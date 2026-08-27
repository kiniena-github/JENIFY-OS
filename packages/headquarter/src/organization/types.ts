/**
 * Editable organization + workforce runtime model (issue #118, HQ special
 * lane B).
 *
 * This module is a pure, deterministic domain engine over JSON-serializable
 * state. It has NO database, NO randomness, and NO side effects outside the
 * state it is handed back and forth by the caller. Persistence adapters
 * (SQLite, etc.) are a later concern layered on top of `OrgState`.
 *
 * Vendor neutrality: nothing in this module hard-codes a provider name.
 * 'chatgpt' | 'claude' | 'gemini' | 'codex' | 'jules' | any future string are
 * all just data carried on `OrgWorker.provider` — see contracts/workers.ts
 * for the same principle in the Operator layer.
 *
 * Capability references: `Role.requiredCapabilities` and
 * `OrgWorker.allowedCapabilities` hold capability ids only (see
 * operator/capabilities.ts). This module never grants, mutates, or
 * interprets capability semantics itself — it only checks that a worker's
 * allow-list is a superset of a role's requirement (see engine.ts,
 * `isEligible`). The real WorkerDescriptor / CapabilityRegistry passed in by
 * a caller (via `import type`) are never mutated by this module — org edits
 * cannot grant Operator side-effect rights (invariant, enforced + tested).
 */

/** Occupant kind an assignment can be made to. */
export type OccupantType = 'human' | 'ai' | 'external';

export interface Department {
  id: string;
  name: string;
  /** Null for a top-level department. */
  parentDepartmentId: string | null;
}

/**
 * Whether a role may be combined with other roles for the same worker.
 * - 'exclusive': a worker holding this role may hold no other role, and no
 *   worker holding any other role may take this one.
 * - 'shared': combinable with other 'shared' roles, subject to the org-level
 *   `allowMultiRolePerWorker` policy flag still being on.
 */
export type RoleExclusivity = 'exclusive' | 'shared';

export interface Role {
  id: string;
  name: string;
  departmentId: string;
  /** Optional designation that this role is a manager role. */
  isManagerRole: boolean;
  /** Reporting line: the role id this role reports to, or null for the top. */
  reportsToRoleId: string | null;
  /** Desired headcount for this role; drives the vacancy read model. */
  teamSizeTarget: number;
  /** Maximum simultaneous occupants this role may carry. */
  maxOccupants: number;
  exclusivity: RoleExclusivity;
  /** Occupant types eligible to be assigned to this role. */
  eligibleOccupantTypes: OccupantType[];
  /** Capability ids required to hold this role. Refs only, never grants. */
  requiredCapabilities: string[];
}

export interface OrgWorker {
  id: string;
  displayName: string;
  occupantType: OccupantType;
  /** Data only — e.g. 'chatgpt' | 'claude' | 'gemini' | 'codex' | 'jules' | any future string. */
  provider?: string;
  active: boolean;
  /**
   * Capability ids this worker snapshot is allowed. This is THIS module's
   * own copy (captured at registerWorker time) — never a live reference into
   * the real WorkerDescriptor / CapabilityRegistry, and never written back
   * to them.
   */
  allowedCapabilities: string[];
}

export interface Occupant {
  /** Deterministic id: `${roleId}::${workerId}`. */
  id: string;
  roleId: string;
  workerId: string;
  assignedAt: string;
  assignedBy: string;
  metadata?: Record<string, unknown>;
}

export interface TaskForce {
  id: string;
  purpose: string;
  memberWorkerIds: string[];
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  dissolved: boolean;
  dissolvedAt: string | null;
  dissolvedBy: string | null;
  dissolvedReason: string | null;
}

export type TaskOwnershipState = 'owned' | 'handover_pending';

export interface TaskOwnership {
  taskId: string;
  roleId: string;
  /** Current owning worker; null while a handover has no target yet. */
  workerId: string | null;
  state: TaskOwnershipState;
  registeredAt: string;
  registeredBy: string;
  updatedAt: string;
}

export interface Handover {
  id: string;
  taskId: string;
  fromWorkerId: string;
  toWorkerId: string | null;
  reason: string;
  status: 'pending' | 'completed';
  initiatedAt: string;
  initiatedBy: string;
  completedAt: string | null;
  completedBy: string | null;
}

