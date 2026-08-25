/**
 * MQTT publishing with Home Assistant discovery.
 *
 * Publishes a binary_sensor per camera for motion and one for the doorbell, so
 * Home Assistant creates the entities itself rather than requiring hand-written
 * YAML. Availability is retained under a last-will topic, so entities show as
 * unavailable if the bridge dies rather than silently going stale.
 *
 * MQTT is optional and entirely non-blocking: if the broker is unreachable the
 * client keeps retrying in the background while streaming carries on.
 */
import mqtt, { type MqttClient } from 'mqtt'
import type { MqttConfig } from './config.ts'
import type { RingEventRecord } from './ring-events.ts'

/** How long a motion/ding sensor stays "on" after an event. */
const TRIGGER_HOLD_MS = 30_000

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export class MqttBridge {
  private readonly config: MqttConfig
  private readonly cameraNames: string[]
  private client?: MqttClient
  private connected = false
  private lastError?: string
  private readonly resetTimers = new Map<string, NodeJS.Timeout>()

  constructor(config: MqttConfig, cameraNames: string[]) {
    this.config = config
    this.cameraNames = cameraNames
  }

  get enabled(): boolean {
    return Boolean(this.config.url)
  }

  get status(): { enabled: boolean; connected: boolean; error?: string } {
    return { enabled: this.enabled, connected: this.connected, error: this.lastError }
  }

  private get availabilityTopic(): string {
    return `${this.config.topicPrefix}/status`
  }

  async start(): Promise<void> {
    if (!this.config.url) {
      return
    }

    this.client = mqtt.connect(this.config.url, {
      username: this.config.username,
      password: this.config.password,
      reconnectPeriod: 5_000,
      will: {
        topic: this.availabilityTopic,
        payload: Buffer.from('offline'),
        qos: 0,
        retain: true,
      },
    })

    this.client.on('connect', () => {
      this.connected = true
      this.lastError = undefined
      console.log(`[mqtt] connected to ${this.config.url}`)
      this.client?.publish(this.availabilityTopic, 'online', { retain: true })
      if (this.config.discoveryPrefix) {
        this.publishDiscovery()
      }
      // Seed every sensor so entities exist before the first real event.
      for (const name of this.cameraNames) {
        for (const kind of ['motion', 'ding'] as const) {
          this.client?.publish(this.stateTopic(name, kind), 'OFF', { retain: true })
        }
      }
    })

    this.client.on('error', (error) => {
      this.lastError = String(error)
      console.error(`[mqtt] ${String(error)}`)
    })
    this.client.on('close', () => {
      this.connected = false
    })
  }

  private stateTopic(cameraName: string, kind: 'motion' | 'ding'): string {
    return `${this.config.topicPrefix}/${slug(cameraName)}/${kind}`
  }

  /** Home Assistant MQTT discovery payloads, retained so HA finds them late. */
  private publishDiscovery(): void {
    for (const name of this.cameraNames) {
      const id = slug(name)
      const device = {
        identifiers: [`ring_bridge_${id}`],
        name,
        manufacturer: 'Ring',
        model: 'Ring Bridge',
      }

      for (const [kind, deviceClass, label] of [
        ['motion', 'motion', 'Motion'],
        ['ding', 'occupancy', 'Doorbell'],
      ] as const) {
        const topic =
          `${this.config.discoveryPrefix}/binary_sensor/ring_bridge_${id}_${kind}/config`
        this.client?.publish(
          topic,
          JSON.stringify({
            name: label,
            unique_id: `ring_bridge_${id}_${kind}`,
            state_topic: this.stateTopic(name, kind),
            device_class: deviceClass,
            payload_on: 'ON',
            payload_off: 'OFF',
            availability_topic: this.availabilityTopic,
            device,
          }),
          { retain: true },
        )
      }
    }
    console.log(`[mqtt] published Home Assistant discovery for ${this.cameraNames.length} camera(s)`)
  }

  publishEvent(event: RingEventRecord): void {
    if (!this.client || !this.connected) {
      return
    }

    const kind = event.kind.includes('ding') || event.kind === 'ding' ? 'ding' : 'motion'
    // on_demand is the bridge dialing Ring, not something that happened.
    if (event.kind === 'on_demand') {
      return
    }

    const topic = this.stateTopic(event.cameraName, kind)
    this.client.publish(topic, 'ON', { retain: true })
    this.client.publish(
      `${this.config.topicPrefix}/${slug(event.cameraName)}/event`,
      JSON.stringify({
        kind: event.kind,
        at: new Date(event.at).toISOString(),
        personDetected: event.personDetected ?? false,
      }),
    )

    // Ring reports a trigger, not a duration, so release it on a timer.
    clearTimeout(this.resetTimers.get(topic))
    this.resetTimers.set(
      topic,
      setTimeout(() => {
        this.client?.publish(topic, 'OFF', { retain: true })
      }, TRIGGER_HOLD_MS),
    )
  }

  async stop(): Promise<void> {
    for (const timer of this.resetTimers.values()) {
      clearTimeout(timer)
    }
    this.resetTimers.clear()
    if (!this.client) {
      return
    }
    this.client.publish(this.availabilityTopic, 'offline', { retain: true })
    await new Promise<void>((resolve) => this.client?.end(false, {}, () => resolve()))
    this.client = undefined
    this.connected = false
  }
}
