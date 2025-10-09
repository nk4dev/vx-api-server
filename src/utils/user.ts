import type { StoredUser } from '../types'

export function normalizeUser(user: any): StoredUser | null {
  if (!user || typeof user !== 'object') return null
  const numericId = Number((user as any).id)
  if (!Number.isFinite(numericId)) return null
  const login = (user as any).login
  if (!login) return null
  return {
    id: numericId,
    login: String(login),
    name: typeof (user as any).name === 'string' ? (user as any).name : null,
    avatar_url: typeof (user as any).avatar_url === 'string' ? (user as any).avatar_url : null,
  }
}
