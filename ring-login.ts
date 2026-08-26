/**
 * Ring login: email and password, then the two-factor code.
 *
 * Ring hands out a refresh token only at the end of an interactive login, so
 * this has to be a two-step conversation rather than a single call. The same
 * state machine backs both the CLI and the dashboard, so there is one place
 * where credentials are handled and one place that decides a token is dead.
 *
 * Credentials are never stored -- only the resulting refresh token is, and only
 * to .env.
 */
import { RingRestClient } from 'ring-client-api/rest-client'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { ENV_PATH, TOKEN_KEY, upsertEnvValue } from './ring-auth.ts'

export interface LoginStart {
  /** Ring wants a 2FA code; `prompt` is Ring's own wording for where it went. */
  needsTwoFactor: boolean
  prompt?: string
  refreshToken?: string
}

/**
 * A login in progress. Ring ties the 2FA code to the client instance that
 * requested it, so the same object must be used for both steps.
 */
export class LoginSession {
  private client?: RingRestClient
  readonly startedAt = Date.now()

  async begin(email: string, password: string): Promise<LoginStart> {
    if (!email || !password) {
      throw new Error('email and password are both required')
    }
    this.client = new RingRestClient({ email, password })

    try {
      const auth = await this.client.getCurrentAuth()
      return { needsTwoFactor: false, refreshToken: auth.refresh_token }
    } catch (error) {
      // A 2FA challenge is the expected path for essentially every account;
      // the library signals it by setting promptFor2fa rather than by type.
      if (this.client.promptFor2fa) {
        return { needsTwoFactor: true, prompt: this.client.promptFor2fa }
      }
      throw new Error(describeLoginFailure(error))
    }
  }

  async submitCode(code: string): Promise<string> {
    if (!this.client) {
      throw new Error('no login in progress')
    }
    if (!/^\d{4,8}$/.test(code.trim())) {
      throw new Error('the code should be 4-8 digits')
    }
    try {
      const auth = await this.client.getAuth(code.trim())
      return auth.refresh_token
    } catch {
      // Ring does not distinguish a wrong code from an expired one.
      throw new Error('that code was not accepted — check it and try again')
    }
  }
}

function describeLoginFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/access_denied|invalid[_ ]grant|401|Unauthorized/i.test(message)) {
    return 'Ring rejected that email and password'
  }
  if (/verification|too many/i.test(message)) {
    return `Ring refused the attempt: ${message}`
  }
  return message
}

/**
 * Does this error mean the refresh token is dead, as opposed to a transient
 * network or camera problem? Only a dead token warrants telling someone to log
 * in again, so this stays narrow on purpose.
 */
export function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /refresh token is not valid/i.test(message) ||
    /invalid[_ ]grant/i.test(message) ||
    /\b401\b/.test(message)
  )
}

/** Persist a refresh token to .env, preserving everything else in the file. */
export function saveRefreshToken(token: string): string {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  const temp = `${ENV_PATH}.tmp`
  writeFileSync(temp, upsertEnvValue(existing, TOKEN_KEY, token), { mode: 0o600 })
  renameSync(temp, ENV_PATH)
  process.env[TOKEN_KEY] = token
  return ENV_PATH
}
