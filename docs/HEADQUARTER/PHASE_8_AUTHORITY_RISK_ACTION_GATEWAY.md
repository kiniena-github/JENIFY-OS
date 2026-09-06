# Phase 8 — Authority + Risk + External Action Gateway

Built on top of the accepted Phase 7 work (head `ab40f70`) on branch
`cloud/phase-7-8-truth-authority-gateway`, itself based on accepted main `9787516`. One
document for the phase, in the Phase 5+6/Phase 7 style. Phase 7 is described in
`PHASE_7_TRUTH_AND_EVIDENCE.md` and is not restated here.

## What Phase 8 is

Meaningful external actions now go through ONE canonical authority/risk/action-intent
gateway instead of provider-specific ad hoc execution paths. Module
`src/application/action-gateway.ts` owns the vocabulary, the adapter contract, the
deterministic risk engine, the append-only ledger schema, the idempotency/digest
derivations and the PURE state derivation; `HeadquarterOperations` owns every authority
decision and every write (`proposeAction`, `authorizeAction`, `executeAction`,
`reconcileAction`), the Intent Guard, and every read (`getAction`, `listActions`,
`listActionsBounded`, `actionStorePresent`, `gatewayActionHistory`).

### The model

- **An action intent is an execution/action LEDGER entry, never a second task truth.** Every
  intent is bound to exactly one canonical `op_tasks` row and executes only under that
  task's live, started, fenced claim. The stable fields: action id; `requestedBy`; task ref
  and optional mission ref; capability; adapter + action type; target; canonical payload +
  SHA-256 `payloadDigest`; provider binding (`providerId`, from the task's
  `executionProvider` or the adapter); categorical risk (`riskLevel`, `riskFactors`);
  declared visibility/reversibility/compensation; context refs (`op_evidence` ids and
  `hq_truth_records` ids — referenced, never copied, and never granting anything);
  `requestedAt`; derived idempotency key; and, from the ledger, the authorization binding
  (approval id + snapshot digest), the attempt (`correlationId` = `<actionId>#<generation>`),
  the outcome and the reconciliation.
- **Ledger states are categorical only**: `proposed | authorized | attempted | succeeded |
  failed | outcome_unknown | reconciled`. The state is DERIVED as the last event of the
  action's `hq_action_events` ledger; the intent row never changes.
- **Risk is categorical only**: `low | medium | high | critical` — no numeric score, no
  probability, no confidence, anywhere (the wire guard already refuses `confidenceScore`).
  `assessActionRisk` is one pure, deterministic function over (a) the CANONICAL capability
  row (`riskClass`, `sideEffect`), (b) the adapter's DECLARED action contract (visibility,
  reversibility) and (c) the proposer's ESCALATIONS (`productionScope`, `spend`,
  `credentialSensitivity`, `legalCompliance`, `blastRadius`). Escalations only ever raise the
  level — nothing a proposer says can lower it (workers may not self-declare an action safe).
  Each raise names a stable factor (`money_spend`, `public_and_irreversible`, ...).
- **Risk policy**: `high` and `critical` actions require a bound, valid Founder approval on
  the canonical task — even where the capability's standing pre-approval would let the task
  itself run unapproved. This is a strictly STRICTER precondition: risk escalation can add an
  approval requirement and can never remove one (`approval_required_by_risk`).
- **Adapters** implement `ExternalActionAdapter { id, provider, actions, execute }`. They
  are supplied ONLY at construction (`HeadquarterOperationsOptions.actionAdapters`), exactly
  like the dispatch evidence grant; nothing holding `ops` can register one. Each action type
  declares `visibility`, `reversibility` and a `compensation` that MUST be present for
  `reversible`/`compensable` and MUST be absent for `irreversible` — a contract that promises
  reversibility without a declared method refuses construction. The compensation is
  declarative metadata on the ledger; nothing in this phase executes it.
