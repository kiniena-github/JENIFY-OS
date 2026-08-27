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
| `src/application/ports.ts` | The two narrow integration seams |
| `src/application/db.ts` | Module-owned, additive DDL |

Two new tables, both **presentation/routing metadata only**, never authority:
`hq_op_task_meta` (project/title label + advisory assignment) and
`hq_mission_proposals` (inert group-room proposals).

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

### The four hardenings this lane adds

All are strictly **narrowing** — each one refuses more than the raw queue would.

1. **Allow-lists come from the directory.** `OperatorQueue.enqueue()` accepts
   `requestedBy.allowedCapabilities` from its caller. `HeadquarterOperations`
   always fills that from `WorkerDirectoryPort`; there is no argument through
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
4. **Founder actions require a human principal.** Approve, deny and the kill
   switch are refused for any id the directory knows as a registered worker, on
   top of the queue's own self-approval guards. An AI worker cannot approve an
   action or turn the kill switch off.

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

> **Open question for the Founder — a human cannot promote a proposal today.**
> Promotion creates a task whose requester must hold the capability in the
> directory, and the directory holds AI specialists, not humans. So a mission
> the Founder raises in the group room becomes work when a *worker* promotes it
> (and the Founder then approves the gated task), not by the Founder promoting
> it directly. Registering the Founder as a directory worker would fix that but
> would also make them a "registered worker", which is exactly the class barred
> from approving — so the two rules would collide. The safe direction was taken
> and the rule is **not** invented here: if the Founder wants direct promotion,
> it needs a human-principal grant model, which is a product decision, not an
> implementation detail.

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

64 new tests across three files; no existing test was edited.

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

---

## 9. Rollback

Revert the single commit. The schema is additive (two new `hq_*` tables created
idempotently and read by nothing else), and no existing file changed except
`src/index.ts` (+1 export line) and `package.json` (+1 subpath export).
