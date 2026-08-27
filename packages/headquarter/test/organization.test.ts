import { beforeEach, describe, expect, it } from 'vitest';
import { createOrganizationEngine, type OrganizationEngine } from '../src/organization/index.js';

const CAPS = ['ops.write_reports', 'ops.review_code', 'ops.manage_org'];

function seedBasicOrg(engine: OrganizationEngine) {
  engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
  engine.defineDepartment({ id: 'eng-platform', name: 'Platform', parentDepartmentId: 'eng' }, 'founder', 'seed');
  engine.defineRole(
    {
      id: 'role-lead',
      name: 'Build Lead',
      departmentId: 'eng',
      isManagerRole: true,
      teamSizeTarget: 1,
      eligibleOccupantTypes: ['human', 'ai'],
      requiredCapabilities: ['ops.manage_org'],
    },
    'founder',
    'seed',
  );
  engine.defineRole(
    {
      id: 'role-implementer',
      name: 'Implementer',
      departmentId: 'eng-platform',
      reportsToRoleId: 'role-lead',
      teamSizeTarget: 2,
      maxOccupants: 3,
      eligibleOccupantTypes: ['human', 'ai', 'external'],
      requiredCapabilities: ['ops.write_reports'],
    },
    'founder',
    'seed',
  );
}

function registerWorkers(engine: OrganizationEngine) {
  engine.registerWorker(
    { id: 'chatgpt', displayName: 'ChatGPT', occupantType: 'ai', provider: 'chatgpt', active: true, allowedCapabilities: CAPS },
    'founder',
    'seed',
  );
  engine.registerWorker(
    { id: 'claude', displayName: 'Claude', occupantType: 'ai', provider: 'claude', active: true, allowedCapabilities: CAPS },
    'founder',
    'seed',
  );
  engine.registerWorker(
    { id: 'alice', displayName: 'Alice', occupantType: 'human', active: true, allowedCapabilities: CAPS },
    'founder',
    'seed',
  );
}

describe('organization engine — departments, roles, workers', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
  });

  it('defines a department tree and a role within it', () => {
    seedBasicOrg(engine);
    const org = engine.getCurrentOrg();
    expect(org.departments.map((d) => d.id).sort()).toEqual(['eng', 'eng-platform']);
    expect(org.roles.map((r) => r.id).sort()).toEqual(['role-implementer', 'role-lead']);
    expect(org.orgChart).toHaveLength(1);
    expect(org.orgChart[0].department.id).toBe('eng');
    expect(org.orgChart[0].children[0].department.id).toBe('eng-platform');
  });

  it('rejects a role referencing an unknown department', () => {
    const res = engine.defineRole(
      {
        id: 'role-x',
        name: 'X',
        departmentId: 'does-not-exist',
        teamSizeTarget: 1,
        eligibleOccupantTypes: ['human'],
      },
      'founder',
      'test',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });

  it('assigns and unassigns a worker to a role', () => {
    seedBasicOrg(engine);
    registerWorkers(engine);
    const assign = engine.assignRole('role-implementer', 'alice', 'founder', 'staffing');
    expect(assign.ok).toBe(true);
    if (assign.ok) expect(assign.data.workerId).toBe('alice');

    const org = engine.getCurrentOrg();
    expect(org.orgChart[0].children[0].roles[0].occupants.map((o) => o.workerId)).toEqual(['alice']);
    expect(org.vacancies.find((v) => v.roleId === 'role-implementer')?.vacant).toBe(1);

    const unassign = engine.unassignRole('role-implementer', 'alice', 'founder', 'reshuffle');
    expect(unassign.ok).toBe(true);
    expect(engine.getCurrentOrg().occupants).toHaveLength(0);
  });

  it('read model reports roles held per worker', () => {
    seedBasicOrg(engine);
    registerWorkers(engine);
    engine.assignRole('role-implementer', 'alice', 'founder', 'staffing');
    expect(engine.rolesForWorker('alice')).toEqual(['role-implementer']);
    expect(engine.rolesForWorker('claude')).toEqual([]);
  });
});

