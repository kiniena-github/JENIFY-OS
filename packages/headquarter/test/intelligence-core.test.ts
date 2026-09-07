/**
 * Phase 14 — the PURE core: the vocabularies, the cost-fact lock, the routing
 * policy, the escalation rule, the budget evaluation and the analytics fold.
 *
 * Everything exercised here is a total function over data: no database, no
 * clock, no process. That is deliberate — the rules the phase turns on ("HQ
 * never invents a price", "a ceiling never grants", "a cheaper tier cannot
 * bypass a reviewer tier") are properties of the policy, and a property that
 * can only be demonstrated through a facade is a property nobody can read.
 */

import { describe, expect, it } from 'vitest';
import {
  AVOIDABLE_SPEND_STATEMENT,
  BUDGET_DECISIONS,
  COMPLEXITY_FLOOR,
  CONTEXT_FLOOR,
  COST_PROVENANCES,
  COST_UNIT_KINDS,
  DECISION_RESULTS,
  DECISION_STATES,
  DEFAULT_PERMITTED_TIERS,
  ESCALATION_TRIGGERS,
  INTELLIGENCE_TIERS,
  MODEL_AVAILABILITY_STATES,
  REVIEW_REQUIREMENT,
  RISK_FLOOR,
  WORK_KIND_FLOOR,
  computeRoutingProposal,
  decisionIsProvablyAvoidable,
  deriveDecisionRecord,
  deriveEscalation,
  emptyIntelligenceSnapshot,
  evaluateBudget,
  isIntelligenceTier,
  latestBudgetFor,
  MAX_COST_BASIS_LENGTH,
  MAX_COST_MINOR_UNITS,
  normalizeCostFact,
  proposalSatisfiesReviewRequirement,
  readStoredCostFact,
  riskClassForRouting,
  summarizeIntelligence,
  summarizeIntelligenceAnalytics,
  tierRank,
  type BudgetRow,
  type CostEntryRow,
  type DecisionRecord,
  type DecisionRow,
  type IntelligenceTier,
  type ModelObservationRow,
  type TaskCharacteristics,
} from '../src/application/intelligence-command.js';
import { PROVIDER_HEALTH_STATES } from '../src/providers/contracts.js';
import { RISK_CLASSES } from '../src/operator/capabilities.js';
import { RUN_STATES } from '../src/application/reliability-command.js';
import { ACTIVITY_STATUSES } from '../src/contracts/events.js';
import { MISSION_STATUSES } from '../src/contracts/mission.js';
import { ACTION_STATES } from '../src/application/action-gateway.js';
import { PRODUCT_LIFECYCLE_STATES } from '../src/application/product-command.js';
import { PROVIDERS } from '../src/routing/providers.js';
import { KNOWN_PROVIDERS } from '../src/providers/known.js';

const READ_ONLY_WORK: TaskCharacteristics = {
  complexity: 'trivial',
  contextSize: 'small',
  workKind: 'classification',
  riskClass: 'read_only',
  latency: 'unspecified',
  privacy: 'unrestricted',
};

const SIDE_EFFECT_WORK: TaskCharacteristics = { ...READ_ONLY_WORK, riskClass: 'external_side_effect' };

function decisionRow(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    seq: 1,
    id: 'dec-1',
    taskId: 'task-1',
    missionId: null,
    projectId: null,
    tier: 'standard',
    floorTier: 'deterministic_local',
    requiredReviewTier: null,
    escalatedFrom: null,
    escalationTrigger: null,
    boundProvider: null,
    characteristics: READ_ONLY_WORK,
    permittedTiers: [...INTELLIGENCE_TIERS],
    budgetDecision: 'within_ceiling',
    label: 'classify an inbox',
    issuedAt: '2026-01-01T00:00:00.000Z',
    issuedBy: 'claude',
    processId: 'p1',
    ...over,
  };
}

function record(over: Partial<DecisionRow> = {}): DecisionRecord {
  return deriveDecisionRecord(decisionRow(over), { outcomes: [], escalations: [] });
}

function costRow(over: Partial<CostEntryRow> = {}): CostEntryRow {
  return {
    seq: 1,
    id: 'cost-1',
    taskId: 'task-1',
    missionId: null,
    projectId: null,
    decisionId: null,
    providerId: 'anthropic',
    modelId: null,
    fact: {
      provenance: 'billed',
      amountMinorUnits: 500,
      currency: 'USD',
      unitKind: 'requests',
      basis: null,
      state: 'known',
    },
    unitsObserved: null,
    occurredAt: '2026-01-01T00:00:00.000Z',
    recordedAt: '2026-01-01T00:00:00.000Z',
    recordedBy: 'claude',
    note: null,
    ...over,
  };
}

