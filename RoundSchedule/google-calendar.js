(function (root) {
  'use strict';
  const C =
    typeof module !== 'undefined' && module.exports ? require('./core.js') : root.ScheduleCore;
  const PREFIX = 'gcal:';
  const KEY = 'daily-schedule-google-calendar';
  const API = 'https://www.googleapis.com/calendar/v3';
  const SCOPE =
    'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

  const isGoogleTask = (task) => typeof task?.id === 'string' && task.id.startsWith(PREFIX);
  const supported = (task) => task && ['timed', 'allDay'].includes(task.kind) && !task.repeat;
  const trim = (value, length) =>
    Array.from(value || '')
      .slice(0, length)
      .join('');
  const localDateTime = (date, minute) => new Date(C.epoch(date, minute)).toISOString();

  function eventBody(task, localId = null) {
    if (!supported(task))
      throw new Error('Googleへ保存できるのは繰り返しのない日時付き・終日の予定です');
    const body = {
      summary: task.name,
      description: task.notes || '',
      location: task.location || '',
      start:
        task.kind === 'allDay'
          ? { date: task.date }
          : { dateTime: localDateTime(task.date, task.startMin) },
      end:
        task.kind === 'allDay'
          ? { date: C.addDays(task.endDate, 1) }
          : { dateTime: localDateTime(task.endDate, task.endMin) },
    };
    if (localId) body.extendedProperties = { private: { roundScheduleId: localId } };
    return body;
  }

  function eventTask(event, id, categories, previous = null) {
    if (!event?.id || !event.start || !event.end || event.status === 'cancelled') return null;
    const allDay = !!event.start.date;
    let date,
      endDate,
      startMin = 0,
      endMin = 0;
    if (allDay) {
      if (!event.end.date) return null;
      date = event.start.date;
      try {
        endDate = C.addDays(event.end.date, -1);
      } catch {
        return null;
      }
    } else {
      const start = new Date(event.start.dateTime);
      const end = new Date(event.end.dateTime);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
      date = C.dateKey(start);
      endDate = C.dateKey(end);
      startMin = start.getHours() * 60 + start.getMinutes();
      endMin = end.getHours() * 60 + end.getMinutes();
    }
    try {
      return C.taskValue(
        {
          id,
          name: trim(event.summary || '無題の予定', 80),
          date,
          endDate,
          startMin,
          endMin,
          kind: allDay ? 'allDay' : 'timed',
          categoryId: categories.some((c) => c.id === previous?.categoryId)
            ? previous.categoryId
            : categories[0].id,
          notes: trim(event.description, 2000),
          location: trim(event.location, 200),
          url: previous?.url || '',
          status: previous?.status || 'planned',
          notification: previous?.notification ?? 'default',
        },
        categories
      );
    } catch {
      return null;
    }
  }

  async function taskId(calendarId, eventId, cryptoApi = root.crypto) {
    if (!cryptoApi?.subtle) throw new Error('Google連携には安全なブラウザー環境が必要です');
    const bytes = new TextEncoder().encode(`${calendarId}\n${eventId}`);
    const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes));
    return PREFIX + [...digest.slice(0, 20)].map((n) => n.toString(16).padStart(2, '0')).join('');
  }

  class Connection {
    constructor({
      fetch = root.fetch?.bind(root),
      storage = root.localStorage,
      crypto = root.crypto,
    } = {}) {
      this.fetch = fetch;
      this.storage = storage;
      this.crypto = crypto;
      this.token = '';
      this.events = new Map();
      this.localIds = new Set();
      this.syncQueue = Promise.resolve();
      this.clientId = '';
      this.calendarId = '';
      this.ready = !!root.google?.accounts?.oauth2;
      this.loading = null;
      try {
        const saved = JSON.parse(storage?.getItem(KEY) || '{}');
        this.clientId = saved.clientId || '';
        this.calendarId = saved.calendarId || '';
      } catch {}
    }
    get connected() {
      return !!(this.token && this.calendarId);
    }
    configure(clientId, calendarId = this.calendarId) {
      this.clientId = clientId;
      this.calendarId = calendarId;
      this.storage?.setItem(KEY, JSON.stringify({ clientId, calendarId }));
    }
    prepare() {
      if (this.ready || root.google?.accounts?.oauth2) {
        this.ready = true;
        return Promise.resolve();
      }
      if (!this.loading)
        this.loading = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://accounts.google.com/gsi/client';
          script.async = true;
          script.onload = () => {
            this.ready = true;
            resolve();
          };
          script.onerror = () => reject(new Error('Google認証画面を読み込めませんでした'));
          document.head.append(script);
        }).catch((error) => {
          this.loading = null;
          throw error;
        });
      return this.loading;
    }
    async authorize(clientId = this.clientId) {
      if (!/^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientId))
        throw new Error('Googleのウェブアプリ用クライアントIDを入力してください');
      if (!this.ready) throw new Error('Google認証の読み込みを待ってから接続してください');
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Google認証が完了しませんでした。もう一度接続してください')),
          120000
        );
        const done = (fn, value) => {
          clearTimeout(timeout);
          fn(value);
        };
        const client = root.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: (response) => {
            if (!response?.access_token)
              return done(
                reject,
                new Error(response?.error || 'Googleへの接続が許可されませんでした')
              );
            if (!root.google.accounts.oauth2.hasGrantedAllScopes(response, ...SCOPE.split(' ')))
              return done(reject, new Error('カレンダーの閲覧・編集権限を両方許可してください'));
            done(resolve, response);
          },
          error_callback: (error) =>
            done(reject, new Error(error?.type || 'Google認証画面を開けませんでした')),
        });
        client.requestAccessToken();
      });
      this.token = result.access_token;
      this.events.clear();
      this.localIds.clear();
      this.configure(clientId, '');
    }
    async request(path, { method = 'GET', body, etag } = {}) {
      if (!this.token) throw new Error('Googleに接続してください');
      const response = await this.fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(etag ? { 'If-Match': etag } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) this.token = '';
      if (!response.ok) {
        if (response.status === 412)
          throw new Error('Google側で予定が変更されました。同期してから開き直してください');
        if (response.status === 401)
          throw new Error('Googleへの接続が切れました。再接続してください');
        let message = '';
        try {
          message = (await response.json()).error?.message || '';
        } catch {}
        const error = new Error(
          `Googleカレンダーへの通信に失敗しました（${response.status}）${message ? `: ${message}` : ''}`
        );
        error.status = response.status;
        throw error;
      }
      return response.status === 204 ? null : response.json();
    }
    async calendars() {
      const items = [];
      let page;
      do {
        const query = new URLSearchParams({ maxResults: '250' });
        if (page) query.set('pageToken', page);
        const result = await this.request(`/users/me/calendarList?${query}`);
        items.push(
          ...(result.items || []).filter((c) => ['owner', 'writer'].includes(c.accessRole))
        );
        page = result.nextPageToken;
      } while (page);
      return items;
    }
    async listEvents() {
      if (!this.calendarId) throw new Error('同期先のカレンダーを選択してください');
      const path = `/calendars/${encodeURIComponent(this.calendarId)}/events`;
      const pages = async (parameters) => {
        const items = [];
        let page;
        do {
          const query = new URLSearchParams({
            showDeleted: 'false',
            maxResults: '2500',
            ...parameters,
          });
          if (page) query.set('pageToken', page);
          const result = await this.request(`${path}?${query}`);
          items.push(...(result.items || []));
          if (items.length > 20000) throw new Error('予定が多すぎるため同期を中止しました');
          page = result.nextPageToken;
        } while (page);
        return items;
      };
      const base = await pages({ singleEvents: 'false' });
      const normal = base.filter((event) => !event.recurrence && !event.recurringEventId);
      if (!base.some((event) => event.recurrence)) return normal;
      const now = new Date();
      const first = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      const last = new Date(now.getFullYear() + 2, now.getMonth() + 1, 1);
      const instances = await pages({
        singleEvents: 'true',
        timeMin: first.toISOString(),
        timeMax: last.toISOString(),
      });
      return [...normal, ...instances.filter((event) => event.recurringEventId)];
    }
    sync(repo, metadata = null) {
      const work = this.syncQueue.then(() => this.syncNow(repo, metadata));
      this.syncQueue = work.catch(() => {});
      return work;
    }
    async syncNow(repo, metadata = null) {
      if (repo.sharedEnabled)
        throw new Error('先に「ChatGPT連携」で端末内の予定へ切り替えてください');
      const events = await this.listEvents();
      const mapped = await Promise.all(
        events.map(async (event) => ({
          event,
          id: await taskId(this.calendarId, event.id, this.crypto),
        }))
      );
      mapped.sort((a, b) => a.id.localeCompare(b.id));
      const current = await repo.read();
      const byId = new Map(current.tasks.map((task) => [task.id, task]));
      const previousFor = (event, id, old) => {
        const localId = event.extendedProperties?.private?.roundScheduleId;
        if (metadata && (metadata.id === id || metadata.id === localId)) return metadata;
        return old.get(id) || old.get(localId);
      };
      const nextTasks = mapped
        .map(({ event, id }) =>
          eventTask(event, id, current.categories, previousFor(event, id, byId))
        )
        .filter(Boolean);
      const validIds = new Set(nextTasks.map((task) => task.id));
      const markerIds = new Set(
        mapped
          .filter(({ id }) => validIds.has(id))
          .map(({ event }) => event.extendedProperties?.private?.roundScheduleId)
          .filter(Boolean)
      );
      const localTasks = current.tasks.filter(
        (task) => !isGoogleTask(task) && !markerIds.has(task.id)
      );
      const changed =
        JSON.stringify(current.tasks) !== JSON.stringify([...localTasks, ...nextTasks]);
      const next = changed
        ? await repo.mutate(
            'Googleカレンダーと同期',
            (state) => {
              const old = new Map(state.tasks.map((task) => [task.id, task]));
              state.tasks = [
                ...state.tasks.filter((task) => !isGoogleTask(task) && !markerIds.has(task.id)),
                ...mapped
                  .map(({ event, id }) =>
                    eventTask(event, id, state.categories, previousFor(event, id, old))
                  )
                  .filter(Boolean),
              ];
              return state;
            },
            { history: false }
          )
        : current;
      this.events = new Map(
        mapped.filter(({ id }) => validIds.has(id)).map(({ event, id }) => [id, event])
      );
      this.localIds = markerIds;
      return { state: next, imported: nextTasks.length, skipped: mapped.length - nextTasks.length };
    }
    async create(task) {
      if (!this.calendarId) throw new Error('同期先のカレンダーを選択してください');
      const search = new URLSearchParams({
        privateExtendedProperty: `roundScheduleId=${task.id}`,
        maxResults: '2',
      });
      const previous = await this.request(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${search}`
      );
      if (previous.items?.length) return previous.items[0];
      const event = await this.request(`/calendars/${encodeURIComponent(this.calendarId)}/events`, {
        method: 'POST',
        body: eventBody(task, task.id),
      });
      return event;
    }
    async update(task) {
      const old = this.events.get(task.id);
      if (!old) throw new Error('Googleの予定が見つかりません。同期してから開き直してください');
      const original = eventTask(
        old,
        task.id,
        [{ id: task.categoryId, name: '', color: '#000000' }],
        task
      );
      if (!original) throw new Error('Googleの予定を読み直してから編集してください');
      const full = eventBody(task);
      const body = {};
      if (task.name !== original.name) body.summary = full.summary;
      if (task.notes !== original.notes) body.description = full.description;
      if (task.location !== original.location) body.location = full.location;
      if (
        ['kind', 'date', 'endDate', 'startMin', 'endMin'].some((key) => task[key] !== original[key])
      ) {
        body.start = full.start;
        body.end = full.end;
      }
      if (!Object.keys(body).length) return old;
      const event = await this.request(
        `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(old.id)}`,
        { method: 'PATCH', body, etag: old.etag }
      );
      this.events.set(task.id, event);
      return event;
    }
    async remove(task) {
      const old = this.events.get(task.id);
      if (!old) throw new Error('Googleの予定が見つかりません。同期してから開き直してください');
      try {
        await this.request(
          `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(old.id)}`,
          { method: 'DELETE', etag: old.etag }
        );
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    async migrate(repo, onProgress = () => {}) {
      await this.sync(repo);
      const initial = await repo.read();
      const tasks = initial.tasks.filter((task) => !isGoogleTask(task) && supported(task));
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (!this.localIds.has(task.id)) await this.create(task);
        await this.sync(repo);
        onProgress(i + 1, tasks.length);
      }
      return tasks.length;
    }
    async forget(repo) {
      const state = await repo.read();
      const next =
        !repo.sharedEnabled && state.tasks.some(isGoogleTask)
          ? await repo.mutate(
              'Google連携を解除',
              (value) => {
                value.tasks = value.tasks.filter((task) => !isGoogleTask(task));
                return value;
              },
              { history: false }
            )
          : state;
      this.token = '';
      this.events.clear();
      this.localIds.clear();
      this.clientId = '';
      this.calendarId = '';
      this.storage?.removeItem(KEY);
      return next;
    }
  }

  function mount(connection, { repo, onChange, onError, beforeSwitch }) {
    const make = (tag, label, className) => {
      const node = document.createElement(tag);
      if (label !== undefined) node.textContent = label;
      if (className) node.className = className;
      return node;
    };
    const dialog = make('dialog');
    dialog.id = 'google-dialog';
    dialog.setAttribute('aria-labelledby', 'google-title');
    const heading = make('div', undefined, 'dialog-heading');
    const title = make('h2', 'Googleカレンダー連携');
    title.id = 'google-title';
    const close = make('button', '×', 'icon-button');
    close.type = 'button';
    close.setAttribute('aria-label', '閉じる');
    close.addEventListener('click', () => dialog.close());
    heading.append(title, close);
    const status = make('p', '', 'hint');
    status.setAttribute('role', 'status');
    const error = make('p', '', 'notice error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const content = make('div');
    dialog.append(heading, status, error, content);
    document.body.append(dialog);
    const open = make('button', 'Google連携');
    open.type = 'button';
    open.id = 'open-google';
    open.addEventListener('click', () => {
      if (beforeSwitch && !beforeSwitch()) return;
      render();
      dialog.showModal();
      connection.prepare().then(render, (e) => {
        error.textContent = e.message;
        error.hidden = false;
      });
    });
    document.querySelector('.header-actions')?.append(open);
    const button = (label, action, className) => {
      const node = make('button', label, className);
      node.type = 'button';
      node.addEventListener('click', () => run(action));
      return node;
    };
    let busy = false;
    let lastResult = '';
    async function run(action) {
      if (busy) return;
      busy = true;
      error.hidden = true;
      content.querySelectorAll('button').forEach((node) => (node.disabled = true));
      try {
        if ((await action()) !== false) render();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        onError?.(e);
      } finally {
        busy = false;
        content.querySelectorAll('button').forEach((node) => (node.disabled = false));
      }
    }
    async function sync() {
      const result = await connection.sync(repo);
      onChange(result.state);
      lastResult = `Googleの予定 ${result.imported}件を同期${result.skipped ? `（表示できない予定 ${result.skipped}件）` : ''}`;
      status.textContent = lastResult;
      return result;
    }
    function render() {
      content.replaceChildren();
      status.textContent = connection.connected
        ? lastResult || 'Googleカレンダーに接続済み。繰り返し予定は過去1年から今後2年を同期します。'
        : 'Googleへの接続は、この画面を開いている間だけ有効です。';
      if (repo.sharedEnabled) {
        content.append(
          make('p', '先に「ChatGPT連携」で端末内の予定へ切り替えてください。', 'notice')
        );
        return;
      }
      const info = make(
        'p',
        'Google CloudでCalendar APIを有効にし、ウェブアプリ用OAuthクライアントIDを作成してください。'
      );
      const docs = make('a', '設定手順');
      docs.href = './GOOGLE_CALENDAR_CONNECTION.md';
      docs.target = '_blank';
      docs.rel = 'noopener';
      info.append(' ', docs);
      content.append(info);
      const label = make('label', 'クライアントID');
      label.htmlFor = 'google-client-id';
      const input = make('input');
      input.id = 'google-client-id';
      input.value = connection.clientId;
      input.autocomplete = 'off';
      input.placeholder = '123456-abc.apps.googleusercontent.com';
      content.append(label, input);
      const connectButton = button(
        connection.token ? 'Googleアカウントを再接続' : 'Googleアカウントに接続',
        async () => {
          const preferredCalendar = connection.calendarId;
          await connection.authorize(input.value.trim());
          const calendars = await connection.calendars();
          showCalendars(calendars, preferredCalendar);
          return false;
        },
        'primary wide'
      );
      connectButton.disabled = !connection.ready;
      content.append(connectButton);
      if (connection.connected) {
        content.append(button('予定を同期', sync, 'wide'));
        const localCount = document.getElementById('data-count')?.textContent || '';
        content.append(
          make(
            'p',
            `同期先: ${connection.calendarId}。${localCount}。端末内の繰り返し・時刻未定は移しません。`,
            'hint'
          )
        );
        content.append(
          button('端末の日時付き・終日予定をGoogleへ移す', async () => {
            const state = await repo.read();
            const count = state.tasks.filter(
              (task) => !isGoogleTask(task) && supported(task)
            ).length;
            if (!count) return;
            if (
              !confirm(
                `${count}件の予定を「${connection.calendarId}」に移しますか？Googleに保存できた予定から端末内の元データを取り除きます。`
              )
            )
              return;
            await connection.migrate(repo, (done, total) => {
              status.textContent = `${done}/${total}件を移行中…`;
            });
            await sync();
          })
        );
      }
      if (connection.clientId || connection.calendarId) {
        content.append(
          button('Google連携を解除', async () => {
            if (!confirm('この端末のGoogle連携を解除しますか？Googleカレンダーの予定は残ります。'))
              return;
            onChange(await connection.forget(repo));
          })
        );
      }
    }
    function showCalendars(calendars, preferredCalendar) {
      render();
      const label = make('label', '同期するカレンダー');
      label.htmlFor = 'google-calendar-id';
      const select = make('select');
      select.id = 'google-calendar-id';
      for (const calendar of calendars) {
        const option = make('option', calendar.summary || calendar.id);
        option.value = calendar.id;
        select.append(option);
      }
      if (calendars.some((calendar) => calendar.id === preferredCalendar))
        select.value = preferredCalendar;
      content.append(label, select);
      content.append(
        button(
          'このカレンダーと同期',
          async () => {
            if (!select.value) throw new Error('書き込み可能なカレンダーがありません');
            const previous = connection.calendarId;
            connection.configure(connection.clientId, select.value);
            try {
              await sync();
            } catch (e) {
              connection.configure(connection.clientId, previous);
              throw e;
            }
          },
          'primary wide'
        )
      );
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && connection.connected && !repo.sharedEnabled)
        sync().catch((e) => onError?.(e));
    });
    setInterval(() => {
      if (connection.connected && !repo.sharedEnabled && document.visibilityState !== 'hidden')
        sync().catch((e) => onError?.(e));
    }, 120000);
    return { open, sync };
  }

  const exported = { Connection, eventBody, eventTask, taskId, isGoogleTask, supported, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.ScheduleGoogle = exported;
})(globalThis);
