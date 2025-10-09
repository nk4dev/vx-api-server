import { HTTPException } from 'hono/http-exception'

import type { AppContext } from '../types'

export const COOKIE_NAME = 'user_session'
export const COOKIE_MAX_AGE = 60 * 60 * 24 // 1 day

export function ensureCookieSecret(c: AppContext) {
  if (!c.env.COOKIE_SECRET) {
    throw new HTTPException(500, { message: 'Cookie secret is not configured' })
  }
  return c.env.COOKIE_SECRET
}

export function isSecureRequest(c: AppContext) {
  const forwardedProto = c.req.header('x-forwarded-proto')
  if (forwardedProto) {
    const proto = forwardedProto.split(',')[0]?.trim().toLowerCase()
    if (proto) return proto === 'https'
  }
  return c.req.url.startsWith('https://')
}
