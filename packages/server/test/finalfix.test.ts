import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, schema, type Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, type TestTenant } from './helpers.js';
import { createParty } from '../src/services/parties.js';
import { createWarehouse, updateWarehouse, createItem, updateItem, getItem } from '../src/services/masterdata.js';
import {
  enableLanguage,
  deleteLanguage,
  languageEverUsed,
  listLanguages,
  upsertTranslation,
  registerTranslationKeys,
} from '../src/services/translations.js';
import { saveSettings } from '../src/services/settings.js';
import { PLATFORM_KEYS } from '../src/i18n-keys.js';
import { createReceipt, postReceipt } from '../src/services/receiving.js';
import { createBatch, completeBatch, recordQualityTest, approveQualityTest } from '../src/services/batches.js';
import { createInvoice, confirmInvoice } from '../src/services/sales.js';
import { createDelivery, dispatchDelivery, markDelivered } from '../src/services/deliveries.js';
import { createPayment, getPayment } from '../src/services/payments.js';
import { postSimpleTxn } from '../src/services/simpletxn.js';
import { defineSequence } from '../src/services/numbering.js';
import { packagingReport, deliveryReport, qualityReport, simpleItemReport } from '../src/services/reports.js';
import { createStage, updateStage, listStages } from '../src/services/production.js';
import {
  initFreshProductionTenant,
  previewFreshProductionTenant,
  updateTenantBranding,
  isValidTimezone,
} from '../src/services/provisioning.js';
import { createUser } from '../src/services/users.js';
import { generateRecoveryCodes, recoverWithCode } from '../src/services/recovery.js';
import { login, resolveSession } from '../src/services/auth.js';
import { listAudit } from '../src/services/audit.js';
import { nowIso, AppError } from '../src/util.js';
import { eq, and } from 'drizzle-orm';

const TODAY = nowIso().slice(0, 10);

let db: Db;
let tt: TestTenant;
let supplierId: string;
let customerId: string;
let rawLotId: string;
let sackItemId: string;

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
  return db.select().from(schema.lots).where(eq(schema.lots.tenantId, tt.tenantId)).all().at(-1)!.id;
}

beforeAll(() => {
  db = testDb();
  registerTranslationKeys(db, PLATFORM_KEYS);
  tt = makeTestTenant(db, 'FFX');
  makeProcessStages(tt);
  supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Supplier' });
  customerId = createParty(tt.ownerCtx, { kind: 'customer', name: 'Customer', creditLimit: 10_000_000 });
  sackItemId = createItem(tt.sysCtx, {
    code: 'SACK',
    name: 'Empty Sack',
    kind: 'consumable',
    trackingMode: 'none',
    baseUomId: tt.uoms.piece,
  });
  defineSequence(tt.sysCtx, 'sack', 'SACK-', 4);
  saveSettings(tt.ownerCtx, 'pricing', {
    categories: ['wholesale'],
    defaultCategory: 'wholesale',
    prices: { [tt.items.pack1kg]: { wholesale: 80 } },
  });
  saveSettings(tt.ownerCtx, 'vat', { enabled: true, ratePct: 15 });
  rawLotId = receive(10_000, tt.warehouses.a);
});

