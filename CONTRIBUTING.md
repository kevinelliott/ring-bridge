# Contributing

Thanks for looking. This is a small project with a clear scope: take Ring's live view
and serve it as RTSP that an NVR can rely on.

## Getting set up

```sh
git clone https://github.com/kevinelliott/ring-bridge.git
cd ring-bridge
npm install
npx tsx cli.ts login      # writes a refresh token to .env
npx tsx cli.ts doctor     # checks ffmpeg, ports, encoder, CPU
```

Run from source with `npm run bridge -- --port 8554`. Nothing is compiled during
development; `tsx` runs the TypeScript directly.

## Before opening a pull request

```sh
npm run typecheck
npm test
npm run build
```

CI runs all three plus a Docker build. If `npm run build` fails, the published package
would be broken, so it is not optional.

## What gets merged easily

- **NVR recipes.** The most useful contribution. If you got ring-bridge working with
  something not in [docs/nvr-recipes.md](docs/nvr-recipes.md), send the config that
  worked and how you found it. Say which version you tested against.
- **Bug fixes with a test.** Especially in the RTSP server, the frame clock, or config
  handling — those are where a silent regression is expensive.
- **Documentation corrections.** Several recipes were written from documentation rather
  than a running system; corrections from people actually running them are welcome.

## What needs discussion first

- Anything that changes the RTSP wire format or the SDP.
- New runtime dependencies. The project deliberately has few: `ring-client-api`, `mqtt`,
  and ffmpeg as an external binary.
- Features that need Ring API surface the library does not already expose.

Open an issue before writing the code for those.

## House style

Match what is there. A few things that are deliberate:

- **Comments say why, not what.** The code says what it does. Comments exist for the
  non-obvious: why backpressure is measured by queue depth rather than `write()`'s
  return value, why the RTP headers are rewritten, why audio rides the frame clock.
- **No abbreviations in names.** `continuousPublisher`, not `contPub`.
- **Failures are sentences.** A user hitting an error should be told what to do about it,
  not handed a stack trace.
- **Verify against a real camera** where you can. Much of this only misbehaves against
  the real Ring API, on real timings.

## Testing without a Ring account

Most of the code is testable without one — the config layer, RTP rewriting, the frame
clock, the spinner, the auth gate. Those tests run in CI with no credentials. Anything
needing a live camera has to be verified by hand; say so in the pull request rather than
implying it was tested.

## Reporting security issues

For anything exploitable, email the maintainer rather than opening a public issue.
