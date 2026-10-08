'use strict';

/**
 * 合并周四第8-9节的两条重复课程：
 *   保留用户自己建的那条（作业挂在它下面），改名为「高级旅游英语口语」、教室改成教3034，
 *   删掉导入时多出来的那条。
 *
 *   node scripts/merge-courses.js
 */

const BASE = process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.env.PASSCODE || '0304';
const NICKNAME = process.env.NICKNAME || '水煮大白鹅';

const KEEP_NAME = '口语';                    // 用户自己建的（作业挂在它下面）
const REMOVE_NAME = '高级旅游英语口语';        // 我导入的重复项
const FINAL_NAME = '高级旅游英语口语';
const FINAL_LOCATION = '教3034';

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

  const keep = doc.courses.find((c) => c.name === KEEP_NAME);
  const remove = doc.courses.find((c) => c.name === REMOVE_NAME);
  if (!keep || !remove) {
    console.log(`找不到要合并的课程：保留项=${Boolean(keep)}，删除项=${Boolean(remove)}（可能已经处理过了）`);
    return;
  }

  const linkedAssignments = doc.assignments.filter((a) => a.courseId === remove.id);
  console.log(`\n合并前：`);
  console.log(`  保留 ${keep.name} (${keep.id})  节次 ${keep.slot}  教室 ${keep.location || '（空）'}`);
  console.log(`  删除 ${remove.name} (${remove.id})  节次 ${remove.slot}  教室 ${remove.location}`);
  console.log(`  挂在「${remove.name}」下的作业：${linkedAssignments.length} 条 → 会转挂到保留的那条`);

  // 1. 保留项改成最终名字/教室
  keep.name = FINAL_NAME;
  keep.location = FINAL_LOCATION;
  keep.slot = '第8-9节';
  keep.updatedAt = new Date().toISOString();

  // 2. 把作业从被删课程转到保留课程
  linkedAssignments.forEach((a) => {
    a.courseId = keep.id;
    a.updatedAt = new Date().toISOString();
  });

  // 3. 删掉重复课程
  doc.courses = doc.courses.filter((c) => c.id !== remove.id);

  const saved = await call('PUT', '/api/data', { doc, baseRevision: data.payload.revision }, token);
  console.log(`\n保存：HTTP ${saved.status} ${JSON.stringify(saved.payload)}`);
  if (saved.status !== 200) throw new Error('保存失败');

  const after = await call('GET', '/api/data', undefined, token);
  const finalDoc = after.payload.doc;
  console.log(`\n合并后课程（${finalDoc.courses.length} 门）：`);
  finalDoc.courses
    .slice()
    .sort((a, b) => (Number(a.day) || 9) - (Number(b.day) || 9) || String(a.slot).localeCompare(String(b.slot), 'zh'))
    .forEach((c) => console.log(`   ${c.name}${c.location ? ` @${c.location}` : ''}  (${c.slot})`));
  console.log(`\n作业（${finalDoc.assignments.length} 条）：`);
  finalDoc.assignments.forEach((a) => {
    const course = finalDoc.courses.find((c) => c.id === a.courseId);
    console.log(`   第${a.week}周 ${a.title} → ${course ? course.name : '未归类'}`);
  });
  console.log('');
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
