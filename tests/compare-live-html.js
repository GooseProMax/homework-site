'use strict';

/**
 * 对比线上首页和自己仓库里的 index.html，定位部署后 HTML 被改动的地方。
 *   node tests/compare-live-html.js [线上地址]
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const ROOT = path.resolve(__dirname, '..');

function stats(label, text) {
  const ids = (text.match(/id=/g) || []).length;
  const cls = (text.match(/class=/g) || []).length;
  const scripts = (text.match(/<script/g) || []).length;
  console.log(`${label}: ${text.length} 字符, id= ×${ids}, class= ×${cls}, <script> ×${scripts}`);
}

(async () => {
  const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(25000) });
  const live = await response.text();
  const local = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  console.log(`\n线上地址：${BASE}`);
  console.log(`响应头 content-type: ${response.headers.get('content-type')}`);
  console.log(`响应头 content-length: ${response.headers.get('content-length')}`);
  console.log(`响应头 cache-control: ${response.headers.get('cache-control')}\n`);

  stats('本地 index.html', local);
  stats('线上 GET /    ', live);

  // 找出线上缺少的 id
  const localIds = (local.match(/id="([^"]+)"/g) || []).map((s) => s.slice(4, -1));
  const liveIds = (live.match(/id=["']([^"']+)["']/g) || []).map((s) => s.replace(/id=["']|["']/g, ''));
  const missing = localIds.filter((id) => !liveIds.includes(id));
  console.log(`\n本地有 ${localIds.length} 个 id，线上有 ${liveIds.length} 个；线上缺失：${missing.length ? missing.join(', ') : '（无）'}`);

  // 逐行对比：找第一处不同的行
  const localLines = local.split(/\r?\n/);
  const liveLines = live.split(/\r?\n/);
  console.log(`\n本地 ${localLines.length} 行，线上 ${liveLines.length} 行`);
  for (let i = 0; i < Math.max(localLines.length, liveLines.length); i += 1) {
    const a = localLines[i];
    const b = liveLines[i];
    if (a !== b) {
      console.log(`\n第一处不同（第 ${i + 1} 行）：`);
      console.log('  本地: ' + JSON.stringify(a === undefined ? '<无>' : a.slice(0, 160)));
      console.log('  线上: ' + JSON.stringify(b === undefined ? '<无>' : b.slice(0, 160)));
      break;
    }
  }

  fs.mkdirSync(path.join(ROOT, '.local-data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.local-data', 'live-index.html'), live);
  console.log('\n线上页面已保存到 .local-data/live-index.html');
})();
