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

**On EVERY path that records a tier, which was not true until the third
correction round (Medium B3).** `escalateIntelligenceDecision` never ran
`#resolveRecordedTier` at all: `deriveEscalation` picked the cheapest higher
PERMITTED tier and consulted neither the required reviewer tier nor the floor.
Reproduced through supported calls only — a Founder re-registering a capability
at a higher risk class through the documented registry upsert — the enforced
path refused `low_cost` with `review_tier_required` while escalation recorded
`low_cost` anyway against a `critical_review` requirement. There are two checks
now: the pure derivation SKIPS a tier that cannot satisfy the requirement
(skips rather than refuses, because the next one up may well satisfy it), and
the facade re-derives the current proposal and runs the shared resolver, which
also covers the floor and the permitted set as they stand at escalation time.
A prior decision whose stored characteristics cannot be read through the closed
vocabularies fails closed: the escalation is refused rather than recorded
against a policy HQ could not compute.

The requirement also survives a FORGED row in both columns (Medium B4). The
canonical re-derivation used to be skipped whenever `characteristics` failed to
parse, and `rowToDecision` reads an unparseable column as null — so forging
`required_review_tier` alone was caught by the max and forging BOTH escaped
completely, with `requiredReviewTier: null`, `satisfies: true`, and the row
dropping out of `reviewRequired` in analytics. The canonical risk class is now
read first and unconditionally.

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

The parameter is gone. `#governingBudgetScopes` derives the set from the task:
`deployment/total` always, plus every deployment / mission / project / provider
scope-and-window for which a ceiling has ACTUALLY been recorded. The missions
are read off `hq_mission_plan_items.task_id` (ALL of them, not the first) and
the projects off `hq_missions.project_id` — the same canonical link
`proposeAction` already checks — and the provider off `#taskBoundProvider`.

**Deriving every mission was only half of it, and the other half was missing
until the third correction round (High B1).** A cost entry carries ONE
`mission_id` column, the attribution wrote `canonical.missionIds[0]`, and
`#entriesForScope` matched that column — so a task linked to a SECOND mission
had that mission's ceiling evaluated against ZERO entries. Identical spend under
an identical ceiling read `blocked, observed 5000000` with one link and
`within_ceiling, observed 0` with two, and WHICH of the two bound was decided by
uuid sort order: twelve runs of the two-link configuration enforced eight times
and bypassed four. Reached through `linkMissionPlanItem`, a supported facade
call, with no raw SQL — the same fail-open the wave's own
`trg_hq_mission_plan_items_no_erase` trigger was added to close, one link over.

`#entriesForScope` now derives mission and project membership from
`hq_mission_plan_items` per entry, which is the canonical-truth answer rather
than a denormalized column that can only hold one of N. **The claim that
followed here — that the stored `mission_id` and `project_id` "remain recorded
attribution and measure nothing" — was FALSE, and is corrected in the fourth
round (Medium M5).** They measured `intelligenceAnalytics()`, which is served on
`/api/hq/control/intelligence`: `analytics.cost.byMission` and `byProject`
folded exactly those one-of-N columns, so which mission a spend was attributed
to flipped on uuid sort order (six runs, one task linked to two missions, one
5000 spend: four runs attributed 100% to A and 0 to B, two the reverse). Both
the ceilings and the analytics now read canonical membership UNION the recorded
attribution — the union, because the derivation answers "every mission this task
belongs to NOW" and the column answers "the mission this spend was filed under",
which no later relinking can take away. The `provider`
scope is derived the same way, from the task's canonical BINDING rather than
from the caller-supplied column — which is what closes the mirror-image defect
(Medium B5): spend from an UNBOUND task could be filed against any provider id
and pushed a third party's Founder ceiling from `observed 0` to `blocked,
observed 999999`. Such an entry is still recorded and still counts toward the
deployment total, because the provider a worker reports is a real fact; it
simply measures no PROVIDER ceiling, because HQ has no canonical statement that
the work ran there.
`combineBudgetEvaluations` then takes the most severe decision and the
INTERSECTION of the permitted sets, so a tier is permitted only where every
applicable ceiling permits it, and carries `governedBy`, so a reader can see
which recorded policies actually bound the answer and where each was derived
from. Escalation evaluates the same derived set rather than the deployment scope
alone, so it cannot climb past a ceiling the first decision honoured.

Only scopes with a RECORDED ceiling join, because `evaluateBudget` answers
`requires_founder_decision` for a scope with no policy — folding in silent
scopes would make every answer a Founder decision and every permitted set the
local tier alone, which is noise rather than caution. An EMPTY set is still not
"no restrictions": it answers `requires_founder_decision` with the free local
tier alone.

**`model` scopes are deliberately absent from that set, and that is a stated
limitation.** Nothing in canonical truth binds a task to a MODEL, so HQ has no
honest derivation for one and does not invent it: a model ceiling is REPORTED by
`intelligenceBudgetDecision` and does not gate a routing decision. The
`provider` scope is NOT in that position, and the reason it is not had to be
built rather than asserted (Wave 5 correction round three, High B2). The claim
made here was that "a cost entry whose `providerId` contradicts
`#taskBoundProvider` is refused, so the two vocabularies are one by enforcement"
— and the refusal was real while the vocabularies were not one at all. Canonical
routing says `CLAUDE`; every id this lane stores is a lowercase slug. So on a
provider-bound task `CLAUDE` failed the slug rule, `claude` failed the binding
rule, and `Claude` failed the slug rule again: no cost entry against bound work
was expressible, the `provider` scope was dead, and every Founder ceiling on it
stayed at `observed: 0` forever. The escape hatch was closed too, since a task
bound to lowercase `claude` cannot be claimed by anyone.

`normalizeProviderId` is where the two now meet. It is a CASE FOLD, not a
substitution: the canonical set is uppercase-distinct so the fold is injective
over it, the decision record still stores the canonical binding verbatim, and
the fold is applied at the cost write, the observation write, the budget write
and the budget read — so a Founder may write `CLAUDE` or `claude` and get one
ceiling, which then genuinely binds a decision write on bound work.

### The law: a spend is attributed to canonical work, not to a declaration

Also a Wave 5 correction (Medium 8). `missionId` and `projectId` on both
ledgers were `.trim() || null` with no existence check, no length bound and no
secret scan, unlike `label`/`note`/`basis`, which get bounds AND a secret scan.
A 5000-character `missionId` and a `projectId` of `<script>x</script>` were
both accepted — and, worse, OMITTING `missionId` hid a spend from an exhausted
mission ceiling, which made three of the five `BUDGET_SCOPES` meaningless.

Both are now DERIVED by `#canonicalTaskScopes` and are no longer parameters:
one canonical attribution decision serving this and the scope rule above.
`decisionId` on a cost entry must name a decision that exists AND belongs to
the same task, and a `providerId` contradicting the canonical binding is refused
as `provider_binding_mismatch`.

`decisionId` must additionally, since the second correction round (LOW 8), be a
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

The other correction lane reached the same table from the other side, and its
exploit is closed by the same entry: with the table unlisted, dropping
`trg_hq_mission_plan_items_no_replace` let an `INSERT OR REPLACE` rewrite a plan
item's task binding with no `append_only_guard_missing` finding at all. Its
mechanism for putting the table into the census — a boolean
`holdsUniversalTrio: false` — was dropped in the reconciliation in favour of
`requiredGuards`, because a boolean cannot express a REQUIRED `no_erase` and the
`no_erase` guard is the half that closes the fail-open above. Its inverted
live-schema test (the live trigger set EQUALS the union of the declarations, so
a guarded table nobody listed is a test failure) is kept and now binds this
entry.

### The law: the window is measured on the instant HQ stamped

Wave 5 High 3. `occurredAt` was caller-supplied and the only check was
`/^\d{4}-\d{2}-\d{2}T/`, which is a shape and not a date, while the window
filter was a string prefix over that same field. Under a `deployment/day`
ceiling of 100 with 90 observed, an entry declaring
`occurredAt: "0000-00-00T00:00:00Z"` with an amount of 1,000,000 was ACCEPTED
and the ceiling still reported `within_ceiling`.

Three changes together: the instant must `Date.parse`; it must sit inside a
BOUNDED interval around `nowIso()` — at most one hour ahead, to absorb ordinary
clock skew, and thirty days behind — and the window filter measures
`recorded_at`, which HQ sets. `occurredAt` survives as reported-only metadata,
which is what it always was. (Two correction lanes fixed this: one with "must
parse, may not be in the future", one with the bounded interval. The interval
survives because it closes both directions, and the future half keeps the other
lane's refusal by name. The consequence is stated rather than hidden: a genuine
observation older than thirty days can no longer be recorded at all, and a lane
importing historical spend would need a Founder decision about that bound.)

**And `occurredAt` is no longer DEFAULTED into the entry's identity** (fifth
correction round, Low 3). `costEntryKey` covers the identity — task, provider,
model, instant, unit kind, idempotency key — and the facade used to pass a
defaulted `nowIso()` as that instant, so an entry recorded without one carried a
millisecond wall clock inside its own identity. Two identical calls therefore
almost never collided: executed at a 0 ms, a 2 ms and a 30 ms gap, an unchanged
replay of a 6000-unit entry was accepted as a NEW ROW every time and the
Founder's provider ceiling observed 12000 from 6000 actually spent, reporting
`blocked`. The direction is fail-safe — it over-reports and never grants — but a
fabricated measurement in the false-alarm direction is as much a fabrication as
one in the reassuring direction, and it also made the `cost_entry_conflict`
protection above technically true and practically unreachable on the default
path.

