import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import { createParty } from '../src/services/parties.js';
import { saveSettings } from '../src/services/settings.js';
import { createLot, postMovement, getOnHand, getAvailable, getReserved } from '../src/services/inventory.js';
import {
  createInvoice,
  confirmInvoice,
  cancelInvoice,
  getInvoice,
  listInvoiceLines,
  invoicePaidCents,
  invoiceCreditStatus,
  customerOutstanding,
  type CreateInvoiceInput,
} from '../src/services/sales.js';
import {
  createDelivery,
  markLoading,
  dispatchDelivery,
  markDelivered,
  getDelivery,
  updateDeliveryDetails,
} from '../src/services/deliveries.js';
import {
  createPayment,
  applyAllocations,
  reversePayment,
  allocatedCents,
  getPayment,
} from '../src/services/payments.js';
import { creditOverview } from '../src/services/creditview.js';
import { AppError, nowIso } from '../src/util.js';

const PC = 1000; // milli-pieces per pack

let db: Db;
let tt: TestTenant;
let customerId: string;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'SALTA');
  customerId = createParty(tt.ownerCtx, {
    kind: 'customer',
    name: 'North Wholesale',
    partyType: 'wholesaler',
    creditLimit: 200_000,
  });
  saveSettings(tt.ownerCtx, 'pricing', {
    categories: ['retail', 'wholesale', 'distributor'],
    customPrice: { requiresApproval: true },
    discount: { requiresApproval: true },
    prices: { [tt.items.pack1kg]: { retail: 100, wholesale: 80, distributor: 70 } },
  });
  saveSettings(tt.ownerCtx, 'vat', { enabled: true, ratePct: 15 });
});

/** Put finished packs into stock as two lots (FIFO test material). */
function stockPacks(lot1 = 1000, lot2 = 1000, warehouseId = tt.warehouses.b) {
  const mk = (n: string, units: number) => {
    const lotId = createLot(tt.ownerCtx, { itemId: tt.items.pack1kg, lotNumber: n, initialQty: units * PC });
    if (units > 0) {
      postMovement(tt.ownerCtx, {
        itemId: tt.items.pack1kg,
        lotId,
        warehouseId,
        qty: units * PC,
        movementType: 'production_output',
        documentKind: 'production_batch',
        documentId: n,
      });
    }
    return lotId;
  };
  return { lot1: mk('PKG-0001', lot1), lot2: mk('PKG-0002', lot2) };
}

function invoiceInput(overrides: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    customerId,
    date: '2026-08-17',
    priceCategory: 'wholesale',
    paymentTerm: 'credit',
    dueDate: '2026-08-31',
    fulfillment: 'delivery',
    lines: [
      {
        itemId: tt.items.pack1kg,
        warehouseId: tt.warehouses.b,
        qty: 2000,
        entryUomId: tt.uoms.piece,
      },
    ],
    ...overrides,
  };
}

