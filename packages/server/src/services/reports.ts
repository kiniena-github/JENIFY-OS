import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import {
  deliveries,
  goodsReceipts,
  invoiceLines,
  items,
  lots,
  parties,
  productionBatches,
  productionStages,
  qualityTests,
  salesInvoices,
  simpleTransactions,
  stockMovements,
  warehouses,
} from '../db/schema.js';
import type { Ctx } from './context.js';
import { stockOverview } from './stockview.js';
import { creditOverview } from './creditview.js';
import { invoicePaidCents } from './sales.js';
import { listPayments } from './payments.js';

export interface Period {
  from?: string; // inclusive ISO date
  to?: string; // inclusive ISO date
}

function inPeriod<T extends { date: string }>(rows: T[], p: Period): T[] {
  return rows.filter((r) => (!p.from || r.date >= p.from) && (!p.to || r.date <= p.to));
}

/** Raw material: received / used / remaining, by batch and warehouse. */
export function rawStockReport(ctx: Ctx, p: Period, warehouseId?: string) {
  const receipts = ctx.db
    .select()
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.tenantId, ctx.tenantId), eq(goodsReceipts.lifecycle, 'posted')))
    .all();
  const receivedRows = inPeriod(receipts, p).filter(
    (r) => !warehouseId || r.warehouseId === warehouseId,
  );

  const stock = stockOverview(ctx, { kind: 'raw_material' }).filter(
    (r) => !warehouseId || r.warehouseId === warehouseId,
  );

  // usage: production_consume movements in period
  const conds = [
    eq(stockMovements.tenantId, ctx.tenantId),
    eq(stockMovements.movementType, 'production_consume'),
  ];
  if (warehouseId) conds.push(eq(stockMovements.warehouseId, warehouseId));
  const usage = ctx.db
    .select()
    .from(stockMovements)
    .where(and(...conds))
    .all()
    .filter((m) => {
      const d = m.postedAt.slice(0, 10);
      return (!p.from || d >= p.from) && (!p.to || d <= p.to);
    });

  const lotRows = ctx.db.select().from(lots).where(eq(lots.tenantId, ctx.tenantId)).all();
  const lotById = new Map(lotRows.map((l) => [l.id, l]));
  const usedByLot = new Map<string, number>();
  for (const m of usage) {
    if (m.lotId) usedByLot.set(m.lotId, (usedByLot.get(m.lotId) ?? 0) - m.qty);
  }

  const breakdown = stock
    .filter((r) => r.lotId && (r.onHand !== 0 || (usedByLot.get(r.lotId) ?? 0) !== 0))
    .map((r) => ({
      lotNumber: r.lotNumber,
      source: r.lotSource,
      receivedAt: r.receivedAt,
      initialQty: r.initialQty,
      usedQty: usedByLot.get(r.lotId!) ?? 0,
      remainingQty: r.onHand,
      reservedQty: r.reserved,
      warehouseCode: r.warehouseCode,
      status: r.status,
    }));

  return {
    receivedQty: receivedRows.reduce((s, r) => s + r.netQty, 0),
    usedQty: usage.reduce((s, m) => s - m.qty, 0),
    remainingQty: stock.reduce((s, r) => s + r.onHand, 0),
    reservedQty: stock.reduce((s, r) => s + r.reserved, 0),
    breakdown,
    lotCount: lotById.size,
  };
}

/** Bulk production throughput: input, output, loss, efficiency per batch. */
export function productionReport(ctx: Ctx, p: Period, stageCode?: string) {
  const stages = ctx.db
    .select()
    .from(productionStages)
    .where(eq(productionStages.tenantId, ctx.tenantId))
    .all();
  const bulkStageIds = stages
    .filter((s) => s.outputForm === 'bulk' && (!stageCode || s.code === stageCode))
    .map((s) => s.id);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const batches = ctx.db
    .select()
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.tenantId, ctx.tenantId),
        eq(productionBatches.status, 'completed'),
        inArray(productionBatches.stageId, bulkStageIds.length ? bulkStageIds : ['-']),
      ),
    )
    .all();
  const rows = inPeriod(batches, p);
  const lotRows = ctx.db.select().from(lots).where(eq(lots.tenantId, ctx.tenantId)).all();
  const lotById = new Map(lotRows.map((l) => [l.id, l]));
  const batchNumById = new Map(batches.map((b) => [b.id, b.docNumber]));

  const input = rows.reduce((s, b) => s + b.inputQty, 0);
  const output = rows.reduce((s, b) => s + (b.outputQty ?? 0), 0);
  return {
    inputQty: input,
    outputQty: output,
    lossQty: rows.reduce((s, b) => s + (b.lossQty ?? 0), 0),
    efficiencyPct: input > 0 ? (output / input) * 100 : null,
    breakdown: rows.map((b) => ({
      batchNumber: b.docNumber,
      stage: stageById.get(b.stageId)?.code ?? '?',
      sourceRef: b.inputLotId
        ? (lotById.get(b.inputLotId)?.lotNumber ?? '—')
        : b.inputBatchId
          ? (batchNumById.get(b.inputBatchId) ?? '—')
          : '—',
      date: b.date,
      inputQty: b.inputQty,
      outputQty: b.outputQty,
      lossQty: b.lossQty,
      efficiencyPct: b.outputQty != null && b.inputQty > 0 ? (b.outputQty / b.inputQty) * 100 : null,
      status: b.status,
    })),
  };
}

