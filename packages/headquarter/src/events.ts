/**
 * Canonical activity/event model for Stream 2 (war room #41, order B).
 *
 * Every worker/task state change across the company infrastructure is
 * expressed as one append-only ActivityEvent. A task's current state is the
 * latest event for its taskId; nothing is ever edited or deleted.
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

export function isActivityStatus(value: unknown): value is ActivityStatus {
  return typeof value === 'string' && (ACTIVITY_STATUSES as readonly string[]).includes(value);
}

/** Cross-links to durable evidence. Identifiers only — never copies. */
export interface RelatedRefs {
  issues?: number[];
  pullRequests?: number[];
  commits?: string[];
  /** Free-form artifact locators (file paths, report names, Drive ids later). */
  artifacts?: string[];
}

export interface ActivityEvent {
  /** Unique event id (append-only; never reused). */
  id: string;
  /** Stable id of the task this event belongs to, e.g. "JENIFY-OS#43". */
  taskId: string;
  /** Project the task belongs to, e.g. "JENIFY-OS", "QOS", "Jenify News". */
  project: string;
  /** Human-readable task title. */
  title: string;
  /** Worker lane: "claude" | "jules" | "codex" | "chatgpt" | "gemini" | "founder" | ... */
  worker: string;
  status: ActivityStatus;
  /** ISO-8601 UTC instant. */
  occurredAt: string;
  detail?: string;
  refs?: RelatedRefs;
}

export interface TaskState {
  taskId: string;
  project: string;
  title: string;
  worker: string;
  status: ActivityStatus;
  /** occurredAt of the latest event. */
  updatedAt: string;
  detail?: string;
  refs?: RelatedRefs;
  /** Full ordered event history for the task (oldest first). */
  history: ActivityEvent[];
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function validateActivityEvent(event: ActivityEvent): string[] {
  const errors: string[] = [];
  if (!event.id) errors.push('id is required');
  if (!event.taskId) errors.push('taskId is required');
  if (!event.project) errors.push('project is required');
  if (!event.title) errors.push('title is required');
  if (!event.worker) errors.push('worker is required');
  if (!isActivityStatus(event.status)) errors.push(`status must be one of: ${ACTIVITY_STATUSES.join(', ')}`);
  if (!event.occurredAt || !ISO_UTC.test(event.occurredAt)) {
    errors.push('occurredAt must be an ISO-8601 instant with timezone');
  }
  return errors;
}

/**
 * Reduce an event stream to the latest state per task.
 * Events are ordered by occurredAt (ties broken by array order, later wins).
 */
export function latestTaskStates(events: ActivityEvent[]): TaskState[] {
  const byTask = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const list = byTask.get(event.taskId) ?? [];
    list.push(event);
    byTask.set(event.taskId, list);
  }
  const states: TaskState[] = [];
  for (const [taskId, list] of byTask) {
    const ordered = [...list].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const last = ordered[ordered.length - 1];
    states.push({
      taskId,
      project: last.project,
      title: last.title,
      worker: last.worker,
      status: last.status,
      updatedAt: last.occurredAt,
      detail: last.detail,
      refs: last.refs,
      history: ordered,
    });
  }
  return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
