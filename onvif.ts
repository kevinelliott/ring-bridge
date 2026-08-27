/**
 * A minimal ONVIF Profile S device, enough to be discovered and added.
 *
 * Synology Surveillance Station and Blue Iris both prefer ONVIF: without it they
 * need a hand-typed RTSP path and a "User Define" camera entry, and neither can
 * find the bridge on its own. This implements the small slice they actually
 * use -- WS-Discovery so the bridge appears in a network scan, then the device
 * and media services needed to enumerate profiles and resolve a stream URI.
 *
 * It is deliberately not a full ONVIF stack: no PTZ, no events, no imaging, no
 * authentication. Everything is read-only, and the RTSP URIs it hands out are
 * the same ones the dashboard shows.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createSocket, type Socket } from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'

const WS_DISCOVERY_ADDRESS = '239.255.255.250'
const WS_DISCOVERY_PORT = 3702

export interface OnvifCamera {
  name: string
  /** RTSP path, without a leading slash. */
  path: string
  width: number
  height: number
  fps: number
  substreamPath?: string
  substreamWidth?: number
  substreamHeight?: number
  substreamFps?: number
}

export interface OnvifOptions {
  /** Port for the ONVIF SOAP services. */
  port: number
  rtspPort: number
  /** Port serving /snapshot/<camera>.jpg, when public snapshots are enabled. */
  snapshotPort?: number
  cameras: () => OnvifCamera[]
}

/** First non-internal IPv4 address, which is what a discovering NVR can reach. */
export function primaryAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address
      }
    }
  }
  return '127.0.0.1'
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Stable, URL-safe profile token for a camera path. */
function profileToken(path: string, kind: 'main' | 'sub'): string {
  return `${path}_${kind}`
}

const ENVELOPE_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
  'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
  'xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>'
const ENVELOPE_CLOSE = '</s:Body></s:Envelope>'

export class OnvifService {
  private readonly options: OnvifOptions
  private readonly uuid = randomUUID()
  private http?: ReturnType<typeof createServer>
  private discovery?: Socket
  private address = '127.0.0.1'

  constructor(options: OnvifOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    this.address = primaryAddress()
    await this.startHttp()
    await this.startDiscovery()
    console.log(
      `ONVIF device on http://${this.address}:${this.options.port}/onvif/device_service`,
    )
  }

  stop(): void {
    this.http?.close()
    try {
      this.discovery?.close()
    } catch {
      // Already closed.
    }
  }

  private get xaddr(): string {
    return `http://${this.address}:${this.options.port}/onvif/device_service`
  }

