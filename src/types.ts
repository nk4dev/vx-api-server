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

export type CreateProjectPayload = {
  name: string // プロジェクト名（必須）
  projectId: string // プロジェクトID（必須）
  description?: string | null // 説明
  website?: string | null // ウェブサイトページ
  nodeEndpoint?: string | null // ノードエンドポイント
  creator: string | number // 作成者（必須）
  currencies: string[] // 使用する通貨の配列（必須）
  features?: string[] | null // オプション機能用配列
}

export type ProjectRecord = {
  id: string // UUID
  name: string
  project_id: string // ユーザー指定のプロジェクトID
  description: string | null
  website: string | null
  node_endpoint: string | null
  creator: string
  currencies: string[] // JSON配列として保存
  features: string[] | null // JSON配列として保存
  created_at: string
  updated_at: string
}
