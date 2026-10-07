const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const C = require('../core.js');
const G = require('../google-calendar.js');

function task(overrides = {}) {
  return C.taskValue(
    {
      id: 'local-1',
      name: '打ち合わせ',
      date: '2026-10-08',
      endDate: '2026-10-08',
      startMin: 840,
      endMin: 900,
      kind: 'timed',
      categoryId: 'work',
      notes: '内容',
      location: '',
      status: 'planned',
      notification: 'default',
      ...overrides,
    },
    C.initialState().categories
  );
}

function fixture(initial = C.initialState()) {
  let state = C.copy(initial);
  const remote = [];
  const calls = [];
  const repo = {
    sharedEnabled: false,
    async read() {
      return C.copy(state);
    },
    async mutate(label, mutator) {
      state = C.strictState(mutator(C.copy(state)));
      state.revision++;
      return C.copy(state);
    },
  };
  const fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const method = options.method;
    calls.push({ url, method, options });
    const reply = (status, value) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => value,
    });
    if (method === 'GET' && url.pathname.endsWith('/events')) {
      const marker = url.searchParams.get('privateExtendedProperty')?.split('=')[1];
      return reply(200, {
        items: marker
          ? remote.filter((event) => event.extendedProperties?.private?.roundScheduleId === marker)
          : remote,
      });
    }
    if (method === 'POST' && url.pathname.endsWith('/events')) {
      const body = JSON.parse(options.body);
      const event = { ...body, id: `event-${remote.length + 1}`, etag: `v${remote.length + 1}` };
      remote.push(event);
      return reply(200, event);
    }
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    const index = remote.findIndex((event) => event.id === id);
    if (index < 0) return reply(404, { error: { message: 'not found' } });
    if (options.headers['If-Match'] !== remote[index].etag)
      return reply(412, { error: { message: 'stale' } });
    if (method === 'PATCH') {
      remote[index] = { ...remote[index], ...JSON.parse(options.body), etag: 'updated' };
      return reply(200, remote[index]);
    }
    if (method === 'DELETE') {
      remote.splice(index, 1);
      return reply(204, null);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const connection = new G.Connection({ fetch, storage, crypto: webcrypto });
  connection.token = 'test-token';
  connection.calendarId = 'round@example.com';
  return {
    connection,
    repo,
    remote,
    calls,
    get state() {
      return state;
    },
  };
}

test('Google event mapping uses exclusive all-day end and rejects unsupported local kinds', () => {
  const allDay = task({ kind: 'allDay', date: '2026-10-08', endDate: '2026-10-09' });
  const body = G.eventBody(allDay, allDay.id);
  assert.deepEqual(body.start, { date: '2026-10-08' });
  assert.deepEqual(body.end, { date: '2026-10-10' });
  assert.equal(body.extendedProperties.private.roundScheduleId, allDay.id);
  assert.throws(() => G.eventBody(task({ kind: 'unscheduled' })), /日時付き・終日/);
});

test('sync imports ChatGPT-created events once and removes deleted events', async () => {
  const f = fixture();
  f.remote.push({
    id: 'from-chatgpt',
    etag: 'v1',
    summary: 'ChatGPTで追加',
    start: { date: '2026-10-08' },
    end: { date: '2026-10-09' },
  });
  const first = await f.connection.sync(f.repo);
  assert.equal(first.imported, 1);
  assert.equal(first.state.tasks[0].name, 'ChatGPTで追加');
  assert.equal(first.state.tasks[0].categoryId, 'work');
  const revision = f.state.revision;
  await f.connection.sync(f.repo);
  assert.equal(f.state.revision, revision);
  f.remote.splice(0);
  await f.connection.sync(f.repo);
  assert.equal(f.state.tasks.length, 0);
});

