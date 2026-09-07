# Phase 14 — Cost + Intelligence Optimization

Built on Phase 13 (`4a5671c`) on branch
`cloud/phase-13-14-reliability-cost-intelligence`, as the second half of the
Phase 13 + 14 wave. One document for the phase, in the Phase 5+6 / Phase 7 /
Phase 8 / Phase 9 / Phase 10 / Phase 11 / Phase 12 / Phase 13 style.

## What Phase 14 is

HQ uses the **lowest-cost intelligence that still meets the quality and safety
requirement**, and escalates when stronger intelligence materially improves the
outcome. That is value engineering, not "always cheapest", and it is not
possible without two other things: a truthful record of what HQ actually knows
about the models it uses, and a truthful record of what it actually spent —
including, loudly, the parts it does not know.

Two modules own it. `src/application/intelligence-command.ts` owns the
vocabularies (categorical only), the five INSERT-only tables, the keys, the
cost-fact lock, the routing policy, the escalation rule, the budget evaluation
and the analytics fold — all pure, all total functions over data.
`HeadquarterOperations` owns every gate, every write and every
enforcement-safe read, exactly as it does for every phase before this.

### What Phase 14 deliberately is NOT

- **Not a second provider truth.** `operator/provider-binding.ts` remains the
  one thing that decides who may execute a task. A routing decision RECORDS
  the binding HQ observed on the canonical payload; it never proposes a
  different one, and the routing surface has no provider or model parameter
  and no provider or model FIELD. A proposal that disagreed with a binding
  would simply be ignored by `OperatorQueue.claim`/`start`.
- **Not a second task truth.** `op_tasks` plus `ActivityStatus` stay the answer
  to "what is the state of this work". A decision row REFERENCES a canonical
  task and holds what none of them holds: which POLICY TIER the work was routed
  at, what floor its own characteristics imposed, and what it cost.
- **Not a spending authority.** There is no method, no route, no parameter and
  no field anywhere that activates a provider, enables a paid service, buys
  credits or authorizes spend. A ceiling BLOCKS or DEMANDS A DECISION;
  `grantsSpend` and `authorizesPaidActivation` are literal `false` on every
  answer, including `within_ceiling`.
- **Not a price list.** HQ records only what it OBSERVED. It has no rate card,
  no vendor pricing table, and no path that fills one in.
- **Not an execution seam.** No adapter handle, no endpoint, no payload, no
  model call. Nothing here opens a socket, reads an environment variable, names
  a paid service or adds a dependency.
- **Not a brand ranking.** No tier names a provider, a vendor or a model, and a
  test scans the vocabulary against every provider id in both registries.

## The model

### Intelligence tiers — policy categories, ordered by what they cost HQ

```
deterministic_local → low_cost → standard → high → critical_review
```

`deterministic_local` is first because it is the honest bottom of the order: a
local, free, deterministic path that costs nothing and leaves no data.
`critical_review` is last because it is reserved for work whose failure is
expensive to discover late — not because it is "the best".

### The routing policy, in four steps

1. **The FLOOR.** The highest of the complexity, context-size, work-kind and
   canonical-risk floors, plus the review requirement when there is one. That
   is the cheapest tier that still meets the requirement, and it is a
   computation over five stated tables rather than a slogan.
2. **The PRIVACY CAP.** `local_only` admits `deterministic_local` and nothing
   else. When the floor is higher, HQ refuses and NAMES the conflict
   (`privacy_requires_local_but_work_needs_more`) rather than quietly breaking
   one of the two rules.
3. **The PERMITTED SET.** The cheapest permitted tier at or above the floor
   wins — never one below it, because "cheapest" is bounded by "still meets the
   requirement" and never the other way round.
4. **The BUDGET.** `blocked` refuses outright. `requires_founder_decision`
   refuses nothing but marks the proposal as needing a human — except when the
   chosen tier is the free local one, which spends nothing and therefore needs
   no spending decision.

