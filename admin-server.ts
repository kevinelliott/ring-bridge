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
import { readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { logBus, type LogEntry } from './log-bus.ts'
import type { RingEventCollector, RingEventRecord } from './ring-events.ts'
import type { ContinuousPublisher, OutputStats } from './continuous-publisher.ts'
import type { BridgeConfig, CameraSettings } from './config.ts'
import { renderMetrics } from './metrics.ts'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const UI_PATH = join(projectRoot, 'public', 'index.html')
/** Preview frame rate; low enough to stay cheap, high enough to look live. */
const MJPEG_FPS = 5
/** JPEG end-of-image marker, used to split the MJPEG stream into frames. */
const JPEG_EOI = Buffer.from([0xff, 0xd9])

export interface OutputStatus extends OutputStats {
  path: string
  clients: number
  bytesSent: number
}

export interface CameraStatus {
  name: string
  path: string
  live: boolean
  connected: boolean
  demandReason: string
  pinned: boolean
  alwaysOn: boolean
  onDemand: boolean
  lastFrameAt: number
  droppedFrames: number
  encoderRestarts: number
  peakQueuedFrames: number
  audioBufferedMs: number
  clients: number
  bytesSent: number
  outputs: OutputStatus[]
}

export interface BridgeStatus {
  startedAt: number
  rtspPort: number
  cameras: CameraStatus[]
  events: { lastRefreshAt: number; error?: string; count: number }
  mqtt: { enabled: boolean; connected: boolean; error?: string }
}

export interface ApplyResult {
  applied?: string[]
  configPath?: string
  error?: string
}

export interface AdminContext {
  getStatus(): BridgeStatus
  getConfig(): BridgeConfig
  /** `cameraName` null applies to defaults (all cameras). */
  applyConfig(cameraName: string | null, patch: Partial<CameraSettings>): ApplyResult
  pinCamera(path: string, seconds: number): boolean
  getPublisher(path: string): ContinuousPublisher | undefined
  getRuntime(path: string): { camera: { name: string }; session?: unknown } | undefined
  /** Play audio through a camera's speaker; resolves when playback finishes. */
  talk(path: string, audioPath: string): Promise<{ error?: string }>
  events: RingEventCollector
  refreshEvents(): Promise<void>
}

interface SseClient {
  res: ServerResponse
}

export class AdminServer {
  private readonly context: AdminContext
  private readonly token?: string
  private readonly clients = new Set<SseClient>()
  private server?: ReturnType<typeof createServer>
  private uiCache?: string
  /** One shared JPEG encoder per camera, alive while viewers are watching. */
  private readonly mjpeg = new Map<string, MjpegSession>()

  constructor(context: AdminContext, token?: string) {
    this.context = context
    this.token = token
  }

  async listen(port: number, host: string): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) {
          this.json(res, 500, { error: String(error) })
        }
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
    for (const session of this.mjpeg.values()) {
      session.close()
    }
    this.mjpeg.clear()
    this.server?.close()
  }

  private broadcast(event: string, data: unknown): void {
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
   * Reads may authenticate with a cookie because EventSource and <img> cannot
   * set request headers. Mutations require the header, which a cross-site
   * request cannot add -- so cookie auth alone can never be replayed as CSRF.
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
      const cookie = /(?:^|;\s*)admin_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
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
      this.uiCache ??= await readFile(UI_PATH, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(this.uiCache)
      return
    }

    const isRead = req.method === 'GET'
    if ((path.startsWith('/api/') || path === '/metrics') &&
        !this.authorized(req, isRead)) {
      this.json(res, 401, { error: 'admin token required' })
      return
    }

    if (path === '/metrics') {
      const body = renderMetrics(this.context.getStatus())
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
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
        let body: { camera?: string | null; patch?: Partial<CameraSettings> }
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          this.json(res, 400, { error: 'body must be JSON' })
          return
        }
        const result = this.context.applyConfig(body.camera ?? null, body.patch ?? {})
        this.json(res, result.error ? 400 : 200, result)
        return
      }
      this.json(res, 405, { error: 'method not allowed' })
      return
    }

    if (path.startsWith('/api/pin/')) {
      if (req.method !== 'POST' || !this.authorized(req, false)) {
        this.json(res, req.method === 'POST' ? 401 : 405, { error: 'not allowed' })
        return
      }
      const camera = decodeURIComponent(path.slice('/api/pin/'.length))
      const seconds = Number(url.searchParams.get('seconds') ?? 300)
      const ok = this.context.pinCamera(camera, Number.isFinite(seconds) ? seconds : 300)
      this.json(res, ok ? 200 : 404, ok ? { pinned: seconds } : { error: 'unknown camera' })
      return
    }

    if (path.startsWith('/api/snapshot/')) {
      const camera = decodeURIComponent(path.slice('/api/snapshot/'.length))
      const current = this.context.getPublisher(camera)?.currentFrame()
      if (!current) {
        this.json(res, 404, { error: 'no frame available yet' })
        return
      }
      const jpeg = await frameToJpeg(current.frame, current.width, current.height)
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'content-length': jpeg.length,
      })
      res.end(jpeg)
      return
    }

    if (path.startsWith('/api/talk/')) {
      // Mutating and physically audible at the camera, so header auth only.
      if (req.method !== 'POST' || !this.authorized(req, false)) {
        this.json(res, req.method === 'POST' ? 401 : 405, { error: 'not allowed' })
        return
      }
      const camera = decodeURIComponent(path.slice('/api/talk/'.length))
      const temp = join(tmpdir(), `ring-talk-${randomBytes(6).toString('hex')}`)
      try {
        await writeFile(temp, await readBinaryBody(req))
        const result = await this.context.talk(camera, temp)
        this.json(res, result.error ? 400 : 200, result.error ? result : { spoken: true })
      } catch (error) {
        this.json(res, 400, { error: String(error) })
      } finally {
        await rm(temp, { force: true })
      }
      return
    }

    if (path.startsWith('/api/event-thumb/')) {
      const rest = path.slice('/api/event-thumb/'.length)
      const slash = rest.indexOf('/')
      const cameraName = decodeURIComponent(rest.slice(0, slash))
      const uuid = decodeURIComponent(rest.slice(slash + 1))
      const camera = this.context.events.byName.get(cameraName)
      if (!camera || !/^[\w-]{8,64}$/.test(uuid)) {
        this.json(res, 404, { error: 'unknown event snapshot' })
        return
      }
      try {
        const image = await camera.getSnapshotByUuid(uuid)
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          // Event snapshots never change, so let the browser keep them.
          'cache-control': 'private, max-age=3600',
          'content-length': image.length,
        })
        res.end(image)
      } catch (error) {
        this.json(res, 502, { error: `Ring refused the snapshot: ${String(error)}` })
      }
      return
    }

    if (path.startsWith('/api/preview/')) {
      const camera = decodeURIComponent(path.slice('/api/preview/'.length))
      this.serveMjpeg(camera, res)
      return
    }

    if (path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')
      const client: SseClient = { res }
      this.clients.add(client)
      res.write(`event: status\ndata: ${JSON.stringify(this.context.getStatus())}\n\n`)
      req.on('close', () => this.clients.delete(client))
      return
    }

    this.json(res, 404, { error: 'not found' })
  }

  /**
   * Multipart MJPEG, so the dashboard shows motion instead of a still that
   * refreshes every few seconds. One encoder is shared by all viewers of a
   * camera and torn down when the last one leaves, so an unwatched dashboard
   * costs nothing.
   */
  private serveMjpeg(cameraPath: string, res: ServerResponse): void {
    const publisher = this.context.getPublisher(cameraPath)
    if (!publisher) {
      this.json(res, 404, { error: 'unknown camera' })
      return
    }

    let session = this.mjpeg.get(cameraPath)
    if (!session) {
      session = new MjpegSession(publisher, () => this.mjpeg.delete(cameraPath))
      this.mjpeg.set(cameraPath, session)
    }
    session.addViewer(res)
  }
}

