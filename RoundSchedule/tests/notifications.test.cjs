const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const { NotificationManager } = require('../notifications.js');
function setup() {
  const state = C.initialState();
  state.settings = { ...state.settings, notifications: true, lead: 1 };
  state.tasks = [
    C.taskValue(
      {
        id: 't',
        name: 'test',
        date: '2026-09-08',
        endDate: '2026-09-08',
        startMin: 600,
        endMin: 660,
        categoryId: 'work',
      },
      state.categories
    ),
  ];
  let now = C.epoch('2026-09-08', 599),
    shown = 0;
  const claims = new Set(),
    timers = [];
  const repo = {
    read: async () => state,
    claimNotice: async (key) => {
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    releaseNotice: async (key) => claims.delete(key),
  };
  const opts = {
    clock: () => now,
    permission: () => 'granted',
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    show: async () => {
      shown++;
    },
  };
  return {
    state,
    repo,
    opts,
    timers,
    claims,
    get shown() {
      return shown;
    },
    set now(v) {
      now = v;
    },
  };
}
test('focus/reschedule and multiple managers only show one notification', async () => {
  const s = setup(),
    a = new NotificationManager(s.repo, s.opts),
    b = new NotificationManager(s.repo, s.opts),
    event = C.notificationCandidates(s.state, s.opts.clock())[0];
  await Promise.all([a.deliver(event), b.deliver(event)]);
  await a.deliver(event);
  assert.equal(s.shown, 1);
});
test('editing/deleting or disabling a scheduled task prevents stale delivery', async () => {
  const s = setup(),
    m = new NotificationManager(s.repo, s.opts),
    event = C.notificationCandidates(s.state, s.opts.clock())[0];
  s.state.tasks[0].notification = 'off';
  assert.equal(await m.deliver(event), false);
  s.state.tasks = [];
  assert.equal(await m.deliver(event), false);
  assert.equal(s.shown, 0);
});
test('failed display releases claim and can be retried', async () => {
  const s = setup(),
    event = C.notificationCandidates(s.state, s.opts.clock())[0];
  let calls = 0;
  const m = new NotificationManager(s.repo, {
    ...s.opts,
    show: async () => {
      if (!calls++) throw new Error('not ready');
    },
  });
  await assert.rejects(m.deliver(event), /not ready/);
  assert.equal(s.claims.size, 0);
  assert.equal(await m.deliver(event), true);
});
test('timer delay uses absolute seconds and old generations cannot fire', () => {
  const s = setup();
  s.now = C.epoch('2026-09-08', 590) + 45000;
  const m = new NotificationManager(s.repo, s.opts);
  m.refresh(s.state);
  assert.equal(s.timers[0].ms, 495000);
  m.stop();
  s.timers[0].fn();
  assert.equal(s.shown, 0);
});