| Input | Floor it imposes |
|---|---|
| complexity `trivial` / `routine` / `substantial` / `novel` | local / low_cost / standard / high |
| context `small` / `medium` / `large` / `very_large` | local / low_cost / standard / high |
| work kind `classification`,`summarization` / `research`,`coding`,`planning` / `review` | local / low_cost / standard |
| risk `read_only` / `reversible` / `external_side_effect` / `destructive`,`founder_gate` | local / low_cost / high / critical_review |

**The risk class is not a caller parameter.** It is read from the task's
canonical capability, so a caller cannot describe risky work as harmless to get
a cheaper tier; an unreadable capability row fails closed to `founder_gate`,
the strictest class.

**Latency is recorded and currently discriminates between NO tiers.** HQ has
observed no latency for any tier, and ranking tiers by a latency nobody
measured would be exactly the invented measurement this repository forbids. It
is carried on every proposal with a statement saying so, and it becomes
discriminating when real observations exist. This is listed as debt below
rather than dressed up.

### The law: a cheaper tier never bypasses a required reviewer tier

The review requirement is derived from the canonical risk class
(`external_side_effect → high`, `destructive`/`founder_gate → critical_review`),
it is one of the terms the floor's `max` is taken over, and
`proposalSatisfiesReviewRequirement` is false for anything under it. The facade
ENFORCES it: `#resolveRecordedTier` refuses `review_tier_required` before it
refuses `tier_below_policy_floor`, because the floor already contains the
review requirement and a caller who only ever saw "below the floor" would never
learn the actual reason.

A recommendation still never bypasses canonical approval authority. This raises
a floor; it does not lower the Phase 8 gate, and the refusal text says so.

### The law: HQ never invents a price

`normalizeCostFact` is the single function every recorded amount passes
through, and it locks the amount and the provenance to each other in **both**
directions:

| Situation | Answer |
|---|---|
| `unknown` provenance carrying an amount | refused — `unknown_provenance_carries_amount` |
| `estimated`/`provider_reported`/`billed` with no amount | refused — `known_provenance_without_amount` |
| `estimated` with no stated BASIS | refused — an estimate whose origin nobody recorded is a fabrication with a label on it |
| amount not a whole number, negative, or beyond the bound | refused |
| amount with no currency, or a malformed one | refused — HQ never converts, so it cannot infer one |
| a legitimate unknown | `amountMinorUnits: null`, `state: 'unknown'` — **never zero** |

`readStoredCostFact` fails closed the same way, so an APPEND carrying a forged
provenance, a bad currency or a fractional amount reads back as `unknown` with
a null amount rather than as a figure HQ would then publish.

### The law: a ceiling blocks or asks, and never grants

| Situation | `evaluateBudget` | Why |
|---|---|---|
| no ceiling recorded for the scope | `requires_founder_decision`, permitted set = the free local tier alone | absence of a policy is not permission |
| any entry in the window with an unknown amount | `requires_founder_decision` | HQ cannot prove it is under a ceiling it cannot measure against |
| any entry in another currency | `requires_founder_decision` | converting would need a rate HQ has not observed |
| observed ≥ ceiling | `blocked` | |
| otherwise | `within_ceiling` | a statement that the ceiling has not been reached — **not** permission to spend |

`grantsSpend: false` and `authorizesPaidActivation: false` are literals on every
branch, including the last one. With no budget ever recorded, the permitted set
is `DEFAULT_PERMITTED_TIERS` — `['deterministic_local']` — so a deployment that
has never had a Founder policy written routes to local intelligence or asks a
human, and never silently to a paid one.

### The law: an escalation preserves canonical identity and creates no authority

`escalateIntelligenceDecision` takes a decision id and a trigger. It has **no
task, mission or project parameter**: the identity is read off the prior
decision, so an escalation is structurally incapable of moving work to
different canonical work. It moves strictly UP the tier order, only inside the
permitted set, and refuses (`already_at_highest_tier`,
`no_higher_permitted_tier`, `budget_ceiling_blocks`,
`prior_decision_has_no_tier`) rather than inventing a tier. `grantsAuthority`
and `authorizesSpend` are literal false on the escalation, and the claim it is
recorded under is the same claim.

