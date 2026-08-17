import { and, eq, sql } from 'drizzle-orm';
import type { ItemKind } from '@factoryos/shared';
import { items, lots, reservations, stockBalances, warehouses, productionBatches } from '../db/schema.js';
import type { Ctx } from './context.js';

export interface StockRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  itemKind: string;
  unitWeightMilliKg: number | null;
  lotId: string | null;
  lotNumber: string | null;
  lotSource: string | null;
  receivedAt: string | null;
  initialQty: number | null;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  onHand: number;
  reserved: number;
  inProcess: number;
  available: number;
  status: 'available' | 'reserved' | 'in_process' | 'empty';
}

/** Calculated stock by item × lot × warehouse, with reservation state. */
export function stockOverview(ctx: Ctx, filter: { kind?: ItemKind; itemId?: string } = {}): StockRow[] {
  const conds = [eq(stockBalances.tenantId, ctx.tenantId)];
  if (filter.itemId) conds.push(eq(stockBalances.itemId, filter.itemId));
  const rows = ctx.db
    .select({
      itemId: stockBalances.itemId,
      lotKey: stockBalances.lotId,
      warehouseId: stockBalances.warehouseId,
      onHand: stockBalances.qtyOnHand,
      itemCode: items.code,
      itemName: items.name,
      itemKind: items.kind,
      unitWeightMilliKg: items.unitWeightMilliKg,
      warehouseCode: warehouses.code,
      warehouseName: warehouses.name,
    })
    .from(stockBalances)
    .innerJoin(items, eq(stockBalances.itemId, items.id))
    .innerJoin(warehouses, eq(stockBalances.warehouseId, warehouses.id))
    .where(and(...conds))
    .all()
    .filter((r) => (filter.kind ? r.itemKind === filter.kind : true));

  // active reservations grouped by item/lot/warehouse
  const resRows = ctx.db
    .select({
      itemId: reservations.itemId,
      lotId: sql<string>`coalesce(${reservations.lotId}, '')`,
      warehouseId: reservations.warehouseId,
      total: sql<number>`sum(${reservations.qty})`,
    })
    .from(reservations)
    .where(and(eq(reservations.tenantId, ctx.tenantId), eq(reservations.status, 'active')))
    .groupBy(reservations.itemId, sql`coalesce(${reservations.lotId}, '')`, reservations.warehouseId)
    .all();
  const resMap = new Map(resRows.map((r) => [`${r.itemId}|${r.lotId}|${r.warehouseId}`, r.total]));

  // quantities held by in-progress production batches (reserved-for-production)
  const inProcRows = ctx.db
    .select({
      lotId: productionBatches.inputLotId,
      warehouseId: productionBatches.inputWarehouseId,
      total: sql<number>`sum(${productionBatches.inputQty})`,
    })
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.tenantId, ctx.tenantId),
        eq(productionBatches.status, 'in_progress'),
      ),
    )
    .groupBy(productionBatches.inputLotId, productionBatches.inputWarehouseId)
    .all();
  const inProcMap = new Map(
    inProcRows.filter((r) => r.lotId).map((r) => [`${r.lotId}|${r.warehouseId}`, r.total]),
  );

  // lot metadata
  const lotRows = ctx.db.select().from(lots).where(eq(lots.tenantId, ctx.tenantId)).all();
  const lotMap = new Map(lotRows.map((l) => [l.id, l]));

  return rows.map((r) => {
    const lot = r.lotKey ? lotMap.get(r.lotKey) : undefined;
    const reserved = resMap.get(`${r.itemId}|${r.lotKey}|${r.warehouseId}`) ?? 0;
    const inProcess = r.lotKey ? (inProcMap.get(`${r.lotKey}|${r.warehouseId}`) ?? 0) : 0;
    const available = r.onHand - reserved;
    const lotAttrs = (lot?.attributes ?? {}) as { source?: string };
    const status: StockRow['status'] =
      r.onHand === 0 ? 'empty' : inProcess > 0 ? 'in_process' : reserved > 0 ? 'reserved' : 'available';
    return {
      itemId: r.itemId,
      itemCode: r.itemCode,
      itemName: r.itemName,
      itemKind: r.itemKind,
      unitWeightMilliKg: r.unitWeightMilliKg,
      lotId: r.lotKey || null,
      lotNumber: lot?.lotNumber ?? null,
      lotSource: lotAttrs.source ?? null,
      receivedAt: lot?.receivedAt ?? null,
      initialQty: lot?.initialQty ?? null,
      warehouseId: r.warehouseId,
      warehouseCode: r.warehouseCode,
      warehouseName: r.warehouseName,
      onHand: r.onHand,
      reserved,
      inProcess,
      available,
      status,
    };
  });
}
