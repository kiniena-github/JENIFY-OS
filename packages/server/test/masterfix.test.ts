import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toEthiopianDate } from '@factoryos/shared';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, matrixOf, type TestTenant } from './helpers.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { createParty } from '../src/services/parties.js';
import { createItem, createWarehouse } from '../src/services/masterdata.js';
import { saveSettings } from '../src/services/settings.js';
import { defineSequence } from '../src/services/numbering.js';
import { registerTranslationKeys } from '../src/services/translations.js';
import { PLATFORM_KEYS } from '../src/i18n-keys.js';
import { nowIso } from '../src/util.js';

/**
 * Master end-to-end regression for the full-fix pass (scenario A-N of the
 * founder brief), run against a dedicated in-memory test tenant so real data
 * is never touched. Every number below is from the brief and must stay exact.
 */

const TODAY = nowIso().slice(0, 10);

let db: Db;
let tt: TestTenant;
let app: FastifyInstance;
let cookie = '';
let sackItemId: string;
let customerId: string;
let supplierId: string;

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) {
  return app.inject({ method, url, payload: payload as object, headers: { cookie } });
}
async function ok(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) {
  const res = await call(method, url, payload);
  expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(200);
  return res.json();
}

beforeAll(async () => {
  db = testDb();
  registerTranslationKeys(db, PLATFORM_KEYS);
  tt = makeTestTenant(db, 'MFX');
  makeProcessStages(tt);
  supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Afdera Supplier' });
  // customer whose DEFAULT category must drive the invoice automatically
  customerId = createParty(tt.ownerCtx, {
    kind: 'customer',
    name: 'Wholesale North',
    creditLimit: 1_000_000,
    defaultPriceCategory: 'wholesale',
  });
  sackItemId = createItem(tt.sysCtx, {
    code: 'SACK',
    name: 'Empty Sack',
    kind: 'consumable',
    trackingMode: 'none',
    baseUomId: tt.uoms.piece,
  });
  defineSequence(tt.sysCtx, 'sack', 'SACK-', 4);
  saveSettings(tt.ownerCtx, 'pricing', {
    categories: [
      { code: 'retail', name: 'Retail', active: true },
      { code: 'wholesale', name: 'Wholesale', active: true },
    ],
    defaultCategory: 'retail',
    prices: { [tt.items.pack1kg]: { wholesale: 80, retail: 95 } },
  });
  saveSettings(tt.ownerCtx, 'vat', { enabled: true, ratePct: 15 });
  app = buildApp({ db });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'owner.mfx', password: 'test-password' },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'];
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie!).split(';')[0];
});

afterAll(async () => {
  await app.close();
});

let receiptId: string;
let rawLotId = '';
let washId: string;
let iodId: string;
let pkgId: string;
let invoiceId: string;
let deliveryId: string;
let sellTxnId: string;

