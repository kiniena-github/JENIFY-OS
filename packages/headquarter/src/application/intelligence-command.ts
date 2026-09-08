/**
 * Phase 14 — Cost + Intelligence Optimization: the MODEL/PROVIDER OBSERVATION
 * REGISTRY, the intelligence TIER policy, the ROUTING PROPOSAL, the ESCALATION
 * rule, the COST LEDGER and the BUDGET policy.
 *
 * The goal is value engineering, never "always cheapest": use the lowest-cost
 * intelligence that still meets the quality and safety requirement, and
 * escalate when stronger intelligence materially improves the outcome. That is
 * one property, and it decomposes into eight laws. Every function below exists
 * to keep one of them.
 *
 * 1. **A proposal is a RECOMMENDATION; the binding is the authority.** A tier
 *    is a policy category, not an executor. Nothing here selects a provider,
 *    nothing here substitutes one, and nothing here can move a task from the
 *    provider its payload binds it to — `operator/provider-binding.ts` remains
 *    the one place that decides who may execute, and a decision row RECORDS
 *    the binding it observed rather than proposing a different one. The
 *    routing surface deliberately carries no provider parameter at all.
 *
 * 2. **HQ never invents a price.** A cost figure exists only with a
 *    categorical provenance beside it — `estimated`, `provider_reported`,
 *    `billed` or `unknown` — and `unknown` means the amount is `null`, never
 *    zero. The two are locked to each other in both directions by
 *    `normalizeCostFact`, so an "unknown" carrying a number and a number
 *    carrying no provenance are equally unrepresentable. An `estimated`
 *    amount additionally has to name its BASIS, because an estimate whose
 *    origin nobody recorded is a fabrication with a label on it.
 *
 * 3. **A budget ceiling can BLOCK or DEMAND A DECISION; it never grants
 *    spend.** `evaluateBudget` returns one of three answers and every one of
 *    them carries `grantsSpend: false` and `authorizesPaidActivation: false`
 *    as literals. The absence of a recorded ceiling is `requires_founder_
 *    decision`, not permission, and an unknown-amount entry anywhere in the
 *    window forces the same answer: HQ cannot prove it is under a ceiling it
 *    cannot measure against.
 *
 * 4. **Nothing here activates paid spending.** No policy path can widen the
 *    permitted tier set on its own. With no budget recorded, the permitted set
 *    is `DEFAULT_PERMITTED_TIERS` — the free local tier alone — so a
 *    deployment that has never had a Founder policy written routes to local
 *    intelligence or asks, and never to a paid one by default.
 *
 * 5. **The local/open path is first-class.** `deterministic_local` is the
 *    bottom of the tier order and the default permitted member; a routing
 *    proposal picks it whenever it clears the requirement, and a `local_only`
 *    privacy requirement makes it the ONLY admissible tier rather than a
 *    preference that a cheaper-looking cloud option can beat.
 *
 * 6. **A cheaper tier cannot bypass a required reviewer tier.** The review
 *    requirement is derived from the canonical risk class, it is a FLOOR on
 *    the tier rank, and `proposalSatisfiesReviewRequirement` is false for
 *    anything under it. The facade refuses to record a decision that does not
 *    satisfy it — the requirement is enforced, not advertised.
 *
 * 7. **An escalation preserves canonical identity and creates no authority.**
 *    `deriveEscalation` carries the task, mission and project of the decision
 *    it escalates verbatim, refuses to change any of them, and returns
 *    `grantsAuthority: false`. It can only move UP the tier order and only
 *    within the permitted set; when no higher permitted tier exists it refuses
 *    rather than inventing one.
 *
 * 8. **Analytics are derived only from what was observed.** Every number is a
 *    count of rows or a sum of amounts that were actually recorded with a
 *    known provenance. Amounts are never converted between currencies, never
 *    imputed, and unknown entries are reported as their own count beside the
 *    sums rather than folded into them. The escalation "rate" is published as
 *    an exact numerator and denominator, because a percentage over a
 *    single-digit denominator reads as a measurement it is not.
 *
 * Nothing in this module opens a socket, reads an environment variable, names
 * a paid service, spends anything or adds a dependency.
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../contracts/freeze.js';
import type { HqDatabase } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import { UNRECOGNIZED_BUCKET } from './reliability-command.js';
import { CapabilityRegistry, RISK_CLASSES, type Capability, type RiskClass } from '../operator/capabilities.js';
import { PROVIDER_HEALTH_STATES, type ProviderHealth } from '../providers/contracts.js';

/* ------------------------------------------------------------------ */
/* Vocabulary — categorical only                                       */
/* ------------------------------------------------------------------ */

/**
 * The intelligence TIERS: conceptual policy categories, ordered by what they
 * cost HQ rather than by any vendor's marketing.
 *
 * Deliberately NOT a brand ranking. No member names a provider, a model or a
 * vendor, and a test scans the vocabulary for every provider id HQ knows and
 * finds none. A tier says what KIND of intelligence a piece of work needs;
 * which provider actually runs it is decided by the canonical binding and by
 * nothing here.
 *
 * `deterministic_local` is first because it is the honest bottom of the order:
 * a local, free, deterministic path that costs nothing and leaves no data.
 * `critical_review` is last because it is the tier reserved for work whose
 * failure is expensive to discover late — not because it is "the best".
 */
export const INTELLIGENCE_TIERS = deepFreeze([
  'deterministic_local',
  'low_cost',
  'standard',
  'high',
  'critical_review',
] as const);
export type IntelligenceTier = (typeof INTELLIGENCE_TIERS)[number];

export function isIntelligenceTier(value: unknown): value is IntelligenceTier {
  return typeof value === 'string' && (INTELLIGENCE_TIERS as readonly string[]).includes(value);
}

/** Position in the tier order. The ONE place "stronger than" is defined. */
export function tierRank(tier: IntelligenceTier): number {
  return INTELLIGENCE_TIERS.indexOf(tier);
}

/**
 * The tier set permitted when NO budget policy has been recorded for a scope.
 *
 * The free local tier, alone. This is law 4 in one constant: a deployment that
 * has never had a Founder policy written routes to local intelligence or asks
 * a human, and never silently to a paid one.
 */
export const DEFAULT_PERMITTED_TIERS: readonly IntelligenceTier[] = deepFreeze(['deterministic_local']);

/**
 * What a stored tier can be once read back. `hq_intel_*` are append-only
 * ledgers on which an APPEND is the write the triggers deliberately permit, so
 * a row carrying a tier outside the closed set is representable even though no
 * facade path produces one. It is carried as `unrecognized` — never coerced
 * into a real tier, which would publish a wrong count to a reader.
 */
export const STORED_TIER_UNRECOGNIZED = 'unrecognized' as const;
export type StoredIntelligenceTier = IntelligenceTier | typeof STORED_TIER_UNRECOGNIZED;

/** How hard the work is. A property of the WORK, never of a model. */
export const TASK_COMPLEXITIES = deepFreeze(['trivial', 'routine', 'substantial', 'novel'] as const);
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

/** How much material the work has to hold at once. */
export const CONTEXT_SIZES = deepFreeze(['small', 'medium', 'large', 'very_large'] as const);
export type ContextSize = (typeof CONTEXT_SIZES)[number];

/** What KIND of work it is. Coding and review are separated deliberately. */
export const WORK_KINDS = deepFreeze([
  'classification',
  'summarization',
  'research',
  'coding',
  'planning',
  'review',
] as const);
export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * How quickly the answer is needed.
 *
 * Recorded and published, and it currently changes NO tier. HQ has observed no
 * latency for any tier, and ranking tiers by a latency nobody measured would
 * be exactly the fabricated measurement this repository forbids. It is carried
 * so a real observation can make it discriminating later, and the statement on
 * every proposal says so.
 */
export const LATENCY_REQUIREMENTS = deepFreeze(['unspecified', 'batch', 'interactive'] as const);
export type LatencyRequirement = (typeof LATENCY_REQUIREMENTS)[number];

/** Where the work's material may go. `local_only` is a hard constraint. */
export const PRIVACY_REQUIREMENTS = deepFreeze(['unrestricted', 'local_only'] as const);
export type PrivacyRequirement = (typeof PRIVACY_REQUIREMENTS)[number];

/**
 * The ONE tier `local_only` admits, named once so the proposal's privacy cap
 * and the recorded-tier refusal cannot drift apart (Wave 5 correction round
 * fifteen, High 3).
 *
 * They already had: `computeRoutingProposal` applied the cap, and
 * `#resolveRecordedTier` — "the one place a recorded tier is checked against
 * the policy" — never read `privacy` at all, so naming a tier explicitly
 * bypassed a constraint this file calls hard. Two spellings of "local only
 * means local" is exactly the drift a shared constant removes.
 */
export const LOCAL_ONLY_TIER: IntelligenceTier = 'deterministic_local';

/**
 * Where HQ's knowledge of a cost figure came from.
 *
 * The four the directive names, and no fifth. `unknown` is a first-class
 * member rather than an error case, and it is the ONLY provenance an entry
 * with no amount may carry.
 */
export const COST_PROVENANCES = deepFreeze(['estimated', 'provider_reported', 'billed', 'unknown'] as const);
export type CostProvenance = (typeof COST_PROVENANCES)[number];

export function isCostProvenance(value: unknown): value is CostProvenance {
  return typeof value === 'string' && (COST_PROVENANCES as readonly string[]).includes(value);
}

/** Whether HQ holds an amount at all. Derived from the amount; never declared. */
export const COST_STATES = deepFreeze(['known', 'unknown'] as const);
export type CostState = (typeof COST_STATES)[number];

/**
 * What an amount was charged FOR. `unknown` is a real member: a billed line
 * item whose unit nobody recorded is still a real amount.
 */
export const COST_UNIT_KINDS = deepFreeze([
  'tokens_prompt',
  'tokens_completion',
  'tokens_total',
  'requests',
  'compute_seconds',
  'subscription_period',
  'unknown',
] as const);
export type CostUnitKind = (typeof COST_UNIT_KINDS)[number];

export function isCostUnitKind(value: unknown): value is CostUnitKind {
  return typeof value === 'string' && (COST_UNIT_KINDS as readonly string[]).includes(value);
}

/**
 * Where a model/provider OBSERVATION came from. The registry holds
 * observations, not a catalogue HQ made up.
 */
export const OBSERVATION_SOURCES = deepFreeze(['founder_declared', 'provider_reported', 'runtime_observed'] as const);
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export function isObservationSource(value: unknown): value is ObservationSource {
  return typeof value === 'string' && (OBSERVATION_SOURCES as readonly string[]).includes(value);
}

/**
 * Availability reuses the provider layer's `ProviderHealth` VERBATIM rather
 * than spelling a near-identical set. Same question, same four answers, same
 * `unknown` default — a second spelling would drift, and a test asserts the
 * two arrays are the same object.
 */
export const MODEL_AVAILABILITY_STATES = deepFreeze(PROVIDER_HEALTH_STATES);
export type ModelAvailability = ProviderHealth;

export function isModelAvailability(value: unknown): value is ModelAvailability {
  return typeof value === 'string' && (MODEL_AVAILABILITY_STATES as readonly string[]).includes(value);
}

/**
 * Capability facts a model observation may carry. Categorical presence only —
 * never a score, never a benchmark number, never a ranking.
 */
export const MODEL_CAPABILITY_FACTS = deepFreeze([
  'tool_use',
  'structured_output',
  'long_context',
  'code_generation',
  'independent_review',
  'offline_capable',
] as const);
export type ModelCapabilityFact = (typeof MODEL_CAPABILITY_FACTS)[number];

export function isModelCapabilityFact(value: unknown): value is ModelCapabilityFact {
  return typeof value === 'string' && (MODEL_CAPABILITY_FACTS as readonly string[]).includes(value);
}

/** Where a model runs relative to this machine. */
export const MODEL_LOCALITIES = deepFreeze(['local', 'cloud'] as const);
export type ModelLocality = (typeof MODEL_LOCALITIES)[number];

export function isModelLocality(value: unknown): value is ModelLocality {
  return typeof value === 'string' && (MODEL_LOCALITIES as readonly string[]).includes(value);
}

/**
 * The state of a recorded routing decision.
 *
 * Disjoint from `ActivityStatus`, `MissionStatus`, `ActionState`,
 * `ProductLifecycleState` AND `RunState` — no member is shared with any of the
 * five, and a test asserts it directly against all five. A decision state
 * named `completed`, `concluded` or `released` would create exactly the
 * ambiguity a reader then has to resolve by guessing.
 */
export const DECISION_STATES = deepFreeze(['issued', 'escalated_away', 'settled'] as const);
export type DecisionState = (typeof DECISION_STATES)[number];

export function isDecisionState(value: unknown): value is DecisionState {
  return typeof value === 'string' && (DECISION_STATES as readonly string[]).includes(value);
}

/**
 * What the work at that tier actually produced, as far as HQ can honestly say.
 * `result_unknown` is a first-class member and the default: a decision nobody
 * reported on has an unknown result, never a successful one.
 */
export const DECISION_RESULTS = deepFreeze(['quality_met', 'quality_not_met', 'result_unknown'] as const);
export type DecisionResult = (typeof DECISION_RESULTS)[number];

export function isDecisionResult(value: unknown): value is DecisionResult {
  return typeof value === 'string' && (DECISION_RESULTS as readonly string[]).includes(value);
}

/** Why a stronger tier was asked for. Categorical, with no number beside it. */
export const ESCALATION_TRIGGERS = deepFreeze([
  'tier_did_not_meet_requirement',
  'insufficient_evidence',
  'review_tier_required',
  'context_exceeded_tier',
  'policy_requires_stronger',
] as const);
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export function isEscalationTrigger(value: unknown): value is EscalationTrigger {
  return typeof value === 'string' && (ESCALATION_TRIGGERS as readonly string[]).includes(value);
}

/** What a budget ceiling is scoped to. */
export const BUDGET_SCOPES = deepFreeze(['mission', 'project', 'provider', 'model', 'deployment'] as const);
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/**
 * What a STORED scope kind or window can be once it has been read back — the
 * same shape, and the same reason, as `STORED_RUN_KIND_UNRECOGNIZED`.
 *
 * `hq_intel_budgets` is append-only, so an APPEND is the write the triggers
 * deliberately permit and a row naming a scope outside the vocabulary is
 * representable. It reads as `unrecognized` rather than being coerced into a
 * real scope, which is what it used to be: a forged `scope_kind` became
 * `deployment` and a forged `window_kind` became `total`, so the row was
 * adopted as the DEPLOYMENT ceiling (Wave 5 review, Medium finding B-4).
 * `latestBudgetFor` matches no real scope against this value, so such a row
 * governs nothing.
 */
export const STORED_BUDGET_UNRECOGNIZED = 'unrecognized' as const;
export type StoredBudgetScope = BudgetScope | typeof STORED_BUDGET_UNRECOGNIZED;
export type StoredBudgetWindow = BudgetWindow | typeof STORED_BUDGET_UNRECOGNIZED;

export function isBudgetScope(value: unknown): value is BudgetScope {
  return typeof value === 'string' && (BUDGET_SCOPES as readonly string[]).includes(value);
}

/** The window a ceiling applies over. */
export const BUDGET_WINDOWS = deepFreeze(['day', 'month', 'total'] as const);
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

export function isBudgetWindow(value: unknown): value is BudgetWindow {
  return typeof value === 'string' && (BUDGET_WINDOWS as readonly string[]).includes(value);
}

/**
 * The three answers a budget can give. There is deliberately no fourth, and
 * emphatically no `approved`: a ceiling is a limit, and a limit that could
 * authorize would be a spending grant wearing a limit's name.
 */
