# Phase 3 — UI hiding

**Goal.** When a member opens the Studio web UI, admin-only sidebar
items, action buttons, and tabs **do not render**. Admin-only routes
**redirect** with a toast. The per-user OAuth "Connect your account"
CTA remains visible because members need it.

This is defence in depth. The backend already enforces (Phase 1) and
the MCP catalogue is filtered (Phase 2). Phase 3 makes the product
feel coherent.

## Step 3.1 — Single source of truth hook

Create `apps/mesh/src/web/hooks/use-current-member-role.ts`:

```ts
/**
 * Resolve the current viewer's role within the active org.
 *
 * Returns booleans for the rest of the UI to consume — components
 * never compare role strings directly. Adding/removing roles later
 * is a one-file change here.
 *
 * `role === null` means we haven't resolved yet (loading) or the
 * caller is not a member of the active org. In both cases callers
 * should default to the most restrictive UI (treat as a non-member).
 */

import { authClient } from "@/web/lib/auth-client";
import { useMembers } from "@/web/hooks/use-members";

export function useCurrentMemberRole() {
  const { data: session } = authClient.useSession();
  const { data: membersData } = useMembers();

  const members = (membersData?.data?.members ?? []) as Array<{
    userId: string;
    role: string;
  }>;
  const me = members.find((m) => m.userId === session?.user?.id);
  const role = me?.role ?? null;

  const isOwner = role === "owner";
  const isAdmin = role === "admin";
  const isMember = role === "member";
  const isAdminOrOwner = isOwner || isAdmin;

  return {
    userId: session?.user?.id ?? null,
    role,
    isOwner,
    isAdmin,
    isMember,
    isAdminOrOwner,
    // Permission booleans — components consume these.
    canManageOrg: isAdminOrOwner,
    canManageConnections: isAdminOrOwner,
    canManageVirtualMcps: isAdminOrOwner,
    canManageMembers: isAdminOrOwner,
    canEditRoles: isAdminOrOwner,
    canManageAIProviders: isAdminOrOwner,
    /** Members can authorise their own per-user OAuth connections. */
    canConnectOwnAccount: !!role,
  };
}
```

**Heads-up on dependencies.** Confirm
`apps/mesh/src/web/hooks/use-members.ts` exists and exposes the shape
`{ data: { members: [...] } }` shown above. If the shape differs,
adapt the destructuring. If the hook doesn't exist, find the
equivalent (search `grep -rn "listMembers" apps/mesh/src/web/`).

## Step 3.2 — Sidebar gates

Open `apps/mesh/src/web/components/sidebar/footer/inbox.tsx`. Find
where `SettingsButton` and `ConnectionsButton` are rendered (around
lines 232 and 312 per the exploration notes). Gate them:

```tsx
import { useCurrentMemberRole } from "@/web/hooks/use-current-member-role";

// inside the footer component
const { canManageOrg } = useCurrentMemberRole();

// in the JSX
{canManageOrg && <SettingsButton ... />}
{/* ConnectionsButton stays visible — members need to see the list
    to authorise their own per-user OAuth connections. Only the
    "+ New Connection" CTA inside the page is admin-only (Step 3.5). */}
<ConnectionsButton ... />
```

Then search the sidebar tree (
`grep -rn "settings/roles\|settings/members\|settings/ai-providers\|settings/general" apps/mesh/src/web/components/sidebar/ apps/mesh/src/web/layouts/org-shell-layout/`
) and gate any nav entry pointing at:

- `/<org>/settings/roles`
- `/<org>/settings/members`
- `/<org>/settings/ai-providers`
- `/<org>/settings/general`

Wrap with `{canManageOrg && ...}`.

## Step 3.3 — Route loaders for admin-only pages

TanStack Router uses `beforeLoad` for guards. For each file:

- `apps/mesh/src/web/routes/orgs/settings/roles.tsx`
- `apps/mesh/src/web/routes/orgs/settings/members.tsx`
- `apps/mesh/src/web/routes/orgs/settings/ai-providers/*` (every
  route file under that folder)
- Any other `settings/*.tsx` route that mutates state

Add the guard via a small helper to avoid duplication. Create
`apps/mesh/src/web/lib/require-admin-role.ts`:

```ts
import { redirect } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "@/web/lib/auth-client";

/**
 * Use inside a TanStack Router `beforeLoad`. Redirects non-admins to
 * the org home and shows a toast. Throws redirect (TanStack Router
 * convention) on denial.
 */
export async function requireAdminRole(params: { org: string }) {
  // Fetch the current org's members. authClient.organization.listMembers
  // honours the session cookie and is already TanStack-Query-cached
  // elsewhere.
  const session = await authClient.getSession();
  if (!session?.data?.user) {
    throw redirect({ to: "/login" });
  }
  const me = await authClient.organization.listMembers().then(
    (r) =>
      (r?.data?.members ?? []).find(
        (m: { userId: string }) => m.userId === session.data.user.id,
      ) as { role?: string } | undefined,
  );
  const role = me?.role;
  if (role !== "owner" && role !== "admin") {
    toast.error("You don't have access to this page.");
    throw redirect({ to: "/$org", params: { org: params.org } });
  }
}
```

In each admin-only route file add:

```tsx
import { requireAdminRole } from "@/web/lib/require-admin-role";

export const Route = createFileRoute("/orgs/$org/settings/roles")({
  // … existing options …
  beforeLoad: async ({ params }) => {
    await requireAdminRole({ org: params.org });
  },
});
```

If a file already has a `beforeLoad`, call `requireAdminRole` inside
it before the existing logic.

**Pitfall.** `authClient.organization.listMembers` may require an
active org cookie that hasn't been set yet on first nav. If you see
a flicker (redirect → page → redirect), add a `loader` that
pre-fetches the org membership and uses TanStack Query to dedupe.

## Step 3.4 — Connection detail tabs and buttons

`apps/mesh/src/web/components/details/connection/index.tsx` has tabs
(Capabilities, Activity, Settings, Agents, etc) around the area that
imports `Tabs`/`TabsTrigger` from `@deco/ui/components/tabs.tsx`. Also
search for the delete button (the exploration noted line ~544-548):

```tsx
import { useCurrentMemberRole } from "@/web/hooks/use-current-member-role";

// inside the component
const { canManageConnections } = useCurrentMemberRole();

// Settings tab — gate the trigger AND the panel
{canManageConnections && <TabsTrigger value="settings">Settings</TabsTrigger>}
{canManageConnections && (
  <TabsContent value="settings">
    {/* … */}
  </TabsContent>
)}

// Destructive buttons (Delete connection, Delete instance, etc.)
{canManageConnections && (
  <Button variant="destructive" onClick={handleDelete}>
    Delete
  </Button>
)}
```

`OAuthAuthenticationState` in
`apps/mesh/src/web/components/details/connection/settings-tab/index.tsx`
(the per-user "Connect your account" empty state) must **remain
visible to members** — that is their self-service entry. Do not gate
that component.

## Step 3.5 — Connection list & virtual MCP list

`apps/mesh/src/web/routes/orgs/connections.tsx`:

```tsx
const { canManageConnections } = useCurrentMemberRole();

{canManageConnections && (
  <Button onClick={() => setCreateOpen(true)}>+ New connection</Button>
)}
```

Search for the virtual MCP list page and apply the same pattern:

```bash
grep -rn "Virtual.*MCP\|virtual-mcp\b" apps/mesh/src/web/routes/orgs/
```

Gate "+ New Virtual MCP", delete and edit buttons.

## Step 3.6 — Member invitation dialog

`apps/mesh/src/web/components/invite-member-dialog.tsx` is opened
from the members page (already gated by the route loader in Step
3.3). Add a belt-and-suspenders gate at the trigger render site too,
so even if a route guard misfires the dialog is unreachable from the
sidebar:

```tsx
const { canManageMembers } = useCurrentMemberRole();

{canManageMembers && (
  <Button onClick={() => setInviteOpen(true)}>+ Invite member</Button>
)}
```

## Step 3.7 — Toast and graceful degradation

Toast is already wired in `requireAdminRole`. Double-check that
rapid back/forward navigation doesn't fire repeated toasts. If it
does (visible regression during smoke testing), wrap the toast call
with a per-route key (e.g. session-storage marker that clears after
3 seconds).

## Manual verification

With dev running and **two browser sessions**:

1. **Owner** (`arioliveira@localhost.mesh` / `local-mode-default`) in
   one window:
   - Sidebar shows Settings.
   - `/<org>/settings/roles` loads, "+ New role" visible.
   - Connection list page shows "+ New connection".
   - Connection detail shows the Settings tab.
2. **Member** (`userb@test.local` / `PerUserTest123!`) in incognito:
   - Sidebar does **not** show Settings.
   - Visit
     `http://localhost:3200/arioliveira-local/settings/roles`
     directly → redirects to org home with the "You don't have
     access to this page." toast.
   - Connection list page shows **no** "+ New connection" button.
   - Connection detail shows only Capabilities + Activity tabs (and
     the "Connect your account" CTA on per_user connections).

## Commit message (use verbatim)

```
feat(auth): hide admin-only UI affordances from members

Adds a useCurrentMemberRole hook with permission booleans and gates
sidebar items, route loaders, connection tabs and action buttons
behind those booleans. Members see only what they can operate on —
Capabilities/Activity tabs, the per-user OAuth Connect CTA, and
read-only connection / virtual MCP listings. Admin-only pages
(roles, members, AI providers) redirect to org home with a toast.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Commit with:

```bash
bun run fmt
git add apps/mesh/src/web/hooks/use-current-member-role.ts \
        apps/mesh/src/web/lib/require-admin-role.ts \
        apps/mesh/src/web/components/sidebar \
        apps/mesh/src/web/layouts/org-shell-layout \
        apps/mesh/src/web/routes/orgs \
        apps/mesh/src/web/components/details/connection \
        apps/mesh/src/web/components/invite-member-dialog.tsx
git commit
```

(Add or remove paths above based on what you actually edited.)

## Phase 3 verification gate

- [ ] `bun run check && bun run lint` clean.
- [ ] Manual: member browser shows no Settings tile, no "+ New"
      buttons, no Settings tab on connection detail.
- [ ] Manual: visiting `/<org>/settings/roles` as member redirects
      with toast.
- [ ] Manual: owner browser is unchanged — every nav, tab, button
      still works.
- [ ] No regressions in `bun test`.
- [ ] Commit landed.

Report to lead → wait for green light → proceed to **Phase 4**.