### Analytics: only what was observed

- **Escalation rate** is published as an exact `numerator` over an exact
  `denominator`. HQ publishes no percentage there: over a small denominator a
  percentage reads as a measurement, and this is a count of rows.
- **Spend** is folded per identity **and per currency**, because HQ never
  converts and a sum across two currencies would be a fabricated number. There
  is deliberately no single grand total.
- **Unknown-amount entries** are their own count beside every sum, never folded
  in and never rendered as zero.
- **Provably avoidable** counts a decision only when all four hold from
  recorded data: it was issued strictly above the floor the policy itself
  computes for the characteristics recorded ON it, it was not an escalation, no
  reviewer tier was required, and its recorded result is `quality_met`. The
  floor is RECOMPUTED from the characteristics rather than trusted from the
  stored column, so a forged append can neither hide nor manufacture a finding.
  It is a statement about HQ's own policy, not a claim about what a cheaper
  model would have produced — HQ never ran one, and the statement on the view
  says so.

## Authority

| Act | Authority | Why that one |
|---|---|---|
| `recordModelObservation`, `setIntelligenceBudget` | the `hq.intelligence_command` Founder-gate trio | declaring what a model costs, and what may be spent against it, are Founder statements |
| `recordIntelligenceDecision`, `escalateIntelligenceDecision`, `recordIntelligenceOutcome`, `recordIntelligenceCost` | the LIVE FENCED CLAIM on the referenced canonical task, read straight off `op_tasks` through `#db` | the worker carrying the work is the one entity that can honestly say which tier it used and what it spent. It grants nothing: holding a claim already allows execution; this only lets it record |

The claim read is enforcement-safe: a forged `queue.get` on the instance AND on
`OperatorQueue.prototype` is proven to take, and to buy no decision write and
no cost write on either — while the legitimate claim still works, so the patch
changed nothing at all. Approval authority is deliberately NOT intelligence
authority: the `coo` principal holds the first and is refused the second.

## The enforcement-safe read audit

| Read | Reads through | Decides | Status |
|---|---|---|---|
| the claim on the referenced task | `#runClaimFact` — a direct `#db` SELECT of `op_tasks`, deliberately NOT `queue.get()` | whether any decision, outcome or cost row is written | canonical. Pinned against a patch on instance and prototype. |
| the CURRENT budget ceiling and permitted tier set | `#budgetFromStore` → `loadBudgets` off `#db`, then `latestBudgetFor` | whether a tier may be recorded at all, and which ones | canonical. Pinned: a forged `intelligenceBudgetDecision`/`listIntelligenceBudgetsBounded` lies publicly and buys no write, on instance, prototype and a later-constructed facade. |
| the recorded cost entries in the window | `#costEntriesFromStore` / `#entriesForScope` | whether the ceiling is reached, and whether HQ can prove it | canonical, and fail-closed on an unknown amount. |
| the task's canonical RISK CLASS | `#capabilityFromStore` (the existing `#private` closure), never `queue.capabilities` | the floor and the review requirement | canonical, and fail-closed to `founder_gate` on an unreadable row. |
| the prior decision, for an escalation | `#decisionRecordFromStore` — `loadDecision`/`loadDecisionOutcomes` off `#db` | the canonical identity the escalation carries, and the tier it moves from | canonical. Pinned: a forged `getIntelligenceDecision` buys no escalation. |
| the provider BINDING on the task | a direct `#db` SELECT of `op_tasks.payload` through `readProviderBinding` | what a decision RECORDS as the bound provider | canonical, and the same function the queue's own enforcement uses. |
| the intelligence-command capability row | `#capabilityFromStore` | whether an observation or a budget policy may proceed | canonical, unchanged from the Phase 4/5/7/12/13 pattern. |
| the SAFE-MODE verdict | the `#private` `#integrityReport` field (Phase 13) | whether any Phase 14 write proceeds | canonical, inherited unchanged. |
| the ledgers, for the unauthenticated snapshot | `#listDecisionRecordsFromStore`, `#costEntriesFromStore`, `#observationsFromStore` — deliberately NOT the bounded public reads | what `hq-snapshot.json`'s `intelligence` section publishes | canonical. Pinned against a forged public read. |
| store presence | the constructor's `#intelligenceStorePresent` flag | whether a 0 means "absent" or "empty" | canonical, observed, never migrated. |

