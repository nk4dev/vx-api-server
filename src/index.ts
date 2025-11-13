import { Hono } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { D1Database } from "@cloudflare/workers-types";
import { ethGasService } from "./services/gas/eth";
import { trpcServer } from "@hono/trpc-server";
import { appRouter } from "./trpc-router";

import type { Bindings, TokenData, StoredUser } from "./types";
import {
  ensureCookieSecret,
  isSecureRequest,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
} from "./utils/cookies";
import { handleAuthLogin, handleAuthStatus, handleAuthRegister } from "./handlers/auth";
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

// CORS middleware: allow requests from the frontend dev origin (supports credentials)
app.use("*", async (c, next) => {
  const origin = c.req.header('origin') || '';
  // allowlist for local development
  const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  // Preflight handling
  if (c.req.method === 'OPTIONS') {
    // Return empty 204 for preflight. Cast to any to satisfy typings.
    return c.text('', 204 as any);
  }

  await next();
});

// --- ルーティング ---

app.post("/auth/login", handleAuthLogin);
app.post("/auth/register", handleAuthRegister);
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
            <h1>VX3 API Server</h1>
            <p>Please use the API endpoints to authenticate and access resources.</p>
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

// Mount tRPC router
app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    createContext: () => {
      return {
        DATABASE_URL: process.env.DATABASE_URL,
        DB: undefined,
      };
    },
  })
);

export default app;
