import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import { createParty } from '../src/services/parties.js';
import { saveSettings } from '../src/services/settings.js';
import { createReceipt, postReceipt } from '../src/services/receiving.js';
import { createInvoice, confirmInvoice, customerOutstanding, listInvoiceLines } from '../src/services/sales.js';
import { creditOverview } from '../src/services/creditview.js';
import { createDelivery, dispatchDelivery, markDelivered, getDelivery } from '../src/services/deliveries.js';
import { getInvoice } from '../src/services/sales.js';
import { createSalesReturn, reverseSalesReturn, createPurchaseReturn, listCreditNotes } from '../src/services/returns.js';
import { getOnHand } from '../src/services/inventory.js';
import { nowIso } from '../src/util.js';

let db: Db;
let tt: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'GAP');
  saveSettings(tt.ownerCtx, 'pricing', { categories: ['retail'], prices: { [tt.items.pack1kg]: { retail: 50 } } });
});

/** Stock 100 pack1kg, then a credit invoice for `qty`, confirmed. */
function soldInvoice(qty: number): { invoiceId: string; customerId: string } {
  const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'Sup' });
  const customerId = createParty(tt.sysCtx, { kind: 'customer', name: 'Cust' });
  const r = createReceipt(tt.ownerCtx, { supplierId, date: '2026-08-01', itemId: tt.items.pack1kg, entryUomId: tt.uoms.piece, netQty: 100, warehouseId: tt.warehouses.a });
  postReceipt(tt.ownerCtx, r.id);
  const inv = createInvoice(tt.ownerCtx, { customerId, date: nowIso().slice(0, 10), paymentTerm: 'credit', dueDate: '2026-12-31', priceCategory: 'retail', lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty, entryUomId: tt.uoms.piece }] });
  confirmInvoice(tt.ownerCtx, inv.id);
  return { invoiceId: inv.id, customerId };
}

function fullyDeliver(invoiceId: string): void {
  const del = createDelivery(tt.ownerCtx, { invoiceId, destination: 'X', truckNumber: 'T1', driverName: 'D', driverPhone: '+2519', expectedDate: nowIso().slice(0, 10) });
  dispatchDelivery(tt.ownerCtx, del.id, {});
  markDelivered(tt.ownerCtx, del.id, { actualDate: nowIso().slice(0, 10), receivedBy: 'R' });
}

// ---------------------------------------------------------------------------
// A. Sales returns / credit notes
// ---------------------------------------------------------------------------
describe('Sales returns / credit notes (Gap A)', () => {
  it('a partial return restocks the goods and reduces the receivable', () => {
    const { invoiceId, customerId } = soldInvoice(10);
    fullyDeliver(invoiceId);
    const onHandBefore = getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a); // 90 packs = 90000
    const outstandingBefore = customerOutstanding(tt.ownerCtx, customerId); // 10 * 50 * 100 = 50000 cents

    const line = listInvoiceLines(tt.ownerCtx, invoiceId)[0]!;
    const cn = createSalesReturn(tt.ownerCtx, { invoiceId, date: nowIso().slice(0, 10), reason: 'damaged', lines: [{ invoiceLineId: line.id, qty: 4 }] });
    expect(cn.totalCents).toBe(4 * 50 * 100); // 4 packs credited

    // stock returned: +4 packs
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a)).toBe(onHandBefore + 4000);
    // receivable reduced by the credited amount
    expect(customerOutstanding(tt.ownerCtx, customerId)).toBe(outstandingBefore - 4 * 50 * 100);
    // credit overview reflects it too
    const co = creditOverview(tt.ownerCtx, { customerId });
    expect(co.outstandingCents).toBe(outstandingBefore - 4 * 50 * 100);
  });

  it('over-returning (more than sold, cumulative) is blocked', () => {
    const { invoiceId } = soldInvoice(10);
    fullyDeliver(invoiceId);
    const line = listInvoiceLines(tt.ownerCtx, invoiceId)[0]!;
    createSalesReturn(tt.ownerCtx, { invoiceId, date: nowIso().slice(0, 10), lines: [{ invoiceLineId: line.id, qty: 7 }] });
    // a second return of 4 would total 11 > 10 sold
    expect(() => createSalesReturn(tt.ownerCtx, { invoiceId, date: nowIso().slice(0, 10), lines: [{ invoiceLineId: line.id, qty: 4 }] })).toThrowError(/more than sold/);
  });

  it('a return on an undispatched invoice is refused; reversing a credit note un-restocks', () => {
    const { invoiceId, customerId } = soldInvoice(10);
    const line = listInvoiceLines(tt.ownerCtx, invoiceId)[0]!;
    // not dispatched yet -> refused
    expect(() => createSalesReturn(tt.ownerCtx, { invoiceId, date: nowIso().slice(0, 10), lines: [{ invoiceLineId: line.id, qty: 1 }] })).toThrowError(/dispatched or completed/);
    fullyDeliver(invoiceId);
    const cn = createSalesReturn(tt.ownerCtx, { invoiceId, date: nowIso().slice(0, 10), lines: [{ invoiceLineId: line.id, qty: 4 }] });
    const onHandAfterReturn = getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a);
    const outstandingAfterReturn = customerOutstanding(tt.ownerCtx, customerId);
    reverseSalesReturn(tt.ownerCtx, cn.id, 'entered by mistake');
    // stock goes back out, receivable restored
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a)).toBe(onHandAfterReturn - 4000);
    expect(customerOutstanding(tt.ownerCtx, customerId)).toBe(outstandingAfterReturn + 4 * 50 * 100);
    expect(listCreditNotes(tt.ownerCtx, { invoiceId })[0]!.status).toBe('reversed');
  });

  it('requires sales.create permission (a viewer is refused)', () => {
    const { invoiceId } = soldInvoice(10);
    fullyDeliver(invoiceId);
    const line = listInvoiceLines(tt.ownerCtx, invoiceId)[0]!;
    const roleId = createRole(tt.sysCtx, { code: 'viewer', name: 'Viewer', matrix: matrixOf([['sales', ['view']]]) });
    const uid = createUser(tt.sysCtx, { username: 'v', displayName: 'V', password: 'test-password', roleId });
    const viewer = { db, tenantId: tt.tenantId, user: buildSessionUser(db, uid)! };
    expect(() => createSalesReturn(viewer, { invoiceId, date: nowIso().slice(0, 10), lines: [{ invoiceLineId: line.id, qty: 1 }] })).toThrowError(/permission/);
  });
});

