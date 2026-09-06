# Phase 7 — Truth + Evidence

Built on accepted main `9787516` (the Wave 1 merge, Phases 5 + 6) as the first half of the
Phase 7 + 8 wave on branch `cloud/phase-7-8-truth-authority-gateway`. Phase 8 (the external
action gateway / risk engine) is a separate build on the same branch and is NOT described
here. One document for the phase, in the Phase 5+6 style; the Phase 8 builder appends its own.

## What Phase 7 is

HQ now distinguishes, as first-class records, what was **claimed**, **observed**, **verified**
and **Founder-accepted** about its own canonical entities — a truth/evidence graph that is a
**projection over existing evidence, never a second authority**. Module
`src/application/truth-command.ts` owns the vocabulary, the schema, the pure derivation core and
the browser views; `HeadquarterOperations` owns every authority decision and every write
(`recordTruth`, `verifyTruth`, `acceptTruth`) and every read (`getTruthRecord`, `listTruth`,
`getEntityTruth`, `listTruthContradictions`, `truthSummary`, `truthStorePresent`).

### The model

- **States are categorical only**: `claimed | observed | verified | accepted`. There is no
  confidence number, no score, no percentage anywhere — by design (the wire guard already
  refuses `confidenceScore`/`progressPercent`; `truth-surfaces` additionally pins that no
  key of the browser view is a fabricated-metric name).
- **A record is BORN `claimed` or `observed`** (`bornState`, immutable). `verified` and
  `accepted` are never stored on the record — they are **derived** at read time, by one pure
  function (`deriveTruthRecord`), from OTHER actors' verification and acceptance records.
  Asserting `verified`/`accepted` at birth is refused at the facade and at the route.
- **Subjects** are canonical entities that must EXIST (probed only after the authority gates,
  so the ungranted get no oracle): `mission | project | task | memory | worker | capability`.
- **Evidence refs are `op_evidence` ids, referenced never copied.** Every ref must exist or the
  write is refused (`unknown_evidence`, checked inside the write transaction). An
  `observed` record needs at least one; a `claimed` record may carry none (it is then,
  visibly, a bare claim). A memory record can be the SUBJECT of truth but never its evidence.
- **Relationships**: `supports`, `contradicts`, `supersedes`, `derived_from` are STATED by the
  recording actor at birth (immutable facts of the record, part of its idempotency digest);
  `verified_by` and `accepted_by` are written only by the verify/accept acts, atomically.
  Every related id must name a real truth record.
- **Verification records carry** verifier identity, target, method (`reproduced |
  inspected_evidence | cross_checked_sources | tested | reviewed`), evidence refs (≥1, all
  existing), timestamp, verdict (`confirmed | refuted | inconclusive`) and REQUIRED stated
  limitations.
- **Acceptance records carry** the Founder principal, timestamp, the exact acceptance digest,
  the confirming verification ids it rests on, and an optional scanned note.
- **Privacy** reuses the memory vocabulary (`internal | founder_only`, no parallel one) and
  inherits DOWNWARD, fail closed: a record about a founder_only memory subject, or one that
  supports/contradicts/supersedes/derives from a founder_only record, must itself be
  founder_only or is refused.

### The state machine, as enforced

```
                 recordTruth (hq.truth_record holder; worker or human; never 'system')
                          │
            born ─────────┴──────────► claimed | observed          (self-asserted, only ever these two)
                                              │
      verifyTruth by an INDEPENDENT actor     │  actor ≠ recordedBy; holds hq.truth_verify; trio intact;
      (verdict confirmed, no refuted)          ▼  ≥1 existing evidence ref; limitations stated
                                          verified                   (derived: ≥1 confirmed AND 0 refuted)
                                              │
      acceptTruth — the canonical Founder     │  #assertApprovalAuthority (approval authority; workers,
      gate, plus digest binding, plus         ▼  system, unknown refused); acceptor ≠ author ≠ any
      independence, plus STEP-UP at route  accepted   confirming verifier; expectedDigest === current
                                                      acceptance digest; record current and UNCONTESTED
```

- **A claim can never upgrade itself.** The author of a record cannot verify it, whatever
  grants they hold; the author cannot accept it; a verifier cannot also be the acceptor
  (verification and acceptance are separate authorities — the requester-cannot-approve rule).
- **`refuted`** never erases: the record stays, visibly refuted (`verification: 'refuted'`),
  at its born state. Confirmed AND refuted together is `contested` and the record stays at its
  born state with `acceptanceDigest: null`.
- **`accepted` is one explicit act**: exactly one acceptance per record (unique by engine); the
  same acceptor deduplicates, a different one conflicts — while the acceptance STANDS (see the
  current-standing rule below). Acceptance executes nothing — no task status, approval row,
  claim, dispatch or kill switch moves (pinned).
- **`accepted` is a CURRENT standing, not a permanent label** (review round 3). The acceptance
  row is immutable history; whether the record still presents as `accepted` is re-derived from
  the graph on every read by the current-standing rule below.
- **Supersession** is an explicit, attributed act with a unique successor per predecessor (a
  second "supersession" is a contradiction and must be recorded as one). The predecessor row
  never changes; its lifecycle is derived from the immutable forward pointer and it stays in
  the entity's history with its verifications intact. Superseding a record that was EVER
  verified or EVER accepted takes the Founder gate (`#assertApprovalAuthority`, reading the
  history-based `establishedTruthTier`, never the derived `state`) — a worker's fresh claim
  cannot displace established truth from "current", and a later refutation or contest lowers
  the record's state but never the authority needed to retire it. A superseded record can be
  neither verified nor accepted (`truth_conflict`).

### The current-standing rule for a Founder acceptance (review round 3)

Verification is append-only and a later refutation is deliberately kept beside the acceptance
it undermines, so the projection must say which of the two stands NOW. The rule, as one
predicate over the graph (`deriveTruthRecord`, pure, the same function every read and every
gate uses):

