/**
 * Canonical task truth → mission-task presentation (issue #254, integration
 * decision D1).
 *
 * ## What this is, and what it is not
 *
 * The issue describes a mission's tasks in seven words: Waiting, Working,
 * Needs Review, Needs Approval, Completed, Blocked, Failed. Those words are
 * the right ones for a Founder to read. They are NOT a state machine, and this
 * module is where that decision is enforced rather than merely intended:
 *
 *   - The canonical truth about a task is, and stays, the nine-value
 *     `ActivityStatus` plus `reviewState` in `op_tasks`, moved only through
 *     `ALLOWED_TRANSITIONS` and the Operator's capability-aware checks on top.
 *   - This file is a TOTAL, PURE function from that truth to a presentation
 *     word. It is called at read time, on every read. Nothing persists its
 *     output, nothing reads its output back as authority, and there is no
 *     transition table over its output because its output is not a state.
 *
 * Adding a second table of "allowed presentation transitions" would have been
 * the duplicate state machine D1 forbids — two vocabularies for one lifecycle,
 * guaranteed to drift. `test/mission-presentation.test.ts` proves totality by
 * iterating every canonical status × review state and requiring an answer.
 *
 * ## The mapping, and the two cases worth explaining
 *
 * `running` with `reviewState: 'pending'` is NEEDS REVIEW, not WORKING. The
 * canonical console files that task in `pendingReviews` and deliberately
 * excludes it from `inFlight` (`application/console.ts`), because nobody is
 * executing it — the worker submitted a result and an independent reviewer
 * has not decided. Calling it "working" is the exact misreport the Mission
 * Room was corrected for once already (Codex round 13 on #250).
 *
 * `outcome_unknown` is BLOCKED, with its own note. It is not "failed" — the
 * side effect may well have happened — and it is not "working". It is a task
 * that will never be blindly retried and needs a human reconciliation
 * decision, which is precisely what a Founder reading "blocked" should go and
 * do.
 *
 * `review_passed` is WORKING with a note: review is done and the task is one
 * canonical transition from `completed`. It is not yet complete, and saying so
 * would be inventing a fact one step ahead of the record.
 */

import { ACTIVITY_STATUSES, type ActivityStatus } from '../contracts/events.js';
import type { ReviewState } from '../operator/queue.js';
import type { MissionState } from './states.js';

export const MISSION_TASK_PRESENTATIONS = [
  'waiting',
  'working',
  'needs_review',
  'needs_approval',
  'completed',
  'blocked',
  'failed',
] as const;

export type MissionTaskPresentation = (typeof MISSION_TASK_PRESENTATIONS)[number];

export const MISSION_TASK_PRESENTATION_LABELS: Record<MissionTaskPresentation, string> = {
  waiting: 'Waiting',
  working: 'Working',
  needs_review: 'Needs Review',
  needs_approval: 'Needs Approval',
  completed: 'Completed',
  blocked: 'Blocked',
  failed: 'Failed',
};

/** The review states a task row can carry. Restated as a tuple for the totality test. */
export const REVIEW_STATES: readonly ReviewState[] = ['none', 'pending', 'passed', 'failed'];

export interface PresentedTaskState {
  /** The presentation word. */
  presentation: MissionTaskPresentation;
  /** The canonical status it was derived from — always shown beside it. */
  canonicalStatus: ActivityStatus;
  reviewState: ReviewState;
  /** Why the word is the word, where the mapping is not obvious. Never a status claim. */
  note: string | null;
}

/**
 * The adapter. Total over `ActivityStatus × ReviewState`; the `switch` has no
 * default because TypeScript's exhaustiveness check IS the totality proof at
 * compile time, and the test repeats it at run time for the JavaScript caller.
 */
export function presentTaskState(status: ActivityStatus, reviewState: ReviewState): PresentedTaskState {
  const at = (presentation: MissionTaskPresentation, note: string | null = null): PresentedTaskState => ({
    presentation,
    canonicalStatus: status,
    reviewState,
    note,
  });
  switch (status) {
    case 'queued':
      return at('waiting');
    case 'assigned':
      return at('working', 'Claimed by a worker; execution has not been recorded as started.');
    case 'running':
      return reviewState === 'pending'
        ? at('needs_review', 'The worker submitted a result; an independent reviewer has not decided. Nobody is executing it.')
        : at('working');
    case 'blocked':
      return at('blocked');
    case 'needs_approval':
      return at('needs_approval', 'Held at the Founder gate. Executes nothing until that exact action digest is approved.');
    case 'review_failed':
      return at('failed', 'An independent reviewer failed the result. Re-queueing is a separate, explicit act.');
    case 'review_passed':
      return at('working', 'Review passed; one canonical transition from completed, and not there yet.');
    case 'completed':
      return at('completed');
    case 'outcome_unknown':
      return at('blocked', 'The real-world outcome was never confirmed. Never retried automatically; needs a reconciliation decision.');
  }
}

/** Every canonical status, so the totality test cannot forget one. */
export function everyCanonicalStatus(): readonly ActivityStatus[] {
  return ACTIVITY_STATUSES;
}

/**
 * What a mission's canonical tasks IMPLY about the mission — derived, shown
 * beside the recorded state, and never written to it.
 *
 * Phase 3 has no orchestrator, so a mission's recorded state moves only when
 * someone moves it. That is honest but it can lag reality: every task can be
 * complete while the mission still says `working`. Rather than either hiding
 * the lag or auto-advancing (which would be the later-phase behaviour this
 * phase must not fake), the UI shows both — "Recorded: Working · Tasks imply:
 * Ready for review" — and lets the Founder make the recorded transition.
 *
 * Precedence, and why:
 *   all completed         → ready_review   the work is done; a mission review is what is left
 *   any failed            → failed         a failed step means the plan as written did not succeed
 *   any blocked           → blocked        a human is needed before anything else matters
 *   any working / review  → working        something is genuinely in motion
 *   otherwise             → planned        everything is waiting or gated; nothing has run
 *
 * `null` for a mission with no tasks: zero tasks imply nothing, and saying
 * "planned" about an empty plan would be the filler D8 forbids.
 */
export function impliedMissionState(tasks: readonly PresentedTaskState[]): MissionState | null {
  if (tasks.length === 0) return null;
  const words = tasks.map((task) => task.presentation);
  if (words.every((word) => word === 'completed')) return 'ready_review';
  if (words.includes('failed')) return 'failed';
  if (words.includes('blocked')) return 'blocked';
  if (words.includes('working') || words.includes('needs_review')) return 'working';
  return 'planned';
}
