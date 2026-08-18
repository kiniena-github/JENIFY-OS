import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, type TestTenant } from './helpers.js';
import { createParty } from '../src/services/parties.js';
import { saveSettings } from '../src/services/settings.js';
import { defineSequence } from '../src/services/numbering.js';
import { createReceipt, postReceipt, getReceipt } from '../src/services/receiving.js';
import {
  createBatch,
  completeBatch,
  recordQualityTest,
  approveQualityTest,
} from '../src/services/batches.js';
import { createInvoice, confirmInvoice } from '../src/services/sales.js';
import { createDelivery, dispatchDelivery } from '../src/services/deliveries.js';
import { createPayment } from '../src/services/payments.js';
import { postSimpleTxn, reverseSimpleTxn } from '../src/services/simpletxn.js';
import {
  rawStockReport,
  productionReport,
  qualityReport,
  packagingReport,
  finishedInventoryReport,
  salesReport,
  creditReport,
  deliveryReport,
  simpleItemReport,
} from '../src/services/reports.js';
import { dashboard } from '../src/services/dashboard.js';
import { getOnHand, recomputeBalances } from '../src/services/inventory.js';
import { createItem } from '../src/services/masterdata.js';
import { nowIso } from '../src/util.js';

const KG = 1000;
const PC = 1000;

let db: Db;
let tt: TestTenant;
let customerId: string;
const TODAY = nowIso().slice(0, 10);

/**
 * One realistic full chain, then every report must reconcile with it:
 * receive 10t -> wash 10,000 (out 9,200, loss 800) -> iodize 9,200 (out 9,150,
 * QC passed+approved) -> package 7,600 into 7,552 x 1kg (32 rejected)
 * -> sell 2,000 packs wholesale @80 +15% VAT -> dispatch -> pay 100,000.
 */
beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'SALTA');
  makeProcessStages(tt);
  const supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Supplier' });
  customerId = createParty(tt.ownerCtx, { kind: 'customer', name: 'Wholesale Shop', creditLimit: 500_000 });
  saveSettings(tt.ownerCtx, 'pricing', {
    categories: ['retail', 'wholesale', 'distributor'],
    prices: { [tt.items.pack1kg]: { wholesale: 80 } },
  });
  saveSettings(tt.ownerCtx, 'vat', { enabled: true, ratePct: 15 });

  const { id: rcv } = createReceipt(tt.ownerCtx, {
    supplierId,
    source: 'Afdera',
    truckNumber: 'T1',
    driverName: 'D1',
    date: TODAY,
    itemId: tt.items.raw,
    entryUomId: tt.uoms.ton,
    netQty: 10,
    warehouseId: tt.warehouses.a,
  });
  postReceipt(tt.ownerCtx, rcv);
  const lotId = getReceipt(tt.ownerCtx, rcv).lotId!;

  const { id: wash } = createBatch(tt.ownerCtx, {
    stageCode: 'washing',
    date: TODAY,
    inputLotId: lotId,
    inputWarehouseId: tt.warehouses.a,
    inputQty: 10000,
    inputUomId: tt.uoms.kg,
  });
  completeBatch(tt.ownerCtx, wash, { outputQty: 9200 });

  const { id: iod } = createBatch(tt.ownerCtx, {
    stageCode: 'iodization',
    date: TODAY,
    inputBatchId: wash,
    inputBatchQty: 9200,
    attributes: { iodine_added_kg: 0.42 },
  });
  completeBatch(tt.ownerCtx, iod, {});
  recordQualityTest(tt.ownerCtx, iod, {
    targetLevel: '30-40 ppm',
    actualResult: '34 ppm',
    status: 'passed',
    date: TODAY,
  });
  approveQualityTest(tt.ownerCtx, iod);

  const { id: pkg } = createBatch(tt.ownerCtx, {
    stageCode: 'packaging',
    date: TODAY,
    inputBatchId: iod,
    inputBatchQty: 7600,
  });
  completeBatch(tt.ownerCtx, pkg, {
    outputItemId: tt.items.pack1kg,
    unitsProduced: 7552,
    unitsRejected: 32,
    outputWarehouseId: tt.warehouses.b,
  });

  const { id: inv } = createInvoice(tt.ownerCtx, {
    customerId,
    date: TODAY,
    priceCategory: 'wholesale',
    paymentTerm: 'partial',
    dueDate: '2099-12-31',
    lines: [
      { itemId: tt.items.pack1kg, warehouseId: tt.warehouses.b, qty: 2000, entryUomId: tt.uoms.piece },
    ],
  });
  confirmInvoice(tt.ownerCtx, inv);
  const { id: del } = createDelivery(tt.ownerCtx, {
    invoiceId: inv,
    destination: 'Town',
    truckNumber: 'T-9',
    driverName: 'Driver',
    driverPhone: '+251 900 000 000',
    expectedDate: '2099-12-31',
  });
  dispatchDelivery(tt.ownerCtx, del);
  createPayment(
    tt.ownerCtx,
    {
      customerId,
      date: TODAY,
      amount: 100_000,
      method: 'bank',
      allocations: [{ invoiceId: inv, amount: 100_000 }],
    },
    { post: true },
  );
});

