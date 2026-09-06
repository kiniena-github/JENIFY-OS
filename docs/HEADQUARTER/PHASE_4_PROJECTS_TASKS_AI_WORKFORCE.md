# Phase 4 — Projects + Tasks + Dynamic AI Workforce

Issue #262 (Founder-approved local handoff; this lane is the sole Phase 4 integrator). Built
on accepted main `c3a907a` (the Phase 3 merge). This document is the canonical description of
what Phase 4 added, what it deliberately did not, and where every rule is enforced.

## What Phase 4 is

Phase 3 gave HQ a real durable Mission. Phase 4 gives that mission a truthful working
structure — MISSION → PROJECTS → REAL TASKS → APPROPRIATE AI WORKERS — without becoming the
Phase 6 autonomous orchestrator. Everything added is either a canonical record the Founder
commands, an explicit Founder-gated act, or an ADVISORY computation whose advice grants
nothing.

## The canonical Project register

`hq_projects` — the orphaned foundation-wave table nothing in production ever wrote — was
ADOPTED as THE canonical project table rather than shadowed by a second one. It is owned by
`src/application/project-command.ts` from Phase 4 on: module-owned additive column upgrades
(`created_by`, `status_changed_at/by`, `idempotency_key` + partial UNIQUE), the append-only
`hq_project_events` history (born with the complete §G trigger set), and the only write paths
(the Founder-gated facade). The store's ungated `upsertProject` was DELETED in the same
change; `test/headquarter.test.ts` pins that no project method grows back on the store.

- **Two states, deliberately: `active ⇄ closed`** (`contracts/project.ts`), notes mandatory
  in both directions, `closed` not terminal (a register entry, not history — reopening
  forges nothing because the event log records both moves). Absent states are
  anti-fabrication decisions: no `planned` (a record existing IS the declaration), no
  `completed`/`failed` (completion is mission/task truth; a project status claiming it would
  be a fabricated progress claim), no `blocked`/`paused` (blockage is mission/task truth).
- **Authority**: `hq.project_command` (founder_gate, sideEffect false, idempotent) with the
  full CONFIGURATION-vs-INVOCATION trio. Commanding requires an active HUMAN principal
  holding the originate grant; workers and `system` are refused outright.
- **Idempotent creation** on a derived sha256 digest (client key an input, never the key);
  dedupe inside the same IMMEDIATE transaction as the insert.
- **`updateProject` is an audited register edit, not a history rewrite**: closed entries
  refuse (reopen first), a no-change update writes nothing (an event claiming a change that
  did not happen would forge history), and the event records exactly which fields changed.
  `Project` deliberately does NOT join the facade mutation-scan suffix group — the reasoning
  is recorded at the pin in `test/application.security.test.ts`.
- **Legacy wart, stated**: the adopted `stream` column is NOT NULL; an unstated stream is
  stored as `''` and read back as `null` via the single `encodeStream`/`decodeStream` pair,
  test-pinned. A 12-step table rebuild was judged more dangerous than a documented encoding.
  The update route carries the tri-state across the wire (correction pass): absent =
  unchanged, `null` = clear, string = set; a non-string non-null refuses rather than being
  silently coerced into "not supplied".
- **Derived truth only**: `missions[]` (the canonical relationship) and `taskCounts[]`
  (counts of DISTINCT canonical tasks by `ActivityStatus` across linked plan items — one
  real task linked to two plan items counts ONCE (Sol M2), and counts are never a share or
  percentage) are computed at read time and never stored.

## The linkage truth table

| Field | What it is | Authority |
|---|---|---|
| `hq_missions.project_id` | The canonical mission → project relationship. Validated at the facade (project must exist and be `active`). | THE relationship truth |
| `hq_missions.project` | Free-text console LABEL on the order | A label, never matched against the register |
| `hq_op_task_meta.project` | Free-text console LABEL on a task | A label, never authority |
| `hq_mission_plan_items.task_id` | Write-once link to a real `op_tasks` row (now engine-enforced write-once) | THE mission → task bridge |

Project → task is derived exclusively through `project_id → missions → plan items →
task_id`. No string matching between labels and register names exists anywhere. The UI words
the two claims apart: `project: <name>` (canonical) vs `label: <text>`.

