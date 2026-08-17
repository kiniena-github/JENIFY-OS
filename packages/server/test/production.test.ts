import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, type TestTenant } from './helpers.js';
import { createReceipt, postReceipt, getReceipt } from '../src/services/receiving.js';
import { createParty } from '../src/services/parties.js';
import {
  createBatch,
  startBatch,
  completeBatch,
  cancelBatch,
  getBatch,
  recordQualityTest,
  approveQualityTest,
  listQualityTests,
  availableSourceBatches,
  batchGenealogy,
  outputBalance,
} from '../src/services/batches.js';
import { getOnHand, getAvailable } from '../src/services/inventory.js';
import { AppError } from '../src/util.js';

const KG = 1000;

let db: Db;
let tt: TestTenant;
let stages: { washing: string; iodization: string; packaging: string };
let rawLotId: string;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'SALTA');
  stages = makeProcessStages(tt);
  const supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Supplier' });
  const { id } = createReceipt(tt.ownerCtx, {
    supplierId,
    source: 'Afdera',
    truckNumber: 'T1',
    driverName: 'D1',
    date: '2026-08-14',
    itemId: tt.items.raw,
    entryUomId: tt.uoms.ton,
    netQty: 10,
    warehouseId: tt.warehouses.a,
  });
  postReceipt(tt.ownerCtx, id);
  rawLotId = getReceipt(tt.ownerCtx, id).lotId!;
});

function makeWashing(qtyKg = 10000): string {
  const { id } = createBatch(tt.ownerCtx, {
    stageCode: 'washing',
    date: '2026-08-14',
    inputLotId: rawLotId,
    inputWarehouseId: tt.warehouses.a,
    inputQty: qtyKg,
    inputUomId: tt.uoms.kg,
  });
  return id;
}

function completedWashing(outKg = 9200): string {
  const id = makeWashing();
  completeBatch(tt.ownerCtx, id, { outputQty: outKg });
  return id;
}

function makeIodization(sourceId: string, qtyKg = 9200): string {
  const { id } = createBatch(tt.ownerCtx, {
    stageCode: 'iodization',
    date: '2026-08-14',
    inputBatchId: sourceId,
    inputBatchQty: qtyKg,
    attributes: { iodine_added_kg: 0.42 },
  });
  return id;
}

