'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const target = path.resolve(__dirname, '..', '.env');
const text = [
  '# Daily Schedule: personal shared server configuration. Do not commit this file.',
  'SCHEDULE_BASE_URL=http://127.0.0.1:8765',
  `SCHEDULE_PASSPHRASE=${crypto.randomBytes(32).toString('base64url')}`,
  'SCHEDULE_TIME_ZONE=Asia/Tokyo',
  'SCHEDULE_DATA_DIR=.schedule-data',
  'HOST=127.0.0.1',
  'PORT=8765',
  '',
].join('\n');
try {
  fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
  console.log('共有サーバー用の .env を作成しました。');
  console.log('ログイン用パスフレーズは .env の SCHEDULE_PASSPHRASE を確認してください。');
  console.log('npm.cmd run start:shared でローカル起動できます。');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env はすでに存在します。設定は変更していません。');
  else {
    console.error('.env を作成できませんでした。保存先の権限を確認してください。');
    process.exitCode = 1;
  }
}
