/**
 * MCP server facade: a low-level SDK Server whose tools/list and tools/call
 * are forwarded verbatim to the shared `railway mcp` upstream.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Upstream } from './upstream.ts'

export function createMcpServer(upstream: Upstream): Server {
  const server = new Server(
    { name: 'railway', version: '2.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, req =>
    upstream.use(c => c.listTools(req.params, upstream.requestOptions)),
  )

  server.setRequestHandler(CallToolRequestSchema, req =>
    upstream.use(c => c.callTool(req.params, CallToolResultSchema, upstream.requestOptions)),
  )

  return server
}
