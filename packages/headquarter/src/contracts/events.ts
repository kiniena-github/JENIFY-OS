/**
 * Canonical activity/event model for Stream 2 (war room #41, order B).
 *
 * Every worker/task/project status anywhere in Headquarter or the Universal
 * Operator MUST be expressed in these statuses. UI layers (Jules) and
 * reviewers (Codex) consume this contract; they never invent parallel status
 * vocabularies.
 */

export const ACTIVITY_STATUSES = [
  'queued',
  'assigned',
  'running',
  'blocked',
  'needs_approval',
  'review_failed',
  'review_passed',
  'completed',
  'outcome_unknown',
] as const;

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/**
 * Allowed status transitions. Anything not listed here is rejected.
 *
 * Notes:
 * - `completed` is the only terminal status.
 * - This table is necessary but NOT sufficient: it is capability-blind, so
 *   the operator queue adds capability-aware enforcement on top of it
 *   (issue #53 correction B). `running -> completed` directly is legal only
 *   for read-only, no-side-effect capabilities; a side-effect execution's
 *   reported result waits in a review-gated path (reviewState 'pending')
 *   and only an INDEPENDENT reviewer decision (never the executing worker)
 *   moves it through review_passed to completed. Approval-gated tasks are
 *   additionally re-validated against the Founder-approved action digest at
 *   the claim/start execution boundary (correction A).
 * - `assigned -> needs_approval` exists only for the start-time approval
 *   revalidation (issue #71): an approval that was valid when the task was
 *   claimed can expire before the worker actually starts; the claimed task
 *   is then released and returned for a fresh Founder decision instead of
 *   executing on a stale approval.
 * - `outcome_unknown` is NEVER blindly retried. It leaves only through an
 *   explicit reconciliation decision (see operator/queue.ts):
 *   confirmed-done -> completed, confirmed-failed -> review_failed,
 *   confirmed-not-executed (idempotent capability only) -> queued.
 * - A denied approval goes to `blocked` (with the denial reason), never
 *   silently back to `queued`.
 */
export const ALLOWED_TRANSITIONS: Record<ActivityStatus, readonly ActivityStatus[]> = {
  queued: ['assigned', 'blocked', 'needs_approval'],
  assigned: ['running', 'queued', 'blocked', 'needs_approval'],
  running: [
    'blocked',
    'needs_approval',
    'review_failed',
    'review_passed',
    'completed',
    'outcome_unknown',
  ],
  blocked: ['queued', 'assigned', 'running'],
  needs_approval: ['queued', 'assigned', 'running', 'blocked'],
  review_failed: ['queued', 'assigned', 'running'],
  review_passed: ['completed'],
  completed: [],
  outcome_unknown: ['completed', 'review_failed', 'queued'],
};

export function isActivityStatus(value: string): value is ActivityStatus {
  return (ACTIVITY_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ActivityStatus, to: ActivityStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ActivityStatus, to: ActivityStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal activity transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: ActivityStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/**
 * What kind of thing an event is about.
 *
 * `mission` (Phase 3, issue #253) is a Founder-commanded mission. Mission
 * events are ANNOTATIONS — `status` is always null on them — because the
 * mission vocabulary (planned / working / blocked / …) is not the task
 * vocabulary this envelope's `status` field is typed with, and copying one
 * into the other would let a Command Center lane file a mission as if it were
 * a task. The mission's own state travels in `detail.missionStatus`.
 */
export type ActivitySubjectKind = 'task' | 'project' | 'worker' | 'approval' | 'system' | 'mission';

/**
 * The canonical event envelope. Events are immutable facts; the append-only
 * event log is the source of truth, and every dashboard/read model is derived
 * from it.
 */
export interface ActivityEvent {
  /** UUID of this event. */
  id: string;
  /** Monotonic per-store sequence assigned at append time. */
  seq: number;
  /** ISO-8601 UTC timestamp assigned at append time. */
  at: string;
  subjectKind: ActivitySubjectKind;
  /** Stable id of the task/project/worker/approval the event is about. */
  subjectId: string;
  /** Status the subject moved to (null for pure annotations, e.g. notes). */
  status: ActivityStatus | null;
  /** Actor that caused the event: worker id, 'founder', or 'system'. */
  actor: string;
  /** Short human-readable summary. Never contains secrets. */
  summary: string;
  /** Optional structured detail (JSON-serializable). Never contains secrets. */
  detail?: Record<string, unknown>;
  /** Related evidence: issue/PR URLs, commit SHAs, artifact paths. */
  refs?: string[];
}

export type NewActivityEvent = Omit<ActivityEvent, 'id' | 'seq' | 'at'>;
