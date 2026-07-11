# syntax=docker/dockerfile:1.12
FROM node:24.18.0-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @massion/server build
RUN pnpm --filter @massion/server deploy --prod --legacy /opt/massion
RUN find /opt/massion -type f \( -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) -delete

FROM node:24.18.0-bookworm-slim AS production
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/massion /data \
  && chown -R node:node /var/lib/massion /data
WORKDIR /opt/massion
COPY --from=build --chown=node:node /opt/massion/ ./
USER node
ENV NODE_ENV=production
EXPOSE 3141 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3141/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main.js"]
