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
  different one, and the routing surface has no provider or model PARAMETER.
  Stated exactly, because the previous wording was wrong (Wave 5 Low): the
  `RoutingProposal` interface carries no provider or model field, but the
  facade returns `RoutingProposal & { taskId; boundProvider }`. That
  `boundProvider` is OBSERVED off the canonical payload by `#taskBoundProvider`
  — a report of what will execute, with no parameter anywhere that could make
  it say anything else — and a proposal that disagreed with a binding would
  simply be ignored by `OperatorQueue.claim`/`start`.
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
provenance, a bad currency, a fractional amount, an `estimated` amount with no
BASIS, or an amount beyond `MAX_COST_MINOR_UNITS` reads back as `unknown` with
a null amount rather than as a figure HQ would then publish.

**The last two are Wave 5 corrections (Medium 6).** The parity above was a
claim before it was true: those two shapes had no counterpart on the read side,
so a row carrying either read back as a KNOWN amount and was folded into
`observedMinorUnits` — which is how a scope that should read
`requires_founder_decision` reads `within_ceiling` instead.

**`MAX_COST_BASIS_LENGTH` applies on every branch** (Wave 5 Medium 7). It used
to be applied only to non-estimates — the branch that cannot carry a basis at
all — under the misnamed `basis_on_non_estimate`, so `estimated`, the one
provenance that REQUIRES a basis, had no length check and roughly a megabyte of
caller text could land permanently in an append-only, un-erasable table and be
echoed on every read of the intelligence control surface. The bound is now
checked before the provenance switch under `basis_too_long`, and
`basis_on_non_estimate` means what its name says: a non-estimate may not carry
a basis at all. `capabilityFacts` and `permittedTiers` are deduped in the
facade, because the route's `stringArrayField` caps neither length nor
repetition.

**The canonical risk class is read through the vocabulary, never asserted**
(Wave 5 Medium 5). `op_capabilities` carries no immutability triggers —
enabling and disabling a capability is a legitimate UPDATE — so one raw
`UPDATE op_capabilities SET risk_class = 'totally_harmless'` used to become a
typed `RiskClass` by cast: `RISK_FLOOR[...]` and `REVIEW_REQUIREMENT[...]` both
read `undefined`, the floor fell from `high` to `deterministic_local`, and a
null review requirement is treated as satisfied — so `deterministic_local` was
ACCEPTED on an `external_side_effect` task. `readStoredRiskClass` fails closed
to `founder_gate` at every store read, and `computeRoutingProposal` re-checks as
defence in depth.

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

### The law: WHICH ceiling applies is derived, never chosen

This is a Wave 5 correction (High 2), and it was the largest hole in the phase.
`budgetScope` was a CALLER parameter on `recordIntelligenceDecision` and
`intelligenceRoutingProposal`, and its `scopeId` was never checked against the
task's canonical mission or project. With a strict `deployment/total` policy
(`permittedTiers: ['deterministic_local']`) beside a permissive
`mission/some-other-mission/total`, a worker on an `external_side_effect` task
moved from `refusal: no_permitted_tier` to `tier: high, budgetDecision:
within_ceiling` by naming the other scope — or by naming a different `window`,
since only `total` was ever consulted. No test passed the parameter at all.

The parameter is gone. `#canonicalBudgetScopes` derives the set from the task:
`deployment/total` always, plus every deployment / mission / project
scope-and-window for which a ceiling has ACTUALLY been recorded. The mission is
read off `hq_mission_plan_items.task_id` and the project off
`hq_missions.project_id` — the same canonical link `proposeAction` already
checks. `mostRestrictiveBudget` then takes the most severe decision and the
INTERSECTION of the permitted sets, so a tier is permitted only where every
applicable ceiling permits it. Escalation evaluates the same canonical set
rather than the deployment scope alone, so it cannot climb past a ceiling the
first decision honoured.

Only scopes with a RECORDED ceiling join, because `evaluateBudget` answers
`requires_founder_decision` for a scope with no policy — folding in six silent
scopes would make every answer a Founder decision and every permitted set the
local tier alone, which is noise rather than caution.

