import { test } from 'node:test'
import assert from 'node:assert/strict'
import { upsertEnvValue } from '../ring-auth.ts'

const KEY = 'RING_REFRESH_TOKEN'

test('replaces an existing value', () => {
  assert.equal(upsertEnvValue(`${KEY}=old\n`, KEY, 'NEW'), `${KEY}=NEW\n`)
})

test('preserves comments and unrelated keys', () => {
  const input = `# comment\nFOO=bar\n${KEY}=old\nBAZ=qux\n`
  assert.equal(upsertEnvValue(input, KEY, 'NEW'), `# comment\nFOO=bar\n${KEY}=NEW\nBAZ=qux\n`)
})

test('normalises an exported assignment', () => {
  assert.equal(upsertEnvValue(`export ${KEY}=old\n`, KEY, 'NEW'), `${KEY}=NEW\n`)
})

test('handles a file with no trailing newline', () => {
  assert.equal(upsertEnvValue(`FOO=bar\n${KEY}=old`, KEY, 'NEW'), `FOO=bar\n${KEY}=NEW`)
})

test('appends when the key is absent', () => {
  assert.equal(upsertEnvValue('FOO=bar\n', KEY, 'NEW'), `FOO=bar\n${KEY}=NEW\n`)
  assert.equal(upsertEnvValue('', KEY, 'NEW'), `${KEY}=NEW\n`)
})

test('does not match a key that merely contains the name', () => {
  const input = `MY_${KEY}_X=keep\n${KEY}=old\n`
  assert.equal(upsertEnvValue(input, KEY, 'NEW'), `MY_${KEY}_X=keep\n${KEY}=NEW\n`)
})
