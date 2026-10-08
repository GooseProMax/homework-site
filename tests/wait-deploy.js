'use strict';

/**
 * 等线上部署生效（Deno Deploy 收到新提交后会自动构建，通常 40~90 秒）。
 *
 *   node tests/wait-deploy.js [网址] [最多等多久秒]
 */

const BASE = process.argv[2] || process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const LIMIT_SECONDS = Number(process.argv[3] || 300);

// 判断新版本是否上线的特征：源码里必须出现这些片段
const MARKERS = [
  { name: 'app.js 含 bindGateEvents（表单绑定修复）', path: '/js/app.js', needle: 'bindGateEvents' },
  { name: 'index.html 脚本带 ?v=3（绕过缓存）', path: '/', needle: 'app.js?v=3' },
];

(async () => {
  const started = Date.now();
  let round = 0;
  while ((Date.now() - started) / 1000 < LIMIT_SECONDS) {
    round += 1;
    const results = [];
    for (const marker of MARKERS) {
      try {
        const response = await fetch(BASE + marker.path, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
        const text = await response.text();
        results.push({ ...marker, ok: text.includes(marker.needle), size: text.length });
      } catch (err) {
        results.push({ ...marker, ok: false, error: (err.cause && err.cause.message) || err.message });
      }
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    const allOk = results.every((r) => r.ok);
    console.log(`第 ${round} 次（${elapsed}s）：` + results.map((r) => `${r.ok ? '✅' : '⏳'} ${r.name}`).join('  '));
    results.filter((r) => r.error).forEach((r) => console.log('    ' + r.error));

    if (allOk) {
      console.log('\n✅ 新版本已经上线，可以刷新浏览器验证了。');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  console.log(`\n⚠️ ${LIMIT_SECONDS} 秒内还没全部生效。去 Deno Deploy 的 Builds 页面看看构建是否失败。`);
  process.exitCode = 1;
})();
