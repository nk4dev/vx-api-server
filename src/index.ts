import { Hono } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { D1Database } from "@cloudflare/workers-types";
import { ethGasService } from "./services/gas/eth";

import type { Bindings, GitHubUser, TokenData, StoredUser } from "./types";
import {
  ensureCookieSecret,
  isSecureRequest,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
} from "./utils/cookies";
import { handleAuthLogin, handleAuthStatus } from "./handlers/auth";
import { fetchUserFromGitHubById } from "./utils/github";
// registerRoutes is dynamically imported below to avoid pulling Node-only modules
// (like 'pg' or Node 'crypto') into the Cloudflare Workers bundle.

const app = new Hono<{ Bindings: Bindings }>();

const DEFAULT_DASHBOARD_REDIRECT = "https://api.varius.technology/";

// another apis
app.route("/eth", ethGasService);

// auth api
// api.routes("/auth", authService);
async function persistUserBestEffort(env: Bindings, user: StoredUser) {
  if ((env as any).DB) {
    try {
      const { getD1, upsertUserD1 } = await import("./db");
      const db = getD1((env as any).DB as D1Database);
      await upsertUserD1(db, user);
    } catch (err) {
      console.error("Persist to D1 failed (best-effort):", err);
    }
  }

  if ((env as any).DATABASE_URL) {
    try {
      const { getPgPool, upsertUserPgRaw } = await import("./db");
      const pool = await getPgPool((env as any).DATABASE_URL as string);
      try {
        await upsertUserPgRaw(pool, user);
      } finally {
        try {
          pool.end?.();
        } catch (_) { }
      }
    } catch (err) {
      console.error("Persist to Postgres failed (best-effort):", err);
    }
  }
}

// for debug logging on terminal
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const path = (c.req as any).path ?? url.pathname;
  const pathWithQuery = `${path}${url.search}`;
  const envmode: string | null  = process.env.NODE_ENV === 'development' ? 'development' : null;
  if (c.req.method === "GET" && process.env.NODE_ENV === 'development') {
    console.log(` \x1b[32mGET\x1b[0m [path] => ${pathWithQuery} (env: ${envmode})`);
  } else if (c.req.method === "POST" && process.env.NODE_ENV === 'development') {
    console.log(` \x1b[34mPOST\x1b[0m [path] => ${pathWithQuery} (env: ${envmode})`);
  } else if (process.env.NODE_ENV === 'development') {
    console.log(`\n Method => ${c.req.method} \n [path] => ${pathWithQuery} (env: ${envmode})`);
  } else {
    null;
  }
  await next();
});

// --- ルーティング ---

// auth api handler
// 1. ユーザーをGitHub認証ページにリダイレクト
app.get("/auth", (c) => {
  //console.log({GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_HOST, COOKIE_SECRET});
  const redirectRaw = c.req.query("redirect_url");
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    throw new HTTPException(500, {
      message:
        "GitHub OAuth credentials are not configured https://www.google.com/search?q=GitHub+OAuth+credentials+are+not+configured",
    });
  }
  const callbackUrl = new URL("/auth/github/callback", c.env.AUTH_HOST);
  if (redirectRaw && redirectRaw.trim().length > 0) {
    callbackUrl.searchParams.set("url", encodeURIComponent(redirectRaw));
  }

  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl.toString(),
    scope: "read:user user:email", // 必要な権限を要求
    response_type: "code",
  });
  if (redirectRaw && redirectRaw.trim().length > 0) {
    params.set("send", redirectRaw);
  }
  const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
  return c.redirect(authUrl);
});

