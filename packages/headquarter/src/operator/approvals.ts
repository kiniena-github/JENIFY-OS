/**
 * Founder-approval binding (issue #53, correction A).
 *
 * An approval is not a boolean on a task — it is a record bound to the exact
 * immutable action the Founder saw:
 *
 * - `actionDigest`: SHA-256 over the canonical serialization of the task's
 *   identity + capability + payload + idempotency key. Any mutation of the
 *   capability or payload after approval changes the digest and invalidates
 *   the approval.
 * - `expiresAt`: approvals are time-boxed; an expired approval can never
 *   admit a task to execution.
 * - single-use nonce: the approval row id is consumed exactly once, at claim
 *   time. A re-queued or replayed task needs a fresh Founder approval.
 *
 * Validation happens at the execution boundary (claim/start in
 * operator/queue.ts), not only at approve time, so a payload mutated between
 * approval and execution is always caught.
 */

import { createHash } from 'node:crypto';

/** Default approval time-box. Configurable per approval via approve(). */
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60_000;

/**
 * Canonical JSON: deterministic serialization with recursively sorted object
 * keys, so the digest of a payload does not depend on key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export interface ApprovableAction {
  /** The exact task row the approval binds to — never transferable. */
  taskId: string;
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
}

/** SHA-256 digest of the canonical serialized action. */
export function canonicalActionDigest(action: ApprovableAction): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        taskId: action.taskId,
        capabilityId: action.capabilityId,
        payload: action.payload,
        idempotencyKey: action.idempotencyKey,
      }),
    )
    .digest('hex');
}

/** Digest of an operator task row (adapter from the task shape to ApprovableAction). */
export function taskActionDigest(task: {
  id: string;
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
}): string {
  return canonicalActionDigest({
    taskId: task.id,
    capabilityId: task.capabilityId,
    payload: task.payload,
    idempotencyKey: task.idempotencyKey,
  });
}

/** Why an approval failed validation at the execution boundary. */
export type ApprovalRejection =
  | 'approval_missing'
  | 'approval_not_approved'
  | 'approval_expired'
  | 'approval_already_consumed'
  | 'approval_digest_mismatch'
  | 'approval_claim_binding_mismatch';

export interface ApprovalRecordForValidation {
  decision: string;
  actionDigest: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
}

/**
 * Consumption binding written atomically with the single-use nonce at claim
 * time (issue #77): which worker's claim consumed the approval, under which
 * fencing token, and the random per-claim nonce that the claim also stamped
 * onto the task row.
 */
export interface ApprovalConsumptionForValidation {
  consumedAt: string | null;
  consumedBy: string | null;
  /** Exact task the consuming claim was for (issue #79). */
  consumedTaskId: string | null;
  consumedFence: number | null;
  consumedClaimNonce: string | null;
}

/**
 * Verify at execution start that the approval was consumed by exactly the
 * claim now trying to execute (issues #77/#79): same worker, same task, same
 * fencing token, same per-claim nonce as the task row carries. A consumed
 * approval reattached to a forced assigned state, a different worker/claim,
 * or a different task (even behind a forged action digest) can never satisfy
 * all four, and an approval that was never consumed (a forced state that
 * skipped the claim path) has no binding at all. Missing binding fields never
 * admit anything.
 */
export function validateApprovalClaimBinding(
  record: ApprovalConsumptionForValidation | null,
  claim: { taskId: string; workerId: string; fence: number; claimNonce: string | null },
): ApprovalRejection | null {
  if (!record) return 'approval_missing';
  if (
    !record.consumedAt ||
    !record.consumedBy ||
    !record.consumedTaskId ||
    record.consumedFence === null ||
    !record.consumedClaimNonce ||
    !claim.claimNonce ||
    record.consumedBy !== claim.workerId ||
    record.consumedTaskId !== claim.taskId ||
    record.consumedFence !== claim.fence ||
    record.consumedClaimNonce !== claim.claimNonce
  ) {
    return 'approval_claim_binding_mismatch';
  }
  return null;
}

/**
 * Single source of truth for the expiry boundary: an approval is expired at
 * or after `expiresAt` (`now >= expiresAt`, ISO-8601 string comparison), and
 * a missing/unbound expiry never admits anything. Used by validateApproval()
 * at claim and re-checked at actual execution start (issue #71), where the
 * nonce is already legitimately consumed by the claim and only the time-box
 * can still be re-validated.
 */
export function approvalExpiredAt(
  record: Pick<ApprovalRecordForValidation, 'expiresAt'> | null,
  now: Date = new Date(),
): boolean {
  return !record?.expiresAt || now.toISOString() >= record.expiresAt;
}

/**
 * Validate an approval record against the task's CURRENT canonical digest.
 * Returns null when the approval admits execution, otherwise the rejection
 * reason. Missing digest/expiry on the record is treated as invalid — an
 * unbound approval never admits anything.
 */
export function validateApproval(
  record: ApprovalRecordForValidation | null,
  currentDigest: string,
  now: Date = new Date(),
): ApprovalRejection | null {
  if (!record) return 'approval_missing';
  if (record.decision !== 'approved') return 'approval_not_approved';
  // Digest mismatch outranks every other rejection: a mutated action is a
  // hostile signal and must be blocked, not politely sent back for re-approval.
  if (!record.actionDigest || record.actionDigest !== currentDigest) {
    return 'approval_digest_mismatch';
  }
  if (approvalExpiredAt(record, now)) return 'approval_expired';
  if (record.consumedAt) return 'approval_already_consumed';
  return null;
}
