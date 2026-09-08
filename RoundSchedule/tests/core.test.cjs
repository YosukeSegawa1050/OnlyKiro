const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const cats = C.initialState().categories;
function task(overrides = {}) {
  return C.taskValue(
    {
      id: 't',
      name: '予定',
      date: '2026-09-08',
      endDate: '2026-09-08',
      startMin: 540,
      endMin: 600,
      categoryId: 'work',
      ...overrides,
    },
    cats
  );
}
test('local dates: leap years, rollover, invalid dates and half-open adjacent intervals', () => {
  assert.equal(C.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(C.validDate('2026-02-30'), false);
  assert.equal(C.minutes('24:00'), NaN);
  assert.equal(C.conflicts([task()], task({ id: 'b', startMin: 600, endMin: 660 })).length, 0);
});
test('overnight tasks intersect their actual days, not the previous morning', () => {
  const night = task({ startMin: 1380, endMin: 360, endDate: '2026-09-09' });
  assert.equal(C.conflicts([night], task({ id: 'early', startMin: 60, endMin: 120 })).length, 0);
  assert.equal(
    C.conflicts(
      [night],
      task({ id: 'next', date: '2026-09-09', endDate: '2026-09-09', startMin: 60, endMin: 120 })
    ).length,
    1
  );
  assert.deepEqual(
    C.daySegments([night], '2026-09-08').map((o) => [o.clipStart, o.clipEnd]),
    [[1380, 1440]]
  );
  assert.deepEqual(
    C.daySegments([night], '2026-09-09').map((o) => [o.clipStart, o.clipEnd]),
    [[0, 360]]
  );
});
test('end at midnight has no zero-length fragment on the next day', () => {
  const t = task({ startMin: 1380, endMin: 0, endDate: '2026-09-09' });
  assert.equal(C.daySegments([t], '2026-09-09').length, 0);
});
test('invalid or ambiguous durations cannot be saved', () => {
  assert.throws(() => task({ startMin: 600, endMin: 540 }), /終了/);
  assert.throws(() => task({ startMin: 540, endMin: 540 }), /終了/);
  assert.throws(() => task({ endDate: '2026-09-20' }), /7日/);
  assert.throws(() => task({ startMin: NaN }), /時刻/);
});
test('recurrence weekdays, until and per-occurrence exceptions', () => {
  const t = task({ repeat: { days: [2, 4], until: '2026-09-17', exceptions: ['2026-09-10'] } });
  assert.deepEqual(
    C.occurrences([t], '2026-09-01', '2026-09-30').map((o) => o.date),
    ['2026-09-08', '2026-09-15', '2026-09-17']
  );
  assert.equal(
    C.conflicts([t], task({ id: 'b', date: '2026-09-15', endDate: '2026-09-15' })).length,
    1
  );
  assert.equal(
    C.conflicts([t], task({ id: 'b', date: '2026-09-10', endDate: '2026-09-10' })).length,
    0
  );
});
test('recurring overnight carry-over survives week and month boundaries', () => {
  const t = task({
    date: '2026-08-31',
    endDate: '2026-09-01',
    startMin: 1380,
    endMin: 360,
    repeat: { days: [1], until: '2026-09-14', exceptions: [] },
  });
  assert.deepEqual(
    C.daySegments([t], '2026-09-15').map((o) => [o.date, o.clipStart, o.clipEnd]),
    [['2026-09-14', 0, 360]]
  );
});
test('repeating candidate checks all its dates before it is committed', () => {
  const old = task({ date: '2026-09-15', endDate: '2026-09-15' }),
    candidate = task({ id: 'r', repeat: { days: [2], until: '2026-09-22', exceptions: [] } });
  assert.throws(() => C.assertAvailable([old], candidate), /重なって/);
});
test('done time stays occupied; cancelled, all-day and unscheduled are not time conflicts', () => {
  assert.equal(C.conflicts([task({ status: 'done' })], task({ id: 'b' })).length, 1);
  for (const mod of [{ status: 'cancelled' }, { kind: 'allDay' }, { kind: 'unscheduled' }])
    assert.equal(C.conflicts([task(mod)], task({ id: 'b' })).length, 0);
});
test('summary measures union, not double-counted overlaps in legacy data', () => {
  const ts = [task(), task({ id: 'b', startMin: 570, endMin: 630 })];
  assert.equal(C.summary(ts, '2026-09-08').occupied, 90);
  assert.equal(C.summary(ts, '2026-09-08').free, 1350);
});
test('next free interval accounts for previous-day carry-over and exact boundaries', () => {
  const night = task({ date: '2026-09-07', endDate: '2026-09-08', startMin: 1380, endMin: 360 });
  assert.equal(C.nextFree([night, task()], '2026-09-08', 60, 300), 360);
  assert.equal(C.nextFree([task({ startMin: 0, endMin: 1439 })], '2026-09-08', 30), null);
});
test('legacy migration normalizes once and retains literal names', () => {
  const legacy = {
    tasks: [{ id: 'x', name: '<b>予定</b>', startMin: 1380, endMin: 360, categoryId: 'sleep' }],
    categories: cats,
  };
  const n = C.normalize(legacy, { today: '2026-09-08' });
  assert.equal(n.issues.length, 0);
  assert.equal(n.state.tasks[0].endDate, '2026-09-09');
  assert.equal(n.state.tasks[0].name, '<b>予定</b>');
  assert.equal(C.normalize(n.state, { today: '2026-09-09' }).state.tasks[0].date, '2026-09-08');
});
test('malformed arrays, references, IDs, URLs, colors and future schemas are rejected', () => {
  assert.throws(() => C.normalize({ tasks: [], categories: {} }));
  assert.throws(() => C.normalize({ ...C.initialState(), schemaVersion: 999 }));
  assert.throws(() => task({ url: 'javascript:alert(1)' }));
  const bad = C.normalize({
    ...C.initialState(),
    tasks: [task(), task(), { id: 'bad', name: 'bad', categoryId: 'missing' }],
    categories: [...cats, { id: 'bad', name: 'bad', color: 'red;' }],
  });
  assert.equal(bad.issues.length, 3);
  assert.equal(bad.state.tasks.length, 1);
});
test('template append never silently replaces and replace does not delete a carry-over', () => {
  const s = C.initialState();
  s.tasks = [
    task(),
    task({ id: 'night', date: '2026-09-07', endDate: '2026-09-08', startMin: 1380, endMin: 360 }),
  ];
  const template = { tasks: [C.templateEntry(task({ startMin: 600, endMin: 660 }))] };
  assert.equal(C.applyTemplate(s, template, '2026-09-08', 'append').tasks.length, 3);
  const replaced = C.applyTemplate(s, template, '2026-09-08', 'replace');
  assert.equal(replaced.tasks.length, 2);
  assert.ok(replaced.tasks.some((t) => t.id === 'night'));
  assert.equal(s.tasks.length, 2);
});
test('template collision fails atomically and recurrence replacement adds only that date exception', () => {
  const s = C.initialState();
  s.tasks = [task({ repeat: { days: [2], until: '2026-09-22', exceptions: [] } })];
  const template = { tasks: [C.templateEntry(task())] };
  assert.throws(() => C.applyTemplate(s, template, '2026-09-08', 'append'));
  const result = C.applyTemplate(s, template, '2026-09-08', 'replace');
  assert.deepEqual(result.tasks[0].repeat.exceptions, ['2026-09-08']);
  assert.equal(C.occurrences(result.tasks, '2026-09-15').length, 1);
  assert.deepEqual(s.tasks[0].repeat.exceptions, []);
});
test('notifications calculate exact seconds and cross midnight', () => {
  const s = C.initialState();
  s.settings = { ...s.settings, notifications: true, lead: 1 };
  s.tasks = [task({ startMin: 600, endMin: 660 })];
  const now = C.epoch('2026-09-08', 590) + 45000,
    n = C.notificationCandidates(s, now)[0];
  assert.equal(n.due, C.epoch('2026-09-08', 599));
  s.tasks = [task({ date: '2026-09-09', endDate: '2026-09-09', startMin: 0, endMin: 60 })];
  assert.equal(
    C.notificationCandidates(s, C.epoch('2026-09-08', 1439))[0].due,
    C.epoch('2026-09-08', 1439)
  );
});
test('notification cancellation, explicit lead, zero lead and delayed timer grace', () => {
  const s = C.initialState();
  s.settings.notifications = true;
  s.tasks = [task({ notification: 0 })];
  const at = C.epoch('2026-09-08', 540);
  assert.equal(C.notificationCandidates(s, at + 30).length, 1);
  assert.equal(C.notificationCandidates(s, at + 61000).length, 0);
  s.tasks[0].status = 'done';
  assert.equal(C.notificationCandidates(s, at).length, 0);
  s.tasks[0].status = 'planned';
  s.tasks[0].notification = 'off';
  assert.equal(C.notificationCandidates(s, at).length, 0);
});
test('ICS round-trip escapes multiline Japanese, timed and all-day, folds octets', () => {
  const source = [
    task({ name: '予定,;\\'.repeat(12), notes: '一行目\n二行目', location: '自宅' }),
    task({ id: 'all', kind: 'allDay', date: '2026-09-09', endDate: '2026-09-10' }),
  ];
  const text = C.exportICS(source, '2026-09-08', '2026-09-10');
  assert.ok(text.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));
  const restored = C.importICS(text, 'work', cats);
  assert.equal(restored[0].name, source[0].name);
  assert.equal(restored[0].notes, source[0].notes);
  assert.equal(restored[1].kind, 'allDay');
  assert.equal(restored[1].endDate, '2026-09-10');
});
test('ICS rejects recurrence/TZID rather than silently dropping information', () => {
  const base = C.exportICS([task()], '2026-09-08', '2026-09-08');
  assert.throws(
    () => C.importICS(base.replace('SUMMARY:', 'RRULE:FREQ=DAILY\r\nSUMMARY:'), 'work', cats),
    /繰り返し/
  );
  assert.throws(
    () => C.importICS(base.replace('DTSTART:', 'DTSTART;TZID=Asia/Tokyo:'), 'work', cats),
    /TZID/
  );
});
test('ICS recurrence export expands bounded occurrences', () => {
  const text = C.exportICS(
    [task({ repeat: { days: [2], until: '2026-09-22', exceptions: [] } })],
    '2026-09-08',
    '2026-09-15'
  );
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 2);
});
test('ICS invalid UTC dates and seconds do not silently move or truncate events', () => {
  const base = C.exportICS([task()], '2026-09-08', '2026-09-08');
  assert.throws(
    () =>
      C.importICS(
        base.replace('DTSTART:20260908T090000', 'DTSTART:20260230T090000Z'),
        'work',
        cats
      ),
    /不正/
  );
  assert.throws(
    () =>
      C.importICS(
        base.replace('DTSTART:20260908T090000', 'DTSTART:20260908T240000Z'),
        'work',
        cats
      ),
    /不正/
  );
  assert.throws(
    () =>
      C.importICS(
        base.replace('DTSTART:20260908T090000', 'DTSTART:20260908T090030Z'),
        'work',
        cats
      ),
    /秒単位/
  );
});