describe('reports reconcile with source transactions', () => {
  it('raw stock report', () => {
    const r = rawStockReport(tt.ownerCtx, {});
    expect(r.receivedQty).toBe(10000 * KG);
    expect(r.usedQty).toBe(10000 * KG);
    expect(r.remainingQty).toBe(0);
    expect(r.remainingQty).toBe(getOnHand(tt.ownerCtx, tt.items.raw));
  });

  it('production report: loss/efficiency describe measured stages only', () => {
    const r = productionReport(tt.ownerCtx, {});
    // washing 10,000->9,200 (measured) + iodization 9,200->9,200 (conserved)
    expect(r.inputQty).toBe((10000 + 9200) * KG);
    expect(r.outputQty).toBe((9200 + 9200) * KG);
    // NO invented iodization loss: only washing's measured 800 kg
    expect(r.lossQty).toBe(800 * KG);
    const washRow = r.breakdown.find((b) => b.stage === 'washing')!;
    expect(washRow.efficiencyPct).toBeCloseTo(92.0, 1);
    const iodRow = r.breakdown.find((b) => b.stage === 'iodization')!;
    expect(iodRow.efficiencyPct).toBeNull();
    expect(iodRow.outputPolicy).toBe('conserved');
    const iodStage = r.perStage.find((sr) => sr.stageCode === 'iodization')!;
    expect(iodStage.lossQty).toBeNull();
  });

  it('quality report: iodine total and pass counts', () => {
    const r = qualityReport(tt.ownerCtx, {});
    expect(r.batchCount).toBe(1);
    expect(r.passedCount).toBe(1);
    expect(r.attributeTotals.iodine_added_kg).toBeCloseTo(0.42);
  });

  it('packaging report: good units and weight', () => {
    const r = packagingReport(tt.ownerCtx, {});
    expect(r.perItem.length).toBe(1);
    expect(r.perItem[0].produced).toBe(7552 * PC);
    expect(r.perItem[0].rejected).toBe(32 * PC);
    expect(r.perItem[0].good).toBe(7520 * PC);
    expect(r.perItem[0].weight).toBe(7520 * KG); // 1kg packs
  });

  it('finished inventory report reconciles with the ledger', () => {
    const r = finishedInventoryReport(tt.ownerCtx, {});
    // 7,520 packed − 2,000 dispatched = 5,520 available
    expect(r.availableUnits).toBe(5520 * PC);
    expect(r.soldUnits).toBe(2000 * PC);
    expect(r.availableUnits).toBe(getOnHand(tt.ownerCtx, tt.items.pack1kg));
  });

  it('sales report: totals with VAT', () => {
    const r = salesReport(tt.ownerCtx, {});
    expect(r.invoiceCount).toBe(1);
    expect(r.subtotalCents).toBe(160_000_00);
    expect(r.vatCents).toBe(24_000_00);
    expect(r.totalCents).toBe(184_000_00);
    expect(r.paidCents).toBe(100_000_00);
  });

  it('credit report: outstanding equals total minus payments', () => {
    const r = creditReport(tt.ownerCtx, {});
    expect(r.outstandingCents).toBe(84_000_00);
    expect(r.collectedCents).toBe(100_000_00);
  });

  it('delivery report counts', () => {
    const r = deliveryReport(tt.ownerCtx, {});
    expect(r.dispatched).toBe(1);
    expect(r.breakdown[0].truckNumber).toBe('T-9');
  });

  it('dashboard aggregates the same facts', () => {
    const d = dashboard(tt.ownerCtx, { includeFinancial: true });
    expect(d.rawStock.totalQty).toBe(0);
    expect(d.finance?.todaySalesCents).toBe(184_000_00);
    expect(d.finance?.outstandingCents).toBe(84_000_00);
    expect(d.deliveries.dispatched).toBe(1);
    const pkgStage = d.production.find((s) => s.stageCode === 'packaging')!;
    expect(pkgStage.todayOutput).toBe(7520 * KG);
  });

  it('ledger integrity: no balance drift anywhere', () => {
    expect(recomputeBalances(tt.ownerCtx)).toEqual([]);
  });
});

