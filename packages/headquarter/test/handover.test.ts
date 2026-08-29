import { beforeEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { OperatorQueue } from '../src/operator/queue.js';
import type { PrivilegedQueueApi } from '../src/operator/queue.js';
import type { PolicyContext } from '../src/operator/policy.js';
import { MemoryStore } from '../src/memory/index.js';
import {


  assertAssignable,
  assertHandoverTransition,
  generateHandoverPackage,
  HandoverStore,
  type HandoverState,
} from '../src/handover/index.js';

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


const claude = { workerId: 'claude', allowedCapabilities: ['repo.read_status', 'github.open_pr'] };

function setup(): { db: HqDatabase; hq: HeadquarterStore; queue: OperatorQueue; queueApprovals: PrivilegedQueueApi; memory: MemoryStore; handovers: HandoverStore } {
  const db = openMemoryHqDatabase();
  const hq = new HeadquarterStore(db);
  const { queue: queue, privileged: queueApprovals } = queueWithApprovals(db, { preApprovedCapabilities: new Set(['github.open_pr']) });
  new CapabilityRegistry(db).register({
    id: 'repo.read_status',
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  new CapabilityRegistry(db).register({
    id: 'github.open_pr',
    description: 'Open a branch-isolated PR',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: true,
  });
  hq.upsertSpecialist({ id: 'claude', displayName: 'Claude', vendor: 'anthropic', role: 'parallel_implementer', allowedCapabilities: ['repo.read_status', 'github.open_pr'], active: true });
  hq.upsertSpecialist({ id: 'jules', displayName: 'Jules', vendor: 'google', role: 'parallel_implementer', allowedCapabilities: ['repo.read_status'], active: true });
  const memory = new MemoryStore(db, (e) => hq.appendEvent(e));
  const handovers = new HandoverStore(db);
  return { db, hq, queue, queueApprovals, memory, handovers };
}

describe('handover / replacement lifecycle', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  // Spec C item 1
  it('worker replacement with active tasks: inventory captures them, verify fails while still claimed, passes after completion', () => {
    const { queue, memory, handovers } = ctx;
    const enq = queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claude });
    if (!enq.accepted) throw new Error('enqueue failed');
    const claimed = queue.claim('claude', 'repo.read_status')!;
    expect(claimed.status).toBe('assigned');

    const h = handovers.initiate('claude', 'founder');
    expect(h.state).toBe('frozen');

    const afterInventory = handovers.inventory(h.id);
    expect(afterInventory.state).toBe('inventoried');

    const afterPackage = handovers.generatePackage(h.id, memory);
    expect(afterPackage.state).toBe('package_ready');
    expect(afterPackage.package?.activeAssignments.map((t) => t.id)).toEqual([claimed.id]);

    const acked = handovers.acknowledge(h.id, 'jules');
    expect(acked.state).toBe('acknowledged');
    expect(acked.successorId).toBe('jules');

    expect(() => handovers.verify(h.id, 'founder')).toThrow(/reconciliation required/);
    expect(() => handovers.verify(h.id, 'founder')).toThrow(new RegExp(claimed.id));

    // Reassign/complete the task — it is no longer "still claimed ... active".
    queue.start(claimed.id, 'claude', claimed.fence);
    queue.complete(claimed.id, 'claude', claimed.fence, { ok: true });

    const verified = handovers.verify(h.id, 'founder');
    expect(verified.state).toBe('verified');

    const completed = handovers.complete(h.id);
    expect(completed.state).toBe('completed');
    expect(ctx.hq.getSpecialist('claude')?.active).toBe(false);
  });

  // Spec C item 2
  it('an unfinished PR is represented in the generated handover package', () => {
    const { memory } = ctx;
    memory.record({
      kind: 'task_state',
      title: 'PR #77 open, awaiting CI',
      body: 'Branch ai/77-something has an open PR pending review.',
      status: 'CURRENT',
      recorded: { date: '2026-08-26', confidence: 'exact' },
      recordedBy: 'claude',
      project: 'JENIFY-OS',
      related: { pullRequests: [77], commits: ['abc1234'] },
    });

    const pkg = generateHandoverPackage(ctx.db, memory, 'claude');
    expect(pkg.branchesAndPrs).toEqual(expect.arrayContaining(['pr:77', 'commit:abc1234']));
  });

  // Spec C item 3
  it('an outcome_unknown task blocks verify with a reconciliation-required error and is never flipped by the handover flow', () => {
    const { queue, memory, handovers } = ctx;
    const enq = queue.enqueue({ capabilityId: 'github.open_pr', payload: { pr: 1 }, idempotencyKey: 'pr-1', requestedBy: claude });
    if (!enq.accepted) throw new Error('enqueue failed');
    // Already-expired lease so the very next sweep marks it outcome_unknown.
    const claimed = queue.claim('claude', 'github.open_pr', -1000)!;
    queue.start(claimed.id, 'claude', claimed.fence);
    const swept = queue.sweepExpiredLeases();
    expect(swept.outcomeUnknown).toEqual([claimed.id]);
    expect(queue.get(claimed.id)!.status).toBe('outcome_unknown');

    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    const withPkg = handovers.generatePackage(h.id, memory);
    expect(withPkg.package?.outcomeUnknownTaskIds).toEqual([claimed.id]);
    expect(withPkg.package?.unresolvedSideEffects.map((t) => t.id)).toEqual([claimed.id]);
    handovers.acknowledge(h.id, 'jules');

    expect(() => handovers.verify(h.id, 'founder')).toThrow(/reconciliation required/);

    // The handover flow itself never mutates op_tasks — status is untouched.
    expect(queue.get(claimed.id)!.status).toBe('outcome_unknown');

    // Once genuinely reconciled through the operator queue, verify succeeds.
    ctx.queueApprovals.reconcile(claimed.id, 'confirmed_done', 'reviewer', 'checked GitHub, PR exists');
    expect(handovers.verify(h.id, 'founder').state).toBe('verified');
  });

  // Spec C item 4
  it('rejects verify/complete before acknowledgement', () => {
    const { memory, handovers } = ctx;
    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    expect(() => handovers.verify(h.id, 'founder')).toThrow(/is package_ready, expected acknowledged/);
    expect(() => handovers.complete(h.id)).toThrow(/expected verified/);
  });

  // Spec C item 5
  it('a revoked (completed-handover) worker, and a frozen worker, cannot be assigned new work', () => {
    const { memory, handovers, db } = ctx;
    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    handovers.acknowledge(h.id, 'jules');
    handovers.verify(h.id, 'founder');
    handovers.complete(h.id);

    expect(() => assertAssignable(db, 'claude')).toThrow(/deactivated/);

    // A different worker with an in-flight (merely frozen) handover is also unassignable.
    ctx.hq.upsertSpecialist({ id: 'codex', displayName: 'Codex', vendor: 'openai', role: 'parallel_implementer', allowedCapabilities: [], active: true });
    handovers.initiate('codex', 'founder');
    expect(() => assertAssignable(db, 'codex')).toThrow(/active handover/);

    // An untouched, active specialist remains assignable.
    expect(() => assertAssignable(db, 'jules')).not.toThrow();
  });

  // Spec C item 8
  it('preserves history: completed handover row, worker hq_events timeline, and deactivated specialist all remain readable', () => {
    const { memory, handovers, hq, db } = ctx;
    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    handovers.acknowledge(h.id, 'jules');
    handovers.verify(h.id, 'founder');
    handovers.complete(h.id);

    const stored = handovers.get(h.id)!;
    expect(stored.state).toBe('completed');
    expect(stored.successorId).toBe('jules');
    expect(handovers.listByPredecessor('claude').map((r) => r.id)).toEqual([h.id]);

    const timeline = hq.eventsFor('worker', 'claude');
    expect(timeline.length).toBeGreaterThanOrEqual(6); // frozen, inventoried, package_ready, acknowledged, verified, completed, deactivated
    expect(timeline.map((e) => e.summary).some((s) => s.includes('frozen'))).toBe(true);
    expect(timeline.map((e) => e.summary).some((s) => s.includes('deactivated'))).toBe(true);

    const specialist = hq.getSpecialist('claude');
    expect(specialist).not.toBeNull();
    expect(specialist!.active).toBe(false);
    expect(specialist!.displayName).toBe('Claude'); // row content preserved, not deleted

    // Sanity: nothing in hq_handovers was ever deleted.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM hq_handovers').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('rejects illegal handover transitions', () => {
    const from: HandoverState = 'frozen';
    expect(() => assertHandoverTransition(from, 'verified')).toThrow(/Illegal handover transition/);
    expect(() => assertHandoverTransition('completed', 'frozen')).toThrow(/Illegal handover transition/);

    const { memory, handovers } = ctx;
    const h = handovers.initiate('claude', 'founder');
    // Skipping straight to generatePackage from 'frozen' (needs 'inventoried') must fail.
    expect(() => handovers.generatePackage(h.id, memory)).toThrow(/is frozen, expected inventoried/);
  });

  it('abort path: unfreezes from any pre-completed state and is itself terminal', () => {
    const { handovers, db } = ctx;
    const h = handovers.initiate('claude', 'founder');
    const aborted = handovers.abort(h.id, 'Founder cancelled the replacement', 'founder');
    expect(aborted.state).toBe('aborted');
    expect(aborted.revokedBy).toBe('founder');
    expect(aborted.revokedReason).toBe('Founder cancelled the replacement');

    // An aborted handover no longer blocks new assignment (only the specialist's own active flag matters).
    expect(() => assertAssignable(db, 'claude')).not.toThrow();

    // Aborting an already-terminal handover is rejected, not silently accepted.
    expect(() => handovers.abort(h.id, 'again', 'founder')).toThrow(/already terminal/);

    // A fresh handover can now be initiated for the same worker.
    const h2 = handovers.initiate('claude', 'founder');
    expect(h2.id).not.toBe(h.id);
  });

  // Secret-like content rejected from the handover package itself, exercised
  // as the defense-in-depth backstop it is documented to be: every normal
  // entry point (memory.record(), queue.complete()) already screens its own
  // input, so this simulates a secret reaching op_tasks.result some other
  // way (a raw write, bypassing the queue) to prove the package-level guard
  // still catches it rather than trusting upstream filtering alone.
  it('rejects secret-like content surfacing in a handover package as a defense-in-depth backstop', () => {
    const { db, queue, memory } = ctx;
    const enq = queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claude });
    if (!enq.accepted) throw new Error('enqueue failed');
    const claimed = queue.claim('claude', 'repo.read_status')!;
    db.prepare('UPDATE op_tasks SET result = ? WHERE id = ?').run(
      JSON.stringify({ refs: ['token: sk-liveSecretValueThatShouldNeverAppearHere']}),
      claimed.id,
    );
    expect(() => generateHandoverPackage(db, memory, 'claude')).toThrow(/secret-like content/);
  });
});
