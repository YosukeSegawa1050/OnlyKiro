export default function middleware(request) {
  const username = process.env.APP_AUTH_USERNAME;
  const password = process.env.APP_AUTH_PASSWORD;

  // 認証情報が未設定のまま公開されることを防ぐ。
  if (!username || !password) {
    return new Response('認証情報が設定されていません。Vercelの環境変数を設定してください。', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const authorization = request.headers.get('authorization') || '';
  const expected = `Basic ${btoa(`${username}:${password}`)}`;
  if (authorization !== expected) {
    return new Response('ログインが必要です。', {
      status: 401,
      headers: {
        'www-authenticate': 'Basic realm="Hanyu", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }
}

