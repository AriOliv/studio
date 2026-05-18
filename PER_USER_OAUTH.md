# Per-User OAuth on Downstream MCP Connections

Branch: `feat/per-user-oauth`. Tracks the work to make each member of an
organization act with their own downstream identity (Notion, Google
Calendar, GitHub, etc.) instead of a single shared bot account, while
keeping the same single MCP gateway URL for the whole team.

## What works today

- **Single unified endpoint** per organization
  (`https://<studio>/api/<org-slug>/mcp/gateway/<virtual-mcp-id>`).
  Each member configures Claude Desktop / Claude Code / Cursor with the
  same URL.
- **OAuth from Claude clients to Studio**. The clients follow RFC 9728
  (Protected Resource Metadata) + RFC 7591 (Dynamic Client Registration)
  against `/api/:org/oauth-proxy/...` — already implemented upstream.
  The user signs into Studio in the browser; the client caches the
  resulting access token.
- **`auth_mode` per connection** (`shared` | `per_user`, default
  `shared`). When `per_user`, the resolver in
  `apps/mesh/src/mcp-clients/outbound/headers.ts` looks the downstream
  token up by `(connection_id, caller_user_id)` instead of just
  `connection_id`. Missing token raises
  `PerUserAuthorizationRequiredError` which the proxies render as an
  HTTP 401 with `WWW-Authenticate: Bearer` and a structured body
  carrying the authorize URL.
- **Two partial unique indexes** on `downstream_tokens` keep one
  shared row per connection (`user_id IS NULL`) and any number of
  per-user rows (`user_id IS NOT NULL`) coexisting safely. Migration
  078 is non-destructive — existing tokens stay as shared.
- **UI**: switch in the create-connection dialog and the settings tab;
  badge "Per-user" on the connection card; copy on the OAuth empty-state
  adapts to per-user mode.
- **`member` role mapping** (commit `52f0e1ca9`, narrowed in
  `7314572e9`). Members can now log in and use the gateway — without
  the mapping every page threw `Access denied to: ...`.
- **Validated end-to-end** with two real users (admin + user B as
  `member`). User B authorised Google Calendar with their own account
  via the UI; `tools/list` through the gateway returned the calendar
  tools with their identity; admin (no token) received the structured
  401 with the actionable URL. Confirmed in Claude Code CLI too.

## Architecture quick-reference

| File | Role |
|---|---|
| `apps/mesh/migrations/078-per-user-oauth.ts` | Schema migration |
| `apps/mesh/src/storage/types.ts` | `DownstreamTokenTable.userId`, `MCPConnectionTable.auth_mode` |
| `apps/mesh/src/storage/downstream-token.ts` | `get/upsert/delete` scoped by `(connectionId, userId)` |
| `apps/mesh/src/storage/connection.ts` | Reads/writes `auth_mode` on the connection row |
| `apps/mesh/src/mcp-clients/outbound/headers.ts` | Token resolver — the hot path |
| `apps/mesh/src/mcp-clients/outbound/errors.ts` | `PerUserAuthorizationRequiredError` + 401 renderer |
| `apps/mesh/src/api/routes/proxy.ts` and `virtual-mcp.ts` | Catch the error, return 401 |
| `apps/mesh/src/api/routes/downstream-token.ts` | REST endpoints scope tokens by caller |
| `apps/mesh/src/auth/index.ts` | `member` role definition |
| `packages/mesh-sdk/src/types/connection.ts` | `auth_mode` in the connection Zod schema |
| `apps/mesh/src/web/components/details/connection/settings-tab/` | Switch + adapted OAuth empty-state |
| `apps/mesh/src/web/components/connections/connection-card.tsx` | "Per-user" badge |

## Branch commits

```
d5f28b7f0 fix(roles): include connection tools in the role permission editor
008ea5308 docs(per-user-oauth): track open follow-ups for this feature branch
7314572e9 fix(auth): narrow `member` role permissions (intent, not yet enforced)
89111d58c fix(virtual-mcp): resolve org from path-scoped ctx, not just legacy headers
52f0e1ca9 fix(auth): map `member` role so new org members have permissions
8aa6ce3e3 feat(auth): per-user OAuth on downstream MCP connections
```

---

## Open follow-ups

Numbered so it's easy to pick one and ship it.

### 1. **\[security blocker\]** `member` can still self-promote to `admin`

> **✅ Fixed by `c17706dc6` and reinforced by `14cf5d3ee` / `d357d8a4c`.**
> Root cause: `BUILTIN_ROLES` in `apps/mesh/src/auth/roles.ts`
> included `"user"`, which is the Better Auth admin-plugin default
> for fresh signups, so the bypass at
> `apps/mesh/src/core/context-factory.ts:251-255` fired for new org
> members. `"user"` removed from the array. Filed upstream as
> decocms/studio#3388.