## Safe mode

Phase 13's posture gates every Phase 14 write — the decision, the escalation,
the outcome, the cost entry, the observation and the budget policy all refuse
`safe_mode_engaged` while HQ cannot stand behind its own stored record. Every
Phase 14 READ stays available, because a Founder who cannot see what was spent
cannot govern it. Proven against a real file with a real dropped guard.

## Privacy: what crosses to the unauthenticated artifact

`hq-snapshot.json` gains ONE optional section, `intelligence`, with exactly
fifteen keys: `storePresent`, `observations`,
`observationsWithKnownUnitCost`, `observationsWithUnknownUnitCost`,
`decisions`, `byTier`, `byState`, `byResult`, `escalations`, `costEntries`,
`byCostProvenance`, `unknownAmountEntries`, `budgetsRecorded`,
`tierPolicyRecorded`, `note`.

**No** amount, currency, ceiling, provider id, model id, task/mission/project
id, decision id, label, basis or note. That is not a redaction, it is the
SHAPE: the view has no numeric money field and no free-text field, so there is
nothing to leak and nothing a reader could mistake for a spend figure. Pinned
by the exact top-level key set and by a whole-artifact scan for every one of
those values on a populated snapshot.

The four MAPS are closed **by construction** — the Phase 12 lesson applied
without having to relearn it. Every increment passes a membership check and the
CHECKED value is the key. Pinned with a raw append carrying
`SUPER SECRET TIER NAME`: the text appears nowhere in the artifact, the count
lands in `unrecognized`, every count is an integer, and the map total equals
what was folded.

`unknownAmountEntries` DOES cross, and that is the deliberate exception. A
reader shown a tidy count of recorded costs with no indication that some of
them have no known amount has been given a false impression of how well HQ
knows what it spends.

The section is additionally asserted against `assertNoFabricatedFields` on a
POPULATED artifact. That guard refuses a field literally named `cost`, `spend`,
`tokens`, `promptTokens` or `eta`; a cost phase is the likeliest phase ever to
trip it, so the field names are `amountMinorUnits`, `unitsObserved` and
`unitKind`, and the guard is proven rather than assumed. Token counts are
carried as the VALUE of `unitKind`, never as a key.

No `HQ_SNAPSHOT_VERSION` bump (the section is optional and additive).

## Surfaces

Routes (the unchanged pipeline — origin/referer, identity scan of body AND
query, Founder resolution, `safe()`; route table **44 → 47**, write surface
**28 → 30**):

```
GET  /api/hq/control/intelligence          posture, ledgers, analytics, vocabularies
POST /api/hq/control/intelligence/observe  record a model/provider observation
POST /api/hq/control/intelligence/budget   set a ceiling and a permitted tier set
```

The GET is a pure read: it records nothing, latches nothing and contacts
nothing. Proven by calling it twice and watching the evidence watermark not
move.

**What has no route, and why.** Recording a routing decision, escalating one,
recording its outcome and recording a cost entry are WORKER acts under a live
fenced claim — exactly like authorize and execute in Phase 8 and the run writes
in Phase 13 — and a browser holds no claim. And there is no route, no facade
method and no path SEGMENT anywhere in the whole control table that spells
`activate`, `spend`, `purchase`, `buy`, `credits`, `billing` or `upgrade`. Ten
invented paths 404.

Neither write takes step-up, and that is a decision: both append to an
append-only ledger, neither can execute anything, and a ceiling that has to be
lowered urgently should not need a fresh credential to lower.

