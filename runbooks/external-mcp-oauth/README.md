# External MCP clients over OAuth (Claude Desktop / Claude Code → Studio)

How an external MCP client (Claude Desktop, Claude Code, any RFC 9728 / MCP
OAuth client) connects to a Studio **aggregate** or **virtual MCP** endpoint and
actually calls tools. Also documents the WhatsApp-MCP deployment this was first
proven against.

## TL;DR — the working endpoint shape

```
https://<host>/api/<org-slug>/mcp/<virtual-mcp-connection-id>
```

- **Virtual MCP (a.k.a. "Agent")** endpoint — aggregates the connections you
  add as children. This is what you give an external client.
- The bare aggregate `https://<host>/api/<org>/mcp` is the **Decopilot
  orchestrator** — it has `connections: []` by design (zero tools). Do not
  point external clients at it expecting tools.
- Per-connection endpoints (`/api/<org>/mcp/<downstream-conn-id>`) use the
  connection **oauth-proxy**, which only accepts Studio's own redirect_uri —
  not usable by an external client. Use a virtual MCP instead.

Add to Claude Code:

```bash
claude mcp add --transport http studio-agent \
  https://<host>/api/<org>/mcp/<virtual-mcp-id>
# then: /mcp → Authenticate (OAuth against Studio's own Better Auth AS)
```

## Why it didn't work out of the box (three root causes)

1. **No OAuth resource metadata on aggregate / virtual endpoints.**
   - The bare aggregate `/api/:org/mcp` had no `oauth-protected-resource`
     well-known (404).
   - Virtual MCP endpoints tried to *proxy* the downstream OAuth metadata, but
     a virtual MCP's `connection_url` is `virtual://<id>` — nothing to fetch →
     502 "protocol must be http/https/s3".
   Both should advertise **Studio itself** (Better Auth MCP AS, which supports
   Dynamic Client Registration) as the authorization server.

2. **`WWW-Authenticate` advertised an `http://` resource_metadata URL** behind
   the TLS-terminating reverse proxy (Caddy → Studio over http). Strict OAuth
   clients (Claude) reject non-https metadata URLs.

3. **MCP OAuth sessions resolved the member role from the wrong org.** External
   clients don't send `x-org-id` / `x-org-slug`; the org is in the URL path. For
   a **multi-org** member the code fell through to a "single membership only"
   guard, resolved to **no role**, lost the owner/admin bypass, and every
   connection tool call 403'd `Access denied to: <tool>`.

## The fix (all in `apps/mesh`)

| File | Change |
|------|--------|
| `api/app.ts` (`mcpAuth`) | Build the `resource_metadata` origin from `X-Forwarded-Proto` when present, so it advertises `https://` behind a proxy. |
| `api/routes/org-scoped.ts` | Mount `GET /mcp/.well-known/oauth-protected-resource` (aggregate, no connectionId) → Better Auth protected-resource metadata. |
| `api/routes/oauth-proxy.ts` (`protectedResourceMetadataHandler`) | If `connection_url` starts with `virtual://`, return Better Auth metadata instead of proxying a nonexistent downstream AS. |
| `core/context-factory.ts` (`authenticateRequest`) | Derive an org-slug hint from the request path (`/api/:org/...`) and use it in the MCP-OAuth membership lookup, so multi-org members resolve their role for the org they target. |

Net effect: an external MCP client discovers Studio's own Better Auth AS,
registers via DCR (its own redirect_uri is accepted), logs in against Studio,
and the resulting token resolves to the caller's real role in the path org.
Downstream per-user OAuth (e.g. WhatsApp pairing) still happens lazily when a
per_user connection's tool is first invoked.

## RBAC still applies (by design)

