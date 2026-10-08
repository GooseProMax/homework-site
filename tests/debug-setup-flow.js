'use strict';

/**
 * 复现浏览器「设置口令 → 进入」的完整请求序列，找出卡在哪一步。
 *
 *   node tests/debug-setup-flow.js [线上地址] [口令] [昵称]
 *
 * 注意：这会在线上站点创建/使用一个测试成员，跑完自动清理该成员。
 */

const BASE = process.argv[2] || process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.argv[3] || '';
const NICKNAME = process.argv[4] || '__诊断测试__';

async function call(method, pathname, body, token) {
  const started = Date.now();
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 200) };
  }
  return { status: response.status, payload, ms: Date.now() - started };
}

function show(label, result) {
  const body = JSON.stringify(result.payload);
  console.log(`  ${label}`);
  console.log(`    HTTP ${result.status} (${result.ms}ms)  ${body.length > 220 ? `${body.slice(0, 220)}…` : body}`);
}

(async () => {
  console.log(`\n诊断站点：${BASE}\n`);

  console.log('【1】浏览器打开页面时发的第一个请求');
  const status = await call('GET', '/api/auth?action=status');
  show('GET /api/auth?action=status', status);
  const initialized = Boolean(status.payload && status.payload.initialized);
  console.log(`    → initialized = ${initialized}（${initialized ? '应该显示「输入口令登录」' : '应该显示「设置口令」'}）`);
  console.log(`    → 成员名单：${JSON.stringify((status.payload && status.payload.members) || [])}`);

  if (!initialized) {
    console.log('\n【2】站点还没初始化。前端会显示「设置口令」表单；填完会发这个请求：');
    console.log('     POST /api/auth  {action:"setup", passcode, nickname}');
    if (!PASSCODE) {
      console.log('\n  ⚠️ 没提供口令，无法继续复现。用法：node tests/debug-setup-flow.js <网址> <口令> <昵称>');
      return;
    }
    const setup = await call('POST', '/api/auth', { action: 'setup', passcode: PASSCODE, nickname: NICKNAME });
    show('POST /api/auth (setup)', setup);
    if (setup.status !== 200 || !setup.payload.token) {
      console.log('\n  ❌ 初始化失败，问题在服务端。上面的响应就是原因。');
      return;
    }
    const token = setup.payload.token;

    console.log('\n【3】初始化成功后，前端立刻会读数据（Store.init → GET /api/data）');
    const data = await call('GET', '/api/data', undefined, token);
    show('GET /api/data', data);
    if (data.status !== 200) {
      console.log('\n  ❌ 读数据失败 → 前端会把你踢回登录页，表现就是「设置完口令又回到开头」！');
      console.log('     这就是你遇到的现象的根因。');
      return;
    }

    console.log('\n【4】读健康检查（前端「设置 → 自检」按钮用）');
    const health = await call('GET', '/api/health');
    show('GET /api/health', health);

    console.log('\n【5】清理：删掉诊断用的成员');
    const doc = data.payload.doc;
    doc.members = (doc.members || []).filter((m) => m.nickname !== NICKNAME);
    const save = await call('PUT', '/api/data', { doc, baseRevision: data.payload.revision }, token);
    show('PUT /api/data (清理成员)', save);
    console.log('\n  注意：诊断用的口令已经写进站点，正式口令请用设置页修改。');
    return;
  }

  console.log('\n【2】站点已初始化，前端显示「输入口令」表单。两个分支：');
  const members = (status.payload.members || []).map((m) => m.nickname);
  console.log(`    分支 A（选了已有昵称 ${JSON.stringify(members)}）：POST {action:"login", member:"昵称"}  —— 不需要口令`);
  console.log('    分支 B（新昵称）：POST {action:"intro", passcode, nickname}  —— 需要口令');

  const loginTest = await call('POST', '/api/auth', { action: 'login', member: NICKNAME });
  show('POST /api/auth (login，新昵称，无口令)', loginTest);
  console.log(`    → ${loginTest.status === 401 ? '✅ 正确拒绝（新昵称必须给口令）' : '⚠️ 期望 401'}`);

  const introTest = await call('POST', '/api/auth', { action: 'intro', passcode: 'wrong-passcode', nickname: NICKNAME });
  show('POST /api/auth (intro，错误口令)', introTest);
  console.log(`    → ${introTest.status === 401 ? '✅ 正确拒绝' : '⚠️ 期望 401'}`);

  if (!PASSCODE) {
    console.log('\n  要验证正确口令的完整流程，请再跑一次并带上口令：');
    console.log(`  node tests/debug-setup-flow.js ${BASE} <你的口令> ${NICKNAME}`);
    return;
  }

  const good = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: NICKNAME });
  show('POST /api/auth (intro，正确口令)', good);
  if (good.status !== 200 || !good.payload.token) {
    console.log('\n  ❌ 正确口令也进不去 → 口令不对，或者服务端口令校验有问题。');
    return;
  }
  const token = good.payload.token;

  const data = await call('GET', '/api/data', undefined, token);
  show('GET /api/data', data);
  console.log(`    → ${data.status === 200 ? '✅ 数据可读，流程完整' : '❌ 读数据失败，前端会被踢回登录页'}`);

  if (data.status === 200) {
    console.log('\n【3】清理：删掉诊断用的成员');
    const doc = data.payload.doc;
    doc.members = (doc.members || []).filter((m) => m.nickname !== NICKNAME);
    const save = await call('PUT', '/api/data', { doc, baseRevision: data.payload.revision }, token);
    show('PUT /api/data (清理成员)', save);
  }
})();
