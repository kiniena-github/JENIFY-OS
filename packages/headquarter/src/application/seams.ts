/**
 * Integration seams for lanes that are not merged into `main` yet
 * (issue #139 INTEGRATION clause).
 *
 * HQ lane F must be composable with, but never a duplicate of, the
 * organization/registry/memory state machines owned by other lanes:
 *
 * - lane B (merged, `../organization/`) — editable organization + workforce.
 * - lane C (PR #128, open) — provider-neutral AI Member Registry.
 * - lane D (PR #127, open) — company memory + worker handover/replacement.
 *
 * Rather than importing anything unmerged (or re-implementing it), this file
 * declares two deliberately tiny interfaces the service depends on. Each
 * unmerged lane can be bound to them later with a thin adapter and no change
 * to the service:
 *
 *   WorkerNominationSource  — "who COULD do this?"  (advisory only)
 *   WorkerAssignabilityGate — "may this worker take on new work at all?"
 *                             (deny-only; can refuse, can never grant)
 *
 * SECURITY INVARIANT (issue #139): a nomination source may *nominate* workers,
 * but the Universal Operator remains the final authority on capability and
 * risk. Nothing returned by either seam can widen what a worker is allowed to
 * do — `HeadquarterOperationsService` always re-derives permission from the
 * capability registry + specialist directory allow-list, and treats these
 * seams as filters layered ON TOP of that decision. See
 * `service.ts#nominateWorkers` and `service.ts#claimNext`.
 *
 * ---------------------------------------------------------------------------
 * EXACT INTEGRATION SEAM for the unmerged lanes
 * ---------------------------------------------------------------------------
 * lane C (PR #128) — `AiMemberRegistry`:
 *   nominate:      registry.list({ status: 'active' }) filtered by
 *                  role eligibility / `rankMembers(...)`, mapped to
 *                  `{ workerId: member.id, source: 'ai_member_registry' }`.
 *   assignability: `member.status === 'active'` → assignable; 'disabled' |
 *                  'removed' | 'replaced' → not assignable, with the member's
 *                  own status as `reason`.
 *
 * lane D (PR #127) — `HandoverStore` / `assertAssignable(db, workerId)`:
 *   assignability: call `assertAssignable(db, workerId)` inside
 *                  `isAssignable` and translate its throw into
 *                  `{ assignable: false, reason: 'handover_pending' }`.
 *
 * Until those land, `defaultWorkerAssignability()` and
 * `directoryNominationSource()` below provide equivalent behaviour built only
 * on merged `main` (the specialist directory and the lane-B organization
 * engine), so the lane is testable and shippable today.
 */

import type { HeadquarterStore } from '../store/headquarter.js';
import type { OrganizationEngine } from '../organization/engine.js';

/** Why a worker may not take on new work. Deny-only vocabulary. */
export type NotAssignableReason =
  | 'unknown_worker'
  | 'inactive'
  | 'disabled'
  | 'replaced'
  | 'removed'
  | 'handover_pending';

export type AssignabilityDecision =
  | { assignable: true }
  | { assignable: false; reason: NotAssignableReason; details?: Record<string, unknown> };

/**
 * Deny-only gate. An implementation may REFUSE a worker; it can never grant
 * a capability, raise a risk class, or admit a worker the Operator denied.
 */
export interface WorkerAssignabilityGate {
  isAssignable(workerId: string): AssignabilityDecision;
}

export interface WorkerNomination {
  workerId: string;
  /** Which seam produced the nomination (audit/display only). */
  source: string;
  /** Optional ranking hint. Never used as a permission input. */
  rank?: number;
}

/**
 * Advisory "who could do this" source. Its output is a *candidate list*, not
 * a grant: every candidate is still put through the Operator's own policy
 * decision before it is shown as nominated.
 */
export interface WorkerNominationSource {
  nominate(capabilityId: string): WorkerNomination[];
}

/**
 * Default gate built on merged `main`: a worker is assignable when it exists
 * in the specialist directory and is flagged active there. Disabling a
 * specialist (see `HeadquarterOperationsService#disableWorker`) is what makes
 * this return false, which is what stops a disabled/replaced worker claiming
 * new tasks.
 */
export function defaultWorkerAssignability(store: HeadquarterStore): WorkerAssignabilityGate {
  return {
    isAssignable(workerId: string): AssignabilityDecision {
      const descriptor = store.getSpecialist(workerId);
      if (!descriptor) return { assignable: false, reason: 'unknown_worker' };
      if (!descriptor.active) return { assignable: false, reason: 'disabled' };
      return { assignable: true };
    },
  };
}

/**
 * Compose several gates. The result is assignable only when EVERY gate says
 * so — adding a gate can only ever remove permission, never add it. This is
 * how the lane-C/lane-D adapters get layered in once merged.
 */
export function allGates(...gates: WorkerAssignabilityGate[]): WorkerAssignabilityGate {
  return {
    isAssignable(workerId: string): AssignabilityDecision {
      for (const gate of gates) {
        const decision = gate.isAssignable(workerId);
        if (!decision.assignable) return decision;
      }
      return { assignable: true };
    },
  };
}

/**
 * Nomination source over the merged specialist directory: active specialists
 * whose directory allow-list contains the capability.
 *
 * Note the allow-list is read from the DIRECTORY, never from anything the
 * worker asserts about itself at runtime (contracts/workers.ts).
 */
export function directoryNominationSource(store: HeadquarterStore): WorkerNominationSource {
  return {
    nominate(capabilityId: string): WorkerNomination[] {
      return store
        .listSpecialists()
        .filter((w) => w.active && w.allowedCapabilities.includes(capabilityId))
        .map((w) => ({ workerId: w.id, source: 'specialist_directory' }));
    },
  };
}

/**
 * Nomination source over the merged lane-B organization engine: workers that
 * occupy a role whose `requiredCapabilities` include this capability.
 *
 * The organization engine is READ ONLY here — this lane never mutates org
 * state, and an org edit can never grant Operator rights (lane B enforces the
 * same invariant from its side).
 */
export function organizationNominationSource(engine: OrganizationEngine): WorkerNominationSource {
  return {
    nominate(capabilityId: string): WorkerNomination[] {
      const org = engine.getCurrentOrg();
      const roleIds = new Set(
        org.roles.filter((r) => r.requiredCapabilities.includes(capabilityId)).map((r) => r.id),
      );
      const seen = new Set<string>();
      const nominations: WorkerNomination[] = [];
      for (const occupant of org.occupants) {
        if (!roleIds.has(occupant.roleId) || seen.has(occupant.workerId)) continue;
        const worker = org.workers.find((w) => w.id === occupant.workerId);
        if (!worker?.active) continue;
        seen.add(occupant.workerId);
        nominations.push({ workerId: occupant.workerId, source: 'organization' });
      }
      return nominations;
    },
  };
}

/** Union of several nomination sources, de-duplicated by worker id. */
export function anySource(...sources: WorkerNominationSource[]): WorkerNominationSource {
  return {
    nominate(capabilityId: string): WorkerNomination[] {
      const byWorker = new Map<string, WorkerNomination>();
      for (const source of sources) {
        for (const nomination of source.nominate(capabilityId)) {
          if (!byWorker.has(nomination.workerId)) byWorker.set(nomination.workerId, nomination);
        }
      }
      return [...byWorker.values()];
    },
  };
}
