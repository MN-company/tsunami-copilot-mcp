# Runtime needs no browser: Tsunami runs over plain HTTP + cookies. Login (npm run login) runs on the host
# and the token file is shared through the mounted data directory.
FROM node:22-slim
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN mkdir -p /data /state && chown -R node:node /data /state /app
USER node
ENV TSUNAMI_DATA_DIR=/data TSUNAMI_DB_PATH=/state/agent.sqlite BIND_HOST=0.0.0.0 PORT=3790
EXPOSE 3790
CMD ["node", "src/server.mjs"]
