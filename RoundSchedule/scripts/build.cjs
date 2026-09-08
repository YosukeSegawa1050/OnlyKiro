const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const assets = [
  'index.html',
  'RoundSchedule.html',
  'core.js',
  'storage.js',
  'shared-storage.js',
  'shared-ui.js',
  'notifications.js',
  'category-interactions.js',
  'app.js',
  'styles.css',
  'ds-sw.js',
  'ds-manifest.json',
  'icon-192.png',
  'icon-512.png',
  'schedule-icon.svg',
];
fs.mkdirSync(output, { recursive: true });
for (const asset of assets) fs.copyFileSync(path.join(root, asset), path.join(output, asset));
console.log(`Built ${assets.length} production files in dist/`);