describe('the vocabularies are closed, categorical and disjoint from every other state vocabulary', () => {
  it('names no provider, vendor or model anywhere in the tier vocabulary', () => {
    // A tier is a POLICY CATEGORY. If a brand name were a tier, "value
    // engineering" would just be brand ranking with a different label.
    // `LOCAL`, `CUSTOM` and `JENIFY` are excluded because they are not vendor
    // brands: `local` is a LOCALITY word this phase legitimately uses (the
    // free local tier is named for where it runs, not for who sells it), and
    // the other two name a placeholder and this company. Every actual vendor
    // in both registries is checked.
    const generic = new Set(['LOCAL', 'CUSTOM', 'JENIFY']);
    const brands = [
      ...PROVIDERS.filter((id) => !generic.has(id)).map((id) => id.toLowerCase()),
      ...KNOWN_PROVIDERS.map((descriptor) => descriptor.providerId).filter(
        (id) => id !== 'local-custom' && id !== 'jenify-ai',
      ),
    ];
    expect(brands).toContain('anthropic');
    expect(brands).toContain('openai');
    for (const tier of INTELLIGENCE_TIERS) {
      for (const brand of brands) {
        expect(tier).not.toContain(brand);
      }
    }
  });

  it('keeps DECISION_STATES disjoint from all five other state vocabularies', () => {
    const others = new Set<string>([
      ...ACTIVITY_STATUSES,
      ...MISSION_STATUSES,
      ...ACTION_STATES,
      ...PRODUCT_LIFECYCLE_STATES,
      ...RUN_STATES,
    ]);
    for (const state of DECISION_STATES) expect(others.has(state)).toBe(false);
  });

  it('carries no number, percentage, confidence or ETA in any vocabulary member', () => {
    const members = [
      ...INTELLIGENCE_TIERS,
      ...DECISION_STATES,
      ...DECISION_RESULTS,
      ...BUDGET_DECISIONS,
      ...COST_PROVENANCES,
      ...COST_UNIT_KINDS,
      ...ESCALATION_TRIGGERS,
    ];
    for (const member of members) {
      expect(member).not.toMatch(/percent|confidence|probability|score|eta|estimate_of|rating/i);
    }
  });

  it('reuses the provider layer’s health vocabulary BY IDENTITY, not by a second copy', () => {
    // The Phase 13 lesson (RUN_RECONCILE_DECISIONS) applied again: a second
    // spelling of the same four answers is a thing that drifts.
    expect(MODEL_AVAILABILITY_STATES).toBe(PROVIDER_HEALTH_STATES);
  });

  it('orders the tiers cheapest-first, with the free local path at the bottom', () => {
    expect(INTELLIGENCE_TIERS[0]).toBe('deterministic_local');
    expect(tierRank('deterministic_local')).toBeLessThan(tierRank('low_cost'));
    expect(tierRank('low_cost')).toBeLessThan(tierRank('standard'));
    expect(tierRank('standard')).toBeLessThan(tierRank('high'));
    expect(tierRank('high')).toBeLessThan(tierRank('critical_review'));
  });

  it('defaults the permitted set to the FREE LOCAL TIER ALONE', () => {
    // Law 4 as a constant: a deployment with no Founder policy routes local or
    // asks, and never silently to a paid tier.
    expect([...DEFAULT_PERMITTED_TIERS]).toEqual(['deterministic_local']);
  });

  it('imposes a floor for every member of every characteristic vocabulary', () => {
    for (const riskClass of RISK_CLASSES) expect(isIntelligenceTier(RISK_FLOOR[riskClass])).toBe(true);
    for (const tier of Object.values(COMPLEXITY_FLOOR)) expect(isIntelligenceTier(tier)).toBe(true);
    for (const tier of Object.values(CONTEXT_FLOOR)) expect(isIntelligenceTier(tier)).toBe(true);
    for (const tier of Object.values(WORK_KIND_FLOOR)) expect(isIntelligenceTier(tier)).toBe(true);
  });

  /**
   * Wave 5 review, LOW finding 5. The fail-closed default for an unreadable
   * capability row was live, correct and UNPINNED — flipping it to
   * `'read_only'` passed all 3026 tests, because a foreign key makes the null
   * branch unreachable through the ordinary path. It is a total function over
   * one nullable input, so it is asserted directly rather than through a
   * contrived integration.
   */
  it('fails closed to the STRICTEST risk class when the capability cannot be read', () => {
    expect(riskClassForRouting(null)).toBe('founder_gate');
    expect(riskClassForRouting(undefined)).toBe('founder_gate');
    // ...and that default is genuinely the strictest: the highest floor there
    // is, plus a required reviewer tier. An unreadable capability is never the
    // cheap path.
    expect(RISK_FLOOR.founder_gate).toBe('critical_review');
    expect(REVIEW_REQUIREMENT.founder_gate).toBe('critical_review');
    for (const riskClass of RISK_CLASSES) {
      expect(tierRank(RISK_FLOOR.founder_gate)).toBeGreaterThanOrEqual(tierRank(RISK_FLOOR[riskClass]));
    }
    // A readable row is carried through verbatim, never widened or narrowed.
    for (const riskClass of RISK_CLASSES) {
      expect(riskClassForRouting({ riskClass })).toBe(riskClass);
    }
  });
});

