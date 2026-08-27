import { beforeEach, describe, expect, it } from 'vitest';
import { createOrganizationEngine, type OrganizationEngine } from '../src/organization/index.js';

const CAPS = ['ops.write_reports', 'ops.review_code', 'ops.manage_org', 'ops.deploy'];

function seedDeptAndRoles(engine: OrganizationEngine) {
  engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
  engine.defineRole(
    {
      id: 'role-manager',
      name: 'Manager',
      departmentId: 'eng',
      isManagerRole: true,
      teamSizeTarget: 1,
      eligibleOccupantTypes: ['human', 'ai'],
      requiredCapabilities: [],
    },
    'founder',
    'seed',
  );
}

function seedWorkers(engine: OrganizationEngine) {
  engine.registerWorker(
    { id: 'alice', displayName: 'Alice', occupantType: 'human', active: true, allowedCapabilities: CAPS },
    'founder',
    'seed',
  );
  engine.registerWorker(
    { id: 'bob', displayName: 'Bob', occupantType: 'human', active: true, allowedCapabilities: CAPS },
    'founder',
    'seed',
  );
}

describe('organization engine — manager swap during active tasks (handover required)', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    seedDeptAndRoles(engine);
    seedWorkers(engine);
    engine.assignRole('role-manager', 'alice', 'founder', 'staff manager role');
    engine.registerTaskOwnership('task-1', 'role-manager', 'alice', 'founder', 'assign work');
  });

  it('refuses to swap the manager out while they own an active task, with no silent orphaning', () => {
    const res = engine.unassignRole('role-manager', 'alice', 'founder', 'swap manager');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('active_tasks_require_handover');
      expect(res.error.details?.taskIds).toEqual(['task-1']);
    }
    // The occupant is still there — nothing was silently removed.
    expect(engine.getCurrentOrg().occupants.map((o) => o.workerId)).toEqual(['alice']);
    expect(engine.getCurrentOrg().taskOwnerships[0].state).toBe('owned');
  });

  it('allows the swap when an explicit handover instruction is given, and the task lands in handover_pending', () => {
    const res = engine.unassignRole('role-manager', 'alice', 'founder', 'swap manager', {
      handover: { toWorkerId: 'bob', reason: 'alice is off the project' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.handoverIds).toHaveLength(1);

    const org = engine.getCurrentOrg();
    expect(org.occupants).toHaveLength(0); // alice vacated the role
    const ownership = org.taskOwnerships.find((t) => t.taskId === 'task-1')!;
    expect(ownership.state).toBe('handover_pending');
    const handover = org.handovers.find((h) => h.id === res.data.handoverIds[0])!;
    expect(handover.fromWorkerId).toBe('alice');
    expect(handover.toWorkerId).toBe('bob');
    expect(handover.status).toBe('pending');

    // Not owned again until explicitly completed.
    const complete = engine.completeHandover(handover.id, 'founder', 'bob picked it up');
    expect(complete.ok).toBe(true);
    const afterComplete = engine.getCurrentOrg().taskOwnerships.find((t) => t.taskId === 'task-1')!;
    expect(afterComplete.state).toBe('owned');
    expect(afterComplete.workerId).toBe('bob');
  });

  it('supports handing over to no target yet (null), resolved later at completeHandover time', () => {
    const res = engine.unassignRole('role-manager', 'alice', 'founder', 'swap manager', {
      handover: { toWorkerId: null, reason: 'need to find a replacement' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const handoverId = res.data.handoverIds[0];
    expect(engine.getCurrentOrg().handovers.find((h) => h.id === handoverId)?.toWorkerId).toBeNull();

    // Cannot complete without ever specifying a target.
    const failed = engine.completeHandover(handoverId, 'founder', 'still looking');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('handover_invalid_state');

    const completed = engine.completeHandover(handoverId, 'founder', 'found one', 'bob');
    expect(completed.ok).toBe(true);
    expect(engine.getCurrentOrg().taskOwnerships.find((t) => t.taskId === 'task-1')?.workerId).toBe('bob');
  });
});

describe('organization engine — removing an occupied role', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    seedDeptAndRoles(engine);
    seedWorkers(engine);
    engine.assignRole('role-manager', 'alice', 'founder', 'staff');
  });

  it('is blocked without handover when the occupant owns active tasks', () => {
    engine.registerTaskOwnership('task-9', 'role-manager', 'alice', 'founder', 'assign');
    const res = engine.unassignRole('role-manager', 'alice', 'founder', 'vacate role');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('active_tasks_require_handover');
  });

  it('works cleanly (no handover needed) when the occupant owns no active tasks', () => {
    const res = engine.unassignRole('role-manager', 'alice', 'founder', 'vacate role');
    expect(res.ok).toBe(true);
    expect(engine.getCurrentOrg().occupants).toHaveLength(0);
  });

  it('history stays intact (append-only) across a blocked-then-successful unassign', () => {
    engine.registerTaskOwnership('task-9', 'role-manager', 'alice', 'founder', 'assign');
    const before = engine.getHistory().length;
    engine.unassignRole('role-manager', 'alice', 'founder', 'vacate role'); // fails, no version added
    expect(engine.getHistory().length).toBe(before);
    const ok = engine.unassignRole('role-manager', 'alice', 'founder', 'vacate role', {
      handover: { toWorkerId: 'bob', reason: 'reassign' },
    });
    expect(ok.ok).toBe(true);
    expect(engine.getHistory().length).toBe(before + 1);
  });
});

