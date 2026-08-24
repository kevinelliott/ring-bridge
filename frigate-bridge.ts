/**
 * Ring -> RTSP bridge for Frigate, with a built-in RTSP server.
 *
 * Ring has no RTSP endpoint, and its live view is a WebRTC call that Ring's
 * servers tear down after roughly twelve minutes. Rather than let that gap
 * reach Frigate, the RTSP stream is served from this process and fed by a
 * fixed-rate frame clock: live Ring frames when they are arriving, and the
 * last known frame plus an animated spinner when they are not. From a client's
 * point of view the stream never stops.
 *
 *   Ring (WebRTC) --ffmpeg decode--> raw frames --+
 *                                                 +--> clock --> encoder --> RTSP server
 *              last frame + spinner (on outage) --+
 */
import { createServer as createTcpServer } from 'node:net'
import { RingApi, type RingCamera } from 'ring-client-api'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import { firstValueFrom } from 'rxjs'
import { loadRefreshToken, persistRefreshTokenUpdates } from './ring-auth.ts'
import { RtspServer } from './rtsp-server.ts'
import { ContinuousPublisher, type TunableOptions } from './continuous-publisher.ts'
import { AdminServer, frameToJpeg, type BridgeStatus } from './admin-server.ts'
import { RingEventCollector } from './ring-events.ts'
import { logBus } from './log-bus.ts'

interface BridgeOptions extends TunableOptions {
  port: number
  audio: boolean
  webPort: number
  webBind: string
  webToken?: string
  cameraFilter: string[]
}

/**
 * Ring answers with Opus or PCMU; both are resampled to this rate so the
 * encoder's audio input has one fixed shape regardless of what Ring sends.
 */
const SAMPLE_RATE = 16000

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000
/** A call that survived this long ended on Ring's timer, not a fault. */
const HEALTHY_SESSION_MS = 30_000

const DEFAULTS: BridgeOptions = {
  port: 8554,
  width: 1920,
  height: 1080,
  fps: 20,
  encoder: 'libx264',
  crf: 21,
  preset: 'veryfast',
  audio: true,
  webPort: 8080,
  webBind: '0.0.0.0',
  cameraFilter: [],
}

function parseArgs(argv: string[]): BridgeOptions {
  const options: BridgeOptions = { ...DEFAULTS, cameraFilter: [] }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) {
        throw new Error(`${arg} requires a value`)
      }
      return value
    }

    switch (arg) {
      case '--port':
        options.port = Number(next())
        break
      case '--size': {
        const value = next()
        const match = /^(\d+)x(\d+)$/.exec(value)
        if (!match) {
          throw new Error(`--size expects WxH, got "${value}"`)
        }
        options.width = Number(match[1])
        options.height = Number(match[2])
        break
      }
      case '--fps':
        options.fps = Number(next())
        break
      case '--encoder':
        options.encoder = next()
        break
      case '--crf':
        options.crf = Number(next())
        break
      case '--preset':
        options.preset = next()
        break
      case '--bitrate':
        options.bitrateKbps = Number(next())
        break
      case '--camera':
        options.cameraFilter.push(next().toLowerCase())
        break
      case '--no-audio':
        options.audio = false
        break
      case '--web-port':
        options.webPort = Number(next())
        break
      case '--web-bind':
        options.webBind = next()
        break
      case '--web-token':
        options.webToken = next()
        break
      case '--no-web':
        options.webPort = 0
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  // yuv420p subsamples chroma 2x2, so odd dimensions have no valid layout.
  if (options.width % 2 !== 0 || options.height % 2 !== 0) {
    throw new Error('--size width and height must both be even')
  }
  if (!Number.isFinite(options.fps) || options.fps < 1 || options.fps > 60) {
    throw new Error('--fps must be between 1 and 60')
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be a valid TCP port')
  }
  if (!Number.isInteger(options.crf) || options.crf < 0 || options.crf > 51) {
    throw new Error('--crf must be an integer between 0 and 51')
  }
  if (
    options.bitrateKbps !== undefined &&
    (!Number.isFinite(options.bitrateKbps) || options.bitrateKbps < 100)
  ) {
    throw new Error('--bitrate is in kbit/s and must be at least 100')
  }

  return options
}

/**
 * Accept decoded PCM from the Ring-side ffmpeg over loopback TCP.
 *
 * The library only surfaces one stdout stream, which video already uses, so
 * audio needs a second destination. TCP rather than UDP because PCM has no
 * framing or recovery of its own -- a dropped or reordered datagram would be
 * an audible glitch, where TCP simply delivers the bytes in order.
 */
function createAudioReceiver(
  onChunk: (chunk: Buffer) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer((socket) => {
      socket.on('data', (chunk: Buffer) => onChunk(chunk))
      socket.on('error', () => socket.destroy())
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve(address.port)
      } else {
        reject(new Error('failed to bind audio receiver'))
      }
    })
  })
}

/** "Front Door" -> "front_door", so RTSP paths stay URL-safe and stable. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Dial Ring and pump decoded frames into the publisher, redialing whenever the
 * call drops. The publisher keeps serving throughout, so failures here only
 * change what the stream shows, never whether it exists.
 */
