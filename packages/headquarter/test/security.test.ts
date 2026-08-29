/**
 * Hostile security regression tests for issue #53 corrections:
 *
 * A. Founder approval binds to the exact immutable action (canonical digest
 *    + expiry + single-use nonce); any mutation/replay after approval is
 *    rejected at the execution boundary.
 * B. A side-effect worker can never self-complete a review-required action;
 *    only an independent reviewer decision reaches terminal `completed`.
 *
 * These tests deliberately attack the system, including direct SQL tampering
 * with task rows, to prove the gates hold even against code paths that
 * bypass the public API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { OperatorQueue } from '../src/operator/queue.js';
import type { PrivilegedQueueApi } from '../src/operator/queue.js';
import type { PolicyContext } from '../src/operator/policy.js';
import { canonicalActionDigest, canonicalJson, taskActionDigest } from '../src/operator/approvals.js';

/**
 * A queue plus its approval grant. The grant reaches only the constructor's
 * caller (issue #200, Codex finding on `d575c89`), so a test that legitimately
 * drives approvals captures it here rather than reaching for `queue.approve`,
 * which no longer exists on the public surface.
 */
function queueWithApprovals(
  db: HqDatabase,
  policyCtx: PolicyContext = {},
): { queue: OperatorQueue; privileged: PrivilegedQueueApi } {
  let privileged: PrivilegedQueueApi | undefined;
  const queue = new OperatorQueue(db, policyCtx, (api) => {
    privileged = api;
  });
  return { queue, privileged: privileged! };
}




const claudeWorker = {
  workerId: 'claude',
  allowedCapabilities: ['repo.read_status', 'ops.risky', 'archive.index_document'],
};

function makeQueue(db: HqDatabase): { queue: OperatorQueue; approvals: PrivilegedQueueApi } {
  const { queue: q, privileged: qApprovals } = queueWithApprovals(db);
  new CapabilityRegistry(db).register({
    id: 'repo.read_status',
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  new CapabilityRegistry(db).register({
    id: 'ops.risky',
    description: 'Founder-gated side-effect action',
    riskClass: 'founder_gate',
    sideEffect: true,
    idempotent: true,
  });
  new CapabilityRegistry(db).register({
    id: 'archive.index_document',
    description: 'External side effect without standing pre-approval',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: true,
  });
  return { queue: q, approvals: qApprovals };
}

/** Enqueue a founder-gated task; returns its id (status: needs_approval). */
function enqueueGated(queue: OperatorQueue, key = 'risky-1', payload: Record<string, unknown> = { target: 'x' }): string {
  const res = queue.enqueue({
    capabilityId: 'ops.risky',
    payload,
    idempotencyKey: key,
    requestedBy: claudeWorker,
  });
  if (!res.accepted) throw new Error(res.reason);
  return res.task.id;
}

describe('canonical serialization', () => {
  it('is independent of object key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }),
    );
  });

  it('digest changes when payload or capability changes', () => {
    const base = { taskId: 't1', capabilityId: 'ops.risky', payload: { n: 1 }, idempotencyKey: 'k' };
    const d = canonicalActionDigest(base);
    expect(canonicalActionDigest({ ...base, payload: { n: 2 } })).not.toBe(d);
    expect(canonicalActionDigest({ ...base, capabilityId: 'other' })).not.toBe(d);
    expect(canonicalActionDigest({ ...base, taskId: 't2' })).not.toBe(d);
  });
});