**`provider` and `model` scopes are deliberately absent from that set, and
that is a stated limitation.** A cost entry's `providerId` is a
caller-declared fact about who was billed, in a different vocabulary from the
canonical execution binding, so HQ cannot attribute it canonically. A provider
or model ceiling is REPORTED by `intelligenceBudgetDecision` and does not gate
a routing decision.

### The law: a spend is attributed to canonical work, not to a declaration

Also a Wave 5 correction (Medium 8). `missionId` and `projectId` on both
ledgers were `.trim() || null` with no existence check, no length bound and no
secret scan, unlike `label`/`note`/`basis`, which get bounds AND a secret scan.
A 5000-character `missionId` and a `projectId` of `<script>x</script>` were
both accepted — and, worse, OMITTING `missionId` hid a spend from an exhausted
mission ceiling, which made three of the five `BUDGET_SCOPES` meaningless.

Both are now DERIVED by `#canonicalWorkIdentity` and are no longer parameters:
one canonical attribution decision serving this and the scope rule above.
`decisionId` on a cost entry must name a decision that exists AND belongs to
the same task — and, since the second correction round (LOW 8), must be a
bounded lowercase slug that is shape-checked before any store read, with the
refusal carrying the code rather than echoing the caller's text. It was the one
id a caller still passes into this phase, and it was left unbounded and
unscanned by the same round that removed `missionId` and `projectId` for
precisely that reason.

#### The one row this derivation stands on, and what now protects it

Both halves of that derivation reach the task through ONE row:
`hq_mission_plan_items.task_id`. That was a fail-OPEN dependency and nothing
said so (second correction round, MEDIUM 3). The older users of that link check
that a row EXISTS, so a DELETE fails them closed; this derivation reads the
absence as "this task belongs to no mission" and drops the mission and project
ceilings from the applicable set entirely. Executed: with an exhausted
`mission/mission-1/total` ceiling the proposal was `blocked` and restricted to
`deterministic_local`; after one `DELETE` of the single link row it was
`within_ceiling` with the full tier set — and the integrity census reported
nothing, because `hq_mission_plan_items` was deliberately outside
`ENGINE_IMMUTABLE_TABLES`.

Checked before acting, as the finding required: **no code path in this
repository deletes from that table**, and the mission source scan already
forbids the spelling. So the table now carries
`trg_hq_mission_plan_items_no_erase` and the engine refuses the DELETE from any
writer. `no_rewrite` was deliberately NOT added — linking a task, superseding
an item and stating a work spec are legitimate UPDATEs of this table's own
columns, and each of those columns is already write-once by its own trigger. The
table is now IN the census with a reduced declared base
(`requiredGuards: ['no_erase', 'no_replace']` plus `no_relink` and `no_respec`),
so its guards can no longer go missing quietly; being outside the census
entirely was the second half of the defect.

### The law: the window is measured on the instant HQ stamped

Wave 5 High 3. `occurredAt` was caller-supplied and the only check was
`/^\d{4}-\d{2}-\d{2}T/`, which is a shape and not a date, while the window
filter was a string prefix over that same field. Under a `deployment/day`
ceiling of 100 with 90 observed, an entry declaring
`occurredAt: "0000-00-00T00:00:00Z"` with an amount of 1,000,000 was ACCEPTED
and the ceiling still reported `within_ceiling`.

Three changes together: the instant must `Date.parse`; it may not be in the
future; and the window filter measures `recorded_at`, which HQ sets.
`occurredAt` survives as reported-only metadata, which is what it always was.
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
- **`provider` and `model` budget scopes are REPORTED, not enforced at the
  routing gate.** A cost entry's `providerId` is a caller-declared fact about
  who was billed, in a different vocabulary from the canonical execution
  binding, so HQ cannot attribute it canonically and will not pretend to. See
  "WHICH ceiling applies is derived" above.
- **`requiresFounderDecision` is computed and published but read by nothing.**
  It appears on the proposal and on the escalation; no HQ path branches on it.
  Carried honestly rather than removed, and carried honestly rather than
  described as a gate.