describe('organization engine — cyclic reporting lines', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
  });

  function defineRole(id: string, reportsToRoleId: string | null) {
    return engine.defineRole(
      { id, name: id, departmentId: 'eng', teamSizeTarget: 1, eligibleOccupantTypes: ['human'], reportsToRoleId },
      'founder',
      'seed',
    );
  }

  it('rejects a role that reports to itself', () => {
    const res = defineRole('r1', 'r1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cycle_detected');
  });

  it('rejects a 3+ node cycle introduced via changeReportingLine', () => {
    expect(defineRole('r1', null).ok).toBe(true);
    expect(defineRole('r2', 'r1').ok).toBe(true);
    expect(defineRole('r3', 'r2').ok).toBe(true);
    // r1 -> r2 -> r3 -> r1 would be a 3-node cycle.
    const res = engine.changeReportingLine('r1', 'r3', 'founder', 'reorg gone wrong');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cycle_detected');
    // Original reporting line is untouched.
    expect(engine.getCurrentOrg().roles.find((r) => r.id === 'r1')?.reportsToRoleId).toBeNull();
  });

  it('rejects self-cycle introduced via changeReportingLine', () => {
    expect(defineRole('r1', null).ok).toBe(true);
    const res = engine.changeReportingLine('r1', 'r1', 'founder', 'oops');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cycle_detected');
  });

  it('allows a legitimate deep reporting chain (not a cycle)', () => {
    expect(defineRole('r1', null).ok).toBe(true);
    expect(defineRole('r2', 'r1').ok).toBe(true);
    expect(defineRole('r3', 'r2').ok).toBe(true);
    expect(defineRole('r4', 'r3').ok).toBe(true);
  });
});

describe('organization engine — duplicate ids across entity kinds', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
  });

  it('rejects a duplicate department id', () => {
    expect(engine.defineDepartment({ id: 'd1', name: 'A' }, 'founder', 'seed').ok).toBe(true);
    const res = engine.defineDepartment({ id: 'd1', name: 'B' }, 'founder', 'seed');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicate_id');
  });

  it('rejects a duplicate role id', () => {
    engine.defineDepartment({ id: 'd1', name: 'A' }, 'founder', 'seed');
    const roleInput = { id: 'r1', name: 'R', departmentId: 'd1', teamSizeTarget: 1, eligibleOccupantTypes: ['human' as const] };
    expect(engine.defineRole(roleInput, 'founder', 'seed').ok).toBe(true);
    const res = engine.defineRole(roleInput, 'founder', 'seed');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicate_id');
  });

  it('rejects a duplicate worker id', () => {
    const w = { id: 'w1', displayName: 'W', occupantType: 'human' as const, active: true, allowedCapabilities: [] };
    expect(engine.registerWorker(w, 'founder', 'seed').ok).toBe(true);
    const res = engine.registerWorker(w, 'founder', 'seed');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicate_id');
  });

  it('rejects a duplicate task force id', () => {
    expect(engine.createTaskForce({ id: 'tf1', purpose: 'p', memberWorkerIds: [] }, 'founder', 'seed').ok).toBe(true);
    const res = engine.createTaskForce({ id: 'tf1', purpose: 'p2', memberWorkerIds: [] }, 'founder', 'seed');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicate_id');
  });
});

