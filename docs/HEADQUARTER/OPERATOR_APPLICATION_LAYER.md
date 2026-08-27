# Headquarter → Universal Operator application layer

Issue #139 (HQ lane F, retry of the blocked #122). Implementation:
`packages/headquarter/src/application/`, covered by
`packages/headquarter/test/application.test.ts` and
`packages/headquarter/test/application.hostile.test.ts`.

## What this is

The typed service seam a Founder-facing Headquarter surface calls instead of touching
the Universal Operator — or its SQLite rows — directly. It spans the whole task
lifecycle (create → classify → route → assign → claim → start → review → complete →
reconcile), the Founder Approval Center actions, the kill switch, worker
disable/replacement, and group-room missions.

## What this deliberately is not

It is **not a second control plane**. Every safety decision is delegated to the
canonical Operator that PR #45 established and PRs #53/#71/#77/#79 hardened:

| Decision | Owned by |
|---|---|
| Capability existence / enablement / risk class | `operator/capabilities.ts` |
| allow / deny / needs-approval | `operator/policy.ts` `evaluatePolicy` |
| Atomic claim, fencing token, per-claim nonce | `operator/queue.ts` `claim()` |
| Approval digest / expiry / single-use / claim binding | `operator/approvals.ts` |
| Independent review, self-review refusal | `operator/queue.ts` `reviewPass/reviewFail` |
| `outcome_unknown`, reconciliation | `operator/queue.ts` `reconcile()` |
| Idempotency for side-effect capabilities | `operator/queue.ts` `enqueue()` |
| Hash-chained evidence | `operator/evidence.ts` |

This layer re-implements none of them and weakens none of them.

## The deny-only rule

Every gate this layer adds is written so that **deleting it would make the system more
permissive, not less**. That is the property that makes it safe to stack on top of the
Operator: a bug here can cost availability (work waits), never safety (work executes
that should not have).

Concretely:

- `nominateWorkers()` proposes candidates, then re-derives each one through
  `evaluatePolicy` + the specialist-directory allow-list + the assignability gate.
  Anything the Operator refuses lands in `rejected`, never in `nominated`.
- `assign()` records an *intended owner*. It refuses to record an intent the Operator
  would refuse anyway, and cannot record one that grants anything.
- `claimNext()` runs five pre-flight refusals (capability enabled, kill switch, worker
  assignable, directory allow-list, intended-owner reservation) and only then delegates
  the real claim to `OperatorQueue.claim`, which still performs the atomic conditional
  UPDATE and the single-use approval consumption with its full binding.
- `allGates(...)` in `seams.ts` composes assignability gates with AND, so adding a gate
  can only remove permission.

## Approval Center binding

`founderApprove()` requires the caller to echo back the `actionDigest` the Approval
Center **displayed**. If the task's current canonical digest has moved on — payload
edited, capability swapped, idempotency key changed — the decision is refused with
`action_changed_since_display` *before any approval row is written*, so a mutated action
never acquires an approval it could replay later.

This is an **additional** gate at the UI boundary. The Operator independently
re-validates digest, expiry, single-use consumption and claim binding at claim and at
start; removing the UI gate would not make a mutated action executable.

`operationsSnapshot()` surfaces `staleDigest` and `expired` per pending approval, so a
mutation or a lapsed time-box is visible in the Approval Center rather than only at the
execution boundary. `expired` reuses `approvalExpiredAt()` from `operator/approvals.ts`
rather than re-deriving the cutoff, so the UI and the execution boundary cannot disagree.

## Group-room text is inert

Chat text is data, not instruction — and that is architectural, not filtered:

- `postMessage()` writes one row and returns. It calls nothing on the Operator: no
  enqueue, no approve, no claim, not even a capability lookup.
- `createMissionTask()` takes `capabilityId` and `payload` as **typed arguments** from
  the caller's structured form. Nothing in `rooms.ts` parses, tokenises or
  pattern-matches a message body to produce them.
- Every mission task goes through the ordinary `createTask` → `enqueue` → policy path,
  so a risky capability lands in `needs_approval` regardless of what the room said.

A defensive keyword filter would be the *weaker* design: it implies text could reach the
decision if the filter missed something. `application.hostile.test.ts` asserts the
architectural property instead — four injection payloads produce zero new tasks, zero
approvals, zero events and zero evidence entries, and a mission task whose payload
carries `{ approved: true, riskClass: 'read_only', preApproved: true }` still lands in
`needs_approval`.

The only guard on message bodies is `assertNoSecretLikeContent` — a backstop that keeps
credentials out of the log. It is not an authorisation boundary and must not be read as
one.

## Presentation never invents state

