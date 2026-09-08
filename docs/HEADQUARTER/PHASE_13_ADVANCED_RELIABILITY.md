# Phase 13 — Advanced Reliability

Built on the accepted `main` (`f1ce71c6`) on branch
`cloud/phase-13-14-reliability-cost-intelligence`, as the first half of the
Phase 13 + 14 wave. One document for the phase, in the Phase 5+6 / Phase 7 /
Phase 8 / Phase 9 / Phase 10 / Phase 11 / Phase 12 style.

## What Phase 13 is

HQ survives crashes, restarts, duplicate calls, two processes, partial provider
failures and stale workers **without lying about what happened**. It gains a
durable run ledger, a truthful restart classification, a stronger
cross-process duplicate guard, explicit reconciliation paths, a verified-backup
register, and a safe/read-restricted posture it enters when its own stored
record can no longer be trusted.

Two modules own it. `src/store/integrity.ts` answers one question categorically
— can HQ still stand behind its own stored truth? — and reads only.
`src/application/reliability-command.ts` owns the run vocabulary (categorical
only), the three INSERT-only tables, the keys, the pure derivations and the
crash classification. `HeadquarterOperations` owns every gate, every write and
every enforcement-safe read, exactly as it does for every phase before this.

### What Phase 13 deliberately is NOT

- **Not a second task truth.** `op_tasks` plus `ActivityStatus` stay the one
  answer to "what is the state of this work"; `hq_missions` stays the answer
  for a mission; the Phase 8 `hq_action_intents` / `hq_action_events` ledger
  stays the answer for an external action. A run row REFERENCES a canonical
  task (and optionally a mission and an action) and holds what none of them
  holds: which PROCESS was carrying the work, how many attempts it made, which
  correlation each used, and what category of failure ended it.
- **Not a second dedupe system.** The attempt key is the Phase 8 side-effect
  key's shape, backed the same way (a UNIQUE partial index plus the
  secondary-unique append-only trigger). Reconciliation reuses
  `ACTION_RECONCILE_DECISIONS` **verbatim** — the same three answers, the same
  authority — rather than spelling a near-identical set. `RUN_RECONCILE_DECISIONS`
  is a re-export, and a test asserts identity (`toBe`), not equality.
- **Not a retry engine.** There is no facade method, no route, no parameter and
  no code path that reopens an uncertain outcome. The only place the word
  appears on a surface is `retryStatement` — a sentence that says HQ does NOT
  do it — and `retriedAnything: false` on the recovery response. A test pins
  that no control path SEGMENT anywhere spells `retry`, `restore`, `repair`,
  `force` or `override`.
- **Not a second writer into any other ledger.** Restart recovery classifies
  THIS ledger's runs. Interrupted canonical work owned elsewhere — Phase 8
  actions standing at `attempted`/`outcome_unknown`, tasks the queue moved to
  `outcome_unknown`, tasks holding an expired lease — is REPORTED as counts,
  with the canonical path that resolves each, and is left exactly where it
  stands.
- **Not a repair tool.** HQ never repairs a corrupt store, never restores a
  backup and never takes one. Repair is a Founder act against a verified
  backup, performed outside HQ against a stopped process.
- **Not an execution seam.** There is no adapter handle, no provider parameter,
  no target and no payload anywhere in this phase. A run records that an
  attempt happened; the attempt is made by the canonical lane that owns it.
- **Not a paid service or a spend decision.** Nothing here opens a socket,
  reads an environment variable, names a service or adds a dependency.

## The model

### A run — a REFERENCE plus the one fact no canonical row holds

| Field | What it is |
|---|---|
| `taskId` | The canonical `op_tasks` row this run is executing. A reference, never a copy; the run write is authorized by the live fenced claim on it. |
| `missionId`, `actionId` | Optional references to the canonical mission and the Phase 8 action intent. Never written by this phase. |
| `capabilityId` | Copied from the task row at open, so the crash classification can ask "could this have reached outside HQ" without re-resolving a task that may have moved. |
| `workerId`, `claimFence`, `claimNonce` | The claim the run was opened under. |
| `processId` | Which process OPENED the run. Stated precisely, because the imprecision was a defect (Wave 5 Medium 1): it proves "not the process running this recovery". It does not prove "dead", and HQ holds no liveness signal that would — there is no heartbeat and no boot nonce. So a recovery run while another process is genuinely mid-attempt WILL classify that live attempt as interrupted. What HQ does about that is not pretend otherwise: see [When a live process is classified](#when-a-live-process-is-classified). |
| `state`, `outcome`, `failureCategory`, `attempts` | DERIVED from the append-only event ledger. Never stored mutable columns. |

### The state vocabulary, and why it is disjoint

```
open → attempting → concluded
                 ↘ needs_reconciliation → (human) → concluded
```

`RUN_STATES` shares **no member** with `ActivityStatus`, `MissionStatus`,
`ActionState` or `ProductLifecycleState`, and a test asserts the disjointness
directly against all four. A run state named `completed` or `blocked` would
create exactly the ambiguity a reader then has to resolve by guessing.

`RUN_OUTCOMES` carries `outcome_unknown` as a **first-class member**, not an
error case, and `not_executed` means somebody established that nothing
happened — never that nothing was heard. `RUN_FAILURE_CATEGORIES` is
categorical with no number beside it; a test scans every vocabulary member for
`percent|confidence|probability|score|eta|estimate` and finds none.

### The law: an uncertain outcome is never retried

Enforced **twice**, deliberately.

1. **By a pure function.** `runAdmitsAttempt` returns true only for a run that
   has never attempted, or one reopened by a `confirmed_not_executed`
   reconciliation. `attempting` is refused (one attempt is already open),
   `needs_reconciliation` is refused (HQ does not know what the last one did),
   and a `concluded` run is refused unless a human said nothing happened.
2. **By the engine.** Each attempt reserves `runKey#generation` in a UNIQUE
   partial index on `hq_reliability_run_events.attempt_key`, so two processes
   cannot both open the same generation — including a process that never ran
   this module's code. Proven from a raw `better-sqlite3` connection.

The generation counter is `1 + the number of confirmed_not_executed
reconciliations`, which is `sideEffectGeneration`'s shape exactly, so the two
ledgers count attempts the same way.

### Fail closed, everywhere HQ does not know

| Situation | Reading | Why |
|---|---|---|
| stored `run_kind` outside the vocabulary | `unrecognized` | Coercing it to a real kind would publish a wrong count to an unauthenticated reader. |
| stored event `kind` outside the vocabulary | `unrecognized`, and the run becomes `needs_reconciliation` | An event HQ cannot interpret is not an attempt, not a conclusion, and emphatically not permission to try again. |
| reported `outcome` outside the vocabulary | `outcome_unknown` | The safe reading is the one that costs a human a look, never the one that closes the record. |
| reconciliation `decision` outside the vocabulary | `confirmed_failed` — the strictest of the three | It concludes nothing and reopens nothing. |
| capability row that cannot be read at recovery | treated as side-effecting | An interrupted attempt on it is uncertain rather than conveniently harmless. |

### The crash classification

`classifyInterruptedRun` is pure, so the rule can be exercised without a
process, a file or a clock. A run is classified only when it is `open` or
`attempting` **and was opened by a different process**; runs opened by THIS
process are left strictly alone, because closing them would be the recovery
inventing a crash.

| What the ledger shows | Verdict | Why it is honest |
|---|---|---|
| no attempt was ever reserved | concluded `not_executed` | Provable from the ledger: no reservation exists, so nothing external can have happened. |
| an attempt, on a capability with `side_effect = 0` | concluded `not_executed` | The capability cannot reach outside HQ — the same column the queue itself uses at lease expiry. |
| an attempt, on a capability that has (or may have) a side effect | `needs_reconciliation`, outcome `outcome_unknown` | HQ does not know. It says so, and never retries. |

Recovery is idempotent: a second pass finds nothing left to classify and writes
nothing.

### When a live process is classified

`process_id` is an identity, not a liveness signal, and Phase 13 originally
described it as if it were one. A Founder-gated recovery run while another
process is mid-attempt classifies that live attempt as interrupted /
`outcome_unknown` — and, before Wave 5, the live worker's truthful
`recordRunOutcome` was then refused `run_state_conflict`, so the ledger
permanently asserted an interruption that never happened and only a human guess
could close it.

**The correction is a repair path, not a prevention.** A run whose most recent
event is an `interrupted` one (`RunRecord.interruptedWithoutReport`) accepts a
statement from the worker that still holds the LIVE FENCED CLAIM — which a dead
process cannot hold, and which is already the only authority this phase accepts
for a run write. A run that has been RECONCILED still refuses, so a human
decision is never overwritten.

**And it is a REPORT, in the strict sense the second Wave 5 correction had to
make it (Critical 1).** The first attempt at this repair path appended
`outcome_recorded`, which is the event that CLOSES a run. That defeated two
other guarantees at once:

- `deriveRunRecord`'s `outcome_recorded` branch sets `state = 'concluded'`, so
  `needsReconciliation` went false — and `openRun`'s guard, which refuses a new
  run on a task standing at "HQ does not know what happened", lifted with it.
  The worker whose own attempt was in doubt could then open a SECOND run on the
  same task and start a second attempt, on a NON-IDEMPOTENT
  `external_side_effect` capability, with no human anywhere in the chain.
- `reconcileRun` demands FOUR things for exactly that transition — approval
  authority, INDEPENDENCE from the worker that ran it, an unconditional
  route-level step-up, and `confirmed_not_executed` only for an IDEMPOTENT
  capability. The late path demanded none of them, while performing the same
  state change.

So the late statement is now its own event kind, `worker_report`. It is folded
into `RunRecord.workerReport` — who said it, when, what outcome and failure
category they report, and their note — and `state` stays
`needs_reconciliation`, `outcome` stays `outcome_unknown`, `admitsAttempt`
stays false and `openRun` keeps refusing. **`reconcileRun` is once again the
only thing that closes such a run**, with all four of its gates intact. The
interruption event stays in the append-only ledger as the classification it
was, and the report carries `afterInterruption: true` rather than smoothing it
over.

The rule is in the DERIVATION and not only in the writer: an `outcome_recorded`
event that lands on a run already standing at `needs_reconciliation` is folded
in as testimony too. `hq_reliability_run_events` is append-only and an APPEND
is precisely the write its triggers permit, so a raw connection could otherwise
have re-opened the hole from outside this code.

What the repair path does NOT do, stated so the boundary is not read
generously: it does not clear the interruption, does not conclude the run, does
not lift the `openRun` guard, does not open an attempt generation, and does not
make HQ's `outcome` anything other than `outcome_unknown`. It records that the
carrier says something happened. A human still has to agree.

**What was considered and not done, and why.** Skipping runs whose canonical
task still holds an unexpired lease is genuinely sound and is the stronger fix.
It was not taken because it changes WHEN recovery works: after a real crash the
lease is still live, so recovery would do nothing until it expired. That is a
material change to the behaviour of a Founder-gated operation and is a decision
to take deliberately rather than as part of a correction pass.

**Also not done, and stated plainly.** `deriveRunRecord` trusts a RECOGNIZED
event absolutely; its fail-closed handling covers only strings outside the
vocabulary. `hq_reliability_run_events` carries no hash chain and is not
cross-checked against the chained `op_evidence` entry each facade write also
lands, so ONE raw `INSERT` of a well-formed `reconciled` event still flips a
run's derived state and re-admits an attempt (Wave 5 Medium 4, structural half).
The MINIMUM was done — the `interrupted` branch's `uncertain` flag now fails
closed, so an absent, corrupt or non-boolean value reads as UNCERTAIN rather
than as "nothing happened", and an unreadable `failureCategory` reads `unknown`
rather than `none`. The structural half (hash-chaining that table, or deriving
reconciliation only for events with a matching chained evidence entry) changes a
pure function's signature, the store shape and every call site, and would leave
every pre-existing row unverifiable on an existing file. It is open.

## The five reconciliation paths

Every interruption the directive names has an explicit answer, and none of them
is a retry.

| Path | Answer |
|---|---|
| `outcome_unknown` | `reconcileRun` — approval authority plus independence from the carrier, with the same idempotency rule the queue and the gateway already impose. |
| provider outage | `recoverInterruptedRuns({ reason: 'provider_outage' })`, or a worker recording `outcome_unknown` with `failureCategory: 'provider_unavailable'`. Categorical either way. |
| partial attempt | `RUN_INTERRUPTION_REASONS.partial_attempt`, classified uncertain when the capability could have reached outside. |
| stale lease | Reported as a COUNT with `OperatorQueue.sweepExpiredLeases` named as the canonical resolver. Phase 13 does not sweep — the queue owns that. |
| interrupted action | Phase 8 actions at `attempted`/`outcome_unknown` are reported as a COUNT with `reconcileAction` named as the canonical resolver. Not one row is written into `hq_action_events`. |

## Safe mode

`SAFE_MODE_STATEMENT`, verbatim on every view: safe mode is a statement about
HQ's OWN stored record, not about the outside world.

**It engages on four findings, and only four**, each of which means HQ's own
record cannot be trusted:

- `database_integrity_check_failed` — the engine says the file is corrupt;
- `append_only_guard_missing` — a guard the schema DECLARES is absent;
- `append_only_ledger_truncated` — a declared append-only ledger holds fewer
  rows than the engine's own high-water mark says it reached (round six, High 1
  and High 2). Deliberately NOT folded into `append_only_guard_missing`: in the
  attack it names every declared guard is present and correct at the moment the
  census looks, so reporting it as a missing guard would tell the Founder
  something untrue of the file;
- `evidence_chain_broken` — the hash-chained log does not verify (or cannot be
  verified at all; an unverifiable chain is treated as a broken one).

(This paragraph read "three findings, and only three" through the round-six
lane that added the fourth, and through the merge of the two round-six lanes.
The vocabulary is seven names and the blocking list is four —
`SAFE_MODE_BLOCKING_FINDINGS` in `store/integrity.ts` — as the round-six section
below already stated. Corrected here at the round-seven reconciliation.)

`foreign_key_violations`, `durability_below_requirement` and
`reliability_schema_absent` are REPORTED and do not engage it. That is argued
rather than assumed: a dangling reference is a defect in a relationship and a
degraded durability posture risks the NEXT crash, but neither says a recorded
fact is false, and treating them as corruption would make safe mode a thing
operators route around instead of a thing they act on.

### What it refuses, and what it deliberately does not

The asymmetry is the point: safe mode never removes a way to STOP something and
never removes a way to find out what is wrong.

| Refused | Kept available |
|---|---|
| every Founder-gated command write (mission, project, memory, truth, orchestrate, collaboration, brief, product) | every READ — a Founder who cannot see the store cannot fix it |
| `approveTask` — an approval bound now would sit primed to run the moment safe mode clears | `denyTask` — the fail-safe direction |
| `acceptTruth` — the Founder's approval-authority, digest-bound, one-shot ACCEPTANCE of a truth record; the act `SAFE_MODE_STATEMENT`'s word "APPROVE" denotes if it denotes anything | `reviewTask` — a verdict on work that was claimed and executed BEFORE safe mode engaged |
| `authorizeAction` — the external-action analogue of the same argument: the `authorized` snapshot is captured from canonical truth HQ has just declared untrustworthy, it outlives the clearing of safe mode, and `executeAction` compares against it | `proposeAction` — a proposal is a request, not an authorization, and it reaches nothing |
| `releaseKillSwitch` | `engageKillSwitch` — the fail-safe direction |
| `registerExecutionWorker`, `declareWorkerProvider`, `registerAiMember` — the three that ADD authority | `revokeWorkerProvider`, `deactivateExecutionWorker`, `disableAiMember` — the three that remove it |
| `claimNext` — refused as `safe_mode_engaged`, distinctly from `nothing_claimable` | `recoverInterruptedRuns`, `reconcileRun`, `reconcileTask`, `reconcileAction` — the acts that resolve the state |
| `executeAction` — refused BEFORE the reservation, so no side-effect key is burned | `assessHqIntegrity` and `recordVerifiedBackup` — the acts that investigate and clear it |
| `openRun` / `startRunAttempt` / `recordRunOutcome` | `startTask`, `heartbeat`, `submitResult`, `failTask` — work already claimed and already running, which must still be able to report |
| `recordIntelligenceDecision`, `escalateIntelligenceDecision`, `recordIntelligenceOutcome`, `recordIntelligenceCost`, `recordModelObservation`, `setIntelligenceBudget` (Phase 14) | `returnForFreshApproval` — strictly narrowing: it can only clear a dead approval |

**This table was right and the one-sentence `SAFE_MODE_STATEMENT` was broader
than it** (Wave 5 correction round four, Low L6). The shipped sentence said HQ
"refuses the acts that would ADD TO … a record it cannot stand behind", while
`createTask`, `proposeMission`, `appendSystemEvidence`, `recordVerifiedBackup`
and `engageKillSwitch` all add rows under an engaged latch — each for the reason
given in the tables below. The sentence now names what is actually
refused: acts that would APPROVE, RELEASE, EXECUTE against or grant AUTHORITY
over that record.

**Both columns are now EXHAUSTIVE, and the suite enforces that** (Wave 5
correction round seven, Medium 1). Three times in this wave a mutator turned out
to be in neither column — `authorizeAction` in the review, `registerExecutionWorker`
and `declareWorkerProvider` in round three, and in round seven `acceptTruth`,
`registerAiMember`, `disableAiMember`, `setAiMemberHealth`, `postMissionMessage`,
`reconcileTask`, `rejectProposal` and `returnForFreshApproval` all at once. A
narrative table cannot stop that happening a fourth time, so the two tables
below name EVERY public method of `HeadquarterOperations` that writes, one row
each, and `safe-mode-disposition.test.ts` derives the same two sets from
`application/service.ts` and fails when they differ in either direction. A new
mutator that lands in neither table fails the suite; a method listed in a table
that no longer has the disposition it claims fails it too.

#### Every facade write REFUSED while safe mode is engaged

| Refused | Why |
|---|---|
| `approveTask` | an approval bound to a record HQ cannot stand behind would sit primed to run the moment safe mode clears. |
| `acceptTruth` | the Founder's approval-authority, digest-bound, step-up-gated, one-shot acceptance of a truth record. Acceptance executes nothing — no task, approval row, claim or dispatch is touched — which is why this was a Medium rather than a High; it is refused anyway because an act the shipped sentence calls APPROVE must either be refused or be here in the other table with its reason. |
| `claimNext` | a claim hands work to a worker. Refused as `safe_mode_engaged`, distinctly from `nothing_claimable`. **And the refusal now lives at the CANONICAL boundary as well** (Wave 5 correction round ten, High 3). It used to live only here, in the wrapper, while `HeadquarterOperations.queue` is a `public readonly` field and `src/operator/queue.ts` contained zero occurrences of `safeMode` — so with safe mode genuinely latched, `ops.claimNext(...)` was refused and `ops.queue.claim(...)` SUCCEEDED, and a hostile reviewer ran the whole lifecycle through the delegate (`claim` → `start` → `heartbeat` → `complete`, task reaching `running`). `OperatorQueue.claim` now consults the latch first, through a `#private` gate installed by this facade and unreachable from any object a caller holds. Pinned by `queue-safe-mode-enforcement.test.ts`, including a hostile-patch case. |
| `releaseKillSwitch` | the direction that lets work run again. |
| `declareWorkerProvider` | it is what lets a worker claim provider-bound work at all, so it ADDS authority. |
| `registerExecutionWorker` | creates a worker identity WITH its `allowedCapabilities`, straight into the table `#grantOf` reads at every enforcement point. Create-only, with no revoke path. |
| `registerAiMember` | writes `grantedCapabilities`, from which `RegistryWorkerDirectory` derives the `effectiveCapabilities` it answers `allowedCapabilities` with. That the shipped host leaves the narrowing seam unwired is a deployment fact, not a property of the method. |
| `assignTaskAsFounder` | the Founder-gated wrapper is gated by the `hq.workforce_assign` trio, and every Founder-gated command write is refused. (The bare `assignTask` stays available — see the other table.) |
| `commandMission` | Founder-gated command write. |
| `transitionMission` | Founder-gated command write. |
| `amendMissionIntent` | Founder-gated command write. |
| `linkMissionPlanItem` | Founder-gated command write. |
| `orchestrateMission` | Founder-gated command write; `apply` links plan items to tasks. |
| `assignMissionToProject` | Founder-gated command write. |
| `createProject` | Founder-gated command write. |
| `updateProject` | Founder-gated command write. |
| `transitionProject` | Founder-gated command write. |
| `createProduct` | Founder-gated command write. |
| `moveProductLifecycle` | Founder-gated command write. |
| `registerProductArtifact` | Founder-gated command write. |
| `openRun` | opens the run ledger's record of an execution HQ is about to admit. |
| `startRunAttempt` | records that an attempt is running against canonical truth HQ cannot vouch for. |
| `recordRunOutcome` | records the outcome of that attempt. |
| `recordModelObservation` | Founder-gated command write (Phase 14). |
| `setIntelligenceBudget` | Founder-gated command write (Phase 14) — a budget is a standing authorization to spend. |
| `recordIntelligenceDecision` | Founder-gated command write (Phase 14). |
| `escalateIntelligenceDecision` | Founder-gated command write (Phase 14). |
| `recordIntelligenceOutcome` | Founder-gated command write (Phase 14). |
| `recordIntelligenceCost` | Founder-gated command write (Phase 14). |
| `recordMemory` | Founder-gated command write. |
| `recordTruth` | Founder-gated command write. |
| `verifyTruth` | Founder-gated command write. |
| `authorizeAction` | the `authorized` snapshot is captured from canonical truth HQ has just declared untrustworthy, it outlives the clearing of safe mode, and `executeAction` compares against it. |
| `executeAction` | the one act HQ cannot walk back. Refused BEFORE the reservation, so no side-effect key is burned. |
| `openCollaborationSession` | Founder-gated command write. |
| `admitCollaborator` | Founder-gated command write; admission is an addition. |
| `recordContribution` | Founder-gated command write. |
| `assembleCollaborationContext` | Founder-gated: it writes the assembled bundle. |
| `issueBrief` | Founder-gated command write. |

#### Every facade write LEFT AVAILABLE while safe mode is engaged, each with its reason

| Left available | Why |
|---|---|
| `createTask` | a queued task is a request that cannot execute: claiming it is refused, so nothing it carries can happen while safe mode stands. Refusing creation would stop a Founder recording the very work that fixes the store. **This sentence was FALSE as written until round ten and is now true** (High 3): the claim refusal lived only in `claimNext`, and the same task was claimable through `ops.queue.claim` — so a queued task carried plenty that could happen. The refusal is now enforced in `OperatorQueue.claim` itself. |
| `assignTask` | assignment narrows who MAY claim; the claim itself is refused. It removes an option, it never adds one. |
| `routeTask` | advisory routing. `eligible` is computed from the capability registry and the directory allow-list, it changes no canonical state, and the claim it might inform is refused anyway. The only thing it can write is an evidence note saying a nomination source misbehaved. |
| `denyTask` | the fail-safe direction. |
| `startTask` | belongs to work already claimed and already running. Refusing it would strand a live execution with nowhere to report. |
| `heartbeat` | the same, one field across: it only says the live claim is still alive. |
| `submitResult` | the same. Refusing it loses truth rather than protecting it. |
| `failTask` | reporting a failed execution is the fail-safe direction of `submitResult`. |
| `reviewTask` | a `pass` verdict completes a task and is the closest of these to an approval, but the task it completes was claimed and executed BEFORE safe mode engaged. Refusing the verdict does not un-execute it; it only leaves HQ unable to record what happened. **Stated as the argued judgement it is, not as an obvious one.** |
| `reconcileTask` | one of the acts that RESOLVE an uncertain state, exactly like `reconcileRun` and `reconcileAction`. Refusing it would make safe mode self-sustaining. |
| `returnForFreshApproval` | strictly NARROWING and a no-op unless an approval is already dead: it clears a task's binding to an approval that no longer admits execution. The fresh decision that would follow is an ordinary `approveTask`, which is refused. |
| `engageKillSwitch` | the fail-safe direction. |
| `appendSystemEvidence` | the entry that had to be ARGUED, because it appends into the very hash chain a latched `evidence_chain_broken` finding is a statement about. Every kind it can still write records a system lane REFUSING to act (`claude_github_dispatch_refused`, `direct_order_dispatch_blocked`); the kinds that DECIDE a dispatch outcome are structurally excluded and reachable only through the constructor grant; and the actor is a reserved system name that can never resolve to a principal or a worker. It grants nothing and concludes nothing, and refusing it would leave a lane unable to record that it declined — losing truth in the posture built for not losing truth. |
| `reserveEvidence` | atomicity, not authority: it runs a callback in one write transaction and writes nothing itself, and every gate inside the callback still applies. |
| `lookupPrincipal` | a read. It is in this table because the enumeration covers every public method the source scan reaches, and leaving it out would be the same silent omission this table exists to end. |
| `revokeWorkerProvider` | strictly NARROWING: it can only take authority away, and there is no reactivate method. `declareWorkerProvider` is refused for the mirror-image reason. |
| `deactivateExecutionWorker` | the same. `registerExecutionWorker` is refused for the mirror-image reason. |
| `disableAiMember` | the same, one registry across: `status: 'disabled'` makes `assignability` answer `worker_inactive`. `registerAiMember` is refused for the mirror-image reason. |
| `setAiMemberHealth` | a closed vocabulary that grants nothing. The only enforcement-adjacent reader is `registry/routing.ts`, which excludes an `unavailable` member from an ADVISORY ranking — so the most it can do is re-admit a member to a nomination list, and `routeTask`, whose whole output that is, is available for the same reason. Refusing it would only stop the Founder recording that a member is down. |
| `postMissionMessage` | storage only. It creates no task, touches no approval and grants nothing, whatever the text says; the one bridge from a room to work creates a task that cannot be claimed. Refusing it would stop a Founder and a worker discussing the outage they are fixing. |
| `proposeMission` | a proposal reaches nothing and authorizes nothing. |
| `promoteProposal` | the task a promotion creates cannot be claimed while safe mode stands, so it cannot become an act. |
| `rejectProposal` | the CLOSING direction of `promoteProposal`: it can only take an open proposal off the table. The same asymmetry that keeps `denyTask` available while `approveTask` is refused. |
| `recoverInterruptedRuns` | one of the acts that RESOLVE an uncertain state. |
| `reconcileRun` | the same. |
| `reconcileAction` | the same. |
| `assessHqIntegrity` | the act that investigates safe mode and is the only thing that clears it. Its capability gate passes `permittedInSafeMode = true` on purpose. |
| `recordVerifiedBackup` | the act that preserves a recovery point while the store is untrusted. Same gate, same flag. |
| `proposeAction` | a proposal is a request, not an authorization, and it reaches nothing; `authorizeAction` and `executeAction` are both refused. |

**The residual this table does not cover, recorded rather than implied** (Wave 5
correction round eleven, Low 3). Both tables enumerate `HeadquarterOperations`
and the canonical boundary underneath it. `OperatorQueue` is also exported from
`@factoryos/headquarter/operator`, and constructing a SECOND one directly over
the same database handle — `new OperatorQueue(db, …)` — produces a queue whose
constructor installs no safe-mode gate, and it claims freely under a genuine
latch (executed: `-> CLAIMED fd36da5a… fence 1`). It is out of reach of a caller
who holds only `HeadquarterOperations`: `#db` is `#private` on both, so the
handle cannot be taken from the facade, and `ops.queue.claim` — the delegate the
round-ten High 3 closed — is gated. What is left is a caller who already has the
database handle, which is the same authority as opening the file, and against
that authority no in-process gate is a boundary. It is NOT closed by a check in
`OperatorQueue`'s own constructor, deliberately: the facade constructs its queue
during its own construction, and a constructor that threw under a latch would
make `assessHqIntegrity` — the only act that clears safe mode — unreachable on
exactly the file that needs it.


### When it is assessed, and the cost of each

| Depth | What runs | When |
|---|---|---|
| `structural` | the schema catalogue (three `sqlite_master` reads), the durability pragmas, one `COUNT(*)` and one `MAX(rowid)` over each of the 33 declared ledgers, one further `MAX(rowid)` seek for each declared ledger the engine carries a positive `sqlite_sequence` row for, and five reads of `hq_integrity_checkpoints` — a `COUNT(*)` served by a covering index, one indexed lookup joined to `op_evidence` by rowid, and three full SCANs that expand each row's marks through `json_each` and group them in a temporary B-tree | **every construction of the facade.** One term IS proportional to the operational data — a `COUNT(*)` is proportional to the rows a ledger holds, where the seek beside it is not — and it is paid deliberately, because a seek cannot see a row removed from the MIDDLE of a ledger and a count can. **This row carried the retired wording for two rounds after it was retired everywhere else, and is corrected in round twelve (Medium 3). It said "one `MAX(rowid)` seek per declared ledger, and one `COUNT(*)` plus one indexed lookup" until round ten (Low 1)**, which understated its own pass three ways: the third read is a scan with a temp B-tree rather than a lookup, and `hq_integrity_checkpoints` is not fixed in size — it grows a row per clean boot and per clean assessment. Round ten's own replacement, "two `MAX(rowid)` seeks for each ledger HQ has committed a mark for", was wrong twice over and is what round twelve corrects here: the standalone seek is ONE, not two, and it is taken while walking `sqlite_sequence`, so it is not the committed set — on the fixture's own warmed file it reaches four ledgers where HQ has committed marks for three, and it would reach a ledger HQ has committed nothing about. No statement TOTAL is quoted here any more, for the reason given at `STRUCTURAL_STATEMENT_BASE`: three have been shipped and all three were wrong. Measured with `EXPLAIN QUERY PLAN` and by counting the statements a pass executes, and pinned that way in `integrity-statement-truth.test.ts` |
| `full` | everything structural, plus `PRAGMA integrity_check`, `PRAGMA foreign_key_check` and a whole-log evidence-chain verification | only `assessHqIntegrity`, a Founder act — these are O(database) and O(log) |

The depth is carried ON the verdict and on the published snapshot, so a cheap
pass can never be mistaken for a full one.

**This row said "the schema catalogue and the durability pragmas" alone, and
was stale by four correction rounds (round eight, Medium 1).** The commitment
and high-water-mark reads were added to the cheap pass by rounds five and six
and the row was never re-read, so the page under-stated what a boot detects —
fail-safe in direction, and exactly the drift this wave keeps finding. Measured
at this head by inducing all seven findings against a real file and running both
depths over each: `structural` raises five of them —
`append_only_guard_missing`, `append_only_ledger_truncated`,
`evidence_chain_broken`, `durability_below_requirement` and
`reliability_schema_absent` — and only `database_integrity_check_failed` and
`foreign_key_violations` need the full pass. That partition is now derived by
execution in `integrity-statement-truth.test.ts` and compared to the sentence
HQ serves the Founder, so the two cannot separate again.

**The boot-time observation is taken BEFORE the schema ensures, and that is
load-bearing.** Every `ensure*Schema` is `CREATE TRIGGER IF NOT EXISTS`, so a
construction RESTORES a dropped guard. A check run after them would find a
healthy file and report one — HQ would silently repair a tamper and say nothing
about it. So the missing-guard list is observed as the file was FOUND and
passed into the check. HQ can re-create the guards it declares; it cannot know
what was written while they were absent, and safe mode is exactly the posture
for that. Clearing therefore takes an explicit assessment of the file as it now
stands, not a restart.

**Nothing clears it by assertion.** There is no override parameter, no force
flag and no acknowledge, and a source scan pins that no such method name
exists. The verdict is a `#private` latched field; a hostile patch of
`hqReliabilityPosture` and `reliabilitySummary` is proven to have taken on the
instance, on the prototype, and on a facade constructed AFTER the patch — and
to buy no claim on either facade.

**And a restart does not clear it either, because the verdict is RECORDED.**

> **Correction (Wave 5 review, HIGH finding 1 — the second one).**
> `SAFE_MODE_STATEMENT` shipped verbatim on every reliability view, in every
> refusal message and in the unauthenticated snapshot, asserting: "It is never
> cleared by a boot: only a fresh assessment that finds nothing blocking clears
> it." The paragraph above repeated it. **Both were false.** The verdict lived
> only in the in-memory `#integrityReport`; construction ran
> `structuralIntegrity`, which by design cannot see a broken evidence chain;
> nothing was persisted and nothing re-read. A plain restart over a file whose
> chain was still broken at seq 2 reported `safeMode: false`, depth
> `structural`, findings `[]` — and handed `releaseKillSwitch` and `claimNext`
> back out. In a local-first CLI model every command is a new process, so this
> was the ordinary path rather than an exotic one. `append_only_guard_missing`
> had the same shape with one extra step: it survived exactly one boot, because
> boot #1's `ensure*Schema` re-created the dropped trigger and boot #2 then
> found a healthy file.
>
> **What changed.** `hq_reliability_verdicts` is a fourth append-only ledger
> (the full trio of guards; declared in `ENGINE_IMMUTABLE_TABLES`), holding one
> row per verdict: when, at what depth, safe mode or not, and the categorical
> findings. `assessHqIntegrity` appends the verdict and its evidence entry in
> ONE `privileged.reserve`, and only then updates the latch — which also closes
> LOW 8's ordering complaint, where the field was assigned before the evidence
> append and a throw could leave the posture changed with no audit entry. The
> constructor reads the last verdict and re-raises every BLOCKING finding it
> holds, so the latch belongs to the record rather than to one process's memory;
> and when a construction's own structural pass is blocking and nothing standing
> already says so, it APPENDS that observation (through the same reserve), so
> the tamper a boot repairs is not forgotten by the next boot.
>
> Non-blocking findings are deliberately not carried: re-asserting a stale
> `durability_below_requirement` would be HQ stating something it has not just
> checked. Clearing is unchanged in principle and now true in fact — only
> `fullIntegrity` over the file as it now stands supersedes the record.
>
> The prose says the mechanism and says where it does not apply: on a database
> that carries no Phase 13 ledger there is nowhere to record a verdict, so it is
> process-local there, and the `reliability_schema_absent` finding says when
> that is the case.

> **Correction (Wave 5 review, HIGH finding 1).** That paragraph was true of
> the FIELD and false of the LATCH, and the gap was real rather than
> theoretical. `assessHqIntegrity` computed `evidence_chain_broken` — one of the
> three blocking findings, and the only one that detects tampering with HQ's own
> audit record — through `() => this.queue.evidence.verifyChain()`. `queue` is a
> public `readonly` field and `queue.evidence` is a mutable own-property object
> literal that issue #200 deliberately keeps PATCHABLE, safe exactly while
> nothing is enforced on it. So the finding could be switched off by assignment,
> and worse: the next legitimate Founder assessment then found nothing and
> CLEARED an already-latched safe mode, handing `releaseKillSwitch` and
> `claimNext` back out against a chain that was still broken. This violated
> permanent architectural law 3 and repeated a defect class the repository had
> already hardened against three times (`queue.evidence` under #200,
> `#getTask`/`#capabilityOf` rebuilt as private closures).
>
> **Fixed** by the pattern `#capabilityFromStore` and `#runClaimFact` already
> use: `#verifyEvidenceChainFromStore` is a `#private` closure over the facade's
> own handle and a new module-level `verifyEvidenceChain(db)` in
> `operator/evidence.ts`. `EvidenceLog.verifyChain` is now a thin delegate over
> the same function, so the read surface and the enforcement path share ONE
> computation and cannot drift, and no prototype method participates — patching
> `EvidenceLog.prototype.verifyChain` or `.list` moves what the patcher sees and
> nothing that safe mode decides. Pinned by
> `reliability-authority.test.ts` → "the safe-mode evidence verdict is computed
> from enforcement-safe truth": the chain is broken by a LEGAL APPEND from a raw
> connection, safe mode engages, the delegate is patched on the instance AND on
> `EvidenceLog.prototype` (both proven to have taken), and the finding still
> engages, the latch is still not cleared, `releaseKillSwitch` and `claimNext`
> still refuse, a facade constructed AFTER the patch reaches the same verdict,
> and an independent recomputation confirms the chain really is broken. A source
> scan additionally pins that no non-comment line of `service.ts` reaches
> `queue.evidence.verifyChain`.
>
> With that in place the paragraph above is now true of both: nothing clears
> safe mode by assertion, and nothing clears it by patching a read either.

### The latch is DURABLE, and it was not

> **Correction (Wave 5, reached INDEPENDENTLY by two correction lanes — one as
> HIGH 1, one as HIGH 2).** Both found the same defect from the same executed
> evidence and both built the same guarantee: after a full assessment engaged
> `evidence_chain_broken`, a RESTART reported `safeMode: false` at depth
> `structural` with `claimNext` ALLOWED, while `verifyEvidenceChain` still
> reported the break and the world-readable snapshot published `safeMode: false`
> over it; an `append_only_guard_missing` engagement survived exactly one boot,
> because the next `ensure*Schema` re-created the trigger.
>
> **ONE implementation survives.** The engagement is a row in
> `hq_reliability_verdicts`, described in full in the correction above. The
> other lane built the same durability as its own INSERT-only
> `hq_safe_mode_latch` table; that table, its DDL, its readers, its writer, its
> type and its census entry were deleted in the reconciliation rather than kept
> beside the verdict ledger, because two append-only tables answering "is safe
> mode engaged" is a second truth. Its tests were ported onto the survivor
> rather than dropped: UPDATE and DELETE from a raw connection are refused,
> dropping `trg_hq_reliability_verdicts_no_erase` is a census finding, a restart
> with the chain still broken keeps safe mode and publishes it, and a second
> boot after a dropped guard keeps it even though the first boot re-created the
> trigger.
>
> **Three properties carried across from the dropped implementation, because it
> stated them and the survivor had not.**
>
> 1. **A recorded verdict that says ENGAGED engages even when its stored finding
>    list cannot be read.** A raw append can put a finding name outside the
>    closed vocabulary into the ledger. That name is still dropped — it must
>    never reach the unauthenticated artifact's key set or a refusal message, and
>    no vocabulary member is invented for it — but dropping the ENGAGEMENT with
>    it was the fail-open answer, and the surviving lane's own test asserted
>    exactly that. `carryRecordedVerdict` now reports the standing engagement
>    separately from the findings it could carry, `#safeModeRefusal` names the
>    situation categorically instead of rendering "HQ is in SAFE MODE ()", and
>    the snapshot's finding counts stay at zero rather than gaining a fabricated
>    key. Both lanes' assertions are kept, on the merged behaviour.
> 2. **The reported `depth` stays the depth of the CURRENT assessment**, never
>    the recorded one — a structural boot must not present itself as a full pass
>    — and the recorded depth is stated in the carried observation's detail
>    instead.
> 3. **A READ-ONLY handle (the `hq:snapshot` CLI) writes nothing.** It reports
>    the verdict it finds, which is the honest answer for a handle that promised
>    not to write, and it means a read-only process observing a blocking finding
>    for the first time reports it without recording it.
>
> **What this does NOT protect against, stated rather than glossed.** The
> standing verdict is the LAST row, and an APPEND is the write the table's
> triggers deliberately permit. A writer that already holds a writable handle on
> the file can therefore append a `safe_mode = 0` row, and the next
> construction's own pass is STRUCTURAL — which by design cannot see a broken
> evidence chain — so an `evidence_chain_broken` engagement would not be
> re-derived. That is exactly the class of residual this document already records
> for `hq_reliability_run_events`. The guards close the other doors (no UPDATE of
> a standing row, no DELETE of the history, no REPLACE onto an existing id) and
> the census reports them if they go missing. Against a writer with the file
> already open this is bookkeeping, not a boundary; what it closes is the thing
> it was built for — a plain RESTART silently lowering a verdict HQ had already
> reached.

## Backup and restore

HQ does not take a backup and cannot restore one. Taking one safely — inode
reservation, no-replace publication, directory-entry commits, the whole Stage 3
apparatus — already lives in `@factoryos/hq-host`'s durable persistence owner,
and restoring is a deliberate operator act against a stopped process. Phase 13
adds the half that was missing: **verification, and a register of what was
verified.**

`verifyHqBackupFile` is read-only with respect to the CANDIDATE in the
strongest available sense — the file is opened `O_RDONLY | O_NOFOLLOW` and
never written, and no `-wal`/`-shm` is created beside it. Seventeen categorical
refusals, never an exception: `path_not_absolute`, `path_not_normalized`,
`path_missing`, `path_is_symlink`, `path_not_a_regular_file`,
`path_not_readable`, `file_empty`, `file_too_large`,
`file_has_multiple_links`, `sidecar_journal_present`,
`candidate_is_the_live_database`, `verification_copy_failed`,
`not_a_readable_sqlite_database`, `integrity_check_failed`,
`not_an_hq_database`, `would_latch_safe_mode`,
`candidate_census_unavailable`. Fourteen of the seventeen are exercised against
real files on disk — a relative path, an unnormalized absolute one, a missing
one, a directory, an empty file, a symlink, a hard link to another name, the
live database at its own path, a file of prose, a corrupted SQLite image,
a valid SQLite database that is simply somebody else's, a genuine backup
with a `-wal` dropped beside it (twice over: as a dropped sidecar, and as a
live un-checkpointed WAL database whose newest table exists only in the
sidecar), a file whose own record would latch safe mode, and a call that
supplies no assessor at all. `file_too_large` is NOT exercised: it would mean
writing a two-gigabyte file in a test, and a bound asserted by reading the
constant rather than by crossing it is stated here as what it is.
`path_not_readable` and `verification_copy_failed` are likewise not exercised —
both need a filesystem HQ cannot read or write, which a test that must pass on
any developer's machine cannot arrange honestly.

> **Correction (Wave 5 correction rounds eleven and twelve — MEDIUM 2 in one
> lane, Low 3 in the other; both lanes found it independently and both pins are
> kept).** The three numbers above were stale in three places and NO test pinned
> any of them. The list said "Thirteen" and "ten of the thirteen" while
> `BACKUP_REFUSAL_REASONS` held sixteen, and it omitted
> `file_has_multiple_links`, `candidate_is_the_live_database` and
> `would_latch_safe_mode` from its own enumeration — each added by an earlier
> round of this same wave, each with the count left behind. It then went stale
> AGAIN inside the correction itself: one lane re-derived the sentence against a
> constant of sixteen at the same time as the other added
> `candidate_census_unavailable`, taking the real length to seventeen, and the
> merge of the two lanes is what caught that — which is the whole point of
> pinning a count to its constant rather than to a reviewer's memory. Two
> derived pins now stand over this paragraph: `backup-refusal-vocabulary.test.ts`
> derives the count word, the enumeration and the exercised/not-exercised split
> from `BACKUP_REFUSAL_REASONS` and from the test directory, and
> `reliability-durability.test.ts` independently re-derives both counts and
> requires every unexercised reason to be excused here by name. Neither sweep
> counts a reason that appears only in a file whose job is to COUNT reasons: a
> name written down in order to be asserted about is not an exercise of it, and
> a census that counted itself would have reported all seventeen as exercised.

> **Correction (Wave 5 correction round eleven, HIGH 1).** `verifyHqBackupFile`
> ran HQ's census as `structuralIntegrity(db)` with NO options, so the standing
> verdict the candidate records ABOUT ITSELF was never read and the evidence
> log's links were never walked. Executed: a file whose boot had recorded
> `safe_mode=1 ["append_only_guard_missing"]`, its guard since re-created by
> HQ's own ensure pass, verified `{ verified: true, refusals: [],
> integrityVerdict: 'ok' }` while the same bytes opened live gave
> `safeMode: true`; and a copy whose `op_evidence` payload was rewritten in
> place at a seq behind the last checkpoint commitment verified `ok` too.
> `recordVerifiedBackup` certified both into the INSERT-only register. Both
> inputs live above `store/` — the verdict ledger in `application/`, the
> whole-log verifier in `operator/` — so they now arrive through a REQUIRED
> `assessCandidate` injection (`assessHqBackupCandidate`), the same shape
> `fullIntegrity` uses for `verifyEvidenceChain`; an assessment that could not
> run is `candidate_census_unavailable` rather than a pass.

> **Correction (Wave 5 review, HIGH finding 3 / Medium 3 — both correction
> lanes found it independently).** The digest and the checks were statements
> about DIFFERENT byte sets, and the gap was exploitable. `digestFile` hashed
> the main file through a descriptor while `integrity_check`, the schema census
> and the `hq_events` marker were evaluated by a SECOND open of the PATH — and
> SQLite resolves a path together with its `-wal`/`-shm`. A plain `cp` of a live
> WAL-mode HQ database therefore verified `true`, with 45 tables read out of a
> sidecar the digest never covered, a `sizeBytes` counting the main file only,
> and the pristine file's digest recorded permanently in an append-only
> register; the other lane executed the same defect from the other side, with
> two candidates carrying an identical `contentDigest` and an identical recorded
> size while their verified table counts differed (11 versus 12).
> `backupRecordKey` is `hash(path, digest)`, so two materially different backups
> collapsed onto one record. The same block was TOCTOU besides: `lstat` →
> `openSync(O_NOFOLLOW)` → open-by-path, where only the first two constrained
> the final component, which made `path_is_symlink` advisory for exactly the
> half that decided `verified`.
>
> **Both are closed the same way.** After the `O_NOFOLLOW` open the function
> never touches the path again: the descriptor's bytes are hashed and copied to
> a scratch file under the OS temp directory in ONE pass, and the database
> checks run against the copy, which is removed before the function returns. So
> what `integrity_check` read, what `schemaTables` counted and what `digest` is
> of are the same bytes by construction. That also removed a defect the fix
> would otherwise have introduced: opening the candidate with SQLite CREATED
> `-wal` and `-shm` beside it and left them, so a verification that refused
> sidecars while opening the candidate directly would have refused its own
> leftovers on the second call — pinned now by a test that verifies the same
> file twice and asserts no sidecar was created.
>
> The other lane closed the same TOCTOU differently, by HOLDING the digest
> descriptor across the SQLite open and re-digesting through it afterwards,
> refusing a divergence as `file_changed_during_verification`. That
> implementation is dropped and its refusal reason with it, because the
> scratch-copy version does not need the check: one pass over one descriptor
> produces the digest, the copy and the checks together, so there is no window
> in which they can disagree, and SQLite never re-resolves the candidate path at
> all. A race closed by construction is preferred to a race detected afterwards,
> and the reason nothing pinned it — it was recorded as an untested refusal — no
> longer exists to be pinned.
>
> A sidecar beside the candidate is still refused rather than checked around,
> because the main file alone may then not be the database an operator would
> restore. The surviving rule refuses on PRESENCE rather than on non-zero size
> (the other lane's `file_has_uncheckpointed_wal` bound), because presence is
> what makes the main file possibly not the whole database. Pointing this at the
> LIVE HQ database AT ITS OWN PATH is consequently refused — a live HQ database
> is WAL-mode — which is a more honest answer than the "safe as well as useless"
> pass it used to give.
>
> **That was written as "the live database is refused" and the scope was wrong
> in two ways the third correction round executed (Medium A4).** A HARD LINK to
> the live inode, under a name with no sidecars beside it, PASSED — because the
> sidecar check is keyed on the resolved PATH — and the live database was then
> recorded permanently in the append-only register as a verified recovery point
> while its committed content was demonstrably not all in the bytes that had
> been digested. `nlink` is taken from the descriptor that was actually opened
> now, and a candidate with more than one name is refused as
> `file_has_multiple_links`: a snapshot another name can still be written
> through is not a snapshot. A plain `cp` of a live WAL database, however, is a
> copy of an arbitrary prefix of the truth: it is a different inode with no
> sidecars, and what it holds is whatever had been checkpointed into the main
> file when it was copied. (**"Still verifies and always will" was too strong,
> and is corrected in the fourth round — Low L8.** Executed: a `cp` of a live but
> UNCHECKPOINTED store was REFUSED `not_an_hq_database` with `schemaTables: 0`,
> because everything including the schema was still in the `-wal`; only a
> post-`wal_checkpoint(TRUNCATE)` copy verified. Such a copy may read as sound,
> as empty, or as not a database at all.) `verified` means "these bytes are a
> sound HQ database" and has never meant "this is the whole of what was
> committed when they were copied". `MAX_VERIFIED_BACKUP_BYTES` now bounds the READ rather than only the
> pre-open `lstat`, and the `openSync` failure that used to collapse every cause
> into `path_not_a_regular_file` is distinguished (LOW 12).
>
> **A symlinked PARENT directory is resolved and RECORDED, not refused.**
> `lstat` and `O_NOFOLLOW` cover only the FINAL path component (verified true
> with a directory symlink), so a candidate reached through a symlinked ancestor
> used to be verified silently under the alias the caller named. An ancestor
> link substitutes no file — the digest still describes whatever inode the path
> resolves to — so what it breaks is bookkeeping.
> `BackupVerification.resolvedPath` carries the path HQ actually opened and
> `recordVerifiedBackup` stores THAT, so the register and the dedupe key name
> the file rather than an alias for it. Refusing on any divergence was the other
> option and was rejected as disproportionate and non-portable: on macOS
> `os.tmpdir()` itself sits under a symlinked `/var`. WHICH file an operator may
> point at remains a question this function does not answer.

> **Correction (Wave 5 review, LOW finding 8).** Seven of those eight refusals
> were asserted BY NAME; the corrupted-database one asserted only `verified:
> false` plus the facade's error code, which left `integrity_check_failed` the
> one exercised refusal whose reason nothing pinned — a corrupted backup and a
> good one refused for an unrelated reason read the same. The test now asserts
> the refusal name, the non-`ok` integrity verdict, and that the name reaches
> the caller in both the message and the `details.refusals` array.

`recordVerifiedBackup` performs the verification itself rather than trusting a
caller, and records the sha256 **HQ computed over the bytes it checked** —
never a declared digest. `BACKUP_RECORD_STATEMENT` says so on every view.

Restart proof and restore verification are proven end to end: a real file is
backed up, verified, copied, verified again, opened as a working HQ, and the
run recorded before the backup is read back out of the restored copy. The
digest comparison is made BEFORE the restored file is opened live, because an
open WAL-mode database carries a `-wal` and is therefore no longer a candidate
this verification will vouch for.

## Authority

| Act | Authority | Why that one |
|---|---|---|
| `openRun`, `startRunAttempt`, `recordRunOutcome` | the LIVE FENCED CLAIM on the referenced canonical task, read straight off `op_tasks` through `#db` | the worker holding the claim is the one entity that can honestly say what that execution did. It grants nothing: holding a claim already allows the worker to execute; this only lets it record what it did. |
| `recoverInterruptedRuns` | approval authority | a classification of what happened is a Founder judgement, exactly like `reconcileAction`. |
| `reconcileRun` | approval authority **plus** independence from the carrier, **plus** the idempotency rule for `confirmed_not_executed` | the entity whose attempt is in doubt does not get to declare what it did, and reopening an attempt of something that cannot be safely repeated is how a duplicate irreversible act happens. |
| `assessHqIntegrity`, `recordVerifiedBackup` | the `hq.reliability_command` Founder-gate trio | declaring the store healthy, or declaring a file a valid recovery point, is a Founder statement. |

The claim read is enforcement-safe: a forged `queue.get` on the instance AND on
`OperatorQueue.prototype` is proven to have taken, and to buy no run write on
either — while the legitimate claim still works, so the patch changed nothing
at all.

## A run is NOT task authority

The strongest claim in the phase, established three ways — the Phase 12 recipe.

1. **Behaviourally, forward.** Opening a run, reserving an attempt and
   recording an unknown outcome leaves the canonical task's status, fence,
   claimant, approval binding, review state and result identical, and the
   task's own lifecycle still works.
2. **Behaviourally, in reverse.** A facade over a store with no run at all
   produces the same task status, capability, review state and classification.
   Absence changes nothing either, which is what "not authority" has to mean in
   both directions.
3. **Hostilely, and structurally.** A same-realm patch forging a `concluded` /
   `succeeded` run on `getRun` and `listRuns` is proven to have taken on the
   instance, the prototype and a facade constructed after the patch, and to buy
   no second attempt on either. Behaviour alone cannot prove a negative about
   every future call site, so a source scan additionally pins that
   `operator/queue.ts`, `operator/policy.ts`, `operator/approvals.ts` and
   `operator/capabilities.ts` never mention `hq_reliability_`, the reliability
   module or `needs_reconciliation` at all.

## The enforcement-safe read audit

| Read | Reads through | Decides | Status |
|---|---|---|---|
| the claim on the referenced task | `#runClaimFact` — a direct `#db` SELECT of `op_tasks`, deliberately NOT `queue.get()` | whether any run row or event is written | canonical. Pinned against a patch on instance and prototype. |
| the run's CURRENT state | `#runRecordFromStore` — `loadRun`/`loadRunEvents` off `#db`, then the pure derivation, re-derived INSIDE the attempt reservation | whether a further attempt is admitted | canonical. Pinned: a forged `getRun` lies publicly and buys no attempt. |
| the attempt generation | `runAttemptGeneration` inside the write transaction, backed by the UNIQUE `attempt_key` index | which generation a reservation takes | canonical. The engine refuses a duplicate under two processes. |
| does the capability have a side effect | `#capabilityFromStore` (the existing `#private` closure), never `queue.capabilities` | whether an interrupted attempt is uncertain | canonical, and fail-closed on an unreadable row. |
| the capability's idempotency | `#capabilityFromStore` | whether `confirmed_not_executed` may reopen an attempt | canonical. |
| the reliability-command capability row | `#capabilityFromStore` | whether an assessment or a backup record may proceed | canonical, unchanged from the Phase 4/5/7/12 pattern. |
| the SAFE-MODE verdict | the `#private` `#integrityReport` field, latched from the structural assessment AND from the last row of `hq_reliability_verdicts` | whether a Founder-gated write, an approval, an external-action authorization, a kill-switch release, a claim or an external execution proceeds | canonical. Pinned against a patch of `hqReliabilityPosture` and `reliabilitySummary` on instance, prototype, and a later-constructed facade — and, **since the Wave 5 correction of HIGH 1**, against a plain RESTART, which used to clear it. |
| the RECORDED verdict a construction re-reads | `standingIntegrityVerdict(db)` — a direct read of the append-only `hq_reliability_verdicts` ledger | whether a blocking verdict survives a restart | canonical. The ledger carries the full append-only trio; a raw connection can APPEND a `safe_mode = 1` row (the fail-closed direction) and can neither rewrite nor erase one. |
| the APPEND-ONLY GUARDS ON THE AUDIT LOG ITSELF | the same `missingImmutabilityGuards` census, now that `op_evidence` is a declared `ENGINE_IMMUTABLE_TABLES` member | whether removing the guards on the hash-chained log is a blocking finding | canonical **since the third correction round (High A2)**. The table used to carry NO triggers at all, on the argument that "its guarantee is the chain rather than the engine" — so a raw `DELETE FROM op_evidence WHERE seq > 1` was simply permitted, and the chain then verified perfectly over what was left. |
| the EVIDENCE-CHAIN verification that PRODUCES that verdict | `#verifyEvidenceChainFromStore` — a `#private` closure over `#db` and the module-level `verifyEvidenceChain`, deliberately NOT `queue.evidence.verifyChain()` | whether `evidence_chain_broken` engages safe mode, and whether an already-latched safe mode survives the next assessment | canonical **since the Wave 5 correction**; it previously read the patchable delegate. Pinned against a patch on the instance and on `EvidenceLog.prototype`, and against a facade constructed after it. Since the third correction round it verifies the chain's LENGTH as well as its links, against the AUTOINCREMENT high-water mark SQLite maintains — because walking forward from the genesis value proved that the entries PRESENT link to one another and said nothing about where the chain was supposed to END, so deleting the NEWEST entries left a log that verified perfectly. Since the FOURTH it also requires the seqs present to be CONTIGUOUS from 1, because the high-water comparison alone was erased by the next ordinary append: one entry later the largest seq present reached the mark again, the deleted seqs became a hole in the middle, and the appended entries chained from the surviving tip so the links did not object either. |
| the DURABLE COMMITMENT both of those are measured against | `contradictedChainCommitment` and `regressedImmutableLedgers` — direct reads of the append-only `hq_integrity_checkpoints` ledger, over `#db`, with no injected closure and nothing patchable in the path | whether a log that was re-written WHOLE, or a ledger that is back EMPTY, engages safe mode | canonical **since the fifth correction round (High 1 / Medium 1)**. Every other check on this table reads the record and asks whether the record is self-consistent, which a coherent whole-log rewrite satisfies. This one asks whether the record agrees with a commitment HQ made about it earlier, in a different append-only ledger. Every commitment ever recorded is checked and the per-ledger comparison takes the MAXIMUM ever committed, so an appended checkpoint can only add a constraint. |
| the APPEND-ONLY GUARD census that produces the other schema finding | `missingImmutabilityGuards(db)` over `ENGINE_IMMUTABLE_TABLES`, observed as the file was FOUND | whether `append_only_guard_missing` engages safe mode | canonical, and **widened twice by the Wave 5 review** — to the secondary-unique guards and `hq_memory`'s supersede rule (Medium 2), and to `hq_mission_plan_items`' three own guards (Medium 6). The declaration is **deep-frozen at module scope** (HIGH 2): it is public package API, `readonly` erases at runtime, and one `ENGINE_IMMUTABLE_TABLES.length = 0` used to empty the census and make a tampered file read clean. |
| store presence | the constructor's `#reliabilityStorePresent` flag | whether a 0 means "absent" or "empty" | canonical, observed, never migrated. |
| the ledger, for the unauthenticated snapshot | `#listRunsFromStore` and the `#private` report — deliberately NOT `listRuns()` or `hqReliabilityPosture()` | what `hq-snapshot.json`'s `reliability` section publishes | canonical. |

## Privacy: what crosses to the unauthenticated artifact

`hq-snapshot.json` gains ONE optional section, `reliability`, with exactly
twelve keys: `storePresent`, `runs`, `byKind`, `byState`, `byOutcome`,
`needsReconciliation`, `verifiedBackups`, `safeMode`, `assessmentDepth`,
`findings`, `durabilityMeetsRequirement`, `note`.

**No** run label, task id, mission id, action id, run id, worker id,
correlation id, process identity, backup path, digest, or finding detail
string. Pinned by the exact top-level key set, by the exact nested key set of
all three maps, and by a whole-artifact scan for every one of those values on a
populated snapshot.

> **Correction (Wave 5 review, MEDIUM finding C-1).** `reliabilitySummary()`
> short-circuited on `#reliabilityStorePresent === false` and returned
> `emptyReliabilitySnapshot(false)`, which HARD-CODES `safeMode: false`,
> `assessmentDepth: 'structural'`, `findings: {}` and
> `durabilityMeetsRequirement: true` without consulting `#integrityReport` at
> all. But `#reliabilityStorePresent` answers only "does this file carry the
> Phase 13 run TABLES", while the integrity verdict is computed over the whole
> file — and on the case where they disagree (a genuine pre-Phase-13 database
> with one dropped append-only trigger) the public artifact said everything was
> fine while the Founder-gated view said `safeMode: true`. Because
> `snapshot.ts` gates the "HQ is in SAFE MODE" provenance sentence on the same
> flag, the note was suppressed with it, and the `durabilityMeetsRequirement:
> true` in that branch was a separate law-8 breach. Both branches now report the
> REAL verdict; the run half is still stated as absent, which it is. The key set
> is unchanged — the same twelve.
>
> `durabilityMeetsRequirement` is a statement about a FILE-backed database, and
> the snapshot note now says so in words (LOW 10): an in-memory handle reports
> it true because there is nothing durable to require of a database with no
> file, not because it is durable. The authenticated posture carries `inMemory`
> beside it; the artifact deliberately does not grow a thirteenth key for a fact
> the note can state.

The four MAPS are closed **by construction**, not only by intent — the Phase 12
lesson applied without having to relearn it. `hq_reliability_runs` and
`hq_reliability_run_events` are append-only ledgers on which an APPEND is the
write the triggers deliberately permit, so a stored `run_kind`, state, outcome
or finding name could be free text. Each map is keyed by its vocabulary plus
exactly one extra member, `unrecognized`; every increment passes a membership
check and the CHECKED value — never the caller's or the row's string — is the
key. Pinned with a hostile row carrying `SUPER SECRET PROJECT NAME` as its
kind: the text does not appear anywhere in the artifact, the count lands in
`unrecognized`, every count is an integer, and the map total equals what was
folded.

`safeMode` DOES cross, and that is the deliberate exception. A reader told
everything is fine while HQ has said otherwise about itself has been lied to,
and that is the one thing this phase exists to prevent. The finding CATEGORY
crosses; the detail — which names schema objects — does not.

### The unauthenticated artifact IS a Founder-text publication surface

Stated plainly here for the first time (Wave 5 correction round ten, NEW LOW).
Everything above is about the `reliability` section, and it is accurate about
that section. The artifact AS A WHOLE is a different question, and the answer
is that it does carry Founder-typed text, in a file served with no
authentication at all.

The round-ten review named the task `title`. Round ten measured **four** and
wrote that number here. **A fresh hostile review at `f348f9a` planted canaries
across the whole Founder-writable facade and found the disclosure was far too
narrow; re-measured at the merged head with every plant executed through the
real facade and every call asserted to have returned OK, it is
twenty fields, not four** — `src/cli/snapshot.ts` writes the whole object
`liveSnapshotFromOperations` returns, so everything in it is published:

| Founder-typed field | One measured path in `hq-snapshot.json` |
|---|---|
| `createProject.name` | `projects.data[].name`, and `missions.data[].projectName` |
| `createProject.purpose` | `projects.data[].purpose` |
| `createProject.stream` | `projects.data[].stream` |
| `commandMission.title` | `missions.data[].title`, `projects.data[].missions[].title`, and the `commandCenter` attention summary |
| `commandMission.objective` | `missions.data[].intentHistory[].objective` |
| `commandMission.scope` | `missions.data[].scope` |
| `commandMission.constraints` | `missions.data[].constraints[]` and `intentHistory[].constraints[]` |
| `commandMission.acceptanceCriteria` | `missions.data[].acceptanceCriteria[]` and `intentHistory[].acceptanceCriteria[]` |
| `commandMission.planItems` | `missions.data[].planItems[].summary` |
| `commandMission.project` | `missions.data[].project` |
| `amendMissionIntent.objective` | `missions.data[].objective` and `intentHistory[].objective` |
| `amendMissionIntent.constraints` | `missions.data[].constraints[]` |
| `amendMissionIntent.acceptanceCriteria` | `missions.data[].acceptanceCriteria[]` |
| `amendMissionIntent.addPlanItems` | `missions.data[].planItems[].summary` |
| `createTask.title` | `operations.data.<lane>[].title`, and the `commandCenter` attention summary |
| `createTask.project` | `operations.data.<lane>[].project` |
| `denyTask.reason` | `operations.data.blocked[].blockReason`, `activity.data[].summary`, the same attention summary |
| `failTask.reason` | `activity.data[].summary` — worker-typed, and published |
| `registerExecutionWorker.displayName` | `workforce.data[].displayName` |
| `registerExecutionWorker.vendor` | `workforce.data[].vendor` |

Fourteen further Founder- and worker-typed fields were planted and do NOT cross,
and that half is pinned too, because it is what makes the payload carve-out from
the credential scan defensible: `createTask.payload`,
`commandMission.instruction`, `amendMissionIntent.amendment`,
`engageKillSwitch.reason`, `setIntelligenceBudget.note`,
`recordModelObservation.unitCostBasis`, `recordModelObservation.note`,
`recordVerifiedBackup.backupPath`, `recordVerifiedBackup.note`,
`postMissionMessage.body`, `postMissionMessage.refs`,
`recordIntelligenceDecision.label`, `recordIntelligenceCost.basis`,
`recordIntelligenceCost.note`.

**No behaviour is changed by this table, and no credential can reach any of
these fields** — every one of them is credential-scanned at its facade write,
which is why that scan is load-bearing rather than tidy. The defect round
fourteen closes is the FALSE DISCLOSURE and the vacuous pin: the previous
version of `unauthenticated-founder-text.test.ts` planted canaries in two
methods and asserted three `toContain` paths, so a field added beside them
published silently.

**What the pin does now.** `unauthenticated-founder-text.test.ts` plants a
distinct canary in all 34 fields, asserts every facade call RETURNED OK (a
canary that was never written would otherwise read as "does not cross"), asserts
the crossing set EXACTLY in both directions, checks each published field lands
at the path this table names, DERIVES the completeness of the plant from
`service.ts` itself — every name in each exercised method's own
`callerTextRefusal(input, [ … ])` list must be planted or exempted with a
reason — and checks this table against the measured set, so the prose cannot
drift from the behaviour again.

**The scope of that derivation, stated rather than implied.** It is complete for
the METHODS the scenario exercises, which are the Founder-driven writes the
snapshot's sections are built from. It is not a claim about every method on the
facade — `facade-write-scan.test.ts` owns that enumeration, over the call graph,
for the credential scan. A method added to a snapshot section in a future phase
has to be added to the canary table by hand, and nothing in the file can force
that.

**What this means in plain words:** a project's name, purpose and stream; a
mission's title, objective, scope, constraints, acceptance criteria, plan-item
summaries and project label, and every amendment to them; a task's title and
project; the reason a Founder gave for denying it; the reason a WORKER gave for
failing one; and a registered worker's display name and vendor — **are all
public.** Anyone composing one should know that, and any future field added
beside them inherits the same question rather than the same silence.

**That is true of the store-ABSENT branch too, and it was not (Wave 5
High 5).** `reliabilitySummary()` returned a hard-coded
`{safeMode: false, findings: {}, durabilityMeetsRequirement: true}` whenever
`#reliabilityStorePresent` was false — but `#integrityReport` is latched at
construction INDEPENDENTLY of the reliability store, and `src/cli/snapshot.ts`
opens read-only, which is exactly that branch. The world-readable artifact
therefore published "everything is fine" while HQ had latched safe mode with
blocking findings, and published `durabilityMeetsRequirement: true` on EVERY
read-only pre-Phase-13 snapshot with no tampering at all. The store-absent view
now takes the integrity facts as a REQUIRED argument and folds them through
`summarizeReliability`, so the closed vocabulary and the counts-only shape are
unchanged and there is no way to build the view without stating what HQ knows.
The run counts stay genuinely zero: there is no ledger to count.

The provenance note states four things a reader would otherwise supply
themselves: that a concluded count is a count of RECORDS and not evidence that
anything reached the outside world; that a `structural` depth is not a claim
that a full `integrity_check` has been run; that a `needsReconciliation` count
means HQ never retried; and, when engaged, what safe mode actually means.

No `HQ_SNAPSHOT_VERSION` bump (the section is optional and additive).

## Surfaces

Routes (the unchanged pipeline — origin/referer, identity scan of body AND
query, Founder resolution, `safe()`; route table **41 → 44**, write surface
**26 → 28**):

```
GET  /api/hq/control/reliability             posture + bounded runs + backups + vocabularies
POST /api/hq/control/reliability/recover     classify the runs whose carrying process is gone
POST /api/hq/control/reliability/reconcile   close a run whose outcome HQ does not know
```

The GET is a pure read: it re-assesses nothing and latches nothing, because a
GET must never be the thing that changes a safety posture. Proven by calling it
twice and comparing the integrity object, and by watching the evidence-log
watermark not move.

**What has no route, and why.** Opening a run, starting an attempt and
recording an outcome are WORKER acts under a live fenced claim — exactly like
authorize and execute in Phase 8 — and a browser holds no claim. A full
integrity assessment and a verified-backup record read the local filesystem and
re-latch a safety posture; they belong to a process with the machine in front
of it. And nothing anywhere clears safe mode by assertion. Eight invented paths
404, and no path SEGMENT in the whole control table spells `retry`, `restore`,
`repair`, `force` or `override`.

Neither write takes step-up, and that is a decision: neither can execute
anything, both append to an append-only ledger, and a reconciliation is the act
that RESOLVES an irreversible effect somebody already checked rather than one
that causes it.

`/session` gains two flags. `reliabilityRecover` rides `mayApprove`, exactly as
`actionReconcile` does — neither is an origination of work, so neither takes a
capability grant. `reliabilityCommand` is advertised as a FACT about the
principal rather than as a button, because the two acts behind it have no
route; a console that could not see the capability was missing would have no
way to explain why an assessment it was told to run does not exist as a
control.

UI, rooms and the spatial shell: **deliberately unchanged.** No `ROOM_SECTIONS`
change, no `hydrate.ts` change, no `rooms.ts` change, no console change. A
reliability console is a real thing to want, and it is honestly absent rather
than half-built.

## What is canonical vs derived

| Canonical (written here) | Derived (never stored) |
|---|---|
| `hq_reliability_runs` — one INSERT-only row per run | `state`, `outcome`, `failureCategory`, `attempts`, `nextGeneration`, `lastCorrelationId`, `interruption`, `reconciliation`, `admitsAttempt` |
| `hq_reliability_run_events` — INSERT-only history, with the UNIQUE attempt reservation | the recovery report and its classifications |
| `hq_reliability_backups` — INSERT-only verified recovery points | the integrity verdict's OBSERVATIONS and the safe-mode posture |
| `hq_reliability_verdicts` — INSERT-only integrity verdicts (Wave 5 correction) | the snapshot's `safeMode` / `assessmentDepth` / `findings` |
| | the snapshot counts |

| Canonical (referenced, never written by this phase) |
|---|
| `op_tasks` (the claim, the capability, the status) — read to authorize a run write; never created, moved or released here |
| `op_capabilities` — read for `side_effect` and `idempotent`; never written |
| `hq_action_intents` / `hq_action_events`, `hq_approvals`, `hq_missions`, `hq_projects` — counted at most, never written |

Each write commits its row, its history event, its `hq_events` audit entry and
its `op_evidence` entry in ONE reservation.

## Verification actually run

| Command | Result |
|---|---|
| `npm run test:hq` | 157 files, 2917 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root, `@factoryos/server`) | 37 files, 569 passed, 3 skipped |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |
| `npm run build` | all workspaces built; web initial JS 215.66 kB / 69.22 kB gzip (unchanged) |

Baseline before this phase was 152 files / 2810 tests in `test:hq`; Phase 13
adds 107 tests across five new files plus one shared fixture. The three skipped
tests under `packages/server` are pre-existing `it.skip` GAP markers, untouched
— nothing under `packages/server`, `packages/web`, `packages/shared` or
`packages/config-mesob` was changed.

### The tests that are real rather than simulated

The directive asked for real process/file/connection tests and no
timing-only concurrency tests. What was built:

- **A real crash.** `reliability-crash-recovery` spawns a genuine child `node`
  process — as `node --import tsx <script>`, deliberately NOT through the `tsx`
  CLI, which spawns a grandchild and would leave a wrapper to exit tidily — has
  it open a run and reserve an attempt against a real SQLite file, and kills it
  with `SIGKILL`. The test asserts the child died by signal. Recovery then runs
  in the parent over the file the dead process left behind.
- **A real second connection.** The duplicate-attempt guard is proven by
  INSERTing the same `attempt_key` from a raw `better-sqlite3` handle that
  never ran this repository's code. There is no sleep, no timer and no
  interleaving assumption anywhere: the assertion is that the ENGINE refuses.
- **A real file.** Engine immutability (UPDATE, DELETE, and both REPLACE-on-
  unique-index paths on all four tables — `hq_reliability_verdicts` included),
  the tamper that engages safe mode, the evidence-chain break, the restart that
  no longer clears a verdict, and fourteen of the seventeen backup refusals
  are all exercised against a real database in a real temporary directory. The
  three that are not (`file_too_large`, `path_not_readable`,
  `verification_copy_failed`) are named in "Backup and restore" with the reason,
  rather than counted as if they were — and the split is derived by
  `backup-refusal-vocabulary.test.ts` rather than counted by hand. (This sentence
  read "ten" of "thirteen" at `237fc76`, two constants behind, because round
  twelve's pin on this page reads ONE phrasing of the pair and this is a second —
  Wave 5 correction round thirteen, Medium 3. The pin now sweeps EVERY place on
  this page that states the pair and checks both halves of each.)
- **A real restore.** Backed up, verified, copied, verified again, opened as a
  working HQ, and the run read back out of the copy.

## What is NOT built (deliberately)

- **No retry, resume, restore or repair path of any kind.**
- **No automatic recovery at boot.** Recovery is a Founder act. A constructor
  that silently classified other processes' work would be taking a judgement
  nobody asked it to take, at the least reviewable moment there is.
- **No periodic or background assessment.** No daemon, no timer, no schedule —
  the Phase 6 rule, unchanged.
- **No in-process lane opens a run automatically.** See the debt below.
- **No lease sweep, no task reconciliation and no action reconciliation here.**
  Those are the queue's and the gateway's, and this phase points at their doors
  rather than reaching through them.
- **No backup scheduler, no retention policy, no rotation, no off-site copy.**
- **No CLI, no console, no spatial room, no snapshot version bump, no new
  dependency.**

## Known limitations (honest)

- **Nothing in HQ opens a run automatically yet.** The ledger is written
  through the worker-fenced facade methods, and no in-process lane calls them.
  Until a lane does, the run ledger's crash story applies to work that
  deliberately opts in, and the recovery report's value for everything else is
  the COUNT of canonical work interrupted elsewhere. This is the most likely
  thing a first real user will notice, and it is the deliberate cost of not
  changing the dispatch and orchestration paths in the same wave that
  introduced the ledger.
- **Safe mode is assessed at construction and on demand, not continuously.** A
  corruption that appears while HQ is running is caught at the next boot or the
  next explicit assessment, not at the moment it happens.
- **The structural check cannot see everything.** It reads the schema
  catalogue, the pragmas, and the bounded marks HQ keeps about its own
  append-only records; a corrupt page and a referential violation are the two
  findings only the full assessment raises. **This bullet also said "a broken
  chain", and that has been wrong since round five (round eight, Medium 1):**
  the cheap pass reads HQ's durable commitment, so a log that has been shortened
  or rebuilt is blocking at the BOOT as well as at the assessment. What the
  structural pass still cannot do is verify the chain link by link — a tampered
  entry that no commitment covers needs the full pass, and only a full
  assessment ever reports the chain as verified.
- **A missing append-only guard is detected, and the tamper window is not
  bounded.** HQ reports that a guard was absent when the file was found; it
  cannot say for how long, or what was written meanwhile. That is why the
  posture is "stop and investigate" rather than "here is the damage".
- **The guard census covers the trio AND every declared SECONDARY guard.**
  Both Wave 5 correction lanes reached this independently (one as High 1, one
  as Medium 2). It used to cover only `no_rewrite`/`no_erase`/`no_replace`, on
  the reasoning that listing every trigger name would drift, and that a table's
  further guards were "that module's business". That reasoning was wrong in the
  direction that matters: the secondary guards close REPLACE on a SECONDARY
  unique index, where the primary-identity guard never fires, and
  `recursive_triggers` is off by default and connection-scoped — so an
  `INSERT OR REPLACE` colliding on such an index DELETES the standing row with
  no BEFORE DELETE running. Dropping just
  `trg_hq_reliability_run_events_no_replace_attempt` (the cross-process
  duplicate-attempt guard) left `missingImmutabilityGuards` reporting `[]`,
  safe mode false at both depths, and a committed append-only row erasable and
  replaceable by a forged one, with no finding; dropping
  `trg_hq_intel_budgets_no_replace_unique` was demonstrated the same way, and
  the ceiling went 1000 to 999999999 with the census silent.
  `ENGINE_IMMUTABLE_TABLES` entries now declare `secondaryGuards` and
  `declaredGuardsFor` composes the full set the census demands, so a dropped
  secondary guard produces a real `append_only_guard_missing` finding and
  engages safe mode at both depths and at the next construction. The drift
  concern is answered where it belongs: TWO live-schema pin tests hold the
  whole declaration — one compares the full trigger-name set for every listed
  PREFIX, the other every trigger on the listed TABLE — so a guard a future
  phase adds and forgets to declare fails there rather than escaping the check.
  **Corrected again — by BOTH later correction lanes, from two different
  exploits (Medium 3 and Medium A-6).** Those pin tests iterated the
  DECLARATION, so they could not see a guard on a table nobody had listed — and
  `hq_mission_plan_items`' guards were exactly that. The table is not
  append-only as a whole (supersede and link legitimately UPDATE it), which was
  taken as a reason to leave it out of the list altogether. One lane demonstrated
  that dropping `_no_replace` let an `INSERT OR REPLACE` rewrite a plan item's
  task binding with no finding at all; the other demonstrated that the table
  carried no `_no_erase` guard whatever, and that ONE DELETE of the single link
  row turned a `blocked` Phase 14 proposal into `within_ceiling` (see the Phase
  14 doc). The merged fix is one entry: the table now CARRIES `no_erase`, and it
  is listed with a REDUCED base declared through
  `EngineImmutableTable.requiredGuards` (`no_erase`, `no_replace`, plus
  `no_relink` and `no_respec`), so the census checks exactly what the schema
  declares and demands no `no_rewrite` it should not. The boolean
  `holdsUniversalTrio` the other lane used for the same purpose was dropped in
  the reconciliation because it cannot express a required `no_erase`. A test
  pins that exactly one entry declares a reduced base, so a second exception
  cannot be added quietly, and a third test asserts the LIVE trigger set EQUALS
  the union of the declarations, so a new guarded table is a test failure rather
  than a silent gap.
- **An HQ database file created before this wave engages safe mode once, on its
  first boot afterwards.** `trg_hq_mission_plan_items_no_erase` and the
  `hq_reliability_verdicts` guards did not exist in it. `hq_mission_plan_items`
  EXISTS on such a file without its new guard, and the as-found observation is
  taken before the schema ensures — by design, because HQ cannot know what was
  written while a guard was gone. The finding is therefore true rather than
  spurious. **What it COSTS to clear depends on whether the file was missing a
  guard or a whole ledger, and the sixth correction round corrects this sentence
  too.** A missing GUARD on a table that is present is cleared by ONE Founder
  full assessment, which finds the re-created guard standing. A pre-wave file is
  also missing whole declared LEDGERS — `hq_reliability_verdicts` and, since the
  fifth round, `hq_integrity_checkpoints` — and since the round that stopped a
  destroyed ledger being laundered by re-creating it empty, an absent ledger is
  carried for the life of the process that observed it. Such a file therefore
  takes a restart and TWO Founder full assessments. See the newly-declared-ledger
  item below for the measurement and for why the asymmetry is deliberate. A file
  created by this code is unaffected. Stated here rather than discovered in
  operation.
- **The safe-mode latch reads the evidence chain from private truth.** Both
  correction lanes found this too (one as Critical 1, one as High 1).
  `assessHqIntegrity` used to pass `() => this.queue.evidence.verifyChain()`
  into `fullIntegrity`. `queue.evidence` is a public own-property object the
  queue documents as safe to patch "because enforcement never dispatches
  through it" — a premise that call made false. `evidence_chain_broken` is one
  of only four blocking findings and this assessment is the only path that
  CLEARS the latch, so replacing that one read let a same-realm caller clear
  safe mode over a genuinely broken chain and claim again. The chain is now
  computed by a module-level `verifyEvidenceChain(db)` in `operator/evidence.ts`
  and reached from `#verifyEvidenceChainFromStore`, an ECMAScript `#private`
  closure over the facade's own handle — deliberately NOT a delegation to
  `PrivilegedQueueApi`, because that would still dispatch through the exported
  `EvidenceLog.prototype`, which is equally patchable. `EvidenceLog.verifyChain`
  is now a thin delegate over that same function, so the READ surface and the
  ENFORCEMENT path share one computation and cannot drift — the reason this
  shape was kept over the other lane's inlined second copy. Pinned on the
  instance AND on that prototype, with `EvidenceLog.list` patched out too, plus
  a source scan that no non-comment line of `service.ts` reaches
  `queue.evidence.verifyChain`. An unparseable payload is a BREAK at that seq
  rather than a thrown error, which is the one thing the dropped copy did
  better and which was carried into the survivor.
- **`POST /reliability/reconcile` takes step-up, unconditionally** (Wave 5
  High 4). It was the only reconciliation route in HQ without it, while Phase
  8's `actionReconcile` — which shares this route's decision vocabulary BY
  IDENTITY — takes it always. `controlAvailability` now emits
  `reliabilityReconcile` beside `reliabilityRecover`, which its own comment
  already described.
- **A run's dedupe key is not keyed on the caller's label** (Wave 5 Medium 2).
  Both enforcement layers bind to the run key, and the key digested `label` —
  ≤120 characters of arbitrary free text — so changing `'publish the thing'` to
  `'publish the thing.'` opened a SECOND run with a fresh admitted attempt
  beside a run standing at `needs_reconciliation` for that very work. The label
  is out of the digest, and `openRun` additionally refuses outright when the
  task already carries a run at `needs_reconciliation`, so the deliberate
  `idempotencyKey` escape hatch cannot reopen the same hole. **That guard is
  what the Critical of the second correction round defeated and what has since
  been restored** — see [When a live process is
  classified](#when-a-live-process-is-classified).
- **A run-key COLLISION between two different pieces of work is refused, not
  deduplicated** (Wave 5 Medium 4, second correction round). Taking `label` out
  of the key was right, but `idempotencyKey` is optional, so the default shape
  of two different runs on one task derives one key — and the second open
  returned `ok`, `deduplicated: true`, and a record carrying the FIRST work's
  label. Executed: `openRun("roll the release back")` returned `ok` with a run
  labelled `"publish the release note"`, followed by a permanent
  `run_attempt_refused`. Fail-closed at the attempt, so never a safety hole, but
  a correctness and auditability regression that went undisclosed. `openRun` now
  compares the stored label before deduplicating: identical work still dedupes
  onto the standing run (the cross-restart inherit the key exists for), and a
  mismatch is refused as the new `run_key_conflict`, which names the standing
  run id and deliberately does NOT echo its stored label. A caller with
  genuinely separate work on one task passes a distinct `idempotencyKey`.
  **Ordering, since the three-lane reconciliation:** `openRun` now carries three
  guards, and the earliest one wins. A task holding an unreconciled run is
  refused `run_state_conflict` BEFORE the run key is derived at all, so on such a
  task every open — same label or not — is answered by that refusal; the
  `run_key_conflict` above is what answers a collision on LIVE work, where the
  dedupe is still reachable. The in-reservation `run_attempt_refused` remains
  beneath both as the re-check under the reservation, which is what closes the
  window between the pre-reservation read and the write. Three lanes wrote three
  different expected codes for the relabel-under-`needs_reconciliation` case;
  the tests are ported to the answer the merged guard order actually gives, with
  the reason stated inline, and no lane's guarantee was dropped to do it.
- **The independence check in `reconcileRun` is currently unreachable through
  the worker path**, because `assertApprovalAuthority` refuses any registered
  worker first, and only registered workers hold claims. It is kept as defence
  in depth — the guard should not depend on that staying true — and the test
  says so rather than pretending it is what fires.
- **`listRuns` derives every run's whole record per call**, exactly as
  `listProducts`, `#commandFacts` and `#searchCorpus` do. Fine at HQ scale; a
  large ledger would want an indexed derivation.
- **A run cannot be corrected in place.** The register is append-only; a
  mistaken label is permanent.
- **Nothing here has been exercised by a real AI worker lane.** As with Phases
  9 through 12, every canonical act in these suites is performed by a test
  acting as the Founder or as a registered worker.

## Wave 5 review corrections

The frozen wave head was reviewed by TWO independent hostile passes; this
section records the four-reviewer one, and "Wave 5 correction pass" at the end
of this document records both and how they were reconciled.

The Phase 13 defects a four-reviewer hostile pass found, and what was done
about each, are recorded inline in the sections above: the safe-mode latch's
patchable evidence-chain read (Critical 1), the trio-only guard census
(High 1), the missing step-up on `POST /reliability/reconcile` (High 4), the
fail-OPEN store-absent snapshot (High 5), `process_id` as a liveness signal it
never was (Medium 1), the label-keyed run identity (Medium 2), the backup
digest that did not cover what SQLite checked (Medium 3), and the
`interrupted` branch's fail-OPEN `uncertain` flag (Medium 4, minimum only).

Two are only PARTLY closed, and both say so where they are described: the
structural half of Medium 4 (no hash chain on `hq_reliability_run_events`, no
cross-check against the chained `op_evidence` entry) is open, and Medium 1's
correction is a repair path rather than a prevention.

### Second correction round

The corrected head was reviewed again, hostilely, and the round above turned
out to have introduced one defect and left four. All five are recorded inline
above rather than summarised away:

| Finding | Where it is described |
|---|---|
| CRITICAL 1 — the late-outcome path concluded the run, lifting the `openRun` guard and re-admitting a duplicate irreversible act with no human | ["When a live process is classified"](#when-a-live-process-is-classified) |
| HIGH 2 — the safe-mode latch did not survive a restart while `SAFE_MODE_STATEMENT` said it did | ["The latch is DURABLE, and it was not"](#the-latch-is-durable-and-it-was-not) |
| MEDIUM 4 — a run-key collision silently merged two different pieces of work | "Known limitations" |
| MEDIUM 5 — `file_changed_during_verification` did not hold, because the SQLite open is by path | "Backup and restore" — **the finding stands; its implementation does not.** The third lane closed the same TOCTOU by construction (the scratch copy), that implementation survived the reconciliation, and this refusal was dropped with the code that needed it. |
| LOW 6 — `verifyHqBackupFile`'s header contradicted its own code about a symlinked ancestor | "Backup and restore" — the header was rewritten around the scratch copy and states the resolve-and-record rule correctly. |

The lesson recorded, because it is the one that produced the Critical: the two
Wave 5 fixes that cancelled were each correct in isolation. Medium 1 gave a
live worker a way to report the truth; Medium 2 added a guard keyed on
`needsReconciliation`. Neither review step asked what the first did to the
second's predicate. A correction that changes a DERIVED field must be checked
against every guard that reads it.

## Carry-forward Low debt

**From Phase 11/12, unchanged and still open** — recorded rather than restated
as fixed, because this phase did not touch any of it: lexical-only retrieval,
loose `any_term` question retrieval, the query-independent withheld count, the
absent `hq_specialists` timestamp, the in-memory corpus scan, the product-edit
gap and the absent `founder_only` product level.

**New Low debt from this phase**: the un-wired run ledger, the
assess-on-demand rather than continuous posture, the unbounded tamper window,
and the currently-unreachable independence guard — all four listed under
limitations above. None is reported as anything other than open.

## Deliberate pin ledger

Route table 41 → 44 (`live-control-api`, test renamed "forty-four entries",
three sorted paths added, reasoning recorded in the test). Write surface 26 →
28 (`live-mission-routes`, two `toContain` lines plus one `not.toContain` for
the read, length 26 → 28). `/session` gained two flags, `reliabilityRecover`
and `reliabilityCommand`. No `HQ_SNAPSHOT_VERSION` bump, no `ROOM_SECTIONS`
change, no `CONTROL_FETCH_TARGETS` change, no console change, no CLI change,
and no change under `packages/server`, `packages/web`, `packages/shared` or
`packages/config-mesob`.

**No existing test was deleted, skipped, weakened, narrowed or relaxed.** Two
product-code changes came out of writing the suites and are recorded here
rather than hidden:

1. A stored run KIND outside the closed vocabulary was being coerced to
   `orchestration` at load. That would have published a wrong count to an
   unauthenticated reader — the Phase 12 snapshot defect, in a new place. It is
   now carried as `unrecognized`, like the event kind, and the fold buckets it.
2. The structural integrity check originally ran AFTER the schema ensures,
   which meant a dropped guard was silently re-created and then reported
   healthy. It now observes the guards as the file was FOUND, before any
   ensure, and the finding stands until an explicit assessment says otherwise.

`Phase 10`'s assertion that no facade method name matches `/recommend/i` is
untouched and still holds; nothing in this phase recommends anything.

---

## Wave 5 correction pass (this branch, on top of `c9ddecc`)

**Two independent correction lanes, reconciled by a merge.** The frozen wave
head `c9ddecc` was hostile-reviewed twice, concurrently and without either
reviewer knowing about the other:

| Lane | Verdict | Landed as |
|---|---|---|
| A four-reviewer sweep | 1 Critical / 5 High / 10 Medium / ~13 Low | twelve commits |
| A separate fresh read-only reviewer | 0 Critical / 1 High / 1 Medium / 6 Low | one commit |

Both reached the SAME two defects — the safe-mode evidence-chain read and the
trio-only guard census — by different routes, and each found things the other
did not. The merge keeps the union of the guarantees, one implementation of
each shared fix, and every regression test from both lanes. Where the two
disagreed on implementation the surviving choice and the reason are recorded at
the code and in the bullets above; nothing was resolved by picking a side.

The findings that touch Phase 13 are corrected in place above, in the sections
they belong to rather than in a footnote:

| Finding | Where it is now recorded |
|---|---|
| the safe-mode evidence verdict came through a patchable delegate (Lane A Critical 1 = Lane B High 1) | "Safe mode → Nothing clears it by assertion", plus two new rows in the enforcement-safe read audit, plus "Known limitations → The safe-mode latch reads the evidence chain from private truth" |
| the secondary append-only guards were unpinned and invisible to the census (Lane A High 1 = Lane B Medium 2) | "Known limitations → The guard census covers the trio AND every declared SECONDARY guard", plus the census row in the audit |
| `POST /reliability/reconcile` took no step-up (Lane A High 4) | "Surfaces", and "Known limitations" |
| the store-absent snapshot failed OPEN (Lane A High 5) | "Privacy: what crosses to the unauthenticated artifact" |
| `process_id` read as a liveness signal (Lane A Medium 1) | "When a live process is classified" |
| the label-keyed run identity (Lane A Medium 2) | "Known limitations → A run's dedupe key" |
| the backup digest did not cover what SQLite checked (Lane A Medium 3) | "Backup and restore" |
| the `interrupted` branch's fail-OPEN `uncertain` flag (Lane A Medium 4, minimum only) | "The law: an uncertain outcome is never retried" |
| the corrupted-backup refusal was not pinned by name (Lane B Low 8) | "Backup and restore" |

**Which duplicate implementation was dropped, and why.** Both lanes moved the
evidence-chain verification off `queue.evidence.verifyChain`. Lane A inlined a
second copy of the hash formula as a `#private` closure in `service.ts`; Lane B
moved the computation to a module-level `verifyEvidenceChain(db)` and made
`EvidenceLog.verifyChain` a thin delegate over it. Lane B's survives and Lane
A's copy was deleted, on the argument that decided it: two computations of one
verdict can drift, and a drifted verifier reports a false break, which under
safe mode is an outage rather than a warning. Lane A's one better behaviour —
an unparseable payload is a BREAK at that seq rather than a thrown
`JSON.parse` — was carried into the survivor and is pinned by its own test.
Both lanes' hostile-patch tests are kept, and both live-schema guard pins are
kept: one compares the full trigger-name set per PREFIX, the other every
trigger per TABLE.

**Verification after the FIRST reconciliation** (Lane A + Lane B; the whole
suite, not a subset):

| Command | Result |
|---|---|
| `npm run test:hq` | 162 files, 3073 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root) | 37 files, 569 passed, 3 skipped |
| `npm run build` | all workspaces; web `215.66 kB` / `69.22 kB` gzip (unchanged) |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |

Baseline at `c9ddecc` was 161 files / 3026 tests; Lane A alone was 161 / 3053
and Lane B alone 162 / 3045. Nothing was deleted, skipped, weakened or
narrowed by either lane or by that merge; the three pre-existing `it.skip` GAP
markers under `packages/server` are untouched, and nothing under
`packages/server`, `packages/web`, `packages/shared` or `packages/config-mesob`
was changed.

---

## Wave 5 SECOND correction pass, and the THREE-lane reconciliation

The head those two lanes produced was reviewed again, by three further fresh
read-only hostile reviewers, none of whom authored the head they reviewed and
none of whom knew about the lanes above. They returned 0 Critical / 5 High /
7 Medium / 13 Low across both phases, every High reproduced by execution rather
than inferred. That correction is **Lane C**, and this section is both its
record and the record of merging it with the Lane A + Lane B head.

The findings that touch Phase 13 are corrected in place above, in the sections
they belong to:

| Finding | Where it is now recorded |
|---|---|
| HIGH 1 — the safe-mode latch was process-local; a plain restart cleared an `evidence_chain_broken` verdict | "Safe mode → Nothing clears it by assertion", plus two rows in the enforcement-safe read audit and a fourth table in the ledger map |
| HIGH 2 — `ENGINE_IMMUTABLE_TABLES` was a mutable exported array on an enforcement path | the census row of the enforcement-safe read audit |
| HIGH 3 — `verifyHqBackupFile` digested one byte set and verified another | "Backup and restore" |
| MEDIUM 4 — the run key included the caller's free-text label, so renaming defeated the duplicate guard | "Known limitations" |
| MEDIUM 5 — `fullIntegrity`'s chain verifier was optional and its absence read as a pass | `fullIntegrity`'s own contract; the report now carries `chainVerified` |
| MEDIUM 6 — the census was blind to `hq_mission_plan_items`, and the pinning test could not have caught it | "Known limitations → Which guards the census can see" |
| MEDIUM 7 — `authorizeAction` was in neither column of the safe-mode table | "What it refuses, and what it deliberately does not", which now lists every mutator left available with its reason |
| MEDIUM C-1 — the unauthenticated section published `safeMode: false` while HQ had latched safe mode | "Privacy: what crosses to the unauthenticated artifact" |
| LOW 8 — the latch was mutated before the assessment was recorded | folded into the HIGH 1 correction: one `reserve`, record first |
| LOW 9 — a stale comment pointed a maintainer back at the removed delegate | `fullIntegrity`'s contract |
| LOW 10 — `:memory:` durability read as meeting the requirement at the artifact boundary | the durability posture's own note, and the snapshot note |
| LOW 11 — "provable from the ledger" overstated what a voluntary ledger proves | `classifyInterruptedRun`'s comment |
| LOW 12 — backup refusal categories over-collapsed and the size bound was not a bound on the read | "Backup and restore" |
| LOW C-3 — the integrity `detail` comment claimed it was never composed from engine output | `HqIntegrityObservation.detail`'s own comment |
| LOW C-4 — `runView.externalActionTaken: false` was stamped per run with nothing explaining it | `runView`'s docstring in `live/control-api.ts` |

**Where Lane C and the Lane A + Lane B head fixed the SAME defect, one
implementation survives and both sides' tests are kept, ported onto it.** In
Phase 13 that is three places:

- **Backup verification** (Lane A's Medium 3 vs Lane C's High 3). Lane C's
  scratch-copy version survives: it digests, copies and checks one descriptor in
  one pass, so the digest pins what was checked BY CONSTRUCTION and nothing
  the path names AFTER that open can change what was verified. (The path is
  read several times BEFORE it: an `lstat`, a `realpathSync` and three sidecar
  `lstat`s, because the refusals those make are about the path. The sentence
  shipped on `BACKUP_RECORD_STATEMENT` said "never resolved a second time" and
  is corrected in the fourth round — Low L5.) Lane A's held-descriptor
  re-digest and its `file_changed_during_verification` refusal are dropped with
  it — that race cannot occur in the survivor — while Lane A's `realpathSync`
  resolution and `BackupVerification.resolvedPath` are carried ONTO the
  survivor, so the register still names the file HQ opened rather than an alias.
  Lane A's two backup tests are ported: the un-checkpointed-WAL exploit now
  expects `sidecar_journal_present` (the broader rule) and keeps its
  checkpointed-accept half, and the symlinked-ancestor test is kept unchanged.
- **The absent-run-ledger snapshot** (Lane A's High 5 vs Lane C's C-1). Both
  reached the same answer. `reliabilitySummary` composes the integrity half
  exactly once now, with no separate branch for the absent store;
  `emptyReliabilitySnapshot` keeps the required-integrity signature Lane A gave
  it, and its own unit test still pins that it cannot be called without a
  verdict.
- **The run key and the duplicate-run guard** (Lane A's Medium 2 vs Lane C's
  Medium 4). Identical fix to the digest, and Lane C's second half — `openRun`
  refuses `run_state_conflict` against a task carrying an unreconciled run —
  survives. Lane A's re-labelling test asserted the rename DEDUPES; it is ported
  to assert the refusal, and the property it was really pinning (the label is
  not part of a run's identity) is kept as its own new test over live work,
  where nothing is unresolved and the rename does dedupe.

**Known debt this pass records rather than closes:**

- WHICH file an operator may point `verifyHqBackupFile` at is not a question it
  answers. A symlinked ancestor is resolved and reported through `resolvedPath`
  rather than refused, and the final component is `O_NOFOLLOW`, so the inode the
  digest covers is the inode that is checked — but the choice of path is the
  operator's;
- `file_too_large`, `path_not_readable` and `verification_copy_failed` are
  asserted by construction rather than by being crossed;
- the verdict ledger is durable only where it exists: a database written before
  this correction, or a read-only handle over one, carries no
  `hq_reliability_verdicts` table, and the verdict is process-local there.
  `SAFE_MODE_STATEMENT` says so rather than glossing it;
- `hq_reliability_run_events` is not hash-chained (Lane A's open item, still
  open): a raw recognized `reconciled` append still flips a run's derived state
  and re-admits an attempt. The engine guards refuse UPDATE, DELETE and REPLACE;
  they do not refuse a new, well-formed, forged row;
- the recovery-liveness fix is a REPAIR path rather than a prevention (Lane A's
  open item, still open). The lease-liveness alternative was considered and
  deliberately not taken in this wave.

**Verification at the THREE-lane merged head** (the whole suite, not a subset):

| Command | Result |
|---|---|
| `npm run test:hq` | 164 files, 3109 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root) | 37 files, 569 passed, 3 skipped |
| `npm run build` | all workspaces; web `215.66 kB` / `69.22 kB` gzip (unchanged) |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |

Lane C alone was 164 files / 3080 tests and the Lane A + Lane B head 162 /
3073; the merged head exceeds both, which is what "nothing was dropped" looks
like in the count. Nothing was deleted, skipped, weakened or narrowed to make
the merge green: no `.skip` / `.only` / `.todo` / `xit` / `xdescribe` was added
anywhere, no `as any`, no `@ts-expect-error` and no `eslint-disable` in an added
line. Seven assertions written by the two earlier lanes were PORTED onto the
surviving implementations rather than dropped — five of them because the
survivor answers more strictly than the lane that wrote the assertion expected
(the re-labelled open, the deliberately fresh `idempotencyKey` open, the
un-checkpointed-WAL refusal name, the backdated `occurredAt`, and the retrieval
statement's "exported for testing" disclosure, which is inverted because it is
now false), and two because the survivor's signature changed (`fullIntegrity`'s
chain verifier is required, and the guard statement names declaration rather
than the resolver). Every guarantee either lane pinned is still pinned. The
three pre-existing `it.skip` GAP markers under `packages/server` are untouched;
`git diff` against the wave base `f1ce71c` over `packages/server`,
`packages/web`, `packages/shared` and `packages/config-mesob` is empty; and
`package.json` and `package-lock.json` are byte-identical to that base.

---

## The FOURTH reconciliation: the second correction round merged with the three-lane head

The three-lane head above and the "second correction round" recorded earlier in
this document were produced CONCURRENTLY by efforts that did not know about each
other, both on the same branch and both descending from the Lane A + Lane B head
`4c83f54`. This section records their merge. Nothing from either side was
discarded; where both fixed the same defect, ONE implementation survives and both
sides' regression tests are kept, ported onto it.

### The CRITICAL, and why it had to survive intact

The second correction round found that the FIRST round had introduced a
Critical: the late-outcome accept path let a worker whose own attempt had been
classified by a concurrent recovery conclude its own doubtful run, which lifted
the `openRun` guard and re-admitted a SECOND run and a second attempt on a
NON-IDEMPOTENT `external_side_effect` capability, with no independent principal,
no step-up and no idempotency check. The three-lane head inherits the vulnerable
accept path from `4c83f54` and does not close it.

The fix survives this merge unchanged: a late statement is appended as
`worker_report`, a member of the closed run-event vocabulary that
`deriveRunRecord` folds into `RunRecord.workerReport` while `state` stays
`needs_reconciliation` and `outcome` stays `outcome_unknown`; and an
`outcome_recorded` that lands on a run ALREADY standing at
`needs_reconciliation` is folded as testimony too, so a raw append into the
append-only event table cannot reopen the hole from outside this code.
`reconcileRun` — independent principal, step-up, idempotency rule — remains the
only thing that closes such a run.

The exploit is re-proven end to end in the merged tree by
`a late worker report can never re-admit a second run or a second attempt on the
same task` (`reliability-crash-recovery.test.ts`), which follows the whole chain:
a non-idempotent `external_side_effect` capability, a live fenced claim, a run
and an attempt, recovery from a second process, the late outcome from that same
worker, then a SECOND `openRun` and a second `startRunAttempt` — both refused —
plus a self-reconcile refused for want of independence and an independent
`confirmed_not_executed` refused because the capability is not idempotent.
`does not let a RAW outcome_recorded conclude a run standing at
needs_reconciliation` (`reliability-durability.test.ts`) proves the same rule at
the derivation, through a raw INSERT.

**One refusal NAME changed and no guarantee did.** The third lane added a second,
EARLIER `openRun` guard — a task carrying an unreconciled run is refused
`run_state_conflict` before the run key is derived at all — so the second
`openRun` in that exploit is now answered by that guard rather than by the
in-reservation `run_attempt_refused` that answered it before. Both are
categorical refusals naming the standing run; the assertions were ported to the
answer the merged guard order actually gives, with the reason stated inline, and
the in-reservation guard survives beneath it as the re-check under the
reservation. Reverting the `worker_report` fix in the merged tree makes three
tests fail, including both named above — checked, not assumed.

### Duplicate implementations, and which one survived

| Defect both sides fixed | Survivor | Dropped, and why |
|---|---|---|
| The safe-mode latch was not durable | `hq_reliability_verdicts` (third lane) | `hq_safe_mode_latch` (second round) — table, DDL, readers, writer, type, census entry and imports all removed. Two append-only ledgers answering "is safe mode engaged" is a second truth. The survivor also appends the verdict row and its evidence entry in ONE reservation, is consulted by `reliabilitySummary`, and records who assessed. Three properties were carried ONTO it from the dropped one: an engaged verdict whose stored finding list cannot be read still engages, the reported depth stays this assessment's, and a read-only handle writes nothing. All of the dropped implementation's tests were ported. |
| Backup verification digested one byte set and checked another | the scratch-copy verification (third lane) | the held-descriptor re-digest plus `dev`/`ino` comparison, and its `file_changed_during_verification` refusal (second round). Its argument was evaluated against the code rather than taken on trust, and it holds: after the `O_NOFOLLOW` open the survivor never touches the candidate path again, so digest, copy and checks come from ONE pass over ONE descriptor and there is no window in which they can disagree — fail-closed by construction rather than by detection. The dropped version disclosed its own residual (a rename REVERTED inside the window between SQLite's open and the `stat` still passes) and the survivor has no such residual. The second argument is decisive in combination: the dropped version opens the candidate with SQLite, which CREATES `-wal`/`-shm` beside it and leaves them, and the surviving sidecar rule refuses on PRESENCE — so keeping both would have made HQ refuse its own leftovers on the second verification. Keeping the size-based rule instead would have been the weaker refusal. The refusal reason is dropped with the implementation because the race it detects cannot occur in the survivor. |
| `hq_mission_plan_items` was outside the census | `EngineImmutableTable.requiredGuards` (second round) | `holdsUniversalTrio: false` (third lane). A boolean can only say "the trio" or "nothing"; it cannot express a REQUIRED `no_erase`, and `no_erase` is the guard that closes the executed Phase 14 fail-open (one DELETE of the single plan-item link turned a `blocked` proposal into `within_ceiling`). The third lane's exploit — dropping `_no_replace` to rewrite a plan item's task binding — is closed by the same entry, and its INVERTED live-schema test (the live trigger set EQUALS the union of the declarations) is kept and now binds it. |
| The run key and the duplicate-run guard | all three guards, in one order | nothing dropped. `run_state_conflict` (third lane) is checked first, before the key is derived; `run_key_conflict` (second round) answers a collision on LIVE work, where the dedupe is still reachable; the in-reservation `run_attempt_refused` remains as the re-check under the reservation. Three lanes wrote three different expected codes for the relabel-under-`needs_reconciliation` case, and each assertion was ported to the merged answer with its reason inline. |

Everything either side changed ALONE is kept verbatim. From the third lane: the
deep-freeze of `ENGINE_IMMUTABLE_TABLES` and its four sibling constants, the
required fail-closed chain verifier and `chainVerified`, the safe-mode gate on
`authorizeAction`, the module-private raw retrieval adapters, the
NFKC-normalized case-insensitive credential patterns, `cost_entry_conflict`,
the canonical budget-scope derivation and spend attribution,
`provider_binding_mismatch`, `deriveDecisionRecord`'s canonical re-derivation,
and the `redaction.ts` corrections. From the second round: the CRITICAL above,
`run_key_conflict`, the `no_erase` guard and its reduced census base,
`readStoredCostFact`'s two further parity gaps, the bounded `decisionId`, and
the honest residual disclosure now stated on `standingIntegrityVerdict`.

### One seam the merge had to close itself

The deep-freeze (third lane) and the reduced base (second round) met for the
first time here, and `deepFreezeTables` froze `entry.secondaryGuards` and the
entry but not `entry.requiredGuards` — which is exactly the finding the freeze
exists to close, one field across:
`ENGINE_IMMUTABLE_TABLES[i].requiredGuards.length = 0` would have dropped
`no_erase` and `no_replace` off `hq_mission_plan_items`' declared set and made
the census blind to the guard the other lane had just added. Frozen, and pinned
by an added assertion in `refuses assignment to the census array, its entries
and their guard lists`.

## The THIRD correction round: what two independent hostile reviews reproduced

Two read-only reviewers re-read the reconciled head by EXECUTION and reproduced
five High, ten Medium and four Low findings across Phases 13 and 14. The Phase
13 half is below; the Phase 14 half is in that phase's document. Every entry
names what was actually wrong, not what was thought to be wrong.

| Finding | What was reproduced | What changed |
|---|---|---|
| **HIGH A1** — a DROPPED ledger read as a clean store | `DROP TABLE` is DDL: no BEFORE trigger refuses it, and the guard census SKIPPED a declared table that was absent. Dropping `hq_action_intents`, `hq_action_events`, `hq_truth_records`, `hq_truth_verifications`, `hq_truth_acceptances`, `hq_memory` and `hq_intel_budgets` produced a structural pass AND a full assessment with ZERO observations, while the facade's ensures recreated each one EMPTY. Dropping `hq_reliability_verdicts` erased a latched safe mode outright and `releaseKillSwitch` was admitted with the evidence chain still broken. | The absence is OBSERVED as found, before any ensure runs, and is a finding when HQ's own schema then re-creates the ledger. `establishedImmutableTables` discriminates a first construction — where every phase's ledger is legitimately absent — from a file that has lost one. **Corrected TWICE in the fourth round, once per lane, and both corrections are kept.** (a) That discriminator on its own was bypassed by doing MORE damage — dropping ALL of the declared ledgers emptied the set, read as a first boot and silenced the census entirely while the operational half of the database survived; it now also reads a mark HQ stamps into `PRAGMA user_version` after its ensure pass, which lives in the database header where no `DROP TABLE` reaches it and which `VACUUM` preserves. A content check over the tables was tried and rejected: HQ's own components legitimately write rows to a fresh file BEFORE the facade is constructed over it, so "this file has rows" cannot tell a first boot from an operated file. (b) `op_evidence` was invisible to the census in the other direction — `migrateHqDatabase` re-creates it before the facade census runs — so the absence is now taken from the PRE-migration catalogue (`tableNamesBeforeMigration`) for exactly the migration-created ledgers. |
| **HIGH A2** — the hash chain did not detect DELETION | `op_evidence` carried no append-only triggers at all, so a raw `DELETE` was permitted; and the verifier walked forward from the genesis value with no commitment to where the chain should END, so deleting the NEWEST entries left a chain that verified perfectly. `DROP TABLE op_evidence` and `DELETE FROM op_evidence WHERE seq > 1` both read CLEAN at full depth. | Three holds were added — the engine refuses UPDATE/DELETE/REPLACE; `op_evidence` is a declared engine-immutable ledger; and the verification compares the entries present against the AUTOINCREMENT high-water mark. **They were NOT independent, and the round that added them said they were.** All three live inside the thing being checked: `DROP TABLE op_evidence` takes the triggers, the rows and the `sqlite_sequence` entry with it, and the census that hold two rests on runs AFTER `migrateHqDatabase` has re-created the table empty. The FOURTH correction round closes both halves, one per lane, and both are kept — see its section below: seq CONTIGUITY from 1, because the high-water half alone was erased by the very next append (HQ's own boot appends did it), and a durable commitment recorded OUTSIDE `op_evidence`, because contiguity is silent on a log dropped and re-created whole. The two lanes recorded that commitment in two different places; the FIFTH round's `hq_integrity_checkpoints` is the one that survived the reconciliation, and the verdict-row commitment was retired — see the boundary item in the NOT-fixed list. |
| **HIGH A3** — a second run lineage opened while the first attempt was still in flight | Both halves of the duplicate-run guard keyed on `needsReconciliation`, and a crashed attempt sits at `attempting` until the Founder-gated recovery classifies it. A second `openRun` under a distinct `idempotencyKey` derived a distinct `run_key`, passed both guards, and `startRunAttempt` ADMITTED generation 1 on a `sideEffect: true` capability while the first worker held the live fence. | One guard over both unsettled states, applied at the ATTEMPT as well as at the OPEN — two runs can both stand at `open` and then attempt one after the other. `open` stays admissible, so two genuinely separate pieces of work on one task remain expressible. |
| **MEDIUM A4** — a hard link to the live database verified as a backup | The sidecar refusal is keyed on the resolved PATH; a hard link is a second name for the same inode with no sidecars beside it. Recorded permanently in the append-only register as a verified recovery point, missing WAL-resident committed data. | `nlink` from the opened descriptor; `file_has_multiple_links`. The shipped "the live database is therefore refused" is scoped to what is true, and the `cp` case is disclosed rather than implied away. |
| **MEDIUM A5** — a fabricated durability defect on every snapshot | `synchronous` is a connection pragma SQLite records nothing about in the file, and `openHqDatabaseReadOnly` — the `hq:snapshot` open — never set it. Every world-readable snapshot of a healthy WAL + FULL store published `durabilityMeetsRequirement: false` and a `durability_below_requirement` finding, permanently masking a genuine degradation. | Both HQ opens establish the declared posture, spelled the same way. The posture documents what it is a statement about: the journal mode is the FILE's, `synchronous` is this CONNECTION's, and a read-only handle does not speak for the writer's. |
| **MEDIUM A6** — the capability drift gate was defeated by patching what it compares against | `RELIABILITY_COMMAND_RESERVED_CONTRACT` was unfrozen. With a tampered registry row the gate correctly refused `assessHqIntegrity`; patching the reserved contract made it ADMIT at full depth. `REPORTABLE_RUN_OUTCOMES.length = 0` and `RUN_STATES.length = 0` corrupted the unauthenticated snapshot's counts. | One shared `deepFreeze`, applied to every `*_RESERVED_CONTRACT` in the package, the capability declarations they derive from, and every closed vocabulary a decision or a published count is keyed by. The pinning test enumerates the package rather than a hand-kept list. |
| **MEDIUM A7** — one raw `INSERT` cleared a latched safe mode | An APPEND is exactly the write an append-only ledger permits, and the boot's own pass is structural. `releaseKillSwitch` and `claimNext` came straight back out, while `SAFE_MODE_STATEMENT` asserted on every view that only a fresh full assessment clears it. | A verdict that says ENGAGED stands whoever appended it; a verdict that says CLEAR counts only when the evidence chain carries the entry naming it, which the two writers of a verdict append in the same reservation. `latestIntegrityVerdict` is renamed `standingIntegrityVerdict`, because it is no longer the latest anything. |
| **MEDIUM A8** — safe mode left an authority-GRANTING mutator open | `registerExecutionWorker` created a worker identity WITH its `allowedCapabilities` while HQ had declared its own record untrustworthy. `declareWorkerProvider` is the same act one field across and was not in the reviewers' list. | Both refused, first and categorically; `SAFE_MODE_STATEMENT` names them. The five that stay available are decided deliberately, with the reason on the method and in the table above. |
| **LOW A9 / LOW A10** — three test titles advertising proofs their bodies did not execute | The two latch tests tried UPDATE and DELETE, which the triggers refuse, and never the plain INSERT that actually cleared safe mode. The statement test greped three substrings and executed no behaviour while pinning a sentence whose second half was false. | Each body now runs what its title claims. |

**Two claims the review checked and found TRUE**, recorded so a later reader does
not re-litigate them: the `#private`-closure enforcement design held under
hostile patching of every read surface tried, and the trigger/table census was
exactly complete in both directions before `op_evidence` was added to it.

## The FIFTH correction round: a commitment that lives outside the record

A fresh read-only reviewer re-read the fourth-round head by EXECUTION and
returned 0 Critical / 1 High / 1 Medium / 3 Low. Both the High and the Medium
were the same defect one level apart: **every check HQ had read the record and
asked whether the record was self-consistent**, and a writer that already holds
the file open can make a shortened record perfectly self-consistent.

| Finding | What was reproduced | What changed |
|---|---|---|
| **HIGH 1** — the evidence chain could be re-written WHOLE, and the shipped residual overstated three barriers that do not exist | `DROP TABLE op_evidence` → re-create from its own `sqlite_master` SQL → INSERT a shortened log with explicit seqs rehashed from the genesis value → re-create the three triggers. Links, contiguity and the `sqlite_sequence` high-water mark all agree; NO `UPDATE` is executed, nothing writes `sqlite_sequence`, the guards are back before HQ next constructs, and the dropped-ledger detector sees a table that is present. Two committed audit entries erased, boot CLEAN, Founder full assessment CLEAN. The cheaper tail-SUBSTITUTION variant (drop triggers → DELETE tail → INSERT replacements at the SAME seqs → re-create triggers) was equally clean. The residual list told the Founder this attack needed the UPDATE the engine refuses and left a blocking trace; it needed neither. | A durable checkpoint ledger, `hq_integrity_checkpoints`: append-only, engine-guarded with the same trio, declared in `ENGINE_IMMUTABLE_TABLES`, holding the evidence chain's length and the hash AT that seq plus each declared ledger's AUTOINCREMENT high-water mark. Written at every construction that finds nothing blocking and inside every clean assessment, never while safe mode is engaged, and never on a read-only handle. EVERY commitment ever recorded is checked and the per-ledger comparison takes the maximum ever committed, so appending a checkpoint that agrees with a forgery adds a satisfied row and removes nothing. `verifyEvidenceChain` returns the first contradicted length, and the cheap structural pass checks the commitment too — one indexed lookup — so the boot catches it as well as the assessment. |
| **MEDIUM 1** — one Founder full assessment converted a confirmed destructive finding into a recorded CLEAN verdict | The boot census reported 31 dropped ledgers and engaged safe mode; `releaseKillSwitch` was refused. The full assessment — the documented remedy — asked about "the file as it now stands", found the ledgers HQ had itself re-created EMPTY, and recorded `safeMode: false` with an EMPTY findings list; `releaseKillSwitch` was then admitted. Identical for the seven-ledger subset. | Two halves. The ledgers THIS process found absent and re-created are carried into `fullIntegrity` and are not clearable by it: re-creating a ledger repairs the schema, not the rows. A missing GUARD stays clearable, deliberately, because re-creating a trigger genuinely does repair the file's guard set. The durable half is the checkpoint's high-water commitment, which is a fact about the file as it now stands and therefore survives restarts. |
| **LOW 1** — the schema-ensured mark's false-ALARM direction was undisclosed | `hqSchemaEnsuredMarkPresent` accepted ANY non-zero `PRAGMA user_version`, which is the conventional application-schema slot. A fresh file another application had stamped `user_version = 7` booted `safeMode: true ["append_only_guard_missing"]`; the control fresh file booted clean. | A distinctive constant of HQ's own, read as an exact member of a closed set. A later build that raises the generation adds the new value beside the old one, which is a reviewed act rather than an arithmetic comparison that would accept a foreign stamp again. |
| **LOW 2** — `assessHqIntegrity` threw an uncaught `SqliteError` on a read-only handle, and the comment beside it was false | `#reliabilityStorePresent` is TRUE for a read-only handle over a modern file, so the verdict append ran and the engine's error escaped the facade instead of an `OpsResult`. The comment claimed `verdictRecorded` was false for "a pre-correction file, or a read-only one"; the read-only half never got that far. | An explicit refusal, after the authority gates, naming why: the assessment records a verdict, the evidence entry that corroborates it and the checkpoint, and a verdict HQ cannot record is a verdict HQ does not act on. The comment now says what is true. |
| **LOW 3** — a cost entry's identity contained a wall-clock default | `occurredAt` defaulted to `nowIso()` and fed `costEntryKey`, so at 0 ms, 2 ms and 30 ms gaps an unchanged replay of a 6000-unit entry was accepted as a NEW ROW and the Founder ceiling observed 12000 from 6000 spent. It also answers a question a previous round left open: the cost-entry shuffling an earlier reviewer saw across runs was this, not a script artefact. | The key carries the DECLARED instant or nothing, and an entry declaring neither an `idempotencyKey` nor an `occurredAt` is refused. Recorded in the Phase 14 document, where the claim it falsified lives. |

**Two things this round deliberately did NOT do**, with the reason: it did not
widen the closed finding vocabulary — a dropped ledger has always been reported
as `append_only_guard_missing`, and a ledger that is back empty is the same
finding measured a second way — and it did not make a boot-time observation
permanently unclearable, because a build that declares a NEW ledger produces the
same observation on every established file and permanent safe mode for a routine
upgrade would be a worse failure than the one being closed. What it DID cost the
routine upgrade was measured only in the sixth round, and it is a restart and a
second Founder assessment rather than the one the three shipped sentences
claimed; the sentences were corrected there.

### What is NOT fixed — all four lanes' disclosures, in one list

Nothing below is closed by this wave, and each item is stated where it belongs
as well as here:

- `hq_reliability_run_events` is not hash-chained, and there is no cross-check
  against the chained `op_evidence` entry. A raw, well-formed, recognized append
  still moves a run's derived state; the engine guards refuse UPDATE, DELETE and
  REPLACE, not a forged new row.
- The evidence chain's LENGTH commitment is three checks now, not two: the seqs
  present must be CONTIGUOUS from 1, the largest one present must reach SQLite's
  own AUTOINCREMENT high-water mark in `sqlite_sequence` (which a DELETE does not
  lower), and the log must not contradict any DURABLE CHECKPOINT HQ has recorded
  in `hq_integrity_checkpoints`. **Both earlier wordings of this item understated
  the cost of getting past it, and each was corrected by the round that followed
  it.** The fourth round corrected "a `sqlite_sequence` rewrite is needed" — no
  rewrite was needed, because the high-water check alone was erased by the next
  ordinary append (HQ's own boot appends did it) and a tail deletion that
  verified as BROKEN one moment verified as CLEAN one entry later, with the
  documented remedy then certifying the robbed log (HQ's OWN boot appends were
  the laundering write); contiguity is the property no later write repairs. That
  same round also corrected the mitigating clause "the first of those steps is
  itself a blocking finding", which did not hold either: a dropped trigger that
  is RECREATED before the next boot observation is never observed missing, so
  drop-trigger / delete-tail / recreate-trigger / `UPDATE sqlite_sequence` read
  `safeMode: false, []`. **The fifth round corrects the sentence the fourth round
  wrote**, which named three barriers that were all false and cross-referenced a
  fourth item that answered nothing. It said the surviving attack needed the
  survivors RENUMBERED, that the renumbering needs the UPDATE the engine guard
  refuses, that dropping that guard is itself a blocking finding, and that a log
  dropped and re-created whole is the dropped-ledger question answered below.
  Executed, none of it held: `DROP TABLE op_evidence`, re-create it from its own
  `sqlite_master` SQL, INSERT a shortened log with explicit seqs rehashed forward
  from the genesis value, re-create the three triggers. No `UPDATE` is executed
  anywhere, so that barrier is never crossed; nothing writes `sqlite_sequence`,
  because SQLite rebuilds the high-water mark from the explicit rowids; there is
  no census finding, because the guards are back before HQ next constructs and
  the as-found census reads `sqlite_master` at construction time only; and the
  dropped-ledger detector reports nothing, because the attacker re-created the
  table. Two committed audit entries were erased and BOTH the boot and the
  Founder's full assessment read completely clean. The cheaper tail-SUBSTITUTION
  variant — drop the triggers, DELETE the tail, INSERT replacement rows at the
  SAME seqs, re-create the triggers — was equally clean, and it too executes no
  `UPDATE`. What answers both is a commitment that does not live inside the log:
  HQ records the chain's length and the hash at that seq into
  `hq_integrity_checkpoints` at every construction that finds nothing blocking
  and inside every clean assessment, every commitment ever recorded is checked,
  and the per-ledger comparison takes the maximum ever committed — so appending a
  checkpoint that agrees with the forgery adds a satisfied row and removes
  nothing. **The SIXTH round corrects the sentence the fifth round wrote**,
  which named a barrier the attacker never has to cross. It said the surviving
  attack is a writer that rewrites the log coherently AND DROPS
  `hq_integrity_checkpoints`, and priced that at "one extra `DROP TABLE`, one
  restart and one further Founder act". The drop variant reproduced exactly as
  written at THAT head — `p2 boot=true assess=true release=refused`, `p3
  boot=true assess=false release=ADMITTED` — but it was not the cheap way.
  (It no longer reproduces at all: since round eleven's header mark, dropping
  that ledger is a permanent lockout at every process, which round twelve's
  Medium 4 records in the residual list below — including the operational cost,
  which is a store no in-HQ act can bring back.) Wiping the
  commitments' ROWS IN PLACE costs nothing at all: drop the ledger's three
  triggers, `DELETE`, INSERT one replacement that agrees with the forged log,
  re-create the triggers. The table is never absent, so the as-found census has
  nothing to observe, and against the fifth-round head the forgery was accepted
  from the very next boot — `BOOT safeMode = false []`, `FULL assessment
  safeMode = false []`, `releaseKillSwitch ADMITTED? true`, zero restarts and
  zero Founder acts. The same wipe also neutralised the durable half for a store
  whose every OTHER declared ledger had been dropped: `p3 boot=false assess=false
  release=ADMITTED`.

  What answers the free version is an invariant of the commitment ledger itself
  rather than another commitment about it. It is `INTEGER PRIMARY KEY
  AUTOINCREMENT`, HQ is its only writer and its `no_erase` guard refuses a
  DELETE, so the rows it holds, its greatest rowid and the high-water mark
  SQLite records for it are the same number — and an in-place elision breaks
  that identity, because `sqlite_sequence` keeps the mark the deleted rows
  reached. Both attacks above are now blocking at the boot, at the assessment,
  and at every process afterwards. Before relying on it, six legitimate ways a
  sequence value might be burned were executed against a table with this exact
  schema — the `no_replace` guard's own `RAISE(ABORT)`, a `UNIQUE` violation, a
  `NOT NULL` violation, a failed insert inside a transaction that later commits
  other work, a multi-row `INSERT ... SELECT` whose second row fails, and an
  explicit `ROLLBACK` of a good insert — and SQLite burned none of them;
  `VACUUM` preserves all three numbers. A false permanent alarm here would have
  been worse than the hole.

  **What is still NOT detected — RE-PRICED in round SEVEN, because the version
  WITHOUT the barrier the last price named was never executed (Low 2).** The
  round-five sentence here read "insert the replacement at an EXPLICIT
  `seq = 1` and then `UPDATE sqlite_sequence SET seq = 1` for that ledger",
  measured `rows/highwater={"c":1,"s":1} boot=false assess=false
  release=ADMITTED`. Two things are wrong with it. First, that path is not the
  cheapest. Second, on a file carrying more than ONE commitment it is CAUGHT:
  collapsing three commitment rows into one regresses this ledger's own recorded
  high-water mark, and the next process came back `boot=true assess=true
  release=safe_mode_engaged`. It was measured on a single-commitment file, where
  the collapse is invisible.

  The path that actually survives elides nothing, so there is no identity to
  repair and no `sqlite_sequence` write at all. Keep the ROW COUNT and rewrite
  the rows IN PLACE: `DROP TRIGGER` the ONE `BEFORE UPDATE` guard of the three,
  one `UPDATE hq_integrity_checkpoints SET chain_length = …, tip_hash = …,
  ledger_marks = …`, re-create that one trigger. Count, greatest rowid and
  high-water mark are untouched by construction. Executed end to end with
  `op_evidence` itself rewritten in place and re-chained, so the forgery is real
  rather than notional: `p2/p3/p4 boot=false assess=false release=ADMITTED`,
  permanently. Zero `sqlite_sequence` writes, zero `DELETE`s, zero `INSERT`s,
  zero explicit rowids, one trigger of three per ledger touched. The whole
  sequence is in `reliability-commitment-residual.test.ts`, which asserts the
  hole as well as the closure — a residual nobody can execute is a residual
  nobody can price.

  So the honest gain of `elidedCommitmentLedgerRows` is narrower than it was
  written to be — and the sentence that stood here for two rounds, "it closes
  every version that DELETES rows, at every price", was FALSE of the code in
  both of its halves. Round ten corrects it rather than softening it: a PREFIX
  replay deletes rows and was silent (see the round-ten entry below), and even
  now every version can be bought back with one further `PRAGMA application_id`
  write. What the check closes is every version that leaves the ledger holding
  fewer commitments than HQ's header records it once held — deleted in place,
  deleted with the high-water mark deleted beside them, dropped and replayed
  empty, or dropped and replayed as a prefix — and it closes none of them
  against a writer willing to spend that one further statement. It
  does not close the version that rewrites them in place, and no row-count
  invariant can — the count is exactly what that version preserves. The
  even cheaper ONE-statement repair of an ELISION was tried too and does not hold: `DELETE
  FROM sqlite_sequence WHERE name = 'hq_integrity_checkpoints'` buys the
  attacker the process that follows, the Founder assessment it was aiming to
  pass included — and that assessment is itself the next COMMITMENT, which
  re-creates the high-water mark from the surviving rowid and breaks the
  identity again without any further help. Measured: `p2 boot=false
  assess=false release=ADMITTED`, then `p3 boot=true assess=true
  release=refused` and `p4` the same, permanently.

  **"The version costing NOTHING is gone" was FALSE when round six shipped it,
  and a third variant is what made it false** (round seven, High NEW-2). Neither
  reading above sees an EMPTY ledger: `DELETE` every row AND `DELETE FROM
  sqlite_sequence WHERE name = 'hq_integrity_checkpoints'` — two statements, no
  replacement row at all — left `rows = 0` with no high-water mark to compare it
  against, and `elidedCommitmentLedgerRows` returned early. Measured on
  `d97b8a6`: `p2`–`p5` each `boot=false [] full=false [] release=ADMITTED`, zero
  restarts and zero Founder acts, silent for ever. It is closed in the same
  place as the Critical of that round — see the checkpoint-existence entry below
  — and the sentence is re-priced rather than repeated: what is gone now is
  every version costing nothing, and the one-statement repair still costs the
  attacker every process after the one it bought. HQ holds no key
  a foreign writer does not also have; every fact this ledger rests on lives in
  the same file the attacker is already writing, and nothing here pretends the
  commitment is a boundary.

  **Both round-six lanes reproduced that in-place wipe independently, and the
  merge keeps both answers because they are not the same answer.** The other
  lane reached it from the general direction: `verifyEvidenceChain` has always
  ended its walk by comparing `op_evidence`'s last surviving seq against
  `sqlite_sequence`, and that single comparison is why tail truncation of the
  audit log is caught — but nothing generalised it, so EVERY other declared
  ledger could be emptied by the same three statements with no finding at any
  depth. `truncatedImmutableLedgers` makes that comparison — `MAX(rowid)` versus
  the engine's high-water mark, one b-tree seek per ledger — for every declared
  AUTOINCREMENT ledger, and reports the new blocking finding
  `append_only_ledger_truncated` at both depths. It is what closes the identical
  attack on `hq_reliability_run_events`, where emptying the ledger returned a
  correctly refused duplicate attempt to generation 1 and ADMITTED it, making
  `RUN_RETRY_STATEMENT`'s "an interrupted attempt is NEVER retried
  automatically" false; that ledger's rows are the cross-process reservation, and
  no commitment about the checkpoint ledger says anything about them. The row
  COUNT identity above is in turn strictly stronger for the commitment ledger,
  because a replacement row can restore the greatest rowid and satisfy the
  general relation. Neither subsumes the other; both fire at both depths.

  The merge also had to COMPOSE one thing rather than lay the two side by side.
  The other lane's blocking finding means the boot that observes an inflated
  `sqlite_sequence` appends its safe-mode verdict row — and SQLite gives that row
  the inflated rowid, which made `min(seq, MAX(rowid))` commit the inflated value
  after all and manufactured exactly the permanent finding true of nothing that
  this round's Low 1 exists to prevent. The committed mark is therefore now
  `MAX(rowid)` alone, with `sqlite_sequence` used only as the gate for "has this
  ledger ever been appended to" (a DROP takes that row with it). That is strictly
  stronger in both directions: it cannot be moved by any write to
  `sqlite_sequence`, and every detection the `min` gave is unchanged.

  For the OTHER declared ledgers the general check protects, the same
  `sqlite_sequence` residual applies and its limit was measured rather than
  assumed. `sqlite_sequence` is an internal SQLite table, it carries no
  triggers, `tableNames` excludes it by construction, and a writer holding the
  file open can lower or remove the mark it finds there — so emptying a ledger
  AND removing its `sqlite_sequence` row silences the truncation check. What it
  does NOT silence is the commitment: once any checkpoint has recorded a mark
  for that ledger, the removal makes the current mark ZERO against a committed
  one, and `regressedImmutableLedgers` reports it permanently. Executed on
  `hq_reliability_run_events` at this head, both ways: with no warm boot before
  the attack (no mark ever committed) `p2 boot=false [] assess=false
  release=ADMITTED`; with ONE warm boot before it, `p2` and `p3` both
  `boot=true [append_only_guard_missing] assess=true release=refused`. The
  residual is therefore "empty a ledger HQ has never committed a mark for, and
  remove its `sqlite_sequence` row" — the same residual class as zeroing
  `PRAGMA user_version`, and narrower than it looks.

  **A declared ledger that is not `AUTOINCREMENT` has no `sqlite_sequence` row
  at all and contributes nothing to THIS check, and the sentence that used to
  end this paragraph made that read like an empty set** (corrected at round
  seven, Medium 2). "Every ledger the check currently protects does have one" is
  a tautology — the check protects exactly the ledgers that have one — and it
  was standing where a reader looks for the residual. FIVE of the 33 declared
  ledgers have no such row, ever: `hq_memory`, `hq_mission_intents`,
  `hq_mission_plan_items`, `hq_missions` and `hq_orchestration_runs`. Two of
  them are the ledgers a task's mission and its project ceiling are derived
  through, which is why this wave gave them `no_erase` at all. At round seven
  they are covered by `regressedImmutableLedgers`, which reads every declared
  ledger's own rows against HQ's own commitment rather than starting from
  `sqlite_sequence`; wiping one is blocking at both depths and across restarts.
  What remains true of THIS check, and only of it, is that a ledger with no
  engine high-water mark contributes nothing to it.

- **Round seven, Critical NEW-1 — destroying the commitment ledger outright was
  cheaper than eliding a row from it, and the file certified itself intact.**
  Every check that guards the commitments read something the erasure destroys:
  `regressedImmutableLedgers` reads `committedLedgerMarks` out of the table that
  was emptied, so an empty table commits nothing and contradicts nothing; and
  `elidedCommitmentLedgerRows` started from the `sqlite_sequence` row a `DROP
  TABLE` takes with it. So `DROP TABLE hq_integrity_checkpoints` followed by a
  replay of the table's own DDL out of `sqlite_master` — the table SQL, its
  index and its three guards — left it PRESENT and empty, with nothing absent
  for the as-found census to observe. Executed against `d97b8a6` on a file
  carrying a genuinely latched `evidence_chain_broken`: `full=false []`,
  `releaseKillSwitch` **ADMITTED**, and every later process `boot=false []`,
  permanently. The same held with `op_evidence` dropped and replayed beside it,
  and with `hq_reliability_verdicts`.

  **What closes it: a witness that does not live in any table.** HQ stamps
  `PRAGMA application_id` with `0x48514350` (`HQCP`) once a checkpoint row has
  LANDED — never before, because a witness set beside a failed insert would be a
  permanent finding true of nothing. `application_id` sits in the 100-byte
  database header, `DROP TABLE` cannot reach it, `VACUUM` preserves it, SQLite
  never writes it, and `user_version` is already using the other slot. A
  commitment ledger that is PRESENT and holds NO rows on a witnessed file is
  therefore blocking at both depths and across restarts, however it came to be
  empty. Read as an exact member of a closed set, for the reason
  `HQ_SCHEMA_ENSURED_MARKS` records: a foreign application's `application_id`
  must not be a false alarm at HQ's first boot over its file.

  **CORRECTED at round ten, and this paragraph described the superseded
  encoding until round thirteen (Low 3).** The slot no longer carries one exact
  32-bit value read as a member of a closed set. It carries a 16-bit SIGNATURE
  (`0x4851`, `HQ` in ASCII) in the high half and the greatest rowid HQ's
  commitment ledger has ever reached in the low half, saturating at `0xFFFF`;
  `0x48514350` is kept as a legacy stamp meaning "witnessed, mark unknown", for
  back-compatibility with files committed on by an older build. That is a real
  loss of specificity in the false-alarm direction — 65,535 accepted values
  rather than one — and it is measured and argued where the encoding lives
  (`HQ_COMMITMENT_WITNESS_MARK` in `store/integrity.ts`), together with the one
  mark value the encoding gives up (a genuine mark of 17,232 encodes to exactly
  the legacy value and is read back as "unknown"). This page's own convention is
  that a superseded description carries the correction rather than being
  silently rewritten, which is why the original sentence stands above it.

  **What it still does not answer, executed rather than asserted.** A writer
  that also runs `PRAGMA application_id = 0` puts the file back to unwitnessed —
  one further statement on top of the erasure, still silent, measured
  (`boot=false`). That is the same residual class as zeroing `PRAGMA
  user_version` or rewriting `sqlite_sequence`. What is closed is the
  INVERSION: total erasure is no longer cheaper than partial erasure. And a
  file whose commitments were all written by a build older than this witness
  carries none of it until HQ's next checkpoint stamps the header, which is the
  ordinary upgrade cost of any new mark and not a defence.

  The other escape is the one already disclosed for the header mark, and the
  checkpoint ledger DOES change its price — this paragraph priced it two
  statements too cheap and one restart too cheap until round thirteen (Low 2).
  It read: "a writer that drops every declared ledger AND zeroes
  `PRAGMA user_version` leaves a file that reads as a first boot … Executed:
  `boot=false [] release=ADMITTED` on the first process afterwards." Re-executed
  at `237fc76`, step by step on one warmed file:

  - 33 `DROP TABLE`s, one per declared ledger: `boot=true
    [append_only_guard_missing] assess=true release=REFUSED`;
  - plus `PRAGMA user_version = 0` (34 statements): still `boot=true
    [append_only_guard_missing] assess=true release=REFUSED`, on that process
    and the next;
  - plus `PRAGMA application_id = 0` (35 statements): the first process
    afterwards is `boot=true [append_only_guard_missing] assess=FALSE []
    release=ADMITTED`, and every process after that is `boot=false []`.

  So the honest price is 35 statements, one restart and one Founder assessment —
  not 34 and no restart. What did not change is the CLASS: HQ holds no key over
  its own file, and a writer who already has it can rewrite both header slots.

- **There were TWO durable commitments in the concurrent round-four/round-five
  lanes, and ONE survives.** The round-four lane recorded the chain tip on every
  VERDICT row — `evidence_tip_seq` / `evidence_tip_hash` on
  `hq_reliability_verdicts`, read back with `MAX(evidence_tip_seq)` by
  `evidenceChainCommitmentBreach` and injected into `structuralIntegrity` /
  `fullIntegrity` as a value. It answered the same question
  `hq_integrity_checkpoints` answers, so it was retired rather than kept beside
  it: two records of "how far did the audit log reach" are two things a future
  change has to keep in step, and this package does not keep two. The checkpoint
  ledger is the one that survives, on three merits, each of which is a real
  difference and not a preference:
  1. **It is fail-closed where the MAX was fail-open.** Appending to the verdict
     ledger is a write its trio deliberately permits. A writer that rebuilt
     `op_evidence` as a LONGER coherent forgery could append one verdict row
     committing to the forged tip; the `MAX` selected it and the genuine
     commitment behind it was never consulted again.
     `contradictedChainCommitment` checks EVERY commitment ever recorded and
     takes the per-ledger maximum, so the same appended row adds a satisfied row
     and removes nothing.
  2. **It commits far more often.** A verdict is written only when a Founder
     assesses; a checkpoint is written at every construction that finds nothing
     blocking. That bounds a forger's window to one process lifetime instead of
     to the gap between two Founder acts.
  3. **It commits to more than the chain.** Each checkpoint also carries, for
     every declared ledger this file carries, how many rows it holds and the
     greatest row it reaches — which is what `regressedImmutableLedgers`
     measures, a durable answer to "a ledger is back EMPTY" and to "a row was
     taken out of the middle of one" that survives restarts. The verdict-row
     commitment said nothing about any ledger but `op_evidence`. (Until round
     seven this said "every declared ledger's AUTOINCREMENT high-water mark",
     which was false in two ways at once: the reading was the ledger's
     `MAX(rowid)`, not the engine's mark, and it was taken only for the ledgers
     that HAVE an engine mark — 28 of 33. Both halves are corrected in the code,
     not only in the sentence: High 1 and High 2.)

  **What was lost with it, stated rather than glossed — and RE-PRICED by the
  sixth round, because the first price was understated.** The two commitments
  lived in two different append-only ledgers, so an attacker who wanted both
  silenced had to drop both. With one mechanism the round-five text recorded the
  cost as "there is now ONE ledger to drop", pointing at the drop residual
  (`p2 boot=true assess=true release=refused`, `p3 boot=true assess=false
  release=ADMITTED`). **That sentence was true of the drop and silent about the
  cheaper act**, which the sixth round executed: until `elidedCommitmentLedgerRows`
  existed the surviving ledger did not have to be DROPPED at all — wiping its
  ROWS in place left the table present, the census silent and the forgery
  accepted at zero restarts and zero Founder acts. So the honest statement of
  what retiring the second commitment cost is: one ledger to drop OR to wipe in
  place and re-seat, and the free version of the second of those is now closed —
  see the re-priced residual immediately above for what the wipe costs today
  (one `DROP TRIGGER` and its re-creation per ledger, plus one `UPDATE` per
  ledger; no `sqlite_sequence` write, contrary to what round five recorded
  here). The trade itself still
  stands on its three merits, because the retired mechanism could be argued past
  by an APPEND — a write the ledger permits — while the survivor cannot, and a
  second barrier that a permitted write can retire is not a second barrier.
- A DROPPED declared ledger is a finding only on a handle that can WRITE, because
  the discriminator between "this file lost a ledger" and "this file predates
  it" is that HQ's own ensure pass re-creates what its schema declares. A
  read-only handle re-creates nothing and therefore cannot tell the two apart;
  it reports neither rather than inventing one. **The earlier wording of this
  item said only that, and it was incomplete in the direction that mattered.**
  Until the fourth correction round the "has HQ been here before" half of the
  discriminator was "does this file still carry an ensure-created declared
  ledger", which meant dropping a SUBSET of the ledgers was reported and dropping
  ALL of them emptied the set, read as a first boot, and returned a completely
  SILENT census at both depths — while the workers, capabilities, principals,
  tasks, approvals and kill switch all survived and `releaseKillSwitch` was
  handed back. More damage bought less detection. That half is now answered a
  second way as well, by a mark HQ stamps into `PRAGMA user_version` after its
  ensure pass: it lives in the database header, no `DROP TABLE` reaches it, and
  `VACUUM` preserves it. What remains, and is genuinely a residual: a writer that
  ZEROES `PRAGMA user_version` puts the file back to unmarked and a census over a
  file with every ledger dropped goes silent again. That is a deliberate forgery
  of HQ's own mark rather than a further drop — the same residual class as
  rewriting `sqlite_sequence` — and it is a different act from the one that used
  to succeed, which needed nothing but more `DROP TABLE`. A file no writer of
  this build has ever opened carries no mark either, and is read as a first boot;
  that is the same read-only/older-file limit as the sentence above, and it also
  covers the case where the stamp itself could not be written — the facade never
  fails a construction over the mark, so a file HQ could not stamp is a file HQ
  reads as new next time.

  **The fifth correction round adds the half this item never had: what a full
  ASSESSMENT does with the same observation.** The boot reported the drop and
  engaged safe mode, and then one Founder full assessment — the documented
  remedy, and the only thing that can clear a latch — asked about "the file as
  it now stands", found the ledgers HQ had itself just re-created EMPTY, and
  recorded `safeMode: false` with an EMPTY findings list. HQ affirmatively
  certified a store it had told the Founder was gutted one call earlier, and
  handed `releaseKillSwitch` back. Executed for the total erasure and, in
  exactly the same shape, for the seven-ledger subset that shipped in an earlier
  round. Two things changed. The ledgers this process found ABSENT and
  re-created are carried into the assessment and are not clearable by it —
  re-creating a ledger repairs the schema, not the rows, and no assessment of
  the file as it now stands can un-destroy them (a missing GUARD is deliberately
  still clearable, because HQ re-creating a trigger genuinely does repair the
  file's guard set). And the checkpoint ledger described above commits each
  declared ledger's AUTOINCREMENT high-water mark, which cannot fall in
  legitimate operation, so a ledger that is back EMPTY contradicts a commitment
  the file itself carries — a fact about the file as it now stands, reported
  however many restarts have happened and clearable by nothing while it is true.

  **What that leaves, executed rather than assumed.** The durable half only
  bites where a checkpoint PRECEDED the destruction and where the destroyed
  ledger had rows to lose: a ledger that was empty anyway commits no mark, and
  the local-first cadence is what keeps the window short (every CLI command is a
  new process, and every construction that finds nothing blocking commits). A
  ledger HQ itself keeps writing to can also climb back ABOVE its committed mark
  — `op_evidence` does, within a few boots — after which only the content-bound
  chain commitment still contradicts it. So for a subset erasure that leaves
  `hq_integrity_checkpoints` and `op_evidence` alone, that destroys only ledgers
  with no rows, or that happens before HQ has ever committed, the boot that
  observed the drop and the process it belongs to are still the only reporters:
  safe mode is engaged and recorded, a restart does not clear it, but a full
  assessment in a LATER process does. Measured on the exact reviewer scripts:
  with a checkpoint in place, a total erasure that spares the checkpoint ledger
  stays blocking through three further processes and three further Founder
  assessments; without one, or with the checkpoint ledger dropped too, the
  second process's assessment clears it — `p2 boot=true assess=true
  release=refused`, then `p3 boot=true assess=false release=ADMITTED`. (Measured
  before round eleven's header mark. With the checkpoint ledger dropped it no
  longer clears at p3 or ever: see round twelve's Medium 4 in the residual list,
  which also records what that costs an operator who lost the ledger by
  accident.) Dropping
  a declared ledger that held NO rows is in the same position and always will
  be: there was no high-water mark to commit to, and nothing was destroyed.
- The verdict ledger is durable only where it EXISTS: a database written before
  this wave, or a read-only handle over one, carries no `hq_reliability_verdicts`
  table and the verdict is process-local there. `SAFE_MODE_STATEMENT` says so.
- ~~A writer that already holds a writable handle can APPEND a `safe_mode = 0`
  verdict~~ — **CLOSED in the third correction round (Medium A7)**, because the
  sentence `SAFE_MODE_STATEMENT` ships on every view said it could not. A
  verdict that says ENGAGED stands whoever appended it; a verdict that says
  CLEAR counts only when the hash-chained evidence log carries the entry naming
  it, which the two writers of a verdict append inside the same reservation.
  What remains is stated on `standingIntegrityVerdict`: HQ holds no key a
  foreign writer does not also have, so a writer holding the file open can forge
  the evidence entry too — at the cost of appending to a chain that is now
  engine-guarded and length-committed. A real barrier, not a cryptographic
  boundary, and the same residual class as the run-event ledger above.
- **An HQ database file created before this wave engages safe mode once, on its
  first boot afterwards**, because `trg_hq_mission_plan_items_no_erase` did not
  exist in it and the as-found census observes it missing. The finding is true
  rather than spurious; one Founder full assessment clears it — and "clears it"
  is the right phrase for THIS case, where a guard was missing and HQ's ensure
  pass genuinely repaired it, in a way it is deliberately NOT the right phrase
  for a file whose ledgers were destroyed (see the dropped-ledger item above,
  which the fifth correction round separates from these). Since the verdict
  ledger survived this merge, that first boot also RECORDS the engagement, so it
  now persists across restarts until that assessment — stronger, and stated here
  rather than discovered in operation. A fresh file is unaffected.
- **The third correction round adds two more first-boot cases of exactly that
  kind, for exactly that reason.** `op_evidence` now carries the append-only
  guard trio, and those triggers are installed by the facade's ensure pass
  rather than by `migrateHqDatabase` — deliberately, so that a DROPPED guard is
  OBSERVED before it is repaired. A file that has never been opened by a writer
  of this build therefore does not carry them, and the as-found census says so
  once. The same holds for a CLEAR verdict recorded by an older build, which
  carries no paired evidence entry and so no longer clears a blocking verdict
  standing behind it. Both are the fail-closed direction and both are cleared by
  one Founder full assessment.
- **The fifth correction round adds one more first-boot case, for the same
  reason, and it costs TWO Founder assessments rather than one.**
  `hq_integrity_checkpoints` is a newly declared engine-immutable LEDGER, so a
  file no writer of this build has opened does not carry it and the as-found
  census says so once. Clearing it is not one assessment, and the sixth
  correction round corrects that sentence rather than the code: a ledger this
  process found absent and re-created is deliberately carried into
  `fullIntegrity` for the whole life of that process — which is what stops a
  DESTROYED ledger being laundered by re-creating it empty — so the first
  process's assessment reports it again and refuses. It takes a RESTART and a
  SECOND Founder full assessment, in a process that opened a file already
  carrying the ledger. Measured on such a file: `p1 boot=true assess=true
  release=refused`, `p2 boot=true assess=false release=ADMITTED`, `p3 boot=false`.
  A newly declared GUARD is still one assessment — `q1 boot=true assess=false
  release=ADMITTED` — because re-creating a trigger genuinely repairs the file's
  guard set. **The asymmetry was NOT narrowed to "genuine upgrades only",
  because the discriminator that would need does not survive forging.** The only
  durable marks separating "a ledger this build newly declares" from "a ledger
  destroyed" are `PRAGMA user_version` and the checkpoint commitments; both are
  ordinary writable content of the same file, so a writer who drops a ledger and
  stamps an older schema generation walks into the benign branch, and for the
  commitment ledger itself no commitment survives its own destruction to appeal
  to. Making the code match the old sentence would have made the residual above
  CHEAPER, which is why the sentences moved instead. The `PRAGMA user_version` mark
  also changed value in that round — it is now HQ's own distinctive constant
  rather than `1`, read as an exact member of a closed set — so a file stamped
  by an earlier build of this wave reads as unmarked until its next writable
  construction re-stamps it; the ledger half of the discriminator answers for it
  meanwhile.
- **A READ-ONLY handle over such a file cannot clear either**, because it
  creates nothing and assesses nothing. `hq:snapshot` over a database that no
  writer of this build has opened will report `append_only_guard_missing` until
  one has. Open it once with a writable HQ command first. The fifth correction
  round makes that refusal explicit rather than an exception: `assessHqIntegrity`
  through a read-only handle used to reach the verdict append and throw the
  engine's `SqliteError: attempt to write a readonly database` out of the facade,
  and it now returns an `invalid_input` refusal saying why. Not reachable from
  any shipped command — only `cli/snapshot.ts` builds a read-only facade and it
  never assesses — but the facade's own rule is refusals, not exceptions.
- **A foreign `PRAGMA user_version` is no longer read as HQ's mark** (fifth
  correction round, Low 1). `user_version` is the conventional
  application-schema slot and HQ has claimed it; reading "any non-zero value" as
  HQ's own meant a file another application had stamped `user_version = 7`
  booted `safeMode: true ["append_only_guard_missing"]` on first contact, with
  every declared ledger reported absent from a database nothing had tampered
  with. Only HQ's own constant counts now. The residual is unchanged in the
  other direction and stated where it is read: HQ still OVERWRITES whatever was
  in that slot when it ensures a file, so a foreign application's version
  number is lost if HQ is ever pointed at its database.
- Recovery's liveness correction is a REPAIR path, not a prevention.
- A MODEL-scoped ceiling does not govern a decision write, because nothing in
  canonical truth binds a task to a model.
- WHICH file an operator may point `verifyHqBackupFile` at is not a question it
  answers; a symlinked ancestor is resolved and RECORDED rather than refused.
- `file_too_large`, `path_not_readable` and `verification_copy_failed` are
  asserted by construction rather than by being crossed.
- `verifyHqBackupFile` now writes a full copy of the candidate into the OS temp
  directory, so verification needs free space equal to the file and is slower.
- `file_has_multiple_links` refuses on `nlink > 1` from the opened descriptor,
  and that is DELIBERATELY broader than "is this the live database". The
  refusal was added because a hard link to the live inode under a name with no
  sidecars beside it passed, and the check that catches it cannot know which
  other name is on the other end of the link. Two costs are accepted rather than
  narrowed, and they are real: anyone who can create a hard link in the backup
  directory can make an already-recorded backup unverifiable — a
  denial-of-verification, never a false pass — and a hardlink-based rotation
  scheme (`rsync --link-dest`, borg and the like) is refused wholesale, so HQ
  backups must be verified from a file that carries exactly one name. Narrowing
  it to "the same inode as the live database" was considered and rejected: it
  would weaken the standing assertion that a verified backup is a file no other
  name can be written through, and it would make the answer depend on which
  database HQ happens to have open rather than on the candidate's own bytes.
- The credential-shape scan folds away invisible/zero-ink characters, NFKC
  compatibility forms, and Cyrillic and Greek Latin-lookalike letters. It is NOT
  a Unicode confusables implementation: a lookalike drawn from Cherokee,
  Armenian, Coptic, Lisu or any other script still defeats the shape while
  leaving the credential intact. The two folded scripts are the ones homoglyph
  substitution is actually written in; the rest is disclosed rather than
  claimed. Ordinary whitespace is deliberately not folded either — a space
  inside a credential is a break a reader can see, and folding it would start
  matching prose. The fold's one visible cost, stated rather than left to be
  discovered: Greek `ΤΟΚΕΝ` folds to `TOKEN`, so Greek text of the form
  `ΤΟΚΕΝ: ********` is refused by the free-text `key: value` heuristic exactly as
  the English `TOKEN: ********` already is.
  **The reason ordinary Cyrillic prose is safe from the same cost changed at the
  reconciliation, so the reason is restated rather than carried.** One lane
  bounded it by OMISSION — it deliberately left Cyrillic `к`, `м`, `т`, `в`, `н`
  and `г` unmapped, so no Cyrillic string could fold into an English keyword at
  all. The surviving map is the other lane's, which IS shape-faithful for those
  letters, so that impossibility no longer holds and is not claimed. What holds
  instead is the faithfulness itself: `с` folds to `c` and not `s`, `н` to `h`
  and not `n`, `р` to `p` and not `r`, so `СЕКРЕТ` folds to `CEKPET` and `токен`
  to `tokeh`. Computed over the whole modern Russian, Ukrainian and Serbian
  alphabets, the ASCII letters the merged map can produce from them are exactly
  `abcehijkmoptxy` — and `apikey` (with `api_key`/`api-key`) and `cookie` are
  the ONLY two keywords whose every letter is in that set, so `арікеу` and
  `соокіе` do fold onto them. Neither is a word in any of those languages; both
  are homoglyph spellings of an English credential keyword, which is precisely
  what the fold exists to catch, and both are field-NAME keywords where a
  refusal is the right answer. `live-redaction.test.ts` pins the boundary from
  both sides rather than leaving it argued.
- A credential split across two search fields still passes both scans.
- **The strict scan REFUSES ordinary Founder prose that the weak heuristic
  accepted, and that cost is disclosed here rather than left to be discovered**
  (Wave 5 correction round seven, Low 1). Round four's disclosure said "nothing
  that used to be refused is now accepted" — true, and only half the trade. Two
  shapes carry the other half, both executed: `Bearer\s+[A-Za-z0-9._-]{16,}`
  refuses "The bearer responsibilities were reassigned to the shift lead", and
  `sk-[A-Za-z0-9_-]{16,}` refuses "Contract with Addis-Sk-Trading-Corporation
  renewed for 2027" — a plausible Ethiopian business name in a product whose
  first tenant is an Ethiopian salt factory. The answer is `invalid_input`,
  there is no override, and rephrasing is the only remedy. The patterns were
  deliberately NOT loosened: this is the SAME function the read boundary
  applies, so admitting the prose would loosen what may be published as well as
  what may be stored, and every candidate discriminator was a real weakening of
  a fail-closed backstop — "require a digit in the run" admits a real 16-character
  all-letter token about 6.6% of the time, and "require a longer run" only moves
  an arbitrary boundary. `credential-scan-cost.test.ts` pins the exact refused
  sentences and the near misses that are still accepted, so this disclosure is
  enforced by the suite and a future tightening has to move it rather than
  quietly change the trade.
- A `cp` of a live WAL-mode database is a copy of an arbitrary prefix of the
  truth, and HQ cannot tell you so from the bytes. **The claim that it "still
  verifies, and always will" was too strong in BOTH directions and is corrected
  here (Low L8):** executed, a `cp` of a live but UNCHECKPOINTED store was
  REFUSED `not_an_hq_database` with `schemaTables: 0`, because everything
  including the schema was still in the `-wal`; only after
  `wal_checkpoint(TRUNCATE)` did the copy verify. So such a copy may read as
  sound, as empty, or as not a database at all, depending on where the
  checkpoint boundary fell. `verified` means "these bytes are a sound HQ
  database" and has never meant "this is the whole of what was committed when it
  was taken". A hard LINK to the live database is refused
  (`file_has_multiple_links`); a copy of it is not, and cannot be.
- A forged decision row can still understate complexity, context size and work
  kind.
- A raw appender can still widen a budget by appending a higher-version row.
- The independence check in `reconcileRun` is unreachable through the worker
  path (kept as defence in depth), `listRuns` derives every record per call, a
  run cannot be corrected in place, and nothing here has been exercised by a real
  AI worker lane.


## The FOURTH correction round: what three independent hostile reviews reproduced

Three read-only reviewers re-read the third-round head (`22680ba`) by EXECUTION
and returned 1 Critical, 3 High, 9 Medium and 8 Low across Phases 13 and 14.
The Phase 13 half is below; the Phase 14 half is in that phase's document. All
six findings from the previous round were re-verified CLOSED by mutation.

**A SECOND, concurrent lane reviewed the same head `22680ba` and corrected it on
this same branch**, without either lane knowing about the other — the fourth
time that has happened on this branch. It returned 0 Critical, 2 High and 3 Low,
and it reached two of the same defects by a different and in places better
route. Both lanes are reconciled here; the table below carries the merged
answer, and the section "The fourth round's two lanes, reconciled" at the end of
this document records what survived from each, what was dropped and why, and
which regression tests were ported.

| Finding | What was reproduced | What changed |
|---|---|---|
| **CRITICAL C1** — a credential hidden by a control character, a hyphen homoglyph or a word-character prefix reached the UNAUTHENTICATED `hq-snapshot.json` | `\p{Cc}` is neither `\p{Cf}` nor `\p{Default_Ignorable_Code_Point}`, so the strip whose comment claimed to "hold for code points nobody enumerated" was blind to an entire block. One fresh fixture per row through `liveSnapshotFromOperations`: a plain `sk-…` correctly REFUSED the artifact, while U+0001, U+001F, U+007F, U+0090, U+2010 and `OPENAI_KEY_sk-…` each CARRIED the credential onto it. `\b` is a boundary between a word character and a non-word character, and `_` is a word character. At unit level, a credential in a `Map`, a `Set` or behind a `toJSON`, and a key-name homoglyph (`арiKey`), were all invisible to the walk. | `\p{Cc}`, `\p{Zl}` and `\p{Zp}` join the erased set (`\p{Zs}` deliberately does not — a space is visible, and erasing it fabricates refusals out of ordinary prose); the hyphen family folds to ASCII `-` before the erase; every `\b` becomes `(?<![A-Za-z0-9])`, which treats `_` as a boundary while still refusing to fire inside a letter run; the walk follows `toJSON`, `Map` (keys as key names) and `Set`, with a cycle set and a depth bound; the key rule reads the normalized name; and U+2800 BRAILLE PATTERN BLANK joins the erased set from the OTHER lane's Low 2 — it is `So`, so it was in none of the properties named above and it split `sk-…` in two while leaving every character of the key present, which is why the class is stated as zero INK rather than zero width. The constant's false comment is corrected in place. |
| **HIGH H1** — the evidence hash chain still did not detect DESTRUCTION | `DROP TABLE op_evidence` read CLEAN at both depths — `safeMode: false`, `observations: []`, `chainVerified: true` — over an audit log destroyed and rebuilt empty, and CLEARED an already-latched safe mode and re-admitted `releaseKillSwitch`. Root cause was ORDERING: `op_evidence` is created by `migrateHqDatabase`, which runs BEFORE the facade census, so the absent-table check could never see it absent (raw-view `absentImmutableTables` = `["op_evidence"]`; after `openHqDatabase()`, `[]`). | Two independent holds, because every existing hold lived inside the thing being checked. (1) `migrateHqDatabase` records the table names the file carried before it touched it, and the census asks that record for the migration-created ledgers; "established" is judged on the PRE-migration catalogue too, so a fresh store's first boot is not a false finding. (2) HQ COMMITS to the chain tip (`seq` + `hash`) it observed, in an append-only ledger of its own, and both depths check the log still carries that entry with that hash. A rebuilt log cannot satisfy it — satisfying it means replaying the prefix that was destroyed. **The lane that raised H1 put that commitment on the verdict row (`evidence_tip_seq` / `evidence_tip_hash`); the fifth round put it in `hq_integrity_checkpoints`, and the reconciliation kept the checkpoint and retired the verdict-row columns** — see the boundary item in the NOT-fixed list for the three merits and the one cost. The hold H1 named is intact; only where it is recorded changed. |
| **MEDIUM M1** — a latched safe mode cleared by two raw inserts | `verdictIsCorroborated` matched `kind` plus `json_extract(payload,'$.verdictId')` and nothing else, so the corroborating evidence row needed NO valid hash: one clean verdict row plus one forged corroboration gave `safeMode false []` and `releaseKillSwitch {"ok":true}` with the chain genuinely broken. | Corroboration now requires the entry to be a genuine LINK: its own hash correct over its stored fields, and its `prev_hash` equal to its predecessor's. That closes the forged-row route. It does NOT close an append by a writer holding the file — HQ holds no key such a writer does not also have — so `SAFE_MODE_STATEMENT` says that in words instead of asserting a boundary the code cannot hold. |
| **MEDIUM M2** — `sqlite_sequence` unguarded and uncensused | See the corrected entry in the NOT-fixed list above. | The durable chain-tip commitment, in a ledger that IS guarded and IS censused — `hq_integrity_checkpoints` after the reconciliation, `hq_reliability_verdicts` in the lane that raised M2. |
| **MEDIUM M3** — a Founder assessment LAUNDERED a boot-observed ledger loss | `assessHqIntegrity` passes no `immutableTablesAbsentAsFound` (correctly — it asks about the file as it NOW stands, which is the only way a latch clears) and is the only latch-clearing path, so a dropped ledger observed at boot was cleared with nothing durably recording that rows had gone missing. | The boot observation appends an `hq_immutable_ledger_absent` evidence entry naming the ledgers, unconditionally on the standing verdict. The latch still clears — the file as it stands is sound — and the LOSS outlives it, in the append-only log. Declared table names only, so the entry can never become a channel for stored content. |
| **MEDIUM M4** — four false shipped claims about the audit log's protection | `evidence.ts:122-124` ("a dropped `op_evidence` is caught by the census … the check that can actually see it"), `evidence.ts:15-17`, `integrity.ts:265-269`, and this document's "Three independent holds". | All four corrected in place, each saying what is actually true and why the previous sentence was not. |
| **MEDIUM M7 / M8** — closed vocabularies still unfrozen, and the pinning test only looked at three modules | 82 of the 202 exported ALL-CAPS object/array bindings reachable through this package's own entry points were mutable. `FABRICATED_FIELD_NAMES.length = 0` published a fabricated `costUsd` through the snapshot's fail-closed gate; `STATE_CHANGING_METHODS.length = 0` turned a refused cross-origin non-JSON POST (`403 content_type_not_json`, no write) into an accepted `201` that WROTE a budget row. The test that claimed to "enumerate the package" scanned three modules for two name suffixes. | All 82 frozen through the one `deepFreeze` helper. The pinning test imports every entry point in `package.json#exports` and asserts NO exported ALL-CAPS object or array is unfrozen — no name filter, so a constant added tomorrow is covered the day it is exported. Two exploit-level assertions sit beside it. **“A constant added tomorrow is covered the day it is exported” was true only of a module that IS re-exported** (round seven, Medium NEW-5): the entry-point scan cannot see a module `package.json#exports` does not reach, and the unfrozen count regrew to 26 distinct bindings over 225. The census now enumerates `src/` itself (`test/frozen-constants-census.test.ts`, 131 modules excluding `src/cli/**`, deduped by object identity). The load-bearing one was `PROJECT_ALLOWED_TRANSITIONS`, the gate behind `canTransitionProject`: `.active.length = 0` flips `canTransitionProject('active','closed')` true → false, which is NARROWING — a local denial of service on a Founder act, not an authority widening, and it is stated as that rather than dressed up. The other 24 are `ui/spatial/*` floor geometry and presentation maps, `providers/codex/*`'s two closed vocabularies and review schema, `providers/claude/*`'s evidence-kind map and repo-slug pattern, and `ui/control-console.ts`'s fetch allow-list: none is an authority gate, and all are frozen anyway. |
| **MEDIUM NEW-5 (round seven)** — `deepFreeze`'s “It freezes ALL THE WAY DOWN” was not true of a `Set` or a `Map` | A collection's ENTRIES are not own properties, so `Reflect.ownKeys` never reaches them and `Object.freeze` does not touch them. `QUEUED_UNREACHABLE_STATUSES` — read by `service.ts` to decide whether a queued task is reachable — accepted `.delete()` and `.add()`; `QUERY_STOPWORDS` accepted `.clear()`. Same class as `ENGINE_IMMUTABLE_TABLES.length = 0`: a closed vocabulary a decision is keyed by, narrowed without touching one frozen property. | A frozen collection is now frozen in CONTENT — **and round seven's answer to this was NOT enough, which round ten (Medium 2) corrects rather than restates.** Round seven installed own, non-configurable throwing `add`/`set`/`delete`/`clear`, and an own property shadows the prototype for DIRECT property access only: `Set.prototype.clear.call(x)` reads no property of `x` at all, it reaches the internal slot, and it emptied a `deepFreeze`d `QUEUED_UNREACHABLE_STATUSES` in one statement — the same cost as the `.clear()` the stubs had just refused. There is no way to make a REAL `Set` refuse that without patching `Set.prototype` for the whole process, so `deepFreeze` no longer hands out a real `Set`: it hands out a `Proxy` over one, and the raw collection is closed over and never escapes. A `Proxy` carries no [[SetData]] slot, so the prototype spelling now throws `TypeError: Method Set.prototype.clear called on incompatible receiver`. `forEach` had to be rewritten rather than forwarded — it hands its callback the collection as a THIRD argument, and forwarding the raw target there was a one-statement escape, found by execution before it shipped. Reading is untouched: `has`, `get`, `size`, `forEach`, `keys`/`values`/`entries`, `for…of`, spread, `Array.from`, the ES2025 set-composition methods, `instanceof Set` and `Object.isFrozen` all behave as before. Measured cost: a bare `.has()` is about 15 ns direct and about 38 ns through the view; the package has two frozen collections and two call sites, one `.has()` per task and one per query token, so the added cost is bounded by a few microseconds per search. The test title that claimed CONTENTS while asserting only the four shadowed properties now executes the prototype spelling, the `forEach` escape, a nested collection and a self-referential one. |
| **MEDIUM M9** — `RETRIEVAL_GUARD_STATEMENT` made false by one line | The raw adapters are module-private and `SEMANTIC_RETRIEVAL_ADAPTERS` is frozen, but `LEXICAL_RETRIEVAL_ADAPTER` was a bare object literal: the wrapper could be replaced IN PLACE and an untokenized credential term delivered unscanned. | Frozen, and the shipped sentence says "wrapped AND frozen". The facade scan remains the stated real guarantee. |
| **LOW L5 / L6 / L7 / L8 / L9** | `BACKUP_RECORD_STATEMENT`'s "the path is never resolved a second time" (it is resolved four more times before the open); `SAFE_MODE_STATEMENT` claiming safe mode refuses everything that ADDS to the record (`createTask`, `proposeMission`, `appendSystemEvidence`, `recordVerifiedBackup` and `engageKillSwitch` all add rows under a latch, each deliberately); `chainVerified: true` published over a log that was never verified against anything; the `cp` claim; and a NUL-byte census scoped to `src/` under a claim about the whole package. | Each sentence corrected to what the code does. `chainVerified`'s doc now states exactly what a `true` still fails to distinguish and how the tip commitment bounds it to "a file nothing has happened on yet". After the reconciliation `chainVerified` reads `brokenAt === null` alone, because `verifyEvidenceChain` itself ends on the commitment check — the bound is the same one, reached without an argument the caller had to remember to pass. The NUL fixture in `test/connectors.github.test.ts` is spelled with a unicode escape — identical runtime value — and the census is widened to every TypeScript file in the package. |

### Verification actually run for the fourth round

| Command | Result |
|---|---|
| `npm run test:hq` | 164 files, 3168 passed, 0 failed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root, `@factoryos/server`) | 37 files, 569 passed, 3 skipped |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |
| `npm run build` | all workspaces built; web initial JS 215.66 kB / 69.22 kB gzip (unchanged) |

The six Phase 13 test files hold 179 tests at Lane A's head:
`reliability-core` 32, `reliability-authority` 51, `reliability-surfaces` 19,
`reliability-durability` 41, `reliability-crash-recovery` 12,
`reliability-verdict-durability` 24. At the MERGED head they hold 184, the five
extra all in `reliability-durability` (46): four ported from the other lane and
one new at the merge. The three skipped tests under
`packages/server` are pre-existing `it.skip` GAP markers, untouched.

**Every fix in this round is pinned by a test that was VERIFIED to fail against
the pre-fix source**, by reverting the changed module in a scratch copy and
re-running: 5 unit + 1 end-to-end for C1, 5 for H1/M1/M2/M3, 2 for M7/M8/M9
(the enumeration reports all 82 unfrozen bindings by name), 1 for L9, and the
`SAFE_MODE_STATEMENT` clause assertions for L6. That verification is required
because the previous round shipped a vacuous test, and it is why a finding
survived it.

### What the fourth round adds to the NOT-fixed list

- **A credential SPLIT across two sibling fields or two array items is still not
  detected**, and this is a decision rather than an oversight. Catching it means
  concatenating sibling values and scanning the join, which fabricates matches
  out of ordinary text — `['task', '-oriented-workflow-item']` would be refused
  as an OpenAI key. Every candidate rule was a worse trade than the hole. It is
  stated on `assertBrowserSafe` itself.
- **Round seven closed two UNDISCLOSED classes of the zero-ink sweep, and
  re-states the third.** The set named five properties and two code points and
  argued `\p{Zs}` out on the merits, but `\p{Mn}` non-spacing marks (2,059 code
  points), `\p{Me}` enclosing marks (13) and `\p{Cn}` unassigned (814,730) were
  in neither the set nor any residual list. Each broke
  `sk-ABCDEFGHIJKLMNOP0123` into two unmatched halves with every character of
  the key intact; U+0301 and U+0378 are the two the review named, and both were
  disclosed nowhere. A combining mark is exactly the class this scan exists for
  — it leaves the credential complete and a reader strips the mark — so both are
  CLOSED rather than disclosed: marks are removed from an `NFKD`-decomposed copy
  BEFORE the pipeline runs (because `NFKC` composes base + mark into a
  precomposed letter, which is `Lu` and no longer `Mn` by the time the erase
  runs), and all three categories join the erase set as well. Measured after the
  fix: 1,809 marks swept, 0 survivors; 815 sampled unassigned code points, 0
  survivors. False positives are measured rather than assumed — accented prose
  in five languages plus every legitimate string the shipped suite pins still
  pass, and the fold is a SCAN COPY, so what is stored and served is
  byte-unchanged. `\p{Zs}` is still not folded, on the argument that has not
  changed: a space is visible, so it hides nothing. **Corrected at round nine
  (High 1): this bullet's list of what round seven left open was FALSE.**
  `\p{Co}` PRIVATE USE — 137,468 code points, taking the identical argument to
  the `\p{Cn}` this bullet describes as closed — was open, and appeared in no
  residual list, no comment and no test. It is in the erase set from round
  nine, and after that fix `\p{Zs}` and the anchoring residual in the bullet
  below are the whole open list, derived from a whole-plane sweep rather than
  written down.
- **A prefix that runs straight into a credential shape with no separator at all
  (`KEYsk-…`) is still not matched.** `(?<![A-Za-z0-9])` deliberately does not
  fire inside a letter run, because `task-oriented-approach` literally contains
  `sk-oriented-approach`. Anchoring is a heuristic; the architecture —
  credentials never enter the control plane — is the guarantee. Executed and
  still open at round seven: `Xsk-…` and `9sk-…` reach a written
  `hq-snapshot.json`.
- **Round seven, Low NEW-7 — a source file the repository's own tooling could
  not read, and a fix from an earlier round that had not actually been
  applied.** `test/connectors.github.test.ts` carried a raw U+0007 BEL at byte
  4903 and a raw U+202E beside it, so `git diff` rendered it `Bin 9424 -> 9429
  bytes` — the exact hazard the NUL two characters earlier had been escaped to
  avoid. Both are escaped now and that change renders as one line out, one line
  in. The derived assertion that replaces the hand check
  (`test/source-text-hygiene.test.ts`, every `.ts` file in `src/` and `test/`)
  then found FOUR more raw U+001F separators in `src/application/
  product-command.ts`, `src/application/intelligence-command.ts` and
  `src/live/auth.ts` — each sitting under a comment from Wave 5 Medium 10
  claiming the separator had been written so "the file stays greppable". The
  comment described a fix that was not applied: git only treats a file as binary
  on a NUL, so the file was greppable, but the separator was still an invisible
  raw control character in source. All four are escapes now, same runtime value,
  and the comments say what the code does.
- **The chain-tip commitment is a barrier, not a cryptographic boundary.** A
  writer that already holds the file open can append a correctly-hashed entry,
  and can destroy `hq_integrity_checkpoints` and the evidence log together. **The
  sentence that used to stand here — that destroying both "is itself a census
  finding on the checkpoint ledger, since it is ensure-created and declared in
  `ENGINE_IMMUTABLE_TABLES`" — was FALSE, and executing it is what proved it**
  (round seven, Critical NEW-1): a writer who replays the dropped table's own
  DDL out of `sqlite_master` leaves nothing absent for the census to observe at
  all. That is now blocking, and the check that answers it does not live in a
  table: HQ stamps `PRAGMA application_id` once it has committed on a file, so a
  commitment ledger that is present and EMPTY on a witnessed file is blocking
  however it came to be empty. The residual is one further statement — `PRAGMA
  application_id = 0` — and it is measured and listed above rather than
  described as a boundary. HQ holds no key such a writer does not also have.
- **`chainVerified: true` still cannot distinguish "checked and sound" from
  "there was nothing to check" on one file: one that has never recorded a
  verdict AND whose log is empty.** Every other case is now bounded by the
  commitment. That file is one nothing has happened on yet.
- **`op_tasks.payload` remains mutable and uncensused.** A write-once guard on
  it was implemented and then withdrawn: eight existing hostile tests mutate the
  payload deliberately, to prove the approval-digest gate catches exactly that,
  and an engine guard would have made their scenario unconstructible. The Phase
  14 defect it was reached for is closed at the root instead — the provider
  ceiling no longer re-reads the payload for work that already happened; see
  `provider_bound` in that phase's document.
- **`hq_missions` and `op_evidence` first-boot cost.** `hq_missions` joins
  `ENGINE_IMMUTABLE_TABLES` with two new guards, so a file written by an earlier
  build observes them missing once, engages safe mode once, and is cleared by
  one Founder full assessment. This is the same documented cost every newly
  declared guard carries. A fresh file is unaffected.

## The fourth round's two lanes, reconciled

Two correction lanes worked on the frozen head `22680ba` concurrently, neither
knowing about the other, and both corrected it on this same canonical branch.
This is the reconciliation, and it follows exactly the principle the three
earlier reconciliations on this branch set: **nothing from either side is
discarded; where both sides fixed the same defect differently, ONE
implementation survives, chosen on the merits in the fail-closed direction, and
BOTH sides' regression tests are kept, ported onto the survivor with the reason
stated inline.**

- **LANE A** — seven commits (`22680ba..3d6a307`), from a three-reviewer sweep
  returning 1 Critical / 3 High / 9 Medium / 8 Low. It contributed the
  credential-scan class fix (C1), the write-scan/read-scan parity across all 29
  label and text write sites (H3), the freeze of 82 exported vocabularies with a
  pinning test that enumerates every `package.json#exports` entry point (M7/M8),
  the evidence-log DESTRUCTION detection (H1) — the pre-migration catalogue plus
  the durable chain-tip commitment in the verdict ledger with its new
  `evidence_tip_seq`/`evidence_tip_hash` columns — the budget derivation (H2)
  with `provider_bound`, `trg_hq_mission_plan_items_no_remission` and
  `hq_missions` under the census, the corroboration link check (M1), the
  laundered-ledger-loss evidence entry (M3), `RETRIEVAL_GUARD_STATEMENT` (M9),
  and the Low/doc corrections.
- **LANE B** — two commits (`af0232b`, `83e563e`), already on `origin`, from a
  separate fresh reviewer returning 0 Critical / 2 High / 3 Low. Narrower, and
  deeper on two Phase 13 items: the total-erasure census bypass (its High 1) and
  the evidence chain's laundered LENGTH (its High 2), plus U+2800 (Low 2), a
  curated Cyrillic/Greek lookalike fold (Low 3), and the `file_has_multiple_links`
  cost disclosed rather than narrowed (Low 1).

### The two shared defects, and what survives

**1. The evidence log's length and destruction (Lane A's H1 + M2 vs Lane B's
High 1 and High 2). BOTH SURVIVE, because neither subsumes the other**, and
that was checked rather than assumed:

- Lane B found that the high-water commitment was erased by the very next
  append — HQ's OWN boot appends were the laundering write, and the one Founder
  full assessment the residual list tells them to run then certified a robbed
  log as intact. Its fix requires the seqs present to be CONTIGUOUS from 1, a
  property of the record that no later write repairs. It also corrects a
  residual that claimed a `sqlite_sequence` rewrite was needed: none was.
  Contiguity holds with **no prior verdict on the file at all**, which Lane A's
  commitment cannot do, and it is silent on a log DROPPED and recreated whole,
  because the seqs then restart at 1 with no gap.
- Lane A found that `DROP TABLE op_evidence` plus a rebuild read
  `safeMode: false`, `observations: []`, `chainVerified: true` at BOTH depths
  and CLEARED an already-latched safe mode. Its fix is the pre-migration
  catalogue plus a chain-tip commitment recorded OUTSIDE `op_evidence`. That
  survives a drop, which contiguity cannot, and it says nothing until HQ has
  recorded a commitment.

  Together they leave no window: a tail delete followed by any number of appends
  fails contiguity, and a whole-log rebuild that restores contiguity fails the
  commitment. Both are stated as holds 3 and 4 in `operator/evidence.ts`, with
  the boundary between them written down rather than implied.

  **Where the commitment is recorded changed one round later.** Lane A put it on
  the verdict row (`evidence_tip_seq` / `evidence_tip_hash` on
  `hq_reliability_verdicts`, read with a `MAX`); the fifth round's lane put it in
  a dedicated `hq_integrity_checkpoints` ledger. The next reconciliation kept the
  checkpoint and RETIRED the verdict-row columns, their reader
  `evidenceChainCommitmentBreach`, the `evidenceCommitmentBreachAt` injection
  into `structuralIntegrity` / `fullIntegrity` and the exported
  `evidenceChainTip` that fed them — see "The round-five reconciliation" below
  for the three merits, the one cost, and the tests that were ported.

**2. The first-boot discriminator (Lane B's High 1 vs Lane A's H1, first half).
BOTH SURVIVE, and the merge had to close the seam between them itself.**

- Lane B found the inversion that mattered most: **more damage bought less
  detection.** The discriminator read "does this file still carry an
  ensure-created declared ledger", so dropping a SUBSET was reported and
  dropping ALL of them emptied the set, read as a fresh file, and returned zero
  observations at BOTH depths — while workers, capabilities, principals, tasks,
  approvals and the kill switch all survived and `releaseKillSwitch` was handed
  back. Its fix is a mark stamped into `PRAGMA user_version` after the ensure
  pass: it lives in the database header, no `DROP TABLE` reaches it, and
  `VACUUM` preserves it. A content check over the tables was tried and REJECTED,
  with a test pinning that direction, because HQ's own components legitimately
  write rows to a fresh file before the facade is constructed over it.
- Lane A found the ordering hole in the other direction: `op_evidence` is
  created by `migrateHqDatabase`, which runs before the facade census, so that
  one ledger could never be seen absent. Its fix asks the PRE-migration
  catalogue.
- **The seam.** Composed naively, the widest attack — drop every declared ledger — reports the
  other thirty ledgers and stays SILENT about the audit log itself, the one
  thing it destroyed, because Lane A's function judged establishment on the
  pre-migration ledger catalogue and that attack empties it. Reading Lane B's
  mark as it STANDS does not fix it either: `recordHqSchemaEnsured` stamps at the
  END of a facade construction, so a SECOND facade over the same handle sees a
  mark this very process just wrote and reports `op_evidence` as a lost ledger on
  a brand-new store. Executed during this merge, exactly that put nine suites
  into safe mode. The mark is therefore recorded AT MIGRATION TIME, beside the
  table catalogue and in the same `try`, by `schemaEnsuredMarkBeforeMigration`,
  and the census asks the state of the file as HQ found it for both facts. One
  definition of "established", two readings of it, taken at one instant.

**3. The lookalike fold (Lane A's C1, key-name half, vs Lane B's Low 3). LANE
A'S IMPLEMENTATION SURVIVES; Lane B's entries are folded into it.** Both lanes
shipped a Cyrillic/Greek fold; one map survives, because two confusable tables
are two spellings of the same truth. Lane A's is broader — it also folds the
hyphen family, the C0/C1 control block, `\p{Zl}`/`\p{Zp}` and U+034F, and it
carries the `toJSON`/`Map`/`Set` walk and the `(?<![A-Za-z0-9])` anchor that
Lane B's lane did not touch — and a wider fold is the fail-closed direction for
a credential scan. Lane B reached four code points Lane A did not (`Ү`, `Ԛ`,
`Ԝ`, `ϲ`) and one erased character Lane A did not (U+2800, which is `So` and so
in none of Lane A's named properties); all five are carried onto the survivor.
**Lane B's BOUND does not carry across, and it is replaced rather than
restated**: that lane bounded false positives by OMISSION — deliberately leaving
`к`, `м`, `т`, `в`, `н`, `г` unmapped so no Cyrillic string could fold into an
English keyword at all — and the surviving map is shape-faithful for those
letters. The bound that actually holds for the merged map is computed and
disclosed in the residual list above, and pinned from both sides by
`live-redaction.test.ts`.

**4. The key rule reading the normalized name.** Both lanes made the identical
change. Lane A's `namesACredentialHolder` helper survives as the single spelling,
because the rule is asked in more than one place; Lane B's inline reason is
carried onto it.

### Tests ported

Nothing was deleted, skipped, weakened or narrowed to make this merge green. No
`.skip`/`.only`/`.todo`/`xit`/`xdescribe` was added anywhere, and no `as any`,
`@ts-expect-error` or `eslint-disable` appears in any added line.

- Lane B's `refuses a credential broken by a zero-ink character that is not
  default-ignorable` (U+2800) — kept whole, ported onto the merged
  `ERASED_CODE_POINTS`, with the reason it is not `Cc` either stated inline.
- Lane B's `refuses a credential whose prefix is spelled with Cyrillic or Greek
  lookalikes` — kept whole; it holds unchanged against the merged fold.
- Lane B's `keeps accepting ordinary Cyrillic, Greek and other-script prose` —
  kept whole, with its REASON rewritten inline: the omission argument it was
  written against is not the surviving map's property, and what it actually pins
  is that prose is not turned into a refusal.
- Lane B's `reports EVERY declared ledger dropped, so widening the attack does
  not buy silence` — kept whole, and STRENGTHENED with one assertion neither
  lane could make alone: the finding now names `op_evidence` too.
- Lane B's `still reads a fresh file HQ has already written rows to as a first
  boot`, `keeps detecting a deleted entry after a later, perfectly well-formed
  append`, and `refuses to certify a robbed evidence log through the full
  assessment that clears a boot finding` — all kept whole and unchanged.
- Lane A's whole `reliability-verdict-durability.test.ts`, its C0/C1 sweep, its
  hyphen-family, word-character-prefix, ordinary-prose, `Map`/`Set`/`toJSON`,
  homoglyph-field-name and cycle tests, and everything else it changed alone —
  kept verbatim.
- NEW at the merge, because they pin properties neither lane had: `folds only
  the two credential keywords a modern Cyrillic alphabet can spell`, and `does
  not read its own schema mark as evidence that a fresh store lost a ledger`,
  which pins the seam described above.

## The round-five reconciliation: one witness, not two

The two concurrent lanes met again after the fourth-round merge. The other lane
had advanced by two commits — `4b0b546` ("Commit HQ to a witness that does not
live inside the record it verifies") and `bdec887` ("Say which half of the
census a full assessment can clear, and which it cannot"). Three files conflicted
textually: this document, `application/service.ts` and `operator/evidence.ts`.
Two more conflicted SEMANTICALLY, with no marker to warn about it, and the full
suite is what found them.

### The shared defect: two commitments to the same fact

Both lanes independently built "a record of how far the audit log reached, kept
outside the audit log". **One survives.** The checkpoint ledger does; the
verdict-row columns do not. Three merits, each a real difference:

1. **Fail-closed versus fail-open.** The verdict-row reader took
   `MAX(evidence_tip_seq)`. Appending to the verdict ledger is a write its trio
   deliberately permits, so a writer that rebuilt `op_evidence` as a LONGER
   coherent forgery could append one verdict committing to the forged tip; the
   `MAX` selected it and the genuine commitment behind it was never consulted
   again. `contradictedChainCommitment` checks EVERY commitment ever recorded and
   takes the per-ledger maximum, so the same appended row adds a satisfied row
   and removes nothing.
2. **Frequency.** A verdict is recorded only when a Founder assesses; a
   checkpoint is recorded at every construction that finds nothing blocking. The
   forger's window is one process lifetime rather than the gap between two
   Founder acts.
3. **Scope.** A checkpoint also carries every declared ledger's AUTOINCREMENT
   high-water mark, which is what `regressedImmutableLedgers` measures. The
   verdict-row commitment said nothing about any ledger but `op_evidence`.

**The cost, recorded rather than glossed:** two commitments lived in two ledgers,
so an attacker had to drop both to silence them. Now there is one ledger to drop,
which is exactly the residual measured in the NOT-fixed list at the time (`p2
boot=true assess=true release=refused`, `p3 boot=true assess=false
release=ADMITTED`). The
trade was taken because a barrier that a PERMITTED write can retire is not a
second barrier. Since round eleven that drop no longer clears at p3 or at any
later process; round twelve's Medium 4 re-measures it and states the operational
consequence, which is that an operator who loses that one ledger has no in-HQ
remedy at all.

**What was deleted with it:** `recordedEvidenceChainCommitment` and
`evidenceChainCommitmentBreach`, the `evidence_tip_seq` / `evidence_tip_hash`
columns and the `ensureVerdictChainCommitmentColumns` ALTER that added them, the
`evidenceTip` parameter on `appendIntegrityVerdict`, the
`evidenceCommitmentBreachAt` option on `structuralIntegrity` and `fullIntegrity`
and the second `evidence_chain_broken` observation it pushed, and the exported
`evidenceChainTip`. Each removal site carries a comment saying what stood there
and why it is gone, so the decision is findable where a reader would look for the
mechanism. `assessHqIntegrity` also returns to verdict → evidence → checkpoint
ordering: the fourth-round lane had put the evidence append first so the tip
stored on the verdict row would include its own corroborating entry, and the
checkpoint — written last — delivers that freshness without the reordering.

### The census-clearing distinction versus the ledger-loss record

`bdec887` and this lane's M3 answer different halves of one question and BOTH
survive. M3's answer is the `hq_immutable_ledger_absent` evidence entry: a
durable, append-only record naming which ledger disappeared, which outlives any
latch. `bdec887`'s (with round five's Medium 1) is that a full assessment may not
CLEAR the half it cannot repair — re-creating a trigger really does repair a
file's guard set, re-creating a table does not bring back its rows. M3's own
sentence "the clearing is still correct" was wrong and is corrected; its evidence
entry is untouched.

### The semantic seams, which no conflict marker showed

- **A cost entry now needs a declared identity.** `4b0b546` refuses an entry
  carrying neither `idempotencyKey` nor `occurredAt`, because HQ reading its own
  wall clock made every replay a new row. This lane's `route (c)` attribution
  test was written against the old behaviour and recorded a bare entry; it now
  declares `idempotencyKey: 'route-c-provider-spend'`. What the test exercises —
  that rewriting the task payload cannot nullify a charged provider ceiling — is
  untouched by which identity the entry carries.
- **`verifyEvidenceChain` is no longer silent on a coherent rebuild.** Two tests
  asserted `verifyEvidenceChain(...)` was `null` at the point where the attack had
  just been staged, documenting the pre-correction baseline. That function now
  ends on `contradictedChainCommitment`, so it refuses right there. Both
  assertions were inverted to `not.toBeNull()` with the reason inline — a
  strictly stronger statement of the same property, since the refusal no longer
  waits for a separate check the caller had to remember to make.
- **A dropped ledger is no longer clearable in the process that saw it.** The M3
  test asserted that the next assessment cleared the latch. It does not, and must
  not. The test now asserts the stricter behaviour, that `releaseKillSwitch` is
  refused under it, that the loss record still names the ledger — and, executed
  rather than asserted as prose, the honest residual: `hq_intel_budgets` carries
  no AUTOINCREMENT mark for the durable half to measure, so a RESTART plus a
  SECOND Founder assessment does clear it, with the loss record still standing.

### Tests ported at the round-five reconciliation

Nothing was deleted, skipped, weakened or narrowed. No `.skip`/`.only`/`.todo`/
`xit`/`xdescribe`, no `as any`, no `@ts-expect-error` and no `eslint-disable`
appears in any added line.

- `refuses a log that was dropped and REBUILT with its own three guards` — kept
  whole and ported twice: it now asserts `verifyEvidenceChain` itself refuses the
  rebuild, and it reads `chainVerified` off a `fullIntegrity` call that passes no
  commitment argument, because there is none to pass. Its detail assertion moved
  from the retired wording ("reached entry seq") to the surviving one ("commits
  the evidence log to an entry at seq"), asserting the same fact about the same
  seq.
- `catches a tail truncation that rewrites sqlite_sequence to hide itself` — kept
  whole, same porting, and it still proves that a laundering `UPDATE
  sqlite_sequence` buys nothing.
- `records WHICH ledger disappeared in the audit log, so clearing the latch does
  not erase it` — kept whole and STRENGTHENED: the clearing half is replaced by
  the stricter round-five rule, a refusal assertion is added, and the documented
  residual is now executed inside the test rather than only described.
- `route (c): rewriting the task payload the provider ceiling was derived
  through` — kept whole, ported onto the cost-identity rule.
- The other lane's `test/reliability-checkpoint-durability.test.ts` and
  `test/intelligence-cost-identity.test.ts` arrive whole and unchanged, as do its
  edits to `intelligence-attribution`, `intelligence-authority`,
  `intelligence-durability` and `intelligence-surfaces`.

### Verification actually run at the round-five merged head

| Command | Result |
|---|---|
| `npm run test:hq` | 166 files, 3192 passed, 0 failed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root, `@factoryos/server`) | 37 files, 569 passed, 3 pre-existing skips |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |
| `npm run build` | all workspaces built; web initial JS 215.66 kB / 69.22 kB gzip (unchanged) |

The round-four merged head was 164 files / 3177 tests. This lane's parent is that
head; the other lane's parent is 175 files / 3073 tests. The round-five merge is
**166 suite files / 3192 tests**, which exceeds both. Counted statically over
`packages/headquarter/test`, this lane's parent held 173 files / 2993 `it(`
declarations, the other lane's parent 175 / **2981** (re-measured in the sixth
round — the 2963 first published here was wrong, and the number exists to prove
nothing was lost, so its accuracy is the point; the miscount came from a
text-mode `grep` treating `connectors.github.test.ts` as binary because of the
raw control characters that round-six Low 6 has since escaped), and the merge
175 / 3008 — no
test file and no `it(` from either side was lost, and every per-file count on the
merge is greater than or equal to the same file's count on both parents.
`package.json` and `package-lock.json` stay byte-identical to the wave base
`f1ce71c`, no dependency was added, and the whole wave diff stays inside
`packages/headquarter/` and `docs/HEADQUARTER/`.

**Re-verified by execution at this head**, outside the suite as well as inside
it: dropping a SUBSET of the declared engine-immutable ledgers and dropping ALL
of them are both findings at BOTH depths, and the detail names `op_evidence` in
each case (`releaseKillSwitch` refused: `safe_mode_engaged`); a log dropped and
rebuilt with its own three guards is `append_only_guard_missing` +
`evidence_chain_broken` at both depths, with `missingImmutabilityGuards` empty
and `verifyEvidenceChain` returning the contradicted commitment; a tail
truncation followed by HQ's own laundering boot appends stays blocking across
two further processes and a Founder full assessment. The 15 credential disguises
and the ordinary-prose acceptance are pinned by `live-redaction.test.ts` (31
tests), the label-poisoning refusal on both the run and decision routes by
`reliability-authority.test.ts` and `intelligence-authority.test.ts` (103), the
three budget-ceiling nullification routes by `intelligence-attribution.test.ts`
(25), and the freeze enumeration by `freezes EVERY exported closed vocabulary in
the package, by enumeration`, which reports nothing unfrozen.

## The sixth correction round

Two fresh independent read-only reviewers re-read the round-five merged head
(`6a0f6ae`, exact-head CI green, 166 files / 3192 tests) by EXECUTION and
returned **0 Critical / 5 High / 7 Medium / 7 Low**. Every finding below was
reproduced first, at this repository, before anything was changed; every fix is
pinned by a regression test that was verified to FAIL against the pre-fix code
by reverting the fix, running the test, and restoring.

| Finding | What was reproduced | What changed |
|---|---|---|
| **HIGH 1** — the surviving witness ledger could be EMPTIED with no finding at any depth | Round five left `hq_integrity_checkpoints` as the only external witness for the evidence chain, protected by triggers only — and `operator/evidence.ts` already documented that a trigger dropped and re-created before the next boot is never observed missing. Three statements (`DROP TRIGGER ..._no_erase; DELETE FROM hq_integrity_checkpoints;` re-create) emptied it: both readers (`regressedImmutableLedgers`, `contradictedChainCommitment`) read the very rows deleted, so they returned `[]` and `null`. Executed — seed, one warm boot, attack, coherently rebuild `op_evidence` two committed entries short: boot `safeMode=false []`, full assessment `safeMode=false []`, `releaseKillSwitch` **ADMITTED**, no restart and no further Founder act. `sqlite_sequence.hq_integrity_checkpoints` still read 2 against 0 rows present, and nothing looked at it. | `truncatedImmutableLedgers` generalises the one comparison that already worked: `verifyEvidenceChain` has always checked `MAX(seq)` against `sqlite_sequence` for `op_evidence`, and that is why tail truncation is caught. It now runs over EVERY declared AUTOINCREMENT ledger, as `MAX(rowid)` versus the engine's own high-water mark, in `structuralIntegrity` — so both depths, at every construction, one b-tree seek per ledger. New blocking finding `append_only_ledger_truncated`; the finding vocabulary is 7 and the blocking list is 4. |
| **HIGH 2** — the same pattern made `RUN_RETRY_STATEMENT` false | `RUN_RETRY_STATEMENT` ships on every reliability view: "An interrupted attempt ... is NEVER retried automatically." Executed: open a run, take attempt generation 1, second attempt correctly refused; then empty `hq_reliability_run_events` the same three ways → boot clean, full assessment clean, **attempt ADMITTED at generation 1**. The guard this module calls "the single most load-bearing secondary guard in the schema" was back in place and reserved nothing, because its rows were gone. | The same one rule. The doc's residual for this ledger was written only about forged APPENDS, which is precisely the claim the erasure defeated. |
| **HIGH 3** — budget-ceiling nullification, fourth route | Phase 14 finding; see `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md`. | Two append-only columns holding EVERY derived scope, not one of N. |
| **HIGH 4** — `recordVerifiedBackup({note})` permanently bricked `GET /api/hq/control/reliability` | `service.ts` used `missionText('note', ...)` with NO credential scan, in a method the shipped claim covers BY NAME ("every facade write that stores caller text goes through `assertNoCredentialShape` — 29 call sites"). Executed with a real verified backup file: `GET /reliability` 200 → `recordVerifiedBackup({note:'ghp_...'})` ACCEPTED → `GET /reliability` **500 forever**; `DELETE`/`UPDATE` on `hq_reliability_backups` both refused as append-only; still 500 after a restart. This was the round-four H3 defect left standing at a write site the sweep missed. | The scan is applied, with a refusal message that says why the register cannot take it back. The coverage is DERIVED rather than counted: `credential-scan-coverage.test.ts` enumerates every member that calls `missionText` and names any that does not also scan, and `facade-write-scan.test.ts` derives the same property per (method, parameter) pair. **The second of the two hand counts that stood here was stale by round eleven (Low 4): "29 `missionText` methods" is still exactly right — measured again at that head — but "`assertNoCredentialShape` has 32 call sites" had been 47 for several rounds, and was 48 at the head of the round that removed it (49 at `582c239`, and **50** at the reconciled round-thirteen head measured here — it moves every round, which is exactly why it is derived rather than written down).** The number is removed rather than re-counted, because a present-tense count in a historical correction cell is a claim about the code that nothing checks; the two derived assertions are what the sentence now rests on. |
| **HIGH 5** — `MAX_SCAN_DEPTH = 64` was fail-OPEN and the module claimed the opposite | `redaction.ts` said the depth bound and the cycle set are "both fail-CLOSED ... they stop the walk descending, they never stop a finding being raised". `JSON.stringify` has no depth limit, so stopping the walk IS stopping the finding. Executed through `proposeAction`, which applies BOTH scans and whose own comment says the payload "is stored permanently and handed verbatim to an adapter": depth 60–63 refused, **depth 64 and beyond ACCEPTED and the credential stored**, and the strict scan on the response stopped at 64 too, so `GET /api/hq/control/actions` served it rather than failing. | Reaching the bound now THROWS `BrowserSafetyError`: HQ refuses what it cannot read in full. The cycle set still returns silently, and the comment now says why the two are different — `seen` stops at a value already READ, `depth` stops at one that has NOT been. |
| **MEDIUM 1** — `regressedImmutableLedgers` shipped load-bearing and covered by NO test | Mutating its body to `const regressed: string[] = []` passed the FULL suite (166/3192). Its only two assertions were `toEqual([])` on healthy files — no-false-positive checks that can only pass. | A hostile test that drops a declared ledger, lets HQ re-create it empty, restarts TWICE and proves the finding survives with `tablesAbsent`, `missingImmutabilityGuards` and `truncatedImmutableLedgers` all empty — so only the checkpoint's committed mark can answer. Verified to fail against the mutated body. |
| **MEDIUM 2** — the round-four seam's pinning assertion was vacuous | Deleting `\|\| schemaEnsuredMarkBeforeMigration(db) === true` from `migrationRestoredImmutableTables` passed the FULL suite. The assertion carrying an 8-line comment about the round-four RECONCILIATION was `expect(finding!.detail).toContain('op_evidence')` — and the same detail already lists the missing GUARDS `trg_op_evidence_no_erase/_no_replace/_no_rewrite`, so it matched regardless. | The assertion is now on `observeImmutabilityAsFound(db).tablesAbsent`, which is the list that reconciliation actually produces. Verified: with the clause deleted, the test fails on that line. |
| **MEDIUM 3** — "a missing verifier is treated exactly like one that threw" was untested | Correct that it was untested. **The review's proposed mutation does not reproduce a defect**, and that is recorded rather than repeated: replacing the ternary with a plain `null` leaves the guarantee standing, because the `try` then calls `undefined()`, throws, and the `catch` sets `'error'`. Measured. | A test that asserts the guarantee itself — `fullIntegrity` with no verifier reports `evidence_chain_broken`, blocking, `chainVerified: false`, and returns the SAME finding list as a verifier that threw; with no options argument at all it throws. Verified to fail when the `catch` is made to set `null`. |
| **MEDIUM 4** — two more unscanned caller-text write sites | `recordIntelligenceOutcome({note})` and `disableAiMember({reason})`. See the Phase 14 document for the first; both are the same class as High 4, latent rather than live because no read publishes those columns today. | Both scan. |
| **MEDIUM 5** | Phase 14 doc claim; corrected there. | — |
| **MEDIUM 6** — 26 exported closed vocabularies were unfrozen outside the `package.json#exports` surface | The entry-point measurement (202/202 frozen) was honest and the SURFACE was wrong: `package.json#exports` is a bundler's view, and any in-process code can deep-import — the running server does. A whole-package census found 26 distinct unfrozen module-level exported ALL-CAPS constants. Three are on enforcement paths: `providers/claude/transport.ts#REPO_SLUG_PATTERN` gates the real GitHub dispatch target and `.test` lives on `RegExp.prototype`, so assigning an own `test` turned `isValidTarget(hostile)` from `false` to `true`; `providers/codex/types.ts#EMPTY_EVIDENCE` is spread into EVERY codex evidence object, so mutating it seeds a fabricated `actualModel`/`cliVersion` into provider evidence; `CLAUDE_DISPATCH_EVIDENCE` names the kinds the duplicate-dispatch guard compares against. | All 26 frozen (`deepFreeze`, or `Object.freeze` for the RegExp). The pinning test now walks `src/**/*.ts` instead of the 16 barrels, checks DEEP as well as shallow, and asserts counts measured at this head: **604 exported ALL-CAPS bindings, 2103 objects reached by walking into them, 0 unfrozen at either level**. `src/cli/` is excluded because those modules run their work at import, and the test asserts from the source text that they export no `const` at all. The two enforcement exploits are pinned as behaviour, not only as `Object.isFrozen`. |
| **MEDIUM 7** — four identity-naming body keys were silently accepted | `live/auth.ts` states such a key is "REFUSED if any is present — not ignored, refused, so a client that believes it can name a principal learns immediately that it cannot". Executed: `requestedBy`/`principalId`/`actor`/`founderId` → 400 with the digest unchanged; `setBy`/`observedBy`/`recordedBy`/`issuedBy` → **201 with the digest CHANGED**. No authority effect — every actor a control route passes to the facade is `founder.principal.id` and the body field is never read — but `setBy`/`observedBy` are literally the facade's parameter names. | `setBy`, `observedBy`, `recordedBy`, `issuedBy` and `assessedBy` joined `CLIENT_IDENTITY_KEYS`. `workerId` was reported with them and is deliberately NOT there: on the workforce and collaboration routes it names the worker being acted UPON, not who is acting, and reserving it took eleven real behaviours out of the product — tried, measured, reverted, and recorded on the declaration. |
| **LOW 1** | `integrity.ts` still pointed the reader at `evidenceChainCommitmentBreach` — 1 reference, 0 definitions package-wide, deleted in the round-five merge. | Points at `contradictedChainCommitment`, and says what the old name was. |
| **LOW 2** | `integrityCheckpointLedgerPresent` and `HQ_INTEGRITY_CHECKPOINT_TABLE` were exported with no consumer outside their own module and no test. (The review said "zero consumers"; they have three in-module callers between them — corrected here.) | The function is module-private. The constant is exported and now has a test consumer. |
| **LOW 3** | `verifyHqBackupFile(<the live db path>)` returns `verified=true, refusals=[], tables=47` when no process holds the file open — SQLite removes `-wal` on a clean close, so `sidecar_journal_present` covers the live database only while HQ is running, and a Founder could register it as a verified recovery point between runs. | Closed, not merely stated: `verifyHqBackupFile` takes the live handle's own path and refuses `candidate_is_the_live_database`, both sides resolved through `realpathSync`, and `recordVerifiedBackup` always passes `this.#db.name`. |
| **LOW 4** | The page claimed parent 2 held **2963** `it(` declarations; it is **2981**. | Corrected, with the cause (a text-mode `grep` treating a fixture as binary — the same raw control characters as Low 6). All three counts re-measured: 2993 / 2981 / 3008, and the per-file monotonicity claim re-checked and still true. |
| **LOW 5** | Phase 14 suite property; corrected there. | — |
| **LOW 6** | `connectors.github.test.ts` carried a raw U+202E and a raw U+0007 inside a fixture string while the `\u0000` beside them was already written as an escape. | All four written as escapes. The file now contains no raw control character or bidi override at all. |
| **LOW 7** | `store/db.ts` recorded the pre-migration `user_version` mark as ANY non-zero value while `integrity.ts` read it against the CLOSED set `[0x48510001]` — two spellings of "HQ has been here" that disagreed on a foreign application's `user_version = 7`. The outer `established` gate absorbed it, so it was not exploitable; it was one refactor from being so. | ONE spelling: `HQ_SCHEMA_ENSURED_MARK`, `HQ_SCHEMA_ENSURED_MARKS` and `isHqSchemaEnsuredMark` live in `store/db.ts` and both readers use them. Pinned by a test that opens a file stamped `user_version = 7` by another application and asserts both readings say "not HQ's mark", and that a first construction over it is still silent. |

### What the sixth round adds to the NOT-fixed list

- **`sqlite_sequence` can still be written down.** The new truncation check reads
  the engine's own high-water mark, and that mark lives in an internal SQLite
  table that carries no triggers and cannot be brought under the census.
  Emptying a declared ledger AND removing or lowering its `sqlite_sequence` row
  is still silent — measured on the checkpoint ledger at this head: `p2
  boot=false [] assess=false release=ADMITTED`. It is one more deliberate act
  than the route that is now closed, and it is the same residual class as
  zeroing `PRAGMA user_version`.
- **The five declared ledgers that are not `AUTOINCREMENT` are covered by the
  COMMITMENT check rather than by the engine's high-water check, and before Wave
  5 correction round seven they were covered by NEITHER.** Two lanes found this
  independently — round seven, High 1, and round ten, Medium 4 — and both
  measurements are kept, because they are different experiments on the same
  hole. The row that stood here before either was a tautology: it said such a
  ledger "contributes nothing", named neither the count nor the ledgers, and
  closed with "every ledger the check currently protects does have one", which
  reads as an all-clear. What it glossed over was a fail-OPEN hole against the
  identical attack the other twenty-eight are protected from. The five are
  `hq_memory`, `hq_mission_intents`, `hq_mission_plan_items`, `hq_missions` and
  `hq_orchestration_runs`, out of thirty-three declared.
  Executed against `ae4bf90` on `hq_mission_plan_items`, the ledger through
  which a task's mission and its project ceiling are derived — drop the guards,
  `DELETE`, put the guards back: `boot=false [] assess=false []
  release=ADMITTED`, permanently. Measured again as a MATCHED PAIR by the other
  lane, running the same three statements against one of the five and against a
  control: erasing `hq_missions` gave `safeMode: false, blocking: []` and a FULL
  assessment of `{}` with three committed missions gone, while erasing
  `op_evidence` correctly gave `safeMode: true, blocking:
  ['append_only_ledger_truncated']`.
  `immutableLedgerMarks` is now driven by the DECLARATION rather than by a
  `sqlite_sequence` scan — the mark it publishes was always `MAX(rowid)`; the
  sequence row was only deciding which tables got one — and it reads through
  `declaredLedgerIdentities`, which commits each ledger's row COUNT beside its
  greatest rowid. So every declared ledger contributes a commitment and
  `regressedImmutableLedgers` compares it. It is sound for exactly these tables
  because all thirty-three declare `no_erase`, so `MAX(rowid)` on a declared
  ledger only ever rises.
  **The difference that remains, stated rather than smoothed over:**
  `truncatedImmutableLedgers` measures a ledger against the ENGINE's own
  high-water mark, which genuinely does not exist for the five, so their alarm
  needs a prior healthy boot to have recorded a commitment first. Pinned by
  `ledger-identity.test.ts` and by
  `immutable-ledger-truncation-coverage.test.ts`, the second of which also fails
  if a sixth non-`AUTOINCREMENT` ledger is declared without this row being
  revisited.
- **`DROP TABLE hq_integrity_checkpoints` is not a surviving ROUTE any more; it
  is a permanent lockout, and the operational half of that is the part that
  matters** (round twelve, Medium 4). This bullet priced it at "one extra
  `DROP TABLE`, one restart and one further Founder act", with
  `p3 assess=false release=ADMITTED` and `p4 boot=false []`. Re-executed at this
  head on two independent real files, that is false in the attacker's direction
  and false in the operator's: `p2/p3/p4/p5 boot=[append_only_guard_missing]
  assess=[append_only_guard_missing] release=safe_mode_engaged`, with
  `elided: true` and `regressed: []`. It never clears. Since round eleven the
  database header records how far the commitment ledger has ever reached, and a
  `DROP` takes the `sqlite_sequence` row while leaving that header mark standing;
  `recordIntegrityCheckpoint` refuses to append while safe mode is engaged, so
  nothing inside HQ can restore the identity the header now demands.
- **For an ATTACKER that is strictly better than disclosed and needs no further
  comment. For an OPERATOR it is a brick, and there is deliberately no in-HQ
  remedy.** Somebody who loses that ledger to a partial restore or a botched
  migration was told the cost was one restart plus one Founder act. It is not: the
  store stays in safe mode for ever, and every act safe mode gates stays refused.
  **A Founder-gated re-seat was considered and REJECTED rather than shipped.** The
  finding "HQ's commitment ledger has been destroyed" is equally true when a
  migration destroyed it and when an attacker did, and nothing inside the file
  can tell those apart — that indistinguishability is the entire value of a
  witness that lives in the header. A re-seat clearable by one Founder act would
  reduce the whole attack to `DROP TABLE` plus one Founder act, which is exactly
  the price this wave has spent three rounds proving too cheap, and it would
  re-open round eleven's prefix replay behind it. So the lockout is stated
  plainly instead: **recovery is out-of-band.** Restore the file from a
  verified backup — which is what `recordVerifiedBackup` exists to preserve, and
  it is deliberately still permitted while the store is untrusted. A byte copy
  of a healthy file produces no false positive, so a restore is clean.
- **A payload nested deeper than 64 levels is refused outright**, whether or not
  it carries anything secret. That is the fail-closed statement itself and it is
  a real behaviour change: a caller that genuinely needs to publish such a
  structure has a shape problem, and HQ will not publish what it has not read.
- **`workerId` in a request body is still accepted.** It names the worker being
  acted upon rather than who is acting, and reserving it removed eleven real
  behaviours. The rule `CLIENT_IDENTITY_KEYS` encodes is "a client may not name
  WHO IS ACTING", and `workerId` does not.
- **The freeze census excludes `src/cli/`.** Those modules run their work at
  import — `inventory.ts` writes a file at module scope — so importing them in a
  test is not safe. The exclusion is sound only because they export no `const`
  at all, and the test asserts that from the source text rather than assuming it.

### Verification at the sixth-round head

| Command | Result |
|---|---|
| `npm run test:hq` | **167 files, 3220 passed**, 0 failed (the merged head; this lane alone was 166 / 3209) |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root, `@factoryos/server`) | 37 files, 569 passed, 3 pre-existing skips |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |
| `npm run build` | all workspaces built; web initial JS 215.66 kB / 69.22 kB gzip (unchanged) |

Counted statically over `packages/headquarter/test` at the MERGED head: **176
files / 3036 `it(` declarations**, up from the round-five merge's 175 / 3008.
This lane alone was 175 / 3025; the other round-six lane contributes
`reliability-commitment-ledger.test.ts` and its 11 declarations. No test file and
no `it(` from either lane was removed; nothing is skipped, narrowed or annotated
away.
`package.json` and `package-lock.json` stay byte-identical to the wave base
`f1ce71c`, no dependency was added, and the whole wave diff stays inside
`packages/headquarter/` and `docs/HEADQUARTER/`.

**Re-verified by execution at this head**, so the sixth round's changes did not
regress what the earlier rounds established: dropping a SUBSET of the declared
engine-immutable ledgers and dropping ALL of them are still findings at BOTH
depths naming `op_evidence`, now asserted on
`observeImmutabilityAsFound(...).tablesAbsent` rather than on a prose substring;
a log dropped and rebuilt with its own three guards is still
`append_only_guard_missing` + `evidence_chain_broken`; tail truncation plus HQ's
own laundering appends plus a `sqlite_sequence` rewrite is still blocking; a
rebuilt LONGER coherent forgery is still a finding; the invisible-code-point
credential sweep still shows zero leaks within the erased classes and ordinary
prose is still accepted (`live-redaction.test.ts`, now 36 tests); label poisoning
is still refused on both the run and the decision routes; ALL FOUR
budget-nullification routes stay charged (`intelligence-attribution.test.ts`, 26
tests); the freeze enumeration reports nothing unfrozen — over the whole package
now, not the entry-point surface; `founder_only` isolation holds and the
mapped-non-Founder property is stated truthfully; and the unauthenticated
snapshot leaks no canary.

### The sixth round had TWO concurrent lanes, and this document describes the merged head

Wave 5 diverged again. Two correction lanes worked the sixth round at the same
time against different heads, without either knowing about the other:

- **this section's lane** reviewed `6a0f6ae` — the round-five reconciliation as
  it stood on `origin` — with two fresh reviewers, and returned 0 Critical / 5
  High / 7 Medium / 7 Low;
- **the section below** reviewed `bdec887`, the round-five head BEFORE that
  reconciliation, with one fresh reviewer, and returned 0 Critical / 0 High / 2
  Medium / 1 Low.

Both are kept in full. Nothing from either was discarded, and the two sections
are left as each lane wrote them rather than blended, so a reader can see what
each review actually found. What the merge had to decide is recorded here:

- **The two lanes reproduced the SAME core defect independently** — the
  commitment ledger's rows can be wiped IN PLACE, leaving the table present and
  the census silent — and answered it with two DIFFERENT rules. Both are kept
  because neither subsumes the other: `elidedCommitmentLedgerRows` asserts the
  commitment ledger's own count/rowid/high-water identity, which catches a wipe
  that INSERTS a replacement restoring the greatest rowid;
  `truncatedImmutableLedgers` asserts the weaker `MAX(rowid) >= high-water`
  relation over EVERY declared AUTOINCREMENT ledger, which is what closes the
  identical attack on the twenty-odd ledgers the first rule says nothing about —
  most sharply `hq_reliability_run_events`, where the wipe returned a spent
  attempt generation and made `RUN_RETRY_STATEMENT` false.
- **One thing had to be COMPOSED rather than laid side by side.** The Low 1 fix
  below committed `min(sqlite_sequence.seq, MAX(rowid))`. With
  `append_only_ledger_truncated` present, the boot that observes an inflated
  `sqlite_sequence` is BLOCKING and therefore appends a safe-mode verdict row —
  which SQLite gives the inflated rowid, so the `min` committed the inflated
  value after all and re-manufactured exactly the permanent finding true of
  nothing that Low 1 exists to prevent. Reproduced during the merge. The
  committed mark is now `MAX(rowid)` alone, with `sqlite_sequence` used only as
  the gate for "has this ledger ever been appended to"; that is strictly stronger
  in both directions and every detection the `min` gave is unchanged. The Low 1
  test is ported with that reasoning inline, and it also asserts that the
  inflating boot is blocking.

  **It does NOT assert that the latch clears, because the latch does not clear**
  (Wave 5 correction round fifteen, High 1). The sentence here used to read "the
  latch it leaves is cleared by one Founder assessment rather than standing for
  ever", and the test that pinned it restored `sqlite_sequence` to the real value
  before asserting the clearing — so the version WITHOUT the barrier the sentence
  names was never executed, which is precisely what the round-six rule two
  sections down forbids. Executed at `c23dd0a` with the mark left inflated, ONE
  statement and no DDL — `UPDATE sqlite_sequence SET seq = 999 WHERE name =
  'hq_reliability_verdicts'`, all six of that ledger's triggers still present:

  ```
  p1  boot safeMode=false []                                    release ADMITTED
  --- UPDATE sqlite_sequence SET seq = 999 (one statement, 6 triggers intact) ---
  p2  boot safeMode=true  ["append_only_ledger_truncated"]      release REFUSED
      FOUNDER assessHqIntegrity -> safeMode=true ["append_only_guard_missing"]
      identity {rows:5, top:1001}   regressed ["hq_reliability_verdicts"]
  p3  boot safeMode=true  ["append_only_guard_missing"]         release REFUSED
      FOUNDER assessHqIntegrity -> safeMode=true ["append_only_guard_missing"]
  p4  boot safeMode=true  ["append_only_guard_missing"]         release REFUSED
      FOUNDER assessHqIntegrity -> safeMode=true ["append_only_guard_missing"]
  ```

  Each of p2/p3/p4 ran a full Founder assessment and none of them cleared it.
  The mechanism is a loop the file cannot leave: the inflating boot is blocking,
  a blocking boot APPENDS its own safe-mode verdict row to
  `hq_reliability_verdicts`, SQLite gives that row the rowid the burned counter
  names, `no_rowid_skip` permits it by design (its `sequenceTerm` exists so HQ
  never refuses what the engine itself would allocate) and `no_rowid_reseat`
  permits it because the row IS the greatest — and the gap `top − rows` is now
  998 against a committed baseline of 0, which `regressedImmutableLedgers`
  reports for ever. Only a CLEAN assessment commits a checkpoint, so no boot can
  ever re-baseline the gap. A two-statement variant on `hq_intel_cost_entries`
  reproduces identically.

  `SAFE_MODE_STATEMENT` was already honest about this — it says a writer that
  "raises the engine's own high-water mark for some other ledger" can
  "manufacture a finding HQ will then report and keep reporting" — so what was
  wrong was this page contradicting it for the one path it names. The sentence
  is corrected here, and `reliability-commitment-ledger.test.ts` grows a second
  arm that leaves the mark inflated and asserts what actually happens, so the
  corrected sentence is executed rather than asserted.

  **Restoring the mark is not the remedy either**, and the first draft of this
  correction said it was, so it was executed too. By the time a reader could act,
  HQ's own verdict rows already stand at the rowids the burned counter named;
  putting `sqlite_sequence` back to `MAX(rowid)` leaves those rows and the gap
  exactly where they are — measured: `regressed
  ["hq_reliability_verdicts"]`, `assess ["append_only_guard_missing"]`,
  `releaseKillSwitch REFUSED`. What does clear it is a re-baseline of the
  committed gap — a direct `recordIntegrityCheckpoint` against the file as it now
  stands (`regressed []`, `assess []`, `release ADMITTED`) — and **no facade path
  performs it**, because both call sites are gated on `!safeMode`. So the honest
  statement is: once the inflating boot has appended, nothing a Founder can reach
  through HQ clears this latch. Both halves are pinned.

  **The structural half was designed and is NOT closed**, and both candidates
  are recorded rather than left for a later round to rediscover:

  1. **Let a boot re-baseline the gap when the gap is its only blocking
     finding.** This is the mechanism that works, and it is rejected on a
     MEASURED reason rather than a feared one: the identical re-baseline clears a
     GENUINE mid-ledger deletion just as completely. Executed — drop the six
     triggers, `DELETE` one row from the middle, put the triggers back, then one
     `recordIntegrityCheckpoint`: `regressed []`, `assess []`,
     `releaseKillSwitch ADMITTED`. A real removal presents as exactly "the gap is
     the only blocking finding", so automating this would launder it, which is a
     direct regression of the round-seven High the gap clause exists for.
  2. **Do not count a gap rise that is attributable to a `sqlite_sequence` mark
     HQ never committed.** HQ deliberately commits `MAX(rowid)` and never
     `sqlite_sequence` (that is the Low 1 fix immediately above), so the only
     available witness for the attribution is the CURRENT `sqlite_sequence` —
     which is the attacker's own value. A real mid-ledger deletion could then be
     masked by inflating the counter beside it, trading a false alarm for a
     false reassurance, which this module ranks strictly worse.
     A third variant — replace `top − rows > committedGap` with "holes below the
     COMMITTED top", `mark.top − COUNT(rowid <= mark.top) > committedGap` — is
     immune to that masking. It was implemented and measured on this head, and it
     does both things: it closes this finding, and it drops a detection the suite
     already pins.

     ```
     scenario                                    shipped clause          holes-below-top
     sqlite_sequence inflation (this finding)    ["hq_reliability_verdicts"]   []
     INSERT above the top, guard removed         ["hq_reliability_verdicts"]   []
     ```

     The second row is the round-thirteen exploit, and it is not hypothetical:
     with the variant in place, `ledger-rowid-guard.test.ts`'s *"still falls to
     three statements, and that is what the residual is priced at"* FAILS.
     Trading a fabricated finding for a lost real one is the same trade in the
     other direction, so the disclosure stands and the sentence is corrected
     instead.
- **The vocabulary grew by one and the count assertions moved with it.** This
  lane added `append_only_ledger_truncated` because in its attack every declared
  guard is present when the census looks, so reporting it as
  `append_only_guard_missing` would state something untrue of the file. The
  other lane's elision finding stays folded into `append_only_guard_missing`,
  where it belongs for the same reason. Vocabulary 7, blocking list 4.
- **Both lanes' tests are kept**, `test/reliability-commitment-ledger.test.ts`
  (11) beside this lane's additions to `reliability-durability.test.ts`, and the
  matrix at the merged head is reported in this lane's verification table.

## The SIXTH correction round: the commitment ledger's own rows, and two prices stated wrongly

A fresh read-only reviewer re-read the fifth-round head by EXECUTION and
returned 0 Critical / 0 High / 2 Medium / 1 Low. Both Mediums were
documentation-honesty defects about the newest code: in each case a shipped
sentence stated a cost or a remedy that the reviewer executed and found false in
the direction of false reassurance. That is the third round in this wave where
the finding was a DISCLOSURE, so the rule is written down here rather than
learned again: **a residual is a load-bearing claim, and the version WITHOUT the
barrier it names must be executed before the sentence is written.**

| Finding | What was reproduced | What changed |
|---|---|---|
| **MEDIUM 1** — the surviving whole-log forgery costs materially less than the residual stated, and names a barrier the attacker never has to cross | The residual priced the surviving attack at "one extra `DROP TABLE`, one restart and one further Founder act". Wiping `hq_integrity_checkpoints` ROWS IN PLACE — drop its three triggers, `DELETE`, INSERT one coherent replacement, re-create the triggers — leaves the table PRESENT, so the as-found census has nothing to observe: `BOOT safeMode = false []`, `FULL assessment safeMode = false []`, `releaseKillSwitch ADMITTED? true`, at zero restarts and zero Founder acts. The same wipe neutralised the durable half for a store whose every OTHER declared ledger had been dropped (`p3 boot=false assess=false release=ADMITTED`). The DROP variant the residual described does reproduce exactly as written; it is simply not the cheap path. | `elidedCommitmentLedgerRows`: the commitment ledger is `INTEGER PRIMARY KEY AUTOINCREMENT`, HQ is its only writer and its `no_erase` guard refuses a DELETE, so its row COUNT, its greatest rowid and the engine's high-water mark for it are the same number. An in-place elision breaks that identity and is blocking at the boot, at the assessment and at every process afterwards. Verified against six legitimate ways a sequence value might be burned — none burns one in SQLite — before it was relied on. **The remaining price this row recorded was itself wrong, and is corrected in round seven (Low 2): "one explicit rowid plus one `UPDATE sqlite_sequence`" is neither the cheapest surviving path nor a silent one — on a file with more than one commitment it is CAUGHT (`boot=true assess=true release=safe_mode_engaged`), because collapsing the rows regresses the ledger's own recorded high-water mark.** The path that survives keeps the row COUNT and rewrites the rows in place: one `DROP TRIGGER` of the `BEFORE UPDATE` guard, one `UPDATE`, re-create that trigger — no `DELETE`, no `INSERT`, no explicit rowid and no `sqlite_sequence` write at all (`p2/p3/p4 boot=false assess=false release=ADMITTED`). This check closes every version that DELETES rows; no row-count invariant can close the version that preserves the count. |
| **MEDIUM 2** — the documented remedy for this wave's own upgrade cost does not work, and the source comment contradicted the code it documented | Three sentences said a newly declared ledger's first boot is "cleared by one Founder full assessment". Carrying the restored-ledger list into `fullIntegrity` — which is what closed the previous round's Medium — made that false for every established file: `p1 boot=true assess=true release=refused`, `p2 boot=true assess=false release=ADMITTED`. The control, a dropped GUARD, still clears in one: `q1 boot=true assess=false release=ADMITTED`. It applies to every existing HQ database on first contact with this build. | The sentences, not the code. Narrowing the rule to "genuine upgrades only" needs a discriminator separating "a ledger this build newly declares" from "a ledger destroyed", and the only durable marks available — `PRAGMA user_version` and the checkpoint commitments — are ordinary writable content of the same file. A writer who drops a ledger and stamps an older generation walks into the benign branch, which would have made MEDIUM 1's residual cheaper; and the commitment ledger's own destruction takes every commitment about it. Two processes and two Founder assessments is now what `store/integrity.ts` and this document say, with the measurement beside it. |
| **LOW 1** — a forged `sqlite_sequence` reading, once committed, latched safe mode permanently with no in-HQ remedy | `sqlite_sequence` is an ordinary writable table SQLite refuses to let a trigger guard, and the per-ledger commitment took the maximum ever recorded. Inflating `hq_reliability_verdicts` from 1 to 500000, letting ONE clean boot commit the reading and then restoring the true value produced a `regressedImmutableLedgers` entry TRUE OF NOTHING: `pB2/pB3/pB4 boot=true assess=true findings=["append_only_guard_missing"]`, clearable by nothing including `assessHqIntegrity`. Fail-closed, and the attacker already holds raw write — but a FABRICATED finding in the false-alarm direction, which the architectural law forbids symmetrically. | The committed mark is corroborated against the ledger's own rows, and HQ commits `MAX(rowid)` alone. (This cell said "the smaller of the two" until round seven, Low 3, which is what the round-five lane wrote and what the round-six MERGE twenty lines above already says it replaced: the `min` still let an inflated reading be committed, because the boot that follows the inflation appends its own verdict row and SQLite gives that row the inflated rowid.) An inflated `sqlite_sequence` now commits nothing the rows do not support: `pB2/pB3/pB4 boot=false assess=false findings=[]`. `MAX(rowid)` is a single reverse seek, so the structural pass stays affordable — and its stated cost was corrected to say so rather than keeping the old "runs no table scan". |

**What the LOW fix also bought, and what it did not.** Because the mark now
tracks `MAX(rowid)`, rows removed IN PLACE from the TAIL of any declared ledger
— drop the guards, `DELETE`, re-create the guards, which leaves
`sqlite_sequence` untouched and was previously invisible — fall below the
committed mark and are reported. Executed on `hq_reliability_verdicts`:
`[tail p2] boot=true`. It is a one-process signal, not a durable one: HQ's own
next append climbs the ledger back over the committed mark, which is the
already-disclosed "climb back" residual and is unchanged by this round
(`[tail p3] boot=false`). A MIDDLE-row deletion leaves the tail in place and is
not detected at all (`[middle p2] boot=false assess=false release=ADMITTED`).
Both are stated here because neither is closed.

**A raw writer can still manufacture a one-process false alarm**, and this was
executed rather than reasoned about: plant a row at rowid 500000 in a declared
ledger, let one clean boot commit it, then remove that row with the guards
dropped. Measured: `boot-1 safeMode=false`, `pB2 boot=true`, then `pB2 assess=false`
and `pB3 boot=false` — HQ's own verdict append restores the mark. The finding is
true of something the attacker really did, and it is no longer permanent; the
metadata-only version, which was permanent and true of nothing, is gone. Any
durable finding in this family remains unclearable by any in-HQ act by design —
if one were ever raised falsely the only remedy would be a restore from a
verified backup, and that is the accepted posture rather than an oversight.

**What this round deliberately did NOT do.** It did not extend the row-COUNT
identity to every OTHER declared ledger. That would assert an invariant over tables
this module does not own, and it would break `structuralIntegrity`'s stated cost
— a `COUNT(*)` is proportional to the rows, unlike the `MAX(rowid)` seek — for a
check that a raw writer repairs with one `UPDATE` anyway. It did not widen the
closed finding vocabulary: an elided commitment is `append_only_guard_missing`,
the same finding measured a fourth way. And it did not weaken any behaviour the
review confirmed at the fifth-round head, which the pinning tests hold.

### Reconciled with the concurrent round-five lane

The sixth round was reviewed and corrected against `bdec887`, the round-five
head as it stood on `origin` at the time — NOT against the reconciliation the
other lane published on the same branch (`6a0f6ae`, "Reconcile the round-five
lanes: one witness for the evidence chain, both lanes' guarantees kept"). Both
are kept; nothing from either was discarded. What that costs a reader is one
correction and two clarifications, recorded here rather than left to be found:

- **The reconciliation's own recorded cost was understated, and it is re-priced
  in the NOT-fixed list above.** It said that retiring the verdict-row
  commitment left "ONE ledger to drop". That was true of the DROP and silent
  about the cheaper act: until `elidedCommitmentLedgerRows` existed, the one
  surviving commitment ledger did not have to be dropped at all — its rows could
  be wiped IN PLACE for nothing. The re-priced sentence is one ledger to drop OR
  to wipe in place and re-seat, with the free version of the second now closed.
  The trade itself is not disturbed: it was taken on three merits that this
  round does not touch.
- **MEDIUM 1's finding is load-bearing for the reconciled code specifically, not
  only for `bdec887`.** The reconciliation made `hq_integrity_checkpoints` the
  SINGLE surviving witness for the evidence chain's length. A single witness that
  can be emptied in place for free is not a witness, so the row-identity check is
  what makes the reconciliation's chosen trade hold at the price it claims.
- **MEDIUM 1's exploit numbers were measured on `bdec887` and re-measured on the
  merged head.** The merged tree adds `hq_missions` to the declared ledgers, so
  the declared-ledger COUNT in any older sentence is not the count today; the
  measurements are quoted by behaviour (`boot=`, `assess=`, `release=`) rather
  than by ledger count wherever a number would drift.

`elidedCommitmentLedgerRows` folds into `append_only_guard_missing`, the
existing closed finding, so the vocabulary the reconciliation froze is unchanged
by this round — the freeze enumeration reports nothing unfrozen at the merged
head.

## The SEVENTH correction round: a Founder APPROVAL that safe mode admitted, and four more write/read asymmetries

A fresh read-only hostile review of the merged head `d97b8a6` — the true merge
of the two round-six correction lanes — returned 0 Critical, 0 High, 2 Medium
and 2 Low. All four are addressed here. Two are code fixes with new pinning
suites; one is a disclosure the code deliberately does not change; one is a
residual re-priced after executing the version without the barrier it named.

| Finding | What was reproduced | What answers it |
|---|---|---|
| **MEDIUM 1** — `acceptTruth` wrote a permanent acceptance while safe mode was engaged, and was in neither column of the safe-mode tables | `acceptTruth` had no `#safeModeRefusal`. Executed: with `append_only_guard_missing` latched, `acceptTruth -> ACCEPTED`, while `recordTruth` beside it correctly answered `safe_mode_engaged`. `SAFE_MODE_STATEMENT` — shipped verbatim on every reliability view and in every refusal — says HQ refuses the acts that would APPROVE a record it cannot stand behind, and this is the Founder's approval-authority, digest-bound, step-up-gated, one-shot acceptance of one. Seven more mutators were in neither column with it: `registerAiMember`, `disableAiMember`, `setAiMemberHealth`, `postMissionMessage`, `reconcileTask`, `rejectProposal`, `returnForFreshApproval`. The honest mitigation, which is why this is a Medium: acceptance executes nothing — no task, approval row, claim or dispatch is touched, and no gate reads it. | `acceptTruth` and `registerAiMember` are REFUSED; the other six are named in the kept-available table with their reasons. `registerAiMember` is refused because it writes `grantedCapabilities`, from which `RegistryWorkerDirectory` derives the `effectiveCapabilities` it answers `allowedCapabilities` with — the same argument that already refuses `registerExecutionWorker`; that the shipped host leaves the narrowing seam unwired is a deployment fact, not a property of the method, and its docstring's "grants nothing and is never consulted by enforcement" is corrected rather than softened. Both safe-mode tables above now name EVERY public facade write, one row each, and `safe-mode-disposition.test.ts` derives the same two sets from the source and fails when they differ in either direction — so a mutator cannot land in neither column a fourth time. |
| **MEDIUM 2** — write-scan ≠ read-scan at five more sites; one accepted write permanently 500s a Founder read route | Round four's "every facade write … 29 call sites … the asymmetry is closed" was premature. Executed across separate processes, each to a permanent outage no HQ command can undo: `createTask`'s `title` → `500` on `/state` and `/commandCenter`; `createTask`'s `project` → `/state`; `failTask`'s `reason` → both; `registerExecutionWorker`'s `displayName` → `/state`, `/workforce` and `/commandCenter`, from a CREATE-ONLY command; `engageKillSwitch`'s `reason` → both, on the act a Founder reaches for in a hurry to stop everything. Two of the five (`createTask`, `engageKillSwitch`) were found by the sweep rather than by the review. | All five scan `assertNoCredentialShape` before the first write, as do `assignTask`, `submitResult`, `reviewTask`, `reconcileTask`, `postMissionMessage`, `rejectProposal`, `promoteProposal`, `registerAiMember`, `disableAiMember`, `recordVerifiedBackup`, `recordIntelligenceOutcome` and `recoverInterruptedRuns`, which the same sweep reached. `facade-write-scan.test.ts` enumerates the facade's text-storing writes FROM THE SOURCE and fails when one does not call the function, then proves the five outages end to end over every shipped control route in two fresh processes. ONE carve-out is named and itself executed: `createTask`'s task PAYLOAD, which no control route serves and whose strict guard lives at the dispatch boundary that would publish it — two existing tests write a credential-shaped payload through `createTask` on purpose to prove that boundary holds independently. |
| **LOW 1** — the strict scan newly refuses ordinary Founder prose, undisclosed | `Bearer\s+[A-Za-z0-9._-]{16,}` refuses "The bearer responsibilities were reassigned to the shift lead"; `sk-[A-Za-z0-9_-]{16,}` refuses "Contract with Addis-Sk-Trading-Corporation renewed for 2027". Both were ACCEPTED by the weak heuristic these sites used before round four, and round four's disclosure said only that nothing formerly refused is now accepted. | **DISCLOSED, not changed.** The patterns are not loosened: this is the same function the READ boundary applies, so admitting the prose would loosen what may be published as well as what may be stored, and no candidate discriminator could be shown not to admit a genuine credential. The exact sentences and the near misses that stay accepted are pinned in `credential-scan-cost.test.ts`, alongside a non-regression group proving the evasion direction is untouched — so the disclosure is suite-enforced and a future tightening has to move it. |
| **LOW 2** — the round-six residual priced the surviving forgery above its cheapest path, and one source sentence was false of that path | The residual said the cheapest surviving repair is "the replacement inserted at an explicit `seq = 1`, then one `UPDATE sqlite_sequence` for that ledger". Executed on a file with three genuine commitments, that path is CAUGHT (`boot=true assess=true release=safe_mode_engaged`) — it was measured on a single-commitment file. The path that survives keeps the ROW COUNT and rewrites the rows in place: one `DROP TRIGGER` of the `BEFORE UPDATE` guard, one `UPDATE`, re-create that trigger. No `DELETE`, no `INSERT`, no explicit rowid, and ZERO `sqlite_sequence` writes. Executed end to end with `op_evidence` itself rewritten in place and re-chained: `p2/p3/p4 boot=false assess=false release=ADMITTED`. | Both sentences corrected at source (`store/integrity.ts`, `operator/evidence.ts`) and in the NOT-fixed list above, to the cheapest path that could actually be executed. `reliability-commitment-residual.test.ts` runs all three variants — the elision (blocking), the path round five named (blocking on a multi-commitment file), and the count-preserving rewrite (silent for ever) — so the residual is enforced by the suite rather than described. The honest gain of `elidedCommitmentLedgerRows` is now stated narrowly: it closes every version that DELETES rows, and no row-count invariant can close the version that preserves the count. |

### What this round does NOT claim

- LOW 1 is a disclosure, not a fix. The refusal is real, there is no override,
  and a Founder who writes either sentence must rephrase.
- LOW 2 is a re-pricing, not a closure. The count-preserving in-place rewrite is
  open, and the security posture is unchanged by this round: the disclosed
  variant was equally silent, and both need raw write to the file.
- The safe-mode table enforcement is a SOURCE derivation plus behavioural spot
  checks, not a proof that every one of the 39 refused methods refuses at
  runtime. The derivation reads the gates that decide it, the READ list is
  cross-checked against the same write markers so it cannot hide a mutator, and
  the four dispositions this round turns on are proven against a real
  file-backed database with a real latched finding.

### The seventh round had TWO independent hostile reviews of `d97b8a6`, and this document describes the merged head

A second read-only reviewer read the same frozen head at the same time, without
either lane knowing about the other, and returned **1 Critical, 3 High, 2 Medium
and 1 Low**, all reproduced by execution. Both lanes' corrections are on this
branch; the merge kept every answer from each, and where the two answered the
same question the surviving answer is named at the code.

| Finding | What was reproduced | What answers it |
|---|---|---|
| **CRITICAL NEW-1** — total erasure of the commitment ledger was CHEAPER than eliding a row from it, and the file certified itself intact | Every check guarding the commitments reads something the erasure destroys: `elidedCommitmentLedgerRows` and `truncatedImmutableLedgers` both START from the `sqlite_sequence` row, and `regressedImmutableLedgers` reads `committedLedgerMarks` out of the table that was emptied. `DROP TABLE hq_integrity_checkpoints` followed by a replay of the table's own DDL out of `sqlite_master` leaves it PRESENT and empty, with nothing absent for the as-found census. Executed on a file carrying a genuinely latched `evidence_chain_broken`: `full=false []`, `releaseKillSwitch` **ADMITTED**, and every later process `boot=false []`, permanently. The same held with `op_evidence` dropped and replayed beside it, and with `hq_reliability_verdicts`. Re-verified against the OTHER lane's head `b986cff` after the merge: still open there — `truncatedImmutableLedgers` does not see it, because the drop takes the `sqlite_sequence` row it reads. | A witness that does not live in any table. HQ stamps `PRAGMA application_id` with `0x48514350` (`HQCP`) once a checkpoint row has LANDED — never before, because a witness set beside a failed insert would be a permanent finding true of nothing. The header survives `DROP TABLE`, `VACUUM` and `VACUUM INTO`; SQLite never writes it; `user_version` is already using the other slot. A commitment ledger that is PRESENT and holds NO rows on a witnessed file is blocking at both depths and across restarts. Read as an exact member of a closed set, so a foreign application's `application_id` is not a false alarm at HQ's first boot over its file. `reliability-commitment-witness.test.ts` executes all four variants against a real file through a raw connection. |
| **HIGH NEW-2** — a free, permanently-silent commitment wipe survived, and the shipped re-pricing said it did not | `store/integrity.ts` and this page both claimed "the version costing NOTHING is gone". A third variant reached the same early return: `DELETE` every row from the ledger AND `DELETE FROM sqlite_sequence` for it — two statements, no replacement row, no `DROP`. Measured on `d97b8a6`: `p2`–`p5` each `boot=false [] full=false [] release=ADMITTED`, zero restarts and zero Founder acts. | The same `rows === 0` branch and the same header witness. The sentence is re-priced at source and above rather than repeated: what is gone is every version costing nothing; the one-statement repair still costs the attacker every process after the one it bought; the count-preserving in-place rewrite (LOW 2 of the other lane) is unchanged and still silent. |
| **HIGH NEW-3** — an unscanned facade write permanently 500s the Founder reliability route, and the "29 call sites" claim was a hand count | `recordVerifiedBackup.note`, `recordIntelligenceOutcome.note` and `disableAiMember.reason` bounded their caller text with `missionText` — a LENGTH check — and never reached `assertNoCredentialShape`. Executed on `d97b8a6`: `GET /api/hq/control/reliability` `200`, one accepted `recordVerifiedBackup({note:'sk-…'})`, then `500` for ever, because `hq_reliability_backups` carries `no_rewrite`/`no_erase`. | **The other lane had already closed all three** (round six High 4 / Medium 4, round seven Medium 2), reached from the public-method direction; its guards and refusal messages are what survive the merge. What this lane adds is a SECOND derived assertion: `credential-scan-coverage.test.ts` enumerates every member of `service.ts` that calls `missionText` (29 at this head) and names any that does not also call the scan. The two enumerations cover different sets — public methods that store caller text, and length-bounded text fields — and neither subsumes the other. `disableAiMember`'s reachability, left open by the review, is answered rather than argued: `src/cli/workforce.ts` builds the facade with the member registry on every actor-attributed action, and the test builds the same facade. |
| **HIGH NEW-4** — the round-four ceiling fix did not cover new work under an already-exhausted ceiling | The `spentUnder` union closes the routes only for a task that has ALREADY recorded spend. Executed with the project ceiling exhausted by task A and the attack on task B in the same project, as a principal holding `originateCapabilities: ['hq.mission_command']`, `approvalAuthority: false` and no intelligence grant: `assignMissionToProject({projectId: null})` was accepted, `permittedTiers` widened from `["deterministic_local"]` to all five, and a `critical_review` record was ACCEPTED — while the same principal calling `setIntelligenceBudget` directly is correctly `refused(not_permitted)`. Raw `UPDATE hq_missions SET project_id = NULL` did the same. Re-verified against `b986cff`: still open there. | Project membership is derived from the APPEND-ONLY mission event log as well as from the mutable column. `assignMissionToProject` already records BOTH ends of every move it makes, and `commandMission` now records the project a mission is created under, so clearing the link narrows nothing — the act of clearing it is itself the record that the project once governed. Applied identically to `#governingBudgetScopes` and to `#entriesForScope`, so the governing set and the measurement agree by construction. The half that already worked is pinned unchanged: a task with its own recorded spend keeps `governedBy: task_project` and `observed 5000`. |
| **MEDIUM NEW-5** — 26 exported ALL-CAPS constants were still unfrozen, and frozen `Set`s were mutable in content | The shipped pinning test enumerates `package.json#exports`, so it cannot see a module no entry point re-exports; the unfrozen count regrew to 26 distinct bindings over 225, across 131 `src/` modules. Separately, `deepFreeze`'s "It freezes ALL THE WAY DOWN" was NOT true of a `Set` or a `Map`: entries are not own properties, so `QUEUED_UNREACHABLE_STATUSES` — which `service.ts` decides a queued task's reachability on — accepted `.delete()` and `.add()`, and `QUERY_STOPWORDS` accepted `.clear()`. | **The other lane froze the same 26 independently** (its round-six pass), and that half of the finding is closed at `b986cff`. What this lane adds is the census that would have CAUGHT the regrowth — `frozen-constants-census.test.ts` enumerates `src/` itself rather than the entry points — and the collection fix: a frozen `Set`/`Map` now has its entries recursed into, with reading untouched. **The mutator half of that sentence was corrected at round ten (Medium 2):** own, non-configurable throwing properties shadow direct access only, so `Set.prototype.clear.call(x)` still emptied the vocabulary in one statement. `deepFreeze` now returns a `Proxy` over the collection rather than the collection, which carries no [[SetData]] slot and so refuses the prototype spelling too. The `freeze.ts` sentence is corrected rather than restated. Decision-bearing, stated either way: `PROJECT_ALLOWED_TRANSITIONS` is the gate behind `canTransitionProject` and `.active.length = 0` flips it true → false, which is NARROWING — a local denial of service on a Founder act, not an authority widening. The other 24 are `ui/spatial/*` geometry and presentation maps, `providers/codex/*` vocabularies and the review schema, `providers/claude/*` evidence kinds and the repo-slug pattern, and `control-console.ts`'s fetch allow-list; none is an authority gate. |
| **MEDIUM NEW-6** — `provablyAvoidable` flipped retroactively and two published numbers contradicted each other | `decisionIsProvablyAvoidable` recomputed the floor from the CURRENT canonical risk class while `rowToDecision` served the STORED `floor_tier`. Executed: a Founder registry upsert flipped `provablyAvoidable` 1 → 0 and left the served record reporting `floorTier: deterministic_local` beside `requiredReviewTier: critical_review` — which cannot both be true, since the review requirement is one of the terms the floor's `max` is taken over. Undisclosed. | ONE computation answers both. `deriveDecisionRecord` recomputes the floor and SERVES it; `decisionIsProvablyAvoidable` reads that result rather than recomputing, so the two cannot diverge again. The stored value is carried as `floorTierAsRecorded`. The flip is kept — canonical truth really did move — but no longer silent: `riskClassChangedSinceIssue` per record, counted on `analytics.provablyAvoidable.riskClassChangedSinceIssue`, and stated in `AVOIDABLE_SPEND_STATEMENT`. |
| **LOW NEW-7** — a source file the repository's own text tooling could not read | `test/connectors.github.test.ts` carried a raw U+0007 at byte 4903 and a raw U+202E beside it, so `git diff` rendered it `Bin 9424 -> 9429 bytes` — the exact hazard the NUL two characters earlier had been escaped to avoid. | Both escaped; that change now renders as one line out, one line in. **The other lane escaped the same two characters independently** (its round-six Low 6). What this lane adds is the derived assertion that replaces the hand check — `source-text-hygiene.test.ts` over every `.ts` file in `src/` and `test/` — and what that assertion then FOUND: four more raw U+001F separators in `src/application/product-command.ts`, `src/application/intelligence-command.ts` and `src/live/auth.ts`, each sitting under a Wave 5 Medium 10 comment claiming the separator had been written so the file "stays greppable". The comment described a fix that was never applied. All four are escapes now, same runtime value. |
| **Two undisclosed sweep residuals** — `\p{Mn}`, `\p{Me}` and `\p{Cn}` carried a credential shape past the guard | The zero-ink sweep named five properties and argued `\p{Zs}` out on the merits, but non-spacing marks (2,059 code points), enclosing marks (13) and unassigned code points (814,730) were in neither the set nor any residual list. **Those two figures read 1,796 and 810,961 until Wave 5 correction round thirteen (Low 6)**: they were the sizes on an older ICU, and on the shipped runtime (Node v22.22.2, ICU 78.2, Unicode 17.0) they are 2,059 and 814,730. `\p{Me}` 13, `\p{Co}` 137,468 and `\p{Zs}` 17 were exact. They are now measured against the running engine and parsed back out of the prose by `redaction-invisible-classes.test.ts`, so the pair cannot drift apart again; the guarantee never moved with them, because the erase set is expressed as the PROPERTIES. U+0301 and U+0378 are the two the review named. | CLOSED, not disclosed. A combining mark leaves every credential character intact and a reader strips the mark, so it is exactly this class. Marks are removed from an `NFKD`-decomposed copy BEFORE the pipeline — `NFKC` composes base + mark into a precomposed `Lu` letter, so a late erase misses it — and all three categories join the erase set as well. Measured after the fix: 1,809 marks swept, 0 survivors; 815 sampled unassigned code points, 0 survivors; no new refusal on accented prose in five languages or on any legitimate string the shipped suite pins. The fold is a SCAN COPY, so stored and served text is byte-unchanged. `\p{Zs}` still not folded, and `Xsk-…`/`9sk-…` still reach a written `hq-snapshot.json` — both pinned as disclosed rather than described. **Corrected at round nine (High 1): that closing sentence was incomplete — `\p{Co}` PRIVATE USE (137,468 code points) was also open, on no stated argument at all, and is closed at round nine.** |

### What the second seventh-round lane does NOT claim

- **The header witness is not a boundary.** A writer that also runs `PRAGMA
  application_id = 0` puts the file back to unwitnessed — one further statement
  on top of the erasure, executed and still silent. What is closed is the
  INVERSION: total erasure is no longer cheaper than partial erasure. HQ holds
  no key over its own file.
- **A file whose commitments predate the witness carries none of it** until HQ's
  next checkpoint stamps the header. That is the ordinary upgrade cost of a new
  mark, not a defence.
- **NEW-4's history derivation does not reach one case:** a mission CREATED with
  a project by a build older than the `commanded` event's `projectId` detail,
  never re-assigned through the facade, whose link is then cleared by RAW SQL,
  leaves no history to derive from. The FACADE route is closed for such a
  mission regardless of build age, because `assignMissionToProject` writes
  `from` at the moment it clears.
- **`PROJECT_ALLOWED_TRANSITIONS` was a narrowing exposure, not a widening
  one.** Emptying it denies a Founder transition; it grants nothing.
- **The floor recomputation does not stop a forged `characteristics` row.** It
  makes the two published numbers agree and reports when canonical truth moved;
  the underlying forgery surface is unchanged and is disclosed where it always
  was, on `decisionIsProvablyAvoidable`.

**Verification at the round-seven merged head** (the whole matrix, all green,
exit 0): `npm run test:hq` **178 files / 3288 tests**; `npm test` (root) **37
files / 569 passed + 3 pre-existing skips**; hq-host **23 / 222**; hq-server
**2 / 20**; all four typechecks clean; `npm run build:site` 10 pages +
`hq-snapshot.json`; `npm run build` all workspaces, web initial JS
**215.66 kB / 69.22 kB gzip** (unchanged). The diff against the accepted base
`f1ce71c` touches `packages/server`, `packages/web`, `packages/shared`,
`packages/config-mesob`, `packages/hq-host`, `apps/`, `package.json` and
`package-lock.json` not at all, and no test file was deleted or renamed.

## The seventh round had a THIRD hostile review, and this section is its lane

Two fresh reviewers read the merged head `2891123` and returned **0 Critical /
5 High / 7 Medium / 9 Low**. Every High was the same structural mistake — a
partial enumeration standing in for the complete one — and three of them land in
this phase. All three were reproduced by execution against `ae4bf90` before
anything was changed, and the reproductions are the tests named beside them.

Two of the Highs the reviewers raised were already CLOSED by the concurrent
lane that pushed `ae4bf90` while this one worked, and that is said here rather
than claimed: `createTask`'s unscanned `title`/`project` (their round-seven
Medium 2, verified refused here) and the intermediate-scope budget route (their
HIGH NEW-4, verified closed here — see Phase 14). The `Set`/`Map` freeze
(their NEW-5) was closed by the same lane and is likewise verified rather than
re-fixed.

| Finding | What was reproduced, on `ae4bf90` | What changed |
|---|---|---|
| **HIGH 1** — five declared engine-immutable ledgers were covered by NEITHER wipe detector, and wiping one is permanently silent | `sqlite_sequence` MEMBERSHIP was standing in for "is this a declared ledger": `truncatedImmutableLedgers` iterates that table, `immutableLedgerMarks` was gated on it, and `regressedImmutableLedgers` reads what that gate committed — so all three shared one blind spot. Five of the 33 `ENGINE_IMMUTABLE_TABLES` entries are not `INTEGER PRIMARY KEY AUTOINCREMENT` and have no row there ever: `hq_memory`, `hq_mission_intents`, `hq_mission_plan_items`, `hq_missions`, `hq_orchestration_runs`. Executed: drop the guards, `DELETE FROM hq_mission_plan_items`, put the guards back — `truncated []`, `regressed []`, `elided false`, `boot=false [] assess=false [] release=ADMITTED`, on every process afterwards. Same for `hq_missions`. Two of those five are the ledgers a task's mission and its project ceiling are derived through, which is why this wave gave them `no_erase` at all. | `declaredLedgerIdentities` reads EVERY declared ledger the file carries, from the declaration, and consults `sqlite_sequence` not at all. A checkpoint now commits, per ledger, how many rows it holds and the greatest row it reaches. Wiping any of the five is blocking at both depths and across restarts, and the finding names the ledger. `truncatedImmutableLedgers` is unchanged and still engine-mark-based; it answers a different question and is not the enumeration that was wrong. |
| **HIGH 2** — a MID-ledger delete re-admitted a spent attempt generation, undetected at both depths | `MAX(rowid)` was standing in for "how many rows does this ledger hold", so deleting from the middle left the tail, left the engine's high-water mark, and left every detector silent. Executed on `hq_reliability_verdicts` — the ledger holding the safe-mode latch itself — rowids `[1,2,3]`, delete rowid 2: `truncated []`, `regressed []`, `boot=false []`, `release=ADMITTED`, across restarts. | A row COUNT alone does NOT close it, and that was measured rather than assumed: HQ appends to that ledger as it assesses, so the next append restores the count and the finding lasted less than one process. What does not heal is the GAP the deletion leaves in the rowids, because SQLite hands the next append `MAX(rowid) + 1` and never reissues a deleted row's. Checkpoints commit `rows` and `top` per ledger in a new `ledger_rows` column, added in place on existing files; a regression is a fall in either, or a gap beyond the greatest ever committed. The gap baseline is a MAXIMUM, which is the direction that cannot fabricate. Pinned in `ledger-identity.test.ts`, including the invariant it rests on: refusals, duplicates, deduplicated writes, a rolled-back transaction, a failed statement inside a committed one, `VACUUM` and `VACUUM INTO` are driven and none burns a rowid. **"driven over all 33 ledgers" was an over-claim, corrected in round twelve (Medium 2)**: that fixture populates about eight of the 33, so 25 passed trivially, and the file cited as the general evidence — `ledger-rowid-contiguity.test.ts` — had never existed on any commit. It exists now and carries the half that does generalize: which engine behaviours burn a rowid, established against the engine (a UNIQUE violation, a trigger `ABORT` and a rolled-back `SAVEPOINT` burn nothing; `INSERT … ON CONFLICT … DO UPDATE` DOES raise `sqlite_sequence`), plus a sweep of the whole `src/` tree asserting that no upsert, no `INSERT OR REPLACE`/`OR IGNORE`/`REPLACE INTO` and no `DELETE FROM` targets any of the 33. That covers all of them; the executed sampling stays where it was. |
| **HIGH 3** — ONE permitted APPEND into `hq_integrity_checkpoints` bricked the whole control plane with a FABRICATED finding no in-HQ act could clear | Appending is the write that ledger's own trio deliberately permits, and both readers took the stored columns at their word with no corroboration. Executed, no trigger dropped and no restart needed: an over-stated `ledger_marks` gave `regressed ["hq_reliability_verdicts","op_evidence"]` and `p2/p3 boot=true assess=true release=refused`, with HQ telling the Founder those ledgers "were DROPPED and are back empty" when nothing had touched them; `chain_length = 999999` did the same through `evidence_chain_broken` over a log that verified perfectly. This is the failure `immutableLedgerMarks` already forbids in the false-alarm direction as strictly as the false-reassurance one — it had not closed, it had MOVED from `sqlite_sequence` to the commitment ledger's own append, and it had got cheaper. | The over-claim is refused where it is WRITTEN: `trg_hq_integrity_checkpoints_no_overclaim`, declared beside the trio so its absence is a census finding, built over the ledgers the file carries and re-created on each construction. Every committed mark must be ≤ that ledger's current `MAX(rowid)` and every committed count ≤ its current `COUNT(*)`, which is exactly what HQ is about to write; `chain_length` is bounded by the same row's own `op_evidence` mark, which is the identity every genuine checkpoint has. Nothing any READER believes changed. |

**The read-time repair that was tried and REJECTED**, recorded because it is the
obvious one. Capping a commitment at read time by the engine's own high-water
mark defeats every forgery above — and hands back an evasion that is closed
today, because `sqlite_sequence` is writable: a tail truncation that also writes
the mark down is caught now, and under the cap one `UPDATE` would hide it again.
Two shipped tests fail on exactly that, and they are the right tests. Trading a
false alarm for a false reassurance is not a fix. The evasion is pinned in
`commitment-overclaim.test.ts` so the trade cannot be made quietly later.

### What this third seventh-round lane does NOT claim

- **`no_overclaim` is a step, not a boundary.** It costs three statements
  instead of one — `DROP TRIGGER`, the forged `INSERT`, re-create — which is
  what every other tamper in this module costs, and it carries the same standing
  residual: a guard dropped and re-created before the next boot is never
  observed missing, because the as-found census reads `sqlite_master` at
  construction time only. Executed and pinned at that price. What is closed is
  the INVERSION, where fabricating a finding was cheaper than everything else.
  **That price was FALSE from round seven to round twelve, and the sentence
  above is true again rather than softened.** The guard bounded a commitment
  with `json_extract`, which returns the FIRST value a duplicated JSON key
  carries, while `committedGreatest` read it back with `json_each` + `MAX`,
  which sees every one of them. So the cheapest path was ONE statement, not
  three: a single `INSERT` whose `ledger_marks` named the same ledger twice —
  the legal value first, the forged value second — passed the bound and landed
  the over-claim, with no trigger touched. Executed at `48dd026` on a file built
  by this package's own fixture: `{"op_evidence":999}` REFUSED,
  `{"op_evidence":4,"op_evidence":999}` ACCEPTED, then
  `regressedImmutableLedgers ["op_evidence"]`, `append_only_guard_missing` and
  `safeMode: true` at every depth and every process afterwards, about a log
  nothing had touched — the round-seven defect re-opened by a second route, in
  the fabricating direction. `ledger_rows` took the same shape; `chain_length`
  did not, in any of three variants, because it is a plain INTEGER column with
  no JSON parse. Closed by refusing the AMBIGUITY rather than by picking a
  winner between the two spellings: a `ledger_marks` or `ledger_rows` value
  whose `json_each` cardinality is not its distinct-key count is refused at the
  guard. That was chosen over teaching the guard to read `MAX`, because a third
  parse — `committedLedgerGaps`, which takes keys out of one column with
  `json_each` and looks their marks up in the other with `json_extract`, in one
  expression — cannot be aligned by any single choice of parse, and refusing the
  input makes all five readers agree. Pinned in `commitment-overclaim.test.ts`.
  **That re-pricing was itself wrong, and round THIRTEEN re-measured it by
  enumeration rather than by variant.** The round-twelve sentence said "the
  one-statement path is refused in every variant tried" — and every variant
  tried was a variant of the route round twelve had just fixed. The guard
  bounded `ledger_marks`, `ledger_rows` and `chain_length` and left `tip_hash`
  and the explicit `seq` unbounded, though a reader acts on each: one `INSERT`
  carrying HQ's own newest commitment with only the HASH changed fabricated
  `evidence_chain_broken` over a log that verified perfectly, and one `INSERT`
  carrying that commitment UNCHANGED at rowid 1000 fabricated
  `append_only_guard_missing` — 224 distinct single-`INSERT` shapes in all,
  counted by the enumeration that now ships. That figure was RE-MEASURED at the
  merged head rather than carried across it: with the pre-round-thirteen guard
  restored (`BEFORE INSERT`, no tip-hash clause, no rowid clause) and the other
  lane's `no_rowid_skip` dropped from this ledger, the shipped enumeration
  composes 7,240 shapes, 326 of them LAND, and exactly 224 of those make an
  intact store report something. Both latched permanently on an
  intact store; only a backup restore escaped. Both are bounded now, by a clause
  that mirrors `contradictedChainCommitment` exactly and by one that asserts the
  ledger's own row-count/greatest-rowid identity. The price is no longer
  asserted from the clauses that were looked at: `commitment-overclaim.test.ts`
  composes every hostile shape of every column the file declares, singly and in
  the full cross-product over the five that decide anything, and requires each
  to be refused at the write or to leave every reader silent — and the
  three-statement path is executed beside it and still reaches.
- **The rowid clause is why the guard fires `AFTER INSERT` rather than
  `BEFORE`.** In a `BEFORE INSERT` trigger on an `INTEGER PRIMARY KEY
  AUTOINCREMENT` column, an OMITTED rowid does not read as `NULL` — SQLite
  reports it as the integer `-1`, which a caller can also supply explicitly and
  which lands at rowid -1 and breaks the ledger's identity exactly as 1000 does.
  Measured, not assumed: the obvious `BEFORE` clause refused every checkpoint HQ
  writes. `RAISE(ABORT)` in an `AFTER INSERT` trigger rolls the statement back,
  so a refused commitment still never persists and burns no sequence value —
  executed under `INSERT`, `INSERT OR REPLACE` and `INSERT OR IGNORE` alike. The
  one visible consequence is that the guard's two clauses about its OWN ledger
  subtract the row being written, so the bound stays "what the file held when
  the commitment was written" rather than silently gaining one.
- **The recurring shape was PARTIAL ENUMERATION, and that is what round thirteen
  closed rather than the two columns.** Round seven bounded `ledger_marks`; its
  own follow-up bounded `ledger_rows` and `chain_length`; round twelve re-read
  all three and never looked one column over. Each round then shipped a price
  sentence resting on a clause set written out by hand. The obligation is now
  derived: `unboundedCheckpointColumns` reads `PRAGMA table_info` of the ledger
  as the FILE declares it and checks it against the guard as `sqlite_master`
  holds it, `CHECKPOINT_COLUMNS_THAT_DECIDE_NOTHING` names the four columns no
  reader reads, and a test fails when the two disagree — in both directions,
  including a guard re-created with one clause missing. A column added to this
  ledger is bounded, or explicitly excused, on the day it is added.
- **The duplicate-key refusal is a WRITE-TIME guard (`BEFORE INSERT` when this
  was written, `AFTER INSERT` since round thirteen; either way the statement is
  rolled back and the row never persists), so it bounds what LANDS and not what
  a file already holds.** A duplicate-keyed row written by a
  raw writer at a build without the clause is still read at its greatest value:
  planted at `48dd026`, then opened by the fixed build, it still gives
  `regressed ["op_evidence"]`, `append_only_guard_missing` and `safeMode: true`.
  Executed, not reasoned about. It is disclosed rather than closed by a
  read-time rule on one argument: no GENUINE file can carry such a row, because
  this ledger has exactly one writer and it writes both columns as
  `JSON.stringify` of a `Record<string, number>`, which cannot emit a duplicate
  key. Reaching the state needs a raw writer, and a raw writer already has the
  three-statement path to the same fabricated finding — so a read-time rule
  would buy nothing against an attacker while adding a fourth parse of these
  columns, which is the thing this correction exists to avoid.
- **A ledger created AFTER a construction is unbounded until the next one.** The
  guard's clause list is generated from the ledgers `sqlite_master` shows when
  the schema is ensured, because a trigger naming a table this file does not
  carry would throw at INSERT time and silently stop HQ committing anything at
  all — the worst outcome available. A capability registration that creates a
  declared ledger mid-process leaves that ledger unbounded in the guard until
  the next construction.
- **`sqlite_sequence` can still MANUFACTURE a finding, and this round did not
  close it.** Raising a declared ledger's `sqlite_sequence` row above its
  greatest rowid is one `UPDATE` and reports `append_only_ledger_truncated` over
  a ledger nobody has touched — measured at this head: `p2/p3 boot=true
  assess=true release=refused`, and `evidence_chain_broken` beside it when the
  ledger is `op_evidence`. It is the same class as HIGH 3 and it is NOT fixed,
  because the only bound available for that check is the number being written.
  Stated at its price rather than described away.
- **A raw writer can still weaken the gap baseline, and this bullet priced that
  wrongly until round thirteen (High 1).** It said the way in was "a forged
  checkpoint committing a LARGER gap than the file has raises the baseline" —
  per-ledger, per-value, and needing a declared table to be named. The cheapest
  path named no ledger at all and erased EVERY baseline at once: one `INSERT`
  whose `ledger_rows` carried an EMPTY key made `committedLedgerGaps` build
  `'$.' || j.key`, SQLite raise `bad JSON path: '$.'`, and the reader's own
  `try/catch` return `{}` — all 33 baselines gone, permanently, because the
  ledger is append-only. Measured against `237fc76`, control and attack identical
  but for that `INSERT`, over a mid-ledger delete of `hq_reliability_verdicts`
  rowid 2: control `p2..p6 boot=true["append_only_guard_missing"] assess=true
  release=refused`; attack `p2 boot=true assess=false[] release=ADMITTED` and
  `p3..p6 boot=false[] assess=false[] release=ADMITTED`. That was ONE statement
  against the three this module quotes everywhere else, in the
  false-reassurance direction, against the ledger that holds the safe-mode latch.
  Closed in both halves: the guard now admits only the shape HQ's own writer
  emits (`COMMITMENT_SHAPE_CLAUSES` — a valid JSON object, declared table names
  as keys, non-negative integers as values), and the reader builds no JSON path
  out of a key a row carries and fails CLOSED rather than open when the engine
  refuses it. **The "what remains" sentence that stood here was itself wrong, in
  the understating direction, on the page whose theme is that prices are
  measured** (Wave 5 correction round fourteen, Medium 1). It said the narrower
  route cost "the same three-statement price every other residual here pays",
  and ended "`no_overclaim` bounds marks and counts from above; it does not bound
  a gap from below, because a legitimate gap cannot be distinguished from a
  claimed one at write time". Both halves were false. The route cost ONE
  statement: an `INSERT` whose `ledger_rows` read `{hq_reliability_verdicts: 1}`
  — a declared key, valid JSON, a non-negative integer at or below what the file
  held, exactly the shape HQ's own writer emits — passed every clause, because
  each clause bounded a VALUE and none bounded the DIFFERENCE the reader
  consumes. Executed at `8481269`, control and attack identical but for that one
  `INSERT`, over a mid-ledger delete of `hq_reliability_verdicts` rowid 2:
  control `p2..p6 boot=true["append_only_guard_missing"] assess=true
  release=refused`; attack `p2 boot=true assess=false[] release=ADMITTED` and
  `p3..p6 boot=false[] assess=false[] release=ADMITTED`. And a legitimate gap
  CAN be distinguished from a claimed one at write time, because HQ's own writer
  commits `marks[t] = MAX(rowid)` and `rows[t] = COUNT(*)` from one reading: the
  gap it commits IS the file's gap, so bounding the committed difference by
  `MAX(rowid) − COUNT(*)` refuses the forgery and never refuses HQ. That clause
  is now in the guard, gated on the commitment naming a row count for the ledger
  so it is exactly as wide as `committedLedgerGaps` and no wider — a PARTIAL
  commitment, a row count with no mark beside it, is still admitted. **What
  remains** is the ordinary residual: with the guard temporarily dropped — three
  statements, counted in `commitment-gap-bound.test.ts` — the same append lands
  and the same silence follows. Still fail-OPEN, still silent, still not a
  fabricated finding, and now priced at what it actually costs.
- **A commitment written before this round carries no row count.** The
  `ledger_rows` column defaults to `'{}'` on existing rows, which is the truth
  about a row written before HQ committed any counts. The row-count and gap
  halves of the check begin at the next checkpoint that lands, which is the
  ordinary upgrade cost of a new commitment and not a defence.
- **The structural pass got more expensive, and the module header now says so.**
  Measured on the `warmedFile()` fixture: 52 statements executed per pass, of
  which 33 are a `COUNT(*)` + `MAX(rowid)` identity pair per declared ledger, 4
  are a further `MAX(rowid)` seek — **one per declared ledger the engine carries
  a positive `sqlite_sequence` row for, which is NOT the set HQ has committed
  marks for; on this very fixture it is four against three** — and 15 are
  catalogue, pragma and commitment-ledger reads that do not move. A `COUNT(*)`
  is O(rows) where the seek is not. It is paid deliberately, because the seek
  cannot see a row removed from the middle and the count can. 52 is this
  fixture's total and not the cost of a pass: the rule is
  `STRUCTURAL_STATEMENT_BASE` (48) plus one per seek, which is 50 on a file HQ
  has merely booted twice and 15 before the first commitment. (The figure this
  row carried for two rounds — "46 prepared statements per pass and 0.87 ms
  averaged over 50" — was wrong in both halves; see the two concurrent rounds
  below, and no duration ships anywhere any more. **The figures it carried after
  that — 48 / 44 / 46 / 11 — were wrong a FOURTH time, in the same direction,
  and are corrected here in round thirteen (Medium 1): the instrument that
  measured them wrapped `db.prepare` and could not see the four durability
  pragmas `readDurabilityPosture` reads through `db.pragma()`, which are exactly
  what the served sentence's own first clause promises a pass reads. The
  instrument counts `db.pragma` and `db.exec` now, and every figure above moved
  by four.**)
- **Nothing here closes the count-preserving in-place REWRITE of the commitment
  ledger.** That residual is unchanged, and `reliability-commitment-residual.test.ts`
  still enforces it.
- **A cost figure written in THIS document is read by no test.** The parse-back
  rule reaches `integrity.ts` — the served string, the module header and the
  docblock above `STRUCTURAL_STATEMENT_BASE` — and stops there. Executed:
  changing "52 statements executed per pass" in the bullet above to "61" leaves
  the whole suite green and unchanged. Re-EXECUTED at the reconciled
  round-thirteen head rather than carried over from either lane that measured
  it: **197 files / 3494 tests passed** with the wrong figure in place (it was
  191 / 3425 at `5126ffe`, 193 / 3442 at `582c239` and 193 / 3451 at the second
  lane's head — the price is the same at every one of them, which is the point).
  Disclosed at that price, with the cheapest close named, in the merge section
  at the end of this page.

### One residual RE-PRICED downwards at this head

The one-statement commitment repair — elide a row, then `DELETE FROM
sqlite_sequence` for the ledger rather than matching it — used to buy the forger
one clean process, including the Founder assessment it was aiming to pass. It
now buys none. The reason is HIGH 1's fix rather than a new check: HQ's
committed mark used to be gated on the ledger having a `sqlite_sequence` row, so
deleting that row meant HQ saw nothing to commit about its own commitment ledger
and appended nothing during the assessment. The mark is read from the ledger's
own rows now, so the first thing that assessment does is append a checkpoint,
which re-creates the high-water mark from the rowid the forged row still carries,
and the identity breaks inside the same process. Measured, and
`reliability-commitment-ledger.test.ts` is renamed and re-asserted to the new
price.

**Verification at the head this section describes** (the whole matrix, all
green, exit 0, every number measured rather than carried forward):
`npm run test:hq` **181 files / 3310 tests** at the head that section was written, and **182 files / 3319 tests** at the merge with the concurrent lane's rounds eight and nine; `npm test` (root) **37 files / 569
passed + 3 pre-existing skips**; `packages/hq-host` **23 files / 222 tests**;
`apps/hq-server` **2 files / 20 tests**; four typechecks clean
(`headquarter`, `hq-host`, `hq-server`, root build); `npm run build:site`
10 Headquarter pages + `hq-snapshot.json`; `npm run build` all workspaces, web
initial JS **215.66 kB / 69.22 kB gzip** — unchanged. Against `ae4bf90` this lane gained 3 files and 22 tests and lost none, and the
merge with rounds eight and nine gained one more file and nine more tests: no test file was deleted or
renamed, and no test file holds fewer `it(` than it did. The diff against the
accepted base `f1ce71c` touches `packages/server`, `packages/web`,
`packages/shared`, `packages/config-mesob`, `packages/hq-host`, `apps/`,
`package.json` and `package-lock.json` not at all; no `.skip`/`.only`/`.todo`/
`xit`/`xdescribe` was added anywhere, and no `as any`, `@ts-expect-error` or
`eslint-disable` appears in any added line.

## The EIGHTH correction round: three statements the wave's own corrections outran

A fresh read-only hostile review of the round-seven merged head returned **0
Critical / 0 High / 1 Medium / 2 Low**, and recorded that every
security-relevant claim it tested held under execution. All three findings are
documentation honesty, with zero runtime effect: no gate, guard, ledger or
route behaves differently than claimed. This round changes no behaviour. Every
statement below was already true of the code and false in the prose describing
it — the sixth consecutive round in which a disclosure, rather than a defect,
was the finding.

| Finding | What was wrong | What was done |
|---|---|---|
| **MEDIUM 1** — the depth sentence served to the Founder was false of the code it describes | `INTEGRITY_DEPTH_STATEMENT` — published as `depthStatement` on `hqReliabilityPosture`, i.e. read by the Founder verbatim — said a structural assessment "reads the schema catalogue and the durability pragmas **only**", and that a broken chain is found "only by the full assessment". Rounds five and six had given the cheap pass a `MAX(rowid)` seek per declared ledger, a `COUNT(*)` and an indexed lookup over `hq_integrity_checkpoints`, and it reports `append_only_ledger_truncated` and `evidence_chain_broken` itself. The module header's own point 3 was updated to say so; the shipped string, the depth table and the residual bullet were not. The Low 1 row of round six even records the cost wording being corrected in ONE place ("rather than keeping the old 'runs no table scan'") while this string kept it. Direction was under-claim — HQ detects more than it says, which is fail-safe and is exactly why nothing caught it. | The statement, the depth table and the residual bullet are corrected together, and the claim is now **derived rather than written**. `integrity-statement-truth.test.ts` induces all seven findings against a real file-backed database, runs BOTH depths over each induced state, and compares the executed full-exclusive set to the names parsed out of the shipped sentence. Measured at this head: `structural` raises `append_only_guard_missing`, `append_only_ledger_truncated`, `evidence_chain_broken`, `durability_below_requirement` and `reliability_schema_absent`; `full` raises all seven; only `database_integrity_check_failed` and `foreign_key_violations` need the full pass. The battery is required to reach the WHOLE vocabulary, so a new finding no scenario induces fails the test rather than silently escaping the partition. |
| **LOW 1** — the canonical safe-mode module's header contradicted its own constants | `integrity.ts` said a finding "is one of **six** names" fifteen lines above `HQ_INTEGRITY_FINDINGS`, which holds **seven** and whose own docstring says "Seven names"; and that "**Only three findings** engage safe mode", enumerating three, while `SAFE_MODE_BLOCKING_FINDINGS` holds **four** and its docstring says "The four findings". `append_only_ledger_truncated`, added by round six, was missing from the enumeration. Round six's sweep for exactly this stale sentence reached the phase doc and a test comment but not the module that DEFINES both constants. | Both counts corrected, all four blocking findings named by identifier, and the counts **pinned to the constants**: the same test parses the two numbers back out of the header and compares them to `HQ_INTEGRITY_FINDINGS.length` and `SAFE_MODE_BLOCKING_FINDINGS.length`, requires every blocking finding to be named in the paragraph, and requires every non-blocking finding NOT to be. Adding an eighth finding or a fifth blocking one now fails a test instead of quietly falsifying the prose. This is the pattern `INBOX_ORDERING_STATEMENT` has had since Phase 10; the integrity module simply never got it. |
| **LOW 2** — a superseded residual left unmarked in PHASE_14's NOT-fixed list | `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md` still told the reader that a cost entry's `mission_id`/`project_id` "still hold one value each" and that the columns can be read "but never as the measurement". Round six (High 3) added `mission_ids` and round seven (High NEW-4) added `project_ids`, and `#entriesForScope` measures from them; the H2 row in the same section already said so. Every other superseded statement in these docs carries an inline correction marker; this one did not. | Marked in the house style, with the narrower residual that does still hold stated in its place: the singular columns remain and carry the FIRST of the set for display. Behaviour was already pinned as route (d) in `intelligence-attribution.test.ts`. |

### What was swept, and what the sweep found

Because this is the sixth round in which a stale sentence was the finding, the
whole wave was swept for the same class rather than only the three sites
reported: every shipped statement carrying a literal count, an
only/always/never/every claim, or a named mechanism was checked against the
code. Checked and TRUE at this head, each measured rather than read:
`INBOX_ORDERING_STATEMENT`'s nine attention kinds against `ATTENTION_KINDS`
(already pinned); `COST_LEDGER_STATEMENT`'s four provenances against
`COST_PROVENANCES`; `BACKUP_RECORD_STATEMENT`'s three sidecar suffixes against
`SQLITE_SIDECAR_SUFFIXES` and its "an lstat, a realpath and three sidecar
lstats" against the call sites; `INTELLIGENCE_LATENCY_STATEMENT`'s "discriminates
between NO tiers" against `imposedFloor: null`; "All seventeen HQ destinations"
against `HQ_ROOMS` (17); "the sum of the six canonical buckets" against the six
summed terms; "the two decisions this model has … there is no third" against
`'approved' | 'denied'`; "at most one hour ahead and thirty days behind" against
`MAX_COST_OCCURRED_AT_FUTURE_MS` and `MAX_COST_OCCURRED_AT_PAST_MS`; PHASE_14's
"**46 call sites at this head**" (measured: 46) and "(29 at this head)"
(measured: 29); and the five other descriptions of the structural pass in this
document, which were already consistent with the corrected statement. No further
stale statement was found.

**Residual, stated rather than fixed:** three of those statements enumerate a
frozen constant in prose without being pinned to it —
`COST_LEDGER_STATEMENT`/`COST_PROVENANCES`,
`BACKUP_RECORD_STATEMENT`/`SQLITE_SIDECAR_SUFFIXES`, and
`INTELLIGENCE_LATENCY_STATEMENT`/the latency floor. All three are correct today
and none is load-bearing for a gate, so they are disclosed rather than changed
in a round scoped to three findings. The cheapest path when one is next touched
is one assertion apiece, of the shape `INBOX_ORDERING_STATEMENT` already
carries.

**Verification at the round-eight head** (the whole matrix, all green, exit 0):
`npm run test:hq` **179 files / 3292 tests** (round-seven head was 178 / 3288;
the whole delta is the one new file and its four tests); `npm test` (root)
**37 files / 569 passed + 3 pre-existing skips**; hq-host **23 / 222**;
hq-server **2 / 20**; typechecks clean for `@factoryos/headquarter`,
`@factoryos/hq-host` and `@factoryos/hq-server`; `npm run build:site` 10 pages +
`hq-snapshot.json`; `npm run build` all workspaces, web initial JS
**215.66 kB / 69.22 kB gzip** (unchanged). The diff against the accepted base
`f1ce71c` touches `packages/server`, `packages/web`, `packages/shared`,
`packages/config-mesob`, `package.json` and `package-lock.json` not at all, and
no test file was deleted or renamed. Zero new dependencies.

**The new tests were verified to FAIL against the round-seven head** rather than
merely to pass here: `ae4bf90` was extracted to a scratch tree, the new file
overlaid on it alone, and all **4 of 4 failed** — the depth statement's derived
list absent (`expected null to be truthy`), the retired "durability pragmas
only" wording still present, `expected 6 to be 7`, and `expected 3 to be 4`.
The eight-scenario battery itself RAN clean against that head, which is the
point: the behaviour was already correct and only the sentences describing it
were not.

## The NINTH correction round: a credential class closed for its twin and not for itself, and the sentence that hid it

A fresh read-only hostile review of the round-eight head (`ae4bf908`) returned
**0 Critical / 1 High / 1 Medium / 1 Low**, all reproduced by execution, and
recorded that every other security-relevant claim it tested held. The branch had
fast-forwarded to `3bdb2d1` under the review; the corrections are on that head.

| Finding | What was wrong | What was done |
|---|---|---|
| **HIGH 1** — `\p{Co}` PRIVATE USE carried a credential past the guard onto the unauthenticated artifact, disclosed nowhere | Executed end to end on the round-eight head: `createTask({title: 'sk-<U+E000>ABCDEFGHIJKLMNOP0123456789'})` was ACCEPTED where the plain form is refused `invalid_input`, `liveSnapshotFromOperations` and `assertBrowserSafe` both PASSED, and the written `hq-snapshot.json` carried `"title": "sk-ABCDEFGHIJKLMNOP0123456789"` with the hidden code point intact and invisible; U+F8FF and U+100000 behaved identically. That end-to-end run is the REVIEW's measurement. Reproduced independently at this lane before the fix, and the number this round measured itself: on `3bdb2d1`, all six credential shapes (`sk-`, `ghp_`, `github_pat_`, `AIza`, a PEM header, `Bearer `) passed `assertBrowserSafe` for U+E000, U+F8FF, U+100000 and U+FFFFD, and a sweep of the whole category found **137,468 of 137,468 private-use code points surviving** — 0 after the fix. The class is 137,468 code points and it was in no residual list, no comment and no test. Round seven had closed `\p{Cn}` on the argument that an unassigned code point has no glyph and does not occur in prose — the argument applies verbatim to `\p{Co}`, so one twin was closed and the other left open. | `\p{Co}` joins `ERASED_CODE_POINTS` beside `\p{Cn}`, with the same argument recorded at the code. Pinned two ways in `redaction-invisible-classes.test.ts`: all **137,468** private-use code points swept against the guard (0 survivors, and the count asserted so a narrowed sweep is visible), and the three the review executed refused in all six credential shapes. False positives measured, not assumed: the five accented-prose languages and every legitimate string the shipped suite pins still pass, and CJK, Arabic and emoji prose were added to that list. One measured price is disclosed below. |
| **MEDIUM 2** — a shipped sentence claimed a full-plane sweep that existed nowhere | `credential-scan-cost.test.ts` said "the full-plane sweep lives in `live-redaction.test.ts`". That file's largest sweep is a 65-code-point C0/C1 block; the only `0..0x10ffff` loops in the package are in `redaction-invisible-classes.test.ts` and they COLLECT members of a named category rather than testing the plane against the guard, with the `\p{Cn}` case sampling every 997th point. This is the sentence a reviewer reads to decide the sweep is complete and stop looking, and it is why HIGH 1 survived seven rounds. | The sentence is made TRUE rather than merely corrected. A real whole-plane sweep was added: every one of the **1,112,064** non-surrogate code points is pushed through `assertBrowserSafe` inside `sk-…`, and no member of the zero-ink categories — named independently of the guard, so dropping one from `ERASED_CODE_POINTS` fails here — may survive. Measured at this head: 1,112,064 visited, **155,327 survivors, 0 of them zero-ink, 17 of them `\p{Zs}`**. The survivor count is asserted non-zero so a guard that refused everything could not pass vacuously, and the `\p{Zs}` count is pinned exactly, so the one deliberately open class cannot change size without the disclosure moving with it. Runtime ~11 s. |
| **LOW 3** — two published numbers on one served decision record could still contradict, via a forged column | Round seven made one computation answer both the served `floorTier` and the avoidability flag, but fed that computation `characteristics` carrying only the CANONICAL risk class, while the record publishes `maxRequiredReviewTier(stored, canonical)` — the max, deliberately, so a forged NULL cannot drop the requirement. A raw `required_review_tier` ABOVE the canonical class therefore still produced the pair the source comment says cannot both be true: `floorTier: deterministic_local` beside `requiredReviewTier: critical_review`. Needs a raw DB write and is fail-closed (`satisfiesReviewRequirement: false`, and the decision drops out of `provablyAvoidable`), so nothing rested on it; what was wrong is what was PUBLISHED. | The served floor is the `max` over the review tier the record actually SERVES, not over the canonical one alone. Pinned by a hostile raw APPEND — the write the append-only triggers permit, so no guard is dropped — of a `read_only` decision carrying a forged `critical_review`: the served floor now reads `critical_review`, `floorTierAsRecorded` still reads `deterministic_local` so the forgery stays visible, and the fail-closed behaviour is unchanged. The legitimate path is untouched: an unrecognized stored floor is left exactly as it is rather than raised to a recognized tier the row never earned. |

### What this round does NOT claim, and the price it measured

- The anchoring residual is unchanged and still open: `Xsk-…` and `9sk-…` reach
  a written `hq-snapshot.json`, because `(?<![A-Za-z0-9])` deliberately does
  not fire inside a letter run — `task-oriented-approach` literally contains
  `sk-oriented-approach`. Architecture, not anchoring, is the guarantee.
  (The anchor was written here with an underscore in the class for one round,
  which was the `\b` behaviour this wave's own Critical C1 removed: `_` INSIDE
  the class would let `OPENAI_KEY_sk-…` onto the artifact. The code has never
  had it — corrected in round ten, Low 1. Verified at that head: the code
  refuses `OPENAI_KEY_sk-…` and `_sk-…`, and passes `Xsk-…` and `9sk-…` exactly
  as disclosed above.)
- `\p{Zs}` is still not folded, on the argument that has not changed.
- **The measured price of closing `\p{Co}`, stated rather than hidden:** a
  private-use code point sitting exactly where a word character would otherwise
  anchor the prefix — `ta<U+E000>sk-oriented-approach` — is refused. That
  refusal is NOT caused by this round: `assertBrowserSafe` tests every pattern
  against the raw string as well as the folded copy, and in the raw string the
  character before `sk-` is a private-use code point rather than the `k` that
  makes the plain word legitimate. It is pinned as a `toThrow` beside the plain
  word's `not.toThrow`, so the boundary is recorded rather than discovered
  again. No accented, CJK, Arabic, Greek, Cyrillic or emoji prose is affected.
- LOW 3 is a coherence fix on a published pair, not a new defence. The forgery
  it concerns was already fail-closed and still needs raw database write.
- The whole-plane sweep asserts that no member of the NAMED zero-ink categories
  survives. JS cannot measure ink, so naming the categories is the practical
  proxy for "a reader cannot see it", and that is stated at the test rather
  than implied.

**Verification at the round-nine head** (the whole matrix, all green, exit 0):
`npm run test:hq` **179 files / 3297 tests** (round-eight head was 179 / 3292;
the whole delta is five new tests in two existing files); `npm test` (root)
**37 files / 569 passed + 3 pre-existing skips**; hq-host **23 / 222**;
hq-server **2 / 20**; typechecks clean for `@factoryos/headquarter`,
`@factoryos/hq-host` and `@factoryos/hq-server`; `npm run build:site` 10 pages +
`hq-snapshot.json`; `npm run build` all workspaces, web initial JS
**215.66 kB / 69.22 kB gzip** (unchanged). The diff against the accepted base
`f1ce71c` touches `packages/server`, `packages/web`, `packages/shared`,
`packages/config-mesob`, `packages/hq-host`, `apps`, `package.json` and
`package-lock.json` not at all, and no test file was deleted or renamed. Zero
new dependencies.

**Each fix was verified to FAIL pre-fix** rather than merely to pass here: the
source file was reverted to its `3bdb2d1` content from a scratch copy held
outside the worktree, the new tests run against it, and the file restored. The
measured pre-fix failures are recorded with each finding above.

## The merge of round seven's third lane with rounds eight and nine

`origin` moved from `ae4bf90` to `6ce93df` while the third round-seven lane
worked. Merged, never rebased; no commit of theirs is discarded and no assertion
of theirs is weakened. Three files conflicted, and two of the three conflicts
were the two lanes fixing the SAME defect:

- **The module header's counts.** Both lanes found "one of six names" (seven)
  and "only three findings engage safe mode" (four) — this lane as Low 1, theirs
  as round eight. THEIRS survives on the merits: it names the four blocking
  findings individually AND pins both counts to the constants they describe with
  a derived assertion (`integrity-statement-truth.test.ts`), where this lane
  only corrected the prose. A count in a docstring that nothing checks is what
  made the error possible in the first place.
- **The cost paragraph.** Round eight rewrote it to say the structural pass
  makes "one `MAX(rowid)` seek per declared ledger, and one `COUNT(*)` plus one
  indexed lookup over HQ's own small commitment ledger — none of which is
  proportional to the size of a ledger". That was true of THEIR head and false
  of the merged one within the same wave: closing High 2 costs a `COUNT(*)` per
  declared ledger, and a `COUNT(*)` is proportional to the rows a ledger holds.
  This lane's measured version survives, with round eight's correction named as
  the thing it supersedes and why.
- **`INTEGRITY_DEPTH_STATEMENT`, which ships to the Founder verbatim.** Not a
  marked conflict — it auto-merged — and it carried the same now-false "none of
  those is proportional to the data" clause. Corrected at the merge, keeping the
  mechanisms round eight's own test requires it to name.
- **The two phase pages' new sections.** Both lanes appended; both are kept, in
  round order.
- **Phase 14's superseded residual.** Both lanes found it (this lane's Low 6,
  theirs' round-eight Low 2). Theirs survives whole — it cites the predicate and
  states the narrower residual that does still hold — with one clause folded in
  from this lane: round FOUR is where the sentence first stopped being true.

**One seam no conflict marker showed, and it was a real test failure.** Round
eight's `integrity-statement-truth.test.ts` corrupts a fixed page —
`pageCount - 2` — to produce `database_integrity_check_failed`, which is a bet
on the file's layout. This lane added a column to the commitment ledger and a
row count per declared ledger, the layout moved under the bet, and the scribble
landed where the durability pragma itself could not read past: the scenario
failed with `database disk image is malformed` thrown out of
`readDurabilityPosture` rather than asserting anything. The scenario now chooses
its page by OUTCOME — it looks for a page whose corruption the catalogue read and
the pragmas survive, and fails loudly if the file carries none — which is what
it always meant and is no longer a bet.

Verification at the merged head, all green, exit 0: `npm run test:hq`
**182 files / 3319 tests**; root `npm test` 37 / 569 + 3 pre-existing skips;
`packages/hq-host` 23 / 222; `apps/hq-server` 2 / 20; four typechecks clean;
`build:site` 10 pages + `hq-snapshot.json`; `npm run build` web initial JS
215.66 kB / 69.22 kB gzip, unchanged. Measured against both parents rather than
assumed: this lane's head 181 / 3310, theirs 179 / 3297. The merge is above
both, and no test file holds fewer `it(` than it did on either side.

## The TENTH correction round: a frozen `Set` that was not, and three claims that outran their code

A read-only hostile reviewer read `3bdb2d1` — the round-EIGHT head — concurrently
with the lane that produced round nine above, neither knowing about the other,
and returned **0 Critical, 0 High, 2 Medium, 2 Low**, every one reproduced by
execution. This section describes the merged head: round nine's four commits are
untouched, and nothing below re-opens any of them.

One of the four was a genuine code defect. The other three were false shipped
claims — the seventh consecutive round in which a defect turned out to live in a
disclosure rather than in the code, which is why the absolutes sweep below was
run over the whole wave rather than over the three sites the review named.

| Finding | What was reproduced | What changed |
|---|---|---|
| **MEDIUM 2** — "a frozen `Set`/`Map` is frozen in CONTENT" was false, and a TEST TITLE advertised a proof it did not execute | Round seven answered the mutable-collection finding with own, non-configurable throwing `add`/`set`/`delete`/`clear`. An own property shadows the prototype for DIRECT property access only. `Set.prototype.clear.call(x)` reads no property of `x` at all — it reaches the internal slot — and emptied a `deepFreeze`d `QUEUED_UNREACHABLE_STATUSES` in ONE statement: `frozen? true`, `.clear() refused`, then `after Set.prototype.clear.call: [] size= 0` and `has("done") now: false`. That is the vocabulary `service.ts` decides `task_beyond_claiming` on; emptied, the barrier stops firing. `Set.prototype.add`/`delete` and `Map.prototype.set` reached the same way. Meanwhile `frozen-constants-census.test.ts` carried the title *"a frozen Set or Map is frozen in its CONTENTS, not only in its shape"* while asserting only that the four shadowed properties throw. | **FIXED, not narrowed.** There is no way to make a REAL `Set` refuse the prototype spelling short of patching `Set.prototype` for the whole process, so `deepFreeze` no longer hands out a real `Set`: it returns a `Proxy` over one, and the raw collection is closed over and never escapes. A `Proxy` carries no `[[SetData]]` slot, so `Set.prototype.clear.call(view)` throws `TypeError: Method Set.prototype.clear called on incompatible receiver`. Direct `view.clear()` still throws HQ's own `TypeError`, from the own stub returned verbatim by the trap (returning anything else would violate the proxy invariant for a non-configurable own property). **`forEach` had to be rewritten rather than forwarded**: it hands its callback the collection it was called on as a THIRD argument, and forwarding the raw target there was a one-statement escape — found by executing the naive design before it shipped, not after. Reading is untouched: `has`, `get`, `size`, `forEach`, `keys`/`values`/`entries`, `for…of`, spread, `Array.from`, the ES2025 set-composition methods, `instanceof Set` and `Object.isFrozen` all behave as before, and a nested or self-referential collection resolves to its view rather than to the raw reference. Measured cost, stated rather than waved away: a bare `.has()` is about 15 ns direct and about 38 ns through the view; the package has exactly two frozen collections (census over every `src/` module outside `src/cli/**`, enumerated and floored by `frozen-constants-census.test.ts` rather than hand-counted — the "122" this cell used to name was never the count at any head in this repository's history, which runs 121 then 123 and was 131 on the day the sentence was written; round thirteen) and two call sites — one `.has()` per task, one per query token — so the added cost is bounded by a few microseconds per search and `deepFreeze` itself runs only at module load. The test title now executes the prototype spelling, the `forEach` escape, the full read surface, a nested collection and a cycle. |
| **MEDIUM 1** — the project-scope derivation was documented as "unforgeable", and the residual priced the attack above its cheapest path | Phase 14 said the third term was "monotone and **unforgeable** … because `hq_mission_events` is engine-guarded", and scoped the residual to "a mission created with a project by a build older than the commanded-event detail, never re-assigned through the facade". A guard is a row in `sqlite_master` and this ledger carries no hash chain, so a CURRENT-build mission that WAS assigned through the facade is stripped in one count-preserving pass. Executed: `BEFORE gov=["deployment","project:task_project"] tiers=["deterministic_local"] criticalReview ok=false`; facade route unchanged (correctly still blocks); raw column unchanged (correctly still blocks); then 3 rows rewritten and `inplace gov=["deployment"] tiers=[all five] criticalReview ok=TRUE`. | **NARROWED AND DISCLOSED**, which is what the finding is: a disclosure defect, not a new capability. Closing it needs a hash chain over `hq_mission_events`, a material new mechanism this wave's own residual list already declines for the whole guarded-but-unhashed class. So "unforgeable" is gone from the derivation's header, from the `spentUnder` comment, from `intelligence-command.ts` and from both Phase 14 rows, replaced by "monotone against every SUPPORTED route"; and the count-preserving in-place rewrite class is now carried for this ledger in Phase 14's NOT-fixed list at its executed cost — three `DROP TRIGGER`, one `json_remove` update, three `CREATE TRIGGER`, one column clear; no `DELETE`, no `INSERT`, no row-count change, zero restarts, zero Founder acts. **The sweep found the same class also empties the `spentUnder` half** — the same one pass rewriting `mission_ids`/`project_ids` on `hq_intel_cost_entries` took an exhausted ceiling's `observed` from 5000 to 0 for a task that HAS spend of its own, the half three rounds had called always-held — and that both `structuralIntegrity` and `fullIntegrity` report `safeMode: false` with no observation afterwards. Both SUPPORTED routes remain correctly closed, pinned. |
| **LOW 1** — `INTEGRITY_DEPTH_STATEMENT`'s cost clause understated its own structural pass, and was not pinned | The Founder-facing sentence said "one `MAX(rowid)` seek per declared ledger, and one `COUNT(*)` plus one indexed lookup over HQ's own small commitment ledger". `EXPLAIN QUERY PLAN`: `committedLedgerMarks` is `SCAN c` / `SCAN j VIRTUAL TABLE` / `USE TEMP B-TREE FOR GROUP BY`; the `COUNT(*)` is a covering-index SCAN; only `contradictedChainCommitment` is an indexed lookup. Direction fail-safe. | Re-MEASURED rather than re-estimated, and corrected in all three places it was restated (the constant, the module header, and this page's depth table). Counting the statements one pass executes: 15 on a warm store — three catalogue reads, TWO `MAX(rowid)` seeks for each of the three ledgers HQ has COMMITTED a mark for (not one per each of the 33 DECLARED), three `sqlite_sequence` reads, and three reads of the commitment ledger. And the ledger is not fixed in size: executed, it grows a row per clean boot AND per clean assessment. The round-eight statement-truth pin was GROWN rather than replaced — it was confirmed genuine — with three derived assertions: the seek count from instrumenting `db.prepare`, the ledger read's shape from `EXPLAIN QUERY PLAN` over the statement the pass really ran, and the growth from executing a boot and an assessment. |
| **LOW 2** — the NFKD mark-strip introduced a new credential-shape false positive on accented hyphenated names | `ŠK-Slovan-Bratislava-1919` passed before this wave — `Š` is a precomposed `Lu` that `NFKC` leaves alone — and is refused now, because the `NFKD` strip folds it to `S` and the case-insensitive `sk-` rule fires, refusing the whole snapshot. The round-seven measurement was scoped to "accented prose in five languages", which does not cover hyphenated proper names. | **DISCLOSED, argued, and stated by enumeration rather than by adjective.** The class is exact: 53 non-ASCII letters fold to `s` and 42 to `k`, and a string is newly refused when one of the first is followed by one of the second at a non-alphanumeric boundary, then `-`, then 16+ of `[A-Za-z0-9_-]` — all 53 executed, all 53 refuse. Nothing wider: `Škoda-Auto-Mladá-Boleslav`, `Sköldebrand-Åkerström-Handelsbolaget` and `Ćwikliński-Żółkiewski-Przedsiębiorstwo` each execute and each pass, as do the twelve legitimate multi-script strings. Not fixed, because the ASCII spelling `SK-Slovan-Bratislava-1919` was ALREADY refused before this wave — the over-breadth is in the `sk-` shape, which accepts `-` in its tail because a real key does (`sk-proj-…`) — so the fold added SPELLINGS of an existing over-refusal rather than a new class, and narrowing a credential rule to buy back an availability cost measured at one two-letter prefix is a change in the direction of under-refusal. The evasion direction is re-executed and unmoved: U+0301, U+20DD, U+0378, U+05BF and U+0E31 are all still caught. **ROUND FOURTEEN (Low 5) adds the class this cost did not name: a git BRANCH NAME.** This repository's own automation protocol mandates `ai/<issue>-<slug>` and `claude/<slug>` branches, and a branch name routinely reaches a facade text field — a mission title, a task title, a plan-item summary, a note. `feature/sk-rework-of-the-evaporation-model` is REFUSED, and so are `ai/271-sk-rework-of-the-evaporation-model`, `claude/sk-rework-of-the-evaporation` and the bare `sk-rework-of-the-evaporation-model`: the rule is `(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}`, so a slug beginning `sk-` at any non-alphanumeric boundary with sixteen or more following characters meets it. The class is REAL and it is NARROW, and both halves are the disclosure: measured over fifteen real and near-miss branch names, 5 are refused and 10 pass, including `ai/267-sk-rework` (too short), `docs/sk-notes`, `feature/task-scheduler-improvements`, `feature/skew-correction` and `ai/12-skip-broken-test`. The boundary is measured on both sides (`feature/sk-abcdefghijklmnop` refused, `feature/sk-abcdefghijklmno` passed). The DECISION is unchanged for the reason above — the ASCII spelling was already refused, and narrowing a credential rule to buy back availability is a change in the direction of under-refusal — and the class is executed in `credential-scan-false-positive-class.test.ts` rather than described. |

### The absolutes sweep this round ran, and what it found

Because the same word had already been found false once in this wave, every
added line in the wave diff (49,827 of them) was grepped for `unforgeable`,
`impossible`, `cannot be`, `can never be`, `no way to` and neighbouring
absolutes, and each hit was checked against the count-preserving in-place
rewrite class specifically — by EXECUTING the class, not by reading the
sentence. Five live claims rested on engine triggers over a table with no hash
chain and are corrected: `service.ts`'s `#durableTaskProjectScopes` header and
its `spentUnder` comment, `intelligence-command.ts`'s scope-array docblock, and
the two Phase 14 rows. Two more were corrected on the same test:
`mission-command.ts`'s schema comment ("a row's identity can never be replaced
… a linked task id can never be re-pointed … a row can never be DELETED" — all
three hold against every writer that has not first removed the guard, which is
what it now says), and `ARTIFACT_DIGEST_STATEMENT`, served to a Founder, which
said a changed `recordDigest` "is impossible rather than merely detectable" and
had it exactly backwards at this class: it is detectable and not impossible.
Claims that already NAMED their scope were left standing — `product-command.ts`'s
"cannot be produced through any path this repository has" is true as written —
and historical quotations of retired claims were left as history. One hit sits
outside the wave and is recorded rather than edited: `PHASE_9_MISSION_ROOM_
COLLABORATION.md`'s "`withheld` unforgeable" is a different mechanism on a page
this wave does not touch.

### What this round does NOT claim

- Medium 2 is closed for the collections `deepFreeze` returns. A caller who
  builds their own `Set` and never passes it through `deepFreeze` is unaffected,
  which is the point: this is a property of `deepFreeze`, not of `Set`, and the
  census test says so by executing an ordinary `Set` beside a frozen one.
- The proxy is not a security boundary against code running in the same
  process. It withholds the raw collection from a caller who asks politely and
  from the three spellings a caller would reach for; a process that can patch
  `Set.prototype` or read another module's closure was never in scope here.
- Medium 1 and Low 2 change no behaviour at all. Both are disclosure
  corrections, and the residual each names was executed before it was written.
- Low 1's direction was fail-SAFE throughout: HQ always did MORE than the
  sentence said, never less. Nothing about detection changed; only the sentence.

**Verification at the round-ten head** (the whole matrix, all green, exit 0):
`npm run test:hq` **181 files / 3314 tests** (round-nine head was 179 / 3297;
the delta is two new test files and twelve new tests in two existing files);
`npm test` (root) **37 files / 569 passed + 3 pre-existing skips**; hq-host
**23 / 222**; hq-server **2 / 20**; typechecks clean for
`@factoryos/headquarter`, `@factoryos/hq-host` and `@factoryos/hq-server`;
`npm run build:site` 10 pages + `hq-snapshot.json`; `npm run build` all
workspaces, web initial JS **215.66 kB / 69.22 kB gzip** (unchanged). The diff
touches `packages/headquarter/` and `docs/HEADQUARTER/` only, no test file was
deleted or renamed, and there are zero new dependencies.

**Each fix was verified to FAIL pre-fix.** The tree at `3bdb2d1` was extracted
with `git archive` into a scratch directory outside the worktree, the four new
and extended test files were overlaid on it, and the suite run: **11 of 26
assertions failed there, across all four files** — four in the frozen-collection
census, three in the cost-clause pin, three in the project-scope residual pin,
and one in the credential false-positive class pin.

## The merge of round seven's third lane with round ten

`origin` moved again, from `6ce93df` to `f867299`, while the previous merge was
being verified. Merged, never rebased; nothing of round ten is discarded or
weakened. Three files conflicted.

- **`INTEGRITY_DEPTH_STATEMENT` and the module header's cost clause.** Round ten
  re-measured this clause with `EXPLAIN QUERY PLAN` and by counting the
  statements a pass executes, and its measurement was right about the head it was
  taken at and wrong about the merged one — because the concurrent round-seven
  lane was closing High 2 in the same wave, and reading each declared ledger's
  row COUNT is what sees a row removed from the MIDDLE. So the clause has now
  been wrong THREE times in one wave, in the same direction, and every correction
  is recorded rather than the latest written as if it had always been there.
  The round-eleven re-measurement — "46 statements per structural pass and
  0.871 ms averaged over 50" with "one further `MAX(rowid)` seek per COMMITTED
  ledger" — shipped to the Founder verbatim and was wrong in both terms. **Two
  concurrent lanes off this same base found it independently, and both are
  recorded below**: round eleven's Medium 1 re-measured the total at 48 and
  retired the duration outright; round twelve's Medium 1 showed that no total
  can be right, because the seek term is a census. Instrumented on that lane's
  own `warmedFile()` construction, a pass executed 47 statements, not 46, and 48
  at the head that corrected it; on a plain established file it executed 46. The
  number was never a constant. And the seek set is not the committed set: the
  standalone seek is taken while walking `sqlite_sequence`, so it reached four
  ledgers where HQ had committed marks for three, and it can reach a ledger HQ
  has committed nothing about.
- **So no total is written in prose any more, and no duration either.** The cost
  is stated as the RULE:
  `STRUCTURAL_STATEMENT_BASE` (44 — the 33 identity reads plus the 11 fixed
  catalogue, pragma and commitment-ledger reads) plus one statement for each
  declared ledger carrying a positive `sqlite_sequence` row, on a file HQ has
  committed on — measured at 46 with two such ledgers and 48 with four. Before
  the first commitment there is nothing to compare a ledger against, so the 33
  identity
  reads do not run at all and a pass is 11 statements; quoting the committed-on
  figure as the cost of every pass would overstate that case four times over, so
  both branches are stated. The base is a constant the Founder-facing sentence
  interpolates rather than restates, and
  `integrity-statement-truth.test.ts` asserts the rule against instrumented
  counts on two files whose seek terms differ, decomposes one real pass into its
  three terms, and parses every number in both prose sites back out and compares
  it to the measurement. **No timing figure ships at all** — round eleven's
  point, kept over round twelve's "still under a millisecond", because a
  duration that reads 0.830 ms on one machine and 1.023 ms on another is not a
  property of the code and no test can pin one; a test now forbids `millisecond`,
  a bare `ms` and any `<number> ms/seconds` shape from returning to the served
  sentence. The reason all three corrections were needed is the same one
  each time: the pin never compared a number to anything.
- **Round ten's pin, grown rather than replaced — and grown again in round
  twelve, because its TITLE claimed more than its assertions executed.** It was
  called "counts both reads: an identity per declared ledger, a seek per
  committed one" while asserting only that the seek count equalled the seeked-set
  size and that the size was under 33 — neither of which can tell the committed
  set from any other, which is exactly how the wrong set shipped. It now compares
  the seeked set to the `sqlite_sequence` set it really comes from and shows it
  DIFFERENT from the committed set on the same file. Its test asserted "two
  `MAX(rowid)` seeks per committed ledger, not one per declared one", which is
  the right shape of assertion and the wrong numbers at the merged head. It now
  counts BOTH reads — the identity per declared ledger and the standalone seek,
  which the bullet above establishes is per `sqlite_sequence`-carrying ledger
  and not per committed one — and asserts each against the census rather than
  against the sentence, which is strictly stronger than either lane's version.
  Both retired phrasings are still pinned as retired, by their exact shape, and
  "one further `MAX(rowid)` seek for each ledger HQ has committed a mark for"
  joins them.
- **Phase 14's H2 cell.** Both lanes corrected the same sentence. Round ten's
  correction survives on the merits — it disproves "unforgeable" by execution
  rather than by argument, with a count-preserving in-place rewrite of
  `hq_intel_cost_entries` — with this lane's distinct point folded in: even
  "monotone against every supported route" is the THIRD term's doing, and the
  sentence shipped false in rounds four, six and seven.

Verification at this merged head, all green, exit 0: `npm run test:hq`
**184 files / 3336 tests**; root `npm test` 37 / 569 + 3 pre-existing skips;
`packages/hq-host` 23 / 222; `apps/hq-server` 2 / 20; four typechecks clean;
`build:site` 10 pages + `hq-snapshot.json`; `npm run build` web initial JS
215.66 kB / 69.22 kB gzip, unchanged.

## The TENTH correction round, SECOND LANE: the commitment ledger rolled back to a PREFIX of itself

Two independent read-only hostile reviews gated `6ce93df`, exactly as rounds
six and seven were gated twice, and this page carries both lanes' corrections.
The lane above is the frozen-`Set` and three-claims lane; this one is the
commitment-ledger lane. They touch the same two source files and neither
finding overlaps the other's; the merged head is what every number below was
measured at unless a number is explicitly attributed to a pre-merge head.

A fresh read-only hostile review of `6ce93df` returned **0 Critical / 1 High /
0 Medium / 2 Low**, all reproduced by execution.

| Finding | What was wrong | What was done |
|---|---|---|
| **HIGH 1** — a PREFIX replay of HQ's own commitment ledger defeated all four commitment checks at once, permanently, and cleared a latched safe mode | `DROP TABLE hq_integrity_checkpoints`, replay the table's own DDL out of `sqlite_master`, and re-insert a PREFIX of its own genuine rows at the rowids they already carried. No hash is recomputed — every row written back is one HQ itself wrote — and no header write is needed, because round seven's yes/no witness stays true. `AUTOINCREMENT` rebuilds `sqlite_sequence` from those explicit rowids, so `elidedCommitmentLedgerRows`' `rows === top === mark` identity holds at a DIFFERENT number; `truncatedImmutableLedgers` compares `MAX(rowid)` against that same rebuilt mark and is satisfied; `regressedImmutableLedgers` reads `ledger_marks` out of the checkpoints just erased, and the surviving oldest checkpoint's own mark for this table is always at or below its own rowid; `contradictedChainCommitment` takes the maximum over the SURVIVING commitments, which the attacker chose. The `rows === 0` witness branch never runs, because the ledger is not empty. Measured by the review on a real file through the real facade: **18 statements** took commitments **7 → 1** and evidence **9 → 4**, with `boot=false []`, FULL Founder assessment `false []`, reboot `false []` and `releaseKillSwitch` **ADMITTED**; a file latched at `["append_only_guard_missing","evidence_chain_broken"]` read `false []` at boot, at full assessment and across two further reboots after a 25-statement rollback over three ledgers; and once the commitment ledger was rolled back this way, rows could be erased from any of the 33 declared ledgers with no finding at any depth. | The header slot now records HOW FAR the commitment ledger has ever reached, not merely THAT it has been reached. `application_id` carries the signature `0x4851` (`HQ`) in its high 16 bits and the greatest rowid the ledger has ever held in its low 16 bits, raised by `recordCommitmentWitness` and never lowered. `elidedCommitmentLedgerRows` reports a ledger holding fewer rows, or a lower greatest rowid, than that mark. A `DROP TABLE` cannot lower a number in the database header. **"and a replay cannot raise the ledger to meet it" stood here and was FALSE — see round thirteen's HIGH 2 below**: the mark is a COUNT, so a replay that PADS the prefix up to it with copies of a surviving row meets it exactly, and is silent from the very next boot. What the mark still closes is the UNPADDED replay this row measured. Reproduced independently at this lane before the fix (7 statements at `6ce93df`, 8 at the merged head where the ledger carries a fourth guard; commitments 4 → 1, `elided=false`, `regressed=[]`, `truncated=[]`, `contradicted=null`, `boot=false [] full=false [] reboot=false []`, release ADMITTED) and closed after it (`boot=true [append_only_guard_missing] full=true`, release refused, across three restarts). |
| **LOW 1** — the phase document stated an anchor that would reopen the wave's own Critical | This page wrote the negative lookbehind with an underscore inside the character class. The code (`src/live/redaction.ts`) has never had the underscore and must not: `_` inside the class is the `\b` behaviour that carried `OPENAI_KEY_sk-…` onto the unauthenticated artifact (round four, Critical C1). The code was stronger than the document said, which is the direction a future reader "corrects" the wrong way. | The `_` is dropped from that sentence, and the drift is now machine-checked: `redaction-narrow-spaces.test.ts` reads every negative lookbehind out of `redaction.ts` itself, asserts they are all `(?<![A-Za-z0-9])`, and asserts this document nowhere spells the underscore form — which is why the sentence above describes it in words rather than quoting it. The behaviour on both sides of the boundary is pinned beside it: `OPENAI_KEY_sk-…` and `_sk-…` refused, `Xsk-…` and `9sk-…` admitted as disclosed. |
| **LOW 2** — the `\p{Zs}` residual was retained on a justification whose only worked example does not hold | The comment said folding the class "would join ordinary prose into fabricated credential shapes (`...ask -driven-workflow`)". The review reverted-to-test it on a scratch copy with `\p{Zs}` folded across a 40-string corpus: exactly **1** verdict changed and that string was contrived, while the doc's own example was still ACCEPTED — the `(?<![A-Za-z0-9])` anchor sees the `a` of `ask`, and the run is far too short for `{16,}`. Meanwhile the residual carried a whole key to the unauthenticated artifact for all seventeen members, and "a space is visible, so it hides nothing" is at its weakest for U+2007 FIGURE SPACE and U+200A HAIR SPACE. | The fifteen `\p{Zs}` separators that are not a plain space — U+1680, U+2000–U+200A, U+202F, U+205F, U+3000 — are erased from the scan copy. U+0020 and U+00A0 are deliberately left alone: those two are what prose is made of, and folding them would join every word of every sentence. The whole-plane sweep's `\p{Zs}` survivor count moves **17 → 2**, and the two are now named rather than counted. The false-positive cost was measured rather than assumed, and so was the mechanism. |

### What the tenth round measured, including where a first attempt did not work

- **The `\p{Zs}` fold cannot live in `ERASED_CODE_POINTS`, and that was found by
  running it rather than by reasoning about it.** That set is applied LAST, and
  `NFKC`/`NFKD` run before it — compatibility normalization maps fourteen of the
  fifteen onto a plain U+0020. With all fifteen added to the erase set and
  nothing else changed, the whole-plane sweep still found **16** `\p{Zs}`
  survivors carrying a key; only U+1680, the one member with no compatibility
  decomposition, dropped out. The erase therefore happens on the RAW string,
  before any normalization, and the ordering property is pinned by a test that
  asserts the decompositions themselves.
- **The false-positive cost of that fold, measured on the typography that
  actually uses those separators.** French narrow-no-break and thin-space
  punctuation around `:`, French grouped numbers, and Japanese/Chinese prose
  spaced with U+3000 were run against the guard with the fold in place, together
  with the shipped multilingual corpus and every string the existing suites pin:
  **zero refusals changed**. The retired justification's own example is pinned as
  still ACCEPTED, so the sentence cannot come back.
- **The seven legitimate operations the review confirmed clean were re-run
  against the header mark, and all seven stay clean:** `VACUUM`, `.backup()`,
  `VACUUM INTO`, a failed `INSERT` inside a committing transaction, an explicit
  `ROLLBACK`, a `UNIQUE`/`RAISE(ABORT)` abort, and `SAVEPOINT` + `ROLLBACK TO`.
  The header slot survives all three whole-file copies, and none of the four
  failed or undone writes moves it. A `PRAGMA application_id` write is
  TRANSACTIONAL in this engine — verified rather than assumed, and pinned —
  which is what stops the stamp made inside a clean assessment's reservation
  from surviving a rollback of that reservation as an inflated mark.
- **HQ cannot walk its own finding back.** A genuine checkpoint appended by HQ's
  own writer onto a rolled-back ledger lands at a lower rowid and leaves the
  header alone, so the file stays blocking. Pinned.

### What the tenth round adds to the NOT-fixed list

- **One further `PRAGMA application_id` write buys any of the erasures back.** A
  writer that rewrites the header to a mark matching the prefix it replayed — or
  to zero, which returns the file to unwitnessed — is silent again: measured at
  this head as ONE statement, after which boot, full assessment and reboot all
  read `false []`. This is the same residual class as zeroing `PRAGMA
  user_version` or rewriting `sqlite_sequence`. HQ holds no key over its own
  file, and every fact this module rests on lives in the file the attacker is
  already writing.
- **The count-preserving in-place REWRITE is unchanged and remains the cheapest
  surviving forgery.** It elides nothing, so it changes no count, no rowid and no
  header mark. Its price is one `BEFORE UPDATE` trigger dropped and re-created on
  each engine-guarded ledger the forgery touches.
- **The header mark saturates at 65,535.** Past that many committed checkpoints
  it stops advancing, so a rollback WITHIN the saturated range is not caught;
  any rollback below 65,535 still is. Pinned by an encoding test.
- **Exactly one mark value is given up, in the fail-open direction.** A genuine
  mark of 17,232 encodes to the legacy round-seven stamp `0x48514350` and is read
  back as "witnessed, mark unknown", so the check is vacuous for that ONE
  checkpoint out of 65,535 and repairs itself at the next. Pinned.
- **The witness signature is now 16 bits rather than an exact 32-bit value.** A
  foreign file whose `application_id` begins with the ASCII `HQ` is read as
  HQ-witnessed — the same consequence that already existed for the single legacy
  value, now 65,536 times more likely and still requiring a foreign application
  to have chosen an id beginning `HQ`. Corroborating the witness with `PRAGMA
  user_version` was considered and rejected: it would let ONE statement against
  `user_version` defeat both marks at once.
- **A file committed on by a build older than this mark carries no mark until its
  next checkpoint stamps one.** The ordinary upgrade cost of any new mark, in the
  fail-open direction.
- **Two `\p{Zs}` members still carry a key to the artifact:** U+0020 and U+00A0.
  Deliberate, argued above, and pinned by name in the whole-plane sweep.

**Verification at the MERGED round-ten head** (both lanes, all green, exit 0):
`npm run test:hq` **186 files / 3357 tests** (this lane alone was 181 / 3318 on
top of `6ce93df`'s 179 / 3297); root `npm test` **37 files / 569 passed + 3
pre-existing skips**; hq-host **23 / 222**; hq-server **2 / 20**; typechecks
clean for `@factoryos/headquarter`, `@factoryos/hq-host` and
`@factoryos/hq-server`; `npm run build:site` 10 pages + `hq-snapshot.json`;
`npm run build` all workspaces, web initial JS **215.66 kB / 69.22 kB gzip**
(unchanged). The diff against the accepted base `f1ce71c` touches
`packages/server`, `packages/web`, `packages/shared`, `packages/config-mesob`,
`packages/hq-host`, `apps`, `package.json` and `package-lock.json` not at all,
and no test file was deleted or renamed. Zero new dependencies.

**One interaction between the two lanes, recorded because it changes the
attack rather than only the code.** The other lane's overclaim guard is a
`BEFORE INSERT` on the commitment ledger that refuses a checkpoint claiming
more than the file can support. It therefore refuses a genuine checkpoint row
replayed AFTER the ledgers it commits to have been shortened — so the prefix
replay has to roll the commitment ledger back FIRST, while the file is still
intact, which costs the attacker nothing and walks round that guard entirely.
The two fixes are not substitutes: the guard closes a forged commitment, and
the header mark closes a genuine one that has been rolled back. The ordering is
executed in `reliability-commitment-prefix-replay.test.ts` rather than argued.

**Each fix was verified to FAIL pre-fix** rather than merely to pass here: the
source file was reverted to its `6ce93df` content from a scratch copy held
outside the worktree, the new tests run against it, and the file restored.
Measured: `reliability-commitment-prefix-replay.test.ts` **13 of 13 failed**
(three of them the bare `expected false to be true` on
`elidedCommitmentLedgerRows` for the three attack shapes);
`reliability-commitment-ledger.test.ts` **2 of 11 failed** and
`reliability-commitment-residual.test.ts` **1 of 6**, which are the three
assertions that pinned a residual this round CLOSES and are now stronger in every
line; with `redaction.ts` and this document reverted,
`redaction-narrow-spaces.test.ts` failed on U+1680 and on the underscore anchor
in this page, and `redaction-invisible-classes.test.ts` failed with
`['U+0020','U+00A0','U+1680', …(14)]` against the expected two.

## The ELEVENTH correction round: a served number that was wrong a third time, and two annotations that outran their tests

A fresh read-only hostile review of `48dd026` returned **0 Critical / 0 High /
1 Medium / 2 Low**. It manufactured no blocking finding: the commitment-witness
closure held under prefix replay at all six prefix lengths, full replay to
empty, prefix plus forged padding, `DELETE` all plus `DELETE FROM
sqlite_sequence`, and the combination attack; `PRAGMA application_id` is
transactional on this engine, including under `SAVEPOINT`/`ROLLBACK TO`. All
three findings are honesty defects in prose, and none of them is a security
hole. **Nothing in this round changes security behaviour.**

The round is recorded here because all three share one cause, and it is the
cause this wave keeps rediscovering: **a number that no test reads.**

### MEDIUM 1 — the cost clause was wrong a THIRD time, in the same direction, inside the sentence written to stop it

`INTEGRITY_DEPTH_STATEMENT` is served to the Founder as `depthStatement` on
`GET /api/hq/control/reliability`. It said "Measured on a real file, the whole
pass is **46 statements** and under a millisecond". The module header said
"**46 statements** per pass and **0.871 ms** averaged over 50 … **Pinned in
`integrity-statement-truth.test.ts` rather than estimated**", and this document
repeated both.

Re-measured at this head by instrumenting `db.prepare` on the branch's own
`statementsExecutedByOneStructuralPass` call site, five runs, deterministic:
**48**, not 46.

**The "Pinned … rather than estimated" clause was false**, and that is the more
serious half. `integrity-statement-truth.test.ts` pinned the SHAPES of the
reads rigorously — identity reads equal to `ENGINE_IMMUTABLE_TABLES.length`,
strictly fewer standalone seeks than that, `EXPLAIN QUERY PLAN` asked of the
engine, retired phrasings asserted absent — and pinned **neither number**.
That is precisely why a figure re-measured one round earlier drifted again
while every test in the file kept passing. The clause had already been wrong
twice in this wave, in the same direction, and the sentence recording those two
corrections was itself the third.

**The fix is not a better constant, because a bare total cannot stay right.**
Two of its three terms are censuses rather than constants. Measured on the
deterministic `warmedFile()` fixture:

| Term | Scales with | Measured |
|---|---|---|
| `COUNT(*)` + `MAX(rowid)` identity read | ledgers DECLARED | 33 |
| further `MAX(rowid)` seek | ledgers HQ has COMMITTED a mark for | 4 |
| catalogue, pragma and commitment-ledger reads | nothing — fixed | 11 |
| **total** | | **48** |

> **The middle row's "Scales with" is itself wrong, and the merge with the
> concurrent round-twelve lane corrects it** — see the merge section at the end
> of this page. The standalone seek is taken while walking `sqlite_sequence`, so
> it is one per declared ledger the engine carries a positive `sqlite_sequence`
> row for. On this very fixture that set has four members where HQ has committed
> marks for three, so the counts coincide and the sets do not, and a
> count-only assertion passes on the wrong rule. **The served sentence therefore
> ships no total at all in the merged code**: it ships
> `STRUCTURAL_STATEMENT_BASE` (33 + 11 = 44) plus one per seek, which is 48 on
> this fixture, 46 on a file HQ has merely booted twice, and 11 before the first
> commitment. This round's three measured TERMS survive unchanged and are
> asserted term by term; only the second term's attribution and the shipping of
> a total are superseded.

The served sentence and the module header now state the three terms and the
census they were measured against, and a new test asserts each term off one
real pass, requires the total to be their sum, and **parses every number back
out of both prose sites and compares it to the measurement**. Nothing retypes a
figure for the prose to agree with. Mutation-checked three ways rather than
asserted: restoring `46` in the served sentence fails (`expected 46 to be 48`),
drifting the header's sum to `33 + 4 + 9 = 46` fails (`expected [33,4,9,46] to
deeply equal [33,4,11,48]`), and reintroducing `0.871 ms` fails.

**No duration is shipped anywhere any more, and none should have been.** The
retired figure was 0.871 ms; the same measurement re-run at this head gives
**0.830 ms** on this machine, and the review that found the error measured
**1.023 ms** on another. A number that moves with the machine is not a property
of the code and no test can pin one, so the sentence now claims nothing about
time and a test forbids a timing figure from returning.

### LOW 1 — a census annotation stated 225 where its own code measured 226

`frozen-constants-census.test.ts` annotated its floors with "131 modules and
225 distinct bindings at this head; the entry-point scan reaches 202 of them."
Instrumented at this head: **131 files, 226 distinct bindings, 0 unfrozen**.
The assertion is a floor (`>= 225`) and passed, so only the annotation was
stale — by one.

The `202` was worse than stale: it was a round-six measurement of a
BARREL-based entry-point scan that `reliability-verdict-durability.test.ts` has
since replaced with a path-based enumeration of `src/`, so it had stopped
describing anything at all, and nothing asserted it anywhere.

Corrected the way Medium 1 was: the floor is raised to the measured **226**, the
`202` is dropped, and the numbers are now stated **only in the assertion** —
not restated in prose beside it, which is what allowed the two to disagree. The
floors stay floors on purpose: new exported vocabulary is ordinary, and the
thing worth failing on is the enumeration SHRINKING.

### LOW 2 — "it cannot build `sk-`, `ghp_` … out of prose that did not carry one" is false of the fold

`redaction.ts` wrote that inference twice — once for the narrow-space fold and
once for the combining-mark fold — and `redaction-invisible-classes.test.ts`
repeated it a third time for `\p{Co}`. The premise is true and the conclusion
does not follow: **removing a separator concatenates the tokens on either side
of it**, so the scan copy can hold a prefix that no contiguous run of the
original held. The same paragraph half-conceded it two sentences later ("What
it CAN do is close a gap") while the sentence above still denied it.

Executed against the real guard, and now pinned in
`redaction-narrow-spaces.test.ts`: `the gh<U+200A>p_…`, `AI<U+3000>za…` and
`Bear<U+200A>er …` carry no `ghp_`, `AIza` or `Bearer ` anywhere in the raw
string and are all **REFUSED**, while the identical three strings written with
a plain U+0020 — which this fold deliberately does not erase — are all
**admitted**. That pair isolates the join as the whole cause.

**The residual is not under-priced and the fold stays.** The review measured it
over **138,600** real strings — this repository's own `PHASE_13` prose,
`store/integrity.ts`'s source, and a French/Polish typography corpus, each
against the 15 separators in 2 substitution styles — and found **15 verdicts
changed, all 15 of them new refusals of one contrived `gh<U+200A>p_…` string,
0 new accepts and 0 changes on real prose**. The direction is conservative: the
cost is a false refusal on a contrived string, never a leak. So only the
sentence changes, in all three places, and the retired wording is quoted rather
than silently overwritten.

### Verification at the eleventh-round head

All green, exit 0. Baseline re-measured on this head (`e58b95c`) before any
edit, and again after:

| Check | Before | After |
|---|---|---|
| `npm run test:hq` | 190 files / 3397 tests | **190 files / 3401 tests** |
| `npm run typecheck --workspace @factoryos/headquarter` | clean | clean |
| `@factoryos/hq-host` test + typecheck | 23 / 222, clean | **23 / 222**, clean |
| `@factoryos/hq-server` test + typecheck | 2 / 20, clean | **2 / 20**, clean |
| root `npm test` | 37 / 569 + 3 skips | **37 / 569 + 3 pre-existing skips** |
| `npm run build:site` | 10 pages | **10 pages** + `hq-snapshot.json` |
| `npm run build` web initial JS | 215.66 kB / 69.22 kB gzip | **215.66 kB / 69.22 kB gzip** |

Four tests added, no test file added, deleted, renamed, skipped or weakened.
The diff against the accepted base `f1ce71c` touches `packages/server`,
`packages/web`, `packages/shared`, `packages/config-mesob`, `packages/hq-host`,
`apps`, `package.json` and `package-lock.json` **not at all**, and this round's
own diff is confined to `packages/headquarter/` and `docs/HEADQUARTER/`. Zero
new dependencies.

**Each new assertion was verified to FAIL pre-fix** rather than merely to pass
here — the source file was reverted to its `e58b95c` content from a scratch
copy held outside the worktree, the new tests run against it, and the file
restored. `integrity-statement-truth.test.ts`'s new test failed on
`the depth statement must state its declared ledgers: expected null to be
truthy`; `redaction-narrow-spaces.test.ts`'s new source assertion failed on
`expected … not to contain 'it cannot introduce a letter, so it'`.

**Stated honestly, because it is the point of Low 2:** the two BEHAVIOURAL
tests added for the join pass against the pre-fix source as well, and always
would have. The code was never wrong; only the sentence about it was. That is
exactly why nothing caught it for a round, and it is the same failure mode as
Medium 1 one level up — a claim no execution was ever compared against.

## Wave 5 correction round twelve — the over-claim guard bypassed at ONE statement, and four measurements that had never been compared to anything

A fresh read-only hostile review of `100a927` returned 0 Critical / 1 High /
4 Medium / 5 Low. The work below was done on `48dd026`, which origin had already
moved to (one further commit plus a merge), so every line number and every
measurement was re-derived at that head rather than carried over.

**HIGH 1 — `no_overclaim` was bypassed by a duplicate JSON key, at one
statement.** `json_extract` returns the FIRST value a duplicated key carries and
`json_each` sees every one of them, so the guard bounded a commitment at the
legal value while `committedGreatest` read it at the forged one. Detail, the
executed reproduction, the choice of fix and the re-priced residual are in the
`no_overclaim` bullet of the NOT-fixed list above. Closed by refusing the
ambiguity at the guard rather than by choosing a winner between the two
spellings, because a third parse — `committedLedgerGaps` — uses both in one
expression and cannot be aligned by any single choice.

**Every reader of these columns was checked against every other**, which is what
the choice of fix rests on. `ledger_marks` has five: two guard clauses
(`json_extract`, first value), `committedGreatest` (`json_each` + `MAX`, greatest
value), `committedLedgerGaps` (`json_extract`, first value, paired with
`json_each` over the other column) and the single writer. `ledger_rows` has the
guard clause (`json_extract`), `committedGreatest` and `committedLedgerGaps`
(both `json_each`). `chain_length` has three readers and none of them parses
JSON — it is a plain INTEGER column — which is why chain forgery was refused in
every variant and only the mark/row half was open.

**MEDIUM 1** — the cost clause, wrong a third time and in the same direction;
now stated as a rule with a pinned constant, and the pin compares the seeked set
to the set it really comes from. **MEDIUM 2** — a cited test file that had never
existed; written, and the citation corrected to what is actually executed, with a
sweep that fails whenever `src/` names a test file the package does not have.
**MEDIUM 3** — the cost row a reader actually consults, still carrying the
retired wording two rounds after it was retired everywhere else. **MEDIUM 4** —
the disclosed remedy for a lost commitment ledger does not exist; the lockout is
now stated plainly and a Founder-gated re-seat is argued down rather than
shipped. All four are recorded at their own sites above.

**The five Lows.** Low 1: the fold's class sentence claimed completeness its
enumeration could not see (three multi-character folds and eight non-letters);
corrected, and shown by execution that none of the eleven is a cost the fold
added, because all eleven already folded under `NFKC`. Low 2: the residual's own
`UPDATE` named two of the four columns it needs, and did not reproduce as
written; both variants now executed. Low 3: thirteen/ten corrected to
fifteen/twelve, the two unnamed refusals named, and both counts pinned against
the constant. Low 4 was subsumed by Medium 1. Low 5: `deepFreeze` kept the RAW
collection at a property it could not repoint, and was not idempotent over a
structure holding a view; both closed rather than disclosed, because "no call
site reaches it today" is the reasoning the freeze census exists to stop anyone
relying on.

**Verification at the round-twelve head, MERGED with the concurrent round-ten
lane** (the whole matrix, all green, exit 0): `npm run test:hq` **191 files /
3421 tests** (this lane alone was 187 / 3381 on top of `48dd026`'s 186 / 3357;
the other lane's `e58b95c` brought the rest);
root `npm test` **37 files / 569 passed + 3 pre-existing skips**; hq-host
**23 / 222**; hq-server **2 / 20**; typechecks clean for
`@factoryos/headquarter`, `@factoryos/hq-host` and `@factoryos/hq-server`;
`npm run build:site` 10 pages + `hq-snapshot.json`; `npm run build` all
workspaces, web initial JS **215.66 kB / 69.22 kB gzip** (unchanged). The diff
against the accepted base `f1ce71c` touches `packages/server`, `packages/web`,
`packages/shared`, `packages/config-mesob`, `packages/hq-host`, `apps`,
`package.json` and `package-lock.json` not at all, and no test file was deleted
or renamed. Zero new dependencies.

**The merge kept both lanes and re-measured rather than re-asserted.** Three
files conflicted. In `contracts/freeze.ts` and
`test/frozen-constants-census.test.ts` both lanes had appended to the same
region and both sides are kept whole. In this page the other lane had rewritten
the non-`AUTOINCREMENT` bullet while this one rewrote the `DROP TABLE` bullet
immediately after it; their rewrite and this correction are both kept. **One
number moved because of the merge and the new pin is what caught it**: the other
lane added a sixteenth backup refusal, `would_latch_safe_mode`, so the count
corrected above from thirteen to fifteen went stale again inside the same round
and is now sixteen, with thirteen exercised. That is the pin doing the job the
absence of one had left to reviewers three times.

**Each fix was verified to FAIL against `48dd026`** rather than merely to pass
here, by checking the new tests out into a `git archive` of that head: 12
assertions fail there — `commitment-overclaim.test.ts` **3 of 13** (the two
duplicate-key routes and the ambiguity refusal; the two controls and the
three-statement price pass at both heads, which is what makes them controls),
`integrity-statement-truth.test.ts` **2 of 8**, `reliability-durability.test.ts`
**2 of 55**, `frozen-constants-census.test.ts` **2 of 11**,
`credential-scan-false-positive-class.test.ts` **1 of 8**,
`intelligence-project-scope-residual.test.ts` **1 of 8**, and
`ledger-rowid-contiguity.test.ts`'s citation sweep, which reports exactly one
missing file against a pristine checkout of that head — the file the sentence it
corrects had cited. The other seven assertions in that new file pass at both
heads by design: they pin a property that was already TRUE at `48dd026`, where
the defect was the evidence for it rather than the property itself, and a pin
that failed there would mean the store had a rowid burn it does not have.

## The merge of correction rounds eleven and twelve

`origin` moved to `46f409b` — the round-eleven lane — while the round-twelve
lane was being verified locally at `ba13d99`. Both were taken off the same base,
`e58b95c`, so neither contains the other. Merged, never rebased: the result is a
true merge commit with both parents, and **nothing from either lane is
discarded**. Two files conflicted with markers
(`docs/HEADQUARTER/PHASE_13_ADVANCED_RELIABILITY.md` and
`packages/headquarter/src/store/integrity.ts`); three more overlapped without
one and are treated below as the seams they are.

Both lanes' round sections are kept whole and in order — round eleven, then
round twelve — because each contains measurements the other never took. What
follows is only what the merge itself had to decide.

### The duplicate fix: the cost clause, corrected twice, independently

Both lanes found the same defect — `INTEGRITY_DEPTH_STATEMENT` and the module
header shipping "46 statements per pass and 0.871 ms averaged over 50 … Pinned
in `integrity-statement-truth.test.ts` rather than estimated", where the file
pinned neither figure. **One implementation survives, on the merits, and both
lanes' regression tests are kept and ported.**

- **Round twelve's derivation survives.** Round eleven's replacement stated a
  three-term census and shipped its total: 33 identity reads per DECLARED
  ledger + 4 seeks per ledger HQ has **COMMITTED** a mark for + 11 fixed reads =
  48. The second term's attribution is wrong. The standalone seek is taken while
  walking `sqlite_sequence`, so it is one per declared ledger the engine carries
  a positive `sqlite_sequence` row for. On round eleven's own `warmedFile()`
  fixture those two sets have the same SIZE — four — while HQ has committed
  marks for three, so round eleven's assertion
  `expect(Number(committedClaim![1])).toBe(seeks.length)` passed on the wrong
  rule, which is the exact failure mode its own round was written to stop.
  Round twelve compares the seeked SET to the `sqlite_sequence` SET and shows it
  different from the committed set on the same file, which is a comparison a
  count cannot fake. It also shows why no total can be shipped at all: the seek
  term is a census, so the same code costs 48 statements on the warmed fixture
  and 46 on a file HQ has merely booted twice, and 11 with zero identity reads
  before the first commitment. So the served sentence ships
  `STRUCTURAL_STATEMENT_BASE` (33 + 11 = 44) plus one per seek, as a rule.
- **Round eleven's three measured TERMS survive**, unchanged, and are now
  asserted term by term off one real pass — 33 identity reads, 4 seeks, 11 fixed
  reads, and the base required to be the two of them that do not move with the
  store's history. Round twelve had measured the total and the seek census but
  had never decomposed the fixed remainder.
- **Round eleven's NO-DURATION rule survives, and it is the stricter one, so it
  wins over round twelve's wording.** Round twelve kept "Either way it runs in
  under a millisecond" in the served sentence. That is a duration, it was
  measured at 0.871 ms when it shipped, at 0.830 ms on one machine and 1.023 ms
  on another, and no test can pin one. It is removed from the served sentence
  and from the module header, and round eleven's assertions are kept verbatim —
  `/millisecond/i`, `/\bms\b/` and `/\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?)\b/i`
  may not match `INTEGRITY_DEPTH_STATEMENT`. Executed: putting "Either way it
  runs in under a millisecond" back fails with `expected 'A structural
  assessment reads the sch…' not to match /under a millisecond/i`.
- **Round eleven's PARSE-BACK rule survives and is applied to round twelve's own
  prose, which had escaped it.** Round twelve wrote the rule instead of a total
  and then illustrated it with four figures no test read: "carries two such
  ledgers and executes 46 statements; one carrying a run attempt carries four
  and executes 48", "measured at 11 statements and ZERO identity reads", and
  "overstate the unestablished case by four times". Writing a rule does not
  exempt the numbers that illustrate it. Every one of them is now read back out
  of the source — the module header, and the docblock above
  `STRUCTURAL_STATEMENT_BASE` — and compared to the pass this test just
  instrumented. Executed: drifting the docblock's `46` to `47` fails with
  `expected [ 2, 47, 4, 48 ] to deeply equal [ 2, 46, 4, 48 ]`.

Round eleven's test keeps its identity and its assertions; it is renamed from
"ships a total that is its own three measured terms, and no duration at all" to
"ships its three measured terms and no total or duration at all", because under
the merged rule the served sentence ships no total. Nothing was deleted,
skipped, weakened or narrowed: the merged file carries both lanes' tests, and
the merged suite is at or above both parents in test files and in per-file `it(`
count.

### The five seams, and how each was resolved

Three of them carried no conflict marker at all.

1. **`INTEGRITY_DEPTH_STATEMENT` and the module header** (marker). Resolved
   above.
2. **`integrity-statement-truth.test.ts`** (NO marker — both lanes appended
   different tests to the same describe block, so git merged them silently).
   Round eleven's new test asserts against prose round twelve had already
   rewritten. Left alone it would have required the served sentence to say "with
   marks committed for 4 of them" and "that is 48 statements", both of which the
   merged sentence correctly refuses to say. Ported to the merged rule: the term
   assertions and the arithmetic stay, the wrong-set claim is replaced by an
   assertion that the sentence attributes the seek to the `sqlite_sequence`
   census AND does not carry the retired attribution, and the total assertion is
   replaced by `not.toMatch(/\d+ statements(?! plus one for each of those
   seeks)/)` — the base in the rule form is the only statement count the
   sentence may carry. Executed: restoring "one further seek per committed one"
   fails.
3. **This page's cost row and residual bullet** (marker on one, none on the
   other). Round eleven rewrote the "structural pass got more expensive" bullet
   to "4 are a further `MAX(rowid)` seek per COMMITTED ledger"; round twelve had
   rewritten the depth table at the top of this page to the `sqlite_sequence`
   attribution. Both are now the `sqlite_sequence` attribution, with the
   four-against-three difference stated where the number is, and the bullet says
   48 is that fixture's total rather than the cost of a pass. Round eleven's own
   section keeps its table and carries a quoted correction of the one row the
   merge changed, rather than being silently rewritten. One further sentence in
   the round-seven/round-ten merge section — "the identity per declared ledger
   and the standalone seek per committed one" — was superseded by round twelve's
   finding and is corrected here.
4. **`frozen-constants-census.test.ts`** (NO marker — round eleven edited the
   floors near the top, round twelve appended a `deepFreeze` describe block at
   the bottom). Round eleven's annotation asserts the floors ARE the measurement
   at this head, so the merge had to re-measure rather than assume: instrumented
   at the merged head, **226 distinct bindings, 131 files, 0 unfrozen** — round
   eleven's raised floor of 226 is still exactly the measurement after round
   twelve's `freeze.ts` changes, which add no exported ALL-CAPS binding. Both
   sides kept unchanged.
5. **`redaction.ts` and the citation sweep** (NO marker — round eleven rewrote
   the two "it cannot build a prefix" paragraphs, round twelve rewrote the
   s-then-k class paragraph between them). The two corrections are about
   different claims and neither contradicts the other: round eleven's is about
   what an ERASE can join, round twelve's is about what a single-letter
   enumeration could SEE. Round twelve's citation sweep — which fails whenever
   `src/` names a `*.test.ts` the package does not have — was run against round
   eleven's new sentences, which cite `redaction-narrow-spaces.test.ts` and
   `live-redaction.test.ts`; both exist and the sweep passes.

### Verification at the merged head

All green, exit 0, run in this worktree. **This table describes `5126ffe`** —
the merge of the two lanes named in its own column headings, not the head this
page currently sits at; the later reconciliation section below re-measures every
row against the head that carries both that work AND the other round-eleven
lane's.

| Check | Round eleven (`46f409b`) | Round twelve (`ba13d99`) | Merged (`5126ffe`) |
|---|---|---|---|
| `npm run test:hq` | 190 files / 3401 tests | 191 files / 3421 tests | **191 files / 3425 tests** |
| repo-wide `*.test.ts` files | 252 | 253 | **253** |
| repo-wide `it(` declarations | 4039 | 4059 | **4063** |
| `typecheck @factoryos/headquarter` | clean | clean | clean |
| `@factoryos/hq-host` test + typecheck | 23 / 222, clean | 23 / 222, clean | **23 / 222**, clean |
| `@factoryos/hq-server` test + typecheck | 2 / 20, clean | 2 / 20, clean | **2 / 20**, clean |
| root `npm test` | 37 / 569 + 3 skips | 37 / 569 + 3 skips | **37 / 569 + 3 pre-existing skips** |
| `npm run build:site` | 10 pages | 10 pages | **10 pages** + `hq-snapshot.json` |
| `npm run build` web initial JS | 215.66 kB / 69.22 kB gzip | same | **215.66 kB / 69.22 kB gzip** |

No test file in either parent is missing from the merge, and **no file has fewer
`it(` declarations than it had in either parent** — enumerated file by file
rather than compared in total. Nothing was deleted, renamed, skipped, weakened
or narrowed; no `.skip` / `.only` / `.todo` / `xit` / `xdescribe` was added, and
no `as any`, `@ts-expect-error` or `eslint-disable` appears in an added line.
Zero new dependencies. The diff against the accepted base `f1ce71c` touches
`packages/server`, `packages/web`, `packages/shared`, `packages/config-mesob`,
`packages/hq-host`, `apps`, `package.json` and `package-lock.json` not at all.

Both lanes' headline guarantees were re-executed here rather than carried over:
the duplicate-key over-claim and the plain over-claim are both REFUSED
(`commitment-overclaim.test.ts`, 13 tests); the cost pin compares the seeked set
to the `sqlite_sequence` set and shows it different from the committed set; the
citation sweep passes; the backup-refusal count pin passes; the sealed-property
`deepFreeze` escape throws; round eleven's term census, no-duration rule and
parse-back rule all hold, with the three mutations above executed to show they
are not vacuous.

### The one residual the merge leaves standing, executed before it is written

**A cost figure written in THIS document is still read by no test.** The parse-
back rule the merge extended reaches `integrity.ts` — the served string, the
module header, and the docblock above `STRUCTURAL_STATEMENT_BASE` — and stops
there. Executed rather than reasoned about: changing "48 statements executed per
pass" in the residual bullet above to "61 statements executed per pass" and
running the whole suite gave **191 files / 3425 tests passed**, unchanged —
**measured at `5126ffe`**, the head this section describes. The suite has grown
since; the reconciled table below carries the current figure. The point stands
whatever the count is: the figure is wrong and nothing fails.

It is disclosed rather than closed, and the price is stated rather than argued.
It is not a defect this merge introduced — both parents already carried
unasserted cost figures on this page, and it is the same class the wave has now
hit four times. What the merge did do is move every such figure in the SOURCE
under a test, which is where the served sentence and the constant come from; a
figure on this page is a description of them and cannot reach the Founder except
by being read here. The cheapest close is a doc parse-back of the same shape as
`reliability-durability.test.ts`'s backup-refusal count pin, which already reads
a number out of this page and compares it to a constant. That is a separate,
scoped change with its own review, not something to fold into a reconciliation
whose rule is that nothing is discarded and nothing new is invented.

## The reconciliation of the two round-eleven lanes with round twelve

Three lanes ran off `e58b95c`. Two of them have already been reconciled with
each other above (`46f409b` + `ba13d99` → `5126ffe`). This section records the
merge of that result with the THIRD lane — the round eleven that closed the
backup verdict's missing half, the `string[]` blind spot in the caller-text
scan, the refusal-vocabulary count, and two holes in the frozen-collection view
— and it re-measures every row rather than carrying either parent's numbers
forward.

**Nothing was discarded.** Every finding, test, guard and correction from both
parents is in the merged head. Two files conflicted textually and one
measurement conflicted semantically; all three were resolved by shipping the
stronger guarantee and keeping the other side's assertions passing against it.

### The three seams, and how each was resolved

1. **`contracts/freeze.ts` — the nested-collection repoint.** Both lanes edited
   the same four lines. One made the proxy target a PRIVATE COPY of the argument
   (`new Set(argument)` / `new Map(argument)` with the argument's own property
   descriptors carried over), so a caller that named its collection before
   freezing it can no longer reach the view through the reference it kept, and
   returned `constructor` UNBOUND so `view.constructor === Set` reads as it does
   on a real collection. The other made a collection at a property that can be
   neither reconfigured nor rewritten a LOAD-TIME REFUSAL instead of a silent
   skip, and added `HANDED_OUT` so `deepFreeze` is idempotent. **Both ship, and
   the refusal is what replaced the skip**: the one lane's `if (… configurable
   || … writable)` guard SILENTLY left the frozen object holding the raw
   collection, which is precisely the escape the other lane executed, so the
   loud `TypeError` strictly subsumes it and the silent branch is gone. The
   repoint itself now writes to the private copy rather than to the caller's
   object, which neither lane alone had to decide. Re-executed at the merged
   head: every prototype-spelled mutator refuses (`Set.prototype.clear/add/
   delete.call`, `Map.prototype.set/delete/clear.call`, `Reflect.apply`, `bind`,
   `getPrototypeOf(...).clear.call`) and so does every direct one; `instanceof
   Set`/`Map`, `Object.isFrozen`, `[object Set]`, `size`, `has`, iteration,
   spread, `Array.from`, `constructor` identity and `forEach`'s third argument
   (the view, never the target) all behave as they did; a retained reference
   emptied to `size 0` leaves the view at `size 2`; the sealed-property case
   throws; and `deepFreeze(view) === view`.
2. **This page's backup-refusal paragraph.** One lane re-derived it against a
   constant of sixteen; the other had added `candidate_census_unavailable`,
   taking the real length to seventeen. The constant wins: the paragraph states
   seventeen, names all of them, and states the exercised split, and BOTH lanes'
   derived pins now stand over it — one deriving the count word, the enumeration
   and the split from `BACKUP_REFUSAL_REASONS` and the test directory, the other
   independently re-deriving both counts and requiring every unexercised reason
   to be excused here by name. Neither lane's pin was dropped in favour of the
   other's.
3. **The exercised-refusal sweep, which the merge itself falsified.** The two
   pins measure the same property by scanning the test directory, and putting
   them in one tree broke that measurement: one lane's census file names
   `file_too_large`, `path_not_readable` and `verification_copy_failed` as
   quoted literals in order to ASSERT that they are unexercised, and the other
   lane's sweep counted those literals as exercise — reporting all seventeen as
   driven, including a refusal that would need a two-gigabyte file no test
   writes. One lane had already reasoned about exactly this hazard for COMMENTS
   and stripped them; the merge is where it appears in code. Both sweeps now
   skip the files whose job is to count refusals, which is stated in
   `REFUSAL_CENSUS_FILES` rather than left implicit. No assertion on either side
   was weakened: both now measure the one real property and both pass.

Everything else auto-merged and was re-read rather than trusted:
`store/integrity.ts` (both lanes changed it heavily — the required
`assessCandidate` injection, `BackupVerification.chainVerified` and
`candidate_census_unavailable` all survive intact beside the duplicate-key
over-claim clauses, `STRUCTURAL_STATEMENT_BASE` and the re-derived cost
sentence), `test/frozen-constants-census.test.ts` (both lanes appended; all four
new cases coexist), `test/reliability-durability.test.ts`, `live/redaction.ts`
and `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md` (one lane removed a running
call-site count that had gone stale every round; the other corrected the residual
`UPDATE` that did not reproduce as written — different paragraphs, both kept).

### Verification at the reconciled head

All green, exit 0, run in this worktree. The parents' figures are as those lanes
recorded them; the merged column is measured here.

| Check | Round eleven (backup verdict lane) | `5126ffe` | Reconciled |
|---|---|---|---|
| `npm run test:hq` | 192 files / 3414 tests | 191 files / 3425 tests | **193 files / 3442 tests** |
| `typecheck @factoryos/headquarter` | clean | clean | **clean** |
| `@factoryos/hq-host` test + typecheck | 23 / 222, clean | 23 / 222, clean | **23 / 222**, clean |
| `@factoryos/hq-server` test + typecheck | 2 / 20, clean | 2 / 20, clean | **2 / 20**, clean |
| root `npm test` | 37 / 569 + 3 skips | 37 / 569 + 3 skips | **37 / 569 + 3 pre-existing skips** |
| `npm run build:site` | 10 pages | 10 pages | **10 pages** + `hq-snapshot.json` |
| `npm run build` web initial JS | 215.66 kB / 69.22 kB gzip | same | **215.66 kB / 69.22 kB gzip** |

Repo-wide, measured at the reconciled head with one stated method — `git grep
-oh -P "(?<![A-Za-z0-9_$.])it\(" -- '*.test.ts'` — **255 test files and 4042
`it(` declarations**, against 254 / 4014 and 253 / 4025 for the two parents by
that same command. The earlier table above counted `it(` a different way and its
figures are not comparable to these; the command is written out here so the
number can be re-run rather than believed.

No test file from either parent is missing, **no file has fewer `it(`
declarations than it had in either parent** (enumerated file by file, not
compared in total), and no exported symbol from either parent is absent.
Nothing was deleted, renamed, skipped, weakened or narrowed; no `.skip` /
`.only` / `.todo` / `xit` / `xdescribe` was added. The diff against the accepted
base `f1ce71c` touches `packages/server`, `packages/web`, `packages/shared`,
`packages/config-mesob`, `packages/hq-host`, `apps`, `package.json` and
`package-lock.json` not at all.

Both lanes' headline guarantees were re-executed at this head rather than
carried over. The four `sk-…` command arguments are refused `invalid_input`
naming the exact field (`workerId`, `scope`, `scopeId`, `providerId`) and their
legitimate forms all succeed; `submitResult(..., ['sk-…'])` and
`postMissionMessage({refs:['sk-…']})` are refused at `evidenceRefs[0]` and
`refs[0]` while ordinary arrays of a PR URL, a doc path and Amharic text land;
`/state`, `/workforce`, `/command-center` and `/intelligence` all answer `200`
before those refused writes, after them, and after a real restart of the same
file. An honest backup verifies `{verified: true, refusals: [], chainVerified:
true, integrityVerdict: 'ok'}` with its sha256 byte-identical before and after
and no sidecar created; a backup carrying a standing blocking verdict and one
whose evidence payload was rewritten behind the last checkpoint both come back
`{verified: false, refusals: ['would_latch_safe_mode']}`; a call supplying no
assessor is `candidate_census_unavailable`. Under a genuine
`append_only_guard_missing` latch, `ops.claimNext` refuses `safe_mode_engaged`
and `ops.queue.claim` throws, while `assessHqIntegrity`, `engageKillSwitch` and
`hqReliabilityPosture` stay available. All five non-AUTOINCREMENT declared
ledgers — `hq_memory`, `hq_mission_intents`, `hq_mission_plan_items`,
`hq_missions`, `hq_orchestration_runs` — are enumerated from the file's own
schema rather than listed by hand, and a healthy restart, a `VACUUM INTO` and a
`.backup()` each report `safeMode: false`. The credential-scan availability set
— English, Amharic, Arabic, Devanagari, Turkish, French and Vietnamese prose,
emoji, a URL, a sha256, a UUID, base64, an absolute path, NBSP, U+2009 and an en
dash — is accepted in every one of its sixteen members.

**The residual disclosed above stands unchanged**, and so does the one this
merge inherits from the third lane: `new OperatorQueue(db, …)` over the same
handle installs no safe-mode gate, and a constructor gate is still the wrong
fix, because the facade builds its queue during its own construction and a
throwing constructor would make `assessHqIntegrity` — the only act that clears
safe mode — unreachable on exactly the file that needs it.

## Wave 5 correction round thirteen — a shipped detector defeated permanently at ONE permitted `INSERT`, and a cost clause wrong a fourth time because the instrument was blind to the term

A fresh read-only hostile review of `237fc768e55ae50fab3deda87276ff3c56d34ff4`
returned 0 Critical / 1 High / 1 Medium / 2 Low. All four are fixed here. Every
figure below was executed at this head before it was written.

### HIGH 1 — `committedLedgerGaps` built a JSON path out of a column a raw writer controls, and one empty key erased every baseline for ever

`json_extract(c.ledger_marks, '$.' || j.key)` took `j.key` from `ledger_rows`.
SQLite raises a hard `bad JSON path: '$.'` for an EMPTY key; the reader's own
`try/catch` swallowed it and returned `{}`. Every gap baseline for all 33
declared ledgers was gone, and gone permanently — the commitment ledger is
append-only, so the poison row can never be removed.

Nothing fired on the way in. `json_each('{"":0}')` gives `COUNT(*) = 1` and
`COUNT(DISTINCT key) = 1`, so round twelve's ambiguity clause is silent, and no
declared table is named, so no value bound is either. Executed against
`237fc76`:

```
gaps before poison: [{"hq_integrity_checkpoints",0},{"hq_reliability_verdicts",0},{"op_evidence",0}]
ambiguity check on {"":0} : {"c":1,"d":1}  -> equal, guard does not fire
INSERT ACCEPTED by trg_hq_integrity_checkpoints_no_overclaim
gaps after poison:  THROWS -> bad JSON path: '$.'
```

End to end, control and attack identical but for that one `INSERT`, against a
mid-ledger delete of `hq_reliability_verdicts` rowid 2 — the ledger that holds
the safe-mode latch:

```
CONTROL: p2..p6 boot=true["append_only_guard_missing"] assess=true release=refused
ATTACK : p2 boot=true assess=false[] release=ADMITTED ; p3..p6 boot=false[] assess=false[] release=ADMITTED
```

That is the detector round seven's High 2 exists to provide, defeated in the
FALSE-REASSURANCE direction, at one statement against the three this module
quotes for every other tamper.

**Fixed as a CLASS, not as an instance**, because this is the second round
running in which a reader of these columns disagreed with the others on an input
the guard admitted. Three changes:

1. **The guard admits only the shape HQ's single writer emits.**
   `COMMITMENT_SHAPE_CLAUSES` refuses any `ledger_marks` or `ledger_rows` that is
   not a `TEXT` value, is not valid JSON, is not a top-level JSON OBJECT, or
   carries a key that is not one of the 33 `ENGINE_IMMUTABLE_TABLES` names or a
   value that is not a non-negative JSON integer.
   `CHAIN_LENGTH_SHAPE_CLAUSE` does the same for the third column. Every one of
   these was executed: the empty key, an undeclared key, a top-level array, an
   empty array, a JSON scalar, a JSON number, malformed JSON, a BLOB that parses
   as JSON, an INTEGER in the TEXT column, a nested object or array as a value, a
   real / text / boolean / null value, a negative value on either half, and a
   real / text / negative `chain_length` — all refused; `'{}'` and a re-statement
   of HQ's own newest commitment still land, and HQ keeps committing boot after
   boot.
2. **No JSON path is built from anything a row carries.** `committedLedgerGaps`
   joins the mark to the row count through a second `json_each` on `key`
   (`LEFT JOIN`, so a key present in one column and absent from the other still
   contributes the gap of 0 it contributed before, rather than being silently
   dropped from the baseline).
3. **The reader no longer fails OPEN.** `json_valid` moved from a `WHERE`
   predicate into the `json_each` ARGUMENT in both readers, so neither can raise
   on any content the column can hold — a `WHERE` predicate beside a
   table-valued function is a planner decision, not a guarantee. The `catch` is
   split: a COMPILE-time error (`no such table`, `no such column` — the two
   benign reasons it was written for) still yields no baseline, which is the
   truth about a file HQ has never committed on; a RUN-time error now yields the
   STRICTEST baseline instead of none — a committed gap of zero for every
   declared ledger, which is what a healthy ledger really has, so a holed ledger
   is reported and a healthy store still reports nothing.

**Two disclosure defects rode on it, and both are corrected.**
`integrity.ts`'s round-twelve docblock claimed refusing the duplicate ambiguity
"makes all five readers agree by making the only input they can differ on
unreachable through the guard". The empty key was a second such input, reachable
through that guard, and the sentence now says so and names the measurement.
This page's residual bullet priced the gap fail-open as "a forged checkpoint
committing a LARGER gap than the file has" — per-ledger, per-value; the cheapest
path named no ledger at all. The bullet now states what was closed and what
genuinely remains at the three-statement price.

**A third claim was nearly shipped and was executed instead.** The obvious way
to keep `json_valid = 0` in front of the `json_type`, `json_each` and
`json_extract` beside it is to write it first and rely on `OR` short-circuiting.
That was written and executed: on SQLite 3.53.2 a trigger `WHEN` clause whose
terms carry subqueries evaluates them anyway, and an `INSERT` carrying
`'{"op_evidence": '` came back as the engine's `malformed JSON` rather than as
HQ's refusal. Documenting the order as a guarantee would have been the eleventh
disclosure defect of this wave. Every expression over these columns is made
TOTAL instead (`totalCommitmentJson`), and the test asserts the MESSAGE rather
than merely that the row did not land.

**The residual, unchanged in kind.** This is still a `BEFORE INSERT` guard: it
bounds what LANDS. A row of the old shape planted with the guards temporarily
dropped is still in the file — but the reader it defeated no longer builds a path
out of it and no longer fails open, so the DETECTOR survives the planted row.
Executed: plant the empty-key row through the three-statement path, then delete
`hq_reliability_verdicts` rowid 2, and the mid-ledger deletion is still reported
at every process afterwards. And the strict fallback gives up one thing, stated
rather than traded silently: a ledger whose rowids legitimately had a hole
BEFORE HQ first committed on it would be reported while the commitment columns
are unreadable.

### MEDIUM 1 — the cost clause undercounted by 4, a fourth time in the same direction, because `statementsExecutedByOneStructuralPass` could not see `db.pragma()`

`INTEGRITY_DEPTH_STATEMENT` says a pass reads "the durability pragmas" in its
own first clause and priced the fixed term at "11 catalogue, pragma and
commitment-ledger reads". `readDurabilityPosture` reads `journal_mode`,
`synchronous`, `foreign_keys` and `wal_autocheckpoint` through better-sqlite3's
`db.pragma()`, which compiles and steps its own statement and never touches a
prepared handle — and the instrument wrapped `db.prepare` only. The four were in
neither the 11 nor the total.

**The parse-back rule could not catch this**, because it compares the prose to a
MEASUREMENT and the measurement shared the blind spot. So the instrument was
fixed first: it now counts `db.pragma` and `db.exec` as well as prepared
statements, and a new test asserts the four pragmas BY NAME off the `db.pragma`
route, asserts that none of them appears in the prepared-statement stream (which
is why they were missed), and pins `db.exec` at zero in a structural pass.

Measured at this head with the fixed instrument:

| File | prepared | pragma | exec | identities | seeks | fixed | total |
|---|---|---|---|---|---|---|---|
| pre-commitment | 11 | 4 | 0 | 0 | 1 | — | **15** |
| booted twice | 46 | 4 | 0 | 33 | 2 | 15 | **50** |
| `warmedFile()` | 47 | 4 | 0 | 33 | 4 | 15 | **52** |

`STRUCTURAL_STATEMENT_BASE` is therefore **48**, not 44, and every figure that
quotes it moved by four: the module header, the constant's docblock, the served
sentence, and this page's residual bullet. The constant's own comparative moved
too and is restated at what it measures rather than carried over — the
pre-commitment branch gained the same four pragmas, so the ratio between the two
branches fell from four to a little over three (50 / 15). Everything else the
review independently confirmed about the clause is unchanged: the rule holds on
both committed-on files, the pre-commitment branch reads zero identities, the
seeked set is the `sqlite_sequence` set and demonstrably not the committed set,
and a full assessment adds exactly `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`.

**Figures in EARLIER sections of this page are historical.** Each `##` section
records what a given round measured at its own head. They are not restated here
and they are not rewritten; the numbers that describe THIS head are the ones in
the table above, in the residual bullet, and in `integrity.ts`.

### LOW 1 — a test docblock's count was stale by one

`reliability-durability.test.ts`'s docblock said `BACKUP_REFUSAL_REASONS` "holds
fifteen … Twelve are exercised". At `237fc76` the constant held **16** with
**13** exercised, which is what the page correctly said. No assertion was ever
unpinned — they all derive from the constant — but a false sentence in a test
file is the same artifact as a false sentence in a served string. The docblock is
corrected, and its two numbers are now parsed back out of the file itself and
compared to the constant and to the sweep, so the next addition to the vocabulary
fails a test rather than leaving a fourth stale sentence behind.

**The new pin earned itself immediately, at the merge below.** The concurrent
round-eleven lane added `candidate_census_unavailable` and a census file the
sweep has to exclude, taking the constant to **17** and the exercised set to
**14**. The corrected docblock went stale a THIRD time in as many merges — and
this time a test failed instead of a reviewer having to notice, which is the
whole point. The numbers above describe `237fc76`; the merged head's are 17
and 14, asserted rather than written down.

### LOW 2 — this wave's heaviest real-file tests were still at the 5 s default

`reliability-crash-recovery.test.ts` had no explicit deadline anywhere while
three of its tests `spawnSync` a real child `node` process against a file-backed
SQLite database. Measured over two full runs with the whole package in parallel:
**825–1137 ms** for those three, against the **361 ms** test that actually failed
CI #552 with `Test timed out in 5000ms`. This is a residual of the previous
round's timeout remediation rather than a false claim in it — that fix's claims
were correctly scoped to its own two files.

Treated the same way: an explicit per-test deadline of **60 s** (~53x the
slowest observed run, the same headroom the other two files carry), a documented
constant, no assertion changed, and **no** global `testTimeout` — raising the
default would relax the deadline for every test in the package, including the
many where a hang is the real signal.

**The other nine tests in that file are deliberately left at the default** and
that is stated rather than quietly done: they use the same file-backed fixture,
spawn no child process, and measure 113–186 ms over the same two runs.
**`decide-routing-cli.test.ts` is measured and deliberately NOT changed here**:
its slowest test (`treats an unrecognised value as unknown rather than as a clean
answer`) runs 1393 ms and 1410 ms over those two runs, at the same 5 s default. It is a different subsystem and
not this round's finding, so it is recorded for whoever picks it up rather than
folded into a commit that did not measure the rest of that file.

### The reader audit this round's High required

Every reader of `ledger_marks`, `ledger_rows` and `chain_length`, checked against
each other over the input space the guard now admits — a `TEXT` value that is
valid JSON, whose top-level type is `object`, whose keys are distinct members of
the 33 declared ledger names, and whose values are non-negative JSON integers;
plus a `chain_length` that is a non-negative SQL integer.

| Reader | Spelling | Agrees over the admitted space because |
|---|---|---|
| `overclaimGuardDdl` value bounds | `json_extract(<total>, '$.<literal>')` | the path is a fixed literal built from the frozen `ENGINE_IMMUTABLE_TABLES`, never from a row; keys are distinct, so `json_extract` and `json_each` return the same single value for the same key |
| `AMBIGUOUS_COMMITMENT_CLAUSES` | `json_each(<total>)` cardinality vs distinct keys | equal for every object with distinct keys; this clause is what makes "distinct" true of the admitted space in the first place |
| `COMMITMENT_SHAPE_CLAUSES` | `TYPEOF` / `json_valid` / `json_type` / `json_each` | `TYPEOF` and `json_valid` are total by definition; the other two read the `<total>` expression, so no value the column can hold raises |
| `committedGreatest` (both columns) | `json_each(<total>)` + `MAX(CAST(value AS INTEGER))` | one row per key, so `MAX` is that key's single value; non-declared keys are dropped in JS, and only positive integers are kept |
| `committedLedgerGaps` | `json_each(<total>)` on both columns, joined on `key` | no path is built at all; `LEFT JOIN` preserves the previous `NULL → MAX ignores → 0` behaviour for a key present in rows and absent from marks, which HQ's writer cannot produce anyway (`rows > 0` implies `top >= 1`) |
| `committedChainLength` | `MAX(chain_length)` | `chain_length` is a non-negative integer, so `Number.isInteger` keeps exactly what the column holds |
| `contradictedChainCommitment` | `c.chain_length` joined to `op_evidence.seq` | same column, same type; the two readers cannot disagree on an integer |

Outside the admitted space there is nothing left to agree about: those values are
refused where they are written. The only remaining disagreement is over rows a
raw writer planted at a build without these clauses, and that is closed at the
READER rather than argued away — no reader builds a path out of a row, no reader
raises on any content, and the one that used to fail open now fails closed.

### The residual this round leaves standing, re-executed rather than carried over

**A cost figure written in THIS document is still read by no test.** The
parse-back rule reaches `integrity.ts` — the served string, the module header
and the docblock above `STRUCTURAL_STATEMENT_BASE` — and stops there. Executed at
THIS head rather than quoted from the round that first disclosed it: changing
"52 statements executed per pass" in the residual bullet above to "61 statements
executed per pass" and running the whole suite gives **193 files / 3451 tests
passed**, unchanged. The figure is wrong and nothing fails. It is disclosed at
that price; the cheapest close is a doc parse-back of the same shape as
`reliability-durability.test.ts`'s backup-refusal count pin, and it is a separate
scoped change rather than something to fold into a correction round.

### The merge with the round-eleven third lane, which landed on `origin` while this round was in progress

This round was built on `237fc768e55ae50fab3deda87276ff3c56d34ff4`. `origin`
moved to `582c2398dd8c081762c90a6c05550a2ab49f3051` before the work was
finished — the reconciliation recorded in the section immediately above — so
this work was committed first and then MERGED with it: a true merge, both
parents, nothing discarded. Two files conflicted textually and both were
resolved by composing rather than choosing.

 - `reliability-durability.test.ts`'s docblock. Both lanes rewrote the same
   paragraph, and both were right about different things: the other lane removed
   the free-standing figures and recorded that the constant had reached
   seventeen, this one added a pin that reads the paragraph's own numbers back
   out and compares them. Both are kept — and the pin FAILED on the first run
   after the merge, because the other lane's new census file changes the
   exercised set from thirteen to **fourteen**. It was corrected by measurement,
   which is the pin doing exactly the job it was written for.
 - `PHASE_13_ADVANCED_RELIABILITY.md`. Two new sections appended at the same
   place; both kept, the other lane's first because it describes the head this
   round builds on.

`integrity.ts` merged without conflict: the other lane's changes are in the
backup-verification vocabulary near the end of the file, this round's are in the
module header, the cost constant, the over-claim guard and the two commitment
readers.

### Verification at the merged head

All green, exit 0, run in this worktree.

| Check | Round twelve merge (`237fc76`) | `origin` (`582c239`) | This merged head |
|---|---|---|---|
| `npm run test:hq` | 191 files / 3425 tests | 193 files / 3442 tests | **193 files / 3451 tests** |
| `typecheck @factoryos/headquarter` | clean | clean | clean |
| `@factoryos/hq-host` test + typecheck | 23 / 222, clean | 23 / 222, clean | **23 / 222**, clean |
| `@factoryos/hq-server` test + typecheck | 2 / 20, clean | 2 / 20, clean | **2 / 20**, clean |
| root `npm test` (`@factoryos/server`) | 37 / 569 + 3 skips | 37 / 569 + 3 skips | **37 / 569 + 3 pre-existing skips** |
| `npm run build:site` | 10 pages | 10 pages | **10 pages** + `hq-snapshot.json` |
| `npm run build` web initial JS | 215.66 kB / 69.22 kB gzip | same | **215.66 kB / 69.22 kB gzip** |

The nine tests added by this round were also run against BOTH parent heads with
the source untouched: **9 failed against `237fc76`** (the eight behavioural pins
plus the docblock pin, the latter spliced into that head's own prose rather than
copied whole, because a pin that reads its own file's docblock passes when the
file is copied with it) and **8 failed against `582c239`**. Nothing was deleted,
renamed, skipped, weakened or narrowed; no `.skip` / `.only` / `.todo` / `xit` /
`xdescribe` was added, and no `as any`, `@ts-expect-error` or `eslint-disable`
appears in an added line. Zero new dependencies. This round's own diff touches
`packages/headquarter/` and `docs/HEADQUARTER/` only.
## Wave 5 correction round THIRTEEN: the rowid channel, and four partial enumerations standing in for complete ones

Two fresh read-only hostile reviews of `48dd026` returned 0 Critical, 4 High, 7
Medium and 8 Low. This section records what was reproduced at the MERGED head
(`237fc76`, which already carried rounds ten to twelve), what changed, and what
is disclosed instead — priced by execution, never by estimate.

This section was written against `237fc76` and then MERGED with a concurrent
round-thirteen lane (`7d3581a`) that had run off the same base. Nothing was
discarded in either direction: that lane's empty-key poison fix to
`committedLedgerGaps`, its `db.pragma` instrument correction (which moved
`STRUCTURAL_STATEMENT_BASE` from 44 to 48) and its seventeenth backup refusal all
stand, and every figure THIS lane states was re-measured at the merged head
rather than carried forward. Where both lanes touched one sentence — Phase 14's
HIGH H2 row and this page's backup-count sentence — the merged text carries both
corrections.

**The class behind every High of this round, and of the three rounds before
it**: a partial enumeration standing in for the complete one. `missionText(`
call sites for "stores caller text"; eighteen curated parameter names for
"caller-supplied text"; `sqlite_sequence` membership for "declared ledger";
`MAX(rowid)` for "row count"; a count-and-top witness for "the same rows"; an
inner `JOIN` for "canonical membership"; and now the append-only trio for "every
way a row can enter a ledger". Each fix below makes its enumeration complete BY
CONSTRUCTION and makes the pinning test enumerate the same way, rather than by a
list somebody maintains.

### HIGH 1 — one PERMITTED `INSERT` fabricated a permanent, unclearable safe mode on 32 of the 33 declared ledgers

**Reproduced at `237fc76`.** `trg_<ledger>_no_replace` fires only on a
*colliding* rowid, so an ordinary `INSERT` naming an explicit rowid ABOVE a
declared ledger's current maximum was a write the append-only trio deliberately
permitted. It widens `MAX(rowid) - COUNT(*)`, and `committedLedgerGaps` reads
that widening as proof of a mid-ledger deletion. Executed through this package's
own file fixture, one statement, no trigger dropped, no `sqlite_sequence` write,
no restart: `hq_reliability_verdicts` went from `{rows:4, top:4}` to `{rows:5,
top:104}` — **the row count went UP and nothing was removed** — and `p2`/`p3`
then read `boot=true assess=true release=REFUSED`, permanently, with the
Founder-facing detail saying the ledger no longer held what HQ's checkpoint
recorded, "fewer rows, a lower greatest row, or a gap where a row used to be …
None of those can happen while HQ is the only writer." The sweep found the
statement ACCEPTED on 32 of the 33 declared ledgers; the 33rd,
`hq_integrity_checkpoints`, falls to the same statement with valid JSON in its
commitment columns. This is round seven's HIGH 3 re-opened one column over:
`no_overclaim` bounds `ledger_marks`, `ledger_rows` and `chain_length`, and the
rowid is a channel it does not bound.

**Why it is closed where the write happens.** After a mid-ledger deletion of k
rows and m appends a ledger reads `rows + m - k` / `top + m`; after one append d
above the top it reads `rows + 1` / `top + d`. Both widen the gap by the same
arithmetic, so `committedLedgerGaps` reports them under one name.

> **CORRECTED IN ROUND FOURTEEN (High 1).** This paragraph used to say the two
> acts are "indistinguishable from the file alone at any later moment, so
> nothing this reader could do would separate them". **That was false, and a
> reviewer disproved it by execution.** They are separated exactly by a
> predicate over data HQ already commits — `COUNT(*) WHERE rowid <= committed
> top`, against the committed row count — because a ledger HQ only appends to
> holds exactly its committed rows at or below its committed top for ever
> after. `committedRemovalsBelowMark` is that reader, and the Founder-facing
> detail now says WHICH of the two happened. What it does NOT separate is a hole
> that was REFILLED from a ledger nothing touched, and that is said in the
> reader's own docblock, in the detail text and in the test that pins it. The
> channel is still closed at the write, but now for a reason that holds: the
> guard also refuses the refill, which no read-time predicate can see.

**What changed.** Every declared ledger now carries
`trg_<prefix>_no_rowid_skip`, a `BEFORE INSERT` guard that refuses a rowid past
what the engine itself would allocate:

```sql
WHEN NEW.rowid > 1 + MAX(COALESCE((SELECT MAX(rowid) FROM "<ledger>"), 0),
                         COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '<ledger>'), 0))
```

It is appended in `declaredGuardsFor` rather than written on 33 declaration
lines, so the set is complete BY CONSTRUCTION — a ledger cannot be declared
without declaring it — and `ensureLedgerRowidGuards` installs it by iterating
`ENGINE_IMMUTABLE_TABLES` itself, beside `ensureIntegrityCheckpoints` and after
the as-found census, so a dropped guard is reported before it is repaired. The
live-schema pins in `reliability-durability.test.ts` (the trigger set on a real
file EQUALS the union of the declarations, in both directions) then require it
to actually exist on all 33.

**Why the bound names `sqlite_sequence` as well as the rows.** A legitimate
append lands at `MAX(rowid) + 1` on an implicit-rowid table and at
`sqlite_sequence.seq + 1` on an AUTOINCREMENT one. A bound taken from the rows
alone would refuse HQ's own next append after any burned counter and stop the
store writing — strictly worse than the hole a burn opens. Taking the counter
into the bound gives a writer who can raise it a rowid to skip to, and that buys
nothing new: raising a declared ledger's high-water mark above its `MAX(rowid)`
is already reported by `truncatedImmutableLedgers` on its own, in one statement,
with no insert at all.

**The Founder-facing detail no longer asserts what it cannot distinguish.** It
now names both causes — a row removed from the middle, and a row written past
the end — and says the guards refuse an INSERT at a position the engine would
not have allocated, which is what makes "none of those can happen while HQ is
the only writer" true rather than reassuring.

**Executed after the fix.** The same statement is REFUSED on all 33 (`<ledger>
rowids are contiguous`); `{rows:4, top:4}` is unchanged; `regressed []`; and
`p2`–`p5` read `boot=false [] assess=false [] release=ADMITTED`. Pinned in
`ledger-rowid-guard.test.ts`, whose sweep uses each ledger's REAL `CREATE TABLE`
text taken from a live HQ file, proves an ordinary append is accepted on each
one first, and fails on 4 of its 6 tests against the pre-fix code.

### ROUND FOURTEEN, HIGH 1 and HIGH 2 — the bound had ONE side, and 30 ledgers were silent

`no_rowid_skip` bounds the rowid from ABOVE only. Two live one-statement writes
went through the open side, both reproduced at the merged head `8481269` through
this package's own file fixture before anything was changed.

**HIGH 1 — a mid-ledger deletion laundered back to a completely clean store.**

```
control (delete rowid 6 of an 11-row hq_reliability_verdicts, guards restored, 3 statements)
  identity {"rows":10,"top":11}   missingGuards [] regressed ["hq_reliability_verdicts"] truncated []
  structural safeMode true
attack (+ ONE further PERMITTED INSERT at the freed rowid, nothing dropped, all guards in place)
  identity {"rows":11,"top":11}   missingGuards [] regressed [] truncated []
  structural safeMode false
```

Four statements to a completely clean store, against three for a finding that
stands — the inversion this module says it forbids. Silent on 30 of the 33
declared ledgers (all but `op_evidence`, which has the hash chain, and
`hq_integrity_checkpoints`, which has `no_overclaim`), **including
`hq_reliability_verdicts`, the safe-mode latch ledger, and
`hq_reliability_run_events`, the ledger `RUN_RETRY_STATEMENT` rests on**.

**HIGH 2 — one `INSERT` at rowid `-1` bricked HQ's own appends, kill switch
included.** In a `BEFORE INSERT` trigger an auto-assigned rowid reads as the
integer `-1` on this engine — measured against a probe trigger, and now pinned —
so a row planted AT rowid -1 makes `no_replace`'s `EXISTS (… WHERE seq =
NEW.seq)` true for every append that follows. Executed on `op_evidence`:

```
INSERT at rowid -1 accepted: true (no trigger dropped)
census  missingGuards [] regressed [] truncated []   structural safeMode false
engageKillSwitch   THREW UNCAUGHT  SqliteError: op_evidence is append-only
assessHqIntegrity  THREW UNCAUGHT  SqliteError: op_evidence is append-only
```

One permitted statement, no restart, no DDL: HQ could no longer write, **the
Founder could not engage the kill switch**, the clearing route threw instead of
refusing, and every integrity reading said the store was clean.

**What changed.** Every declared ledger now also carries
`trg_<prefix>_no_rowid_reseat`, an `AFTER INSERT` guard:

```sql
WHEN NEW.rowid < 1 OR NEW.rowid <> (SELECT MAX(rowid) FROM "<ledger>")
```

It is declared in `declaredGuardsFor` beside `no_rowid_skip`, so the set stays
complete BY CONSTRUCTION, and installed by the same loop over
`ENGINE_IMMUTABLE_TABLES`. The timing is `AFTER INSERT` because neither clause
can be asserted before the fact: an omitted AUTOINCREMENT key presents as `-1`
there, which is a value a caller can also spell, and there is no `BEFORE`
spelling that separates "the engine will choose" from "the caller chose -1" —
the same measurement that forced `no_overclaim` to that timing. The upper bound
cannot move with it, because after the insert `sqlite_sequence` has already been
raised to the caller's own rowid and the engine's pre-insert allocation is no
longer recoverable. So the channel has two bounds at two timings, and the phase
document says which does what rather than implying one covers both.

**Executed after the fix**, on the same file:

```
attack INSERT at the freed rowid: REFUSED 'hq_reliability_verdicts rowids are append-only'
identity {"rows":10,"top":11}   regressed ["hq_reliability_verdicts"]   p2/p3 boot=true assess=true release=refused
plant at rowid -1 (INSERT / OR REPLACE / OR IGNORE): all REFUSED
engageKillSwitch ok:true   assessHqIntegrity ok:true
```

**And the three acts that used to throw now REFUSE.** `engageKillSwitch`,
`releaseKillSwitch` and `assessHqIntegrity` return a refusal naming the store's
own message when HQ's own append is refused, instead of throwing the driver's
`SqliteError` out of the facade. `#integrityReport` is still not assigned on that
path, so a verdict HQ could not record is still a verdict HQ does not act on —
what changed is that the caller is told and the process stays up.

Pinned in `ledger-rowid-guard.test.ts`: the 33-ledger reseat sweep against the
real schemas in five spellings (the freed hole, rowid 0 and rowid -1 on a
populated ledger, and 0 and -1 on an EMPTY one, where only the `< 1` clause can
speak), the end-to-end laundering act on a real file, the `-1` plant with the
kill switch still working, the refuse-not-throw contract, and the `NEW.rowid`
measurement itself. Seven of that file's fourteen tests fail against the pre-fix
tree.

**Two concurrent round-thirteen lanes closed this channel off the same base, and
BOTH closures are kept — the narrower one is not subsumed.** The other lane
bounded the rowid inside the over-claim guard, as `NEW.seq <> (SELECT COUNT(*)
FROM hq_integrity_checkpoints)`, and moving that guard to `AFTER INSERT` is what
the next bullet above is about. `no_rowid_skip` is broader — all 33 declared
ledgers, where that clause only ever bounded one — so it is the mechanism this
section prices, and being `BEFORE INSERT` it speaks first. It is NOT, however, a
superset: it bounds the rowid from ABOVE only, so a reseat at or below the top
that collides with nothing passes it. Executed on the commitment ledger at the
merged head, with each guard left standing alone:

```
round thirteen, measured at the merged head of that round:
no_rowid_skip ALONE : seq=-1 ACCEPTED [elided=true] ; seq=0 ACCEPTED [elided=true] ;
                      seq=1000 REFUSED 'rowids are contiguous'
no_overclaim ALONE  : seq=-1, seq=0, seq=1000 all REFUSED 'may not commit beyond the record'
both (as shipped)   : all three REFUSED

round fourteen, with the bound from below now on all 33:
broad guards ALONE  : seq=-1 REFUSED 'rowids are append-only' ; seq=0 REFUSED ;
                      seq=1000 REFUSED 'rowids are contiguous'
                      append at the TOP of a ledger a row was elided from: ACCEPTED
no_overclaim ALONE  : all four REFUSED 'may not commit beyond the record'
all three (shipped) : all four REFUSED
```

> **UPDATED IN ROUND FOURTEEN.** The two reseats the round-thirteen table
> records as ACCEPTED by `no_rowid_skip` alone are not accepted any more — the
> seat guard closed them on all 33. The clauses are still not equivalent, and
> the shape that separates them is the last line of the table: on a ledger a row
> has been elided from, an ordinary append AT THE TOP satisfies both broad
> guards (it is the greatest rowid, and it is within the allocation) and fails
> the identity clause (it is not the row COUNT). Measured honestly, that append
> does NOT launder the elision — `elidedCommitmentLedgerRows` still reads true
> afterwards, which `commitment-overclaim.test.ts` asserts rather than assumes —
> so the identity clause is kept for what it is: the only clause in the schema
> that ties this ledger's rowid to its ROW COUNT, which is the relation that
> reader reads.

`-1` is not an exotic value: it is what SQLite itself reports for an omitted
`AUTOINCREMENT` rowid, which is the measurement that forced the `AFTER INSERT`
timing. Each admitted reseat raises this ledger's row count without raising its
greatest rowid, and `elidedCommitmentLedgerRows` reads exactly that pair — so
retiring the identity clause as "covered by the broader guard" would have
reopened half of round thirteen's Exploit B under a merge that looked like
consolidation. The two are complements: one is the only bound on the other 32
ledgers, the other is the stricter bound on the one ledger whose own row count is
read back. Both are pinned, each with the other's guard dropped so neither test
can pass on the other's work — `ledger-rowid-guard.test.ts` for the first, and
`commitment-overclaim.test.ts`'s reseat and complementarity probes for the
second.

### MEDIUM 1 — the burn enumeration named one spelling of three

`committedLedgerGaps` cited `ledger-rowid-contiguity.test.ts` for which engine
behaviours burn a rowid, and the citation named `INSERT … ON CONFLICT … DO
UPDATE` as the one that does. Measured on the shipped runtime (SQLite 3.53.2):
`INSERT OR IGNORE` on a conflict burns (`seq` 2→3) and `INSERT … ON CONFLICT DO
NOTHING` burns (`seq` 3→4), each with `rows` and `top` unchanged, and the next
genuine append then skips three rowids. All three spellings are now measured in
that file and named in the docblock. The property itself was never at risk — the
source sweeps in the same file already ban `INSERT OR IGNORE` outright and catch
every `ON CONFLICT` target, over all 33 ledgers read from the declaration — it
was the enumeration in the prose that was partial. The reviewer's finding was
raised against `48dd026`, where the cited file did not exist at all; round twelve
created it, and this round completes its engine half.

### HIGH 2 — a PADDED prefix replay meets the header witness, and three sentences said it could not

**Reproduced at `237fc76`.** The round-ten witness records the greatest rowid
HQ's commitment ledger has ever reached, and `elidedCommitmentLedgerRows` reports
`top < mark || rows < mark`. That is a COUNT, and a count is met by putting the
right NUMBER of rows back rather than the right rows: `DROP TABLE
hq_integrity_checkpoints`, replay the DDL out of `sqlite_master`, re-insert a
PREFIX of the genuine rows, then PAD up to the mark `W` with copies of a
surviving row at the erased rowids, changing only the UNIQUE `id`. Every
commitment written back is one HQ itself made, so `no_overclaim` has nothing to
refuse. Measured: 13 statements at `237fc76` (14 at the round-thirteen head, where the
ledger carries `no_rowid_skip` as a seventh object to replay, and 16 at this one,
where round fourteen declared `no_rowid_reseat` and `no_rowid_move` beside it)
took six genuine
commitments to two plus four copies, with `rows === top === sqlite_sequence ===
W`, `elided false`, `regressed []`, `truncated []`, `contradicted null`, and
`p2`/`p3`/`p4` each `boot=false [] assess=false [] release=ADMITTED`.

Three places said this could not happen, verbatim: *"A `DROP TABLE` cannot lower
it and a replay cannot raise the ledger to meet it."* All three are corrected —
this page, `HQ_COMMITMENT_WITNESS_MARK`'s docblock, and
`reliability-commitment-prefix-replay.test.ts`'s header.

**It is DISCLOSED rather than closed, and the reason is exact rather than an
apology.** The attacker reads the genuine ledger before destroying it, so any
predicate over the FILE's own content can be satisfied by writing content that
satisfies it. The only predicate that could not be met is one over content the
attacker cannot reconstruct, and there is none: the header slot carries 32 bits,
16 of which are the signature. Two candidate closures were designed and rejected
on the merits, and both are recorded so a later round does not rediscover them:

1. **An "every checkpoint advances something" invariant.** True of
   `recordIntegrityCheckpoint` by construction, and it does catch a pad built
   from COPIES. Rejected because it buys nothing an attacker cannot step around:
   the pad can be built from DISTINCT rows whose committed quantities RISE,
   which `no_overclaim` permits because they stay under the file's real marks,
   and the invariant is then satisfied by construction.

   It is ALSO rejected because two processes that read the same state before
   either writes produce two checkpoints committing identical quantities — an
   ordinary concurrent boot — so the check can raise a PERMANENT finding over an
   untampered file.

   > **RE-TESTED IN ROUND FOURTEEN (Low 4), and the verdict did not change.** A
   > reviewer reported that second reason as NOT reproduced: three real
   > concurrent processes x six assessments, 20 checkpoints, 0 identical.
   > Re-running the same experiment found the reviewer's result reproducible AND
   > its opposite reproducible: over **eight** runs, six produced no identical
   > pair and **two did** — once inside the suite itself (21 checkpoints, 20
   > distinct), once from a standalone driver (22 checkpoints, 21 distinct) —
   > each time between DIFFERENT processes. So the collision is real and
   > INTERMITTENT, the sentence stands, and the finding is not a defect. What
   > this round adds is the frequency and a test written so that neither sample
   > can be reported as the settled answer:
   > `reliability-commitment-prefix-replay.test.ts` asserts only what is stable —
   > that all three processes committed, that one process never commits the same
   > quantities twice (the deterministic half), and that any identical pair is
   > between different processes (the claim the closure rests on).
2. **A content digest in the header's low bits.** Sixteen bits is a 65,536-way
   collision search an attacker runs offline in under a second. Widening it means
   either shrinking the signature — which round ten already measured as a real
   loss in the false-alarm direction — or coupling `PRAGMA user_version`, which
   round ten rejected because it would let ONE statement defeat both marks.

What the mark still closes is the UNPADDED replay, which is what round ten
measured; that case stays pinned in the same file, beside the executed
disclosure of this one.

### HIGH 4 and MEDIUM 2 — reported against `48dd026`, already closed at the merged head

Both were reproduced by the reviewers against `48dd026` and both were closed by
round ten, which the merge brought in. Re-executed at `237fc76` rather than
taken on trust:

- **HIGH 4** — four caller-supplied IDENTIFIER fields stored unscanned.
  `registerExecutionWorker({ workerId: 'ghp_…' })`, `setIntelligenceBudget({
  scopeId: 'ghp_…' })`, `recordModelObservation({ providerId: 'ghp_…' })`,
  `recordModelObservation({ modelId: 'ghp_…' })` and `engageKillSwitch('ghp_…',
  …)` are each refused `invalid_input` naming the exact field
  (`String matches a known credential shape (at stored_text.workerId)`, and so
  on). `callerTextRefusal` scans every own string field of every facade write's
  input, and `facade-write-scan.test.ts` derives coverage PER (method,
  parameter) pair with no curated vocabulary in the PARAMETER half — the
  18-name `FREE_TEXT_PARAMETERS` list the finding names is gone. Not a defect at
  this head.

  > **SCOPE CORRECTED IN ROUND FOURTEEN (Medium 2).** "No curated vocabulary" is
  > true of the PARAMETER half and was never true of the METHOD half. Which
  > methods count as WRITES starts from `WRITE_MARKERS`, a curated regex of write
  > spellings, and round thirteen closed that regex over the class's own call
  > graph so a public method whose write lives in a `#private` helper is
  > classified — which is exactly the defect a fresh review reported against
  > `f348f9a`, and it is ALREADY FIXED at the merged head by the concurrent
  > round-thirteen lane. The two ledger writers the reviewer named,
  > `recordIntelligenceDecision` and `escalateIntelligenceDecision`, are
  > classified and scanned. What the classifier can still miss is a write in a
  > spelling `WRITE_MARKERS` does not name, reached through a module-level
  > function rather than a method of this class; no such method exists at this
  > head, and that is the honest boundary rather than "no curated vocabulary
  > anywhere".
- **MEDIUM 2** — the served depth statement's "46 statements". The served
  sentence quotes no total at all now; it interpolates
  `STRUCTURAL_STATEMENT_BASE` and states the seek term as a rule, with both
  worked totals explained rather than one shipped as "the" cost.
  `integrity-statement-truth.test.ts` pins it against instrumented counts on two
  files with different seek terms and parses every number back out of the prose.
  At the head this section was first written the constant was 44 (33 + 11); the
  CONCURRENT round-thirteen lane merged in beside this one then found the
  instrument itself blind to the four `db.pragma()` reads the served sentence
  names in its own first clause, so the fixed term is 15 and the constant is
  **48** (33 + 15), with 48 + 2 = 50 and 48 + 4 = 52 as the two files' totals.
  Re-verified at the MERGED head rather than carried forward: changing the
  constant from 48 to 49 in a scratch copy fails three of that file's tests.
  Not a defect at this head.

### MEDIUM 3, MEDIUM 4 and MEDIUM 5 — a stale count and three unpinned defences

- **MEDIUM 3.** Round twelve's pin already reads ONE sentence on this page and
  compares it to `BACKUP_REFUSAL_REASONS`. A SECOND sentence stating the same
  pair claimed `ten` exercised of `thirteen` total, and went on saying so after
  the constant moved, because no regex reached it. The sentence is corrected and
  the sweep is generalised: every `"<number word> of the <number word>"` on this
  page whose sentence goes on to say those refusals are exercised is now checked
  in BOTH halves, rather than the one phrasing the regex was written around.
  That generality earned itself immediately — the CONCURRENT round-thirteen lane
  merged in beside this one raised the vocabulary to SEVENTEEN, moved the
  exercised count to FOURTEEN and re-worded the sentence from "backup path
  protections" to "backup refusals", which a phrasing-bound regex would have
  stopped reading. Re-verified at the merged head: writing `ten of the seventeen`
  in a scratch copy fails the sweep, naming the pair it read.
- **MEDIUM 4.** `return seq` on an unparseable payload, in `verifyEvidenceChain`.
  Mutated to `continue` it left 3425 tests green and turned a Founder assessment
  that reported `evidence_chain_broken` into a clean one. Pinned in
  `evidence-link-defences.test.ts`, with the exact seq asserted and the
  no-false-alarm case (a payload that differs only in whitespace) beside it.
- **MEDIUM 5.** The `prev_hash` comparison, at BOTH its sites — the walk and
  `evidenceEntryLinkStands`. A row whose `prev_hash` column is forged while its
  own `hash` stays correct over the REAL previous hash passes every other test in
  both functions; without the comparison, `evidenceEntryLinkStands` answers
  `true` for it, which would corroborate a verdict-clearing claim. Both sites are
  pinned in the same file, and each mutation fails exactly its own test.

### The LOW findings

- **LOW 1 — a residual priced ABOVE its real cost, which is as much a false
  claim as one priced below it.** `operator/evidence.ts` still read "Dropping
  `hq_integrity_checkpoints` outright remains the other route, and still costs
  the restart and the second Founder act the round-five text priced it at." The
  round-ten header witness closed that route entirely. Re-executed at `237fc76`
  — one `DROP TABLE`, nothing else — `p2`, `p3`, `p4` and `p5` each read
  `boot=true [append_only_guard_missing] assess=true release=REFUSED`. The
  sentence is corrected and the measurement is pinned in
  `reliability-commitment-witness.test.ts`.
- **LOW 2 — the drop-everything residual was priced two statements and one
  restart too cheap.** Re-executed step by step on one warmed file, and written
  out above beside the sentence it corrects: 33 `DROP TABLE`s alone, and 33 plus
  `PRAGMA user_version = 0`, are both still `boot=true assess=true
  release=REFUSED`; it takes `PRAGMA application_id = 0` as well — 35 statements
  — and then ONE restart and ONE Founder assessment before the file reads clean.
- **LOW 3 — the `application_id` encoding described here was the superseded
  one.** Round ten replaced the single closed-set value `0x48514350` with a
  16-bit signature plus a 16-bit mark, and this page went on describing the old
  encoding with no correction marker, against its own convention. Corrected in
  place, with the specificity cost and the one given-up mark value named.
- **LOW 4 — dead public surface.** `readCommitmentWitness` was exported and
  re-exported by `store/index.ts` with five hits, all inside `integrity.ts`, no
  consumer and no test. It is module-private now, for the condition round six
  made `integrityCheckpointLedgerPresent` module-private for; the two questions
  callers ask (`commitmentWitnessPresent`, `committedCheckpointMark`) stay
  exported.
- **LOW 5 — an unpinned but contained defence.** Removing
  `.filter(isHqIntegrityFinding)` from `rowToRecordedVerdict` left the suite
  green and let a forged finding name reach `standingIntegrityVerdict`'s public
  output. Pinned in `reliability-verdict-durability.test.ts` by a LEGAL append
  carrying a forged name, with the containment (`carryRecordedVerdict`
  re-filters, so no safe-mode decision sees it) asserted in the same test rather
  than implied.
- **LOW 6 — two Unicode category sizes measured on an older ICU.** `\p{Mn}` is
  **2,059** and `\p{Cn}` **814,730** on the shipped runtime (Node v22.22.2, ICU
  78.2, Unicode 17.0), not 1,796 and 810,961; `\p{Me}` 13, `\p{Co}` 137,468 and
  `\p{Zs}` 17 were exact. All three sites are corrected, the figures now name the
  Unicode version they were measured on, and
  `redaction-invisible-classes.test.ts` measures every one of them against the
  running engine and parses them back out of `redaction.ts`'s docblock. The
  guarantee never moved with the numbers: the erase set is expressed as the
  PROPERTIES, so a category that grows is covered the day the engine grows it.
- **LOW 7 — recorded on `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md`.** The
  enforcement-safe read audit described `#governingBudgetScopes` by its canonical
  term alone, omitting `#durableTaskProjectScopes` and `#recordedScopesForTask`,
  both of which are load-bearing elsewhere on that same page. Corrected there.
- **LOW 8 — already closed at the merged head.** `integrity-statement-truth.test.ts`
  carries `FILE_BACKED_BATTERY_TIMEOUT_MS = 60_000` on all six of its file-backed
  batteries, as of `237fc76`. Not a defect at this head.

### What round thirteen adds to the NOT-fixed list

- **`no_rowid_skip` is a step, not a boundary**, at the same price as every
  other engine guard in this module: three statements — `DROP TRIGGER`, the
  insert, re-create. Counted rather than asserted, in
  `ledger-rowid-guard.test.ts`, which then shows the census clean and
  `regressedImmutableLedgers ["hq_reliability_verdicts"]` afterwards. A guard
  re-created before the next boot is never observed missing, because the
  as-found census reads `sqlite_master` at construction time only.
- **A file written by a build older than this one reports one boot of safe
  mode.** Its ledgers carry no `no_rowid_skip` trigger — and, since round
  fourteen, no `no_rowid_reseat` or `no_rowid_move` either, nor the derived
  `no_unique_reentry` guard on `op_tasks` — so the as-found census reports
  `append_only_guard_missing`. That is the ordinary cost of declaring a new
  guard — `no_overclaim` had exactly the same one — and a missing GUARD is
  cleared by ONE Founder assessment of the file as it then stands, because
  re-creating a trigger really does repair the file's guard set.
- **The `sqlite_sequence` manufacture residual is unchanged and is now also a
  route to the gap.** One `UPDATE` raising a declared ledger's counter is
  already reported as `append_only_ledger_truncated` over a ledger nobody
  touched; the same write also lets HQ's own next append land past
  `MAX(rowid) + 1` and widen the gap. Neither is closed, for the reason round
  seven recorded: the only bound available for that check is the number being
  written.
- **A PADDED prefix replay of the commitment ledger is silent from the very next
  boot** — 13 statements at `237fc76`, 14 at the round-thirteen head, 16 at this
  one, because the ledger's declared guard set grew by two. Executed and asserted in
  `reliability-commitment-prefix-replay.test.ts`, with the two candidate closures
  that were designed and rejected on the merits written out beside it. See HIGH 2
  above for why no predicate over the file's own content can close it.
- **`UPDATE op_tasks SET id` still detaches a task from its mission and project
  ceilings at three statements** — `DROP TRIGGER trg_op_tasks_no_reidentify`, the
  `UPDATE`, re-create — and no read-side derivation can hold it, because
  `hq_mission_plan_items.task_id` names the task BY ID and there is no second key
  to resolve it by. Priced and asserted in `budget-scope-identity.test.ts`; the
  full record is on `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md`.

  **That price was true of the `UPDATE` and was read as the price of the
  DETACHMENT, which it was not** (Wave 5 correction round fourteen, High 2). The
  same detachment was reachable in ONE statement by a different spelling:
  `INSERT OR REPLACE INTO op_tasks` colliding on `idx_op_tasks_idem` at the
  victim's own rowid. `REPLACE` deletes the standing row without firing
  `BEFORE DELETE` while `recursive_triggers` is off — the engine default on
  every ordinary connection — and `no_reidentify` is `BEFORE UPDATE OF id`, so
  nothing fired. Executed at `8481269` on the shipped budget scene: the task's
  `id` became `HIJACKED-TASK`, `governedBy` lost the mission, `permittedTiers`
  widened from `['deterministic_local']` to all five, `budgetDecision` went
  `blocked` → `within_ceiling`, and a `critical_review` write the exhausted
  Founder ceiling had refused was ACCEPTED, with `missingImmutabilityGuards`
  empty and `structuralIntegrity` silent. `hq_missions` fell to the same
  statement on `UNIQUE(idempotency_key)`. Both are closed —
  `trg_op_tasks_no_unique_reentry`, derived from the table's own indexes, and
  `trg_hq_missions_no_replace_unique` — and the CLASS is closed by execution in
  `unique-index-reentry.test.ts`, which drives a colliding `INSERT OR REPLACE`
  and a bare `REPLACE` on every unique index of all 33 declared ledgers and
  every write-once identity table. The three-statement `UPDATE` route above is
  unchanged and is still the standing residual.
- **A verdict row's FORGED finding name still reaches nothing, but the row still
  lands.** Appending to `hq_reliability_verdicts` is the write its guards
  deliberately permit; what round thirteen pins is that the name is dropped at the
  reader rather than that the append is refused.

### What round fourteen adds to the NOT-fixed list

Every price below is MEASURED at this head, not carried forward.

- **`no_rowid_reseat` is a step, not a boundary**, at exactly the price its
  sibling carries: three statements — `DROP TRIGGER`, the write, re-create — and
  a guard re-created before the next boot is never observed missing, because the
  as-found census reads `sqlite_master` at construction time only. What that
  buys back is the LAUNDERING of a mid-ledger deletion: with the guard gone, one
  further insert at the freed rowid restores rows, greatest rowid and gap to
  exactly what HQ committed, and **no predicate over the file separates that
  from an untampered ledger**. `committedRemovalsBelowMark` says so in its own
  docblock with the worked four-case table, the detail text says so to the
  Founder, and `ledger-rowid-guard.test.ts` asserts it — the refilled hole is
  reported by nothing, deliberately, rather than being claimed as covered.
- **A file written by a build older than this one reports one boot of safe
  mode**, unchanged in kind and now for two guards rather than one: a file
  carrying no `no_rowid_reseat` trigger reports `append_only_guard_missing` at
  its first boot under this build, and ONE Founder assessment of the file as it
  then stands clears it, because re-creating a trigger really does repair the
  file's guard set. The same is true of `op_tasks`' two new identity guards.
- **The `op_tasks` identity residual is now three routes at three prices**, all
  executed in `budget-scope-identity.test.ts` rather than quoted: `UPDATE
  op_tasks SET id` at three statements (`trg_op_tasks_no_reidentify`), `INSERT
  OR REPLACE` at three (`trg_op_tasks_no_replace`), and `DELETE` + `INSERT` at
  four (`trg_op_tasks_no_erase`, two writes, re-create). The round-thirteen page
  priced the first at three while the cheapest was ONE; the full record is on
  `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md`.
- **A raw `INSERT` of a NEW `op_tasks` row is admitted at ONE statement and no
  trigger can close it**, because it is byte-for-byte the shape of `createTask`.
  What it produces is an UNGOVERNED task, which is what `createTask` produces
  for any task not linked to a mission; it is NOT an identity change, and the
  victim task's ceiling still binds, which is asserted rather than assumed.
- **The derived unique-index guard installs no clause for three index shapes** —
  an index whose column name is not a plain identifier, a key with an expression
  column, and a partial index whose predicate is not exactly the NOT-NULL
  conjunction the generated clause encodes. It builds SQL and will not build SQL
  it cannot spell exactly. Such an index is REPORTED by
  `unguardedUniqueIndexes` rather than skipped silently — which is why the
  concurrent lane's derivation is the one the merge kept — and HQ's live schema
  carries none of those shapes, asserted rather than assumed.
- **The unauthenticated artifact publishes twenty Founder- and worker-typed
  fields**, unchanged in behaviour and now disclosed in full above. The
  derivation that keeps that table honest is complete for the METHODS the canary
  scenario exercises and is not a claim about the whole facade; a method added
  to a snapshot section in a future phase has to be added to the canary table by
  hand.
- **`hq_projects` carries no engine guard and is in neither census**, and the
  measured effect on the budget derivation is NONE — recorded, with the
  measurement and the pin, in `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md`'s
  NOT-fixed list.
- **The `sk-` credential shape refuses a class of git BRANCH NAME**, disclosed
  above with the executed boundary (5 refused of 15 real and near-miss names).
  Unchanged decision: the ASCII spelling was already refused, and narrowing a
  credential rule to buy back availability is a change in the direction of
  under-refusal.
- **`facade-write-scan.test.ts`'s METHOD classification has a curated base
  case.** `WRITE_MARKERS` is a regex of write spellings, closed over the class's
  own call graph; a write in a spelling it does not name, reached through a
  module-level function rather than a method of this class, would be missed. No
  such method exists at this head.
- **An unreadable JSON column now reads as EMPTY rather than raising**, which is
  a choice with a cost: an action intent whose `payload` reads as `{}` no longer
  matches its own stored digest, so every path that acts on a payload refuses
  it, and a Founder sees an intent with no risk factors rather than a console
  that will not render. Raising is the outcome that was closed; reading the
  planted content is not something any reader could do.

## Wave 5 correction round thirteen, the THIRD lane: the classifier, not the parameters

A fresh read-only hostile review of the round-twelve reconciled head
(`582c239`) returned **0 Critical / 0 High / 1 Medium / 4 Low**, and could not
break any enforcement guarantee. All five are closed here. This lane ran
concurrently with the two round-thirteen lanes recorded immediately above and
was built on the same `582c239`; the reconciliation of all three, with every
figure re-measured at the merged head, is the section that follows this one.

### MEDIUM 1 — a derivation gap, not a live exploit

`facade-write-scan.test.ts` claims that "no string parameter of a facade write
reaches storage unscanned" and that "a parameter ADDED to an input type in a
future phase is covered the day it is added". Both were true only of the 64
public methods its `WRITE_MARKERS` regex happened to match — a regex over ONE
method body. A public method whose write happens inside a `#private` helper was
not a write as far as that file was concerned, and every parameter it declared
contributed **zero** rows to the derivation. Nothing could fire on that: the
only floor was `expect(facts.length).toBeGreaterThan(200)` against 262 derived
pairs, and a method excluded from the write set produces no pairs at all.

Eight public methods sat in that hole. **This was not a live outage.** Every
unscanned value was traced to its sink and none could reach storage carrying a
credential shape and correspond to anything: the two `idempotencyKey`s are
folded into `decisionIdempotencyKey()`, a `sha256(canonicalJson(...))`, so only
the digest lands; `taskId`, `workerId`, `decisionId`, `requestedBy` and `actor`
are each bounded by `#runClaimRefusal`, `#resolveDecisionReference`,
`#resolveContributor` or `#assertApprovalAuthority` before any write; and what
does reach append-only storage on a refusal lands in `op_evidence.payload`,
which no control route serves. What was wrong is that the defence rested on
properties nobody had enumerated — the exact substitution of a reasoned argument
for a derivation that this file exists to end.

Six of the eight genuinely write, and all six now scan at the source:

| Method | What writes, and where the write is | Now |
|---|---|---|
| `reconciliationAuthorityRefusal` | `#assertApprovalAuthority` appends `{actorId: actor, action, reason}` to `op_evidence` on a refusal | `assertNoCredentialShape({actor})` first; measured to append nothing on a credential shape |
| `assignTaskAsFounder` | `#resolveFounderGateActor` → `#resolveRequester` appends `{actorId: founderId, action: 'assign task <taskId>'}` before `assignTask`'s own scan is reached | `callerTextRefusal(input, ['rationale'])` first |
| `assembleCollaborationContext` | the same `#resolveRequester` append, carrying `requestedBy` | `callerTextRefusal(input)` first |
| `recordIntelligenceDecision` | `#insertDecision` holds the `INSERT INTO hq_intel_decisions`; `taskId` / `workerId` land in `task_id` / `issued_by` | `callerTextRefusal(input, ['label'])` first |
| `escalateIntelligenceDecision` | the same `#insertDecision` | `callerTextRefusal(input)` first |
| `evaluateTaskEligibility` | `this.routeTask` appends `routing_evaluated` | `callerTextRefusal({taskId})` first, so the coverage no longer depends on that delegation being the first statement |

The other two — `intelligenceBudgetDecision` and `intelligenceRoutingProposal` —
are the call graph's over-approximations. Both are on the READ list of
`safe-mode-disposition.test.ts`, which already names them as reads the
reachability reaches only through a branch they cannot take, and MEASURES both
by table delta as writing no row at all. They are exempt here on that
measurement, named with it, rather than scanned as if they wrote.

Two further spellings of the same under-reading are closed with it. A named
input type was resolved only when `export interface X {` was declared in
`service.ts` itself, so `registerAiMember`'s `RegisterMemberInput` — which lives
in `registry/members.ts` — enumerated **nothing**; it is scanned at runtime, but
by luck rather than by the mechanism. And the inline-object field matcher
required `;`, `,`, a newline or `)` after the type, so
`assessHqIntegrity(input: { requestedBy: string })` enumerated nothing either.

**What now fires.** The classifier follows the class's own call graph — the same
fixpoint `safe-mode-disposition.test.ts` computes for the safe-mode
dispositions — and three method-level assertions were added beside the pair
floor, which was raised from 200 to 280:

- the set of methods classified ONLY transitively must equal a named roster, in
  both directions, and each must be invisible to the direct predicate;
- every write-classified method must enumerate a parameter or appear in a
  ZERO-PARAMETER roster, asserted by EQUALITY — so adding a text parameter to
  one of them fails the build until it is enumerated;
- the six that genuinely write must have every parameter reach a scan.

**Derivation at this head:** 148 public methods, **72** classified as writes
(was 64), **292** (method, parameter) pairs (was 262), one zero-parameter write
(`reserveEvidence<T>(fn: () => T)`), three exempt pairs (`lookupPrincipal.id`,
`intelligenceBudgetDecision.scopeId`, `intelligenceRoutingProposal.taskId`).

**Executed against the pre-fix source**: the new derivation reports 14 uncovered
pairs across the six methods; the pre-fix derivation, asserted against the new
claims, misses all eight transitively-classified methods, reports
`assessHqIntegrity` and `registerAiMember` as enumerating zero parameters, and
does not contain `registerAiMember.displayName` among its 262 pairs. Four of the
six new behavioural refusals fail against the pre-fix source
(`reconciliationAuthorityRefusal` answers `may not …` rather than a credential
refusal; the other three answer `not_permitted`, `unknown_principal` and
`unknown_task`).

### The four Lows, all doc/comment honesty

- **LOW 1** — the enforcement-safe read audit's row for "the RECORDED verdict a
  construction re-reads" named a function that exists nowhere. Dead name, then
  live one: `latestIntegrityVerdict` → `standingIntegrityVerdict`
  (`application/reliability-command.ts`), renamed inside this wave by `ba02f81`,
  with the rename recorded two pages down and the table row never updated. Both mentions corrected, and **pinned**: `phase-doc-name-truth.test.ts`
  requires every backticked code identifier in that table's "Reads through"
  column to resolve to a real declaration under `src/`, and proves the checker
  can tell the two names apart.
- **LOW 2** — `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md` named
  `recordCostEntry` where the method is `recordIntelligenceCost`, and the
  sentence was otherwise true of it. Corrected, and added to a retired-name
  register in the same test. A general sweep of every backticked camelCase word in these
  two pages is NOT viable — it collides with vitest matchers, node calls and
  JSON keys, and the allow-list would go stale the way the rows did — so the
  register is narrow on purpose.
- **LOW 3** — two test files (`integrity-statement-truth.test.ts`,
  `facade-write-scan.test.ts`) said "would relax the deadline for all 3425 tests
  in this package". The package had 3442. The number is removed rather than
  re-measured, because the reason a global `testTimeout` is the wrong instrument
  is that it reaches every test however many there are. Pinned: no test file in
  the package may state a present-tense whole-suite count. The three HISTORICAL
  measurements at a named head are deliberately not swept — they record what an
  experiment produced and stay true.
- **LOW 4** — two superseded suite figures on this page read as present-tense
  claims about "the whole suite". Both now name the head they were measured at
  (`5126ffe`), rather than being rewritten. The other two occurrences were
  already head-scoped by their own section headings. **The disclosure this page
  already carries is unchanged and still true: a cost figure written in THIS
  document is read by no test.**

### Verification at THIS LANE's head (`faa642d`)

All green, exit 0, run in this worktree. These figures describe `faa642d` and
are deliberately not rewritten; the merged head's are measured again in the
reconciliation section below.

| Check | Reconciled round-twelve head (`582c239`) | This lane (`faa642d`) |
|---|---|---|
| `npm run test:hq` | 193 files / 3442 tests | **194 files / 3457 tests** |
| `typecheck @factoryos/headquarter` | clean | **clean** |
| `@factoryos/hq-host` test + typecheck | 23 / 222, clean | **23 / 222**, clean |
| `@factoryos/hq-server` test + typecheck | 2 / 20, clean | **2 / 20**, clean |
| root `npm test` | 37 / 569 + 3 skips | **37 / 569 + 3 pre-existing skips** |
| `npm run build` (web initial JS) | 215.66 kB / 69.22 kB gzip | **215.66 kB / 69.22 kB gzip** |
| `npm run build:site` | 10 pages + `hq-snapshot.json` | **10 pages + `hq-snapshot.json`** |

The re-attack battery holds unchanged: `registerExecutionWorker`,
`engageKillSwitch`, `setIntelligenceBudget` and `recordModelObservation` all
still refuse `invalid_input` with the field named, legitimate forms still land,
and no `CONTROL_ROUTES` GET is bricked including after restart;
`submitResult(..., ['sk-…'])` and `postMissionMessage({refs:['sk-…']})` still
refuse, nested forms included, while ordinary refs arrays still land; under a
genuine latch `ops.queue.claim` throws, `ops.claimNext` refuses
`safe_mode_engaged`, and `assessHqIntegrity` / `engageKillSwitch` /
`hqReliabilityPosture` stay available; `verifyHqBackupFile` answers
`chainVerified: true`, `candidate_census_unavailable` and
`would_latch_safe_mode` on the four cases with the candidate sha256 unchanged
and no sidecars; all five non-AUTOINCREMENT ledgers are still caught on erasure
with no false positive on restart, `VACUUM`, `.backup()` or `VACUUM INTO`; and
the frozen collections still refuse every mutator spelling while remaining
`instanceof Set` and spreadable.

## The reconciliation of the THREE round-thirteen lanes

Round thirteen was run three times, concurrently, off the same base. Two of
them had already merged with each other on `origin` (`f348f9a`, whose own two
sections stand above); the third is the section immediately preceding this one
(`faa642d`). This section records the merge of those two heads — a true merge,
both parents, **nothing discarded in either direction** — and re-derives every
figure it states from the MERGED code rather than copying one from either side.

### What each side brought

| Lane | Head | What it closed |
|---|---|---|
| the rowid / burn lane | `7cd9538`…`f348f9a` | the rowid channel on every declared ledger (`no_rowid_skip` on all 33, `ledger-rowid-guard.test.ts`), the complete burn enumeration, the padded prefix replay disclosed, write-once row identity (`no_reidentify`, `budget-scope-identity.test.ts`), two unpinned evidence-link defences (`evidence-link-defences.test.ts`), the two Unicode category sizes, `readCommitmentWitness` made module-private |
| the empty-key / cost lane | `943de09`…`f348f9a` | the empty-key JSON-path poison that silently disabled `committedLedgerGaps` for ever, the commitment shape guard, the reader that failed OPEN, the cost clause blind to its own `db.pragma()` reads (`STRUCTURAL_STATEMENT_BASE` 44 → 48), the seventeenth backup refusal and its docblock pin, the crash-recovery deadline |
| the classifier lane | `faa642d` | the facade write classification derived over the CALL GRAPH instead of one method body (eight public methods were invisible to it, six of which genuinely write), named input types resolved across module boundaries, three method-level assertions that actually fire, and four doc/comment honesty corrections — one of which is pinned by the new `phase-doc-name-truth.test.ts` |

### The conflict, and how it was resolved

**Exactly one file conflicted: this one.** `src/application/service.ts`,
`test/integrity-statement-truth.test.ts` and
`PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md` auto-merged and were re-read
rather than trusted — the classifier lane's six `callerTextRefusal` /
`assertNoCredentialShape` insertions and the rowid lane's
`ensureLedgerRowidGuards` / `ensureWriteOnceIdentityGuards` boot calls and
`#canonicalTaskScopes` rewrite all survive together, and the instrument in
`integrity-statement-truth.test.ts` carries the `db.pragma` / `db.exec` routes
with no stale suite count left in it.

Two hunks, both resolved by COMPOSING:

1. **The cost-figure residual bullet.** Both lanes rewrote the same sentence.
   The classifier lane head-scoped a superseded figure ("48 … measured at
   `5126ffe`"); the other lane re-measured it against the corrected instrument
   ("52 … 193 files / 3451 tests"). The second SUBSUMES the first on the
   number — 52 is what the bullet above it now says, and 48 was the figure the
   pragma correction retired — so the re-measured sentence is what ships, with
   the head-scoping discipline of the first kept and the measurement **executed
   again here**: see the figure table below.
2. **The tail of this page.** Both sides appended a new `##` section at the
   same place. Both are kept, in full, the two-lane merge first because it
   describes the head the third lane also built on. The third lane's section
   heading and its verification table are head-scoped to `faa642d` rather than
   rewritten, because they record what that lane actually measured.

One correction was inherited rather than authored: the crash-recovery deadline
docblock the other lane added ("would relax the deadline for all 3451 tests in
this package") is exactly the defect the classifier lane's Low 3 closed in two
other files, and `phase-doc-name-truth.test.ts` FAILED on it at the first run
after the merge. The number is removed there for the same reason it was removed
in the other two — a global `testTimeout` is the wrong instrument because it
reaches every test, however many there are — and the pin is what found it.

### Every figure re-derived at the merged head

Nothing below is copied from either parent. Each was measured against the
merged working tree before it was written.

| Figure | Parent value(s) | Merged head |
|---|---|---|
| `npm run test:hq` | 194 / 3457 (`faa642d`), 193 / 3451 (`f348f9a`) | **197 files / 3494 tests** |
| test FILES in `packages/headquarter/test` | 194, 196 | **197** (the union: one new file from the classifier lane, three from the other two) |
| facade-write derivation: public methods | 148 | **148** |
| facade-write derivation: write-classified | 72 (was 64 before round thirteen) | **72** |
| facade-write derivation: (method, parameter) pairs | **296** as first published, corrected to 292 | **292**, re-derived from the committed test's own derivation |
| zero-parameter writes | `reserveEvidence` | **1** — `reserveEvidence` |
| `EXEMPT_PARAMETERS` | 3 | **3** — `lookupPrincipal.id`, `intelligenceBudgetDecision.scopeId`, `intelligenceRoutingProposal.taskId` |
| `BACKUP_REFUSAL_REASONS` | 16 at `237fc76`, 17 after the round-eleven merge | **17**, with **14** exercised |
| `ENGINE_IMMUTABLE_TABLES` | 33 | **33** |
| `CONTROL_ROUTES` | 47 | **47** |
| `HQ_INTEGRITY_FINDINGS` | 7 | **7** |
| `SAFE_MODE_BLOCKING_FINDINGS` | 4 | **4** |
| members of `service.ts` calling `missionText` | 29 | **29**, none of them unscanned |
| `assertNoCredentialShape` call sites | 48 when the count was removed; 49 at `582c239` | **50**, all in `service.ts` |
| `STRUCTURAL_STATEMENT_BASE` | 44 → 48 | **48**, with 50 and 52 as the two files' totals |

**The disclosure both lanes carry is unchanged and was re-executed here rather
than quoted:** a cost figure written in THIS document is read by no test.
Writing "61 statements executed per pass" into the residual bullet above left
the whole suite green at 197 files / 3494 tests. The price is the same at every
head that has measured it, which is why it is disclosed rather than described
as closed.

Two of the eight methods the classifier lane's Medium 1 swept in —
`intelligenceBudgetDecision` and `intelligenceRoutingProposal` — remain READS,
exempted on `safe-mode-disposition.test.ts`'s existing MEASUREMENT that both
write zero rows, not on a sentence. The merge does not reclassify them, and the
call graph still reaches them only through a doc comment containing
`UPDATE hq_missions SET` in `#recordedScopesForTask`.

One exported symbol is gone from the merged head relative to the classifier
lane's parent: `readCommitmentWitness`, made module-private by the other lane's
Low 4 as dead public surface. That is a deliberate narrowing recorded above,
not a merge casualty — it has no consumer in `packages/`, and
`commitmentWitnessPresent` / `committedCheckpointMark` stay exported.

### Verification at the merged head

All green, exit 0, run in this worktree.

| Check | `faa642d` | `f348f9a` | Merged head |
|---|---|---|---|
| `npm run test:hq` | 194 / 3457 | 193 / 3451 | **197 files / 3494 tests** |
| `typecheck @factoryos/headquarter` | clean | clean | **clean** |
| `@factoryos/hq-host` test + typecheck | 23 / 222, clean | 23 / 222, clean | **23 / 222**, clean |
| `@factoryos/hq-server` test + typecheck | 2 / 20, clean | 2 / 20, clean | **2 / 20**, clean |
| root `npm test` | 37 / 569 + 3 skips | 37 / 569 + 3 skips | **37 / 569 + 3 pre-existing skips** |
| `npm run build` (web initial JS) | 215.66 kB / 69.22 kB gzip | same | **215.66 kB / 69.22 kB gzip** |
| `npm run build:site` | 10 pages + `hq-snapshot.json` | same | **10 pages + `hq-snapshot.json`** |

Zero test files deleted; no `.skip` / `.only` / `.todo` / `xit` / `xdescribe`
anywhere in the package; no test file carries fewer `it(` declarations than it
did in EITHER parent. The merge's diff touches `packages/headquarter/` and
`docs/HEADQUARTER/` only.

### The re-attack battery, executed against the merged head

Not quoted from either parent. The four identifier refusals name the field in
the message, measured on a real file:

```
registerExecutionWorker.workerId  ok=false invalid_input  String matches a known credential shape (at stored_text.workerId)
engageKillSwitch.scope            ok=false invalid_input  String matches a known credential shape (at stored_text.scope)
setIntelligenceBudget.scopeId     ok=false invalid_input  String matches a known credential shape (at stored_text.scopeId)
recordModelObservation.providerId ok=false invalid_input  String matches a known credential shape (at stored_text.providerId)
recordModelObservation.modelId    ok=false invalid_input  String matches a known credential shape (at stored_text.modelId)
legitimate registerExecutionWorker / engageKillSwitch: ok=true, ok=true
```

The nested spellings are refused at the sink and the ordinary array still
lands:

```
postMissionMessage refs ['sk-…']     -> invalid_input (at stored_text.refs[0])
postMissionMessage refs [['sk-…']]   -> invalid_input (at stored_text.refs[0][0])
postMissionMessage refs [{k:'sk-…'}] -> invalid_input (at stored_text.refs[0].k)
postMissionMessage refs ['mission-1', 'docs/…PHASE_13…md'] -> ok
```

A frozen collection refuses every mutator spelling and stays a readable `Set`:

```
add/delete/clear = refused(TypeError); Set.prototype.{add,delete,clear}.call = refused(TypeError)
instanceof Set = true; constructor === Set = true; spread = ["done","failed"];
forEach = ["done","failed"]; size = 2
```

The remaining guarantees were re-executed through the files that pin them, all
green at this head: `facade-write-scan.test.ts` (34) and
`credential-scan-coverage.test.ts` (3) for the write scan and the control-route
replay in two separate processes; `queue-safe-mode-enforcement.test.ts` (6) and
`safe-mode-disposition.test.ts` (16) for the latch — `ops.queue.claim` throwing,
`ops.claimNext` refusing `safe_mode_engaged`, and `assessHqIntegrity` /
`engageKillSwitch` / `hqReliabilityPosture` staying available, including with a
permissive gate appended; `backup-verification-census.test.ts` (4),
`backup-candidate-standing-verdict.test.ts` (5) and
`backup-refusal-vocabulary.test.ts` (4) for the four `verifyHqBackupFile` cases
with the candidate sha256 unchanged and no sidecars;
`reliability-durability.test.ts` (56), `ledger-rowid-contiguity.test.ts` (9) and
`ledger-rowid-guard.test.ts` (6) for the five non-AUTOINCREMENT ledgers on
erasure with no false positive on restart, `VACUUM`, `.backup()` or
`VACUUM INTO`; and `frozen-constants-census.test.ts` (18) for the retained
pre-freeze reference. 161 tests across those eleven files, 161 passed.


> **MERGE NOTE.** Two round-fourteen lanes ran concurrently against the same
> base and both audited the rowid channel. Both sections are kept below in full,
> and the merged head carries the UNION of their guarantees with ONE
> implementation of each shared fix. What the merge decided, in the two places
> the lanes overlapped:
>
>  - **the bound from below** — both lanes wrote `no_rowid_reseat`, with the
>    same name and the same `AFTER INSERT` timing. The OTHER lane's version is
>    the implementation kept, because it comes with `no_rowid_move` and a
>    `LEDGER_ROWID_GUARDS` declaration that closes the whole question of how a
>    row's position changes rather than one further side of it. THIS lane's
>    `NEW.rowid < 1` term is kept ON that clause, because the identity clause
>    alone admits a plant at rowid -1 on an EMPTY ledger — where the plant IS
>    the maximum — and a landed row at -1 bricks every auto-assigned append that
>    follows. Both lanes' sweeps are kept, and the empty-ledger case is now
>    swept on all 33.
>  - **the replacement route on `op_tasks`** — both lanes closed
>    `INSERT OR REPLACE`. The other lane's DERIVED `no_unique_reentry` is the
>    implementation kept, because it REPORTS a unique index it cannot express
>    (`unguardedUniqueIndexes`) where this lane's version skipped one silently.
>    THIS lane's `no_erase` is kept beside it, because the other lane did not
>    close the `DELETE` + `INSERT` route, which was live at TWO statements.
>
> Everything else in the two sections is disjoint. Both prices, both sweeps and
> both residual lists stand as written, with the numbers this merge re-measured.

## Wave 5 correction round FOURTEEN — a bound with one side, a rowid the engine spells for itself, and an enumeration that was one of three

Two fresh read-only hostile reviewers audited `f348f9a` independently and
returned **0 Critical / 4 High / 4 Medium / 7 Low**. This branch had already
moved to `8481269` by the time the round started — the concurrent round-thirteen
classifier lane had landed — so **every finding was re-executed at the merged
head before anything was changed**, and two of them were found already closed
there. The verdicts below are per finding, and every price is the one measured
at `8481269` rather than the one reported.

**The class, for the fifth consecutive round: a partial enumeration standing in
for the complete one.** A bound with one side (`no_rowid_skip`), one identity
spelling of three (`op_tasks`), two methods standing for a whole facade (the
artifact canary), and a curated method vocabulary standing for every write
(`WRITE_MARKERS`). The answer this round is the same in each case — make the
enumeration complete BY CONSTRUCTION, and make the pinning test enumerate the
same way — and where it cannot be complete, say so plainly instead of writing a
sentence that implies it is. Three such boundaries are now written down: what
`committedRemovalsBelowMark` cannot separate, which unique-index shapes the
derived guard reports instead of guarding, and what the canary derivation does
and does not cover.

| finding | verdict | where |
|---|---|---|
| **HIGH 1** — `no_rowid_skip` bounds only from above, so a mid-ledger deletion is laundered to a clean store by ONE further permitted `INSERT`; silent on 30 of 33 ledgers | **FIXED** at the write (`no_rowid_reseat` on all 33 — the concurrent lane's implementation, which also adds `no_rowid_move`) and at the read (`committedRemovalsBelowMark` separates a removal from a plant); the three false docblocks and the `SAFE_MODE_STATEMENT` clause corrected | the HIGH 1/HIGH 2 section above, and the merge note |
| **HIGH 2** — one permitted `INSERT` at rowid `-1` bricks HQ's own appends, kill switch included | **FIXED**; the plant is refused, and `engageKillSwitch`, `releaseKillSwitch` and `assessHqIntegrity` now REFUSE rather than throw when HQ's own store will not take the append | the same section |
| **HIGH 3** — a seventh budget-ceiling route: `op_tasks` carried one identity guard of three | **FIXED**; the table now declares all three — `no_reidentify`, the concurrent lane's derived `no_unique_reentry` (partial unique index included), and this lane's `no_erase` | `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md`, and the merge note |
| **HIGH 4** — the unauthenticated artifact publishes far more Founder-typed text than the disclosure says, and the pin was vacuous | **FIXED as a disclosure**: measured at 20 of 34, the table above rewritten, the pin now plants every field and asserts the exact crossing set in both directions | the publication-surface section above |
| **MEDIUM 1** — the `op_tasks` residual was priced 3x too high | **FIXED**; prices measured per route | `PHASE_14…md` |
| **MEDIUM 2** — `facade-write-scan.test.ts` gated on a curated METHOD vocabulary | **ALREADY FIXED at the merged head** by the concurrent round-thirteen lane, which closed `WRITE_MARKERS` over the call graph; the surviving overstatement ("no curated vocabulary anywhere") is corrected to the true scope | the HIGH 4 row of the round-thirteen reconciliation, with its scope note |
| **MEDIUM 3** — `hqReliabilityPosture()` throws uncaught on one permitted append | **FIXED**; the action-intent reader is total over anything a raw writer can store | pinned in `action-gateway-durability.test.ts` |
| **MEDIUM 4** — the `op_tasks.payload` provider-scope route carried no pin | **FIXED**; the disclosed residual is now executed at its one-statement price, with the half that HOLDS pinned beside it | `PHASE_14…md` |
| **LOW 1** — `ledgerRowidGuardDdl` emits a one-argument `MAX()` with no `sqlite_sequence` | **FIXED** (latent, not reachable on a real HQ file); pinned on `hq_missions`, one of the five non-AUTOINCREMENT ledgers | `ledger-rowid-guard.test.ts` |
| **LOW 2** — stale worked figures in `integrity-statement-truth.test.ts` | **FIXED**; 46/48/11 → 50/52/15, and the comment now says why the assertions never caught it | that file |
| **LOW 3** — the `NEW.rowid` comment | **FIXED**; the value is deterministically the integer `-1`, and it is now MEASURED by a probe trigger rather than described | `ledger-rowid-guard.test.ts` |
| **LOW 4** — "concurrent boots produce identical checkpoints" was not reproduced | **NOT A DEFECT.** Re-running the reviewer's own experiment EIGHT times reproduced their result six times and its OPPOSITE twice: the collision is real and intermittent, between different processes. The sentence stands; what is added is the frequency, and a test that cannot report either sample as settled | `reliability-commitment-prefix-replay.test.ts` |
| **LOW 5** — the credential-scan false-positive cost misses git branch names | **FIXED as a disclosure**; the class is real and NARROW, executed at 5 refused of 15, with the boundary measured on both sides | the LOW 2 row above, and `credential-scan-false-positive-class.test.ts` |
| **LOW 6** — `registerExecutionWorker` throws on an omitted field | **FIXED**; it refuses `invalid_input` and never raises | `worker-registration.test.ts` |
| **LOW 7** — `hq_projects` is unguarded and uncensused | **RECORDED, not closed**: measured effect on the budget derivation is NONE, and the property that makes that true is pinned so a future join fails there first | `PHASE_14…md` |

**How each fix was verified.** Every pin was run against the pre-fix tree in a
scratch worktree at `8481269` and confirmed to FAIL there, with the reason
recorded per finding. A mutation sweep was then run over every defence added or
touched: **24 mutations, 24 killed**, with two survivors on the first pass — the
primary-key fallback in this lane's own key derivation (retired at the merge in
favour of the other lane's, which reports rather than skips) and the three-guard
identity census
— each given the pin that kills it rather than being reported as covered.

## Wave 5 correction round FOURTEEN: how a row enters or moves, and the unique index nobody guarded

A fresh independent read-only hostile review of `24ac1b7` returned **FAIL — 0
Critical / 2 High / 2 Medium / 1 Low**, and named one shared root cause across
High 1, Medium 2 and half of High 2: **an enumeration of how a row can enter or
change position in a ledger that stops one spelling short.** That is the fifth
consecutive round whose High is a partial enumeration, so this round closes the
QUESTION rather than the instances.

Every finding below was re-confirmed by execution at `8481269` — a
fast-forward past the reviewed `24ac1b7` — before anything was changed, and the
refusal after the change was executed at the same place.

### The question, enumerated

There are exactly three ways a row's position in a rowid table changes, and
round thirteen closed one of them:

| spelling | guard | closed in |
|---|---|---|
| a row ENTERS above the top | `no_rowid_skip` (`BEFORE INSERT`) | round thirteen |
| a row ENTERS at or below the top — rowid 0, `-1`, any negative, a hole refill | `no_rowid_reseat` (`AFTER INSERT`) | **round fourteen** |
| a row already present MOVES — `UPDATE … SET rowid`, `ON CONFLICT … DO UPDATE SET rowid` | `no_rowid_move` (`BEFORE UPDATE`) | **round fourteen** |

All three are appended by `declaredGuardsFor`, so the set is complete BY
CONSTRUCTION on all 33 declared ledgers: a ledger cannot be declared without
declaring all three, `ensureLedgerRowidGuards` installs them by iterating
`ENGINE_IMMUTABLE_TABLES` itself, and the live-schema equality pins in
`reliability-durability.test.ts` require them to actually exist. A fourth
spelling added tomorrow is added to `LEDGER_ROWID_GUARDS` and every probe that
isolates a guard picks it up without being edited, because those probes iterate
that constant.

`VACUUM` was the fourth candidate and is measured rather than assumed: on SQLite
3.53.2 it renumbers implicit rowids only for a table with NO primary key, and all
33 declared ledgers declare one (28 an `INTEGER PRIMARY KEY`, five a `TEXT` one).
Executed on every ledger's real schema in `ledger-row-position.test.ts`, with a
no-primary-key control that DOES renumber so the reading is a fact about these
schemas rather than about the engine build. `ALTER TABLE` renumbering needs DDL
and is the standing DDL residual, unchanged.

### HIGH 1 — one `INSERT` at `seq = 0` on `op_evidence` fabricated a permanent, unclearable safe mode

`no_rowid_skip` is `NEW.rowid > 1 + MAX(top, sequence)` — one-sided by
construction — and `verifyEvidenceChain` starts at `expectedSeq = 1` and returns
`1` as soon as a lower seq sorts first. A `BEFORE INSERT` trigger cannot carry a
lower bound, because SQLite reports an omitted rowid as the integer `-1` on
AUTOINCREMENT and implicit-rowid tables alike, so `0`, `-1` and every negative
are indistinguishable from "the engine will choose".

Executed at `8481269` on a store that verified perfectly, one raw statement, no
DDL privilege:

```
before          op_evidence {c:5, lo:1, hi:5}, four declared guards present
INSERT INTO op_evidence (seq,...) VALUES (0,'ghost-row',...)   ACCEPTED
after           op_evidence {c:6, lo:0, hi:5}, four guards still present
verifyEvidenceChain -> 1
p2/p3/p4        assess safeMode=true ["evidence_chain_broken"]
```

A full Founder assessment — the documented remedy — re-derives it, and the ghost
row cannot be removed without DDL.

**Closed** by `no_rowid_reseat`: `AFTER INSERT … WHEN NEW.rowid <> (SELECT
MAX(rowid) FROM "<t>")`. The `AFTER` timing is what makes a lower bound
expressible at all — it reads the rowid the row ACTUALLY took — and it is the
same measurement that forced `no_overclaim` to `AFTER INSERT` in round thirteen.
Executed before shipping, on `op_evidence`'s real schema and then on all 33:

- refuses rowid `0`, `-1`, `-9`, a skip, and a REFILL of a freed rowid;
- permits an ordinary append, a multi-row `VALUES` append, a multi-row
  `INSERT … SELECT`, an explicit rowid AT the top, the engine's own next
  allocation after a BURNED `AUTOINCREMENT` counter, and an append onto a ledger
  that already holds a hole — so no ledger is brought to a stop and no older file
  is bricked;
- `RAISE(ABORT)` from `AFTER INSERT` persists nothing and burns no
  `AUTOINCREMENT` value under `INSERT`, `INSERT OR REPLACE`, `OR IGNORE`,
  `OR FAIL`, `OR ROLLBACK` and bare `REPLACE`, inside and outside an explicit
  transaction — and an open transaction STAYS open, so `OR ROLLBACK` does not
  become a way to discard a caller's other work.

After: the same statement throws `op_evidence rowids are contiguous`, the log is
byte-identical, `verifyEvidenceChain` returns `null`, and `p2/p3/p4` all read
`boot=false [] assess=false []`.

### MEDIUM 2 — a mid-ledger deletion DID heal, and the mechanism sentence was false

`committedLedgerGaps`' docblock said SQLite "never reissues a rowid a deleted row
held". It does, whenever a caller supplies one — which is the only case that
matters. Executed at `8481269` on `hq_reliability_verdicts`:

```
delete rowid 2                      p2/p3/p4 boot=true ["append_only_guard_missing"]
delete rowid 2, then INSERT at 2    ACCEPTED, {c:4,t:4}, p2/p3/p4 boot=false []
```

Phase 13's only durable mid-ledger-deletion detector healed for +1 statement.
The same `no_rowid_reseat` clause refuses the refill, executed on all 33; the
mechanism sentence now says the guard holds it rather than the engine, and the
`SAFE_MODE_STATEMENT` clause — served verbatim on the **unauthenticated**
`hq-snapshot.json` — no longer says "the gap it leaves in the rows is never
filled" but "an engine guard refuses any later row that would fill the gap …
Those are guards on this file, not properties of the engine: a writer that first
removes them can fill the gap, and HQ says so rather than promising otherwise."

**"served verbatim on the unauthenticated `hq-snapshot.json`" was false when
this was written, and is true now** (Wave 5 correction round fifteen, Medium 2).
The correction to the clause was real; the AUDIENCE claim was not.
`SAFE_MODE_STATEMENT` reached `#integrityView()` — `assessHqIntegrity` and
`hqReliabilityPosture`, both authenticated — and the safe-mode refusal message,
and nothing else. Executed with safe mode genuinely engaged at `c23dd0a`: full
statement on the snapshot **false**, mid-ledger clause **false**, even the
opening words "Safe mode is a statement" **false**. The snapshot's reliability
section is built by `reliabilitySummary()`, which the constant never reached.
`summarizeReliability` now carries `safeModeStatement` — the same constant, one
spelling — so the sentence above is true of the artifact rather than of an
intention, and `live-snapshot.test.ts` pins both the presence and the identity
with the authenticated view.

### HIGH 2 — one `INSERT OR REPLACE` on a SECONDARY unique index rewrote a write-once identity

`REPLACE` resolves a conflict on ANY unique index by DELETING the standing row,
and it skips `BEFORE DELETE` triggers while `recursive_triggers` is off — the
engine default, connection-scoped, and therefore true of every ordinary
connection whatever HQ's own handle is set to. This codebase states that fact in
ten other modules and applied it one table at a time. Both tables the branch
declares a write-once identity for were bypassable at ONE statement:

- **`op_tasks`** — the only member of `WRITE_ONCE_IDENTITY_TABLES` — carried no
  `no_replace*` clause at all. On the shipped `intelligenceFixture` budget scene:
  one `INSERT OR REPLACE` colliding on `idx_op_tasks_idem` at the victim's own
  rowid took the proposal from `{scopes:["deployment","mission"],
  tiers:["deterministic_local"], budgetDecision:"blocked"}` to
  `{scopes:["deployment"], tiers:[all five], budgetDecision:"within_ceiling"}`,
  and a `critical_review` write the exhausted Founder ceiling had REFUSED was
  accepted — with `missingImmutabilityGuards []` and `structuralIntegrity
  safeMode false`.
- **`hq_missions`** declares `UNIQUE(idempotency_key)` and carried no
  unique-index guard. Through the real facade from an ordinary connection: the
  mission's `id` became `HIJACKED-MISSION` with every declared guard standing and
  two later processes reading `safeMode false []`.

**Closed, and the class with it.** `hq_missions` takes a declared
`no_replace_unique` in its own module's DDL; `op_tasks` takes the DERIVED
`no_unique_reentry` guard, built from `PRAGMA index_list` / `PRAGMA index_info`
of the table as the file declares it, with `IS NOT NULL` on every indexed column
and plain `=` equality — exactly the engine's own uniqueness rule, so it is
neither wider nor narrower than the conflict it stands in for.

**Installing that derived guard on all 33 declared ledgers was built, measured
and REJECTED.**

**The measurement recorded here for that rejection was wrong, and is replaced
with the executed one** (Wave 5 correction round fifteen, Medium 4). The page
said the wider guard "pre-empts the engine's own `UNIQUE` conflict … into a
trigger `ABORT` with a different code". The code is identical with and without
it — the engine's `SQLITE_CONSTRAINT_UNIQUE` was already pre-empted at that head
by the shipped `trg_hq_action_events_no_replace_unique`:

```
without the derived guard: code=SQLITE_CONSTRAINT_TRIGGER
   msg="hq_action_events is append-only (UNIQUE side_effect_key already reserved)"
with the derived guard:    code=SQLITE_CONSTRAINT_TRIGGER
   msg="hq_action_events unique keys are write-once"
```

What broke was one substring test, `errorMessage(error).includes('side_effect_key')`
in `executeAction`'s catch — a fail-closed classification resting on a trigger's
message text. That is fixed at its source rather than worked around: the
duplicate arm now asks `sideEffectHolder`, a read of the ledger that no rename
can move. The derived guard's `RAISE` text also names the colliding columns now.

**Re-measured with both fixed, the wider form still does not ship, for a
different and real reason.** Installed on all 33 declared ledgers it SHADOWS the
hand-written `no_replace_unique`-family guard each already carries — a second
`BEFORE INSERT` trigger fires ahead of the declared one, so every refusal that
said "<table> is append-only" says "<table> unique keys are write-once" instead,
and every ledger's declared guard SET grows by one. Against the full suite at
this head that is **36 failures across 20 files**: tests that pin which guard
held a write-once identity, and tests that derive each ledger's guard inventory.
And it buys nothing to pay that with — the round-fourteen audit found ZERO
unguarded secondary unique indexes across all 54 on the 33 ledgers, so the wider
install adds no coverage today. Its only value would be forward coverage for an
index added tomorrow, which `unique-index-reentry.test.ts` already provides by
execution on the day it is added.

So the CLASS is closed by EXECUTION rather than by installation:
`unique-index-reentry.test.ts` enumerates every unique index of all 33 declared
ledgers and every write-once identity table from `PRAGMA index_list` /
`PRAGMA index_info` on a copy of the live schema — every table, index and trigger
a real file has, with `recursive_triggers` at the engine default of OFF — and
drives a colliding `INSERT OR REPLACE` and a bare `REPLACE` on each, requiring an
abort with the standing row byte-identical afterwards. A unique index added
tomorrow with nothing holding it fails that file on the day it is added, and it
fails because the engine accepted a forgery rather than because a regex did not
find a column name in a trigger's text.

### MEDIUM 1 — the gap baseline was poisoned by ONE permitted append, not three statements

Recorded in full on the bullet it corrects, above. In short: `no_overclaim`
bounded `ledger_marks` and `ledger_rows` from above and nothing bounded the
DIFFERENCE `committedLedgerGaps` consumes, so a commitment carrying HQ's own
marks and a lower row count for one ledger passed every clause at ONE statement
— and the page said that route cost three. The guard now bounds the committed
gap by the file's own `MAX(rowid) − COUNT(*)`, gated on the commitment naming a
row count for that ledger so it is exactly as wide as the reader and no wider.
The sentence is corrected as well as the code.

### LOW 1 — `unboundedCheckpointColumns` derives NAMED, not BOUNDED

The check is `new RegExp("\\bNEW\\." + column + "\\b").test(triggerSql)`, and the
docblock claimed it established that a column added tomorrow "is either BOUNDED
by a clause that names it or named here". It establishes the weaker thing. The
claim is now stated at its real width, with the reason the stronger check is not
attempted (evaluating a SQL expression out of a trigger's text is a parser this
module does not have and will not pretend to), and the executed enumeration in
`commitment-overclaim.test.ts` is named as what actually establishes the bound.
Two real defects in the match are fixed rather than only described: the
interpolated `.` was an unescaped metacharacter, so `NEWXseq` satisfied the check
for `seq`; and SQL comments are now stripped, so a column named only in a `--`
or block comment is reported. Both are executed in
`commitment-gap-bound.test.ts`, together with a test that ASSERTS the honest
limit — a clause that names every deciding column and bounds nothing satisfies
the derivation — so the docblock can never quietly claim otherwise again.

### What round fourteen adds to the NOT-fixed list

- **All five new guards are steps, not boundaries**, at the same three-statement
  price as every other engine guard here: `DROP TRIGGER`, the write, re-create.
  A guard re-created before the next boot is never observed missing, because the
  as-found census reads `sqlite_master` at construction time only.
- **The derived unique-index guard is installed on the write-once identity
  tables only.** The 33 declared ledgers keep the hand-written
  `no_replace_unique`-family guards they already carry; the class is held by an
  executed test rather than by an installed clause, for the measured reason
  above. That is a real difference and it is stated rather than smoothed over: a
  unique index added to a declared ledger tomorrow is CAUGHT by a failing test on
  the day it is added, not COVERED by a guard on that day.
- **The unique-index guards refuse the `DO UPDATE` branch too, and that is
  deliberate.** A `BEFORE INSERT` trigger fires before conflict resolution, so
  `trg_op_tasks_no_unique_reentry` and `trg_hq_missions_no_replace_unique` abort
  `REPLACE`, `INSERT OR REPLACE` and `ON CONFLICT … DO UPDATE` alike on the
  indexes they name — including a `DO UPDATE` that would only have touched an
  ordinary column. Measured on both tables. No path in this repository upserts
  either one (`createTask` looks the idempotency key up first; `commandMission`
  inserts), and both real writers are driven in `unique-index-reentry.test.ts`
  to show they are untouched; a future writer that wants an upsert here has to
  change the declaration rather than discover this.
- **`VACUUM` is measured, not guaranteed.** No trigger sees it. The reading
  above rests on every declared ledger having a primary key, which is asserted per
  ledger in `ledger-row-position.test.ts`; a future ledger declared without one
  would be renumbered by a single `VACUUM`, and that test is what would say so.