describe('organization engine — invalid/empty ids rejected', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
  });

  it('rejects an empty department id and a whitespace-only name', () => {
    expect(engine.defineDepartment({ id: '', name: 'A' }, 'founder', 'seed').ok).toBe(false);
    expect(engine.defineDepartment({ id: 'ok', name: '   ' }, 'founder', 'seed').ok).toBe(false);
  });

  it('rejects an empty actor or reason on any mutation', () => {
    const res1 = engine.defineDepartment({ id: 'd1', name: 'A' }, '', 'seed');
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.error.code).toBe('invalid_input');
    const res2 = engine.defineDepartment({ id: 'd1', name: 'A' }, 'founder', '   ');
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error.code).toBe('invalid_input');
  });
});

describe('organization engine — capability refs and deny-by-default', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
  });

  it('rejects a role with an unknown required-capability ref', () => {
    const res = engine.defineRole(
      {
        id: 'r1',
        name: 'R',
        departmentId: 'eng',
        teamSizeTarget: 1,
        eligibleOccupantTypes: ['human'],
        requiredCapabilities: ['ops.does_not_exist'],
      },
      'founder',
      'seed',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unknown_capability_ref');
  });

  it('rejects registering a worker with an unknown allowed-capability ref', () => {
    const res = engine.registerWorker(
      { id: 'w1', displayName: 'W', occupantType: 'human', active: true, allowedCapabilities: ['not.a.real.cap'] },
      'founder',
      'seed',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unknown_capability_ref');
  });

  it('denies assignRole when the worker lacks a required capability (deny by default)', () => {
    engine.defineRole(
      {
        id: 'r1',
        name: 'Reviewer',
        departmentId: 'eng',
        teamSizeTarget: 1,
        eligibleOccupantTypes: ['human'],
        requiredCapabilities: ['ops.review_code'],
      },
      'founder',
      'seed',
    );
    engine.registerWorker(
      { id: 'w1', displayName: 'W', occupantType: 'human', active: true, allowedCapabilities: ['ops.write_reports'] },
      'founder',
      'seed',
    );
    const res = engine.assignRole('r1', 'w1', 'founder', 'staff reviewer');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('capability_not_granted');
      expect(res.error.details?.missing).toEqual(['ops.review_code']);
    }
  });

  it('denies assignRole for an ineligible occupant type', () => {
    engine.defineRole(
      { id: 'r2', name: 'Humans only', departmentId: 'eng', teamSizeTarget: 1, eligibleOccupantTypes: ['human'] },
      'founder',
      'seed',
    );
    engine.registerWorker(
      { id: 'gpt', displayName: 'GPT', occupantType: 'ai', provider: 'chatgpt', active: true, allowedCapabilities: [] },
      'founder',
      'seed',
    );
    const res = engine.assignRole('r2', 'gpt', 'founder', 'try to staff an AI into a human-only role');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('occupant_type_not_eligible');
  });

  it('denies assignRole for an inactive worker', () => {
    engine.defineRole(
      { id: 'r3', name: 'Any', departmentId: 'eng', teamSizeTarget: 1, eligibleOccupantTypes: ['human'] },
      'founder',
      'seed',
    );
    engine.registerWorker(
      { id: 'w-off', displayName: 'Off', occupantType: 'human', active: false, allowedCapabilities: [] },
      'founder',
      'seed',
    );
    const res = engine.assignRole('r3', 'w-off', 'founder', 'try inactive worker');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('worker_inactive');
  });
});