`/session` gains one flag, `intelligenceCommand`, advertised as a FACT about
the principal rather than as a button — a console that could not see the
capability was missing would have no way to explain why the control it was told
to use does not exist. There is deliberately no spend flag and no activation
flag, because there is no such act to grant.

UI, rooms and the spatial shell: **deliberately unchanged.** No `ROOM_SECTIONS`
change, no `hydrate.ts` change, no `rooms.ts` change, no console change. A cost
console is a real thing to want, and it is honestly absent rather than
half-built.

## What is canonical vs derived

| Canonical (written here) | Derived (never stored) |
|---|---|
| `hq_intel_model_observations` — INSERT-only observations, with provenance | the cost STATE (`known`/`unknown`), read from the amount |
| `hq_intel_budgets` — INSERT-only versioned ceilings and tier policies | the CURRENT ceiling (the highest version), and the budget decision |
| `hq_intel_decisions` — INSERT-only routing decisions | the decision `state`, `result`, `escalatedAwayTo`, `satisfiesReviewRequirement` |
| `hq_intel_decision_outcomes` — INSERT-only, one per decision by key | every routing proposal, floor, consideration and escalation |
| `hq_intel_cost_entries` — INSERT-only observed usage/cost | every analytics figure and every snapshot count |

| Canonical (referenced, never written by this phase) |
|---|
| `op_tasks` (the claim, the capability, the provider binding) — read to authorize a write and to record the observed binding; never created, moved, released or re-bound here |
| `op_capabilities` — read for `risk_class`; never written |
| `hq_missions`, `hq_projects`, `hq_action_intents`, `hq_approvals` — referenced by id at most, never written |

Each write commits its row, its `hq_events` audit entry and its `op_evidence`
entry in ONE reservation.

## Verification actually run

| Command | Result |
|---|---|
| `npm run test:hq` | 161 files, 3026 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root, `@factoryos/server`) | 37 files, 569 passed, 3 skipped |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |
| `npm run build` | all workspaces built; web initial JS 215.66 kB / 69.22 kB gzip (unchanged) |

Baseline after Phase 13 was 157 files / 2917 tests; the accepted base was 152 /
2810. Phase 14 adds 109 tests across four new files plus one shared fixture.
The three skipped tests under `packages/server` are pre-existing `it.skip` GAP
markers, untouched — nothing under `packages/server`, `packages/web`,
`packages/shared` or `packages/config-mesob` was changed.

### What the tests actually prove

- **No silent model substitution.** A task bound to `CLAUDE` is recorded with
  `boundProvider: 'CLAUDE'`, the payload binding is byte-identical afterwards,
  and a `GEMINI`-declared worker is still refused the task with "No
  substitution is made" while the bound provider's worker still claims it.
- **Unknown cost stays unknown.** Through the facade, through the analytics,
  through the Founder-gated route, through the snapshot, and across a real
  restart over a real file: `null`, never `0`.
- **A budget ceiling blocks a paid act or requires a decision.** A ceiling
  reached refuses the decision write with `budget_ceiling_blocks`; one unknown
  entry anywhere in the window turns `within_ceiling` into
  `requires_founder_decision`.
- **Escalation preserves canonical task identity.** Same task, mission and
  project; the method has no parameter that could change any of them.
- **A cheaper tier cannot bypass a required reviewer tier.** `low_cost` on an
  `external_side_effect` task is refused `review_tier_required` by name.
- **A local model is accepted when policy permits.** Read-only work routes to
  `deterministic_local` and RECORDS there with no budget policy at all — the
  local path is not decorative.
- **No fabricated usage or cost.** An estimate with no basis is refused at the
  facade and at the route; the populated artifact passes
  `assertNoFabricatedFields`.
- **Restart durability.** Every ledger, the analytics and the budget decision
  read back identically from a second facade over the same file.

## What is NOT built (deliberately)

- **No model call, no adapter, no endpoint, no dependency.** Nothing here
  contacts anything.
- **No provider activation, no paid-service enablement, no credit purchase, no
  billing integration.** Not a method, not a route, not a field.
