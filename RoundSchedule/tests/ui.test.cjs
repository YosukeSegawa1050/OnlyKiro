const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { IDBFactory } = require('fake-indexeddb');
const root = path.resolve(__dirname, '..');
async function waitFor(fn) {
  for (let i = 0; i < 120; i++) {
    if (fn()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('UI state did not settle');
}
async function app({
  legacy = null,
  indexedDB = new IDBFactory(),
  now = new Date('2026-09-08T12:00:00').getTime(),
  session = new Map(),
  updateCheck,
} = {}) {
  const { window } = parseHTML(fs.readFileSync(path.join(root, 'RoundSchedule.html'), 'utf8'));
  const { document } = window;
  const downloads = [];
  class DownloadURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:test-${downloads.length}`;
      downloads.push({ url, blob });
      return url;
    }
    static revokeObjectURL() {}
  }
  document.addEventListener('click', (event) => {
    if (event.target.tagName === 'A' && event.target.download) {
      const item = downloads.find((download) => download.url === event.target.href);
      if (item) item.name = event.target.download;
    }
  });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() {
      return (
        [...this.options].find((o) => o.hasAttribute('selected'))?.value ??
        this.options[0]?.value ??
        ''
      );
    },
    set(v) {
      [...this.options].forEach((o) => {
        if (o.value === String(v)) o.setAttribute('selected', '');
        else o.removeAttribute('selected');
      });
    },
  });
  Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
    configurable: true,
    get() {
      return this.hasAttribute('checked');
    },
    set(v) {
      if (v) this.setAttribute('checked', '');
      else this.removeAttribute('checked');
    },
  });
  document.querySelectorAll('dialog').forEach((d) => {
    Object.defineProperty(d, 'open', {
      get() {
        return d.hasAttribute('open');
      },
    });
    d.showModal = () => d.setAttribute('open', '');
    d.close = () => d.removeAttribute('open');
  });
  const storage = {
      getItem: (k) => (k === 'daily_schedule_data' ? legacy : null),
      setItem() {},
      removeItem() {},
    },
    sessionStorage = {
      getItem: (k) => session.get(k) || null,
      setItem: (k, v) => session.set(k, v),
      removeItem: (k) => session.delete(k),
    };
  let instant = now,
    reloads = 0;
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [instant]));
    }
    static now() {
      return instant;
    }
  }
  const ctx = vm.createContext({
    document,
    indexedDB,
    localStorage: storage,
    sessionStorage,
    navigator: { onLine: true },
    location: {
      search: '',
      href: 'http://localhost/RoundSchedule.html',
      reload() {
        reloads++;
      },
    },
    Date: Clock,
    URL: DownloadURL,
    URLSearchParams,
    Blob,
    TextEncoder,
    Intl,
    crypto: require('node:crypto').webcrypto,
    console,
    confirm: () => true,
    XMLSerializer: class {
      serializeToString(node) {
        return node.toString();
      }
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    addEventListener: window.addEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    print() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  ctx.window = ctx;
  for (const file of [
    'core.js',
    'storage.js',
    'notifications.js',
    'category-interactions.js',
    'updates.js',
    'app.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
    if (file === 'updates.js' && updateCheck)
      ctx.ScheduleUpdates = { create: (options) => ({ check: () => updateCheck(options) }) };
  }
  await waitFor(() => document.getElementById('workspace').getAttribute('aria-busy') === 'false');
  const get = (id) => document.getElementById(id),
    dispatch = (id, type) =>
      get(id).dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const C = ctx.ScheduleCore;
  const repo = new ctx.ScheduleStorage.Repository({ indexedDB, legacyStorage: storage });
  if (get('recovery').hidden) await repo.open();
  return {
    get,
    dispatch,
    ctx,
    C,
    repo,
    document,
    downloads,
    session,
    window,
    get reloads() {
      return reloads;
    },
    setNow: (v) => {
      instant = v;
    },
    focus: () => ctx.dispatchEvent(new window.Event('focus')),
    async refresh() {
      const old = get('save-status').textContent;
      this.focus();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    close() {
      repo.close();
    },
  };
}
function fill(
  a,
  {
    name = '朝の読書',
    date = '2026-09-08',
    endDate = date,
    start = '09:00',
    end = '10:00',
    category = 'study',
  } = {}
) {
  for (const [id, v] of Object.entries({
    'task-name': name,
    'task-date': date,
    'task-end-date': endDate,
    'task-start': start,
    'task-end': end,
    'task-category': category,
  }))
    a.get(id).value = v;
}
async function submit(a) {
  a.dispatch('task-form', 'submit');
  await waitFor(() => !a.get('task-dialog').open || !a.get('task-error').hidden);
}
test('HTML has unique IDs and all declared labels point to controls; no external executable assets', () => {
  const { document } = parseHTML(fs.readFileSync(path.join(root, 'RoundSchedule.html'), 'utf8'));
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const label of document.querySelectorAll('label[for]'))
    assert.ok(document.getElementById(label.getAttribute('for')));
  assert.equal(document.querySelectorAll('script[src^="https:"]').length, 0);
  assert.equal(
    document.querySelector('meta[name=viewport]').content.includes('user-scalable'),
    false
  );
});
test('app boots, adds literal HTML-looking name, edits from list, and undo restores', async () => {
  const a = await app();
  assert.equal(a.get('recovery').hidden, true);
  a.dispatch('add-task', 'click');
  assert.equal(a.get('task-dialog').open, true);
  fill(a, { name: '<img src=x onerror=alert(1)>' });
  await submit(a);
  assert.equal(a.get('task-dialog').open, false);
  assert.equal((await a.repo.read()).tasks.length, 1);
  assert.equal(a.get('task-list').querySelectorAll('img').length, 0);
  assert.match(a.get('task-list').textContent, /<img src=x/);
  a.get('task-list').querySelector('button').click();
  assert.equal(a.get('task-category').value, 'study');
  a.dispatch('task-dialog', 'cancel');
  a.get('task-dialog').close();
  a.dispatch('undo', 'click');
  await waitFor(() => a.get('task-list').children.length === 0);
  assert.equal((await a.repo.read()).tasks.length, 0);
  a.close();
});

test('date arrows continue in both directions across month boundaries and after today reset', async () => {
  const a = await app();
  a.get('selected-date').value = '2026-09-30';
  a.dispatch('selected-date', 'change');
  for (const [control, date] of [
    ['next-day', '2026-10-01'],
    ['next-day', '2026-10-02'],
    ['prev-day', '2026-10-01'],
    ['prev-day', '2026-09-30'],
    ['go-today', '2026-09-08'],
    ['prev-day', '2026-09-07'],
    ['next-day', '2026-09-08'],
  ]) {
    a.dispatch(control, 'click');
    assert.equal(a.get('selected-date').value, date);
    assert.equal(a.get('prev-day').hasAttribute('disabled'), false);
    assert.equal(a.get('next-day').hasAttribute('disabled'), false);
  }
  a.close();
});

test('manual retry after a saved all-day task loses its response never creates a second task', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a, { name: '一度だけ登録する終日予定' });
  a.get('task-kind').value = 'allDay';
  a.dispatch('task-form', 'change');
  const prototype = a.ctx.ScheduleStorage.Repository.prototype;
  const original = prototype.mutate;
  let lost = false;
  prototype.mutate = async function (...args) {
    const state = await original.apply(this, args);
    if (!lost) {
      lost = true;
      throw new Error('保存応答が失われました');
    }
    return state;
  };
  try {
    await submit(a);
    assert.equal(a.get('task-dialog').open, true);
    assert.equal((await a.repo.read()).tasks.length, 1);
    await submit(a);
    assert.match(a.get('task-error').textContent, /すでに保存/);
    assert.equal((await a.repo.read()).tasks.length, 1);
    assert.equal(a.get('task-name').value, '一度だけ登録する終日予定');
  } finally {
    prototype.mutate = original;
    a.close();
  }
});

test('chart center shows current and next tasks, and leaves unused caption space empty', async () => {
  const a = await app();
  assert.equal(a.get('center-task').textContent, '');
  assert.equal(a.get('center-task').hidden, true);
  a.dispatch('add-task', 'click');
  fill(a, { name: '昼の予定', start: '13:00', end: '14:00' });
  await submit(a);
  assert.equal(a.get('center-task').textContent, '次：昼の予定');
  assert.equal(a.get('center-task').hidden, false);
  a.setNow(new Date('2026-09-08T13:30:00').getTime());
  a.focus();
  await waitFor(() => a.get('center-task').textContent === '昼の予定');
  a.dispatch('next-day', 'click');
  assert.equal(a.get('center-task').textContent, '');
  assert.equal(a.get('center-task').hidden, true);
  assert.equal(a.get('center-detail').textContent, '');
  a.close();
});
test('editing category and original date survive focus, cross-tab refresh and midnight', async () => {
  const a = await app({ now: new Date('2026-09-08T23:59:00').getTime() });
  a.dispatch('add-task', 'click');
  fill(a, { category: 'sleep' });
  await submit(a);
  a.get('task-list').querySelector('button').click();
  a.setNow(new Date('2026-09-09T00:01:00').getTime());
  a.focus();
  await waitFor(() => a.get('selected-date').value === '2026-09-09');
  assert.equal(a.get('task-category').value, 'sleep');
  assert.equal(a.get('task-date').value, '2026-09-08');
  a.get('task-name').value = '編集後';
  await submit(a);
  const t = (await a.repo.read()).tasks[0];
  assert.equal(t.date, '2026-09-08');
  assert.equal(t.categoryId, 'sleep');
  a.close();
});
test('deleted elsewhere preserves editing input and reports conflict', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  a.get('task-list').querySelector('button').click();
  a.get('task-name').value = '消したくない入力';
  await a.repo.mutate('other delete', (s) => {
    s.tasks = [];
    return s;
  });
  await submit(a);
  assert.equal(a.get('task-dialog').open, true);
  assert.match(a.get('task-error').textContent, /削除/);
  assert.equal(a.get('task-name').value, '消したくない入力');
  a.close();
});
test('overnight UI rejects actual overlap, shows carry-over and duration', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a, { start: '23:00', end: '06:00', endDate: '2026-09-09' });
  a.dispatch('task-form', 'input');
  assert.match(a.get('duration-preview').textContent, /7時間/);
  await submit(a);
  a.dispatch('next-day', 'click');
  assert.match(a.get('task-list').textContent, /前日から継続/);
  a.dispatch('add-task', 'click');
  fill(a, { date: '2026-09-09', start: '01:00', end: '02:00' });
  await submit(a);
  assert.match(a.get('task-error').textContent, /重なって/);
  assert.equal((await a.repo.read()).tasks.length, 1);
  a.close();
});
test('category rename and deletion reassign existing tasks and templates safely', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  a.dispatch('open-categories', 'click');
  const study = [...a.get('category-list').children].find((r) => r.textContent.includes('学習'));
  study.dispatchEvent(new a.window.Event('dblclick', { bubbles: true }));
  a.get('category-name').value = '読書';
  a.dispatch('category-form', 'submit');
  await waitFor(() => a.get('category-list').textContent.includes('読書'));
  assert.match(a.get('task-list').textContent, /読書/);
  const renamed = [...a.get('category-list').children].find((r) => r.textContent.includes('読書'));
  a.setNow(new Date('2026-09-08T12:00:01').getTime());
  renamed.dispatchEvent(new a.window.Event('dblclick', { bubbles: true }));
  a.get('category-reassign').value = 'free';
  a.dispatch('delete-category', 'click');
  await waitFor(() => !a.get('category-list').textContent.includes('読書'));
  assert.equal((await a.repo.read()).tasks[0].categoryId, 'free');
  a.close();
});
function categoryKey(a, row, key) {
  const event = new a.window.Event('keydown', { bubbles: true, cancelable: true });
  event.key = key;
  row.dispatchEvent(event);
}
test('category editor stays compact until add or edit, and cancel retains the saved category', async () => {
  const a = await app();
  a.dispatch('open-categories', 'click');
  assert.equal(a.get('category-form').hidden, true);
  a.get('category-list').firstElementChild.click();
  assert.equal(a.get('category-form').hidden, true);
  a.dispatch('add-category', 'click');
  assert.equal(a.get('category-form').hidden, false);
  a.get('category-name').value = '散歩';
  a.get('category-color').value = '#118877';
  a.dispatch('category-form', 'submit');
  await waitFor(() => a.get('category-form').hidden);
  const added = [...a.get('category-list').children].find((row) =>
    row.textContent.includes('散歩')
  );
  categoryKey(a, added, 'Enter');
  assert.equal(a.get('category-color').value, '#118877');
  a.get('category-name').value = '未保存';
  a.dispatch('reset-category', 'click');
  assert.equal(a.get('category-form').hidden, true);
  assert.equal((await a.repo.read()).categories.at(-1).name, '散歩');
  a.close();
});
test('category reorder saves the order, preserving tasks and a concurrent name change', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  a.dispatch('open-categories', 'click');
  const before = await a.repo.read();
  const initialIds = Array.from(before.categories, (category) => category.id);
  const first = a.get('category-list').firstElementChild;
  await a.repo.mutate('rename elsewhere', (s) => {
    s.categories[0].name = '変更された名前';
    return s;
  });
  categoryKey(a, first, ' ');
  assert.equal(a.get('category-done').hidden, false);
  categoryKey(a, first, 'ArrowDown');
  await waitFor(() => !a.get('category-list').classList.contains('category-reorder-busy'));
  const after = await a.repo.read();
  const expected = [initialIds[1], initialIds[0], ...initialIds.slice(2)];
  assert.deepEqual(
    Array.from(after.categories, (category) => category.id),
    expected
  );
  assert.equal(after.categories[1].name, '変更された名前');
  assert.deepEqual(after.tasks, before.tasks);
  a.dispatch('category-done', 'click');
  assert.equal(a.get('category-list').classList.contains('category-reorder-mode'), false);
  assert.equal(a.get('categories-dialog').open, true);
  a.get('categories-dialog').querySelector('[data-close]').click();
  a.dispatch('open-categories', 'click');
  assert.deepEqual(
    [...a.get('category-list').children].map((row) => row.dataset.categoryId),
    expected
  );
  a.close();
});
test('a concurrent category addition rejects stale reorder and restores its visible order', async () => {
  const a = await app();
  a.dispatch('open-categories', 'click');
  const before = await a.repo.read();
  const initialIds = Array.from(before.categories, (category) => category.id);
  await a.repo.mutate('add elsewhere', (s) => {
    s.categories.push({ id: 'elsewhere', name: '追加済み', color: '#113355' });
    return s;
  });
  const first = a.get('category-list').firstElementChild;
  categoryKey(a, first, ' ');
  categoryKey(a, first, 'ArrowDown');
  await waitFor(() => !a.get('category-error').hidden);
  assert.match(a.get('category-error').textContent, /別の場所で変更/);
  assert.deepEqual(
    [...a.get('category-list').children].map((row) => row.dataset.categoryId),
    initialIds
  );
  assert.deepEqual(
    Array.from((await a.repo.read()).categories, (category) => category.id),
    [...initialIds, 'elsewhere']
  );
  assert.equal(a.get('category-form').hidden, true);
  a.close();
});
test('compact data controls export all formats and select the matching import type', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  a.dispatch('open-settings', 'click');
  assert.equal(a.get('calendar-export-range').hidden, true);
  a.dispatch('export-data', 'click');
  await waitFor(() => a.downloads.length === 1);
  assert.match(a.downloads[0].name, /\.json$/);
  assert.equal(JSON.parse(await a.downloads[0].blob.text()).tasks[0].name, '朝の読書');
  a.dispatch('import-data', 'click');
  assert.equal(a.get('file-input').accept, '.json,application/json');
  a.get('data-format').value = 'ics';
  a.dispatch('data-format', 'change');
  assert.equal(a.get('calendar-export-range').hidden, false);
  a.dispatch('export-data', 'click');
  assert.match(a.downloads[1].name, /\.ics$/);
  assert.match(await a.downloads[1].blob.text(), /BEGIN:VEVENT/);
  a.dispatch('import-data', 'click');
  assert.equal(a.get('file-input').accept, '.ics,text/calendar');
  a.get('export-to').value = '2026-01-01';
  a.dispatch('export-data', 'click');
  assert.equal(a.downloads.length, 2);
  assert.equal(a.get('settings-error').hidden, false);
  a.get('data-format').value = 'svg';
  a.dispatch('data-format', 'change');
  assert.equal(a.get('calendar-export-range').hidden, true);
  assert.equal(a.get('import-data').hidden, true);
  a.dispatch('export-data', 'click');
  assert.match(a.downloads[2].name, /\.svg$/);
  assert.match(await a.downloads[2].blob.text(), /<svg/);
  a.close();
});

test('template capture, editable content, append conflict and next-day apply', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  a.dispatch('open-templates', 'click');
  a.dispatch('snapshot-template', 'click');
  assert.equal(a.get('template-entries').children.length, 1);
  a.get('template-name').value = '朝';
  a.dispatch('template-form', 'submit');
  await waitFor(() => a.get('template-list').textContent.includes('朝'));
  a.dispatch('apply-template', 'click');
  await waitFor(() => !a.get('template-error').hidden);
  assert.match(a.get('template-error').textContent, /重なって/);
  a.get('template-date').value = '2026-09-09';
  a.dispatch('template-date', 'change');
  a.dispatch('apply-template', 'click');
  await waitFor(() => !a.get('templates-dialog').open);
  assert.equal((await a.repo.read()).tasks.length, 2);
  assert.equal(a.get('selected-date').value, '2026-09-09');
  a.close();
});
test('draft survives close/reopen with category and date intact', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a, { name: '入力途中', date: '2026-09-11', category: 'sleep' });
  a.dispatch('task-form', 'input');
  a.get('task-dialog').querySelector('[data-close]').click();
  a.dispatch('add-task', 'click');
  assert.equal(a.get('task-name').value, '入力途中');
  assert.equal(a.get('task-date').value, '2026-09-11');
  assert.equal(a.get('task-category').value, 'sleep');
  assert.equal(a.get('draft-note').hidden, false);
  a.close();
});
test('corrupt migration shows recovery and prevents editing', async () => {
  const a = await app({ legacy: '{bad' });
  assert.equal(a.get('recovery').hidden, false);
  assert.match(a.get('recovery-message').textContent, /旧データ/);
  a.dispatch('add-task', 'click');
  assert.equal(a.get('task-dialog').open, false);
  a.close();
});
test('search across days, category filter, week and month navigation', async () => {
  const a = await app();
  await a.repo.mutate('fixtures', (s) => {
    s.tasks = [
      a.C.taskValue(
        {
          id: 'future',
          name: '来週の予定',
          date: '2026-09-15',
          endDate: '2026-09-15',
          startMin: 600,
          endMin: 660,
          categoryId: 'work',
        },
        s.categories
      ),
    ];
    return s;
  });
  a.focus();
  await new Promise((r) => setTimeout(r, 10));
  a.get('search-all').checked = true;
  a.dispatch('search-all', 'change');
  a.get('search').value = '来週';
  a.dispatch('search', 'input');
  assert.match(a.get('task-list').textContent, /2026-09-15/);
  a.document.querySelector('[data-view=week]').click();
  assert.equal(a.get('calendar-grid').querySelectorAll('button').length, 7);
  a.document.querySelector('[data-view=month]').click();
  assert.equal(a.get('calendar-grid').querySelectorAll('button').length, 42);
  a.close();
});
test('recurrence editor detaches only the selected occurrence', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a);
  a.get('task-repeat').checked = true;
  a.get('repeat-until').value = '2026-09-22';
  a.get('weekday-2').checked = true;
  await submit(a);
  assert.equal((await a.repo.read()).tasks[0].repeat.days[0], 2);
  a.get('task-list').querySelector('button').click();
  assert.equal(a.get('repeat-scope').value, 'one');
  a.get('task-name').value = '今日だけ変更';
  await submit(a);
  const s = await a.repo.read();
  assert.equal(s.tasks.length, 2);
  assert.deepEqual(Array.from(s.tasks[0].repeat.exceptions), ['2026-09-08']);
  assert.equal(a.C.occurrences(s.tasks, '2026-09-15')[0].name, '朝の読書');
  assert.equal(a.C.occurrences(s.tasks, '2026-09-08')[0].name, '今日だけ変更');
  a.close();
});
test('JSON import previews counts, retains prior state until confirm and is undoable', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  a.dispatch('open-settings', 'click');
  a.dispatch('import-data', 'click');
  const raw = JSON.stringify({
    ...a.C.initialState(),
    tasks: [
      a.C.taskValue(
        {
          id: 'imported',
          name: '復元した予定',
          date: '2026-09-09',
          endDate: '2026-09-09',
          startMin: 600,
          endMin: 660,
          categoryId: 'work',
        },
        a.C.initialState().categories
      ),
    ],
  });
  Object.defineProperty(a.get('file-input'), 'files', {
    value: [{ size: raw.length, text: async () => raw }],
    configurable: true,
  });
  a.dispatch('file-input', 'change');
  await waitFor(() => a.get('import-dialog').open);
  assert.equal((await a.repo.read()).tasks[0].name, '朝の読書');
  assert.match(a.get('import-summary').textContent, /予定1件/);
  a.dispatch('confirm-import', 'click');
  await waitFor(() => !a.get('import-dialog').open);
  assert.equal((await a.repo.read()).tasks[0].name, '復元した予定');
  a.get('settings-dialog').close();
  a.dispatch('undo', 'click');
  await waitFor(() => a.get('task-list').textContent.includes('朝の読書'));
  a.close();
});
test('all-day and unscheduled tasks save without required time fields', async () => {
  const a = await app();
  for (const kind of ['allDay', 'unscheduled']) {
    a.dispatch('add-task', 'click');
    fill(a, { name: kind });
    a.get('task-kind').value = kind;
    a.dispatch('task-form', 'change');
    assert.equal(a.get('time-fields').hidden, true);
    assert.equal(a.get('task-start').required, false);
    await submit(a);
    assert.equal(a.get('task-dialog').open, false);
  }
  assert.equal((await a.repo.read()).tasks.length, 2);
  a.close();
});
test('display settings save and draft can explicitly be discarded', async () => {
  const a = await app();
  a.dispatch('open-settings', 'click');
  a.get('setting-theme').value = 'dark';
  a.get('setting-font').value = 'large';
  a.dispatch('settings-form', 'submit');
  await waitFor(() => a.document.documentElement.dataset.theme === 'dark');
  assert.equal((await a.repo.read()).settings.fontSize, 'large');
  a.get('settings-dialog').close();
  a.dispatch('add-task', 'click');
  fill(a, { name: 'draft' });
  a.dispatch('task-form', 'input');
  a.get('task-dialog').querySelector('[data-close]').click();
  a.dispatch('add-task', 'click');
  a.dispatch('discard-draft', 'click');
  assert.equal(a.get('task-name').value, '');
  assert.equal(a.get('draft-note').hidden, true);
  a.close();
});
test('app update preserves the task draft before reloading and retains saved schedules', async () => {
  const a = await app({
    updateCheck: async ({ beforeApply }) => {
      await beforeApply();
      return { status: 'reload', version: '2.2.1' };
    },
  });
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  const saved = await a.repo.read();
  a.dispatch('add-task', 'click');
  fill(a, { name: '更新中の下書き', start: '14:00', end: '15:00' });
  a.dispatch('update-app', 'click');
  await waitFor(() => a.reloads === 1);
  const draft = JSON.parse(a.session.get('daily-schedule-draft'));
  assert.equal(draft.values['task-name'], '更新中の下書き');
  assert.deepEqual((await a.repo.read()).tasks, saved.tasks);
  a.close();
});
test('failed draft persistence cancels app update and restores its button for retry', async () => {
  const session = new Map();
  const a = await app({
    session,
    updateCheck: async ({ beforeApply, onProgress }) => {
      onProgress('更新を確認中…');
      await beforeApply();
      return { status: 'reload', version: '2.2.1' };
    },
  });
  a.dispatch('add-task', 'click');
  fill(a);
  session.set = () => {
    throw new Error('full');
  };
  a.dispatch('update-app', 'click');
  await waitFor(() => !a.get('update-app').disabled);
  assert.equal(a.reloads, 0);
  assert.match(a.get('toast').textContent, /更新を中止/);
  assert.equal(a.get('task-name').value, '朝の読書');
  a.close();
});

test('template capture keeps its displayed day after midnight', async () => {
  const a = await app({ now: new Date('2026-09-08T23:59:00').getTime() });
  a.dispatch('add-task', 'click');
  fill(a);
  await submit(a);
  a.dispatch('open-templates', 'click');
  a.setNow(new Date('2026-09-09T00:01:00').getTime());
  a.focus();
  await waitFor(() => a.get('selected-date').value === '2026-09-09');
  a.dispatch('snapshot-template', 'click');
  assert.equal(a.get('template-date').value, '2026-09-08');
  assert.equal(a.get('template-entries').children.length, 1);
  assert.match(a.get('template-name').value, /9月8日/);
  a.close();
});
test('free-slot suggestion preserves the duration of an overnight entry', async () => {
  const a = await app();
  a.dispatch('add-task', 'click');
  fill(a, { start: '23:00', end: '06:00', endDate: '2026-09-09' });
  a.dispatch('find-free', 'click');
  assert.equal(a.get('task-start').value, '00:00');
  assert.equal(a.get('task-end').value, '07:00');
  assert.equal(a.get('task-end-date').value, '2026-09-08');
  a.close();
});
