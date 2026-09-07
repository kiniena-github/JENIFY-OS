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

**What a RAW WRITER can still do to a budget, stated rather than left for a
reader to find** (recorded by the Wave 5 review; not a defect, and not
previously written down). `hq_intel_budgets` is append-only and versioned, and
`latestBudgetFor` takes the highest `version`. So a writer with direct file
access — not HQ, not any route, not any facade method — can WIDEN policy by
APPENDING a higher-version row with a looser ceiling and a broader permitted
set. That is inherent to append-only versioning under a raw-writer threat: the
guards make an existing row unchangeable, they do not and cannot make a new
legitimate-looking append impossible, and the same is true of every versioned
append-only register in this repository. What the guards DO close is the
quieter attack — an `INSERT OR REPLACE` colliding on `budget_key`, which would
swap a standing ceiling with no new row for anyone to notice — and that is now
pinned (see the correction pass below). A widening append leaves a row, with
its version, its `set_by` and its `set_at`, for a Founder to see.

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
  in and never rendered as zero. `foldSpend` used to be the one exception:
  an identity with no known amount rendered `knownAmountMinorUnits: 0` under a
  synthetic `currency: "unknown"`. Nothing was fabricated — the zero was
  arithmetically true and `unknownAmountEntries: 1` stood beside it — but a `0`
  next to an identity HQ has no amount for is exactly the reading this phase
  exists to prevent, and `"unknown"` is not a currency code. Both fields are now
  `null` in that group (Wave 5 LOW 6), and the known and unknown halves of one
  identity stay separate groups so only the known one ever carries a number.
- **Provably avoidable** counts a decision only when all four hold from
  recorded data: it was issued strictly above the floor the policy itself
  computes for the characteristics recorded ON it, it was not an escalation, no
  reviewer tier was required, and its recorded result is `quality_met`. The
  floor is RECOMPUTED from the characteristics rather than trusted from the
  stored column. **Stated exactly** (Wave 5, MEDIUM B-3): recomputing from
  `decision.characteristics` RELOCATES the forgery rather than closing it —
  `characteristics` is a stored column on the same append-only table. What
  closes it is upstream: `deriveDecisionRecord` re-derives the `riskClass` half
  from `op_tasks`/`op_capabilities`, and the review requirement is the STRONGER
  of the stored one and the one the canonical risk class imposes, so a forged
  NULL cannot drop it. The remaining terms — complexity, context size, work kind
  — are descriptions of the work HQ has no canonical source for, and a forged
  row can still understate those. That is recorded debt, not a closed hole.
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
| WHICH budget policies govern a piece of work | `#governingBudgetScopes` — the deployment baseline, plus the task's canonical missions and projects off `hq_mission_plan_items`/`hq_missions`, plus `#taskBoundProvider`, all through `#db` | which ceilings a decision write is enforced against at all | canonical **since the Wave 5 correction of HIGH B-1**; it was previously an optional `budgetScope` ARGUMENT taken verbatim, so the caller chose the policy governing its own write. |
| the CURRENT budget ceiling and permitted tier set | `#budgetFromStore` → `loadBudgets` off `#db`, then `latestBudgetFor`, folded by `combineBudgetEvaluations` | whether a tier may be recorded at all, and which ones | canonical. The most restrictive DECISION and the INTERSECTION of permitted tiers stand. Pinned: a forged `intelligenceBudgetDecision`/`listIntelligenceBudgetsBounded` lies publicly and buys no write, on instance, prototype and a later-constructed facade. |
| a STORED budget row's scope, window and ceiling | `rowToBudget`, fail-closed | whether a row governs anything at all | canonical **since HIGH B-4**; a scope or window outside the vocabulary reads as `unrecognized` and matches nothing, and a ceiling that is not a whole non-negative number reads as `null` and answers `requires_founder_decision`. It used to coerce them to `deployment`/`total` and `NaN`. |
| the mission and project a decision or cost entry is ATTRIBUTED to | `#canonicalTaskScopes` — `hq_mission_plan_items` joined to `hq_missions`, through `#db` | whose ceiling the spend counts against | canonical **since HIGH B-2**; both were caller parameters written verbatim, and neither was checked for existence. |
| the provider a COST ENTRY may name | `#taskBoundProvider`, compared against the supplied `providerId` | whether the entry is recorded at all | canonical. A contradiction is `provider_binding_mismatch`, the same refusal the queue's claim/start enforcement gives. |
| a decision's `boundProvider` and risk class, at READ time | `deriveDecisionRecord`'s `canonical` resolver — `#taskBoundProvider` and `riskClassForRouting(#capabilityFromStore(...))` | what the Founder route publishes, and what the avoidable-spend derivation computes its floor from | canonical **since MEDIUM B-3**; both were stored columns on an append-only table read back verbatim. |
| the recorded cost entries in the window | `#costEntriesFromStore` / `#entriesForScope` | whether the ceiling is reached, and whether HQ can prove it | canonical, and fail-closed on an unknown amount. |
| the task's canonical RISK CLASS | `#capabilityFromStore` (the existing `#private` closure), never `queue.capabilities` | the floor and the review requirement | canonical. The fail-closed default for an UNREADABLE row is `riskClassForRouting`, and it is now asserted directly — it was listed here as verified while nothing reached it (Wave 5 LOW 5). |
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
in Phase 13 — and a browser holds no claim. There is no route and no path
SEGMENT anywhere in the whole control table that spells `activate`, `spend`,
`purchase`, `buy`, `credits`, `billing` or `upgrade`, and ten invented paths
404.

