/**
 * A persistent RTSP publisher that never drops.
 *
 * One long-lived encoder per output owns its RTSP session, fed by a fixed-rate
 * frame clock rather than by Ring directly. When live frames are arriving the
 * clock forwards the newest one; when they stop it forwards the last known
 * frame, dimmed, with an animated spinner composited on top. Clients see one
 * uninterrupted stream either way.
 *
 * Audio rides the same clock. Every tick writes one video frame and exactly
 * `sampleRate / fps` audio samples -- Ring's audio when it is arriving, silence
 * when it is not. Because ffmpeg derives timestamps for both raw inputs from
 * their declared rates, holding that ratio keeps A/V in sync by construction
 * rather than by timer accuracy.
 *
 * A substream is a second encoder fed from the same decoded frames, scaled and
 * rate-divided by ffmpeg. It costs an encode but not a second decode.
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

/** One encoder output: main stream, or a scaled-down substream. */
export interface OutputSettings {
  readonly name: string
  readonly rtpPort: number
  readonly audioRtpPort?: number
  width: number
  height: number
  fps: number
  encoder: string
  crf: number
  preset: string
  bitrateKbps?: number
}

export interface PublisherOptions {
  label: string
  /** Geometry of the raw frames the decoder produces; drives the clock. */
  sourceWidth: number
  sourceHeight: number
  sourceFps: number
  sampleRate: number
  outputs: OutputSettings[]
  displayUrl: string
}

export interface OutputStats {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly measuredFps: number
  readonly encoder: string
  readonly crf: number
  readonly bitrateKbps?: number
  readonly hasAudio: boolean
  readonly restarts: number
}

export interface PublisherStats {
  readonly label: string
  readonly live: boolean
  readonly lastFrameAt: number
  readonly droppedFrames: number
  readonly encoderRestarts: number
  readonly startedAt: number
  readonly peakQueuedFrames: number
  readonly audioBufferedMs: number
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly sourceFps: number
  readonly outputs: OutputStats[]
}

/** No live frame for this long => Ring is considered down, show the spinner. */
const STALE_MS = 2_000
/** Spinner rotation speed, independent of output fps. */
const SPINNER_STEP_MS = 1000 / 12
const ENCODER_RESTART_MS = 2_000
const BYTES_PER_SAMPLE = 2
const MAX_AUDIO_BUFFER_MS = 400

/**
 * How much video may sit queued for an encoder before the clock skips a frame.
 *
 * Measured against the pipe's queue depth, not write()'s return value: a raw
 * 1080p frame is ~3.1MB against a 64KB highWaterMark, so write() reports
 * backpressure on every single frame and using it would make each tick a race
 * against the drain event.
 *
 * Skipping is a last resort. A skipped frame shortens the output timeline
 * permanently -- the encoder stamps frames from its fixed input rate, so N
 * missing frames leave playback N/fps further behind real time forever.
 * Absorbing a stall in the queue instead costs only transient latency, which
 * drains away because the encoder runs several times faster than real time.
 * Measured stalls reach ~750ms around a Ring reconnect.
 */
const MAX_QUEUE_MS = 1500
/** Window for the measured-fps figure shown on the dashboard. */
const RATE_WINDOW_MS = 5_000

interface Output {
  settings: OutputSettings
  process?: ChildProcess
  videoPipe?: Writable
  audioPipe?: Writable
  restartTimer?: NodeJS.Timeout
  restarts: number
  /** Write to this output every Nth tick, giving it its own frame rate. */
  tickDivisor: number
  tickCounter: number
  framesWritten: number
  rateMark: { at: number; frames: number }
  measuredFps: number
}

export class ContinuousPublisher {
  private options: PublisherOptions
  private bytesPerFrame: number
  private sprite: Sprite
  private silence: Buffer
  private readonly outputs: Output[] = []
  private clock?: NodeJS.Timeout
  private stopped = false

  private pending: Buffer = Buffer.alloc(0)
  private latestFrame?: Buffer
  private lastFrameAt = 0

  private audioPending: Buffer = Buffer.alloc(0)
  private audioSamplesOwed = 0

  private fillerBase?: Buffer
  private fillerFrame?: Buffer
  private wasLive: boolean | undefined
  private droppedFrames = 0
  private peakQueued = 0
  private readonly startedAt = Date.now()

