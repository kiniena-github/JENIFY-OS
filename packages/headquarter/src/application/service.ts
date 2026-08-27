/**
 * Headquarter → Universal Operator application/service layer (issue #139,
 * HQ lane F; mission originally specified in issue #122).
 *
 * WHAT THIS IS
 * ------------
 * The typed seam a Founder-facing Headquarter surface calls instead of
 * touching the Operator (or its SQLite rows) directly. It covers the whole
 * task lifecycle — create / classify / route / assign / claim / start /
 * review / complete / reconcile — plus the Founder Approval Center actions,
 * the kill switch, and worker disable/replacement.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT a second control plane. Every safety decision is delegated to the
 * canonical Operator in `../operator/`:
 *
 *   - capability existence / enablement / risk class  → CapabilityRegistry
 *   - allow / deny / needs-approval                   → policy.evaluatePolicy
 *   - atomic claim, fencing token, claim nonce        → OperatorQueue.claim
 *   - approval digest / expiry / single-use / binding → operator/approvals.ts
 *   - independent review, self-review refusal         → OperatorQueue.review*
 *   - outcome_unknown, reconciliation                 → OperatorQueue.reconcile
 *   - idempotency for side-effect capabilities        → OperatorQueue.enqueue
 *
 * This file re-implements none of them and weakens none of them. Where it
 * adds a check, that check can only ever REFUSE (deny-only), never admit
 * something the Operator refused. Every gate below is written so that
 * deleting it would make the system more permissive, not less — which is the
 * property that makes it safe to layer on top.
 *
 * SECURITY ASSUMPTIONS
 * --------------------
 * 1. Actor identity (`actor` / `workerId` / `decidedBy`) is authenticated by
 *    the caller before it reaches this layer. This layer authorises, it does
 *    not authenticate.
 * 2. The specialist directory and capability registry are Founder-curated,
 *    code-reviewed data. A worker's own runtime claims about itself are never
 *    an input to any decision here.
 * 3. Free text (chat/room bodies, notes, titles) is inert data. There is no
 *    code path anywhere in this layer from message text to a capability id,
 *    a payload, a risk class, or an approval. See `rooms.ts`.
 * 4. Credentials never enter the control plane at all; the secret-like
 *    content guard is a backstop, not the boundary.
 */

import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import type { HeadquarterStore } from '../store/headquarter.js';
import type { ActivityStatus } from '../contracts/events.js';
import type { Capability } from '../operator/capabilities.js';
import { evaluatePolicy, approvalRequired, type PolicyContext } from '../operator/policy.js';
import { taskActionDigest } from '../operator/approvals.js';
import type { OperatorQueue, OperatorTask, ReconcileDecision } from '../operator/queue.js';
import { ensureApplicationTables } from './schema.js';
import {
  classifyOperatorError,
  opsErr,
  opsOk,
  type OpsResult,
} from './errors.js';
import {
  allGates,
  defaultWorkerAssignability,
  directoryNominationSource,
  type WorkerAssignabilityGate,
  type WorkerNominationSource,
} from './seams.js';

/** Statuses in which a task is held by a worker and cannot simply vanish. */
export const IN_FLIGHT_STATUSES: readonly ActivityStatus[] = ['assigned', 'running'];

export interface TaskMeta {
  taskId: string;
  project: string | null;
  title: string | null;
  originThreadId: string | null;
  assignedWorkerId: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  classifiedBy: string | null;
  classifiedAt: string | null;
}

export interface CreateTaskInput {
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  /** Worker/actor requesting the action. Its allow-list is read from the directory. */
  requestedBy: string;
  /** Routing metadata only — never an input to any policy decision. */
  project?: string;
  title?: string;
  originThreadId?: string;
}

export interface CreatedTask {
  task: OperatorTask;
  deduplicated: boolean;
  meta: TaskMeta;
}

export interface ClassifyInput {
  project?: string;
  title?: string;
}

