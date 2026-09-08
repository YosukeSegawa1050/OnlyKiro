'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../core.js');
const { createStore } = require('../server/store.cjs');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-server-store-'));
  const stores = [];
  const open = (options = {}) => {
    const s = createStore({ dataDir, ...options });
    stores.push(s);
    return s;
  };
  const close = (s) => {
    s.close();
    stores.splice(stores.indexOf(s), 1);
  };
  t.after(() => {
    for (const s of stores) s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { open, close };
}
function task(id, date = '2026-09-08', startMin = 600, endMin = 660, extra = {}) {
  return C.taskValue(
    { id, name: id, date, endDate: date, startMin, endMin, categoryId: 'work', ...extra },
    C.initialState().categories
  );
}
function replace(s, changes, id, extra = {}) {
  const { state } = s.getSnapshot();
  Object.assign(state, changes);
  return s.replace({ state, expectedRevision: state.revision, mutationId: id, ...extra });
}
test('SQLite state, initialization and undo label survive restart', (t) => {
  const f = fixture(t);
  let s = f.open();
  assert.equal(s.getSnapshot().initialized, false);
  replace(s, { tasks: [task('first')] }, 'initial-01', { initializeOnly: true, label: '初回共有' });
  f.close(s);
  s = f.open();
  const snapshot = s.getSnapshot();
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.state.revision, 1);
  assert.equal(snapshot.state.tasks[0].id, 'first');
  assert.equal(snapshot.undoLabel, '初回共有');
});
test('compare and swap prevents stale writes across independent database connections', (t) => {
  const f = fixture(t),
    a = f.open(),
    b = f.open();
  const stale = b.getSnapshot().state;
  replace(a, { tasks: [task('first')] }, 'first-001');
  assert.throws(() => b.replace({ state: stale, expectedRevision: 0, mutationId: 'second-01' }), {
    code: 'revision_conflict',
    status: 409,
  });
  assert.equal(b.getSnapshot().state.tasks[0].id, 'first');
});
test('idempotency survives restart, returns original result, and rejects key reuse', (t) => {
  const f = fixture(t);
  let s = f.open();
  const state = C.initialState();
  state.tasks.push(task('first'));
  const args = { state, expectedRevision: 0, mutationId: 'retry-001' };
  const result = s.replace(args);
  replace(s, { tasks: [] }, 'later-001');
  f.close(s);
  s = f.open();
  assert.deepEqual(s.replace(args), result);
  assert.equal(s.getSnapshot().state.revision, 2);
  assert.throws(() => s.replace({ ...args, label: 'different' }), { code: 'idempotency_conflict' });
});
test('invalid data and overlaps rollback state, undo and mutation receipt atomically', (t) => {
  const s = fixture(t).open();
  replace(s, { tasks: [task('first')] }, 'setup-001');
  const before = s.getSnapshot();
  assert.throws(() => replace(s, { tasks: [task('first'), task('second')] }, 'invalid01'), {
    code: 'overlap',
  });
  assert.deepEqual(s.getSnapshot(), before);
  assert.equal(
    s.db
      .prepare('SELECT count(*) AS n FROM schedule_mutations WHERE mutation_id=?')
      .get('invalid01').n,
    0
  );
  assert.throws(() => replace(s, { categories: [] }, 'invalid02'), { code: 'invalid_request' });
  assert.deepEqual(s.getSnapshot(), before);
});
test('new overnight conflicts are rejected while touching endpoints are allowed', (t) => {
  const s = fixture(t).open();
  replace(
    s,
    { tasks: [task('night', '2026-09-08', 1380, 360, { endDate: '2026-09-09' })] },
    'night-001'
  );
  assert.throws(
    () =>
      replace(
        s,
        { tasks: [...s.getSnapshot().state.tasks, task('morning', '2026-09-09', 300, 400)] },
        'night-002'
      ),
    { code: 'overlap' }
  );
  replace(
    s,
    { tasks: [...s.getSnapshot().state.tasks, task('morning', '2026-09-09', 360, 420)] },
    'night-003'
  );
  assert.equal(s.getSnapshot().state.tasks.length, 2);
});
test('existing imported overlap survives unrelated edits but no new overlap is allowed', (t) => {
  const s = fixture(t).open();
  replace(s, { tasks: [task('old-a'), task('old-b')] }, 'import001', { initializeOnly: true });
  const tasks = s.getSnapshot().state.tasks;
  tasks[0].notes = '説明のみ変更';
  replace(s, { tasks }, 'notes-001');
  replace(s, { tasks: [...tasks, task('new-safe', '2026-09-08', 700, 760)] }, 'safe-0001');
  assert.throws(() => replace(s, { tasks: [...tasks, task('new-conflict')] }, 'bad-00001'), {
    code: 'overlap',
  });
});
test('undo restores contents with monotonically increasing revision and persistent receipt', (t) => {
  const f = fixture(t);
  let s = f.open();
  replace(s, { tasks: [task('first')] }, 'first-001');
  replace(s, { tasks: [] }, 'delete001');
  const args = { expectedRevision: 2, mutationId: 'undo-0001' };
  const undo = s.undo(args);
  assert.equal(undo.state.revision, 3);
  assert.equal(undo.state.tasks.length, 1);
  f.close(s);
  s = f.open();
  assert.deepEqual(s.undo(args), undo);
  s.undo({ expectedRevision: 3, mutationId: 'undo-0002' });
  assert.equal(s.getSnapshot().initialized, true);
  assert.throws(() => replace(s, { tasks: [] }, 'reinit001', { initializeOnly: true }), {
    code: 'already_initialized',
  });
});
test('timezone cannot silently reinterpret an existing database', (t) => {
  const f = fixture(t);
  f.open();
  assert.throws(() => f.open({ timeZone: 'Europe/London' }), { code: 'invalid_request' });
});
test('repeated multi-day tasks cannot overlap their own occurrences', (t) => {
  const s = fixture(t).open();
  const repeating = task('repeat', '2026-09-08', 600, 660, {
    endDate: '2026-09-09',
    repeat: { days: [0, 1, 2, 3, 4, 5, 6], until: '2026-09-12', exceptions: [] },
  });
  assert.throws(() => replace(s, { tasks: [repeating] }, 'repeat001'), { code: 'overlap' });
});
test('removing a repeated occurrence preserves unrelated legacy conflicts', (t) => {
  const s = fixture(t).open();
  const repeating = task('repeat', '2026-09-08', 600, 660, {
    repeat: { days: [0, 1, 2, 3, 4, 5, 6], until: '2026-09-12', exceptions: [] },
  });
  replace(s, { tasks: [repeating, task('old-conflict')] }, 'import001', { initializeOnly: true });
  const tasks = s.getSnapshot().state.tasks;
  tasks[0].repeat.exceptions.push('2026-09-10');
  replace(s, { tasks }, 'exclude01');
  assert.equal(s.getSnapshot().state.revision, 2);
});
