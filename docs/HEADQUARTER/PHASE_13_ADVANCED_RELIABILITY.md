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

**It has exactly one other trigger, and it is not a finding** (Wave 5 review,
correction cycle 2): an evidence-chain posture of `not_verified`. A finding is a
claim about the file, and "I did not look" is not one. It is carried as its own
closed three-member vocabulary — `verified` / `broken` / `not_verified` — on the
verdict, on `hqReliabilityPosture`, in the `safe_mode_engaged` refusal detail
and on the unauthenticated snapshot, and `not_verified` engages safe mode
exactly as a break does. That is the fail-closed rule: HQ never hands out the
acts that add to, approve, release or execute against a record whose own audit
chain it has not checked, and a reader is never told HQ is well about something
HQ has not looked at.

### What it refuses, and what it deliberately does not

| Refused | Kept available |
|---|---|
| every Founder-gated command write (mission, project, memory, truth, orchestrate, collaboration, brief, product) | every READ — a Founder who cannot see the store cannot fix it |
| `approveTask` — an approval bound now would sit primed to run the moment safe mode clears | `denyTask` — the fail-safe direction |
| `releaseKillSwitch` | `engageKillSwitch` — the fail-safe direction |
| `claimNext` — refused as `safe_mode_engaged`, distinctly from `nothing_claimable` | `recoverInterruptedRuns` and `reconcileRun` — the acts that resolve the state |
| `executeAction` — refused BEFORE the reservation, so no side-effect key is burned | `assessHqIntegrity` and `recordVerifiedBackup` — the acts that investigate and clear it |
| `openRun` / `startRunAttempt` / `recordRunOutcome` | |

The asymmetry is the point: safe mode never removes a way to STOP something and
never removes a way to find out what is wrong.

### When it is assessed, and the cost of each

| Depth | What runs | When |
|---|---|---|
| `structural` | the schema catalogue (three `sqlite_master` reads), the durability pragmas, and the whole-log evidence-chain verification | **every construction of the facade** |
| `full` | everything structural, plus `PRAGMA integrity_check` and `PRAGMA foreign_key_check` | only `assessHqIntegrity`, a Founder act — these are O(database) |

The depth is carried ON the verdict and on the published snapshot, so a cheap
pass can never be mistaken for a full one. The chain posture is carried
SEPARATELY, so neither can be inferred from the other.

> **Correction (Wave 5 review, correction cycle 2, HIGH).** That table used to
> put the chain verification under `full` only, and the consequence was that a
> **plain restart cleared an `evidence_chain_broken` safe mode**. The first
> correction closed the PATCH route to defeating the verdict; it did not close
> the RESTART route, which needs no patch and no privilege — just process exit.
> The constructor latched `structuralIntegrity`, which never looked at the
> chain; only `assessHqIntegrity` did; the latch was never persisted anywhere;
> and every HQ entrypoint (`hq:order`, `hq:snapshot`, `hq:workforce`,
> `hq:dispatch-claude`, `hq:ingest-claude`) is a fresh process. Break the chain
> by a legal raw append, assess, watch `claimNext` and `releaseKillSwitch`
> refuse — then construct a new facade with no assessment and both were ALLOWED,
> with the unauthenticated snapshot publishing `safeMode: false` about it. That
> last part is the exact failure the snapshot section of this document names as
> the one it exists to prevent.
>
> **Fixed by verifying the chain at every construction.** Nothing is carried
> across the boot, and that is the design rather than an omission: a persisted
> latch would live in the same file the tamper is in and could be edited by the
> same access that broke the chain, so the verdict is re-DERIVED from the bytes
> instead. A new process re-finds the break because the break is still there.
> Two alternatives were weighed and rejected — persisting the latch, for the
> reason just given; and failing closed on the mere absence of a full assessment,
> which alone would refuse every act on every boot and is an outage rather than
> a safety posture. The fail-closed rule is kept for the case it fits, which is
> the `not_verified` posture above.
>
> **The cost is measured, not assumed:** ~9µs per evidence entry on this
> repository's own hardware — ~2ms at 200 entries, ~15ms at 2,000, ~170ms at
> 20,000, against a CLI process start that already costs more than that in
> TypeScript transform alone. It is linear and unbounded, and that is recorded
> in the debt section rather than capped: a cap would mean publishing
> `safeMode: false` about an unexamined tail, which is the lie this change
> removes. Pinned by `reliability-safe-mode-restart.test.ts` (12 tests),
> including the reviewer's probe verbatim, every enforcement point on the
> restarted facade, the snapshot a stranger receives, the healthy control, and
> the hostile patch re-proved at the new boot call site.

