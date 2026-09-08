const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const allowed = new Set([
  'index.html',
  'RoundSchedule.html',
  'core.js',
  'storage.js',
  'notifications.js',
  'app.js',
  'styles.css',
  'ds-sw.js',
  'ds-manifest.json',
  'icon-192.png',
  'icon-512.png',
  'schedule-icon.svg',
]);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'RoundSchedule.html';
  if (!['GET', 'HEAD'].includes(req.method) || !allowed.has(name)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(root, name), (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(name)],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.listen(Number(process.env.PORT) || 8765, '127.0.0.1', () =>
  console.log(`Daily Schedule: http://127.0.0.1:${server.address().port}/RoundSchedule.html`)
);