export const BUDGET_DECISIONS = deepFreeze(['within_ceiling', 'requires_founder_decision', 'blocked'] as const);
export type BudgetDecision = (typeof BUDGET_DECISIONS)[number];

export function isBudgetDecision(value: unknown): value is BudgetDecision {
  return typeof value === 'string' && (BUDGET_DECISIONS as readonly string[]).includes(value);
}

/** Why a routing proposal could not name a tier. Categorical; never a guess. */
export const ROUTING_REFUSALS = deepFreeze([
  'no_permitted_tier',
  'privacy_requires_local_but_work_needs_more',
  'budget_ceiling_blocks',
] as const);
export type RoutingRefusal = (typeof ROUTING_REFUSALS)[number];

/* ------------------------------------------------------------------ */
/* Statements carried on every view                                    */
/* ------------------------------------------------------------------ */

export const INTELLIGENCE_ROUTING_STATEMENT =
  'A tier is a POLICY CATEGORY and a proposal is a RECOMMENDATION. It selects no provider and no model, it ' +
  'cannot move work from the provider its canonical payload binds it to, and it grants no authority of any ' +
  'kind. Provider/model truth comes from the canonical binding enforced in OperatorQueue.claim/start; a ' +
  'proposal that disagreed with a binding would simply be ignored by execution.';

export const INTELLIGENCE_LATENCY_STATEMENT =
  'The latency requirement is recorded and published, and it currently discriminates between NO tiers: HQ ' +
  'has observed no latency for any tier, and ranking tiers by a latency nobody measured would be an ' +
  'invented measurement. It becomes discriminating when real latency observations exist, and not before.';

export const COST_LEDGER_STATEMENT =
  'Every amount carries a categorical provenance: estimated, provider_reported, billed or unknown. An ' +
  'unknown cost has a null amount and stays null — it is never rendered as zero, never imputed and never ' +
  'averaged in. Amounts are integer minor units of ONE stated currency and are never converted between ' +
  'currencies, so there is no single grand total and the analytics report per-currency sums instead.';

export const BUDGET_POLICY_STATEMENT =
  'A budget ceiling can BLOCK an act or require a Founder decision. It never grants spend, never activates ' +
  'a paid provider, and never widens what may execute: authority comes from worker permissions, mission ' +
  'permissions, policy and approvals, and a ceiling is none of those. With no ceiling recorded, the answer ' +
  'is requires_founder_decision and the permitted tier set is the free local tier alone.';

export const ESCALATION_STATEMENT =
  'An escalation carries the SAME canonical task, mission and project as the decision it escalates, and ' +
  'creates no authority: it is a recommendation to use a stronger tier, not permission to do anything the ' +
  'original decision could not do. It can only move up the tier order and only inside the permitted set.';

export const INTELLIGENCE_ANALYTICS_STATEMENT =
  'Every figure here is a count of recorded rows or a sum of amounts that were actually recorded with a ' +
  'known provenance. Nothing is projected, extrapolated, converted between currencies or filled in. ' +
  'Unknown-amount entries are reported as their own count beside the sums, never folded into them, and the ' +
  'escalation rate is published as an exact numerator and denominator rather than as a percentage.';

export const AVOIDABLE_SPEND_STATEMENT =
  'A decision is counted as provably avoidable only when ALL of these hold from recorded data: it was ' +
  'issued at a tier strictly above the floor the policy itself computed for its own recorded task ' +
  'characteristics, it was not an escalation, no reviewer tier was required of it, and its recorded result ' +
  'is quality_met. It is a statement about HQ’s own policy, not a claim about what a cheaper model ' +
  'would have produced — HQ never ran one, so it cannot know that. The floor it is measured against is ' +
  'RECOMPUTED from canonical truth as it stands now, not read back from the column the row stored, so this ' +
  'set can change after a decision was issued: raising a capability’s risk class raises the floor and takes ' +
  'decisions out of it. The floor served on each record is that same recomputation — the stored one is ' +
  'carried beside it as floorTierAsRecorded — and riskClassChangedSinceIssue counts the records whose ' +
  'canonical risk class has moved since they were written.';

/* ------------------------------------------------------------------ */
/* Capability (the CONFIGURATION vs INVOCATION trio)                   */
/* ------------------------------------------------------------------ */

/**
 * The capability behind the two FOUNDER acts of this phase: recording a
 * model/provider observation, and setting a budget policy.
 *
 * NOT registered automatically. `sideEffect: false` is honest — both append a
 * row and reach nothing outside HQ. `riskClass: 'founder_gate'` because
 * declaring what a model costs, and declaring what may be spent against it,
 * are Founder statements.
 *
 * Recording a cost entry and recording a routing decision deliberately do NOT
 * sit behind this capability: they sit behind the live fenced claim on the
 * canonical task, exactly like a Phase 13 run event, because the worker
 * carrying the work is the one entity that can honestly say what it used.
 */
export const INTELLIGENCE_COMMAND_CAPABILITY = deepFreeze({
  id: 'hq.intelligence_command',
  description:
    'Founder intelligence command — records observed model/provider capability and cost metadata, and ' +
    'sets budget ceilings and permitted intelligence tiers. Appends only; activates no provider, enables ' +
    'no paid service, authorizes no spend and executes nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const);

/** Register the intelligence-command capability — a CONFIGURATION action. */
export function registerIntelligenceCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...INTELLIGENCE_COMMAND_CAPABILITY });
}

export const INTELLIGENCE_COMMAND_RESERVED_CONTRACT = deepFreeze({
  riskClass: INTELLIGENCE_COMMAND_CAPABILITY.riskClass,
  sideEffect: INTELLIGENCE_COMMAND_CAPABILITY.sideEffect,
  idempotent: INTELLIGENCE_COMMAND_CAPABILITY.idempotent,
} as const);

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function intelligenceCommandContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== INTELLIGENCE_COMMAND_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== INTELLIGENCE_COMMAND_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== INTELLIGENCE_COMMAND_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type IntelligenceCommandCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/** Classify the registry's current row from an ENFORCEMENT-SAFE read; never repairs. */
export function intelligenceCommandCapabilityState(
  capability: Capability | null,
): IntelligenceCommandCapabilityState {
  if (!capability) return 'missing';
  if (intelligenceCommandContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

export const MAX_PROVIDER_ID_LENGTH = 64;
export const MAX_MODEL_ID_LENGTH = 120;
export const MAX_INTEL_NOTE_LENGTH = 500;
export const MAX_COST_BASIS_LENGTH = 200;
export const MAX_DECISION_LABEL_LENGTH = 120;
/**
 * A decision id, as HQ will accept one from a caller (Wave 5 Low 8).
 *
 * HQ mints `inteldec-<uuid>`, which is 45 characters of slug. The bound exists
 * because the value used to be unbounded and unscanned and was interpolated
 * verbatim into `Unknown routing decision: ${decisionId}` — the same gap that
 * justified removing the caller-supplied `missionId` / `projectId` in the
 * previous round, left standing on the one id a caller still passes.
 */
export const MAX_DECISION_ID_LENGTH = 120;
/** Largest amount HQ will record, in minor units. A bound, never a ceiling. */
export const MAX_COST_MINOR_UNITS = 1_000_000_000_000;
/** Bounded reads: the true total is always stated beside a bounded list. */
export const OBSERVATION_READ_LIMIT = 100;
export const DECISION_READ_LIMIT = 50;
export const COST_READ_LIMIT = 100;
export const BUDGET_READ_LIMIT = 50;

/**
 * A provider or model id, as HQ will accept it.
 *
 * A strict slug, deliberately: these strings are joined into derived keys and
 * echoed on a Founder-gated read, and a bounded closed shape is what makes a
 * later reader's job provable. It is still never used as a key in the
 * unauthenticated snapshot — see `summarizeIntelligence`.
 */
const SLUG = /^[a-z0-9][a-z0-9._:-]*$/;

export function isIdentifierSlug(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && SLUG.test(value);
}

/**
 * The ONE spelling of a provider identity inside this lane.
 *
 * HQ has two vocabularies for the same thing and always has: canonical routing
 * says `CLAUDE` (`routing/providers.ts`, and the value `readProviderBinding`
 * returns from a task payload), while every id this module stores or echoes is
 * a lowercase slug, because these strings are joined into derived keys and go
 * out on a Founder-gated read. The two are the same identity in different case,
 * and this function is where they meet.
 *
 * Until the Wave 5 correction round three they never met, and the `provider`
 * budget scope was DEAD as a result (High B2). `recordIntelligenceCost` demanded
 * a lowercase slug and then demanded equality with `#taskBoundProvider`, which
 * is uppercase — so `CLAUDE` was `invalid_input`, `claude` was
 * `provider_binding_mismatch`, and `Claude` was `invalid_input` again. Every
 * ceiling a Founder set on a provider therefore stayed at `observed: 0` forever
 * over work that was genuinely bound to it, and the escape hatch was closed too:
 * a task bound to lowercase `claude` is unclaimable, because
 * `declareWorkerProvider` is limited to the canonical uppercase set. Meanwhile
 * the module comment and the phase document both claimed "the two vocabularies
 * are one by enforcement and a Founder's provider ceiling binds".
 *
 * A case fold is not a SUBSTITUTION: `CLAUDE` and `claude` name the same
 * provider, the canonical set is uppercase-distinct so the fold is injective
 * over it, and the DECISION record still stores the canonical uppercase binding
 * verbatim. What is folded is the id used as a budget scope key and as a cost
 * entry's provider column — the intelligence lane's own vocabulary.
 */
export function normalizeProviderId(value: string): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * A budget scope id in the vocabulary its KIND is expressed in.
 *
 * Only `provider` is folded, and only because that is the one scope whose ids
 * come from the canonical uppercase routing vocabulary. Mission, project and
 * model ids are already single-vocabulary (uuids and lowercase slugs), and
 * case-folding a mission id would silently merge two Founder scopes that are
 * genuinely different.
 */
export function canonicalBudgetScopeId(scopeKind: BudgetScope, scopeId: string): string {
  return scopeKind === 'provider' ? normalizeProviderId(scopeId) : (scopeId ?? '').trim();
}

/** ISO-4217-shaped currency code. Never converted; only compared. */
const CURRENCY = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY.test(value);
}

/* ------------------------------------------------------------------ */
/* Schema — five tables, all INSERT-only BY ENGINE                     */
/* ------------------------------------------------------------------ */

/**
 * The full Phase 7/8/12/13 trigger set on all five tables: no UPDATE of any
 * column, no DELETE, a BEFORE INSERT guard on `id`/`seq` that closes REPLACE
 * and UPSERT, and a second BEFORE INSERT guard on every SECONDARY unique
 * index.
 *
 * The second guard matters here for the same reason it mattered in Phase 13: a
 * REPLACE colliding on a unique key would DELETE the standing row without any
 * BEFORE DELETE firing (`recursive_triggers` is off by default and
 * connection-scoped). On `hq_intel_budgets.budget_key` that would silently
 * replace a Founder's ceiling with a looser one; on
 * `hq_intel_cost_entries.entry_key` it would erase a recorded amount and let
 * the same one be re-recorded, which is how a spend total quietly shrinks.
 */
const INTELLIGENCE_DDL = `
CREATE TABLE IF NOT EXISTS hq_intel_model_observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  locality TEXT NOT NULL,
  availability TEXT NOT NULL,
  capability_facts TEXT NOT NULL,
  context_window_tokens INTEGER,
  unit_cost_provenance TEXT NOT NULL,
  unit_cost_minor_units INTEGER,
  unit_cost_currency TEXT,
  unit_cost_unit_kind TEXT NOT NULL,
  unit_cost_basis TEXT,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_by TEXT NOT NULL,
  note TEXT,
  observation_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_intel_obs_provider ON hq_intel_model_observations(provider_id, seq);

CREATE TABLE IF NOT EXISTS hq_intel_budgets (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  ceiling_minor_units INTEGER NOT NULL,
  currency TEXT NOT NULL,
  permitted_tiers TEXT NOT NULL,
  version INTEGER NOT NULL,
  set_at TEXT NOT NULL,
  set_by TEXT NOT NULL,
  note TEXT,
  budget_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_intel_budgets_scope
  ON hq_intel_budgets(scope_kind, scope_id, window_kind, version);

CREATE TABLE IF NOT EXISTS hq_intel_decisions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  mission_id TEXT,
  project_id TEXT,
  tier TEXT NOT NULL,
  floor_tier TEXT NOT NULL,
  required_review_tier TEXT,
  escalated_from TEXT,
  escalation_trigger TEXT,
  bound_provider TEXT,
  characteristics TEXT NOT NULL,
  permitted_tiers TEXT NOT NULL,
  budget_decision TEXT NOT NULL,
  label TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  process_id TEXT NOT NULL,
  decision_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_intel_decisions_task ON hq_intel_decisions(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_hq_intel_decisions_from ON hq_intel_decisions(escalated_from, seq);

CREATE TABLE IF NOT EXISTS hq_intel_decision_outcomes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  decision_id TEXT NOT NULL,
  result TEXT NOT NULL,
  reviewed_by_tier TEXT,
  note TEXT,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  outcome_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_intel_outcomes_decision ON hq_intel_decision_outcomes(decision_id, seq);

CREATE TABLE IF NOT EXISTS hq_intel_cost_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  mission_id TEXT,
  project_id TEXT,
  decision_id TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  provenance TEXT NOT NULL,
  amount_minor_units INTEGER,
  currency TEXT,
  unit_kind TEXT NOT NULL,
  units_observed INTEGER,
  basis TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  note TEXT,
  entry_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_intel_costs_task ON hq_intel_cost_entries(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_hq_intel_costs_provider ON hq_intel_cost_entries(provider_id, seq);

CREATE TRIGGER IF NOT EXISTS trg_hq_intel_obs_no_rewrite
BEFORE UPDATE ON hq_intel_model_observations
BEGIN SELECT RAISE(ABORT, 'hq_intel_model_observations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_obs_no_erase
BEFORE DELETE ON hq_intel_model_observations
BEGIN SELECT RAISE(ABORT, 'hq_intel_model_observations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_obs_no_replace
BEFORE INSERT ON hq_intel_model_observations
WHEN EXISTS (SELECT 1 FROM hq_intel_model_observations WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_intel_model_observations WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_intel_model_observations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_obs_no_replace_unique
BEFORE INSERT ON hq_intel_model_observations
WHEN EXISTS (SELECT 1 FROM hq_intel_model_observations WHERE observation_key = NEW.observation_key)
BEGIN SELECT RAISE(ABORT, 'hq_intel_model_observations is append-only (unique observation_key already held)'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_intel_budgets_no_rewrite
BEFORE UPDATE ON hq_intel_budgets
BEGIN SELECT RAISE(ABORT, 'hq_intel_budgets is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_budgets_no_erase
BEFORE DELETE ON hq_intel_budgets
BEGIN SELECT RAISE(ABORT, 'hq_intel_budgets is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_budgets_no_replace
BEFORE INSERT ON hq_intel_budgets
WHEN EXISTS (SELECT 1 FROM hq_intel_budgets WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_intel_budgets WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_intel_budgets is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_budgets_no_replace_unique
BEFORE INSERT ON hq_intel_budgets
WHEN EXISTS (SELECT 1 FROM hq_intel_budgets WHERE budget_key = NEW.budget_key)
BEGIN SELECT RAISE(ABORT, 'hq_intel_budgets is append-only (unique budget_key already held)'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_intel_decisions_no_rewrite
BEFORE UPDATE ON hq_intel_decisions
BEGIN SELECT RAISE(ABORT, 'hq_intel_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_decisions_no_erase
BEFORE DELETE ON hq_intel_decisions
BEGIN SELECT RAISE(ABORT, 'hq_intel_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_decisions_no_replace
BEFORE INSERT ON hq_intel_decisions
WHEN EXISTS (SELECT 1 FROM hq_intel_decisions WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_intel_decisions WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_intel_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_decisions_no_replace_unique
BEFORE INSERT ON hq_intel_decisions
WHEN EXISTS (SELECT 1 FROM hq_intel_decisions WHERE decision_key = NEW.decision_key)
BEGIN SELECT RAISE(ABORT, 'hq_intel_decisions is append-only (unique decision_key already held)'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_intel_outcomes_no_rewrite
BEFORE UPDATE ON hq_intel_decision_outcomes
BEGIN SELECT RAISE(ABORT, 'hq_intel_decision_outcomes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_outcomes_no_erase
BEFORE DELETE ON hq_intel_decision_outcomes
BEGIN SELECT RAISE(ABORT, 'hq_intel_decision_outcomes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_outcomes_no_replace
BEFORE INSERT ON hq_intel_decision_outcomes
WHEN EXISTS (SELECT 1 FROM hq_intel_decision_outcomes WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_intel_decision_outcomes WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_intel_decision_outcomes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_outcomes_no_replace_unique
BEFORE INSERT ON hq_intel_decision_outcomes
WHEN EXISTS (SELECT 1 FROM hq_intel_decision_outcomes WHERE outcome_key = NEW.outcome_key)
BEGIN SELECT RAISE(ABORT, 'hq_intel_decision_outcomes is append-only (unique outcome_key already held)'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_intel_costs_no_rewrite
BEFORE UPDATE ON hq_intel_cost_entries
BEGIN SELECT RAISE(ABORT, 'hq_intel_cost_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_costs_no_erase
BEFORE DELETE ON hq_intel_cost_entries
BEGIN SELECT RAISE(ABORT, 'hq_intel_cost_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_costs_no_replace
BEFORE INSERT ON hq_intel_cost_entries
WHEN EXISTS (SELECT 1 FROM hq_intel_cost_entries WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_intel_cost_entries WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_intel_cost_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_intel_costs_no_replace_unique
BEFORE INSERT ON hq_intel_cost_entries
WHEN EXISTS (SELECT 1 FROM hq_intel_cost_entries WHERE entry_key = NEW.entry_key)
BEGIN SELECT RAISE(ABORT, 'hq_intel_cost_entries is append-only (unique entry_key already held)'); END;
`;

/**
 * Idempotent; safe on every construction of the service.
 *
 * Never attempts DDL on a READ-ONLY handle, for the Phase 13 reason: the
 * snapshot path legitimately builds the service over `openHqDatabaseReadOnly`,
 * and a pre-Phase-14 file must be OBSERVED truthfully rather than migrated by
 * a path that promised to write nothing.
 */
export function ensureIntelligenceSchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(INTELLIGENCE_DDL);
  ensureCostEntryBindingColumn(db);
  ensureCostEntryScopeColumns(db);
}

