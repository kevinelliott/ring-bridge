import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RingApi } from 'ring-client-api'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(projectRoot, '.env')
const TOKEN_KEY = 'RING_REFRESH_TOKEN'

/**
 * Read the refresh token from the environment. `npm start` loads .env via
 * node's --env-file-if-exists, so process.env is the single source of truth
 * at startup.
 */
export function loadRefreshToken(): string {
  const token = process.env[TOKEN_KEY]

  if (!token) {
    throw new Error(
      `Missing ${TOKEN_KEY}. Add it to .env and run via \`npm start\`, ` +
        'or export it before running this script.',
    )
  }

  return token
}

/**
 * Rewrite a single key in a .env file, preserving every other line
 * (including comments and unrelated vars) exactly as it was.
 */
function upsertEnvValue(contents: string, key: string, value: string): string {
  const lines = contents.split('\n')
  const keyPattern = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`)
  let replaced = false

  const updated = lines.map((line) => {
    if (!keyPattern.test(line)) {
      return line
    }
    replaced = true
    return `${key}=${value}`
  })

  if (!replaced) {
    // Keep exactly one trailing newline when appending a brand new key.
    if (updated.at(-1) === '') {
      updated.splice(updated.length - 1, 0, `${key}=${value}`)
    } else {
      updated.push(`${key}=${value}`)
    }
  }

  return updated.join('\n')
}

/** Write .env via a temp file + rename so a crash can't truncate the token. */
function writeEnvAtomically(contents: string): void {
  const tempPath = `${ENV_PATH}.tmp`
  writeFileSync(tempPath, contents, { mode: 0o600 })
  renameSync(tempPath, ENV_PATH)
}

/**
 * Ring rotates the refresh token on every auth refresh and invalidates the
 * previous one. Without persisting the new value, .env goes stale and the
 * next cold start fails with a 401. Subscribing here writes each rotation
 * back to disk.
 *
 * Returns an unsubscribe function.
 */
export function persistRefreshTokenUpdates(ringApi: RingApi): () => void {
  const subscription = ringApi.onRefreshTokenUpdated.subscribe(
    ({ oldRefreshToken, newRefreshToken }) => {
      // ReplaySubject(1) replays the token we started with; nothing to do.
      if (!oldRefreshToken) {
        return
      }

      try {
        const existing = readFileSync(ENV_PATH, 'utf8')
        writeEnvAtomically(upsertEnvValue(existing, TOKEN_KEY, newRefreshToken))
        process.env[TOKEN_KEY] = newRefreshToken
        console.log(`[auth] refresh token rotated, saved to ${ENV_PATH}`)
      } catch (error) {
        // Never let a disk problem kill a running stream — the in-memory
        // token is still valid for this process.
        console.error(
          `[auth] FAILED to persist rotated refresh token: ${String(error)}\n` +
            `[auth] save this manually or the next start will fail:\n${newRefreshToken}`,
        )
      }
    },
  )

  return () => subscription.unsubscribe()
}

export { ENV_PATH, TOKEN_KEY, upsertEnvValue }
