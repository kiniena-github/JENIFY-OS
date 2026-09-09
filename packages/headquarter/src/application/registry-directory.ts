/**
 * The lane C (AI Member + Capability Registry) ↔ lane F (Operator application)
 * capability seam — issue #174 Mission C.
 *
 * Wave 1 (PR #172) landed both lanes but deliberately left them unjoined:
 * `HeadquarterOperations` kept reading worker capabilities from the foundation's
 * `hq_specialists.allowed_capabilities` column while the Registry held the
 * provider-neutral truth. Two registries describing the same worker, and only
 * one of them consulted when the policy engine decides what that worker may do.
 *
 * This file closes that seam. Three rules govern it, and they are the reason
 * the composite below intersects rather than replaces:
 *
 *  1. NEVER trust advertised capabilities. A member's `advertisedCapabilities`
 *     are what a vendor claims; only `effectiveCapabilities` — granted by a
 *     registrar AND still registered and enabled — is read here. That is also
 *     what makes revocation take effect immediately: lane C derives it on every
 *     read rather than storing it (see registry/eligibility.ts).
 *  2. The Registry may only NARROW. Where both directories know a worker, the
 *     answer is the INTERSECTION of what each allows. Neither source can widen
 *     the other, so introducing the Registry can never grant a worker something
 *     the operator directory did not already permit — and vice versa.
 *  3. The base execution directory stays the CANONICAL worker-registration
 *     authority. A worker only the Registry knows is nominatable but not
 *     executable: it holds no capabilities and is never assignable, because
 *     supplying a Registry must not enrol anybody into execution. See
 *     `NarrowingWorkerDirectory` for why that is the whole safety argument.
 *  4. The Operator remains the final capability and risk authority. This layer
 *     only supplies the allow-list; `operator/policy.ts` still applies risk
 *     class, side-effect and approval rules on top, unchanged.
 *
 * Compatibility: when no Registry is supplied nothing here is used at all and
 * `HeadquarterOperations` keeps its existing `SpecialistDirectoryAdapter`
 * behaviour exactly.
 */

import type { AiMember, MemberAssignment } from '../registry/index.js';
import {
  bindDirectoryReads,
  type WorkerAssignability,
  type WorkerDirectoryPort,
  type WorkerDirectoryReads,
} from './ports.js';

/**
 * The slice of `AiMemberRegistry` this seam needs.
 *
 * Structural rather than the concrete class so the seam stays testable and the
 * application lane does not depend on the Registry's construction, wiring or
 * database. `AiMemberRegistry` satisfies it as-is.
 */
export interface MemberDirectorySource {
  get(id: string): AiMember | null;
  listAssignments(memberId: string): MemberAssignment[];
}

/**
 * `WorkerDirectoryPort` over lane C's Registry.
 *
 * Deny by default throughout: a worker the Registry does not know holds no
 * capabilities and is not assignable.
 */
/**
 * The Registry's assignability rule, as one pure function over the member
 * record and its assignments.
 *
 * Shared by `RegistryWorkerDirectory` (the exported port) and by
 * `registryDirectoryReads` (the prototype-free closures enforcement uses), so
 * the two answers cannot drift while only one of them is trusted.
 */
export function registryAssignability(
  member: AiMember | null,
  assignments: readonly MemberAssignment[],
): WorkerAssignability {
  if (member == null) return { assignable: false, reason: 'worker_unknown' };

  // A replaced worker is reported as replaced, not merely inactive: the
  // successor's id is actionable information for whoever is reassigning.
  if (member.status === 'replaced') {
    return {
      assignable: false,
      reason: 'worker_replaced',
      details: { replacedById: member.replacedById },
    };
  }
  if (member.status === 'removed' || member.status === 'disabled' || !member.enabled) {
    return { assignable: false, reason: 'worker_inactive', details: { status: member.status } };
  }

  // Work that was interrupted must be handed over before this worker takes on
  // anything new, otherwise the interrupted activity has no owner.
  const pending = assignments.filter((a) => a.status === 'handover_pending');
  if (pending.length > 0) {
    return {
      assignable: false,
      reason: 'handover_pending',
      details: { assignments: pending.map((a) => a.id) },
    };
  }

  return { assignable: true };
}

