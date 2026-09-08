const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const C = require('../core.js');
const { Repository, RecoveryError } = require('../storage.js');
const legacy = { getItem: () => null };
function entry(id) {
  return C.taskValue(
    {
      id,
      name: id,
      date: '2026-09-08',
      endDate: '2026-09-08',
      startMin: 540,
      endMin: 600,
      categoryId: 'work',
    },
    C.initialState().categories
  );
}
test('simultaneous tabs serialize read-modify-write without losing either addition', async () => {
  const indexedDB = new IDBFactory(),
    a = new Repository({ indexedDB, legacyStorage: legacy }),
    b = new Repository({ indexedDB, legacyStorage: legacy });
  await Promise.all([a.open(), b.open()]);
  await Promise.all([
    a.mutate('add A', (s) => {
      s.tasks.push(entry('A'));
      return s;
    }),
    b.mutate('add B', (s) => {
      s.tasks.push(entry('B'));
      return s;
    }),
  ]);
  assert.deepEqual(
    (await a.read()).tasks.map((t) => t.id),
    ['A', 'B']
  );
  assert.equal((await b.read()).revision, 2);
  a.close();
  b.close();
});
test('failed candidate write leaves persistent state and history unchanged; retry works', async () => {
  const r = new Repository({ indexedDB: new IDBFactory(), legacyStorage: legacy });
  await r.open();
  const before = await r.read();
  await assert.rejects(
    r.mutate('bad', (s) => {
      s.tasks.push(entry('new'));
      throw new Error('QuotaExceededError');
    }),
    /Quota/
  );
  assert.deepEqual(await r.read(), before);
  await r.mutate('retry', (s) => {
    s.tasks.push(entry('new'));
    return s;
  });
  assert.equal((await r.read()).tasks.length, 1);
  r.close();
});
test('transaction abort on actual put error does not commit partial mutations', async () => {
  const r = new Repository({ indexedDB: new IDBFactory(), legacyStorage: legacy });
  await r.open();
  const original = r.db.transaction.bind(r.db);
  r.db.transaction = (...args) => {
    const tx = original(...args),
      objectStore = tx.objectStore.bind(tx);
    tx.objectStore = (name) => {
      const store = objectStore(name);
      store.put = () => {
        throw new DOMException('Disk full', 'QuotaExceededError');
      };
      return store;
    };
    return tx;
  };
  await assert.rejects(
    r.mutate('add', (s) => {
      s.tasks.push(entry('a'));
      return s;
    }),
    /Disk full/
  );
  r.db.transaction = original;
  assert.equal((await r.read()).tasks.length, 0);
  r.close();
});
test('strict revision checks prevent stale destructive imports; undo is atomic', async () => {
  const r = new Repository({ indexedDB: new IDBFactory(), legacyStorage: legacy });
  await r.open();
  await r.mutate('add', (s) => {
    s.tasks.push(entry('a'));
    return s;
  });
  await assert.rejects(
    r.mutate('replace', () => C.initialState(), { expectedRevision: 0 }),
    /別のタブ/
  );
  assert.equal((await r.read()).tasks.length, 1);
  const undo = await r.undo();
  assert.equal(undo.tasks.length, 0);
  assert.equal(undo.revision, 2);
  await assert.rejects(r.undo(), /取り消せる/);
  r.close();
});
test('legacy migration is durable and raw original remains archived', async () => {
  const indexedDB = new IDBFactory(),
    raw = JSON.stringify({
      categories: C.initialState().categories,
      tasks: [{ id: 'old', name: 'old', startMin: 1380, endMin: 360, categoryId: 'sleep' }],
    });
  const r = new Repository({ indexedDB, legacyStorage: { getItem: () => raw } });
  const first = await r.open();
  assert.equal(first.tasks.length, 1);
  assert.equal((await r.archive()).raw, raw);
  r.close();
  const next = new Repository({ indexedDB, legacyStorage: { getItem: () => '{broken' } });
  assert.equal((await next.open()).tasks[0].date, first.tasks[0].date);
  next.close();
});
test('corrupt legacy data blocks initialization, can be exported and explicitly recovered', async () => {
  const r = new Repository({
    indexedDB: new IDBFactory(),
    legacyStorage: { getItem: () => '{broken' },
  });
  await assert.rejects(r.open(), (e) => e instanceof RecoveryError && e.raw === '{broken');
  await r.recover(C.initialState(), '{broken');
  assert.equal((await r.read()).tasks.length, 0);
  assert.equal((await r.archive()).raw, '{broken');
  r.close();
});
test('partially invalid legacy data is not silently imported', async () => {
  const raw = JSON.stringify({ ...C.initialState(), tasks: [entry('good'), { id: 'bad' }] }),
    r = new Repository({ indexedDB: new IDBFactory(), legacyStorage: { getItem: () => raw } });
  await assert.rejects(r.open(), (e) => e.candidate.tasks.length === 1 && e.issues.length === 1);
  r.close();
});
test('concurrent recovery cannot overwrite another tabs successful recovery', async () => {
  const indexedDB = new IDBFactory(),
    a = new Repository({ indexedDB, legacyStorage: { getItem: () => '{' } }),
    b = new Repository({ indexedDB, legacyStorage: { getItem: () => '{' } });
  await assert.rejects(a.open());
  await assert.rejects(b.open());
  await a.recover({ ...C.initialState(), tasks: [entry('A')] }, '{');
  await assert.rejects(b.recover(C.initialState(), '{'), /復旧済み/);
  assert.equal((await a.read()).tasks.length, 1);
  a.close();
  b.close();
});
test('notification claims are mutually exclusive across tabs and can retry on display error', async () => {
  const indexedDB = new IDBFactory(),
    a = new Repository({ indexedDB, legacyStorage: legacy }),
    b = new Repository({ indexedDB, legacyStorage: legacy });
  await a.open();
  await b.open();
  assert.deepEqual(await Promise.all([a.claimNotice('same', 100), b.claimNotice('same', 100)]), [
    true,
    false,
  ]);
  await a.releaseNotice('same');
  assert.equal(await b.claimNotice('same', 200), true);
  a.close();
  b.close();
});
test('restore archives full previous state beyond the undo operation', async () => {
  const r = new Repository({ indexedDB: new IDBFactory(), legacyStorage: legacy });
  await r.open();
  await r.mutate('add', (s) => {
    s.tasks.push(entry('original'));
    return s;
  });
  await r.mutate('import', () => C.initialState(), { archive: true });
  await r.mutate('settings', (s) => {
    s.settings.theme = 'dark';
    return s;
  });
  assert.equal(JSON.parse((await r.archive()).raw).tasks[0].id, 'original');
  r.close();
});
test('undo cannot discard an unseen update from another tab', async () => {
  const r = new Repository({ indexedDB: new IDBFactory(), legacyStorage: legacy });
  await r.open();
  await r.mutate('one', (s) => {
    s.tasks.push(entry('one'));
    return s;
  });
  const seen = 1;
  await r.mutate('two', (s) => {
    s.tasks.push(entry('two'));
    return s;
  });
  await assert.rejects(r.undo(seen), /別のタブ/);
  assert.equal((await r.read()).tasks.length, 2);
  r.close();
});
