'use strict';

/**
 * 一次性导入课表（按用户提供的截图整理）。
 *   node scripts/import-schedule.js
 */

const BASE = process.env.BASE || 'https://homework-site.goosepromax.deno.net';
const PASSCODE = process.env.PASSCODE || '0304';
const NICKNAME = process.env.NICKNAME || '水煮大白鹅';

// day: 1=周一 … 7=周日；slot 用「第X-Y节」，课程表视图会按这个字符串排序
const COURSES = [
  { name: '英语国家社会与文化', location: '教4005', day: 1, slot: '第1-2节', color: '#4361ee' },
  { name: '日语 II', location: '教3011', day: 1, slot: '第3-4节', color: '#0ea5e9' },
  { name: '跨文化交际', location: '教5005', day: 1, slot: '第6-7节', color: '#14b8a6' },

  { name: '英语词汇学', location: '教4025', day: 2, slot: '第3-4节', color: '#f0a02a' },
  { name: '中国文化的推广与演讲', location: '教2016', day: 2, slot: '第6-7节', color: '#8b5cf6' },
  { name: '英美文学选读 (I)', location: '教1025', day: 2, slot: '第8-9节', color: '#ec4899' },

  { name: '翻译理论与实践 I', location: '教4011', day: 3, slot: '第3-4节', color: '#f97316' },
  { name: '剑桥商务英语', location: '教5007', day: 3, slot: '第8-9节', color: '#a855f7' },

  { name: '形势与政策', location: '线上授课1', day: 4, slot: '第1-2节', color: '#64748b' },
  { name: '高级旅游英语口语', location: '教3034', day: 4, slot: '第8-9节', color: '#84cc16' },
];

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
    return { status: response.status, payload: { raw: text.slice(0, 300) } };
  }
}

(async () => {
  console.log(`\n站点：${BASE}\n`);

  const login = await call('POST', '/api/auth', { action: 'intro', passcode: PASSCODE, nickname: NICKNAME });
  if (login.status !== 200) throw new Error(`登录失败（HTTP ${login.status}）：${JSON.stringify(login.payload)}`);
  const token = login.payload.token;
  console.log(`登录成功：${login.payload.nickname}`);

  const loaded = await call('GET', '/api/data', undefined, token);
  const doc = loaded.payload.doc;
  console.log(`当前数据：课程 ${doc.courses.length} 门，作业 ${doc.assignments.length} 条，revision ${loaded.payload.revision}`);

  const now = new Date().toISOString();
  const courseIds = [];
  const added = [];
  for (const item of COURSES) {
    const id = `course_${item.day}_${item.slot.replace(/[^0-9]/g, '')}_${courseIds.length}`;
    courseIds.push(id);
    added.push({
      id,
      name: item.name,
      teacher: '',
      location: item.location,
      color: item.color,
      day: item.day,
      slot: item.slot,
      note: '',
      createdAt: now,
      updatedAt: now,
    });
  }

  // 保留原有课程（若有），避免覆盖
  const keep = doc.courses.filter((c) => !added.some((a) => a.name === c.name));
  doc.courses = keep.concat(added);

  doc.settings.semester = '2026-2027 第1学期';
  doc.settings.semesterStart = '2026-09-07';

  const saved = await call('PUT', '/api/data', { doc, baseRevision: loaded.payload.revision }, token);
  console.log(`保存课表：HTTP ${saved.status} ${JSON.stringify(saved.payload)}`);
  if (saved.status !== 200) throw new Error('保存失败');

  const check = await call('GET', '/api/data', undefined, token);
  const finalDoc = check.payload.doc;
  console.log(`\n读取确认：共 ${finalDoc.courses.length} 门课`);
  const byDay = {};
  finalDoc.courses.forEach((c) => { byDay[c.day] = (byDay[c.day] || 0) + 1; });
  const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  Object.keys(byDay).sort().forEach((d) => console.log(`  ${dayNames[d]}：${byDay[d]} 门`));
  console.log(`学期设置：${finalDoc.settings.semester}｜第1周周一 ${finalDoc.settings.semesterStart}｜共 ${finalDoc.settings.weeks} 周`);
})().catch((err) => {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
});
