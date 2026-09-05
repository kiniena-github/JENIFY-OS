# Phase 3 — Founder Command + Mission Core

Issue #254 (Founder-approved; #255 designated the local main-builder lane). Built on accepted
Phase 2 main `9f98723`. This document is the canonical description of what Phase 3 added, what
it deliberately did not, and where every rule is enforced.

## What a Mission is

The command-level aggregate ABOVE tasks: the durable canonical record of a Founder order.

> "Improve the QOS website speed without changing the visual design or deploying production."

becomes one mission holding: title, canonical objective, scope, **non-negotiable constraints**,
acceptance criteria (absent = recorded as an explicit unknown, never defaulted), priority
(mission metadata only), a task plan, dependencies on other missions (advisory in Phase 3),
blockers, lifecycle state, server-derived authority truth, and an append-only intent history
whose seq 0 is the original order, immutable forever.

Phase 3 is NOT the autonomous orchestrator. **Missions execute nothing**: commanding,
transitioning, amending and plan-item linking create no task, touch no approval, dispatch
nothing, read no worker registry, and no runtime consumer reads mission state. Later phases
add consumers; each such addition re-opens the step-up and kill-switch decisions recorded in
`docs/JENIFY_DECISIONS.md` (2026-09-05).

## The three meanings of "mission", reconciled

| Concept | Where | Status |
|---|---|---|
| **Mission (canonical aggregate)** | `src/application/mission-command.ts`, `src/contracts/mission.ts` | THE Phase 3 meaning; authoritative |
| Mission proposal (chat → one task) | `src/application/missions.ts`, `hq_mission_proposals` | untouched, distinct concept |
| Mission watchdog (dispatch decision rules) | `src/application/mission-watchdog.ts` | still UNWIRED (`MISSION_WATCHDOG_RUNTIME_CONSUMERS` empty, policed by its wiring-truth test); wiring remains a Founder decision |

The Mission Room UI was deliberately rebound from "open `op_tasks` rows" to the canonical
aggregate — recorded in the 2026-09-05 decisions entry, the room's `binding.source` prose and
the comment at `missionsSection()` in `src/client/hydrate.ts`. Tasks stay the Command Room's
subject; the one shared quantity (missions needing a decision: `blocked` + `ready_review`) is
computed from the same status set in both rooms.

## Lifecycle

`contracts/mission.ts` — the vocabulary and the structural law:

```
planned      → working | blocked | cancelled
working      → blocked | ready_review | failed | cancelled
blocked      → working | failed | cancelled
ready_review → working | verified | failed | cancelled
verified     → complete | cancelled
complete / failed / cancelled → (terminal)
```

- The map is fixed; later phases widen the set of authorized CALLERS, never the map.
- In Phase 3 every transition is Founder-driven through the one actor-checked facade method.
- `blocked`, `verified`, `failed`, `cancelled` demand a non-empty note (the deny-reason rule).
- `verified` is reachable ONLY as an explicit recorded Founder decision
  (`verification.method = 'founder_decision'`; the vocabulary has no machine member — the
  `ActorAuthentication` pattern) and additionally requires approval authority. It grants and
  executes nothing and never touches `hq_approvals` (test-pinned).
- Blueprint states not in #254 (Proposed / Ready / Paused) are later-phase and deliberately
  absent.

Task-plan items are planning records, never `op_tasks` rows. A `work` item may be LINKED
(write-once) to a real task created through the ordinary gated paths; its display state is then
derived read-time by `planItemStateFromTask` — compile-time exhaustive over `ActivityStatus`,
raw status always shown alongside, no second stored vocabulary. An order with no supplied plan
gets exactly one `needs_clarification` item; **no text is ever parsed into tasks, capabilities
or providers**.

## Authority and security posture

- Capability `hq.mission_command` (`founder_gate`, `sideEffect: false`, `idempotent: true`)
  with the full CONFIGURATION-vs-INVOCATION trio: `registerMissionCommandCapability` is a
  separate explicit act; invocation fails closed on missing/altered/disabled and never repairs.
- Commanding requires an active HUMAN principal holding the originate grant; workers, `system`
  and unknown ids are refused outright. `requestedBy` comes only from the resolved Founder
  principal at the boundary; a body naming an actor is refused (`scanForClientIdentity`).
- Idempotency: derived sha256 digest over the canonical-JSON of the normalized command —
  INCLUDING the raw instruction text, so two orders differing only in their wording are two
  missions (Opus finding on `cee771f`); the client key is an input, never the key. Dedupe
  returns the existing mission (200 + `deduplicated`), writing nothing; the dedupe read runs
  inside the same IMMEDIATE transaction as the insert, so it cannot race a concurrent writer.
