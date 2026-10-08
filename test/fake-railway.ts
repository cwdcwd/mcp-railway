/** Stand-in for `railway mcp`: a stdio MCP server with whoami/echo/crash tools. */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'fake-railway', version: '0.0.0' }, { capabilities: { tools: {} } })
const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [tool('whoami'), tool('echo'), tool('crash')],
}))

server.setRequestHandler(CallToolRequestSchema, req => {
  if (req.params.name === 'crash') process.exit(1)
  const text = req.params.name === 'whoami' ? `pid ${process.pid}` : JSON.stringify(req.params.arguments)
  return { content: [{ type: 'text', text }] }
})

await server.connect(new StdioServerTransport())
