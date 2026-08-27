/**
 * `HeadquarterOperations` — the typed application/service layer that makes
 * Headquarter operational over the EXISTING Universal Operator (HQ lane F,
 * issue #139, retry of #122).
 *
 * ## What this layer is
 *
 * One facade over the whole task lifecycle — create / classify / route /
 * assign / claim / start / review / complete / reconcile — plus the Founder
 * Approval Center actions and group-room mission intake. A UI binds to this
 * and to `console.ts`; it never reaches into `OperatorQueue` directly.
 *
 * ## What this layer is NOT
 *
 * It does not re-implement, relax, or route around a single canonical
 * Operator guarantee. Approval digest binding, time-box, single-use nonce,
 * claim/worker/fence/nonce binding, atomic fenced claim, idempotency,
 * independent review, `outcome_unknown`, the kill switch and deny-by-default
 * all stay exactly where they are, in `operator/*`. Everything here either
 * delegates to them or adds a STRICTER precondition on top. There is
 * deliberately no method that edits a task's capability or payload, no method
 * that clears a rejection, and no path that writes `op_tasks`/`hq_approvals`
 * columns behind the queue's back.
 *
 * ## The hardenings this lane adds
 *
 * 1. **Allow-lists come from a registry.** `OperatorQueue.enqueue()` takes
 *    `requestedBy.allowedCapabilities` from its caller. Here that argument is
 *    always filled from `WorkerDirectoryPort` (workers) or
 *    `originateCapabilities` (human principals) — a caller cannot hand in its
 *    own permissions.
 * 2. **Approvals are digest-echoed.** `approveTask()` requires the console to
 *    send back the exact action digest it displayed. If the action changed
 *    between render and click, the approval is refused before it is ever
 *    written, so a Founder can never approve something other than what was on
 *    screen.
 * 3. **Assignability is re-checked at claim and at start.** A worker disabled
 *    or replaced mid-flight cannot take new work, and cannot start work it had
 *    already claimed.
 * 4. **Every actor must positively BE someone.** Approve, deny and the kill
 *    switch need a registered, active human principal carrying approval
 *    authority; opening work needs a worker or a human with the capability
 *    granted; review and reconciliation need a known actor. Registered workers
 *    are still refused approval authority outright, and human principals can
 *    never claim or start work. See `principals.ts` — an earlier version of
 *    this file authorized Founder actions by elimination ("not a worker,
 *    therefore human"), which admitted every unknown string; authority is now
 *    positive and deny-by-default on both sides. All of this sits on top of —
 *    never instead of — the queue's own self-approval guards.
 *
 * ## Standing rule for anyone extending this file
 *
 * **Every method that writes a record carrying an actor's name must resolve
 * that actor first** — `resolveRequester()` when a capability grant is needed,
 * `resolveActor()` when mere identity is enough, `assertApprovalAuthority()`
 * for Founder decisions, or the fencing token (`assertFence`) for a worker
 * mid-execution. There is no fifth option, and "this path is harmless" is not
 * one: authorization and attribution are different properties.
 *
 * That distinction is why the Jules review of `ff105a2` found four attributed
 * writes still unresolved (`rejectProposal`, `assignTask`, `postMissionMessage`,
 * `proposeMission`). None could escalate privilege — a proposal and a message
 * are inert, an assignment intent is advisory — but each let an unknown
 * identity choose what it SIGNED, in a hash-chained evidence log that exists
 * precisely so history can be trusted. Group-room attribution is the sharpest
 * case: it is what a human reads before deciding to promote a mission.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { HeadquarterStore } from '../store/headquarter.js';
import type { ActivityStatus } from '../contracts/events.js';
import { evaluatePolicy, type PolicyContext, type PolicyDecision } from '../operator/policy.js';
import { taskActionDigest } from '../operator/approvals.js';
import { assertNoSecretLikeContent } from '../operator/evidence.js';
import { OperatorQueue, type OperatorTask, type ReconcileDecision } from '../operator/queue.js';
import { ensureApplicationSchema } from './db.js';
import {
  SpecialistDirectoryAdapter,
  type NominationSourcePort,
  type WorkerAssignability,
  type WorkerDirectoryPort,
} from './ports.js';
import { classifyCapability, type TaskClassification } from './classification.js';
import {
  HumanPrincipalRegistry,
  resolveApprover,
  resolvePrincipal,
  type HumanPrincipalPort,
} from './principals.js';
import {
  detectActionLanguage,
  missionProposalDigest,
  type MissionProposal,
  type MissionProposalStatus,
} from './missions.js';

// ---- result contract ----

export type OpsErrorCode =
  | 'invalid_input'
  | 'unknown_task'
  | 'unknown_capability'
  | 'capability_disabled'
  | 'not_permitted'
  | 'worker_not_assignable'
  | 'kill_switch_engaged'
  | 'action_digest_mismatch'
  | 'task_not_awaiting_approval'
  | 'assigned_to_other_worker'
  | 'nothing_claimable'
  | 'unknown_principal'
  | 'humans_do_not_execute'
  | 'enqueue_rejected'
  | 'operator_rejected'
  | 'proposal_not_found'
  | 'proposal_not_open'
  | 'proposal_digest_mismatch'
  | 'replacement_blocked';

export interface OpsError {
  code: OpsErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type OpsResult<T> = { ok: true; data: T } | { ok: false; error: OpsError };

function fail(code: OpsErrorCode, message: string, details?: Record<string, unknown>): OpsResult<never> {
  return { ok: false, error: { code, message, details } };
}

function ok<T>(data: T): OpsResult<T> {
  return { ok: true, data };
}

// ---- inputs / outputs ----

export interface CreateTaskInput {
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * Worker or human principal opening the work. Permissions are read from the
   * matching registry, never from the caller. A human's grant is to ORIGINATE
   * only — it never confers a claim.
   */
  requestedBy: string;
  /** Console labels only — never authority. */
  project?: string;
  title?: string;
}

