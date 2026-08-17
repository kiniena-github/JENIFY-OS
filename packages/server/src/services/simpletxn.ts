import { and, desc, eq } from 'drizzle-orm';
import { simpleTransactions } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { nextDocNumber } from './numbering.js';
import { getItem, getWarehouse } from './masterdata.js';
import { getOnHand, postMovement } from './inventory.js';

export interface SimpleTxnInput {
  itemId: string;
  warehouseId: string;
  type: 'collect' | 'sell';
  qty: number; // whole units (pieces)
  buyer?: string;
  unitPrice?: number; // major currency units
  date: string;
  notes?: string;
  docSeqKey: string;
}

/** Post a collect (stock in) or sell (stock out + proceeds) in one step. */
export function postSimpleTxn(ctx: Ctx, input: SimpleTxnInput): { id: string; docNumber: string } {
  return inTx(ctx, (tx) => {
    getItem(tx, input.itemId);
    getWarehouse(tx, input.warehouseId);
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      badRequest('qty_invalid', 'Quantity must be a positive whole number');
    }
    const qtyMilli = input.qty * 1000;
    if (input.type === 'sell') {
      if (!input.buyer?.trim()) badRequest('buyer_required', 'Buyer is required for a sale');
      if (input.unitPrice == null || input.unitPrice < 0) {
        badRequest('price_required', 'Selling price is required');
      }
      const onHand = getOnHand(tx, input.itemId, input.warehouseId);
      if (onHand < qtyMilli) {
        badRequest('insufficient_stock', `Only ${onHand / 1000} pieces available`);
      }
    }
    const docNumber = nextDocNumber(tx, input.docSeqKey);
    const id = newId();
    tx.db
      .insert(simpleTransactions)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        type: input.type,
        qty: qtyMilli,
        buyer: input.buyer ?? null,
        unitPriceCents: input.unitPrice != null ? Math.round(input.unitPrice * 100) : null,
        date: input.date,
        notes: input.notes ?? null,
        recordedBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    postMovement(tx, {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      qty: input.type === 'collect' ? qtyMilli : -qtyMilli,
      movementType: input.type === 'collect' ? 'receipt' : 'issue',
      documentKind: 'simple_transaction',
      documentId: id,
      documentNumber: docNumber,
    });
    writeAudit(tx, {
      module: 'inventory',
      action: `simple_${input.type}`,
      entity: 'simple_transaction',
      entityId: id,
      reference: docNumber,
      summary:
        input.type === 'collect'
          ? `${docNumber}: ${input.qty} pieces collected`
          : `${docNumber}: ${input.qty} pieces sold to ${input.buyer}`,
    });
    return { id, docNumber };
  });
}

export function reverseSimpleTxn(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('reason_required', 'A reversal reason is required');
  inTx(ctx, (tx) => {
    const txn = tx.db
      .select()
      .from(simpleTransactions)
      .where(and(eq(simpleTransactions.tenantId, tx.tenantId), eq(simpleTransactions.id, id)))
      .get();
    if (!txn) notFound('txn_missing', 'Transaction not found');
    if (txn.lifecycle !== 'posted') badRequest('not_posted', 'Transaction is already reversed');
    postMovement(tx, {
      itemId: txn.itemId,
      warehouseId: txn.warehouseId,
      qty: txn.type === 'collect' ? -txn.qty : txn.qty,
      movementType: 'reversal',
      documentKind: 'simple_transaction',
      documentId: id,
      documentNumber: txn.docNumber,
      note: reason,
    });
    tx.db
      .update(simpleTransactions)
      .set({ lifecycle: 'reversed', reversalReason: reason })
      .where(eq(simpleTransactions.id, id))
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'simple_reverse',
      entity: 'simple_transaction',
      entityId: id,
      reference: txn.docNumber,
      summary: `${txn.docNumber} reversed`,
      reason,
    });
  });
}

export function listSimpleTxns(ctx: Ctx, itemId: string, filter: { limit?: number } = {}) {
  return ctx.db
    .select()
    .from(simpleTransactions)
    .where(and(eq(simpleTransactions.tenantId, ctx.tenantId), eq(simpleTransactions.itemId, itemId)))
    .orderBy(desc(simpleTransactions.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500))
    .all();
}
