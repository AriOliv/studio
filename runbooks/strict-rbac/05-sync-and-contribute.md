# Phase 5 — Sync, document, contribute

**Goal.** Update local docs to reflect what landed, share the
findings on the upstream issue, push to the fork, and (optionally)
open a draft PR to `decocms/studio`.

## Step 5.1 — Update local docs

Open `PER_USER_OAUTH.md` (at the repo root). Two surgical edits:

### Edit 1: follow-up #1 (escalation bug)

Find the section
`### 1. **\[security blocker\]** \`member\` can still self-promote
to \`admin\`` and prepend a "Resolved" callout while leaving the
historical description intact:

```md
### 1. **\[security blocker\]** `member` can still self-promote to `admin`

> **✅ Fixed by <commit-hash-of-Phase-1>.** Root cause: `BUILTIN_ROLES`
> in `apps/mesh/src/auth/roles.ts` included `"user"`, which is the
> Better Auth admin-plugin default for fresh signups, so the bypass
> at `context-factory.ts:251-255` fired for new org members. Removed
> from the array. Filed upstream as decocms/studio#3388.

Filed upstream: [decocms/studio#3388](https://github.com/decocms/studio/issues/3388).
(remaining historical text unchanged below this point)
```

Replace `<commit-hash-of-Phase-1>` with the actual short hash.

### Edit 2: follow-up #8 (Role design)

Find the section
`### 8. Role design: scope \`member\` further` and add a short status
note:

```md
### 8. Role design: scope `member` further

> **Status (after Phase 3 of `runbooks/strict-rbac/`):** member role
> is now scoped to read-only on connections/virtual MCPs plus its own
> per-user OAuth tokens. tools/list filtering and UI hiding both
> respect this. Remaining gap is per-connection grants — see
> follow-up #2.

(existing description unchanged below)
```

### Edit 3: add an operating note

At the end of `PER_USER_OAUTH.md`, append:

```md
---

## Operating the strict access model

- **Owner / admin** — full control of org, connections, virtual MCPs,
  roles, members.
- **Member** — can: see connection catalogue, view virtual MCP
  catalogue, authorise their own per-user OAuth on connections, see
  org info. Cannot: create/edit/delete connections, virtual MCPs,
  invite members, change roles.
- **Per-connection grants** (future) — admin will be able to scope
  "user X can use connection Y only". Tracked as follow-up #2.
```

Commit:

```bash
bun run fmt
git add PER_USER_OAUTH.md
git commit -m "$(cat <<'EOF'
docs(per-user-oauth): mark escalation fix landed and scoped member role

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Step 5.2 — Comment on upstream issue

```bash
gh issue comment 3388 --repo decocms/studio --body "$(cat <<'EOF'
Root cause confirmed: `BUILTIN_ROLES` in
`apps/mesh/src/auth/roles.ts` included `"user"`, and Better Auth's
admin plugin sets `defaultRole: "user"` for every fresh signup. The
`createBoundAuthClient.hasPermission` short-circuit at
`apps/mesh/src/core/context-factory.ts:251-255` returns `true` for any
role in `BUILTIN_ROLES`, so every newly-signed-up user bypassed
permission checks regardless of their org membership row being
`"member"`.

Fixed in the AriOliv/studio fork by dropping `"user"` from
`BUILTIN_ROLES`. Legitimate admin behaviour already lives in
`ADMIN_ROLES = ["owner", "admin"]`. Added an integration test in
`apps/mesh/src/api/integration-org-scoped.test.ts` and follow-up
work to (1) filter tools/list by caller role and (2) hide
admin-only UI affordances from members.

Commits on the fork: <paste short hashes of Phase 1/2/3 commits>
EOF
)"
```

Replace the placeholder with actual short hashes (
`git log --oneline -5`).

## Step 5.3 — Push to fork

```bash
git push origin feat/per-user-oauth
```

Confirm with `git status`:

```
Your branch is up to date with 'origin/feat/per-user-oauth'.
```

## Step 5.4 — Draft upstream PR (optional, lead's call)

Ask the lead whether to open the PR now or hold. If green-lit:

```bash
gh pr create --repo decocms/studio --draft \
  --base main \
  --head AriOliv:feat/per-user-oauth \
  --title "feat(auth): per-user OAuth + strict role enforcement" \
  --body-file PER_USER_OAUTH.md
```

The lead will review the PR description and flip it to "ready" when
appropriate.

## Phase 5 verification gate

- [ ] `PER_USER_OAUTH.md` updated (follow-ups #1 and #8 marked
      resolved/scoped; operating note appended).
- [ ] `gh issue view 3388 --repo decocms/studio --comments`
      shows the new comment.
- [ ] `git push origin feat/per-user-oauth` exited 0.
- [ ] (If lead approved) Draft PR open on `decocms/studio`.

Surface to the lead → done.
