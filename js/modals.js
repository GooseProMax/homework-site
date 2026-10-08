/* global window, document, Store, Api, UI, U */
/* 弹窗：作业编辑、课表编辑、设置、确认框、图片查看 */
(function () {
  'use strict';

  const { el, $ } = U;
  const WEEKDAY_OPTIONS = U.WEEKDAYS.map((name, index) => ({ value: String(index + 1), label: name }));

  let onCloseHook = null;

  function openModal(options) {
    const modal = $('#modal');
    $('#modal-title').textContent = options.title || '';
    const body = $('#modal-body');
    body.textContent = '';
    if (options.node) body.appendChild(options.node);
    const foot = $('#modal-foot');
    foot.textContent = '';
    (options.buttons || []).forEach((btn) => {
      foot.appendChild(el('button', {
        class: `btn ${btn.kind || ''}`,
        text: btn.label,
        dataset: { action: 'modal-btn', key: btn.key },
        onclick: btn.onClick,
      }));
    });
    const card = modal.querySelector('.modal-card');
    card.className = `modal-card${options.wide ? ' wide' : ''}`;
    modal.hidden = false;
    onCloseHook = options.onClose || null;
    const first = body.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 30);
    return { body, foot };
  }

  function closeModal() {
    const modal = $('#modal');
    modal.hidden = true;
    $('#modal-body').textContent = '';
    $('#modal-foot').textContent = '';
    const hook = onCloseHook;
    onCloseHook = null;
    if (hook) hook();
  }

  function selectField(label, options, value) {
    const node = el('select');
    options.forEach((opt) => {
      const option = el('option', { value: opt.value, text: opt.label });
      if (String(opt.value) === String(value)) option.selected = true;
      node.appendChild(option);
    });
    return el('label', { class: 'field' }, [el('span', { text: label }), node]);
  }

  function inputField(label, attrs) {
    const input = el('input', attrs || {});
    return { wrap: el('label', { class: 'field' }, [el('span', { text: label }), input]), input };
  }

  function confirmDialog(message, options) {
    const opts = options || {};
    return new Promise((resolve) => {
      openModal({
        title: opts.title || '确认一下',
        node: el('p', { style: 'margin:0;line-height:1.7;white-space:pre-wrap', text: message }),
        buttons: [
          { label: opts.cancelLabel || '取消', key: 'cancel', onClick: () => { closeModal(); resolve(false); } },
          { label: opts.okLabel || '确定', kind: opts.danger ? 'btn-danger' : 'btn-primary', key: 'ok', onClick: () => { closeModal(); resolve(true); } },
        ],
        onClose: () => resolve(false),
      });
    });
  }

  /* ----------------------------- 图片选择器 ----------------------------- */
  function imagePicker(initial) {
    const images = (initial || []).slice();
    const previews = el('div', { class: 'img-previews' });
    const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const drop = el('div', { class: 'img-drop' }, ['点击选择图片，或直接 Ctrl+V 粘贴截图（自动压缩）']);

    function render() {
      previews.textContent = '';
      images.forEach((src, index) => {
        const item = el('div', { class: 'img-preview' }, [
          el('img', { src, alt: `图片 ${index + 1}`, dataset: { action: 'zoom', src } }),
          el('button', {
            type: 'button',
            title: '移除',
            text: '×',
            onclick: () => { images.splice(index, 1); render(); },
          }),
        ]);
        previews.appendChild(item);
      });
    }

    async function addFiles(files) {
      for (const file of Array.from(files || [])) {
        if (!/^image\//.test(file.type)) continue;
        try {
          const { dataUrl } = await U.compressImage(file, 1600);
          images.push(dataUrl);
        } catch (err) {
          U.toast(`图片处理失败：${err.message}`, 'err');
        }
      }
      render();
    }

    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
    drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.style.borderColor = '#4361ee'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.style.borderColor = '';
      addFiles(event.dataTransfer.files);
    });

    const wrap = el('div', { class: 'img-input' }, [drop, previews, fileInput]);
    render();

    return {
      node: wrap,
      get images() { return images.slice(); },
      pasteHandler(event) {
        const items = (event.clipboardData && event.clipboardData.items) || [];
        const files = [];
        for (const item of items) {
          if (item.type && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length) {
          event.preventDefault();
          addFiles(files);
          return true;
        }
        return false;
      },
    };
  }

  /* ----------------------------- 作业编辑器 ----------------------------- */
  function openAssignmentEditor(existing, preset) {
    const pre = preset || {};
    const isNew = !existing;
    const total = Number(Store.doc.settings.weeks) || 16;

    const courseOptions = [{ value: '', label: '（未归类）' }]
      .concat(Store.doc.courses.map((c) => ({ value: c.id, label: c.name })));
    const weekOptions = [];
    for (let week = 1; week <= total; week += 1) {
      weekOptions.push({ value: String(week), label: `第 ${week} 周` });
    }
    if (existing && Number(existing.week) > total) weekOptions.push({ value: String(existing.week), label: `第 ${existing.week} 周` });

    const base = existing || {};
    const courseSelect = selectField('课程', courseOptions, base.courseId || pre.courseId || '');
    const weekSelect = selectField('周次', weekOptions, base.week || pre.week || UI.ui.currentWeek);
    const typeSelect = selectField('类型', [
      { value: 'homework', label: '普通作业' },
      { value: 'major', label: '大作业（特殊颜色）' },
      { value: 'exam', label: '考试 / 测验' },
    ], base.type || pre.type || 'homework');
    const titleInput = inputField('作业标题', { type: 'text', maxlength: 120, value: base.title || '', placeholder: '例如：第 3 章课后习题 1-10' });
    const detailArea = el('textarea', { placeholder: '详细要求、老师原话、注意事项…', maxlength: 4000 });
    detailArea.value = base.detail || '';
    const deadlineInput = inputField('截止时间', { type: 'datetime-local', value: U.toLocalInputValue(base.deadline) });
    const linksArea = el('textarea', { placeholder: '相关链接，一行一个（可选）', maxlength: 2000, style: 'min-height:60px' });
    linksArea.value = (base.links || []).join('\n');

    const picker = imagePicker(base.images);

    const form = el('div', { class: 'form-grid' }, [
      el('div', { class: 'span2' }, [titleInput.wrap]),
      courseSelect,
      weekSelect,
      typeSelect,
      deadlineInput.wrap,
      el('div', { class: 'span2' }, [el('label', { class: 'field' }, [el('span', { text: '详细说明' }), detailArea])]),
      el('div', { class: 'span2' }, [el('label', { class: 'field' }, [el('span', { text: '图片（截图 / 照片）' }), picker.node])]),
      el('div', { class: 'span2' }, [el('label', { class: 'field' }, [el('span', { text: '相关链接' }), linksArea])]),
    ]);

    function collect() {
      const title = titleInput.input.value.trim();
      if (!title) {
        U.toast('请填写作业标题', 'warn');
        titleInput.input.focus();
        return null;
      }
      return {
        title,
        courseId: courseSelect.querySelector('select').value || null,
        week: Number(weekSelect.querySelector('select').value) || 1,
        type: typeSelect.querySelector('select').value,
        detail: detailArea.value.trim(),
        deadline: U.fromLocalInputValue(deadlineInput.input.value),
        links: linksArea.value.split('\n').map((line) => line.trim()).filter(Boolean),
        images: picker.images,
      };
    }

    const onDocPaste = (event) => {
      if (event.target && /INPUT|TEXTAREA/.test(event.target.tagName) && event.target.type !== 'text') return;
      picker.pasteHandler(event);
    };

    const buttons = [
      { label: '取消', key: 'cancel', onClick: () => closeModal() },
    ];
    if (!isNew) {
      buttons.push({
        label: '删除',
        key: 'del',
        kind: 'btn-danger',
        onClick: async () => {
          if (await confirmDialog(`确定删除「${base.title}」吗？`, { danger: true, okLabel: '删除' })) {
            Store.removeAssignment(base.id);
            closeModal();
            afterChange('已删除');
          }
        },
      });
    }
    buttons.push({
      label: isNew ? '添加' : '保存',
      key: 'save',
      kind: 'btn-primary',
      onClick: () => {
        const data = collect();
        if (!data) return;
        if (isNew) Store.addAssignment(data);
        else Store.updateAssignment(base.id, data);
        closeModal();
        afterChange(isNew ? '已添加' : '已保存');
      },
    });

    openModal({
      title: isNew ? '新增作业' : '编辑作业',
      node: form,
      buttons,
      onClose: () => document.removeEventListener('paste', onDocPaste),
    });
    document.addEventListener('paste', onDocPaste);
  }

  function afterChange(message) {
    if (message) U.toast(message, 'ok', 1600);
    UI.renderAll();
  }

  /* ----------------------------- 课表编辑器 ----------------------------- */
  function openScheduleEditor() {
    const draft = Store.doc.courses.map((c) => Object.assign({}, c));
    const rows = el('div', { class: 'timetable-editor' });

    function rowNode(course, index) {
      const nameInput = el('input', { type: 'text', placeholder: '课程名', value: course.name || '' });
      const teacherInput = el('input', { type: 'text', placeholder: '老师', value: course.teacher || '' });
      const locationInput = el('input', { type: 'text', placeholder: '教室', value: course.location || '' });
      const daySelect = el('select');
      daySelect.appendChild(el('option', { value: '', text: '星期?' }));
      WEEKDAY_OPTIONS.forEach((opt) => {
        const option = el('option', { value: opt.value, text: opt.label });
        if (course.day && String(course.day) === opt.value) option.selected = true;
        daySelect.appendChild(option);
      });
      const slotInput = el('input', { type: 'text', placeholder: '如 1-2 节', value: course.slot || '' });
      const colorInput = el('input', { type: 'color', value: course.color || U.pickColor(index) });

      // 把输入框引用挂在草稿对象上，保存时统一读取（避免依赖 DOM 顺序）
      course._fields = { nameInput, teacherInput, locationInput, daySelect, slotInput, colorInput };

      return el('div', { class: 'tt-row' }, [
        nameInput,
        teacherInput,
        locationInput,
        daySelect,
        slotInput,
        colorInput,
        el('button', {
          class: 'icon-btn', title: '删除这门课', text: '🗑',
          onclick: () => {
            const position = draft.indexOf(course);
            if (position >= 0) draft.splice(position, 1);
            renderRows();
          },
        }),
      ]);
    }

    function renderRows() {
      rows.textContent = '';
      draft.forEach((course, index) => rows.appendChild(rowNode(course, index)));
      if (!draft.length) rows.appendChild(el('p', { class: 'hint', text: '还没有课程，点下面的「＋ 添加课程」开始。' }));
    }
    renderRows();

    const body = el('div', {}, [
      el('p', { class: 'hint', style: 'margin:0 0 10px', text: '「星期 + 第几节」填了就能在上面排出课程表网格；不填也行，只影响展示方式。' }),
      el('div', { class: 'tt-row', style: 'font-size:12px;color:#7c88a6' }, [
        el('span', { text: '课程名' }), el('span', { text: '老师' }), el('span', { text: '教室' }),
        el('span', { text: '星期' }), el('span', { text: '节次' }), el('span', { text: '颜色' }), el('span'),
      ]),
      rows,
      el('button', { class: 'btn btn-sm', text: '＋ 添加课程', onclick: () => { draft.push({ id: U.uid('course'), name: '', color: U.pickColor(draft.length) }); renderRows(); } }),
    ]);

    openModal({
      title: '编辑课表',
      wide: true,
      node: body,
      buttons: [
        { label: '取消', key: 'cancel', onClick: () => closeModal() },
        {
          label: '保存课表',
          key: 'save',
          kind: 'btn-primary',
          onClick: () => {
            const cleaned = draft
              .filter((course) => course._fields)
              .map((course) => {
                const fields = course._fields;
                return {
                  id: course.id || U.uid('course'),
                  name: fields.nameInput.value.trim(),
                  teacher: fields.teacherInput.value.trim(),
                  location: fields.locationInput.value.trim(),
                  day: fields.daySelect.value ? Number(fields.daySelect.value) : null,
                  slot: fields.slotInput.value.trim(),
                  color: fields.colorInput.value || U.pickColor(0),
                };
              })
              .filter((course) => course.name);
            const removedIds = Store.doc.courses.map((c) => c.id).filter((id) => !cleaned.some((c) => c.id === id));
            const willDelete = Store.doc.assignments.filter((a) => removedIds.includes(a.courseId));
            const apply = () => {
              Store.snapshot();
              Store.doc.courses = cleaned.map((course) => Object.assign({}, course, { updatedAt: new Date().toISOString() }));
              if (willDelete.length) {
                const ids = willDelete.map((a) => a.id);
                Store.doc.assignments = Store.doc.assignments.filter((a) => !ids.includes(a.id));
              }
              Store.touch();
              closeModal();
              afterChange('课表已保存');
            };
            if (willDelete.length) {
              confirmDialog(`有 ${willDelete.length} 条作业属于被删除的课程，会一起删掉哦。继续吗？`, { danger: true, okLabel: '一起删除' }).then((ok) => { if (ok) apply(); });
            } else {
              apply();
            }
          },
        },
      ],
    });
  }

  /* ----------------------------- 设置 ----------------------------- */
  function openSettings() {
    const settings = Store.doc.settings || {};
    const titleInput = inputField('作业板标题', { type: 'text', value: settings.title || '' });
    const semesterInput = inputField('学期名称', { type: 'text', value: settings.semester || '', placeholder: '例如：2025 秋季学期' });
    const startInput = inputField('第 1 周周一日期', { type: 'date', value: settings.semesterStart ? String(settings.semesterStart).slice(0, 10) : '' });
    const weeksSelect = selectField('学期周数', [16, 17, 18, 19, 20].map((n) => ({ value: String(n), label: `${n} 周` })), String(settings.weeks || 16));

    const currentPass = inputField('当前口令', { type: 'password', placeholder: '验证身份' });
    const newPass = inputField('新口令', { type: 'password', placeholder: '至少 4 位' });

    const healthBox = el('div', { class: 'kv' }, [el('div', { class: 'kv-row' }, [el('b', { text: '状态' }), el('span', { text: '点击「自检」查看' })])]);

    const body = el('div', {}, [
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'span2' }, [titleInput.wrap]),
        semesterInput.wrap,
        weeksSelect,
        startInput.wrap,
        el('div'),
      ]),
      el('button', {
        class: 'btn btn-primary', text: '保存基本设置',
        onclick: () => {
          Store.updateSettings({
            title: titleInput.input.value.trim() || '本学期作业板',
            semester: semesterInput.input.value.trim(),
            weeks: Number(weeksSelect.querySelector('select').value) || 16,
            semesterStart: startInput.input.value || '',
          });
          U.toast('设置已保存', 'ok');
          UI.renderAll();
        },
      }),
      el('hr', { style: 'border:none;border-top:1px solid #e2e7f2;margin:4px 0' }),
      el('h3', { style: 'margin:0;font-size:14px', text: '修改访问口令' }),
      el('div', { class: 'form-grid' }, [currentPass.wrap, newPass.wrap]),
      el('button', {
        class: 'btn', text: '修改口令',
        onclick: async () => {
          if (Api.offline) { U.toast('本地模式下没有口令', 'warn'); return; }
          try {
            await Api.changePasscode(currentPass.input.value, newPass.input.value);
            U.toast('口令已更新', 'ok');
            currentPass.input.value = '';
            newPass.input.value = '';
          } catch (err) {
            U.toast(err.message, 'err');
          }
        },
      }),
      el('hr', { style: 'border:none;border-top:1px solid #e2e7f2;margin:4px 0' }),
      el('h3', { style: 'margin:0;font-size:14px', text: '数据与同步' }),
      el('div', { class: 'row-btns' }, [
        el('button', {
          class: 'btn btn-sm', text: '立即上传到云端',
          onclick: async () => {
            Store.dirty = true;
            await Store.pushSave(true);
            U.toast('已同步', 'ok');
          },
        }),
        el('button', {
          class: 'btn btn-sm', text: '从云端拉取',
          onclick: async () => {
            const changed = await Store.pullRemote();
            UI.renderAll();
            U.toast(changed ? '已拉取最新数据' : '已是最新', 'ok');
          },
        }),
        el('button', {
          class: 'btn btn-sm', text: '导出备份',
          onclick: () => { document.getElementById('btn-export').click(); },
        }),
        el('button', {
          class: 'btn btn-sm', text: '退出登录',
          onclick: async () => {
            if (!(await confirmDialog('退出后需要重新输入口令才能进入。', { okLabel: '退出' }))) return;
            Api.logout();
            location.reload();
          },
        }),
      ]),
      healthBox,
      el('button', {
        class: 'btn btn-sm', text: '自检（数据库 / 密钥）',
        onclick: async () => {
          healthBox.textContent = '';
          healthBox.appendChild(el('div', { class: 'kv-row' }, [el('b', { text: '结果' }), el('span', { text: '检查中…' })]));
          try {
            const report = await Api.health();
            healthBox.textContent = '';
            const rows = [
              ['服务', report.ok ? '✅ 正常' : '❌ 异常'],
              ['存储后端', (report.storage && report.storage.store) || '未知'],
              ['数据版本', String(report.revision)],
              ['APP_SECRET', report.appSecretConfigured ? '已配置' : '未配置（建议配置）'],
              ['SITE_PASSCODE', report.sitePasscodeConfigured ? '已配置' : '未配置（口令存在数据库里）'],
            ];
            if (report.error) rows.push(['错误', report.error]);
            if (report.hint) rows.push(['提示', report.hint]);
            rows.forEach(([key, value]) => healthBox.appendChild(el('div', { class: 'kv-row' }, [el('b', { text: key }), el('span', { text: value })])));
          } catch (err) {
            healthBox.textContent = '';
            healthBox.appendChild(el('div', { class: 'kv-row' }, [el('b', { text: '错误' }), el('span', { text: err.message })]));
          }
        },
      }),
      el('p', { class: 'hint', text: `当前身份：${Store.nickname}｜数据模式：${Store.mode === 'local' ? '仅本地浏览器' : '云端共享'}` }),
    ]);

    openModal({
      title: '设置',
      node: body,
      buttons: [{ label: '关闭', key: 'close', kind: 'btn-primary', onClick: () => closeModal() }],
    });
  }

  /* ----------------------------- 图片查看 ----------------------------- */
  function zoomImage(src) {
    const box = $('#lightbox');
    $('#lightbox-img').src = src;
    box.hidden = false;
  }

  window.Modals = { openModal, closeModal, confirmDialog, openAssignmentEditor, openScheduleEditor, openSettings, zoomImage };
}());
