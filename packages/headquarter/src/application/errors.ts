/**
 * Typed outcomes for the Headquarter application/service layer (issue #139,
 * HQ lane F).
 *
 * Every service entry point returns an `OpsResult` instead of throwing for an
 * *expected* refusal, so a UI/Founder surface can render a precise reason
 * without string-matching exception messages. Hostile paths inside the
 * canonical Operator (`operator/queue.ts`) still throw loudly; this layer
 * catches those throws and maps them onto the same typed shape AFTER the
 * queue has already written its evidence entry — the refusal is never
 * swallowed, only re-shaped.
 *
 * Deliberately mirrors `organization/types.ts`'s `OrgResult` so Headquarter
 * has one result convention, not two.
 */

export type OpsErrorCode =
  /** The referenced task/worker/capability/mission does not exist. */
  | 'not_found'
  /** Input failed shape/validation checks before anything was attempted. */
  | 'invalid_input'
  /** Deny-by-default: the capability registry/policy refused the action. */
  | 'policy_denied'
  /** The capability exists but is disabled in the registry. */
  | 'capability_disabled'
  /** The worker is not allowed this capability by the specialist directory. */
  | 'capability_not_allowed'
  /** Kill switch engaged globally or for this capability — no new claims. */
  | 'kill_switch_engaged'
  /** Worker is inactive, disabled, replaced, or otherwise not assignable. */
  | 'worker_not_assignable'
  /** Nothing claimable right now (empty queue) — not an error condition. */
  | 'nothing_claimable'
  /**
   * The next queued task names a different intended owner who is still
   * assignable. Deny-only: it withholds a claim, it never grants one.
   */
  | 'reserved_for_other_worker'
  /** The task is not in a status this operation is legal from. */
  | 'illegal_state'
  /**
   * The Founder acted on an action digest that no longer matches the task's
   * current canonical digest — the action changed between display and
   * decision. The approval is refused at the UI boundary.
   */
  | 'action_changed_since_display'
  /** Approval missing/expired/consumed/mutated at the execution boundary. */
  | 'approval_rejected'
  /** Fence/claim-nonce mismatch: a stale or forged claim tried to write. */
  | 'stale_claim'
  /** Independence violation: builder tried to review/approve/reconcile itself. */
  | 'independence_violation'
  /** The worker still holds in-flight work that needs handover/reconciliation. */
  | 'handover_required'
  /** Payload/message content tripped the secret-like-content guard. */
  | 'content_rejected';

export interface OpsError {
  code: OpsErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type OpsResult<T> = { ok: true; data: T } | { ok: false; error: OpsError };

export function opsOk<T>(data: T): OpsResult<T> {
  return { ok: true, data };
}

export function opsErr<T = never>(
  code: OpsErrorCode,
  message: string,
  details?: Record<string, unknown>,
): OpsResult<T> {
  return { ok: false, error: { code, message, details } };
}

/**
 * Map a throw out of the canonical Operator onto a typed code.
 *
 * The queue throws only on hostile/stale paths and has already appended its
 * evidence entry by the time we get here, so this classification is purely
 * presentational — it never decides whether the action was allowed.
 */
export function classifyOperatorError(error: unknown): OpsError {
  const message = error instanceof Error ? error.message : String(error);
  if (/Stale fence/i.test(message)) {
    return { code: 'stale_claim', message };
  }
  if (/may not (approve|review) its own|requires an independent reviewer/i.test(message)) {
    return { code: 'independence_violation', message };
  }
  if (/approval/i.test(message)) {
    return { code: 'approval_rejected', message };
  }
  if (/^Unknown (task|capability|approval)/i.test(message)) {
    return { code: 'not_found', message };
  }
  if (/secret-like content/i.test(message)) {
    return { code: 'content_rejected', message };
  }
  if (/Illegal activity transition|is not (running|outcome_unknown|awaiting approval)|has no result awaiting review|not idempotent/i.test(message)) {
    return { code: 'illegal_state', message };
  }
  return { code: 'illegal_state', message };
}
