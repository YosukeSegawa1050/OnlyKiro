'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createAuth } = require('../server/auth.cjs');

const PASSWORD = 'fixture-only-long-passphrase-2026';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = () => crypto.randomBytes(32).toString('base64url');
const pkce = (value) => crypto.createHash('sha256').update(value).digest('base64url');

async function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  let clock = Date.now();
  let auth;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url)) return;
    const allowed =
      url.pathname === '/api/private'
        ? auth.requireApi(req, res)
        : auth.requireMcp(
            req,
            res,
            url.pathname === '/mcp/write'
              ? 'schedules:write'
              : url.pathname === '/mcp/read'
                ? 'schedules:read'
                : null
          );
    if (allowed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ private: true, oauth: req.oauth || null }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const issuer = options.baseUrl || origin;
  const build = (passphrase = PASSWORD) =>
    createAuth({ db, baseUrl: issuer, passphrase, now: () => clock, ...options });
  auth = build();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const request = async (
    path,
    data,
    {
      method = data === undefined ? 'GET' : 'POST',
      cookie,
      bearer,
      form = false,
      raw,
      headers = {},
    } = {}
  ) => {
    const requestHeaders = { ...headers };
    if (cookie) requestHeaders.Cookie = cookie;
    if (bearer) requestHeaders.Authorization = `Bearer ${bearer}`;
    let body;
    if (data !== undefined || raw !== undefined) {
      requestHeaders['Content-Type'] = form
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
      body =
        raw === undefined
          ? form
            ? new URLSearchParams(data).toString()
            : JSON.stringify(data)
          : raw;
    }
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: requestHeaders,
      body,
      redirect: 'manual',
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: response.status,
      headers: response.headers,
      text,
      json,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  };
  const register = async (data = {}) => {
    const response = await request('/oauth/register', {
      client_name: 'ChatGPT test',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      ...data,
    });
    assert.equal(response.status, 201, response.text);
    return response.json.client_id;
  };
  const startConsent = async ({
    clientId,
    scope = 'schedules:read schedules:write',
    secret = verifier(),
    ...changes
  } = {}) => {
    const id = clientId || (await register());
    const params = {
      client_id: id,
      response_type: 'code',
      redirect_uri: REDIRECT,
      resource: `${issuer}/mcp`,
      scope,
      state: 'test-random-state',
      code_challenge_method: 'S256',
      code_challenge: pkce(secret),
      ...changes,
    };
    const response = await request(`/oauth/authorize?${new URLSearchParams(params)}`);
    return {
      ...response,
      clientId: id,
      secret,
      challenge: response.text.match(/name="challenge" value="([A-Za-z0-9_-]+)"/)?.[1],
    };
  };
  const approve = async (consent, changes = {}, reqOptions = {}) => {
    const response = await request(
      '/oauth/authorize',
      { challenge: consent.challenge, passphrase: PASSWORD, decision: 'allow', ...changes },
      { cookie: consent.cookie, form: true, headers: { Origin: issuer }, ...reqOptions }
    );
    const location = response.headers.get('location');
    return {
      ...response,
      location: location ? new URL(location) : null,
      code: location ? new URL(location).searchParams.get('code') : null,
    };
  };
  const exchange = (consent, code, changes = {}) =>
    request(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: consent.clientId,
        resource: `${issuer}/mcp`,
        code,
        redirect_uri: REDIRECT,
        code_verifier: consent.secret,
        ...changes,
      },
      { form: true }
    );
  const grant = async (options = {}) => {
    const consent = await startConsent(options);
    assert.equal(consent.status, 200, consent.text);
    const approved = await approve(consent);
    assert.equal(approved.status, 303, approved.text);
    const response = await exchange(consent, approved.code);
    assert.equal(response.status, 200, response.text);
    return { consent, approved, ...response.json };
  };
  return {
    db,
    origin,
    issuer,
    request,
    register,
    startConsent,
    approve,
    exchange,
    grant,
    advance: (ms) => {
      clock += ms;
    },
    rebuild: (password = PASSWORD) => {
      auth = build(password);
    },
  };
}

