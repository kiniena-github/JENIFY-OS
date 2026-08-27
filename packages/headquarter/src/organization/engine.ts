/**
 * Organization + workforce runtime engine (issue #118).
 *
 * A pure, deterministic domain engine over JSON-serializable state. No
 * database, no network, no randomness (ids the engine must invent — only
 * handovers — come from a monotonic in-state counter, not uuid/Math.random,
 * so replaying the same call sequence always yields the same state).
 *
 * INVARIANT (enforced here, documented in ORGANIZATION_MODEL.md, and proven
 * in test/organization.security.test.ts): this module never grants Operator
 * side-effect rights. It only ever *reads* capability ids (to validate refs
 * and check subset-eligibility) and *copies* worker data handed to it at
 * `registerWorker` time. It never calls a mutating method on, or writes a
 * property onto, any object the caller passed in — capability registries and
 * WorkerDescriptors the caller owns are never touched.
 */

import { evaluateRoleEligibility } from './eligibility.js';
import { buildOrgChart, buildVacancyReport, rolesForWorker as rolesForWorkerInState } from './readmodel.js';
import type {
  CreateTaskForceInput,
  DefineDepartmentInput,
  DefineRoleInput,
  Department,
  Handover,
  OccupantType,
  Occupant,
  OrgError,
  OrgErrorCode,
  OrgPolicy,
  OrgResult,
  OrgSnapshot,
  OrgState,
  OrgVersion,
  OrgVersionSummary,
  RegisterWorkerInput,
  Role,
  TaskForce,
  TaskOwnership,
  UnassignRoleOptions,
  OrgWorker,
} from './types.js';

const OCCUPANT_TYPES: readonly OccupantType[] = ['human', 'ai', 'external'];

export interface CreateOrganizationEngineConfig {
  /** Known capability ids. Requirement/allow-list refs outside this set are rejected. */
  capabilityIds?: Iterable<string>;
  policy?: Partial<OrgPolicy>;
  /** Injectable clock for deterministic tests. Defaults to `new Date().toISOString()`. */
  clock?: () => string;
  /** Actor recorded on the synthetic initial version. Defaults to 'system'. */
  initialActor?: string;
}

function err(code: OrgErrorCode, message: string, details?: Record<string, unknown>): OrgError {
  return { code, message, details };
}

