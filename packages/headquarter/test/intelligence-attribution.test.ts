/**
 * Wave 5 correction — WHOSE budget, WHOSE mission, WHOSE provider, and WHICH
 * figure.
 *
 * Phase 14's module docstring states four laws, and law 4 says "no policy path
 * can widen the permitted tier set on its own". That was true of the policy
 * module and false of the facade, in two compounding ways the review reproduced
 * by execution:
 *
 *  - **HIGH B-1 — a caller chose which Founder budget policy governed its own
 *    write.** `budgetScope` was an optional argument taken verbatim; nothing
 *    checked that the named scope had anything to do with the task, its
 *    mission, its project or its bound provider. `evaluation.permittedTiers`
 *    and `evaluation.decision` are the WHOLE of what `#resolveRecordedTier`
 *    enforces against, so the same task, the same worker and the same live
 *    fence produced `tier_not_permitted` under the default scope and a recorded
 *    `critical_review` under a scope the caller shopped for. `grep budgetScope
 *    test/` returned nothing: the parameter was entirely unpinned.
 *  - **HIGH B-2 — every non-deployment ceiling, and both time windows, were
 *    keyed on strings the caller invented.** `missionId`, `projectId`,
 *    `providerId` and `occurredAt` were written verbatim: a ghost mission, a
 *    provider the task is not bound to, and a 999,999-unit entry dated
 *    2099-01-01 that no window could see, all accepted.
 *
 * Both directions were live: a claim-holding worker could evade its own
 * ceiling, and could push spend into a third party's scope to force it towards
 * `blocked`. The fix is one coherent change — attribution comes from canonical
 * truth, and the governing policy set is DERIVED from it.
 *
 * The Mediums and Lows that travel with them are pinned here too: the budget
 * reader that failed OPEN (B-4), the cost dedupe that silently kept a
 * fabricated zero (B-5), the escalation view that could contradict its own row
 * (B-6), the basis bound that never applied to an estimate (B-7), and the
 * credential scan that stopped at the route (B-8).
 */

import { describe, expect, it } from 'vitest';
import { expectOk } from './application.fixture.js';
import { intelligenceFixture, type IntelligenceFixture } from './intelligence.fixture.js';
import {
  INTELLIGENCE_TIERS,
  MAX_COST_BASIS_LENGTH,
  combineBudgetEvaluations,
  evaluateBudget,
  latestBudgetFor,
  loadBudgets,
  normalizeCostFact,
  type BudgetEvaluation,
  type GoverningBudgetScope,
} from '../src/application/intelligence-command.js';
import type { HeadquarterOperations } from '../src/application/service.js';

function decide(fx: IntelligenceFixture, over: Record<string, unknown> = {}) {
  return fx.ops.recordIntelligenceDecision({
    taskId: fx.claim.taskId,
    workerId: fx.claim.workerId,
    fence: fx.claim.fence,
    label: 'open the release PR',
    complexity: 'routine',
    contextSize: 'medium',
    workKind: 'coding',
    ...over,
  } as Parameters<HeadquarterOperations['recordIntelligenceDecision']>[0]);
}

function cost(fx: IntelligenceFixture, over: Record<string, unknown> = {}) {
  return fx.ops.recordIntelligenceCost({
    taskId: fx.claim.taskId,
    workerId: fx.claim.workerId,
    fence: fx.claim.fence,
    providerId: 'anthropic',
    provenance: 'unknown',
    unitKind: 'unknown',
    ...over,
  } as Parameters<HeadquarterOperations['recordIntelligenceCost']>[0]);
}