describe('HQ never invents a price — the cost fact lock', () => {
  it('refuses an unknown provenance that carries an amount', () => {
    const refused = normalizeCostFact({
      provenance: 'unknown',
      amountMinorUnits: 100,
      currency: 'USD',
      unitKind: 'requests',
    });
    expect(refused).toEqual({ ok: false, refusal: 'unknown_provenance_carries_amount' });
  });

  it('refuses a known provenance that omits the amount', () => {
    const refused = normalizeCostFact({
      provenance: 'billed',
      amountMinorUnits: null,
      currency: 'USD',
      unitKind: 'requests',
    });
    expect(refused).toEqual({ ok: false, refusal: 'known_provenance_without_amount' });
  });

  it('refuses an ESTIMATE that does not name its basis', () => {
    const refused = normalizeCostFact({
      provenance: 'estimated',
      amountMinorUnits: 42,
      currency: 'USD',
      unitKind: 'tokens_total',
    });
    expect(refused).toEqual({ ok: false, refusal: 'estimate_without_basis' });
    const accepted = normalizeCostFact({
      provenance: 'estimated',
      amountMinorUnits: 42,
      currency: 'USD',
      unitKind: 'tokens_total',
      basis: 'published rate card read on 2026-01-01',
    });
    expect(accepted.ok).toBe(true);
  });

  it('reads an unknown cost as NULL and never as zero', () => {
    const fact = normalizeCostFact({
      provenance: 'unknown',
      amountMinorUnits: null,
      currency: null,
      unitKind: 'unknown',
    });
    expect(fact.ok).toBe(true);
    if (!fact.ok) return;
    expect(fact.fact.amountMinorUnits).toBeNull();
    expect(fact.fact.amountMinorUnits).not.toBe(0);
    expect(fact.fact.state).toBe('unknown');
  });

  it('refuses a malformed currency, a fractional amount and a negative one', () => {
    const base = { provenance: 'billed', unitKind: 'requests' as const };
    expect(normalizeCostFact({ ...base, amountMinorUnits: 10, currency: 'dollars' })).toEqual({
      ok: false,
      refusal: 'currency_malformed',
    });
    expect(normalizeCostFact({ ...base, amountMinorUnits: 1.5, currency: 'USD' })).toEqual({
      ok: false,
      refusal: 'amount_not_a_whole_number',
    });
    expect(normalizeCostFact({ ...base, amountMinorUnits: -1, currency: 'USD' })).toEqual({
      ok: false,
      refusal: 'amount_negative',
    });
  });

  it('reads a STORED row that lies about its own provenance back as unknown', () => {
    // The ledger is append-only, so an APPEND carrying a forged provenance is
    // representable. It must never read back as a number HQ can vouch for.
    expect(
      readStoredCostFact({
        provenance: 'audited_by_nobody',
        amountMinorUnits: 999999,
        currency: 'USD',
        unitKind: 'requests',
        basis: null,
      }),
    ).toMatchObject({ provenance: 'unknown', amountMinorUnits: null, state: 'unknown' });
    expect(
      readStoredCostFact({
        provenance: 'billed',
        amountMinorUnits: 500,
        currency: 'not-a-currency',
        unitKind: 'requests',
        basis: null,
      }),
    ).toMatchObject({ amountMinorUnits: null, state: 'unknown' });
  });

  /**
   * Wave 5 Medium 6. `readStoredCostFact` claimed parity with the writer and
   * did not have it: two of `normalizeCostFact`'s refusals had no counterpart,
   * so a row of either shape read back as a KNOWN amount and was folded into
   * `observedMinorUnits` — turning a scope that should read
   * `requires_founder_decision` into `within_ceiling`.
   */
  it('reads a STORED estimate with no basis back as unknown, exactly as the writer refuses one', () => {
    expect(
      normalizeCostFact({
        provenance: 'estimated',
        amountMinorUnits: 100_000,
        currency: 'USD',
        unitKind: 'requests',
      }),
    ).toEqual({ ok: false, refusal: 'estimate_without_basis' });
    expect(
      readStoredCostFact({
        provenance: 'estimated',
        amountMinorUnits: 100_000,
        currency: 'USD',
        unitKind: 'requests',
        basis: null,
      }),
    ).toMatchObject({ provenance: 'unknown', amountMinorUnits: null, state: 'unknown' });
    // A stored estimate that DOES name its basis still reads as known.
    expect(
      readStoredCostFact({
        provenance: 'estimated',
        amountMinorUnits: 100_000,
        currency: 'USD',
        unitKind: 'requests',
        basis: 'published rate card read on 2026-01-01',
      }),
    ).toMatchObject({ provenance: 'estimated', amountMinorUnits: 100_000, state: 'known' });
  });

  /**
   * Wave 5 LOW 7. The Medium 6 correction closed two of the writer's refusals
   * and then asserted, in a comment, that there had only ever been two. There
   * were four. These are the other two, both executed against the reader.
   */
  it('reads a STORED non-estimate that names a basis back as unknown', () => {
    expect(
      normalizeCostFact({
        provenance: 'billed',
        amountMinorUnits: 250,
        currency: 'USD',
        unitKind: 'requests',
        basis: 'a story about a number that did not need one',
      }),
    ).toEqual({ ok: false, refusal: 'basis_on_non_estimate' });
    const read = readStoredCostFact({
      provenance: 'billed',
      amountMinorUnits: 250,
      currency: 'USD',
      unitKind: 'requests',
      basis: 'a story about a number that did not need one',
    });
    expect(read).toMatchObject({ provenance: 'unknown', amountMinorUnits: null, state: 'unknown' });
    // And the basis itself does not travel out on the unknown fact.
    expect(read.basis).toBeNull();
  });

  it('reads a STORED basis beyond the writer’s length bound back as unknown', () => {
    const enormous = 'x'.repeat(500_000);
    expect(
      normalizeCostFact({
        provenance: 'estimated',
        amountMinorUnits: 100,
        currency: 'USD',
        unitKind: 'requests',
        basis: enormous,
      }),
    ).toEqual({ ok: false, refusal: 'basis_too_long' });
    const read = readStoredCostFact({
      provenance: 'estimated',
      amountMinorUnits: 100,
      currency: 'USD',
      unitKind: 'requests',
      basis: enormous,
    });
    expect(read).toMatchObject({ provenance: 'unknown', amountMinorUnits: null, state: 'unknown' });
    expect(read.basis).toBeNull();
    // A basis exactly at the bound is still a fact HQ vouches for.
    expect(
      readStoredCostFact({
        provenance: 'estimated',
        amountMinorUnits: 100,
        currency: 'USD',
        unitKind: 'requests',
        basis: 'y'.repeat(MAX_COST_BASIS_LENGTH),
      }),
    ).toMatchObject({ state: 'known' });
  });

  it('reads a STORED amount beyond the writer’s bound back as unknown', () => {
    const beyond = MAX_COST_MINOR_UNITS + 1;
    expect(
      normalizeCostFact({
        provenance: 'billed',
        amountMinorUnits: beyond,
        currency: 'USD',
        unitKind: 'requests',
      }),
    ).toEqual({ ok: false, refusal: 'amount_out_of_bounds' });
    expect(
      readStoredCostFact({
        provenance: 'billed',
        amountMinorUnits: beyond,
        currency: 'USD',
        unitKind: 'requests',
        basis: null,
      }),
    ).toMatchObject({ provenance: 'unknown', amountMinorUnits: null, state: 'unknown' });
  });

  /**
   * Wave 5 Medium 7. `MAX_COST_BASIS_LENGTH` was applied only to the branch
   * that cannot carry a basis at all, under the misnamed
   * `basis_on_non_estimate` — so `estimated`, the one provenance that REQUIRES
   * a basis, had no length check, and roughly a megabyte of caller text could
   * land permanently in an append-only, un-erasable table.
   */
  it('bounds the basis on EVERY branch, and names the refusal for what it is', () => {
    const long = 'x'.repeat(MAX_COST_BASIS_LENGTH + 1);
    expect(
      normalizeCostFact({
        provenance: 'estimated',
        amountMinorUnits: 10,
        currency: 'USD',
        unitKind: 'requests',
        basis: long,
      }),
    ).toEqual({ ok: false, refusal: 'basis_too_long' });
    expect(
      normalizeCostFact({
        provenance: 'billed',
        amountMinorUnits: 10,
        currency: 'USD',
        unitKind: 'requests',
        basis: long,
      }),
    ).toEqual({ ok: false, refusal: 'basis_too_long' });
    expect(
      normalizeCostFact({
        provenance: 'unknown',
        amountMinorUnits: null,
        currency: null,
        unitKind: 'unknown',
        basis: long,
      }),
    ).toEqual({ ok: false, refusal: 'basis_too_long' });
    // At the bound exactly, an estimate is accepted.
    const atBound = normalizeCostFact({
      provenance: 'estimated',
      amountMinorUnits: 10,
      currency: 'USD',
      unitKind: 'requests',
      basis: 'y'.repeat(MAX_COST_BASIS_LENGTH),
    });
    expect(atBound.ok).toBe(true);
    // And a SHORT basis on a non-estimate is refused for what it is, rather
    // than silently accepted because it happened to be under 200 characters.
    expect(
      normalizeCostFact({
        provenance: 'billed',
        amountMinorUnits: 10,
        currency: 'USD',
        unitKind: 'requests',
        basis: 'a story about a number that did not need one',
      }),
    ).toEqual({ ok: false, refusal: 'basis_on_non_estimate' });
  });
});

