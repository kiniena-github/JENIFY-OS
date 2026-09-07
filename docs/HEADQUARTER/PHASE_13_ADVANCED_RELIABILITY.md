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

**It engages on three findings, and only three**, each of which means HQ's own
record cannot be trusted:

- `database_integrity_check_failed` — the engine says the file is corrupt;
- `append_only_guard_missing` — a guard the schema DECLARES is absent;
- `evidence_chain_broken` — the hash-chained log does not verify (or cannot be
  verified at all; an unverifiable chain is treated as a broken one).

`foreign_key_violations`, `durability_below_requirement` and
`reliability_schema_absent` are REPORTED and do not engage it. That is argued
rather than assumed: a dangling reference is a defect in a relationship and a
degraded durability posture risks the NEXT crash, but neither says a recorded
fact is false, and treating them as corruption would make safe mode a thing
operators route around instead of a thing they act on.

### What it refuses, and what it deliberately does not

| Refused | Kept available |
|---|---|
| every Founder-gated command write (mission, project, memory, truth, orchestrate, collaboration, brief, product) | every READ — a Founder who cannot see the store cannot fix it |
| `approveTask` — an approval bound now would sit primed to run the moment safe mode clears | `denyTask` — the fail-safe direction |
| `authorizeAction` — the external-action analogue of the same argument: the `authorized` snapshot is captured from canonical truth HQ has just declared untrustworthy, it outlives the clearing of safe mode, and `executeAction` compares against it | `proposeAction` — a proposal is a request, not an authorization, and it reaches nothing |
| `releaseKillSwitch` | `engageKillSwitch` — the fail-safe direction |
| `registerExecutionWorker`, `declareWorkerProvider` — the two that ADD authority | `revokeWorkerProvider`, `deactivateExecutionWorker` — the two that remove it |
| `claimNext` — refused as `safe_mode_engaged`, distinctly from `nothing_claimable` | `recoverInterruptedRuns` and `reconcileRun` — the acts that resolve the state |
| `executeAction` — refused BEFORE the reservation, so no side-effect key is burned | `assessHqIntegrity` and `recordVerifiedBackup` — the acts that investigate and clear it |
| `openRun` / `startRunAttempt` / `recordRunOutcome` | |
| `recordIntelligenceDecision`, `escalateIntelligenceDecision`, `recordIntelligenceOutcome`, `recordIntelligenceCost`, `recordModelObservation`, `setIntelligenceBudget` (Phase 14) | |

The asymmetry is the point: safe mode never removes a way to STOP something and
never removes a way to find out what is wrong.

**The mutators deliberately left AVAILABLE, each with its reason** (Wave 5
review, Medium finding 7 — `authorizeAction` was in neither column, and neither
was anything else in this list, so "what safe mode refuses" was a partial
statement presented as a complete one).

That table was still incomplete, and one of the entries missing from it granted
AUTHORITY (Wave 5 correction round three, Medium A8). `registerExecutionWorker`
created a worker identity WITH its `allowedCapabilities` straight into
`hq_specialists` — the table `#grantOf` reads at every enforcement point — while
HQ had declared its own record untrustworthy, and registration is create-only
with no revoke path. `declareWorkerProvider` is the same act one field across:
it is what lets a worker claim provider-bound work at all. Both are REFUSED now,
and `SAFE_MODE_STATEMENT` names them. The five that remain available were each
decided deliberately rather than by omission, and the reason is recorded on the
method as well as here.