describe('organization engine — org edits grant no Operator side-effect rights', () => {
  it('never mutates the caller-owned worker descriptor passed into registerWorker', () => {
    const engine = createOrganizationEngine({ capabilityIds: CAPS });
    const descriptor = Object.freeze({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead' as const,
      allowedCapabilities: Object.freeze(['ops.write_reports']) as unknown as string[],
      active: true,
    });
    const before = JSON.parse(JSON.stringify(descriptor));

    // Frozen — any attempted write throws in strict mode (ESM modules are
    // always strict), which itself proves the engine never tries to write to
    // the caller's object as long as this call does not throw.
    const res = engine.registerWorker(
      { id: descriptor.id, displayName: descriptor.displayName, occupantType: 'ai', provider: 'claude', active: descriptor.active, allowedCapabilities: descriptor.allowedCapabilities },
      'founder',
      'onboard claude',
    );
    expect(res.ok).toBe(true);
    expect(descriptor).toEqual(before); // untouched

    // The engine's own copy is a distinct object/array, not an alias.
    const org = engine.getCurrentOrg();
    const stored = org.workers.find((w) => w.id === 'claude')!;
    expect(stored.allowedCapabilities).toEqual(descriptor.allowedCapabilities);
    expect(stored.allowedCapabilities).not.toBe(descriptor.allowedCapabilities);
  });

  it('never mutates the capabilityIds set handed to the engine at construction', () => {
    const caps = new Set(CAPS);
    const capsSnapshot = new Set(caps);
    const engine = createOrganizationEngine({ capabilityIds: caps });
    engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
    engine.defineRole(
      { id: 'r1', name: 'R', departmentId: 'eng', teamSizeTarget: 1, eligibleOccupantTypes: ['human'], requiredCapabilities: ['ops.deploy'] },
      'founder',
      'seed',
    );
    engine.registerWorker(
      { id: 'w1', displayName: 'W', occupantType: 'human', active: true, allowedCapabilities: ['ops.deploy'] },
      'founder',
      'seed',
    );
    engine.assignRole('r1', 'w1', 'founder', 'staff');
    expect(caps).toEqual(capsSnapshot); // caller's Set is exactly as they made it
  });
});

describe('organization engine — team-size target changes', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    seedDeptAndRoles(engine);
  });

  it('accepts a valid non-negative integer target', () => {
    const res = engine.setTeamSizeTarget('role-manager', 5, 'founder', 'growing the team');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.role.teamSizeTarget).toBe(5);
      expect(res.data.warning).toBeNull();
    }
  });

  it('rejects a negative target', () => {
    const res = engine.setTeamSizeTarget('role-manager', -1, 'founder', 'bad input');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid_input');
  });

  it('rejects a non-integer target', () => {
    const res = engine.setTeamSizeTarget('role-manager', 1.5, 'founder', 'bad input');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid_input');
  });

  it('accepts a target below the current occupant count, and reports a warning rather than rejecting', () => {
    seedWorkers(engine);
    engine.assignRole('role-manager', 'alice', 'founder', 'staff'); // maxOccupants defaults to 1
    engine.setTeamSizeTarget('role-manager', 3, 'founder', 'raise target first'); // avoid maxOccupants friction
    const res = engine.setTeamSizeTarget('role-manager', 0, 'founder', 'shrink below current headcount');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.role.teamSizeTarget).toBe(0);
      expect(res.data.warning).toMatch(/below the current occupant count/);
    }
    // Nobody was removed by shrinking the target.
    expect(engine.getCurrentOrg().occupants).toHaveLength(1);
  });

  it('rejects a team-size change for an unknown role', () => {
    const res = engine.setTeamSizeTarget('ghost-role', 1, 'founder', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });
});

