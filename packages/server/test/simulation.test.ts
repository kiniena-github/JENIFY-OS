import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MOVEMENT_TYPES } from '@factoryos/shared';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, type TestTenant } from './helpers.js';
import type { Ctx } from '../src/services/context.js';
import { AppError, nowIso } from '../src/util.js';
import { stockBalances, stockMovements } from '../src/db/schema.js';

import { createParty } from '../src/services/parties.js';
import { saveSettings } from '../src/services/settings.js';
import { createReceipt, postReceipt, reverseReceipt, getReceipt } from '../src/services/receiving.js';
import { createTransfer, postTransfer } from '../src/services/transfers.js';
import {
  createBatch,
  startBatch,
  completeBatch,
  recordQualityTest,
  approveQualityTest,
  getBatch,
} from '../src/services/batches.js';
import {
  createInvoice,
  confirmInvoice,
  cancelInvoice,
  getInvoice,
  listInvoices,
  invoicePaidCents,
  customerOutstanding,
} from '../src/services/sales.js';
import {
  createDelivery,
  markLoading,
  dispatchDelivery,
  markDelivered,
} from '../src/services/deliveries.js';
import {
  createPayment,
  reversePayment,
  applyAllocations,
  getPayment,
} from '../src/services/payments.js';
import { creditOverview } from '../src/services/creditview.js';
import { recomputeBalances, getOnHand, getAvailable, getReserved } from '../src/services/inventory.js';
import { salesReport, rawStockReport, productionReport, finishedInventoryReport } from '../src/services/reports.js';
import { listAudit } from '../src/services/audit.js';

/**
 * ============================================================================
 * MULTI-BUSINESS SIMULATION LAB  (mission §38)  — persistent regression asset
 * ============================================================================
 *
 * This is NOT a single happy transaction. Each profile below drives the REAL
 * services through a realistic operational PERIOD ("days"), deliberately mixing
 * the non-happy paths the mission calls out:
 *
 *   - a mistake + reversal            (post a wrong receipt, then reverse it)
 *   - a stock shortage blocking a sale (oversell is rejected, invoice cancelled)
 *   - a credit-limit block            (over-limit sale rejected, then overridden)
 *   - a payment reversal restoring the customer balance
 *   - a partial delivery              (order-level; single-invoice split = GAP)
 *   - a return / credit note          (NOT SUPPORTED — surfaced as a real GAP)
 *
 * After the run every profile asserts the books stay consistent (invariants):
 *   I1  stock balance  == Σ posted movements (independently recomputed)
 *   I2  no negative stock balances
 *   I3  customer outstanding == Σ committed-invoice totals − Σ active allocations
 *   I4  credit overview outstanding == Σ per-customer outstanding
 *   I5  audit events exist for every mutation (asserted per action code)
 *   I6  a reversed payment is not allocatable and does not count as paid
 *
 * Determinism: fixed quantities, fixed prices, no randomness. Dates are derived
 * relative to run time (nowIso) only where a service enforces a date window
 * (deliveries), so the suite is stable on any calendar day.
 */

const TODAY = nowIso().slice(0, 10);
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
// Logical "day" labels for document dates — free-form, used for reporting order.
const D = (n: number) => `2026-08-0${n}`;

// ---------------------------------------------------------------------------
// Shared invariant helpers — reused by both business profiles
// ---------------------------------------------------------------------------

/** I1 + I2: every cached balance equals the ledger sum, and none is negative. */
function assertLedgerConsistent(ctx: Ctx, label: string): void {
  // The repair pass reports ZERO discrepancies on a healthy ledger.
  expect(recomputeBalances(ctx), `${label}: cached balance drifted from the ledger`).toEqual([]);

  // Independent recomputation straight from the append-only movement ledger.
  const movements = ctx.db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.tenantId, ctx.tenantId))
    .all();
  const ledger = new Map<string, number>();
  for (const m of movements) {
    const key = `${m.itemId}|${m.lotId ?? ''}|${m.warehouseId}`;
    ledger.set(key, (ledger.get(key) ?? 0) + m.qty);
  }
  const balances = ctx.db
    .select()
    .from(stockBalances)
    .where(eq(stockBalances.tenantId, ctx.tenantId))
    .all();
  const seen = new Set<string>();
  for (const b of balances) {
    const key = `${b.itemId}|${b.lotId ?? ''}|${b.warehouseId}`;
    seen.add(key);
    expect(b.qtyOnHand, `${label}: balance != Σ movements @ ${key}`).toBe(ledger.get(key) ?? 0);
    expect(b.qtyOnHand, `${label}: NEGATIVE balance @ ${key}`).toBeGreaterThanOrEqual(0);
  }
  // Any movement key that never produced a balance row must net to zero.
  for (const [key, sum] of ledger) {
    if (!seen.has(key)) expect(sum, `${label}: ledger key without balance @ ${key}`).toBe(0);
  }
}

