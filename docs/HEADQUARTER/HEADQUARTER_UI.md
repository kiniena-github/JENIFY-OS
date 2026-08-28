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
| Command Center | `renderCommandCenter` | KPI strip, Founder attention queue, the five lanes **NOW / NEXT / DONE TODAY / BLOCKED / WAITING FOR FOUNDER**, live activity feed, active AI workforce. |
| Projects | `renderProjects` | Portfolio board: health, completed share of recorded tasks, active workers, first blocker, latest achievement, next queued item, recent update + per-project visual timelines. |
| Executive Room | `renderExecutiveRoom` | Participants with identity/vendor/role, contribution stream, and the open Founder decisions (from `ApprovalRequest`). |
| Direct Chats | `renderDirectChats` | Conversation list + transcript + a context panel showing what that worker is actually recorded as doing. |
| Specialist Directory | `renderSpecialistDirectory` | Workforce directory: identity, vendor/platform, role, granted capabilities, availability, current assignment and recorded workload. |
| Founder Approvals | `renderFounderApprovals` | Read-only decision cards: ask, risk class, D15 fields (digest/expiry/consumption/decider), high-risk emphasis, and inert, explicitly-labelled Approve/Reject/Ask-for-changes placeholders. |
| Archive | `renderArchive` | Search + structured filters, ranked results with a detail disclosure, chronological month browser, project-evolution chains, links to preserved originals, date-confidence flags. |

## Canonical activity model

The ONE canonical event model lives in `src/contracts/events.ts` (PR #45
integration base per issue #53 correction D / architecture doc §6b):
`queued / assigned / running / blocked / needs_approval / review_failed /
review_passed / completed / outcome_unknown`, as append-only `ActivityEvent`s
(`subjectKind`/`subjectId`/`actor`/`seq`/`at`). The UI defines no parallel
status vocabulary: `src/ui/model.ts` derives a `TaskState` view-model from
that contract; `latestTaskStates()` keeps full history (status-`null`
annotation events are preserved without changing state). Founder Approvals
renders the D15 approval fields (`actionDigest`, `expiresAt`, `consumedAt`,
`decidedBy`) read-only from the contracts' `ApprovalRequest`.

Dashboard mapping (`DASHBOARD_BUCKET`):
- **NOW** — `assigned`, `running`, `review_failed` (rework), `review_passed` (finishing)
- **NEXT** — `queued`
- **BLOCKED** — `blocked`, plus `outcome_unknown` (needs attention, never silent)
- **WAITING FOR FOUNDER** — `needs_approval`
- **DONE TODAY** — `completed` events dated on the dashboard's UTC "today"

## Executive UI upgrade (issue #138)

The 2026-08 upgrade replaced the developer-dashboard styling with one dark,
premium executive theme while keeping every renderer pure and every honesty
rule intact.

- `src/ui/theme.ts` — the whole design system as one CSS string (tokens,
  layout primitives, status language, responsive rules). No build step, no
  dependency, no external font or asset request.
- `src/ui/components.ts` — shared escaping-by-default fragments: status
  chips, identity avatars, KPI cards, progress meters, empty states,
  scroll-contained table wrappers, relative ages.
- `src/ui/views.ts` — additional read models derived from the SAME canonical
  events: `projectBoard`, `projectHealth`, `founderAttentionQueue`,
  `activityFeed`, `specialistProfiles`. Each returns `null` rather than
  guessing when the data cannot answer the question.
- `src/ui/archive-search.ts` — the archive search semantics as plain,
  self-contained functions that are unit-tested directly AND serialized into
  the page with `Function.prototype.toString()`, so the browser cannot drift
  from the tests. This is what fixed the old inconsistency where search hid
  table rows while the Evolution section ignored the query entirely: search,
  filters, results and Evolution now share one match set.

### Truthfulness rules the upgrade preserves

- Founder Approvals renders **no `<button>` and no `<form>`** on any page.
  The Approve / Reject / Ask-for-changes affordances are inert `<span>`s with
  `aria-disabled` and a visible "not wired — read-only page" label.
- A field the canonical contracts cannot answer is omitted, never estimated.
  There is no cost, token-usage, sentiment, ETA or agreement/disagreement
  signal anywhere, because none of those exist in the contracts.
- When the bundle carries a provenance note it is shown at the top of every
  page as well as in the footer, so sample/reconstructed data cannot be read
  as live production truth.
- `bundleAsOf()` derives "as of" from the newest timestamp in the bundle, not
  from wall-clock time: the site never claims to be fresher than its data and
  renders stay byte-reproducible.

### Responsive and accessibility guarantees

Mobile is treated as a first-class Founder surface, not a squeezed desktop.

- Horizontal overflow is **eliminated, not hidden**: `overflow-x: hidden` is
  banned (and test-asserted as absent). Grid tracks are
  `minmax(min(<x>, 100%), 1fr)`, flex/grid children carry `min-width: 0`,
  long tokens wrap, and wide tables scroll inside a focusable
  `role="region"` container.
- Structural guarantees run in CI: `test/ui-responsive.test.ts`.
- Measured browser proof: `tools/ui-evidence.mjs` asserts
  `documentElement.scrollWidth <= innerWidth` (and the same for `body`) for
  all 7 pages at 1440 / 1024 / 414 / 390 / 360 / 320 px, exercises the archive
  search interaction, and writes full-page screenshots. Playwright is
  intentionally NOT a package dependency; the tool is run by hand for PR
  evidence (`npm run evidence:ui --workspace @factoryos/headquarter`).
- Skip link, single `h1` per page, labelled nav landmark with `aria-current`,
  visible focus (`outline` is never removed), status conveyed by word **and**
  colour, `aria-label`ed progress meters, an `aria-live` archive result
  count, and all motion disabled under `prefers-reduced-motion`.

### Known intentionally read-only / non-live controls

| Surface | State |
|---|---|
| Approve / Reject / Ask for changes (Founder Approvals) | Drawn, inert, labelled "not wired". Decisions stay in the Founder-gated operator control plane. |
| Executive Room and Direct Chats | Transcript view only. No send box, no attachment control — live messaging arrives with the operator control layer. |
| Archive search | Literal token matching, stated on the page. No semantic/AI retrieval is implied. |
| Everything else | Read-only projections of canonical data. No page mutates anything. |

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
npm run test --workspace @factoryos/headquarter        # 777 tests
npm run evidence:ui --workspace @factoryos/headquarter # browser overflow proof + screenshots
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