// 2. GitHubからのコールバックを処理
app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const requestedRaw = c.req.query("send");
  const encodedUrlParam = c.req.query("url");
  if (!code) {
    throw new HTTPException(400, { message: "Authorization code is missing" });
  }

  try {
    // 2a. codeを使ってアクセストークンを取得
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
        }),
      },
    );

    const tokenData = (await tokenResponse.json()) as TokenData;
    if (tokenData.error) {
      throw new Error(tokenData.error_description);
    }
    const accessToken = tokenData.access_token;

    // 2b. Use the access token to fetch GitHub user information
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Hono-App", // GitHub APIではUser-Agentが必須
      },
    });
    const githubUser = (await userResponse.json()) as GitHubUser;

    // 2c. Define only the necessary user information as session data
    const sessionData = {
      id: githubUser.id,
      login: githubUser.login,
      name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    };

    // 2d. Save user information in a signed cookie
    const cookieSecret = ensureCookieSecret(c);
    await setSignedCookie(
      c,
      COOKIE_NAME,
      JSON.stringify(sessionData),
      cookieSecret,
      {
        path: "/",
        httpOnly: true, // Block JavaScript access
        secure: isSecureRequest(c), // true in production (HTTPS)
        sameSite: "Lax", // CSRF protection
        maxAge: COOKIE_MAX_AGE, // Valid for 1 day
      },
    );

    // 2e. Persist GitHub user to D1 via Drizzle (best-effort). If DB binding is not present, skip.
    try {
      if ((c.env as any).DB) {
        const { getD1, upsertUserD1 } = await import("./db");
        const db = getD1((c.env as any).DB as D1Database);
        await upsertUserD1(db, {
          id: githubUser.id,
          login: githubUser.login,
          name: githubUser.name,
          avatar_url: githubUser.avatar_url,
        });
      }

      // If a DATABASE_URL is provided (e.g., Postgres/Neon), also persist there.
      if ((c.env as any).DATABASE_URL) {
        const { getPgPool, upsertUserPgRaw } = await import("./db");
        const pool = await getPgPool((c.env as any).DATABASE_URL as string);
        try {
          await upsertUserPgRaw(pool, {
            id: githubUser.id,
            login: githubUser.login,
            name: githubUser.name,
            avatar_url: githubUser.avatar_url,
          });

          const baseRedirect = (() => {
            if (requestedRaw && requestedRaw.length > 0) return requestedRaw;
            if (encodedUrlParam && encodedUrlParam.length > 0) {
              try {
                return decodeURIComponent(encodedUrlParam);
              } catch (_) {
                /* ignore */
              }
            }
            return DEFAULT_DASHBOARD_REDIRECT;
          })();

          return c.redirect(
            "/redirect?url=" +
            encodeURIComponent(baseRedirect) +
            "&user=" +
            githubUser.id,
          );
          //return c.redirect('/redirect?user_id=1&url=' + encodeURIComponent('http://localhost:8787/users/' + githubUser.id))
        } finally {
          try {
            pool.end();
          } catch (_) { }
        }
      }
    } catch (dbErr) {
      console.error("DB upsert failed:", dbErr);
      // don't break auth flow on DB errors
    }

    // when successful, redirect to frontend dashboard
    const baseRedirect = (() => {
      if (requestedRaw && requestedRaw.length > 0) return requestedRaw;
      if (encodedUrlParam && encodedUrlParam.length > 0) {
        try {
          return decodeURIComponent(encodedUrlParam);
        } catch (_) {
          /* ignore */
        }
      }
      return DEFAULT_DASHBOARD_REDIRECT;
    })();
    return c.redirect(
      "/redirect?url=" +
      encodeURIComponent(baseRedirect) +
      "&user=" +
      githubUser.id,
    );
    //return c.redirect('/redirect?user_id=1&url=' + encodeURIComponent('http://localhost:8787/users/' + githubUser.id))
  } catch (error) {
    console.error("GitHub auth callback error:", error);
    throw new HTTPException(500, {
      message: "Internal Server Error during authentication",
    });
  }
});

app.post("/auth/login", handleAuthLogin);
app.post("/auth/status", handleAuthStatus);
//app.get('/w3/gas', handleAuthStatus)

