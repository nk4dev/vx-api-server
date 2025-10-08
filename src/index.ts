import { Hono } from 'hono'
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'

type Bindings = {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  AUTH_HOST: string
  COOKIE_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

// --- 環境変数 (本来は.envファイルや環境設定で管理) ---
// ステップ1で取得した自身のClient IDとClient Secretに置き換えてください

// --- 型定義 ---
type GitHubUser = {
  login: string;
  id: number;
  avatar_url: string;
  name: string;
  email: string | null;
}

type tokenDataType = {
  error?: string;
  error_description?: string;
  access_token: string;
  token_type: string;
  scope: string;
}

// --- ルーティング ---

// 1. ユーザーをGitHub認証ページにリダイレクト
app.get('/auth', (c) => {
  //console.log({GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_HOST, COOKIE_SECRET});
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    throw new HTTPException(500, { message: 'GitHub OAuth credentials are not configured https://www.google.com/search?q=GitHub+OAuth+credentials+are+not+configured'})
  }
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${c.env.AUTH_HOST}/auth/github/callback`,
    scope: 'read:user user:email', // 必要な権限を要求
    response_type: 'code',
  })
  const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`
  return c.redirect(authUrl)
})

// 2. GitHubからのコールバックを処理
app.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) {
    throw new HTTPException(400, { message: 'Authorization code is missing' })
  } 

  try {
    // 2a. codeを使ってアクセストークンを取得
    const tokenResponse = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
        }),
      }
    )

    const tokenData = await tokenResponse.json() as tokenDataType
    if (tokenData.error) {
      throw new Error(tokenData.error_description)
    }
    const accessToken = tokenData.access_token

    // 2b. アクセストークンを使ってGitHubユーザー情報を取得
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Hono-App', // GitHub APIではUser-Agentが必須
      },
    })
    const githubUser = await userResponse.json() as GitHubUser

    // 2c. 必要なユーザー情報だけをセッションデータとして定義
    const sessionData = {
        id: githubUser.id,
        login: githubUser.login,
        name: githubUser.name,
        avatar_url: githubUser.avatar_url,
    }

    // 2d. ユーザー情報を署名付きCookieに保存
    await setSignedCookie(c, 'user_session', JSON.stringify(sessionData), c.env.COOKIE_SECRET, {
      path: '/',
      httpOnly: true, // JavaScriptからアクセスできないようにする
      secure: c.req.url.startsWith('httpss'), // 本番環境(HTTPS)ではtrue
      sameSite: 'Lax', // CSRF対策
      maxAge: 60 * 60 * 24, // 1日間有効
    })

    // 認証成功後、フロントエンドのダッシュボードなどにリダイレクト
    return c.redirect('/auth/me')

  } catch (error) {
    console.error('GitHub auth callback error:', error)
    throw new HTTPException(500, { message: 'Internal Server Error during authentication' })
  }
})

// 3. 認証済みユーザー情報を返すAPIエンドポイント
app.get('/auth/me', async (c) => {
  const sessionCookie = await getSignedCookie(c, c.env.COOKIE_SECRET, 'user_session')

  if (!sessionCookie) {
    // 未認証の場合はエラーレスポンス
    return c.json({ error: 'Not authenticated' }, 401)
  }

  try {
    const userData = JSON.parse(sessionCookie)
    return c.json({ user: userData })
  } catch (error) {
    // Cookieのパースに失敗した場合
    return c.json({ error: 'Invalid session data' }, 400)
  }
})

// 4. ログアウト
app.get('/logout', (c) => {
    deleteCookie(c, 'user_session', { path: '/' });
    return c.json({ message: 'Logged out successfully' });
});

app.get('/health', (c) => c.json({ status: 'ok' }))


// ルート: ログイン状態に応じてメッセージを表示
app.get('/', async (c) => {
    const sessionCookie = await getSignedCookie(c, c.env.COOKIE_SECRET, 'user_session');
    if (sessionCookie) {
        const user = JSON.parse(sessionCookie);
        return c.html(`
            <h1>Welcome, ${user.name || user.login}!</h1>
            <p>You are logged in.</p>
            <a href="/auth/me">View My Data</a> | <a href="/logout">Logout</a>
        `);
    }
})


export default app
// Remove this entire function - fetch is a global Web API

