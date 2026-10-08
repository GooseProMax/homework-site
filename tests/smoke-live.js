'use strict';

/**
 * 冒烟测试：完全模拟浏览器在前端发出的请求序列（首次进入 → 录课表 → 加作业 → 勾完成 → 同步）。
 * 需要服务器已在 http://127.0.0.1:5173 运行：
 *   node tests/smoke-live.js
 */

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5173';

let token = '';
let ok = 0;
let bad = 0;

function check(name, condition, detail) {
  if (condition) {
    ok += 1;
    console.log(`  ✅ ${name}`);
  } else {
    bad += 1;
    console.log(`  ❌ ${name}${detail ? `\n     ↳ ${detail}` : ''}`);
  }
}

async function call(method, pathname, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: payload };
}

async function main() {
  console.log(`\n对着 ${BASE} 做一次真实链路冒烟测试…\n`);

  const status = await call('GET', '/api/auth?action=status');
  check('拿到站点状态', status.status === 200, JSON.stringify(status.body));

  if (!status.body.initialized) {
    const setup = await call('POST', '/api/auth', { action: 'setup', passcode: 'hw2025', nickname: '我' });
    check('首次初始化（设置口令）成功', setup.status === 200 && Boolean(setup.body.token), JSON.stringify(setup.body));
    token = setup.body.token;
  } else {
    const login = await call('POST', '/api/auth', { action: 'intro', passcode: process.env.SMOKE_PASSCODE || 'hw2025', nickname: '我' });
    if (login.status !== 200) {
      console.log(`  ℹ️  站点已初始化，需要正确口令才能继续（${login.body.error}）。跳过写数据步骤。`);
      return;
    }
    token = login.body.token;
    check('用已配置的口令登录成功', true);
  }

  const loaded = await call('GET', '/api/data');
  check('读到当前数据', loaded.status === 200, JSON.stringify(loaded.body).slice(0, 150));

  const doc = loaded.body.doc;
  const now = new Date().toISOString();
  doc.settings.title = '本学期作业板';
  doc.settings.semester = '2025 秋季学期';
  doc.settings.weeks = 16;

  const courseA = { id: 'c-lit', name: '英美文学选读', teacher: '王老师', location: 'A203', color: '#4361ee', day: 2, slot: '1-2 节', createdAt: now };
  const courseB = { id: 'c-jp', name: '日语', teacher: '田中老师', location: 'B105', color: '#e5484d', day: 4, slot: '3-4 节', createdAt: now };
  const existing = new Set(doc.courses.map((c) => c.id));
  [courseA, courseB].forEach((c) => { if (!existing.has(c.id)) doc.courses.push(c); });

  const samples = [
    { id: 'smoke-1', courseId: 'c-lit', week: 1, type: 'homework', title: '第 1 章读书报告', detail: '800 字，下周一交', deadline: '', doneBy: ['我'], hasDone: true, status: 'done', links: [], images: [] },
    { id: 'smoke-2', courseId: 'c-jp', week: 1, type: 'homework', title: '五十音图默写', detail: '', deadline: '', doneBy: [], status: 'todo', links: [], images: [] },
    { id: 'smoke-3', courseId: 'c-lit', week: 8, type: 'major', title: '期末论文（4000 字）', detail: '选题先报给老师', deadline: '', doneBy: [], status: 'todo', links: [], images: [] },
  ];
  const existingHw = new Set(doc.assignments.map((a) => a.id));
  samples.forEach((item) => {
    if (!existingHw.has(item.id)) doc.assignments.push(Object.assign({ createdAt: now, updatedAt: now }, item));
  });

  const saved = await call('PUT', '/api/data', { doc, baseRevision: loaded.body.revision });
  check('保存课表与示例作业成功', saved.status === 200, JSON.stringify(saved.body).slice(0, 150));

  const reread = await call('GET', '/api/data');
  check('再次读取能看到 2 门课', (reread.body.doc.courses || []).length >= 2, String((reread.body.doc.courses || []).length));
  check('大作业被保存下来', (reread.body.doc.assignments || []).some((a) => a.type === 'major'));
  check('完成状态被保存下来', (reread.body.doc.assignments || []).some((a) => a.id === 'smoke-1' && a.doneBy.includes('我')));
  check('学期设置生效', reread.body.doc.settings.semester === '2025 秋季学期', reread.body.doc.settings.semester);

  console.log(`\n结果：${ok} 项通过，${bad} 项失败\n`);
  if (bad) process.exitCode = 1;
}

main().catch((err) => {
  console.error('冒烟测试出错：', err.message);
  process.exitCode = 1;
});