/**
 * Was the entry's task CANONICALLY BOUND to the provider it names, at the
 * moment HQ recorded it?
 *
 * Added by ALTER because `CREATE TABLE IF NOT EXISTS` does not extend an
 * existing table; idempotent, exactly like `ensureColumns` in `store/db.ts`.
 *
 * It exists so a provider ceiling stops depending on a MUTABLE table for work
 * that already happened (Wave 5 correction round four, High H2 route (c), and
 * Medium M6). `provider_id` on this row is caller-declared and is only
 * enforced equal to the binding when a binding EXISTS
 * (`provider_binding_mismatch`); the measurement therefore had to re-read
 * `op_tasks.payload` for every entry, and that column is neither append-only
 * nor censused — one raw `UPDATE op_tasks SET payload = ...` moved recorded
 * spend out of the ceiling that governed it. HQ writes this flag itself, from
 * the binding it read at record time, and the row is append-only, so what was
 * true then stays true.
 *
 * A NULL means "an entry recorded before this column existed", and is read as
 * NOT bound — the fail-closed direction: such an entry measures no provider
 * ceiling and is reported as unattributed rather than credited to a provider
 * HQ cannot vouch for.
 */
function ensureCostEntryBindingColumn(db: HqDatabase): void {
  const columns = db.prepare(`PRAGMA table_info(hq_intel_cost_entries)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === 'provider_bound')) {
    db.exec(`ALTER TABLE hq_intel_cost_entries ADD COLUMN provider_bound INTEGER`);
  }
}

/**
 * EVERY mission and project HQ derived for the entry's task at record time,
 * not just the one that happened to sort first.
 *
 * Added by ALTER for the same reason `provider_bound` was, and to close the
 * fourth route of the same nullification (Wave 5 correction round six, High 3).
 * `mission_id` and `project_id` store `canonicalScopes.missionIds[0] ?? null`,
 * so every reader that unions canonical membership with the stored column had a
 * union that was complete only for the first-sorting scope. A task linked to two
 * missions could have the OTHER mission's project ceiling nullified by moving
 * that mission to a different project — `assignMissionToProject`, a supported
 * facade call reachable with `hq.mission_command` alone, no approval authority
 * and no intelligence grant. The victim project went from `blocked, observed
 * 5000` to `within_ceiling, observed 0`, the refused decision was recorded, and
 * the published report then credited the 5000 to the escape project, which had
 * spent nothing.
 *
 * NULL means "recorded before these columns existed". Such a row reports its
 * single column, which is exactly what it committed to — the same fail-honest
 * reading `provider_bound` takes, and not a claim that the row was filed under
 * nothing.
 */
function ensureCostEntryScopeColumns(db: HqDatabase): void {
  const columns = db.prepare(`PRAGMA table_info(hq_intel_cost_entries)`).all() as { name: string }[];
  const present = new Set(columns.map((column) => column.name));
  if (!present.has('mission_ids')) {
    db.exec(`ALTER TABLE hq_intel_cost_entries ADD COLUMN mission_ids TEXT`);
  }
  if (!present.has('project_ids')) {
    db.exec(`ALTER TABLE hq_intel_cost_entries ADD COLUMN project_ids TEXT`);
  }
}

/** True when this file carries the Phase 14 ledgers — observation, never migration. */
export function intelligenceSchemaPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_intel_decisions'`)
      .get() !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/**
 * Derived dedupe keys. The caller's `idempotencyKey` is an INPUT to the digest
 * and never the key itself — the mission/project/memory/truth/product/run rule
 * — so an identical re-record dedupes and a deliberately fresh one is
 * possible.
 */
export function observationIdempotencyKey(input: {
  providerId: string;
  modelId: string | null;
  observedAt: string;
  source: ObservationSource;
  idempotencyKey: string | null;
}): string {
  return `intelobs:${createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 32)}`;
}

/**
 * A budget row's key. The VERSION is part of it, so a new version is a new row
 * rather than a collision — the append-only versioning the repository uses for
 * every settings-shaped record.
 */
export function budgetKey(input: {
  scopeKind: BudgetScope;
  scopeId: string;
  window: BudgetWindow;
  version: number;
}): string {
  return `intelbudget:${createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 32)}`;
}

export function decisionIdempotencyKey(input: {
  taskId: string;
  tier: IntelligenceTier;
  escalatedFrom: string | null;
  label: string;
  idempotencyKey: string | null;
}): string {
  return `inteldec:${createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 32)}`;
}

/** One outcome per decision, by construction: the key is the decision id. */
export function decisionOutcomeKey(decisionId: string): string {
  return `intelout:${decisionId}`;
}

/**
 * A cost entry's identity.
 *
 * `occurredAt` is `string | null` and the null is load-bearing (Wave 5
 * correction round five, Low 3): only an instant the CALLER declared belongs in
 * an identity. The facade used to pass a defaulted `nowIso()` here, which made
 * every replay of an otherwise identical entry a distinct row and left
 * `cost_entry_conflict` unreachable on the default path. A caller that declares
 * no instant must declare an `idempotencyKey` instead — the facade refuses an
 * entry that declares neither, because HQ cannot then tell a replay from a
 * second real spend and will not invent an answer either way.
 */
export function costEntryKey(input: {
  taskId: string;
  providerId: string;
  modelId: string | null;
  occurredAt: string | null;
  unitKind: CostUnitKind;
  idempotencyKey: string | null;
}): string {
  return `intelcost:${createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 32)}`;
}

/* ------------------------------------------------------------------ */
/* Cost facts — law 2, in one function                                 */
/* ------------------------------------------------------------------ */

/** A cost figure and everything HQ knows about where it came from. */
export interface CostFact {
  provenance: CostProvenance;
  /** Integer minor units, or null. Null is the ONLY reading of an unknown cost. */
  amountMinorUnits: number | null;
  currency: string | null;
  unitKind: CostUnitKind;
  /** Where an ESTIMATE came from. Required for `estimated`; null otherwise. */
  basis: string | null;
  /** DERIVED from the amount, never declared by a caller. */
  state: CostState;
}

export type CostFactRefusal =
  | 'unknown_provenance_carries_amount'
  | 'known_provenance_without_amount'
  | 'amount_not_a_whole_number'
  | 'amount_negative'
  | 'amount_out_of_bounds'
  | 'currency_missing'
  | 'currency_malformed'
  | 'unrecognized_provenance'
  | 'unrecognized_unit_kind'
  | 'estimate_without_basis'
  | 'basis_on_non_estimate'
  /**
   * The basis exceeds `MAX_COST_BASIS_LENGTH` (Wave 5 Medium 7).
   *
   * The bound used to be applied only on the NON-estimate branch, under the
   * misnamed `basis_on_non_estimate` — so `estimated`, the one provenance that
   * REQUIRES a basis, had no length check at all, and roughly a megabyte of
   * caller text could land permanently in an append-only, un-erasable table
   * and be echoed on every read of the intelligence control surface.
   */
  | 'basis_too_long';

/**
 * The one place a cost figure becomes a fact — law 2 in a single function.
 *
 * The provenance and the amount are locked to each other in BOTH directions:
 * `unknown` may not carry an amount, and the other three may not omit one. So
 * "cost unknown, but here is a number" and "here is a number, provenance
 * unstated" are equally unrepresentable, and a reader never has to work out
 * which of the two a null meant.
 *
 * An `estimated` amount must NAME ITS BASIS. An estimate whose origin nobody
 * recorded is a fabrication with a label on it, and this is the phase that
 * exists to refuse those.
 */
export function normalizeCostFact(input: {
  provenance: unknown;
  amountMinorUnits: unknown;
  currency: unknown;
  unitKind: unknown;
  basis?: unknown;
}): { ok: true; fact: CostFact } | { ok: false; refusal: CostFactRefusal } {
  if (!isCostProvenance(input.provenance)) return { ok: false, refusal: 'unrecognized_provenance' };
  if (!isCostUnitKind(input.unitKind)) return { ok: false, refusal: 'unrecognized_unit_kind' };
  const provenance = input.provenance;
  const unitKind = input.unitKind;
  const basisRaw = typeof input.basis === 'string' ? input.basis.trim() : '';
  // The length bound applies to EVERY branch, before the provenance switch
  // (Wave 5 Medium 7). It used to be applied only to non-estimates — the one
  // branch that cannot carry a basis at all — so `estimated`, which REQUIRES
  // one, was unbounded.
  if (basisRaw.length > MAX_COST_BASIS_LENGTH) return { ok: false, refusal: 'basis_too_long' };
  const hasAmount = input.amountMinorUnits != null;

  if (provenance === 'unknown') {
    if (hasAmount) return { ok: false, refusal: 'unknown_provenance_carries_amount' };
    if (basisRaw !== '') return { ok: false, refusal: 'basis_on_non_estimate' };
    return {
      ok: true,
      fact: {
        provenance,
        amountMinorUnits: null,
        currency: null,
        unitKind,
        basis: null,
        state: 'unknown',
      },
    };
  }

  if (!hasAmount) return { ok: false, refusal: 'known_provenance_without_amount' };
  const amount = input.amountMinorUnits;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    return { ok: false, refusal: 'amount_not_a_whole_number' };
  }
  if (amount < 0) return { ok: false, refusal: 'amount_negative' };
  if (amount > MAX_COST_MINOR_UNITS) return { ok: false, refusal: 'amount_out_of_bounds' };
  if (typeof input.currency !== 'string' || input.currency.trim() === '') {
    return { ok: false, refusal: 'currency_missing' };
  }
  const currency = input.currency.trim();
  if (!isCurrencyCode(currency)) return { ok: false, refusal: 'currency_malformed' };
  if (provenance === 'estimated' && basisRaw === '') {
    return { ok: false, refusal: 'estimate_without_basis' };
  }
  // A non-estimate may not name a basis at all: `observed`, `provider_reported`
  // and `billed` amounts are facts, and a "basis" beside one is a story about a
  // number that did not need one. (This used to accept any basis of ≤200
  // characters here, which is why the refusal was both misnamed and unreachable
  // in practice — no test exercised it.)
  if (provenance !== 'estimated' && basisRaw !== '') {
    return { ok: false, refusal: 'basis_on_non_estimate' };
  }
  return {
    ok: true,
    fact: {
      provenance,
      amountMinorUnits: amount,
      currency,
      unitKind,
      basis: basisRaw === '' ? null : basisRaw,
      state: 'known',
    },
  };
}

/**
 * Read a STORED cost figure back. Fail closed in the same direction as the
 * writer: a row whose provenance is outside the vocabulary, or whose amount
 * and provenance disagree, reads as `unknown` with a null amount. It never
 * reads as a number HQ cannot vouch for, and it never reads as zero.
 *
 * "The same direction as the writer" was a claim before it was true (Wave 5
 * Medium 6), and the first correction was itself incomplete (Wave 5 Low 7): it
 * said there were two such refusals when there were FOUR. All four now have a
 * counterpart here, and each one was a row that read back as a KNOWN amount
 * and was folded into `observedMinorUnits` — which is how a scope that should
 * read `requires_founder_decision` reads `within_ceiling` instead:
 *
 *  - an `estimated` amount with NO BASIS. On write that is
 *    `estimate_without_basis`, because an estimate whose origin nobody
 *    recorded is a fabricated price with a label on it. Read back, it was a
 *    number HQ vouched for on exactly the evidence it refuses to accept.
 *  - an amount beyond `MAX_COST_MINOR_UNITS`. On write that is
 *    `amount_out_of_bounds`; read back, it was a spend total.
 *  - a NON-ESTIMATE carrying a basis. On write that is
 *    `basis_on_non_estimate`: `observed`, `provider_reported` and `billed`
 *    amounts are facts, and a "basis" beside one is a story about a number
 *    that did not need one. Executed: a raw-appended `billed` row WITH a basis
 *    read back `state: 'known'` and carried the basis with it.
 *  - a basis longer than `MAX_COST_BASIS_LENGTH`. On write that is
 *    `basis_too_long`; executed: an `estimated` row with a 500,000-character
 *    basis read back `known`, unbounded, on a Founder-gated read.
 *
 * All four now return the unknown fact. `hq_intel_cost_entries` is append-only
 * and an APPEND is the write its triggers deliberately permit, so a row of any
 * of these shapes is representable in the file even though no facade path
 * writes one.
 */
