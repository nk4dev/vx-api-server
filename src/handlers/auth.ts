import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie'

import type { HonoContext } from '../types'
import { ensureCookieSecret, isSecureRequest, COOKIE_MAX_AGE, COOKIE_NAME } from '../utils/cookies'
import { readBodyPayload } from '../utils/body'
import { findStoredUser } from '../services/userLookup'
import { normalizeUser } from '../utils/user'

/**
 * Simple password hashing using Web Crypto API.
 * WARNING: This is a basic implementation. For production, use proper bcrypt or argon2.
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Verify password against hash.
 */
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password)
  return computed === hash
}

export const handleAuthRegister = async (c: HonoContext) => {
  const payload = await readBodyPayload(c)

  const username = payload?.username
  const password = payload?.password
  const email = payload?.email
  const name = payload?.name

  if (!username || !password) {
    return c.json({ status: 'failed', error: 'username and password are required' }, 400)
  }

  const usernameStr = String(username).trim()
  const passwordStr = String(password).trim()

  if (!usernameStr || !passwordStr) {
    return c.json({ status: 'failed', error: 'username and password cannot be empty' }, 400)
  }

  try {
    if ((c.env as any).DATABASE_URL) {
      const { getPgPool, registerUserPgRaw, getUserByUsernamePgRaw } = await import('../db')
      const pool = await getPgPool((c.env as any).DATABASE_URL as string)
      
      try {
        // Check if user already exists
        const existingUser = await getUserByUsernamePgRaw(pool, usernameStr)
        if (existingUser) {
          return c.json({ status: 'failed', error: 'username already exists' }, 409)
        }

        // Hash password
        const passwordHash = await hashPassword(passwordStr)

        // Register user
        const userId = await registerUserPgRaw(
          pool,
          usernameStr,
          passwordHash,
          email ? String(email).trim() : undefined,
          name ? String(name).trim() : undefined
        )

        return c.json({
          status: 'ok',
          user: {
            id: userId,
            username: usernameStr,
            email: email ? String(email).trim() : null,
            name: name ? String(name).trim() : null,
          },
        }, 201)
      } finally {
        try {
          pool.end?.()
        } catch (_) { }
      }
    } else {
      return c.json({ status: 'failed', error: 'Database not configured' }, 500)
    }
  } catch (err: any) {
    const errMsg = String(err?.message ?? err)
    if (errMsg.includes('duplicate')) {
      return c.json({ status: 'failed', error: 'username already exists' }, 409)
    }
    return c.json({ status: 'failed', error: 'Registration failed', details: errMsg }, 500)
  }
}

export const handleAuthLogin = async (c: HonoContext) => {
  const cookieSecret = ensureCookieSecret(c)
  const payload = await readBodyPayload(c)

  const rawUser = payload?.user
  const identifier = rawUser === undefined || rawUser === null
    ? ''
    : String(rawUser).trim()
  if (!identifier) {
    return c.json({ status: 'faild', error: 'user is required', payload: c.req }, 400)
  }

  const redirectRaw = payload?.redirect_url
  let redirectUrl: string | null = null
  if (redirectRaw != null) {
    const redirectString = String(redirectRaw).trim()
    if (redirectString === '') {
      return c.json({ status: 'faild', error: 'redirect_url must be a non-empty string' }, 400)
    }
    try {
      redirectUrl = redirectString
    } catch (_) {
      return c.json({ status: 'faild', error: 'invalid redirect_url' }, 400)
    }
  }

  const user = await findStoredUser(c, identifier)
  if (!user) {
    return c.json({ status: 'faild', error: 'faild to auth' }, 401)
  }

  await setSignedCookie(c, COOKIE_NAME, JSON.stringify(user), cookieSecret, {
    path: '/',
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: 'Lax',
    maxAge: COOKIE_MAX_AGE,
  })

  const responsePayload: Record<string, unknown> = {
    status: 'ok',
    user,
  }

  const redirectWithUser = (() => {
    if (!redirectUrl) return null
    try {
      const dest = new URL(redirectUrl)
      dest.searchParams.set('user', String(user.id))
      return dest.toString()
    } catch (_) {
      try {
        const dest = new URL(redirectUrl, c.env.AUTH_HOST)
        dest.searchParams.set('user', String(user.id))
        return dest.toString()
      } catch (_) {
        return null
      }
    }
  })()

  responsePayload.redirect = redirectWithUser ?? null

  const authUrl = `${c.env.AUTH_HOST}/auth?user=${encodeURIComponent(identifier)}${redirectUrl ? `&redirect_url=${encodeURIComponent(redirectUrl)}` : ''}`
  responsePayload.authurl = authUrl

  return c.json(responsePayload)
}

export const handleAuthStatus = async (c: HonoContext) => {
  const cookieSecret = ensureCookieSecret(c)
  const payload = await readBodyPayload(c)
  const requestedRaw = payload?.user
  const requestedUser = requestedRaw == null ? null : String(requestedRaw).trim()

  const sessionCookie = await getSignedCookie(c, cookieSecret, COOKIE_NAME)
  if (!sessionCookie) {
    return c.json({ status: 'Not Authenticated', code: 1 }, 401)
  }

  let parsedSession: unknown
  try {
    parsedSession = JSON.parse(sessionCookie)
  } catch (err) {
    console.error('Failed to parse session cookie:', err)
    deleteCookie(c, COOKIE_NAME, { path: '/' })
    return c.json({ status: 'Not Authenticated', code: 1 }, 401)
  }

  const sessionUser = normalizeUser(parsedSession)
  if (!sessionUser) {
    deleteCookie(c, COOKIE_NAME, { path: '/' })
    return c.json({ status: 'Not Authenticated', code: 1 }, 401)
  }

  if (requestedUser) {
    const matches = sessionUser.login === requestedUser || String(sessionUser.id) === requestedUser
    if (!matches) {
      return c.json({ status: 'Not Authenticated', code: 1 }, 403)
    }
  }

  return c.json({ status: 'Authenticated', code: 0 })
}