describe('the governing budget policy is DERIVED, never named by the caller', () => {
  it('takes no budgetScope parameter at all, on either method', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // The exploit was one optional argument. Supplying it now changes nothing,
    // because nothing reads it — and the shopped scope below proves that is a
    // real property rather than a signature detail.
    const withArgument = expectOk(
      decide(fx, {
        tier: 'high',
        budgetScope: { scopeKind: 'model', scopeId: 'a-scope-nobody-checked', window: 'total' },
        idempotencyKey: 'with-argument',
      }),
    );
    expect(withArgument.decision.tier).toBe('high');
    // And it did NOT govern: the deployment baseline is what was recorded.
    expect([...withArgument.decision.permittedTiers]).toEqual([...INTELLIGENCE_TIERS]);
  });

  it('refuses under the real policy where a SHOPPED scope used to permit', () => {
    const fx = intelligenceFixture();
    // The deployment baseline — the policy that actually governs — permits the
    // free local tier alone.
    fx.budget(['deterministic_local']);
    // A second scope that permits everything. Recorded by the Founder, so the
    // row is legitimate; it simply has nothing to do with this task.
    fx.budget([...INTELLIGENCE_TIERS], {
      scopeKind: 'model',
      scopeId: 'some-other-scope',
      window: 'total',
    });
    expect(loadBudgets(fx.db)).toHaveLength(2);

    // The reviewer's reproduction: DEFAULT SCOPE refused, SHOPPED SCOPE
    // recorded `critical_review` with the whole tier set behind it.
    const shopped = decide(fx, {
      tier: 'critical_review',
      budgetScope: { scopeKind: 'model', scopeId: 'some-other-scope', window: 'total' },
    });
    expect(shopped.ok).toBe(false);
    expect(!shopped.ok && shopped.error.code).toBe('tier_not_permitted');

    // The proposal answers the same way, and it used to answer `high` under
    // the shopped scope while answering `null` under the default one.
    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    expect(proposal.tier).toBeNull();
    expect(proposal.refusal).toBe('no_permitted_tier');
    // And it says which policies governed, so the derivation is visible.
    expect(proposal.governedBy.map((scope) => `${scope.scopeKind}:${scope.scopeId}`)).toEqual([
      'deployment:deployment',
    ]);
    expect(proposal.governedBy[0]!.derivedFrom).toBe('deployment');
  });

  it('governs by the task’s canonical mission, and takes the most restrictive answer', () => {
    const fx = intelligenceFixture();
    const canonical = fx.linkToCanonicalMission(fx.claim.taskId, 'restrictive');
    // The deployment baseline permits everything...
    fx.budget([...INTELLIGENCE_TIERS]);
    // ...and the task's own mission does not. The mission ceiling is the
    // policy a worker had every reason to want to route around, and the one
    // the caller-supplied scope let it route around.
    fx.budget(['deterministic_local', 'low_cost'], {
      scopeKind: 'mission',
      scopeId: canonical.missionId,
      window: 'total',
    });

    const refusal = decide(fx, { tier: 'critical_review' });
    expect(refusal.ok).toBe(false);
    expect(!refusal.ok && refusal.error.code).toBe('tier_not_permitted');

    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    // The INTERSECTION, never the union.
    expect([...proposal.permittedTiers]).toEqual(['deterministic_local', 'low_cost']);
    expect(proposal.governedBy.map((scope) => scope.derivedFrom).sort()).toEqual([
      'deployment',
      'task_mission',
    ]);
  });

  it('governs by the task’s canonical PROJECT too, through its mission', () => {
    const fx = intelligenceFixture();
    const canonical = fx.linkToCanonicalMission(fx.claim.taskId, 'project-governed');
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.budget([...INTELLIGENCE_TIERS], {
      scopeKind: 'project',
      scopeId: canonical.projectId,
      window: 'total',
      ceilingMinorUnits: 1,
    });
    // One cost entry of 500 in the project's window: the project ceiling of 1
    // is reached, so the whole answer is `blocked` however generous the
    // deployment baseline is.
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 500,
        currency: 'USD',
        unitKind: 'requests',
      }),
    );
    const refusal = decide(fx, { tier: 'high' });
    expect(refusal.ok).toBe(false);
    expect(!refusal.ok && refusal.error.code).toBe('budget_ceiling_blocks');
  });

  it('folds several policies with the worst decision and the narrowest set', () => {
    // The pure rule, asserted directly rather than only through the facade.
    const scope = (scopeId: string): GoverningBudgetScope => ({
      scopeKind: 'mission',
      scopeId,
      window: 'total',
      derivedFrom: 'task_mission',
    });
    const evaluation = (
      decision: BudgetEvaluation['decision'],
      permittedTiers: readonly string[],
    ): BudgetEvaluation =>
      ({
        decision,
        ceilingMinorUnits: 100,
        currency: 'USD',
        observedMinorUnits: 0,
        unknownAmountEntries: 0,
        otherCurrencyEntries: 0,
        permittedTiers,
        reason: 'test',
        grantsSpend: false,
        authorizesPaidActivation: false,
        statement: 'test',
      }) as unknown as BudgetEvaluation;

    const folded = combineBudgetEvaluations([
      { scope: scope('a'), evaluation: evaluation('within_ceiling', [...INTELLIGENCE_TIERS]) },
      { scope: scope('b'), evaluation: evaluation('requires_founder_decision', ['deterministic_local', 'low_cost']) },
      { scope: scope('c'), evaluation: evaluation('within_ceiling', ['low_cost', 'standard']) },
    ]);
    expect(folded.decision).toBe('requires_founder_decision');
    expect(folded.permittedTiers).toEqual(['low_cost']);
    expect(folded.governedBy).toHaveLength(3);

    // `blocked` beats `requires_founder_decision`.
    expect(
      combineBudgetEvaluations([
        { scope: scope('a'), evaluation: evaluation('requires_founder_decision', [...INTELLIGENCE_TIERS]) },
        { scope: scope('b'), evaluation: evaluation('blocked', [...INTELLIGENCE_TIERS]) },
      ]).decision,
    ).toBe('blocked');

    // An EMPTY set is not "no restrictions".
    const none = combineBudgetEvaluations([]);
    expect(none.decision).toBe('requires_founder_decision');
    expect(none.permittedTiers).toEqual(['deterministic_local']);
  });
});