describe('dynamic language delete eligibility', () => {
  it('blocks while translations exist, re-allows after they are cleared', () => {
    const id = enableLanguage(tt.ownerCtx, 'am', 'Amharic');
    upsertTranslation(tt.ownerCtx, 'nav.dashboard', 'am', 'ዳሽቦርድ');
    expect(languageEverUsed(tt.ownerCtx, 'am')).toBe(true);
    expect(() => deleteLanguage(tt.ownerCtx, id)).toThrow(/archive/i);
    expect(listLanguages(tt.ownerCtx).find((l) => l.code === 'am')!.deletable).toBe(false);

    // founder clears the translation -> eligibility re-evaluates DYNAMICALLY
    upsertTranslation(tt.ownerCtx, 'nav.dashboard', 'am', '');
    expect(languageEverUsed(tt.ownerCtx, 'am')).toBe(false);
    expect(listLanguages(tt.ownerCtx).find((l) => l.code === 'am')!.deletable).toBe(true);
    deleteLanguage(tt.ownerCtx, id); // now allowed
  });

  it('a user dependency also blocks deletion until freed', () => {
    const id = enableLanguage(tt.ownerCtx, 'fr', 'French');
    createUser(tt.sysCtx, {
      username: 'french.ffx',
      displayName: 'French User',
      password: 'test-password',
      roleId: tt.ownerRoleId,
      language: 'fr',
    });
    expect(listLanguages(tt.ownerCtx).find((l) => l.code === 'fr')!.deletable).toBe(false);
    expect(() => deleteLanguage(tt.ownerCtx, id)).toThrow(/archive/i);
  });

  it('English is never deletable regardless of state', () => {
    enableLanguage(tt.ownerCtx, 'en', 'English');
    expect(listLanguages(tt.ownerCtx).find((l) => l.code === 'en')!.deletable).toBe(false);
  });
});

describe('report field additions', () => {
  let iodId: string;

  beforeAll(() => {
    const wash = createBatch(tt.ownerCtx, {
      stageCode: 'washing',
      date: TODAY,
      inputLotId: rawLotId,
      inputWarehouseId: tt.warehouses.a,
      inputQty: 5000,
      inputUomId: tt.uoms.kg,
    });
    completeBatch(tt.ownerCtx, wash.id, { outputQty: 4600 });
    const iod = createBatch(tt.ownerCtx, {
      stageCode: 'iodization',
      date: TODAY,
      inputBatchId: wash.id,
      inputBatchQty: 4600,
      attributes: { iodine_added_kg: 0.23 },
    });
    iodId = iod.id;
    completeBatch(tt.ownerCtx, iod.id, {});
    recordQualityTest(tt.ownerCtx, iod.id, { targetLevel: '30-40 ppm', actualResult: '34', status: 'passed', date: TODAY });
  });

  it('quality report separates QC result from release status', () => {
    // test PASSED but release not yet granted -> released must NOT be implied
    let r = qualityReport(tt.ownerCtx, {});
    let row = r.breakdown[0];
    expect(row.qcResult).toBe('passed');
    expect(row.releaseStatus).toBe('pending');
    approveQualityTest(tt.ownerCtx, iodId);
    r = qualityReport(tt.ownerCtx, {});
    row = r.breakdown[0];
    expect(row.qcResult).toBe('passed');
    expect(row.releaseStatus).toBe('released');
  });

  it('packaging report includes input received and destination warehouse', () => {
    const pkg = createBatch(tt.ownerCtx, {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 4000,
    });
    completeBatch(tt.ownerCtx, pkg.id, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 4000,
      unitsRejected: 20,
      outputWarehouseId: tt.warehouses.b,
    });
    const r = packagingReport(tt.ownerCtx, {});
    const row = r.breakdown[0];
    expect(row.inputQty).toBe(4_000_000); // 4,000 kg received into packaging
    expect(row.warehouseCode).toBe('B'); // destination warehouse
    expect(row.goodUnits).toBe(3_980_000);
  });

  it('delivery report carries the driver', () => {
    const inv = createInvoice(tt.ownerCtx, {
      customerId,
      date: TODAY,
      paymentTerm: 'credit',
      dueDate: '2099-12-31',
      lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 100, entryUomId: tt.uoms.piece }],
    });
    confirmInvoice(tt.ownerCtx, inv.id);
    const del = createDelivery(tt.ownerCtx, {
      invoiceId: inv.id,
      destination: 'Adigrat',
      truckNumber: 'T-7',
      driverName: 'Tesfay H.',
      driverPhone: '+251 911 000 404',
      expectedDate: '2099-12-31',
    });
    dispatchDelivery(tt.ownerCtx, del.id);
    const r = deliveryReport(tt.ownerCtx, {});
    expect(r.breakdown.find((b) => b.deliveryNumber === del.docNumber)!.driverName).toBe('Tesfay H.');
  });

  it('empty sacks report computes the row total amount', () => {
    postSimpleTxn(tt.ownerCtx, {
      itemId: sackItemId,
      warehouseId: tt.warehouses.a,
      type: 'collect',
      qty: 100,
      date: TODAY,
      docSeqKey: 'sack',
    });
    postSimpleTxn(tt.ownerCtx, {
      itemId: sackItemId,
      warehouseId: tt.warehouses.a,
      type: 'sell',
      qty: 40,
      buyer: 'Trader',
      unitPrice: 10,
      date: TODAY,
      docSeqKey: 'sack',
    });
    const r = simpleItemReport(tt.ownerCtx, sackItemId, {});
    const sale = r.breakdown.find((b) => b.type === 'sell')!;
    expect(sale.totalCents).toBe(40_000); // 40 x ETB 10 = ETB 400.00
    const collect = r.breakdown.find((b) => b.type === 'collect')!;
    expect(collect.totalCents).toBeNull();
  });
});

