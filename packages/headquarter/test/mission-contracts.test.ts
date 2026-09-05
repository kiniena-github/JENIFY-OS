import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_STATUSES,
  type ActivityStatus,
} from '../src/contracts/events.js';
import {
  MISSION_ALLOWED_TRANSITIONS,
  MISSION_NOTE_REQUIRED_TARGETS,
  MISSION_PRIORITIES,
  MISSION_STATUSES,
  MISSION_VERIFICATION_METHODS,
  assertMissionTransition,
  canTransitionMission,
  isMissionPriority,
  isMissionStatus,
  isMissionTerminal,
  planItemStateFromTask,
} from '../src/contracts/mission.js';

describe('canonical mission lifecycle (issue #254)', () => {
  it('has exactly the eight binding mission states', () => {
    expect([...MISSION_STATUSES].sort()).toEqual(
      [
        'planned',
        'working',
        'blocked',
        'ready_review',
        'verified',
        'complete',
        'failed',
        'cancelled',
      ].sort(),
    );
  });

  it('complete, failed and cancelled are exactly the terminal states', () => {
    for (const s of MISSION_STATUSES) {
      expect(isMissionTerminal(s)).toBe(s === 'complete' || s === 'failed' || s === 'cancelled');
    }
  });

  it('every transition target is itself a canonical mission state', () => {
    for (const targets of Object.values(MISSION_ALLOWED_TRANSITIONS)) {
      for (const t of targets) expect(MISSION_STATUSES).toContain(t);
    }
  });

  it('the transition map covers every state as a source, exactly once each', () => {
    expect(Object.keys(MISSION_ALLOWED_TRANSITIONS).sort()).toEqual([...MISSION_STATUSES].sort());
  });

  it('allows the Founder-driven happy path', () => {
    expect(canTransitionMission('planned', 'working')).toBe(true);
    expect(canTransitionMission('working', 'ready_review')).toBe(true);
    expect(canTransitionMission('ready_review', 'verified')).toBe(true);
    expect(canTransitionMission('verified', 'complete')).toBe(true);
  });

  it('allows honest failure and closure everywhere non-terminal', () => {
    for (const s of MISSION_STATUSES) {
      if (isMissionTerminal(s)) continue;
      expect(canTransitionMission(s, 'cancelled')).toBe(true);
    }
    expect(canTransitionMission('working', 'failed')).toBe(true);
    expect(canTransitionMission('blocked', 'failed')).toBe(true);
    expect(canTransitionMission('ready_review', 'failed')).toBe(true);
  });

  it('rejects the jumps that would skip a recorded decision', () => {
    expect(canTransitionMission('planned', 'verified')).toBe(false);
    expect(canTransitionMission('planned', 'complete')).toBe(false);
    expect(canTransitionMission('working', 'verified')).toBe(false);
    expect(canTransitionMission('working', 'complete')).toBe(false);
    expect(canTransitionMission('ready_review', 'complete')).toBe(false);
    expect(() => assertMissionTransition('planned', 'complete')).toThrow(/Illegal/);
  });

  it('terminal states go nowhere — no resurrection edges', () => {
    for (const s of ['complete', 'failed', 'cancelled'] as const) {
      expect(MISSION_ALLOWED_TRANSITIONS[s]).toEqual([]);
      for (const t of MISSION_STATUSES) expect(canTransitionMission(s, t)).toBe(false);
    }
  });

  it('verified is reachable only from ready_review', () => {
    for (const s of MISSION_STATUSES) {
      expect(canTransitionMission(s, 'verified')).toBe(s === 'ready_review');
    }
  });

  it('the decision transitions all demand a recorded note', () => {
    expect([...MISSION_NOTE_REQUIRED_TARGETS].sort()).toEqual(
      ['blocked', 'cancelled', 'failed', 'verified'].sort(),
    );
  });

  it('verification has exactly one method and it is a human decision', () => {
    // The vocabulary having no machine member is load-bearing: a later phase
    // must first widen this list before any code path can claim
    // machine-verification (the ActorAuthentication pattern).
    expect(MISSION_VERIFICATION_METHODS).toEqual(['founder_decision']);
  });

  it('recognizes its own vocabulary and nothing else', () => {
    for (const s of MISSION_STATUSES) expect(isMissionStatus(s)).toBe(true);
    expect(isMissionStatus('paused')).toBe(false); // later-phase, deliberately absent
    expect(isMissionStatus('proposed')).toBe(false); // later-phase, deliberately absent
    expect(isMissionStatus('queued')).toBe(false); // task vocabulary, not mission
    for (const p of MISSION_PRIORITIES) expect(isMissionPriority(p)).toBe(true);
    expect(isMissionPriority('urgent')).toBe(false);
  });
});

describe('plan-item display adapter (presentation only, never storage)', () => {
  it('is total over every canonical task status, with and without pending review', () => {
    for (const status of ACTIVITY_STATUSES) {
      for (const pending of [false, true]) {
        const state = planItemStateFromTask(status, pending);
        expect(typeof state).toBe('string');
        expect(state.length).toBeGreaterThan(0);
      }
    }
  });

  it('maps each canonical status to the agreed #254 word', () => {
    const expected: Record<ActivityStatus, string> = {
      queued: 'waiting',
      assigned: 'working',
      running: 'working',
      needs_approval: 'needs_approval',
      blocked: 'blocked',
      review_failed: 'failed',
      review_passed: 'working',
      completed: 'completed',
      outcome_unknown: 'blocked',
    };
    for (const status of ACTIVITY_STATUSES) {
      expect(planItemStateFromTask(status, false)).toBe(expected[status]);
    }
  });

  it('a submitted result awaiting independent review reads needs_review', () => {
    expect(planItemStateFromTask('running', true)).toBe('needs_review');
  });

  it('pending review changes nothing outside the running state', () => {
    for (const status of ACTIVITY_STATUSES) {
      if (status === 'running') continue;
      expect(planItemStateFromTask(status, true)).toBe(planItemStateFromTask(status, false));
    }
  });

  it('never claims completion the canonical record has not made', () => {
    // review_passed is in flight until the queue records completed.
    expect(planItemStateFromTask('review_passed', false)).not.toBe('completed');
  });
});
