/**
 * In-process log capture for the admin UI.
 *
 * The bridge already logs everything interesting to the console, so rather
 * than introduce a logging framework this intercepts console output, keeps a
 * bounded history, and republishes each line to subscribers (the dashboard's
 * SSE stream). Original console behaviour is preserved so terminal use and
 * systemd journals are unaffected.
 */

export type LogLevel = 'info' | 'error'

export interface LogEntry {
  readonly seq: number
  readonly at: number
  readonly level: LogLevel
  readonly text: string
}

type Listener = (entry: LogEntry) => void

const HISTORY_LIMIT = 1000

class LogBus {
  private readonly history: LogEntry[] = []
  private readonly listeners = new Set<Listener>()
  private seq = 0
  private installed = false
  /** Guards against a listener that logs, which would recurse forever. */
  private dispatching = false

  install(): void {
    if (this.installed) {
      return
    }
    this.installed = true

    const wrap = (level: LogLevel, original: (...args: unknown[]) => void) => {
      return (...args: unknown[]): void => {
        original(...args)
        this.record(level, args)
      }
    }

    /* eslint-disable no-console */
    console.log = wrap('info', console.log.bind(console))
    console.info = wrap('info', console.info.bind(console))
    console.warn = wrap('error', console.warn.bind(console))
    console.error = wrap('error', console.error.bind(console))
    /* eslint-enable no-console */
  }

  private record(level: LogLevel, args: unknown[]): void {
    if (this.dispatching) {
      return
    }

    const text = args
      .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
      .join(' ')
      .trimEnd()

    if (!text) {
      return
    }

    // Split so multi-line output stays one entry per line in the UI.
    for (const line of text.split('\n')) {
      const entry: LogEntry = {
        seq: ++this.seq,
        at: Date.now(),
        level,
        text: line,
      }

      this.history.push(entry)
      if (this.history.length > HISTORY_LIMIT) {
        this.history.shift()
      }

      this.dispatching = true
      try {
        for (const listener of this.listeners) {
          listener(entry)
        }
      } finally {
        this.dispatching = false
      }
    }
  }

  recent(limit = 300): LogEntry[] {
    return this.history.slice(-limit)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return value.message
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export const logBus = new LogBus()
