/**
 * Preflight checks.
 *
 * Nearly every failed setup is one of a handful of things: no ffmpeg, a stale
 * token, a port already in use, or an encoder the machine cannot actually run.
 * Each is quick to test and miserable to diagnose from a stack trace, so test
 * them all up front and say which one it is.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { RingApi } from 'ring-client-api'
import { loadConfig } from './config.ts'
import { detectBestEncoder, listEncoders, encoderWorks } from './encoder-detect.ts'

const run = promisify(execFile)

type Status = 'ok' | 'warn' | 'fail'
interface Check {
  name: string
  status: Status
  detail: string
}

const ICON: Record<Status, string> = { ok: '✔', warn: '!', fail: '✖' }

async function checkFfmpeg(): Promise<Check> {
  try {
    const { stdout } = await run('ffmpeg', ['-version'])
    const version = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'unknown'
    return { name: 'ffmpeg', status: 'ok', detail: `found, version ${version}` }
  } catch {
    return {
      name: 'ffmpeg',
      status: 'fail',
      detail: 'not found on PATH — install it (brew install ffmpeg / apt install ffmpeg)',
    }
  }
}

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0])
  return major >= 22
    ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
    : {
        name: 'node',
        status: 'fail',
        detail: `v${process.versions.node} — this project needs Node 22 or newer`,
      }
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

async function checkPort(label: string, port: number, host: string): Promise<Check> {
  if (port === 0) {
    return { name: label, status: 'ok', detail: 'disabled' }
  }
  const free = await portFree(port, host)
  return free
    ? { name: label, status: 'ok', detail: `${host}:${port} is free` }
    : { name: label, status: 'fail', detail: `${host}:${port} is already in use` }
}

async function checkToken(): Promise<Check> {
  const token = process.env.RING_REFRESH_TOKEN
  if (!token) {
    return {
      name: 'ring token',
      status: 'fail',
      detail: 'RING_REFRESH_TOKEN not set — see .env.example',
    }
  }
  try {
    const api = new RingApi({ refreshToken: token })
    const locations = await api.getLocations()
    const cameras = locations.flatMap((l) => l.cameras)
    api.disconnect()
    return {
      name: 'ring token',
      status: 'ok',
      detail: `valid — ${locations.length} location(s), ${cameras.length} camera(s)`,
    }
  } catch (error) {
    return {
      name: 'ring token',
      status: 'fail',
      detail: `rejected by Ring: ${String(error)}`,
    }
  }
}

async function checkEncoder(configured: string): Promise<Check[]> {
  const checks: Check[] = []
  const available = await listEncoders()

  if (!available.has(configured)) {
    checks.push({
      name: 'encoder',
      status: 'fail',
      detail: `"${configured}" is not built into this ffmpeg`,
    })
  } else if (await encoderWorks(configured)) {
    checks.push({ name: 'encoder', status: 'ok', detail: `"${configured}" works` })
  } else {
    checks.push({
      name: 'encoder',
      status: 'fail',
      detail: `"${configured}" is present but failed a test encode`,
    })
  }

  const best = await detectBestEncoder()
  if (best.hardware && best.name !== configured) {
    checks.push({
      name: 'hardware encoding',
      status: 'warn',
      detail: `${best.label} is available — "--encoder ${best.name}" would cut CPU sharply`,
    })
  } else if (!best.hardware) {
    checks.push({
      name: 'hardware encoding',
      status: 'warn',
      detail: 'none detected; expect roughly one core per 1080p camera',
    })
  } else {
    checks.push({ name: 'hardware encoding', status: 'ok', detail: best.label })
  }

  return checks
}

function checkCpu(cameraCount: number): Check {
  const cores = navigator?.hardwareConcurrency ?? 0
  if (!cores) {
    return { name: 'cpu', status: 'warn', detail: 'could not determine core count' }
  }
  // One 1080p20 software encode plus its decode is roughly one core.
  const needed = Math.max(1, cameraCount)
  return needed <= cores - 1
    ? { name: 'cpu', status: 'ok', detail: `${cores} cores for ~${needed} camera(s)` }
    : {
        name: 'cpu',
        status: 'warn',
        detail: `${cores} cores for ~${needed} camera(s) — consider --fps 10, a smaller --size, or a hardware encoder`,
      }
}

export async function runDoctor(configPath: string): Promise<number> {
  console.log('ring-bridge doctor\n')

  const config = existsSync(configPath) ? loadConfig(configPath) : loadConfig('')
  const checks: Check[] = [checkNode(), await checkFfmpeg()]

  checks.push({
    name: 'config',
    status: existsSync(configPath) ? 'ok' : 'warn',
    detail: existsSync(configPath)
      ? configPath
      : `${configPath} not found — using built-in defaults`,
  })

  checks.push(await checkPort('rtsp port', config.rtspPort, '0.0.0.0'))
  checks.push(await checkPort('web port', config.webPort, config.webBind))

  const tokenCheck = await checkToken()
  checks.push(tokenCheck)

  const cameraCount = Number(/(\d+) camera/.exec(tokenCheck.detail)?.[1] ?? 1)
  checks.push(...(await checkEncoder(config.defaults.encoder)))
  checks.push(checkCpu(cameraCount))

  if (!config.webToken && config.webBind !== '127.0.0.1' && config.webPort > 0) {
    checks.push({
      name: 'dashboard auth',
      status: 'warn',
      detail: 'no token and bound to the network — anyone on your LAN can view cameras',
    })
  }

  const width = Math.max(...checks.map((c) => c.name.length))
  for (const check of checks) {
    console.log(`  ${ICON[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`)
  }

  const failures = checks.filter((c) => c.status === 'fail').length
  const warnings = checks.filter((c) => c.status === 'warn').length
  console.log(
    `\n${failures ? `${failures} problem(s)` : 'No problems'}` +
      `${warnings ? `, ${warnings} warning(s)` : ''}.`,
  )
  return failures > 0 ? 1 : 0
}