  private startHttp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res))
      this.http = server
      server.once('error', reject)
      server.listen(this.options.port, '0.0.0.0', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /**
   * WS-Discovery: NVRs multicast a Probe, and a device answers with where its
   * services live. This is the part that makes the bridge show up in a scan
   * rather than needing its address typed in.
   */
  private startDiscovery(): Promise<void> {
    return new Promise((resolve) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      this.discovery = socket

      socket.on('message', (message, remote) => {
        const text = message.toString()
        if (!text.includes('Probe')) {
          return
        }
        // Echo the probe's MessageID as RelatesTo, or the responder is ignored.
        const messageId = /<[^>]*MessageID>([^<]+)</.exec(text)?.[1] ?? ''
        const reply = this.probeMatch(messageId)
        socket.send(reply, remote.port, remote.address)
      })

      socket.on('error', (error) => {
        console.error(`[onvif] discovery: ${String(error)}`)
      })

      socket.bind(WS_DISCOVERY_PORT, () => {
        try {
          socket.addMembership(WS_DISCOVERY_ADDRESS)
        } catch (error) {
          // Multicast is often unavailable in containers without host
          // networking; the SOAP services still work when added by hand.
          console.warn(
            `[onvif] discovery unavailable (${String(error)}); ` +
              'add the device by address instead',
          )
        }
        resolve()
      })
    })
  }

  private probeMatch(relatesTo: string): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
      'xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
      'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
      'xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><s:Header>' +
      '<a:MessageID>urn:uuid:' + randomUUID() + '</a:MessageID>' +
      '<a:RelatesTo>' + escapeXml(relatesTo) + '</a:RelatesTo>' +
      '<a:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To>' +
      '<a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action>' +
      '</s:Header><s:Body><d:ProbeMatches><d:ProbeMatch>' +
      '<a:EndpointReference><a:Address>urn:uuid:' + this.uuid + '</a:Address></a:EndpointReference>' +
      '<d:Types>dn:NetworkVideoTransmitter</d:Types>' +
      '<d:Scopes>onvif://www.onvif.org/type/video_encoder ' +
      'onvif://www.onvif.org/Profile/Streaming ' +
      'onvif://www.onvif.org/name/ring-bridge ' +
      'onvif://www.onvif.org/hardware/ring-bridge</d:Scopes>' +
      '<d:XAddrs>' + this.xaddr + '</d:XAddrs>' +
      '<d:MetadataVersion>1</d:MetadataVersion>' +
      '</d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>'
    )
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      // SOAP requests here are tiny; anything large is not a real client.
      if (body.length > 64 * 1024) {
        req.destroy()
      }
    })
    req.on('end', () => {
      const reply = this.respond(body)
      res.writeHead(200, {
        'content-type': 'application/soap+xml; charset=utf-8',
        'content-length': Buffer.byteLength(reply),
      })
      res.end(reply)
    })
  }

  /** Dispatch on the SOAP action, which for ONVIF is the body's first element. */
  private respond(body: string): string {
    const wrap = (inner: string): string => ENVELOPE_OPEN + inner + ENVELOPE_CLOSE

    if (body.includes('GetSystemDateAndTime')) {
      const now = new Date()
      return wrap(
        '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>' +
        '<tt:DateTimeType>Manual</tt:DateTimeType>' +
        '<tt:DaylightSavings>false</tt:DaylightSavings>' +
        '<tt:UTCDateTime><tt:Time>' +
        `<tt:Hour>${now.getUTCHours()}</tt:Hour>` +
        `<tt:Minute>${now.getUTCMinutes()}</tt:Minute>` +
        `<tt:Second>${now.getUTCSeconds()}</tt:Second>` +
        '</tt:Time><tt:Date>' +
        `<tt:Year>${now.getUTCFullYear()}</tt:Year>` +
        `<tt:Month>${now.getUTCMonth() + 1}</tt:Month>` +
        `<tt:Day>${now.getUTCDate()}</tt:Day>` +
        '</tt:Date></tt:UTCDateTime>' +
        '</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
      )
    }

    if (body.includes('GetDeviceInformation')) {
      return wrap(
        '<tds:GetDeviceInformationResponse>' +
        '<tds:Manufacturer>ring-bridge</tds:Manufacturer>' +
        '<tds:Model>Ring Bridge</tds:Model>' +
        '<tds:FirmwareVersion>1.0</tds:FirmwareVersion>' +
        `<tds:SerialNumber>${this.uuid}</tds:SerialNumber>` +
        '<tds:HardwareId>ring-bridge</tds:HardwareId>' +
        '</tds:GetDeviceInformationResponse>',
      )
    }

    if (body.includes('GetCapabilities')) {
      return wrap(
        '<tds:GetCapabilitiesResponse><tds:Capabilities>' +
        `<tt:Device><tt:XAddr>${this.xaddr}</tt:XAddr></tt:Device>` +
        `<tt:Media><tt:XAddr>${this.mediaXaddr}</tt:XAddr>` +
        '<tt:StreamingCapabilities>' +
        '<tt:RTPMulticast>false</tt:RTPMulticast>' +
        '<tt:RTP_TCP>true</tt:RTP_TCP>' +
        '<tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP>' +
        '</tt:StreamingCapabilities></tt:Media>' +
        '</tds:Capabilities></tds:GetCapabilitiesResponse>',
      )
    }

    if (body.includes('GetServices')) {
      return wrap(
        '<tds:GetServicesResponse>' +
        '<tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace>' +
        `<tds:XAddr>${this.xaddr}</tds:XAddr>` +
        '<tds:Version><tt:Major>2</tt:Major><tt:Minor>5</tt:Minor></tds:Version></tds:Service>' +
        '<tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>' +
        `<tds:XAddr>${this.mediaXaddr}</tds:XAddr>` +
        '<tds:Version><tt:Major>2</tt:Major><tt:Minor>5</tt:Minor></tds:Version></tds:Service>' +
        '</tds:GetServicesResponse>',
      )
    }

    if (body.includes('GetVideoSources')) {
      return wrap(
        '<trt:GetVideoSourcesResponse>' +
        this.options.cameras().map((camera) =>
          `<trt:VideoSources token="${escapeXml(camera.path)}">` +
          `<tt:Framerate>${camera.fps}</tt:Framerate>` +
          `<tt:Resolution><tt:Width>${camera.width}</tt:Width>` +
          `<tt:Height>${camera.height}</tt:Height></tt:Resolution>` +
          '</trt:VideoSources>',
        ).join('') +
        '</trt:GetVideoSourcesResponse>',
      )
    }

    if (body.includes('GetVideoSourceConfigurations')) {
      return wrap(
        '<trt:GetVideoSourceConfigurationsResponse>' +
        this.options.cameras().map((camera) =>
          `<trt:Configurations token="${escapeXml(camera.path)}_src">` +
          `<tt:Name>${escapeXml(camera.name)}</tt:Name>` +
          '<tt:UseCount>1</tt:UseCount>' +
          `<tt:SourceToken>${escapeXml(camera.path)}</tt:SourceToken>` +
          `<tt:Bounds x="0" y="0" width="${camera.width}" height="${camera.height}"></tt:Bounds>` +
          '</trt:Configurations>',
        ).join('') +
        '</trt:GetVideoSourceConfigurationsResponse>',
      )
    }

    if (body.includes('GetProfiles')) {
      return wrap(
        '<trt:GetProfilesResponse>' +
        this.profiles().map((p) => this.profileXml(p, 'trt:Profiles')).join('') +
        '</trt:GetProfilesResponse>',
      )
    }

    if (body.includes('GetStreamUri')) {
      const token = /<[^>]*ProfileToken>([^<]+)</.exec(body)?.[1] ?? ''
      const profile = this.profiles().find((p) => p.token === token) ?? this.profiles()[0]
      const uri = profile
        ? `rtsp://${this.address}:${this.options.rtspPort}/${profile.path}`
        : ''
      return wrap(
        '<trt:GetStreamUriResponse><trt:MediaUri>' +
        `<tt:Uri>${escapeXml(uri)}</tt:Uri>` +
        '<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>' +
        '<tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>' +
        '<tt:Timeout>PT0S</tt:Timeout>' +
        '</trt:MediaUri></trt:GetStreamUriResponse>',
      )
    }

    if (body.includes('GetSnapshotUri')) {
      const token = /<[^>]*ProfileToken>([^<]+)</.exec(body)?.[1] ?? ''
      const profile = this.profiles().find((p) => p.token === token) ?? this.profiles()[0]
      const uri = this.options.snapshotPort && profile
        ? `http://${this.address}:${this.options.snapshotPort}/snapshot/${profile.cameraPath}.jpg`
        : ''
      return wrap(
        '<trt:GetSnapshotUriResponse><trt:MediaUri>' +
        `<tt:Uri>${escapeXml(uri)}</tt:Uri>` +
        '<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>' +
        '<tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>' +
        '<tt:Timeout>PT0S</tt:Timeout>' +
        '</trt:MediaUri></trt:GetSnapshotUriResponse>',
      )
    }

    // Anything unimplemented gets a proper SOAP fault rather than silence, so a
    // client reports it clearly instead of hanging.
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault>' +
      '<s:Code><s:Value>s:Receiver</s:Value></s:Code>' +
      '<s:Reason><s:Text xml:lang="en">Action not implemented</s:Text></s:Reason>' +
      '</s:Fault></s:Body></s:Envelope>'
    )
  }

  private get mediaXaddr(): string {
    return `http://${this.address}:${this.options.port}/onvif/media_service`
  }

  private profiles(): Array<{
    token: string
    name: string
    path: string
    cameraPath: string
    width: number
    height: number
    fps: number
  }> {
    const out = []
    for (const camera of this.options.cameras()) {
      out.push({
        token: profileToken(camera.path, 'main'),
        name: camera.name,
        path: camera.path,
        cameraPath: camera.path,
        width: camera.width,
        height: camera.height,
        fps: camera.fps,
      })
      if (camera.substreamPath) {
        out.push({
          token: profileToken(camera.path, 'sub'),
          name: `${camera.name} (sub)`,
          path: camera.substreamPath,
          cameraPath: camera.path,
          width: camera.substreamWidth ?? 640,
          height: camera.substreamHeight ?? 360,
          fps: camera.substreamFps ?? 5,
        })
      }
    }
    return out
  }

  private profileXml(
    p: {
      token: string; name: string; cameraPath: string
      width: number; height: number; fps: number
    },
    element: string,
  ): string {
    return (
      `<${element} token="${escapeXml(p.token)}" fixed="true">` +
      `<tt:Name>${escapeXml(p.name)}</tt:Name>` +
      // A profile without a VideoSourceConfiguration is rejected by real
      // clients: they resolve the profile back to a video source, and the
      // ONVIF client library reports "Unrecognized configuration" without it.
      `<tt:VideoSourceConfiguration token="${escapeXml(p.cameraPath)}_src">` +
      `<tt:Name>${escapeXml(p.name)}</tt:Name>` +
      '<tt:UseCount>1</tt:UseCount>' +
      `<tt:SourceToken>${escapeXml(p.cameraPath)}</tt:SourceToken>` +
      '<tt:Bounds x="0" y="0" ' +
      `width="${p.width}" height="${p.height}"></tt:Bounds>` +
      '</tt:VideoSourceConfiguration>' +
      `<tt:VideoEncoderConfiguration token="${escapeXml(p.token)}_enc">` +
      `<tt:Name>${escapeXml(p.name)}</tt:Name>` +
      '<tt:UseCount>1</tt:UseCount>' +
      '<tt:Encoding>H264</tt:Encoding>' +
      `<tt:Resolution><tt:Width>${p.width}</tt:Width>` +
      `<tt:Height>${p.height}</tt:Height></tt:Resolution>` +
      '<tt:Quality>4</tt:Quality>' +
      '<tt:RateControl>' +
      `<tt:FrameRateLimit>${p.fps}</tt:FrameRateLimit>` +
      '<tt:EncodingInterval>1</tt:EncodingInterval>' +
      '<tt:BitrateLimit>4096</tt:BitrateLimit>' +
      '</tt:RateControl>' +
      '<tt:H264><tt:GovLength>' + p.fps + '</tt:GovLength>' +
      '<tt:H264Profile>Main</tt:H264Profile></tt:H264>' +
      '<tt:SessionTimeout>PT60S</tt:SessionTimeout>' +
      '</tt:VideoEncoderConfiguration>' +
      `</${element}>`
    )
  }
}
