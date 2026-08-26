/**
 * Policy-based risk gates.
 *
 * The decision is derived ONLY from the capability registry entry and the
 * requesting worker's allow-list — never from anything the worker says about
 * the task. AI workers may not self-declare an action safe (war room #41).
 */

import type { Capability, RiskClass } from './capabilities.js';

export type PolicyDecision =
  | { outcome: 'allow' }
  | { outcome: 'needs_approval'; reason: string }
  | { outcome: 'deny'; reason: string };

/** Risk classes that always require an explicit Founder approval. */
const FOUNDER_GATED: readonly RiskClass[] = ['destructive', 'founder_gate'];

/** Risk classes that require approval unless the Founder pre-approved the capability via policy. */
const APPROVAL_GATED: readonly RiskClass[] = ['external_side_effect'];

export interface PolicyContext {
  /** Capability ids the Founder has standing-approved for automatic execution. */
  preApprovedCapabilities?: ReadonlySet<string>;
}

export function evaluatePolicy(
  capability: Capability | null,
  requestedBy: { workerId: string; allowedCapabilities: readonly string[] },
  ctx: PolicyContext = {},
): PolicyDecision {
  if (!capability) {
    return { outcome: 'deny', reason: 'Unknown capability (deny by default)' };
  }
  if (!capability.enabled) {
    return { outcome: 'deny', reason: `Capability ${capability.id} is disabled` };
  }
  if (!requestedBy.allowedCapabilities.includes(capability.id)) {
    return {
      outcome: 'deny',
      reason: `Worker ${requestedBy.workerId} is not allowed capability ${capability.id} (least privilege)`,
    };
  }
  if (FOUNDER_GATED.includes(capability.riskClass)) {
    return {
      outcome: 'needs_approval',
      reason: `Risk class ${capability.riskClass} always requires Founder approval`,
    };
  }
  if (APPROVAL_GATED.includes(capability.riskClass)) {
    if (ctx.preApprovedCapabilities?.has(capability.id)) {
      return { outcome: 'allow' };
    }
    return {
      outcome: 'needs_approval',
      reason: `External side effect ${capability.id} has no standing Founder pre-approval`,
    };
  }
  return { outcome: 'allow' };
}
