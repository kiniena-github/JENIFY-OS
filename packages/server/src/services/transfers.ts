import { and, desc, eq } from 'drizzle-orm';
import { stockTransfers } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { getSettings } from './settings.js';
import { nextDocNumber } from './numbering.js';
import { getItem, getUom, getWarehouse, toBaseQty, baseUomCode } from './masterdata.js';
import { getAvailable, getLot, postMovement } from './inventory.js';

export interface TransferInput {
  itemId: string;
  lotId?: string | null;
  entryUomId: string;
  qty: number; // natural units
  fromWarehouseId: string;
  toWarehouseId: string;
  date: string;
  reason: string;
}

function validate(ctx: Ctx, input: TransferInput): number {
  getItem(ctx, input.itemId);
  getUom(ctx, input.entryUomId);
  getWarehouse(ctx, input.fromWarehouseId);
  getWarehouse(ctx, input.toWarehouseId);
  if (input.lotId) getLot(ctx, input.lotId);
  if (input.fromWarehouseId === input.toWarehouseId) {
    badRequest('transfer_same', 'Source and destination warehouses must differ');
  }
  if (!(input.qty > 0)) badRequest('transfer_qty', 'Quantity must be positive');
  if (!input.reason?.trim()) badRequest('transfer_reason', 'A reason is required');
  return toBaseQty(ctx, input.entryUomId, input.qty);
}

export function createTransfer(ctx: Ctx, input: TransferInput): { id: string; docNumber: string } {
  const baseQty = validate(ctx, input);
  return inTx(ctx, (tx) => {
    const docNumber = nextDocNumber(tx, 'transfer');
    const id = newId();
    tx.db
      .insert(stockTransfers)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        date: input.date,
        itemId: input.itemId,
        lotId: input.lotId ?? null,
        qty: baseQty,
        entryUomId: input.entryUomId,
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        requestedBy: actorId(tx),
        reason: input.reason,
        lifecycle: 'draft',
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'transfer_draft',
      entity: 'stock_transfer',
      entityId: id,
      reference: docNumber,
      summary: `Transfer ${docNumber} drafted`,
    });
    return { id, docNumber };
  });
}

/**
 * Approval posts matched movements: −source, +destination, linked as one pair.
 * Factory-wide total is unchanged by construction.
 */
export function postTransfer(ctx: Ctx, id: string): void {
  inTx(ctx, (tx) => {
    const doc = getTransfer(tx, id);
    if (doc.lifecycle !== 'draft') badRequest('not_draft', 'Transfer already processed');
    const available = getAvailable(tx, doc.itemId, doc.fromWarehouseId, doc.lotId ?? undefined);
    if (available < doc.qty) {
      badRequest(
        'insufficient_available',
        `Only ${available / 1000} ${baseUomCode(tx, doc.itemId)} available in the source warehouse`,
      );
    }
    const outId = postMovement(tx, {
      itemId: doc.itemId,
      lotId: doc.lotId,
      warehouseId: doc.fromWarehouseId,
      qty: -doc.qty,
      movementType: 'transfer_out',
      documentKind: 'stock_transfer',
      documentId: doc.id,
      documentNumber: doc.docNumber,
    });
    postMovement(tx, {
      itemId: doc.itemId,
      lotId: doc.lotId,
      warehouseId: doc.toWarehouseId,
      qty: doc.qty,
      movementType: 'transfer_in',
      documentKind: 'stock_transfer',
      documentId: doc.id,
      documentNumber: doc.docNumber,
      counterpartId: outId,
    });
    tx.db
      .update(stockTransfers)
      .set({
        lifecycle: 'posted',
        approvedBy: actorId(tx),
        postedAt: nowIso(),
        brandingVersion: getSettings(tx, 'branding')?.version ?? null,
      })
      .where(eq(stockTransfers.id, id))
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'transfer_post',
      entity: 'stock_transfer',
      entityId: id,
      reference: doc.docNumber,
      summary: `Transfer ${doc.docNumber} approved: ${doc.qty / 1000} ${baseUomCode(tx, doc.itemId)} moved`,
    });
  });
}

/** Reversal posts the opposite pair; the original transfer stays in history. */
export function reverseTransfer(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('reason_required', 'A reversal reason is required');
  inTx(ctx, (tx) => {
    const doc = getTransfer(tx, id);
    if (doc.lifecycle !== 'posted') badRequest('not_posted', 'Only completed transfers can be reversed');
    const availableAtDest = getAvailable(tx, doc.itemId, doc.toWarehouseId, doc.lotId ?? undefined);
    if (availableAtDest < doc.qty) {
      badRequest(
        'insufficient_available',
        'The transferred quantity is no longer available at the destination',
      );
    }
    const outId = postMovement(tx, {
      itemId: doc.itemId,
      lotId: doc.lotId,
      warehouseId: doc.toWarehouseId,
      qty: -doc.qty,
      movementType: 'reversal',
      documentKind: 'stock_transfer',
      documentId: doc.id,
      documentNumber: doc.docNumber,
      note: reason,
    });
    postMovement(tx, {
      itemId: doc.itemId,
      lotId: doc.lotId,
      warehouseId: doc.fromWarehouseId,
      qty: doc.qty,
      movementType: 'reversal',
      documentKind: 'stock_transfer',
      documentId: doc.id,
      documentNumber: doc.docNumber,
      counterpartId: outId,
      note: reason,
    });
    tx.db
      .update(stockTransfers)
      .set({ lifecycle: 'reversed', reversalReason: reason })
      .where(eq(stockTransfers.id, id))
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'transfer_reverse',
      entity: 'stock_transfer',
      entityId: id,
      reference: doc.docNumber,
      summary: `Transfer ${doc.docNumber} reversed`,
      reason,
    });
  });
}

export function cancelTransferDraft(ctx: Ctx, id: string, reason?: string): void {
  const doc = getTransfer(ctx, id);
  if (doc.lifecycle !== 'draft') badRequest('not_draft', 'Only drafts can be cancelled');
  ctx.db
    .update(stockTransfers)
    .set({ lifecycle: 'cancelled', reversalReason: reason ?? null })
    .where(eq(stockTransfers.id, id))
    .run();
  writeAudit(ctx, {
    module: 'inventory',
    action: 'transfer_cancel',
    entity: 'stock_transfer',
    entityId: id,
    reference: doc.docNumber,
    summary: `Transfer draft ${doc.docNumber} cancelled`,
    reason,
  });
}

export function getTransfer(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(stockTransfers)
    .where(and(eq(stockTransfers.tenantId, ctx.tenantId), eq(stockTransfers.id, id)))
    .get();
  if (!row) notFound('transfer_missing', 'Transfer not found');
  return row;
}

export function listTransfers(ctx: Ctx, filter: { limit?: number } = {}) {
  return ctx.db
    .select()
    .from(stockTransfers)
    .where(eq(stockTransfers.tenantId, ctx.tenantId))
    .orderBy(desc(stockTransfers.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500))
    .all();
}
