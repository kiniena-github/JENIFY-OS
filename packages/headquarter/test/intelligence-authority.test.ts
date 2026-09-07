/**
 * Phase 14 — AUTHORITY. Who may record an observation, who may set a ceiling,
 * who may record a decision, an outcome and a cost, what safe mode refuses,
 * and the four negatives the phase turns on:
 *
 *  - a recorded decision NEVER substitutes a provider, and never touches the
 *    canonical binding that decides who executes;
 *  - a budget ceiling NEVER grants spend, and no path here activates anything;
 *  - an unknown cost stays unknown, across a restart;
 *  - a cheaper tier NEVER bypasses a required reviewer tier.
 *
 * The enforcement-safe reads are pinned hostilely, on the instance, on the
 * prototype, and against a facade constructed AFTER the patch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import { intelligenceFixture, type IntelligenceFixture } from './intelligence.fixture.js';
import { claimSideEffectTask } from './reliability.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { openHqDatabase } from '../src/store/db.js';
import {
  INTELLIGENCE_COMMAND_CAPABILITY,
  INTELLIGENCE_TIERS,
  registerIntelligenceCommandCapability,
} from '../src/application/intelligence-command.js';
import { EXECUTION_PROVIDER_KEY, readProviderBinding } from '../src/operator/provider-binding.js';

function expectError(result: { ok: boolean; error?: { code: string; message: string } }): {
  code: string;
  message: string;
} {
  expect(result.ok).toBe(false);
  return result.error!;
}

function observe(fx: IntelligenceFixture, over: Record<string, unknown> = {}) {
  return fx.ops.recordModelObservation({
    providerId: 'anthropic',
    modelId: 'claude-generic',
    locality: 'cloud',
    availability: 'unknown',
    unitCostProvenance: 'unknown',
    unitCostUnitKind: 'unknown',
    source: 'founder_declared',
    observedBy: 'founder',
    ...over,
  } as Parameters<HeadquarterOperations['recordModelObservation']>[0]);
}

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

/**
 * Link the fixture's claimed task to a mission (and that mission to a project)
 * the way the canonical record does it: a `hq_mission_plan_items` row carrying
 * the task id, and `hq_missions.project_id`.
 *
 * Written directly, because what is under test is what the facade DERIVES from
 * that link — not the mission machinery that creates it. This is the exact
 * link `proposeAction` already checks a task against.
 */
function linkTaskToMission(fx: IntelligenceFixture, missionId: string, projectId: string | null): void {
  fx.db
    .prepare(
      `INSERT INTO hq_missions
         (id, title, objective, constraints, idempotency_key, created_by, created_at, updated_at,
          status_changed_at, status_changed_by, project_id)
       VALUES (?, ?, ?, '[]', ?, 'founder', ?, ?, ?, 'founder', ?)`,
    )
    .run(
      missionId,
      `Mission ${missionId}`,
      'ship the thing',
      `idem-${missionId}`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      projectId,
    );
  fx.db
    .prepare(
      `INSERT INTO hq_mission_plan_items
         (id, mission_id, seq, summary, kind, task_id, created_in_intent_seq)
       VALUES (?, ?, 1, 'the work', 'task', ?, 1)`,
    )
    .run(`item-${missionId}`, missionId, fx.claim.taskId);
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

/* ------------------------------------------------------------------ */

describe('the two FOUNDER acts are gated by the capability trio and the originate grant', () => {
  it('accepts the Founder holding the grant against a registered, intact capability', () => {
    const fx = intelligenceFixture();
    const recorded = expectOk(observe(fx));
    expect(recorded.deduplicated).toBe(false);
    expect(recorded.observation.providerId).toBe('anthropic');
    expect(recorded.observation.unitCost.state).toBe('unknown');
  });

  it('refuses a registered WORKER outright — intelligence policy is a Founder act', () => {
    const fx = intelligenceFixture();
    expect(expectError(observe(fx, { observedBy: 'claude' })).code).toBe('not_permitted');
    expect(
      expectError(
        fx.ops.setIntelligenceBudget({
          scopeKind: 'deployment',
          scopeId: 'deployment',
          window: 'total',
          ceilingMinorUnits: 100,
          currency: 'USD',
          permittedTiers: [...INTELLIGENCE_TIERS],
          setBy: 'claude',
        }),
      ).code,
    ).toBe('not_permitted');
  });

  it('refuses a principal with approval authority but no intelligence grant', () => {
    const fx = intelligenceFixture();
    expect(expectError(observe(fx, { observedBy: 'coo' })).code).toBe('not_permitted');
  });

  it('fails closed when the capability is unregistered, disabled or altered', () => {
    const missing = intelligenceFixture({ registerIntelligence: false });
    expect(expectError(observe(missing)).code).toBe('unknown_capability');

    const withheld = intelligenceFixture({ grantIntelligence: false });
    expect(expectError(observe(withheld)).code).toBe('not_permitted');

    const disabled = intelligenceFixture();
    new CapabilityRegistry(disabled.db).setEnabled(INTELLIGENCE_COMMAND_CAPABILITY.id, false);
    expect(expectError(observe(disabled)).code).toBe('capability_disabled');

    const altered = intelligenceFixture();
    new CapabilityRegistry(altered.db).register({
      ...INTELLIGENCE_COMMAND_CAPABILITY,
      riskClass: 'read_only',
    });
    const drift = expectError(observe(altered));
    expect(drift.code).toBe('not_permitted');
    expect(drift.message).toContain('drift');
  });

  it('deduplicates an identical observation and lets a deliberately fresh one through', () => {
    const fx = intelligenceFixture();
    const first = expectOk(observe(fx));
    expect(expectOk(observe(fx)).deduplicated).toBe(true);
    const fresh = expectOk(observe(fx, { idempotencyKey: 'second-look' }));
    expect(fresh.deduplicated).toBe(false);
    expect(fresh.observation.id).not.toBe(first.observation.id);
  });
});

describe('HQ never invents a price, at the facade', () => {
  it('refuses an unknown provenance carrying an amount, and an estimate with no basis', () => {
    const fx = intelligenceFixture();
    const carried = expectError(
      observe(fx, { unitCostProvenance: 'unknown', unitCostMinorUnits: 100, unitCostCurrency: 'USD' }),
    );
    expect(carried.code).toBe('cost_provenance_conflict');
    expect(carried.message).toContain('Unknown stays unknown');

    const estimated = expectError(
      observe(fx, {
        unitCostProvenance: 'estimated',
        unitCostMinorUnits: 100,
        unitCostCurrency: 'USD',
        unitCostUnitKind: 'requests',
      }),
    );
    expect(estimated.code).toBe('cost_provenance_conflict');
    expect(estimated.message).toContain('fabricated price');
  });

  it('records an unknown cost as null and never as zero, through the ledger and the analytics', () => {
    const fx = intelligenceFixture();
    const entry = expectOk(cost(fx)).entry;
    expect(entry.fact.amountMinorUnits).toBeNull();
    expect(entry.fact.state).toBe('unknown');
    const analytics = fx.ops.intelligenceAnalytics();
    expect(analytics.cost.entries).toBe(1);
    expect(analytics.cost.unknownAmountEntries).toBe(1);
    expect(analytics.cost.byCurrency).toEqual([]);
    // Wave 5 review, LOW finding 6: this used to assert `currency: 'unknown'`
    // and `knownAmountMinorUnits: 0` — a `0` that meant "unknown", beside a
    // currency code HQ invented. The assertion is corrected here rather than
    // relaxed: it now pins the stronger property.
    expect(analytics.cost.byProvider[0]).toMatchObject({
      id: 'anthropic',
      currency: null,
      knownAmountMinorUnits: null,
      unknownAmountEntries: 1,
    });
    expect(JSON.stringify(analytics.cost.byProvider)).not.toContain('"knownAmountMinorUnits":0');
  });
});

describe('a decision/outcome/cost write is authorized by the live fenced claim, and by nothing else', () => {
  it('accepts the worker holding the current claim', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const recorded = expectOk(decide(fx));
    expect(recorded.decision.taskId).toBe(fx.claim.taskId);
    expect(recorded.decision.issuedBy).toBe('claude');
    expect(recorded.decision.state).toBe('issued');
    expect(recorded.decision.result).toBe('result_unknown');
    expect(recorded.decision.grantsAuthority).toBe(false);
  });

  it('refuses a different worker, a stale fence, an unknown task and the Founder', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    expect(expectError(decide(fx, { workerId: 'jules' })).code).toBe('stale_run_claim');
    expect(expectError(decide(fx, { fence: fx.claim.fence + 7 })).code).toBe('stale_run_claim');
    expect(expectError(decide(fx, { taskId: 'task-that-never-existed' })).code).toBe('unknown_task');
    expect(expectError(decide(fx, { workerId: 'founder' })).code).toBe('stale_run_claim');
    expect(expectError(cost(fx, { workerId: 'jules' })).code).toBe('stale_run_claim');
  });

  it('reads the claim from the store, not from the patchable queue read', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const forged = {
      ...fx.ops.queue.get(fx.claim.taskId)!,
      claimedBy: 'jules',
      fence: 99,
      status: 'running' as const,
    };
    const queuePrototype = Object.getPrototypeOf(fx.ops.queue) as Record<string, unknown>;
    const realGet = queuePrototype.get;
    try {
      fx.ops.queue.get = () => forged;
      queuePrototype.get = () => forged;
      expect(expectError(decide(fx, { workerId: 'jules', fence: 99 })).code).toBe('stale_run_claim');
      expect(expectError(cost(fx, { workerId: 'jules', fence: 99 })).code).toBe('stale_run_claim');
      // The legitimate claim still works, so the patch changed nothing at all.
      expect(expectOk(decide(fx)).decision.issuedBy).toBe('claude');
    } finally {
      queuePrototype.get = realGet;
    }
  });

  it('records exactly one outcome per decision, by construction', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const decision = expectOk(decide(fx)).decision;
    const first = expectOk(
      fx.ops.recordIntelligenceOutcome({
        decisionId: decision.id,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        result: 'quality_met',
      }),
    );
    expect(first.deduplicated).toBe(false);
    expect(first.decision.state).toBe('settled');
    expect(first.decision.result).toBe('quality_met');
    // A second report cannot overwrite the first.
    const second = expectOk(
      fx.ops.recordIntelligenceOutcome({
        decisionId: decision.id,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        result: 'quality_not_met',
      }),
    );
    expect(second.deduplicated).toBe(true);
    expect(second.decision.result).toBe('quality_met');
  });
});

