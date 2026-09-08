(function (root) {
  'use strict';
  function create({
    serviceWorker = root.navigator?.serviceWorker,
    fetch: fetchResource = root.fetch?.bind(root),
    baseURL = root.location?.href,
    currentVersion = null,
    beforeApply = () => {},
    onProgress = () => {},
    timeout = 20000,
    networkTimeout = 6000,
    versionTimeout = 1000,
    installTimeout = 10000,
    activationTimeout = 10000,
    MessageChannel: Channel = root.MessageChannel,
    setTimeout: later = root.setTimeout.bind(root),
    clearTimeout: clearLater = root.clearTimeout.bind(root),
  } = {}) {
    let pending = null;
    const validVersion = (version) =>
      typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version);
    function progress(message) {
      try {
        onProgress(message);
      } catch {
        /* Progress UI is advisory. */
      }
    }
    async function run() {
      if (!serviceWorker?.register) throw new Error('この環境ではアプリの更新機能を利用できません');
      if (!fetchResource) throw new Error('更新元へ接続できません');
      const workerURL = new URL('./ds-sw.js', baseURL).href;
      const releaseURL = new URL('./release.json', baseURL).href;
      const abort = new AbortController();
      const totalTimer = later(
        () =>
          abort.abort(
            new Error('更新の確認に時間がかかっています。接続を確認してもう一度お試しください')
          ),
        timeout
      );
      function bounded(promise, milliseconds, message) {
        return new Promise((resolve, reject) => {
          let finished = false;
          const timer = later(() => finish(reject, new Error(message)), milliseconds);
          const cancelled = () =>
            finish(reject, abort.signal.reason || new Error('更新を中止しました'));
          function finish(callback, value) {
            if (finished) return;
            finished = true;
            clearLater(timer);
            abort.signal.removeEventListener('abort', cancelled);
            callback(value);
          }
          abort.signal.addEventListener('abort', cancelled, { once: true });
          Promise.resolve(promise).then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error)
          );
          if (abort.signal.aborted) cancelled();
        });
      }
      function listen(target, type, callback) {
        target.addEventListener(type, callback);
        return () => target.removeEventListener(type, callback);
      }
      async function waitFor(inspect, subscribe, milliseconds, message) {
        let remove = () => {};
        try {
          return await bounded(
            new Promise((resolve, reject) => {
              const check = () => {
                try {
                  const result = inspect();
                  if (result) resolve(result);
                } catch (error) {
                  reject(error);
                }
              };
              remove = subscribe(check);
              check();
            }),
            milliseconds,
            message
          );
        } finally {
          remove();
        }
      }
      async function workerVersion(worker) {
        if (!worker?.postMessage || !Channel) return null;
        const channel = new Channel();
        try {
          return await bounded(
            new Promise((resolve, reject) => {
              channel.port1.onmessage = (event) => {
                if (validVersion(event.data?.version)) resolve(event.data.version);
              };
              channel.port1.start?.();
              try {
                worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
              } catch (error) {
                reject(error);
              }
            }),
            versionTimeout,
            'アプリの版を確認できませんでした'
          );
        } catch (error) {
          if (abort.signal.aborted) throw error;
          return null;
        } finally {
          channel.port1.onmessage = null;
          channel.port1.close();
          channel.port2.close();
        }
      }
      async function prepareApply() {
        const allowed = await bounded(
          Promise.resolve().then(beforeApply),
          timeout,
          '更新前の保存が完了しませんでした'
        );
        if (allowed === false)
          throw new Error('編集中の内容を保存してから、もう一度更新してください');
      }
      async function waitForControl(registration, worker, activate = false) {
        await waitFor(
          () => {
            if (worker.state === 'redundant')
              throw new Error('別の更新が見つかりました。もう一度確認してください');
            return (
              worker.state === 'activated' &&
              registration.active === worker &&
              serviceWorker.controller === worker
            );
          },
          (check) => {
            const removeState = listen(worker, 'statechange', check);
            const removeController = listen(serviceWorker, 'controllerchange', check);
            if (activate && worker.state !== 'activated' && worker.state !== 'activating') {
              try {
                worker.postMessage({ type: 'SKIP_WAITING' });
              } catch (error) {
                removeState();
                removeController();
                throw error;
              }
            }
            return () => {
              removeState();
              removeController();
            };
          },
          activationTimeout,
          '新版の適用が完了しませんでした。もう一度更新を確認してください'
        );
      }
      async function applyWaiting(registration, worker) {
        progress('新しい版を適用中…');
        await prepareApply();
        await waitForControl(registration, worker, true);
        const version = await workerVersion(worker);
        return { status: 'reload', version };
      }
      async function release() {
        try {
          return await bounded(
            (async () => {
              const response = await fetchResource(releaseURL, {
                cache: 'no-store',
                signal: abort.signal,
                headers: { Accept: 'application/json' },
              });
              if (!response.ok)
                throw new Error(`配信元の版情報を取得できませんでした（HTTP ${response.status}）`);
              const data = await response.json();
              if (!validVersion(data?.version))
                throw new Error(
                  '配信元の版情報が正しくありません。サーバーの更新状況を確認してください'
                );
              return data.version;
            })(),
            networkTimeout,
            '更新元への接続に時間がかかっています。サーバーの起動と通信を確認してください'
          );
        } catch (error) {
          if (abort.signal.aborted) throw error;
          if (error instanceof TypeError)
            throw new Error('更新元へ接続できません。サーバーが起動しているか確認してください');
          throw error;
        }
      }
      try {
        progress('更新を確認中…');
        let registration, registrationFailure;
        try {
          registration = await bounded(
            serviceWorker.register(workerURL, { updateViaCache: 'none' }),
            networkTimeout,
            '更新元への接続に時間がかかっています'
          );
        } catch (error) {
          registrationFailure = error;
          if (abort.signal.aborted) throw error;
          if (serviceWorker.getRegistration)
            registration = await bounded(
              serviceWorker.getRegistration(baseURL),
              networkTimeout,
              '登録済みアプリの確認に時間がかかっています'
            );
        }
        if (!registration)
          throw new Error('更新元へ接続できません。サーバーを起動してからもう一度お試しください');
        // A downloaded release can be applied even if the server is now unavailable.
        if (registration.waiting) return await applyWaiting(registration, registration.waiting);
        if (registrationFailure)
          throw new Error('更新元へ接続できません。サーバーを起動してからもう一度お試しください');
        const latest = release().then(
          (version) => ({ version }),
          (error) => ({ error })
        );
        try {
          await bounded(
            registration.update(),
            networkTimeout,
            '更新元への接続に時間がかかっています。もう一度お試しください'
          );
        } catch (error) {
          if (registration.waiting && !abort.signal.aborted)
            return await applyWaiting(registration, registration.waiting);
          if (abort.signal.aborted) throw error;
          throw new Error('更新ファイルを取得できません。サーバーの起動と通信を確認してください');
        }
        const installing = registration.installing;
        if (installing) {
          progress('新しい版を取得中…');
          await waitFor(
            () => {
              if (installing.state === 'redundant')
                throw new Error(
                  '新版の取得に失敗しました。配信ファイルと通信状態を確認してください'
                );
              return installing.state === 'installed' || installing.state === 'activated';
            },
            (check) => listen(installing, 'statechange', check),
            installTimeout,
            '新版の取得に時間がかかっています。もう一度お試しください'
          );
        }
        if (registration.waiting) return await applyWaiting(registration, registration.waiting);
        const info = await latest;
        if (info.error) throw info.error;
        const active = registration.active;
        if (!active) throw new Error('アプリの更新準備ができませんでした。もう一度お試しください');
        await waitForControl(registration, active);
        const activeVersion = await workerVersion(active);
        if (activeVersion !== info.version)
          throw new Error(
            '配信元と保存済みアプリの版が一致しません。サーバーの更新を確認してもう一度お試しください'
          );
        if (!currentVersion || currentVersion !== activeVersion) {
          progress('新しい版を表示中…');
          await prepareApply();
          return { status: 'reload', version: activeVersion };
        }
        return { status: 'current', version: activeVersion };
      } finally {
        clearLater(totalTimer);
        abort.abort(new Error('更新の確認が終了しました'));
      }
    }
    return {
      check() {
        if (!pending)
          pending = run().finally(() => {
            pending = null;
          });
        return pending;
      },
      get busy() {
        return !!pending;
      },
    };
  }
  const API = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.ScheduleUpdates = API;
})(globalThis);
