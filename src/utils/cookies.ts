import { HTTPException } from 'hono/http-exception'

import type { HonoContext, AppContext } from '../types'

export const COOKIE_NAME = 'user_session'
export const COOKIE_MAX_AGE = 60 * 60 * 24 // 1 day

/**
 * Resolve cookie secret from either a Hono context (has `env`) or a tRPC/AppContext-style object.
 */
export function ensureCookieSecret(c: HonoContext | AppContext | any) {
  const envAny = (c as any).env ?? (c as any)
  if (!envAny.COOKIE_SECRET) {
    throw new HTTPException(500, { message: 'Cookie secret is not configured' })
  }
  return envAny.COOKIE_SECRET
}

export function isSecureRequest(c: HonoContext) {
  const forwardedProto = c.req.header('x-forwarded-proto')
  if (forwardedProto) {
    const proto = forwardedProto.split(',')[0]?.trim().toLowerCase()
    if (proto) return proto === 'https'
  }
  return c.req.url.startsWith('https://')
}