- Risk/approval truth is server-derived and honest: `authority.riskClass` from the registry row
  (null = row absent, stated), `founderOnly: true`, `approvalFlow:
  'originate_gated_no_approval_row'` — deliberately NOT a `TaskClassification` echo, whose
  `requiresApproval` would misdescribe an intake with no approval row.
- Raw order text and amendment rationale: server-side intent bodies only
  (`getMissionIntentHistory`), never in any route response or snapshot. The browser DOES see
  the structured per-sequence intent history (seq/kind/actor/at + objective/constraints/
  acceptance criteria — all intake-scanned canonical fields), so the Founder can audit the
  immutable original (seq 0) next to every amendment in-product; the Mission Room console
  renders exactly that, ORIGINAL clearly distinguished from CURRENT. All persisted text is
  scanned (`assertNoSecretLikeContent` at the facade; `assertBrowserSafe` at the routes,
  raw-token shapes included) and bounded before anything writes.
- Kill switch: mission writes stay open (parity with direct-order intake; recording direction —
  including "cancelled" — must survive an emergency stop) and still create nothing executable.
- Every mutation commits its row(s), one entry in the mission-owned append-only
  `hq_mission_events` AND one entry in the hash-chained `op_evidence` ATOMICALLY, inside one
  IMMEDIATE reserve transaction (the `declareWorkerProvider` precedent, issue #224): a failing
  evidence append rolls the mutation back, and a service holding no privileged grant refuses
  before any row exists (kinds `mission_commanded`, `mission_transitioned`,
  `mission_intent_amended`, `mission_plan_item_linked`, all `executable: false`).
- The two history tables are append-only BY ENGINE: `BEFORE UPDATE`/`BEFORE DELETE` triggers
  in the module DDL abort a rewrite from any writer, and a src-wide guard plus a raw-SQL
  tamper test pin it.

## Surfaces

Routes (exact-match, deny-by-default, full pipeline — origin/content-type, identity scan,
Founder resolution, `safe()`):

```
GET  /api/hq/control/missions             list, full browser-safe detail
POST /api/hq/control/missions             command (201 / 200 deduplicated)
POST /api/hq/control/missions/transition  lifecycle move (409 on conflict/illegal)
POST /api/hq/control/missions/amend       append-only amendment
```

`CONTROL_WRITE_ROUTES` states the write surface explicitly for test obligations. Session
controls gain `missionCommand`, advertised from the same conditions that decide the write.
The facade adds `commandMission`, `getMission`, `listMissions`, `getMissionIntentHistory`,
`transitionMission`, `amendMissionIntent`, `linkMissionPlanItem`; the facade surface scan's
regex gained `Mission` in the same commit that added them.

Snapshot: `HqSnapshot.missions` + `counts.missions` via the one shared `missionBrowserView`
projection (no version bump — purely additive; the constant's docstring records the policy).
The WRITTEN `hq:snapshot` artefact bounds the section to the newest `SNAPSHOT_MISSION_LIMIT`
missions with `counts.missions` keeping the total and provenance naming the trim; the live
`/state` route stays unbounded so the rooms never silently truncate. `hq:snapshot` also works
over a read-only pre-Phase-3 database: schema init never writes through a read-only handle,
and an absent mission store projects as an honest zero with provenance saying why.
UI: Founder Command composer on index.html, Mission Room console on projects.html (list +
detail + per-sequence intent record + map-derived transition buttons + amend form), immersive
Mission Room rebound — all script-created after `/session` grants, textContent-only,
zero-truth explicit. Authorization loss is honest in BOTH directions: any safe/off entry
clears every rendered mission row by construction, a 401/403 on a lifecycle/amend write
re-checks `/session` and re-reads (session gone → wipe; record still readable with the write
grant gone → rows stay, controls go), and the composer disarms itself on a refused command.

## Evidence

Focused suites: `mission-contracts` (17), `application.mission-core` (36),
`live-mission-routes` (21), `mission-consoles` (9, JSDOM against the real control API),
`mission-durability` (2, real file reopen), three immersive-page additions (live refresh,
lock-over-rows, expiry wipe), hq-host wildcard forwarding (3), hq-server hosted restart driven
through the real `commandMission`/read-back facade path (Linux-gated, CI-authoritative), plus
the deliberate pin updates recorded in their diffs (route table nine entries,
bucket-agreement replacement; the client fetch-target list in `control-console.test.ts` is a
TEST PIN over the emitted scripts — the protective boundary is the server-side
`CONTROL_WRITE_ROUTES` and the unchanged request pipeline, not any client-side allow-list).
