import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import { createParty } from '../src/services/parties.js';
import { saveSettings } from '../src/services/settings.js';
import { createLot, postMovement, getReserved, getAvailable, listReservationsForDocument } from '../src/services/inventory.js';
import {
  createOrder,
  confirmOrder,
  createInvoiceFromOrder,
  cancelOrder,
  getOrder,
  listOrderLines,
  listOrders,
  listInvoicesForOrder,
  type CreateOrderInput,
} from '../src/services/orders.js';
import { createInvoice, confirmInvoice, getInvoice, listInvoiceLines } from '../src/services/sales.js';
import { applySyncOp } from '../src/services/syncops.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import type { Ctx } from '../src/services/context.js';
import { AppError } from '../src/util.js';

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

function orderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    customerId,
    date: '2026-08-20',
    priceCategory: 'wholesale',
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

describe('order drafting', () => {
  it('prices from the list, applies configured VAT and numbers the document', () => {
    const { docNumber, totalCents } = createOrder(tt.ownerCtx, orderInput());
    // 2000 packs x 80 ETB = 160,000; VAT 15% = 24,000; total 184,000
    expect(docNumber).toBe('ORD-0001');
    expect(totalCents).toBe(184_000_00);
    const second = createOrder(tt.ownerCtx, orderInput());
    expect(second.docNumber).toBe('ORD-0002');
  });

  it('freezes the price snapshot on the lines and stays a draft with no reservation', () => {
    const { id } = createOrder(tt.ownerCtx, orderInput());
    const order = getOrder(tt.ownerCtx, id);
    expect(order.status).toBe('draft');
    expect(order.channel).toBe('standard');
    const lines = listOrderLines(tt.ownerCtx, id);
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceCents).toBe(80_00);
    expect(lines[0].qty).toBe(2000 * PC);
    expect(lines[0].qtyInvoiced).toBe(0);
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg)).toBe(0);
  });

  it('requires approval for custom prices and discounts (same gate as invoices)', () => {
    expect(() =>
      createOrder(
        tt.ownerCtx,
        orderInput({
          lines: [
            { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 10, entryUomId: tt.uoms.piece, unitPrice: 60 },
          ],
        }),
      ),
    ).toThrow(/authorized approval/);
    const ok = createOrder(
      tt.ownerCtx,
      orderInput({
        customApproved: true,
        lines: [
          { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 10, entryUomId: tt.uoms.piece, unitPrice: 60 },
        ],
      }),
    );
    expect(ok.totalCents).toBe(Math.round(10 * 60_00 * 1.15));
  });

  it('rejects hostile line quantities and malformed dates at the shared funnels', () => {
    for (const badQty of [true, '5', NaN, Infinity, -3, 0, [] as unknown]) {
      expect(() =>
        createOrder(
          tt.ownerCtx,
          orderInput({
            lines: [
              {
                itemId: tt.items.pack1kg,
                warehouseId: tt.warehouses.b,
                qty: badQty as number,
                entryUomId: tt.uoms.piece,
              },
            ],
          }),
        ),
      ).toThrow(AppError);
    }
    expect(() => createOrder(tt.ownerCtx, orderInput({ date: '20-08-2026' }))).toThrow(/calendar date/);
    expect(() => createOrder(tt.ownerCtx, orderInput({ expectedDate: 'soon' }))).toThrow(/calendar date/);
    expect(() => createOrder(tt.ownerCtx, orderInput({ date: '2026-02-30' }))).toThrow(/real calendar date/);
  });
});

