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
import { postMovement, getOnHand, getAvailable, createReservation } from '../src/services/inventory.js';
import { toBaseQty } from '../src/services/masterdata.js';
import { createWorkOrder, issuePartToWorkOrder, startWorkOrder, listWorkOrders } from '../src/services/workorders.js';
import { createResource, createBooking, listBookings, conflictingBookings } from '../src/services/bookings.js';
import { requireInstant, requireQty, requireSpan, clampLimit, requireEnum, requireText } from '../src/validate.js';

/**
 * AI TASK #3 — R4 BUG-FAMILY regression matrix.
 *
 * These cover the FAMILIES the R4 red team found, not only the individual
 * exploits that were fixed. The goal is that a newly added endpoint cannot
 * reintroduce the same class of defect.
 */

let db: Db;
let tt: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'BF');
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

const grab = (fn: () => void): string => {
  try { fn(); return 'NO-THROW'; } catch (e) { return (e as Error).message; }
};

// ===========================================================================
// FAMILY 1 — TIME / DATE SAFETY
// ===========================================================================
describe('bug family: time/date safety', () => {
  const SAME_INSTANT = [
    '2026-09-01T09:00:00.000Z',
    '2026-09-01T12:00:00.000+03:00', // positive offset
    '2026-09-01T04:00:00.000-05:00', // negative offset
  ];

  it('the same instant in Z, positive and negative offsets canonicalises identically', () => {
    const canon = SAME_INSTANT.map((v) => requireInstant(v, 'x'));
    expect(new Set(canon).size).toBe(1);
    expect(canon[0]).toBe('2026-09-01T09:00:00.000Z');
  });

  it('a booking collides with the SAME instant however it is expressed', () => {
    const room = createResource(tt.ownerCtx, { code: 'A', name: 'A' });
    createBooking(tt.ownerCtx, { resourceId: room, startAt: SAME_INSTANT[0]!, endAt: '2026-09-01T11:00:00.000Z' });
    for (const variant of SAME_INSTANT.slice(1)) {
      expect(
        () => createBooking(tt.ownerCtx, { resourceId: room, startAt: variant, endAt: '2026-09-01T10:00:00.000Z' }),
        `offset variant ${variant} slipped past the overlap check`,
      ).toThrowError(/already booked/);
    }
  });

  it('overlap and day-view queries agree across mixed representations and UTC day boundaries', () => {
    const room = createResource(tt.ownerCtx, { code: 'B', name: 'B' });
    createBooking(tt.ownerCtx, { resourceId: room, startAt: '2026-09-01T22:00:00.000Z', endAt: '2026-09-02T02:00:00.000Z' });
    // a booking crossing the UTC day boundary is visible from both days
    expect(listBookings(tt.ownerCtx, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' })).toHaveLength(1);
    expect(listBookings(tt.ownerCtx, { from: '2026-09-02T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' })).toHaveLength(1);
    // and an offset-format probe finds the same row
    expect(conflictingBookings(tt.ownerCtx, room, '2026-09-02T04:00:00.000+03:00', '2026-09-02T05:00:00.000+03:00')).toHaveLength(1);
  });

  it('invalid, empty and non-string instants are refused', () => {
    for (const bad of ['!', '~', 'not-a-date', '', '   ', null, undefined, 42, true, {}, []]) {
      expect(
        () => requireInstant(bad, 'when'),
        `accepted ${JSON.stringify(bad)}`,
      ).toThrowError(/required|valid date/);
    }
  });

  it('extreme historical and future dates are refused', () => {
    expect(() => requireInstant('1000-01-01T00:00:00.000Z', 'when')).toThrowError(/supported date range/);
    expect(() => requireInstant('9999-01-01T00:00:00.000Z', 'when')).toThrowError(/supported date range/);
  });

  it('excessive and inverted durations are refused; a normal span is accepted', () => {
    expect(() => requireSpan('2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', { start: 's', end: 'e' })).toThrowError(/may not exceed/);
    expect(() => requireSpan('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', { start: 's', end: 'e' })).toThrowError(/must be after/);
    expect(requireSpan('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', { start: 's', end: 'e' }).end).toBe('2026-01-02T00:00:00.000Z');
  });

  it('an instant with no timezone resolves deterministically and canonically', () => {
    expect(requireInstant('2026-09-01', 'when')).toBe('2026-09-01T00:00:00.000Z');
  });
});

// ===========================================================================
// FAMILY 2 — NUMERIC INPUT SAFETY
// ===========================================================================
describe('bug family: numeric input safety', () => {
  const NON_NUMBERS: unknown[] = [true, false, '5', '', 'abc', null, undefined, {}, [], [5], NaN, Infinity, -Infinity];

  it('requireQty rejects every non-number, including booleans and numeric strings', () => {
    for (const bad of NON_NUMBERS) {
      expect(() => requireQty(bad, 'qty'), `accepted ${JSON.stringify(bad)}`).toThrowError(/must be a number|finite/);
    }
  });

  it('zero, negative, fractional and overflow values are rejected per domain rules', () => {
    expect(() => requireQty(0, 'qty')).toThrowError(/greater than zero/);
    expect(() => requireQty(-1, 'qty')).toThrowError(/greater than zero/);
    expect(() => requireQty(1e15, 'qty')).toThrowError(/out of the allowed range/);
    expect(() => requireQty(1.5, 'qty', { integerOnly: true })).toThrowError(/whole number/);
    expect(requireQty(1.5, 'qty')).toBe(1.5); // fractions fine where the domain allows
    expect(requireQty(0, 'qty', { allowZero: true })).toBe(0);
  });

  it('the LEDGER refuses non-numeric and overflow quantities (shared funnel)', () => {
    for (const bad of [true, '5', {}, [], NaN, Infinity]) {
      expect(
        () => postMovement(tt.ownerCtx, {
          itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty: bad as unknown as number,
          movementType: 'adjustment', documentKind: 'test', documentId: 'x',
        }),
        `ledger accepted ${JSON.stringify(bad)}`,
      ).toThrow();
    }
    expect(() => postMovement(tt.ownerCtx, {
      itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty: 1e14,
      movementType: 'adjustment', documentKind: 'test', documentId: 'x', allowNegative: true,
    })).toThrowError(/range/);
  });

  it('UNIT CONVERSION refuses the same family (every natural-unit qty funnels here)', () => {
    for (const bad of [true, '5', {}, NaN, Infinity]) {
      expect(() => toBaseQty(tt.ownerCtx, tt.uoms.ton, bad as unknown as number)).toThrow();
    }
    expect(() => toBaseQty(tt.ownerCtx, tt.uoms.ton, 1e12)).toThrowError(/range/);
  });

  it('RESERVATIONS refuse fractional and non-numeric quantities', () => {
    stockAndLot(10);
    expect(() => createReservation(tt.ownerCtx, {
      itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty: 1.5,
      documentKind: 'test', documentId: 'x',
    })).toThrowError(/whole number/);
    expect(() => createReservation(tt.ownerCtx, {
      itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty: true as unknown as number,
      documentKind: 'test', documentId: 'x',
    })).toThrow();
  });

  it('WORK-ORDER parts refuse the same family and never reach the ledger', () => {
    const lotId = stockAndLot(10);
    const wo = createWorkOrder(tt.ownerCtx, { title: 'J', scheduledFor: '2026-08-23' });
    const before = getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId);
    for (const bad of [true, '5', {}, [], NaN, Infinity, 0, -3]) {
      expect(
        () => issuePartToWorkOrder(tt.ownerCtx, wo.id, {
          itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: bad as unknown as number,
        }),
        `accepted ${JSON.stringify(bad)}`,
      ).toThrow();
    }
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(before);
  });

  it('BOOKING party size refuses the same family', () => {
    const room = createResource(tt.ownerCtx, { code: 'C', name: 'C', capacity: 10 });
    for (const bad of [true, '2', {}, 0, -1, 1.5]) {
      expect(
        () => createBooking(tt.ownerCtx, {
          resourceId: room, startAt: '2026-09-05T09:00:00.000Z', endAt: '2026-09-05T10:00:00.000Z',
          partySize: bad as unknown as number,
        }),
        `accepted ${JSON.stringify(bad)}`,
      ).toThrow();
    }
  });

  it('page limits cannot be widened by garbage or negatives', () => {
    for (const bad of [-1, 0, NaN, Infinity, 'abc', null, undefined, {}, true]) {
      expect(clampLimit(bad, 100, 500), `limit ${JSON.stringify(bad)}`).toBe(100);
    }
    expect(clampLimit(99999, 100, 500)).toBe(500);
    expect(clampLimit(25, 100, 500)).toBe(25);
    expect(clampLimit(25.9, 100, 500)).toBe(25);
  });

  it('list endpoints honour the clamp end to end', () => {
    for (let i = 0; i < 3; i++) createWorkOrder(tt.ownerCtx, { title: `J${i}` });
    expect(listWorkOrders(tt.ownerCtx, { limit: -1 as unknown as number }).length).toBeLessThanOrEqual(100);
    expect(listWorkOrders(tt.ownerCtx, { limit: 1e9 as unknown as number }).length).toBeLessThanOrEqual(500);
  });

  it('text and enum inputs are bounded and closed', () => {
    expect(() => requireText('', 'name')).toThrowError(/required/);
    expect(() => requireText('x'.repeat(501), 'name')).toThrowError(/may not exceed/);
    expect(() => requireText(42, 'name')).toThrowError(/required/);
    expect(() => requireEnum('nope', 'kind', ['a', 'b'] as const)).toThrowError(/must be one of/);
    expect(requireEnum('a', 'kind', ['a', 'b'] as const)).toBe('a');
  });
});

// ===========================================================================
// FAMILY 3 — STOCK AVAILABILITY / RESERVATION CEILINGS
// ===========================================================================
describe('bug family: reserved stock cannot be consumed by another operation', () => {
  function hold(qtyNatural: number, lotId: string): void {
    createReservation(tt.ownerCtx, {
      itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId,
      qty: qtyNatural * 1000, documentKind: 'test_hold', documentId: 'hold-1',
    });
  }

  it('a work order cannot consume stock reserved by another document', () => {
    const lotId = stockAndLot(10);
    hold(10, lotId);
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(0);
    const wo = createWorkOrder(tt.ownerCtx, { title: 'J', scheduledFor: '2026-08-23' });
    expect(() => issuePartToWorkOrder(tt.ownerCtx, wo.id, {
      itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 1,
    })).toThrowError(/available/);
  });

  it('two consumers cannot oversubscribe the same availability', () => {
    const lotId = stockAndLot(10);
    hold(6, lotId); // 4 available
    const wo = createWorkOrder(tt.ownerCtx, { title: 'J', scheduledFor: '2026-08-23' });
    issuePartToWorkOrder(tt.ownerCtx, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 3 });
    expect(() => issuePartToWorkOrder(tt.ownerCtx, wo.id, {
      itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 2,
    })).toThrowError(/available/);
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(1000);
  });

  it('availability and on-hand never go negative through any consumer path', () => {
    const lotId = stockAndLot(5);
    hold(5, lotId);
    const wo = createWorkOrder(tt.ownerCtx, { title: 'J', scheduledFor: '2026-08-23' });
    for (const qty of [1, 5, 100]) {
      try {
        issuePartToWorkOrder(tt.ownerCtx, wo.id, { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty });
      } catch { /* expected */ }
    }
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBeGreaterThanOrEqual(0);
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBeGreaterThanOrEqual(0);
  });

  it('a failed issue rolls back completely — no partial ledger effect', () => {
    const lotId = stockAndLot(10);
    hold(10, lotId);
    const before = getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId);
    const wo = createWorkOrder(tt.ownerCtx, { title: 'J', scheduledFor: '2026-08-23' });
    expect(() => issuePartToWorkOrder(tt.ownerCtx, wo.id, {
      itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, lotId, qty: 4,
    })).toThrow();
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a, lotId)).toBe(before);
  });
});

