import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, matrixOf, type TestTenant } from './helpers.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { createParty } from '../src/services/parties.js';
import { saveSettings } from '../src/services/settings.js';
import { registerTranslationKeys } from '../src/services/translations.js';
import { PLATFORM_KEYS } from '../src/i18n-keys.js';
import { nowIso } from '../src/util.js';

/**
 * Full local workflow through the REAL HTTP routes with role-scoped sessions:
 * warehouse drafts receiving (cannot approve) -> operations approves ->
 * production washes/iodizes (QC gate) -> packaging -> sales confirms (reserve)
 * -> warehouse prepares, operations dispatches -> finance posts a payment
 * allocated across two invoices -> reports and dashboard reconcile.
 */

const TODAY = nowIso().slice(0, 10);

let db: Db;
let tt: TestTenant;
let app: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(role: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: `${role}.e2e`, password: 'test-password' },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie!;
  cookies[role] = raw.split(';')[0];
}

async function call(
  role: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    payload: payload as object,
    headers: { cookie: cookies[role] },
  });
  return res;
}

async function ok(role: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) {
  const res = await call(role, method, url, payload);
  expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(200);
  return res.json();
}

let supplierId: string;
let customerId: string;

beforeAll(async () => {
  db = testDb();
  registerTranslationKeys(db, PLATFORM_KEYS);
  tt = makeTestTenant(db, 'E2E');
  makeProcessStages(tt);
  supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Afdera Supplier' });
  customerId = createParty(tt.ownerCtx, { kind: 'customer', name: 'North Wholesale', creditLimit: 1_000_000 });
  saveSettings(tt.ownerCtx, 'pricing', {
    categories: ['retail', 'wholesale', 'distributor'],
    prices: { [tt.items.pack1kg]: { wholesale: 80 } },
  });
  saveSettings(tt.ownerCtx, 'vat', { enabled: true, ratePct: 15 });

  // Mesob-style roles (test-tenant configuration)
  const mk = (code: string, matrix: Parameters<typeof matrixOf>[0]) => {
    const roleId = createRole(tt.sysCtx, { code, name: code, matrix: matrixOf(matrix) });
    createUser(tt.sysCtx, {
      username: `${code}.e2e`,
      displayName: `${code} user`,
      password: 'test-password',
      roleId,
    });
  };
  mk('warehouse', [
    ['dashboard', ['view']],
    ['inventory', ['view', 'create', 'edit']],
    ['production', ['view']],
    ['delivery', ['view', 'create', 'edit']],
  ]);
  mk('operations', [
    ['dashboard', ['view']],
    ['inventory', ['view', 'create', 'edit', 'approve']],
    ['production', ['view', 'create', 'edit']],
    ['quality', ['view', 'create', 'approve']],
    ['delivery', ['view', 'create', 'edit', 'approve']],
    ['reports', ['view']],
    ['audit', ['view']],
  ]);
  mk('sales', [
    ['dashboard', ['view']],
    ['inventory', ['view']],
    ['parties', ['view', 'create', 'edit']],
    ['sales', ['view', 'create', 'edit', 'view_financial']],
    ['credit', ['view']],
    ['delivery', ['view', 'create']],
  ]);
  mk('finance', [
    ['dashboard', ['view', 'view_financial']],
    ['sales', ['view', 'view_financial']],
    ['credit', ['view', 'create', 'edit', 'approve', 'view_financial']],
    ['payments', ['view', 'create', 'edit', 'approve', 'view_financial']],
    ['reports', ['view', 'export', 'view_financial']],
  ]);

  app = buildApp({ db });
  await app.ready();
  for (const r of ['warehouse', 'operations', 'sales', 'finance']) await login(r);
});

afterAll(async () => {
  await app.close();
});

let receiptId: string;
let washId: string;
let iodId: string;
let invoiceA: string;
let invoiceB: string;
let deliveryId: string;

