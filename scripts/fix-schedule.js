'use strict';

/**
 * 课表微调：规范节次写法 + 校验「当前周次」计算。
 *   node scripts/fix-schedule.js
 */

const BASE = process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.env.PASSCODE || '0304';
const NICKNAME = process.env.NICKNAME || '水煮大白鹅';

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

/** 把 89节 / 8-9 / 第8节 之类统一成「第8-9节」 */
function normalizeSlot(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^第.*节$/.test(text)) return text;
  const nums = text.match(/\d+/g);
  if (!nums || !nums.length) return text;
  if (nums.length === 1) {
    const only = nums[0];
    if (only.length === 2) return `第${only[0]}-${only[1]}节`;
    return `第${only}节`;
  }
  return `第${nums[0]}-${nums[1]}节`;
}

/** 与前端 U.guessCurrentWeek 完全一致的算法，用来验证「本周」对不对 */
function guessCurrentWeek(semesterStart) {
  let start = semesterStart ? new Date(`${semesterStart}T00:00:00`) : null;
  if (!start || Number.isNaN(start.getTime())) {
    const now = new Date();
    const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    start = new Date(year, 8, 1);
  }
  const day = start.getDay() || 7;
  const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - (day - 1));
  const diffDays = Math.floor((Date.now() - monday) / 86400000);
  return Math.floor(diffDays / 7) + 1;
}

(async () => {
  const login = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: NICKNAME });
  if (login.status !== 200) throw new Error(`登录失败：${JSON.stringify(login.payload)}`);
  const token = login.payload.token;
  const data = await call('GET', '/api/data', undefined, token);
  const doc = data.payload.doc;

  console.log(`\n1) 节次规范化`);
  let changed = 0;
  doc.courses.forEach((course) => {
    const fixed = normalizeSlot(course.slot);
    if (fixed !== course.slot) {
      console.log(`   ${course.name}：${JSON.stringify(course.slot)} → ${JSON.stringify(fixed)}`);
      course.slot = fixed;
      course.updatedAt = new Date().toISOString();
      changed += 1;
    }
  });
  if (!changed) console.log('   （无需修改）');

  const wanted = ['2026-2027 第1学期', '2026-2027 第 1 学期'];
  if (!doc.settings.semester) {
    doc.settings.semester = '2026-2027 第1学期';
    console.log(`   学期名称补上：${doc.settings.semester}`);
    changed += 1;
  }
  if (!doc.settings.semesterStart) {
    doc.settings.semesterStart = '2026-09-07';
    console.log(`   第1周周一补上：${doc.settings.semesterStart}`);
    changed += 1;
  }

  if (changed) {
    const saved = await call('PUT', '/api/data', { doc, baseRevision: data.payload.revision }, token);
    console.log(`\n   保存：HTTP ${saved.status} ${JSON.stringify(saved.payload)}`);
  }

  const after = await call('GET', '/api/data', undefined, token);
  const finalDoc = after.payload.doc;

  console.log(`\n2) 当前周次校验`);
  const week = guessCurrentWeek(finalDoc.settings.semesterStart);
  console.log(`   第1周周一：${finalDoc.settings.semesterStart}｜按算法今天属于第 ${week} 周`);

  console.log(`\n3) 最终课程表（${finalDoc.courses.length} 门）`);
  finalDoc.courses
    .slice()
    .sort((a, b) => (Number(a.day) || 9) - (Number(b.day) || 9) || String(a.slot).localeCompare(String(b.slot), 'zh'))
    .forEach((c) => console.log(`   ${(DAYS[c.day] || '未排时间').padEnd(5)} ${String(c.slot || '—').padEnd(8)} ${c.name}${c.location ? ` @${c.location}` : ''}`));

  console.log(`\n4) 作业（${finalDoc.assignments.length} 条）`);
  finalDoc.assignments.forEach((a) => {
    const course = finalDoc.courses.find((c) => c.id === a.courseId);
    console.log(`   第${a.week}周 ${a.type === 'major' ? '[大作业] ' : ''}${a.title}${course ? ` (${course.name})` : ''}${a.deadline ? ` 截止 ${String(a.deadline).slice(0, 10)}` : ''}${(a.doneBy || []).length ? ` 已完成:${(a.doneBy || []).join('/')}` : ''}`);
  });
  console.log('');
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