`commandMission` accepts an optional `projectId`; the idempotency digest gains the field
ONLY when stated, so byte-identical Phase 3 re-commands keep deduping onto their stored keys
(pinned by key-equality and behavioral tests). `assignMissionToProject` binds/clears the
relationship under the MISSION gate (it directs a mission), refuses terminal missions and
closed projects, refuses replayed no-op assignments, and records every move in the
append-only mission event log plus the evidence chain. Both writers read the project's
status INSIDE the IMMEDIATE `reserve()` transaction (correction pass, the
`amendMissionIntent` precedent): a concurrent close can no longer land between the
active-project check and the write.

## Tasks — one stored truth, unchanged

`op_tasks` + `ActivityStatus` remain the ONLY stored task state machine. Phase 4 added no
second vocabulary, no queue priority (claiming stays strictly FIFO, test-pinned — a
CRITICAL-priority mission's linked task is claimed in arrival order, proven behaviorally),
and no path that turns a plan item into a task automatically. Creating a real task stays an
explicit gated act through `createTask`/`submitDirectOrder`; the mission console's
"create task via direct order, then link" control is a client-side TWO-STEP over the
unchanged `/orders` route (the plan-item summary only prefills a draft the Founder edits and
owns) followed by the link write, with partial failure reported exactly.

## The Dynamic AI Workforce — advisory, never autonomous

What was WIRED ON in the production host (`hq-host/src/config.ts`):

| Machinery | Wired | Meaning |
|---|---|---|
| `AiMemberRegistry` | ON (lifecycle/display) | Real registrations only; empty registry displays zero; health `unknown` until explicitly declared |
| `declaredOnlyAdapter` over `KNOWN_PROVIDERS` | ON | Vendor catalog knowledge; `probeHealth` answers `'unknown'` always — catalog is not connection evidence |
| `MemberRegistryNominationSource` | ON (advisory) | `rankMembers` over the EXACT operator capability id — no domain mapping, ever; empty until a registrar performs that configuration act |
| `assignTaskAsFounder` / `evaluateTaskEligibility` | ON | Founder-gated advisory assignment + the eligible-worker calculation from enforcement truth |
| `deactivateExecutionWorker` | ON | Founder-gated, narrowing-only, in-flight work protected by `assertReplacementSafe`; NO reactivate method |
| `options.memberRegistry` (capability narrowing) | **OFF — recorded** | The authority migration of issue #182: disjoint vocabularies would empty same-id grants, and the enforcement read would leave its hardened closure. A separate Founder decision. Pinned by the ANTI-EMPTYING regressions at BOTH layers: `hq-host/test/host-contract.test.ts` (Fastify-wired) and `test/workforce-command.test.ts` (service) |
| `hq_ai_member_assignments` task binding | OFF | `hq_op_task_meta.assignment` stays the ONE assignment truth; dual truth would diverge on claim races |
| Seeding members from `KNOWN_PROVIDERS` | NEVER | Fabricated workers |

Assignment is advisory BY CONSTRUCTION: it changes no task status, burns no approval,
dispatches nothing; its one operational effect is narrowing (`claimNext` refuses the head
task to a different worker). Because that is its ONLY effect, the correction pass (Sol M1)
made the write refuse whenever the effect is impossible: a task under a live fenced claim
answers `task_already_claimed` (409) — the same canonical predicate `replacementPlan` uses,
`claimed_by` set AND status in `assigned/running/outcome_unknown` — and a task whose status
can never reach `queued` again (`completed`/`review_passed`, DERIVED from
`ALLOWED_TRANSITIONS` and drift-pinned) answers `task_beyond_claiming` (409). The
eligibility read carries the identical truth (`taskState`, computed by the SAME predicate),
so the browser is never shown an open assignment the write would refuse; the console success
line commits only to narrowing FUTURE claiming. Nomination is advisory BY CONTRACT:
`routeTask` recomputes
`eligible` from the worker directory and policy engine alone; a registry-only nominee reports
`worker_unknown` and `eligible: false` (a registry row enrols nobody). No worker can assign
work, register members, declare health, or otherwise reach any Founder-gated method — worker
identity is refused outright at every one.

`GET /workforce` composes the three truths honestly: enforcement (grants, assignability,
policy outcome with the verbatim deny reason), transport (declared-or-null provider — the
vendor string is never turned into a provider claim — plus routing-contract configuration
truth naming missing FACTS, and three-valued dispatchability: true/false only when genuinely
observed, null otherwise), and member enrichment (identity key, status, declared health).
The transport field is `contractSatisfied`, not `connected` (correction pass): a satisfied
routing contract is a CONFIGURATION fact — "requirements satisfied by configuration;
nothing was probed" — never worded as a live observation; negative reasons (missing facts)
pass through verbatim because a missing requirement genuinely proves non-executability.
Members with no matching execution worker are listed separately as NOT enrolled for
execution.

## Surfaces

Routes (exact-match, deny-by-default, the unchanged pipeline; `CONTROL_ROUTES` 9 → 17
entries, `CONTROL_WRITE_ROUTES` 6 → 13 — the Founder-approved widening recorded in
`docs/JENIFY_DECISIONS.md`):

```
GET  /api/hq/control/projects                 the register, full browser-safe detail
POST /api/hq/control/projects                 create (201 / 200 deduplicated)
POST /api/hq/control/projects/transition      close/reopen, note required
POST /api/hq/control/projects/update          audited register edit
POST /api/hq/control/missions/assign-project  bind/clear the canonical link
POST /api/hq/control/missions/link-plan-item  write-once plan-item → task link
GET  /api/hq/control/workforce                enforcement + transport + member truth
POST /api/hq/control/workforce/route          evaluate eligibility (records evidence)
POST /api/hq/control/workforce/assign         record an ADVISORY assignment intent
```

Session controls gain `projectCommand` and `workforceAssign`, advertised from exactly the
conditions that decide the writes. The internal idempotency key never crosses the boundary.

**Step-up, re-evaluated at Phase 4** (the obligation item 4 of the Phase 3 decision
recorded): none of the new writes takes step-up, and the exemption is RE-AFFIRMED rather
than inherited — Phase 4 still adds no autonomous consumer that can turn mission/project
state into execution. It must be re-evaluated again the moment one exists (Phase ≥ 6, or any
earlier wiring of the mission watchdog). **Kill-switch parity** extends to project writes
AND to the workforce advisory writes (the switch stops execution reachability, never the
recording of Founder direction): an engaged switch leaves `/workforce/assign` open —
recording an advisory intent executes nothing — while claiming keeps refusing
`kill_switch_engaged` at the canonical boundary, so the intent cannot become execution.
Both postures are pinned by named tests; the workforce posture was made explicit in the
correction pass rather than left accidental.

Snapshot: additive `projects` section + `counts.projects` through the shared
`projectBrowserView` (no version bump — the recorded additive policy); `SnapshotWorker`
gains `provider`/`member` enrichment with nulls where the building context genuinely cannot
observe. A read-only pre-Phase-4 file projects the register's ABSENCE with provenance saying
why, never a fake empty register.

UI: the Projects room is REBOUND from the activity-label counter to the canonical register
(the Mission-Room-rebind treatment: decisions entry, `binding.source` prose, the recorded
semantic-change comment at `projectsSection()`); its liveness derives from register missions
by the SAME status sets the Mission Room uses. The AI Workforce room keeps its no-pulse rule
and gains provider/dispatchability/health chips with unknown rendered AS unknown. Three
script-created consoles (register on projects.html, workforce on specialists.html, linkage
controls in the mission console) under the emitted-markup-stays-inert rule, each wiping what
a lost session can no longer prove.

## §G — the append-only REPLACE bypass, closed

The recorded Phase 3 Low was real and verified: SQLite's REPLACE conflict resolution deletes
a colliding row WITHOUT firing BEFORE DELETE triggers while `recursive_triggers` is off (the
engine default, connection-scoped), so `INSERT OR REPLACE` could silently overwrite mission
history — including the immutable intent seq 0 — past the Phase 3 triggers. Phase 4 closed
it at the engine: BEFORE INSERT abort-on-existing guards on `hq_mission_intents` and
`hq_mission_events` fire before conflict resolution and bind every writer and every conflict
clause (REPLACE / INSERT OR REPLACE / UPSERT). The `recursive_triggers` PRAGMA was rejected
as the fix — connection-scoped, it cannot bind a foreign writer. Plan items additionally got
engine-enforced write-once task links and non-replaceable row identity. The src-wide guard
regex was widened to the REPLACE/UPSERT spellings, behavioral tamper regressions attempt all
three shapes, `isMissionSequenceConflict` accepts the trigger's error shape so a raced
amendment stays a typed 409, and every documentation claim now states exactly the engine
guarantee. `hq_project_events` was born with the complete trigger set. The correction pass
widened the guard's TABLE SET to its real blast radius — never-legitimate spellings for
`hq_mission_plan_items` and `hq_project_events` joined the grep, and the test title now
states exactly what it covers; plan-item relink protection stays with the engine trigger
plus the behavioral tamper test (a grep on plain UPDATE would flag the legitimate one-shot
linker).

## Configuration paths

`hq:workforce` (trusted-local-admin, the `hq:order` trust model verbatim) closes the
recorded registration gap: `--register-capability` (fail-closed to exactly
`hq.mission_command` / `hq.project_command` / `hq.workforce_assign`; never enables a
disabled row), `--register-principal` (the stated BOOTSTRAP path — the first principal
cannot be gated on a principal existing; an UPSERT, stated loudly since the correction
pass: re-running an existing id replaces the row wholesale from that invocation's flags,
forces `active` true, and the command reports REPLACED with the previous truth — pinned),
and `--register-member` / `--disable-member` / `--set-member-health` /
`--deactivate-worker` through the ordinary Founder-gated facade.

## What is deliberately NOT here

No Phase 5 (Context + Mission Memory). No Phase 6 (Real Mission Orchestrator). No autonomous
execution of any kind: nothing reads mission or project state to create, claim, order or
dispatch anything. No evidence engine, no external action gateway, no chief of staff. No
queue priority. No worker reactivation path (a widening; a separate recorded act). No
member-registry authority migration (narrowing stays off, pinned). No probed provider
health (mock adapters stay out of production; declared-only answers `unknown`). No
fabricated metric anywhere — `assertNoFabricatedFields` still refuses
cost/tokens/ETA/progress on the wire, and the register shows counts, never percentages.
Zero renders as zero; unknown renders as unknown; unavailable renders as unavailable.

## Evidence

New suites: `application.project-core` (22), `live-project-routes` (11, incl. the named
kill-switch-parity and no-step-up-re-evaluation pins), `live-workforce-routes` (8),
`workforce-command` (20, incl. the service-level anti-emptying proof), `phase4-consoles`
(9, JSDOM against the real control API), `workforce-cli` (7), `project-durability` (2, real
file reopen); mission-core grew the §G tamper/conflict regressions and 6 linkage cases (52);
`host-contract` grew the Fastify-wired Phase 4 surface + ANTI-EMPTYING pin. Deliberate pin
updates: route table 9 → 17, write surface 6 → 13, control-console fetch/postJson audits and
PATH bindings, snapshot/hydration fixtures (+projects source, +worker fields), `/state`
counts (+`projects: 0`). Full-matrix results and the exact frozen SHA are recorded in the
Phase 4 PR; merge remains gated on independent review and the Founder.

**Correction pass** (GPT-5.6 Sol exact-head gate on PR #263 + the Opus Lows, one
consolidated pass): M1 — assignment refuses over a live claim or a queued-unreachable
status, with the shared read/write predicate and the mandate's full regression sequence
(claim by A → assign B refused → claimant/meta/events/evidence unchanged) at service,
route and JSDOM-console level; M2 — `COUNT(DISTINCT t.id)` with the one-task-two-plan-items
pin; plus the eight Lows: transport `contractSatisfied` vocabulary at the workforce
boundary, CLI principal-UPSERT stated and pinned, `stream: null` tri-state at the update
route, the project-close TOCTOU closed inside `reserve()`, the workforce kill-switch
posture pinned, the source-guard table set widened, inactive workers no longer offered in
the assign dropdown (server stays authoritative), and both anti-emptying layers named
here. Deliberately unchanged: the ORDERS-lane `providerConnectivity` wording (a recorded
follow-up, migrating it means migrating that lane's surfaces together), and superseded
plan items retaining their `task_id` in counts (pre-existing linkage semantics, recorded).