**Correction to the same claim about FACADE METHOD NAMES** (Wave 5 review,
informational). Commit `fdfa1e0`'s message says "no route, no facade method …
spells activate, spend, purchase, buy, credits, billing or upgrade". The route
half is exact. The facade half is not: `deactivateExecutionWorker` — a Phase 4
workforce lifecycle method that REMOVES a worker's ability to execute — contains
the substring "activate". A pushed commit message cannot be amended, so the
claim is corrected here, scoped to what is actually true: **no facade method
activates a provider, enables a paid service, buys credits or authorizes spend,
and no Phase 14 method name contains any of those seven words.** The one
pre-existing method whose name contains the substring moves in the fail-safe
direction.

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
2810. The four Phase 14 test files plus `intelligence-durability.test.ts` and
`intelligence-attribution.test.ts` now hold 126 tests. (`c9ddecc`'s claim of
"109 tests across four new files" was 111 at that head and is corrected here
rather than left standing — Wave 5, LOW B-9.)
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
  reached refuses the decision write with `budget_ceiling_blocks` **when a tier
  is explicitly supplied**; with the tier omitted the proposal simply names no
  admissible tier and the refusal is `intelligence_routing_refused`. Both are
  refusals and neither records anything, but they are different codes and this
  line used to name only the first (Wave 5, LOW B-9). One unknown entry anywhere
  in the window turns `within_ceiling` into `requires_founder_decision`.
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
- **A second escalation with a DIFFERENT trigger dedupes to the first.**
  `decisionIdempotencyKey` deliberately excludes the trigger, so the same
  escalation re-recorded is one row — which is the point of an idempotency rule
  over an append-only ledger. What follows is that the second caller's trigger
  is not what HQ holds, and the returned view now says so: it carries the
  STORED trigger (Wave 5 LOW 4). If a deployment ever needs two escalations of
  one decision under different triggers, the key is the thing to widen, and
  that would be a deliberate change to what "the same escalation" means.
- **`byCostProvenance.unrecognized` is unreachable through the stored reader.**
  `readStoredCostFact` already coerces an out-of-vocabulary provenance to
  `unknown`, so no ROW can land in that bucket; the membership re-check catches
  only a caller passing a raw fact directly. The bucket is kept — the key set is
  a published shape guarantee and the fold must stay closed by construction
  independently of its reader — and the comments now describe it as that rather
  than as a live defence (Wave 5 LOW 7). The tier, state and result buckets ARE
  reachable from a stored row, and that asymmetry is now pinned by a test. The
  same class of finding was recorded in Wave 4 as `byLifecycle.unrecognized`
  and deliberately left open; this pass corrected the wording here and did NOT
  touch that one, so the two now differ in wording while agreeing in behaviour.

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

**Pinned by** `test/search-adapter-guard.test.ts` (12 tests). Every branch of
the resolver is exercised, the facade refusals are proven for all four fields,
and an ordinary search and an ordinary question are proven still to work, so the
guard did not narrow the surface it protects.

