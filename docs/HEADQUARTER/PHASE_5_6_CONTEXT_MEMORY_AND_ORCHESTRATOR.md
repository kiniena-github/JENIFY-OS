# Phase 5 + 6 — Context + Mission Memory, and the Real Mission Orchestrator

Issue #265 (Founder-approved combined Wave 1; this lane is the sole main integrator). Built
on accepted main `ccaaa21` (the Phase 4 merge). ONE canonical document for the wave —
a deliberate departure from the one-doc-per-phase precedent, because the two phases ship as
one PR and share one boundary contract that would otherwise be duplicated or orphaned. The
phases stay internally separate below.

## PHASE 5 — Context + Mission Memory

### What memory is

The issue-#120 Company Memory module (`src/memory/`, table `hq_memory`) — previously
complete, tested and constructed NOWHERE in src/ — is Phase 5's one memory truth. Nothing
was duplicated: the ArchiveStatus/DateConfidence/RelatedRefs vocabulary, the supersede
chains, the duplicate-CURRENT guard, the secret refusal and the archive search engine all
carry over unchanged. Phase 5 wired it, hardened it, and gave it entity truth:

- **Additive kinds**: `founder_note`, `source_material`, `summary`. Observed system facts
  keep using `evidence_note`; a summary is a NEW record that must name real sources in
  `derivedFrom` and never touches the originals. A summary is not automatically a fact; a
  retrieval result never silently becomes canonical truth (test-pinned).
- **Canonical entity refs**: nullable `mission_id` / `project_id` / `task_id`, validated to
  EXIST at the facade (after the authority gates — no existence oracle). The free-text
  `project` column stays a LABEL, never matched against the register (the Phase 4 wording).