- **No automatic routing.** Nothing in HQ calls `intelligenceRoutingProposal`
  on its own; no lane opens a decision automatically. See the debt below.
- **No price catalogue.** HQ holds observations, not a rate card.
- **No currency conversion, ever.**
- **No cost console, no CLI, no spatial room, no snapshot version bump.**

## Known limitations (honest)

- **Nothing in HQ records a routing decision automatically yet.** The ledger is
  written through the worker-fenced facade methods, and no in-process lane
  calls them. This is the same shape as Phase 13's un-wired run ledger and the
  same deliberate cost: not changing the dispatch and orchestration paths in
  the same wave that introduced the ledger. It is the most likely thing a first
  real user will notice.
- **Latency discriminates between no tiers.** Recorded, published, and stated
  as changing nothing, because HQ has observed no latency. It becomes real when
  latency observations exist on model observations, and not before.
- **Availability and reliability observations are recorded but do not yet
  influence a proposal.** `MODEL_AVAILABILITY_STATES` is stored per observation
  and counted in the analytics; the routing policy does not read it, because
  reading a possibly-stale availability to exclude a tier would be a decision
  taken on an observation HQ cannot date-check. Stated rather than half-wired.
- **The budget window is a PREFIX comparison on the recorded instant.** A `day`
  ceiling counts entries whose ISO instant starts with today's date, and a
  `month` ceiling this month's. That needs no timezone rule and no arithmetic,
  and it is UTC by construction — a deployment whose accounting day is not UTC
  would want a stated timezone, and does not have one.
- **`provablyAvoidable` is a statement about HQ's own policy.** It never claims
  a cheaper model would have produced the same result; HQ did not run one.
- **The analytics derive every decision's whole record per call**, exactly as
  `listProducts` and `listRuns` do. Fine at HQ scale; a large ledger would want
  an indexed derivation.
- **A decision, an observation and a cost entry cannot be corrected in place.**
  The registers are append-only; a mistaken figure is permanent and is
  superseded by a further append rather than edited.
- **Nothing here has been exercised by a real AI worker lane.** As with Phases
  9 through 13, every canonical act in these suites is performed by a test
  acting as the Founder or as a registered worker.
- **`hq.intelligence_command` is not registered automatically.** A deployment
  that wants the two Founder acts calls
  `registerIntelligenceCommandCapability`; until then both fail closed.

## The `assertBrowserSafe` pre-real-adapter Low — exactly what was resolved

**The recorded fact.** On the Phase 11 search / Ask Jenify path,
`assertBrowserSafe` scanning of the free text (`text`, `project`, `tag`,
`question`) was enforced **at the browser route only**, and the
`RetrievalAdapter` seam (`SEMANTIC_RETRIEVAL_ADAPTERS`, empty,
`fallbackReason: 'no_adapter_installed'`) is what a real semantic retriever
would plug into. That was safe exactly while the adapter set was empty — the
one installed adapter is a local inverted index that transmits nothing — and it
stops being safe the day a real adapter exists, because a semantic retriever is
a thing that SENDS the query somewhere and an in-process facade caller (a CLI,
a lane, an orchestrator) bypasses the route entirely.

**Why it became urgent here.** Phase 14 is precisely the layer that would
introduce a real adapter: it is the registry and routing layer for the models
such an adapter would call.

**What was done — closed structurally, in two places.**

1. **At the seam.** `guardRetrievalAdapter` wraps an adapter so it scans the
   free text it is about to be handed before it delegates, and
   `resolveRetrievalAdapter` now returns a guarded wrapper in **every** branch
   — the deterministic one, an installed semantic one, and the fallback. There
   is therefore no code path through the resolver that yields an unguarded
   adapter, an in-process caller cannot obtain one, and an adapter added to
   `SEMANTIC_RETRIEVAL_ADAPTERS` later cannot opt out by being added to the
   list. The wrapper is transparent in every other respect (same id, mode,
   availability, reason), so nothing downstream gains a reason to reach for the
   unguarded object.
