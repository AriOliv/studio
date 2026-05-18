# TASKS — strict-rbac runbook

The single checklist the implementer ticks as they go. Update this
file (commit it) at every phase boundary so the lead sees progress at
a glance.

Order is binding. **Do not start a phase until the previous phase's
verification gate is green and the lead has signed off.**

---

## Phase 0 — Remote topology

- [ ] Local tree clean (`git status -s` empty).
- [ ] `git remote rename origin upstream`.
- [ ] `git remote add origin https://github.com/AriOliv/studio.git`.
- [ ] `git remote -v` shows both remotes as expected.
- [ ] `git push -u origin feat/per-user-oauth` succeeded.
- [ ] Branch visible at https://github.com/AriOliv/studio/branches.

→ Surface to lead.

---

## Phase 1 — Close the escalation bypass

### Repro + fix

- [ ] Added the two temporary `console.log` lines (access-control.ts,
      context-factory.ts).
- [ ] Restarted dev server.
- [ ] Reproduced escalation via curl. Captured the log lines proving
      `builtinBypass: true, role: "user"`.
- [ ] Removed `"user"` from `BUILTIN_ROLES` in
      `apps/mesh/src/auth/roles.ts`.
- [ ] Audited other consumers via `grep -rn "BUILTIN_ROLES"`. No
      unexpected breakage.
- [ ] Re-ran the curl — now Forbidden, DB unchanged.
- [ ] Removed the two `console.log` lines.
- [ ] Final grep confirms no `debug:` string in the diff.

### Test

- [ ] Added regression test in
      `apps/mesh/src/api/integration-org-scoped.test.ts`:
      "member cannot self-promote via ORGANIZATION_MEMBER_UPDATE_ROLE".
- [ ] Added belt-and-suspenders test for Better Auth statements.
- [ ] `bun test apps/mesh/src/api/integration-org-scoped.test.ts`
      passes.

### Validate

- [ ] `bun run check` clean.
- [ ] `bun run lint` clean.
- [ ] `bun run fmt` applied.
- [ ] Targeted test suites still pass
      (`bun test apps/mesh/src/storage apps/mesh/src/oauth apps/mesh/src/mcp-clients apps/mesh/src/tools/connection`).

### Commit

- [ ] Commit landed with exact message from `01-escalation-fix.md`
      § Commit message.

→ Surface to lead. **Wait for green light.**

---

## Phase 2 — Filter tools/list by caller role

### Code

- [ ] Created `apps/mesh/src/auth/role-tools.ts` with
      `getAllowedToolsForRole` and `MEMBER_SELF_TOOLS`.
- [ ] Wrapped `ListToolsRequestSchema` in
      `apps/mesh/src/api/routes/proxy.ts` for the `/mcp/<id>_self`
      branch. (Plan A or, if necessary, Plan B as documented.)
- [ ] Same scaffold (no-op for now, TODO comment) in
      `apps/mesh/src/api/routes/virtual-mcp.ts`.

### Test

- [ ] Added integration test:
      "member tools/list excludes admin-only management tools".
- [ ] Test passes.

### Manual verify

- [ ] curl as member returns a strict subset.
- [ ] `ORGANIZATION_MEMBER_UPDATE_ROLE` missing from member's list.
- [ ] Member calling a filtered-out tool by name still gets Forbidden
      (Phase 1 gate intact).

### Validate

- [ ] `bun run check && bun run lint && bun run fmt` clean.
- [ ] Test suites still green.

### Commit

- [ ] Commit landed with exact message from `02-tools-list-filter.md`.

→ Surface to lead. **Wait for green light.**

---

## Phase 3 — UI hiding

### Code

- [ ] Created `apps/mesh/src/web/hooks/use-current-member-role.ts`.
- [ ] Created `apps/mesh/src/web/lib/require-admin-role.ts`.
- [ ] Sidebar: gated `SettingsButton`. Connection-related nav items
      gated as needed.
- [ ] Route loaders added on
      `routes/orgs/settings/{roles,members,ai-providers/*,general}.tsx`.
- [ ] Connection detail: `Settings` tab gated; delete and edit
      buttons gated.
- [ ] Connection list page: "+ New connection" gated.
- [ ] Virtual MCP list page: create/delete/edit gated.
- [ ] Member invitation dialog trigger gated.

### Manual verify

- [ ] As member: no Settings tile in sidebar.
- [ ] As member: visiting admin routes redirects with toast.
- [ ] As member: connection list page is read-only; connection detail
      shows only Capabilities + Activity; per-user OAuth Connect CTA
      still works.
- [ ] As owner: nothing regressed; all admin chrome visible.

### Validate

- [ ] `bun run check && bun run lint && bun run fmt` clean.
- [ ] Test suites still green.

### Commit

- [ ] Commit landed with exact message from `03-ui-hiding.md`.

→ Surface to lead. **Wait for green light.**

---

## Phase 4 — Cross-phase verification

All boxes in `04-verification.md` ticked:

### Browser A (owner)

- [ ] Sidebar Settings visible.
- [ ] `settings/roles` loads, "+ New role" visible.
- [ ] `settings/members` loads, "+ Invite member" visible.
- [ ] Connection list shows "+ New connection".
- [ ] Connection detail shows Settings tab.

### Browser B (member)

- [ ] No Settings tile.
- [ ] Direct nav to `/settings/roles` redirects with toast.
- [ ] Same for `/settings/members`, `/settings/ai-providers/*`.
- [ ] Connection list has no "+ New connection".
- [ ] Connection detail: only Capabilities + Activity tabs.

### Backend curl (member)

- [ ] tools/list returns subset; all denied names absent.
- [ ] Escalation curl returns Forbidden, DB unchanged.
- [ ] Per-user OAuth flow still functional.

→ Surface to lead. **Wait for green light.**

---

## Phase 5 — Sync, docs, contribute

- [ ] `PER_USER_OAUTH.md` updated (follow-ups #1 and #8 marked,
      operating note appended).
- [ ] Doc commit landed.
- [ ] `gh issue comment 3388 --repo decocms/studio` posted with
      root cause and fork commit hashes.
- [ ] `git push origin feat/per-user-oauth` exited 0.
- [ ] Lead asked whether to open the draft PR on decocms/studio.
- [ ] (If approved) Draft PR open at
      `gh pr view <number> --repo decocms/studio`.

→ Done. Report to lead.
