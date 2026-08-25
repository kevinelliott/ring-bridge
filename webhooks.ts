/**
 * Fire-and-forget webhooks for Ring events.
 *
 * For people who want automation triggers without running an MQTT broker. A
 * webhook failure must never disturb streaming, so errors are logged and
 * dropped rather than retried -- a queue of stale doorbell presses helps
 * nobody.
 */
import type { RingEventRecord } from './ring-events.ts'

const TIMEOUT_MS = 5_000

export class WebhookSender {
  private readonly url?: string

  constructor(url?: string) {
    this.url = url
  }

  get enabled(): boolean {
    return Boolean(this.url)
  }

  async send(event: RingEventRecord): Promise<void> {
    if (!this.url) {
      return
    }
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          camera: event.cameraName,
          kind: event.kind,
          at: new Date(event.at).toISOString(),
          personDetected: event.personDetected ?? false,
          source: event.source,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        console.error(`[webhook] ${this.url} returned ${response.status}`)
      }
    } catch (error) {
      console.error(`[webhook] failed: ${String(error)}`)
    }
  }
}
