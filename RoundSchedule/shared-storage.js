(function (root) {
  'use strict';
  const C =
    typeof module !== 'undefined' && module.exports ? require('./core.js') : root.ScheduleCore;
  const S =
    typeof module !== 'undefined' && module.exports
      ? require('./storage.js')
      : root.ScheduleStorage;
  const MODE_KEY = 'daily-schedule-shared-enabled';
  const GENERATION_KEY = 'daily-schedule-shared-generation';
  const PENDING_KEY = 'shared-pending-write';
  const RESTORED =
    '共有先が復元または置き換えられました。「ChatGPT連携」から共有予定を再読み込みしてください（閲覧のみ）';
  class ConnectionError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'ConnectionError';
      this.status = status;
    }
  }
  class Repository {
    constructor(options = {}) {
      this.local = options.local || new S.Repository(options);
      this.fetch = options.fetch || root.fetch?.bind(root);
      this.preferences = options.preferences || root.localStorage;
      this.timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      this.sharedState = null;
      this.serverTimeZone = null;
      this.problem = '';
      this.listeners = new Set();
      this.sharedEnabled = false;
      this.busy = false;
      this.modeEpoch = 0;
      this.modeGeneration = null;
      this.resetDetected = false;
      try {
        this.sharedEnabled = this.preferences?.getItem(MODE_KEY) === 'true';
        this.modeGeneration = this.preferences?.getItem(GENERATION_KEY) || null;
      } catch {}
    }
    get notificationsAllowed() {
      return !this.problem && (!this.sharedEnabled || this.timeZone === this.serverTimeZone);
    }
    onStatus(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    report(message = '') {
      this.problem = message;
      for (const listener of this.listeners) listener();
    }
    saveStatus() {
      if (!this.sharedEnabled) return this.problem;
      if (this.problem) return `共有予定 · ${this.problem}`;
      const time = this.sharedState?.updatedAt;
      return `共有先に保存済み${time ? ' · ' + new Date(time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : ''}`;
    }
    assertMode() {
      if (!this.preferences) return;
      const enabled = this.preferences.getItem(MODE_KEY) === 'true';
      const generation = this.preferences.getItem(GENERATION_KEY) || null;
      if (enabled !== this.sharedEnabled || generation !== this.modeGeneration) {
        const error = new ConnectionError(
          '別の画面で保存先が変更されました。この画面を再読み込みしてから操作してください。'
        );
        error.code = 'MODE_CHANGED';
        this.report(error.message);
        throw error;
      }
    }
    setMode(enabled) {
      this.assertMode();
      const generation = C.uid();
      this.preferences?.setItem(GENERATION_KEY, generation);
      if (enabled) this.preferences?.setItem(MODE_KEY, 'true');
      else this.preferences?.removeItem(MODE_KEY);
      this.sharedEnabled = enabled;
      this.modeGeneration = this.preferences ? generation : null;
      this.modeEpoch++;
    }
    assertWritable() {
      this.assertMode();
      if (this.resetDetected) throw new ConnectionError(RESTORED);
    }
    checkSnapshot(snapshot, knownRevision = this.sharedState?.revision) {
      if (
        Number.isInteger(knownRevision) &&
        (!snapshot.initialized || snapshot.state?.revision < knownRevision)
      ) {
        this.resetDetected = true;
        this.report(RESTORED);
        throw new ConnectionError(RESTORED);
      }
    }
    checkTimeZone(snapshot) {
      if (snapshot.timeZone !== this.timeZone)
        throw new Error(`端末のタイムゾーンを${snapshot.timeZone}に合わせてから編集してください`);
    }
    async pendingWrite() {
      const pending = await this.local.run('readonly', (store, result) => {
        const request = store.get(PENDING_KEY);
        request.onsuccess = () => result(request.result);
      });
      if (!pending) return null;
      const methods = { '/api/state': 'PUT', '/api/initialize': 'PUT', '/api/undo': 'POST' };
      if (
        methods[pending.path] !== pending.method ||
        typeof pending.body?.mutationId !== 'string' ||
        !pending.body.mutationId ||
        !Number.isInteger(pending.body.expectedRevision)
      )
        throw new ConnectionError(
          '未確定の保存記録を確認できません。端末のデータを削除せずに確認してください。'
        );
      return pending;
    }
    async clearPending(mutationId) {
      return this.local.run('readwrite', (store, result, fail) => {
        const request = store.get(PENDING_KEY);
        request.onsuccess = () => {
          try {
            if (request.result?.body.mutationId === mutationId) store.delete(PENDING_KEY);
            result();
          } catch (error) {
            fail(error);
          }
        };
      });
    }
    async sendPending(pending) {
      this.assertMode();
      let snapshot;
      try {
        snapshot = await this.request(pending.path, {
          method: pending.method,
          body: pending.body,
          retry: true,
        });
      } catch (error) {
        // Authentication, throttling, server errors and lost responses do not prove a write failed.
        const rejected =
          error.status >= 400 && error.status < 500 && ![401, 408, 425, 429].includes(error.status);
        if (rejected) await this.clearPending(pending.body.mutationId);
        this.report(
          rejected
            ? '保存は適用されませんでした · 最新の予定を確認してください'
            : '保存結果の確認待ち · 次の保存で前回の結果を確認します'
        );
        throw error;
      }
      const state = await this.accept(snapshot, { force: pending.path === '/api/initialize' });
      try {
        await this.clearPending(pending.body.mutationId);
      } catch {
        this.report('共有先に保存済み · 端末の保存確認記録を更新できません');
      }
      this.assertMode();
      return { state, snapshot, path: pending.path };
    }
    priorSaved() {
      const error = new ConnectionError(
        '前回の保存は完了しています。今回の操作は実行していません。一覧を確認し、この入力を閉じてください。変更する場合は保存済みの予定を開いてください。'
      );
      error.code = 'PENDING_RESOLVED';
      this.report('前回の保存を確認しました · 一覧を確認してください');
      return error;
    }
    async settlePending({ initialize = false } = {}) {
      const pending = await this.pendingWrite();
      if (!pending) return null;
      const saved = await this.sendPending(pending);
      if (initialize && pending.path === '/api/initialize') return saved;
      throw this.priorSaved();
    }
    async writeRemote(path, method, body) {
      this.assertWritable();
      const pending = { path, method, body: C.copy(body), createdAt: new Date().toISOString() };
      const reserved = await this.local.run('readwrite', (store, result, fail) => {
        const request = store.get(PENDING_KEY);
        request.onsuccess = () => {
          try {
            this.assertWritable();
            if (request.result) return result(false);
            store.put(pending, PENDING_KEY);
            result(true);
          } catch (error) {
            fail(error);
          }
        };
      });
      if (!reserved) {
        await this.settlePending();
        // Another tab may already have cleared its receipt after our reservation check.
        throw this.priorSaved();
      }
      return (await this.sendPending(pending)).state;
    }
    async request(path, { method = 'GET', body, retry = false } = {}) {
      if (!this.fetch) throw new ConnectionError('サーバーに接続できません');
      let lastError;
      for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await this.fetch(path, {
            method,
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
            headers:
              body === undefined
                ? { Accept: 'application/json' }
                : { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          let data;
          try {
            data = await response.json();
          } catch {
            throw new ConnectionError('接続先が予定の共有サーバーではありません', response.status);
          }
          if (!response.ok) {
            const message =
              response.status === 401
                ? path === '/auth/login'
                  ? 'ログインできませんでした。パスフレーズを確認してください。'
                  : '再ログインしてください（未保存の入力は保持されています）'
                : data.message ||
                  data.error_description ||
                  data.error?.message ||
                  (typeof data.error === 'string' ? data.error : '共有先へ保存できませんでした');
            throw new ConnectionError(message, response.status);
          }
          return data;
        } catch (error) {
          lastError =
            error instanceof ConnectionError
              ? error
              : new ConnectionError('接続できません。通信状態を確認して再試行してください');
          if (lastError.status) throw lastError;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError;
    }
    async open() {
      const local = await this.local.open();
      this.assertMode();
      if (!this.sharedEnabled) return local;
      const cached = await this.local.run('readonly', (store, result) => {
        const request = store.get('shared-cache');
        request.onsuccess = () => result(request.result);
      });
      if (cached) {
        this.sharedState = C.strictState(cached.state);
        this.serverTimeZone = cached.timeZone;
      }
      return this.read();
    }
    async accept(snapshot, { force = false } = {}) {
      if (!snapshot.initialized)
        throw new ConnectionError('共有予定が未設定です。「ChatGPT連携」から接続し直してください');
      const state = C.strictState(snapshot.state);
      if (force) this.resetDetected = false;
      if (force || !this.sharedState || state.revision >= this.sharedState.revision) {
        this.sharedState = state;
        this.serverTimeZone = snapshot.timeZone;
        try {
          await this.local.run('readwrite', (store, result, fail) => {
            const request = store.get('shared-cache');
            request.onsuccess = () => {
              try {
                this.assertMode();
                if (force || !request.result || request.result.state.revision <= state.revision)
                  store.put({ state, timeZone: snapshot.timeZone }, 'shared-cache');
                result();
              } catch (error) {
                fail(error);
              }
            };
          });
        } catch {
          this.report('共有先に保存済み · 端末への控えを保存できません');
          return C.copy(this.sharedState);
        }
      }
      this.report(
        this.resetDetected
          ? RESTORED
          : this.timeZone !== this.serverTimeZone
            ? `端末のタイムゾーンを${this.serverTimeZone}に合わせてください（閲覧のみ）`
            : ''
      );
      return C.copy(this.sharedState);
    }
    async read() {
      this.assertMode();
      const epoch = this.modeEpoch;
      if (!this.sharedEnabled) {
        const state = await this.local.read();
        this.assertMode();
        return epoch === this.modeEpoch ? state : this.read();
      }
      try {
        const knownRevision = this.sharedState?.revision;
        const snapshot = await this.request('/api/state');
        if (epoch !== this.modeEpoch) return this.read();
        this.assertMode();
        this.checkSnapshot(snapshot, knownRevision);
        const state = await this.accept(snapshot);
        this.assertMode();
        return epoch === this.modeEpoch ? state : this.read();
      } catch (error) {
        if (epoch !== this.modeEpoch) return this.read();
        if (error.code === 'MODE_CHANGED') throw error;
        this.report(
          this.resetDetected
            ? RESTORED
            : error.status === 401
              ? '再ログインが必要です · 閲覧のみ'
              : '接続待ち · 保存済みの内容を表示（閲覧のみ）'
        );
        if (this.sharedState) return C.copy(this.sharedState);
        throw error;
      }
    }
    async exclusive(action) {
      if (this.busy) throw new Error('保存または接続の処理中です。少し待ってから操作してください');
      this.assertMode();
      this.busy = true;
      try {
        return await action();
      } finally {
        this.busy = false;
      }
    }
    async mutate(label, mutator, options = {}) {
      return this.exclusive(async () => {
        await this.settlePending();
        this.assertWritable();
        if (!this.sharedEnabled)
          return this.local.mutate(
            label,
            (s) => {
              this.assertWritable();
              return mutator(s);
            },
            options
          );
        try {
          const knownRevision = this.sharedState?.revision;
          const snapshot = await this.request('/api/state');
          this.assertWritable();
          this.checkSnapshot(snapshot, knownRevision);
          if (!snapshot.initialized) throw new Error('先に共有予定を設定してください');
          this.checkTimeZone(snapshot);
          const current = C.strictState(snapshot.state);
          if (options.expectedRevision != null && current.revision !== options.expectedRevision)
            throw new ConnectionError(
              '他の画面またはChatGPTで変更されました。最新の予定を確認してやり直してください。',
              409
            );
          const candidate = mutator(C.copy(current));
          if (candidate?.then) throw new Error('保存処理は同期的に指定してください');
          const state = C.strictState(candidate);
          return await this.writeRemote('/api/state', 'PUT', {
            state,
            expectedRevision: current.revision,
            label,
            mutationId: C.uid(),
          });
        } catch (error) {
          if (!error.code && !this.resetDetected && !(await this.pendingWrite()))
            this.report(
              error.status === 409
                ? '変更が競合しました · 最新の予定を確認してください'
                : '保存結果を確認できません · 再接続後に確認してください'
            );
          throw error;
        }
      });
    }
    async undo(expectedRevision = null) {
      return this.exclusive(async () => {
        await this.settlePending();
        this.assertWritable();
        if (!this.sharedEnabled) return this.local.undo(expectedRevision);
        if (!Number.isInteger(expectedRevision))
          throw new Error('最新の予定を確認してから取り消してください');
        try {
          const knownRevision = this.sharedState?.revision;
          const snapshot = await this.request('/api/state');
          this.assertWritable();
          this.checkSnapshot(snapshot, knownRevision);
          this.checkTimeZone(snapshot);
          if (snapshot.state.revision !== expectedRevision)
            throw new ConnectionError(
              '他の画面またはChatGPTで変更されました。最新の予定を確認してやり直してください。',
              409
            );
          return await this.writeRemote('/api/undo', 'POST', {
            expectedRevision,
            mutationId: C.uid(),
          });
        } catch (error) {
          if (!error.code && !this.resetDetected && !(await this.pendingWrite()))
            this.report('取り消し結果を確認できません · 最新の予定を確認してください');
          throw error;
        }
      });
    }
    async connect({ importLocal = false, expectedRevision } = {}) {
      return this.exclusive(async () => {
        const resumed = await this.settlePending({ initialize: true });
        if (resumed) {
          this.setMode(true);
          this.report(this.problem);
          return resumed.state;
        }
        let snapshot = await this.request('/api/state');
        this.assertMode();
        let state;
        if (!snapshot.initialized) {
          if (!importLocal) throw new Error('この端末の予定を共有する操作を選んでください');
          this.checkTimeZone(snapshot);
          const local = await this.local.read();
          if (expectedRevision !== undefined && local.revision !== expectedRevision)
            throw new Error('この端末の予定が変わりました。件数を確認し直してください');
          // This is an explicit new connection after a server restore.
          this.resetDetected = false;
          state = await this.writeRemote('/api/initialize', 'PUT', {
            state: local,
            expectedRevision: snapshot.state.revision,
            label: 'この端末の予定を共有',
            mutationId: C.uid(),
          });
        } else if (importLocal) {
          throw new ConnectionError(
            '共有先に予定があります。共有予定を開いてください。端末の予定はそのまま残っています。',
            409
          );
        }
        // Store the snapshot before enabling remote mode, so offline restart has a usable copy.
        if (!state) state = await this.accept(snapshot, { force: true });
        this.setMode(true);
        this.report(this.problem);
        return state;
      });
    }
    async disconnect() {
      return this.exclusive(async () => {
        await this.settlePending();
        this.assertWritable();
        // Preserve the shared snapshot locally before switching. Do not revert to the old pre-sync schedule.
        const knownRevision = this.sharedState?.revision;
        const snapshot = await this.request('/api/state');
        this.assertWritable();
        this.checkSnapshot(snapshot, knownRevision);
        this.checkTimeZone(snapshot);
        if (!snapshot.initialized) throw new Error('共有先の予定を確認できません');
        const current = await this.local.read();
        const next = await this.local.mutate(
          '共有予定をこの端末へ保存',
          () => {
            this.assertWritable();
            return C.strictState(snapshot.state);
          },
          { expectedRevision: current.revision, archive: true }
        );
        this.setMode(false);
        this.report();
        return next;
      });
    }
    recover(...args) {
      return this.local.recover(...args);
    }
    archive(...args) {
      return this.local.archive(...args);
    }
    claimNotice(...args) {
      return this.local.claimNotice(...args);
    }
    releaseNotice(...args) {
      return this.local.releaseNotice(...args);
    }
    close() {
      this.local.close();
    }
  }
  const API = { Repository, ConnectionError, MODE_KEY, GENERATION_KEY, PENDING_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.ScheduleShared = API;
})(globalThis);
