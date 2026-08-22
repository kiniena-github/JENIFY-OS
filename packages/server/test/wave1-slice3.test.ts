import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, makeTestTenant, makeProcessStages, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import type { Ctx } from '../src/services/context.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import { createParty } from '../src/services/parties.js';
import { previewAction, executeAction, listActionCatalog } from '../src/services/aiActions.js';
import { applySyncOp } from '../src/services/syncops.js';
import { ownerBrief } from '../src/services/brief.js';
import { getReceipt } from '../src/services/receiving.js';
import { createDelivery, dispatchDelivery, getDelivery } from '../src/services/deliveries.js';
import { createInvoice, confirmInvoice } from '../src/services/sales.js';
import { saveSettings } from '../src/services/settings.js';
import { createReceipt, postReceipt, listReceipts } from '../src/services/receiving.js';
import { newId, nowIso } from '../src/util.js';

let db: Db;
let tt: TestTenant;

function userCtx(userId: string): Ctx {
  return { db, tenantId: tt.tenantId, user: buildSessionUser(db, userId)! };
}

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'W1S3');
});

// ---------------------------------------------------------------------------
// AI safe-action substrate — preview → confirm → execute, risk-gated
// ---------------------------------------------------------------------------
describe('AI safe-action substrate', () => {
  function draftReceivingParams() {
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'Afdera' });
    return { supplierId, date: '2026-08-22', itemId: tt.items.raw, entryUomId: tt.uoms.ton, netQty: 5, warehouseId: tt.warehouses.a };
  }

  it('preview is side-effect free and returns a confirmation token for a draft action', () => {
    const params = draftReceivingParams();
    const preview = previewAction(tt.ownerCtx, 'draft.receiving', params);
    expect(preview.risk).toBe('draft');
    expect(preview.executable).toBe(true);
    expect(preview.confirmationToken).toBeTruthy();
    // preview created nothing — no result ref, and listReceipts is still empty
    expect((preview as { resultRef?: string }).resultRef).toBeUndefined();
    expect(listReceipts(tt.ownerCtx)).toHaveLength(0);
  });

  it('execute WITHOUT a valid confirmation token is refused', () => {
    const params = draftReceivingParams();
    expect(() => executeAction(tt.ownerCtx, 'draft.receiving', params, {})).toThrowError(/previewed and confirmed/);
    expect(() => executeAction(tt.ownerCtx, 'draft.receiving', params, { confirmationToken: 'forged' })).toThrowError(/previewed and confirmed/);
  });

  it('execute WITH the preview token creates the draft through the normal domain API', () => {
    const params = draftReceivingParams();
    const preview = previewAction(tt.ownerCtx, 'draft.receiving', params);
    const result = executeAction(tt.ownerCtx, 'draft.receiving', params, { confirmationToken: preview.confirmationToken });
    expect(result.resultRef).toBeTruthy();
    // it is a real DRAFT receipt (reversible, not posted)
    const receipt = getReceipt(tt.ownerCtx, result.resultRef);
    expect(receipt.lifecycle).toBe('draft');
  });

  it('a token is bound to the exact params — changing params invalidates it', () => {
    const params = draftReceivingParams();
    const preview = previewAction(tt.ownerCtx, 'draft.receiving', params);
    const tampered = { ...params, netQty: 9999 };
    expect(() => executeAction(tt.ownerCtx, 'draft.receiving', tampered, { confirmationToken: preview.confirmationToken })).toThrowError(/previewed and confirmed/);
  });

  it('high-risk (post) actions are registered but refuse to execute', () => {
    // even previewing is allowed (permission held), but execute is gated
    const preview = previewAction(tt.ownerCtx, 'post.receiving', { receiptId: newId() });
    expect(preview.executable).toBe(false);
    expect(preview.confirmationToken).toBeUndefined();
    expect(() => executeAction(tt.ownerCtx, 'post.receiving', { receiptId: newId() }, { confirmationToken: 'x' })).toThrowError(/not enabled/);
  });

  it('permission is fail-closed: a user without the action permission cannot preview or execute', () => {
    const roleId = createRole(tt.sysCtx, { code: 'viewer', name: 'Viewer', matrix: matrixOf([['inventory', ['view']]]) });
    const uid = createUser(tt.sysCtx, { username: 'v', displayName: 'V', password: 'test-password', roleId });
    expect(() => previewAction(userCtx(uid), 'draft.receiving', draftReceivingParams())).toThrowError(/permission/);
  });

  it('catalog exposes risk + executable flags', () => {
    const cat = listActionCatalog();
    expect(cat.find((a) => a.id === 'draft.receiving')?.executable).toBe(true);
    expect(cat.find((a) => a.id === 'post.receiving')?.executable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Offline O2 #2 — delivery confirmation
// ---------------------------------------------------------------------------
describe('Offline delivery confirmation (O2 #2)', () => {
  function dispatchedDelivery(): string {
    // stock in, invoice, confirm (reserve), delivery, dispatch
    saveSettings(tt.ownerCtx, 'pricing', {
      categories: ['retail'],
      prices: { [tt.items.pack1kg]: { retail: 50 } },
    });
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'Sup' });
    const customerId = createParty(tt.sysCtx, { kind: 'customer', name: 'Cust' });
    const r = createReceipt(tt.ownerCtx, { supplierId, date: '2026-08-01', itemId: tt.items.pack1kg, entryUomId: tt.uoms.piece, netQty: 100, warehouseId: tt.warehouses.a });
    postReceipt(tt.ownerCtx, r.id);
    const inv = createInvoice(tt.ownerCtx, { customerId, date: nowIso().slice(0, 10), paymentTerm: 'credit', dueDate: '2026-12-31', priceCategory: 'retail', lines: [{ itemId: tt.items.pack1kg, warehouseId: tt.warehouses.a, qty: 10, entryUomId: tt.uoms.piece }] });
    confirmInvoice(tt.ownerCtx, inv.id);
    const del = createDelivery(tt.ownerCtx, { invoiceId: inv.id, destination: 'Mekelle', truckNumber: 'ET-1234', driverName: 'Dawit', driverPhone: '+251900000000', expectedDate: nowIso().slice(0, 10) });
    dispatchDelivery(tt.ownerCtx, del.id, {});
    return del.id;
  }

  it('a queued delivery.confirm op transitions the delivery to delivered, once', () => {
    const deliveryId = dispatchedDelivery();
    const op = {
      opKey: newId(),
      opType: 'delivery.confirm',
      payload: { deliveryId, actualDate: nowIso().slice(0, 10), receivedBy: 'Abebe (gate)' },
    };
    const res = applySyncOp(tt.ownerCtx, op);
    expect(res.status).toBe('applied');
    expect(getDelivery(tt.ownerCtx, deliveryId).status).toBe('delivered');
    // replay is idempotent — no error, no second transition
    const again = applySyncOp(tt.ownerCtx, op);
    expect(again.duplicate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D5 — ledger-integrity magnitude guard (red-team R2 High)
// ---------------------------------------------------------------------------
describe('ledger-integrity: oversized quantities are rejected (D5)', () => {
  it('an absurd receiving quantity is rejected before it can corrupt the ledger', () => {
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'S' });
    expect(() =>
      createReceipt(tt.ownerCtx, { supplierId, date: '2026-08-22', itemId: tt.items.raw, entryUomId: tt.uoms.ton, netQty: 1e15, warehouseId: tt.warehouses.a }),
    ).toThrowError(/range|finite/);
  });

  it('a non-finite quantity is rejected', () => {
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'S2' });
    expect(() =>
      createReceipt(tt.ownerCtx, { supplierId, date: '2026-08-22', itemId: tt.items.raw, entryUomId: tt.uoms.ton, netQty: Number.POSITIVE_INFINITY, warehouseId: tt.warehouses.a }),
    ).toThrowError(/finite|range/);
  });

  it('an oversized offline receiving op is REJECTED (recorded, not applied)', () => {
    const supplierId = createParty(tt.sysCtx, { kind: 'supplier', name: 'S3' });
    const res = applySyncOp(tt.ownerCtx, {
      opKey: newId(),
      opType: 'receiving.post',
      payload: { supplierId, date: '2026-08-22', itemId: tt.items.raw, entryUomId: tt.uoms.ton, netQty: 1e15, warehouseId: tt.warehouses.a },
    });
    expect(res.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// Owner daily brief
// ---------------------------------------------------------------------------
describe('Owner daily brief', () => {
  it('returns happened + attention sections and masks money without view_financial', () => {
    makeProcessStages(tt);
    const brief = ownerBrief(tt.ownerCtx);
    expect(brief.date).toBeTruthy();
    expect(Array.isArray(brief.happened)).toBe(true);
    expect(Array.isArray(brief.attention)).toBe(true);
    expect(brief.financialIncluded).toBe(true); // owner has view_financial

    // a non-financial manager gets the brief without financial inclusion
    const roleId = createRole(tt.sysCtx, { code: 'ops', name: 'Ops', matrix: matrixOf([['dashboard', ['view']]]) });
    const uid = createUser(tt.sysCtx, { username: 'ops', displayName: 'Ops', password: 'test-password', roleId });
    const b2 = ownerBrief(userCtx(uid));
    expect(b2.financialIncluded).toBe(false);
  });

  it('attention items are sorted most-severe first', () => {
    const brief = ownerBrief(tt.ownerCtx);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < brief.attention.length; i++) {
      expect(rank[brief.attention[i - 1]!.severity]).toBeLessThanOrEqual(rank[brief.attention[i]!.severity]);
    }
  });
});