**The boot-time observation is taken BEFORE the schema ensures, and that is
load-bearing.** Every `ensure*Schema` is `CREATE TRIGGER IF NOT EXISTS`, so a
construction RESTORES a dropped guard. A check run after them would find a
healthy file and report one — HQ would silently repair a tamper and say nothing
about it. So the missing-guard list is observed as the file was FOUND and
passed into the check. HQ can re-create the guards it declares; it cannot know
what was written while they were absent, and safe mode is exactly the posture
for that.

> **Correction (Wave 5 review, correction cycle 2, LOW 1).** This paragraph used
> to end "Clearing therefore takes an explicit assessment of the file as it now
> stands, not a restart." **That was false, and the doc is corrected rather than
> the behaviour, deliberately.** The construction that FINDS the guards missing
> also repairs them, so the next construction finds a healthy file and reports
> one: a restart clears a guard-tamper posture, and so does a single Founder
> assessment — which proves only that HQ repaired itself, not that nothing was
> written while the guards were gone.
>
> The behaviour is kept because making the posture durable would require storing
> the latch in the same file the tamper is in, where the same raw access that
> dropped the trigger can also edit or append past the latch. An in-file latch
> against an adversary who can write the file is theatre, and this phase does not
> build theatre. A chain break needs none of it: it is re-derived from the bytes
> at every construction, which is why that half genuinely does survive a restart.
>
> What IS added is the durable RECORD. `assessHqIntegrity` now carries the
> construction-time observation into the append-only evidence log —
> `guardsMissingAtConstruction` (a count) and
> `guardsMissingAtConstructionNames` (schema object names, never row content) —
> so the Founder act that clears the posture also writes down what the boot saw.
> HQ still writes NOTHING at construction; that property is unchanged and
> re-pinned. The residual limit is stated in the debt section.

**Nothing clears it by assertion.** There is no override parameter, no force
flag and no acknowledge, and a source scan pins that no such method name
exists. The verdict is a `#private` latched field; a hostile patch of
`hqReliabilityPosture` and `reliabilitySummary` is proven to have taken on the
instance, on the prototype, and on a facade constructed AFTER the patch — and
to buy no claim on either facade.

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

`verifyHqBackupFile` is read-only in the strongest available sense — the file
is opened `O_NOFOLLOW` to digest and through `openHqDatabaseReadOnly` (SQLite
itself refuses writes, and a missing file is an error rather than a new empty
database) to check. Nine categorical refusals, never an exception:
`path_not_absolute`, `path_missing`, `path_is_symlink`,
`path_not_a_regular_file`, `file_empty`, `file_too_large`,
`not_a_readable_sqlite_database`, `integrity_check_failed`,
`not_an_hq_database`. Eight of the nine are exercised against real files on
disk — a relative path, a missing one, a directory, an empty file, a symlink,
a file of prose, a corrupted SQLite image and a perfectly valid SQLite
database that is simply somebody else's. `file_too_large` is NOT exercised: it
would mean writing a two-gigabyte file in a test, and a bound that is asserted
by reading the constant rather than by crossing it is stated here as what it
is.

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
run recorded before the backup is read back out of the restored copy.

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
| the SAFE-MODE verdict | the `#private` `#integrityReport` field | whether a Founder-gated write, an approval, a kill-switch release, a claim or an external execution proceeds | canonical. Pinned against a patch of `hqReliabilityPosture` and `reliabilitySummary` on instance, prototype, and a later-constructed facade. |
| the EVIDENCE-CHAIN verification that PRODUCES that verdict | `#verifyEvidenceChainFromStore` — a `#private` closure over `#db` and the module-level `verifyEvidenceChain`, deliberately NOT `queue.evidence.verifyChain()` | whether `evidence_chain_broken` engages safe mode, and whether an already-latched safe mode survives the next assessment | canonical **since the Wave 5 correction**; it previously read the patchable delegate. Pinned against a patch on the instance and on `EvidenceLog.prototype`, and against a facade constructed after it. |
| the APPEND-ONLY GUARD census that produces the other schema finding | `missingImmutabilityGuards(db)` over `ENGINE_IMMUTABLE_TABLES`, observed as the file was FOUND | whether `append_only_guard_missing` engages safe mode | canonical, and **widened by the Wave 5 correction** to the secondary-unique guards and `hq_memory`'s supersede rule, which it previously could not see. |
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

**Which of those `unrecognized` buckets is actually REACHABLE from a stored row
is asymmetric, and the asymmetry is recorded rather than smoothed over.**
`byKind`, `byState` and `byOutcome` are genuinely reachable — the ledgers are
append-only, an append is a permitted write, and a raw connection can land a row
carrying free text in any of the three. The `findings` map is not: every finding
name reaching the fold comes from HQ's own closed observation vocabulary, so the
membership re-check there catches only a caller passing a raw fact directly. The
bucket is KEPT anyway, because the key set is a published shape guarantee and
the fold must stay closed by construction independently of who calls it — the
same decision Wave 4 left open for `byLifecycle.unrecognized` in the Product
Factory snapshot and Phase 14 records for `byCostProvenance.unrecognized`. This
document and `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md` now state it in the
same terms; `PHASE_12_PRODUCT_FACTORY.md` still names `byLifecycle` as a
published key without recording the reachability decision, and that remains
open rather than being quietly claimed as closed.

