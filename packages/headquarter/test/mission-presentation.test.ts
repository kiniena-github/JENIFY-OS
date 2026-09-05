/**
 * The canonical → mission-task presentation adapter (issue #254, D1).
 *
 * The decision under test: the issue's task words are a PRESENTATION of the
 * nine-value `ActivityStatus` + `reviewState`, not a second state machine.
 * So the adapter must be total, must be pure, must always carry the canonical
 * status beside the word, and the presentation vocabulary must never appear
 * as something the store persists.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATUSES } from '../src/contracts/events.js';
import {
  everyCanonicalStatus,
  impliedMissionState,
  MISSION_TASK_PRESENTATION_LABELS,
  MISSION_TASK_PRESENTATIONS,
  presentTaskState,
  REVIEW_STATES,
  type PresentedTaskState,
} from '../src/mission/presentation.js';

function at(status: PresentedTaskState['canonicalStatus'], review: PresentedTaskState['reviewState'] = 'none') {
  return presentTaskState(status, review);
}

describe('the adapter is total over canonical status × review state', () => {
  it('answers with a vocabulary word for every combination, and carries the canonical status', () => {
    expect([...everyCanonicalStatus()]).toEqual([...ACTIVITY_STATUSES]);
    for (const status of ACTIVITY_STATUSES) {
      for (const review of REVIEW_STATES) {
        const presented = presentTaskState(status, review);
        expect(MISSION_TASK_PRESENTATIONS, `${status}/${review}`).toContain(presented.presentation);
        expect(presented.canonicalStatus).toBe(status);
        expect(presented.reviewState).toBe(review);
        expect(MISSION_TASK_PRESENTATION_LABELS[presented.presentation].length).toBeGreaterThan(0);
      }
    }
  });

  it('is pure: the same inputs give the same answer', () => {
    expect(at('running', 'pending')).toEqual(at('running', 'pending'));
  });

  it('gives exactly this word for every one of the 36 combinations', () => {
    // Mutation-testing pass on `b3f72d1`. The totality test above proves an
    // ANSWER exists for every combination, and the spot-checks below pin the
    // word for eight of them. Making `blocked` + `passed` answer `waiting`
    // passed everything. Every cell is pinned here, as a literal table: the
    // row is the canonical status, the columns are none / pending / passed /
    // failed, and the only status whose word depends on the review state is
    // `running`.
    const EXPECTED: Record<(typeof ACTIVITY_STATUSES)[number], readonly [string, string, string, string]> = {
      queued: ['waiting', 'waiting', 'waiting', 'waiting'],
      assigned: ['working', 'working', 'working', 'working'],
      running: ['working', 'needs_review', 'working', 'working'],
      blocked: ['blocked', 'blocked', 'blocked', 'blocked'],
      needs_approval: ['needs_approval', 'needs_approval', 'needs_approval', 'needs_approval'],
      review_failed: ['failed', 'failed', 'failed', 'failed'],
      review_passed: ['working', 'working', 'working', 'working'],
      completed: ['completed', 'completed', 'completed', 'completed'],
      outcome_unknown: ['blocked', 'blocked', 'blocked', 'blocked'],
    };
    expect([...REVIEW_STATES]).toEqual(['none', 'pending', 'passed', 'failed']);
    let cells = 0;
    for (const status of ACTIVITY_STATUSES) {
      REVIEW_STATES.forEach((review, column) => {
        expect(presentTaskState(status, review).presentation, `${status}/${review}`).toBe(EXPECTED[status][column]);
        cells += 1;
      });
    }
    expect(cells).toBe(36);
  });

  it('anchors REVIEW_STATES to the canonical ReviewState type rather than restating it', () => {
    // A hand-copied `readonly ReviewState[]` is checked in one direction only:
    // each element must be a ReviewState, but a fifth ReviewState added to
    // `operator/queue.ts` would leave the tuple at four, compile cleanly, and
    // let the totality loop keep passing over 9×4 while the real space was
    // 9×5. The tuple is now the key set of a `Record<ReviewState, true>`,
    // which the compiler checks in both directions. This test reads the
    // source to make sure the anchor stays the anchor.
    const source = readFileSync(fileURLToPath(new URL('../src/mission/presentation.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/const REVIEW_STATE_KEYS: Record<ReviewState, true> = \{/);
    expect(source).toMatch(/export const REVIEW_STATES: readonly ReviewState\[\] = Object\.keys\(REVIEW_STATE_KEYS\)/);
  });
});

describe('the mappings that are easy to get wrong', () => {
  it('reads running + pending review as NEEDS REVIEW, never WORKING', () => {
    // The canonical console files this task in pendingReviews and excludes it
    // from inFlight: nobody is executing it (Codex round 13 on #250).
    expect(at('running', 'pending').presentation).toBe('needs_review');
    expect(at('running', 'none').presentation).toBe('working');
  });

  it('reads outcome_unknown as BLOCKED with a reconciliation note, never as failed or working', () => {
    const presented = at('outcome_unknown');
    expect(presented.presentation).toBe('blocked');
    expect(presented.note).toMatch(/reconciliation/i);
  });

  it('reads review_passed as WORKING with a note — it is not yet completed', () => {
    const presented = at('review_passed', 'passed');
    expect(presented.presentation).toBe('working');
    expect(presented.note).toMatch(/not there yet/);
  });

  it('maps the rest as a Founder would read them', () => {
    expect(at('queued').presentation).toBe('waiting');
    expect(at('assigned').presentation).toBe('working');
    expect(at('blocked').presentation).toBe('blocked');
    expect(at('needs_approval').presentation).toBe('needs_approval');
    expect(at('review_failed', 'failed').presentation).toBe('failed');
    expect(at('completed').presentation).toBe('completed');
  });
});

describe('what canonical tasks imply about a mission — derived, never written', () => {
  it('implies nothing for a mission with no task: zero is not "planned"', () => {
    expect(impliedMissionState([])).toBeNull();
  });

  it('ranks all-complete over everything, then failed, blocked, working, planned', () => {
    expect(impliedMissionState([at('completed'), at('completed')])).toBe('ready_review');
    expect(impliedMissionState([at('completed'), at('review_failed', 'failed'), at('blocked')])).toBe('failed');
    expect(impliedMissionState([at('completed'), at('blocked'), at('running')])).toBe('blocked');
    expect(impliedMissionState([at('completed'), at('outcome_unknown'), at('running')])).toBe('blocked');
    expect(impliedMissionState([at('completed'), at('running'), at('queued')])).toBe('working');
    expect(impliedMissionState([at('completed'), at('running', 'pending')])).toBe('working');
    expect(impliedMissionState([at('needs_approval'), at('queued')])).toBe('planned');
  });
});

describe('the presentation vocabulary is never persisted as state', () => {
  const src = (relative: string) =>
    readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');

  it('appears in no SQL the mission store or the schema writes', () => {
    const store = src('mission/store.ts');
    const ddl = src('store/db.ts');
    for (const word of ['needs_review', 'waiting']) {
      // The two words that exist ONLY in the presentation vocabulary; the
      // others (blocked, completed, …) are legitimately canonical strings.
      expect(store, word).not.toMatch(new RegExp(`'${word}'`));
      expect(ddl, word).not.toContain(word);
    }
  });

  it('has no transition table of its own — MISSION_TRANSITIONS is keyed by mission states only', async () => {
    // `working`, `blocked` and `failed` are words both vocabularies use, on
    // purpose; the four that exist ONLY as task presentation must not be keys
    // of any transition table.
    const states = await import('../src/mission/states.js');
    for (const word of ['waiting', 'needs_review', 'needs_approval', 'completed']) {
      expect(Object.keys(states.MISSION_TRANSITIONS), word).not.toContain(word);
    }
  });
});
