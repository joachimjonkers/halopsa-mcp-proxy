# HaloPSA MCP Proxy

A small local **stdio-based MCP server** that proxies tool calls to a HaloPSA hosted MCP endpoint, so you can work with HaloPSA tickets directly from an MCP client like Claude Code.

## Why this exists

HaloPSA's MCP endpoint returns responses in **SSE format** (`event: message\ndata: {...}`). Some MCP clients' built-in HTTP transport fails to parse those responses, throwing errors like `Cannot read properties of undefined (reading 'map')` on every tool call.

This proxy:

1. Speaks **stdio MCP** to your client (which works reliably),
2. Forwards each tool call to the HaloPSA HTTP endpoint,
3. Parses the SSE-wrapped response correctly,
4. Returns clean JSON-RPC results back to the client.

It auto-discovers whatever tools your HaloPSA endpoint exposes at startup (commonly ~14, e.g. `search_tickets`, `get_one_ticket`, `get_assigned_tickets`, `get_knowledge`, `create_ticket`, `add_note_to_ticket`, `assign_to_me`, `log_time`).

## What you need

1. **Node.js** (recent LTS) — check with `node --version`.
2. An **MCP client** (these instructions use [Claude Code](https://docs.anthropic.com/en/docs/claude-code)).
3. Your **HaloPSA MCP endpoint URL** (looks like `https://<your-halopsa-instance>/api/mcp`).
4. A **HaloPSA API key** (`X-Halo-Api-Key`) tied to your own account.

> The endpoint URL and API key are specific to your organization's HaloPSA instance. Get them from whoever administers your HaloPSA — they are **not** included in this repo.

## Setup

```bash
git clone <this-repo-url>
cd halopsa-mcp-proxy
npm install
```

Register it with Claude Code (user scope = available in every project):

```bash
claude mcp add halopsa-proxy \
  --scope user \
  -e HALO_API_KEY="<your-api-key>" \
  -e HALO_URL="<your-halopsa-mcp-endpoint>" \
  -- node "$PWD/server.js"
```

Run this from inside the cloned folder so `$PWD` resolves correctly. Then **restart Claude Code** so it picks up the new server.

### Letting Claude set it up for you

You can hand this README to Claude Code and say:

> "Set up the HaloPSA MCP proxy following this README. My endpoint is `<url>` and my API key is `<key>`."

It will run `npm install` and the `claude mcp add` command. You still restart the client yourself at the end.

## Verify

In a session, ask: *"Use the halopsa tools to list my assigned tickets."* Claude should call the `halopsa-proxy` tools and return live data. You can also run `claude mcp list` to confirm it's registered.

If it doesn't appear: check the path in the registration, that `npm install` finished, that both env vars are set, and that the client was fully restarted.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `HALO_API_KEY` | yes | — | Your `X-Halo-Api-Key` value |
| `HALO_URL` | yes | — | Your HaloPSA MCP endpoint, e.g. `https://<your-halopsa>/api/mcp` |
| `HALO_TIMEOUT` | no | `60000` | Request timeout in ms |

## Removing it

```bash
claude mcp remove halopsa-proxy --scope user
```

## When the upstream bug is fixed

Once your MCP client parses HaloPSA's SSE responses correctly, this proxy can be replaced with a direct HTTP MCP registration:

```bash
claude mcp add halopsa --transport http <your-halopsa-mcp-endpoint> \
  --header "X-Halo-Api-Key: <your-key>"
```

## License

MIT — see [LICENSE](LICENSE).
