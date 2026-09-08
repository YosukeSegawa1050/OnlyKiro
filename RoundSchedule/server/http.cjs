'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createStore, ScheduleError, invalid } = require('./store.cjs');
const { handleMcp } = require('./mcp.cjs');
const { createAuth } = require('./auth.cjs');
const ASSETS = new Set([
  'index.html',
  'RoundSchedule.html',
  'core.js',
  'storage.js',
  'notifications.js',
  'category-interactions.js',
  'app.js',
  'styles.css',
  'ds-sw.js',
  'ds-manifest.json',
  'icon-192.png',
  'icon-512.png',
  'schedule-icon.svg',
  'shared-storage.js',
  'shared-ui.js',
]);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}
async function readJson(req, limit = 4 * 1024 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw new ScheduleError(
      415,
      'unsupported_media_type',
      'Content-Type: application/json が必要です'
    );
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit)
    throw new ScheduleError(413, 'too_large', '送信内容が上限を超えています');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new ScheduleError(413, 'too_large', '送信内容が上限を超えています');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalid('JSON形式を確認してください');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('JSONオブジェクトを送信してください');
  return value;
}
function createScheduleServer(options = {}) {
  const store =
    options.store || createStore({ dataDir: options.dataDir, timeZone: options.timeZone });
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const configured = options.baseUrl || process.env.SCHEDULE_BASE_URL;
  let auth, resolvedUrl;
  function baseUrl() {
    if (resolvedUrl) return resolvedUrl;
    const address = server.address();
    const candidate = configured || `http://127.0.0.1:${address?.port || 8765}`;
    const value = new URL(candidate);
    if (
      !['http:', 'https:'].includes(value.protocol) ||
      value.username ||
      value.password ||
      value.search ||
      value.hash ||
      !['', '/'].includes(value.pathname)
    )
      throw invalid('SCHEDULE_BASE_URL はパスなしの公開URLにしてください');
    if (value.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(value.hostname))
      throw invalid('公開URLにはHTTPSが必要です');
    resolvedUrl = value.origin;
    return resolvedUrl;
  }
  function authentication() {
    if (!auth)
      auth = createAuth({
        db: store.db,
        baseUrl: baseUrl(),
        passphrase: options.passphrase || process.env.SCHEDULE_PASSPHRASE,
      });
    return auth;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const origin = baseUrl();
      const canonical = new URL(origin);
      const allowedHosts = new Set([canonical.host]);
      const address = server.address();
      if (address?.port) {
        allowedHosts.add(`127.0.0.1:${address.port}`);
        allowedHosts.add(`localhost:${address.port}`);
        allowedHosts.add(`[::1]:${address.port}`);
      }
      if (!allowedHosts.has(req.headers.host))
        return json(res, 421, { error: 'invalid_host', message: '接続先ホストが一致しません' });
      const url = new URL(req.url, origin);
      if (url.origin !== origin)
        return json(res, 400, { error: 'invalid_url', message: '接続先URLが一致しません' });
      const protectedPath =
        url.pathname.startsWith('/api/') ||
        url.pathname === '/mcp' ||
        url.pathname.startsWith('/auth/') ||
        url.pathname.startsWith('/oauth/') ||
        url.pathname.startsWith('/.well-known/');
      if (protectedPath) res.setHeader('Cache-Control', 'no-store');
      const handler = authentication();
      if (await handler.handle(req, res, url)) return;
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
        if (req.headers.origin && req.headers.origin !== origin)
          return json(res, 403, {
            error: 'invalid_origin',
            message: '同じサイトから操作してください',
          });
      }
      if (url.pathname === '/api/config' && req.method === 'GET')
        return json(res, 200, {
          available: true,
          timeZone: store.timeZone,
          mcpUrl: `${origin}/mcp`,
          authenticated: !!handler.session(req),
        });
      if (url.pathname.startsWith('/api/')) {
        if (!handler.requireApi(req, res)) return;
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin)
          return json(res, 403, {
            error: 'invalid_origin',
            message: '同じサイトから操作してください',
          });
        if (url.pathname === '/api/state' && req.method === 'GET')
          return json(res, 200, store.getSnapshot());
        if (['/api/state', '/api/initialize'].includes(url.pathname) && req.method === 'PUT') {
          const body = await readJson(req);
          const result = store.replace({
            state: body.state,
            expectedRevision: body.expectedRevision,
            label: body.label,
            mutationId: body.mutationId,
            initializeOnly: url.pathname === '/api/initialize',
          });
          return json(res, 200, result);
        }
        if (url.pathname === '/api/undo' && req.method === 'POST')
          return json(res, 200, store.undo(await readJson(req)));
        return json(res, 404, { error: 'not_found', message: 'APIが見つかりません' });
      }
      if (url.pathname === '/mcp') {
        if (!handler.requireMcp(req, res)) return;
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return json(res, 405, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Use POST for stateless Streamable HTTP' },
          });
        }
        const body = await readJson(req);
        await handleMcp(req, res, body, {
          store,
          baseUrl: origin,
          resourceUrl: `${origin}/.well-known/oauth-protected-resource`,
        });
        return;
      }
      const name = url.pathname.slice(1) || 'RoundSchedule.html';
      if (!['GET', 'HEAD'].includes(req.method) || !ASSETS.has(name))
        return json(res, 404, { error: 'not_found', message: 'Not found' });
      let data;
      try {
        data = await fs.readFile(path.join(root, name));
      } catch {
        return json(res, 404, { error: 'not_found', message: 'Not found' });
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(name)],
        'Cache-Control': 'no-cache',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const known = error instanceof ScheduleError;
      json(res, known ? error.status : 500, {
        error: known ? error.code : 'internal_error',
        message: known
          ? error.message
          : 'サーバーで処理できませんでした。しばらくして再試行してください',
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server,
    store,
    get auth() {
      return authentication();
    },
    get baseUrl() {
      return baseUrl();
    },
    async close() {
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
      if (!options.store) store.close();
    },
  };
}
module.exports = { createScheduleServer, readJson };