describe('master A-N regression (test tenant)', () => {
  it('A: receives 10,000 kg of raw salt as a traceable lot', async () => {
    const draft = await ok('POST', '/api/receipts', {
      supplierId,
      source: 'Afdera',
      truckNumber: 'ET-3-10001',
      driverName: 'Driver A',
      date: TODAY,
      itemId: tt.items.raw,
      entryUomId: tt.uoms.ton,
      grossQty: 10.4,
      netQty: 10,
      warehouseId: tt.warehouses.a,
    });
    receiptId = draft.id;
    await ok('POST', `/api/receipts/${receiptId}/post`);
    const stock = await ok('GET', '/api/stock?kind=raw_material');
    expect(stock.length).toBe(1);
    expect(stock[0].onHand).toBe(10_000_000);
    rawLotId = stock[0].lotId;
  });

  it('B: transfers 5,000 kg A->B without changing the factory total', async () => {
    await ok('POST', '/api/transfers', {
      itemId: tt.items.raw,
      lotId: rawLotId,
      entryUomId: tt.uoms.kg,
      qty: 5000,
      fromWarehouseId: tt.warehouses.a,
      toWarehouseId: tt.warehouses.b,
      date: TODAY,
      reason: 'Feed production',
      andPost: true,
    });
    const stock = await ok('GET', '/api/stock?kind=raw_material');
    expect(stock.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0)).toBe(10_000_000);
  });

  it('C: washing 5,000 kg -> 4,600 kg records a measured 400 kg loss', async () => {
    const created = await ok('POST', '/api/batches', {
      stageCode: 'washing',
      date: TODAY,
      inputLotId: rawLotId,
      inputWarehouseId: tt.warehouses.a,
      inputQty: 5000,
      inputUomId: tt.uoms.kg,
      andStart: true,
    });
    washId = created.id;
    await ok('POST', `/api/batches/${washId}/complete`, { outputQty: 4600 });
    const detail = await ok('GET', `/api/batches/${washId}`);
    expect(detail.batch.lossQty).toBe(400_000);
  });

  it('D: iodization CONSERVES quantity — 4,600 in, 4,600 out, no invented loss', async () => {
    const created = await ok('POST', '/api/batches', {
      stageCode: 'iodization',
      date: TODAY,
      inputBatchId: washId,
      inputBatchQty: 4600,
      attributes: { iodine_added_kg: 0.23 },
    });
    iodId = created.id;
    // an ad-hoc different output is rejected on a conserved stage
    const adHoc = await call('POST', `/api/batches/${iodId}/complete`, { outputQty: 4580 });
    expect(adHoc.statusCode).toBe(400);
    await ok('POST', `/api/batches/${iodId}/complete`, {});
    const detail = await ok('GET', `/api/batches/${iodId}`);
    expect(detail.batch.outputQty).toBe(4_600_000);
    expect(detail.batch.lossQty).toBe(0);
  });

  it('D2: failed QC blocks packaging; retest passes; release opens the gate', async () => {
    await ok('POST', `/api/batches/${iodId}/qc-test`, {
      targetLevel: '30-40 ppm',
      actualResult: '21 ppm',
      status: 'failed',
      date: TODAY,
    });
    const blocked = await call('POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 1000,
    });
    expect(blocked.statusCode).toBe(400);
    await ok('POST', `/api/batches/${iodId}/qc-test`, {
      targetLevel: '30-40 ppm',
      actualResult: '35 ppm',
      status: 'passed',
      date: TODAY,
    });
    // passed but NOT yet released -> still blocked
    const stillBlocked = await call('POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 1000,
    });
    expect(stillBlocked.statusCode).toBe(400);
    await ok('POST', `/api/batches/${iodId}/qc-approve`);
    const detail = await ok('GET', `/api/batches/${iodId}`);
    expect(detail.batch.qcStatus).toBe('passed');
    expect(detail.tests.length).toBe(2); // immutable attempts, linked retest
  });

  it('E: packaging 4,000 kg -> 4,000 units, 20 rejected, 3,980 finished, 600 kg left on source', async () => {
    const created = await ok('POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 4000,
    });
    pkgId = created.id;
    await ok('POST', `/api/batches/${pkgId}/complete`, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 4000,
      unitsRejected: 20,
      outputWarehouseId: tt.warehouses.b,
    });
    const stock = await ok('GET', '/api/stock?kind=finished_good');
    expect(stock.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0)).toBe(3_980_000);
    const iod = await ok('GET', `/api/batches/${iodId}`);
    expect(iod.batch.outputQty - iod.batch.consumedOutputQty).toBe(600_000); // 600 kg remaining
  });

  it('E2: the packaging report names its iodization source (never a dash)', async () => {
    const report = await ok('GET', '/api/reports/packaging');
    const row = report.breakdown.find((b: { batchNumber: string }) => b.batchNumber.startsWith('PKG'));
    expect(row.sourceRef).toMatch(/^IOD-/);
    expect(report.totalRejected).toBe(20_000); // 20 packs in milli-units
  });

  it('F+G: the customer default category drives the invoice; 2,000 x 80 + 15% VAT = 184,000', async () => {
    const inv = await ok('POST', '/api/invoices', {
      customerId,
      date: TODAY,
      // priceCategory deliberately omitted -> must resolve to 'wholesale'
      paymentTerm: 'credit',
      dueDate: '2099-12-31',
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 2000, entryUomId: tt.uoms.piece }],
      andConfirm: true,
    });
    invoiceId = inv.id;
    expect(inv.totalCents).toBe(18_400_000); // ETB 184,000.00
    const detail = await ok('GET', `/api/invoices/${invoiceId}`);
    expect(detail.invoice.priceCategory).toBe('wholesale');
    expect(detail.invoice.vatCents).toBe(2_400_000); // ETB 24,000 VAT
  });

  it('H: confirmation reserved 2,000 units so 1,980 remain available', async () => {
    const stock = await ok('GET', '/api/stock?kind=finished_good');
    const onHand = stock.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0);
    const reserved = stock.reduce((s: number, r: { reserved: number }) => s + r.reserved, 0);
    expect(onHand).toBe(3_980_000);
    expect(reserved).toBe(2_000_000);
    expect(onHand - reserved).toBe(1_980_000);
  });

  it('I: loading changes NO stock; dispatch removes stock; delivered closes it', async () => {
    const created = await ok('POST', '/api/deliveries', {
      invoiceId,
      destination: 'Adigrat',
      truckNumber: 'ET-3-20002',
      driverName: 'Driver B',
      driverPhone: '+251 911 111 222',
      expectedDate: '2099-12-31',
    });
    deliveryId = created.id;
    await ok('POST', `/api/deliveries/${deliveryId}/loading`);
    const during = await ok('GET', '/api/stock?kind=finished_good');
    expect(during.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0)).toBe(3_980_000);
    await ok('POST', `/api/deliveries/${deliveryId}/dispatch`);
    const after = await ok('GET', '/api/stock?kind=finished_good');
    expect(after.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0)).toBe(1_980_000);
    await ok('POST', `/api/deliveries/${deliveryId}/delivered`, {
      actualDate: TODAY,
      receivedBy: 'Shop Manager',
    });
  });

  it('J: PAY-1 100,000 then PAY-2 84,000 bring the outstanding balance to zero', async () => {
    const p1 = await ok('POST', '/api/payments', {
      customerId,
      date: TODAY,
      amount: 100_000,
      method: 'bank_transfer',
      referenceNumber: 'REF-1',
      allocations: [{ invoiceId, amount: 100_000 }],
      post: true,
    });
    const p2 = await ok('POST', '/api/payments', {
      customerId,
      date: TODAY,
      amount: 84_000,
      method: 'cash',
      allocations: [{ invoiceId, amount: 84_000 }],
      post: true,
    });
    expect(p1.docNumber).not.toBe(p2.docNumber); // document numbers stay unique
    const credit = await ok('GET', '/api/credit');
    expect(credit.outstandingCents).toBe(0);
  });

  it('K: sacks — collect 100, overselling 101 is rejected, sell 40 @ 10 = ETB 400', async () => {
    await ok('POST', '/api/simple-transactions', {
      itemId: sackItemId,
      warehouseId: tt.warehouses.a,
      type: 'collect',
      qty: 100,
      date: TODAY,
      docSeqKey: 'sack',
    });
    const oversell = await call('POST', '/api/simple-transactions', {
      itemId: sackItemId,
      warehouseId: tt.warehouses.a,
      type: 'sell',
      qty: 101,
      buyer: 'Local Trader',
      unitPrice: 10,
      date: TODAY,
      docSeqKey: 'sack',
    });
    expect(oversell.statusCode).toBe(400);
    const sale = await ok('POST', '/api/simple-transactions', {
      itemId: sackItemId,
      warehouseId: tt.warehouses.a,
      type: 'sell',
      qty: 40,
      buyer: 'Local Trader',
      unitPrice: 10,
      date: TODAY,
      docSeqKey: 'sack',
    });
    sellTxnId = sale.id;
    const rows = await ok('GET', `/api/simple-transactions?itemId=${sackItemId}`);
    const sold = rows.find((r: { id: string }) => r.id === sellTxnId);
    // row total shown in the UI = qty x unit price = ETB 400.00
    expect(Math.round((sold.qty / 1000) * sold.unitPriceCents)).toBe(40_000);
  });

  it('K2: reversing the sack sale restores the full 100 pieces', async () => {
    await ok('POST', `/api/simple-transactions/${sellTxnId}/reverse`, { reason: 'Buyer returned' });
    const stock = await ok('GET', `/api/stock?itemId=${sackItemId}`);
    const onHand = stock
      .filter((r: { itemId: string }) => r.itemId === sackItemId)
      .reduce((s: number, r: { onHand: number }) => s + r.onHand, 0);
    expect(onHand).toBe(100_000); // 100 pieces in milli-units
  });

  it('N: audit search finds the story; operational scope hides technical noise', async () => {
    const byRef = await ok('GET', '/api/audit?search=RCV-0001&scope=all');
    expect(byRef.count).toBeGreaterThan(0);
    const operational = await ok('GET', '/api/audit?scope=operational&limit=500');
    const technical = ['report_run', 'translation_edit'];
    expect(
      operational.rows.every((r: { action: string }) => !technical.includes(r.action)),
    ).toBe(true);
  });
});

