'use strict';

/**
 * 分块下载 Deno 到 .tools/deno.zip，支持断点续传 + 多个镜像源。
 *   node scripts\fetch-deno.js
 *
 * 国内直连 dl.deno.land / GitHub Release 容易中途断开，所以：
 *   - 每次只请求 4MB 一段（HTTP Range），断了就续
 *   - 依次尝试 GitHub Release → dl.deno.land → npmmirror（国内镜像）
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.resolve(__dirname, '..', '.tools');
const TARGET = path.join(OUT_DIR, 'deno.zip');
const CHUNK = 4 * 1024 * 1024;
const SEARCH_FROM = 1024; // zip 的中央目录在结尾，从前 1KB 开始找 EOCD 标记

function readVersionFromZip(file) {
  const size = fs.statSync(file).size;
  const buffer = fs.readFileSync(file);
  const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // EOCD
  const index = buffer.lastIndexOf(marker);
  if (index < 0) return null;
  const entries = buffer.readUInt16LE(index + 10);
  const centralSize = buffer.readUInt32LE(index + 12);
  const centralOffset = buffer.readUInt32LE(index + 16);
  if (centralOffset + centralSize > size) return null;
  return { entries, centralSize, centralOffset, size, eocd: index };
}

async function resolveVersion() {
  const candidates = [
    'https://registry.npmmirror.com/-/binary/deno/',
    'https://api.github.com/repos/denoland/deno/releases/latest',
    'https://dl.deno.land/release-latest.txt',
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'homework-site-setup' },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) continue;
      if (url.includes('npmmirror')) {
        const list = await res.json();
        const versions = list
          .map((item) => String(item.name || '').replace(/^v/, '').replace(/\/$/, ''))
          .filter((v) => /^\d+\.\d+\.\d+$/.test(v));
        if (versions.length) {
          versions.sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
          });
          console.log(`  版本列表来自 npmmirror，最新：${versions[0]}`);
          return versions[0];
        }
      } else if (url.includes('github')) {
        const data = await res.json();
        if (data.tag_name) return String(data.tag_name).replace(/^v/, '');
      } else {
        const text = (await res.text()).trim();
        if (text) return text;
      }
    } catch (err) {
      console.warn(`  取版本失败（${url}）：${err.message}`);
    }
  }
  throw new Error('拿不到 Deno 版本号');
}

function sources(version) {
  return [
    `https://registry.npmmirror.com/-/binary/deno/v${version}/deno-x86_64-pc-windows-msvc.zip`,
    `https://github.com/denoland/deno/releases/download/v${version}/deno-x86_64-pc-windows-msvc.zip`,
    `https://dl.deno.land/release/${version}/deno-x86_64-pc-windows-msvc.zip`,
  ];
}

async function downloadFrom(url) {
  console.log(`\n使用源：${url}`);
  let offset = fs.existsSync(TARGET) ? fs.statSync(TARGET).size : 0;
  let expectedTotal = 0;
  let stalls = 0;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (let round = 0; round < 200; round += 1) {
    const headers = { 'user-agent': 'homework-site-setup' };
    if (offset > 0) headers.range = `bytes=${offset}-${offset + CHUNK - 1}`;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
    } catch (err) {
      stalls += 1;
      console.warn(`  第 ${stalls} 次断流（${err.message}），续传中…`);
      if (stalls > 12) throw new Error('连续断流太多次');
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const total = res.headers.get('content-range')
      ? Number(res.headers.get('content-range').split('/')[1])
      : Number(res.headers.get('content-length')) || 0;
    if (total) expectedTotal = total;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      stalls += 1;
      if (stalls > 12) throw new Error('服务端返回空数据');
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    fs.appendFileSync(TARGET, buf);
    offset += buf.length;
    const pct = expectedTotal ? ` (${((offset / expectedTotal) * 100).toFixed(1)}%)` : '';
    console.log(`  ${(offset / 1048576).toFixed(2)} MB${pct}`);
    if (expectedTotal && offset >= expectedTotal) break;
    if (!expectedTotal && buf.length < CHUNK) break; // 服务端不支持 Range，一次给完
  }

  const info = readVersionFromZip(TARGET);
  if (!info) throw new Error('下载的文件不是完整 zip（缺少中央目录）');
  console.log(`  ✅ zip 完整：${info.entries} 个文件，${(info.size / 1048576).toFixed(1)} MB`);
  return info;
}

(async () => {
  const version = await resolveVersion();
  console.log('Deno 目标版本：', version);
  if (fs.existsSync(TARGET)) {
    const existing = readVersionFromZip(TARGET);
    if (existing) {
      console.log('已存在完整 zip，跳过下载：', TARGET);
      return;
    }
    console.log('已有 zip 不完整，重新下载…');
    fs.unlinkSync(TARGET);
  }
  for (const url of sources(version)) {
    try {
      await downloadFrom(url);
      console.log('\n下载完成：', TARGET);
      return;
    } catch (err) {
      console.warn(`  ✗ 该源失败：${err.message}`);
      if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET);
    }
  }
  console.error('\n❌ 所有源都失败，稍后重试。');
  process.exitCode = 1;
})();