describe('setup wizard configurability', () => {
  it('creates and edits products from configuration APIs', () => {
    const id = createItem(tt.ownerCtx, {
      code: 'FG500',
      name: 'Salt 500g',
      kind: 'finished_good',
      trackingMode: 'lot',
      baseUomId: tt.uoms.piece,
      unitWeightKg: 0.5,
      sellable: true,
    });
    updateItem(tt.ownerCtx, id, { name: 'Iodized Salt 500g', sellable: false });
    let item = getItem(tt.ownerCtx, id);
    expect(item.name).toBe('Iodized Salt 500g');
    expect(item.sellable).toBe(false);
    updateItem(tt.ownerCtx, id, { active: false });
    item = getItem(tt.ownerCtx, id);
    expect(item.active).toBe(false);
    const audit = listAudit(tt.ownerCtx, { search: 'item_update', scope: 'all' });
    expect(audit.count).toBeGreaterThan(0);
  });

  it('edits production stages: order, policy, QC gate, enable/disable', () => {
    const stage = createStage(tt.ownerCtx, {
      code: 'drying',
      nameKey: 'stage.drying',
      sequence: 9,
      inputSource: 'prior_batch',
      outputForm: 'bulk',
      outputPolicy: 'measured',
      docSeqKey: 'production.drying',
    });
    defineSequence(tt.ownerCtx, 'production.drying', 'DRY-', 4);
    updateStage(tt.ownerCtx, stage, { outputPolicy: 'conserved', requiresQc: true, sequence: 4 });
    const all = listStages(tt.ownerCtx, { includeInactive: true });
    const dry = all.find((s) => s.code === 'drying')!;
    expect(dry.outputPolicy).toBe('conserved');
    expect(dry.requiresQc).toBe(true);
    expect(dry.sequence).toBe(4);
    // disable removes it from the normal (active) stage list
    updateStage(tt.ownerCtx, stage, { active: false });
    expect(listStages(tt.ownerCtx).some((s) => s.code === 'drying')).toBe(false);
    expect(listStages(tt.ownerCtx, { includeInactive: true }).some((s) => s.code === 'drying')).toBe(true);
    // Mesob's working chain stays intact
    expect(listStages(tt.ownerCtx).map((s) => s.code)).toEqual(['washing', 'iodization', 'packaging']);
    expect(() => updateStage(tt.ownerCtx, stage, { outputPolicy: 'weird' as never })).toThrow(/policy/);
  });
});

