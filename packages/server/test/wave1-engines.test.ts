import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalPolicy, RoleExperienceSpec } from '@factoryos/shared';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import type { Ctx } from '../src/services/context.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import { createParty } from '../src/services/parties.js';
import { saveRoleExperience, effectiveExperience, getRoleExperience } from '../src/services/experience.js';
import {
  saveApprovalPolicy,
  openApprovalIfRequired,
  decideApproval,
  isApproved,
  pendingApprovalsForActor,
  approvalHistory,
} from '../src/services/approvals.js';
import { applySyncOp, replaySyncOps } from '../src/services/syncops.js';
import { newId } from '../src/util.js';

let db: Db;
let tt: TestTenant;

function userCtx(userId: string): Ctx {
  return { db, tenantId: tt.tenantId, user: buildSessionUser(db, userId)! };
}

/** A warehouse-only user (view+create inventory, nothing else). */
function makeWarehouseUser(): Ctx {
  const roleId = createRole(tt.sysCtx, {
    code: 'warehouse',
    name: 'Warehouse',
    dashboardFocus: 'inventory',
    matrix: matrixOf([['inventory', ['view', 'create', 'approve']]]),
  });
  const userId = createUser(tt.sysCtx, {
    username: 'wh1',
    displayName: 'Warehouse Worker',
    password: 'test-password',
    roleId,
  });
  return userCtx(userId);
}

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'W1E');
});

// ---------------------------------------------------------------------------
// Role Experience Engine — experience is subordinate to permission
// ---------------------------------------------------------------------------
describe('Role Experience Engine (A)', () => {
  it('derives a permission-scoped experience when no spec is configured', () => {
    const wh = makeWarehouseUser();
    const exp = effectiveExperience(wh);
    expect(exp.derived).toBe(true);
    // warehouse can only view inventory → nav is exactly that
    expect(exp.nav).toEqual(['inventory']);
    expect(exp.homeFocus).toBe('inventory'); // from role.dashboardFocus
  });

  it('a spec can NARROW and reorder, but NEVER surface an unpermitted module', () => {
    const wh = makeWarehouseUser();
    const spec: RoleExperienceSpec = {
      homeFocus: 'inventory',
      // spec tries to include sales + payments the warehouse role cannot view
      nav: ['sales', 'inventory', 'payments'],
      mobileActions: [
        { id: 'receive', labelKey: 'x', path: '/receiving', module: 'inventory', action: 'create' },
        { id: 'sell', labelKey: 'x', path: '/sales', module: 'sales', action: 'create' }, // not permitted
      ],
    };
    saveRoleExperience(tt.ownerCtx, wh.user!.roleId, spec);
    const exp = effectiveExperience(wh);
    // sales + payments are filtered out — experience intersected with permission
    expect(exp.nav).toEqual(['inventory']);
    expect(exp.mobileActions.map((a) => a.id)).toEqual(['receive']); // sell removed
    expect(exp.derived).toBe(false);
  });

  it('saving an experience requires manage_users and is versioned', () => {
    const wh = makeWarehouseUser();
    // the warehouse user cannot save experiences (no manage_users)
    expect(() => saveRoleExperience(wh, wh.user!.roleId, {})).toThrowError(/permission/);
    const v1 = saveRoleExperience(tt.ownerCtx, wh.user!.roleId, { homeFocus: 'inventory' });
    const v2 = saveRoleExperience(tt.ownerCtx, wh.user!.roleId, { homeFocus: 'inventory', kpis: ['stock'] });
    expect(v2).toBe(v1 + 1);
    expect(getRoleExperience(tt.ownerCtx, wh.user!.roleId)?.kpis).toEqual(['stock']);
  });
});