describe('no silent model substitution — the canonical binding is the authority', () => {
  function boundFixture(): { fx: IntelligenceFixture; taskId: string; fence: number } {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // Declare `claude` as the CLAUDE executor and bind a task to CLAUDE.
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'founder' }));
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'bound', [EXECUTION_PROVIDER_KEY]: 'CLAUDE' },
        idempotencyKey: 'bound-task',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr, undefined, created.task.id));
    return { fx, taskId: claimed.id, fence: claimed.fence };
  }

  it('RECORDS the provider the canonical payload binds, and never proposes another', () => {
    const { fx, taskId, fence } = boundFixture();
    const recorded = expectOk(decide(fx, { taskId, fence }));
    expect(recorded.decision.boundProvider).toBe('CLAUDE');
    // The canonical binding is untouched by the recording.
    const task = fx.ops.queue.get(taskId)!;
    expect(readProviderBinding(task.payload)).toEqual({ bound: true, provider: 'CLAUDE' });
  });

  it('exposes NO facade method that accepts a provider to route work to', () => {
    const fx = intelligenceFixture();
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(fx.ops) as object),
      ...Object.getOwnPropertyNames(fx.ops),
    ].filter((name) => /intelligence|Intelligence|ModelObservation|Cost|Budget/.test(name));
    expect(surface.length).toBeGreaterThan(0);
    // Phase 10 pinned that no facade method name matches /recommend/i, and
    // this phase keeps that: a proposal must never look like a handle on an
    // act, and none of the names below suggests one.
    expect(surface.filter((name) => /recommend/i.test(name))).toEqual([]);
    // A routing proposal's own SHAPE cannot name an executor either.
    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.readOnlyClaim.taskId,
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
      }),
    );
    expect(Object.keys(proposal)).not.toContain('providerId');
    expect(Object.keys(proposal)).not.toContain('modelId');
    expect(proposal.grantsAuthority).toBe(false);
    expect(proposal.authorizesSpend).toBe(false);
  });

  it('leaves the binding enforcement untouched: another provider’s worker still cannot claim', () => {
    const { fx, taskId, fence } = boundFixture();
    expectOk(decide(fx, { taskId, fence }));
    // `jules` is declared as a DIFFERENT provider and must still be refused by
    // the canonical claim path — a recorded decision changed nothing about it.
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'jules', providerId: 'GEMINI', founderId: 'founder' }));
    const other = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'bound-2', [EXECUTION_PROVIDER_KEY]: 'CLAUDE' },
        idempotencyKey: 'bound-task-2',
        requestedBy: 'claude',
      }),
    );
    // The binding removes `jules` as a candidate entirely: it is offered
    // nothing, while the bound provider's worker still claims it normally.
    const refused = expectError(
      fx.ops.claimNext('jules', CAPS.openPr, undefined, other.task.id) as {
        ok: boolean;
        error?: { code: string; message: string };
      },
    );
    expect(refused.message).toContain('No substitution is made');
    expect(expectOk(fx.ops.claimNext('claude', CAPS.openPr, undefined, other.task.id)).id).toBe(
      other.task.id,
    );
  });

  it('does not change the task’s status, fence, claimant or payload', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const before = fx.ops.queue.get(fx.claim.taskId)!;
    expectOk(decide(fx));
    expectOk(cost(fx));
    const after = fx.ops.queue.get(fx.claim.taskId)!;
    expect(after.status).toBe(before.status);
    expect(after.fence).toBe(before.fence);
    expect(after.claimedBy).toBe(before.claimedBy);
    expect(after.payload).toEqual(before.payload);
    // And the task's own lifecycle still works.
    expect(expectOk(fx.ops.startTask(fx.claim.taskId, 'claude', fx.claim.fence)).status).toBe('running');
  });
});

