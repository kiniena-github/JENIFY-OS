/**
 * Narrow public integration seams for HQ lane F (issue #139 / #122).
 *
 * Lane F wires Headquarter to the EXISTING Universal Operator. It must not
 * duplicate the organization (#118), member-registry (#119/PR #128) or
 * memory/handover (#120/PR #127) state machines, so everything it needs from
 * those domains arrives through the two tiny interfaces below.
 *
 * The split between them is the security point of this lane:
 *
 * - `NominationSourcePort` may only NOMINATE. Anything it returns is a
 *   suggestion. It cannot grant a capability, mark a worker assignable, or
 *   influence risk classification in any way.
 * - `WorkerDirectoryPort` is the OPERATOR-SIDE authority for "who is this
 *   worker and what may it hold". Capability allow-lists used by the policy
 *   engine are read from HERE — never from a nomination, never from a task
 *   payload, and never from what a worker says about itself.
 *
 * When PR #127 (handover/replacement lifecycle) and PR #128 (AI member
 * registry) merge, they plug in as `WorkerDirectoryPort` implementations —
 * `assignability()` is exactly the shape of lane D's `assertAssignable()`
 * guard, and `allowedCapabilities()` is exactly lane C's GRANTED (never
 * advertised) capability list. No code in this lane needs to change.
 */

import type { RiskClass } from '../operator/capabilities.js';
import type { HeadquarterStore } from '../store/headquarter.js';

/**
 * Why a worker may not take on new work. Deny by default: an unknown worker is
 * never assignable.
 *
 * `worker_replaced` / `handover_pending` are produced by a richer lifecycle
 * implementation (lane D); the built-in specialist-directory adapter can only
 * distinguish unknown from inactive, and reports `worker_inactive` for a
 * disabled or replaced specialist.
 */
export type AssignabilityReason =
  | 'worker_unknown'
  | 'worker_inactive'
  | 'worker_replaced'
  | 'handover_pending';

export type WorkerAssignability =
  | { assignable: true }
  | { assignable: false; reason: AssignabilityReason; details?: Record<string, unknown> };

/** Operator-side worker authority. Read-only from this lane's point of view. */
export interface WorkerDirectoryPort {
  /** Whether the id belongs to a registered worker at all (not a human principal). */
  isRegistered(workerId: string): boolean;
  /**
   * Capability ids this worker may hold, per the directory. THE ONLY source
   * the policy engine is fed from in this lane. Unknown worker => empty list.
   */
  allowedCapabilities(workerId: string): readonly string[];
  /** Whether the worker may claim/continue work right now. */
  assignability(workerId: string): WorkerAssignability;
}

/** A suggestion, nothing more. */
export interface WorkerNomination {
  workerId: string;
  rationale?: string;
}

/**
 * What a nomination source is told about the task. Deliberately does not
 * include the payload: routing must not depend on free-form content, and a
 * nomination source is not a trusted reader of task input.
 */
export interface NominationContext {
  taskId: string;
  capabilityId: string;
  riskClass: RiskClass;
  sideEffect: boolean;
}

export interface NominationSourcePort {
  /** Stable id recorded in evidence so a nomination's origin is auditable. */
  readonly id: string;
  nominate(ctx: NominationContext): readonly WorkerNomination[];
}

/**
 * Default `WorkerDirectoryPort` over the foundation's specialist directory
 * (`hq_specialists`). Deny by default: unknown workers get no capabilities and
 * are not assignable.
 */
export class SpecialistDirectoryAdapter implements WorkerDirectoryPort {
  constructor(private store: HeadquarterStore) {}

  isRegistered(workerId: string): boolean {
    return this.store.getSpecialist(workerId) !== null;
  }

  allowedCapabilities(workerId: string): readonly string[] {
    return this.store.getSpecialist(workerId)?.allowedCapabilities ?? [];
  }

  assignability(workerId: string): WorkerAssignability {
    const worker = this.store.getSpecialist(workerId);
    if (!worker) return { assignable: false, reason: 'worker_unknown' };
    if (!worker.active) return { assignable: false, reason: 'worker_inactive' };
    return { assignable: true };
  }
}
