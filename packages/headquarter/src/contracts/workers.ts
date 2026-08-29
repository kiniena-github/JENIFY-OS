/**
 * Vendor-neutral worker/specialist contracts.
 *
 * Claude, Codex, Jules, and Google specialist tools are all just
 * WorkerAdapter implementations registered in the specialist directory.
 * No vendor is hard-coded as "the system" (issue #42, order 6).
 */

import type { ActivityStatus } from './events.js';

/**
 * Broad role a worker plays in the org. Informational, not a permission.
 *
 * Listed as a runtime array so a CLI can validate what an operator typed
 * against the same source the type comes from — one list, not two that drift.
 */
export const WORKER_ROLES = [
  'build_lead',
  'parallel_implementer',
  'reviewer_gatekeeper',
  'specialist_tool',
  'mission_director',
] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export interface WorkerDescriptor {
  /** Stable id, e.g. 'claude', 'codex', 'jules', 'google-notebooklm'. */
  id: string;
  displayName: string;
  vendor: string;
  role: WorkerRole;
  /**
   * Capability ids (see operator/capabilities.ts) this worker may claim.
   * Permissions live HERE plus the capability registry — never in the
   * worker's own self-description at runtime. Deny by default.
   */
  allowedCapabilities: string[];
  /** Whether the worker is currently enabled at all. */
  active: boolean;
}

export interface WorkerStatusReport {
  workerId: string;
  taskId: string;
  status: ActivityStatus;
  summary: string;
  /** Evidence references: PR/issue URLs, commit SHAs, test output paths. */
  refs?: string[];
}

/**
 * The integration seam for any AI worker or specialist tool.
 *
 * IMPORTANT SECURITY BOUNDARY: adapters receive a task payload and a fencing
 * token. They never receive credentials through this interface; credential
 * material lives only in the execution worker's own isolated environment
 * (issue #42, order 5) and must never appear in payloads, events, evidence,
 * or chat.
 */
export interface WorkerAdapter {
  descriptor: WorkerDescriptor;
  /**
   * Ask the worker to start a claimed task. Implementations dispatch to the
   * vendor-specific surface (API, GitHub issue, queue…). They report progress
   * only via WorkerStatusReport events — never by mutating queue rows
   * directly.
   */
  dispatch(task: DispatchedTask): Promise<void>;
}

export interface DispatchedTask {
  taskId: string;
  capabilityId: string;
  /** Fencing token; all writes back to the queue must carry it. */
  fence: number;
  /** JSON-serializable task input. Never contains secrets. */
  payload: Record<string, unknown>;
  /** Idempotency key (required for side-effect capabilities). */
  idempotencyKey?: string;
}
