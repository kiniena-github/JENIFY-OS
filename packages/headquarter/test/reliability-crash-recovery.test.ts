/**
 * Phase 13 — CRASH AND RESTART, proved with a real process and a real file.
 *
 * The claim under test is not "a function returns the right string": it is
 * that when a process carrying HQ work DIES, the next process tells the truth
 * about what it finds. A test that simulated the crash by calling a method
 * would be testing the method. So the first suite here starts a genuine child
 * `node` process, has it open a run and reserve an attempt against a real
 * SQLite file, and then kills it with SIGKILL — no unwinding, no cleanup, no
 * chance to record anything. Recovery then runs in the parent, over the file
 * the dead process left behind.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { founderConsole } from '../src/application/console.js';

/**
 * The child runs as `node --import tsx <script>` rather than through the `tsx`
 * CLI, and that detail is load-bearing: the CLI spawns a grandchild, so killing
 * "the process" would kill the grandchild and leave a wrapper to exit tidily.
 * `--import` keeps it to ONE process, so the SIGKILL asserted below is the
 * death of the process that actually held the run.
 */
const CHILD_NODE_ARGS = ['--import', 'tsx'];

/**
 * The child program. It opens a run and reserves an attempt against the file,
 * prints the run id, and then kills ITSELF with SIGKILL — the closest thing to
 * a power cut a test can arrange, and specifically not a path that can run a
 * finally block, flush a buffer or record an outcome.
 */
function childSource(dbPath: string, taskId: string, fence: number, mode: 'attempt' | 'open'): string {
  return `
import { openHqDatabase } from ${JSON.stringify(new URL('../src/store/db.ts', import.meta.url).pathname)};
import { HeadquarterOperations } from ${JSON.stringify(
    new URL('../src/application/service.ts', import.meta.url).pathname,
  )};

const db = openHqDatabase(${JSON.stringify(dbPath)});
const ops = new HeadquarterOperations(db, {
  policyCtx: { preApprovedCapabilities: new Set([${JSON.stringify(CAPS.openPr)}]) },
  processIdentity: 'the-process-that-died',
});
const opened = ops.openRun({
  taskId: ${JSON.stringify(taskId)},
  workerId: 'claude',
  fence: ${fence},
  runKind: 'external_action',
  label: 'publishing something to the outside world',
});
if (!opened.ok) {
  console.log('CHILD_ERROR ' + JSON.stringify(opened.error));
  process.exit(2);
}
${
  mode === 'attempt'
    ? `const attempt = ops.startRunAttempt({ runId: opened.data.run.id, workerId: 'claude', fence: ${fence} });
if (!attempt.ok) {
  console.log('CHILD_ERROR ' + JSON.stringify(attempt.error));
  process.exit(2);
}
console.log('CHILD_RUN ' + opened.data.run.id + ' ' + attempt.data.correlationId);`
    : `console.log('CHILD_RUN ' + opened.data.run.id + ' none');`
}
db.close();
// Die the way a crashed process dies: no unwinding, no cleanup, no outcome.
process.kill(process.pid, 'SIGKILL');
`;
}

interface CrashResult {
  runId: string;
  correlationId: string;
}

function crashAfter(
  dir: string,
  dbPath: string,
  taskId: string,
  fence: number,
  mode: 'attempt' | 'open',
): CrashResult {
  const script = path.join(dir, `child-${mode}.ts`);
  fs.writeFileSync(script, childSource(dbPath, taskId, fence, mode));
  const result = spawnSync(process.execPath, [...CHILD_NODE_ARGS, script], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: new URL('..', import.meta.url).pathname,
  });
  const stdout = `${result.stdout ?? ''}`;
  const line = stdout.split('\n').find((l) => l.startsWith('CHILD_RUN'));
  if (!line) {
    throw new Error(
      `the child process did not record a run.\nstdout: ${stdout}\nstderr: ${result.stderr}`,
    );
  }
  // It really did die by signal rather than exiting normally.
  expect(result.signal).toBe('SIGKILL');
  const [, runId, correlationId] = line.trim().split(' ');
  return { runId: runId!, correlationId: correlationId! };
}

