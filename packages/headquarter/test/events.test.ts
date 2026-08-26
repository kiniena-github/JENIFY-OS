import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_STATUSES,
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
} from '../src/contracts/events.js';

describe('canonical activity model', () => {
  it('has exactly the nine Founder-approved statuses', () => {
    expect([...ACTIVITY_STATUSES].sort()).toEqual(
      [
        'queued',
        'assigned',
        'running',
        'blocked',
        'needs_approval',
        'review_failed',
        'review_passed',
        'completed',
        'outcome_unknown',
      ].sort(),
    );
  });

  it('completed is the only terminal status', () => {
    for (const s of ACTIVITY_STATUSES) {
      expect(isTerminal(s)).toBe(s === 'completed');
    }
  });

  it('every transition target is itself a canonical status', () => {
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const t of targets) expect(ACTIVITY_STATUSES).toContain(t);
    }
  });

  it('allows the normal happy path', () => {
    expect(canTransition('queued', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'running')).toBe(true);
    expect(canTransition('running', 'review_passed')).toBe(true);
    expect(canTransition('review_passed', 'completed')).toBe(true);
  });

  it('rejects illegal jumps', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('outcome_unknown', 'running')).toBe(false);
    expect(() => assertTransition('queued', 'completed')).toThrow(/Illegal/);
  });

  it('outcome_unknown resolves only via explicit reconciliation targets', () => {
    expect([...ALLOWED_TRANSITIONS.outcome_unknown].sort()).toEqual(
      ['completed', 'queued', 'review_failed'].sort(),
    );
  });
});
