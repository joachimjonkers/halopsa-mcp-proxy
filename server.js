#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ── Load .env next to this file ─────────────────────────────────────
// Lets you keep credentials in a local .env file instead of passing them
// on the command line. Real environment variables take precedence, so
// this never overrides values passed via `claude mcp add -e ...`.
function loadDotEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return; // no .env file — rely on real environment variables
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

// ── Config ──────────────────────────────────────────────────────────
// The MCP endpoint (e.g. https://<your-halopsa>/api/mcp)
const HALO_URL = process.env.HALO_URL;
const HALO_TIMEOUT = Number(process.env.HALO_TIMEOUT) || 60_000;

// Auth — two supported methods:
//   1. OAuth2 client credentials (recommended): HALO_CLIENT_ID + HALO_CLIENT_SECRET
//      → the proxy fetches a Bearer token and refreshes it automatically.
//   2. Static API key (fallback): HALO_API_KEY → sent as the X-Halo-Api-Key header.
const HALO_CLIENT_ID = process.env.HALO_CLIENT_ID;
const HALO_CLIENT_SECRET = process.env.HALO_CLIENT_SECRET;
const HALO_API_KEY = process.env.HALO_API_KEY;
const HALO_SCOPE = process.env.HALO_SCOPE || "all";

if (!HALO_URL) {
  console.error(
    "[halopsa-proxy] HALO_URL environment variable is required " +
      "(your HaloPSA MCP endpoint, e.g. https://<your-halopsa>/api/mcp)."
  );
  process.exit(1);
}

const useOAuth = Boolean(HALO_CLIENT_ID && HALO_CLIENT_SECRET);

if (!useOAuth && !HALO_API_KEY) {
  console.error(
    "[halopsa-proxy] No credentials provided. Set either " +
      "HALO_CLIENT_ID + HALO_CLIENT_SECRET (recommended) or HALO_API_KEY."
  );
  process.exit(1);
}

// Token endpoint. Defaults to <origin-of-HALO_URL>/auth/token, which is
// correct for most HaloPSA instances. Override with HALO_AUTH_URL if your
// authorisation server differs (see Config > Integrations > Halo API).
const HALO_AUTH_URL =
  process.env.HALO_AUTH_URL || new URL(HALO_URL).origin + "/auth/token";

// ── OAuth2 token management ─────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0; // epoch ms

async function getAccessToken() {
  // Refresh a minute before expiry to avoid edge-of-expiry failures.
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: HALO_CLIENT_ID,
    client_secret: HALO_CLIENT_SECRET,
    scope: HALO_SCOPE,
  });

  const res = await fetch(HALO_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(HALO_TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(
      `Token request to ${HALO_AUTH_URL} failed: HTTP ${res.status}: ${await res.text()}`
    );
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error(
      `Token response from ${HALO_AUTH_URL} had no access_token: ${JSON.stringify(json).slice(0, 300)}`
    );
  }

  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  return cachedToken;
}

// Build the auth header for a request to the MCP endpoint.
async function authHeaders() {
  if (useOAuth) {
    return { Authorization: `Bearer ${await getAccessToken()}` };
  }
  return { "X-Halo-Api-Key": HALO_API_KEY };
}

// ── Internal notes (REST API) ───────────────────────────────────────
// Halo's MCP get_one_ticket only returns the customer-visible conversation.
// Internal notes (actions with hiddenfromuser=true) are fetched from the
// REST API and merged into the result. Defaults to <origin-of-HALO_URL>/api;
// override with HALO_API_URL. Set HALO_INCLUDE_INTERNAL_NOTES=false to disable.
const HALO_API_URL =
  process.env.HALO_API_URL || new URL(HALO_URL).origin + "/api";
const INCLUDE_INTERNAL_NOTES =
  (process.env.HALO_INCLUDE_INTERNAL_NOTES || "true").toLowerCase() !== "false";

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

async function fetchInternalNotes(ticketId) {
  const url = `${HALO_API_URL}/actions?ticket_id=${encodeURIComponent(ticketId)}&excludesys=true`;
  const res = await fetch(url, {
    headers: await authHeaders(),
    signal: AbortSignal.timeout(HALO_TIMEOUT),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  return (json.actions || [])
    .filter((a) => a.hiddenfromuser)
    .sort((a, b) => a.id - b.id)
    .map((a) => ({
      id: a.id,
      datetime: a.datetime,
      who: a.who,
      outcome: a.outcome,
      note: a.note || htmlToText(a.note_html || ""),
    }));
}

// Merge internal notes into a get_one_ticket result (JSON in the first text block).
async function withInternalNotes(result, ticketId) {
  const block = result?.content?.find((c) => c.type === "text");
  if (!block || ticketId == null) return result;
  let ticket;
  try {
    ticket = JSON.parse(block.text);
  } catch {
    return result; // not JSON (e.g. an error message) — leave untouched
  }
  try {
    ticket.internal_notes = await fetchInternalNotes(ticketId);
  } catch (err) {
    ticket.internal_notes_error = err.message;
  }
  block.text = JSON.stringify(ticket);
  return result;
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
      ...(await authHeaders()),
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
    if (INCLUDE_INTERNAL_NOTES) {
      const t = cachedTools.find((t) => t.name === "get_one_ticket");
      if (t) {
        t.description =
          (t.description || "") +
          " The result also includes `internal_notes`: the agents' internal (hidden-from-customer) notes on the ticket, which are not part of `conversation`. Always take them into account when summarising or answering questions about a ticket.";
      }
    }
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
      if (INCLUDE_INTERNAL_NOTES && name === "get_one_ticket" && !result?.isError) {
        return await withInternalNotes(result, args?.ticket_id);
      }
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
