# Phase 3 — Founder Command + Mission Core

Issue #253. Package: `@factoryos/headquarter`, subpath exports `./application`,
`./live`, `./client`, `./ui`.

This document is the operator-facing half. The reasoning lives next to the code
in `src/application/mission-domain.ts` (pure rules) and
`src/application/mission-core.ts` (persistence + authority), with the browser
seam in `src/live/control-api.ts` and `src/ui/control-console.ts`.

---

## 1. What a mission is, next to what already existed

HQ already had two "mission" things. Phase 3 adds a third **beside** them:

| Thing | Where | What it is | Phase 3 change |
|---|---|---|---|
| `hq_mission_proposals` | `application/missions.ts` | Inert chat-room proposal for ONE capability invocation | none |
| `hq.direct_order` | `live/orders.ts` | ONE free-text instruction → ONE Founder-gated `op_tasks` row | none |
| **Mission** | `application/mission-core.ts` | A locked goal with explicit constraints and a dependency-ordered task plan | new |

Extending the proposal table was considered and rejected: a proposal is one
capability + one payload, and a goal, an intent history, a task graph and a
decision list on that row would make an inert record carry authority-shaped
fields.

A mission **owns no execution authority**. Every mission task becomes real work
only by opening an ordinary `op_tasks` row through
`HeadquarterOperations.createTask`, under the unchanged capability registry,
policy, approval-digest, claim-fence, provider-binding, review and kill-switch
rules.

## 2. Storage

Four additive, idempotent tables in `src/store/db.ts` (so the hosted
durable-volume owner migrates them under the same verified WAL +
`synchronous=FULL` ordering as everything else):

| Table | Holds |
|---|---|
| `hq_missions` | the mission row; `original_instruction` is **server-side only**; `lifecycle` records only explicit decisions |
| `hq_mission_intents` | immutable intent history, one row per version |
| `hq_mission_tasks` | planned tasks; `op_task_id` links to canonical work once opened; `execution_intent_version` is the fence |
| `hq_mission_decisions` | Founder-visible decisions (hard gates, ambiguities); open ones block the mission |

Nothing in `data/factoryos.sqlite` is touched.

## 3. The Founder Command path

```
Founder types a command  →  POST /api/hq/control/missions (session → Founder map → principal)
  →  MissionCore.createFromCommand
       capability hq.founder_command: registered, enabled, unaltered, kill switch clear
       principal holds the ORIGINATE grant for it (deny by default)
       command scanned for credentials (refused before any write)
       normalizeFounderCommand  → objective + do_not + constraints + unknowns
       Founder hard gates detected → recorded as OPEN DECISIONS (mission BLOCKED), never planned around
       plan = supplied PlannerResult (in-process seam) or deterministic baseline
       validatePlan  → stable keys, acyclic, deps exist, task risk ≤ mission ceiling, scope narrows, do_not inherited
       one IMMEDIATE transaction: mission + intent v1 + tasks + decisions + evidence
  →  MissionView (browser-safe)  — normalized intent, plan, decisions, derived status, command DIGEST + length
```

Registering `hq.founder_command` is a configuration act:
`npm run hq:founder-command -- --register-capability [--db <path>]`. Issuing a
command never registers or re-enables it.

### The normalizer is deterministic, not an AI

Fixed grammar: the first sentence is the objective; a do-not marker
(`without`, `do not`, `never`, `must not`, `avoid`, …) splits any sentence into
head + hard-constraint clause; later sentences opening with a positive marker
(`keep`, `only`, `within`, …) are constraints; every other later sentence is
**counted and not copied**, and the count is stated as an unknown. This is what
lets the read model publish "what HQ understood" while the raw command stays
server-side. A later AI planner replaces the baseline plan and must still pass
`validatePlan`.

Founder hard gates are detected by matching the gate patterns against the
**requiring half** of the command — the text with every do-not clause excised —
because "without deploying to production" is a constraint HQ can honour while
"and deploy to production" is a gate HQ must stop at, and the difference is
where the phrase sits. Detection stays conservative and is not the containment:
a phrasing the patterns miss raises no decision, but every task still passes the
real capability, policy, approval and kill-switch gates when it is opened as
canonical work.

## 4. Goal Lock

- The original command is written once and never updated.
- Intent is versioned; every intent-dependent write (revise, resolve a
  decision, cancel, decide an outcome, open task work) carries
  `expectedIntentVersion` and is refused as `stale_intent_version` when it is
  not current.
- A do-not rule leaves the intent only when the revision names it in
  `removeDoNot`; a list that merely omits one is refused as
  `constraint_removed`.
- Scope expansion is allowed but detected and recorded on the version row and
  in evidence.
- An execution opened under intent v1 is marked **stale** after v2, and
  `HeadquarterOperations.approveTask` refuses to approve it
  (`mission_intent_changed`) — a stricter precondition on the existing gate,
  not a second approval system.