export function readStoredCostFact(row: {
  provenance: unknown;
  amountMinorUnits: unknown;
  currency: unknown;
  unitKind: unknown;
  basis: unknown;
}): CostFact {
  const unitKind = isCostUnitKind(row.unitKind) ? row.unitKind : 'unknown';
  const unknownFact: CostFact = {
    provenance: 'unknown',
    amountMinorUnits: null,
    currency: null,
    unitKind,
    basis: null,
    state: 'unknown',
  };
  if (!isCostProvenance(row.provenance) || row.provenance === 'unknown') return unknownFact;
  const amount = row.amountMinorUnits;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) return unknownFact;
  // The writer's bound, applied on the way back in too.
  if (amount > MAX_COST_MINOR_UNITS) return unknownFact;
  if (typeof row.currency !== 'string' || !isCurrencyCode(row.currency)) return unknownFact;
  const basis = typeof row.basis === 'string' && row.basis.trim() !== '' ? row.basis : null;
  // An estimate must NAME ITS BASIS, on the way back as well as on the way in.
  if (row.provenance === 'estimated' && basis === null) return unknownFact;
  // And a NON-estimate must not name one: a basis beside an `observed`,
  // `provider_reported` or `billed` amount is the writer's
  // `basis_on_non_estimate` refusal, so reading such a row as a known fact
  // vouched for a shape HQ will not accept.
  if (row.provenance !== 'estimated' && basis !== null) return unknownFact;
  // The writer's length bound, applied on the way back too. Without it a
  // raw-appended row could put an unbounded string on a Founder-gated read.
  if (basis !== null && basis.length > MAX_COST_BASIS_LENGTH) return unknownFact;
  return {
    provenance: row.provenance,
    amountMinorUnits: amount,
    currency: row.currency,
    unitKind,
    basis,
    state: 'known',
  };
}

/* ------------------------------------------------------------------ */
/* The routing policy — pure, deterministic, and stated                */
/* ------------------------------------------------------------------ */

/** What HQ knows about the WORK. Every field is a closed vocabulary member. */
export interface TaskCharacteristics {
  complexity: TaskComplexity;
  contextSize: ContextSize;
  workKind: WorkKind;
  /** The canonical `op_capabilities.risk_class` of the task's capability. */
  riskClass: RiskClass;
  latency: LatencyRequirement;
  privacy: PrivacyRequirement;
}

export function isTaskCharacteristics(value: unknown): value is TaskCharacteristics {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (TASK_COMPLEXITIES as readonly unknown[]).includes(v.complexity) &&
    (CONTEXT_SIZES as readonly unknown[]).includes(v.contextSize) &&
    (WORK_KINDS as readonly unknown[]).includes(v.workKind) &&
    (RISK_CLASSES as readonly unknown[]).includes(v.riskClass) &&
    (LATENCY_REQUIREMENTS as readonly unknown[]).includes(v.latency) &&
    (PRIVACY_REQUIREMENTS as readonly unknown[]).includes(v.privacy)
  );
}

/**
 * The FLOOR each characteristic imposes — the cheapest tier that still clears
 * it. The whole policy is `max` over these four tables plus the review floor,
 * which is what makes "lowest cost that still meets the requirement" a
 * computation rather than a slogan.
 *
 * Every mapping below is a POLICY choice, written once, and changeable by
 * editing one line. None of them names a provider or a model.
 */
export const COMPLEXITY_FLOOR: Readonly<Record<TaskComplexity, IntelligenceTier>> = deepFreeze({
  trivial: 'deterministic_local',
  routine: 'low_cost',
  substantial: 'standard',
  novel: 'high',
});

export const CONTEXT_FLOOR: Readonly<Record<ContextSize, IntelligenceTier>> = deepFreeze({
  small: 'deterministic_local',
  medium: 'low_cost',
  large: 'standard',
  very_large: 'high',
});

export const WORK_KIND_FLOOR: Readonly<Record<WorkKind, IntelligenceTier>> = deepFreeze({
  classification: 'deterministic_local',
  summarization: 'deterministic_local',
  research: 'low_cost',
  coding: 'low_cost',
  planning: 'low_cost',
  review: 'standard',
});

export const RISK_FLOOR: Readonly<Record<RiskClass, IntelligenceTier>> = deepFreeze({
  read_only: 'deterministic_local',
  reversible: 'low_cost',
  external_side_effect: 'high',
  destructive: 'critical_review',
  founder_gate: 'critical_review',
});

/**
 * The RISK CLASS a routing decision is computed against.
 *
 * Canonical when the task's `op_capabilities` row can be read; the STRICTEST
 * class — `founder_gate`, which forces the highest floor AND a
 * `critical_review` requirement — when it cannot. An unreadable capability
 * must never be the cheap path.
 *
 * Extracted from `HeadquarterOperations.#characteristicsFor` by the Wave 5
 * review (LOW finding 5). The default was live and correct, and it was
 * UNPINNED: the reviewer flipped it to `'read_only'` and all 3026 tests passed,
 * because a foreign key on `op_tasks.capability_id` makes an unreadable row
 * unreachable through the ordinary path. A defensive default whose whole job is
 * to hold on the day the FK does not — a raw writer, a handle with
 * `foreign_keys` off, a future schema change — is worth keeping and is worth
 * one assertion. It is a total function over one nullable input, so the
 * assertion is a unit test rather than a contrived integration.
 */
export function riskClassForRouting(capability: { riskClass: RiskClass } | null | undefined): RiskClass {
  return capability ? capability.riskClass : 'founder_gate';
}

/**
 * When an INDEPENDENT REVIEW tier is required, and which one.
 *
 * Derived from the canonical risk class alone, because that is the one input
 * that is already Founder-controlled and already decides whether an act can
 * touch the outside world. A recommendation never bypasses canonical approval
 * authority — this raises a floor, it never lowers the Phase 8 gate.
 */
export const REVIEW_REQUIREMENT: Readonly<Record<RiskClass, IntelligenceTier | null>> = deepFreeze({
  read_only: null,
  reversible: null,
  external_side_effect: 'high',
  destructive: 'critical_review',
  founder_gate: 'critical_review',
});

function maxTier(...tiers: IntelligenceTier[]): IntelligenceTier {
  return tiers.reduce((a, b) => (tierRank(b) > tierRank(a) ? b : a));
}

/** One stated reason a tier floor moved. Categorical id plus a sentence. */
export interface RoutingConsideration {
  factor: 'complexity' | 'context_size' | 'work_kind' | 'risk_class' | 'latency' | 'privacy' | 'budget';
  observed: string;
  /** The floor this factor alone imposes, or null when it imposes none. */
  imposedFloor: IntelligenceTier | null;
  statement: string;
}

/**
 * A routing PROPOSAL. Never an assignment, never an authority, never a
 * provider.
 *
 * Deliberately carries no `providerId` and no `modelId` field at all: the
 * shape is incapable of naming an executor, so no reader and no caller can
 * mistake it for one. `boundProvider` appears only on a RECORDED decision,
 * where it is the binding HQ OBSERVED on the canonical task — a fact copied
 * in, never a choice made here.
 */
export interface RoutingProposal {
  /** The tier proposed, or null when the policy admits none. */
  tier: IntelligenceTier | null;
  /** The cheapest tier that clears every requirement, before the permitted set. */
  floorTier: IntelligenceTier;
  /** A stronger tier this work must ALSO be reviewed at, or null. */
  requiredReviewTier: IntelligenceTier | null;
  /** The permitted set the proposal was intersected with. */
  permittedTiers: readonly IntelligenceTier[];
  /** Every tier the policy weighed, with why each was or was not taken. */
  considerations: readonly RoutingConsideration[];
  /** Set when `tier` is null. Categorical; never a guess. */
  refusal: RoutingRefusal | null;
  /** The budget answer that was folded in. Never a grant. */
  budgetDecision: BudgetDecision;
  /** True when a human has to decide before this proposal can be acted on. */
  requiresFounderDecision: boolean;
  /** True when the proposal picked the free local path. */
  localPathTaken: boolean;
  characteristics: TaskCharacteristics;
  /** Literal false. A proposal grants nothing, ever. */
  grantsAuthority: false;
  /** Literal false. A proposal spends nothing and activates nothing. */
  authorizesSpend: false;
  statement: string;
  latencyStatement: string;
}

/**
 * Compute the routing proposal — value engineering, as a total function.
 *
 * The rule, in order:
 *  1. take the FLOOR: the highest of the complexity, context, work-kind and
 *     risk floors, and of the review requirement when there is one. That is
 *     the cheapest tier that still meets the requirement;
 *  2. apply the PRIVACY CAP: `local_only` admits `deterministic_local` and
 *     nothing else. When the floor is higher than that, HQ refuses and NAMES
 *     the conflict rather than quietly breaking one of the two rules;
 *  3. intersect with the PERMITTED set. The cheapest permitted tier at or
 *     above the floor wins — never one below it, because "cheapest" is bounded
 *     by "still meets the requirement" and never the other way round;
 *  4. fold in the BUDGET answer. `blocked` refuses outright. `requires_
 *     founder_decision` refuses nothing but marks the proposal as needing a
 *     human — except when the chosen tier is the free local one, which spends
 *     nothing and therefore needs no spending decision.
 */
export function computeRoutingProposal(input: {
  characteristics: TaskCharacteristics;
  permittedTiers: readonly IntelligenceTier[];
  budgetDecision: BudgetDecision;
}): RoutingProposal {
  const c = input.characteristics;
  const complexityFloor = COMPLEXITY_FLOOR[c.complexity];
  const contextFloor = CONTEXT_FLOOR[c.contextSize];
  const workFloor = WORK_KIND_FLOOR[c.workKind];
  // FAIL CLOSED on a risk class outside the vocabulary (Wave 5 Medium 5,
  // defence in depth). `op_capabilities` carries no immutability triggers, so
  // a raw `UPDATE ... SET risk_class = 'totally_harmless'` is a writable row —
  // and an unrecognized key here reads `RISK_FLOOR[...] === undefined` (no
  // floor at all) and `REVIEW_REQUIREMENT[...] === undefined`, which
  // `proposalSatisfiesReviewRequirement` treats as "no reviewer required". The
  // store reads coerce the same way (`readStoredRiskClass`); this is the
  // second layer, so a characteristics object built by any future path cannot
  // escape it either.
  const riskClass: RiskClass = (RISK_CLASSES as readonly unknown[]).includes(c.riskClass)
    ? c.riskClass
    : 'founder_gate';
  const riskFloor = RISK_FLOOR[riskClass];
  const requiredReviewTier = REVIEW_REQUIREMENT[riskClass];
  const floorTier = maxTier(
    complexityFloor,
    contextFloor,
    workFloor,
    riskFloor,
    ...(requiredReviewTier ? [requiredReviewTier] : []),
  );

  const considerations: RoutingConsideration[] = [
    {
      factor: 'complexity',
      observed: c.complexity,
      imposedFloor: complexityFloor,
      statement: `Complexity ${c.complexity} needs at least ${complexityFloor}.`,
    },
    {
      factor: 'context_size',
      observed: c.contextSize,
      imposedFloor: contextFloor,
      statement: `A ${c.contextSize} context needs at least ${contextFloor}.`,
    },
    {
      factor: 'work_kind',
      observed: c.workKind,
      imposedFloor: workFloor,
      statement: `Work of kind ${c.workKind} needs at least ${workFloor}.`,
    },
    {
      factor: 'risk_class',
      // The CHECKED value, never the stored string.
      observed: riskClass,
      imposedFloor: riskFloor,
      statement:
        `The canonical risk class ${riskClass} needs at least ${riskFloor}` +
        (requiredReviewTier
          ? `, and requires an independent review at ${requiredReviewTier}.`
          : ', and requires no independent review tier.'),
    },
    {
      factor: 'latency',
      observed: c.latency,
      imposedFloor: null,
      statement: INTELLIGENCE_LATENCY_STATEMENT,
    },
    {
      factor: 'privacy',
      observed: c.privacy,
      imposedFloor: null,
      statement:
        c.privacy === 'local_only'
          ? 'local_only admits deterministic_local and nothing else; no cloud tier is considered.'
          : 'unrestricted places no locality constraint on the tier.',
    },
    {
      factor: 'budget',
      observed: input.budgetDecision,
      imposedFloor: null,
      statement: BUDGET_POLICY_STATEMENT,
    },
  ];

  const base = {
    floorTier,
    requiredReviewTier,
    permittedTiers: [...input.permittedTiers],
    considerations,
    budgetDecision: input.budgetDecision,
    characteristics: c,
    grantsAuthority: false as const,
    authorizesSpend: false as const,
    statement: INTELLIGENCE_ROUTING_STATEMENT,
    latencyStatement: INTELLIGENCE_LATENCY_STATEMENT,
  };

  if (input.budgetDecision === 'blocked') {
    return {
      ...base,
      tier: null,
      refusal: 'budget_ceiling_blocks',
      requiresFounderDecision: true,
      localPathTaken: false,
    };
  }

  if (c.privacy === 'local_only') {
    if (tierRank(floorTier) > tierRank(LOCAL_ONLY_TIER)) {
      return {
        ...base,
        tier: null,
        refusal: 'privacy_requires_local_but_work_needs_more',
        requiresFounderDecision: true,
        localPathTaken: false,
      };
    }
    if (!input.permittedTiers.includes(LOCAL_ONLY_TIER)) {
      return {
        ...base,
        tier: null,
        refusal: 'no_permitted_tier',
        requiresFounderDecision: true,
        localPathTaken: false,
      };
    }
    return {
      ...base,
      tier: 'deterministic_local',
      refusal: null,
      requiresFounderDecision: false,
      localPathTaken: true,
    };
  }

  const admissible = [...input.permittedTiers]
    .filter((tier) => isIntelligenceTier(tier) && tierRank(tier) >= tierRank(floorTier))
    .sort((a, b) => tierRank(a) - tierRank(b));
  const chosen = admissible[0] ?? null;
  if (!chosen) {
    return {
      ...base,
      tier: null,
      refusal: 'no_permitted_tier',
      requiresFounderDecision: true,
      localPathTaken: false,
    };
  }
  const localPathTaken = chosen === 'deterministic_local';
  return {
    ...base,
    tier: chosen,
    refusal: null,
    // A free local tier spends nothing, so an unknown spend position does not
    // need a human before it may be used. Every other tier does.
    requiresFounderDecision: input.budgetDecision === 'requires_founder_decision' && !localPathTaken,
    localPathTaken,
  };
}

/**
 * Does this proposal satisfy the independent-review requirement it carries?
 *
 * Law 6 in one function: a cheaper tier cannot bypass a required reviewer
 * tier. A null tier never satisfies anything.
 */
export function proposalSatisfiesReviewRequirement(proposal: {
  tier: IntelligenceTier | null;
  requiredReviewTier: IntelligenceTier | null;
}): boolean {
  if (proposal.requiredReviewTier == null) return true;
  if (proposal.tier == null) return false;
  return tierRank(proposal.tier) >= tierRank(proposal.requiredReviewTier);
}

/* ------------------------------------------------------------------ */
/* Escalation                                                          */
/* ------------------------------------------------------------------ */

export type EscalationRefusal =
  | 'already_at_highest_tier'
  | 'no_higher_permitted_tier'
  | 'prior_decision_has_no_tier'
  | 'budget_ceiling_blocks';

/** The canonical identity an escalation must carry forward UNCHANGED. */
export interface CanonicalWorkIdentity {
  taskId: string;
  missionId: string | null;
  projectId: string | null;
}

export interface EscalationProposal {
  /** VERBATIM from the decision being escalated. Never re-derived, never changed. */
  identity: CanonicalWorkIdentity;
  fromDecisionId: string;
  fromTier: IntelligenceTier;
  toTier: IntelligenceTier;
  trigger: EscalationTrigger;
  requiredReviewTier: IntelligenceTier | null;
  /** Literal false. An escalation is a stronger recommendation, not a new grant. */
  grantsAuthority: false;
  authorizesSpend: false;
  requiresFounderDecision: boolean;
  statement: string;
}

