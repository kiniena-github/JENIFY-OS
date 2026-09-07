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
| `processId` | **The fact the phase turns on.** Which process was carrying the work. A restart is a different one; that is how "interrupted" is told from "still running", without a timer and without a guess. |
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
| `claimNext` — refused as `safe_mode_engaged`, distinctly from `nothing_claimable` | `recoverInterruptedRuns` and `reconcileRun` — the acts that resolve the state |
| `executeAction` — refused BEFORE the reservation, so no side-effect key is burned | `assessHqIntegrity` and `recordVerifiedBackup` — the acts that investigate and clear it |
| `openRun` / `startRunAttempt` / `recordRunOutcome` | |
| `recordIntelligenceDecision`, `escalateIntelligenceDecision`, `recordIntelligenceOutcome`, `recordIntelligenceCost`, `recordModelObservation`, `setIntelligenceBudget` (Phase 14) | |

The asymmetry is the point: safe mode never removes a way to STOP something and
never removes a way to find out what is wrong.

**The mutators deliberately left AVAILABLE, each with its reason** (Wave 5
review, Medium finding 7 — `authorizeAction` was in neither column, and neither
was anything else in this list, so "what safe mode refuses" was a partial
statement presented as a complete one):

| Left available | Why |
|---|---|
| `createTask` | a queued task is a request that cannot execute: claiming it is refused, so nothing it carries can happen while safe mode stands. Refusing creation would stop a Founder recording the very work that fixes the store. |
| `assignTask` | assignment narrows who MAY claim; the claim itself is refused. It removes an option, it never adds one. |
| `startTask`, `submitResult` | both belong to work already claimed and already running. Refusing them would strand a live execution with nowhere to report, which loses truth rather than protecting it. |
| `reviewTask` | a `pass` verdict completes a task and is the closest of these to an approval, but the task it completes was claimed and executed BEFORE safe mode engaged. Refusing the verdict does not un-execute it; it only leaves HQ unable to record what happened. **Stated as the argued judgement it is, not as an obvious one.** |
| `proposeAction` | a proposal reaches nothing and authorizes nothing; `authorizeAction` and `executeAction` are both refused, so it cannot become an act. |
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
with a `-wal` dropped beside it. `file_too_large` is NOT exercised: it would
mean writing a two-gigabyte file in a test, and a bound asserted by reading the
constant rather than by crossing it is stated here as what it is.
`path_not_readable` and `verification_copy_failed` are likewise not exercised —
both need a filesystem HQ cannot read or write, which a test that must pass on
any developer's machine cannot arrange honestly.

> **Correction (Wave 5 review, HIGH finding 3).** The digest and the checks
> were statements about DIFFERENT byte sets, and the gap was exploitable.
> `digestFile` hashed the main file through a descriptor while
> `integrity_check`, the schema census and the `hq_events` marker were evaluated
> by a SECOND open of the PATH — and SQLite resolves a path together with its
> `-wal`/`-shm`. A plain `cp` of a live WAL-mode HQ database therefore verified
> `true`, with 45 tables read out of a sidecar the digest never covered, a
> `sizeBytes` counting the main file only, and the pristine file's digest
> recorded permanently in an append-only register. `backupRecordKey` is
> `hash(path, digest)`, so two materially different backups collapsed onto one
> record. The same block was TOCTOU besides: `lstat` → `openSync(O_NOFOLLOW)` →
> open-by-path, where only the first two constrained the final component, which
> made `path_is_symlink` advisory for exactly the half that decided `verified`.
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
> leftovers on the second call.
>
> A sidecar beside the candidate is still refused rather than checked around,
> because the main file alone may then not be the database an operator would
> restore. Pointing this at the LIVE HQ database is consequently refused — a
> live HQ database is WAL-mode — which is a more honest answer than the "safe as
> well as useless" pass it used to give. `MAX_VERIFIED_BACKUP_BYTES` now bounds
> the READ rather than only the pre-open `lstat`, and the `openSync` failure
> that used to collapse every cause into `path_not_a_regular_file` is
> distinguished (LOW 12).
>
> **Not covered, and recorded rather than implied:** a path whose PARENT
> directories are symlinks is accepted. `O_NOFOLLOW` constrains the final
> component only, and `realpath` would refuse legitimate layouts (a symlinked
> backup volume). Which file an operator may point at is a separate question
> this function does not answer.

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
| the EVIDENCE-CHAIN verification that PRODUCES that verdict | `#verifyEvidenceChainFromStore` — a `#private` closure over `#db` and the module-level `verifyEvidenceChain`, deliberately NOT `queue.evidence.verifyChain()` | whether `evidence_chain_broken` engages safe mode, and whether an already-latched safe mode survives the next assessment | canonical **since the Wave 5 correction**; it previously read the patchable delegate. Pinned against a patch on the instance and on `EvidenceLog.prototype`, and against a facade constructed after it. |
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
- **Which guards the census can see** — corrected by the Wave 5 review (Medium
  finding 2). It originally checked the trio only, on the reasoning that a
  table's further guards were "that module's business" and that re-stating them
  would drift. The consequence was that it could not report a dropped
  `trg_hq_intel_budgets_no_replace_unique` at all. `ENGINE_IMMUTABLE_TABLES`
  now declares each table's `secondaryGuards` and the census reads both, so a
  dropped secondary guard produces a real `append_only_guard_missing` finding
  and engages safe mode. The drift concern is answered where it belongs: a test
  pins the whole declaration against the LIVE schema, so a phase that adds a
  guard and forgets to declare it fails there.
  **Corrected again (Wave 5, Medium finding 6):** that test iterated the
  DECLARATION, so it could not see a guard on a table nobody had listed — and
  three were exactly that. `hq_mission_plan_items` is not append-only as a
  table (supersede and link legitimately UPDATE it) and so does not carry the
  trio, which was taken as a reason to leave it out of the list altogether; the
  consequence was that its `_no_replace` / `_no_relink` / `_no_respec` guards
  were invisible to the census, and dropping `_no_replace` let an
  `INSERT OR REPLACE` rewrite a plan item's task binding with no finding at
  all. It is listed now with `holdsUniversalTrio: false`, and the test asserts
  the LIVE trigger set EQUALS the union of the declarations, so a new guarded
  table is a test failure rather than a silent gap.
