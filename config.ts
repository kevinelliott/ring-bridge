/**
 * Configuration: file-backed, per-camera, with CLI overrides.
 *
 * Precedence is file < CLI. The file is the durable source of truth and is
 * what the dashboard writes to, so a setting tuned in the browser survives a
 * restart. A CLI flag wins for that run only and is never written back --
 * otherwise a one-off `--fps 5` would silently become permanent.
 *
 * Camera keys are matched case-insensitively against the Ring camera name.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Resolved against the working directory rather than the module, so an
 * installed copy reads the config belonging to wherever it was run -- not one
 * buried in node_modules.
 */
export const DEFAULT_CONFIG_PATH = resolve('ring-bridge.config.json')

/** Encoder settings; every field is overridable per camera. */
export interface StreamSettings {
  width: number
  height: number
  fps: number
  encoder: string
  crf: number
  preset: string
  bitrateKbps?: number
  audio: boolean
}

/** A lower-resolution companion stream, published at `<path>_sub`. */
export interface SubstreamSettings {
  width: number
  height: number
  fps: number
  crf: number
  bitrateKbps?: number
}

export interface CameraSettings extends StreamSettings {
  /**
   * Hold the Ring connection open even with no RTSP clients. Necessary for
   * anything that needs an always-current frame; costly for battery cameras.
   */
  alwaysOn: boolean
  /** Dial Ring only while a client is watching. */
  onDemand: boolean
  /** How long to keep Ring connected after the last client disconnects. */
  idleTimeoutSec: number
  substream?: SubstreamSettings
  /** Exclude this camera from the bridge entirely. */
  enabled: boolean
}

export interface MqttConfig {
  url?: string
  username?: string
  password?: string
  topicPrefix: string
  /** Home Assistant MQTT discovery prefix; empty disables discovery. */
  discoveryPrefix: string
}

export interface BridgeConfig {
  rtspPort: number
  webPort: number
  webBind: string
  webToken?: string
  /** Paths to a TLS certificate and key; both required to enable HTTPS. */
  tlsCert?: string
  tlsKey?: string
  /**
   * Serve stills at /snapshot/<camera>.jpg without the admin token, for NVRs
   * and integrations that want a still-image URL. Off by default: it exposes
   * camera images to anyone who can reach the port.
   */
  publicSnapshots: boolean
  /** Seconds between checks for cameras added or removed in the Ring app. */
  cameraRefreshSec: number
  logFile?: string
  webhookUrl?: string
  mqtt: MqttConfig
  defaults: CameraSettings
  /** Per-camera overrides, keyed by camera name. */
  cameras: Record<string, Partial<CameraSettings>>
}

