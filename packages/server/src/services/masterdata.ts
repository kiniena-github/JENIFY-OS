import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { ItemKind, TrackingMode } from '@factoryos/shared';
import {
  items,
  uoms,
  warehouses,
  stockBalances,
  reservations,
  stockMovements,
  goodsReceipts,
  stockTransfers,
  productionBatches,
  invoiceLines,
  simpleTransactions,
} from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import { requireQty } from '../validate.js';
import type { Ctx } from './context.js';
import { writeAudit } from './audit.js';

// ----------------------------- Units of measure ----------------------------

export function createUom(
  ctx: Ctx,
  input: { code: string; name: string; family: string; factorToBase: number },
): string {
  if (input.factorToBase <= 0) badRequest('uom_factor', 'Conversion factor must be positive');
  const id = newId();
  ctx.db
    .insert(uoms)
    .values({
      id,
      tenantId: ctx.tenantId,
      code: input.code,
      name: input.name,
      family: input.family,
      factorToBase: Math.round(input.factorToBase * 1000), // stored in milli
    })
    .run();
  return id;
}

export function listUoms(ctx: Ctx) {
  return ctx.db.select().from(uoms).where(eq(uoms.tenantId, ctx.tenantId)).all();
}

export function getUom(ctx: Ctx, uomId: string) {
  const row = ctx.db
    .select()
    .from(uoms)
    .where(and(eq(uoms.tenantId, ctx.tenantId), eq(uoms.id, uomId)))
    .get();
  if (!row) notFound('uom_missing', 'Unit of measure not found');
  return row;
}

/**
 * Ledger-integrity ceiling (D5). A single entry quantity is capped far below
 * anything a real business posts (1e9 natural units) but far below
 * MAX_SAFE_INTEGER after conversion, so no movement — even one smuggled through
 * an import or offline replay — can push a running on-hand sum past the exact
 * integer range and permanently corrupt the append-only ledger.
 */
export const MAX_ENTRY_QTY = 1e9;

/**
 * Convert an entry quantity to milli base-units.
 * entryQty is in natural units (e.g. 10.5 ton); result is milli base (kg*1000).
 */
export function toBaseQty(ctx: Ctx, uomId: string, entryQty: number): number {
  // Shared discipline (AI TASK #3): reject by TYPE first — booleans, numeric
  // strings, arrays and objects are never quantities however JS coerces them —
  // then finiteness, then magnitude. This is the single funnel every
  // natural-unit quantity passes through, so the whole bug family dies here.
  requireQty(entryQty, 'Quantity', { allowNegative: true, max: MAX_ENTRY_QTY });
  const uom = getUom(ctx, uomId);
  // factorToBase is stored in milli, so this yields milli base-units directly.
  return Math.round(entryQty * uom.factorToBase);
}

/** Human unit code (kg / pc / …) of an item's base unit — for audit text. */
export function baseUomCode(ctx: Ctx, itemId: string): string {
  const item = getItem(ctx, itemId);
  return getUom(ctx, item.baseUomId).code;
}

// ----------------------------- Items ---------------------------------------

export function createItem(
  ctx: Ctx,
  input: {
    code: string;
    name: string;
    kind: ItemKind;
    trackingMode?: TrackingMode;
    baseUomId: string;
    unitWeightKg?: number;
    sellable?: boolean;
    purchasable?: boolean;
    attributes?: Record<string, unknown>;
  },
): string {
  getUom(ctx, input.baseUomId);
  const id = newId();
  ctx.db
    .insert(items)
    .values({
      id,
      tenantId: ctx.tenantId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      trackingMode: input.trackingMode ?? 'none',
      baseUomId: input.baseUomId,
      unitWeightMilliKg: input.unitWeightKg != null ? Math.round(input.unitWeightKg * 1000) : null,
      sellable: input.sellable ?? false,
      purchasable: input.purchasable ?? false,
      attributes: (input.attributes as object) ?? null,
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'inventory',
    action: 'item_create',
    entity: 'item',
    entityId: id,
    reference: input.code,
    summary: `Item '${input.name}' created`,
  });
  return id;
}

