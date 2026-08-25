/**
 * The bridge: Ring supervision, RTSP publishing, and everything wired together.
 *
 * Ring has no RTSP endpoint, and its live view is a WebRTC call that Ring's
 * servers tear down after roughly twelve minutes. Rather than let that gap
 * reach the NVR, the RTSP stream is served from this process and fed by a
 * fixed-rate frame clock: live Ring frames when they are arriving, and the last
 * known frame plus an animated spinner when they are not.
 *
 *   Ring (WebRTC) --ffmpeg decode--> raw frames --+
 *                                                 +--> clock --> encoders --> RTSP
 *              last frame + spinner (on outage) --+
 */
import { createServer as createTcpServer } from 'node:net'
import { RingApi, type RingCamera } from 'ring-client-api'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import { firstValueFrom } from 'rxjs'
import { loadRefreshToken, persistRefreshTokenUpdates } from './ring-auth.ts'
import { RtspServer } from './rtsp-server.ts'
import { ContinuousPublisher, type OutputSettings } from './continuous-publisher.ts'
import { AdminServer } from './admin-server.ts'
import { RingEventCollector } from './ring-events.ts'
import { logBus } from './log-bus.ts'
import { DemandTracker } from './demand.ts'
import { MqttBridge } from './mqtt-bridge.ts'
import { WebhookSender } from './webhooks.ts'
import {
  loadConfig, saveConfig, settingsFor, validateSettings,
  type BridgeConfig, type CameraSettings,
} from './config.ts'

/**
 * Ring answers with Opus or PCMU; both are resampled to this rate so the
 * encoder's audio input has one fixed shape regardless of what Ring sends.
 */
export const SAMPLE_RATE = 16000

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000
/** A call that survived this long ended on Ring's timer, not a fault. */
const HEALTHY_SESSION_MS = 30_000
/** How often to re-check demand while idle. */
const DEMAND_POLL_MS = 1_000

export interface CliOverrides extends Partial<CameraSettings> {
  rtspPort?: number
  webPort?: number
  webBind?: string
  webToken?: string
  noWeb?: boolean
  cameraFilter?: string[]
}

/** "Front Door" -> "front_door", so RTSP paths stay URL-safe and stable. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Accept decoded PCM from the Ring-side ffmpeg over loopback TCP.
 *
 * The library only surfaces one stdout stream, which video already uses, so
 * audio needs a second destination. TCP rather than UDP because PCM has no
 * framing or recovery of its own -- a dropped or reordered datagram would be an
 * audible glitch, where TCP simply delivers the bytes in order.
 */
