# ring-bridge

Turn Ring cameras into a stable RTSP stream for Frigate and other NVRs — with a stream
that never drops, even while Ring is reconnecting.

![Ring Bridge dashboard](docs/dashboard.png)

## Why this exists

Ring has no RTSP endpoint. Live view is a WebRTC call that Ring's servers tear down after
about twelve minutes, and a camera can be unreachable for much longer. Publish that
straight to RTSP and your NVR loses the stream every few minutes.

ring-bridge serves RTSP from its own process and feeds it with a fixed-rate frame clock:

- **Ring is up** → live video and audio pass through.
- **Ring is down** → the last frame it saw, dimmed, with an animated spinner on top.
- **Ring comes back** → live video takes over mid-stream.

The RTSP session is never torn down, so clients see one continuous feed and never
reconnect. It also runs its own RTSP server, so there is no MediaMTX or go2rtc to install.

## Requirements

- Node.js 22 or newer
- `ffmpeg` on your `PATH`
- A Ring account with at least one camera

## Setup

**1. Install**

```sh
git clone https://github.com/kevinelliott/ring-bridge.git
cd ring-bridge
npm install
```

**2. Get a Ring refresh token**

```sh
npx -p ring-client-api ring-auth-cli
```

It asks for your Ring email, password, and 2FA code, then prints a token.

**3. Save it**

```sh
cp .env.example .env
# paste the token into RING_REFRESH_TOKEN
```

Ring rotates this token and invalidates the old one, so the bridge writes each new value
back to `.env` automatically. Keep the file writable and never commit it.

**4. Check your machine and account**

```sh
npx ring-bridge doctor
```

```
  ✔  node               v22.20.0
  ✔  ffmpeg             found, version 9.0.1
  ✔  rtsp port          0.0.0.0:8554 is free
  ✔  ring token         valid — 1 location(s), 2 camera(s)
  ✔  encoder            "libx264" works
  !  hardware encoding  Apple VideoToolbox is available — "--encoder h264_videotoolbox" would cut CPU sharply
  ✔  cpu                12 cores for ~2 camera(s)
```

**5. Check your cameras**

```sh
npx ring-bridge list
```

```
Ring locations (1)

Home  (abc123-xyz) — 2 cameras
  ├─ Front Door  Doorbell Elite  wired  online
  └─ Backyard    Floodlight Cam  wired  offline
```

**6. Run the bridge**

```sh
npx ring-bridge run
```

```
RTSP server listening on 0.0.0.0:8554
[Front Door] publishing to rtsp://<host>:8554/front_door
Admin dashboard on http://0.0.0.0:8080
[Front Door] Ring live, taking over output
```

Each camera is served at `rtsp://<host>:8554/<camera_name_slugified>` — `Front Door`
becomes `front_door`. Verify with any RTSP client:

```sh
ffplay -rtsp_transport tcp rtsp://localhost:8554/front_door
```

## Commands

| Command | What it does |
| --- | --- |
| `ring-bridge run` | Run the bridge (the default if you give no command) |
| `ring-bridge list [--json]` | List locations and cameras |
| `ring-bridge test [name]` | Dial one camera and report exactly what Ring sends |
| `ring-bridge doctor` | Check ffmpeg, ports, token, encoder, and CPU headroom |
| `ring-bridge encoders` | Show the best available video encoder |

`ring-bridge test` is the fastest way to answer "is the quality problem mine or Ring's":

```
$ npx ring-bridge test "Front Door" -n 8

What Ring actually sends:
  resolution   1920x1080
  frame rate   20/1
  video codec  h264
  bitrate      2.65 Mbps
  audio        aac @ 48000 Hz
```

## Connect it to your NVR

### Frigate

Add each camera to your `config.yml`:

```yaml
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://<bridge-host>:8554/front_door
          input_args: preset-rtsp-generic
          roles: [detect, record, audio]
    detect:
      width: 1920
      height: 1080
      fps: 5
```

Notes:

- Use the machine's LAN IP for `<bridge-host>`. If Frigate runs in Docker on the same
  host, `host.docker.internal` works on Docker Desktop; on Linux use the host IP.
- Keep `detect.fps` low. 5 is plenty — the bridge delivers 20.
- Start order does not matter. Because the stream is always up, Frigate connecting before
  Ring is reachable gets the placeholder rather than a refused connection.
- Drop `audio` from `roles` if you run with `--no-audio`.

### Other NVRs

