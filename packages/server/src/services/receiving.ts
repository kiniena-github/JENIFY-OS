import { and, desc, eq } from 'drizzle-orm';
import { goodsReceipts } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { nextDocNumber } from './numbering.js';
import { getItem, getUom, getWarehouse, toBaseQty, baseUomCode } from './masterdata.js';
import { getParty } from './parties.js';
import { createLot, postMovement } from './inventory.js';

export interface ReceiptInput {
  supplierId: string;
  source?: string;
  truckNumber?: string;
  driverName?: string;
  date: string;
  itemId: string;
  entryUomId: string;
  grossQty?: number; // natural units
  netQty: number; // natural units
  warehouseId: string;
  receivedByUserId?: string;
  remarks?: string;
}

function validate(ctx: Ctx, input: ReceiptInput): { netBase: number; grossBase: number | null } {
  getParty(ctx, input.supplierId);
  const item = getItem(ctx, input.itemId);
  const uom = getUom(ctx, input.entryUomId);
  getWarehouse(ctx, input.warehouseId);
  if (!input.date) badRequest('receipt_date', 'Date is required');
  if (!(input.netQty > 0)) badRequest('receipt_qty', 'Net quantity must be positive');
  const baseUom = getUom(ctx, item.baseUomId);
  if (uom.family !== baseUom.family) {
    badRequest('receipt_uom', `Unit '${uom.code}' does not measure this item`);
  }
  const netBase = toBaseQty(ctx, input.entryUomId, input.netQty);
  const grossBase = input.grossQty != null ? toBaseQty(ctx, input.entryUomId, input.grossQty) : null;
  if (grossBase != null && netBase > grossBase) {
    badRequest('receipt_net_gross', 'Net quantity cannot exceed gross quantity');
  }
  return { netBase, grossBase };
}

export function createReceipt(ctx: Ctx, input: ReceiptInput): { id: string; docNumber: string } {
  const { netBase, grossBase } = validate(ctx, input);
  return inTx(ctx, (tx) => {
    const docNumber = nextDocNumber(tx, 'receiving');
    const id = newId();
    tx.db
      .insert(goodsReceipts)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        date: input.date,
        supplierId: input.supplierId,
        source: input.source ?? null,
        truckNumber: input.truckNumber ?? null,
        driverName: input.driverName ?? null,
        itemId: input.itemId,
        grossQty: grossBase,
        netQty: netBase,
        entryUomId: input.entryUomId,
        entryQty: Math.round(input.netQty * 1000),
        warehouseId: input.warehouseId,
        receivedByUserId: input.receivedByUserId ?? actorId(tx),
        remarks: input.remarks ?? null,
        lifecycle: 'draft',
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'receipt_draft',
      entity: 'goods_receipt',
      entityId: id,
      reference: docNumber,
      summary: `Receiving ${docNumber} drafted (${netBase / 1000} ${baseUomCode(tx, input.itemId)})`,
    });
    return { id, docNumber };
  });
}

export function updateReceiptDraft(ctx: Ctx, id: string, input: ReceiptInput): void {
  const doc = getReceipt(ctx, id);
  if (doc.lifecycle !== 'draft') badRequest('not_draft', 'Only drafts can be edited');
  const { netBase, grossBase } = validate(ctx, input);
  ctx.db
    .update(goodsReceipts)
    .set({
      date: input.date,
      supplierId: input.supplierId,
      source: input.source ?? null,
      truckNumber: input.truckNumber ?? null,
      driverName: input.driverName ?? null,
      itemId: input.itemId,
      grossQty: grossBase,
      netQty: netBase,
      entryUomId: input.entryUomId,
      entryQty: Math.round(input.netQty * 1000),
      warehouseId: input.warehouseId,
      remarks: input.remarks ?? null,
    })
    .where(eq(goodsReceipts.id, id))
    .run();
}

/**
 * Posting a receipt is the business fact "goods arrived":
 * creates/links a traceable lot, adds net quantity to the warehouse,
 * writes the stock movement, and records the approver.
 */