test('auth configuration fails closed and callback allowlist is exact', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => createAuth({ db, baseUrl: 'https://example.com' }), /PASSPHRASE/);
    assert.throws(
      () => createAuth({ db, baseUrl: 'http://example.com', passphrase: PASSWORD }),
      /HTTPS/
    );
    assert.throws(
      () => createAuth({ db, baseUrl: 'https://example.com/path', passphrase: PASSWORD }),
      /origin/
    );
    assert.throws(
      () =>
        createAuth({
          db,
          baseUrl: 'https://example.com',
          passphrase: PASSWORD,
          redirectUris: ['https://chatgpt.com/*'],
        }),
      /exact HTTPS/
    );
    assert.throws(
      () =>
        createAuth({
          db,
          baseUrl: 'https://example.com',
          passphrase: PASSWORD,
          redirectUris: ['https://user:pw@example.com/callback'],
        }),
      /exact HTTPS/
    );
    assert.throws(
      () =>
        createAuth({
          db,
          baseUrl: 'https://example.com',
          passphrase: PASSWORD,
          redirectUris: ['http://localhost:1234/callback'],
        }),
      /exact HTTPS/
    );
  } finally {
    db.close();
  }
});

test('metadata, public CORS, and per-request bearer authentication', async (t) => {
  const f = await fixture(t);
  const denied = await f.request('/mcp');
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /resource_metadata=/);
  const resource = await f.request('/.well-known/oauth-protected-resource');
  assert.equal(resource.json.resource, `${f.issuer}/mcp`);
  assert.deepEqual(resource.json.authorization_servers, [f.issuer]);
  const auth = await f.request('/.well-known/oauth-authorization-server');
  assert.deepEqual(auth.json.code_challenge_methods_supported, ['S256']);
  assert.equal(auth.json.authorization_response_iss_parameter_supported, true);
  assert.equal(auth.json.client_id_metadata_document_supported, undefined);
  const preflight = await f.request('/oauth/token', undefined, {
    method: 'OPTIONS',
    headers: { Origin: 'https://chatgpt.com' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal((await f.request('/mcp?access_token=fake')).status, 401);
});

test('owner login uses same-origin, HttpOnly sessions; logout and expiration revoke access', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/private')).status, 401);
  assert.equal((await f.request('/auth/login', { passphrase: PASSWORD })).status, 403);
  assert.equal(
    (
      await f.request(
        '/auth/login',
        { passphrase: PASSWORD },
        { headers: { Origin: 'https://evil.example' } }
      )
    ).status,
    403
  );
  const bad = await f.request(
    '/auth/login',
    { passphrase: 'wrong' },
    { headers: { Origin: f.issuer } }
  );
  assert.equal(bad.status, 401);
  assert.ok(!bad.text.includes('wrong'));
  const login = await f.request(
    '/auth/login',
    { passphrase: PASSWORD },
    { headers: { Origin: f.issuer } }
  );
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.request('/api/private', undefined, { cookie: login.cookie })).status, 200);
  assert.equal((await f.request('/mcp', undefined, { cookie: login.cookie })).status, 401);
  assert.equal(
    (
      await f.request(
        '/auth/logout',
        {},
        { cookie: login.cookie, headers: { Origin: 'https://evil.example' } }
      )
    ).status,
    403
  );
  assert.equal(
    (await f.request('/auth/logout', {}, { cookie: login.cookie, headers: { Origin: f.issuer } }))
      .status,
    200
  );
  assert.equal((await f.request('/api/private', undefined, { cookie: login.cookie })).status, 401);
  const again = await f.request(
    '/auth/login',
    { passphrase: PASSWORD },
    { headers: { Origin: f.issuer } }
  );
  f.advance(86400001);
  assert.equal((await f.request('/api/private', undefined, { cookie: again.cookie })).status, 401);
});

test('HTTPS cookies have __Host prefix, Secure, and safe SameSite modes', async (t) => {
  const f = await fixture(t, { baseUrl: 'https://schedule.example' });
  const login = await f.request(
    '/auth/login',
    { passphrase: PASSWORD },
    { headers: { Origin: f.issuer } }
  );
  assert.match(login.headers.get('set-cookie'), /^__Host-schedule_session=/);
  assert.match(login.headers.get('set-cookie'), /; Secure$/);
  const consent = await f.startConsent();
  assert.match(consent.headers.get('set-cookie'), /^__Host-schedule_consent=/);
  assert.match(consent.headers.get('set-cookie'), /SameSite=Lax.*Secure/);
});

