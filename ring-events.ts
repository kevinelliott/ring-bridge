/**
 * Ring event collection for the admin UI.
 *
 * Two sources feed one list. Push notifications arrive live over the receiver
 * the library registers during getLocations(), and are what make the dashboard
 * react the moment someone rings the bell. The REST history fills in what
 * happened before the bridge started, and backfills anything a missed push
 * would otherwise lose. Both are keyed by ding id so the two never double up.
 */
import type { RingCamera } from 'ring-client-api'
import type { Subscription } from 'rxjs'

export type EventSource = 'push' | 'history'

export interface RingEventRecord {
  /** Ring's ding id where known, otherwise a synthetic key for local events. */
  readonly id: string
  readonly cameraName: string
  readonly cameraId: number
  readonly kind: string
  readonly at: number
  readonly state?: string
  readonly personDetected?: boolean
  readonly source: EventSource
  /** Ring snapshot id, when the push notification carried one. */
  readonly snapshotUuid?: string
}

const HISTORY_LIMIT = 200
/** How many events to pull per camera when backfilling. */
const FETCH_LIMIT = 25

type Listener = (event: RingEventRecord) => void

export class RingEventCollector {
  /** Cameras by name, so the admin server can fetch snapshots by id. */
  readonly byName = new Map<string, RingCamera>()

  private readonly events = new Map<string, RingEventRecord>()
  private readonly listeners = new Set<Listener>()
  private readonly subscriptions: Subscription[] = []
  private readonly cameras: RingCamera[]
  private lastRefreshAt = 0
  private refreshError?: string
  /**
   * Suppresses notifications during the first history fetch. Backfill is
   * catching up on what already happened, not news -- announcing fifty old
   * events over MQTT at every startup would be worse than useless.
   */
  private backfilled = false

  constructor(cameras: RingCamera[]) {
    this.cameras = cameras
    for (const camera of cameras) {
      this.byName.set(camera.name, camera)
    }
  }

  /** Attach to live push notifications for every bridged camera. */
  start(): void {
    for (const camera of this.cameras) {
      this.subscriptions.push(
        camera.onNewNotification.subscribe((notification) => {
          const data = notification.data as Record<string, any> | undefined
          const event = data?.event as Record<string, any> | undefined
          const dingId =
            (event?.ding?.id as string | number | undefined) ??
            notification.analytics?.server_correlation_id

          this.add({
            snapshotUuid: camera.latestNotificationSnapshotUuid,
            id: dingId ? String(dingId) : `${camera.id}-${Date.now()}`,
            cameraName: camera.name,
            cameraId: camera.id,
            kind: String(event?.ding?.subtype ?? event?.type ?? 'notification'),
            at: Date.now(),
            state: 'live',
            personDetected:
              typeof event?.ding?.detection_type === 'string'
                ? event.ding.detection_type.includes('human')
                : undefined,
            source: 'push',
          })
        }),
      )
    }
  }

  /**
   * Pull recent events from Ring's REST history. Failures are recorded rather
   * than thrown -- the dashboard should still render if history is unavailable.
   */
  async refresh(): Promise<void> {
    const results = await Promise.allSettled(
      this.cameras.map(async (camera) => {
        const response = await camera.getEvents({ limit: FETCH_LIMIT })
        for (const event of response.events ?? []) {
          this.add({
            id: event.ding_id_str ?? String(event.ding_id),
            cameraName: camera.name,
            cameraId: camera.id,
            kind: event.kind,
            at: new Date(event.created_at).getTime(),
            state: event.state,
            personDetected: Boolean(event.cv_properties?.person_detected),
            source: 'history',
          })
        }
      }),
    )

    this.backfilled = true

    const failure = results.find((r) => r.status === 'rejected')
    this.refreshError =
      failure && failure.status === 'rejected'
        ? String(failure.reason)
        : undefined
    this.lastRefreshAt = Date.now()
  }

  private add(event: RingEventRecord): void {
    const existing = this.events.get(event.id)
    // A live push is the more informative record; never let a later history
    // fetch overwrite it with the same ding.
    if (existing && existing.source === 'push' && event.source === 'history') {
      return
    }

    this.events.set(event.id, event)

    if (this.events.size > HISTORY_LIMIT) {
      const oldest = [...this.events.values()].sort((a, b) => a.at - b.at)
      for (const stale of oldest.slice(0, this.events.size - HISTORY_LIMIT)) {
        this.events.delete(stale.id)
      }
    }

    // Anything genuinely new is worth announcing, whether it arrived by push
    // or was found by polling history. Without this, MQTT and webhooks would
    // go silent whenever push registration is disabled.
    const isNew = existing === undefined
    if (isNew && (event.source === 'push' || this.backfilled)) {
      for (const listener of this.listeners) {
        listener(event)
      }
    }
  }

  list(limit = 100): RingEventRecord[] {
    return [...this.events.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  }

  get status(): { lastRefreshAt: number; error?: string; count: number } {
    return {
      lastRefreshAt: this.lastRefreshAt,
      error: this.refreshError,
      count: this.events.size,
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe()
    }
    this.subscriptions.length = 0
    this.listeners.clear()
  }
}
