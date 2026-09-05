# syntax=docker/dockerfile:1
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /opt/playtest
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && npm run build:web && npm prune --omit=dev --ignore-scripts

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ARG REVISION
LABEL org.opencontainers.image.revision=$REVISION
ENV NODE_ENV=production PLAYTEST_IMAGE_REVISION=$REVISION
WORKDIR /opt/playtest
COPY --from=build /opt/playtest /opt/playtest

FROM runtime AS control-plane
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg fonts-dejavu-core \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=4177 PLAYTEST_FFMPEG=/usr/bin/ffmpeg
USER node
EXPOSE 4177
CMD ["node", "packages/platform/control-plane/src/index.ts"]

FROM docker:29.2.1-cli@sha256:cab69e2d0a1a2ea9a1ce1060252f439e83483ae41ec09317aecb33b08a0656a5 AS docker-cli
FROM runtime AS runner
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
USER node
CMD ["node", "packages/platform/runner-agent/src/cli.ts", "pool"]

FROM runtime AS job
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright PLAYTEST_FFMPEG=/usr/bin/ffmpeg HOME=/tmp
RUN npx --no-install playwright install --with-deps chromium && apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /opt/playwright
USER node
CMD ["node", "packages/platform/runner-agent/src/case-runner-child.ts"]
