# Phase 10 — Chief of Staff + Company Command Center

Built on `9c82956` (Phase 9 plus its correction pass) as the second half of the Phase 9 + 10
wave on branch `cloud/phase-9-10-collaboration-chief-of-staff`. One document for the phase,
in the Phase 5+6 / Phase 7 / Phase 8 / Phase 9 style.

**Provenance of the code.** A partial, never-compiled Phase 10 existed on
`cloud/phase-10-wip-fable-interrupted` (`26616f6`) from an interrupted builder, and the
Founder authorised salvaging it. What was carried over, what was corrected and what was
written fresh is recorded in "Salvage ledger" near the end — nothing from that branch was
merged wholesale, and everything kept was read line by line and is owned here.

## What Phase 10 is

The Founder gets ONE truthful, DERIVED command layer over canonical company state: what
needs them, what is blocked, what changed, what is verified, what is unknown, and what HQ
can safely do next — with the recommendations that answer the inbox and the department
projections beside them. Module `src/application/chief-of-staff.ts` owns the vocabulary
(categorical only), the one capability trio, the append-only brief-ledger schema, the
idempotency/digest derivations and the PURE derivation core; `HeadquarterOperations` owns
the fact-gathering (`#commandFacts`, `#collaborationFacts`, `#dispatchLaneFacts`,
`#canonicalWatermark`, `#changedSince`, `#briefLedgerState`), every read
(`founderInbox`, `founderBriefing`, `commandCenterSummary`, `listBriefs`, `getBrief`,
`briefStorePresent`) and the ONE write (`issueBrief`).

### What the Chief of Staff deliberately is NOT

- **Not a superuser.** It reads, coordinates and recommends under EXISTING authority. The
  only grant it introduces is `hq.founder_brief`, and that grant unlocks exactly one act:
  writing a receipt row. Pinned: a principal holding `hq.founder_brief` and nothing else
  still cannot approve a task, transition a mission or open a collaboration session.
- **Not a second authority store.** The Founder Inbox, the briefing, the recommendations
  and the department projections are derived at READ time from `hq_missions`,
  `hq_mission_plan_items`, `op_tasks`, `hq_op_task_meta`, `hq_approvals`, `op_kill_switch`,
  the truth graph, the action ledger, the collaboration record, the evidence chain, the
  registries, `hq_memory`, `hq_projects`, `op_capabilities` and `hq_orchestration_runs`.
  Every attention item REFERENCES the canonical row it came from (`source: { table, id }`)
  and copies no authority. Nothing here stores an item: assembling the whole briefing
  writes not one row, and no table exists that could hold one (both pinned).
- **Not an executor.** A recommendation carries `executable: false`, names the EXISTING
  gated act and the authority that act passes, and has no path to execution. There is no
  route and no facade method that accepts a recommendation id (pinned three ways: the
  route table contains no such path and a probe of one 404s; the facade surface contains
  no method whose name mentions a recommendation; and the named act still refuses an
  unauthorised caller while the recommendation sits on screen).
- **Not a scorer.** There is no priority number, score, confidence, ETA, percentage,
  urgency or weight anywhere. Items are GROUPED by attention kind in the vocabulary's
  stated order and, within a kind, listed oldest canonical timestamp first — a display
  grouping, stated in the document itself (`ordering`), pinned to sort by exactly the
  vocabulary order, and checked by a wire test that no such field name exists.
- **Not a notification channel.** The brief ledger records that a brief was issued (by
  whom, when, over which canonical watermarks, with which categorical counts and a content
  digest). No timer issues one; nothing is sent anywhere; there is no email, webhook,
  schedule or channel in this phase.

## The model

### The Founder Inbox — a derived attention queue

Nine attention kinds, in the order the inbox groups them: `approval`, `review`,
`contradiction`, `blocked`, `risk`, `external_action`, `incident`, `decision`,
`stale_mission`. Twenty-one reasons name the PREDICATE that put an item there; each is a
fact about a canonical row and none is a judgement. Every kind and every reason is
genuinely reachable — pinned by a fact set that reaches all of them, so no vocabulary
entry claims a rule the code does not have.

An item exists exactly while its source predicate holds and vanishes the moment the source
is decided elsewhere. Pinned end-to-end against real canonical machinery: decide the
approval and the `approval` item is gone; review the task and `review_pending` is gone;
supersede one side and `contradiction_unresolved` is gone; accept the record and
`truth_awaiting_acceptance` is gone; release the switch and `kill_switch_engaged` is gone;
make the Founder assignment and `handoff_requested` is gone.

**One predicate is recorded here because the obvious one is wrong.** HQ writes an
`hq_approvals` row when a decision is MADE — `approveTask` and `denyTask` each insert one —
not when one is requested. A task waiting on the Founder therefore has NO approval row at
all, and a derivation over `hq_approvals.decision = 'pending'` (which the interrupted draft
used) would have shown an empty inbox over a queue full of held work. The canonical
"this needs the Founder" fact is `op_tasks.status = 'needs_approval'`, and that is what
`task_awaiting_approval` reads. The one predicate that does read `hq_approvals` is
`approval_expired_unconsumed`: `decision = 'approved'` AND `consumed_at IS NULL` AND
`expires_at < now` AND the task is not completed — rows `approveTask` genuinely writes.

