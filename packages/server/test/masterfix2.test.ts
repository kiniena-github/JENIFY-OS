import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { deliveryPerformance } from '@factoryos/shared';
import * as webFmt from '../../web/src/lib/format.js';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, type TestTenant } from './helpers.js';
import { createParty } from '../src/services/parties.js';
import { createItem, createWarehouse, updateWarehouse, deleteWarehouse, warehouseEverUsed } from '../src/services/masterdata.js';
import { enableLanguage, updateLanguage, deleteLanguage, upsertTranslation } from '../src/services/translations.js';
import { saveSettings } from '../src/services/settings.js';
import { defineSequence } from '../src/services/numbering.js';
import { registerTranslationKeys } from '../src/services/translations.js';
import { PLATFORM_KEYS } from '../src/i18n-keys.js';
import { createReceipt, postReceipt } from '../src/services/receiving.js';
import { createTransfer, postTransfer } from '../src/services/transfers.js';
import { createBatch, completeBatch, recordQualityTest, approveQualityTest, getBatch } from '../src/services/batches.js';
import { createInvoice, confirmInvoice } from '../src/services/sales.js';
import { createDelivery, dispatchDelivery, markDelivered } from '../src/services/deliveries.js';
import { createPayment, reversePayment, applyAllocations } from '../src/services/payments.js';
import { productionReport, qualityReport, rawStockReport, creditReport, deliveryReport } from '../src/services/reports.js';
import { createUser, updateUser } from '../src/services/users.js';
import { createRole } from '../src/services/permissions.js';
import { generateRecoveryCodes, recoverWithCode } from '../src/services/recovery.js';
import { initFreshProductionTenant } from '../src/services/provisioning.js';
import { login } from '../src/services/auth.js';
import { listAudit } from '../src/services/audit.js';
import { fullMatrix } from './helpers.js';
import { nowIso, AppError } from '../src/util.js';
import { eq } from 'drizzle-orm';
import { schema } from '../src/db/index.js';

const TODAY = nowIso().slice(0, 10);

let db: Db;
let tt: TestTenant;
let supplierId: string;
let customerId: string;
let rawLotId: string;

function receive(qtyKg: number, warehouseId: string): string {
  const { id } = createReceipt(tt.ownerCtx, {
    supplierId,
    truckNumber: 'T-1',
    driverName: 'D',
    date: TODAY,
    itemId: tt.items.raw,
    entryUomId: tt.uoms.kg,
    netQty: qtyKg,
    warehouseId,
  });
  postReceipt(tt.ownerCtx, id);
  const lot = db.select().from(schema.lots).where(eq(schema.lots.tenantId, tt.tenantId)).all().at(-1)!;
  return lot.id;
}

beforeAll(() => {
  db = testDb();
  registerTranslationKeys(db, PLATFORM_KEYS);
  tt = makeTestTenant(db, 'MF2');
  makeProcessStages(tt);
  supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Supplier' });
  customerId = createParty(tt.ownerCtx, {
    kind: 'customer',
    name: 'Customer X',
    creditLimit: 10_000_000,
    defaultPriceCategory: 'wholesale',
  });
  saveSettings(tt.ownerCtx, 'pricing', {
    categories: ['retail', 'wholesale'],
    defaultCategory: 'retail',
    prices: { [tt.items.pack1kg]: { wholesale: 80, retail: 95 } },
  });
  saveSettings(tt.ownerCtx, 'vat', { enabled: true, ratePct: 15 });
  saveSettings(tt.ownerCtx, 'branding', { companyName: 'MF2 Factory', tin: '111' });
  rawLotId = receive(10_000, tt.warehouses.a);
});