describe('a cheaper tier cannot bypass a required reviewer tier, at the facade', () => {
  it('refuses a tier below the required review tier by name', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // `github.open_pr` is `external_side_effect`, so its review tier is `high`.
    const refusal = expectError(decide(fx, { tier: 'low_cost' }));
    expect(refusal.code).toBe('review_tier_required');
    expect(refusal.message).toContain('never bypasses a required reviewer tier');
    // And the strong tier is accepted.
    expect(expectOk(decide(fx, { tier: 'critical_review' })).decision.tier).toBe('critical_review');
  });

  it('refuses a tier below the computed floor when no review is required', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const refusal = expectError(
      fx.ops.recordIntelligenceDecision({
        taskId: fx.readOnlyClaim.taskId,
        workerId: fx.readOnlyClaim.workerId,
        fence: fx.readOnlyClaim.fence,
        label: 'read the CI status',
        complexity: 'novel',
        contextSize: 'small',
        workKind: 'classification',
        tier: 'low_cost',
      }),
    );
    expect(refusal.code).toBe('tier_below_policy_floor');
    expect(refusal.message).toContain('Cheapest is bounded by');
  });

  it('refuses a tier the policy does not permit, however strong it is', () => {
    const fx = intelligenceFixture();
    fx.budget(['deterministic_local', 'low_cost']);
    const refusal = expectError(
      fx.ops.recordIntelligenceDecision({
        taskId: fx.readOnlyClaim.taskId,
        workerId: fx.readOnlyClaim.workerId,
        fence: fx.readOnlyClaim.fence,
        label: 'read the CI status',
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
        tier: 'critical_review',
      }),
    );
    expect(refusal.code).toBe('tier_not_permitted');
  });

  it('takes the RISK CLASS from canonical truth, not from the caller', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // No parameter describes risk; the side-effect task's own capability does.
    const sideEffect = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
      }),
    );
    expect(sideEffect.characteristics.riskClass).toBe('external_side_effect');
    expect(sideEffect.requiredReviewTier).toBe('high');
    const readOnly = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.readOnlyClaim.taskId,
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
      }),
    );
    expect(readOnly.characteristics.riskClass).toBe('read_only');
    expect(readOnly.requiredReviewTier).toBeNull();
    expect(readOnly.tier).toBe('deterministic_local');
  });

  /**
   * Wave 5 Medium 5, as the exploit that found it. `op_capabilities` carries no
   * immutability triggers — enabling and disabling a capability is a legitimate
   * UPDATE — so one raw `UPDATE ... SET risk_class = 'totally_harmless'` used to
   * become a typed `RiskClass` by assertion. `RISK_FLOOR[...]` and
   * `REVIEW_REQUIREMENT[...]` then read `undefined`, the floor fell from `high`
   * to `deterministic_local`, and `proposalSatisfiesReviewRequirement` treats a
   * null requirement as satisfied — so `deterministic_local` was ACCEPTED on an
   * `external_side_effect` task.
   */
  it('fails CLOSED on a risk class outside the vocabulary, rather than dropping the floor', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.db.prepare(`UPDATE op_capabilities SET risk_class = ? WHERE id = ?`).run(
      'totally_harmless',
      CAPS.openPr,
    );

    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
      }),
    );
    // The strictest class, not the convenient one.
    expect(proposal.characteristics.riskClass).toBe('founder_gate');
    expect(proposal.requiredReviewTier).toBe('critical_review');
    expect(proposal.floorTier).toBe('critical_review');
    // And the forged string never becomes a published value.
    expect(JSON.stringify(proposal)).not.toContain('totally_harmless');

    const refusal = expectError(
      fx.ops.recordIntelligenceDecision({
        taskId: fx.claim.taskId,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        label: 'cheap work on forged-risk work',
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
        tier: 'deterministic_local',
      }),
    );
    expect(refusal.code).toBe('review_tier_required');
  });
});

describe('a local model is accepted when policy permits, and paid tiers are never assumed', () => {
  it('routes read-only work to the free local tier with NO budget recorded at all', () => {
    const fx = intelligenceFixture();
    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.readOnlyClaim.taskId,
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
      }),
    );
    expect(proposal.budgetDecision).toBe('requires_founder_decision');
    expect([...proposal.permittedTiers]).toEqual(['deterministic_local']);
    expect(proposal.tier).toBe('deterministic_local');
    expect(proposal.localPathTaken).toBe(true);
    expect(proposal.requiresFounderDecision).toBe(false);
    // And it can actually be RECORDED, so the local path is not decorative.
    const recorded = expectOk(
      fx.ops.recordIntelligenceDecision({
        taskId: fx.readOnlyClaim.taskId,
        workerId: fx.readOnlyClaim.workerId,
        fence: fx.readOnlyClaim.fence,
        label: 'read the CI status',
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
      }),
    );
    expect(recorded.decision.tier).toBe('deterministic_local');
  });

  it('refuses to route side-effect work anywhere while no budget policy exists', () => {
    // The absence of a Founder policy is never permission to use a paid tier.
    const fx = intelligenceFixture();
    const refusal = expectError(decide(fx));
    expect(refusal.code).toBe('intelligence_routing_refused');
    expect(refusal.message).toContain('no_permitted_tier');
  });

  it('records a LOCAL model observation with a free unit cost and no invented price', () => {
    const fx = intelligenceFixture();
    const recorded = expectOk(
      observe(fx, {
        providerId: 'local-custom',
        modelId: 'local-generic',
        locality: 'local',
        availability: 'unknown',
        capabilityFacts: ['offline_capable', 'code_generation'],
        unitCostProvenance: 'billed',
        unitCostMinorUnits: 0,
        unitCostCurrency: 'USD',
        unitCostUnitKind: 'requests',
        source: 'runtime_observed',
      }),
    );
    expect(recorded.observation.locality).toBe('local');
    expect(recorded.observation.unitCost.amountMinorUnits).toBe(0);
    expect(recorded.observation.unitCost.provenance).toBe('billed');
    expect(fx.ops.intelligenceAnalytics().observations).toMatchObject({ local: 1, cloud: 0 });
  });
});

