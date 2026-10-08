/* global window, document, Store, U */
/* 界面渲染：16 周总览 / 清单 / 课程表 / 大作业 / 侧栏 */
(function () {
  'use strict';

  const { el, $ } = U;

  const ui = {
    view: 'grid',
    search: '',
    courseId: '',
    state: 'all',
    currentWeek: 1,
  };

  /* ----------------------------- 过滤与查询 ----------------------------- */
  function courseOf(item) {
    return Store.courseById(item.courseId);
  }

  function courseName(item) {
    const course = courseOf(item);
    return course ? course.name : '未归类';
  }

  function courseColor(item) {
    const course = courseOf(item);
    return (course && course.color) || '#94a3b8';
  }

  function matchesFilter(item) {
    if (ui.courseId === '__none__') {
      if (item.courseId) return false;
    } else if (ui.courseId && item.courseId !== ui.courseId) {
      return false;
    }
    const doneByMe = Store.isDoneByMe(item);
    if (ui.state === 'todo' && doneByMe) return false;
    if (ui.state === 'done' && !doneByMe) return false;
    if (ui.state === 'urgent') {
      if (!item.deadline || doneByMe) return false;
      const due = U.toDateOnly(item.deadline);
      if (!due) return false;
      const days = (due.getTime() - Date.now()) / 86400000;
      if (days < 0 || days > 3) return false;
    }
    if (ui.search) {
      const haystack = [
        item.title, item.detail, courseName(item),
        (item.links || []).join(' '),
        (item.doneBy || []).join(' '),
        item.week ? `第${item.week}周` : '',
      ].join(' ').toLowerCase();
      if (!haystack.includes(ui.search.toLowerCase())) return false;
    }
    return true;
  }

  function filteredAssignments() {
    return Store.doc.assignments.filter(matchesFilter);
  }

  function weekAssignments(week) {
    return filteredAssignments()
      .filter((a) => Number(a.week) === Number(week) && a.type !== 'major')
      .sort(sortAssignments);
  }

  function majorAssignments() {
    return filteredAssignments().filter((a) => a.type === 'major').sort(sortAssignments);
  }

  function sortAssignments(a, b) {
    const colorA = courseColor(a);
    const colorB = courseColor(b);
    if (colorA !== colorB) return colorA < colorB ? -1 : 1;
    const da = a.deadline ? Date.parse(a.deadline) : Infinity;
    const db = b.deadline ? Date.parse(b.deadline) : Infinity;
    if (da !== db) return da - db;
    return String(a.title).localeCompare(String(b.title), 'zh');
  }

  /* ----------------------------- 周次日期 ----------------------------- */
  function weekRange(week) {
    const settings = Store.doc.settings || {};
    let start = U.toDateOnly(settings.semesterStart);
    if (!start) {
      const now = new Date();
      const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
      start = new Date(year, 8, 1);
    }
    const day = start.getDay() || 7;
    const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - (day - 1) + (Number(week) - 1) * 7);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return {
      monday,
      sunday,
      text: `${monday.getMonth() + 1}/${monday.getDate()} - ${sunday.getMonth() + 1}/${sunday.getDate()}`,
    };
  }

  function detectCurrentWeek() {
    const total = Number(Store.doc.settings.weeks) || 16;
    const guess = U.guessCurrentWeek(Store.doc.settings.semesterStart);
    ui.currentWeek = Math.min(total, Math.max(1, guess.week));
    return ui.currentWeek;
  }

  /* ----------------------------- 作业条目 ----------------------------- */
  function assignmentNode(item, options) {
    const opts = options || {};
    const doneMe = Store.isDoneByMe(item);
    const due = item.deadline ? U.relativeDue(item.deadline) : null;
    const color = courseColor(item);
    const course = courseOf(item);

    const meta = [];
    if (course) meta.push(el('span', { text: course.name }));
    else meta.push(el('span', { class: 'pill', text: '未归类' }));
    if (item.type === 'major') meta.push(el('span', { class: 'pill major', text: '大作业' }));
    if (item.type === 'exam') meta.push(el('span', { class: 'pill major', text: '考试' }));
    if (item.deadline) {
      meta.push(el('span', {
        class: `pill ${due ? due.kind : ''}`,
        text: `${U.formatDateTime(item.deadline)} · ${due ? due.text : ''}`,
      }));
    }
    (item.doneBy || []).forEach((who) => {
      meta.push(el('span', { class: 'pill', text: `✓ ${who}` }));
    });

    const thumbs = (item.images || []).slice(0, 4).map((src, index) => el('img', {
      src,
      alt: `${item.title} 图 ${index + 1}`,
      loading: 'lazy',
      dataset: { action: 'zoom', src },
    }));

    const body = el('div', { class: 'hw-main' }, [
      el('div', { class: 'hw-title', text: item.title }),
      meta.length ? el('div', { class: 'hw-meta' }, meta) : null,
      item.detail ? el('div', { class: 'hw-desc', text: item.detail }) : null,
      (item.links || []).length
        ? el('div', { class: 'hw-meta' }, item.links.map((link, index) => el('a', {
            href: link, target: '_blank', rel: 'noopener noreferrer', text: `链接 ${index + 1} ↗`,
          })))
        : null,
      thumbs.length ? el('div', { class: 'hw-thumbs' }, thumbs) : null,
    ]);

    const actions = el('div', { class: 'hw-actions' }, [
      el('button', { class: 'icon-btn', title: '编辑', dataset: { action: 'edit-hw', id: item.id }, text: '✎' }),
      el('button', { class: 'icon-btn', title: '复制一条', dataset: { action: 'dup-hw', id: item.id }, text: '⧉' }),
      el('button', { class: 'icon-btn', title: '删除', dataset: { action: 'del-hw', id: item.id }, text: '🗑' }),
    ]);

    const checkbox = el('input', {
      type: 'checkbox',
      class: 'hw-check',
      title: doneMe ? '取消我的完成标记' : '标记我已完成',
      dataset: { action: 'toggle-done', id: item.id },
    });
    checkbox.checked = doneMe;

    return el('div', {
      class: `hw type-${item.type}${doneMe ? ' done' : ''}`,
      style: `border-left-color:${color}`,
      dataset: { action: 'edit-hw', id: item.id },
      title: opts.compact ? `${item.title}｜点击查看/编辑` : '点击查看/编辑',
    }, [checkbox, body, actions]);
  }

  function weekProgress(items) {
    if (!items.length) return null;
    const done = items.filter((a) => Store.isDoneByMe(a)).length;
    return { done, total: items.length, percent: Math.round((done / items.length) * 100) };
  }

  function progressBar(percent, cls) {
    return el('div', { class: cls || 'mini-progress' }, [
      el('i', { style: `width:${percent}%` }),
    ]);
  }

  /* ----------------------------- 16 周总览 ----------------------------- */
  function weekCard(week) {
    const items = weekAssignments(week);
    const total = Number(Store.doc.settings.weeks) || 16;
    const range = weekRange(week);
    const isCurrent = week === ui.currentWeek;
    const progress = weekProgress(items);

    const groups = new Map();
    items.forEach((item) => {
      const key = item.courseId || '__none__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    const body = el('div', { class: 'week-body' });
    if (!items.length) {
      body.appendChild(el('div', { class: 'week-empty', text: ui.search || ui.courseId || ui.state !== 'all' ? '没有符合条件的作业' : '这一周还没有作业，点「＋ 新增作业」添加' }));
    } else {
      if (progress) {
        body.appendChild(progressBar(progress.percent));
      }
      Array.from(groups.entries()).forEach(([key, groupItems]) => {
        const course = key === '__none__' ? null : Store.courseById(key);
        const groupDone = groupItems.filter((a) => Store.isDoneByMe(a)).length;
        body.appendChild(el('div', { class: 'course-group' }, [
          el('div', { class: 'course-group-head' }, [
            el('span', { class: 'dot', style: `background:${(course && course.color) || '#94a3b8'}` }),
            el('span', { text: course ? course.name : '未归类' }),
            el('span', { class: 'tiny', text: `${groupDone}/${groupItems.length}` }),
          ]),
          ...groupItems.map((item) => assignmentNode(item, { compact: true })),
        ]));
      });
    }

    return el('section', { class: `week-card${isCurrent ? ' is-current' : ''}` }, [
      el('header', { class: 'week-head' }, [
        el('span', { class: 'wnum' }, [`第 ${week} 周`, el('small', { text: range.text })]),
        isCurrent ? el('span', { class: 'badge-now', text: '本周' }) : null,
        el('span', {
          class: 'wmeta',
          text: progress ? `${progress.done}/${progress.total} 完成` : `${total} 周`,
        }),
        el('button', {
          class: 'icon-btn',
          title: `在第 ${week} 周新增作业`,
          dataset: { action: 'add-hw-week', week },
          text: '＋',
        }),
      ]),
      body,
    ]);
  }

  function renderGrid() {
    const container = $('#weeks');
    if (!container) return;
    const total = Number(Store.doc.settings.weeks) || 16;
    const fragment = document.createDocumentFragment();

    const majors = majorAssignments();
    if (majors.length) {
      fragment.appendChild(majorSection(majors, '大作业与考试'));
    }

    for (let week = 1; week <= total; week += 1) fragment.appendChild(weekCard(week));
    container.textContent = '';
    container.appendChild(fragment);
  }

  function majorSection(items, title) {
    const done = items.filter((a) => Store.isDoneByMe(a)).length;
    const wrapper = el('section', { class: 'week-card', style: 'grid-column:1/-1;border-color:#f3d9a8' });
    wrapper.appendChild(el('header', { class: 'week-head', style: 'background:#fff8ec' }, [
      el('span', { class: 'wnum' }, ['★ ', title]),
      el('span', { class: 'wmeta', text: `${done}/${items.length} 完成` }),
      el('button', { class: 'icon-btn', title: '新增大作业', dataset: { action: 'add-major' }, text: '＋' }),
    ]));
    const body = el('div', { class: 'week-body', style: 'grid-template-columns:repeat(auto-fill,minmax(280px,1fr));display:grid' });
    items.forEach((item) => body.appendChild(assignmentNode(item)));
    wrapper.appendChild(body);
    return wrapper;
  }

  /* ----------------------------- 清单模式 ----------------------------- */
  function renderList() {
    const container = $('#list-body');
    if (!container) return;
    const total = Number(Store.doc.settings.weeks) || 16;
    container.textContent = '';

    const all = filteredAssignments().slice().sort(sortAssignments);
    if (!all.length) {
      container.appendChild(el('div', { class: 'major-empty', text: '没有符合条件的作业' }));
      return;
    }

    const byWeek = new Map();
    all.filter((a) => a.type !== 'major').forEach((item) => {
      const week = Number(item.week) || 1;
      if (!byWeek.has(week)) byWeek.set(week, []);
      byWeek.get(week).push(item);
    });

    Array.from(byWeek.keys()).sort((a, b) => a - b).forEach((week) => {
      const items = byWeek.get(week);
      const progress = weekProgress(items);
      const section = el('section', { class: 'list-week' });
      section.appendChild(el('h3', {}, [
        `第 ${week} 周`,
        el('small', { text: weekRange(week).text }),
        el('small', { style: 'margin-left:auto', text: progress ? `${progress.done}/${progress.total} 完成` : '' }),
      ]));
      const body = el('div', { class: 'week-body' });
      if (progress) body.appendChild(progressBar(progress.percent));
      items.forEach((item) => body.appendChild(assignmentNode(item)));
      section.appendChild(body);
      container.appendChild(section);
    });

    const majors = majorAssignments();
    if (majors.length) {
      const section = el('section', { class: 'list-week' });
      section.appendChild(el('h3', { style: 'background:#fff8ec' }, ['★ 大作业与考试']));
      const body = el('div', { class: 'week-body' });
      majors.forEach((item) => body.appendChild(assignmentNode(item)));
      section.appendChild(body);
      container.appendChild(section);
    }
  }

  /* ----------------------------- 课程表 ----------------------------- */
  function renderTimetable() {
    const container = $('#timetable');
    if (!container) return;
    container.textContent = '';

    const courses = Store.doc.courses.slice().sort((a, b) => {
      const da = a.day === null || a.day === undefined ? 9 : Number(a.day);
      const db = b.day === null || b.day === undefined ? 9 : Number(b.day);
      if (da !== db) return da - db;
      return String(a.slot || '').localeCompare(String(b.slot || ''), 'zh');
    });

    if (!courses.length) {
      container.appendChild(el('div', { class: 'major-empty' }, [
        el('p', { text: '还没有课程。点下面的按钮把课表录进来。' }),
        el('button', { class: 'btn btn-primary', dataset: { action: 'edit-schedule' }, text: '录入课表' }),
      ]));
      return;
    }

    const slots = Array.from(new Set(courses.map((c) => c.slot).filter(Boolean))).sort();
    if (slots.length) {
      const grid = el('div', { class: 'tt-grid' });
      grid.appendChild(el('div', { class: 'tt-cell head', text: '节次' }));
      U.WEEKDAYS.forEach((name) => grid.appendChild(el('div', { class: 'tt-cell head', text: name })));
      slots.forEach((slot) => {
        grid.appendChild(el('div', { class: 'tt-cell slot', text: slot }));
        for (let day = 1; day <= 7; day += 1) {
          const dayCourses = courses.filter((c) => Number(c.day) === day && c.slot === slot);
          const cell = el('div', { class: 'tt-cell' });
          dayCourses.forEach((course) => cell.appendChild(el('div', {
            class: 'tt-course',
            style: `border-left-color:${course.color}`,
          }, [
            el('b', { text: course.name }),
            course.location ? el('small', { text: course.location }) : null,
            course.teacher ? el('small', { text: course.teacher }) : null,
          ])));
          grid.appendChild(cell);
        }
      });
      container.appendChild(grid);
    } else {
      container.appendChild(el('p', { class: 'hint', text: '这些课程还没有填「星期」和「节次」，所以下面是列表形式。想排成课表，点「编辑课表」补上即可。' }));
    }

    const cards = el('div', { class: 'course-cards' });
    courses.forEach((course) => {
      const count = Store.doc.assignments.filter((a) => a.courseId === course.id).length;
      cards.appendChild(el('div', { class: 'course-card', style: `border-left-color:${course.color}` }, [
        el('b', { text: course.name }),
        el('div', { class: 'meta' }, [
          course.teacher ? el('span', { text: `老师：${course.teacher}` }) : null,
          course.location ? el('span', { text: `地点：${course.location}` }) : null,
          course.day ? el('span', { text: `时间：${U.WEEKDAYS[Number(course.day) - 1] || ''} ${course.slot || ''}` }) : null,
          course.note ? el('span', { text: `备注：${course.note}` }) : null,
          el('span', { text: `作业 ${count} 条` }),
        ]),
        el('div', { class: 'acts' }, [
          el('button', { class: 'btn btn-sm', dataset: { action: 'filter-course', id: course.id }, text: '只看这门课' }),
          el('button', { class: 'btn btn-sm', dataset: { action: 'edit-schedule' }, text: '编辑课表' }),
        ]),
      ]));
    });
    container.appendChild(el('div', { class: 'section-title' }, [
      el('span', { text: '课程列表' }),
      el('span', { class: 'tag', text: `${courses.length} 门` }),
      el('button', { class: 'btn btn-sm', style: 'margin-left:auto', dataset: { action: 'edit-schedule' }, text: '编辑课表' }),
    ]));
    container.appendChild(cards);
  }

  /* ----------------------------- 侧栏 ----------------------------- */
  function renderSidebar() {
    const stats = Store.stats();
    const box = $('#progress-box');
    if (box) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'progress-num' }, [`${stats.percent}%`, el('small', { text: ` ${stats.done}/${stats.total} 条已完成` })]));
      box.appendChild(progressBar(stats.percent, 'progress-bar'));
      box.appendChild(el('div', { class: 'progress-note', text: `本周第 ${ui.currentWeek} 周 · 大作业 ${stats.doneMajors}/${stats.majors}${stats.overdue ? ` · 逾期 ${stats.overdue} 条` : ''}` }));
    }

    const filterBox = $('#course-filter');
    if (filterBox) {
      filterBox.textContent = '';
      const counts = new Map();
      Store.doc.assignments.forEach((a) => counts.set(a.courseId, (counts.get(a.courseId) || 0) + 1));
      Store.doc.courses.forEach((course) => {
        const pressed = ui.courseId === course.id;
        filterBox.appendChild(el('button', {
          class: 'chip',
          'aria-pressed': pressed ? 'true' : 'false',
          dataset: { action: 'filter-course', id: course.id },
        }, [
          el('i', { class: 'dot', style: `background:${course.color}` }),
          el('span', { text: `${course.name} (${counts.get(course.id) || 0})` }),
        ]));
      });
      if (counts.get(null) || counts.get(undefined)) {
        filterBox.appendChild(el('button', {
          class: 'chip',
          'aria-pressed': ui.courseId === '__none__' ? 'true' : 'false',
          dataset: { action: 'filter-course', id: '__none__' },
        }, [el('span', { text: `未归类 (${counts.get(null) || 0})` })]));
      }
      if (!Store.doc.courses.length) {
        filterBox.appendChild(el('button', { class: 'btn btn-sm', dataset: { action: 'edit-schedule' }, text: '＋ 添加课程' }));
      }
    }

    U.$$('#state-filter .chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', chip.dataset.state === ui.state ? 'true' : 'false');
    });

    const majorMini = $('#major-mini');
    if (majorMini) {
      majorMini.textContent = '';
      const majors = Store.doc.assignments.filter((a) => a.type === 'major').sort(sortAssignments);
      if (!majors.length) {
        majorMini.appendChild(el('div', { class: 'empty', text: '还没有大作业' }));
      } else {
        majors.slice(0, 6).forEach((item) => {
          majorMini.appendChild(el('div', {
            class: 'row',
            dataset: { action: 'edit-hw', id: item.id },
            style: 'cursor:pointer',
          }, [
            el('i', { style: Store.isDoneByMe(item) ? 'background:#12a150' : '' }),
            el('b', { text: item.title }),
            el('small', { text: item.deadline ? U.formatDateShort(item.deadline) : `第${item.week}周` }),
          ]));
        });
      }
    }

    const members = $('#member-list');
    if (members) {
      members.textContent = '';
      const names = new Set((Store.doc.members || []).map((m) => m.nickname));
      Store.doc.assignments.forEach((a) => (a.doneBy || []).forEach((who) => names.add(who)));
      if (Store.nickname) names.add(Store.nickname);
      Array.from(names).filter(Boolean).forEach((name) => {
        members.appendChild(el('span', {
          class: `chip${name === Store.nickname ? ' me' : ''}`,
          text: name === Store.nickname ? `${name}（我）` : name,
        }));
      });
    }

    const hint = $('#storage-hint');
    if (hint) {
      const bytes = new Blob([JSON.stringify(Store.doc)]).size;
      const where = Store.mode === 'local' ? '仅本机浏览器' : '云端数据库';
      hint.textContent = `数据位置：${where}｜当前体积：${U.bytesToText(bytes)}${Store.lastSavedAt ? `｜最近保存：${U.formatDateTime(Store.lastSavedAt)}` : ''}`;
    }
  }

  /* ----------------------------- 顶栏与状态 ----------------------------- */
  function renderHeader() {
    const settings = Store.doc.settings || {};
    const title = $('#brand-title');
    if (title) title.textContent = settings.title || '本学期作业板';
    const semester = $('#brand-semester');
    if (semester) {
      const total = Number(settings.weeks) || 16;
      semester.textContent = settings.semester ? `${settings.semester} · 共 ${total} 周` : `共 ${total} 周 · 当前第 ${ui.currentWeek} 周`;
    }
    const undoBtn = $('#btn-undo');
    if (undoBtn) undoBtn.disabled = !Store.history.length;
    const redoBtn = $('#btn-redo');
    if (redoBtn) redoBtn.disabled = !Store.future.length;
  }

  function setSyncState(text, kind) {
    const node = $('#sync-state');
    if (!node) return;
    node.textContent = text;
    node.className = `sync-state ${kind || ''}`;
  }

  function renderAll() {
    detectCurrentWeek();
    renderHeader();
    renderSidebar();
    if (ui.view === 'grid') renderGrid();
    else if (ui.view === 'list') renderList();
    else renderTimetable();
  }

  function setView(view) {
    ui.view = view;
    U.$$('.seg').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.view === view ? 'true' : 'false'));
    $('#view-grid').hidden = view !== 'grid';
    $('#view-list').hidden = view !== 'list';
    $('#view-timetable').hidden = view !== 'timetable';
    renderAll();
  }

  window.UI = { ui, renderAll, renderGrid, renderList, renderTimetable, renderSidebar, renderHeader, setView, assignmentNode, weekRange, detectCurrentWeek, sortAssignments, courseColor, courseName, setSyncState, filteredAssignments };
}());
