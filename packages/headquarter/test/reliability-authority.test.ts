/**
 * Phase 13 — AUTHORITY. Who may write a run, who may recover, who may
 * reconcile, what safe mode refuses, and the two negatives the phase turns on:
 * a run is never task authority, and an uncertain outcome is never retried.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import {
  claimSideEffectTask,
  fileFixture,
  reliabilityFixture,
  type ReliabilityFixture,
} from './reliability.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import {
  RELIABILITY_COMMAND_CAPABILITY,
  registerReliabilityCommandCapability,
} from '../src/application/reliability-command.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { EvidenceLog, verifyEvidenceChain } from '../src/operator/evidence.js';
import { founderConsole } from '../src/application/console.js';

function expectError(result: { ok: boolean; error?: { code: string; message: string } }): {
  code: string;
  message: string;
} {
  expect(result.ok).toBe(false);
  return result.error!;
}

function openRun(fx: ReliabilityFixture, over: Record<string, unknown> = {}) {
  return fx.ops.openRun({
    taskId: fx.claim.taskId,
    workerId: fx.claim.workerId,
    fence: fx.claim.fence,
    runKind: 'external_action',
    label: 'publish the release note',
    ...over,
  } as Parameters<HeadquarterOperations['openRun']>[0]);
}

describe('a run write is authorized by the live fenced claim, and by nothing else', () => {
  it('accepts the worker holding the current claim', () => {
    const fx = reliabilityFixture();
    const opened = expectOk(openRun(fx));
    expect(opened.deduplicated).toBe(false);
    expect(opened.run.workerId).toBe('claude');
    expect(opened.run.taskId).toBe(fx.claim.taskId);
    expect(opened.run.state).toBe('open');
  });

  it('refuses a different worker, a stale fence, and an unknown task', () => {
    const fx = reliabilityFixture();
    expect(expectError(openRun(fx, { workerId: 'jules' })).code).toBe('stale_run_claim');
    expect(expectError(openRun(fx, { fence: fx.claim.fence + 7 })).code).toBe('stale_run_claim');
    expect(expectError(openRun(fx, { taskId: 'task-that-never-existed' })).code).toBe('unknown_task');
  });

  it('refuses the FOUNDER, who holds approval authority and never a claim', () => {
    const fx = reliabilityFixture();
    expect(expectError(openRun(fx, { workerId: 'founder' })).code).toBe('stale_run_claim');
  });

  it('refuses a task that is not executing', () => {
    const fx = reliabilityFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'unclaimed' },
        requestedBy: 'claude',
      }),
    );
    const refusal = expectError(
      openRun(fx, { taskId: created.task.id, workerId: 'claude', fence: 0 }),
    );
    expect(refusal.code).toBe('stale_run_claim');
  });

  it('reads the claim from the store, not from the patchable queue read', () => {
    // `queue.get` is documented as safe to patch precisely because enforcement
    // never dispatches through it. A run write is enforcement, so it must not
    // either — a forged claim on the public read must buy nothing.
    const fx = reliabilityFixture();
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
      expect(expectError(openRun(fx, { workerId: 'jules', fence: 99 })).code).toBe('stale_run_claim');
      // And the legitimate claim still works, so the patch changed nothing at all.
      expect(expectOk(openRun(fx)).run.workerId).toBe('claude');
    } finally {
      // Restored, because `OperatorQueue.prototype` is shared with every other
      // test in this process — a patch left standing would silently rewrite
      // what later suites are testing.
      queuePrototype.get = realGet;
    }
  });
});

describe('duplicate runs and duplicate attempts', () => {
  it('deduplicates an identical open onto the standing run instead of creating a second', () => {
    const fx = reliabilityFixture();
    const first = expectOk(openRun(fx));
    const second = expectOk(openRun(fx));
    expect(second.deduplicated).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(fx.ops.listRuns()).toHaveLength(1);
  });

  it('lets a deliberately fresh open be a different run', () => {
    const fx = reliabilityFixture();
    const first = expectOk(openRun(fx));
    const fresh = expectOk(openRun(fx, { idempotencyKey: 'second-go' }));
    expect(fresh.deduplicated).toBe(false);
    expect(fresh.run.id).not.toBe(first.run.id);
  });

  it('admits exactly one open attempt, and refuses a second while it stands', () => {
    const fx = reliabilityFixture();
    const run = expectOk(openRun(fx)).run;
    const first = expectOk(
      fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }),
    );
    expect(first.generation).toBe(1);
    expect(first.correlationId).toBe(`${run.id}#1`);
    const second = expectError(
      fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }),
    );
    expect(second.code).toBe('run_attempt_refused');
  });

  it('NEVER admits another attempt after an unknown outcome — the law of the phase', () => {
    const fx = reliabilityFixture();
    const run = expectOk(openRun(fx)).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    expectOk(
      fx.ops.recordRunOutcome({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
        outcome: 'outcome_unknown',
        failureCategory: 'provider_unavailable',
        note: 'the provider timed out after the request was sent',
      }),
    );
    const refusal = expectError(
      fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }),
    );
    expect(refusal.code).toBe('run_attempt_refused');
    expect(refusal.message).toMatch(/never retried automatically/i);
    // And re-opening the same work does not produce a clean run either.
    expect(expectOk(openRun(fx)).run.id).toBe(run.id);
    expect(fx.ops.getRun(run.id)!.needsReconciliation).toBe(true);
  });

  /**
   * Wave 5 Medium 2, as the exploit that found it. Both enforcement layers —
   * the derivation and the UNIQUE index on the attempt key — bind to the run
   * key, and the run key used to include the caller's `label`: ≤120 characters
   * of arbitrary free text. Same task, same worker, same live fence, one added
   * full stop, and a SECOND run opened with a fresh admitted attempt beside a
   * run standing at `needs_reconciliation` / `outcome_unknown` for that very
   * work.
   */
  it('is not walked around by re-labelling the same work', () => {
    const fx = reliabilityFixture();
    const run = expectOk(openRun(fx, { label: 'publish the thing' })).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    expectOk(
      fx.ops.recordRunOutcome({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
        outcome: 'outcome_unknown',
        note: 'the provider timed out after the request was sent',
      }),
    );
    expect(fx.ops.getRun(run.id)!.needsReconciliation).toBe(true);

    // The one-character rename deduplicates onto the standing run rather than
    // opening a second one.
    const relabelled = expectOk(openRun(fx, { label: 'publish the thing.' }));
    expect(relabelled.deduplicated).toBe(true);
    expect(relabelled.run.id).toBe(run.id);
    expect(fx.ops.listRuns()).toHaveLength(1);
    // And no fresh generation is admitted on it.
    expect(
      expectError(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }))
        .code,
    ).toBe('run_attempt_refused');
  });

  /**
   * The other half of Medium 2: the deliberate `idempotencyKey` escape hatch
   * must not become a way to put a fresh admitted attempt beside unresolved
   * work on the same task either.
   */
  it('refuses a NEW run on a task that already stands at needs_reconciliation', () => {
    const fx = reliabilityFixture();
    const run = expectOk(openRun(fx)).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    expectOk(
      fx.ops.recordRunOutcome({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
        outcome: 'outcome_unknown',
        note: 'the provider timed out after the request was sent',
      }),
    );
    const refusal = expectError(openRun(fx, { idempotencyKey: 'a-deliberately-fresh-one' }));
    expect(refusal.code).toBe('run_attempt_refused');
    expect(refusal.message).toMatch(/never retried automatically/i);
    expect(fx.ops.listRuns()).toHaveLength(1);

    // Once a human has reconciled it, a fresh run is available again.
    expectOk(
      fx.ops.reconcileRun({
        runId: run.id,
        decision: 'confirmed_not_executed',
        note: 'checked the provider; nothing landed',
        requestedBy: 'coo',
      }),
    );
    expect(expectOk(openRun(fx, { idempotencyKey: 'a-deliberately-fresh-one' })).run.id).not.toBe(run.id);
  });

  it('refuses an outcome against a run with no open attempt', () => {
    const fx = reliabilityFixture();
    const run = expectOk(openRun(fx)).run;
    expect(
      expectError(
        fx.ops.recordRunOutcome({
          runId: run.id,
          workerId: 'claude',
          fence: fx.claim.fence,
          outcome: 'succeeded',
        }),
      ).code,
    ).toBe('run_state_conflict');
  });
});