/**
 * The Registry's three reads as OWN-PROPERTY CLOSURES over a
 * `MemberDirectorySource` bound once — see `WorkerDirectoryReads` in
 * `ports.ts` for the exploit that made prototype dispatch unacceptable on this
 * path.
 */
export function registryDirectoryReads(source: MemberDirectorySource): WorkerDirectoryReads {
  const get = source.get.bind(source);
  const listAssignments = source.listAssignments.bind(source);
  return {
    isRegistered: (workerId: string) => get(workerId) !== null,
    allowedCapabilities: (workerId: string) => get(workerId)?.effectiveCapabilities ?? [],
    assignability: (workerId: string) => {
      const member = get(workerId);
      return registryAssignability(member, member == null ? [] : listAssignments(workerId));
    },
  };
}

export class RegistryWorkerDirectory implements WorkerDirectoryPort {
  constructor(private registry: MemberDirectorySource) {}

  isRegistered(workerId: string): boolean {
    return this.registry.get(workerId) !== null;
  }

  /**
   * EFFECTIVE capabilities only — granted, and still registered and enabled.
   *
   * Not `advertisedCapabilities` (a vendor's claim about itself) and not
   * `grantedCapabilities` (which can outlive the capability being disabled
   * registry-wide). This is the whole point of the seam: a capability revoked
   * in the Registry stops authorising work in the application immediately,
   * because nothing about it was cached here.
   */
  allowedCapabilities(workerId: string): readonly string[] {
    return this.registry.get(workerId)?.effectiveCapabilities ?? [];
  }

  assignability(workerId: string): WorkerAssignability {
    const member = this.registry.get(workerId);
    return registryAssignability(
      member,
      member == null ? [] : this.registry.listAssignments(workerId),
    );
  }
}

/**
 * Composes two directories so that supplying a Registry can only ever REMOVE
 * authority, never add any.
 *
 * The base directory is the canonical execution authority: membership in it is
 * what makes an id executable at all. On top of that:
 *
 * - **Both know the worker** — capabilities are the INTERSECTION, and the
 *   worker is assignable only if BOTH say so (either refusal wins).
 * - **Base only** — the base answers alone, so enabling the Registry does not
 *   strand workers that exist only in the operator directory. Nothing is
 *   widened: this is exactly the pre-integration answer.
 * - **Registry only** — no capabilities, never assignable. The Registry may
 *   narrow and it may nominate; it may not enrol. See below.
 *
 * ## Why a Registry-only worker holds nothing (issue #182)
 *
 * The first version of this class let the Registry answer alone for a worker
 * the base did not know. That looked symmetrical, but it was a widening: an id
 * that was refused as `worker_unknown` before the Registry was supplied became
 * executable, with Registry-granted capabilities, purely because
 * `memberRegistry` was passed to `HeadquarterOperations`. Registration in the
 * Registry — a provider/model catalogue that anyone onboarding a model writes
 * to — would then have been enough to enter the execution path, which is
 * precisely the authority migration issue #174 Mission C forbade.
 *
 * So the invariant this class actually guarantees is the strong one: for every
 * worker id, `allowedCapabilities` is a SUBSET of what the base directory would
 * have returned alone, and `assignability` is assignable only where the base
 * alone would also have said yes. Composition is a filter over the base, never
 * a second source of members.
 *
 * Turning the Registry into the canonical worker-registration authority is a
 * separate, deliberate authority migration — it is not something this seam may
 * do as a side effect of being switched on.
 *
 * `isRegistered` is the one method that still ORs the two sources, because it
 * answers a question about IDENTITY, not eligibility: "is this id a worker at
 * all, as opposed to a human principal?" Keeping Registry-only ids recognised
 * as worker identities is itself narrowing — it is what stops a Registry member
 * id from being mistaken for a human and picking up approval authority or the
 * human-principal path in `HeadquarterOperations.resolveRequester`. Recognition
 * grants nothing: such an id resolves to zero capabilities and a refusal, so
 * every execution path still ends in a deny.
 */
