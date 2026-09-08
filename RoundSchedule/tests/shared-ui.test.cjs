const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { IDBFactory } = require('fake-indexeddb');
const C = require('../core.js');
const S = require('../shared-storage.js');

async function waitFor(check) {
  for (let i = 0; i < 120; i++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('Shared UI did not settle');
}
async function setup({
  authenticated = false,
  initialized = false,
  beforeSwitch = () => true,
  configError = false,
  stateError = false,
} = {}) {
  const { window, document } = parseHTML(
    '<html><body><nav class="header-actions"></nav><span id="save-status"></span></body></html>'
  );
  window.HTMLElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  window.HTMLElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new window.Event('close'));
  };
  const server = {
    authenticated,
    initialized,
    state: C.initialState(),
    calls: [],
    loginGate: null,
    connections: [],
  };
  const preferences = new Map();
  const repo = new S.Repository({
    indexedDB: new IDBFactory(),
    legacyStorage: { getItem: () => null },
    timeZone: 'Asia/Tokyo',
    preferences: {
      getItem: (k) => preferences.get(k),
      setItem: (k, v) => preferences.set(k, v),
      removeItem: (k) => preferences.delete(k),
    },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      server.calls.push({ url, method: options.method, body });
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
      if (url === '/api/config') {
        if (configError) throw new Error('Offline');
        return json({
          available: true,
          authenticated: server.authenticated,
          mcpUrl: 'https://schedule.example/mcp',
        });
      }
      if (url === '/auth/login') {
        if (server.loginGate) await server.loginGate;
        if (body.passphrase !== 'test-passphrase')
          return json({ message: 'パスフレーズが違います' }, 401);
        server.authenticated = true;
        return json({ ok: true });
      }
      if (url === '/auth/logout') {
        server.authenticated = false;
        return json({ ok: true });
      }
      if (url === '/auth/connections') return json({ connections: server.connections });
      if (url === '/auth/revoke') {
        server.connections = server.connections.filter((c) => c.id !== body.grantId);
        return json({ ok: true });
      }
      if (!server.authenticated) return json({ message: 'Login required' }, 401);
      if (stateError) return json({ message: '共有予定を読み込めません' }, 503);
      if (url === '/api/initialize') {
        server.initialized = true;
        server.state = C.copy(body.state);
        server.state.revision++;
      }
      return json({ initialized: server.initialized, timeZone: 'Asia/Tokyo', state: server.state });
    },
  });
  await repo.open();
  const changes = [];
  const ctx = vm.createContext({
    document,
    navigator: {},
    addEventListener: window.addEventListener.bind(window),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared-ui.js'), 'utf8'), ctx);
  const options = { repo, onChange: (s) => changes.push(s), beforeSwitch };
  ctx.ScheduleSharedUI.mount(options);
  const button = (text) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === text);
  const dialog = document.getElementById('shared-dialog');
  const open = async () => {
    document.getElementById('open-shared').click();
    await waitFor(() => !dialog.querySelector('.icon-button').disabled);
  };
  return { repo, server, document, window, ctx, options, changes, button, dialog, open };
}

