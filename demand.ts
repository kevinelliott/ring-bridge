/**
 * Decides when a camera's Ring connection should be open.
 *
 * Holding a live view open around the clock is what makes battery cameras
 * unusable and what fills Ring's event history with `on_demand` entries -- one
 * per dial. On-demand mode connects only while something is actually watching:
 * an RTSP client, or a temporary pin from the dashboard.
 *
 * `alwaysOn` opts a camera out, for feeds that must have a current frame at all
 * times regardless of who is watching.
 */
export interface DemandOptions {
  alwaysOn: boolean
  onDemand: boolean
  idleTimeoutSec: number
}

export class DemandTracker {
  private readonly label: string
  private options: DemandOptions
  private clients = 0
  /** Set while the dashboard has asked for a temporary connection. */
  private pinnedUntil = 0
  /** Wall time the last client left, for the idle grace period. */
  private idleSince = 0
  private readonly listeners = new Set<() => void>()

  constructor(label: string, options: DemandOptions) {
    this.label = label
    this.options = options
    this.idleSince = Date.now()
  }

  update(options: DemandOptions): void {
    this.options = options
    this.notify()
  }

  setClients(count: number): void {
    if (count === this.clients) {
      return
    }
    const had = this.clients > 0
    this.clients = count
    if (count === 0 && had) {
      this.idleSince = Date.now()
    }
    this.notify()
  }

  /** Keep the connection open for a while regardless of clients. */
  pin(seconds: number): void {
    this.pinnedUntil = Date.now() + seconds * 1000
    console.log(`${this.label} pinned online for ${seconds}s`)
    this.notify()
  }

  unpin(): void {
    this.pinnedUntil = 0
    this.idleSince = Date.now()
    this.notify()
  }

  get pinned(): boolean {
    return Date.now() < this.pinnedUntil
  }

  get clientCount(): number {
    return this.clients
  }

  shouldConnect(): boolean {
    if (this.options.alwaysOn || !this.options.onDemand) {
      return true
    }
    if (this.clients > 0 || this.pinned) {
      return true
    }
    // Grace period: a client that reconnects quickly should not pay for a
    // fresh Ring dial, which takes seconds and logs another event.
    return Date.now() - this.idleSince < this.options.idleTimeoutSec * 1000
  }

  /** Human-readable reason, shown on the dashboard. */
  get reason(): string {
    if (this.options.alwaysOn) return 'always-on'
    if (!this.options.onDemand) return 'on-demand disabled'
    if (this.clients > 0) return `${this.clients} client${this.clients === 1 ? '' : 's'}`
    if (this.pinned) return 'pinned from dashboard'
    if (this.shouldConnect()) return 'idle grace period'
    return 'no clients'
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
