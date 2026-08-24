import { RingApi, type Location, type RingCamera } from 'ring-client-api'
import { loadRefreshToken, persistRefreshTokenUpdates } from './ring-auth.ts'

const ringApi = new RingApi({ refreshToken: loadRefreshToken() })
const stopPersistingToken = persistRefreshTokenUpdates(ringApi)

/** Right-pad `value` so columns line up in the tree output. */
function pad(value: string, width: number): string {
  return value.padEnd(width)
}

/** Battery / power state for a single camera, e.g. "87%" or "wired". */
function describePower(camera: RingCamera): string {
  if (!camera.hasBattery) {
    return 'wired'
  }

  const level = camera.batteryLevel
  const charging = camera.isCharging ? ' (charging)' : ''

  return level === null ? 'battery ?' : `battery ${level}%${charging}`
}

/** One line per camera, drawn as a branch under its location. */
function formatCamera(
  camera: RingCamera,
  isLast: boolean,
  widths: { name: number; model: number; power: number },
): string {
  const branch = isLast ? '└─' : '├─'
  const status = camera.isOffline ? 'offline' : 'online'

  return [
    `  ${branch} ${pad(camera.name, widths.name)}`,
    pad(camera.model, widths.model),
    pad(describePower(camera), widths.power),
    status,
  ].join('  ')
}

function formatLocation(location: Location): string {
  const { cameras } = location
  const lines = [`${location.name}  (${location.id}) — ${cameras.length} camera${cameras.length === 1 ? '' : 's'}`]

  if (cameras.length === 0) {
    lines.push('  └─ (no cameras)')
    return lines.join('\n')
  }

  // Size the columns to the widest entry so everything stays aligned.
  const widths = {
    name: Math.max(...cameras.map((camera) => camera.name.length)),
    model: Math.max(...cameras.map((camera) => camera.model.length)),
    power: Math.max(...cameras.map((camera) => describePower(camera).length)),
  }

  for (const [index, camera] of cameras.entries()) {
    lines.push(formatCamera(camera, index === cameras.length - 1, widths))
  }

  return lines.join('\n')
}

const locations = await ringApi.getLocations()

console.log(
  `\nRing locations (${locations.length})\n\n` +
    locations.map(formatLocation).join('\n\n') +
    '\n',
)

stopPersistingToken()
ringApi.disconnect()
