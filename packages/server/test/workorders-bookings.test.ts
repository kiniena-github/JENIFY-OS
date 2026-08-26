import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { lots } from '../src/db/schema.js';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import type { Ctx } from '../src/services/context.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import { createParty } from '../src/services/parties.js';
import { createReceipt, postReceipt } from '../src/services/receiving.js';
import { getOnHand } from '../src/services/inventory.js';
import {
  createWorkOrder, assignWorkOrder, startWorkOrder, completeWorkOrder, cancelWorkOrder,
  issuePartToWorkOrder, listWorkOrders, myWorkOrders, getWorkOrder,
} from '../src/services/workorders.js';
import {
  createResource, createBooking, checkInBooking, completeBooking, cancelBooking,
  markNoShow, rescheduleBooking, listBookings, conflictingBookings, getBooking,
} from '../src/services/bookings.js';

let db: Db;
let tt: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'WOB');
});

function makeTech(username = 'tech1'): { ctx: Ctx; userId: string } {
  const roleId = createRole(tt.sysCtx, {
    code: `tech-${username}`,
    name: 'Technician',
    dashboardFocus: 'production',
    matrix: matrixOf([['production', ['view', 'edit']], ['inventory', ['view', 'create']]]),
  });
  const userId = createUser(tt.sysCtx, { username, displayName: 'Tech', password: 'test-password', roleId });
  return { ctx: { db, tenantId: tt.tenantId, user: buildSessionUser(db, userId)! }, userId };
}

/** Put 100 units of the (lot-tracked) part into warehouse A; returns its lot id. */
function stockParts(): string {
  const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'PartsCo' });
  const r = createReceipt(tt.ownerCtx, {
    supplierId, date: '2026-08-01', itemId: tt.items.pack1kg,
    entryUomId: tt.uoms.piece, netQty: 100, warehouseId: tt.warehouses.a,
  });
  postReceipt(tt.ownerCtx, r.id);
  const lot = db.select().from(lots).where(eq(lots.itemId, tt.items.pack1kg)).get()!;
  return lot.id;
}

