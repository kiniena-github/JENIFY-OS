/**
 * AI Member registry (issue #119, order 2) — which AI workers exist, which
 * provider/model each one actually is, and what each is trusted to do.
 *
 * Security properties:
 *
 * - **Advertised vs. granted.** Every member carries both
 *   `advertisedCapabilities` (what its provider metadata claims — untrusted
 *   input, see `providers/contracts.ts`) and `grantedCapabilities` (what a
 *   registrar explicitly granted). Every permission check and all routing
 *   (`registry/routing.ts`) reads `grantedCapabilities` ONLY. Granting a
 *   capability the member does not advertise is allowed (flagged as a
 *   warning — maybe intentional, e.g. a manually-verified extra skill), but
 *   granting an unregistered or disabled capability throws outright.
 * - **Identity binding.** `(providerId, modelId, modelVersion)` is fixed at
 *   registration and immutable forever after — `identityKey` is computed
 *   from them once and stored. `update()` rejects any patch that touches an
 *   identity field (or `id`, `status`, or other lifecycle-managed fields);
 *   only dedicated lifecycle methods may change those. `verifyIdentity`
 *   checks a claimed identity against the registered one before dispatch —
 *   a mismatch is treated as a possible impersonation attempt and is
 *   recorded in history, never silently ignored.
 * - **No hard delete, ever.** Disabling or removing a member only changes
 *   `status`; the row, its full history, and its assignment records are
 *   preserved forever. There is deliberately no delete method for members,
 *   history, or assignments.
 * - **Deny by default for dispatch.** `assign()` refuses any member that is
 *   not `enabled` and `status: 'active'`, or whose health is `unavailable`.
 *   Disabling a member immediately excludes it from `assign()` and from
 *   routing (`registry/routing.ts`), while flipping its in-flight work to
 *   `handover_pending` so nothing silently goes unattended.
 * - **Role eligibility is capability-gated.** `setRoleEligibility` will not
 *   assign a role whose `requiredCapabilities` are not a subset of the
 *   member's own `grantedCapabilities` — it throws and names exactly which
 *   capabilities are missing.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import type { ProviderDirectory } from '../providers/directory.js';
import { MemberCapabilityRegistry } from './capabilities.js';
import { ensureRegistrySchema } from './db.js';

export const WORKER_TYPES = ['interactive', 'execution', 'review', 'automation'] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export const LOCALITIES = ['local', 'cloud'] as const;
export type Locality = (typeof LOCALITIES)[number];

export const PRIVACY_CLASSES = ['open', 'internal', 'confidential', 'restricted'] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export const COST_CLASSES = ['free', 'low', 'medium', 'high', 'premium'] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const MEMBER_STATUSES = ['active', 'disabled', 'removed', 'replaced'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const MEMBER_HEALTHS = ['unknown', 'healthy', 'degraded', 'unavailable'] as const;
export type MemberHealth = (typeof MEMBER_HEALTHS)[number];

export const ASSIGNMENT_STATUSES = ['active', 'completed', 'handover_pending'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export interface MemberBenchmark {
  /** What the score is evidence for — matched against a routing request's `requiredCapability`. */
  ref: string;
  /** 0-100. */
  score: number;
  recordedAt: string;
}

