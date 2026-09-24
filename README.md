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
3. Your **HaloPSA MCP endpoint URL** (looks like `https://<your-halopsa-instance>/api/mcp`). Enable it in HaloPSA under **Config > AI > "Enable the MCP Endpoint"**.
4. Credentials — **either** of:
   - **OAuth2 client credentials (recommended):** a **Client ID** + **Client Secret** from a HaloPSA API application (Config > Integrations > Halo API, authentication method "Client ID and Secret (Services)"). The proxy exchanges these for a Bearer token automatically.
   - **A static API key** (`X-Halo-Api-Key`) — HaloPSA's fallback auth method, if your instance issues one.

> The endpoint URL and credentials are specific to your organization's HaloPSA instance. Get them from whoever administers your HaloPSA — they are **not** included in this repo.

## Setup

```bash
git clone <this-repo-url>
cd halopsa-mcp-proxy
npm install
```

### Recommended: keep your secret in a `.env` file

This keeps your client secret in a local file — **never** typed into a chat window or a command. The proxy reads a `.env` file sitting next to `server.js`.

1. Create the file from the template:

   ```bash
   cp .env.example .env
   ```

2. Open `.env` in a text editor and fill in your values, then save:

   ```
   HALO_URL=<your-halopsa-mcp-endpoint>
   HALO_CLIENT_ID=<your-client-id>
   HALO_CLIENT_SECRET=<your-client-secret>
   ```

3. Register the proxy — note there are **no credentials in this command**:

   ```bash
   claude mcp add halopsa-proxy --scope user -- node "$PWD/server.js"
   ```

Run step 3 from inside the cloned folder so `$PWD` resolves correctly. Then **restart Claude Code**. `.env` is git-ignored, so your secret never gets committed.

> If you're letting Claude Code do the setup for you, ask it to create `.env` from `.env.example` and register the server — **but fill in the secret yourself in a text editor**, and don't paste it into the chat. Anything typed into the chat is sent to the model.

### Alternative: pass values on the command line

If you prefer, you can pass everything via `-e` instead of a `.env` file (values passed this way take precedence over `.env`):

```bash
claude mcp add halopsa-proxy \
  --scope user \
  -e HALO_URL="<your-halopsa-mcp-endpoint>" \
  -e HALO_CLIENT_ID="<your-client-id>" \
  -e HALO_CLIENT_SECRET="<your-client-secret>" \
  -- node "$PWD/server.js"
```

Static API key instead of OAuth2? Swap the client id/secret for `-e HALO_API_KEY="<your-api-key>"` (or set `HALO_API_KEY` in `.env`).

> **Token endpoint:** with client credentials the proxy requests a token from `<origin-of-HALO_URL>/auth/token` by default (e.g. `https://your-halopsa/api/mcp` → `https://your-halopsa/auth/token`). If your instance's authorisation server is on a different URL (check Config > Integrations > Halo API), set `HALO_AUTH_URL`. If the token request is rejected for scope, set `HALO_SCOPE` (default `all`).

## Verify

In a session, ask: *"Use the halopsa tools to list my assigned tickets."* Claude should call the `halopsa-proxy` tools and return live data. You can also run `claude mcp list` to confirm it's registered.

If it doesn't appear: check the path in the registration, that `npm install` finished, that both env vars are set, and that the client was fully restarted.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `HALO_URL` | yes | — | Your HaloPSA MCP endpoint, e.g. `https://<your-halopsa>/api/mcp` |
| `HALO_CLIENT_ID` | one auth method required | — | OAuth2 client ID (recommended path) |
| `HALO_CLIENT_SECRET` | with `HALO_CLIENT_ID` | — | OAuth2 client secret |
| `HALO_API_KEY` | fallback auth method | — | Static `X-Halo-Api-Key` value (used only if client id/secret are absent) |
| `HALO_AUTH_URL` | no | `<origin of HALO_URL>/auth/token` | OAuth2 token endpoint |
| `HALO_SCOPE` | no | `all` | OAuth2 scope requested |
| `HALO_TIMEOUT` | no | `60000` | Request timeout in ms |
| `HALO_API_URL` | no | `<origin of HALO_URL>/api` | REST API base, used to fetch internal notes |
| `HALO_INCLUDE_INTERNAL_NOTES` | no | `true` | Set to `false` to stop merging internal notes into `get_one_ticket` |

Provide **either** `HALO_CLIENT_ID` + `HALO_CLIENT_SECRET` (OAuth2, recommended) **or** `HALO_API_KEY` (static fallback).

### Internal notes

HaloPSA's MCP `get_one_ticket` only returns the customer-visible conversation. The proxy also calls the REST API (`GET /api/actions?ticket_id=…`) with the same credentials and adds the agents' hidden notes to the result as `internal_notes` (`id`, `datetime`, `who`, `outcome`, `note`). If that call fails — e.g. the API application lacks REST read access — the ticket is still returned, with the reason in `internal_notes_error`.

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