/** One candidate for a task, after the Operator's own policy decision. */
export interface NominatedWorker {
  workerId: string;
  source: string;
  /** 'allow' or 'needs_approval' — both are claimable; approval gates at the boundary. */
  policyOutcome: 'allow' | 'needs_approval';
}

export interface RejectedWorker {
  workerId: string;
  source: string;
  reason: string;
}

export interface RoutingProposal {
  taskId: string;
  capabilityId: string;
  nominated: NominatedWorker[];
  rejected: RejectedWorker[];
}

export interface FounderDecisionInput {
  taskId: string;
  /**
   * The action digest the Approval Center DISPLAYED to the Founder. Required
   * on approve: if the task's canonical digest has moved on since it was
   * rendered, the decision is refused before any approval row is written.
   */
  actionDigest: string;
  decidedBy: string;
  note?: string;
  ttlMs?: number;
}

export interface WorkerRetirement {
  workerId: string;
  /** In-flight tasks that now require handover or reconciliation. */
  handoverRequired: { taskId: string; status: ActivityStatus; capabilityId: string }[];
}

export interface HeadquarterOperationsConfig {
  db: HqDatabase;
  queue: OperatorQueue;
  store: HeadquarterStore;
  /** Standing Founder pre-approvals. Must match the queue's own policy context. */
  policyContext?: PolicyContext;
  /** Deny-only assignability gates (lane C/D adapters plug in here). */
  assignability?: WorkerAssignabilityGate;
  /** Advisory nomination sources (organization/registry lanes plug in here). */
  nominationSource?: WorkerNominationSource;
  clock?: () => string;
}

export class HeadquarterOperationsService {
  private readonly db: HqDatabase;
  readonly queue: OperatorQueue;
  readonly store: HeadquarterStore;
  private readonly policyContext: PolicyContext;
  private readonly assignability: WorkerAssignabilityGate;
  private readonly nominationSource: WorkerNominationSource;
  private readonly clock: () => string;

  constructor(config: HeadquarterOperationsConfig) {
    this.db = config.db;
    this.queue = config.queue;
    this.store = config.store;
    this.policyContext = config.policyContext ?? {};
    this.clock = config.clock ?? nowIso;
    ensureApplicationTables(this.db);
    // Composed so that adding a gate can only ever remove permission.
    this.assignability = config.assignability
      ? allGates(defaultWorkerAssignability(this.store), config.assignability)
      : defaultWorkerAssignability(this.store);
    this.nominationSource = config.nominationSource ?? directoryNominationSource(this.store);
  }

  // ---------------------------------------------------------------- create --

  /**
   * Create a task. The capability id and payload are STRUCTURED INPUTS from
   * the caller's typed form — never parsed out of prose. Allow/deny/approval
   * is decided entirely by `OperatorQueue.enqueue` → `evaluatePolicy`, using
   * the requester's directory allow-list; `project`/`title` are labels and
   * reach no decision.
   *
   * The requester must have a specialist-directory entry: an actor with no
   * entry has no allow-list and is therefore denied by default. A disabled
   * worker is refused here too — the issue only requires that it cannot
   * CLAIM, but letting it keep filing work would leave a retired identity
   * driving the queue, so the request side is closed as well.
   */
  createTask(input: CreateTaskInput): OpsResult<CreatedTask> {
    if (!input.capabilityId?.trim()) {
      return opsErr('invalid_input', 'capabilityId is required');
    }
    if (!input.requestedBy?.trim()) {
      return opsErr('invalid_input', 'requestedBy is required');
    }
    const capability = this.queue.capabilities.get(input.capabilityId);
    if (!capability) {
      return opsErr('not_found', `Unknown capability: ${input.capabilityId} (deny by default)`);
    }
    const requester = this.store.getSpecialist(input.requestedBy);
    if (requester) {
      const assignable = this.assignability.isAssignable(input.requestedBy);
      if (!assignable.assignable) {
        return opsErr('worker_not_assignable', `Worker ${input.requestedBy} is not assignable`, {
          reason: assignable.reason,
        });
      }
    }
    // Deny by default: an actor with no directory entry has no allow-list,
    // so `enqueue` refuses it on the least-privilege check below.
    const allowedCapabilities = requester?.allowedCapabilities ?? [];

    let result;
    try {
      result = this.queue.enqueue({
        capabilityId: input.capabilityId,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        requestedBy: { workerId: input.requestedBy, allowedCapabilities },
      });
    } catch (error) {
      return { ok: false, error: classifyOperatorError(error) };
    }
    if (!result.accepted) {
      return opsErr('policy_denied', result.reason, {
        capabilityId: input.capabilityId,
        requestedBy: input.requestedBy,
      });
    }

    // A deduplicated request must not relabel the task it collided with: the
    // second caller's (possibly empty) project/title would otherwise wipe the
    // metadata the first one — or a later `classify()` — established.
    const meta = result.deduplicated
      ? this.readMeta(result.task.id)
      : this.writeMeta(result.task.id, {
          project: input.project ?? null,
          title: input.title ?? null,
          originThreadId: input.originThreadId ?? null,
        });
    return opsOk({ task: result.task, deduplicated: result.deduplicated, meta });
  }

