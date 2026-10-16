'use strict';

/**
 * 登录历史（loginLog）端到端测试 —— 走 Node 版真实接口。
 *
 * 覆盖：
 *   1. init 后文档里有 loginLog 字段
 *   2. intro 成功 → 追加一条记录（带 nickname / action / at）
 *   3. 口令错误 → 不留下记录
 *   4. 客户端 PUT 整体覆盖 loginLog → 服务端保留，不会丢
 *   5. 记录条数上限 300（超出只留最近的）
 *
 * 用法：node tests/login-log-test.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 用独立的临时数据文件，别碰开发数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-loginlog-'));
process.env.DATA_FILE = path.join(tmpDir, 'data.json');
process.env.APP_SECRET = 'test-secret-login-log';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.KV_REST_API_URL;

const auth = require('../api/auth.js');
const data = require('../api/data.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

/** 造一个最小 req/res，直接调用 handler */
function callHandler(handler, { method = 'POST', body, query = '', token = '', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: `/api/auth${query}`,
      headers: Object.assign(
        { host: 'localhost', 'user-agent': 'LoginLogTest/1.0', 'x-forwarded-for': '203.0.113.7' },
        token ? { authorization: `Bearer ${token}` } : {},
        headers,
      ),
      on() {},
      [Symbol.asyncIterator]: async function* () {},
    };
    req.body = body;
    const headersOut = {};
    const res = {
      statusCode: 0,
      body: '',
      setHeader(k, v) { headersOut[k.toLowerCase()] = v; },
      end(text) { this.body = text || ''; resolve({ status: this.statusCode, payload: safeParse(this.body) }); },
      get headersOut() { return headersOut; },
    };
    handler(req, res);
  });
}

function safeParse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return { raw: String(text).slice(0, 200) }; }
}

function readDoc() {
  const raw = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  return raw;
}