/** I3: customer outstanding equals invoices − active allocations, independently. */
function assertOutstanding(ctx: Ctx, customerId: string, label: string): number {
  const committed = listInvoices(ctx, { customerId }).filter((i) =>
    ['confirmed', 'dispatched', 'completed'].includes(i.status),
  );
  const manual = committed.reduce(
    (s, inv) => s + Math.max(0, inv.totalCents - invoicePaidCents(ctx, inv.id)),
    0,
  );
  expect(customerOutstanding(ctx, customerId), `${label}: outstanding mismatch`).toBe(manual);
  return manual;
}

/** I5: assert an audit trail row exists for each mutation action code. */
function assertAudited(ctx: Ctx, actions: string[], label: string): void {
  for (const action of actions) {
    const found = listAudit(ctx, { action, limit: 5 });
    expect(found.count, `${label}: no audit event for '${action}'`).toBeGreaterThan(0);
  }
}

/** Run `fn` and require it to throw an AppError carrying the given machine code. */
function expectAppError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected an AppError('${code}')`).toBeInstanceOf(AppError);
  expect((thrown as AppError).code, `expected AppError code '${code}'`).toBe(code);
}

// ===========================================================================
// PROFILE A — Mesob-style PROCESS FACTORY (receive → wash → iodize/QC → pack →
// sell → deliver → collect). Exercises production, reservations, QC gate and
// the full commercial tail.
// ===========================================================================

describe('§38 simulation — Profile A: process manufacturing factory', () => {
  let db: Db;
  let tt: TestTenant;
  const s = {
    supplier: '',
    north: '', // big credit line
    smallShop: '', // tight credit line
    lot1: '',
    goodReceipt: '',
    washId: '',
    iodId: '',
    invA1: '',
    invSmall: '',
    payReversed: '',
  };

  beforeAll(() => {
    db = testDb();
    tt = makeTestTenant(db, 'SIMFAC');
    makeProcessStages(tt);
    const ctx = tt.ownerCtx;
    s.supplier = createParty(ctx, { kind: 'supplier', name: 'Afdera Salt Source' });
    s.north = createParty(ctx, { kind: 'customer', name: 'North Wholesale', creditLimit: 10_000_000 });
    s.smallShop = createParty(ctx, { kind: 'customer', name: 'Corner Shop', creditLimit: 500 });
    saveSettings(ctx, 'pricing', {
      categories: ['wholesale'],
      prices: { [tt.items.pack1kg]: { wholesale: 80 } },
    });
    saveSettings(ctx, 'vat', { enabled: true, ratePct: 15 });
  });

  it('Day 1 — receives two raw lots and balances warehouses by transfer', () => {
    const ctx = tt.ownerCtx;
    const r1 = createReceipt(ctx, {
      supplierId: s.supplier,
      source: 'Afdera',
      date: D(1),
      itemId: tt.items.raw,
      entryUomId: tt.uoms.ton,
      grossQty: 10.2,
      netQty: 10,
      warehouseId: tt.warehouses.a,
    });
    postReceipt(ctx, r1.id);
    s.lot1 = getReceipt(ctx, r1.id).lotId!;

    const r2 = createReceipt(ctx, {
      supplierId: s.supplier,
      date: D(1),
      itemId: tt.items.raw,
      entryUomId: tt.uoms.ton,
      netQty: 6,
      warehouseId: tt.warehouses.a,
    });
    postReceipt(ctx, r2.id);

    // move 4 t of lot1 A -> B (factory total is unchanged by construction)
    const trf = createTransfer(ctx, {
      itemId: tt.items.raw,
      lotId: s.lot1,
      entryUomId: tt.uoms.ton,
      qty: 4,
      fromWarehouseId: tt.warehouses.a,
      toWarehouseId: tt.warehouses.b,
      date: D(1),
      reason: 'Feed production line B',
    });
    postTransfer(ctx, trf.id);

    expect(getOnHand(ctx, tt.items.raw)).toBe(16_000_000); // 10t + 6t
    expect(getOnHand(ctx, tt.items.raw, tt.warehouses.b, s.lot1)).toBe(4_000_000);
  });

  it('Day 2 — a mistaken receipt is posted then REVERSED (mistake + reversal)', () => {
    const ctx = tt.ownerCtx;
    const before = getOnHand(ctx, tt.items.raw);
    const wrong = createReceipt(ctx, {
      supplierId: s.supplier,
      date: D(2),
      itemId: tt.items.raw,
      entryUomId: tt.uoms.ton,
      netQty: 2, // wrong truck logged against us
      warehouseId: tt.warehouses.a,
    });
    postReceipt(ctx, wrong.id);
    s.goodReceipt = wrong.id;
    expect(getOnHand(ctx, tt.items.raw)).toBe(before + 2_000_000);

    reverseReceipt(ctx, wrong.id, 'Truck belonged to another buyer — logged in error');
    expect(getReceipt(ctx, wrong.id).lifecycle).toBe('reversed');
    // Stock is restored EXACTLY; history keeps both the +2t and the −2t rows.
    expect(getOnHand(ctx, tt.items.raw)).toBe(before);
  });

  it('Day 3 — production: wash (loss) → iodize (QC fail→retest→pass) → package', () => {
    const ctx = tt.ownerCtx;
    // washing: 5 t of lot1 from A, 400 kg process loss
    const wash = createBatch(ctx, {
      stageCode: 'washing',
      date: D(3),
      inputLotId: s.lot1,
      inputWarehouseId: tt.warehouses.a,
      inputQty: 5000,
      inputUomId: tt.uoms.kg,
    });
    s.washId = wash.id;
    startBatch(ctx, wash.id); // reserves the raw quantity (in-process)
    expect(getReserved(ctx, tt.items.raw, tt.warehouses.a, s.lot1)).toBe(5_000_000);
    completeBatch(ctx, wash.id, { outputQty: 4600 });
    expect(getBatch(ctx, wash.id).lossQty).toBe(400_000);

    // iodization: conserved stage, records iodine, then QC gate
    const iod = createBatch(ctx, {
      stageCode: 'iodization',
      date: D(3),
      inputBatchId: wash.id,
      inputBatchQty: 4600,
      attributes: { iodine_added_kg: 0.2 },
    });
    s.iodId = iod.id;
    completeBatch(ctx, iod.id, {});
    recordQualityTest(ctx, iod.id, {
      targetLevel: '30-40 ppm',
      actualResult: '22 ppm',
      status: 'failed',
      date: D(3),
    });
    // downstream packaging is blocked while QC is unresolved
    expectAppError(
      () =>
        createBatch(ctx, {
          stageCode: 'packaging',
          date: D(3),
          inputBatchId: iod.id,
          inputBatchQty: 1000,
        }),
      'qc_gate',
    );
    recordQualityTest(ctx, iod.id, {
      targetLevel: '30-40 ppm',
      actualResult: '34 ppm',
      status: 'passed',
      date: D(3),
    });
    approveQualityTest(ctx, iod.id);
    expect(getBatch(ctx, iod.id).qcStatus).toBe('passed');

    // packaging: 4000 kg -> 3980 packs produced, 20 rejected => 3960 good into B
    const pkg = createBatch(ctx, {
      stageCode: 'packaging',
      date: D(3),
      inputBatchId: iod.id,
      inputBatchQty: 4000,
    });
    completeBatch(ctx, pkg.id, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 3980,
      unitsRejected: 20,
      outputWarehouseId: tt.warehouses.b,
    });
    expect(getOnHand(ctx, tt.items.pack1kg, tt.warehouses.b)).toBe(3_960_000);
  });

  it('Day 4 — sales: confirm a big order; oversell BLOCKED; credit-limit BLOCKED then overridden', () => {
    const ctx = tt.ownerCtx;
    // A1: 2000 packs to North (well within its credit line)
    const a1 = createInvoice(ctx, {
      customerId: s.north,
      date: D(4),
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: future(30),
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 2000, entryUomId: tt.uoms.piece }],
    });
    s.invA1 = a1.id;
    expect(a1.totalCents).toBe(18_400_000); // 184,000 ETB incl. 15% VAT
    confirmInvoice(ctx, a1.id);
    expect(getReserved(ctx, tt.items.pack1kg, tt.warehouses.b)).toBe(2_000_000);

    // NON-HAPPY: oversell — 5000 packs but only 1960 available -> confirm rejected
    const over = createInvoice(ctx, {
      customerId: s.north,
      date: D(4),
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: future(30),
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 5000, entryUomId: tt.uoms.piece }],
    });
    expectAppError(() => confirmInvoice(ctx, over.id), 'insufficient_available');
    expect(getInvoice(ctx, over.id).status).toBe('pending'); // no reservation leaked
    cancelInvoice(ctx, over.id, 'Oversell — insufficient finished stock');

    // NON-HAPPY: credit-limit — Corner Shop (500 ETB limit) buys 9,200 ETB -> blocked
    const small = createInvoice(ctx, {
      customerId: s.smallShop,
      date: D(4),
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: future(30),
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 100, entryUomId: tt.uoms.piece }],
    });
    s.invSmall = small.id;
    expectAppError(() => confirmInvoice(ctx, small.id), 'credit_limit');
    // authorized override lets it through (Founder policy: override, never bypass)
    confirmInvoice(ctx, small.id, { creditOverride: true });
    expect(getInvoice(ctx, small.id).status).toBe('confirmed');
  });

  it('Day 5 — delivery dispatches A1 (order-level PARTIAL fulfilment: small order held)', () => {
    const ctx = tt.ownerCtx;
    const del = createDelivery(ctx, {
      invoiceId: s.invA1,
      deliveryType: 'delivery',
      destination: 'Adigrat',
      truckNumber: 'ET-3-77210',
      driverName: 'Tesfay H.',
      driverPhone: '+251911000404',
      expectedDate: future(7),
    });
    markLoading(ctx, del.id);
    dispatchDelivery(ctx, del.id);
    markDelivered(ctx, del.id, { actualDate: TODAY, receivedBy: 'Shop Manager' });

    expect(getInvoice(ctx, s.invA1).status).toBe('completed');
    expect(getOnHand(ctx, tt.items.pack1kg, tt.warehouses.b)).toBe(1_960_000); // 3960 - 2000
    // The Corner Shop order (invSmall) stays confirmed & reserved — the overall
    // customer demand is only PARTIALLY fulfilled this period. (True per-invoice
    // split delivery is a documented capability GAP, see the gaps block below.)
    expect(getInvoice(ctx, s.invSmall).status).toBe('confirmed');
    expect(getReserved(ctx, tt.items.pack1kg, tt.warehouses.b)).toBe(100_000);
  });

  it('Day 6 — finance: partial pay, a PAYMENT REVERSAL restores balance, then settle', () => {
    const ctx = tt.ownerCtx;
    // p1: 100,000 ETB toward A1 (184,000) -> 84,000 outstanding
    createPayment(
      ctx,
      { customerId: s.north, date: D(6), amount: 100_000, method: 'cash', allocations: [{ invoiceId: s.invA1, amount: 100_000 }] },
      { post: true },
    );
    expect(customerOutstanding(ctx, s.north)).toBe(8_400_000);

    // p2: another 50,000 ETB posted & allocated -> 34,000 outstanding ...
    const p2 = createPayment(
      ctx,
      { customerId: s.north, date: D(6), amount: 50_000, method: 'cash', allocations: [{ invoiceId: s.invA1, amount: 50_000 }] },
      { post: true },
    );
    s.payReversed = p2.id;
    expect(customerOutstanding(ctx, s.north)).toBe(3_400_000);

    // ... then p2 is REVERSED (e.g. cheque bounced) -> balance restored to 84,000
    reversePayment(ctx, p2.id, 'Bank returned the deposit');
    expect(getPayment(ctx, p2.id).status).toBe('reversed');
    expect(customerOutstanding(ctx, s.north)).toBe(8_400_000);
    expect(invoicePaidCents(ctx, s.invA1)).toBe(10_000_000); // only p1 counts

    // I6: a reversed payment can no longer be allocated
    expectAppError(() => applyAllocations(ctx, p2.id, [{ invoiceId: s.invA1, amount: 1 }]), 'not_posted');

    // p3: settle the remaining 84,000 -> A1 fully paid
    createPayment(
      ctx,
      { customerId: s.north, date: D(6), amount: 84_000, method: 'cash', allocations: [{ invoiceId: s.invA1, amount: 84_000 }] },
      { post: true },
    );
    expect(customerOutstanding(ctx, s.north)).toBe(0);
    expect(invoicePaidCents(ctx, s.invA1)).toBe(18_400_000);
  });

  it('INVARIANTS — books stay consistent after the whole period', () => {
    const ctx = tt.ownerCtx;
    // I1 + I2
    assertLedgerConsistent(ctx, 'Profile A');

    // I3 — per customer, recomputed independently from source records
    assertOutstanding(ctx, s.north, 'Profile A/North'); // fully settled -> 0
    const smallOwed = assertOutstanding(ctx, s.smallShop, 'Profile A/Corner'); // 9,200 ETB open
    expect(smallOwed).toBe(920_000);

    // I4 — credit overview reconciles with the sum of customer balances
    const credit = creditOverview(ctx);
    expect(credit.outstandingCents).toBe(920_000);

    // I6 — the reversed payment is not counted anywhere as paid
    expect(invoicePaidCents(ctx, s.invA1)).toBe(18_400_000); // p1 + p3 only, not p2

    // Reports reconcile with the ledger. The window spans the logical document
    // days AND the real posting time — movement-based reports (dispatches, raw
    // usage) filter on the actual postedAt timestamp, not the document date.
    const period = { from: D(1), to: future(1) };
    const sales = salesReport(ctx, period);
    expect(sales.totalCents).toBe(18_400_000 + 920_000); // A1 + Corner order (both committed)
    expect(sales.cancelledCount).toBe(1); // the oversell attempt
    const raw = rawStockReport(ctx, period);
    expect(raw.receivedQty).toBe(16_000_000); // reversed mistake excluded from posted receipts
    const prod = productionReport(ctx, period);
    expect(prod.rawInputQty).toBe(5_000_000); // first stage unique input
    const fin = finishedInventoryReport(ctx, period);
    expect(fin.soldUnits).toBe(2_000_000);

    // I5 — every kind of mutation left an audit trail
    assertAudited(
      ctx,
      [
        'receipt_post',
        'receipt_reverse',
        'transfer_post',
        'batch_complete',
        'qc_test',
        'qc_approve',
        'invoice_confirm',
        'invoice_cancel',
        'delivery_dispatch',
        'payment_post',
        'payment_reverse',
      ],
      'Profile A',
    );
  });
});

// ===========================================================================
// PROFILE B — simple TRADING business (buy → sell on credit → deliver → collect).
// No production at all: proves the same core (stock ledger, reservations,
// credit, payments, deliveries) serves a very different business shape.
// ===========================================================================

describe('§38 simulation — Profile B: simple trading business', () => {
  let db: Db;
  let tt: TestTenant;
  const s = {
    supplier: '',
    bulk: '', // big credit line
    corner: '', // tight credit line
    invB1: '',
    invCorner: '',
    payReversed: '',
  };

  beforeAll(() => {
    db = testDb();
    tt = makeTestTenant(db, 'SIMTRD');
    const ctx = tt.ownerCtx;
    s.supplier = createParty(ctx, { kind: 'supplier', name: 'Import Depot' });
    s.bulk = createParty(ctx, { kind: 'customer', name: 'Bulk Buyer', creditLimit: 1_000_000 });
    s.corner = createParty(ctx, { kind: 'customer', name: 'Corner Store', creditLimit: 500 });
    // A trading business resells the goods it buys. `raw` is purchasable AND
    // sellable in the test tenant, so we trade it directly. No VAT configured.
    saveSettings(ctx, 'pricing', {
      categories: ['wholesale'],
      prices: { [tt.items.raw]: { wholesale: 25 } },
    });
  });

  it('Day 1 — buys stock into the shop (two lots received)', () => {
    const ctx = tt.ownerCtx;
    for (const netQty of [1000, 500]) {
      const r = createReceipt(ctx, {
        supplierId: s.supplier,
        date: D(1),
        itemId: tt.items.raw,
        entryUomId: tt.uoms.kg,
        netQty,
        warehouseId: tt.warehouses.a,
      });
      postReceipt(ctx, r.id);
    }
    expect(getOnHand(ctx, tt.items.raw, tt.warehouses.a)).toBe(1_500_000); // 1500 kg
  });

  it('Day 2 — sells on credit; oversell BLOCKED; credit-limit BLOCKED then overridden', () => {
    const ctx = tt.ownerCtx;
    // B1: 600 kg to Bulk Buyer (FIFO reserves from the first lot)
    const b1 = createInvoice(ctx, {
      customerId: s.bulk,
      date: D(2),
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: future(30),
      lines: [{ itemId: tt.items.raw, warehouseId: tt.warehouses.a, qty: 600, entryUomId: tt.uoms.kg }],
    });
    s.invB1 = b1.id;
    expect(b1.totalCents).toBe(1_500_000); // 15,000 ETB, no VAT
    confirmInvoice(ctx, b1.id);
    expect(getReserved(ctx, tt.items.raw, tt.warehouses.a)).toBe(600_000);

    // NON-HAPPY: oversell 2000 kg (only 900 kg available) -> rejected & cancelled
    const over = createInvoice(ctx, {
      customerId: s.bulk,
      date: D(2),
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: future(30),
      lines: [{ itemId: tt.items.raw, warehouseId: tt.warehouses.a, qty: 2000, entryUomId: tt.uoms.kg }],
    });
    expectAppError(() => confirmInvoice(ctx, over.id), 'insufficient_available');
    cancelInvoice(ctx, over.id, 'Not enough stock on hand');

    // NON-HAPPY: credit-limit — Corner Store (500 ETB) buys 7,500 ETB -> blocked then overridden
    const corner = createInvoice(ctx, {
      customerId: s.corner,
      date: D(2),
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: future(30),
      lines: [{ itemId: tt.items.raw, warehouseId: tt.warehouses.a, qty: 300, entryUomId: tt.uoms.kg }],
    });
    s.invCorner = corner.id;
    expectAppError(() => confirmInvoice(ctx, corner.id), 'credit_limit');
    confirmInvoice(ctx, corner.id, { creditOverride: true });
    expect(getReserved(ctx, tt.items.raw, tt.warehouses.a)).toBe(900_000); // 600 + 300
  });

  it('Day 3 — delivers the Bulk Buyer order (stock leaves the shop)', () => {
    const ctx = tt.ownerCtx;
    const del = createDelivery(ctx, {
      invoiceId: s.invB1,
      deliveryType: 'delivery',
      destination: 'Mekelle Market',
      truckNumber: 'ET-2-11002',
      driverName: 'Hailu B.',
      driverPhone: '+251911222333',
      expectedDate: future(5),
    });
    markLoading(ctx, del.id);
    dispatchDelivery(ctx, del.id);
    markDelivered(ctx, del.id, { actualDate: TODAY, receivedBy: 'Warehouse Keeper' });
    expect(getInvoice(ctx, s.invB1).status).toBe('completed');
    expect(getOnHand(ctx, tt.items.raw, tt.warehouses.a)).toBe(900_000); // 1500 - 600
    expect(getAvailable(ctx, tt.items.raw, tt.warehouses.a)).toBe(600_000); // 900 on hand - 300 reserved
  });

  it('Day 4 — collects: partial pay, PAYMENT REVERSAL restores balance, then settle', () => {
    const ctx = tt.ownerCtx;
    // partial 8,000 of 15,000
    const p1 = createPayment(
      ctx,
      { customerId: s.bulk, date: D(4), amount: 8_000, method: 'cash', allocations: [{ invoiceId: s.invB1, amount: 8_000 }] },
      { post: true },
    );
    s.payReversed = p1.id;
    expect(customerOutstanding(ctx, s.bulk)).toBe(700_000);

    // reversal restores the full balance and cannot be re-applied
    reversePayment(ctx, p1.id, 'Customer stopped the transfer');
    expect(customerOutstanding(ctx, s.bulk)).toBe(1_500_000);
    expectAppError(() => applyAllocations(ctx, p1.id, [{ invoiceId: s.invB1, amount: 1 }]), 'not_posted');

    // settle in full
    createPayment(
      ctx,
      { customerId: s.bulk, date: D(4), amount: 15_000, method: 'cash', allocations: [{ invoiceId: s.invB1, amount: 15_000 }] },
      { post: true },
    );
    expect(customerOutstanding(ctx, s.bulk)).toBe(0);
  });

  it('INVARIANTS — books stay consistent after the whole period', () => {
    const ctx = tt.ownerCtx;
    assertLedgerConsistent(ctx, 'Profile B');

    assertOutstanding(ctx, s.bulk, 'Profile B/Bulk'); // settled -> 0
    const cornerOwed = assertOutstanding(ctx, s.corner, 'Profile B/Corner');
    expect(cornerOwed).toBe(750_000); // 7,500 ETB open, never paid

    const credit = creditOverview(ctx);
    expect(credit.outstandingCents).toBe(750_000);

    expect(invoicePaidCents(ctx, s.invB1)).toBe(1_500_000); // reversed p1 excluded

    const sales = salesReport(ctx, { from: D(1), to: D(4) });
    expect(sales.totalCents).toBe(1_500_000 + 750_000);
    expect(sales.cancelledCount).toBe(1);

    assertAudited(
      ctx,
      [
        'receipt_post',
        'invoice_confirm',
        'invoice_cancel',
        'delivery_dispatch',
        'payment_post',
        'payment_reverse',
      ],
      'Profile B',
    );
  });
});

// ===========================================================================
// CAPABILITY GAPS surfaced by the simulation.
// These are HONEST holes in the platform found while driving a realistic
// period. We do NOT fake the missing flows — each is documented here so it
// surfaces in the test report and feeds the roadmap. Skipped bodies describe
// the contract the capability SHOULD satisfy once built.
// ===========================================================================

describe('§38 simulation — capability GAPS (roadmap feed)', () => {
  it('GAP #1 CLOSED — the ledger now has first-class return movement types', () => {
    // Closed 2026-08-22 (final-acceleration): sales returns/credit notes +
    // purchase returns are implemented (services/returns.ts) with dedicated
    // ledger movements, so restocked/returned goods reconcile on the ledger.
    expect(MOVEMENT_TYPES).toContain('sale_return');
    expect(MOVEMENT_TYPES).toContain('purchase_return');
  });

  // TODO(GAP #1 — SALES RETURN / CREDIT NOTE): after a delivery is completed
  // there is no service to accept returned goods, restock them, and issue a
  // credit note that REDUCES the customer's outstanding. `reversePayment`
  // reverses money, and `cancelInvoice` is refused once an invoice is
  // dispatched/completed — neither models a post-sale return. A real return
  // flow must: restock (new movement) → credit the invoice/customer → audit.
  it.skip('GAP #1: a completed sale can be returned & credit-noted (NOT SUPPORTED)', () => {
    // Desired contract once implemented, e.g.:
    //   const cn = createSalesReturn(ctx, { invoiceId, lines:[{itemId, warehouseId, qty}], reason });
    //   expect(getOnHand(ctx, itemId, warehouseId)).toBe(before + qty);        // restocked
    //   expect(customerOutstanding(ctx, customerId)).toBe(before - cn.creditCents); // credited
    //   assertLedgerConsistent(ctx, 'after return');                            // books still balance
  });

  // TODO(GAP #2 — PARTIAL / SPLIT DELIVERY OF ONE INVOICE): dispatchDelivery
  // ships ALL active reservations of an invoice at once and moves the invoice
  // straight to a terminal fulfilment state. There is no per-line / partial
  // quantity on CreateDeliveryInput, so "ship 60% now, 40% next week" against a
  // SINGLE invoice is impossible. (Order-level partial fulfilment across
  // multiple invoices IS possible and is exercised in Profile A.)
  it.skip('GAP #2: one invoice ships in multiple partial deliveries (NOT SUPPORTED)', () => {
    // Desired contract once implemented, e.g.:
    //   const d1 = createDelivery(ctx, { invoiceId, lines:[{ invoiceLineId, qty: half }] , ... });
    //   dispatchDelivery(ctx, d1.id);
    //   expect(getInvoice(ctx, invoiceId).status).toBe('partially_dispatched');
    //   const d2 = createDelivery(ctx, { invoiceId, lines:[{ invoiceLineId, qty: rest }] , ... });
    //   dispatchDelivery(ctx, d2.id);
    //   expect(getInvoice(ctx, invoiceId).status).toBe('dispatched');
  });

  // TODO(GAP #3 — PURCHASE RETURN TO SUPPLIER): the only inbound correction is
  // reverseReceipt, which fully unwinds a receipt. There is no way to return a
  // PART of a received lot to the supplier after it has been split/moved, nor a
  // supplier debit-note. Real procurement needs a partial goods-return-out flow.
  it.skip('GAP #3: partial return of received goods to a supplier (NOT SUPPORTED)', () => {
    // Desired contract once implemented, e.g.:
    //   const gr = createPurchaseReturn(ctx, { receiptId, qty: partial, warehouseId, reason });
    //   expect(getOnHand(ctx, itemId, warehouseId)).toBe(before - partial); // partial removal
    //   assertLedgerConsistent(ctx, 'after purchase return');
  });
});