describe('warehouse delete vs archive (core rule)', () => {
  it('permanently deletes an unused warehouse after explicit confirmation path', () => {
    const id = createWarehouse(tt.sysCtx, { code: 'TMP', name: 'Temp warehouse' });
    expect(warehouseEverUsed(tt.ownerCtx, id)).toBe(false);
    deleteWarehouse(tt.ownerCtx, id);
    const gone = db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id)).get();
    expect(gone).toBeUndefined();
  });

  it('blocks permanent delete once ANY transaction referenced it — even at zero stock', () => {
    const id = createWarehouse(tt.sysCtx, { code: 'USED', name: 'Used warehouse' });
    receive(50, id); // touched by a receipt + movement
    expect(warehouseEverUsed(tt.ownerCtx, id)).toBe(true);
    expect(() => deleteWarehouse(tt.ownerCtx, id)).toThrow(/history/);
    // move the stock out — delete stays blocked because history remains
    const lot = db.select().from(schema.lots).where(eq(schema.lots.tenantId, tt.tenantId)).all().at(-1)!;
    const { id: trf } = createTransfer(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId: lot.id,
      entryUomId: tt.uoms.kg,
      qty: 50,
      fromWarehouseId: id,
      toWarehouseId: tt.warehouses.a,
      date: TODAY,
      reason: 'Consolidate',
    });
    postTransfer(tt.ownerCtx, trf);
    expect(() => deleteWarehouse(tt.ownerCtx, id)).toThrow(/history/);
    // archive is the correct path, and history stays intact afterwards
    updateWarehouse(tt.ownerCtx, id, { active: false });
    const receipts = db.select().from(schema.goodsReceipts).where(eq(schema.goodsReceipts.warehouseId, id)).all();
    expect(receipts.length).toBe(1);
  });

  it('blocks archive while stock remains', () => {
    const id = createWarehouse(tt.sysCtx, { code: 'FULL', name: 'Full warehouse' });
    receive(20, id);
    expect(() => updateWarehouse(tt.ownerCtx, id, { active: false })).toThrow(/stock/);
    expect(() => deleteWarehouse(tt.ownerCtx, id)).toThrow(/history/);
  });
});

describe('language delete vs archive (core rule)', () => {
  it('permanently deletes a never-used language', () => {
    const id = enableLanguage(tt.ownerCtx, 'tr', 'Turkish');
    deleteLanguage(tt.ownerCtx, id);
    const gone = db.select().from(schema.tenantLanguages).where(eq(schema.tenantLanguages.id, id)).get();
    expect(gone).toBeUndefined();
  });

  it('blocks delete once translations exist; archive stays available', () => {
    const id = enableLanguage(tt.ownerCtx, 'fr', 'French');
    upsertTranslation(tt.ownerCtx, 'nav.dashboard', 'fr', 'Tableau de bord');
    expect(() => deleteLanguage(tt.ownerCtx, id)).toThrow(/archive/i);
    updateLanguage(tt.ownerCtx, id, { enabled: false });
    const row = db.select().from(schema.tenantLanguages).where(eq(schema.tenantLanguages.id, id)).get()!;
    expect(row.enabled).toBe(false);
  });

  it('never deletes English', () => {
    const id = enableLanguage(tt.ownerCtx, 'en', 'English');
    expect(() => deleteLanguage(tt.ownerCtx, id)).toThrow(/base/i);
  });
});

describe('quantity display policy (never round away hundreds of kg)', () => {
  it('shows tons with two-decimal precision and exact form', () => {
    expect(webFmt.qtySmart(3_980_000)).toBe('3.98 t');
    expect(webFmt.qtySmart(1_980_000)).toBe('1.98 t');
    expect(webFmt.qtySmart(5_960_000)).toBe('5.96 t');
    expect(webFmt.qtySmart(4_000_000)).toBe('4 t');
    expect(webFmt.qtySmart(950_000)).toBe('950 kg');
    expect(webFmt.qtyExact(3_980_000)).toBe('3.98 t (3,980 kg)');
  });
});

describe('delivery performance calculation', () => {
  const base = { status: 'delivered' };
  it('early / on-time / late for delivered orders', () => {
    expect(deliveryPerformance({ ...base, expectedDate: '2026-08-20', actualDate: '2026-08-19' })).toEqual({ code: 'early', days: 1 });
    expect(deliveryPerformance({ ...base, expectedDate: '2026-08-20', actualDate: '2026-08-20' })).toEqual({ code: 'on_time', days: 0 });
    expect(deliveryPerformance({ ...base, expectedDate: '2026-08-20', actualDate: '2026-08-23' })).toEqual({ code: 'late', days: 3 });
  });
  it('on-schedule / due-today / overdue for open orders', () => {
    const today = '2026-08-19';
    expect(deliveryPerformance({ status: 'pending', expectedDate: '2026-08-25', today })).toEqual({ code: 'on_schedule', days: 0 });
    expect(deliveryPerformance({ status: 'dispatched', expectedDate: today, today })).toEqual({ code: 'due_today', days: 0 });
    expect(deliveryPerformance({ status: 'dispatched', expectedDate: '2026-08-15', today })).toEqual({ code: 'overdue', days: 4 });
    expect(deliveryPerformance({ status: 'cancelled', expectedDate: '2026-08-15', today })).toBeNull();
  });
});