describe('sales invoices', () => {
  it('prices from the list, applies configured VAT, snapshots the config', () => {
    stockPacks();
    const { totalCents, docNumber } = createInvoice(tt.ownerCtx, invoiceInput());
    // 2000 packs x 80 ETB = 160,000; VAT 15% = 24,000; total 184,000
    expect(docNumber).toBe('INV-0001');
    expect(totalCents).toBe(184_000_00);
  });

  it('requires a price when no list price exists, and approval for custom prices', () => {
    stockPacks();
    expect(() =>
      createInvoice(
        tt.ownerCtx,
        invoiceInput({
          lines: [
            { itemId: tt.items.raw, warehouseId: tt.warehouses.b, qty: 100, entryUomId: tt.uoms.kg },
          ],
        }),
      ),
    ).toThrow(/No wholesale price/);
    // custom price without approval flag -> blocked
    expect(() =>
      createInvoice(
        tt.ownerCtx,
        invoiceInput({
          lines: [
            {
              itemId: tt.items.pack1kg,
              warehouseId: tt.warehouses.b,
              qty: 100,
              entryUomId: tt.uoms.piece,
              unitPrice: 75,
            },
          ],
        }),
      ),
    ).toThrow(/approval/);
    // approved custom price passes
    const r = createInvoice(
      tt.ownerCtx,
      invoiceInput({
        customApproved: true,
        lines: [
          {
            itemId: tt.items.pack1kg,
            warehouseId: tt.warehouses.b,
            qty: 100,
            entryUomId: tt.uoms.piece,
            unitPrice: 75,
          },
        ],
      }),
    );
    expect(r.totalCents).toBe(Math.round(100 * 75 * 1.15) * 100);
  });

  it('credit sales require a due date', () => {
    stockPacks();
    expect(() => createInvoice(tt.ownerCtx, invoiceInput({ dueDate: undefined }))).toThrow(
      /due date/i,
    );
  });

  it('confirmation reserves stock FIFO across lots', () => {
    const { lot1, lot2 } = stockPacks(1500, 1000);
    const { id } = createInvoice(tt.ownerCtx, invoiceInput()); // 2000 packs
    confirmInvoice(tt.ownerCtx, id);
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(2000 * PC);
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(500 * PC);
    // allocation: 1500 from lot1 + 500 from lot2 (FIFO)
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b, lot1)).toBe(0);
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b, lot2)).toBe(500 * PC);
    const lines = listInvoiceLines(tt.ownerCtx, id);
    expect(lines.length).toBe(2);
    expect(lines.reduce((s, l) => s + l.qty, 0)).toBe(2000 * PC);
    // money splits proportionally, nothing lost
    const inv = getInvoice(tt.ownerCtx, id);
    expect(lines.reduce((s, l) => s + l.lineSubtotalCents, 0)).toBe(inv.subtotalCents - inv.discountCents);
  });

  it('cannot confirm beyond available stock', () => {
    stockPacks(500, 500);
    const { id } = createInvoice(tt.ownerCtx, invoiceInput()); // needs 2000
    expect(() => confirmInvoice(tt.ownerCtx, id)).toThrow(/Not enough available/);
  });

  it('credit limit blocks confirmation without override', () => {
    stockPacks(3000, 0);
    // 2000 x 80 * 1.15 = 184,000 ETB < 200,000 limit -> first sale OK
    const { id: first } = createInvoice(tt.ownerCtx, invoiceInput());
    confirmInvoice(tt.ownerCtx, first);
    // second sale pushes outstanding past the limit
    const { id: second } = createInvoice(
      tt.ownerCtx,
      invoiceInput({
        lines: [
          { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 500, entryUomId: tt.uoms.piece },
        ],
      }),
    );
    expect(() => confirmInvoice(tt.ownerCtx, second)).toThrow(/credit limit/);
    confirmInvoice(tt.ownerCtx, second, { creditOverride: true });
    expect(getInvoice(tt.ownerCtx, second).status).toBe('confirmed');
  });

  it('cancel releases reservations; blocked once payments applied', () => {
    stockPacks();
    const { id } = createInvoice(tt.ownerCtx, invoiceInput());
    confirmInvoice(tt.ownerCtx, id);
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(2000 * PC);
    cancelInvoice(tt.ownerCtx, id, 'customer withdrew');
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(0);
    expect(getInvoice(tt.ownerCtx, id).status).toBe('cancelled');
    expect(customerOutstanding(tt.ownerCtx, customerId)).toBe(0);

    const { id: id2 } = createInvoice(tt.ownerCtx, invoiceInput());
    confirmInvoice(tt.ownerCtx, id2);
    createPayment(
      tt.ownerCtx,
      {
        customerId,
        date: '2026-08-17',
        amount: 1000,
        method: 'cash',
        allocations: [{ invoiceId: id2, amount: 1000 }],
      },
      { post: true },
    );
    expect(() => cancelInvoice(tt.ownerCtx, id2, 'too late')).toThrow(/payments/);
  });
});

