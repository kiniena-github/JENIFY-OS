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
 *  3. The Operator remains the final capability and risk authority. This layer
 *     only supplies the allow-list; `operator/policy.ts` still applies risk
 *     class, side-effect and approval rules on top, unchanged.
 *
 * Compatibility: when no Registry is supplied nothing here is used at all and
 * `HeadquarterOperations` keeps its existing `SpecialistDirectoryAdapter`
 * behaviour exactly.
 */

import type { AiMember, MemberAssignment } from '../registry/index.js';
import type { WorkerAssignability, WorkerDirectoryPort } from './ports.js';

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
    const pending = this.registry
      .listAssignments(workerId)
      .filter((a) => a.status === 'handover_pending');
    if (pending.length > 0) {
      return {
        assignable: false,
        reason: 'handover_pending',
        details: { assignments: pending.map((a) => a.id) },
      };
    }

    return { assignable: true };
  }
}

/**
 * Composes two directories so neither can widen the other.
 *
 * Where both know a worker, capabilities are the INTERSECTION and the worker is
 * assignable only if BOTH say so. Where only one knows the worker, that one
 * answers — so adding a Registry does not strand workers that exist only in the
 * operator directory, and a Registry-only worker is still governed.
 *
 * The intersection is what makes this safe to switch on: it is impossible for
 * the seam to hand the policy engine a capability that the pre-integration
 * behaviour would not also have handed it.
 */
export class NarrowingWorkerDirectory implements WorkerDirectoryPort {
  constructor(
    private base: WorkerDirectoryPort,
    private registry: WorkerDirectoryPort,
  ) {}

  isRegistered(workerId: string): boolean {
    return this.base.isRegistered(workerId) || this.registry.isRegistered(workerId);
  }

  allowedCapabilities(workerId: string): readonly string[] {
    const inBase = this.base.isRegistered(workerId);
    const inRegistry = this.registry.isRegistered(workerId);
    if (inBase && inRegistry) {
      const allowed = new Set(this.registry.allowedCapabilities(workerId));
      return this.base.allowedCapabilities(workerId).filter((c) => allowed.has(c));
    }
    if (inRegistry) return this.registry.allowedCapabilities(workerId);
    if (inBase) return this.base.allowedCapabilities(workerId);
    return [];
  }

  assignability(workerId: string): WorkerAssignability {
    const inBase = this.base.isRegistered(workerId);
    const inRegistry = this.registry.isRegistered(workerId);
    if (!inBase && !inRegistry) return { assignable: false, reason: 'worker_unknown' };

    // Any "no" wins. The Registry is consulted first only so that its richer
    // reasons (replaced, handover_pending) are the ones reported when both
    // directories would refuse.
    if (inRegistry) {
      const verdict = this.registry.assignability(workerId);
      if (!verdict.assignable) return verdict;
    }
    if (inBase) {
      const verdict = this.base.assignability(workerId);
      if (!verdict.assignable) return verdict;
    }
    return { assignable: true };
  }
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
