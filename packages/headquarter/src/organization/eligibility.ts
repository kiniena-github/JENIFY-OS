/**
 * Deny-by-default eligibility check: may `worker` hold `role`?
 *
 * Mirrors the shape of operator/policy.ts's `evaluatePolicy` deliberately —
 * same "derive only from registry/allow-list data, never from what the
 * subject claims about itself" philosophy, applied to org roles instead of
 * Operator capabilities. This function makes NO decision from provider name
 * or occupant identity — only from `worker.active`, `role.eligibleOccupantTypes`,
 * and a subset check between `role.requiredCapabilities` and
 * `worker.allowedCapabilities`.
 */

import type { EligibilityDecision, OrgWorker, Role } from './types.js';

export function evaluateRoleEligibility(role: Role, worker: OrgWorker): EligibilityDecision {
  if (!worker.active) {
    return { eligible: false, reason: 'worker_inactive' };
  }
  if (!role.eligibleOccupantTypes.includes(worker.occupantType)) {
    return {
      eligible: false,
      reason: 'occupant_type_not_eligible',
      details: { occupantType: worker.occupantType, eligibleOccupantTypes: role.eligibleOccupantTypes },
    };
  }
  const missing = role.requiredCapabilities.filter((c) => !worker.allowedCapabilities.includes(c));
  if (missing.length > 0) {
    return { eligible: false, reason: 'capability_not_granted', details: { missing } };
  }
  return { eligible: true };
}
