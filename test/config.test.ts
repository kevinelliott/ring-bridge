import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadConfig, saveConfig, settingsFor, parseSize, validateSettings,
  BUILT_IN_DEFAULTS,
} from '../config.ts'

const dir = mkdtempSync(join(tmpdir(), 'ring-bridge-test-'))
const write = (name: string, body: unknown): string => {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(body))
  return path
}

test('missing config file falls back to built-in defaults', () => {
  const config = loadConfig(join(dir, 'does-not-exist.json'))
  assert.equal(config.rtspPort, BUILT_IN_DEFAULTS.rtspPort)
  assert.equal(config.defaults.width, 1920)
})

test('per-camera overrides layer over defaults', () => {
  const path = write('a.json', {
    defaults: { width: 1280, height: 720, fps: 15 },
    cameras: { 'Front Door': { fps: 20, alwaysOn: true } },
  })
  const config = loadConfig(path)

  const front = settingsFor(config, 'Front Door')
  assert.equal(front.width, 1280, 'inherits default width')
  assert.equal(front.fps, 20, 'own fps wins')
  assert.equal(front.alwaysOn, true)

  const other = settingsFor(config, 'Backyard')
  assert.equal(other.fps, 15, 'unlisted camera keeps defaults')
  assert.equal(other.alwaysOn, false)
})

test('camera lookup is case-insensitive', () => {
  const path = write('b.json', { cameras: { 'FRONT door': { fps: 7 } } })
  const config = loadConfig(path)
  assert.equal(settingsFor(config, 'Front Door').fps, 7)
})

test('unknown keys in the file are ignored, not merged', () => {
  const path = write('c.json', {
    defaults: { width: 1280, height: 720, evil: 'payload' },
  })
  const config = loadConfig(path)
  assert.equal((config.defaults as Record<string, unknown>).evil, undefined)
  assert.equal(config.defaults.width, 1280)
})

test('invalid JSON reports the file, not a parser stack', () => {
  const path = join(dir, 'bad.json')
  writeFileSync(path, '{not json')
  assert.throws(() => loadConfig(path), /is not valid JSON/)
})

test('save then load round-trips', () => {
  const path = join(dir, 'rt.json')
  const config = loadConfig(join(dir, 'missing.json'))
  config.defaults.crf = 30
  config.cameras['Cam'] = { fps: 12 }
  saveConfig(path, config)
  assert.match(readFileSync(path, 'utf8'), /"crf": 30/)
  const reloaded = loadConfig(path)
  assert.equal(reloaded.defaults.crf, 30)
  assert.equal(settingsFor(reloaded, 'Cam').fps, 12)
})

test('parseSize rejects odd dimensions', () => {
  assert.deepEqual(parseSize('1920x1080'), { width: 1920, height: 1080 })
  // yuv420p subsamples chroma 2x2, so odd sizes have no valid layout.
  assert.throws(() => parseSize('1919x1080'), /even/)
  assert.throws(() => parseSize('banana'), /expected WxH/)
})

test('validateSettings rejects shell-ish encoder and preset values', () => {
  assert.equal(validateSettings({ encoder: 'libx264' }), undefined)
  assert.match(String(validateSettings({ encoder: 'rm -rf /' })), /unexpected/)
  assert.match(String(validateSettings({ preset: 'fast;evil' })), /unexpected/)
  assert.match(String(validateSettings({ crf: 99 })), /between 0 and 51/)
  assert.match(String(validateSettings({ fps: 0 })), /between 1 and 60/)
  assert.match(String(validateSettings({ bitrateKbps: 5 })), /at least 100/)
})