  // -------------------------------------------------------------- classify --

  /**
   * Classification is LABELLING ONLY. It cannot touch the capability, the
   * payload, the idempotency key, the risk class, or the status — i.e. it can
   * never change the approval digest, so a classification edit can never
   * invalidate (or launder) a Founder approval. Recorded as a canonical
   * annotation event (status: null) so the history stays complete without
   * inventing a state change.
   */
  classify(taskId: string, input: ClassifyInput, actor: string): OpsResult<TaskMeta> {
    const task = this.queue.get(taskId);
    if (!task) return opsErr('not_found', `Unknown task: ${taskId}`);
    if (!actor?.trim()) return opsErr('invalid_input', 'actor is required');

    const digestBefore = taskActionDigest(task);
    const current = this.readMeta(taskId);
    const meta = this.writeMeta(taskId, {
      project: input.project ?? current.project,
      title: input.title ?? current.title,
      classifiedBy: actor,
      classifiedAt: this.clock(),
    });
    // Invariant, asserted rather than assumed: classification never moves the
    // digest the Founder's approval is bound to.
    const digestAfter = taskActionDigest(this.queue.get(taskId)!);
    if (digestBefore !== digestAfter) {
      throw new Error(
        `Invariant violated: classification changed the approval digest of task ${taskId}`,
      );
    }
    this.annotate(taskId, actor, 'Task classified', {
      project: meta.project,
      title: meta.title,
    });
    return opsOk(meta);
  }

  // ----------------------------------------------------------------- route --

  /**
   * Nominate candidate workers for a task.
   *
   * The nomination source (organization membership, AI member registry, …)
   * only proposes. Every proposal is then re-derived through the Operator's
   * own decision — capability registry entry + the worker's DIRECTORY
   * allow-list + assignability — and anything the Operator refuses is
   * reported in `rejected`, never in `nominated`. A nomination therefore
   * cannot widen what a worker may do; the Operator stays the final authority
   * on capability and risk.
   *
   * Pure read: this makes no queue writes and no state change.
   */
  nominateWorkers(taskId: string): OpsResult<RoutingProposal> {
    const task = this.queue.get(taskId);
    if (!task) return opsErr('not_found', `Unknown task: ${taskId}`);
    const capability = this.queue.capabilities.get(task.capabilityId);
    if (!capability) {
      return opsErr('not_found', `Unknown capability: ${task.capabilityId} (deny by default)`);
    }

    const nominated: NominatedWorker[] = [];
    const rejected: RejectedWorker[] = [];
    for (const nomination of this.nominationSource.nominate(task.capabilityId)) {
      const verdict = this.operatorVerdict(nomination.workerId, capability);
      if (verdict.ok) {
        nominated.push({
          workerId: nomination.workerId,
          source: nomination.source,
          policyOutcome: verdict.data,
        });
      } else {
        rejected.push({
          workerId: nomination.workerId,
          source: nomination.source,
          reason: verdict.error.message,
        });
      }
    }
    return opsOk({ taskId, capabilityId: task.capabilityId, nominated, rejected });
  }

