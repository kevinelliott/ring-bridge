import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DemandTracker } from '../demand.ts'

const opts = { alwaysOn: false, onDemand: true, idleTimeoutSec: 0 }

test('on-demand stays disconnected with no clients', () => {
  const d = new DemandTracker('[t]', opts)
  assert.equal(d.shouldConnect(), false)
  assert.match(d.reason, /no clients/)
})

test('a client brings the connection up', () => {
  const d = new DemandTracker('[t]', opts)
  d.setClients(1)
  assert.equal(d.shouldConnect(), true)
  assert.match(d.reason, /1 client/)
  d.setClients(0)
  assert.equal(d.shouldConnect(), false)
})

test('alwaysOn overrides the absence of clients', () => {
  const d = new DemandTracker('[t]', { ...opts, alwaysOn: true })
  assert.equal(d.shouldConnect(), true)
  assert.equal(d.reason, 'always-on')
})

test('disabling on-demand keeps the connection up', () => {
  const d = new DemandTracker('[t]', { ...opts, onDemand: false })
  assert.equal(d.shouldConnect(), true)
})

test('a pin holds the connection, and unpin releases it', () => {
  const d = new DemandTracker('[t]', opts)
  d.pin(60)
  assert.equal(d.shouldConnect(), true)
  assert.equal(d.pinned, true)
  d.unpin()
  assert.equal(d.shouldConnect(), false)
})

test('the idle grace period spans a quick reconnect', () => {
  const d = new DemandTracker('[t]', { ...opts, idleTimeoutSec: 60 })
  d.setClients(1)
  d.setClients(0)
  assert.equal(d.shouldConnect(), true, 'still within the grace window')
  assert.match(d.reason, /grace/)
})

test('changes notify listeners so the supervisor reacts promptly', () => {
  const d = new DemandTracker('[t]', opts)
  let calls = 0
  const off = d.onChange(() => calls++)
  d.setClients(1)
  d.setClients(0)
  assert.equal(calls, 2)
  off()
  d.setClients(1)
  assert.equal(calls, 2, 'unsubscribed listener stops firing')
})
