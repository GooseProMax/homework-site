'use strict';

/**
 * 把线上课程表渲染成「星期 × 节次」的文本课程表，方便核对。
 *   node scripts/render-timetable.js
 */

const BASE = process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.env.PASSCODE || '0304';
const NICKNAME = process.env.NICKNAME || '水煮大白鹅';

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
// 你们学校的时间表（按截图推算）
const SLOT_TIMES = {
  '第1-2节': '08:50-09:35',
  '第3-4节': '09:55-11:30',
  '第6-7节': '13:00-14:35',
  '第8-9节': '14:50-16:25',
};

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

function width(text) {
  // 中文按 2 个宽度算
  let n = 0;
  for (const ch of String(text)) n += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

function pad(text, target) {
  const diff = target - width(text);
  return text + ' '.repeat(Math.max(0, diff));
}

(async () => {
  const login = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: NICKNAME });
  const token = login.payload.token;
  const data = await call('GET', '/api/data', undefined, token);
  const doc = data.payload.doc;

  const slots = Array.from(new Set(doc.courses.map((c) => c.slot).filter(Boolean)))
    .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 99) - (parseInt(b.replace(/\D/g, ''), 10) || 99));

  console.log('\n' + '='.repeat(96));
  console.log(`  课程表 · ${doc.settings.semester || ''}   (第1周周一 ${doc.settings.semesterStart || '未设置'})`);
  console.log('='.repeat(96));

  const header = pad('节次', 18) + DAYS.slice(0, 5).map((d) => pad(d, 22)).join('');
  console.log(header);
  console.log('-'.repeat(18 + 22 * 5));

  slots.forEach((slot) => {
    const label = `${slot} ${SLOT_TIMES[slot] || ''}`.trim();
    let line = pad(label, 18);
    for (let day = 1; day <= 5; day += 1) {
      const names = doc.courses.filter((c) => Number(c.day) === day && c.slot === slot).map((c) => c.name);
      line += pad(names.length ? names.join(' / ') : '·', 22);
    }
    console.log(line);
  });
  console.log('-'.repeat(96));

  const unplaced = doc.courses.filter((c) => !c.day || !c.slot);
  if (unplaced.length) {
    console.log('未排时间的课程：' + unplaced.map((c) => c.name).join('、'));
  }

  console.log(`\n共 ${doc.courses.length} 门课，涉及 ${doc.courses.reduce((sum, c) => sum + (c.name.length > 0 ? 1 : 0), 0)} 个条目`);
  console.log(`作业 ${doc.assignments.length} 条｜成员：${(doc.members || []).map((m) => m.nickname).join('、')}`);
  console.log('='.repeat(96) + '\n');
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
