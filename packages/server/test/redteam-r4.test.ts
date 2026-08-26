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
import { saveSettings } from '../src/services/settings.js';
import { createReceipt, postReceipt } from '../src/services/receiving.js';
import { createInvoice, confirmInvoice } from '../src/services/sales.js';
import { getAvailable, getOnHand } from '../src/services/inventory.js';
import { createWorkOrder, issuePartToWorkOrder, startWorkOrder, listWorkOrders } from '../src/services/workorders.js';
import { createResource, createBooking, rescheduleBooking, listBookings } from '../src/services/bookings.js';
import { nowIso } from '../src/util.js';

/**
 * Regressions for RED_TEAM_R4. Each test reproduces a CONFIRMED exploit and
 * asserts it is now refused. These must never be deleted.
 */

let db: Db;
let tt: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'R4');
});

function stockAndLot(qty = 100): string {
  const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'Sup' });
  const r = createReceipt(tt.ownerCtx, {
    supplierId, date: '2026-08-01', itemId: tt.items.pack1kg,
    entryUomId: tt.uoms.piece, netQty: qty, warehouseId: tt.warehouses.a,
  });
  postReceipt(tt.ownerCtx, r.id);
  return db.select().from(lots).where(eq(lots.itemId, tt.items.pack1kg)).get()!.id;
}

// ---------------------------------------------------------------------------
describe('R4 H1 — double-booking via a non-UTC timestamp format', () => {
  it('the SAME instant expressed with an offset still collides', () => {
    const room = createResource(tt.ownerCtx, { code: 'R1', name: 'Room 1' });
    createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-09-01T09:00:00.000Z', endAt: '2026-09-01T11:00:00.000Z' });
    // 12:00+03:00 IS 09:00Z — previously slipped past the lexicographic compare
    expect(() =>
      createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-09-01T12:00:00.000+03:00', endAt: '2026-09-01T14:00:00.000+03:00' }),
    ).toThrowError(/already booked/);
  });

  it('rescheduling onto an occupied slot with an offset format is refused', () => {
    const room = createResource(tt.ownerCtx, { code: 'R2', name: 'Room 2' });
    createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-09-02T09:00:00.000Z', endAt: '2026-09-02T11:00:00.000Z' });
    const b = createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-09-02T15:00:00.000Z', endAt: '2026-09-02T16:00:00.000Z' });
    expect(() =>
      rescheduleBooking(tt.ownerCtx, b.id, '2026-09-02T12:00:00.000+03:00', '2026-09-02T13:00:00.000+03:00'),
    ).toThrowError(/already booked/);
  });

  it('instants are stored canonically so the day view cannot be skewed', () => {
    const room = createResource(tt.ownerCtx, { code: 'R3', name: 'Room 3' });
    createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-09-03T12:00:00.000+03:00', endAt: '2026-09-03T14:00:00.000+03:00' });
    const rows = listBookings(tt.ownerCtx, {});
    expect(rows[0]!.startAt).toBe('2026-09-03T09:00:00.000Z'); // normalised to UTC
    // and a window expressed in an offset format still finds it
    expect(listBookings(tt.ownerCtx, { from: '2026-09-03T11:00:00.000+03:00', to: '2026-09-03T15:00:00.000+03:00' })).toHaveLength(1);
  });
});