### The six questions

| Question | Section | What it is |
|---|---|---|
| WHAT NEEDS ME? | `needsMe` | the ordered inbox, bounded to `INBOX_READ_LIMIT` (50), with per-kind counts over exactly the readable set |
| WHAT IS BLOCKED? | `blocked` | blocked missions; blocked / review-failed tasks; tasks held at the Founder gate; engaged kill switches; plans the orchestrator cannot act on |
| WHAT CHANGED? | `changed` | canonical rows appended after the last issued brief's watermark — or an explicit statement that no brief exists so this is NOT a delta |
| WHAT IS VERIFIED? | `verified` | current records deriving `verified` or `accepted` now, with the verifier's stated limitations verbatim; superseded records EXCLUDED and counted |
| WHAT IS UNKNOWN? | `unknown` | unconfirmed task outcomes, unreconciled external attempts, dispatch attempts with no terminal, missions with no stated acceptance criteria, inconclusive verifications, claims citing no evidence, active workers with no declared provider, and the stores this handle does not carry |
| WHAT CAN HQ SAFELY DO NEXT? | `safeNext` | the read/record acts available now under an existing gate, plus queued tasks a registered worker could claim |

Each section is bounded to `BRIEFING_SECTION_LIMIT` (20) with the true total stated beside
it, and `total` is always the size of the set that was enumerated (pinned arithmetically).

**Staleness is stated, never resolved.** A fact whose canonical subject moved is MARKED
(`current | stale | not_evaluated`) and is never reordered by that mark. A superseded truth
record is excluded from "verified" and the exclusion is counted. An expired-unconsumed
approval is `stale`. A `working` mission with nothing in motion is `stale`. A kill switch
is `not_evaluated`, because HQ cannot tell whether the cause of a stop is resolved.

**Missing provenance is shown as missing.** A current record citing no evidence is listed
under WHAT IS UNKNOWN ("Claims citing no evidence — missing provenance, shown as missing")
and, if it also derives verified, carries `provenanceMissing: true` in the verified list.

**`safe` and `blockers` never disagree.** `SafeAct.safe` is exactly
`blockers.length === 0` for every act (pinned as an invariant). Facts about a DIFFERENT act
live in their own field: an orchestration PREVIEW is a pure read that nothing gates, and
what `apply` would refuse on today — a blocked mission, an engaged global or spec-scope
kill switch, an unregistered or disabled orchestrate capability — is listed in
`applyWouldRefuse`. The interrupted draft put those strings in `blockers` beside
`safe: true`, so the record contradicted itself in adjacent fields.

### Recommendations

One per readable inbox item, derived and never persisted. Each states its source facts
(table, id and the predicate text), the affected canonical entities, a rationale naming the
predicate, the limitations of acting on it, the required authority, and `actPath` — the
EXISTING gated act, for the reader. `executable: false`, and structurally so: the record
has eleven fields, none of them a token, callback or payload (pinned by exact key set).

Recommendations are derived from the items the READER may see, not from the full set:
deriving them from everything would hand back a withheld item's summary through the
recommendation's own `summary` field.

### The brief ledger

`hq_briefs` — one row per issued brief, INSERT-only BY ENGINE using the full §G trigger set
(no UPDATE, no DELETE, a BEFORE INSERT guard on `id`/`seq` AND the secondary unique index
`idempotency_key`, so REPLACE/UPSERT is closed on every conflict target for every writer).
`seq INTEGER PRIMARY KEY AUTOINCREMENT`, so the implicit rowid IS `seq`. Pinned:
UPDATE throws, DELETE throws, and `INSERT OR REPLACE` throws on the id conflict AND on the
idempotency-key conflict, with the row unchanged.

A row is a RECEIPT — `id`, `issued_by`, `issued_at`, `event_seq`, `evidence_seq`,
`content_digest`, `counts`, `idempotency_key`, `seq`, and nothing else (pinned by exact
column set). It stores no attention item, no recommendation and no document body, so a
stale receipt can never be mistaken for current truth; the digest lets a later reader check
a re-derivation against what was issued.

**The watermark deliberately excludes the ledger's own audit rows.** Issuing a brief
appends one `hq_events` row and one `op_evidence` entry, as every write in HQ does. If
those counted, the watermark would move on every issue — so a second brief could never
deduplicate — and "what changed since the last brief" would report the last brief. Neither
is true of the COMPANY record. The exclusion is exact (events matched against the ledger's
own ids, evidence against the single kind `issueBrief` appends), it is stated in the
section's own note, and when the ledger is absent the predicate degenerates to "every row"
rather than referencing a table that does not exist.

