/**
 * HQ lane F — lifecycle wiring (issue #139 / #122).
 *
 * create → classify → route → assign → claim → start → review → complete →
 * reconcile, driven entirely through `HeadquarterOperations`, asserting that
 * the canonical Operator guarantees still hold when reached through the
 * service layer.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CAPS, expectOk, fakeNominationSource, setupFixture, type Fixture } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';

describe('lane F — classify', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('derives gates from the capability registry, not from the caller', () => {
    expect(expectOk(fx.ops.classify(CAPS.readStatus))).toMatchObject({
      riskClass: 'read_only',
      requiresApproval: false,
      requiresIndependentReview: false,
      requiresIdempotencyKey: false,
      route: 'auto',
    });
    expect(expectOk(fx.ops.classify(CAPS.dropIndex))).toMatchObject({
      riskClass: 'destructive',
      requiresApproval: true,
      requiresIndependentReview: true,
      route: 'founder_approval',
    });
  });

  it('honours a standing Founder pre-approval for an external side effect', () => {
    expect(expectOk(fx.ops.classify(CAPS.openPr)).requiresApproval).toBe(false);
    // ...but never for a destructive capability, pre-approved or not.
    expect(expectOk(fx.ops.classify(CAPS.indexDoc)).requiresApproval).toBe(true);
  });

  it('denies an unknown capability by default', () => {
    const res = fx.ops.classify('shell.exec');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('unknown_capability');
  });
});

describe('lane F — create', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('creates a read-only task straight into the queue', () => {
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'JENIFY-OS' },
        requestedBy: 'claude',
        project: 'jenify-os',
        title: 'Check CI',
      }),
    );
    expect(created.task.status).toBe('queued');
    expect(fx.ops.readMeta(created.task.id)).toMatchObject({ project: 'jenify-os', title: 'Check CI' });
  });

  it('parks a Founder-gated capability in needs_approval', () => {
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.dropIndex,
        payload: { index: 'archive' },
        idempotencyKey: 'drop-1',
        requestedBy: 'claude',
      }),
    );
    expect(created.task.status).toBe('needs_approval');
  });

  it('reads the capability allow-list from the directory, never from the caller', () => {
    // 'codex' is only granted repo.read_status by the directory. Nothing the
    // caller passes can widen that — there is no argument for it.
    const res = fx.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: 'x' },
      idempotencyKey: 'pr-1',
      requestedBy: 'codex',
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('enqueue_rejected');
    expect(!res.ok && res.error.message).toContain('least privilege');
  });

  it('refuses an unknown requester (deny by default)', () => {
    const res = fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: {},
      requestedBy: 'ghost',
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('worker_not_assignable');
    expect(!res.ok && res.error.details?.reason).toBe('worker_unknown');
  });

  it('requires an idempotency key for a side-effect capability', () => {
    const res = fx.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: 'x' },
      requestedBy: 'claude',
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toContain('idempotency key');
  });

  it('deduplicates a repeated side-effect request instead of enqueuing twice', () => {
    const first = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'lane-f' },
        idempotencyKey: 'pr-lane-f',
        requestedBy: 'claude',
      }),
    );
    const second = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'lane-f' },
        idempotencyKey: 'pr-lane-f',
        requestedBy: 'claude',
      }),
    );
    expect(second.deduplicated).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    const rows = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM op_tasks WHERE idempotency_key = ?`)
      .get('pr-lane-f') as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('lane F — route and assign', () => {
  it('lets sources nominate but leaves the Operator as the authority', () => {
    const fx = setupFixture({
      nominationSources: [
        // An org/registry hook that nominates everyone, including a worker
        // without the grant, a disabled worker, and one that does not exist.
        fakeNominationSource('org-chart', [
          { workerId: 'claude', rationale: 'holds the build_lead role' },
          { workerId: 'codex', rationale: 'available' },
          { workerId: 'retired-bot', rationale: 'idle' },
          { workerId: 'ghost', rationale: 'claims every capability' },
        ]),
      ],
    });
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'pr-route',
        requestedBy: 'claude',
      }),
    );
    const routing = expectOk(fx.ops.routeTask(created.task.id));
    const byId = Object.fromEntries(routing.nominations.map((n) => [n.workerId, n]));

    expect(byId.claude.eligible).toBe(true);
    // Nominated, but the directory does not grant it github.open_pr.
    expect(byId.codex.eligible).toBe(false);
    expect(byId.codex.operatorDecision.outcome).toBe('deny');
    // Nominated, granted the capability, but disabled.
    expect(byId['retired-bot'].eligible).toBe(false);
    expect(byId['retired-bot'].assignability).toMatchObject({ assignable: false, reason: 'worker_inactive' });
    // Nominated out of thin air.
    expect(byId.ghost.eligible).toBe(false);
    expect(byId.ghost.assignability).toMatchObject({ assignable: false, reason: 'worker_unknown' });
  });

  it('survives a nomination source that throws', () => {
    const fx = setupFixture({
      nominationSources: [
        {
          id: 'broken',
          nominate: () => {
            throw new Error('registry offline');
          },
        },
        fakeNominationSource('org-chart', [{ workerId: 'claude' }]),
      ],
    });
    const created = expectOk(
      fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: {}, requestedBy: 'claude' }),
    );
    const routing = expectOk(fx.ops.routeTask(created.task.id));
    expect(routing.nominations.map((n) => n.workerId)).toEqual(['claude']);
  });

  it('records an advisory assignment that narrows who may claim', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'pr-assign',
        requestedBy: 'claude',
      }),
    );
    expectOk(fx.ops.assignTask(created.task.id, 'claude', 'founder', 'owns this lane'));

    // The intent changed no canonical state...
    expect(fx.ops.queue.get(created.task.id)!.status).toBe('queued');
    expect(fx.ops.queue.get(created.task.id)!.claimedBy).toBeNull();

    // ...but another eligible worker is turned away.
    const wrong = fx.ops.claimNext('jules', CAPS.openPr);
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.error.code).toBe('assigned_to_other_worker');

    expect(expectOk(fx.ops.claimNext('claude', CAPS.openPr)).claimedBy).toBe('claude');
  });

  it('refuses to assign a task to a worker the Operator would deny', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'pr-deny',
        requestedBy: 'claude',
      }),
    );
    const res = fx.ops.assignTask(created.task.id, 'codex', 'founder');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('not_permitted');
  });
});

describe('lane F — execution lifecycle', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('completes a read-only task directly, with no review gate', () => {
    const created = expectOk(
      fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: {}, requestedBy: 'claude' }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expect(claimed.status).toBe('assigned');
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expect(running.status).toBe('running');
    const done = expectOk(
      fx.ops.submitResult(created.task.id, 'claude', running.fence, { ci: 'green' }),
    );
    expect(done.status).toBe('completed');
    expect(done.reviewState).toBe('none');
  });

  it('holds a side-effect result for an independent reviewer', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'lane-f' },
        idempotencyKey: 'pr-review',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    const submitted = expectOk(
      fx.ops.submitResult(claimed.id, 'claude', running.fence, { pr: 42 }),
    );
    // Not completed — the executing worker cannot end its own side effect.
    expect(submitted.status).toBe('running');
    expect(submitted.reviewState).toBe('pending');

    const reviewed = expectOk(fx.ops.reviewTask(claimed.id, 'codex', 'pass', 'diff verified'));
    expect(reviewed.status).toBe('completed');
    expect(reviewed.reviewState).toBe('passed');
  });

  it('sends a failed review back for rework rather than completing', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'bad' },
        idempotencyKey: 'pr-fail',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(claimed.id, 'claude', running.fence, { pr: 43 }));
    const reviewed = expectOk(fx.ops.reviewTask(claimed.id, 'codex', 'fail', 'tests missing'));
    expect(reviewed.status).toBe('review_failed');
  });

  it('runs the full Founder-gated path: approve → claim → start → review', () => {
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.dropIndex,
        payload: { index: 'stale' },
        idempotencyKey: 'drop-full',
        requestedBy: 'claude',
      }),
    );
    expect(created.task.status).toBe('needs_approval');

    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === created.task.id)!;
    const approved = expectOk(
      fx.ops.approveTask({
        taskId: created.task.id,
        founderId: 'founder',
        expectedActionDigest: card.actionDigest,
      }),
    );
    expect(approved.status).toBe('queued');

    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.dropIndex));
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(claimed.id, 'claude', running.fence, { dropped: true }));
    expect(expectOk(fx.ops.reviewTask(claimed.id, 'codex', 'pass')).status).toBe('completed');
  });
});

describe('lane F — outcome_unknown and reconciliation', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  /** Claim with an already-expired lease, start, then sweep. */
  function abandonSideEffectTask(capabilityId: string, idempotencyKey: string): string {
    expectOk(
      fx.ops.createTask({
        capabilityId,
        payload: { thing: 1 },
        idempotencyKey,
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', capabilityId, -1_000));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    const swept = fx.ops.queue.sweepExpiredLeases();
    expect(swept.outcomeUnknown).toContain(claimed.id);
    return claimed.id;
  }

  it('never silently retries a side-effect task whose worker went silent', () => {
    const taskId = abandonSideEffectTask(CAPS.openPr, 'pr-abandoned');
    expect(fx.ops.queue.get(taskId)!.status).toBe('outcome_unknown');
  });

  it('re-queues an idempotent capability only on an explicit not-executed finding', () => {
    const taskId = abandonSideEffectTask(CAPS.openPr, 'pr-abandoned-2');
    const reconciled = expectOk(
      fx.ops.reconcileTask(taskId, 'confirmed_not_executed', 'founder', 'no PR exists'),
    );
    expect(reconciled.status).toBe('queued');
    expect(reconciled.claimedBy).toBeNull();
  });

  it('refuses to re-queue a non-idempotent capability from an uncertain outcome', () => {
    // dropIndex is destructive → approve it first, then abandon it.
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.dropIndex,
        payload: { index: 'x' },
        idempotencyKey: 'drop-abandon',
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
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.dropIndex, -1_000));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    fx.ops.queue.sweepExpiredLeases();

    const res = fx.ops.reconcileTask(claimed.id, 'confirmed_not_executed', 'founder', 'unclear');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toContain('not idempotent');
    expect(fx.ops.queue.get(claimed.id)!.status).toBe('outcome_unknown');
  });

  it('reports in-flight work as a blocker to replacing a worker', () => {
    const taskId = abandonSideEffectTask(CAPS.openPr, 'pr-abandoned-3');
    const plan = expectOk(fx.ops.replacementPlan('claude'));
    expect(plan.safe).toBe(false);
    expect(plan.blockers).toEqual([
      expect.objectContaining({ taskId, status: 'outcome_unknown', requires: 'reconciliation' }),
    ]);

    const guard = fx.ops.assertReplacementSafe('claude');
    expect(guard.ok).toBe(false);
    expect(!guard.ok && guard.error.code).toBe('replacement_blocked');

    expectOk(fx.ops.reconcileTask(taskId, 'confirmed_done', 'founder', 'PR exists, verified'));
    expect(expectOk(fx.ops.replacementPlan('claude')).safe).toBe(true);
  });

  it('requires a handover for a live claim', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'live' },
        idempotencyKey: 'pr-live',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));
    expect(expectOk(fx.ops.replacementPlan('claude')).blockers).toEqual([
      expect.objectContaining({ taskId: claimed.id, requires: 'handover' }),
    ]);
  });
});