describe('a budget ceiling blocks a paid act or requires a decision — and never grants one', () => {
  it('blocks a decision once recorded spend reaches the ceiling', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS], { ceilingMinorUnits: 100 });
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 100,
        currency: 'USD',
        unitKind: 'requests',
      }),
    );
    expect(fx.ops.intelligenceBudgetDecision({
      scopeKind: 'deployment',
      scopeId: 'deployment',
      window: 'total',
    })).toMatchObject({ ok: true });
    const evaluation = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'deployment',
        scopeId: 'deployment',
        window: 'total',
      }),
    );
    expect(evaluation.decision).toBe('blocked');
    expect(evaluation.grantsSpend).toBe(false);
    const refusal = expectError(decide(fx, { tier: 'high' }));
    expect(refusal.code).toBe('budget_ceiling_blocks');
    // With no explicit tier the proposal itself refuses, for the same reason.
    expect(expectError(decide(fx)).code).toBe('intelligence_routing_refused');
  });

  it('requires a Founder decision while any recorded cost is unknown', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS], { ceilingMinorUnits: 100_000 });
    expectOk(cost(fx));
    const evaluation = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'deployment',
        scopeId: 'deployment',
        window: 'total',
      }),
    );
    expect(evaluation.decision).toBe('requires_founder_decision');
    expect(evaluation.unknownAmountEntries).toBe(1);
    // The work is still routable, and the proposal SAYS a human is needed.
    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    expect(proposal.tier).toBe('high');
    expect(proposal.requiresFounderDecision).toBe(true);
  });

  it('exposes no method and no field anywhere that grants spend or activates a provider', () => {
    const fx = intelligenceFixture();
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(fx.ops) as object),
      ...Object.getOwnPropertyNames(fx.ops),
    ];
    expect(
      surface.filter((name) => /activateProvider|enablePaid|purchase|buyCredits|authorizeSpend|topUp/i.test(name)),
    ).toEqual([]);
    const posture = fx.ops.hqIntelligencePosture();
    expect(posture.canActivatePaidProvider).toBe(false);
    expect(posture.canSpend).toBe(false);
  });

  it('versions the ceiling append-only: a new policy is a new row, and the old one survives', () => {
    const fx = intelligenceFixture();
    fx.budget(['deterministic_local'], { ceilingMinorUnits: 100 });
    fx.budget([...INTELLIGENCE_TIERS], { ceilingMinorUnits: 500 });
    const budgets = fx.ops.listIntelligenceBudgetsBounded();
    expect(budgets.total).toBe(2);
    expect(budgets.budgets.map((entry) => entry.version).sort()).toEqual([1, 2]);
    const evaluation = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'deployment',
        scopeId: 'deployment',
        window: 'total',
      }),
    );
    expect(evaluation.ceilingMinorUnits).toBe(500);
    expect([...evaluation.permittedTiers]).toEqual([...INTELLIGENCE_TIERS]);
  });
});

/**
 * Wave 5 High 2, High 3 and Medium 8: WHICH ceiling applies, and WHAT a spend
 * is attributed to, are canonical facts about the task — never caller
 * parameters.
 */
