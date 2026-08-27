# Headquarter → Universal Operator application layer (HQ lane F)

Issue #139 (Founder-approved retry of #122), child of war room #117.
Package: `@factoryos/headquarter`, subpath export `./application`.

This is the layer that makes Headquarter *operational* over the Universal
Operator that merged in PR #45/#46. It adds no new control plane. Everything
in `packages/headquarter/src/operator/**` remains the source of truth for
safety; this layer is the typed way a UI reaches it.

---

## 1. What was added

| File | Role |
|---|---|
| `src/application/service.ts` | `HeadquarterOperations` — the whole lifecycle facade |
| `src/application/console.ts` | `founderConsole()` — the Founder-facing read model |
| `src/application/classification.ts` | Registry-derived task classification |
| `src/application/missions.ts` | Group-room proposal types + digest |
| `src/application/ports.ts` | The two narrow worker-side integration seams |
| `src/application/principals.ts` | Human identity, separate from AI worker identity |
| `src/application/db.ts` | Module-owned, additive DDL |

Three new tables. Two are **presentation/routing metadata only**, never
authority: `hq_op_task_meta` (project/title label + advisory assignment) and
`hq_mission_proposals` (inert group-room proposals). The third,
`hq_human_principals` (§4a), *is* authority — and starts empty, so it grants
nothing until a Founder explicitly registers someone.

`src/store/db.ts` is deliberately **not** edited, so this lane can land beside
the other #117 lanes without schema conflicts.

---

## 2. The lifecycle

```
createTask ──► classify ──► routeTask ──► assignTask (advisory)
     │                                          │
     │                              ┌───────────┘
     ▼                              ▼
needs_approval ──approveTask──► queued ──claimNext──► assigned
     │  (digest echoed)                                  │
     └──denyTask──► blocked                         startTask
                                                         │
                                                      running
                                                         │
                                                   submitResult
                                          ┌──────────────┴──────────────┐
                              read-only:  │                             │  side effect:
                                    completed                  reviewState = pending
                                                                        │
                                                          reviewTask (INDEPENDENT actor)
                                                            pass ► completed
                                                            fail ► review_failed
```

Off to the side, and never a silent retry: a side-effect task whose worker goes
silent mid-execution becomes `outcome_unknown` and leaves only through
`reconcileTask()`.

---

## 3. Where authority actually lives

Everything below is enforced in `operator/**` and simply reached through this
layer. **None of it was redesigned, relaxed, or duplicated.**

- Founder approval bound to the SHA-256 digest of the exact immutable action.
- Approval time-box, re-validated at execution start, not only at claim.
- Single-use approval nonce, consumed atomically with the claim, bound to the
  consuming worker + task + fencing token + per-claim nonce.
- Atomic fenced claim; every later write must present the current fence.
- Idempotency key required for side-effect capabilities; duplicates dedupe.
- Independent review mandatory for every side effect; no self-review,
  no self-completion.
- `outcome_unknown` and the kill switch.
- Deny-by-default capability registry; no shell/browser executor exists.

### The hardenings this lane adds

All are strictly **narrowing** — each one refuses more than the raw queue would.

1. **Allow-lists come from a registry.** `OperatorQueue.enqueue()` accepts
   `requestedBy.allowedCapabilities` from its caller. `HeadquarterOperations`
   always fills that from `WorkerDirectoryPort` (workers) or
   `originateCapabilities` (human principals); there is no argument through
   which a caller can supply its own permissions.
2. **Approvals are digest-echoed.** `approveTask()` requires the console to
   send back the digest it displayed. If the action changed between render and
   click, the approval is refused *before any approval row is written* — so
   "the Founder approved exactly what was on screen" is mechanically true, not
   a UI convention. The queue then binds its own record to the same digest, so
   the guarantee survives any later mutation too.
3. **Assignability is re-checked at claim AND at start.** A worker disabled or
   replaced mid-flight gets no new work and cannot start work it had already
   claimed. Its live claims surface as handover/reconciliation blockers.
4. **Every actor must positively BE someone.** See §4a — this replaces an
   earlier check that authorized Founder actions by elimination.

One more, found while wiring: `submitResult()` refuses a result for a task that
already has one awaiting review. `OperatorQueue.complete()` releases the lease
but leaves `claimed_by`/`fence` intact, so a second call would pass the fence
check and overwrite the stored result while a reviewer was reading it. It could
never self-complete the task — the review gate holds regardless — but the
reviewer must decide on the evidence that was actually submitted. Fixed here as
a service-layer precondition rather than by editing the queue, which is outside
this lane's ownership; **flagged for the Operator owner** as a candidate for the
queue itself.

### What this layer deliberately cannot do

