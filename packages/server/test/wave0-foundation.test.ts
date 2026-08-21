import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/index.js';
import { schema } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, type TestTenant } from './helpers.js';
import { login } from '../src/services/auth.js';
import { createUser } from '../src/services/users.js';
import { createParty, listParties, getParty, updateParty } from '../src/services/parties.js';
import { createReceipt, postReceipt, listReceipts, getReceipt } from '../src/services/receiving.js';
import { listTransfers } from '../src/services/transfers.js';
import {
  createBatch,
  completeBatch,
  getBatch,
  listBatches,
  recordQualityTest,
  approveQualityTest,
} from '../src/services/batches.js';
import { createInvoice, confirmInvoice, getInvoice, listInvoices } from '../src/services/sales.js';
import { createPayment, listPayments, applyAllocations, getPayment } from '../src/services/payments.js';
import { createDelivery, listDeliveries, getDelivery } from '../src/services/deliveries.js';
import { saveSettings, getSettings } from '../src/services/settings.js';
import { defineSequence, nextDocNumber, listSequences } from '../src/services/numbering.js';
import { listAudit } from '../src/services/audit.js';
import { listUsers } from '../src/services/users.js';
import { listRoles } from '../src/services/permissions.js';
import { listLanguages, enableLanguage, registerTranslationKeys } from '../src/services/translations.js';
import { rawStockReport, salesReport } from '../src/services/reports.js';
import { stockOverview } from '../src/services/stockview.js';
import { generateRecoveryCodes, recoverWithCode } from '../src/services/recovery.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
import { PLATFORM_KEYS } from '../src/i18n-keys.js';
import { nowIso, AppError } from '../src/util.js';
import { eq } from 'drizzle-orm';

const TODAY = nowIso().slice(0, 10);

let db: Db;
let ta: TestTenant;
let tb: TestTenant;