describe('simple item transactions (empty sacks pattern)', () => {
  let sackItem: string;
  beforeEach(() => {
    sackItem = createItem(tt.sysCtx, {
      code: 'SACK',
      name: 'Empty Sack',
      kind: 'other',
      baseUomId: tt.uoms.piece,
      sellable: true,
    });
    defineSequence(tt.sysCtx, 'sack', 'SACK-', 4);
  });

  it('collect increases, sell decreases, proceeds tracked, never negative', () => {
    postSimpleTxn(tt.ownerCtx, {
      itemId: sackItem,
      warehouseId: tt.warehouses.a,
      type: 'collect',
      qty: 180,
      date: TODAY,
      docSeqKey: 'sack',
    });
    postSimpleTxn(tt.ownerCtx, {
      itemId: sackItem,
      warehouseId: tt.warehouses.a,
      type: 'sell',
      qty: 100,
      buyer: 'Local Buyer',
      unitPrice: 20,
      date: TODAY,
      docSeqKey: 'sack',
    });
    const r = simpleItemReport(tt.ownerCtx, sackItem, {});
    expect(r.collectedQty).toBe(180 * PC);
    expect(r.soldQty).toBe(100 * PC);
    expect(r.remainingQty).toBe(80 * PC);
    expect(r.proceedsCents).toBe(2_000_00); // 100 x 20 ETB
    // cannot oversell
    expect(() =>
      postSimpleTxn(tt.ownerCtx, {
        itemId: sackItem,
        warehouseId: tt.warehouses.a,
        type: 'sell',
        qty: 81,
        buyer: 'X',
        unitPrice: 20,
        date: TODAY,
        docSeqKey: 'sack',
      }),
    ).toThrow();
  });

  it('reversal restores the balance with linked history', () => {
    const { id } = postSimpleTxn(tt.ownerCtx, {
      itemId: sackItem,
      warehouseId: tt.warehouses.a,
      type: 'collect',
      qty: 50,
      date: TODAY,
      docSeqKey: 'sack',
    });
    expect(getOnHand(tt.ownerCtx, sackItem)).toBe(50 * PC);
    reverseSimpleTxn(tt.ownerCtx, id, 'entry error');
    expect(getOnHand(tt.ownerCtx, sackItem)).toBe(0);
  });
});