describe('order confirmation (stock commitment)', () => {
  it('reserves the full quantity so no other document can consume it', () => {
    stockPacks();
    const { id } = createOrder(tt.ownerCtx, orderInput({ lines: [
      { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 1500, entryUomId: tt.uoms.piece },
    ] }));
    confirmOrder(tt.ownerCtx, id);
    expect(getOrder(tt.ownerCtx, id).status).toBe('confirmed');
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(1500 * PC);
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(500 * PC);

    // A DIRECT invoice for more than the free remainder must fail — the
    // order's reserved stock is untouchable (R4 stock/concurrency invariant).
    const bigInvoice = createInvoice(tt.ownerCtx, {
      customerId,
      date: '2026-08-21',
      priceCategory: 'wholesale',
      paymentTerm: 'paid',
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 1000, entryUomId: tt.uoms.piece }],
    });
    expect(() => confirmInvoice(tt.ownerCtx, bigInvoice.id)).toThrow(/Not enough available/);
    // ...while the free remainder is still sellable
    const smallInvoice = createInvoice(tt.ownerCtx, {
      customerId,
      date: '2026-08-21',
      priceCategory: 'wholesale',
      paymentTerm: 'paid',
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 500, entryUomId: tt.uoms.piece }],
    });
    confirmInvoice(tt.ownerCtx, smallInvoice.id);
    expect(getAvailable(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(0);
  });

  it('rolls back atomically when any line cannot be covered', () => {
    stockPacks(1000, 1000); // 2000 packs available
    const { id } = createOrder(
      tt.ownerCtx,
      orderInput({
        lines: [
          { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 1000, entryUomId: tt.uoms.piece },
          { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 1500, entryUomId: tt.uoms.piece },
        ],
      }),
    );
    expect(() => confirmOrder(tt.ownerCtx, id)).toThrow(/Not enough available/);
    // the first line's reservation must NOT survive the failed confirmation
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg)).toBe(0);
    expect(getOrder(tt.ownerCtx, id).status).toBe('draft');
  });

  it('only a draft can be confirmed', () => {
    stockPacks();
    const { id } = createOrder(tt.ownerCtx, orderInput());
    confirmOrder(tt.ownerCtx, id);
    expect(() => confirmOrder(tt.ownerCtx, id)).toThrow(/already processed/);
  });
});

