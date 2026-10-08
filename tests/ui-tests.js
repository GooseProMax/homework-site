'use strict';

/**
 * 前端逻辑测试（不需要浏览器）：
 *   node tests/ui-tests.js
 *
 * 用最小 DOM 桩加载 js/util.js 与 js/store.js，验证：
 *   周次日期计算、合并冲突、撤销重做、课程/作业增删改、统计、导入导出，
 *   以及 HTML 里被引用的元素 id / data-action 是否真的存在（防手滑打错）。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? `\n     ↳ ${detail}` : ''}`);
  }
}

/* ------------------------------ 最小 DOM 桩 ------------------------------ */
function makeSandbox() {
  const storage = new Map();
  const listeners = {};

  function makeNode(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      style: {},
      dataset: {},
      attributes: {},
      className: '',
      textContent: '',
      innerHTML: '',
      value: '',
      hidden: false,
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter((c) => c !== child); },
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key]; },
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() {},
      remove() {},
      className: '',
    };
    return node;
  }

  const document = {
    createElement: makeNode,
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    createDocumentFragment: () => makeNode('fragment'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    body: makeNode('body'),
    hidden: false,
  };

  const window = {
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    Blob: class Blob {
      constructor(parts) { this.size = Buffer.byteLength(parts.join(''), 'utf8'); }
    },
    setTimeout,
    clearTimeout,
    console,
    confirm: () => true,
    prompt: () => '我',
    addEventListener() {},
    location: { protocol: 'http:', reload() {} },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    alert: () => {},
  };
  window.window = window;
  window.self = window;

  // 让 window === 全局对象，这样脚本里的 window.U / window.Api 就是测试能读到的全局
  const sandbox = window;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = window.localStorage;
  sandbox.Blob = window.Blob;
  sandbox.location = window.location;
  sandbox.fetch = window.fetch;
  if (typeof sandbox.setInterval !== 'function') sandbox.setInterval = setInterval;
  if (typeof sandbox.clearInterval !== 'function') sandbox.clearInterval = clearInterval;
  vm.createContext(sandbox);
  return sandbox;
}

function loadScript(sandbox, relative) {
  const code = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  vm.runInContext(code, sandbox, { filename: relative });
}

/* ------------------------------ 静态检查 ------------------------------ */
function staticChecks() {
  console.log('\n前端静态检查…\n');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = ['js/util.js', 'js/api.js', 'js/store.js', 'js/render.js', 'js/modals.js', 'js/app.js'];
  const sources = scripts.map((file) => ({ file, code: fs.readFileSync(path.join(ROOT, file), 'utf8') }));

  // 1. HTML 里引用的脚本文件都存在、且都被 <script> 引到
  scripts.forEach((file) => {
    check(`index.html 引用了 ${file}`, html.includes(`src="${file}"`), `缺少 <script src="${file}">`);
  });

  // 2. 代码里 $('#xxx') 用到的 id 必须在 HTML 里存在
  const htmlIds = new Set(Array.from(html.matchAll(/id="([A-Za-z0-9_-]+)"/g)).map((m) => m[1]));
  const missingIds = new Set();
  sources.forEach(({ file, code }) => {
    Array.from(code.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)).forEach((match) => {
      if (!htmlIds.has(match[1])) missingIds.add(`${file} → #${match[1]}`);
    });
    Array.from(code.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)).forEach((match) => {
      if (!htmlIds.has(match[1])) missingIds.add(`${file} → #${match[1]}`);
    });
  });
  check('代码引用的元素 id 都存在于 index.html', missingIds.size === 0, Array.from(missingIds).join(', '));

  // 3. 所有 data-action 都必须在 app.js 里被处理（登录用的 action 除外）
  const appCode = sources.find((s) => s.file === 'js/app.js').code;
  const handled = new Set(Array.from(appCode.matchAll(/action === '([a-z-]+)'/g)).map((m) => m[1]));
  const nonUiActions = new Set(['setup', 'intro', 'login', 'logout', 'passcode', 'modal-btn']);
  const declared = new Set();
  sources.forEach(({ code }) => {
    Array.from(code.matchAll(/dataset: \{ action: '([a-z-]+)'/g)).forEach((m) => declared.add(m[1]));
  });
  const unhandled = Array.from(declared).filter((action) => !handled.has(action) && !nonUiActions.has(action));
  check('每个按钮动作都有对应处理', unhandled.length === 0, unhandled.join(', '));

  // 4. 每个脚本自身语法正确（vm 里试跑会暴露语法错）
  sources.forEach(({ file, code }) => {
    let ok = true;
    let message = '';
    try {
      new vm.Script(code, { filename: file });
    } catch (err) {
      ok = false;
      message = err.message;
    }
    check(`${file} 语法正确`, ok, message);
  });

  return { html };
}