describe('conserved-stage measured variance override', () => {
  it('allows an audited correction but never below the consumed quantity', async () => {
    // separate flow so the A-N numbers above stay untouched
    const created = await ok('POST', '/api/batches', {
      stageCode: 'washing',
      date: TODAY,
      inputLotId: rawLotId,
      inputWarehouseId: tt.warehouses.b,
      inputQty: 1000,
      inputUomId: tt.uoms.kg,
      andStart: true,
    });
    await ok('POST', `/api/batches/${created.id}/complete`, { outputQty: 950 });
    const iod = await ok('POST', '/api/batches', {
      stageCode: 'iodization',
      date: TODAY,
      inputBatchId: created.id,
      inputBatchQty: 950,
      attributes: { iodine_added_kg: 0.05 },
    });
    await ok('POST', `/api/batches/${iod.id}/complete`, {});
    await ok('POST', `/api/batches/${iod.id}/qc-test`, {
      targetLevel: '30-40 ppm',
      actualResult: '33 ppm',
      status: 'passed',
      date: TODAY,
    });
    await ok('POST', `/api/batches/${iod.id}/qc-approve`);

    // audited measured-variance override succeeds
    await ok('POST', `/api/batches/${iod.id}/correct-output`, {
      measuredOutputKg: 948,
      reason: 'Weighbridge remeasure after spillage',
    });
    const detail = await ok('GET', `/api/batches/${iod.id}`);
    expect(detail.batch.outputQty).toBe(948_000);
    const audit = await ok('GET', '/api/audit?search=batch_output_correct&scope=all');
    expect(audit.count).toBeGreaterThan(0);

    // consume some downstream, then a correction below consumption is refused
    const pkg = await ok('POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iod.id,
      inputBatchQty: 900,
    });
    await ok('POST', `/api/batches/${pkg.id}/complete`, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 900,
      unitsRejected: 0,
      outputWarehouseId: tt.warehouses.b,
    });
    const tooLow = await call('POST', `/api/batches/${iod.id}/correct-output`, {
      measuredOutputKg: 899,
      reason: 'Should fail',
    });
    expect(tooLow.statusCode).toBe(400);
  });
});

