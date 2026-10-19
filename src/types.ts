import type { UserRow } from './db.js'
export type AppEnv = { Variables: { user: UserRow | null; session: { id: string; expiresAt: number } | undefined } }
