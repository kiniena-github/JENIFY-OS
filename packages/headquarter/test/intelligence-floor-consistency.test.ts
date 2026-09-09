/**
 * Wave 5, correction round seven — MEDIUM NEW-6: two published numbers over one
 * row, computed two different ways.
 *
 * `decisionIsProvablyAvoidable` recomputed the tier floor from the CURRENT
 * canonical risk class while `rowToDecision` served the STORED `floor_tier`. So
 * a Founder registry upsert that raised a capability's risk class flipped
 * `provablyAvoidable` 1 → 0 retroactively AND left the served record reporting
 * `floorTier: deterministic_local` beside `requiredReviewTier: critical_review`
 * — which the phase document itself says cannot both be true, because the
 * review requirement is one of the terms `computeRoutingProposal` takes the
 * floor's `max` over. Neither the flip nor the contradiction was disclosed
 * anywhere.
 *
 * What closes it: ONE computation answers both. `deriveDecisionRecord`
 * recomputes the floor and serves it; `decisionIsProvablyAvoidable` reads that
 * result rather than recomputing a second time; the stored value is carried as
 * `floorTierAsRecorded` so no history is lost; and `riskClassChangedSinceIssue`
 * — per record and counted on the analytics view — says out loud that canonical
 * truth moved under a number a reader may have written down.
 *
 * Round NINE (Low 3) closes the last route to the same contradiction: the
 * recomputation was fed the CANONICAL review requirement while the record
 * publishes the MAX of the canonical and the stored one, so a forged
 * `required_review_tier` above the canonical class still produced the pair. The
 * floor is now the max over the review tier this record actually SERVES.
 */

import { describe, expect, it } from 'vitest';
import { expectOk, CAPS } from './application.fixture.js';
import { intelligenceFixture } from './intelligence.fixture.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  INTELLIGENCE_TIERS,
  AVOIDABLE_SPEND_STATEMENT,
  REVIEW_REQUIREMENT,
  RISK_FLOOR,
  computeRoutingProposal,
  isIntelligenceTier,
  tierRank,
} from '../src/application/intelligence-command.js';

