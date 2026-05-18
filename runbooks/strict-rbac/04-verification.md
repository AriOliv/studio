# Phase 4 — Cross-phase manual verification

**Goal.** Confirm end-to-end that the three previous phases compose
correctly. Done only after Phase 3 is committed.

## Setup

Start the dev server fresh (Phase 1's instrumentation leftovers, if
any, would have been removed already):

```bash
cd /Users/arioliveira/Aol/studio

# Kill any stale studio processes
ps aux | grep -E "scripts/dev\.ts|dev:server|dev:client|bun.*src/index\.ts|sandbox-ingress" | grep -v grep | awk '{print $2}' | xargs -I{} kill {} 2>/dev/null
sleep 3

# Start
PORT=3200 VITE_PORT=4200 bun run dev --no-tui --no-local-mode > /tmp/studio-dev-phase4.log 2>&1 &

# Wait for ready
until curl -fsS -o /dev/null http://localhost:3200/api/auth/get-session 2>/dev/null; do sleep 1; done
echo "API ready at http://localhost:3200"
```

Open two browsers / two profiles:

- **Browser A** signed in as
  `arioliveira@localhost.mesh` / `local-mode-default` (owner).
- **Browser B** (incognito) signed in as
  `userb@test.local` / `PerUserTest123!` (member).

## Checks for Browser A (owner)

- [ ] Sidebar shows the Settings tile.
- [ ] `/arioliveira-local/settings/roles` loads. "+ New role" button
      visible.
- [ ] `/arioliveira-local/settings/members` loads. "+ Invite member"
      button visible.
- [ ] `/arioliveira-local/connections` loads. "+ New connection"
      button visible.
- [ ] Open any existing connection. Settings tab is visible. Delete
      button visible.

## Checks for Browser B (member)

- [ ] Sidebar does **not** show the Settings tile.
- [ ] Visiting
      `http://localhost:3200/arioliveira-local/settings/roles`
      directly redirects to the org home with a toast that says
      "You don't have access to this page."
- [ ] Same redirect/toast for `/settings/members` and
      `/settings/ai-providers/*`.
- [ ] `/arioliveira-local/connections` loads — but the
      "+ New connection" button is absent.
- [ ] Opening a connection: Settings tab is **absent**. Capabilities
      and Activity tabs are visible. On per_user connections, the
      "Connect your account" CTA still works.

## Backend checks (curl, member session)

Re-use the cookie jar from Phase 1:

```bash
# Refresh login
curl -sS -c /tmp/userb-cookies.txt -X POST http://localhost:3200/api/auth/sign-in/email \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3200" \
  -d '{"email":"userb@test.local","password":"PerUserTest123!"}' -o /dev/null -w "%{http_code}\n"

# Org id
ORG_ID="ffjfkVwbl6o1LR8PXXzXn5poGAXICbP5"   # arioliveira-local

# tools/list — should be a strict subset
curl -sS -b /tmp/userb-cookies.txt -X POST "http://localhost:3200/api/arioliveira-local/mcp/${ORG_ID}_self" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Origin: http://localhost:3200" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | python3 -c "
import sys, re
d = sys.stdin.read()
names = re.findall(r'\"name\":\"([A-Z_]+)\"', d)
denied = ['ORGANIZATION_MEMBER_UPDATE_ROLE','COLLECTION_CONNECTIONS_CREATE','COLLECTION_VIRTUAL_MCP_CREATE','COLLECTION_VIRTUAL_MCP_UPDATE','COLLECTION_VIRTUAL_MCP_DELETE','ORGANIZATION_DELETE','ORGANIZATION_UPDATE']
print(f'total tools: {len(set(names))}')
for n in denied:
    print(f'  {n} present? {n in names}')
"

# Escalation attempt — should be Forbidden, DB unchanged
MEMBER_ID="b4fac5e40d6c172e9b2d2fb69c78a06b"   # userb's member row id
curl -sS -b /tmp/userb-cookies.txt -X POST "http://localhost:3200/api/arioliveira-local/mcp/${ORG_ID}_self" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Origin: http://localhost:3200" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"ORGANIZATION_MEMBER_UPDATE_ROLE\",\"arguments\":{\"memberId\":\"${MEMBER_ID}\",\"role\":[\"admin\"]}}}" \
  | head -c 800
```

Verify DB row unchanged:

```bash
cat << 'EOF' | bun run --cwd apps/mesh -
import pg from "pg";
import { execSync } from "child_process";
const port = execSync("ps aux | grep 'studio/.deco' | grep 'postgres -D' | grep -v grep | grep -oE '\\-p [0-9]+' | head -1 | awk '{print $2}'").toString().trim();
const c = new pg.Client(`postgresql://postgres:postgres@localhost:${port}/postgres`);
await c.connect();
const r = await c.query(`SELECT u.email, m.role FROM "member" m JOIN "user" u ON m."userId"=u.id WHERE m."organizationId"='ffjfkVwbl6o1LR8PXXzXn5poGAXICbP5'`);
console.log(r.rows);
await c.end();
EOF
# Expect: owner=arioliveira@localhost.mesh, member=userb@test.local
```

Per-user OAuth flow must still work for members:

- In Browser B, open
  `http://localhost:3200/arioliveira-local/settings/connections/google-calendar`
  (or any per_user connection). The "Connect your Google Calendar
  account" empty state must still render. Clicking the button should
  start the OAuth flow as expected — that's the regression test for
  not over-gating.

## Failure handling

- Any owner-side regression → revert the latest commit, surface to
  lead.
- Any member-side bypass (e.g. the redirect doesn't fire on a
  specific URL) → log the URL and behaviour, surface.
- Any test that was green before now fails → bisect with
  `git bisect` between Phase 1's commit and current HEAD.

## Phase 4 verification gate

- [ ] Every check in the Browser A and Browser B lists above passes.
- [ ] All listed denied tools are absent in member `tools/list`.
- [ ] Escalation curl returns Forbidden and DB unchanged.
- [ ] Per-user OAuth flow still functional for members.
- [ ] `bun test` (whole repo, or at minimum the targeted suites)
      green.

Report to lead → wait for green light → proceed to **Phase 5**.