describe('invoicing an order (fulfilment)', () => {
  it('carries the full order to a confirmed invoice atomically', () => {
    stockPacks();
    const { id, totalCents } = createOrder(tt.ownerCtx, orderInput());
    confirmOrder(tt.ownerCtx, id);
    const inv = createInvoiceFromOrder(tt.ownerCtx, id, { paymentTerm: 'paid', date: '2026-08-22' });
    // money carried exactly: same frozen prices, same VAT config
    expect(inv.totalCents).toBe(totalCents);
    const invoice = getInvoice(tt.ownerCtx, inv.invoiceId);
    expect(invoice.status).toBe('confirmed');
    expect(invoice.orderId).toBe(id);
    expect(getOrder(tt.ownerCtx, id).status).toBe('fulfilled');
    expect(listOrderLines(tt.ownerCtx, id)[0].qtyInvoiced).toBe(2000 * PC);
    expect(listInvoicesForOrder(tt.ownerCtx, id).map((i) => i.id)).toEqual([inv.invoiceId]);
    // the stock commitment moved from the order to the invoice — total
    // reserved is unchanged and the order holds nothing anymore
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(2000 * PC);
    const orderRes = listReservationsForDocument(tt.ownerCtx, 'sales_order', id);
    expect(orderRes.length).toBeGreaterThan(0);
    expect(orderRes.every((r) => r.status !== 'active')).toBe(true);
    const invRes = listReservationsForDocument(tt.ownerCtx, 'sales_invoice', inv.invoiceId);
    expect(invRes.some((r) => r.status === 'active')).toBe(true);
  });

  it('supports partial fulfilment with exact cumulative discount carry-over', () => {
    stockPacks();
    const { id } = createOrder(
      tt.ownerCtx,
      orderInput({
        customApproved: true,
        lines: [
          {
            itemId: tt.items.pack1kg,
            warehouseId: tt.warehouses.b,
            qty: 3,
            entryUomId: tt.uoms.piece,
            discount: 1, // 100 cents across 3 packs — indivisible
          },
        ],
      }),
    );
    confirmOrder(tt.ownerCtx, id);
    const lineId = listOrderLines(tt.ownerCtx, id)[0].id;

    const inv1 = createInvoiceFromOrder(tt.ownerCtx, id, {
      paymentTerm: 'paid',
      lines: [{ orderLineId: lineId, qty: 1 }],
    });
    expect(getOrder(tt.ownerCtx, id).status).toBe('partially_fulfilled');
    expect(listOrderLines(tt.ownerCtx, id)[0].qtyInvoiced).toBe(1 * PC);
    // order still holds the un-invoiced remainder
    expect(
      listReservationsForDocument(tt.ownerCtx, 'sales_order', id)
        .filter((r) => r.status === 'active')
        .reduce((s, r) => s + r.qty, 0),
    ).toBe(2 * PC);

    const inv2 = createInvoiceFromOrder(tt.ownerCtx, id, {
      paymentTerm: 'paid',
      lines: [{ orderLineId: lineId, qty: 1 }],
    });
    const inv3 = createInvoiceFromOrder(tt.ownerCtx, id, {
      paymentTerm: 'paid',
      lines: [{ orderLineId: lineId, qty: 1 }],
    });
    expect(getOrder(tt.ownerCtx, id).status).toBe('fulfilled');

    // Σ invoice discounts equals the order discount EXACTLY (33+34+33 = 100)
    const discounts = [inv1, inv2, inv3].map((v) =>
      listInvoiceLines(tt.ownerCtx, v.invoiceId).reduce((s, l) => s + l.discountCents, 0),
    );
    expect(discounts.reduce((a, b) => a + b, 0)).toBe(100);
    // and each invoice's money is exact: (80.00 - its discount slice) + 15% VAT
    expect([inv1.totalCents, inv2.totalCents, inv3.totalCents]).toEqual([
      Math.round((80_00 - 33) * 1.15),
      Math.round((80_00 - 34) * 1.15),
      Math.round((80_00 - 33) * 1.15),
    ]);
  });

  it('rejects over-invoicing, drafts, cancelled orders and duplicate line selections', () => {
    stockPacks();
    const { id } = createOrder(tt.ownerCtx, orderInput());
    expect(() => createInvoiceFromOrder(tt.ownerCtx, id, { paymentTerm: 'paid' })).toThrow(/confirmed order/);
    confirmOrder(tt.ownerCtx, id);
    const lineId = listOrderLines(tt.ownerCtx, id)[0].id;
    expect(() =>
      createInvoiceFromOrder(tt.ownerCtx, id, { paymentTerm: 'paid', lines: [{ orderLineId: lineId, qty: 2500 }] }),
    ).toThrow(/more than remains/);
    expect(() =>
      createInvoiceFromOrder(tt.ownerCtx, id, {
        paymentTerm: 'paid',
        lines: [
          { orderLineId: lineId, qty: 1 },
          { orderLineId: lineId, qty: 1 },
        ],
      }),
    ).toThrow(/selected twice/);
    createInvoiceFromOrder(tt.ownerCtx, id, { paymentTerm: 'paid' });
    expect(() => createInvoiceFromOrder(tt.ownerCtx, id, { paymentTerm: 'paid' })).toThrow(
      /confirmed order|fully invoiced/,
    );
  });

  it('enforces the credit limit at invoicing, with an explicit override', () => {
    stockPacks(2000, 2000);
    const o1 = createOrder(tt.ownerCtx, orderInput()); // 184,000 ETB
    confirmOrder(tt.ownerCtx, o1.id);
    createInvoiceFromOrder(tt.ownerCtx, o1.id, { paymentTerm: 'credit', dueDate: '2026-09-30' });

    const o2 = createOrder(tt.ownerCtx, orderInput()); // would exceed the 200,000 limit
    confirmOrder(tt.ownerCtx, o2.id);
    expect(() =>
      createInvoiceFromOrder(tt.ownerCtx, o2.id, { paymentTerm: 'credit', dueDate: '2026-09-30' }),
    ).toThrow(/credit limit/);
    // an authorized override still works (route gates it behind credit.approve)
    const inv2 = createInvoiceFromOrder(tt.ownerCtx, o2.id, {
      paymentTerm: 'credit',
      dueDate: '2026-09-30',
      creditOverride: true,
    });
    expect(getInvoice(tt.ownerCtx, inv2.invoiceId).status).toBe('confirmed');
  });

  it('a failed conversion leaves the order commitment fully intact (atomicity)', () => {
    stockPacks();
    const { id } = createOrder(tt.ownerCtx, orderInput());
    confirmOrder(tt.ownerCtx, id);
    // paymentTerm credit without a due date → the invoice creation rejects
    expect(() => createInvoiceFromOrder(tt.ownerCtx, id, { paymentTerm: 'credit' })).toThrow(/due date/);
    expect(getOrder(tt.ownerCtx, id).status).toBe('confirmed');
    expect(listOrderLines(tt.ownerCtx, id)[0].qtyInvoiced).toBe(0);
    expect(
      listReservationsForDocument(tt.ownerCtx, 'sales_order', id)
        .filter((r) => r.status === 'active')
        .reduce((s, r) => s + r.qty, 0),
    ).toBe(2000 * PC);
    expect(listInvoicesForOrder(tt.ownerCtx, id)).toHaveLength(0);
  });
});