`schema.ts` has no status column anywhere, by construction. `hq_task_meta`,
`hq_missions` and `hq_mission_tasks` hold routing and labelling metadata only — project,
title, origin thread, intended owner. Status, fence, claim, approval, review state and
results live exclusively in `op_tasks` / `hq_approvals` and the canonical `hq_events`
log, and every read model JOINs against those. If the Operator and a snapshot ever
disagree, the snapshot is stale by one read; it cannot hold a state the Operator never
had.

Classification is labelling only and asserts its own invariant: `classify()` recomputes
the action digest before and after and throws if it moved, so a relabel can never
invalidate — or launder — a Founder approval.

Annotations (`status: null` canonical events) record routing decisions in history without
creating a state transition. `application.test.ts` asserts that
`latestTaskStates(events)` always equals `queue.get(id).status` after a full lifecycle
including annotations.

## Worker disable and replacement

`disableWorker()` flips the specialist directory entry inactive. From that moment the
worker claims nothing new (`claimNext` gate 3) and files nothing new (`createTask`).

Work it **already holds is not force-released**. Releasing a claim would either burn a
single-use approval or hand a side-effect task to a second worker while the first may
still be executing it. Instead each in-flight task is annotated in canonical history and
returned as `handoverRequired`, and resolves only through the canonical path: handover to
a successor, or lease expiry → `outcome_unknown` → explicit independent `reconcile()`.
Never a silent retry.

`replaceWorker()` additionally requires the successor to already exist in the directory
with its **own** Founder-curated allow-list. Capabilities are deliberately not copied
from the outgoing worker — replacement is an org event and must never become a privilege
transfer. The evidence entry records `capabilitiesTransferred: false` explicitly, and the
hostile suite asserts the successor still cannot claim the outgoing worker's capability.

## Integration seams for unmerged lanes

Lane F must compose with, not duplicate, the organization/registry/memory state machines
other lanes own. `seams.ts` declares two deliberately tiny interfaces:

| Seam | Question | Power |
|---|---|---|
| `WorkerNominationSource` | "who *could* do this?" | Advisory. Proposals are re-checked by the Operator. |
| `WorkerAssignabilityGate` | "may this worker take on new work at all?" | Deny-only. Can refuse; can never grant. |

Bindings for the lanes in flight, to be added as thin adapters when they merge — no
change to the service is needed:

**Lane C — AI Member Registry (PR #128, open)**
- nomination: `registry.list({ status: 'active' })` filtered by role eligibility or
  `rankMembers(...)`, mapped to `{ workerId: member.id, source: 'ai_member_registry' }`.
- assignability: `member.status === 'active'` → assignable; `disabled` / `removed` /
  `replaced` → not assignable, carrying the member's own status as the reason.

**Lane D — memory + handover/replacement (PR #127, open)**
- assignability: call `assertAssignable(db, workerId)` inside `isAssignable` and
  translate its throw into `{ assignable: false, reason: 'handover_pending' }`.

Until those land, `defaultWorkerAssignability()` (specialist directory) and
`directoryNominationSource()` / `organizationNominationSource()` (specialist directory
and the merged lane-B organization engine) provide equivalent behaviour on `main` alone,
so the lane is testable and shippable today. `application.test.ts` proves the
organization seam cannot grant Operator rights the directory withholds.

## Security assumptions

1. Actor identity (`actor` / `workerId` / `decidedBy`) is authenticated by the caller
   before it reaches this layer. This layer authorises; it does not authenticate.
2. The specialist directory and capability registry are Founder-curated, code-reviewed
   data. A worker's own runtime claims about itself are never an input to any decision.
3. Free text — chat bodies, notes, titles — is inert data with no path to a capability
   id, payload, risk class or approval.
4. Credentials never enter the control plane at all; `assertNoSecretLikeContent` is a
   backstop, not the boundary.
5. `hq_task_meta.assigned_worker_id` is an intent, not a lock. Under a claim race the
   atomic UPDATE may land on a different row than the one pre-checked; the divergence is
   recorded as a canonical annotation event rather than reversed, because reversing a
   claim that already consumed a single-use approval would be the more dangerous act.

## Rollback

Self-contained and additive. To revert:

1. Delete `packages/headquarter/src/application/` and the two
   `packages/headquarter/test/application*.test.ts` files plus
   `test/helpers/application-harness.ts`.
2. Remove the `./application` entry from `packages/headquarter/package.json` `exports`
   and the `export * from './application/index.js'` line from
   `packages/headquarter/src/index.ts`.

No existing file's behaviour changes, so nothing else needs undoing. The three tables in
`schema.ts` are created by an idempotent `ensureApplicationTables()` that runs only when
the service is constructed; they are `CREATE TABLE IF NOT EXISTS` and hold no canonical
state, so leaving them behind in an existing database is harmless. `store/db.ts`,
`operator/*`, `organization/*` and `ui/*` are untouched by this lane.