describe('end-to-end factory workflow over HTTP', () => {
  it('warehouse drafts receiving but cannot approve it', async () => {
    const draft = await ok('warehouse', 'POST', '/api/receipts', {
      supplierId,
      source: 'Afdera',
      truckNumber: 'ET-3-48219',
      driverName: 'Solomon G.',
      date: TODAY,
      itemId: tt.items.raw,
      entryUomId: tt.uoms.ton,
      grossQty: 10.5,
      netQty: 10,
      warehouseId: tt.warehouses.a,
    });
    receiptId = draft.id;
    const forbidden = await call('warehouse', 'POST', `/api/receipts/${receiptId}/post`);
    expect(forbidden.statusCode).toBe(403);
    // stock unchanged by the draft
    const stock = await ok('warehouse', 'GET', '/api/stock?kind=raw_material');
    expect(stock.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0)).toBe(0);
  });

  it('operations approves receiving; stock increases as a traceable lot', async () => {
    await ok('operations', 'POST', `/api/receipts/${receiptId}/post`);
    const stock = await ok('operations', 'GET', '/api/stock?kind=raw_material');
    expect(stock.length).toBe(1);
    expect(stock[0].onHand).toBe(10_000_000); // 10t in milli-kg
    expect(stock[0].lotNumber).toBe('RAW-0001');
  });

  it('operations transfers 5t A->B keeping the factory total unchanged', async () => {
    const stock = await ok('operations', 'GET', '/api/stock?kind=raw_material');
    await ok('operations', 'POST', '/api/transfers', {
      itemId: tt.items.raw,
      lotId: stock[0].lotId,
      entryUomId: tt.uoms.kg,
      qty: 5000,
      fromWarehouseId: tt.warehouses.a,
      toWarehouseId: tt.warehouses.b,
      date: TODAY,
      reason: 'Balance production supply',
      andPost: true,
    });
    const after = await ok('operations', 'GET', '/api/stock?kind=raw_material');
    const total = after.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0);
    expect(total).toBe(10_000_000);
    expect(after.length).toBe(2);
  });

  it('production washes 5t from warehouse A with loss calculated', async () => {
    const stock = await ok('operations', 'GET', '/api/stock?kind=raw_material');
    const inA = stock.find((r: { warehouseCode: string }) => r.warehouseCode === 'A')!;
    const created = await ok('operations', 'POST', '/api/batches', {
      stageCode: 'washing',
      date: TODAY,
      inputLotId: inA.lotId,
      inputWarehouseId: inA.warehouseId,
      inputQty: 5000,
      inputUomId: tt.uoms.kg,
      andStart: true,
    });
    washId = created.id;
    await ok('operations', 'POST', `/api/batches/${washId}/complete`, { outputQty: 4600 });
    const detail = await ok('operations', 'GET', `/api/batches/${washId}`);
    expect(detail.batch.lossQty).toBe(400_000); // 400 kg
  });

  it('iodization records iodine, fails QC, retests, passes, and is approved', async () => {
    const created = await ok('operations', 'POST', '/api/batches', {
      stageCode: 'iodization',
      date: TODAY,
      inputBatchId: washId,
      inputBatchQty: 4600,
      attributes: { iodine_added_kg: 0.21 },
    });
    iodId = created.id;
    await ok('operations', 'POST', `/api/batches/${iodId}/complete`, { outputQty: 4580 });

    await ok('operations', 'POST', `/api/batches/${iodId}/qc-test`, {
      targetLevel: '30-40 ppm',
      actualResult: '22 ppm',
      status: 'failed',
      date: TODAY,
    });
    // packaging from a failed batch is blocked
    const blocked = await call('operations', 'POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 1000,
    });
    expect(blocked.statusCode).toBe(400);

    await ok('operations', 'POST', `/api/batches/${iodId}/qc-test`, {
      targetLevel: '30-40 ppm',
      actualResult: '34 ppm',
      status: 'passed',
      date: TODAY,
    });
    await ok('operations', 'POST', `/api/batches/${iodId}/qc-approve`);
    const detail = await ok('operations', 'GET', `/api/batches/${iodId}`);
    expect(detail.batch.qcStatus).toBe('passed');
    expect(detail.tests.length).toBe(2);
  });

  it('packaging converts approved salt into finished packs in warehouse B', async () => {
    const created = await ok('operations', 'POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 4000,
    });
    await ok('operations', 'POST', `/api/batches/${created.id}/complete`, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 3980,
      unitsRejected: 20,
      outputWarehouseId: tt.warehouses.b,
    });
    const stock = await ok('operations', 'GET', '/api/stock?kind=finished_good');
    expect(stock[0].onHand).toBe(3_960_000); // 3,960 packs
    // genealogy reaches back to the raw lot
    const gen = await ok('operations', 'GET', `/api/batches/${created.id}/genealogy`);
    expect(gen.backward.map((n: { label: string }) => n.label.split('-')[0])).toEqual([
      'IOD',
      'WSH',
      'RAW',
    ]);
  });

  it('sales confirms two invoices; stock reserves; warehouse cannot see prices', async () => {
    const inv1 = await ok('sales', 'POST', '/api/invoices', {
      customerId,
      date: TODAY,
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: '2099-12-31',
      lines: [
        { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 2000, entryUomId: tt.uoms.piece },
      ],
      andConfirm: true,
    });
    invoiceA = inv1.id;
    const inv2 = await ok('sales', 'POST', '/api/invoices', {
      customerId,
      date: TODAY,
      priceCategory: 'wholesale',
      paymentTerm: 'credit',
      dueDate: '2099-12-31',
      lines: [
        { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 100, entryUomId: tt.uoms.piece },
      ],
      andConfirm: true,
    });
    invoiceB = inv2.id;
    expect(inv1.totalCents).toBe(184_000_00);
    expect(inv2.totalCents).toBe(9_200_00);

    const stock = await ok('sales', 'GET', '/api/stock?kind=finished_good');
    expect(stock.reduce((s: number, r: { reserved: number }) => s + r.reserved, 0)).toBe(2_100_000);

    // warehouse role sees invoices without money
    const masked = await ok('warehouse', 'GET', '/api/deliveries');
    expect(Array.isArray(masked)).toBe(true);
    const salesView = await call('warehouse', 'GET', '/api/invoices');
    expect(salesView.statusCode).toBe(403); // no sales.view at all
  });

  it('delivery lifecycle: warehouse loads, operations dispatches, stock leaves', async () => {
    const created = await ok('warehouse', 'POST', '/api/deliveries', {
      invoiceId: invoiceA,
      destination: 'Adigrat',
      truckNumber: 'ET-3-77210',
      driverName: 'Tesfay H.',
    });
    deliveryId = created.id;
    await ok('warehouse', 'POST', `/api/deliveries/${deliveryId}/loading`);
    // warehouse lacks delivery.approve -> cannot dispatch
    const forbidden = await call('warehouse', 'POST', `/api/deliveries/${deliveryId}/dispatch`);
    expect(forbidden.statusCode).toBe(403);
    await ok('operations', 'POST', `/api/deliveries/${deliveryId}/dispatch`);
    const stock = await ok('operations', 'GET', '/api/stock?kind=finished_good');
    const total = stock.reduce((s: number, r: { onHand: number }) => s + r.onHand, 0);
    expect(total).toBe(1_960_000); // 3,960 - 2,000 dispatched
    await ok('operations', 'POST', `/api/deliveries/${deliveryId}/delivered`, {
      actualDate: TODAY,
      receivedBy: 'Shop Manager',
    });
  });

  it('finance posts one payment allocated across both invoices', async () => {
    await ok('finance', 'POST', '/api/payments', {
      customerId,
      date: TODAY,
      amount: 100_000,
      method: 'bank_transfer',
      referenceNumber: 'BANK-REF-1',
      allocations: [
        { invoiceId: invoiceA, amount: 90_800 },
        { invoiceId: invoiceB, amount: 9_200 },
      ],
      post: true,
    });
    const credit = await ok('finance', 'GET', '/api/credit');
    expect(credit.outstandingCents).toBe(93_200_00); // 193,200 - 100,000
    const rowB = credit.rows.find((r: { invoiceId: string }) => r.invoiceId === invoiceB)!;
    expect(rowB.status).toBe('paid');
  });

  it('reports and dashboard reconcile; sales report blocked for operations', async () => {
    const salesReport = await ok('finance', 'GET', '/api/reports/sales');
    expect(salesReport.totalCents).toBe(193_200_00);
    expect(salesReport.paidCents).toBe(100_000_00);
    const noFin = await call('operations', 'GET', '/api/reports/sales');
    expect(noFin.statusCode).toBe(403);

    const production = await ok('operations', 'GET', '/api/reports/production');
    expect(production.inputQty).toBe((5000 + 4600) * 1000);

    const dash = await ok('finance', 'GET', '/api/dashboard');
    expect(dash.finance.outstandingCents).toBe(93_200_00);

    // audit trail captured the whole story
    const audit = await ok('operations', 'GET', '/api/audit?limit=500');
    expect(audit.count).toBeGreaterThan(20);
    const forbiddenAudit = await call('warehouse', 'GET', '/api/audit');
    expect(forbiddenAudit.statusCode).toBe(403);
  });
});