```
verificationBasisHolds := verificationSummary(record) = 'confirmed'     (≥1 confirmed AND 0 refuted)
current                := no record supersedes this one                 (lifecycle = 'current')
uncontested            := no unresolved contradiction touches this one  (contested = false)

acceptanceStanding :=
    'none'                  if the record holds no acceptance row
    'verification_refuted'  else if ¬verificationBasisHolds
    'superseded'            else if ¬current
    'contested'             else if ¬uncontested
    'standing'              otherwise

state :=
    'accepted'      if acceptanceStanding = 'standing'
    'verified'      else if verificationBasisHolds
    bornState       otherwise
```

- **What degrades to what.** An acceptance stands only while every precondition the acceptance
  itself required still holds; the moment one breaks, the record derives exactly what it would
  derive WITHOUT the acceptance: `verified` while the verification basis is intact (superseded
  or contested), else its born state (refuted). So: accepted → later refuted verification ⇒
  born state, `verification: 'contested'`, standing `verification_refuted`; accepted → later
  unresolved contradiction ⇒ `verified`, `contested: true`, standing `contested` (and the entity
  headline shows the born state, as for any contested record); accepted → superseded ⇒
  `verified`, `lifecycle: 'superseded'`, standing `superseded`. The ladder names the FIRST
  broken precondition, basis first — and the preconditions CAN break together. A superseded
  record is `out` of every contradiction (`standingOf` → `judgeContradiction`), so `superseded`
  and `contested` never co-occur; but a record whose verification summary is `contested` (≥1
  confirmed AND ≥1 refuted) is NOT out — `standingOf` withdraws a record only for a summary of
  exactly `refuted` — so a live rival can still contradict it and the contradiction stays
  `unresolved`. Reproduced through the facade: claim → confirm → accept → refute → a live rival
  contradicts it derives `{state: 'claimed', verification: 'contested', contested: true,
  lifecycle: 'current', acceptanceStanding: 'verification_refuted', acceptanceDigest: null}` —
  the verification precondition and the contest precondition broken at the same time. The rule
  then simply names the basis and says nothing about the contest in `acceptanceStanding`; a
  reader loses nothing by that, because the same view carries `contested: true` (and the
  `contradictions[]` entry) beside the named standing, the console draws the `CONTESTED` chip
  beside `ACCEPTANCE NO LONGER STANDS`, the accept ladder refuses in the same basis-first order
  (`truth_not_verified`, `details` naming the standing), and the snapshot counts the dispute.
  Pinned through the facade in `truth-acceptance-standing`. (An earlier version of this
  sentence claimed a contest was "by construction never simultaneous with the other two"; that
  was false for the refuted case and is corrected in the round 3 accuracy correction below.)
- **What is final and what can return.** Refutation and supersession are irreversible acts, so
  those standings are final. A contest resolves only by an explicit act (a refuting
  verification or a supersession of the OTHER side); resolved in the record's favour, the
  standing returns to `standing` and the state to `accepted` by derivation alone — the basis
  never moved and nothing is written to restore it. There is no timestamp, score or
  tie-break anywhere in this rule.
- **History is never erased and stays reachable.** The `hq_truth_acceptances` row (acceptor,
  timestamp, digest, the confirming verification ids it rested on, note) is byte-identical
  after degradation (pinned), the `truth_accepted` evidence entry and the `truth:<id>` audit
  event remain in the chain, and every view still carries it in `acceptances[]` whatever the
  standing — the reader can always see that the Founder DID accept, when, and on which
  verifications. The console card keeps the `ACCEPTED by …` line and adds an
  `ACCEPTANCE NO LONGER STANDS` chip plus one line naming the standing and the state the record
  derives now.
- **Nothing is acceptable in a degraded standing.** `acceptanceDigest` is issued only for a
  record that is exactly `verified`, current and uncontested; a degraded acceptance is either
  refuted (born state), superseded (not current) or contested — never acceptable, so the
  console draws no accept control and `awaitingAcceptance` never counts it.
- **Re-acceptance is never a shortcut (fail closed).** `acceptTruth` deduplicates (same
  acceptor) or conflicts (another acceptor) ONLY while the acceptance stands. Once degraded,
  the request falls through to the ordinary ladder, re-derived inside the IMMEDIATE write lock,
  and is refused on the record's CURRENT standing with the true cause — `truth_conflict`
  (superseded), `truth_not_verified` (refuted; `details.acceptanceStanding` names it),
  `truth_contested` — exactly as a never-accepted record in the same shape. No second acceptance
  row can exist (the engine's one-acceptance index; a belt-and-braces refusal stands before the
  insert regardless).
- **Authority is never lowered by degradation.** The supersession gate reads
  `establishedTruthTier` — HISTORY-based: `accepted` if any acceptance row exists, else
  `verified` if any verification ever confirmed the record, else nothing — never the derived
  `state`. A record once verified or once accepted takes the Founder gate to displace from
  "current" for as long as it exists, whatever its current standing. This is deliberately
  STRICTER than the head before the correction, where a verified record whose verification was
  later contested (confirmed + refuted) derived its born state and any claimant could supersede
  it; now that too takes the Founder. A record only ever refuted or inconclusive established
  nothing and needs no gate (pinned in both directions).
- **Every surface reads the same `state`,** so none disagrees: the list filter, the entity
  headline (`entityCurrentState`), the snapshot `byState` (counts the current standing; a degraded
  acceptance is counted under what it derives now, never under `accepted`), `awaitingAcceptance`,
  the Founder Office `Founder-accepted` metric (its description now says "currently stands") and
  Company Memory's `Accepted`. `TruthRecordView` gained ONE additive categorical field,
  `acceptanceStanding` (`none | standing | verification_refuted | superseded | contested`); no
  schema, migration or write-path change, no `HQ_SNAPSHOT_VERSION` bump.

Before this rule (heads `20d70ef` through `ba16bf3`) `deriveTruthRecord` computed
`state = acceptances.length > 0 ? 'accepted' : …` before considering any later refutation,
contest or supersession, so a historical acceptance kept projecting as CURRENT `accepted` truth
after new evidence refuted or contested its basis, while the same derivation already
(correctly) withdrew `acceptanceDigest` — the projection and the acceptability disagreed.

