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
import { approvalRequired, evaluatePolicy, type PolicyContext } from './policy.js';
import { EvidenceLog, assertNoSecretLikeContent } from './evidence.js';
// Worker-assignability guard. The handover module owns the freeze/replacement
// state, so the queue consults IT rather than re-deriving "is this worker
// frozen?" from its own copy of that logic — one source of truth, per the
// replacement-safety model. handover/ depends only on leaf modules
// (store/, memory/, operator/evidence.js) and never on this file, so this
// import introduces no cycle.
// assertAssignable is self-sufficient (it ensures its own tables), so the
// guard holds regardless of whether a HandoverStore was ever constructed.
import { assertAssignable } from '../handover/replacement.js';
import {
  checkProviderBinding,
  readProviderBinding,
  WorkerProviderDirectory,
  type ProviderBindingViolation,
  type WorkerProviderLookup,
  type WorkerProviderRecord,
} from './provider-binding.js';
import {
  DEFAULT_APPROVAL_TTL_MS,
  approvalExpiredAt,
  taskActionDigest,
  validateApproval,
  validateApprovalClaimBinding,
  type ApprovalRejection,
} from './approvals.js';

/**
 * Independent-review pipeline state for a task's reported result (issue #53
 * correction B). Orthogonal to the canonical activity status: a side-effect
 * execution that reported a result sits in `pending` (status stays `running`)
 * until an independent reviewer — never the executing worker — passes or
 * fails it.
 */
export type ReviewState = 'none' | 'pending' | 'passed' | 'failed';

export interface OperatorTask {
  id: string;
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  status: ActivityStatus;
  fence: number;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  /**
   * Random nonce minted by the current claim (issue #77). The claim stamps
   * the same nonce onto the approval row when it consumes the single-use
   * approval; start() verifies the two still match, so a consumed approval
   * cannot be reattached to a forced assigned state or a different claim.
   */
  claimNonce: string | null;
  /** Single-use approval nonce currently bound to this task, if any. */
  approvalId: string | null;
  reviewState: ReviewState;
  /** Worker that submitted the execution result now awaiting review. */
  submittedBy: string | null;
  submittedAt: string | null;
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
  /**
   * Declared worker → provider map, LOOKUP ONLY (issue #200, Codex round-3
   * P1 #1). The object behind this handle has no write method at all: writing
   * the map is a configuration act gated on approval authority in
   * `HeadquarterOperations`, so nothing on the execution path — which is what
   * holds a queue — can move its own provider identity.
   */
  /**
   * The enforcement lookup is a CLOSURE, not an instance of an exported class.
   *
   * It was a public `readonly` reference to a `WorkerProviderDirectory`, then a
   * `#private` one — and neither was enough, because dispatch still went
   * through that class's prototype. `WorkerProviderDirectory` is exported, so a
   * worker sharing this realm could assign
   * `WorkerProviderDirectory.prototype.providerOf = () => 'CLAUDE'` and both
   * `selectClaimable` and `assertProviderBinding` would call the patched method
   * on the private instance (issue #200, Codex exact-head finding on
   * `67b5937`). The SIXTH mechanism at this boundary: making the reference
   * private protected the reference and left the method lookup mutable.
   *
   * A closure created here has no prototype in its dispatch path and no
   * exported identity to patch. `#providerOf` is an own field holding a
   * function defined in this module over `#db`; calling it resolves nothing
   * through any prototype an attacker can reach.
   */
  readonly #providerOf: (workerId: string) => string | null;
  readonly #listProviders: () => WorkerProviderRecord[];

  /**
   * ECMAScript `#private`. TypeScript `private` erases to a public property, so
   * `queue.db` handed any JavaScript caller holding this object a WRITABLE
   * database — from which `op_worker_providers` can be upserted directly,
   * satisfying the provider check while never reaching
   * `HeadquarterOperations.declareWorkerProvider`, its principal/approval check
   * or its evidence entry (issue #200, Codex exact-head finding on `135ae58`).
   * Making the registrar `#private` closed the named-property route and left
   * this one open; a gate in front of a mechanism whose raw substrate is public
   * is not a gate.
   */
  readonly #db: HqDatabase;
  readonly #policyCtx: PolicyContext;

