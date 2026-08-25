import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpinner, buildFillerBase, createBlackFrame, drawSpinner,
  restoreBbox, frameSize,
} from '../spinner.ts'

const W = 640, H = 360

test('frameSize matches the yuv420p layout', () => {
  // Full-resolution luma plus two half-resolution chroma planes.
  assert.equal(frameSize(W, H), W * H + 2 * ((W / 2) * (H / 2)))
})

test('a black frame is legal limited-range black', () => {
  const frame = createBlackFrame(W, H)
  assert.equal(frame.length, frameSize(W, H))
  assert.equal(frame[0], 16, 'luma is 16, not 0')
  assert.equal(frame[W * H], 128, 'chroma is neutral')
})

test('the spinner stays inside its bounding box', () => {
  const sprite = buildSpinner(W, H)
  const { x, y, w, h } = sprite.bbox
  assert.ok(x >= 0 && y >= 0 && x + w <= W && y + h <= H)
  assert.equal(x % 2, 0, 'even x so chroma maps cleanly')
  assert.equal(y % 2, 0)
  assert.equal(sprite.dots.length, 12)
})

test('drawing then restoring returns the frame to its base', () => {
  const sprite = buildSpinner(W, H)
  const source = createBlackFrame(W, H)
  for (let i = 0; i < W * H; i++) source[i] = 120
  const base = buildFillerBase(source, sprite, W, H)
  const frame = Buffer.from(base)

  drawSpinner(frame, sprite, 3, W, H)
  assert.notDeepEqual(frame, base, 'drawing changed pixels')

  restoreBbox(frame, base, sprite, W, H)
  assert.deepEqual(frame, base, 'restore is exact, so frames cannot smear')
})

test('the filler base dims and desaturates the frozen frame', () => {
  const sprite = buildSpinner(W, H)
  const source = createBlackFrame(W, H)
  source.fill(200, 0, W * H)
  source.fill(200, W * H)
  const base = buildFillerBase(source, sprite, W, H)

  assert.ok(base[0]! < 200, 'luma darkened')
  const chromaStart = W * H
  assert.ok(base[chromaStart]! < 200, 'chroma pulled toward neutral 128')
  assert.ok(base[chromaStart]! > 128)
})
