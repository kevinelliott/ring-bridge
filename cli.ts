#!/usr/bin/env node
/**
 * ring-bridge command line.
 *
 * Subcommands rather than flags-on-one-entry-point, because the things you do
 * with this tool are genuinely different verbs: inspect an account, check a
 * machine, probe one camera, or run the bridge.
 */
import { runBridge, type CliOverrides } from './bridge.ts'
import { runDoctor } from './doctor.ts'
import { runCameraTest } from './camera-test.ts'
import { listCameras } from './ring.ts'
import { runLogin } from './login-cli.ts'
import { resolveConfigPath, parseSize, validateSettings } from './config.ts'
import { detectBestEncoder } from './encoder-detect.ts'
import { isAuthError } from './ring-login.ts'

const USAGE = `ring-bridge — serve Ring cameras as RTSP

Usage:
  ring-bridge login                 Log in to Ring and save a refresh token
  ring-bridge run [options]         Run the bridge (default)
  ring-bridge list [--json]         List locations and cameras
  ring-bridge test [name] [-n SEC]  Dial one camera and report what Ring sends
  ring-bridge doctor                Check this machine is ready
  ring-bridge encoders              Show the best available video encoder

Run options:
  --config <path>    Config file (default ring-bridge.config.json)
  --port <n>         RTSP listen port
  --camera "Name"    Bridge only this camera; repeatable
  --size WxH         Output resolution
  --fps <n>          Output frame rate
  --encoder <name>   Video encoder, or "auto" to detect hardware support
  --crf <n>          Quality, lower is better (libx264/libx265)
  --preset <name>    x264 preset
  --bitrate <kbps>   Target bitrate; overrides --crf
  --no-audio         Publish video only
  --always-on        Keep Ring connected even with no clients
  --no-on-demand     Same as --always-on
  --idle-timeout <s> Seconds to hold Ring after the last client leaves
  --web-port <n>     Dashboard port (0 disables)
  --web-bind <addr>  Dashboard bind address
  --web-token <s>    Require a token for the dashboard
  --no-web           Disable the dashboard
  --tls-cert <path>  Serve the dashboard over HTTPS (with --tls-key)
  --tls-key <path>   Private key for --tls-cert
  --public-snapshots Serve /snapshot/<camera>.jpg without the admin token
  --onvif-port <n>   Enable ONVIF discovery on this port (0 disables)
  --push-notifications
                     Register for Ring push. Instant events, but Ring's device
                     limit means this can stop your phone and chime alerting.

Test options:
  -n, --seconds <n>  Capture length (default 10)
  --keep <path>      Keep the sample clip at this path`

interface ParsedArgs {
  command: string
  configPath: string
  overrides: CliOverrides
  testName?: string
  testSeconds: number
  testKeep?: string
  json: boolean
  encoderAuto: boolean
}

