import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import {
  createReceipt,
  postReceipt,
  reverseReceipt,
  cancelReceiptDraft,
  getReceipt,
  type ReceiptInput,
} from '../src/services/receiving.js';
import {
  createTransfer,
  postTransfer,
  reverseTransfer,
  getTransfer,
} from '../src/services/transfers.js';
import { createParty } from '../src/services/parties.js';
import {
  getOnHand,
  listMovements,
  createReservation,
  postMovement,
} from '../src/services/inventory.js';
import { listAudit } from '../src/services/audit.js';
import { AppError } from '../src/util.js';
import { eq } from 'drizzle-orm';
import { lots } from '../src/db/schema.js';

const KG = 1000;

let db: Db;
let tt: TestTenant;
let supplierId: string;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'SALTA');
  supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Test Supplier' });
});

function receiptInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    supplierId,
    source: 'Afdera',
    truckNumber: 'ET-3-48219',
    driverName: 'Test Driver',
    date: '2026-08-14',
    itemId: tt.items.raw,
    entryUomId: tt.uoms.ton,
    grossQty: 10.5,
    netQty: 10,
    warehouseId: tt.warehouses.a,
    ...overrides,
  };
}

describe('goods receiving', () => {
  it('draft does not touch stock; posting adds net quantity and creates a lot', () => {
    const { id, docNumber } = createReceipt(tt.ownerCtx, receiptInput());
    expect(docNumber).toBe('RCV-0001');
    expect(getOnHand(tt.ownerCtx, tt.items.raw)).toBe(0);

    postReceipt(tt.ownerCtx, id);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(10000 * KG);

    const doc = getReceipt(tt.ownerCtx, id);
    expect(doc.lifecycle).toBe('posted');
    expect(doc.lotId).toBeTruthy();
    const lot = db.select().from(lots).where(eq(lots.id, doc.lotId!)).get()!;
    expect(lot.initialQty).toBe(10000 * KG);
    expect((lot.attributes as { source: string }).source).toBe('Afdera');
  });

  it('validates net <= gross and positive quantities', () => {
    expect(() => createReceipt(tt.ownerCtx, receiptInput({ netQty: 11, grossQty: 10 }))).toThrow(
      AppError,
    );
    expect(() => createReceipt(tt.ownerCtx, receiptInput({ netQty: 0 }))).toThrow(AppError);
  });

  it('rejects a count unit for a mass item', () => {
    expect(() =>
      createReceipt(tt.ownerCtx, receiptInput({ entryUomId: tt.uoms.piece })),
    ).toThrow(AppError);
  });

  it('cannot post twice', () => {
    const { id } = createReceipt(tt.ownerCtx, receiptInput());
    postReceipt(tt.ownerCtx, id);
    expect(() => postReceipt(tt.ownerCtx, id)).toThrow(AppError);
  });

  it('reversal posts an opposite movement and preserves history', () => {
    const { id } = createReceipt(tt.ownerCtx, receiptInput());
    postReceipt(tt.ownerCtx, id);
    reverseReceipt(tt.ownerCtx, id, 'Wrong truck recorded');
    expect(getOnHand(tt.ownerCtx, tt.items.raw)).toBe(0);
    const doc = getReceipt(tt.ownerCtx, id);
    expect(doc.lifecycle).toBe('reversed');
    const movements = listMovements(tt.ownerCtx, { documentId: id });
    expect(movements.length).toBe(2); // original + reversal, nothing deleted
    const audit = listAudit(tt.ownerCtx, { action: 'receipt_reverse' });
    expect(audit.count).toBe(1);
  });

  it('reversal without reason is rejected', () => {
    const { id } = createReceipt(tt.ownerCtx, receiptInput());
    postReceipt(tt.ownerCtx, id);
    expect(() => reverseReceipt(tt.ownerCtx, id, '')).toThrow(AppError);
  });

  it('reversal fails when the received stock was already consumed', () => {
    const { id } = createReceipt(tt.ownerCtx, receiptInput());
    postReceipt(tt.ownerCtx, id);
    const doc = getReceipt(tt.ownerCtx, id);
    // consume most of the lot so the reversal cannot balance
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId: doc.lotId,
      warehouseId: tt.warehouses.a,
      qty: -9500 * KG,
      movementType: 'production_consume',
      documentKind: 'production_batch',
      documentId: 'b1',
    });
    expect(() => reverseReceipt(tt.ownerCtx, id, 'too late')).toThrow(AppError);
  });

  it('cancelled drafts never affect stock', () => {
    const { id } = createReceipt(tt.ownerCtx, receiptInput());
    cancelReceiptDraft(tt.ownerCtx, id, 'duplicate entry');
    expect(getOnHand(tt.ownerCtx, tt.items.raw)).toBe(0);
    expect(() => postReceipt(tt.ownerCtx, id)).toThrow(AppError);
  });
});