// ===========================================================================
// FAMILY 4 — PERMISSION / EXISTENCE LEAKAGE
// ===========================================================================
describe('bug family: unauthorized requests must not leak existence', () => {
  function userWith(matrix: ReturnType<typeof matrixOf>, username: string): Ctx {
    const roleId = createRole(tt.sysCtx, { code: `r-${username}`, name: username, matrix });
    const uid = createUser(tt.sysCtx, { username, displayName: username, password: 'test-password', roleId });
    return { db, tenantId: tt.tenantId, user: buildSessionUser(db, uid)! };
  }

  it('a real id and a fake id fail IDENTICALLY for an unauthorized caller', () => {
    const nobody = userWith(matrixOf([['dashboard', ['view']]]), 'nb1');
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Secret job' });
    const real = grab(() => startWorkOrder(nobody, wo.id));
    const fake = grab(() => startWorkOrder(nobody, 'no-such-id'));
    expect(real).toBe(fake);
    expect(real).toMatch(/permission/i);
  });

  it('a real id in a rejecting state is indistinguishable from a nonexistent id', () => {
    const nobody = userWith(matrixOf([['dashboard', ['view']]]), 'nb2');
    const wo = createWorkOrder(tt.ownerCtx, { title: 'Secret job 2' });
    expect(grab(() => startWorkOrder(nobody, wo.id))).toBe(grab(() => startWorkOrder(nobody, 'ghost')));
  });

  it("another tenant's id is indistinguishable from a fake one", () => {
    const other = makeTestTenant(db, 'OTH');
    const foreign = createWorkOrder(other.ownerCtx, { title: 'Foreign' });
    const nobody = userWith(matrixOf([['dashboard', ['view']]]), 'nb3');
    expect(grab(() => startWorkOrder(nobody, foreign.id))).toBe(grab(() => startWorkOrder(nobody, 'ghost2')));
  });
});
