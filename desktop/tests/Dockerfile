FROM node:24.19.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app/desktop
COPY desktop/package.json desktop/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run install:electron && chown root:root node_modules/electron/dist/chrome-sandbox && chmod 4755 node_modules/electron/dist/chrome-sandbox
COPY src /app/src
COPY docs/product/screens/copy.ko.json /app/docs/product/screens/copy.ko.json
COPY package.json tsconfig.json /app/
COPY scripts/ui-contracts /app/scripts/ui-contracts
COPY desktop/*.ts desktop/*.mjs desktop/*.js desktop/*.cjs ./
COPY desktop/tests ./tests
RUN npm run build && mkdir smoke-artifacts && chown -R node:node /app/desktop/dist /app/desktop/tests /app/desktop/smoke-artifacts
USER node
CMD ["xvfb-run", "-a", "npm", "run", "smoke"]