There is no method that edits a task's capability or payload, none that clears
a rejection, and no path that writes `op_tasks` / `hq_approvals` columns behind
the queue's back. A test asserts the public surface carries no
`set*`/`update*`/`force*`/`override*` task-mutation method, so a future change
that adds one fails CI.

---

## 4a. Human principals — three rights, held apart

*Added in the correction after the PR #142 review, which caught a real hole and
a real product gap in the first cut.*

The first version authorized Founder actions by **elimination**: "this actor is
not a registered worker, therefore it is a human". That denied workers but
admitted *every unknown string* — a typo'd or invented id could approve. It also
left the Founder unable to originate work at all without being registered as a
worker, which would then have barred them from approving.

`principals.ts` makes human identity its own first-class, deny-by-default seam,
deliberately separate from AI worker identity. **The registry starts empty**;
registering a principal is a Founder-gated, code-reviewed action, exactly like
registering a capability. No default grant or default authority is invented.

Each principal carries two independent authorities:

| | Grant | What it does | What it never does |
|---|---|---|---|
| **Originate** | `originateCapabilities: string[]` | Open work for those capability ids | Confer any execution right |
| **Approve** | `approvalAuthority: boolean` | Decide Founder approvals, operate the kill switch | Confer a capability |

Three separations are enforced and tested:

- **Originating is never executing.** `claimNext()` and `startTask()` refuse a
  human principal outright (`humans_do_not_execute`). Execution requires a live
  fenced claim, and no code path gives a human one.
- **Approval authority is never worker membership.** A registered worker is
  refused approval authority *before* the principal lookup, so an id cannot be
  laundered into approving by also being listed as a principal.
- **Nobody round-trips a gated action alone.** The canonical
  requester-cannot-approve rule is untouched, so a human who opens a gated task
  cannot approve it. A second approval-authorized principal must — or, the
  ordinary Headquarter flow, a worker originates and the Founder approves.

> That last consequence is real: in a one-approver org, Founder-*originated*
> gated work has no approver. The answer is a second approval principal, or
> letting a worker originate. It is deliberately **not** solved with a Founder
> exception, which would weaken a canonical Operator guarantee.

