# skippy-context MCP server — patch set for `skippy-omi`

These files belong in **`ramonscottf/skippy-omi`**, not in def-flyers. They add a `/mcp` route
that exposes the Context Engine as a Model Context Protocol server, so Claude Code (and any MCP
client) can query Skippy's memory natively instead of curling — which also dodges the `web_fetch`
stale-cache bug.

> **Apply in skippy-omi only.** One repo per worker; never two sessions pushing the same repo.
> Do not deploy from a laptop (that causes drift — skippy-omi is the single source of truth).

## What's here

- `mcp.ts` — a dependency-free MCP-over-HTTP handler (JSON-RPC: `initialize`, `tools/list`,
  `tools/call`). No `@modelcontextprotocol/sdk` needed — it's a small surface and Workers bundle
  better without it. The tool bodies call the worker's existing public endpoints by URL, so they
  stay decoupled from skippy-omi internals.

## How to wire it

1. Drop `mcp.ts` into `skippy-omi/src/`.
2. In the worker's `fetch` handler, before the 404 catch-all:
   ```ts
   import { handleMcp } from "./mcp";
   // ...
   if (new URL(request.url).pathname === "/mcp") return handleMcp(request, env);
   ```
3. (Optional auth) Set a secret so only holders of the token can query:
   ```bash
   wrangler secret put MCP_TOKEN   # in the skippy-omi repo
   ```
   Then in Claude Code's `.mcp.json`, send `Authorization: Bearer <token>` (see
   def-flyers `.mcp.json` + the `SKIPPY_CONTEXT_TOKEN` env var). If you leave `MCP_TOKEN` unset,
   the route is open/read-only and no header is required.
4. Deploy from the skippy-omi repo. **PROMPT-IS-A-DOC-TOO:** in the same session, update the
   skippy-omi README and the Project Skippy system prompt to mention the new `/mcp` route + tools
   (and bump the prompt version), then tell Scott to paste the new prompt into Project settings.

## Verify

```bash
# tools/list
curl -s https://omi.fosterlabs.org/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -m json.tool

# tools/call
curl -s https://omi.fosterlabs.org/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"smart_search","arguments":{"q":"SOME KNOWN COMMIT ID"}}}'
```
In Claude Code: `claude mcp list` should show `skippy-context`, and `/sync` should return hits.