// ---------------------------------------------------------------------------
// Work orders — automotive / field service / utilities / mining / maintenance
// ---------------------------------------------------------------------------
describe('work orders (shared job capability)', () => {
  it('runs the full job lifecycle with audited transitions', () => {
    const { ctx: tech, userId } = makeTech();
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Replace pump seal', kind: 'repair', assetRef: 'PUMP-02' });
    expect(wo.docNumber).toMatch(/^WO-/);
    assignWorkOrder(tt.ownerCtx, wo.id, userId, '2026-08-23');
    expect(getWorkOrder(tt.ownerCtx, wo.id).status).toBe('scheduled');
    startWorkOrder(tech, wo.id);
    expect(getWorkOrder(tt.ownerCtx, wo.id).status).toBe('in_progress');
    completeWorkOrder(tech, wo.id, 'seal replaced, tested');
    const done = getWorkOrder(tt.ownerCtx, wo.id);
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBeTruthy();
    expect(done.completionNote).toContain('seal replaced');
  });

  it('rejects invalid status jumps and closing a closed job', () => {
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Inspect' });
    // draft -> completed is not a legal transition
    expect(() => completeWorkOrder(tt.ownerCtx, wo.id)).toThrowError(/cannot go from draft to completed/);
    startWorkOrder(tt.ownerCtx, wo.id);
    completeWorkOrder(tt.ownerCtx, wo.id);
    expect(() => cancelWorkOrder(tt.ownerCtx, wo.id, 'changed mind')).toThrowError(/cannot go from completed/);
  });

  it('issuing a part posts a REAL stock movement (no phantom consumption)', () => {
    const lotId = stockParts();
    const before = getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId);
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Service', scheduledFor: '2026-08-23' });
    issuePartToWorkOrder(tt.ownerCtx, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 3 });
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(before - 3000);
  });

  it('a lot-tracked part cannot be issued without naming its lot (traceability)', () => {
    stockParts();
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Service', scheduledFor: '2026-08-23' });
    expect(() =>
      issuePartToWorkOrder(tt.ownerCtx, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty: 3 }),
    ).toThrowError(/lot-tracked/);
  });

  it('parts cannot be issued to a completed job', () => {
    const lotId = stockParts();
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Done job' });
    startWorkOrder(tt.ownerCtx, wo.id);
    completeWorkOrder(tt.ownerCtx, wo.id);
    expect(() =>
      issuePartToWorkOrder(tt.ownerCtx, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 1 }),
    ).toThrowError(/scheduled or in-progress/);
  });

  it('an assignee from another tenant is refused (tenant isolation)', () => {
    const other = makeTestTenant(db, 'OTHER');
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Job' });
    expect(() => assignWorkOrder(tt.ownerCtx, wo.id, other.ownerUserId)).toThrowError(/not a user of this organization/);
  });

  it("a technician's queue contains only their own open jobs", () => {
    const a = makeTech('techA');
    const b = makeTech('techB');
    const w1 = createWorkOrder(tt.ownerCtx, { title: 'A job' });
    const w2 = createWorkOrder(tt.ownerCtx, { title: 'B job' });
    const w3 = createWorkOrder(tt.ownerCtx, { title: 'A done' });
    assignWorkOrder(tt.ownerCtx, w1.id, a.userId);
    assignWorkOrder(tt.ownerCtx, w2.id, b.userId);
    assignWorkOrder(tt.ownerCtx, w3.id, a.userId);
    startWorkOrder(a.ctx, w3.id);
    completeWorkOrder(a.ctx, w3.id);
    const queue = myWorkOrders(a.ctx);
    expect(queue.map((w) => w.id)).toEqual([w1.id]); // not B's, not the completed one
  });

  it('requires production permission to create and view', () => {
    const roleId = createRole(tt.sysCtx, { code: 'nobody', name: 'Nobody', matrix: matrixOf([['dashboard', ['view']]]) });
    const uid = createUser(tt.sysCtx, { username: 'no1', displayName: 'No', password: 'test-password', roleId });
    const nobody: Ctx = { db, tenantId: tt.tenantId, user: buildSessionUser(db, uid)! };
    expect(() => createWorkOrder(nobody, { title: 'x' })).toThrowError(/permission/);
    expect(() => listWorkOrders(nobody)).toThrowError(/permission/);
  });
});

