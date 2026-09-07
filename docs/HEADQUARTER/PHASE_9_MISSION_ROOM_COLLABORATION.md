# Phase 9 — Mission Room + Multi-AI Collaboration

Built on accepted main `2d72ce1` (the Wave 2 merge, Phases 7 + 8) as the first half of the
Phase 9 + 10 wave on branch `cloud/phase-9-10-collaboration-chief-of-staff`. One document
for the phase, in the Phase 5+6 / Phase 7 / Phase 8 style. Phase 10 is a separate build on
the same branch and is NOT described here.

**Corrected after the hostile review of `1b73316`.** A second Opus review disproved two
claims this document made, and the Founder decided two adjacent Lows. The corrections are
described where they belong below and summarised here so nothing is buried:

| Finding | What was wrong | What the correction does |
|---|---|---|
| **H1 (High)** | The context bundle's truth section filtered privacy over the PUBLIC `listTruth()` projection. A same-realm patch that wrapped the original and relabelled `privacy` on the REAL rows pushed a genuine `founder_only` record into another worker's bundle AND drove `withheld.founderOnlyTruth` to 0, so the bundle's own honesty field concealed the disclosure. This document's claim that a forged read "cannot reveal a real founder_only one" was FALSE. | The bundle derives truth from the private `#deriveAllTruth(loadTruthGraph(#db))` — the enforcement-safe derivation `#contributionContext` already used — and filters privacy on the derived row. Pinned by a hostile-patch regression on the instance AND the prototype. |
| **M2 (Medium)** | `assembleCollaborationContext` had no capability gate and no standing check. A cancelled mission, both capability rows disabled, and a revoked `hq.collaboration_contribute` grant each closed the WRITE paths and left the bundle read fully open. | The worker read now carries the same gates as `recordContribution` (identity + assignability + directory grant + the capability trio read from the DATABASE row) plus the session's derived standing from `hq_missions.status` through `#db`. Fails closed. The Founder-gated audit path may still read a CLOSED session — stated below and pinned. |
| **L3 (Founder-decided)** | A worker's bundle disclosed `founder_only` CARDINALITIES. | A worker gets a categorical `withheld` (`audience: 'worker'`, booleans); the Founder audit keeps exact counts (`audience: 'founder_audit'`). |
| **L4** | Session-existence oracle: a real session a worker was not admitted to returned `not_permitted`, a fake id `unknown_session`. | For a worker both are ONE byte-identical `unknown_session`. The Founder-gated path keeps the distinguishing answers. |
| **L5 (Founder-decided)** | A session's free-text `purpose` rode the UNAUTHENTICATED snapshot artifact verbatim, and no classification existed. | Sessions carry the existing `internal | founder_only` privacy vocabulary (no second system, no second store). The unauthenticated artifact carries no `founder_only` session and no purpose text at all; both omissions are counted and stated. |
| **L6** | Two authority reads sat outside the reserve lock, against Wave-2 correction `0b6c108`. | Both are now REVALIDATED inside the lock; the pre-lock checks stay so refusal order is unchanged. No exploit existed (`reserve()` is synchronous) — this is consistency, not a fix. |

## What Phase 9 is

Several real AI workers can now collaborate on ONE canonical mission — as a durable,
attributed, bounded RECORD — without becoming a swarm and without HQ gaining a second
mission, task, worker, approval, evidence, truth or memory authority. Module
`src/application/collaboration-command.ts` owns the vocabulary, the two capability trios,
the append-only schema, the idempotency derivations, the PURE derivation core, the browser
projections and the bounded context-bundle policy; `HeadquarterOperations` owns every
authority decision and every write (`openCollaborationSession`, `admitCollaborator`,
`recordContribution`) and every read (`getCollaborationSession`, `listCollaborationSessions`,
`listCollaborationSessionsBounded`, `listContributions`, `getMissionRoom`,
`assembleCollaborationContext`, `collaborationSummary`, `collaborationStorePresent`).

### The model

- **A session references ONE canonical mission and has no lifecycle of its own.**
  `hq_collab_sessions` carries `mission_id`, a title, an optional purpose, a privacy
  classification (below), who opened it and when — and NO status column (pinned). Its `standing` (`active | closed`) is DERIVED
  on every read from the mission's canonical `hq_missions.status`: a terminal mission
  (`complete | failed | cancelled`) closes every session on it, admits nobody and records
  nothing further; a finished mission opens no new session (`mission_terminal`).
- **Roles are admission metadata, never authority.** `planner | builder | researcher |
  reviewer | verifier | critic` — one `hq_collab_participants` row per (session, worker,
  role), written by the Founder act. A role grants no capability, approves nothing,
  verifies nothing and is consulted by no gate outside this module's own membership check
  (pinned: a worker admitted as `verifier` still cannot `verifyTruth`; one admitted as
  `planner` still cannot amend or transition the mission; its directory grant and
  `hq_specialists` row are byte-identical).
- **A participant is a REAL execution worker.** Admission requires a registered,
  assignable `hq_specialists` row read through the enforcement closures — never a human
  principal (a human admitted "as a worker" would let human identity read as worker
  identity), never an unknown id, never an inactive worker. No worker is ever invented.
