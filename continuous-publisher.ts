/**
 * A persistent RTSP publisher that never drops.
 *
 * The encoder process is long-lived and owns the RTSP session. It is fed by a
 * fixed-rate frame clock rather than directly by Ring, which decouples output
 * timing from Ring's availability: when live frames are arriving the clock
 * forwards the newest one, and when they stop it forwards the last known frame
 * dimmed, with an animated spinner composited on top.
 *
 * Audio rides the same clock. Every tick writes exactly one video frame and
 * exactly `sampleRate / fps` audio samples -- Ring's audio when it is arriving,
 * silence when it is not. Because ffmpeg derives timestamps for both raw inputs
 * from their declared rates, holding that ratio keeps A/V in sync by
 * construction rather than by timer accuracy.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'
import {
  buildFillerBase,
  buildSpinner,
  createBlackFrame,
  drawSpinner,
  frameSize,
  restoreBbox,
  type Sprite,
  DOT_COUNT,
} from './spinner.ts'

/** Settings the admin UI can change while the bridge is running. */
export interface TunableOptions {
  fps: number
  encoder: string
  crf: number
  preset: string
  bitrateKbps?: number
  width: number
  height: number
}

export interface PublisherStats {
  readonly label: string
  readonly live: boolean
  readonly lastFrameAt: number
  readonly droppedFrames: number
  readonly encoderRestarts: number
  readonly startedAt: number
  readonly settings: TunableOptions
  readonly hasAudio: boolean
  readonly audioBufferedMs: number
  /** Peak encoder queue depth, in frames, since the process started. */
  readonly peakQueuedFrames: number
}

export interface PublisherOptions {
  /** Loopback UDP port of the built-in RTSP server's video track. */
  readonly rtpPort: number
  /** Loopback UDP port of the audio track; omit to publish video only. */
  readonly audioRtpPort?: number
  readonly sampleRate: number
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly label: string
  readonly encoder: string
  /** Constant Rate Factor for libx264/libx265; ignored by other encoders. */
  readonly crf: number
  readonly preset: string
  /** Target video bitrate in kbit/s. Overrides crf; required for hardware encoders. */
  readonly bitrateKbps?: number
  /** Public RTSP URL, for logging only. */
  readonly displayUrl: string
}

/** No live frame for this long => Ring is considered down, show the spinner. */
const STALE_MS = 2_000
/** Spinner rotation speed, independent of output fps. */
const SPINNER_STEP_MS = 1000 / 12
const ENCODER_RESTART_MS = 2_000
const BYTES_PER_SAMPLE = 2
/**
 * Cap on buffered Ring audio. Ring produces samples in real time and the clock
 * consumes them in real time, so a persistent surplus means clock drift; older
 * audio is dropped rather than allowed to become unbounded latency.
 */
const MAX_AUDIO_BUFFER_MS = 400
/**
 * How much video may sit queued for the encoder before the clock skips a frame.
 *
 * Measured against the pipe's queue depth, not write()'s return value: a raw
 * 1080p frame is ~3.1MB against a 64KB highWaterMark, so write() reports
 * backpressure on every single frame and using it would make each tick a race
 * against the drain event.
 *
 * Skipping is a last resort rather than routine flow control. A skipped frame
 * shortens the output timeline permanently -- the encoder stamps frames from
 * its fixed input rate, so N missing frames leave playback N/fps further behind
 * real time forever. Absorbing a stall in the queue instead costs only
 * transient latency, which drains away because the encoder runs several times
 * faster than real time. Measured stalls reach ~750ms around a Ring reconnect,
 * so this allows roughly double that before giving up.
 *
 * Memory cost is the ceiling times the frame size (~93MB per camera at 1080p),
 * and only while a stall is actually in progress.
 */
const MAX_QUEUE_MS = 1500

export class ContinuousPublisher {
  private options: PublisherOptions
  private bytesPerFrame: number
  private sprite: Sprite
  private readonly hasAudio: boolean
  private silence: Buffer
  private encoderRestarts = 0
  private peakQueued = 0
  private readonly startedAt = Date.now()

  private encoder?: ChildProcess
  private videoPipe?: Writable
  private audioPipe?: Writable
  private clock?: NodeJS.Timeout
  private restartTimer?: NodeJS.Timeout
  private stopped = false

  /** Reassembly buffer for partial frames arriving from the decoder. */
  private pending: Buffer = Buffer.alloc(0)
  private latestFrame?: Buffer
  private lastFrameAt = 0

