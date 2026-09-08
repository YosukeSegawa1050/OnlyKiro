'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../updates.js');
class Events {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  emit(type) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler();
  }
  count() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}
function fixture(t, options = {}) {
  let instant = 0,
    counter = 0,
    preparations = 0,
    skipCalls = 0,
    registerCalls = 0,
    updateCalls = 0;
  const timers = new Map(),
    channels = [],
    fetches = [],
    progress = [],
    workers = [];
  const later = (callback, delay) => {
    timers.set(++counter, { callback, due: instant + delay });
    return counter;
  };
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const advance = async (amount) => {
    await flush();
    const end = instant + amount;
    while (true) {
      const next = [...timers]
        .filter(([, entry]) => entry.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      instant = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    instant = end;
    await flush();
  };
  class Channel {
    constructor() {
      this.port1 = {
        closed: false,
        close() {
          this.closed = true;
        },
        start() {},
        onmessage: null,
      };
      this.port2 = {
        closed: false,
        close() {
          this.closed = true;
        },
        postMessage: (data) => {
          queueMicrotask(() => {
            if (!this.port1.closed) this.port1.onmessage?.({ data });
          });
        },
      };
      channels.push(this);
    }
  }
  const serviceWorker = new Events();
  const registration = new Events();
  function activate(worker) {
    registration.waiting = null;
    registration.installing = null;
    registration.active = worker;
    worker.state = 'activating';
    worker.emit('statechange');
    serviceWorker.controller = worker;
    serviceWorker.emit('controllerchange');
    worker.state = 'activated';
    worker.emit('statechange');
  }
  function worker(version, state = 'activated') {
    const result = new Events();
    Object.assign(result, { version, state, noActivation: false });
    result.postMessage = (message, ports) => {
      if (message.type === 'GET_VERSION' && result.version)
        ports[0].postMessage({ version: result.version });
      if (message.type === 'SKIP_WAITING') {
        skipCalls++;
        if (!result.noActivation) queueMicrotask(() => activate(result));
      }
    };
    workers.push(result);
    return result;
  }
  registration.active = worker(
    options.activeVersion === undefined ? '2.2.1' : options.activeVersion
  );
  registration.waiting = options.waiting ? worker('2.2.1', 'installed') : null;
  registration.installing = null;
  serviceWorker.controller = registration.active;
  serviceWorker.register = async (url, config) => {
    registerCalls++;
    assert.equal(url, 'http://127.0.0.1:8765/ds-sw.js');
    assert.equal(config.updateViaCache, 'none');
    if (options.registerHang) return new Promise(() => {});
    if (options.registerError) throw new TypeError('network unavailable');
    return registration;
  };
  serviceWorker.getRegistration = async () => registration;
  registration.update = async () => {
    updateCalls++;
    if (options.update) return options.update({ registration, worker, later });
  };
  const controller = create({
    serviceWorker,
    baseURL: 'http://127.0.0.1:8765/RoundSchedule.html',
    currentVersion: options.currentVersion === undefined ? '2.0.0' : options.currentVersion,
    fetch: async (url, config) => {
      fetches.push({ url, config });
      if (options.fetchError) throw new TypeError('network unavailable');
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: options.releaseVersion || '2.2.1' }),
      };
    },
    beforeApply: () => {
      preparations++;
      return options.beforeApply?.();
    },
    onProgress: (message) => progress.push(message),
    MessageChannel: Channel,
    setTimeout: later,
    clearTimeout: (id) => timers.delete(id),
    ...(options.timeouts || {}),
  });
  t.after(() => {
    assert.equal(timers.size, 0, 'all timers were cleaned');
    assert.equal(serviceWorker.count(), 0, 'controller listeners were cleaned');
    for (const worker of workers) assert.equal(worker.count(), 0, 'worker listeners were cleaned');
    assert.ok(
      channels.every((channel) => channel.port1.closed && channel.port2.closed),
      'message ports were closed'
    );
  });
  return {
    controller,
    registration,
    serviceWorker,
    worker,
    activate,
    flush,
    advance,
    fetches,
    progress,
    get preparations() {
      return preparations;
    },
    get skipCalls() {
      return skipCalls;
    },
    get registerCalls() {
      return registerCalls;
    },
    get updateCalls() {
      return updateCalls;
    },
  };
}
test('a stale 2.0.0 page reloads when the controller and release are already 2.2.1', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.controller.check(), { status: 'reload', version: '2.2.1' });
  assert.equal(f.preparations, 1);
  assert.equal(f.skipCalls, 0);
  assert.equal(f.updateCalls, 1);
  assert.equal(f.fetches[0].url, 'http://127.0.0.1:8765/release.json');
  assert.equal(f.fetches[0].config.cache, 'no-store');
});
test('current requires matching server, active controller and page versions', async (t) => {
  const f = fixture(t, { currentVersion: '2.2.1' });
  assert.deepEqual(await f.controller.check(), { status: 'current', version: '2.2.1' });
  assert.equal(f.preparations, 0);
});
test('the recovery page without a current version always requests reload after verification', async (t) => {
  const f = fixture(t, { currentVersion: null });
  assert.deepEqual(await f.controller.check(), { status: 'reload', version: '2.2.1' });
});
test('an already downloaded waiting worker applies despite failed registration and unreachable server', async (t) => {
  const f = fixture(t, {
    waiting: true,
    registerError: true,
    fetchError: true,
    activeVersion: '2.0.0',
  });
  assert.deepEqual(await f.controller.check(), { status: 'reload', version: '2.2.1' });
  assert.equal(f.skipCalls, 1);
  assert.equal(f.preparations, 1);
  assert.equal(f.fetches.length, 0);
});
test('a new install is awaited before SKIP_WAITING and reload', async (t) => {
  const f = fixture(t, {
    activeVersion: '2.0.0',
    update({ registration, worker, later }) {
      const candidate = worker('2.2.1', 'installing');
      registration.installing = candidate;
      later(() => {
        registration.waiting = candidate;
        registration.installing = null;
        candidate.state = 'installed';
        candidate.emit('statechange');
      }, 10);
    },
  });
  const pending = f.controller.check();
  await f.flush();
  assert.equal(f.skipCalls, 0);
  await f.advance(10);
  assert.deepEqual(await pending, { status: 'reload', version: '2.2.1' });
  assert.equal(f.skipCalls, 1);
});
test('an offline or failed release request never reports the installed version as latest', async (t) => {
  const f = fixture(t, { currentVersion: '2.2.1', fetchError: true });
  await assert.rejects(f.controller.check(), /接続できません/);
  assert.equal(f.preparations, 0);
});
test('concurrent checks share one operation and return the same promise', async (t) => {
  const f = fixture(t);
  const first = f.controller.check(),
    second = f.controller.check();
  assert.equal(first, second);
  assert.equal(f.controller.busy, true);
  await first;
  assert.equal(f.registerCalls, 1);
  assert.equal(f.controller.busy, false);
});
test('a failed draft-save gate prevents activation', async (t) => {
  const f = fixture(t, { waiting: true, beforeApply: () => false });
  await assert.rejects(f.controller.check(), /編集中の内容を保存/);
  assert.equal(f.skipCalls, 0);
  assert.equal(f.registration.waiting.state, 'installed');
});
test('activation timeout removes listeners and a later retry can succeed', async (t) => {
  const f = fixture(t, { waiting: true, timeouts: { activationTimeout: 25 } });
  const waiting = f.registration.waiting;
  waiting.noActivation = true;
  const first = assert.rejects(f.controller.check(), /適用が完了しません/);
  await f.advance(25);
  await first;
  assert.equal(f.serviceWorker.count(), 0);
  assert.equal(waiting.count(), 0);
  waiting.noActivation = false;
  assert.deepEqual(await f.controller.check(), { status: 'reload', version: '2.2.1' });
  assert.equal(f.skipCalls, 2);
});
test('the whole-operation timeout bounds a permanently hanging registration', async (t) => {
  const f = fixture(t, { registerHang: true, timeouts: { timeout: 25, networkTimeout: 100 } });
  const pending = assert.rejects(f.controller.check(), /確認に時間がかかっています/);
  await f.advance(25);
  await pending;
  assert.equal(f.controller.busy, false);
});
test('an unresponsive legacy worker cannot produce a false latest result', async (t) => {
  const f = fixture(t, {
    activeVersion: null,
    currentVersion: '2.2.1',
    timeouts: { versionTimeout: 25 },
  });
  const pending = assert.rejects(f.controller.check(), /版が一致しません/);
  await f.advance(25);
  await pending;
});
test('creating the updater is safe in an unsupported environment until check is requested', async () => {
  const controller = create({ serviceWorker: null, fetch: null, baseURL: 'http://localhost/' });
  await assert.rejects(controller.check(), /利用できません/);
});
