/**
 * Dial one camera once and report exactly what Ring sends.
 *
 * Useful before tuning anything: the bridge cannot produce more detail than the
 * source carries, so knowing the real resolution, frame rate and bitrate tells
 * you whether a quality problem is worth chasing.
 */
import { spawn } from 'node:child_process'
import { unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RingApi } from 'ring-client-api'
import { firstValueFrom, timeout, catchError, of } from 'rxjs'
import { loadRefreshToken } from './ring-auth.ts'

interface ProbeResult {
  width?: number
  height?: number
  fps?: string
  videoCodec?: string
  audioCodec?: string
  sampleRate?: string
  durationSec?: number
  bitrateMbps?: number
}

function probe(path: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate',
      '-show_entries', 'format=duration,size',
      '-of', 'json', path,
    ])
    let out = ''
    ff.stdout.on('data', (d: Buffer) => (out += d.toString()))
    ff.on('close', () => {
      try {
        const data = JSON.parse(out) as {
          streams?: Array<Record<string, string | number>>
          format?: Record<string, string>
        }
        const video = data.streams?.find((s) => s.codec_type === 'video')
        const audio = data.streams?.find((s) => s.codec_type === 'audio')
        const duration = Number(data.format?.duration ?? 0)
        const size = Number(data.format?.size ?? 0)
        resolve({
          width: video?.width as number | undefined,
          height: video?.height as number | undefined,
          fps: video?.r_frame_rate as string | undefined,
          videoCodec: video?.codec_name as string | undefined,
          audioCodec: audio?.codec_name as string | undefined,
          sampleRate: audio?.sample_rate as string | undefined,
          durationSec: duration || undefined,
          bitrateMbps: duration ? Math.round((size * 8) / duration / 1e4) / 100 : undefined,
        })
      } catch {
        resolve({})
      }
    })
  })
}

export async function runCameraTest(
  cameraName: string | undefined,
  seconds: number,
  keepPath?: string,
): Promise<number> {
  const api = new RingApi({ refreshToken: loadRefreshToken() })
  const locations = await api.getLocations()
  const cameras = locations.flatMap((l) => l.cameras)

  const camera = cameraName
    ? cameras.find((c) => c.name.toLowerCase() === cameraName.toLowerCase())
    : cameras[0]

  if (!camera) {
    console.error(
      `No camera named "${cameraName}". Available: ${cameras.map((c) => c.name).join(', ')}`,
    )
    api.disconnect()
    return 1
  }

  const outPath = keepPath ?? join(tmpdir(), `ring-bridge-test-${Date.now()}.mp4`)
  console.log(`Testing "${camera.name}" (${camera.model}) for ${seconds}s...`)
  console.log(`  reported state: ${camera.isOffline ? 'offline' : 'online'}` +
    `${camera.hasBattery ? `, battery ${camera.batteryLevel ?? '?'}%` : ', wired'}`)

  const startedAt = Date.now()
  try {
    // Stream-copy so the figures describe Ring's own encode, not a re-encode.
    const session = await camera.streamVideo({
      audio: ['-acodec', 'aac'],
      video: ['-vcodec', 'copy'],
      output: ['-t', String(seconds), '-y', outPath],
    })
    await firstValueFrom(
      session.onCallEnded.pipe(
        timeout((seconds + 25) * 1000),
        catchError(() => of(null)),
      ),
    )
    session.stop()
  } catch (error) {
    console.error(`\n  FAILED to stream: ${String(error)}`)
    api.disconnect()
    return 1
  }
  api.disconnect()

  const connectSec = Math.round((Date.now() - startedAt) / 10) / 100
  if (!existsSync(outPath)) {
    console.error('\n  FAILED: no output produced — check DEBUG=ring for ffmpeg errors')
    return 1
  }

  const result = await probe(outPath)
  console.log('\nWhat Ring actually sends:')
  console.log(`  resolution   ${result.width ?? '?'}x${result.height ?? '?'}`)
  console.log(`  frame rate   ${result.fps ?? '?'}`)
  console.log(`  video codec  ${result.videoCodec ?? '?'}`)
  console.log(`  bitrate      ${result.bitrateMbps ?? '?'} Mbps`)
  console.log(`  audio        ${result.audioCodec ?? 'none'}${result.sampleRate ? ` @ ${result.sampleRate} Hz` : ''}`)
  console.log(`  captured     ${result.durationSec?.toFixed(1) ?? '?'}s in ${connectSec}s wall clock`)

  if (result.width && result.height) {
    console.log(
      `\n  Suggested config: --size ${result.width}x${result.height}` +
        `${result.fps ? ` --fps ${result.fps.split('/')[0]}` : ''}`,
    )
    console.log('  Anything larger only upscales; Ring is the ceiling.')
  }

  if (keepPath) {
    console.log(`\n  Sample kept at ${keepPath}`)
  } else {
    try { unlinkSync(outPath) } catch { /* best effort */ }
  }
  return 0
}