describe('order cancellation', () => {
  it('releases every reservation and requires a reason', () => {
    stockPacks();
    const { id } = createOrder(tt.ownerCtx, orderInput());
    confirmOrder(tt.ownerCtx, id);
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg)).toBe(2000 * PC);
    expect(() => cancelOrder(tt.ownerCtx, id, '')).toThrow(/required/);
    cancelOrder(tt.ownerCtx, id, 'Customer withdrew');
    expect(getOrder(tt.ownerCtx, id).status).toBe('cancelled');
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg)).toBe(0);
  });

  it('cancelling a partially fulfilled order releases only the remainder; invoices stand', () => {
    stockPacks();
    const { id } = createOrder(tt.ownerCtx, orderInput());
    confirmOrder(tt.ownerCtx, id);
    const lineId = listOrderLines(tt.ownerCtx, id)[0].id;
    const inv = createInvoiceFromOrder(tt.ownerCtx, id, {
      paymentTerm: 'paid',
      lines: [{ orderLineId: lineId, qty: 500 }],
    });
    cancelOrder(tt.ownerCtx, id, 'Remainder no longer needed');
    expect(getOrder(tt.ownerCtx, id).status).toBe('cancelled');
    // the invoice keeps ITS reservation; the order's remainder is free again
    expect(getReserved(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(500 * PC);
    expect(getInvoice(tt.ownerCtx, inv.invoiceId).status).toBe('confirmed');
    // and a fulfilled/cancelled order cannot be cancelled (again)
    expect(() => cancelOrder(tt.ownerCtx, id, 'again')).toThrow(/cannot be cancelled/);
  });
});

describe('tenant isolation and identifier non-leakage', () => {
  it('another tenant and a nonexistent id fail identically', () => {
    const { id } = createOrder(tt.ownerCtx, orderInput());
    const other = makeTestTenant(db, 'SALTB');
    const errors: string[] = [];
    for (const probe of [id, 'does-not-exist']) {
      try {
        getOrder(other.ownerCtx, probe);
      } catch (e) {
        errors.push((e as AppError).message);
      }
    }
    expect(errors).toEqual(['Order not found', 'Order not found']);
    expect(listOrders(other.ownerCtx)).toHaveLength(0);
    expect(listOrders(tt.ownerCtx)).toHaveLength(1);
  });
});

describe('offline idempotent order capture (order.create sync op)', () => {
  it('applies once and returns the recorded outcome on replay', () => {
    const payload = orderInput();
    const first = applySyncOp(tt.ownerCtx, { opKey: 'op-order-1', opType: 'order.create', payload });
    expect(first.status).toBe('applied');
    expect(first.duplicate).toBe(false);
    const replay = applySyncOp(tt.ownerCtx, { opKey: 'op-order-1', opType: 'order.create', payload });
    expect(replay.status).toBe('applied');
    expect(replay.duplicate).toBe(true);
    expect(replay.resultRef).toBe(first.resultRef);
    expect(listOrders(tt.ownerCtx)).toHaveLength(1); // never double-created
  });

  it('never trusts a client-supplied approval flag for custom prices', () => {
    // a seller who may create but not approve custom prices
    const roleId = createRole(tt.sysCtx, {
      code: 'seller',
      name: 'Seller',
      matrix: matrixOf([['sales', ['view', 'create']]]),
    });
    const userId = createUser(tt.sysCtx, {
      username: 'seller.salta',
      displayName: 'Seller',
      password: 'test-password',
      roleId,
    });
    const sellerCtx: Ctx = { db, tenantId: tt.tenantId, user: buildSessionUser(db, userId)! };
    const payload = orderInput({
      customApproved: true, // hostile: replayed device claims approval
      lines: [
        { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 10, entryUomId: tt.uoms.piece, unitPrice: 1 },
      ],
    });
    const res = applySyncOp(sellerCtx, { opKey: 'op-order-2', opType: 'order.create', payload });
    expect(res.status).toBe('rejected');
    expect(listOrders(tt.ownerCtx)).toHaveLength(0);
    // a list-price order from the same seller applies fine
    const ok = applySyncOp(sellerCtx, { opKey: 'op-order-3', opType: 'order.create', payload: orderInput() });
    expect(ok.status).toBe('applied');
  });
});
