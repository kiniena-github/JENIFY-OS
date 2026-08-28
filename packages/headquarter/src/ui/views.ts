/**
 * Founder dashboard view computation (issue #43, order 1).
 *
 * Derives NOW / DONE TODAY / BLOCKED / WAITING FOR FOUNDER / NEXT,
 * worker status, project cards, and project timelines from the canonical
 * activity contract (§6b) — presentation never invents state.
 */

import type { ActivityEvent, ActivityStatus } from '../contracts/events.js';
import type { WorkerDescriptor } from '../contracts/workers.js';
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

/* ------------------------------------------------------------------ */
/* Issue #138 — richer executive read models                           */
/*                                                                     */
/* Everything below is DERIVED from the same canonical task states and  */
/* activity events already used above. Nothing here invents a field: if */
/* the canonical data cannot answer a question, the model returns null  */
/* and the UI omits the block rather than filling it in.                */
/* ------------------------------------------------------------------ */

/**
 * Health of a project, derived strictly from the counts already present in
 * its card. It is a rendering of recorded task state, not a judgement:
 *   blocked        — at least one blocked/outcome_unknown task
 *   needs_founder  — nothing blocked, but a task is waiting on the Founder
 *   active         — open work with no blockers and no Founder gate
 *   idle           — no open tasks recorded at all
 */
export type ProjectHealth = 'blocked' | 'needs_founder' | 'active' | 'idle';

export function projectHealth(card: ProjectCard): ProjectHealth {
  if (card.blockedCount > 0) return 'blocked';
  if (card.waitingForFounderCount > 0) return 'needs_founder';
  return card.openCount > 0 ? 'active' : 'idle';
}

export interface ProjectBoardCard extends ProjectCard {
  health: ProjectHealth;
  /** Tasks recorded for the project (open + completed). */
  totalCount: number;
  /**
   * Share of RECORDED tasks that are completed, 0–1. This is deliberately not
   * called "project completion": the archive only knows about tasks that have
   * produced canonical events.
   */
  completedShare: number;
  /** Distinct workers holding an active task on this project. */
  activeWorkers: string[];
  /** Blocked / outcome-unknown tasks, newest first. */
  blockers: TaskState[];
  /** Most recently completed task, if any. */
  latestCompleted: TaskState | null;
  /** Oldest queued task — the next thing recorded as due to start. */
  nextQueued: TaskState | null;
  /** Most recently updated task of any status. */
  latestUpdate: TaskState | null;
}

export function projectBoard(states: TaskState[]): ProjectBoardCard[] {
  const cards = projectCards(states);
  return cards.map((card) => {
    const inProject = states.filter((state) => state.project === card.project);
    const byNewest = [...inProject].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const completed = byNewest.filter((state) => state.status === 'completed');
    const queued = inProject
      .filter((state) => state.status === 'queued')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const totalCount = card.openCount + card.completedCount;
    return {
      ...card,
      health: projectHealth(card),
      totalCount,
      completedShare: totalCount === 0 ? 0 : card.completedCount / totalCount,
      activeWorkers: [
        ...new Set(
          byNewest.filter((state) => ACTIVE_STATUSES.includes(state.status)).map((state) => state.worker),
        ),
      ].sort(),
      blockers: byNewest.filter((state) => state.status === 'blocked' || state.status === 'outcome_unknown'),
      latestCompleted: completed[0] ?? null,
      nextQueued: queued[0] ?? null,
      latestUpdate: byNewest[0] ?? null,
    };
  });
}

/** Why an item sits in the Founder's queue. Mirrors the canonical status. */
export type AttentionReason = 'needs_approval' | 'blocked' | 'outcome_unknown';

export interface AttentionItem {
  state: TaskState;
  reason: AttentionReason;
}

/**
 * The Founder attention queue: everything that cannot move without a human.
 * Approval gates come first (only the Founder can clear them), then blocked
 * work; within each group the oldest item is first, because waiting longest
 * is the thing most likely to be forgotten.
 */
export function founderAttentionQueue(dashboard: FounderDashboard): AttentionItem[] {
  const order: Record<AttentionReason, number> = { needs_approval: 0, blocked: 1, outcome_unknown: 1 };
  const items: AttentionItem[] = [
    ...dashboard.waitingForFounder.map((state) => ({ state, reason: 'needs_approval' as const })),
    ...dashboard.blocked.map((state) => ({
      state,
      reason: (state.status === 'outcome_unknown' ? 'outcome_unknown' : 'blocked') as AttentionReason,
    })),
  ];
  return items.sort(
    (a, b) => order[a.reason] - order[b.reason] || a.state.updatedAt.localeCompare(b.state.updatedAt),
  );
}

/**
 * Recent canonical activity across every subject, newest first. Annotation
 * events (status null) are included: they are real recorded activity even
 * though they never change task state.
 */
export function activityFeed(events: ActivityEvent[], limit = 12): ActivityEvent[] {
  return [...events].sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, limit));
}

export interface SpecialistProfile {
  descriptor: WorkerDescriptor;
  /** Live workload derived from canonical events; null when nothing recorded. */
  status: WorkerStatus | null;
}

/**
 * Join the registered specialist directory with the workload derived from
 * canonical events. Workers that appear in events but are not registered are
 * NOT invented as specialists — they surface on the Command Center workforce
 * strip instead, where the source is the event log itself.
 */
export function specialistProfiles(
  specialists: WorkerDescriptor[],
  statuses: WorkerStatus[],
): SpecialistProfile[] {
  const byWorker = new Map(statuses.map((status) => [status.worker, status]));
  return specialists.map((descriptor) => ({
    descriptor,
    status: byWorker.get(descriptor.id) ?? null,
  }));
}
