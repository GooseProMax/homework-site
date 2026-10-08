'use strict';

/**
 * 收尾：清掉最后一个测试账号，打印最终成员名单与站点状态。
 *   node tests/finalize.js
 */

const BASE = process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.env.PASSCODE || '0304';
const TEST_NAMES = ['诊断', '维护脚本', '验证账号', '清理工具'];

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
  try {
    return { status: response.status, payload: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, payload: { raw: text.slice(0, 200) } };
  }
}

(async () => {
  const login = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: '临时收尾' });
  if (login.status !== 200) throw new Error(`登录失败：${JSON.stringify(login.payload)}`);
  const token = login.payload.token;

  const status = await call('GET', '/api/auth?action=status');
  const names = (status.payload.members || []).map((m) => m.nickname);
  const removable = names.filter((n) => TEST_NAMES.includes(n) || n === '临时收尾');
  console.log('当前成员：' + names.join(', '));

  if (removable.length) {
    const removed = await call('POST', '/api/auth', { action: 'member-remove', names: removable }, token);
    console.log(`移除测试账号 ${removable.join(', ')} → HTTP ${removed.status} ${JSON.stringify(removed.payload)}`);
  }

  const finalStatus = await call('GET', '/api/auth?action=status');
  const finalNames = (finalStatus.payload.members || []).map((m) => m.nickname);

  const data = await call('GET', '/api/data', undefined, token);
  const doc = data.payload.doc;

  console.log('\n================ 最终状态 ================');
  console.log(`网址        ${BASE}`);
  console.log(`口令        已设置（${PASSCODE}）`);
  console.log(`成员        ${finalNames.join(', ') || '（空）'}`);
  console.log(`课程        ${doc.courses.length} 门`);
  console.log(`作业        ${doc.assignments.length} 条（其中大作业 ${doc.assignments.filter((a) => a.type === 'major').length} 条）`);
  console.log(`数据版本    revision ${data.payload.revision}`);
  console.log(`数据库      ${finalStatus.payload.storage}`);
  console.log('==========================================\n');
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
