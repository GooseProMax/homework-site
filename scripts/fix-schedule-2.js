'use strict';

/**
 * 按用户的最新说明修正课表：
 *   1. 中国文化的推广与演讲：周二 → 周三
 *   2. 翻译理论与实践 I：周三 → 周五
 *   3. 删除：形势与政策
 *
 *   node src/../scripts/fix-schedule-2.js
 */

const BASE = process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.env.PASSCODE || '0304';
const NICKNAME = process.env.NICKNAME || '水煮大白鹅';

const MOVES = [
  { name: '中国文化的推广与演讲', day: 3, slot: '第6-7节' },
  { name: '翻译理论与实践 I', day: 5, slot: '第3-4节' },
];
const DELETE = ['形势与政策'];

const DAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

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
  return { status: response.status, payload: text ? JSON.parse(text) : null };
}

(async () => {
  const login = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: NICKNAME });
  if (login.status !== 200) throw new Error(`登录失败：${JSON.stringify(login.payload)}`);
  const token = login.payload.token;
  const data = await call('GET', '/api/data', undefined, token);
  const doc = data.payload.doc;

  const now = new Date().toISOString();
  let changed = 0;

  console.log('\n调整：');
  MOVES.forEach((move) => {
    const course = doc.courses.find((c) => c.name === move.name);
    if (!course) {
      console.log(`  ⚠️ 找不到课程「${move.name}」，跳过`);
      return;
    }
    console.log(`  ${course.name}：${DAYS[course.day]} → ${DAYS[move.day]}  ${course.slot} → ${move.slot}`);
    course.day = move.day;
    course.slot = move.slot;
    course.updatedAt = now;
    changed += 1;
  });

  DELETE.forEach((name) => {
    const index = doc.courses.findIndex((c) => c.name === name);
    if (index < 0) {
      console.log(`  ⚠️ 找不到课程「${name}」，跳过`);
      return;
    }
    const [removed] = doc.courses.splice(index, 1);
    const linked = doc.assignments.filter((a) => a.courseId === removed.id);
    if (linked.length) {
      // 有作业挂在被删课程上：改成未归类，避免作业跟着消失
      linked.forEach((a) => {
        a.courseId = null;
        a.updatedAt = now;
      });
      console.log(`  删除 ${removed.name}（它下面 ${linked.length} 条作业已转为「未归类」）`);
    } else {
      console.log(`  删除 ${removed.name}`);
    }
    changed += 1;
  });

  if (changed) {
    const saved = await call('PUT', '/api/data', { doc, baseRevision: data.payload.revision }, token);
    console.log(`\n保存：HTTP ${saved.status} ${JSON.stringify(saved.payload)}`);
  }

  const after = await call('GET', '/api/data', undefined, token);
  const finalDoc = after.payload.doc;
  console.log(`\n调整后的课程表（${finalDoc.courses.length} 门）：`);
  const slotOrder = (slot) => parseInt(String(slot).replace(/\D/g, ''), 10) || 99;
  finalDoc.courses
    .slice()
    .sort((a, b) => (Number(a.day) || 9) - (Number(b.day) || 9) || slotOrder(a.slot) - slotOrder(b.slot))
    .forEach((c) => console.log(`   ${(DAYS[c.day] || '未排').padEnd(4)} ${String(c.slot).padEnd(8)} ${c.name}${c.location ? ` @${c.location}` : ''}`));
  console.log(`\n作业 ${finalDoc.assignments.length} 条：`);
  finalDoc.assignments.forEach((a) => {
    const course = finalDoc.courses.find((c) => c.id === a.courseId);
    console.log(`   第${a.week}周 ${a.title} → ${course ? course.name : '未归类'}`);
  });
  console.log('');
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