describe('timezone configuration', () => {
  it('validates identifiers, saves, and audits without touching stored data', () => {
    expect(isValidTimezone('Africa/Addis_Ababa')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(() => updateTenantBranding(tt.ownerCtx, { timezone: 'Not/AZone' })).toThrow(/timezone/i);
    updateTenantBranding(tt.ownerCtx, { timezone: 'Africa/Nairobi' });
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, tt.tenantId)).get()!;
    expect(tenant.timezone).toBe('Africa/Nairobi');
    const audit = listAudit(tt.ownerCtx, { search: 'timezone', scope: 'all' });
    expect(audit.count).toBeGreaterThan(0);
    updateTenantBranding(tt.ownerCtx, { timezone: 'Africa/Addis_Ababa' }); // restore
  });
});

describe('simple multi-currency payments', () => {
  it('converts a configured foreign currency once at the stored rate', () => {
    saveSettings(tt.ownerCtx, 'currency', {
      currencies: [{ code: 'USD', name: 'US Dollar', active: true }],
      rates: { USD: 150 },
    });
    const { id } = createPayment(
      tt.ownerCtx,
      { customerId, date: TODAY, amount: 100, method: 'cash', currency: 'USD' },
      { post: true },
    );
    const p = getPayment(tt.ownerCtx, id);
    expect(p.amountCents).toBe(1_500_000); // ETB 15,000 in cents — accounting currency
    expect(p.currency).toBe('USD');
    expect(p.fxRate).toBe(150);
    expect(p.originalAmountCents).toBe(10_000); // USD 100.00
  });

  it('default-currency payments stay exactly as before (no corruption)', () => {
    const { id } = createPayment(
      tt.ownerCtx,
      { customerId, date: TODAY, amount: 500, method: 'cash' },
      { post: true },
    );
    const p = getPayment(tt.ownerCtx, id);
    expect(p.amountCents).toBe(50_000);
    expect(p.currency).toBeNull();
    expect(p.fxRate).toBeNull();
  });

  it('rejects unconfigured currencies and missing rates', () => {
    expect(() =>
      createPayment(tt.ownerCtx, { customerId, date: TODAY, amount: 10, method: 'cash', currency: 'EUR' }, { post: true }),
    ).toThrow(/not configured/i);
    saveSettings(tt.ownerCtx, 'currency', {
      currencies: [
        { code: 'USD', name: 'US Dollar', active: true },
        { code: 'GBP', name: 'Pound', active: true },
      ],
      rates: { USD: 150 },
    });
    expect(() =>
      createPayment(tt.ownerCtx, { customerId, date: TODAY, amount: 10, method: 'cash', currency: 'GBP' }, { post: true }),
    ).toThrow(/rate/i);
  });
});

describe('fresh production tenant: approved configuration only', () => {
  it('copies only explicitly approved warehouses/languages; preview matches', () => {
    // an ACTIVE test warehouse exists — being active must NOT be enough to copy
    createWarehouse(tt.sysCtx, { code: 'TSTX', name: 'test warehouse' });
    enableLanguage(tt.ownerCtx, 'tr', 'Turkish (test)');

    const selection = { warehouseCodes: ['A', 'B'], languageCodes: ['en'] };
    const preview = previewFreshProductionTenant(db, tt.tenantId, selection);
    expect(preview.willCopy.warehouses).toHaveLength(2);
    expect(String(preview.willNotCopy.unapprovedWarehouses)).toContain('TSTX');
    expect(String(preview.willNotCopy.unapprovedLanguages)).toContain('tr');
    expect(preview.willNotCopy.transactions).toContain('invoices');

    const { tenantId } = initFreshProductionTenant(db, {
      sourceTenantId: tt.tenantId,
      code: 'ffx-prod',
      name: 'FFX Production',
      ownerUsername: 'ffx.owner',
      ownerPassword: 'go-live-pass',
      selection,
    });
    const rows = <T extends { tenantId: string }>(all: T[]) => all.filter((r) => r.tenantId === tenantId);
    expect(rows(db.select().from(schema.warehouses).all()).map((w) => w.code).sort()).toEqual(['A', 'B']);
    expect(rows(db.select().from(schema.tenantLanguages).all()).map((l) => l.code)).toEqual(['en']);
    expect(rows(db.select().from(schema.salesInvoices).all()).length).toBe(0);
    expect(rows(db.select().from(schema.goodsReceipts).all()).length).toBe(0);
    expect(rows(db.select().from(schema.parties).all()).length).toBe(0);
  });

  it('refuses a selection naming unknown or inactive warehouses', () => {
    expect(() =>
      initFreshProductionTenant(db, {
        sourceTenantId: tt.tenantId,
        code: 'ffx-prod2',
        name: 'X',
        ownerUsername: 'x.owner',
        ownerPassword: 'pass-123',
        selection: { warehouseCodes: ['A', 'NOPE'] },
      }),
    ).toThrow(/NOPE/);
    expect(() =>
      initFreshProductionTenant(db, {
        sourceTenantId: tt.tenantId,
        code: 'ffx-prod3',
        name: 'X',
        ownerUsername: 'x.owner',
        ownerPassword: 'pass-123',
        selection: { warehouseCodes: [] },
      }),
    ).toThrow(/Explicitly list/);
  });
});