export interface CreatedTask {
  task: OperatorTask;
  classification: TaskClassification;
  deduplicated: boolean;
}

/** A nomination after the Operator has had the final word on it. */
export interface EvaluatedNomination {
  workerId: string;
  /** Nomination source ids that suggested this worker. */
  nominatedBy: string[];
  rationales: string[];
  assignability: WorkerAssignability;
  /** The Operator's own decision, from registry + directory allow-list only. */
  operatorDecision: PolicyDecision;
  /** True only when the Operator itself would admit this worker. */
  eligible: boolean;
}

export interface TaskRouting {
  taskId: string;
  capabilityId: string;
  classification: TaskClassification;
  nominations: EvaluatedNomination[];
}

export interface AssignmentIntent {
  taskId: string;
  workerId: string;
  assignedBy: string;
  assignedAt: string;
  rationale: string | null;
}

export interface TaskMeta {
  taskId: string;
  project: string | null;
  title: string | null;
  sourceProposalId: string | null;
  assignment: AssignmentIntent | null;
}

export interface ApproveTaskInput {
  taskId: string;
  /** Human principal deciding. Refused for any registered worker. */
  founderId: string;
  /**
   * The digest the Approval Center displayed. REQUIRED: if the action changed
   * since it was rendered, the approval is refused rather than written.
   */
  expectedActionDigest: string;
  ttlMs?: number;
  note?: string;
}

export interface DenyTaskInput {
  taskId: string;
  founderId: string;
  reason: string;
  /** Optional; a mismatch is recorded but does not block a denial. */
  expectedActionDigest?: string;
}

export interface ReplacementBlocker {
  taskId: string;
  status: ActivityStatus;
  capabilityId: string;
  /** What must happen before the worker can be safely removed. */
  requires: 'handover' | 'reconciliation';
}

export interface ReplacementPlan {
  workerId: string;
  safe: boolean;
  blockers: ReplacementBlocker[];
}

export interface HeadquarterOperationsOptions {
  policyCtx?: PolicyContext;
  workers?: WorkerDirectoryPort;
  /** Human identity seam. Defaults to the (initially empty) table-backed registry. */
  humanPrincipals?: HumanPrincipalPort;
  nominationSources?: readonly NominationSourcePort[];
  store?: HeadquarterStore;
  queue?: OperatorQueue;
}

/** Who an actor turned out to be, once resolved against both registries. */
type ResolvedRequester =
  | { kind: 'worker'; allowedCapabilities: readonly string[] }
  | { kind: 'human'; allowedCapabilities: readonly string[] };

export class HeadquarterOperations {
  readonly queue: OperatorQueue;
  readonly store: HeadquarterStore;
  readonly workers: WorkerDirectoryPort;
  /**
   * Human identity, deliberately separate from worker identity. Empty by
   * default: nobody is a principal until a Founder registers them.
   */
  readonly principals: HumanPrincipalPort;
  private readonly nominationSources: readonly NominationSourcePort[];
  private readonly policyCtx: PolicyContext;

  constructor(
    private db: HqDatabase,
    options: HeadquarterOperationsOptions = {},
  ) {
    ensureApplicationSchema(db);
    this.store = options.store ?? new HeadquarterStore(db);
    this.queue = options.queue ?? new OperatorQueue(db, options.policyCtx ?? {});
    this.workers = options.workers ?? new SpecialistDirectoryAdapter(this.store);
    this.principals = options.humanPrincipals ?? new HumanPrincipalRegistry(db);
    this.nominationSources = options.nominationSources ?? [];
    this.policyCtx = options.policyCtx ?? {};
  }

  /** Standing pre-approval set the policy engine is evaluated against. */
  get policyContext(): PolicyContext {
    return this.policyCtx;
  }

