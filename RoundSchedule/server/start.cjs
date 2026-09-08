'use strict';
const { createScheduleServer } = require('./http.cjs');
if (!process.env.SCHEDULE_PASSPHRASE || process.env.SCHEDULE_PASSPHRASE.length < 20) {
  console.error('SCHEDULE_PASSPHRASE に20文字以上のログイン用パスフレーズを設定してください。');
  process.exitCode = 1;
} else {
  let app;
  try {
    app = createScheduleServer({ dataDir: process.env.SCHEDULE_DATA_DIR });
    const port = Number(process.env.PORT || 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT が不正です');
    const host = process.env.HOST || '127.0.0.1';
    app.server.on('error', () => {
      console.error('サーバーを起動できません。ポートと設定を確認してください。');
      process.exitCode = 1;
    });
    app.server.listen(port, host, () => {
      try {
        // Fail at startup for invalid authentication/public URL configuration.
        void app.auth;
        console.log(`Daily Schedule: ${app.baseUrl}/RoundSchedule.html`);
        console.log(`MCP: ${app.baseUrl}/mcp (${app.store.timeZone})`);
      } catch {
        console.error('認証または公開URLの設定を確認してください。');
        app.close().finally(() => {
          process.exitCode = 1;
        });
      }
    });
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        app.close().then(
          () => {
            process.exitCode = 0;
          },
          () => {
            process.exitCode = 1;
          }
        );
      });
  } catch {
    console.error(
      'サーバーを起動できません。Node 24以降、保存先、タイムゾーン、環境設定を確認してください。'
    );
    if (app) app.close().catch(() => {});
    process.exitCode = 1;
  }
}