describe('correction A: approval binds to the exact immutable action', () => {
  let db: HqDatabase;
  let queue: OperatorQueue;
  let queueApprovals: PrivilegedQueueApi;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    ({ queue, approvals: queueApprovals } = makeQueue(db));
  });

  it('approve() stores a digest-bound, time-boxed, single-use approval and admits the unmodified task', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const approved = queue.get(id)!;
    expect(approved.status).toBe('queued');
    expect(approved.approvalId).not.toBeNull();
    const row = db
      .prepare(`SELECT action_digest, expires_at, consumed_at, decided_by FROM hq_approvals WHERE id = ?`)
      .get(approved.approvalId) as Record<string, unknown>;
    expect(row.action_digest).toBe(taskActionDigest(approved));
    expect(row.expires_at).toBeTruthy();
    expect(row.consumed_at).toBeNull();
    expect(row.decided_by).toBe('founder');
    const claimed = queue.claim('claude', 'ops.risky');
    expect(claimed?.id).toBe(id);
    // Nonce consumed exactly at claim time.
    const after = db
      .prepare(`SELECT consumed_at FROM hq_approvals WHERE id = ?`)
      .get(approved.approvalId) as Record<string, unknown>;
    expect(after.consumed_at).not.toBeNull();
  });

  it('HOSTILE: payload mutated after approval is rejected and the task is blocked', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    // Attacker rewrites the payload after the Founder approved it.
    db.prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`).run(
      JSON.stringify({ target: 'PRODUCTION-DELETE-EVERYTHING' }),
      id,
    );
    expect(queue.claim('claude', 'ops.risky')).toBeNull();
    const task = queue.get(id)!;
    expect(task.status).toBe('blocked');
    expect(task.approvalId).toBeNull();
    const kinds = queue.evidence.list(id).map((e) => e.kind);
    expect(kinds).toContain('approval_rejected_at_execution');
  });

  it('HOSTILE: capability swapped after approval is rejected and the task is blocked', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    db.prepare(`UPDATE op_tasks SET capability_id = 'archive.index_document' WHERE id = ?`).run(id);
    expect(queue.claim('claude', 'archive.index_document')).toBeNull();
    expect(queue.get(id)!.status).toBe('blocked');
  });

  it('HOSTILE: payload mutated between claim and start invalidates the approval at start()', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!;
    db.prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`).run(JSON.stringify({ target: 'evil' }), id);
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/approval invalidated/i);
    expect(queue.get(id)!.status).toBe('blocked');
  });

  it('an expired approval never admits execution; the task returns to needs_approval', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id, 'founder', { ttlMs: -1000 });
    expect(queue.claim('claude', 'ops.risky')).toBeNull();
    expect(queue.get(id)!.status).toBe('needs_approval');
  });

  it('HOSTILE: replaying a consumed approval is rejected; a fresh Founder approval is required', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!;
    const approvalId = db.prepare(`SELECT approval_id FROM op_tasks WHERE id = ?`).get(id) as {
      approval_id: string;
    };
    // Attacker forces the claimed task back into the queue, keeping the old
    // (already consumed) approval attached, and tries to execute again.
    db.prepare(`UPDATE op_tasks SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL WHERE id = ?`).run(id);
    expect(queue.claim('claude', 'ops.risky')).toBeNull();
    expect(queue.get(id)!.status).toBe('needs_approval');
    expect(t.approvalId).toBe(approvalId.approval_id);
  });

  it('HOSTILE: forcing a gated task to queued without any approval record is rejected', () => {
    const id = enqueueGated(queue);
    db.prepare(`UPDATE op_tasks SET status = 'queued' WHERE id = ?`).run(id);
    expect(queue.claim('claude', 'ops.risky')).toBeNull();
    expect(queue.get(id)!.status).toBe('needs_approval');
  });

  it("HOSTILE: task B cannot ride on task A's approval (digest binds the task id)", () => {
    const a = enqueueGated(queue, 'risky-a', { same: 'payload' });
    const b = enqueueGated(queue, 'risky-b', { same: 'payload' });
    queueApprovals.approve(a);
    const approvalOfA = queue.get(a)!.approvalId!;
    db.prepare(`UPDATE op_tasks SET status = 'queued', approval_id = ? WHERE id = ?`).run(approvalOfA, b);
    // Task A is claimable; hostile task B must be rejected even though its
    // capability + payload are identical to what the Founder approved.
    const claimed = queue.claim('claude', 'ops.risky');
    expect(claimed?.id).toBe(a);
    expect(queue.claim('claude', 'ops.risky')).toBeNull();
    expect(queue.get(b)!.status).toBe('blocked');
  });

  it('the requesting worker cannot approve its own action', () => {
    const id = enqueueGated(queue);
    expect(() => queueApprovals.approve(id, 'claude')).toThrow(/may not approve its own/);
    expect(() => queueApprovals.approve(id, 'system')).toThrow(/may not approve/);
    expect(queue.get(id)!.status).toBe('needs_approval');
  });

  it('approve() refuses a task that is not awaiting approval', () => {
    const res = queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    if (!res.accepted) throw new Error('enqueue failed');
    expect(() => queueApprovals.approve(res.task.id)).toThrow(/not awaiting approval/);
  });

  it('denials are recorded immutably with the decider', () => {
    const id = enqueueGated(queue);
    queueApprovals.deny(id, 'not this wave');
    const row = db
      .prepare(`SELECT decision, decided_by, decision_note FROM hq_approvals WHERE task_id = ?`)
      .get(id) as Record<string, unknown>;
    expect(row.decision).toBe('denied');
    expect(row.decided_by).toBe('founder');
    expect(row.decision_note).toBe('not this wave');
  });
});

