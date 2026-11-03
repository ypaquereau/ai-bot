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
# Needs git (to clone/commit/push) and the Claude Code CLI (to run the
# agent itself). Kept on Debian slim rather than Alpine for glibc
# compatibility with the Claude Code binary / its npm postinstall.
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
RUN groupadd -g 10001 app && useradd -m -u 10001 -g app -d /workspace app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /workspace && chown -R app:app /workspace /app
USER app
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/runner/index.js"]