- An approval granted **before** the revision is unexpired and would still
  admit execution, so `approveTask`'s refusal never runs again for it and the
  next claim would consume it. A revision therefore **supersedes** every
  execution of the mission that is `queued` — approved but not yet claimed —
  by denying it through the ordinary `denyTask` gate, in the same transaction
  as the version bump. Nothing was claimed and nothing ran; the task becomes
  `blocked` with the reason stated, and the denied task ids are named in the
  `mission_intent_revised` evidence.
  - `needs_approval` executions are deliberately left alone: `approveTask`'s
    refusal already covers them, harder, and denying them from this side would
    make that guard unreachable on the path it exists for. The Founder can
    still deny one deliberately.
  - `assigned` / `running` / `outcome_unknown` executions are **not** stopped
    by a revision. This layer cannot honestly halt claimed work — the
    Operator's kill switch, review and reconciliation own that, the same rule
    `cancel()` states — so they are recorded as stale in flight in the same
    evidence entry and are refused a fresh approval, rather than the mission
    layer pretending to have stopped them.
- A revision is not a dead end for the task it supersedes. A mission task whose
  execution is **stale and finished without success** (`blocked` or
  `review_failed`) may be re-opened under the current intent: `openTaskWork`
  creates a fresh canonical task with its own `mission-task:<id>:v<version>`
  idempotency key and re-links, naming the superseded task id in evidence. The
  old `op_tasks` row is never edited or deleted. Every other status still
  refuses `mission_task_already_opened` — a live decision, unfinished work, or
  work that succeeded.
- `MissionCore.manifest(id)` is the compact authoritative manifest a later
  worker prompt consumes (server-side; it includes the original command).

## 5. Status is derived, never stored as a claim

```
lifecycle ≠ open           → that lifecycle (verified / complete / failed / cancelled)
any open Founder decision  → blocked
any task blocked or failed → blocked
all tasks completed        → ready_review      (never "complete" — that is a Founder decision)
any execution opened       → working
otherwise                  → planned
```

Task states map from canonical `op_tasks` truth: `queued → waiting`,
`assigned → working`, `running → working` / `needs_review` (review pending),
`needs_approval`, `completed`, `review_failed → failed` (worker reported) or
`blocked` (reviewer rejected), `blocked` / `outcome_unknown → blocked`.

`verified` is reachable only from derived `ready_review`; `complete` only from
`verified`; `failed` from any open mission with a note. All require approval
authority.

## 6. Cancellation

`MissionCore.cancel` (and `POST /missions/cancel`) requires approval authority, a
reason and the displayed intent version. It **refuses** while any attached
canonical task is queued, claimed, running or outcome-unknown — those are
stopped through the Operator's own paths (kill switch, review, reconciliation),
not by marking a mission cancelled while work runs. Executions still waiting at
the Founder gate are denied as part of the cancellation, because a denial is
not an authorization and nothing had run.

## 7. Browser surface

Routes added to the exact-match table (nine total):

| Route | Verb | Calls |
|---|---|---|
| `/api/hq/control/missions` | GET | `MissionCore.list` — the same projection the state route's `missions` section carries |
| `/api/hq/control/missions` | POST | `MissionCore.createFromCommand` with the server-resolved principal and the earned `authenticated_os_session` marker |
| `/api/hq/control/missions/cancel` | POST | `MissionCore.cancel`, fenced on `expectedIntentVersion` |

There is deliberately no browser route that revises intent, resolves a decision,
decides an outcome or opens task work, and no `plan` field is accepted from a
request body (the browser is not a planner). `/session` advertises
`founderCommand` (originate grant + capability enabled + writable origin) and
`cancelMission` (approval authority) on exactly the conditions that decide the
writes.

The Command Center page (`index.html`) gains a **FOUNDER COMMAND — MISSION CORE**
section: inert static markup plus `missionConsoleScript`, which draws the
composer only under a `founderCommand` grant, lists missions for any resolved
Founder session, and states one of five conditions in words — checking, off
(server's reason), empty ("HQ is holding nothing here"), error/offline,
unauthorized. The immersive **Mission Room** projects the mission records
beside the canonical task cards it already showed; its liveness now also
counts a blocked/ready-for-review mission as attention and a working mission
as active. No progress, ETA, cost, token or worker-activity figure exists on
any of these surfaces, and `assertNoFabricatedFields` refuses one on the wire.

The immersive runtime itself stays read-only (its own tests forbid a write
route in it); the write control lives on the Command Center console, as the
Direct Order composer does.

## 8. What Phase 3 does not do

No orchestrator, no AI planner call, no dynamic workforce, no context engine,
no external action gateway. `PlannerResult` → `validatePlan` and
`MissionCore.manifest` are the contracts those phases extend.