- **A contribution is an attributed worker act.** `hq_collab_contributions` records the
  resolved worker (there is no input that names one), the role it acts in (one it holds in
  THAT session — a worker holding one role need not name it, one holding several must),
  the kind (`plan | finding | proposal | review | critique | question | answer |
  status_report | handoff_request`), bounded content, artifact refs, `op_evidence` refs
  (must exist), `hq_truth_records` refs (must exist and not be founder_only — refused with
  the SAME code as an absent id, so nothing is an oracle), an optional task ref (must be a
  task the mission links through a plan item), the CANONICAL provider/model binding, and
  the timestamp. Every write appends one `hq_events` audit row (`collaboration:<session>`)
  and one `op_evidence` entry (`collaboration_session_opened`,
  `collaboration_participant_admitted`, `collaboration_contributed`, all
  `executable: false`) atomically with the row.
- **Provider/model truth is read from the canonical rows at write time, never from the
  worker.** `providerId` is the operator's declared execution provider
  (`op_worker_providers`, routing vocabulary `CLAUDE` / `CODEX` / …); `memberIdentityKey`
  is the ACTIVE registered AI member under the same worker id (`hq_ai_members`, registry
  vocabulary `anthropic:claude-…`), when that table exists in the file. The two
  vocabularies are disjoint and are recorded side by side — never compared to each other,
  never inferred from the specialist's vendor string. `bindingSource` states which were
  found: `declared_provider_and_registered_model | declared_provider | undeclared`. A
  contribution may DECLARE a binding; it must equal the canonical one exactly or the write
  is refused (`provider_binding_mismatch`) — a wrong provider, a provider for an undeclared
  worker, a wrong model version, or a model for a worker with no registered identity all
  refuse. Nothing is substituted.
- **Agreement and disagreement are explicit stances, never truth.** `agrees_with`,
  `disagrees_with` and `responds_to` are stated at birth in `hq_collab_relations`, must
  name a contribution of the SAME session, and are immutable. Each contribution derives a
  categorical `standing` (`unchallenged | agreed | disputed | mixed`) from the stances
  OTHER contributions took on it; every `disagrees_with` is listed as a `DisagreementView`
  until an act ELSEWHERE resolves the matter — never by count, never by recency. No number
  of agreeing workers writes a verification or acceptance row: a contribution's
  `truthRefs[].state` is the state each referenced record derives NOW through the Phase 7
  derivation, so a room full of agreement visibly moved nothing (pinned: three workers
  agree, the record stays `claimed`; only `verifyTruth` by an independent verifier moves
  it).
- **A handoff is a recommendation.** `kind: 'handoff_request'` carries `{ taskId,
  toWorkerId, reason }`: the task must be one the mission links, the target must be ANOTHER
  registered, assignable, non-human worker. The view carries the canonical task picture
  beside it (`status`, `claimedBy`, the Founder's `hq_op_task_meta.assignment`) read at
  derivation time and flagged `advisory: true`. Canonical claim, fence and assignment stay
  exactly where they are and read nothing here (pinned: after a request naming `jules`,
  `claimNext('jules', …, taskId)` refuses, the claim and fence are unchanged, no assignment
  row exists; only `assignTaskAsFounder` changes the picture).
- **Context bundles are bounded, role/task/mission-scoped and privacy-safe.**
  `assembleCollaborationContext({ sessionId, role, taskId?, requestedBy })` composes, at
  read time and persisting nothing: the ONE mission's current structured intent
  (objective, scope, constraints, acceptance criteria, status, priority, block reason, the
  current `intentSeq`, plan items with spec presence — never the raw order text or
  amendment rationale, never `intentHistory`), the ONE task's minimal ref when named (never
  the payload), THIS session's participants and contributions (never another session's —
  counted in `withheld.otherSessionContributions`), internal truth about the mission and
  its tasks (**derived through the PRIVATE truth derivation over the canonical graph, never
  the public `listTruth` projection** — H1), and entity-linked internal memory through the
  Phase 5 assembler (unrelated company memory never enters). Each
  section is assembled only where `CONTEXT_SECTIONS_BY_ROLE` grants it — a stated,
  categorical policy table (builders: task + memory, no truth graph; reviewers/verifiers/
  critics: truth, no memory; planners/researchers: both) — and a section outside the policy
  is `null`, never an empty list pretending to be a read. Every list is bounded to
  `COLLABORATION_CONTEXT_LIMIT` (20) with the true total stated.
- **The bundle read is gated exactly like the sibling WRITE paths** (M2). A WORKER passes:
  identity + assignability + the `hq.collaboration_contribute` directory grant
  (`#resolveContributor`, the enforcement closures); the capability trio through
  `#collaborationContributeCapabilityGate`, which reads the DATABASE row, so a disabled or
  drifted capability closes the read exactly as it closes the write; membership in THIS
  session from the canonical participant rows; and the session's DERIVED standing from
  `hq_missions.status` read through `#db` — a cancelled, complete or failed mission answers
  `session_closed` to the read just as it does to the write. A human passes
  `hq.collaboration_command` (grant AND intact capability row). `system` and unknown ids
  are refused before any session is probed.
  **Decided, and pinned:** a Founder-gated audit MAY still read a CLOSED session's bundle —
  auditing what a role received is precisely what is wanted after a mission is cancelled,
  and the audit read grants nothing and hands nothing to a worker. An admitted WORKER may
  not.