describe('reconciliation: approval authority, independence, and the idempotency rule', () => {
  function unknownRun(fx: ReliabilityFixture): string {
    const run = expectOk(openRun(fx)).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    expectOk(
      fx.ops.recordRunOutcome({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
        outcome: 'outcome_unknown',
      }),
    );
    return run.id;
  }

  it('refuses a worker, an unknown actor, and a human without approval authority', () => {
    const fx = reliabilityFixture();
    const runId = unknownRun(fx);
    for (const actor of ['claude', 'nobody-at-all', 'analyst']) {
      expect(
        expectError(
          fx.ops.reconcileRun({ runId, decision: 'confirmed_failed', note: 'x', requestedBy: actor }),
        ).code,
      ).toBe('not_permitted');
    }
  });

  it('refuses the worker that CARRIED the run even when its name is also a principal with approval authority', () => {
    const fx = reliabilityFixture();
    const runId = unknownRun(fx);
    // Register the carrying worker's own name as a human principal WITH
    // approval authority — the most direct attempt at "the entity whose
    // attempt is in doubt declares what it did".
    fx.principals.register({
      id: 'claude',
      displayName: 'Claude the human, apparently',
      originateCapabilities: [],
      approvalAuthority: true,
      active: true,
    });
    const refusal = expectError(
      fx.ops.reconcileRun({
        runId,
        decision: 'confirmed_succeeded',
        note: 'it was me, I checked',
        requestedBy: 'claude',
      }),
    );
    expect(refusal.code).toBe('not_permitted');
    // Refused by the FIRST of the two guards: `assertApprovalAuthority` denies
    // any registered worker outright, whatever a principal row says. The
    // independence check in `reconcileRun` stands behind it as defence in
    // depth for the same reason `reconcileAction` carries one — a run carried
    // by an identity that is not a registered worker is not representable
    // today, and the guard should not depend on that staying true.
    expect(refusal.message).toMatch(/worker identity never carries approval authority/i);
    // The independent principal still gets through, so the refusal was about
    // WHO asked and not about the run.
    expect(
      expectOk(
        fx.ops.reconcileRun({
          runId,
          decision: 'confirmed_succeeded',
          note: 'checked GitHub: the PR exists',
          requestedBy: 'coo',
        }),
      ).run.outcome,
    ).toBe('succeeded');
  });

  it('accepts an independent principal with approval authority, and closes the run', () => {
    const fx = reliabilityFixture();
    const runId = unknownRun(fx);
    const reconciled = expectOk(
      fx.ops.reconcileRun({
        runId,
        decision: 'confirmed_succeeded',
        note: 'the PR exists on GitHub; the attempt landed',
        requestedBy: 'coo',
      }),
    );
    expect(reconciled.run.state).toBe('concluded');
    expect(reconciled.run.outcome).toBe('succeeded');
    expect(reconciled.run.reconciliation).toMatchObject({ by: 'coo', decision: 'confirmed_succeeded' });
    expect(reconciled.run.admitsAttempt).toBe(false);
  });

  it('reopens exactly one further attempt on confirmed_not_executed, for an idempotent capability', () => {
    const fx = reliabilityFixture();
    const runId = unknownRun(fx);
    const reopened = expectOk(
      fx.ops.reconcileRun({
        runId,
        decision: 'confirmed_not_executed',
        note: 'no PR exists; nothing was created',
        requestedBy: 'coo',
      }),
    );
    expect(reopened.run.admitsAttempt).toBe(true);
    expect(reopened.run.nextGeneration).toBe(2);
    const second = expectOk(
      fx.ops.startRunAttempt({ runId, workerId: 'claude', fence: fx.claim.fence }),
    );
    expect(second.generation).toBe(2);
    expect(second.correlationId).toBe(`${runId}#2`);
  });

  it('refuses confirmed_not_executed for a NON-idempotent capability', () => {
    const fx = reliabilityFixture();
    // `archive.index_document` is a non-idempotent side effect; a task on it
    // needs a real Founder approval, which the fixture's Founder can give.
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { doc: 'annual-report' },
        idempotencyKey: 'index-once',
        requestedBy: 'claude',
      }),
    );
    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === created.task.id)!;
    expectOk(
      fx.ops.approveTask({
        taskId: created.task.id,
        founderId: 'founder',
        expectedActionDigest: card.actionDigest,
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.indexDoc, undefined, created.task.id));
    const run = expectOk(
      fx.ops.openRun({
        taskId: claimed.id,
        workerId: 'claude',
        fence: claimed.fence,
        runKind: 'external_action',
        label: 'index the annual report',
      }),
    ).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: claimed.fence }));
    expectOk(
      fx.ops.recordRunOutcome({
        runId: run.id,
        workerId: 'claude',
        fence: claimed.fence,
        outcome: 'outcome_unknown',
      }),
    );
    const refusal = expectError(
      fx.ops.reconcileRun({
        runId: run.id,
        decision: 'confirmed_not_executed',
        note: 'probably fine',
        requestedBy: 'coo',
      }),
    );
    expect(refusal.code).toBe('not_permitted');
    expect(refusal.message).toMatch(/not idempotent/i);
  });

  it('refuses to reconcile a run whose outcome is known', () => {
    const fx = reliabilityFixture();
    const run = expectOk(openRun(fx)).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    expectOk(
      fx.ops.recordRunOutcome({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
        outcome: 'succeeded',
      }),
    );
    expect(
      expectError(
        fx.ops.reconcileRun({ runId: run.id, decision: 'confirmed_failed', note: 'no', requestedBy: 'coo' }),
      ).code,
    ).toBe('run_state_conflict');
  });
});