/* ------------------------------ 逻辑测试 ------------------------------ */
function logicChecks() {
  console.log('\n前端逻辑测试（DOM 桩）…\n');

  const sandbox = makeSandbox();
  loadScript(sandbox, 'js/util.js');
  loadScript(sandbox, 'js/api.js');
  loadScript(sandbox, 'js/store.js');

  const U = sandbox.U;
  const Store = sandbox.Store;

  check('工具库加载成功', Boolean(U && U.el && U.relativeDue));
  check('数据仓库加载成功', Boolean(Store && Store.normalizeDoc));

  /* ---- 日期 ---- */
  const due = U.relativeDue(new Date(Date.now() + 86400000).toISOString());
  check('截止时间显示「明天截止」', due && due.kind === 'due-soon' && due.text.includes('明天'), JSON.stringify(due));

  const overdue = U.relativeDue(new Date(Date.now() - 3 * 86400000).toISOString());
  check('过期时间标记为 overdue', overdue && overdue.kind === 'overdue', JSON.stringify(overdue));

  const weekRangeOk = U.guessCurrentWeek('2025-09-01') !== null;
  check('周次推算可用', weekRangeOk);

  const roundTrip = U.fromLocalInputValue(U.toLocalInputValue('2025-09-10T07:00:00.000Z'));
  check('截止时间输入框来回转换不丢时间', Math.abs(Date.parse(roundTrip) - Date.parse('2025-09-10T07:00:00.000Z')) < 60000, roundTrip);

  /* ---- 颜色 ---- */
  check('配色循环不越界', U.pickColor(0) === U.pickColor(12) && U.pickColor(13) === U.pickColor(1));
  check('颜色可读性判断正确', U.readableOn('#ffffff') === '#16203a' && U.readableOn('#000000') === '#ffffff');

  /* ---- 文档规范 ----
   */
  const normalized = Store.normalizeDoc({ courses: null, assignments: 'x' });
  check('脏数据被规范化', Array.isArray(normalized.courses) && Array.isArray(normalized.assignments) && normalized.settings.weeks === 16);

  /* ---- 课程与作业 ---- */
  Store.doc = Store.normalizeDoc(null);
  Store.revision = 0;
  Store.mode = 'local';
  Store.nickname = '小张';

  const course = Store.addCourse({ name: '英美文学选读', teacher: '王老师', day: 2, slot: '1-2 节' });
  check('新增课程成功', Boolean(course.id) && Store.doc.courses.length === 1);

  const hw1 = Store.addAssignment({ courseId: course.id, week: 3, title: '第 3 章读书报告', deadline: '2025-09-20T15:00:00.000Z' });
  const hw2 = Store.addAssignment({ courseId: course.id, week: 3, type: 'major', title: '期末论文' });
  check('新增作业成功', Store.doc.assignments.length === 2);
  check('大作业类型被保留', hw2.type === 'major' && hw1.type === 'homework');

  Store.toggleDone(hw1.id, '小张');
  check('我完成作业后 doneBy 记录昵称', Store.isDoneByMe(Store.doc.assignments[0]) && Store.doc.assignments[0].hasDone === true);

  Store.toggleDone(hw1.id, '小李');
  const d1 = Store.doc.assignments[0];
  check('多人可以各自标记完成', d1.doneBy.length === 2 && d1.hasDone === true && d1.status === 'done',
    `doneBy=${JSON.stringify(d1.doneBy)} hasDone=${d1.hasDone}`);

  Store.nickname = '小李';
  check('换一个人看这条作业是「我已标记」', Store.isDoneByMe(Store.doc.assignments[0]));
  Store.nickname = '小张';

  Store.toggleDone(hw1.id, '小李');
  check('取消完成标记生效', !Store.doc.assignments[0].doneBy.includes('小李'));

  const stats = Store.stats();
  check('统计数字正确（2 条作业 / 1 条大作业）', stats.total === 2 && stats.majors === 1, JSON.stringify(stats));

  /* ---- 撤销重做 ---- */
  Store.updateAssignment(hw1.id, { title: '改过的标题' });
  check('编辑生效', Store.doc.assignments[0].title === '改过的标题');
  Store.undo();
  check('撤销恢复原标题', Store.doc.assignments[0].title === '第 3 章读书报告', Store.doc.assignments[0].title);
  Store.redo();
  check('重做又变回新标题', Store.doc.assignments[0].title === '改过的标题');

  /* ---- 合并冲突：同一 id 比 updatedAt，谁新用谁 ---- */
  const localDoc = JSON.parse(JSON.stringify(Store.doc));
  localDoc.assignments[0].updatedAt = new Date(Date.now() + 1000).toISOString();
  localDoc.assignments[0].title = '本地最新';
  const remoteDoc = JSON.parse(JSON.stringify(Store.doc));
  remoteDoc.assignments[0].updatedAt = new Date(Date.now() - 5000).toISOString();
  remoteDoc.assignments[0].title = '别人旧的';
  remoteDoc.assignments.push({
    id: 'remote-only', week: 5, title: '别人新增的', doneBy: [], images: [], links: [],
    updatedAt: new Date().toISOString(),
  });
  remoteDoc.courses.push({ id: 'c-remote', name: '别人加的课', color: '#e5484d' });

  const mergedDoc = Store.mergeDocs(remoteDoc, localDoc);
  const mergedFirst = mergedDoc.assignments.find((a) => a.id === localDoc.assignments[0].id);
  check('合并时同一作业取更新的那版', mergedFirst.title === '本地最新', mergedFirst.title);
  check('合并时保留对方新增的作业', mergedDoc.assignments.some((a) => a.id === 'remote-only'));
  check('合并时保留对方新增的课程', mergedDoc.courses.some((c) => c.id === 'c-remote'));
  check('合并不会丢自己的作业', mergedDoc.assignments.length === 3, String(mergedDoc.assignments.length));

  /* ---- 导入导出 ---- */
  Store.doc = mergedDoc;
  const json = Store.exportJson();
  check('导出内容包含课程和作业', json.includes('英美文学选读') && json.includes('期末论文'));
  Store.doc = Store.normalizeDoc(null);
  const importPromise = Store.importJson(json, 'replace');
  check('importJson 是异步函数', typeof importPromise.then === 'function');
  importPromise.then(() => {
    check('导入后作业数量一致', Store.doc.assignments.length === 3, String(Store.doc.assignments.length));
    check('导入后课程数量一致', Store.doc.courses.length === 2, String(Store.doc.courses.length));

    // 再测一次合并导入：不覆盖已有内容
    Store.doc = Store.normalizeDoc(null);
    Store.addAssignment({ week: 1, title: '已有的作业' });
    return Store.importJson(json, 'merge');
  }).then(() => {
    check('合并导入保留原有作业', Store.doc.assignments.some((a) => a.title === '已有的作业'));
    check('合并导入追加备份里的作业', Store.doc.assignments.length === 4, String(Store.doc.assignments.length));
  }).catch((err) => {
    check('导入流程无异常', false, err.message);
  }).finally(() => {
    finish();
  });
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
  if (failed) process.exitCode = 1;
}

staticChecks();
logicChecks();