describe('the applicable budget scope and the spend attribution are derived, not chosen', () => {
  it('binds EVERY applicable scope at once, so a permissive one cannot be named instead', () => {
    const fx = intelligenceFixture();
    linkTaskToMission(fx, 'mission-alpha', 'project-alpha');
    // The deployment policy is strict: local only.
    fx.budget(['deterministic_local']);
    // A permissive policy on a mission this task is NOT part of. Under the old
    // caller-supplied `budgetScope`, naming it moved an external_side_effect
    // task from `refusal: no_permitted_tier` to `tier: high`.
    fx.budget([...INTELLIGENCE_TIERS], { scopeKind: 'mission', scopeId: 'some-other-mission' });

    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    expect([...proposal.permittedTiers]).toEqual(['deterministic_local']);
    expect(proposal.tier).toBeNull();
    expect(proposal.refusal).toBe('no_permitted_tier');

    // And there is no parameter that could have named the other scope: the
    // signature has none, and smuggling one through changes nothing.
    const smuggled = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
        ...({
          budgetScope: { scopeKind: 'mission', scopeId: 'some-other-mission', window: 'total' },
        } as unknown as Record<string, never>),
      }),
    );
    expect(smuggled.refusal).toBe('no_permitted_tier');

    const refusal = expectError(decide(fx, { tier: 'high' }));
    expect(refusal.code).toBe('tier_not_permitted');
  });

  it('takes the MOST RESTRICTIVE answer when the task’s own mission ceiling is tighter', () => {
    const fx = intelligenceFixture();
    linkTaskToMission(fx, 'mission-alpha', 'project-alpha');
    fx.budget([...INTELLIGENCE_TIERS]);
    // The task's OWN mission permits only the local tier.
    fx.budget(['deterministic_local'], { scopeKind: 'mission', scopeId: 'mission-alpha' });
    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    // The intersection of the two permitted sets.
    expect([...proposal.permittedTiers]).toEqual(['deterministic_local']);
    expect(expectError(decide(fx, { tier: 'high' })).code).toBe('tier_not_permitted');
  });

  it('is not evaded by naming a different WINDOW: a day ceiling that is reached still blocks', () => {
    const fx = intelligenceFixture();
    // Deployment/total is generous; deployment/DAY is exhausted.
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.budget([...INTELLIGENCE_TIERS], { window: 'day', ceilingMinorUnits: 100 });
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 100,
        currency: 'USD',
        unitKind: 'requests',
      }),
    );
    const proposal = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    expect(proposal.budgetDecision).toBe('blocked');
    expect(proposal.tier).toBeNull();
    expect(expectError(decide(fx, { tier: 'low_cost' })).code).toBe('budget_ceiling_blocks');
  });

  it('measures a day ceiling on the instant HQ stamped, not on the one the caller declares', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.budget([...INTELLIGENCE_TIERS], { window: 'day', ceilingMinorUnits: 100 });
    // 90 of 100 observed.
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 90,
        currency: 'USD',
        unitKind: 'requests',
        idempotencyKey: 'first',
      }),
    );
    // A shape that PASSES the old `/^\d{4}-\d{2}-\d{2}T/` check and is not a
    // date at all. It is refused outright now.
    const nonsense = cost(fx, {
      provenance: 'billed',
      amountMinorUnits: 1_000_000,
      currency: 'USD',
      unitKind: 'requests',
      occurredAt: '0000-00-00T00:00:00Z',
      idempotencyKey: 'the-evasion',
    });
    expect(nonsense.ok).toBe(false);
    expect(!nonsense.ok && nonsense.error.message).toMatch(/real ISO-8601 instant/);

    // So is a future one.
    const future = cost(fx, {
      provenance: 'billed',
      amountMinorUnits: 1_000_000,
      currency: 'USD',
      unitKind: 'requests',
      occurredAt: '2999-01-01T00:00:00.000Z',
      idempotencyKey: 'the-other-evasion',
    });
    expect(future.ok).toBe(false);
    expect(!future.ok && future.error.message).toMatch(/future/);

    // And a valid-but-OLD occurredAt no longer moves the entry out of today's
    // window: the window is measured on recordedAt, which HQ sets.
    //
    // Twenty days back rather than this lane's original `2020-01-01`: the
    // merged implementation also carries the other lane's bound on how far
    // `occurredAt` may sit from the clock (at most one hour ahead, thirty days
    // behind), so a six-year-old instant is refused outright now and cannot be
    // used to demonstrate this property. The property itself is unchanged and
    // is what this assertion pins — a backdated entry still counts in TODAY's
    // window, because the window reads `recorded_at`.
    const backdated = new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString();
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 1_000_000,
        currency: 'USD',
        unitKind: 'requests',
        occurredAt: backdated,
        idempotencyKey: 'the-backdated-one',
      }),
    );
    const evaluation = expectOk(
      fx.ops.intelligenceBudgetDecision({ scopeKind: 'deployment', scopeId: 'deployment', window: 'day' }),
    );
    expect(evaluation.observedMinorUnits).toBe(1_000_090);
    expect(evaluation.decision).toBe('blocked');
  });

  it('derives mission and project attribution, and refuses a decision id from another task', () => {
    const fx = intelligenceFixture();
    linkTaskToMission(fx, 'mission-alpha', 'project-alpha');
    fx.budget([...INTELLIGENCE_TIERS]);
    const decision = expectOk(decide(fx, { tier: 'high' })).decision;
    expect(decision.missionId).toBe('mission-alpha');
    expect(decision.projectId).toBe('project-alpha');

    // A cost entry inherits the same canonical attribution, with no parameter
    // that could omit it or invent one.
    const entry = expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 250,
        currency: 'USD',
        unitKind: 'requests',
        decisionId: decision.id,
        ...({ missionId: 'x'.repeat(5000), projectId: '<script>x</script>' } as unknown as Record<
          string,
          never
        >),
      }),
    ).entry;
    expect(entry.missionId).toBe('mission-alpha');
    expect(entry.projectId).toBe('project-alpha');
    expect(JSON.stringify(entry)).not.toContain('<script>');

    // The mission ceiling now SEES that spend, which is the whole point:
    // omitting `missionId` used to hide it.
    fx.budget([...INTELLIGENCE_TIERS], {
      scopeKind: 'mission',
      scopeId: 'mission-alpha',
      ceilingMinorUnits: 200,
    });
    const missionCeiling = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'mission',
        scopeId: 'mission-alpha',
        window: 'total',
      }),
    );
    expect(missionCeiling.observedMinorUnits).toBe(250);
    expect(missionCeiling.decision).toBe('blocked');

    // A decision id belonging to another task is refused rather than stored.
    const other = claimSideEffectTask(fx, 'another-piece-of-work');
    const foreign = fx.ops.recordIntelligenceCost({
      taskId: other.taskId,
      workerId: other.workerId,
      fence: other.fence,
      providerId: 'anthropic',
      provenance: 'unknown',
      unitKind: 'unknown',
      decisionId: decision.id,
    });
    expect(foreign.ok).toBe(false);
    expect(!foreign.ok && foreign.error.code).toBe('invalid_input');
    expect(!foreign.ok && foreign.error.message).toMatch(/belongs to a different task/);
    // The refusal does NOT echo the caller's id back (Wave 5 Low 8).
    expect(!foreign.ok && foreign.error.message).not.toContain(decision.id);
  });

  /**
   * Wave 5 LOW 8. `decisionId` is the one id a caller still passes into this
   * phase, and it was unbounded, unscanned and interpolated verbatim into
   * `Unknown routing decision: ${decisionId}` — the same gap that justified
   * removing the caller-supplied `missionId` / `projectId` in the previous
   * round. It is now shape-checked against a bound before anything reads the
   * store, and the refusal carries the code alone.
   */
  it('bounds decisionId and refuses with the code rather than echoing it', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const enormous = 'a'.repeat(5000);
    const scripted = '<script>alert(1)</script>';
    for (const hostile of [enormous, scripted, 'UPPERCASE-IS-NOT-A-SLUG']) {
      const refused = cost(fx, { decisionId: hostile });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('an unbounded decision id was accepted');
      expect(refused.error.code).toBe('invalid_input');
      expect(refused.error.message).not.toContain(hostile);
      expect(refused.error.message.length).toBeLessThan(200);
    }
    // Whitespace only is the ABSENCE of a citation, which stays legitimate.
    expectOk(cost(fx, { decisionId: '  ' }));
    // A well-shaped id that simply is not in the ledger refuses too, and still
    // does not echo it back.
    const unknown = fx.ops.recordIntelligenceCost({
      taskId: fx.claim.taskId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      providerId: 'anthropic',
      provenance: 'unknown',
      unitKind: 'unknown',
      decisionId: 'inteldec-00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error('an unknown decision id was accepted');
    expect(unknown.error.code).toBe('unknown_intelligence_decision');
    expect(unknown.error.message).not.toContain('inteldec-00000000');
    // The same bound applies on the other two paths that take a caller's id.
    const escalated = fx.ops.escalateIntelligenceDecision({
      decisionId: enormous,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      toTier: 'high',
      trigger: 'review_tier_required',
    } as Parameters<HeadquarterOperations['escalateIntelligenceDecision']>[0]);
    expect(escalated.ok).toBe(false);
    expect(!escalated.ok && escalated.error.message).not.toContain(enormous);
    const outcome = fx.ops.recordIntelligenceOutcome({
      decisionId: enormous,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      result: 'quality_met',
    } as Parameters<HeadquarterOperations['recordIntelligenceOutcome']>[0]);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.message).not.toContain(enormous);
  });

  /**
   * Wave 5 Medium 3, as the exploit that found it.
   *
   * The whole mission/project half of `BUDGET_SCOPES` reaches a task through
   * ONE row: `hq_mission_plan_items.task_id`. The older readers of that link
   * check that a row EXISTS, so a delete fails them closed. The Phase 14
   * budget derivation reads its ABSENCE as "this task belongs to no mission"
   * and fails OPEN — so with an exhausted `mission/mission-alpha/total`
   * ceiling, one DELETE turned a `blocked` proposal restricted to
   * `deterministic_local` into `within_ceiling` with the full tier set. And
   * because `hq_mission_plan_items` was outside `ENGINE_IMMUTABLE_TABLES`
   * entirely, the integrity census reported nothing about it either.
   *
   * The engine now refuses the DELETE, from any writer, and the census sees
   * the guard.
   */
  it('cannot have a mission ceiling unbound by deleting the plan-item link', () => {
    const fx = intelligenceFixture();
    linkTaskToMission(fx, 'mission-alpha', null);
    fx.budget([...INTELLIGENCE_TIERS]);
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 250,
        currency: 'USD',
        unitKind: 'requests',
      }),
    );
    fx.budget(['deterministic_local'], {
      scopeKind: 'mission',
      scopeId: 'mission-alpha',
      ceilingMinorUnits: 200,
    });
    const blocked = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    expect(blocked.budgetDecision).toBe('blocked');
    expect([...blocked.permittedTiers]).toEqual(['deterministic_local']);

    // THE EXPLOIT. The link row is the only thing binding this task to the
    // exhausted ceiling, and the engine — not this module's discipline —
    // refuses to let it go.
    expect(() =>
      fx.db.prepare(`DELETE FROM hq_mission_plan_items WHERE task_id = ?`).run(fx.claim.taskId),
    ).toThrow(/never erased/);

    const after = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: fx.claim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
    expect(after.budgetDecision).toBe('blocked');
    expect([...after.permittedTiers]).toEqual(['deterministic_local']);
  });
});

