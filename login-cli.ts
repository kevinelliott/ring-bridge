/**
 * Interactive `ring-bridge login`.
 *
 * Replaces the "go run some other package's CLI and paste the output" step,
 * which was the roughest part of setup and left people holding a token with no
 * idea where to put it. This writes it to .env directly.
 */
import { createInterface, type Interface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { LoginSession, saveRefreshToken } from './ring-login.ts'

/**
 * One readline interface for the whole conversation. Creating a fresh one per
 * question works on a TTY but silently stops producing answers once stdin has
 * been closed by the previous interface, which breaks piped input entirely.
 */
/**
 * Prompts for the whole conversation.
 *
 * Lines are queued as readline emits them rather than being pulled one
 * question at a time. Two things break the naive approach: a single readline
 * per question stops producing answers once the previous one closed stdin, and
 * with piped input readline can drain the stream and emit "close" before a
 * question callback ever fires, so every answer comes back empty.
 */
class Prompter {
  private readonly rl: Interface
  private readonly isTty: boolean
  private readonly queue: string[] = []
  private waiting?: (line: string) => void
  private muted = false
  private ended = false

  constructor() {
    this.isTty = Boolean(stdin.isTTY)
    this.rl = createInterface({ input: stdin, output: stdout, terminal: this.isTty })

    this.rl.on('line', (line: string) => {
      const waiter = this.waiting
      if (waiter) {
        this.waiting = undefined
        waiter(line)
      } else {
        this.queue.push(line)
      }
    })

    this.rl.on('close', () => {
      this.ended = true
      const waiter = this.waiting
      if (waiter) {
        this.waiting = undefined
        // Input ended mid-question (EOF or Ctrl-D): answer empty so the caller
        // reports what is missing instead of hanging.
        waiter('')
      }
    })

    if (this.isTty) {
      // readline has no masking of its own; suppress its echo while muted.
      const target = this.rl as unknown as { _writeToOutput(text: string): void }
      const original = target._writeToOutput.bind(target)
      target._writeToOutput = (text: string): void => {
        if (!this.muted) {
          original(text)
        }
      }
    }
  }

  async ask(question: string, hidden = false): Promise<string> {
    stdout.write(question)

    const queued = this.queue.shift()
    if (queued !== undefined) {
      if (!this.isTty) {
        stdout.write('\n')
      }
      return queued.trim()
    }
    if (this.ended) {
      stdout.write('\n')
      return ''
    }

    if (hidden && this.isTty) {
      this.muted = true
    }
    const line = await new Promise<string>((resolve) => {
      this.waiting = resolve
    })
    this.muted = false
    if (hidden && this.isTty) {
      stdout.write('\n')
    }
    return line.trim()
  }

  close(): void {
    this.muted = false
    this.rl.close()
  }
}

export async function runLogin(): Promise<number> {
  console.log('Log in to Ring. Your password is used once to obtain a refresh')
  console.log('token and is never stored.\n')

  const prompt = new Prompter()
  try {
    const email = await prompt.ask('Email: ')
    const password = await prompt.ask('Password: ', true)

    if (!email || !password) {
      console.error('\nEmail and password are both required.')
      return 1
    }

    const session = new LoginSession()
    let token: string

    const start = await session.begin(email, password)
    if (start.refreshToken) {
      token = start.refreshToken
    } else {
      console.log(`\n${start.prompt ?? 'Ring sent a verification code.'}`)
      // Ring locks the flow after a few bad codes; stop before that and let
      // the person start over cleanly.
      let remaining = 3
      for (;;) {
        const code = await prompt.ask('Code: ')
        try {
          token = await session.submitCode(code)
          break
        } catch (error) {
          remaining--
          const message = error instanceof Error ? error.message : String(error)
          if (remaining === 0) {
            console.error(`\n${message}`)
            return 1
          }
          console.log(`${message} (${remaining} left)`)
        }
      }
    }

    const path = saveRefreshToken(token)
    console.log(`\nLogged in. Refresh token saved to ${path}`)
    console.log('Ring rotates this token on every refresh, and the bridge writes')
    console.log('each new one back automatically, so this should be a one-time step.')
    console.log('\nNext:  npx ring-bridge doctor')
    return 0
  } catch (error) {
    console.error(`\nLogin failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    prompt.close()
  }
}