/** QC report for stages that require quality testing. */
export function qualityReport(ctx: Ctx, p: Period) {
  const stages = ctx.db
    .select()
    .from(productionStages)
    .where(and(eq(productionStages.tenantId, ctx.tenantId), eq(productionStages.requiresQc, true)))
    .all();
  const stageIds = stages.map((s) => s.id);
  const batches = ctx.db
    .select()
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.tenantId, ctx.tenantId),
        inArray(productionBatches.stageId, stageIds.length ? stageIds : ['-']),
      ),
    )
    .all();
  const rows = inPeriod(batches, p).filter((b) => b.status === 'completed');
  const tests = ctx.db
    .select()
    .from(qualityTests)
    .where(eq(qualityTests.tenantId, ctx.tenantId))
    .all();
  const testsByBatch = new Map<string, typeof tests>();
  for (const qt of tests) {
    const list = testsByBatch.get(qt.batchId) ?? [];
    list.push(qt);
    testsByBatch.set(qt.batchId, list);
  }
  const batchNumById = new Map(
    ctx.db.select().from(productionBatches).where(eq(productionBatches.tenantId, ctx.tenantId)).all()
      .map((b) => [b.id, b.docNumber] as const),
  );

  // sum numeric attributes (e.g. iodine_added_kg) across batches
  const attributeTotals: Record<string, number> = {};
  for (const b of rows) {
    const attrs = (b.attributes ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === 'number') attributeTotals[k] = (attributeTotals[k] ?? 0) + v;
    }
  }

  const statusOf = (b: (typeof rows)[number]) =>
    b.qcStatus === 'passed' && b.qcApprovedAt ? 'passed' : b.qcStatus;

  return {
    batchCount: rows.length,
    passedCount: rows.filter((b) => statusOf(b) === 'passed').length,
    failedCount: rows.filter((b) => b.qcStatus === 'failed').length,
    retestOpenCount: rows.filter((b) => b.qcStatus === 'retest_required' || b.qcStatus === 'pending').length,
    attributeTotals,
    breakdown: rows.map((b) => {
      const batchTests = (testsByBatch.get(b.id) ?? []).sort((a, z) => z.attemptNumber - a.attemptNumber);
      const latest = batchTests[0];
      return {
        batchNumber: b.docNumber,
        sourceRef: b.inputBatchId ? (batchNumById.get(b.inputBatchId) ?? '—') : '—',
        date: b.date,
        inputQty: b.inputQty,
        attributes: b.attributes,
        actualResult: latest?.actualResult ?? null,
        attempts: batchTests.length,
        approvedBy: b.qcApprovedBy,
        status: statusOf(b),
      };
    }),
  };
}