### Contradictions and staleness — never newest-wins

A `contradicts` relation between two current, unrefuted records is `unresolved` and BOTH
records render `contested: true`, at their born state in the entity headline
(`entityCurrentState` never launders a contested verification). It resolves ONLY by an
explicit act — `resolved_by_refutation` (one side refuted by verification) or
`resolved_by_supersession` (one side superseded) — or `both_withdrawn`; the judgement
(`judgeContradiction`) reads no timestamp. A contested record cannot be accepted
(`truth_contested`): the Founder resolves the dispute explicitly rather than by accepting one
side while the other still stands. Unresolved contradictions ride every read surface (list
route, entity route, snapshot section, Security Center rows, the console's first block).
Staleness is a categorical `subjectDrift` (`none | subject_changed_since_record |
subject_superseded | subject_missing | not_evaluated`) computed from the subject's canonical
row, shown and never used as a tie-breaker.

## Authority rules (the enforcement-safe path)

- Two capability trios, CONFIGURATION-vs-INVOCATION exactly as memory/orchestrate:
  `hq.truth_record` and `hq.truth_verify` (`reversible`, `sideEffect: false`,
  `idempotent: true`); registration is a separate act (`registerTruth*Capability`), invocation
  fails closed on missing/altered/disabled through the DATABASE row (`#capabilityFromStore`,
  never `queue.capabilities`), and detection never repairs. Unlike the Founder-gate trio a
  **worker may hold these** through its directory grant (a reviewer worker verifies a builder's
  claim); `system` is refused outright because an unattributed truth act is exactly the
  fabrication this phase forbids. Human grants ride `originateCapabilities`, as memory's does.
- Acceptance reuses the canonical Founder mechanics and invents nothing parallel:
  `#assertApprovalAuthority` (the approve/deny/kill-switch gate — positive identity, audited
  refusal), digest binding (`expectedDigest` must equal the record's current
  `truthAcceptanceDigest`, computed over id + subject + statement + supersedes + the sorted
  confirming verification ids; a moved basis refuses with `action_digest_mismatch` and an
  evidence entry), and STEP-UP at the route — **unconditionally**, not by risk class: an
  acceptance is the Founder's irreversible signature on truth, so it takes the same
  fresh-credential bar as an execution-granting approval.
- **The decision reads canonical rows, never a public projection.** `acceptTruth` re-derives the
  record INSIDE the IMMEDIATE write lock through the private `#deriveTruthById` (→ `#db` +
  the module's pure function); `getTruthRecord` merely calls the same private method. Pinned
  by the hostile-patch tests: `getTruthRecord`/`listTruth`/`getEntityTruth` patched on both the
  instance and the prototype to report a forged `verified` state and digest change nothing;
  a lying `queue.capabilities.get` cannot smuggle a disabled trio; a lying public
  `lookupPrincipal` cannot forge the Founder gate.
- Every write is ONE IMMEDIATE reserve transaction: dedupe read → existence checks (evidence,
  relations, subject) → authority re-checks that depend on graph state (supersession tier,
  acceptance basis) → insert(s) + stated relations + `hq_events` audit (`truth:<id>`) +
  `op_evidence` entry (`truth_recorded` / `truth_verified` / `truth_accepted`, all
  `executable: false`), atomically. Refusals write nothing (row-count pinned throughout).
- Derived idempotency keys (`truth:`, `truth-verification:`) over canonical JSON of the
  normalized input + actor; the client key is an input, never the key. Identical re-record and
  re-verification dedupe (200); acceptance dedupes by acceptor.
- Kill switch: truth writes stay OPEN (the memory intake-parity rule) — recording, verifying and
  accepting are records, execute nothing, and must survive an emergency stop.
- Bounds: statement ≤1000, limitations ≤1000, note ≤500, id lists ≤20 entries of ≤200 chars,
  duplicates collapsed; secret scan on every persisted text (facade) and the stricter browser
  scan at the routes; `requestedBy` only from the resolved principal, a body/query naming an
  actor refused (`client_identity_supplied`).

## What is canonical vs projection

| Canonical (unchanged, never rewritten by this phase) | Projection (Phase 7, derived) |
|---|---|
| `op_evidence` hash chain — evidence truth; truth entries only APPEND to it and reference ids | `hq_truth_records` (born state + refs + stated pointers), `hq_truth_relations`, `hq_truth_verifications`, `hq_truth_acceptances` — all INSERT-only BY ENGINE (full §G trigger set: no UPDATE of any column, no DELETE, and a BEFORE INSERT guard on EVERY unique index — `id`/`seq` AND the secondary indexes `idempotency_key`, `supersedes`, one-acceptance-per-record — so REPLACE/UPSERT is closed on every conflict target, for every writer, regardless of that writer's `recursive_triggers` setting; see the review-round-1 corrections below) |
| `op_tasks`, `hq_approvals`, `op_kill_switch`, `hq_missions`, `hq_projects`, `hq_memory`, registries | derived `state`, `lifecycle`, `verification`, `contested`, `subjectDrift`, `acceptanceDigest`, contradiction resolutions, `entityCurrentState` |
| Founder gate, capability trios, worker directory, principal registry | nothing — no gate, grant, policy, claim, dispatch, orchestration or kill-switch path reads a truth table (pinned: an accepted "this task is approved" truth changes no status, approval row, eligibility verdict or claimability) |

Memory informs; memory never grants: a memory record asserting verification/acceptance changes
no truth state (pinned), and memory is refused as evidence (`unknown_evidence`).

## Surfaces

Routes (the unchanged pipeline — origin/content-type, identity scan of body AND query, Founder
resolution, `safe()`; route table 21→25, write surface 15→18, both pins updated deliberately):

```
GET  /api/hq/control/truth          bounded list (TRUTH_READ_LIMIT=50, newest first, total +
                                    truncated), founder_only INCLUDED past the Founder gate,
                                    unresolved contradictions alongside, storePresent
GET  /api/hq/control/truth/entity   ?kind=<entity kind>&id=<id> — current, history (bounded,
                                    total), headline state, unresolved contradictions
POST /api/hq/control/truth          record a claim/observation (201 / 200 deduplicated)
POST /api/hq/control/truth/verify   record a verification (201 / 200 deduplicated)
POST /api/hq/control/truth/accept   Founder acceptance — STEP-UP always (401 required /
                                    403 failed / 429 rate-limited), 201 / 200 deduplicated
```

One status per cause: 404 `unknown_truth | unknown_evidence | unknown_entity`; 409
`truth_conflict | truth_not_verified | truth_contested`; 403 authority/capability; 400 input
and `unsafe_truth_content`. Session controls gain `truthRecord`, `truthVerify` (grant AND
intact row, enforcement-safe read) and `truthAccept` (= approval authority), each advertised
from exactly the conditions that decide the write.

Snapshot: an OPTIONAL `truth` section (`TruthSnapshotView`: total, byState, unresolved count,
verified-awaiting-acceptance count, withheld founder_only count, newest
`TRUTH_SNAPSHOT_LIMIT`=20 records, unresolved pairs). Optional by shape on purpose — a static
build opens no truth store and states nothing rather than an invented zero, every pre-Phase-7
fixture stays valid, and no `counts` pin moved. **What each count spans (review round 2):**
`total` counts every record, founder_only included, and `withheldFounderOnly` says how many of
those the reader may not see; `byState`, `unresolvedContradictions` and `awaitingAcceptance`
span ONLY the set the reader may see (all records past the Founder gate; the non-founder_only
records in the unauthenticated artifact) — over all of that set, never bounded by the carried
page, so `byState` sums to `total − withheldFounderOnly` and `unresolvedContradictions` is
exactly the count of pairs `contradictions[]` summarises. (At heads `20d70ef` and `8ad1c92`
`byState` and `unresolvedContradictions` were computed over ALL records including withheld
ones, so arithmetic on the artifact — `total`, `withheldFounderOnly`, `byState.accepted`
against the carried records — disclosed how many PRIVATE records were accepted, and a dispute
between two private records was counted as existing.) The
Founder-gated `/state` carries founder_only rows; the unauthenticated artifact withholds them,
withholds the pair-level contradictions touching them, AND projects every carried public
record through `withholdFounderOnlyRelations` so no relation id (`supports`/`contradicts`/
`derived_from` in either direction, `supersedes`/`supersededBy`) and no `contradictions[]`
entry pointing at a founder_only record survives — counted per withheld counterpart as
`withheldFounderOnlyRelations`, stated in provenance beside `withheldFounderOnly`. Pinned:
neither the private statement text NOR the private record id appears anywhere in the
artifact blob. What is deliberately NOT rewritten is the public record's own categorical
standing: a public statement that is `contested` or `superseded` stays so in the artifact
(the same answer the Founder-gated view gives), because laundering it would present a
contested statement as clean — the artifact withholds who by, in which direction and how it
stands, never the fact that the public record itself is in that state. A read-only
pre-Phase-7 file projects absence with provenance saying why; no `HQ_SNAPSHOT_VERSION` bump
(additive — one new count field, `withheldFounderOnlyRelations`).

Rooms (server-side `hydrate.ts`, counts only, present-only when the section exists): **Security
Center** gains a `Truth contradictions` condition metric and one attention row per unresolved
contradiction ("neither side is preferred by recency"); **Founder Office** gains
`Verified, awaiting acceptance` (the server-side `awaitingAcceptance` count: exactly the
records the server issued an acceptance digest for, counted over EVERY record the reader may
see — since review round 2; before it the room counted `acceptanceDigest !== null` over the
bounded `records` page while `Founder-accepted` beside it used `byState` over all records, so
past twenty records the metric UNDERSTATED the verified truth waiting at the gate and the
"cannot disagree" claim that stood here was false) and `Founder-accepted`, both
waiting-at-the-gate liveness; **Company Memory** gains `Truth records / Verified / Accepted`
beside memory. Room
`binding.source` texts name the truth section. An empty projection renders dark; zero is zero.

UI: archive.html gains the Truth + Evidence live console (`truthConsoleScript`): a mount and a
note in static markup, everything else script-created after a real `/session` grant,
textContent-only. Unresolved contradictions render FIRST; each record card shows derived state,
born state, lifecycle, verification picture, evidence ids, every verification with verifier/
method/limitations, acceptance provenance with digest, contradiction resolutions, supersession
and subject drift. Entity lookup reads the parameterized route. The record and verify forms
draw only under their grants; the accept form draws a control only when something is genuinely
acceptable, carries the record's digest verbatim, and has a step-up password field (never
stored, echoed or audited). Fetch heads / postJson targets / path literals are allow-listed in
`control-console.test.ts` (pins updated). Grant JS gains the three truth flags.

## What is NOT here (deliberately)

No confidence numbers, scores or rankings. No automatic verification, no inference from text,
no model judgement of truth — every verification is an attributed act by a resolved actor. No
automatic resolution of contradictions, no recency tie-break, no "latest wins" view anywhere.
No second evidence store — nothing copies an evidence body. No new approval system — acceptance
is the existing Founder gate plus digest plus step-up. No daemon, no schedule. No Phase 8
machinery: no external-action gateway, no risk engine, nothing that CONSUMES an accepted truth
to act; the truth projection is read by humans and by nothing that decides.

## Known limitations (honest)

- The truth graph is loaded whole per read/derivation (`loadTruthGraph`). Fine at HQ scale and
  bounded on the wire; a large graph would want indexed per-entity derivation. Recorded, not hidden.
- `subjectDrift` is evaluated for mission/project/task (`updated_at`) and memory (status);
  worker and capability subjects report `not_evaluated` — their rows carry no timestamp, and
  inventing one would be a fabrication.
- Verification independence is checked against the record's AUTHOR only. A verifier who also
  authored the evidence entry the record cites is not refused — evidence actorship is a
  weaker signal than record authorship and a rule there would refuse legitimate observations of
  one's own task; left explicit rather than half-enforced.
- Relations are stated at birth only; there is no "relate two existing records" route. Stating
  a contradiction between two existing records is done by recording a new record that
  contradicts one of them — an attributed claim in its own right. A relate route was
  considered and dropped as a second write path with a weaker authorship story.
- The console's accept control appears for any approval-authority session whose record set
  contains an acceptable record; the facade's independence rules (author/verifier) still decide,
  so a Founder who authored the only acceptable record sees a control that refuses with the
  reason. Advertising per-record acceptability would leak actor-graph facts to the browser.
- Truth writes are not kill-switch-gated (intake parity with memory/missions). If Phase 8 makes
  an accepted truth an INPUT to an external action, the gateway must gate there — this phase
  records only.
- The unauthenticated artifact still states a carried public record's `contested` /
  `lifecycle` truthfully (see Surfaces). Together with `withheldFounderOnlyRelations > 0` a
  reader can infer that SOME founder_only counterpart relates to a public record — the count
  is the price of stating the omission honestly rather than silently. The private record's
  id, statement, direction and resolution never appear. If the Founder prefers the artifact
  to carry no count, that is a one-line policy change, recorded here as an open choice.
  Review round 2 considered this residual and dismissed it: laundering the record would
  present a disputed statement as clean, which is worse. It stays as documented. A visible
  consequence since round 2's count scoping: such an artifact can show `contested: true` on a
  carried record while `unresolvedContradictions` is 0 — the pair is withheld, the record's
  own standing is not.
- The snapshot carries no aggregate count of acceptances that no longer stand (review round 3).
  `byState.accepted` drops when an acceptance is degraded and the record's card names why, but
  no room metric says "N Founder acceptances were later refuted/contested/superseded". Adding
  one is a one-field additive change to `TruthSnapshotView`; it was left out of the correction
  to keep the round to the reviewed defect, and is recorded here as an open choice.

## Deliberate pin ledger

Route table 21→25 (`live-control-api`), write surface 15→18 (`live-mission-routes`), console
fetch heads (+`TRUTH_PATH`, `TRUTH_ENTITY_PATH`) and postJson targets (+`TRUTH_PATH`,
`TRUTH_VERIFY_PATH`, `TRUTH_ACCEPT_PATH`) with the "eighteen write routes" wording
(`control-console`), `CONTROL_FETCH_TARGETS` (+4), room `binding.source` texts for
security-center / founder-office / company-memory, `CONTROL_GRANT_JS` (+3 flags). No test was
deleted or relaxed; no `counts` pin, no `ROOM_SECTIONS` change, no `HQ_SNAPSHOT_VERSION` bump.
Review round 1 RENAMED one test to what it proves (`truth-graph-hardening`: the engine-abort
test covered UPDATE/DELETE on all four tables but REPLACE/upsert only on the `id` target — it
is now named exactly that, and a second test carries the secondary-index cases); its
assertions were not changed. Review round 2 CHANGED two expected values in `live-truth-routes`
and added assertions beside them, deliberately and in the stricter direction: the
unauthenticated artifact's `unresolvedContradictions` for (a) a dispute between two
founder_only records and (b) a founder_only record disputing a public one was pinned at `1`
(the count spanned withheld rows) and is now pinned at `0`, with the Founder-gated state
pinned at `1` and the gated/artifact `byState` pinned explicitly in the same tests — the
count is now pinned in both directions rather than loosened. `TruthSnapshotView` gained one
additive field (`awaitingAcceptance`); the read-only pre-Phase-7 absence projection states
it as 0 like its siblings. No test was deleted or relaxed. Review round 3 CHANGED two
expectations in `truth-durability` deliberately, both of which encoded the defect: after the
reopen, the accepted-then-contradicted record was pinned `state: 'accepted'` beside
`contested: true` and is now pinned `verified` + `contested` + `acceptanceStanding: 'contested'`
with the acceptance row still readable; and a second acceptor on that record was pinned
`truth_conflict` ("already accepted") and is now pinned `truth_contested` (refused on the
current standing) with the acceptance count pinned at 1 — a refusal in both directions, now
for the true cause. `TruthRecordView` gained one additive categorical field
(`acceptanceStanding`). No test was deleted or relaxed; no `counts` pin, no `ROOM_SECTIONS`
change, no `HQ_SNAPSHOT_VERSION` bump, no route-table or write-surface change. The round 3
accuracy correction RENAMED one test in `truth-acceptance-standing` to what it proves (the
pure-ladder precedence test had claimed a contest is never simultaneous with a refutation, which
is false), REPLACED its one vacuous assertion (`contested === false` on two records that no
contradiction touched) with a genuine one (a live record now contradicts both superseded
records and each contradiction is pinned `resolved_by_supersession`), and ADDED one test
pinning the refuted-and-contested co-occurrence through the facade. Every assertion the renamed
test already carried is unchanged; no source line changed; no test was deleted or relaxed.

## Deployment runbook (configuration acts, never automatic)

1. `hq:workforce --local-admin --register-capability hq.truth_record`
2. `hq:workforce --local-admin --register-capability hq.truth_verify`
3. Grant `hq.truth_record` in the Founder principal's `originateCapabilities` (and to any worker
   that should claim, via its directory allow-list); grant `hq.truth_verify` to the
   independent verifier(s) — a different principal/worker from the claimants, or nothing will
   ever verify.
4. Acceptance needs no registration: it is approval authority on the principal.
Until these acts happen every invocation fails closed (`unknown_capability` / `not_permitted`).

## Evidence

New suites: `truth-authority` (16: self-upgrade, self-verify, observation rules, verification
authority/vocabulary, Founder gate + digest + independence + contested/refuted, execution
inertness, identity/trio fail-closed, no existence oracle, dedupe), `truth-graph-hardening`
(21: no newest-wins incl. verified-but-contested, timestamp-blind judgement, evidence/relation
existence, engine immutability on all four tables — UPDATE/DELETE, REPLACE/upsert on the `id`
target, and REPLACE on every SECONDARY unique index with `recursive_triggers` switched OFF on
the connection — op_evidence chain grows only, src-wide rewrite-spelling guard, superseded
auditability and Founder-tier supersession, categorical staleness, memory-never-grants incl.
memory-as-evidence refusal and founder_only inheritance, no-second-evidence-store
canonical-inertness, pure reads, hostile-patch ×3), `truth-durability` (2: real file reopen
with identical derivation and identical refusals; read-only pre-Phase-7 absence),
`live-truth-routes` (15: write surface, attribution/dedupe, birth-state refusal, the arc through
the routes, STEP-UP on accept only, one status per cause, hostile callers, identity in body and
query, mutations-off, secret-like content, 404 sub-routes, founder_only through the gate and
withheld from the artifact by statement AND by id, a founder_only contradiction of a PUBLIC
record leaving no id in the artifact while the gated state keeps it, entity route, control
advertisement incl. withdrawal on a disabled row), `truth-surfaces` (8: optional section
absence, derived states + both wire guards + no fabricated key, the artifact privacy
projection over supports/derived_from/contradicts/supersession with the withheld count, the
artifact's aggregate counts spanning the carried set only (round 2), Security/Founder rooms,
Founder Office counting awaiting-acceptance over `TRUTH_SNAPSHOT_LIMIT + 1` verified records
(round 2), Company Memory counts, dark zero), `truth-console` (6, JSDOM against the real control API:
inert static markup, forms only under grants, record from the page, contradiction-first +
limitations + step-up refusal then acceptance with password, entity lookup, non-Founder off +
hostile text inert), hq-host `host-contract` (+2: Fastify-wired record/entity/query-scan/
self-verify/accept-refusal arc, NO_IDENTITY sweep of all five truth routes),
`truth-acceptance-standing` (13, review round 3 and its accuracy correction: accepted → later
refuted; accepted → later confirmed + refuted; accepted → later refuted AND contradicted by a
live rival, the two preconditions broken at once and the basis named first with the contest
still visible; accepted → later unresolved contradiction and its explicit resolution restoring
the standing; accepted → superseded; the pure ladder's precedence with a superseded record
pinned out of every contradiction, and the history-based tier; supersession authority never
lowered for the once-accepted and the once-verified, with the never-verified needing no gate;
re-acceptance of a degraded record refused through the ordinary ladder in all three shapes and
a standing one still deduplicating — the one preserved-behaviour pin, which passes pre-fix by
design; snapshot counts, Founder Office, Company Memory and the entity headline agreeing), plus one
`truth-console` test (the card shows the acceptance as history beside the state derived now,
and draws no accept control). Full-matrix results
are recorded in the wave PR; merge stays gated on independent review and the Founder.

## Independent review round 1 — corrections (head `20d70ef` → this head)

An independent hostile review of the exact head `20d70ef` (CI green, every test count
confirmed) returned CHANGES REQUIRED with working exploits. Each finding sat inside a stated
guarantee and outside what the green suite asserted. The Phase 7 items and their fixes:

- **High — `INSERT OR REPLACE` bypassed the insert-only triggers through SECONDARY unique
  indexes.** The `*_no_replace` BEFORE INSERT guards tested only `NEW.id`/`NEW.seq`; a REPLACE
  colliding on `hq_truth_records.idempotency_key`, `hq_truth_records.supersedes`,
  `hq_truth_verifications.idempotency_key` or `hq_truth_acceptances.truth_id` deleted the
  standing row, and SQLite fires no BEFORE DELETE for that delete unless `recursive_triggers`
  is on (it was not set; it is connection-scoped and binds no foreign writer anyway). Proven:
  the Founder's acceptance row replaced by an attacker's with a forged digest, the record still
  deriving `accepted`; a legitimate successor deleted and `supersededBy` re-pointed at a
  forgery. **Fix (`truth-command.ts`):** three ADDITIVE triggers
  (`trg_hq_truth_records_no_replace_unique`, `trg_hq_truth_verifications_no_replace_unique`,
  `trg_hq_truth_acceptances_no_replace_unique`) close every remaining unique index — new names
  so a file created at the old head gains them on the next ensure. `hq_truth_relations` has no
  secondary unique index. Belt to those braces (`store/db.ts`): the application connection
  now sets `PRAGMA recursive_triggers = ON`, so on OUR connection REPLACE also reaches the
  BEFORE DELETE guards; checked before enabling it: no trigger anywhere in the schema writes
  (all bodies are `RAISE(ABORT)`), so nothing recurses; no source path spells `REPLACE INTO` /
  `INSERT OR REPLACE` (the src-wide spelling guards); every `ON CONFLICT DO UPDATE` in `src/`
  targets a table with no triggers and UPSERT is unaffected by the pragma regardless; no
  existing test pins the pragma set. The legitimate write paths pre-check idempotency and
  supersession inside the IMMEDIATE lock, so no accepted path ever reaches the new guards.
  Pinned in `truth-graph-hardening` with the pragma switched OFF on the connection, so the
  test proves the trigger and not the pragma; verified to fail against the old DDL.
- **Same flaw in `hq_memory` (accepted Phase 5, `idx_hq_memory_idem`) — hardened here as
  directly adjacent, additive and behaviour-preserving:** `trg_hq_memory_no_replace_idem`
  (`memory/store.ts`, new name, `HARDENING_DDL` already runs on every construction). The
  facade dedupes by key BEFORE inserting (`findIdByIdempotencyKey`), so the only writer that
  can trip it is a forger or a raced foreign insert; no memory code path catches
  `SQLITE_CONSTRAINT_UNIQUE` specifically, so the changed engine error shape on that race
  alters no behaviour. Pinned in `memory-engine-hardening`; verified to fail against the old DDL.
  (Round 2 found this left the table's THIRD conflict target — its implicit rowid — open; see
  the round 2 corrections below.)
- **Medium — founder_only leakage through relation ids in the unauthenticated artifact.**
  `truthSummary` withheld the records and the pair list, but a carried PUBLIC record still
  shipped the private record's id in `contradictedBy` / `contradictions[].withId` (and by the
  same shape `supportedBy`, `derivations`, `supersededBy`). **Fix:** the pure
  `withholdFounderOnlyRelations` projection (`truth-command.ts`), applied in `truthSummary`
  when `includeFounderOnly` is false, with the count `withheldFounderOnlyRelations` and a
  provenance note; the Surfaces section above now states exactly what is and is not withheld.
  Pinned in `live-truth-routes` (the id never appears in the blob; the gated state keeps the
  relation) and `truth-surfaces` (all four relation families, count per counterpart);
  verified to fail against the unscrubbed summary.
