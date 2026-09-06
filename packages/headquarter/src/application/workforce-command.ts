/**
 * Workforce Command — the `hq.workforce_assign` capability trio (Phase 4,
 * issue #262).
 *
 * The one capability a Founder workforce-assignment act exercises: recording
 * an ADVISORY task -> worker assignment intent from the browser, and reading
 * the eligibility evaluation that informs it. It follows the mission/project
 * CONFIGURATION-vs-INVOCATION pattern exactly: registration is a separate
 * explicit act, invocation fails closed on missing/altered/disabled, and
 * detection never repairs.
 *
 * What this capability deliberately is NOT:
 * - not an execution right — an assignment intent changes no task status,
 *   burns no approval, dispatches nothing; the worker still claims through
 *   the atomic fenced path under policy/approval/review;
 * - not queue authority — claiming stays strictly FIFO; the intent only
 *   NARROWS (claimNext refuses the head task to a different worker);
 * - not a worker-facing power — the facade refuses worker identity outright,
 *   so no worker can assign work to itself or anybody else.
 */

import type { HqDatabase } from '../store/db.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';

export const WORKFORCE_ASSIGN_CAPABILITY = {
  id: 'hq.workforce_assign',
  description:
    'Founder workforce assignment — records advisory task-to-worker assignment intent and ' +
    'reads eligibility. Narrows claiming only; executes nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const;

/** Register the workforce-assign capability — a CONFIGURATION action. */
export function registerWorkforceAssignCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...WORKFORCE_ASSIGN_CAPABILITY });
}

export const WORKFORCE_ASSIGN_RESERVED_CONTRACT = {
  riskClass: WORKFORCE_ASSIGN_CAPABILITY.riskClass,
  sideEffect: WORKFORCE_ASSIGN_CAPABILITY.sideEffect,
  idempotent: WORKFORCE_ASSIGN_CAPABILITY.idempotent,
} as const;

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function workforceAssignContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== WORKFORCE_ASSIGN_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== WORKFORCE_ASSIGN_RESERVED_CONTRACT.sideEffect)
    drift.push('sideEffect');
  if (capability.idempotent !== WORKFORCE_ASSIGN_RESERVED_CONTRACT.idempotent)
    drift.push('idempotent');
  return drift;
}

export type WorkforceAssignCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/**
 * Classify the registry's current row. Callers supply the row from an
 * ENFORCEMENT-SAFE read, never from `queue.capabilities` (#219). Drift is
 * checked before `enabled`, and detecting drift never repairs it.
 */
export function workforceAssignCapabilityState(
  capability: Capability | null,
): WorkforceAssignCapabilityState {
  if (!capability) return 'missing';
  if (workforceAssignContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

/** Bound on the free-text rationale a Founder may attach to an assignment. */
export const MAX_ASSIGNMENT_RATIONALE_LENGTH = 500;