/**
 * Streams MJPEG to any number of viewers from a single long-lived encoder.
 *
 * The obvious implementation -- encode each frame with its own ffmpeg -- costs
 * a process spawn per frame, which at 5fps across a few cameras is enough to
 * matter on the low-power hosts this tends to run on. Instead one ffmpeg is
 * held open per camera, fed raw frames on stdin and emitting a continuous MJPEG
 * stream on stdout, which is split back into frames here and fanned out.
 */
class MjpegSession {
  private readonly viewers = new Set<ServerResponse>()
  private readonly stopFrames: () => void
  private readonly onEmpty: () => void
  private encoder?: ChildProcess
  private stdin?: Writable
  private buffer: Buffer = Buffer.alloc(0)
  private lastWriteAt = 0
  /** Geometry the current encoder was started for; a change restarts it. */
  private geometry = ''
  private closed = false

  constructor(publisher: ContinuousPublisher, onEmpty: () => void) {
    this.onEmpty = onEmpty
    this.stopFrames = publisher.onFrame((frame, width, height) => {
      this.feed(frame, width, height)
    })
  }

  private feed(frame: Buffer, width: number, height: number): void {
    if (this.closed || this.viewers.size === 0) {
      return
    }

    const geometry = `${width}x${height}`
    if (geometry !== this.geometry) {
      this.restartEncoder(geometry)
    }

    // Throttle here rather than in ffmpeg so the encoder's declared input rate
    // and the actual write rate agree.
    const now = Date.now()
    if (now - this.lastWriteAt < 1000 / MJPEG_FPS) {
      return
    }
    this.lastWriteAt = now

    // Drop rather than queue: a stalled preview must never hold frames.
    if (this.stdin?.writable && (this.stdin.writableLength ?? 0) < frame.length * 3) {
      this.stdin.write(frame)
    }
  }

