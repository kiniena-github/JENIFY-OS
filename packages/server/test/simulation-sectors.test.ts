import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, lots, stockMovements } from '../src/db/schema.js';
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
  issuePartToWorkOrder, myWorkOrders, listWorkOrders,
} from '../src/services/workorders.js';
import {
  createResource, createBooking, checkInBooking, completeBooking, cancelBooking,
  markNoShow, rescheduleBooking, listBookings,
} from '../src/services/bookings.js';

/**
 * §34 realistic multi-sector simulation for the capabilities added this wave.
 *
 * Two fake businesses are driven through an operational PERIOD — not one happy
 * transaction — including the failures real operations produce: a cancelled
 * job, a no-show, a double-booking attempt, a reschedule collision, parts
 * consumed against stock, and work assigned across staff. Ledger and audit
 * invariants are asserted at the end.
 */

let db: Db;

// ---------------------------------------------------------------------------
// A: "Kombolcha Auto" — a workshop (work orders + parts + technicians)
// ---------------------------------------------------------------------------
describe('§34 simulation — automotive workshop over an operational week', () => {
  let shop: TestTenant;
  let techA: { ctx: Ctx; userId: string };
  let techB: { ctx: Ctx; userId: string };
  let lotId: string;

  function makeTech(tt: TestTenant, username: string): { ctx: Ctx; userId: string } {
    const roleId = createRole(tt.sysCtx, {
      code: `tech-${username}`, name: 'Technician', dashboardFocus: 'production',
      matrix: matrixOf([['production', ['view', 'edit']], ['inventory', ['view', 'create']]]),
    });
    const userId = createUser(tt.sysCtx, { username, displayName: username, password: 'test-password', roleId });
    return { ctx: { db, tenantId: tt.tenantId, user: buildSessionUser(db, userId)! }, userId };
  }

  beforeEach(() => {
    db = testDb();
    shop = makeTestTenant(db, 'AUTO');
    techA = makeTech(shop, 'abel');
    techB = makeTech(shop, 'bereket');
    const supplier = createParty(shop.sysCtx, { kind: 'supplier', name: 'Parts Importer' });
    const r = createReceipt(shop.ownerCtx, {
      supplierId: supplier, date: '2026-09-01', itemId: shop.items.pack1kg,
      entryUomId: shop.uoms.piece, netQty: 50, warehouseId: shop.warehouses.a,
    });
    postReceipt(shop.ownerCtx, r.id);
    lotId = db.select().from(lots).where(eq(lots.itemId, shop.items.pack1kg)).get()!.id;
  });

  it('runs a week of jobs including a cancellation, and stock reconciles exactly', () => {
    const customer = createParty(shop.sysCtx, { kind: 'customer', name: 'Dawit' });
    const openingStock = getOnHand(shop.ownerCtx, shop.items.pack1kg, shop.warehouses.a, lotId);

    // Mon: three jobs booked in, assigned across two technicians
    const j1 = createWorkOrder(shop.ownerCtx, { title: 'Brake pads', kind: 'repair', customerId: customer, assetRef: 'CAR-100' });
    const j2 = createWorkOrder(shop.ownerCtx, { title: 'Oil service', kind: 'service', assetRef: 'CAR-200' });
    const j3 = createWorkOrder(shop.ownerCtx, { title: 'Diagnostics', kind: 'inspection', assetRef: 'CAR-300' });
    assignWorkOrder(shop.ownerCtx, j1.id, techA.userId, '2026-09-02');
    assignWorkOrder(shop.ownerCtx, j2.id, techB.userId, '2026-09-02');
    assignWorkOrder(shop.ownerCtx, j3.id, techA.userId, '2026-09-03');

    // each technician sees ONLY their own work
    expect(myWorkOrders(techA.ctx).map((w) => w.id).sort()).toEqual([j1.id, j3.id].sort());
    expect(myWorkOrders(techB.ctx).map((w) => w.id)).toEqual([j2.id]);

    // Tue: j1 worked and parts consumed
    startWorkOrder(techA.ctx, j1.id);
    issuePartToWorkOrder(techA.ctx, j1.id, { itemId: shop.items.pack1kg, warehouseId: shop.warehouses.a, lotId, qty: 4 });
    issuePartToWorkOrder(techA.ctx, j1.id, { itemId: shop.items.pack1kg, warehouseId: shop.warehouses.a, lotId, qty: 2 });
    completeWorkOrder(techA.ctx, j1.id, 'pads replaced');

    // Tue: j2 started but the customer withdrew — cancelled mid-flight
    startWorkOrder(techB.ctx, j2.id);
    cancelWorkOrder(techB.ctx, j2.id, 'customer withdrew the vehicle');

    // Wed: j3 still open
    startWorkOrder(techA.ctx, j3.id);

    // --- invariants ---
    // stock fell by exactly what was issued (6), nothing phantom
    expect(getOnHand(shop.ownerCtx, shop.items.pack1kg, shop.warehouses.a, lotId)).toBe(openingStock - 6000);
    // ledger truth: balance == sum of posted movements for this item/lot
    const movements = db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, shop.tenantId), eq(stockMovements.itemId, shop.items.pack1kg)))
      .all()
      .filter((m) => m.lotId === lotId);
    const summed = movements.reduce((s, m) => s + m.qty, 0);
    expect(getOnHand(shop.ownerCtx, shop.items.pack1kg, shop.warehouses.a, lotId)).toBe(summed);
    // a cancelled job consumed nothing
    expect(listWorkOrders(shop.ownerCtx, { status: 'cancelled' })).toHaveLength(1);
    // the open job remains in its technician's queue; the finished/cancelled do not
    expect(myWorkOrders(techA.ctx).map((w) => w.id)).toEqual([j3.id]);
    expect(myWorkOrders(techB.ctx)).toHaveLength(0);
  });

  it('every job mutation left an audit event', () => {
    const j = createWorkOrder(shop.ownerCtx, { title: 'Audited job' });
    assignWorkOrder(shop.ownerCtx, j.id, techA.userId);
    startWorkOrder(techA.ctx, j.id);
    completeWorkOrder(techA.ctx, j.id);
    const actions = db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, shop.tenantId), eq(auditEvents.entityId, j.id)))
      .all()
      .map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['work_order_create', 'work_order_assign', 'work_order_in_progress', 'work_order_completed']),
    );
  });
});