- **Insert-only BY ENGINE**: DELETE aborts; UPDATE of any content column aborts
  (`trg_hq_memory_no_rewrite` — everything except status/superseded_by/updated_at, exactly
  the legitimate supersede UPDATE's column set); status may only move CURRENT→SUPERSEDED;
  the §G BEFORE INSERT guard closes the REPLACE/UPSERT path. Documented residual:
  `superseded_by`/`updated_at` stay engine-mutable for the supersede write; the immutable
  forward pointer (`supersedes` on the successor) keeps chains reconstructable regardless.
  The src-wide append-only source guard gains hq_memory's never-legitimate spellings.
- **The one write path**: `recordMemory` — bounds/vocabulary → `hq.memory_command` actor +
  trio gates (fail closed, drift never repaired) → entity existence → secret scan → derived
  idempotency-key dedupe → ONE IMMEDIATE transaction (insert + hq_events audit +
  op_evidence `memory_recorded`, atomically). A record cannot be born SUPERSEDED — history
  is earned by a successor. Memory writes are exempt from step-up (append-only knowledge,
  reversible by supersede) and not kill-switch-gated (recording direction survives an
  emergency stop — the intake parity rule).

### What context is

Read-time composition, never storage: `getMissionContext` / `getProjectContext` /
`getTaskContext` assemble the entity's EXISTING browser projection plus entity-linked
memory in deterministic groups (mission → task → project → one-hop related via
derivation/supersession), CURRENT-first then newest-first, bounded (20/group) with the true
total stated, every element carrying live provenance naming what was read. Unrelated
company memory NEVER enters an entity's context (the no-global-dump pin); text search is a
separate explicit act over the existing archive engine ($0, deterministic — no embeddings,
no external calls). Assembly writes nothing and changes no canonical truth (row-count and
re-read pins). A task context's canonical element is a minimal ref — never the payload.

### Surfaces

Routes (the unchanged pipeline; the write surface widened 13→15 across the wave, route
table 17→21 — recorded in `docs/JENIFY_DECISIONS.md`):

```
GET/POST /api/hq/control/memory           list (founder_only INCLUDED — this gate IS the
                                          privacy-enforcing reading layer) / record-supersede
GET  /api/hq/control/memory/search        deterministic search, bounded, honest total
GET  /api/hq/control/memory/context       scope=mission|project|task&id=<entity id>
POST /api/hq/control/missions/orchestrate Phase 6 (below)
```

The ONE boundary widening: `ControlRequest` gains an optional `query` map, parsed by the
host (first value wins) and identity-scanned exactly like the body — a `?principalId=`
attempt is refused, never ignored (host-contract-pinned).

Snapshot: a required `memory` section + `counts.memory` (= ALL rows, always). The
Founder-gated `/state` route carries every record (`includeFounderOnlyMemory: true`); the
unauthenticated `hq:snapshot` artifact excludes founder_only rows with the exclusion counted
and stated in provenance, bounds carried rows to `SNAPSHOT_MEMORY_LIMIT`, and a pre-Phase-5
read-only file projects absence with provenance saying why. No `HQ_SNAPSHOT_VERSION` bump
(the recorded additive policy). Handover packages now EXCLUDE founder_only memory — a
package is consumed by a successor worker, and the Founder-gated surface is the reading
layer for those rows (a real pre-existing gap, closed and pinned).

UI: room 14 **Company Memory** rebound `later_phase` → `live` on the new `memory`
RoomSection; its purpose text drops the earlier "Ask Jenify" phrasing honestly (the
natural-language layer remains a later, Founder-gated milestone — what exists is the
durable record). `memorySection` renders provenance-first metrics/rows with PRESENT-ONLY
liveness (memory never demands a human, never animates; zero renders dark). archive.html
gains the live memory console: founder-gated record cards with full provenance, a local
deterministic filter, and a record form drawn only under a granted `memoryCommand`.

### What is NOT memory truth

Model inferences, summaries-as-facts, invented confidence numbers (the wire format refuses
`confidenceScore`/`progressPercent` shapes), demo memory, and anything a gate could read:
no eligibility, approval, capability, kill-switch or enforcement path consults hq_memory —
proven by the seam suite's hostile-record test.

## PHASE 6 — Real Mission Orchestrator

### Authority model

`hq.mission_orchestrate` (founder_gate, the full CONFIGURATION-vs-INVOCATION trio; CLI
registration via `hq:workforce --register-capability`). One route, POST
`missions/orchestrate`, mode `'preview' | 'apply'`:

- **Preview** is a pure read: it observes canonical state, classifies every plan item
  through the deterministic decision core, and writes NOTHING — no task, no run record, no
  evidence (eligibility is read through the SAME directory/policy predicates enforcement
  uses, evidence-free). Available on any non-terminal mission, including under an engaged
  kill switch (reading is not reachability), which it reports truthfully.
- **Apply** demands the orchestrate gate AND the mission gate (linking directs the
  mission), orchestrates only `planned`/`working` missions (`blocked` records a Founder
  stop; `ready_review`/`verified` are past building), refuses WHOLESALE under a global or
  orchestrate-scope kill switch (an orchestrated `queued` task would sit primed — the
  approveTask precedent) and per-item under a spec-capability scope, refuses a stale
  preview fingerprint (409), and **takes STEP-UP** — see the decisions entry: this is the
  recorded Phase ≥ 6 re-evaluation, resolved as a demand.

### The cycle

Inside ONE IMMEDIATE transaction, re-observed under the write lock: for each actionable
item — work-kind, unsuperseded, unlinked, Founder-spec'd, capability registered+enabled,
originate grant held, scope switch off — `createTask` through THE approved origination path
(payload VERBATIM from the stored spec; policy decides queued vs needs_approval exactly as
for a manual order; derived idempotency key → the queue's own dedupe), then the write-once
`linkMissionPlanItem`. Run items land per decision; the run row lands LAST with its
categorical summary; one `orchestrated` mission event and one `mission_orchestrated`
evidence entry commit atomically with the acts. Rerun/crash-safe by construction: an
in-cycle crash rolls the whole transaction back; a rerun observes linked items verbatim and
adopts (never duplicates) a task an earlier committed cycle created under the derived key.
Never recursive: the cycle reads mission/plan/task truth and writes tasks/links/runs — it
never reads run records to decide, and nothing orchestrated feeds back as input beyond its
canonical status.

### Task creation truth

Phase 3's law stands: **no text is ever parsed into tasks, capabilities or providers.** A
plan item becomes a task ONLY from its explicit Founder work spec — `spec_capability_id` +
canonical-JSON `spec_payload`, WRITE-ONCE at the engine (the relink-guard recipe), supplied
at `commandMission` (object-form `plan`) or stated on an existing unlinked item via
`amendMissionIntent.specifyPlanItems`, with the full spec recorded verbatim in the
append-only intent body and only capability-id + provenance crossing to the browser (the
raw-order isolation precedent). Changing a stated spec = supersede + re-add. Unspec'd items
are truthfully `not_actionable_unspecified`; commanding with specs still creates no task
(pinned) — a spec is a stated plan, orchestration is the separate act. Spec payloads are
bounded, ≤3 levels deep, and may not carry a reserved identity key at ANY depth (the
facade walk covers what the route scan's depth floor cannot). The mission idempotency
digest gains specs only when stated, so stored Phase 3/4 keys keep deduping (pinned).

### What stays canonical and untouched

`op_tasks` + ActivityStatus remain the ONLY task truth; claiming stays strictly FIFO
(behaviorally pinned: a critical mission's task never jumps an older manual task); the
orchestrator approves nothing (orchestrated tasks are created BY the Founder principal, so
the queue's self-approval rule means a SECOND approval-authority principal decides
approval-gated specs — stated here so it is never a surprise), claims nothing, dispatches
nothing, transitions no mission (readiness is a derived categorical RECOMMENDATION —
`ready_review` when every live work item is linked and complete — that the Founder may act
on), records no assignment intent in Wave 1 (no canonical assignment-rule store exists;
inventing one would be new decision authority — `/workforce/assign` remains the Founder's
advisory tool), writes nothing into hq_memory, and consults the member registry for
nothing. `outcome_unknown` stays unknown — never requeued or retried. The accepted Low #1
posture (hostile-rejection `blocked` with `claimed_by` retained) is reported verbatim,
execution-inert, never duplicated (pinned). The mission watchdog stays UNWIRED
(`MISSION_WATCHDOG_RUNTIME_CONSUMERS` still empty; it is the GitHub-dispatch-lane concept,
not this aggregate) and no `schedule:` trigger exists anywhere.

### Run records

`hq_orchestration_runs` + `hq_orchestration_run_items`: INSERT-only with the full §G
trigger set — derived AUDIT truth (what a cycle observed and did), never a second task or
status truth; nothing reads them to decide anything.

## The P5/P6 boundary contract

1. Memory holds no authority: no gate reads hq_memory; a hostile record claiming grants
   changes no verdict (pinned against a memory-free control run).
2. The orchestrator consumes context read-only; retrieval performs zero writes and repeats
   deterministically.
3. Context informs, never grants: task-creation inputs come from Founder specs + canonical
   registries only.
4. The orchestrator writes NOTHING into memory — orchestration truth lives in its own run
   records (row-count pinned across preview/apply/rerun).
5. Constraints travel from the append-only intent record, never from retrieval; seq 0
   survives every wave operation byte-identical (pinned on a real reopened file).

## What is NOT automated (and deliberately absent)

No daemon, timer, cron or queue drain — a cycle runs when the Founder invokes it. No
mission lifecycle automation. No worker dispatch. No retry/backoff. No Phase 7+ machinery:
no evidence-engine replacement, no external action gateway, no risk engine, no multi-AI
collaboration room, no chief of staff, no self-directed objective creation. No numeric
progress/confidence anywhere — counts and canonical statuses only.

## Deliberate pin ledger (every updated expectation, and why)

Route table 17→21 and write surface 13→15 (`live-control-api`, `live-mission-routes` — the
Founder-approved widening of issue #265); console fetch/postJson allow-lists (+MEMORY_PATH,
+ORCHESTRATE_PATH); the room live-split (+company-memory, non-live shrinks to 3;
`ROOM_SECTIONS` +memory — atomic with the rebind); `/state` counts (+`memory: 0`); snapshot
sources fixtures (+required memory section, ~18 sites); the §G source-guard table set
(+hq_memory never-legitimate spellings with the scoping comment, +run tables via behavioral
tamper tests); `mission-core`'s anti-existence pin EXTENDED ("commanding with specs still
creates no task"); the webgl-evidence fixture row for room 14 (later_phase → live/dark).
NOT touched: `mission-watchdog.wiring-truth`, `project-core`'s no-task-table pin,
`headquarter.test`'s store scan (MemoryStore and the run-record writers stay OFF
HeadquarterStore), `ai-task-trigger.yml` (no schedule).

## Deployment runbook (configuration acts, never automatic)

1. `hq:workforce --local-admin --register-capability hq.memory_command`
2. `hq:workforce --local-admin --register-capability hq.mission_orchestrate`
3. Grant both ids (plus the spec capabilities missions will use) in the Founder principal's
   `originateCapabilities` via `--register-principal`.
Until these acts happen, every invocation fails closed (`unknown_capability` /
`not_permitted`) — registration is not performed by any invocation path.

## Evidence

New suites: memory-command (15), memory-engine-hardening (6), memory-context (9),
memory-durability (1, real file reopen), live-memory-routes (15), memory-console (6, JSDOM
against the real control API), application.orchestrator-core (13), orchestrator-authority
(10), orchestrator-fifo (1, behavioral), orchestrator-command (5), orchestrator-restart
(3, real file reopen), live-orchestrate-route (6, incl. the step-up arc),
orchestration-durability (1, the full §15 arc on a real reopened file),
memory-orchestration-seam (4); handover founder_only pin; hq-host host-contract grew the
Fastify-wired Wave 1 composition + query-scan obligation + NO_IDENTITY sweep. Full-matrix
results and the exact frozen SHA are recorded in the Wave 1 PR; merge remains gated on
independent review (fresh Opus 5 exact-head, then the Sol/Codex gate) and the Founder.