test('DCR rejects open redirects, unsupported authentication and grant metadata', async (t) => {
  const f = await fixture(t);
  for (const uri of [
    'https://evil.example/callback',
    'https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
    `${REDIRECT}#fragment`,
    `${REDIRECT}?next=evil`,
    'javascript:alert(1)',
  ]) {
    const result = await f.request('/oauth/register', { redirect_uris: [uri] });
    assert.equal(result.status, 400, uri);
    assert.equal(result.json.error, 'invalid_redirect_uri');
  }
  const secret = await f.request('/oauth/register', {
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'client_secret_post',
  });
  assert.equal(secret.status, 400);
  const implicit = await f.request('/oauth/register', {
    redirect_uris: [REDIRECT],
    grant_types: ['implicit'],
  });
  assert.equal(implicit.status, 400);
  const invalidScopes = await f.request('/oauth/register', {
    redirect_uris: [REDIRECT],
    scope: 'admin',
  });
  assert.equal(invalidScopes.json.error, 'invalid_scope');
});

test('authorization rejects missing PKCE, duplicate parameters, wrong scope, audience, and redirect', async (t) => {
  const f = await fixture(t);
  const clientId = await f.register();
  for (const changes of [
    { code_challenge_method: 'plain' },
    { code_challenge: 'short' },
    { resource: 'https://other.example/mcp' },
    { scope: 'admin' },
    { redirect_uri: 'https://evil.example/callback' },
    { response_type: 'token' },
  ]) {
    const result = await f.startConsent({ clientId, ...changes });
    if (changes.redirect_uri) {
      assert.equal(result.status, 400, JSON.stringify(changes));
      assert.equal(result.headers.get('location'), null);
    } else {
      assert.equal(result.status, 303, JSON.stringify(changes));
      const location = new URL(result.headers.get('location'));
      assert.equal(location.origin, 'https://chatgpt.com');
      assert.equal(location.searchParams.get('iss'), f.issuer);
      assert.ok(location.searchParams.has('error'));
    }
  }
  const duplicate = await f.request(`/oauth/authorize?client_id=${clientId}&client_id=${clientId}`);
  assert.equal(duplicate.status, 400);
});

test('consent binds the original request, requires same-origin + cookie, escapes content, and is single-use', async (t) => {
  const f = await fixture(t);
  const clientId = await f.register({ client_name: '<img src=x onerror=alert(1)>' });
  const consent = await f.startConsent({ clientId, scope: 'schedules:read' });
  assert.equal(consent.status, 200);
  assert.ok(consent.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!consent.text.includes('<img src=x'));
  assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await f.approve(consent, {}, { cookie: undefined })).status, 403);
  assert.equal(
    (await f.approve(consent, {}, { headers: { Origin: 'https://evil.example' } })).status,
    403
  );
  assert.equal((await f.approve(consent, { passphrase: 'wrong' })).status, 401);
  const approved = await f.approve(consent, {
    scope: 'schedules:write',
    redirect_uri: 'https://evil.example',
  });
  assert.equal(approved.status, 303);
  assert.equal(approved.location.origin, 'https://chatgpt.com');
  assert.equal(approved.location.searchParams.get('iss'), f.issuer);
  assert.equal(approved.location.searchParams.get('state'), 'test-random-state');
  assert.equal((await f.approve(consent)).status, 403);
  const token = await f.exchange(consent, approved.code);
  assert.equal(token.status, 200);
  assert.equal(token.json.scope, 'schedules:read');
  assert.equal(
    (await f.request('/mcp/write', undefined, { bearer: token.json.access_token })).status,
    403
  );
});

test('consent denial returns issuer and state without an authorization code', async (t) => {
  const f = await fixture(t);
  const consent = await f.startConsent();
  const denied = await f.approve(consent, { decision: 'deny', passphrase: '' });
  assert.equal(denied.status, 303);
  assert.equal(denied.location.searchParams.get('error'), 'access_denied');
  assert.equal(denied.location.searchParams.get('iss'), f.issuer);
  assert.equal(denied.location.searchParams.get('state'), 'test-random-state');
  assert.equal(denied.code, null);
});