type Outcome<T> = { error: OrgError } | { value: T };
function fail<T = never>(code: OrgErrorCode, message: string, details?: Record<string, unknown>): Outcome<T> {
  return { error: err(code, message, details) };
}
function ok<T>(value: T): Outcome<T> {
  return { value };
}
function isFail<T>(o: Outcome<T>): o is { error: OrgError } {
  return 'error' in o;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

/** Walks the reportsTo chain from `startFrom`; true if `roleId` is reachable (a cycle). */
function reachesRole(roles: Record<string, Role>, roleId: string, startFrom: string | null): boolean {
  let current = startFrom;
  const seen = new Set<string>();
  while (current) {
    if (current === roleId) return true;
    if (seen.has(current)) return true; // pre-existing cycle guard
    seen.add(current);
    current = roles[current]?.reportsToRoleId ?? null;
  }
  return false;
}

function occupantId(roleId: string, workerId: string): string {
  return `${roleId}::${workerId}`;
}

export class OrganizationEngine {
  private readonly history: OrgVersion[] = [];
  private readonly capabilityIds: ReadonlySet<string>;
  private readonly clock: () => string;

  constructor(config: CreateOrganizationEngineConfig = {}) {
    this.capabilityIds = new Set(config.capabilityIds ?? []);
    this.clock = config.clock ?? (() => new Date().toISOString());
    const initialState: OrgState = {
      departments: {},
      roles: {},
      workers: {},
      occupants: {},
      taskForces: {},
      taskOwnerships: {},
      handovers: {},
      policy: { allowMultiRolePerWorker: false, ...config.policy },
      nextSeq: 1,
    };
    this.history.push({
      version: 0,
      meta: { actor: config.initialActor ?? 'system', at: this.clock(), reason: 'initial state', changeKind: 'init' },
      state: initialState,
    });
  }

  // ---- internals ----

  private currentState(): OrgState {
    return this.history[this.history.length - 1].state;
  }

  private validateActorReason(actor: string, reason: string): OrgError | null {
    if (!isNonEmptyString(actor)) return err('invalid_input', 'actor must be a non-empty string');
    if (!isNonEmptyString(reason)) return err('invalid_input', 'reason must be a non-empty string');
    return null;
  }

  /**
   * Runs one mutation. `fn` receives a private draft (a structuredClone of
   * current state — never the live history object, never a caller-owned
   * object) and returns an Outcome. On success a NEW version is appended;
   * history is never rewritten or shrunk, and on failure nothing is appended.
   */
  private commit<T>(
    changeKind: string,
    actor: string,
    reason: string,
    fn: (draft: OrgState) => Outcome<T>,
  ): OrgResult<T> {
    const actorReasonError = this.validateActorReason(actor, reason);
    if (actorReasonError) return { ok: false, error: actorReasonError };

    const draft = structuredClone(this.currentState());
    const outcome = fn(draft);
    if (isFail(outcome)) return { ok: false, error: outcome.error };

    const version = this.history.length;
    this.history.push({
      version,
      meta: { actor, at: this.clock(), reason, changeKind },
      state: draft,
    });
    return { ok: true, version, data: outcome.value };
  }

  private validateCapabilityRefs(ids: string[]): OrgError | null {
    const unknown = ids.filter((id) => !this.capabilityIds.has(id));
    if (unknown.length > 0) {
      return err('unknown_capability_ref', `Unknown capability id(s): ${unknown.join(', ')}`, { unknown });
    }
    return null;
  }

  // ---- department ----

  defineDepartment(input: DefineDepartmentInput, actor: string, reason: string): OrgResult<Department> {
    return this.commit('define_department', actor, reason, (draft) => {
      if (!isNonEmptyString(input.id)) return fail('invalid_input', 'department id must be a non-empty string');
      if (!isNonEmptyString(input.name)) return fail('invalid_input', 'department name must be a non-empty string');
      if (draft.departments[input.id]) {
        return fail('duplicate_id', `Department ${input.id} already exists`);
      }
      const parentDepartmentId = input.parentDepartmentId ?? null;
      if (parentDepartmentId !== null) {
        if (parentDepartmentId === input.id) {
          return fail('cycle_detected', `Department ${input.id} cannot be its own parent`);
        }
        if (!draft.departments[parentDepartmentId]) {
          return fail('not_found', `Parent department ${parentDepartmentId} does not exist`);
        }
      }
      const dept: Department = { id: input.id, name: input.name, parentDepartmentId };
      draft.departments[dept.id] = dept;
      return ok(dept);
    });
  }

  // ---- role ----

  defineRole(input: DefineRoleInput, actor: string, reason: string): OrgResult<Role> {
    return this.commit('define_role', actor, reason, (draft) => {
      if (!isNonEmptyString(input.id)) return fail('invalid_input', 'role id must be a non-empty string');
      if (!isNonEmptyString(input.name)) return fail('invalid_input', 'role name must be a non-empty string');
      if (draft.roles[input.id]) return fail('duplicate_id', `Role ${input.id} already exists`);
      if (!isNonEmptyString(input.departmentId) || !draft.departments[input.departmentId]) {
        return fail('not_found', `Department ${String(input.departmentId)} does not exist`);
      }
      if (!isNonNegativeInt(input.teamSizeTarget)) {
        return fail('invalid_input', 'teamSizeTarget must be a non-negative integer');
      }
      const maxOccupants = input.maxOccupants ?? 1;
      if (!Number.isInteger(maxOccupants) || maxOccupants < 1) {
        return fail('invalid_input', 'maxOccupants must be an integer >= 1');
      }
      if (!Array.isArray(input.eligibleOccupantTypes) || input.eligibleOccupantTypes.length === 0) {
        return fail('invalid_input', 'eligibleOccupantTypes must be a non-empty array');
      }
      for (const t of input.eligibleOccupantTypes) {
        if (!OCCUPANT_TYPES.includes(t)) {
          return fail('invalid_input', `Unknown occupant type: ${String(t)}`);
        }
      }
      const requiredCapabilities = [...(input.requiredCapabilities ?? [])];
      const capError = this.validateCapabilityRefs(requiredCapabilities);
      if (capError) return { error: capError };

      const reportsToRoleId = input.reportsToRoleId ?? null;
      if (reportsToRoleId !== null) {
        if (reportsToRoleId === input.id) {
          return fail('cycle_detected', `Role ${input.id} cannot report to itself`);
        }
        if (!draft.roles[reportsToRoleId]) {
          return fail('not_found', `Role ${reportsToRoleId} (reportsToRoleId) does not exist`);
        }
        if (reachesRole(draft.roles, input.id, reportsToRoleId)) {
          return fail('cycle_detected', `Reporting line for ${input.id} would create a cycle`);
        }
      }

      const role: Role = {
        id: input.id,
        name: input.name,
        departmentId: input.departmentId,
        isManagerRole: input.isManagerRole ?? false,
        reportsToRoleId,
        teamSizeTarget: input.teamSizeTarget,
        maxOccupants,
        exclusivity: input.exclusivity ?? 'shared',
        eligibleOccupantTypes: [...input.eligibleOccupantTypes],
        requiredCapabilities,
      };
      draft.roles[role.id] = role;
      return ok(role);
    });
  }

  changeReportingLine(roleId: string, newReportsToRoleId: string | null, actor: string, reason: string): OrgResult<Role> {
    return this.commit('change_reporting_line', actor, reason, (draft) => {
      const role = draft.roles[roleId];
      if (!role) return fail('not_found', `Role ${roleId} does not exist`);
      if (newReportsToRoleId !== null) {
        if (newReportsToRoleId === roleId) {
          return fail('cycle_detected', `Role ${roleId} cannot report to itself`);
        }
        if (!draft.roles[newReportsToRoleId]) {
          return fail('not_found', `Role ${newReportsToRoleId} does not exist`);
        }
        if (reachesRole(draft.roles, roleId, newReportsToRoleId)) {
          return fail('cycle_detected', `Reassigning ${roleId} to report to ${newReportsToRoleId} would create a cycle`);
        }
      }
      role.reportsToRoleId = newReportsToRoleId;
      return ok(role);
    });
  }

  /**
   * Team-size target changes are always accepted for any non-negative
   * integer, including a target below the current occupant count — that is
   * reported back as a `warning` on the successful result rather than
   * rejected, since shrinking a target while people are still on the role is
   * a normal "stop backfilling, let it attrit" move, not an invalid state.
   * (Documented choice — see ORGANIZATION_MODEL.md.)
   */
  setTeamSizeTarget(roleId: string, newTarget: number, actor: string, reason: string): OrgResult<{ role: Role; warning: string | null }> {
    return this.commit('set_team_size_target', actor, reason, (draft) => {
      const role = draft.roles[roleId];
      if (!role) return fail('not_found', `Role ${roleId} does not exist`);
      if (!isNonNegativeInt(newTarget)) {
        return fail('invalid_input', 'teamSizeTarget must be a non-negative integer');
      }
      const currentOccupants = Object.values(draft.occupants).filter((o) => o.roleId === roleId).length;
      role.teamSizeTarget = newTarget;
      const warning =
        newTarget < currentOccupants
          ? `New target ${newTarget} is below the current occupant count (${currentOccupants})`
          : null;
      return ok({ role, warning });
    });
  }

  // ---- workers ----

  registerWorker(input: RegisterWorkerInput, actor: string, reason: string): OrgResult<OrgWorker> {
    return this.commit('register_worker', actor, reason, (draft) => {
      if (!isNonEmptyString(input.id)) return fail('invalid_input', 'worker id must be a non-empty string');
      if (!isNonEmptyString(input.displayName)) {
        return fail('invalid_input', 'worker displayName must be a non-empty string');
      }
      if (draft.workers[input.id]) return fail('duplicate_id', `Worker ${input.id} already exists`);
      if (!OCCUPANT_TYPES.includes(input.occupantType)) {
        return fail('invalid_input', `Unknown occupant type: ${String(input.occupantType)}`);
      }
      if (typeof input.active !== 'boolean') {
        return fail('invalid_input', 'worker active must be a boolean');
      }
      const allowedCapabilities = [...(input.allowedCapabilities ?? [])];
      const capError = this.validateCapabilityRefs(allowedCapabilities);
      if (capError) return { error: capError };

      // Copy every field explicitly — never store a reference into the
      // caller's input object (org edits must never let a mutation on the
      // caller's own descriptor leak into, or out of, this engine's state).
      const worker: OrgWorker = {
        id: input.id,
        displayName: input.displayName,
        occupantType: input.occupantType,
        provider: input.provider,
        active: input.active,
        allowedCapabilities,
      };
      draft.workers[worker.id] = worker;
      return ok(worker);
    });
  }

  // ---- role assignment ----

  assignRole(
    roleId: string,
    workerId: string,
    actor: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): OrgResult<Occupant> {
    return this.commit('assign_role', actor, reason, (draft) => {
      const role = draft.roles[roleId];
      if (!role) return fail('not_found', `Role ${roleId} does not exist`);
      const worker = draft.workers[workerId];
      if (!worker) return fail('not_found', `Worker ${workerId} does not exist`);

      const id = occupantId(roleId, workerId);
      if (draft.occupants[id]) {
        return fail('duplicate_id', `Worker ${workerId} already occupies role ${roleId}`);
      }

      const eligibility = evaluateRoleEligibility(role, worker);
      if (!eligibility.eligible) {
        return fail(eligibility.reason, `Worker ${workerId} is not eligible for role ${roleId}`, eligibility.details);
      }

      const existingForRole = Object.values(draft.occupants).filter((o) => o.roleId === roleId);
      if (existingForRole.length >= role.maxOccupants) {
        return fail('max_occupants_exceeded', `Role ${roleId} already has ${role.maxOccupants} occupant(s)`);
      }

      const workerRoles = Object.values(draft.occupants).filter((o) => o.workerId === workerId);
      if (workerRoles.length > 0) {
        if (role.exclusivity === 'exclusive') {
          return fail('exclusivity_violation', `Role ${roleId} is exclusive and cannot be combined with other roles`);
        }
        const holdsExclusiveElsewhere = workerRoles.some((o) => draft.roles[o.roleId]?.exclusivity === 'exclusive');
        if (holdsExclusiveElsewhere) {
          return fail('exclusivity_violation', `Worker ${workerId} already holds an exclusive role`);
        }
        if (!draft.policy.allowMultiRolePerWorker) {
          return fail('multi_role_not_allowed', 'Org policy does not allow a worker to hold multiple roles');
        }
      }

      const occupant: Occupant = {
        id,
        roleId,
        workerId,
        assignedAt: this.clock(),
        assignedBy: actor,
        metadata: metadata ? structuredClone(metadata) : undefined,
      };
      draft.occupants[id] = occupant;
      return ok(occupant);
    });
  }

  unassignRole(
    roleId: string,
    workerId: string,
    actor: string,
    reason: string,
    opts: UnassignRoleOptions = {},
  ): OrgResult<{ occupant: Occupant; handoverIds: string[] }> {
    return this.commit('unassign_role', actor, reason, (draft) => {
      const id = occupantId(roleId, workerId);
      const occupant = draft.occupants[id];
      if (!occupant) return fail('not_occupant', `Worker ${workerId} does not occupy role ${roleId}`);

      const ownedTasks = Object.values(draft.taskOwnerships).filter(
        (t) => t.roleId === roleId && t.workerId === workerId && t.state === 'owned',
      );

      const handoverIds: string[] = [];
      if (ownedTasks.length > 0) {
        if (!opts.handover) {
          return fail('active_tasks_require_handover', `Worker ${workerId} owns active task(s) on role ${roleId}`, {
            taskIds: ownedTasks.map((t) => t.taskId),
          });
        }
        for (const task of ownedTasks) {
          const handoverOutcome = this.initiateHandoverInDraft(
            draft,
            task.taskId,
            actor,
            opts.handover.reason,
            opts.handover.toWorkerId,
          );
          if (isFail(handoverOutcome)) return handoverOutcome;
          handoverIds.push(handoverOutcome.value.id);
        }
      }

      delete draft.occupants[id];
      return ok({ occupant, handoverIds });
    });
  }

  // ---- task ownership + handover ----

  registerTaskOwnership(taskId: string, roleId: string, workerId: string, actor: string, reason: string): OrgResult<TaskOwnership> {
    return this.commit('register_task_ownership', actor, reason, (draft) => {
      if (!isNonEmptyString(taskId)) return fail('invalid_input', 'taskId must be a non-empty string');
      if (draft.taskOwnerships[taskId]) return fail('duplicate_id', `Task ${taskId} already has an ownership record`);
      const role = draft.roles[roleId];
      if (!role) return fail('not_found', `Role ${roleId} does not exist`);
      const worker = draft.workers[workerId];
      if (!worker) return fail('not_found', `Worker ${workerId} does not exist`);
      if (!draft.occupants[occupantId(roleId, workerId)]) {
        return fail('not_occupant', `Worker ${workerId} does not occupy role ${roleId}; cannot own a task through it`);
      }
      const ownership: TaskOwnership = {
        taskId,
        roleId,
        workerId,
        state: 'owned',
        registeredAt: this.clock(),
        registeredBy: actor,
        updatedAt: this.clock(),
      };
      draft.taskOwnerships[taskId] = ownership;
      return ok(ownership);
    });
  }

  initiateHandover(taskId: string, actor: string, reason: string, toWorkerId: string | null = null): OrgResult<Handover> {
    return this.commit('initiate_handover', actor, reason, (draft) =>
      this.initiateHandoverInDraft(draft, taskId, actor, reason, toWorkerId),
    );
  }

  private initiateHandoverInDraft(
    draft: OrgState,
    taskId: string,
    actor: string,
    reason: string,
    toWorkerId: string | null,
  ): Outcome<Handover> {
    const ownership = draft.taskOwnerships[taskId];
    if (!ownership) return fail('not_found', `Task ${taskId} has no ownership record`);
    if (ownership.state !== 'owned' || !ownership.workerId) {
      return fail('handover_invalid_state', `Task ${taskId} is not in an owned state`);
    }
    if (toWorkerId !== null && !draft.workers[toWorkerId]) {
      return fail('not_found', `Target worker ${toWorkerId} does not exist`);
    }
    const id = `handover-${draft.nextSeq++}`;
    const handover: Handover = {
      id,
      taskId,
      fromWorkerId: ownership.workerId,
      toWorkerId,
      reason,
      status: 'pending',
      initiatedAt: this.clock(),
      initiatedBy: actor,
      completedAt: null,
      completedBy: null,
    };
    draft.handovers[id] = handover;
    ownership.state = 'handover_pending';
    ownership.updatedAt = this.clock();
    return ok(handover);
  }

  completeHandover(handoverId: string, actor: string, reason: string, resolvedToWorkerId?: string): OrgResult<TaskOwnership> {
    return this.commit('complete_handover', actor, reason, (draft) => {
      const handover = draft.handovers[handoverId];
      if (!handover) return fail('not_found', `Handover ${handoverId} does not exist`);
      if (handover.status !== 'pending') {
        return fail('handover_invalid_state', `Handover ${handoverId} is already ${handover.status}`);
      }
      const target = resolvedToWorkerId ?? handover.toWorkerId;
      if (!target) {
        return fail('handover_invalid_state', `Handover ${handoverId} has no target worker to resolve to`);
      }
      if (handover.toWorkerId !== null && resolvedToWorkerId && resolvedToWorkerId !== handover.toWorkerId) {
        return fail('invalid_input', `resolvedToWorkerId ${resolvedToWorkerId} does not match handover target ${handover.toWorkerId}`);
      }
      const worker = draft.workers[target];
      if (!worker) return fail('not_found', `Target worker ${target} does not exist`);
      if (!worker.active) return fail('worker_inactive', `Target worker ${target} is not active`);

      const ownership = draft.taskOwnerships[handover.taskId];
      if (!ownership) return fail('not_found', `Task ${handover.taskId} has no ownership record`);
      if (ownership.state !== 'handover_pending') {
        return fail('handover_invalid_state', `Task ${handover.taskId} is not pending handover`);
      }

      ownership.workerId = target;
      ownership.state = 'owned';
      ownership.updatedAt = this.clock();
      handover.status = 'completed';
      handover.toWorkerId = target;
      handover.completedAt = this.clock();
      handover.completedBy = actor;
      return ok(ownership);
    });
  }

  // ---- task forces ----

  createTaskForce(input: CreateTaskForceInput, actor: string, reason: string): OrgResult<TaskForce> {
    return this.commit('create_task_force', actor, reason, (draft) => {
      if (!isNonEmptyString(input.id)) return fail('invalid_input', 'task force id must be a non-empty string');
      if (!isNonEmptyString(input.purpose)) return fail('invalid_input', 'task force purpose must be a non-empty string');
      if (draft.taskForces[input.id]) return fail('duplicate_id', `Task force ${input.id} already exists`);
      if (!Array.isArray(input.memberWorkerIds)) return fail('invalid_input', 'memberWorkerIds must be an array');
      const seen = new Set<string>();
      for (const wid of input.memberWorkerIds) {
        if (!draft.workers[wid]) return fail('not_found', `Worker ${wid} does not exist`);
        if (seen.has(wid)) return fail('invalid_input', `Duplicate member worker id: ${wid}`);
        seen.add(wid);
      }
      const taskForce: TaskForce = {
        id: input.id,
        purpose: input.purpose,
        memberWorkerIds: [...input.memberWorkerIds],
        createdAt: this.clock(),
        createdBy: actor,
        expiresAt: input.expiresAt ?? null,
        dissolved: false,
        dissolvedAt: null,
        dissolvedBy: null,
        dissolvedReason: null,
      };
      draft.taskForces[taskForce.id] = taskForce;
      return ok(taskForce);
    });
  }

  dissolveTaskForce(id: string, actor: string, reason: string): OrgResult<TaskForce> {
    return this.commit('dissolve_task_force', actor, reason, (draft) => {
      const tf = draft.taskForces[id];
      if (!tf) return fail('not_found', `Task force ${id} does not exist`);
      if (tf.dissolved) return fail('task_force_already_dissolved', `Task force ${id} is already dissolved`);
      tf.dissolved = true;
      tf.dissolvedAt = this.clock();
      tf.dissolvedBy = actor;
      tf.dissolvedReason = reason;
      return ok(tf);
    });
  }

  // ---- versioning ----

  rollbackToVersion(targetVersion: number, actor: string, reason: string): OrgResult<{ restoredFromVersion: number }> {
    const actorReasonError = this.validateActorReason(actor, reason);
    if (actorReasonError) return { ok: false, error: actorReasonError };
    if (!Number.isInteger(targetVersion) || !this.history[targetVersion]) {
      return { ok: false, error: err('invalid_version', `Version ${String(targetVersion)} does not exist`) };
    }
    const restoredState = structuredClone(this.history[targetVersion].state);
    const version = this.history.length;
    this.history.push({
      version,
      meta: { actor, at: this.clock(), reason, changeKind: 'rollback' },
      state: restoredState,
    });
    return { ok: true, version, data: { restoredFromVersion: targetVersion } };
  }

  getVersion(n: number): OrgVersion | null {
    const entry = this.history[n];
    if (!entry) return null;
    return { version: entry.version, meta: { ...entry.meta }, state: structuredClone(entry.state) };
  }

  getHistory(): OrgVersionSummary[] {
    return this.history.map((h) => ({ version: h.version, meta: { ...h.meta } }));
  }

  // ---- read models ----

  getCurrentOrg(): OrgSnapshot {
    const latest = this.history[this.history.length - 1];
    const state = structuredClone(latest.state);
    return {
      version: latest.version,
      meta: { ...latest.meta },
      departments: Object.values(state.departments),
      roles: Object.values(state.roles),
      workers: Object.values(state.workers),
      occupants: Object.values(state.occupants),
      taskForces: Object.values(state.taskForces),
      taskOwnerships: Object.values(state.taskOwnerships),
      handovers: Object.values(state.handovers),
      policy: state.policy,
      orgChart: buildOrgChart(state),
      vacancies: buildVacancyReport(state),
    };
  }

  rolesForWorker(workerId: string): string[] {
    return rolesForWorkerInState(this.currentState(), workerId);
  }
}

export function createOrganizationEngine(config: CreateOrganizationEngineConfig = {}): OrganizationEngine {
  return new OrganizationEngine(config);
}