/**
 * Escalate a recorded decision to a stronger tier.
 *
 * Law 7. The canonical identity is carried through by REFERENCE — the same
 * task, the same mission, the same project — and there is no parameter that
 * could change any of them: the identity is read off the prior decision, not
 * accepted from the caller. It moves strictly UP the tier order, only into the
 * permitted set, and it refuses rather than inventing a tier when there is no
 * higher permitted one.
 */
export function deriveEscalation(input: {
  from: {
    id: string;
    tier: StoredIntelligenceTier;
    identity: CanonicalWorkIdentity;
    requiredReviewTier: IntelligenceTier | null;
  };
  trigger: EscalationTrigger;
  permittedTiers: readonly IntelligenceTier[];
  budgetDecision: BudgetDecision;
}): { ok: true; escalation: EscalationProposal } | { ok: false; refusal: EscalationRefusal } {
  if (!isIntelligenceTier(input.from.tier)) return { ok: false, refusal: 'prior_decision_has_no_tier' };
  if (input.budgetDecision === 'blocked') return { ok: false, refusal: 'budget_ceiling_blocks' };
  const fromTier = input.from.tier;
  if (tierRank(fromTier) >= INTELLIGENCE_TIERS.length - 1) {
    return { ok: false, refusal: 'already_at_highest_tier' };
  }
  const higher = [...input.permittedTiers]
    .filter((tier) => isIntelligenceTier(tier) && tierRank(tier) > tierRank(fromTier))
    // A tier that does not satisfy the REVIEW requirement is not a candidate
    // (Wave 5 correction round three, Medium B3). This used to pick the cheapest
    // higher permitted tier full stop, consulting neither `requiredReviewTier`
    // nor the floor — so an escalation RECORDED `low_cost` against a
    // `critical_review` requirement that the enforced path refuses outright with
    // `review_tier_required`, while law 6 and the phase document both said the
    // facade ENFORCES it. Skipping such a tier rather than refusing on it is
    // what keeps escalation useful: the next one up may well satisfy it.
    .filter((tier) =>
      proposalSatisfiesReviewRequirement({ tier, requiredReviewTier: input.from.requiredReviewTier }),
    )
    .sort((a, b) => tierRank(a) - tierRank(b));
  const toTier = higher[0];
  if (!toTier) return { ok: false, refusal: 'no_higher_permitted_tier' };
  return {
    ok: true,
    escalation: {
      // Structurally copied, field by field, from the prior decision.
      identity: {
        taskId: input.from.identity.taskId,
        missionId: input.from.identity.missionId,
        projectId: input.from.identity.projectId,
      },
      fromDecisionId: input.from.id,
      fromTier,
      toTier,
      trigger: input.trigger,
      requiredReviewTier: input.from.requiredReviewTier,
      grantsAuthority: false,
      authorizesSpend: false,
      requiresFounderDecision:
        input.budgetDecision === 'requires_founder_decision' && toTier !== 'deterministic_local',
      statement: ESCALATION_STATEMENT,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Budget evaluation                                                   */
/* ------------------------------------------------------------------ */

/** One recorded ceiling, as a reader sees it. */
export interface BudgetRecord {
  id: string;
  seq: number;
  /** `unrecognized` for a row appended outside the vocabulary. It governs nothing. */
  scopeKind: StoredBudgetScope;
  scopeId: string;
  window: StoredBudgetWindow;
  /**
   * Null for a row whose stored ceiling is not a whole non-negative number.
   * Read as null rather than as `NaN`, and answered as
   * `requires_founder_decision` rather than as `within_ceiling`.
   */
  ceilingMinorUnits: number | null;
  currency: string;
  permittedTiers: readonly IntelligenceTier[];
  version: number;
  setAt: string;
  setBy: string;
  note: string | null;
  statement: string;
}

export interface BudgetEvaluation {
  decision: BudgetDecision;
  /** Null when no ceiling has ever been recorded for the scope. */
  ceilingMinorUnits: number | null;
  currency: string | null;
  /** The sum of KNOWN amounts in the ceiling's currency. Never imputed. */
  observedMinorUnits: number;
  /** Entries with no amount at all. The reason HQ often cannot say "within". */
  unknownAmountEntries: number;
  /** Entries recorded in a DIFFERENT currency. Never converted; counted. */
  otherCurrencyEntries: number;
  permittedTiers: readonly IntelligenceTier[];
  reason: string;
  /** Literal false, on every answer. */
  grantsSpend: false;
  authorizesPaidActivation: false;
  statement: string;
}

/**
 * Evaluate a scope against its recorded ceiling — law 3.
 *
 * Fail closed at every fork:
 *  - no ceiling recorded at all → `requires_founder_decision`, and the
 *    permitted set is the free local tier alone. Absence of a policy is not
 *    permission;
 *  - any entry in the window whose amount is unknown → `requires_founder_
 *    decision`, because HQ cannot prove it is under a ceiling it cannot
 *    measure against. This is the "unknown stays unknown" rule reaching the
 *    one place it has real consequences;
 *  - any entry in a currency the ceiling is not denominated in → the same
 *    answer, because converting it would require a rate HQ has not observed;
 *  - observed at or above the ceiling → `blocked`;
 *  - otherwise `within_ceiling`, which is a statement that the ceiling has not
 *    been reached and NOT permission to spend. `grantsSpend` is a literal
 *    false on every branch, including this one.
 */
export function evaluateBudget(input: {
  budget: Pick<BudgetRecord, 'ceilingMinorUnits' | 'currency' | 'permittedTiers'> | null;
  entries: readonly { amountMinorUnits: number | null; currency: string | null }[];
}): BudgetEvaluation {
  const base = {
    grantsSpend: false as const,
    authorizesPaidActivation: false as const,
    statement: BUDGET_POLICY_STATEMENT,
  };
  if (!input.budget) {
    const unknownAmountEntries = input.entries.filter((entry) => entry.amountMinorUnits == null).length;
    return {
      ...base,
      decision: 'requires_founder_decision',
      ceilingMinorUnits: null,
      currency: null,
      observedMinorUnits: 0,
      unknownAmountEntries,
      otherCurrencyEntries: 0,
      permittedTiers: [...DEFAULT_PERMITTED_TIERS],
      reason:
        'No budget ceiling has been recorded for this scope. HQ does not treat the absence of a policy as ' +
        'permission, so the answer is a Founder decision and the permitted tier set is the free local tier ' +
        'alone.',
    };
  }
  if (input.budget.ceilingMinorUnits == null) {
    // A row exists and its ceiling is unreadable. That is NOT permission, and
    // it is not `within_ceiling` either: an unguarded `Number()` used to make
    // it `NaN`, `observed >= NaN` false, and `blocked` unreachable for the
    // scope forever (Wave 5 review, Medium finding B-4). Answered as the
    // Founder decision it is, with the free local tier alone.
    const unknownAmountEntries = input.entries.filter((entry) => entry.amountMinorUnits == null).length;
    return {
      ...base,
      decision: 'requires_founder_decision',
      ceilingMinorUnits: null,
      currency: input.budget.currency,
      observedMinorUnits: 0,
      unknownAmountEntries,
      otherCurrencyEntries: 0,
      permittedTiers: [...DEFAULT_PERMITTED_TIERS],
      reason:
        'A budget row is recorded for this scope but its ceiling is not a whole non-negative number, so HQ ' +
        'cannot measure anything against it. An unreadable ceiling is a Founder decision, never a reassuring ' +
        'answer, and the permitted tier set is the free local tier alone.',
    };
  }
  const budget = { ...input.budget, ceilingMinorUnits: input.budget.ceilingMinorUnits };
  let observedMinorUnits = 0;
  let unknownAmountEntries = 0;
  let otherCurrencyEntries = 0;
  for (const entry of input.entries) {
    if (entry.amountMinorUnits == null || entry.currency == null) {
      unknownAmountEntries += 1;
      continue;
    }
    if (entry.currency !== budget.currency) {
      otherCurrencyEntries += 1;
      continue;
    }
    observedMinorUnits += entry.amountMinorUnits;
  }
  const common = {
    ...base,
    ceilingMinorUnits: budget.ceilingMinorUnits,
    currency: budget.currency,
    observedMinorUnits,
    unknownAmountEntries,
    otherCurrencyEntries,
    permittedTiers: [...budget.permittedTiers],
  };
  if (observedMinorUnits >= budget.ceilingMinorUnits) {
    return {
      ...common,
      decision: 'blocked',
      reason:
        `Recorded spend of ${observedMinorUnits} minor units in ${budget.currency} has reached the ceiling ` +
        `of ${budget.ceilingMinorUnits}. The ceiling blocks; it does not grant, and lifting it is a Founder act.`,
    };
  }
  if (unknownAmountEntries > 0 || otherCurrencyEntries > 0) {
    return {
      ...common,
      decision: 'requires_founder_decision',
      reason:
        `HQ cannot prove this scope is under its ceiling: ${unknownAmountEntries} recorded entr(ies) have no ` +
        `known amount and ${otherCurrencyEntries} are in another currency, which HQ does not convert. An ` +
        'unknown cost stays unknown, so the answer is a Founder decision rather than a reassuring number.',
    };
  }
  return {
    ...common,
    decision: 'within_ceiling',
    reason:
      `Recorded spend of ${observedMinorUnits} minor units in ${budget.currency} is below the ceiling of ` +
      `${budget.ceilingMinorUnits}. That is a statement that the ceiling has not been reached; it is not ` +
      'permission to spend, and it activates nothing.',
  };
}

/** One scope a piece of work is answerable to, and where it came from. */
export interface GoverningBudgetScope {
  scopeKind: BudgetScope;
  scopeId: string;
  window: BudgetWindow;
  /**
   * The canonical row this scope was DERIVED from — never a caller's argument.
   * `deployment` is the baseline every piece of work is answerable to.
   */
  derivedFrom: 'deployment' | 'task_mission' | 'task_project' | 'task_bound_provider';
}

/**
 * The order refusals get worse in. Used to pick the most restrictive answer.
 *
 * `Readonly` and frozen: it is read on an enforcement path, and the other
 * correction lane's version of this constant carried the `Readonly` type for
 * exactly that reason.
 */
const BUDGET_DECISION_SEVERITY: Readonly<Record<BudgetDecision, number>> = Object.freeze({
  within_ceiling: 0,
  requires_founder_decision: 1,
  blocked: 2,
});

/**
 * Fold EVERY policy that governs one piece of work into one answer — law 4,
 * enforced instead of asserted.
 *
 * The module docstring's fourth law says no policy path can widen the
 * permitted tier set on its own. That was true of this module and false of the
 * facade, because the facade took the governing scope as a caller argument:
 * the same task, the same worker and the same live fence produced
 * `tier_not_permitted` under the default scope and a recorded
 * `critical_review` under a scope the caller named instead, with the whole
 * permitted set behind it (Wave 5 review, High finding B-1). The scopes are
 * derived from canonical truth now, and this is where they are combined.
 *
 * Two rules, both in the restrictive direction:
 *
 *  - the DECISION is the worst of them. One `blocked` ceiling blocks; one
 *    scope HQ cannot measure makes the whole answer a Founder decision;
 *  - the permitted tier set is the INTERSECTION, never the union. A ceiling
 *    that permits more cannot widen one that permits less, which is the only
 *    reading under which "the most restrictive applicable policy governs" is
 *    true rather than aspirational.
 *
 * An EMPTY list is not "no restrictions": it answers `requires_founder_decision`
 * with the free local tier alone, the same fail-closed answer as no ceiling at
 * all. Nothing produces an empty list today (the deployment baseline is always
 * present), and a future caller that did must not be handed permission.
 */
export function combineBudgetEvaluations(
  parts: readonly { scope: GoverningBudgetScope; evaluation: BudgetEvaluation }[],
): {
  decision: BudgetDecision;
  permittedTiers: IntelligenceTier[];
  reason: string;
  governedBy: GoverningBudgetScope[];
} {
  if (parts.length === 0) {
    return {
      decision: 'requires_founder_decision',
      permittedTiers: [...DEFAULT_PERMITTED_TIERS],
      reason:
        'No budget policy was resolved for this work at all. Absence of a policy is not permission, so the ' +
        'answer is a Founder decision and the permitted tier set is the free local tier alone.',
      governedBy: [],
    };
  }
  let decision: BudgetDecision = 'within_ceiling';
  for (const part of parts) {
    if (BUDGET_DECISION_SEVERITY[part.evaluation.decision] > BUDGET_DECISION_SEVERITY[decision]) {
      decision = part.evaluation.decision;
    }
  }
  const permittedTiers = INTELLIGENCE_TIERS.filter((tier) =>
    parts.every((part) => part.evaluation.permittedTiers.includes(tier)),
  );
  const worst = parts.find((part) => part.evaluation.decision === decision)!;
  const scopes = parts.map((part) => `${part.scope.scopeKind}:${part.scope.scopeId}/${part.scope.window}`);
  return {
    decision,
    permittedTiers,
    reason:
      `${scopes.length} recorded polic(ies) govern this work (${scopes.join(', ')}); the most restrictive ` +
      `answer stands and the permitted tier set is their intersection. ${worst.evaluation.reason}`,
    governedBy: parts.map((part) => part.scope),
  };
}

/* ------------------------------------------------------------------ */
/* Stored rows                                                         */
/* ------------------------------------------------------------------ */

export interface ModelObservationRow {
  seq: number;
  id: string;
  providerId: string;
  modelId: string | null;
  locality: ModelLocality | 'unrecognized';
  availability: ModelAvailability;
  capabilityFacts: ModelCapabilityFact[];
  contextWindowTokens: number | null;
  unitCost: CostFact;
  source: ObservationSource | 'unrecognized';
  observedAt: string;
  observedBy: string;
  note: string | null;
}

export interface BudgetRow extends Omit<BudgetRecord, 'statement'> {
  budgetKey: string;
}

export interface DecisionRow {
  seq: number;
  id: string;
  taskId: string;
  missionId: string | null;
  projectId: string | null;
  tier: StoredIntelligenceTier;
  floorTier: StoredIntelligenceTier;
  requiredReviewTier: IntelligenceTier | null;
  escalatedFrom: string | null;
  escalationTrigger: EscalationTrigger | null;
  /** The provider the canonical payload binds the task to, as HQ OBSERVED it. */
  boundProvider: string | null;
  characteristics: TaskCharacteristics | null;
  permittedTiers: readonly IntelligenceTier[];
  budgetDecision: BudgetDecision;
  label: string;
  issuedAt: string;
  issuedBy: string;
  processId: string;
}

export interface DecisionOutcomeRow {
  seq: number;
  id: string;
  decisionId: string;
  result: DecisionResult;
  reviewedByTier: IntelligenceTier | null;
  note: string | null;
  recordedAt: string;
  recordedBy: string;
}

export interface CostEntryRow {
  seq: number;
  id: string;
  taskId: string;
  missionId: string | null;
  projectId: string | null;
  decisionId: string | null;
  providerId: string;
  /**
   * Did HQ's own canonical record BIND this entry's task to the provider it
   * names, at the moment the entry was recorded?
   *
   * `providerId` is caller-declared and is only enforced equal to the binding
   * when a binding exists, so it is an attribution CLAIM. This is HQ's
   * statement about that claim, written by HQ and never by the caller, on an
   * append-only row. False on an entry recorded before the column existed —
   * the fail-closed reading.
   */
  providerBound: boolean;
  /**
   * EVERY mission HQ derived for this entry's task at the moment it recorded
   * the entry, and every project those missions belonged to.
   *
   * `missionId`/`projectId` above hold ONE of N — `canonicalScopes.missionIds[0]`
   * — and a task can legitimately be linked to several missions. Every reader
   * that unioned canonical membership with the single column therefore had a
   * union that was complete only for the mission or project that sorted first,
   * and the other one's ceiling could be nullified by moving ITS mission to
   * another project: no raw SQL, `hq.mission_command` alone, victim ceiling
   * `blocked/observed 5000` → `within_ceiling/observed 0`, and the previously
   * refused decision recorded (Wave 5 correction round six, High 3).
   *
   * HQ-derived, never caller-supplied, on an append-only row — so this is
   * monotone against every supported route, in exactly the way the single
   * columns were meant to be. On a row recorded before these columns existed
   * the arrays are the single columns, which is what that row actually
   * committed to.
   *
   * It is NOT "unforgeable", which is what this sentence said until round ten,
   * Medium 1. Append-only here means four engine triggers and no hash chain, so
   * a writer holding the file can drop them, rewrite these two arrays in place
   * without changing the row count, and put them back — executed, taking an
   * exhausted ceiling's observed spend from 5000 to 0 with both integrity
   * depths clean. See `service.ts`'s `spentUnder` comment and Phase 14's
   * NOT-fixed list for the executed cost.
   */
  missionIds: string[];
  projectIds: string[];
  modelId: string | null;
  fact: CostFact;
  unitsObserved: number | null;
  occurredAt: string;
  recordedAt: string;
  recordedBy: string;
  note: string | null;
}

function jsonArray(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Stored tiers, read through the vocabulary and never asserted into it. */
function readStoredTier(value: unknown): StoredIntelligenceTier {
  return isIntelligenceTier(value) ? value : STORED_TIER_UNRECOGNIZED;
}

function readPermittedTiers(value: unknown): IntelligenceTier[] {
  return jsonArray(value).filter(isIntelligenceTier);
}

function rowToObservation(r: Record<string, unknown>): ModelObservationRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    providerId: r.provider_id as string,
    modelId: (r.model_id as string | null) ?? null,
    locality: isModelLocality(r.locality) ? r.locality : 'unrecognized',
    // Fail closed: an availability outside the vocabulary reads as `unknown`,
    // which is the answer that costs a human a look rather than the one that
    // makes a dead provider look healthy.
    availability: isModelAvailability(r.availability) ? r.availability : 'unknown',
    capabilityFacts: jsonArray(r.capability_facts).filter(isModelCapabilityFact),
    contextWindowTokens:
      typeof r.context_window_tokens === 'number' && Number.isInteger(r.context_window_tokens)
        ? r.context_window_tokens
        : null,
    unitCost: readStoredCostFact({
      provenance: r.unit_cost_provenance,
      amountMinorUnits: r.unit_cost_minor_units,
      currency: r.unit_cost_currency,
      unitKind: r.unit_cost_unit_kind,
      basis: r.unit_cost_basis,
    }),
    source: isObservationSource(r.source) ? r.source : 'unrecognized',
    observedAt: r.observed_at as string,
    observedBy: r.observed_by as string,
    note: (r.note as string | null) ?? null,
  };
}

/**
 * Read a STORED budget row. FAIL CLOSED, in the same direction as
 * `readStoredCostFact` — which the budget reader did not do, and the gap was
 * live (Wave 5 review, Medium finding B-4).
 *
 * Three coercions used to fail OPEN, and all three are gone:
 *
 *  - `scope_kind` outside the vocabulary was coerced to `'deployment'` and
 *    `window_kind` to `'total'`, so a raw append naming a scope that does not
 *    exist was ADOPTED into the deployment scope — the exact opposite of
 *    `#entriesForScope`'s stated rule that an unrecognized scope matches
 *    nothing. Both now read as `unrecognized`, which `latestBudgetFor` can
 *    never match, so a forged row governs nothing;
 *  - `Number(r.ceiling_minor_units)` was unguarded, so a non-numeric ceiling
 *    became `NaN`, `observed >= NaN` was false, and `blocked` could never fire
 *    again for that scope: one append turned a blocked scope into
 *    `within_ceiling` and a `critical_review` tier was recorded against it.
 *    A ceiling that is not a whole non-negative number now reads as `null`,
 *    and `evaluateBudget` answers `requires_founder_decision` on it.
 */
function rowToBudget(r: Record<string, unknown>): BudgetRow {
  const ceiling = r.ceiling_minor_units;
  return {
    seq: r.seq as number,
    id: r.id as string,
    scopeKind: isBudgetScope(r.scope_kind) ? r.scope_kind : STORED_BUDGET_UNRECOGNIZED,
    scopeId: r.scope_id as string,
    window: isBudgetWindow(r.window_kind) ? r.window_kind : STORED_BUDGET_UNRECOGNIZED,
    ceilingMinorUnits:
      typeof ceiling === 'number' && Number.isInteger(ceiling) && ceiling >= 0 ? ceiling : null,
    currency: r.currency as string,
    permittedTiers: readPermittedTiers(r.permitted_tiers),
    version: Number(r.version),
    setAt: r.set_at as string,
    setBy: r.set_by as string,
    note: (r.note as string | null) ?? null,
    budgetKey: r.budget_key as string,
  };
}

function rowToDecision(r: Record<string, unknown>): DecisionRow {
  const characteristics = jsonObject(r.characteristics);
  return {
    seq: r.seq as number,
    id: r.id as string,
    taskId: r.task_id as string,
    missionId: (r.mission_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    tier: readStoredTier(r.tier),
    floorTier: readStoredTier(r.floor_tier),
    requiredReviewTier: isIntelligenceTier(r.required_review_tier) ? r.required_review_tier : null,
    escalatedFrom: (r.escalated_from as string | null) ?? null,
    escalationTrigger: isEscalationTrigger(r.escalation_trigger) ? r.escalation_trigger : null,
    boundProvider: (r.bound_provider as string | null) ?? null,
    // Fail closed: characteristics outside the closed vocabularies read as
    // null, so the avoidable-spend derivation simply cannot see them rather
    // than treating a forged row as a policy input.
    characteristics: isTaskCharacteristics(characteristics) ? characteristics : null,
    permittedTiers: readPermittedTiers(r.permitted_tiers),
    budgetDecision: isBudgetDecision(r.budget_decision) ? r.budget_decision : 'requires_founder_decision',
    label: r.label as string,
    issuedAt: r.issued_at as string,
    issuedBy: r.issued_by as string,
    processId: r.process_id as string,
  };
}

function rowToOutcome(r: Record<string, unknown>): DecisionOutcomeRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    decisionId: r.decision_id as string,
    // Fail closed: a result outside the vocabulary is `result_unknown`, never
    // `quality_met`. A forged row can never make a tier look successful.
    result: isDecisionResult(r.result) ? r.result : 'result_unknown',
    reviewedByTier: isIntelligenceTier(r.reviewed_by_tier) ? r.reviewed_by_tier : null,
    note: (r.note as string | null) ?? null,
    recordedAt: r.recorded_at as string,
    recordedBy: r.recorded_by as string,
  };
}

/**
 * The recorded scope-id set for one cost row: the JSON array column when the
 * row carries one, UNION the single legacy column, de-duplicated and sorted.
 *
 * Union rather than "array if present, column otherwise", because the two can
 * only ever agree — HQ writes the column from the array's first element — and a
 * union is the fail-CLOSED reading if they ever did not: a scope named by
 * either is a scope this spend was filed under, and a ceiling that has been
 * charged stays charged.
 */
function recordedScopeIds(arrayColumn: unknown, singleColumn: unknown): string[] {
  const ids = new Set<string>();
  for (const value of jsonArray(arrayColumn)) {
    if (typeof value === 'string' && value !== '') ids.add(value);
  }
  if (typeof singleColumn === 'string' && singleColumn !== '') ids.add(singleColumn);
  return [...ids].sort();
}

function rowToCostEntry(r: Record<string, unknown>): CostEntryRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    taskId: r.task_id as string,
    missionId: (r.mission_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    decisionId: (r.decision_id as string | null) ?? null,
    providerId: r.provider_id as string,
    // Read as NOT bound unless HQ recorded that it was. See
    // `ensureCostEntryBindingColumn`: null (an older row) is the fail-closed
    // reading, never the convenient one.
    providerBound: Number(r.provider_bound) === 1,
    // The FULL recorded attribution, with the single column folded in. A row
    // written before `ensureCostEntryScopeColumns` existed carries no array, and
    // what it committed to is exactly its one column — so that is what it
    // reports, rather than nothing. A forged array is no more reachable than a
    // forged `mission_id` was: both are HQ-derived columns on an append-only
    // table, and only non-empty strings are taken.
    missionIds: recordedScopeIds(r.mission_ids, r.mission_id),
    projectIds: recordedScopeIds(r.project_ids, r.project_id),
    modelId: (r.model_id as string | null) ?? null,
    fact: readStoredCostFact({
      provenance: r.provenance,
      amountMinorUnits: r.amount_minor_units,
      currency: r.currency,
      unitKind: r.unit_kind,
      basis: r.basis,
    }),
    unitsObserved:
      typeof r.units_observed === 'number' && Number.isInteger(r.units_observed) ? r.units_observed : null,
    occurredAt: r.occurred_at as string,
    recordedAt: r.recorded_at as string,
    recordedBy: r.recorded_by as string,
    note: (r.note as string | null) ?? null,
  };
}