The key now carries the DECLARED instant or nothing, and an entry that declares
neither an `idempotencyKey` nor an `occurredAt` is REFUSED: HQ genuinely cannot
tell a replay from a second real spend when the caller declares neither, and it
will not invent a wall clock to say they differ (over-reporting) nor a match to
say they are the same (under-reporting against a Founder ceiling). The
`idempotencyKey` is therefore stated as what it is — the required mitigation
whenever the caller has no observed instant to declare — rather than left as an
unmentioned option. The cost, stated: every in-process caller of
`recordIntelligenceCost` must now declare one of the two.

This also answers a question carried from an earlier round rather than leaving
it open. A previous reviewer saw a cost-entry probe shuffle between runs and
hypothesized a script artefact; it was not one. It was this — the entry key
contained `nowIso()` at millisecond resolution, so the same script produced a
collision or a second row depending on how the clock fell.
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
2810. (`c9ddecc`'s claim of "109 tests across four new files" was 111 at that
head and is corrected here rather than left standing — Wave 5, LOW B-9.)

**The count above said 126 and was stale by two rounds (Low L4).** Counted at
the fourth-round head, the five Phase 14 test files hold **153**:
`intelligence-core` 52, `intelligence-authority` 52, `intelligence-surfaces` 17,
`intelligence-durability` 7, `intelligence-attribution` 25. Numbers on this page
are now recorded from a run rather than carried forward.
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
- **`model` budget scopes are REPORTED, not enforced at the routing gate.**
  Nothing in canonical truth binds a task to a model, so HQ has no honest
  derivation for a model scope and does not invent one. The `provider` scope IS
  enforced, because `provider_binding_mismatch` makes the cost ledger's provider
  vocabulary the same one as the canonical execution binding. See "WHICH ceiling
  applies is derived" above.
- **A scope with no recorded ceiling is not evaluated at all**, so a Founder who
  has recorded no mission policy is governed by the deployment baseline alone.
- **`requiresFounderDecision` is computed and published but read by nothing.**
  It appears on the proposal and on the escalation; no HQ path branches on it.
  Carried honestly rather than removed, and carried honestly rather than
  described as a gate.
- ~~**Escalation reuses the PRIOR decision's stored `requiredReviewTier` and
  `floorTier`** rather than re-deriving them … a capability that has since been
  made RISKIER is not re-checked against the new floor.~~ — **this states the
  OPPOSITE of the code and is corrected in the fourth round (Low L1).** At this
  head `escalateIntelligenceDecision` resolves the prior decision through
  `deriveDecisionRecord`, which reads the canonical risk class from
  `op_tasks`/`op_capabilities` unconditionally and takes
  `maxRequiredReviewTier(row.requiredReviewTier, canonicalReview)` — the
  STRONGER of the stored value and the freshly derived one. A capability made
  riskier since IS re-checked. The escalation is also evaluated against
  `#governingBudgetEvaluation(prior.taskId)`, the same derived most-restrictive
  answer the original was bound by, rather than the deployment baseline. The
  false statement was in the safe direction and understated the code.
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
   narrowed to what is enforced. **The sentence that stood here — "the raw
   objects are exported for testing and are not wrapped in themselves" — was
   left in the PRESENT tense after the code stopped making it true, and it
   contradicted both `RETRIEVAL_GUARD_STATEMENT` and two later passages of this
   page. It is corrected in the fourth round (Low L3).** At this head the raw
   adapters are module-private (`RAW_LEXICAL_RETRIEVAL_ADAPTER`,
   `RAW_SEMANTIC_RETRIEVAL_ADAPTERS`), every exported binding is wrapped AT
   DECLARATION, and — since the fourth round closed Medium M9 —
   `LEXICAL_RETRIEVAL_ADAPTER` is frozen too, so the wrapper cannot be replaced
   in place. The substantive guard is unchanged and sound; the FACADE scan
   remains the stated real guarantee.
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

**Which of the two layers is the guarantee — corrected.** All three Wave 5
correction lanes reached this independently (one as Medium 9, one as Low 3, one
as Medium C-2). The sentence above used to end "Both layers are kept: the outer
one gives a good error, the inner one is the guarantee", and commit `0c5edea`'s
message said "a test proves the wrapped adapter is never CALLED with
credential-shaped terms". The structural claims mostly held — every resolver
branch returns a wrapper, and a recording stand-in got zero calls — but the
ATTRIBUTION was the wrong way round, and one claim was simply false when it was
made. Both are now stated as they are, and the false one was made TRUE by the
box above rather than by narrowing the sentence:

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
- **"An in-process caller cannot obtain an unguarded adapter" is TRUE, and it
  was made true structurally rather than narrowed away.** The paragraph that
  stood here said the opposite — that the raw adapters were exported for testing
  and were not wrapped in themselves — and it was dropped-lane prose that
  survived into the merged document while contradicting the row about the same
  finding further down this page (Wave 5 correction round three, Low B9). At
  this head `RAW_LEXICAL_RETRIEVAL_ADAPTER` and `RAW_SEMANTIC_RETRIEVAL_ADAPTERS`
  are module-private, `LEXICAL_RETRIEVAL_ADAPTER` and
  `SEMANTIC_RETRIEVAL_ADAPTERS` are `guardRetrievalAdapter(...)` applied AT
  DECLARATION, and there is no exported binding through which an unguarded
  `retrieve` can be reached — including a semantic adapter a future build adds
  to the list, which is guarded where it is declared rather than at the one call
  site that happens to resolve it.

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
| A HIGH 2 = C HIGH B-1 — `budgetScope` was a caller parameter and which ceiling applied was chosen, not derived | "The law: WHICH ceiling applies is derived, never chosen". This lane's `#canonicalBudgetScopes` + `mostRestrictiveBudget` was the DROPPED duplicate; the surviving implementation is `#governingBudgetScopes` + `combineBudgetEvaluations` (all missions, the bound provider, and `governedBy` provenance) | this lane's tests in `intelligence-authority.test.ts`, kept and ported, plus `intelligence-attribution.test.ts` |
| A HIGH 3 = C HIGH B-2 (second half) — `occurredAt` was caller-supplied and the window measured it | "The law: the window is measured on the instant HQ stamped"; the window filter reads `recorded_at`, and the instant must parse AND sit inside the bounded interval around now | this lane's tests in `intelligence-authority.test.ts` (the backdated case ported to a date inside the new bound), plus `intelligence-attribution.test.ts` |
| A MEDIUM 5/6/7 — three fail-open reads in the cost and routing policy | recorded at each site above | new tests in `intelligence-core.test.ts` and `intelligence-authority.test.ts` |
| A MEDIUM 8 = C HIGH B-2 — a spend was attributed to a declaration, not to canonical work | "The law: a spend is attributed to canonical work". This lane's `#canonicalWorkIdentity` was the DROPPED duplicate (it read the first plan item only); the survivor is `#canonicalTaskScopes`, and this lane's decision-id existence/ownership check is kept on top of it | this lane's tests in `intelligence-authority.test.ts`, kept and ported, plus `intelligence-attribution.test.ts` |
| A MEDIUM 9 = B LOW 3 = C MEDIUM C-2 — the seam guard's scan is inert on tokenized terms, and the raw adapters were exported | "The `assertBrowserSafe` pre-real-adapter Low" above, which names the FACADE scan as the guarantee. The "cannot obtain an unguarded adapter" claim was made TRUE structurally (raw adapters module-private, every export guarded at declaration) rather than narrowed away, so this lane's prose fix is the dropped duplicate and its assertions are ported or inverted | both lanes' tests in `search-adapter-guard.test.ts` (12 tests), one of which pins the tokenization fact against six real credential shapes |
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

**Verification after the FIRST reconciliation** (Lane A + Lane B; the whole
suite, not a subset):

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

---

## Wave 5 SECOND correction pass, and the THREE-lane reconciliation

Three further fresh read-only hostile reviewers, none of whom authored the head
they reviewed and none of whom knew about the two lanes above, returned
0 Critical / 5 High / 7 Medium / 13 Low across both phases; every High was
reproduced by execution. That correction is **Lane C**, and it was then merged
with the Lane A + Lane B head on the same principle that merge used: nothing
from either side is discarded, and where both sides fixed the same defect
differently ONE implementation survives with BOTH sides' regression tests ported
onto it. The findings that touch Phase 14 are corrected in place above, in the
sections they belong to:

| Finding | What changed | Pinned by |
|---|---|---|
| HIGH B-1 — a caller chose which Founder budget policy governed its own write | the `budgetScope` parameter is GONE from `intelligenceRoutingProposal` and `recordIntelligenceDecision`; `#governingBudgetScopes` derives the applicable scopes from canonical truth (deployment baseline + the task's missions and projects + its bound provider), and `combineBudgetEvaluations` takes the most restrictive decision and the INTERSECTION of permitted tiers | `test/intelligence-attribution.test.ts`, including the reviewer's own shopped-scope reproduction and the mission-ceiling case it was used to route around |
| HIGH B-2 — every non-deployment ceiling and both time windows were keyed on caller strings | mission and project come from `hq_mission_plan_items`/`hq_missions`; a `providerId` contradicting the canonical binding is `provider_binding_mismatch`; `occurredAt` is clamped to a bounded interval around `nowIso()` (one hour ahead, thirty days behind) | the ghost-mission, misattributed-provider and 2099-dated-entry cases, same file |
| MEDIUM B-3 — "recompute the floor" was described as closing a forgery it only relocates | the comment and the doc say what recomputation does; structurally, `bound_provider`, the risk class and the review requirement are re-derived at READ time from `op_tasks`/`op_capabilities` | a raw append forging all three, same file |
| MEDIUM B-4 — `rowToBudget` failed OPEN on a malformed row | `unrecognized` scope/window (matching nothing) and a `null` ceiling answering `requires_founder_decision` | the reviewer's one-append reproduction, same file |
| MEDIUM B-5 — first-write-wins dedupe let a `billed 0` suppress a real amount | a second entry with the same identity and a different figure is `cost_entry_conflict`; an identical one still dedupes. **The fifth correction round makes that identity real** (Low 3): `occurredAt` used to DEFAULT to `nowIso()` and then feed `costEntryKey`, so the identity of an unkeyed entry contained a millisecond wall clock and two identical calls essentially never met — executed at 0 ms, 2 ms and 30 ms gaps, a replay of a 6000-unit entry was accepted as a second row every time and the Founder ceiling observed 12000 from 6000 spent. The key now uses the DECLARED instant only, and an entry that declares neither an `idempotencyKey` nor an `occurredAt` is refused, because HQ cannot then tell a replay from a second real spend and will not invent an answer in either direction | same file, plus `test/intelligence-cost-identity.test.ts` |
| LOW B-6 — the escalation view's `requiresFounderDecision` came from the request, not the row | projected from the stored `budgetDecision`, like the trigger beside it | same file |
| LOW B-7 — `MAX_COST_BASIS_LENGTH` never applied to an `estimated` basis, and the refusal was misnamed | the bound applies to every provenance; `basis_too_long` is its own refusal | same file |
| LOW B-8 — `providerId`/`modelId` were scanned at the route and not at the facade | `assertBrowserSafe` at the facade, where `recordIntelligenceCost`'s only callers are | same file |
| LOW B-9 — doc drift (test count, the `budget_ceiling_blocks` claim, the undisclosed caller-supplied scope) | all three corrected above | — |
| MEDIUM C-2 — "an in-process caller cannot obtain an unwrapped adapter" was false | the raw adapters are module-private; `LEXICAL_RETRIEVAL_ADAPTER` and every member of `SEMANTIC_RETRIEVAL_ADAPTERS` are guarded AT DECLARATION, and `guardRetrievalAdapter` is idempotent | `search-adapter-guard.test.ts`, with the assertion inverted from "the resolver wraps" to "there is nothing unwrapped to obtain" |
| LOW C-1 — a credential split across two search fields passes both scans | NOT fixed; recorded below | — |
| LOW C-2 — ten of the eleven credential patterns were case-sensitive, and invisible characters defeated all of them | the patterns are case-insensitive (the JWT one deliberately excepted: `eyJ` is base64url, not a spelling) and values are NFKC-normalized with zero-width and bidi controls stripped before matching | `live-redaction.test.ts` |

**Where Lane C and the Lane A + Lane B head fixed the SAME Phase 14 defect**,
the surviving implementation and the reason are recorded in the lane table
above; in summary:

- **which ceiling governs, and what a spend is attributed to** — Lane C's
  `#governingBudgetScopes` / `#canonicalTaskScopes` / `combineBudgetEvaluations`
  survive over Lane A's `#canonicalBudgetScopes` / `#canonicalWorkIdentity` /
  `mostRestrictiveBudget`, because they derive EVERY mission a task is linked to
  rather than the first plan item, enforce the provider scope (which
  `provider_binding_mismatch` makes canonically attributable), and carry
  `governedBy`. Lane A's `Readonly` severity map, its `.trim()` on the proposal's
  task id, and its decision-id existence/ownership check are carried onto the
  survivor, and its tests are kept;
- **`occurredAt`** — the bounded interval survives over "must parse, may not be
  in the future", because it closes both directions; the future refusal keeps
  the other lane's name and message fragment, and Lane A's structural half (the
  window filter reads `recorded_at`) is unchanged and is what the backdated test
  still pins;
- **`MAX_COST_BASIS_LENGTH`** — Lane A's ordering survives (the bound is checked
  BEFORE the provenance switch, so a long basis on an `unknown` cost is
  `basis_too_long` and not the other refusal), together with its rule that a
  non-estimate may not carry a basis at all. Lane C's late bound is dropped as
  the weaker placement; both lanes' tests hold against the survivor;
- **the retrieval guard statement** — Lane C's structural fix survives over Lane
  A's prose narrowing, so the claim "no in-process caller can obtain an unwrapped
  adapter" is TRUE rather than deleted. Lane A's assertions on the statement text
  are ported, except `toContain('exported for testing and are not wrapped')`,
  which is INVERTED because that sentence is now false.

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

**Verification at the THREE-lane merged head** (the whole suite, not a subset):

| Command | Result |
|---|---|
| `npm run test:hq` | 164 files, 3109 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root) | 37 files, 569 passed, 3 skipped |
| `npm run build` | all workspaces; web `215.66 kB` / `69.22 kB` gzip (unchanged) |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |

Lane C alone was 164 files / 3080 tests and the Lane A + Lane B head 162 /
3073; the merged head exceeds both, which is what "nothing was dropped" looks
like in the count. Nothing was deleted, skipped, weakened or narrowed to make
the merge green: no `.skip` / `.only` / `.todo` / `xit` / `xdescribe` was added
anywhere, no `as any`, no `@ts-expect-error` and no `eslint-disable` in an added
line. Seven assertions written by the two earlier lanes were PORTED onto the
surviving implementations rather than dropped — five of them because the
survivor answers more strictly than the lane that wrote the assertion expected
(the re-labelled open, the deliberately fresh `idempotencyKey` open, the
un-checkpointed-WAL refusal name, the backdated `occurredAt`, and the retrieval
statement's "exported for testing" disclosure, which is inverted because it is
now false), and two because the survivor's signature changed (`fullIntegrity`'s
chain verifier is required, and the guard statement names declaration rather
than the resolver). Every guarantee either lane pinned is still pinned. The
three pre-existing `it.skip` GAP markers under `packages/server` are untouched;
`git diff` against the wave base `f1ce71c` over `packages/server`,
`packages/web`, `packages/shared` and `packages/config-mesob` is empty; and
`package.json` and `package-lock.json` are byte-identical to that base.

---

## The FOURTH reconciliation: the second correction round merged with the three-lane head

The three-lane head above and the "second correction round" recorded earlier in
this document were produced CONCURRENTLY, on the same branch, both descending
from `4c83f54`, by efforts that did not know about each other. This section
records their merge for Phase 14. The full account, including the CRITICAL that
had to survive it, is in the matching section of `PHASE_13_ADVANCED_RELIABILITY.md`.

**What each side contributed to this phase.**

The three lanes contributed the canonical budget-scope derivation and spend
attribution (`#canonicalTaskScopes`, `#governingBudgetScopes`,
`combineBudgetEvaluations`, with `budgetScope` removed as a parameter rather
than validated), `cost_entry_conflict`, `provider_binding_mismatch`,
`deriveDecisionRecord`'s canonical re-derivation of `bound_provider` and the
risk class, the fail-closed `rowToBudget`, the bounded `occurredAt` interval,
`requiresFounderDecision` projected from the stored row, the facade-level
`assertBrowserSafe` scan of `providerId`/`modelId`, and the NFKC-normalized
case-insensitive credential patterns.

The second correction round contributed `readStoredCostFact`'s two remaining
parity gaps (a raw-appended `billed` row carrying a basis, and an `estimated`
row whose basis exceeds `MAX_COST_BASIS_LENGTH`, both of which used to read back
as `state: 'known'`), the bounded and shape-checked `decisionId` with refusals
that carry the code rather than echoing the caller's text, and the
`trg_hq_mission_plan_items_no_erase` guard that closes the one executed fail-open
this phase's budget derivation stood on.

**One duplicate implementation, one survivor.** Both sides put
`hq_mission_plan_items` into the integrity census, from two different exploits.
`EngineImmutableTable.requiredGuards` survives and `holdsUniversalTrio: false` is
dropped, because a boolean can only say "the trio" or "nothing" and cannot
express the REQUIRED `no_erase` that closes the DELETE fail-open described
above. The other lane's exploit — dropping `_no_replace` so an `INSERT OR
REPLACE` rewrites a plan item's task binding — is closed by the same entry, and
its inverted live-schema test (the live trigger set EQUALS the union of the
declarations, so a guarded table nobody listed is a test failure) is kept and
binds it. Nothing else in this phase was fixed twice: the budget-scope
derivation exists once, in the surviving `#governingBudgetScopes`.

## The THIRD correction round: what two independent hostile reviews reproduced