- **Idempotency is durable and engine-enforced.** `sideEffectKeyBase` = digest of
  (task, adapter, action type, target, payload digest); an attempt reserves
  `<base>#<generation>` in `hq_action_events.side_effect_key` under a UNIQUE partial index,
  so two different action intents naming the same external side effect get ONE attempt —
  across processes too. A new generation opens ONLY through a human
  `confirmed_not_executed` reconciliation on an idempotent capability, and then as a NEW
  proposal (the generation is part of the proposal's derived dedupe key).

### The state machine, as enforced

```
 proposeAction (worker or human resolved; holds the task's capability; never 'system')
      │  adapter + action type declared; bound provider == adapter provider; refs exist;
      │  risk assessed from canonical row + contract + escalations; payload/target scanned
      ▼
  proposed ──authorizeAction (the worker holding the LIVE started claim; humans refused)──► authorized
      │        #gatewayGate over CURRENT rows → snapshot {taskActionDigest, payloadDigest,     │
      │        approvalId, approvalDecidedBy, worker, fence, claimNonce, provider, adapter,     │
      │        missionIntentSeq, missionStatus, capabilityRiskClass, riskLevel}; written ONCE   │
      │                                                                                        │
      │   executeAction (same worker/fence) ── step 1, ONE IMMEDIATE transaction ─────────────┘
      │     #gatewayGate again → current snapshot; snapshotDrift vs authorized → refuse on ANY drift;
      │     kill switches (global | capability | external_action | provider:<P> | adapter:<id>);
      │     side-effect key reserved by UNIQUE index; `attempted` committed. Nothing executes
      │     unless this committed.
      ▼
  attempted ── step 2, OUTSIDE the transaction: adapter.execute() exactly once
      │           ok → succeeded | rejected/unavailable → failed | unknown or THROW → outcome_unknown
      ▼        step 3, second transaction: the terminal event (secret-like externalRef WITHHELD)
  succeeded | failed | outcome_unknown
                          │
      attempted | outcome_unknown ──reconcileAction (approval authority; not the proposer)──► reconciled
                                     confirmed_succeeded | confirmed_failed | confirmed_not_executed*
                                     (*idempotent capability only; opens generation+1 for a NEW proposal)
```

- **Never auto-retry an unknown outcome.** `executeAction` on an action whose last event is
  `attempted` (an open or LOST attempt — e.g. the process died between steps 1 and 3) or
  `outcome_unknown` refuses with `action_outcome_unknown`. Only a human reconciliation moves
  it. A terminal action (`succeeded | failed | reconciled`) is never re-executed
  (`action_state_conflict`); a second attempt is a new proposal.
- **Refusals move nothing**: a refused authorize/execute/reconcile writes no ledger event; it
  writes one best-effort `action_refused` evidence entry (actor `system`, taskId set) naming
  the phase and code, so the failure is visible rather than silent.

## Authority rules (the enforcement-safe path)

`#gatewayGate` is the ONE gate behind both `authorizeAction` and `executeAction`, evaluated
INSIDE the IMMEDIATE write lock over canonical rows read through `#db` and the enforcement-safe
closures only. (At head `20d70ef` this sentence was FALSE for step 9: the dispatch-lane
exclusion read `queue.evidence.list`, the deliberately patchable display read; the review
round 1 correction below moved it onto `op_evidence` rows through `#db`, and the sentence is
true again.) Authority = worker permissions ∩ mission permissions ∩ policy ∩ approvals:

1. The executing identity must be a worker (`#rejectHumanExecution`), assignable, and granted
   the task's capability by the directory (`#grantOf`, the composed registry-narrowed grant).
2. The adapter and action type must be declared at construction (`unknown_adapter`).
3. The task row (`#taskRowFromStore`, never `queue.get`) must still name the intent's
   capability, be `running`, claimed by THIS worker at THIS fence (`task_not_executing`).
4. The capability row (`#capabilityFromStore`) must exist and be enabled.
5. Provider binding, no substitution in either direction: a bound task admits only an adapter
   of its bound provider; a provider adapter admits only a worker DECLARED as that provider in
   `op_worker_providers` (never inferred from a vendor string); a local (`provider: null`)
   adapter never executes a bound task.
6. Approval — reused canonical mechanics, nothing parallel — required when the capability
   policy requires it (`approvalRequired`) OR the risk level is `high`/`critical`: the
   `hq_approvals` row bound to the task must be `approved`, digest-bound to the task's CURRENT
   `taskActionDigest`, unexpired at `now` (`approvalExpiredAt`), consumed by exactly this claim
   (`validateApprovalClaimBinding`: worker, task, fence, claim nonce) and NOT decided by the
   action's proposer or by the executing worker (the requester-cannot-approve rule applied to
   the external action). A missing row on a standing-pre-approved capability is
   `approval_required_by_risk`; every other defect is `action_approval_stale` or
   `action_digest_mismatch`.
