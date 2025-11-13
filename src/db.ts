import { drizzle } from 'drizzle-orm/d1'
import { sql } from 'drizzle-orm'
import type { D1Database } from '@cloudflare/workers-types'
import { nanoid } from 'nanoid'

function generateNanoId(): string {
  return nanoid(21);
}

function generateUUID(): string {
  // Simple UUIDv4 generator
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  })
}

/**
 * Register routes for:
 *  - /eth/gas  (delegates to services/eth/gas.handleGas)
 *  - /projects and nested /todos routes (basic Postgres-backed CRUD)
 *
 * Notes:
 * - Expects a Postgres connection string in process.env.DATABASE_URL.
 * - Creates simple `projects` and `todos` tables if they don't exist.
 * - Uses node-postgres Pool via getPgPool().
 *
 * This file focuses on wiring + minimal implementations. It is intentionally
 * small and defensive; production usage should add validation, pagination
 * improvements, prepared migrations, connection lifecycle handling, and tests.
 */

type AnyObj = Record<string, any>;
type ProjectResp = AnyObj & { todos?: AnyObj[] };

const DEFAULT_DB = "postgres://postgres:postgres@localhost:5432/postgres";

function ensureTables(client: any) {
  // Creates simple projects & todos tables if missing.
  // - projects.id is text (UUID)
  // - todos.id is text (UUID) and references projects(id)
  return client.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY,
      project_id text NOT NULL UNIQUE,
      project_name text NOT NULL,
      description text,
      website text,
      node_endpoint text,
      creator text NOT NULL,
      currencies jsonb NOT NULL DEFAULT '[]'::jsonb,
      features jsonb,
      title text,
      owner_id text,
      due_date date,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS todos (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title text NOT NULL,
      "order" integer,
      done boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users_auth (
      id text PRIMARY KEY,
      username text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      email text,
      name text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
  `);
}

function getD1(d1: D1Database) {
  return drizzle(d1)
}

/** Ensure the users table exists and upsert the user record for D1. */
async function ensureUsersTableD1(db: ReturnType<typeof getD1>) {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      login TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT
    );
  `)
}

export async function upsertUserD1(db: ReturnType<typeof getD1>, user: { id: number; login: string; name?: string | null; avatar_url?: string | null }) {
  await ensureUsersTableD1(db)

  // Insert or replace user by primary key
  await db.run(sql`
    INSERT OR REPLACE INTO users (id, login, name, avatar_url)
    VALUES (${user.id}, ${user.login}, ${user.name ?? null}, ${user.avatar_url ?? null});
  `)
}

// Postgres helper: create a node-postgres Pool via dynamic import.
// This avoids importing 'pg' at module initialization time which breaks
// bundling for Cloudflare Workers / Miniflare.
async function getPgPool(databaseUrl: string): Promise<any> {
  const mod = await import('pg');
  const { Pool } = mod as any;
  return new Pool({ connectionString: databaseUrl });
}

/**
 * Optional: if Drizzle's Postgres adapter is available in this environment, you can create a Drizzle instance.
 * This function will attempt a dynamic import of a Drizzle Postgres adapter and return it; if not available, it throws.
 */
export async function getPgDrizzleIfAvailable(pool: any) {
  try {
    // Newer Drizzle versions have an adapter under 'drizzle-orm/pg' or 'drizzle-orm/postgres-js'.
    // Try both possibilities.
    try {
      // @ts-ignore - optional adapter may not be installed in all environments
      const mod = await import('drizzle-orm/pg')
      const { drizzle: drizzlePg } = mod as any
      return drizzlePg(pool as any)
    } catch (_) {
      try {
        // @ts-ignore - optional adapter may not be installed in all environments
        const mod = await import('drizzle-orm/postgres-js')
        const { drizzle: drizzlePg } = mod as any
        return drizzlePg(pool as any)
      } catch (_) {
        throw new Error('Drizzle Postgres adapter not available')
      }
    }
  } catch (err) {
    throw new Error('Drizzle Postgres adapter not available')
  }
}

/** Upsert user into Postgres using node-postgres (raw SQL). */
async function ensureUsersTablePg(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id bigint PRIMARY KEY,
      login text NOT NULL,
      name text,
      avatar_url text
    );
  `)
}

export async function upsertUserPgRaw(pool: any, user: { id: number; login: string; name?: string | null; avatar_url?: string | null }) {
  const client = await pool.connect()
  try {
    await ensureUsersTablePg(client)

    await client.query(
      `INSERT INTO users (id, login, name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         login = EXCLUDED.login,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url;`,
      [user.id, user.login, user.name ?? null, user.avatar_url ?? null]
    )
  } finally {
    client.release()
  }
}

/** Get user by id from D1. Returns null if not found. */
export async function getUserByIdD1(db: ReturnType<typeof getD1>, id: number) {
  try {
    await ensureUsersTableD1(db)
    const result = await db.all(sql`
      SELECT id, login, name, avatar_url FROM users WHERE id = ${id} LIMIT 1
    `)
    const rows = Array.isArray((result as any)?.results) ? (result as any).results : (result as any)
    return (rows && rows[0]) ? rows[0] : null
  } catch (err: any) {
    const message = typeof err?.message === 'string' ? err.message : ''
    if (message.includes('no such table')) {
      return null
    }
    throw err
  }
}

/** Get user by id from Postgres (raw). Returns null if not found. */
export async function getUserByIdPgRaw(pool: any, id: number) {
  const client = await pool.connect()
  try {
    await ensureUsersTablePg(client)
    const res = await client.query('SELECT id, login, name, avatar_url FROM users WHERE id = $1 LIMIT 1', [id])
    return res.rows[0] ?? null
  } catch (err: any) {
    // 42P01: undefined_table – treat as not found
    if (err?.code === '42P01') {
      return null
    }
    throw err
  } finally {
    client.release()
  }
}

/** Get user by login from D1. Returns null if not found. */
export async function getUserByLoginD1(db: ReturnType<typeof getD1>, login: string) {
  try {
    await ensureUsersTableD1(db)
    const result = await db.all(sql`
      SELECT id, login, name, avatar_url FROM users WHERE login = ${login} COLLATE NOCASE LIMIT 1
    `)
    const rows = Array.isArray((result as any)?.results) ? (result as any).results : (result as any)
    return (rows && rows[0]) ? rows[0] : null
  } catch (err: any) {
    const message = typeof err?.message === 'string' ? err.message : ''
    if (message.includes('no such table')) {
      return null
    }
    throw err
  }
}

/** Get user by login from Postgres (raw). Returns null if not found. */
export async function getUserByLoginPgRaw(pool: any, login: string) {
  const client = await pool.connect()
  try {
    await ensureUsersTablePg(client)
    const res = await client.query('SELECT id, login, name, avatar_url FROM users WHERE login = $1 LIMIT 1', [login])
    return res.rows[0] ?? null
  } catch (err: any) {
    if (err?.code === '42P01') {
      return null
    }
    throw err
  } finally {
    client.release()
  }
}

/** Ensure the users_auth table exists in Postgres. */
async function ensureUsersAuthTablePg(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users_auth (
      id text PRIMARY KEY,
      username text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      email text,
      name text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
  `)
}

/** Register a new user in Postgres. Returns the user ID on success. */
export async function registerUserPgRaw(
  pool: any,
  username: string,
  passwordHash: string,
  email?: string,
  name?: string
): Promise<string> {
  const client = await pool.connect()
  try {
    await ensureUsersAuthTablePg(client)
    
    const userId = generateNanoId()
    await client.query(
      `INSERT INTO users_auth (id, username, password_hash, email, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [userId, username, passwordHash, email ?? null, name ?? null]
    )
    return userId
  } finally {
    client.release()
  }
}

/** Get user by username from Postgres. Returns null if not found. */
export async function getUserByUsernamePgRaw(pool: any, username: string) {
  const client = await pool.connect()
  try {
    await ensureUsersAuthTablePg(client)
    const res = await client.query(
      'SELECT id, username, email, name, created_at FROM users_auth WHERE username = $1 LIMIT 1',
      [username]
    )
    return res.rows[0] ?? null
  } finally {
    client.release()
  }
}

export type { AnyObj, ProjectResp };
export { generateNanoId, getD1, getPgPool, ensureTables, ensureUsersTableD1, DEFAULT_DB, generateUUID };