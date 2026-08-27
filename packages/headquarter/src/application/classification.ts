/**
 * Task classification for the Headquarter service layer (HQ lane F).
 *
 * Classification is DERIVED, never declared. Every field below comes from the
 * capability registry entry plus the Founder's standing pre-approval set —
 * exactly the inputs `operator/policy.ts` already uses. Nothing here reads the
 * task payload, the requesting worker's self-description, a nomination, or a
 * group-room message: an AI worker cannot talk its way into a lower risk
 * class (war room #41).
 *
 * This module adds NO new gate and relaxes none. It is a read-only projection
 * so the Founder console can explain *why* a task is gated, in the same
 * vocabulary the Operator enforces.
 */

import type { Capability, RiskClass } from '../operator/capabilities.js';
import { approvalRequired, type PolicyContext } from '../operator/policy.js';

/** How a task will travel once created — presentation of policy, not policy. */
export type TaskRoute = 'auto' | 'founder_approval';

export interface TaskClassification {
  capabilityId: string;
  riskClass: RiskClass;
  sideEffect: boolean;
  idempotent: boolean;
  /** True when a bound, unexpired, unconsumed Founder approval is required. */
  requiresApproval: boolean;
  /**
   * True when the executing worker can never self-complete: any side-effect
   * capability's result waits for an INDEPENDENT reviewer (queue.complete()).
   */
  requiresIndependentReview: boolean;
  /** Side-effect capabilities cannot be enqueued without an idempotency key. */
  requiresIdempotencyKey: boolean;
  route: TaskRoute;
  /** Plain-language reason shown in the Founder Approval Center. */
  reason: string;
}

export function classifyCapability(
  capability: Capability,
  ctx: PolicyContext = {},
): TaskClassification {
  const needsApproval = approvalRequired(capability, ctx);
  return {
    capabilityId: capability.id,
    riskClass: capability.riskClass,
    sideEffect: capability.sideEffect,
    idempotent: capability.idempotent,
    requiresApproval: needsApproval,
    requiresIndependentReview: capability.sideEffect,
    requiresIdempotencyKey: capability.sideEffect,
    route: needsApproval ? 'founder_approval' : 'auto',
    reason: needsApproval
      ? `Risk class ${capability.riskClass} requires an explicit Founder approval bound to this exact action`
      : `Risk class ${capability.riskClass} executes under standing policy`,
  };
}
