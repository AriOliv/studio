# Phase 2 — Filter `tools/list` by caller role

**Goal.** When a `member` calls `tools/list` on the management MCP at
`/api/<org>/mcp/<org-id>_self` or against a Virtual MCP aggregator,
the response includes only tools their role is allowed to execute.

This is the catalogue-hiding layer. Phase 1 already gates tool *
execution*. Without Phase 2, a member's MCP client (Claude Desktop /
Claude Code / Cursor) sees admin tools in the catalogue, attempts to
call them, and fails with Forbidden — confusing UX. With Phase 2 they
don't appear at all.

## Step 2.1 — Helper to compute allowed tools

Create `apps/mesh/src/auth/role-tools.ts`:

```ts
/**
 * Resolve which Studio management-MCP tools a given role can call.
 *
 * - "owner" / "admin" → all tools.
 * - "user" → all tools. (Brand-new signups before they join an org;
 *            after Phase 1 they no longer bypass at the access-check
 *            layer, but the catalogue can still show them everything
 *            so they can bootstrap their first org.)
 * - "member" → the narrow `self:` array defined for the member role
 *              in `apps/mesh/src/auth/index.ts`, plus
 *              `BASIC_USAGE_TOOLS` from
 *              `apps/mesh/src/tools/registry-metadata.ts`.
 * - Anything else → `BASIC_USAGE_TOOLS` only.
 *
 * Returned shape lets callers branch cheaply:
 *   { mode: "all" } → skip filtering entirely (cheap path).
 *   { mode: "explicit", names } → Array.filter on response.
 */

import { ADMIN_ROLES } from "./roles";
import { BASIC_USAGE_TOOLS } from "../tools/registry-metadata";

/**
 * Member's allowed surface — keep this list in sync with the `member`
 * role's `self:` array in `auth/index.ts`. The integration test in
 * Step 2.4 imports MEMBER_SELF_TOOLS to assert parity.
 */
export const MEMBER_SELF_TOOLS = [
  "COLLECTION_CONNECTIONS_LIST",
  "COLLECTION_CONNECTIONS_GET",
  "COLLECTION_VIRTUAL_MCP_LIST",
  "COLLECTION_VIRTUAL_MCP_GET",
  "ORGANIZATION_LIST",
  "ORGANIZATION_GET",
  "ORGANIZATION_MEMBER_LIST",
  "API_KEY_CREATE",
  "API_KEY_LIST",
] as const;

export type AllowedTools =
  | { mode: "all" }
  | { mode: "explicit"; names: Set<string> };

export function getAllowedToolsForRole(
  role: string | undefined | null,
): AllowedTools {
  if (!role) {
    // Anonymous / unmapped → no access. The route should already
    // have refused at session auth, but be defensive.
    return { mode: "explicit", names: new Set() };
  }

  if (
    ADMIN_ROLES.includes(role as (typeof ADMIN_ROLES)[number]) ||
    role === "user"
  ) {
    return { mode: "all" };
  }

  if (role === "member") {
    return {
      mode: "explicit",
      names: new Set<string>([...MEMBER_SELF_TOOLS, ...BASIC_USAGE_TOOLS]),
    };
  }

  // Custom Dynamic AC roles: fall back to BASIC_USAGE_TOOLS. Reading
  // their permission column to compute a precise set is out of scope
  // for this phase (the agent can pull it in when needed).
  return { mode: "explicit", names: new Set<string>(BASIC_USAGE_TOOLS) };
}
```

## Step 2.2 — Wrap the management MCP `tools/list` handler

In `apps/mesh/src/api/routes/proxy.ts`, find the `/mcp/<id>_self`
branch (around lines 75-99). It does:

```ts
const server = await managementMCP(ctx);
const transport = new WebStandardStreamableHTTPServerTransport({ ... });
await server.connect(transport);
const response = await transport.handleRequest(c.req.raw);
return guardResponseStream(response, `mcp:self:${connectionId}`);
```

You will add a filter step **between** `managementMCP(ctx)` and
`server.connect(transport)`:

```ts
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getAllowedToolsForRole } from "../../auth/role-tools";

// inside the route handler
const server = await managementMCP(ctx);

// PHASE 2: filter tools/list by caller role.
const allowed = getAllowedToolsForRole(ctx.access.getRole?.() ?? null);
if (allowed.mode === "explicit") {
  const allowedNames = allowed.names;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The MCP SDK keeps the registered tools internally. Pull them
    // out and filter. See "Plan A vs Plan B" below if the SDK does
    // not expose a clean accessor on this version.
    const all = await server.listTools();
    return {
      tools: all.tools.filter((t) => allowedNames.has(t.name)),
    };
  });
}

const transport = new WebStandardStreamableHTTPServerTransport({ ... });
await server.connect(transport);
```

### Plan A vs Plan B — which `listTools` accessor

The MCP SDK ships with subtle accessor differences between versions.
**Before coding, run**:

```bash
grep -rn "listTools\b\|setRequestHandler" \
  node_modules/.bun/@modelcontextprotocol+sdk*/node_modules/@modelcontextprotocol/sdk/dist/esm/server/*.js \
  | head -40
```

- **Plan A (preferred).** `server.listTools()` (or
  `server.getRegisteredTools()`) returns the registered list. Use the
  diff above as-is.
- **Plan B.** No accessor exists on this version. In that case
  refactor `managementMCP(ctx)` in `apps/mesh/src/tools/index.ts`
  (around lines 197-397) to accept an optional second argument
  `toolFilter?: (name: string) => boolean`. Skip
  `server.registerTool(name, …)` when `toolFilter` rejects the name.
  The proxy then computes the filter from
  `getAllowedToolsForRole` and passes it:
  ```ts
  const allowed = getAllowedToolsForRole(ctx.access.getRole?.() ?? null);
  const filter = allowed.mode === "all"
    ? undefined
    : (name: string) => allowed.names.has(name);
  const server = await managementMCP(ctx, filter);
  ```
  Keep this option as a fallback — Plan A is cleaner because it
  doesn't change the `managementMCP` signature.

If neither works (the SDK on this version actively prevents post-hoc
filtering), **stop** and escalate to the lead.

## Step 2.3 — Virtual MCP aggregator

In `apps/mesh/src/api/routes/virtual-mcp.ts`, after the aggregator
server is assembled and before `server.connect(transport)` (around
the section ending at line ~200), add the same kind of wrapper. For
now it's a no-op — we don't have per-connection grants yet — but the
scaffold lives here so the next phase can drop in the real filter.

```ts
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getAllowedToolsForRole } from "../../auth/role-tools";

// after the server is built
const allowed = getAllowedToolsForRole(ctx.access.getRole?.() ?? null);
if (allowed.mode === "explicit") {
  // TODO(per-connection-grants): once apps/mesh has a
  // connection_access table (PER_USER_OAUTH.md follow-up #2), filter
  // the aggregator's tools[] to drop tools whose gatewayClientId is
  // not allow-listed for ctx.access.getRole() / ctx.auth.user.id.
  //
  // Until then, members get the full aggregator surface. Execution
  // checks at each downstream connection still apply.
  void allowed;
}
```

Yes, you're writing what is currently a no-op. That is intentional —
it documents the seam and gives the next phase a one-file edit.

## Step 2.4 — Integration test for `tools/list` filtering

Add to `apps/mesh/src/api/integration-org-scoped.test.ts`. Reuse the
same fixtures you set up in Phase 1's regression test.