export function listItems(ctx: Ctx, filter: { kind?: ItemKind; sellable?: boolean } = {}) {
  const conds = [eq(items.tenantId, ctx.tenantId)];
  if (filter.kind) conds.push(eq(items.kind, filter.kind));
  if (filter.sellable !== undefined) conds.push(eq(items.sellable, filter.sellable));
  return ctx.db
    .select()
    .from(items)
    .where(and(...conds))
    .all();
}

export function getItem(ctx: Ctx, itemId: string) {
  const row = ctx.db
    .select()
    .from(items)
    .where(and(eq(items.tenantId, ctx.tenantId), eq(items.id, itemId)))
    .get();
  if (!row) notFound('item_missing', 'Item not found');
  return row;
}

// ----------------------------- Warehouses ----------------------------------

export function createWarehouse(
  ctx: Ctx,
  input: { code: string; name: string; locationNote?: string },
): string {
  const id = newId();
  ctx.db
    .insert(warehouses)
    .values({
      id,
      tenantId: ctx.tenantId,
      code: input.code,
      name: input.name,
      locationNote: input.locationNote ?? null,
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'warehouse_create',
    entity: 'warehouse',
    entityId: id,
    reference: input.code,
    summary: `Warehouse '${input.name}' created`,
  });
  return id;
}

export function listWarehouses(ctx: Ctx, opts: { includeInactive?: boolean } = {}) {
  const conds = [eq(warehouses.tenantId, ctx.tenantId)];
  if (!opts.includeInactive) conds.push(eq(warehouses.active, true));
  return ctx.db
    .select()
    .from(warehouses)
    .where(and(...conds))
    .all();
}

export function getWarehouse(ctx: Ctx, warehouseId: string) {
  const row = ctx.db
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.id, warehouseId)))
    .get();
  if (!row) notFound('warehouse_missing', 'Warehouse not found');
  return row;
}

export function updateWarehouse(
  ctx: Ctx,
  warehouseId: string,
  patch: { name?: string; locationNote?: string; active?: boolean },
): void {
  const wh = getWarehouse(ctx, warehouseId);
  if (patch.active === false) {
    const withStock = ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.tenantId, ctx.tenantId),
          eq(stockBalances.warehouseId, warehouseId),
          gt(stockBalances.qtyOnHand, 0),
        ),
      )
      .get();
    const withReservations = ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, ctx.tenantId),
          eq(reservations.warehouseId, warehouseId),
          eq(reservations.status, 'active'),
        ),
      )
      .get();
    if ((withStock?.n ?? 0) > 0 || (withReservations?.n ?? 0) > 0) {
      badRequest(
        'warehouse_in_use',
        'Cannot deactivate a warehouse that still holds stock or active reservations',
      );
    }
  }
  const before = { name: wh.name, locationNote: wh.locationNote, active: wh.active };
  ctx.db
    .update(warehouses)
    .set({
      name: patch.name ?? wh.name,
      locationNote: patch.locationNote ?? wh.locationNote,
      active: patch.active ?? wh.active,
    })
    .where(eq(warehouses.id, warehouseId))
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'warehouse_update',
    entity: 'warehouse',
    entityId: warehouseId,
    reference: wh.code,
    summary: `Warehouse '${wh.name}' updated`,
    before,
    after: patch,
  });
}

/**
 * True when ANY transaction or history row has ever referenced the warehouse.
 * Once used, a warehouse may only be archived — never permanently deleted —
 * even if its current stock is back to zero, so history can always resolve.
 */