> **Correction (Wave 5 review, MEDIUM finding C-2).** The claim "an in-process
> caller cannot obtain an unwrapped adapter" was made on the RESOLVER and was
> false of the MODULE: `LEXICAL_RETRIEVAL_ADAPTER` and
> `SEMANTIC_RETRIEVAL_ADAPTERS` were exported raw, `application/index.ts`
> re-exported them, and `search-core.test.ts` already called
> `LEXICAL_RETRIEVAL_ADAPTER.retrieve(...)` unwrapped. The day a real
> transmitting retriever joined the semantic list,
> `SEMANTIC_RETRIEVAL_ADAPTERS[0].retrieve({terms})` would have been a one-line
> public bypass. Fixed structurally rather than by deleting the sentence: the
> raw adapters are module-private, every exported binding is the GUARDED
> wrapper, the semantic list is guarded member by member at declaration and
> frozen, and `guardRetrievalAdapter` is idempotent so the resolver does not
> double-wrap. There is now no exported binding through which an unguarded
> `retrieve` can be reached.

**Which of the two layers is the guarantee — corrected** (Wave 5 review, LOW
finding 3). The sentence above used to end "Both layers are kept: the outer one
gives a good error, the inner one is the guarantee", and commit `0c5edea`'s
message said "a test proves the wrapped adapter is never CALLED with
credential-shaped terms". The structural claims all hold — every resolver branch
returns a wrapper, an in-process caller cannot obtain an unwrapped adapter, and
a recording stand-in got zero calls — but the ATTRIBUTION was the wrong way
round, and it is now stated as it is:

- `guardRetrievalAdapter` scans `input.terms`. On the pipeline path those terms
  are always `tokenize()` output, which lowercases and splits on `[^a-z0-9]+` —
  stripping every separator the eleven `SECRET_VALUE_PATTERNS` require (`sk-`,
  `ghp_`, a JWT's dots, `Bearer `, `api_key: `). **The seam scan therefore does
  not fire on those shapes once the pipeline has tokenized them.** The test that
  fed it a whole unsplit key was feeding it an input the pipeline cannot
  generate. *(Narrowed by the Wave 5 correction of LOW C-2: the sentence used to
  add "and defeating the case-sensitive ones besides" and to claim the seam is
  inert on anything the pipeline can produce. The patterns are case-insensitive
  now, so a shape with NO separator — a Google API key — survives tokenization
  apart from case and IS caught at the seam. Two separate tests say which is
  which.)*
- **The FACADE scan is the guarantee** for the pipeline, and the route's scan
  is the outer layer beyond it. Both see the raw field before normalization and
  before tokenization, which is where a credential is actually met.
- **The seam guard is defence in depth against a non-tokenized caller**, and
  that caller is real: `resolveRetrievalAdapter` is exported, so an in-process
  caller can obtain an adapter and hand it terms it built itself. That is worth
  guarding; it is not the layer the pipeline relies on.

`RETRIEVAL_GUARD_STATEMENT`, the module comments and the test names all say this
now, and a new test PINS the tokenization fact itself against six real
credential shapes — each refused at the facade, each inert at the seam once
tokenized — so the claim cannot quietly become wrong again in either direction.

**What was NOT resolved.** The scan is credential-SHAPE based
(`assertBrowserSafe`'s key rule and value patterns); it is not a general
data-loss-prevention filter and will not recognise a secret that looks like
ordinary prose. **A credential SPLIT ACROSS TWO FIELDS passes both scans** —
`?text=sk-&project=AAAAAAAAAAAAAAAAAAAAAAAA` was verified to pass at the route
and at the facade, and the pieces are then echoed into `criteria` (Wave 5, LOW
C-1). Each field is scanned independently, and joining them for the scan would
either miss the same split (if joined with a separator) or manufacture false
refusals (if joined without one), so this is recorded rather than papered over. The corpus documents handed to an adapter are deliberately not
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

---

## Wave 5 correction pass (this branch, on top of `c9ddecc`)

A separate fresh read-only hostile reviewer returned CHANGES REQUIRED —
0 Critical / 1 High / 1 Medium / 6 Low — against the frozen wave head. Every
finding that touches Phase 14 is corrected in place above, in the section it
belongs to. This table says where, and what now pins each one.

| Finding | Correction | Pinned by |
|---|---|---|
| MEDIUM 2 — the five secondary-unique guards were unpinned, and the census could not see them | `ENGINE_IMMUTABLE_TABLES` now declares each table's `secondaryGuards` and `missingImmutabilityGuards` reads them, so a dropped one produces a real `append_only_guard_missing` finding and engages safe mode | new `test/intelligence-durability.test.ts` (7 tests) and three new tests in `reliability-durability.test.ts` |
| LOW 3 — the seam guard's scan is inert on tokenized terms | "The `assertBrowserSafe` pre-real-adapter Low" above, rewritten to name the FACADE scan as the guarantee | two new tests in `search-adapter-guard.test.ts`, one of which pins the tokenization fact against six real credential shapes |
| LOW 4 — the returned escalation trigger could contradict the record | "Known limitations", and the facade now returns the STORED trigger | new test in `intelligence-authority.test.ts` |
| LOW 5 — the `founder_gate` fail-closed default was unpinned | extracted as `riskClassForRouting`; audit row corrected | new unit test in `intelligence-core.test.ts` |
| LOW 6 — `foldSpend` rendered `0` for an unknown amount | "Analytics: only what was observed"; the field is `null` now | new test in `intelligence-core.test.ts`, and the corrected assertion in `intelligence-authority.test.ts` |
| LOW 7 — a dead `unrecognized` bucket described as a live defence | "Known limitations"; comments corrected, bucket kept | new test in `intelligence-core.test.ts` |
| Informational — `fdfa1e0`'s "no facade method spells activate…" | "Surfaces → What has no route, and why", scoped honestly | the existing route-segment scan, unchanged |
| Undisclosed debt — a raw appender can widen a budget by version | "The law: a ceiling blocks or asks, and never grants" | stated, not defended — it is inherent to append-only versioning |

**What the five guards actually hold, verified rather than asserted.** With the
five `_no_replace_unique` triggers deleted from a scratch copy outside the
repository, `INSERT OR REPLACE` colliding on `hq_intel_budgets.budget_key`
swapped the ceiling from 1000 to 999999999 and the permitted tier from
`deterministic_local` to `critical_review`, and the same on
`hq_intel_cost_entries.entry_key` erased a recorded amount. Three of the seven
new tests fail against that scratch copy and pass here. The other four are
SHAPE coverage — with `recursive_triggers` ON the implicit DELETE reaches
`_no_erase`, and an upsert reaches `_no_rewrite` — and the test file says so
rather than implying four pins where there are three.

**No live defect existed at this head.** All five guards were present and every
one of the eight new tables refused every attack; this is a verification and
regression-exposure fix, not an exploit fix.

**Verification after the correction pass** (the whole suite, not a subset):

| Command | Result |
|---|---|
| `npm run test:hq` | 162 files, 3045 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |

Baseline at `c9ddecc` was 161 files / 3026 tests. Nothing was deleted, skipped,
weakened or narrowed. Two existing assertions were CORRECTED rather than
relaxed, and both are recorded above: the `foldSpend` zero (it pinned the
defect) and `REQUIRED_IMMUTABILITY_GUARDS`' companion test (widened to cover the
per-table declaration beside the universal trio). The three pre-existing
`it.skip` GAP markers under `packages/server` are untouched, and nothing under
`packages/server`, `packages/web`, `packages/shared` or `packages/config-mesob`
was changed.

---

## Wave 5 SECOND correction pass (this branch, on top of `9782b45`)

Three further fresh read-only hostile reviewers returned 0 Critical / 5 High /
7 Medium / 13 Low across both phases; every High was reproduced by execution.
The findings that touch Phase 14 are corrected in place above, in the sections
they belong to:

| Finding | What changed | Pinned by |
|---|---|---|
| HIGH B-1 — a caller chose which Founder budget policy governed its own write | the `budgetScope` parameter is GONE from `intelligenceRoutingProposal` and `recordIntelligenceDecision`; `#governingBudgetScopes` derives the applicable scopes from canonical truth (deployment baseline + the task's missions and projects + its bound provider), and `combineBudgetEvaluations` takes the most restrictive decision and the INTERSECTION of permitted tiers | `test/intelligence-attribution.test.ts`, including the reviewer's own shopped-scope reproduction and the mission-ceiling case it was used to route around |
| HIGH B-2 — every non-deployment ceiling and both time windows were keyed on caller strings | mission and project come from `hq_mission_plan_items`/`hq_missions`; a `providerId` contradicting the canonical binding is `provider_binding_mismatch`; `occurredAt` is clamped to a bounded interval around `nowIso()` (one hour ahead, thirty days behind) | the ghost-mission, misattributed-provider and 2099-dated-entry cases, same file |
| MEDIUM B-3 — "recompute the floor" was described as closing a forgery it only relocates | the comment and the doc say what recomputation does; structurally, `bound_provider`, the risk class and the review requirement are re-derived at READ time from `op_tasks`/`op_capabilities` | a raw append forging all three, same file |
| MEDIUM B-4 — `rowToBudget` failed OPEN on a malformed row | `unrecognized` scope/window (matching nothing) and a `null` ceiling answering `requires_founder_decision` | the reviewer's one-append reproduction, same file |
| MEDIUM B-5 — first-write-wins dedupe let a `billed 0` suppress a real amount | a second entry with the same identity and a different figure is `cost_entry_conflict`; an identical one still dedupes | same file |
| LOW B-6 — the escalation view's `requiresFounderDecision` came from the request, not the row | projected from the stored `budgetDecision`, like the trigger beside it | same file |
| LOW B-7 — `MAX_COST_BASIS_LENGTH` never applied to an `estimated` basis, and the refusal was misnamed | the bound applies to every provenance; `basis_too_long` is its own refusal | same file |
| LOW B-8 — `providerId`/`modelId` were scanned at the route and not at the facade | `assertBrowserSafe` at the facade, where `recordIntelligenceCost`'s only callers are | same file |
| LOW B-9 — doc drift (test count, the `budget_ceiling_blocks` claim, the undisclosed caller-supplied scope) | all three corrected above | — |
| MEDIUM C-2 — "an in-process caller cannot obtain an unwrapped adapter" was false | the raw adapters are module-private; `LEXICAL_RETRIEVAL_ADAPTER` and every member of `SEMANTIC_RETRIEVAL_ADAPTERS` are guarded AT DECLARATION, and `guardRetrievalAdapter` is idempotent | `search-adapter-guard.test.ts`, with the assertion inverted from "the resolver wraps" to "there is nothing unwrapped to obtain" |
| LOW C-1 — a credential split across two search fields passes both scans | NOT fixed; recorded below | — |
| LOW C-2 — ten of the eleven credential patterns were case-sensitive, and invisible characters defeated all of them | the patterns are case-insensitive (the JWT one deliberately excepted: `eyJ` is base64url, not a spelling) and values are NFKC-normalized with zero-width and bidi controls stripped before matching | `live-redaction.test.ts` |

**A consequence of LOW C-2 that changes an earlier claim, stated rather than
left to be found.** The previous correction pass established that the seam
guard is INERT on the terms the pipeline produces, because `tokenize()` strips
every separator the shape patterns need. That is still true of the shapes whose
match DEPENDS on a separator — `sk-`, `ghp_`, a JWT's dots, `Bearer `,
`api_key: ` — and it is no longer true of a Google API key, which carries no
separator at all and now matches case-insensitively after tokenization. The
test file says which is which, in two separate tests.

**Known debt this pass records rather than closes:**

- **A credential split across two search fields still passes** (`?text=sk-&project=AAAA…`).
  Each field is scanned independently and the pieces are then echoed into
  `criteria`. Joining the fields for the scan would either miss the same split
  (with a separator) or produce false refusals (without one), so this is
  recorded rather than papered over.
- **A forged decision row can still understate complexity, context size and
  work kind.** Only the risk class has a canonical source; HQ does not invent
  one for the other three.
- **No MODEL-scoped ceiling constrains a decision write.** Nothing in canonical
  truth binds a task to a model, so HQ has no honest derivation for a model
  scope and does not invent one. A model ceiling can be read through
  `intelligenceBudgetDecision`; it does not by itself govern.
- **A scope with no recorded ceiling is not evaluated.** Absence of a mission
  policy is absence of a policy, and the deployment baseline already answers
  "no policy anywhere" with the free local tier alone.
- **A raw appender can still widen a budget by appending a higher-version row**
  (`latestBudgetFor` takes the max version). Inherent to append-only versioning
  under a raw-writer threat; unchanged from the previous pass, and still stated.

