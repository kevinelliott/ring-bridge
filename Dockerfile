# ffmpeg is not optional here -- it does every decode and encode -- so start
# from a base that has it rather than compiling one in.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.ts ./
COPY public ./public

# RTSP (TCP for interleaved and control) and the admin dashboard.
EXPOSE 8554 8080

ENV NODE_ENV=production
# The config file lives on a volume so dashboard changes survive a rebuild.
VOLUME ["/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Invoke the installed binary directly: npx would reach for the network if the
# package were ever missing, and this image must start without one.
ENTRYPOINT ["node_modules/.bin/tsx", "cli.ts"]
CMD ["run", "--config", "/config/ring-bridge.config.json"]
