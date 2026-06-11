// skippy-context — MCP-over-HTTP handler for the skippy-omi worker.
//
// Exposes the Context Engine endpoints as MCP tools so Claude Code can query Skippy's memory
// natively. Dependency-free: implements the minimal JSON-RPC surface (initialize, tools/list,
// tools/call) over a single POST route. Wire it in skippy-omi's fetch handler:
//
//     import { handleMcp } from "./mcp";
//     if (new URL(request.url).pathname === "/mcp") return handleMcp(request, env);
//
// Optional auth: set `MCP_TOKEN` secret; clients then send `Authorization: Bearer <token>`.
// Leave it unset to keep the route open/read-only.

const BASE = "https://omi.fosterlabs.org";
const PROTOCOL_VERSION = "2024-11-05";

interface Env {
  MCP_TOKEN?: string;
}

type Json = Record<string, unknown>;

const TOOLS = [
  {
    name: "smart_search",
    description:
      "AutoRAG hybrid search (bge-m3 + keyword, RRF) over the Skippy corpus. BEST for " +
      "identifiers, dates, GitHub commits, and iMessage content. Use this by default for " +
      "anything with an ID/date/commit.",
    endpoint: (a: Json) => `${BASE}/context/v2/smart?q=${encodeURIComponent(String(a.q ?? ""))}`,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", description: "The query (substitute real text)" } },
      required: ["q"],
    },
  },
  {
    name: "nl_search",
    description:
      "v1 natural-language synthesis (Llama over the skippy-memory Vectorize index). Use for " +
      "natural-language 'pendant' questions where you want a synthesized answer, not identifiers.",
    endpoint: (a: Json) => `${BASE}/context/smart?q=${encodeURIComponent(String(a.q ?? ""))}`,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", description: "Natural-language question" } },
      required: ["q"],
    },
  },
  {
    name: "raw_search",
    description: "Raw Vectorize top-k results + metadata, no synthesis.",
    endpoint: (a: Json) =>
      `${BASE}/search?q=${encodeURIComponent(String(a.q ?? ""))}&k=${Number(a.k ?? 10)}`,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        k: { type: "number", description: "How many results (default 10)" },
      },
      required: ["q"],
    },
  },
  {
    name: "index",
    description: "Full corpus index (~200 tokens). Cheap orientation before a deeper query.",
    endpoint: () => `${BASE}/context`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "imsg_recent",
    description:
      "Last ~7 days across tracked iMessage contacts. SENSITIVE: real conversations with real " +
      "people. Acknowledge sensitive content once, briefly; don't psychoanalyze or lecture; " +
      "answer the actual question and offer the next action.",
    endpoint: () => `${BASE}/context/imsg`,
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const json = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

const rpcResult = (id: unknown, result: Json) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      },
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  if (env.MCP_TOKEN) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${env.MCP_TOKEN}`) return rpcError(null, -32001, "Unauthorized");
  }

  let msg: Json;
  try {
    msg = (await request.json()) as Json;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "skippy-context", version: "1.0.0" },
      });

    case "notifications/initialized":
      return new Response(null, { status: 202 });

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = (params?.name as string) ?? "";
      const args = (params?.arguments as Json) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const upstream = await fetch(tool.endpoint(args), { headers: { accept: "application/json" } });
        const text = await upstream.text();
        return rpcResult(id, {
          content: [{ type: "text", text }],
          isError: !upstream.ok,
        });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Upstream error: ${(e as Error).message}` }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method ?? "(none)"}`);
  }
}
