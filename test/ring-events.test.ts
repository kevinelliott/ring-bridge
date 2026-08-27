import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RingEventCollector, type RingEventRecord } from '../ring-events.ts'

/** Reach the private add(), which both push and history paths funnel through. */
function add(c: RingEventCollector, e: Partial<RingEventRecord>): void {
  ;(c as unknown as { add(e: RingEventRecord): void }).add({
    id: 'x', cameraName: 'Cam', cameraId: 1, kind: 'motion',
    at: Date.now(), source: 'history', ...e,
  } as RingEventRecord)
}
function setBackfilled(c: RingEventCollector, v: boolean): void {
  ;(c as unknown as { backfilled: boolean }).backfilled = v
}

test('backfill does not announce old events', () => {
  const c = new RingEventCollector([])
  const seen: RingEventRecord[] = []
  c.subscribe((e) => seen.push(e))
  // Initial history load, before backfilled flips.
  add(c, { id: 'a' })
  add(c, { id: 'b' })
  assert.equal(seen.length, 0, 'startup must not replay history to MQTT')
})

test('history events found by polling are announced', () => {
  const c = new RingEventCollector([])
  const seen: RingEventRecord[] = []
  c.subscribe((e) => seen.push(e))
  setBackfilled(c, true)
  add(c, { id: 'new-one', kind: 'ding' })
  assert.equal(seen.length, 1, 'polled events must reach MQTT and webhooks')
  assert.equal(seen[0]?.kind, 'ding')
})

test('a repeated event is announced only once', () => {
  const c = new RingEventCollector([])
  const seen: RingEventRecord[] = []
  c.subscribe((e) => seen.push(e))
  setBackfilled(c, true)
  add(c, { id: 'same' })
  add(c, { id: 'same' })
  add(c, { id: 'same' })
  assert.equal(seen.length, 1, 'polling repeatedly must not re-fire')
})

test('push events are announced even before backfill completes', () => {
  const c = new RingEventCollector([])
  const seen: RingEventRecord[] = []
  c.subscribe((e) => seen.push(e))
  add(c, { id: 'live', source: 'push' })
  assert.equal(seen.length, 1)
})

test('a later history fetch never downgrades a live push record', () => {
  const c = new RingEventCollector([])
  setBackfilled(c, true)
  add(c, { id: 'dup', source: 'push', state: 'live' })
  add(c, { id: 'dup', source: 'history', state: 'completed' })
  const list = c.list()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.source, 'push', 'the richer live record wins')
})