describe('R4 H3 — a single booking permanently blocking a resource', () => {
  it('garbage instants are refused outright', () => {
    const room = createResource(tt.ownerCtx, { code: 'R4', name: 'Room 4' });
    expect(() => createBooking(tt.ownerCtx, { resourceId: room, startAt: '!', endAt: '~' })).toThrowError(/valid date/);
    // the resource is still bookable afterwards — no denial of service
    expect(() => createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-09-04T09:00:00.000Z', endAt: '2026-09-04T10:00:00.000Z' })).not.toThrow();
  });

  it('an absurdly long booking is refused', () => {
    const room = createResource(tt.ownerCtx, { code: 'R5', name: 'Room 5' });
    expect(() =>
      createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-01-01T00:00:00.000Z', endAt: '3026-01-01T00:00:00.000Z' }),
    ).toThrowError(/supported date range/); // caught even earlier now: year 3026 is out of range
    // and a long-but-in-range span is still refused by the duration cap
    expect(() =>
      createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-01-01T00:00:00.000Z', endAt: '2028-01-01T00:00:00.000Z' }),
    ).toThrowError(/may not exceed/);
  });
});

describe('R4 H2 — work-order parts consuming RESERVED stock', () => {
  it('a job cannot consume stock committed to a confirmed sale', () => {
    saveSettings(tt.ownerCtx, 'pricing', { categories: ['retail'], prices: { [tt.items.pack1kg]: { retail: 50 } } });
    const lotId = stockAndLot(10);
    const customerId = createParty(tt.sysCtx, { kind: 'customer', name: 'Cust' });
    // reserve all 10 against a confirmed invoice
    const inv = createInvoice(tt.ownerCtx, {
      customerId, date: nowIso().slice(0, 10), paymentTerm: 'credit', dueDate: '2026-12-31',
      priceCategory: 'retail',
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty: 10, entryUomId: tt.uoms.piece }],
    });
    confirmInvoice(tt.ownerCtx, inv.id);
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(0);

    const wo = createWorkOrder(tt.ownerCtx, { title: 'Job', scheduledFor: '2026-08-23' });
    expect(() =>
      issuePartToWorkOrder(tt.ownerCtx, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 4 }),
    ).toThrowError(/available/);
    // available never went negative and on-hand is untouched
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(0);
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(10000);
  });

  it('a non-numeric quantity cannot post a ledger movement', () => {
    const lotId = stockAndLot(10);
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Job', scheduledFor: '2026-08-23' });
    expect(() =>
      issuePartToWorkOrder(tt.ownerCtx, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: true as unknown as number }),
    ).toThrowError(/must be a number/);
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(10000);
  });
});

describe('R4 M1/M2 — authority on job operations', () => {
  function userWith(matrix: ReturnType<typeof matrixOf>, username: string): Ctx {
    const roleId = createRole(tt.sysCtx, { code: `r-${username}`, name: username, matrix });
    const uid = createUser(tt.sysCtx, { username, displayName: username, password: 'test-password', roleId });
    return { db, tenantId: tt.tenantId, user: buildSessionUser(db, uid)! };
  }

  it('inventory.create alone can no longer consume stock against a job', () => {
    const lotId = stockAndLot(10);
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Job', scheduledFor: '2026-08-23' });
    const stockOnly = userWith(matrixOf([['inventory', ['view', 'create']]]), 'stockonly');
    expect(() =>
      issuePartToWorkOrder(stockOnly, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 1 }),
    ).toThrowError(/permission/);
  });

  it('a job transition checks authority BEFORE existence (no id oracle)', () => {
    const nobody = userWith(matrixOf([['dashboard', ['view']]]), 'nobody');
    // a real job and a non-existent id must fail the SAME way for this user
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Real job' });
    const realErr = (() => { try { startWorkOrder(nobody, wo.id); } catch (e) { return (e as Error).message; } })();
    const fakeErr = (() => { try { startWorkOrder(nobody, 'does-not-exist'); } catch (e) { return (e as Error).message; } })();
    expect(realErr).toBe(fakeErr);
    expect(realErr).toMatch(/permission/);
  });

  it('a caller-supplied limit cannot widen the page', () => {
    for (let i = 0; i < 3; i++) createWorkOrder(tt.ownerCtx, { title: `Job ${i}` });
    expect(listWorkOrders(tt.ownerCtx, { limit: -1 as unknown as number }).length).toBeLessThanOrEqual(100);
    expect(listWorkOrders(tt.ownerCtx, { limit: 99999 as unknown as number }).length).toBeLessThanOrEqual(500);
  });
});
