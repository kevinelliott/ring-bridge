/**
 * Pick the best available H.264 encoder.
 *
 * libx264 works everywhere but burns roughly a core per 1080p camera, which is
 * the single biggest cost of running this bridge. Most machines have hardware
 * encoding available and simply are not asked to use it, so probe for it and
 * prefer it -- while still letting an explicit --encoder win.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Ordered best-first; the first one ffmpeg reports is used. */
const HARDWARE_CANDIDATES = [
  { name: 'h264_videotoolbox', platform: 'darwin', label: 'Apple VideoToolbox' },
  { name: 'h264_nvenc', platform: 'any', label: 'NVIDIA NVENC' },
  { name: 'h264_qsv', platform: 'any', label: 'Intel Quick Sync' },
  { name: 'h264_vaapi', platform: 'linux', label: 'VA-API' },
  { name: 'h264_v4l2m2m', platform: 'linux', label: 'V4L2 M2M (Raspberry Pi)' },
] as const

export interface EncoderInfo {
  name: string
  label: string
  hardware: boolean
}

export async function listEncoders(): Promise<Set<string>> {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders'], {
      maxBuffer: 4 * 1024 * 1024,
    })
    const names = new Set<string>()
    for (const line of stdout.split('\n')) {
      // Format: " V....D h264_nvenc   NVIDIA NVENC H.264 encoder"
      const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)
      if (match?.[1]) {
        names.add(match[1])
      }
    }
    return names
  } catch {
    return new Set()
  }
}

/**
 * Hardware encoders are cheap but not always functional (a VA-API device may be
 * absent, NVENC may be a stub). Probe by actually encoding two frames.
 */
export async function encoderWorks(name: string): Promise<boolean> {
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=black:s=320x240:r=5',
      '-frames:v', '2', '-c:v', name, '-f', 'null', '-',
    ], { timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

export async function detectBestEncoder(): Promise<EncoderInfo> {
  const available = await listEncoders()
  for (const candidate of HARDWARE_CANDIDATES) {
    if (candidate.platform !== 'any' && candidate.platform !== process.platform) {
      continue
    }
    if (!available.has(candidate.name)) {
      continue
    }
    if (await encoderWorks(candidate.name)) {
      return { name: candidate.name, label: candidate.label, hardware: true }
    }
  }
  return { name: 'libx264', label: 'libx264 (software)', hardware: false }
}