The output is standard RTSP (H.264 + AAC) over TCP or UDP, so anything that accepts an
RTSP URL should work — Blue Iris, Scrypted, Shinobi, ZoneMinder, go2rtc. Recipes for
those are coming; open an issue if you get one working and want it documented.

## On-demand connections

By default a camera is dialed **only while something is watching** — an RTSP client, or a
temporary connection from the dashboard. This matters for three reasons:

- **Battery cameras become usable.** Holding live view open around the clock drains them
  in hours.
- **Less exposure to Ring's rate limits.** There is no documented quota, so less is safer.
- **A readable event history.** Every dial writes an `on_demand` event into Ring's history;
  connecting only on demand stops the bridge from drowning out real events.

When nobody is watching, the stream still exists — it serves the frozen last frame with
the spinner — so your NVR never sees a dead endpoint.

Some feeds need an always-current frame regardless. Force those on per camera:

```json
{
  "cameras": {
    "Front Door": { "alwaysOn": true }
  }
}
```

Or globally with `--always-on`. The dashboard also has a **Connect for 5 min** button per
camera for a temporary look without changing any config.

`idleTimeoutSec` (default 30) keeps Ring connected briefly after the last client leaves,
so a quick reconnect does not pay for a fresh dial.

## Configuration file

Settings live in `ring-bridge.config.json` next to the project, overridable per camera.
The dashboard writes to this file, so anything you tune in the browser survives a restart.
CLI flags override the file for that run only, and are never written back.

```json
{
  "rtspPort": 8554,
  "webPort": 8080,
  "webToken": "change-me",
  "logFile": "/var/log/ring-bridge.log",
  "webhookUrl": "https://example.com/hooks/ring",
  "mqtt": {
    "url": "mqtt://192.168.1.10:1883",
    "username": "homeassistant",
    "password": "secret",
    "topicPrefix": "ring-bridge",
    "discoveryPrefix": "homeassistant"
  },
  "defaults": {
    "width": 1920, "height": 1080, "fps": 20,
    "encoder": "libx264", "crf": 21, "preset": "veryfast",
    "audio": true, "onDemand": true, "idleTimeoutSec": 30
  },
  "cameras": {
    "Front Door": {
      "alwaysOn": true,
      "substream": { "width": 640, "height": 360, "fps": 5, "crf": 28 }
    },
    "Old Camera": { "enabled": false }
  }
}
```

## Substreams

Frigate detects on a low-resolution stream and records the high-resolution one. Add a
`substream` to any camera and it is published alongside the main stream at
`<path>_sub`, encoded from the same decoded frames — so it costs an encode but not a
second decode, and it is cheaper than making Frigate downscale.

```yaml
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://<bridge-host>:8554/front_door_sub
          roles: [detect]
        - path: rtsp://<bridge-host>:8554/front_door
          roles: [record, audio]
    detect:
      width: 640
      height: 360
      fps: 5
```

## Dashboard

`http://<bridge-host>:8080` — four tabs:

| Tab | What's there |
| --- | --- |
| **Dashboard** | Live MJPEG preview per camera, Ring connection state and why, per-output resolution/measured fps/bitrate/clients, queue health, and a Connect button for on-demand cameras |
| **Ring Events** | Doorbell presses, motion, person detection — live and backfilled from Ring history, with snapshot thumbnails |
| **Logs** | Everything the bridge prints, streamed live, with filtering |
| **Configuration** | Per-camera or global resolution, frame rate, encoder, quality, and always-on — written to the config file |

Applying a configuration change restarts the encoder, and **connected clients keep their
RTSP session** — the server rewrites RTP headers across the restart so the change is
invisible downstream.

`on_demand` events are hidden by default in the Events tab, because every time the bridge
dials Ring it creates one — they are mostly the bridge's own activity, not real events.

### Securing the dashboard


By default the dashboard binds to `0.0.0.0` with **no authentication**, so anyone who can
reach the port can view camera snapshots, logs, and events, and change encoder settings.
The bridge prints a warning at startup when that is the case. Pick one:

```sh
npm run bridge -- --web-token "some-secret"   # require a token for everything
npm run bridge -- --web-bind 127.0.0.1        # local only, reach it over SSH
npm run bridge -- --no-web                    # turn it off entirely
```

With `--web-token` set, **every endpoint** is gated — snapshots and logs included, not
just configuration. The browser stores the token in a `SameSite=Strict` cookie so that
live updates work (`EventSource` cannot send custom headers), but configuration changes
additionally require the token as an `X-Admin-Token` header, which a cross-site request
cannot forge. The token is never accepted from the query string, since URLs end up in
server logs and browser history.

