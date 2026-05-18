# Strict RBAC Runbook

A staged plan for closing the privilege-escalation gap on the Studio
fork (`feat/per-user-oauth`). The goal is that **org members cannot
mutate anything an admin did not grant**, and admin-only options
**disappear from the UI** for them. Reference upstream issue:
[decocms/studio#3388](https://github.com/decocms/studio/issues/3388).

## Audience and roles

- **Implementer (executing agent)** — reads this folder in order,
  executes each phase, ticks `TASKS.md`, asks the lead on escalation
  triggers documented in `policies.md`.
- **Tech lead reviewers** — Ari Oliveira and the planning agent that
  authored this runbook. Validates each phase verification gate before
  the implementer moves on.

## How to use this runbook

1. Read `policies.md` first. It's short and binding.
2. Open `TASKS.md` — it's the single checklist that tracks progress
   across every phase. Tick items as you go.
3. Execute phases in numeric order. **Do not start a phase until the
   previous phase's verification gate is green.**
4. Each phase file follows the same shape:
   - **Goal** — what done looks like.
   - **Steps** — copy/paste-ready commands and diffs.
   - **Commit message** — exact text to use.
   - **Verification gate** — checklist that MUST pass before
     moving on.
5. When verification fails or behaviour differs from what the runbook
   describes, **stop** and surface to the lead. Do not improvise.

## Phase index

| File | Phase | Scope |
|---|---|---|
| `00-remote-topology.md` | 0 | Repoint `origin` at AriOliv/studio fork, add `upstream` for decocms/studio. |
| `01-escalation-fix.md` | 1 | Backend: cut the `BUILTIN_ROLES` bypass so `member` cannot self-promote. Regression test. |
| `02-tools-list-filter.md` | 2 | Backend: `tools/list` returns only tools the caller's role can execute. |
| `03-ui-hiding.md` | 3 | Frontend: sidebar items, route loaders, tabs and action buttons hidden for members. |
| `04-verification.md` | 4 | Manual end-to-end sweep with two real accounts (owner + member). |
| `05-sync-and-contribute.md` | 5 | Update local docs, comment on upstream #3388, push to fork, draft upstream PR. |

Plus:

- `policies.md` — guardrails (must / must not).
- `TASKS.md` — the live checklist.

## Repo and account facts the implementer must remember

- Repo: `/Users/arioliveira/Aol/studio`. Monorepo, Bun workspaces.
  Primary app: `apps/mesh/`; SDK: `packages/mesh-sdk/`.
- Branch: `feat/per-user-oauth`.
- Dev command:
  `PORT=3200 VITE_PORT=4200 bun run dev --no-tui --no-local-mode`.
- Two test accounts already seeded in the local DB:
  - `arioliveira@localhost.mesh` / `local-mode-default` —
    **owner** of org `arioliveira-local`.
  - `userb@test.local` / `PerUserTest123!` — **member** of the same
    org.
- Embedded Postgres port rotates every dev restart. Discover it with
  `ps aux | grep "studio/.deco" | grep "postgres -D" | grep -v grep | grep -oE "\-p [0-9]+" | head -1 | awk '{print $2}'`.

## Estimate

- Phase 0: 10 min.
- Phase 1: 3–4 h.
- Phase 2: 2–3 h.
- Phase 3: 4–6 h.
- Phase 4: 30–45 min.
- Phase 5: 30–60 min.

Total: 1.5–2 working days for a focused agent. One PR.