describe('role hardening: quality gate is not a production/ops power', () => {
  it('a view+export-only quality role cannot record or approve QC', async () => {
    const roleId = createRole(tt.sysCtx, {
      code: 'opsx',
      name: 'Ops (view-only QC)',
      matrix: matrixOf([
        ['production', ['view', 'create', 'edit', 'approve']],
        ['quality', ['view', 'export']],
        ['inventory', ['view']],
      ]),
    });
    createUser(tt.sysCtx, {
      username: 'opsx.mfx',
      displayName: 'Ops X',
      password: 'test-password',
      roleId,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'opsx.mfx', password: 'test-password' },
    });
    const opsCookie = (Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'][0]
      : login.headers['set-cookie']!
    ).split(';')[0];

    const test = await app.inject({
      method: 'POST',
      url: `/api/batches/${iodId}/qc-test`,
      payload: { targetLevel: '30-40 ppm', actualResult: '30 ppm', status: 'passed', date: TODAY },
      headers: { cookie: opsCookie },
    });
    expect(test.statusCode).toBe(403);
    const approve = await app.inject({
      method: 'POST',
      url: `/api/batches/${iodId}/qc-approve`,
      headers: { cookie: opsCookie },
    });
    expect(approve.statusCode).toBe(403);
    // but viewing production stays allowed
    const view = await app.inject({
      method: 'GET',
      url: `/api/batches/${iodId}`,
      headers: { cookie: opsCookie },
    });
    expect(view.statusCode).toBe(200);
  });
});