// ---------------------------------------------------------------------------
// B. Single-invoice split delivery
// ---------------------------------------------------------------------------
describe('Single-invoice split delivery (Gap B)', () => {
  it('ships part now and part later; invoice completes only when fully delivered', () => {
    const { invoiceId } = soldInvoice(10);
    const line = listInvoiceLines(tt.ownerCtx, invoiceId)[0]!;
    const onHandStart = getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a); // 90 after reservation? on-hand is 100 (reserved != dispatched)

    // delivery 1: ship 6 of 10
    const d1 = createDelivery(tt.ownerCtx, { invoiceId, destination: 'X', truckNumber: 'T1', driverName: 'D', driverPhone: '+2519', expectedDate: nowIso().slice(0, 10) });
    dispatchDelivery(tt.ownerCtx, d1.id, { lineQtys: [{ invoiceLineId: line.id, qty: 6 }] });
    // 6 packs left stock
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a)).toBe(onHandStart - 6000);
    markDelivered(tt.ownerCtx, d1.id, { actualDate: nowIso().slice(0, 10), receivedBy: 'R1' });
    // invoice NOT complete — 4 remain
    expect(getInvoice(tt.ownerCtx, invoiceId).status).toBe('dispatched');

    // delivery 2: ship the remaining 4
    const d2 = createDelivery(tt.ownerCtx, { invoiceId, destination: 'X', truckNumber: 'T2', driverName: 'D', driverPhone: '+2519', expectedDate: nowIso().slice(0, 10) });
    dispatchDelivery(tt.ownerCtx, d2.id, { lineQtys: [{ invoiceLineId: line.id, qty: 4 }] });
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a)).toBe(onHandStart - 10000);
    markDelivered(tt.ownerCtx, d2.id, { actualDate: nowIso().slice(0, 10), receivedBy: 'R2' });
    // now fully delivered -> completed
    expect(getInvoice(tt.ownerCtx, invoiceId).status).toBe('completed');
  });

  it('cannot dispatch more than the line remainder', () => {
    const { invoiceId } = soldInvoice(10);
    const line = listInvoiceLines(tt.ownerCtx, invoiceId)[0]!;
    const d1 = createDelivery(tt.ownerCtx, { invoiceId, destination: 'X', truckNumber: 'T1', driverName: 'D', driverPhone: '+2519', expectedDate: nowIso().slice(0, 10) });
    expect(() => dispatchDelivery(tt.ownerCtx, d1.id, { lineQtys: [{ invoiceLineId: line.id, qty: 11 }] })).toThrowError(/more than remaining/);
  });

  it('a full dispatch (no lineQtys) still completes the invoice on delivery', () => {
    const { invoiceId } = soldInvoice(10);
    fullyDeliver(invoiceId);
    expect(getInvoice(tt.ownerCtx, invoiceId).status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// C. Partial purchase returns
// ---------------------------------------------------------------------------
describe('Partial purchase returns (Gap C)', () => {
  it('returns part of a received lot to the supplier, reducing stock', () => {
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'Sup' });
    const r = createReceipt(tt.ownerCtx, { supplierId, date: '2026-08-01', itemId: tt.items.raw, entryUomId: tt.uoms.ton, netQty: 10, warehouseId: tt.warehouses.a });
    postReceipt(tt.ownerCtx, r.id);
    const onHandBefore = getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a); // 10 ton = 10_000_000 milli
    const pr = createPurchaseReturn(tt.ownerCtx, { receiptId: r.id, date: nowIso().slice(0, 10), qty: 3000, reason: 'wet' }); // 3 ton = 3000 base kg
    expect(pr.docNumber).toMatch(/^PRT-/);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(onHandBefore - 3000 * 1000);
  });

  it('over-returning (more than received, cumulative) is blocked', () => {
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'Sup' });
    const r = createReceipt(tt.ownerCtx, { supplierId, date: '2026-08-01', itemId: tt.items.raw, entryUomId: tt.uoms.ton, netQty: 10, warehouseId: tt.warehouses.a });
    postReceipt(tt.ownerCtx, r.id);
    createPurchaseReturn(tt.ownerCtx, { receiptId: r.id, date: nowIso().slice(0, 10), qty: 7000 }); // 7 ton
    expect(() => createPurchaseReturn(tt.ownerCtx, { receiptId: r.id, date: nowIso().slice(0, 10), qty: 4000 })).toThrowError(/more than received/);
  });
});
