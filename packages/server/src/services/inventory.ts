import { and, desc, eq, sql } from 'drizzle-orm';
import type { MovementType, LotStatus } from '@factoryos/shared';
import { lots, reservations, stockBalances, stockMovements } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';

/**
 * Append-only inventory ledger.
 * Balances change ONLY through posted movements; there is no API to set a
 * balance directly. Corrections are new movements linked to their target.
 */

export interface PostMovementInput {
  itemId: string;
  lotId?: string | null;
  warehouseId: string;
  qty: number; // signed milli base-units; + increases stock
  movementType: MovementType;
  documentKind: string;
  documentId: string;
  documentNumber?: string;
  counterpartId?: string;
  note?: string;
  /** allow the balance to go negative (never used by normal operations) */
  allowNegative?: boolean;
}

export function postMovement(ctx: Ctx, input: PostMovementInput): string {
  if (!Number.isInteger(input.qty) || input.qty === 0) {
    badRequest('movement_qty', 'Movement quantity must be a non-zero integer');
  }
  const lotKey = input.lotId ?? '';
  const balance = ctx.db
    .select()
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, ctx.tenantId),
        eq(stockBalances.itemId, input.itemId),
        eq(stockBalances.lotId, lotKey),
        eq(stockBalances.warehouseId, input.warehouseId),
      ),
    )
    .get();
  const newQty = (balance?.qtyOnHand ?? 0) + input.qty;
  if (newQty < 0 && !input.allowNegative) {
    badRequest(
      'insufficient_stock',
      `Insufficient stock: movement would leave ${newQty / 1000} base units`,
    );
  }
  const id = newId();
  ctx.db
    .insert(stockMovements)
    .values({
      id,
      tenantId: ctx.tenantId,
      itemId: input.itemId,
      lotId: input.lotId ?? null,
      warehouseId: input.warehouseId,
      qty: input.qty,
      movementType: input.movementType,
      documentKind: input.documentKind,
      documentId: input.documentId,
      documentNumber: input.documentNumber ?? null,
      counterpartId: input.counterpartId ?? null,
      note: input.note ?? null,
      postedBy: actorId(ctx),
      postedAt: nowIso(),
    })
    .run();
  if (balance) {
    ctx.db
      .update(stockBalances)
      .set({ qtyOnHand: newQty, updatedAt: nowIso() })
      .where(eq(stockBalances.id, balance.id))
      .run();
  } else {
    ctx.db
      .insert(stockBalances)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        itemId: input.itemId,
        lotId: lotKey,
        warehouseId: input.warehouseId,
        qtyOnHand: newQty,
        updatedAt: nowIso(),
      })
      .run();
  }
  return id;
}

export function getOnHand(
  ctx: Ctx,
  itemId: string,
  warehouseId?: string,
  lotId?: string | null,
): number {
  const conds = [eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, itemId)];
  if (warehouseId) conds.push(eq(stockBalances.warehouseId, warehouseId));
  if (lotId !== undefined) conds.push(eq(stockBalances.lotId, lotId ?? ''));
  const rows = ctx.db
    .select({ total: sql<number>`coalesce(sum(${stockBalances.qtyOnHand}), 0)` })
    .from(stockBalances)
    .where(and(...conds))
    .all();
  return rows[0]?.total ?? 0;
}

export function getReserved(
  ctx: Ctx,
  itemId: string,
  warehouseId?: string,
  lotId?: string | null,
): number {
  const conds = [
    eq(reservations.tenantId, ctx.tenantId),
    eq(reservations.itemId, itemId),
    eq(reservations.status, 'active'),
  ];
  if (warehouseId) conds.push(eq(reservations.warehouseId, warehouseId));
  if (lotId != null) conds.push(eq(reservations.lotId, lotId));
  const rows = ctx.db
    .select({ total: sql<number>`coalesce(sum(${reservations.qty}), 0)` })
    .from(reservations)
    .where(and(...conds))
    .all();
  return rows[0]?.total ?? 0;
}

export function getAvailable(
  ctx: Ctx,
  itemId: string,
  warehouseId?: string,
  lotId?: string | null,
): number {
  return getOnHand(ctx, itemId, warehouseId, lotId) - getReserved(ctx, itemId, warehouseId, lotId);
}

// ----------------------------- Reservations --------------------------------

export function createReservation(
  ctx: Ctx,
  input: {
    itemId: string;
    lotId?: string | null;
    warehouseId: string;
    qty: number; // positive milli
    documentKind: string;
    documentId: string;
  },
): string {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    badRequest('reservation_qty', 'Reservation quantity must be positive');
  }
  const available = getAvailable(ctx, input.itemId, input.warehouseId, input.lotId ?? undefined);
  if (available < input.qty) {
    badRequest(
      'insufficient_available',
      `Cannot reserve ${input.qty / 1000}: only ${available / 1000} available`,
    );
  }
  const id = newId();
  ctx.db
    .insert(reservations)
    .values({
      id,
      tenantId: ctx.tenantId,
      itemId: input.itemId,
      lotId: input.lotId ?? null,
      warehouseId: input.warehouseId,
      qty: input.qty,
      documentKind: input.documentKind,
      documentId: input.documentId,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  return id;
}

function closeReservation(ctx: Ctx, reservationId: string, status: 'consumed' | 'released'): void {
  const row = ctx.db
    .select()
    .from(reservations)
    .where(and(eq(reservations.tenantId, ctx.tenantId), eq(reservations.id, reservationId)))
    .get();
  if (!row) notFound('reservation_missing', 'Reservation not found');
  if (row.status !== 'active') badRequest('reservation_closed', 'Reservation is not active');
  ctx.db
    .update(reservations)
    .set({ status, closedAt: nowIso() })
    .where(eq(reservations.id, reservationId))
    .run();
}

export function consumeReservation(ctx: Ctx, reservationId: string): void {
  closeReservation(ctx, reservationId, 'consumed');
}
export function releaseReservation(ctx: Ctx, reservationId: string): void {
  closeReservation(ctx, reservationId, 'released');
}

export function listReservationsForDocument(ctx: Ctx, documentKind: string, documentId: string) {
  return ctx.db
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, ctx.tenantId),
        eq(reservations.documentKind, documentKind),
        eq(reservations.documentId, documentId),
      ),
    )
    .all();
}

