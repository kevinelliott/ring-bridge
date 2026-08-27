# ffmpeg is not optional here -- it does every decode and encode -- so start
# from a base that has it rather than compiling one in.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Dependencies first so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY *.ts ./
COPY public ./public
RUN npm run build

# Reinstall without dev dependencies: the runtime needs plain JS and the
# production tree only, not TypeScript or tsx.
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# RTSP (TCP for interleaved and control) and the admin dashboard.
EXPOSE 8554 8080

ENV NODE_ENV=production
# Config and the refresh token resolve against the working directory, so mount
# a volume there rather than into the application directory.
WORKDIR /config
VOLUME ["/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["run"]