describe('a decision’s floor and its avoidability are ONE computation', () => {
  it('never serves a floor that contradicts the review requirement beside it', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);

    // A READ-ONLY capability requires no reviewer, so a decision on it can be
    // provably avoidable at all.
    expect(REVIEW_REQUIREMENT.read_only).toBeNull();
    const decision = expectOk(
      fx.ops.recordIntelligenceDecision({
        taskId: fx.readOnlyClaim.taskId,
        workerId: fx.readOnlyClaim.workerId,
        fence: fx.readOnlyClaim.fence,
        tier: 'high',
        label: 'read the status at a tier the floor did not ask for',
        complexity: 'routine',
        contextSize: 'small',
        workKind: 'research',
      }),
    ).decision;
    expectOk(
      fx.ops.recordIntelligenceOutcome({
        decisionId: decision.id,
        workerId: fx.readOnlyClaim.workerId,
        fence: fx.readOnlyClaim.fence,
        result: 'quality_met',
      }),
    );

    const before = fx.ops.getIntelligenceDecision(decision.id)!;
    expect(before.requiredReviewTier).toBeNull();
    expect(fx.ops.intelligenceAnalytics().provablyAvoidable.total).toBe(1);

    // The Founder raises the capability's risk class. A legitimate act: the
    // registry is where canonical risk lives.
    new CapabilityRegistry(fx.db).register({
      id: CAPS.readStatus,
      description: 'Read repo/CI status',
      riskClass: 'destructive',
      sideEffect: true,
      idempotent: true,
    });

    const after = fx.ops.getIntelligenceDecision(decision.id)!;
    // The review requirement rose, which is the canonical answer and correct.
    expect(after.requiredReviewTier).toBe('critical_review');
    // And the floor rose WITH it, because the review requirement is one of the
    // terms the floor is the maximum over. THIS is the pair that used to
    // contradict each other in public: `floorTier: deterministic_local` served
    // beside `requiredReviewTier: critical_review`.
    expect(after.floorTier).toBe('critical_review');
    // And the avoidability flag flipped on the SAME floor rather than on a
    // second, invisible one.
    expect(fx.ops.intelligenceAnalytics().provablyAvoidable.total).toBe(0);
    const servedFloor = after.floorTier;
    const recordedFloor = after.floorTierAsRecorded;
    if (!isIntelligenceTier(servedFloor) || !isIntelligenceTier(recordedFloor)) {
      throw new Error('both floors must be members of the closed tier vocabulary');
    }
    expect(tierRank(servedFloor)).toBeGreaterThanOrEqual(tierRank(after.requiredReviewTier!));
    // The stored value is not lost, and the move is REPORTED rather than
    // absorbed. Nothing was reported before the upsert, because nothing moved.
    expect(before.floorTierAsRecorded).toBe(before.floorTier);
    expect(before.riskClassChangedSinceIssue).toBe(false);
    expect(recordedFloor).toBe(before.floorTier);
    expect(tierRank(recordedFloor)).toBeLessThan(tierRank(servedFloor));
    expect(after.riskClassChangedSinceIssue).toBe(true);

    const analytics = fx.ops.intelligenceAnalytics();
    // The flip itself is honest — the floor really did move — and it no longer
    // happens silently.
    expect(analytics.provablyAvoidable.total).toBe(0);
    expect(analytics.provablyAvoidable.riskClassChangedSinceIssue).toBe(1);
    expect(AVOIDABLE_SPEND_STATEMENT).toContain('RECOMPUTED from canonical truth as it stands now');
    expect(AVOIDABLE_SPEND_STATEMENT).toContain('riskClassChangedSinceIssue');
  });

  /**
   * Wave 5 correction round NINE, Low 3 — the one remaining way to the same
   * contradiction, through a FORGED column.
   *
   * The round-seven fix made one computation answer both numbers, but it fed
   * that computation `characteristics` carrying only the CANONICAL risk class,
   * while the record PUBLISHES `maxRequiredReviewTier(stored, canonical)` — the
   * max, deliberately, so a forged NULL cannot drop the requirement. A stored
   * `required_review_tier` ABOVE the canonical class therefore still produced
   * the impossible pair the comment above says cannot occur.
   *
   * It needs a raw append and is fail-closed either way. What was wrong is what
   * was PUBLISHED: two numbers over one row that cannot both be true.
   */
  it('raises the served floor when a FORGED review tier outranks the canonical one', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);

    // `repo.read_status` is `read_only`: no reviewer required, floor
    // `deterministic_local`. So the canonical answer for this row asks for
    // nothing, and every raised number below comes from the forged column.
    expect(REVIEW_REQUIREMENT.read_only).toBeNull();
    expect(RISK_FLOOR.read_only).toBe('deterministic_local');

    // A raw APPEND — the write the append-only triggers deliberately permit, so
    // this needs no dropped guard and is the shape a forger actually has.
    const forgedId = 'inteldec-forged-review-tier-above-canonical';
    fx.db
      .prepare(
        `INSERT INTO hq_intel_decisions
           (id, task_id, mission_id, project_id, tier, floor_tier, required_review_tier,
            escalated_from, escalation_trigger, bound_provider, characteristics, permitted_tiers,
            budget_decision, label, issued_at, issued_by, process_id, decision_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        forgedId,
        fx.readOnlyClaim.taskId,
        null,
        null,
        'low_cost',
        'deterministic_local',
        // The forgery: a review tier the canonical risk class never asked for.
        'critical_review',
        null,
        null,
        null,
        JSON.stringify({
          complexity: 'trivial',
          contextSize: 'small',
          workKind: 'classification',
          latency: 'unspecified',
          privacy: 'unrestricted',
          riskClass: 'read_only',
        }),
        JSON.stringify(INTELLIGENCE_TIERS),
        'within_ceiling',
        'forged',
        new Date().toISOString(),
        'attacker',
        'attacker-process',
        `forged-key-${forgedId}`,
      );

    const read = fx.ops.getIntelligenceDecision(forgedId)!;
    // The published requirement is the MAX, which is the round-three answer and
    // stays exactly as it was: a forger cannot LOWER it, so the max keeps the
    // stronger of the two.
    expect(read.requiredReviewTier).toBe('critical_review');
    // THE FINDING. This used to read `deterministic_local` beside the line
    // above — the pair the source comment says cannot both be true, because the
    // review requirement is one of the terms the floor is the max over.
    expect(read.floorTier).toBe('critical_review');
    const servedFloor = read.floorTier;
    if (!isIntelligenceTier(servedFloor)) {
      throw new Error('the served floor must be a member of the closed tier vocabulary');
    }
    expect(tierRank(servedFloor)).toBeGreaterThanOrEqual(tierRank(read.requiredReviewTier!));

    // History is still not lost: the row said `deterministic_local` and that is
    // still readable, which is how a reader can see the forgery at all.
    expect(read.floorTierAsRecorded).toBe('deterministic_local');
    // And the fail-closed behaviour the reviewer measured is unchanged: the
    // recorded tier does not satisfy the requirement, so the decision cannot be
    // pronounced avoidable.
    expect(read.satisfiesReviewRequirement).toBe(false);
    expect(fx.ops.intelligenceAnalytics().provablyAvoidable.decisionIds).not.toContain(forgedId);
  });

  it('serves the floor the policy itself computes, for every recorded decision', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const decision = expectOk(
      fx.ops.recordIntelligenceDecision({
        taskId: fx.claim.taskId,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        tier: 'critical_review',
        label: 'open the release PR',
        complexity: 'novel',
        contextSize: 'large',
        workKind: 'coding',
      }),
    ).decision;
    const record = fx.ops.getIntelligenceDecision(decision.id)!;
    // The served floor is exactly what the pure policy computes from the
    // record's own characteristics — no second spelling anywhere.
    const recomputed = computeRoutingProposal({
      characteristics: record.characteristics!,
      permittedTiers: INTELLIGENCE_TIERS,
      budgetDecision: 'within_ceiling',
    });
    expect(record.floorTier).toBe(recomputed.floorTier);
    // Nothing moved, so the two readings agree and nothing is reported.
    expect(record.floorTierAsRecorded).toBe(record.floorTier);
    expect(record.riskClassChangedSinceIssue).toBe(false);
    expect(fx.ops.intelligenceAnalytics().provablyAvoidable.riskClassChangedSinceIssue).toBe(0);
  });
});