7. Kill switches, read through `#engagedKillSwitchScopeFromStore` (a canonical `op_kill_switch`
   read, never the patchable delegate) over five scopes at once: `*`, the capability,
   `external_action`, `provider:<P>`, `adapter:<id>`. The refusal names the scope.
8. Mission (when referenced): must exist and be neither terminal nor `blocked`
   (`mission_not_active`); at proposal the task must be linked to one of its plan items.
9. The existing Claude GitHub dispatch lane must not already hold the task
   (`duplicate_external_action`), read from the canonical `op_evidence` rows through `#db`
   (`#claudeDispatchState`: `SELECT kind FROM op_evidence WHERE task_id = ?`), never from
   `queue.evidence` — see the seam below.

The Intent Guard / goal lock is the comparison of the authorized snapshot with the one
re-derived at execution (`snapshotDrift`). Drift refuses, classified by what outranks what:
task/payload digest → `action_digest_mismatch`; provider/adapter → `provider_binding_mismatch`;
approval id/decider/worker/fence/nonce → `action_approval_stale`; mission intent seq/status or
capability class → `intent_changed`. An amended mission (a new `hq_mission_intents` row) is
`intent_changed`; the only way forward is a NEW proposal against the current intent, which
re-runs risk and authority. The authorized snapshot is written once and is immutable.

Evidence and truth stay distinct: every act appends `op_evidence` (`action_proposed`,
`action_authorized`, `action_attempted`, `action_succeeded|failed|outcome_unknown`,
`action_reconciled`, `action_refused`) carrying digests and ids — never the payload body —
and an `hq_events` audit row (`action:<id>`). Truth records may be REFERENCED as context;
no truth or memory state is consulted by any gate (memory informs; memory never grants).

## Kill switches and the carried-forward Low 7 — the patchable-read migration audit

The rule: a kill-switch read that DECIDES a write or an authority outcome reads the canonical
`op_kill_switch` row; `queue.killSwitchEngaged` stays the deliberately patchable convenience
read for DISPLAY. Audit of every call site in `src/`:

| Call site | Before | After | Why |
|---|---|---|---|
| `service.ts` `approveTask` | `this.queue.killSwitchEngaged(cap)` | `#killSwitchEngagedFromStore(cap)` | **Migrated.** Decides whether an approval ROW is written — approved work primed to run the instant the switch releases. |
| `service.ts` `claimNext` | `this.queue.killSwitchEngaged(cap)` | `#killSwitchEngagedFromStore(cap)` | **Migrated.** Decides a claim/dispatch outcome. `OperatorQueue.claim` already re-read its own private row, so a forged delegate never produced a claim — but it turned an emergency stop into `nothing_claimable`, misreporting a stop as an empty queue to the dispatch lane. |
| `service.ts` `orchestrateMission` apply precheck | `queue.killSwitchEngaged() \|\| queue.killSwitchEngaged(orchestrate)` | `#killSwitchEngagedFromStore(orchestrate)` (global + scope in one row read) | **Migrated.** The locked revalidation (Sol M1) already read the row, so no write was ever possible on a forged delegate; the precheck still DECIDES a refusal outcome, and no decision may read the delegate. |
| `providers/claude/dispatch.ts` `claudeDispatchEligibility` | `ops.queue.killSwitchEngaged(cap)` | `killSwitchEngagedFor(ops, cap)` — a new exported FUNCTION BINDING published from the class's `static {}` block, the `capabilityRowFor` recipe | **Migrated.** This verdict decides whether a public issue is published. A module binding cannot be reassigned by an importer; the private closure it calls is on no prototype. |
| `service.ts` `#missionExecutionState` (3 reads: `engagedSpecScopes`, `killSwitch.global`, `killSwitch.orchestrate`) | `queue.killSwitchEngaged(...)` | unchanged | **Deliberately left.** A derived read projection (the Mission Room's picture; `recommendation` transitions nothing). A lie there misinforms the patcher's own display and changes nothing enforced — pinned by a test that shows the projection CAN be lied to while the apply beside it still refuses. |
| `service.ts` `#revalidateOrchestrationAuthorityLocked`, `#observeOrchestration` | `#killSwitchEngagedFromStore` (Sol M1/M2) | unchanged | Already canonical. |
| `operator/queue.ts` `claim` | `#killSwitchEngagedInternal` | unchanged | Already canonical (issue #200). |
| Phase 8 gateway (`#gatewayGate`) | — | `#engagedKillSwitchScopeFromStore([...5 scopes])` | New; canonical by construction. |
| `service.ts` `#claudeDispatchState` (`#gatewayGate` step 9 and `proposeAction`) | `this.queue.evidence.list(taskId)` at `20d70ef` | `#db` → `SELECT kind FROM op_evidence WHERE task_id = ?` | **Migrated in review round 1.** Not a kill-switch read, but the same class of defect reintroduced in the new gate: a fact deciding whether HQ EXECUTES an external action was read from the patchable display surface. Proven: a forged `queue.evidence.list` hiding the lane's entries turned `refused:duplicate_external_action` into a real adapter call. |
| `providers/claude/dispatch.ts` `claudeDispatchEligibility` gateway mirror check | `ops.gatewayActionHistory(taskId)` (a prototype method) | `gatewayActionHistoryFor(ops, taskId)` — a function binding over the private `#gatewayActionHistoryFromStore`, which reads the ledger rows through `#db` and not through the public `listActions` | **Hardened in review round 1, minimally.** Not a regression from this wave (the same verdict already reads `ops.queue.get` / `ops.queue.capabilities.get` on accepted main), but the mirror check decides whether a public issue is published, and the recipe already existed. |

Pinned in `kill-switch-enforcement-safe` (5): each site is exercised with the delegate forged
on BOTH the instance and `OperatorQueue.prototype`, the lie proven to have taken
(`queue.killSwitchEngaged()` answers false), and the decision proven unchanged — zero approval
rows, no claim and the typed `kill_switch_engaged`, zero orchestration writes, an ineligible
dispatch verdict — plus the deliberate-left projection pin. The dispatch-eligibility test also
attempts a plain reassignment of the `killSwitchEngagedFor` module binding through a namespace
import and pins that it throws `TypeError` (its earlier name claimed this without attempting
it; the name now says exactly what is attempted — note that a bundler/test transform may
differ from native ESM on `Object.defineProperty`, which is why only the assignment form is
pinned). The gateway's own forged-delegate pin, the forged-`queue.evidence` pin and the
forged-`gatewayActionHistory`/`listActions` pin live in `action-gateway-authority`.

## What is canonical vs projection

| Canonical (unchanged, never rewritten by this phase) | Phase 8 |
|---|---|
| `op_tasks` lifecycle, claims, fences, leases | read only; execution requires `running` under the caller's live fenced claim |
| `hq_approvals` (digest, expiry, single-use claim binding) | read only; the gateway adds STRICTER checks (risk-required approval, proposer ≠ approver) and never writes or extends one |
| `op_kill_switch` | read through canonical closures; two new scope FAMILIES (`external_action`, `provider:<P>`, `adapter:<id>`) are ordinary rows written through the existing Founder-gated `engageKillSwitch` |
| `op_evidence` hash chain | appended to, referenced by context refs, never copied |
| `op_worker_providers`, directory grants, principals | read only |
| Claude GitHub dispatch lane and its evidence contract | untouched except the two narrowing reads above |
| — | `hq_action_intents`, `hq_action_events`: INSERT-only BY ENGINE (full §G trigger set: no UPDATE, no DELETE, and a BEFORE INSERT guard on EVERY unique index — `id`/`seq`, `hq_action_intents.idempotency_key`, `hq_action_events.side_effect_key` — so REPLACE/UPSERT is closed on every conflict target for every writer; see review round 1) plus the UNIQUE `side_effect_key` index; derived `state`, `authorization`, `attempt`, `outcome`, `reconciliation`, `retryBlocked` |

Migration safety: both tables are `CREATE TABLE IF NOT EXISTS`, ensured by
`ensureActionGatewaySchema` from the constructor (readonly-safe, the post-Phase-3 pattern). No
existing table or column changes; no `HQ_SNAPSHOT_VERSION` bump; a read-only pre-Phase-8 file
reports `actionStorePresent() === false`, empty lists and `{ state: 'none' }` history, and is
never migrated (pinned).

## The Phase 7 seam and the dispatch seam

- Context refs may name `hq_truth_records` ids; every ref must exist (`unknown_truth`) and is
  stored as a reference. Nothing reads truth state to decide anything — truth informs the
  reader, it never grants. Truth about an external outcome is recorded, if at all, by the
  ordinary Phase 7 `recordTruth`/`verifyTruth` acts with the action's `op_evidence` entries as
  evidence refs; this phase adds no automatic truth writer.
- One canonical task has ONE external execution path. The gateway refuses to propose or
  execute for a task the Claude GitHub lane has attempted or dispatched (the same evidence
  kinds `dispatchHistory` reads, read as canonical `op_evidence` rows through `#db` —
  `#claudeDispatchState`); `claudeDispatchEligibility` refuses a task with a gateway action
  `attempted | outcome_unknown | succeeded` (`gatewayActionHistoryFor`, a function binding over
  the ledger rows, asked before the lane's own binding checks). The existing lane's
  claim/start/publish/reconcile behaviour, evidence kinds and correlation block are unchanged;
  the two narrowing checks are the ONLY edits to `dispatch.ts`. No Claude/GitHub adapter is
  wired into the gateway in this phase — see limitations.

## Surfaces

Routes (the unchanged pipeline — origin/content-type, identity scan of body AND query, Founder
resolution, `safe()`; route table 25→28, write surface 18→20, both pins updated deliberately):

```
GET  /api/hq/control/actions            bounded ledger list (ACTION_READ_LIMIT=50, newest first,
                                        total + truncated), ?taskId= / ?state= narrow, storePresent
GET  /api/hq/control/actions/detail     ?id=<action id> — one derived view (404 unknown_action)
POST /api/hq/control/actions            PROPOSE (201 / 200 deduplicated); requestedBy is the mapped
                                        principal; browser-guard scan of target + payload first
POST /api/hq/control/actions/reconcile  Founder reconciliation — STEP-UP always (401/403/429), then
                                        the facade's Founder gate and independence rule; 200
```

There is deliberately NO route for `authorizeAction` or `executeAction`: humans never execute,
and both take a worker's fenced claim. The payload BODY never returns to the browser (the view
is digest-only by shape); credential-like adapter results are withheld before storage. One
status per cause: 404 `unknown_action`; 409 `action_state_conflict | action_outcome_unknown |
duplicate_external_action | action_approval_stale | intent_changed | task_not_executing |
mission_not_active`; 403 `approval_required_by_risk` (with the existing authority codes); 400
input and `unsafe_action_content`. Session controls gain `actionReconcile` (= approval
authority). `actionPropose` is deliberately NOT advertised: its deciding condition is per task
(the principal must hold THAT task's capability), and a task-blind flag would advertise a button
the route refuses.

No snapshot section, no room metrics and no archive console for the ledger in this phase — the
routes are the surface, and the deliberate pin ledger below records that nothing else moved.

## What is NOT here (deliberately)

No numeric risk or confidence anywhere. No automatic retry of anything whose outcome is
unknown, no automatic reconciliation, no timer. No second approval system — the approval is the
task's `hq_approvals` row, and the gateway can only demand it more often. No second dispatch
authority — the Claude GitHub lane is not re-routed through the gateway and no real adapter for
it exists yet. No compensation EXECUTION — `compensation` is declared metadata. No real
external action was performed to prove the architecture: every executing test uses a
deterministic local fake adapter. No console UI. No natural-language checking of a mission's
"do-not" constraints — the goal lock is the intent VERSION (seq) and status; matching payload
text against constraint prose would be an invented rule.

## Known limitations (honest)

- **The Claude/GitHub lane is excluded, not integrated.** Wrapping `dispatchClaudeTask` as an
  adapter would double-claim (that lane claims and starts the task itself) and re-home its
  reconciliation authority. The two paths are made mutually exclusive per task instead. A real
  adapter for that lane is a follow-up that must move the claim/start into the gateway's
  step 1 — not something to bolt on.
- **Between step 1 and step 3 a lost process leaves the action `attempted`.** That is the
  correct, retry-blocked state (it is treated exactly like `outcome_unknown` by execute and
  reconcile), but there is no sweep that relabels it `outcome_unknown` after a timeout; a human
  reconciles it. Adding a timer would be inventing an outcome.
- **The risk engine is deliberately simple** (four ordered rules, a fixed factor vocabulary)
  and has no per-capability policy table. Which factors should be `high` vs `critical` for
  JENIFY is a Founder policy question; the current mapping is stated in code and pinned, and
  changes are a reviewed edit, not configuration.
- **`approval_required_by_risk` can make an action un-executable** for a standing-pre-approved
  capability: the task carries no approval row and `approveTask` accepts `needs_approval` only,
  so a `high`/`critical` action on such a task must be re-created under an approval-gated
  capability. This is fail-closed on purpose and said plainly in the refusal.
- **A step-1 refusal writes an `action_refused` evidence entry under actor `system`**, outside
  the rolled-back transaction, best effort. A lost refusal diagnostic costs nothing; the
  refusal itself stands.
- **`gatewayActionHistory` scans the task's actions in memory.** Fine at HQ scale; a large
  ledger would want an indexed derivation, exactly as Phase 7's `loadTruthGraph` notes.
- The proposer independence rule at reconciliation compares the RECONCILER against the
  action's proposer only; the task creator is not refused (the queue's own reconcile refuses
  the task creator for task-level reconciliation, and a task-level rule here would refuse the
  legitimate case of a Founder who ordered the work and later checks the remote).
- **`claudeDispatchEligibility` is only partly enforcement-safe.** Its kill-switch read and
  (since review round 1) its gateway-history read go through function bindings over `#db`,
  but the task and capability it reasons about still come from `ops.queue.get` and
  `ops.queue.capabilities.get` — patchable reads inherited from accepted main, not introduced
  by this wave. The claim/start the lane performs afterwards re-reads canonical rows, so a lie
  there cannot mint a claim, but it can mis-shape the eligibility verdict. Recorded as
  carry-forward debt, not fixed here (out of this correction's scope by the reviewer's own
  framing).

## Deliberate pin ledger

Route table 25→28 (`live-control-api`, test renamed "twenty-eight entries", three sorted paths
added), write surface 18→20 (`live-mission-routes`, plus the two `toContain` and one
`not.toContain` lines), `control-console` postJson allow-list test renamed to "the twenty write
routes" with the allow-list itself deliberately unchanged (no console call site exists for the
two new writes). `application.fixture.ts` gained an `actionAdapters` passthrough (a fixture,
not a test). No test was deleted or relaxed; no `counts` pin, no `ROOM_SECTIONS` change, no
`HQ_SNAPSHOT_VERSION` bump, no `CONTROL_GRANT_JS` change, no change to `CLAIM_BOUND_EVIDENCE_KINDS`
or the dispatch evidence kinds. Review round 1 renamed one test in `kill-switch-enforcement-safe`
to match a reassignment attempt it now actually makes (assertions added, none removed), and
added one exported function binding (`gatewayActionHistoryFor`) plus its module-private reader;
`gatewayActionHistory` keeps its public shape and now delegates to the same private read.

## Deployment runbook (configuration acts, never automatic)

1. Construct `HeadquarterOperations` with `actionAdapters: [...]` at the composition root (the
   host or CLI). Until an adapter is supplied, every `executeAction` refuses `unknown_adapter`
   and every proposal for an undeclared adapter refuses the same — the gateway records nothing
   executable by default.
2. Declare each provider adapter's executing worker in `op_worker_providers` through
   `declareWorkerProvider` (Founder-gated), or a provider adapter refuses every worker.
3. Optional stops: `engageKillSwitch('external_action' | 'provider:<P>' | 'adapter:<id>', ...)`
   through the existing Founder-gated method.
No new capability trio is introduced: proposing requires the TASK's capability from the
proposer's own registry, and reconciling requires approval authority.

## Evidence

New suites: `action-gateway-authority` (31: categorical/monotone risk engine + contract
validation; proposal identity/grant/adapter/provider/refs/secrets/dedupe; the recorded arc with
one adapter call and a payload-free view; truthful `failed`; stale approval, mutated task,
provider redeclaration, mission amendment and blocked mission refusals; duplicate side effect
across intents incl. the engine's UNIQUE index; unknown outcome stays unknown with no auto-retry
and reconciliation authority/independence/idempotency rules; adapter throw = unknown; fresh
generation after `confirmed_not_executed`; every kill-switch scope incl. provider scope and the
forged-delegate pin; risk-required approval on a pre-approved capability; proposer ≠ approver;
authority intersection incl. revoked grant and disabled capability; secret-like adapter result
withheld everywhere; engine immutability on both tables incl. REPLACE on the secondary unique
indexes with `recursive_triggers` OFF and the attempt reservation surviving; the dispatch-lane
mutual exclusion in both directions, under a forged `queue.evidence.list` at execute AND
propose, and under forged `gatewayActionHistory`/`listActions` on instance and prototype; pure
bounded reads), `kill-switch-enforcement-safe` (5: the Low-7 migration
audit above), `action-gateway-durability` (2: real file close/reopen with an unknown outcome
that stays unknown, identical refusals, no retry, then human reconciliation; read-only
pre-Phase-8 absence), `live-action-routes` (11: write surface and the ABSENCE of
authorize/execute routes; attribution/dedupe/no payload on the wire; identity in body and query;
one status per cause; risk escalation from the body; bounded list/detail; secret withheld on the
wire; reconcile step-up 401/403/200 + proposer refused + 409 replay + password never audited;
reconcile input/404/409; `actionReconcile` control; nobody/staff/mutations-off sweep), hq-host
`host-contract` (+2: Fastify-wired propose/read/no-execute-route/worker-step arc; NO_IDENTITY
sweep of all four action routes). Full-matrix results are recorded in the wave PR; merge stays
gated on independent review and the Founder.

## Independent review round 1 — corrections (head `20d70ef` → this head)

An independent hostile review of the exact head `20d70ef` (CI run #518 green, every test count
confirmed) returned CHANGES REQUIRED with working exploits. The Phase 8 items and their fixes
(the Phase 7 items, including the shared trigger flaw and the `hq_memory` carry-forward, are
recorded in `PHASE_7_TRUTH_AND_EVIDENCE.md`):

- **High — the duplicate-external-path check read a patchable surface (Law 3 reintroduced).**
  `#claudeDispatchState` read `this.queue.evidence.list(taskId)`, the surface `operator/queue.ts`
  documents as deliberately patchable for display, and both `#gatewayGate` step 9 and
  `proposeAction` decided on it. Proven: with the Claude lane's `attempted` + `succeeded`
  entries present, an honest `executeAction` refused `duplicate_external_action` with zero
  adapter calls; after `ops.queue.evidence.list = (id) => real(id).filter(not dispatch kinds)`
  the same call EXECUTED and the adapter ran — two external side effects for one canonical
  task. **Fix (`service.ts`):** `#claudeDispatchState` now reads
  `SELECT kind FROM op_evidence WHERE task_id = ? ORDER BY seq` through `#db` (the
  `#missingEvidenceIds` recipe); the `#gatewayGate` sentence in Authority rules is true again
  and says when it was not. Pinned in `action-gateway-authority` with the forged
  `queue.evidence.list` proven to have taken and the gate still refusing at execute and at
  propose; verified to fail against the old read.
- **Mirror check hardened (judged, minimal):** `claudeDispatchEligibility` read
  `ops.gatewayActionHistory` — a prototype method whose body also went through the public
  `listActions`. Not a regression from this wave, but the verdict decides a publication and the
  `killSwitchEngagedFor` recipe already existed, so: a private `#gatewayActionHistoryFromStore`
  reads the ledger rows through `#db`, the public method delegates to it, and the new function
  binding `gatewayActionHistoryFor` is what `dispatch.ts` calls. Pinned with
  `gatewayActionHistory` AND `listActions` forged on instance and prototype (the lie proven to
  have taken on the public method), the binding still answering `succeeded`, the lane still
  ineligible; verified to fail when the binding is routed back through the public method.
- **High (shared with Phase 7) — `INSERT OR REPLACE` through the secondary unique indexes.**
  On `hq_action_events` the standing row was the durable attempt reservation: a REPLACE carrying
  the reserved `side_effect_key` erased the `attempted` event (ledger read
  `proposed → authorized → succeeded → proposed`, `attempt: null`), and a forged replacement
  claiming `reconciled: confirmed_not_executed` would have raised `sideEffectGeneration` and
  freed the side effect for a SECOND real execution. **Fix (`action-gateway.ts`):**
  `trg_hq_action_intents_no_replace_unique` (`idempotency_key`) and
  `trg_hq_action_events_no_replace_unique` (`side_effect_key`), additive names. Because the
  guard now fires BEFORE the UNIQUE index on a raced legitimate reservation, `executeAction`'s
  concurrent-duplicate catch also recognises `SQLITE_CONSTRAINT_TRIGGER` naming
  `side_effect_key` (still `duplicate_external_action`, nothing executes). Pinned with the
  pragma OFF: both REPLACEs abort, rows byte-identical, ledger
  `proposed → authorized → attempted → succeeded`, re-execute `action_state_conflict`, adapter
  calls 1; verified to fail against the old DDL.
- **Low — overstated test name** in `kill-switch-enforcement-safe` ("cannot be reassigned" with
  no attempt). The test now makes the plain reassignment through a namespace import, pins the
  `TypeError`, pins the binding identity afterwards, and is named for exactly that.
