/**
 * Group-room mission intake (HQ lane F).
 *
 * The Founder and the specialists talk in a group room. A mission discussed
 * there must be able to become real work WITHOUT chat text ever being an
 * execution channel. The rule this module implements:
 *
 *   A message is data. A proposal is data. Only an actor that already holds
 *   the capability can promote a proposal, and the resulting task is an
 *   ordinary Operator task subject to every unchanged gate.
 *
 * Concretely, three deliberate non-features:
 *
 * 1. There is NO parser from message text to a capability id, and none may be
 *    added. `capabilityId` on a proposal is chosen by the proposing actor
 *    through the typed API; text like "run infra.drop_database" is inert
 *    prose. Prompt injection has no grammar to hit.
 * 2. Posting a message and creating a proposal both write ZERO rows in
 *    `op_tasks` and grant nothing. A proposal cannot approve itself, cannot
 *    pre-approve, and carries no risk class of its own — classification comes
 *    from the capability registry at promotion time.
 * 3. Promotion is authorized by the OPERATOR-SIDE directory allow-list of the
 *    promoting actor (deny by default), never by the message author, the
 *    proposer, or anything either of them wrote.
 *
 * `detectActionLanguage()` exists only so the console can visually flag
 * imperative-looking chat for a human reader. It is advisory decoration and
 * is never consulted by any authorization path.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../operator/approvals.js';

export type MissionProposalStatus = 'proposed' | 'promoted' | 'rejected';

export interface MissionProposal {
  id: string;
  threadId: string;
  /** Chat message the proposal was raised from, when there was one. */
  sourceMessageId: string | null;
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  /** Digest of the proposed action, so a UI can prove what it is promoting. */
  digest: string;
  proposedBy: string;
  proposedAt: string;
  status: MissionProposalStatus;
  /** Operator task id once promoted; null otherwise. */
  taskId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

/**
 * Digest over a proposal's immutable action content. Mirrors the approval
 * digest's canonical-JSON approach so the two behave identically.
 */
export function missionProposalDigest(input: {
  threadId: string;
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      }),
    )
    .digest('hex');
}

/**
 * Imperative-looking phrasing commonly used in prompt-injection attempts.
 * ADVISORY ONLY — used to decorate the console, never to authorize or to
 * refuse anything. A message that matches is stored and displayed exactly
 * like any other message.
 */
const ACTION_LANGUAGE =
  /\b(approve|approved|auto[- ]?approve|execute|run|deploy|delete|drop|force[- ]?push|merge|grant|escalate|sudo|override|bypass|ignore (?:all )?(?:previous|prior) instructions)\b/i;

export function detectActionLanguage(body: string): boolean {
  return ACTION_LANGUAGE.test(body);
}