describe('a run is never task authority — behaviourally, in both directions', () => {
  it('changes nothing about a task, forward: opening, attempting and failing a run moves no canonical state', () => {
    const fx = reliabilityFixture();
    const before = fx.ops.queue.get(fx.claim.taskId)!;
    const run = expectOk(openRun(fx)).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    expectOk(
      fx.ops.recordRunOutcome({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
        outcome: 'outcome_unknown',
      }),
    );
    const after = fx.ops.queue.get(fx.claim.taskId)!;
    expect(after.status).toBe(before.status);
    expect(after.fence).toBe(before.fence);
    expect(after.claimedBy).toBe(before.claimedBy);
    expect(after.approvalId).toBe(before.approvalId);
    expect(after.reviewState).toBe(before.reviewState);
    expect(after.result).toEqual(before.result);
    // The task's own lifecycle still works exactly as it did.
    expect(expectOk(fx.ops.startTask(fx.claim.taskId, 'claude', fx.claim.fence)).status).toBe('running');
  });

  it('changes nothing about a task, in reverse: a facade with no run ledger answers identically', () => {
    // Absence changes nothing either, which is what "not authority" has to
    // mean in both directions.
    const withLedger = reliabilityFixture();
    const run = expectOk(openRun(withLedger)).run;
    expectOk(
      withLedger.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: withLedger.claim.fence }),
    );
    const plain = setupFixture();
    const plainClaim = claimSideEffectTask(plain, 'rel-side-effect');
    const a = withLedger.ops.queue.get(withLedger.claim.taskId)!;
    const b = plain.ops.queue.get(plainClaim.taskId)!;
    expect(a.status).toBe(b.status);
    expect(a.capabilityId).toBe(b.capabilityId);
    expect(a.reviewState).toBe(b.reviewState);
    expect(expectOk(withLedger.ops.classify(CAPS.openPr))).toEqual(
      expectOk(plain.ops.classify(CAPS.openPr)),
    );
  });

  it('never lets a run state buy a claim, an approval or an execution', () => {
    const fx = reliabilityFixture();
    const run = expectOk(openRun(fx)).run;
    expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    // A forged public read that reports a gloriously successful run.
    const forged = { ...fx.ops.getRun(run.id)!, state: 'concluded' as const, outcome: 'succeeded' as const };
    const prototype = Object.getPrototypeOf(fx.ops) as Record<string, unknown>;
    const realGetRun = prototype.getRun;
    const realListRuns = prototype.listRuns;
    fx.ops.getRun = () => forged;
    prototype.getRun = () => forged;
    prototype.listRuns = () => [forged];
    // Proven to have taken on the public surface...
    expect(fx.ops.getRun(run.id)!.outcome).toBe('succeeded');
    const after = new HeadquarterOperations(fx.db, { store: new HeadquarterStore(fx.db) });
    expect(after.getRun(run.id)!.outcome).toBe('succeeded');
    // ...and to buy nothing. A second attempt is still refused, on both facades.
    expect(
      expectError(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence })).code,
    ).toBe('run_attempt_refused');
    expect(
      expectError(after.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence })).code,
    ).toBe('run_attempt_refused');
    prototype.getRun = realGetRun;
    prototype.listRuns = realListRuns;
  });

  it('is not mentioned at all by the four modules that decide whether work may run', () => {
    // Behaviour alone cannot prove a negative about every future call site, so
    // the source itself is pinned — the Phase 12 recipe.
    const root = new URL('../src/operator/', import.meta.url).pathname;
    for (const file of ['queue.ts', 'policy.ts', 'approvals.ts', 'capabilities.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source, file).not.toMatch(/hq_reliability_/);
      expect(source, file).not.toMatch(/reliability-command/);
      expect(source, file).not.toMatch(/needs_reconciliation/);
    }
  });
});

