/**
 * UI view-model layer (issue #43, adapted per issue #53 correction D /
 * architecture doc §6b).
 *
 * Derives presentation state from the ONE canonical activity contract in
 * `../contracts/events.ts` — this file defines no parallel status
 * vocabulary and no second event envelope. Events with subjectKind 'task'
 * drive the Founder dashboard; status:null annotation events stay in
 * history without changing state.
 */

import type { ActivityEvent, ActivityStatus } from '../contracts/events.js';

/** Derived read model of one task, computed from canonical events only. */
export interface TaskState {
  taskId: string;
  /** From the latest event's detail.project, else 'unassigned'. */
  project: string;
  /** From the latest event's detail.title, else its summary. */
  title: string;
  /** Actor of the latest status-bearing event. */
  worker: string;
  status: ActivityStatus;
  /** `at` of the latest status-bearing event. */
  updatedAt: string;
  refs?: string[];
  /** Full ordered event history for the task (by seq, oldest first). */
  history: ActivityEvent[];
}

function stringDetail(event: ActivityEvent, key: string): string | undefined {
  const value = event.detail?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Project a task event claims to belong to. */
export function eventProject(event: ActivityEvent): string {
  return stringDetail(event, 'project') ?? 'unassigned';
}

/**
 * Reduce the canonical event log to the latest state per task.
 * Ordering follows the store's monotonic `seq`.
 */
export function latestTaskStates(events: ActivityEvent[]): TaskState[] {
  const byTask = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    if (event.subjectKind !== 'task') continue;
    const list = byTask.get(event.subjectId) ?? [];
    list.push(event);
    byTask.set(event.subjectId, list);
  }
  const states: TaskState[] = [];
  for (const [taskId, list] of byTask) {
    const ordered = [...list].sort((a, b) => a.seq - b.seq);
    const statusEvents = ordered.filter((event) => event.status !== null);
    if (statusEvents.length === 0) continue; // annotations only — no state yet
    const last = statusEvents[statusEvents.length - 1];
    states.push({
      taskId,
      project: eventProject(last),
      title: stringDetail(last, 'title') ?? last.summary,
      worker: last.actor,
      status: last.status as ActivityStatus,
      updatedAt: last.at,
      refs: last.refs,
      history: ordered,
    });
  }
  return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