describe('escalation preserves canonical task identity through the facade', () => {
  it('creates a second decision on the SAME task, mission and project, one tier up', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // The mission and project are CANONICAL, not parameters. They used to be
    // The other lane's version of this test wrote the same link with raw rows
    // (`linkTaskToMission`, still used above) and asserted the ids on the
    // FIRST decision as literals; those two assertions are kept below against
    // the canonically created ids, so nothing it pinned is lost.
    // free-text arguments written verbatim, which is what let a worker
    // attribute its spend to a mission that does not exist or to somebody
    // else's (Wave 5 review, High finding B-2). The identity this test is
    // about is therefore established the way HQ actually records it — a
    // commanded mission, a work plan item linked to the task, the mission
    // assigned to a project — and the assertions below are strictly stronger
    // for it: they now prove the ids came from the plan.
    const canonical = fx.linkToCanonicalMission(fx.claim.taskId, 'alpha');
    const first = expectOk(decide(fx, { tier: 'high' })).decision;
    const escalated = expectOk(
      fx.ops.escalateIntelligenceDecision({
        decisionId: first.id,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        trigger: 'insufficient_evidence',
      }),
    );
    expect(escalated.decision.taskId).toBe(first.taskId);
    expect(first.missionId).toBe(canonical.missionId);
    expect(first.projectId).toBe(canonical.projectId);
    expect(escalated.decision.missionId).toBe(canonical.missionId);
    expect(escalated.decision.projectId).toBe(canonical.projectId);
    expect(escalated.decision.tier).toBe('critical_review');
    expect(escalated.decision.escalatedFrom).toBe(first.id);
    expect(escalated.escalation.grantsAuthority).toBe(false);
    expect(escalated.escalation.authorizesSpend).toBe(false);
    // The prior decision now reads as escalated away, and the canonical task is
    // untouched by any of it.
    expect(fx.ops.getIntelligenceDecision(first.id)!.state).toBe('escalated_away');
    expect(fx.ops.queue.get(fx.claim.taskId)!.status).toBe('assigned');
  });

  it('takes NO task, mission or project parameter — the identity cannot be moved', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const first = expectOk(decide(fx, { tier: 'high' })).decision;
    // The signature accepts only decisionId/workerId/fence/trigger/idempotency.
    const escalated = expectOk(
      fx.ops.escalateIntelligenceDecision({
        decisionId: first.id,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        trigger: 'review_tier_required',
        // A stray canonical id is simply not a parameter: TypeScript rejects
        // it on the literal, and the implementation reads the identity off the
        // prior decision rather than off the input, so smuggling it through an
        // `unknown` cast changes nothing either.
        ...({ taskId: 'some-other-task', missionId: 'some-other-mission' } as unknown as Record<
          string,
          never
        >),
      }),
    );
    expect(escalated.decision.taskId).toBe(first.taskId);
    expect(escalated.decision.missionId).toBeNull();
  });

  it('refuses an escalation whose claim is not held by the caller', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const first = expectOk(decide(fx, { tier: 'high' })).decision;
    expect(
      expectError(
        fx.ops.escalateIntelligenceDecision({
          decisionId: first.id,
          workerId: 'jules',
          fence: fx.claim.fence,
          trigger: 'insufficient_evidence',
        }),
      ).code,
    ).toBe('stale_run_claim');
  });

  it('refuses when the permitted set has no higher tier, rather than inventing one', () => {
    const fx = intelligenceFixture();
    fx.budget(['deterministic_local']);
    const first = expectOk(
      fx.ops.recordIntelligenceDecision({
        taskId: fx.readOnlyClaim.taskId,
        workerId: fx.readOnlyClaim.workerId,
        fence: fx.readOnlyClaim.fence,
        label: 'read the CI status',
        complexity: 'trivial',
        contextSize: 'small',
        workKind: 'classification',
      }),
    ).decision;
    const refusal = expectError(
      fx.ops.escalateIntelligenceDecision({
        decisionId: first.id,
        workerId: fx.readOnlyClaim.workerId,
        fence: fx.readOnlyClaim.fence,
        trigger: 'tier_did_not_meet_requirement',
      }),
    );
    expect(refusal.code).toBe('escalation_refused');
    expect(refusal.message).toContain('no_higher_permitted_tier');
  });

  it('refuses an unknown decision id', () => {
    const fx = intelligenceFixture();
    expect(
      expectError(
        fx.ops.escalateIntelligenceDecision({
          decisionId: 'inteldec-nope',
          workerId: fx.claim.workerId,
          fence: fx.claim.fence,
          trigger: 'insufficient_evidence',
        }),
      ).code,
    ).toBe('unknown_intelligence_decision');
  });

  /**
   * Wave 5 review, LOW finding 4. `decisionIdempotencyKey` deliberately
   * excludes the escalation trigger, so a second escalation naming a DIFFERENT
   * trigger dedupes to the row already held. The returned view used to carry
   * the CALLER's trigger regardless — a categorical reason contradicting the
   * record it claims to describe, which is precisely what law 8 forbids.
   */
  it('returns the STORED escalation trigger when a second call dedupes to the same row', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const first = expectOk(decide(fx, { tier: 'high' })).decision;
    const escalate = (trigger: string) =>
      expectOk(
        fx.ops.escalateIntelligenceDecision({
          decisionId: first.id,
          workerId: fx.claim.workerId,
          fence: fx.claim.fence,
          trigger: trigger as never,
        }),
      );

    const original = escalate('insufficient_evidence');
    expect(original.deduplicated).toBe(false);
    expect(original.escalation.trigger).toBe('insufficient_evidence');
    expect(original.decision.escalationTrigger).toBe('insufficient_evidence');

    const again = escalate('tier_did_not_meet_requirement');
    // One row, and the view agrees with it in BOTH places.
    expect(again.deduplicated).toBe(true);
    expect(again.decision.id).toBe(original.decision.id);
    expect(again.decision.escalationTrigger).toBe('insufficient_evidence');
    expect(again.escalation.trigger).toBe('insufficient_evidence');
    expect(again.escalation.trigger).toBe(again.decision.escalationTrigger);
    // And the ledger really does hold exactly one escalation.
    expect(
      fx.ops.listIntelligenceDecisionsBounded().decisions.filter((d) => d.escalatedFrom === first.id),
    ).toHaveLength(1);
  });
});

