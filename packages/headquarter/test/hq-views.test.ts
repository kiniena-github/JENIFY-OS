import { describe, expect, it } from 'vitest';
import { latestTaskStates, type ActivityEvent } from '../src/events.js';
import { founderDashboard, workerStatuses, projectCards, projectTimeline } from '../src/hq/views.js';

function event(partial: Partial<ActivityEvent> & Pick<ActivityEvent, 'id' | 'taskId' | 'status' | 'occurredAt'>): ActivityEvent {
  return {
    project: 'JENIFY-OS',
    title: partial.taskId,
    worker: 'claude',
    ...partial,
  };
}

const EVENTS: ActivityEvent[] = [
  event({ id: 'e1', taskId: 't-run', status: 'queued', occurredAt: '2026-08-26T08:00:00Z' }),
  event({ id: 'e2', taskId: 't-run', status: 'running', occurredAt: '2026-08-26T09:00:00Z' }),
  event({ id: 'e3', taskId: 't-queued', status: 'queued', occurredAt: '2026-08-26T09:10:00Z', worker: 'jules' }),
  event({ id: 'e4', taskId: 't-blocked', status: 'blocked', occurredAt: '2026-08-26T09:20:00Z', worker: 'jules' }),
  event({ id: 'e5', taskId: 't-approval', status: 'needs_approval', occurredAt: '2026-08-26T09:30:00Z' }),
  event({ id: 'e6', taskId: 't-unknown', status: 'outcome_unknown', occurredAt: '2026-08-26T09:40:00Z', worker: 'codex' }),
  event({ id: 'e7', taskId: 't-rework', status: 'review_failed', occurredAt: '2026-08-26T09:50:00Z' }),
  event({ id: 'e8', taskId: 't-done-today', status: 'completed', occurredAt: '2026-08-26T07:00:00Z' }),
  event({ id: 'e9', taskId: 't-done-old', status: 'completed', occurredAt: '2026-08-25T07:00:00Z', project: 'QOS' }),
];

describe('latestTaskStates', () => {
  it('keeps only the latest event per task with full history', () => {
    const states = latestTaskStates(EVENTS);
    const running = states.find((state) => state.taskId === 't-run');
    expect(running?.status).toBe('running');
    expect(running?.history.map((historyEvent) => historyEvent.id)).toEqual(['e1', 'e2']);
  });
});

describe('founderDashboard', () => {
  const dashboard = founderDashboard(latestTaskStates(EVENTS), '2026-08-26');

  it('maps NOW / NEXT / BLOCKED / WAITING FOR FOUNDER buckets', () => {
    expect(dashboard.now.map((state) => state.taskId).sort()).toEqual(['t-rework', 't-run']);
    expect(dashboard.next.map((state) => state.taskId)).toEqual(['t-queued']);
    expect(dashboard.blocked.map((state) => state.taskId).sort()).toEqual(['t-blocked', 't-unknown']);
    expect(dashboard.waitingForFounder.map((state) => state.taskId)).toEqual(['t-approval']);
  });

  it('DONE TODAY includes only completions on the given UTC date', () => {
    expect(dashboard.doneToday.map((state) => state.taskId)).toEqual(['t-done-today']);
  });
});

describe('workerStatuses', () => {
  it('rolls up per-worker activity with the current task', () => {
    const workers = workerStatuses(latestTaskStates(EVENTS));
    const claude = workers.find((worker) => worker.worker === 'claude');
    expect(claude?.activeCount).toBe(2);
    expect(claude?.activeTask?.taskId).toBe('t-rework');
    expect(claude?.completedCount).toBe(2);
    const codex = workers.find((worker) => worker.worker === 'codex');
    expect(codex?.blockedCount).toBe(1);
    expect(codex?.activeTask).toBeNull();
  });
});

describe('projectCards and timeline', () => {
  it('aggregates per project and orders timelines chronologically', () => {
    const cards = projectCards(latestTaskStates(EVENTS));
    const os = cards.find((card) => card.project === 'JENIFY-OS');
    expect(os).toMatchObject({ openCount: 6, blockedCount: 2, waitingForFounderCount: 1, completedCount: 1 });
    const timeline = projectTimeline(EVENTS, 'QOS');
    expect(timeline.map((timelineEvent) => timelineEvent.id)).toEqual(['e9']);
  });
});
