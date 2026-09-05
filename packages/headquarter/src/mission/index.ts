/**
 * MISSION CORE — Founder Command + durable, truthfully-tracked missions
 * (Phase 3, issue #254).
 *
 * ## Two things called "mission", and why neither is renamed
 *
 * `application/missions.ts` predates this module and is a different concept:
 * a group-room mission PROPOSAL — an inert row raised from chat, promoted into
 * a task only by an actor that already holds the capability. It is untouched.
 *
 * This module is the Founder's MISSION: the canonical, durable record of one
 * high-level order — objective, constraints, task plan, recorded state,
 * approval/review truth, and an append-only intent anchor. It is created from
 * a sentence the Founder types, not from a chat thread, and it wraps one or
 * more canonical direct-order tasks rather than proposing a capability.
 *
 * Renaming the older module would have churned a stable surface for a naming
 * nicety; both files now say which one they are in their first paragraph.
 *
 *   states.ts        the eight mission states and their transition table (D2)
 *   presentation.ts  canonical task status → mission-task word; total adapter,
 *                    never persisted (D1); the derived implied-state rule
 *   intent.ts        deterministic order parsing and decomposition; ambiguity
 *                    becomes needs_clarification and zero tasks (D7, D8)
 *   store.ts         the four mission tables, append-only intent chain (D3)
 *   command.ts       submit / amend / transition — every task through
 *                    submitDirectOrder, risk derived from the registry (D5, D6)
 *   view.ts          the browser-safe projection (D10)
 *
 * ## What this module deliberately is NOT
 *
 * Not the autonomous orchestrator of Phases 4–6. Nothing here dispatches a
 * worker, advances a mission on its own, retries anything, or reads meaning
 * into an order beyond a bounded set of written rules. A mission's recorded
 * state moves when a human moves it; what its tasks imply is computed and
 * shown beside that, and never written back.
 */

export * from './states.js';
export * from './presentation.js';
export * from './intent.js';
export * from './store.js';
export * from './command.js';
export * from './view.js';