**Founder decision, 2026-08-27 (PR #142) — settled, not open.** The two-actor
rule stands exactly as built. In the current one-human setup the Founder is the
only human required: an AI worker originates a gated action and the Founder
approves or rejects it; if the Founder personally originates one, they do not
self-approve that same action. **No self-approval exception and no risk-tiered
exception is to be added.** Recorded in `docs/JENIFY_DECISIONS.md`, and pinned
by the test *"will not let a human approve the very task they opened"* — a
future change that introduces an exception fails the suite.

Review and reconciliation use the same positive-identity rule but need no
grant: the decisive property there is independence (queue-enforced), so any
assignable worker or active principal may review — an unknown id may not.

### Attribution is not authorization — the standing rule

**Every method that writes a record carrying an actor's name must resolve that
actor first.** Four options, no fifth: `resolveRequester()` (capability grant
needed), `resolveActor()` (identity is enough), `assertApprovalAuthority()`
(Founder decisions), or the fencing token via `assertFence` (worker
mid-execution). "This path is harmless" is not an exemption.

The Jules review of `ff105a2` found four attributed writes still unresolved —
`rejectProposal`, `assignTask`, `postMissionMessage`, `proposeMission`. None
could escalate privilege: a proposal and a message are inert, an assignment
intent is advisory. That is exactly why they were missed — the earlier audit
asked what an actor could *do*, and these paths let an unknown identity choose
what it could *sign*, in a hash-chained evidence log that exists so history can
be trusted. Group-room attribution is the sharpest case: it is what a human
reads before deciding to promote a mission.

All four resolve now, and each is attacked in tests with an unknown id, a
deactivated worker, a deactivated human and `system`, asserting no record is
written and `evidence.verifyChain()` still returns clean.

## 4. Nomination vs. authority

Organization and registry hooks may **nominate** workers. That is all they do.

`routeTask()` collects nominations from every `NominationSourcePort`, then
evaluates each nominee itself, using only the capability registry and the
`WorkerDirectoryPort` allow-list. A source that nominates a worker without the
grant, a disabled worker, or a worker that does not exist changes nothing: the
nominee comes back `eligible: false` with the Operator's own reason attached. A
source that throws nominates nobody and is recorded, not fatal.

`assignTask()` records an **advisory** assignment intent. It changes no
canonical status and grants nothing; the worker still has to win the atomic
fenced claim. Its one operational effect is narrowing — `claimNext()` refuses to
hand the head-of-queue task to a different worker.

> Known benign race: the intent peek is not part of the claim's conditional
> UPDATE, so an intent recorded between peek and claim can be missed and another
> *eligible* worker may take the task. Assignment intent is advisory routing;
> every real authority — allow-list, approval binding, fence, independent
> review — is unaffected.

---

## 5. Group room → work, without chat being an execution channel

```
message (data)  ──►  proposal (inert row)  ──►  promoteProposal  ──►  ordinary task
                                                (Operator-authorized)      │
                                                                    unchanged gates
```

Three deliberate non-features, and they are the security argument:

1. **There is no parser from message text to a capability id, and none may be
   added.** `capabilityId` is chosen by the proposing actor through the typed
   API. Text like `run infra.drop_index` is inert prose — prompt injection has
   no grammar to hit.
2. Posting a message and creating a proposal write **zero** rows in `op_tasks`
   and grant nothing. A proposal has no risk class of its own; classification
   happens from the registry at promotion time.
3. Promotion is authorized by the promoting actor's **directory** allow-list,
   deny by default — never by the message author, the proposer, or anything
   either of them wrote. A promoted destructive capability still lands in
   `needs_approval` exactly as if it had been created any other way.

`detectActionLanguage()` flags imperative-looking chat for a human reader. It is
decoration and is never consulted by any authorization path.

A human principal **can** promote a proposal, for capabilities their
`originateCapabilities` grant covers (§4a). Promotion is still authorized on the
Operator side and still grants nothing: the promoted task is gated exactly as
any other, and the promoter — human or worker — gets no execution right from it.

---

## 6. Presentation never invents state

`founderConsole()` copies `status`, `reviewState`, `fence` and the rest verbatim
from canonical rows whose history lives in `hq_events`. It defines no status
vocabulary of its own and no "probably done" heuristics. Where it adds a field,
that field is a verbatim copy, a registry-derived classification, or a
presentation label explicitly marked as non-authority.

The two states the Founder must never miss get their own sections rather than a
row in a list:

- `outcomeUnknown` — with only the reconciliation decisions the Operator will
  actually accept (a non-idempotent capability never offers re-queue) and the
  actors it will refuse as reconcilers.
- `killSwitch` — global flag plus every engaged scope with reason and actor.

`ApprovalCard.actionDigest` is the value the Approval Center echoes back to
`approveTask()`. `ReviewCard.ineligibleReviewers` stops the console from
offering a review action that can only fail. Tests assert these claims are true
of the Operator, not just of the view.

---

## 7. Integration seams (PRs #127 / #128 not yet merged)

Lane F depends on **no unmerged lane**. Both dependencies are expressed as
interfaces in `ports.ts`, with a working default over the existing specialist
directory:

| Seam | Today | When the lane merges |
|---|---|---|
| `WorkerDirectoryPort.assignability()` | `SpecialistDirectoryAdapter` over `hq_specialists.active` | PR #127's `assertAssignable()` / replacement lifecycle — `AssignabilityReason` already carries `worker_replaced` and `handover_pending` |
| `WorkerDirectoryPort.allowedCapabilities()` | `hq_specialists.allowed_capabilities` | PR #128's **granted** (never advertised) capability list |
| `NominationSourcePort` | none registered by default | #118 org chart / #128 routing `rankMembers()` |

Plugging either in is a constructor argument. No code in this lane changes.

`replacementPlan()` is the seam in the other direction: lane F does not own the
worker lifecycle, so it reports the Operator-side truth that lifecycle must
respect — a worker holding live claims needs a handover, one holding an
`outcome_unknown` task needs reconciliation — and `assertReplacementSafe()` is
the guard a caller runs before disabling anyone.

---

## 8. Tests

88 new tests across four files; no pre-existing test was edited.

- `test/application.lifecycle.test.ts` (24) — classify, create, dedupe, route,
  advisory assignment, read-only vs. review-gated completion, the full
  Founder-gated path, `outcome_unknown` + reconciliation, replacement
  blockers, kill switch.
- `test/application.security.test.ts` (25) — hostile, including direct SQL
  tampering: approval mutation before and after approval, replay of a consumed
  approval, expiry between claim and start, wrong worker / stale fence / forged
  claim nonce, disabled and mid-flight-replaced workers, self-review and
  evidence swapping, Founder-only actions, nominations and idempotency keys
  that try to smuggle authority.
- `test/application.missions.test.ts` (15) — four textbook prompt-injection
  messages that change nothing, inert proposals, promotion authority, and the
  console-vs-canonical-state consistency checks.
- `test/application.principals.test.ts` (18) — the human seam: a Founder
  originating and promoting within their grant; grants held to least privilege;
  unknown, inactive and unauthorized humans denied; humans refused claim and
  start; a worker id refused approval even when also registered as a principal;
  a human unable to approve the task they opened, and a second approver able to;
  the kill switch on the same positive authority; unknown reviewers and
  reconcilers denied.

---

## 9. Rollback

Revert the branch's commits. The schema is additive (three new `hq_*` tables
created idempotently and read by nothing else), and no existing file changed
except `src/index.ts` (+1 export line) and `package.json` (+1 subpath export).