test('opening the integration shows a login form without sending local data', async () => {
  const a = await setup();
  await a.open();
  assert.ok(a.document.getElementById('shared-passphrase'));
  assert.equal(a.server.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(a.repo.sharedEnabled, false);
  a.ctx.ScheduleSharedUI.mount(a.options);
  assert.equal(a.document.querySelectorAll('#shared-dialog').length, 1);
  a.repo.close();
});

test('an open editor can prevent switching and opening a second modal', async () => {
  const a = await setup({ beforeSwitch: () => false });
  await a.open();
  assert.equal(a.dialog.hasAttribute('open'), false);
  assert.equal(a.server.calls.length, 0);
  a.repo.close();
});

test('login clears the password and importing local data requires a separate explicit click', async () => {
  const a = await setup();
  await a.repo.mutate('local edit', (s) => {
    s.tasks.push(
      C.taskValue(
        {
          id: 'local',
          name: '端末の予定',
          date: '2026-09-08',
          endDate: '2026-09-08',
          startMin: 540,
          endMin: 600,
          categoryId: 'work',
        },
        s.categories
      )
    );
    return s;
  });
  await a.open();
  const input = a.document.getElementById('shared-passphrase');
  input.value = 'test-passphrase';
  a.dialog
    .querySelector('form')
    .dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => a.button('この端末の予定を共有'));
  assert.equal(input.value, '');
  assert.match(a.dialog.textContent, /予定1件/);
  assert.equal(a.repo.sharedEnabled, false);
  assert.equal(a.server.calls.filter((c) => c.url === '/api/initialize').length, 0);
  a.button('この端末の予定を共有').click();
  await waitFor(() => a.document.getElementById('shared-mcp-url'));
  assert.equal(a.repo.sharedEnabled, true);
  assert.equal(a.changes.length, 1);
  assert.equal(a.changes[0].tasks[0].id, 'local');
  assert.equal((await a.repo.local.read()).tasks[0].id, 'local');
  assert.equal(a.document.getElementById('shared-mcp-url').value, 'https://schedule.example/mcp');
  a.repo.close();
});

test('existing shared schedules offer opening without initialization or local overwrite', async () => {
  const a = await setup({ authenticated: true, initialized: true });
  await a.open();
  assert.ok(a.button('共有予定を開く'));
  assert.equal(a.button('この端末の予定を共有'), undefined);
  a.button('共有予定を開く').click();
  await waitFor(() => a.document.getElementById('shared-mcp-url'));
  assert.equal(a.server.calls.filter((c) => c.url === '/api/initialize').length, 0);
  assert.equal(a.repo.sharedEnabled, true);
  a.repo.close();
});

test('connection failure stays in the dialog and keeps local mode usable', async () => {
  const a = await setup({ configError: true });
  await a.open();
  assert.match(a.dialog.textContent, /共有サーバーに接続できません/);
  assert.ok(a.button('再確認'));
  assert.equal(a.repo.sharedEnabled, false);
  assert.equal((await a.repo.read()).tasks.length, 0);
  a.repo.close();
});

test('state fetch failure is rendered as an inline error and leaves the dialog closable', async () => {
  const a = await setup({ authenticated: true, stateError: true });
  await a.open();
  const error = a.dialog.querySelector('[role=alert]');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /共有予定を読み込めません/);
  assert.equal(a.dialog.querySelector('.icon-button').disabled, false);
  a.repo.close();
});

test('pending login prevents duplicate submits and dismissal; closing clears a password', async () => {
  const a = await setup();
  await a.open();
  const input = a.document.getElementById('shared-passphrase');
  input.value = 'test-passphrase';
  let finish;
  a.server.loginGate = new Promise((r) => {
    finish = r;
  });
  const form = a.dialog.querySelector('form');
  form.dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  const cancel = new a.window.Event('cancel', { cancelable: true });
  a.dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(a.server.calls.filter((c) => c.url === '/auth/login').length, 1);
  finish();
  await waitFor(() => !a.dialog.querySelector('.icon-button').disabled);
  a.server.authenticated = false;
  a.dialog.close();
  await a.open();
  const password = a.document.getElementById('shared-passphrase');
  password.value = 'unsent';
  a.dialog.close();
  assert.equal(password.value, '');
  a.repo.close();
});

test('revoking a displayed connection keeps schedule data and escapes connection names', async () => {
  const a = await setup({ authenticated: true, initialized: true });
  a.server.connections = [{ id: 'grant-1', name: '<img src=x onerror=alert(1)>' }];
  await a.repo.connect();
  await a.open();
  assert.match(a.dialog.textContent, /<img src=x/);
  assert.equal(a.dialog.querySelectorAll('img').length, 0);
  const before = await a.repo.read();
  a.button('解除').click();
  await waitFor(() => a.dialog.textContent.includes('ChatGPTは未連携'));
  assert.deepEqual(a.server.calls.find((c) => c.url === '/auth/revoke').body, {
    grantId: 'grant-1',
  });
  assert.equal(a.repo.sharedEnabled, true);
  assert.deepEqual(await a.repo.read(), before);
  a.repo.close();
});