/**
 * The three tests below spawn a REAL child `node` process against a real
 * file-backed SQLite database, and they are the heaviest tests this wave has
 * (Wave 5 correction round thirteen, Low 2).
 *
 * The timeout remediation of the previous round gave explicit deadlines to
 * `facade-write-scan.test.ts` and `integrity-statement-truth.test.ts`, and its
 * claims were correctly scoped to those two files. This file was left at
 * vitest's 5 s default with no explicit deadline at all, which is a residual of
 * that fix rather than a false claim in it: the test that actually failed CI
 * #552 with `Test timed out in 5000ms` measured 361 ms, and each of these three
 * measures more than twice that. The child has to be spawned, transpile TypeScript
 * on the way up, open the database, reserve an attempt and then SIGKILL itself,
 * and a shared runner under load stretches process spawn far more than it
 * stretches an in-process query.
 *
 * Measured on this machine over two full runs with the whole package in
 * parallel: 825-1137 ms for these three, the slowest single observation being
 * the `outcome_unknown` classification at 1137 ms (882 ms with the file run
 * alone). 60 s is ~53x that slowest observed run, which is the same headroom the
 * other two files carry.
 *
 * **The other nine tests in this file are deliberately left at the default**,
 * and that is stated rather than quietly done. They use the same file-backed
 * fixture but spawn no child process, and they measure 113-186 ms over the same
 * two runs — well under the 361 ms that failed. Widening the deadline to
 * every test that touches a file would give up the signal a hang carries in the
 * ones that are genuinely fast.
 *
 * Per test rather than a package-wide `testTimeout`: raising the global default
 * would relax the deadline for EVERY test in this package, however many there
 * are, including the many where a hang is the real signal. (The count that
 * stood here — "all 3451 tests" — was the third spelling of the same defect the
 * concurrent round-thirteen lane closed in `integrity-statement-truth.test.ts`
 * and `facade-write-scan.test.ts`: a present-tense whole-suite figure in a test
 * docblock, correct at the head that wrote it and stale at the next merge. The
 * sentence never needed it, and `phase-doc-name-truth.test.ts` now refuses it.)
 * Only the harness deadline changes here;
 * every assertion is untouched.
 *
 * **A sibling residual, measured and deliberately not changed here.**
 * `decide-routing-cli.test.ts` carries a ~1.4 s test (`treats an unrecognised
 * value as unknown rather than as a clean answer`, 1393 ms and 1410 ms over the
 * same two parallel runs) at the same 5 s default. It is a different subsystem and not
 * this correction's finding, so it is recorded here for whoever picks it up
 * rather than folded into a commit that did not measure the rest of that file.
 */
const CHILD_PROCESS_TIMEOUT_MS = 60_000;