**What `changed` reads, stated because the halves differ.** The `events` list is the
`hq_events` activity log, which does NOT carry every canonical write — mission lifecycle
events live in `hq_mission_events` and task transitions in `op_tasks`. The
`evidenceByKind` counts are the hash-chained `op_evidence` log, which does. Both facts are
in the section's `note`, and pinned: a mission transition moves the evidence half and not
the events half; a truth record moves both.

### Department projections

Development, Ops, Cybersecurity, Research, Product, Finance, Business, Memory and AI
Workforce are PROJECTIONS over canonical truth — never their own stores. Each states its
`basis` (`canonical` or `not_recorded`), the canonical tables it counted, its metrics, the
number of inbox items touching it (the SAME items, grouped, never re-scored), and a note.

Research, Product and Finance are `not_recorded` with no metrics and an explicit reason:
HQ records tasks rather than task classes; no product-assembly capability is registered;
and HQ records no cost, spend, token usage, budget or invoice at all — a finance figure
would be fabricated, and the wire guard refuses those field names outright. Business is
`canonical` only when the project register exists on the handle and `not_recorded`
otherwise ("absence is stated, not read as zero").

Cybersecurity's refusal count is over an ENUMERATED list of fourteen `op_evidence` kinds
(`REFUSAL_EVIDENCE_KINDS`), not a substring search, and `op_evidence` is append-only so
"all time" is exact.

## Authority rules (the enforcement-safe path)

