# syntax=docker/dockerfile:1.7

# ---- deps: install once, reused by the build stage ------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- build: compile TypeScript --------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- server: runs the webhook endpoint -------------------------------------
FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER app
EXPOSE 3000
ENTRYPOINT ["node", "dist/server/index.js"]

# ---- runner: ephemeral image used by the k8s Jobs -------------------------
# Needs git (to clone/commit/push) and the Cursor CLI (to run the agent
# itself, see https://cursor.com/docs/cli). Kept on Debian slim rather than
# Alpine for glibc compatibility with the Cursor CLI's prebuilt binary.
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
# Installed with HOME pointed at /opt/cursor-agent rather than the default
# /root: /root is mode 700, so the non-root "app" user below could never
# traverse into it to exec the binary, even via a symlink (that cost a
# debugging round: the installer's own "add ~/.local/bin to PATH" step also
# means the real binary lands under .local/, not .cursor/ as some
# third-party docs claimed). The install itself leaves files group/other
# readable+executable; the explicit chmod is a belt-and-suspenders in case
# umask ever changes that.
RUN mkdir -p /opt/cursor-agent \
  && export HOME=/opt/cursor-agent \
  && curl https://cursor.com/install -fsS | bash \
  && chmod -R o+rX /opt/cursor-agent \
  && ln -s /opt/cursor-agent/.local/bin/agent /usr/local/bin/agent
RUN groupadd -g 10001 app && useradd -m -u 10001 -g app -d /workspace app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /workspace && chown -R app:app /workspace /app
USER app
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/runner/index.js"]
