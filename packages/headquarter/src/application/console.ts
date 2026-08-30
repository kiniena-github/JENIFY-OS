/**
 * Founder console read model (HQ lane F).
 *
 * PRESENTATION NEVER INVENTS STATE. Every status in this view is copied from a
 * canonical `op_tasks` row whose history lives in `hq_events`; this file has
 * no status vocabulary of its own, no derived "probably done", and no
 * heuristics. Where it adds a field, that field is either:
 *
 * - a verbatim copy of canonical data (`status`, `reviewState`, `fence`),
 * - a registry-derived classification (see `classification.ts`), or
 * - a label from the lane's own presentation metadata (project/title), which
 *   is explicitly NOT authority (see `db.ts`).
 *
 * The two states the Founder must never miss are surfaced as their own
 * sections rather than buried in a list: `outcomeUnknown` (a side-effect task
 * whose real-world result is genuinely not known and which will NEVER be
 * silently retried) and `killSwitch`.
 *
 * `ApprovalCard.actionDigest` is the value the Approval Center must echo back
 * to `HeadquarterOperations.approveTask()`. That round-trip is what makes
 * "the Founder approved exactly what was on screen" mechanically true.
 */

import type { ActivityStatus } from '../contracts/events.js';
import type { ReviewState } from '../operator/queue.js';
import { taskActionDigest } from '../operator/approvals.js';
import { classifyCapability, type TaskClassification } from './classification.js';
import type { HeadquarterOperations, TaskMeta } from './service.js';

export interface ConsoleTask {
  taskId: string;
  capabilityId: string;
  /** Canonical status — copied, never inferred. */
  status: ActivityStatus;
  reviewState: ReviewState;
  fence: number;
  claimedBy: string | null;
  submittedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  blockReason: string | null;
  classification: TaskClassification;
  /** Presentation labels and advisory assignment. Never authority. */
  project: string | null;
  title: string | null;
  assignedTo: string | null;
  sourceProposalId: string | null;
}

export interface ApprovalCard extends ConsoleTask {
  /**
   * Digest of the exact action being approved. Echo this back to
   * `approveTask()`; if the action changed meanwhile the approval is refused.
   */
  actionDigest: string;
  /** Plain-language reason the Founder is being asked at all. */
  ask: string;
  /**
   * What is known about the actor who REQUESTED this action — projected out of
   * the task payload deliberately (issue #200, Codex exact-head finding on
   * `5a19350`).
   *
   * The approval of a second human is the containment for an unauthenticated
   * `--as` assertion at the trusted-local-admin CLI. That containment only
   * works if the approver can see what they are containing, and this read model
   * excludes payload fields by design, so the marker never reached them: the
   * Approval Center showed a requester id and a digest, both of which look
   * equally solid whether or not anyone authenticated anything.
   *
   * `null` means the task carries no marker — an ordinary internal task rather
   * than a direct order. It is NOT a claim that the requester was
   * authenticated; nothing in Headquarter can make that claim yet.
   */
  requesterAuthentication: string | null;
}

export interface ReviewCard extends ConsoleTask {
  /**
   * Actors the queue will refuse as reviewers for this task — the executing,
   * submitting and requesting workers, plus 'system'. Rendering this stops the
   * console from offering a review action that can only fail.
   */
  ineligibleReviewers: string[];
}

export interface OutcomeUnknownCard extends ConsoleTask {
  /**
   * Reconciliation decisions the Operator will actually accept. A
   * non-idempotent capability can never be re-queued, so
   * 'confirmed_not_executed' is absent for it.
   */
  allowedDecisions: ('confirmed_done' | 'confirmed_failed' | 'confirmed_not_executed')[];
  /** Reconciliation requires an independent actor; these are refused. */
  ineligibleReconcilers: string[];
}

export interface KillSwitchView {
  globalEngaged: boolean;
  /** Engaged scopes: '*' for global, otherwise a capability id. */
  engagedScopes: { scope: string; reason: string | null; engagedBy: string | null; engagedAt: string | null }[];
}

export interface FounderConsole {
  generatedAt: string;
  killSwitch: KillSwitchView;
  approvals: ApprovalCard[];
  pendingReviews: ReviewCard[];
  outcomeUnknown: OutcomeUnknownCard[];
  blocked: ConsoleTask[];
  inFlight: ConsoleTask[];
  queued: ConsoleTask[];
}

