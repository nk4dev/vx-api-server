import type { D1Database } from '@cloudflare/workers-types'

import type { HonoContext, AppContext, StoredUser } from '../types'
import { normalizeUser } from '../utils/user'

// Accept either a Hono request context or the simplified AppContext used by tRPC.
export async function findStoredUser(c: HonoContext | AppContext, identifier: string): Promise<StoredUser | null> {
  const trimmed = identifier?.trim()
  if (!trimmed) return null

  // Support both context shapes: Hono provides `env`, while AppContext exposes DATABASE_URL/DB at top level.
  const envAny = (c as any).env ?? (c as any)
  const idCandidate = Number(trimmed)
  const hasNumericId = Number.isFinite(idCandidate)

  try {
    if (envAny.DB) {
      const { getD1, getUserByIdD1, getUserByLoginD1 } = await import('../db')
      const db = getD1(envAny.DB as D1Database)
      if (hasNumericId) {
        const found = normalizeUser(await getUserByIdD1(db, idCandidate))
        if (found) return found
      }
      const foundByLogin = normalizeUser(await getUserByLoginD1(db, trimmed))
      if (foundByLogin) return foundByLogin
    }
  } catch (err) {
    console.error('D1 lookup failed:', err)
  }

  try {
    if (envAny.DATABASE_URL) {
      const { getPgPool, getUserByIdPgRaw, getUserByLoginPgRaw } = await import('../db')
      const pool = await getPgPool(envAny.DATABASE_URL as string)
      try {
        if (hasNumericId) {
          const found = normalizeUser(await getUserByIdPgRaw(pool, idCandidate))
          if (found) return found
        }
        const foundByLogin = normalizeUser(await getUserByLoginPgRaw(pool, trimmed))
        if (foundByLogin) return foundByLogin
      } finally {
        try { pool.end() } catch (_) { }
      }
    }
  } catch (err) {
    console.error('Postgres lookup failed:', err)
  }

  return null
}
