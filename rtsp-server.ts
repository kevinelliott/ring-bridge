/**
 * Minimal in-process RTSP server.
 *
 * The encoder emits RTP to a loopback UDP port; this server owns the client
 * side and fans those packets out to every subscriber. Keeping the server
 * in-process means the stream exists as long as this program runs, so a client
 * that connects before Ring is reachable still gets the placeholder video
 * rather than a connection refused.
 *
 * Supports RTP over TCP (interleaved) and over UDP. Playback only -- nothing
 * publishes over RTSP, so ANNOUNCE/RECORD are deliberately absent.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'

const RTSP_VERSION = 'RTSP/1.0'
const SUPPORTED_METHODS = 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER'
/** Interleaved frames carry a 4-byte header, and length is 16-bit. */
const MAX_INTERLEAVED_PAYLOAD = 0xffff

export interface TrackDefinition {
  /** Media kind as it appears in the SDP m= line. */
  readonly kind: 'video' | 'audio'
  /** Dynamic RTP payload type, e.g. 96. */
  readonly payloadType: number
  /** rtpmap value, e.g. "H264/90000". */
  readonly rtpmap: string
  /** Optional fmtp parameters, e.g. "packetization-mode=1". */
  readonly fmtp?: string
}

interface Track {
  readonly definition: TrackDefinition
  readonly socket: UdpSocket
  port: number
  /** Rewriting state, so encoder restarts stay invisible to clients. */
  outSeq: number
  readonly ssrc: number
  sourceSsrc?: number
  tsOffset: number
  lastOutTs: number
}

interface Transport {
  readonly trackIndex: number
  readonly kind: 'tcp' | 'udp'
  /** TCP: RTP channel (RTCP is channel+1). */
  readonly channel?: number
  /** UDP: client RTP port. */
  readonly clientPort?: number
}

interface Session {
  readonly id: string
  readonly path: string
  readonly socket: Socket
  readonly transports: Transport[]
  playing: boolean
}

/** A stream clients can subscribe to, fed by RTP arriving on loopback UDP. */
export class PublishedStream {
  readonly path: string
  readonly tracks: Track[] = []
  private readonly sessions = new Set<Session>()
  private readonly clientListeners = new Set<(count: number) => void>()
  /** Bytes fanned out, for the dashboard's measured-bitrate figure. */
  bytesSent = 0
  /** SPS/PPS sniffed from the live RTP, advertised so clients decode on join. */
  private sps?: Buffer
  private pps?: Buffer

  constructor(path: string) {
    this.path = path
  }