- `owner` / `admin` bypass all tool checks.
- The built-in `user` role does **not** bypass and has only `BASIC_USAGE_TOOLS`
  + its static grants — it **cannot** call arbitrary connection tools. To grant
  a non-admin access to a connection's tools, create a **custom role** (row in
  `organizationRole`) with `{ "conn_<UUID>": ["*" | tool...] }` and assign it to
  the member (roles are comma-OR'd). The built-in `user` role's grants are
  static code and can't hold connection grants.

## Deploy (VM `litellm-server`, GCP `ari-teste-492120`)

Studio runs as docker-compose project **`deco-mesh`** at
`~/deco-mesh/deploy/docker-compose/` behind **Caddy** (TLS, `*.sslip.io`):

- `decocms` — `evoapicloud`... no: `ghcr.io/decocms/studio/studio` normally;
  here overridden to a locally-built image `decocms-merge:local`
  (`.env`: `IMAGE_REPOSITORY=decocms-merge`, `IMAGE_TAG=local`).
- `studio-postgres`, `deco-caddy`.

Rebuild + redeploy after a code change:

```bash
# local
bun run --cwd=apps/mesh build:server
( cd apps/mesh && npm pack )                      # → decocms-<v>.tgz
cp apps/mesh/decocms-*.tgz /tmp/ctx/decocms.tgz   # ctx also has apps/mesh/Dockerfile
gcloud compute scp /tmp/ctx/decocms.tgz litellm-server:~/studio-merge-context/decocms.tgz \
  --zone southamerica-east1-b
# on VM
sudo docker build -t decocms-merge:local -f Dockerfile ~/studio-merge-context
cd ~/deco-mesh/deploy/docker-compose
sudo docker compose -p deco-mesh \
  -f docker-compose.postgres.yml -f docker-compose.override.yml -f docker-compose.caddy.yml \
  up -d --force-recreate studio
```

> Disk: each image is ~2.7 GB and rebuilds orphan the previous one. If a build
> fails with `no space left on device`, run `sudo docker system prune -af &&
> sudo docker builder prune -af` (keeps running containers + volumes).

### WhatsApp MCP stack (`whatsapp` compose project)

Deployed at `~/whatsapp-deploy/` on the same `deco-mesh_studio-network`:
`evolution-api` (v2, `evoapicloud/evolution-api`) + `evolution-postgres` +
`evolution-redis` + `whatsapp-mcp` (built from
`github.com/AriOliv/whatsapp-mcp`). Secrets in `~/whatsapp-deploy/.env.whatsapp`.
Public via Caddy at `https://whatsapp-mcp.<host>.sslip.io/mcp`.

Caddy site block added to `~/deco-mesh/.../Caddyfile`:

```
whatsapp-mcp.34-95-163-198.sslip.io {
	reverse_proxy whatsapp-mcp:3000
}
```

## Downstream OAuth: the `resource` indicator (RFC 8707)

When Studio's connection **oauth-proxy** forwards the `authorize`/`token` legs to
a downstream MCP's real authorization server, it rewrites the RFC 8707 `resource`
parameter. Historically it hardcoded `resource = connection.connection_url` (the
full MCP endpoint) — correct for servers that validate the resource equals their
exact endpoint (e.g. Supabase), but **wrong for servers that only accept the
origin**.

**Symptom (Pipedream / Pipedrive):** connecting `https://mcp.pipedream.net/v2`
fails the OAuth handshake with:

```
{"error":"invalid_request","error_description":"resource: Invalid or unauthorized resource parameter"}
```

Pipedream's AS (`https://mcp.pipedream.com`) only accepts `resource=https://mcp.pipedream.net`
(origin, no `/v2` path), while the MCP transport itself lives at `/v2`. The two
diverge, and Pipedream gates its `.well-known/oauth-protected-resource` behind
auth so RFC 9728 discovery can't resolve the canonical resource either. (Proven:
probing the authorize endpoint, only the bare origin passes resource validation.)

**Fix** (`apps/mesh/src/api/app.ts`, oauth-proxy handler): the forwarded
`resource` is now `connection.metadata.oauthResource` when set, else
`connection.connection_url`. A single `resourceIndicator` is computed once and
used on both the authorize redirect and the token form-body rewrite.

**Per-connection override** — set once in the DB (or via a connection-metadata
UI when available):

```sql
UPDATE connections
SET metadata = '{"oauthResource":"https://mcp.pipedream.net"}'
WHERE id = '<conn-id>';
```

Leave `metadata.oauthResource` unset for normal servers — they keep the
endpoint-equals-resource default.

> **Reference (why this works):** a local Hermes agent connects the same
> Pipedream MCP successfully as a native OAuth client (DCR client `dyn_…`,
> loopback redirect `http://localhost:60412/callback`, `offline_access` +
> refresh_token). Hermes never rewrites the resource to `/v2`; that is the only
> reason it worked where Studio didn't.

## Manage aggregated connections (UI)

Virtual MCPs are **"Agents"** in the UI (`/<org>/agents`). Add connections to an
agent from **Connections → select → Add to agent**, or from the agent detail.
Each agent's MCP endpoint is `/api/<org>/mcp/<agent-connection-id>`. New
connections are **not** auto-aggregated — add them explicitly.
