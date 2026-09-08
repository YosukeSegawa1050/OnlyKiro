const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const C = require('../core.js');
const S = require('../shared-storage.js');

const entry = (id, startMin = 540) =>
  C.taskValue(
    {
      id,
      name: id,
      date: '2026-09-08',
      endDate: '2026-09-08',
      startMin,
      endMin: startMin + 60,
      categoryId: 'work',
    },
    C.initialState().categories
  );
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function fixture({
  initialized = true,
  timeZone = 'Asia/Tokyo',
  preferences = new Map(),
  indexedDB = new IDBFactory(),
} = {}) {
  const backend = {
    initialized,
    timeZone,
    state: C.initialState(),
    status: 200,
    offline: false,
    calls: [],
    mutations: new Map(),
    losePutResponse: false,
    lostWriteResponses: 0,
    beforeGet: null,
    beforePut: null,
  };
  backend.snapshot = () => ({
    initialized: backend.initialized,
    timeZone: backend.timeZone,
    state: C.copy(backend.state),
  });
  const writeResponse = (snapshot) => {
    if (backend.lostWriteResponses > 0) {
      backend.lostWriteResponses--;
      throw new TypeError('Response lost after commit');
    }
    return response(snapshot);
  };
  backend.fetch = async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    backend.calls.push({ path, ...options, body });
    if (backend.offline) throw new TypeError('Network unavailable');
    if (backend.status !== 200) return response({ error: 'HTTP error' }, backend.status);
    if (options.method === 'GET') {
      const snapshot = backend.snapshot();
      if (backend.beforeGet) await backend.beforeGet(snapshot);
      return response(snapshot);
    }
    if (backend.mutations.has(body.mutationId))
      return writeResponse(backend.mutations.get(body.mutationId));
    if (backend.beforePut) await backend.beforePut();
    if (backend.mutations.has(body.mutationId))
      return writeResponse(backend.mutations.get(body.mutationId));
    if (body.expectedRevision !== backend.state.revision)
      return response({ error: 'conflict' }, 409);
    if (path === '/api/initialize' && backend.initialized)
      return response({ error: 'already initialized' }, 409);
    backend.state = C.copy(body.state || C.initialState());
    backend.state.revision = body.expectedRevision + 1;
    backend.state.updatedAt = '2026-09-08T05:00:00.000Z';
    backend.initialized = true;
    const snapshot = backend.snapshot();
    backend.mutations.set(body.mutationId, snapshot);
    if (backend.losePutResponse) {
      backend.losePutResponse = false;
      throw new TypeError('Response lost after commit');
    }
    return writeResponse(snapshot);
  };
  const makeRepo = () =>
    new S.Repository({
      indexedDB,
      legacyStorage: { getItem: () => null },
      timeZone: 'Asia/Tokyo',
      fetch: backend.fetch,
      preferences: {
        getItem: (key) => preferences.get(key) || null,
        setItem: (key, value) => preferences.set(key, value),
        removeItem: (key) => preferences.delete(key),
      },
    });
  return { backend, preferences, indexedDB, makeRepo, repo: makeRepo() };
}

test('shared setup requires an explicit import and retains the existing local schedule', async () => {
  const { repo, backend, preferences } = fixture({ initialized: false });
  await repo.open();
  const local = await repo.mutate('local edit', (s) => {
    s.tasks.push(entry('local'));
    return s;
  });
  await assert.rejects(repo.connect(), /操作を選んで/);
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 0);
  const shared = await repo.connect({ importLocal: true, expectedRevision: local.revision });
  assert.equal(shared.tasks[0].id, 'local');
  assert.equal(repo.sharedEnabled, true);
  assert.equal(preferences.get(S.MODE_KEY), 'true');
  assert.deepEqual(await repo.local.read(), local);
  assert.equal(backend.calls.filter((c) => c.path === '/api/initialize').length, 1);
  repo.close();
});

test('existing shared data cannot be overwritten by initialization and switching keeps local data', async () => {
  const { repo, backend } = fixture();
  backend.state.tasks = [entry('remote')];
  await repo.open();
  const local = await repo.mutate('local', (s) => {
    s.tasks.push(entry('local'));
    return s;
  });
  await assert.rejects(
    repo.connect({ importLocal: true, expectedRevision: local.revision }),
    (e) => e.status === 409
  );
  assert.equal(repo.sharedEnabled, false);
  assert.equal((await repo.connect()).tasks[0].id, 'remote');
  assert.deepEqual(await repo.local.read(), local);
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 0);
  repo.close();
});