async function superviseCamera(
  camera: RingCamera,
  publisher: ContinuousPublisher,
  options: BridgeOptions,
  audioPort: number | undefined,
  shouldStop: () => boolean,
): Promise<void> {
  const label = `[${camera.name}]`
  let attempt = 0

  while (!shouldStop()) {
    const startedAt = Date.now()
    let session: StreamingSession | undefined

    try {
      session = await camera.streamVideo({
        // Empty overrides the library's defaults ("-acodec aac" / "-vcodec
        // copy"): both streams must be decoded so they can be mixed with the
        // placeholder and re-timed by the frame clock.
        audio: [],
        video: [],
        output: [
          '-map', '0:v',
          '-f', 'rawvideo',
          '-pix_fmt', 'yuv420p',
          '-s', `${options.width}x${options.height}`,
          '-r', String(options.fps),
          'pipe:1',
          // "0:a?" so a camera without an audio stream still publishes video.
          ...(audioPort !== undefined
            ? [
                '-map', '0:a?',
                '-f', 's16le',
                '-ar', String(SAMPLE_RATE),
                '-ac', '1',
                `tcp://127.0.0.1:${audioPort}`,
              ]
            : []),
        ],
        stdoutCallback: (data) => publisher.pushDecoderChunk(data),
      })

      await firstValueFrom(session.onCallEnded)

      const durationSec = Math.round((Date.now() - startedAt) / 1000)
      console.log(`${label} Ring call ended after ${durationSec}s`)
    } catch (error) {
      console.error(`${label} Ring stream error: ${String(error)}`)
    } finally {
      session?.stop()
      publisher.markSourceDown()
    }

    if (shouldStop()) {
      break
    }

    if (Date.now() - startedAt >= HEALTHY_SESSION_MS) {
      attempt = 0
    } else {
      attempt++
    }

    const backoff = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1),
      RECONNECT_MAX_MS,
    )
    const jitter = Math.floor(backoff * 0.2 * Math.random())
    const delay = attempt === 0 ? RECONNECT_BASE_MS : backoff + jitter

    console.log(`${label} redialing Ring in ${Math.round(delay / 1000)}s`)
    await sleep(delay)
  }
}

const USAGE = `Usage:
  npm run bridge -- [options]

Options:
  --port <n>        RTSP listen port (default ${DEFAULTS.port})
  --camera "Name"   Bridge only this camera; repeatable
  --size WxH        Output size (default ${DEFAULTS.width}x${DEFAULTS.height})
  --fps <n>         Output frame rate (default ${DEFAULTS.fps})
  --encoder <name>  Video encoder (default ${DEFAULTS.encoder}; try h264_videotoolbox on macOS)
  --crf <n>         Quality, lower is better (default ${DEFAULTS.crf}; libx264/libx265 only)
  --preset <name>   x264 preset (default ${DEFAULTS.preset}; slower = better per bit)
  --bitrate <kbps>  Target bitrate; overrides --crf, needed for hardware encoders
  --no-audio        Publish video only
  --web-port <n>    Admin dashboard port (default ${DEFAULTS.webPort}; 0 or --no-web disables)
  --web-bind <addr> Admin bind address (default ${DEFAULTS.webBind})
  --web-token <s>   Require this token for configuration changes`

logBus.install()

let options: BridgeOptions
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
  process.exit(1)
}

const ringApi = new RingApi({ refreshToken: loadRefreshToken() })
const stopPersistingToken = persistRefreshTokenUpdates(ringApi)

const locations = await ringApi.getLocations()
const allCameras = locations.flatMap((location) => location.cameras)

const cameras =
  options.cameraFilter.length === 0
    ? allCameras
    : allCameras.filter((camera) =>
        options.cameraFilter.includes(camera.name.toLowerCase()),
      )

if (cameras.length === 0) {
  console.error(
    `No cameras matched. Available: ${allCameras.map((c) => c.name).join(', ') || '(none)'}`,
  )
  stopPersistingToken()
  ringApi.disconnect()
  process.exit(1)
}

const server = new RtspServer()
const publishers: ContinuousPublisher[] = []
const audioPorts: Array<number | undefined> = []

for (const camera of cameras) {
  const path = slugify(camera.name)
  const stream = server.publish(path)

  const rtpPort = await stream.addTrack({
    kind: 'video',
    payloadType: 96,
    rtpmap: 'H264/90000',
    fmtp: 'packetization-mode=1',
  })

  const audioRtpPort = options.audio
    ? await stream.addTrack({
        kind: 'audio',
        payloadType: 97,
        rtpmap: `MPEG4-GENERIC/${SAMPLE_RATE}/1`,
        // AudioSpecificConfig for AAC-LC mono at SAMPLE_RATE, matching what
        // ffmpeg's own RTP muxer advertises for these encoder settings.
        fmtp:
          'profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;' +
          'indexdeltalength=3;config=140856E500',
      })
    : undefined

  const publisher = new ContinuousPublisher({
    rtpPort,
    audioRtpPort,
    sampleRate: SAMPLE_RATE,
    width: options.width,
    height: options.height,
    fps: options.fps,
    encoder: options.encoder,
    crf: options.crf,
    preset: options.preset,
    bitrateKbps: options.bitrateKbps,
    label: `[${camera.name}]`,
    displayUrl: `rtsp://<host>:${options.port}/${path}`,
  })

  publishers.push(publisher)
  audioPorts.push(
    options.audio
      ? await createAudioReceiver((chunk) => publisher.pushAudioChunk(chunk))
      : undefined,
  )
}

