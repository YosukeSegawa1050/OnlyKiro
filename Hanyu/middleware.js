const AUTH_USERNAME = 'hanyu-owner';
const AUTH_PASSWORD_HASH = '0b1d18d9d25c5bf740d999b2e82839a3396d89d6e5d1c84cd5df9a70617a154b';

function unauthorized() {
  return new Response('ログインが必要です。', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="Hanyu", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export default async function middleware(request) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Basic ')) return unauthorized();

  let credentials;
  try {
    credentials = atob(authorization.slice(6));
  } catch {
    return unauthorized();
  }

  const delimiter = credentials.indexOf(':');
  if (delimiter < 0) return unauthorized();
  const username = credentials.slice(0, delimiter);
  const password = credentials.slice(delimiter + 1);
  if (username !== AUTH_USERNAME || await sha256(password) !== AUTH_PASSWORD_HASH) return unauthorized();
}