export function postReceipt(ctx: Ctx, id: string): void {
  inTx(ctx, (tx) => {
    const doc = getReceipt(tx, id);
    if (doc.lifecycle !== 'draft') badRequest('not_draft', 'Receipt is already posted or closed');
    const item = getItem(tx, doc.itemId);

    let lotId: string | null = null;
    if (item.trackingMode === 'lot') {
      const attrs = (item.attributes ?? {}) as { lotSeqKey?: string };
      const lotNumber = attrs.lotSeqKey ? nextDocNumber(tx, attrs.lotSeqKey) : doc.docNumber;
      lotId = createLot(tx, {
        itemId: doc.itemId,
        lotNumber,
        sourceKind: 'goods_receipt',
        sourceId: doc.id,
        attributes: doc.source ? { source: doc.source } : undefined,
        receivedAt: doc.date,
        initialQty: doc.netQty,
      });
    }
    postMovement(tx, {
      itemId: doc.itemId,
      lotId,
      warehouseId: doc.warehouseId,
      qty: doc.netQty,
      movementType: 'receipt',
      documentKind: 'goods_receipt',
      documentId: doc.id,
      documentNumber: doc.docNumber,
    });
    tx.db
      .update(goodsReceipts)
      .set({ lifecycle: 'posted', lotId, approvedBy: actorId(tx), postedAt: nowIso() })
      .where(eq(goodsReceipts.id, id))
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'receipt_post',
      entity: 'goods_receipt',
      entityId: id,
      reference: doc.docNumber,
      summary: `Receiving ${doc.docNumber} approved: +${doc.netQty / 1000} ${baseUomCode(tx, doc.itemId)} into warehouse`,
      after: { lotId, netQty: doc.netQty },
    });
  });
}

/** Reversal posts an opposite movement — history is preserved, never deleted. */
export function reverseReceipt(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('reason_required', 'A reversal reason is required');
  inTx(ctx, (tx) => {
    const doc = getReceipt(tx, id);
    if (doc.lifecycle !== 'posted') badRequest('not_posted', 'Only posted receipts can be reversed');
    postMovement(tx, {
      itemId: doc.itemId,
      lotId: doc.lotId,
      warehouseId: doc.warehouseId,
      qty: -doc.netQty,
      movementType: 'reversal',
      documentKind: 'goods_receipt',
      documentId: doc.id,
      documentNumber: doc.docNumber,
      note: reason,
    });
    tx.db
      .update(goodsReceipts)
      .set({ lifecycle: 'reversed', reversalReason: reason })
      .where(eq(goodsReceipts.id, id))
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'receipt_reverse',
      entity: 'goods_receipt',
      entityId: id,
      reference: doc.docNumber,
      summary: `Receiving ${doc.docNumber} reversed`,
      reason,
    });
  });
}

export function cancelReceiptDraft(ctx: Ctx, id: string, reason?: string): void {
  const doc = getReceipt(ctx, id);
  if (doc.lifecycle !== 'draft') badRequest('not_draft', 'Only drafts can be cancelled');
  ctx.db
    .update(goodsReceipts)
    .set({ lifecycle: 'cancelled', reversalReason: reason ?? null })
    .where(eq(goodsReceipts.id, id))
    .run();
  writeAudit(ctx, {
    module: 'inventory',
    action: 'receipt_cancel',
    entity: 'goods_receipt',
    entityId: id,
    reference: doc.docNumber,
    summary: `Receiving draft ${doc.docNumber} cancelled`,
    reason,
  });
}

export function getReceipt(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.tenantId, ctx.tenantId), eq(goodsReceipts.id, id)))
    .get();
  if (!row) notFound('receipt_missing', 'Receiving record not found');
  return row;
}

export function listReceipts(ctx: Ctx, filter: { limit?: number } = {}) {
  return ctx.db
    .select()
    .from(goodsReceipts)
    .where(eq(goodsReceipts.tenantId, ctx.tenantId))
    .orderBy(desc(goodsReceipts.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500))
    .all();
}
