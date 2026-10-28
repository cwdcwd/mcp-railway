FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the CLI so rebuilding the bridge is reproducible. Override at build time
# only when intentionally upgrading: --build-arg RAILWAY_CLI_VERSION=x.y.z.
ARG RAILWAY_CLI_VERSION=5.71.0
RUN curl -fsSL https://railway.com/install.sh | RAILWAY_VERSION="${RAILWAY_CLI_VERSION}" bash -s -- -y -b /usr/local/bin

# node:22 already ships uid 1000 as 'node'; rename it to 'app' with HOME
# /home/app so the existing railway-mcp_railway_mcp_data volume (owned by
# 1000, mounted at /home/app/.railway) keeps working unchanged.
RUN usermod -l app -d /home/app -m node && groupmod -n app node \
    && mkdir -p /home/app/.railway && chown -R app:app /home/app/.railway
ENV HOME=/home/app
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=3003 \
    HOST=0.0.0.0 \
    MCP_PATH=/mcp

USER app
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3003)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node 22+ runs TypeScript directly (type stripping) — no build step needed.
CMD ["node", "--experimental-strip-types", "src/http.ts"]