function createAudioReceiver(onChunk: (chunk: Buffer) => void): Promise<number> {
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

export interface CameraRuntime {
  camera: RingCamera
  path: string
  settings: CameraSettings
  publisher: ContinuousPublisher
  demand: DemandTracker
  audioPort?: number
  /** Live session, when connected -- used for two-way audio. */
  session?: StreamingSession
}

export interface RunOptions {
  configPath: string
  overrides: CliOverrides
}

export async function runBridge(options: RunOptions): Promise<void> {
  logBus.install()

  const config = loadConfig(options.configPath)
  applyOverrides(config, options.overrides)

  if (config.logFile) {
    logBus.mirrorToFile(config.logFile)
  }

  const ringApi = new RingApi({ refreshToken: loadRefreshToken() })
  const stopPersistingToken = persistRefreshTokenUpdates(ringApi)

  const locations = await ringApi.getLocations()
  const allCameras = locations.flatMap((location) => location.cameras)
  const filter = options.overrides.cameraFilter ?? []

  const cameras = allCameras.filter((camera) => {
    if (filter.length > 0 && !filter.includes(camera.name.toLowerCase())) {
      return false
    }
    return settingsFor(config, camera.name).enabled
  })

  if (cameras.length === 0) {
    console.error(
      `No cameras matched. Available: ${allCameras.map((c) => c.name).join(', ') || '(none)'}`,
    )
    stopPersistingToken()
    ringApi.disconnect()
    process.exit(1)
  }

  const server = new RtspServer()
  const runtimes: CameraRuntime[] = []

  for (const camera of cameras) {
    const settings = settingsFor(config, camera.name)
    const path = slugify(camera.name)
    const outputs: OutputSettings[] = []

    const stream = server.publish(path)
    const rtpPort = await stream.addTrack({
      kind: 'video',
      payloadType: 96,
      rtpmap: 'H264/90000',
      fmtp: 'packetization-mode=1',
    })
    const audioRtpPort = settings.audio
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

    outputs.push({
      name: 'main',
      rtpPort,
      audioRtpPort,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      encoder: settings.encoder,
      crf: settings.crf,
      preset: settings.preset,
      bitrateKbps: settings.bitrateKbps,
    })

    if (settings.substream) {
      const sub = settings.substream
      const subStream = server.publish(`${path}_sub`)
      const subPort = await subStream.addTrack({
        kind: 'video',
        payloadType: 96,
        rtpmap: 'H264/90000',
        fmtp: 'packetization-mode=1',
      })
      outputs.push({
        name: 'sub',
        rtpPort: subPort,
        width: sub.width,
        height: sub.height,
        fps: sub.fps,
        encoder: settings.encoder,
        crf: sub.crf,
        preset: settings.preset,
        bitrateKbps: sub.bitrateKbps,
      })
    }

    const publisher = new ContinuousPublisher({
      label: `[${camera.name}]`,
      sourceWidth: settings.width,
      sourceHeight: settings.height,
      sourceFps: settings.fps,
      sampleRate: SAMPLE_RATE,
      outputs,
      displayUrl: `rtsp://<host>:${config.rtspPort}/${path}`,
    })

    const demand = new DemandTracker(`[${camera.name}]`, {
      alwaysOn: settings.alwaysOn,
      onDemand: settings.onDemand,
      idleTimeoutSec: settings.idleTimeoutSec,
    })

    // Both the main stream and its substream count as demand.
    stream.onClientChange(() => updateDemand())
    const subLive = settings.substream ? server.stream(`${path}_sub`) : undefined
    subLive?.onClientChange(() => updateDemand())
    function updateDemand(): void {
      demand.setClients(stream.clientCount + (subLive?.clientCount ?? 0))
    }

    const runtime: CameraRuntime = { camera, path, settings, publisher, demand }
    if (settings.audio) {
      runtime.audioPort = await createAudioReceiver((chunk) =>
        publisher.pushAudioChunk(chunk),
      )
    }
    runtimes.push(runtime)
  }

  await server.listen(config.rtspPort)
  console.log(`RTSP server listening on 0.0.0.0:${config.rtspPort}`)

  // Publishers start before Ring is dialed, so the placeholder is already being
  // served if Ring is slow, unreachable, or simply not wanted yet.
  for (const runtime of runtimes) {
    runtime.publisher.start()
    console.log(
      `${runtime.publisher.stats.label} publishing to ` +
        `rtsp://<host>:${config.rtspPort}/${runtime.path}` +
        (runtime.settings.substream ? ` (+ /${runtime.path}_sub)` : ''),
    )
  }

  const eventCollector = new RingEventCollector(cameras)
  eventCollector.start()
  void eventCollector.refresh().catch(() => {})

  const webhooks = new WebhookSender(config.webhookUrl)
  const mqtt = new MqttBridge(config.mqtt, cameras.map((c) => c.name))
  await mqtt.start()

  eventCollector.subscribe((event) => {
    void webhooks.send(event)
    mqtt.publishEvent(event)
  })

  const startedAt = Date.now()
  let stopping = false
  const shouldStop = (): boolean => stopping

  const admin = config.webPort > 0
    ? await startAdmin({
        config, configPath: options.configPath, runtimes, server,
        eventCollector, startedAt, mqtt,
      })
    : undefined

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) {
        process.exit(1)
      }
      console.log(`\nReceived ${signal}, shutting down...`)
      stopping = true
      for (const runtime of runtimes) {
        runtime.publisher.stop()
      }
      admin?.close()
      eventCollector.stop()
      void mqtt.stop()
      server.close()
      stopPersistingToken()
      ringApi.disconnect()
      setTimeout(() => process.exit(0), 2_000).unref()
    })
  }

  await Promise.all(runtimes.map((runtime) => superviseCamera(runtime, shouldStop)))

  for (const runtime of runtimes) {
    runtime.publisher.stop()
  }
  admin?.close()
  eventCollector.stop()
  await mqtt.stop()
  server.close()
  stopPersistingToken()
  ringApi.disconnect()
}