describe('payment reference required by method', () => {
  it('rejects mobile money / bank / cheque without a reference; cash is exempt', () => {
    for (const method of ['mobile_money', 'bank_transfer', 'cheque']) {
      expect(() =>
        createPayment(tt.ownerCtx, { customerId, date: TODAY, amount: 10, method }, { post: true }),
      ).toThrow(/reference/i);
    }
    const cash = createPayment(tt.ownerCtx, { customerId, date: TODAY, amount: 10, method: 'cash' }, { post: true });
    expect(cash.docNumber).toMatch(/^PAY-/);
  });

  it('blocks a duplicate external reference for the same method', () => {
    createPayment(
      tt.ownerCtx,
      { customerId, date: TODAY, amount: 5, method: 'mobile_money', referenceNumber: 'MM-777' },
      { post: true },
    );
    expect(() =>
      createPayment(
        tt.ownerCtx,
        { customerId, date: TODAY, amount: 7, method: 'mobile_money', referenceNumber: 'MM-777' },
        { post: true },
      ),
    ).toThrow(/already used/i);
  });

  it('a reversed payment can never receive allocations', () => {
    const { id } = createPayment(
      tt.ownerCtx,
      { customerId, date: TODAY, amount: 15, method: 'bank_transfer', referenceNumber: 'RVT-1' },
      { post: true },
    );
    reversePayment(tt.ownerCtx, id, 'Recorded twice');
    expect(() => applyAllocations(tt.ownerCtx, id, [{ invoiceId: 'x', amount: 1 }])).toThrow(/posted/);
    // the freed reference may be reused after reversal
    const again = createPayment(
      tt.ownerCtx,
      { customerId, date: TODAY, amount: 15, method: 'bank_transfer', referenceNumber: 'RVT-1' },
      { post: true },
    );
    expect(again.docNumber).toMatch(/^PAY-/);
  });
});