test('initialization rejects a local schedule changed after the displayed preview', async () => {
  const { repo, backend } = fixture({ initialized: false });
  await repo.open();
  await repo.mutate('local', (s) => {
    s.tasks.push(entry('new'));
    return s;
  });
  await assert.rejects(
    repo.connect({ importLocal: true, expectedRevision: 0 }),
    /件数を確認し直して/
  );
  assert.equal(backend.initialized, false);
  assert.equal(repo.sharedEnabled, false);
  repo.close();
});

test('disconnect retains latest shared content locally and archives the original local schedule', async () => {
  const { repo, backend, preferences } = fixture();
  await repo.open();
  const original = await repo.mutate('local', (s) => {
    s.tasks.push(entry('original'));
    return s;
  });
  await repo.connect();
  backend.state.tasks = [entry('latest-shared')];
  backend.state.revision = 4;
  const local = await repo.disconnect();
  assert.equal(repo.sharedEnabled, false);
  assert.equal(preferences.has(S.MODE_KEY), false);
  assert.equal(local.tasks[0].id, 'latest-shared');
  assert.equal((await repo.read()).tasks[0].id, 'latest-shared');
  const archive = await repo.local.run('readonly', (store, done) => {
    const read = store.get('restore-backup');
    read.onsuccess = () => done(read.result);
  });
  assert.deepEqual(JSON.parse(archive.raw), original);
  repo.close();
});

test('offline restart displays the shared cache and all writes fail without local fallback', async () => {
  const f = fixture();
  f.backend.state.tasks = [entry('remote')];
  await f.repo.open();
  const local = await f.repo.local.read();
  await f.repo.connect();
  f.repo.close();
  f.backend.offline = true;
  const repo = f.makeRepo();
  assert.equal((await repo.open()).tasks[0].id, 'remote');
  assert.equal(repo.sharedEnabled, true);
  assert.equal(repo.notificationsAllowed, false);
  assert.match(repo.saveStatus(), /閲覧のみ/);
  await assert.rejects(
    repo.mutate('offline edit', (s) => {
      s.tasks.push(entry('no-save', 700));
      return s;
    }),
    /接続できません/
  );
  await assert.rejects(repo.undo(0), /接続できません/);
  await assert.rejects(repo.disconnect(), /接続できません/);
  assert.deepEqual(await repo.local.read(), local);
  assert.equal((await repo.read()).tasks.length, 1);
  repo.close();
});

test('expired login retains cached data, rejects edits, and recovers after authentication', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  await repo.connect();
  backend.status = 401;
  const cached = await repo.read();
  assert.match(repo.problem, /再ログイン/);
  await assert.rejects(
    repo.mutate('write', (s) => s),
    (e) => e.status === 401
  );
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.deepEqual(await repo.read(), cached);
  backend.status = 200;
  backend.state.revision = 3;
  assert.equal((await repo.read()).revision, 3);
  assert.equal(repo.problem, '');
  assert.equal(repo.notificationsAllowed, true);
  repo.close();
});

test('stale destructive edits and server conflicts preserve both shared and local snapshots', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  const local = await repo.local.read();
  await repo.connect();
  backend.state.revision = 2;
  await assert.rejects(
    repo.mutate('stale import', () => C.initialState(), { expectedRevision: 0 }),
    (e) => e.status === 409
  );
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 0);
  backend.beforePut = () => {
    backend.state.revision++;
  };
  await assert.rejects(
    repo.mutate('racing edit', (s) => {
      s.tasks.push(entry('rejected'));
      return s;
    }),
    (e) => e.status === 409
  );
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 1);
  assert.equal(backend.state.tasks.length, 0);
  assert.deepEqual(await repo.local.read(), local);
  assert.match(repo.problem, /競合/);
  repo.close();
});

test('a lost write response retries the identical mutation ID and commits once', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  await repo.connect();
  backend.losePutResponse = true;
  const saved = await repo.mutate('add', (s) => {
    s.tasks.push(entry('once'));
    return s;
  });
  const writes = backend.calls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(backend.mutations.size, 1);
  assert.equal(saved.revision, 1);
  assert.equal(saved.tasks.length, 1);
  repo.close();
});

