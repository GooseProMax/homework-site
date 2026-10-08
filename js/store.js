/* global window, U */
/* 数据仓库：状态、增删改、撤销重做、自动保存、轮询同步 */
(function () {
  'use strict';

  const CACHE_KEY = 'hw.cache';
  const LOCAL_KEY = 'hw.localdoc';

  const DEFAULT_DOC = {
    version: 1,
    createdAt: '',
    updatedAt: '',
    settings: {
      title: '本学期作业板',
      semester: '',
      semesterStart: '',
      weeks: 16,
      passcodeSalt: '',
      passcodeHash: '',
      initializedAt: null,
    },
    courses: [],
    assignments: [],
    members: [],
  };

  function normalizeDoc(raw) {
    const doc = JSON.parse(JSON.stringify(DEFAULT_DOC));
    if (!raw || typeof raw !== 'object') return doc;
    Object.keys(raw).forEach((key) => { doc[key] = raw[key]; });
    doc.settings = Object.assign({}, DEFAULT_DOC.settings, raw.settings || {});
    doc.courses = Array.isArray(raw.courses) ? raw.courses : [];
    doc.assignments = Array.isArray(raw.assignments) ? raw.assignments : [];
    doc.members = Array.isArray(raw.members) ? raw.members : [];
    return doc;
  }

  const store = {
    doc: normalizeDoc(null),
    revision: 0,
    nickname: (window.Api && window.Api.nickname) || '我',
    offline: false,
    mode: 'server', // server | local（本地模式：数据只在这台设备）
    dirty: false,
    listeners: [],
    history: [],
    future: [],
    saving: false,
    lastSavedAt: '',
    error: '',
  };

  function api() {
    return window.Api;
  }

  function emit(event) {
    store.listeners.forEach((fn) => {
      try {
        fn(event || {});
      } catch (err) {
        console.error('[store listener]', err);
      }
    });
  }

  function onChange(fn) {
    store.listeners.push(fn);
  }

  /* --------------------------- 本地缓存（防手滑丢数据） --------------------------- */
  function saveCache() {
    try {
      const payload = { doc: store.doc, revision: store.revision, at: new Date().toISOString() };
      localStorage.setItem(store.mode === 'local' ? LOCAL_KEY : CACHE_KEY, JSON.stringify(payload));
    } catch (err) {
      if (String(err && err.name).includes('Quota')) {
        U.toast('图片太多，浏览器本地缓存写不下了（云端数据不受影响）', 'warn', 4000);
      }
    }
  }

  function loadCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.doc) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  /* ------------------------------- 初始化 ------------------------------- */
  async function init() {
    const local = loadCache(LOCAL_KEY);
    const client = api();

    if (!client || client.offline) {
      store.mode = 'local';
      store.offline = true;
      store.doc = normalizeDoc(local ? local.doc : null);
      if (!store.doc.createdAt) store.doc.createdAt = new Date().toISOString();
      emit({ type: 'init' });
      return store;
    }

    const cached = loadCache(CACHE_KEY);
    if (cached) {
      store.doc = normalizeDoc(cached.doc);
      store.revision = Number(cached.revision) || 0;
    }

    try {
      const { doc, revision } = await client.load();
      if (doc) {
        store.doc = normalizeDoc(doc);
        store.revision = Number(revision) || 0;
        store.mode = 'server';
        saveCache();
      } else {
        // 服务器还没数据：把本地缓存（如果有）推上去
        store.mode = 'server';
        if (cached && cached.doc && (cached.doc.courses || []).length) await pushSave(true);
      }
    } catch (err) {
      if (err.status === 401) throw err;
      store.offline = true;
      store.mode = 'local';
      store.doc = normalizeDoc(cached ? cached.doc : null);
      store.error = err.message;
      U.toast('连不上服务器，已切换到本地模式（数据只保存在这台设备）', 'warn', 4000);
    }
    emit({ type: 'init' });
    return store;
  }

  /* ------------------------------- 撤销重做 ------------------------------- */
  function snapshot() {
    store.history.push({ doc: JSON.parse(JSON.stringify(store.doc)), revision: store.revision });
    if (store.history.length > 60) store.history.shift();
    store.future.length = 0;
  }

  function undo() {
    if (!store.history.length) return false;
    const state = store.history.pop();
    store.future.push({ doc: JSON.parse(JSON.stringify(store.doc)), revision: store.revision });
    store.doc = state.doc;
    store.revision = Math.max(0, (store.revision || 0) - 1);
    touch();
    return true;
  }

  function redo() {
    if (!store.future.length) return false;
    const state = store.future.pop();
    store.history.push({ doc: JSON.parse(JSON.stringify(store.doc)), revision: store.revision });
    store.doc = state.doc;
    store.revision = Math.max(0, (store.revision || 0) - 1);
    touch();
    return true;
  }

  /* ------------------------------- 保存 ------------------------------- */
  let saveTimer = null;

  function touch() {
    store.dirty = true;
    store.doc.updatedAt = new Date().toISOString();
    saveCache();
    emit({ type: 'change' });
    if (store.mode === 'local') {
      store.dirty = false;
      store.lastSavedAt = new Date().toISOString();
      emit({ type: 'saved', local: true });
      return;
    }
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    emit({ type: 'saving' });
    saveTimer = setTimeout(() => { pushSave(false); }, 700);
  }

  async function pushSave(force) {
    const client = api();
    if (store.mode === 'local' || !client) return;
    if (store.saving) {
      scheduleSave();
      return;
    }
    if (!store.dirty && !force) return;
    store.saving = true;
    try {
      const { revision } = await client.save(store.doc, store.revision);
      store.revision = Number(revision) || store.revision;
      store.dirty = false;
      store.offline = false;
      store.error = '';
      store.lastSavedAt = new Date().toISOString();
      saveCache();
      emit({ type: 'saved' });
    } catch (err) {
      if (err.status === 409 && err.payload) {
        // 别人也改过：两边合并（同一条取 updatedAt 更新的那版）
        const remote = normalizeDoc(err.payload.doc);
        store.doc = mergeDocs(remote, store.doc);
        store.revision = Number(err.payload.revision) || store.revision;
        U.toast('检测到其他人的修改，已自动合并', 'warn', 3200);
        store.dirty = true;
        saveCache();
        emit({ type: 'merged' });
        store.saving = false;
        scheduleSave();
        return;
      }
      if (err.status === 401) {
        store.error = err.message;
        emit({ type: 'error', error: err.message });
        return;
      }
      store.offline = true;
      store.error = err.message;
      emit({ type: 'error', error: err.message });
      U.toast(`保存失败：${err.message}`, 'err', 4000);
    } finally {
      store.saving = false;
    }
  }

  /** 合并两份文档：远端为准，本地更新的条目覆盖远端 */
  function mergeDocs(remote, local) {
    const result = normalizeDoc(remote);
    const byId = new Map();
    result.assignments.forEach((a) => byId.set(a.id, a));
    local.assignments.forEach((mine) => {
      const theirs = byId.get(mine.id);
      if (!theirs) {
        byId.set(mine.id, mine);
        return;
      }
      const mineTime = Date.parse(mine.updatedAt || 0) || 0;
      const theirTime = Date.parse(theirs.updatedAt || 0) || 0;
      if (mineTime > theirTime) byId.set(mine.id, mine);
    });
    result.assignments = Array.from(byId.values());
    const courseIds = new Set(result.courses.map((c) => c.id));
    local.courses.forEach((c) => { if (!courseIds.has(c.id)) result.courses.push(c); });
    return result;
  }

  /* ------------------------------- 课程 ------------------------------- */
  function courseById(id) {
    return store.doc.courses.find((c) => c.id === id) || null;
  }

  function addCourse(data) {
    snapshot();
    const course = {
      id: U.uid('course'),
      name: String(data.name || '').trim() || '未命名课程',
      teacher: String(data.teacher || '').trim(),
      location: String(data.location || '').trim(),
      color: data.color || U.pickColor(store.doc.courses.length),
      day: data.day === '' || data.day === undefined || data.day === null ? null : Number(data.day),
      slot: String(data.slot || '').trim(),
      note: String(data.note || '').trim(),
      createdAt: new Date().toISOString(),
    };
    store.doc.courses.push(course);
    touch();
    return course;
  }

  function updateCourse(id, patch) {
    const index = store.doc.courses.findIndex((c) => c.id === id);
    if (index < 0) return null;
    snapshot();
    store.doc.courses[index] = Object.assign({}, store.doc.courses[index], patch, { updatedAt: new Date().toISOString() });
    touch();
    return store.doc.courses[index];
  }

  function removeCourse(id) {
    const used = store.doc.assignments.filter((a) => a.courseId === id);
    if (used.length) {
      const names = used.slice(0, 3).map((a) => a.title).join('、');
      if (!window.confirm(`这门课下面还有 ${used.length} 条作业（${names}…），删除课程会同时删掉它们，确定吗？`)) return false;
    }
    snapshot();
    store.doc.courses = store.doc.courses.filter((c) => c.id !== id);
    store.doc.assignments = store.doc.assignments.filter((a) => a.courseId !== id);
    touch();
    return true;
  }

  /* ------------------------------- 作业 ------------------------------- */
  function addAssignment(data) {
    snapshot();
    const now = new Date().toISOString();
    const item = {
      id: U.uid('hw'),
      courseId: data.courseId || null,
      week: Number(data.week) || 1,
      type: data.type === 'major' ? 'major' : (data.type === 'exam' ? 'exam' : 'homework'),
      title: String(data.title || '').trim() || '未命名作业',
      detail: String(data.detail || '').trim(),
      deadline: data.deadline || '',
      links: Array.isArray(data.links) ? data.links.filter(Boolean) : [],
      images: Array.isArray(data.images) ? data.images : [],
      status: 'todo',
      hasDone: false, // 是否已有人完成（status 只表示「我」是否完成）
      doneBy: [],
      createdBy: store.nickname,
      createdAt: now,
      updatedAt: now,
    };
    store.doc.assignments.push(item);
    touch();
    return item;
  }

  function updateAssignment(id, patch, options) {
    const index = store.doc.assignments.findIndex((a) => a.id === id);
    if (index < 0) return null;
    if (!options || options.snapshot !== false) snapshot();
    const previous = store.doc.assignments[index];
    store.doc.assignments[index] = Object.assign({}, previous, patch, { updatedAt: new Date().toISOString() });
    touch();
    return store.doc.assignments[index];
  }

  function removeAssignment(id) {
    snapshot();
    store.doc.assignments = store.doc.assignments.filter((a) => a.id !== id);
    touch();
  }

  function toggleDone(id, nickname) {
    const who = nickname || store.nickname;
    const item = store.doc.assignments.find((a) => a.id === id);
    if (!item) return;
    snapshot();
    const list = Array.isArray(item.doneBy) ? item.doneBy.slice() : [];
    const index = list.indexOf(who);
    if (index >= 0) list.splice(index, 1);
    else list.push(who);
    item.doneBy = list;
    item.hasDone = list.length > 0;
    item.status = list.length ? 'done' : 'todo';
    item.updatedAt = new Date().toISOString();
    touch();
  }

  function isDoneByMe(item) {
    return Array.isArray(item.doneBy) && item.doneBy.includes(store.nickname);
  }

  /* ------------------------------- 设置 ------------------------------- */
  function updateSettings(patch) {
    snapshot();
    store.doc.settings = Object.assign({}, store.doc.settings, patch);
    touch();
  }

  /* ------------------------------- 导入导出 ------------------------------- */
  function exportJson() {
    return JSON.stringify({ exportedAt: new Date().toISOString(), doc: store.doc }, null, 2);
  }

  function importJson(text, mode) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return Promise.reject(new Error('文件不是合法的 JSON'));
    }
    const incoming = normalizeDoc(parsed.doc || parsed);
    snapshot();
    if (mode === 'replace') {
      store.doc = incoming;
    } else {
      const byId = new Map(store.doc.assignments.map((a) => [a.id, a]));
      incoming.assignments.forEach((a) => byId.set(a.id, a));
      store.doc.assignments = Array.from(byId.values());
      const courseIds = new Set(store.doc.courses.map((c) => c.id));
      incoming.courses.forEach((c) => { if (!courseIds.has(c.id)) store.doc.courses.push(c); });
    }
    touch();
    return Promise.resolve(store.doc);
  }

  /* ------------------------------- 轮询同步 ------------------------------- */
  let pollTimer = null;

  function startPolling(intervalMs) {
    stopPolling();
    if (store.mode === 'local') return;
    pollTimer = setInterval(async () => {
      if (document.hidden || store.saving || store.dirty) return;
      const client = api();
      if (!client) return;
      try {
        const { revision } = await client.probeRevision();
        if (Number(revision) !== Number(store.revision)) await pullRemote();
      } catch (_) {
        /* 网络抖动忽略 */
      }
    }, intervalMs || 20000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pullRemote() {
    const client = api();
    if (!client) return false;
    try {
      const { doc, revision } = await client.load();
      if (!doc) return false;
      const remote = normalizeDoc(doc);
      const remoteTime = Date.parse(remote.updatedAt || 0) || 0;
      const localTime = Date.parse(store.doc.updatedAt || 0) || 0;
      if (remoteTime <= localTime && !store.dirty) return false;
      store.doc = store.dirty ? mergeDocs(remote, store.doc) : remote;
      store.revision = Number(revision) || store.revision;
      store.offline = false;
      saveCache();
      emit({ type: 'remote' });
      if (store.dirty) scheduleSave();
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------- 统计 ------------------------------- */
  function stats() {
    const total = store.doc.assignments.length;
    const done = store.doc.assignments.filter(isDoneByMe).length;
    const majors = store.doc.assignments.filter((a) => a.type === 'major');
    const doneMajors = majors.filter(isDoneByMe).length;
    const overdue = store.doc.assignments.filter((a) => {
      if (isDoneByMe(a) || !a.deadline) return false;
      const due = U.toDateOnly(a.deadline);
      return Boolean(due) && due.getTime() < Date.now();
    }).length;
    return { total, done, majors: majors.length, doneMajors, overdue, percent: total ? Math.round((done / total) * 100) : 0 };
  }

  window.Store = Object.assign(store, {
    init, normalizeDoc, onChange, emit, mergeDocs,
    touch, snapshot, undo, redo, pushSave, pullRemote,
    courseById, addCourse, updateCourse, removeCourse,
    addAssignment, updateAssignment, removeAssignment, toggleDone, isDoneByMe,
    updateSettings, exportJson, importJson,
    startPolling, stopPolling, stats,
  });
}());
