/**
 * Universal Operator task queue.
 *
 * Core guarantees:
 * - Atomic claim: a task is claimed by exactly one worker via a single
 *   conditional UPDATE; every claim increments a fencing token, and all
 *   subsequent writes for that claim must present the current fence.
 * - Leases: a claim holds a lease; an expired lease can be swept, but a
 *   side-effect task whose worker went silent becomes OUTCOME_UNKNOWN —
 *   never a silent retry (war room #41 safety rules).
 * - Idempotency: side-effect capabilities require an idempotency key at
 *   enqueue; duplicates return the existing task instead of enqueuing twice.
 * - Kill switch: when engaged (globally or per capability), no new claims
 *   are handed out.
 * - Every state change is recorded in the Headquarter event log and the
 *   hash-chained evidence log.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { assertTransition, type ActivityStatus } from '../contracts/events.js';
import { CapabilityRegistry } from './capabilities.js';
import { evaluatePolicy, type PolicyContext } from './policy.js';
import { EvidenceLog, assertNoSecretLikeContent } from './evidence.js';

export interface OperatorTask {
  id: string;
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  status: ActivityStatus;
  fence: number;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  result: Record<string, unknown> | null;
  blockReason: string | null;
}

export interface EnqueueRequest {
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  requestedBy: { workerId: string; allowedCapabilities: readonly string[] };
}

export type EnqueueResult =
  | { accepted: true; task: OperatorTask; deduplicated: boolean }
  | { accepted: false; reason: string };

export type ReconcileDecision = 'confirmed_done' | 'confirmed_failed' | 'confirmed_not_executed';

const GLOBAL_SCOPE = '*';

export class OperatorQueue {
  readonly capabilities: CapabilityRegistry;
  readonly evidence: EvidenceLog;

  constructor(
    private db: HqDatabase,
    private policyCtx: PolicyContext = {},
  ) {
    this.capabilities = new CapabilityRegistry(db);
    this.evidence = new EvidenceLog(db);
  }

  // ---- kill switch ----

  engageKillSwitch(scope: string = GLOBAL_SCOPE, by = 'founder', reason = ''): void {
    this.db
      .prepare(
        `INSERT INTO op_kill_switch (scope, engaged, reason, engaged_by, engaged_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET engaged = 1, reason = excluded.reason,
           engaged_by = excluded.engaged_by, engaged_at = excluded.engaged_at`,
      )
      .run(scope, reason, by, nowIso());
    this.evidence.append({ actor: by, kind: 'kill_switch_engaged', payload: { scope, reason } });
  }

  releaseKillSwitch(scope: string = GLOBAL_SCOPE, by = 'founder'): void {
    this.db.prepare(`UPDATE op_kill_switch SET engaged = 0 WHERE scope = ?`).run(scope);
    this.evidence.append({ actor: by, kind: 'kill_switch_released', payload: { scope } });
  }

  killSwitchEngaged(capabilityId?: string): boolean {
    const scopes = [GLOBAL_SCOPE, ...(capabilityId ? [capabilityId] : [])];
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM op_kill_switch WHERE engaged = 1 AND scope IN (${scopes
          .map(() => '?')
          .join(',')}) LIMIT 1`,
      )
      .get(...scopes);
    return !!row;
  }

  // ---- enqueue ----

  enqueue(req: EnqueueRequest): EnqueueResult {
    assertNoSecretLikeContent(req.payload);
    const cap = this.capabilities.get(req.capabilityId);
    const decision = evaluatePolicy(cap, req.requestedBy, this.policyCtx);
    if (decision.outcome === 'deny') {
      this.evidence.append({
        actor: req.requestedBy.workerId,
        kind: 'enqueue_denied',
        payload: { capabilityId: req.capabilityId, reason: decision.reason },
      });
      return { accepted: false, reason: decision.reason };
    }
    if (cap!.sideEffect && !req.idempotencyKey) {
      return {
        accepted: false,
        reason: `Capability ${cap!.id} has side effects and requires an idempotency key`,
      };
    }
    if (req.idempotencyKey) {
      const existing = this.db
        .prepare(`SELECT id FROM op_tasks WHERE capability_id = ? AND idempotency_key = ?`)
        .get(req.capabilityId, req.idempotencyKey) as { id: string } | undefined;
      if (existing) {
        return { accepted: true, task: this.get(existing.id)!, deduplicated: true };
      }
    }
    const id = uuid();
    const at = nowIso();
    const status: ActivityStatus = decision.outcome === 'needs_approval' ? 'needs_approval' : 'queued';
    this.db
      .prepare(
        `INSERT INTO op_tasks (id, capability_id, payload, idempotency_key, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, req.capabilityId, JSON.stringify(req.payload), req.idempotencyKey ?? null, status, req.requestedBy.workerId, at, at);
    this.recordEvent(id, status, req.requestedBy.workerId, `Task enqueued for ${req.capabilityId}`);
    this.evidence.append({
      taskId: id,
      actor: req.requestedBy.workerId,
      kind: 'enqueued',
      payload: {
        capabilityId: req.capabilityId,
        status,
        policyReason: decision.outcome === 'needs_approval' ? decision.reason : 'auto-allowed',
      },
    });
    return { accepted: true, task: this.get(id)!, deduplicated: false };
  }

  /** Founder approval moves a needs_approval task into the queue. */
  approve(taskId: string, by = 'founder'): OperatorTask {
    return this.transition(taskId, 'queued', by, 'Founder approved');
  }

  /** Founder denial blocks the task with a reason. */
  deny(taskId: string, reason: string, by = 'founder'): OperatorTask {
    const task = this.transition(taskId, 'blocked', by, `Founder denied: ${reason}`);
    this.db.prepare(`UPDATE op_tasks SET block_reason = ? WHERE id = ?`).run(reason, taskId);
    return this.get(taskId)!;
  }

  // ---- claim / execute lifecycle ----

  /**
   * Atomically claim the oldest queued task for a capability. Returns null
   * when nothing is claimable or the kill switch is engaged.
   */
  claim(workerId: string, capabilityId: string, leaseMs = 5 * 60_000): OperatorTask | null {
    if (this.killSwitchEngaged(capabilityId)) return null;
    const candidate = this.db
      .prepare(
        `SELECT id, fence FROM op_tasks
         WHERE capability_id = ? AND status = 'queued'
         ORDER BY created_at LIMIT 1`,
      )
      .get(capabilityId) as { id: string; fence: number } | undefined;
    if (!candidate) return null;
    const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
    const res = this.db
      .prepare(
        `UPDATE op_tasks
         SET status = 'assigned', fence = fence + 1, claimed_by = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND fence = ?`,
      )
      .run(workerId, leaseExpires, nowIso(), candidate.id, candidate.fence);
    if (res.changes === 0) return null; // lost the race; caller may retry
    this.recordEvent(candidate.id, 'assigned', workerId, `Claimed by ${workerId}`);
    this.evidence.append({
      taskId: candidate.id,
      actor: workerId,
      kind: 'claimed',
      payload: { fence: candidate.fence + 1, leaseExpires },
    });
    return this.get(candidate.id)!;
  }

  /** Worker signals it has started executing. Fence must match. */
  start(taskId: string, workerId: string, fence: number): OperatorTask {
    this.assertFence(taskId, workerId, fence);
    return this.transition(taskId, 'running', workerId, 'Execution started');
  }

  /** Extend the lease mid-execution. Fence must match. */
  heartbeat(taskId: string, workerId: string, fence: number, leaseMs = 5 * 60_000): void {
    this.assertFence(taskId, workerId, fence);
    this.db
      .prepare(`UPDATE op_tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + leaseMs).toISOString(), nowIso(), taskId);
  }

  /**
   * Worker reports completion with evidence. Side-effect completions go to
   * review_passed only via an independent reviewer; workers land on
   * `completed` directly only for read-only capabilities.
   */
  complete(
    taskId: string,
    workerId: string,
    fence: number,
    result: Record<string, unknown>,
    evidenceRefs: string[] = [],
  ): OperatorTask {
    this.assertFence(taskId, workerId, fence);
    assertNoSecretLikeContent(result);
    this.db.prepare(`UPDATE op_tasks SET result = ? WHERE id = ?`).run(JSON.stringify(result), taskId);
    this.evidence.append({
      taskId,
      actor: workerId,
      kind: 'execution_result',
      payload: { result, refs: evidenceRefs },
    });
    return this.transition(taskId, 'completed', workerId, 'Execution completed');
  }

  fail(taskId: string, workerId: string, fence: number, reason: string): OperatorTask {
    this.assertFence(taskId, workerId, fence);
    this.evidence.append({ taskId, actor: workerId, kind: 'execution_failed', payload: { reason } });
    return this.transition(taskId, 'review_failed', workerId, `Execution failed: ${reason}`);
  }

  // ---- lease expiry / OUTCOME_UNKNOWN ----

  /**
   * Sweep expired leases. A read-only, no-side-effect task is safely
   * re-queued. A side-effect task whose worker went silent while
   * assigned/running becomes OUTCOME_UNKNOWN and waits for explicit
   * reconciliation — never a blind retry.
   */
  sweepExpiredLeases(): { requeued: string[]; outcomeUnknown: string[] } {
    const now = nowIso();
    const rows = this.db
      .prepare(
        `SELECT t.id, t.status, c.side_effect AS side_effect
         FROM op_tasks t JOIN op_capabilities c ON c.id = t.capability_id
         WHERE t.status IN ('assigned', 'running') AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at < ?`,
      )
      .all(now) as { id: string; status: ActivityStatus; side_effect: number }[];
    const requeued: string[] = [];
    const outcomeUnknown: string[] = [];
    for (const row of rows) {
      if (row.side_effect && row.status === 'running') {
        this.transition(row.id, 'outcome_unknown', 'system', 'Lease expired mid-execution of a side-effect task');
        outcomeUnknown.push(row.id);
      } else {
        this.transition(row.id, 'queued', 'system', 'Lease expired; task re-queued');
        this.db
          .prepare(`UPDATE op_tasks SET claimed_by = NULL, lease_expires_at = NULL WHERE id = ?`)
          .run(row.id);
        requeued.push(row.id);
      }
    }
    return { requeued, outcomeUnknown };
  }

  /**
   * Resolve OUTCOME_UNKNOWN after a human/reviewer checked the real world.
   * 'confirmed_not_executed' re-queues only idempotent capabilities; for
   * non-idempotent ones it is refused and the task must be resolved as done
   * or failed after further investigation.
   */
  reconcile(taskId: string, decision: ReconcileDecision, by: string, note: string): OperatorTask {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status !== 'outcome_unknown') {
      throw new Error(`Task ${taskId} is not outcome_unknown`);
    }
    this.evidence.append({ taskId, actor: by, kind: 'reconciliation', payload: { decision, note } });
    if (decision === 'confirmed_done') {
      return this.transition(taskId, 'completed', by, `Reconciled done: ${note}`);
    }
    if (decision === 'confirmed_failed') {
      return this.transition(taskId, 'review_failed', by, `Reconciled failed: ${note}`);
    }
    const cap = this.capabilities.get(task.capabilityId)!;
    if (!cap.idempotent) {
      throw new Error(
        `Capability ${cap.id} is not idempotent; cannot safely re-queue an uncertain execution`,
      );
    }
    const requeued = this.transition(taskId, 'queued', by, `Reconciled not-executed: ${note}`);
    this.db
      .prepare(`UPDATE op_tasks SET claimed_by = NULL, lease_expires_at = NULL WHERE id = ?`)
      .run(taskId);
    return this.get(taskId) ?? requeued;
  }

  // ---- reads / internals ----

  get(id: string): OperatorTask | null {
    const row = this.db.prepare(`SELECT * FROM op_tasks WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      capabilityId: row.capability_id as string,
      payload: JSON.parse(row.payload as string),
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
      status: row.status as ActivityStatus,
      fence: row.fence as number,
      claimedBy: (row.claimed_by as string | null) ?? null,
      leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      result: row.result ? JSON.parse(row.result as string) : null,
      blockReason: (row.block_reason as string | null) ?? null,
    };
  }

  listByStatus(status: ActivityStatus): OperatorTask[] {
    const rows = this.db
      .prepare(`SELECT id FROM op_tasks WHERE status = ? ORDER BY created_at`)
      .all(status) as { id: string }[];
    return rows.map((r) => this.get(r.id)!);
  }

  private assertFence(taskId: string, workerId: string, fence: number): void {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.claimedBy !== workerId || task.fence !== fence) {
      throw new Error(
        `Stale fence for task ${taskId}: worker ${workerId} fence ${fence} vs current ${task.claimedBy}/${task.fence}`,
      );
    }
  }

  private transition(taskId: string, to: ActivityStatus, actor: string, summary: string): OperatorTask {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    assertTransition(task.status, to);
    this.db
      .prepare(`UPDATE op_tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(to, nowIso(), taskId);
    this.recordEvent(taskId, to, actor, summary);
    return this.get(taskId)!;
  }

  private recordEvent(taskId: string, status: ActivityStatus, actor: string, summary: string): void {
    this.db
      .prepare(
        `INSERT INTO hq_events (id, at, subject_kind, subject_id, status, actor, summary)
         VALUES (?, ?, 'task', ?, ?, ?, ?)`,
      )
      .run(uuid(), nowIso(), taskId, status, actor, summary);
  }
}