| Left available | Why |
|---|---|
| `createTask` | a queued task is a request that cannot execute: claiming it is refused, so nothing it carries can happen while safe mode stands. Refusing creation would stop a Founder recording the very work that fixes the store. |
| `assignTask` | assignment narrows who MAY claim; the claim itself is refused. It removes an option, it never adds one. |
| `startTask`, `submitResult` | both belong to work already claimed and already running. Refusing them would strand a live execution with nowhere to report, which loses truth rather than protecting it. |
| `reviewTask` | a `pass` verdict completes a task and is the closest of these to an approval, but the task it completes was claimed and executed BEFORE safe mode engaged. Refusing the verdict does not un-execute it; it only leaves HQ unable to record what happened. **Stated as the argued judgement it is, not as an obvious one.** |
| `proposeAction`, `proposeMission`, `promoteProposal` | a proposal reaches nothing and authorizes nothing; `authorizeAction` and `executeAction` are both refused, and the task a promotion creates cannot be claimed, so none of the three can become an act. |
| `routeTask` | advisory routing. `eligible` is computed from the capability registry and the directory allow-list, it changes no canonical state, and the claim it might inform is refused anyway. The only thing it can write is an evidence note saying a nomination source misbehaved. |
| `appendSystemEvidence` | the entry that had to be ARGUED, because it appends into the very hash chain a latched `evidence_chain_broken` finding is a statement about. Every kind it can still write records a system lane REFUSING to act (`claude_github_dispatch_refused`, `direct_order_dispatch_blocked`); the kinds that DECIDE a dispatch outcome are structurally excluded and reachable only through the constructor grant; and the actor is a reserved system name that can never resolve to a principal or a worker. It grants nothing and concludes nothing, and refusing it would leave a lane unable to record that it declined — losing truth in the posture built for not losing truth. The same argument as `startTask`/`submitResult`. |
| `revokeWorkerProvider`, `deactivateExecutionWorker` | strictly NARROWING: each can only take authority away, and there is no reactivate method. `declareWorkerProvider` and `registerExecutionWorker` are refused for the mirror-image reason. |
| `reconcileAction`, `reconcileRun`, `recoverInterruptedRuns` | the acts that RESOLVE an uncertain state. Refusing them would make safe mode self-sustaining. |
| `engageKillSwitch`, `denyTask` | the fail-safe directions. |

### When it is assessed, and the cost of each

| Depth | What runs | When |
|---|---|---|
| `structural` | the schema catalogue (three `sqlite_master` reads) and the durability pragmas | **every construction of the facade** — cheap enough to afford there |
| `full` | everything structural, plus `PRAGMA integrity_check`, `PRAGMA foreign_key_check` and a whole-log evidence-chain verification | only `assessHqIntegrity`, a Founder act — these are O(database) and O(log) |