describe('issue #71: approval expiry is revalidated at actual execution start', () => {
  let db: HqDatabase;
  let queue: OperatorQueue;
  let queueApprovals: PrivilegedQueueApi;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    ({ queue, approvals: queueApprovals } = makeQueue(db));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('HOSTILE: approval valid at claim but expired before start() never executes; task returns to needs_approval with evidence', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id, 'founder', { ttlMs: 60_000 }); // expires 00:01:00.000Z
    const t = queue.claim('claude', 'ops.risky')!; // valid at claim; nonce consumed here
    expect(t.status).toBe('assigned');
    // Clock advances beyond expires_at between claim and start.
    vi.setSystemTime(new Date('2026-01-01T00:01:00.001Z'));
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/expired before execution start/i);
    const task = queue.get(id)!;
    expect(task.status).toBe('needs_approval'); // safe approval-required path, not running
    expect(task.approvalId).toBeNull(); // stale binding cleared
    expect(task.claimedBy).toBeNull(); // void claim released
    expect(task.leaseExpiresAt).toBeNull();
    const rejection = queue.evidence
      .list(id)
      .find((e) => e.kind === 'approval_rejected_at_execution');
    expect(rejection?.payload.rejection).toBe('approval_expired');
    // The consumed approval stays immutably consumed — single-use is preserved.
    expect(
      (db.prepare(`SELECT consumed_at FROM hq_approvals WHERE id = ?`).get(t.approvalId) as Record<string, unknown>)
        .consumed_at,
    ).not.toBeNull();
    // The old worker's stale fence can no longer act on the task.
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/stale fence/i);
    // Recovery is exactly the existing contract: a FRESH Founder approval.
    queueApprovals.approve(id, 'founder', { ttlMs: 60_000 });
    const t2 = queue.claim('claude', 'ops.risky')!;
    expect(t2.fence).toBeGreaterThan(t.fence);
    expect(t2.approvalId).not.toBe(t.approvalId);
    expect(queue.start(id, 'claude', t2.fence).status).toBe('running');
  });

  it('boundary: start() exactly AT expires_at is rejected (expiry is inclusive: now >= expires_at)', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id, 'founder', { ttlMs: 60_000 }); // expires 00:01:00.000Z
    const t = queue.claim('claude', 'ops.risky')!;
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/expired before execution start/i);
    expect(queue.get(id)!.status).toBe('needs_approval');
  });

  it('boundary: start() strictly before expires_at (expiry minus 1ms) still executes', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id, 'founder', { ttlMs: 60_000 }); // expires 00:01:00.000Z
    const t = queue.claim('claude', 'ops.risky')!;
    vi.setSystemTime(new Date('2026-01-01T00:00:59.999Z'));
    expect(queue.start(id, 'claude', t.fence).status).toBe('running');
  });

  it('HOSTILE: approval expiry wiped via direct SQL between claim and start never admits execution', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id, 'founder', { ttlMs: 60_000 });
    const t = queue.claim('claude', 'ops.risky')!;
    // Attacker strips the time-box entirely; an unbound expiry must never admit.
    db.prepare(`UPDATE hq_approvals SET expires_at = NULL WHERE id = ?`).run(t.approvalId);
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/expired before execution start/i);
    expect(queue.get(id)!.status).toBe('needs_approval');
  });
});