  /** Frame subscribers, used by the dashboard's MJPEG preview. */
  private readonly frameListeners = new Set<(frame: Buffer) => void>()

  constructor(options: PublisherOptions) {
    this.options = options
    this.bytesPerFrame = frameSize(options.sourceWidth, options.sourceHeight)
    this.sprite = buildSpinner(options.sourceWidth, options.sourceHeight)
    this.silence = Buffer.alloc(
      Math.ceil(options.sampleRate / options.sourceFps) * BYTES_PER_SAMPLE,
    )
    for (const settings of options.outputs) {
      this.outputs.push(this.makeOutput(settings))
    }
  }

  private makeOutput(settings: OutputSettings): Output {
    return {
      settings,
      restarts: 0,
      tickDivisor: Math.max(1, Math.round(this.options.sourceFps / settings.fps)),
      tickCounter: 0,
      framesWritten: 0,
      rateMark: { at: Date.now(), frames: 0 },
      measuredFps: 0,
    }
  }

  start(): void {
    for (const output of this.outputs) {
      this.startEncoder(output)
    }
    this.clock = setInterval(() => this.tick(), 1000 / this.options.sourceFps)
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.clock)
    for (const output of this.outputs) {
      clearTimeout(output.restartTimer)
      output.process?.kill('SIGKILL')
      output.process = undefined
    }
    this.frameListeners.clear()
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