describe('organization engine — multi-role policy, exclusivity, maxOccupants', () => {
  function makeEngine(allowMultiRolePerWorker: boolean) {
    const engine = createOrganizationEngine({ capabilityIds: CAPS, policy: { allowMultiRolePerWorker } });
    engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'seed');
    engine.defineRole(
      { id: 'role-a', name: 'A', departmentId: 'eng', teamSizeTarget: 1, maxOccupants: 1, eligibleOccupantTypes: ['human'], exclusivity: 'shared' },
      'founder',
      'seed',
    );
    engine.defineRole(
      { id: 'role-b', name: 'B', departmentId: 'eng', teamSizeTarget: 1, maxOccupants: 1, eligibleOccupantTypes: ['human'], exclusivity: 'shared' },
      'founder',
      'seed',
    );
    engine.defineRole(
      { id: 'role-exclusive', name: 'Exclusive', departmentId: 'eng', teamSizeTarget: 1, maxOccupants: 1, eligibleOccupantTypes: ['human'], exclusivity: 'exclusive' },
      'founder',
      'seed',
    );
    engine.defineRole(
      { id: 'role-multi', name: 'Multi-seat', departmentId: 'eng', teamSizeTarget: 2, maxOccupants: 2, eligibleOccupantTypes: ['human'], exclusivity: 'shared' },
      'founder',
      'seed',
    );
    engine.registerWorker({ id: 'alice', displayName: 'Alice', occupantType: 'human', active: true, allowedCapabilities: [] }, 'founder', 'seed');
    engine.registerWorker({ id: 'bob', displayName: 'Bob', occupantType: 'human', active: true, allowedCapabilities: [] }, 'founder', 'seed');
    engine.registerWorker({ id: 'carol', displayName: 'Carol', occupantType: 'human', active: true, allowedCapabilities: [] }, 'founder', 'seed');
    return engine;
  }

  it('rejects a second role for a worker when org policy disallows multi-role', () => {
    const engine = makeEngine(false);
    expect(engine.assignRole('role-a', 'alice', 'founder', 'staff').ok).toBe(true);
    const res = engine.assignRole('role-b', 'alice', 'founder', 'staff second role');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('multi_role_not_allowed');
  });

  it('allows a second shared role for a worker when org policy allows multi-role', () => {
    const engine = makeEngine(true);
    expect(engine.assignRole('role-a', 'alice', 'founder', 'staff').ok).toBe(true);
    const res = engine.assignRole('role-b', 'alice', 'founder', 'staff second role');
    expect(res.ok).toBe(true);
    expect(engine.rolesForWorker('alice').sort()).toEqual(['role-a', 'role-b']);
  });

  it('enforces per-role exclusivity even when org policy allows multi-role', () => {
    const engine = makeEngine(true);
    expect(engine.assignRole('role-exclusive', 'alice', 'founder', 'staff exclusive').ok).toBe(true);
    const res = engine.assignRole('role-a', 'alice', 'founder', 'try to add a second role');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('exclusivity_violation');
  });

  it('refuses to add the exclusive role to a worker who already holds another role', () => {
    const engine = makeEngine(true);
    expect(engine.assignRole('role-a', 'alice', 'founder', 'staff shared first').ok).toBe(true);
    const res = engine.assignRole('role-exclusive', 'alice', 'founder', 'then try exclusive');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('exclusivity_violation');
  });

  it('enforces maxOccupants on a role', () => {
    const engine = makeEngine(true);
    expect(engine.assignRole('role-multi', 'alice', 'founder', 'seat 1').ok).toBe(true);
    expect(engine.assignRole('role-multi', 'bob', 'founder', 'seat 2').ok).toBe(true);
    const res = engine.assignRole('role-multi', 'carol', 'founder', 'seat 3, over capacity');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('max_occupants_exceeded');
  });

  it('rejects assigning the same worker to the same role twice', () => {
    const engine = makeEngine(true);
    expect(engine.assignRole('role-a', 'alice', 'founder', 'first').ok).toBe(true);
    const res = engine.assignRole('role-a', 'alice', 'founder', 'again');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicate_id');
  });
});

describe('organization engine — registerTaskOwnership requires real occupancy', () => {
  let engine: OrganizationEngine;

  beforeEach(() => {
    engine = createOrganizationEngine({ capabilityIds: CAPS });
    seedDeptAndRoles(engine);
    seedWorkers(engine);
  });

  it('rejects registering ownership for a worker who does not occupy the role', () => {
    const res = engine.registerTaskOwnership('t1', 'role-manager', 'alice', 'founder', 'assign');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_occupant');
  });

  it('rejects a duplicate ownership record for the same task', () => {
    engine.assignRole('role-manager', 'alice', 'founder', 'staff');
    expect(engine.registerTaskOwnership('t1', 'role-manager', 'alice', 'founder', 'assign').ok).toBe(true);
    const res = engine.registerTaskOwnership('t1', 'role-manager', 'alice', 'founder', 'assign again');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicate_id');
  });
});
