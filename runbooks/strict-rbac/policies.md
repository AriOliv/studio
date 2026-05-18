# Policies — binding rules for the implementer

These rules are non-negotiable. Violating any of them is grounds to
**stop and escalate**, not to keep going.

## Must not

- **Never run destructive git commands** without explicit lead
  approval. This includes `git reset --hard`, `git push --force` (to
  any remote), `git checkout .`, `git restore .`, `git clean -f`,
  `git branch -D <protected>`.
- **Never push to `upstream`**. The remote `upstream` points at
  `decocms/studio` and is fetch-only. All pushes go to `origin`
  (`AriOliv/studio`).
- **Never bypass pre-commit hooks**. Do not pass `--no-verify`,
  `--no-gpg-sign`, or similar to `git commit`. If lefthook fails, the
  fix is in the code (almost always missing `bun run fmt`), not in
  silencing the hook.
- **Never commit `console.log("[debug:...")` lines.** Phase 1 asks
  you to add two temporary log statements to confirm the root cause.
  Revert them before staging.
- **Never modify `knip.json`, `knip.config.ts`, `biome.json`,
  `.oxlintrc.json` to silence warnings.** Per `CLAUDE.md`, those
  warnings are real and must be fixed by removing the offending
  unused code/export/dependency.
- **Never add new runtime dependencies** without lead approval.
  Adding `devDependencies` is fine when justified.
- **Never skip a phase's verification gate**. Even if everything
  looks fine, run the listed commands and confirm the listed
  manual checks.
- **Never modify upstream behaviour you don't understand.** If a
  change touches a path you haven't read end-to-end, stop and ask.

## Must

- **Run `bun run fmt` after every code change** (lefthook will yell
  otherwise).
- **Run `bun run check` and the targeted test suite** at the end of
  every phase. Paste the output to the lead.
- **Prefer editing existing files over creating new ones.** The
  runbook explicitly lists the few new files (`role-tools.ts`,
  `use-current-member-role.ts`, `resolve-role.ts`). If you find
  yourself creating something not on that list, surface it.
- **Use Bun's test runner** (`bun test`). Integration tests live in
  `apps/mesh/src/api/integration-org-scoped.test.ts`. Unit tests
  co-locate next to the code (`*.test.ts`).
- **Use Conventional Commits.** Each phase file gives you the exact
  commit message — use it verbatim. End every commit with the
  trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```
- **When a step says "search for X", actually run `grep` / `gh
  search`.** Don't guess paths.
- **Update `PER_USER_OAUTH.md`** when behaviour described there
  changes (specifically follow-up item #1 once Phase 1 lands).

## When to escalate to the lead

- Phase 1 reproduction still allows escalation after the fix is
  applied. There's a second bypass we missed.
- Removing `"user"` from `BUILTIN_ROLES` causes any test to fail or
  any UI to regress unexpectedly.
- The MCP SDK does not expose `server.setRequestHandler` /
  `server.listTools()` in the way Phase 2 needs. Try Plan B in
  `02-tools-list-filter.md` § Plan B, then escalate if that also
  doesn't fit.
- Any verification gate fails for reasons not anticipated in the
  runbook.
- A `git fetch upstream main && git rebase upstream/main` produces a
  conflict that requires behaviour judgement to resolve.
- You discover a security issue not covered in this runbook.

## Output expectations to the lead between phases

At the end of each phase, post (in the chat with the lead):

1. `git log --oneline <prev-head>..HEAD` — what landed.
2. `bun run check` last line + a summary of `bun test` (pass/fail counts).
3. The output of the phase's manual verification commands.
4. Anything surprising — even minor.

The lead either green-lights the next phase or asks for a specific
change. Wait for green light.
