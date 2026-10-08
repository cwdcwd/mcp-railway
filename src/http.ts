#!/usr/bin/env node
/**
 * railway-mcp HTTP entrypoint — stdio-to-streamable-HTTP bridge for Railway's
 * official MCP server. Bearer gate, DNS-rebinding Host/Origin allow-lists,
 * health endpoint, stateless per-request MCP servers over ONE shared
 * `railway mcp` subprocess (see upstream.ts).
 */

import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './server.ts'
import { Upstream } from './upstream.ts'
import { matchesAny } from './hosts.ts'

const port = Number(process.env.PORT ?? 3002)
const host = process.env.HOST ?? '0.0.0.0'
const path = process.env.MCP_PATH ?? '/mcp'
// In-server bearer gate: Docker's published-port DNAT bypasses ufw's INPUT
// chain, so the published port's effective isolation must live here.
const token = process.env.RAILWAY_MCP_TOKEN ?? ''

const list = (v: string | undefined, dflt: string) =>
  (v ?? dflt).split(',').map(s => s.trim()).filter(Boolean)
// DNS-rebinding protection. Defaults admit loopback only; add the Host/Origin
// values your clients actually send (e.g. myhost.lan:3003) via env.
const allowedHosts = list(process.env.ALLOWED_HOSTS, 'localhost:*,127.0.0.1:*')
const allowedOrigins = list(process.env.ALLOWED_ORIGINS, 'http://localhost:*,http://127.0.0.1:*')

const upstream = new Upstream({
  command: process.env.RAILWAY_BIN ?? 'railway',
  args: list(process.env.RAILWAY_ARGS, 'mcp'),
  env: { HOME: process.env.HOME ?? '/home/app', PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
  requestTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 300_000),
})

const expectedAuth = Buffer.from(`Bearer ${token}`)
const authorized = (req: IncomingMessage) => {
  if (!token) return true
  const got = Buffer.from(req.headers.authorization ?? '')
  return got.length === expectedAuth.length && timingSafeEqual(got, expectedAuth)
}

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((res, rej) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      if (!raw) return res(undefined)
      try {
        res(JSON.parse(raw))
      } catch {
        rej(new Error('invalid JSON body'))
      }
    })
    req.on('error', rej)
  })

const rpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })

const http = createHttpServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, upstreamPid: upstream.pid }))
  }

  if (pathname !== path) {
    res.writeHead(404)
    return res.end()
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(rpcError(-32001, 'unauthorized'))
  }

  if (!matchesAny(req.headers.host ?? '', allowedHosts)) {
    res.writeHead(421, { 'content-type': 'application/json' })
    return res.end(rpcError(-32000, 'invalid Host header'))
  }
  const origin = req.headers.origin
  if (origin && !matchesAny(origin, allowedOrigins)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    return res.end(rpcError(-32000, 'invalid Origin header'))
  }

  // Stateless: fresh server + transport per request; the upstream is shared.
  const server = createMcpServer(upstream)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined)
  } catch (err) {
    console.error('request failed:', err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    if (!res.writableEnded) res.end(rpcError(-32603, 'internal error'))
  }
})

http.listen(port, host, () => {
  console.error(
    `railway-mcp listening on http://${host}:${port} — MCP at ${path}` +
      `${token ? ' (bearer auth on)' : ' (NO AUTH)'}`,
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    http.close()
    void upstream.close().finally(() => process.exit(0))
  })
}
