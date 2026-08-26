import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../src/contracts/events.js';
import { latestTaskStates } from '../src/ui/model.js';
import { founderDashboard, workerStatuses, projectCards, projectTimeline } from '../src/ui/views.js';

let seq = 0;
function event(
  partial: Partial<ActivityEvent> & Pick<ActivityEvent, 'id' | 'subjectId' | 'status' | 'at'>,
): ActivityEvent {
  seq += 1;
  return {
    seq,
    subjectKind: 'task',
    actor: 'claude',
    summary: partial.subjectId,
    detail: { project: 'JENIFY-OS', title: partial.subjectId },
    ...partial,
  };
}

const EVENTS: ActivityEvent[] = [
  event({ id: 'e1', subjectId: 't-run', status: 'queued', at: '2026-08-26T08:00:00Z' }),
  event({ id: 'e2', subjectId: 't-run', status: 'running', at: '2026-08-26T09:00:00Z' }),
  event({ id: 'e3', subjectId: 't-queued', status: 'queued', at: '2026-08-26T09:10:00Z', actor: 'jules' }),
  event({ id: 'e4', subjectId: 't-blocked', status: 'blocked', at: '2026-08-26T09:20:00Z', actor: 'jules' }),
  event({ id: 'e5', subjectId: 't-approval', status: 'needs_approval', at: '2026-08-26T09:30:00Z' }),
  event({ id: 'e6', subjectId: 't-unknown', status: 'outcome_unknown', at: '2026-08-26T09:40:00Z', actor: 'codex' }),
  event({ id: 'e7', subjectId: 't-rework', status: 'review_failed', at: '2026-08-26T09:50:00Z' }),
  event({ id: 'e8', subjectId: 't-done-today', status: 'completed', at: '2026-08-26T07:00:00Z' }),
  event({
    id: 'e9',
    subjectId: 't-done-old',
    status: 'completed',
    at: '2026-08-25T07:00:00Z',
    detail: { project: 'QOS', title: 't-done-old' },
  }),
  // Pure annotation: must appear in history but never change state.
  event({ id: 'e10', subjectId: 't-run', status: null, at: '2026-08-26T09:05:00Z', summary: 'progress note' }),
  // Non-task subject: never becomes a dashboard row.
  event({ id: 'e11', subjectId: 'claude', status: 'running', at: '2026-08-26T09:55:00Z', subjectKind: 'worker' }),
];

describe('latestTaskStates (canonical contract)', () => {
  it('keeps only the latest status-bearing event per task, ordered by seq', () => {
    const states = latestTaskStates(EVENTS);
    const running = states.find((state) => state.taskId === 't-run');
    expect(running?.status).toBe('running');
    expect(running?.history.map((historyEvent) => historyEvent.id)).toEqual(['e1', 'e2', 'e10']);
  });

  it('ignores non-task subjects and derives project/title/worker from the event', () => {
    const states = latestTaskStates(EVENTS);
    expect(states.some((state) => state.taskId === 'claude')).toBe(false);
    const old = states.find((state) => state.taskId === 't-done-old');
    expect(old).toMatchObject({ project: 'QOS', worker: 'claude', title: 't-done-old' });
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
  it('aggregates per project and orders timelines by canonical seq', () => {
    const cards = projectCards(latestTaskStates(EVENTS));
    const os = cards.find((card) => card.project === 'JENIFY-OS');
    expect(os).toMatchObject({ openCount: 6, blockedCount: 2, waitingForFounderCount: 1, completedCount: 1 });
    const timeline = projectTimeline(EVENTS, 'QOS');
    expect(timeline.map((timelineEvent) => timelineEvent.id)).toEqual(['e9']);
  });
});
