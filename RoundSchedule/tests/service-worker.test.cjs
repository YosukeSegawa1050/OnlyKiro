const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function worker({ cached = true, fetchResult = new Response('network'), failPut = false } = {}) {
  const events = {},
    deleted = [],
    writes = [],
    requests = [],
    assets = [];
  let claimed = false,
    opened = null;
  const cache = {
    addAll: async (items) => assets.push(...items),
    match: async (req) =>
      cached
        ? new Response(typeof req === 'string' && req.endsWith('.html') ? 'app' : 'asset')
        : undefined,
    put: async (req, res) => {
      if (failPut) throw new Error('full');
      writes.push(await res.text());
    },
  };
  const self = {
    location: new URL('https://example.test/app/ds-sw.js'),
    addEventListener: (type, fn) => (events[type] = fn),
    skipWaiting: async () => {},
    clients: {
      claim: async () => {
        claimed = true;
      },
      matchAll: async () => [],
      openWindow: async (url) => {
        opened = url;
      },
    },
  };
  const ctx = vm.createContext({
    self,
    caches: {
      open: async () => cache,
      keys: async () => ['daily-schedule-v4', 'daily-schedule-2.2.0', 'another-app'],
      delete: async (key) => deleted.push(key),
    },
    URL,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (req, opts) => {
      requests.push(req);
      if (fetchResult instanceof Error) throw fetchResult;
      return fetchResult.clone();
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ds-sw.js'), 'utf8'), ctx);
  async function fetchPath(url, { mode = 'navigate', method = 'GET' } = {}) {
    let result;
    events.fetch({
      request: { url, method, mode },
      respondWith: (p) => {
        result = p;
      },
    });
    return result ? await result : undefined;
  }
  return {
    events,
    deleted,
    writes,
    requests,
    assets,
    fetchPath,
    get claimed() {
      return claimed;
    },
    get opened() {
      return opened;
    },
  };
}
test('install includes every same-origin application resource with consistent version', async () => {
  const w = worker();
  let p;
  w.events.install({ waitUntil: (x) => (p = x) });
  await p;
  for (const asset of w.assets)
    assert.ok(fs.existsSync(path.join(__dirname, '..', asset.split('?')[0])));
  assert.ok(w.assets.some((x) => x.includes('styles.css')));
  assert.ok(w.assets.includes('./icon-192.png'));
  assert.ok(!w.assets.some((x) => /^http/.test(x)));
});
test('activate only deletes previous caches belonging to this application', async () => {
  const w = worker();
  let p;
  w.events.activate({ waitUntil: (x) => (p = x) });
  await p;
  assert.deepEqual(w.deleted, ['daily-schedule-v4']);
  assert.equal(w.claimed, true);
});
test('cached navigation starts instantly despite offline, server errors or slow network', async () => {
  const w = worker({ fetchResult: new Error('offline') });
  const res = await w.fetchPath('https://example.test/app/RoundSchedule.html?date=2026-09-08');
  assert.equal(await res.text(), 'app');
  assert.equal(w.requests.length, 0);
});
test('does not intercept other applications, POST requests or external assets', async () => {
  const w = worker();
  assert.equal(await w.fetchPath('https://example.test/other/'), undefined);
  assert.equal(
    await w.fetchPath('https://example.test/app/RoundSchedule.html', { method: 'POST' }),
    undefined
  );
  assert.equal(
    await w.fetchPath('https://cdn.example.test/styles.css', { mode: 'no-cors' }),
    undefined
  );
});
test('uncached failed image gets no HTML fallback', async () => {
  const w = worker({ cached: false, fetchResult: new Error('offline') });
  const r = await w.fetchPath('https://example.test/app/icon-192.png', { mode: 'no-cors' });
  assert.equal(r.status, 503);
  assert.equal(await r.text(), '');
});
test('server 503 without cache gives clear offline response', async () => {
  const w = worker({ cached: false, fetchResult: new Response('bad', { status: 503 }) });
  const r = await w.fetchPath('https://example.test/app/RoundSchedule.html');
  assert.equal(r.status, 503);
  assert.match(await r.text(), /オンライン/);
});
test('successful asset writes finish before response resolves; cache failure does not discard network response', async () => {
  const w = worker({ cached: false });
  assert.equal(
    await (await w.fetchPath('https://example.test/app/icon-192.png', { mode: 'no-cors' })).text(),
    'network'
  );
  assert.deepEqual(w.writes, ['network']);
  const full = worker({ cached: false, failPut: true });
  assert.equal(
    (await full.fetchPath('https://example.test/app/icon-192.png', { mode: 'no-cors' })).status,
    200
  );
});
test('notification click only opens app URL, preserving other editing windows', async () => {
  const w = worker();
  let p,
    closed = false;
  w.events.notificationclick({
    notification: {
      data: { date: '2026-09-09', taskId: 'a&b' },
      close: () => {
        closed = true;
      },
    },
    waitUntil: (x) => (p = x),
  });
  await p;
  assert.equal(closed, true);
  const url = new URL(w.opened);
  assert.equal(url.origin, 'https://example.test');
  assert.equal(url.pathname, '/app/RoundSchedule.html');
  assert.equal(url.searchParams.get('task'), 'a&b');
});
test('manifest has real 192/512 PNG dimensions and all version declarations agree', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../ds-manifest.json'), 'utf8').replace(/^\uFEFF/, '')
  );
  for (const icon of manifest.icons) {
    const png = fs.readFileSync(path.join(__dirname, '..', icon.src));
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  const version = require('../core.js').VERSION;
  assert.equal(require('../package.json').version, version);
  const html = fs.readFileSync(path.join(__dirname, '../RoundSchedule.html'), 'utf8');
  assert.equal(
    [...html.matchAll(/\?v=([\d.]+)/g)].every((m) => m[1] === version),
    true
  );
});