describe('issue #77: approval consumption binds to the legitimate claim', () => {
  let db: HqDatabase;
  let queue: OperatorQueue;
  let queueApprovals: PrivilegedQueueApi;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    ({ queue, approvals: queueApprovals } = makeQueue(db));
  });

  it('a legitimate claim records the full consumption binding and still starts before expiry', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!;
    expect(t.claimNonce).toBeTruthy();
    const row = db
      .prepare(
        `SELECT consumed_at, consumed_by, consumed_fence, consumed_claim_nonce FROM hq_approvals WHERE id = ?`,
      )
      .get(t.approvalId) as Record<string, unknown>;
    expect(row.consumed_at).not.toBeNull();
    expect(row.consumed_by).toBe('claude');
    expect(row.consumed_fence).toBe(t.fence);
    expect(row.consumed_claim_nonce).toBe(t.claimNonce);
    // The binding is on the evidence record too.
    const consumedEv = queue.evidence.list(id).find((e) => e.kind === 'approval_consumed');
    expect(consumedEv?.payload.consumedBy).toBe('claude');
    expect(consumedEv?.payload.consumedFence).toBe(t.fence);
    expect(consumedEv?.payload.claimNonce).toBe(t.claimNonce);
    // The legitimate claim still executes normally.
    expect(queue.start(id, 'claude', t.fence).status).toBe('running');
  });

  it('HOSTILE: an approval consumed by worker A cannot be reattached to a forced assigned state for worker B', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!; // legitimately consumed by claude's claim
    // Attacker hands the assigned task (with its consumed approval still
    // attached) to a different worker via direct SQL.
    db.prepare(`UPDATE op_tasks SET claimed_by = 'intruder' WHERE id = ?`).run(id);
    expect(() => queue.start(id, 'intruder', t.fence)).toThrow(/not consumed by this claim/i);
    const task = queue.get(id)!;
    expect(task.status).toBe('blocked');
    expect(task.approvalId).toBeNull();
    const rejection = queue.evidence.list(id).find((e) => e.kind === 'approval_rejected_at_execution');
    expect(rejection?.payload.rejection).toBe('approval_claim_binding_mismatch');
  });

  it('HOSTILE: a forced assigned state that skipped the claim path (approval never consumed) cannot start', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id); // approved and queued; nonce NOT consumed — no claim happened
    db.prepare(
      `UPDATE op_tasks SET status = 'assigned', claimed_by = 'claude', fence = 1,
         claim_nonce = 'forged', lease_expires_at = ? WHERE id = ?`,
    ).run(new Date(Date.now() + 60_000).toISOString(), id);
    expect(() => queue.start(id, 'claude', 1)).toThrow(/not consumed by this claim/i);
    expect(queue.get(id)!.status).toBe('blocked');
  });

  it('HOSTILE: a stale/forged claim nonce on the task row cannot start execution', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!;
    // Attacker overwrites the task's per-claim nonce (e.g. while restoring a forced state).
    db.prepare(`UPDATE op_tasks SET claim_nonce = 'forged-nonce' WHERE id = ?`).run(id);
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/not consumed by this claim/i);
    expect(queue.get(id)!.status).toBe('blocked');
  });

  it('HOSTILE: a released claim cannot be force-restored onto its old consumed approval', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky', -1)!; // lease already expired while assigned
    queue.sweepExpiredLeases(); // safely re-queued; claim released, nonce cleared
    const released = queue.get(id)!;
    expect(released.status).toBe('queued');
    expect(released.claimNonce).toBeNull();
    // Attacker resurrects the old claim by force, pointing at the consumed approval.
    db.prepare(
      `UPDATE op_tasks SET status = 'assigned', claimed_by = 'claude', fence = ?,
         approval_id = ?, lease_expires_at = ? WHERE id = ?`,
    ).run(t.fence, t.approvalId, new Date(Date.now() + 60_000).toISOString(), id);
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/not consumed by this claim/i);
    expect(queue.get(id)!.status).toBe('blocked');
  });

  it('valid-at-claim but expired-at-start is still the safe needs_approval path, not a hostile block', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const id = enqueueGated(queue);
      queueApprovals.approve(id, 'founder', { ttlMs: 60_000 });
      const t = queue.claim('claude', 'ops.risky')!; // binding intact, legitimately consumed
      vi.setSystemTime(new Date('2026-01-01T00:01:00.001Z'));
      // The legitimate claim's binding passes; only the time-box rejects — so
      // the recovery path stays needs_approval (issue #71), never blocked.
      expect(() => queue.start(id, 'claude', t.fence)).toThrow(/expired before execution start/i);
      expect(queue.get(id)!.status).toBe('needs_approval');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('issue #79: consumption also pins the exact task (cross-task riding fails even behind a forged digest)', () => {
  let db: HqDatabase;
  let queue: OperatorQueue;
  let queueApprovals: PrivilegedQueueApi;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    ({ queue, approvals: queueApprovals } = makeQueue(db));
  });

  it('a legitimate claim records the exact task id in the consumption record', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!;
    const row = db
      .prepare(`SELECT consumed_task_id FROM hq_approvals WHERE id = ?`)
      .get(t.approvalId) as Record<string, unknown>;
    expect(row.consumed_task_id).toBe(id);
    const consumedEv = queue.evidence.list(id).find((e) => e.kind === 'approval_consumed');
    expect(consumedEv?.payload.consumedTaskId).toBe(id);
    expect(queue.start(id, 'claude', t.fence).status).toBe('running');
  });

  it("HOSTILE: task B forged into assigned state cannot ride task A's consumed approval even with a forged digest and a copied claim nonce", () => {
    const a = enqueueGated(queue, 'risky-a', { same: 'payload' });
    const b = enqueueGated(queue, 'risky-b', { same: 'payload' });
    queueApprovals.approve(a);
    const claimedA = queue.claim('claude', 'ops.risky')!; // consumes A's approval legitimately
    // Attacker copies EVERYTHING observable from A's legitimate claim onto B
    // (worker, fence, claim nonce, consumed approval) and even rewrites the
    // approval's action digest to match B — defeating every check except the
    // consumed task id, which pins the consumption to A alone.
    db.prepare(`UPDATE hq_approvals SET action_digest = ? WHERE id = ?`).run(
      taskActionDigest(queue.get(b)!),
      claimedA.approvalId,
    );
    db.prepare(
      `UPDATE op_tasks SET status = 'assigned', claimed_by = 'claude', fence = ?,
         claim_nonce = ?, approval_id = ?, lease_expires_at = ? WHERE id = ?`,
    ).run(
      claimedA.fence,
      claimedA.claimNonce,
      claimedA.approvalId,
      new Date(Date.now() + 60_000).toISOString(),
      b,
    );
    expect(() => queue.start(b, 'claude', claimedA.fence)).toThrow(/not consumed by this claim/i);
    const taskB = queue.get(b)!;
    expect(taskB.status).toBe('blocked');
    expect(taskB.approvalId).toBeNull();
    const rejection = queue.evidence.list(b).find((e) => e.kind === 'approval_rejected_at_execution');
    expect(rejection?.payload.rejection).toBe('approval_claim_binding_mismatch');
  });

  it('HOSTILE: wiping the consumed task id via direct SQL fails closed at start()', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!;
    db.prepare(`UPDATE hq_approvals SET consumed_task_id = NULL WHERE id = ?`).run(t.approvalId);
    expect(() => queue.start(id, 'claude', t.fence)).toThrow(/not consumed by this claim/i);
    expect(queue.get(id)!.status).toBe('blocked');
  });
});