| Finding | What was reproduced | What changed |
|---|---|---|
| **HIGH B1** — a mission ceiling stopped accumulating at the second link | The attribution wrote `canonical.missionIds[0]` while `#governingBudgetScopes` derived every mission, and `#entriesForScope` matched that one column — so the non-first mission's ceiling was evaluated against ZERO entries. Identical spend under an identical ceiling: `blocked, observed 5000000` with one link, `within_ceiling, observed 0` with two. Twelve runs of the two-link configuration enforced eight times and bypassed four, on uuid sort order. Through `linkMissionPlanItem`, no raw SQL. | Scope membership is derived from `hq_mission_plan_items` per entry — canonical truth rather than a column that can only hold one of N. Projects the same. |
| **HIGH B2** — the `provider` scope was DEAD | `recordIntelligenceCost` demanded a lowercase slug and then equality with the uppercase canonical binding, so `CLAUDE`, `claude` and `Claude` all failed. No cost entry against a provider-bound task was expressible, every provider ceiling stayed at `observed: 0` forever, and a task bound to lowercase `claude` is unclaimable. The doc and the code comment both claimed the two vocabularies were one by enforcement. | `normalizeProviderId` — a case fold, injective over the canonical set, applied at the cost write, the observation write, the budget write and the budget read. The decision record still stores the canonical binding verbatim. |
| **MEDIUM B3** — escalation recorded a tier the enforced path refuses | `escalateIntelligenceDecision` never ran `#resolveRecordedTier`; `deriveEscalation` picked the cheapest higher permitted tier and consulted neither the review requirement nor the floor. Through supported calls only: the enforced path refused `low_cost` with `review_tier_required` while escalation recorded `low_cost` against a `critical_review` requirement. | Two checks: the derivation skips a tier that cannot satisfy the requirement, and the facade runs the shared resolver against a freshly derived proposal. |
| **MEDIUM B4** — a double-column forgery escaped the canonical re-derivation | The re-derivation was skipped when `characteristics` failed to parse, and an unparseable column reads as null. Forging both columns gave `requiredReviewTier: null`, `satisfies: true`, and the row dropped out of `reviewRequired` in analytics. | The canonical risk class is read first and unconditionally. It was in scope and simply unused on that branch. |
| **MEDIUM B5** — spend from an UNBOUND task poisoned another provider's ceiling | The binding check only ran when a binding existed, so a claim-holding worker pushed an unrelated Founder ceiling from `observed 0` to `blocked, observed 999999`. | The provider scope is measured against the task's canonical binding. The entry is still recorded and still counts toward the deployment total. |
| **MEDIUM B6** — the `provider_binding_mismatch` proof was vacuous | The test guarded on `boundProvider == null` and always took its early return, because the fixture's claim task binds no provider — while its comment claimed the opposite. That vacuous test is why B2 shipped. | The fixture gains a genuinely provider-bound claim; the unbound case is its own test. |
| **MEDIUM B7** — invisible characters defeated the STATED facade guarantee | `normalizeForScan` stripped five hand-listed ranges. U+00AD, U+180E, U+034F, U+2028, U+2029, U+115F and U+FFA0 all passed the scan inside every credential shape the guard knows. End to end: a plain `sk-…` note refused 400, the same note with one soft hyphen stored 201 and returned on the wire; and `searchCompany`/`askJenify` refused the plain form and ACCEPTED the hidden one. The added test picked exactly the three characters the implementation handled. | A Unicode PROPERTY — default-ignorable plus format, with the three invisible splitters that are in neither category named — and a pinning test using code points the implementation does not enumerate. |
| **LOW B8** — the cost-entry conflict check covered three columns | A second entry with the same amount but `unitsObserved` 9,999,999, an invented `basis`, or a citation of a real `decisionId` deduped SILENTLY and the stored values stayed the first row's. `units_observed` is published on the Founder route and `basis` is what law 2 says an estimate must name. | All six figures are compared. |
| **LOW B9** — dropped-lane prose surviving into the merged document | The paragraph claiming the raw retrieval adapters "are exported for testing and are not wrapped in themselves" was false at this head and contradicted the merge row further down the same page. | Corrected to what the code does: the raw adapters are module-private and every exported binding is guarded at declaration. |

**What is NOT fixed in this phase**, all sides' disclosures in one list: a
credential split across two search fields still passes both scans; a forged
decision row can still understate complexity, context size and work kind, since
only the risk class has a canonical source; no MODEL-scoped ceiling governs a
decision write, because nothing in canonical truth binds a task to a model; a
scope with no recorded ceiling is not evaluated; a raw appender can still widen a
budget by appending a higher-version row; a genuine observation older than thirty
days can no longer be recorded, which is the stated cost of the bounded
`occurredAt` interval; the `unrecognized` provenance bucket is documented as
unreachable rather than as a live defence; and `recordIntelligenceCost` /
`recordIntelligenceDecision` no longer accept mission/project/provider/budget-scope
arguments at all, so an in-process caller that passed them silently gets
canonical attribution instead — a deliberate behaviour change, not a compatible
one.

**Added by the third correction round**, and each stated where it belongs as
well as here: ~~a cost entry's stored `mission_id` and `project_id` still hold
one value each and are recorded ATTRIBUTION only — every ceiling is measured from
`hq_mission_plan_items` instead, so the columns can be read as a summary but
never as the measurement~~ — **superseded twice, and left unmarked until round
eight (Low 2).** Both halves of that sentence stopped being true in this wave and
the H2 row below in this same section already says so. Round FOUR is where it
first stopped being true — that is the round that made the stored attribution one
half of a union and therefore load-bearing, and the concurrent round-seven lane
reached this same finding from that end. Round six (High 3) then added
`mission_ids`, and round seven (High NEW-4) added `project_ids`: a cost entry
now records the WHOLE set it was recorded under, not one of N. And
`#entriesForScope` measures from those columns — `canonicalOf(entry.taskId)
.missionIds.includes(scope.scopeId) || entry.missionIds.includes(scope.scopeId)`
— so the recorded columns are a measurement term, which is precisely what makes
the ceiling survive `assignMissionToProject` severing the canonical link
(`blocked / observed 5000` where the canonical read alone returns
`within_ceiling / observed 0`). The residual that still holds is narrower and
is stated in the H2 row: the singular `mission_id`/`project_id` columns remain,
carrying the FIRST of the set for display, and a reader who measures from those
rather than from the plural ones gets one of N.

The rest of that list still holds as written: spend recorded against a provider
the task is not canonically bound to is kept in the deployment total and
measures no PROVIDER ceiling, which means an unbound lane's provider ceiling
cannot be filled at all rather than being fillable by anyone; the provider fold
is a CASE fold and nothing else, so two providers whose ids differ only by case
would collide, which the canonical uppercase-distinct set makes impossible today
and a future set would have to preserve; and the credential scan remains
SHAPE-based — folding away invisible characters widens what it catches and does
not make it a data-loss-prevention filter.


## The FOURTH correction round: what three independent hostile reviews reproduced

Three read-only reviewers re-read the third-round head (`22680ba`) by EXECUTION.
The Phase 14 half of what they returned is below; the Phase 13 half, the
cross-cutting findings and the full verification table are in
`PHASE_13_ADVANCED_RELIABILITY.md`.