// ---------------------------------------------------------------------------
// Bookings — hospitality / restaurant / healthcare / education
// ---------------------------------------------------------------------------
describe('bookings (shared reserved-time capability)', () => {
  const T = (h: number): string => `2026-09-01T${String(h).padStart(2, '0')}:00:00.000Z`;

  it('books a resource and runs the arrival lifecycle', () => {
    const room = createResource(tt.ownerCtx, { code: '101', name: 'Room 101', kind: 'room', capacity: 2 });
    const guest = createParty(tt.sysCtx, { kind: 'customer', name: 'Guest' });
    const b = createBooking(tt.ownerCtx, { resourceId: room, startAt: T(14), endAt: T(18), customerId: guest, partySize: 2 });
    expect(b.docNumber).toMatch(/^BKG-/);
    checkInBooking(tt.ownerCtx, b.id);
    expect(getBooking(tt.ownerCtx, b.id).status).toBe('checked_in');
    completeBooking(tt.ownerCtx, b.id);
    expect(getBooking(tt.ownerCtx, b.id).status).toBe('completed');
  });

  it('REFUSES a double booking of the same resource for overlapping time', () => {
    const table = createResource(tt.ownerCtx, { code: 'T1', name: 'Table 1', kind: 'table', capacity: 4 });
    createBooking(tt.ownerCtx, { resourceId: table, startAt: T(19), endAt: T(21) });
    // exact overlap
    expect(() => createBooking(tt.ownerCtx, { resourceId: table, startAt: T(19), endAt: T(21) })).toThrowError(/already booked/);
    // partial overlap
    expect(() => createBooking(tt.ownerCtx, { resourceId: table, startAt: T(20), endAt: T(22) })).toThrowError(/already booked/);
    // enclosing overlap
    expect(() => createBooking(tt.ownerCtx, { resourceId: table, startAt: T(18), endAt: T(23) })).toThrowError(/already booked/);
  });

  it('ALLOWS back-to-back bookings (half-open intervals)', () => {
    const table = createResource(tt.ownerCtx, { code: 'T2', name: 'Table 2', kind: 'table', capacity: 4 });
    createBooking(tt.ownerCtx, { resourceId: table, startAt: T(18), endAt: T(20) });
    expect(() => createBooking(tt.ownerCtx, { resourceId: table, startAt: T(20), endAt: T(22) })).not.toThrow();
  });

  it('a cancelled or no-show booking FREES the slot', () => {
    const room = createResource(tt.ownerCtx, { code: '102', name: 'Room 102' });
    const first = createBooking(tt.ownerCtx, { resourceId: room, startAt: T(9), endAt: T(11) });
    cancelBooking(tt.ownerCtx, first.id, 'guest cancelled');
    expect(() => createBooking(tt.ownerCtx, { resourceId: room, startAt: T(9), endAt: T(11) })).not.toThrow();

    const room2 = createResource(tt.ownerCtx, { code: '103', name: 'Room 103' });
    const b2 = createBooking(tt.ownerCtx, { resourceId: room2, startAt: T(9), endAt: T(11) });
    markNoShow(tt.ownerCtx, b2.id);
    expect(conflictingBookings(tt.ownerCtx, room2, T(9), T(11))).toHaveLength(0);
  });

  it('rejects capacity overflow, inverted ranges, and cross-tenant customers', () => {
    const table = createResource(tt.ownerCtx, { code: 'T3', name: 'Table 3', capacity: 2 });
    expect(() => createBooking(tt.ownerCtx, { resourceId: table, startAt: T(12), endAt: T(13), partySize: 5 })).toThrowError(/holds 2/);
    expect(() => createBooking(tt.ownerCtx, { resourceId: table, startAt: T(13), endAt: T(12) })).toThrowError(/must be after/);
    const other = makeTestTenant(db, 'OTHER2');
    const foreign = createParty(other.sysCtx, { kind: 'customer', name: 'Foreign' });
    expect(() => createBooking(tt.ownerCtx, { resourceId: table, startAt: T(12), endAt: T(13), customerId: foreign })).toThrow();
  });

  it('rescheduling re-validates the double-booking rule', () => {
    const room = createResource(tt.ownerCtx, { code: '201', name: 'Room 201' });
    const a = createBooking(tt.ownerCtx, { resourceId: room, startAt: T(9), endAt: T(11) });
    const b = createBooking(tt.ownerCtx, { resourceId: room, startAt: T(13), endAt: T(15) });
    // moving b onto a's slot must fail
    expect(() => rescheduleBooking(tt.ownerCtx, b.id, T(9), T(11))).toThrowError(/already booked/);
    // moving b to a free slot works, and does not collide with itself
    expect(() => rescheduleBooking(tt.ownerCtx, b.id, T(16), T(18))).not.toThrow();
    expect(getBooking(tt.ownerCtx, b.id).startAt).toBe(T(16));
    expect(a.id).toBeTruthy();
  });

  it('the day view lists bookings overlapping the window, in time order', () => {
    const room = createResource(tt.ownerCtx, { code: '301', name: 'Room 301' });
    createBooking(tt.ownerCtx, { resourceId: room, startAt: T(15), endAt: T(16) });
    createBooking(tt.ownerCtx, { resourceId: room, startAt: T(9), endAt: T(10) });
    const day = listBookings(tt.ownerCtx, { from: T(8), to: T(20) });
    expect(day.map((b) => b.startAt)).toEqual([T(9), T(15)]);
  });
});
