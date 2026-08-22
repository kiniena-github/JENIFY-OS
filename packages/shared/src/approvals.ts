// Shared Approvals vocabulary — ONE reusable JENIFY Core capability.
// Every module that needs sign-off (procurement, stock adjustments, discounts,
// expenses, sensitive config, sensitive AI actions, sector workflows) uses this
// same engine rather than inventing its own. Enforcement is always server-side.

/**
 * What kind of thing is being approved. Open string set (a stable slug per
 * use-site, e.g. 'stock_adjustment', 'discount', 'purchase_order') so new
 * call-sites do not require a schema change; policies match on it.
 */
export type ApprovalSubjectType = string;

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_ACTIONS = [
  'submit',
  'approve',
  'reject',
  'cancel',
  'comment',
  'resubmit',
] as const;
export type ApprovalActionKind = (typeof APPROVAL_ACTIONS)[number];

/**
 * A versioned approval policy. Off by default (a subject with no policy needs
 * no approval), threshold-triggered so the small business stays simple and the
 * larger one gets control. `steps` supports one-step or multi-step chains.
 */
export interface ApprovalPolicy {
  subjectType: ApprovalSubjectType;
  /** engaged only when the subject's numeric magnitude (e.g. cents) is >= this;
   *  null/0 = always require approval when a policy exists */
  thresholdMinor?: number | null;
  /** ordered approval steps; each names a role that must approve */
  steps: Array<{
    /** role CODE that may approve this step */
    approverRoleCode: string;
    labelKey?: string;
  }>;
  /** separation of duties: the requester may never approve their own request */
  separationOfDuties: boolean;
  active: boolean;
}

/** True when a subject of the given magnitude requires approval under a policy. */
export function policyRequiresApproval(
  policy: ApprovalPolicy | null | undefined,
  magnitudeMinor: number,
): boolean {
  if (!policy || !policy.active) return false;
  const threshold = policy.thresholdMinor ?? 0;
  return magnitudeMinor >= threshold;
}
