# NVR recipes

ring-bridge serves ordinary RTSP — H.264 video and AAC audio, over TCP or UDP — so
anything that accepts an RTSP URL should work.

Two URLs per camera:

```
rtsp://<bridge-host>:8554/<camera_slug>        main stream
rtsp://<bridge-host>:8554/<camera_slug>_sub    substream, if configured
```

`Front Door` becomes `front_door`. `ring-bridge list --json` prints the exact
`rtspPath` for every camera.

**Prefer TCP.** RTP over UDP works, but a 1080p keyframe fragments across many
datagrams and a single loss costs the whole frame. Every recipe below asks for TCP.

**Start order does not matter.** Because the stream exists whether or not Ring is
reachable, an NVR that connects first gets the placeholder rather than a refused
connection.

## ONVIF discovery

Some NVRs prefer to find cameras rather than be told about them. Enable ONVIF and the
bridge answers discovery probes and advertises a profile per stream:

```sh
ring-bridge run --onvif-port 8081 --public-snapshots
```

Each camera appears as two profiles when a substream is configured — `<camera>_main` and
`<camera>_sub` — with the right resolution and frame rate on each. `--public-snapshots`
is what lets the bridge advertise a still-image URL alongside the stream; without it the
snapshot URI comes back empty and most NVRs cope, but some complain.

Discovery uses UDP multicast on `239.255.255.250:3702`, which needs the bridge on the
same layer-2 network as the NVR. In Docker that means `network_mode: host` — with bridge
networking the SOAP services still work, but nothing will discover them, so add the
device by address.

This is a deliberately partial implementation: discovery, device information, profiles,
stream and snapshot URIs. No PTZ, events, imaging, or authentication.

---

## Frigate

```yaml
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://<bridge-host>:8554/front_door_sub
          roles: [detect]
        - path: rtsp://<bridge-host>:8554/front_door
          roles: [record, audio]
      input_args: preset-rtsp-generic
    detect:
      width: 640
      height: 360
      fps: 5
    record:
      enabled: true
```

Without a substream, use one input with `roles: [detect, record, audio]` and set
`detect.fps: 5` — the bridge delivers 20, and Frigate does not need them all.

Drop `audio` from `roles` if you run with `--no-audio`.

If Frigate runs in Docker on the same host, `<bridge-host>` is
`host.docker.internal` on Docker Desktop, or the host's LAN IP on Linux.

## go2rtc

Verified against go2rtc 1.9.14: it consumes both streams and re-serves them with video
and audio intact.

```yaml
streams:
  front_door:
    - rtsp://<bridge-host>:8554/front_door
  front_door_sub:
    - rtsp://<bridge-host>:8554/front_door_sub
```

Force TCP if your network is lossy:

```yaml
streams:
  front_door: rtsp://<bridge-host>:8554/front_door#media=video+audio#rtsp_transport=tcp
```

go2rtc then gives you WebRTC and HLS on top, which is a good way to view a Ring camera
in a browser without the Ring app.

## Home Assistant

With go2rtc or Frigate already in play, use their integrations. For a direct connection,
the `generic` camera integration takes an RTSP URL:

**Settings → Devices & Services → Add Integration → Generic Camera**

```
Stream source URL:  rtsp://<bridge-host>:8554/front_door
RTSP transport:     tcp
```

For motion and doorbell entities, point the bridge at your MQTT broker instead — it
publishes Home Assistant discovery messages and the entities appear on their own. See
the MQTT section in the main README.

## Scrypted

1. **Plugins → Install → RTSP Plugin**
2. **Add Device → RTSP Camera**
3. Set the stream URL:

```
rtsp://<bridge-host>:8554/front_door
```

4. Under the camera's **Streams** tab, add the substream as a second stream and mark it
   the *Remote/Low Resolution* stream so detection and remote viewing use it.

Scrypted's HomeKit plugin will then expose the camera to HomeKit, which is one way to
get Ring cameras into Apple Home.

## Blue Iris

