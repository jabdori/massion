# syntax=docker/dockerfile:1.12
FROM node:24.18.0-bookworm-slim AS web
WORKDIR /workspace
RUN npm install --global pnpm@11.13.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @massion/web build

FROM caddy:2.11.4-alpine
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /workspace/apps/web/dist /srv