describe('the enforcement-safe reads survive a hostile patch of the public surface', () => {
  it('forges a budget on the instance, the prototype and a later facade — and buys nothing', () => {
    const fx = intelligenceFixture();
    // No budget is recorded, so only the free local tier is permitted and the
    // side-effect task is unroutable. A patch that claims otherwise must not
    // change that.
    const forgedEvaluation = {
      ok: true as const,
      data: {
        decision: 'within_ceiling' as const,
        ceilingMinorUnits: 1_000_000,
        currency: 'USD',
        observedMinorUnits: 0,
        unknownAmountEntries: 0,
        otherCurrencyEntries: 0,
        permittedTiers: [...INTELLIGENCE_TIERS],
        reason: 'forged',
        grantsSpend: false as const,
        authorizesPaidActivation: false as const,
        statement: 'forged',
      },
    };
    const prototype = Object.getPrototypeOf(fx.ops) as Record<string, unknown>;
    const realDecision = prototype.intelligenceBudgetDecision;
    const realList = prototype.listIntelligenceBudgetsBounded;
    try {
      fx.ops.intelligenceBudgetDecision = () => forgedEvaluation;
      prototype.intelligenceBudgetDecision = () => forgedEvaluation;
      fx.ops.listIntelligenceBudgetsBounded = () => ({
        budgets: [
          {
            id: 'forged',
            seq: 1,
            scopeKind: 'deployment' as const,
            scopeId: 'deployment',
            window: 'total' as const,
            ceilingMinorUnits: 1_000_000,
            currency: 'USD',
            permittedTiers: [...INTELLIGENCE_TIERS],
            version: 99,
            setAt: '2026-01-01T00:00:00.000Z',
            setBy: 'nobody',
            note: null,
            statement: 'forged',
          },
        ],
        total: 1,
        truncated: false,
      });
      prototype.listIntelligenceBudgetsBounded = fx.ops.listIntelligenceBudgetsBounded;

      // The patch TOOK — the public read lies.
      expect(expectOk(
        fx.ops.intelligenceBudgetDecision({
          scopeKind: 'deployment',
          scopeId: 'deployment',
          window: 'total',
        }),
      ).decision).toBe('within_ceiling');
      // And it buys nothing: the write still refuses.
      expect(expectError(decide(fx)).code).toBe('intelligence_routing_refused');
      expect(expectError(decide(fx, { tier: 'high' })).code).toBe('tier_not_permitted');

      // A facade constructed AFTER the patch refuses identically.
      const later = new HeadquarterOperations(fx.db, {
        store: new HeadquarterStore(fx.db),
        policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
      });
      expect(
        expectError(
          later.recordIntelligenceDecision({
            taskId: fx.claim.taskId,
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
            label: 'open the release PR',
            complexity: 'routine',
            contextSize: 'medium',
            workKind: 'coding',
            tier: 'high',
          }),
        ).code,
      ).toBe('tier_not_permitted');
    } finally {
      prototype.intelligenceBudgetDecision = realDecision;
      prototype.listIntelligenceBudgetsBounded = realList;
    }
  });

  it('forges a decision on the public reads and buys no escalation and no analytics finding', () => {
    const fx = intelligenceFixture();
    const forged = {
      id: 'inteldec-forged',
      seq: 1,
      taskId: fx.claim.taskId,
      missionId: null,
      projectId: null,
      tier: 'critical_review' as const,
      floorTier: 'deterministic_local' as const,
      requiredReviewTier: null,
      escalatedFrom: null,
      escalationTrigger: null,
      boundProvider: null,
      characteristics: null,
      permittedTiers: [...INTELLIGENCE_TIERS],
      budgetDecision: 'within_ceiling' as const,
      label: 'forged',
      issuedAt: '2026-01-01T00:00:00.000Z',
      issuedBy: 'nobody',
      processId: 'nobody',
      state: 'issued' as const,
      result: 'quality_met' as const,
      reviewedByTier: null,
      escalatedAwayTo: null,
      satisfiesReviewRequirement: true,
      grantsAuthority: false as const,
      statement: 'forged',
    };
    const prototype = Object.getPrototypeOf(fx.ops) as Record<string, unknown>;
    const realGet = prototype.getIntelligenceDecision;
    const realList = prototype.listIntelligenceDecisionsBounded;
    try {
      fx.ops.getIntelligenceDecision = () => forged;
      prototype.getIntelligenceDecision = () => forged;
      fx.ops.listIntelligenceDecisionsBounded = () => ({
        decisions: [forged],
        total: 1,
        truncated: false,
      });
      prototype.listIntelligenceDecisionsBounded = fx.ops.listIntelligenceDecisionsBounded;

      // The patch TOOK.
      expect(fx.ops.getIntelligenceDecision('inteldec-forged')!.result).toBe('quality_met');
      // And it buys nothing: the escalation path does not see it, and the
      // analytics and the snapshot are folded from the private reads.
      expect(
        expectError(
          fx.ops.escalateIntelligenceDecision({
            decisionId: 'inteldec-forged',
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
            trigger: 'insufficient_evidence',
          }),
        ).code,
      ).toBe('unknown_intelligence_decision');
      expect(fx.ops.intelligenceAnalytics().decisions.total).toBe(0);
      expect(fx.ops.intelligenceSummary().decisions).toBe(0);

      const later = new HeadquarterOperations(fx.db, {
        store: new HeadquarterStore(fx.db),
        policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
      });
      expect(later.intelligenceSummary().decisions).toBe(0);
    } finally {
      prototype.getIntelligenceDecision = realGet;
      prototype.listIntelligenceDecisionsBounded = realList;
    }
  });
});

