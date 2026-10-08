'use strict';

/**
 * 打印线上课程表（按星期 × 节次），用于核对导入结果。
 *   node scripts/show-schedule.js
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

(async () => {
  const login = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: NICKNAME });
  const token = login.payload.token;
  const data = await call('GET', '/api/data', undefined, token);
  const doc = data.payload.doc;

  console.log(`\n课程（${doc.courses.length} 门）`);
  const sorted = doc.courses.slice().sort((a, b) => (Number(a.day) || 9) - (Number(b.day) || 9) || String(a.slot).localeCompare(String(b.slot), 'zh'));
  sorted.forEach((c) => {
    console.log(`  ${(DAYS[c.day] || '未排时间').padEnd(6)} ${String(c.slot || '—').padEnd(9)} ${c.name}${c.location ? `  @${c.location}` : ''}`);
  });

  console.log(`\n作业（${doc.assignments.length} 条）`);
  doc.assignments.forEach((a) => {
    const course = doc.courses.find((c) => c.id === a.courseId);
    const marks = (a.doneBy || []).length ? ` 已完成：${(a.doneBy || []).join('/')}` : '';
    console.log(`  第${a.week}周 ${a.type === 'major' ? '[大作业]' : ''}${a.title}${course ? `  (${course.name})` : ''}${a.deadline ? `  截止 ${String(a.deadline).slice(0, 16).replace('T', ' ')}` : ''}${marks}`);
  });

  console.log(`\n学期：${doc.settings.semester || '（未设置）'}｜第1周周一：${doc.settings.semesterStart || '（未设置）'}｜周数：${doc.settings.weeks}`);
  console.log(`成员：${(doc.members || []).map((m) => m.nickname).join(', ')}`);
  console.log(`revision：${data.payload.revision}\n`);
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
