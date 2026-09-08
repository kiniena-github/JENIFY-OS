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

/**
 * Every helper call is its own OBSERVATION, and says so.
 *
 * A cost entry must declare an identity — an `idempotencyKey` or the
 * `occurredAt` it was observed at — because the wall clock HQ used to default
 * into the key made a replay of an identical entry a second row, and a Founder
 * ceiling then observed twice what was spent (Wave 5 correction round five,
 * Low 3). A per-call key keeps each of these calls a distinct entry, exactly
 * as before; a test that means two calls to be the SAME observation passes its
 * own key and overrides this one.
 */
let costCallSeq = 0;

function cost(fx: IntelligenceFixture, over: Record<string, unknown> = {}) {
  const input: Record<string, unknown> = {
    taskId: fx.claim.taskId,
    workerId: fx.claim.workerId,
    fence: fx.claim.fence,
    providerId: 'anthropic',
    provenance: 'unknown',
    unitKind: 'unknown',
    ...over,
  };
  // ONLY when the test declares neither. A test that fixes `occurredAt` is
  // declaring the identity itself — that is how the dedupe and conflict cases
  // below meet — and a per-call key would silently take those cases apart.
  if (input.occurredAt === undefined && input.idempotencyKey === undefined) {
    input.idempotencyKey = `helper-cost-${(costCallSeq += 1)}`;
  }
  return fx.ops.recordIntelligenceCost(
    input as Parameters<HeadquarterOperations['recordIntelligenceCost']>[0],
  );
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

/**
 * Wave 5 correction round four, High H2 — an exhausted ceiling that could be
 * nullified.
 *
 * The previous round moved ceiling measurement off the cost ledger's own
 * columns onto three MUTABLE, UNCENSUSED tables: `hq_mission_plan_items`,
 * `hq_missions` and `op_tasks.payload`. Breaking any of those links did two
 * things at once, and the second was new: the scope left
 * `#governingBudgetScopes` (a pre-existing fail-open), AND `observed` collapsed
 * from 5000 to 0 — removing the last place a Founder could see the spend the
 * ceiling had been exhausted by.
 *
 * All three routes are executed here. The rule that closes them is one rule:
 * canonical membership UNION the attribution HQ itself recorded on the
 * append-only cost row. HQ derives those columns; no caller supplies one; the
 * rows cannot be updated or deleted. So a ceiling that has been charged stays
 * charged, and no caller can charge somebody else's.
 */
describe('an exhausted ceiling cannot be nullified by breaking the link it was derived through', () => {
  function exhaust(fx: IntelligenceFixture, scope: { scopeKind: 'mission' | 'project'; scopeId: string }): void {
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.budget([...INTELLIGENCE_TIERS], {
      ...scope,
      window: 'total',
      ceilingMinorUnits: 1,
    });
    expectOk(
      cost(fx, { provenance: 'billed', amountMinorUnits: 5000, currency: 'USD', unitKind: 'requests' }),
    );
  }

  function blockedObserved(fx: IntelligenceFixture, scope: { scopeKind: 'mission' | 'project'; scopeId: string }): {
    decision: string;
    observed: number | null;
  } {
    const view = expectOk(fx.ops.intelligenceBudgetDecision({ ...scope, window: 'total' }));
    return { decision: view.decision, observed: view.observedMinorUnits };
  }

  it('route (a): clearing the mission’s project through the SUPPORTED facade call', () => {
    const fx = intelligenceFixture();
    const canonical = fx.linkToCanonicalMission(fx.claim.taskId, 'route-a');
    exhaust(fx, { scopeKind: 'project', scopeId: canonical.projectId });
    expect(blockedObserved(fx, { scopeKind: 'project', scopeId: canonical.projectId })).toEqual({
      decision: 'blocked',
      observed: 5000,
    });
    const refused = decide(fx, { tier: 'high' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('budget_ceiling_blocks');

    // A principal holding ONLY `hq.mission_command` — no approval authority, no
    // `hq.intelligence_command` — clears the mission's project. This is a
    // legitimate, supported act, and it must not be a way to spend past a
    // Founder ceiling. The same principal raising the ceiling directly is
    // correctly refused, which is what made this a bypass.
    expectOk(
      fx.ops.assignMissionToProject({
        missionId: canonical.missionId,
        projectId: null,
        requestedBy: 'founder',
      }),
    );

    // The spend is still visible, and the ceiling still binds.
    expect(blockedObserved(fx, { scopeKind: 'project', scopeId: canonical.projectId })).toEqual({
      decision: 'blocked',
      observed: 5000,
    });
    const stillRefused = decide(fx, { tier: 'high', idempotencyKey: 'after-unlink' });
    expect(stillRefused.ok).toBe(false);
    expect(!stillRefused.ok && stillRefused.error.code).toBe('budget_ceiling_blocks');
  });

  it('route (b): re-pointing or erasing the canonical link with raw SQL', () => {
    const fx = intelligenceFixture();
    const canonical = fx.linkToCanonicalMission(fx.claim.taskId, 'route-b');
    exhaust(fx, { scopeKind: 'mission', scopeId: canonical.missionId });

    // The engine refuses both writes now: `no_relink` covered `task_id` only,
    // and `hq_missions` was absent from the census entirely.
    expect(() =>
      fx.db
        .prepare(`UPDATE hq_mission_plan_items SET mission_id = 'nowhere' WHERE task_id = ?`)
        .run(fx.claim.taskId),
    ).toThrow(/write-once/);
    expect(() => fx.db.prepare(`DELETE FROM hq_missions`).run()).toThrow(/never erased/);

    // And even against a writer that got past them, the recorded attribution
    // keeps the spend visible and the ceiling binding. `project_id` is a column
    // the facade legitimately moves, so this is the raw form of route (a).
    fx.db.prepare(`UPDATE hq_missions SET project_id = NULL`).run();
    expect(blockedObserved(fx, { scopeKind: 'mission', scopeId: canonical.missionId })).toEqual({
      decision: 'blocked',
      observed: 5000,
    });
  });

  it('route (c): rewriting the task payload the provider ceiling was derived through', () => {
    const fx = intelligenceFixture();
    const bound = fx.providerBoundClaim('CLAUDE');
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.budget([...INTELLIGENCE_TIERS], {
      scopeKind: 'provider',
      scopeId: 'claude',
      window: 'total',
      ceilingMinorUnits: 1,
    });
    expectOk(
      fx.ops.recordIntelligenceCost({
        taskId: bound.taskId,
        workerId: bound.workerId,
        fence: bound.fence,
        providerId: 'CLAUDE',
        provenance: 'billed',
        amountMinorUnits: 5000,
        currency: 'USD',
        unitKind: 'requests',
        // A cost entry must DECLARE an identity, so a replay of the same
        // observation is recognized rather than counted twice (Wave 5
        // correction round five, Low 3). Added when the two round-five lanes
        // were reconciled: this route-(c) case was written against the build
        // where HQ stamped a wall-clock identity of its own, and the nullification
        // it exercises is unaffected by which identity the entry carries.
        idempotencyKey: 'route-c-provider-spend',
      }),
    );
    const before = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'provider',
        scopeId: 'claude',
        window: 'total',
      }),
    );
    expect(before.decision).toBe('blocked');
    expect(before.observedMinorUnits).toBe(5000);

    // `op_tasks.payload` is a mutable, uncensused column, and the provider
    // ceiling used to be measured by re-reading it for every entry. HQ records
    // its OWN statement about the binding on the append-only row instead, so
    // rewriting the payload cannot move spend that already happened.
    fx.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ branch: 'rewritten' }), bound.taskId);
    const after = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'provider',
        scopeId: 'claude',
        window: 'total',
      }),
    );
    expect(after.decision).toBe('blocked');
    expect(after.observedMinorUnits).toBe(5000);
  });

  /**
   * Route (d): a task linked to TWO missions, and the OTHER mission moved.
   *
   * Wave 5 correction round six, High 3. The rule the three routes above rest
   * on is "canonical membership UNION the attribution HQ recorded on the row",
   * and the phase document called that union "monotone and unforgeable". It was
   * neither for a task linked to more than one mission: the cost row stored
   * `canonicalScopes.missionIds[0]` and `projectIds[0]`, ONE of N, so the union
   * was complete only for the scope that sorted first.
   *
   * No raw SQL. A principal holding `hq.mission_command`, without approval
   * authority and without `hq.intelligence_command`, calls
   * `assignMissionToProject` on the mission owning the project the row did NOT
   * store. Executed against the previous head: the victim project went from
   * `blocked, observed 5000` to `within_ceiling, observed 0`, the refused
   * decision was RECORDED, and the published report credited the whole 5000 to
   * the escape project, which had spent nothing.
   */
  it('route (d): moving the OTHER mission of a task linked to two of them', () => {
    const fx = intelligenceFixture();
    const first = fx.linkToCanonicalMission(fx.claim.taskId, 'alpha');
    const second = fx.linkToCanonicalMission(fx.claim.taskId, 'beta');
    // The row stores the project that sorts FIRST, so the victim is the other
    // one — whichever that happens to be for these uuids.
    const [stored, victim] =
      first.projectId < second.projectId ? [first, second] : [second, first];
    expect(stored.projectId < victim.projectId).toBe(true);

    exhaust(fx, { scopeKind: 'project', scopeId: victim.projectId });
    expect(blockedObserved(fx, { scopeKind: 'project', scopeId: victim.projectId })).toEqual({
      decision: 'blocked',
      observed: 5000,
    });
    const refusedBefore = decide(fx, { tier: 'high' });
    expect(refusedBefore.ok).toBe(false);
    expect(!refusedBefore.ok && refusedBefore.error.code).toBe('budget_ceiling_blocks');

    const escape = expectOk(
      fx.ops.createProject({
        name: 'Somewhere else',
        purpose: 'The project the mission is moved to',
        requestedBy: 'founder',
      }),
    ).project;
    expectOk(
      fx.ops.assignMissionToProject({
        missionId: victim.missionId,
        projectId: escape.id,
        requestedBy: 'founder',
      }),
    );

    // The ceiling still binds and the spend is still visible under it.
    expect(blockedObserved(fx, { scopeKind: 'project', scopeId: victim.projectId })).toEqual({
      decision: 'blocked',
      observed: 5000,
    });
    const stillRefused = decide(fx, { tier: 'high', idempotencyKey: 'after-mission-moved' });
    expect(stillRefused.ok).toBe(false);
    expect(!stillRefused.ok && stillRefused.error.code).toBe('budget_ceiling_blocks');

    // And the published report still SHOWS the spend under the project that
    // incurred it. Before the fix the victim vanished from `byProject`
    // altogether — the report agreed with a ceiling that had stopped binding.
    const analytics = fx.ops.intelligenceAnalytics();
    const credited = (
      analytics.cost.byProject as { id: string | null; knownAmountMinorUnits: number | null }[]
    )
      .filter((row) => row.knownAmountMinorUnits === 5000)
      .map((row) => row.id)
      .sort();
    expect(credited).toContain(victim.projectId);
    expect(credited).toContain(stored.projectId);
    // The escape project appears TOO, and that is the union's stated behaviour
    // rather than a leftover of this defect: `byProject` folds canonical
    // membership as it stands NOW beside the attribution HQ recorded, so a
    // project a task has been moved under is shown that task's spend. It is the
    // same rule that makes the escape project's OWN ceiling start governing the
    // work, which is the fail-closed direction. Asserted rather than left
    // implicit, and carried in the phase document's residual list — the defect
    // this test closes is the victim's DISAPPEARANCE, which was the half no
    // reading of the union could defend.
    expect(credited).toContain(escape.id);
  });

});