  constructor(db: HqDatabase, policyCtx: PolicyContext = {}) {
    this.#db = db;
    this.#policyCtx = policyCtx;
    this.capabilities = new CapabilityRegistry(db);
    this.evidence = new EvidenceLog(db);
    // Built here rather than delegated to the exported class, so no prototype
    // an attacker can reach participates in the enforcement path. The SQL is
    // the same as `WorkerProviderDirectory`'s; the read side of that class
    // stays exported for callers who legitimately want an object.
    this.#providerOf = (workerId: string): string | null => {
      const row = db
        .prepare(`SELECT provider_id FROM op_worker_providers WHERE worker_id = ?`)
        .get(workerId) as { provider_id: string } | undefined;
      return row?.provider_id ?? null;
    };
    this.#listProviders = (): WorkerProviderRecord[] => {
      const rows = db
        .prepare(
          `SELECT worker_id, provider_id, declared_by, declared_at FROM op_worker_providers ORDER BY worker_id`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((row) => ({
        workerId: String(row.worker_id),
        providerId: String(row.provider_id) as WorkerProviderRecord['providerId'],
        declaredBy: String(row.declared_by),
        declaredAt: String(row.declared_at),
      }));
    };
  }

  /**
   * Refuse a worker that does not match a task's declared execution provider.
   *
   * Called at BOTH execution boundaries — claim and start — so a task whose
   * status was forced to `assigned` behind the queue's back still cannot be
   * executed by the wrong provider. The refusal is loud (a throw) and
   * evidenced, never a silent `null`: "this is not yours" and "the queue is
   * empty" are different facts.
   */
  #assertProviderBinding(task: OperatorTask, workerId: string): void {
    const binding = readProviderBinding(task.payload);
    if (!binding.bound) return;
    const workerProvider = this.#providerOf(workerId);
    const violation: ProviderBindingViolation | null = checkProviderBinding(
      task.id,
      workerId,
      binding,
      workerProvider,
    );
    if (!violation) return;
    this.#recordBindingRefusal(violation, workerId);
    throw violation;
  }

  #recordBindingRefusal(violation: ProviderBindingViolation, workerId: string): void {
    this.evidence.append({
      taskId: violation.taskId,
      actor: workerId,
      kind: 'provider_binding_rejected',
      payload: {
        requiredProvider: violation.requiredProvider,
        workerProvider: violation.workerProvider,
        reason: violation.message,
      },
    });
  }

  /**
   * The oldest QUEUED task for a capability that this worker may actually
   * claim (issue #200, Codex round-3 P1 #2).
   *
   * Provider binding takes part in SELECTION, not only in refusal. Previously
   * the queue offered the single oldest queued task and then refused it if the
   * binding did not match, so one CLAUDE-bound order at the head could block a
   * CODEX worker from every later CODEX-compatible task in the same
   * capability — indefinitely, since a queued task only leaves the head by
   * being claimed. The worker is now offered the oldest COMPATIBLE task
   * instead.
   *
   * Nothing is loosened by skipping: an incompatible task was never claimable
   * by this worker, at the head or anywhere else, and malformed or undeclared
   * bindings still fail closed — a malformed `executionProvider` is compatible
   * with nobody, and a worker with no declaration is compatible only with
   * unbound tasks.
   *
   * Silence and refusal stay different facts. When nothing compatible exists
   * the FIRST incompatible task's violation is returned, so the caller can
   * still say "that work is not yours" (evidenced, loudly) rather than "the
   * queue is empty".
   *
   * The worker's declared provider is read ONCE, before the scan, so the
   * comparison cannot drift mid-scan and no query runs inside the row walk.
   */
  #selectClaimableInternal(
    workerId: string,
    capabilityId: string,
  ): { task: OperatorTask | null; refusal: ProviderBindingViolation | null } {
    const workerProvider = this.#providerOf(workerId);
    // Queued depth per capability is small in HQ; ids and payloads only.
    const rows = this.#db
      .prepare(
        `SELECT id, payload FROM op_tasks
         WHERE capability_id = ? AND status = 'queued'
         ORDER BY created_at`,
      )
      .all(capabilityId) as { id: string; payload: string }[];
    let firstRefusal: ProviderBindingViolation | null = null;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        // An unparseable payload is not offered to anyone: a task whose
        // binding cannot even be read is exactly the case to fail closed on.
        continue;
      }
      const binding = readProviderBinding(payload);
      const violation = checkProviderBinding(row.id, workerId, binding, workerProvider);
      if (!violation) return { task: this.get(row.id), refusal: null };
      firstRefusal ??= violation;
    }
    return { task: null, refusal: firstRefusal };
  }

  // ---- kill switch ----

  engageKillSwitch(scope: string = GLOBAL_SCOPE, by = 'founder', reason = ''): void {
    this.#db
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
    this.#db.prepare(`UPDATE op_kill_switch SET engaged = 0 WHERE scope = ?`).run(scope);
    this.evidence.append({ actor: by, kind: 'kill_switch_released', payload: { scope } });
  }

  /**
   * Read-only delegates for callers OUTSIDE the queue.
   *
   * Enforcement never dispatches through these. `claim` and `start` call the
   * `#private` methods directly, so patching either of these on an instance or
   * on `OperatorQueue.prototype` changes what the PATCHER sees and nothing
   * about what the queue enforces.
   *
   * They exist because `HeadquarterOperations` legitimately needs to peek at
   * the same selection and kill-switch state; that is a read, and a caller who
   * lies to itself about a read harms only itself. It was not always so: both
   * were ordinary methods that `claim` itself dispatched through, so
   * `queue.selectClaimable = () => ({ task, refusal: null })` combined with
   * `queue.assertProviderBinding = () => {}` walked a CODEX worker straight
   * through to the conditional update and approval consumption of a
   * CLAUDE-bound task (issue #200, Codex exact-head finding on `e578112` — the
   * seventh mechanism at this boundary, and the third found in my tests rather
   * than my code).
   */
  killSwitchEngaged(capabilityId?: string): boolean {
    return this.#killSwitchEngagedInternal(capabilityId);
  }

  selectClaimable(
    workerId: string,
    capabilityId: string,
  ): { task: OperatorTask | null; refusal: ProviderBindingViolation | null } {
    return this.#selectClaimableInternal(workerId, capabilityId);
  }

  #killSwitchEngagedInternal(capabilityId?: string): boolean {
    const scopes = [GLOBAL_SCOPE, ...(capabilityId ? [capabilityId] : [])];
    const row = this.#db
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
    const decision = evaluatePolicy(cap, req.requestedBy, this.#policyCtx);
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
      const existing = this.#db
        .prepare(`SELECT id FROM op_tasks WHERE capability_id = ? AND idempotency_key = ?`)
        .get(req.capabilityId, req.idempotencyKey) as { id: string } | undefined;
      if (existing) {
        return { accepted: true, task: this.get(existing.id)!, deduplicated: true };
      }
    }
    const id = uuid();
    const at = nowIso();
    const status: ActivityStatus = decision.outcome === 'needs_approval' ? 'needs_approval' : 'queued';
    this.#db
      .prepare(
        `INSERT INTO op_tasks (id, capability_id, payload, idempotency_key, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, req.capabilityId, JSON.stringify(req.payload), req.idempotencyKey ?? null, status, req.requestedBy.workerId, at, at);
    this.#recordEvent(id, status, req.requestedBy.workerId, `Task enqueued for ${req.capabilityId}`);
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

  /**
   * Founder approval moves a needs_approval task into the queue — bound to
   * the exact immutable action (issue #53 correction A): the approval record
   * stores the SHA-256 digest of the task's canonical serialization, a
   * time-box, and acts as a single-use nonce consumed at claim time. Any
   * later capability/payload mutation, expiry, or replay invalidates it at
   * the execution boundary.
   */
  approve(taskId: string, by = 'founder', opts: { ttlMs?: number; note?: string } = {}): OperatorTask {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status !== 'needs_approval') {
      throw new Error(`Task ${taskId} is not awaiting approval (status: ${task.status})`);
    }
    if (by === task.createdBy || (task.claimedBy && by === task.claimedBy) || by === 'system') {
      throw new Error(
        `Actor ${by} cannot approve task ${taskId}: the requesting/executing worker may not approve its own action`,
      );
    }
    const digest = taskActionDigest(task);
    const approvalId = uuid();
    const at = nowIso();
    const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString();
    const cap = this.capabilities.get(task.capabilityId);
    this.#db
      .prepare(
        `INSERT INTO hq_approvals (id, task_id, ask, risk_class, requested_by, requested_at,
           decision, decided_at, decided_by, decision_note, action_digest, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
      )
      .run(
        approvalId,
        taskId,
        `Execute ${task.capabilityId}`,
        cap?.riskClass ?? 'unknown',
        task.createdBy,
        at,
        at,
        by,
        opts.note ?? null,
        digest,
        expiresAt,
      );
    this.#db.prepare(`UPDATE op_tasks SET approval_id = ? WHERE id = ?`).run(approvalId, taskId);
    this.evidence.append({
      taskId,
      actor: by,
      kind: 'founder_approved',
      payload: { approvalId, actionDigest: digest, expiresAt },
    });
    return this.#transition(taskId, 'queued', by, 'Founder approved (digest-bound, single-use)');
  }

  /** Founder denial blocks the task with a reason; the denial is recorded immutably. */
  deny(taskId: string, reason: string, by = 'founder'): OperatorTask {
    const before = this.get(taskId);
    if (!before) throw new Error(`Unknown task: ${taskId}`);
    const cap = this.capabilities.get(before.capabilityId);
    const task = this.#transition(taskId, 'blocked', by, `Founder denied: ${reason}`);
    this.#db.prepare(`UPDATE op_tasks SET block_reason = ? WHERE id = ?`).run(reason, taskId);
    this.#db
      .prepare(
        `INSERT INTO hq_approvals (id, task_id, ask, risk_class, requested_by, requested_at,
           decision, decided_at, decided_by, decision_note, action_digest)
         VALUES (?, ?, ?, ?, ?, ?, 'denied', ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        taskId,
        `Execute ${before.capabilityId}`,
        cap?.riskClass ?? 'unknown',
        before.createdBy,
        nowIso(),
        nowIso(),
        by,
        reason,
        taskActionDigest(before),
      );
    this.evidence.append({ taskId, actor: by, kind: 'founder_denied', payload: { reason } });
    return this.get(taskId) ?? task;
  }

  // ---- claim / execute lifecycle ----

  /**
   * Atomically claim the oldest queued task for a capability. Returns null
   * when nothing is claimable or the kill switch is engaged.
   *
   * THROWS when `workerId` is not assignable — frozen by an active handover,
   * or deactivated (see assertAssignable). This is the canonical assignment
   * boundary: `claim()` is the ONLY code path in the repository that writes a
   * worker id into `op_tasks.claimed_by`, so enforcing the replacement-safety
   * invariant here enforces it for every supported assignment path, including
   * callers that never construct a HandoverStore. A rejection is loud rather
   * than a silent `null` so a frozen worker cannot mistake "you are being
   * replaced" for "the queue is empty".
   */
  /**
   * Read-only view of the declared worker→provider map.
   *
   * A method rather than a property: what it returns is a copied array of plain
   * records, so a caller can read the declarations without holding the object
   * the binding checks consult. Patching this method on one queue instance
   * changes what that caller sees and nothing about what `claim` enforces.
   */
  listWorkerProviders(): WorkerProviderRecord[] {
    return this.#listProviders();
  }

  claim(workerId: string, capabilityId: string, leaseMs = 5 * 60_000): OperatorTask | null {
    // Deny-by-default, and FIRST: before any read, any state mutation, and
    // crucially before the single-use approval nonce is consumed below, so a
    // rejected claim can never burn an approval or inflate a fencing token.
    assertAssignable(this.#db, workerId);
    if (this.#killSwitchEngagedInternal(capabilityId)) return null;
    // Provider binding participates in SELECTION, before any mutation and
    // before the single-use approval nonce can be consumed: the worker is
    // offered the oldest task compatible with its declared provider, and an
    // order routed to one provider is never handed to another (issue #200,
    // Codex P1 #1 and round-3 P1 #2).
    const { task: selected, refusal } = this.#selectClaimableInternal(workerId, capabilityId);
    if (!selected) {
      // Nothing compatible. If incompatible work exists, say so loudly and
      // evidence it — "not yours" is not "the queue is empty".
      if (refusal) {
        this.#recordBindingRefusal(refusal, workerId);
        throw refusal;
      }
      return null;
    }
    const candidate = { id: selected.id, fence: selected.fence };
    // Execution boundary (issue #53 correction A): an approval-gated task is
    // admitted only with a valid, unexpired, unconsumed approval bound to the
    // task's CURRENT digest — even if something forced its status to queued.
    const task = selected;
    // Belt and braces: the selected task is compatible by construction, and
    // this re-derives that from the task row itself rather than trusting the
    // scan, on the path that is about to consume an approval.
    this.#assertProviderBinding(task, workerId);
    const cap = this.capabilities.get(capabilityId);
    if (!cap || !cap.enabled) return null; // deny by default
    if (approvalRequired(cap, this.#policyCtx)) {
      const rejection = this.#validateTaskApproval(task);
      if (rejection) {
        this.#rejectAtExecutionBoundary(task, rejection);
        return null;
      }
    }
    const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
    const claimNonce = uuid();
    const claimFence = candidate.fence + 1;
    const res = this.#db
      .prepare(
        `UPDATE op_tasks
         SET status = 'assigned', fence = fence + 1, claimed_by = ?, lease_expires_at = ?, claim_nonce = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND fence = ?`,
      )
      .run(workerId, leaseExpires, claimNonce, nowIso(), candidate.id, candidate.fence);
    if (res.changes === 0) return null; // lost the race; caller may retry
    // Consume the single-use approval nonce exactly once, with the claim —
    // recording WHICH claim consumed it (issues #77/#79): worker, exact task,
    // fencing token, and the per-claim nonce, written in the same atomic
    // conditional UPDATE as the consumption itself. start() re-verifies this
    // binding.
    if (cap && approvalRequired(cap, this.#policyCtx) && task.approvalId) {
      const consumed = this.#db
        .prepare(
          `UPDATE hq_approvals
           SET consumed_at = ?, consumed_by = ?, consumed_task_id = ?, consumed_fence = ?, consumed_claim_nonce = ?
           WHERE id = ? AND consumed_at IS NULL`,
        )
        .run(nowIso(), workerId, candidate.id, claimFence, claimNonce, task.approvalId);
      if (consumed.changes === 0) {
        // Nonce raced/replayed: undo nothing destructive — surface loudly.
        throw new Error(`Approval nonce ${task.approvalId} was already consumed (replay rejected)`);
      }
      this.evidence.append({
        taskId: candidate.id,
        actor: workerId,
        kind: 'approval_consumed',
        payload: {
          approvalId: task.approvalId,
          consumedBy: workerId,
          consumedTaskId: candidate.id,
          consumedFence: claimFence,
          claimNonce,
        },
      });
    }
    this.#recordEvent(candidate.id, 'assigned', workerId, `Claimed by ${workerId}`);
    this.evidence.append({
      taskId: candidate.id,
      actor: workerId,
      kind: 'claimed',
      payload: { fence: candidate.fence + 1, leaseExpires },
    });
    return this.get(candidate.id)!;
  }

  /**
   * Worker signals it has started executing. Fence must match, and for an
   * approval-gated task the payload must still match the digest the Founder
   * approved — a mutation between claim and start invalidates the approval.
   * The approval's time-box is also re-validated here (issue #71): an
   * approval that was valid (and consumed) at claim can expire before the
   * worker actually starts; execution never proceeds on an expired approval —
   * the claim is released and the task returns to needs_approval for a fresh
   * Founder decision. Consumption is not merely expected here — it is
   * VERIFIED (issue #77): the approval must have been consumed by exactly
   * this claim (same worker, same fencing token, same per-claim nonce as the
   * task row), so a consumed approval reattached to a forced assigned state
   * or a different claim, or an approval never consumed through the claim
   * path at all, is rejected as hostile.
   */
  start(taskId: string, workerId: string, fence: number): OperatorTask {
    this.#assertFence(taskId, workerId, fence);
    const task = this.get(taskId)!;
    // Re-checked here as well as at claim: a task forced into `assigned` never
    // passed through claim's check, and provider binding is an execution
    // authority, not a routing hint.
    this.#assertProviderBinding(task, workerId);
    const cap = this.capabilities.get(task.capabilityId);
    if (cap && approvalRequired(cap, this.#policyCtx)) {
      const approval = this.#getApprovalRecord(task.approvalId);
      if (!approval?.actionDigest || approval.actionDigest !== taskActionDigest(task)) {
        this.#rejectAtExecutionBoundary(task, 'approval_digest_mismatch');
        throw new Error(
          `Task ${taskId}: action changed after Founder approval; approval invalidated`,
        );
      }
      if (approval.decision !== 'approved') {
        this.#rejectAtExecutionBoundary(task, 'approval_not_approved');
        throw new Error(
          `Task ${taskId}: approval record is not an approval; fresh Founder approval required`,
        );
      }
      const bindingRejection = validateApprovalClaimBinding(approval, {
        taskId: task.id,
        workerId,
        fence: task.fence,
        claimNonce: task.claimNonce,
      });
      if (bindingRejection) {
        this.#rejectAtExecutionBoundary(task, bindingRejection);
        throw new Error(
          `Task ${taskId}: approval was not consumed by this claim (worker/task/fence/nonce binding mismatch); execution rejected`,
        );
      }
      if (approvalExpiredAt(approval)) {
        this.#rejectAtExecutionBoundary(task, 'approval_expired');
        throw new Error(
          `Task ${taskId}: Founder approval expired before execution start; fresh approval required`,
        );
      }
    }
    return this.#transition(taskId, 'running', workerId, 'Execution started');
  }

  /** Extend the lease mid-execution. Fence must match. */
  heartbeat(taskId: string, workerId: string, fence: number, leaseMs = 5 * 60_000): void {
    this.#assertFence(taskId, workerId, fence);
    this.#db
      .prepare(`UPDATE op_tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + leaseMs).toISOString(), nowIso(), taskId);
  }

  /**
   * Worker reports its execution result (issue #53 correction B).
   *
   * A worker can NEVER self-complete a review-required action: for any
   * side-effect capability the result lands in the review-gated path
   * (reviewState 'pending', status stays `running`, lease released) and only
   * an independent reviewer decision — reviewPass()/reviewFail() by an actor
   * other than the executing/submitting/requesting worker — can reach the
   * terminal `completed` status. Only read-only, no-side-effect capabilities
   * complete directly.
   */
  complete(
    taskId: string,
    workerId: string,
    fence: number,
    result: Record<string, unknown>,
    evidenceRefs: string[] = [],
  ): OperatorTask {
    this.#assertFence(taskId, workerId, fence);
    assertNoSecretLikeContent(result);
    const task = this.get(taskId)!;
    const cap = this.capabilities.get(task.capabilityId);
    if (cap?.sideEffect) {
      if (task.status !== 'running') {
        throw new Error(`Task ${taskId} is not running (status: ${task.status})`);
      }
      this.#db.prepare(`UPDATE op_tasks SET result = ? WHERE id = ?`).run(JSON.stringify(result), taskId);
      this.#db
        .prepare(
          `UPDATE op_tasks SET review_state = 'pending', submitted_by = ?, submitted_at = ?,
             lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(workerId, nowIso(), nowIso(), taskId);
      this.#recordEvent(taskId, 'running', workerId, 'Result submitted; awaiting independent review');
      this.evidence.append({
        taskId,
        actor: workerId,
        kind: 'execution_result_submitted_for_review',
        payload: { result, refs: evidenceRefs },
      });
      return this.get(taskId)!;
    }
    this.#db.prepare(`UPDATE op_tasks SET result = ? WHERE id = ?`).run(JSON.stringify(result), taskId);
    this.evidence.append({
      taskId,
      actor: workerId,
      kind: 'execution_result',
      payload: { result, refs: evidenceRefs },
    });
    return this.#transition(taskId, 'completed', workerId, 'Execution completed');
  }

  /**
   * Independent reviewer passes a submitted side-effect result. This is the
   * ONLY path by which a review-required task reaches terminal `completed`.
   * The reviewer must be independent: not the executing worker, not the
   * submitter, not the task's requester, and not 'system'.
   */
  reviewPass(taskId: string, reviewerId: string, note = ''): OperatorTask {
    this.#requirePendingReview(taskId, reviewerId);
    this.evidence.append({
      taskId,
      actor: reviewerId,
      kind: 'review_passed',
      payload: { note },
    });
    this.#db.prepare(`UPDATE op_tasks SET review_state = 'passed' WHERE id = ?`).run(taskId);
    this.#transition(taskId, 'review_passed', reviewerId, `Independent review passed${note ? `: ${note}` : ''}`);
    return this.#transition(taskId, 'completed', reviewerId, 'Completed by independent reviewer decision');
  }

  /** Independent reviewer rejects a submitted result; the task goes to review_failed for rework. */
  reviewFail(taskId: string, reviewerId: string, reason: string): OperatorTask {
    this.#requirePendingReview(taskId, reviewerId);
    this.evidence.append({
      taskId,
      actor: reviewerId,
      kind: 'review_failed',
      payload: { reason },
    });
    this.#db.prepare(`UPDATE op_tasks SET review_state = 'failed' WHERE id = ?`).run(taskId);
    return this.#transition(taskId, 'review_failed', reviewerId, `Independent review failed: ${reason}`);
  }

  fail(taskId: string, workerId: string, fence: number, reason: string): OperatorTask {
    this.#assertFence(taskId, workerId, fence);
    this.evidence.append({ taskId, actor: workerId, kind: 'execution_failed', payload: { reason } });
    return this.#transition(taskId, 'review_failed', workerId, `Execution failed: ${reason}`);
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
    const rows = this.#db
      .prepare(
        `SELECT t.id, t.status, c.side_effect AS side_effect
         FROM op_tasks t JOIN op_capabilities c ON c.id = t.capability_id
         WHERE t.status IN ('assigned', 'running') AND t.review_state != 'pending'
           AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at < ?`,
      )
      .all(now) as { id: string; status: ActivityStatus; side_effect: number }[];
    const requeued: string[] = [];
    const outcomeUnknown: string[] = [];
    for (const row of rows) {
      if (row.side_effect && row.status === 'running') {
        this.#transition(row.id, 'outcome_unknown', 'system', 'Lease expired mid-execution of a side-effect task');
        outcomeUnknown.push(row.id);
      } else {
        this.#transition(row.id, 'queued', 'system', 'Lease expired; task re-queued');
        this.#db
          .prepare(`UPDATE op_tasks SET claimed_by = NULL, lease_expires_at = NULL, claim_nonce = NULL WHERE id = ?`)
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
    if (by === task.claimedBy || by === task.createdBy || by === 'system') {
      throw new Error(
        `Actor ${by} cannot reconcile task ${taskId}: reconciliation requires an independent reviewer`,
      );
    }
    this.evidence.append({ taskId, actor: by, kind: 'reconciliation', payload: { decision, note } });
    if (decision === 'confirmed_done') {
      return this.#transition(taskId, 'completed', by, `Reconciled done: ${note}`);
    }
    if (decision === 'confirmed_failed') {
      return this.#transition(taskId, 'review_failed', by, `Reconciled failed: ${note}`);
    }
    const cap = this.capabilities.get(task.capabilityId)!;
    if (!cap.idempotent) {
      throw new Error(
        `Capability ${cap.id} is not idempotent; cannot safely re-queue an uncertain execution`,
      );
    }
    const requeued = this.#transition(taskId, 'queued', by, `Reconciled not-executed: ${note}`);
    this.#db
      .prepare(`UPDATE op_tasks SET claimed_by = NULL, lease_expires_at = NULL, claim_nonce = NULL WHERE id = ?`)
      .run(taskId);
    return this.get(taskId) ?? requeued;
  }

  // ---- reads / internals ----

  get(id: string): OperatorTask | null {
    const row = this.#db.prepare(`SELECT * FROM op_tasks WHERE id = ?`).get(id) as
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
      claimNonce: (row.claim_nonce as string | null) ?? null,
      approvalId: (row.approval_id as string | null) ?? null,
      reviewState: (row.review_state as ReviewState | null) ?? 'none',
      submittedBy: (row.submitted_by as string | null) ?? null,
      submittedAt: (row.submitted_at as string | null) ?? null,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      result: row.result ? JSON.parse(row.result as string) : null,
      blockReason: (row.block_reason as string | null) ?? null,
    };
  }

  listByStatus(status: ActivityStatus): OperatorTask[] {
    const rows = this.#db
      .prepare(`SELECT id FROM op_tasks WHERE status = ? ORDER BY created_at`)
      .all(status) as { id: string }[];
    return rows.map((r) => this.get(r.id)!);
  }

  /** Read a hq_approvals row in the shape validateApproval()/validateApprovalClaimBinding() need. */
  #getApprovalRecord(approvalId: string | null): {
    decision: string;
    actionDigest: string | null;
    expiresAt: string | null;
    consumedAt: string | null;
    consumedBy: string | null;
    consumedTaskId: string | null;
    consumedFence: number | null;
    consumedClaimNonce: string | null;
  } | null {
    if (!approvalId) return null;
    const row = this.#db
      .prepare(
        `SELECT decision, action_digest, expires_at, consumed_at, consumed_by, consumed_task_id, consumed_fence, consumed_claim_nonce
         FROM hq_approvals WHERE id = ?`,
      )
      .get(approvalId) as
      | {
          decision: string;
          action_digest: string | null;
          expires_at: string | null;
          consumed_at: string | null;
          consumed_by: string | null;
          consumed_task_id: string | null;
          consumed_fence: number | null;
          consumed_claim_nonce: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      decision: row.decision,
      actionDigest: row.action_digest,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      consumedBy: row.consumed_by,
      consumedTaskId: row.consumed_task_id,
      consumedFence: row.consumed_fence,
      consumedClaimNonce: row.consumed_claim_nonce,
    };
  }

  #validateTaskApproval(task: OperatorTask): ApprovalRejection | null {
    return validateApproval(this.#getApprovalRecord(task.approvalId), taskActionDigest(task));
  }

  /**
   * An approval-gated task failed approval validation at the execution
   * boundary. A digest mismatch means the action was mutated after approval,
   * and a claim-binding mismatch (issue #77) means a consumed approval was
   * reattached to a forced state or a different claim — both are hostile or
   * a bug, so the task is blocked for investigation. Every other rejection
   * (missing/expired/consumed/undecided approval) sends the task back to
   * needs_approval for a fresh Founder decision. The stale approval binding
   * is cleared either way; approvals themselves are immutable records.
   */
  #rejectAtExecutionBoundary(task: OperatorTask, rejection: ApprovalRejection): void {
    this.evidence.append({
      taskId: task.id,
      actor: 'system',
      kind: 'approval_rejected_at_execution',
      payload: { rejection, approvalId: task.approvalId },
    });
    this.#db.prepare(`UPDATE op_tasks SET approval_id = NULL WHERE id = ?`).run(task.id);
    if (rejection === 'approval_digest_mismatch' || rejection === 'approval_claim_binding_mismatch') {
      const reason =
        rejection === 'approval_digest_mismatch'
          ? 'Approval invalidated: action payload/capability changed after Founder approval'
          : 'Approval invalidated: approval was not consumed by the current legitimate claim (reattach/replay rejected)';
      if (task.status !== 'blocked') {
        this.#transition(task.id, 'blocked', 'system', reason);
      }
      this.#db.prepare(`UPDATE op_tasks SET block_reason = ? WHERE id = ?`).run(reason, task.id);
      return;
    }
    if (task.status !== 'needs_approval') {
      this.#transition(task.id, 'needs_approval', 'system', `Fresh Founder approval required (${rejection})`);
    }
    // A claim voided at the execution boundary (issue #71: e.g. expiry
    // between claim and start) releases the worker and its lease; the stale
    // fence can no longer act on the task. No-op for unclaimed tasks.
    this.#db
      .prepare(`UPDATE op_tasks SET claimed_by = NULL, lease_expires_at = NULL, claim_nonce = NULL WHERE id = ?`)
      .run(task.id);
  }

  /** Shared guard for reviewPass/reviewFail: pending review + independent reviewer. */
  #requirePendingReview(taskId: string, reviewerId: string): OperatorTask {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.reviewState !== 'pending') {
      throw new Error(`Task ${taskId} has no result awaiting review (reviewState: ${task.reviewState})`);
    }
    if (
      reviewerId === 'system' ||
      reviewerId === task.claimedBy ||
      reviewerId === task.submittedBy ||
      reviewerId === task.createdBy
    ) {
      throw new Error(
        `Actor ${reviewerId} cannot review task ${taskId}: the executing/submitting/requesting worker may not review its own action (builder != final reviewer)`,
      );
    }
    return task;
  }

  #assertFence(taskId: string, workerId: string, fence: number): void {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.claimedBy !== workerId || task.fence !== fence) {
      throw new Error(
        `Stale fence for task ${taskId}: worker ${workerId} fence ${fence} vs current ${task.claimedBy}/${task.fence}`,
      );
    }
  }

  #transition(taskId: string, to: ActivityStatus, actor: string, summary: string): OperatorTask {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    assertTransition(task.status, to);
    this.#db
      .prepare(`UPDATE op_tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(to, nowIso(), taskId);
    this.#recordEvent(taskId, to, actor, summary);
    return this.get(taskId)!;
  }

  #recordEvent(taskId: string, status: ActivityStatus, actor: string, summary: string): void {
    this.#db
      .prepare(
        `INSERT INTO hq_events (id, at, subject_kind, subject_id, status, actor, summary)
         VALUES (?, ?, 'task', ?, ?, ?, ?)`,
      )
      .run(uuid(), nowIso(), taskId, status, actor, summary);
  }
}