function parse(argv: string[]): ParsedArgs {
  const known = new Set(['run', 'list', 'test', 'doctor', 'encoders', 'login', 'help'])
  let command = 'run'
  let index = 0
  if (argv[0] && known.has(argv[0])) {
    command = argv[0]
    index = 1
  } else if (argv[0] && !argv[0].startsWith('-')) {
    throw new Error(`Unknown command: ${argv[0]}`)
  }

  const out: ParsedArgs = {
    command,
    configPath: resolveConfigPath(),
    overrides: {},
    testSeconds: 10,
    json: false,
    encoderAuto: false,
  }
  const o = out.overrides

  for (; index < argv.length; index++) {
    const arg = argv[index]
    const next = (): string => {
      const value = argv[++index]
      if (value === undefined) {
        throw new Error(`${arg} requires a value`)
      }
      return value
    }

    switch (arg) {
      case '--config': out.configPath = resolveConfigPath(next()); break
      case '--port': o.rtspPort = Number(next()); break
      case '--camera': (o.cameraFilter ??= []).push(next().toLowerCase()); break
      case '--size': {
        const { width, height } = parseSize(next())
        o.width = width
        o.height = height
        break
      }
      case '--fps': o.fps = Number(next()); break
      case '--encoder': {
        const value = next()
        if (value === 'auto') out.encoderAuto = true
        else o.encoder = value
        break
      }
      case '--crf': o.crf = Number(next()); break
      case '--preset': o.preset = next(); break
      case '--bitrate': o.bitrateKbps = Number(next()); break
      case '--no-audio': o.audio = false; break
      case '--always-on': o.alwaysOn = true; break
      case '--no-on-demand': o.onDemand = false; break
      case '--idle-timeout': o.idleTimeoutSec = Number(next()); break
      case '--web-port': o.webPort = Number(next()); break
      case '--web-bind': o.webBind = next(); break
      case '--web-token': o.webToken = next(); break
      case '--no-web': o.noWeb = true; break
      case '--tls-cert': o.tlsCert = next(); break
      case '--tls-key': o.tlsKey = next(); break
      case '--public-snapshots': o.publicSnapshots = true; break
      case '--onvif-port': o.onvifPort = Number(next()); break
      case '--push-notifications': o.pushNotifications = true; break
      case '--json': out.json = true; break
      case '-n': case '--seconds': out.testSeconds = Number(next()); break
      case '--keep': out.testKeep = next(); break
      case '-h': case '--help': out.command = 'help'; break
      default:
        if (out.command === 'test' && arg && !arg.startsWith('-') && !out.testName) {
          out.testName = arg
        } else {
          throw new Error(`Unknown argument: ${arg}`)
        }
    }
  }

  const invalid = validateSettings(o)
  if (invalid) {
    throw new Error(invalid)
  }
  if (o.rtspPort !== undefined && (!Number.isInteger(o.rtspPort) || o.rtspPort < 1 || o.rtspPort > 65535)) {
    throw new Error('--port must be a valid TCP port')
  }
  if (out.testSeconds < 1 || out.testSeconds > 120) {
    throw new Error('--seconds must be between 1 and 120')
  }

  return out
}

let args: ParsedArgs
try {
  args = parse(process.argv.slice(2))
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
  process.exit(1)
}

if (args.command === 'help') {
  console.log(USAGE)
  process.exit(0)
}

if (args.encoderAuto) {
  const best = await detectBestEncoder()
  console.log(`[encoder] auto-detected ${best.label}`)
  args.overrides.encoder = best.name
}

/**
 * Report failures as a sentence rather than a stack trace. A missing token or
 * an unreachable Ring is a setup problem, not a crash, and the person seeing it
 * is usually mid-install.
 */
try {
  switch (args.command) {
    case 'login':
      process.exit(await runLogin())
      break
    case 'list':
      process.exit(await listCameras({ json: args.json }))
      break
    case 'doctor':
      process.exit(await runDoctor(args.configPath))
      break
    case 'encoders': {
      const best = await detectBestEncoder()
      console.log(`Best available: ${best.name}  (${best.label})`)
      console.log(
        best.hardware
          ? 'Use it with:  ring-bridge run --encoder ' + best.name
          : 'No working hardware encoder found; libx264 will use roughly one core per 1080p camera.',
      )
      process.exit(0)
      break
    }
    case 'test':
      process.exit(await runCameraTest(args.testName, args.testSeconds, args.testKeep))
      break
    default:
      await runBridge({ configPath: args.configPath, overrides: args.overrides })
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\nring-bridge ${args.command}: ${message}`)
  if (/RING_REFRESH_TOKEN/.test(message)) {
    console.error('\nRun `npx ring-bridge login` to sign in and save one.')
  } else if (isAuthError(error)) {
    console.error(
      '\nRing rejected the stored refresh token. Run `npx ring-bridge login` to sign in again.',
    )
  }
  process.exit(1)
}
