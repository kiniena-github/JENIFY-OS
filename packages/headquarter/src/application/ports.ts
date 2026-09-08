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
import type { HqDatabase } from '../store/db.js';
import { bindSchemaResilientGet } from '../store/db.js';
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
 * The same three answers as `WorkerDirectoryPort`, as OWN-PROPERTY CLOSURES
 * rather than prototype methods (Wave 5 correction round fifteen, Critical 2
 * and High 2).
 *
 * ## Why a second shape of the same interface exists
 *
 * `HeadquarterOperations` held its directory in a `#private` field and called
 * `this.#workers.assignability(workerId)` — private storage, public dispatch.
 * `#workers` holds an instance of the EXPORTED `SpecialistDirectoryAdapter` /
 * `NarrowingWorkerDirectory`, so the call resolved through a replaceable
 * prototype every time it ran. A hostile review disabled a member through
 * ordinary configuration (no raw DB write), watched `executeAction` refuse
 * with `worker_not_assignable` and zero adapter calls, then set
 * `NarrowingWorkerDirectory.prototype.assignability = () => ({assignable:true})`
 * and got `{"ok":true,"reversibility":"irreversible","visibility":"public"}`
 * with the adapter called ONCE — an irreversible public external act by a
 * worker the Registry said was disabled. Two lines above, `#grantOf` was
 * already hardened; the sibling read beside it was not.
 *
 * The same shape reached least privilege: `#grantOf`'s database-backed closure
 * applied only when NEITHER `options.workers` NOR `options.memberRegistry` was
 * supplied, so supplying either silently opted back into prototype dispatch,
 * and `NarrowingWorkerDirectory.prototype.allowedCapabilities = () => [cap]`
 * turned `not_permitted` into `{"ok":true,"status":"assigned"}`.
 *
 * A closure captured at construction has no prototype on the path at call
 * time. That is the same narrowing — not the same as a guarantee — the
 * constructor's `bindGet` note already states: an attacker who runs BEFORE
 * construction can still patch what is captured, and the boundary that closes
 * that is a separate process, not an in-process fix.
 */
export interface WorkerDirectoryReads {
  isRegistered: (workerId: string) => boolean;
  allowedCapabilities: (workerId: string) => readonly string[];
  assignability: (workerId: string) => WorkerAssignability;
}

/**
 * Bind a caller-supplied `WorkerDirectoryPort`'s three reads once, at
 * construction.
 *
 * The honest limit, stated rather than implied: this removes the OUTER
 * prototype from the call path. A port the CALLER composed can still dispatch
 * internally however it likes — HQ did not build it and cannot reach inside
 * it. For the composition HQ builds itself (`composeDirectoryReads`), no
 * prototype participates at any layer.
 */
export function bindDirectoryReads(port: WorkerDirectoryPort): WorkerDirectoryReads {
  const isRegistered = port.isRegistered.bind(port);
  const allowedCapabilities = port.allowedCapabilities.bind(port);
  const assignability = port.assignability.bind(port);
  return { isRegistered, allowedCapabilities, assignability };
}

/**
 * The specialist-directory rule, as one pure function.
 *
 * Shared by `SpecialistDirectoryAdapter` (the exported port, unchanged for the
 * callers that want an object) and by `specialistDirectoryReads` (the
 * prototype-free closures enforcement uses), so the two answers cannot drift
 * while only one of them is trusted — the same argument the queue's
 * `rowToTask` already carries.
 */
export function specialistAssignability(
  worker: { active: boolean } | null | undefined,
): WorkerAssignability {
  if (!worker) return { assignable: false, reason: 'worker_unknown' };
  if (!worker.active) return { assignable: false, reason: 'worker_inactive' };
  return { assignable: true };
}

/**
 * The default directory's three reads, over `hq_specialists`, with the
 * statement prepared and its `get` bound once — the `bindGet` recipe the
 * constructor's principal and grant lookups already use, applied to the whole
 * directory.
 *
 * Deny by default throughout, including on an unparseable
 * `allowed_capabilities` column: a malformed grant grants NOTHING rather than
 * throwing out of an enforcement decision.
 *
 * That sentence was true of a MALFORMED GRANT and false of a concurrent DDL
 * (Wave 5 correction round seventeen, Medium-3). The bound `get` could never
 * be re-prepared, so `SQLITE_SCHEMA` — which HQ's own `CREATE TABLE IF NOT
 * EXISTS` boot path provokes whenever a second process starts against the same
 * file — threw straight out of `#resolveRequester`. Measured over 32 runs of
 * `reliability-commitment-prefix-replay.test.ts` on `85b720d`: 2 failures,
 * both here at `row`. `bindSchemaResilientGet` re-prepares once and retries,
 * from a `prepare` captured at construction so no prototype joins the call
 * path; see its docblock for why the two properties are compatible.
 */
export function specialistDirectoryReads(db: HqDatabase): WorkerDirectoryReads {
  const get = bindSchemaResilientGet(
    db,
    `SELECT id, allowed_capabilities, active FROM hq_specialists WHERE id = ?`,
  ) as (workerId: string) => Record<string, unknown> | undefined;
  const row = (workerId: string): { allowedCapabilities: string[]; active: boolean } | null => {
    const found = get(workerId);
    if (!found) return null;
    let allowedCapabilities: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(found.allowed_capabilities));
      if (Array.isArray(parsed)) allowedCapabilities = parsed.filter((c): c is string => typeof c === 'string');
    } catch {
      allowedCapabilities = [];
    }
    return { allowedCapabilities, active: !!found.active };
  };
  return {
    isRegistered: (workerId: string) => row(workerId) !== null,
    allowedCapabilities: (workerId: string) => row(workerId)?.allowedCapabilities ?? [],
    assignability: (workerId: string) => specialistAssignability(row(workerId)),
  };
}

/**
 * Default `WorkerDirectoryPort` over the foundation's specialist directory
 * (`hq_specialists`). Deny by default: unknown workers get no capabilities and
 * are not assignable.
 *
 * Kept exactly as it was for the callers that legitimately want an object.
 * `HeadquarterOperations` no longer holds one: it uses
 * `specialistDirectoryReads` instead, for the reason `WorkerDirectoryReads`
 * documents.
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
    return specialistAssignability(this.store.getSpecialist(workerId));
  }
}
