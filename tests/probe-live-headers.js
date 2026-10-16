'use strict';

/**
 * 诊断：线上 Deno Deploy 到底把客户端 IP 放在哪个请求头里？
 *
 * 用法：node tests/probe-live-headers.js
 *
 * 它请求 /api/health?headers=1（服务端的临时诊断口），把收到的所有请求头
 * 原样打出来，并检查常见 IP 头是否存在。
 */

const BASE = process.env.SITE_URL || 'https://homework-site.goosepromax.deno.net';

/** 这些头都可能携带客户端 IP，按常见程度排列 */
const IP_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'forwarded',
  'x-client-ip',
  'x-cluster-client-ip',
  'true-client-ip',
  'fastly-client-ip',
  'x-vercel-forwarded-for',
  'x-deno-net-client-ip',
];

(async () => {
  console.log(`\n探测：${BASE}/api/health?headers=1\n`);

  let payload = null;
  try {
    const res = await fetch(`${BASE}/api/health?headers=1`, {
      headers: { 'user-agent': 'HeaderProbe/1.0', 'x-forwarded-for': '203.0.113.250' },
    });
    payload = await res.json();
    console.log(`HTTP ${res.status}`);
  } catch (err) {
    console.error('请求失败：', err.message);
    process.exit(1);
  }

  if (!payload || !payload.headers) {
    console.log('\n❌ 诊断口没生效（可能还是旧版本）。返回内容：');
    console.log(JSON.stringify(payload, null, 2).slice(0, 600));
    console.log('\n提示：确认最后一次推送是否成功、Deno Deploy 是否已构建完成。');
    process.exit(1);
  }

  const headers = payload.headers;
  console.log('\n=== 服务端实际收到的全部请求头 ===');
  Object.keys(headers).sort().forEach((key) => {
    const value = String(headers[key]);
    const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    console.log(`  ${key}: ${shown}`);
  });

  console.log('\n=== 客户端 IP 相关头的检查 ===');
  let found = [];
  IP_HEADERS.forEach((name) => {
    if (headers[name]) {
      console.log(`  ✅ ${name} = ${headers[name]}`);
      found.push(name);
    } else {
      console.log(`  ␀  ${name} （不存在）`);
    }
  });

  console.log('\n=== 服务端 clientInfo() 的解析结果 ===');
  console.log(' ', JSON.stringify(payload.clientInfo));

  console.log('\n=== 结论 ===');
  if (!found.length) {
    console.log('  Deno Deploy 未提供任何客户端 IP 头 —— 记录 IP 这条路走不通，建议界面上不显示该字段。');
  } else {
    const picked = payload.clientInfo && payload.clientInfo.ip;
    console.log(`  可用的 IP 头：${found.join(', ')}`);
    console.log(`  当前 clientInfo() 取到：${picked ? `"${picked}"` : '（空）'}`);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(picked || '') || /:/.test(picked || '')) {
      console.log('  ✅ 解析正常。注意：若值接近边缘节点网段，则它是代理 IP 而非真实客户端。');
    }
  }
  console.log('');
})();