/** Seed one small but complete operational world inside a tenant. */
function seedWorld(tt: TestTenant, tag: string) {
  const supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: `Supplier ${tag}` });
  const customerId = createParty(tt.ownerCtx, {
    kind: 'customer',
    name: `Customer ${tag}`,
    creditLimit: 10_000_000,
  });
  saveSettings(tt.ownerCtx, 'pricing', {
    categories: ['wholesale'],
    defaultCategory: 'wholesale',
    prices: { [tt.items.pack1kg]: { wholesale: 80 } },
  });
  const { id: rcv } = createReceipt(tt.ownerCtx, {
    supplierId,
    truckNumber: 'T-1',
    driverName: 'D',
    date: TODAY,
    itemId: tt.items.raw,
    entryUomId: tt.uoms.kg,
    netQty: 1000,
    warehouseId: tt.warehouses.a,
  });
  postReceipt(tt.ownerCtx, rcv);
  const lot = db.select().from(schema.lots).where(eq(schema.lots.tenantId, tt.tenantId)).all().at(-1)!;
  const wash = createBatch(tt.ownerCtx, {
    stageCode: 'washing',
    date: TODAY,
    inputLotId: lot.id,
    inputWarehouseId: tt.warehouses.a,
    inputQty: 500,
    inputUomId: tt.uoms.kg,
  });
  completeBatch(tt.ownerCtx, wash.id, { outputQty: 450 });
  // finished stock for a sale: package via iodization->packaging is heavyweight;
  // sell raw instead? raw isn't priced — use a direct pack lot via receipt path:
  // simplest: invoice against pack stock produced through the normal chain
  const iod = createBatch(tt.ownerCtx, {
    stageCode: 'iodization',
    date: TODAY,
    inputBatchId: wash.id,
    inputBatchQty: 450,
    attributes: { iodine_added_kg: 0.02 },
  });
  completeBatch(tt.ownerCtx, iod.id, {});
  recordQualityTest(tt.ownerCtx, iod.id, { targetLevel: '30-40 ppm', actualResult: '34', status: 'passed', date: TODAY });
  approveQualityTest(tt.ownerCtx, iod.id);
  const pkg = createBatch(tt.ownerCtx, {
    stageCode: 'packaging',
    date: TODAY,
    inputBatchId: iod.id,
    inputBatchQty: 400,
  });
  completeBatch(tt.ownerCtx, pkg.id, {
    outputItemId: tt.items.pack1kg,
    unitsProduced: 400,
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
  confirmInvoice(tt.ownerCtx, inv.id);
  const del = createDelivery(tt.ownerCtx, {
    invoiceId: inv.id,
    destination: `Town ${tag}`,
    truckNumber: 'T-2',
    driverName: 'D',
    driverPhone: '1',
    expectedDate: '2099-12-31',
  });
  const pay = createPayment(
    tt.ownerCtx,
    { customerId, date: TODAY, amount: 1000, method: 'cash' },
    { post: true },
  );
  return { supplierId, customerId, lotId: lot.id, invoiceId: inv.id, deliveryId: del.id, paymentId: pay.id, batchId: wash.id, receiptId: rcv };
}

let aWorld: ReturnType<typeof seedWorld>;
let bWorld: ReturnType<typeof seedWorld>;

beforeAll(() => {
  db = testDb();
  registerTranslationKeys(db, PLATFORM_KEYS);
  ta = makeTestTenant(db, 'TA');
  tb = makeTestTenant(db, 'TB');
  makeProcessStages(ta);
  makeProcessStages(tb);
  aWorld = seedWorld(ta, 'A');
  bWorld = seedWorld(tb, 'B');
});

// ---------------------------------------------------------------------------
// E1 — multi-tenant login/recovery disambiguation (D4)
// ---------------------------------------------------------------------------
describe('multi-tenant authentication (D4 fixed)', () => {
  beforeAll(() => {
    createUser(ta.sysCtx, { username: 'shared.worker', displayName: 'Shared A', password: 'password-a', roleId: ta.ownerRoleId });
    createUser(tb.sysCtx, { username: 'shared.worker', displayName: 'Shared B', password: 'password-b', roleId: tb.ownerRoleId });
  });

  it('resolves a shared username via tenant CODE (not UUID) and scopes strictly', () => {
    const a = login(db, { username: 'shared.worker', password: 'password-a', tenantCode: 'TA' });
    expect(a.user.tenantId).toBe(ta.tenantId);
    const b = login(db, { username: 'shared.worker', password: 'password-b', tenantCode: 'TB' });
    expect(b.user.tenantId).toBe(tb.tenantId);
    // right password, WRONG tenant scope -> refused (no cross-tenant fallback)
    expect(() => login(db, { username: 'shared.worker', password: 'password-a', tenantCode: 'TB' })).toThrow(AppError);
    // ambiguous without a tenant code -> fails closed, never guesses a tenant
    expect(() => login(db, { username: 'shared.worker', password: 'password-a' })).toThrow(AppError);
    // single-tenant usernames keep working without any code (Mesob unaffected)
    const solo = login(db, { username: 'owner.ta', password: 'test-password' });
    expect(solo.user.tenantId).toBe(ta.tenantId);
  });

  it('recovery honors tenant scoping for shared usernames', () => {
    const sharedA = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'shared.worker'))
      .all()
      .find((u) => u.tenantId === ta.tenantId)!;
    const codes = generateRecoveryCodes({ db, tenantId: ta.tenantId, user: null }, sharedA.id);
    // ambiguous recovery without tenantCode fails closed
    expect(() => recoverWithCode(db, { username: 'shared.worker', code: codes[0], newPassword: 'fresh-pass-1' })).toThrow(AppError);
    // scoped recovery works and only touches tenant A's account
    recoverWithCode(db, { username: 'shared.worker', code: codes[0], newPassword: 'fresh-pass-1', tenantCode: 'TA' });
    expect(login(db, { username: 'shared.worker', password: 'fresh-pass-1', tenantCode: 'TA' }).user.tenantId).toBe(ta.tenantId);
    expect(login(db, { username: 'shared.worker', password: 'password-b', tenantCode: 'TB' }).user.tenantId).toBe(tb.tenantId);
  });
});