  /**
   * Record the intended owner of a task.
   *
   * ADVISORY BY DESIGN, DENY-ONLY IN EFFECT. Assignment does not reserve a
   * row, hand out a lease, or pre-consume an approval — the atomic claim in
   * `OperatorQueue.claim` remains the one place a task is actually taken, so
   * assignment cannot weaken claim atomicity. What it does do is let
   * `claimNext` REFUSE a worker the Founder did not intend (see
   * `claimNext`); it can never let one through that the Operator denied.
   */
  assign(taskId: string, workerId: string, actor: string): OpsResult<TaskMeta> {
    const task = this.queue.get(taskId);
    if (!task) return opsErr('not_found', `Unknown task: ${taskId}`);
    const capability = this.queue.capabilities.get(task.capabilityId);
    if (!capability) {
      return opsErr('not_found', `Unknown capability: ${task.capabilityId} (deny by default)`);
    }
    // Refuse to record an intent the Operator would refuse anyway, so the
    // Founder never sees an "assigned" worker that can never claim.
    const verdict = this.operatorVerdict(workerId, capability);
    if (!verdict.ok) return { ok: false, error: verdict.error };

    const meta = this.writeMeta(taskId, {
      assignedWorkerId: workerId,
      assignedBy: actor,
      assignedAt: this.clock(),
    });
    this.annotate(taskId, actor, `Intended owner set to ${workerId}`, { assignedWorkerId: workerId });
    return opsOk(meta);
  }

  // ----------------------------------------------------------------- claim --

  /**
   * Claim the next queued task for a capability on behalf of a worker.
   *
   * Pre-flight gates (ALL deny-only; each can refuse, none can admit):
   *   1. capability must exist and be enabled;
   *   2. kill switch must not be engaged globally or for the capability;
   *   3. the worker must be assignable — an inactive/disabled/replaced worker
   *      claims nothing, which is what makes worker replacement safe;
   *   4. the worker's DIRECTORY allow-list must include the capability;
   *   5. if the next queued task names a different intended owner who is
   *      still assignable, this worker is refused.
   *
   * Only then is the real claim delegated to `OperatorQueue.claim`, which
   * still performs the atomic conditional UPDATE, mints the fencing token and
   * claim nonce, and consumes the single-use approval with its full binding.
   */
  claimNext(
    workerId: string,
    capabilityId: string,
    leaseMs?: number,
  ): OpsResult<OperatorTask> {
    const capability = this.queue.capabilities.get(capabilityId);
    if (!capability) {
      return opsErr('not_found', `Unknown capability: ${capabilityId} (deny by default)`);
    }
    if (!capability.enabled) {
      return opsErr('capability_disabled', `Capability ${capabilityId} is disabled`);
    }
    if (this.queue.killSwitchEngaged(capabilityId)) {
      return opsErr('kill_switch_engaged', `Kill switch engaged; no new claims for ${capabilityId}`, {
        capabilityId,
      });
    }
    const verdict = this.operatorVerdict(workerId, capability);
    if (!verdict.ok) return { ok: false, error: verdict.error };

    const candidate = this.nextQueuedTaskId(capabilityId);
    if (!candidate) {
      return opsErr('nothing_claimable', `No queued task for ${capabilityId}`);
    }
    const reservation = this.readMeta(candidate).assignedWorkerId;
    if (reservation && reservation !== workerId && this.assignability.isAssignable(reservation).assignable) {
      return opsErr(
        'reserved_for_other_worker',
        `Task ${candidate} is intended for ${reservation}`,
        { taskId: candidate, assignedWorkerId: reservation },
      );
    }

    let claimed: OperatorTask | null;
    try {
      claimed = leaseMs === undefined
        ? this.queue.claim(workerId, capabilityId)
        : this.queue.claim(workerId, capabilityId, leaseMs);
    } catch (error) {
      return { ok: false, error: classifyOperatorError(error) };
    }
    if (!claimed) {
      // The queue refuses silently by design. Re-read the candidate to tell
      // the Founder WHY: an approval rejected at the execution boundary moves
      // the task to needs_approval/blocked, otherwise we simply lost a race.
      const after = this.queue.get(candidate);
      if (after && (after.status === 'needs_approval' || after.status === 'blocked')) {
        return opsErr('approval_rejected', `Approval rejected at the execution boundary`, {
          taskId: candidate,
          status: after.status,
          blockReason: after.blockReason,
        });
      }
      return opsErr('nothing_claimable', `No claimable task for ${capabilityId}`);
    }

    // The atomic claim may legitimately have landed on a different row than
    // the one we pre-checked (another worker took ours first). Surface the
    // divergence for the Founder rather than silently reversing a claim that
    // has already consumed a single-use approval.
    const intended = this.readMeta(claimed.id).assignedWorkerId;
    if (intended && intended !== workerId) {
      this.annotate(
        claimed.id,
        workerId,
        `Claimed by ${workerId} although intended for ${intended}`,
        { claimedBy: workerId, intendedOwner: intended },
      );
    }
    return opsOk(claimed);
  }

