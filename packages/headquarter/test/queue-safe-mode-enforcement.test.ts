/**
 * Safe mode is enforced at the layer that OWNS the act, not only at the
 * convenience wrapper above it (Wave 5 correction round ten, HIGH 3).
 *
 * ## What was open, executed rather than argued
 *
 * `HeadquarterOperations.queue` is a `public readonly` field. `src/operator/queue.ts`
 * contained ZERO occurrences of `safeMode` or `safe_mode`. So with safe mode
 * genuinely latched on a real file:
 *
 * ```
 * ops.claimNext(...)   -> refused safe_mode_engaged
 * ops.queue.claim(...) -> SUCCEEDED
 * ```
 *
 * And it was not one method. A hostile reviewer ran the ENTIRE lifecycle under
 * the latch — `queue.claim` → `start` → `heartbeat` → `complete`, all of them
 * fine, with the task reaching `running` — against a store HQ had just told the
 * Founder it could not stand behind.
 *
 * Two shipped sentences were false as a result, and both are corrected in
 * `PHASE_13_ADVANCED_RELIABILITY.md` beside this fix: the `claimNext` row, and
 * the `createTask` row's "claiming it is refused, so nothing it carries can
 * happen while safe mode stands".
 *
 * ## What is enforced now, and the asymmetry that is deliberately kept
 *
 * `OperatorQueue.claim` consults the latch FIRST — before assignability, least
 * privilege, the kill switch and the single-use approval nonce. `start`,
 * `heartbeat`, `complete`, `fail`, `releaseClaim` and `sweepExpiredLeases` stay
 * available on purpose, because the facade's own documented disposition leaves
 * `startTask`, `heartbeat`, `submitResult` and `failTask` available: they
 * belong to work claimed and started BEFORE the latch, and safe mode must never
 * remove a way to STOP something or to FIND OUT what is wrong. Both halves are
 * executed below.
 *
 * ## Why the enforcement cannot be patched off
 *
 * The gates live in a `#private` field of `OperatorQueue`, assigned only
 * through a module-private closure published by the class's own `static {}`
 * block — the recipe `service.ts` already uses for `readCapabilityRow` and
 * `readKillSwitchEngaged`. `installQueueSafeModeGate` can only ADD a gate, they
 * are OR-ed, and a gate that throws counts as ENGAGED, so a hostile permissive
 * gate cannot mask the facade's real one.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import { OperatorQueue, installQueueSafeModeGate } from '../src/operator/queue.js';

/** A file-backed fixture with a genuinely latched `append_only_guard_missing`. */
function latched() {
  const fx = fileFixture();
  // A task that is QUEUED and unclaimed, so a claim is genuinely available to
  // whoever asks for one.
  expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: 'the-one-waiting' },
      idempotencyKey: 'waiting-for-a-claim',
      requestedBy: 'claude',
    }),
  );
  fx.db.close();
  const raw = fx.raw();
  raw.exec('DROP TRIGGER IF EXISTS trg_hq_reliability_verdicts_no_erase');
  raw.close();
  const after = fx.reopen('the-latched-process');
  expect(after.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
  return { fx, ops: after.ops, db: after.db };
}

