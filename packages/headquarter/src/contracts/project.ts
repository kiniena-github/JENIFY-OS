/**
 * Canonical Project lifecycle vocabulary for Phase 4 — Projects + Tasks +
 * Dynamic AI Workforce (issue #262).
 *
 * A Project is the Founder's REGISTER entry for a body of work: a named
 * container that missions are assigned to. It sits between the Mission
 * aggregate and nothing else — a project is not a task, holds no plan of its
 * own, grants no capability and executes nothing. Work truth lives in
 * missions and tasks; the project is the organizing record above them.
 *
 * Two states, deliberately: `active` and `closed`. Every state the vocabulary
 * does NOT have is an anti-fabrication decision:
 * - No `planned`: a project record existing IS the Founder stating it. There
 *   is no pre-existence state to record.
 * - No `completed` / `failed`: completion of a project is a claim about its
 *   work, and work truth lives in the linked missions and their tasks. The
 *   Founder closes a project with a mandatory note saying why (done /
 *   abandoned / superseded); the mission record says what actually happened.
 *   A `completed` status here would be exactly the fabricated progress claim
 *   this codebase refuses to store.
 * - No `blocked` / `paused`: blockage is mission/task truth. A paused project
 *   is a closed-for-now project — `closed` already refuses new mission
 *   assignment, and reopening records a reason. No consumer would behave
 *   differently between "paused" and "closed", so the extra state would be
 *   vocabulary with no truth behind it.
 *
 * `closed` is NOT terminal (unlike mission terminals): a project is a
 * register entry, not history. Reopening forges nothing, because
 * `hq_project_events` records both moves append-only.
 */

export const PROJECT_STATUSES = ['active', 'closed'] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Allowed project transitions. Both edges exist and both demand a non-empty
 * note (see PROJECT_NOTE_REQUIRED): closing and reopening are decisions with
 * reasons, and the reason is part of the record (the mission
 * MISSION_NOTE_REQUIRED_TARGETS / denyTask mandatory-reason precedent).
 */
export const PROJECT_ALLOWED_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  active: ['closed'],
  closed: ['active'],
};

export function isProjectStatus(value: string): value is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Every project transition carries a mandatory note — with two states there
 * is no "routine" move: each direction is a Founder decision with a reason.
 * A constant rather than a list so the rule reads as what it is.
 */
export const PROJECT_NOTE_REQUIRED = true as const;
