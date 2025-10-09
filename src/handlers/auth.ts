import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie'

import type { AppContext } from '../types'
import { ensureCookieSecret, isSecureRequest, COOKIE_MAX_AGE, COOKIE_NAME } from '../utils/cookies'
import { readBodyPayload } from '../utils/body'
import { findStoredUser } from '../services/userLookup'
import { normalizeUser } from '../utils/user'

export const handleAuthLogin = async (c: AppContext) => {
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

export const handleAuthStatus = async (c: AppContext) => {
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