describe('security regression: recovery flow after rebrand', () => {
  it('full lifecycle: no username disclosure, single use, sessions invalidated, audited', () => {
    const username = 'owner.ffx';
    // old session becomes invalid after recovery
    const session = login(db, { username, password: 'test-password' });
    expect(resolveSession(db, session.token)).not.toBeNull();

    const codes = generateRecoveryCodes(tt.ownerCtx, tt.ownerUserId);

    // unknown username and bad code fail with the SAME error shape
    let unknownErr: AppError | null = null;
    let badCodeErr: AppError | null = null;
    try {
      recoverWithCode(db, { username: 'ghost.user', code: codes[0], newPassword: 'irrelevant-1' });
    } catch (e) {
      unknownErr = e as AppError;
    }
    try {
      recoverWithCode(db, { username, code: 'AAAA-BBBB-CCCC', newPassword: 'irrelevant-1' });
    } catch (e) {
      badCodeErr = e as AppError;
    }
    expect(unknownErr?.statusCode).toBe(401);
    expect(badCodeErr?.statusCode).toBe(401);
    expect(unknownErr?.message).toBe(badCodeErr?.message); // no user-existence leak

    recoverWithCode(db, { username, code: codes[0], newPassword: 'fresh-pass-9' });
    // previous session is revoked immediately
    expect(resolveSession(db, session.token)).toBeNull();
    // code consumed; new password works; old fails
    expect(() => recoverWithCode(db, { username, code: codes[0], newPassword: 'again-1' })).toThrow(AppError);
    expect(() => login(db, { username, password: 'test-password' })).toThrow(AppError);
    login(db, { username, password: 'fresh-pass-9' });
    // plaintext codes are never stored
    const stored = db
      .select()
      .from(schema.recoveryCodes)
      .where(and(eq(schema.recoveryCodes.tenantId, tt.tenantId), eq(schema.recoveryCodes.userId, tt.ownerUserId)))
      .all();
    expect(stored.every((r) => !codes.includes(r.codeHash))).toBe(true);
    const audit = listAudit(tt.ownerCtx, { search: 'recovery', scope: 'all' });
    expect(audit.count).toBeGreaterThanOrEqual(3); // generate + failed + used
    recoverWithCode(db, { username, code: codes[1], newPassword: 'test-password' }); // restore
  });
});

describe('JENIFY OS public branding', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp({ db });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('login-info stays tenant-first (Mesob-style identity, platform underneath)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/login-info' });
    expect(res.json().name).toBe('FFX Test Factory'); // tenant identity, not JENIFY OS
  });

  it('falls back to the JENIFY OS product name when no tenant exists', async () => {
    const emptyDb = createDb(':memory:');
    const emptyApp = buildApp({ db: emptyDb });
    await emptyApp.ready();
    const res = await emptyApp.inject({ method: 'GET', url: '/api/login-info' });
    expect(res.json().name).toBe('JENIFY OS');
    await emptyApp.close();
  });
});
