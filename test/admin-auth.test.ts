import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { AdminServer, type AdminContext, type BridgeStatus } from '../admin-server.ts'
import { RingEventCollector } from '../ring-events.ts'
import { BUILT_IN_DEFAULTS } from '../config.ts'

const TOKEN = 'test-secret-token'
let port = 0
let server: AdminServer

const status: BridgeStatus = {
  startedAt: Date.now(),
  rtspPort: 8554,
  cameras: [],
  events: { lastRefreshAt: 0, count: 0 },
  mqtt: { enabled: false, connected: false },
  auth: { state: 'ok' },
  cameraChanges: { added: [], removed: 0 },
}

const context: AdminContext = {
  getStatus: () => status,
  getConfig: () => BUILT_IN_DEFAULTS,
  applyConfig: () => ({ applied: [] }),
  pinCamera: () => true,
  getPublisher: () => undefined,
  getRuntime: () => undefined,
  talk: async () => ({}),
  events: new RingEventCollector([]),
  refreshEvents: async () => {},
  onReauthenticated: () => {},
}

before(async () => {
  server = new AdminServer(context, TOKEN)
  // Port 0 lets the OS pick, so tests never collide with a running bridge.
  await server.listen(0, '127.0.0.1')
  port = (server as unknown as { server: { address(): { port: number } } })
    .server.address().port
})

after(() => server.close())

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers })

const post = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  })

test('the page shell stays open so it can render the token prompt', async () => {
  assert.equal((await get('/')).status, 200)
  const auth = await (await get('/api/auth')).json()
  assert.equal(auth.authRequired, true)
})

test('every data endpoint is gated when a token is configured', async () => {
  // The whole point of the token is protecting camera video; a token that
  // guarded only config changes would leave snapshots and logs readable.
  for (const path of [
    '/api/status', '/api/logs', '/api/events', '/api/config',
    '/api/snapshot/front_door', '/api/preview/front_door', '/metrics',
  ]) {
    assert.equal((await get(path)).status, 401, `${path} should be gated`)
  }
})

test('reads accept the header or the cookie', async () => {
  assert.equal((await get('/api/status', { 'x-admin-token': TOKEN })).status, 200)
  // EventSource and <img> cannot set headers, so reads must accept a cookie.
  assert.equal(
    (await get('/api/status', { cookie: `admin_token=${TOKEN}` })).status,
    200,
  )
})

test('mutations require the header and reject the cookie', async () => {
  // A browser attaches cookies to cross-site requests but cannot add headers,
  // so header-only is what makes these endpoints CSRF-proof.
  for (const path of ['/api/config', '/api/pin/front_door', '/api/login/start']) {
    assert.equal(
      (await post(path, { cookie: `admin_token=${TOKEN}` })).status, 401,
      `${path} must not accept cookie auth`,
    )
  }
  assert.notEqual(
    (await post('/api/config', { 'x-admin-token': TOKEN })).status, 401,
    'the header is accepted',
  )
})

test('the token is never accepted from the query string', async () => {
  // URLs land in server logs, proxy logs and browser history.
  assert.equal((await get(`/api/status?token=${TOKEN}`)).status, 401)
})

test('a wrong or truncated token is rejected', async () => {
  for (const bad of ['', 'wrong', TOKEN.slice(0, -1), TOKEN + 'x']) {
    assert.equal(
      (await get('/api/status', { 'x-admin-token': bad })).status, 401,
      `"${bad}" must be rejected`,
    )
  }
})

test('unknown paths 404 rather than leaking behaviour', async () => {
  assert.equal((await get('/api/nope', { 'x-admin-token': TOKEN })).status, 404)
})

test('with no token configured, reads are open', async () => {
  const open = new AdminServer(context)
  await open.listen(0, '127.0.0.1')
  const p = (open as unknown as { server: { address(): { port: number } } })
    .server.address().port
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/status`)
    assert.equal(r.status, 200)
    const auth = await (await fetch(`http://127.0.0.1:${p}/api/auth`)).json()
    assert.equal(auth.authRequired, false)
  } finally {
    open.close()
  }
})
