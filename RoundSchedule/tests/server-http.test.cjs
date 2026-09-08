'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const C = require('../core.js');
const { createScheduleServer } = require('../server/http.cjs');
const PASSPHRASE = 'tests-only-not-a-real-password-2026';
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-server-http-'));
  const app = createScheduleServer({ dataDir, passphrase: PASSPHRASE });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = app.baseUrl;
  const request = (route, options = {}) => fetch(base + route, options);
  async function login() {
    const response = await request('/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function grant(scope = 'schedules:read schedules:write') {
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const registered = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'MCP SDK HTTP test',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(registered.status, 201);
    const clientId = (await registered.json()).client_id;
    const secret = crypto.randomBytes(32).toString('base64url');
    const consent = await request(
      '/oauth/authorize?' +
        new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: redirect,
          resource: base + '/mcp',
          scope,
          state: 'integration-test-state',
          code_challenge_method: 'S256',
          code_challenge: crypto.createHash('sha256').update(secret).digest('base64url'),
        })
    );
    assert.equal(consent.status, 200);
    const cookie = consent.headers.get('set-cookie').split(';')[0];
    const challenge = (await consent.text()).match(/name="challenge" value="([A-Za-z0-9_-]+)"/)[1];
    const approved = await request('/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        challenge,
        passphrase: PASSPHRASE,
        decision: 'allow',
      }).toString(),
    });
    assert.equal(approved.status, 303);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const exchanged = await request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        resource: base + '/mcp',
        code,
        redirect_uri: redirect,
        code_verifier: secret,
      }).toString(),
    });
    assert.equal(exchanged.status, 200);
    const token = (await exchanged.json()).access_token;
    const id = app.store.db
      .prepare('SELECT grant_id FROM auth_tokens WHERE hash=?')
      .get(crypto.createHash('sha256').update(token).digest('hex')).grant_id;
    return { token, id };
  }
  async function client(scope) {
    const credentials = await grant(scope);
    const mcp = new Client({ name: 'daily-schedule-http-tests', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + credentials.token } },
    });
    await mcp.connect(transport);
    t.after(() => mcp.close());
    return { mcp, ...credentials };
  }
  return { app, base, request, login, client };
}
function headers(base, cookie) {
  return { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' };
}
function newTask(name = '会議') {
  return {
    name,
    date: '2026-09-08',
    endDate: '2026-09-08',
    startMin: 600,
    endMin: 660,
    categoryId: 'work',
  };
}
function content(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}

test('public config reveals no private state; API and MCP require distinct authentication', async (t) => {
  const f = await fixture(t);
  const config = await f.request('/api/config');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await config.json(), {
    available: true,
    timeZone: 'Asia/Tokyo',
    mcpUrl: f.base + '/mcp',
    authenticated: false,
  });
  assert.equal((await f.request('/api/state')).status, 401);
  const mcp = await f.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(mcp.status, 401);
  assert.match(mcp.headers.get('www-authenticate'), /resource_metadata/);
  const cookie = await f.login();
  assert.equal((await f.request('/api/state', { headers: { Cookie: cookie } })).status, 200);
  assert.equal(
    (await f.request('/mcp', { method: 'POST', headers: headers(f.base, cookie), body: '{}' }))
      .status,
    401
  );
});
test('HTTP API initializes once, uses CAS and durable retry receipts, then undoes', async (t) => {
  const f = await fixture(t),
    cookie = await f.login();
  const state = C.initialState();
  state.tasks.push(C.taskValue({ ...newTask(), id: 'first' }, state.categories));
  const body = { state, expectedRevision: 0, mutationId: 'http-init-01', label: '初回共有' };
  const put = (route, data) =>
    f.request(route, {
      method: 'PUT',
      headers: headers(f.base, cookie),
      body: JSON.stringify(data),
    });
  const first = await put('/api/initialize', body);
  assert.equal(first.status, 200);
  const snapshot = await first.json();
  assert.equal(snapshot.state.revision, 1);
  assert.deepEqual(await (await put('/api/initialize', body)).json(), snapshot);
  assert.equal(
    (await put('/api/initialize', { ...body, expectedRevision: 1, mutationId: 'http-init-02' }))
      .status,
    409
  );
  assert.equal((await put('/api/state', { ...body, mutationId: 'http-stale1' })).status, 409);
  const undone = await f.request('/api/undo', {
    method: 'POST',
    headers: headers(f.base, cookie),
    body: JSON.stringify({ expectedRevision: 1, mutationId: 'http-undo01' }),
  });
  assert.equal(undone.status, 200);
  const result = await undone.json();
  assert.equal(result.state.tasks.length, 0);
  assert.equal(result.state.revision, 2);
  assert.equal(result.initialized, true);
});
test('API rejects missing/cross-site origins, invalid JSON/media and does not leak paths', async (t) => {
  const f = await fixture(t),
    cookie = await f.login();
  const body = JSON.stringify({
    state: C.initialState(),
    expectedRevision: 0,
    mutationId: 'security01',
  });
  for (const origin of [undefined, 'https://other.example']) {
    const h = { Cookie: cookie, 'Content-Type': 'application/json' };
    if (origin) h.Origin = origin;
    assert.equal((await f.request('/api/state', { method: 'PUT', headers: h, body })).status, 403);
  }
  assert.equal(
    (
      await f.request('/api/state', {
        method: 'PUT',
        headers: { ...headers(f.base, cookie), 'Content-Type': 'text/plain' },
        body,
      })
    ).status,
    415
  );
  assert.equal(
    (await f.request('/api/state', { method: 'PUT', headers: headers(f.base, cookie), body: '{' }))
      .status,
    400
  );
  for (const route of [
    '/.schedule-data/schedule.sqlite',
    '/server/auth.cjs',
    '/package.json',
    '/%2e%2e%2fcore.js',
    '/.git/config',
  ]) {
    const response = await f.request(route);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(await response.text(), /Users|sqlite|SELECT|passphrase/);
  }
  const page = await f.request('/RoundSchedule.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});
test('official MCP SDK lists annotated tools and shares create/update/delete data with HTTP', async (t) => {
  const f = await fixture(t),
    { mcp } = await f.client(),
    cookie = await f.login();
  const listed = await mcp.listTools();
  assert.equal(listed.tools.length, 5);
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.list_schedule.annotations.readOnlyHint, true);
  assert.equal(byName.create_schedule_task.annotations.destructiveHint, false);
  assert.equal(byName.update_schedule_task.annotations.destructiveHint, true);
  assert.equal(byName.delete_schedule_task.annotations.destructiveHint, true);
  const args = { task: newTask(), requestId: 'sdk-create01' };
  const created = content(await mcp.callTool({ name: 'create_schedule_task', arguments: args }));
  assert.equal(created.revision, 1);
  assert.ok(created.task.id);
  assert.equal(new URL(created.appUrl).origin, f.base);
  assert.equal(new URL(created.appUrl).searchParams.get('task'), created.task.id);
  assert.deepEqual(
    content(await mcp.callTool({ name: 'create_schedule_task', arguments: args })),
    created
  );
  const apiState = await (await f.request('/api/state', { headers: { Cookie: cookie } })).json();
  assert.equal(apiState.state.tasks[0].id, created.task.id);
  const list = content(
    await mcp.callTool({
      name: 'list_schedule',
      arguments: { from: '2026-09-08', to: '2026-09-09' },
    })
  );
  assert.equal(list.timeZone, 'Asia/Tokyo');
  assert.ok(list.categories.length);
  assert.equal(list.tasks[0].date, '2026-09-08');
  assert.equal(new URL(list.tasks[0].appUrl).searchParams.get('date'), '2026-09-08');
  const updated = content(
    await mcp.callTool({
      name: 'update_schedule_task',
      arguments: {
        id: created.task.id,
        expectedRevision: 1,
        changes: { name: '更新済み' },
        requestId: 'sdk-update01',
      },
    })
  );
  assert.equal(updated.task.name, '更新済み');
  assert.equal(updated.revision, 2);
  assert.equal(new URL(updated.appUrl).searchParams.get('task'), created.task.id);
  const stale = await mcp.callTool({
    name: 'delete_schedule_task',
    arguments: { id: created.task.id, expectedRevision: 1, requestId: 'sdk-stale-01' },
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error, 'revision_conflict');
  const deleted = content(
    await mcp.callTool({
      name: 'delete_schedule_task',
      arguments: { id: created.task.id, expectedRevision: 2, requestId: 'sdk-delete01' },
    })
  );
  assert.equal(deleted.revision, 3);
  assert.equal(f.app.store.getSnapshot().state.tasks.length, 0);
});
test('MCP write scope is enforced even after successful read-only initialization', async (t) => {
  const f = await fixture(t),
    { mcp } = await f.client('schedules:read');
  const list = await mcp.callTool({
    name: 'list_schedule',
    arguments: { from: '2026-09-08', to: '2026-09-08' },
  });
  assert.equal(content(list).tasks.length, 0);
  const denied = await mcp.callTool({
    name: 'create_schedule_task',
    arguments: { task: newTask(), requestId: 'scope-denied' },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error, 'insufficient_scope');
  assert.equal(f.app.store.getSnapshot().state.revision, 0);
});
test('MCP write-only credentials cannot read private schedules and oversized names are rejected', async (t) => {
  const f = await fixture(t),
    { mcp } = await f.client('schedules:write');
  const denied = await mcp.callTool({
    name: 'list_schedule',
    arguments: { from: '2026-09-08', to: '2026-09-08' },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error, 'insufficient_scope');
  const oversized = await mcp.callTool({
    name: 'create_schedule_task',
    arguments: {
      task: newTask('あ'.repeat(81)),
      requestId: 'length-test-01',
    },
  });
  assert.equal(oversized.isError, true);
  assert.equal(f.app.store.getSnapshot().state.revision, 0);
  const created = content(
    await mcp.callTool({
      name: 'create_schedule_task',
      arguments: {
        task: newTask('追加は許可'),
        requestId: 'write-only-01',
      },
    })
  );
  assert.equal(created.revision, 1);
});
test('MCP recurring changes require explicit scope and one occurrence leaves series intact', async (t) => {
  const f = await fixture(t),
    { mcp } = await f.client();
  const created = content(
    await mcp.callTool({
      name: 'create_schedule_task',
      arguments: {
        task: { ...newTask('定例'), repeat: { days: [2, 3, 4], until: '2026-09-10' } },
        requestId: 'repeat-create',
      },
    })
  );
  const args = {
    id: created.task.id,
    expectedRevision: 1,
    changes: { name: 'この回の名前' },
    requestId: 'repeat-update',
  };
  const missing = await mcp.callTool({ name: 'update_schedule_task', arguments: args });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error, 'invalid_request');
  const changed = content(
    await mcp.callTool({
      name: 'update_schedule_task',
      arguments: { ...args, scope: 'one', occurrenceDate: '2026-09-09' },
    })
  );
  assert.notEqual(changed.task.id, created.task.id);
  assert.equal(changed.task.repeat, null);
  assert.equal(changed.task.date, '2026-09-09');
  const list = content(
    await mcp.callTool({
      name: 'list_schedule',
      arguments: { from: '2026-09-08', to: '2026-09-10' },
    })
  );
  assert.deepEqual(
    list.tasks.map((task) => task.name),
    ['定例', 'この回の名前', '定例']
  );
  const deleted = content(
    await mcp.callTool({
      name: 'delete_schedule_task',
      arguments: {
        id: created.task.id,
        expectedRevision: 2,
        scope: 'one',
        occurrenceDate: '2026-09-10',
        requestId: 'repeat-delete',
      },
    })
  );
  assert.equal(deleted.scope, 'one');
  assert.equal(f.app.store.getSnapshot().state.tasks.length, 2);
});
test('MCP validates categories/overlap and rechecks revocation on every HTTP request', async (t) => {
  const f = await fixture(t),
    { mcp, id } = await f.client();
  content(
    await mcp.callTool({
      name: 'create_schedule_task',
      arguments: { task: newTask(), requestId: 'validated-01' },
    })
  );
  const overlap = await mcp.callTool({
    name: 'create_schedule_task',
    arguments: { task: newTask('重複'), requestId: 'validated-02' },
  });
  assert.equal(overlap.isError, true);
  assert.equal(overlap.structuredContent.error, 'overlap');
  const badCategory = await mcp.callTool({
    name: 'create_schedule_task',
    arguments: { task: { ...newTask(), categoryId: 'missing' }, requestId: 'validated-03' },
  });
  assert.equal(badCategory.isError, true);
  assert.equal(badCategory.structuredContent.error, 'invalid_request');
  f.app.store.db.prepare('UPDATE auth_grants SET revoked=1 WHERE id=?').run(id);
  await assert.rejects(() => mcp.listTools());
  assert.equal(f.app.store.getSnapshot().state.revision, 1);
});
test('MCP date moves require an explicit end date for single tasks and individual occurrences', async (t) => {
  const f = await fixture(t),
    { mcp } = await f.client();
  const created = content(
    await mcp.callTool({
      name: 'create_schedule_task',
      arguments: {
        task: newTask(),
        requestId: 'date-create-01',
      },
    })
  );
  const missingEnd = await mcp.callTool({
    name: 'update_schedule_task',
    arguments: {
      id: created.task.id,
      expectedRevision: 1,
      changes: { date: '2026-09-07' },
      requestId: 'date-update-01',
    },
  });
  assert.equal(missingEnd.isError, true);
  assert.equal(missingEnd.structuredContent.error, 'invalid_request');
  assert.equal(f.app.store.getSnapshot().state.revision, 1);
  assert.equal(f.app.store.getSnapshot().state.tasks[0].date, '2026-09-08');
  const moved = content(
    await mcp.callTool({
      name: 'update_schedule_task',
      arguments: {
        id: created.task.id,
        expectedRevision: 1,
        changes: { date: '2026-09-07', endDate: '2026-09-07' },
        requestId: 'date-update-02',
      },
    })
  );
  assert.equal(moved.task.date, '2026-09-07');
  assert.equal(C.interval(moved.task)[1] - C.interval(moved.task)[0], 60);
  const series = content(
    await mcp.callTool({
      name: 'create_schedule_task',
      arguments: {
        task: { ...newTask('定例'), repeat: { days: [2, 3, 4], until: '2026-09-10' } },
        requestId: 'date-create-02',
      },
    })
  );
  const wrongOccurrenceMove = await mcp.callTool({
    name: 'update_schedule_task',
    arguments: {
      id: series.task.id,
      expectedRevision: 3,
      scope: 'one',
      occurrenceDate: '2026-09-09',
      changes: { date: '2026-09-08' },
      requestId: 'date-update-03',
    },
  });
  assert.equal(wrongOccurrenceMove.isError, true);
  assert.equal(wrongOccurrenceMove.structuredContent.error, 'invalid_request');
  assert.equal(f.app.store.getSnapshot().state.revision, 3);
  assert.deepEqual(f.app.store.getSnapshot().state.tasks[1].repeat.exceptions, []);
});
