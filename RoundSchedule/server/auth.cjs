'use strict';

// Deliberately narrow, single-owner OAuth server. Public clients use authorization
// code + S256 PKCE; tokens are opaque, hashed at rest, and checked on every request.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const SCOPES = ['schedules:read', 'schedules:write'];
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const opaque = () => crypto.randomBytes(32).toString('base64url');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]
  );

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new AuthError(status, code, message);
};

function canonicalBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SCHEDULE_BASE_URL must be an absolute URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'SCHEDULE_BASE_URL must be an HTTPS origin (HTTP is allowed only on loopback).'
    );
  }
  return url.origin;
}

function createAuth({ db, baseUrl, passphrase, redirectUris, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('SQLite database is required.');
  if (typeof passphrase !== 'string' || passphrase.length < 20 || passphrase.length > 1024) {
    throw new Error('SCHEDULE_PASSPHRASE must contain 20 to 1024 characters.');
  }
  const issuer = canonicalBase(baseUrl);
  const resource = `${issuer}/mcp`;
  const secure = issuer.startsWith('https:');
  const sessionCookie = secure ? '__Host-schedule_session' : 'schedule_session';
  const consentCookie = secure ? '__Host-schedule_consent' : 'schedule_consent';
  let configuredRedirects = redirectUris;
  if (configuredRedirects === undefined && process.env.SCHEDULE_OAUTH_REDIRECT_URIS) {
    try {
      configuredRedirects = JSON.parse(process.env.SCHEDULE_OAUTH_REDIRECT_URIS);
    } catch {
      throw new Error('SCHEDULE_OAUTH_REDIRECT_URIS must be a JSON array of exact callback URLs.');
    }
  }
  if (
    configuredRedirects !== undefined &&
    (!Array.isArray(configuredRedirects) || configuredRedirects.length > 20)
  ) {
    throw new Error('OAuth redirect allowlist must be an array of at most 20 exact URLs.');
  }
  const allowedRedirects = new Set([CHATGPT_REDIRECT, ...(configuredRedirects || [])]);
  for (const value of allowedRedirects) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Invalid OAuth redirect allowlist URL.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      typeof value !== 'string' ||
      value.length > 2048 ||
      value.includes('*') ||
      url.href !== value ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && !secure))
    ) {
      throw new Error(
        'OAuth callbacks must be exact HTTPS URLs without credentials, fragments, or wildcards.'
      );
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_consents (
      hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, request TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_grants (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_codes (
      hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_rates (key TEXT PRIMARY KEY, until_at INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_token_grant ON auth_tokens(grant_id);
  `);
  let salt = db.prepare('SELECT value FROM auth_meta WHERE key = ?').get('salt')?.value;
  if (!salt) {
    salt = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO auth_meta(key, value) VALUES (?, ?)').run('salt', salt);
  }
  const passwordHash = crypto.scryptSync(passphrase, salt, 32);
  const oldHash = db
    .prepare('SELECT value FROM auth_meta WHERE key = ?')
    .get('password_hash')?.value;
  if (oldHash && !safeEqual(oldHash, passwordHash.toString('hex'))) {
    // Changing the owner password invalidates all sessions and OAuth credentials.
    db.exec(
      'DELETE FROM auth_sessions; DELETE FROM auth_consents; DELETE FROM auth_codes; DELETE FROM auth_tokens; DELETE FROM auth_grants;'
    );
  }
  db.prepare(
    'INSERT INTO auth_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run('password_hash', passwordHash.toString('hex'));

  const timestamp = () => Math.floor(now() / 1000);
  const cookie = (name, value, seconds, sameSite = 'Strict') =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const readCookie = (req, name) => {
    const parts = String(req.headers.cookie || '')
      .split(';')
      .map((s) => s.trim());
    const matches = parts.filter((s) => s.startsWith(`${name}=`));
    if (matches.length !== 1) return '';
    const value = matches[0].slice(name.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
  };
  function response(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  }
  function sameOrigin(req) {
    // No Referer fallback: a missing/opaque Origin is not proof of a same-origin write.
    return req.headers.origin === issuer && req.headers['sec-fetch-site'] !== 'cross-site';
  }
  function requireOrigin(req) {
    if (!sameOrigin(req)) fail(403, 'csrf_failed', '同じサイトから操作してください。');
  }
  async function body(req, type) {
    if (
      String(req.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase() !== type
    ) {
      fail(415, 'invalid_request', 'Unsupported content type.');
    }
    if (Number(req.headers['content-length'] || 0) > 16384)
      fail(413, 'invalid_request', 'Request too large.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) fail(413, 'invalid_request', 'Request too large.');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (type === 'application/json') {
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        fail(400, 'invalid_request', 'Invalid JSON.');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(400, 'invalid_request', 'Expected an object.');
      return value;
    }
    return parameters(new URLSearchParams(raw));
  }
  function parameters(params) {
    const result = Object.create(null);
    for (const [key, value] of params) {
      if (Object.hasOwn(result, key)) fail(400, 'invalid_request', 'Duplicate request parameter.');
      result[key] = value;
    }
    return result;
  }
  function rate(req, bucket, limit, windowSeconds) {
    const at = timestamp();
    const address = String(req.socket?.remoteAddress || 'unknown');
    for (const [key, max] of [
      [`${bucket}:${address}`, limit],
      [`${bucket}:global`, limit * 5],
    ]) {
      const record = db
        .prepare(
          `INSERT INTO auth_rates(key,until_at,count) VALUES (?,?,1)
        ON CONFLICT(key) DO UPDATE SET
          count=CASE WHEN auth_rates.until_at <= ? THEN 1 ELSE auth_rates.count+1 END,
          until_at=CASE WHEN auth_rates.until_at <= ? THEN excluded.until_at ELSE auth_rates.until_at END
        RETURNING count,until_at`
        )
        .get(key, at + windowSeconds, at, at);
      if (record.count > max)
        fail(429, 'rate_limited', '操作が多すぎます。しばらく待ってから再試行してください。');
    }
  }
  async function passwordMatches(value) {
    if (typeof value !== 'string' || value.length > 1024) return false;
    return crypto.timingSafeEqual(await scrypt(value, salt, 32), passwordHash);
  }
  function scopes(value, allowed = SCOPES) {
    if (typeof value !== 'string' || value.length > 100)
      fail(400, 'invalid_scope', 'Invalid scope.');
    const list = [...new Set(value.split(' ').filter(Boolean))];
    if (!list.length || list.some((v) => !allowed.includes(v)))
      fail(400, 'invalid_scope', 'Invalid scope.');
    return list.join(' ');
  }
  function client(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id))
      fail(400, 'invalid_client', 'Unknown client.');
    const entry = db.prepare('SELECT * FROM auth_clients WHERE id = ?').get(id);
    if (!entry) fail(400, 'invalid_client', 'Unknown client.');
    return entry;
  }
  function verifyResource(value) {
    if (value !== resource)
      fail(400, 'invalid_target', 'The resource must identify this MCP server.');
  }
  function session(req) {
    const value = readCookie(req, sessionCookie);
    return Boolean(
      value &&
      db
        .prepare('SELECT 1 FROM auth_sessions WHERE hash=? AND expires_at>?')
        .get(digest(value), timestamp())
    );
  }
  function requireApi(req, res) {
    if (session(req)) return true;
    response(res, 401, { error: 'unauthorized', message: 'ログインしてください。' });
    return false;
  }
  function requireMcp(req, res, requiredScope = null) {
    const authorization = String(req.headers.authorization || '');
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    const entry =
      match &&
      db
        .prepare(
          `SELECT t.scope,t.expires_at,g.resource,g.revoked,g.client_id,g.id,
      g.expires_at AS grant_expires FROM auth_tokens t JOIN auth_grants g ON g.id=t.grant_id
      WHERE t.hash=? AND t.kind='access' AND t.used=0`
        )
        .get(digest(match[1]));
    const valid =
      entry &&
      !entry.revoked &&
      entry.expires_at > timestamp() &&
      entry.grant_expires > timestamp() &&
      entry.resource === resource;
    const grantedScopes = valid ? entry.scope.split(' ') : [];
    const sufficient =
      valid &&
      (requiredScope
        ? grantedScopes.includes(requiredScope)
        : SCOPES.some((scope) => grantedScopes.includes(scope)));
    if (!sufficient) {
      const status = valid ? 403 : 401;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", error="${valid ? 'insufficient_scope' : 'invalid_token'}", scope="${requiredScope || SCOPES.join(' ')}"`
      );
      response(res, status, { error: valid ? 'insufficient_scope' : 'invalid_token' });
      return false;
    }
    req.oauth = {
      scope: entry.scope,
      scopes: entry.scope.split(' '),
      clientId: entry.client_id,
      grantId: entry.id,
      userId: 'owner',
    };
    return true;
  }
  function tokens(grantId, scope) {
    const access = opaque();
    const refresh = opaque();
    const at = timestamp();
    const grant = db.prepare('SELECT expires_at FROM auth_grants WHERE id=?').get(grantId);
    const expiresIn = Math.min(900, grant.expires_at - at);
    const insert = db.prepare(
      'INSERT INTO auth_tokens(hash,grant_id,kind,scope,expires_at) VALUES (?,?,?,?,?)'
    );
    insert.run(digest(access), grantId, 'access', scope, at + expiresIn);
    insert.run(
      digest(refresh),
      grantId,
      'refresh',
      scope,
      Math.min(at + 30 * 86400, grant.expires_at)
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
      scope,
    };
  }
  function redirect(res, uri, values) {
    const target = new URL(uri);
    for (const [key, value] of Object.entries({ ...values, iss: issuer })) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    res.writeHead(303, {
      Location: target.href,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }
  function consentPage(res, request, challenge, name) {
    const nonce = opaque();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    res.end(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>予定へのアクセスを許可</title><style nonce="${nonce}">*{box-sizing:border-box;scrollbar-width:none}*::-webkit-scrollbar{display:none}html,body{overflow-x:clip;overscroll-behavior:none}body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:1rem;line-height:1.7;color:#17233a}input,button{font:inherit;padding:.7rem;box-sizing:border-box}input{display:block;width:100%;margin:.5rem 0 1rem}button{margin:.3rem}code{overflow-wrap:anywhere}</style><main><h1>予定へのアクセスを許可</h1><p><strong>${escapeHtml(name)}</strong> がこのサーバーへのアクセスを求めています。</p><ul>${request.scope
        .split(' ')
        .map(
          (s) =>
            `<li>${s === 'schedules:read' ? '予定とカテゴリーの読み取り' : '予定の追加・変更・削除'}</li>`
        )
        .join(
          ''
        )}</ul><p>許可先: <code>${escapeHtml(request.redirect_uri)}</code></p><p>あなた自身が開始した連携だけ許可してください。承認すると、この接続は解除または期限まで上記の操作を行えます。</p><form method="post" action="/oauth/authorize"><input type="hidden" name="challenge" value="${challenge}"><label for="passphrase">サーバーのパスフレーズ</label><input id="passphrase" name="passphrase" type="password" autocomplete="current-password" maxlength="1024" required><button type="submit" name="decision" value="allow">許可する</button><button type="submit" name="decision" value="deny" formnovalidate>拒否する</button></form></main></html>`
    );
  }

  let lastCleanup = 0;
  function cleanup() {
    const at = timestamp();
    if (at - lastCleanup < 60) return;
    lastCleanup = at;
    for (const table of ['auth_sessions', 'auth_consents'])
      db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(at);
    db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(at - 86400);
    db.prepare(
      'DELETE FROM auth_tokens WHERE grant_id IN (SELECT id FROM auth_grants WHERE expires_at <= ?)'
    ).run(at);
    db.prepare('DELETE FROM auth_grants WHERE expires_at <= ?').run(at);
    db.prepare('DELETE FROM auth_rates WHERE until_at <= ?').run(at);
  }
  async function handle(req, res, inputUrl) {
    const url = inputUrl || new URL(req.url, issuer);
    const path = url.pathname;
    const publicPaths = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/token',
      '/oauth/revoke',
    ];
    const known = [
      ...publicPaths,
      '/oauth/authorize',
      '/auth/login',
      '/auth/logout',
      '/auth/session',
      '/auth/connections',
      '/auth/revoke',
    ];
    if (!known.includes(path)) return false;
    let authorizationReturn;
    try {
      cleanup();
      if (publicPaths.includes(path)) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return true;
        }
      }
      if (req.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
        response(res, 200, {
          resource,
          authorization_servers: [issuer],
          scopes_supported: SCOPES,
          bearer_methods_supported: ['header'],
          resource_name: 'Round Schedule',
        });
      } else if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        response(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          revocation_endpoint: `${issuer}/oauth/revoke`,
          scopes_supported: SCOPES,
          response_types_supported: ['code'],
          response_modes_supported: ['query'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          revocation_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
        });
      } else if (req.method === 'GET' && path === '/auth/session') {
        response(res, 200, { authenticated: session(req) });
      } else if (req.method === 'POST' && path === '/auth/login') {
        requireOrigin(req);
        rate(req, 'password', 10, 900);
        const data = await body(req, 'application/json');
        if (!(await passwordMatches(data.passphrase)))
          fail(401, 'unauthorized', 'ログインできませんでした。');
        const old = readCookie(req, sessionCookie);
        if (old) db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(digest(old));
        const value = opaque();
        db.prepare('INSERT INTO auth_sessions(hash,expires_at) VALUES (?,?)').run(
          digest(value),
          timestamp() + 86400
        );
        res.setHeader('Set-Cookie', cookie(sessionCookie, value, 86400));
        response(res, 200, { authenticated: true });
      } else if (req.method === 'POST' && path === '/auth/logout') {
        requireOrigin(req);
        const value = readCookie(req, sessionCookie);
        if (value) db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(digest(value));
        res.setHeader('Set-Cookie', cookie(sessionCookie, '', 0));
        response(res, 200, { authenticated: false });
      } else if (req.method === 'GET' && path === '/auth/connections') {
        if (!requireApi(req, res)) return true;
        const connections = db
          .prepare(
            `SELECT g.id,c.name,g.scope,g.created_at,g.expires_at FROM auth_grants g JOIN auth_clients c ON c.id=g.client_id WHERE g.revoked=0 AND g.expires_at>? ORDER BY g.created_at DESC`
          )
          .all(timestamp());
        response(res, 200, { connections });
      } else if (req.method === 'POST' && path === '/auth/revoke') {
        requireOrigin(req);
        if (!requireApi(req, res)) return true;
        const data = await body(req, 'application/json');
        if (typeof data.grantId !== 'string')
          fail(400, 'invalid_request', '接続を指定してください。');
        db.prepare('UPDATE auth_grants SET revoked=1 WHERE id=?').run(data.grantId);
        response(res, 200, { revoked: true });
      } else if (req.method === 'POST' && path === '/oauth/register') {
        rate(req, 'register', 10, 3600);
        const data = await body(req, 'application/json');
        if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== 'none')
          fail(400, 'invalid_client_metadata', 'Only public clients with PKCE are supported.');
        if (
          !Array.isArray(data.redirect_uris) ||
          !data.redirect_uris.length ||
          data.redirect_uris.length > 5 ||
          data.redirect_uris.some((uri) => !allowedRedirects.has(uri))
        )
          fail(400, 'invalid_redirect_uri', 'Callback URL is not allowlisted.');
        if (
          data.grant_types !== undefined &&
          (!Array.isArray(data.grant_types) ||
            !data.grant_types.includes('authorization_code') ||
            data.grant_types.some((v) => !['authorization_code', 'refresh_token'].includes(v)))
        )
          fail(400, 'invalid_client_metadata', 'Unsupported grant type.');
        if (
          data.response_types !== undefined &&
          (!Array.isArray(data.response_types) ||
            data.response_types.length !== 1 ||
            data.response_types[0] !== 'code')
        )
          fail(400, 'invalid_client_metadata', 'Unsupported response type.');
        if (db.prepare('SELECT COUNT(*) AS count FROM auth_clients').get().count >= 200)
          fail(429, 'registration_limit', 'Client registration limit reached.');
        const name = data.client_name === undefined ? '連携クライアント' : data.client_name;
        if (
          typeof name !== 'string' ||
          !name.trim() ||
          name.length > 120 ||
          /[\x00-\x1f\x7f]/.test(name)
        )
          fail(400, 'invalid_client_metadata', 'Invalid client name.');
        const scope = scopes(data.scope === undefined ? SCOPES.join(' ') : data.scope);
        const id = opaque();
        const created = timestamp();
        const redirects = [...new Set(data.redirect_uris)];
        db.prepare(
          'INSERT INTO auth_clients(id,name,redirects,scope,created_at) VALUES (?,?,?,?,?)'
        ).run(id, name.trim(), JSON.stringify(redirects), scope, created);
        response(res, 201, {
          client_id: id,
          client_id_issued_at: created,
          client_name: name.trim(),
          redirect_uris: redirects,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope,
        });
      } else if (req.method === 'GET' && path === '/oauth/authorize') {
        rate(req, 'authorize', 60, 900);
        const data = parameters(url.searchParams);
        const registered = client(data.client_id);
        if (
          !JSON.parse(registered.redirects).includes(data.redirect_uri) ||
          !allowedRedirects.has(data.redirect_uri)
        )
          fail(400, 'invalid_request', 'Invalid redirect URI.');
        if (
          data.state !== undefined &&
          (data.state.length > 1024 || /[\x00-\x1f\x7f]/.test(data.state))
        )
          fail(400, 'invalid_request', 'Invalid state.');
        // OAuth errors may be redirected only after the registered callback is validated.
        authorizationReturn = { uri: data.redirect_uri, state: data.state };
        if (data.response_type !== 'code')
          fail(400, 'unsupported_response_type', 'Only authorization code flow is supported.');
        verifyResource(data.resource);
        if (
          data.code_challenge_method !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(data.code_challenge || '')
        )
          fail(400, 'invalid_request', 'S256 PKCE is required.');
        const scope = scopes(
          data.scope === undefined ? 'schedules:read' : data.scope,
          registered.scope.split(' ')
        );
        const request = {
          client_id: data.client_id,
          redirect_uri: data.redirect_uri,
          resource,
          scope,
          code_challenge: data.code_challenge,
          state: data.state,
        };
        const challenge = opaque();
        const csrf = opaque();
        db.prepare(
          'INSERT INTO auth_consents(hash,csrf_hash,request,expires_at) VALUES (?,?,?,?)'
        ).run(digest(challenge), digest(csrf), JSON.stringify(request), timestamp() + 300);
        res.setHeader('Set-Cookie', cookie(consentCookie, csrf, 300, 'Lax'));
        consentPage(res, request, challenge, registered.name);
      } else if (req.method === 'POST' && path === '/oauth/authorize') {
        requireOrigin(req);
        rate(req, 'password', 10, 900);
        const data = await body(req, 'application/x-www-form-urlencoded');
        const csrf = readCookie(req, consentCookie);
        const pending =
          typeof data.challenge === 'string' &&
          /^[A-Za-z0-9_-]{43}$/.test(data.challenge) &&
          db
            .prepare('SELECT * FROM auth_consents WHERE hash=? AND expires_at>?')
            .get(digest(data.challenge), timestamp());
        if (!pending || !csrf || !safeEqual(pending.csrf_hash, digest(csrf)))
          fail(
            403,
            'csrf_failed',
            '承認画面の有効期限が切れたか、操作を確認できません。連携をやり直してください。'
          );
        if (!['allow', 'deny'].includes(data.decision))
          fail(400, 'invalid_request', 'Invalid decision.');
        const request = JSON.parse(pending.request);
        if (data.decision === 'allow' && !(await passwordMatches(data.passphrase)))
          fail(401, 'unauthorized', '認証できませんでした。連携をやり直してください。');
        const removed = db
          .prepare('DELETE FROM auth_consents WHERE hash=? AND expires_at>?')
          .run(pending.hash, timestamp());
        if (removed.changes !== 1)
          fail(400, 'invalid_request', 'Consent has expired or already been used.');
        res.setHeader('Set-Cookie', cookie(consentCookie, '', 0, 'Lax'));
        if (data.decision === 'deny') {
          redirect(res, request.redirect_uri, { error: 'access_denied', state: request.state });
        } else {
          const id = opaque();
          const code = opaque();
          const at = timestamp();
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare(
              'INSERT INTO auth_grants(id,client_id,scope,resource,created_at,expires_at) VALUES (?,?,?,?,?,?)'
            ).run(id, request.client_id, request.scope, resource, at, at + 90 * 86400);
            db.prepare(
              'INSERT INTO auth_codes(hash,grant_id,redirect_uri,challenge,expires_at) VALUES (?,?,?,?,?)'
            ).run(digest(code), id, request.redirect_uri, request.code_challenge, at + 120);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          redirect(res, request.redirect_uri, { code, state: request.state });
        }
      } else if (req.method === 'POST' && path === '/oauth/token') {
        rate(req, 'token', 120, 900);
        const data = await body(req, 'application/x-www-form-urlencoded');
        if (req.headers.authorization || data.client_secret || data.client_assertion)
          fail(400, 'invalid_client', 'Only public-client PKCE authentication is supported.');
        const registered = client(data.client_id);
        verifyResource(data.resource);
        let result;
        if (data.grant_type === 'authorization_code') {
          const code =
            typeof data.code === 'string' &&
            db.prepare('SELECT * FROM auth_codes WHERE hash=?').get(digest(data.code));
          const grant =
            code && db.prepare('SELECT * FROM auth_grants WHERE id=?').get(code.grant_id);
          if (
            !grant ||
            grant.client_id !== registered.id ||
            grant.resource !== resource ||
            grant.revoked ||
            grant.expires_at <= timestamp() ||
            code.expires_at <= timestamp()
          )
            fail(400, 'invalid_grant', 'Invalid or expired authorization code.');
          if (
            data.redirect_uri !== code.redirect_uri ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(data.code_verifier || '') ||
            !safeEqual(
              crypto.createHash('sha256').update(data.code_verifier).digest('base64url'),
              code.challenge
            )
          )
            fail(400, 'invalid_grant', 'Invalid authorization code binding.');
          if (code.used) {
            db.prepare('UPDATE auth_grants SET revoked=1 WHERE id=?').run(grant.id);
            fail(400, 'invalid_grant', 'Authorization code has already been used.');
          }
          db.exec('BEGIN IMMEDIATE');
          try {
            const updated = db
              .prepare('UPDATE auth_codes SET used=1 WHERE hash=? AND used=0')
              .run(code.hash);
            if (updated.changes !== 1)
              fail(400, 'invalid_grant', 'Authorization code has already been used.');
            result = tokens(grant.id, grant.scope);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        } else if (data.grant_type === 'refresh_token') {
          const token =
            typeof data.refresh_token === 'string' &&
            db
              .prepare("SELECT * FROM auth_tokens WHERE hash=? AND kind='refresh'")
              .get(digest(data.refresh_token));
          const grant =
            token && db.prepare('SELECT * FROM auth_grants WHERE id=?').get(token.grant_id);
          if (
            !grant ||
            grant.client_id !== registered.id ||
            grant.resource !== resource ||
            grant.revoked ||
            grant.expires_at <= timestamp() ||
            token.expires_at <= timestamp()
          )
            fail(400, 'invalid_grant', 'Invalid or expired refresh token.');
          if (token.used) {
            db.prepare('UPDATE auth_grants SET revoked=1 WHERE id=?').run(grant.id);
            fail(400, 'invalid_grant', 'Refresh token reuse detected; reconnect this client.');
          }
          const scope =
            data.scope === undefined ? token.scope : scopes(data.scope, token.scope.split(' '));
          db.exec('BEGIN IMMEDIATE');
          try {
            const updated = db
              .prepare('UPDATE auth_tokens SET used=1 WHERE hash=? AND used=0')
              .run(token.hash);
            if (updated.changes !== 1)
              fail(400, 'invalid_grant', 'Refresh token has already been used.');
            result = tokens(grant.id, scope);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        } else fail(400, 'unsupported_grant_type', 'Unsupported grant type.');
        response(res, 200, result);
      } else if (req.method === 'POST' && path === '/oauth/revoke') {
        rate(req, 'token', 120, 900);
        const data = await body(req, 'application/x-www-form-urlencoded');
        if (req.headers.authorization || data.client_secret || data.client_assertion)
          fail(400, 'invalid_client', 'Only public-client authentication is supported.');
        const registered = client(data.client_id);
        if (typeof data.token !== 'string' || data.token.length > 2048)
          fail(400, 'invalid_request', 'Invalid token.');
        const token = db
          .prepare(
            'SELECT g.id FROM auth_tokens t JOIN auth_grants g ON g.id=t.grant_id WHERE t.hash=? AND g.client_id=?'
          )
          .get(digest(data.token), registered.id);
        if (token) db.prepare('UPDATE auth_grants SET revoked=1 WHERE id=?').run(token.id);
        response(res, 200, {});
      } else {
        res.setHeader(
          'Allow',
          path === '/oauth/authorize'
            ? 'GET, POST'
            : path.startsWith('/.well-known/') ||
                ['/auth/session', '/auth/connections'].includes(path)
              ? 'GET'
              : 'POST'
        );
        response(res, 405, { error: 'method_not_allowed' });
      }
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.status === 429) res.setHeader('Retry-After', '900');
        if (authorizationReturn && error.status === 400) {
          redirect(res, authorizationReturn.uri, {
            error: error.code,
            state: authorizationReturn.state,
          });
        } else response(res, error.status, { error: error.code, error_description: error.message });
      } else {
        // Never return exception text: it can contain SQL, request fields, or secrets.
        response(res, 500, {
          error: 'server_error',
          error_description: '認証処理に失敗しました。',
        });
      }
    }
    return true;
  }
  return { handle, session, requireApi, requireMcp, resource, issuer, scopes: [...SCOPES] };
}

module.exports = { createAuth };