app.get("/redirect", async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl) {
    return c.text("Missing url parameter", 400);
  }

  try {
    let destString = rawUrl.trim();
    if (!destString) {
      return c.text("Invalid url parameter", 400);
    }

    let userParam = c.req.query("user")?.trim() ?? "";
    const isLikelyId = /^[0-9]+$/.test(destString);
    if (isLikelyId) {
      if (!userParam) {
        userParam = destString;
      }
      destString = DEFAULT_DASHBOARD_REDIRECT;
    }

    const baseForRelative = (() => {
      try {
        return new URL(DEFAULT_DASHBOARD_REDIRECT);
      } catch (_) {
        return new URL(c.req.url);
      }
    })();

    const dest = new URL(destString, baseForRelative);
    if (!/^https?:$/i.test(dest.protocol)) {
      return c.text("Invalid url parameter", 400);
    }

    if (userParam) {
      dest.searchParams.set("user", userParam);
    } else if (
      !dest.searchParams.has("user") &&
      dest.searchParams.has("user_id")
    ) {
      const existing = dest.searchParams.get("user_id");
      if (existing) dest.searchParams.set("user", existing);
    }

    return c.redirect(dest.toString());
  } catch (e) {
    return c.text("Invalid url parameter", 400);
  }
});
// 3. 認証済みユーザー情報を返すAPIエンドポイント
app.get("/auth/me", async (c) => {
  const cookieSecret = ensureCookieSecret(c);
  const sessionCookie = await getSignedCookie(c, cookieSecret, COOKIE_NAME);

  if (!sessionCookie) {
    // 未認証の場合はエラーレスポンス
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const userData = JSON.parse(sessionCookie);
    return c.json({ user: userData });
  } catch (error) {
    // Cookieのパースに失敗した場合
    return c.json({ error: "Invalid session data" }, 400);
  }
});

// 4. ログアウト
app.get("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ message: "Logged out successfully" });
});

app.get("/version", (c) => c.json({ version: "0.1.2" }));
// ルート: ログイン状態に応じてメッセージを表示
app.get("/", async (c) => {
  const cookieSecret = ensureCookieSecret(c);
  const sessionCookie = await getSignedCookie(c, cookieSecret, COOKIE_NAME);
  const basedContent = `<head><title>VX3 API Server</title></head>VX3 API server <br/> version 0.1.2<br/> `;
  const styles = `
    <style>
      * {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
        font-size: 16px;
        line-height: 1.6;
        color: #333;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
    </style>
  `;
  if (sessionCookie) {
    const user = JSON.parse(sessionCookie);
    return c.html(`
      <html>
            ${styles}
            ${basedContent}
            <h1>Welcome, ${user.name || user.login}!</h1>
            <p>You are logged in.</p>
            <a href="/auth/me">View My Data</a> | <a href="/logout">Logout</a>
            </html>
        `);
  } else {
    return c.html(`
      <html>  

            ${styles}
            ${basedContent}
            <h1>Login with</h1>
            <a href="/auth">Login with GitHub</a>
        </html>`);
  }
});

// Get user by id (REST API)
app.get("/users/:id", async (c) => {
  const idStr = c.req.param("id");
  const id = Number(idStr);
  if (Number.isNaN(id)) {
    return c.json({ error: "Invalid id" }, 400);
  }

  try {
    if ((c.env as any).DB) {
      try {
        const { getD1, getUserByIdD1 } = await import("./db");
        const db = getD1((c.env as any).DB as D1Database);
        const user = await getUserByIdD1(db, id);
        if (user) return c.json({ user });
      } catch (d1Err) {
        console.error("D1 getUser failed:", d1Err);
      }
    }

    if ((c.env as any).DATABASE_URL) {
      try {
        const { getPgPool, getUserByIdPgRaw } = await import("./db");
        const pool = await getPgPool((c.env as any).DATABASE_URL as string);
        try {
          const user = await getUserByIdPgRaw(pool, id);
          if (user) return c.json({ user });
        } finally {
          try {
            pool.end?.();
          } catch (_) { }
        }
      } catch (pgErr) {
        console.error("Postgres getUser failed:", pgErr);
      }
    }

    const fallbackUser = await fetchUserFromGitHubById(id);
    if (fallbackUser) {
      await persistUserBestEffort(c.env, fallbackUser);
      return c.json({ user: fallbackUser });
    }

    return c.json({ error: "User not found" }, 404);
  } catch (err) {
    console.error("Error fetching user:", err);
    return c.json(
      {
        error: "Internal Server Error",
        msg: err,
      },
      500,
    );
  }
});

// Wire additional routes (projects + eth gas endpoints)
(async () => {
  try {
    // Dynamically import registerRoutes so Node-specific modules aren't bundled into the Worker.
    const mod = await import("./routes");
    if (mod && typeof mod.default === "function") {
      // registerRoutes is async; await to make sure routes are registered before serving traffic
      await (mod.default as any)(app as any);
    } else if (mod && typeof mod.registerRoutes === "function") {
      await (mod.registerRoutes as any)(app as any);
    }
  } catch (err) {
    console.error("Failed to register additional routes:", err);
  }
})();

export default app;
// Remove this entire function - fetch is a global Web API