  /** Decoded PCM from Ring, awaiting its turn on the clock. */
  private audioPending: Buffer = Buffer.alloc(0)
  /** Fractional carry, for frame rates that do not divide the sample rate. */
  private audioSamplesOwed = 0

  private fillerBase?: Buffer
  private fillerFrame?: Buffer
  private wasLive: boolean | undefined
  private droppedFrames = 0

  constructor(options: PublisherOptions) {
    this.options = options
    this.bytesPerFrame = frameSize(options.width, options.height)
    this.sprite = buildSpinner(options.width, options.height)
    this.hasAudio = options.audioRtpPort !== undefined
    this.silence = Buffer.alloc(
      Math.ceil(options.sampleRate / options.fps) * BYTES_PER_SAMPLE,
    )
  }

  start(): void {
    this.startEncoder()
    this.clock = setInterval(() => this.tick(), 1000 / this.options.fps)
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.clock)
    clearTimeout(this.restartTimer)
    this.encoder?.kill('SIGKILL')
    this.encoder = undefined
  }

  /**
   * Feed raw decoder output. Chunks do not align to frame boundaries, so they
   * are accumulated and split at exact frame size.
   */
  pushDecoderChunk(chunk: Buffer): void {
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])

    while (this.pending.length >= this.bytesPerFrame) {
      this.latestFrame = this.pending.subarray(0, this.bytesPerFrame)
      this.pending = this.pending.subarray(this.bytesPerFrame)
      this.lastFrameAt = Date.now()
    }

    // A frame's worth of slack is normal; more means the geometry is wrong and
    // the buffer would grow without bound.
    if (this.pending.length > this.bytesPerFrame * 4) {
      console.error(
        `${this.options.label} decoder output desynced, resetting buffer`,
      )
      this.pending = Buffer.alloc(0)
    }
  }

  /** Feed decoded PCM (s16le mono at `sampleRate`) from Ring. */
  pushAudioChunk(chunk: Buffer): void {
    if (!this.hasAudio) {
      return
    }

    this.audioPending =
      this.audioPending.length === 0
        ? chunk
        : Buffer.concat([this.audioPending, chunk])

    const maxBytes =
      ((this.options.sampleRate * MAX_AUDIO_BUFFER_MS) / 1000) * BYTES_PER_SAMPLE
    if (this.audioPending.length > maxBytes) {
      this.audioPending = this.audioPending.subarray(
        this.audioPending.length - maxBytes,
      )
    }
  }

  /** Called when a Ring session ends so the spinner appears without waiting. */
  markSourceDown(): void {
    this.lastFrameAt = 0
    this.pending = Buffer.alloc(0)
    // Drop stale audio so it cannot replay after a reconnect.
    this.audioPending = Buffer.alloc(0)
  }

  private buildEncoderArgs(): string[] {
    const {
      width, height, fps, rtpPort, audioRtpPort, sampleRate,
      encoder, crf, preset, bitrateKbps,
    } = this.options
    const isX26x = encoder === 'libx264' || encoder === 'libx265'
    // One keyframe per second bounds how long a joining client waits.
    const gop = Math.max(2, Math.round(fps))

    return [
      '-hide_banner',
      '-loglevel', 'error',
      // Timestamps come from the fixed input rates, keeping output monotonic
      // across source drops.
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-s', `${width}x${height}`,
      '-r', String(fps),
      '-i', 'pipe:0',
      ...(this.hasAudio
        ? ['-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:3']
        : []),

      '-map', '0:v',
      '-c:v', encoder,
      ...(isX26x ? ['-preset', preset, '-tune', 'zerolatency'] : []),
      ...(bitrateKbps !== undefined
        ? ['-b:v', `${bitrateKbps}k`, '-maxrate', `${bitrateKbps}k`,
           '-bufsize', `${bitrateKbps * 2}k`]
        : isX26x
          ? ['-crf', String(crf)]
          : []),
      '-pix_fmt', 'yuv420p',
      // Raw frames carry no colour metadata, so ffmpeg cannot infer any and
      // leaves the stream untagged. Players then guess -- often BT.601 or full
      // range -- which shows up as shifted contrast and washed-out colour.
      // Ring decodes to limited-range BT.709, so say so explicitly.
      '-color_range', 'tv',
      '-colorspace', 'bt709',
      '-color_trc', 'bt709',
      '-color_primaries', 'bt709',
      // The flags above reach the muxer but x264 only writes matrix and range
      // into the bitstream VUI; transfer and primaries need saying again here,
      // or they arrive at the client as "unknown".
      ...(encoder === 'libx264'
        ? ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv']
        : []),
      '-g', String(gop),
      '-keyint_min', String(gop),
      // pkt_size stays under the loopback MTU so RTP is never IP-fragmented.
      '-f', 'rtp',
      `rtp://127.0.0.1:${rtpPort}?pkt_size=1200`,

      ...(this.hasAudio
        ? [
            '-map', '1:a',
            '-c:a', 'aac',
            '-b:a', '32k',
            '-ar', String(sampleRate),
            '-ac', '1',
            '-f', 'rtp',
            `rtp://127.0.0.1:${audioRtpPort}?pkt_size=1200`,
          ]
        : []),
    ]
  }

  private startEncoder(): void {
    if (this.stopped) {
      return
    }

    const args = this.buildEncoderArgs()
    const child = spawn('ffmpeg', args, {
      // fd 3 carries audio; video uses stdin.
      stdio: this.hasAudio
        ? ['pipe', 'pipe', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe'],
    })

    this.encoder = child
    this.videoPipe = child.stdin ?? undefined
    this.audioPipe = this.hasAudio
      ? (child.stdio[3] as Writable | undefined)
      : undefined

    // Broken pipe on encoder exit; the exit handler owns the restart.
    this.videoPipe?.on('error', () => {})
    this.audioPipe?.on('error', () => {})

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        console.error(`${this.options.label} encoder: ${text}`)
      }
    })

    child.on('exit', (code) => {
      if (this.stopped || child !== this.encoder) {
        return
      }
      console.error(
        `${this.options.label} encoder exited (${code}), restarting in ${ENCODER_RESTART_MS / 1000}s`,
      )
      this.encoderRestarts++
      this.encoder = undefined
      this.restartTimer = setTimeout(
        () => this.startEncoder(),
        ENCODER_RESTART_MS,
      )
    })

    console.log(`${this.options.label} publishing to ${this.options.displayUrl}`)
  }

  private isLive(): boolean {
    return Date.now() - this.lastFrameAt < STALE_MS
  }

  get stats(): PublisherStats {
    const { fps, encoder, crf, preset, bitrateKbps, width, height } = this.options
    return {
      label: this.options.label,
      live: this.isLive(),
      lastFrameAt: this.lastFrameAt,
      droppedFrames: this.droppedFrames,
      encoderRestarts: this.encoderRestarts,
      startedAt: this.startedAt,
      settings: { fps, encoder, crf, preset, bitrateKbps, width, height },
      hasAudio: this.hasAudio,
      audioBufferedMs: Math.round(
        (this.audioPending.length / 2 / this.options.sampleRate) * 1000,
      ),
      peakQueuedFrames:
        Math.round((this.peakQueued / this.bytesPerFrame) * 10) / 10,
    }
  }

  /**
   * The frame currently being published -- live video, or the placeholder with
   * the spinner during an outage. Used for dashboard previews.
   */
  currentFrame(): { frame: Buffer; width: number; height: number } | undefined {
    const frame = this.isLive() ? this.latestFrame : this.fillerFrame
    if (!frame) {
      return undefined
    }
    return {
      frame: Buffer.from(frame),
      width: this.options.width,
      height: this.options.height,
    }
  }

  /**
   * Apply new encoder settings without dropping the RTSP session. The encoder
   * is restarted, which the server absorbs by rewriting RTP headers, so
   * connected clients keep their session across the change.
   */
  reconfigure(next: Partial<TunableOptions>): void {
    const merged = { ...this.options, ...next }
    const geometryChanged =
      merged.width !== this.options.width ||
      merged.height !== this.options.height
    const rateChanged = merged.fps !== this.options.fps

    this.options = merged

    if (geometryChanged) {
      this.bytesPerFrame = frameSize(merged.width, merged.height)
      this.sprite = buildSpinner(merged.width, merged.height)
      this.pending = Buffer.alloc(0)
      this.latestFrame = undefined
      this.lastFrameAt = 0
    }
    if (geometryChanged || rateChanged) {
      this.fillerBase = undefined
      this.fillerFrame = undefined
      this.silence = Buffer.alloc(
        Math.ceil(merged.sampleRate / merged.fps) * BYTES_PER_SAMPLE,
      )
      this.audioPending = Buffer.alloc(0)
      this.audioSamplesOwed = 0
    }
    if (rateChanged) {
      clearInterval(this.clock)
      this.clock = setInterval(() => this.tick(), 1000 / merged.fps)
    }

    // Restart the encoder so the new arguments take effect.
    const current = this.encoder
    this.encoder = undefined
    current?.kill('SIGKILL')
    clearTimeout(this.restartTimer)
    this.startEncoder()

    console.log(
      `${merged.label} reconfigured: ${merged.width}x${merged.height} @${merged.fps}fps ` +
        `${merged.encoder} ${merged.bitrateKbps ? `${merged.bitrateKbps}kbps` : `crf ${merged.crf}`}`,
    )
  }

  private nextFillerFrame(): Buffer {
    const { width, height } = this.options

    if (!this.fillerBase) {
      const source = this.latestFrame ?? createBlackFrame(width, height)
      this.fillerBase = buildFillerBase(source, this.sprite, width, height)
      this.fillerFrame = Buffer.from(this.fillerBase)
    }

    const frame = this.fillerFrame as Buffer
    const step = Math.floor(Date.now() / SPINNER_STEP_MS) % DOT_COUNT

    restoreBbox(frame, this.fillerBase, this.sprite, width, height)
    drawSpinner(frame, this.sprite, step, width, height)

    return frame
  }

  /**
   * Exactly one tick's worth of audio: Ring's samples where available, silence
   * for the remainder. Always returns the full amount so the sample-to-frame
   * ratio -- and therefore A/V sync -- never slips.
   */
  private nextAudioChunk(): Buffer {
    this.audioSamplesOwed += this.options.sampleRate / this.options.fps
    const samples = Math.floor(this.audioSamplesOwed)
    this.audioSamplesOwed -= samples

    const wanted = samples * BYTES_PER_SAMPLE

    if (this.audioPending.length >= wanted) {
      const chunk = this.audioPending.subarray(0, wanted)
      this.audioPending = this.audioPending.subarray(wanted)
      return chunk
    }

    if (this.audioPending.length === 0) {
      return this.silence.subarray(0, wanted)
    }

    // Partial: pad the tail with silence rather than stretching what we have.
    const chunk = Buffer.alloc(wanted)
    this.audioPending.copy(chunk)
    this.audioPending = Buffer.alloc(0)
    return chunk
  }

  private tick(): void {
    const videoPipe = this.videoPipe
    if (!videoPipe?.writable) {
      return
    }
    if (this.hasAudio && !this.audioPipe?.writable) {
      return
    }

    const live = this.isLive()

    if (live !== this.wasLive) {
      if (live) {
        console.log(`${this.options.label} Ring live, taking over output`)
        // Drop the cached placeholder so the next outage freezes a fresh frame.
        this.fillerBase = undefined
        this.fillerFrame = undefined
      } else {
        console.log(
          `${this.options.label} Ring unavailable, holding last frame with spinner`,
        )
      }
      this.wasLive = live
    }

    // Skip video and audio together when either pipe is behind, so the
    // sample-to-frame ratio holds and the streams stay aligned.
    if (this.backedUp()) {
      this.droppedFrames++
      // A frame or two while the pipe fills at startup is normal; only report
      // backpressure once it has cost a full second of video.
      const oneSecond = this.options.fps
      if (
        this.droppedFrames === oneSecond ||
        (this.droppedFrames > oneSecond &&
          this.droppedFrames % (oneSecond * 30) === 0)
      ) {
        console.error(
          `${this.options.label} encoder backpressure, dropped ${this.droppedFrames} frames`,
        )
      }
      // Still consume this tick's audio so the buffer cannot run away.
      if (this.hasAudio) {
        this.nextAudioChunk()
      }
      return
    }

    // The filler buffer is mutated in place every tick, and a Writable holds
    // queued chunks by reference rather than copying them -- so a frame still
    // waiting in the queue would be rewritten underneath the encoder. Live
    // frames are safe: they view decoder output that is never mutated in place.
    const frame = live
      ? (this.latestFrame as Buffer)
      : Buffer.from(this.nextFillerFrame())

    // Return value is ignored deliberately -- see MAX_QUEUE_MS.
    videoPipe.write(frame)
    if (this.hasAudio && this.audioPipe) {
      this.audioPipe.write(this.nextAudioChunk())
    }
  }

  /** True when the encoder is genuinely behind, not merely over highWaterMark. */
  private backedUp(): boolean {
    const budgetFrames = (MAX_QUEUE_MS / 1000) * this.options.fps
    const videoQueued = this.videoPipe?.writableLength ?? 0
    this.peakQueued = Math.max(this.peakQueued, videoQueued)

    if (videoQueued > this.bytesPerFrame * budgetFrames) {
      return true
    }
    if (this.hasAudio) {
      const audioQueued = this.audioPipe?.writableLength ?? 0
      if (audioQueued > this.silence.length * budgetFrames) {
        return true
      }
    }
    return false
  }
}
