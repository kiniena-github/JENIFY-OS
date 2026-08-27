/**
 * Founder-facing operations read model (issue #139: "live status/events flow
 * into canonical ActivityEvent history; presentation never invents state" and
 * "outcome_unknown and kill switch surfaced clearly").
 *
 * Every field below is READ from a canonical source — `op_tasks`,
 * `hq_approvals`, `op_kill_switch`, `hq_events` — or DERIVED from them by a
 * pure function in this file. Nothing here caches status, and nothing here
 * has a writer. If the Operator and this snapshot ever disagree, the snapshot
 * is simply stale by one read; it cannot hold a state the Operator never had.
 *
 * Two derived flags earn their keep, and both are computed live:
 *
 *   `staleDigest` — the pending approval's stored digest no longer equals the
 *     task's current canonical digest, i.e. the action was mutated after the
 *     Founder was asked. Rendering this makes the mutation visible in the
 *     Approval Center instead of only at the execution boundary.
 *
 *   `expired` — the approval's time-box has passed. `approvalExpiredAt()`
 *     from `operator/approvals.ts` is reused rather than re-derived, so the
 *     UI and the execution boundary can never disagree about the cutoff.
 */

import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import type { ActivityStatus } from '../contracts/events.js';
import { approvalExpiredAt, taskActionDigest } from '../operator/approvals.js';
import type { HeadquarterOperationsService, TaskMeta } from './service.js';

export interface KillSwitchState {
  scope: string;
  engaged: boolean;
  reason: string | null;
  engagedBy: string | null;
  engagedAt: string | null;
}

export interface AttentionTask {
  taskId: string;
  capabilityId: string;
  status: ActivityStatus;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  fence: number;
  reviewState: string;
  blockReason: string | null;
  meta: TaskMeta;
}

export interface PendingFounderAction {
  taskId: string;
  capabilityId: string;
  riskClass: string;
  ask: string;
  requestedBy: string;
  /** Digest the Approval Center must echo back on decide. */
  currentDigest: string;
  /** Digest recorded on the existing approval row, if any. */
  approvedDigest: string | null;
  /** True when the action changed after the Founder was asked. */
  staleDigest: boolean;
  expiresAt: string | null;
  expired: boolean;
  meta: TaskMeta;
}

export interface OperationsSnapshot {
  generatedAt: string;
  /** Global + per-capability kill switch rows that are currently engaged. */
  killSwitches: KillSwitchState[];
  killSwitchEngagedGlobally: boolean;
  /** Tasks the Founder must decide on, with digest/expiry surfaced. */
  waitingForFounder: PendingFounderAction[];
  /** Held by a worker right now. */
  inFlight: AttentionTask[];
  /** Result submitted, waiting on an INDEPENDENT reviewer. */
  awaitingReview: AttentionTask[];
  /** Real-world outcome unknown — never retried blindly; needs reconciliation. */
  outcomeUnknown: AttentionTask[];
  /** Blocked, including approvals invalidated at the execution boundary. */
  blocked: AttentionTask[];
  /** In-flight work whose owning worker has been disabled/replaced. */
  handoverRequired: (AttentionTask & { disabledWorkerId: string })[];
}

const GLOBAL_SCOPE = '*';

export function operationsSnapshot(
  db: HqDatabase,
  ops: HeadquarterOperationsService,
  now: Date = new Date(),
): OperationsSnapshot {
  const killSwitches = readKillSwitches(db);
  const attention = (statuses: readonly ActivityStatus[], extra = ''): AttentionTask[] =>
    readTasks(db, ops, statuses, extra);

  const inFlight = attention(['assigned', 'running'], `AND review_state != 'pending'`);
  const awaitingReview = attention(['running'], `AND review_state = 'pending'`);

  const disabledWorkers = new Set(
    ops.store.listSpecialists().filter((w) => !w.active).map((w) => w.id),
  );
  const handoverRequired = [...inFlight, ...awaitingReview]
    .filter((t) => t.claimedBy && disabledWorkers.has(t.claimedBy))
    .map((t) => ({ ...t, disabledWorkerId: t.claimedBy! }));

  return {
    generatedAt: nowIso(),
    killSwitches,
    killSwitchEngagedGlobally: killSwitches.some((k) => k.scope === GLOBAL_SCOPE && k.engaged),
    waitingForFounder: readPendingFounderActions(db, ops, now),
    inFlight,
    awaitingReview,
    outcomeUnknown: attention(['outcome_unknown']),
    blocked: attention(['blocked']),
    handoverRequired,
  };
}

function readKillSwitches(db: HqDatabase): KillSwitchState[] {
  const rows = db
    .prepare(`SELECT * FROM op_kill_switch WHERE engaged = 1 ORDER BY scope`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    scope: r.scope as string,
    engaged: !!r.engaged,
    reason: (r.reason as string | null) ?? null,
    engagedBy: (r.engaged_by as string | null) ?? null,
    engagedAt: (r.engaged_at as string | null) ?? null,
  }));
}

function readTasks(
  db: HqDatabase,
  ops: HeadquarterOperationsService,
  statuses: readonly ActivityStatus[],
  extraWhere = '',
): AttentionTask[] {
  const rows = db
    .prepare(
      `SELECT id FROM op_tasks
       WHERE status IN (${statuses.map(() => '?').join(',')}) ${extraWhere}
       ORDER BY updated_at DESC`,
    )
    .all(...statuses) as { id: string }[];
  return rows.flatMap((row) => {
    const task = ops.getTask(row.id);
    if (!task) return [];
    return [
      {
        taskId: task.id,
        capabilityId: task.capabilityId,
        status: task.status,
        claimedBy: task.claimedBy,
        leaseExpiresAt: task.leaseExpiresAt,
        fence: task.fence,
        reviewState: task.reviewState,
        blockReason: task.blockReason,
        meta: ops.readMeta(task.id),
      },
    ];
  });
}

function readPendingFounderActions(
  db: HqDatabase,
  ops: HeadquarterOperationsService,
  now: Date,
): PendingFounderAction[] {
  const rows = db
    .prepare(`SELECT id FROM op_tasks WHERE status = 'needs_approval' ORDER BY created_at`)
    .all() as { id: string }[];
  return rows.flatMap((row) => {
    const task = ops.getTask(row.id);
    if (!task) return [];
    const capability = ops.queue.capabilities.get(task.capabilityId);
    const approval = task.approvalId
      ? (db
          .prepare(`SELECT action_digest, expires_at FROM hq_approvals WHERE id = ?`)
          .get(task.approvalId) as { action_digest: string | null; expires_at: string | null } | undefined)
      : undefined;
    const currentDigest = taskActionDigest(task);
    return [
      {
        taskId: task.id,
        capabilityId: task.capabilityId,
        riskClass: capability?.riskClass ?? 'unknown',
        ask: `Execute ${task.capabilityId}`,
        requestedBy: task.createdBy,
        currentDigest,
        approvedDigest: approval?.action_digest ?? null,
        staleDigest: !!approval?.action_digest && approval.action_digest !== currentDigest,
        expiresAt: approval?.expires_at ?? null,
        expired: approval ? approvalExpiredAt({ expiresAt: approval.expires_at ?? null }, now) : false,
        meta: ops.readMeta(task.id),
      },
    ];
  });
}