  // ------------------------------------------------------------- execution --

  /** Worker signals execution start. Delegates every approval re-check to the queue. */
  start(taskId: string, workerId: string, fence: number): OpsResult<OperatorTask> {
    return this.delegate(() => this.queue.start(taskId, workerId, fence));
  }

  /** Extend a lease mid-execution. Fence must match. */
  heartbeat(taskId: string, workerId: string, fence: number, leaseMs?: number): OpsResult<true> {
    return this.delegate(() => {
      if (leaseMs === undefined) this.queue.heartbeat(taskId, workerId, fence);
      else this.queue.heartbeat(taskId, workerId, fence, leaseMs);
      return true as const;
    });
  }

  /**
   * Worker submits its result. For a side-effect capability the queue holds
   * it in the review-gated path — a side-effect worker can never reach
   * `completed` from here, no matter what this layer does.
   */
  submitResult(
    taskId: string,
    workerId: string,
    fence: number,
    result: Record<string, unknown>,
    evidenceRefs: string[] = [],
  ): OpsResult<OperatorTask> {
    return this.delegate(() => this.queue.complete(taskId, workerId, fence, result, evidenceRefs));
  }

  /** Worker reports failure. */
  reportFailure(taskId: string, workerId: string, fence: number, reason: string): OpsResult<OperatorTask> {
    return this.delegate(() => this.queue.fail(taskId, workerId, fence, reason));
  }

  /**
   * Independent review decision. Reviewer independence (not the executor, not
   * the submitter, not the requester, not 'system') is enforced by the queue;
   * this layer adds no override and offers no bypass.
   */
  review(
    taskId: string,
    reviewerId: string,
    decision: 'pass' | 'fail',
    note = '',
  ): OpsResult<OperatorTask> {
    if (decision === 'fail' && !note.trim()) {
      return opsErr('invalid_input', 'A failed review requires a reason');
    }
    return this.delegate(() =>
      decision === 'pass'
        ? this.queue.reviewPass(taskId, reviewerId, note)
        : this.queue.reviewFail(taskId, reviewerId, note),
    );
  }

  /** Resolve an outcome_unknown task after a human checked the real world. */
  reconcile(
    taskId: string,
    decision: ReconcileDecision,
    by: string,
    note: string,
  ): OpsResult<OperatorTask> {
    if (!note.trim()) return opsErr('invalid_input', 'Reconciliation requires a note');
    return this.delegate(() => this.queue.reconcile(taskId, decision, by, note));
  }

