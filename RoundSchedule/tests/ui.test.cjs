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
} = {}) {
  const { window } = parseHTML(fs.readFileSync(path.join(root, 'RoundSchedule.html'), 'utf8'));
  const { document } = window;
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
  let instant = now;
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
    location: { search: '', href: 'http://localhost/RoundSchedule.html' },
    Date: Clock,
    URL,
    URLSearchParams,
    Blob,
    TextEncoder,
    Intl,
    crypto: require('node:crypto').webcrypto,
    console,
    confirm: () => true,
    XMLSerializer: window.XMLSerializer,
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
  for (const file of ['core.js', 'storage.js', 'notifications.js', 'app.js'])
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
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
    session,
    window,
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
  study.querySelectorAll('button')[2].click();
  a.get('category-name').value = '読書';
  a.dispatch('category-form', 'submit');
  await waitFor(() => a.get('category-list').textContent.includes('読書'));
  assert.match(a.get('task-list').textContent, /読書/);
  const renamed = [...a.get('category-list').children].find((r) => r.textContent.includes('読書'));
  renamed.querySelectorAll('button')[2].click();
  a.get('category-reassign').value = 'free';
  a.dispatch('delete-category', 'click');
  await waitFor(() => !a.get('category-list').textContent.includes('読書'));
  assert.equal((await a.repo.read()).tasks[0].categoryId, 'free');
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
  a.dispatch('import-json', 'click');
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
