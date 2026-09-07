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
  });

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
  });

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
  });
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
      // The lease was one millisecond; it is already in the past.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-clean-restart-'));
    try {
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
        const before = fs.readFileSync(fx.dbPath);

        const rebooted = fx.reopen('boot-two');
        expect(rebooted.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
        const report = expectOk(rebooted.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
        expect(report.interruptedTotal).toBe(0);
        expect(report.nowNeedingReconciliation).toBe(0);
        expect(rebooted.ops.getRun(run.id)!.outcome).toBe('succeeded');
        // The recovery pass wrote nothing at all, so the file is unchanged.
        expect(fs.readFileSync(fx.dbPath).equals(before)).toBe(true);
      } finally {
        fx.cleanup();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
