import { beforeEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { OperatorQueue } from '../src/operator/queue.js';

const claudeWorker = {
  workerId: 'claude',
  allowedCapabilities: ['repo.read_status', 'github.open_pr', 'archive.index_document'],
};

function makeQueue(db: HqDatabase): OperatorQueue {
  const q = new OperatorQueue(db, { preApprovedCapabilities: new Set(['github.open_pr']) });
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
  new CapabilityRegistry(db).register({
    id: 'archive.index_document',
    description: 'Index a document (non-idempotent example)',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: false,
  });
  return q;
}

describe('operator queue', () => {
  let db: HqDatabase;
  let queue: OperatorQueue;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    queue = makeQueue(db);
  });

  it('enqueues an allowed read-only task as queued', () => {
    const res = queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    expect(res.accepted && res.task.status).toBe('queued');
  });

  it('denies enqueue for a capability outside the worker allow-list', () => {
    const res = queue.enqueue({
      capabilityId: 'repo.read_status',
      payload: {},
      requestedBy: { workerId: 'stranger', allowedCapabilities: [] },
    });
    expect(res.accepted).toBe(false);
  });

  it('requires an idempotency key for side-effect capabilities', () => {
    const res = queue.enqueue({ capabilityId: 'github.open_pr', payload: {}, requestedBy: claudeWorker });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toMatch(/idempotency/);
  });

  it('deduplicates on idempotency key instead of double-enqueueing', () => {
    const a = queue.enqueue({
      capabilityId: 'github.open_pr',
      payload: { pr: 1 },
      idempotencyKey: 'pr-1',
      requestedBy: claudeWorker,
    });
    const b = queue.enqueue({
      capabilityId: 'github.open_pr',
      payload: { pr: 1 },
      idempotencyKey: 'pr-1',
      requestedBy: claudeWorker,
    });
    expect(a.accepted && b.accepted).toBe(true);
    if (a.accepted && b.accepted) {
      expect(b.task.id).toBe(a.task.id);
      expect(b.deduplicated).toBe(true);
    }
  });

  it('claim is atomic and increments the fencing token', () => {
    queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    const t1 = queue.claim('claude', 'repo.read_status');
    expect(t1?.status).toBe('assigned');
    expect(t1?.fence).toBe(1);
    // Second claim finds nothing left.
    expect(queue.claim('jules', 'repo.read_status')).toBeNull();
  });

  it('rejects writes with a stale fence', () => {
    queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    const t = queue.claim('claude', 'repo.read_status')!;
    queue.start(t.id, 'claude', t.fence);
    expect(() => queue.complete(t.id, 'claude', t.fence - 1, {})).toThrow(/Stale fence/);
    expect(() => queue.complete(t.id, 'jules', t.fence, {})).toThrow(/Stale fence/);
  });

  it('completes a task with evidence and records the event trail', () => {
    queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    const t = queue.claim('claude', 'repo.read_status')!;
    queue.start(t.id, 'claude', t.fence);
    const done = queue.complete(t.id, 'claude', t.fence, { ok: true }, ['https://example.test/run/1']);
    expect(done.status).toBe('completed');
    const kinds = queue.evidence.list(t.id).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['claimed', 'execution_result']));
  });

  it('kill switch blocks new claims globally and per capability', () => {
    queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    queue.engageKillSwitch('*', 'founder', 'emergency stop');
    expect(queue.claim('claude', 'repo.read_status')).toBeNull();
    queue.releaseKillSwitch('*');
    queue.engageKillSwitch('repo.read_status', 'founder', 'capability paused');
    expect(queue.claim('claude', 'repo.read_status')).toBeNull();
    queue.releaseKillSwitch('repo.read_status');
    expect(queue.claim('claude', 'repo.read_status')).not.toBeNull();
  });

  it('expired lease on a running side-effect task becomes outcome_unknown, never a retry', () => {
    queue.enqueue({
      capabilityId: 'github.open_pr',
      payload: {},
      idempotencyKey: 'pr-2',
      requestedBy: claudeWorker,
    });
    const t = queue.claim('claude', 'github.open_pr', -1)!; // lease already expired
    queue.start(t.id, 'claude', t.fence);
    const swept = queue.sweepExpiredLeases();
    expect(swept.outcomeUnknown).toContain(t.id);
    expect(queue.get(t.id)!.status).toBe('outcome_unknown');
  });

  it('expired lease on a read-only task is safely re-queued', () => {
    queue.enqueue({ capabilityId: 'repo.read_status', payload: {}, requestedBy: claudeWorker });
    const t = queue.claim('claude', 'repo.read_status', -1)!;
    const swept = queue.sweepExpiredLeases();
    expect(swept.requeued).toContain(t.id);
    const again = queue.claim('jules', 'repo.read_status');
    expect(again?.id).toBe(t.id);
    expect(again?.fence).toBe(2); // fence advanced; old claim cannot write
    expect(() => queue.complete(t.id, 'claude', 1, {})).toThrow(/Stale fence/);
  });

  it('reconciles outcome_unknown: confirmed_done -> completed', () => {
    queue.enqueue({ capabilityId: 'github.open_pr', payload: {}, idempotencyKey: 'pr-3', requestedBy: claudeWorker });
    const t = queue.claim('claude', 'github.open_pr', -1)!;
    queue.start(t.id, 'claude', t.fence);
    queue.sweepExpiredLeases();
    const done = queue.reconcile(t.id, 'confirmed_done', 'codex', 'PR exists on GitHub');
    expect(done.status).toBe('completed');
  });

  it('reconcile confirmed_not_executed re-queues only idempotent capabilities', () => {
    queue.enqueue({
      capabilityId: 'archive.index_document',
      payload: {},
      idempotencyKey: 'doc-1',
      requestedBy: claudeWorker,
    });
    const approved = queue.listByStatus('needs_approval')[0];
    queue.approve(approved.id);
    const t = queue.claim('claude', 'archive.index_document', -1)!;
    queue.start(t.id, 'claude', t.fence);
    queue.sweepExpiredLeases();
    expect(() => queue.reconcile(t.id, 'confirmed_not_executed', 'codex', 'not sure')).toThrow(
      /not idempotent/,
    );
  });

  it('needs_approval flows through founder approve/deny', () => {
    const res = queue.enqueue({
      capabilityId: 'archive.index_document',
      payload: {},
      idempotencyKey: 'doc-2',
      requestedBy: claudeWorker,
    });
    expect(res.accepted && res.task.status).toBe('needs_approval');
    if (!res.accepted) return;
    const denied = queue.deny(res.task.id, 'not this wave');
    expect(denied.status).toBe('blocked');
    expect(denied.blockReason).toBe('not this wave');
  });

  it('rejects payloads containing secret-like content', () => {
    const res = () =>
      queue.enqueue({
        capabilityId: 'repo.read_status',
        payload: { note: 'api_key: sk-1234567890abcdef' },
        requestedBy: claudeWorker,
      });
    expect(res).toThrow(/secret-like/);
  });
});