  /** Sweep expired leases; side-effect tasks become outcome_unknown, never a silent retry. */
  sweepLeases(): { requeued: string[]; outcomeUnknown: string[] } {
    return this.queue.sweepExpiredLeases();
  }

  // ------------------------------------------------- Founder Approval Center --

  /**
   * Approve the EXACT action the Founder was shown.
   *
   * `actionDigest` is the digest the Approval Center rendered. If the task's
   * current canonical digest differs — payload edited, capability swapped,
   * idempotency key changed — the decision is refused HERE, before any
   * approval row exists, so a mutated action can never acquire an approval to
   * replay later. The queue's own claim/start boundary re-validates the
   * digest, expiry, single-use nonce and claim binding independently; this is
   * an additional gate at the UI boundary, not a replacement for it.
   */
  founderApprove(input: FounderDecisionInput): OpsResult<OperatorTask> {
    const task = this.queue.get(input.taskId);
    if (!task) return opsErr('not_found', `Unknown task: ${input.taskId}`);
    if (!input.actionDigest?.trim()) {
      return opsErr('invalid_input', 'actionDigest of the displayed action is required to approve');
    }
    if (!input.decidedBy?.trim()) return opsErr('invalid_input', 'decidedBy is required');
    const current = taskActionDigest(task);
    if (current !== input.actionDigest) {
      this.annotate(task.id, input.decidedBy, 'Approval refused: action changed since it was displayed', {
        displayedDigest: input.actionDigest,
        currentDigest: current,
      });
      this.queue.evidence.append({
        taskId: task.id,
        actor: input.decidedBy,
        kind: 'approval_refused_action_changed',
        payload: { displayedDigest: input.actionDigest, currentDigest: current },
      });
      return opsErr(
        'action_changed_since_display',
        `Task ${task.id} changed after it was shown for approval; re-review the current action`,
        { displayedDigest: input.actionDigest, currentDigest: current },
      );
    }
    return this.delegate(() =>
      this.queue.approve(input.taskId, input.decidedBy, { ttlMs: input.ttlMs, note: input.note }),
    );
  }

  /** Deny an action. A denial is always safe, but still requires a reason. */
  founderDeny(taskId: string, reason: string, decidedBy: string): OpsResult<OperatorTask> {
    if (!reason?.trim()) return opsErr('invalid_input', 'A denial requires a reason');
    if (!decidedBy?.trim()) return opsErr('invalid_input', 'decidedBy is required');
    return this.delegate(() => this.queue.deny(taskId, reason, decidedBy));
  }

  /** The digest a UI must echo back when the Founder decides. */
  displayDigest(taskId: string): OpsResult<string> {
    const task = this.queue.get(taskId);
    if (!task) return opsErr('not_found', `Unknown task: ${taskId}`);
    return opsOk(taskActionDigest(task));
  }

  // ----------------------------------------------------------- kill switch --

  engageKillSwitch(scope: string, by: string, reason: string): OpsResult<true> {
    if (!reason?.trim()) return opsErr('invalid_input', 'Engaging the kill switch requires a reason');
    this.queue.engageKillSwitch(scope, by, reason);
    return opsOk(true as const);
  }

  releaseKillSwitch(scope: string, by: string): OpsResult<true> {
    this.queue.releaseKillSwitch(scope, by);
    return opsOk(true as const);
  }

  // ------------------------------------------------ worker disable/replace --

