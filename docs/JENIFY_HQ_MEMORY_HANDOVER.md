# HQ Special Lane D — Company Memory & Handover/Replacement Lifecycle

Issue #120. Implements: `packages/headquarter/src/memory/**`,
`packages/headquarter/src/handover/**`, tests in `packages/headquarter/test/
memory.test.ts` and `handover.test.ts`.

## Purpose

Two problems, one lane:

1. **Company memory.** Decisions, rationale, and live task/project state
   currently live only in chat transcripts and a given AI session's context
   — they vanish when the session ends or the worker changes. Memory makes
   that knowledge durable, company-owned, searchable, and auditable.
2. **Worker replacement continuity.** When a specialist (Claude instance,
   Codex, Jules, a future worker) needs to be replaced or rotated out, its
   in-flight work, unresolved side effects, and reasoning must not
   disappear with it. The handover lifecycle freezes the worker, inventories
   what it owns, packages that into a structured handover, and only
   deactivates it once a successor has acknowledged and every unresolved
   item has been genuinely reconciled — never silently dropped.

**Ownership.** Memory belongs to Jenify / Headquarter — the company — never
to the AI worker or session that recorded it. `MemoryRecord.recordedBy` is
provenance only (who typed it), not an ownership claim. This is stated
directly in `memory/schema.ts`'s doc comment.

## Data model

### Company memory (`hq_memory`, owned by `memory/store.ts`)

A `MemoryRecord` reuses the **existing** archive/provenance/date-confidence
vocabulary from `archive/schema.ts` rather than inventing a second one:
`status: ArchiveStatus` (CURRENT/SUPERSEDED/REJECTED/EXPERIMENTAL/ARCHIVED),
`recorded: DatedValue` (date + confidence), `related: RelatedRefs`
(issues/PRs/commits/artifacts). On top of that it adds memory-specific
fields: `kind` (decision/rationale/task_state/project_state/blocker/
dependency/next_action/evidence_note), `title`/`body`, `project`,
`sourceRefs` (pointers, never copies), `tags`, `supersedes`/`supersededBy`
(evolution links, same shape as `ArchiveRecord.predecessorId`/
`successorIds`), and `privacy` (`internal` | `founder_only` — metadata; the
API layer that reads this table is responsible for enforcing it, per
JENIFY-OS CLAUDE.md rule 3: permission enforcement lives at the API layer,
never only in a field being present).

Immutability: `MemoryStore.record()` only ever inserts a new row. Superseding
an existing CURRENT record flips its `status` to SUPERSEDED and appends to
its `supersededBy` list, atomically with the new insert — the predecessor's
own title/body/tags are never rewritten. Recording a second CURRENT record
with the same `kind`+`project`+`title` without going through `supersedes`
throws, forcing an explicit, auditable supersede instead of silent
duplication.

### Handover/replacement (`hq_handovers`, owned by `handover/replacement.ts`)

```
frozen -> inventoried -> package_ready -> acknowledged -> verified -> completed
   \___________________________________________________________/
                              \-> aborted (from any pre-completed state)
```

`HANDOVER_TRANSITIONS` + `assertHandoverTransition` gate every state change,
mirroring `contracts/events.ts`'s `ALLOWED_TRANSITIONS`/`assertTransition`.
`verified` is reachable only from `acknowledged`, and `completed` only from
`verified` — so verification or completion without a prior acknowledgement
is structurally impossible, not just discouraged.

- **initiate** — freezes the predecessor and opens the one active handover
  for it (a second `initiate` while one is already open, in any
  non-terminal state, is rejected).
- **inventory** — read-only snapshot of how many tasks are currently active
  (`assigned`/`running`/`outcome_unknown`) under the predecessor in
  `op_tasks`.
- **generatePackage** — builds a `HandoverPackage` (see below) and stores it
  on the row.
- **acknowledge** — the named successor must be an ACTIVE row in
  `hq_specialists` (checked through the existing `HeadquarterStore`, not
  duplicate SQL) and must differ from the predecessor.
- **verify** — re-checks (never mutates) `op_tasks`: any task still claimed
  by the predecessor in `assigned`/`running`/`outcome_unknown` blocks
  verification, naming the task ids. This is where issue #120's rule lives:
  *a worker cannot be removed/replaced mid-side-effect without
  reconciliation; an uncertain external result stays `outcome_unknown`* —
  reconciliation happens only through the existing operator queue
  (`operator/queue.ts`: `reconcile()`/`reviewPass()`/`reviewFail()`).
