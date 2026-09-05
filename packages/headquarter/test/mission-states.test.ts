/**
 * Mission states — the one new state machine of Phase 3 (issue #254, D2).
 *
 * What is proven here, and only here: the table is total over the vocabulary,
 * every listed edge is allowed, every unlisted edge is refused, the two
 * terminal states are exactly `complete` and `cancelled`, and `failed`'s exits
 * are the two the module docstring commits to.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertMissionTransition,
  canMissionTransition,
  isMissionState,
  isMissionTerminal,
  isRecordedMissionEdgeLegal,
  MISSION_STATE_LABELS,
  MISSION_STATES,
  MISSION_TRANSITIONS,
  type MissionState,
} from '../src/mission/states.js';

describe('the mission transition table', () => {
  it('holds exactly these edges, written out — no more, no fewer', () => {
    // Mutation-testing pass on `b3f72d1`, P1.1. The test below this one
    // computes `listed` from the table and compares it to `canMissionTransition`
    // — which IS `MISSION_TRANSITIONS[from].includes(to)`. That proves the
    // function agrees with the table and nothing about the table. Proven by
    // mutation: adding `verified` to `working` — a mission declared
    // Founder-verified without ever passing through `ready_review` — passed
    // every test. Only the terminal set, `failed`'s two exits and
    // complete-only-from-verified were genuinely pinned.
    //
    // This is the pin: the CONTENTS, as a literal. An edge added or removed
    // anywhere in the table fails here, and the docstring in `states.ts` has
    // to be argued with before this expectation is changed.
    const EXPECTED: Record<MissionState, readonly MissionState[]> = {
      planned: ['working', 'blocked', 'cancelled'],
      working: ['blocked', 'ready_review', 'failed', 'cancelled'],
      blocked: ['planned', 'working', 'failed', 'cancelled'],
      ready_review: ['verified', 'working', 'blocked', 'failed', 'cancelled'],
      verified: ['complete', 'working', 'cancelled'],
      complete: [],
      failed: ['planned', 'cancelled'],
      cancelled: [],
    };
    expect(MISSION_TRANSITIONS).toEqual(EXPECTED);
    // And the reviewer's exact mutation, named: working never reaches verified.
    expect(canMissionTransition('working', 'verified')).toBe(false);
  });

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

  it('states the one self-edge the HISTORY may hold, and refuses every other', () => {
    // Mutation-testing pass on `b3f72d1`. The table lists no self-edge, and
    // the assertion above says so — but `amendMission` records
    // `blocked → blocked` when an amendment leaves a plan-less mission still
    // unreadable (a reason refresh with its own history row), and
    // `recordTransition` never consulted the table, so the two statements
    // contradicted each other and nothing said which was right.
    // `isRecordedMissionEdgeLegal` is the explicit statement: genesis, a
    // table edge, or that one documented refresh. Nothing else.
    for (const state of MISSION_STATES) {
      expect(isRecordedMissionEdgeLegal(null, state), `genesis -> ${state}`).toBe(true);
      expect(isRecordedMissionEdgeLegal(state, state), `${state} -> ${state}`).toBe(state === 'blocked');
      for (const to of MISSION_STATES) {
        if (to === state) continue;
        expect(isRecordedMissionEdgeLegal(state, to), `${state} -> ${to}`).toBe(canMissionTransition(state, to));
      }
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

  it('labels verified as the Founder’s own record, never as independent verification', () => {
    // Opus second pass on `a849af8`. `verified` read "Reviewed and accepted"
    // in the docstring and "Verified" in the label, and both implied a review
    // the mission core does not perform: there is no independence bar, and
    // the same principal that placed a mission may record it verified and
    // complete. That is deliberate — enforcing a second reviewer would
    // deadlock a single-Founder deployment — and it is left as an OPEN
    // product question for the Founder rather than decided here. What is
    // fixed is the honesty: the label says whose record it is, and no UI
    // surface that renders a mission state claims independent verification.
    expect(MISSION_STATE_LABELS.verified).not.toBe('Verified');
    expect(MISSION_STATE_LABELS.verified).toMatch(/founder/i);
    const states = readFileSync(fileURLToPath(new URL('../src/mission/states.ts', import.meta.url)), 'utf8');
    expect(states).toContain("Founder's own record");
    expect(states).toContain('NOT an independent review');
    for (const file of ['../src/ui/control-console.ts', '../src/client/hydrate.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/independent(ly)?[ -]verif/i);
    }
  });
});
