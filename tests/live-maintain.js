'use strict';

/**
 * 线上维护脚本：改口令 + 验证数据持久化 + 清理测试成员。
 *
 *   node tests/live-maintain.js status  <口令>
 *   node tests/live-maintain.js passcode <当前口令> <新口令>
 *   node tests/live-maintain.js verify   <口令>      写入 → 等待 → 重读 → 校验持久化
 */

const BASE = process.env.BASE || 'https://homework-site.goosepromax.deno.net';

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

async function login(passcode, nickname) {
  const intro = await call('POST', '/api/auth', { action: 'intro', passcode, nickname });
  if (intro.status !== 200) throw new Error(`登录失败（HTTP ${intro.status}）：${JSON.stringify(intro.payload)}`);
  return intro.payload.token;
}

async function showStatus() {
  const status = await call('GET', '/api/auth?action=status');
  const s = status.payload;
  console.log(`  已初始化：${s.initialized}`);
  console.log(`  成员：${(s.members || []).map((m) => m.nickname).join(', ') || '（无）'}`);
  console.log(`  数据库：${s.storage}｜密钥：${s.secretConfigured ? '已配置' : '未配置'}`);
  const probe = await call('GET', '/api/data?probe=1');
  console.log(`  当前数据版本 revision：${probe.payload && probe.payload.revision}`);
  return s;
}

async function changePasscode(current, next, nickname) {
  const token = await login(current, nickname);
  const result = await call('POST', '/api/auth', { action: 'passcode', passcode: current, newPasscode: next }, token);
  console.log(`  改口令：HTTP ${result.status}  ${JSON.stringify(result.payload)}`);
  const oldTry = await call('POST', '/api/auth', { action: 'intro', passcode: current, nickname: 'old-pass-check' });
  console.log(`  旧口令是否失效：${oldTry.status === 401 ? '✅ 已失效' : `⚠️ HTTP ${oldTry.status}`}`);
  const newTry = await call('POST', '/api/auth', { action: 'intro', passcode: next, nickname: nickname });
  console.log(`  新口令是否可用：${newTry.status === 200 ? '✅ 可用' : `❌ HTTP ${newTry.status}`}`);
  return newTry.payload.token;
}

async function verify(passcode, nickname) {
  const token = await login(passcode, nickname);
  const before = await call('GET', '/api/data', undefined, token);
  console.log(`  读取：revision=${before.payload.revision}，作业 ${before.payload.doc.assignments.length} 条，课程 ${before.payload.doc.courses.length} 门`);

  const doc = JSON.parse(JSON.stringify(before.payload.doc));
  const marker = `__持久化验证__${Date.now()}`;
  doc.settings.semester = marker;
  const saved = await call('PUT', '/api/data', { doc, baseRevision: before.payload.revision }, token);
  console.log(`  写入：HTTP ${saved.status}，新 revision=${saved.payload && saved.payload.revision}`);
  if (saved.status !== 200) throw new Error('写入失败');

  console.log('  等待 3 秒后重新读取（验证真的落到 Deno KV，而不是内存）…');
  await new Promise((r) => setTimeout(r, 3000));

  const after = await call('GET', '/api/data', undefined, token);
  const ok = after.payload.doc.settings.semester === marker;
  console.log(`  重读：semester = ${JSON.stringify(after.payload.doc.settings.semester)}`);
  console.log(`  持久化结果：${ok ? '✅ 数据确实存进 Deno KV 了' : '❌ 没读到刚写的内容'}`);

  // 恢复原值
  const restore = JSON.parse(JSON.stringify(after.payload.doc));
  restore.settings.semester = before.payload.doc.settings.semester;
  const restored = await call('PUT', '/api/data', { doc: restore, baseRevision: after.payload.revision }, token);
  console.log(`  还原原值：HTTP ${restored.status}`);
  return ok;
}

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  console.log(`\n站点：${BASE}`);
  console.log(`操作：${command || '(无)'}\n`);
  try {
    if (command === 'status') {
      await showStatus();
    } else if (command === 'passcode') {
      const [current, next] = rest;
      if (!current || !next) throw new Error('用法：node tests/live-maintain.js passcode <当前口令> <新口令>');
      await changePasscode(current, next, '维护脚本');
      console.log('\n  改完后的状态：');
      await showStatus();
    } else if (command === 'verify') {
      const [passcode] = rest;
      if (!passcode) throw new Error('用法：node tests/live-maintain.js verify <口令>');
      const ok = await verify(passcode, '维护脚本');
      process.exitCode = ok ? 0 : 1;
    } else {
      console.log('用法：');
      console.log('  node tests/live-maintain.js status');
      console.log('  node tests/live-maintain.js passcode <当前口令> <新口令>');
      console.log('  node tests/live-maintain.js verify <口令>');
    }
  } catch (err) {
    console.error('❌ ' + err.message);
    process.exitCode = 1;
  }
})();
