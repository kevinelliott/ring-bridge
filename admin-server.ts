/**
 * Embedded admin web server.
 *
 * Serves a single-page dashboard plus a small JSON API over Node's built-in
 * http module -- no framework, matching the in-process approach the RTSP server
 * already takes. Live updates use Server-Sent Events rather than WebSockets:
 * the dashboard only ever needs server-to-client push, and SSE reconnects on
 * its own without any client-side plumbing.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { logBus, type LogEntry } from './log-bus.ts'
import type { RingEventCollector, RingEventRecord } from './ring-events.ts'
import type { TunableOptions } from './continuous-publisher.ts'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const UI_PATH = join(projectRoot, 'public', 'index.html')

export interface CameraStatus {
  name: string
  path: string
  rtspUrl: string
  live: boolean
  lastFrameAt: number
  droppedFrames: number
  encoderRestarts: number
  clients: number
  hasAudio: boolean
  audioBufferedMs: number
  peakQueuedFrames: number
  settings: TunableOptions
}

export interface BridgeStatus {
  startedAt: number
  rtspPort: number
  cameras: CameraStatus[]
  events: { lastRefreshAt: number; error?: string; count: number }
}

export interface AdminContext {
  getStatus(): BridgeStatus
  getConfig(): TunableOptions & { audio: boolean; port: number }
  applyConfig(patch: Partial<TunableOptions>): { applied: string[]; restartRequired: string[] }
  getSnapshot(path: string): Promise<Buffer | undefined>
  events: RingEventCollector
  refreshEvents(): Promise<void>
}

interface SseClient {
  id: number
  res: ServerResponse
}

export class AdminServer {
  private readonly context: AdminContext
  private readonly token?: string
  private readonly clients = new Set<SseClient>()
  private server?: ReturnType<typeof createServer>
  private nextClientId = 1
  private uiCache?: string

  constructor(context: AdminContext, token?: string) {
    this.context = context
    this.token = token
  }

  async listen(port: number, host: string): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.json(res, 500, { error: String(error) })
      })
    })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    // Push log lines and Ring events to every connected dashboard.
    logBus.subscribe((entry) => this.broadcast('log', entry))
    this.context.events.subscribe((event) => this.broadcast('ring-event', event))

    // A periodic status frame keeps tiles fresh and doubles as an SSE keepalive
    // through proxies that time out idle connections.
    setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcast('status', this.context.getStatus())
      }
    }, 2000).unref()
  }

  close(): void {
    for (const client of this.clients) {
      client.res.end()
    }
    this.clients.clear()
    this.server?.close()
  }

  private broadcast(event: string, data: LogEntry | RingEventRecord | BridgeStatus): void {
    if (this.clients.size === 0) {
      return
    }
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.clients) {
      client.res.write(payload)
    }
  }

  private matchesToken(provided: string): boolean {
    const a = Buffer.from(provided)
    const b = Buffer.from(this.token ?? '')
    // timingSafeEqual requires equal lengths, so compare those first.
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * Authorise a request when a token is configured.
   *
   * The token is never accepted from the query string: URLs end up in server
   * logs, proxy logs and browser history, which is exactly where a long-lived
   * credential should not be.
   *
   * Reads may authenticate with a cookie because EventSource cannot set
   * request headers. Mutations require the header, which a cross-site request
   * cannot add -- so cookie auth alone can never be replayed as CSRF.
   */
  private authorized(req: IncomingMessage, allowCookie: boolean): boolean {
    if (!this.token) {
      return true
    }

    const header = req.headers['x-admin-token']?.toString()
    if (header && this.matchesToken(header)) {
      return true
    }

    if (allowCookie) {
      const cookie = /(?:^|;\s*)admin_token=([^;]+)/.exec(
        req.headers.cookie ?? '',
      )?.[1]
      if (cookie && this.matchesToken(decodeURIComponent(cookie))) {
        return true
      }
    }

    return false
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/api/auth') {
      this.json(res, 200, { authRequired: Boolean(this.token) })
      return
    }

    if (path === '/' || path === '/index.html') {
      // Cached after first read; the page is static.
      this.uiCache ??= await readFile(UI_PATH, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(this.uiCache)
      return
    }

    // The page itself stays open: it is an empty shell that renders the token
    // prompt. Everything that returns data is gated.
    if (path.startsWith('/api/') && !this.authorized(req, req.method === 'GET')) {
      this.json(res, 401, { error: 'admin token required' })
      return
    }

    if (path === '/api/status') {
      this.json(res, 200, this.context.getStatus())
      return
    }

    if (path === '/api/logs') {
      const limit = Number(url.searchParams.get('limit') ?? 300)
      this.json(res, 200, logBus.recent(Number.isFinite(limit) ? limit : 300))
      return
    }

    if (path === '/api/events') {
      if (url.searchParams.get('refresh') === '1') {
        await this.context.refreshEvents()
      }
      this.json(res, 200, {
        events: this.context.events.list(100),
        status: this.context.events.status,
      })
      return
    }

    if (path === '/api/config') {
      if (req.method === 'GET') {
        this.json(res, 200, {
          config: this.context.getConfig(),
          authRequired: Boolean(this.token),
        })
        return
      }

      if (req.method === 'POST') {
        // Header only: see authorized().
        if (!this.authorized(req, false)) {
          this.json(res, 401, { error: 'invalid or missing admin token' })
          return
        }
        const body = await readBody(req)
        let patch: Partial<TunableOptions>
        try {
          patch = JSON.parse(body || '{}') as Partial<TunableOptions>
        } catch {
          this.json(res, 400, { error: 'body must be JSON' })
          return
        }

        const invalid = validate(patch)
        if (invalid) {
          this.json(res, 400, { error: invalid })
          return
        }

        const result = this.context.applyConfig(patch)
        this.json(res, 200, { ...result, config: this.context.getConfig() })
        return
      }

      this.json(res, 405, { error: 'method not allowed' })
      return
    }

    if (path.startsWith('/api/snapshot/')) {
      const camera = decodeURIComponent(path.slice('/api/snapshot/'.length))
      const jpeg = await this.context.getSnapshot(camera)
      if (!jpeg) {
        this.json(res, 404, { error: 'no frame available yet' })
        return
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'content-length': jpeg.length,
      })
      res.end(jpeg)
      return
    }

    if (path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')

      const client: SseClient = { id: this.nextClientId++, res }
      this.clients.add(client)

      res.write(`event: status\ndata: ${JSON.stringify(this.context.getStatus())}\n\n`)

      req.on('close', () => {
        this.clients.delete(client)
      })
      return
    }

    this.json(res, 404, { error: 'not found' })
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      // Config payloads are tiny; refuse anything that isn't.
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Mirror the CLI's validation so the UI cannot set values the CLI rejects. */
function validate(patch: Partial<TunableOptions>): string | undefined {
  if (patch.fps !== undefined && (!Number.isFinite(patch.fps) || patch.fps < 1 || patch.fps > 60)) {
    return 'fps must be between 1 and 60'
  }
  if (
    patch.crf !== undefined &&
    (!Number.isInteger(patch.crf) || patch.crf < 0 || patch.crf > 51)
  ) {
    return 'crf must be an integer between 0 and 51'
  }
  if (
    patch.bitrateKbps !== undefined &&
    patch.bitrateKbps !== null &&
    (!Number.isFinite(patch.bitrateKbps) || patch.bitrateKbps < 100)
  ) {
    return 'bitrate must be at least 100 kbit/s'
  }
  if (patch.width !== undefined && (patch.width % 2 !== 0 || patch.width < 160)) {
    return 'width must be even and at least 160'
  }
  if (patch.height !== undefined && (patch.height % 2 !== 0 || patch.height < 120)) {
    return 'height must be even and at least 120'
  }
  if (patch.encoder !== undefined && !/^[\w-]+$/.test(patch.encoder)) {
    return 'encoder name has unexpected characters'
  }
  if (patch.preset !== undefined && !/^[a-z]+$/.test(patch.preset)) {
    return 'preset has unexpected characters'
  }
  return undefined
}

/** Encode one yuv420p frame to JPEG for the dashboard preview. */
export function frameToJpeg(
  frame: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
      '-s', `${width}x${height}`,
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', 'scale=640:-2',
      '-f', 'mjpeg', 'pipe:1',
    ])

    const chunks: Buffer[] = []
    ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error(`snapshot encode failed (${code})`))
      }
    })

    ff.stdin.on('error', () => {})
    ff.stdin.end(frame)
  })
}