- **Low — overstated test name.** The `truth-graph-hardening` engine-abort test claimed
  "every REPLACE/upsert spelling on all four truth tables" while asserting two spellings on
  two tables at the `id` target — the name that let the High ship. Renamed to what it proves;
  the secondary-index cases are a separate, real test.

## Independent review round 2 — corrections (head `8ad1c92` → this head)

A second, independent hostile review of the exact head `8ad1c92` (CI run #519 green, every
test count confirmed) verified round 1's corrections as genuinely fixed — the trigger sweep on
the six new tables complete on all conflict targets, the pragma safe on all three claims, the
relation scrub covering all nine id-bearing fields — and returned CHANGES REQUIRED. The
Phase 7 items and their fixes (the Phase 8 items — the unscanned adapter message and the
`dispatchHistory` read — are in `PHASE_8_AUTHORITY_RISK_ACTION_GATEWAY.md`); every fix carries
a regression test verified to fail against the code before it:

- **Low — `hq_memory` implicit-rowid conflict target still open.** `hq_memory` is the only one
  of the seven tables hardened in this wave with a TEXT primary key, so it keeps a separate
  implicit rowid — a conflict target that `trg_hq_memory_no_replace` (`id`) and
  `trg_hq_memory_no_replace_idem` (`idempotency_key`) do not test. Proven with
  `recursive_triggers = OFF`: `INSERT OR REPLACE INTO hq_memory (rowid, id, …) VALUES (1, 'mZ',
  …)` deleted a `founder_only` record and landed a forged `internal` one in its place, no
  BEFORE DELETE firing. On HQ's own connection the round 1 pragma makes it abort, so only a
  foreign writer at SQLite's default is exposed — hence Low. The comment in `memory/store.ts`
  claimed the id guard closed the REPLACE path "while recursive_triggers is off"; that was
  false for this target. **Fix (`memory/store.ts`):** one additive trigger,
  `trg_hq_memory_no_replace_rowid` (`WHEN TYPEOF(NEW.rowid) = 'integer' AND EXISTS (SELECT 1
  FROM hq_memory WHERE rowid = NEW.rowid)`); an auto-assigned rowid reads as `-1` inside a
  BEFORE INSERT trigger, so the legitimate writer — which never names a rowid — never matches
  an existing row (pinned: a note records normally after the forged REPLACE is refused). The
  module comment now names all three targets and says when the claim was false. Pinned in
  `memory-engine-hardening` with the pragma OFF: the REPLACE aborts, every row byte-identical,
  the founder_only record still founder_only, no forged row. Fails against the old DDL (the
  REPLACE succeeds). The same shape exists on three accepted-main tables outside this wave and
  is recorded as carry-forward debt in the Phase 8 document's Known limitations — not fixed
  here, by the reviewer's framing.