describe('washing (lot-input, bulk-output)', () => {
  it('start reserves raw stock; completion consumes it and computes loss', () => {
    const id = makeWashing(10000);
    startBatch(tt.ownerCtx, id);
    expect(getAvailable(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(0);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(10000 * KG);

    completeBatch(tt.ownerCtx, id, { outputQty: 9200 });
    const batch = getBatch(tt.ownerCtx, id);
    expect(batch.status).toBe('completed');
    expect(batch.outputQty).toBe(9200 * KG);
    expect(batch.lossQty).toBe(800 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(0);
    expect(getAvailable(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(0);
  });

  it('cannot draft a batch beyond available raw stock', () => {
    expect(() => makeWashing(10001)).toThrow(AppError);
  });

  it('output cannot exceed input', () => {
    const id = makeWashing(10000);
    expect(() => completeBatch(tt.ownerCtx, id, { outputQty: 10001 })).toThrow(AppError);
  });

  it('cancel releases the started reservation', () => {
    const id = makeWashing(10000);
    startBatch(tt.ownerCtx, id);
    expect(getAvailable(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(0);
    cancelBatch(tt.ownerCtx, id, 'operator error');
    expect(getAvailable(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(10000 * KG);
    expect(getBatch(tt.ownerCtx, id).status).toBe('cancelled');
  });
});

describe('iodization (prior-batch input, QC gate)', () => {
  it('consumes washing output balance', () => {
    const washId = completedWashing(9200);
    const iodId = makeIodization(washId, 9200);
    completeBatch(tt.ownerCtx, iodId, { outputQty: 9150 });
    expect(outputBalance(getBatch(tt.ownerCtx, washId))).toBe(0);
    const iod = getBatch(tt.ownerCtx, iodId);
    expect(iod.status).toBe('completed');
    expect(iod.qcStatus).toBe('pending'); // requiresQc: not released yet
  });

  it('cannot consume more than the source batch balance', () => {
    const washId = completedWashing(9200);
    // drafts do not hold balance, but completion does; and new drafts
    // beyond the remaining balance are rejected outright
    const firstId = makeIodization(washId, 5000);
    completeBatch(tt.ownerCtx, firstId, { outputQty: 4900 });
    expect(outputBalance(getBatch(tt.ownerCtx, washId))).toBe(4200 * KG);
    expect(() => makeIodization(washId, 5000)).toThrow(AppError);
    // a draft created while balance existed also re-checks at completion
    const secondId = makeIodization(washId, 4200);
    const thirdDraftBlocked = () => makeIodization(washId, 4200);
    completeBatch(tt.ownerCtx, secondId, { outputQty: 4200 });
    expect(thirdDraftBlocked).toThrow(AppError);
  });

  it('requires the configured stage attributes', () => {
    const washId = completedWashing();
    expect(() =>
      createBatch(tt.ownerCtx, {
        stageCode: 'iodization',
        date: '2026-08-14',
        inputBatchId: washId,
        inputBatchQty: 1000,
      }),
    ).toThrow(AppError);
  });

  it('failed test blocks packaging; retest keeps full history; approval releases', () => {
    const washId = completedWashing(9200);
    const iodId = makeIodization(washId, 9200);
    completeBatch(tt.ownerCtx, iodId, { outputQty: 9200 });

    recordQualityTest(tt.ownerCtx, iodId, {
      targetLevel: '30-40 ppm',
      actualResult: '22 ppm',
      status: 'failed',
      date: '2026-08-14',
    });
    expect(getBatch(tt.ownerCtx, iodId).qcStatus).toBe('failed');
    // packaging cannot start from a failed batch
    expect(() =>
      createBatch(tt.ownerCtx, {
        stageCode: 'packaging',
        date: '2026-08-14',
        inputBatchId: iodId,
        inputBatchQty: 1000,
      }),
    ).toThrow(AppError);
    expect(availableSourceBatches(tt.ownerCtx, 'packaging').length).toBe(0);

    recordQualityTest(tt.ownerCtx, iodId, {
      targetLevel: '30-40 ppm',
      actualResult: '31 ppm',
      status: 'retest_required',
      date: '2026-08-14',
    });
    recordQualityTest(tt.ownerCtx, iodId, {
      targetLevel: '30-40 ppm',
      actualResult: '34 ppm',
      status: 'passed',
      date: '2026-08-15',
    });
    // passed but NOT yet approved -> still gated
    expect(getBatch(tt.ownerCtx, iodId).qcStatus).toBe('pending');
    expect(availableSourceBatches(tt.ownerCtx, 'packaging').length).toBe(0);

    approveQualityTest(tt.ownerCtx, iodId);
    expect(getBatch(tt.ownerCtx, iodId).qcStatus).toBe('passed');
    expect(availableSourceBatches(tt.ownerCtx, 'packaging').length).toBe(1);

    // full immutable history: 3 attempts, linked
    const tests = listQualityTests(tt.ownerCtx, iodId);
    expect(tests.length).toBe(3);
    expect(tests.map((t) => t.status)).toEqual(['passed', 'retest_required', 'failed']);
    expect(tests[0].previousTestId).toBe(tests[1].id);
    expect(tests[1].previousTestId).toBe(tests[2].id);
  });

  it('cannot approve a failed result; cannot re-test after approval', () => {
    const washId = completedWashing();
    const iodId = makeIodization(washId);
    completeBatch(tt.ownerCtx, iodId, { outputQty: 9000 });
    recordQualityTest(tt.ownerCtx, iodId, {
      actualResult: 'bad',
      status: 'failed',
      date: '2026-08-14',
    });
    expect(() => approveQualityTest(tt.ownerCtx, iodId)).toThrow(AppError);
    recordQualityTest(tt.ownerCtx, iodId, {
      actualResult: 'ok',
      status: 'passed',
      date: '2026-08-14',
    });
    approveQualityTest(tt.ownerCtx, iodId);
    expect(() =>
      recordQualityTest(tt.ownerCtx, iodId, {
        actualResult: 'again',
        status: 'passed',
        date: '2026-08-15',
      }),
    ).toThrow(AppError);
  });
});

describe('packaging (packaged-items output)', () => {
  function approvedIodization(outKg = 9200): string {
    const washId = completedWashing(outKg);
    const iodId = makeIodization(washId, outKg);
    completeBatch(tt.ownerCtx, iodId, { outputQty: outKg });
    recordQualityTest(tt.ownerCtx, iodId, {
      actualResult: 'pass',
      status: 'passed',
      date: '2026-08-14',
    });
    approveQualityTest(tt.ownerCtx, iodId);
    return iodId;
  }

  it('converts approved iodized salt into finished packs and inventory', () => {
    const iodId = approvedIodization(9200);
    const { id: pkgId, docNumber } = createBatch(tt.ownerCtx, {
      stageCode: 'packaging',
      date: '2026-08-14',
      inputBatchId: iodId,
      inputBatchQty: 7600,
    });
    completeBatch(tt.ownerCtx, pkgId, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 7552,
      unitsRejected: 32,
      outputWarehouseId: tt.warehouses.b,
    });
    const pkg = getBatch(tt.ownerCtx, pkgId);
    expect(pkg.status).toBe('completed');
    expect(pkg.outputLotId).toBeTruthy();
    // good packs = 7520 -> finished stock in warehouse B
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.b)).toBe(7520 * KG);
    // good weight for reporting = 7520 * 1 kg
    expect(pkg.outputQty).toBe(7520 * KG);
    // iodization balance reduced by consumed 7600
    expect(outputBalance(getBatch(tt.ownerCtx, iodId))).toBe(1600 * KG);
    expect(docNumber.startsWith('PKG-')).toBe(true);
  });

  it('rejects invalid pack counts and foreign products', () => {
    const iodId = approvedIodization();
    const make = () =>
      createBatch(tt.ownerCtx, {
        stageCode: 'packaging',
        date: '2026-08-14',
        inputBatchId: iodId,
        inputBatchQty: 1000,
      });
    const { id: b1 } = { id: make().id };
    expect(() =>
      completeBatch(tt.ownerCtx, b1, {
        outputItemId: tt.items.raw, // not in stage outputItemIds
        unitsProduced: 100,
        outputWarehouseId: tt.warehouses.b,
      }),
    ).toThrow(AppError);
    const { id: b2 } = make();
    expect(() =>
      completeBatch(tt.ownerCtx, b2, {
        outputItemId: tt.items.pack1kg,
        unitsProduced: 100,
        unitsRejected: 101,
        outputWarehouseId: tt.warehouses.b,
      }),
    ).toThrow(AppError);
  });
});

describe('genealogy', () => {
  it('traces backward to the raw lot and forward to the finished lot', () => {
    const washId = completedWashing(9200);
    const iodId = makeIodization(washId, 9200);
    completeBatch(tt.ownerCtx, iodId, { outputQty: 9200 });
    recordQualityTest(tt.ownerCtx, iodId, { actualResult: 'ok', status: 'passed', date: '2026-08-14' });
    approveQualityTest(tt.ownerCtx, iodId);
    const { id: pkgId } = createBatch(tt.ownerCtx, {
      stageCode: 'packaging',
      date: '2026-08-14',
      inputBatchId: iodId,
      inputBatchQty: 7600,
    });
    completeBatch(tt.ownerCtx, pkgId, {
      outputItemId: tt.items.pack1kg,
      unitsProduced: 7552,
      unitsRejected: 32,
      outputWarehouseId: tt.warehouses.b,
    });

    const pkgTree = batchGenealogy(tt.ownerCtx, pkgId);
    // backward: iodization batch -> washing batch -> raw lot
    expect(pkgTree.backward.map((n) => n.kind)).toEqual(['batch', 'batch', 'lot']);
    expect(pkgTree.backward[2].label.startsWith('RAW-')).toBe(true);
    // forward from packaging: its finished lot
    expect(pkgTree.forward.some((n) => n.kind === 'lot')).toBe(true);

    const washTree = batchGenealogy(tt.ownerCtx, washId);
    expect(washTree.forward.some((n) => n.label.startsWith('IOD-'))).toBe(true);
  });
});