  private restartEncoder(geometry: string): void {
    this.encoder?.kill('SIGKILL')
    this.buffer = Buffer.alloc(0)
    this.geometry = geometry

    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
      '-s', geometry, '-r', String(MJPEG_FPS),
      '-i', 'pipe:0',
      '-vf', 'scale=640:-2',
      '-q:v', '6',
      '-f', 'mjpeg', 'pipe:1',
    ])

    this.encoder = child
    this.stdin = child.stdin ?? undefined
    this.stdin?.on('error', () => {})
    child.stdout?.on('data', (chunk: Buffer) => this.onEncoded(chunk))
    child.on('exit', () => {
      if (!this.closed && child === this.encoder) {
        this.encoder = undefined
        this.stdin = undefined
        this.geometry = ''
      }
    })
  }

  /** Split the MJPEG stream on JPEG end-of-image markers and fan each out. */
  private onEncoded(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    for (;;) {
      const end = this.buffer.indexOf(JPEG_EOI, 2)
      if (end === -1) {
        break
      }
      const jpeg = this.buffer.subarray(0, end + 2)
      this.buffer = this.buffer.subarray(end + 2)
      this.send(jpeg)
    }

    // A frame this large means the marker scan has lost sync; start over
    // rather than growing without bound.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = Buffer.alloc(0)
    }
  }

  private send(jpeg: Buffer): void {
    for (const viewer of this.viewers) {
      viewer.write(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
      )
      viewer.write(jpeg)
      viewer.write('\r\n')
    }
  }

  addViewer(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
      'cache-control': 'no-store',
      connection: 'close',
    })
    this.viewers.add(res)
    res.on('close', () => {
      this.viewers.delete(res)
      if (this.viewers.size === 0) {
        this.close()
      }
    })
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.stopFrames()
    this.encoder?.kill('SIGKILL')
    this.encoder = undefined
    for (const viewer of this.viewers) {
      viewer.end()
    }
    this.viewers.clear()
    this.onEmpty()
  }
}

function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('audio must be under 8MB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
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

/** Encode one yuv420p frame to JPEG. */
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
