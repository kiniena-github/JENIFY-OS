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
| `releaseKillSwitch` | `engageKillSwitch` — the fail-safe direction |
| `claimNext` — refused as `safe_mode_engaged`, distinctly from `nothing_claimable` | `recoverInterruptedRuns` and `reconcileRun` — the acts that resolve the state |
| `executeAction` — refused BEFORE the reservation, so no side-effect key is burned | `assessHqIntegrity` and `recordVerifiedBackup` — the acts that investigate and clear it |
| `openRun` / `startRunAttempt` / `recordRunOutcome` | |

The asymmetry is the point: safe mode never removes a way to STOP something and
never removes a way to find out what is wrong.

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

> **Correction (Wave 5 second correction round, HIGH 2).** `SAFE_MODE_STATEMENT`
> — which crosses to the Founder browser and into the unauthenticated
> `hq-snapshot.json` — says safe mode "is never cleared by a boot: only a fresh
> assessment that finds nothing blocking clears it". Until this round it was,
> and the mechanism made it inevitable: `#integrityReport` was an in-memory
> field recomputed at every construction from `structuralIntegrity`, which by
> design never runs the evidence-chain verification.
>
> Executed: after a full assessment engaged `evidence_chain_broken`,
> `claimNext` was refused; after a RESTART, `safeMode` was false, the depth was
> `structural`, `claimNext` was ALLOWED, `verifyEvidenceChain` still reported
> the break at seq 1, and the world-readable snapshot published
> `safeMode: false` over a genuinely broken chain. An
> `append_only_guard_missing` engagement survived exactly one boot, because the
> next `ensure*Schema` re-created the trigger and the as-found census then saw a
> healthy file. The mechanism predates this wave; this wave made it load-bearing
> (High 5 relies on "latched at construction") and re-published the claim.
>
> **Fixed** by writing the engagement down. `hq_safe_mode_latch` is an
> INSERT-only table in the Phase 13 schema, carrying the full trio of engine
> guards and declared in `ENGINE_IMMUTABLE_TABLES` so the census reports a
> dropped guard on it — because an UPDATE or DELETE there would be a way to
> clear safe mode without an assessment. The constructor appends an engagement
> when a blocking finding stands and none is latched, then overlays the standing
> latch onto the fresh report: **a boot can only ADD an engagement, never
> subtract one.** `assessHqIntegrity` is the only path that may append a CLEAR,
> and only because a FULL assessment found nothing blocking; there is still no
> override, force flag or acknowledgement.
>
> **What the latch does NOT protect against, stated rather than glossed.** The
> standing verdict is the LAST row, and an APPEND is the write the table's
> triggers deliberately permit. A writer that already holds a writable handle on
> the file can therefore append `engaged = 0` and clear safe mode at the next
> construction — exactly as it could append a forged event into any other ledger
> here, and exactly the class of residual this document already records for
> `hq_reliability_run_events`. The guards close the other doors (no UPDATE of a
> standing row, no DELETE of the history, no REPLACE onto an existing id) and
> the census reports them if they go missing. Against a writer with the file
> open this is bookkeeping, not a boundary; what it closes is the thing it was
> built for — a RESTART silently lowering a verdict HQ had already reached.
>
> Two details that are deliberately narrow. The reported `depth` remains the
> depth of the CURRENT assessment — a structural boot must not present itself as
> a full pass — and the latched depth is stated in the carried observation's
> detail instead. And a READ-ONLY handle (the `hq:snapshot` CLI) writes nothing:
> it reports the latch it finds, which is the honest answer for a handle that
> promised not to write, and it means a read-only process observing a blocking
> finding for the first time reports it without latching it.

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
database) to check. **Eleven** categorical refusals, never an exception:
`path_not_absolute`, `path_missing`, `path_is_symlink`,
`path_not_a_regular_file`, `file_empty`, `file_too_large`,
`file_has_uncheckpointed_wal`, `file_changed_during_verification`,
`not_a_readable_sqlite_database`, `integrity_check_failed`,
`not_an_hq_database`. Nine of the eleven are exercised against real files on
disk — a relative path, a missing one, a directory, an empty file, a symlink,
a file of prose, a corrupted SQLite image, a perfectly valid SQLite database
that is simply somebody else's, and a database with an un-checkpointed WAL
beside it. `file_too_large` is NOT exercised: it would mean writing a
two-gigabyte file in a test, and a bound that is asserted by reading the
constant rather than by crossing it is stated here as what it is.
`file_changed_during_verification` IS exercised since the second Wave 5
correction round: the substitution is placed exactly where the race would put
it (the moment the digest descriptor is obtained, before anything opens the
path) by a spy on `fs.openSync`, and two real HQ databases with different table
counts make the swap observable.

