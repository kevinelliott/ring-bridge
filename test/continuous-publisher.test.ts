import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContinuousPublisher } from '../continuous-publisher.ts'
import { frameSize } from '../spinner.ts'

const SAMPLE_RATE = 16000
const W = 320, H = 240

function makePublisher(fps: number): ContinuousPublisher {
  return new ContinuousPublisher({
    label: '[test]',
    sourceWidth: W,
    sourceHeight: H,
    sourceFps: fps,
    sampleRate: SAMPLE_RATE,
    displayUrl: 'rtsp://test/x',
    outputs: [{
      name: 'main', rtpPort: 1, width: W, height: H, fps,
      encoder: 'libx264', crf: 21, preset: 'veryfast',
    }],
  })
}

/** Reach the private audio pacing, which is the A/V sync invariant. */
function drainAudio(p: ContinuousPublisher): Buffer {
  return (p as unknown as { nextAudioChunk(): Buffer }).nextAudioChunk()
}

test('audio pacing delivers exactly one frame of samples per tick', () => {
  // 16000/20 = 800 samples = 1600 bytes, with no remainder.
  const p = makePublisher(20)
  for (let i = 0; i < 10; i++) {
    assert.equal(drainAudio(p).length, 1600)
  }
})

test('a frame rate that does not divide the sample rate still averages exactly', () => {
  // 16000/15 = 1066.67 samples: individual ticks must vary, but a second of
  // ticks must total exactly a second of audio or A/V drifts forever.
  const fps = 15
  const p = makePublisher(fps)
  let total = 0
  const sizes = new Set<number>()
  for (let i = 0; i < fps; i++) {
    const bytes = drainAudio(p).length
    total += bytes
    sizes.add(bytes)
  }
  assert.ok(sizes.size > 1, 'sizes vary tick to tick, carrying the remainder')
  assert.equal(total / 2, SAMPLE_RATE, 'one second of ticks is one second of audio')
})

test('the ratio holds over a long run at an awkward rate', () => {
  const fps = 7
  const p = makePublisher(fps)
  let total = 0
  for (let i = 0; i < fps * 60; i++) {
    total += drainAudio(p).length
  }
  // Sixty seconds of ticks, sixty seconds of samples, exactly.
  assert.equal(total / 2, SAMPLE_RATE * 60)
})

test('silence is emitted when Ring supplies no audio', () => {
  const p = makePublisher(20)
  const chunk = drainAudio(p)
  assert.ok(chunk.every((b) => b === 0), 'digital silence, not noise')
})

test('Ring audio is consumed in order, then padded with silence', () => {
  const p = makePublisher(20)
  // Two ticks' worth of a recognisable pattern.
  const supplied = Buffer.alloc(2400, 0x7f)
  p.pushAudioChunk(supplied)

  const first = drainAudio(p)
  assert.equal(first.length, 1600)
  assert.ok(first.every((b) => b === 0x7f), 'first tick is all real audio')

  const second = drainAudio(p)
  assert.equal(second.length, 1600, 'still a full tick, so the ratio holds')
  assert.equal(second[0], 0x7f, 'starts with the remaining real audio')
  assert.equal(second[1599], 0, 'tail padded with silence rather than stretched')
})

test('the audio buffer is capped so drift cannot become latency', () => {
  const p = makePublisher(20)
  // Ten seconds of audio arriving at once, far past the 400ms cap.
  p.pushAudioChunk(Buffer.alloc(SAMPLE_RATE * 2 * 10, 0x11))
  const stats = p.stats
  assert.ok(
    stats.audioBufferedMs <= 400,
    `buffered ${stats.audioBufferedMs}ms should be capped at 400ms`,
  )
})

test('decoder chunks are reassembled into whole frames', () => {
  const p = makePublisher(20)
  const bytes = frameSize(W, H)
  assert.equal(p.stats.live, false)

  // Split one frame across three writes, as a pipe would.
  const frame = Buffer.alloc(bytes, 0x40)
  p.pushDecoderChunk(frame.subarray(0, 1000))
  assert.equal(p.stats.live, false, 'a partial frame is not a frame')
  p.pushDecoderChunk(frame.subarray(1000, 5000))
  p.pushDecoderChunk(frame.subarray(5000))
  assert.equal(p.stats.live, true, 'completing the frame marks the source live')

  const current = p.currentFrame()
  assert.equal(current?.frame.length, bytes)
  assert.equal(current?.width, W)
})

test('markSourceDown clears buffers so stale audio cannot replay', () => {
  const p = makePublisher(20)
  p.pushDecoderChunk(Buffer.alloc(frameSize(W, H), 0x40))
  p.pushAudioChunk(Buffer.alloc(1600, 0x7f))
  assert.equal(p.stats.live, true)

  p.markSourceDown()
  assert.equal(p.stats.live, false)
  assert.equal(p.stats.audioBufferedMs, 0)
  assert.ok(drainAudio(p).every((b) => b === 0), 'silence, not the old audio')
})

test('reassembly memory is fixed regardless of how much arrives', () => {
  const p = makePublisher(20)
  const bytes = frameSize(W, H)
  const internals = p as unknown as { assembling: Buffer; ring: Buffer[] }
  const before = internals.assembling.length + internals.ring.length * bytes

  // Far more than a frame, at an offset that never aligns -- the old
  // concat-based reassembly would have grown a buffer here.
  for (let i = 0; i < 20; i++) {
    p.pushDecoderChunk(Buffer.alloc(bytes * 2 + 7, 0x22))
  }

  const after = internals.assembling.length + internals.ring.length * bytes
  assert.equal(after, before, 'footprint is constant')
  assert.equal(internals.assembling.length, bytes, 'never grows past one frame')
})

test('a published frame is not overwritten by the next one', () => {
  const p = makePublisher(20)
  const bytes = frameSize(W, H)

  p.pushDecoderChunk(Buffer.alloc(bytes, 0xaa))
  const first = p.currentFrame()
  assert.equal(first?.frame[0], 0xaa)

  // Reusing buffers is only safe if the frame just handed out survives the
  // next one being assembled.
  p.pushDecoderChunk(Buffer.alloc(bytes, 0xbb))
  assert.equal(first?.frame[0], 0xaa, 'the earlier copy is intact')
  assert.equal(p.currentFrame()?.frame[0], 0xbb, 'and the new frame is current')
})

test('substream outputs get their own frame rate from one source', () => {
  const p = new ContinuousPublisher({
    label: '[test]', sourceWidth: W, sourceHeight: H, sourceFps: 20,
    sampleRate: SAMPLE_RATE, displayUrl: 'rtsp://test/x',
    outputs: [
      { name: 'main', rtpPort: 1, width: W, height: H, fps: 20,
        encoder: 'libx264', crf: 21, preset: 'veryfast' },
      { name: 'sub', rtpPort: 2, width: 160, height: 120, fps: 5,
        encoder: 'libx264', crf: 28, preset: 'veryfast' },
    ],
  })
  const outputs = (p as unknown as {
    outputs: Array<{ tickDivisor: number; settings: { name: string } }>
  }).outputs
  assert.equal(outputs[0]?.tickDivisor, 1, 'main takes every frame')
  assert.equal(outputs[1]?.tickDivisor, 4, '20fps / 5fps = every 4th frame')
  assert.equal(p.stats.outputs.length, 2)
})