test('migration is idempotent and carries local category and status into the cached task', async () => {
  const initial = C.initialState();
  initial.tasks.push(task({ categoryId: 'study', status: 'done' }));
  const f = fixture(initial);
  assert.equal(await f.connection.migrate(f.repo), 1);
  assert.equal(f.remote.length, 1);
  assert.equal(f.state.tasks.length, 1);
  assert.ok(G.isGoogleTask(f.state.tasks[0]));
  assert.equal(f.state.tasks[0].categoryId, 'study');
  assert.equal(f.state.tasks[0].status, 'done');
  assert.equal(await f.connection.migrate(f.repo), 0);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('retrying a Google create with the same local ID does not add a duplicate', async () => {
  const f = fixture();
  const first = await f.connection.create(task());
  const retry = await f.connection.create(task());
  assert.equal(retry.id, first.id);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('an unsupported Google event does not remove its local source task', async () => {
  const initial = C.initialState();
  initial.tasks.push(task());
  const f = fixture(initial);
  f.remote.push({
    id: 'too-long',
    summary: '長すぎる予定',
    start: { date: '2026-10-08' },
    end: { date: '2026-10-20' },
    extendedProperties: { private: { roundScheduleId: 'local-1' } },
  });
  const result = await f.connection.sync(f.repo);
  assert.equal(result.skipped, 1);
  assert.equal(f.state.tasks.length, 1);
  assert.equal(f.state.tasks[0].id, 'local-1');
});

test('Google edits use an etag and preserve RoundSchedule-only metadata', async () => {
  const f = fixture();
  f.remote.push({
    id: 'event-1',
    etag: 'v1',
    summary: '元の予定',
    description: '長いメモ'.repeat(500),
    start: { date: '2026-10-08' },
    end: { date: '2026-10-09' },
  });
  const imported = (await f.connection.sync(f.repo)).state.tasks[0];
  const changed = { ...imported, name: '変更後', categoryId: 'study', status: 'done' };
  await f.connection.update(changed);
  const patch = f.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.options.headers['If-Match'], 'v1');
  assert.equal(Object.hasOwn(JSON.parse(patch.options.body), 'description'), false);
  await f.connection.sync(f.repo, changed);
  assert.equal(f.state.tasks[0].name, '変更後');
  assert.equal(f.state.tasks[0].categoryId, 'study');
  assert.equal(f.state.tasks[0].status, 'done');
  await f.connection.remove(f.state.tasks[0]);
  await f.connection.sync(f.repo);
  assert.equal(f.state.tasks.length, 0);
});

test('Google connection dialog keeps the calendar picker until selection', async () => {
  const { window } = parseHTML(
    '<html><head></head><body><nav class="header-actions"></nav></body></html>'
  );
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() {
      return (
        [...this.options].find((option) => option.hasAttribute('selected'))?.value ||
        this.options[0]?.value ||
        ''
      );
    },
    set(value) {
      [...this.options].forEach((option) => {
        if (option.value === value) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      });
    },
  });
  const ctx = vm.createContext({
    document: window.document,
    setInterval() {},
    confirm: () => true,
    crypto: webcrypto,
    TextEncoder,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../google-calendar.js'), 'utf8'), ctx);
  const connection = {
    clientId: '123-abc.apps.googleusercontent.com',
    calendarId: '',
    token: '',
    ready: true,
    get connected() {
      return !!(this.token && this.calendarId);
    },
    prepare: async () => {},
    authorize: async function () {
      this.token = 'token';
    },
    calendars: async () => [{ id: 'round@example.com', summary: 'RoundSchedule' }],
    configure: function (clientId, calendarId) {
      this.clientId = clientId;
      this.calendarId = calendarId;
    },
    sync: async () => ({ state: C.initialState(), imported: 0, skipped: 0 }),
  };
  const repo = { sharedEnabled: false };
  ctx.ScheduleGoogle.mount(connection, { repo, onChange() {} });
  const dialog = window.document.getElementById('google-dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  window.document.getElementById('open-google').click();
  const connect = [...dialog.querySelectorAll('button')].find((b) =>
    b.textContent.includes('Googleアカウントに接続')
  );
  connect.click();
  for (let i = 0; i < 10 && !dialog.querySelector('#google-calendar-id'); i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(dialog.querySelector('#google-calendar-id'));
  const choose = [...dialog.querySelectorAll('button')].find((b) =>
    b.textContent.includes('このカレンダーと同期')
  );
  choose.click();
  for (let i = 0; i < 10 && !connection.calendarId; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.calendarId, 'round@example.com');
});