describe('warehouse transfers', () => {
  function receivedLot(): string {
    const { id } = createReceipt(tt.ownerCtx, receiptInput());
    postReceipt(tt.ownerCtx, id);
    return getReceipt(tt.ownerCtx, id).lotId!;
  }

  it('approval moves stock between warehouses, total unchanged', () => {
    const lotId = receivedLot();
    const { id, docNumber } = createTransfer(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      entryUomId: tt.uoms.kg,
      qty: 5000,
      fromWarehouseId: tt.warehouses.a,
      toWarehouseId: tt.warehouses.b,
      date: '2026-08-14',
      reason: 'Balance production supply',
    });
    expect(docNumber).toBe('TRF-0001');
    postTransfer(tt.ownerCtx, id);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(5000 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.b)).toBe(5000 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.raw)).toBe(10000 * KG);
  });

  it('rejects same source and destination, and missing reason', () => {
    const lotId = receivedLot();
    expect(() =>
      createTransfer(tt.ownerCtx, {
        itemId: tt.items.raw,
        lotId,
        entryUomId: tt.uoms.kg,
        qty: 100,
        fromWarehouseId: tt.warehouses.a,
        toWarehouseId: tt.warehouses.a,
        date: '2026-08-14',
        reason: 'x',
      }),
    ).toThrow(AppError);
    expect(() =>
      createTransfer(tt.ownerCtx, {
        itemId: tt.items.raw,
        lotId,
        entryUomId: tt.uoms.kg,
        qty: 100,
        fromWarehouseId: tt.warehouses.a,
        toWarehouseId: tt.warehouses.b,
        date: '2026-08-14',
        reason: '  ',
      }),
    ).toThrow(AppError);
  });

  it('cannot transfer more than available (reservations count)', () => {
    const lotId = receivedLot();
    createReservation(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 8000 * KG,
      documentKind: 'sales_invoice',
      documentId: 'inv1',
    });
    const { id } = createTransfer(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      entryUomId: tt.uoms.kg,
      qty: 5000,
      fromWarehouseId: tt.warehouses.a,
      toWarehouseId: tt.warehouses.b,
      date: '2026-08-14',
      reason: 'attempted over-transfer',
    });
    expect(() => postTransfer(tt.ownerCtx, id)).toThrow(AppError);
  });

  it('reversal returns stock to the source with linked movements', () => {
    const lotId = receivedLot();
    const { id } = createTransfer(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      entryUomId: tt.uoms.kg,
      qty: 4000,
      fromWarehouseId: tt.warehouses.a,
      toWarehouseId: tt.warehouses.b,
      date: '2026-08-14',
      reason: 'move',
    });
    postTransfer(tt.ownerCtx, id);
    reverseTransfer(tt.ownerCtx, id, 'entered wrong batch');
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(10000 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.b)).toBe(0);
    expect(getTransfer(tt.ownerCtx, id).lifecycle).toBe('reversed');
    expect(listMovements(tt.ownerCtx, { documentId: id }).length).toBe(4);
  });
});
