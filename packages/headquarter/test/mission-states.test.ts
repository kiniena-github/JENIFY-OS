/**
 * Mission states — the one new state machine of Phase 3 (issue #254, D2).
 *
 * What is proven here, and only here: the table is total over the vocabulary,
 * every listed edge is allowed, every unlisted edge is refused, the two
 * terminal states are exactly `complete` and `cancelled`, and `failed`'s exits
 * are the two the module docstring commits to.
 */

import { describe, expect, it } from 'vitest';
import {
  assertMissionTransition,
  canMissionTransition,
  isMissionState,
  isMissionTerminal,
  MISSION_STATE_LABELS,
  MISSION_STATES,
  MISSION_TRANSITIONS,
} from '../src/mission/states.js';

describe('the mission transition table', () => {
  it('is total: every state has an entry, and every target is a state', () => {
    for (const state of MISSION_STATES) {
      expect(MISSION_TRANSITIONS[state], state).toBeDefined();
      for (const target of MISSION_TRANSITIONS[state]) {
        expect(isMissionState(target), `${state} -> ${target}`).toBe(true);
      }
      expect(MISSION_STATE_LABELS[state].length, state).toBeGreaterThan(0);
    }
  });

  it('allows exactly the listed edges and refuses every other pair', () => {
    for (const from of MISSION_STATES) {
      for (const to of MISSION_STATES) {
        const listed = MISSION_TRANSITIONS[from].includes(to);
        expect(canMissionTransition(from, to), `${from} -> ${to}`).toBe(listed);
        if (listed) {
          expect(() => assertMissionTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertMissionTransition(from, to)).toThrow(/Illegal mission transition/);
        }
      }
    }
  });

  it('never lists a self-edge: a state change is a change', () => {
    for (const state of MISSION_STATES) {
      expect(MISSION_TRANSITIONS[state], state).not.toContain(state);
    }
  });

  it('makes complete and cancelled the only terminal states', () => {
    expect(MISSION_STATES.filter(isMissionTerminal).sort()).toEqual(['cancelled', 'complete']);
  });

  it('states failed’s exits deliberately: re-plan or cancel, never resume', () => {
    expect([...MISSION_TRANSITIONS.failed].sort()).toEqual(['cancelled', 'planned']);
    expect(canMissionTransition('failed', 'working')).toBe(false);
  });

  it('lets a blocked mission return to planned, which is how a clarified order gets its plan', () => {
    expect(canMissionTransition('blocked', 'planned')).toBe(true);
  });

  it('reaches complete only through verified', () => {
    for (const from of MISSION_STATES) {
      if (from === 'verified') continue;
      expect(canMissionTransition(from, 'complete'), from).toBe(false);
    }
  });

  it('refuses an unknown string as a state', () => {
    for (const hostile of ['done', 'Planned', '', 'queued', 'running']) {
      expect(isMissionState(hostile), hostile).toBe(false);
    }
  });
});