There is no TLS. Put it behind a reverse proxy if it needs to leave your LAN.

## Configuration

All options are CLI flags:

```sh
npm run bridge -- [options]
```

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | `8554` | RTSP listen port |
| `--camera "Name"` | all | Bridge only this camera; repeatable |
| `--size WxH` | `1920x1080` | Output resolution |
| `--fps <n>` | `20` | Output frame rate |
| `--encoder <name>` | `libx264` | Video encoder |
| `--crf <n>` | `21` | Quality, lower is better (libx264/libx265) |
| `--preset <name>` | `veryfast` | x264 preset |
| `--bitrate <kbps>` | — | Target bitrate; overrides `--crf` |
| `--no-audio` | — | Publish video only |
| `--web-port <n>` | `8080` | Dashboard port |
| `--web-bind <addr>` | `0.0.0.0` | Dashboard bind address |
| `--web-token <s>` | — | Require a token for config changes |
| `--no-web` | — | Disable the dashboard |

### Running it as a service

```ini
# /etc/systemd/system/ring-bridge.service
[Unit]
Description=Ring Bridge
After=network-online.target

[Service]
WorkingDirectory=/opt/ring-bridge
ExecStart=/usr/bin/npm run bridge
Restart=always
RestartSec=10
User=ring

[Install]
WantedBy=multi-user.target
```

## Integrations

### Home Assistant (MQTT)

Set `mqtt.url` in the config and the bridge publishes Home Assistant discovery messages,
so motion and doorbell entities appear on their own — no YAML. Availability is a retained
last-will topic, so entities show as unavailable if the bridge stops rather than going
quietly stale.

```
ring-bridge/status                 online | offline   (retained)
ring-bridge/<camera>/motion        ON | OFF           (retained)
ring-bridge/<camera>/ding          ON | OFF           (retained)
ring-bridge/<camera>/event         JSON payload
```

Ring reports a trigger rather than a duration, so sensors release themselves 30 seconds
after firing.

### Webhooks

Set `webhookUrl` to POST every Ring event as JSON. Failures are logged and dropped rather
than retried — a queue of stale doorbell presses helps nobody.

```json
{ "camera": "Front Door", "kind": "motion", "at": "2026-08-24T21:15:02.000Z",
  "personDetected": true, "source": "push" }
```

### Prometheus

`GET /metrics` on the dashboard port, in the standard text format:

```
ring_bridge_camera_live{camera="Front Door"} 1
ring_bridge_camera_connected{camera="Front Door"} 1
ring_bridge_camera_clients{camera="Front Door"} 2
ring_bridge_camera_dropped_frames_total{camera="Front Door"} 0
ring_bridge_camera_peak_queued_frames{camera="Front Door"} 8
ring_bridge_output_fps{camera="Front Door",output="sub"} 4.9
```

### Two-way audio

POST an audio file to play it through a doorbell's speaker. An on-demand camera is woken
first, so this works even when it is idle.

```sh
curl -X POST --data-binary @message.wav \
  -H "x-admin-token: $TOKEN" \
  http://<bridge-host>:8080/api/talk/front_door
```

## Docker

```sh
cp .env.example .env      # add your token
mkdir -p config
docker compose up -d
```

Host networking is used so RTP needs no port juggling and NVRs reach the stream at the
host's address. The config file lives in `./config`, so dashboard changes survive a
rebuild. Uncomment the `devices` block for Intel Quick Sync or VA-API.

## Resolution and quality

**Ring's stream is the ceiling.** A Doorbell Elite sends 1920x1080 H.264 at 20fps, around
2.3 Mbps, and its live-view preset is already set to `highest`. There is no
higher-resolution source to request, and `--size` larger than the camera's native
resolution just upscales.

Lowering `--crf` below about 20 mostly spends bandwidth reproducing Ring's own compression
artifacts — measured SSIM barely moves while bitrate climbs 50%.

CPU is the real cost. Mixing live video with the placeholder requires decoding and
re-encoding, so budget roughly one modern core per 1080p20 camera at
`libx264 -preset veryfast`. To reduce it:

```sh
ring-bridge run --encoder auto     # detect and use hardware encoding
ring-bridge run --fps 10           # halve the frame rate
ring-bridge run --size 1280x720    # smaller output
```

