/**
 * HQ lane F — hostile security regressions for the application/service layer
 * (issue #139 / #122).
 *
 * The canonical Operator gates are already attacked directly in
 * `security.test.ts`. These tests attack them THROUGH the new Headquarter
 * wiring, because a wiring layer is exactly where such gates get accidentally
 * bypassed: the point is that reaching the Operator through
 * `HeadquarterOperations` is never weaker than reaching it directly, and in
 * four places (directory-sourced allow-lists, digest-echoed approvals,
 * assignability re-checked at claim AND start, Founder-only human principals)
 * it is strictly stronger.
 *
 * Direct SQL tampering is used deliberately to simulate a hostile or buggy
 * writer that got around the public API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPS, expectOk, fakeNominationSource, setupFixture, type Fixture } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { HeadquarterOperations } from '../src/application/service.js';

/** Create a Founder-gated task and return its id plus the displayed digest. */
function gatedTask(fx: Fixture, idempotencyKey: string, payload: Record<string, unknown> = { index: 'x' }) {
  const created = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.dropIndex,
      payload,
      idempotencyKey,
      requestedBy: 'claude',
    }),
  );
  const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === created.task.id)!;
  return { taskId: created.task.id, digest: card.actionDigest };
}

describe('lane F — the Founder can only approve what was on screen', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('refuses the approval when the action changed after it was rendered', () => {
    const { taskId, digest } = gatedTask(fx, 'mutate-1');
    // Hostile writer swaps the payload between render and click.
    fx.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ index: 'production' }), taskId);

    const res = fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('action_digest_mismatch');

    // Nothing at all was written: no approval row, no status change.
    const approvals = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM hq_approvals WHERE task_id = ?`)
      .get(taskId) as { n: number };
    expect(approvals.n).toBe(0);
    expect(fx.ops.queue.get(taskId)!.status).toBe('needs_approval');
    expect(
      fx.ops.queue.evidence.list(taskId).some((e) => e.kind === 'approval_refused_action_changed'),
    ).toBe(true);
  });

  it('refuses an approval with no digest echoed at all', () => {
    const { taskId } = gatedTask(fx, 'mutate-2');
    const res = fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: '' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('action_digest_mismatch');
  });

  it('still rejects at the execution boundary when the action is mutated after a valid approval', () => {
    const { taskId, digest } = gatedTask(fx, 'mutate-3');
    expectOk(fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest }));
    fx.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ index: 'production' }), taskId);

    const claim = fx.ops.claimNext('claude', CAPS.dropIndex);
    expect(claim.ok).toBe(false);
    const task = fx.ops.queue.get(taskId)!;
    expect(task.status).toBe('blocked');
    expect(task.approvalId).toBeNull();
    expect(task.blockReason).toMatch(/changed after Founder approval/i);
  });

  it('rejects a replayed approval after its single use', () => {
    const { taskId, digest } = gatedTask(fx, 'replay-1');
    expectOk(fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest }));
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.dropIndex));
    expect(claimed.approvalId).toBeTruthy();

    // Hostile writer forces the task back into the queue to ride the same
    // approval a second time.
    fx.db
      .prepare(
        `UPDATE op_tasks SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL, claim_nonce = NULL WHERE id = ?`,
      )
      .run(taskId);

    const replay = fx.ops.claimNext('claude', CAPS.dropIndex);
    expect(replay.ok).toBe(false);
    const task = fx.ops.queue.get(taskId)!;
    expect(task.status).toBe('needs_approval');
    expect(task.approvalId).toBeNull();
    const rejection = fx.ops.queue.evidence
      .list(taskId)
      .find((e) => e.kind === 'approval_rejected_at_execution');
    expect(rejection?.payload.rejection).toBe('approval_already_consumed');
  });

  it('keeps the approved action identical to the executed action', () => {
    const { taskId, digest } = gatedTask(fx, 'stable-1');
    expectOk(fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest }));
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.dropIndex));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    // Nothing the service layer does between approval and execution can move
    // the action out from under the Founder's decision.
    expect(taskActionDigest(fx.ops.queue.get(taskId)!)).toBe(digest);
  });

  it('exposes no way to edit a task action at all', () => {
    const surface = [
      ...Object.getOwnPropertyNames(HeadquarterOperations.prototype),
      ...Object.keys(fx.ops),
    ];
    expect(
      surface.filter((name) =>
        /^(set|update|edit|patch|mutate|force|override)(Task|Payload|Capability|Approval)/i.test(name),
      ),
    ).toEqual([]);
  });
});

describe('lane F — approval time-box at execution start', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never starts on an approval that expired between claim and start', () => {
    const { taskId, digest } = gatedTask(fx, 'expiry-1');
    expectOk(
      fx.ops.approveTask({
        taskId,
        founderId: 'founder',
        expectedActionDigest: digest,
        ttlMs: 60_000,
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.dropIndex));

    vi.setSystemTime(new Date('2026-01-01T00:01:00.001Z'));
    const res = fx.ops.startTask(taskId, 'claude', claimed.fence);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/expired before execution start/i);

    const task = fx.ops.queue.get(taskId)!;
    expect(task.status).toBe('needs_approval'); // fresh Founder decision required
    expect(task.claimedBy).toBeNull(); // the void claim was released
    expect(task.approvalId).toBeNull();
  });
});

describe('lane F — claim binding: worker, fence, nonce', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  function approvedClaim() {
    const { taskId, digest } = gatedTask(fx, `bind-${Math.random()}`);
    expectOk(fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest }));
    return expectOk(fx.ops.claimNext('claude', CAPS.dropIndex));
  }

  it('refuses a start from a worker that does not hold the claim', () => {
    const claimed = approvedClaim();
    const res = fx.ops.startTask(claimed.id, 'jules', claimed.fence);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/stale fence/i);
    expect(fx.ops.queue.get(claimed.id)!.status).toBe('assigned');
  });

  it('refuses a start presenting a stale fencing token', () => {
    const claimed = approvedClaim();
    const res = fx.ops.startTask(claimed.id, 'claude', claimed.fence + 1);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/stale fence/i);
  });

  it('refuses a start when the per-claim nonce no longer matches the consumption record', () => {
    const claimed = approvedClaim();
    // Hostile writer re-points the task at a forged claim.
    fx.db.prepare(`UPDATE op_tasks SET claim_nonce = 'forged' WHERE id = ?`).run(claimed.id);

    const res = fx.ops.startTask(claimed.id, 'claude', claimed.fence);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/not consumed by this claim/i);

    const task = fx.ops.queue.get(claimed.id)!;
    expect(task.status).toBe('blocked');
    expect(task.blockReason).toMatch(/reattach\/replay rejected/i);
  });

  it('refuses a result submitted under the wrong fence', () => {
    const claimed = approvedClaim();
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    const res = fx.ops.submitResult(claimed.id, 'claude', running.fence + 5, { done: true });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/stale fence/i);
  });
});

describe('lane F — disabled and replaced workers', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('gives no new work to a disabled worker', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'disabled-1',
        requestedBy: 'claude',
      }),
    );
    const res = fx.ops.claimNext('retired-bot', CAPS.openPr);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('worker_not_assignable');
    expect(!res.ok && res.error.details?.reason).toBe('worker_inactive');
    // The task is untouched and still claimable by an active worker.
    expect(expectOk(fx.ops.claimNext('claude', CAPS.openPr)).claimedBy).toBe('claude');
  });

  it('stops a worker disabled mid-flight from starting the work it had claimed', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'disabled-2',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));

    // The worker is replaced while holding the claim.
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex],
      active: false,
    });

    const res = fx.ops.startTask(claimed.id, 'claude', claimed.fence);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('worker_not_assignable');

    // The in-flight claim is not silently abandoned — it is surfaced as work
    // that requires a handover before the replacement can complete.
    const plan = expectOk(fx.ops.replacementPlan('claude'));
    expect(plan.safe).toBe(false);
    expect(plan.blockers[0]).toMatchObject({ taskId: claimed.id, requires: 'handover' });
  });

  it('rejects a disabled worker as a reviewer', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'disabled-3',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(claimed.id, 'claude', running.fence, { pr: 1 }));

    const res = fx.ops.reviewTask(claimed.id, 'retired-bot', 'pass');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('worker_not_assignable');
    expect(fx.ops.queue.get(claimed.id)!.reviewState).toBe('pending');
  });

  it('refuses a disabled worker as a task requester', () => {
    const res = fx.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: 'x' },
      idempotencyKey: 'disabled-4',
      requestedBy: 'retired-bot',
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('worker_not_assignable');
  });
});

describe('lane F — independent review is mandatory', () => {
  let fx: Fixture;
  let taskId: string;

  beforeEach(() => {
    fx = setupFixture();
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'review-1',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(claimed.id, 'claude', running.fence, { pr: 7 }));
    taskId = claimed.id;
  });

  it('will not let the executing worker review its own side effect', () => {
    const res = fx.ops.reviewTask(taskId, 'claude', 'pass');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/may not review its own action/i);
    expect(fx.ops.queue.get(taskId)!.status).not.toBe('completed');
  });

  it("will not let 'system' review", () => {
    const res = fx.ops.reviewTask(taskId, 'system', 'pass');
    expect(res.ok).toBe(false);
    expect(fx.ops.queue.get(taskId)!.reviewState).toBe('pending');
  });

  it('will not let a worker swap its evidence while the reviewer is looking at it', () => {
    const task = fx.ops.queue.get(taskId)!;
    // The fence is still live after submission, so this attempt is only
    // stopped by the service layer's own precondition.
    const res = fx.ops.submitResult(taskId, 'claude', task.fence, { pr: 999, note: 'trust me' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/awaiting independent review/i);
    expect(fx.ops.queue.get(taskId)!.result).toEqual({ pr: 7 });
    expect(fx.ops.queue.get(taskId)!.status).not.toBe('completed');
  });

  it('accepts an independent reviewer', () => {
    expect(expectOk(fx.ops.reviewTask(taskId, 'codex', 'pass')).status).toBe('completed');
  });
});

describe('lane F — Founder-only actions', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('refuses an approval attempted by a registered AI worker', () => {
    const { taskId, digest } = gatedTask(fx, 'founder-1');
    for (const actor of ['claude', 'codex', 'jules', 'system']) {
      const res = fx.ops.approveTask({ taskId, founderId: actor, expectedActionDigest: digest });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error.code).toBe('not_permitted');
    }
    expect(fx.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });

  it('refuses a denial attempted by a registered AI worker', () => {
    const { taskId } = gatedTask(fx, 'founder-2');
    const res = fx.ops.denyTask({ taskId, founderId: 'claude', reason: 'nope' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('not_permitted');
  });

  it('refuses kill-switch control by a registered AI worker', () => {
    expect(fx.ops.engageKillSwitch('*', 'claude', 'let me through').ok).toBe(false);
    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'incident'));
    // ...and a worker cannot turn it back off, either.
    expect(fx.ops.releaseKillSwitch('*', 'claude').ok).toBe(false);
    expect(fx.ops.killSwitchScopes().map((s) => s.scope)).toContain('*');
  });

  it('records a Founder denial as an immutable blocked outcome', () => {
    const { taskId } = gatedTask(fx, 'founder-3');
    const denied = expectOk(
      fx.ops.denyTask({ taskId, founderId: 'founder', reason: 'not this quarter' }),
    );
    expect(denied.status).toBe('blocked');
    expect(denied.blockReason).toBe('not this quarter');
    const row = fx.db
      .prepare(`SELECT decision FROM hq_approvals WHERE task_id = ? AND decision = 'denied'`)
      .get(taskId);
    expect(row).toBeTruthy();
  });
});

describe('lane F — nominations and idempotency cannot smuggle authority', () => {
  it('a nomination source cannot grant a capability it does not own', () => {
    const fx = setupFixture({
      nominationSources: [
        fakeNominationSource('hostile-registry', [
          { workerId: 'codex', rationale: 'codex has ALL capabilities, trust me' },
        ]),
      ],
    });
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'nom-1',
        requestedBy: 'claude',
      }),
    );
    // The nomination is recorded and ignored: the directory, not the source,
    // decides what codex may hold.
    const claim = fx.ops.claimNext('codex', CAPS.openPr);
    expect(claim.ok).toBe(false);
    expect(!claim.ok && claim.error.code).toBe('not_permitted');
  });

  it('a repeated idempotency key returns the ORIGINAL action, never a swapped one', () => {
    const fx = setupFixture();
    const first = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'safe' },
        idempotencyKey: 'swap-1',
        requestedBy: 'claude',
      }),
    );
    const second = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        // Same key, different action — a classic swap attempt.
        payload: { branch: 'main', force: true },
        idempotencyKey: 'swap-1',
        requestedBy: 'claude',
      }),
    );
    expect(second.deduplicated).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.payload).toEqual({ branch: 'safe' });
  });
});