// ---------------------------------------------------------------------------
// B: "Simien View Hotel" — bookings over an operational period
// ---------------------------------------------------------------------------
describe('§34 simulation — hotel bookings over an operational period', () => {
  let hotel: TestTenant;
  const T = (day: number, hour: number): string =>
    `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  beforeEach(() => {
    db = testDb();
    hotel = makeTestTenant(db, 'HOTEL');
  });

  it('handles arrivals, a no-show, a cancellation, a rejected double-booking and a reschedule', () => {
    const r101 = createResource(hotel.ownerCtx, { code: '101', name: 'Room 101', kind: 'room', capacity: 2 });
    const r102 = createResource(hotel.ownerCtx, { code: '102', name: 'Room 102', kind: 'room', capacity: 2 });
    const guest1 = createParty(hotel.sysCtx, { kind: 'customer', name: 'Selam' });
    const guest2 = createParty(hotel.sysCtx, { kind: 'customer', name: 'Yonas' });

    // night 1: two rooms sold
    const b1 = createBooking(hotel.ownerCtx, { resourceId: r101, startAt: T(10, 14), endAt: T(11, 11), customerId: guest1, partySize: 2 });
    const b2 = createBooking(hotel.ownerCtx, { resourceId: r102, startAt: T(10, 14), endAt: T(11, 11), customerId: guest2 });

    // an overbooking attempt on 101 is REFUSED — the core rule of the sector
    expect(() =>
      createBooking(hotel.ownerCtx, { resourceId: r101, startAt: T(10, 18), endAt: T(11, 10) }),
    ).toThrowError(/already booked/);

    // guest1 arrives; guest2 never shows
    checkInBooking(hotel.ownerCtx, b1.id);
    markNoShow(hotel.ownerCtx, b2.id);

    // 102 is free again the same night because the no-show released it
    const walkIn = createBooking(hotel.ownerCtx, { resourceId: r102, startAt: T(10, 20), endAt: T(11, 11) });
    expect(walkIn.docNumber).toMatch(/^BKG-/);

    // next night booked, then moved — and the move onto an occupied slot fails
    const b3 = createBooking(hotel.ownerCtx, { resourceId: r101, startAt: T(12, 14), endAt: T(13, 11) });
    const b4 = createBooking(hotel.ownerCtx, { resourceId: r101, startAt: T(14, 14), endAt: T(15, 11) });
    expect(() => rescheduleBooking(hotel.ownerCtx, b4.id, T(12, 14), T(13, 11))).toThrowError(/already booked/);
    rescheduleBooking(hotel.ownerCtx, b4.id, T(16, 14), T(17, 11)); // to a free night — fine

    // checkout + a late cancellation
    completeBooking(hotel.ownerCtx, b1.id);
    cancelBooking(hotel.ownerCtx, b3.id, 'guest cancelled by phone');

    // --- invariants ---
    // no two BLOCKING bookings ever overlap on the same resource
    const all = listBookings(hotel.ownerCtx, {});
    const blocking = all.filter((b) => b.status === 'confirmed' || b.status === 'checked_in');
    for (const a of blocking) {
      for (const b of blocking) {
        if (a.id === b.id || a.resourceId !== b.resourceId) continue;
        const overlaps = a.startAt < b.endAt && a.endAt > b.startAt;
        expect(overlaps, `overlap between ${a.docNumber} and ${b.docNumber}`).toBe(false);
      }
    }
    // released statuses really did free their slots
    expect(all.filter((b) => b.status === 'no_show')).toHaveLength(1);
    expect(all.filter((b) => b.status === 'cancelled')).toHaveLength(1);
    expect(all.filter((b) => b.status === 'completed')).toHaveLength(1);
  });

  it('the day view answers the question reception actually asks', () => {
    const room = createResource(hotel.ownerCtx, { code: '201', name: 'Room 201' });
    createBooking(hotel.ownerCtx, { resourceId: room, startAt: T(20, 14), endAt: T(21, 11) });
    createBooking(hotel.ownerCtx, { resourceId: room, startAt: T(22, 14), endAt: T(23, 11) });
    const arrivals = listBookings(hotel.ownerCtx, { from: T(20, 0), to: T(21, 0) });
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.startAt).toBe(T(20, 14));
  });
});