**With ONVIF** (run the bridge with `--onvif-port 8081`):

1. **Add new camera → Find/Inspect**, and Blue Iris should discover the bridge.
2. Accept the discovered profiles; the substream is offered as a second profile.

**By hand**, which is equally fine:

1. **Add new camera**, give it a short name.
2. **Video → Network IP**, then set **Media/video path** using the *Custom / RTSP* make:

```
Address:   <bridge-host>
Port:      8554
Path:      /front_door
Protocol:  RTSP over TCP
```

3. Untick **Get ONVIF/PTZ settings** unless you enabled `--onvif-port`.
4. If you configured a substream, set it as the **sub-stream** path (`/front_door_sub`)
   so Blue Iris decodes the small stream for motion detection.

## Shinobi

**Add Monitor**, then:

```
Input Type:        H.264 / H.265 / H.264+AAC
Connection Type:   RTSP
RTSP Transport:    TCP
Full URL:          rtsp://<bridge-host>:8554/front_door
```

Set **Stream Type** to `HLS` or `MJPEG` for the web view, and leave the record mode on
`Record` if you want retention on Shinobi's side.

## ZoneMinder

**Add Monitor**, then on the **Source** tab:

```
Source Type:       FFmpeg
Source Path:       rtsp://<bridge-host>:8554/front_door
Remote Method:     RTP/RTSP over TCP
Target Colorspace: 24 bit colour
Capture Width:     1920
Capture Height:    1080
```

Set **Function** to `Modect` for motion detection or `Record` for continuous capture. On
the **Buffers** tab, an Image Buffer Size of 50–100 is usually enough at 20fps.

## Synology Surveillance Station

**With ONVIF** (run the bridge with `--onvif-port 8081 --public-snapshots`):

1. **Surveillance Station → IP Camera → Add → Quick Setup**, and the bridge should be
   discovered on the local network.
2. If discovery finds nothing — common when Surveillance Station is on a different
   VLAN, since discovery is multicast — use **Add → Manual** with brand **ONVIF** and
   the bridge's address and ONVIF port.

**Without ONVIF**, add it as a generic RTSP device:

1. **Surveillance Station → IP Camera → Add → Manual**
2. Brand: **[User Define]**
3. Fill in:

```
Camera name:   Front Door
IP address:    <bridge-host>
Port:          8554
Source path:   /front_door
Video format:  H.264
Transport:     TCP
```

4. Leave username and password blank — the RTSP server does not require credentials.

Each camera consumes a Surveillance Station licence, so check your seat count first.

## MediaMTX

You do not need MediaMTX — the bridge serves RTSP itself — but if you already run it as a
hub, pull the stream in as a source:

```yaml
paths:
  front_door:
    source: rtsp://<bridge-host>:8554/front_door
    sourceProtocol: tcp
```

## VLC, ffplay, and quick checks

```sh
ffplay -rtsp_transport tcp rtsp://<bridge-host>:8554/front_door
vlc --rtsp-tcp rtsp://<bridge-host>:8554/front_door
ffprobe -rtsp_transport tcp rtsp://<bridge-host>:8554/front_door
```

---

## Troubleshooting

**The NVR connects but shows a spinner.** That is the placeholder: Ring is not currently
connected for that camera. With on-demand enabled, an RTSP client should trigger a dial
within a few seconds — check the dashboard's Ring row, or the logs, for why not.

**Connection refused.** The bridge is not running, or is bound elsewhere. Confirm with
`ffprobe` from the NVR's own host, not just from the bridge machine.

**Video stutters or breaks up.** Almost always UDP on a lossy link. Force TCP.

**My phone stopped getting Ring notifications.** The bridge no longer registers for push
by default, but if it did previously, remove the `ring-client-api` entries under Ring
Control Center → Authorized Client Devices. See the README section on push notifications.

**The NVR reports no audio.** Either the camera is running with `--no-audio`, or the
substream is in use — substreams are video only. Point the audio role at the main stream.

**Something else works?** Open an issue with the config that worked and it will be added
here.