export interface AiMember {
  id: string;
  displayName: string;
  providerId: string;
  modelId: string;
  modelVersion: string;
  /** `${providerId}:${modelId}:${modelVersion}`, fixed forever at registration. */
  identityKey: string;
  workerType: WorkerType;
  enabled: boolean;
  locality: Locality;
  privacyClass: PrivacyClass;
  costClass: CostClass;
  contextWindowTokens: number | null;
  toolMetadata: Record<string, unknown>;
  roleEligibility: string[];
  /** Untrusted — what the provider/member claims it can do. Never used for permission checks. */
  advertisedCapabilities: string[];
  /** Trusted — what a registrar explicitly granted. The only thing permission checks/routing use. */
  grantedCapabilities: string[];
  status: MemberStatus;
  health: MemberHealth;
  healthCheckedAt: string | null;
  benchmarks: MemberBenchmark[];
  /** Set when status is 'replaced' — points at the member that replaced this one. */
  replacedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterMemberInput {
  id: string;
  displayName: string;
  providerId: string;
  modelId: string;
  modelVersion: string;
  workerType: WorkerType;
  enabled?: boolean;
  locality: Locality;
  privacyClass: PrivacyClass;
  costClass: CostClass;
  contextWindowTokens?: number | null;
  toolMetadata?: Record<string, unknown>;
  roleEligibility?: string[];
  advertisedCapabilities?: string[];
  grantedCapabilities?: string[];
  health?: MemberHealth;
}

/** Mutable-field patch for `update()`. Identity/lifecycle fields are deliberately absent from this type. */
export interface UpdateMemberInput {
  displayName?: string;
  enabled?: boolean;
  workerType?: WorkerType;
  locality?: Locality;
  privacyClass?: PrivacyClass;
  costClass?: CostClass;
  contextWindowTokens?: number | null;
  toolMetadata?: Record<string, unknown>;
  advertisedCapabilities?: string[];
  grantedCapabilities?: string[];
  health?: MemberHealth;
  healthCheckedAt?: string | null;
}

export interface MemberRole {
  roleId: string;
  requiredCapabilities: string[];
  description: string;
}

export interface MemberAssignment {
  id: string;
  memberId: string;
  taskRef: string;
  status: AssignmentStatus;
  assignedAt: string;
  endedAt: string | null;
}

export interface MemberHistoryEvent {
  id: string;
  memberId: string;
  at: string;
  event: string;
  detail: Record<string, unknown>;
  actor: string;
}

export interface RegisterResult {
  member: AiMember;
  /** Non-fatal notices, e.g. a granted capability the member does not advertise. */
  warnings: string[];
}

/** Fields `update()` refuses to touch — identity is permanent, the rest are lifecycle-managed elsewhere. */
const UPDATE_BLOCKED_FIELDS = [
  'id',
  'providerId',
  'modelId',
  'modelVersion',
  'identityKey',
  'status',
  'replacedById',
  'createdAt',
  'updatedAt',
  'roleEligibility',
  'benchmarks',
] as const;

function memberToRow(m: AiMember): Record<string, unknown> {
  return {
    id: m.id,
    displayName: m.displayName,
    providerId: m.providerId,
    modelId: m.modelId,
    modelVersion: m.modelVersion,
    identityKey: m.identityKey,
    workerType: m.workerType,
    enabled: m.enabled ? 1 : 0,
    locality: m.locality,
    privacyClass: m.privacyClass,
    costClass: m.costClass,
    contextWindowTokens: m.contextWindowTokens,
    toolMetadata: JSON.stringify(m.toolMetadata),
    roleEligibility: JSON.stringify(m.roleEligibility),
    advertisedCapabilities: JSON.stringify(m.advertisedCapabilities),
    grantedCapabilities: JSON.stringify(m.grantedCapabilities),
    status: m.status,
    health: m.health,
    healthCheckedAt: m.healthCheckedAt,
    benchmarks: JSON.stringify(m.benchmarks),
    replacedById: m.replacedById,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function rowToMember(row: Record<string, unknown>): AiMember {
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    providerId: row.provider_id as string,
    modelId: row.model_id as string,
    modelVersion: row.model_version as string,
    identityKey: row.identity_key as string,
    workerType: row.worker_type as WorkerType,
    enabled: !!row.enabled,
    locality: row.locality as Locality,
    privacyClass: row.privacy_class as PrivacyClass,
    costClass: row.cost_class as CostClass,
    contextWindowTokens: (row.context_window_tokens as number | null) ?? null,
    toolMetadata: JSON.parse(row.tool_metadata as string),
    roleEligibility: JSON.parse(row.role_eligibility as string),
    advertisedCapabilities: JSON.parse(row.advertised_capabilities as string),
    grantedCapabilities: JSON.parse(row.granted_capabilities as string),
    status: row.status as MemberStatus,
    health: row.health as MemberHealth,
    healthCheckedAt: (row.health_checked_at as string | null) ?? null,
    benchmarks: JSON.parse(row.benchmarks as string),
    replacedById: (row.replaced_by_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Standalone insert, independent of any class instance — reused by `registry/serialization.ts` on import. */
export function insertMemberRow(db: HqDatabase, member: AiMember): void {
  const r = memberToRow(member);
  db.prepare(
    `INSERT INTO hq_ai_members (
      id, display_name, provider_id, model_id, model_version, identity_key, worker_type, enabled,
      locality, privacy_class, cost_class, context_window_tokens, tool_metadata, role_eligibility,
      advertised_capabilities, granted_capabilities, status, health, health_checked_at, benchmarks,
      replaced_by_id, created_at, updated_at
    ) VALUES (
      @id, @displayName, @providerId, @modelId, @modelVersion, @identityKey, @workerType, @enabled,
      @locality, @privacyClass, @costClass, @contextWindowTokens, @toolMetadata, @roleEligibility,
      @advertisedCapabilities, @grantedCapabilities, @status, @health, @healthCheckedAt, @benchmarks,
      @replacedById, @createdAt, @updatedAt
    )`,
  ).run(r);
}

function updateMemberRow(db: HqDatabase, member: AiMember): void {
  const r = memberToRow(member);
  db.prepare(
    `UPDATE hq_ai_members SET
      display_name = @displayName,
      worker_type = @workerType,
      enabled = @enabled,
      locality = @locality,
      privacy_class = @privacyClass,
      cost_class = @costClass,
      context_window_tokens = @contextWindowTokens,
      tool_metadata = @toolMetadata,
      role_eligibility = @roleEligibility,
      advertised_capabilities = @advertisedCapabilities,
      granted_capabilities = @grantedCapabilities,
      status = @status,
      health = @health,
      health_checked_at = @healthCheckedAt,
      benchmarks = @benchmarks,
      replaced_by_id = @replacedById,
      updated_at = @updatedAt
    WHERE id = @id`,
  ).run(r);
}

/** Standalone reader, independent of any class instance — reused by `registry/serialization.ts`. */
export function listAllMembers(db: HqDatabase): AiMember[] {
  const rows = db.prepare(`SELECT * FROM hq_ai_members ORDER BY created_at`).all() as Record<string, unknown>[];
  return rows.map(rowToMember);
}

function rowToRole(row: Record<string, unknown>): MemberRole {
  return {
    roleId: row.role_id as string,
    requiredCapabilities: JSON.parse(row.required_capabilities as string),
    description: row.description as string,
  };
}

/** Standalone insert/upsert, reused by `registry/serialization.ts` on import. */
export function insertRoleRow(db: HqDatabase, role: MemberRole): void {
  db.prepare(
    `INSERT INTO hq_member_roles (role_id, required_capabilities, description)
     VALUES (?, ?, ?)
     ON CONFLICT(role_id) DO UPDATE SET
       required_capabilities = excluded.required_capabilities,
       description = excluded.description`,
  ).run(role.roleId, JSON.stringify(role.requiredCapabilities), role.description);
}

/** Standalone reader, independent of any class instance — reused by `registry/serialization.ts`. */
export function listAllRoles(db: HqDatabase): MemberRole[] {
  const rows = db.prepare(`SELECT * FROM hq_member_roles ORDER BY role_id`).all() as Record<string, unknown>[];
  return rows.map(rowToRole);
}

function rowToAssignment(row: Record<string, unknown>): MemberAssignment {
  return {
    id: row.id as string,
    memberId: row.member_id as string,
    taskRef: row.task_ref as string,
    status: row.status as AssignmentStatus,
    assignedAt: row.assigned_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
  };
}

export class AiMemberRegistry {
  constructor(
    private db: HqDatabase,
    public readonly providers: ProviderDirectory,
    public readonly capabilities: MemberCapabilityRegistry,
  ) {
    ensureRegistrySchema(db);
  }

  // ---- capability grant validation --------------------------------------

  /**
   * Throws if any `granted` id is unregistered or disabled (deny by
   * default). Returns a warning for each granted capability the member does
   * not itself advertise — allowed, but worth a registrar's attention.
   */
  private validateGrants(advertised: readonly string[], granted: readonly string[]): string[] {
    const warnings: string[] = [];
    for (const capId of granted) {
      const check = this.capabilities.isGrantable(capId);
      if (!check.ok) {
        throw new Error(`Cannot grant capability '${capId}' to member: ${check.reason}`);
      }
      if (!advertised.includes(capId)) {
        warnings.push(
          `Capability '${capId}' was granted but is not advertised by this member's provider metadata.`,
        );
      }
    }
    return warnings;
  }

  private validateRoleEligibility(roleIds: readonly string[], granted: readonly string[]): void {
    const missingByRole: Record<string, string[]> = {};
    for (const roleId of roleIds) {
      const role = this.getRole(roleId);
      if (!role) throw new Error(`Unknown role: ${roleId}`);
      const missing = role.requiredCapabilities.filter((c) => !granted.includes(c));
      if (missing.length > 0) missingByRole[roleId] = missing;
    }
    if (Object.keys(missingByRole).length > 0) {
      throw new Error(
        `Member is not eligible for role(s), missing granted capabilities: ${JSON.stringify(missingByRole)}`,
      );
    }
  }

  private recordHistory(memberId: string, event: string, detail: Record<string, unknown>, actor: string): void {
    this.db
      .prepare(
        `INSERT INTO hq_ai_member_history (id, member_id, at, event, detail, actor) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(uuid(), memberId, nowIso(), event, JSON.stringify(detail), actor);
  }

  private mustGet(id: string): AiMember {
    const m = this.get(id);
    if (!m) throw new Error(`Unknown AI member: ${id}`);
    return m;
  }

  // ---- roles --------------------------------------------------------------

  defineRole(roleId: string, requiredCapabilities: string[], description: string): MemberRole {
    for (const capId of requiredCapabilities) {
      if (!this.capabilities.get(capId)) {
        throw new Error(`Role '${roleId}' requires unregistered capability: ${capId}`);
      }
    }
    const role: MemberRole = { roleId, requiredCapabilities, description };
    insertRoleRow(this.db, role);
    return role;
  }

  getRole(roleId: string): MemberRole | null {
    const row = this.db.prepare(`SELECT * FROM hq_member_roles WHERE role_id = ?`).get(roleId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRole(row) : null;
  }

  listRoles(): MemberRole[] {
    return listAllRoles(this.db);
  }

  // ---- members: lifecycle ---------------------------------------------------

  register(input: RegisterMemberInput, actor = 'system'): RegisterResult {
    if (this.get(input.id)) {
      throw new Error(`Duplicate AI member id: ${input.id}`);
    }
    if (!this.providers.has(input.providerId)) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    const advertised = input.advertisedCapabilities ?? [];
    const granted = input.grantedCapabilities ?? [];
    const warnings = this.validateGrants(advertised, granted);

    const roleEligibility = input.roleEligibility ?? [];
    if (roleEligibility.length > 0) {
      this.validateRoleEligibility(roleEligibility, granted);
    }

    const now = nowIso();
    const member: AiMember = {
      id: input.id,
      displayName: input.displayName,
      providerId: input.providerId,
      modelId: input.modelId,
      modelVersion: input.modelVersion,
      identityKey: `${input.providerId}:${input.modelId}:${input.modelVersion}`,
      workerType: input.workerType,
      enabled: input.enabled ?? true,
      locality: input.locality,
      privacyClass: input.privacyClass,
      costClass: input.costClass,
      contextWindowTokens: input.contextWindowTokens ?? null,
      toolMetadata: input.toolMetadata ?? {},
      roleEligibility,
      advertisedCapabilities: advertised,
      grantedCapabilities: granted,
      status: 'active',
      health: input.health ?? 'unknown',
      healthCheckedAt: null,
      benchmarks: [],
      replacedById: null,
      createdAt: now,
      updatedAt: now,
    };
    insertMemberRow(this.db, member);
    this.recordHistory(
      member.id,
      'registered',
      { providerId: member.providerId, modelId: member.modelId, modelVersion: member.modelVersion },
      actor,
    );
    return { member, warnings };
  }

  get(id: string): AiMember | null {
    const row = this.db.prepare(`SELECT * FROM hq_ai_members WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToMember(row) : null;
  }

  list(filter?: { status?: MemberStatus }): AiMember[] {
    const all = listAllMembers(this.db);
    return filter?.status ? all.filter((m) => m.status === filter.status) : all;
  }

  /**
   * Updates mutable fields only. Throws immediately if the patch touches any
   * identity or lifecycle-managed field (see `UPDATE_BLOCKED_FIELDS`) —
   * those can only change via `disable`/`remove`/`replace`/`setRoleEligibility`/
   * `addBenchmark`, never here. A relabel (`displayName`) can never alter identity.
   */
  update(id: string, patch: UpdateMemberInput & Record<string, unknown>, actor = 'system'): RegisterResult {
    for (const key of UPDATE_BLOCKED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const isIdentity = (['id', 'providerId', 'modelId', 'modelVersion', 'identityKey'] as string[]).includes(
          key,
        );
        throw new Error(
          `Cannot update field '${key}' via update(): ${
            isIdentity
              ? 'identity is immutable once a member is registered'
              : 'this field is managed by a dedicated lifecycle method'
          }`,
        );
      }
    }
    const member = this.mustGet(id);
    const next: AiMember = { ...member };
    let warnings: string[] = [];

    if (patch.displayName !== undefined) next.displayName = patch.displayName;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.workerType !== undefined) next.workerType = patch.workerType;
    if (patch.locality !== undefined) next.locality = patch.locality;
    if (patch.privacyClass !== undefined) next.privacyClass = patch.privacyClass;
    if (patch.costClass !== undefined) next.costClass = patch.costClass;
    if (patch.contextWindowTokens !== undefined) next.contextWindowTokens = patch.contextWindowTokens;
    if (patch.toolMetadata !== undefined) next.toolMetadata = patch.toolMetadata;
    if (patch.health !== undefined) next.health = patch.health;
    if (patch.healthCheckedAt !== undefined) next.healthCheckedAt = patch.healthCheckedAt;

    if (patch.advertisedCapabilities !== undefined || patch.grantedCapabilities !== undefined) {
      const advertised = patch.advertisedCapabilities ?? next.advertisedCapabilities;
      const granted = patch.grantedCapabilities ?? next.grantedCapabilities;
      warnings = this.validateGrants(advertised, granted);
      // A capability grant that no longer covers a currently-eligible role is
      // left in place rather than silently dropping the role; setRoleEligibility
      // must be called again explicitly if the registrar wants it re-checked.
      next.advertisedCapabilities = advertised;
      next.grantedCapabilities = granted;
    }

    next.updatedAt = nowIso();
    updateMemberRow(this.db, next);
    this.recordHistory(id, 'updated', { fields: Object.keys(patch) }, actor);
    return { member: next, warnings };
  }

  /**
   * Confirms (or rejects) a claimed identity against the identity this
   * member was actually registered with. A mismatch is a possible
   * impersonation attempt: it is recorded in history and reported not-ok —
   * callers must treat that as a hard stop before dispatch.
   */
  verifyIdentity(
    memberId: string,
    claimed: { providerId: string; modelId: string; modelVersion: string },
  ): { ok: boolean; reason?: string } {
    const member = this.get(memberId);
    if (!member) return { ok: false, reason: `Unknown AI member: ${memberId}` };
    const claimedKey = `${claimed.providerId}:${claimed.modelId}:${claimed.modelVersion}`;
    if (claimedKey !== member.identityKey) {
      this.recordHistory(
        memberId,
        'identity_verification_failed',
        { claimed: claimedKey, registered: member.identityKey },
        'system',
      );
      return {
        ok: false,
        reason: `Identity mismatch: claimed '${claimedKey}' does not match registered '${member.identityKey}' — possible impersonation`,
      };
    }
    return { ok: true };
  }

  /**
   * Disables an active member. All of its currently-active assignments flip
   * to `handover_pending` and are returned so the caller can route the
   * handover — nothing is silently dropped. The member row, its history, and
   * its assignments are all preserved (no delete).
   */
  disable(id: string, reason: string, actor: string): { member: AiMember; handoverRequired: MemberAssignment[] } {
    const member = this.mustGet(id);
    if (member.status !== 'active') {
      throw new Error(`Cannot disable member '${id}': status is '${member.status}', expected 'active'`);
    }
    const handoverRequired = this.flipActiveAssignments(id);
    const next: AiMember = { ...member, status: 'disabled', enabled: false, updatedAt: nowIso() };
    updateMemberRow(this.db, next);
    this.recordHistory(id, 'disabled', { reason, handoverCount: handoverRequired.length }, actor);
    return { member: next, handoverRequired };
  }

  /** Marks a member removed. Row, history, and assignments are all kept — hard delete does not exist. */
  remove(id: string, reason: string, actor: string): AiMember {
    const member = this.mustGet(id);
    if (member.status === 'removed') {
      throw new Error(`Member '${id}' is already removed`);
    }
    const next: AiMember = { ...member, status: 'removed', enabled: false, updatedAt: nowIso() };
    updateMemberRow(this.db, next);
    this.recordHistory(id, 'removed', { reason }, actor);
    return next;
  }

  /**
   * Registers a new member as the replacement for `oldId` (e.g. a model
   * upgrade), marks the old member `status: 'replaced'` with `replacedById`
   * set, flips its active assignments to `handover_pending`, and copies role
   * eligibility from the old member to the new one only for roles the new
   * member's granted capabilities still satisfy. History is recorded on
   * both members.
   */
  replace(
    oldId: string,
    newSpec: RegisterMemberInput,
    actor: string,
  ): { oldMember: AiMember; newMember: AiMember; warnings: string[]; handoverRequired: MemberAssignment[] } {
    const old = this.mustGet(oldId);
    const { member: registered, warnings } = this.register(newSpec, actor);

    const handoverRequired = this.flipActiveAssignments(oldId);

    let newMember = registered;
    const compatibleRoles = old.roleEligibility.filter((roleId) => {
      const role = this.getRole(roleId);
      return !!role && role.requiredCapabilities.every((c) => newMember.grantedCapabilities.includes(c));
    });
    if (compatibleRoles.length > 0) {
      newMember = this.setRoleEligibility(newMember.id, compatibleRoles, actor).member;
    }

    const oldNext: AiMember = {
      ...old,
      status: 'replaced',
      enabled: false,
      replacedById: newMember.id,
      updatedAt: nowIso(),
    };
    updateMemberRow(this.db, oldNext);
    this.recordHistory(oldId, 'replaced', { newMemberId: newMember.id, handoverCount: handoverRequired.length }, actor);
    this.recordHistory(newMember.id, 'replaced_predecessor', { oldMemberId: oldId }, actor);

    return { oldMember: oldNext, newMember, warnings, handoverRequired };
  }

  // ---- role eligibility ---------------------------------------------------

  /**
   * Sets which roles a member is eligible for. Throws (naming the missing
   * capabilities) if any role's `requiredCapabilities` is not a subset of
   * the member's own `grantedCapabilities` — never silently drops the
   * requirement or auto-grants what's missing.
   */
  setRoleEligibility(memberId: string, roleIds: string[], actor = 'system'): { member: AiMember } {
    const member = this.mustGet(memberId);
    this.validateRoleEligibility(roleIds, member.grantedCapabilities);
    const next: AiMember = { ...member, roleEligibility: roleIds, updatedAt: nowIso() };
    updateMemberRow(this.db, next);
    this.recordHistory(memberId, 'role_eligibility_set', { roleIds }, actor);
    return { member: next };
  }

  // ---- benchmarks / health --------------------------------------------------

  addBenchmark(memberId: string, benchmark: MemberBenchmark, actor = 'system'): AiMember {
    if (benchmark.score < 0 || benchmark.score > 100) {
      throw new Error(`Benchmark score must be within 0-100, got ${benchmark.score}`);
    }
    const member = this.mustGet(memberId);
    const next: AiMember = { ...member, benchmarks: [...member.benchmarks, benchmark], updatedAt: nowIso() };
    updateMemberRow(this.db, next);
    this.recordHistory(memberId, 'benchmark_recorded', { ...benchmark }, actor);
    return next;
  }

  setHealth(memberId: string, health: MemberHealth, actor = 'system'): AiMember {
    const member = this.mustGet(memberId);
    const at = nowIso();
    const next: AiMember = { ...member, health, healthCheckedAt: at, updatedAt: at };
    updateMemberRow(this.db, next);
    this.recordHistory(memberId, 'health_updated', { health }, actor);
    return next;
  }

  // ---- assignments ---------------------------------------------------------

  private flipActiveAssignments(memberId: string): MemberAssignment[] {
    const active = this.listAssignments(memberId).filter((a) => a.status === 'active');
    for (const a of active) {
      this.db.prepare(`UPDATE hq_ai_member_assignments SET status = 'handover_pending' WHERE id = ?`).run(a.id);
    }
    return active.map((a) => ({ ...a, status: 'handover_pending' as const }));
  }

  /** Current workload — computed from active assignment rows, never stored redundantly. */
  workloadOf(memberId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM hq_ai_member_assignments WHERE member_id = ? AND status = 'active'`)
      .get(memberId) as { n: number };
    return row.n;
  }

  /** Assigns a task to a member. Deny by default: refuses anything not active/enabled/healthy. */
  assign(memberId: string, taskRef: string, actor = 'system'): MemberAssignment {
    const member = this.mustGet(memberId);
    if (member.status !== 'active' || !member.enabled) {
      throw new Error(`Cannot assign member '${memberId}': not active (status='${member.status}', enabled=${member.enabled})`);
    }
    if (member.health === 'unavailable') {
      throw new Error(`Cannot assign member '${memberId}': health is 'unavailable'`);
    }
    const assignment: MemberAssignment = {
      id: uuid(),
      memberId,
      taskRef,
      status: 'active',
      assignedAt: nowIso(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO hq_ai_member_assignments (id, member_id, task_ref, status, assigned_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(assignment.id, assignment.memberId, assignment.taskRef, assignment.status, assignment.assignedAt, null);
    this.recordHistory(memberId, 'assigned', { taskRef, assignmentId: assignment.id }, actor);
    return assignment;
  }

  completeAssignment(assignmentId: string, actor = 'system'): MemberAssignment {
    const row = this.db.prepare(`SELECT * FROM hq_ai_member_assignments WHERE id = ?`).get(assignmentId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Unknown assignment: ${assignmentId}`);
    const assignment = rowToAssignment(row);
    if (assignment.status !== 'active') {
      throw new Error(`Assignment '${assignmentId}' is not active (status: '${assignment.status}')`);
    }
    const endedAt = nowIso();
    this.db
      .prepare(`UPDATE hq_ai_member_assignments SET status = 'completed', ended_at = ? WHERE id = ?`)
      .run(endedAt, assignmentId);
    this.recordHistory(assignment.memberId, 'assignment_completed', { taskRef: assignment.taskRef, assignmentId }, actor);
    return { ...assignment, status: 'completed', endedAt };
  }

  listAssignments(memberId: string): MemberAssignment[] {
    const rows = this.db
      .prepare(`SELECT * FROM hq_ai_member_assignments WHERE member_id = ? ORDER BY assigned_at`)
      .all(memberId) as Record<string, unknown>[];
    return rows.map(rowToAssignment);
  }

  // ---- history --------------------------------------------------------------

  history(memberId: string): MemberHistoryEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM hq_ai_member_history WHERE member_id = ? ORDER BY seq`)
      .all(memberId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      memberId: row.member_id as string,
      at: row.at as string,
      event: row.event as string,
      detail: JSON.parse(row.detail as string),
      actor: row.actor as string,
    }));
  }
}
