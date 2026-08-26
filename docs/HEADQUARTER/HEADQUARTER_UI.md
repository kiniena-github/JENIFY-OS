# JENIFY Headquarter UI — Module Map & Ownership

Stream 2 deliverable (war room #41 order C, task issue #43 orders 1, 4–6).
Package: `packages/headquarter` (`@factoryos/headquarter`) — a new, isolated
npm workspace. **Zero changes to the Mesob pilot packages** (`shared`,
`server`, `web`, `config-mesob`) beyond registering the workspace in the root
`package.json`.

## Information architecture (implemented)

Seven pages sharing one navigation shell, rendered from canonical data:

| Page | Module | Content |
|---|---|---|
| Command Center | `renderCommandCenter` | Founder dashboard: **NOW / DONE TODAY / BLOCKED / WAITING FOR FOUNDER / NEXT** + per-worker status cards. |
| Projects | `renderProjects` | Project cards (open/blocked/waiting/done counts, last activity) + per-project chronological timelines. |
| Executive Room | `renderExecutiveRoom` | Presentation layer over recorded multi-party transcripts (`ChatThread` contract). |
| Direct Chats | `renderDirectChats` | Founder ↔ worker transcript presentation (same contract). |
| Specialist Directory | `renderSpecialistDirectory` | Worker/specialist roster with lane + status. |
| Founder Approvals | `renderFounderApprovals` | Read-only queue of `needs_approval` tasks. |
| Archive | `renderArchive` | Monthly browsing, project-evolution chains, links to preserved originals, date-confidence flags, client-side search. |

## Canonical activity model

`src/events.ts` implements war-room order B exactly:
`queued / assigned / running / blocked / needs_approval / review_failed /
review_passed / completed / outcome_unknown`, as append-only `ActivityEvent`s.
A task's state is the latest event; `latestTaskStates()` keeps full history.

Dashboard mapping (`DASHBOARD_BUCKET`):
- **NOW** — `assigned`, `running`, `review_failed` (rework), `review_passed` (finishing)
- **NEXT** — `queued`
- **BLOCKED** — `blocked`, plus `outcome_unknown` (needs attention, never silent)
- **WAITING FOR FOUNDER** — `needs_approval`
- **DONE TODAY** — `completed` events dated on the dashboard's UTC "today"

## Design decisions

- **Framework-free renderers** (pure `data → HTML string`): testable without a
  DOM, servable as static files privately, and embeddable later behind the
  operator control layer. No new runtime dependencies; no external requests;
  everything user-visible is HTML-escaped (test-covered).
- **Presentation never invents state.** Views are pure functions of the
  canonical events/records. The Founder Approvals page is deliberately
  read-only: Approve/Reject execution belongs to the Founder-gated operator
  control layer (Claude-owned, out of this task's scope) — no fake buttons.
- **Chat is a contract, not a transport.** `ChatThread`/`ChatMessage` define
  what any future transport must provide for display; live messaging is
  explicitly deferred to the control plane.

## Build & run (local only)

```
npm run test --workspace @factoryos/headquarter        # 31 tests
npm run typecheck --workspace @factoryos/headquarter
npm run inventory --workspace @factoryos/headquarter   # reconstruct archive from repo history
npm run build:site --workspace @factoryos/headquarter  # render dist/site/*.html
```

`dist/` is derived, gitignored output. The sample bundle
(`sample-data/hq-sample.json`) is reconstructed from real GitHub-visible
activity; its chat transcripts are labeled illustrative samples.

## File ownership (issue #43 order 6)

Owned by this Stream 2 task, safe for parallel work elsewhere:

- `packages/headquarter/**` (all new)
- `docs/HEADQUARTER/**` (all new)
- Root `package.json` — two additive lines only (workspace entry + `test:hq` script)

Not touched: operator/control-plane files, `packages/shared|server|web|config-mesob`,
migrations, data, CI workflows, any existing doc except the execution log append.

## Rollback

Revert the single PR commit (or delete `packages/headquarter/`,
`docs/HEADQUARTER/`, and the two root `package.json` lines). No migrations, no
data writes, no changes to existing behavior — rollback is purely subtractive.