test('pending writes reject competing actions and release the lock after completion', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  await repo.connect();
  const gate = deferred();
  const entered = deferred();
  backend.beforeGet = async () => {
    entered.resolve();
    await gate.promise;
  };
  const write = repo.mutate('first', (s) => {
    s.tasks.push(entry('first'));
    return s;
  });
  await entered.promise;
  await assert.rejects(
    repo.mutate('second', (s) => s),
    /処理中/
  );
  await assert.rejects(repo.disconnect(), /処理中/);
  gate.resolve();
  await write;
  backend.beforeGet = null;
  await repo.mutate('later', (s) => {
    s.tasks.push(entry('later', 700));
    return s;
  });
  assert.equal(backend.state.tasks.length, 2);
  repo.close();
});

test('out-of-order shared reads do not regress the displayed or persisted revision', async () => {
  const f = fixture();
  await f.repo.open();
  await f.repo.connect();
  const gate = deferred();
  const entered = deferred();
  f.backend.beforeGet = async () => {
    entered.resolve();
    await gate.promise;
  };
  const old = f.repo.read();
  await entered.promise;
  f.backend.beforeGet = null;
  f.backend.state.revision = 3;
  f.backend.state.tasks = [entry('latest')];
  await f.repo.read();
  gate.resolve();
  assert.equal((await old).revision, 3);
  f.repo.close();
  f.backend.offline = true;
  const reopened = f.makeRepo();
  assert.equal((await reopened.open()).revision, 3);
  reopened.close();
});

test('a different time zone allows viewing but rejects edits and undo before sending writes', async () => {
  const { repo, backend } = fixture({ timeZone: 'America/New_York' });
  await repo.open();
  await repo.connect();
  assert.equal(repo.notificationsAllowed, false);
  assert.match(repo.problem, /閲覧のみ/);
  await assert.rejects(
    repo.mutate('edit', (s) => s),
    /タイムゾーン/
  );
  await assert.rejects(repo.undo(0), /タイムゾーン/);
  assert.equal(backend.calls.filter((c) => c.method !== 'GET').length, 0);
  repo.close();
});

test('a local read finishing after connection returns the active shared schedule', async () => {
  const { repo, backend } = fixture();
  backend.state.tasks = [entry('shared')];
  await repo.open();
  const localRead = repo.local.read.bind(repo.local);
  const gate = deferred();
  const entered = deferred();
  repo.local.read = async () => {
    const old = await localRead();
    entered.resolve();
    await gate.promise;
    return old;
  };
  const pending = repo.read();
  await entered.promise;
  await repo.connect();
  gate.resolve();
  assert.equal((await pending).tasks[0].id, 'shared');
  repo.close();
});

test('a remote read finishing after disconnect cannot replace a newer local edit', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  await repo.connect();
  const gate = deferred();
  const entered = deferred();
  backend.beforeGet = async () => {
    entered.resolve();
    await gate.promise;
  };
  const pending = repo.read();
  await entered.promise;
  backend.beforeGet = null;
  await repo.disconnect();
  await repo.mutate('local after disconnect', (s) => {
    s.tasks.push(entry('new-local'));
    return s;
  });
  gate.resolve();
  assert.equal((await pending).tasks[0].id, 'new-local');
  assert.equal(repo.sharedEnabled, false);
  repo.close();
});

test('failure to cache a successful server write still returns the saved data', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  await repo.connect();
  const run = repo.local.run.bind(repo.local);
  repo.local.run = (mode, action, name) =>
    run(
      mode,
      (store, result, fail) => {
        const put = store.put.bind(store);
        store.put = (value, key) => {
          if (key === 'shared-cache') throw new DOMException('Quota full', 'QuotaExceededError');
          return put(value, key);
        };
        action(store, result, fail);
      },
      name
    );
  const saved = await repo.mutate('save', (s) => {
    s.tasks.push(entry('saved'));
    return s;
  });
  assert.equal(saved.tasks[0].id, 'saved');
  assert.equal(backend.state.tasks[0].id, 'saved');
  assert.match(repo.saveStatus(), /共有先に保存済み.*控えを保存できません/);
  repo.close();
});

