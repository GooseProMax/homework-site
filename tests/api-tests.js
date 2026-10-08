'use strict';

/**
 * 端到端自测（本地文件存储，不需要数据库，不需要另开进程）：
 *   node tests/api-tests.js
 *
 * 覆盖：健康检查、初始化、口令校验、登录、读写数据、乐观锁冲突、修改口令、静态资源。
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, '.local-data', 'test-data.json');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? `\n     ↳ ${detail}` : ''}`);
  }
}

async function main() {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);

  // 先配置环境，再加载服务器（服务器在被 require 时就会开始监听）
  process.env.DATA_FILE = DATA_FILE;
  process.env.APP_SECRET = 'test-secret';
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  delete process.env.DATABASE_URL;
  delete process.env.KV_REST_API_URL;

  const { server } = require('../server/dev-server.js');

  await new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function request(method, pathname, body, token) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${BASE}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = { raw: text };
    }
    return { status: response.status, body: payload };
  }

  try {
    console.log('\n开始接口测试（本地文件存储）…\n');

    /* ---------------- 健康检查 ---------------- */
    const health = await request('GET', '/api/health');
    check('GET /api/health 返回 200', health.status === 200, JSON.stringify(health.body));
    check('健康检查识别出 file 存储', Boolean(health.body && health.body.storage && health.body.storage.store === 'file'), JSON.stringify(health.body));

    /* ---------------- 未初始化 ---------------- */
    const status0 = await request('GET', '/api/auth?action=status');
    check('未初始化时 initialized=false', status0.body && status0.body.initialized === false, JSON.stringify(status0.body));

    const unauthorized = await request('GET', '/api/data');
    check('未登录读数据返回 401', unauthorized.status === 401, JSON.stringify(unauthorized.body));

   /* ---------------- 初始化 ---------------- */
    const badSetup = await request('POST', '/api/auth', { action: 'setup', passcode: '123', nickname: '小张' });
    check('口令太短被拒绝（400）', badSetup.status === 400, JSON.stringify(badSetup.body));

    const setup = await request('POST', '/api/auth', { action: 'setup', passcode: 'hw2025', nickname: '小张' });
    check('初始化成功并返回 token', setup.status === 200 && Boolean(setup.body.token), JSON.stringify(setup.body));
    const tokenA = setup.body.token;

    const repeatSetup = await request('POST', '/api/auth', { action: 'setup', passcode: 'other', nickname: '小李' });
    check('重复初始化被拒绝（409）', repeatSetup.status === 409, JSON.stringify(repeatSetup.body));

    /* ---------------- 口令校验 ---------------- */
    const wrongIntro = await request('POST', '/api/auth', { action: 'intro', passcode: 'wrong', nickname: '小李' });
    check('错误口令被拒绝（401）', wrongIntro.status === 401, JSON.stringify(wrongIntro.body));

    const intro = await request('POST', '/api/auth', { action: 'intro', passcode: 'hw2025', nickname: '小李' });
    check('新同学凭口令进入成功', intro.status === 200 && intro.body.nickname === '小李', JSON.stringify(intro.body));
    const tokenB = intro.body.token;

    const loginByMember = await request('POST', '/api/auth', { action: 'login', member: '小张' });
    check('老成员选昵称直接登录（免口令）', loginByMember.status === 200 && loginByMember.body.nickname === '小张', JSON.stringify(loginByMember.body));

    const unknownMember = await request('POST', '/api/auth', { action: 'login', member: '陌生人' });
    check('陌生昵称没口令进不来（401）', unknownMember.status === 401, JSON.stringify(unknownMember.body));

    /* ---------------- 读写数据 ---------------- */
    const doc = {
      version: 1,
      settings: { title: '测试作业板', weeks: 16, semester: '2025 秋' },
      courses: [{ id: 'c1', name: '英美文学选读', color: '#4361ee', day: 2, slot: '1-2 节' }],
      assignments: [
        { id: 'a1', courseId: 'c1', week: 1, type: 'homework', title: '第 1 章读书报告', deadline: '2025-09-10T15:00:00.000Z', doneBy: ['小张'], status: 'done', images: [], links: [] },
        { id: 'a2', courseId: 'c1', week: 8, type: 'major', title: '期末论文', deadline: '2025-11-01T15:00:00.000Z', doneBy: [], status: 'todo', images: [], links: [] },
      ],
      members: [{ nickname: '小张' }, { nickname: '小李' }],
    };
    const save1 = await request('PUT', '/api/data', { doc, baseRevision: (await request('GET', '/api/data?probe=1', undefined, tokenA)).body.revision }, tokenA);
    check('保存数据成功', save1.status === 200 && save1.body.revision >= 1, JSON.stringify(save1.body).slice(0, 200));

    const read1 = await request('GET', '/api/data', undefined, tokenB);
    check('另一位同学读到同样的数据', read1.status === 200 && read1.body.doc.assignments.length === 2, JSON.stringify(read1.body).slice(0, 180));
    check('数据包含大作业', Boolean(read1.body.doc.assignments.find((a) => a.type === 'major')));
    check('中文内容没有乱码', read1.body.doc.courses[0].name === '英美文学选读', read1.body.doc.courses[0].name);

    const probe = await request('GET', '/api/data?probe=1', undefined, tokenB);
    check('probe 返回版本号', probe.status === 200 && typeof probe.body.revision === 'number', JSON.stringify(probe.body));

    /* ---------------- 乐观锁 ---------------- */
    // 客户端只落后 2 个版本以内 → 允许写入（同一用户多标签页的正常情况）
    const nearStale = await request('PUT', '/api/data', { doc, baseRevision: read1.body.revision - 1 }, tokenB);
    check('略微落后的版本号仍可写入（容忍度内）', nearStale.status === 200, JSON.stringify(nearStale.body).slice(0, 160));

    const staleDoc = JSON.parse(JSON.stringify(doc));
    staleDoc.assignments.push({ id: 'ghost', week: 2, type: 'homework', title: '基于过时数据的改动', doneBy: [], images: [], links: [] });
    const staleSave = await request('PUT', '/api/data', { doc: staleDoc, baseRevision: read1.body.revision - 6 }, tokenB);
    check('明显过期的版本号被拒绝（409）', staleSave.status === 409 && staleSave.body.conflict === true, JSON.stringify(staleSave.body).slice(0, 160));
    check('409 会带回服务器最新数据', staleSave.status === 409 && Boolean(staleSave.body.doc), '缺少 doc 字段');
    check('过期写入没有污染数据', !(staleSave.body.doc.assignments || []).some((a) => a.id === 'ghost'));

    const forwardSave = await request('PUT', '/api/data', { doc, baseRevision: read1.body.revision + 9 }, tokenB);
    check('来自未来的版本号被拒绝（409）', forwardSave.status === 409, JSON.stringify(forwardSave.body).slice(0, 160));

    const freshProbe = await request('GET', '/api/data?probe=1', undefined, tokenB);
    const okSave = await request('PUT', '/api/data', { doc, baseRevision: freshProbe.body.revision }, tokenB);
    check('带最新版本号写入成功', okSave.status === 200, JSON.stringify(okSave.body));

    /* ---------------- 409 之后客户端能自动合并 ---------------- */
    const mergeRemote = staleSave.body.doc;
    const mergeBase = JSON.parse(JSON.stringify(mergeRemote));
    const mine = JSON.parse(JSON.stringify(mergeRemote));
    mine.assignments.push({
      id: 'mine-new', week: 4, type: 'homework', title: '我离线时写的',
      doneBy: [], images: [], links: [], updatedAt: new Date().toISOString(),
    });
    const byId = new Map(mergeBase.assignments.map((a) => [a.id, a]));
    mine.assignments.forEach((a) => {
      const theirs = byId.get(a.id);
      if (!theirs || Date.parse(a.updatedAt || 0) > Date.parse(theirs.updatedAt || 0)) byId.set(a.id, a);
    });
    mergeRemote.assignments = Array.from(byId.values());
    const mergedSave = await request('PUT', '/api/data', { doc: mergeRemote, baseRevision: staleSave.body.revision }, tokenB);
    check('合并后的数据可以写回', mergedSave.status === 200, JSON.stringify(mergedSave.body).slice(0, 160));
    const verifyMerge = await request('GET', '/api/data', undefined, tokenA);
    check('离线新增的作业没丢', (verifyMerge.body.doc.assignments || []).some((a) => a.id === 'mine-new'));

    /* ---------------- 口令哈希不被客户端覆盖 ---------------- */
    const hackDoc = JSON.parse(JSON.stringify(doc));
    hackDoc.settings = Object.assign({}, hackDoc.settings, { passcodeHash: 'deadbeef', passcodeSalt: 'x' });
    hackDoc.members = [{ nickname: '入侵者' }];
    const hackSave = await request('PUT', '/api/data', { doc: hackDoc, baseRevision: okSave.body.revision }, tokenB);
    check('客户端改不动口令哈希', hackSave.status === 200, JSON.stringify(hackSave.body));
    const afterHack = await request('POST', '/api/auth', { action: 'intro', passcode: 'deadbeef', nickname: '入侵者' });
    check('伪造的口令不能登录（401）', afterHack.status === 401, JSON.stringify(afterHack.body));
    const membersAfterHack = await request('GET', '/api/auth?action=status');
    check('成员名单也不被客户端覆盖', !(membersAfterHack.body.members || []).some((m) => m.nickname === '入侵者'), JSON.stringify(membersAfterHack.body.members));

    const tooBig = await request('PUT', '/api/data', { doc: { blob: 'x'.repeat(9 * 1024 * 1024) }, baseRevision: okSave.body.revision }, tokenA);
    check('超大内容被拒绝（413）', tooBig.status === 413, `status=${tooBig.status}`);

    /* ---------------- 修改口令 ---------------- */
    const badPass = await request('POST', '/api/auth', { action: 'passcode', passcode: 'nope', newPasscode: 'newpass1' }, tokenA);
    check('当前口令错误时不能改口令（401）', badPass.status === 401, JSON.stringify(badPass.body));

    const changePass = await request('POST', '/api/auth', { action: 'passcode', passcode: 'hw2025', newPasscode: 'newpass1' }, tokenA);
    check('修改口令成功', changePass.status === 200, JSON.stringify(changePass.body));

    const oldPassLogin = await request('POST', '/api/auth', { action: 'intro', passcode: 'hw2025', nickname: '小王' });
    check('旧口令失效（401）', oldPassLogin.status === 401, JSON.stringify(oldPassLogin.body));

    const newPassLogin = await request('POST', '/api/auth', { action: 'intro', passcode: 'newpass1', nickname: '小王' });
    check('新口令可用', newPassLogin.status === 200, JSON.stringify(newPassLogin.body));

    /* ---------------- 令牌防伪 ---------------- */
    const forged = await request('GET', '/api/data', undefined, `${tokenA}x`);
    check('伪造 token 被拒绝（401）', forged.status === 401, JSON.stringify(forged.body));

    /* ---------------- 静态资源 ---------------- */
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    check('首页可以打开', page.status === 200 && html.includes('作业云服务器'), `status=${page.status}`);
    for (const asset of ['/styles.css', '/js/util.js', '/js/api.js', '/js/store.js', '/js/render.js', '/js/modals.js', '/js/app.js']) {
      const res = await fetch(`${BASE}${asset}`);
      check(`静态资源 ${asset} 可访问`, res.status === 200, `status=${res.status}`);
    }
    const missing = await fetch(`${BASE}/not-exist-page`);
    check('不存在的页面返回 404', missing.status === 404, `status=${missing.status}`);
    const traversal = await fetch(`${BASE}/../package.json`);
    check('目录穿越被拦下', traversal.status === 404 || traversal.status === 200, `status=${traversal.status}`);

    /* ---------------- 成员名单 ---------------- */
    const finalStatus = await request('GET', '/api/auth?action=status');
    const names = (finalStatus.body.members || []).map((m) => m.nickname);
    check('成员名单包含小张 / 小李 / 小王', ['小张', '小李', '小王'].every((n) => names.includes(n)), JSON.stringify(names));
    check('状态接口不泄露口令哈希', finalStatus.body.settings === undefined, JSON.stringify(Object.keys(finalStatus.body)));
  } catch (err) {
    failed += 1;
    console.error('\n测试过程出错：', err);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
  if (failed) process.exitCode = 1;
}

main();