- **Low — `awaitingAcceptance` was a bounded count under an unbounded claim.**
  `client/hydrate.ts` counted `acceptanceDigest !== null` over the artifact's newest
  `TRUTH_SNAPSHOT_LIMIT` = 20 records while the sibling `Founder-accepted` metric used
  `byState.accepted` over all records; the comment claimed the two "cannot disagree". False
  past 20 records, and in the direction that hid pending Founder work. **Fix:** computed
  server-side in `truthSummary` over the full set the reader may see and carried as
  `TruthSnapshotView.awaitingAcceptance`; the room reads it, and the comment says what was
  wrong. Pinned in `truth-surfaces` with 21 verified records: `records` carries 20,
  `awaitingAcceptance` and the Founder Office metric say 21. Fails against the bounded count.
- **Low — artifact aggregate counts spanned withheld founder_only rows.** In the
  unauthenticated artifact `byState` and `unresolvedContradictions` were computed over all
  records while `records` and `contradictions[]` were filtered, so arithmetic disclosed
  aggregate categorical facts about private records (how many are `accepted`; that a private
  dispute exists). No id, statement, subject or actor leaked. The reviewer offered either
  scoping the counts or documenting the span; **scoping was chosen** — a dispute between two
  founder_only records is an internal dispute, which is the very substance round 1 said
  founder_only protects when it scrubbed relation ids, and `total` + `withheldFounderOnly`
  still state the omission. **Fix (`service.ts` `truthSummary`):** `byState`,
  `unresolvedContradictions` and the new `awaitingAcceptance` span the visible set; `total`
  is unchanged. Surfaces above states exactly what each count spans. Pinned in
  `truth-surfaces` (gated vs artifact counts side by side; `byState` sums to `total −
  withheldFounderOnly`) and by the two changed `live-truth-routes` expectations recorded in
  the pin ledger. Fails against the all-rows aggregate.
