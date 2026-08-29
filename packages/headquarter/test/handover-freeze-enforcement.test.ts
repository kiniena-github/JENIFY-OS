/**
 * Canonical freeze-enforcement regression suite (PR #127 independent-review
 * correction).
 *
 * REPORTED DEFECT: a worker could be marked FROZEN by the handover /
 * replacement lifecycle, but that freeze was NOT enforced through the
 * canonical task-assignment path. `assertAssignable()` existed and was
 * correct, but had ZERO production call sites — it was only ever exercised
 * directly by tests. `OperatorQueue.claim()` — the single code path in the
 * repository that writes a worker id into `op_tasks.claimed_by` — never
 * consulted it. Headquarter could therefore say "Claude is frozen; stop
 * giving Claude new work" while `claim()` happily handed Claude more work.
 *
 * CANONICAL SAFETY INVARIANT (enforced at the control boundary, not in a
 * caller/UI/helper):
 *
 *   While a worker is frozen (an active, non-terminal handover) or
 *   deactivated, NO new work may be assigned to that worker through ANY
 *   supported assignment path.
 *
 * Deliberate scope of the invariant: freeze blocks the ACQUISITION of new
 * work (`claim()`). It does NOT block draining work the worker already
 * holds (`start()`/`complete()`/`fail()`/`reconcile()`) — the handover
 * lifecycle *requires* in-flight work to be resolved or reassigned before
 * `verify()` will pass, so blocking the drain path would strand the very
 * work the lifecycle exists to hand over. That boundary is asserted below.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHqDatabase, openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { OperatorQueue } from '../src/operator/queue.js';
import type { PrivilegedQueueApi } from '../src/operator/queue.js';
import type { PolicyContext } from '../src/operator/policy.js';
import { MemoryStore } from '../src/memory/index.js';
import { assertAssignable, HandoverStore } from '../src/handover/index.js';

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
const jules = { workerId: 'jules', allowedCapabilities: ['repo.read_status'] };

interface Ctx {
  db: HqDatabase;
  queueApprovals: PrivilegedQueueApi;
  hq: HeadquarterStore;
  queue: OperatorQueue;
  memory: MemoryStore;
  handovers: HandoverStore;
}

function wire(db: HqDatabase): Ctx {
  const hq = new HeadquarterStore(db);
  const { queue, privileged: queueApprovals } = queueWithApprovals(db, { preApprovedCapabilities: new Set(['github.open_pr']) });
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
  hq.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'parallel_implementer',
    allowedCapabilities: ['repo.read_status', 'github.open_pr'],
    active: true,
  });
  hq.upsertSpecialist({
    id: 'jules',
    displayName: 'Jules',
    vendor: 'google',
    role: 'parallel_implementer',
    allowedCapabilities: ['repo.read_status'],
    active: true,
  });
  const memory = new MemoryStore(db, (e) => hq.appendEvent(e));
  const handovers = new HandoverStore(db);
  return { db, hq, queue, queueApprovals, memory, handovers };
}

function setup(): Ctx {
  return wire(openMemoryHqDatabase());
}

function enqueueRead(ctx: Ctx, by = claude): string {
  const enq = ctx.queueApprovals.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: by });
  if (!enq.accepted) throw new Error(`enqueue failed: ${enq.reason}`);
  return enq.task.id;
}

describe('canonical freeze enforcement at the assignment boundary', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  // ---- Case 1: the reported defect ----

  it('case 1: a frozen worker cannot receive a new task through canonical assignment', () => {
    const { queue, queueApprovals, handovers } = ctx;
    const taskId = enqueueRead(ctx);

    handovers.initiate('claude', 'founder');

    // THE DEFECT: before the correction this returned the task, handing a
    // frozen worker new work.
    expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);

    // Fail-closed: the task is untouched and still claimable by someone else.
    const task = queue.get(taskId)!;
    expect(task.status).toBe('queued');
    expect(task.claimedBy).toBeNull();
  });

  // ---- Case 2 + 3: alternate / direct / manual assignment paths ----

  it('case 2: an independently constructed queue on the same database cannot bypass the freeze', () => {
    const { db, handovers } = ctx;
    const taskId = enqueueRead(ctx);
    handovers.initiate('claude', 'founder');

    // A different caller building its own OperatorQueue over the same DB —
    // the "alternate assignment path". The guard lives at the boundary, so
    // this instance is bound by it too.
    const { queue: alternate, privileged: alternateApprovals } = queueWithApprovals(db, { preApprovedCapabilities: new Set(['github.open_pr']) });
    expect(() => alternate.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
    expect(alternate.get(taskId)!.status).toBe('queued');
  });

  it('case 3: a manual claim on a freshly opened queue that never constructed a HandoverStore is still blocked', () => {
    const { db, handovers } = ctx;
    enqueueRead(ctx);
    handovers.initiate('claude', 'founder');

    // Simulates a process/module that only ever imports the operator queue
    // and knows nothing about the handover module. It must still be blocked:
    // the freeze is read from the database, not from an in-memory handle.
    const { queue: bare, privileged: bareApprovals } = queueWithApprovals(db, { preApprovedCapabilities: new Set(['github.open_pr']) });
    expect(() => bare.claim('claude', 'repo.read_status')).toThrow(/cannot be assigned new work|active handover/i);
  });

  it('case 3b: a task force-reset to queued by direct SQL still cannot be claimed by a frozen worker', () => {
    const { db, queue, handovers } = ctx;
    const taskId = enqueueRead(ctx);
    const claimed = queue.claim('claude', 'repo.read_status')!;
    expect(claimed.id).toBe(taskId);

    handovers.initiate('claude', 'founder');

    // Hostile/manual reset of the row back to queued (mirrors the existing
    // security.test.ts forced-state attacks).
    db.prepare(
      `UPDATE op_tasks SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL, claim_nonce = NULL WHERE id = ?`,
    ).run(taskId);

    expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
    expect(queue.get(taskId)!.claimedBy).toBeNull();
  });

  // ---- Case 4: reassignment during handover ----

  it('case 4: work released during a handover is reassignable to the successor, never back to the frozen worker', () => {
    const { queue, queueApprovals, handovers } = ctx;
    const taskId = enqueueRead(ctx);
    handovers.initiate('claude', 'founder');

    // The successor is not frozen and picks the work up.
    const takenOver = queue.claim('jules', 'repo.read_status');
    expect(takenOver).not.toBeNull();
    expect(takenOver!.id).toBe(taskId);
    expect(takenOver!.claimedBy).toBe('jules');

    // And the frozen predecessor still cannot take anything new.
    enqueueRead(ctx, jules);
    expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
  });

  // ---- Case 5: concurrency ----

  it('case 5: repeated concurrent claim attempts during a freeze all fail safely and leave the task queued', () => {
    const { queue, queueApprovals, handovers } = ctx;
    const taskId = enqueueRead(ctx);
    handovers.initiate('claude', 'founder');

    for (let i = 0; i < 25; i += 1) {
      expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
    }

    const task = queue.get(taskId)!;
    expect(task.status).toBe('queued');
    expect(task.claimedBy).toBeNull();
    // No fence inflation from rejected attempts — nothing was written.
    expect(task.fence).toBe(0);
  });

  it('case 5b: a claim rejected by the freeze never burns the single-use Founder approval nonce', () => {
    const { queue, queueApprovals, handovers } = ctx;
    // A genuinely approval-gated capability (NOT pre-approved), so the task
    // carries a real single-use approval nonce that claim() would consume.
    new CapabilityRegistry(ctx.db).register({
      id: 'github.merge_pr',
      description: 'Merge a pull request',
      riskClass: 'external_side_effect',
      sideEffect: true,
      idempotent: false,
    });
    const enq = queueApprovals.enqueue({
      capabilityId: 'github.merge_pr',
      payload: { pr: 127 },
      idempotencyKey: 'merge-127',
      requestedBy: { workerId: 'claude', allowedCapabilities: ['github.merge_pr'] },
    });
    if (!enq.accepted) throw new Error(`enqueue failed: ${enq.reason}`);
    expect(enq.task.status).toBe('needs_approval');

    const approved = queueApprovals.approve(enq.task.id, 'founder');
    expect(approved.status).toBe('queued');
    expect(approved.approvalId).toBeTruthy();

    handovers.initiate('claude', 'founder');
    expect(() => queue.claim('claude', 'github.merge_pr')).toThrow(/active handover/i);

    // The successor must actually HOLD the capability it is taking over: the
    // queue enforces the least-privilege grant at its own boundary now, not
    // only in the service. "The nonce survived" can only be demonstrated by a
    // claim that is legitimate in every other respect.
    ctx.hq.upsertSpecialist({
      id: 'jules',
      displayName: 'Jules',
      vendor: 'google',
      role: 'parallel_implementer',
      allowedCapabilities: ['repo.read_status', 'github.merge_pr'],
      active: true,
    });

    // The nonce survived: the successor can still legitimately claim AND
    // start it. If the rejected claim had consumed the approval, start()
    // would reject at the execution boundary.
    const taken = queue.claim('jules', 'github.merge_pr');
    expect(taken).not.toBeNull();
    expect(() => queue.start(taken!.id, 'jules', taken!.fence)).not.toThrow();
  });

  // ---- Case 6 + 7 + 8: inventory, package contents, acknowledgement ----

  it('case 6/7/8: in-flight work is inventoried, the successor receives it, and acknowledgement is recorded', () => {
    const { queue, memory, handovers, hq } = ctx;
    const inflight = queue.claim('claude', 'repo.read_status', 60_000);
    enqueueRead(ctx);
    const claimed = inflight ?? queue.claim('claude', 'repo.read_status', 60_000)!;

    memory.record({
      kind: 'blocker',
      title: 'Waiting on Founder pricing decision',
      body: 'Cannot finish invoice rounding until the pricing rule is confirmed.',
      status: 'CURRENT',
      recorded: { date: '2026-08-26', confidence: 'exact' },
      recordedBy: 'claude',
      project: 'JENIFY-OS',
    });

    const h = handovers.initiate('claude', 'founder');
    const inventoried = handovers.inventory(h.id);
    expect(inventoried.state).toBe('inventoried');

    const ready = handovers.generatePackage(h.id, memory);
    const pkg = ready.package!;

    // Case 6: the in-flight task is captured, not silently lost.
    expect(pkg.activeAssignments.map((t) => t.id)).toContain(claimed.id);
    // Case 7: the successor gets the context that matters.
    expect(pkg.workerId).toBe('claude');
    expect(pkg.blockers.map((b) => b.title)).toContain('Waiting on Founder pricing decision');

    // Case 8: acknowledgement is recorded with who and when.
    const acked = handovers.acknowledge(h.id, 'jules');
    expect(acked.state).toBe('acknowledged');
    expect(acked.successorId).toBe('jules');
    expect(acked.acknowledgedBy).toBe('jules');
    expect(acked.acknowledgedAt).toBeTruthy();

    // Audit trail carries the acknowledgement too.
    const events = hq.eventsFor('worker', 'claude');
    expect(events.some((e) => e.summary.includes('acknowledged by successor jules'))).toBe(true);
  });

  // ---- Case 9 + 10: verification gates deactivation ----

  it('case 9: failed verification prevents deactivation of the old worker', () => {
    const { queue, memory, handovers, hq } = ctx;
    enqueueRead(ctx);
    const claimed = queue.claim('claude', 'repo.read_status')!;

    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    handovers.acknowledge(h.id, 'jules');

    // Unresolved in-flight work blocks verification...
    expect(() => handovers.verify(h.id, 'founder')).toThrow(new RegExp(claimed.id));
    // ...and completion is structurally unreachable from 'acknowledged'.
    expect(() => handovers.complete(h.id)).toThrow(/expected verified/i);

    // The predecessor is still active — not prematurely deactivated.
    expect(hq.getSpecialist('claude')!.active).toBe(true);
  });

  it('case 10: successful verification permits completion of the replacement', () => {
    const { queue, memory, handovers, hq } = ctx;
    enqueueRead(ctx);
    const claimed = queue.claim('claude', 'repo.read_status')!;

    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    handovers.acknowledge(h.id, 'jules');

    // The lifecycle's drain path: a frozen worker may still finish work it
    // already holds. Freeze blocks acquisition, not resolution.
    expect(() => queue.start(claimed.id, 'claude', claimed.fence)).not.toThrow();
    queue.complete(claimed.id, 'claude', claimed.fence, { ok: true });

    expect(handovers.verify(h.id, 'founder').state).toBe('verified');
    expect(handovers.complete(h.id).state).toBe('completed');
    expect(hq.getSpecialist('claude')!.active).toBe(false);
  });

  // ---- Case 11: after deactivation ----

  it('case 11: a deactivated worker cannot continue receiving work', () => {
    const { queue, memory, handovers } = ctx;
    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    handovers.acknowledge(h.id, 'jules');
    handovers.verify(h.id, 'founder');
    handovers.complete(h.id);

    // The handover is terminal, so the handover-based block no longer
    // applies — the deactivation block must take over.
    enqueueRead(ctx, jules);
    expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/deactivated/i);
  });

  it('case 11b: an aborted handover correctly unfreezes a worker that was never deactivated', () => {
    const { queue, queueApprovals, handovers } = ctx;
    enqueueRead(ctx);
    const h = handovers.initiate('claude', 'founder');
    expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);

    handovers.abort(h.id, 'replacement cancelled by Founder', 'founder');

    // Freeze lifted; the worker is assignable again.
    const claimed = queue.claim('claude', 'repo.read_status');
    expect(claimed).not.toBeNull();
    expect(claimed!.claimedBy).toBe('claude');
  });

  // ---- adjacent bypass: the successor path is an assignment path too ----

  it('adjacent bypass: a worker that is itself frozen cannot be named successor', () => {
    const { hq, memory, handovers } = ctx;
    hq.upsertSpecialist({
      id: 'gemini',
      displayName: 'Gemini',
      vendor: 'google',
      role: 'parallel_implementer',
      allowedCapabilities: ['repo.read_status'],
      active: true,
    });

    // Gemini is itself mid-replacement.
    handovers.initiate('gemini', 'founder');

    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);

    // Accepting a handover transfers a whole workload — it is an assignment,
    // and must obey the same invariant.
    expect(() => handovers.acknowledge(h.id, 'gemini')).toThrow(/active handover/i);

    // The handover stays at package_ready; no successor was recorded.
    const after = handovers.get(h.id)!;
    expect(after.state).toBe('package_ready');
    expect(after.successorId).toBeNull();

    // A genuinely assignable successor still works.
    expect(handovers.acknowledge(h.id, 'jules').successorId).toBe('jules');
  });

  it('adjacent bypass: a deactivated worker cannot be named successor', () => {
    const { hq, memory, handovers } = ctx;
    hq.upsertSpecialist({ ...hq.getSpecialist('jules')!, active: false });

    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);

    expect(() => handovers.acknowledge(h.id, 'jules')).toThrow(/not an active specialist|deactivated/i);
    expect(handovers.get(h.id)!.successorId).toBeNull();
  });

  it('boundary: a frozen worker may still enqueue work, but can never claim it back', () => {
    const { queue, queueApprovals, handovers } = ctx;
    handovers.initiate('claude', 'founder');

    // Enqueue is a request for work to be DONE, not an assignment to the
    // requester, so it stays open (the predecessor may still need to file
    // follow-up work during its own handover).
    const taskId = enqueueRead(ctx);
    expect(queue.get(taskId)!.status).toBe('queued');

    // ...but the frozen worker cannot pick it up. The successor can.
    expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
    expect(queue.claim('jules', 'repo.read_status')!.claimedBy).toBe('jules');
  });

  // ---- Case 12: company memory survives replacement ----

  it('case 12: replacing a worker does not destroy company-owned memory', () => {
    const { memory, handovers, hq } = ctx;
    const decision = memory.record({
      kind: 'decision',
      title: 'Quantities are integer milli base-units',
      body: 'Locked platform-wide to avoid float drift.',
      status: 'CURRENT',
      recorded: { date: '2026-08-20', confidence: 'exact' },
      recordedBy: 'claude',
      project: 'JENIFY-OS',
    });

    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    handovers.acknowledge(h.id, 'jules');
    handovers.verify(h.id, 'founder');
    handovers.complete(h.id);

    expect(hq.getSpecialist('claude')!.active).toBe(false);

    // The company still owns the knowledge after the worker is gone.
    const survived = memory.get(decision.id);
    expect(survived).not.toBeNull();
    expect(survived!.status).toBe('CURRENT');
    expect(survived!.title).toBe('Quantities are integer milli base-units');
    // recordedBy is provenance only — it is not an ownership claim, and the
    // record is not scoped to, or removed with, the departed worker.
    expect(survived!.recordedBy).toBe('claude');
    expect(memory.listByProject('JENIFY-OS').map((r) => r.id)).toContain(decision.id);
  });

  // ---- Case 14: idempotence / replay ----

  it('case 14: duplicate and replayed handover operations are rejected safely', () => {
    const { memory, handovers } = ctx;
    const h = handovers.initiate('claude', 'founder');

    // A second handover for the same predecessor is refused.
    expect(() => handovers.initiate('claude', 'founder')).toThrow(/already has an active handover/i);

    handovers.inventory(h.id);
    expect(() => handovers.inventory(h.id)).toThrow(/expected frozen/i);

    handovers.generatePackage(h.id, memory);
    expect(() => handovers.generatePackage(h.id, memory)).toThrow(/expected inventoried/i);

    handovers.acknowledge(h.id, 'jules');
    expect(() => handovers.acknowledge(h.id, 'jules')).toThrow(/expected package_ready/i);

    handovers.verify(h.id, 'founder');
    handovers.complete(h.id);
    expect(() => handovers.complete(h.id)).toThrow(/expected verified/i);
    expect(() => handovers.abort(h.id, 'late abort', 'founder')).toThrow(/already terminal/i);

    // Exactly one handover row survives, with its full history.
    expect(handovers.listByPredecessor('claude')).toHaveLength(1);
  });

  // ---- Case 15: audit provenance ----

  it('case 15: audit history identifies the old worker, the successor, every state change and its actor', () => {
    const { memory, handovers, hq } = ctx;
    const h = handovers.initiate('claude', 'founder');
    handovers.inventory(h.id);
    handovers.generatePackage(h.id, memory);
    handovers.acknowledge(h.id, 'jules');
    handovers.verify(h.id, 'founder');
    handovers.complete(h.id);

    const events = hq.eventsFor('worker', 'claude');
    const states = events
      .map((e) => (e.detail as Record<string, unknown> | null)?.toState)
      .filter(Boolean);

    expect(states).toEqual([
      'frozen',
      'inventoried',
      'package_ready',
      'acknowledged',
      'verified',
      'completed',
    ]);

    // Every event names the handover, and the actors are preserved.
    expect(events.every((e) => (e.detail as Record<string, unknown>)?.handoverId === h.id)).toBe(true);
    expect(events.map((e) => e.actor)).toContain('founder');
    expect(events.map((e) => e.actor)).toContain('jules');
    // The successor is identifiable from the trail.
    expect(events.some((e) => e.summary.includes('jules'))).toBe(true);
  });

  // ---- Case 16: no regression in normal operation ----

  it('case 16: an unfrozen, active worker is unaffected and claims normally', () => {
    const { queue } = ctx;
    const taskId = enqueueRead(ctx);
    const claimed = queue.claim('claude', 'repo.read_status');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(taskId);
    expect(claimed!.claimedBy).toBe('claude');
    expect(claimed!.status).toBe('assigned');
  });

  it('case 16b: an unrelated worker is unaffected by another worker being frozen', () => {
    const { queue, queueApprovals, handovers } = ctx;
    enqueueRead(ctx);
    handovers.initiate('claude', 'founder');

    const claimed = queue.claim('jules', 'repo.read_status');
    expect(claimed).not.toBeNull();
    expect(claimed!.claimedBy).toBe('jules');
  });

  it('case 16c: an empty queue still returns null rather than throwing for an assignable worker', () => {
    const { queue } = ctx;
    expect(queue.claim('claude', 'repo.read_status')).toBeNull();
  });

  it('hostile: flipping the specialist active flag back on does not lift a freeze', () => {
    const { queue, hq, handovers } = ctx;
    enqueueRead(ctx);
    handovers.initiate('claude', 'founder');

    // Freeze and deactivation are INDEPENDENT gates. Re-asserting "active"
    // on the specialist row must not buy a frozen worker its way back into
    // the assignment path — only aborting/completing the handover changes
    // freeze state.
    hq.upsertSpecialist({ ...hq.getSpecialist('claude')!, active: true });

    expect(() => queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
  });

  // ---- guard-level unit checks ----

  it('assertAssignable remains the single source of truth for both block reasons', () => {
    const { db, hq, handovers } = ctx;
    handovers.initiate('claude', 'founder');
    expect(() => assertAssignable(db, 'claude')).toThrow(/active handover/i);

    hq.upsertSpecialist({ ...hq.getSpecialist('jules')!, active: false });
    expect(() => assertAssignable(db, 'jules')).toThrow(/deactivated/i);
  });
});

// ---- Case 13: persistence / restart ----

describe('freeze survives process restart', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hq-freeze-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('case 13: reopening the database does not accidentally unfreeze a worker', () => {
    const path = join(dir, 'hq.sqlite');

    // ---- process 1: enqueue work and freeze the worker ----
    const first = wire(openHqDatabase(path));
    const enq = first.queueApprovals.enqueue({
      capabilityId: 'repo.read_status',
      payload: {},
      requestedBy: claude,
    });
    if (!enq.accepted) throw new Error('enqueue failed');
    const handoverId = first.handovers.initiate('claude', 'founder').id;
    expect(() => first.queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
    first.db.close();

    // ---- process 2: fresh objects, fresh connection, same file ----
    const second = wire(openHqDatabase(path));
    const persisted = second.handovers.get(handoverId);
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe('frozen');

    // The freeze must still bite after the restart.
    expect(() => second.queue.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
    expect(second.queue.get(enq.task.id)!.status).toBe('queued');

    // And a queue built in the fresh process WITHOUT ever constructing a
    // HandoverStore is bound by it too.
    const { queue: bare, privileged: bareApprovals } = queueWithApprovals(second.db, {
      preApprovedCapabilities: new Set(['github.open_pr']),
    });
    expect(() => bare.claim('claude', 'repo.read_status')).toThrow(/active handover/i);
    second.db.close();
  });
});