describe('production flow: supervisor identity + reports', () => {
  let washId: string;
  let iodId: string;
  let invoiceId: string;

  it('records operator and supervisor as separate identities with audit', () => {
    const { id } = createBatch(tt.ownerCtx, {
      stageCode: 'washing',
      date: TODAY,
      inputLotId: rawLotId,
      inputWarehouseId: tt.warehouses.a,
      inputQty: 5000,
      inputUomId: tt.uoms.kg,
      operatorName: 'Abel',
      supervisorName: 'Saba',
    });
    washId = id;
    completeBatch(tt.ownerCtx, id, { outputQty: 4600 });
    const b = getBatch(tt.ownerCtx, id);
    expect(b.operatorName).toBe('Abel');
    expect(b.supervisorName).toBe('Saba');
    const audit = listAudit(tt.ownerCtx, { search: 'supervised by Saba', scope: 'all' });
    expect(audit.count).toBeGreaterThan(0);
  });

  it('quality report separates final state from historical attempts', () => {
    const { id } = createBatch(tt.ownerCtx, {
      stageCode: 'iodization',
      date: TODAY,
      inputBatchId: washId,
      inputBatchQty: 4600,
      attributes: { iodine_added_kg: 0.23 },
    });
    iodId = id;
    completeBatch(tt.ownerCtx, id, {});
    recordQualityTest(tt.ownerCtx, id, { targetLevel: '30-40 ppm', actualResult: '21', status: 'failed', date: TODAY });
    recordQualityTest(tt.ownerCtx, id, { targetLevel: '30-40 ppm', actualResult: '34', status: 'passed', date: TODAY });
    approveQualityTest(tt.ownerCtx, id);
    const r = qualityReport(tt.ownerCtx, {});
    expect(r.releasedCount).toBe(1);
    expect(r.currentlyFailedCount).toBe(0);
    expect(r.retestedBatchCount).toBe(1); // history preserved despite final Pass
    expect(r.totalAttempts).toBe(2);
    expect(r.failedAttempts).toBe(1);
  });

  it('production report never double-counts consecutive stages', () => {
    const r = productionReport(tt.ownerCtx, {});
    expect(r.rawInputQty).toBe(5_000_000); // washing input only
    expect(r.finalOutputQty).toBe(4_600_000); // iodization output only
    expect(r.lossQty).toBe(400_000); // measured washing loss only
  });

  it('raw report shows the ORIGINAL batch quantity once with warehouse locations', () => {
    const { id: trf } = createTransfer(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId: rawLotId,
      entryUomId: tt.uoms.kg,
      qty: 2000,
      fromWarehouseId: tt.warehouses.a,
      toWarehouseId: tt.warehouses.b,
      date: TODAY,
      reason: 'Split',
    });
    postTransfer(tt.ownerCtx, trf);
    const r = rawStockReport(tt.ownerCtx, {});
    const batch = r.batches.find((b) => b.lotNumber === 'RAW-0001')!;
    expect(batch.originalQty).toBe(10_000_000); // shown once for the batch
    expect(batch.locations.length).toBeGreaterThanOrEqual(2); // A and B
    expect(batch.locations.reduce((s, l) => s + l.remainingQty, 0)).toBe(batch.remainingQty);
    // totals still reconcile: 10,000 received once, not once per warehouse
    expect(r.receivedQty).toBeGreaterThanOrEqual(10_000_000);
  });

  it('credit report: settled invoices are visible on request and collected is traceable', () => {
    const pkg = createBatch(tt.ownerCtx, {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 1000,
    });
    completeBatch(tt.ownerCtx, pkg.id, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 1000,
      unitsRejected: 0,
      outputWarehouseId: tt.warehouses.b,
    });
    const inv = createInvoice(tt.ownerCtx, {
      customerId,
      date: TODAY,
      paymentTerm: 'credit',
      dueDate: '2099-12-31',
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 100, entryUomId: tt.uoms.piece }],
    });
    invoiceId = inv.id;
    confirmInvoice(tt.ownerCtx, inv.id);
    createPayment(
      tt.ownerCtx,
      {
        customerId,
        date: TODAY,
        amount: inv.totalCents / 100,
        method: 'bank_transfer',
        referenceNumber: 'SETTLE-1',
        allocations: [{ invoiceId: inv.id, amount: inv.totalCents / 100 }],
      },
      { post: true },
    );
    const open = creditReport(tt.ownerCtx, {}, 'open');
    expect(open.rows.some((r) => r.invoiceId === inv.id)).toBe(false);
    const settled = creditReport(tt.ownerCtx, {}, 'settled');
    const row = settled.rows.find((r) => r.invoiceId === inv.id)!;
    expect(row.remainingCents).toBe(0);
    expect(settled.collectedCents).toBeGreaterThanOrEqual(inv.totalCents);
  });

  it('invoice detail exposes paid/remaining and the branding snapshot version', () => {
    const inv = db.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId)).get()!;
    expect(inv.brandingVersion).toBe(1); // stamped at confirmation
    expect(inv.paymentTerm).toBe('credit'); // payment TYPE, never an account status
  });

  it('delivery report includes expected/actual and computed performance', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const inv = createInvoice(tt.ownerCtx, {
      customerId,
      date: TODAY,
      paymentTerm: 'credit',
      dueDate: '2099-12-31',
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 50, entryUomId: tt.uoms.piece }],
    });
    confirmInvoice(tt.ownerCtx, inv.id);
    const { id: delId } = createDelivery(tt.ownerCtx, {
      invoiceId: inv.id,
      destination: 'Adigrat',
      truckNumber: 'T-2',
      driverName: 'D',
      driverPhone: '1',
      expectedDate: tomorrow,
    });
    dispatchDelivery(tt.ownerCtx, delId);
    markDelivered(tt.ownerCtx, delId, { actualDate: TODAY, receivedBy: 'R' });
    const r = deliveryReport(tt.ownerCtx, {});
    const row = r.breakdown.find((b) => b.invoiceNumber === inv.docNumber)!;
    expect(row.expectedDate).toBe(tomorrow);
    expect(row.actualDate).toBe(TODAY);
    expect(row.performance).toEqual({ code: 'early', days: 1 }); // "1 day early"
  });
});

