/**
 * Mission states — the one genuinely NEW state machine Phase 3 introduces
 * (issue #254, integration decision D2).
 *
 * ## Why missions get a transition table and tasks do not
 *
 * A mission is a different kind of thing from a task. A task is a single
 * canonical unit of work whose lifecycle `contracts/events.ts` already defines
 * in full — nine statuses, one transition table, capability-aware enforcement
 * on top. The issue's task vocabulary (Waiting / Working / Needs Review / Needs
 * Approval / Completed / Blocked / Failed) is a PRESENTATION of that canonical
 * truth and is handled by an adapter in `presentation.ts`; it is never a
 * second source of truth, and this file deliberately has nothing to say about
 * tasks.
 *
 * A mission has no canonical lifecycle yet, so this table IS its canonical
 * lifecycle. It is modelled on `ALLOWED_TRANSITIONS` on purpose — same shape,
 * same `can`/`assert` pair, same rule that anything not listed is refused — so
 * a reader who knows one knows the other.
 *
 * ## The table, and why each edge exists
 *
 *   planned       The order was understood and decomposed; canonical tasks
 *                 exist and are gated. Nothing has run.
 *   working       At least one task is being executed. Recorded EXPLICITLY —
 *                 there is no orchestrator in Phase 3 to move a mission here
 *                 automatically, and this module will not pretend there is.
 *   blocked       The mission cannot proceed without a human. The mission core
 *                 itself puts a mission here when the order needs
 *                 clarification (`needs_clarification`), because an order that
 *                 cannot be decomposed honestly has no plan to be `planned`
 *                 with. Blocked exits to `planned` for exactly that case: an
 *                 amendment that yields a plan.
 *   ready_review  The work is done and awaits a mission-level review by the
 *                 Founder.
 *   verified      The Founder RECORDED that the work checked out. This is the
 *                 Founder's own record of acceptance and nothing more: the
 *                 mission core imposes no independence bar, so the same
 *                 principal that placed the mission may record it verified
 *                 and then complete. That is deliberate — enforcing a second
 *                 reviewer here would deadlock a single-Founder deployment —
 *                 and it is an OPEN product question for the Founder, recorded
 *                 rather than decided (Opus second pass on `a849af8`). It is
 *                 NOT an independent review; independent review exists at the
 *                 TASK level, in the canonical review lane `presentation.ts`
 *                 reads, and nothing about this state claims it. The label
 *                 says "Founder-verified" so no UI can read it as more. One
 *                 step short of complete so that "the work checked out" and
 *                 "the mission is closed" remain two recorded decisions rather
 *                 than one.
 *   complete      TERMINAL. No exit.
 *   failed        The mission did not achieve its objective. NOT terminal, and
 *                 its exits are stated deliberately: `planned` (re-plan under an
 *                 amended intent — the tasks that failed stay in the plan
 *                 history) or `cancelled` (give up). There is no `failed →
 *                 working` edge: resuming failed work without a recorded
 *                 re-plan is exactly the quiet retry the watchdog rules refuse.
 *   cancelled     TERMINAL. No exit. A cancelled mission is not deleted — its
 *                 intent lock, task links and history stay readable.
 *
 * Nothing here moves a mission by itself. Every transition is an explicit call
 * with an actor and a reason, recorded in `hq_mission_events`. What the
 * canonical TASKS imply about a mission is computed separately, shown beside
 * the recorded state, and never written back (see `presentation.ts`).
 */

export const MISSION_STATES = [
  'planned',
  'working',
  'blocked',
  'ready_review',
  'verified',
  'complete',
  'failed',
  'cancelled',
] as const;

export type MissionState = (typeof MISSION_STATES)[number];

/** Display labels, kept beside the vocabulary so no UI invents its own. */
export const MISSION_STATE_LABELS: Record<MissionState, string> = {
  planned: 'Planned',
  working: 'Working',
  blocked: 'Blocked',
  ready_review: 'Ready for review',
  // "Founder-verified", never bare "Verified": the state is the Founder's own
  // record of acceptance, and a label that reads as independent verification
  // would claim a review the mission core does not perform. See the module
  // docstring.
  verified: 'Founder-verified',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Allowed mission transitions. Anything not listed here is refused.
 *
 * `complete` and `cancelled` are the only terminal states. `failed` is not
 * terminal — see the module docstring for why its two exits are the two they
 * are.
 */
export const MISSION_TRANSITIONS: Record<MissionState, readonly MissionState[]> = {
  planned: ['working', 'blocked', 'cancelled'],
  working: ['blocked', 'ready_review', 'failed', 'cancelled'],
  blocked: ['planned', 'working', 'failed', 'cancelled'],
  ready_review: ['verified', 'working', 'blocked', 'failed', 'cancelled'],
  verified: ['complete', 'working', 'cancelled'],
  complete: [],
  failed: ['planned', 'cancelled'],
  cancelled: [],
};

export function isMissionState(value: unknown): value is MissionState {
  return typeof value === 'string' && (MISSION_STATES as readonly string[]).includes(value);
}

export function canMissionTransition(from: MissionState, to: MissionState): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

export function assertMissionTransition(from: MissionState, to: MissionState): void {
  if (!canMissionTransition(from, to)) {
    throw new Error(`Illegal mission transition: ${from} -> ${to}`);
  }
}

export function isMissionTerminal(state: MissionState): boolean {
  return MISSION_TRANSITIONS[state].length === 0;
}

/**
 * The block-reason CODE the mission core itself writes when it refuses to
 * invent a plan. A Founder-typed reason on an explicit transition to `blocked`
 * never begins with this prefix — `command.ts` refuses one that does, so the
 * two cannot be confused when read back.
 */
export const NEEDS_CLARIFICATION_REASON = 'needs_clarification';
