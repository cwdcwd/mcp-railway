#!/usr/bin/env python3
# railway-mcp verification probe
# Usage: python3 mcp-probe-railway.py <host> [port]
#   host defaults to localhost, port defaults to 3003 (published).
# Raw JSON-RPC probe, no MCP client needed. Bearer support: set RAILWAY_MCP_TOKEN env
# (read from env, NEVER printed, NEVER passed on the command line) once the in-server
# — without it the gate must answer 401 (that is the negative control).
import json as _json
import os
import sys
import urllib.error
import urllib.request

host = sys.argv[1] if len(sys.argv) > 1 else 'localhost'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 3003
url = f"http://{host}:{port}/mcp"
_token = os.environ.get("RAILWAY_MCP_TOKEN", "")


def rpc(method, params=None, session=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method,
            "params": params or {}}
    req = urllib.request.Request(
        url, data=_json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"})
    if session:
        req.add_header("Mcp-Session-Id", session)
    if _token:
        req.add_header("Authorization", f"Bearer {_token}")
    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        print(f"{method}: HTTP {e.code} (gate or transport rejection)")
        sys.exit(2)
    return resp, resp.headers.get("Mcp-Session-Id") or session


resp, session = rpc("initialize", {
    "protocolVersion": "2025-03-26", "capabilities": {},
    "clientInfo": {"name": "railway-mcp-probe", "version": "1.0"}})
print("initialize:", resp.status, "endpoint:", url)
resp, session = rpc("tools/list", session=session)
raw = resp.read().decode()
tools = []
try:  # plain-JSON framing
    doc = _json.loads(raw)
    tools = doc.get("result", {}).get("tools", [])
except Exception:
    pass
if not tools:  # SSE framing: parse data: lines BEFORE giving up
    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                tools = _json.loads(line[5:]).get("result", {}).get("tools", [])
                if tools:
                    break
            except Exception:
                continue
print("tools/list:", resp.status, "tool count:", len(tools))
print("sample:", ", ".join(t.get("name", "?") for t in tools[:6]))
# Upstream `railway mcp` serves BARE tool names (whoami, list-projects, ...);
# any prefix an aggregating gateway adds is not visible here.
for call in ("whoami", "list-projects"):
    resp, session = rpc("tools/call",
                        {"name": call, "arguments": {}}, session=session)
    head = resp.read().decode()[:120]
    print(f"tools/call {call}:", resp.status, "head:", head)
print("PROBE COMPLETE")