describe('lane F — kill switch', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('stops new claims while engaged and resumes after release', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'pr-kill',
        requestedBy: 'claude',
      }),
    );
    expectOk(fx.ops.engageKillSwitch(CAPS.openPr, 'founder', 'incident 12'));

    const blocked = fx.ops.claimNext('claude', CAPS.openPr);
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.error.code).toBe('kill_switch_engaged');

    expectOk(fx.ops.releaseKillSwitch(CAPS.openPr, 'founder'));
    expect(expectOk(fx.ops.claimNext('claude', CAPS.openPr)).claimedBy).toBe('claude');
  });

  it('refuses to approve work into a queue that is switched off', () => {
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.dropIndex,
        payload: { index: 'x' },
        idempotencyKey: 'drop-kill',
        requestedBy: 'claude',
      }),
    );
    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === created.task.id)!;
    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'global halt'));

    const res = fx.ops.approveTask({
      taskId: created.task.id,
      founderId: 'founder',
      expectedActionDigest: card.actionDigest,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('kill_switch_engaged');
    // Nothing was written: the task is still awaiting a decision.
    expect(fx.ops.queue.get(created.task.id)!.status).toBe('needs_approval');
    expect(fx.ops.queue.get(created.task.id)!.approvalId).toBeNull();
  });
});
