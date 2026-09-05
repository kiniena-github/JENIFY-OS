/**
 * Canonical Mission lifecycle vocabulary for Phase 3 — Founder Command +
 * Mission Core (issue #254).
 *
 * A Mission is the command-level aggregate ABOVE tasks: the durable record of
 * a Founder order — objective, constraints, plan, blockers, lifecycle. It is
 * a NEW aggregate level, not a second vocabulary for tasks: every worker/
 * task/project status remains expressed in `ActivityStatus` (./events.js),
 * and nothing here stores a task status. The one bridge is
 * `planItemStateFromTask`, a read-time presentation adapter that is
 * compile-time exhaustive over `ActivityStatus`, so the canonical vocabulary
 * cannot grow without this file being forced to answer for it.
 *
 * Relationship to the two older "mission" meanings, so nobody conflates them:
 * - `application/missions.ts` (`hq_mission_proposals`) is the chat-lane
 *   proposal-for-a-task flow. Untouched; different concept.
 * - `application/mission-watchdog.ts` is an UNWIRED decision-rule library
 *   with its own derived classification vocabulary. It stays unwired; its
 *   states are dispatch-decision classifications, not this lifecycle.
 */

import { type ActivityStatus } from './events.js';

export const MISSION_STATUSES = [
  'planned',
  'working',
  'blocked',
  'ready_review',
  'verified',
  'complete',
  'failed',
  'cancelled',
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

/**
 * Allowed mission transitions. Anything not listed here is rejected.
 *
 * Two distinct laws govern a transition, and this table is only the first:
 * - STRUCTURAL law (this map): which movements are ever meaningful. The map
 *   is fixed; later phases do not add edges, they add authorized callers.
 * - REACHABILITY law (the facade): WHO may drive a movement. In Phase 3
 *   every transition is Founder-driven through the single actor-checked
 *   facade method. No worker, watchdog, orchestrator, or derived rule can
 *   move a mission; mission status is never computed from task status.
 *
 * Notes:
 * - `complete`, `failed` and `cancelled` are terminal. `cancelled` is how a
 *   Founder closes a mission that should not continue (issue #254 has no
 *   pause/resume; those are later-phase states deliberately absent here).
 * - `verified -> complete` is separate from `ready_review -> verified`
 *   because verification and closure are different Founder decisions.
 * - `ready_review -> verified` requires an explicit recorded Founder
 *   decision with a mandatory note (see MISSION_VERIFICATION_METHODS). No
 *   machine path to `verified` exists in Phase 3.
 * - Edges a later phase is expected to drive autonomously (for example
 *   `working -> ready_review` from an evidence engine, or
 *   `blocked -> working` from dependency resolution) are CURRENTLY
 *   Founder-only. Widening the caller set is a deliberate later-phase
 *   change, not something this table can grant.
 */
export const MISSION_ALLOWED_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  planned: ['working', 'blocked', 'cancelled'],
  working: ['blocked', 'ready_review', 'failed', 'cancelled'],
  blocked: ['working', 'failed', 'cancelled'],
  ready_review: ['working', 'verified', 'failed', 'cancelled'],
  verified: ['complete', 'cancelled'],
  complete: [],
  failed: [],
  cancelled: [],
};

export function isMissionStatus(value: string): value is MissionStatus {
  return (MISSION_STATUSES as readonly string[]).includes(value);
}

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransitionMission(from, to)) {
    throw new Error(`Illegal mission transition: ${from} -> ${to}`);
  }
}

export function isMissionTerminal(status: MissionStatus): boolean {
  return MISSION_ALLOWED_TRANSITIONS[status].length === 0;
}

/**
 * Transitions that must carry a non-empty note. Stopping, failing, closing
 * or verifying a mission is a decision with a reason; the reason is part of
 * the record (the `denyTask` mandatory-reason precedent).
 */
export const MISSION_NOTE_REQUIRED_TARGETS: readonly MissionStatus[] = [
  'blocked',
  'verified',
  'failed',
  'cancelled',
];

/**
 * How a mission can become `verified`. Deliberately a single member: Phase 3
 * has no evidence engine, so the only honest verification is an explicit
 * recorded Founder decision. The vocabulary having NO machine member is the
 * point (the `ActorAuthentication`-has-no-`authenticated` pattern in
 * live/local-trust.ts): a later phase must first add the ability to even
 * SAY "machine-verified" before any code path can claim it.
 */
export const MISSION_VERIFICATION_METHODS = ['founder_decision'] as const;

export type MissionVerificationMethod = (typeof MISSION_VERIFICATION_METHODS)[number];

/**
 * Mission priority is mission-level metadata for the Founder's own ordering.
 * Nothing in the operator queue reads it: task claiming remains strictly
 * FIFO. `null` (absent) means the Founder did not state one — unstated is
 * recorded as unstated, never defaulted to `normal`.
 */
export const MISSION_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;

export type MissionPriority = (typeof MISSION_PRIORITIES)[number];

export function isMissionPriority(value: string): value is MissionPriority {
  return (MISSION_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Display states for a mission's plan items, in the issue #254 vocabulary
 * (Waiting / Working / Needs Review / Needs Approval / Completed / Blocked /
 * Failed) plus two planning-record facts that only unlinked items can have.
 *
 * This is a PRESENTATION mapping, not a second task state machine: it has no
 * transition table, no writes and no storage. A linked item's state is
 * derived at read time from the linked task's one canonical `ActivityStatus`
 * (+ its pending-review flag), and the raw canonical status always travels
 * alongside it in every view, so the mapping can compress but never hide.
 */
export type MissionPlanItemState =
  | 'waiting'
  | 'working'
  | 'needs_review'
  | 'needs_approval'
  | 'completed'
  | 'blocked'
  | 'failed'
  /** Unlinked item recording an open question — never guessed into a plan. */
  | 'needs_clarification'
  /** Replaced by a later amendment; kept because plan history is append-only. */
  | 'superseded';

/**
 * Derive a linked plan item's display state from its task's canonical
 * status. Exhaustive over `ActivityStatus` on purpose — adding a canonical
 * status breaks compilation here (the `ui/spatial/state.ts STATUS_ACTIVITY`
 * pattern).
 *
 * Two deliberately-compressing cells, both covered by the adjacent raw
 * status in every view:
 * - `review_failed -> failed`: an independent reviewer recorded a failure
 *   verdict. The task may re-enter work later; the raw status says so.
 * - `outcome_unknown -> blocked`: the work is stopped pending
 *   reconciliation. #254's vocabulary has no "unknown" member and inventing
 *   one would widen the binding list.
 * `review_passed -> working` because the task is still in flight until the
 * queue records `completed`; mapping it to `completed` would claim a
 * completion the canonical record has not made.
 */
export function planItemStateFromTask(
  status: ActivityStatus,
  reviewPending: boolean,
): MissionPlanItemState {
  switch (status) {
    case 'queued':
      return 'waiting';
    case 'assigned':
      return 'working';
    case 'running':
      return reviewPending ? 'needs_review' : 'working';
    case 'needs_approval':
      return 'needs_approval';
    case 'blocked':
      return 'blocked';
    case 'review_failed':
      return 'failed';
    case 'review_passed':
      return 'working';
    case 'completed':
      return 'completed';
    case 'outcome_unknown':
      return 'blocked';
  }
}