for (const kind of ['allDay', 'unscheduled'])
  test(`two lost responses and a manual retry after reload never duplicate a ${kind} task`, async () => {
    const f = fixture();
    await f.repo.open();
    await f.repo.connect();
    f.backend.lostWriteResponses = 2;
    await assert.rejects(
      f.repo.mutate('first save', (s) => {
        s.tasks.push(C.taskValue({ ...entry('first'), kind }, s.categories));
        return s;
      }),
      /接続できません/
    );
    const pending = await f.repo.pendingWrite();
    assert.equal(pending.body.state.tasks[0].id, 'first');
    f.repo.close();
    const repo = f.makeRepo();
    await repo.open();
    let repeated = false;
    await assert.rejects(
      repo.mutate('manual retry', (s) => {
        repeated = true;
        s.tasks.push(C.taskValue({ ...entry('duplicate'), kind }, s.categories));
        return s;
      }),
      (e) => e.code === 'PENDING_RESOLVED'
    );
    assert.equal(repeated, false);
    assert.equal(f.backend.state.tasks.length, 1);
    assert.equal(f.backend.mutations.size, 1);
    assert.equal(await repo.pendingWrite(), null);
    const writes = f.backend.calls.filter((c) => c.method === 'PUT');
    assert.equal(writes.length, 3);
    assert.ok(writes.every((c) => c.body.mutationId === pending.body.mutationId));
    repo.close();
  });

test('lost initialization responses resume the original import after restart', async () => {
  const f = fixture({ initialized: false });
  await f.repo.open();
  await f.repo.mutate('local', (s) => {
    s.tasks.push(entry('local'));
    return s;
  });
  f.backend.lostWriteResponses = 2;
  await assert.rejects(
    f.repo.connect({ importLocal: true, expectedRevision: 1 }),
    /接続できません/
  );
  assert.equal(f.repo.sharedEnabled, false);
  assert.equal(f.backend.initialized, true);
  f.repo.close();
  const repo = f.makeRepo();
  await repo.open();
  const shared = await repo.connect();
  assert.equal(shared.tasks[0].id, 'local');
  assert.equal(repo.sharedEnabled, true);
  assert.equal(f.backend.mutations.size, 1);
  assert.equal(await repo.pendingWrite(), null);
  repo.close();
});

test('lost undo responses are confirmed once before another operation or disconnect', async () => {
  const { repo, backend } = fixture();
  backend.state.tasks = [entry('old')];
  await repo.open();
  await repo.connect();
  backend.lostWriteResponses = 2;
  await assert.rejects(repo.undo(0), /接続できません/);
  const pending = await repo.pendingWrite();
  assert.equal(pending.path, '/api/undo');
  await assert.rejects(repo.disconnect(), (e) => e.code === 'PENDING_RESOLVED');
  assert.equal(repo.sharedEnabled, true);
  assert.equal(backend.state.revision, 1);
  assert.equal(backend.mutations.size, 1);
  assert.equal(await repo.pendingWrite(), null);
  repo.close();
});

test('authentication and server failures retain an uncertain write; a definitive rejection clears it', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  await repo.connect();
  backend.lostWriteResponses = 2;
  await assert.rejects(repo.mutate('save', (s) => s));
  const id = (await repo.pendingWrite()).body.mutationId;
  for (const status of [401, 500, 429]) {
    backend.status = status;
    await assert.rejects(
      repo.mutate('retry', () => {
        throw new Error('must not run');
      }),
      (e) => e.status === status
    );
    assert.equal((await repo.pendingWrite()).body.mutationId, id);
  }
  backend.status = 409;
  await assert.rejects(
    repo.mutate('retry', () => {
      throw new Error('must not run');
    }),
    (e) => e.status === 409
  );
  assert.equal(await repo.pendingWrite(), null);
  repo.close();
});

test('reservation failure prevents sending any write to the server', async () => {
  const { repo, backend } = fixture();
  await repo.open();
  await repo.connect();
  const run = repo.local.run.bind(repo.local);
  repo.local.run = (mode, ...args) =>
    mode === 'readwrite' ? Promise.reject(new Error('Disk full')) : run(mode, ...args);
  await assert.rejects(
    repo.mutate('save', (s) => s),
    /Disk full/
  );
  assert.equal(backend.calls.filter((c) => c.method !== 'GET').length, 0);
  repo.close();
});

