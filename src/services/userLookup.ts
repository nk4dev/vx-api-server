import type { D1Database } from '@cloudflare/workers-types'

import type { AppContext, StoredUser } from '../types'
import { normalizeUser } from '../utils/user'
import { fetchUserFromGitHubById, fetchUserFromGitHubByLogin } from '../utils/github'

export async function findStoredUser(c: AppContext, identifier: string): Promise<StoredUser | null> {
  const trimmed = identifier?.trim()
  if (!trimmed) return null

  const envAny = c.env as any
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
      const pool = getPgPool(envAny.DATABASE_URL as string)
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

  if (hasNumericId) {
    const viaId = await fetchUserFromGitHubById(idCandidate)
    if (viaId) return viaId
  }

  return await fetchUserFromGitHubByLogin(trimmed)
}
