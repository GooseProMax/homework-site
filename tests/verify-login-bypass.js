'use strict';

/**
 * 验证「免口令登录」漏洞已修复。
 *   node tests/verify-login-bypass.js <网址> <正确口令> <已知成员昵称>
 *
 * 修复前：用已有昵称调用 login 不带口令，服务端直接发令牌 → 相当于绕过小组口令。
 * 修复后：必须校验口令。
 */

const BASE = process.argv[2] || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.argv[3] || '0304';
const KNOWN_MEMBER = process.argv[4] || '水煮大白鹅';

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

async function call(body) {
  const response = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 200) };
  }
  return { status: response.status, payload };
}

(async () => {
  console.log(`\n站点：${BASE}\n已知成员：${KNOWN_MEMBER}\n`);

  const status = await (await fetch(`${BASE}/api/auth?action=status`, { signal: AbortSignal.timeout(20000) })).json();
  console.log(`成员名单：${(status.members || []).map((m) => m.nickname).join(', ')}\n`);

  const noPass = await call({ action: 'login', member: KNOWN_MEMBER });
  check('旧漏洞路径：已有昵称 + 不带口令 → 401 拒绝', noPass.status === 401, JSON.stringify(noPass.payload));

  const wrongPass = await call({ action: 'login', passcode: 'definitely-wrong', member: KNOWN_MEMBER });
  check('已有昵称 + 错误口令 → 401 拒绝', wrongPass.status === 401, JSON.stringify(wrongPass.payload));

  const rightPass = await call({ action: 'login', passcode: PASSCODE, member: KNOWN_MEMBER });
  check('已有昵称 + 正确口令 → 登录成功', rightPass.status === 200 && Boolean(rightPass.payload.token), JSON.stringify(rightPass.payload));

  const guest = await call({ action: 'login', member: '随便一个陌生名字' });
  check('陌生昵称 + 不带口令 → 401 拒绝', guest.status === 401, JSON.stringify(guest.payload));

  const introWrong = await call({ action: 'intro', passcode: 'definitely-wrong', nickname: '陌生人' });
  check('intro 错误口令 → 401 拒绝', introWrong.status === 401, JSON.stringify(introWrong.payload));

  console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
  if (fail) process.exitCode = 1;
})();
