import { drizzle } from 'drizzle-orm/d1'
import { sql } from 'drizzle-orm'
import type { D1Database } from '@cloudflare/workers-types'

// Postgres (postgres-js) + Drizzle
import pkg from 'pg'
const { Pool } = pkg
import type { Pool as PgPool, PoolClient } from 'pg'

export function getD1(d1: D1Database) {
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

// Postgres helper: create a postgres-js client and a Drizzle adapter
export function getPgPool(databaseUrl: string): PgPool {
  return new Pool({ connectionString: databaseUrl })
}

/**
 * Optional: if Drizzle's Postgres adapter is available in this environment, you can create a Drizzle instance.
 * This function will attempt a dynamic import of a Drizzle Postgres adapter and return it; if not available, it throws.
 */
export async function getPgDrizzleIfAvailable(pool: PgPool) {
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
async function ensureUsersTablePg(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id bigint PRIMARY KEY,
      login text NOT NULL,
      name text,
      avatar_url text
    );
  `)
}

export async function upsertUserPgRaw(pool: PgPool, user: { id: number; login: string; name?: string | null; avatar_url?: string | null }) {
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
export async function getUserByIdPgRaw(pool: PgPool, id: number) {
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
export async function getUserByLoginPgRaw(pool: PgPool, login: string) {
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