- **One capability trio**, CONFIGURATION-vs-INVOCATION exactly as mission / truth / memory
  / collaboration: `hq.founder_brief` (`founder_gate`, `sideEffect: false`,
  `idempotent: true`). Registration is a separate act (`registerFounderBriefCapability`,
  and the `hq:workforce` CLI's fail-closed `REGISTRABLE` list); invocation fails closed on
  missing / altered / disabled through the DATABASE row (`#capabilityFromStore`, never
  `queue.capabilities`), and detection never repairs. Pinned: unregistered →
  `unknown_capability` and the row is still absent afterwards; disabled →
  `capability_disabled`; drifted → `not_permitted`; a forged `queue.capabilities.get`/
  `.list` reporting the reserved contract opens nothing.
- **READING the command layer takes no capability.** The two GET routes sit behind the
  Founder gate exactly as the Mission Room does. Pinned: a Founder with no brief grant
  reads the whole briefing, and the session advertises no read control (there is none).
- `issueBrief` resolves through `#resolveFounderGateActor` — an active HUMAN principal
  holding the grant. Workers, `system` and unknown ids are refused (`not_permitted`,
  `not_permitted`, `unknown_principal`), and a human without the grant is refused.
- **Every deciding read is a canonical row through `#db` or an enforcement closure.** See
  the patchable-read audit below. Pinned by hostile same-realm patches on the INSTANCE and
  the PROTOTYPE, each with the lie proven to have taken on the public surface it forged
  (including for a facade constructed AFTER the patch).
- The write is ONE IMMEDIATE reserve transaction: the watermark, the dedupe read, the
  briefing, the counts, the digest, the row, the `hq_events` audit entry and the
  `op_evidence` entry (`founder_brief_issued`, `executable: false`) commit together. The
  receipt therefore describes one instant of the canonical record rather than several.
- Derived idempotency key (`founder-brief:<sha256 prefix>`) over the actor, the watermarks
  and the caller's `idempotencyKey` — the client key is an INPUT to the digest, never the
  key. Pinned: the same Founder over the same canonical position deduplicates; a different
  client key over the same position is a different brief; a moved record is a new brief; a
  different actor is a different brief.
- **Kill switch:** brief writes stay OPEN (the memory/truth intake-parity rule) — a
  receipt is a record, executes nothing, and recording what the company held is exactly
  what an emergency stop must not erase. The engaged stop appears in the brief as an
  `incident` item and in `blocked.killSwitches`, and it closes `claimableTasks`. Pinned.

## What is canonical vs projection

| Canonical (unchanged, never rewritten by this phase) | Phase 10 |
|---|---|
| `hq_missions` lifecycle, intents, plan items; `op_tasks`, claims, fences, leases; `hq_op_task_meta`; `hq_approvals`; `op_kill_switch`; `hq_specialists`; `op_worker_providers`; `hq_ai_members`; `hq_human_principals`; `op_capabilities`; `hq_orchestration_runs` | read only |
| `op_evidence` hash chain, `hq_truth_*` (Phase 7), `hq_action_*` (Phase 8), `hq_collab_*` (Phase 9), `hq_memory` (Phase 5), `hq_projects` (Phase 4) | read only; referenced, never copied |
| — | `hq_briefs`: INSERT-only BY ENGINE. Derived and stored nowhere: every attention item, every recommendation, every section of the briefing, the department projections and the snapshot section |

Migration safety: `hq_briefs` is `CREATE TABLE IF NOT EXISTS`, ensured by `ensureBriefSchema`
from the constructor (readonly-safe, the post-Phase-3 pattern). No existing table or column
changes; no `HQ_SNAPSHOT_VERSION` bump (the snapshot section is optional and additive); a
read-only pre-Phase-10 file reports `briefStorePresent() === false`, empty
`listBriefs()`, `getBrief()` null, refuses `issueBrief`, lists `briefs` under
`unknown.storesAbsent`, carries the blocker on `issue_founder_brief`, STILL answers every
derived question from the stores it does have, and is never migrated (all pinned).

## The patchable-read audit for what this phase touched

| Read | Where | Decides | Reads through | Status |
|---|---|---|---|---|
| truth records + their privacy | `#commandFacts` (the truth section, the verified/unknown sections, the acceptance and contradiction items) | WHICH records reach the reader, including the UNAUTHENTICATED snapshot artifact, and the `withheld` accounting beside them | `#deriveAllTruth(loadTruthGraph(#db))` — the private derivation; privacy filtered on the DERIVED row | canonical. Pinned: a patch that wraps the real `listTruth` and relabels `privacy` on the real rows lies on the public surface (proven, instance and prototype) and moves nothing here — the founder_only record stays out of the artifact, `withheldFounderOnly` stays 1, and the statement text never appears |
| contradictions | `#commandFacts` | whether a `contradiction` item exists and whether it is founder_only | `listContradictions(graph, id => #deriveAllTruth(...).get(id))` over the same private graph | canonical. Pinned: a forged `listTruthContradictions` returning a ghost pair invents no item and hides no real one |
| mission status, plan items, dependencies | `#commandFacts` | whether a mission is blocked / stale / ready, and whether a dependency is terminal | `#missionRecord` → `readMissionRecord(#db, …)`; dependency status through `#missionStatusFromStore` | canonical. Pinned: a forged `getMission` reporting `complete` leaves `mission_blocked` standing |
| capability rows | `#commandFacts` (spec availability), `#founderBriefCapabilityGate` | what `apply` would refuse; whether a brief may be issued | `#capabilityFromStore` → `op_capabilities` | canonical. Pinned for both |
| kill switches | `#commandFacts` (spec scopes), and the engaged-scope list | what `apply` would refuse; which tasks are claimable; the incident items | `#killSwitchEngagedFromStore` → `op_kill_switch`; the engaged list read straight off `#db` | canonical. Pinned: forged `queue.killSwitchEngaged` changes nothing |
| worker registration, assignability, grant, policy | `#commandFacts` (`eligibleWorkers`) | which queued tasks are listed as claimable and by whom | `#workerEligibilityFor` → `#grantOf`, `#workers.assignability`, `evaluatePolicy`, `#capabilityFromStore` | canonical (the same predicates `claimNext` enforces) |
| provider / model binding | `#commandFacts` (workers) | which workers are listed as having no declared provider | `#workerBindingFromStore` → `op_worker_providers` + `hq_ai_members` rows via `#db` | canonical. Pinned: forged `listAiMembers` / `workerProviderDeclarations` change no unknown and no department metric |
| task rows, titles, approvals, evidence kinds, projects, memory, runs | `#commandFacts` | every remaining count and summary | direct `#db` reads (`op_tasks`, `hq_op_task_meta`, `hq_approvals`, `op_evidence`, `hq_projects`, `hq_missions`, `hq_orchestration_runs`); memory through the `#private` `MemoryStore` | canonical. Pinned: a forged `readMeta` cannot rewrite what an item says; a forged `queue.evidence.list` cannot change the refusal count |
| collaboration sessions / stances / handoffs, and each session's `privacy` | `#collaborationFacts` | the `disagreement_open` and `handoff_requested` items, the collaboration bundle-read acts, and WHETHER any of them reach an unauthenticated reader | the Phase 9 module loaders over `#db`, plus `#missionStatusFromStore` for standing; `row.privacy` copied onto the session AND onto every disagreement and handoff derived from it | canonical. **Corrected (M1):** the first cut read no `privacy` at all and hard-coded `founderOnly: false` on both items, so a `founder_only` room's id, both worker ids, the disputing worker's role, the mission and the canonical task were narrated on `hq-snapshot.json` while the Phase 9 section two keys earlier correctly withheld the room. Pinned by a whole-document assertion plus direct Phase 10 regressions on both sides of the gate |
| dispatch lane | `#dispatchLaneFacts` | whether a dispatch outcome is unknown | `op_evidence` rows via `#db`, the SAME rule `#claudeDispatchState` enforces | canonical |
| `this.readMeta(taskId)` inside `#contributionContext.taskStateOf` | the handoff item's canonical picture | whether a handoff was already honoured canonically | public prototype method (the pre-existing Phase 9 display read) | **deliberately left, and recorded as a known limitation** — see below |

## Privacy: the one place this phase crosses to an unauthenticated reader

The snapshot section is published on `hq-snapshot.json`, so the reading layer's disclosure
decision is made exactly as `truthSummary` and `collaborationSummary` make it, and defaults
to the LESS disclosing answer:

- an attention item derived from FOUNDER-PRIVATE MATERIAL is not carried, and **no
  other number aggregates over it** — `attention.total`, `attention.byKind` and
  `recommendations.total` all span only the readable set, so arithmetic on the artifact
  discloses no categorical fact about a private record. The omission is counted in
  `attention.withheldFounderOnly` and stated in the section's provenance note;
- **"Founder-private material" is TWO canonical classifications, not one** (M1
  correction). `InboxAttentionItem.founderOnly` is set from `hq_truth_records.privacy`
  for a truth item AND from `hq_collab_sessions.privacy` for a `handoff_requested` or
  `disagreement_open` item — the Phase 9 L5 classification. The first cut honoured only
  the first, so a `founder_only` war room's existence, participants, roles and activity
  were published on `hq-snapshot.json` by this section while the Phase 9 section beside
  it correctly withheld the room. One flag was widened rather than a parallel
  `privateSource` added, deliberately: every reading layer already honours `founderOnly`,
  and a second flag would need each layer to remember to honour it — the exact failure
  this correction exists to close. `deriveSafeNext`'s collaboration bundle-read acts
  honour the same rule, even though that section is not on the artifact today;
- **the Founder's free-text kill-switch `reason` is NOT composed into the
  `kill_switch_engaged` item summary** (deliberate decision, this correction). An inbox
  item rides the unauthenticated artifact, and the pre-existing artifact kill-switch
  surface (`operations.killSwitch`) publishes engaged scopes only and never the reason —
  Phase 10 must not be the thing that puts Founder-written incident text there. The item
  states categorically whether a reason was recorded ("A reason is recorded" / "No reason
  was recorded"); the verbatim text and `engaged_by` are carried on the Founder-gated
  briefing's `blocked.killSwitches`, unchanged. Pinned on both sides. Note the honest
  limit of this decision: mission titles, mission `block_reason` and task `block_reason`
  DO ride the artifact through other item summaries, and did before this phase (task
  block reasons are on the pre-existing `console` section). The kill-switch reason is the
  one place where the artifact had an established "scopes only" rule to keep;
- the same rule applies to `unknown`: an unknown entry naming a founder_only record is
  withheld, kept out of `unknown.total`, counted in `unknown.withheldFounderOnly` and
  stated;
- the department projections and the recommendation BODIES are deliberately not on the
  artifact at all — the section carries six keys (`attention`, `blocked`, `briefs`,
  `recommendations`, `storePresent`, `unknown`) and nothing else (pinned by exact key set);
- the Founder-gated `/state` route — the same `includeFounderOnlyMemory` flag that carries
  founder_only memory, truth and collaboration sessions — carries all of it, and then
  states nothing withheld.

The Founder-gated `GET /api/hq/control/command-center` carries founder_only-derived
material by design, exactly as `GET /truth` does. Pinned on both sides.

### The other two sections on the same file (corrected here)

`hq-snapshot.json` carries three sections that each decide an unauthenticated disclosure,
and all three must derive from the private canonical read, not from a public prototype
method a same-realm patch can wrap:

- `collaborationSummary` (Phase 9) read `this.listCollaborationSessions()` — L1. A
  wrapping patch that relabelled `privacy` on the real rows published a genuine
  `founder_only` room's title and participants AND zeroed `withheldFounderOnly` beside
  it. Now `loadCollaborationSessions(#db)` + the private `#sessionView`.
- `truthSummary` (Phase 7, accepted base code, unchanged by this wave's feature diff)
  read `this.listTruth()` and `this.listTruthContradictions()` — the same shape, and the
  same leak was reproduced at this head. Now the private
  `#deriveAllTruth(loadTruthGraph(#db))` and `listContradictions` over that same graph.
  Fixed here as directly-adjacent carry-forward debt, deliberately kept to the derivation
  lines: `listTruth()` / `listTruthContradictions()` themselves are unchanged and remain
  the Founder-gated routes' projections.

Both are pinned by hostile same-realm patches on the INSTANCE and the PROTOTYPE, each
proving the lie took on the public surface first and that the published section did not
move.

## Surfaces

Routes (the unchanged pipeline — origin/content-type, identity scan of body AND query,
Founder resolution, `safe()`; route table 32→35, write surface 22→23, both pins updated
deliberately):

```
GET  /api/hq/control/command-center        the whole derived briefing (the six questions, the
                                           recommendations, the departments, the ledger state)
GET  /api/hq/control/command-center/inbox  the Founder Inbox alone, for a light poll
POST /api/hq/control/command-center/brief  issue ONE brief receipt (201 / 200 deduplicated);
                                           requestedBy is the mapped principal, never a body field
```

There is deliberately NO route that accepts a recommendation, and no facade method behind
one either. There is no route to read a single brief: `getBrief` exists on the facade and
the briefing already carries the latest receipt with the ledger total.

Snapshot: an OPTIONAL `commandCenter` section (`CommandCenterSnapshotView`), optional by
shape for the truth section's reason — a static site build opens no store and states
nothing rather than an invented zero section. No `HQ_SNAPSHOT_VERSION` bump. The section's
provenance note states the derivation, the privacy omissions with their counts, the bound
when the list is truncated, and the absence of the ledger when there is none.

Rooms (server-side `hydrate.ts`, present-only): the **Command Room** gains exactly ONE
metric — `Needs the Founder` — and one row per carried attention item, each naming the
canonical table and id it exists because of and the authority that resolves it. Only that
one metric was added deliberately: the section's other totals (recorded unknowns, the
blocked aggregate, the brief ledger) span workforce and provenance facts that are not
"what HQ is holding here", and a metric this room counts but cannot explain with a row is
the exact defect the room's own empty-message comments were written about. An attention
item lights `attention` and always brings a row, so the room can never be lit with nothing
to show. The room's `binding.source` names the section.

UI: index.html gains the Chief of Staff console (`commandCenterConsoleScript`): a mount and
a note in static markup, everything else script-created after a real `/session` grant,
textContent-only. It renders the whole briefing — the inbox with each item's source row,
predicate, authority, timestamp and staleness; the five blocked lists; the changed delta
with its own note; the verified records with their stated limitations, subject drift and
missing-provenance flag; the seven unknown lists and the absent stores; the safe acts with
what `apply` would refuse; the recommendations as records stating `executable: false`; and
all nine departments with their basis. The "Issue brief receipt" button is drawn only under
a granted `founderBrief`. Fetch heads / postJson targets / path literals are allow-listed in
`control-console.test.ts` (pins updated); grant JS gains the one flag.

## What is NOT here (deliberately)

No notification channel of any kind — no timer, daemon, schedule, email, webhook or push.
No route or method that accepts a recommendation. No auto-resolution: nothing here decides
an approval, resolves a contradiction, reconciles an outcome, releases a stop, assigns a
task or moves a mission. No priority, score, confidence, ETA, percentage or rank. No
per-department store: a department with no canonical source renders as one with no
canonical source. No natural-language summarisation — every string is composed from
canonical fields by stated code. No brief-detail route. No editing or reclassifying a
receipt (the ledger is append-only by engine). No cost, spend or token figure anywhere.

## Known limitations (honest)

- **`changed.events` is narrower than "everything that changed".** `hq_events` is HQ's
  activity log and does not carry mission lifecycle events or task transitions; the
  evidence half does. Both facts are stated in the section's note and pinned, but a reader
  who looks only at the events list will see less than happened. A comprehensive
  event-level delta would need a canonical change log that HQ does not have.
- **The handoff item's canonical picture still reads `this.readMeta`.** That is the Phase 9
  display read, recorded there as deliberately left; it decides only whether an already-
  honoured handoff is dropped from the inbox. Stated precisely (the earlier wording
  "the patcher's own display" was wrong for the published path, and `#commandFacts`'s own
  code comment claimed no public read at all — both corrected, L2): a same-realm patch of
  `readMeta` reporting the handoff as already assigned REMOVES a real `handoff_requested`
  item from the derived inbox **and from the unauthenticated `hq-snapshot.json` built by
  that process** (1 → 0). It can only remove, never invent; it changes no claim, fence or
  assignment, and `assignTaskAsFounder` reads the canonical rows. Recorded rather than
  fixed, because fixing it belongs in the Phase 9 module it lives in. This is the ONE
  public, patchable read left in `#commandFacts`; every other fact is read privately.
- **The brief receipt's counts on the artifact ARE Founder-audience counts.** `issueBrief`
  assembles the briefing with `includeFounderOnly: true` — a receipt the Founder signs
  states what the Founder can see — and `briefs.latest` rides the unauthenticated
  artifact. So `briefs.latest.counts.attention.total` / `.byKind` DO span material the
  live section beside them withholds. The disclosure stops at the count: no id, statement,
  session id, room title, worker id or summary of a withheld item crosses, and the live
  section already publishes `attention.withheldFounderOnly` by design. Left rather than
  redacted, because projecting the receipt would make its `contentDigest` uncheckable
  against a re-derivation, which is the receipt's whole purpose. Stated here and pinned by
  a test that asserts exactly this and no more.
- **The department projections are a judgement, stated as code.** Which canonical tables
  each department counts, and which departments are `not_recorded`, is a reviewed edit
  rather than configuration. The Founder may want a different split; every metric is a
  count over a named table regardless.
- **`#commandFacts` scans the whole record in memory** per read — the truth graph, the
  action ledger, every task, every specialist's eligibility. Fine at HQ scale (the Phase 7
  / 8 / 9 note); a large ledger would want indexed derivation. `founderInbox`,
  `founderBriefing` and `commandCenterSummary` each gather the facts once, so a page that
  calls two of them scans twice.
- **`eligibleWorkers` is an evidence-free eligibility read.** It is the same directory /
  assignability / policy predicate `claimNext` enforces, but a claim also revalidates
  fences, leases, approvals and kill switches at claim time. A task listed as claimable is
  therefore "no worker is excluded by the directory or the policy", not a promise the next
  claim succeeds.
- **`approval_pending` over `hq_approvals` does not exist as a predicate**, because no
  production path writes a `decision = 'pending'` row (the store's `requestApproval` method
  is uncalled in `src/`). If a future phase starts writing them, a second approval predicate
  will be needed; today the inbox would not see one.
- **The content digest covers the briefing the FOUNDER audience sees**, at the instant the
  receipt was written. A later re-derivation matches only if the canonical record has not
  moved — which is the point of the watermark beside it, but means the digest is a
  check against re-derivation, not a portable proof.
- **Nothing here has been exercised by a real AI worker lane.** As with Phase 9, every
  canonical act in these suites is performed by a test acting as the Founder or as a
  registered worker.

## Deliberate pin ledger

Route table 32→35 (`live-control-api`, test renamed "thirty-five entries", three sorted
paths added), write surface 22→23 (`live-mission-routes`, plus one `toContain` and two
`not.toContain` lines), `control-console` fetch-head allow-list (+`COMMAND_CENTER_PATH`),
postJson allow-list renamed "the twenty-three write routes" (+`BRIEF_PATH`), and two
`*_PATH` binding pins for index.html. The `hq:workforce` CLI's fail-closed `REGISTRABLE`
list gained one id (its existing "refuses an id outside the trio" pin is unchanged and
still refuses `infra.drop_index`). `CONTROL_GRANT_JS` gained one flag (`founderBrief`);
`CONTROL_FETCH_TARGETS` gained three paths. The Command Room's `binding.source` text was
extended (no test pinned the exact string).

**One existing pin was UPDATED to the new, correct behaviour — none deleted or relaxed.**
`client-state-route`'s "never tells the Command Room it is empty while approvals are
pending" asserted `command.rows` had length 0, recording the gap its own empty message was
written to paper over: the room counted the held task and showed nothing for it. It now
asserts one row, that the row's id is the derived `approval:task_awaiting_approval:` item,
that its secondary text names `op_tasks`, and that the new metric reads 1 — four assertions
where there was one, and every original assertion (the metric, the liveness, the empty
message's wording) kept verbatim.

No `counts` pin, no `ROOM_SECTIONS` change, no `HQ_SNAPSHOT_VERSION` bump, no change to
`CLAIM_BOUND_EVIDENCE_KINDS` or the dispatch evidence kinds, no change under
`packages/server`.

## Deployment runbook (configuration acts, never automatic)

1. `hq:workforce --local-admin --register-capability hq.founder_brief` — the id joins the
   CLI's fail-closed `REGISTRABLE` list in this phase (pinned in `workforce-cli`).
2. Grant `hq.founder_brief` in the Founder principal's `originateCapabilities`.

Until both acts happen, `issueBrief` fails closed (`unknown_capability` / `not_permitted`)
and the console draws no button. READING the command centre needs neither act — only the
Founder gate the other read routes already carry.

(Carried forward, still unfixed and still recorded: the accepted Phase 7 runbook names
`hq:workforce --register-capability hq.truth_record` / `hq.truth_verify`, but the CLI's
list has never contained them, so those two remain registrable only through the module
functions from a trusted composition root. Phase 10 did not fix it — the two ids belong to
the Phase 7 module and the fix is that phase's to own.)

## Salvage ledger

What came from `cloud/phase-10-wip-fable-interrupted` (`26616f6`), and what did not:

**Kept, after reading every line:** the vocabulary shape and most of its prose, the
capability trio and its drift/state helpers, the `hq_briefs` DDL and trigger set, the
loaders and `briefView`, `briefIdempotencyKey` / `contentDigest`, the `CommandFacts`
interface, the bulk of `deriveFounderInbox`'s predicates, `deriveBlocked`,
`deriveVerified`, `deriveUnknown`, `deriveSafeNext`, `deriveChanged`,
`deriveDepartments`, `deriveRecommendations`, `orderAttentionItems`, `countByKind`,
`bounded`, `briefCountsOf` and the view interfaces.

**Corrected, because it was wrong:**

1. `approval_pending` read `hq_approvals.decision = 'pending'`, a row no production path
   writes — the inbox would have been blind to every task held at the Founder gate.
   Replaced by `task_awaiting_approval` over `op_tasks.status = 'needs_approval'`, and
   `BlockedView.heldForApproval` reshaped to stop naming an approval id it never has.
2. Truth and contradiction subjects of kind `memory` were relabelled as `truth`, publishing
   a memory id under the wrong kind. Fixed with a total `truthSubjectRef` mapping and
   `memory` added to `EntityRefKind`.
3. `SafeAct` put apply-time blockers in `blockers` beside `safe: true`, contradicting
   itself. Split into `blockers` (this act) and `applyWouldRefuse` (the follow-on act),
   with `safe === (blockers.length === 0)` pinned as an invariant.
4. No section filtered `founder_only` material, so the snapshot section would have
   published private records and aggregated over them. Added `SectionOptions`,
   `withheldFounderOnly` on the verified and unknown sections, `readableItems`, and the
   assembly functions that keep every count spanning the readable set.
5. `REQUIRED_AUTHORITIES` carried `truth_verify` and `worker_claim`, which no derivation
   reaches, and `truthRefStaleness` was exported and never used. Removed, and a
   vocabulary-reachability suite added so it cannot recur.
6. `deriveDepartments` was handed the BOUNDED inbox page, so a department's attention count
   would have been a page size rather than a set size. Fixed.
7. The draft's `service.ts` delta imported symbols that did not exist yet
   (`assembleBriefing`, `INBOX_ORDERING_STATEMENT` used as a value, `MissionFact` unused)
   and called `listOrchestrationRuns(db)` with one argument, which does not compile.

**Written fresh (nothing existed on that branch):** the whole facade — `#commandFacts`,
`#collaborationFacts`, `#dispatchLaneFacts`, `#canonicalWatermark`, `#changedSince`,
`#briefLedgerState`, `founderInbox`, `founderBriefing`, `commandCenterSummary`,
`listBriefs`, `getBrief`, `briefStorePresent`, `issueBrief`, `#founderBriefCapabilityGate`
— plus the brief-row watermark exclusion, the assembly layer (`assembleFounderInbox`,
`assembleBriefing`, `assembleCommandCenterSnapshot`, `blockedTotalOf`,
`COMMAND_CENTER_PROVENANCE`), `REFUSAL_EVIDENCE_KINDS`, `SOURCE_TABLES` as a value, all
three routes, the session control flag, the snapshot section, the hydrate/rooms wiring, the
console, the CLI registration, this document and every test.

**Not merged:** the branch's copy of Phase 9, which predates the correction pass.

## Evidence

New suites (all in `packages/headquarter/test/`): `chief-of-staff-core` (46: every
attention predicate and its disappearance when the fact changes; ordering as a grouping;
superseded-excluded; staleness marks; missing provenance; the unknown list and absent
stores; the founder_only partition across inbox / verified / unknown / recommendations /
snapshot; the recommendation's exact key set and inertness; `safe === blockers.length === 0`
for every act; the apply/blocker split; the changed-delta note in both branches; the
department projections including `not_recorded`; no fabricated key anywhere; every total
the size of its set; bounds; the brief key and digest; and the four
vocabulary-reachability pins), `command-center-authority` (30: the inbox derived and never
stored against real canonical machinery, with six sources decided through their own gates
and the item disappearing each time; the recommendation with no path to an act and no
method that takes one; the brief gate failing closed on worker / `system` / unknown /
ungranted / unregistered / disabled / drifted / forged-queue; the receipt's exact stored
shape; dedupe over an unmoved canonical position; the changed delta after a receipt;
engine immutability on both unique indexes; the grant unlocking nothing else; the dispatch
lane folded by the same sticky rule the gateway enforces, under a live claim; and SEVEN
hostile-patch regressions — `listTruth` relabel, `listTruthContradictions` ghost,
`getMission`, kill switch + capabilities, `listAiMembers` + `workerProviderDeclarations`,
`readMeta`, `queue.evidence.list` — each with the lie proven to have taken),
`command-center-durability` (3: a real file closed and reopened answering identically with
receipts and digests intact and refusals unchanged; the next brief's delta measured from
the previous process's receipt; a read-only pre-Phase-10 file observing absence, refusing
to issue, still deriving every question, and not being migrated),
`live-command-center-routes` (21: the write surface; no recommendation route under any
method; the briefing's section set and that it writes nothing; no fabricated field on the
wire; every item traceable; founder_only carried past the gate; the inbox agreeing with
the briefing; the receipt attributed to the mapped principal with 201/200; identity in the
body refused; no idempotency key on the wire; non-Founder / staff / nobody refused on all
three routes; mutations-off; one status per capability cause; the session control
advertised from the deciding conditions and withdrawn when either fails; the kill-switch
behaviour on both sides; the query scan; and the inbox losing an item after the approval
route decides it), `command-center-surfaces` (11: the optional section absent from a
store-less build; the counts, bounds and both wire guards; no fabricated-metric key;
founder_only withheld from the artifact with nothing aggregating over it and both omissions
stated; the unknown half of the same rule; the section carrying no department and no
recommendation body; the Command Room's one metric, its rows, its liveness, its stated
binding, its dark case, and every other room untouched), and `command-center-console` (9,
JSDOM against the real control API: inert static markup; the live briefing with each item
naming its canonical row and all six questions and nine departments drawn; a recommendation
drawn as a record with no control on it; a `not_recorded` department; a real receipt issued
from the page; the control absent without the grant and absent with a disabled row; a
non-Founder session off; and missing provenance shown as missing). Plus `workforce-cli`
(+1: the trio registrable with its reserved contract, and drift reported rather than
repaired) and hq-host `host-contract` (+3: the Fastify-wired briefing/inbox/receipt arc
with dedupe and a forged body refused; the ungranted Founder refused on the write while the
reads answer; the NO_IDENTITY sweep of all three routes).

Full-matrix results are recorded in the builder's report and the wave PR; merge stays gated
on independent review and the Founder.