function applyOverrides(config: BridgeConfig, o: CliOverrides): void {
  if (o.rtspPort !== undefined) config.rtspPort = o.rtspPort
  if (o.webPort !== undefined) config.webPort = o.webPort
  if (o.webBind !== undefined) config.webBind = o.webBind
  if (o.webToken !== undefined) config.webToken = o.webToken
  if (o.noWeb) config.webPort = 0

  // Encoder overrides land on defaults, so they apply to every camera unless a
  // per-camera entry in the config file says otherwise.
  for (const key of [
    'width', 'height', 'fps', 'encoder', 'crf', 'preset', 'bitrateKbps',
    'audio', 'alwaysOn', 'onDemand', 'idleTimeoutSec',
  ] as const) {
    const value = o[key]
    if (value !== undefined) {
      ;(config.defaults[key] as unknown) = value
    }
  }
}

/**
 * Dial Ring and pump decoded frames into the publisher, redialing whenever the
 * call drops -- but only while something is actually watching. The publisher
 * keeps serving throughout, so this only changes what the stream shows.
 */
async function superviseCamera(
  runtime: CameraRuntime,
  shouldStop: () => boolean,
): Promise<void> {
  const { camera, publisher, demand, settings } = runtime
  const label = `[${camera.name}]`
  let attempt = 0
  let idleLogged = false

  while (!shouldStop()) {
    if (!demand.shouldConnect()) {
      if (!idleLogged) {
        console.log(`${label} idle (${demand.reason}), Ring disconnected`)
        publisher.markSourceDown()
        idleLogged = true
      }
      await sleep(DEMAND_POLL_MS)
      continue
    }
    idleLogged = false

    const startedAt = Date.now()
    let session: StreamingSession | undefined

    try {
      console.log(`${label} dialing Ring (${demand.reason})`)
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
          '-s', `${settings.width}x${settings.height}`,
          '-r', String(settings.fps),
          'pipe:1',
          // "0:a?" so a camera without an audio stream still publishes video.
          ...(runtime.audioPort !== undefined
            ? [
                '-map', '0:a?',
                '-f', 's16le',
                '-ar', String(SAMPLE_RATE),
                '-ac', '1',
                `tcp://127.0.0.1:${runtime.audioPort}`,
              ]
            : []),
        ],
        stdoutCallback: (data) => publisher.pushDecoderChunk(data),
      })
      runtime.session = session

      // End the call as soon as demand goes away, rather than waiting for
      // Ring's own twelve-minute timer.
      await Promise.race([
        firstValueFrom(session.onCallEnded),
        waitUntilIdle(demand, shouldStop),
      ])

      const durationSec = Math.round((Date.now() - startedAt) / 1000)
      console.log(`${label} Ring call ended after ${durationSec}s`)
    } catch (error) {
      console.error(`${label} Ring stream error: ${String(error)}`)
    } finally {
      session?.stop()
      runtime.session = undefined
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

    if (demand.shouldConnect()) {
      console.log(`${label} redialing Ring in ${Math.round(delay / 1000)}s`)
    }
    await sleep(delay)
  }
}

/** Wait for a camera's Ring session to come up, for two-way audio. */
function waitForSession(
  runtime: CameraRuntime,
  timeoutMs: number,
): Promise<StreamingSession | undefined> {
  return new Promise((resolve) => {
    if (runtime.session) {
      resolve(runtime.session)
      return
    }
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (runtime.session || Date.now() > deadline) {
        clearInterval(timer)
        resolve(runtime.session)
      }
    }, 250)
  })
}

/** Resolves once demand drops, so an active call can be torn down promptly. */
function waitUntilIdle(
  demand: DemandTracker,
  shouldStop: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (shouldStop() || !demand.shouldConnect()) {
        clearInterval(timer)
        resolve()
      }
    }, DEMAND_POLL_MS)
    timer.unref()
  })
}

