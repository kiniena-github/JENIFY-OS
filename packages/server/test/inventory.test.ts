import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import {
  postMovement,
  getOnHand,
  getAvailable,
  getReserved,
  createReservation,
  releaseReservation,
  consumeReservation,
  createLot,
  recomputeBalances,
  listMovements,
} from '../src/services/inventory.js';
import { toBaseQty } from '../src/services/masterdata.js';
import { AppError } from '../src/util.js';

let db: Db;
let tt: TestTenant;
let other: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'SALTA');
  other = makeTestTenant(db, 'SALTB');
});

const KG = 1000; // milli base-units per kg

describe('unit conversions', () => {
  it('ton and quintal convert to kg through the UoM table', () => {
    expect(toBaseQty(tt.ownerCtx, tt.uoms.ton, 10.5)).toBe(10500 * KG);
    expect(toBaseQty(tt.ownerCtx, tt.uoms.quintal, 3)).toBe(300 * KG);
    expect(toBaseQty(tt.ownerCtx, tt.uoms.kg, 250)).toBe(250 * KG);
  });
});

describe('stock ledger', () => {
  it('balance equals the sum of posted movements', () => {
    const lotId = createLot(tt.ownerCtx, { itemId: tt.items.raw, lotNumber: 'RAW-0001' });
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 10000 * KG,
      movementType: 'receipt',
      documentKind: 'goods_receipt',
      documentId: 'doc1',
    });
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: -1500 * KG,
      movementType: 'production_consume',
      documentKind: 'production_batch',
      documentId: 'doc2',
    });
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a, lotId)).toBe(8500 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.raw)).toBe(8500 * KG);
  });

  it('rejects movements that would leave negative stock', () => {
    const lotId = createLot(tt.ownerCtx, { itemId: tt.items.raw, lotNumber: 'RAW-0002' });
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 100 * KG,
      movementType: 'receipt',
      documentKind: 'goods_receipt',
      documentId: 'doc1',
    });
    expect(() =>
      postMovement(tt.ownerCtx, {
        itemId: tt.items.raw,
        lotId,
        warehouseId: tt.warehouses.a,
        qty: -200 * KG,
        movementType: 'issue',
        documentKind: 'adjustment',
        documentId: 'doc2',
      }),
    ).toThrow(AppError);
  });

  it('transfer-style paired movements keep the total unchanged', () => {
    const lotId = createLot(tt.ownerCtx, { itemId: tt.items.raw, lotNumber: 'RAW-0003' });
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 8000 * KG,
      movementType: 'receipt',
      documentKind: 'goods_receipt',
      documentId: 'doc1',
    });
    const out = postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: -5000 * KG,
      movementType: 'transfer_out',
      documentKind: 'stock_transfer',
      documentId: 'tr1',
    });
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.b,
      qty: 5000 * KG,
      movementType: 'transfer_in',
      documentKind: 'stock_transfer',
      documentId: 'tr1',
      counterpartId: out,
    });
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(3000 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.b)).toBe(5000 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.raw)).toBe(8000 * KG);
  });

  it('ledger is tenant-isolated', () => {
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      warehouseId: tt.warehouses.a,
      qty: 100 * KG,
      movementType: 'receipt',
      documentKind: 'goods_receipt',
      documentId: 'doc1',
    });
    expect(getOnHand(other.ownerCtx, other.items.raw)).toBe(0);
    expect(listMovements(other.ownerCtx).length).toBe(0);
  });

  it('recomputeBalances finds no discrepancies in a healthy ledger', () => {
    const lotId = createLot(tt.ownerCtx, { itemId: tt.items.raw, lotNumber: 'RAW-0004' });
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 700 * KG,
      movementType: 'receipt',
      documentKind: 'goods_receipt',
      documentId: 'doc1',
    });
    expect(recomputeBalances(tt.ownerCtx)).toEqual([]);
  });
});

describe('reservations', () => {
  function receive(qtyKg: number): string {
    const lotId = createLot(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotNumber: `RAW-R${Math.random().toString(36).slice(2, 6)}`,
    });
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: qtyKg * KG,
      movementType: 'receipt',
      documentKind: 'goods_receipt',
      documentId: 'doc1',
    });
    return lotId;
  }

  it('available = on hand - active reservations', () => {
    const lotId = receive(1000);
    createReservation(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 300 * KG,
      documentKind: 'sales_invoice',
      documentId: 'inv1',
    });
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(1000 * KG);
    expect(getReserved(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(300 * KG);
    expect(getAvailable(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(700 * KG);
  });

  it('cannot reserve more than available', () => {
    const lotId = receive(100);
    createReservation(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 80 * KG,
      documentKind: 'sales_invoice',
      documentId: 'inv1',
    });
    expect(() =>
      createReservation(tt.ownerCtx, {
        itemId: tt.items.raw,
        lotId,
        warehouseId: tt.warehouses.a,
        qty: 30 * KG,
        documentKind: 'sales_invoice',
        documentId: 'inv2',
      }),
    ).toThrow(AppError);
  });

  it('release restores availability; consume closes without restoring', () => {
    const lotId = receive(500);
    const r1 = createReservation(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 200 * KG,
      documentKind: 'sales_invoice',
      documentId: 'inv1',
    });
    releaseReservation(tt.ownerCtx, r1);
    expect(getAvailable(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(500 * KG);

    const r2 = createReservation(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: 200 * KG,
      documentKind: 'sales_invoice',
      documentId: 'inv2',
    });
    // dispatch: stock leaves AND the reservation closes
    postMovement(tt.ownerCtx, {
      itemId: tt.items.raw,
      lotId,
      warehouseId: tt.warehouses.a,
      qty: -200 * KG,
      movementType: 'sale_dispatch',
      documentKind: 'delivery',
      documentId: 'del1',
    });
    consumeReservation(tt.ownerCtx, r2);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(300 * KG);
    expect(getAvailable(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(300 * KG);
    // closed reservations cannot be closed twice
    expect(() => releaseReservation(tt.ownerCtx, r2)).toThrow(AppError);
  });
});
