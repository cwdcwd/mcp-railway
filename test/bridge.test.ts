import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { matchesAny } from '../src/hosts.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const PORT = 39_402
const TOKEN = 'test-token'
const url = `http://127.0.0.1:${PORT}/mcp`

let bridge: ChildProcess

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function rpc(method: string, params: object = {}, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const raw = await res.text()
  const data = raw.split('\n').find(l => l.startsWith('data:'))
  return { status: res.status, body: data ? JSON.parse(data.slice(5)) : raw }
}

const upstreamPid = async () =>
  ((await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { upstreamPid: number | null }).upstreamPid

beforeAll(async () => {
  bridge = spawn('node', ['--experimental-strip-types', 'src/http.ts'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      RAILWAY_MCP_TOKEN: TOKEN,
      RAILWAY_BIN: 'node',
      RAILWAY_ARGS: `--experimental-strip-types,${root}/test/fake-railway.ts`,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  for (let i = 0; i < 50; i++) {
    try {
      await upstreamPid()
      return
    } catch {
      await new Promise(r => setTimeout(r, 100))
    }
  }
  throw new Error('bridge did not start')
})

afterAll(() => {
  bridge.kill('SIGTERM')
})

describe('gates', () => {
  it('rejects missing/wrong bearer with 401', async () => {
    expect((await rpc('tools/list', {}, { authorization: '' })).status).toBe(401)
    expect((await rpc('tools/list', {}, { authorization: 'Bearer nope' })).status).toBe(401)
  })

  it('rejects foreign Host with 421 and foreign Origin with 403', async () => {
    // fetch won't let us override Host, so test the matcher directly.
    const hosts = ['localhost:*', 'myhost.lan:3003']
    expect(matchesAny('localhost:3002', hosts)).toBe(true)
    expect(matchesAny('myhost.lan:3003', hosts)).toBe(true)
    expect(matchesAny('evil.com', hosts)).toBe(false)
    expect(matchesAny('localhost:80.evil.com', hosts)).toBe(false)
    expect((await rpc('tools/list', {}, { origin: 'http://evil.com' })).status).toBe(403)
  })
})

describe('proxy', () => {
  it('forwards tools/list and tools/call', async () => {
    const list = await rpc('tools/list')
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['whoami', 'echo', 'crash'])
    const call = await rpc('tools/call', { name: 'echo', arguments: { a: 1 } })
    expect(call.body.result.content[0].text).toBe('{"a":1}')
  })

  it('reuses ONE subprocess across many requests', async () => {
    const pid = await upstreamPid()
    await Promise.all(Array.from({ length: 20 }, () => rpc('tools/call', { name: 'whoami', arguments: {} })))
    expect(await upstreamPid()).toBe(pid)
  })

  it('respawns after the subprocess dies, without leaking the old one', async () => {
    const before = (await upstreamPid())!
    const crashed = await rpc('tools/call', { name: 'crash', arguments: {} })
    expect(crashed.body.error ?? crashed.body.result?.isError).toBeTruthy()
    await new Promise(r => setTimeout(r, 300))
    expect(alive(before)).toBe(false)

    const who = await rpc('tools/call', { name: 'whoami', arguments: {} })
    const after = (await upstreamPid())!
    expect(after).not.toBe(before)
    expect(who.body.result.content[0].text).toBe(`pid ${after}`)
  })
})
