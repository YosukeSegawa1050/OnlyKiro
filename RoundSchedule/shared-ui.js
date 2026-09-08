(function (root) {
  'use strict';
  let mounted = false;
  function mount({ repo, onChange, onError, beforeSwitch }) {
    if (mounted || typeof repo.connect !== 'function') return;
    mounted = true;
    const make = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const button = (text, action, className) => {
      const node = make('button', text, className);
      node.type = 'button';
      node.addEventListener('click', action);
      return node;
    };
    const details = (text) => {
      const node = make('details');
      node.append(make('summary', text));
      return node;
    };
    const dialog = make('dialog');
    dialog.id = 'shared-dialog';
    dialog.setAttribute('aria-labelledby', 'shared-title');
    const heading = make('div', undefined, 'dialog-heading');
    const title = make('h2', 'ChatGPT連携');
    title.id = 'shared-title';
    const close = button('×', () => dialog.close(), 'icon-button');
    close.setAttribute('aria-label', '閉じる');
    heading.append(title, close);
    const status = make('p', '', 'hint');
    status.setAttribute('role', 'status');
    const error = make('p', '', 'notice error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const content = make('div');
    dialog.append(heading, status, error, content);
    document.body.append(dialog);
    const open = button('ChatGPT連携', async () => {
      if (beforeSwitch && !beforeSwitch()) return;
      dialog.showModal();
      await action(refresh);
    });
    open.id = 'open-shared';
    document.querySelector('.header-actions')?.append(open);
    let working = false;
    function updateStatus() {
      const target = document.getElementById('save-status');
      if (repo.sharedEnabled && target) target.textContent = repo.saveStatus();
    }
    repo.onStatus(updateStatus);
    async function action(fn) {
      if (working) return;
      working = true;
      error.hidden = true;
      content.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
      close.disabled = true;
      try {
        await fn();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      } finally {
        working = false;
        close.disabled = false;
        content.querySelectorAll('button').forEach((b) => {
          b.disabled = false;
        });
      }
    }
    // Do not dismiss a pending save or leave a password in the closed dialog.
    dialog.addEventListener('cancel', (event) => {
      if (working) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      const password = dialog.querySelector('input[type="password"]');
      if (password) password.value = '';
    });
    async function refresh() {
      status.textContent = '確認中…';
      content.replaceChildren();
      error.hidden = true;
      let config;
      try {
        config = await repo.request('/api/config');
      } catch {
        status.textContent = repo.sharedEnabled
          ? repo.saveStatus()
          : '共有サーバーに接続できません。';
        content.append(button('再確認', () => action(refresh)));
        return;
      }
      if (!config.available) {
        status.textContent = '共有サーバー未設定';
        return;
      }
      if (!config.authenticated) {
        status.textContent = repo.sharedEnabled
          ? '再ログインが必要です · 閲覧のみ'
          : '共有先へログイン';
        const form = make('form');
        const label = make('label', 'パスフレーズ');
        label.htmlFor = 'shared-passphrase';
        const input = make('input');
        input.id = 'shared-passphrase';
        input.name = 'password';
        input.type = 'password';
        input.autocomplete = 'current-password';
        input.required = true;
        input.maxLength = 1024;
        const login = make('button', 'ログイン', 'primary wide');
        login.type = 'submit';
        form.append(label, input, login);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          action(async () => {
            await repo.request('/auth/login', {
              method: 'POST',
              body: { passphrase: input.value },
            });
            input.value = '';
            if (repo.sharedEnabled) onChange(await repo.read());
            await refresh();
          });
        });
        content.append(form);
        return;
      }
      const snapshot = await repo.request('/api/state');
      status.textContent = repo.sharedEnabled
        ? '共有予定に接続済み'
        : 'ログイン済み · 端末内の予定';
      if (!repo.sharedEnabled) {
        if (repo.timeZone && snapshot.timeZone !== repo.timeZone)
          content.append(
            make(
              'p',
              `共有先 ${snapshot.timeZone}／端末 ${repo.timeZone}。閲覧のみ。編集・共有には端末のタイムゾーンを合わせてください。`,
              'notice'
            )
          );
        if (!snapshot.initialized) {
          const local = await repo.local.read();
          content.append(
            make(
              'p',
              `共有する内容：予定${local.tasks.length}件・カテゴリー${local.categories.length}件・テンプレート${local.templates.length}件`
            )
          );
          content.append(
            button(
              'この端末の予定を共有',
              () =>
                action(async () => {
                  onChange(
                    await repo.connect({ importLocal: true, expectedRevision: local.revision })
                  );
                  await refresh();
                }),
              'primary wide'
            )
          );
        } else {
          content.append(
            make('p', `共有先：予定${snapshot.state.tasks.length}件。端末の予定は保持されます。`)
          );
          content.append(
            button(
              '共有予定を開く',
              () =>
                action(async () => {
                  onChange(await repo.connect());
                  await refresh();
                }),
              'primary wide'
            )
          );
        }
      } else {
        if (repo.problem) content.append(make('p', repo.problem, 'notice'));
        content.append(
          button('再読み込み', () =>
            action(async () => {
              onChange(await repo.connect());
              await refresh();
            })
          )
        );
        if (!config.mcpUrl.startsWith('https://'))
          content.append(
            make('p', 'ローカル接続です。ChatGPTとの連携にはHTTPS公開が必要です。', 'notice')
          );
        const connection = details('ChatGPTの接続設定');
        const label = make('label', '接続URL');
        label.htmlFor = 'shared-mcp-url';
        const url = make('input');
        url.id = 'shared-mcp-url';
        url.readOnly = true;
        url.value = config.mcpUrl;
        connection.append(label, url);
        const connectionActions = make('div', undefined, 'actions');
        connectionActions.append(
          button('URLをコピー', () =>
            action(async () => {
              if (!navigator.clipboard?.writeText) {
                url.focus();
                url.select();
                status.textContent = 'URLを選択しました。コピーしてください。';
                return;
              }
              await navigator.clipboard.writeText(url.value);
              status.textContent = 'URLをコピーしました';
            })
          )
        );
        const docs = make('a', '設定手順');
        docs.href = 'https://developers.openai.com/plugins/deploy/connect-chatgpt';
        docs.target = '_blank';
        docs.rel = 'noopener noreferrer';
        connectionActions.append(docs);
        connection.append(connectionActions);
        content.append(connection);
        const grants = await repo.request('/auth/connections');
        content.append(make('h3', 'アクセス許可'));
        if (!grants.connections.length) content.append(make('p', 'ChatGPTは未連携', 'hint'));
        for (const grant of grants.connections) {
          const row = make('div', undefined, 'actions');
          const revoke = button('解除', () =>
            action(async () => {
              await repo.request('/auth/revoke', { method: 'POST', body: { grantId: grant.id } });
              await refresh();
            })
          );
          revoke.setAttribute('aria-label', `${grant.name}のアクセス許可を解除`);
          row.append(make('span', grant.name), revoke);
          content.append(row);
        }
        const localMode = details('端末内へ切り替え');
        localMode.append(
          make(
            'p',
            '端末の予定を共有予定で置き換えます（元の予定はバックアップ）。ChatGPTの許可は継続します。',
            'hint'
          )
        );
        localMode.append(
          button('保存して切り替え', () =>
            action(async () => {
              onChange(await repo.disconnect());
              await refresh();
            })
          )
        );
        content.append(localMode);
      }
      content.append(
        button('ログアウト', () =>
          action(async () => {
            await repo.request('/auth/logout', { method: 'POST', body: {} });
            if (repo.sharedEnabled) {
              repo.report('再ログインが必要です · 閲覧のみ');
              onChange(await repo.read());
            }
            await refresh();
          })
        )
      );
    }
    root.addEventListener('online', async () => {
      if (repo.sharedEnabled) {
        try {
          onChange(await repo.read());
        } catch (e) {
          onError?.(e.message);
        }
      }
    });
  }
  root.ScheduleSharedUI = { mount };
})(globalThis);
