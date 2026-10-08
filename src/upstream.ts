/**
 * The ONE persistent `railway mcp` stdio subprocess this bridge fronts.
 *
 * Railway's MCP server only speaks stdio and authenticates via the live
 * `railway login` CLI session in ~/.railway (it refuses static/project
 * tokens), so we hold a single client and re-expose it over HTTP.
 *
 * Leak fix vs. the Python bridge: that version pushed every respawned
 * subprocess onto a process-lifetime AsyncExitStack and never closed the
 * old one when a ping failed — ~100 orphaned `railway mcp` processes over
 * 9 days. Here every client we drop is explicitly close()d (which ends
 * stdin, then SIGTERM/SIGKILLs the child), and at most one exists at a time.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

export interface UpstreamOptions {
  command: string
  args: string[]
  env: Record<string, string>
  /** Per-request timeout for forwarded calls (progress notifications reset it). */
  requestTimeoutMs: number
}

export class Upstream {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private connecting: Promise<Client> | null = null
  private readonly opts: UpstreamOptions

  constructor(opts: UpstreamOptions) {
    this.opts = opts
  }

  /** PID of the live subprocess, or null if none is running. */
  get pid(): number | null {
    return this.client ? (this.transport?.pid ?? null) : null
  }

  get requestOptions() {
    return { timeout: this.opts.requestTimeoutMs, resetTimeoutOnProgress: true }
  }

  /** Live client, spawning `railway mcp` on first use or after it died. */
  async get(): Promise<Client> {
    if (this.client) return this.client
    this.connecting ??= this.spawn().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /**
   * Run `fn` against the upstream. If it fails because the subprocess died
   * or wedged, drop (and kill) that client so the next call respawns.
   */
  async use<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.get()
    try {
      return await fn(c)
    } catch (err) {
      if (await this.isDead(c, err)) await this.discard(c)
      throw err
    }
  }

  async close(): Promise<void> {
    if (this.client) await this.discard(this.client)
  }

  private async spawn(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      env: this.opts.env,
      stderr: 'inherit',
    })
    const client = new Client({ name: 'railway-mcp-bridge', version: '2.0.0' })
    // Child exited on its own (crash, CLI self-update): forget it.
    client.onclose = () => {
      if (this.client === client) {
        console.error('railway mcp subprocess exited; will respawn on next request')
        this.client = null
        this.transport = null
      }
    }
    try {
      await client.connect(transport)
    } catch (err) {
      await client.close().catch(() => {})
      throw err
    }
    this.client = client
    this.transport = transport
    console.error(`spawned railway mcp (pid ${transport.pid})`)
    return client
  }

  private async isDead(c: Client, err: unknown): Promise<boolean> {
    if (this.client !== c) return false
    if (!(err instanceof McpError)) return false
    if (err.code === ErrorCode.ConnectionClosed) return true
    if (err.code !== ErrorCode.RequestTimeout) return false
    // A slow tool isn't proof of death — only recycle if it won't answer a ping.
    try {
      await c.ping({ timeout: 5_000 })
      return false
    } catch {
      return true
    }
  }

  private async discard(c: Client): Promise<void> {
    if (this.client === c) {
      this.client = null
      this.transport = null
    }
    await c.close().catch(err => console.error('error closing railway mcp:', err))
  }
}