- **Considered and dismissed by the reviewer — left as documented:** a carried public record
  staying truthfully `contested` while `withheldFounderOnlyRelations > 0` (see Known
  limitations).

## Independent review round 3 — correction (head `ba16bf3` → `6849f87`)

A third independent review of head `ba16bf3` returned one Medium against Phase 7 (the three
recorded Lows and the Phase 8 gateway are untouched by this round):

- **Medium — a historical Founder acceptance stayed projected as CURRENT `accepted` after later
  evidence invalidated its basis.** `deriveTruthRecord` set `state` from the mere existence of
  an acceptance row before considering a later `refuted` verification (summary `contested`), an
  unresolved contradiction, or supersession; the same derivation correctly withdrew
  `acceptanceDigest`, so the projected state and the acceptability disagreed, and a stale
  `accepted` could mislead any later projection while the acceptance event itself had to stay
  immutable. **Fix (derivation only — no schema, migration or write-path change):** the
  current-standing rule stated in full under *The current-standing rule for a Founder
  acceptance* above — `state` is `accepted` only while the acceptance STANDS, the additive
  categorical `acceptanceStanding` names the first broken precondition, the acceptance row and
  its evidence/audit entries stay byte-identical and readable, and every read surface (list
  filter, entity headline, snapshot `byState` / `awaitingAcceptance`, Founder Office, Company
  Memory, the console card) reads the one derived `state`. **Two adjacent closures were
  required to keep the rule coherent and fail-closed, both made explicitly:** (a) the
  supersession gate in `recordTruth` now reads the history-based `establishedTruthTier`
  rather than the derived `state` — with the naive degradation alone a once-accepted record
  whose acceptance fell to its born state would have stopped requiring Founder authority to
  displace, a real authority downgrade; the gate is now also stricter than before for a
  once-verified, later-contested record (recorded above); (b) `acceptTruth` deduplicates or
  conflicts on an existing acceptance ONLY while it stands — a degraded acceptance falls through
  to the ordinary ladder inside the write lock and is refused on the record's current standing,
  never answered "already accepted"; a belt-and-braces refusal before the insert closes any
  future reordering, beside the engine's one-acceptance index. Pinned in the new suite
  `truth-acceptance-standing` (12 at that head; 13 after the accuracy correction below) and one
  new `truth-console` test. **Measured pre-fix result: 11 of the 12 tests fail against the
  pre-fix code (`ba16bf3`), not all 12.** Method: `packages/headquarter` at `ba16bf3` was
  extracted with `git archive` into a scratch directory (no checkout), the suite as committed
  at `6849f87` was copied in, and the assertions on the then-absent additive field
  `acceptanceStanding` were neutralised (pure field assertions deleted, the key stripped from
  `toMatchObject` shapes) so that only behavioural claims were measured — run raw, all 12 fail,
  but 9 of them only on `expected undefined to be 'standing'`, i.e. the field's absence. With
  that noise removed, 11 fail on their substantive claim (`'accepted'` where `'claimed'`/
  `'verified'`/`'observed'` is now derived, a refusal expected where the pre-fix code answered
  `ok`, `byState.accepted: 1`, the analyst allowed to supersede once-verified truth; the
  history-based-tier test fails on its `state` assertion before reaching `establishedTruthTier`,
  which did not exist pre-fix and so cannot be evaluated there). The twelfth — *"a standing
  acceptance still deduplicates for its acceptor and conflicts for another — including after a
  contest resolved in its favour"* — PASSES against the pre-fix code on its substantive claim:
  it is a deliberate non-regression pin of behaviour the correction preserved (dedupe/conflict
  while the acceptance stands), not a regression pin. The earlier wording of this paragraph
  said "every behavioural assertion … failed"; that was an overstatement. The message of commit
  `9bb44c6` carries the same overstatement and cannot be corrected — history is not rewritten —
  so this document is the correction of record. The two supersession-authority pins were
  additionally run against a naive state-based gate and failed there (the analyst allowed
  through) before passing against the history-based one.