- **complete** — only from `verified`. Deactivates the predecessor
  (`hq_specialists.active = 0`) via `HeadquarterStore.upsertSpecialist` —
  the row and its full event history are preserved, never deleted.
- **abort** — from any pre-completed state, with a reason; itself terminal.
- **assertAssignable(db, workerId)** — throws if the worker is deactivated
  or has any active (non-completed, non-aborted) handover, including a bare
  freeze that never progressed. This is the enforcement point a future
  "assign new work" path must call — see Follow-ups.

`HandoverPackage` (`handover/package.ts`, pure read, no mutation of
`op_tasks`/`hq_memory`):

| Field | Source |
|---|---|
| `activeAssignments` | `op_tasks` claimed_by worker, status assigned/running |
| `unresolvedSideEffects` | claimed_by worker, status outcome_unknown, OR a side-effect capability still running / review pending |
| `outcomeUnknownTaskIds` | claimed_by worker, status outcome_unknown |
| `decisions`/`blockers`/`dependencies`/`nextActions` | CURRENT memory records owned by the worker (see open question below), by `kind` |
| `branchesAndPrs`/`files`/`evidence` | collected from those memory records' `related`/`sourceRefs`, plus any `refs` array found inside a claimed task's stored `result` |

Both `record()` and `generateHandoverPackage()` run
`operator/evidence.ts`'s existing `assertNoSecretLikeContent` — issue #120's
"no copying secrets into memory" rule. The package-level check is
deliberately a defense-in-depth backstop (every normal input already passed
its own check at `memory.record()`/`queue.complete()` time), not the primary
defense — mirrored from `evidence.ts`'s own doc comment on the same
function. `handover.test.ts` exercises this by writing a secret-shaped
`op_tasks.result` directly via SQL (bypassing `queue.complete()`'s own
check) to prove the package-level guard still catches it.

## Integration points

- **Archive search reuse.** `memory/store.ts` never implements a second
  index. `asArchiveRecord(memory)` projects a `MemoryRecord` into the
  existing `ArchiveRecord` shape (`archive/schema.ts`) — it passes
  `validateArchiveRecord()` unchanged — and `searchMemory(records, query)`
  is a thin wrapper: project, then delegate to `archive/search.ts`'s
  existing `buildIndex()`/`search()`.
- **hq_events.** All memory-supersede/record events (subjectKind `system`)
  and every handover lifecycle transition (subjectKind `worker`) go through
  the existing `hq_events` append-only log — `MemoryStore` via an optional
  injected `onEvent` callback (kept decoupled, matching the issue's
  "keep it a simple optional constructor param" instruction), `HandoverStore`
  via a direct `HeadquarterStore.appendEvent()` call (worker
  freeze/replacement is exactly the kind of "important action" JENIFY-OS
  CLAUDE.md rule 4 requires an audit event for, so this one is not made
  optional).
- **op_tasks / op_capabilities — read-only.** Neither module ever writes to
  these tables. `verify()` re-checks; it does not resolve.
- **assertNoSecretLikeContent.** Reused from `operator/evidence.ts` for both
  memory records and handover packages — no second secret detector.
- **Own DDL.** Each module owns and applies its own tables idempotently
  (`ensureMemoryTables`, `ensureHandoverTables`, both `CREATE TABLE IF NOT
  EXISTS`) — `store/db.ts`'s DDL is untouched.

## Open question flagged, not invented

Issue #120 asks for handover `decisions` to be "CURRENT memory records
recordedBy or tagged to the worker's **projects**." Headquarter has no
separate worker-to-project ownership model anywhere else in the codebase to
resolve "the worker's projects" against. Rather than invent one, this
implementation uses the more literal, testable subset: a memory record
belongs to a worker when `recordedBy` is that worker, or the worker's id
appears in the record's `tags`. This is documented at the point of use
(`handover/package.ts`'s `ownedBy()`) and called out here so it can be
revisited once project-level worker ownership actually exists.

## Explicit follow-ups (not built here)

- **Queue-side `assertAssignable` wiring.** `operator/queue.ts`'s `claim()`
  does not yet call `assertAssignable()` before honoring a claim — this
  issue builds the guard and its enforcement semantics, but wiring it into
  the live claim path is a follow-up so it can be reviewed against the
  queue's existing fencing/approval invariants on its own.
- **UI.** No Jules-owned surface for browsing memory or driving a handover
  through its states — this issue is the data/lifecycle layer only.
