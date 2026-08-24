/**
 * YUV420p frame compositing for the "waiting for Ring" placeholder.
 *
 * Frames are composited in yuv420p because that is what the decoder emits and
 * what the encoder wants -- converting to RGB and back would cost more than
 * the drawing itself. Layout is a full-size luma plane followed by
 * half-resolution U and V planes.
 */

const Y_BLACK = 16
const CHROMA_NEUTRAL = 128
const Y_WHITE = 235

/** How much to darken the frozen frame so the spinner reads clearly. */
const DIM_FACTOR = 0.55
/** How far to pull chroma toward neutral, draining color from a stale frame. */
const DESATURATE = 0.5

const DOT_COUNT = 12
/** How far the scrim darkens the frame at its centre. */
const SCRIM_STRENGTH = 0.6

export interface Sprite {
  /** Bounding box of everything the spinner touches, in luma pixels. */
  readonly bbox: { x: number; y: number; w: number; h: number }
  /**
   * Static dark disc behind the dots. Baked into the frozen base once, so the
   * spinner stays legible over a bright frame without any per-frame cost.
   */
  readonly scrim: ReadonlyArray<readonly [number, number]>
  /** Per dot: byte offsets into each plane, with anti-aliased coverage. */
  readonly dots: ReadonlyArray<{
    luma: ReadonlyArray<readonly [number, number]>
    chroma: ReadonlyArray<readonly [number, number]>
  }>
}

export function frameSize(width: number, height: number): number {
  return width * height + 2 * ((width / 2) * (height / 2))
}

export function createBlackFrame(width: number, height: number): Buffer {
  const frame = Buffer.alloc(frameSize(width, height))
  frame.fill(Y_BLACK, 0, width * height)
  frame.fill(CHROMA_NEUTRAL, width * height)
  return frame
}

/** Coverage of a pixel by a circle, sampled 2x2 for cheap anti-aliasing. */
function coverage(px: number, py: number, cx: number, cy: number, r: number): number {
  let hits = 0
  for (const ox of [0.25, 0.75]) {
    for (const oy of [0.25, 0.75]) {
      const dx = px + ox - cx
      const dy = py + oy - cy
      if (dx * dx + dy * dy <= r * r) {
        hits++
      }
    }
  }
  return hits / 4
}

/**
 * Precompute the spinner once. Every animation step reuses these pixel lists
 * and only varies per-dot brightness, so drawing a frame is a few thousand
 * blends inside a small bounding box rather than a full-frame repaint.
 */
export function buildSpinner(width: number, height: number): Sprite {
  const centerX = Math.round(width / 2)
  const centerY = Math.round(height / 2)
  const orbit = Math.max(12, Math.round(Math.min(width, height) * 0.06))
  const dotRadius = Math.max(2, orbit * 0.22)

  const lumaPlane = width * height
  const chromaWidth = width / 2
  const uPlaneStart = lumaPlane
  const dots: Array<{
    luma: Array<readonly [number, number]>
    chroma: Array<readonly [number, number]>
  }> = []

  for (let i = 0; i < DOT_COUNT; i++) {
    const angle = (i / DOT_COUNT) * Math.PI * 2 - Math.PI / 2
    const dotX = centerX + Math.cos(angle) * orbit
    const dotY = centerY + Math.sin(angle) * orbit

    const luma: Array<readonly [number, number]> = []
    const chroma: Array<readonly [number, number]> = []

    const minX = Math.max(0, Math.floor(dotX - dotRadius) - 1)
    const maxX = Math.min(width - 1, Math.ceil(dotX + dotRadius) + 1)
    const minY = Math.max(0, Math.floor(dotY - dotRadius) - 1)
    const maxY = Math.min(height - 1, Math.ceil(dotY + dotRadius) + 1)

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cov = coverage(x, y, dotX, dotY, dotRadius)
        if (cov > 0) {
          luma.push([y * width + x, cov])
        }
      }
    }

    // Chroma is half resolution, so each subsampled pixel is visited once.
    const seen = new Set<number>()
    for (let y = minY >> 1; y <= maxY >> 1; y++) {
      for (let x = minX >> 1; x <= maxX >> 1; x++) {
        const cov = coverage(x * 2, y * 2, dotX, dotY, dotRadius * 2)
        const offset = y * chromaWidth + x
        if (cov > 0 && !seen.has(offset)) {
          seen.add(offset)
          chroma.push([offset, cov])
        }
      }
    }

    dots.push({ luma, chroma })
  }

  const pad = Math.ceil(dotRadius) + 2
  const bboxX = Math.max(0, centerX - orbit - pad)
  const bboxY = Math.max(0, centerY - orbit - pad)

  // Soft-edged disc a little larger than the ring of dots.
  const scrim: Array<readonly [number, number]> = []
  const scrimRadius = orbit + dotRadius * 2.2
  const feather = dotRadius * 1.8
  const scrimMinX = Math.max(0, Math.floor(centerX - scrimRadius))
  const scrimMaxX = Math.min(width - 1, Math.ceil(centerX + scrimRadius))
  const scrimMinY = Math.max(0, Math.floor(centerY - scrimRadius))
  const scrimMaxY = Math.min(height - 1, Math.ceil(centerY + scrimRadius))

  for (let y = scrimMinY; y <= scrimMaxY; y++) {
    for (let x = scrimMinX; x <= scrimMaxX; x++) {
      const distance = Math.hypot(x - centerX, y - centerY)
      if (distance > scrimRadius) {
        continue
      }
      const strength =
        distance > scrimRadius - feather
          ? (scrimRadius - distance) / feather
          : 1
      if (strength > 0.01) {
        scrim.push([y * width + x, strength])
      }
    }
  }

  return {
    scrim,
    bbox: {
      // Keep the box on even coordinates so chroma rows map cleanly.
      x: bboxX & ~1,
      y: bboxY & ~1,
      w: Math.min(width - (bboxX & ~1), (orbit + pad) * 2 + 2) & ~1,
      h: Math.min(height - (bboxY & ~1), (orbit + pad) * 2 + 2) & ~1,
    },
    dots,
  }
}