export const BUILT_IN_DEFAULTS: BridgeConfig = {
  rtspPort: 8554,
  webPort: 8080,
  webBind: '0.0.0.0',
  publicSnapshots: false,
  cameraRefreshSec: 900,
  mqtt: {
    topicPrefix: 'ring-bridge',
    discoveryPrefix: 'homeassistant',
  },
  defaults: {
    width: 1920,
    height: 1080,
    fps: 20,
    encoder: 'libx264',
    crf: 21,
    preset: 'veryfast',
    audio: true,
    alwaysOn: false,
    onDemand: true,
    idleTimeoutSec: 30,
    enabled: true,
  },
  cameras: {},
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shallow-merge known keys only, so an unexpected file cannot inject fields. */
function mergeSettings(
  base: CameraSettings,
  patch: Partial<CameraSettings> | undefined,
): CameraSettings {
  if (!patch) {
    return { ...base }
  }
  const out: CameraSettings = { ...base }
  const assign = <K extends keyof CameraSettings>(key: K): void => {
    const value = patch[key]
    if (value !== undefined) {
      out[key] = value as CameraSettings[K]
    }
  }
  assign('width'); assign('height'); assign('fps')
  assign('encoder'); assign('crf'); assign('preset'); assign('bitrateKbps')
  assign('audio'); assign('alwaysOn'); assign('onDemand')
  assign('idleTimeoutSec'); assign('enabled')
  if (patch.substream !== undefined) {
    out.substream = patch.substream ?? undefined
  }
  return out
}

export function loadConfig(path: string): BridgeConfig {
  if (!existsSync(path)) {
    return structuredClone(BUILT_IN_DEFAULTS)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${String(error)}`)
  }
  if (!isObject(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  const config = structuredClone(BUILT_IN_DEFAULTS)

  if (typeof parsed.rtspPort === 'number') config.rtspPort = parsed.rtspPort
  if (typeof parsed.webPort === 'number') config.webPort = parsed.webPort
  if (typeof parsed.webBind === 'string') config.webBind = parsed.webBind
  if (typeof parsed.webToken === 'string') config.webToken = parsed.webToken
  if (typeof parsed.tlsCert === 'string') config.tlsCert = parsed.tlsCert
  if (typeof parsed.tlsKey === 'string') config.tlsKey = parsed.tlsKey
  if (typeof parsed.publicSnapshots === 'boolean') {
    config.publicSnapshots = parsed.publicSnapshots
  }
  if (typeof parsed.cameraRefreshSec === 'number') {
    config.cameraRefreshSec = parsed.cameraRefreshSec
  }
  if (typeof parsed.logFile === 'string') config.logFile = parsed.logFile
  if (typeof parsed.webhookUrl === 'string') config.webhookUrl = parsed.webhookUrl

  if (isObject(parsed.mqtt)) {
    const m = parsed.mqtt
    if (typeof m.url === 'string') config.mqtt.url = m.url
    if (typeof m.username === 'string') config.mqtt.username = m.username
    if (typeof m.password === 'string') config.mqtt.password = m.password
    if (typeof m.topicPrefix === 'string') config.mqtt.topicPrefix = m.topicPrefix
    if (typeof m.discoveryPrefix === 'string') {
      config.mqtt.discoveryPrefix = m.discoveryPrefix
    }
  }

  if (isObject(parsed.defaults)) {
    config.defaults = mergeSettings(
      config.defaults,
      parsed.defaults as Partial<CameraSettings>,
    )
  }

  if (isObject(parsed.cameras)) {
    for (const [name, value] of Object.entries(parsed.cameras)) {
      if (isObject(value)) {
        config.cameras[name] = value as Partial<CameraSettings>
      }
    }
  }

  return config
}

/** Effective settings for one camera: defaults with its overrides applied. */
export function settingsFor(
  config: BridgeConfig,
  cameraName: string,
): CameraSettings {
  const key = Object.keys(config.cameras).find(
    (name) => name.toLowerCase() === cameraName.toLowerCase(),
  )
  return mergeSettings(config.defaults, key ? config.cameras[key] : undefined)
}

/** Write via temp file + rename so a crash cannot truncate the config. */
export function saveConfig(path: string, config: BridgeConfig): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n')
  renameSync(temp, path)
}

export function resolveConfigPath(argPath?: string): string {
  return argPath ? resolve(argPath) : DEFAULT_CONFIG_PATH
}

export function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value.trim())
  if (!match) {
    throw new Error(`expected WxH, got "${value}"`)
  }
  const width = Number(match[1])
  const height = Number(match[2])
  // yuv420p subsamples chroma 2x2, so odd dimensions have no valid layout.
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error('width and height must both be even')
  }
  return { width, height }
}

/** Validate settings the same way regardless of whether CLI or UI set them. */
export function validateSettings(s: Partial<CameraSettings>): string | undefined {
  if (s.fps !== undefined && (!Number.isFinite(s.fps) || s.fps < 1 || s.fps > 60)) {
    return 'fps must be between 1 and 60'
  }
  if (s.crf !== undefined && (!Number.isInteger(s.crf) || s.crf < 0 || s.crf > 51)) {
    return 'crf must be an integer between 0 and 51'
  }
  if (
    s.bitrateKbps !== undefined &&
    s.bitrateKbps !== null &&
    (!Number.isFinite(s.bitrateKbps) || s.bitrateKbps < 100)
  ) {
    return 'bitrate must be at least 100 kbit/s'
  }
  if (s.width !== undefined && (s.width % 2 !== 0 || s.width < 160)) {
    return 'width must be even and at least 160'
  }
  if (s.height !== undefined && (s.height % 2 !== 0 || s.height < 120)) {
    return 'height must be even and at least 120'
  }
  if (s.encoder !== undefined && !/^[\w-]+$/.test(s.encoder)) {
    return 'encoder name has unexpected characters'
  }
  if (s.preset !== undefined && !/^[a-z]+$/.test(s.preset)) {
    return 'preset has unexpected characters'
  }
  if (
    s.idleTimeoutSec !== undefined &&
    (!Number.isFinite(s.idleTimeoutSec) || s.idleTimeoutSec < 0)
  ) {
    return 'idleTimeoutSec must be zero or more'
  }
  return undefined
}