The depth is carried ON the verdict and on the published snapshot, so a cheap
pass can never be mistaken for a full one.

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
never written, and no `-wal`/`-shm` is created beside it. Thirteen categorical
refusals, never an exception: `path_not_absolute`, `path_not_normalized`,
`path_missing`, `path_is_symlink`, `path_not_a_regular_file`,
`path_not_readable`, `file_empty`, `file_too_large`,
`sidecar_journal_present`, `verification_copy_failed`,
`not_a_readable_sqlite_database`, `integrity_check_failed`,
`not_an_hq_database`. Ten of the thirteen are exercised against real files on
disk — a relative path, an unnormalized absolute one, a missing one, a
directory, an empty file, a symlink, a file of prose, a corrupted SQLite image,
a valid SQLite database that is simply somebody else's, and a genuine backup
with a `-wal` dropped beside it (twice over: as a dropped sidecar, and as a
live un-checkpointed WAL database whose newest table exists only in the
sidecar). `file_too_large` is NOT exercised: it would mean writing a
two-gigabyte file in a test, and a bound asserted by reading the constant
rather than by crossing it is stated here as what it is. `path_not_readable`
and `verification_copy_failed` are likewise not exercised — both need a
filesystem HQ cannot read or write, which a test that must pass on any
developer's machine cannot arrange honestly.

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
> through is not a snapshot. A plain `cp` of a live WAL database, however, still
> verifies and always will — it is a different inode with no sidecars and its
> bytes are a sound HQ database, just one that may be missing whatever the WAL
> had not checkpointed, and nothing in the bytes distinguishes it from a
> properly consolidated backup. `verified` means "these bytes are a sound HQ
> database" and has never meant "this is the whole of what was committed when
> they were copied". `MAX_VERIFIED_BACKUP_BYTES` now bounds the READ rather than only the
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
| the RECORDED verdict a construction re-reads | `latestIntegrityVerdict(db)` — a direct read of the append-only `hq_reliability_verdicts` ledger | whether a blocking verdict survives a restart | canonical. The ledger carries the full append-only trio; a raw connection can APPEND a `safe_mode = 1` row (the fail-closed direction) and can neither rewrite nor erase one. |
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
  no longer clears a verdict, and ten of the thirteen backup path protections
  are all exercised against a real database in a real temporary directory. The
  three that are not (`file_too_large`, `path_not_readable`,
  `verification_copy_failed`) are named in "Backup and restore" with the reason,
  rather than counted as if they were.
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
- **The structural check cannot see everything.** It reads the schema catalogue
  and the pragmas; a corrupt page, a broken chain and a referential violation
  are only found by the full assessment.
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
  `hq_reliability_verdicts` guards did not exist in it. The census skips a table
  that is ABSENT (so the verdict ledger produces nothing), but
  `hq_mission_plan_items` EXISTS on such a file without its new guard, and the
  as-found observation is taken before the schema ensures — by design, because
  HQ cannot know what was written while a guard was gone. The finding is
  therefore true rather than spurious, and it is cleared by one Founder full
  assessment, which finds the re-created guard standing. A file created by this
  code is unaffected. Stated here rather than discovered in operation.
