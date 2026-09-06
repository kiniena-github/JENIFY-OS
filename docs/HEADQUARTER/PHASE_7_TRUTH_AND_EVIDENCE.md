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
  same acceptor deduplicates, a different one conflicts. Acceptance executes nothing — no task
  status, approval row, claim, dispatch or kill switch moves (pinned).
- **Supersession** is an explicit, attributed act with a unique successor per predecessor (a
  second "supersession" is a contradiction and must be recorded as one). The predecessor row
  never changes; its lifecycle is derived from the immutable forward pointer and it stays in
  the entity's history with its verifications intact. Superseding a `verified` or `accepted`
  record takes the Founder gate (`#assertApprovalAuthority`) — a worker's fresh claim cannot
  displace established truth from "current". A superseded record can be neither verified nor
  accepted (`truth_conflict`).

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
| `op_evidence` hash chain — evidence truth; truth entries only APPEND to it and reference ids | `hq_truth_records` (born state + refs + stated pointers), `hq_truth_relations`, `hq_truth_verifications`, `hq_truth_acceptances` — all INSERT-only BY ENGINE (full §G trigger set: no UPDATE of any column, no DELETE, REPLACE/UPSERT closed) |
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
withheld founder_only count, newest `TRUTH_SNAPSHOT_LIMIT`=20 records, unresolved pairs).
Optional by shape on purpose — a static build opens no truth store and states nothing rather
than an invented zero, every pre-Phase-7 fixture stays valid, and no `counts` pin moved. The
Founder-gated `/state` carries founder_only rows; the unauthenticated artifact withholds them,
withholds contradictions touching them, keeps them in the totals and says so in provenance
(pinned, including that the private statement text never appears). A read-only pre-Phase-7
file projects absence with provenance saying why; no `HQ_SNAPSHOT_VERSION` bump (additive).

Rooms (server-side `hydrate.ts`, counts only, present-only when the section exists): **Security
Center** gains a `Truth contradictions` condition metric and one attention row per unresolved
contradiction ("neither side is preferred by recency"); **Founder Office** gains
`Verified, awaiting acceptance` (exactly the records the server issued a digest for — the
count and the acceptable set cannot disagree) and `Founder-accepted`, both waiting-at-the-gate
liveness; **Company Memory** gains `Truth records / Verified / Accepted` beside memory. Room
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

## Deliberate pin ledger

Route table 21→25 (`live-control-api`), write surface 15→18 (`live-mission-routes`), console
fetch heads (+`TRUTH_PATH`, `TRUTH_ENTITY_PATH`) and postJson targets (+`TRUTH_PATH`,
`TRUTH_VERIFY_PATH`, `TRUTH_ACCEPT_PATH`) with the "eighteen write routes" wording
(`control-console`), `CONTROL_FETCH_TARGETS` (+4), room `binding.source` texts for
security-center / founder-office / company-memory, `CONTROL_GRANT_JS` (+3 flags). No test was
deleted or relaxed; no `counts` pin, no `ROOM_SECTIONS` change, no `HQ_SNAPSHOT_VERSION` bump.

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
(20: no newest-wins incl. verified-but-contested, timestamp-blind judgement, evidence/relation
existence, engine immutability on all four tables incl. REPLACE/UPSERT, op_evidence chain
grows only, src-wide rewrite-spelling guard, superseded auditability and Founder-tier
supersession, categorical staleness, memory-never-grants incl. memory-as-evidence refusal and
founder_only inheritance, no-second-evidence-store canonical-inertness, pure reads,
hostile-patch ×3), `truth-durability` (2: real file reopen with identical derivation and
identical refusals; read-only pre-Phase-7 absence), `live-truth-routes` (14: write surface,
attribution/dedupe, birth-state refusal, the arc through the routes, STEP-UP on accept only,
one status per cause, hostile callers, identity in body and query, mutations-off, secret-like
content, 404 sub-routes, founder_only through the gate and withheld from the artifact, entity
route, control advertisement incl. withdrawal on a disabled row), `truth-surfaces` (5: optional
section absence, derived states + both wire guards + no fabricated key, Security/Founder rooms,
Company Memory counts, dark zero), `truth-console` (6, JSDOM against the real control API:
inert static markup, forms only under grants, record from the page, contradiction-first +
limitations + step-up refusal then acceptance with password, entity lookup, non-Founder off +
hostile text inert), hq-host `host-contract` (+2: Fastify-wired record/entity/query-scan/
self-verify/accept-refusal arc, NO_IDENTITY sweep of all five truth routes). Full-matrix results
are recorded in the wave PR; merge stays gated on independent review and the Founder.