describe('deliveries', () => {
  function confirmedInvoice(): string {
    stockPacks();
    const { id } = createInvoice(tt.ownerCtx, invoiceInput());
    confirmInvoice(tt.ownerCtx, id);
    return id;
  }

  it('walks the full lifecycle and moves stock exactly at dispatch', () => {
    const invId = confirmedInvoice();
    const { id: delId, docNumber } = createDelivery(tt.ownerCtx, {
      invoiceId: invId,
      destination: 'Adigrat',
      truckNumber: 'ET-3-77210',
      driverName: 'Tesfay H.',
      driverPhone: '+251 911 000 404',
      expectedDate: '2099-12-31',
    });
    expect(docNumber).toBe('DEL-0001');
    markLoading(tt.ownerCtx, delId);
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(2000 * PC); // still reserved, not moved

    dispatchDelivery(tt.ownerCtx, delId);
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(0);
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(0);
    expect(getInvoice(tt.ownerCtx, invId).status).toBe('dispatched');

    markDelivered(tt.ownerCtx, delId, { actualDate: nowIso().slice(0, 10), receivedBy: 'Shop Manager' });
    expect(getDelivery(tt.ownerCtx, delId).status).toBe('delivered');
    expect(getInvoice(tt.ownerCtx, invId).status).toBe('completed');
  });

  it('requires complete delivery details at creation for factory deliveries', () => {
    const invId = confirmedInvoice();
    // missing destination
    expect(() =>
      createDelivery(tt.ownerCtx, {
        invoiceId: invId,
        truckNumber: 'T-1',
        driverName: 'D',
        driverPhone: '1',
        expectedDate: '2099-12-31',
      }),
    ).toThrow(/Destination/);
    // missing expected date
    expect(() =>
      createDelivery(tt.ownerCtx, {
        invoiceId: invId,
        destination: 'Mekelle',
        truckNumber: 'T-1',
        driverName: 'D',
        driverPhone: '1',
      }),
    ).toThrow(/Expected delivery date/);
    // expected date in the past
    expect(() =>
      createDelivery(tt.ownerCtx, {
        invoiceId: invId,
        destination: 'Mekelle',
        truckNumber: 'T-1',
        driverName: 'D',
        driverPhone: '1',
        expectedDate: '2020-01-01',
      }),
    ).toThrow(/before today/);
    // missing truck for a factory delivery
    expect(() =>
      createDelivery(tt.ownerCtx, {
        invoiceId: invId,
        destination: 'Mekelle',
        driverName: 'D',
        driverPhone: '1',
        expectedDate: '2099-12-31',
      }),
    ).toThrow(/Truck/);
    // pickup deliberately requires no truck/driver
    const { id: pickupId } = createDelivery(tt.ownerCtx, {
      invoiceId: invId,
      deliveryType: 'pickup',
      destination: 'Factory gate',
      expectedDate: '2099-12-31',
    });
    dispatchDelivery(tt.ownerCtx, pickupId);
  });

  it('blocks invalid status jumps, duplicate deliveries, and bad actual dates', () => {
    const invId = confirmedInvoice();
    const details = {
      invoiceId: invId,
      destination: 'Adigrat',
      truckNumber: 'T-1',
      driverName: 'D',
      driverPhone: '1',
      expectedDate: '2099-12-31',
    };
    const { id: delId } = createDelivery(tt.ownerCtx, details);
    expect(() => createDelivery(tt.ownerCtx, details)).toThrow(/already exists/);
    // delivered before dispatch = invalid transition
    expect(() =>
      markDelivered(tt.ownerCtx, delId, { actualDate: nowIso().slice(0, 10), receivedBy: 'X' }),
    ).toThrow(AppError);
    dispatchDelivery(tt.ownerCtx, delId);
    // actual delivery date cannot be in the future
    expect(() =>
      markDelivered(tt.ownerCtx, delId, { actualDate: '2099-12-30', receivedBy: 'X' }),
    ).toThrow(/future/);
    markDelivered(tt.ownerCtx, delId, { actualDate: nowIso().slice(0, 10), receivedBy: 'X' });
  });
});