(async () => {
  console.log('\n=== 登录历史（loginLog）测试 ===\n');

  /* 1. 初始状态：没有 loginLog 字段 */
  const status0 = await callHandler(auth, { method: 'GET', query: '?action=status' });
  check('站点初始未初始化', status0.payload && status0.payload.initialized === false);

  /* 2. setup 会写第一条记录 */
  const setup = await callHandler(auth, { body: { action: 'setup', passcode: 'hw2025', nickname: '阿甲' } });
  check('setup 成功', setup.status === 200 && setup.payload.ok === true);
  const token = setup.payload.token;

  let doc = readDoc().doc;
  check('文档里有 loginLog 数组', Array.isArray(doc.loginLog), JSON.stringify(doc.loginLog));
  check('setup 留下 1 条记录', doc.loginLog.length === 1, `实际 ${doc.loginLog.length}`);
  check('记录里有昵称', doc.loginLog[0] && doc.loginLog[0].nickname === '阿甲');
  check('记录标注动作 setup', doc.loginLog[0] && doc.loginLog[0].action === 'setup');
  check('记录里有时间戳', Boolean(doc.loginLog[0] && doc.loginLog[0].at));
  check('记录里有 UA', doc.loginLog[0] && /LoginLogTest/.test(doc.loginLog[0].ua || ''));
  check('不记录 IP（平台给不了真实值，且该值可伪造）', doc.loginLog[0] && doc.loginLog[0].ip === undefined, JSON.stringify(doc.loginLog[0].ip));

  /* 3. intro 成功 → 追加记录 */
  const intro = await callHandler(auth, { body: { action: 'intro', passcode: 'hw2025', nickname: '阿乙' } });
  check('intro 成功', intro.status === 200 && intro.payload.ok === true);
  doc = readDoc().doc;
  check('intro 后共 2 条', doc.loginLog.length === 2, `实际 ${doc.loginLog.length}`);
  check('最新一条是阿乙', doc.loginLog[1].nickname === '阿乙');
  check('最新一条标注 intro', doc.loginLog[1].action === 'intro');

  /* 4. 口令错误 → 不写记录 */
  const bad = await callHandler(auth, { body: { action: 'intro', passcode: 'luanma', nickname: '坏人' } });
  check('错误口令被拒', bad.status === 401, `status=${bad.status}`);
  doc = readDoc().doc;
  check('失败尝试不写记录', doc.loginLog.length === 2, `实际 ${doc.loginLog.length}`);
  check('坏人不在记录里', !doc.loginLog.some((e) => e.nickname === '坏人'));

  /* 5. login 动作也记录 */
  const login = await callHandler(auth, { body: { action: 'login', passcode: 'hw2025', member: '阿丙' } });
  check('login 成功', login.status === 200 && login.payload.ok === true);
  doc = readDoc().doc;
  check('login 后共 3 条', doc.loginLog.length === 3, `实际 ${doc.loginLog.length}`);
  check('login 记录标注 login', doc.loginLog[2].action === 'login');

  /* 6. 客户端 PUT 覆盖 loginLog → 服务端保留 */
  const revision = readDoc().revision;
  const currentDoc = readDoc().doc;
  const tampered = JSON.parse(JSON.stringify(currentDoc));
  tampered.loginLog = []; // 客户端想清空日志
  tampered.settings.title = '被改过的标题';
  const put = await callHandler(data, {
    method: 'PUT',
    token,
    body: { doc: tampered, baseRevision: revision },
  });
  check('PUT 成功', put.status === 200 && put.payload.ok === true, `status=${put.status}`);
  doc = readDoc().doc;
  check('登录日志未被客户端清空', doc.loginLog.length === 3, `实际 ${doc.loginLog.length}`);
  check('正常字段（标题）改动生效', doc.settings.title === '被改过的标题', doc.settings.title);
  check('口令哈希未被覆盖', Boolean(doc.settings.passcodeHash));

  /* 7. 客户端伪造记录也无效（仍以服务端为准） */
  const revision2 = readDoc().revision;
  const forged = JSON.parse(JSON.stringify(readDoc().doc));
  forged.loginLog = [{ at: '2000-01-01T00:00:00.000Z', nickname: '伪造者', action: 'login' }];
  await callHandler(data, { method: 'PUT', token, body: { doc: forged, baseRevision: revision2 } });
  doc = readDoc().doc;
  check('伪造记录被丢弃', doc.loginLog.length === 3 && !doc.loginLog.some((e) => e.nickname === '伪造者'));

  /* 8. 超出上限只保留最近 300 条 */
  const { revision: revision3 } = readDoc();
  let bulkDoc = JSON.parse(JSON.stringify(readDoc().doc));
  bulkDoc.loginLog = Array.from({ length: 400 }, (_, i) => ({
    at: new Date(Date.now() + i).toISOString(), nickname: `批量${i}`, action: 'intro', ip: '', ua: '',
  }));
  await callHandler(data, { method: 'PUT', token, body: { doc: bulkDoc, baseRevision: revision3 } });
  doc = readDoc().doc;
  check('客户端塞 400 条也被服务端接管（保留服务端 3 条）', doc.loginLog.length === 3, `实际 ${doc.loginLog.length}`);

  /* 9. 直接验证 appendLoginLog 的 300 上限（服务端真实写入路径） */
  for (let i = 0; i < 320; i += 1) {
    await callHandler(auth, { body: { action: 'intro', passcode: 'hw2025', nickname: `压测${i}` } });
  }
  doc = readDoc().doc;
  check('连续登录后记录数不超过 300', doc.loginLog.length <= 300, `实际 ${doc.loginLog.length}`);
  check('保留的是最近的记录', doc.loginLog[doc.loginLog.length - 1].nickname === '压测319', doc.loginLog[doc.loginLog.length - 1].nickname);

  /* 10. 不记录 IP：即使客户端伪造 x-forwarded-for，也不该进日志
   * 背景：Deno Deploy 不提供真实客户端 IP，且对客户端自带的 x-forwarded-for
   * 既不校验也不覆盖（原样透传）。记一个可伪造的值比不记更糟，所以干脆不采集。
   */
  await callHandler(auth, {
    body: { action: 'intro', passcode: 'hw2025', nickname: '伪造者' },
    headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
  });
  const spoofed = readDoc().doc.loginLog.slice(-1)[0];
  check('伪造 x-forwarded-for 不会被记入日志', spoofed.ip === undefined, `ip = ${JSON.stringify(spoofed.ip)}`);
  check('记录里有 ua', /LoginLogTest/.test(spoofed.ua || ''), spoofed.ua);
  check('记录里有时间/昵称/动作', Boolean(spoofed.at && spoofed.nickname && spoofed.action));

  /* 清理 */
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(1);
});