describe('correction B: executor can never self-complete a review-required action', () => {
  let db: HqDatabase;
  let queue: OperatorQueue;
  let queueApprovals: PrivilegedQueueApi;

  /** Approved + claimed + running side-effect task, executed by claude. */
  function runningGatedTask(): { id: string; fence: number } {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky')!;
    queue.start(id, 'claude', t.fence);
    return { id, fence: t.fence };
  }

  beforeEach(() => {
    db = openMemoryHqDatabase();
    ({ queue, approvals: queueApprovals } = makeQueue(db));
  });

  it('side-effect complete() lands in the review-gated path, not in completed', () => {
    const { id, fence } = runningGatedTask();
    const after = queue.complete(id, 'claude', fence, { done: true });
    expect(after.status).toBe('running');
    expect(after.reviewState).toBe('pending');
    expect(after.submittedBy).toBe('claude');
    const kinds = queue.evidence.list(id).map((e) => e.kind);
    expect(kinds).toContain('execution_result_submitted_for_review');
    expect(kinds).not.toContain('execution_result');
  });

  it('HOSTILE: the executing worker cannot pass review on its own execution', () => {
    const { id, fence } = runningGatedTask();
    queue.complete(id, 'claude', fence, { done: true });
    expect(() => queue.reviewPass(id, 'claude')).toThrow(/builder != final reviewer/);
    expect(() => queue.reviewFail(id, 'claude', 'x')).toThrow(/builder != final reviewer/);
    expect(() => queue.reviewPass(id, 'system')).toThrow(/builder != final reviewer/);
    expect(queue.get(id)!.status).toBe('running');
  });

  it('only an independent reviewer decision reaches terminal completed', () => {
    const { id, fence } = runningGatedTask();
    queue.complete(id, 'claude', fence, { done: true });
    const done = queue.reviewPass(id, 'codex', 'verified against the real side effect');
    expect(done.status).toBe('completed');
    expect(done.reviewState).toBe('passed');
    // The full audited path is on record: review_passed then completed.
    const statuses = db
      .prepare(`SELECT status FROM hq_events WHERE subject_id = ? ORDER BY seq`)
      .all(id)
      .map((r) => (r as { status: string }).status);
    expect(statuses).toContain('review_passed');
    expect(statuses[statuses.length - 1]).toBe('completed');
  });

  it('an independent reviewer can fail the result; the task goes to review_failed for rework', () => {
    const { id, fence } = runningGatedTask();
    queue.complete(id, 'claude', fence, { done: true });
    const failed = queue.reviewFail(id, 'codex', 'side effect not observed');
    expect(failed.status).toBe('review_failed');
    expect(failed.reviewState).toBe('failed');
  });

  it('review decisions require a result actually awaiting review', () => {
    const { id } = runningGatedTask();
    expect(() => queue.reviewPass(id, 'codex')).toThrow(/no result awaiting review/);
  });

  it('a review-pending task is never swept into outcome_unknown', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky', -1)!; // lease already expired
    queue.start(id, 'claude', t.fence);
    queue.complete(id, 'claude', t.fence, { done: true });
    const swept = queue.sweepExpiredLeases();
    expect(swept.outcomeUnknown).not.toContain(id);
    expect(queue.get(id)!.reviewState).toBe('pending');
  });

  it('HOSTILE: the executing worker cannot reconcile its own outcome_unknown task', () => {
    const id = enqueueGated(queue);
    queueApprovals.approve(id);
    const t = queue.claim('claude', 'ops.risky', -1)!;
    queue.start(id, 'claude', t.fence);
    queue.sweepExpiredLeases();
    expect(queue.get(id)!.status).toBe('outcome_unknown');
    expect(() => queue.reconcile(id, 'confirmed_done', 'claude', 'trust me')).toThrow(
      /independent reviewer/,
    );
    const done = queue.reconcile(id, 'confirmed_done', 'codex', 'verified externally');
    expect(done.status).toBe('completed');
  });

  it('read-only capabilities still complete directly (no review theater for safe reads)', () => {
    const res = queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    if (!res.accepted) throw new Error('enqueue failed');
    const t = queue.claim('claude', 'repo.read_status')!;
    queue.start(t.id, 'claude', t.fence);
    expect(queue.complete(t.id, 'claude', t.fence, { ok: true }).status).toBe('completed');
  });
});