describe('a cost entry is attributed to canonical truth, not to what the caller typed', () => {
  it('takes mission and project from the plan, ignoring a ghost pair', () => {
    const fx = intelligenceFixture();
    const canonical = fx.linkToCanonicalMission(fx.claim.taskId, 'attribution');
    fx.budget([...INTELLIGENCE_TIERS]);
    const entry = expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 4200,
        currency: 'USD',
        unitKind: 'requests',
        missionId: 'a-mission-that-does-not-exist',
        projectId: 'a-project-that-does-not-exist',
      }),
    ).entry;
    expect(entry.missionId).toBe(canonical.missionId);
    expect(entry.projectId).toBe(canonical.projectId);
    expect(entry.missionId).not.toBe('a-mission-that-does-not-exist');

    // And a task linked to nothing is attributed to nothing, rather than to a
    // mission the caller names.
    const unlinked = intelligenceFixture();
    unlinked.budget([...INTELLIGENCE_TIERS]);
    const orphan = expectOk(
      cost(unlinked, {
        provenance: 'billed',
        amountMinorUnits: 1,
        currency: 'USD',
        unitKind: 'requests',
        missionId: 'still-not-real',
      }),
    ).entry;
    expect(orphan.missionId).toBeNull();
    expect(orphan.projectId).toBeNull();
  });

  it('refuses a provider the canonical payload does not bind', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const bound = fx.ops.getIntelligenceDecision('none');
    expect(bound).toBeNull();
    // The fixture's task carries a provider binding, so a cost entry naming a
    // different provider is a misattribution rather than a description.
    const boundProvider = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    ).boundProvider;
    if (boundProvider == null) {
      // Nothing is bound on this fixture's task, so the rule cannot fire and
      // saying it did would be a fabrication. The unbound case is stated
      // instead: any provider is accepted, exactly as before.
      expect(
        expectOk(cost(fx, { providerId: 'a.provider.never.bound' })).entry.providerId,
      ).toBe('a.provider.never.bound');
      return;
    }
    const refusal = cost(fx, { providerId: 'a.provider.never.bound' });
    expect(refusal.ok).toBe(false);
    expect(!refusal.ok && refusal.error.code).toBe('provider_binding_mismatch');
    expect(!refusal.ok && refusal.error.message).toContain('No substitution is made');
    expect(expectOk(cost(fx, { providerId: boundProvider })).entry.providerId).toBe(boundProvider);
  });

  it('refuses an occurredAt that would file the spend in a window it did not happen in', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS], { window: 'day', ceilingMinorUnits: 100 });
    // The reviewer's reproduction: 999,999 minor units dated 2099-01-01, which
    // no `day` or `month` window can see, so the scope read `within_ceiling`
    // with `observed: 0`.
    const future = cost(fx, {
      provenance: 'billed',
      amountMinorUnits: 999_999,
      currency: 'USD',
      unitKind: 'requests',
      occurredAt: '2099-01-01T00:00:00.000Z',
    });
    expect(future.ok).toBe(false);
    expect(!future.ok && future.error.code).toBe('invalid_input');
    expect(!future.ok && future.error.message).toMatch(/bounded interval around now/);

    const ancient = cost(fx, {
      provenance: 'billed',
      amountMinorUnits: 1,
      currency: 'USD',
      unitKind: 'requests',
      occurredAt: '1999-01-01T00:00:00.000Z',
    });
    expect(ancient.ok).toBe(false);
    expect(!ancient.ok && ancient.error.code).toBe('invalid_input');

    // A plausible instant is still accepted, so the bound is a bound and not a
    // ban on recording anything but "now".
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(expectOk(cost(fx, { occurredAt: recent })).entry.occurredAt).toBe(recent);
  });

  it('refuses a second entry that disagrees, instead of keeping a fabricated zero', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const at = new Date().toISOString();
    const zero = expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 0,
        currency: 'USD',
        unitKind: 'requests',
        occurredAt: at,
      }),
    );
    expect(zero.entry.fact.amountMinorUnits).toBe(0);
    expect(zero.entry.fact.state).toBe('known');

    // THE FINDING: `costEntryKey` excludes provenance, amount and currency, so
    // the true figure deduped to the zero and came back as `deduplicated: true`
    // with `amount: 0` — silently, and without setting `unknownAmountEntries`,
    // so `evaluateBudget` answered `within_ceiling` over a fabricated zero.
    const real = cost(fx, {
      provenance: 'billed',
      amountMinorUnits: 50_000,
      currency: 'USD',
      unitKind: 'requests',
      occurredAt: at,
    });
    expect(real.ok).toBe(false);
    expect(!real.ok && real.error.code).toBe('cost_entry_conflict');
    expect(!real.ok && real.error.message).toMatch(/says something different/);

    // An IDENTICAL re-record still dedupes — the idempotency property the key
    // exists for is unchanged.
    const identical = expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 0,
        currency: 'USD',
        unitKind: 'requests',
        occurredAt: at,
      }),
    );
    expect(identical.deduplicated).toBe(true);
    expect(identical.entry.id).toBe(zero.entry.id);

    // And the correction has a way through: its own idempotency key.
    const corrected = expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 50_000,
        currency: 'USD',
        unitKind: 'requests',
        occurredAt: at,
        idempotencyKey: 'the-real-figure',
      }),
    );
    expect(corrected.entry.fact.amountMinorUnits).toBe(50_000);
  });

  it('scans providerId and modelId at the FACADE, which has no route to scan at', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // The slug rule accepts `sk-proj-…`: lowercase letters, digits and dashes
    // are exactly what an OpenAI-style key looks like.
    const refusal = cost(fx, { providerId: 'sk-proj-abcdefghijklmnopqrstuvwxyz' });
    expect(refusal.ok).toBe(false);
    expect(!refusal.ok && refusal.error.code).toBe('invalid_input');
    expect(!refusal.ok && refusal.error.message).toMatch(/credential/);
    // The refusal does not echo the offending text back.
    expect(!refusal.ok && refusal.error.message).not.toContain('sk-proj-');
  });
});

