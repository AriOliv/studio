# Phase 1 — Close the escalation bypass

**Goal.** A user whose org-membership role is `member` cannot
successfully call `ORGANIZATION_MEMBER_UPDATE_ROLE` (or any other
admin-only Studio tool) via MCP/curl/HTTP, regardless of the value of
their `user.role` (the column on the `user` table, managed by Better
Auth's admin plugin).

This phase fixes the actual security bug. Phases 2 and 3 are defence in
depth on top of this.

## Root cause (already validated by the tech lead)

`apps/mesh/src/auth/roles.ts:11`:

```ts
export const BUILTIN_ROLES = ["owner", "admin", "user"] as const;
```

`apps/mesh/src/core/context-factory.ts:246-256` short-circuits
`hasPermission` to `true` whenever the caller's role is in
`BUILTIN_ROLES`:

```ts
if (role && BUILTIN_ROLES.includes(role as (typeof BUILTIN_ROLES)[number])) {
  return true;
}
```

The Better Auth admin plugin (`apps/mesh/src/auth/index.ts:293-296`)
configures `defaultRole: "user"`, so every fresh signup ends up with
`user.role = "user"`. Several code paths inside `context-factory.ts`
(notably the MCP OAuth and API-key paths) end up passing `user.role`
(not the org `member.role`) into `createBoundAuthClient`, so the
`BUILTIN_ROLES` bypass fires for newly-signed-up users even when their
org membership says `"member"`.

The fix is to **remove `"user"` from `BUILTIN_ROLES`**. The legitimate
admin shortcut already lives in `ADMIN_ROLES = ["owner", "admin"]` at
`apps/mesh/src/auth/roles.ts:21`.

## Step 1.1 — Instrument and reproduce

**Add two temporary `console.log` statements and run a curl repro to
confirm the hot path.** This is *temporary instrumentation*. You will
revert these lines in Step 1.5.

### Edit 1: `apps/mesh/src/core/access-control.ts`

Find `private async checkResource(resource: string): Promise<boolean>`
(around line 186) and add the first line of its body:

```ts
private async checkResource(resource: string): Promise<boolean> {
  console.log("[debug:access-control]", {
    resource,
    userId: this.userId,
    role: this.role,
    organizationId: this.organizationId,
    connectionId: this.connectionId,
  });
  // ... existing body unchanged
```

### Edit 2: `apps/mesh/src/core/context-factory.ts`

Find `hasPermission: async (requestedPermission, options) => {` inside
`createBoundAuthClient` (around line 246) and add the first line:

```ts
hasPermission: async (requestedPermission, options) => {
  console.log("[debug:bound-auth]", {
    role,
    requestedPermission,
    options,
    builtinBypass: !!(role && BUILTIN_ROLES.includes(role as (typeof BUILTIN_ROLES)[number])),
  });
  // ... existing body unchanged
```

### Reproduce

Make sure the dev server is running. Restart it after the edits so the
logs take effect:

```bash
cd /Users/arioliveira/Aol/studio
ps aux | grep -E "scripts/dev\.ts|dev:server|dev:client|bun.*src/index\.ts|sandbox-ingress" | grep -v grep | awk '{print $2}' | xargs -I{} kill {} 2>/dev/null
sleep 3
PORT=3200 VITE_PORT=4200 bun run dev --no-tui --no-local-mode > /tmp/studio-dev-phase1.log 2>&1 &
# Wait for it to come up:
until curl -fsS -o /dev/null http://localhost:3200/api/auth/get-session 2>/dev/null; do sleep 1; done
echo "API ready"
```

Then sign in as the seeded member and attempt the escalation:

```bash
# 1. Sign in as userb (member of arioliveira-local)
curl -sS -c /tmp/userb-cookies.txt -X POST http://localhost:3200/api/auth/sign-in/email \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3200" \
  -d '{"email":"userb@test.local","password":"PerUserTest123!"}' -o /dev/null -w "%{http_code}\n"

# 2. Resolve member id + user.role from the local Postgres
cat << 'EOF' | bun run --cwd apps/mesh -
import pg from "pg";
import { execSync } from "child_process";
const port = execSync("ps aux | grep 'studio/.deco' | grep 'postgres -D' | grep -v grep | grep -oE '\\-p [0-9]+' | head -1 | awk '{print $2}'").toString().trim();
const c = new pg.Client(`postgresql://postgres:postgres@localhost:${port}/postgres`);
await c.connect();
const r = await c.query(`
  SELECT m.id AS member_id, m."organizationId" AS org_id, m.role AS member_role,
         u.email, u.role AS user_role
  FROM "member" m JOIN "user" u ON m."userId" = u.id
  WHERE u.email = 'userb@test.local'`);
console.log(r.rows);
await c.end();
EOF

# 3. Attempt escalation (use the org id you found above)
ORG_ID="<paste org_id>"
MEMBER_ID="<paste member_id>"
curl -sS -b /tmp/userb-cookies.txt -X POST "http://localhost:3200/api/arioliveira-local/mcp/${ORG_ID}_self" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Origin: http://localhost:3200" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"ORGANIZATION_MEMBER_UPDATE_ROLE\",\"arguments\":{\"memberId\":\"${MEMBER_ID}\",\"role\":[\"admin\"]}}}"

# 4. Tail the studio log to find the debug lines
grep -E "debug:access-control|debug:bound-auth" /tmp/studio-dev-phase1.log | tail -10
```

### What you should see (smoking gun)

```
[debug:access-control] { resource: "ORGANIZATION_MEMBER_UPDATE_ROLE", role: "user", … }
[debug:bound-auth]     { role: "user", builtinBypass: true, … }
```

If `builtinBypass: true` AND `role: "user"`, the root cause is
confirmed. **Proceed to Step 1.2.**

If `role: "member"` and the call still succeeds → **STOP**. There is
a second bypass we haven't accounted for. Surface to the lead with
the full log lines.

## Step 1.2 — Apply the fix

Edit `apps/mesh/src/auth/roles.ts`:

```ts
/**
 * Built-in roles that have full access bypass at the platform layer.
 *
 * `"user"` is the Better Auth admin-plugin default for every fresh
 * signup — it is NOT an admin role and must not bypass permission
 * checks. Org-scoped admin behaviour lives in `ADMIN_ROLES` below
 * (owner / admin), which is what the bypass should match.
 *
 * Removing `"user"` from this array closes the privilege-escalation
 * path documented in decocms/studio#3388, where a member with
 * `user.role = "user"` could call ORGANIZATION_MEMBER_UPDATE_ROLE
 * and self-promote.
 */
export const BUILTIN_ROLES = ["owner", "admin"] as const;
```

`ADMIN_ROLES` on line 21 stays as-is.

## Step 1.3 — Audit other consumers of `BUILTIN_ROLES`

```bash
grep -rn "BUILTIN_ROLES" /Users/arioliveira/Aol/studio --include="*.ts" --include="*.tsx"
```

Expected hits:

- `apps/mesh/src/auth/roles.ts` — the declaration you just edited.
- `apps/mesh/src/core/context-factory.ts` — the `hasPermission`
  bypass site.

If you find other consumers (e.g. a UI helper showing admin
affordances by checking the array), read them. Removing `"user"`
from the array means new signups before they join any org are no
longer treated as admins anywhere. That is the intended outcome. If
something genuinely relies on the old behaviour, surface to the lead
before proceeding.

## Step 1.4 — Test the fix interactively

Restart the dev server so the change takes effect (`bun --hot` should
pick it up, but a clean restart is safer):

```bash
ps aux | grep -E "scripts/dev\.ts|dev:server|dev:client|bun.*src/index\.ts|sandbox-ingress" | grep -v grep | awk '{print $2}' | xargs -I{} kill {} 2>/dev/null
sleep 3
PORT=3200 VITE_PORT=4200 bun run dev --no-tui --no-local-mode > /tmp/studio-dev-phase1.log 2>&1 &
until curl -fsS -o /dev/null http://localhost:3200/api/auth/get-session 2>/dev/null; do sleep 1; done
```

Re-run the reproduction from Step 1.1 (sign in, curl the escalation
attempt). Expected log:

```
[debug:access-control] { resource: "ORGANIZATION_MEMBER_UPDATE_ROLE", role: "user", … }
[debug:bound-auth]     { role: "user", builtinBypass: false, … }
… falls through to Better Auth hasPermission API …
```

HTTP response body should contain `isError: true` and a Forbidden-ish
message. Check that the DB row is unchanged:

```bash
cat << 'EOF' | bun run --cwd apps/mesh -
import pg from "pg";
import { execSync } from "child_process";
const port = execSync("ps aux | grep 'studio/.deco' | grep 'postgres -D' | grep -v grep | grep -oE '\\-p [0-9]+' | head -1 | awk '{print $2}'").toString().trim();
const c = new pg.Client(`postgresql://postgres:postgres@localhost:${port}/postgres`);
await c.connect();
const r = await c.query(`SELECT role FROM "member" WHERE id = '<MEMBER_ID>'`);
console.log(r.rows);
await c.end();
EOF
# Expect: [{ role: "member" }]
```

## Step 1.5 — Remove instrumentation

Open the same two files you edited in Step 1.1 and **delete the two
`console.log` statements**. Save.

`bun --hot` should pick the change up live. Confirm by re-running the
escalation curl one more time and grep'ing the log:

```bash
grep -E "debug:access-control|debug:bound-auth" /tmp/studio-dev-phase1.log | tail
# Expected: no new lines after the timestamp of this re-run
```

## Step 1.6 — Regression test

Add a test to `apps/mesh/src/api/integration-org-scoped.test.ts`.
Search the file for an existing test that uses session cookies (e.g.
`it("oauth-proxy refuses slug-spoofing"`) to find the local helpers
for app + DB setup. The pattern below is a guide; **adapt to the
actual helpers available in that file**:

```ts
it("member cannot self-promote via ORGANIZATION_MEMBER_UPDATE_ROLE", async () => {
  const { db, app } = await setupTestApp();   // pre-existing helper
  const orgId = "org_phase1";
  const memberRowId = "member_phase1_member";

  await seedOrg(db, { id: orgId, slug: "org-phase1" });
  await seedUser(db, { id: "user_owner_phase1", email: "owner@phase1.test" });
  await seedUser(db, { id: "user_member_phase1", email: "member@phase1.test" });
  await seedMembership(db, {
    id: "member_phase1_owner",
    userId: "user_owner_phase1",
    organizationId: orgId,
    role: "owner",
  });
  await seedMembership(db, {
    id: memberRowId,
    userId: "user_member_phase1",
    organizationId: orgId,
    role: "member",
  });

  const cookies = await signIn(app, "member@phase1.test");

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
        method: "tools/call",
        params: {
          name: "ORGANIZATION_MEMBER_UPDATE_ROLE",
          arguments: { memberId: memberRowId, role: ["admin"] },
        },
      }),
    },
  ));

  const body = (await res.json()) as { result?: { isError?: boolean } };
  expect(body.result?.isError ?? false).toBe(true);
  expect(JSON.stringify(body)).toMatch(/forbid|denied|access/i);

  const after = await db
    .selectFrom("member")
    .select("role")
    .where("id", "=", memberRowId)
    .executeTakeFirst();
  expect(after?.role).toBe("member");
});
```

Run the file:

```bash
bun test apps/mesh/src/api/integration-org-scoped.test.ts
```

If the helpers `seedOrg`/`seedUser`/`seedMembership`/`signIn` don't
exist with those names, find the equivalents in the test file (look
near the top for shared fixture setup) and adapt. Don't invent new
helpers — reuse existing patterns.

## Step 1.7 — Belt-and-suspenders verification

Even after the BUILTIN_ROLES fix, Better Auth's organization plugin
should *independently* reject the call because the `member` role's
statements
(`organization: [], member: [], invitation: [], team: [], ac: ["read"]`)
forbid `member:update`. Verify by adding a one-shot test in the same
file:

```ts
it("better-auth statements alone deny member:update for member role", async () => {
  // Construct a member-role context and call auth.api.hasPermission directly.
  // Expected: { success: false }.
  // …
});
```

If you can't reproduce that result, the org-plugin gate is leaky too
— escalate to the lead. The runbook assumes this gate works.

## Commit message (use verbatim)

```
fix(auth): remove `user` from BUILTIN_ROLES to close member escalation

