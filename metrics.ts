/**
 * Prometheus text-format metrics.
 *
 * Hand-rolled rather than pulling in a client library: the exposition format is
 * a few lines of text, and everything here is already tracked for the dashboard.
 */
import type { BridgeStatus } from './admin-server.ts'

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

export function renderMetrics(status: BridgeStatus): string {
  const lines: string[] = []
  const add = (name: string, help: string, type: string): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
  }

  add('ring_bridge_up', 'Always 1; presence indicates the bridge is running.', 'gauge')
  lines.push('ring_bridge_up 1')

  add('ring_bridge_uptime_seconds', 'Seconds since the bridge started.', 'gauge')
  lines.push(
    `ring_bridge_uptime_seconds ${Math.floor((Date.now() - status.startedAt) / 1000)}`,
  )

  add('ring_bridge_camera_live', 'Whether Ring frames are currently arriving.', 'gauge')
  add('ring_bridge_camera_connected', 'Whether a Ring session is open.', 'gauge')
  add('ring_bridge_camera_clients', 'RTSP clients connected to this camera.', 'gauge')
  add('ring_bridge_camera_dropped_frames_total', 'Frames skipped due to encoder backpressure.', 'counter')
  add('ring_bridge_camera_encoder_restarts_total', 'Encoder process restarts.', 'counter')
  add('ring_bridge_camera_peak_queued_frames', 'Peak encoder input queue depth, in frames.', 'gauge')
  add('ring_bridge_camera_sent_bytes_total', 'RTP bytes fanned out to clients.', 'counter')
  add('ring_bridge_output_fps', 'Measured frames per second per output.', 'gauge')

  for (const camera of status.cameras) {
    const l = `camera="${esc(camera.name)}"`
    lines.push(`ring_bridge_camera_live{${l}} ${camera.live ? 1 : 0}`)
    lines.push(`ring_bridge_camera_connected{${l}} ${camera.connected ? 1 : 0}`)
    lines.push(`ring_bridge_camera_clients{${l}} ${camera.clients}`)
    lines.push(`ring_bridge_camera_dropped_frames_total{${l}} ${camera.droppedFrames}`)
    lines.push(`ring_bridge_camera_encoder_restarts_total{${l}} ${camera.encoderRestarts}`)
    lines.push(`ring_bridge_camera_peak_queued_frames{${l}} ${camera.peakQueuedFrames}`)
    lines.push(`ring_bridge_camera_sent_bytes_total{${l}} ${camera.bytesSent}`)
    for (const output of camera.outputs) {
      lines.push(
        `ring_bridge_output_fps{${l},output="${esc(output.name)}"} ${output.measuredFps}`,
      )
    }
  }

  add('ring_bridge_events_total', 'Ring events currently held in memory.', 'gauge')
  lines.push(`ring_bridge_events_total ${status.events.count}`)

  add('ring_bridge_mqtt_connected', 'Whether the MQTT client is connected.', 'gauge')
  lines.push(`ring_bridge_mqtt_connected ${status.mqtt.connected ? 1 : 0}`)

  return lines.join('\n') + '\n'
}