  async addTrack(definition: TrackDefinition): Promise<number> {
    const socket = createSocket('udp4')
    const trackIndex = this.tracks.length

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      // Port 0 lets the OS pick a free port, avoiding collisions between
      // cameras without any port bookkeeping.
      socket.bind(0, '127.0.0.1', () => {
        socket.removeListener('error', reject)
        resolve()
      })
    })

    const track: Track = {
      definition,
      socket,
      port: socket.address().port,
      outSeq: randomBytes(2).readUInt16BE(0),
      ssrc: randomBytes(4).readUInt32BE(0),
      tsOffset: 0,
      lastOutTs: 0,
    }
    this.tracks.push(track)

    socket.on('message', (packet) => {
      // Rewrite first: it detects an encoder restart and clears the cached
      // parameter sets, so capture below re-reads them from the new epoch.
      if (!this.rewriteRtpHeader(track, packet)) {
        return
      }
      if (definition.kind === 'video') {
        this.captureParameterSets(packet)
      }
      this.fanOut(trackIndex, packet)
    })
    socket.on('error', (error) => {
      console.error(`[rtsp] ${this.path} track ${trackIndex}: ${String(error)}`)
    })

    return track.port
  }

  /**
   * Give the stream one continuous RTP identity regardless of how many times
   * the encoder is restarted underneath. A restarted encoder picks a fresh
   * SSRC and restarts sequence numbers and timestamps, which clients read as a
   * broken stream ("bad cseq") and often abandon. Rewriting the header keeps
   * the sequence monotonic and the timeline moving forward across restarts.
   *
   * Returns false if the packet is too short to be valid RTP.
   */
  private rewriteRtpHeader(track: Track, packet: Buffer): boolean {
    if (packet.length < 12) {
      return false
    }

    const inTs = packet.readUInt32BE(4)
    const inSsrc = packet.readUInt32BE(8)

    if (track.sourceSsrc !== inSsrc) {
      // New encoder epoch: continue the output timeline from where it stopped,
      // leaving a nominal one-frame gap so timestamps stay strictly increasing.
      const NOMINAL_FRAME_TICKS = 3000 // 90kHz clock, ~1/30s
      track.tsOffset =
        track.sourceSsrc === undefined
          ? 0
          : (track.lastOutTs + NOMINAL_FRAME_TICKS - inTs) >>> 0
      if (track.sourceSsrc !== undefined) {
        this.resetParameterSets()
      }
      track.sourceSsrc = inSsrc
    }

    const outTs = (inTs + track.tsOffset) >>> 0
    track.lastOutTs = outTs

    packet.writeUInt16BE(track.outSeq & 0xffff, 2)
    packet.writeUInt32BE(outTs, 4)
    packet.writeUInt32BE(track.ssrc, 8)
    track.outSeq = (track.outSeq + 1) & 0xffff

    return true
  }

  /**
   * H.264 parameter sets travel in-band, so a client joining mid-GOP cannot
   * decode until the next keyframe. Sniffing SPS/PPS off the wire lets
   * DESCRIBE advertise them via sprop-parameter-sets, so decoding starts
   * immediately instead of after a GOP of errors.
   */
  private captureParameterSets(packet: Buffer): void {
    if (this.sps && this.pps) {
      return
    }
    if (packet.length < 13) {
      return
    }

    const csrcCount = packet[0]! & 0x0f
    const hasExtension = (packet[0]! & 0x10) !== 0
    let offset = 12 + csrcCount * 4

    if (hasExtension) {
      if (packet.length < offset + 4) return
      offset += 4 + packet.readUInt16BE(offset + 2) * 4
    }
    if (offset >= packet.length) {
      return
    }

    const nalType = packet[offset]! & 0x1f

    if (nalType === 24) {
      // STAP-A: a sequence of 2-byte-length-prefixed NAL units.
      let cursor = offset + 1
      while (cursor + 2 <= packet.length) {
        const size = packet.readUInt16BE(cursor)
        cursor += 2
        if (size === 0 || cursor + size > packet.length) break
        this.storeParameterSet(packet.subarray(cursor, cursor + size))
        cursor += size
      }
    } else if (nalType === 7 || nalType === 8) {
      this.storeParameterSet(packet.subarray(offset))
    }
  }

  /** A restarted encoder emits fresh parameter sets; re-sniff them. */
  private resetParameterSets(): void {
    this.sps = undefined
    this.pps = undefined
  }

  private storeParameterSet(nal: Buffer): void {
    const type = nal[0]! & 0x1f
    if (type === 7 && !this.sps) {
      this.sps = Buffer.from(nal)
    } else if (type === 8 && !this.pps) {
      this.pps = Buffer.from(nal)
    }
  }

  /** Send one RTP packet to every session subscribed to this track. */
  private fanOut(trackIndex: number, packet: Buffer): void {
    if (packet.length > MAX_INTERLEAVED_PAYLOAD) {
      return
    }

    for (const session of this.sessions) {
      if (!session.playing) {
        continue
      }

      for (const transport of session.transports) {
        if (transport.trackIndex !== trackIndex) {
          continue
        }

        this.bytesSent += packet.length
        if (transport.kind === 'tcp') {
          const header = Buffer.allocUnsafe(4)
          header[0] = 0x24 // '$'
          header[1] = transport.channel as number
          header.writeUInt16BE(packet.length, 2)
          // Cork/uncork so header and payload land in one segment.
          session.socket.cork()
          session.socket.write(header)
          session.socket.write(packet)
          session.socket.uncork()
        } else if (transport.clientPort !== undefined) {
          const address = session.socket.remoteAddress?.replace(/^::ffff:/, '')
          if (address) {
            this.tracks[trackIndex]?.socket.send(packet, transport.clientPort, address)
          }
        }
      }
    }
  }

  buildSdp(): string {
    const lines = [
      'v=0',
      'o=- 0 0 IN IP4 0.0.0.0',
      `s=${this.path}`,
      'c=IN IP4 0.0.0.0',
      't=0 0',
      'a=control:*',
    ]

    this.tracks.forEach((track, index) => {
      const { kind, payloadType, rtpmap, fmtp } = track.definition
      // Port 0: the transport is negotiated per client in SETUP.
      lines.push(`m=${kind} 0 RTP/AVP ${payloadType}`)
      lines.push(`a=rtpmap:${payloadType} ${rtpmap}`)

      const params = [fmtp]
      if (kind === 'video' && this.sps && this.pps) {
        params.push(
          `sprop-parameter-sets=${this.sps.toString('base64')},${this.pps.toString('base64')}`,
        )
      }
      const fmtpLine = params.filter(Boolean).join(';')
      if (fmtpLine) {
        lines.push(`a=fmtp:${payloadType} ${fmtpLine}`)
      }
      lines.push(`a=control:trackID=${index}`)
    })

    return lines.join('\r\n') + '\r\n'
  }

  addSession(session: Session): void {
    this.sessions.add(session)
    this.notifyClients()
  }

  removeSession(session: Session): void {
    if (this.sessions.delete(session)) {
      this.notifyClients()
    }
  }

  onClientChange(listener: (count: number) => void): () => void {
    this.clientListeners.add(listener)
    return () => this.clientListeners.delete(listener)
  }

  private notifyClients(): void {
    for (const listener of this.clientListeners) {
      listener(this.sessions.size)
    }
  }

  get clientCount(): number {
    return this.sessions.size
  }

  close(): void {
    for (const track of this.tracks) {
      track.socket.close()
    }
    for (const session of this.sessions) {
      session.socket.destroy()
    }
    this.sessions.clear()
  }
}