- **The safe-mode latch reads the evidence chain from private truth.** Both
  correction lanes found this too (one as Critical 1, one as High 1).
  `assessHqIntegrity` used to pass `() => this.queue.evidence.verifyChain()`
  into `fullIntegrity`. `queue.evidence` is a public own-property object the
  queue documents as safe to patch "because enforcement never dispatches
  through it" — a premise that call made false. `evidence_chain_broken` is one
  of only three blocking findings and this assessment is the only path that
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
  one pass, so the digest pins what was checked BY CONSTRUCTION and the
  candidate's path is never resolved a second time. Lane A's held-descriptor
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
the honest residual disclosure now stated on `latestIntegrityVerdict`.

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
| **HIGH A1** — a DROPPED ledger read as a clean store | `DROP TABLE` is DDL: no BEFORE trigger refuses it, and the guard census SKIPPED a declared table that was absent. Dropping `hq_action_intents`, `hq_action_events`, `hq_truth_records`, `hq_truth_verifications`, `hq_truth_acceptances`, `hq_memory` and `hq_intel_budgets` produced a structural pass AND a full assessment with ZERO observations, while the facade's ensures recreated each one EMPTY. Dropping `hq_reliability_verdicts` erased a latched safe mode outright and `releaseKillSwitch` was admitted with the evidence chain still broken. | The absence is OBSERVED as found, before any ensure runs, and is a finding when HQ's own schema then re-creates the ledger. `establishedImmutableTables` discriminates a first construction — where every phase's ledger is legitimately absent — from a file that has lost one. **Corrected in the fourth round (High 1):** that discriminator on its own was bypassed by doing MORE damage — dropping ALL the declared ledgers emptied the set, read as a first boot and silenced the census entirely while the operational half of the database survived. The discriminator now also reads a mark HQ stamps into `PRAGMA user_version` after its ensure pass, which lives in the database header where no `DROP TABLE` reaches it. A content check over the tables was tried and rejected: HQ's own components legitimately write rows to a fresh file BEFORE the facade is constructed over it, so "this file has rows" cannot tell a first boot from an operated file. |
| **HIGH A2** — the hash chain did not detect DELETION | `op_evidence` carried no append-only triggers at all, so a raw `DELETE` was permitted; and the verifier walked forward from the genesis value with no commitment to where the chain should END, so deleting the NEWEST entries left a chain that verified perfectly. `DROP TABLE op_evidence` and `DELETE FROM op_evidence WHERE seq > 1` both read CLEAN at full depth. | Three independent holds: the engine refuses UPDATE/DELETE/REPLACE; `op_evidence` is a declared engine-immutable ledger, so removing those guards is a blocking finding; and the verification compares the entries present against the AUTOINCREMENT high-water mark, which a DELETE does not lower. The module header's "deletion breaks the chain" and "the only blocking finding that detects tampering with HQ's own audit record" are corrected rather than restated. **Corrected again in the fourth round (High 2):** the high-water half alone did not survive the next append, so the header's unqualified "commits to its own LENGTH" was false at that head; the verification now requires seq contiguity as well. |
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
upgrade would be a worse failure than the one being closed.

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
  documented remedy then certifying the robbed log; contiguity is the property no
  later write repairs. **The fifth round corrects the sentence the fourth round
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
  nothing. **What is still NOT detected, with every barrier in the sentence
  personally tried:** a writer that rewrites the log coherently AND drops
  `hq_integrity_checkpoints` as well. Executed end to end, this is exactly what
  it costs and no more. The drop IS reported — the ledger is a declared
  `ENGINE_IMMUTABLE_TABLES` member carrying the engine's own trio, so the boot
  that observes it engages safe mode, that process's full assessment still
  reports it, and `releaseKillSwitch` is refused. Then: restart, and a SECOND
  Founder full assessment in the new process clears it, because HQ has by then
  re-created the ledger empty and no commitment survives to measure against.
  Measured: `p2 boot=true assess=true release=refused`, `p3 boot=true
  assess=false release=ADMITTED`. So the honest cost of the surviving attack is
  one extra `DROP TABLE`, one restart and one further Founder act — more
  deliberate acts across more guarded ledgers than the attack needed before, and
  a cost rather than a boundary. HQ holds no key a foreign writer does not also
  have, and nothing here pretends the commitment is one.

  The other escape is the one already disclosed for the header mark, and the
  checkpoint ledger does not change it: a writer that drops every declared
  ledger AND zeroes `PRAGMA user_version` leaves a file that reads as a first
  boot, so the census — and every commitment, which went with the ledger —
  reports nothing at all. Executed: `boot=false [] release=ADMITTED` on the
  first process afterwards.
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
  release=refused`, then `p3 boot=true assess=false release=ADMITTED`. Dropping
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
  reason.** `hq_integrity_checkpoints` is a newly declared engine-immutable
  ledger, so a file no writer of this build has opened does not carry it and the
  as-found census says so once. Cleared by one Founder full assessment, and the
  same fail-closed direction as the two above. The `PRAGMA user_version` mark
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
  the English `TOKEN: ********` already is. No Cyrillic word can reach any of
  those keywords by folding, which is a property of which letters the map
  deliberately omits.
- A credential split across two search fields still passes both scans.
- A `cp` of a live WAL-mode database still verifies as a backup, and always
  will: it is a different inode with no sidecars beside it and its bytes are a
  sound, integrity-clean HQ database — just one that may be missing whatever the
  WAL had not checkpointed. Nothing in the bytes distinguishes it from a properly
  consolidated backup. `verified` means "these bytes are a sound HQ database" and
  has never meant "this is the whole of what was committed when it was taken".
  A hard LINK to the live database is refused now (`file_has_multiple_links`);
  a copy of it is not, and cannot be.
- A forged decision row can still understate complexity, context size and work
  kind.
- A raw appender can still widen a budget by appending a higher-version row.
- The independence check in `reconcileRun` is unreachable through the worker
  path (kept as defence in depth), `listRuns` derives every record per call, a
  run cannot be corrected in place, and nothing here has been exercised by a real
  AI worker lane.