```ts
import { MEMBER_SELF_TOOLS } from "../auth/role-tools";

it("member tools/list excludes admin-only management tools", async () => {
  const { db, app } = await setupTestApp();
  // … seed org, owner, member rows as in the Phase 1 test …

  const memberCookie = await signIn(app, "member@phase1.test");
  const ownerCookie = await signIn(app, "owner@phase1.test");

  const callList = async (cookies: string) => {
    const res = await app.fetch(new Request(
      `http://test.local/api/org-phase1/mcp/${orgId}_self`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: cookies,
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      },
    ));
    const body = (await res.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    return new Set<string>((body.result?.tools ?? []).map((t) => t.name));
  };

  const memberTools = await callList(memberCookie);
  const ownerTools = await callList(ownerCookie);

  // Member must NOT see admin-only mutators
  expect(memberTools.has("ORGANIZATION_MEMBER_UPDATE_ROLE")).toBe(false);
  expect(memberTools.has("COLLECTION_CONNECTIONS_CREATE")).toBe(false);
  expect(memberTools.has("COLLECTION_VIRTUAL_MCP_CREATE")).toBe(false);

  // Member SEES allowed tools
  for (const t of MEMBER_SELF_TOOLS) {
    expect(memberTools.has(t)).toBe(true);
  }

  // Owner sees everything (or at least, strictly more)
  expect(ownerTools.size).toBeGreaterThan(memberTools.size);
  expect(ownerTools.has("ORGANIZATION_MEMBER_UPDATE_ROLE")).toBe(true);
});
```

Run:

```bash
bun test apps/mesh/src/api/integration-org-scoped.test.ts
```

## Manual verification (in addition to tests)

With dev running:

```bash
# Sign in as member
curl -sS -c /tmp/userb-cookies.txt -X POST http://localhost:3200/api/auth/sign-in/email \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3200" \
  -d '{"email":"userb@test.local","password":"PerUserTest123!"}' -o /dev/null

# Find org id
ORG_ID="ffjfkVwbl6o1LR8PXXzXn5poGAXICbP5"   # arioliveira-local org id

# tools/list as member
curl -sS -b /tmp/userb-cookies.txt -X POST "http://localhost:3200/api/arioliveira-local/mcp/${ORG_ID}_self" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Origin: http://localhost:3200" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | python3 -c "import sys,json,re; d=sys.stdin.read(); names=re.findall(r'\"name\":\"([A-Z_]+)\"', d); print(f'{len(set(names))} tools'); print('has UPDATE_ROLE?', 'ORGANIZATION_MEMBER_UPDATE_ROLE' in names)"
```

Expected: a smaller count than the admin sees, and
`has UPDATE_ROLE? False`.

## Commit message (use verbatim)

```
feat(auth): filter tools/list by caller role on the management MCP

Members no longer see admin-only tools (organization mutators,
connection CRUD, virtual MCP CRUD, etc.) when their MCP client calls
tools/list against /api/<org>/mcp/<org>_self. Execution-time gates at
defineTool remain — this is the catalogue-hiding layer.

- New helper apps/mesh/src/auth/role-tools.ts mapping role → tool set.
- Wrap ListToolsRequestSchema in proxy.ts when the caller is not
  owner/admin/user. Virtual MCP aggregator gets the same scaffold,
  no-op until per-connection grants land.
- Integration test asserts members see a strict subset and owners
  still see everything.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Commit with:

```bash
bun run fmt
git add apps/mesh/src/auth/role-tools.ts apps/mesh/src/api/routes/proxy.ts apps/mesh/src/api/routes/virtual-mcp.ts apps/mesh/src/api/integration-org-scoped.test.ts
git commit
```

## Phase 2 verification gate

- [ ] `bun run check && bun run lint` clean.
- [ ] `bun test apps/mesh/src/api/integration-org-scoped.test.ts`
      passes including the new test.
- [ ] `bun test apps/mesh/src/storage apps/mesh/src/oauth apps/mesh/src/mcp-clients apps/mesh/src/tools/connection`
      still passes.
- [ ] Manual: member `tools/list` returns a strict subset versus
      owner's. `ORGANIZATION_MEMBER_UPDATE_ROLE` missing for member.
- [ ] Calling a filtered-out tool by name as a member still returns
      Forbidden (Phase 1 enforcement is still doing its job; filter
      is defence in depth on top of it, not a replacement).
- [ ] Commit landed.

Report to lead → wait for green light → proceed to **Phase 3**.
