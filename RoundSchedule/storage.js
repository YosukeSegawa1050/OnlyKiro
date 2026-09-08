(function (root) {
  'use strict';
  const C =
    typeof module !== 'undefined' && module.exports ? require('./core.js') : root.ScheduleCore;
  class RecoveryError extends Error {
    constructor(message, raw, candidate = null, issues = []) {
      super(message);
      this.name = 'RecoveryError';
      this.raw = raw;
      this.candidate = candidate;
      this.issues = issues;
    }
  }
  class Repository {
    constructor({
      indexedDB = root.indexedDB,
      legacyStorage = root.localStorage,
      name = 'daily-schedule-v2',
    } = {}) {
      this.factory = indexedDB;
      this.legacy = legacyStorage;
      this.name = name;
      this.db = null;
    }
    async open() {
      if (!this.factory)
        throw new Error('この環境では保存機能が利用できません。通常のブラウザーで開いてください。');
      this.db = await new Promise((resolve, reject) => {
        const r = this.factory.open(this.name, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('data');
          r.result.createObjectStore('notices');
        };
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('他のタブを閉じてから再読み込みしてください'));
        r.onsuccess = () => {
          r.result.onversionchange = () => r.result.close();
          resolve(r.result);
        };
      });
      return this.run('readwrite', (store, setResult, fail) => {
        const request = store.get('state');
        request.onsuccess = () => {
          try {
            if (request.result) {
              let checked;
              try {
                checked = C.normalize(request.result);
              } catch (e) {
                throw new RecoveryError(e.message, JSON.stringify(request.result));
              }
              if (checked.issues.length)
                throw new RecoveryError(
                  '保存データの一部を読み込めません',
                  JSON.stringify(request.result),
                  checked.state,
                  checked.issues
                );
              setResult(checked.state);
              return;
            }
            let raw;
            try {
              raw = this.legacy?.getItem('daily_schedule_data');
            } catch (e) {
              throw new RecoveryError('旧データの読み込みが許可されていません', null);
            }
            let state = C.initialState();
            if (raw) {
              let parsed;
              try {
                parsed = JSON.parse(raw);
              } catch {
                throw new RecoveryError(
                  '旧データを読み込めません。元データを退避して復旧してください。',
                  raw
                );
              }
              let n;
              try {
                n = C.normalize(parsed);
              } catch (e) {
                throw new RecoveryError(e.message, raw);
              }
              if (n.issues.length)
                throw new RecoveryError('旧データの一部を読み込めません', raw, n.state, n.issues);
              state = n.state;
              store.put({ raw, at: new Date().toISOString() }, 'migration-backup');
            }
            state.updatedAt = new Date().toISOString();
            store.put(state, 'state');
            setResult(state);
          } catch (e) {
            fail(e);
          }
        };
      });
    }
    run(mode, action, storeName = 'data') {
      return new Promise((resolve, reject) => {
        let result, reason, tx;
        try {
          tx = this.db.transaction(storeName, mode);
        } catch (e) {
          reject(e);
          return;
        }
        const fail = (e) => {
          reason = e;
          try {
            tx.abort();
          } catch {
            reject(e);
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () =>
          reject(
            reason ||
              tx.error ||
              new Error('保存できませんでした。内容を保持したまま再試行できます。')
          );
        tx.onerror = () => {};
        try {
          action(
            tx.objectStore(storeName),
            (value) => {
              result = value;
            },
            fail
          );
        } catch (e) {
          fail(e);
        }
      });
    }
    read() {
      return this.run('readonly', (store, result, fail) => {
        const r = store.get('state');
        r.onsuccess = () => {
          try {
            if (!r.result) throw new Error('保存データがありません');
            const parsed = C.normalize(r.result);
            if (parsed.issues.length)
              throw new RecoveryError(
                '保存データの確認が必要です',
                JSON.stringify(r.result),
                parsed.state,
                parsed.issues
              );
            result(parsed.state);
          } catch (e) {
            fail(
              e instanceof RecoveryError
                ? e
                : new RecoveryError(e.message, JSON.stringify(r.result))
            );
          }
        };
      });
    }
    // The read, conflict check, history, and write live in ONE IndexedDB transaction.
    // Mutators are deliberately synchronous: awaiting inside them can close a transaction.
    mutate(label, mutator, { expectedRevision = null, history = true, archive = false } = {}) {
      return this.run('readwrite', (store, result, fail) => {
        const r = store.get('state');
        r.onsuccess = () => {
          try {
            const current = C.strictState(r.result);
            if (expectedRevision !== null && current.revision !== expectedRevision)
              throw new Error(
                '別のタブで内容が変わりました。最新の内容を確認してやり直してください。'
              );
            const candidate = mutator(C.copy(current));
            if (candidate?.then) throw new Error('保存処理は同期的に指定してください');
            const next = C.strictState(candidate);
            next.revision = current.revision + 1;
            next.updatedAt = new Date().toISOString();
            if (history) store.put({ state: current, revision: next.revision, label }, 'undo');
            if (archive)
              store.put({ raw: JSON.stringify(current), at: next.updatedAt }, 'restore-backup');
            store.put(next, 'state');
            result(next);
          } catch (e) {
            fail(e);
          }
        };
      });
    }
    undo(expectedRevision = null) {
      return this.run('readwrite', (store, result, fail) => {
        const stateRequest = store.get('state');
        stateRequest.onsuccess = () => {
          const u = store.get('undo');
          u.onsuccess = () => {
            try {
              if (!u.result) throw new Error('取り消せる操作がありません');
              if (expectedRevision !== null && stateRequest.result.revision !== expectedRevision)
                throw new Error(
                  '別のタブで変更がありました。最新の内容を確認してから取り消してください。'
                );
              if (stateRequest.result.revision !== u.result.revision)
                throw new Error('その後の変更があるため取り消せません');
              const restored = C.strictState(u.result.state);
              restored.revision = stateRequest.result.revision + 1;
              restored.updatedAt = new Date().toISOString();
              store.put(restored, 'state');
              store.delete('undo');
              result(restored);
            } catch (e) {
              fail(e);
            }
          };
        };
      });
    }
    recover(candidate, raw) {
      return this.run('readwrite', (store, result, fail) => {
        const r = store.get('state');
        r.onsuccess = () => {
          try {
            // Do not overwrite a valid database initialized by another tab during recovery.
            if (r.result) {
              let good = false;
              try {
                C.strictState(r.result);
                good = true;
              } catch {}
              if (good) throw new Error('別のタブで復旧済みです。再読み込みしてください。');
            }
            const next = C.strictState(candidate);
            next.revision++;
            next.updatedAt = new Date().toISOString();
            store.put({ raw, at: next.updatedAt }, 'recovery-backup');
            store.put(next, 'state');
            result(next);
          } catch (e) {
            fail(e);
          }
        };
      });
    }
    archive() {
      return this.run('readonly', (store, result) => {
        const r = store.get('restore-backup');
        r.onsuccess = () => {
          if (r.result) {
            result(r.result);
            return;
          }
          const q = store.get('migration-backup');
          q.onsuccess = () => {
            if (q.result) {
              result(q.result);
              return;
            }
            const z = store.get('recovery-backup');
            z.onsuccess = () => result(z.result || null);
          };
        };
      });
    }
    claimNotice(key, now) {
      return this.run(
        'readwrite',
        (store, result) => {
          const r = store.get(key);
          r.onsuccess = () => {
            if (r.result && now - r.result.at < 7 * 86400000) {
              result(false);
              return;
            }
            store.put({ at: now }, key);
            result(true);
          };
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (c) {
              if (now - c.value.at > 7 * 86400000) c.delete();
              c.continue();
            }
          };
        },
        'notices'
      );
    }
    releaseNotice(key) {
      return this.run(
        'readwrite',
        (store, result) => {
          store.delete(key);
          result();
        },
        'notices'
      );
    }
    close() {
      this.db?.close();
    }
  }
  const API = { Repository, RecoveryError };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.ScheduleStorage = API;
})(globalThis);
