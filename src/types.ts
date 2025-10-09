import type { Context } from 'hono'
import type { D1Database } from '@cloudflare/workers-types'

export type Bindings = {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  AUTH_HOST: string
  COOKIE_SECRET: string
  DB?: D1Database
  DATABASE_URL?: string
}

export type AppContext = Context<{ Bindings: Bindings }>

export type GitHubUser = {
  login: string
  id: number
  avatar_url: string
  name: string | null
  email: string | null
}

export type TokenData = {
  error?: string
  error_description?: string
  access_token: string
  token_type: string
  scope: string
}

export type StoredUser = {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
}

export type BodyPayload = Record<string, unknown>
