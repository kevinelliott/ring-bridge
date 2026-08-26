import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthError } from '../ring-login.ts'

test('classifies a dead refresh token as an auth error', () => {
  assert.equal(
    isAuthError(new Error(
      'Refresh token is not valid.  Unable to authenticate with Ring servers.',
    )),
    true,
  )
  assert.equal(isAuthError(new Error('invalid_grant')), true)
  assert.equal(isAuthError(new Error('Request failed with status 401')), true)
})

test('does not mistake transient failures for a dead token', () => {
  // Telling someone to log in again because a camera was unreachable, or the
  // network blipped, would send them chasing the wrong problem.
  for (const message of [
    'connect ETIMEDOUT 10.0.0.5:443',
    'Camera is offline',
    'socket hang up',
    'Request failed with status 503',
    'ffmpeg exited with code 1',
  ]) {
    assert.equal(isAuthError(new Error(message)), false, message)
  }
})

test('accepts non-Error values without throwing', () => {
  assert.equal(isAuthError('invalid_grant'), true)
  assert.equal(isAuthError(undefined), false)
  assert.equal(isAuthError(null), false)
})