## Independent review round 3 — accuracy corrections (head `6849f87` → this head)

An independent review of head `6849f87` returned PASS (0 Critical / 0 High / 0 Medium) on the
round 3 correction and three Low **accuracy** defects — no behavioural bug. All three are
corrected here; no source line under `src/` changed, and nothing in Phase 8, the three recorded
Low residuals, or the accepted Phase 1–6 code was touched.

- **Low 1 — a false mechanical claim in this document.** The current-standing rule said a
  contest was "by construction never simultaneous with the other two (a refuted or superseded
  record is `out` of every contradiction)". False for the refuted case: `standingOf` sets
  `refuted` only for a verification summary of exactly `refuted`, so a record with summary
  `contested` (confirmed AND refuted) is not out and `judgeContradiction` still returns
  `unresolved` against a live rival. Reproduced through the facade before rewording (claim →
  confirm → accept → refute → live rival contradicts): `{state: 'claimed', verification:
  'contested', contested: true, lifecycle: 'current', acceptanceStanding:
  'verification_refuted', acceptanceDigest: null}`. **Correction:** the sentence now states
  what the rule does — the preconditions can break together, the ladder is basis-first and
  names the first broken one, `superseded` and `contested` genuinely never co-occur (a
  superseded record IS out), and nothing is hidden because the view, the console chip, the
  accept ladder and the snapshot all still carry the contest beside the named standing.