// ---------------------------------------------------------------------------
// E2 — recovery username-enumeration parity (D11)
// ---------------------------------------------------------------------------
describe('recovery gives no username-existence oracle (D11 fixed)', () => {
  it('weak password returns the SAME error for unknown and known usernames', () => {
    const grab = (fn: () => void): AppError => {
      try {
        fn();
      } catch (e) {
        return e as AppError;
      }
      throw new Error('expected throw');
    };
    const unknownWeak = grab(() => recoverWithCode(db, { username: 'ghost.nobody', code: 'AAAA-BBBB-CCCC', newPassword: 'x' }));
    const knownWeak = grab(() => recoverWithCode(db, { username: 'owner.ta', code: 'AAAA-BBBB-CCCC', newPassword: 'x' }));
    expect(unknownWeak.statusCode).toBe(knownWeak.statusCode);
    expect(unknownWeak.message).toBe(knownWeak.message);
    const unknownBad = grab(() => recoverWithCode(db, { username: 'ghost.nobody', code: 'AAAA-BBBB-CCCC', newPassword: 'long-enough-1' }));
    const knownBad = grab(() => recoverWithCode(db, { username: 'owner.ta', code: 'AAAA-BBBB-CCCC', newPassword: 'long-enough-1' }));
    expect(unknownBad.statusCode).toBe(401);
    expect(knownBad.statusCode).toBe(401);
    expect(unknownBad.message).toBe(knownBad.message);
  });
});

// ---------------------------------------------------------------------------
// E3 — unauthenticated rate limiting
// ---------------------------------------------------------------------------
describe('auth rate limiting (failed attempts only)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    _resetRateLimiter();
    app = buildApp({ db });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    _resetRateLimiter();
  });

  it('locks login after 10 failures, even for the then-correct password', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner.tb', password: 'wrong-guess' } });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner.tb', password: 'test-password' } });
    expect(blocked.statusCode).toBe(429);
    // a different username from the same ip is unaffected
    const other = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner.ta', password: 'test-password' } });
    expect(other.statusCode).toBe(200);
    _resetRateLimiter();
    const after = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner.tb', password: 'test-password' } });
    expect(after.statusCode).toBe(200);
  });

  it('successful sign-ins never accumulate towards the limit', async () => {
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner.ta', password: 'test-password' } });
      expect(r.statusCode).toBe(200);
    }
  });

  it('locks the public recovery endpoint after repeated failures', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/recover',
        payload: { username: 'owner.tb', code: 'AAAA-BBBB-CCCC', newPassword: 'long-enough-1' },
      });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/recover',
      payload: { username: 'owner.tb', code: 'AAAA-BBBB-CCCC', newPassword: 'long-enough-1' },
    });
    expect(blocked.statusCode).toBe(429);
    _resetRateLimiter();
  });
});