| Finding | What was reproduced | What changed |
|---|---|---|
| **HIGH H2** — an exhausted budget ceiling could be nullified: `blocked, observed 5000` became `within_ceiling, observed 0`, and the refused write then succeeded | The previous round moved ceiling measurement off the append-only cost ledger's own columns onto three MUTABLE, UNCENSUSED tables: `hq_mission_plan_items.mission_id`, `hq_missions` (joined at `service.ts`) and `op_tasks.payload`. The hardening guarded `DELETE` and a `task_id` relink and nothing else. Three routes: **(a)** a principal with `originateCapabilities: ['hq.mission_command']`, no approval authority and no `hq.intelligence_command`, calling `assignMissionToProject({projectId: null})` — a supported facade call, no raw SQL; **(b)** `UPDATE hq_mission_plan_items SET mission_id` (the `no_relink` guard is declared `BEFORE UPDATE OF task_id`), `UPDATE hq_missions SET project_id = NULL`, `DELETE FROM hq_missions`; **(c)** `UPDATE op_tasks SET payload`. Nothing in the census or safe mode fired on any of it. The reviewer separated the halves by re-running against a reverted copy: the ENFORCEMENT drop-out was pre-existing; what this wave ADDED was that `observed` collapses to 0, removing the last place a Founder could see the spend the ceiling was exhausted by. | One rule closes all three: **canonical membership UNION the attribution HQ itself recorded**. `mission_id`, `project_id` and a new `provider_bound` flag are derived by HQ at record time from canonical truth — no caller supplies one — and the rows are append-only. **The round-six correction had to finish it (High 3): the rule was right and the recorded half was incomplete**, so the union was NOT monotone for a task linked to two or more missions. `mission_id`/`project_id` store `canonicalScopes.missionIds[0] ?? null` — ONE of N — so the union was complete only for the mission or project that sorted first, and a FOURTH route reached the same nullification with no raw SQL at all: `assignMissionToProject` on the mission owning the project the row did not store, by the same `hq.mission_command`-only principal. Executed: victim project `blocked, observed 5000` → `within_ceiling, observed 0`, the refused `recordIntelligenceDecision` RECORDED, and `byProject` crediting the 5000 to the escape project. Two further append-only columns — `mission_ids` and `project_ids`, added by `ensureCostEntryScopeColumns` and holding EVERY scope HQ derived at record time — are what make the sentence true; a row written before they existed reports its single column, which is exactly what that row committed to. With them the union really is monotone against every SUPPORTED route — and even that is the THIRD term's doing rather than these two columns', which is the concurrent round-seven lane's Medium 6: this row said "with them the union really is monotone and unforgeable" and it shipped false in rounds four, six AND seven, because the union's other half is canonical membership NOW, which a facade call can narrow — executed 12 times out of 12 by moving a mission P1 to P2, spending under P2 until the ceiling blocked, then moving P2 to P3. **It is not "unforgeable", which is what this row said until round ten (Medium 1)** — `hq_intel_cost_entries` is append-only by trigger and carries no hash chain, so a writer holding the file can drop the four guards, rewrite `mission_ids`/`project_ids` in place without changing the row count, and put them back; executed on a task with its OWN recorded spend, `observed` went 5000 to 0 and a refused `critical_review` was ACCEPTED, with both integrity depths reporting `safeMode: false` and no observation. That is the count-preserving in-place rewrite class in the NOT-fixed list below, not a route this union was ever going to close. The `mission` scope always held; only `project` was reachable this way. It is applied identically to `#entriesForScope` (the observed figure) and `#governingBudgetScopes` (which policies bind), so the pre-existing enforcement half is closed with the new one rather than beside it. `provider_bound` takes the provider ceiling off `op_tasks.payload` entirely for work that already happened. Engine guards for the raw routes: `trg_hq_mission_plan_items_no_remission`, and `trg_hq_missions_no_erase` / `_no_replace` with `hq_missions` joining `ENGINE_IMMUTABLE_TABLES` under a reduced base. **And it was still an OVERCLAIM for a task with no spend of its own** (round seven, High NEW-4): the recorded half has nothing to add for NEW work under a ceiling some OTHER task exhausted, so such a task was governed by the mutable `hq_missions.project_id` alone. Executed against `d97b8a6` with the ceiling exhausted by task A and the attack on task B in the same project, as a principal with `originateCapabilities: ['hq.mission_command']`, `approvalAuthority: false` and no intelligence grant: `assignMissionToProject({projectId: null})` was accepted, `permittedTiers` widened from `["deterministic_local"]` to all five, and a `critical_review` record was ACCEPTED — while that same principal calling `setIntelligenceBudget` directly is correctly `refused(not_permitted)`. Raw `UPDATE hq_missions SET project_id = NULL` did the same. A THIRD term closes it: project membership is also derived from the APPEND-ONLY mission event log (`#durableTaskProjectScopes`), which records both ends of every `assignMissionToProject` move and — since round seven — the project a mission was created under, so clearing the link narrows nothing. Applied identically to the governing set and to the measurement. |
| **HIGH H3** — one accepted write permanently bricked BOTH new Founder read routes | `openRun` and `recordIntelligenceDecision` scanned their labels with the weak `api_key: value` heuristic while `control-api.ts` applies the strict, shape-based `assertBrowserSafe` to every response. `sk-…`, `ghp_…`, a PEM header and `Bearer …` were all STORED; the rows are append-only; `GET /api/control/reliability` and `GET /api/control/intelligence` then answered `500 {"code":"internal"}` on every subsequent read, forever, with no DELETE or UPDATE able to undo it. | Every facade write that stores caller text goes through one function, `assertNoCredentialShape`, which is the SAME `assertBrowserSafe` the read boundary uses (29 call sites when this row was written; round six found three write sites the sweep had missed and round seven another five). **The running count that stood here — "46 call sites at this head" — was stale from the round it was written, and is removed rather than re-counted** (Wave 5 correction round eleven, Low 4): it was 47 for several rounds and is 48 after round eleven, and nothing checked it. What the claim rests on now is derived — see High 4 and Medium 4 below, and the round-seven correction that follows. Any text a write accepts and a read refuses is a permanent outage waiting to be typed, so the asymmetry is closed rather than the two labels patched. The two refusal messages (Low L2) are corrected with it: they claimed shape detection the weak check did not perform. **Corrected again in round seven (Medium 2): "29 call sites" and "the asymmetry is closed" were both premature.** Five facade writes still stored caller text unscanned, and each was executed to the outage — `createTask`'s `title` (`500` on `/state` and `/commandCenter`) and `project` (`/state`), `failTask`'s `reason` (both), `registerExecutionWorker`'s `displayName` (`/state`, `/workforce`, `/commandCenter`, from a create-only command) and `engageKillSwitch`'s `reason` (both, on the act a Founder reaches for to stop everything). All five are scanned now, and the claim is no longer a count in a document: `facade-write-scan.test.ts` enumerates the facade's text-storing writes from the source and fails when one of them does not call the function. One carve-out is named rather than implied — `createTask`'s task PAYLOAD, which no control route serves and whose strict guard lives at the dispatch boundary that would publish it; that carve-out is itself executed in the same file. **And three more, found independently in the other round-seven lane (High NEW-3):** `recordVerifiedBackup.note`, `recordIntelligenceOutcome.note` and `disableAiMember.reason` bounded their text with `missionText` — a LENGTH check — and never reached the scan; `recordVerifiedBackup` was live and bricked `GET /api/hq/control/reliability` exactly as this row describes. All three are scanned, and a SECOND derived assertion stands beside `facade-write-scan.test.ts`: `credential-scan-coverage.test.ts` enumerates every member of `service.ts` that calls `missionText` (29 at this head) and names any that does not also call the scan. The two enumerate different things — public methods that store caller text, and length-bounded text fields — and neither subsumes the other, so both stand. |
| **MEDIUM M5** — `analytics.cost.byMission`/`byProject` rested on the one-of-N stored column | Six runs, one task linked to two missions, one 5000 spend: four runs attributed 100% to mission A and 0 to B; two the reverse. This page claimed the stored columns "measure nothing"; they measured `intelligenceAnalytics()`, served on `/api/hq/control/intelligence`. | Folded from the same union the ceilings use. A task linked to two missions counts IN FULL under each, because HQ has no basis for a split and does not invent one. `summarizeIntelligenceAnalytics` takes the canonical derivation as a REQUIRED input, so a missing one cannot read clean. |
| **MEDIUM M6** — a claim-holding worker poisoned the Founder's spend-by-provider report | `byProvider` folded the caller-declared `row.providerId` that the ceiling path had already stopped trusting: `[{"id":"openai","knownAmountMinorUnits":999999}]` went out for work HQ has no canonical statement ever ran there, while the ceiling correctly read `observed 0`. Two surfaces over one ledger, disagreeing about the same spend. | Folded on the binding HQ vouched for (`provider_bound`). An amount HQ cannot attribute lands in a categorical `unattributed` bucket rather than being credited to whoever the worker named. |

### Round seven, Medium NEW-6 — `provablyAvoidable` flipped retroactively and two published numbers contradicted each other

`decisionIsProvablyAvoidable` recomputed the tier floor from the **current**
canonical risk class while `rowToDecision` served the **stored** `floor_tier`.
Two published numbers over one row, computed two different ways. Executed: a
Founder registry upsert that raised a capability's risk class flipped
`provablyAvoidable` 1 → 0 **and** left the served record reporting `floorTier:
deterministic_local` beside `requiredReviewTier: critical_review` — which this
document itself says cannot both be true, because the review requirement is one
of the terms `computeRoutingProposal` takes the floor's `max` over. Neither the
flip nor the contradiction was disclosed anywhere.

**ONE computation answers both now.** `deriveDecisionRecord` recomputes the
floor from the canonically-corrected characteristics and SERVES that;
`decisionIsProvablyAvoidable` reads its result instead of recomputing a second
time, so the two cannot diverge again. The stored value is carried beside it as
`floorTierAsRecorded`, so no history is lost. And the flip is REPORTED rather
than absorbed: `riskClassChangedSinceIssue` on each record, counted on
`analytics.provablyAvoidable.riskClassChangedSinceIssue`, and
`AVOIDABLE_SPEND_STATEMENT` now says out loud that the floor is recomputed from
canonical truth as it stands and that the set can therefore change after a
decision was issued.

The flip itself is kept rather than suppressed: raising a capability's risk
class really does raise the floor, and a decision that was above the old floor
may be at or below the new one. Excluding such rows would hide a real change in
canonical truth; what was wrong was doing it silently and inconsistently.

### What the fourth round adds to Phase 14's NOT-fixed list

- **A cost entry that HQ could not attribute to a provider is reported as
  `unattributed` rather than dropped.** The amount is real and still counts
  toward the deployment total; what HQ refuses to do is name a provider for it.
  A reader who wants per-provider spend for such work has to bind the task
  first.
- **An entry linked to two missions counts in full under BOTH.** The sum of
  `byMission` can therefore exceed the sum of `byCurrency`. That is the honest
  reading — each mission's ceiling really is measured against the whole spend of
  the work linked to it — and it is stated on the fold rather than smoothed over
  by an invented split.
- **`op_tasks.payload` remains mutable and uncensused**, and the provider
  ceiling no longer depends on it for work that already happened. What still
  depends on the live payload is which provider scope governs a NEW decision on
  a task that has not yet recorded any spend. A write-once guard on the column
  was implemented and withdrawn — see the Phase 13 document for why.
- **A MODEL-scoped ceiling still does not govern a decision write**, unchanged:
  nothing in canonical truth binds a task to a model, so `byModel` stays on the
  entry's own column and a model ceiling is readable but not binding.
- **A raw appender can still widen a budget by appending a higher-version row**,
  and can still understate complexity, context size and work kind on a forged
  decision row. Both unchanged from the third round.

### The fourth round had TWO concurrent lanes, and this document describes the merged head