export interface OrgPolicy {
  /**
   * Org-wide gate on multi-role assignment. Even when true, a role marked
   * 'exclusive' still forbids combination (per-role exclusivity wins).
   */
  allowMultiRolePerWorker: boolean;
}

/** The full, JSON-serializable organization state at one version. */
export interface OrgState {
  departments: Record<string, Department>;
  roles: Record<string, Role>;
  workers: Record<string, OrgWorker>;
  occupants: Record<string, Occupant>;
  taskForces: Record<string, TaskForce>;
  taskOwnerships: Record<string, TaskOwnership>;
  handovers: Record<string, Handover>;
  policy: OrgPolicy;
  /** Internal monotonic counter used only for auto ids (e.g. handovers). */
  nextSeq: number;
}

export interface OrgVersionMeta {
  actor: string;
  at: string;
  reason: string;
  changeKind: string;
}

export interface OrgVersion {
  version: number;
  meta: OrgVersionMeta;
  state: OrgState;
}

/** Lightweight history entry — metadata only, no full state payload. */
export interface OrgVersionSummary {
  version: number;
  meta: OrgVersionMeta;
}

// ---- errors ----

export type OrgErrorCode =
  | 'invalid_input'
  | 'duplicate_id'
  | 'not_found'
  | 'cycle_detected'
  | 'unknown_capability_ref'
  | 'capability_not_granted'
  | 'worker_inactive'
  | 'occupant_type_not_eligible'
  | 'exclusivity_violation'
  | 'multi_role_not_allowed'
  | 'max_occupants_exceeded'
  | 'not_occupant'
  | 'active_tasks_require_handover'
  | 'handover_invalid_state'
  | 'handover_target_not_occupant'
  | 'task_force_already_dissolved'
  | 'invalid_version';

export interface OrgError {
  code: OrgErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type OrgResult<T> =
  | { ok: true; version: number; data: T }
  | { ok: false; error: OrgError };

// ---- read models ----

export interface RoleSummary {
  role: Role;
  occupants: Occupant[];
  vacancies: number;
}

export interface OrgChartNode {
  department: Department;
  children: OrgChartNode[];
  roles: RoleSummary[];
}

export interface WorkerRoleSummary {
  workerId: string;
  roleIds: string[];
}

export interface VacancyReport {
  roleId: string;
  roleName: string;
  teamSizeTarget: number;
  currentOccupants: number;
  vacant: number;
}

// ---- operation inputs (plain, serializable — additive-friendly for a UI editor) ----

export interface DefineDepartmentInput {
  id: string;
  name: string;
  parentDepartmentId?: string | null;
}

export interface DefineRoleInput {
  id: string;
  name: string;
  departmentId: string;
  isManagerRole?: boolean;
  reportsToRoleId?: string | null;
  teamSizeTarget: number;
  maxOccupants?: number;
  exclusivity?: RoleExclusivity;
  eligibleOccupantTypes: OccupantType[];
  requiredCapabilities?: string[];
}

export interface RegisterWorkerInput {
  id: string;
  displayName: string;
  occupantType: OccupantType;
  provider?: string;
  active: boolean;
  allowedCapabilities: string[];
}

export interface CreateTaskForceInput {
  id: string;
  purpose: string;
  memberWorkerIds: string[];
  expiresAt?: string | null;
}

export interface HandoverInstruction {
  toWorkerId: string | null;
  reason: string;
}

export interface UnassignRoleOptions {
  handover?: HandoverInstruction;
}

/** Eligibility decision, mirroring operator/policy.ts's evaluatePolicy shape. */
export type EligibilityDecision =
  | { eligible: true }
  | { eligible: false; reason: OrgErrorCode; details?: Record<string, unknown> };

export interface OrgSnapshot {
  version: number;
  meta: OrgVersionMeta;
  departments: Department[];
  roles: Role[];
  workers: OrgWorker[];
  occupants: Occupant[];
  taskForces: TaskForce[];
  taskOwnerships: TaskOwnership[];
  handovers: Handover[];
  policy: OrgPolicy;
  orgChart: OrgChartNode[];
  vacancies: VacancyReport[];
}
