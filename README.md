# ring-bridge

[![CI](https://github.com/kevinelliott/ring-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinelliott/ring-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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
npm install -g ring-bridge
```

Or run it without installing:

```sh
npx ring-bridge --help
```

Or from source, if you want to hack on it:

```sh
git clone https://github.com/kevinelliott/ring-bridge.git
cd ring-bridge
npm install
```

**2. Log in to Ring**

```sh
npx ring-bridge login
```

It asks for your email, password, and the verification code Ring sends, then writes a
refresh token to `.env` for you.

Your password is used once to obtain that token and is never stored. Ring rotates the
token on every refresh and invalidates the old one, so the bridge writes each new value
back to `.env` automatically — this should be a one-time step. Keep the file writable and
never commit it.

You can also sign in from the dashboard, under **Configuration → Ring account**.

**3. Check your machine and account**

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

**4. Check your cameras**

```sh
npx ring-bridge list
```

```
Ring locations (1)

Home  (abc123-xyz) — 2 cameras
  ├─ Front Door  Doorbell Elite  wired  online
  └─ Backyard    Floodlight Cam  wired  offline
```

**5. Run the bridge**

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
| `ring-bridge login` | Log in to Ring and save a refresh token to `.env` |
| `ring-bridge run` | Run the bridge (the default if you give no command) |
| `ring-bridge list [--json]` | List locations and cameras |
| `ring-bridge test [name]` | Dial one camera and report exactly what Ring sends (`-n` seconds, `--keep <path>` to save the clip) |
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

The output is standard RTSP (H.264 + AAC), so anything that accepts an RTSP URL works.
**[docs/nvr-recipes.md](docs/nvr-recipes.md)** has copy-paste configuration for:

go2rtc · Home Assistant · Scrypted · Blue Iris · Shinobi · ZoneMinder ·
Synology Surveillance Station · MediaMTX · VLC and ffplay

Got another one working? Open an issue with the config and it will be added.

## When the token goes stale

Ring can invalidate a refresh token — a password change, a revoked session, or a long
enough outage. That failure never recovers on its own, so the bridge treats it as its own
condition rather than as an endless reconnect loop:

- **At startup** the CLI stops with `Ring rejected the stored refresh token. Run
  ring-bridge login to sign in again.`
- **While running** streams keep serving the placeholder, the log says what happened, and
  the dashboard shows a red banner linking to the sign-in form.

Signing in again from the dashboard writes the new token and, if you leave *restart the
bridge after signing in* ticked, exits cleanly so your process supervisor brings it back
with the new credentials. Under systemd (`Restart=always`) or Docker
(`restart: unless-stopped`) that is seamless; otherwise start it again yourself.

The bridge distinguishes a dead token from an unreachable camera or a network blip, so it
only asks you to log in when logging in is actually the fix.

### A note on the dashboard login

The sign-in form sends your Ring password to the bridge over **plain HTTP**. On a trusted
LAN that is usually fine, but if it is not:

- Use `ring-bridge login` on the machine itself, over SSH.
- Or reach the dashboard through an HTTPS reverse proxy.

The login endpoints always require the admin token as a header, so they are never
reachable by a cross-site request even when a browser has a session cookie.

## Push notifications and your phone

**If the Ring app and chime stopped announcing events while the bridge was running, this
is why — and it is fixed by default now.**

`ring-client-api` registers a Firebase push receiver as a side effect of listing
locations, using the Ring *Android app's* credentials, then attaches the token to your
account's device record. Ring
[limits how many devices may be registered for push](https://github.com/dgreif/ring/wiki/Notification-Troubleshooting),
so adding another one can displace an existing registration — and the casualty can be
your phone or your chime.

The bridge therefore **does not register for push by default.** Streaming is completely
unaffected: video, audio, and reconnects all work without it. Only *live* event delivery
changes — the dashboard, MQTT, and webhooks are fed by polling Ring's event history
(`eventPollSec`, default 60s) instead of arriving instantly.

If you would rather have instant events and do not rely on the phone app:

```sh
ring-bridge run --push-notifications
```

### Recovering notifications

Disabling push here stops the bridge *taking* a registration, but it does not undo one
already made — Ring keeps the device record, and disconnecting does not remove it. To
clean up:

1. Ring app → **Control Center → Authorized Client Devices**
2. Delete the entries named `ring-client-api` (they appear as Android devices)
3. Sign out and back in on your phone if notifications do not return

While you are there, removing other stale entries is worth doing; a crowded device list
is what makes the limit bite.

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
  "pushNotifications": false,
  "eventPollSec": 60,
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

For HTTPS, point it at a certificate:

```sh
ring-bridge run --tls-cert /path/cert.pem --tls-key /path/key.pem
```

That matters mainly because the dashboard's Ring sign-in form carries a password. A
reverse proxy in front works equally well.

### ONVIF discovery

NVRs that discover cameras rather than accepting a URL — Synology Surveillance Station,
Blue Iris — can find the bridge if you enable ONVIF:

```sh
ring-bridge run --onvif-port 8081 --public-snapshots
```

Each camera is advertised as a profile, with a second profile for its substream.
Discovery is multicast, so the bridge must share a network with the NVR;
[docs/nvr-recipes.md](docs/nvr-recipes.md) has the details and the manual fallback.

### Still images

Some NVRs and integrations want a snapshot URL rather than a stream:

```sh
ring-bridge run --public-snapshots
# http://<bridge-host>:8080/snapshot/front_door.jpg
```

This endpoint sits deliberately outside the admin token, which is why it is off by
default — anyone who can reach the port can fetch a current camera image.

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
| `--web-token <s>` | — | Require a token for the dashboard |
| `--no-web` | — | Disable the dashboard |
| `--tls-cert <path>` | — | Serve the dashboard over HTTPS (with `--tls-key`) |
| `--tls-key <path>` | — | Private key for `--tls-cert` |
| `--public-snapshots` | off | Serve `/snapshot/<camera>.jpg` without the admin token |
| `--onvif-port <n>` | off | Enable ONVIF discovery on this port |
| `--push-notifications` | off | Register for Ring push; can displace your phone's registration |
| `--always-on` | — | Keep Ring connected even with no clients |
| `--no-on-demand` | — | Same as `--always-on` |
| `--idle-timeout <s>` | `30` | Seconds to hold Ring after the last client leaves |
| `--config <path>` | `./ring-bridge.config.json` | Config file |

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

## The `ip` advisory (GHSA-2p57-rm9w-gvfp)

**Resolved.** `npm audit` used to report a high-severity SSRF advisory against the `ip`
package, reached transitively as `ring-client-api → werift → ip`.

werift 0.24.4 dropped the dependency entirely, but `ring-client-api` still pins werift to
`0.22.4`, so the fix does not arrive on its own. This project therefore carries an
override:

```json
"overrides": { "werift": "0.24.4" }
```

`npm audit` now reports zero vulnerabilities and `ip` is not in the tree at all.

Two things worth knowing if you are evaluating this:

- The advisory was never reachable here even before the override. It concerns
  `ip.isPublic()`, which is not called anywhere in this dependency tree — werift used
  only `toString`, `toBuffer`, `isV4Format` and `isLoopback`, for STUN attribute encoding
  and ICE candidates.
- The override moves the WebRTC stack two minor versions ahead of what
  `ring-client-api` pins. It was verified against live cameras — video, audio, and
  reconnects across a Ring session timeout — but that is one network and two camera
  models. If you see streaming problems, drop the `overrides` block and reinstall; the
  advisory returns but remains unreachable.

The durable fix is upstream in `ring-client-api`.

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

## Releasing

```sh
npm version patch      # or minor / major
git push --follow-tags
```

Tagging `v*` runs the checks, cuts a GitHub release, and publishes to npm if an
`NPM_TOKEN` repository secret is set. To publish by hand instead:

```sh
npm login
npm publish --access public
```

`prepack` builds first either way, so a stale `dist/` cannot be published.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). NVR recipes are the most useful contribution —
there is an issue template for them.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # compile to dist/, which is what gets published
```

From a source checkout the commands run through `tsx`:

```sh
npm run bridge -- --port 8554
npm run list
```

Files that hold your data — `.env` and `ring-bridge.config.json` — resolve against the
working directory, not the install location, so a globally installed copy reads whichever
directory you run it from. `RING_ENV_FILE` overrides where the token is kept.

Tests cover the parts where a silent regression would be expensive: config merging and
validation, RTP header rewriting across an encoder restart, SPS/PPS sniffing, the
on-demand state machine, the `.env` token rewrite, and the placeholder compositor.

Built on [ring-client-api](https://github.com/dgreif/ring). Not affiliated with Ring or
Amazon.