Filed upstream: [decocms/studio#3388](https://github.com/decocms/studio/issues/3388).

Symptom: a user with role `member` calling
`ORGANIZATION_MEMBER_UPDATE_ROLE` via `/api/<org>/mcp/self` succeeds —
the role on the DB row gets flipped to `admin`. Reproduced in this
session after commit `7314572e9` even with the narrow `self:` array.

Hypotheses to investigate:
- Better Auth caches role definitions across `bun --hot` reloads; a
  full kill-and-restart of `bun run dev` may be required to pick up
  changes to `apps/mesh/src/auth/index.ts`. (Tried once, still
  escalated — need to confirm with stricter restart.)
- The `connectionId` passed to `boundAuth.hasPermission` defaults to
  the literal string `"self"` (see
  `apps/mesh/src/core/access-control.ts:128`) but the actual call to
  `/mcp/self` may set a different value via the MeshContext wiring,
  meaning the role's `self:` array is the wrong key entirely.
- There's an alternate code path that grants access without
  `ctx.access.check()` — e.g., a middleware that calls
  `accessControl.grant()` early for some routes.

Suggested approach: add temporary `console.log` instrumentation in
`AccessControl.check` and `checkResource` to print the user id, role,
resource, and `hasPermission` response, then reproduce the escalation
to see which line lets it through.

**Must be fixed before this branch is proposed upstream.**

---

### 2. Proxy-level enforcement of "which user can use which connection"

Today any org member can call `/api/<org>/mcp/<connection-id>` and the
resolver will inject whatever token is configured (shared or, for
per-user, the caller's own). There's no check "is this user allowed
to use connection X". For real isolation (CEO uses Notion + Calendar
only; compliance uses blocklist tools only), the team currently has to
rely on "do not share the URL" rather than enforcement.

Design sketch:

- New table `connection_access(connection_id, principal_type, principal_id, mode)`
  where `principal_type ∈ {user, role}` and `mode ∈ {allow, deny}`.
- Insert a check in `proxy.ts` (before `clientFromConnection`) and in
  `virtual-mcp.ts` (when iterating aggregated connections — filter the
  list to only those the caller can use, so `tools/list` already comes
  back curated).
- New tools `COLLECTION_CONNECTIONS_GRANT` / `REVOKE` for management.
- UI on the connection settings: a "Who can use this" list with
  add/remove.

Estimated: 1–2 days. Out of scope for this branch.

---

### 3. Decopilot doesn't aggregate tools

`/api/<org>/mcp` (without a virtual MCP id) routes to the Decopilot
agent, which by design is a pure orchestrator with `connections: []`
(see `apps/mesh/src/storage/virtual.ts:138-146`). It exposes the
Studio Pack manager agents via `subtask`, not the org's actual tools.

For a unified "all org tools" endpoint we currently create a Virtual
MCP manually (`COLLECTION_VIRTUAL_MCP_CREATE` or via UI) and use
`/api/<org>/mcp/gateway/<vmcp-id>`. Worth either:

- Documenting clearly that `/api/<org>/mcp` is NOT a generic
  aggregator; OR
- Adding a `?include=all-org-connections` mode on the Decopilot path
  that does flatten everything; OR
- Auto-creating a default "All Tools" virtual MCP per org so members
  always have one URL to copy without admin setup.

---

### 4. Claude Desktop rendering of per-user authorize URL

When the resolver throws `PerUserAuthorizationRequiredError`, we
return:

```json
{
  "error": "per_user_authorization_required",
  "message": "Connect your <provider> account: <url>",
  "authorize_url": "<url>"
}
```

with `WWW-Authenticate: Bearer realm="...", error="per_user_authorization_required", authorize_url="..."`.

Claude Desktop and Claude Code SHOULD render the message text and let
the user click the URL. Need to verify this happens consistently
across MCP clients; if not, consider:

- Surfacing the URL as a `resource` link in the JSON-RPC tool error
  payload (richer MCP semantics);
- Making each per-user tool _idempotently_ kick off the OAuth flow via
  DCR when missing the token, the same way the initial Studio login
  works — would eliminate the manual click.

---

### 5. Personal "My Connections" route

`/<org>/me/connections` showing the member only the connections they
can authorise (per-user) with status `connected as you / not yet
connected`, and a single button per row. Enables a member to set up
all their downstream OAuth in one place before opening Claude
Desktop.

Builds on the existing `/oauth-token/status` endpoint (already
scoped by user id since this branch).

---

### 6. Forced reconnect on provider-side revocation

`refreshAccessToken` in `apps/mesh/src/oauth/token-refresh.ts`
already detects permanent failures (RFC 6749 `400 invalid_grant`) and
deletes the cached row. With per-user storage, we can now dispatch a
targeted notification to _just that member_ ("Your Notion connection
expired — reconnect here"). Today the row just disappears silently.

---

### 7. Per-user support for HTTP / STDIO connections with manual tokens

This iteration only covers OAuth-flow connections. For HTTP
connections that authenticate with a manual `connection_token`
(API key pasted by the admin), the token is still org-shared even if
`auth_mode = per_user`. Same story for STDIO (env vars). Two ways
out:

- Add per-user `connection_token` rows (mirroring the
  `downstream_tokens` per-user scheme).
- Or formally restrict the `per_user` switch to OAuth-capable
  connections in the UI and document the limit.

---

### 8. Role design: scope `member` further

> **Status (after `runbooks/strict-rbac/` Phases 1-3 landed):** the
> `member` role is now scoped to read-only on connections / virtual
> MCPs plus its own per-user OAuth tokens. `tools/list` filtering
> and UI hiding both respect this. Remaining gap is per-connection
> grants — see follow-up #2.

The `member` role currently has read access to all connections
(`COLLECTION_CONNECTIONS_LIST`, `COLLECTION_CONNECTIONS_GET`,
`COLLECTION_VIRTUAL_MCP_LIST/GET`) so they can navigate to a
connection and authorise their own per-user token. That's broader
than necessary if you want a member to _only_ see the connections
that an admin explicitly granted them.

Depends on (2) — once we have `connection_access`, the LIST/GET tools
can filter to "only what this user is allowed to see" and the role
itself stays read-only.

---

### 9. Tests for the per-user flow at the integration level

Unit tests landed in `apps/mesh/src/storage/downstream-token.test.ts`.
Missing:

- Integration test in `apps/mesh/src/api/integration-org-scoped.test.ts`
  with two real users authorising the same per_user connection and
  proving isolation through `/mcp/<connection>` calls.
- Test for the proxy's 401 rendering when the user has no token.
- Test that flipping `auth_mode` from `shared` → `per_user` deletes
  the shared row OR leaves it as a fallback (current behaviour:
  leaves it, but resolver doesn't use it in per_user mode).

---

### 10. Roles UI: editing a builtin role 400s with `THAT_ROLE_NAME_IS_ALREADY_TAKEN`

Pre-existing bug, not introduced here, but surfaces during the same QA
flow so it's tracked next to it. Steps to reproduce: navigate to
`/<org>/settings/roles?role=builtin-user`, change any permission,
click Save.

Root cause: when the user first edits a built-in role,
`org-role-detail.tsx:1353-1357` calls
`orgAuth.organization.createRole({ role: formData.role.slug, ... })` to
materialise a custom version in the DB. The slug (`user`, `admin`,
`owner`, and now `member`) is already in the static `roles: {}` map in
`apps/mesh/src/auth/index.ts`, so Better Auth's Dynamic Access Control
rejects the create with
`[Dynamic Access Control] The role name "X" is already taken by a
pre-defined role`.

Workaround: create a brand-new custom role with a different slug
instead of editing the built-in.

Proper fix options:
- The UI namespaces the shadow row (e.g. `user@<orgId>` or
  `user-custom`) on first edit, then merges static + custom on read.
- Or remove the builtins from the static config entirely and bootstrap
  them in the DB on first org creation, letting Dynamic AC own them.

### 11. Documentation in `apps/docs/`

The Studio docs site (`apps/docs/`) doesn't mention per-user
connections. When the feature lands, add a page covering:

- When to choose `shared` vs `per_user`
- The compliance/audit benefits
- Step-by-step for both admin (configure) and member (authorise)
- Trade-offs (provider seat costs, refresh tokens per user)

---

## Notes for whoever picks this back up

- The `feat/per-user-oauth` branch is on a forked-from-`main` working
  tree at `/Users/arioliveira/Aol/studio`. Not pushed anywhere yet.
- A second user `userb@test.local` / `PerUserTest123!` and a Virtual
  MCP `vir_4XeEwycrXgTlCheE9X_Hd` (`Empresa`) exist in the local
  embedded postgres for ad-hoc testing.
- Local dev: `PORT=3100 VITE_PORT=4100 bun run dev --no-tui --no-local-mode`.
  Without `--no-local-mode` the auto-login bypasses the form and you
  can't test as user B.
- Embedded postgres port rotates on each restart. Find it with
  `ps aux | grep "postgres -D" | grep -oE "\-p [0-9]+"`.

---

## Operating the strict access model

After the `runbooks/strict-rbac/` work landed, the contract is:

- **Owner / admin** — full control of org settings, connections,
  virtual MCPs, roles and members.
- **Member** — can: browse connection and virtual-MCP catalogues,
  open a connection to authorise their own per-user OAuth, see
  org info. Cannot: create / edit / delete connections or virtual
  MCPs, invite or remove members, change roles, manage AI
  providers, or access any `/<org>/settings/*` page.
- **Per-connection grants** (future) — admin will be able to scope
  "user X can use connection Y only". Tracked as follow-up #2.