// ---------------------------------------------------------------------------
// E4 — document-number concurrency (D12)
// ---------------------------------------------------------------------------
describe('document numbering is allocation-safe across connections (D12 fixed)', () => {
  it('interleaved draws from two live connections never repeat a number', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jenify-seq-')), 'seq.sqlite');
    const dbA = createDb(file);
    const dbB = createDb(file);
    const t = makeTestTenant(dbA, 'SEQ');
    defineSequence(t.sysCtx, 'stress', 'STR-', 4);
    const ctxA = { db: dbA, tenantId: t.tenantId, user: null };
    const ctxB = { db: dbB, tenantId: t.tenantId, user: null };
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      seen.add(nextDocNumber(ctxA, 'stress'));
      seen.add(nextDocNumber(ctxB, 'stress'));
    }
    expect(seen.size).toBe(60); // all distinct
    expect(seen.has('STR-0001')).toBe(true);
    expect(seen.has('STR-0060')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E7 — permanent cross-tenant negative-path suite
// ---------------------------------------------------------------------------
describe('tenant isolation: tenant B can never see or touch tenant A', () => {
  it('every list surface returns only the caller tenant rows', () => {
    const bCtx = tb.ownerCtx;
    expect(listParties(bCtx, {}).some((p) => p.name.endsWith(' A'))).toBe(false);
    expect(listReceipts(bCtx).every((r) => r.id !== aWorld.receiptId)).toBe(true);
    expect(listTransfers(bCtx).length).toBe(0);
    expect(listBatches(bCtx).every((b) => b.id !== aWorld.batchId)).toBe(true);
    expect(listInvoices(bCtx).every((i) => i.id !== aWorld.invoiceId)).toBe(true);
    expect(listPayments(bCtx).every((p) => p.id !== aWorld.paymentId)).toBe(true);
    expect(listDeliveries(bCtx).every((d) => d.id !== aWorld.deliveryId)).toBe(true);
    expect(listUsers(bCtx).every((u) => u.username !== 'owner.ta')).toBe(true);
    expect(listRoles(bCtx).length).toBeGreaterThan(0);
    expect(listSequences(bCtx).every((s) => s.tenantId === tb.tenantId)).toBe(true);
    expect(stockOverview(bCtx, {}).every((r) => r.lotId !== aWorld.lotId)).toBe(true);
    const audit = listAudit(bCtx, { limit: 500 });
    // tenant-A entities are named 'Supplier A' / 'Customer A' — none may appear
    expect(
      audit.rows.every(
        (r) => !String(r.summary).includes('Supplier A') && !String(r.summary).includes('Customer A'),
      ),
    ).toBe(true);
    expect(audit.count).toBeGreaterThan(0); // B does see its own audit trail
  });

  it('direct gets and mutations against tenant A ids fail closed', () => {
    const bCtx = tb.ownerCtx;
    expect(() => getParty(bCtx, aWorld.customerId)).toThrow(AppError);
    expect(() => updateParty(bCtx, aWorld.customerId, { name: 'stolen' })).toThrow(AppError);
    expect(() => getReceipt(bCtx, aWorld.receiptId)).toThrow(AppError);
    expect(() => getBatch(bCtx, aWorld.batchId)).toThrow(AppError);
    expect(() => getInvoice(bCtx, aWorld.invoiceId)).toThrow(AppError);
    expect(() => getPayment(bCtx, aWorld.paymentId)).toThrow(AppError);
    expect(() => getDelivery(bCtx, aWorld.deliveryId)).toThrow(AppError);
  });

  it('money can never cross tenants: B payment cannot allocate to A invoice', () => {
    expect(() =>
      applyAllocations(tb.ownerCtx, bWorld.paymentId, [{ invoiceId: aWorld.invoiceId, amount: 1 }]),
    ).toThrow(AppError);
  });

  it('configuration, languages, and reports stay tenant-scoped', () => {
    enableLanguage(ta.ownerCtx, 'am', 'Amharic');
    expect(listLanguages(tb.ownerCtx, { includeDisabled: true }).some((l) => l.code === 'am')).toBe(false);
    saveSettings(ta.ownerCtx, 'general', { calendar: 'ethiopian' });
    expect(getSettings(tb.ownerCtx, 'general')?.data.calendar).not.toBe('ethiopian');
    const bRaw = rawStockReport(tb.ownerCtx, {});
    expect(bRaw.receivedQty).toBe(1_000_000); // only B's own 1,000 kg
    const bSales = salesReport(tb.ownerCtx, {});
    expect(bSales.invoiceCount).toBe(1);
  });

  it('sequences are independent: both tenants minted their own INV-0001', () => {
    const aInv = getInvoice(ta.ownerCtx, aWorld.invoiceId);
    const bInv = getInvoice(tb.ownerCtx, bWorld.invoiceId);
    expect(aInv.docNumber).toBe('INV-0001');
    expect(bInv.docNumber).toBe('INV-0001');
  });
});