/** Packaged output by finished item: produced, rejected, good units/weight. */
export function packagingReport(ctx: Ctx, p: Period) {
  const stages = ctx.db
    .select()
    .from(productionStages)
    .where(and(eq(productionStages.tenantId, ctx.tenantId), eq(productionStages.outputForm, 'packaged_items')))
    .all();
  const stageIds = stages.map((s) => s.id);
  const batches = ctx.db
    .select()
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.tenantId, ctx.tenantId),
        eq(productionBatches.status, 'completed'),
        inArray(productionBatches.stageId, stageIds.length ? stageIds : ['-']),
      ),
    )
    .all();
  const rows = inPeriod(batches, p);
  const itemRows = ctx.db.select().from(items).where(eq(items.tenantId, ctx.tenantId)).all();
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const batchNumById = new Map(batches.map((b) => [b.id, b.docNumber]));

  const perItem = new Map<string, { produced: number; rejected: number; good: number; weight: number }>();
  for (const b of rows) {
    if (!b.outputItemId) continue;
    const item = itemById.get(b.outputItemId);
    const cur = perItem.get(b.outputItemId) ?? { produced: 0, rejected: 0, good: 0, weight: 0 };
    const produced = b.unitsProduced ?? 0;
    const rejected = b.unitsRejected ?? 0;
    cur.produced += produced;
    cur.rejected += rejected;
    cur.good += produced - rejected;
    cur.weight += item?.unitWeightMilliKg != null ? ((produced - rejected) / 1000) * item.unitWeightMilliKg : 0;
    perItem.set(b.outputItemId, cur);
  }

  return {
    perItem: [...perItem.entries()].map(([itemId, v]) => ({
      itemId,
      itemName: itemById.get(itemId)?.name ?? '?',
      ...v,
    })),
    totalRejected: rows.reduce((s, b) => s + (b.unitsRejected ?? 0), 0),
    breakdown: rows.map((b) => ({
      batchNumber: b.docNumber,
      sourceRef: b.inputBatchId ? (batchNumById.get(b.inputBatchId) ?? '—') : '—',
      date: b.date,
      itemName: b.outputItemId ? (itemById.get(b.outputItemId)?.name ?? '?') : '?',
      unitsProduced: b.unitsProduced,
      unitsRejected: b.unitsRejected,
      goodUnits: (b.unitsProduced ?? 0) - (b.unitsRejected ?? 0),
      goodWeight: b.outputQty,
      status: b.status,
    })),
  };
}

/** Finished stock position + units dispatched in the period. */
export function finishedInventoryReport(ctx: Ctx, p: Period, warehouseId?: string) {
  const stock = stockOverview(ctx, { kind: 'finished_good' }).filter(
    (r) => !warehouseId || r.warehouseId === warehouseId,
  );
  const dispatches = ctx.db
    .select()
    .from(stockMovements)
    .where(
      and(eq(stockMovements.tenantId, ctx.tenantId), eq(stockMovements.movementType, 'sale_dispatch')),
    )
    .all()
    .filter((m) => {
      const d = m.postedAt.slice(0, 10);
      return (!p.from || d >= p.from) && (!p.to || d <= p.to) && (!warehouseId || m.warehouseId === warehouseId);
    });
  const soldByKey = new Map<string, number>();
  for (const m of dispatches) {
    const key = `${m.itemId}|${m.lotId ?? ''}|${m.warehouseId}`;
    soldByKey.set(key, (soldByKey.get(key) ?? 0) - m.qty);
  }
  return {
    availableUnits: stock.reduce((s, r) => s + r.available, 0),
    reservedUnits: stock.reduce((s, r) => s + r.reserved, 0),
    soldUnits: dispatches.reduce((s, m) => s - m.qty, 0),
    availableWeight: stock.reduce(
      (s, r) => s + (r.unitWeightMilliKg != null ? (r.available / 1000) * r.unitWeightMilliKg : 0),
      0,
    ),
    breakdown: stock
      .filter((r) => r.onHand !== 0 || r.reserved !== 0 || soldByKey.has(`${r.itemId}|${r.lotId ?? ''}|${r.warehouseId}`))
      .map((r) => ({
        itemName: r.itemName,
        lotNumber: r.lotNumber,
        warehouseCode: r.warehouseCode,
        available: r.available,
        reserved: r.reserved,
        sold: soldByKey.get(`${r.itemId}|${r.lotId ?? ''}|${r.warehouseId}`) ?? 0,
        weight: r.unitWeightMilliKg != null ? (r.onHand / 1000) * r.unitWeightMilliKg : null,
        status: r.status,
      })),
  };
}

