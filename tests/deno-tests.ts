/**
 * Deno 版端到端测试（本机跑，不需要联网）：
 *
 *   .tools\bin\deno.exe run -A tests/deno-tests.ts
 *
 * 会临时启动 server.ts（数据写到 .local-data/deno-test.json），跑完自动关掉。
 */

const PORT = 8790 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = '.local-data/deno-test.json';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? `\n     ↳ ${detail}` : ''}`);
  }
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: payload };
}

try {
  await Deno.remove(DATA_FILE);
} catch { /* 不存在就算了 */ }

const serverPath = decodeURIComponent(new URL('../server.ts', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const child = new Deno.Command(Deno.execPath(), {
  args: ['run', '-A', serverPath],  env: {
    PORT: String(PORT),
    DATA_FILE,
    APP_SECRET: 'deno-test-secret',
    NO_COLOR: '1',
  },
  stdout: 'piped',
  stderr: 'piped',
}).spawn();

// 等服务器起来
let ready = false;
for (let i = 0; i < 60; i += 1) {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (res.ok || res.status === 500) {
      ready = true;
      break;
    }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 400));
}
check('服务器启动成功', ready, '请检查 server.ts 是否报错');

try {
  console.log('\n跑 Deno 版接口测试…\n');

  const health = await call('GET', '/api/health');
  check('GET /api/health 返回 200', health.status === 200, JSON.stringify(health.body));
  check('自检里带了存储类型', Boolean(health.body?.storage?.store), JSON.stringify(health.body));
  check('自检显示 APP_SECRET 已配置', health.body?.appSecretConfigured === true, JSON.stringify(health.body));

  const status0 = await call('GET', '/api/auth?action=status');
  check('未初始化时 initialized=false', status0.body?.initialized === false, JSON.stringify(status0.body));

  const noAuth = await call('GET', '/api/data');
  check('未登录读数据 401', noAuth.status === 401);

  const badSetup = await call('POST', '/api/auth', { action: 'setup', passcode: '12', nickname: '小张' });
  check('口令太短被拒（400）', badSetup.status === 400, JSON.stringify(badSetup.body));

  const setup = await call('POST', '/api/auth', { action: 'setup', passcode: 'hw2025', nickname: '小张' });
  check('初始化成功拿到 token', setup.status === 200 && Boolean(setup.body.token), JSON.stringify(setup.body));
  const tokenA = setup.body.token;

  const repeat = await call('POST', '/api/auth', { action: 'setup', passcode: 'other', nickname: '小李' });
  check('重复初始化被拒（409）', repeat.status === 409, JSON.stringify(repeat.body));

  const wrong = await call('POST', '/api/auth', { action: 'intro', passcode: 'wrong', nickname: '小李' });
  check('口令错误被拒（401）', wrong.status === 401, JSON.stringify(wrong.body));

  const intro = await call('POST', '/api/auth', { action: 'intro', passcode: 'hw2025', nickname: '小李' });
  check('新同学凭口令进入成功', intro.status === 200 && intro.body.nickname === '小李', JSON.stringify(intro.body));
  const tokenB = intro.body.token;

  const byMember = await call('POST', '/api/auth', { action: 'login', member: '小张' });
  check('老成员不给口令进不来（401）', byMember.status === 401, JSON.stringify(byMember.body));

  const byMemberOk = await call('POST', '/api/auth', { action: 'login', passcode: 'hw2025', member: '小张' });
  check('老成员给对口令可以登录', byMemberOk.status === 200 && byMemberOk.body.nickname === '小张', JSON.stringify(byMemberOk.body));

  const stranger = await call('POST', '/api/auth', { action: 'login', member: '陌生人' });
  check('陌生昵称没口令进不来（401）', stranger.status === 401, JSON.stringify(stranger.body));

  const probe0 = await call('GET', '/api/data?probe=1', undefined, tokenA);
  const doc = {
    version: 1,
    settings: { title: '测试作业板', weeks: 16, semester: '2025 秋' },
    courses: [{ id: 'c1', name: '英美文学选读', color: '#4361ee', day: 2, slot: '1-2 节' }],
    assignments: [
      { id: 'a1', courseId: 'c1', week: 1, type: 'homework', title: '第 1 章读书报告', doneBy: ['小张'], status: 'done', images: [], links: [] },
      { id: 'a2', courseId: 'c1', week: 8, type: 'major', title: '期末论文', doneBy: [], status: 'todo', images: [], links: [] },
    ],
    members: [{ nickname: '小张' }, { nickname: '小李' }],
  };
  const save1 = await call('PUT', '/api/data', { doc, baseRevision: probe0.body.revision }, tokenA);
  check('保存数据成功', save1.status === 200 && save1.body.revision >= 1, JSON.stringify(save1.body));

  const read1 = await call('GET', '/api/data', undefined, tokenB);
  check('另一位同学读到相同数据', read1.status === 200 && read1.body.doc.assignments.length === 2, JSON.stringify(read1.body).slice(0, 160));
  check('大作业字段保留', read1.body.doc.assignments.some((a: any) => a.type === 'major'));
  check('中文没乱码', read1.body.doc.courses[0].name === '英美文学选读');

  const stale = await call('PUT', '/api/data', { doc, baseRevision: read1.body.revision - 6 }, tokenB);
  check('过期版本号被拒（409）', stale.status === 409 && stale.body.conflict === true, JSON.stringify(stale.body).slice(0, 160));
  check('409 带回最新数据', Boolean(stale.body.doc));

  const hack = JSON.parse(JSON.stringify(doc));
  hack.settings.passcodeHash = 'deadbeef';
  hack.settings.passcodeSalt = 'x';
  hack.members = [{ nickname: '入侵者' }];
  const hackSave = await call('PUT', '/api/data', { doc: hack, baseRevision: stale.body.revision }, tokenB);
  check('客户端改不动口令哈希', hackSave.status === 200, JSON.stringify(hackSave.body));
  const forged = await call('POST', '/api/auth', { action: 'intro', passcode: 'deadbeef', nickname: '入侵者' });
  check('伪造口令登不进来（401）', forged.status === 401, JSON.stringify(forged.body));

  const badPass = await call('POST', '/api/auth', { action: 'passcode', passcode: 'nope', newPasscode: 'newpass1' }, tokenA);
  check('当前口令错误时不能改口令（401）', badPass.status === 401, JSON.stringify(badPass.body));

  const changePass = await call('POST', '/api/auth', { action: 'passcode', passcode: 'hw2025', newPasscode: 'newpass1' }, tokenA);
  check('修改口令成功', changePass.status === 200, JSON.stringify(changePass.body));

  const oldLogin = await call('POST', '/api/auth', { action: 'intro', passcode: 'hw2025', nickname: '小王' });
  check('旧口令失效（401）', oldLogin.status === 401, JSON.stringify(oldLogin.body));
  const newLogin = await call('POST', '/api/auth', { action: 'intro', passcode: 'newpass1', nickname: '小王' });
  check('新口令可用', newLogin.status === 200, JSON.stringify(newLogin.body));

  const forgedToken = await call('GET', '/api/data', undefined, `${tokenA}x`);
  check('伪造 token 被拒（401）', forgedToken.status === 401);

  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('首页可以打开', page.status === 200 && html.includes('作业云服务器'), `status=${page.status}`);
  check('首页带上了正确的 content-type', (page.headers.get('content-type') ?? '').includes('text/html'));

  for (const asset of ['/styles.css', '/js/app.js', '/js/store.js', '/js/render.js', '/js/modals.js', '/js/api.js']) {
    const res = await fetch(`${BASE}${asset}`);
    const text = await res.text();
    check(`静态资源 ${asset} 正常`, res.status === 200 && text.length > 100, `status=${res.status} len=${text.length}`);
  }

  const notFound = await fetch(`${BASE}/api/nope`);
  check('不存在的接口返回 404', notFound.status === 404, `status=${notFound.status}`);

  const methodGuard = await fetch(`${BASE}/api/data`, { method: 'DELETE' });
  check('不支持的方法被拒（405）', methodGuard.status === 405, `status=${methodGuard.status}`);
} catch (err) {
  failed += 1;
  console.error('\n测试过程出错：', err);
} finally {
  try {
    child.kill('SIGKILL');
  } catch { /* ignore */ }
  await child.status;
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
if (failed) Deno.exit(1);