export function loadModelObservations(db: HqDatabase): ModelObservationRow[] {
  return (
    db.prepare(`SELECT * FROM hq_intel_model_observations ORDER BY seq`).all() as Record<string, unknown>[]
  ).map(rowToObservation);
}

export function loadBudgets(db: HqDatabase): BudgetRow[] {
  return (db.prepare(`SELECT * FROM hq_intel_budgets ORDER BY seq`).all() as Record<string, unknown>[]).map(
    rowToBudget,
  );
}

/**
 * The CURRENT ceiling for a scope: the highest version recorded for it.
 *
 * Append-only versioning, so "current" is a derivation over the ledger and
 * never a mutable row somebody could edit.
 */
export function latestBudgetFor(
  budgets: readonly BudgetRow[],
  scope: { scopeKind: BudgetScope; scopeId: string; window: BudgetWindow },
): BudgetRow | null {
  let best: BudgetRow | null = null;
  for (const row of budgets) {
    if (row.scopeKind !== scope.scopeKind) continue;
    if (row.scopeId !== scope.scopeId) continue;
    if (row.window !== scope.window) continue;
    if (!best || row.version > best.version || (row.version === best.version && row.seq > best.seq)) {
      best = row;
    }
  }
  return best;
}

export function loadDecision(db: HqDatabase, id: string): DecisionRow | null {
  const row = db.prepare(`SELECT * FROM hq_intel_decisions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDecision(row) : null;
}

export function loadDecisionByKey(db: HqDatabase, key: string): DecisionRow | null {
  const row = db.prepare(`SELECT * FROM hq_intel_decisions WHERE decision_key = ?`).get(key) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDecision(row) : null;
}

export function loadDecisions(db: HqDatabase): DecisionRow[] {
  return (db.prepare(`SELECT * FROM hq_intel_decisions ORDER BY seq`).all() as Record<string, unknown>[]).map(
    rowToDecision,
  );
}

export function loadDecisionOutcomes(db: HqDatabase): DecisionOutcomeRow[] {
  return (
    db.prepare(`SELECT * FROM hq_intel_decision_outcomes ORDER BY seq`).all() as Record<string, unknown>[]
  ).map(rowToOutcome);
}

export function loadCostEntries(db: HqDatabase): CostEntryRow[] {
  return (db.prepare(`SELECT * FROM hq_intel_cost_entries ORDER BY seq`).all() as Record<string, unknown>[]).map(
    rowToCostEntry,
  );
}

/* ------------------------------------------------------------------ */
/* Derived records the facade returns                                  */
/* ------------------------------------------------------------------ */

/** One recorded routing decision, with its DERIVED state and result. */
export interface DecisionRecord extends DecisionRow {
  /** DERIVED from the ledger; never a stored column. */
  state: DecisionState;
  result: DecisionResult;
  reviewedByTier: IntelligenceTier | null;
  /** True when a later decision names this one as the tier it escalated from. */
  escalatedAwayTo: string | null;
  /** Does the recorded tier satisfy the review requirement recorded with it? */
  satisfiesReviewRequirement: boolean;
  /**
   * The floor as the ROW records it, kept beside the served `floorTier` so the
   * history is not lost when the two differ (Wave 5 correction round seven,
   * Medium NEW-6).
   *
   * `floorTier` on this record is RECOMPUTED — from the same characteristics,
   * with the same canonical risk class, that `decisionIsProvablyAvoidable`
   * recomputes from. The two used to disagree: the avoidability flag was
   * computed from the CURRENT canonical risk class while `rowToDecision` served
   * the STORED `floor_tier`, so a Founder registry upsert that raised a
   * capability's risk class flipped `provablyAvoidable` 1 → 0 while the served
   * record still read `floorTier: deterministic_local` beside
   * `requiredReviewTier: critical_review`. Those two cannot both be true — the
   * review requirement is one of the terms the floor's `max` is taken over —
   * and the contradiction was published on the Founder route and disclosed
   * nowhere.
   *
   * That fix left one narrower way to the same contradiction, closed in round
   * nine (Low 3): the recomputation folds in the requirement of the CANONICAL
   * risk class, while the served `requiredReviewTier` is the max of that and
   * the stored column. A raw write that raised `required_review_tier` above the
   * canonical class therefore still produced the impossible pair. The served
   * floor is now the max over the served requirement, so the two published
   * numbers are coherent whatever the stored column says.
   */
  floorTierAsRecorded: StoredIntelligenceTier;
  /**
   * True when the canonical risk class this record was derived against differs
   * from the one stored on the row.
   *
   * The visible half of the answer to the same finding: the flip is real —
   * canonical truth moved — and it is a fact a reader is entitled to see rather
   * than a silent retroactive change. `intelligenceAnalytics` counts these.
   * Always false on a derivation with no canonical resolver, because there is
   * then nothing to compare against.
   */
  riskClassChangedSinceIssue: boolean;
  /** Literal false. A recorded decision is still not authority. */
  grantsAuthority: false;
  statement: string;
}

/**
 * Derive one decision's record. PURE: no I/O, no clock, no randomness.
 *
 * `state` is derived, in this order, from facts that cannot contradict each
 * other: a decision a later decision escalated away from is `escalated_away`;
 * one with a recorded outcome is `settled`; otherwise it is `issued`.
 */
export function deriveDecisionRecord(
  row: DecisionRow,
  input: {
    outcomes: readonly DecisionOutcomeRow[];
    escalations: readonly DecisionRow[];
    /**
     * CANONICAL truth about the decision's task, re-read at derivation time.
     *
     * Three columns on an append-only table were previously read back verbatim
     * and published as canonical facts, and a raw appender could therefore
     * choose all three (Wave 5 review, Medium finding B-3):
     *
     *  - `bound_provider` is presented on the Founder route as "the provider
     *    the canonical payload binds", which is a claim about `op_tasks` and
     *    not about this row;
     *  - the `riskClass` half of `characteristics` drives the recomputed floor
     *    that `decisionIsProvablyAvoidable` calls a defence against forgery —
     *    the recomputation relocated the forgery from `floor_tier` to
     *    `characteristics`, it did not close it;
     *  - `required_review_tier` NULL made `satisfiesReviewRequirement` true and
     *    dropped the row out of the review-required count.
     *
     * When this resolver is supplied — the facade always supplies it — all
     * three are taken from `op_tasks` / `op_capabilities` instead, and the
     * review requirement is the STRONGER of the stored one and the one the
     * canonical risk class imposes. On an honestly recorded row the two agree,
     * so nothing changes; on a forged one the canonical answer wins. It is
     * optional only so the pure derivation stays exercisable without a
     * database.
     */
    canonical?: {
      boundProvider: (taskId: string) => string | null;
      /** Fail-closed: `founder_gate` for a task or capability that cannot be read. */
      riskClass: (taskId: string) => RiskClass;
    };
  },
): DecisionRecord {
  const outcome =
    [...input.outcomes].filter((entry) => entry.decisionId === row.id).sort((a, b) => a.seq - b.seq).pop() ??
    null;
  const escalatedAway =
    [...input.escalations].filter((entry) => entry.escalatedFrom === row.id).sort((a, b) => a.seq - b.seq)[0] ??
    null;
  const state: DecisionState = escalatedAway ? 'escalated_away' : outcome ? 'settled' : 'issued';
  const canonical = input.canonical ?? null;
  const boundProvider = canonical ? canonical.boundProvider(row.taskId) : row.boundProvider;
  // The canonical risk class is read FIRST and UNCONDITIONALLY, so the review
  // requirement below does not depend on whether the stored characteristics
  // happened to parse (Wave 5 correction round three, Medium B4).
  //
  // It used to be read only inside the `row.characteristics` branch, and
  // `rowToDecision` reads an unparseable `characteristics` column as null. So
  // forging `required_review_tier` alone was correctly caught by the max below,
  // and forging BOTH columns escaped completely: `requiredReviewTier` came back
  // null, `satisfiesReviewRequirement` true, and the row dropped out of
  // `reviewRequired` in analytics altogether. `canonical.riskClass(taskId)` was
  // in scope and simply unused on that branch, and it fails closed to
  // `founder_gate` for a task or capability it cannot read.
  const canonicalRiskClass = canonical ? canonical.riskClass(row.taskId) : null;
  const characteristics =
    canonical && row.characteristics
      ? { ...row.characteristics, riskClass: canonicalRiskClass! }
      : row.characteristics;
  // The stronger of the two, so a forged NULL cannot drop the requirement — and
  // neither can a forged pair.
  const canonicalReview = canonicalRiskClass ? REVIEW_REQUIREMENT[canonicalRiskClass] : null;
  const requiredReviewTier = maxRequiredReviewTier(row.requiredReviewTier, canonicalReview);
  // The floor is SERVED from the same recomputation the avoidability flag is
  // computed from (Wave 5 correction round seven, Medium NEW-6). Two published
  // numbers over one row used to be computed two different ways: this record
  // carried the STORED `floor_tier` while `decisionIsProvablyAvoidable`
  // recomputed the floor from the CURRENT canonical risk class. A Founder
  // registry upsert therefore flipped `provablyAvoidable` 1 → 0 and left the
  // served record reporting `floorTier: deterministic_local` beside
  // `requiredReviewTier: critical_review` — which cannot both be true, because
  // the review requirement is one of the terms `computeRoutingProposal` takes
  // the floor's `max` over. One computation now answers both, the stored value
  // is carried as `floorTierAsRecorded` so no history is lost, and the fact
  // that canonical truth moved is reported rather than absorbed.
  const proposedFloor: StoredIntelligenceTier = characteristics
    ? computeRoutingProposal({
        characteristics,
        permittedTiers: INTELLIGENCE_TIERS,
        budgetDecision: 'within_ceiling',
      }).floorTier
    : row.floorTier;
  // And the floor's `max` is taken over the tier this record actually SERVES,
  // not over the canonical one alone (Wave 5 correction round nine, Low 3).
  //
  // The round-seven fix above made one computation answer both numbers, but it
  // left one way for them to contradict each other in public. `characteristics`
  // above carries only the CANONICAL risk class, so `computeRoutingProposal`
  // folds in `REVIEW_REQUIREMENT[canonical]` and nothing else — while the
  // `requiredReviewTier` this record publishes is the MAX of the stored column
  // and the canonical requirement, deliberately, so a forged NULL cannot drop
  // the requirement. A raw `UPDATE ... SET required_review_tier` ABOVE the
  // canonical class therefore produced exactly the pair the comment above says
  // cannot both be true: `floorTier: deterministic_local` beside
  // `requiredReviewTier: critical_review`.
  //
  // It is fail-closed already — `satisfiesReviewRequirement` reads false and
  // the decision drops out of `provablyAvoidable` — so no spend claim rested on
  // it. What it published was an incoherent pair, and the fix is to close the
  // loop the sentence already asserts: whatever review tier is SERVED is one of
  // the terms the served floor is the max over.
  //
  // An unrecognized stored floor is left exactly as it is rather than raised to
  // a recognized tier: `decisionIsProvablyAvoidable` fails closed on a floor
  // outside the vocabulary, and replacing it here would hand that path a
  // recognized value it never earned.
  const recomputedFloor: StoredIntelligenceTier =
    requiredReviewTier != null && isIntelligenceTier(proposedFloor)
      ? maxTier(proposedFloor, requiredReviewTier)
      : proposedFloor;
  return {
    ...row,
    boundProvider,
    characteristics,
    requiredReviewTier,
    floorTier: recomputedFloor,
    floorTierAsRecorded: row.floorTier,
    riskClassChangedSinceIssue:
      canonicalRiskClass != null &&
      row.characteristics != null &&
      row.characteristics.riskClass !== canonicalRiskClass,
    state,
    result: outcome?.result ?? 'result_unknown',
    reviewedByTier: outcome?.reviewedByTier ?? null,
    escalatedAwayTo: escalatedAway?.id ?? null,
    satisfiesReviewRequirement: proposalSatisfiesReviewRequirement({
      tier: isIntelligenceTier(row.tier) ? row.tier : null,
      requiredReviewTier,
    }),
    grantsAuthority: false,
    statement: INTELLIGENCE_ROUTING_STATEMENT,
  };
}

/** The stronger of two review requirements; null only when both are null. */
function maxRequiredReviewTier(
  stored: IntelligenceTier | null,
  canonical: IntelligenceTier | null,
): IntelligenceTier | null {
  if (stored == null) return canonical;
  if (canonical == null) return stored;
  return tierRank(canonical) > tierRank(stored) ? canonical : stored;
}

/** One recorded cost entry, as a reader sees it. */
export interface CostEntryRecord extends CostEntryRow {
  statement: string;
}

export function costEntryToRecord(row: CostEntryRow): CostEntryRecord {
  return { ...row, statement: COST_LEDGER_STATEMENT };
}

export function budgetRowToRecord(row: BudgetRow): BudgetRecord {
  return {
    id: row.id,
    seq: row.seq,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    window: row.window,
    ceilingMinorUnits: row.ceilingMinorUnits,
    currency: row.currency,
    permittedTiers: [...row.permittedTiers],
    version: row.version,
    setAt: row.setAt,
    setBy: row.setBy,
    note: row.note,
    statement: BUDGET_POLICY_STATEMENT,
  };
}

/* ------------------------------------------------------------------ */
/* Analytics — counts of rows and sums of recorded amounts only        */
/* ------------------------------------------------------------------ */

/**
 * Spend against ONE identity in ONE currency. An array element rather than a
 * map entry, deliberately: the identity is a VALUE here, so a provider or
 * model id can never become an object key that a later reader treats as
 * vocabulary. (The unauthenticated snapshot carries none of this at all.)
 */
export interface SpendByIdentity {
  id: string;
  /**
   * The observed currency, or NULL when this group's entries carry no currency
   * at all — which is exactly when they carry no amount either
   * (`normalizeCostFact` and `readStoredCostFact` lock the two together in both
   * directions). Never a synthetic code: `"unknown"` is not a currency, and a
   * reader scanning currency codes must not find one HQ invented.
   */
  currency: string | null;
  /**
   * The sum of the amounts HQ actually knows, or NULL when it knows none.
   *
   * Law 8 (Wave 5 review, LOW finding 6). This used to render `0` under a
   * synthetic `currency: "unknown"`. Nothing was fabricated — the `0` was
   * arithmetically true and `unknownAmountEntries` stood beside it — but a `0`
   * sitting next to an identity HQ has no amount for is precisely the shape a
   * reader misreads as "this cost nothing", and that is the reading this phase
   * exists to prevent. An unknown amount is `null`, here as everywhere else.
   */
  knownAmountMinorUnits: number | null;
  entries: number;
  unknownAmountEntries: number;
}

export interface EscalationRatio {
  /** Decisions that were recorded as an escalation of an earlier one. */
  numerator: number;
  /** Decisions recorded at all. */
  denominator: number;
  statement: string;
}

export interface TierResultCounts {
  tier: StoredIntelligenceTier;
  decisions: number;
  qualityMet: number;
  qualityNotMet: number;
  resultUnknown: number;
  reviewRequired: number;
  reviewRequirementSatisfied: number;
}

export interface IntelligenceAnalyticsView {
  decisions: {
    total: number;
    byTier: Record<string, number>;
    byState: Record<string, number>;
    byResult: Record<string, number>;
    escalation: EscalationRatio;
    byTierResult: TierResultCounts[];
  };
  cost: {
    entries: number;
    byProvenance: Record<string, number>;
    unknownAmountEntries: number;
    byCurrency: { currency: string; knownAmountMinorUnits: number; entries: number }[];
    byProvider: SpendByIdentity[];
    byModel: SpendByIdentity[];
    byMission: SpendByIdentity[];
    byProject: SpendByIdentity[];
  };
  provablyAvoidable: {
    decisionIds: string[];
    total: number;
    /**
     * How many decisions were derived against a canonical risk class DIFFERENT
     * from the one stored on the row (Wave 5 correction round seven, Medium
     * NEW-6).
     *
     * `provablyAvoidable` is recomputed from the CURRENT canonical risk class,
     * so a Founder registry upsert can flip a decision out of (or into) the set
     * after it was issued. That is the honest answer — the floor really did
     * move — but a number that changes retroactively with nothing on the view
     * to say so is a number that misleads. This is the count that says so.
     */
    riskClassChangedSinceIssue: number;
    statement: string;
  };
  observations: {
    total: number;
    withKnownUnitCost: number;
    withUnknownUnitCost: number;
    local: number;
    cloud: number;
    byAvailability: Record<string, number>;
  };
  statement: string;
}

/**
 * The extra bucket every closed-vocabulary map carries.
 *
 * Imported from Phase 13 rather than spelled again: it is the same bucket,
 * meaning the same thing, and a second constant that drifted would let two
 * unauthenticated maps disagree about what "not one of these" is called.
 */

function zeroed<T extends string>(members: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = { [UNRECOGNIZED_BUCKET]: 0 };
  for (const member of members) counts[member] = 0;
  return counts;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Is this decision PROVABLY avoidable from recorded data alone?
 *
 * All four, and no fewer:
 *  - it was issued strictly above the floor the policy itself computed for the
 *    characteristics recorded ON the decision;
 *  - it was not an escalation (an escalated decision is above the floor BY
 *    DESIGN, and counting it would be counting the mechanism as a mistake);
 *  - no reviewer tier was required of it;
 *  - its recorded result is `quality_met` — the work actually succeeded, so
 *    the stronger tier bought nothing that was needed.
 *
 * It is a statement about HQ's OWN policy, not a claim about what a cheaper
 * model would have produced. HQ never ran one, so it cannot know that, and
 * `AVOIDABLE_SPEND_STATEMENT` says so on the view.
 */
export function decisionIsProvablyAvoidable(decision: DecisionRecord): boolean {
  if (!isIntelligenceTier(decision.tier)) return false;
  if (decision.escalatedFrom != null) return false;
  if (decision.requiredReviewTier != null) return false;
  if (decision.result !== 'quality_met') return false;
  const characteristics = decision.characteristics;
  if (!characteristics) return false;
  // Recompute the floor rather than trusting the stored `floor_tier` column.
  //
  // Stated exactly, because the old comment here overclaimed and the doc
  // repeated it (Wave 5 review, Medium finding B-3): recomputing from
  // `decision.characteristics` RELOCATES the forgery, it does not close it —
  // `characteristics` is a stored column on the same append-only table, so a
  // raw appender that could have lied in `floor_tier` can lie there instead.
  // What actually closes it is upstream: `deriveDecisionRecord` re-derives the
  // `riskClass` half of `characteristics` from `op_tasks`/`op_capabilities`, so
  // the floor computed here rests on canonical truth for the term that carries
  // the risk. The remaining terms (complexity, context size, work kind) are
  // descriptions of the work that HQ has no canonical source for and does not
  // pretend to — a forged row can still understate those, which is recorded
  // debt rather than a closed hole.
  //
  // **ONE spelling of the recomputation, not two** (Wave 5 correction round
  // seven, Medium NEW-6). This function used to recompute the floor here while
  // `deriveDecisionRecord` served the STORED `floor_tier`, so the two published
  // numbers over one row were computed different ways and could contradict each
  // other in public. `deriveDecisionRecord` now performs the recomputation and
  // this reads its result, so the flag and the served floor cannot diverge
  // again — and a record built without characteristics returns above, before
  // this line.
  // Fail closed on a floor outside the vocabulary: a record built without the
  // recomputation above cannot be pronounced avoidable.
  if (!isIntelligenceTier(decision.floorTier)) return false;
  return tierRank(decision.tier) > tierRank(decision.floorTier);
}

/**
 * The bucket a recorded amount lands in when HQ has no canonical statement
 * about who it belongs to.
 *
 * Distinct from `UNRECOGNIZED_BUCKET`, which means "a value outside a closed
 * vocabulary". This one means "a real value HQ cannot attribute", and it exists
 * because the alternative was to publish the CALLER's claim as a measurement
 * (Wave 5 correction round four, Medium M6): a claim-holding worker on an
 * unbound task recorded `providerId: 'openai'` and
 * `byProvider = [{"id":"openai","knownAmountMinorUnits":999999}]` went out on
 * the Founder route for work HQ has no statement ever ran there — while the
 * ceiling path, which had already stopped trusting that column, correctly read
 * `observed 0`. Two surfaces over one ledger disagreeing is exactly the defect;
 * this is the fold that makes them agree.
 */
export const UNATTRIBUTED_BUCKET = 'unattributed';

function foldSpendMany(
  rows: readonly CostEntryRow[],
  keysOf: (row: CostEntryRow) => readonly string[],
): SpendByIdentity[] {
  // An entry linked to two missions counts IN FULL under each, and that is
  // deliberate (Wave 5 correction round four, Medium M5). HQ has no basis on
  // which to split a recorded amount between them, so it does not invent one —
  // and it is the same reading the ceilings take, where each mission's ceiling
  // measures the whole spend of the work it is linked to.
  const expanded: CostEntryRow[] = [];
  const keys: (string | null)[] = [];
  for (const row of rows) {
    for (const key of new Set(keysOf(row))) {
      expanded.push(row);
      keys.push(key);
    }
  }
  let index = -1;
  return foldSpend(expanded, () => {
    index += 1;
    return keys[index] ?? null;
  });
}

function foldSpend(
  rows: readonly CostEntryRow[],
  keyOf: (row: CostEntryRow) => string | null,
): SpendByIdentity[] {
  const byKey = new Map<string, SpendByIdentity>();
  for (const row of rows) {
    const id = keyOf(row);
    if (id == null) continue;
    // Currency is part of the grouping key, because HQ never converts between
    // currencies and a sum across two of them would be a fabricated number. A
    // null currency is its OWN group and STAYS null — the group of entries HQ
    // has no amount for. It is not labelled `"unknown"`, because that would put
    // an invented code where a reader expects an observed one.
    const currency = row.fact.currency;
    // U+001F UNIT SEPARATOR, not a raw NUL and not a space. A literal 0x00 in a
    // source file makes it BINARY to grep, git grep and ripgrep — they report
    // "binary file matches" and skip the content — so the file becomes
    // invisible to the repository's own text tooling and to a reviewer's
    // honesty scan. A SPACE would be worse still: the identities folded here are
    // provider and model strings that may legitimately contain one, so
    // `"a b"` with no currency and `"a"` with currency `"b"` would collapse into
    // one bogus group. U+001F is a character neither an identity nor a currency
    // code can contain.
    const composite = `${id}\u001f${currency ?? ''}`;
    const entry = byKey.get(composite) ?? {
      id,
      currency,
      // Null until a KNOWN amount is folded in. See the field's own note: a `0`
      // beside an identity HQ has no amount for is the reading this phase
      // exists to prevent.
      knownAmountMinorUnits: null,
      entries: 0,
      unknownAmountEntries: 0,
    };
    entry.entries += 1;
    if (row.fact.amountMinorUnits == null) entry.unknownAmountEntries += 1;
    else entry.knownAmountMinorUnits = (entry.knownAmountMinorUnits ?? 0) + row.fact.amountMinorUnits;
    byKey.set(composite, entry);
  }
  return [...byKey.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || (a.currency ?? '').localeCompare(b.currency ?? ''),
  );
}

/** Fold the ledgers into truthful analytics. Every number is observed. */
export function summarizeIntelligenceAnalytics(input: {
  decisions: readonly DecisionRecord[];
  costs: readonly CostEntryRow[];
  observations: readonly ModelObservationRow[];
  /**
   * CANONICAL membership for a cost entry's task — every mission it is linked
   * to and every project those missions belong to.
   *
   * REQUIRED, not optional, and that is the point (Wave 5 correction round
   * four, Medium M5). `byMission` and `byProject` used to fold the entry's own
   * stored column, which holds ONE of the N missions a task may be linked to
   * (`canonicalScopes.missionIds[0] ?? null`) — so which mission a spend was
   * attributed to flipped on uuid sort order. Executed over six runs with one
   * task linked to two missions and one 5000 spend: four runs attributed 100%
   * to mission A and 0 to B; two runs the reverse. The phase document claimed
   * the stored columns "measure nothing"; they measured THIS, and this is
   * served on `/api/hq/control/intelligence`.
   *
   * An absent derivation would silently produce empty attribution, which is the
   * same class of defect this wave has closed twice already (a missing
   * enforcement input reading clean), so there is no default.
   */
  canonicalScopesOf: (taskId: string) => { missionIds: readonly string[]; projectIds: readonly string[] };
}): IntelligenceAnalyticsView {
  const byTier = zeroed(INTELLIGENCE_TIERS);
  const byState = zeroed(DECISION_STATES);
  const byResult = zeroed(DECISION_RESULTS);
  const perTier = new Map<StoredIntelligenceTier, TierResultCounts>();
  let escalated = 0;
  const avoidable: string[] = [];
  let riskClassChanged = 0;
  for (const decision of input.decisions) {
    // The CHECKED value is the key, never the stored string.
    const tierKey = isIntelligenceTier(decision.tier) ? decision.tier : UNRECOGNIZED_BUCKET;
    bump(byTier, tierKey);
    bump(byState, isDecisionState(decision.state) ? decision.state : UNRECOGNIZED_BUCKET);
    bump(byResult, isDecisionResult(decision.result) ? decision.result : UNRECOGNIZED_BUCKET);
    if (decision.escalatedFrom != null) escalated += 1;
    if (decisionIsProvablyAvoidable(decision)) avoidable.push(decision.id);
    if (decision.riskClassChangedSinceIssue) riskClassChanged += 1;
    const bucketKey: StoredIntelligenceTier = isIntelligenceTier(decision.tier)
      ? decision.tier
      : STORED_TIER_UNRECOGNIZED;
    const bucket =
      perTier.get(bucketKey) ??
      ({
        tier: bucketKey,
        decisions: 0,
        qualityMet: 0,
        qualityNotMet: 0,
        resultUnknown: 0,
        reviewRequired: 0,
        reviewRequirementSatisfied: 0,
      } satisfies TierResultCounts);
    bucket.decisions += 1;
    if (decision.result === 'quality_met') bucket.qualityMet += 1;
    else if (decision.result === 'quality_not_met') bucket.qualityNotMet += 1;
    else bucket.resultUnknown += 1;
    if (decision.requiredReviewTier != null) {
      bucket.reviewRequired += 1;
      if (decision.satisfiesReviewRequirement) bucket.reviewRequirementSatisfied += 1;
    }
    perTier.set(bucketKey, bucket);
  }

  // As in `summarizeIntelligence`: a stored provenance is already vocabulary by
  // the time it reaches here (`readStoredCostFact` coerces), so this map's
  // `unrecognized` bucket cannot be reached through the live path and is kept
  // for the shape and for a caller passing a raw fact — not for a defence
  // against anything the ledger can hold.
  const byProvenance = zeroed(COST_PROVENANCES);
  let unknownAmountEntries = 0;
  const currencyTotals = new Map<string, { currency: string; knownAmountMinorUnits: number; entries: number }>();
  for (const entry of input.costs) {
    bump(byProvenance, isCostProvenance(entry.fact.provenance) ? entry.fact.provenance : UNRECOGNIZED_BUCKET);
    if (entry.fact.amountMinorUnits == null || entry.fact.currency == null) {
      unknownAmountEntries += 1;
      continue;
    }
    const bucket =
      currencyTotals.get(entry.fact.currency) ??
      { currency: entry.fact.currency, knownAmountMinorUnits: 0, entries: 0 };
    bucket.knownAmountMinorUnits += entry.fact.amountMinorUnits;
    bucket.entries += 1;
    currencyTotals.set(entry.fact.currency, bucket);
  }

  const byAvailability = zeroed(MODEL_AVAILABILITY_STATES);
  let withKnownUnitCost = 0;
  let local = 0;
  let cloud = 0;
  for (const observation of input.observations) {
    bump(
      byAvailability,
      isModelAvailability(observation.availability) ? observation.availability : UNRECOGNIZED_BUCKET,
    );
    if (observation.unitCost.state === 'known') withKnownUnitCost += 1;
    if (observation.locality === 'local') local += 1;
    else if (observation.locality === 'cloud') cloud += 1;
  }

  return {
    decisions: {
      total: input.decisions.length,
      byTier,
      byState,
      byResult,
      escalation: {
        numerator: escalated,
        denominator: input.decisions.length,
        statement:
          'An exact numerator over an exact denominator. HQ publishes no percentage here: over a small ' +
          'denominator a percentage reads as a measurement, and this is a count of recorded rows.',
      },
      byTierResult: [...perTier.values()].sort((a, b) => String(a.tier).localeCompare(String(b.tier))),
    },
    cost: {
      entries: input.costs.length,
      byProvenance,
      unknownAmountEntries,
      byCurrency: [...currencyTotals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      // The provider HQ can VOUCH for, never the one the caller declared. An
      // entry whose task was not canonically bound is a real amount HQ cannot
      // attribute, and it is reported as exactly that rather than credited to
      // whoever the worker named (Medium M6).
      byProvider: foldSpend(input.costs, (row) =>
        row.providerBound ? row.providerId : UNATTRIBUTED_BUCKET,
      ),
      // `model` stays on the entry's own column, and that is the same stated
      // limitation `#entriesForScope` carries: nothing in canonical truth binds
      // a task to a MODEL, so HQ has no derivation to prefer.
      byModel: foldSpend(input.costs, (row) => row.modelId),
      // CANONICAL membership UNION the attribution HQ recorded on the row, for
      // the same reason the ceilings take that union: the derivation answers
      // "every mission this task belongs to NOW", and the recorded column
      // answers "the mission this spend was filed under", which no later
      // relinking can take away (Medium M5, and High H2's observation half).
      //
      // The recorded half is `missionIds`/`projectIds` — EVERY scope HQ derived
      // at record time — and not the single `missionId`/`projectId` column,
      // which holds one of N and made the union complete only for the
      // first-sorting scope (Wave 5 correction round six, High 3). With the
      // single column, moving the other mission to a fresh project credited the
      // whole 5000 to a project that had spent nothing.
      byMission: foldSpendMany(input.costs, (row) => [
        ...input.canonicalScopesOf(row.taskId).missionIds,
        ...row.missionIds,
      ]),
      byProject: foldSpendMany(input.costs, (row) => [
        ...input.canonicalScopesOf(row.taskId).projectIds,
        ...row.projectIds,
      ]),
    },
    provablyAvoidable: {
      decisionIds: avoidable,
      total: avoidable.length,
      riskClassChangedSinceIssue: riskClassChanged,
      statement: AVOIDABLE_SPEND_STATEMENT,
    },
    observations: {
      total: input.observations.length,
      withKnownUnitCost,
      withUnknownUnitCost: input.observations.length - withKnownUnitCost,
      local,
      cloud,
      byAvailability,
    },
    statement: INTELLIGENCE_ANALYTICS_STATEMENT,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshot summary — closed-vocabulary counts, and NO amount at all   */
/* ------------------------------------------------------------------ */

export const INTELLIGENCE_SNAPSHOT_NOTE =
  'Counts over closed vocabularies only. NO amount, currency, ceiling, provider id, model id, task/mission/' +
  'project id, decision id, label, basis or note crosses to an unauthenticated reader — the section is ' +
  'incapable of carrying one. A decision count is a count of RECORDS: a routing decision selects no ' +
  'provider, spends nothing and grants nothing, and no path in this phase can activate a paid service. ' +
  'unknownAmountEntries counts costs HQ genuinely does not know; they are never rendered as zero.';

export interface IntelligenceSnapshotView {
  storePresent: boolean;
  observations: number;
  observationsWithKnownUnitCost: number;
  observationsWithUnknownUnitCost: number;
  decisions: number;
  byTier: Record<string, number>;
  byState: Record<string, number>;
  byResult: Record<string, number>;
  escalations: number;
  costEntries: number;
  byCostProvenance: Record<string, number>;
  unknownAmountEntries: number;
  budgetsRecorded: number;
  /** Whether ANY permitted-tier policy exists. A boolean, never the policy. */
  tierPolicyRecorded: boolean;
  note: string;
}

export function emptyIntelligenceSnapshot(storePresent: boolean): IntelligenceSnapshotView {
  return {
    storePresent,
    observations: 0,
    observationsWithKnownUnitCost: 0,
    observationsWithUnknownUnitCost: 0,
    decisions: 0,
    byTier: zeroed(INTELLIGENCE_TIERS),
    byState: zeroed(DECISION_STATES),
    byResult: zeroed(DECISION_RESULTS),
    escalations: 0,
    costEntries: 0,
    byCostProvenance: zeroed(COST_PROVENANCES),
    unknownAmountEntries: 0,
    budgetsRecorded: 0,
    tierPolicyRecorded: false,
    note: INTELLIGENCE_SNAPSHOT_NOTE,
  };
}

/**
 * Fold the ledgers into the unauthenticated section.
 *
 * The four MAPS are closed BY CONSTRUCTION, not merely by intent — the Phase
 * 12 lesson, applied again. Every increment passes a membership check and the
 * CHECKED value is the key, so a stored tier, state or result that is free text
 * lands in `unrecognized` and its TEXT never becomes a key.
 *
 * **Where `unrecognized` really catches something, stated exactly** (Wave 5
 * review, LOW finding 7). For the tier, state and result it is reachable IN
 * PRODUCTION: those are read off the stored column as-is, so a raw append
 * carrying `SUPER SECRET TIER NAME` lands there. For the cost PROVENANCE it is
 * reachable only at this function's own boundary — every fact HQ actually
 * hands it came through `readStoredCostFact`, which has ALREADY coerced
 * anything outside `COST_PROVENANCES` to `unknown`, so no stored row can reach
 * `UNRECOGNIZED_BUCKET` through the live path. The check and the bucket are
 * kept, and described as what they are rather than as a live defence: this
 * fold has to stay closed by construction independently of what its caller
 * happens to do today, and a `zeroed()` map publishes the same key set whether
 * the bucket is ever incremented or not. Both readings fail closed, so nothing
 * is at risk either way.
 *
 * The same class of finding was recorded in Wave 4 as
 * `byLifecycle.unrecognized` and deliberately LEFT open; this pass corrects the
 * wording here and does not touch that one, so the two now differ in wording
 * while agreeing in behaviour.
 *
 * No amount crosses at all. That is not a redaction, it is the shape: this
 * view has no numeric money field, so there is nothing to leak and nothing a
 * reader could mistake for a spend figure.
 */
export function summarizeIntelligence(input: {
  storePresent: boolean;
  decisions: readonly DecisionRecord[];
  costs: readonly CostEntryRow[];
  observations: readonly ModelObservationRow[];
  budgets: readonly BudgetRow[];
}): IntelligenceSnapshotView {
  const byTier = zeroed(INTELLIGENCE_TIERS);
  const byState = zeroed(DECISION_STATES);
  const byResult = zeroed(DECISION_RESULTS);
  let escalations = 0;
  for (const decision of input.decisions) {
    byTier[isIntelligenceTier(decision.tier) ? decision.tier : UNRECOGNIZED_BUCKET] += 1;
    byState[isDecisionState(decision.state) ? decision.state : UNRECOGNIZED_BUCKET] += 1;
    byResult[isDecisionResult(decision.result) ? decision.result : UNRECOGNIZED_BUCKET] += 1;
    if (decision.escalatedFrom != null) escalations += 1;
  }
  const byCostProvenance = zeroed(COST_PROVENANCES);
  let unknownAmountEntries = 0;
  for (const entry of input.costs) {
    // Belt-and-braces at this boundary, not a live defence behind it: every
    // `entry.fact` HQ hands in came through `readStoredCostFact`, which has
    // already coerced an out-of-vocabulary provenance to `unknown`, so no
    // STORED row reaches `UNRECOGNIZED_BUCKET` here. Kept so the fold stays
    // closed by construction if that reader ever changes, and so a caller
    // passing a raw fact is bucketed rather than trusted. See the note above.
    byCostProvenance[isCostProvenance(entry.fact.provenance) ? entry.fact.provenance : UNRECOGNIZED_BUCKET] += 1;
    if (entry.fact.amountMinorUnits == null) unknownAmountEntries += 1;
  }
  const withKnownUnitCost = input.observations.filter(
    (observation) => observation.unitCost.state === 'known',
  ).length;
  return {
    storePresent: input.storePresent,
    observations: input.observations.length,
    observationsWithKnownUnitCost: withKnownUnitCost,
    observationsWithUnknownUnitCost: input.observations.length - withKnownUnitCost,
    decisions: input.decisions.length,
    byTier,
    byState,
    byResult,
    escalations,
    costEntries: input.costs.length,
    byCostProvenance,
    unknownAmountEntries,
    budgetsRecorded: input.budgets.length,
    tierPolicyRecorded: input.budgets.some((budget) => budget.permittedTiers.length > 0),
    note: INTELLIGENCE_SNAPSHOT_NOTE,
  };
}

/* ------------------------------------------------------------------ */
/* The posture the Founder-gated route reads                           */
/* ------------------------------------------------------------------ */

export interface IntelligencePostureView {
  storePresent: boolean;
  /** The tier set in force when no budget names one. Free local, alone. */
  defaultPermittedTiers: readonly IntelligenceTier[];
  observations: number;
  decisions: number;
  costEntries: number;
  budgets: number;
  routingStatement: string;
  costStatement: string;
  budgetStatement: string;
  escalationStatement: string;
  latencyStatement: string;
  /** Literal false, published so a console can never draw a spend button. */
  canActivatePaidProvider: false;
  canSpend: false;
}
