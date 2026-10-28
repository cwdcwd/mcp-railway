# railway-mcp

Streamable-HTTP bridge for Railway's official MCP server.

`railway mcp` only speaks stdio and authenticates with a live `railway login`
CLI session (it refuses project/API tokens). This bridge runs **one**
persistent `railway mcp` subprocess and exposes it at `POST /mcp` so HTTP MCP
clients and aggregators can use it. Every call runs as the logged-in Railway user.

- Bearer-token gate (`RAILWAY_MCP_TOKEN`), constant-time compare
- DNS-rebinding protection: `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` (421 / 403)
- Stateless HTTP transport; the upstream subprocess is shared, killed when
  dropped, and respawned if it exits
- `GET /healthz` → `{ ok, upstreamPid }`
- Railway CLI **v5.71.0** (and its install script) is pinned in the image
  (`RAILWAY_CLI_VERSION`). Deliberate upgrade: `--build-arg RAILWAY_CLI_VERSION=x.y.z`.

## Run

```sh
cp .env.example .env    # set RAILWAY_MCP_TOKEN and your allow-lists
docker compose run --rm --entrypoint railway railway-mcp login --browserless   # once
docker compose up -d --build
RAILWAY_MCP_TOKEN=... python3 mcp-probe-railway.py localhost 3003
```

## Develop

Node ≥ 22.18 (runs TypeScript directly via type stripping).

```sh
npm install
npm run typecheck
npm test        # spawns the bridge against test/fake-railway.ts
```