describe('payments and credit', () => {
  function twoConfirmedInvoices(): [string, string] {
    stockPacks(3000, 3000);
    const { id: a } = createInvoice(tt.ownerCtx, invoiceInput()); // 184,000
    confirmInvoice(tt.ownerCtx, a);
    const { id: b } = createInvoice(
      tt.ownerCtx,
      invoiceInput({
        lines: [
          { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 100, entryUomId: tt.uoms.piece },
        ],
      }),
    ); // 100 x 80 x 1.15 = 9,200
    confirmInvoice(tt.ownerCtx, b, { creditOverride: true });
    return [a, b];
  }

  it('one payment allocates across multiple invoices with visible remainder', () => {
    const [a, b] = twoConfirmedInvoices();
    const { id: payId } = createPayment(
      tt.ownerCtx,
      {
        customerId,
        date: '2026-08-17',
        amount: 100_000,
        method: 'bank',
        referenceNumber: 'BNK-ALLOC-1',
        allocations: [
          { invoiceId: a, amount: 80_000 },
          { invoiceId: b, amount: 9_200 },
        ],
      },
      { post: true },
    );
    expect(invoicePaidCents(tt.ownerCtx, a)).toBe(80_000_00);
    expect(invoicePaidCents(tt.ownerCtx, b)).toBe(9_200_00);
    expect(allocatedCents(tt.ownerCtx, payId)).toBe(89_200_00);
    // unallocated remainder = 10,800 — apply it later
    applyAllocations(tt.ownerCtx, payId, [{ invoiceId: a, amount: 10_800 }]);
    expect(invoicePaidCents(tt.ownerCtx, a)).toBe(90_800_00);
    expect(allocatedCents(tt.ownerCtx, payId)).toBe(100_000_00);
  });

  it('blocks over-allocation of the invoice and of the payment', () => {
    const [a, b] = twoConfirmedInvoices();
    expect(() =>
      createPayment(
        tt.ownerCtx,
        {
          customerId,
          date: '2026-08-17',
          amount: 50_000,
          method: 'cash',
          allocations: [{ invoiceId: b, amount: 10_000 }], // invoice b total is 9,200
        },
        { post: true },
      ),
    ).toThrow(/open balance/);
    expect(() =>
      createPayment(
        tt.ownerCtx,
        {
          customerId,
          date: '2026-08-17',
          amount: 5_000,
          method: 'cash',
          allocations: [{ invoiceId: a, amount: 6_000 }],
        },
        { post: true },
      ),
    ).toThrow(/exceed the payment/);
  });

  it('rejects allocations to another customer’s invoice', () => {
    const [a] = twoConfirmedInvoices();
    const otherCustomer = createParty(tt.ownerCtx, { kind: 'customer', name: 'Other Shop' });
    expect(() =>
      createPayment(
        tt.ownerCtx,
        {
          customerId: otherCustomer,
          date: '2026-08-17',
          amount: 1_000,
          method: 'cash',
          allocations: [{ invoiceId: a, amount: 1_000 }],
        },
        { post: true },
      ),
    ).toThrow(/different customer/);
  });

  it('reversal restores invoice balances through linked events', () => {
    const [a] = twoConfirmedInvoices();
    const { id: payId } = createPayment(
      tt.ownerCtx,
      {
        customerId,
        date: '2026-08-17',
        amount: 50_000,
        method: 'bank',
        referenceNumber: 'BNK-REV-1',
        allocations: [{ invoiceId: a, amount: 50_000 }],
      },
      { post: true },
    );
    expect(invoicePaidCents(tt.ownerCtx, a)).toBe(50_000_00);
    reversePayment(tt.ownerCtx, payId, 'bounced transfer');
    expect(invoicePaidCents(tt.ownerCtx, a)).toBe(0);
    expect(getPayment(tt.ownerCtx, payId).status).toBe('reversed');
  });

  it('derives credit statuses: active, partial, paid, overdue', () => {
    const [a, b] = twoConfirmedInvoices();
    // pay b fully; pay a partially
    createPayment(
      tt.ownerCtx,
      {
        customerId,
        date: '2026-08-17',
        amount: 60_000,
        method: 'cash',
        allocations: [
          { invoiceId: b, amount: 9_200 },
          { invoiceId: a, amount: 50_000 },
        ],
      },
      { post: true },
    );
    // Pinned inside the fixture's credit window (sale 2026-08-17, due 2026-08-31)
    // so 'partial' stays 'partial' instead of ageing into 'overdue' as real time
    // passes — the same fixed-date discipline the overdue assertion below uses.
    const overview = creditOverview(tt.ownerCtx, {}, '2026-08-20');
    const rowA = overview.rows.find((r) => r.invoiceId === a)!;
    const rowB = overview.rows.find((r) => r.invoiceId === b)!;
    expect(rowB.status).toBe('paid');
    expect(rowA.status).toBe('partial');
    expect(rowA.remainingCents).toBe(134_000_00);
    expect(overview.outstandingCents).toBe(134_000_00);

    // overdue: past-due date with remaining balance
    const inv = getInvoice(tt.ownerCtx, a);
    expect(invoiceCreditStatus(inv, invoicePaidCents(tt.ownerCtx, a), '2026-09-15')).toBe('overdue');
  });
});