- **Low 2 — a test named for that false property, with a vacuous supporting assertion.** The
  pure-ladder test in `truth-acceptance-standing` ended "…and a contest is by construction never
  simultaneous with either", supported only by `contested === false` on records `A` and `B` —
  vacuous, since neither appeared in any `contradicts` relation. **Correction:** RENAMED to
  what its body proves (verification_refuted before superseded; a superseded record is out of
  every contradiction, so superseded and contested never co-occur); the vacuous loop is
  REPLACED by a genuine one — a live record `F` now contradicts the superseded `A` and `B`, and
  the test asserts each contradiction resolves `resolved_by_supersession` with `contested:
  false` on both and on `F`; and ONE test ADDED through the facade pinning the co-occurrence:
  `verification: 'contested'` with `contested: true`, `state: 'claimed'` (born state),
  `lifecycle: 'current'`, `acceptanceStanding: 'verification_refuted'`, `acceptanceDigest:
  null`, the `contradictions[]` entry `unresolved`, the rival contested, the list filter and
  entity headline agreeing, re-acceptance refused `truth_not_verified` with the standing in
  `details`, and the snapshot at `byState.accepted: 0` / `unresolvedContradictions: 1`. Suite
  count 12 → 13. The added test was run against `ba16bf3` by the same method and fails there on
  its `state` assertion (`'accepted'` where `'claimed'` is derived), so the measured pre-fix
  result after this correction is 12 of 13, with the same single preserved-behaviour pass. No
  test deleted or relaxed; every prior assertion in the renamed test stands.
- **Low 3 — an overstated evidence claim.** The round 3 entry said every behavioural assertion
  in the new suite failed pre-fix; independently re-measured at 11 of 12 (method and the
  preserved-behaviour exception recorded in the round 3 entry above). Corrected in place; the
  `9bb44c6` commit message keeps the overstatement and this document is the correction of
  record.
