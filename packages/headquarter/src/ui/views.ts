/**
 * Founder dashboard view computation (issue #43, order 1).
 *
 * Derives NOW / DONE TODAY / BLOCKED / WAITING FOR FOUNDER / NEXT,
 * worker status, project cards, and project timelines from the canonical
 * activity contract (§6b) — presentation never invents state.
 */

import type { ActivityEvent, ActivityStatus } from '../contracts/events.js';
import type { TaskState } from './model.js';
import { eventProject } from './model.js';

export interface FounderDashboard {
  now: TaskState[];
  doneToday: TaskState[];
  blocked: TaskState[];
  waitingForFounder: TaskState[];
  next: TaskState[];
}

/** Dashboard bucket per status. review_failed/review_passed are active work; outcome_unknown demands attention. */
export const DASHBOARD_BUCKET: Record<ActivityStatus, keyof FounderDashboard | 'done'> = {
  queued: 'next',
  assigned: 'now',
  running: 'now',
  review_failed: 'now',
  review_passed: 'now',
  blocked: 'blocked',
  outcome_unknown: 'blocked',
  needs_approval: 'waitingForFounder',
  completed: 'done',
};

export function founderDashboard(states: TaskState[], todayUtcDate: string): FounderDashboard {
  const dashboard: FounderDashboard = { now: [], doneToday: [], blocked: [], waitingForFounder: [], next: [] };
  for (const state of states) {
    const bucket = DASHBOARD_BUCKET[state.status];
    if (bucket === 'done') {
      if (state.updatedAt.startsWith(todayUtcDate)) dashboard.doneToday.push(state);
    } else {
      dashboard[bucket].push(state);
    }
  }
  return dashboard;
}

export interface WorkerStatus {
  worker: string;
  /** The task currently in an active status, if any. */
  activeTask: TaskState | null;
  activeCount: number;
  blockedCount: number;
  completedCount: number;
  lastSeen: string;
}

const ACTIVE_STATUSES: ActivityStatus[] = ['assigned', 'running', 'review_failed', 'review_passed'];

export function workerStatuses(states: TaskState[]): WorkerStatus[] {
  const byWorker = new Map<string, WorkerStatus>();
  for (const state of states) {
    const status = byWorker.get(state.worker) ?? {
      worker: state.worker,
      activeTask: null,
      activeCount: 0,
      blockedCount: 0,
      completedCount: 0,
      lastSeen: state.updatedAt,
    };
    if (ACTIVE_STATUSES.includes(state.status)) {
      status.activeCount += 1;
      if (!status.activeTask || state.updatedAt > status.activeTask.updatedAt) status.activeTask = state;
    }
    if (state.status === 'blocked' || state.status === 'outcome_unknown') status.blockedCount += 1;
    if (state.status === 'completed') status.completedCount += 1;
    if (state.updatedAt > status.lastSeen) status.lastSeen = state.updatedAt;
    byWorker.set(state.worker, status);
  }
  return [...byWorker.values()].sort((a, b) => a.worker.localeCompare(b.worker));
}

export interface ProjectCard {
  project: string;
  openCount: number;
  blockedCount: number;
  waitingForFounderCount: number;
  completedCount: number;
  lastActivity: string;
}

export function projectCards(states: TaskState[]): ProjectCard[] {
  const byProject = new Map<string, ProjectCard>();
  for (const state of states) {
    const card = byProject.get(state.project) ?? {
      project: state.project,
      openCount: 0,
      blockedCount: 0,
      waitingForFounderCount: 0,
      completedCount: 0,
      lastActivity: state.updatedAt,
    };
    const bucket = DASHBOARD_BUCKET[state.status];
    if (bucket === 'done') card.completedCount += 1;
    else card.openCount += 1;
    if (bucket === 'blocked') card.blockedCount += 1;
    if (bucket === 'waitingForFounder') card.waitingForFounderCount += 1;
    if (state.updatedAt > card.lastActivity) card.lastActivity = state.updatedAt;
    byProject.set(state.project, card);
  }
  return [...byProject.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/** Chronological task-event timeline for one project (by canonical seq). */
export function projectTimeline(events: ActivityEvent[], project: string): ActivityEvent[] {
  return events
    .filter((event) => event.subjectKind === 'task' && eventProject(event) === project)
    .sort((a, b) => a.seq - b.seq);
}