- **The run-key identity no longer includes the caller's label** (Wave 5,
  Medium finding 4). `runIdempotencyKey` digested the free-text `label`, so
  re-opening the same work under a different wording produced a different key, a
  second run beside the first, and an attempt admitted on it — while the first
  run stood at `needs_reconciliation` with an unknown outcome. That is the
  duplicate irreversible act the phase exists to prevent, reachable by
  renaming. The label is display text and is out of the digest; and `openRun`
  now refuses outright, as `run_state_conflict`, against a task that already
  carries an unreconciled run.
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

A separate fresh read-only hostile reviewer returned CHANGES REQUIRED —
0 Critical / 1 High / 1 Medium / 6 Low — against the frozen wave head. The two
findings that touch Phase 13 are corrected in place above, in the sections they
belong to rather than in a footnote:

| Finding | Where it is now recorded |
|---|---|
| HIGH 1 — the safe-mode evidence verdict came through a patchable delegate | "Safe mode → Nothing clears it by assertion", plus two new rows in the enforcement-safe read audit |
| MEDIUM 2 — the secondary append-only guards were unpinned and invisible to the census | "Known limitations → Which guards the census can see", plus the census row in the audit |
| LOW 8 — the corrupted-backup refusal was not pinned by name | "Backup and restore" |

**Verification after the correction pass** (the whole suite, not a subset):

| Command | Result |
|---|---|
| `npm run test:hq` | 162 files, 3045 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |

Baseline at `c9ddecc` was 161 files / 3026 tests. Nothing was deleted, skipped,
weakened or narrowed; the three pre-existing `it.skip` GAP markers under
`packages/server` are untouched, and nothing under `packages/server`,
`packages/web`, `packages/shared` or `packages/config-mesob` was changed.

---

## Wave 5 SECOND correction pass (this branch, on top of `9782b45`)

Three further fresh read-only hostile reviewers, none of whom authored the head
they reviewed, returned 0 Critical / 5 High / 7 Medium / 13 Low across both
phases. Every High was reproduced by execution rather than inferred. The
findings that touch Phase 13 are corrected in place above, in the sections they
belong to:

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

**Known debt this pass records rather than closes:**

- a path whose PARENT directories are symlinks is still accepted by
  `verifyHqBackupFile`; the final component is `O_NOFOLLOW` and the inode the
  digest covers is the inode that is checked, but WHICH file an operator may
  point at is not a question this function answers;
- `file_too_large`, `path_not_readable` and `verification_copy_failed` are
  asserted by construction rather than by being crossed;
- the verdict ledger is durable only where it exists: a database written before
  this correction, or a read-only handle over one, carries no
  `hq_reliability_verdicts` table, and the verdict is process-local there.
  `SAFE_MODE_STATEMENT` says so rather than glossing it.