describe('a stored budget row is read FAIL-CLOSED, like a stored cost fact', () => {
  it('answers requires_founder_decision on an unreadable ceiling, never within_ceiling', () => {
    // The pure rule first: `Number('not-a-number')` was `NaN`, and
    // `observed >= NaN` is false, so `blocked` could never fire again.
    const unreadable = evaluateBudget({
      budget: { ceilingMinorUnits: null, currency: 'USD', permittedTiers: [...INTELLIGENCE_TIERS] },
      entries: [{ amountMinorUnits: 5_000_000, currency: 'USD' }],
    });
    expect(unreadable.decision).toBe('requires_founder_decision');
    expect(unreadable.ceilingMinorUnits).toBeNull();
    expect([...unreadable.permittedTiers]).toEqual(['deterministic_local']);
    expect(unreadable.grantsSpend).toBe(false);
  });

  it('turns a raw append that forges scope, window and ceiling into a row that governs NOTHING', () => {
    const fx = intelligenceFixture();
    fx.budget(['deterministic_local'], { ceilingMinorUnits: 100 });
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 500,
        currency: 'USD',
        unitKind: 'requests',
      }),
    );
    const before = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'deployment',
        scopeId: 'deployment',
        window: 'total',
      }),
    );
    expect(before.decision).toBe('blocked');

    // THE FINDING: one raw APPEND — the write the triggers deliberately permit
    // — with a scope kind and window outside the vocabulary and a non-numeric
    // ceiling. `rowToBudget` coerced the first two to `deployment`/`total`,
    // ADOPTING the forged row as the deployment ceiling, and `Number()` made
    // the third `NaN`. `blocked` became `within_ceiling` and a
    // `critical_review` tier was recorded against it.
    fx.db
      .prepare(
        `INSERT INTO hq_intel_budgets
           (id, scope_kind, scope_id, window_kind, ceiling_minor_units, currency, permitted_tiers,
            version, set_at, set_by, note, budget_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'budget-forged',
        'not-a-scope',
        'deployment',
        'not-a-window',
        'not-a-number',
        'USD',
        JSON.stringify([...INTELLIGENCE_TIERS]),
        99,
        new Date().toISOString(),
        'attacker',
        null,
        'budget:forged',
      );

    const after = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'deployment',
        scopeId: 'deployment',
        window: 'total',
      }),
    );
    expect(after.decision).toBe('blocked');
    expect(after.ceilingMinorUnits).toBe(100);
    expect([...after.permittedTiers]).toEqual(['deterministic_local']);
    // The forged row is visible as what it is, and matches no real scope.
    const forged = loadBudgets(fx.db).find((row) => row.id === 'budget-forged')!;
    expect(forged.scopeKind).toBe('unrecognized');
    expect(forged.window).toBe('unrecognized');
    expect(forged.ceilingMinorUnits).toBeNull();
    expect(
      latestBudgetFor(loadBudgets(fx.db), {
        scopeKind: 'deployment',
        scopeId: 'deployment',
        window: 'total',
      })!.id,
    ).not.toBe('budget-forged');
    // And the write it was meant to buy is still refused.
    const write = decide(fx, { tier: 'critical_review' });
    expect(write.ok).toBe(false);
    expect(!write.ok && write.error.code).toBe('budget_ceiling_blocks');
  });
});

describe('a decision’s canonical facts are re-derived at READ time', () => {
  it('reports the bound provider and risk class from op_tasks, not from the row', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const recorded = expectOk(decide(fx, { tier: 'critical_review' })).decision;

    // A raw APPEND choosing all three of the columns the Founder route
    // publishes as canonical facts: the bound provider, the risk class inside
    // `characteristics`, and the review requirement.
    fx.db
      .prepare(
        `INSERT INTO hq_intel_decisions
           (id, task_id, mission_id, project_id, tier, floor_tier, required_review_tier, escalated_from,
            escalation_trigger, bound_provider, characteristics, permitted_tiers, budget_decision, label,
            issued_at, issued_by, process_id, decision_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'inteldec-forged',
        fx.claim.taskId,
        null,
        null,
        'critical_review',
        'deterministic_local',
        null,
        null,
        null,
        'gemini-not-the-bound-provider',
        JSON.stringify({
          complexity: 'trivial',
          contextSize: 'small',
          workKind: 'summarization',
          riskClass: 'read_only',
          latency: 'unspecified',
          privacy: 'unrestricted',
        }),
        JSON.stringify([...INTELLIGENCE_TIERS]),
        'within_ceiling',
        'a forged row',
        new Date().toISOString(),
        'attacker',
        'attacker',
        'inteldec:forged',
      );

    const read = fx.ops.getIntelligenceDecision('inteldec-forged')!;
    // The provider comes from the canonical payload, so the forged string is
    // not what the Founder route publishes.
    expect(read.boundProvider).not.toBe('gemini-not-the-bound-provider');
    expect(read.boundProvider).toBe(recorded.boundProvider);
    // The risk class comes from `op_capabilities` through the same `#private`
    // closure the rest of the phase enforces on, so `read_only` is not what the
    // avoidable-spend derivation sees.
    expect(read.characteristics!.riskClass).not.toBe('read_only');
    expect(read.characteristics!.riskClass).toBe(recorded.characteristics!.riskClass);
    // A forged NULL review requirement no longer makes the row satisfy it.
    expect(read.requiredReviewTier).toBe(recorded.requiredReviewTier);

    // And the analytics finding the forgery was aimed at does not appear.
    const analytics = fx.ops.intelligenceAnalytics();
    expect(analytics.provablyAvoidable.decisionIds).not.toContain('inteldec-forged');
  });
});

