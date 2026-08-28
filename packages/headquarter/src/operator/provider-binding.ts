/**
 * Provider binding — an execution authority, not a label (issue #200,
 * Codex P1 #1).
 *
 * ## The defect this closes
 *
 * A direct order resolves a route ("this order goes to CLAUDE") and refuses to
 * substitute one provider for another at creation time. But the resolved
 * provider was only payload METADATA: `OperatorQueue.claim()` hands out the
 * head-of-queue task for a capability to any worker the directory allows, so a
 * CODEX worker holding `hq.direct_order` could claim, start and execute an
 * order that was explicitly routed to CLAUDE. The no-substitution guarantee
 * held at the front door and evaporated at the back one.
 *
 * ## The rule
 *
 * A task whose payload declares `executionProvider` may only be claimed and
 * started by a worker whose execution provider is DECLARED and identical.
 * Everything else is refused, loudly:
 *
 *   - payload declares a provider, worker has no declared provider  → refused
 *   - payload declares a provider, worker's provider differs        → refused
 *   - payload declares a malformed provider (not a non-empty string)→ refused
 *   - payload declares nothing                                      → unchanged
 *
 * Deny by default in both directions, and the binding can only ever NARROW who
 * may execute: it removes candidates, never adds one, so a payload cannot use
 * it to reach a worker that the capability allow-list, assignability and
 * approval gates would not already admit.
 *
 * ## Why the mapping is declared and never inferred
 *
 * HQ holds two provider vocabularies — routing ids (`CLAUDE`, `CODEX`) and
 * registry vendor ids (`anthropic`, `openai`) — and a worker's `vendor` string
 * is a description of who makes it, not a statement about which executor runs
 * it. Guessing `openai → CODEX` would be exactly the kind of invented business
 * rule this repository forbids. So the mapping lives in its own table, written
 * deliberately, and an undeclared worker is refused rather than guessed at.
 *
 * ## Where it is enforced
 *
 * In `OperatorQueue.claim()` and `OperatorQueue.start()` — the canonical
 * execution boundary — so every caller inherits it, including one that never
 * goes through `HeadquarterOperations`. `executionProvider` lives in the
 * payload, so it is inside the action digest a Founder approves: the provider
 * cannot be swapped between the approval and the execution without
 * invalidating the approval.
 */

import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';

/** Reserved payload key carrying the provider a task is bound to. */
export const EXECUTION_PROVIDER_KEY = 'executionProvider';

export type ProviderBinding =
  /** The payload says nothing about a provider — any eligible worker may claim. */
  | { bound: false }
  /** The payload binds the task to exactly one provider. */
  | { bound: true; provider: string }
  /** The key is present but unusable. Nobody may claim; fail closed. */
  | { bound: true; provider: null };

/** Read the binding a task payload declares. Never throws. */
export function readProviderBinding(payload: Record<string, unknown> | null | undefined): ProviderBinding {
  if (payload == null || !Object.prototype.hasOwnProperty.call(payload, EXECUTION_PROVIDER_KEY)) {
    return { bound: false };
  }
  const value = payload[EXECUTION_PROVIDER_KEY];
  if (typeof value === 'string' && value.trim() !== '') {
    return { bound: true, provider: value };
  }
  return { bound: true, provider: null };
}

/** Raised when a worker may not act on a provider-bound task. */
export class ProviderBindingViolation extends Error {
  constructor(
    readonly taskId: string,
    readonly workerId: string,
    readonly requiredProvider: string | null,
    readonly workerProvider: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderBindingViolation';
  }
}

export interface WorkerProviderRecord {
  workerId: string;
  providerId: string;
  declaredBy: string;
  declaredAt: string;
}

/**
 * The declared worker → provider map.
 *
 * Configuration, not invocation: writing to it is a deliberate act recorded
 * with who declared it and when. Reading it is what the execution boundary
 * does on every claim of a bound task.
 */
export class WorkerProviderDirectory {
  constructor(private db: HqDatabase) {}

  /** Declare (or re-declare) which provider a worker executes as. */
  declare(workerId: string, providerId: string, declaredBy: string): void {
    if (!workerId || !providerId || !declaredBy) {
      throw new Error('A provider declaration needs a worker, a provider and a declaring actor');
    }
    this.db
      .prepare(
        `INSERT INTO op_worker_providers (worker_id, provider_id, declared_by, declared_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           provider_id = excluded.provider_id,
           declared_by = excluded.declared_by,
           declared_at = excluded.declared_at`,
      )
      .run(workerId, providerId, declaredBy, nowIso());
  }

  /** Remove a declaration. The worker can then claim no provider-bound task. */
  revoke(workerId: string): void {
    this.db.prepare(`DELETE FROM op_worker_providers WHERE worker_id = ?`).run(workerId);
  }

  /** The provider this worker executes as, or null when none is declared. */
  providerOf(workerId: string): string | null {
    const row = this.db
      .prepare(`SELECT provider_id FROM op_worker_providers WHERE worker_id = ?`)
      .get(workerId) as { provider_id: string } | undefined;
    return row?.provider_id ?? null;
  }

  list(): WorkerProviderRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM op_worker_providers ORDER BY worker_id`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      workerId: row.worker_id as string,
      providerId: row.provider_id as string,
      declaredBy: row.declared_by as string,
      declaredAt: row.declared_at as string,
    }));
  }
}

/**
 * Decide whether `workerId` may act on a task bound to `binding`.
 *
 * Returns null when it may; a violation (not thrown here, so the caller
 * decides how to record it) when it may not.
 */
export function checkProviderBinding(
  taskId: string,
  workerId: string,
  binding: ProviderBinding,
  workerProvider: string | null,
): ProviderBindingViolation | null {
  if (!binding.bound) return null;
  if (binding.provider == null) {
    return new ProviderBindingViolation(
      taskId,
      workerId,
      null,
      workerProvider,
      `Task ${taskId} declares a malformed ${EXECUTION_PROVIDER_KEY}; no worker may execute it`,
    );
  }
  if (workerProvider == null) {
    return new ProviderBindingViolation(
      taskId,
      workerId,
      binding.provider,
      null,
      `Task ${taskId} is bound to provider ${binding.provider}, but worker ${workerId} has no ` +
        'declared execution provider. Provider identity is declared explicitly, never inferred.',
    );
  }
  if (workerProvider !== binding.provider) {
    return new ProviderBindingViolation(
      taskId,
      workerId,
      binding.provider,
      workerProvider,
      `Task ${taskId} is bound to provider ${binding.provider} and worker ${workerId} executes as ` +
        `${workerProvider}. No substitution is made.`,
    );
  }
  return null;
}
