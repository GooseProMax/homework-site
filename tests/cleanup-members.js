'use strict';

/**
 * 清理测试期间产生的假成员（只删名单里的名字，不动任何作业数据）。
 *
 *   node tests/cleanup-members.js <网址> <口令> <要保留的昵称,逗号分隔>
 *   node tests/cleanup-members.js https://xxx.deno.net 0304 水煮大白鹅
 *
 * 我的测试账号固定是这三个：诊断、维护脚本、验证账号。
 */

const BASE = process.argv[2] || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.argv[3] || '0304';
const KEEP = (process.argv[4] || '').split(',').map((s) => s.trim()).filter(Boolean);
const TEST_NAMES = ['诊断', '维护脚本', '验证账号'];

async function call(method, pathname, body, token) {
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
  return { status: response.status, payload };
}

(async () => {
  console.log(`\n站点：${BASE}`);

  const login = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: '清理工具' });
  if (login.status !== 200) throw new Error(`登录失败（HTTP ${login.status}）：${JSON.stringify(login.payload)}`);
  const token = login.payload.token;

  const loaded = await call('GET', '/api/data', undefined, token);
  const doc = loaded.payload.doc;
  const before = (doc.members || []).map((m) => m.nickname);
  console.log('清理前成员：' + before.join(', '));

  const removable = TEST_NAMES.filter((n) => before.includes(n));
  if (!removable.length) {
    console.log('没有需要清理的测试成员。');
  } else {
    // 成员名单在服务端是「客户端不可改」的字段，所以必须走专门的动作
    const removed = await call('POST', '/api/auth', { action: 'member-remove', names: removable }, token);
    console.log(`请求移除 ${removable.join(', ')} → HTTP ${removed.status} ${JSON.stringify(removed.payload)}`);
  }

  const after = await (await fetch(`${BASE}/api/auth?action=status`, { signal: AbortSignal.timeout(20000) })).json();
  const names = (after.members || []).map((m) => m.nickname);
  console.log('清理后成员：' + (names.join(', ') || '（空）'));
  console.log(`保留的真人账号：${KEEP.length ? KEEP.filter((k) => names.includes(k)).join(', ') || '（未在名单中）' : '（未指定）'}`);
  console.log(`仍有测试账号残留：${names.some((n) => TEST_NAMES.includes(n)) ? '是 ❌' : '否 ✅'}`);
  console.log(`当前作业数：${(doc.assignments || []).length}｜课程数：${(doc.courses || []).length}（这些没有被改动）\n`);
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