**The last two are Wave 5 corrections (Medium 3), and both close a real hole.**
The recorded digest covered the MAIN FILE only, while the verifying open reads
main PLUS any `-wal`/`-shm` sidecar, which was never hashed — executed: two
candidates carried an identical `contentDigest` and an identical recorded size
while their verified table counts differed (11 versus 12), because the
difference lived entirely in an un-digested WAL. So a candidate with a non-empty
`-wal`/`-journal` sidecar is now refused rather than recorded under a digest
that means less than it looks like it means. Consequence, stated: pointing this
at the LIVE WAL database is now a refusal instead of a pass. It was never
unsafe — it still reads and writes nothing — but the digest it produced did not
pin what SQLite checked. Separately, the digest `open` and the SQLite `open`
were two independent `open()` calls on the same path; the digest descriptor is
now HELD across the SQLite open and the file is re-digested through it
afterwards.

> **Correction (Wave 5 second correction round, MEDIUM 5).** That last sentence
> used to end "so digest and verdict provably describe one inode and one
> content", and it did not. The re-digest proves the CONTENT behind the held
> descriptor did not change; it proves nothing about what
> `openHqDatabaseReadOnly(resolved)` opened, because that open is BY PATH and
> re-resolves it. A `rename()` between the first digest and that open left the
> digest describing inode A while `integrity_check`, `schemaTables` and
> `verified` described inode B — and the re-digest, reading A, agreed with
> itself, so the candidate passed and `recordVerifiedBackup` would have stored
> that digest as a recovery point.
>
> **Fixed** by comparing the descriptor's `dev`/`ino` with the path's after the
> open and refusing a divergence as `file_changed_during_verification`. It
> cannot invent a refusal (on a platform with no meaningful inode both reads
> agree) and a rename that happens after SQLite's own open is refused too, which
> is the fail-closed direction.
>
> **What the guarantee actually is, stated exactly rather than rounded up:** the
> content behind the digest descriptor cannot have changed, and the path cannot
> be naming a different inode at the moment of verification. A rename that is
> REVERTED inside the window between SQLite's own open and that `stat` would
> still pass. Closing that would require opening the database through the held
> descriptor (`/proc/self/fd/<n>`), which is not portable, and it was not done.

**A symlinked PARENT directory is recorded, not refused.** `verifyHqBackupFile`'s
own function header used to say the opposite — that a divergence is "refused as
`path_is_symlink`" — while the code, the inline note forty lines below and the
test all said it is recorded. A merge artifact, corrected in the second Wave 5
round (LOW 6); the header now matches. `lstat` and
`O_NOFOLLOW` cover only the FINAL path component (verified true with a directory
symlink), so a candidate reached through a symlinked ancestor used to be
verified silently under the alias the caller named. A symlinked ancestor
substitutes no file — the digest and the `integrity_check` still describe
whatever inode the path resolves to — so what it breaks is bookkeeping.
`BackupVerification.resolvedPath` carries the path HQ actually opened, and
`recordVerifiedBackup` stores THAT, so the register and the dedupe key name the
file rather than an alias for it. Refusing on any divergence was the other
option and was rejected as disproportionate and non-portable: on macOS
`os.tmpdir()` itself sits under a symlinked `/var`.

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
  The second correction round added `EngineImmutableTable.requiredGuards`, a
  REDUCED base for the one table whose own columns are legitimately updated
  (`hq_mission_plan_items` — see the Phase 14 doc for why it had to come into
  the census at all), and a test pins that exactly one entry declares one, so a
  second exception cannot be added quietly.
- **An HQ database file created before this correction round engages safe mode
  once, on its first boot afterwards.** `trg_hq_mission_plan_items_no_erase` and
  the `hq_safe_mode_latch` guards did not exist in it. The census skips a table
  that is ABSENT (so the latch table produces nothing), but
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
| MEDIUM 5 — `file_changed_during_verification` did not hold, because the SQLite open is by path | "Backup and restore" |
| LOW 6 — `verifyHqBackupFile`'s header contradicted its own code about a symlinked ancestor | "Backup and restore" |

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

**Verification after the reconciliation** (the whole suite, not a subset):

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
narrowed by either lane or by the merge; the three pre-existing `it.skip` GAP
markers under `packages/server` are untouched, and nothing under
`packages/server`, `packages/web`, `packages/shared` or `packages/config-mesob`
was changed.
