import type { GitHubUser, StoredUser } from '../types'
import { normalizeUser } from './user'

export const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'VX-API-Server',
} as const

export async function fetchUserFromGitHubByLogin(login: string): Promise<StoredUser | null> {
  if (!login) return null
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: GITHUB_HEADERS,
    })
    if (!response.ok) return null
    const data = await response.json() as GitHubUser
    return normalizeUser(data)
  } catch (err) {
    console.error('GitHub lookup by login failed:', err)
    return null
  }
}

export async function fetchUserFromGitHubById(id: number): Promise<StoredUser | null> {
  if (!Number.isFinite(id)) return null
  try {
    const response = await fetch(`https://api.github.com/user/${id}`, {
      headers: GITHUB_HEADERS,
    })
    if (!response.ok) return null
    const data = await response.json() as GitHubUser
    return normalizeUser(data)
  } catch (err) {
    console.error('GitHub lookup by id failed:', err)
    return null
  }
}
