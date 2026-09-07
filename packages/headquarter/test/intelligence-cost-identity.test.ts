/**
 * Wave 5, correction round five — LOW 3: a cost entry's IDENTITY may not be a
 * wall clock HQ read for itself.
 *
 * `occurredAt` defaulted to `nowIso()` and then fed `costEntryKey`, so an entry
 * recorded without one carried a millisecond timestamp as part of its own
 * identity. Executed against the previous head at a 0 ms, a 2 ms and a 30 ms
 * gap: an unchanged replay of a 6000-unit entry was ACCEPTED as a second row
 * every time, and the Founder's provider ceiling observed 12000 from 6000
 * actually spent. `cost_entry_conflict` — which the phase document offers as
 * the protection against exactly this — could essentially never fire on that
 * path, because the default path essentially never produced the same identity.
 *
 * The direction is fail-safe (it over-reports and never grants), which is why
 * this was graded Low. It is still a fabricated measurement, and the
 * architectural law forbids fabrication in the false-alarm direction as much as
 * in the reassuring one.
 */

import { describe, expect, it } from 'vitest';
import { intelligenceFixture } from './intelligence.fixture.js';
import { INTELLIGENCE_TIERS } from '../src/application/intelligence-command.js';
import { expectOk } from './application.fixture.js';
import type { HeadquarterOperations } from '../src/application/service.js';

type CostInput = Parameters<HeadquarterOperations['recordIntelligenceCost']>[0];

function harness() {
  const fx = intelligenceFixture();
  const bound = fx.providerBoundClaim('CLAUDE');
  fx.budget([...INTELLIGENCE_TIERS], {
    scopeKind: 'provider',
    scopeId: 'claude',
    window: 'total',
    ceilingMinorUnits: 10_000,
  });
  const spend = (over: Record<string, unknown> = {}) =>
    fx.ops.recordIntelligenceCost({
      taskId: bound.taskId,
      workerId: bound.workerId,
      fence: bound.fence,
      providerId: 'claude',
      provenance: 'billed',
      unitKind: 'requests',
      amountMinorUnits: 6_000,
      currency: 'USD',
      ...over,
    } as CostInput);
  const observed = () =>
    expectOk(
      fx.ops.intelligenceBudgetDecision({ scopeKind: 'provider', scopeId: 'claude', window: 'total' }),
    );
  return { fx, spend, observed };
}

describe('a cost entry declares its own identity, so a replay is not a second spend', () => {
  it('refuses an entry that declares neither an idempotencyKey nor an occurredAt', () => {
    const { spend, observed } = harness();
    const refusal = spend();
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error('an unidentifiable cost entry was recorded');
    expect(refusal.error.code).toBe('invalid_input');
    expect(refusal.error.message).toContain('idempotencyKey');
    // Nothing was recorded, so nothing was measured either.
    expect(observed().observedMinorUnits).toBe(0);
  });

  it('dedupes a replay carrying the same idempotencyKey however much time has passed', () => {
    const { spend, observed } = harness();
    const first = expectOk(spend({ idempotencyKey: 'one-observation' }));
    expect(first.deduplicated).toBe(false);
    // Deliberately across a real millisecond boundary: that gap is exactly what
    // used to make the two entries different rows.
    const until = Date.now() + 3;
    while (Date.now() < until) {
      /* burn a few milliseconds of wall clock */
    }
    const replay = expectOk(spend({ idempotencyKey: 'one-observation' }));
    expect(replay.deduplicated).toBe(true);
    expect(replay.entry.id).toBe(first.entry.id);
    // THE FINDING: this read 12000 from 6000 actually spent, and the ceiling
    // said `blocked` on a spend that had not happened.
    const decision = observed();
    expect(decision.observedMinorUnits).toBe(6_000);
    expect(decision.decision).toBe('within_ceiling');
  });

  it('dedupes a replay carrying the same declared occurredAt, for the same reason', () => {
    const { spend, observed } = harness();
    const occurredAt = new Date().toISOString();
    expect(expectOk(spend({ occurredAt })).deduplicated).toBe(false);
    const until = Date.now() + 3;
    while (Date.now() < until) {
      /* burn a few milliseconds of wall clock */
    }
    expect(expectOk(spend({ occurredAt })).deduplicated).toBe(true);
    expect(observed().observedMinorUnits).toBe(6_000);
  });

  it('makes the documented conflict reachable: the same identity with a different figure is refused', () => {
    const { spend, observed } = harness();
    expectOk(spend({ idempotencyKey: 'the-observation' }));
    const disagreement = spend({ idempotencyKey: 'the-observation', amountMinorUnits: 9_000 });
    expect(disagreement.ok).toBe(false);
    if (disagreement.ok) throw new Error('a second figure under one identity was accepted');
    expect(disagreement.error.code).toBe('cost_entry_conflict');
    // The first figure stands and no fabricated total is published.
    expect(observed().observedMinorUnits).toBe(6_000);
  });

  it('still records two GENUINELY different observations as two entries', () => {
    const { spend, observed } = harness();
    expectOk(spend({ idempotencyKey: 'call-one' }));
    expectOk(spend({ idempotencyKey: 'call-two' }));
    expect(observed().observedMinorUnits).toBe(12_000);
  });
});