`--encoder auto` probes for VideoToolbox, NVENC, Quick Sync, VA-API, and V4L2 M2M by
running a real test encode, so it never selects one that is present but non-functional.
`ring-bridge encoders` shows what it found. Hardware encoders ignore `--crf`, so pass
`--bitrate` with them.

## Troubleshooting

**`Missing RING_REFRESH_TOKEN`** — `.env` is missing or empty. See Setup step 3.

**401 / auth errors on startup** — the token expired or was invalidated. Generate a new
one with `ring-auth-cli`. This should not happen while the bridge is running, since it
persists rotated tokens automatically.

**Stream connects but shows only the spinner** — Ring is not reachable for that camera.
Check the Logs tab; `Ring stream error` lines show why. Cameras that report `offline` in
`npm start` may still stream intermittently.

**Dropped frames climbing** — the encoder cannot keep up. Check `Peak queue` on the camera
card; if it sits at the ceiling, lower `--fps` or `--size`, or use a hardware encoder.
In steady state dropped frames should read `0`.

**Colors look washed out** — should not happen; the encoder tags BT.709 limited range
explicitly. Verify what your client resolved:

```sh
ffprobe -rtsp_transport tcp -show_entries stream=color_range,color_space \
  rtsp://<bridge-host>:8554/front_door
```

**More detail** — run with `DEBUG=ring` to see the library's internals and full ffmpeg
stderr.

## Things worth knowing

- **Continuous streaming is not what Ring's live view is designed for.** Wired cameras are
  fine, but battery models will drain quickly — this is not a good fit for those.
- Ring may rate-limit sustained live-view usage. There is no documented quota.
- Every reconnect appears in your Ring event history as an `on_demand` event.
- Audio is resampled to 16 kHz mono AAC, which is what Frigate's audio detection expects.

## Known advisory: `ip` (GHSA-2p57-rm9w-gvfp)

`npm audit` reports a high-severity SSRF advisory against the `ip` package. It arrives
transitively as `ring-client-api → werift → ip`, and there is no patched version — the
package is unmaintained, and the only `npm audit fix` is a downgrade to
`ring-client-api@9.13.0`, which is a breaking change.

The advisory is specifically about `ip.isPublic()` misclassifying addresses. That
function is never called anywhere in this dependency tree; werift uses only
`ip.toString`, `ip.toBuffer`, `ip.isV4Format` and `ip.isLoopback`, for STUN attribute
encoding and ICE candidate handling. Verify it yourself:

```sh
grep -rn "\.isPublic(" node_modules/werift node_modules/ring-client-api   # no hits
```

So the alert stays open until upstream drops the dependency, but the vulnerable code path
is not reachable from here.

## How it works

```
Ring (WebRTC) ──ffmpeg decode──▶ raw frames ──┐
                                              ├──▶ frame clock ──▶ encoder ──▶ RTSP server
       last frame + spinner (during outage) ──┘
```

A fixed-rate clock drives the output, decoupling it from Ring's availability. Audio rides
the same clock — every tick writes one video frame and exactly `16000 / fps` samples — so
A/V stays in sync by construction rather than by timer accuracy.

The RTSP server rewrites RTP sequence numbers, timestamps, and SSRC, giving the stream one
continuous identity no matter how many times the encoder restarts underneath. It also
sniffs H.264 SPS/PPS off the wire and advertises them as `sprop-parameter-sets`, so a
client joining mid-GOP decodes immediately.

| File | Role |
| --- | --- |
| `frigate-bridge.ts` | Entry point, Ring supervision, wiring |
| `rtsp-server.ts` | RTSP server: RTP fan-out, SDP, header rewriting |
| `continuous-publisher.ts` | Frame clock, encoder lifecycle, A/V mixing |
| `spinner.ts` | Placeholder compositing in yuv420p |
| `ring-auth.ts` | Token loading and rotation persistence |
| `ring-events.ts` | Ring event collection |
| `admin-server.ts` | Dashboard HTTP API and SSE |
| `log-bus.ts` | Console capture for the dashboard |
| `ring.ts` | Standalone camera lister |

## Development

```sh
npm run typecheck
npm test
```

Tests cover the parts where a silent regression would be expensive: config merging and
validation, RTP header rewriting across an encoder restart, SPS/PPS sniffing, the
on-demand state machine, the `.env` token rewrite, and the placeholder compositor.

Built on [ring-client-api](https://github.com/dgreif/ring). Not affiliated with Ring or
Amazon.
