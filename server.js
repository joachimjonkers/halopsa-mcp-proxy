#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ──────────────────────────────────────────────────────────
const HALO_API_KEY = process.env.HALO_API_KEY;
const HALO_URL = process.env.HALO_URL;
const HALO_TIMEOUT = Number(process.env.HALO_TIMEOUT) || 60_000;

if (!HALO_API_KEY) {
  console.error(
    "[halopsa-proxy] HALO_API_KEY environment variable is required."
  );
  process.exit(1);
}

if (!HALO_URL) {
  console.error(
    "[halopsa-proxy] HALO_URL environment variable is required " +
      "(your HaloPSA MCP endpoint, e.g. https://<your-halopsa>/api/mcp)."
  );
  process.exit(1);
}

// ── SSE response parser ─────────────────────────────────────────────
function parseSSEResponse(text) {
  // Try plain JSON first (in case HaloPSA drops SSE wrapping in the future)
  try {
    const direct = JSON.parse(text.trim());
    if (direct.jsonrpc) return direct;
  } catch {
    // not plain JSON — fall through to SSE parsing
  }

  // Parse SSE: collect all `data:` lines
  const lines = text.split("\n");
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5));
    }
  }

  if (dataLines.length === 0) {
    throw new Error(
      `No data found in SSE response: ${text.substring(0, 300)}`
    );
  }

  return JSON.parse(dataLines.join("\n"));
}

// ── HTTP proxy to HaloPSA ───────────────────────────────────────────
let requestId = 0;

async function proxyToHalo(method, params) {
  requestId += 1;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method,
    params: params ?? {},
  });

  const res = await fetch(HALO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Halo-Api-Key": HALO_API_KEY,
    },
    body,
    signal: AbortSignal.timeout(HALO_TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(
      `HaloPSA returned HTTP ${res.status}: ${await res.text()}`
    );
  }

  const raw = await res.text();
  const parsed = parseSSEResponse(raw);

  if (parsed.error) {
    throw new Error(
      `HaloPSA JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`
    );
  }

  return parsed.result;
}

// ── Discover tools from remote endpoint ─────────────────────────────
let cachedTools = [];

async function discoverTools() {
  try {
    const result = await proxyToHalo("tools/list", {});
    cachedTools = result.tools || [];
    console.error(
      `[halopsa-proxy] Discovered ${cachedTools.length} tools from ${HALO_URL}`
    );
  } catch (err) {
    console.error(
      `[halopsa-proxy] Failed to discover tools: ${err.message}`
    );
    console.error(
      "[halopsa-proxy] Starting with 0 tools — restart to retry."
    );
  }
}

// ── MCP Server ──────────────────────────────────────────────────────
async function main() {
  await discoverTools();

  const server = new Server(
    { name: "halopsa-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // tools/list — return the cached tool definitions from HaloPSA
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: cachedTools };
  });

  // tools/call — proxy the call to HaloPSA and parse the SSE response
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await proxyToHalo("tools/call", {
        name,
        arguments: args,
      });
      return result;
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[halopsa-proxy] Server running on stdio");
}

main().catch((err) => {
  console.error(`[halopsa-proxy] Fatal: ${err.message}`);
  process.exit(1);
});