describe('a real process dies mid-attempt, and the next one tells the truth about it', () => {
  it('classifies the interrupted SIDE-EFFECT attempt as outcome_unknown and never retries it', () => {
    const fx = fileFixture({ processIdentity: 'the-process-that-recovers' });
    try {
      const crashed = crashAfter(fx.dir, fx.dbPath, fx.claim.taskId, fx.claim.fence, 'attempt');

      // The parent is a different process identity, so what it sees is a run
      // it did not open, standing at an attempt nobody ever closed.
      const survivor = fx.reopen('the-process-that-recovers');
      const before = survivor.ops.getRun(crashed.runId)!;
      expect(before.state).toBe('attempting');
      expect(before.processId).toBe('the-process-that-died');
      expect(before.lastCorrelationId).toBe(crashed.correlationId);

      const report = expectOk(
        survivor.ops.recoverInterruptedRuns({ requestedBy: 'founder' }),
      );
      expect(report.processIdentity).toBe('the-process-that-recovers');
      expect(report.interruptedTotal).toBe(1);
      expect(report.classified[0]).toMatchObject({
        runId: crashed.runId,
        openedByProcess: 'the-process-that-died',
        reason: 'process_interrupted',
        uncertain: true,
        outcome: 'outcome_unknown',
      });
      expect(report.retryStatement).toMatch(/NEVER retried automatically/i);

      const after = survivor.ops.getRun(crashed.runId)!;
      expect(after.state).toBe('needs_reconciliation');
      expect(after.outcome).toBe('outcome_unknown');
      expect(after.interruption).toMatchObject({ reason: 'process_interrupted', uncertain: true });
      expect(after.admitsAttempt).toBe(false);

      // The whole point: nothing was retried, and nothing can be.
      const retry = survivor.ops.startRunAttempt({
        runId: crashed.runId,
        workerId: 'claude',
        fence: fx.claim.fence,
      });
      expect(retry.ok).toBe(false);
      expect(!retry.ok && retry.error.code).toBe('run_attempt_refused');
      expect(after.attempts).toBe(1);
    } finally {
      fx.cleanup();
    }
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('concludes a crash BEFORE any attempt as not_executed, because the ledger proves it', () => {
    const fx = fileFixture({ processIdentity: 'the-process-that-recovers' });
    try {
      const crashed = crashAfter(fx.dir, fx.dbPath, fx.claim.taskId, fx.claim.fence, 'open');
      const survivor = fx.reopen('the-process-that-recovers');
      const report = expectOk(survivor.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(report.classified[0]).toMatchObject({ uncertain: false, outcome: 'not_executed' });
      const after = survivor.ops.getRun(crashed.runId)!;
      expect(after.state).toBe('concluded');
      expect(after.outcome).toBe('not_executed');
      expect(after.attempts).toBe(0);
    } finally {
      fx.cleanup();
    }
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('leaves the canonical task exactly where the crash left it', () => {
    const fx = fileFixture({ processIdentity: 'the-process-that-recovers' });
    try {
      const before = fx.ops.queue.get(fx.claim.taskId)!;
      crashAfter(fx.dir, fx.dbPath, fx.claim.taskId, fx.claim.fence, 'attempt');
      const survivor = fx.reopen('the-process-that-recovers');
      expectOk(survivor.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      const after = survivor.ops.queue.get(fx.claim.taskId)!;
      // Recovery classifies a RUN. The task is canonical truth owned by the
      // queue, and recovery is not one of the things that moves it.
      expect(after.status).toBe(before.status);
      expect(after.fence).toBe(before.fence);
      expect(after.claimedBy).toBe(before.claimedBy);
      expect(after.approvalId).toBe(before.approvalId);
    } finally {
      fx.cleanup();
    }
  }, CHILD_PROCESS_TIMEOUT_MS);
});

describe('recovery is scoped, repeatable and honest about what it did not touch', () => {
  function interruptedRunFrom(fx: ReturnType<typeof fileFixture>): string {
    const dead = fx.reopen('a-process-that-is-gone');
    const run = expectOk(
      dead.ops.openRun({
        taskId: fx.claim.taskId,
        workerId: 'claude',
        fence: fx.claim.fence,
        runKind: 'external_action',
        label: 'interrupted work',
      }),
    ).run;
    expectOk(dead.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
    return run.id;
  }

  it('leaves THIS process’s own runs strictly alone — they may genuinely be in flight', () => {
    const fx = fileFixture({ processIdentity: 'still-running' });
    try {
      const mine = expectOk(
        fx.ops.openRun({
          taskId: fx.claim.taskId,
          workerId: 'claude',
          fence: fx.claim.fence,
          runKind: 'dispatch',
          label: 'still going',
        }),
      ).run;
      expectOk(fx.ops.startRunAttempt({ runId: mine.id, workerId: 'claude', fence: fx.claim.fence }));
      const report = expectOk(fx.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(report.interruptedTotal).toBe(0);
      expect(fx.ops.getRun(mine.id)!.state).toBe('attempting');
    } finally {
      fx.cleanup();
    }
  });

  it('is safe to run twice: the second pass finds nothing left to classify', () => {
    const fx = fileFixture({ processIdentity: 'the-survivor' });
    try {
      const runId = interruptedRunFrom(fx);
      const survivor = fx.reopen('the-survivor');
      expect(expectOk(survivor.ops.recoverInterruptedRuns({ requestedBy: 'founder' })).interruptedTotal).toBe(1);
      const second = expectOk(survivor.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(second.interruptedTotal).toBe(0);
      expect(second.nowNeedingReconciliation).toBe(1);
      expect(survivor.ops.getRun(runId)!.events.filter((e) => e.kind === 'interrupted')).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Wave 5 Medium 1. `process_id` proves "not the process running this
   * recovery"; it does not prove "dead", and HQ holds no liveness signal that
   * would. So a Founder-gated recovery run while another process is genuinely
   * mid-attempt classifies that live attempt as interrupted. The truthful
   * outcome the live worker then reported was refused `run_state_conflict`,
   * and the ledger permanently asserted an interruption that never happened —
   * closable only by a human guessing.
   *
   * The correction does not pretend the classification did not happen: the
   * interruption event stays, and the worker that still holds the LIVE FENCED
   * CLAIM (which a dead process cannot) records what it observed on top.
   *
   * Wave 5 Critical 1 corrected the correction. The late statement is
   * TESTIMONY, not a verdict: it is recorded as `worker_report`, the run stays
   * at `needs_reconciliation`, and only `reconcileRun` — independent, stepped
   * up, idempotency-checked — closes it. The exploit this pins the door on is
   * chased to its end in the test below.
   */
  it('accepts a live worker’s truthful outcome on a run a concurrent recovery classified', () => {
    const fx = fileFixture({ processIdentity: 'the-worker-that-is-still-alive' });
    try {
      // This process is live and mid-attempt.
      const mine = expectOk(
        fx.ops.openRun({
          taskId: fx.claim.taskId,
          workerId: 'claude',
          fence: fx.claim.fence,
          runKind: 'external_action',
          label: 'publishing something, right now',
        }),
      ).run;
      expectOk(fx.ops.startRunAttempt({ runId: mine.id, workerId: 'claude', fence: fx.claim.fence }));

      // A SECOND process runs the Founder-gated recovery. It sees a different
      // process id and classifies the live attempt.
      const other = fx.reopen('a-second-process-running-recovery');
      const report = expectOk(other.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(report.interruptedTotal).toBe(1);
      expect(fx.ops.getRun(mine.id)!.state).toBe('needs_reconciliation');
      expect(fx.ops.getRun(mine.id)!.outcome).toBe('outcome_unknown');

      // The live worker finishes and says what actually happened.
      expectOk(
        fx.ops.recordRunOutcome({
          runId: mine.id,
          workerId: 'claude',
          fence: fx.claim.fence,
          outcome: 'succeeded',
          note: 'the publish completed; the recovery pass had already classified it',
        }),
      );
      const settled = fx.ops.getRun(mine.id)!;
      // The statement is ON the record...
      expect(settled.workerReport).toEqual({
        by: 'claude',
        at: expect.any(String),
        outcome: 'succeeded',
        failureCategory: 'none',
        note: 'the publish completed; the recovery pass had already classified it',
      });
      // ...and it decided nothing. HQ still does not KNOW, so it still says so.
      expect(settled.state).toBe('needs_reconciliation');
      expect(settled.outcome).toBe('outcome_unknown');
      expect(settled.needsReconciliation).toBe(true);
      expect(settled.reconciliation).toBeNull();
      expect(settled.attempts).toBe(1);
      expect(settled.nextGeneration).toBe(1);
      expect(settled.admitsAttempt).toBe(false);
      // The classification is still in the append-only ledger, and the report
      // is recorded beside it as the testimony it is.
      expect(settled.events.map((e) => e.kind)).toEqual([
        'opened',
        'attempt_started',
        'interrupted',
        'worker_report',
      ]);
      expect(settled.events.find((e) => e.kind === 'worker_report')!.detail.afterInterruption).toBe(
        true,
      );

      // An INDEPENDENT principal, reading that testimony, is what closes it.
      expectOk(
        other.ops.reconcileRun({
          runId: mine.id,
          decision: 'confirmed_succeeded',
          note: 'checked the provider; the worker’s report matches what landed',
          requestedBy: 'coo',
        }),
      );
      const closed = fx.ops.getRun(mine.id)!;
      expect(closed.state).toBe('concluded');
      expect(closed.outcome).toBe('succeeded');
      expect(closed.reconciliation!.by).toBe('coo');
      // Still no further attempt: `confirmed_succeeded` reopens nothing.
      expect(closed.admitsAttempt).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Wave 5 CRITICAL 1, chased all the way to the second irreversible act.
   *
   * The previous round's test stopped at `admitsAttempt: false` on the FIRST
   * run, which is why the hole was missed: the second attempt does not come
   * from the first run, it comes from a SECOND run on the same task. The
   * `openRun` guard is what refuses that, and it is keyed on
   * `needsReconciliation` — so any path that clears `needsReconciliation`
   * without a human clears the guard too.
   *
   * The exploit, executed end to end: a worker holding a live fenced claim on
   * a NON-IDEMPOTENT external-side-effect capability opens a run and starts an
   * attempt; a Founder recovery from a second process classifies it
   * `interrupted` / `outcome_unknown` / `needs_reconciliation`; the worker then
   * reports a late outcome. Before the fix the report concluded the run, the
   * guard lifted, a second `openRun` on the same task succeeded and a second
   * attempt started — the same irreversible act, twice, with no independent
   * principal anywhere in the chain.
   */
  it('a late worker report can never re-admit a second run or a second attempt on the same task', () => {
    const fx = fileFixture({ processIdentity: 'the-worker-that-is-still-alive' });
    try {
      // A NON-IDEMPOTENT external side effect: the capability `reconcileRun`
      // refuses to reopen even for a human, so nothing here may reopen it.
      new CapabilityRegistry(fx.db).register({
        id: 'irreversible.wire_transfer',
        description: 'Send money. Once.',
        riskClass: 'external_side_effect',
        sideEffect: true,
        idempotent: false,
      });
      fx.store.upsertSpecialist({
        id: 'claude',
        displayName: 'Claude',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: [CAPS.readStatus, CAPS.openPr, 'irreversible.wire_transfer'],
        active: true,
      });
      const created = expectOk(
        fx.ops.createTask({
          capabilityId: 'irreversible.wire_transfer',
          payload: { amount: 1 },
          idempotencyKey: 'the-one-transfer',
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
      const claimed = expectOk(
        fx.ops.claimNext('claude', 'irreversible.wire_transfer', 60 * 60_000, created.task.id),
      );

      const first = expectOk(
        fx.ops.openRun({
          taskId: claimed.id,
          workerId: 'claude',
          fence: claimed.fence,
          runKind: 'external_action',
          label: 'send the transfer',
        }),
      ).run;
      expectOk(fx.ops.startRunAttempt({ runId: first.id, workerId: 'claude', fence: claimed.fence }));

      const other = fx.reopen('a-second-process-running-recovery');
      expectOk(other.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(fx.ops.getRun(first.id)!.needsReconciliation).toBe(true);

      // The worker reports a late success. Accepted — and load-bearing that it
      // is: this is the Medium-1 guarantee that a live worker can tell the
      // truth. It must not also be the thing that unlocks the task.
      expectOk(
        fx.ops.recordRunOutcome({
          runId: first.id,
          workerId: 'claude',
          fence: claimed.fence,
          outcome: 'succeeded',
          note: 'the transfer went out',
        }),
      );
      expect(fx.ops.getRun(first.id)!.needsReconciliation).toBe(true);

      // THE EXPLOIT STEP. A second run on the same task, which is where a
      // second admitted attempt generation would come from.
      const second = fx.ops.openRun({
        taskId: claimed.id,
        workerId: 'claude',
        fence: claimed.fence,
        runKind: 'external_action',
        label: 'send the transfer',
        idempotencyKey: 'deliberately-fresh',
      });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('the openRun guard lifted');
      // The refusal's NAME changed in the three-lane merge and its meaning did
      // not: the third lane added a second, EARLIER `openRun` guard that refuses
      // any open against a task carrying an unreconciled run, so the answer is
      // now `run_state_conflict` rather than the in-reservation
      // `run_attempt_refused` that answered it before. Both are categorical
      // refusals naming the standing run; what this test exists to pin — that
      // the late worker report does NOT lift the guard — is unchanged, and the
      // in-reservation guard survives beneath it as the re-check under the
      // reservation.
      expect(second.error.code).toBe('run_state_conflict');
      expect(second.error.details!.runId).toBe(first.id);

      // And no second attempt is reachable through the first run either.
      const again = fx.ops.startRunAttempt({
        runId: first.id,
        workerId: 'claude',
        fence: claimed.fence,
      });
      expect(again.ok).toBe(false);

      // Nor can the worker unlock it by reconciling: independence is required,
      // and for a NON-IDEMPOTENT capability `confirmed_not_executed` is
      // refused even to an independent, approval-bearing principal.
      const selfReconcile = fx.ops.reconcileRun({
        runId: first.id,
        decision: 'confirmed_not_executed',
        note: 'I checked my own work and nothing happened',
        requestedBy: 'claude',
      });
      expect(selfReconcile.ok).toBe(false);
      const reopenNonIdempotent = other.ops.reconcileRun({
        runId: first.id,
        decision: 'confirmed_not_executed',
        note: 'checked the bank; nothing left the account',
        requestedBy: 'coo',
      });
      expect(reopenNonIdempotent.ok).toBe(false);
      if (reopenNonIdempotent.ok) throw new Error('a non-idempotent capability was reopened');
      expect(reopenNonIdempotent.error.code).toBe('not_permitted');

      // Exactly one attempt was ever reserved against this work.
      expect(fx.ops.getRun(first.id)!.attempts).toBe(1);
      expect(fx.ops.listRuns({ taskId: claimed.id })).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  it('still refuses an outcome on a run that has been RECONCILED', () => {
    const fx = fileFixture({ processIdentity: 'the-worker' });
    try {
      const runId = interruptedRunFrom(fx);
      const survivor = fx.reopen('the-survivor');
      expectOk(survivor.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expectOk(
        survivor.ops.reconcileRun({
          runId,
          decision: 'confirmed_failed',
          note: 'checked the provider; the request never landed',
          requestedBy: 'coo',
        }),
      );
      const refused = fx.ops.recordRunOutcome({
        runId,
        workerId: 'claude',
        fence: fx.claim.fence,
        outcome: 'succeeded',
      });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error.code).toBe('run_state_conflict');
      expect(fx.ops.getRun(runId)!.outcome).toBe('failed');
    } finally {
      fx.cleanup();
    }
  });

  it('takes approval authority, and refuses a worker or a stranger', () => {
    const fx = fileFixture();
    try {
      for (const actor of ['claude', 'nobody', 'system']) {
        const result = fx.ops.recoverInterruptedRuns({ requestedBy: actor });
        expect(result.ok, actor).toBe(false);
        expect(!result.ok && result.error.code).toBe('not_permitted');
      }
    } finally {
      fx.cleanup();
    }
  });

  it('carries an explicit interruption reason when one is stated', () => {
    const fx = fileFixture({ processIdentity: 'the-survivor' });
    try {
      const runId = interruptedRunFrom(fx);
      const survivor = fx.reopen('the-survivor');
      const report = expectOk(
        survivor.ops.recoverInterruptedRuns({ requestedBy: 'founder', reason: 'provider_outage' }),
      );
      expect(report.classified[0]!.reason).toBe('provider_outage');
      expect(survivor.ops.getRun(runId)!.interruption!.reason).toBe('provider_outage');
    } finally {
      fx.cleanup();
    }
  });

  it('COUNTS interrupted canonical work owned by other ledgers, and writes nothing into them', () => {
    const fx = fileFixture({ processIdentity: 'the-survivor' });
    try {
      // A task whose lease has genuinely expired, and one the queue moved to
      // outcome_unknown — both are the OPERATOR's business, not this ledger's.
      const created = expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'expiring' },
          idempotencyKey: 'expiring',
          requestedBy: 'claude',
        }),
      );
      const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr, 1, created.task.id));
      expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
      // The lease was one millisecond, and this used to rely on incidental
      // elapsed time for it to be in the past. Round sixteen's atomicity fix
      // (High B-4) put the whole of `OperatorQueue.claim` inside ONE
      // transaction, which made the claim fast enough that the clock could
      // still be inside that millisecond by the time the sweep ran — so the
      // assertion below measured the scheduler, not the sweep. The expiry is
      // now waited for explicitly. Strictly stronger: the race is gone in both
      // directions, and nothing about what is asserted has changed.
      const leaseExpiry = (
        fx.raw().prepare(`SELECT lease_expires_at FROM op_tasks WHERE id = ?`).get(claimed.id) as {
          lease_expires_at: string;
        }
      ).lease_expires_at;
      while (new Date().toISOString() <= leaseExpiry) {
        // A one-millisecond lease; this spins for at most that long.
      }
      const sweep = fx.ops.queue.sweepExpiredLeases();
      expect(sweep.outcomeUnknown).toContain(claimed.id);

      const beforeTasks = fx.raw().prepare(`SELECT * FROM op_tasks ORDER BY id`).all();
      const beforeActions = fx.raw().prepare(`SELECT COUNT(*) AS n FROM hq_action_events`).get();

      const posture = fx.ops.hqReliabilityPosture();
      expect(posture.canonical.tasksOutcomeUnknown).toBe(1);
      expect(posture.canonical.resolvedBy.tasksOutcomeUnknown).toMatch(/reconcileTask/);
      expect(posture.canonical.resolvedBy.tasksWithExpiredLease).toMatch(/sweepExpiredLeases/);
      expect(posture.canonical.statement).toMatch(/writes nothing into any other/i);

      const report = expectOk(fx.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(report.canonical.tasksOutcomeUnknown).toBe(1);

      // And the other ledgers are byte-for-byte where they were.
      expect(fx.raw().prepare(`SELECT * FROM op_tasks ORDER BY id`).all()).toEqual(beforeTasks);
      expect(fx.raw().prepare(`SELECT COUNT(*) AS n FROM hq_action_events`).get()).toEqual(beforeActions);
    } finally {
      fx.cleanup();
    }
  });
});

describe('a restart with nothing wrong changes nothing', () => {
  it('recovers zero runs, engages no safe mode, and leaves every record identical', () => {
    const fx = fileFixture({ processIdentity: 'boot-one' });
    try {
      const run = expectOk(
        fx.ops.openRun({
          taskId: fx.claim.taskId,
          workerId: 'claude',
          fence: fx.claim.fence,
          runKind: 'dispatch',
          label: 'finished cleanly',
        }),
      ).run;
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      expectOk(
        fx.ops.recordRunOutcome({
          runId: run.id,
          workerId: 'claude',
          fence: fx.claim.fence,
          outcome: 'succeeded',
        }),
      );

      /*
       * "Nothing was written" is asserted against the LEDGERS, not against the
       * main database file (Wave 5 Low). Under WAL a committed write lands in
       * `-wal` and leaves `hq.sqlite` byte-identical until a checkpoint, so
       * comparing main-file bytes here passed whether or not the recovery pass
       * wrote — proved vacuous by executing it against a pass that does write.
       * Row counts and the evidence watermark are what actually move.
       */
      const raw = fx.raw();
      const counts = () => ({
        runs: raw.prepare(`SELECT COUNT(*) AS n FROM hq_reliability_runs`).get(),
        runEvents: raw.prepare(`SELECT COUNT(*) AS n FROM hq_reliability_run_events`).get(),
        tasks: raw.prepare(`SELECT * FROM op_tasks ORDER BY id`).all(),
        evidenceWatermark: raw.prepare(`SELECT MAX(seq) AS seq, COUNT(*) AS n FROM op_evidence`).get(),
        hqEvents: raw.prepare(`SELECT COUNT(*) AS n FROM hq_events`).get(),
      });
      const before = counts();

      const rebooted = fx.reopen('boot-two');
      expect(rebooted.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      const report = expectOk(rebooted.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(report.interruptedTotal).toBe(0);
      expect(report.nowNeedingReconciliation).toBe(0);
      expect(rebooted.ops.getRun(run.id)!.outcome).toBe('succeeded');
      expect(counts()).toEqual(before);
    } finally {
      fx.cleanup();
    }
  });
});
