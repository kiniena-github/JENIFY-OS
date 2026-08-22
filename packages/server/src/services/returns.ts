import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  creditNoteLines,
  creditNotes,
  goodsReceipts,
  invoiceLines,
  purchaseReturns,
  salesInvoices,
} from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { requirePermission } from './permissions.js';
import { postMovement } from './inventory.js';
import { nextDocNumber, defineSequence } from './numbering.js';
import { getInvoice, listInvoiceLines } from './sales.js';
import { getReceipt } from './receiving.js';

/**
 * Returns — sales credit notes and purchase returns.
 *
 * Ledger discipline (invariant #1, #5, #9): a return NEVER edits the original
 * invoice or receipt. It is a NEW posted document that posts its own
 * compensating movement (sale_return +stock, purchase_return -stock) and
 * adjusts the DERIVED receivable/payable. Partial quantities are supported and
 * cumulative over-return is blocked. Reversible via an audited status flip.
 */

// defineSequence is idempotent (updates prefix if present, else inserts), so a
// tenant that never seeded a returns sequence still gets one on first use.
function ensureSeq(ctx: Ctx, key: string, prefix: string): void {
  defineSequence(ctx, key, prefix, 4);
}

// ---------------------------------------------------------------------------
// A. Sales returns / credit notes
// ---------------------------------------------------------------------------

export interface SalesReturnLineInput {
  invoiceLineId: string;
  qty: number; // NATURAL units returned (same unit the line was sold in) — validated <= sold
  restock?: boolean; // default true: goods come back into stock
}

export interface SalesReturnInput {
  invoiceId: string;
  date: string;
  reason?: string;
  lines: SalesReturnLineInput[];
}

/** Milli base-units already credited per invoice line (posted credit notes). */
function returnedByLine(ctx: Ctx, invoiceId: string): Map<string, number> {
  const rows = ctx.db
    .select({
      invoiceLineId: creditNoteLines.invoiceLineId,
      qty: sql<number>`coalesce(sum(${creditNoteLines.qty}), 0)`,
    })
    .from(creditNoteLines)
    .innerJoin(creditNotes, eq(creditNoteLines.creditNoteId, creditNotes.id))
    .where(
      and(
        eq(creditNotes.tenantId, ctx.tenantId),
        eq(creditNotes.invoiceId, invoiceId),
        eq(creditNotes.status, 'posted'),
      ),
    )
    .groupBy(creditNoteLines.invoiceLineId)
    .all();
  return new Map(rows.map((r) => [r.invoiceLineId ?? '', r.qty]));
}