/** Sales by period/product/customer/salesperson with discount and VAT. */
export function salesReport(ctx: Ctx, p: Period, filter: { customerId?: string } = {}) {
  const conds = [
    eq(salesInvoices.tenantId, ctx.tenantId),
    inArray(salesInvoices.status, ['confirmed', 'dispatched', 'completed']),
  ];
  if (filter.customerId) conds.push(eq(salesInvoices.customerId, filter.customerId));
  if (p.from) conds.push(gte(salesInvoices.date, p.from));
  if (p.to) conds.push(lte(salesInvoices.date, p.to));
  const invoices = ctx.db
    .select({ inv: salesInvoices, customerName: parties.name })
    .from(salesInvoices)
    .innerJoin(parties, eq(salesInvoices.customerId, parties.id))
    .where(and(...conds))
    .all();
  const cancelled = ctx.db
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.status, 'cancelled')))
    .all();
  const lines = ctx.db
    .select({ line: invoiceLines, itemName: items.name })
    .from(invoiceLines)
    .innerJoin(items, eq(invoiceLines.itemId, items.id))
    .where(eq(invoiceLines.tenantId, ctx.tenantId))
    .all();
  const linesByInvoice = new Map<string, string[]>();
  for (const { line, itemName } of lines) {
    const list = linesByInvoice.get(line.invoiceId) ?? [];
    if (!list.includes(itemName)) list.push(itemName);
    linesByInvoice.set(line.invoiceId, list);
  }

  return {
    invoiceCount: invoices.length,
    subtotalCents: invoices.reduce((s, r) => s + r.inv.subtotalCents, 0),
    discountCents: invoices.reduce((s, r) => s + r.inv.discountCents, 0),
    vatCents: invoices.reduce((s, r) => s + r.inv.vatCents, 0),
    totalCents: invoices.reduce((s, r) => s + r.inv.totalCents, 0),
    paidCents: invoices.reduce((s, r) => s + invoicePaidCents(ctx, r.inv.id), 0),
    cancelledCount: inPeriod(cancelled, p).length,
    breakdown: invoices.map(({ inv, customerName }) => ({
      invoiceNumber: inv.docNumber,
      date: inv.date,
      customerName,
      products: linesByInvoice.get(inv.id)?.join(', ') ?? '',
      subtotalCents: inv.subtotalCents,
      discountCents: inv.discountCents,
      vatCents: inv.vatCents,
      totalCents: inv.totalCents,
      status: inv.status,
    })),
  };
}

/** Credit balances + money collected in the period. */
export function creditReport(ctx: Ctx, p: Period) {
  const overview = creditOverview(ctx);
  const posted = listPayments(ctx).filter((pay) => pay.status === 'posted');
  const collected = posted
    .filter((pay) => (!p.from || pay.date >= p.from) && (!p.to || pay.date <= p.to))
    .reduce((s, pay) => s + pay.amountCents, 0);
  return { ...overview, collectedCents: collected };
}

/** Fulfilment counts and rows by status/destination/truck. */
export function deliveryReport(ctx: Ctx, p: Period) {
  const rows = ctx.db
    .select({ del: deliveries, customerName: parties.name, invoiceNumber: salesInvoices.docNumber })
    .from(deliveries)
    .innerJoin(parties, eq(deliveries.customerId, parties.id))
    .innerJoin(salesInvoices, eq(deliveries.invoiceId, salesInvoices.id))
    .where(eq(deliveries.tenantId, ctx.tenantId))
    .all()
    .filter((r) => {
      const d = r.del.dispatchDate ?? r.del.createdAt.slice(0, 10);
      return (!p.from || d >= p.from) && (!p.to || d <= p.to);
    });
  const count = (s: string) => rows.filter((r) => r.del.status === s).length;
  return {
    pending: count('pending'),
    loading: count('loading'),
    dispatched: count('dispatched'),
    delivered: count('delivered'),
    cancelled: count('cancelled'),
    breakdown: rows.map((r) => ({
      deliveryNumber: r.del.docNumber,
      invoiceNumber: r.invoiceNumber,
      customerName: r.customerName,
      destination: r.del.destination,
      truckNumber: r.del.truckNumber,
      expectedDate: r.del.expectedDate,
      actualDate: r.del.actualDate,
      status: r.del.status,
    })),
  };
}

/** Simple-item (e.g. empty sack) collected / sold / remaining + proceeds. */
export function simpleItemReport(ctx: Ctx, itemId: string, p: Period) {
  const txns = ctx.db
    .select()
    .from(simpleTransactions)
    .where(
      and(
        eq(simpleTransactions.tenantId, ctx.tenantId),
        eq(simpleTransactions.itemId, itemId),
        eq(simpleTransactions.lifecycle, 'posted'),
      ),
    )
    .all();
  const periodTxns = inPeriod(txns, p);
  const stock = stockOverview(ctx, { itemId });
  const collected = periodTxns.filter((t) => t.type === 'collect').reduce((s, t) => s + t.qty, 0);
  const sold = periodTxns.filter((t) => t.type === 'sell').reduce((s, t) => s + t.qty, 0);
  return {
    collectedQty: collected,
    soldQty: sold,
    remainingQty: stock.reduce((s, r) => s + r.onHand, 0),
    proceedsCents: periodTxns
      .filter((t) => t.type === 'sell' && t.unitPriceCents != null)
      .reduce((s, t) => s + Math.round((t.qty / 1000) * t.unitPriceCents!), 0),
    breakdown: periodTxns.map((t) => ({
      docNumber: t.docNumber,
      date: t.date,
      type: t.type,
      qty: t.qty,
      buyer: t.buyer,
      unitPriceCents: t.unitPriceCents,
      status: t.lifecycle,
    })),
  };
}