A second correction lane reviewed the same frozen head `22680ba` at the same
time, without either lane knowing about the other, and corrected it on this same
branch. Its two commits are entirely Phase 13 — the total-erasure census bypass,
the evidence chain's laundered length, U+2800, a Cyrillic/Greek lookalike fold
and the `file_has_multiple_links` disclosure — so **no Phase 14 finding above was
touched by it, and every sentence in this document's fourth-round section stands
unchanged at the merged head.** The full reconciliation record — what survived
from each lane, what was dropped and why, which regression tests were ported and
what each now asserts — is the section "The fourth round's two lanes,
reconciled" in `PHASE_13_ADVANCED_RELIABILITY.md`.

Three residuals that lane disclosed reach Phase 14 surfaces even though the code
is Phase 13's, so they are named here as well as there rather than left to a
cross-reference:

- **The `PRAGMA user_version` schema mark is not written when the facade cannot
  write it**, and the facade never fails a construction over the mark. A file HQ
  could not stamp is a file HQ reads as new next time — including on the
  read-only `hq:snapshot` path that renders this phase's intelligence section.
- **Seq contiguity is silent on an evidence log DROPPED and recreated whole**,
  because the seqs then restart at 1 with no gap. That is the dropped-ledger
  question and it is answered by the first-boot discriminator and the durable
  chain-tip commitment in `hq_integrity_checkpoints` instead, not by the chain
  check.
- **Every in-process caller of `recordIntelligenceCost` must now declare an
  `idempotencyKey` or an `occurredAt`** (fifth round, Low 3), because HQ will not
  read its own wall clock into a spend figure's identity. An entry declaring
  neither is refused. This is a real obligation on callers, not a default that
  quietly does the right thing, and it is stated here rather than discovered at
  the first refusal.
- **The commitment the item above rests on lives in ONE ledger, not two.** The
  concurrent lane recorded the same chain tip on every verdict row; the
  reconciliation kept `hq_integrity_checkpoints` and retired that mechanism, on
  the merits recorded in Phase 13 ("The round-five reconciliation"). The cost is
  that an attacker who wants the commitment silenced now has one ledger to drop
  rather than two; the measured consequence is in Phase 13's residual list.
- **The confusable fold has one visible cost, and it is shared by every write
  this phase accepts**, because `recordIntelligenceDecision`'s labels go through
  the same `assertNoCredentialShape`: Greek capitals for `TOKEN` fold to `TOKEN`,
  so Greek text of the form `ΤΟΚΕΝ: ********` is refused exactly as the English
  spelling already is. The bound that holds for the MERGED fold — and the two
  keywords (`apikey` and `cookie`) a modern Cyrillic alphabet can spell — is
  computed and disclosed in the Phase 13 residual list.
- **Round seven widened the same scan to combining marks and unassigned code
  points, and it reaches every write on this phase's surfaces.** `\p{Mn}`,
  `\p{Me}` and `\p{Cn}` each carried a credential shape past the guard —
  U+0301 and U+0378 among them — and none of the three was disclosed anywhere.
  Marks are now stripped from an `NFKD` copy before the pipeline runs and all
  three categories join the erase set; the fold is a SCAN COPY, so accented text
  a Founder writes is stored and served byte-unchanged. Measured after the fix:
  0 survivors over 1,809 marks and 815 sampled unassigned code points, and no
  new refusal on accented prose in five languages. **Corrected at round nine
  (High 1): the "what is still open" clause that stood here was FALSE.** It
  named only the anchoring residual and `\p{Zs}`, and `\p{Co}` PRIVATE USE —
  137,468 code points, taking the identical argument to the `\p{Cn}` this round
  closed — was open, in no residual list, no comment and no test. It is closed
  at round nine. What is still open and disclosed on both pages, after that
  fix: a word character running straight into the prefix (`Xsk-…`, `9sk-…`)
  reaches a written `hq-snapshot.json`, and `\p{Zs}` is deliberately not
  folded. Those two are now the whole list, and the claim is DERIVED rather
  than written: the whole-plane sweep in
  `redaction-invisible-classes.test.ts` pushes all 1,112,064 non-surrogate code
  points through the guard and fails if any zero-ink one survives.

**Verification at the round-five merged head** (the whole matrix, all green,
exit 0): `npm run test:hq` 166 files / 3192 tests; `npm test` (root) 37 files /
569 passed + 3 pre-existing skips; hq-host 23 / 222; hq-server 2 / 20; all four
typechecks clean; `npm run build:site` 10 pages + `hq-snapshot.json`;
`npm run build` all workspaces, web initial JS 215.66 kB / 69.22 kB gzip,
unchanged. The round-four merged head was 164 / 3177 and the other lane's head
175 / 3073; the merge exceeds both.

### The sixth correction round — Phase 14's half

Two fresh independent read-only reviewers re-read the round-five merged head
(`6a0f6ae`) by EXECUTION and returned 0 Critical / 5 High / 7 Medium / 7 Low.
The Phase 14 findings are below; the Phase 13 half, the cross-cutting findings,
the full verification table and the re-verified guarantees are in
`PHASE_13_ADVANCED_RELIABILITY.md`.

| Finding | What was reproduced | What changed |
|---|---|---|
| **HIGH 3** — the budget-ceiling nullification had a FOURTH route, for any task linked to two or more missions | `recordIntelligenceCost` stores `canonicalScopes.missionIds[0] ?? null` and `projectIds[0] ?? null` — one of N. `#entriesForScope` and `#governingBudgetScopes` union canonical membership with that single column, so the union is complete only for the scope that sorts first. Executed with NO raw SQL: a principal holding only `hq.mission_command`, `approvalAuthority: false`, no intelligence grant, called `assignMissionToProject` on the mission owning the non-stored project — victim project `blocked/observed 5000` → `within_ceiling/observed 0`, the previously refused `recordIntelligenceDecision` RECORDED, and the same principal raising the ceiling directly still correctly `not_permitted`. The published report was not merely blinded but wrong: `byProject` afterwards credited the 5000 to the escape project, which had spent nothing. | Two append-only columns, `mission_ids` and `project_ids`, added by `ensureCostEntryScopeColumns` exactly as `provider_bound` was, holding EVERY scope HQ derived at record time. `#entriesForScope`, `#recordedScopesForTask` and `summarizeIntelligenceAnalytics` read those instead of the one-of-N column. A row recorded before the columns existed reports its single column — what that row actually committed to. Pinned as route (d) in `intelligence-attribution.test.ts`. |
| **MEDIUM 4** — `recordIntelligenceOutcome({note})` stored caller text with no credential scan | The 30th write site the "29 call sites" claim missed. `ghp_…` was ACCEPTED where the six sibling methods all refuse. No read publishes the column today, so nothing 500s — a LATENT brick: the table is append-only, so the first read that ever serves it repeats High 4 verbatim and cannot be undone. `disableAiMember({reason})` was the same class. | Both now scan. The running call-site count in the High H3 row above is removed rather than re-measured again (round eleven, Low 4) — it went stale every round — and the property is derived instead: `credential-scan-coverage.test.ts` enumerates every member of `service.ts` that calls `missionText` and fails on any that does not also scan. |
| **MEDIUM 5** — `"One rule closes all three… the union is monotone and unforgeable"` was false | Not monotone for a task linked to ≥2 missions; see High 3. | The High H2 row is corrected in place, with the fourth route and its fix stated there rather than in a footnote. |
| **LOW 5** — `"a signed-in non-Founder gets nothing"` was proved only against an UNMAPPED account | A MAPPED non-Founder (`coo`, approval authority, no intelligence grant) gets `200` on `GET /api/hq/control/intelligence`, and `control-api.ts` discloses `founder_only` memory past the same gate. Writes are correctly refused. Pre-existing and by design — the Founder map is host configuration and `ResolvedFounder` is that declaration — but the property as written was untested. | The suite states the TRUE property and now tests both halves: a mapped non-Founder reads and is refused every write; an unmapped account gets nothing. `intelligence-surfaces.test.ts`. |

### What the sixth round adds to Phase 14's NOT-fixed list

- **A project a task is MOVED UNDER is shown that task's earlier spend.**
  `byProject` and `byMission` fold canonical membership as it stands NOW beside
  the attribution HQ recorded, so re-pointing a mission at another project makes
  the new project's report include spend incurred before the move — and makes
  that project's own ceiling start governing the work, which is the fail-closed
  direction and the reason the union is shaped this way. Both halves re-measured
  at THIS head: a project moved under is credited `observed 5000` once it carries
  a ceiling of its own, and the project that INCURRED the spend still reads
  `blocked, observed 5000` after the move.
  **The other half was attributed to the wrong round, and was false when this
  bullet shipped** (corrected at round seven, Medium 6). It said "what High 3
  closed is the other half: the project that INCURRED the spend can no longer
  lose it", and High 3 did not close it — a seventh-round review executed the
  loss 12 times out of 12 against the head this bullet was written at, by moving
  a mission P1 → P2, spending under P2 until the ceiling blocked, then moving
  P2 → P3: `within_ceiling 0`, the refused decision RECORDED, and `byProject`
  crediting P3, which had spent nothing. What closes it is HIGH NEW-4's third
  term, the derivation from the append-only mission event log, and it is closed
  at this head — the same route now leaves P2 `blocked, observed 5000` with the
  decision still refused.