export function warehouseEverUsed(ctx: Ctx, warehouseId: string): boolean {
  const t = ctx.tenantId;
  const checks: Array<() => unknown> = [
    () =>
      ctx.db
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(and(eq(stockMovements.tenantId, t), eq(stockMovements.warehouseId, warehouseId)))
        .limit(1)
        .get(),
    () =>
      ctx.db
        .select({ id: stockBalances.id })
        .from(stockBalances)
        .where(and(eq(stockBalances.tenantId, t), eq(stockBalances.warehouseId, warehouseId)))
        .limit(1)
        .get(),
    () =>
      ctx.db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.tenantId, t), eq(reservations.warehouseId, warehouseId)))
        .limit(1)
        .get(),
    () =>
      ctx.db
        .select({ id: goodsReceipts.id })
        .from(goodsReceipts)
        .where(and(eq(goodsReceipts.tenantId, t), eq(goodsReceipts.warehouseId, warehouseId)))
        .limit(1)
        .get(),
    () =>
      ctx.db
        .select({ id: stockTransfers.id })
        .from(stockTransfers)
        .where(
          and(
            eq(stockTransfers.tenantId, t),
            or(
              eq(stockTransfers.fromWarehouseId, warehouseId),
              eq(stockTransfers.toWarehouseId, warehouseId),
            ),
          ),
        )
        .limit(1)
        .get(),
    () =>
      ctx.db
        .select({ id: productionBatches.id })
        .from(productionBatches)
        .where(
          and(
            eq(productionBatches.tenantId, t),
            or(
              eq(productionBatches.inputWarehouseId, warehouseId),
              eq(productionBatches.outputWarehouseId, warehouseId),
            ),
          ),
        )
        .limit(1)
        .get(),
    () =>
      ctx.db
        .select({ id: invoiceLines.id })
        .from(invoiceLines)
        .where(and(eq(invoiceLines.tenantId, t), eq(invoiceLines.warehouseId, warehouseId)))
        .limit(1)
        .get(),
    () =>
      ctx.db
        .select({ id: simpleTransactions.id })
        .from(simpleTransactions)
        .where(and(eq(simpleTransactions.tenantId, t), eq(simpleTransactions.warehouseId, warehouseId)))
        .limit(1)
        .get(),
  ];
  return checks.some((q) => q() != null);
}

/**
 * Permanent delete — allowed ONLY for a warehouse that has never been touched
 * by any transaction. Anything with history must be archived instead.
 */
export function deleteWarehouse(ctx: Ctx, warehouseId: string): void {
  const wh = getWarehouse(ctx, warehouseId);
  if (warehouseEverUsed(ctx, warehouseId)) {
    badRequest(
      'warehouse_has_history',
      `Warehouse '${wh.name}' has transaction history and cannot be permanently deleted — archive it instead`,
    );
  }
  ctx.db.delete(warehouses).where(eq(warehouses.id, warehouseId)).run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'warehouse_delete',
    entity: 'warehouse',
    entityId: warehouseId,
    reference: wh.code,
    summary: `Unused warehouse '${wh.name}' permanently deleted`,
    before: { code: wh.code, name: wh.name },
  });
}

/** Item configuration update — business identity/config only, never stock. */
export function updateItem(
  ctx: Ctx,
  itemId: string,
  patch: { name?: string; sellable?: boolean; purchasable?: boolean; unitWeightKg?: number | null; active?: boolean },
): void {
  const item = getItem(ctx, itemId);
  const before = {
    name: item.name,
    sellable: item.sellable,
    purchasable: item.purchasable,
    unitWeightMilliKg: item.unitWeightMilliKg,
    active: item.active,
  };
  ctx.db
    .update(items)
    .set({
      name: patch.name ?? item.name,
      sellable: patch.sellable ?? item.sellable,
      purchasable: patch.purchasable ?? item.purchasable,
      unitWeightMilliKg:
        patch.unitWeightKg === undefined
          ? item.unitWeightMilliKg
          : patch.unitWeightKg == null
            ? null
            : Math.round(patch.unitWeightKg * 1000),
      active: patch.active ?? item.active,
    })
    .where(eq(items.id, itemId))
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'item_update',
    entity: 'item',
    entityId: itemId,
    reference: item.code,
    summary: `Product '${item.name}' configuration updated`,
    before,
    after: patch,
  });
}
