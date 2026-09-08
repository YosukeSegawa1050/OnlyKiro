'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const C = require('../core.js');

class ScheduleError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function invalid(message) {
  return new ScheduleError(400, 'invalid_request', message);
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stable(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function checkRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw invalid('expectedRevision を指定してください');
}
function checkedState(raw) {
  if (
    !raw ||
    !Array.isArray(raw.tasks) ||
    raw.tasks.length > 10000 ||
    !Array.isArray(raw.categories) ||
    raw.categories.length > 1000 ||
    !Array.isArray(raw.templates) ||
    raw.templates.length > 1000
  )
    throw invalid('予定データの形式または件数が上限を超えています');
  try {
    return C.strictState(raw);
  } catch (error) {
    throw invalid(error.message);
  }
}
const scheduleFields = (t) =>
  stable({
    date: t.date,
    endDate: t.endDate,
    startMin: t.startMin,
    endMin: t.endMin,
    kind: t.kind,
    active: t.status !== 'cancelled',
    repeat: t.repeat,
  });
function checkChanges(before, after) {
  const old = new Map(before.tasks.map((t) => [t.id, t]));
  for (const task of after.tasks) {
    const previous = old.get(task.id);
    if (previous && scheduleFields(previous) === scheduleFields(task)) continue;
    if (
      previous?.repeat &&
      task.repeat &&
      previous.repeat.exceptions.every((d) => task.repeat.exceptions.includes(d)) &&
      scheduleFields({ ...previous, repeat: { ...previous.repeat, exceptions: [] } }) ===
        scheduleFields({ ...task, repeat: { ...task.repeat, exceptions: [] } })
    )
      continue;
    try {
      C.assertAvailable(after.tasks, task, task.id);
      // A repeated multi-day task must not overlap its own next occurrence.
      if (task.kind === 'timed' && task.status !== 'cancelled' && task.repeat) {
        const occurrences = C.occurrences([task], task.date, C.addDays(task.repeat.until, 7));
        for (let i = 1; i < occurrences.length; i++)
          if (C.interval(occurrences[i - 1])[1] > C.interval(occurrences[i])[0])
            throw new Error('繰り返し予定が次の回の時間と重なっています');
      }
    } catch (error) {
      throw new ScheduleError(409, 'overlap', error.message);
    }
  }
}

function createStore({
  dataDir = path.join(__dirname, '..', '.schedule-data'),
  timeZone = process.env.SCHEDULE_TIME_ZONE || process.env.SCHEDULE_TIMEZONE || 'Asia/Tokyo',
} = {}) {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw invalid('SCHEDULE_TIME_ZONE は有効な IANA タイムゾーンにしてください');
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'schedule.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schedule_state (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS schedule_history (id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_mutations (mutation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO schedule_state (id,state,initialized) VALUES (1,?,0)').run(
    JSON.stringify(C.initialState())
  );
  db.prepare('INSERT OR IGNORE INTO schedule_metadata (key,value) VALUES (?,?)').run(
    'timeZone',
    timeZone
  );
  const storedZone = db
    .prepare('SELECT value FROM schedule_metadata WHERE key=?')
    .get('timeZone').value;
  if (storedZone !== timeZone) {
    db.close();
    throw invalid(
      '保存済みのタイムゾーンと設定が異なります。元の SCHEDULE_TIME_ZONE を指定してください'
    );
  }
  function getSnapshot() {
    const row = db.prepare('SELECT state,initialized FROM schedule_state WHERE id=1').get();
    return {
      state: checkedState(JSON.parse(row.state)),
      initialized: !!row.initialized,
      timeZone,
      undoLabel:
        db.prepare('SELECT label FROM schedule_history ORDER BY id DESC LIMIT 1').get()?.label ||
        null,
    };
  }
  function mutate({
    mutationId,
    operation,
    payload,
    expectedRevision,
    initializeOnly = false,
    label = '予定の変更',
    transform,
    undo = false,
  }) {
    if (typeof mutationId !== 'string' || !/^[\w.:-]{8,150}$/.test(mutationId))
      throw invalid('mutationId / requestId は8〜150文字の一意なIDにしてください');
    if (expectedRevision !== undefined) checkRevision(expectedRevision);
    const fingerprint = crypto
      .createHash('sha256')
      .update(stable({ operation, payload }))
      .digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = db
        .prepare('SELECT fingerprint,result FROM schedule_mutations WHERE mutation_id=?')
        .get(mutationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new ScheduleError(
            409,
            'idempotency_conflict',
            '同じ操作IDが別の内容に使用されています'
          );
        db.exec('COMMIT');
        return JSON.parse(receipt.result);
      }
      const before = getSnapshot();
      if (initializeOnly && before.initialized)
        throw new ScheduleError(
          409,
          'already_initialized',
          '共有データはすでに初期化されています。最新データを読み込んでください'
        );
      if (expectedRevision !== undefined && expectedRevision !== before.state.revision)
        throw new ScheduleError(
          409,
          'revision_conflict',
          '別の操作で予定が変更されました。最新データを読み込み直してください'
        );
      let next;
      if (undo) {
        const history = db
          .prepare('SELECT id,state FROM schedule_history ORDER BY id DESC LIMIT 1')
          .get();
        if (!history) throw new ScheduleError(409, 'nothing_to_undo', '元に戻せる操作がありません');
        next = checkedState(JSON.parse(history.state));
        db.prepare('DELETE FROM schedule_history WHERE id=?').run(history.id);
      } else {
        next = checkedState(transform(C.copy(before.state)));
        // Initial import may contain pre-existing conflicts. Later operations may not create new ones.
        if (!initializeOnly) checkChanges(before.state, next);
        db.prepare('INSERT INTO schedule_history (state,label) VALUES (?,?)').run(
          JSON.stringify(before.state),
          String(label).slice(0, 160)
        );
        db.exec(
          'DELETE FROM schedule_history WHERE id NOT IN (SELECT id FROM schedule_history ORDER BY id DESC LIMIT 30)'
        );
      }
      next.revision = before.state.revision + 1;
      next.updatedAt = new Date().toISOString();
      db.prepare('UPDATE schedule_state SET state=?,initialized=1 WHERE id=1').run(
        JSON.stringify(next)
      );
      const result = getSnapshot();
      db.prepare(
        'INSERT INTO schedule_mutations (mutation_id,fingerprint,result,created_at) VALUES (?,?,?,?)'
      ).run(mutationId, fingerprint, JSON.stringify(result), next.updatedAt);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    db,
    timeZone,
    getSnapshot,
    mutate,
    replace({ state, expectedRevision, label = '予定の変更', mutationId, initializeOnly = false }) {
      checkRevision(expectedRevision);
      return mutate({
        mutationId,
        operation: initializeOnly ? 'initialize' : 'replace',
        payload: { state, expectedRevision, label },
        expectedRevision,
        label,
        initializeOnly,
        transform: () => state,
      });
    },
    undo({ expectedRevision, mutationId }) {
      checkRevision(expectedRevision);
      return mutate({
        mutationId,
        operation: 'undo',
        payload: { expectedRevision },
        expectedRevision,
        undo: true,
      });
    },
    close() {
      db.close();
    },
  };
}
module.exports = { createStore, ScheduleError, invalid, checkChanges };
