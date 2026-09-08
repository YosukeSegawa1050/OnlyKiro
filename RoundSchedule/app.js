(function () {
  'use strict';
  const C = globalThis.ScheduleCore;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, fn, cls) => {
    const b = el('button', text, cls);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  const svgNode = (tag, attrs = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  let state = C.initialState(),
    ready = false,
    selectedDate = C.dateKey(),
    lastToday = selectedDate,
    view = 'day',
    edit = null,
    categoryEdit = null,
    templateEdit = null,
    importData = null,
    recovery = null,
    fileMode = 'json',
    toastTimer,
    installPrompt = null;
  let templateSourceDate = selectedDate;
  const repo = new ScheduleStorage.Repository({
    legacyStorage: { getItem: (key) => localStorage.getItem(key) },
  });
  const notifier = new ScheduleNotifications.NotificationManager(repo, {
    onError: (e) => toast(e.message),
  });
  let channel;
  try {
    channel = new BroadcastChannel('daily-schedule-v2');
    channel.onmessage = () => refresh();
  } catch {}
  const fingerprint = (value) => JSON.stringify(value);
  const dayLabel = (date) =>
    new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    }).format(new Date(C.epoch(date)));
  const clockText = (min) =>
    state.settings.clock === '12'
      ? `${min < 720 ? '午前' : '午後'}${Math.floor(min / 60) % 12 || 12}:${String(min % 60).padStart(2, '0')}`
      : C.time(min);
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => {
      $('toast').hidden = true;
    }, 5500);
  }
  function errorAt(id, error) {
    const target = $(id);
    target.textContent = error.message || String(error);
    target.hidden = false;
  }
  function clearError(id) {
    $(id).hidden = true;
    $(id).textContent = '';
  }
  function requireReady() {
    if (!ready) throw new Error('保存データを確認してから操作してください');
  }
  function openDialog(id) {
    const d = $(id);
    if (!d.open) d.showModal();
  }
  function closeDialog(id) {
    if (id === 'task-dialog') saveDraft();
    $(id).close();
  }
  document
    .querySelectorAll('[data-close]')
    .forEach((b) => b.addEventListener('click', () => closeDialog(b.dataset.close)));
  // A backdrop tap never discards input. Native dialog supplies inert background,
  // focus containment, Escape, and focus restoration.
  $('task-dialog').addEventListener('cancel', () => saveDraft());
  function applyState(next) {
    if (next.revision < state.revision) return;
    state = next;
    render();
    notifier.refresh(state);
  }
  async function commit(label, mutator, options = {}) {
    requireReady();
    $('save-status').textContent = '保存中…';
    try {
      const next = await repo.mutate(label, mutator, options);
      applyState(next);
      channel?.postMessage({ revision: next.revision });
      toast(`${label}しました`);
      return next;
    } catch (e) {
      $('save-status').textContent = '保存できませんでした（入力は保持されています）';
      throw e;
    }
  }
  async function refresh() {
    const today = C.dateKey();
    if (selectedDate === lastToday && today !== lastToday) selectedDate = today;
    lastToday = today;
    if (!ready) {
      render();
      return;
    }
    try {
      applyState(await repo.read());
    } catch (e) {
      $('save-status').textContent = '保存状態を再確認できませんでした';
      if (e instanceof ScheduleStorage.RecoveryError) {
        ready = false;
        recovery = e;
        notifier.stop();
        $('workspace').inert = true;
        $('recovery').hidden = false;
        $('recovery-message').textContent = e.message;
        $('salvage-data').hidden = !e.candidate;
        $('export-recovery').hidden = !e.raw;
      }
      toast(e.message);
    }
  }
  function goDate(date) {
    if (!C.validDate(date) || date > '9999-12-24') return;
    selectedDate = date;
    render();
  }
  function setOptions(select, items, value, emptyLabel) {
    select.replaceChildren();
    if (emptyLabel !== undefined) {
      const o = el('option', emptyLabel);
      o.value = '';
      select.append(o);
    }
    for (const x of items) {
      const o = el('option', x.name);
      o.value = x.id;
      select.append(o);
    }
    if ([...select.options].some((o) => o.value === value)) select.value = value;
  }
  function render() {
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.dataset.font = state.settings.fontSize;
    $('selected-date').value = selectedDate;
    $('date-caption').textContent = selectedDate === C.dateKey() ? '今日' : '表示日';
    $('day-title').textContent = dayLabel(selectedDate);
    $('agenda-title').textContent = $('search-all').checked ? 'すべての予定' : '予定一覧';
    $('go-today').disabled = selectedDate === C.dateKey();
    const all = C.daySegments(state.tasks, selectedDate);
    $('day-count').textContent = `${all.length}件`;
    const s = C.summary(state.tasks, selectedDate);
    $('stat-planned').textContent = C.durationText(s.occupied);
    $('stat-free').textContent = C.durationText(s.free);
    $('stat-done').textContent =
      `${all.filter((t) => t.status === 'done').length} / ${all.filter((t) => t.status !== 'cancelled').length}`;
    const filter = $('filter-category').value;
    setOptions($('filter-category'), state.categories, filter, 'すべて');
    renderChart(all);
    renderAgenda();
    renderOverview();
    $('category-summary').replaceChildren();
    for (const cat of state.categories) {
      if (!s.byCategory[cat.id]) continue;
      const chip = el('span', undefined, 'category-chip'),
        dot = el('span', undefined, 'dot');
      dot.style.background = cat.color;
      chip.append(dot, el('span', `${cat.name} ${C.durationText(s.byCategory[cat.id])}`));
      $('category-summary').append(chip);
    }
    if (ready)
      $('save-status').textContent = state.updatedAt
        ? `この端末に保存済み · ${new Date(state.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
        : 'この端末に保存';
    $('network-status').textContent = navigator.onLine === false ? 'オフライン' : 'オンライン';
    // Never rebuild an open editor during focus/storage/clock refresh.
  }
  function polar(radius, min) {
    const a = (min / 1440) * 2 * Math.PI - Math.PI / 2;
    return { x: 220 + radius * Math.cos(a), y: 220 + radius * Math.sin(a) };
  }
  function ringPath(start, end) {
    if (end - start >= 1440) return ringPath(start, start + 720) + ' ' + ringPath(start + 720, end);
    const a = polar(176, start),
      b = polar(176, end),
      c = polar(112, end),
      d = polar(112, start),
      large = end - start > 720 ? 1 : 0;
    return `M${a.x},${a.y} A176,176 0 ${large} 1 ${b.x},${b.y} L${c.x},${c.y} A112,112 0 ${large} 0 ${d.x},${d.y} Z`;
  }
  function renderChart(all) {
    const svg = $('chart');
    svg.replaceChildren();
    const title = svgNode('title', { id: 'chart-title' });
    title.textContent = `${dayLabel(selectedDate)}の24時間。時刻とカテゴリーは予定一覧でも確認できます。`;
    svg.append(
      title,
      svgNode('circle', {
        cx: 220,
        cy: 220,
        r: 144,
        fill: 'none',
        stroke: 'var(--soft)',
        'stroke-width': 64,
      })
    );
    for (let h = 0; h < 24; h++) {
      const a = polar(182, h * 60),
        b = polar(h % 3 === 0 ? 188 : 185, h * 60);
      svg.append(
        svgNode('line', {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: 'var(--muted)',
          'stroke-width': h % 3 === 0 ? 1.5 : 0.7,
        })
      );
      if (h % 3 === 0) {
        const p = polar(202, h * 60),
          t = svgNode('text', {
            x: p.x,
            y: p.y,
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            class: 'chart-time',
          });
        t.textContent = String(h);
        svg.append(t);
      }
    }
    const labels = [];
    for (const t of all.filter((t) => t.kind === 'timed' && t.status !== 'cancelled')) {
      const cat = state.categories.find((c) => c.id === t.categoryId),
        path = svgNode('path', {
          d: ringPath(t.clipStart, t.clipEnd),
          fill: cat?.color || '#637086',
          stroke: 'var(--surface)',
          'stroke-width': 2,
          class: 'chart-slice',
          tabindex: 0,
          role: 'button',
          'aria-label': `${t.name}、${formatRange(t)}、${cat?.name || ''}。編集`,
        });
      const tip = svgNode('title');
      tip.textContent = `${t.name}\n${formatRange(t)}\n${cat?.name || ''}`;
      path.append(tip);
      path.addEventListener('click', (e) => {
        e.stopPropagation();
        openTask(t);
      });
      path.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openTask(t);
        }
      });
      svg.append(path);
      if (t.clipEnd - t.clipStart >= 45) {
        const p = polar(144, (t.clipStart + t.clipEnd) / 2);
        if (!labels.some((q) => Math.abs(q.y - p.y) < 20 && Math.abs(q.x - p.x) < 92)) {
          labels.push(p);
          const text = svgNode('text', {
            x: p.x,
            y: p.y,
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            class: 'chart-task-label',
          });
          const graphemes =
            typeof Intl.Segmenter === 'function'
              ? [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(t.name)].map(
                  (x) => x.segment
                )
              : Array.from(t.name);
          text.textContent = graphemes.slice(0, 6).join('') + (graphemes.length > 6 ? '…' : '');
          svg.append(text);
        }
      }
    }
    const now = new Date(),
      isToday = selectedDate === C.dateKey(now),
      nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    if (isToday) {
      const p1 = polar(106, nowMin),
        p2 = polar(183, nowMin);
      svg.append(
        svgNode('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'now-line' }),
        svgNode('circle', { cx: p2.x, cy: p2.y, r: 4, fill: 'var(--ink)' })
      );
    }
    const current = isToday
      ? all.find(
          (t) =>
            t.kind === 'timed' &&
            t.status === 'planned' &&
            t.clipStart <= nowMin &&
            t.clipEnd > nowMin
        )
      : null;
    const next = isToday
      ? all
          .filter((t) => t.kind === 'timed' && t.status === 'planned' && t.clipStart > nowMin)
          .sort((a, b) => a.clipStart - b.clipStart)[0]
      : null;
    $('center-kicker').textContent = isToday ? (current ? 'NOW' : 'TODAY') : '24 HOURS';
    $('center-time').textContent = isToday ? clockText(Math.floor(nowMin)) : '24H';
    $('center-task').textContent = current?.name || (next ? `次：${next.name}` : '自分のペースで');
    $('center-detail').textContent = current
      ? `あと${C.durationText(Math.ceil(tillEnd(current) - Date.now() / 60000))}`
      : next
        ? `${clockText(next.startMin)}から`
        : '';
  }
  const tillEnd = (t) => C.epoch(t.endDate, t.endMin) / 60000;
  function formatRange(t) {
    if (t.kind === 'unscheduled') return '時刻未定';
    if (t.kind === 'allDay') return t.date === t.endDate ? '終日' : `${t.date}〜${t.endDate} 終日`;
    const days = C.dayNumber(t.endDate) - C.dayNumber(t.date),
      suffix = days === 1 ? '翌日 ' : days > 1 ? `${t.endDate} ` : '';
    return `${clockText(t.startMin)} → ${suffix}${clockText(t.endMin)} · ${C.durationText(C.interval(t)[1] - C.interval(t)[0])}`;
  }
  function visibleTasks() {
    const query = $('search').value.trim().toLocaleLowerCase(),
      category = $('filter-category').value;
    let tasks;
    if ($('search-all').checked) {
      const dates = state.tasks.map((t) => t.date),
        ends = state.tasks.map((t) => t.repeat?.until || t.endDate);
      tasks = dates.length
        ? C.occurrences(
            state.tasks,
            dates.reduce((a, b) => (a < b ? a : b)),
            ends.reduce((a, b) => (a > b ? a : b))
          )
        : [];
    } else tasks = C.daySegments(state.tasks, selectedDate);
    return tasks.filter(
      (t) =>
        (!category || t.categoryId === category) &&
        (!query || `${t.name} ${t.notes} ${t.location}`.toLocaleLowerCase().includes(query))
    );
  }
  function renderAgenda() {
    const list = $('task-list'),
      tasks = visibleTasks();
    list.replaceChildren();
    $('task-empty').hidden = tasks.length > 0;
    const filtering =
      $('search').value.trim() || $('filter-category').value || $('search-all').checked;
    $('task-empty').querySelector('h3').textContent = filtering
      ? '一致する予定がありません'
      : '余白のある一日';
    $('task-empty').querySelector('p').textContent = filtering
      ? '検索語やカテゴリーを変更してください。'
      : '最初の予定を追加して、一日の流れをつくりましょう。';
    $('empty-add').hidden = !!filtering;
    for (const t of tasks.slice(0, 500)) {
      const cat = state.categories.find((c) => c.id === t.categoryId),
        row = button('', () => openTask(t), 'task-row');
      if (t.status === 'cancelled') row.classList.add('cancelled');
      if (
        t.kind === 'timed' &&
        t.status === 'planned' &&
        C.epoch(t.date, t.startMin) <= Date.now() &&
        Date.now() < C.epoch(t.endDate, t.endMin)
      )
        row.classList.add('current');
      const mark = el('span', undefined, 'cat-mark');
      mark.style.background = cat?.color || '#637086';
      const content = el('span', undefined, 'task-content');
      content.append(el('strong', t.name));
      const meta = el('span', undefined, 'task-meta');
      if ($('search-all').checked || t.date !== selectedDate)
        meta.append(
          el('span', t.date !== selectedDate && !$('search-all').checked ? '前日から継続' : t.date)
        );
      meta.append(el('span', formatRange(t)), el('span', cat?.name || '未分類'));
      if (t.repeat) meta.append(el('span', '繰り返し'));
      content.append(meta);
      row.append(mark, content);
      if (t.status !== 'planned')
        row.append(el('span', t.status === 'done' ? '完了' : '中止', 'status'));
      list.append(row);
    }
    if (tasks.length > 500)
      list.append(el('p', `最初の500件を表示しています。検索条件を絞ってください。`, 'hint'));
  }
  function renderOverview() {
    $('overview').hidden = view === 'day';
    document
      .querySelectorAll('[data-view]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    if (view === 'day') return;
    const month = selectedDate.slice(0, 7);
    let from, count;
    if (view === 'week') {
      from = C.addDays(selectedDate, -((C.weekday(selectedDate) + 6) % 7));
      count = 7;
      $('overview-title').textContent = `${from} からの1週間`;
    } else {
      const first = month + '-01';
      from = C.addDays(first, -((C.weekday(first) + 6) % 7));
      count = 42;
      $('overview-title').textContent = `${month.replace('-', '年')}月`;
    }
    const grid = $('calendar-grid');
    grid.replaceChildren();
    for (const w of ['月', '火', '水', '木', '金', '土', '日'])
      grid.append(el('span', w, 'weekday-caption'));
    for (let i = 0; i < count; i++) {
      const date = C.addDays(from, i),
        tasks = C.daySegments(state.tasks, date),
        s = C.summary(state.tasks, date),
        b = button(
          '',
          () => {
            goDate(date);
            $('agenda').focus();
          },
          'calendar-day'
        );
      b.setAttribute('aria-label', `${dayLabel(date)}、${tasks.length}件`);
      if (date === C.dateKey()) b.classList.add('today');
      if (date === selectedDate) b.classList.add('selected');
      if (view === 'month' && !date.startsWith(month)) b.classList.add('outside');
      b.append(
        el('strong', `${Number(date.slice(8))}`),
        el('span', tasks.length ? `${tasks.length}件` : '—')
      );
      const density = el('span', undefined, 'density'),
        bar = el('i');
      bar.style.width = `${(s.occupied / 1440) * 100}%`;
      density.append(bar);
      b.append(density);
      if (tasks[0]) b.append(el('span', tasks[0].name, 'day-preview'));
      grid.append(b);
    }
  }
  $('chart').addEventListener('click', (e) => {
    const rect = $('chart').getBoundingClientRect(),
      x = ((e.clientX - rect.left) / rect.width) * 440 - 220,
      y = ((e.clientY - rect.top) / rect.height) * 440 - 220,
      r = Math.hypot(x, y);
    if (r < 112 || r > 176) return;
    const min =
      (Math.round(
        ((((Math.atan2(y, x) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) *
          1440) /
          15
      ) *
        15) %
      1440;
    openTask(null, { start: min });
  });

  const taskFields = [
    'task-name',
    'task-kind',
    'task-category',
    'task-date',
    'task-end-date',
    'task-start',
    'task-end',
    'task-repeat',
    'repeat-until',
    'task-notes',
    'task-location',
    'task-url',
    'task-status',
    'task-notification',
    'repeat-scope',
  ];
  function draftValues() {
    const values = {};
    for (const id of taskFields)
      values[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
    values.days = [...document.querySelectorAll('#repeat-days input:checked')].map((n) =>
      Number(n.value)
    );
    return values;
  }
  function fillValues(values) {
    for (const id of taskFields)
      if (values[id] !== undefined) {
        if ($(id).type === 'checkbox') $(id).checked = values[id];
        else $(id).value = values[id];
      }
    document.querySelectorAll('#repeat-days input').forEach((n) => {
      n.checked = (values.days || []).includes(Number(n.value));
    });
  }
  function saveDraft() {
    if (!edit) return;
    try {
      sessionStorage.setItem(
        'daily-schedule-draft',
        JSON.stringify({ edit, values: draftValues(), at: Date.now() })
      );
    } catch {
      toast('下書きを保存できません。画面を開いたまま内容を控えてください。');
    }
  }
  function clearDraft() {
    try {
      sessionStorage.removeItem('daily-schedule-draft');
    } catch {}
  }
  $('discard-draft').addEventListener('click', () => {
    if (!confirm('この下書きを破棄して、新しい予定を作成しますか？')) return;
    clearDraft();
    openTask();
  });
  function fillTask(t) {
    setOptions($('task-category'), state.categories, t.categoryId);
    fillValues({
      'task-name': t.name,
      'task-kind': t.kind,
      'task-category': t.categoryId,
      'task-date': t.date,
      'task-end-date': t.endDate,
      'task-start': C.time(t.startMin),
      'task-end': C.time(t.endMin),
      'task-repeat': !!t.repeat,
      'repeat-until': t.repeat?.until || C.addDays(t.date, 28),
      'task-notes': t.notes,
      'task-location': t.location,
      'task-url': t.url,
      'task-status': t.status,
      'task-notification': String(t.notification),
      days: t.repeat?.days || [C.weekday(t.date)],
    });
  }
  function openTask(occ = null, { start = null, restore = false } = {}) {
    if (!ready) {
      toast('保存データの確認が必要です');
      return;
    }
    clearError('task-error');
    $('draft-note').hidden = true;
    if (restore) {
      try {
        const d = JSON.parse(sessionStorage.getItem('daily-schedule-draft'));
        if (d?.edit && Date.now() - d.at < 7 * 86400000) {
          edit = d.edit;
          setOptions($('task-category'), state.categories, d.values['task-category']);
          fillValues(d.values);
          $('draft-note').hidden = false;
          finishTaskOpen();
          return;
        }
      } catch {}
    }
    const base = occ ? state.tasks.find((t) => t.id === occ.taskId) : null;
    if (occ && !base) {
      toast('この予定は削除されています');
      return;
    }
    if (base) {
      edit = { id: base.id, base: C.copy(base), occDate: occ.date };
      fillTask({ ...occ, repeat: null });
      $('repeat-scope').value = 'one';
    } else {
      const now = new Date(),
        suggest =
          start ??
          C.nextFree(
            state.tasks,
            selectedDate,
            30,
            selectedDate === C.dateKey()
              ? Math.min(1410, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15)
              : 540
          ) ??
          0;
      const end = suggest + 30;
      const t = {
        id: C.uid(),
        name: '',
        kind: 'timed',
        date: selectedDate,
        endDate: C.addDays(selectedDate, Math.floor(end / 1440)),
        startMin: suggest,
        endMin: end % 1440,
        categoryId: state.categories[0].id,
        notes: '',
        location: '',
        url: '',
        status: 'planned',
        notification: 'default',
        repeat: null,
      };
      edit = { id: null, base: null, occDate: selectedDate, newId: t.id };
      fillTask(t);
    }
    finishTaskOpen();
  }
  function finishTaskOpen() {
    $('task-title').textContent = edit.id ? '予定を編集' : '予定を追加';
    $('task-context').textContent = dayLabel($('task-date').value);
    $('edit-actions').hidden = !edit.id;
    $('repeat-scope-field').hidden = !edit.base?.repeat;
    updateTaskFields();
    openDialog('task-dialog');
  }
  function updateTaskFields() {
    const kind = $('task-kind').value,
      timed = kind === 'timed';
    $('time-fields').hidden = !timed;
    $('task-start').required = timed;
    $('task-end').required = timed;
    $('end-date-field').hidden = kind === 'unscheduled';
    $('task-end-date').required = kind !== 'unscheduled';
    const single = edit?.base?.repeat && $('repeat-scope').value === 'one';
    $('repeat-details').hidden = !!single;
    $('repeat-fields').hidden = !$('task-repeat').checked;
    $('repeat-until').required = $('task-repeat').checked && !single;
    try {
      const date = $('task-date').value,
        endDate = kind === 'unscheduled' ? date : $('task-end-date').value;
      const t = {
        date,
        endDate,
        startMin: C.minutes($('task-start').value),
        endMin: C.minutes($('task-end').value),
        kind,
      };
      const [s, e] = C.interval(t);
      $('duration-preview').textContent =
        kind === 'unscheduled'
          ? `${date} · 時刻未定`
          : e > s
            ? `${endDate !== date ? `${endDate} 終了 · ` : ''}${C.durationText(e - s)}${kind === 'allDay' ? '（終日）' : ''}`
            : '終了日・終了時刻は開始より後にしてください';
      $('task-context').textContent = dayLabel(date);
    } catch {
      $('duration-preview').textContent = '日付・時刻を入力してください';
    }
  }
  for (let day = 0; day < 7; day++) {
    const label = el('label'),
      input = el('input');
    input.type = 'checkbox';
    input.value = String(day);
    input.id = `weekday-${day}`;
    label.append(input, el('span', '日月火水木金土'[day]));
    $('repeat-days').append(label);
  }
  $('task-form').addEventListener('input', () => {
    updateTaskFields();
    saveDraft();
  });
  $('task-form').addEventListener('change', () => {
    updateTaskFields();
    saveDraft();
  });
  for (const id of taskFields) {
    $(id).setAttribute('aria-describedby', 'task-error');
    $(id).addEventListener('input', () => $(id).removeAttribute('aria-invalid'));
  }
  $('task-form').addEventListener(
    'invalid',
    (e) => {
      e.target.setAttribute('aria-invalid', 'true');
      errorAt('task-error', new Error('必須項目と入力形式を確認してください。'));
    },
    true
  );
  $('category-name').setAttribute('aria-describedby', 'category-error');
  $('category-name').addEventListener('invalid', () => {
    $('category-name').setAttribute('aria-invalid', 'true');
    errorAt('category-error', new Error('カテゴリー名を入力してください'));
  });
  $('category-name').addEventListener('input', () => {
    $('category-name').removeAttribute('aria-invalid');
    clearError('category-error');
  });
  $('repeat-scope').addEventListener('change', () => {
    if (!edit?.base?.repeat) return;
    if ($('repeat-scope').value === 'series') fillTask(edit.base);
    else {
      const offset = C.dayNumber(edit.base.endDate) - C.dayNumber(edit.base.date);
      fillTask({
        ...edit.base,
        date: edit.occDate,
        endDate: C.addDays(edit.occDate, offset),
        repeat: null,
      });
    }
    updateTaskFields();
    saveDraft();
  });
  function readTask() {
    const kind = $('task-kind').value,
      date = $('task-date').value,
      isOne = edit.base?.repeat && $('repeat-scope').value === 'one';
    const n = $('task-notification').value;
    return C.taskValue(
      {
        id: edit.id || edit.newId || C.uid(),
        name: $('task-name').value,
        date,
        endDate: kind === 'unscheduled' ? date : $('task-end-date').value,
        startMin: C.minutes($('task-start').value),
        endMin: C.minutes($('task-end').value),
        kind,
        categoryId: $('task-category').value,
        notes: $('task-notes').value,
        location: $('task-location').value,
        url: $('task-url').value,
        status: $('task-status').value,
        notification: ['default', 'off'].includes(n) ? n : Number(n),
        repeat:
          $('task-repeat').checked && !isOne
            ? {
                days: [...document.querySelectorAll('#repeat-days input:checked')].map((n) =>
                  Number(n.value)
                ),
                until: $('repeat-until').value,
                exceptions: edit.base?.repeat?.exceptions || [],
              }
            : null,
      },
      state.categories
    );
  }
  function checkedOriginal(s, context) {
    if (!context.id) return null;
    const original = s.tasks.find((t) => t.id === context.id);
    if (!original)
      throw new Error('この予定は別のタブで削除されました。「複製して編集」で新しく保存できます。');
    if (fingerprint(original) !== fingerprint(context.base))
      throw new Error(
        'この予定は別のタブで変更されました。入力を控えてから開き直すか、「複製して編集」を選んでください。'
      );
    return original;
  }
  $('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('task-error');
    const save = $('save-task');
    save.disabled = true;
    try {
      const value = readTask(),
        context = C.copy(edit),
        one = context.base?.repeat && $('repeat-scope').value === 'one';
      await commit('予定を保存', (s) => {
        const original = checkedOriginal(s, context);
        if (original && one) {
          original.repeat.exceptions = [
            ...new Set([...original.repeat.exceptions, context.occDate]),
          ];
          value.id = C.uid();
        } else if (original) s.tasks = s.tasks.filter((t) => t.id !== original.id);
        const checked = C.taskValue(value, s.categories);
        C.assertAvailable(s.tasks, checked);
        s.tasks.push(checked);
        return s;
      });
      clearDraft();
      edit = null;
      $('task-dialog').close();
    } catch (err) {
      errorAt('task-error', err);
      saveDraft();
    } finally {
      save.disabled = false;
    }
  });
  $('delete-task').addEventListener('click', async () => {
    if (!edit?.id) return;
    const context = C.copy(edit),
      one = context.base?.repeat && $('repeat-scope').value === 'one';
    if (
      !confirm(
        `${one ? 'この回の' : context.base.repeat ? '繰り返し全体の' : ''}予定「${context.base.name}」を削除しますか？直後なら「元に戻す」で取り消せます。`
      )
    )
      return;
    try {
      await commit('予定を削除', (s) => {
        const original = checkedOriginal(s, context);
        if (one)
          original.repeat.exceptions = [
            ...new Set([...original.repeat.exceptions, context.occDate]),
          ];
        else s.tasks = s.tasks.filter((t) => t.id !== context.id);
        return s;
      });
      clearDraft();
      edit = null;
      $('task-dialog').close();
    } catch (e) {
      errorAt('task-error', e);
    }
  });
  $('duplicate-task').addEventListener('click', () => {
    edit = { id: null, base: null, occDate: $('task-date').value, newId: C.uid() };
    $('repeat-scope-field').hidden = true;
    $('edit-actions').hidden = true;
    $('task-title').textContent = '予定を複製';
    $('task-repeat').checked = false;
    $('task-name').value = Array.from($('task-name').value).slice(0, 75).join('') + ' のコピー';
    updateTaskFields();
    saveDraft();
    toast('コピー先の日付・時間を選んで保存してください');
  });
  document.querySelectorAll('[data-duration]').forEach((b) =>
    b.addEventListener('click', () => {
      const min = C.minutes($('task-start').value) + Number(b.dataset.duration);
      if (!Number.isFinite(min) || !C.validDate($('task-date').value)) return;
      $('task-end').value = C.time(min);
      $('task-end-date').value = C.addDays($('task-date').value, Math.floor(min / 1440));
      updateTaskFields();
      saveDraft();
    })
  );
  $('end-next-day').addEventListener('click', () => {
    if (C.validDate($('task-date').value)) {
      $('task-end-date').value = C.addDays($('task-date').value, 1);
      updateTaskFields();
      saveDraft();
    }
  });
  $('find-free').addEventListener('click', () => {
    try {
      const date = $('task-date').value,
        range = C.interval({
          date,
          endDate: $('task-end-date').value,
          startMin: C.minutes($('task-start').value),
          endMin: C.minutes($('task-end').value),
          kind: 'timed',
        }),
        length = range[1] - range[0];
      if (!Number.isFinite(length) || length <= 0 || length > 1440)
        throw new Error('空き時間は1日以内の所要時間を指定して探してください');
      const start = C.nextFree(
        state.tasks.filter((t) => t.id !== edit.id),
        date,
        length,
        0
      );
      if (start === null) throw new Error('この日に必要な長さの空き時間がありません');
      $('task-start').value = C.time(start);
      $('task-end').value = C.time(start + length);
      $('task-end-date').value = C.addDays(date, Math.floor((start + length) / 1440));
      updateTaskFields();
      saveDraft();
    } catch (e) {
      errorAt('task-error', e);
    }
  });

  function resetCategory() {
    categoryEdit = null;
    $('category-form-title').textContent = 'カテゴリーを追加';
    $('category-name').value = '';
    $('category-color').value = '#2563eb';
    $('delete-category').hidden = true;
    $('category-reassign-field').hidden = true;
    clearError('category-error');
  }
  function renderCategories() {
    const list = $('category-list');
    list.replaceChildren();
    state.categories.forEach((cat, index) => {
      const row = el('div', undefined, 'manager-row'),
        dot = el('span', undefined, 'dot');
      dot.style.background = cat.color;
      row.append(dot, el('strong', cat.name, 'manager-name'));
      for (const [text, delta] of [
        ['↑', -1],
        ['↓', 1],
      ]) {
        const b = button(
          text,
          async () => {
            try {
              await commit('カテゴリーの順序を変更', (s) => {
                const i = s.categories.findIndex((c) => c.id === cat.id),
                  j = i + delta;
                if (i >= 0 && j >= 0 && j < s.categories.length)
                  [s.categories[i], s.categories[j]] = [s.categories[j], s.categories[i]];
                return s;
              });
              renderCategories();
            } catch (e) {
              errorAt('category-error', e);
            }
          },
          'reorder'
        );
        b.setAttribute('aria-label', `${cat.name}を${delta < 0 ? '上' : '下'}へ`);
        b.disabled = index + delta < 0 || index + delta >= state.categories.length;
        row.append(b);
      }
      row.append(
        button('編集', () => {
          categoryEdit = C.copy(cat);
          $('category-name').value = cat.name;
          $('category-color').value = cat.color;
          $('category-form-title').textContent = 'カテゴリーを編集';
          $('delete-category').hidden = false;
          $('category-reassign-field').hidden = false;
          setOptions(
            $('category-reassign'),
            state.categories.filter((c) => c.id !== cat.id),
            ''
          );
          clearError('category-error');
          $('category-name').focus();
        })
      );
      list.append(row);
    });
  }
  $('category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('category-error');
    try {
      const value = {
          id: categoryEdit?.id || C.uid(),
          name: $('category-name').value.trim(),
          color: $('category-color').value,
        },
        base = categoryEdit ? C.copy(categoryEdit) : null;
      if (!value.name) throw new Error('カテゴリー名を入力してください');
      await commit('カテゴリーを保存', (s) => {
        if (s.categories.some((c) => c.id !== value.id && c.name === value.name))
          throw new Error('同じ名前のカテゴリーがあります');
        if (base) {
          const i = s.categories.findIndex((c) => c.id === base.id);
          if (i < 0 || fingerprint(s.categories[i]) !== fingerprint(base))
            throw new Error('カテゴリーが別のタブで変更されました。開き直してください');
          s.categories[i] = value;
        } else s.categories.push(value);
        return s;
      });
      resetCategory();
      renderCategories();
    } catch (err) {
      errorAt('category-error', err);
    }
  });
  $('delete-category').addEventListener('click', async () => {
    if (!categoryEdit) return;
    const base = C.copy(categoryEdit),
      target = $('category-reassign').value;
    if (!target) {
      errorAt(
        'category-error',
        new Error('最後のカテゴリーは削除できません。移し先を追加してください。')
      );
      return;
    }
    if (!confirm(`「${base.name}」を削除し、予定とテンプレートを選択したカテゴリーへ移しますか？`))
      return;
    try {
      await commit('カテゴリーを削除', (s) => {
        const c = s.categories.find((c) => c.id === base.id);
        if (!c || fingerprint(c) !== fingerprint(base))
          throw new Error('カテゴリーが変更されました。開き直してください');
        if (!s.categories.some((c) => c.id === target))
          throw new Error('移し先のカテゴリーがありません');
        s.categories = s.categories.filter((c) => c.id !== base.id);
        s.tasks.forEach((t) => {
          if (t.categoryId === base.id) t.categoryId = target;
        });
        s.templates.forEach((t) =>
          t.tasks.forEach((x) => {
            if (x.categoryId === base.id) x.categoryId = target;
          })
        );
        return s;
      });
      resetCategory();
      renderCategories();
    } catch (e) {
      errorAt('category-error', e);
    }
  });
  $('reset-category').addEventListener('click', resetCategory);
  $('open-categories').addEventListener('click', () => {
    if (!ready) return;
    resetCategory();
    renderCategories();
    openDialog('categories-dialog');
  });

  function renderTemplates() {
    $('template-context').textContent = `対象日：${dayLabel(templateSourceDate)}`;
    const list = $('template-list');
    list.replaceChildren();
    if (!state.templates.length)
      list.append(el('p', 'まだテンプレートがありません。よく使う一日を登録しましょう。', 'hint'));
    state.templates.forEach((t, index) => {
      const row = el('div', undefined, 'manager-row');
      row.append(
        el('strong', t.name, 'manager-name'),
        el('span', `${t.tasks.length}件`, 'count'),
        button('内容を見る・編集', () => editTemplate(t)),
        button('複製', () =>
          editTemplate(
            {
              ...C.copy(t),
              id: C.uid(),
              name: Array.from(t.name).slice(0, 54).join('') + ' のコピー',
            },
            true
          )
        ),
        button(
          '削除',
          async () => {
            if (!confirm(`テンプレート「${t.name}」を削除しますか？`)) return;
            try {
              await commit('テンプレートを削除', (s) => {
                const current = s.templates.find((x) => x.id === t.id);
                if (!current || fingerprint(current) !== fingerprint(t))
                  throw new Error('内容が変更されました。開き直してください');
                s.templates = s.templates.filter((x) => x.id !== t.id);
                return s;
              });
              $('template-editor').hidden = true;
              templateEdit = null;
              renderTemplates();
            } catch (e) {
              toast(e.message);
            }
          },
          'danger'
        )
      );
      const up = button(
        '↑',
        async () => {
          try {
            await commit('テンプレートの順序を変更', (s) => {
              const i = s.templates.findIndex((x) => x.id === t.id);
              if (i > 0)
                [s.templates[i - 1], s.templates[i]] = [s.templates[i], s.templates[i - 1]];
              return s;
            });
            renderTemplates();
          } catch (e) {
            toast(e.message);
          }
        },
        'reorder'
      );
      up.setAttribute('aria-label', `${t.name}を上へ`);
      up.disabled = index === 0;
      row.append(up);
      list.append(row);
    });
  }
  function entryField(row, labelText, type, value, key, options) {
    const wrapper = el('div'),
      id = `template-${C.uid()}`,
      label = el('label', labelText);
    label.htmlFor = id;
    const input = el(type === 'select' ? 'select' : 'input');
    input.id = id;
    input.dataset.key = key;
    if (type === 'select') {
      for (const option of options) {
        const n = el('option', option.name);
        n.value = option.id;
        input.append(n);
      }
    } else input.type = type;
    input.value = value;
    input.required = true;
    if (key === 'name') input.maxLength = 80;
    if (type === 'number') {
      input.min = 0;
      input.max = 7;
    }
    wrapper.append(label, input);
    row.append(wrapper);
    return input;
  }
  function addTemplateRow(entry) {
    const row = el('div', undefined, 'template-entry');
    row._entry = C.copy(entry);
    const top = el('div', undefined, 'entry-heading');
    top.append(
      el('strong', '予定'),
      button(
        '削除',
        () => {
          row.remove();
          templatePreview();
        },
        'danger'
      )
    );
    row.append(top);
    const grid = el('div', undefined, 'entry-grid');
    entryField(grid, '予定名', 'text', entry.name, 'name');
    entryField(grid, 'カテゴリー', 'select', entry.categoryId, 'categoryId', state.categories);
    const kind = entryField(grid, '種類', 'select', entry.kind || 'timed', 'kind', [
      { id: 'timed', name: '時間を指定' },
      { id: 'allDay', name: '終日' },
      { id: 'unscheduled', name: '時刻未定' },
    ]);
    const offset = entryField(grid, '終了までの日数', 'number', entry.endOffset || 0, 'endOffset'),
      start = entryField(grid, '開始時刻', 'time', C.time(entry.startMin || 0), 'start'),
      end = entryField(grid, '終了時刻', 'time', C.time(entry.endMin || 0), 'end');
    const sync = () => {
      start.disabled = end.disabled = kind.value !== 'timed';
      offset.disabled = kind.value === 'unscheduled';
    };
    kind.addEventListener('change', sync);
    sync();
    row.append(grid);
    $('template-entries').append(row);
  }
  function editTemplate(t, isNew = false) {
    templateEdit = { id: t.id, base: isNew ? null : C.copy(t) };
    $('template-name').value = t.name;
    $('template-entries').replaceChildren();
    t.tasks.forEach(addTemplateRow);
    $('template-date').value = templateSourceDate;
    $('template-mode').value = 'append';
    $('template-editor').hidden = false;
    clearError('template-error');
    templatePreview();
    $('template-name').focus();
  }
  function readTemplate() {
    const tasks = [...document.querySelectorAll('#template-entries .template-entry')].map((row) => {
      const v = (key) => row.querySelector(`[data-key="${key}"]`).value;
      return {
        ...row._entry,
        name: v('name'),
        categoryId: v('categoryId'),
        kind: v('kind'),
        startMin: C.minutes(v('start')),
        endMin: C.minutes(v('end')),
        endOffset: Number(v('endOffset')),
      };
    });
    const candidate = {
      ...C.initialState(),
      categories: state.categories,
      templates: [{ id: templateEdit.id, name: $('template-name').value.trim(), tasks }],
    };
    const parsed = C.normalize(candidate);
    if (parsed.issues.length) throw new Error(parsed.issues.join('\n'));
    return parsed.state.templates[0];
  }
  function checkTemplate(s, value) {
    if (templateEdit.base) {
      const current = s.templates.find((t) => t.id === templateEdit.id);
      if (!current || fingerprint(current) !== fingerprint(templateEdit.base))
        throw new Error('テンプレートが別のタブで変更されました。開き直してください。');
    } else if (s.templates.some((t) => t.id === value.id))
      throw new Error('同じテンプレートを既に保存しています');
    if (s.templates.some((t) => t.id !== value.id && t.name === value.name))
      throw new Error('同じ名前のテンプレートがあります');
  }
  function templatePreview() {
    const date = $('template-date').value;
    if (!C.validDate(date)) {
      $('template-diff').textContent = '適用日を指定してください';
      return;
    }
    const starts = C.occurrences(state.tasks, date).filter((o) => o.date === date),
      count = document.querySelectorAll('#template-entries .template-entry').length;
    $('template-diff').textContent =
      `${dayLabel(date)}：${count}件を${$('template-mode').value === 'replace' ? `適用し、既存の${starts.length}件を置き換えます` : '追加します'}。${count === 0 ? '空のテンプレートです。' : ''}`;
  }
  $('template-form').addEventListener('input', templatePreview);
  $('template-date').addEventListener('change', templatePreview);
  $('template-mode').addEventListener('change', templatePreview);
  $('template-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const value = readTemplate();
      await commit('テンプレートを保存', (s) => {
        checkTemplate(s, value);
        const i = s.templates.findIndex((t) => t.id === value.id);
        if (i >= 0) s.templates[i] = value;
        else s.templates.push(value);
        return s;
      });
      templateEdit.base = C.copy(value);
      renderTemplates();
      clearError('template-error');
    } catch (e) {
      errorAt('template-error', e);
    }
  });
  $('apply-template').addEventListener('click', async () => {
    clearError('template-error');
    try {
      const value = readTemplate(),
        date = $('template-date').value,
        mode = $('template-mode').value,
        revision = state.revision;
      if (!C.validDate(date)) throw new Error('適用日を入力してください');
      const preview = C.applyTemplate(state, value, date, mode);
      if (
        !confirm(
          `${$('template-diff').textContent}\nテンプレートへの編集も保存します。実行しますか？`
        )
      )
        return;
      await commit(
        'テンプレートを適用',
        (s) => {
          checkTemplate(s, value);
          const i = s.templates.findIndex((t) => t.id === value.id);
          if (i >= 0) s.templates[i] = value;
          else s.templates.push(value);
          return C.applyTemplate(s, value, date, mode);
        },
        { expectedRevision: revision }
      );
      templateEdit.base = C.copy(value);
      goDate(date);
      $('templates-dialog').close();
    } catch (e) {
      errorAt('template-error', e);
    }
  });
  $('add-template-entry').addEventListener('click', () => {
    addTemplateRow({
      name: '',
      kind: 'timed',
      categoryId: state.categories[0].id,
      startMin: 540,
      endMin: 600,
      endOffset: 0,
      notification: 'default',
      status: 'planned',
    });
    templatePreview();
  });
  $('snapshot-template').addEventListener('click', () => {
    const tasks = C.occurrences(state.tasks, templateSourceDate)
      .filter((o) => o.date === templateSourceDate)
      .map(C.templateEntry);
    editTemplate(
      {
        id: C.uid(),
        name: `${Number(templateSourceDate.slice(5, 7))}月${Number(templateSourceDate.slice(8))}日の予定`,
        tasks,
      },
      true
    );
  });
  $('open-templates').addEventListener('click', () => {
    if (!ready) return;
    templateSourceDate = selectedDate;
    renderTemplates();
    $('template-editor').hidden = true;
    templateEdit = null;
    openDialog('templates-dialog');
  });

  let settingsBase = null;
  function notificationStatus() {
    const permission = globalThis.Notification?.permission;
    $('notification-status').textContent =
      permission === 'granted'
        ? '通知の許可：有効'
        : permission === 'denied'
          ? '通知の許可：拒否されています。ブラウザーのサイト設定から変更できます。'
          : permission === 'default'
            ? '通知の許可：未設定'
            : 'このブラウザーでは通知を利用できません';
    $('enable-notifications').disabled = !globalThis.Notification || permission === 'granted';
    $('test-notification').disabled = permission !== 'granted';
  }
  $('open-settings').addEventListener('click', () => {
    settingsBase = C.copy(state.settings);
    $('setting-theme').value = state.settings.theme;
    $('setting-font').value = state.settings.fontSize;
    $('setting-clock').value = state.settings.clock;
    $('setting-notifications').checked = state.settings.notifications;
    $('setting-lead').value = String(state.settings.lead);
    $('export-from').value = selectedDate;
    $('export-to').value = C.addDays(selectedDate, 30);
    $('data-count').textContent =
      `予定 ${state.tasks.length}件（繰り返しは1件として集計）・カテゴリー ${state.categories.length}件・テンプレート ${state.templates.length}件`;
    notificationStatus();
    clearError('settings-error');
    openDialog('settings-dialog');
    checkOffline();
  });
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const value = {
        notifications: $('setting-notifications').checked,
        lead: Number($('setting-lead').value),
        theme: $('setting-theme').value,
        fontSize: $('setting-font').value,
        clock: $('setting-clock').value,
      };
      if (value.notifications && globalThis.Notification?.permission !== 'granted')
        throw new Error('先に「通知を有効にする」で許可してください');
      await commit('設定を保存', (s) => {
        if (fingerprint(s.settings) !== fingerprint(settingsBase))
          throw new Error('別のタブで設定が変更されました。設定画面を開き直してください。');
        s.settings = value;
        return s;
      });
      settingsBase = C.copy(value);
      clearError('settings-error');
    } catch (e) {
      errorAt('settings-error', e);
    }
  });
  $('enable-notifications').addEventListener('click', async () => {
    try {
      if (!globalThis.Notification) throw new Error('このブラウザーは通知に対応していません');
      const permission = await Notification.requestPermission();
      notificationStatus();
      if (permission === 'granted') {
        $('setting-notifications').checked = true;
        notifier.refresh(state);
        $('notification-status').textContent =
          '通知を許可しました。「設定を保存」で有効になります。';
      } else
        $('notification-status').textContent =
          '通知は許可されませんでした。予定は通知なしでも利用できます。';
    } catch (e) {
      errorAt('settings-error', e);
    }
  });
  $('test-notification').addEventListener('click', async () => {
    try {
      await notifier.test();
      $('notification-status').textContent = 'テスト通知を送信しました。表示を確認してください。';
    } catch (e) {
      errorAt('settings-error', e);
    }
  });
  function download(name, content, type) {
    const blob = new Blob([content], { type }),
      url = URL.createObjectURL(blob),
      a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('export-json').addEventListener('click', async () => {
    try {
      requireReady();
      const current = await repo.read();
      download(
        `daily-schedule-${C.dateKey()}.json`,
        JSON.stringify({ ...current, exportedAt: new Date().toISOString() }, null, 2),
        'application/json'
      );
    } catch (e) {
      errorAt('settings-error', e);
    }
  });
  $('export-archive').addEventListener('click', async () => {
    try {
      const archive = await repo.archive();
      if (!archive) throw new Error('移行前データはありません');
      download('daily-schedule-before-migration.json', archive.raw, 'application/json');
    } catch (e) {
      errorAt('settings-error', e);
    }
  });
  function pickFile(mode) {
    fileMode = mode;
    $('file-input').value = '';
    $('file-input').accept = mode === 'ics' ? '.ics,text/calendar' : '.json,application/json';
    $('file-input').click();
  }
  $('import-json').addEventListener('click', () => pickFile('json'));
  $('import-ics').addEventListener('click', () => pickFile('ics'));
  $('recovery-import').addEventListener('click', () => pickFile('json'));
  function previewImport(data) {
    importData = data;
    clearError('import-error');
    $('import-summary').textContent =
      data.mode === 'ics'
        ? `${data.tasks.length}件の予定を追加します。`
        : `予定${data.candidate.tasks.length}件・カテゴリー${data.candidate.categories.length}件・テンプレート${data.candidate.templates.length}件を読み込みます。`;
    $('import-issues').hidden = !data.issues?.length;
    $('import-issues').textContent = data.issues?.length
      ? `${data.issues.length}項目を除外して復旧します。\n${data.issues.slice(0, 12).join('\n')}`
      : '';
    $('import-policy').textContent =
      data.mode === 'ics'
        ? '現在の予定は残ります。重なる時間がある場合は全件取り込みを中止します。'
        : ready
          ? '現在のデータ全体を置き換えます。置き換え前のデータを端末内に退避し、直後なら「元に戻す」で戻せます。'
          : '元データを端末内に退避してから、確認した内容で復旧します。';
    openDialog('import-dialog');
  }
  $('file-input').addEventListener('change', async () => {
    const file = $('file-input').files?.[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('10MB以下のファイルを選んでください');
      const raw = await file.text();
      if (fileMode === 'ics') {
        requireReady();
        const tasks = C.importICS(raw, state.categories[0].id, state.categories);
        previewImport({ mode: 'ics', tasks, revision: state.revision });
      } else {
        const n = C.normalize(JSON.parse(raw));
        previewImport({
          mode: 'json',
          candidate: n.state,
          issues: n.issues,
          raw,
          revision: state.revision,
        });
      }
    } catch (e) {
      if ($('settings-dialog').open) errorAt('settings-error', e);
      else {
        toast(e.message);
        $('recovery-message').textContent = e.message;
      }
    }
  });
  $('confirm-import').addEventListener('click', async () => {
    const b = $('confirm-import');
    b.disabled = true;
    try {
      if (!importData) throw new Error('ファイルを選んでください');
      const data = importData;
      if (!ready) {
        if (data.mode === 'ics') throw new Error('先にデータを復旧してください');
        const next = await repo.recover(data.candidate, recovery?.raw ?? data.raw);
        ready = true;
        recovery = null;
        $('recovery').hidden = true;
        $('workspace').inert = false;
        applyState(next);
        channel?.postMessage({ revision: next.revision });
      } else
        await commit(
          'データを取り込み',
          (s) => {
            if (data.mode === 'ics') {
              for (const task of data.tasks) {
                C.assertAvailable(s.tasks, task);
                s.tasks.push(task);
              }
              return s;
            }
            return data.candidate;
          },
          { expectedRevision: data.revision, archive: true }
        );
      $('import-dialog').close();
      importData = null;
      toast('データを読み込みました');
    } catch (e) {
      errorAt('import-error', e);
    } finally {
      b.disabled = false;
    }
  });
  $('export-recovery').addEventListener('click', () => {
    if (recovery?.raw !== null)
      download('daily-schedule-recovery-original.txt', recovery?.raw || '', 'text/plain');
  });
  $('salvage-data').addEventListener('click', () => {
    if (recovery?.candidate)
      previewImport({
        mode: 'json',
        candidate: recovery.candidate,
        issues: recovery.issues,
        raw: recovery.raw,
      });
  });
  $('export-legacy').addEventListener('click', () => {
    try {
      download(
        'daily-schedule-legacy.json',
        localStorage.getItem('daily_schedule_data') || '{}',
        'application/json'
      );
    } catch (e) {
      toast(e.message);
    }
  });
  $('export-ics').addEventListener('click', () => {
    try {
      const from = $('export-from').value,
        to = $('export-to').value;
      if (
        !C.validDate(from) ||
        !C.validDate(to) ||
        to < from ||
        C.dayNumber(to) - C.dayNumber(from) > 366
      )
        throw new Error('書き出し期間は開始日から1年以内にしてください');
      download(
        `schedule-${from}-${to}.ics`,
        C.exportICS(state.tasks, from, to),
        'text/calendar;charset=utf-8'
      );
    } catch (e) {
      errorAt('settings-error', e);
    }
  });
  $('export-svg').addEventListener('click', () => {
    const svg = $('chart').cloneNode(true);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', '880');
    svg.setAttribute('height', '880');
    const originalNodes = $('chart').querySelectorAll('*'),
      cloneNodes = svg.querySelectorAll('*');
    originalNodes.forEach((n, i) => {
      const style = getComputedStyle(n);
      for (const key of [
        'fill',
        'stroke',
        'stroke-width',
        'font-size',
        'font-family',
        'font-weight',
        'paint-order',
      ])
        cloneNodes[i].style.setProperty(key, style.getPropertyValue(key));
      cloneNodes[i].removeAttribute('tabindex');
    });
    const bg = svgNode('rect', {
      width: 440,
      height: 440,
      fill:
        getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff',
    });
    svg.insertBefore(bg, svg.firstChild);
    for (const [text, y, size] of [
      [selectedDate, 207, 14],
      [$('center-time').textContent, 232, 24],
    ]) {
      const node = svgNode('text', {
        x: 220,
        y,
        'text-anchor': 'middle',
        fill:
          getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#202a3b',
        'font-size': size,
        'font-family': 'sans-serif',
      });
      node.textContent = text;
      svg.append(node);
    }
    download(
      `schedule-${selectedDate}.svg`,
      new XMLSerializer().serializeToString(svg),
      'image/svg+xml'
    );
  });

  let registration = null;
  async function checkOffline() {
    try {
      if (!('caches' in globalThis)) throw new Error('この環境ではオフライン利用ができません');
      const cache = await caches.open(`daily-schedule-${C.VERSION}`);
      const assets = [
        './RoundSchedule.html',
        './ds-manifest.json',
        './icon-192.png',
        './icon-512.png',
        ...['core.js', 'storage.js', 'notifications.js', 'app.js', 'styles.css'].map(
          (f) => `./${f}?v=${C.VERSION}`
        ),
      ];
      const complete = (await Promise.all(assets.map((url) => cache.match(url)))).every(Boolean);
      $('offline-status').textContent = complete
        ? 'オフライン用の画面と必要なファイルを保存済みです。'
        : 'オフラインの準備中です。オンラインで再読み込みしてください。';
    } catch (e) {
      $('offline-status').textContent = e.message;
    }
  }
  async function registerWorker() {
    if (!('serviceWorker' in navigator)) {
      $('offline-status').textContent = 'この環境ではオフライン利用ができません';
      return;
    }
    try {
      registration = await navigator.serviceWorker.register('./ds-sw.js');
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') {
            checkOffline();
            if (navigator.serviceWorker.controller) {
              $('update-app').textContent = '新しい版を適用';
              toast('新しいバージョンがあります。更新ボタンで適用できます。');
            }
          }
        });
      });
      if (registration.waiting) $('update-app').textContent = '新しい版を適用';
      checkOffline();
    } catch (e) {
      $('offline-status').textContent =
        'オフラインの準備に失敗しました。オンラインで再読み込みしてください。';
      $('network-status').textContent = 'オフライン準備に失敗';
    }
  }
  $('update-app').addEventListener('click', async () => {
    const b = $('update-app');
    b.disabled = true;
    try {
      if (navigator.onLine === false) throw new Error('オフラインです。接続後に更新してください');
      if (!registration) throw new Error('更新機能を準備できませんでした。再読み込みしてください');
      await registration.update();
      if (registration.installing) {
        await new Promise((resolve, reject) => {
          const worker = registration.installing,
            timer = setTimeout(
              () =>
                reject(
                  new Error('更新の取得に時間がかかっています。しばらくして再確認してください')
                ),
              15000
            );
          const finish = () => {
            if (worker.state === 'installed' || worker.state === 'activated') {
              clearTimeout(timer);
              resolve();
            } else if (worker.state === 'redundant') {
              clearTimeout(timer);
              reject(new Error('更新を取得できませんでした'));
            }
          };
          worker.addEventListener('statechange', finish);
          finish();
        });
      }
      if (registration.waiting) {
        saveDraft();
        const timer = setTimeout(
          () => toast('更新が完了しませんでした。もう一度確認してください'),
          10000
        );
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            location.reload();
          },
          { once: true }
        );
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else toast(`最新のバージョンです（${C.VERSION}）`);
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('install-app').hidden = false;
  });
  $('install-app').addEventListener('click', async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('install-app').hidden = true;
  });
  $('add-task').addEventListener('click', () => openTask(null, { restore: true }));
  $('empty-add').addEventListener('click', () => openTask(null, { restore: true }));
  $('prev-day').addEventListener('click', () => goDate(C.addDays(selectedDate, -1)));
  $('next-day').addEventListener('click', () => goDate(C.addDays(selectedDate, 1)));
  $('go-today').addEventListener('click', () => goDate(C.dateKey()));
  $('selected-date').addEventListener('change', () => {
    if (C.validDate($('selected-date').value)) goDate($('selected-date').value);
    else $('selected-date').value = selectedDate;
  });
  document.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      view = b.dataset.view;
      renderOverview();
    })
  );
  ['search', 'filter-category', 'search-all'].forEach((id) =>
    $(id).addEventListener(id === 'search' ? 'input' : 'change', () => {
      renderAgenda();
      $('agenda-title').textContent = $('search-all').checked ? 'すべての予定' : '予定一覧';
    })
  );
  $('undo').addEventListener('click', async () => {
    try {
      requireReady();
      applyState(await repo.undo(state.revision));
      channel?.postMessage({ revision: state.revision });
      toast('最後の操作を取り消しました');
    } catch (e) {
      toast(e.message);
      refresh();
    }
  });
  $('print-day').addEventListener('click', () => {
    if ($('search-all').checked || $('search').value || $('filter-category').value) {
      $('search-all').checked = false;
      $('search').value = '';
      $('filter-category').value = '';
      render();
    }
    window.print();
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', () => {
    if (ready) refresh();
  });
  window.addEventListener('online', () => {
    render();
    checkOffline();
  });
  window.addEventListener('offline', render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === 'daily_schedule_data' && ready) $('legacy-warning').hidden = false;
  });
  window.addEventListener('pagehide', () => {
    if ($('task-dialog').open) saveDraft();
  });
  setInterval(() => {
    refresh();
  }, 30000);
  async function start() {
    const params = new URLSearchParams(location.search);
    if (C.validDate(params.get('date'))) selectedDate = params.get('date');
    $('workspace').inert = true;
    render();
    try {
      const data = await repo.open();
      state = data;
      ready = true;
      $('workspace').inert = false;
      $('workspace').setAttribute('aria-busy', 'false');
      render();
      notifier.refresh(state);
      const taskId = params.get('task');
      if (taskId) {
        const occ = C.occurrences(state.tasks, selectedDate).find((o) => o.taskId === taskId);
        if (occ) openTask(occ);
        else toast('通知の予定は変更または削除されています');
      }
    } catch (e) {
      recovery = e;
      $('recovery').hidden = false;
      $('recovery-message').textContent = e.message;
      $('salvage-data').hidden = !e.candidate;
      $('export-recovery').hidden = !e.raw;
      $('save-status').textContent = 'データの復旧が必要です';
      $('workspace').setAttribute('aria-busy', 'false');
    }
    await registerWorker();
  }
  start();
})();