export function createSalesReturn(ctx: Ctx, input: SalesReturnInput): { id: string; docNumber: string; totalCents: number } {
  requirePermission(ctx, 'sales', 'create');
  const invoice = getInvoice(ctx, input.invoiceId);
  if (!['dispatched', 'completed'].includes(invoice.status)) {
    badRequest('return_status', 'Only dispatched or completed invoices can be returned (goods must have left)');
  }
  if (!input.lines?.length) badRequest('return_lines', 'At least one return line is required');
  const lines = listInvoiceLines(ctx, input.invoiceId);
  const byId = new Map(lines.map((l) => [l.id, l]));

  // Aggregate the caller's lines by invoiceLineId BEFORE validating (red-team
  // R3 F1): a duplicate id in one request must not bypass the cumulative
  // over-return ceiling. Each line is validated and processed exactly once
  // against its total requested qty. `restock=false` on ANY entry for a line
  // marks the whole aggregated return of that line as non-restocking.
  const aggregated = new Map<string, { qtyMilli: number; restock: boolean }>();
  for (const rl of input.lines) {
    if (!byId.has(rl.invoiceLineId)) badRequest('return_line_unknown', `Invoice line ${rl.invoiceLineId} not on this invoice`);
    if (!(rl.qty > 0)) badRequest('return_qty', 'Return quantity must be positive');
    const cur = aggregated.get(rl.invoiceLineId) ?? { qtyMilli: 0, restock: true };
    cur.qtyMilli += Math.round(rl.qty * 1000);
    if (rl.restock === false) cur.restock = false;
    aggregated.set(rl.invoiceLineId, cur);
  }

  return inTx(ctx, (tx) => {
    ensureSeq(tx, 'credit_note', 'CN-');
    // TOCTOU defense (R3 F3): read prior-returned inside the tx
    const alreadyReturned = returnedByLine(tx, input.invoiceId);
    const docNumber = nextDocNumber(tx, 'credit_note');
    const creditNoteId = newId();
    const now = nowIso();
    let totalCents = 0;
    const outLines: Array<{ id: string; itemId: string; warehouseId: string; lotId: string | null; qty: number; restock: boolean; amountCents: number; invoiceLineId: string }> = [];

    for (const [invoiceLineId, { qtyMilli, restock }] of aggregated) {
      const line = byId.get(invoiceLineId)!;
      const soldMilli = line.qty;
      const priorMilli = alreadyReturned.get(invoiceLineId) ?? 0;
      if (priorMilli + qtyMilli > soldMilli) {
        badRequest('over_return', `Cannot return more than sold (line ${invoiceLineId}: sold ${soldMilli / 1000}, already returned ${priorMilli / 1000})`);
      }
      // proportional credit of the line subtotal (grounded, never invented)
      const amountCents = Math.round((line.lineSubtotalCents * qtyMilli) / soldMilli);
      totalCents += amountCents;
      if (restock) {
        postMovement(tx, {
          itemId: line.itemId,
          lotId: line.lotId,
          warehouseId: line.warehouseId,
          qty: qtyMilli, // + : stock returns
          movementType: 'sale_return',
          documentKind: 'credit_note',
          documentId: creditNoteId,
          documentNumber: docNumber,
        });
      }
      outLines.push({ id: newId(), itemId: line.itemId, warehouseId: line.warehouseId, lotId: line.lotId, qty: qtyMilli, restock, amountCents, invoiceLineId });
    }

    tx.db.insert(creditNotes).values({
      id: creditNoteId, tenantId: tx.tenantId, docNumber, invoiceId: input.invoiceId, customerId: invoice.customerId,
      date: input.date, reason: input.reason ?? null, totalCents, status: 'posted', createdBy: actorId(tx), createdAt: now,
    }).run();
    for (const l of outLines) {
      tx.db.insert(creditNoteLines).values({ id: l.id, tenantId: tx.tenantId, creditNoteId, invoiceLineId: l.invoiceLineId, itemId: l.itemId, warehouseId: l.warehouseId, lotId: l.lotId, qty: l.qty, restock: l.restock, amountCents: l.amountCents }).run();
    }
    writeAudit(tx, {
      module: 'sales', action: 'sales_return', entity: 'credit_note', entityId: creditNoteId, reference: docNumber,
      summary: `Credit note ${docNumber} for invoice ${invoice.docNumber} — ${totalCents / 100} credited`,
    });
    return { id: creditNoteId, docNumber, totalCents };
  });
}

/** Total posted credit-note cents per invoice — reduces the receivable. */
export function creditNotedByInvoice(ctx: Ctx, invoiceIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (invoiceIds.length === 0) return out;
  const rows = ctx.db
    .select({ invoiceId: creditNotes.invoiceId, total: sql<number>`coalesce(sum(${creditNotes.totalCents}), 0)` })
    .from(creditNotes)
    .where(and(eq(creditNotes.tenantId, ctx.tenantId), inArray(creditNotes.invoiceId, invoiceIds), eq(creditNotes.status, 'posted')))
    .groupBy(creditNotes.invoiceId)
    .all();
  for (const r of rows) out.set(r.invoiceId, r.total);
  return out;
}

/** Reverse a posted credit note: un-restock and mark reversed (audited). */
export function reverseSalesReturn(ctx: Ctx, creditNoteId: string, reason: string): void {
  requirePermission(ctx, 'sales', 'edit');
  if (!reason?.trim()) badRequest('reason', 'A reversal reason is required');
  const cn = ctx.db.select().from(creditNotes).where(and(eq(creditNotes.tenantId, ctx.tenantId), eq(creditNotes.id, creditNoteId))).get();
  if (!cn) notFound('credit_note_missing', 'Credit note not found');
  if (cn.status !== 'posted') badRequest('not_posted', 'Only a posted credit note can be reversed');
  const cnLines = ctx.db.select().from(creditNoteLines).where(and(eq(creditNoteLines.tenantId, ctx.tenantId), eq(creditNoteLines.creditNoteId, creditNoteId))).all();
  inTx(ctx, (tx) => {
    for (const l of cnLines) {
      if (l.restock) {
        // reverse the restock: stock goes back OUT
        postMovement(tx, { itemId: l.itemId, lotId: l.lotId, warehouseId: l.warehouseId, qty: -l.qty, movementType: 'reversal', documentKind: 'credit_note', documentId: creditNoteId, documentNumber: cn.docNumber });
      }
    }
    tx.db.update(creditNotes).set({ status: 'reversed', reversalReason: reason }).where(eq(creditNotes.id, creditNoteId)).run();
    writeAudit(tx, { module: 'sales', action: 'sales_return_reverse', entity: 'credit_note', entityId: creditNoteId, reference: cn.docNumber, summary: `Credit note ${cn.docNumber} reversed`, reason });
  });
}