test('PKCE and code are bound to client and callback; replay revokes issued credentials', async (t) => {
  const f = await fixture(t);
  const consent = await f.startConsent();
  const approved = await f.approve(consent);
  const other = await f.register();
  for (const changes of [
    { code_verifier: verifier() },
    { redirect_uri: `${REDIRECT}?wrong=1` },
    { client_id: other },
    { resource: 'https://other.example/mcp' },
  ]) {
    assert.equal((await f.exchange(consent, approved.code, changes)).status, 400);
  }
  const exchange = await f.exchange(consent, approved.code);
  assert.equal(exchange.status, 200, exchange.text);
  const access = exchange.json.access_token;
  assert.equal((await f.request('/mcp', undefined, { bearer: access })).status, 200);
  assert.equal((await f.request('/mcp/write', undefined, { bearer: access })).status, 200);
  assert.equal((await f.request('/mcp')).status, 401);
  assert.equal(
    (await f.exchange(consent, approved.code, { code_verifier: verifier() })).status,
    400
  );
  assert.equal((await f.request('/mcp', undefined, { bearer: access })).status, 200);
  assert.equal((await f.exchange(consent, approved.code)).status, 400);
  assert.equal((await f.request('/mcp', undefined, { bearer: access })).status, 401);
});

test('consent, code, and access token expirations are enforced', async (t) => {
  const f = await fixture(t);
  const expiredConsent = await f.startConsent();
  f.advance(300001);
  assert.equal((await f.approve(expiredConsent)).status, 403);
  const expiredCode = await f.startConsent({ clientId: expiredConsent.clientId });
  const approved = await f.approve(expiredCode);
  f.advance(120001);
  assert.equal((await f.exchange(expiredCode, approved.code)).status, 400);
  const access = await f.grant({ clientId: expiredConsent.clientId });
  f.advance(900001);
  assert.equal((await f.request('/mcp', undefined, { bearer: access.access_token })).status, 401);
});

test('refresh narrows scopes, rotates credentials, and detects reuse', async (t) => {
  const f = await fixture(t);
  const issued = await f.grant();
  const data = {
    grant_type: 'refresh_token',
    client_id: issued.consent.clientId,
    resource: `${f.issuer}/mcp`,
    refresh_token: issued.refresh_token,
  };
  assert.equal(
    (await f.request('/oauth/token', { ...data, scope: 'admin' }, { form: true })).status,
    400
  );
  assert.equal(
    (
      await f.request(
        '/oauth/token',
        { ...data, resource: 'https://wrong.example/mcp' },
        { form: true }
      )
    ).status,
    400
  );
  const refreshed = await f.request(
    '/oauth/token',
    { ...data, scope: 'schedules:read' },
    { form: true }
  );
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.notEqual(refreshed.json.refresh_token, issued.refresh_token);
  assert.equal(
    (await f.request('/mcp', undefined, { bearer: refreshed.json.access_token })).status,
    200
  );
  assert.equal(
    (await f.request('/mcp/write', undefined, { bearer: refreshed.json.access_token })).status,
    403
  );
  const escalation = await f.request(
    '/oauth/token',
    {
      ...data,
      refresh_token: refreshed.json.refresh_token,
      scope: 'schedules:read schedules:write',
    },
    { form: true }
  );
  assert.equal(escalation.status, 400);
  const replay = await f.request('/oauth/token', data, { form: true });
  assert.equal(replay.status, 400);
  assert.equal(
    (await f.request('/mcp', undefined, { bearer: refreshed.json.access_token })).status,
    401
  );
  assert.equal((await f.request('/mcp', undefined, { bearer: issued.access_token })).status, 401);
});