describe('organization engine — provider-agnostic reassignment', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    seedBasicOrg(engine);
    registerWorkers(engine);
    engine.registerWorker(
      {
        id: 'some-future-provider-1',
        displayName: 'Future Model',
        occupantType: 'ai',
        provider: 'some-future-provider',
        active: true,
        allowedCapabilities: CAPS,
      },
      'founder',
      'seed',
    );
  });

  it('reassigns the same role across chatgpt -> claude -> human -> a never-before-seen provider string, with no special-casing', () => {
    const a = engine.assignRole('role-lead', 'chatgpt', 'founder', 'initial staffing');
    expect(a.ok).toBe(true);

    const swap1 = engine.unassignRole('role-lead', 'chatgpt', 'founder', 'swap to claude');
    expect(swap1.ok).toBe(true);
    const b = engine.assignRole('role-lead', 'claude', 'founder', 'swap to claude');
    expect(b.ok).toBe(true);

    const swap2 = engine.unassignRole('role-lead', 'claude', 'founder', 'swap to human');
    expect(swap2.ok).toBe(true);
    const c = engine.assignRole('role-lead', 'alice', 'founder', 'swap to human');
    expect(c.ok).toBe(true);

    const swap3 = engine.unassignRole('role-lead', 'alice', 'founder', 'swap to future provider');
    expect(swap3.ok).toBe(true);
    const d = engine.assignRole('role-lead', 'some-future-provider-1', 'founder', 'swap to future provider');
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.data.workerId).toBe('some-future-provider-1');

    expect(engine.rolesForWorker('some-future-provider-1')).toEqual(['role-lead']);
  });
});

describe('organization engine — versioning and history', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
  });

  it('records who/when/why on every version, including the synthetic initial version', () => {
    const r1 = engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'kick off org');
    expect(r1.ok).toBe(true);
    const history = engine.getHistory();
    expect(history).toHaveLength(2); // initial + this mutation
    expect(history[0].meta.changeKind).toBe('init');
    expect(history[1]).toEqual({
      version: 1,
      meta: { actor: 'founder', at: expect.any(String), reason: 'kick off org', changeKind: 'define_department' },
    });
  });

  it('never appends a version on a failed mutation', () => {
    engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
    const before = engine.getHistory().length;
    const dup = engine.defineDepartment({ id: 'eng', name: 'Engineering again' }, 'founder', 'oops');
    expect(dup.ok).toBe(false);
    expect(engine.getHistory().length).toBe(before);
  });

  it('rollback restores old state as a brand-new version, never rewriting history', () => {
    engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
    engine.defineDepartment({ id: 'sales', name: 'Sales' }, 'founder', 'seed 2');
    expect(engine.getCurrentOrg().departments).toHaveLength(2);

    const historyBeforeRollback = engine.getHistory().length;
    const rollback = engine.rollbackToVersion(1, 'founder', 'sales dept was premature');
    expect(rollback.ok).toBe(true);
    if (rollback.ok) {
      expect(rollback.version).toBe(historyBeforeRollback); // a NEW version, appended at the end
      expect(rollback.data.restoredFromVersion).toBe(1);
    }

    // History never shrinks — the version we rolled back "past" is still there.
    expect(engine.getHistory().length).toBe(historyBeforeRollback + 1);
    expect(engine.getVersion(2)?.state.departments.sales).toBeDefined();

    // Current org reflects the restored (version-1) state.
    expect(engine.getCurrentOrg().departments.map((d) => d.id)).toEqual(['eng']);

    // Getting any historical version still works.
    expect(engine.getVersion(0)?.state.departments).toEqual({});
    expect(engine.getVersion(1)?.state.departments.eng).toBeDefined();
  });

  it('rejects rollback to a version that does not exist', () => {
    const res = engine.rollbackToVersion(999, 'founder', 'nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid_version');
  });
});

describe('organization engine — task forces', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    registerWorkers(engine);
  });

  it('creates and dissolves a task force, preserving history', () => {
    const created = engine.createTaskForce(
      { id: 'tf-launch', purpose: 'Launch readiness', memberWorkerIds: ['alice', 'claude'] },
      'founder',
      'stand up launch squad',
    );
    expect(created.ok).toBe(true);

    const dissolved = engine.dissolveTaskForce('tf-launch', 'founder', 'launch shipped');
    expect(dissolved.ok).toBe(true);
    if (dissolved.ok) {
      expect(dissolved.data.dissolved).toBe(true);
      expect(dissolved.data.memberWorkerIds).toEqual(['alice', 'claude']); // membership preserved, not wiped
    }

    // Still readable in the current snapshot (dissolution != deletion).
    const tf = engine.getCurrentOrg().taskForces.find((t) => t.id === 'tf-launch');
    expect(tf?.dissolved).toBe(true);
    expect(tf?.dissolvedReason).toBe('launch shipped');
  });

  it('rejects dissolving an already-dissolved task force (double-dissolve)', () => {
    engine.createTaskForce({ id: 'tf-1', purpose: 'p', memberWorkerIds: [] }, 'founder', 'seed');
    engine.dissolveTaskForce('tf-1', 'founder', 'done');
    const again = engine.dissolveTaskForce('tf-1', 'founder', 'done again');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('task_force_already_dissolved');
  });

  it('rejects an unknown member worker id', () => {
    const res = engine.createTaskForce({ id: 'tf-2', purpose: 'p', memberWorkerIds: ['ghost'] }, 'founder', 'seed');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });
});