- **Escalation reuses the PRIOR decision's stored `requiredReviewTier` and
  `floorTier`** rather than re-deriving them from the task's capability as it
  stands now. It fails upward only — an escalation moves strictly up the tier
  order — so a capability that has since been made RISKIER is not re-checked
  against the new floor.
- **`intelligenceAnalytics()` is unbounded** while its four neighbours on the
  same control response are page-bounded: `provablyAvoidable.decisionIds` is
  uncapped and four fold arrays are unbounded. It is Founder-gated, so this is
  a response-size question and not a privacy one.
- **`startTask` is not safe-mode gated.** A claim taken before safe mode
  engaged can still advance `assigned → running`. The external path is closed —
  `claimNext` and `executeAction` are both refused — so this narrows what safe
  mode claims rather than changing behaviour: safe mode refuses NEW work being
  taken up and anything reaching outside HQ, not every movement of a claim that
  already existed.
- **A source file must contain no raw NUL byte, and now none does** (Wave 5
  Medium 10). `intelligence-command.ts` introduced a literal 0x00 as a
  composite-key separator, and the PR body disclosed only the two pre-existing
  ones in `product-command.ts` as "carried forward" — which reads as "nothing
  new was added". A NUL makes a file BINARY to grep, git grep and ripgrep:
  they report "binary file matches" and skip the content, so the file is
  invisible to the repository's own text tooling and to a reviewer's default
  honesty scan. All three are now U+001F UNIT SEPARATOR (identical runtime
  value, file stays text), as is a FOURTH nobody had disclosed —
  `src/live/auth.ts` — which the new source scan in
  `test/core-boundary.test.ts` found.
- **A second escalation with a DIFFERENT trigger dedupes to the first.**
  `decisionIdempotencyKey` deliberately excludes the trigger, so the same
  escalation re-recorded is one row — which is the point of an idempotency rule
  over an append-only ledger. What follows is that the second caller's trigger
  is not what HQ holds, and the returned view now says so: it carries the
  STORED trigger (Wave 5 LOW 4). If a deployment ever needs two escalations of
  one decision under different triggers, the key is the thing to widen, and
  that would be a deliberate change to what "the same escalation" means.
- **`readStoredCostFact`'s parity with the writer is now complete, and the
  previous round's claim that it was complete was wrong.** The Wave 5 Medium 6
  correction closed two of `normalizeCostFact`'s refusals on the read side and
  then asserted, in a comment, that there had only ever been two. There were
  four. Executed against the reader in the second correction round (LOW 7): a
  raw-appended `billed` row WITH a basis read back `state: 'known'` and carried
  the basis with it (`basis_on_non_estimate` on write), and an `estimated` row
  with a 500,000-character basis read back `known` and unbounded on a
  Founder-gated read (`basis_too_long` on write). Both now return the unknown
  fact, and the comment states four. `hq_intel_cost_entries` is append-only and
  an APPEND is the write its triggers deliberately permit, so rows of these
  shapes remain representable in a file — which is the whole reason the reader
  has to fail closed independently of the writer.