async function startAdmin(deps: {
  config: BridgeConfig
  configPath: string
  runtimes: CameraRuntime[]
  server: RtspServer
  eventCollector: RingEventCollector
  startedAt: number
  mqtt: MqttBridge
}): Promise<AdminServer> {
  const { config, configPath, runtimes, server, eventCollector, startedAt } = deps
  const bySlug = new Map(runtimes.map((r) => [r.path, r]))

  const admin = new AdminServer(
    {
      getStatus: () => {
        const info = new Map(server.streamInfo().map((i) => [i.path, i]))
        return {
          startedAt,
          rtspPort: config.rtspPort,
          cameras: runtimes.map((r) => {
            const stats = r.publisher.stats
            return {
              name: r.camera.name,
              path: r.path,
              live: stats.live,
              connected: r.session !== undefined,
              demandReason: r.demand.reason,
              pinned: r.demand.pinned,
              alwaysOn: r.settings.alwaysOn,
              onDemand: r.settings.onDemand,
              lastFrameAt: stats.lastFrameAt,
              droppedFrames: stats.droppedFrames,
              encoderRestarts: stats.encoderRestarts,
              peakQueuedFrames: stats.peakQueuedFrames,
              audioBufferedMs: stats.audioBufferedMs,
              clients: info.get(r.path)?.clients ?? 0,
              bytesSent: info.get(r.path)?.bytesSent ?? 0,
              outputs: stats.outputs.map((o) => ({
                ...o,
                path: o.name === 'sub' ? `${r.path}_sub` : r.path,
                clients:
                  info.get(o.name === 'sub' ? `${r.path}_sub` : r.path)?.clients ?? 0,
                bytesSent:
                  info.get(o.name === 'sub' ? `${r.path}_sub` : r.path)?.bytesSent ?? 0,
              })),
            }
          }),
          events: eventCollector.status,
          mqtt: deps.mqtt.status,
        }
      },
      getConfig: () => config,
      applyConfig: (cameraName, patch) => {
        const invalid = validateSettings(patch)
        if (invalid) {
          return { error: invalid }
        }

        const target = cameraName
          ? runtimes.filter((r) => r.camera.name === cameraName)
          : runtimes

        if (target.length === 0) {
          return { error: `unknown camera: ${cameraName}` }
        }

        for (const runtime of target) {
          const key = cameraName ?? undefined
          if (key) {
            config.cameras[key] = { ...config.cameras[key], ...patch }
          } else {
            Object.assign(config.defaults, patch)
          }
          Object.assign(runtime.settings, patch)
          runtime.demand.update({
            alwaysOn: runtime.settings.alwaysOn,
            onDemand: runtime.settings.onDemand,
            idleTimeoutSec: runtime.settings.idleTimeoutSec,
          })
          runtime.publisher.reconfigure({
            width: patch.width ?? runtime.settings.width,
            height: patch.height ?? runtime.settings.height,
            sourceFps: patch.fps,
            encoder: patch.encoder,
            crf: patch.crf,
            preset: patch.preset,
            ...('bitrateKbps' in patch ? { bitrateKbps: patch.bitrateKbps } : {}),
          })
        }

        saveConfig(configPath, config)
        return { applied: Object.keys(patch), configPath }
      },
      pinCamera: (path, seconds) => {
        const runtime = bySlug.get(path)
        if (!runtime) return false
        if (seconds > 0) runtime.demand.pin(seconds)
        else runtime.demand.unpin()
        return true
      },
      talk: async (path, audioPath) => {
        const runtime = bySlug.get(path)
        if (!runtime) {
          return { error: 'unknown camera' }
        }
        // An on-demand camera is probably asleep; wake it and wait for the
        // session before trying to push audio into it.
        runtime.demand.pin(60)
        const session = await waitForSession(runtime, 20_000)
        if (!session) {
          return { error: 'camera did not connect in time' }
        }
        try {
          session.activateCameraSpeaker()
          await session.transcodeReturnAudio({ input: [audioPath] })
          console.log(`${runtime.publisher.stats.label} played audio to speaker`)
          return {}
        } catch (error) {
          return { error: String(error) }
        }
      },
      getPublisher: (path) => bySlug.get(path)?.publisher,
      getRuntime: (path) => bySlug.get(path),
      events: eventCollector,
      refreshEvents: () => eventCollector.refresh(),
    },
    config.webToken,
  )

  await admin.listen(config.webPort, config.webBind)
  console.log(
    `Admin dashboard on http://${config.webBind}:${config.webPort}` +
      (config.webToken ? ' (token required)' : ''),
  )
  if (!config.webToken && config.webBind !== '127.0.0.1' && config.webBind !== 'localhost') {
    console.warn(
      '[admin] WARNING: dashboard is reachable on the network with no token. ' +
        'Anyone who can reach this port can view camera snapshots, logs and events, ' +
        'and change encoder settings. Use --web-token, --web-bind 127.0.0.1, or --no-web.',
    )
  }
  return admin
}
