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

/**
 * Whether a risk class demands a Founder approval when NO capability is bound
 * yet (Phase 3 mission planning, issue #253).
 *
 * A planned mission task names a risk class before it names a capability, so
 * there is no registry row for `approvalRequired` to read and no capability id
 * a standing pre-approval could match. The only honest answer at that point is
 * the stricter one: every class that CAN require approval is treated as
 * requiring it. This is a planning-time statement for the Founder to read; the
 * enforced decision is still made by `approvalRequired`/`evaluatePolicy` from
 * the real capability row when the task is opened as canonical work.
 */
export function riskClassRequiresFounderApproval(riskClass: RiskClass): boolean {
  return FOUNDER_GATED.includes(riskClass) || APPROVAL_GATED.includes(riskClass);
}

export interface PolicyContext {
  /** Capability ids the Founder has standing-approved for automatic execution. */
  preApprovedCapabilities?: ReadonlySet<string>;
}

/**
 * Whether executing this capability requires a bound, unexpired, unconsumed
 * Founder approval record (issue #53 correction A). Derived only from the
 * registry entry + standing pre-approvals — never from the task payload.
 * Checked again at the execution boundary (claim/start), not just enqueue.
 */
export function approvalRequired(capability: Capability, ctx: PolicyContext = {}): boolean {
  if (FOUNDER_GATED.includes(capability.riskClass)) return true;
  if (APPROVAL_GATED.includes(capability.riskClass)) {
    return !ctx.preApprovedCapabilities?.has(capability.id);
  }
  return false;
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