- **`mission_ids`/`project_ids` are NULL on rows recorded before this round.**
  Such a row reports its single `mission_id`/`project_id`, which is what it
  committed to; a task that was linked to two missions before the upgrade keeps
  the one-of-N attribution for its existing entries. There is no backfill,
  because HQ has no record of what the derivation returned at that instant and
  will not invent one.
- **A mapped non-Founder reads every Founder console route, including
  `founder_only` memory.** That is the host's Founder map doing what it declares,
  not a defect. **It was stated and NOT tested, for two rounds** (corrected at
  round seven, Medium 7): this bullet said "stated and tested", and the only
  mapped-non-Founder test in the package covered the intelligence routes. It is
  tested now, in `test/read-boundary-pinned.test.ts`: a mapped `coo` with no
  approval authority and no originate grants receives the full body of a
  `founder_only` memory record on `/memory`, `/memory/search` and `/search`, and
  an identically-authenticated account the map does NOT name receives none of
  it — which is what makes the map an authority grant rather than an accident.

**Verification at the sixth-round MERGED head** (the whole matrix, all green,
exit 0): `npm run test:hq` 167 files / 3220 tests; `npm test` (root) 37 files /
569 passed + 3 pre-existing skips; hq-host 23 / 222; hq-server 2 / 20; all four
typechecks clean; `npm run build:site` 10 pages + `hq-snapshot.json`;
`npm run build` all workspaces, web initial JS 215.66 kB / 69.22 kB gzip,
unchanged. The two concurrent round-six lanes and what the merge had to decide
are recorded in `PHASE_13_ADVANCED_RELIABILITY.md`; no Phase 14 finding above was
touched by the other lane, whose four commits are entirely Phase 13.

## The SEVENTH correction round, second lane: the ceiling that stopped governing new work, and a floor served two ways

A second read-only hostile reviewer read the same frozen head `d97b8a6` as the
lane recorded in `PHASE_13_ADVANCED_RELIABILITY.md`, without either knowing about
the other, and returned 1 Critical, 3 High, 2 Medium and 1 Low. Two of those are
Phase 14 findings; the rest, the merge record and the full verification table
are on the Phase 13 page.

| Finding | What was reproduced | What changed |
|---|---|---|
| **HIGH NEW-4** — the ceiling fix did not cover NEW work under an already-exhausted ceiling | Round four's `spentUnder` union closes the routes only for a task that has ALREADY recorded spend; a task with none of its own was governed by the mutable `hq_missions.project_id` alone. Executed with the project ceiling exhausted by task A and the attack on task B in the same project, as a principal holding `originateCapabilities: ['hq.mission_command']`, `approvalAuthority: false` and no intelligence grant: `assignMissionToProject({projectId: null})` was accepted, `permittedTiers` widened from `["deterministic_local"]` to all five, and a `critical_review` record was **accepted** — while that same principal calling `setIntelligenceBudget` directly is correctly `refused(not_permitted)`, which is what makes the facade route an authority BYPASS rather than an authority. Raw `UPDATE hq_missions SET project_id = NULL` did the same. Re-verified against the other lane's head `b986cff` after the merge: still open there. | A THIRD term, derived from the APPEND-ONLY mission event log (`#durableTaskProjectScopes`): every project a task's mission(s) have EVER been bound to. `assignMissionToProject` already records both ends of every move, and `commandMission` now records the project a mission is created under, so clearing the link narrows nothing — the act of clearing it is itself the record that the project once governed. `hq_mission_events` is engine-guarded (`no_rewrite`, `no_erase`, `no_replace`) and a declared `ENGINE_IMMUTABLE_TABLES` member, so the union is monotone in the same sense the recorded-attribution half is. **It is not "unforgeable", and the residual below used to be scoped to an old build; both were false and are corrected at round ten (Medium 1)** — a guard is a row in `sqlite_master` and this ledger carries no hash chain, so a CURRENT-build mission that WAS assigned through the facade is stripped by three `DROP TRIGGER`, one count-preserving `UPDATE hq_mission_events SET detail = json_remove(detail,'$.projectId','$.to','$.from')`, three `CREATE TRIGGER` and one `UPDATE hq_missions SET project_id = NULL`. Executed: `governedBy` fell from `[deployment, project:task_project]` to `[deployment]`, `permittedTiers` widened from `["deterministic_local"]` to all five, a `critical_review` decision was ACCEPTED, the row count did not move, and both integrity depths reported `safeMode: false` with no observation. Applied identically to `#governingBudgetScopes` and `#entriesForScope`, so the governing set and the measurement agree by construction. Pinned by `intelligence-project-scope-durability.test.ts`, which also pins the half that already worked (`governedBy: task_project`, `observed 5000`) and the no-false-positive case (a task in no project is governed by the deployment baseline alone). |
| **MEDIUM NEW-6** — `provablyAvoidable` flipped retroactively and two published numbers contradicted each other | `decisionIsProvablyAvoidable` recomputed the floor from the CURRENT canonical risk class while `rowToDecision` served the STORED `floor_tier`. Executed: a Founder registry upsert flipped `provablyAvoidable` 1 → 0 and left the served record reporting `floorTier: deterministic_local` beside `requiredReviewTier: critical_review` — which this page itself says cannot both be true, because the review requirement is one of the terms `computeRoutingProposal` takes the floor's `max` over. Neither the flip nor the contradiction was disclosed. | ONE computation answers both. `deriveDecisionRecord` recomputes the floor and SERVES it; `decisionIsProvablyAvoidable` reads that result rather than recomputing a second time. The stored value is carried as `floorTierAsRecorded`, so no history is lost. The flip is KEPT — raising a capability's risk class really does raise the floor — but no longer silent: `riskClassChangedSinceIssue` on each record, counted on `analytics.provablyAvoidable.riskClassChangedSinceIssue`, and `AVOIDABLE_SPEND_STATEMENT` now says out loud that the floor is recomputed from canonical truth as it stands and that the set can therefore change after a decision was issued. |

### What this lane adds to Phase 14's NOT-fixed list

- **A mission CREATED with a project by a build older than the `commanded`
  event's `projectId` detail, never re-assigned through the facade, whose link
  is then cleared by RAW SQL, leaves no history to derive from.** The FACADE
  route is closed for such a mission regardless of build age, because
  `assignMissionToProject` writes `from` at the moment it clears.
- **The count-preserving IN-PLACE REWRITE reaches this derivation too, on a
  CURRENT-build mission that WAS assigned through the facade** (added at round
  ten, Medium 1 — the entry above was the whole residual until then, and it
  priced the attack above its cheapest path). `hq_mission_events` is append-only
  by three engine triggers and carries no hash chain, and a trigger is a row in
  `sqlite_master`. Executed cost, cheapest path only: three `DROP TRIGGER` on
  `hq_mission_events`, one
  `UPDATE hq_mission_events SET detail = json_remove(detail,'$.projectId','$.to','$.from')`,
  three `CREATE TRIGGER`, then one `UPDATE hq_missions SET project_id = NULL`.
  No `DELETE`, no `INSERT`, no row-count change, zero restarts, zero Founder
  acts. Result: `governedBy` fell from `[deployment, project:task_project]` to
  `[deployment]`, `permittedTiers` widened from `["deterministic_local"]` to all
  five, a `critical_review` decision under an exhausted ceiling was ACCEPTED,
  and `structuralIntegrity` and `fullIntegrity` both reported `safeMode: false`
  with no observation. The SAME one pass also empties the `spentUnder` half —
  `UPDATE hq_intel_cost_entries SET mission_ids='[]', project_ids='[]', mission_id=NULL, project_id=NULL`
  under its four lifted guards takes an exhausted ceiling's `observed` from 5000
  to 0 for a task that HAS recorded spend of its own. **This statement named
  only the two array columns until round twelve (Low 2), and as written it does
  not reproduce**: `recordedScopeIds` reads the array column UNION the single
  legacy column — the fail-closed reading — and `recordIntelligenceCost` writes
  both, so clearing the arrays alone leaves the ceiling charged at 5000. Both
  variants are executed in `intelligence-project-scope-residual.test.ts`: two
  columns leave `observed` at 5000, four take it to 0. Nothing had executed that
  `UPDATE` before it was disclosed. This is not a new capability:
  it is the class `PHASE_13_ADVANCED_RELIABILITY.md`'s residual list already
  carries for every guarded-but-unhashed ledger, it needs raw file access and
  DDL privileges, and both SUPPORTED routes — the `hq.mission_command`-only
  facade call and the raw `UPDATE hq_missions SET project_id = NULL` — remain
  correctly closed. What was wrong was the disclosure, not the code. Executed
  and pinned in `intelligence-project-scope-residual.test.ts`, which asserts the
  supported routes still block, the residual still reaches, and the prose no
  longer carries the absolute.
- **A project a task's mission was once bound to keeps governing that task for
  ever.** That is the fail-closed direction and the point of the derivation, and
  it is the same trade the recorded-attribution union already makes: HQ does not
  un-charge a ceiling because a link was later broken.
- **The floor recomputation does not stop a forged `characteristics` row.** It
  makes the two published numbers agree and reports when canonical truth moved;
  the underlying forgery surface is unchanged and is disclosed on
  `decisionIsProvablyAvoidable` where it always was.