Fixes decocms/studio#3388. Better Auth's admin plugin defaults every
fresh signup to `user.role = "user"`. `createBoundAuthClient.hasPermission`
short-circuited `true` for any role in `BUILTIN_ROLES`, so the bypass
fired for every newly-signed-up user even when their org membership
role was `"member"` — they could call admin-only MCP tools (e.g.
ORGANIZATION_MEMBER_UPDATE_ROLE) and self-promote.

- Drop `"user"` from BUILTIN_ROLES. Legitimate admin checks already
  use `ADMIN_ROLES = ["owner", "admin"]`; the `"user"` entry was
  effectively wildcard access for any signed-in user.
- Add integration test asserting a member cannot self-promote.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Commit with:

```bash
bun run fmt
git add apps/mesh/src/auth/roles.ts apps/mesh/src/api/integration-org-scoped.test.ts
git commit
# paste the message above
```

## Phase 1 verification gate

**Do not start Phase 2 until every box is ticked.**

- [ ] `bun run check` clean.
- [ ] `bun run lint` clean.
- [ ] `bun test apps/mesh/src/api/integration-org-scoped.test.ts`
      passes including the new test.
- [ ] `bun test apps/mesh/src/storage apps/mesh/src/oauth apps/mesh/src/mcp-clients apps/mesh/src/tools/connection`
      still passes (197+ tests; nothing regressed).
- [ ] Manual reproduction from Step 1.4 returns Forbidden, DB row
      unchanged.
- [ ] No `console.log("[debug:...")` left in the diff
      (`git diff main..HEAD | grep "debug:"` returns nothing).
- [ ] Commit landed on `feat/per-user-oauth`.

Report to lead → wait for green light → proceed to **Phase 2**.