> **Correction (Wave 5 review, correction cycle 2, LOW 2).** The first
> correction's commit message and the Phase 14 document both said the Wave 4
> `byLifecycle.unrecognized` decision had been left untouched "and both docs say
> so". Only the Phase 14 document recorded it; this one contained zero
> occurrences of `byLifecycle`. A pushed commit message cannot be amended, so
> the claim is made true here instead — the paragraph above is that record — and
> the Phase 14 document is corrected to say exactly which documents carry it.

`safeMode` DOES cross, and that is the deliberate exception. A reader told
everything is fine while HQ has said otherwise about itself has been lied to,
and that is the one thing this phase exists to prevent. The finding CATEGORY
crosses; the detail — which names schema objects — does not. Since correction
cycle 2 the same rule extends to `evidenceChain`: a reader is told what happened
to HQ's audit chain in the process that produced the file, in three closed
words, so `safeMode: false` can never again stand in for "the chain was never
looked at".

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
| `hq_reliability_backups` — INSERT-only verified recovery points | the integrity verdict and the safe-mode posture |
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
  unique-index paths on all three tables), the tamper that engages safe mode,
  the evidence-chain break, and every backup path protection are all exercised
  against a real database in a real temporary directory.
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
  corruption that appears while HQ is running is not caught at the moment it
  happens. Precisely, since correction cycle 2: a **broken evidence chain** and
  a **missing append-only guard** are caught at the next CONSTRUCTION, because
  both are re-derived from the file; a **corrupt page** and a **referential
  violation** are found only by an explicit `assessHqIntegrity`, because those
  two are the O(database) checks a boot does not pay for. The earlier wording
  said "caught at the next boot or the next explicit assessment" without that
  split, and a broken chain was in fact caught at NEITHER a boot nor anything
  short of a Founder act — that is the HIGH this cycle fixed.
- **The construction-time chain verification is O(log) and unbounded.**
  Measured at ~9µs per evidence entry (~2ms at 200 entries, ~15ms at 2,000,
  ~170ms at 20,000), paid by every HQ process including every CLI command. It
  is deliberately NOT capped: verifying a prefix and publishing `safeMode:
  false` about the unexamined tail would be the same lie in a smaller costume.
  If a deployment's log ever grows past the point where this is comfortable,
  the answer is a rotated/anchored log design, not a partial check — and that
  is a real future phase, not something to bolt on here.
- **A missing append-only guard is detected, and the tamper window is not
  bounded.** HQ reports that a guard was absent when the file was found; it
  cannot say for how long, or what was written meanwhile. That is why the
  posture is "stop and investigate" rather than "here is the damage".
- **The guard-tamper posture is per-PROCESS, and a restart or a single
  assessment clears it** (correction cycle 2, LOW 1 — see the correction under
  "When it is assessed"). The construction repairs the file, so no later
  construction can re-find the tamper. Making it durable would mean latching in
  the same file the tamper is in, which the same raw access can edit. The
  durable artefact is instead the evidence entry a Founder assessment writes,
  carrying `guardsMissingAtConstruction`. **What remains open:** a process that
  boots onto a tampered file and exits WITHOUT a Founder assessment leaves no
  record of the tamper at all, because HQ writes nothing at construction.
- **Which guards the census can see, and at which schema vintage.** The census
  originally checked the trio only; the Wave 5 review's Medium 2 widened it to
  each table's `secondaryGuards`, which was right. Doing so with no
  schema-vintage awareness was not, and correction cycle 2 repaired that
  regression: a database written by an OLDER version of this repository's own
  code legitimately has a table and lacks a guard that version never created,
  and the widened census called that `append_only_guard_missing` and engaged
  safe mode on a healthy record — an outage on the first writable boot after an
  upgrade, and a PERMANENT false `safeMode: true` on the read-only `hq:snapshot`
  path, where the ensures return early and nothing ever repairs anything. A
  guard is now required only when the file carries a schema object the code
  declaring that guard also created (`laterThanTable`), read from the file
  rather than from a stored version marker — a marker lives in the same file the
  tamper is in. `git log -S` over all 28 listed tables and all 19 secondary
  guards found exactly four mismatched groups, all on `hq_memory` and the two
  `hq_mission_*` ledgers; every other guard arrived with its table and is
  unconditionally required. **What remains open:** (a) for the two `hq_mission_*`
  groups the witness is rounded UP to the next schema object in ancestry order,
  because neither correcting commit added a table or a column — so on a file
  written between Phase 3 and Phase 4 those six guards are not demanded even
  though that version may have had them; rounding up can only under-require,
  never produce a false finding. (b) Dropping a witness OBJECT would excuse its
  guards — but a witness is a table or a column HQ's own code needs, so that is
  a far larger and far more visible act than dropping a trigger, and it is the
  same trade the "only tables that are PRESENT are checked" rule has always
  made. (c) A typo'd witness would silently excuse a guard forever; a test pins
  every declared witness against the LIVE schema so it cannot happen quietly.
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