describe('safe mode gates every spend-adjacent and policy-adjacent write', () => {
  function tamperedFixture(): {
    ops: HeadquarterOperations;
    claim: { taskId: string; workerId: string; fence: number };
    cleanup: () => void;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-intel-safe-'));
    const dbPath = path.join(dir, 'headquarter.sqlite');
    const first = openHqDatabase(dbPath);
    const store = new HeadquarterStore(first);
    const ops = new HeadquarterOperations(first, {
      store,
      policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
    });
    new CapabilityRegistry(first).register({
      id: CAPS.openPr,
      description: 'Open a branch-isolated PR',
      riskClass: 'external_side_effect',
      sideEffect: true,
      idempotent: true,
    });
    registerIntelligenceCommandCapability(first);
    store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.openPr],
      active: true,
    });
    new HumanPrincipalRegistry(first).register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [CAPS.openPr, INTELLIGENCE_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const created = expectOk(
      ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'safe-mode' },
        idempotencyKey: 'safe-mode',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(ops.claimNext('claude', CAPS.openPr, 60 * 60_000, created.task.id));
    expectOk(
      ops.setIntelligenceBudget({
        scopeKind: 'deployment',
        scopeId: 'deployment',
        window: 'total',
        ceilingMinorUnits: 100_000,
        currency: 'USD',
        permittedTiers: [...INTELLIGENCE_TIERS],
        setBy: 'founder',
      }),
    );
    first.close();

    // Drop an append-only guard the schema DECLARES, then reopen: the boot-time
    // observation is taken as the file was FOUND, so safe mode engages.
    const tamper = openHqDatabase(dbPath);
    tamper.exec('DROP TRIGGER trg_hq_intel_costs_no_erase');
    tamper.close();

    const reopened = openHqDatabase(dbPath);
    const safeOps = new HeadquarterOperations(reopened, {
      store: new HeadquarterStore(reopened),
      policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
    });
    return {
      ops: safeOps,
      claim: { taskId: claimed.id, workerId: 'claude', fence: claimed.fence },
      cleanup: () => {
        try {
          reopened.close();
        } catch {
          // A double close is not a test failure.
        }
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it('refuses the decision, escalation, outcome, cost, observation and budget writes', () => {
    const fx = tamperedFixture();
    try {
      expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const codes = [
        expectError(
          fx.ops.recordIntelligenceDecision({
            taskId: fx.claim.taskId,
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
            label: 'open the release PR',
            complexity: 'routine',
            contextSize: 'medium',
            workKind: 'coding',
          }),
        ).code,
        expectError(
          fx.ops.escalateIntelligenceDecision({
            decisionId: 'inteldec-anything',
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
            trigger: 'insufficient_evidence',
          }),
        ).code,
        expectError(
          fx.ops.recordIntelligenceOutcome({
            decisionId: 'inteldec-anything',
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
            result: 'quality_met',
          }),
        ).code,
        expectError(
          fx.ops.recordIntelligenceCost({
            taskId: fx.claim.taskId,
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
            providerId: 'anthropic',
            provenance: 'unknown',
            unitKind: 'unknown',
          }),
        ).code,
        expectError(
          fx.ops.recordModelObservation({
            providerId: 'anthropic',
            locality: 'cloud',
            availability: 'unknown',
            unitCostProvenance: 'unknown',
            unitCostUnitKind: 'unknown',
            source: 'founder_declared',
            observedBy: 'founder',
          }),
        ).code,
        expectError(
          fx.ops.setIntelligenceBudget({
            scopeKind: 'deployment',
            scopeId: 'deployment',
            window: 'total',
            ceilingMinorUnits: 1,
            currency: 'USD',
            permittedTiers: [...INTELLIGENCE_TIERS],
            setBy: 'founder',
          }),
        ).code,
      ];
      expect(codes).toEqual(Array(6).fill('safe_mode_engaged'));
    } finally {
      fx.cleanup();
    }
  });

  it('keeps every intelligence READ available, because a Founder who cannot see cannot fix', () => {
    const fx = tamperedFixture();
    try {
      expect(fx.ops.hqIntelligencePosture().storePresent).toBe(true);
      expect(fx.ops.listIntelligenceBudgetsBounded().total).toBe(1);
      expect(fx.ops.intelligenceAnalytics().decisions.total).toBe(0);
      expect(
        expectOk(
          fx.ops.intelligenceBudgetDecision({
            scopeKind: 'deployment',
            scopeId: 'deployment',
            window: 'total',
          }),
        ).decision,
      ).toBe('within_ceiling');
    } finally {
      fx.cleanup();
    }
  });
});

describe('restart durability: an unknown cost is still unknown after a reopen', () => {
  it('reads every ledger back identically from a second facade over the same file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-intel-restart-'));
    const dbPath = path.join(dir, 'headquarter.sqlite');
    const opened: { close(): void }[] = [];
    const build = (): HeadquarterOperations => {
      const db = openHqDatabase(dbPath);
      opened.push(db);
      return new HeadquarterOperations(db, {
        store: new HeadquarterStore(db),
        policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
      });
    };
    try {
      const first = build();
      const db = (opened[0] as never) as Parameters<typeof registerIntelligenceCommandCapability>[0];
      new CapabilityRegistry(db).register({
        id: CAPS.openPr,
        description: 'Open a branch-isolated PR',
        riskClass: 'external_side_effect',
        sideEffect: true,
        idempotent: true,
      });
      registerIntelligenceCommandCapability(db);
      new HeadquarterStore(db).upsertSpecialist({
        id: 'claude',
        displayName: 'Claude',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: [CAPS.openPr],
        active: true,
      });
      new HumanPrincipalRegistry(db).register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [CAPS.openPr, INTELLIGENCE_COMMAND_CAPABILITY.id],
        approvalAuthority: true,
        active: true,
      });
      const created = expectOk(
        first.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'restart' },
          idempotencyKey: 'restart',
          requestedBy: 'claude',
        }),
      );
      const claimed = expectOk(first.claimNext('claude', CAPS.openPr, 60 * 60_000, created.task.id));
      expectOk(
        first.setIntelligenceBudget({
          scopeKind: 'deployment',
          scopeId: 'deployment',
          window: 'total',
          ceilingMinorUnits: 100_000,
          currency: 'USD',
          permittedTiers: [...INTELLIGENCE_TIERS],
          setBy: 'founder',
        }),
      );
      expectOk(
        first.recordModelObservation({
          providerId: 'anthropic',
          modelId: 'claude-generic',
          locality: 'cloud',
          availability: 'healthy',
          unitCostProvenance: 'unknown',
          unitCostUnitKind: 'unknown',
          source: 'runtime_observed',
          observedBy: 'founder',
        }),
      );
      const decision = expectOk(
        first.recordIntelligenceDecision({
          taskId: claimed.id,
          workerId: 'claude',
          fence: claimed.fence,
          label: 'open the release PR',
          complexity: 'routine',
          contextSize: 'medium',
          workKind: 'coding',
        }),
      ).decision;
      expectOk(
        first.recordIntelligenceOutcome({
          decisionId: decision.id,
          workerId: 'claude',
          fence: claimed.fence,
          result: 'quality_met',
        }),
      );
      expectOk(
        first.recordIntelligenceCost({
          taskId: claimed.id,
          workerId: 'claude',
          fence: claimed.fence,
          providerId: 'anthropic',
          provenance: 'unknown',
          unitKind: 'unknown',
          decisionId: decision.id,
        }),
      );
      expectOk(
        first.recordIntelligenceCost({
          taskId: claimed.id,
          workerId: 'claude',
          fence: claimed.fence,
          providerId: 'anthropic',
          provenance: 'billed',
          amountMinorUnits: 750,
          currency: 'USD',
          unitKind: 'requests',
          idempotencyKey: 'second',
        }),
      );

      const before = {
        analytics: first.intelligenceAnalytics(),
        summary: first.intelligenceSummary(),
        decision: first.getIntelligenceDecision(decision.id),
      };
      (opened[0] as { close(): void }).close();

      const second = build();
      expect(second.intelligenceSummary()).toEqual(before.summary);
      expect(second.intelligenceAnalytics()).toEqual(before.analytics);
      expect(second.getIntelligenceDecision(decision.id)).toEqual(before.decision);
      // The unknown amount is still null, not zero, after the restart.
      const entries = second.listIntelligenceCostEntriesBounded().entries;
      const unknown = entries.find((entry) => entry.fact.provenance === 'unknown')!;
      expect(unknown.fact.amountMinorUnits).toBeNull();
      expect(second.intelligenceSummary().unknownAmountEntries).toBe(1);
      const evaluation = expectOk(
        second.intelligenceBudgetDecision({
          scopeKind: 'deployment',
          scopeId: 'deployment',
          window: 'total',
        }),
      );
      // One unknown entry stands, so HQ still cannot claim it is under the
      // ceiling — across a restart.
      expect(evaluation.decision).toBe('requires_founder_decision');
      expect(evaluation.observedMinorUnits).toBe(750);
    } finally {
      for (const db of opened) {
        try {
          db.close();
        } catch {
          // A double close is not a test failure.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the intelligence ledgers are not task, mission or approval authority', () => {
  it('changes nothing canonical, in both directions', () => {
    const withLedger = intelligenceFixture();
    withLedger.budget([...INTELLIGENCE_TIERS]);
    expectOk(decide(withLedger));
    expectOk(cost(withLedger));
    const without = intelligenceFixture();
    const a = withLedger.ops.queue.get(withLedger.claim.taskId)!;
    const b = without.ops.queue.get(without.claim.taskId)!;
    expect(a.status).toBe(b.status);
    expect(a.capabilityId).toBe(b.capabilityId);
    expect(a.reviewState).toBe(b.reviewState);
    expect(a.approvalId).toBe(b.approvalId);
  });

  it('is never read by the queue, the policy engine, the approval path or the binding', () => {
    // Behaviour alone cannot prove a negative about every future call site, so
    // this is a source scan of the four modules that decide whether work may
    // run — the Phase 13 recipe, applied to the cost ledger.
    const root = path.resolve(__dirname, '..', 'src', 'operator');
    for (const file of ['queue.ts', 'policy.ts', 'approvals.ts', 'capabilities.ts', 'provider-binding.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toContain('hq_intel_');
      expect(source).not.toContain('intelligence-command');
      expect(source).not.toContain('IntelligenceTier');
    }
  });

  it('leaves a task claimable and executable when no intelligence row exists at all', () => {
    const fx = setupFixture();
    const claim = claimSideEffectTask(fx, 'no-intel-rows');
    expect(expectOk(fx.ops.startTask(claim.taskId, 'claude', claim.fence)).status).toBe('running');
    expect(fx.ops.intelligenceAnalytics().decisions.total).toBe(0);
  });
});