  /** Every engaged kill-switch scope, for the console's alarm section. */
  killSwitchScopes(): {
    scope: string;
    reason: string | null;
    engagedBy: string | null;
    engagedAt: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT scope, reason, engaged_by AS engagedBy, engaged_at AS engagedAt
         FROM op_kill_switch WHERE engaged = 1 ORDER BY scope`,
      )
      .all() as {
      scope: string;
      reason: string | null;
      engagedBy: string | null;
      engagedAt: string | null;
    }[];
  }

  // ---- classify ----

  /** Explain a capability's gates. Registry-derived; payload-blind. */
  classify(capabilityId: string): OpsResult<TaskClassification> {
    const cap = this.queue.capabilities.get(capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${capabilityId}`);
    return ok(classifyCapability(cap, this.policyCtx));
  }

  // ---- create ----

  /**
   * Create a task on behalf of a worker OR a human principal.
   *
   * Either way the capability allow-list is read from a registry — the
   * specialist directory for a worker, `originateCapabilities` for a human —
   * and never accepted from the caller. Deny by default: an id in neither
   * registry can open nothing, and a human's origination grant confers no
   * execution right whatsoever (see `claimNext`/`startTask`).
   */
  createTask(input: CreateTaskInput): OpsResult<CreatedTask> {
    if (!input.capabilityId || !input.requestedBy) {
      return fail('invalid_input', 'capabilityId and requestedBy are required');
    }
    const cap = this.queue.capabilities.get(input.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${input.capabilityId}`);
    if (!cap.enabled) return fail('capability_disabled', `Capability ${cap.id} is disabled`);

    const requester = this.resolveRequester(input.requestedBy, 'create_task');
    if (!requester.ok) return requester;

    const result = this.queue.enqueue({
      capabilityId: input.capabilityId,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      requestedBy: {
        workerId: input.requestedBy,
        // Authority: the registry, not the caller.
        allowedCapabilities: [...requester.data.allowedCapabilities],
      },
    });
    if (!result.accepted) {
      return fail('enqueue_rejected', result.reason, { capabilityId: input.capabilityId });
    }
    if (!result.deduplicated) {
      this.upsertMeta(result.task.id, { project: input.project, title: input.title });
    }
    return ok({
      task: result.task,
      classification: classifyCapability(cap, this.policyCtx),
      deduplicated: result.deduplicated,
    });
  }

  // ---- route / nominate ----

  /**
   * Ask every nomination source who could do this task, then let the Operator
   * decide. Nominations are advisory: `eligible` is computed ONLY from the
   * capability registry and the directory allow-list, so a source that
   * nominates an unauthorized, unknown, or disabled worker changes nothing.
   */
  routeTask(taskId: string): OpsResult<TaskRouting> {
    const task = this.queue.get(taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${taskId}`);
    const cap = this.queue.capabilities.get(task.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${task.capabilityId}`);

    const merged = new Map<string, { sources: string[]; rationales: string[] }>();
    for (const source of this.nominationSources) {
      let nominations: readonly { workerId: string; rationale?: string }[] = [];
      try {
        nominations = source.nominate({
          taskId: task.id,
          capabilityId: task.capabilityId,
          riskClass: cap.riskClass,
          sideEffect: cap.sideEffect,
        });
      } catch {
        // A misbehaving nomination source must never break routing; it simply
        // nominates nobody. Recorded, then ignored.
        this.queue.evidence.append({
          taskId: task.id,
          actor: 'system',
          kind: 'nomination_source_failed',
          payload: { source: source.id },
        });
        continue;
      }
      for (const nomination of nominations) {
        const entry = merged.get(nomination.workerId) ?? { sources: [], rationales: [] };
        entry.sources.push(source.id);
        if (nomination.rationale) entry.rationales.push(nomination.rationale);
        merged.set(nomination.workerId, entry);
      }
    }

    const nominations: EvaluatedNomination[] = [...merged.entries()]
      .map(([workerId, entry]) => {
        const assignability = this.workers.assignability(workerId);
        const operatorDecision = evaluatePolicy(
          cap,
          { workerId, allowedCapabilities: [...this.workers.allowedCapabilities(workerId)] },
          this.policyCtx,
        );
        return {
          workerId,
          nominatedBy: entry.sources,
          rationales: entry.rationales,
          assignability,
          operatorDecision,
          eligible: assignability.assignable && operatorDecision.outcome !== 'deny',
        };
      })
      .sort((a, b) => a.workerId.localeCompare(b.workerId));

    this.queue.evidence.append({
      taskId: task.id,
      actor: 'system',
      kind: 'routing_evaluated',
      payload: {
        capabilityId: task.capabilityId,
        nominated: nominations.map((n) => ({
          workerId: n.workerId,
          nominatedBy: n.nominatedBy,
          eligible: n.eligible,
          operatorOutcome: n.operatorDecision.outcome,
        })),
      },
    });

    return ok({
      taskId: task.id,
      capabilityId: task.capabilityId,
      classification: classifyCapability(cap, this.policyCtx),
      nominations,
    });
  }

  /**
   * Record an ADVISORY assignment intent: "this task is meant for that
   * worker". It changes no canonical status and grants nothing — the worker
   * still has to claim the task through the atomic fenced claim path, and is
   * still subject to policy, approval and review.
   *
   * Its one operational effect is a NARROWING one: `claimNext()` refuses to
   * hand the head-of-queue task to a different worker (see that method for the
   * benign race it can lose).
   */
  assignTask(
    taskId: string,
    workerId: string,
    assignedBy: string,
    rationale?: string,
  ): OpsResult<AssignmentIntent> {
    const task = this.queue.get(taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${taskId}`);
    const cap = this.queue.capabilities.get(task.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${task.capabilityId}`);

    // The actor RECORDING the intent must be someone: this writes an
    // actor-attributed annotation event and evidence entry.
    const actor = this.resolveActor(assignedBy, 'record an assignment intent');
    if (!actor.ok) return actor;

    const assignability = this.workers.assignability(workerId);
    if (!assignability.assignable) {
      return this.rejectNotAssignable(workerId, assignability, 'assign_task');
    }
    const decision = evaluatePolicy(
      cap,
      { workerId, allowedCapabilities: [...this.workers.allowedCapabilities(workerId)] },
      this.policyCtx,
    );
    if (decision.outcome === 'deny') {
      return fail('not_permitted', decision.reason, { workerId, capabilityId: cap.id });
    }

    const at = nowIso();
    this.upsertMeta(taskId, {
      assignedWorkerId: workerId,
      assignedBy,
      assignedAt: at,
      assignmentRationale: rationale ?? null,
    });
    // Annotation only (status null): history records the routing decision
    // without pretending the task changed state.
    this.store.appendEvent({
      subjectKind: 'task',
      subjectId: taskId,
      status: null,
      actor: assignedBy,
      summary: `Assignment intent recorded for ${workerId}`,
      detail: { workerId, advisory: true, rationale: rationale ?? null },
    });
    this.queue.evidence.append({
      taskId,
      actor: assignedBy,
      kind: 'assignment_intent_recorded',
      payload: { workerId, rationale: rationale ?? null },
    });
    return ok({ taskId, workerId, assignedBy, assignedAt: at, rationale: rationale ?? null });
  }

  // ---- Founder Approval Center ----

  /**
   * Approve the exact action the console displayed.
   *
   * `expectedActionDigest` is the whole point: the Approval Center renders a
   * digest, the Founder clicks approve, and the digest travels back. A payload
   * or capability mutated in between produces a different digest and the
   * approval is refused BEFORE any approval row exists — the Founder cannot
   * approve something other than what they read. The queue then binds its own
   * approval record to that same digest, so the guarantee also survives any
   * mutation after this call.
   */
  approveTask(input: ApproveTaskInput): OpsResult<OperatorTask> {
    const task = this.queue.get(input.taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${input.taskId}`);
    const principal = this.assertApprovalAuthority(input.founderId, 'approve');
    if (principal) return principal;
    if (task.status !== 'needs_approval') {
      return fail(
        'task_not_awaiting_approval',
        `Task ${task.id} is not awaiting approval (status: ${task.status})`,
        { status: task.status },
      );
    }
    const cap = this.queue.capabilities.get(task.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${task.capabilityId}`);
    if (!cap.enabled) return fail('capability_disabled', `Capability ${cap.id} is disabled`);
    if (this.queue.killSwitchEngaged(task.capabilityId)) {
      // Refuse rather than let approved work sit primed to run the instant the
      // switch is released.
      return fail('kill_switch_engaged', `Kill switch is engaged for ${task.capabilityId}`);
    }

    const currentDigest = taskActionDigest(task);
    if (!input.expectedActionDigest || input.expectedActionDigest !== currentDigest) {
      this.queue.evidence.append({
        taskId: task.id,
        actor: input.founderId,
        kind: 'approval_refused_action_changed',
        payload: { expected: input.expectedActionDigest ?? null, current: currentDigest },
      });
      return fail(
        'action_digest_mismatch',
        `Task ${task.id}: the action changed since it was presented for approval; nothing was approved`,
        { expected: input.expectedActionDigest ?? null, current: currentDigest },
      );
    }

    try {
      return ok(
        this.queue.approve(task.id, input.founderId, { ttlMs: input.ttlMs, note: input.note }),
      );
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId: task.id });
    }
  }

  /** Founder denial. Blocks the task with an immutable, reasoned record. */
  denyTask(input: DenyTaskInput): OpsResult<OperatorTask> {
    const task = this.queue.get(input.taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${input.taskId}`);
    const principal = this.assertApprovalAuthority(input.founderId, 'deny');
    if (principal) return principal;
    if (!input.reason) return fail('invalid_input', 'A denial requires a reason');
    const currentDigest = taskActionDigest(task);
    if (input.expectedActionDigest && input.expectedActionDigest !== currentDigest) {
      // A denial is never an authorization, so a stale digest does not block
      // it — but the divergence is recorded.
      this.queue.evidence.append({
        taskId: task.id,
        actor: input.founderId,
        kind: 'denial_digest_divergence',
        payload: { expected: input.expectedActionDigest, current: currentDigest },
      });
    }
    try {
      return ok(this.queue.deny(task.id, input.reason, input.founderId));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId: task.id });
    }
  }

  // ---- claim / start / execute ----

  /**
   * Claim the next task for a capability.
   *
   * Preconditions added here, all strictly narrowing: the worker must be
   * assignable (a disabled or replaced worker gets no new work), the directory
   * must grant it the capability, the kill switch must be clear, and the
   * head-of-queue task must not carry an assignment intent for someone else.
   * The atomic fenced claim itself, and the approval consumption bound to it,
   * remain entirely `OperatorQueue.claim()`'s.
   *
   * Known benign race: the intent peek is not part of the claim's conditional
   * UPDATE, so an intent recorded in the microseconds between peek and claim
   * can be missed and another eligible worker may take the task. Assignment
   * intent is advisory routing, and every real authority — allow-list,
   * approval binding, fence, independent review — is unaffected.
   */
  claimNext(workerId: string, capabilityId: string, leaseMs?: number): OpsResult<OperatorTask> {
    const cap = this.queue.capabilities.get(capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${capabilityId}`);
    if (!cap.enabled) return fail('capability_disabled', `Capability ${capabilityId} is disabled`);

    const human = this.rejectHumanExecution(workerId, 'claim work');
    if (human) return human;
    const assignability = this.workers.assignability(workerId);
    if (!assignability.assignable) {
      return this.rejectNotAssignable(workerId, assignability, 'claim');
    }
    if (!this.workers.allowedCapabilities(workerId).includes(capabilityId)) {
      return fail(
        'not_permitted',
        `Worker ${workerId} is not allowed capability ${capabilityId} (least privilege)`,
      );
    }
    if (this.queue.killSwitchEngaged(capabilityId)) {
      return fail('kill_switch_engaged', `Kill switch is engaged for ${capabilityId}`);
    }

    const head = this.queue
      .listByStatus('queued')
      .find((candidate) => candidate.capabilityId === capabilityId);
    if (!head) return fail('nothing_claimable', `No queued task for ${capabilityId}`);
    const intent = this.readMeta(head.id)?.assignment;
    if (intent && intent.workerId !== workerId) {
      return fail(
        'assigned_to_other_worker',
        `Task ${head.id} is assigned to ${intent.workerId}`,
        { taskId: head.id, assignedTo: intent.workerId },
      );
    }

    let claimed: OperatorTask | null;
    try {
      claimed = this.queue.claim(workerId, capabilityId, leaseMs);
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { capabilityId });
    }
    if (!claimed) return fail('nothing_claimable', `No claimable task for ${capabilityId}`);
    return ok(claimed);
  }

  /**
   * Start executing a claimed task. Assignability is re-checked here: a worker
   * disabled or replaced between claim and start must not begin execution.
   * The approval digest / time-box / claim-binding revalidation stays in
   * `OperatorQueue.start()`.
   */
  startTask(taskId: string, workerId: string, fence: number): OpsResult<OperatorTask> {
    const human = this.rejectHumanExecution(workerId, 'start work');
    if (human) return human;
    const assignability = this.workers.assignability(workerId);
    if (!assignability.assignable) {
      return this.rejectNotAssignable(workerId, assignability, 'start', { taskId });
    }
    try {
      return ok(this.queue.start(taskId, workerId, fence));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  heartbeat(taskId: string, workerId: string, fence: number, leaseMs?: number): OpsResult<null> {
    try {
      this.queue.heartbeat(taskId, workerId, fence, leaseMs);
      return ok(null);
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  /**
   * Submit an execution result. For a side-effect capability this can only
   * ever reach `reviewState: 'pending'` — the queue refuses to let the
   * executing worker self-complete, and only an independent reviewer moves it
   * to `completed`.
   *
   * Added precondition (narrowing): a result already awaiting review may not
   * be re-submitted. `OperatorQueue.complete()` releases the lease but leaves
   * `claimed_by`/`fence` intact, so a second call would still satisfy the
   * fence check and would overwrite the stored result while a reviewer is
   * looking at it. It could never self-complete the task — the review gate
   * holds either way — but the reviewer must decide on the evidence that was
   * actually submitted, so the second submission is refused here. Rework after
   * a failed review goes back through claim/start and gets a fresh fence.
   */
  submitResult(
    taskId: string,
    workerId: string,
    fence: number,
    result: Record<string, unknown>,
    evidenceRefs: string[] = [],
  ): OpsResult<OperatorTask> {
    const existing = this.queue.get(taskId);
    if (!existing) return fail('unknown_task', `Unknown task: ${taskId}`);
    if (existing.reviewState === 'pending') {
      return fail(
        'operator_rejected',
        `Task ${taskId} already has a result awaiting independent review; it cannot be re-submitted`,
        { submittedBy: existing.submittedBy },
      );
    }
    try {
      return ok(this.queue.complete(taskId, workerId, fence, result, evidenceRefs));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  failTask(taskId: string, workerId: string, fence: number, reason: string): OpsResult<OperatorTask> {
    try {
      return ok(this.queue.fail(taskId, workerId, fence, reason));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  /**
   * Independent review of a submitted result.
   *
   * The reviewer must BE someone: an assignable worker, or a registered active
   * human principal. (Approval authority is not required — reviewing a result
   * is not deciding a Founder approval.) Independence itself — never the
   * executing, submitting or requesting worker — is enforced by the queue.
   */
  reviewTask(
    taskId: string,
    reviewerId: string,
    verdict: 'pass' | 'fail',
    note = '',
  ): OpsResult<OperatorTask> {
    if (verdict === 'fail' && !note) {
      return fail('invalid_input', 'A failed review requires a reason');
    }
    const reviewer = this.resolveActor(reviewerId, 'review');
    if (!reviewer.ok) return reviewer;
    try {
      return ok(
        verdict === 'pass'
          ? this.queue.reviewPass(taskId, reviewerId, note)
          : this.queue.reviewFail(taskId, reviewerId, note),
      );
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  /**
   * Resolve an `outcome_unknown` task after a human checked the real world.
   * The reconciler must be a known actor (same rule as review); independence
   * and the "never blindly re-queue a non-idempotent capability" rule are the
   * queue's.
   */
  reconcileTask(
    taskId: string,
    decision: ReconcileDecision,
    by: string,
    note: string,
  ): OpsResult<OperatorTask> {
    if (!note) return fail('invalid_input', 'Reconciliation requires a note');
    const reconciler = this.resolveActor(by, 'reconcile');
    if (!reconciler.ok) return reconciler;
    try {
      return ok(this.queue.reconcile(taskId, decision, by, note));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  // ---- kill switch (Founder only) ----

  engageKillSwitch(scope: string, founderId: string, reason: string): OpsResult<null> {
    const principal = this.assertApprovalAuthority(founderId, 'engage the kill switch');
    if (principal) return principal;
    this.queue.engageKillSwitch(scope, founderId, reason);
    return ok(null);
  }

  releaseKillSwitch(scope: string, founderId: string): OpsResult<null> {
    const principal = this.assertApprovalAuthority(founderId, 'release the kill switch');
    if (principal) return principal;
    this.queue.releaseKillSwitch(scope, founderId);
    return ok(null);
  }

  // ---- worker replacement ----

  /**
   * What blocks removing a worker right now. Lane F does not own the worker
   * lifecycle (that is lane D / the specialist directory) — it reports the
   * Operator-side truth that lifecycle must respect: a worker holding
   * in-flight claims needs a handover, and one holding an `outcome_unknown`
   * task needs reconciliation, before it can be safely replaced.
   */
  replacementPlan(workerId: string): OpsResult<ReplacementPlan> {
    const rows = this.db
      .prepare(
        `SELECT id, status, capability_id FROM op_tasks
         WHERE claimed_by = ? AND status IN ('assigned', 'running', 'outcome_unknown')
         ORDER BY created_at`,
      )
      .all(workerId) as { id: string; status: ActivityStatus; capability_id: string }[];
    const blockers: ReplacementBlocker[] = rows.map((row) => ({
      taskId: row.id,
      status: row.status,
      capabilityId: row.capability_id,
      requires: row.status === 'outcome_unknown' ? 'reconciliation' : 'handover',
    }));
    return ok({ workerId, safe: blockers.length === 0, blockers });
  }

  /** Convenience guard for a caller about to disable/replace a worker. */
  assertReplacementSafe(workerId: string): OpsResult<ReplacementPlan> {
    const plan = this.replacementPlan(workerId);
    if (!plan.ok) return plan;
    if (!plan.data.safe) {
      return fail(
        'replacement_blocked',
        `Worker ${workerId} still holds ${plan.data.blockers.length} in-flight task(s); handover/reconciliation required first`,
        { blockers: plan.data.blockers },
      );
    }
    return plan;
  }

  // ---- group-room mission intake ----

  /**
   * Post a group-room message. Storage only. This never creates a task, never
   * touches an approval, and never grants anything, whatever the text says.
   *
   * The AUTHOR must still be a resolvable identity. A message is inert, so a
   * forged author escalates nothing — but attribution in the group room is
   * exactly what a human reads before deciding to promote a mission, so an
   * unknown id must not be able to publish under a trusted-looking name.
   */
  postMissionMessage(input: {
    threadId: string;
    author: string;
    body: string;
    refs?: string[];
  }): OpsResult<{ messageId: string; containsActionLanguage: boolean }> {
    if (!input.threadId || !input.author) {
      return fail('invalid_input', 'threadId and author are required');
    }
    const actor = this.resolveActor(input.author, 'post to a group room');
    if (!actor.ok) return actor;
    const message = this.store.postMessage(input);
    return ok({
      messageId: message.id,
      // Advisory decoration for human readers only.
      containsActionLanguage: detectActionLanguage(input.body),
    });
  }

  /**
   * Raise an INERT proposal from a group-room discussion. Still no task, no
   * approval, no grant — a row a human can read and act on. The capability is
   * chosen through this typed argument, never parsed from message text.
   */
  proposeMission(input: {
    threadId: string;
    capabilityId: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    proposedBy: string;
    sourceMessageId?: string;
  }): OpsResult<MissionProposal> {
    if (!input.threadId || !input.capabilityId || !input.proposedBy) {
      return fail('invalid_input', 'threadId, capabilityId and proposedBy are required');
    }
    // Inert, but it enters the evidence chain under this actor's name.
    const actor = this.resolveActor(input.proposedBy, 'raise a mission proposal');
    if (!actor.ok) return actor;
    try {
      assertNoSecretLikeContent(input.payload);
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }
    const cap = this.queue.capabilities.get(input.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${input.capabilityId}`);

    const id = uuid();
    const at = nowIso();
    const idempotencyKey = input.idempotencyKey ?? null;
    const digest = missionProposalDigest({
      threadId: input.threadId,
      capabilityId: input.capabilityId,
      payload: input.payload,
      idempotencyKey,
    });
    this.db
      .prepare(
        `INSERT INTO hq_mission_proposals
           (id, thread_id, source_message_id, capability_id, payload, idempotency_key, digest,
            proposed_by, proposed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
      )
      .run(
        id,
        input.threadId,
        input.sourceMessageId ?? null,
        input.capabilityId,
        JSON.stringify(input.payload),
        idempotencyKey,
        digest,
        input.proposedBy,
        at,
      );
    this.queue.evidence.append({
      actor: input.proposedBy,
      kind: 'mission_proposed',
      payload: {
        proposalId: id,
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        digest,
        executable: false,
      },
    });
    return ok(this.getProposal(id)!);
  }

  /**
   * Turn a proposal into a real Operator task.
   *
   * This is the ONLY bridge from chat to work, and it is authorized entirely
   * on the Operator side: `promotedBy` must be an assignable worker that the
   * DIRECTORY already grants the capability to. Neither the message author,
   * nor the proposer, nor the message text has any say. The created task is an
   * ordinary task — a Founder-gated capability still lands in `needs_approval`
   * exactly as if it had been created any other way.
   */
  promoteProposal(input: {
    proposalId: string;
    promotedBy: string;
    expectedDigest?: string;
    project?: string;
    title?: string;
  }): OpsResult<CreatedTask> {
    const proposal = this.getProposal(input.proposalId);
    if (!proposal) return fail('proposal_not_found', `Unknown proposal: ${input.proposalId}`);
    if (proposal.status !== 'proposed') {
      return fail('proposal_not_open', `Proposal ${proposal.id} is already ${proposal.status}`, {
        status: proposal.status,
      });
    }
    if (input.expectedDigest && input.expectedDigest !== proposal.digest) {
      return fail(
        'proposal_digest_mismatch',
        `Proposal ${proposal.id} does not match the digest presented`,
        { expected: input.expectedDigest, current: proposal.digest },
      );
    }

    const created = this.createTask({
      capabilityId: proposal.capabilityId,
      payload: proposal.payload,
      idempotencyKey: proposal.idempotencyKey ?? undefined,
      requestedBy: input.promotedBy,
      project: input.project,
      title: input.title,
    });
    if (!created.ok) return created;

    this.db
      .prepare(
        `UPDATE hq_mission_proposals
         SET status = 'promoted', task_id = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(created.data.task.id, input.promotedBy, nowIso(), proposal.id);
    this.upsertMeta(created.data.task.id, { sourceProposalId: proposal.id });
    this.queue.evidence.append({
      taskId: created.data.task.id,
      actor: input.promotedBy,
      kind: 'mission_promoted_to_task',
      payload: {
        proposalId: proposal.id,
        threadId: proposal.threadId,
        sourceMessageId: proposal.sourceMessageId,
        capabilityId: proposal.capabilityId,
      },
    });
    return created;
  }

  /**
   * Close an open proposal without promoting it.
   *
   * Rejection is a one-way state change on a shared record, attributed to the
   * deciding actor in both the proposal row and the hash-chained evidence log,
   * so `by` must resolve to a known worker or active human principal (Jules
   * review of `ff105a2`). An unknown or deactivated identity could otherwise
   * close other people's proposals and write a false name into the evidence
   * trail.
   */
  rejectProposal(proposalId: string, by: string, note: string): OpsResult<MissionProposal> {
    const proposal = this.getProposal(proposalId);
    if (!proposal) return fail('proposal_not_found', `Unknown proposal: ${proposalId}`);
    if (proposal.status !== 'proposed') {
      return fail('proposal_not_open', `Proposal ${proposalId} is already ${proposal.status}`);
    }
    if (!note) return fail('invalid_input', 'Rejecting a proposal requires a note');
    const actor = this.resolveActor(by, 'reject a mission proposal');
    if (!actor.ok) return actor;
    this.db
      .prepare(
        `UPDATE hq_mission_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(by, nowIso(), note, proposalId);
    this.queue.evidence.append({
      actor: by,
      kind: 'mission_proposal_rejected',
      payload: { proposalId, note },
    });
    return ok(this.getProposal(proposalId)!);
  }

  getProposal(id: string): MissionProposal | null {
    const row = this.db.prepare(`SELECT * FROM hq_mission_proposals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      sourceMessageId: (row.source_message_id as string | null) ?? null,
      capabilityId: row.capability_id as string,
      payload: JSON.parse(row.payload as string),
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
      digest: row.digest as string,
      proposedBy: row.proposed_by as string,
      proposedAt: row.proposed_at as string,
      status: row.status as MissionProposalStatus,
      taskId: (row.task_id as string | null) ?? null,
      decidedBy: (row.decided_by as string | null) ?? null,
      decidedAt: (row.decided_at as string | null) ?? null,
      decisionNote: (row.decision_note as string | null) ?? null,
    };
  }

  listProposals(status?: MissionProposalStatus): MissionProposal[] {
    const rows = (
      status
        ? this.db
            .prepare(`SELECT id FROM hq_mission_proposals WHERE status = ? ORDER BY proposed_at`)
            .all(status)
        : this.db.prepare(`SELECT id FROM hq_mission_proposals ORDER BY proposed_at`).all()
    ) as { id: string }[];
    return rows.map((r) => this.getProposal(r.id)!);
  }

  // ---- task metadata (console labels + advisory assignment) ----

  readMeta(taskId: string): TaskMeta | null {
    const row = this.db.prepare(`SELECT * FROM hq_op_task_meta WHERE task_id = ?`).get(taskId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const workerId = (row.assigned_worker_id as string | null) ?? null;
    return {
      taskId: row.task_id as string,
      project: (row.project as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      sourceProposalId: (row.source_proposal_id as string | null) ?? null,
      assignment: workerId
        ? {
            taskId: row.task_id as string,
            workerId,
            assignedBy: row.assigned_by as string,
            assignedAt: row.assigned_at as string,
            rationale: (row.assignment_rationale as string | null) ?? null,
          }
        : null,
    };
  }

  private upsertMeta(
    taskId: string,
    patch: {
      project?: string | null;
      title?: string | null;
      sourceProposalId?: string | null;
      assignedWorkerId?: string | null;
      assignedBy?: string | null;
      assignedAt?: string | null;
      assignmentRationale?: string | null;
    },
  ): void {
    const existing = this.readMeta(taskId);
    const next = {
      project: patch.project ?? existing?.project ?? null,
      title: patch.title ?? existing?.title ?? null,
      sourceProposalId: patch.sourceProposalId ?? existing?.sourceProposalId ?? null,
      assignedWorkerId: patch.assignedWorkerId ?? existing?.assignment?.workerId ?? null,
      assignedBy: patch.assignedBy ?? existing?.assignment?.assignedBy ?? null,
      assignedAt: patch.assignedAt ?? existing?.assignment?.assignedAt ?? null,
      assignmentRationale:
        patch.assignmentRationale ?? existing?.assignment?.rationale ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO hq_op_task_meta
           (task_id, project, title, source_proposal_id, assigned_worker_id, assigned_by, assigned_at, assignment_rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           project = excluded.project,
           title = excluded.title,
           source_proposal_id = excluded.source_proposal_id,
           assigned_worker_id = excluded.assigned_worker_id,
           assigned_by = excluded.assigned_by,
           assigned_at = excluded.assigned_at,
           assignment_rationale = excluded.assignment_rationale`,
      )
      .run(
        taskId,
        next.project,
        next.title,
        next.sourceProposalId,
        next.assignedWorkerId,
        next.assignedBy,
        next.assignedAt,
        next.assignmentRationale,
      );
  }

  // ---- internals ----

  /**
   * Resolve an actor that must simply BE someone — an assignable worker or an
   * active human principal — without needing a capability grant. Used for
   * review and reconciliation, where the decisive property is independence
   * (enforced by the queue) rather than permission to act on a capability.
   * Deny by default: an unknown id is nobody and can do neither.
   */
  private resolveActor(actor: string, action: string): OpsResult<ResolvedRequester> {
    if (!actor) return fail('invalid_input', `An actor is required to ${action}`);
    if (actor === 'system') {
      return fail('not_permitted', `'system' cannot ${action}`);
    }
    return this.resolveRequester(actor, action);
  }

  /**
   * Resolve who is opening work. A worker must be assignable; a human must be
   * a registered, active principal. Neither can supply its own allow-list.
   */
  private resolveRequester(actor: string, action: string): OpsResult<ResolvedRequester> {
    if (this.workers.isRegistered(actor)) {
      const assignability = this.workers.assignability(actor);
      if (!assignability.assignable) {
        return this.rejectNotAssignable(actor, assignability, action);
      }
      return ok({ kind: 'worker', allowedCapabilities: this.workers.allowedCapabilities(actor) });
    }
    const human = resolvePrincipal(this.principals, actor);
    if (!human.ok) {
      this.queue.evidence.append({
        actor: 'system',
        kind: 'principal_rejected',
        payload: { actorId: actor, action, reason: human.reason },
      });
      return fail(
        'unknown_principal',
        `${actor} may not ${action}: not a registered worker, and ${human.reason.replace('principal_', 'the human principal is ')}`,
        { actor, reason: human.reason },
      );
    }
    // A human's grant is for ORIGINATING work only. It never reaches
    // claim/start — those paths are worker-only by construction.
    return ok({ kind: 'human', allowedCapabilities: human.principal.originateCapabilities });
  }

  /**
   * Founder-facing decisions require a registered, active human principal that
   * carries approval authority — deny by default.
   *
   * The earlier version of this guard authorized by elimination ("not a known
   * worker, therefore human"), which denied workers but admitted every unknown
   * string. Authority is now positive: an actor must BE someone, not merely
   * fail to be a worker. Any id the directory knows as a worker is still
   * refused outright, so worker identity can never carry approval authority.
   * All of this sits on top of — never instead of — the queue's own
   * self-approval guards, which still stop a requester approving its own action.
   */
  private assertApprovalAuthority(actor: string, action: string): OpsResult<never> | null {
    if (!actor) return fail('invalid_input', `An actor is required to ${action}`);
    if (actor === 'system') {
      return fail('not_permitted', `'system' cannot ${action}: a human principal is required`);
    }
    if (this.workers.isRegistered(actor)) {
      return fail(
        'not_permitted',
        `Registered worker ${actor} cannot ${action}: worker identity never carries approval authority`,
        { actor },
      );
    }
    const approver = resolveApprover(this.principals, actor);
    if (!approver.ok) {
      this.queue.evidence.append({
        actor: 'system',
        kind: 'approval_authority_refused',
        payload: { actorId: actor, action, reason: approver.reason },
      });
      return fail('not_permitted', `${actor} may not ${action}: ${approver.reason}`, {
        actor,
        reason: approver.reason,
      });
    }
    return null;
  }

  /**
   * Execution is worker-only. A human principal may originate work and may
   * decide approvals; it can never hold a fenced claim, so `claimNext()` and
   * `startTask()` refuse it explicitly rather than letting it fall through the
   * worker-directory lookup with a confusing "unknown worker".
   */
  private rejectHumanExecution(actorId: string, action: string): OpsResult<never> | null {
    if (this.workers.isRegistered(actorId)) return null;
    if (!this.principals.get(actorId)) return null;
    this.queue.evidence.append({
      actor: 'system',
      kind: 'human_execution_refused',
      payload: { actorId, action },
    });
    return fail(
      'humans_do_not_execute',
      `Human principal ${actorId} may not ${action}: originating and approving work never grants execution capability`,
      { actorId },
    );
  }

  private rejectNotAssignable(
    workerId: string,
    assignability: WorkerAssignability,
    action: string,
    details: Record<string, unknown> = {},
  ): OpsResult<never> {
    const reason = assignability.assignable ? 'unknown' : assignability.reason;
    this.queue.evidence.append({
      actor: 'system',
      kind: 'worker_not_assignable',
      payload: { workerId, action, reason },
    });
    return fail('worker_not_assignable', `Worker ${workerId} may not ${action}: ${reason}`, {
      workerId,
      reason,
      ...details,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHeadquarterOperations(
  db: HqDatabase,
  options: HeadquarterOperationsOptions = {},
): HeadquarterOperations {
  return new HeadquarterOperations(db, options);
}