2. **At the facade.** `searchCompany` and `askJenify` scan `text`, `project`,
   `tag` and `question` on the way in and return a stated `invalid_input`
   refusal, so an in-process caller gets a good error instead of an exception
   from deep inside a retrieval. The scan runs BEFORE `normalizeSearchQuery`,
   which echoes `project` and `tag` verbatim into `criteria` — so the material
   never reaches a structure at all.

The route's own scan is **unchanged**: it has a better refusal to give
(`400 unsafe_query`, audited as refused rather than allowed), and it stays as
the outer layer.

**Pinned by** `test/search-adapter-guard.test.ts` (9 tests). The load-bearing
assertion is not that the guard throws — it is that a recording stand-in
adapter, the thing the seam exists for, is **never called at all** with
credential-shaped terms. Every branch of the resolver is exercised, the facade
refusals are proven for all four fields, and an ordinary search and an ordinary
question are proven still to work, so the guard did not narrow the surface it
protects.

**What was NOT resolved.** The scan is credential-SHAPE based
(`assertBrowserSafe`'s key rule and value patterns); it is not a general
data-loss-prevention filter and will not recognise a secret that looks like
ordinary prose. The corpus documents handed to an adapter are deliberately not
scanned — they are canonical rows HQ has already decided this reader may see,
and re-scanning them would be a second, drifting disclosure rule. And no real
semantic adapter exists to test against: what is proven is that the seam cannot
be reached with unscanned text, not that any particular future adapter is safe
in other respects.

## Carry-forward Low debt

**From Phase 11/12, unchanged and still open** — recorded rather than restated
as fixed, because this phase did not touch any of it: lexical-only retrieval,
loose `any_term` question retrieval, the query-independent withheld count, the
absent `hq_specialists` timestamp, the in-memory corpus scan, the product-edit
gap, and the absent `founder_only` product level.

**From Phase 13, unchanged and still open**: the un-wired run ledger, the
assess-on-demand rather than continuous integrity posture, the unbounded tamper
window, and the currently-unreachable independence guard in `reconcileRun`.
None of the four was touched here, and none is reported as fixed.

**Resolved by this phase**: the pre-real-adapter `assertBrowserSafe` Low, as
described above and in exactly the scope described.

**New Low debt from this phase**: the un-wired decision ledger, the
non-discriminating latency requirement, availability observations that do not
yet influence a proposal, the UTC-prefix budget window, and the per-call
analytics derivation — all five listed under limitations above.

## Deliberate pin ledger

Route table 44 → 47 (`live-control-api`, test renamed "forty-seven entries",
three sorted paths added, reasoning recorded in the test). Write surface 28 →
30 (`live-mission-routes`, two `toContain` lines plus one `not.toContain` for
the read, length 28 → 30). `/session` gained one flag, `intelligenceCommand`.
`ENGINE_IMMUTABLE_TABLES` gained five entries, which is what Phase 13's
schema-catalogue check demanded of any new append-only ledger — the check
failed first, which is the guard working. `providers/contracts.ts` gained
`PROVIDER_HEALTH_STATES` as the runtime array behind the existing
`ProviderHealth` type; the type's members are unchanged.

No `HQ_SNAPSHOT_VERSION` bump, no `ROOM_SECTIONS` change, no
`CONTROL_FETCH_TARGETS` change, no console change, no CLI change, and no change
under `packages/server`, `packages/web`, `packages/shared` or
`packages/config-mesob`.

**No existing test was deleted, skipped, weakened, narrowed or relaxed.** The
only two existing tests touched are the two deliberate count pins above, and
both were widened with the reasoning recorded in the test itself.

`Phase 10`'s assertion that no facade method name matches `/recommend/i` is
untouched and still holds: this phase's proposal-shaped reads are named
`intelligenceRoutingProposal` and `escalateIntelligenceDecision`, for the same
reason Phase 12 named its template `productPlanTemplate` — a recommendation
must never look like a handle on an act.