- **What was withheld is reported at the audience's resolution** (L3, Founder decision). A
  `founder_only` cardinality is itself a disclosure about private material, so a worker's
  bundle carries `withheld: { audience: 'worker', founderOnlyMemory: boolean,
  founderOnlyTruth: boolean, otherSessionContributions: number }` — categorically THAT
  something was withheld, never how much. The Founder-gated audit path carries
  `{ audience: 'founder_audit', founderOnlyMemory: number, founderOnlyTruth: number, … }`
  with the exact counts. `otherSessionContributions` stays a count for both audiences
  deliberately: it is not founder_only material, and the phase advertises the session bound
  as a stated bound rather than a silent drop.
- **The bundle is not a session-existence oracle** (L4). For a WORKER, "no such session"
  and "a session you were not admitted to" are ONE refusal — same code, same message, same
  (absent) details — the discipline this module already applies to `founder_only` truth
  refs. A worker already inside a room may still be told it holds a different role there;
  that discloses nothing it did not know. The Founder-gated commander path keeps the
  distinguishing answers.

### The state machine, as enforced

```
 openCollaborationSession  (human holding hq.collaboration_command; trio intact; mission exists
      │                     and is non-terminal — read INSIDE the write lock through #db)
      ▼
   session ── standing DERIVED from hq_missions.status on every read: active | closed ──┐
      │                                                                                  │
 admitCollaborator (same Founder gate; worker = registered, assignable, non-human;       │
      │            role ∈ the six; session active; binding snapshot from canonical rows) │
      ▼                                                                                  │
   participant (session, worker, role) — unique by engine; a repeat deduplicates         │
      │                                                                                  │
 recordContribution (worker holding hq.collaboration_contribute in its directory grant;  │
      │              trio intact; session active; admitted under the named/held role;    │
      │              declared binding == canonical binding; every ref real; stances in   │
      │              the same session; handoff target another real worker)               │
      ▼                                                                                  │
   contribution + stances — standing DERIVED from later stances; truth states DERIVED    │
                            through Phase 7; handoff canonical picture DERIVED from      │
                            op_tasks / hq_op_task_meta at read time                      │
                                                                                         │
   mission reaches complete | failed | cancelled ────────────────────────────────────────┘
   ⇒ every session closed: admit → session_closed, contribute → session_closed,
     assembleCollaborationContext FOR A WORKER → session_closed (M2), open →
     mission_terminal. The Founder-gated audit read of a closed session stays open,
     deliberately. Nothing is ever updated or deleted.
```

## Authority rules (the enforcement-safe path)

- Two capability trios, CONFIGURATION-vs-INVOCATION exactly as truth/memory/orchestrate:
  `hq.collaboration_command` (`founder_gate`, `sideEffect: false`, `idempotent: true`) and
  `hq.collaboration_contribute` (`reversible`, `sideEffect: false`, `idempotent: true`);
  registration is a separate act (`registerCollaboration*Capability`), invocation fails
  closed on missing/altered/disabled through the DATABASE row (`#capabilityFromStore`,
  never `queue.capabilities`), and detection never repairs (pinned for both trios).