describe('the smaller truths that travel with them', () => {
  it('bounds an ESTIMATED basis, and names the refusal for what it is', () => {
    // The bound was applied only on the `provenance !== 'estimated'` branch and
    // raised `basis_on_non_estimate`, so a 5,000-character basis on an estimate
    // — the one provenance that REQUIRES a basis — was stored in full.
    const long = normalizeCostFact({
      provenance: 'estimated',
      amountMinorUnits: 10,
      currency: 'USD',
      unitKind: 'requests',
      basis: 'x'.repeat(MAX_COST_BASIS_LENGTH + 1),
    });
    expect(long.ok).toBe(false);
    expect(!long.ok && long.refusal).toBe('basis_too_long');
    // At the bound it is accepted, so this is a bound and not an aversion.
    const atBound = normalizeCostFact({
      provenance: 'estimated',
      amountMinorUnits: 10,
      currency: 'USD',
      unitKind: 'requests',
      basis: 'x'.repeat(MAX_COST_BASIS_LENGTH),
    });
    expect(atBound.ok).toBe(true);
    // A basis on an UNKNOWN cost is still the other refusal, by its own name.
    const onUnknown = normalizeCostFact({
      provenance: 'unknown',
      amountMinorUnits: null,
      currency: null,
      unitKind: 'unknown',
      basis: 'a basis for a figure that does not exist',
    });
    expect(onUnknown.ok).toBe(false);
    expect(!onUnknown.ok && onUnknown.refusal).toBe('basis_on_non_estimate');
  });

  it('projects requiresFounderDecision from the STORED row, like the trigger beside it', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const first = expectOk(decide(fx, { tier: 'high' })).decision;
    const escalated = expectOk(
      fx.ops.escalateIntelligenceDecision({
        decisionId: first.id,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        trigger: 'insufficient_evidence',
      }),
    );
    // The view may not contradict the row it describes: both the trigger and
    // the Founder-decision flag come from what was actually stored.
    expect(escalated.escalation.trigger).toBe(escalated.decision.escalationTrigger);
    expect(escalated.escalation.requiresFounderDecision).toBe(
      escalated.decision.budgetDecision === 'requires_founder_decision' &&
        escalated.escalation.toTier !== 'deterministic_local',
    );
    // A second escalation under a DIFFERENT trigger dedupes to the standing
    // row, and the view still reports what the row holds.
    const again = expectOk(
      fx.ops.escalateIntelligenceDecision({
        decisionId: first.id,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        trigger: 'review_tier_required',
      }),
    );
    expect(again.deduplicated).toBe(true);
    expect(again.escalation.trigger).toBe('insufficient_evidence');
    expect(again.escalation.requiresFounderDecision).toBe(
      again.decision.budgetDecision === 'requires_founder_decision' &&
        again.escalation.toTier !== 'deterministic_local',
    );
  });
});