  /**
   * Disable a worker.
   *
   * From this moment the worker claims nothing new (gate 3 in `claimNext`).
   * Work it already holds is NOT force-released: releasing a claim would
   * either burn a single-use approval or hand a side-effect task to a second
   * worker while the first may still be executing it. Instead every in-flight
   * task is annotated in canonical history and returned as
   * `handoverRequired`, and it resolves through the canonical path only —
   * handover to a successor, or lease expiry → `outcome_unknown` → explicit
   * `reconcile`. Never a silent retry.
   */
  disableWorker(workerId: string, reason: string, by: string): OpsResult<WorkerRetirement> {
    if (!reason?.trim()) return opsErr('invalid_input', 'Disabling a worker requires a reason');
    const descriptor = this.store.getSpecialist(workerId);
    if (!descriptor) return opsErr('not_found', `Unknown worker: ${workerId}`);

    this.store.upsertSpecialist({ ...descriptor, active: false });
    const handoverRequired = this.inFlightTasksFor(workerId);
    for (const item of handoverRequired) {
      this.annotate(
        item.taskId,
        by,
        `Owning worker ${workerId} disabled mid-flight; handover or reconciliation required`,
        { workerId, reason, status: item.status },
      );
    }
    this.queue.evidence.append({
      actor: by,
      kind: 'worker_disabled',
      payload: { workerId, reason, handoverRequired: handoverRequired.map((t) => t.taskId) },
    });
    this.store.appendEvent({
      subjectKind: 'worker',
      subjectId: workerId,
      status: null,
      actor: by,
      summary: `Worker disabled: ${reason}`,
      detail: { handoverRequired: handoverRequired.map((t) => t.taskId) },
    });
    return opsOk({ workerId, handoverRequired });
  }

  /**
   * Replace a worker with a successor.
   *
   * The successor must already exist in the directory with its OWN
   * Founder-curated allow-list: capabilities are deliberately NOT copied from
   * the outgoing worker, because replacement is an org event and must never
   * become a privilege transfer. In-flight work is handled exactly as in
   * `disableWorker` — surfaced for handover/reconciliation, never silently
   * reassigned.
   */
  replaceWorker(
    outgoingId: string,
    successorId: string,
    reason: string,
    by: string,
  ): OpsResult<WorkerRetirement & { successorId: string }> {
    const successor = this.store.getSpecialist(successorId);
    if (!successor) return opsErr('not_found', `Unknown successor worker: ${successorId}`);
    const successorAssignable = this.assignability.isAssignable(successorId);
    if (!successorAssignable.assignable) {
      return opsErr('worker_not_assignable', `Successor ${successorId} is not assignable`, {
        reason: successorAssignable.reason,
      });
    }
    const retirement = this.disableWorker(outgoingId, reason, by);
    if (!retirement.ok) return retirement;

    this.queue.evidence.append({
      actor: by,
      kind: 'worker_replaced',
      payload: {
        outgoingId,
        successorId,
        reason,
        handoverRequired: retirement.data.handoverRequired.map((t) => t.taskId),
        // Stated explicitly in the audit trail: no rights moved with the role.
        capabilitiesTransferred: false,
      },
    });
    return opsOk({ ...retirement.data, successorId });
  }

  // ------------------------------------------------------------------ reads --

  getTask(taskId: string): OperatorTask | null {
    return this.queue.get(taskId);
  }

  readMeta(taskId: string): TaskMeta {
    const row = this.db.prepare(`SELECT * FROM hq_task_meta WHERE task_id = ?`).get(taskId) as
      | Record<string, unknown>
      | undefined;
    return {
      taskId,
      project: (row?.project as string | null) ?? null,
      title: (row?.title as string | null) ?? null,
      originThreadId: (row?.origin_thread_id as string | null) ?? null,
      assignedWorkerId: (row?.assigned_worker_id as string | null) ?? null,
      assignedBy: (row?.assigned_by as string | null) ?? null,
      assignedAt: (row?.assigned_at as string | null) ?? null,
      classifiedBy: (row?.classified_by as string | null) ?? null,
      classifiedAt: (row?.classified_at as string | null) ?? null,
    };
  }