- Opening and admitting resolve through `#resolveFounderGateActor` — an active HUMAN
  principal holding the command grant; workers, `system` and unknown ids refused, exactly
  as mission command. Contributing resolves through `#resolveContributor` — a registered,
  assignable WORKER whose directory grant (`#grantOf`, the enforcement closure) includes
  the contribute capability; `system` is refused (an unattributed contribution is the
  fabricated activity this phase forbids); human principals are refused (humans direct a
  mission through mission command; a room's contributions are worker acts).
- **Every deciding read is a canonical row through `#db` or an enforcement closure.** The
  mission's status (`#missionStatusFromStore`, inside the IMMEDIATE write lock), the
  session/participant/contribution rows, the worker's registration
  (`#isRegisteredWorker`), assignability (`#workers.assignability`), its grant
  (`#grantOf`), whether an id is a human (`#principalOf`), the binding
  (`#workerBindingFromStore`: `op_worker_providers` + `hq_ai_members` rows), evidence
  existence (`#missingEvidenceIds`), truth existence and privacy (`hq_truth_records` row),
  plan-item linkage (`hq_mission_plan_items` row). Pinned by hostile-patch tests with the
  public reads forged on the instance AND the prototype and each lie proven to have taken:
  `getMission` / `getCollaborationSession` / `lookupPrincipal` / `workers.isRegistered`
  (session still closed, ghost still nobody), `listAiMembers` /
  `workerProviderDeclarations` / `workers.allowedCapabilities` (binding still canonical,
  the ungranted still refused).
- The bundle READ resolves through the same two gates as the write it mirrors —
  `#resolveContributor` + `#collaborationContributeCapabilityGate` for a worker,
  `#resolveCollaborationCommander` + `#collaborationCommandCapabilityGate` for the Founder
  audit — and then re-derives the session's standing from `hq_missions.status` through
  `#db` (M2). Before the correction it did none of these, and survived every stop lever.
- Every write is ONE IMMEDIATE reserve transaction: dedupe read → existence and standing
  checks → membership → binding → references → insert(s) + stated stances + `hq_events`
  audit + `op_evidence` entry, atomically. Refusals write nothing (row counts pinned
  throughout). The two worker-validity gates that sat only OUTSIDE the lock
  (`admitCollaborator`'s admitted worker, `recordContribution`'s handoff target) are now
  REVALIDATED inside it, matching Wave-2 correction `0b6c108` (L6). The pre-lock checks are
  kept, so refusal ORDER is unchanged; no exploit existed, because `reserve()` is
  synchronous — this is consistency, and it is recorded as such rather than sold as a fix.
- Derived idempotency keys (`collab-session:`, `collab-contribution:`) over canonical JSON of
  the normalized input + actor; the client key is an input, never the key. Admission
  dedupes on the engine-unique (session, worker, role) triple.
- Kill switch: collaboration writes stay OPEN (the memory/truth intake-parity rule) — a
  contribution is a record, executes nothing, and must survive an emergency stop; the
  Mission Room read carries the engaged scopes through the Phase 6 execution state so the
  Founder sees the stop beside the room.
- Bounds: title ≤120, purpose ≤500, content ≤4000, handoff reason ≤500, every id/ref list
  ≤20 entries of ≤200 chars with duplicates collapsed; secret scan on every persisted text
  (facade) and the stricter browser scan at the routes; `requestedBy` only from the
  resolved principal — a body or query naming an actor is refused
  (`client_identity_supplied`). Note `role` IS a client-identity key: the route body/query
  key for a collaboration role is `collaborationRole`, and a request carrying `role` is
  refused on sight (pinned at the facade-free control API and through the Fastify host).

## What is canonical vs projection

| Canonical (unchanged, never rewritten by this phase) | Phase 9 |
|---|---|
| `hq_missions` lifecycle, intents (seq 0 immutable), plan items | read only; a session's standing derives from the status; no contribution touches any mission table (pinned byte-identical across `hq_missions`, `hq_mission_intents`, `hq_mission_plan_items`, `hq_mission_events`) |
| `op_tasks`, claims, fences, leases; `hq_op_task_meta.assignment` (Founder-gated advisory assignment) | read only; a handoff request changes none of it and `claimNext` / `assignTaskAsFounder` read nothing here |
| `hq_approvals`, `op_kill_switch`, `hq_specialists`, `op_worker_providers`, `hq_ai_members`, `hq_human_principals` | read only |
| `op_evidence` hash chain, `hq_truth_*` (Phase 7), `hq_action_*` (Phase 8), `hq_orchestration_runs` (Phase 6), `hq_memory` (Phase 5) | referenced / composed; never copied, never consulted to decide anything here beyond existence and privacy of a referenced id |
| — | `hq_collab_sessions`, `hq_collab_participants`, `hq_collab_contributions`, `hq_collab_relations`: INSERT-only BY ENGINE (full §G trigger set: no UPDATE, no DELETE, BEFORE INSERT guards on `id`/`seq` AND every secondary unique index — session `idempotency_key`, participant `(session_id, worker_id, role)`, contribution `idempotency_key` — so REPLACE/UPSERT is closed on every conflict target for every writer with `recursive_triggers` OFF; pinned). Every table is `seq INTEGER PRIMARY KEY`, so the implicit rowid IS `seq` and the carried-forward implicit-rowid shape does not arise. Derived: `standing` (session), `standing`/`agreedBy`/`disputedBy`/`truthRefs[].state` (contribution), `DisagreementView`, `HandoffRequestView.canonical`, the `MissionRoomView`, the context bundle, the snapshot counts |

Migration safety: all four tables are `CREATE TABLE IF NOT EXISTS`, ensured by
`ensureCollaborationSchema` from the constructor (readonly-safe, the post-Phase-3 pattern).
The one column this correction adds — `hq_collab_sessions.privacy` — follows the additive
`ALTER TABLE … ADD COLUMN … DEFAULT` pattern already used by `hq_memory`, `hq_missions` and
`hq_projects`: no row is written, no trigger fires, the append-only guarantee is untouched,
and a file created before the correction reads `internal`. The session idempotency
derivation digests `privacy` only when it is NOT the default, so a session recorded before
the correction still deduplicates a repeat afterwards instead of silently opening a second
room — while two opens that differ only in classification stay distinct, because deduping
them would discard the second one's classification. No other existing table or column
changes; no `HQ_SNAPSHOT_VERSION` bump (the snapshot section is
optional and additive); a read-only pre-Phase-9 file reports
`collaborationStorePresent() === false`, empty lists, zero summary, an absence-stating
snapshot section, and is never migrated (pinned).

## The patchable-read audit for what this phase touched

| Read | Where | Decides | Reads through | Status |
|---|---|---|---|---|
| mission status for open/admit/contribute | `service.ts` Phase 9 writes | whether a session/participant/contribution row is written | `#missionStatusFromStore` → `#db`, inside the reserve lock | canonical by construction |
| session / participant / contribution / relation rows | all Phase 9 writes | membership, role, dedupe, stance targets | `#db` (module loaders take the handle) | canonical |
| worker registration / assignability / grant | admit, contribute, handoff target, context | whether an id may enter a room or record | `#isRegisteredWorker`, `#workers.assignability`, `#grantOf` (the closures `claimNext`/`#gatewayGate` use) | canonical |
| human-principal check for a "worker" id | admit, handoff target | refuses a human admitted as a worker | `#principalOf` | canonical |
| provider / model binding | admit, contribute | what is recorded; whether a declared binding is refused | `#workerBindingFromStore` → `op_worker_providers` + `hq_ai_members` rows via `#db`; the registry table is probed in `sqlite_master` at read time | canonical — never `listAiMembers` / `workerProviderDeclarations` / the registry object |
| evidence / truth / plan-item existence | contribute, context | reference validity; founder_only withholding | `#missingEvidenceIds`, `hq_truth_records` row, `hq_mission_plan_items` row | canonical |
| `this.readMeta(taskId)` | `#contributionContext.taskStateOf` (handoff canonical picture) and `#missionExecutionState` (pre-existing) | NOTHING — a display projection beside the request | public prototype method | deliberately left: a lie there misinforms the patcher's own display and changes no decision (`claimNext`/`assignTaskAsFounder` read the rows). Recorded here as a display read, not an enforcement read |
| `this.listTruth()` / `this.listTruthContradictions()` | `getMissionRoom` ONLY | NOTHING — display composition for the Founder | public prototype methods over `#deriveAllTruth` | deliberately left, and re-examined under H1: `getMissionRoom` has exactly ONE caller (`missionRoomRoute`, behind `ResolvedFounder`), it carries founder_only truth by design exactly as `GET /truth` does, and nothing it returns crosses to another principal. A forged read therefore misinforms the patcher's OWN display and moves no disclosure decision — the same standard recorded for `readMeta` and the kill-switch reads |
| the truth records in a context bundle | `assembleCollaborationContext` (truth section) | WHICH truth records reach ANOTHER worker, and the `withheld` accounting beside them | `#deriveAllTruth(loadTruthGraph(#db))` — the private derivation, privacy filtered on the DERIVED row | **canonical (corrected under H1).** The previous entry read this through the public `listTruth` and claimed a forged read "cannot reveal a real founder_only one". That was wrong: wrapping the original and relabelling `privacy` on the rows it really returned both leaked a genuine founder_only record and zeroed `withheld.founderOnlyTruth`. The bundle crosses principals, so it is an enforcement read, not a display read |
| worker standing / capability trio / session standing for the bundle READ | `assembleCollaborationContext` | whether a bundle is assembled at all | `#resolveContributor` (`#isRegisteredWorker`, `#workers.assignability`, `#grantOf`), `#collaborationContributeCapabilityGate` → `#capabilityFromStore` (the DATABASE row), `#missionStatusFromStore` → `#db` | **canonical (added under M2).** Pinned by a hostile-patch test: forged `workers.allowedCapabilities` and forged `queue.capabilities.get`/`.list` on the instance and the prototype open nothing |
| `#missionExecutionState`'s three `queue.killSwitchEngaged` reads | `getMissionRoom` (via the Phase 6 read) | NOTHING — the room's picture | patchable delegate | unchanged, deliberately left (the Phase 8 audit's recorded projection) |

## Surfaces

Routes (the unchanged pipeline — origin/content-type, identity scan of body AND query,
Founder resolution, `safe()`; route table 28→32, write surface 20→22, both pins updated
deliberately):

```
GET  /api/hq/control/collaboration          bounded session list (COLLABORATION_READ_LIMIT=50, newest
                                            first, total + truncated), ?missionId= narrows, storePresent
GET  /api/hq/control/collaboration/room     ?missionId= — the Founder's Mission Room (404 unknown_mission)
GET  /api/hq/control/collaboration/context  ?sessionId=&collaborationRole=&taskId= — the bundle that role
                                            would receive (a Founder audit read; founder_only never travels)
POST /api/hq/control/collaboration          OPEN a session (201 / 200 deduplicated); requestedBy is the
                                            mapped principal; browser-guard scan of title + purpose first;
                                            optional privacy=internal|founder_only (default internal)
POST /api/hq/control/collaboration/admit    ADMIT a registered worker under collaborationRole (201 / 200)
```

There is deliberately NO route for `recordContribution`: a contribution is a worker act
under its own resolved identity, and a browser route would let the mapped Founder — or a
body — record under a worker's name. The same reason Phase 8 has no authorize/execute
route. The Mission Room read composes `missionBrowserView` (no intent bodies), the Phase 6
execution state, the sessions with participants, the bounded contributions with binding
and stances, the disagreements, the handoff requests beside the canonical claim, the truth
records about the mission and its linked tasks (founder_only INCLUDED — this route sits
behind the Founder gate, exactly as `GET /truth` does), pending `hq_approvals` rows on the
linked tasks, the newest orchestration runs and the newest external actions on the ledger
— every list bounded with its total. One status per cause: 404 `unknown_session |
unknown_contribution | unknown_mission`; 409 `session_closed | mission_terminal`; 403
`not_a_participant` and the existing authority codes (`not_permitted`,
`unknown_principal`, `capability_disabled`); 400 input, `client_identity_supplied` and
`unsafe_collaboration_content`. Session controls gain `collaborationCommand` (the originate
grant AND the intact row, enforcement-safe read).

Snapshot: an OPTIONAL `collaboration` section (`CollaborationSnapshotView`: `sessions`,
`withheldFounderOnly`, `withheldPurposes`, `activeSessions`, `workersAdmitted` (distinct),
`contributions`, `disagreements`, `handoffRequests`, and the newest
`COLLABORATION_SNAPSHOT_LIMIT`=20 session views). Optional
by shape for the truth section's reason; no `HQ_SNAPSHOT_VERSION` bump; a read-only
pre-Phase-9 file projects absence with provenance saying why. The section carries no
founder_only material, no raw intent body and no task payload (pinned) — a session view is
worker ids, roles, bindings, a title and counts.

**War-room material is classified** (L5, Founder decision). `hq_collab_sessions` carries a
`privacy` column using the EXISTING privacy vocabulary — literally `MEMORY_PRIVACY_LEVELS`,
the two levels truth and memory use — not a second privacy system and not a second
authority store. `openCollaborationSession({ …, privacy })` defaults to `internal`; the
control route accepts the same `privacy` body key the memory and truth routes already use
and 400s anything outside the vocabulary. `collaborationSummary({ includeFounderOnly })`
makes the reading layer's decision exactly as `truthSummary` does, and defaults to the
less-disclosing answer:

- the UNAUTHENTICATED artifact (`hq:snapshot`, the static build) carries no
  `founder_only`-classified session, counts the omission in `withheldFounderOnly`, and
  aggregates nothing else over the withheld sessions — their admitted workers and
  contributions are not in `workersAdmitted` / `contributions` / `activeSessions`, so
  arithmetic on the artifact discloses no categorical fact about a private room;
- no carried session publishes its free-text `purpose` verbatim on that artifact at all.
  The vocabulary has NO `public` level, so nothing is ever classified FOR publication to an
  unauthenticated reader; where the policy was ambiguous the less-disclosing answer was
  taken. The purpose is nulled, never rewritten, and the number nulled is stated in
  `withheldPurposes` and in the section provenance note rather than silently dropped;
- the Founder-gated `/state` route — the same `includeFounderOnlyMemory` flag that carries
  founder_only memory and truth — carries both the sessions and their purposes.

A pre-classification file is upgraded additively (`ALTER TABLE … ADD COLUMN privacy TEXT
NOT NULL DEFAULT 'internal'`, no row written, no trigger fired); a READ-ONLY pre-correction
file reports `internal` for its sessions (exactly what the ALTER would have written) and
still publishes no purpose. A present-but-unrecognised stored value reads as the MORE
private level.

Rooms (server-side `hydrate.ts`, present-only): the **Mission Room** gains five metrics —
`Collaboration sessions`, `Workers admitted`, `Contributions`, `Open disagreements`,
`Handoff requests` — and one row per carried session beside the mission rows. An explicit
disagreement or a handoff request is something the Founder decides on, so it lights
`attention`; a recorded contribution in an active session lights `active` (activity that
was RECORDED, never inferred); an admitted-but-silent session is `quiet`; nothing
collaboration-related lights an empty HQ. The room's `binding.source` names the section.

UI: projects.html gains the Mission Room collaboration console (`collaborationConsoleScript`):
a mount and a note in static markup, everything else script-created after a real
`/session` grant, textContent-only. For each mission with a session it renders the full
room read — canonical tasks with live claim / Founder assignment / eligible workers,
blockers and kill switches, admitted workers with the binding HQ recorded, disagreements,
handoff requests beside the canonical picture, the contributions with kind / worker / role
/ standing / binding / stances / truth-ref states / evidence refs, the truth records,
pending approvals, recent runs, external actions and the sessions. The open-session form
(mission select over the live non-terminal missions, title, purpose) and the per-session
admit form (registered worker id, role select) are drawn only under a granted
`collaborationCommand`. Fetch heads / postJson targets / path literals are allow-listed in
`control-console.test.ts` (pins updated); grant JS gains the one flag. Nothing animates and
no worker activity is invented: zero renders as an explicit zero.

## What is NOT here (deliberately)

No route for a worker to contribute (see Surfaces), and no CLI lane for it either: the
facade is the seam, and wiring the Claude dispatch/ingest lanes or any other worker lane to
`recordContribution` is a follow-up that must carry the worker's OWN resolved identity —
not something to bolt onto a Founder-mapped route. No automatic admission, no automatic
session creation on mission command, no timer, no daemon. No consensus rule of any kind:
agreement counts are shown, never acted on. No automatic handoff, no assignment written by
anything but the Founder's canonical act. No truth or memory write from any contribution.
No confidence, progress, ETA or activity numbers anywhere; the wire guards refuse them and
the section is pinned to carry no such key. No "chief of staff", no self-directed
objective creation — that is Phase 10 and is not started here. No per-role natural-language
context selection: the policy is a stated table.

## Known limitations (honest)

- **Contributions are proven through the facade only.** No real AI worker lane calls
  `recordContribution` yet; every contribution in the suites is recorded by a test acting
  as a registered worker. The architecture (identity, binding, membership, stances,
  handoffs, bundles) is proven; that a real Claude/Codex/Jules run produces one is not.
- **The model identity binding depends on a worker id equalling an AI member id.** The
  registry (`hq_ai_members`) and the execution directory (`hq_specialists`) are separate
  truths joined by id, as Phase 4 recorded. A deployment that registers members under
  different ids records `memberIdentityKey: null` (`declared_provider`) truthfully rather
  than guessing — but it also cannot refuse a wrong model declaration for that worker
  beyond "no registered identity". Recorded, not hidden.
- **The two provider vocabularies are not reconciled.** `CLAUDE` (routing) and
  `anthropic` (registry) are recorded side by side; nothing asserts they agree, because
  nothing canonical maps one to the other (the Phase 4 "disjoint vocabularies" note). A
  reconciliation table would be new authority and is a Founder decision.
- **The context-bundle policy table is a judgement, stated as code.** Which sections each
  role receives is a reviewed edit, not configuration; the Founder may want a different
  split. Every section is bounded and privacy-filtered regardless of the split.
- **The bundle's truth section reads the PRIVATE derivation** (corrected; see H1 in the
  table at the top and in the patchable-read audit). The claim this bullet previously made
  — that a forged public read "cannot reveal a real founder_only record" — was disproven by
  the hostile review and is not true of a wrapping patch. The room read is Founder-gated
  and carries founder_only truth by design, exactly as `GET /truth` does.
- **A session's privacy classification is metadata, not an enforcement mechanism by
  itself** — exactly what `memory/schema.ts` says of its own field. It is stored on the
  row; the reading layer enforces. Today one reading layer acts on it: the snapshot
  artifact. The Founder-gated room/list/context reads carry every session regardless of
  classification, which is correct (they are behind the Founder gate) but means a
  `founder_only` classification is currently an artifact-disclosure control and nothing
  wider. Stated, not implied.
- **The classification cannot be changed after a session is opened.** The table is
  append-only by engine, so a session opened `internal` stays `internal`; reclassifying
  would need a new session (or a deliberate future correction act). Chosen over inventing
  an UPDATE path into an append-only table.
- **`getMissionRoom` scans the ledger and the truth graph in memory** per read (the Phase 7
  / Phase 8 note). Fine at HQ scale; a large ledger would want indexed derivation.
- **A handoff's canonical picture is read at derivation time, not stored.** A request made
  while a task was claimed by A shows, after A releases and B claims, B — the request row
  never changes and the view always says what is true NOW; the request's `at` says when it
  was made. This is deliberate: storing a snapshot would present stale assignment truth.
- **Rooms are shown for the newest 12 missions with sessions** in the console (`ROOM_LIMIT`),
  stated on the page when more exist; the API list itself is bounded at 50 with the total.
- **The `status_report` kind carries free text only.** A worker may write "100% done" in
  it; the record shows the text as the worker's claim under the worker's name and derives
  no progress from it — no number leaves it, and the wire guard would refuse one.

## Deliberate pin ledger

Route table 28→32 (`live-control-api`, test renamed "thirty-two entries", four sorted paths
added), write surface 20→22 (`live-mission-routes`, plus two `toContain` and two
`not.toContain` lines), `control-console` fetch-head allow-list (+`COLLAB_PATH`,
`COLLAB_ROOM_PATH`), postJson allow-list renamed "the twenty-two write routes" (+`COLLAB_PATH`,
`COLLAB_ADMIT_PATH`), and three `*_PATH` binding pins for projects.html. The `hq:workforce`
CLI's fail-closed `REGISTRABLE` list gained the two collaboration ids (its existing "refuses
an id outside the trio" pin is unchanged and still refuses `infra.drop_index`). `CONTROL_GRANT_JS`
gained one flag (`collaborationCommand`); `CONTROL_FETCH_TARGETS` gained three paths. The
Mission Room's `binding.source` text was extended (no test pinned the exact string). No
test was deleted or relaxed; no `counts` pin, no `ROOM_SECTIONS` change, no
`HQ_SNAPSHOT_VERSION` bump, no change to `CLAIM_BOUND_EVIDENCE_KINDS` or the dispatch
evidence kinds, no change under `packages/server`.

Correction round (this commit): three existing pins were UPDATED to the new, correct
behaviour, none deleted or relaxed — `collaboration-context`'s worker `withheld` shape
(three assertions, L3: counts→categorical, with a new assertion proving the Founder audit
still gets exact counts) and `collaboration-durability`'s empty-summary `toEqual` (two
additive fields). The route table stays 32 and the write surface stays 22: the `privacy`
body key is an additive field on the EXISTING open route, not a new route. `CollaborationSessionView`
gains `privacy`; `CollaborationSnapshotView` gains `withheldFounderOnly` and
`withheldPurposes`; `CollaborationContextBundle.withheld` becomes the discriminated
`ContextWithheld`.

