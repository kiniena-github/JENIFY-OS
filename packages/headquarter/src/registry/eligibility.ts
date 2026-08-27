/**
 * The single canonical derivation of what an AI member is currently allowed
 * to be routed for (issue #131 correction to #119).
 *
 * WHY THIS FILE EXISTS: role eligibility used to be stored as its own
 * mutable column, updated only by `setRoleEligibility`. Every other path
 * that could invalidate it — revoking a granted capability through
 * `update()`, tightening a role's `requiredCapabilities`, disabling a
 * capability registry-wide, importing a snapshot — left the stored value
 * behind, so a member could stay marked eligible for a role whose full
 * requirements it no longer met, and `rankMembers()` would route to it.
 *
 * The fix is structural rather than a patch on each mutation path: there is
 * no stored eligibility any more, so there is nothing that can go stale.
 * Exactly one fact is persisted — `assignedRoles`, the roles a registrar
 * intentionally put the member forward for — and eligibility is recomputed
 * from current truth on every single read:
 *
 *   effectiveCapabilities = grantedCapabilities ∩ {registered AND enabled}
 *   roleEligibility       = assignedRoles whose requirements ⊆ effectiveCapabilities
 *   suspendedRoles        = assignedRoles that fail that test, with the reason
 *
 * Keeping intent (`assignedRoles`) separate from truth (`roleEligibility`)
 * is what lets the Founder revoke a capability and later restore it without
 * the original assignment being silently destroyed in between — while the
 * member is correctly ineligible for the whole period the capability is
 * gone. Derivation can only ever narrow: a role is never added to
 * eligibility that a registrar did not explicitly assign, so no code path
 * here can widen a member's permissions.
 */

import type { HqDatabase } from '../store/db.js';

/** Why an assigned role is not currently eligible. Both cases fail closed. */
export type SuspensionReason = 'missing_capabilities' | 'unknown_role';

export interface SuspendedRole {
  roleId: string;
  /** Required capabilities the member does not currently hold effectively. Empty for 'unknown_role'. */
  missingCapabilities: string[];
  reason: SuspensionReason;
}

export interface DerivedEligibility {
  effectiveCapabilities: string[];
  roleEligibility: string[];
  suspendedRoles: SuspendedRole[];
}

/**
 * Current-truth inputs the derivation needs. Loaded once per read so
 * deriving a whole member list costs two queries, not two per member.
 */
export interface EligibilityContext {
  /** Capability ids that are both registered AND enabled right now. */
  grantableCapabilityIds: ReadonlySet<string>;
  /** roleId -> requiredCapabilities, as currently defined. */
  roleRequirements: ReadonlyMap<string, readonly string[]>;
}

/**
 * Pure derivation — no database, no clock, no side effects. Given what a
 * member was granted and assigned plus the current state of the capability
 * and role registries, returns what is true right now.
 */
export function deriveEligibility(
  grantedCapabilities: readonly string[],
  assignedRoles: readonly string[],
  context: EligibilityContext,
): DerivedEligibility {
  const effectiveCapabilities = grantedCapabilities.filter((capId) =>
    context.grantableCapabilityIds.has(capId),
  );
  const effectiveSet = new Set(effectiveCapabilities);

  const roleEligibility: string[] = [];
  const suspendedRoles: SuspendedRole[] = [];

  for (const roleId of assignedRoles) {
    const required = context.roleRequirements.get(roleId);
    if (!required) {
      // A role that no longer exists cannot be shown to be satisfied, so it
      // must not confer eligibility.
      suspendedRoles.push({ roleId, missingCapabilities: [], reason: 'unknown_role' });
      continue;
    }
    const missingCapabilities = required.filter((capId) => !effectiveSet.has(capId));
    if (missingCapabilities.length > 0) {
      suspendedRoles.push({ roleId, missingCapabilities, reason: 'missing_capabilities' });
    } else {
      roleEligibility.push(roleId);
    }
  }

  return { effectiveCapabilities, roleEligibility, suspendedRoles };
}

/**
 * Reads the current capability-enablement and role-requirement state. A
 * capability that is registered but disabled is deliberately absent from
 * `grantableCapabilityIds`: `MemberCapabilityRegistry.isGrantable` refuses
 * to grant it, so a grant made before it was disabled must not keep
 * conferring eligibility either.
 */
export function loadEligibilityContext(db: HqDatabase): EligibilityContext {
  const capRows = db
    .prepare(`SELECT id FROM hq_member_capabilities WHERE enabled = 1`)
    .all() as { id: string }[];
  const roleRows = db
    .prepare(`SELECT role_id, required_capabilities FROM hq_member_roles`)
    .all() as { role_id: string; required_capabilities: string }[];

  return {
    grantableCapabilityIds: new Set(capRows.map((r) => r.id)),
    roleRequirements: new Map(
      roleRows.map((r) => [r.role_id, JSON.parse(r.required_capabilities) as string[]]),
    ),
  };
}
