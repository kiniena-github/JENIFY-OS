# JENIFY OS — Founder-Approved Decisions

Append-only. Each entry: date, decision, rationale. Newest last.

- **2026-08-17 — Platform, not app.** Reusable core (typed primitives) + configuration
  packages; Mesob is tenant #1, provisioned through public APIs only. No Mesob literals in core.
- **2026-08-17 — Append-only stock ledger.** Balances always derived; posted documents are
  never hard-deleted or silently edited (cancel/reverse/audited correction only).
- **2026-08-17 — Iodine is not inventory.** Recorded as a batch attribute, not a stock item.
- **2026-08-17 — Payments allocate across multiple invoices**, with explicit visible
  remainder; allocation is always an explicit user action.
- **2026-08-17 — Local-first, sync-ready.** Offline/local deployment, UUIDv7 ids, no cloud
  sync engine yet, no paid external services.
- **2026-08-19 — Stage output policies.** Stages are measured / conserved / converted;
  iodization is CONSERVED (no invented loss); variance only via audited correction.
- **2026-08-19 — Explicit QC release gate.** A passed test alone is not a release; QC result
  and release status are separate concepts. Production Operator, Production Supervisor, and
  Quality Management are separate roles/identities.
- **2026-08-19 — Payment references required** for all non-cash methods; duplicates blocked
  per method. Reversed payments are never allocatable.
- **2026-08-19 — Delete vs archive.** Permanent deletion only for never-used entities
  (warehouses, languages); anything with current dependencies archives. Language eligibility
  is DYNAMIC (clearing translations re-enables deletion). English is protected.
- **2026-08-19 — Branding snapshots.** Issued documents keep their issuance branding
  version; transaction data is immutable regardless.
- **2026-08-19 — Owner recovery without backdoors.** Hashed one-time recovery codes, shown
  once, session-revoking, audited; last active Owner cannot be deactivated/demoted; no
  universal password ever.