describe('safe mode', () => {
  /**
   * Removes ONE append-only guard from a real HQ file, through a raw
   * connection that never ran the application's code — the tamper the
   * structural check exists to catch.
   */
  function tamper(fx: ReturnType<typeof fileFixture>): void {
    const raw = fx.raw();
    raw.exec('DROP TRIGGER trg_hq_action_events_no_erase');
  }

  it('is disengaged on a healthy store, and every act works', () => {
    const fx = fileFixture();
    try {
      expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(
        expectOk(fx.ops.openRun({
          taskId: fx.claim.taskId,
          workerId: 'claude',
          fence: fx.claim.fence,
          runKind: 'dispatch',
          label: 'healthy',
        })).run.state,
      ).toBe('open');
    } finally {
      fx.cleanup();
    }
  });

  it('engages at the NEXT construction when an append-only guard is removed', () => {
    const fx = fileFixture();
    try {
      tamper(fx);
      const restarted = fx.reopen('process-two');
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.map((o) => o.finding)).toContain('append_only_guard_missing');
      expect(posture.integrity.depth).toBe('structural');
      expect(posture.integrity.observations[0]!.detail).toContain('trg_hq_action_events_no_erase');
    } finally {
      fx.cleanup();
    }
  });

  it('refuses the acts that add to, approve, release or execute against the record', () => {
    const fx = fileFixture();
    try {
      tamper(fx);
      const restarted = fx.reopen('process-two');
      const ops = restarted.ops;

      // A Founder-gated command.
      const assessGate = ops.recordVerifiedBackup({ backupPath: '/nope', requestedBy: 'founder' });
      // (recordVerifiedBackup is deliberately PERMITTED in safe mode, so this
      // fails on the path check instead — proven below. The Founder-gated act
      // that is refused is any OTHER capability gate; a claim is the one every
      // deployment has.)
      expect(assessGate.ok).toBe(false);
      expect(!assessGate.ok && assessGate.error.code).toBe('backup_verification_failed');

      // A claim.
      const claim = ops.claimNext('claude', CAPS.openPr);
      expect(claim.ok).toBe(false);
      expect(!claim.ok && claim.error.code).toBe('safe_mode_engaged');
      expect(!claim.ok && claim.error.message).toMatch(/append_only_guard_missing/);

      // Releasing a safety stop.
      expectOk(ops.engageKillSwitch('*', 'founder', 'investigating'));
      const release = ops.releaseKillSwitch('*', 'founder');
      expect(release.ok).toBe(false);
      expect(!release.ok && release.error.code).toBe('safe_mode_engaged');

      // Opening new work to track.
      const opened = ops.openRun({
        taskId: fx.claim.taskId,
        workerId: 'claude',
        fence: fx.claim.fence,
        runKind: 'dispatch',
        label: 'should not open',
      });
      expect(opened.ok).toBe(false);
      expect(!opened.ok && opened.error.code).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });

  it('keeps reading, recovering, reconciling and STOPPING available', () => {
    const fx = fileFixture();
    try {
      const run = expectOk(
        fx.ops.openRun({
          taskId: fx.claim.taskId,
          workerId: 'claude',
          fence: fx.claim.fence,
          runKind: 'external_action',
          label: 'in flight when it all went wrong',
        }),
      ).run;
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      tamper(fx);
      const restarted = fx.reopen('process-two');
      const ops = restarted.ops;
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // Reads answer.
      expect(ops.getRun(run.id)!.state).toBe('attempting');
      expect(ops.listRunsBounded().total).toBe(1);

      // Engaging a stop is the fail-safe direction and stays available.
      expectOk(ops.engageKillSwitch('*', 'founder', 'safe mode'));

      // Recovery works — it is the act that resolves the state.
      const report = expectOk(ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(report.safeMode).toBe(true);
      expect(report.interruptedTotal).toBe(1);
      expect(report.classified[0]).toMatchObject({ uncertain: true, outcome: 'outcome_unknown' });

      // And so does reconciliation.
      expectOk(
        ops.reconcileRun({
          runId: run.id,
          decision: 'confirmed_failed',
          note: 'checked the provider; the request never landed and cannot be resumed',
          requestedBy: 'coo',
        }),
      );
      expect(ops.getRun(run.id)!.outcome).toBe('failed');
    } finally {
      fx.cleanup();
    }
  });

  it('is read from private state, so a forged posture read buys nothing', () => {
    const fx = fileFixture();
    try {
      tamper(fx);
      const restarted = fx.reopen('process-two');
      const ops = restarted.ops;
      const healthy = { ...ops.hqReliabilityPosture() };
      healthy.integrity = { ...healthy.integrity, safeMode: false, observations: [] };
      const prototype = Object.getPrototypeOf(ops) as Record<string, unknown>;
      const realPosture = prototype.hqReliabilityPosture;
      const realSummary = prototype.reliabilitySummary;
      ops.hqReliabilityPosture = () => healthy;
      prototype.hqReliabilityPosture = () => healthy;
      prototype.reliabilitySummary = () => ({ safeMode: false }) as never;
      // Proven to have taken on the public surface, on the instance and on the
      // prototype, and on a facade constructed AFTER the patch...
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      const after = fx.reopen('process-three');
      expect(after.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      // ...and to buy no claim on either facade.
      expect(!ops.claimNext('claude', CAPS.openPr).ok).toBe(true);
      expect(!after.ops.claimNext('claude', CAPS.openPr).ok).toBe(true);
      prototype.hqReliabilityPosture = realPosture;
      prototype.reliabilitySummary = realSummary;
    } finally {
      fx.cleanup();
    }
  });

  it('is cleared only by an assessment that finds nothing blocking — never by assertion', () => {
    const fx = fileFixture();
    try {
      tamper(fx);
      const restarted = fx.reopen('process-two');
      const ops = restarted.ops;
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // The boot ITSELF re-created the guard — every `ensure*Schema` is
      // `CREATE TRIGGER IF NOT EXISTS` — and safe mode is engaged anyway,
      // because the finding is about what was found, not about what was then
      // repaired. So a full assessment of the file AS IT NOW STANDS honestly
      // finds nothing blocking, and that is what clears it.
      const cleared = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(cleared.depth).toBe('full');
      expect(cleared.safeMode).toBe(false);
      // A claim works again — the fixture's own task is already claimed, so
      // this needs a fresh one to claim.
      expectOk(
        ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'after-the-repair' },
          idempotencyKey: 'after-the-repair',
          requestedBy: 'claude',
        }),
      );
      expect(expectOk(ops.claimNext('claude', CAPS.openPr)).claimedBy).toBe('claude');

      // And a full assessment while a guard is GENUINELY gone re-engages it,
      // so clearing is a finding rather than a formality.
      fx.raw().exec('DROP TRIGGER trg_hq_action_events_no_rewrite');
      const still = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(still.safeMode).toBe(true);
      expect(still.observations.map((o) => o.finding)).toContain('append_only_guard_missing');
      expect(!ops.claimNext('claude', CAPS.openPr).ok).toBe(true);

      // There is no parameter anywhere that clears it by assertion.
      const source = fs.readFileSync(
        new URL('../src/application/service.ts', import.meta.url).pathname,
        'utf8',
      );
      expect(source).not.toMatch(/clearSafeMode|forceSafeMode|overrideSafeMode|acknowledgeSafeMode/);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Wave 5 Critical 1: the assessment read the evidence chain through
   * `queue.evidence.verifyChain` — a PUBLIC own-property closure the queue
   * documents as safe to patch. `evidence_chain_broken` is one of only three
   * blocking findings and the assessment is the only path that CLEARS the
   * latch, so that read was the one lever a same-realm caller needed: break
   * the chain, let a dropped guard latch safe mode at boot, replace
   * `verifyChain` with `() => null`, and the ordinary Founder assessment
   * cleared the latch over a record HQ could not stand behind.
   *
   * Patched on the instance AND on `EvidenceLog.prototype`, because a fix that
   * merely moved the call to `PrivilegedQueueApi` would still dispatch through
   * that exported class's prototype.
   */
  it('reads the evidence chain from private truth, so patching verifyChain cannot clear the latch', () => {
    const fx = fileFixture();
    const prototype = EvidenceLog.prototype as unknown as Record<string, unknown>;
    const realVerify = prototype.verifyChain;
    try {
      // A guard is gone (safe mode latches at boot) AND the hash chain is
      // genuinely broken by a raw writer that never ran HQ's code.
      tamper(fx);
      const raw = fx.raw();
      const first = raw.prepare(`SELECT seq FROM op_evidence ORDER BY seq LIMIT 1`).get() as {
        seq: number;
      };
      raw.prepare(`UPDATE op_evidence SET actor = 'forged-actor' WHERE seq = ?`).run(first.seq);

      const restarted = fx.reopen('process-two');
      const ops = restarted.ops;
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // The patch, taken on every surface a same-realm caller can reach.
      ops.queue.evidence.verifyChain = () => null;
      prototype.verifyChain = () => null;
      expect(ops.queue.evidence.verifyChain()).toBeNull();
      expect(new EvidenceLog(restarted.db).verifyChain()).toBeNull();

      // The assessment is unmoved: the chain really is broken, so the latch
      // stands and names the finding.
      const assessed = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(assessed.depth).toBe('full');
      expect(assessed.safeMode).toBe(true);
      expect(assessed.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // And nothing may claim against it.
      const claim = ops.claimNext('claude', CAPS.openPr);
      expect(claim.ok).toBe(false);
      expect(!claim.ok && claim.error.code).toBe('safe_mode_engaged');
    } finally {
      prototype.verifyChain = realVerify;
      fx.cleanup();
    }
  });
});

/**
 * Wave 5 review, HIGH finding 1.
 *
 * `assessHqIntegrity` used to compute `evidence_chain_broken` — one of the
 * three `SAFE_MODE_BLOCKING_FINDINGS`, and the only one that detects tampering
 * with HQ's OWN audit record — through `() => this.queue.evidence.verifyChain()`.
 * `queue` is a public `readonly` field and `queue.evidence` is a mutable
 * own-property object literal that issue #200 deliberately keeps as a
 * PATCHABLE read surface, safe exactly while nothing is enforced on it.
 *
 * The exploit the reviewer demonstrated against a real file: break the chain by
 * a LEGAL APPEND from a raw connection, let the Founder assess (safe mode
 * engages, correctly), then set `ops.queue.evidence.verifyChain = () => null`.
 * The next legitimate Founder assessment found nothing, CLEARED the latch, and
 * handed `releaseKillSwitch` and `claimNext` back out against a chain that was
 * still broken.
 *
 * The fix is the pattern `#capabilityFromStore` and `#runClaimFact` already
 * use: a `#private` closure over the facade's own handle and the module-level
 * `verifyEvidenceChain`. Nothing on the public object graph — and no prototype
 * method — participates.
 */
describe('the safe-mode evidence verdict is computed from enforcement-safe truth', () => {
  /**
   * Break the hash chain by APPENDING a row from a raw connection, which is
   * the write `op_evidence` legitimately permits: its guarantee is the chain,
   * not a trigger. Nothing is updated and nothing is deleted.
   */
  function breakChainByLegalAppend(fx: ReturnType<typeof fileFixture>): void {
    fx.raw()
      .prepare(
        `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'forged-evidence-entry',
        new Date().toISOString(),
        null,
        'not-hq',
        'forged',
        '{"executable":false}',
        'genesis',
        'a-hash-that-was-never-computed-over-anything',
      );
  }

  it('engages on a genuinely broken chain, and no patch of the public surface clears it', () => {
    const fx = fileFixture();
    const evidencePrototype = EvidenceLog.prototype as unknown as Record<string, unknown>;
    const realVerify = evidencePrototype.verifyChain;
    const realList = evidencePrototype.list;
    try {
      breakChainByLegalAppend(fx);
      const ops = fx.ops;

      // (a) UNPATCHED: the finding engages and safe mode latches.
      const engaged = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(engaged.depth).toBe('full');
      expect(engaged.safeMode).toBe(true);
      expect(engaged.observations.map((o) => o.finding)).toContain('evidence_chain_broken');

      // Now the patch, on the INSTANCE own-property closure AND on the
      // prototype of the class behind it — proven to have TAKEN on every
      // public read a caller could reach.
      ops.queue.evidence.verifyChain = () => null;
      evidencePrototype.verifyChain = () => null;
      evidencePrototype.list = () => [];
      expect(ops.queue.evidence.verifyChain()).toBeNull();
      expect(new EvidenceLog(fx.db).verifyChain()).toBeNull();

      // (b) The already-latched verdict is NOT cleared by the next legitimate
      // Founder assessment. This is the half the exploit turned on.
      const stillEngaged = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(stillEngaged.safeMode).toBe(true);
      expect(stillEngaged.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // (c) And the acts safe mode exists to refuse still refuse.
      expectOk(ops.engageKillSwitch('*', 'founder', 'investigating the chain'));
      const release = ops.releaseKillSwitch('*', 'founder');
      expect(release.ok).toBe(false);
      expect(!release.ok && release.error.code).toBe('safe_mode_engaged');
      expectOk(
        ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'after-the-patch' },
          idempotencyKey: 'after-the-patch',
          requestedBy: 'claude',
        }),
      );
      const claim = ops.claimNext('claude', CAPS.openPr);
      expect(claim.ok).toBe(false);
      expect(!claim.ok && claim.error.code).toBe('safe_mode_engaged');

      // (d) A facade constructed AFTER the patch reaches the same verdict.
      const after = fx.reopen('process-two');
      const afterReport = expectOk(after.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(afterReport.safeMode).toBe(true);
      expect(afterReport.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      expect(!after.ops.claimNext('claude', CAPS.openPr).ok).toBe(true);

      // (e) An independent recomputation, on a raw handle that never met the
      // patched objects, agrees the chain is genuinely broken — so none of the
      // above is safe mode standing on a stale latch.
      expect(verifyEvidenceChain(fx.raw())).not.toBeNull();
    } finally {
      evidencePrototype.verifyChain = realVerify;
      evidencePrototype.list = realList;
      fx.cleanup();
    }
  });

  it('still clears on a HEALTHY chain, so the finding is a verdict rather than a formality', () => {
    const fx = fileFixture();
    try {
      // Engaged by an unrelated blocking finding, then cleared by an
      // assessment of a file whose chain genuinely verifies. If the new
      // computation were merely pessimistic, this would never clear.
      fx.raw().exec('DROP TRIGGER trg_hq_action_events_no_erase');
      const restarted = fx.reopen('process-two');
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const cleared = expectOk(restarted.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(cleared.safeMode).toBe(false);
      expect(cleared.observations.map((o) => o.finding)).not.toContain('evidence_chain_broken');
      expect(verifyEvidenceChain(fx.db)).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The merge of the two Wave 5 correction lanes kept ONE chain computation
   * (`verifyEvidenceChain`) and dropped the other lane's inlined copy, but
   * carried that copy's one better behaviour into the survivor: a payload that
   * is not JSON is a BREAK at that seq, not a `JSON.parse` exception thrown out
   * of the verification.
   *
   * `fullIntegrity` does treat a THROWN verifier as a broken chain, so safe
   * mode was never at risk either way. The difference this pins is the public
   * read: `EvidenceLog.verifyChain` and `verifyEvidenceChain` now NAME the bad
   * entry to any caller, instead of failing with an error that says nothing
   * about which row is wrong.
   */
  it('treats an unparseable payload as a break at that seq rather than throwing', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      const before = verifyEvidenceChain(raw);
      expect(before).toBeNull();
      raw
        .prepare(
          `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'unparseable-payload-entry',
          new Date().toISOString(),
          null,
          'not-hq',
          'forged',
          'this is not json',
          'genesis',
          'a-hash-that-was-never-computed-over-anything',
        );
      const seq = (
        raw.prepare(`SELECT seq FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as {
          seq: number;
        }
      ).seq;
      expect(verifyEvidenceChain(raw)).toBe(seq);
      expect(new EvidenceLog(raw).verifyChain()).toBe(seq);
      // And the verdict that matters is unchanged: the chain is broken, so a
      // fresh assessment engages safe mode rather than clearing it.
      const restarted = fx.reopen('process-two');
      const assessed = expectOk(restarted.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(assessed.safeMode).toBe(true);
      expect(assessed.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
    } finally {
      fx.cleanup();
    }
  });

  it('reads the chain through no public delegate at all', () => {
    // Behaviour cannot prove a negative about every future call site, so the
    // source is pinned too: the one call that decides safe mode goes through
    // the `#private` closure, and `queue.evidence.verifyChain` appears in this
    // file only inside comments explaining why it must not.
    const source = fs.readFileSync(
      new URL('../src/application/service.ts', import.meta.url).pathname,
      'utf8',
    );
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/queue\.evidence\.verifyChain/);
    expect(code).toContain('verifyEvidenceChain: this.#verifyEvidenceChainFromStore');
  });
});

describe('the two Founder acts fail closed exactly like every other capability gate', () => {
  it('refuses when the capability is not registered', () => {
    const fx = reliabilityFixture({ registerReliability: false });
    const refusal = expectError(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
    expect(refusal.code).toBe('unknown_capability');
    expect(refusal.message).toMatch(/separate, deliberate configuration action/);
  });

  it('refuses when the Founder does not hold the originate grant', () => {
    const fx = reliabilityFixture({ grantReliability: false });
    expect(expectError(fx.ops.assessHqIntegrity({ requestedBy: 'founder' })).code).toBe('not_permitted');
  });

  it('refuses when the registered definition has drifted from its reserved contract', () => {
    const fx = reliabilityFixture();
    new CapabilityRegistry(fx.db).register({
      ...RELIABILITY_COMMAND_CAPABILITY,
      riskClass: 'read_only',
    });
    const refusal = expectError(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
    expect(refusal.code).toBe('not_permitted');
    expect(refusal.message).toMatch(/no longer matches its reserved contract/);
  });

  it('refuses a registered worker outright, and refuses `system`', () => {
    const fx = reliabilityFixture();
    expect(expectError(fx.ops.assessHqIntegrity({ requestedBy: 'claude' })).code).toBe('not_permitted');
    expect(expectError(fx.ops.assessHqIntegrity({ requestedBy: 'system' })).code).toBe('not_permitted');
  });

  it('registers the capability only as a deliberate configuration action', () => {
    const fx = reliabilityFixture({ registerReliability: false });
    expect(fx.ops.queue.capabilities.get(RELIABILITY_COMMAND_CAPABILITY.id)).toBeNull();
    registerReliabilityCommandCapability(fx.db);
    expect(fx.ops.queue.capabilities.get(RELIABILITY_COMMAND_CAPABILITY.id)).toMatchObject({
      riskClass: 'founder_gate',
      sideEffect: false,
    });
  });
});