describe('a latched safe mode is not steppable through the facade’s own public queue', () => {
  it('refuses the CLAIM at the canonical boundary, not only at claimNext', () => {
    const { fx, ops, db } = latched();
    try {
      // The control: the wrapper refuses, as it always did.
      const wrapper = ops.claimNext('claude', CAPS.openPr);
      expect(wrapper.ok).toBe(false);
      if (wrapper.ok) throw new Error('unreachable');
      expect(wrapper.error.code).toBe('safe_mode_engaged');

      // The finding: the SAME act through the public delegate. It used to
      // return a claimed task.
      expect(() => ops.queue.claim('claude', CAPS.openPr)).toThrow(/SAFE MODE/);

      // And nothing moved. `running` is what the reviewer's lifecycle reached.
      expect(ops.queue.listByStatus('running')).toEqual([]);
      const queued = ops.queue.listByStatus('queued');
      expect(queued.length).toBeGreaterThan(0);
      for (const task of queued) expect(task.claimedBy).toBeNull();
    } finally {
      db.close();
      fx.cleanup();
    }
  });

  it('the whole lifecycle the review ran cannot start: claim → start → heartbeat → complete', () => {
    const { fx, ops, db } = latched();
    try {
      const queued = ops.queue.listByStatus('queued');
      expect(queued.length).toBeGreaterThan(0);
      const target = queued[0]!;
      let claimed: { id: string; fence: number } | null = null;
      expect(() => {
        claimed = ops.queue.claim('claude', target.capabilityId, undefined, target.id);
      }).toThrow(/SAFE MODE/);
      expect(claimed).toBeNull();
      // With no claim there is no fence, so every later step is unreachable by
      // construction rather than by a second check: `start` demands the fence
      // the claim would have minted.
      expect(() => ops.queue.start(target.id, 'claude', 1)).toThrow();
      expect(ops.queue.get(target.id)!.status).toBe('queued');
      expect(ops.queue.get(target.id)!.claimedBy).toBeNull();
    } finally {
      db.close();
      fx.cleanup();
    }
  });

  it('a hostile patch of every reachable surface does not restore the claim', () => {
    const { fx, ops, db } = latched();
    try {
      // The three surfaces #200 documents as deliberately patchable, plus the
      // prototype, plus an attempt to install a permissive gate of one's own.
      (ops.queue as unknown as { killSwitchEngaged: () => boolean }).killSwitchEngaged = () => false;
      (ops.queue as unknown as { capabilities: { get: unknown } }).capabilities.get = () => ({
        id: CAPS.openPr,
        description: 'forged',
        riskClass: 'read_only',
        sideEffect: false,
        idempotent: true,
        enabled: true,
      });
      (OperatorQueue.prototype as unknown as { killSwitchEngaged: () => boolean }).killSwitchEngaged =
        () => false;
      installQueueSafeModeGate(ops.queue, () => false);
      Object.defineProperty(ops.queue, 'safeMode', { value: false, configurable: true });

      expect(() => ops.queue.claim('claude', CAPS.openPr)).toThrow(/SAFE MODE/);
      expect(ops.queue.listByStatus('running')).toEqual([]);
    } finally {
      delete (OperatorQueue.prototype as unknown as Record<string, unknown>).killSwitchEngaged;
      db.close();
      fx.cleanup();
    }
  });

  it('a gate that THROWS counts as engaged — fail closed on unknown', () => {
    const fx = fileFixture();
    try {
      // A healthy store: the facade's own gate says false.
      expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      installQueueSafeModeGate(fx.ops.queue, () => {
        throw new Error('cannot tell');
      });
      expect(() => fx.ops.queue.claim('claude', CAPS.openPr)).toThrow(/SAFE MODE/);
    } finally {
      fx.cleanup();
    }
  });

  it('keeps the deliberate asymmetry: work already claimed can still start, report and fail', () => {
    // The fixture takes its claim while the store is healthy; the latch lands
    // afterwards. Refusing these would strand a live execution with nowhere to
    // report, which is the opposite of what safe mode is for.
    const fx = fileFixture();
    try {
      const claim = fx.claim;
      fx.db.close();
      const raw = fx.raw();
      raw.exec('DROP TRIGGER IF EXISTS trg_hq_reliability_verdicts_no_erase');
      raw.close();
      const after = fx.reopen('the-latched-process');
      expect(after.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      expect(after.ops.startTask(claim.taskId, claim.workerId, claim.fence).ok).toBe(true);
      expect(after.ops.heartbeat(claim.taskId, claim.workerId, claim.fence).ok).toBe(true);
      const failed = after.ops.failTask(
        claim.taskId,
        claim.workerId,
        claim.fence,
        'The store is latched; standing down.',
      );
      expect(failed.ok).toBe(true);
      after.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('a healthy store still hands out claims — the gate refuses safe mode, not claiming', () => {
    const fx = fileFixture();
    try {
      expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      const created = expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'healthy' },
          idempotencyKey: 'healthy-claim',
          requestedBy: 'claude',
        }),
      );
      const claimed = fx.ops.queue.claim('claude', CAPS.openPr, undefined, created.task.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(created.task.id);
    } finally {
      fx.cleanup();
    }
  });
});