/**
 * Wave 5 correction round four, Medium M5 / M6 — the Founder's spend report.
 *
 * `analytics.cost.byMission`/`byProject` folded the entry's own stored column,
 * which holds ONE of the N missions a task may be linked to, so attribution
 * flipped on uuid sort order; and `byProvider` folded the caller-declared
 * `providerId`, which the ceiling path had already stopped trusting. Two
 * surfaces over one ledger, disagreeing about the same spend.
 */
describe('the spend report agrees with the ceiling about whose spend it was', () => {
  it('attributes a two-mission task to BOTH missions, not to whichever sorts first', () => {
    const fx = intelligenceFixture();
    const first = fx.linkToCanonicalMission(fx.claim.taskId, 'm5-one');
    fx.budget([...INTELLIGENCE_TIERS]);
    expectOk(
      cost(fx, { provenance: 'billed', amountMinorUnits: 5000, currency: 'USD', unitKind: 'requests' }),
    );
    // A SECOND canonical mission for the same task — the exact shape that made
    // `missionIds[0]` a coin toss.
    const second = fx.linkToCanonicalMission(fx.claim.taskId, 'm5-two');

    const byMission = fx.ops.intelligenceAnalytics().cost.byMission;
    const ids = byMission.map((row) => row.id).sort();
    expect(ids).toEqual([first.missionId, second.missionId].sort());
    for (const row of byMission) expect(row.knownAmountMinorUnits).toBe(5000);
    // And the ceilings say the same thing, which is the property that matters:
    // the report and the enforcement read one ledger the same way.
    for (const missionId of [first.missionId, second.missionId]) {
      fx.budget([...INTELLIGENCE_TIERS], {
        scopeKind: 'mission',
        scopeId: missionId,
        window: 'total',
        ceilingMinorUnits: 1,
      });
      expect(
        expectOk(
          fx.ops.intelligenceBudgetDecision({ scopeKind: 'mission', scopeId: missionId, window: 'total' }),
        ).observedMinorUnits,
      ).toBe(5000);
    }
  });

  it('never credits a provider HQ has no canonical statement about', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // The fixture's claimed task binds NO provider, so `openai` here is the
    // claim-holding worker's own declaration and nothing more.
    expectOk(
      cost(fx, {
        providerId: 'openai',
        provenance: 'billed',
        amountMinorUnits: 999999,
        currency: 'USD',
        unitKind: 'requests',
      }),
    );
    const byProvider = fx.ops.intelligenceAnalytics().cost.byProvider;
    expect(byProvider.map((row) => row.id)).toEqual(['unattributed']);
    expect(JSON.stringify(byProvider)).not.toContain('openai');
    // Which is exactly what the ceiling already said.
    expect(
      expectOk(
        fx.ops.intelligenceBudgetDecision({ scopeKind: 'provider', scopeId: 'openai', window: 'total' }),
      ).observedMinorUnits,
    ).toBe(0);
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

  /**
   * This test advertised the `provider_binding_mismatch` proof and never
   * executed it (Wave 5 correction round three, Medium B6). The standing
   * fixture's claim task carries `{ branch: 'intel-side-effect' }`, which binds
   * no provider, so `boundProvider` was always null and the guard below always
   * took the early return — while the comment on that branch asserted the
   * fixture DID carry a binding. The vacuous test is why the whole `provider`
   * budget scope shipped dead: nothing ever ran the path.
   *
   * It now uses a genuinely provider-bound claim, and the unbound case is a
   * separate test that says what actually happens there rather than an early
   * return dressed as a proof.
   */
  it('refuses a provider the canonical payload does not bind', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const boundClaim = fx.providerBoundClaim('CLAUDE');
    const boundProvider = expectOk(
      fx.ops.intelligenceRoutingProposal({
        taskId: boundClaim.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    ).boundProvider;
    // No guard, no early return: the binding is REAL and the canonical routing
    // vocabulary is uppercase.
    expect(boundProvider).toBe('CLAUDE');

    const boundCost = (over: Record<string, unknown>) =>
      fx.ops.recordIntelligenceCost({
        taskId: boundClaim.taskId,
        workerId: boundClaim.workerId,
        fence: boundClaim.fence,
        providerId: 'anthropic',
        provenance: 'unknown',
        unitKind: 'unknown',
        // A cost entry must DECLARE an identity, so a replay of the same
        // observation is recognized rather than counted twice (Wave 5
        // correction round five, Low 3). Each spelling below is its own
        // observation and carries its own key.
        idempotencyKey: 'canonical-spelling',
        ...over,
      } as Parameters<HeadquarterOperations['recordIntelligenceCost']>[0]);

    const refusal = boundCost({ providerId: 'a.provider.never.bound' });
    expect(refusal.ok).toBe(false);
    expect(!refusal.ok && refusal.error.code).toBe('provider_binding_mismatch');
    expect(!refusal.ok && refusal.error.message).toContain('No substitution is made');

    // And the bound provider is ACCEPTED in either spelling, which is the half
    // that was structurally impossible: `CLAUDE` failed the slug rule, `claude`
    // failed the binding rule, and `Claude` failed the slug rule again, so no
    // cost entry could ever be recorded against a provider-bound task at all.
    expect(expectOk(boundCost({ providerId: 'CLAUDE' })).entry.providerId).toBe('claude');
    expect(
      expectOk(boundCost({ providerId: 'claude', idempotencyKey: 'lowercase-spelling' })).entry
        .providerId,
    ).toBe('claude');
    expect(
      expectOk(boundCost({ providerId: 'Claude', idempotencyKey: 'mixed-spelling' })).entry.providerId,
    ).toBe('claude');
  });

  /**
   * The UNBOUND case, stated as what it is. The entry is recorded — the
   * provider a worker reports is a real fact and the spend belongs in the
   * deployment total — but it measures no PROVIDER ceiling, because HQ has no
   * canonical statement that this work ran there. Before the correction it did
   * measure one, and a claim-holding worker used that to push an unrelated
   * provider's Founder ceiling from `observed 0` to `blocked, observed 999999`.
   */
  it('records spend from an UNBOUND task without letting it move another provider’s ceiling', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.budget([...INTELLIGENCE_TIERS], {
      scopeKind: 'provider',
      scopeId: 'someone.elses.provider',
      ceilingMinorUnits: 10,
    });
    const before = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'provider',
        scopeId: 'someone.elses.provider',
        window: 'total',
      }),
    );
    expect(before.decision).toBe('within_ceiling');
    expect(before.observedMinorUnits).toBe(0);

    // The fixture's standing claim binds no provider, so nothing refuses the
    // attribution itself.
    const recorded = expectOk(
      cost(fx, {
        providerId: 'someone.elses.provider',
        provenance: 'billed',
        amountMinorUnits: 999_999,
        currency: 'USD',
        unitKind: 'requests',
      }),
    ).entry;
    expect(recorded.providerId).toBe('someone.elses.provider');

    const after = expectOk(
      fx.ops.intelligenceBudgetDecision({
        scopeKind: 'provider',
        scopeId: 'someone.elses.provider',
        window: 'total',
      }),
    );
    expect(after.observedMinorUnits).toBe(0);
    expect(after.decision).toBe('within_ceiling');
    // It IS counted where it honestly belongs: the deployment total.
    expect(
      expectOk(
        fx.ops.intelligenceBudgetDecision({
          scopeKind: 'deployment',
          scopeId: 'deployment',
          window: 'total',
        }),
      ).observedMinorUnits,
    ).toBe(999_999);
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

/**
 * Wave 5 correction round three — the four Phase 14 findings the previous
 * rounds' own fixes left open, each reproduced by execution against this head.
 */
describe('every ceiling that governs the work binds, and every figure it rests on is checked', () => {
  /**
   * HIGH B1. `#governingBudgetScopes` derives EVERY mission a task is linked
   * to, but the cost entry's attribution wrote `canonical.missionIds[0]` and
   * `#entriesForScope` matched that one column — so the moment a task carried a
   * second mission link, the non-first mission's ceiling was evaluated against
   * ZERO entries. Identical spend under an identical ceiling read `blocked,
   * observed 5000000` with one link and `within_ceiling, observed 0` with two,
   * and WHICH of the two bound was decided by uuid sort order: twelve runs of
   * the same configuration enforced eight times and bypassed four.
   */
  it('accumulates a mission ceiling through EVERY link, not the first by uuid order', () => {
    const fx = intelligenceFixture();
    const task = fx.claim.taskId;
    const alpha = fx.linkToCanonicalMission(task, 'alpha');
    const beta = fx.linkToCanonicalMission(task, 'beta');
    expect(beta.missionId).not.toBe(alpha.missionId);
    fx.budget([...INTELLIGENCE_TIERS], { ceilingMinorUnits: 1_000_000_000 });
    for (const mission of [alpha, beta]) {
      fx.budget([...INTELLIGENCE_TIERS], {
        scopeKind: 'mission',
        scopeId: mission.missionId,
        ceilingMinorUnits: 10,
      });
    }
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 5_000_000,
        currency: 'USD',
        unitKind: 'tokens_total',
      }),
    );
    // BOTH ceilings see the spend, whichever of the two uuids sorts first.
    for (const mission of [alpha, beta]) {
      const evaluation = expectOk(
        fx.ops.intelligenceBudgetDecision({
          scopeKind: 'mission',
          scopeId: mission.missionId,
          window: 'total',
        }),
      );
      expect(evaluation.observedMinorUnits, mission.missionId).toBe(5_000_000);
      expect(evaluation.decision, mission.missionId).toBe('blocked');
    }
    // And the enforced write is refused, which is the consequence that matters.
    const refused = decide(fx, { tier: 'critical_review', label: 'more paid work' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('budget_ceiling_blocks');
  });

  /**
   * The same rule for PROJECT scopes, which had the identical
   * `projectIds[0] ?? null` shape.
   */
  it('accumulates a project ceiling through every mission the task belongs to', () => {
    const fx = intelligenceFixture();
    const alpha = fx.linkToCanonicalMission(fx.claim.taskId, 'alpha');
    const beta = fx.linkToCanonicalMission(fx.claim.taskId, 'beta');
    fx.budget([...INTELLIGENCE_TIERS], { ceilingMinorUnits: 1_000_000_000 });
    for (const project of [alpha.projectId, beta.projectId]) {
      fx.budget([...INTELLIGENCE_TIERS], {
        scopeKind: 'project',
        scopeId: project,
        ceilingMinorUnits: 10,
      });
    }
    expectOk(
      cost(fx, {
        provenance: 'billed',
        amountMinorUnits: 4_000,
        currency: 'USD',
        unitKind: 'requests',
      }),
    );
    for (const project of [alpha.projectId, beta.projectId]) {
      expect(
        expectOk(
          fx.ops.intelligenceBudgetDecision({ scopeKind: 'project', scopeId: project, window: 'total' }),
        ).observedMinorUnits,
        project,
      ).toBe(4_000);
    }
  });

  /**
   * HIGH B2, from the other end: a Founder's PROVIDER ceiling on a bound task
   * genuinely binds now. It could not before — no cost entry against a
   * provider-bound task was expressible at all — so the scope stayed at
   * `observed: 0` forever and the phase document's "a Founder's provider
   * ceiling binds" was false.
   */
  it('binds a Founder provider ceiling to work the payload canonically binds', () => {
    const fx = intelligenceFixture();
    const bound = fx.providerBoundClaim('CLAUDE');
    fx.budget([...INTELLIGENCE_TIERS], { ceilingMinorUnits: 1_000_000_000 });
    // Written in the CANONICAL uppercase spelling, and matched anyway.
    fx.budget([...INTELLIGENCE_TIERS], {
      scopeKind: 'provider',
      scopeId: 'CLAUDE',
      ceilingMinorUnits: 10,
    });
    expectOk(
      fx.ops.recordIntelligenceCost({
        taskId: bound.taskId,
        workerId: bound.workerId,
        fence: bound.fence,
        providerId: 'CLAUDE',
        provenance: 'billed',
        amountMinorUnits: 3_702,
        currency: 'USD',
        unitKind: 'tokens_total',
        // A cost entry must DECLARE an identity, so a replay of the same
        // observation is recognized rather than counted twice (Wave 5
        // correction round five, Low 3).
        idempotencyKey: 'provider-ceiling-spend',
      }),
    );
    // Readable under either spelling, because the read is folded exactly as the
    // write is.
    for (const spelling of ['CLAUDE', 'claude']) {
      const evaluation = expectOk(
        fx.ops.intelligenceBudgetDecision({
          scopeKind: 'provider',
          scopeId: spelling,
          window: 'total',
        }),
      );
      expect(evaluation.observedMinorUnits, spelling).toBe(3_702);
      expect(evaluation.decision, spelling).toBe('blocked');
    }
    // And it BLOCKS a decision write on that task, which is the whole claim.
    const refused = fx.ops.recordIntelligenceDecision({
      taskId: bound.taskId,
      workerId: bound.workerId,
      fence: bound.fence,
      label: 'more provider-bound work',
      complexity: 'routine',
      contextSize: 'medium',
      workKind: 'coding',
      tier: 'high',
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('budget_ceiling_blocks');
  });

  /**
   * LOW B8. The amount check closed the case where a `billed 0` recorded first
   * suppressed the true amount; `unitsObserved`, `basis` and `decisionId` were
   * left on the same silent first-write-wins path, and each is a claim
   * published on the Founder route.
   */
  it('refuses a second entry that disagrees on units, basis or the decision it cites', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // A fixed instant, because `costEntryKey` covers it: two calls a
    // millisecond apart are two different entries and would never meet.
    const occurredAt = new Date().toISOString();
    const base = {
      provenance: 'billed' as const,
      amountMinorUnits: 1_000,
      currency: 'USD',
      unitKind: 'tokens_total' as const,
      occurredAt,
    };
    expectOk(cost(fx, { ...base, unitsObserved: 10, idempotencyKey: 'units' }));
    const units = cost(fx, { ...base, unitsObserved: 9_999_999, idempotencyKey: 'units' });
    expect(units.ok).toBe(false);
    expect(!units.ok && units.error.code).toBe('cost_entry_conflict');

    expectOk(
      cost(fx, {
        provenance: 'estimated',
        amountMinorUnits: 500,
        currency: 'USD',
        unitKind: 'requests',
        basis: 'vendor list price 2026-01',
        occurredAt,
        idempotencyKey: 'basis',
      }),
    );
    const basis = cost(fx, {
      provenance: 'estimated',
      amountMinorUnits: 500,
      currency: 'USD',
      unitKind: 'requests',
      basis: 'a number nobody can trace',
      occurredAt,
      idempotencyKey: 'basis',
    });
    expect(basis.ok).toBe(false);
    expect(!basis.ok && basis.error.code).toBe('cost_entry_conflict');

    const decision = expectOk(decide(fx, { tier: 'high' })).decision;
    expectOk(cost(fx, { ...base, idempotencyKey: 'citation' }));
    const cited = cost(fx, { ...base, decisionId: decision.id, idempotencyKey: 'citation' });
    expect(cited.ok).toBe(false);
    expect(!cited.ok && cited.error.code).toBe('cost_entry_conflict');
    // The stored row is untouched by every refusal: nothing was overwritten and
    // nothing was silently kept under a claim it does not carry.
    const stored = fx.ops
      .listIntelligenceCostEntriesBounded()
      .entries.filter((entry) => entry.unitsObserved === 10);
    expect(stored).toHaveLength(1);
    expect(stored[0].decisionId).toBeNull();
  });
});