  /** In-flight (assigned/running) tasks currently held by a worker. */
  inFlightTasksFor(workerId: string): { taskId: string; status: ActivityStatus; capabilityId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, status, capability_id FROM op_tasks
         WHERE claimed_by = ? AND status IN (${IN_FLIGHT_STATUSES.map(() => '?').join(',')})
         ORDER BY created_at`,
      )
      .all(workerId, ...IN_FLIGHT_STATUSES) as {
      id: string;
      status: ActivityStatus;
      capability_id: string;
    }[];
    return rows.map((r) => ({ taskId: r.id, status: r.status, capabilityId: r.capability_id }));
  }

  // -------------------------------------------------------------- internals --

  /**
   * The Operator's verdict on "may this worker take this capability?".
   *
   * Derived ONLY from the capability registry entry, the worker's directory
   * allow-list, and the deny-only assignability gate — never from the task
   * payload, the nomination source, or anything the worker asserts.
   */
  private operatorVerdict(
    workerId: string,
    capability: Capability,
  ): OpsResult<'allow' | 'needs_approval'> {
    const assignable = this.assignability.isAssignable(workerId);
    if (!assignable.assignable) {
      return opsErr('worker_not_assignable', `Worker ${workerId} is not assignable`, {
        reason: assignable.reason,
        ...assignable.details,
      });
    }
    const descriptor = this.store.getSpecialist(workerId);
    if (!descriptor) {
      return opsErr('worker_not_assignable', `Worker ${workerId} is not in the specialist directory`);
    }
    const decision = evaluatePolicy(
      capability,
      { workerId, allowedCapabilities: descriptor.allowedCapabilities },
      this.policyContext,
    );
    if (decision.outcome === 'deny') {
      const code = descriptor.allowedCapabilities.includes(capability.id)
        ? 'capability_disabled'
        : 'capability_not_allowed';
      return opsErr(code, decision.reason, { workerId, capabilityId: capability.id });
    }
    return opsOk(decision.outcome === 'needs_approval' ? 'needs_approval' : 'allow');
  }

  /** Whether executing this capability needs a bound Founder approval. */
  approvalRequiredFor(capabilityId: string): boolean {
    const capability = this.queue.capabilities.get(capabilityId);
    return capability ? approvalRequired(capability, this.policyContext) : true;
  }

  private nextQueuedTaskId(capabilityId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM op_tasks WHERE capability_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1`,
      )
      .get(capabilityId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Append a canonical annotation event (status: null — history, not state). */
  private annotate(
    taskId: string,
    actor: string,
    summary: string,
    detail?: Record<string, unknown>,
    refs?: string[],
  ): void {
    this.store.appendEvent({
      subjectKind: 'task',
      subjectId: taskId,
      status: null,
      actor,
      summary,
      detail,
      refs,
    });
  }

  private writeMeta(
    taskId: string,
    patch: Partial<Omit<TaskMeta, 'taskId'>>,
  ): TaskMeta {
    const current = this.readMeta(taskId);
    const next: TaskMeta = { ...current, ...patch, taskId };
    this.db
      .prepare(
        `INSERT INTO hq_task_meta (task_id, project, title, origin_thread_id, assigned_worker_id,
           assigned_by, assigned_at, classified_by, classified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           project = excluded.project, title = excluded.title,
           origin_thread_id = excluded.origin_thread_id,
           assigned_worker_id = excluded.assigned_worker_id,
           assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at,
           classified_by = excluded.classified_by, classified_at = excluded.classified_at`,
      )
      .run(
        taskId,
        next.project,
        next.title,
        next.originThreadId,
        next.assignedWorkerId,
        next.assignedBy,
        next.assignedAt,
        next.classifiedBy,
        next.classifiedAt,
      );
    return next;
  }

  /** Run a canonical Operator call, converting its loud throws into typed results. */
  private delegate<T>(fn: () => T): OpsResult<T> {
    try {
      return opsOk(fn());
    } catch (error) {
      return { ok: false, error: classifyOperatorError(error) };
    }
  }
}

export function createHeadquarterOperations(
  config: HeadquarterOperationsConfig,
): HeadquarterOperationsService {
  return new HeadquarterOperationsService(config);
}