**Verification at the round-seven merged head** (the whole matrix, all green,
exit 0): `npm run test:hq` 178 files / 3288 tests; `npm test` (root) 37 files /
569 passed + 3 pre-existing skips; hq-host 23 / 222; hq-server 2 / 20; all four
typechecks clean; `npm run build:site` 10 pages + `hq-snapshot.json`;
`npm run build` all workspaces, web initial JS 215.66 kB / 69.22 kB gzip,
unchanged.

## The seventh round's THIRD hostile review, and what it changed in Phase 14

Two fresh reviewers read `2891123` and returned **0 Critical / 5 High / 7 Medium
/ 9 Low**. Three of their findings touch this phase. Two of the three were
already CLOSED by the concurrent lane that pushed `ae4bf90` while this one
worked, and that is said plainly rather than claimed as this lane's:

- **`createTask({title, project})` as an unscanned facade write** — their HIGH
  5, closed by the other lane's round-seven Medium 2. Verified here by
  execution rather than by reading the diff: both fields are refused
  `invalid_input`, with the refusal naming the field (`String matches a known
  credential shape (at stored_text.title)`).
- **The intermediate-scope budget route** — their HIGH 4, closed by the other
  lane's HIGH NEW-4. Verified here by executing the exact route they name: move
  a mission P1 → P2, spend 5000 under P2 until the ceiling reads `blocked` and
  the worker decision is refused, then move P2 → P3. At this head P2 still reads
  `blocked, observed 5000`, the retried decision is still refused
  `budget_ceiling_blocks`, and P3 is credited 0 until it carries a ceiling of its
  own. Two sentences on this page that were false BECAUSE of that route are
  corrected above (Medium 6).

What this lane changed here:

| Finding | What was reproduced, on `ae4bf90` | What changed |
|---|---|---|
| **MEDIUM 5** — the fail-closed default in `#entriesForScope` was completely unpinned | Mutating `default: return false` to `return true` — an unrecognized budget scope matching EVERY cost entry — left the whole package suite green at 178 files / 3288 tests. Unreachable today, and undocumented as a fail-closed default. | Both halves pinned in `read-boundary-pinned.test.ts`. The BOUNDARY that makes it unreachable is executed — five unknown scope kinds refused `invalid_input`, every real member of `BUDGET_SCOPES` accepted — and a derived assertion requires a `case` for every member of that vocabulary, so a scope added without one falls to a default that measures NOTHING rather than everything. The source-level half is what kills the mutation, and it is written that way on purpose: an unreachable branch cannot be executed, and saying so is better than leaving the property documented and unenforced. |
| **MEDIUM 7** — a shipped claim of test coverage that did not exist | This page said a mapped non-Founder reading every Founder console route, including `founder_only` memory, "is now stated **and tested**". The read half is real and was reproduced; no test asserted it, and the only mapped-non-Founder test covered the intelligence routes. | Tested now, over the routes that sentence names — see the corrected bullet above. |
| **LOW 5 / LOW 6** — two sentences that the code beside them contradicts | `service.ts` said of a cost entry's stored scope columns "the stored columns stay as recorded attribution and measure nothing", immediately above the round-four paragraph that adds them to the predicate. This page repeated the same round-three claim in the PRESENT tense. | Both corrected in place, with the round that changed each named, because a reader arriving at the three-term union needs to know which round added which term. |

### What this lane adds to Phase 14's NOT-fixed list

- **`#entriesForScope`'s `default` remains unreachable, and its pin is a source
  assertion rather than an execution.** `isBudgetScope` refuses an unknown scope
  at the boundary, so no supported call reaches the branch. The assertion that
  it returns `false` reads the source. That is weaker than an executed test and
  it is stated as such; what it buys is that the mutation which flips it is
  caught, and that a scope added to the vocabulary without a case is caught too.
- **The mapped-non-Founder read is a property of the HOST's Founder map, and
  testing it does not narrow it.** A host that maps an account to a principal
  has granted that account the Founder console. The test asserts the behaviour
  and its boundary; it does not make the map safer.

**Verification at the head this section describes** (the whole matrix, all
green, exit 0, every number measured rather than carried forward):
`npm run test:hq` **181 files / 3310 tests** at the head that section was written, and **182 files / 3319 tests** at the merge with the concurrent lane's rounds eight and nine; `npm test` (root) **37 files / 569
passed + 3 pre-existing skips**; `packages/hq-host` **23 files / 222 tests**;
`apps/hq-server` **2 files / 20 tests**; four typechecks clean
(`headquarter`, `hq-host`, `hq-server`, root build); `npm run build:site`
10 Headquarter pages + `hq-snapshot.json`; `npm run build` all workspaces, web
initial JS **215.66 kB / 69.22 kB gzip** — unchanged. Against `ae4bf90` this lane gained 3 files and 22 tests and lost none, and the
merge with rounds eight and nine gained one more file and nine more tests: no test file was deleted or
renamed, and no test file holds fewer `it(` than it did. The diff against the
accepted base `f1ce71c` touches `packages/server`, `packages/web`,
`packages/shared`, `packages/config-mesob`, `packages/hq-host`, `apps/`,
`package.json` and `package-lock.json` not at all; no `.skip`/`.only`/`.todo`/
`xit`/`xdescribe` was added anywhere, and no `as any`, `@ts-expect-error` or
`eslint-disable` appears in any added line.

## The EIGHTH correction round (this page's part)

One of the round's three findings lands here: **Low 2**, the superseded
residual above that still told the reader a cost entry's `mission_id` and
`project_id` "still hold one value each" and are "never the measurement". Both
clauses stopped being true when round six added `mission_ids` (High 3) and round
seven added `project_ids` (High NEW-4), and the H2 row in the same section
already said so. It is marked in the house style where it stands, with the
narrower residual that does still hold stated in its place. No behaviour
changed on this page's surfaces; the attribution behaviour was already pinned as
route (d) in `intelligence-attribution.test.ts`.

The round's other two findings are recorded on
`PHASE_13_ADVANCED_RELIABILITY.md`, together with the sweep of every shipped
statement in this wave carrying a literal count, an only/always/never/every
claim or a named mechanism. Two of this page's live counts were re-measured in
that sweep and both hold at this head: `assertNoCredentialShape`'s "**46 call
sites at this head**" (measured: 46 across `src/`, excluding the definition) and
`credential-scan-coverage.test.ts`'s "(29 at this head)" facade members that
call `missionText` (measured: 29).

**Verification at the round-eight head** (the whole matrix, all green, exit 0):
`npm run test:hq` 179 files / 3292 tests; `npm test` (root) 37 files / 569
passed + 3 pre-existing skips; hq-host 23 / 222; hq-server 2 / 20; typechecks
clean for `@factoryos/headquarter`, `@factoryos/hq-host` and
`@factoryos/hq-server`; `npm run build:site` 10 pages + `hq-snapshot.json`;
`npm run build` all workspaces, web initial JS 215.66 kB / 69.22 kB gzip,
unchanged.

### The NINTH correction round: Phase 14's half

A fresh read-only hostile review of the round-eight head returned **0 Critical /
1 High / 1 Medium / 1 Low**, all reproduced by execution. Two of the three touch
this page's surfaces.

**HIGH 1 — `\p{Co}` PRIVATE USE carried a credential shape past the credential
scan.** It reaches every write on this phase's surfaces, because
`recordIntelligenceDecision`'s labels and `recordCostEntry`'s notes go through
the same `assertNoCredentialShape`, and it reached the unauthenticated
`hq-snapshot.json` through `assertBrowserSafe`. 137,468 code points, in no
residual list, no comment and no test, while `\p{Cn}` — which takes the
identical argument — had been closed a round earlier. Closed at the code, and
pinned by a sweep of all 137,468 with the count asserted. The "what is still
open" sentence on this page, corrected above, was false because of it.

**LOW 3 — the served `floorTier` and the served `requiredReviewTier` on one
decision record could still contradict each other.** This is the narrower
survivor of round seven's MEDIUM NEW-6, on this page's own surface: the floor
recomputation was fed the CANONICAL review requirement while the record
publishes the MAX of the canonical and the stored column, so a forged
`required_review_tier` above the canonical class produced `floorTier:
deterministic_local` beside `requiredReviewTier: critical_review`. The served
floor is now the max over the review tier the record actually SERVES.
`floorTierAsRecorded` still carries the row's own value, so the forgery stays
visible, and the fail-closed behaviour the reviewer measured
(`satisfiesReviewRequirement: false`, the decision out of `provablyAvoidable`)
is unchanged — as is the legitimate raise/lower path, which round seven pinned
and this round leaves alone.

The round's MEDIUM is recorded on `PHASE_13_ADVANCED_RELIABILITY.md`: a shipped
test comment claimed a full-plane sweep that existed nowhere, which is why
HIGH 1 survived seven rounds. It is now true — 1,112,064 non-surrogate code
points swept against the guard, 155,327 survivors, 0 of them zero-ink, 17 of
them `\p{Zs}`.

**Verification at the round-nine head** (the whole matrix, all green, exit 0):
`npm run test:hq` 179 files / 3297 tests; `npm test` (root) 37 files / 569
passed + 3 pre-existing skips; hq-host 23 / 222; hq-server 2 / 20; typechecks
clean for `@factoryos/headquarter`, `@factoryos/hq-host` and
`@factoryos/hq-server`; `npm run build:site` 10 pages + `hq-snapshot.json`;
`npm run build` all workspaces, web initial JS 215.66 kB / 69.22 kB gzip,
unchanged.
