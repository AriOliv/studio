# Phase 0 — Remote topology

**Goal.** Point `origin` at Ari's personal fork
(`https://github.com/AriOliv/studio.git`) and rename the current
`decocms/studio` remote to `upstream`. Push the working branch to the
fork so the implementer can iterate without touching upstream.

This is pure git plumbing. No code changes.

## Pre-flight

Confirm you are on the right branch and the tree is clean:

```bash
cd /Users/arioliveira/Aol/studio
git status -s         # expect: empty output
git rev-parse --abbrev-ref HEAD   # expect: feat/per-user-oauth
git remote -v         # expect: origin -> github.com/decocms/studio (the upstream)
```

If the tree is not clean, stop and surface to the lead.

## Steps

```bash
# 1. Rename the current origin (decocms/studio) to "upstream".
git remote rename origin upstream

# 2. Add the personal fork as the new origin.
git remote add origin https://github.com/AriOliv/studio.git

# 3. Sanity check.
git remote -v
# Expected:
#   origin    https://github.com/AriOliv/studio.git (fetch)
#   origin    https://github.com/AriOliv/studio.git (push)
#   upstream  https://github.com/decocms/studio.git (fetch)
#   upstream  https://github.com/decocms/studio.git (push)

# 4. Make sure the fork actually exists on GitHub.
gh repo view AriOliv/studio --json name,owner,visibility
# If the fork does not exist, create it:
gh repo fork decocms/studio --clone=false

# 5. Push the working branch to the fork.
git push -u origin feat/per-user-oauth
```

## Verify

- `git remote -v` lists exactly the two remotes shown above.
- `gh repo view AriOliv/studio` succeeds (does not 404).
- `git status` reads:
  `Your branch is up to date with 'origin/feat/per-user-oauth'.`
- `git log -1 origin/feat/per-user-oauth` matches local HEAD.

## Gotchas

- If `gh` is not authenticated, run `gh auth status` and authenticate
  (`gh auth login`) before retrying.
- If the fork already had `feat/per-user-oauth` from a previous push
  with a different history, **stop**. Do not `--force`. Ask the lead.
- Never run a push command targeting `upstream`. The new topology is
  `origin = my fork (push allowed), upstream = decocms/studio
  (fetch only)`.

## No commit in this phase

This is local repo configuration; nothing to commit.

## Verification gate

- [ ] `git remote -v` matches the expected output above.
- [ ] `git push -u origin feat/per-user-oauth` exited 0.
- [ ] The branch shows up on https://github.com/AriOliv/studio/branches.

Notify the lead → wait for green light → proceed to **Phase 1**.