await server.listen(options.port)
console.log(`RTSP server listening on 0.0.0.0:${options.port}`)

// Publishers start before Ring is dialed, so the placeholder is already being
// served if Ring is slow or unreachable at boot.
for (const publisher of publishers) {
  publisher.start()
}

const eventCollector = new RingEventCollector(cameras)
eventCollector.start()
// Backfill history in the background; the dashboard renders without it.
void eventCollector.refresh().catch(() => {})

const startedAt = Date.now()
let admin: AdminServer | undefined

if (options.webPort > 0) {
  const bySlug = new Map(
    cameras.map((camera, index) => [
      slugify(camera.name),
      { camera, publisher: publishers[index] as ContinuousPublisher },
    ]),
  )

  const buildStatus = (): BridgeStatus => {
    const clients = new Map(
      server.streamInfo().map((info) => [info.path, info.clients]),
    )
    return {
      startedAt,
      rtspPort: options.port,
      cameras: [...bySlug.entries()].map(([path, { camera, publisher }]) => {
        const stats = publisher.stats
        return {
          name: camera.name,
          path,
          rtspUrl: `rtsp://<host>:${options.port}/${path}`,
          live: stats.live,
          lastFrameAt: stats.lastFrameAt,
          droppedFrames: stats.droppedFrames,
          encoderRestarts: stats.encoderRestarts,
          clients: clients.get(path) ?? 0,
          hasAudio: stats.hasAudio,
          audioBufferedMs: stats.audioBufferedMs,
          peakQueuedFrames: stats.peakQueuedFrames,
          settings: stats.settings,
        }
      }),
      events: eventCollector.status,
    }
  }

  admin = new AdminServer(
    {
      getStatus: buildStatus,
      getConfig: () => ({
        width: options.width,
        height: options.height,
        fps: options.fps,
        encoder: options.encoder,
        crf: options.crf,
        preset: options.preset,
        bitrateKbps: options.bitrateKbps,
        audio: options.audio,
        port: options.port,
      }),
      applyConfig: (patch) => {
        const applied: string[] = []
        const tunable: Partial<TunableOptions> = {}

        const set = <K extends keyof TunableOptions>(
          key: K,
          value: TunableOptions[K] | undefined,
        ): void => {
          if (options[key] === value) {
            return
          }
          tunable[key] = value
          options[key] = value as BridgeOptions[K]
          applied.push(key)
        }

        if (patch.width !== undefined) set('width', patch.width)
        if (patch.height !== undefined) set('height', patch.height)
        if (patch.fps !== undefined) set('fps', patch.fps)
        if (patch.encoder !== undefined) set('encoder', patch.encoder)
        if (patch.crf !== undefined) set('crf', patch.crf)
        if (patch.preset !== undefined) set('preset', patch.preset)
        // The UI sends null to clear the override and fall back to CRF.
        if ('bitrateKbps' in patch) {
          set('bitrateKbps', patch.bitrateKbps ?? undefined)
        }

        if (applied.length > 0) {
          for (const publisher of publishers) {
            publisher.reconfigure(tunable)
          }
        }

        // Everything else is fixed at boot: ports bind once, and adding or
        // removing an audio track would change the SDP under live clients.
        return { applied, restartRequired: [] }
      },
      getSnapshot: async (path) => {
        const entry = bySlug.get(path)
        const current = entry?.publisher.currentFrame()
        if (!current) {
          return undefined
        }
        return frameToJpeg(current.frame, current.width, current.height)
      },
      events: eventCollector,
      refreshEvents: () => eventCollector.refresh(),
    },
    options.webToken,
  )

  await admin.listen(options.webPort, options.webBind)
  console.log(
    `Admin dashboard on http://${options.webBind}:${options.webPort}` +
      (options.webToken ? ' (token required for changes)' : ''),
  )
}

let stopping = false
const shouldStop = (): boolean => stopping

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      process.exit(1)
    }
    console.log(`\nReceived ${signal}, shutting down...`)
    stopping = true
    for (const publisher of publishers) {
      publisher.stop()
    }
    admin?.close()
    eventCollector.stop()
    server.close()
    stopPersistingToken()
    ringApi.disconnect()
    setTimeout(() => process.exit(0), 2_000).unref()
  })
}

await Promise.all(
  cameras.map((camera, index) =>
    superviseCamera(
      camera,
      publishers[index] as ContinuousPublisher,
      options,
      audioPorts[index],
      shouldStop,
    ),
  ),
)

for (const publisher of publishers) {
  publisher.stop()
}
admin?.close()
eventCollector.stop()
server.close()
stopPersistingToken()
ringApi.disconnect()