test('two tabs cannot replace a pending operation with a different mutation', async () => {
  const f = fixture();
  await f.repo.open();
  await f.repo.connect();
  const second = f.makeRepo();
  await second.open();
  const gate = deferred();
  const entered = deferred();
  f.backend.beforePut = async () => {
    entered.resolve();
    await gate.promise;
  };
  const first = f.repo.mutate('first', (s) => {
    s.tasks.push(entry('first'));
    return s;
  });
  await entered.promise;
  let called = false;
  const other = second.mutate('other', (s) => {
    called = true;
    return s;
  });
  const rejected = assert.rejects(other, (e) => e.code === 'PENDING_RESOLVED');
  gate.resolve();
  await Promise.all([first, rejected]);
  assert.equal(called, false);
  assert.equal(f.backend.mutations.size, 1);
  const ids = new Set(
    f.backend.calls.filter((c) => c.method === 'PUT').map((c) => c.body.mutationId)
  );
  assert.equal(ids.size, 1);
  assert.equal(await f.repo.pendingWrite(), null);
  f.repo.close();
  second.close();
});

test('initialization and disconnect reject time zone changes before any write', async () => {
  const { repo, backend } = fixture({ initialized: false, timeZone: 'America/New_York' });
  await repo.open();
  const local = await repo.local.read();
  await assert.rejects(repo.connect({ importLocal: true, expectedRevision: 0 }), /タイムゾーン/);
  assert.equal(backend.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(await repo.pendingWrite(), null);
  backend.initialized = true;
  await repo.connect();
  await assert.rejects(repo.disconnect(), /タイムゾーン/);
  assert.deepEqual(await repo.local.read(), local);
  assert.equal(repo.sharedEnabled, true);
  repo.close();
});

test('a tab using the old local mode cannot read or write after another tab connects', async () => {
  const f = fixture();
  const old = f.makeRepo();
  await f.repo.open();
  await old.open();
  await f.repo.connect();
  await assert.rejects(old.read(), (e) => e.code === 'MODE_CHANGED');
  await assert.rejects(
    old.mutate('wrong local target', (s) => s),
    (e) => e.code === 'MODE_CHANGED'
  );
  assert.equal(old.sharedEnabled, false);
  assert.match(old.problem, /再読み込み/);
  assert.match(old.saveStatus(), /再読み込み/);
  assert.equal(old.notificationsAllowed, false);
  f.repo.close();
  old.close();
});

test('mode generations detect another tab switching away and back to the same mode', async () => {
  const f = fixture();
  const old = f.makeRepo();
  await f.repo.open();
  await old.open();
  await f.repo.connect();
  await f.repo.disconnect();
  assert.equal(f.preferences.has(S.MODE_KEY), false);
  await assert.rejects(
    old.mutate('stale local', (s) => s),
    (e) => e.code === 'MODE_CHANGED'
  );
  f.repo.close();
  old.close();
});

test('a restored server revision requires explicit reconnection and replaces the old persistent cache', async () => {
  const f = fixture();
  f.backend.state.revision = 100;
  f.backend.state.tasks = [entry('before-restore')];
  await f.repo.open();
  await f.repo.connect();
  f.backend.state.revision = 3;
  f.backend.state.tasks = [entry('restored')];
  assert.equal((await f.repo.read()).revision, 100);
  assert.match(f.repo.problem, /復元または置き換え/);
  assert.equal(f.repo.notificationsAllowed, false);
  await assert.rejects(
    f.repo.mutate('unsafe', (s) => s),
    /再読み込み/
  );
  await assert.rejects(f.repo.undo(100), /再読み込み/);
  await assert.rejects(f.repo.disconnect(), /再読み込み/);
  assert.equal(f.backend.calls.filter((c) => c.method !== 'GET').length, 0);
  const restored = await f.repo.connect();
  assert.equal(restored.revision, 3);
  assert.equal(restored.tasks[0].id, 'restored');
  assert.equal(f.repo.resetDetected, false);
  f.repo.close();
  f.backend.offline = true;
  const reopened = f.makeRepo();
  assert.equal((await reopened.open()).tasks[0].id, 'restored');
  reopened.close();
});