test('write-only tokens can initialize MCP while read operations remain denied', async (t) => {
  const f = await fixture(t);
  const issued = await f.grant({ scope: 'schedules:write' });
  assert.equal((await f.request('/mcp', undefined, { bearer: issued.access_token })).status, 200);
  assert.equal(
    (await f.request('/mcp/write', undefined, { bearer: issued.access_token })).status,
    200
  );
  assert.equal(
    (await f.request('/mcp/read', undefined, { bearer: issued.access_token })).status,
    403
  );
  f.db.prepare('UPDATE auth_grants SET resource=?').run('https://other.example/mcp');
  assert.equal((await f.request('/mcp', undefined, { bearer: issued.access_token })).status, 401);
});

test('OAuth revocation and owner disconnect invalidate access and refresh tokens', async (t) => {
  const f = await fixture(t);
  const issued = await f.grant();
  const other = await f.register();
  assert.equal(
    (
      await f.request(
        '/oauth/revoke',
        { client_id: other, token: issued.access_token },
        { form: true }
      )
    ).status,
    200
  );
  assert.equal((await f.request('/mcp', undefined, { bearer: issued.access_token })).status, 200);
  assert.equal(
    (
      await f.request(
        '/oauth/revoke',
        { client_id: issued.consent.clientId, token: issued.access_token },
        { form: true }
      )
    ).status,
    200
  );
  assert.equal((await f.request('/mcp', undefined, { bearer: issued.access_token })).status, 401);
  const newer = await f.grant({ clientId: issued.consent.clientId });
  const login = await f.request(
    '/auth/login',
    { passphrase: PASSWORD },
    { headers: { Origin: f.issuer } }
  );
  const connections = await f.request('/auth/connections', undefined, { cookie: login.cookie });
  assert.equal(connections.status, 200);
  assert.equal(connections.json.connections.length, 1);
  const revoke = await f.request(
    '/auth/revoke',
    { grantId: connections.json.connections[0].id },
    { cookie: login.cookie, headers: { Origin: f.issuer } }
  );
  assert.equal(revoke.status, 200);
  assert.equal((await f.request('/mcp', undefined, { bearer: newer.access_token })).status, 401);
  const refresh = await f.request(
    '/oauth/token',
    {
      grant_type: 'refresh_token',
      client_id: newer.consent.clientId,
      resource: `${f.issuer}/mcp`,
      refresh_token: newer.refresh_token,
    },
    { form: true }
  );
  assert.equal(refresh.status, 400);
});

test('hashed credentials persist across restart; password changes invalidate all sessions and grants', async (t) => {
  const f = await fixture(t);
  const issued = await f.grant();
  const login = await f.request(
    '/auth/login',
    { passphrase: PASSWORD },
    { headers: { Origin: f.issuer } }
  );
  const rows = JSON.stringify({
    tokens: f.db.prepare('SELECT * FROM auth_tokens').all(),
    codes: f.db.prepare('SELECT * FROM auth_codes').all(),
    sessions: f.db.prepare('SELECT * FROM auth_sessions').all(),
  });
  assert.ok(!rows.includes(issued.access_token));
  assert.ok(!rows.includes(issued.refresh_token));
  assert.ok(!rows.includes(issued.approved.code));
  assert.ok(!rows.includes(PASSWORD));
  f.rebuild();
  assert.equal((await f.request('/mcp', undefined, { bearer: issued.access_token })).status, 200);
  assert.equal((await f.request('/api/private', undefined, { cookie: login.cookie })).status, 200);
  f.rebuild('changed-fixture-passphrase-2026');
  assert.equal((await f.request('/mcp', undefined, { bearer: issued.access_token })).status, 401);
  assert.equal((await f.request('/api/private', undefined, { cookie: login.cookie })).status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM auth_clients').get().count, 1);
});

test('brute force is rate-limited and duplicate token parameters are rejected', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(
      (await f.request('/auth/login', { passphrase: 'wrong' }, { headers: { Origin: f.issuer } }))
        .status,
      401
    );
  }
  const limited = await f.request(
    '/auth/login',
    { passphrase: PASSWORD },
    { headers: { Origin: f.issuer } }
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
  f.advance(900001);
  assert.equal(
    (await f.request('/auth/login', { passphrase: PASSWORD }, { headers: { Origin: f.issuer } }))
      .status,
    200
  );
  const duplicate = await f.request(
    '/oauth/token',
    {},
    { form: true, raw: 'client_id=a&client_id=b' }
  );
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.json.error, 'invalid_request');
});