export class RtspServer {
  private readonly streams = new Map<string, PublishedStream>()
  private readonly sessions = new Map<string, Session>()
  private server?: Server

  /** Per-path client counts, for the admin dashboard. */
  streamInfo(): Array<{ path: string; clients: number; tracks: number; bytesSent: number }> {
    return [...this.streams.values()].map((stream) => ({
      path: stream.path,
      clients: stream.clientCount,
      tracks: stream.tracks.length,
      bytesSent: stream.bytesSent,
    }))
  }

  stream(path: string): PublishedStream | undefined {
    return this.streams.get(path)
  }

  publish(path: string): PublishedStream {
    const stream = new PublishedStream(path)
    this.streams.set(path, stream)
    return stream
  }

  listen(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket))
      this.server = server
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  }

  close(): void {
    for (const stream of this.streams.values()) {
      stream.close()
    }
    this.streams.clear()
    this.sessions.clear()
    this.server?.close()
  }

  private handleConnection(socket: Socket): void {
    socket.setNoDelay(true)
    let buffer: Buffer = Buffer.alloc(0)

    socket.on('data', (data: Buffer | string) => {
      const chunk: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

      for (;;) {
        // Clients may interleave RTCP back to us; skip those frames.
        if (buffer[0] === 0x24) {
          if (buffer.length < 4) return
          const length = buffer.readUInt16BE(2)
          if (buffer.length < 4 + length) return
          buffer = buffer.subarray(4 + length)
          continue
        }

        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return

        const head = buffer.subarray(0, headerEnd).toString('utf8')
        const contentLength = Number(
          /^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0,
        )
        const total = headerEnd + 4 + contentLength
        if (buffer.length < total) return

        buffer = buffer.subarray(total)
        this.handleRequest(socket, head)
      }
    })

    const cleanup = (): void => this.dropSessionsFor(socket)
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  }

  private dropSessionsFor(socket: Socket): void {
    for (const [id, session] of this.sessions) {
      if (session.socket === socket) {
        this.streams.get(session.path)?.removeSession(session)
        this.sessions.delete(id)
      }
    }
  }

  private handleRequest(socket: Socket, head: string): void {
    const [requestLine = '', ...headerLines] = head.split('\r\n')
    const [method = '', url = ''] = requestLine.split(/\s+/)

    const headers = new Map<string, string>()
    for (const line of headerLines) {
      const separator = line.indexOf(':')
      if (separator > 0) {
        headers.set(
          line.slice(0, separator).trim().toLowerCase(),
          line.slice(separator + 1).trim(),
        )
      }
    }

    const cseq = headers.get('cseq') ?? '0'
    const respond = (status: string, extra: string[] = [], body = ''): void => {
      const lines = [
        `${RTSP_VERSION} ${status}`,
        `CSeq: ${cseq}`,
        ...extra,
      ]
      if (body) {
        lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n' + body)
    }

    switch (method) {
      case 'OPTIONS':
        respond('200 OK', [`Public: ${SUPPORTED_METHODS}`])
        return

      case 'DESCRIBE': {
        const stream = this.lookupStream(url)
        if (!stream) {
          respond('404 Not Found')
          return
        }
        const sdp = stream.buildSdp()
        respond(
          '200 OK',
          [
            'Content-Type: application/sdp',
            `Content-Base: ${this.baseUrl(url)}/`,
          ],
          sdp,
        )
        return
      }

      case 'SETUP': {
        const stream = this.lookupStream(url)
        if (!stream) {
          respond('404 Not Found')
          return
        }

        const trackIndex = Number(/trackID=(\d+)/.exec(url)?.[1] ?? 0)
        if (!stream.tracks[trackIndex]) {
          respond('404 Not Found')
          return
        }

        const transportHeader = headers.get('transport') ?? ''
        const sessionId =
          headers.get('session') ?? randomBytes(4).toString('hex').toUpperCase()

        let session = this.sessions.get(sessionId)
        if (!session) {
          session = {
            id: sessionId,
            path: this.pathOf(url),
            socket,
            transports: [],
            playing: false,
          }
          this.sessions.set(sessionId, session)
          stream.addSession(session)
        }

        const interleaved = /interleaved=(\d+)-(\d+)/.exec(transportHeader)
        const clientPort = /client_port=(\d+)-(\d+)/.exec(transportHeader)

        if (transportHeader.includes('TCP') || interleaved) {
          const channel = interleaved
            ? Number(interleaved[1])
            : trackIndex * 2
          session.transports.push({ trackIndex, kind: 'tcp', channel })
          respond('200 OK', [
            `Transport: RTP/AVP/TCP;unicast;interleaved=${channel}-${channel + 1}`,
            `Session: ${sessionId};timeout=60`,
          ])
          return
        }

        if (clientPort) {
          const port = Number(clientPort[1])
          session.transports.push({ trackIndex, kind: 'udp', clientPort: port })
          const serverPort = stream.tracks[trackIndex]?.port ?? 0
          respond('200 OK', [
            `Transport: RTP/AVP;unicast;client_port=${port}-${port + 1};` +
              `server_port=${serverPort}-${serverPort + 1}`,
            `Session: ${sessionId};timeout=60`,
          ])
          return
        }

        respond('461 Unsupported Transport')
        return
      }

      case 'PLAY': {
        const sessionId = headers.get('session')?.split(';')[0] ?? ''
        const session = this.sessions.get(sessionId)
        if (!session) {
          respond('454 Session Not Found')
          return
        }
        session.playing = true

        const rtpInfo = session.transports
          .map((t) => `url=${this.baseUrl(url)}/trackID=${t.trackIndex}`)
          .join(',')

        respond('200 OK', [
          `Session: ${sessionId};timeout=60`,
          `Range: npt=0.000-`,
          ...(rtpInfo ? [`RTP-Info: ${rtpInfo}`] : []),
        ])
        console.log(
          `[rtsp] ${session.path}: client connected (${session.transports[0]?.kind ?? '?'})`,
        )
        return
      }

      case 'TEARDOWN': {
        const sessionId = headers.get('session')?.split(';')[0] ?? ''
        const session = this.sessions.get(sessionId)
        if (session) {
          this.streams.get(session.path)?.removeSession(session)
          this.sessions.delete(sessionId)
          console.log(`[rtsp] ${session.path}: client disconnected`)
        }
        respond('200 OK')
        return
      }

      case 'GET_PARAMETER':
        respond('200 OK')
        return

      default:
        respond('501 Not Implemented')
    }
  }

  /** Strip scheme/host and any trailing track selector to get the stream path. */
  private pathOf(url: string): string {
    const withoutScheme = url.replace(/^rtsp:\/\/[^/]+/i, '')
    return withoutScheme
      .replace(/\/?trackID=\d+\/?$/i, '')
      .replace(/^\/+|\/+$/g, '')
  }

  private baseUrl(url: string): string {
    return url.replace(/\/?trackID=\d+\/?$/i, '').replace(/\/+$/, '')
  }

  private lookupStream(url: string): PublishedStream | undefined {
    return this.streams.get(this.pathOf(url))
  }
}
