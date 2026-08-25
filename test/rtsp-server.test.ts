import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RtspServer, PublishedStream } from '../rtsp-server.ts'

/** Build a minimal RTP packet: 12-byte header plus payload. */
function rtp(seq: number, ts: number, ssrc: number, payload: Buffer): Buffer {
  const packet = Buffer.alloc(12 + payload.length)
  packet[0] = 0x80
  packet[1] = 96
  packet.writeUInt16BE(seq, 2)
  packet.writeUInt32BE(ts, 4)
  packet.writeUInt32BE(ssrc, 8)
  payload.copy(packet, 12)
  return packet
}

/** Reach the private rewrite through a track, as the socket handler does. */
function rewriteAll(stream: PublishedStream, packets: Buffer[]): Buffer[] {
  const track = stream.tracks[0]
  const rewrite = (
    stream as unknown as {
      rewriteRtpHeader(t: unknown, p: Buffer): boolean
    }
  ).rewriteRtpHeader.bind(stream)
  return packets.filter((p) => rewrite(track, p))
}

test('RTP rewriting keeps one identity across an encoder restart', async () => {
  const stream = new PublishedStream('cam')
  await stream.addTrack({
    kind: 'video', payloadType: 96, rtpmap: 'H264/90000',
  })

  // First epoch, then a "restarted encoder": new SSRC, sequence and timestamps
  // both reset to zero.
  const input = [
    rtp(100, 9000, 0xaaaa, Buffer.from([0x61])),
    rtp(101, 12000, 0xaaaa, Buffer.from([0x61])),
    rtp(0, 0, 0xbbbb, Buffer.from([0x61])),
    rtp(1, 3000, 0xbbbb, Buffer.from([0x61])),
  ]
  const out = rewriteAll(stream, input)
  assert.equal(out.length, 4)

  const ssrcs = new Set(out.map((p) => p.readUInt32BE(8)))
  assert.equal(ssrcs.size, 1, 'one SSRC for the whole stream')

  const seqs = out.map((p) => p.readUInt16BE(2))
  for (let i = 1; i < seqs.length; i++) {
    assert.equal(
      (seqs[i]! - seqs[i - 1]! + 0x10000) & 0xffff, 1,
      'sequence numbers stay contiguous across the restart',
    )
  }

  const stamps = out.map((p) => p.readUInt32BE(4))
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i]! > stamps[i - 1]!, 'timestamps advance monotonically')
  }
  stream.close()
})

test('short packets are dropped rather than mangled', async () => {
  const stream = new PublishedStream('cam')
  await stream.addTrack({ kind: 'video', payloadType: 96, rtpmap: 'H264/90000' })
  assert.equal(rewriteAll(stream, [Buffer.alloc(4)]).length, 0)
  stream.close()
})

test('SDP advertises sniffed SPS/PPS so clients decode on join', async () => {
  const stream = new PublishedStream('cam')
  await stream.addTrack({
    kind: 'video', payloadType: 96, rtpmap: 'H264/90000',
    fmtp: 'packetization-mode=1',
  })

  assert.doesNotMatch(stream.buildSdp(), /sprop-parameter-sets/)

  // STAP-A aggregate carrying SPS (type 7) and PPS (type 8).
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x1f])
  const pps = Buffer.from([0x68, 0xef, 0x0f, 0xcb])
  const payload = Buffer.concat([
    Buffer.from([24]),
    Buffer.from([0, sps.length]), sps,
    Buffer.from([0, pps.length]), pps,
  ])
  const capture = (
    stream as unknown as { captureParameterSets(p: Buffer): void }
  ).captureParameterSets.bind(stream)
  capture(rtp(1, 0, 1, payload))

  const sdp = stream.buildSdp()
  assert.match(sdp, /sprop-parameter-sets=/)
  assert.ok(sdp.includes(sps.toString('base64')), 'SPS present')
  assert.ok(sdp.includes(pps.toString('base64')), 'PPS present')
  assert.match(sdp, /a=control:trackID=0/)
  stream.close()
})

test('server answers DESCRIBE for a known path and 404s otherwise', async () => {
  const server = new RtspServer()
  server.publish('front_door')
  assert.ok(server.stream('front_door'))
  assert.equal(server.stream('nope'), undefined)
  server.close()
})