    if (this.pending.length > this.bytesPerFrame * 4) {
      console.error(
        `${this.options.label} decoder output desynced, resetting buffer`,
      )
      this.pending = Buffer.alloc(0)
    }
  }

  /** Feed decoded PCM (s16le mono at `sampleRate`) from Ring. */
  pushAudioChunk(chunk: Buffer): void {
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
    this.audioPending = Buffer.alloc(0)
  }

  onFrame(listener: (frame: Buffer) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  get hasFrameListeners(): boolean {
    return this.frameListeners.size > 0
  }

  private buildEncoderArgs(output: Output): string[] {
    const { sourceWidth, sourceHeight, sourceFps, sampleRate } = this.options
    const s = output.settings
    const isX26x = s.encoder === 'libx264' || s.encoder === 'libx265'
    const gop = Math.max(2, Math.round(s.fps))
    const hasAudio = s.audioRtpPort !== undefined
    const scaling = s.width !== sourceWidth || s.height !== sourceHeight

    return [
      '-hide_banner',
      '-loglevel', 'error',
      // Declared at this output's own rate; the clock feeds it every Nth frame.
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-s', `${sourceWidth}x${sourceHeight}`,
      '-r', String(sourceFps / output.tickDivisor),
      '-i', 'pipe:0',
      ...(hasAudio
        ? ['-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:3']
        : []),

      '-map', '0:v',
      ...(scaling ? ['-vf', `scale=${s.width}:${s.height}`] : []),
      '-c:v', s.encoder,
      ...(isX26x ? ['-preset', s.preset, '-tune', 'zerolatency'] : []),
      ...(s.bitrateKbps !== undefined
        ? ['-b:v', `${s.bitrateKbps}k`, '-maxrate', `${s.bitrateKbps}k`,
           '-bufsize', `${s.bitrateKbps * 2}k`]
        : isX26x
          ? ['-crf', String(s.crf)]
          : []),
      '-pix_fmt', 'yuv420p',
      // Raw frames carry no colour metadata, so ffmpeg cannot infer any and
      // leaves the stream untagged. Players then guess -- often BT.601 or full
      // range -- which shows up as shifted contrast and washed-out colour.
      '-color_range', 'tv',
      '-colorspace', 'bt709',
      '-color_trc', 'bt709',
      '-color_primaries', 'bt709',
      // The flags above reach the muxer but x264 only writes matrix and range
      // into the bitstream VUI; transfer and primaries need saying again here.
      ...(s.encoder === 'libx264'
        ? ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv']
        : []),
      '-g', String(gop),
      '-keyint_min', String(gop),
      ...(hasAudio ? [] : ['-an']),
      // pkt_size stays under the loopback MTU so RTP is never IP-fragmented.
      '-f', 'rtp',
      `rtp://127.0.0.1:${s.rtpPort}?pkt_size=1200`,

      ...(hasAudio
        ? [
            '-map', '1:a',
            '-c:a', 'aac',
            '-b:a', '32k',
            '-ar', String(sampleRate),
            '-ac', '1',
            '-f', 'rtp',
            `rtp://127.0.0.1:${s.audioRtpPort}?pkt_size=1200`,
          ]
        : []),
    ]
  }

  private startEncoder(output: Output): void {
    if (this.stopped) {
      return
    }

    const hasAudio = output.settings.audioRtpPort !== undefined
    const child = spawn('ffmpeg', this.buildEncoderArgs(output), {
      stdio: hasAudio
        ? ['pipe', 'pipe', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe'],
    })

    output.process = child
    output.videoPipe = child.stdin ?? undefined
    output.audioPipe = hasAudio
      ? (child.stdio[3] as Writable | undefined)
      : undefined

    // Broken pipe on encoder exit; the exit handler owns the restart.
    output.videoPipe?.on('error', () => {})
    output.audioPipe?.on('error', () => {})

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        console.error(`${this.options.label}/${output.settings.name} encoder: ${text}`)
      }
    })

    child.on('exit', (code) => {
      if (this.stopped || child !== output.process) {
        return
      }
      console.error(
        `${this.options.label}/${output.settings.name} encoder exited (${code}), ` +
          `restarting in ${ENCODER_RESTART_MS / 1000}s`,
      )
      output.restarts++
      output.process = undefined
      output.restartTimer = setTimeout(() => this.startEncoder(output), ENCODER_RESTART_MS)
    })
  }

  private isLive(): boolean {
    return Date.now() - this.lastFrameAt < STALE_MS
  }

  get stats(): PublisherStats {
    const { sourceWidth, sourceHeight, sourceFps } = this.options
    return {
      label: this.options.label,
      live: this.isLive(),
      lastFrameAt: this.lastFrameAt,
      droppedFrames: this.droppedFrames,
      encoderRestarts: this.outputs.reduce((sum, o) => sum + o.restarts, 0),
      startedAt: this.startedAt,
      peakQueuedFrames:
        Math.round((this.peakQueued / this.bytesPerFrame) * 10) / 10,
      audioBufferedMs: Math.round(
        (this.audioPending.length / 2 / this.options.sampleRate) * 1000,
      ),
      sourceWidth,
      sourceHeight,
      sourceFps,
      outputs: this.outputs.map((o) => ({
        name: o.settings.name,
        width: o.settings.width,
        height: o.settings.height,
        fps: o.settings.fps,
        measuredFps: o.measuredFps,
        encoder: o.settings.encoder,
        crf: o.settings.crf,
        bitrateKbps: o.settings.bitrateKbps,
        hasAudio: o.settings.audioRtpPort !== undefined,
        restarts: o.restarts,
      })),
    }
  }

  /** The frame currently being published, for dashboard previews. */
  currentFrame(): { frame: Buffer; width: number; height: number } | undefined {
    const frame = this.isLive() ? this.latestFrame : this.fillerFrame
    if (!frame) {
      return undefined
    }
    return {
      frame: Buffer.from(frame),
      width: this.options.sourceWidth,
      height: this.options.sourceHeight,
    }
  }

  /**
   * Apply new encoder settings without dropping the RTSP session. Encoders are
   * restarted, which the server absorbs by rewriting RTP headers, so connected
   * clients keep their session across the change.
   */
  reconfigure(next: Partial<OutputSettings> & { sourceFps?: number }): void {
    const geometryChanged =
      next.width !== undefined &&
      next.height !== undefined &&
      (next.width !== this.options.sourceWidth ||
        next.height !== this.options.sourceHeight)

    if (next.sourceFps !== undefined && next.sourceFps !== this.options.sourceFps) {
      this.options.sourceFps = next.sourceFps
      clearInterval(this.clock)
      this.clock = setInterval(() => this.tick(), 1000 / next.sourceFps)
      this.silence = Buffer.alloc(
        Math.ceil(this.options.sampleRate / next.sourceFps) * BYTES_PER_SAMPLE,
      )
      this.audioPending = Buffer.alloc(0)
      this.audioSamplesOwed = 0
    }

    if (geometryChanged) {
      this.options.sourceWidth = next.width as number
      this.options.sourceHeight = next.height as number
      this.bytesPerFrame = frameSize(this.options.sourceWidth, this.options.sourceHeight)
      this.sprite = buildSpinner(this.options.sourceWidth, this.options.sourceHeight)
      this.pending = Buffer.alloc(0)
      this.latestFrame = undefined
      this.lastFrameAt = 0
    }

    this.fillerBase = undefined
    this.fillerFrame = undefined

    // Apply to the main output only; the substream keeps its own geometry.
    const main = this.outputs[0]
    if (main) {
      if (next.encoder !== undefined) main.settings.encoder = next.encoder
      if (next.crf !== undefined) main.settings.crf = next.crf
      if (next.preset !== undefined) main.settings.preset = next.preset
      if ('bitrateKbps' in next) main.settings.bitrateKbps = next.bitrateKbps
      if (geometryChanged) {
        main.settings.width = this.options.sourceWidth
        main.settings.height = this.options.sourceHeight
      }
      if (next.sourceFps !== undefined) {
        main.settings.fps = next.sourceFps
      }
    }

    for (const output of this.outputs) {
      output.tickDivisor = Math.max(
        1,
        Math.round(this.options.sourceFps / output.settings.fps),
      )
      const current = output.process
      output.process = undefined
      current?.kill('SIGKILL')
      clearTimeout(output.restartTimer)
      this.startEncoder(output)
    }

    console.log(
      `${this.options.label} reconfigured: ${this.options.sourceWidth}x` +
        `${this.options.sourceHeight} @${this.options.sourceFps}fps`,
    )
  }

  private nextFillerFrame(): Buffer {
    const { sourceWidth: width, sourceHeight: height } = this.options

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
    this.audioSamplesOwed += this.options.sampleRate / this.options.sourceFps
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
    const chunk = Buffer.alloc(wanted)
    this.audioPending.copy(chunk)
    this.audioPending = Buffer.alloc(0)
    return chunk
  }

  /** True when any encoder is genuinely behind, not merely over highWaterMark. */
  private backedUp(): boolean {
    const budgetFrames = (MAX_QUEUE_MS / 1000) * this.options.sourceFps
    for (const output of this.outputs) {
      const queued = output.videoPipe?.writableLength ?? 0
      this.peakQueued = Math.max(this.peakQueued, queued)
      if (queued > this.bytesPerFrame * budgetFrames) {
        return true
      }
      const audioQueued = output.audioPipe?.writableLength ?? 0
      if (audioQueued > this.silence.length * budgetFrames) {
        return true
      }
    }
    return false
  }

  private tick(): void {
    const main = this.outputs[0]
    if (!main?.videoPipe?.writable) {
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

    if (this.backedUp()) {
      this.droppedFrames++
      const oneSecond = this.options.sourceFps
      if (
        this.droppedFrames === oneSecond ||
        (this.droppedFrames > oneSecond &&
          this.droppedFrames % (oneSecond * 30) === 0)
      ) {
        console.error(
          `${this.options.label} encoder backpressure, dropped ${this.droppedFrames} frames`,
        )
      }
      this.nextAudioChunk()
      return
    }

    // The filler buffer is mutated in place every tick, and a Writable holds
    // queued chunks by reference rather than copying them -- so a frame still
    // waiting in the queue would be rewritten underneath the encoder. Live
    // frames are safe: they view decoder output that is never mutated in place.
    const frame = live
      ? (this.latestFrame as Buffer)
      : Buffer.from(this.nextFillerFrame())

    const audio = this.nextAudioChunk()
    const now = Date.now()

    for (const output of this.outputs) {
      if (output.tickCounter++ % output.tickDivisor !== 0) {
        continue
      }
      if (!output.videoPipe?.writable) {
        continue
      }
      // Return value is ignored deliberately -- see MAX_QUEUE_MS.
      output.videoPipe.write(frame)
      output.audioPipe?.write(audio)

      output.framesWritten++
      const elapsed = now - output.rateMark.at
      if (elapsed >= RATE_WINDOW_MS) {
        output.measuredFps =
          Math.round(((output.framesWritten - output.rateMark.frames) / elapsed) * 1000 * 10) / 10
        output.rateMark = { at: now, frames: output.framesWritten }
      }
    }

    if (this.frameListeners.size > 0) {
      for (const listener of this.frameListeners) {
        listener(frame)
      }
    }
  }
}