describe('dynamic warehouse manager', () => {
  it('adds a warehouse, refuses archiving while it holds stock, archives when empty', async () => {
    const created = await ok('POST', '/api/warehouses', { code: 'D', name: 'Warehouse D' });
    // stock it, then try to archive
    await ok('POST', '/api/simple-transactions', {
      itemId: sackItemId,
      warehouseId: created.id,
      type: 'collect',
      qty: 5,
      date: TODAY,
      docSeqKey: 'sack',
    });
    const blocked = await call('PATCH', `/api/warehouses/${created.id}`, { active: false });
    expect(blocked.statusCode).toBe(400);
    // empty it and archive
    await ok('POST', '/api/simple-transactions', {
      itemId: sackItemId,
      warehouseId: created.id,
      type: 'sell',
      qty: 5,
      buyer: 'Cleanup',
      unitPrice: 1,
      date: TODAY,
      docSeqKey: 'sack',
    });
    await ok('PATCH', `/api/warehouses/${created.id}`, { active: false });
    const active = await ok('GET', '/api/warehouses');
    expect(active.some((w: { id: string }) => w.id === created.id)).toBe(false);
    const all = await ok('GET', '/api/warehouses?includeInactive=true');
    expect(all.some((w: { id: string }) => w.id === created.id)).toBe(true); // archived, never deleted
  });
});

describe('dynamic language manager', () => {
  it('adds a language with direction, protects English, archives instead of deleting', async () => {
    const created = await ok('POST', '/api/languages', {
      code: 'om',
      name: 'Oromo',
      nativeName: 'Afaan Oromoo',
      direction: 'ltr',
    });
    const list = await ok('GET', '/api/languages');
    const om = list.find((l: { code: string }) => l.code === 'om');
    expect(om.nativeName).toBe('Afaan Oromoo');

    const enCreated = await ok('POST', '/api/languages', { code: 'en', name: 'English' });
    const refuse = await call('PATCH', `/api/languages/${enCreated.id}`, { enabled: false });
    expect(refuse.statusCode).toBe(400); // English fallback can never be disabled

    await ok('PATCH', `/api/languages/${created.id}`, { enabled: false });
    const after = await ok('GET', '/api/languages?includeDisabled=true');
    expect(after.find((l: { code: string }) => l.code === 'om').enabled).toBe(false);
  });
});

describe('per-user appearance preference', () => {
  it('saves the theme via PATCH /api/auth/me and returns it on the session', async () => {
    await ok('PATCH', '/api/auth/me', { theme: 'dark' });
    const me = await ok('GET', '/api/auth/me');
    expect(me.user.theme).toBe('dark');
    await ok('PATCH', '/api/auth/me', { theme: 'system' });
    const back = await ok('GET', '/api/auth/me');
    expect(back.user.theme).toBe('system');
  });
});

describe('ethiopian calendar display conversion', () => {
  it('converts key Gregorian dates to the Ethiopian calendar', () => {
    expect(toEthiopianDate(new Date(2026, 7, 19))).toMatchObject({ year: 2018, day: 13 });
    expect(toEthiopianDate(new Date(2026, 7, 19)).monthName).toBe('Nehase');
    // Ethiopian New Year (11 Sep 2026 -> 1 Meskerem 2019)
    expect(toEthiopianDate(new Date(2026, 8, 11))).toMatchObject({ year: 2019, month: 1, day: 1 });
    // day before New Year falls in Pagume 2018
    expect(toEthiopianDate(new Date(2026, 8, 10)).year).toBe(2018);
    expect(toEthiopianDate(new Date(2026, 8, 10)).month).toBe(13);
  });
});