// ---------------------------------------------------------------------------
// Approvals Engine — server-enforced, SoD, multi-step
// ---------------------------------------------------------------------------
describe('Shared Approvals Engine (C)', () => {
  function financeAndClerk(): { finance: Ctx; clerk: Ctx; clerkId: string } {
    const financeRole = createRole(tt.sysCtx, { code: 'finance', name: 'Finance', matrix: matrixOf([['payments', ['view', 'approve']]]) });
    const clerkRole = createRole(tt.sysCtx, { code: 'clerk', name: 'Clerk', matrix: matrixOf([['sales', ['view', 'create']]]) });
    const financeId = createUser(tt.sysCtx, { username: 'fin', displayName: 'Finance', password: 'test-password', roleId: financeRole });
    const clerkId = createUser(tt.sysCtx, { username: 'clerk', displayName: 'Clerk', password: 'test-password', roleId: clerkRole });
    return { finance: userCtx(financeId), clerk: userCtx(clerkId), clerkId };
  }

  const policy: ApprovalPolicy = {
    subjectType: 'discount',
    thresholdMinor: 100_00,
    steps: [{ approverRoleCode: 'finance' }],
    separationOfDuties: true,
    active: true,
  };

  it('no policy → nothing requires approval', () => {
    const gate = openApprovalIfRequired(tt.ownerCtx, { subjectType: 'discount', subjectId: newId(), magnitudeMinor: 999_00 });
    expect(gate.required).toBe(false);
  });

  it('below threshold → no approval; at/above → a pending request opens', () => {
    financeAndClerk(); // approver roles must exist before the policy references them
    saveApprovalPolicy(tt.ownerCtx, 'discount', policy);
    expect(openApprovalIfRequired(tt.ownerCtx, { subjectType: 'discount', subjectId: newId(), magnitudeMinor: 50_00 }).required).toBe(false);
    const gate = openApprovalIfRequired(tt.ownerCtx, { subjectType: 'discount', subjectId: newId(), magnitudeMinor: 100_00 });
    expect(gate.required).toBe(true);
    expect(gate.status).toBe('pending');
  });

  it('only the step approver role may approve (server-enforced)', () => {
    const { finance, clerk } = financeAndClerk();
    saveApprovalPolicy(tt.ownerCtx, 'discount', policy);
    const subjectId = newId();
    const gate = openApprovalIfRequired(clerk, { subjectType: 'discount', subjectId, magnitudeMinor: 200_00 });
    // the clerk (requester, wrong role) cannot approve
    expect(() => decideApproval(clerk, gate.requestId!, 'approve')).toThrowError(/role 'finance'/);
    // finance approves → resolved
    expect(decideApproval(finance, gate.requestId!, 'approve').status).toBe('approved');
    expect(isApproved(tt.ownerCtx, 'discount', subjectId)).toBe(true);
  });

  it('separation of duties: the requester cannot approve even with the right role', () => {
    // a finance user who is ALSO the requester (role created before the policy)
    const financeRoleId = createRole(tt.sysCtx, { code: 'finance', name: 'Finance', matrix: matrixOf([['payments', ['view', 'approve']]]) });
    saveApprovalPolicy(tt.ownerCtx, 'discount', { ...policy, steps: [{ approverRoleCode: 'finance' }] });
    const finId = createUser(tt.sysCtx, { username: 'fin2', displayName: 'Fin', password: 'test-password', roleId: financeRoleId });
    const fin = userCtx(finId);
    const subjectId = newId();
    const gate = openApprovalIfRequired(fin, { subjectType: 'discount', subjectId, magnitudeMinor: 200_00 });
    expect(() => decideApproval(fin, gate.requestId!, 'approve')).toThrowError(/separation of duties/);
  });

  it('multi-step: both steps must approve, history is append-only', () => {
    const mgrRole = createRole(tt.sysCtx, { code: 'manager', name: 'Manager', matrix: matrixOf([['sales', ['view', 'approve']]]) });
    const finRole = createRole(tt.sysCtx, { code: 'finance', name: 'Finance', matrix: matrixOf([['payments', ['view', 'approve']]]) });
    const mgrId = createUser(tt.sysCtx, { username: 'mgr', displayName: 'Mgr', password: 'test-password', roleId: mgrRole });
    const finId = createUser(tt.sysCtx, { username: 'fin', displayName: 'Fin', password: 'test-password', roleId: finRole });
    const twoStep: ApprovalPolicy = {
      subjectType: 'expense',
      thresholdMinor: 0,
      steps: [{ approverRoleCode: 'manager' }, { approverRoleCode: 'finance' }],
      separationOfDuties: true,
      active: true,
    };
    saveApprovalPolicy(tt.ownerCtx, 'expense', twoStep);
    const subjectId = newId();
    const gate = openApprovalIfRequired(tt.ownerCtx, { subjectType: 'expense', subjectId, magnitudeMinor: 500_00 });
    // step 1: finance cannot approve first (wrong step), manager can
    expect(() => decideApproval(userCtx(finId), gate.requestId!, 'approve')).toThrowError(/role 'manager'/);
    expect(decideApproval(userCtx(mgrId), gate.requestId!, 'approve').status).toBe('pending'); // step 1 of 2
    expect(isApproved(tt.ownerCtx, 'expense', subjectId)).toBe(false);
    // step 2: finance approves → approved
    expect(decideApproval(userCtx(finId), gate.requestId!, 'approve').status).toBe('approved');
    expect(isApproved(tt.ownerCtx, 'expense', subjectId)).toBe(true);
    expect(approvalHistory(tt.ownerCtx, gate.requestId!).length).toBe(3); // submit + 2 approvals
  });

  it('rejects a policy whose steps repeat an approver role (M2 — multi-step means multi-person)', () => {
    createRole(tt.sysCtx, { code: 'finance', name: 'Finance', matrix: matrixOf([['payments', ['view', 'approve']]]) });
    expect(() =>
      saveApprovalPolicy(tt.ownerCtx, 'expense', {
        subjectType: 'expense',
        thresholdMinor: 0,
        steps: [{ approverRoleCode: 'finance' }, { approverRoleCode: 'finance' }],
        separationOfDuties: true,
        active: true,
      }),
    ).toThrowError(/distinct approver role/);
  });

  it('a mid-flight policy edit does NOT re-base an open request (M1 — pinned version)', () => {
    const finRole = createRole(tt.sysCtx, { code: 'finance', name: 'Finance', matrix: matrixOf([['payments', ['view', 'approve']]]) });
    createRole(tt.sysCtx, { code: 'director', name: 'Director', matrix: matrixOf([['settings', ['view', 'approve']]]) });
    const finId = createUser(tt.sysCtx, { username: 'fin', displayName: 'Fin', password: 'test-password', roleId: finRole });
    // v1: single finance step
    saveApprovalPolicy(tt.ownerCtx, 'discount', { subjectType: 'discount', thresholdMinor: 0, steps: [{ approverRoleCode: 'finance' }], separationOfDuties: true, active: true });
    const subjectId = newId();
    const gate = openApprovalIfRequired(tt.ownerCtx, { subjectType: 'discount', subjectId, magnitudeMinor: 500_00 });
    // policy is edited to a stricter 2-step chain AFTER the request opened
    saveApprovalPolicy(tt.ownerCtx, 'discount', { subjectType: 'discount', thresholdMinor: 0, steps: [{ approverRoleCode: 'director' }, { approverRoleCode: 'finance' }], separationOfDuties: true, active: true });
    // the open request still resolves under its pinned v1 (finance, single step)
    expect(decideApproval(userCtx(finId), gate.requestId!, 'approve').status).toBe('approved');
    expect(isApproved(tt.ownerCtx, 'discount', subjectId)).toBe(true);
  });

  it("a rejection resolves the request and it is not approved", () => {
    const { finance, clerk } = financeAndClerk();
    saveApprovalPolicy(tt.ownerCtx, 'discount', policy);
    const subjectId = newId();
    const gate = openApprovalIfRequired(clerk, { subjectType: 'discount', subjectId, magnitudeMinor: 200_00 });
    expect(decideApproval(finance, gate.requestId!, 'reject', 'too high').status).toBe('rejected');
    expect(isApproved(tt.ownerCtx, 'discount', subjectId)).toBe(false);
    // the approver's queue no longer lists it
    expect(pendingApprovalsForActor(finance).some((r) => r.id === gate.requestId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Offline Receiving sync — at-most-once, honest states, no double-post
// ---------------------------------------------------------------------------
describe('Offline Receiving sync (B)', () => {
  function receivingPayload() {
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'Afdera Salt Co' });
    return {
      supplierId,
      date: '2026-08-22',
      itemId: tt.items.raw,
      entryUomId: tt.uoms.ton,
      netQty: 10,
      warehouseId: tt.warehouses.a,
    };
  }

  it('applies a queued receiving op once and reports SYNCED (applied)', () => {
    const wh = makeWarehouseUser();
    const op = { opKey: newId(), opType: 'receiving.post', payload: receivingPayload() };
    const res = applySyncOp(wh, op);
    expect(res.status).toBe('applied');
    expect(res.duplicate).toBe(false);
    expect(res.resultRef).toBeTruthy();
  });

  it('replaying the SAME opKey never double-posts (idempotent)', () => {
    const wh = makeWarehouseUser();
    const op = { opKey: newId(), opType: 'receiving.post', payload: receivingPayload() };
    const first = applySyncOp(wh, op);
    const again = applySyncOp(wh, op);
    expect(again.status).toBe('applied');
    expect(again.duplicate).toBe(true);
    expect(again.resultRef).toBe(first.resultRef); // same receipt, not a new one
  });

  it('a business rejection is recorded and surfaced, never silently merged', () => {
    const wh = makeWarehouseUser();
    const bad = { opKey: newId(), opType: 'receiving.post', payload: { ...receivingPayload(), warehouseId: 'does-not-exist' } };
    const res = applySyncOp(wh, bad);
    expect(res.status).toBe('rejected');
    expect(res.message).toBeTruthy();
    // replaying the rejected op returns the recorded rejection (terminal for that key)
    const again = applySyncOp(wh, bad);
    expect(again.status).toBe('rejected');
    expect(again.duplicate).toBe(true);
  });

  it('an op from a user without permission is rejected, nothing posted', () => {
    // a viewer with no inventory.create
    const roleId = createRole(tt.sysCtx, { code: 'viewer', name: 'Viewer', matrix: matrixOf([['inventory', ['view']]]) });
    const uid = createUser(tt.sysCtx, { username: 'view1', displayName: 'Viewer', password: 'test-password', roleId });
    const res = applySyncOp(userCtx(uid), { opKey: newId(), opType: 'receiving.post', payload: receivingPayload() });
    expect(res.status).toBe('rejected');
  });

  it('replays a batch in order, each result independent', () => {
    const wh = makeWarehouseUser();
    const good = { opKey: newId(), opType: 'receiving.post', payload: receivingPayload() };
    const bad = { opKey: newId(), opType: 'receiving.post', payload: { ...receivingPayload(), netQty: -5 } };
    const results = replaySyncOps(wh, [good, bad]);
    expect(results[0]!.status).toBe('applied');
    expect(results[1]!.status).toBe('rejected');
  });
});
