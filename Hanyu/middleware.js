const AUTH_USERNAME = 'hanyu-owner';
const AUTH_PASSWORD_HASH = '0b1d18d9d25c5bf740d999b2e82839a3396d89d6e5d1c84cd5df9a70617a154b';
const SESSION_COOKIE = 'hanyu_auth';

function getCookie(request, name) {
  const prefix = `${name}=`;
  return (request.headers.get('cookie') || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(prefix))?.slice(prefix.length) || '';
}

function loginPage(error = '') {
  const message = error ? '<p class="error">ユーザー名またはパスワードが違います。</p>' : '';
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ログイン | 中国語単語帳</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ff;font-family:system-ui,sans-serif;color:#312e81}.card{box-sizing:border-box;width:min(90vw,360px);padding:28px;background:#fff;border-radius:18px;box-shadow:0 12px 32px #312e8122}h1{margin:0 0 6px;font-size:24px}p{color:#6b7280;font-size:14px}.error{color:#dc2626;font-weight:bold}label{display:block;margin-top:16px;font-size:13px;font-weight:bold}input{box-sizing:border-box;width:100%;margin-top:6px;padding:12px;border:1px solid #d1d5db;border-radius:9px;font-size:16px}button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:9px;background:#4f46e5;color:#fff;font-size:15px;font-weight:bold}</style></head><body><main class="card"><h1>🔐 中国語単語帳</h1><p>利用するにはログインしてください。</p>${message}<form method="post" action="/login"><label>ユーザー名<input name="username" autocomplete="username" required autofocus></label><label>パスワード<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">ログイン</button></form></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export default async function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname === '/login') {
    if (request.method !== 'POST') return loginPage();
    const form = await request.formData();
    const username = String(form.get('username') || '');
    const password = String(form.get('password') || '');
    if (username !== AUTH_USERNAME || await sha256(password) !== AUTH_PASSWORD_HASH) return loginPage(true);
    return new Response(null, {
      status: 303,
      headers: {
        location: '/',
        'set-cookie': `${SESSION_COOKIE}=${AUTH_PASSWORD_HASH}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`,
      },
    });
  }

  if (url.pathname === '/logout') {
    return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` } });
  }

  if (getCookie(request, SESSION_COOKIE) === AUTH_PASSWORD_HASH) return;
  return Response.redirect(new URL('/login', request.url), 303);
}