- **The budget-scope derivation depends on `hq_mission_plan_items`, and that
  dependency is now guarded rather than merely stated.** See ["The one row this
  derivation stands on"](#the-one-row-this-derivation-stands-on-and-what-now-protects-it).
  The residual risk that remains: the engine refuses a DELETE, but the row's
  `task_id` is still write-once rather than append-only-by-history, so an item
  that was never linked in the first place attributes nothing — a task that no
  mission plan references genuinely belongs to no mission, and HQ cannot tell
  that from an omission. Only `deployment/*` ceilings apply to such a task.
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
   adapter, and an adapter added to `SEMANTIC_RETRIEVAL_ADAPTERS` later cannot
   opt out by being added to the list. The wrapper is transparent in every
   other respect (same id, mode, availability, reason), so nothing downstream
   gains a reason to reach for the unguarded object.

   **`RETRIEVAL_GUARD_STATEMENT` originally overstated this** (Wave 5
   Medium 9). It said an in-process caller "cannot obtain an unguarded
   adapter", while `LEXICAL_RETRIEVAL_ADAPTER` and
   `SEMANTIC_RETRIEVAL_ADAPTERS` are exported and this package's own tests
   import and call them — which is legitimate, because the raw adapters are
   what the guard is tested against. That statement is interpolated into
   `statement.note` and reaches the browser as an HQ assertion, so it was
   narrowed to what is enforced: every adapter the RESOLVER hands out is
   guarded, the wrapping is done by the resolver rather than by the caller, and
   the raw objects are exported for testing and are not wrapped in themselves.
   The substantive guard is unchanged and sound.
2. **At the facade.** `searchCompany` and `askJenify` scan `text`, `project`,
   `tag` and `question` on the way in and return a stated `invalid_input`
   refusal, so an in-process caller gets a good error instead of an exception
   from deep inside a retrieval. The scan runs BEFORE `normalizeSearchQuery`,
   which echoes `project` and `tag` verbatim into `criteria` — so the material
   never reaches a structure at all.

**Which of the two is load-bearing, stated correctly.** The FACADE scan is the
effective one. The inner wrapper sees `input.terms`, which
`normalizeSearchQuery` has already TOKENIZED — and a tokenized term cannot
match the credential patterns, which need a `key: value` shape with punctuation
the tokenizer has removed. The wrapper is defence in depth and becomes
load-bearing only for a future caller that reaches `resolveRetrievalAdapter`
without going through the facade. The module comment previously called the
inner layer "the guarantee"; that was wrong and is corrected, and a test
demonstrates the tokenization point directly.

The route's own scan is **unchanged**: it has a better refusal to give
(`400 unsafe_query`, audited as refused rather than allowed), and it stays as
the outer layer.

**Pinned by** `test/search-adapter-guard.test.ts` (12 tests). Every branch of
the resolver is exercised, the facade refusals are proven for all four fields,
and an ordinary search and an ordinary question are proven still to work, so the
guard did not narrow the surface it protects. The seam's own load-bearing
assertion is not that the guard throws — it is that a recording stand-in
adapter, the thing the seam exists for, is **never called at all** with
credential-shaped terms.

**Which of the two layers is the guarantee — corrected.** Both Wave 5
correction lanes reached this independently (one as Medium 9, one as Low 3).
The sentence above used to end "Both layers are kept: the outer one gives a
good error, the inner one is the guarantee", and commit `0c5edea`'s message
said "a test proves the wrapped adapter is never CALLED with credential-shaped
terms". The structural claims mostly hold — every resolver branch returns a
wrapper, and a recording stand-in got zero calls — but the ATTRIBUTION was the
wrong way round, and one claim was simply false. Both are now stated as they
are:

- `guardRetrievalAdapter` scans `input.terms`. On the pipeline path those terms
  are always `tokenize()` output, which lowercases and splits on `[^a-z0-9]+` —
  stripping every separator the eleven `SECRET_VALUE_PATTERNS` require (`sk-`,
  `ghp_`, a JWT's dots, `Bearer `, `api_key: `) and defeating the
  case-sensitive ones besides. **The seam scan therefore does not fire on
  anything the pipeline can produce.** The test that fed it a whole unsplit key
  was feeding it an input the pipeline cannot generate.
- **The FACADE scan is the guarantee** for the pipeline, and the route's scan
  is the outer layer beyond it. Both see the raw field before normalization and
  before tokenization, which is where a credential is actually met.
- **The seam guard is defence in depth against a non-tokenized caller**, and
  that caller is real: `resolveRetrievalAdapter` is exported, so an in-process
  caller can obtain an adapter and hand it terms it built itself. That is worth
  guarding; it is not the layer the pipeline relies on.
- **"An in-process caller cannot obtain an unguarded adapter" was not true**,
  and the published statement no longer says it. `LEXICAL_RETRIEVAL_ADAPTER`
  and `SEMANTIC_RETRIEVAL_ADAPTERS` are exported, and this package's own tests
  import and call them RAW — which is legitimate, because the raw adapters are
  what the guard is tested against. What is true is narrower and is what is
  published now: every adapter the RESOLVER hands out is wrapped, the wrapping
  is done by the resolver rather than by the caller, and the raw adapter objects
  are exported for testing and are not wrapped in themselves.

`RETRIEVAL_GUARD_STATEMENT`, the module comments and the test names all say this
now, and a new test PINS the tokenization fact itself against six real
credential shapes — each refused at the facade, each inert at the seam once
tokenized — so the claim cannot quietly become wrong again in either direction.

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

**Carried from the Wave 5 review, deliberately NOT fixed and recorded as
open** — each was judged too small or too behaviour-changing to correct inside
a correction pass, and each is listed under limitations above except the last:
the un-safe-mode-gated `startTask`; escalation reusing the prior decision's
stored review/floor tiers; the computed-but-unread `requiresFounderDecision`;
the unbounded `intelligenceAnalytics()`; and two assertions in
`intelligence-authority.test.ts` that compare hard-coded `false` literals
(`grantsSpend`, `authorizesPaidActivation`) and are therefore tautological at
runtime — the TYPE-level `false` literal is what actually enforces those, and
the assertions are left as documentation of intent rather than deleted.

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

**Two independent correction lanes, reconciled by a merge.** The frozen wave
head `c9ddecc` was hostile-reviewed twice, concurrently and without either
reviewer knowing about the other: a four-reviewer sweep (1 Critical / 5 High /
10 Medium / ~13 Low, landed as twelve commits) and a separate fresh read-only
reviewer (0 Critical / 1 High / 1 Medium / 6 Low, landed as one commit). Both
reached the same guard-census defect; each found things the other did not. The
merge keeps the union of the guarantees, one implementation of each shared fix,
and every regression test from both lanes. Full reconciliation record, and the
one duplicate implementation that was dropped and why, are in Phase 13's "Wave
5 correction pass".

Every finding that touches Phase 14 is corrected in place above, in the section
it belongs to. This table says where, and what now pins each one. Findings are
labelled by the lane that raised them.

| Finding | Correction | Pinned by |
|---|---|---|
| A HIGH 2 — `budgetScope` was a caller parameter and which ceiling applied was chosen, not derived | "The law: WHICH ceiling applies is derived, never chosen"; `#canonicalBudgetScopes` + `mostRestrictiveBudget` | new tests in `intelligence-authority.test.ts` |
| A HIGH 3 — `occurredAt` was caller-supplied and the window measured it | "The law: the window is measured on the instant HQ stamped"; the window filter reads `recorded_at` | new tests in `intelligence-authority.test.ts` |
| A MEDIUM 5/6/7 — three fail-open reads in the cost and routing policy | recorded at each site above | new tests in `intelligence-core.test.ts` and `intelligence-authority.test.ts` |
| A MEDIUM 8 — a spend was attributed to a declaration, not to canonical work | "The law: a spend is attributed to canonical work"; `#canonicalWorkIdentity` | new tests in `intelligence-authority.test.ts` |
| A MEDIUM 9 = B LOW 3 — the seam guard's scan is inert on tokenized terms | "The `assertBrowserSafe` pre-real-adapter Low" above, rewritten to name the FACADE scan as the guarantee, and to stop claiming an in-process caller cannot obtain an unguarded adapter | both lanes' tests in `search-adapter-guard.test.ts` (12 tests), one of which pins the tokenization fact against six real credential shapes |
| A MEDIUM 10 — a raw NUL byte made a source file binary to the repo's own tooling | "Known limitations"; all four are U+001F now | new source scan in `test/core-boundary.test.ts` |
| A HIGH 1 = B MEDIUM 2 — the five secondary-unique guards were unpinned, and the census could not see them | `ENGINE_IMMUTABLE_TABLES` now declares each table's `secondaryGuards` and `missingImmutabilityGuards` reads them, so a dropped one produces a real `append_only_guard_missing` finding and engages safe mode | `test/intelligence-durability.test.ts` (7 tests, kept in full from Lane B) and five tests in `reliability-durability.test.ts`, including BOTH lanes' live-schema pins |
| B LOW 4 — the returned escalation trigger could contradict the record | "Known limitations", and the facade now returns the STORED trigger | new test in `intelligence-authority.test.ts` |
| B LOW 5 — the `founder_gate` fail-closed default was unpinned | extracted as `riskClassForRouting`; audit row corrected | new unit test in `intelligence-core.test.ts` |
| B LOW 6 — `foldSpend` rendered `0` for an unknown amount | "Analytics: only what was observed"; the field is `null` now | new test in `intelligence-core.test.ts`, and the corrected assertion in `intelligence-authority.test.ts` |
| B LOW 7 — a dead `unrecognized` bucket described as a live defence | "Known limitations"; comments corrected, bucket kept | new test in `intelligence-core.test.ts` |
| B Informational — `fdfa1e0`'s "no facade method spells activate…" | "Surfaces → What has no route, and why", scoped honestly | the existing route-segment scan, unchanged |
| B Undisclosed debt — a raw appender can widen a budget by version | "The law: a ceiling blocks or asks, and never grants" | stated, not defended — it is inherent to append-only versioning |

### Second correction round

The corrected head was reviewed again, hostilely. Three of its findings touch
Phase 14, and all three are corrected in place above:

| Finding | Correction | Pinned by |
|---|---|---|
| MEDIUM 3 — the budget-scope derivation depended on `hq_mission_plan_items`, which had no `no_erase` guard and was outside the census, so one DELETE unbound a mission/project ceiling FAIL-OPEN with no finding | ["The one row this derivation stands on"](#the-one-row-this-derivation-stands-on-and-what-now-protects-it); `trg_hq_mission_plan_items_no_erase` plus a census entry with a reduced declared base | a new test in `intelligence-authority.test.ts` that reproduces `blocked` → `within_ceiling` and proves the engine now refuses the DELETE, plus the two live-schema pins in `reliability-durability.test.ts` |
| LOW 7 — `readStoredCostFact`'s parity was still incomplete for two more of the writer's refusals, contrary to a comment claiming there had been two | "Known limitations"; a non-estimate that names a basis, and a basis beyond `MAX_COST_BASIS_LENGTH`, both read back as the unknown fact | two new tests in `intelligence-core.test.ts` |
| LOW 8 — `decisionId` was unbounded, unscanned and echoed verbatim into a refusal message | "The law: a spend is attributed to canonical work"; `#resolveDecisionReference` bounds and shape-checks it on all three paths that accept one, and the refusals carry the code alone | a new test in `intelligence-authority.test.ts` |

**One merge-level detail, recorded rather than left silent.** Lane A's Medium
10 replaced `foldSpend`'s composite-key separator (a raw NUL) with U+001F; Lane
B's Low 6 rewrote the same line for the null-currency rule and left a SPACE
there. The merged line takes Lane A's U+001F with Lane B's semantics, because a
space is not a safe separator here: the identities folded are provider and
model strings that may legitimately contain one, so `"a b"` with no currency
and `"a"` with currency `"b"` would have collapsed into one bogus group.

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

**No live defect existed at this head** for the guard finding. All five guards
were present and every one of the eight new tables refused every attack; that
half is a verification and regression-exposure fix, not an exploit fix. The
Lane A findings above are a different matter — High 2, High 3 and Medium 8 were
each demonstrated against a running facade.

**Verification after the reconciliation** (the whole suite, not a subset):

| Command | Result |
|---|---|
| `npm run test:hq` | 162 files, 3073 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root) | 37 files, 569 passed, 3 skipped |
| `npm run build` | all workspaces; web `215.66 kB` / `69.22 kB` gzip (unchanged) |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |

Baseline at `c9ddecc` was 161 files / 3026 tests; Lane A alone was 161 / 3053
and Lane B alone 162 / 3045. Nothing was deleted, skipped, weakened or narrowed
by either lane or by the merge. Two existing assertions were CORRECTED rather
than relaxed, and both are recorded above: the `foldSpend` zero (it pinned the
defect) and `REQUIRED_IMMUTABILITY_GUARDS`' companion test (widened to cover the
per-table declaration beside the universal trio). The three pre-existing
`it.skip` GAP markers under `packages/server` are untouched, and nothing under
`packages/server`, `packages/web`, `packages/shared` or `packages/config-mesob`
was changed.
