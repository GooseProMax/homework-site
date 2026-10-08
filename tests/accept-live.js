'use strict';

/**
 * 线上验收：对部署好的站点跑一遍完整体检（只读，不改数据）。
 *
 *   node tests/accept-live.js
 *   node tests/accept-live.js https://你的域名
 *
 * 检查项：静态资源、页面完整性、接口鉴权、错误处理、国内访问延迟。
 */

const BASE = process.argv[2] || process.env.BASE || 'https://homework-site.goosepromax.deno.net';

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? `\n     ↳ ${detail}` : ''}`);
  }
}

async function get(pathname, options = {}) {
  const started = Date.now();
  const response = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(25000), ...options });
  const text = await response.text();
  return { status: response.status, text, ms: Date.now() - started, headers: response.headers };
}

(async () => {
  console.log(`\n线上验收：${BASE}\n`);

  console.log('【1】自检接口');
  try {
    const health = await get('/api/health');
    const data = JSON.parse(health.text);
    check(`/api/health HTTP ${health.status} (${health.ms}ms)`, health.status === 200, health.text.slice(0, 200));
    check(`数据库正常（${data.storage && data.storage.store}）`, Boolean(data.storage && data.storage.ok), JSON.stringify(data.storage));
    check('APP_SECRET 已配置', data.appSecretConfigured === true, JSON.stringify(data));
    check('运行平台是 deno-deploy', data.platform === 'deno-deploy', String(data.platform));
  } catch (err) {
    check('/api/health 可访问', false, err.message);
  }

  console.log('\n【2】静态资源');
  const assets = [
    ['/', 'text/html'],
    ['/index.html', 'text/html'],
    ['/styles.css', 'text/css'],
    ['/js/util.js', 'javascript'],
    ['/js/api.js', 'javascript'],
    ['/js/store.js', 'javascript'],
    ['/js/render.js', 'javascript'],
    ['/js/modals.js', 'javascript'],
    ['/js/app.js', 'javascript'],
  ];
  for (const [p, expectType] of assets) {
    try {
      const r = await get(p);
      const type = r.headers.get('content-type') || '';
      check(`${p.padEnd(15)} HTTP ${r.status}  ${(r.text.length / 1024).toFixed(1)}KB  ${r.ms}ms`, r.status === 200 && type.includes(expectType), `status=${r.status} ct=${type}`);
    } catch (err) {
      check(p, false, err.message);
    }
  }

  console.log('\n【3】页面完整性（与本地 index.html 逐字对比）');
  const fs = require('node:fs');
  const path = require('node:path');
  const stripVersion = (text) => text.replace(/(src="js\/[a-z]+\.js)\?v=\d+"/g, '$1"');
  const local = stripVersion(fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8'));
  const live = await get('/');
  const liveText = stripVersion(live.text);
  check('线上 HTML 与本地完全一致', liveText === local, `本地 ${local.length} 字符 / 线上 ${liveText.length} 字符`);
  const localIds = (local.match(/id="[^"]+"/g) || []).length;
  const liveIds = (liveText.match(/id="[^"]+"/g) || []).length;
  check(`${liveIds} 个页面元素 id 全部保留`, localIds === liveIds, `本地 ${localIds} / 线上 ${liveIds}`);
  check('引入了全部 6 个前端脚本', ['js/util.js', 'js/api.js', 'js/store.js', 'js/render.js', 'js/modals.js', 'js/app.js'].every((f) => live.text.includes(f)));

  console.log('\n【4】接口鉴权与错误处理');
  const unauth = await get('/api/data');
  check('未登录读数据返回 401', unauth.status === 401, `status=${unauth.status}`);
  const status = JSON.parse((await get('/api/auth?action=status')).text);
  check('站点状态接口可用', typeof status.initialized === 'boolean', JSON.stringify(status).slice(0, 200));
  console.log(`     当前状态：${status.initialized ? '已设置口令' : '尚未设置口令'}｜成员 ${(status.members || []).length} 人｜数据库 ${status.storage}`);
  const missing = await get('/api/not-exist');
  check('不存在的接口返回 404', missing.status === 404, `status=${missing.status}`);
  const wrongMethod = await get('/api/data', { method: 'DELETE' });
  check('不支持的请求方法返回 405', wrongMethod.status === 405, `status=${wrongMethod.status}`);
  const wrongPass = await get('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'intro', passcode: 'definitely-wrong', nickname: '测试' }),
  });
  check('错误口令被拒绝（401 或 428）', wrongPass.status === 401 || wrongPass.status === 428, `status=${wrongPass.status}`);

  console.log('\n【5】国内访问延迟（5 次）');
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await get('/api/health');
    times.push(r.ms);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`     ${times.join('ms, ')}ms → 平均 ${avg}ms`);
  check('接口平均响应 < 2 秒', avg < 2000, `${avg}ms`);

  console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
  if (fail) process.exitCode = 1;
})().catch((err) => {
  console.error('验收脚本出错：', err.message);
  process.exitCode = 1;
});