/** Statuses whose tasks the console lists as active work. */
const IN_FLIGHT: readonly ActivityStatus[] = ['assigned', 'running'];

/**
 * The requester's trust marker, read from the task payload and whitelisted to
 * a known vocabulary before it crosses into a browser-safe read model.
 *
 * Whitelisted rather than passed through: the payload is written by a caller,
 * `ApprovalCard` is published, and an unrecognised value here would be both a
 * publication path and a trust claim nobody can back. Anything outside the
 * vocabulary is reported as unknown provenance, not as the string it contained.
 */
const KNOWN_REQUESTER_AUTHENTICATION: readonly string[] = [
  'unauthenticated',
  'unauthenticated_local_assertion',
];

function requesterAuthenticationOf(task: { payload?: Record<string, unknown> | null }): string | null {
  const raw = task.payload?.actorAuthentication;
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' && KNOWN_REQUESTER_AUTHENTICATION.includes(raw)
    ? raw
    : 'unrecognised_marker';
}

export function founderConsole(ops: HeadquarterOperations, now: Date = new Date()): FounderConsole {
  const toConsoleTask = (taskId: string): ConsoleTask | null => {
    const task = ops.queue.get(taskId);
    if (!task) return null;
    const capability = ops.queue.capabilities.get(task.capabilityId);
    if (!capability) return null;
    const meta: TaskMeta | null = ops.readMeta(task.id);
    return {
      taskId: task.id,
      capabilityId: task.capabilityId,
      status: task.status,
      reviewState: task.reviewState,
      fence: task.fence,
      claimedBy: task.claimedBy,
      submittedBy: task.submittedBy,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      blockReason: task.blockReason,
      classification: classifyCapability(capability, ops.policyContext),
      project: meta?.project ?? null,
      title: meta?.title ?? null,
      assignedTo: meta?.assignment?.workerId ?? null,
      sourceProposalId: meta?.sourceProposalId ?? null,
    };
  };

  const byStatus = (status: ActivityStatus): ConsoleTask[] =>
    ops.queue
      .listByStatus(status)
      .map((task) => toConsoleTask(task.id))
      .filter((card): card is ConsoleTask => card !== null);

  const approvals: ApprovalCard[] = ops.queue.listByStatus('needs_approval').flatMap((task) => {
    const base = toConsoleTask(task.id);
    if (!base) return [];
    return [
      {
        ...base,
        actionDigest: taskActionDigest(task),
        ask: `Execute ${task.capabilityId} — ${base.classification.reason}`,
        requesterAuthentication: requesterAuthenticationOf(task),
      },
    ];
  });

  const pendingReviews: ReviewCard[] = IN_FLIGHT.flatMap((status) =>
    ops.queue.listByStatus(status),
  )
    .filter((task) => task.reviewState === 'pending')
    .flatMap((task) => {
      const base = toConsoleTask(task.id);
      if (!base) return [];
      return [
        {
          ...base,
          ineligibleReviewers: dedupe([
            'system',
            task.claimedBy,
            task.submittedBy,
            task.createdBy,
          ]),
        },
      ];
    });

  const outcomeUnknown: OutcomeUnknownCard[] = ops.queue
    .listByStatus('outcome_unknown')
    .flatMap((task) => {
      const base = toConsoleTask(task.id);
      if (!base) return [];
      const capability = ops.queue.capabilities.get(task.capabilityId)!;
      const allowedDecisions: OutcomeUnknownCard['allowedDecisions'] = [
        'confirmed_done',
        'confirmed_failed',
      ];
      if (capability.idempotent) allowedDecisions.push('confirmed_not_executed');
      return [
        {
          ...base,
          allowedDecisions,
          ineligibleReconcilers: dedupe(['system', task.claimedBy, task.createdBy]),
        },
      ];
    });

  return {
    generatedAt: now.toISOString(),
    killSwitch: killSwitchView(ops),
    approvals,
    pendingReviews,
    outcomeUnknown,
    blocked: [...byStatus('blocked'), ...byStatus('review_failed')],
    inFlight: IN_FLIGHT.flatMap((status) => byStatus(status)).filter(
      (card) => card.reviewState !== 'pending',
    ),
    queued: byStatus('queued'),
  };
}

export function killSwitchView(ops: HeadquarterOperations): KillSwitchView {
  const rows = ops.killSwitchScopes();
  return {
    globalEngaged: rows.some((row) => row.scope === '*'),
    engagedScopes: rows,
  };
}

function dedupe(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))].sort();
}