// ---------------------------------------------------------------------------
// C. Partial purchase returns
// ---------------------------------------------------------------------------

export interface PurchaseReturnInput {
  receiptId: string;
  date: string;
  qty: number; // NATURAL base units to return (validated <= received - already returned)
  reason?: string;
}

/** Milli base-units already returned to supplier for a receipt. */
function purchaseReturnedQty(ctx: Ctx, receiptId: string): number {
  const row = ctx.db
    .select({ qty: sql<number>`coalesce(sum(${purchaseReturns.qty}), 0)` })
    .from(purchaseReturns)
    .where(and(eq(purchaseReturns.tenantId, ctx.tenantId), eq(purchaseReturns.receiptId, receiptId), eq(purchaseReturns.status, 'posted')))
    .get();
  return row?.qty ?? 0;
}

export function createPurchaseReturn(ctx: Ctx, input: PurchaseReturnInput): { id: string; docNumber: string } {
  requirePermission(ctx, 'inventory', 'create');
  const receipt = getReceipt(ctx, input.receiptId);
  if (receipt.lifecycle !== 'posted') badRequest('receipt_status', 'Only a posted receipt can be returned');
  if (!(input.qty > 0)) badRequest('return_qty', 'Return quantity must be positive');
  const qtyMilli = Math.round(input.qty * 1000);
  const received = receipt.netQty; // milli base-units
  const prior = purchaseReturnedQty(ctx, input.receiptId);
  if (prior + qtyMilli > received) {
    badRequest('over_return', `Cannot return more than received (received ${received / 1000}, already returned ${prior / 1000})`);
  }
  return inTx(ctx, (tx) => {
    ensureSeq(tx, 'purchase_return', 'PRT-');
    const docNumber = nextDocNumber(tx, 'purchase_return');
    const id = newId();
    // stock goes OUT to the supplier from the received lot/warehouse
    postMovement(tx, {
      itemId: receipt.itemId,
      lotId: receipt.lotId ?? null,
      warehouseId: receipt.warehouseId,
      qty: -qtyMilli,
      movementType: 'purchase_return',
      documentKind: 'purchase_return',
      documentId: id,
      documentNumber: docNumber,
    });
    tx.db.insert(purchaseReturns).values({
      id, tenantId: tx.tenantId, docNumber, receiptId: input.receiptId, supplierId: receipt.supplierId, date: input.date,
      reason: input.reason ?? null, itemId: receipt.itemId, warehouseId: receipt.warehouseId, lotId: receipt.lotId ?? null,
      qty: qtyMilli, amountCents: 0, status: 'posted', createdBy: actorId(tx), createdAt: nowIso(),
    }).run();
    writeAudit(tx, {
      module: 'inventory', action: 'purchase_return', entity: 'purchase_return', entityId: id, reference: docNumber,
      summary: `Purchase return ${docNumber} — ${qtyMilli / 1000} returned to supplier from receipt ${receipt.docNumber}`,
    });
    return { id, docNumber };
  });
}

export function listCreditNotes(ctx: Ctx, filter: { invoiceId?: string } = {}) {
  const conds = [eq(creditNotes.tenantId, ctx.tenantId)];
  if (filter.invoiceId) conds.push(eq(creditNotes.invoiceId, filter.invoiceId));
  return ctx.db.select().from(creditNotes).where(and(...conds)).all();
}

export function listPurchaseReturns(ctx: Ctx, filter: { receiptId?: string } = {}) {
  const conds = [eq(purchaseReturns.tenantId, ctx.tenantId)];
  if (filter.receiptId) conds.push(eq(purchaseReturns.receiptId, filter.receiptId));
  return ctx.db.select().from(purchaseReturns).where(and(...conds)).all();
}
