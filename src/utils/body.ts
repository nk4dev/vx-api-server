import type { AppContext, BodyPayload } from '../types'

const malformedJsonFixer = /,\s*"([^"\\]+)"\s*,\s*"/g

function tryParseJsonLoose(raw: string): BodyPayload | null {
  const attempts = [raw]
  const patched = raw.replace(malformedJsonFixer, ',"$1": "')
  if (patched !== raw) attempts.push(patched)

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') {
        return parsed as BodyPayload
      }
    } catch {
      // continue trying other candidates
    }
  }
  return null
}

function paramsToObject(params: URLSearchParams): BodyPayload {
  const obj: BodyPayload = {}
  for (const [key, value] of params.entries()) {
    if (!(key in obj)) {
      obj[key] = value
    } else {
      const existing = obj[key]
      if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        obj[key] = [existing, value]
      }
    }
  }
  return obj
}

export async function readBodyPayload(c: AppContext): Promise<BodyPayload> {
  const rawBody = await c.req.text()
  if (!rawBody) return {}
  const trimmed = rawBody.trim()
  if (!trimmed) return {}

  const contentType = (c.req.header('content-type') || '').toLowerCase()

  if (contentType.includes('application/json') || contentType.includes('text/json')) {
    const parsed = tryParseJsonLoose(trimmed)
    if (parsed) return parsed
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(trimmed)
    const obj = paramsToObject(params)
    if (Object.keys(obj).length > 0) return obj
  }

  const fallbackJson = tryParseJsonLoose(trimmed)
  if (fallbackJson) return fallbackJson

  const params = new URLSearchParams(trimmed.replace(/^\?/, ''))
  const obj = paramsToObject(params)
  if (Object.keys(obj).length > 0) return obj

  return {}
}