export class NarrowingWorkerDirectory implements WorkerDirectoryPort {
  constructor(
    private base: WorkerDirectoryPort,
    private registry: WorkerDirectoryPort,
  ) {}

  /** Identity, not eligibility — see the class comment. */
  isRegistered(workerId: string): boolean {
    return this.#reads().isRegistered(workerId);
  }

  allowedCapabilities(workerId: string): readonly string[] {
    return this.#reads().allowedCapabilities(workerId);
  }

  assignability(workerId: string): WorkerAssignability {
    return this.#reads().assignability(workerId);
  }

  /** The one implementation of the rules, shared with `narrowedReads`. */
  #reads(): WorkerDirectoryReads {
    return narrowedReads(bindDirectoryReads(this.base), bindDirectoryReads(this.registry));
  }
}

/**
 * The narrowing rules of `NarrowingWorkerDirectory`, over two already-bound
 * read triples instead of two objects — so the composition HQ builds for
 * itself has NO prototype on the call path at any layer, inner or outer.
 *
 * The class above delegates here, so the composition an external caller
 * constructs and the composition enforcement uses are the same three rules and
 * cannot drift. The rules themselves are unchanged; read the class comment for
 * why each is what it is.
 */
export function narrowedReads(
  base: WorkerDirectoryReads,
  registry: WorkerDirectoryReads,
): WorkerDirectoryReads {
  return {
    /** Identity, not eligibility — see `NarrowingWorkerDirectory`. */
    isRegistered: (workerId: string) => base.isRegistered(workerId) || registry.isRegistered(workerId),
    allowedCapabilities: (workerId: string) => {
      // Not in the canonical execution directory => holds nothing, whatever the
      // Registry granted. Registry grants narrow base capabilities; they never
      // stand on their own.
      if (!base.isRegistered(workerId)) return [];
      if (!registry.isRegistered(workerId)) return base.allowedCapabilities(workerId);
      const allowed = new Set(registry.allowedCapabilities(workerId));
      return base.allowedCapabilities(workerId).filter((c) => allowed.has(c));
    },
    assignability: (workerId: string) => {
      if (!base.isRegistered(workerId)) {
        // Unknown to the authority that decides who may execute. Reported as
        // `worker_unknown` — which is what the base alone would have said —
        // with the Registry sighting carried in details so the refusal is
        // diagnosable ("it is in the Registry, but nobody registered it for
        // execution") without inventing a new authority state.
        return registry.isRegistered(workerId)
          ? { assignable: false, reason: 'worker_unknown', details: { knownTo: 'registry_only' } }
          : { assignable: false, reason: 'worker_unknown' };
      }

      // Any "no" wins. The Registry is consulted first only so that its richer
      // reasons (replaced, handover_pending) are the ones reported when both
      // directories would refuse.
      if (registry.isRegistered(workerId)) {
        const verdict = registry.assignability(workerId);
        if (!verdict.assignable) return verdict;
      }
      return base.assignability(workerId);
    },
  };
}

/**
 * Build the worker directory for a `HeadquarterOperations` instance.
 *
 * With no Registry this returns `base` untouched, which is why enabling the
 * seam is opt-in and the default behaviour is byte-for-byte what it was.
 */
export function narrowByRegistry(
  base: WorkerDirectoryPort,
  registry: MemberDirectorySource | undefined | null,
): WorkerDirectoryPort {
  if (registry == null) return base;
  return new NarrowingWorkerDirectory(base, new RegistryWorkerDirectory(registry));
}

/**
 * Build the prototype-free worker-directory reads for a
 * `HeadquarterOperations` instance — the `narrowByRegistry` of the enforcement
 * path.
 *
 * With no Registry this returns `base` untouched, which is why enabling the
 * seam is opt-in and the default behaviour is byte-for-byte what it was.
 */
export function composeDirectoryReads(
  base: WorkerDirectoryReads,
  registry: MemberDirectorySource | undefined | null,
): WorkerDirectoryReads {
  if (registry == null) return base;
  return narrowedReads(base, registryDirectoryReads(registry));
}