describe('the routing policy is value engineering, not "always cheapest"', () => {
  it('takes the cheapest permitted tier that clears every floor', () => {
    const proposal = computeRoutingProposal({
      characteristics: READ_ONLY_WORK,
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(proposal.floorTier).toBe('deterministic_local');
    expect(proposal.tier).toBe('deterministic_local');
    expect(proposal.localPathTaken).toBe(true);
    expect(proposal.grantsAuthority).toBe(false);
    expect(proposal.authorizesSpend).toBe(false);
  });

  it('raises the floor for harder, larger and riskier work rather than staying cheap', () => {
    const novel = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, complexity: 'novel' },
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(novel.tier).toBe('high');
    const huge = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, contextSize: 'very_large' },
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(huge.tier).toBe('high');
    const destructive = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, riskClass: 'destructive' },
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(destructive.tier).toBe('critical_review');
    expect(destructive.requiredReviewTier).toBe('critical_review');
  });

  it('never proposes a tier BELOW the floor, however cheap the permitted set looks', () => {
    const proposal = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, complexity: 'novel' },
      permittedTiers: ['deterministic_local', 'low_cost'],
      budgetDecision: 'within_ceiling',
    });
    expect(proposal.tier).toBeNull();
    expect(proposal.refusal).toBe('no_permitted_tier');
    expect(proposal.requiresFounderDecision).toBe(true);
  });

  it('treats a local_only privacy requirement as a hard cap, not a preference', () => {
    const fits = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, privacy: 'local_only' },
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'requires_founder_decision',
    });
    expect(fits.tier).toBe('deterministic_local');
    // A free local tier spends nothing, so an unknown spend position does not
    // need a human before it may be used.
    expect(fits.requiresFounderDecision).toBe(false);

    const conflicts = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, privacy: 'local_only', complexity: 'novel' },
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(conflicts.tier).toBeNull();
    expect(conflicts.refusal).toBe('privacy_requires_local_but_work_needs_more');
  });

  it('accepts the LOCAL path as first-class when policy permits it', () => {
    const proposal = computeRoutingProposal({
      characteristics: READ_ONLY_WORK,
      permittedTiers: DEFAULT_PERMITTED_TIERS,
      budgetDecision: 'requires_founder_decision',
    });
    expect(proposal.tier).toBe('deterministic_local');
    expect(proposal.localPathTaken).toBe(true);
    expect(proposal.requiresFounderDecision).toBe(false);
  });

  it('refuses outright when the budget ceiling blocks', () => {
    const proposal = computeRoutingProposal({
      characteristics: READ_ONLY_WORK,
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'blocked',
    });
    expect(proposal.tier).toBeNull();
    expect(proposal.refusal).toBe('budget_ceiling_blocks');
  });

  it('records latency as a consideration that discriminates between no tiers, and says so', () => {
    const batch = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, latency: 'batch' },
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    const interactive = computeRoutingProposal({
      characteristics: { ...READ_ONLY_WORK, latency: 'interactive' },
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(batch.tier).toBe(interactive.tier);
    const consideration = batch.considerations.find((entry) => entry.factor === 'latency')!;
    expect(consideration.imposedFloor).toBeNull();
    expect(consideration.statement).toContain('observed no latency');
  });

  it('has no provider or model field at all — the shape cannot name an executor', () => {
    const proposal = computeRoutingProposal({
      characteristics: READ_ONLY_WORK,
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    const keys = Object.keys(proposal);
    expect(keys).not.toContain('providerId');
    expect(keys).not.toContain('modelId');
    expect(keys).not.toContain('provider');
    expect(keys).not.toContain('model');
    expect(proposal.statement).toContain('canonical binding');
  });
});

describe('a cheaper tier cannot bypass a required reviewer tier', () => {
  it('requires an independent review for exactly the risk classes that reach outside HQ', () => {
    expect(REVIEW_REQUIREMENT.read_only).toBeNull();
    expect(REVIEW_REQUIREMENT.reversible).toBeNull();
    expect(REVIEW_REQUIREMENT.external_side_effect).toBe('high');
    expect(REVIEW_REQUIREMENT.destructive).toBe('critical_review');
    expect(REVIEW_REQUIREMENT.founder_gate).toBe('critical_review');
  });

  it('is false for every tier below the requirement and true at or above it', () => {
    for (const tier of INTELLIGENCE_TIERS) {
      expect(
        proposalSatisfiesReviewRequirement({ tier, requiredReviewTier: 'high' }),
      ).toBe(tierRank(tier) >= tierRank('high'));
    }
    // A proposal that named no tier satisfies nothing.
    expect(proposalSatisfiesReviewRequirement({ tier: null, requiredReviewTier: 'high' })).toBe(false);
    // No requirement is satisfied by anything, including nothing.
    expect(proposalSatisfiesReviewRequirement({ tier: null, requiredReviewTier: null })).toBe(true);
  });

  it('folds the requirement into the FLOOR, so a bare proposal can never sit under it', () => {
    const proposal = computeRoutingProposal({
      characteristics: SIDE_EFFECT_WORK,
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(proposal.requiredReviewTier).toBe('high');
    expect(proposal.floorTier).toBe('high');
    expect(proposal.tier).toBe('high');
    expect(proposalSatisfiesReviewRequirement(proposal)).toBe(true);
  });
});

describe('escalation preserves canonical identity and creates no authority', () => {
  const identity = { taskId: 'task-9', missionId: 'mission-9', projectId: 'project-9' };

  it('carries the same task, mission and project, and moves strictly up', () => {
    const result = deriveEscalation({
      from: { id: 'dec-1', tier: 'low_cost', identity, requiredReviewTier: null },
      trigger: 'tier_did_not_meet_requirement',
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.escalation.identity).toEqual(identity);
    expect(result.escalation.fromTier).toBe('low_cost');
    expect(result.escalation.toTier).toBe('standard');
    expect(tierRank(result.escalation.toTier)).toBeGreaterThan(tierRank(result.escalation.fromTier));
    expect(result.escalation.grantsAuthority).toBe(false);
    expect(result.escalation.authorizesSpend).toBe(false);
  });

  it('refuses when no higher tier is permitted, rather than inventing one', () => {
    expect(
      deriveEscalation({
        from: { id: 'dec-1', tier: 'low_cost', identity, requiredReviewTier: null },
        trigger: 'insufficient_evidence',
        permittedTiers: ['deterministic_local', 'low_cost'],
        budgetDecision: 'within_ceiling',
      }),
    ).toEqual({ ok: false, refusal: 'no_higher_permitted_tier' });
  });

  it('refuses at the top of the order, and refuses when the ceiling blocks', () => {
    expect(
      deriveEscalation({
        from: { id: 'dec-1', tier: 'critical_review', identity, requiredReviewTier: null },
        trigger: 'policy_requires_stronger',
        permittedTiers: INTELLIGENCE_TIERS,
        budgetDecision: 'within_ceiling',
      }),
    ).toEqual({ ok: false, refusal: 'already_at_highest_tier' });
    expect(
      deriveEscalation({
        from: { id: 'dec-1', tier: 'low_cost', identity, requiredReviewTier: null },
        trigger: 'policy_requires_stronger',
        permittedTiers: INTELLIGENCE_TIERS,
        budgetDecision: 'blocked',
      }),
    ).toEqual({ ok: false, refusal: 'budget_ceiling_blocks' });
  });

  it('refuses to escalate a decision whose stored tier is not a vocabulary member', () => {
    expect(
      deriveEscalation({
        from: { id: 'dec-1', tier: 'unrecognized', identity, requiredReviewTier: null },
        trigger: 'insufficient_evidence',
        permittedTiers: INTELLIGENCE_TIERS,
        budgetDecision: 'within_ceiling',
      }),
    ).toEqual({ ok: false, refusal: 'prior_decision_has_no_tier' });
  });
});

describe('a budget ceiling blocks or asks; it never grants', () => {
  const budget = { ceilingMinorUnits: 1000, currency: 'USD', permittedTiers: [...INTELLIGENCE_TIERS] };

  it('answers requires_founder_decision when NO ceiling has been recorded, with the local-only tier set', () => {
    const evaluation = evaluateBudget({ budget: null, entries: [] });
    expect(evaluation.decision).toBe('requires_founder_decision');
    expect([...evaluation.permittedTiers]).toEqual(['deterministic_local']);
    expect(evaluation.grantsSpend).toBe(false);
    expect(evaluation.authorizesPaidActivation).toBe(false);
    expect(evaluation.reason).toContain('not treat the absence of a policy as permission');
  });

  it('BLOCKS when recorded spend reaches the ceiling', () => {
    const evaluation = evaluateBudget({
      budget,
      entries: [{ amountMinorUnits: 1000, currency: 'USD' }],
    });
    expect(evaluation.decision).toBe('blocked');
    expect(evaluation.grantsSpend).toBe(false);
  });

  it('demands a decision when ANY entry has an unknown amount — unknown stays unknown', () => {
    const evaluation = evaluateBudget({
      budget,
      entries: [
        { amountMinorUnits: 10, currency: 'USD' },
        { amountMinorUnits: null, currency: null },
      ],
    });
    expect(evaluation.decision).toBe('requires_founder_decision');
    expect(evaluation.unknownAmountEntries).toBe(1);
    expect(evaluation.observedMinorUnits).toBe(10);
    expect(evaluation.reason).toContain('unknown cost stays unknown');
  });

  it('never converts between currencies — a foreign entry forces a decision', () => {
    const evaluation = evaluateBudget({
      budget,
      entries: [
        { amountMinorUnits: 10, currency: 'USD' },
        { amountMinorUnits: 900, currency: 'EUR' },
      ],
    });
    expect(evaluation.decision).toBe('requires_founder_decision');
    expect(evaluation.otherCurrencyEntries).toBe(1);
    // The EUR amount is NOT added into the USD total.
    expect(evaluation.observedMinorUnits).toBe(10);
  });

  it('says "within_ceiling" without granting anything at all', () => {
    const evaluation = evaluateBudget({ budget, entries: [{ amountMinorUnits: 10, currency: 'USD' }] });
    expect(evaluation.decision).toBe('within_ceiling');
    expect(evaluation.grantsSpend).toBe(false);
    expect(evaluation.authorizesPaidActivation).toBe(false);
    expect(evaluation.reason).toContain('not permission to spend');
  });

  it('resolves the CURRENT ceiling as the highest recorded version', () => {
    const rows: BudgetRow[] = [1, 2, 3].map((version) => ({
      seq: version,
      id: `b${version}`,
      scopeKind: 'deployment',
      scopeId: 'deployment',
      window: 'total',
      ceilingMinorUnits: version * 100,
      currency: 'USD',
      permittedTiers: ['deterministic_local'],
      version,
      setAt: '2026-01-01T00:00:00.000Z',
      setBy: 'founder',
      note: null,
      budgetKey: `k${version}`,
    }));
    const latest = latestBudgetFor(rows, {
      scopeKind: 'deployment',
      scopeId: 'deployment',
      window: 'total',
    })!;
    expect(latest.version).toBe(3);
    expect(latest.ceilingMinorUnits).toBe(300);
    // A different scope has no ceiling at all — absence, not the nearest match.
    expect(latestBudgetFor(rows, { scopeKind: 'mission', scopeId: 'm1', window: 'total' })).toBeNull();
  });
});

describe('analytics are derived only from observed data', () => {
  it('publishes the escalation rate as an exact numerator over an exact denominator', () => {
    const analytics = summarizeIntelligenceAnalytics({
      decisions: [record({ id: 'a' }), record({ id: 'b', escalatedFrom: 'a' })],
      costs: [],
      observations: [],
    });
    expect(analytics.decisions.escalation).toMatchObject({ numerator: 1, denominator: 2 });
    expect(JSON.stringify(analytics)).not.toMatch(/"escalationPercent"|"escalationRate":\s*0\.5/);
  });

  it('sums only KNOWN amounts and counts the unknown ones beside them', () => {
    const analytics = summarizeIntelligenceAnalytics({
      decisions: [],
      costs: [
        costRow({ id: 'c1', fact: { ...costRow().fact, amountMinorUnits: 100 } }),
        costRow({
          id: 'c2',
          fact: {
            provenance: 'unknown',
            amountMinorUnits: null,
            currency: null,
            unitKind: 'unknown',
            basis: null,
            state: 'unknown',
          },
        }),
      ],
      observations: [],
    });
    expect(analytics.cost.entries).toBe(2);
    expect(analytics.cost.unknownAmountEntries).toBe(1);
    expect(analytics.cost.byCurrency).toEqual([{ currency: 'USD', knownAmountMinorUnits: 100, entries: 1 }]);
  });

  it('never sums across currencies — each is its own bucket', () => {
    const analytics = summarizeIntelligenceAnalytics({
      decisions: [],
      costs: [
        costRow({ id: 'c1', fact: { ...costRow().fact, amountMinorUnits: 100, currency: 'USD' } }),
        costRow({ id: 'c2', fact: { ...costRow().fact, amountMinorUnits: 200, currency: 'EUR' } }),
      ],
      observations: [],
    });
    expect(analytics.cost.byCurrency).toEqual([
      { currency: 'EUR', knownAmountMinorUnits: 200, entries: 1 },
      { currency: 'USD', knownAmountMinorUnits: 100, entries: 1 },
    ]);
    expect(analytics.cost.byProvider.map((entry) => entry.currency).sort()).toEqual(['EUR', 'USD']);
  });

  /**
   * Wave 5 review, LOW finding 6. `foldSpend` used to render an
   * unknown-amount identity as `knownAmountMinorUnits: 0` under a synthetic
   * `currency: "unknown"`. Nothing was fabricated — the `0` was arithmetically
   * true and `unknownAmountEntries: 1` stood beside it — but a `0` next to an
   * identity HQ has no amount for is exactly the reading this phase exists to
   * prevent, and `"unknown"` is not a currency.
   */
  it('renders an identity HQ has NO amount for as null, never as zero', () => {
    const analytics = summarizeIntelligenceAnalytics({
      decisions: [],
      costs: [
        costRow({
          id: 'c1',
          providerId: 'anthropic',
          fact: {
            provenance: 'unknown',
            amountMinorUnits: null,
            currency: null,
            unitKind: 'unknown',
            basis: null,
            state: 'unknown',
          },
        }),
      ],
      observations: [],
    });
    const provider = analytics.cost.byProvider[0]!;
    expect(provider.id).toBe('anthropic');
    expect(provider.knownAmountMinorUnits).toBeNull();
    expect(provider.currency).toBeNull();
    expect(provider.entries).toBe(1);
    expect(provider.unknownAmountEntries).toBe(1);
    // No zero anywhere in the fold, and no invented currency code.
    expect(JSON.stringify(analytics.cost.byProvider)).not.toContain('"knownAmountMinorUnits":0');
    // No invented currency code. (`unknown` remains a legitimate PROVENANCE
    // vocabulary member elsewhere in the fold; it is never a currency.)
    expect(JSON.stringify(analytics.cost.byProvider)).not.toContain('unknown"');
    expect(JSON.stringify(analytics.cost.byCurrency)).not.toContain('unknown');
    // The known and unknown halves of one identity stay separate groups, and
    // only the known one carries a number.
    const mixed = summarizeIntelligenceAnalytics({
      decisions: [],
      costs: [
        costRow({
          id: 'c1',
          providerId: 'anthropic',
          fact: {
            provenance: 'unknown',
            amountMinorUnits: null,
            currency: null,
            unitKind: 'unknown',
            basis: null,
            state: 'unknown',
          },
        }),
        costRow({ id: 'c2', providerId: 'anthropic', fact: { ...costRow().fact, amountMinorUnits: 900, currency: 'USD' } }),
      ],
      observations: [],
    });
    expect(mixed.cost.byProvider).toEqual([
      { id: 'anthropic', currency: null, knownAmountMinorUnits: null, entries: 1, unknownAmountEntries: 1 },
      { id: 'anthropic', currency: 'USD', knownAmountMinorUnits: 900, entries: 1, unknownAmountEntries: 0 },
    ]);
  });

  it('counts a decision as provably avoidable ONLY on all four recorded facts', () => {
    // Above the floor, not an escalation, no reviewer required, quality met.
    const avoidable = record({ id: 'av', tier: 'high' });
    avoidable.result = 'quality_met';
    expect(decisionIsProvablyAvoidable(avoidable)).toBe(true);

    // At the floor: nothing to avoid.
    const atFloor = record({ id: 'at', tier: 'deterministic_local' });
    atFloor.result = 'quality_met';
    expect(decisionIsProvablyAvoidable(atFloor)).toBe(false);

    // An escalation is above the floor BY DESIGN.
    const escalated = record({ id: 'esc', tier: 'high', escalatedFrom: 'av' });
    escalated.result = 'quality_met';
    expect(decisionIsProvablyAvoidable(escalated)).toBe(false);

    // A reviewer tier was required.
    const reviewed = record({ id: 'rev', tier: 'high', requiredReviewTier: 'high' });
    reviewed.result = 'quality_met';
    expect(decisionIsProvablyAvoidable(reviewed)).toBe(false);

    // The result is not recorded: HQ does not know it succeeded.
    expect(decisionIsProvablyAvoidable(record({ id: 'unk', tier: 'high' }))).toBe(false);

    expect(AVOIDABLE_SPEND_STATEMENT).toContain('never ran one');
  });

  it('recomputes the floor from the recorded characteristics, so a forged floor column buys nothing', () => {
    // The row claims its floor was `critical_review` while its recorded
    // characteristics compute `deterministic_local`. A forged column must not
    // be able to hide — or manufacture — a finding.
    const forged = record({ id: 'forged', tier: 'high', floorTier: 'critical_review' });
    forged.result = 'quality_met';
    expect(decisionIsProvablyAvoidable(forged)).toBe(true);
  });

  it('reads a decision with unreadable characteristics as NOT avoidable', () => {
    const opaque = record({ id: 'opaque', tier: 'high', characteristics: null });
    opaque.result = 'quality_met';
    expect(decisionIsProvablyAvoidable(opaque)).toBe(false);
  });

  it('derives the decision state from the ledger and defaults the result to unknown', () => {
    const row = decisionRow({ id: 'd1' });
    const issued = deriveDecisionRecord(row, { outcomes: [], escalations: [] });
    expect(issued.state).toBe('issued');
    expect(issued.result).toBe('result_unknown');

    const settled = deriveDecisionRecord(row, {
      outcomes: [
        {
          seq: 1,
          id: 'o1',
          decisionId: 'd1',
          result: 'quality_met',
          reviewedByTier: null,
          note: null,
          recordedAt: '2026-01-02T00:00:00.000Z',
          recordedBy: 'claude',
        },
      ],
      escalations: [],
    });
    expect(settled.state).toBe('settled');
    expect(settled.result).toBe('quality_met');

    const escalatedAway = deriveDecisionRecord(row, {
      outcomes: [],
      escalations: [decisionRow({ id: 'd2', seq: 2, escalatedFrom: 'd1' })],
    });
    expect(escalatedAway.state).toBe('escalated_away');
    expect(escalatedAway.escalatedAwayTo).toBe('d2');
    expect(escalatedAway.grantsAuthority).toBe(false);
  });
});

describe('the unauthenticated snapshot section is closed BY SHAPE', () => {
  it('carries no amount, currency, ceiling, id or free text — the shape has no field for one', () => {
    const observation: ModelObservationRow = {
      seq: 1,
      id: 'obs-1',
      providerId: 'SUPER-SECRET-VENDOR',
      modelId: 'SUPER SECRET MODEL',
      locality: 'cloud',
      availability: 'healthy',
      capabilityFacts: [],
      contextWindowTokens: 200000,
      unitCost: {
        provenance: 'billed',
        amountMinorUnits: 123456,
        currency: 'USD',
        unitKind: 'requests',
        basis: null,
        state: 'known',
      },
      source: 'founder_declared',
      observedAt: '2026-01-01T00:00:00.000Z',
      observedBy: 'founder',
      note: 'SUPER SECRET NOTE',
    };
    const view = summarizeIntelligence({
      storePresent: true,
      decisions: [record({ id: 'SUPER SECRET DECISION', label: 'SUPER SECRET LABEL' })],
      costs: [costRow({ id: 'SUPER SECRET COST', note: 'SUPER SECRET COST NOTE' })],
      observations: [observation],
      budgets: [],
    });
    const encoded = JSON.stringify(view);
    for (const secret of [
      'SUPER-SECRET-VENDOR',
      'SUPER SECRET MODEL',
      'SUPER SECRET NOTE',
      'SUPER SECRET DECISION',
      'SUPER SECRET LABEL',
      'SUPER SECRET COST',
      'SUPER SECRET COST NOTE',
      '123456',
      'USD',
    ]) {
      expect(encoded).not.toContain(secret);
    }
    expect(Object.keys(view).sort()).toEqual([
      'budgetsRecorded',
      'byCostProvenance',
      'byResult',
      'byState',
      'byTier',
      'costEntries',
      'decisions',
      'escalations',
      'note',
      'observations',
      'observationsWithKnownUnitCost',
      'observationsWithUnknownUnitCost',
      'storePresent',
      'tierPolicyRecorded',
      'unknownAmountEntries',
    ]);
  });

  it('buckets a forged tier, state, result and provenance under `unrecognized`, never under its own text', () => {
    const forgedDecision = record({ id: 'x', tier: 'PROJECT NEPTUNE' as IntelligenceTier });
    (forgedDecision as { state: string }).state = 'PROJECT NEPTUNE STATE';
    (forgedDecision as { result: string }).result = 'PROJECT NEPTUNE RESULT';
    const forgedCost = costRow({
      fact: {
        ...costRow().fact,
        provenance: 'PROJECT NEPTUNE PROVENANCE' as never,
      },
    });
    const view = summarizeIntelligence({
      storePresent: true,
      decisions: [forgedDecision],
      costs: [forgedCost],
      observations: [],
      budgets: [],
    });
    expect(JSON.stringify(view)).not.toContain('NEPTUNE');
    expect(view.byTier.unrecognized).toBe(1);
    expect(view.byState.unrecognized).toBe(1);
    expect(view.byResult.unrecognized).toBe(1);
    expect(view.byCostProvenance.unrecognized).toBe(1);
    // Every count is an integer, and each map totals what was folded.
    for (const map of [view.byTier, view.byState, view.byResult, view.byCostProvenance]) {
      for (const count of Object.values(map)) expect(Number.isInteger(count)).toBe(true);
      expect(Object.values(map).reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  /**
   * Wave 5 review, LOW finding 7. The test above forges a fact DIRECTLY, which
   * is the fold's own boundary. This one pins the sentence the comment now
   * makes: through the reader HQ actually uses, a forged provenance is already
   * `unknown` before the fold sees it, so `byCostProvenance.unrecognized` is
   * unreachable on the live path — while the TIER bucket stays reachable there,
   * which is the asymmetry the comment has to state honestly.
   */
  it('cannot reach the provenance `unrecognized` bucket through the STORED reader', () => {
    const coerced = readStoredCostFact({
      provenance: 'PROJECT NEPTUNE PROVENANCE',
      amountMinorUnits: 4200,
      currency: 'USD',
      unitKind: 'requests',
      basis: null,
    });
    expect(coerced.provenance).toBe('unknown');
    expect(coerced.amountMinorUnits).toBeNull();
    const view = summarizeIntelligence({
      storePresent: true,
      decisions: [],
      costs: [costRow({ fact: coerced })],
      observations: [],
      budgets: [],
    });
    expect(view.byCostProvenance.unrecognized).toBe(0);
    expect(view.byCostProvenance.unknown).toBe(1);
    expect(view.unknownAmountEntries).toBe(1);
    // The tier bucket, by contrast, IS reachable from a stored row: the tier is
    // read off the column as-is, which is why that bucket is a live defence and
    // this one is not.
    const forgedTier = summarizeIntelligence({
      storePresent: true,
      decisions: [record({ id: 'x', tier: 'PROJECT NEPTUNE' as IntelligenceTier })],
      costs: [],
      observations: [],
      budgets: [],
    });
    expect(forgedTier.byTier.unrecognized).toBe(1);
  });

  it('states an absent store as zeros without implying an empty one', () => {
    const empty = emptyIntelligenceSnapshot(false);
    expect(empty.storePresent).toBe(false);
    expect(empty.decisions).toBe(0);
    expect(empty.tierPolicyRecorded).toBe(false);
    expect(empty.note).toContain('never rendered as zero');
  });
});
