/* global window, document, location, Api, Store, UI, Modals, U */
/* 应用入口：登录闸门、事件绑定、快捷键、定时同步 */
(function () {
  'use strict';

  const { $, $$ } = U;
  let gateMode = 'login'; // login | setup
  let statusCache = null;

  /* ============================== 登录闸门 ============================== */
  function showGate(mode, status) {
    gateMode = mode;
    statusCache = status || statusCache;
    $('#app').hidden = true;
    $('#gate').hidden = false;
    const isSetup = mode === 'setup';
    $('#gate-setup-only').hidden = !isSetup;
    $('#gate-passcode-only').hidden = isSetup;
    $('#gate-title').textContent = isSetup ? '第一次使用：设置口令' : (statusCache && statusCache.title) || '作业云服务器';
    $('#gate-sub').textContent = isSetup
      ? '给你们的作业板设一个小组口令，之后所有同学共用它进入。'
      : '输入小组口令，开始记录每周作业';
    $('#gate-hint').textContent = isSetup
      ? '提示：口令至少 4 位，别忘了告诉同学。也可以让管理员在 Vercel 里配置 SITE_PASSCODE 环境变量。'
      : '第一次进来的同学，输入口令后填上自己的昵称即可。';

    const membersBox = $('#gate-members');
    const list = $('#gate-members-list');
    list.textContent = '';
    const members = (statusCache && statusCache.members) || [];
    if (!isSetup && members.length) {
      membersBox.hidden = false;
      members.forEach((member) => {
        list.appendChild(el2('button', {
          type: 'button',
          class: 'chip',
          text: member.nickname,
          onclick: () => {
            $('#gate-nick').value = member.nickname;
            list.querySelectorAll('.chip').forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
          },
        }));
      });
    } else {
      membersBox.hidden = true;
    }
  }

  function el2(tag, attrs) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach((key) => {
      if (key === 'text') node.textContent = attrs[key];
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
      else if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, String(attrs[key]));
    });
    return node;
  }

  function gateError(message) {
    const box = $('#gate-error');
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = message;
  }

  async function handleGateSubmit(event) {
    if (event && event.preventDefault) event.preventDefault();
    gateError('');
    const nickInput = $('#gate-nick');
    const newPassInput = $('#gate-newpass');
    const passInput = $('#gate-pass');
    const btn = $('#gate-submit');
    try {
      const nickname = nickInput ? nickInput.value.trim() : '';
      const effectivePass = gateMode === 'setup' && newPassInput ? newPassInput.value : (passInput ? passInput.value : '');
      if (!nickname) {
        gateError('请填写昵称，方便记录谁交了作业');
        return;
      }
      if (btn) {
        btn.disabled = true;
        btn.textContent = '正在进入…';
      }
      if (gateMode === 'setup') {
        await Api.setup(effectivePass || 'local', nickname);
        // 初始化成功后要更新缓存，否则一旦出错重试，界面又会退回「设置口令」
        statusCache = Object.assign({}, statusCache, {
          initialized: true,
          members: ((statusCache && statusCache.members) || []).concat([{ nickname }]),
        });
      } else {
        // 统一走 intro：口令永远要校验（选已有昵称也一样，避免空口令绕过）
        await Api.intro(effectivePass, nickname);
        if (statusCache) {
          const names = (statusCache.members || []).map((m) => m.nickname);
          if (!names.includes(nickname)) statusCache.members = (statusCache.members || []).concat([{ nickname }]);
        }
      }
      await start();
    } catch (err) {
      if (err && err.payload && err.payload.needSetup) {
        showGate('setup', statusCache);
        gateError('这个作业板还没有初始化，请先设置一个口令');
      } else {
        gateError((err && err.message) || '进入失败，请重试');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = gateMode === 'setup' ? '创建并进入' : '进入作业板';
      }
    }
  }

  /* ============================== 启动 ============================== */
  async function boot() {
    const status = await Api.probe();

    if (status.offline) {
      // file:// 或后端不可用：本地模式直接进入
      Api.saveSession('', Api.nickname || '我');
      if (!Api.nickname) {
        const name = window.prompt('后端不可用，已进入本地模式。请给自己起个昵称：', '我');
        Api.saveSession('', name || '我');
      }
      await start({ localMode: true });
      return;
    }

    statusCache = status;
    if (!status.initialized) {
      showGate('setup', status);
      return;
    }
    if (Api.token) {
      try {
        await Store.init();
        await start();
        return;
      } catch (err) {
        if (err.status !== 401) {
          U.toast(err.message, 'err');
        }
      }
    }
    showGate('login', status);
  }

  async function start(options) {
    $('#gate').hidden = true;
    $('#app').hidden = false;

    Store.nickname = Api.nickname || '我';
    Store.onChange(onStoreChange);

    try {
      await Store.init();
    } catch (err) {
      if (err.status === 401) {
        showGate('login', statusCache);
        U.toast('登录已失效，请重新输入口令', 'warn');
        return;
      }
      U.toast(`读取数据失败：${err.message}`, 'err', 4000);
    }

    bindEvents();
    UI.setView('grid');
    UI.renderAll();
    Store.startPolling(20000);

    if (options && options.localMode) {
      showBanner('当前是本地模式：后端没有连上，所有内容只保存在这台设备的浏览器里。部署到 Vercel 后即可多人共享。');
    } else if (Store.mode === 'local') {
      showBanner('后端暂时不可用，已切换到本地模式（数据只保存在这台设备）。恢复网络后点右上角 ⟳ 重新同步。');
    } else if (statusCache && statusCache.storage === 'file') {
      showBanner('当前数据库是本地文件（开发模式）。部署到 Vercel 并在环境变量里配置 DATABASE_URL 或 Upstash Redis 之后，就能多人实时共享。');
    }

    if (!Store.doc.courses.length) {
      setTimeout(() => {
        U.toast('先点右上角「🗓 课表」把课程录进来，之后每周的作业就按课程归类啦', 'ok', 5200);
      }, 600);
    }
  }

  function showBanner(html) {
    const box = $('#banner');
    box.innerHTML = html;
    box.hidden = false;
  }

  function onStoreChange(event) {
    if (event.type === 'saving') UI.setSyncState('保存中…', 'saving');
    else if (event.type === 'saved') {
      UI.setSyncState(Store.mode === 'local' ? '本地已保存' : '已同步到云端', 'saved');
      UI.renderSidebar();
    } else if (event.type === 'error') UI.setSyncState(`保存失败：${Store.error}`, 'error');
    else if (event.type === 'remote' || event.type === 'merged') {
      UI.renderAll();
      U.toast(event.type === 'merged' ? '已合并其他人的修改' : '已同步到最新内容', 'ok', 1800);
    } else if (event.type === 'init') {
      /* noop */
    } else {
      UI.renderHeader();
    }
  }

  /* ============================== 事件绑定 ============================== */
  let bound = false;
  let gateBound = false;

  /**
   * 登录表单必须【立刻】绑定 submit 事件。
   * 之前是放在 bindEvents() 里的，而 bindEvents() 要等登录成功后才执行 ——
   * 结果：第一次进站时点「进入作业板」，表单被浏览器按原生方式提交
   * （地址栏出现 ?passcode=...&nickname=...），页面刷新，表现为「设置完口令又回到开头」。
   */
  function bindGateEvents() {
    if (gateBound) return;
    gateBound = true;
    const form = $('#gate-form');
    if (!form) return;
    // 去掉 HTML 上的兜底 onsubmit="return false"，改由脚本接管
    form.removeAttribute('onsubmit');
    form.addEventListener('submit', handleGateSubmit);
  }

  function bindEvents() {
    bindGateEvents();
    if (bound) return;
    bound = true;

    document.addEventListener('click', async (event) => {
      const target = event.target.closest('[data-action]');
      if (target) {
        const action = target.dataset.action;
        const id = target.dataset.id;

        if (action === 'toggle-done') {
          Store.toggleDone(id);
          event.stopPropagation();
          UI.renderAll();
          return;
        }
        if (action === 'zoom') {
          event.stopPropagation();
          if (event.target.closest('#modal')) return; // 编辑器里的缩略图不弹大图
          Modals.zoomImage(target.dataset.src || target.getAttribute('src'));
          return;
        }
        if (action === 'edit-hw') {
          if (event.target.closest('.hw-actions') || event.target.closest('.hw-check')) return;
          const item = Store.doc.assignments.find((a) => a.id === id);
          if (item) Modals.openAssignmentEditor(item);
          return;
        }
        if (action === 'dup-hw') {
          const item = Store.doc.assignments.find((a) => a.id === id);
          if (item) {
            const copy = Object.assign({}, item);
            delete copy.id;
            Store.addAssignment(Object.assign(copy, { title: `${item.title}（副本）` }));
            UI.renderAll();
            U.toast('已复制一条', 'ok', 1500);
          }
          return;
        }
        if (action === 'del-hw') {
          const item = Store.doc.assignments.find((a) => a.id === id);
          if (!item) return;
          event.stopPropagation();
          if (await Modals.confirmDialog(`确定删除「${item.title}」吗？`, { danger: true, okLabel: '删除' })) {
            Store.removeAssignment(id);
            UI.renderAll();
            U.toast('已删除', 'ok', 1500);
          }
          return;
        }
        if (action === 'add-hw-week') {
          Modals.openAssignmentEditor(null, { week: Number(target.dataset.week) });
          return;
        }
        if (action === 'add-major') {
          Modals.openAssignmentEditor(null, { type: 'major' });
          return;
        }
        if (action === 'edit-schedule') {
          Modals.openScheduleEditor();
          return;
        }
        if (action === 'filter-course') {
          const value = id === '__none__' ? '__none__' : id;
          UI.ui.courseId = UI.ui.courseId === value ? '' : value;
          UI.renderAll();
          return;
        }
      }

      const stateChip = event.target.closest('#state-filter .chip');
      if (stateChip) {
        UI.ui.state = stateChip.dataset.state;
        UI.renderAll();
        return;
      }

      const seg = event.target.closest('.seg');
      if (seg) {
        UI.setView(seg.dataset.view);
        return;
      }

      if (event.target.closest('#sidebar') === null && event.target.closest('#btn-menu')) {
        $('#sidebar').classList.toggle('open');
        return;
      }
      if (event.target.closest('.main') && $('#sidebar').classList.contains('open')) {
        $('#sidebar').classList.remove('open');
      }
    });

    $('#btn-add').addEventListener('click', () => Modals.openAssignmentEditor(null, { week: UI.ui.currentWeek }));
    $('#btn-major').addEventListener('click', () => Modals.openAssignmentEditor(null, { type: 'major', week: UI.ui.currentWeek }));
    $('#btn-schedule').addEventListener('click', () => Modals.openScheduleEditor());
    $('#btn-settings').addEventListener('click', () => Modals.openSettings());
    $('#btn-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

    $('#btn-sync').addEventListener('click', async () => {
      UI.setSyncState('同步中…', 'saving');
      const changed = await Store.pullRemote();
      if (Store.dirty) await Store.pushSave(true);
      UI.renderAll();
      UI.setSyncState(changed ? '已拉取最新内容' : '已是最新', 'saved');
    });

    $('#btn-undo').addEventListener('click', () => { if (Store.undo()) UI.renderAll(); });
    $('#btn-redo').addEventListener('click', () => { if (Store.redo()) UI.renderAll(); });

    $('#search').addEventListener('input', U.debounce((event) => {
      UI.ui.search = event.target.value.trim();
      $('#search-clear').hidden = !UI.ui.search;
      UI.renderAll();
    }, 180));
    $('#search-clear').addEventListener('click', () => {
      $('#search').value = '';
      UI.ui.search = '';
      $('#search-clear').hidden = true;
      UI.renderAll();
    });

    $('#btn-clear-filter').addEventListener('click', () => {
      UI.ui.courseId = '';
      UI.ui.state = 'all';
      UI.renderAll();
    });

    $('#btn-export').addEventListener('click', () => {
      const blob = new Blob([Store.exportJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `作业板备份_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      U.toast('备份已导出', 'ok');
    });

    $('#btn-import').addEventListener('click', () => $('#file-import').click());
    $('#file-import').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      const text = await file.text();
      const replace = await Modals.confirmDialog('合并导入（保留现有内容）点「合并」，清空后只用备份内容点「覆盖」。', {
        title: '导入备份',
        okLabel: '覆盖',
        cancelLabel: '合并',
      });
      try {
        await Store.importJson(text, replace ? 'replace' : 'merge');
        UI.renderAll();
        U.toast('导入完成', 'ok');
      } catch (err) {
        U.toast(`导入失败：${err.message}`, 'err');
      }
    });

    $('#modal-close').addEventListener('click', () => Modals.closeModal());
    $('#modal').addEventListener('click', (event) => {
      if (event.target.dataset.close) Modals.closeModal();
    });
    $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; $('#lightbox-img').src = ''; });

    document.addEventListener('keydown', (event) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if (event.key === 'Escape') {
        if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
        if (!$('#modal').hidden) { Modals.closeModal(); return; }
      }
      if (typing) return;
      if (event.key === 'n' || event.key === 'N') { event.preventDefault(); Modals.openAssignmentEditor(null, { week: UI.ui.currentWeek }); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); if (Store.undo()) UI.renderAll(); }
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) { event.preventDefault(); if (Store.redo()) UI.renderAll(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        Store.dirty = true;
        Store.pushSave(true).then(() => U.toast('已保存', 'ok', 1200));
      }
      if (event.key === '/') { event.preventDefault(); $('#search').focus(); }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Store.mode !== 'local') {
        Store.pullRemote().then((changed) => { if (changed) UI.renderAll(); });
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (Store.dirty && Store.mode !== 'local') {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindGateEvents(); // 先绑定登录表单，再走后面的初始化流程
    boot().catch((err) => {
      console.error(err);
      showGate('login', null);
      gateError(`初始化失败：${err.message}`);
    });
  });
}());