export const uPlaneOffset = (width: number, height: number): number => width * height

/**
 * Darken and desaturate a frozen frame so it reads as "not live" at a glance.
 */
export function buildFillerBase(
  source: Buffer,
  sprite: Sprite,
  width: number,
  height: number,
): Buffer {
  const out = Buffer.from(source)
  const lumaPlane = width * height

  for (let i = 0; i < lumaPlane; i++) {
    out[i] = Y_BLACK + ((out[i] as number) - Y_BLACK) * DIM_FACTOR
  }
  for (let i = lumaPlane; i < out.length; i++) {
    const value = out[i] as number
    out[i] = value + (CHROMA_NEUTRAL - value) * DESATURATE
  }

  // Bake the scrim in so every animation frame starts from it.
  for (const [offset, strength] of sprite.scrim) {
    const current = out[offset] as number
    out[offset] = Y_BLACK + (current - Y_BLACK) * (1 - SCRIM_STRENGTH * strength)
  }

  return out
}

/**
 * Brightness of each dot for a given animation step, producing a comet trail
 * that rotates once per DOT_COUNT steps.
 */
function dotAlpha(dotIndex: number, step: number): number {
  const distance = (dotIndex - step + DOT_COUNT) % DOT_COUNT
  // Apply the curve first, then floor it, so the whole ring stays faintly
  // visible instead of the trail vanishing into the background.
  return Math.max(0.18, (1 - distance / (DOT_COUNT - 1)) ** 1.6)
}

/** Restore the spinner's bounding box from `base`, undoing the previous step. */
export function restoreBbox(
  frame: Buffer,
  base: Buffer,
  sprite: Sprite,
  width: number,
  height: number,
): void {
  const { x, y, w, h } = sprite.bbox
  for (let row = y; row < y + h; row++) {
    const start = row * width + x
    base.copy(frame, start, start, start + w)
  }

  const chromaWidth = width / 2
  const planeSize = chromaWidth * (height / 2)
  const uStart = width * height
  for (let plane = 0; plane < 2; plane++) {
    const planeOffset = uStart + plane * planeSize
    for (let row = y >> 1; row < (y + h) >> 1; row++) {
      const start = planeOffset + row * chromaWidth + (x >> 1)
      base.copy(frame, start, start, start + (w >> 1))
    }
  }
}

/** Blend the spinner for `step` into `frame` (which must already be restored). */
export function drawSpinner(
  frame: Buffer,
  sprite: Sprite,
  step: number,
  width: number,
  height: number,
): void {
  const uStart = width * height
  const planeSize = (width / 2) * (height / 2)

  for (let i = 0; i < sprite.dots.length; i++) {
    const dot = sprite.dots[i]
    if (!dot) continue
    const brightness = dotAlpha(i, step)

    for (const [offset, cov] of dot.luma) {
      const alpha = cov * brightness
      const current = frame[offset] as number
      frame[offset] = current + (Y_WHITE - current) * alpha
    }

    // White is chroma-neutral, so blending toward 128 removes any color cast.
    for (const [offset, cov] of dot.chroma) {
      const alpha = cov * brightness
      for (let plane = 0; plane < 2; plane++) {
        const index = uStart + plane * planeSize + offset
        const current = frame[index] as number
        frame[index] = current + (CHROMA_NEUTRAL - current) * alpha
      }
    }
  }
}

export { DOT_COUNT }