## Wave 5 correction pass 2 (this branch, on top of `9782b45`)

A SECOND, different fresh read-only hostile reviewer read the corrected head and
returned CHANGES REQUIRED — 0 Critical / 1 High / 1 Medium / 3 Low. Both of the
blocking findings are Phase 13's, and one of them is a regression the FIRST
correction introduced. Both are corrected in place above, in the sections they
belong to.

| Finding | Where it is now recorded | Pinned by |
|---|---|---|
| HIGH — a plain restart cleared an `evidence_chain_broken` safe mode | "Safe mode → When it is assessed, and the cost of each", and the new `not_verified` posture under "Safe mode" | new `test/reliability-safe-mode-restart.test.ts` (12 tests) |
| MEDIUM — the widened census raised a FALSE finding on a legitimate older database | "Known limitations → Which guards the census can see, and at which schema vintage" | new `test/reliability-guard-vintage.test.ts` (11 tests) |
| LOW 1 — the guard-tamper posture is cleared by a restart or one assessment | the correction under "The boot-time observation is taken BEFORE the schema ensures", and the debt bullet; the DOC is corrected and the behaviour is kept, with the reason | one test in `reliability-safe-mode-restart.test.ts` for the durable record, plus the statement-truth tests |
| LOW 2 — "both docs say so" about `byLifecycle.unrecognized` was false | the snapshot-fold section above now records the reachability policy, so the claim is made true rather than merely corrected | no test — it is a documentation fact, stated as such |
| LOW 3 — undisclosed scope of the facade credential scan | `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md`, "The `assertBrowserSafe` pre-real-adapter Low" | three tests across `live-redaction.test.ts` and `search-adapter-guard.test.ts` |

**The one published-shape change.** `reliability` gains a thirteenth key,
`evidenceChain`, a closed three-member vocabulary carrying no text. The key-set
pin in `reliability-surfaces.test.ts` was WIDENED, not relaxed: nothing was
removed, and the addition is what stops `safeMode: false` from standing in for
"the chain was never looked at". No `HQ_SNAPSHOT_VERSION` bump, for the same
reason Phase 14 did not bump when it added a whole section: the change is purely
additive and every consumer is in this repository.

**The snapshot's by-shape safety, re-proved rather than assumed.** A scratch
probe outside the repository seeded 112 distinct markers into every TEXT column
of `hq_reliability_runs`, `hq_reliability_run_events`, `hq_reliability_backups`,
all five `hq_intel_*` ledgers, `op_evidence` and `hq_events`, through legal raw
appends, then serialized the snapshot: **0 markers reached the `reliability` or
`intelligence` sections.** Six reached the `activity` section, which is the
canonical `hq_events` feed and a deliberately published surface — not part of
the by-shape guarantee. The same probe, run from a FRESH process over the
tampered file, published `safeMode: true, evidenceChain: broken`, which is the
HIGH proved end to end through the real snapshot path.

**Verification after correction pass 2** (the whole battery, not a subset):

| Command | Result |
|---|---|
| `npm run test:hq` | 164 files, 3073 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root) | 37 files, 569 passed + 3 pre-existing skips |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages, `hq-snapshot.json` written |
| `npm run build` | clean, initial JS 215.66 kB / 69.22 kB gzip |

Baseline at `9782b45` was 162 files / 3045 tests; this pass adds 28. **Nothing
was deleted, skipped, weakened, narrowed or relaxed.** Five existing test files
were touched and every change is additive or a required-argument update:
`reliability-durability.test.ts` and `reliability-core.test.ts` now pass the
chain verification that `structuralIntegrity` / `fullIntegrity` / the snapshot
fold REQUIRE — a strengthening, because those assertions now cover the chain
too; `reliability-surfaces.test.ts` widened the key-set pin by one; and
`live-redaction.test.ts` and `search-adapter-guard.test.ts` gained cases. The
three pre-existing `it.skip` GAP markers under `packages/server` are untouched,
and nothing under `packages/server`, `packages/web`, `packages/shared` or
`packages/config-mesob` was changed. No new dependency.