// ----------------------------- Lots ----------------------------------------

export function createLot(
  ctx: Ctx,
  input: {
    itemId: string;
    lotNumber: string;
    sourceKind?: string;
    sourceId?: string;
    attributes?: Record<string, unknown>;
    receivedAt?: string;
    initialQty?: number;
  },
): string {
  const id = newId();
  ctx.db
    .insert(lots)
    .values({
      id,
      tenantId: ctx.tenantId,
      itemId: input.itemId,
      lotNumber: input.lotNumber,
      sourceKind: input.sourceKind ?? null,
      sourceId: input.sourceId ?? null,
      attributes: (input.attributes as object) ?? null,
      receivedAt: input.receivedAt ?? null,
      initialQty: input.initialQty ?? 0,
      createdAt: nowIso(),
    })
    .run();
  return id;
}

export function getLot(ctx: Ctx, lotId: string) {
  const row = ctx.db
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, ctx.tenantId), eq(lots.id, lotId)))
    .get();
  if (!row) notFound('lot_missing', 'Lot/batch not found');
  return row;
}

export function setLotStatus(ctx: Ctx, lotId: string, status: LotStatus): void {
  getLot(ctx, lotId);
  ctx.db.update(lots).set({ status }).where(eq(lots.id, lotId)).run();
}

/** Per-warehouse balances of one lot. */
export function getLotBalances(ctx: Ctx, lotId: string) {
  return ctx.db
    .select()
    .from(stockBalances)
    .where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.lotId, lotId)))
    .all();
}

export function listMovements(
  ctx: Ctx,
  filter: {
    itemId?: string;
    lotId?: string;
    warehouseId?: string;
    documentKind?: string;
    documentId?: string;
    limit?: number;
  } = {},
) {
  const conds = [eq(stockMovements.tenantId, ctx.tenantId)];
  if (filter.itemId) conds.push(eq(stockMovements.itemId, filter.itemId));
  if (filter.lotId) conds.push(eq(stockMovements.lotId, filter.lotId));
  if (filter.warehouseId) conds.push(eq(stockMovements.warehouseId, filter.warehouseId));
  if (filter.documentKind) conds.push(eq(stockMovements.documentKind, filter.documentKind));
  if (filter.documentId) conds.push(eq(stockMovements.documentId, filter.documentId));
  return ctx.db
    .select()
    .from(stockMovements)
    .where(and(...conds))
    .orderBy(desc(stockMovements.postedAt))
    .limit(Math.min(filter.limit ?? 200, 1000))
    .all();
}

/**
 * Integrity check / repair: recompute every balance from the ledger.
 * Returns discrepancies found (should always be empty in a healthy system).
 */
export function recomputeBalances(ctx: Ctx): Array<{
  itemId: string;
  lotId: string;
  warehouseId: string;
  cached: number;
  actual: number;
}> {
  const sums = ctx.db
    .select({
      itemId: stockMovements.itemId,
      lotId: sql<string>`coalesce(${stockMovements.lotId}, '')`,
      warehouseId: stockMovements.warehouseId,
      total: sql<number>`sum(${stockMovements.qty})`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.tenantId, ctx.tenantId))
    .groupBy(stockMovements.itemId, sql`coalesce(${stockMovements.lotId}, '')`, stockMovements.warehouseId)
    .all();
  const balances = ctx.db
    .select()
    .from(stockBalances)
    .where(eq(stockBalances.tenantId, ctx.tenantId))
    .all();
  const diffs: Array<{ itemId: string; lotId: string; warehouseId: string; cached: number; actual: number }> = [];
  const key = (i: string, l: string, w: string) => `${i}|${l}|${w}`;
  const sumMap = new Map(sums.map((s) => [key(s.itemId, s.lotId, s.warehouseId), s.total]));
  for (const b of balances) {
    const actual = sumMap.get(key(b.itemId, b.lotId, b.warehouseId)) ?? 0;
    if (actual !== b.qtyOnHand) {
      diffs.push({ itemId: b.itemId, lotId: b.lotId, warehouseId: b.warehouseId, cached: b.qtyOnHand, actual });
      ctx.db
        .update(stockBalances)
        .set({ qtyOnHand: actual, updatedAt: nowIso() })
        .where(eq(stockBalances.id, b.id))
        .run();
    }
    sumMap.delete(key(b.itemId, b.lotId, b.warehouseId));
  }
  for (const [k, actual] of sumMap) {
    const [itemId, lotId, warehouseId] = k.split('|');
    diffs.push({ itemId, lotId, warehouseId, cached: 0, actual });
    ctx.db
      .insert(stockBalances)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        itemId,
        lotId,
        warehouseId,
        qtyOnHand: actual,
        updatedAt: nowIso(),
      })
      .run();
  }
  return diffs;
}