- **2026-08-19 — Public rebrand to JENIFY OS.** Tenant identity stays primary ("Mesob Salt
  Factory — Powered by JENIFY OS"); internal `factoryos` identifiers stay for compatibility.
- **2026-08-19 — Simple multi-currency.** Accounting stays in the tenant default currency;
  foreign payments convert once at a configured snapshotted rate. No forex engine.
- **2026-08-19 — Go-live from explicit approved configuration only.** Fresh production
  tenants copy an explicitly approved selection (dry-run preview first); Founder test history
  is NEVER carried to production (Henok gets a clean tenant). Real opening balances enter via
  proper opening documents later.
- **2026-08-21 — Permanent Claude Code team established.** Main session = Team Lead /
  orchestrator; ten project specialists in `.claude/agents/`; one Founder conversation.
- **2026-08-21 — Unified 24-agent structure approved.** Exactly ONE Founder-facing Team
  Lead session; the 10 `jenify-*` agents are the official team; the 14 domain agents remain
  as deeper specialists the Team Lead calls when useful; `lead-architect` is subordinated to
  a deep-integration-reviewer role. No duplicate leadership, no independent milestones, no
  uncoordinated repo edits. All 24 definitions preserved.
- **2026-08-21 — JENIFY AI / QOS is FUTURE PLANNED, not out of scope.** It is a major
  planned part of JENIFY OS; `jenify-ai-qos` stays inactive (design-only) until the Founder
  explicitly starts the AI milestone. Supersedes the earlier "QOS out of scope" framing.
- **2026-08-22 — WAVE 1: GO.** Expanded 24-agent parallel execution mission approved
  (Build / Design / Research / Attack tracks).
- **2026-08-22 — Mobile design target:** ~2 GB RAM Android Go-class low-end phone.
  Performance budgets remain hard constraints (initial JS ≤75 kB gzip unless a future
  Founder-approved architecture decision changes it).
- **2026-08-22 — Offline O2 order:** RECEIVING first; DELIVERY CONFIRMATION second.
  Server stays final authority; no LWW, no silent merges, no fake sync status.
- **2026-08-22 — Language-intelligence k = 5.** A translation variant needs ≥5
  organizations before surfacing in aggregate recommendations; callers can never lower
  the floor.
- **2026-08-22 — Global language authority = Founder only initially.** A dedicated
  JENIFY Platform Language Administrator role comes later; tenant Owners customize their
  own tenant language but never approve global JENIFY translations.
- **2026-08-22 — Translation-learning model KEPT** (freedom → anonymized aggregation →
  consensus → human review → official pack → overrides allowed). Production-scale
  multi-company aggregation requires a clear consent/privacy posture first.
- **2026-08-22 — Automated mobile-viewport regression testing: APPROVED.**
- **2026-08-22 — AI-assisted translation clustering: PLANNED.** AI groups/recommends;
  human approves. Never auto-promote.
- **2026-08-22 — Ethiopia e-invoicing: VERIFY FIRST.** Build extensible integration
  boundaries; no compliance claims or certification-specific behavior from unverified
  research.
- **2026-08-22 — Henok continues separately** (Mesob testing, translation work, usability
  feedback) through a structured intake; his work never blocks platform development.
- **2026-08-27 — Two-actor rule stands; no self-approval exception.** (PR #142, HQ lane F,
  issue #139.) The canonical Operator rule that a requester cannot approve its own action is
  kept exactly as built. In the current one-human setup the Founder is the only human
  required: an AI worker originates/requests a gated action and the Founder approves or
  rejects it. If the Founder personally originates a gated action, the Founder does not
  self-approve that same action. Neither a self-approval exception nor a risk-tiered
  exception is to be added. Human identity is a separate deny-by-default registry
  (`hq_human_principals`) that starts empty and grants nothing until a Founder registers
  someone; originating work and approving work are independent rights, and neither ever
  confers execution.
- **2026-08-27 — Registry ↔ Application capability seam: the Registry may only NARROW.**
  (Issue #174 Mission C; closes the seam PR #172 deliberately left open.) When lane C's
  AI Member Registry is supplied to `HeadquarterOperations`, worker capability reads are
  the INTERSECTION of the operator specialist directory and the Registry's
  granted/effective capabilities — never advertised ones. Where both directories know a
  worker neither can widen the other, so enabling the seam can never grant a capability
  that the pre-integration behaviour would not also have granted; where only one knows
  the worker, that one answers, so existing workers are unaffected and Registry-only
  workers are still governed. Assignability is refused if EITHER source refuses. The
  Operator remains the final capability and risk authority: this layer only supplies the
  allow-list, and `operator/policy.ts` still applies risk, side-effect and approval rules
  on top. The seam is opt-in (`memberRegistry`); with no Registry supplied, behaviour is
  exactly as before.

- **2026-08-28 — HQ browser Founder identity REUSES the existing JENIFY OS login.**
  (Issue #200, Founder decision comment of 2026-08-28.) Headquarter grows no second
  password system. The acting HQ principal for a browser write is derived server-side
  from the existing `fos_session` session (`resolveSessionRecord`, which enforces
  expiry, revocation and account deactivation on every request) plus an EXPLICIT
  configured binding from `(realmId, accountId)` to a registered HQ human principal.
  Nothing is inferred from a username, display name, email, admin role or tenant
  ownership, and a request body that names an actor is REFUSED rather than
  re-attributed. A missing, malformed or ambiguous map, an unregistered or deactivated
  principal, an untrusted `Origin`, or a non-JSON content type all fail closed with no
  mutation. Authentication proves identity ONLY: `HeadquarterOperations`, the principal
  registry's originate grants, `founder_gate` policy, no-self-approval, the action
  digest, provider binding, fencing and the kill switch are unchanged and still decide
  what that identity may do. Approving an irreversible (`founder_gate` / `destructive`)
  action additionally requires step-up — a session under five minutes old, or password
  re-entry through the existing credential boundary. Denial is never step-up-gated.
  The browser write surface is exactly three routes (create order, approve, deny) plus
  two reads; there is no generic mutation endpoint and no "ask for changes", because
  the canonical model records approve or deny only. HQ routes exist only when a host
  passes an explicit control plane to `buildApp`, so an ordinary tenant deployment has
  none of them.

- **2026-09-02 — LIVE HQ CONTROL V1 is Founder-accepted and merged; JENIFY HQ is promoted to a
  first-class Jenify product.** Accepted head `36809306b2620cbc419e1b0a04bd7db05a91aaad`,
  merged to `main` as `197844a8d637622fa08c3bdce02159070965d738`. Acceptance rested on a
  Founder-operated browser proof (issue #230), not on local test claims. Phase 2 is authorised
  as PLANNING ONLY at this point: JENIFY HQ is to be separated from the historical JENIFY-OS
  structure and prepared for `hq.jenifylabs.com`, a future Jenify HQ Desktop, and a core shared
  between web and desktop. No extraction, move, merge or deployment is authorised by this
  entry. The target structure, migration order and the two Founder gates it depends on are set
  out in `docs/HEADQUARTER/PHASE_2_FIRST_CLASS_PRODUCT_PLAN.md`; the repository-boundary
  question (top-level product inside this repo first, versus its own repo immediately) and the
  hosted-identity question are Founder decisions that remain OPEN.

- **2026-09-02 — The official JENIFY HQ visual direction reference is the Drive pack
  `HQ-UI-3D`** (folder `1v8lBLeVtYYgfbegNAAbiUdgiIoKHEf6W`), comprising
  `HQ-UI-3D-REFERENCE-NOTES.md`, four reference videos, nine concept images and eight video
  frame references. Locked direction: premium, serious, futuristic — a real high-end command
  headquarters, not a game; dark architectural base, glass/metal, controlled blue/cyan light,
  strong depth, readable UI. The 3D layer is the experience layer, never decoration that hides
  controls, and real data and controls stay authoritative underneath it. Spaces:
  Home/Lobby, Command Room, Mission Room, Meeting Room, World/Network Map, Department
  Navigation. Worker states rendered in 3D (WORKING, VERIFYING, BLOCKED, WAITING FOR FOUNDER,
  COMPLETE) must represent REAL HQ state — this is binding on any 3D work and is the same
  honesty rule `ui/spatial/state.ts` already enforces (deny by default, every live-looking
  thing carries its evidence, nothing invented). The concept images are visual references, not
  final UI specs.

- **2026-09-05 — Phase 3 (Founder Command + Mission Core, issue #254) widens the HQ browser
  write surface and defines the canonical Mission.** Founder-approved via #254/#255; recorded
  here so nothing about it is silent:
  1. **Write surface.** The browser write surface widens from exactly three routes
     (create order / approve / deny — the 2026-08-28 decision) to additionally
     `POST /api/hq/control/missions` (command), `/missions/transition` and `/missions/amend`.
     This supersedes ONLY the surface-count clause of 2026-08-28; every other clause —
     identity from the server session and Founder map only, fail-closed on a broken map,
     no generic mutation endpoint, no ask-for-changes route — stands and applies to the new
     routes unchanged.
  2. **"Mission" now has a third, authoritative meaning.** The canonical Mission aggregate
     (`hq_missions` + append-only `hq_mission_intents`/`hq_mission_events` +
     `hq_mission_plan_items`) is the command-level record of a Founder order: objective,
     non-negotiable constraints, acceptance criteria (unknown recorded as unknown), priority
     (mission metadata only — the operator queue stays strictly FIFO), plan, blockers and the
     eight lifecycle states of #254. The chat-lane proposal flow (`hq_mission_proposals`) and
     the still-unwired mission watchdog are untouched and remain distinct concepts. The
     Mission Room is deliberately rebound from "open op_tasks rows" to this aggregate; the
     Command Room keeps task truth and gains a mission-decision metric computed from the same
     status set, so the rooms cannot disagree.
  3. **Missions execute nothing in Phase 3.** Commanding, transitioning, amending and linking
     create no task, touch no approval, dispatch nothing and read no worker registry. The
     `verified` state is reachable only as an explicit recorded Founder decision with a
     mandatory note (method vocabulary has no machine member); the two-actor rule of
     2026-08-27 continues to govern execution-granting approvals unchanged — an inert,
     actor-audited state record is not an approval, so single-actor verification is honest
     and displayed as exactly what it is.
  4. **No step-up on mission writes.** Step-up stays bound to what it protects —
     execution-granting approvals. This exemption MUST be revisited the moment any autonomous
     consumer reads mission state (Phase 4+).
  5. **Mission writes are not kill-switch-gated**, in parity with direct-order intake (also
     un-gated): the switch stops execution reachability — claims and approvals — and must not
     stop the Founder from recording direction, including "cancelled", during an emergency
     stop. Pinned by tests whose names state the rationale.
  6. **Raw order isolation.** The raw Founder instruction and every amendment rationale live
     in the server-side intent bodies only; no route response or snapshot carries them. The
     browser sees intake-scanned canonical fields and intent-history metadata.

- **2026-09-05 — Phase 3 Opus second-pass corrections (PR #260, review of `cee771f`) are
  applied on the same canonical branch.** Recorded so none of it is silent:
  1. **Intent-lock visibility (M3).** The browser now sees the STRUCTURED per-sequence intent
     history — seq/kind/actor/at plus objective/constraints/acceptance criteria, all
     intake-scanned canonical fields — so the Founder can audit the immutable original order
     (seq 0) next to every amendment from HQ itself. This supersedes ONLY the "intent-history
     metadata" clause of item 6 above; the raw instruction and every amendment rationale
     remain server-side, and the no-leak scans still pin that.
  2. **Console honesty on authorization loss (M1).** Safe/off clears rendered mission rows by
     construction; a 401/403 on a mission write re-checks the session and re-reads rather
     than guessing — a lost session wipes the record, a lost write grant leaves the readable
     record on screen without controls and without a false "not readable" claim.
  3. **Read-only truth (M2).** Schema init never writes through a read-only database handle;
     `hq:snapshot` over a pre-Phase-3 file projects zero missions with provenance stating the
     store's absence instead of throwing or migrating.
  4. **Append-only by engine (L1).** `hq_mission_intents`/`hq_mission_events` carry
     BEFORE UPDATE/DELETE abort triggers; the source guard now scans all of `src/`.
  5. **Atomic evidence (L5) and closed CAS windows (L4).** Every mission mutation commits its
     rows, its mission event and its `op_evidence` entry in one IMMEDIATE reserve transaction
     (the issue-#224 precedent); amendment sequence reads moved inside it, and a raced
     amendment is a typed 409 (`mission_intent_conflict`), never an opaque 500.
  6. **Digest binds the raw instruction.** Two orders differing only in wording are two
     missions; pre-fix stored digests no longer dedupe against new re-commands (dev-stage
     data, accepted). An invalid mission status filter now matches nothing (fail closed).
  7. **Snapshot bound (L7).** The written snapshot artefact carries the newest
     `SNAPSHOT_MISSION_LIMIT` missions with the TOTAL still in `counts.missions` and the trim
     named in provenance; the live `/state` route stays unbounded on purpose.
  Priority still never touches operator FIFO order (now proven behaviorally, not just by
  grep), and the hosted restart proof now drives the real `commandMission` path.

- **2026-09-05 — Phase 4 (Projects + Tasks + Dynamic AI Workforce, issue #262) widens the HQ
  browser write surface and makes the register, linkage and workforce first-class.**
  Founder-approved via the #262 handoff; recorded here so nothing about it is silent
  (canonical doc: `docs/HEADQUARTER/PHASE_4_PROJECTS_TASKS_AI_WORKFORCE.md`):
  1. **Write surface.** The browser write surface widens from six routes to additionally
     `POST /api/hq/control/projects` (+ `/transition`, `/update`),
     `/missions/assign-project`, `/missions/link-plan-item`, `/workforce/route` and
     `/workforce/assign` (thirteen total; route table seventeen). This supersedes ONLY the
     surface-count clause of the Phase 3 entry; every other clause — identity from the
     server session and Founder map only, fail-closed on a broken map, no generic mutation
     endpoint, no ask-for-changes route — stands and applies to the new routes unchanged.
  2. **`hq_projects` is adopted as THE canonical project register**, owned by
     `application/project-command.ts`; the store's ungated `upsertProject` is deleted and
     its absence pinned. One project system — the alternative was a second table with a
     worse name forever. The lifecycle is deliberately two states (`active ⇄ closed`, notes
     both ways, closed not terminal); absent states are anti-fabrication decisions, the
     reasoning in the contract docstring. The legacy NOT NULL `stream` column keeps a
     documented `''⇔null` encoding rather than a table rebuild.
  3. **One relationship truth.** `hq_missions.project_id` is the canonical mission→project
     link; the free-text `project` labels on missions and task meta stay labels, never
     matched against the register, and the UI words the two claims apart. Project→task is
     derived only through plan-item links. The idempotency digest gains `projectId` only
     when stated, so Phase 3 stored keys keep deduping.
  4. **The Projects room is rebound** from the activity-label counter to the canonical
     register (the Mission-Room-rebind treatment), with liveness computed from register
     missions by the same status sets the Mission Room uses.
  5. **The AI member registry is wired for lifecycle/display/advisory truth only.** The
     capability-narrowing seam (`memberRegistry`, issue #182) stays OFF: the operator and
     member capability vocabularies are disjoint, so narrowing would empty same-id workers'
     grants and move the enforcement read out of its hardened closure. Turning it on is a
     separate, deliberate authority migration — a Founder decision — and the anti-emptying
     regression pins that wiring the lifecycle registry does not flip it. Assignment is
     advisory (narrowing-only at claim); nomination is advisory by contract and maps no
     vocabulary (exact operator capability ids only); no worker reaches any Founder-gated
     method; no member is ever seeded from a vendor catalog; provider health is declared or
     `unknown`, never probed, never fabricated.
  6. **Worker deactivation exists; reactivation deliberately does not.**
     `deactivateExecutionWorker` is Founder-gated and narrowing-only with in-flight work
     protected; turning a worker back on is a widening and stays a separate recorded act.
     Member ids may equal a live worker id (enrichment, reported as such) and may never
     equal a human principal id (the identity-flip guard, refused at registration).
  7. **Step-up re-evaluated at Phase 4, re-affirmed** (the item-4 obligation of the Phase 3
     entry): none of the new writes takes step-up because Phase 4 still adds no autonomous
     consumer that can turn mission/project state into execution — nomination is inert
     without the operator's own verdict, an assignment intent changes no status and burns
     no approval, and nothing reads a mission to create/claim/dispatch anything. To be
     re-evaluated AGAIN the moment such a consumer exists (Phase ≥ 6, or any earlier wiring
     of the mission watchdog). **Kill-switch parity extends to project writes** — the
     switch stops execution reachability, never the recording of Founder direction — pinned
     by named tests.
  8. **The §G hardening is engine truth.** The Phase 3 Low (REPLACE bypassing the
     append-only triggers under default-off `recursive_triggers`) was verified real and
     closed with BEFORE INSERT abort-on-existing triggers that bind every writer and every
     conflict clause; the PRAGMA was rejected as connection-scoped. Plan-item task links are
     write-once at the engine; `hq_project_events` was born with the complete trigger set;
     documentation claims now state exactly the engine guarantee.
  9. **Configuration paths exist without raw writes.** `hq:workforce` (trusted-local-admin,
     the `hq:order` model verbatim) registers the three Founder-gated capabilities
     (fail-closed list), bootstraps principals (stated plainly as the bootstrap path), and
     drives member/worker lifecycle through the ordinary Founder-gated facade.

- **2026-09-06 — Phase 4 correction pass (GPT-5.6 Sol exact-head gate on PR #263 +
  the Opus Lows), one consolidated pass on the same branch.** The two reclassified Mediums
  and the eight Lows, dispositioned (canonical detail: the Correction-pass paragraph of
  `docs/HEADQUARTER/PHASE_4_PROJECTS_TASKS_AI_WORKFORCE.md`):
  1. **Assignment obeys canonical claim truth (M1).** An advisory assignment is allowed
     ONLY while it can genuinely narrow future claiming: a live fenced claim answers
     `task_already_claimed` and a queued-unreachable status (`completed`/`review_passed`,
     derived from `ALLOWED_TRANSITIONS`, drift-pinned) answers `task_beyond_claiming` —
     both 409, both refused before any write, event or evidence. The eligibility read
     carries the identical truth through the same predicate, and the console success line
     commits only to what is guaranteed. No reassignment/claim-transfer machinery was
     built — that stays later scope.
  2. **Project task counts are DISTINCT canonical tasks (M2).** Plan-item linkage stays
     deliberately flexible (no uniqueness on `task_id`); the derived figure changed, not
     the model.
  3. **The eight Lows**: workforce transport says `contractSatisfied` (configuration truth,
     nothing probed; ORDERS-lane wording deliberately untouched — a recorded follow-up);
     the CLI principal path is stated and pinned as an UPSERT that reports REPLACED; the
     update route carries `stream: null` as a real clear; the project-close TOCTOU is
     closed by validating inside the IMMEDIATE `reserve()` transaction (the
     `amendMissionIntent` precedent — no new locking); the workforce kill-switch posture is
     pinned by a named test (advisory writes stay open, claiming stays blocked — the
     switch stops execution, not direction); the append-only source guard covers its real
     table set; the assign dropdown offers only active workers (the server stays
     authoritative); and both anti-emptying regression layers are named in the canonical
     doc. Issue #182 narrowing stays OFF.

- **2026-09-06 — Wave 1: Phase 5 (Context + Mission Memory) + Phase 6 (Real Mission
  Orchestrator), issue #265.** Founder-approved via the #265 handoff; recorded here so
  nothing about it is silent (canonical doc:
  `docs/HEADQUARTER/PHASE_5_6_CONTEXT_MEMORY_AND_ORCHESTRATOR.md`):
  1. **Write surface.** The browser write surface widens from thirteen routes to fifteen
     (`POST /api/hq/control/memory` — record/supersede — and
     `POST /api/hq/control/missions/orchestrate`, mode preview|apply); the route table
     grows 17 → 21 with the three memory reads (list, search, context). This supersedes
     ONLY the surface-count clause of the Phase 4 entry; every other clause — identity
     from the server session and Founder map only, fail-closed on a broken map, no generic
     mutation endpoint — stands and applies to the new routes unchanged. ONE boundary
     widening rides along: `ControlRequest` gains an optional identity-scanned `query`
     map (a `?principalId=` attempt is refused exactly like a body actor).
  2. **The step-up re-evaluation owed at "Phase ≥ 6" is RESOLVED as a demand.**
     Orchestrate-APPLY is the first act that turns stored mission state into
     execution-reachable tasks, in bulk, so it takes step-up with the approve-route
     mechanics verbatim (canonical registry row via `capabilityRowFor`, fresh-session
     pass, stale session demands the JENIFY OS password). PREVIEW is a pure read and
     takes none. Memory writes stay exempt (append-only knowledge, reversible by
     supersede). All other recorded exemptions stand unchanged.
  3. **Kill-switch posture.** Orchestrate-apply refuses WHOLESALE under a global or
     orchestrate-scope engagement — an orchestrated `queued` task would sit primed to run
     on release (the approveTask precedent) — and per-item under a spec-capability scope.
     Preview stays available (reading is not reachability) and reports the switch.
     Memory writes are not kill-switch-gated (intake parity: recording direction
     survives an emergency stop). All pinned by named tests.
  4. **One memory truth.** The issue-#120 module is WIRED, never duplicated: additive
     kinds (founder_note, source_material, summary — a summary must name real sources and
     never touches them), canonical entity refs (mission/project/task, validated to
     exist; the free-text `project` column stays a label), insert-only BY ENGINE (content
     UPDATEs and DELETEs abort; status moves only CURRENT→SUPERSEDED; the §G
     BEFORE INSERT guard closes REPLACE/UPSERT), and the one Founder-gated write path
     under the new `hq.memory_command` trio. `founder_only` privacy is enforced at the
     reading layers: the Founder-gated routes carry those rows, the unauthenticated
     snapshot artifact excludes them (count-only disclosure, stated in provenance), and
     handover packages now exclude them too — a package is consumed by a successor
     WORKER (a real pre-existing gap, closed and pinned).
  5. **Context is read-time composition, never storage**, relationship-scoped with a
     one-hop related walk, bounded with honest totals, provenance on every element, and
     deterministic ($0 — the existing archive search engine; no embeddings, no external
     calls). No gate anywhere reads hq_memory; a hostile record claiming grants changes
     no verdict (pinned against a memory-free control run). Room 14 Company Memory is
     rebound later_phase → live on the new `memory` section; its purpose text drops
     "Ask Jenify" honestly — the NL layer remains a later, Founder-gated milestone.
  6. **Task creation stays specified, never inferred.** A plan item becomes a canonical
     task ONLY from its explicit write-once Founder work spec (capability id +
     canonical-JSON payload, stated at command time or via
     `amendMissionIntent.specifyPlanItems`, recorded verbatim in the append-only intent
     body, payload server-side only). Phase 3's no-parsing law stands; unspec'd items are
     truthfully not actionable; commanding with specs still creates no task; the mission
     idempotency digest gains specs only when stated so stored keys keep deduping.
  7. **The orchestrator holds no new authority.** It creates and links through the
     existing gated facades only (derived idempotency keys → the queue's own dedupe +
     the engine's write-once link = rerun/crash-safe); approves nothing (orchestrated
     tasks are created BY the Founder, so approval-gated specs need a SECOND
     approval-authority principal — the canonical self-approval rule, stated in the
     doc); claims, dispatches and transitions nothing (readiness is a categorical
     RECOMMENDATION); records no Wave-1 assignment intent (no canonical assignment-rule
     store exists — inventing one would be new decision authority); writes nothing into
     hq_memory (run records `hq_orchestration_runs`/`_run_items` are INSERT-only derived
     audit, and nothing reads them to decide); and never touches `outcome_unknown` (it
     stays unknown). Mission priority still never reorders operator FIFO — proven
     behaviorally again at the orchestrated boundary.
  8. **Accepted Phase 4 Low debt, dispositioned.** #1 hostile-rejection blocked+claimant:
     pinned at the orchestration boundary (reported verbatim, execution-inert, never
     duplicated). #2 `dispatchable` terminology and #3 ORDERS-lane `connected` wording:
     untouched (neither lane was migrated this wave — recorded follow-ups stand).
     #4 superseded plan items retaining task links: preserved. #5 member↔operator
     vocabulary bridge: stays OFF. #6 worker reactivation: still deliberately absent.
  9. **Not automated, deliberately.** No daemon/timer/schedule (the mission watchdog
     stays unwired; its wiring-truth pin is untouched); no mission lifecycle automation;
     no Phase 7+ machinery (no evidence-engine replacement, external action gateway,
     risk engine, multi-AI room, or chief of staff). Capability registration remains an
     explicit `hq:workforce` configuration act; invocation fails closed until it happens.