describe('owner recovery and last-owner protection', () => {
  it('cannot deactivate or demote the last active owner', () => {
    expect(() => updateUser(tt.ownerCtx, tt.ownerUserId, { active: false })).toThrow(/owner/i);
    const staffRole = createRole(tt.sysCtx, { code: 'staff', name: 'Staff', matrix: {} });
    expect(() => updateUser(tt.ownerCtx, tt.ownerUserId, { roleId: staffRole })).toThrow(/owner/i);
    // a second active owner unlocks the change
    createUser(tt.sysCtx, {
      username: 'owner2.mf2',
      displayName: 'Second Owner',
      password: 'test-password',
      roleId: tt.ownerRoleId,
    });
    updateUser(tt.ownerCtx, tt.ownerUserId, { active: false });
    updateUser(tt.ownerCtx, tt.ownerUserId, { active: true }); // restore
  });

  it('recovery code lifecycle: single use, forces new password, audited', () => {
    const codes = generateRecoveryCodes(tt.ownerCtx, tt.ownerUserId);
    expect(codes.length).toBe(8);
    expect(new Set(codes).size).toBe(8);
    const username = 'owner.mf2';
    recoverWithCode(db, { username, code: codes[0], newPassword: 'brand-new-pass' });
    // old password now fails; the new one signs in
    expect(() => login(db, { username, password: 'test-password' })).toThrow(AppError);
    const session = login(db, { username, password: 'brand-new-pass' });
    expect(session.user.username).toBe(username);
    // the used code is consumed forever
    expect(() => recoverWithCode(db, { username, code: codes[0], newPassword: 'x-again-1' })).toThrow(AppError);
    // a fresh batch revokes the remaining old codes
    const fresh = generateRecoveryCodes(tt.ownerCtx, tt.ownerUserId);
    expect(() => recoverWithCode(db, { username, code: codes[1], newPassword: 'x-again-2' })).toThrow(AppError);
    recoverWithCode(db, { username, code: fresh[0], newPassword: 'test-password' }); // restore for other tests
    const audit = listAudit(tt.ownerCtx, { search: 'recovery', scope: 'all' });
    expect(audit.count).toBeGreaterThanOrEqual(2);
  });
});

describe('fresh production tenant initialization (go-live)', () => {
  it('clones approved configuration with ZERO operational history', () => {
    // archive a test-only warehouse first — archived locations are not carried
    const testWh = createWarehouse(tt.sysCtx, { code: 'TST', name: 'test warehouse' });
    updateWarehouse(tt.ownerCtx, testWh, { active: false });

    const { tenantId } = initFreshProductionTenant(db, {
      sourceTenantId: tt.tenantId,
      code: 'mf2-prod',
      name: 'MF2 Production',
      ownerUsername: 'prod.owner',
      ownerPassword: 'go-live-pass',
      selection: { warehouseCodes: ['A', 'B', 'C'] },
    });

    const rows = <T extends { tenantId: string }>(all: T[]) => all.filter((r) => r.tenantId === tenantId);

    // configuration copied: active warehouses only — archived test locations stay behind
    const codes = rows(db.select().from(schema.warehouses).all()).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    expect(codes).not.toContain('TST'); // archived test warehouse not carried over
    expect(codes).not.toContain('USED');
    expect(rows(db.select().from(schema.productionStages).all()).length).toBe(3);
    expect(rows(db.select().from(schema.items).all()).length).toBeGreaterThanOrEqual(2);
    const seqs = rows(db.select().from(schema.documentSequences).all());
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.every((s) => s.nextValue === 1)).toBe(true); // counters reset
    expect(rows(db.select().from(schema.tenantSettings).all()).every((s) => s.version === 1)).toBe(true);

    // ZERO operational history
    expect(rows(db.select().from(schema.goodsReceipts).all()).length).toBe(0);
    expect(rows(db.select().from(schema.productionBatches).all()).length).toBe(0);
    expect(rows(db.select().from(schema.salesInvoices).all()).length).toBe(0);
    expect(rows(db.select().from(schema.payments).all()).length).toBe(0);
    expect(rows(db.select().from(schema.deliveries).all()).length).toBe(0);
    expect(rows(db.select().from(schema.parties).all()).length).toBe(0);
    expect(rows(db.select().from(schema.stockMovements).all()).length).toBe(0);

    // fresh owner signs in with the provisioned credentials
    const session = login(db, { username: 'prod.owner', password: 'go-live-pass' });
    expect(session.user.tenantId).toBe(tenantId);
  });
});

// ---------------- HTTP-level checks (login branding + public recovery) ------
describe('tenant-branded login endpoints', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp({ db });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('exposes tenant identity to the anonymous login screen', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/login-info' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('MF2 Test Factory');
  });

  it('public recovery endpoint rejects a bad code without leaking details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/recover',
      payload: { username: 'owner.mf2', code: 'AAAA-BBBB-CCCC', newPassword: 'whatever-1' },
    });
    expect(res.statusCode).toBe(401);
  });
});