## Deployment runbook (configuration acts, never automatic)

1. `hq:workforce --local-admin --register-capability hq.collaboration_command` and
   `hq:workforce --local-admin --register-capability hq.collaboration_contribute` — both ids
   join the CLI's fail-closed `REGISTRABLE` list in this phase (pinned in `workforce-cli`).
   (Discovered, not fixed: the accepted Phase 7 runbook names `hq:workforce
   --register-capability hq.truth_record` / `hq.truth_verify`, but the CLI's list stops at
   the Phase 6 orchestrate trio on accepted main, so those two are registrable only through
   the module functions from a trusted composition root. Recorded here as Low debt for the
   next wave; the Phase 7 document is accepted and is not edited.)
2. Grant `hq.collaboration_command` in the Founder principal's `originateCapabilities`.
3. Grant `hq.collaboration_contribute` to each worker that should be able to contribute, via
   its directory allow-list — and declare its provider (`declareWorkerProvider`) and register
   its AI member identity under the SAME id if model truth should bind.
Until these acts happen every invocation fails closed (`unknown_capability` /
`not_permitted`).

## Evidence

New suites (all in `packages/headquarter/test/` unless stated): `collaboration-authority`
(21: session-references-one-mission incl. the no-status-column pin and derived closure;
Founder-only open/admit; both trios fail closed; fake/unknown/inactive/human workers refused
at admission and contribution; the ungranted refused; membership and role; canonical
binding for three worker shapes; wrong provider / undeclared / wrong version / no
registered identity refused; forged `listAiMembers`/`workerProviderDeclarations`/
`workers.allowedCapabilities` on instance and prototype changing nothing; impersonation
refused with the stored row and evidence naming the resolved actor; contributions leaving
every intent/task/approval/truth row byte-identical; three-worker consensus leaving truth
`claimed` with zero verification/acceptance rows and only `verifyTruth` moving it;
disagreement never outvoted, same-session stances only; handoff leaving claim/fence/
assignment untouched with `claimNext` still refusing, the Founder act alone changing the
picture, and every bad handoff refused; roles granting nothing; reference validity incl.
founder_only-as-unknown and the secret scan; three-way dedupe; engine immutability on all
four tables incl. every secondary unique index with `recursive_triggers` OFF; forged
`getMission`/`getCollaborationSession`/`lookupPrincipal`/`workers.isRegistered` on instance
and prototype), `collaboration-context` (11: the builder bundle's scope, bounds, no raw
rationale / no payload / no other session / no intentHistory; the planner bundle's withheld
founder_only memory and no unrelated mission; the reviewer bundle's internal-only truth and
no memory; who receives a bundle; assembly writes nothing and
repeats deterministically; **plus the six correction regressions** — H1's hostile
`listTruth` relabel patched on the instance AND the prototype, with the lie proven to have
taken on the public surface (a freshly constructed facade lies too), the real founder_only
record still absent from another worker's bundle, and `withheld` unforgeable; M2's
cancelled-mission close for a worker beside the Founder audit still reading it, the
disabled/drifted capability rows for both trios, the revoked directory grant and the
deactivated worker, and the hostile forge of `workers.allowedCapabilities` +
`queue.capabilities.get`/`.list` opening nothing; L3's categorical-vs-exact `withheld`
on both audiences; L4's byte-identical refusal for a real-but-not-mine session and a
session id that never existed, with the Founder path still distinguishing them),
`collaboration-durability` (2: real file close/reopen with the
room, session, summary and contributions identical, refusals identical, dedupe still
deduping; read-only pre-Phase-9 absence incl. the snapshot's absence note),
`live-collaboration-routes` (12: write surface; open attributed/dedupe/no key on the wire;
the `privacy` body key — default internal, founder_only accepted, anything else 400 with no
row written;
admit with `collaborationRole` and `role` refused as identity; no contribute route; the
room read's composition with no rationale/payload/idempotency on the wire and founder_only
truth carried past the gate; bounded list with `?missionId=` and `?principalId=` refused;
context audit with `role=` refused and founder_only never on the wire; one status per
cause; nobody/staff sweep; identity in body, mutations off, secret-like title; control
advertisement incl. withdrawal on a disabled row), `collaboration-surfaces` (6: optional
section absence; counts/bounds/both wire guards/no fabricated key/no private or raw text;
Mission Room metrics and liveness ladder; zero collaboration counts on a session-less
mission; **plus L5** — the unauthenticated artifact carrying no founder_only session, no
purpose text, aggregating over nothing withheld, stating both omissions in its provenance,
against a Founder-gated build that carries both; and the classification's validation,
conservative default, dedupe behaviour and append-only immutability),
`collaboration-console` (4, JSDOM against the real control API: inert static
markup; live zero with the open form only under grant; open + admit from the page then a
facade-recorded contribution and disagreement rendered with binding and standing;
non-Founder off and a Founder without the grant reading with forms off), `workforce-cli` (+1: both trios registrable
with their reserved contracts, one per run), and hq-host `host-contract` (+2: Fastify-wired
open/admit/room/context arc with `role` refused in body AND query and no contribute route;
NO_IDENTITY sweep of all five collaboration routes).
Full-matrix results are recorded in the builder's report and the wave PR; merge stays
gated on independent review and the Founder.
