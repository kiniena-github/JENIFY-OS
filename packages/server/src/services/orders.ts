import { and, desc, eq } from 'drizzle-orm';
import { documentSequences, salesInvoices, salesOrderLines, salesOrders } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import { clampLimit, requireDate, requireEnum, requireText } from '../validate.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { defineSequence, nextDocNumber } from './numbering.js';
import { getItem, getUom, toBaseQty } from './masterdata.js';
import { getParty } from './parties.js';
import { getSettings } from './settings.js';
import {
  allocateLotsFifo,
  createReservation,
  getAvailable,
  listReservationsForDocument,
  reduceReservation,
  releaseReservation,
} from './inventory.js';
import {
  confirmInvoice,
  createInvoice,
  priceCommercialLines,
  requirePricingApproval,
  resolvePriceCategory,
  type CommercialLineInput,
  type PricingSettings,
  type VatSettings,
} from './sales.js';

/**
 * Reusable Order Capability — increment 1 (issue #4, started via issue #80).
 *
 * A sales ORDER is the commercial intent BEFORE the invoice:
 *
 *   draft ──confirm──▶ confirmed ──invoice (1..n, partial ok)──▶
 *          partially_fulfilled ──▶ fulfilled          (└─cancel──▶ cancelled)
 *
 * Design decisions (recorded for review):
 * - REUSE, don't rebuild: pricing, VAT, approval gates, FIFO lot allocation,
 *   reservations, credit checks, numbering, audit and the invoice/delivery/
 *   payment/return chain are the EXISTING primitives. The order only adds the
 *   pre-invoice commitment and partial-fulfilment bookkeeping.
 * - Confirmation reserves stock lot-by-lot (FIFO) with the same allocator the
 *   invoice uses, so per-lot availability seen by every other consumer already
 *   excludes order commitments — reserved stock cannot be consumed by another
 *   operation (R4 stock/concurrency invariant).
 * - Invoicing an order happens ATOMICALLY: the covered order reservations are
 *   consumed and the created invoice is confirmed (re-reserving the stock
 *   under the invoice) inside ONE transaction, so no other operation can take
 *   the stock in between. Money on the invoice comes from the order's frozen
 *   unit prices; discounts are carried over with cumulative rounding so the
 *   sum over all partial invoices equals the order discount exactly.
 * - The credit limit is enforced where the receivable is born — at invoice
 *   confirmation (an order is not yet a receivable, so counting it against
 *   credit would double-count once invoiced).
 * - `channel` tags the sector experience (counter sale, POS, e-commerce, ...)
 *   for reporting/UX; it never forks the lifecycle.
 * - Statuses advance on INVOICING (the commercial hand-off); physical dispatch
 *   and payment remain facts of the linked invoice/delivery/payment documents.
 */

export interface CreateOrderInput {
  customerId: string;
  date: string;
  /** omitted -> customer's default category, then the tenant default */
  priceCategory?: string;
  fulfillment?: 'delivery' | 'pickup';
  /** sector adapter tag; free but validated text, default 'standard' */
  channel?: string;
  expectedDate?: string;
  notes?: string;
  lines: CommercialLineInput[];
  /** set true when a custom price/discount was explicitly approved (route checks permission) */
  customApproved?: boolean;
}

/** Idempotent per tenant: define the order sequence only when absent. */
function ensureOrderSequence(ctx: Ctx): void {
  const existing = ctx.db
    .select()
    .from(documentSequences)
    .where(and(eq(documentSequences.tenantId, ctx.tenantId), eq(documentSequences.seqKey, 'order')))
    .get();
  if (!existing) defineSequence(ctx, 'order', 'ORD-', 4);
}

export function createOrder(
  ctx: Ctx,
  input: CreateOrderInput,
): { id: string; docNumber: string; totalCents: number } {
  return inTx(ctx, (tx) => {
    const customer = getParty(tx, input.customerId);
    if (customer.kind === 'supplier') badRequest('not_customer', 'Selected party is not a customer');
    if (!input.lines?.length) badRequest('no_lines', 'At least one line is required');
    requireDate(input.date, 'Order date');
    if (input.expectedDate != null) requireDate(input.expectedDate, 'Expected date');
    if (input.notes != null && input.notes !== '') requireText(input.notes, 'Notes', 500);
    const channel =
      input.channel == null || input.channel === ''
        ? 'standard'
        : requireText(input.channel, 'Channel', 50);
    if (input.fulfillment != null && input.fulfillment !== 'delivery' && input.fulfillment !== 'pickup') {
      badRequest('bad_fulfillment', "Fulfillment must be 'delivery' or 'pickup'");
    }

    const pricing = getSettings<PricingSettings>(tx, 'pricing');
    const vat = getSettings<VatSettings>(tx, 'vat');
    const priceCategory = resolvePriceCategory(tx, customer, input.priceCategory, pricing);
    const { lines, subtotal, discountTotal, hasCustomPrice } = priceCommercialLines(
      tx,
      input.lines,
      priceCategory,
      pricing,
    );
    requirePricingApproval(pricing, hasCustomPrice, discountTotal, input.customApproved);

    const taxable = subtotal - discountTotal;
    const vatCents = vat?.data.enabled ? Math.round((taxable * vat.data.ratePct) / 100) : 0;
    const totalCents = taxable + vatCents;

    ensureOrderSequence(tx);
    const id = newId();
    const docNumber = nextDocNumber(tx, 'order');
    tx.db
      .insert(salesOrders)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        date: input.date,
        customerId: input.customerId,
        status: 'draft',
        channel,
        priceCategory,
        customPriceApprovedBy: hasCustomPrice || discountTotal > 0 ? actorId(tx) : null,
        subtotalCents: subtotal,
        discountCents: discountTotal,
        vatCents,
        totalCents,
        fulfillment: input.fulfillment ?? 'delivery',
        expectedDate: input.expectedDate ?? null,
        pricingVersion: pricing?.version ?? null,
        vatSnapshot: (vat ? { version: vat.version, ...vat.data } : null) as object,
        notes: input.notes ?? null,
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    for (const l of lines) {
      tx.db
        .insert(salesOrderLines)
        .values({
          id: newId(),
          tenantId: tx.tenantId,
          orderId: id,
          itemId: l.itemId,
          warehouseId: l.warehouseId,
          qty: l.qty,
          entryUomId: l.entryUomId,
          unitPriceCents: l.unitPriceCents,
          priceSource: l.priceSource,
          discountCents: l.discountCents,
          lineSubtotalCents: l.lineSubtotalCents,
        })
        .run();
    }

    writeAudit(tx, {
      module: 'sales',
      action: 'order_draft',
      entity: 'sales_order',
      entityId: id,
      reference: docNumber,
      summary: `Order ${docNumber} drafted for ${customer.name}`,
      after: { totalCents, lines: lines.length, channel },
    });
    return { id, docNumber, totalCents };
  });
}

/**
 * Confirmation is the stock commitment: every line's quantity is reserved
 * (lot-tracked items lot-by-lot FIFO, others at warehouse level) so no other
 * document can consume it. Prices were already frozen at draft time.
 */
export function confirmOrder(ctx: Ctx, id: string): void {
  inTx(ctx, (tx) => {
    const order = getOrder(tx, id);
    if (order.status !== 'draft') badRequest('not_draft', 'Order is already processed');
    const lines = listOrderLines(tx, id);
    for (const line of lines) {
      const item = getItem(tx, line.itemId);
      if (item.trackingMode === 'lot') {
        const allocations = allocateLotsFifo(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          qty: line.qty,
          itemName: item.name,
        });
        for (const a of allocations) {
          createReservation(tx, {
            itemId: line.itemId,
            lotId: a.lotId,
            warehouseId: line.warehouseId,
            qty: a.qty,
            documentKind: 'sales_order',
            documentId: id,
          });
        }
      } else {
        const avail = getAvailable(tx, line.itemId, line.warehouseId);
        if (avail < line.qty) {
          badRequest('insufficient_available', `Not enough available stock of '${item.name}'`);
        }
        createReservation(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          qty: line.qty,
          documentKind: 'sales_order',
          documentId: id,
        });
      }
    }
    tx.db
      .update(salesOrders)
      .set({ status: 'confirmed', confirmedBy: actorId(tx), confirmedAt: nowIso() })
      .where(eq(salesOrders.id, id))
      .run();
    writeAudit(tx, {
      module: 'sales',
      action: 'order_confirm',
      entity: 'sales_order',
      entityId: id,
      reference: order.docNumber,
      summary: `Order ${order.docNumber} confirmed — stock reserved`,
    });
  });
}

export interface OrderInvoiceLineInput {
  orderLineId: string;
  /** natural units to invoice now; omitted -> the line's full remaining qty */
  qty?: number;
}

export interface InvoiceOrderInput {
  /** invoice date; defaults to today */
  date?: string;
  paymentTerm: 'paid' | 'credit' | 'partial';
  dueDate?: string;
  notes?: string;
  /** omitted -> every line's full remaining quantity */
  lines?: OrderInvoiceLineInput[];
  creditOverride?: boolean;
}

/**
 * Carry (part of) a confirmed order to a CONFIRMED invoice atomically:
 * consume the covered order reservations, create the invoice at the order's
 * frozen prices and confirm it (which re-reserves the same stock under the
 * invoice), then advance the order's fulfilment bookkeeping. Runs in ONE
 * transaction so the stock can never escape between the two documents.
 */
export function createInvoiceFromOrder(
  ctx: Ctx,
  orderId: string,
  input: InvoiceOrderInput,
): { invoiceId: string; docNumber: string; totalCents: number } {
  return inTx(ctx, (tx) => {
    const order = getOrder(tx, orderId);
    if (order.status !== 'confirmed' && order.status !== 'partially_fulfilled') {
      badRequest('not_invoiceable', 'Only a confirmed order can be invoiced');
    }
    requireEnum(input.paymentTerm, 'Payment term', ['paid', 'credit', 'partial'] as const);
    const date = input.date != null ? requireDate(input.date, 'Invoice date') : nowIso().slice(0, 10);
    if (input.notes != null && input.notes !== '') requireText(input.notes, 'Notes', 500);

    const allLines = listOrderLines(tx, orderId);
    const byId = new Map(allLines.map((l) => [l.id, l]));

    // Aggregate the request per order line (default: everything remaining).
    const requested = new Map<string, number | undefined>();
    if (input.lines != null) {
      if (!input.lines.length) badRequest('no_lines', 'At least one line is required');
      for (const sel of input.lines) {
        if (!byId.has(sel.orderLineId)) notFound('order_line_missing', 'Order line not found');
        if (requested.has(sel.orderLineId)) badRequest('duplicate_line', 'Order line selected twice');
        requested.set(sel.orderLineId, sel.qty);
      }
    } else {
      for (const l of allLines) if (l.qty - l.qtyInvoiced > 0) requested.set(l.id, undefined);
    }
    if (requested.size === 0) badRequest('nothing_remaining', 'The order is already fully invoiced');

    const invoiceLinesInput: CommercialLineInput[] = [];
    const conversions: Array<{ line: (typeof allLines)[number]; convertMilli: number }> = [];
    for (const [orderLineId, naturalReq] of requested) {
      const line = byId.get(orderLineId)!;
      const remainingMilli = line.qty - line.qtyInvoiced;
      if (remainingMilli <= 0) badRequest('over_invoice', 'Order line is already fully invoiced');
      const uom = getUom(tx, line.entryUomId);
      let natural: number;
      let convertMilli: number;
      if (naturalReq != null) {
        // the same single natural-quantity funnel every document uses (R4)
        convertMilli = toBaseQty(tx, line.entryUomId, naturalReq);
        if (convertMilli <= 0) badRequest('line_qty', 'Quantity must be positive');
        if (convertMilli > remainingMilli) {
          badRequest(
            'over_invoice',
            `Cannot invoice more than remains on the order line (remaining ${remainingMilli / 1000})`,
          );
        }
        natural = naturalReq;
      } else {
        natural = remainingMilli / uom.factorToBase;
        convertMilli = remainingMilli;
      }
      // Discount carry-over with cumulative rounding: Σ over all partial
      // invoices equals the order line's discount exactly — no penny drift.
      const prevAlloc = Math.round((line.discountCents * line.qtyInvoiced) / line.qty);
      const nextAlloc = Math.round((line.discountCents * (line.qtyInvoiced + convertMilli)) / line.qty);
      const discountSliceCents = nextAlloc - prevAlloc;

      invoiceLinesInput.push({
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        qty: natural,
        entryUomId: line.entryUomId,
        unitPrice: line.unitPriceCents / 100, // frozen order price
        discount: discountSliceCents / 100,
      });
      conversions.push({ line, convertMilli });
    }

    // Consume the covered order reservations (oldest first, per item+warehouse
    // pool). The invoice confirmation below re-reserves inside this same
    // transaction, so availability can never leak to another consumer.
    const active = listReservationsForDocument(tx, 'sales_order', orderId)
      .filter((r) => r.status === 'active')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const needByPool = new Map<string, number>();
    for (const c of conversions) {
      const key = `${c.line.itemId}|${c.line.warehouseId}`;
      needByPool.set(key, (needByPool.get(key) ?? 0) + c.convertMilli);
    }
    for (const [key, needTotal] of needByPool) {
      const [itemId, warehouseId] = key.split('|');
      let need = needTotal;
      for (const r of active) {
        if (need <= 0) break;
        if (r.itemId !== itemId || r.warehouseId !== warehouseId) continue;
        const take = Math.min(r.qty, need);
        reduceReservation(tx, r.id, take);
        r.qty -= take;
        need -= take;
      }
      if (need > 0) {
        // should be impossible: reservations always cover un-invoiced qty
        badRequest('order_state', 'Order reservations do not cover the requested quantity');
      }
    }

    const inv = createInvoice(tx, {
      customerId: order.customerId,
      date,
      priceCategory: order.priceCategory,
      paymentTerm: input.paymentTerm,
      dueDate: input.dueDate,
      fulfillment: order.fulfillment as 'delivery' | 'pickup',
      notes: input.notes,
      lines: invoiceLinesInput,
      customApproved: true, // pricing was approved when the order was taken
    });
    confirmInvoice(tx, inv.id, { creditOverride: input.creditOverride });
    tx.db.update(salesInvoices).set({ orderId }).where(eq(salesInvoices.id, inv.id)).run();

    for (const c of conversions) {
      tx.db
        .update(salesOrderLines)
        .set({ qtyInvoiced: c.line.qtyInvoiced + c.convertMilli })
        .where(eq(salesOrderLines.id, c.line.id))
        .run();
    }
    const after = listOrderLines(tx, orderId);
    const fulfilled = after.every((l) => l.qtyInvoiced >= l.qty);
    tx.db
      .update(salesOrders)
      .set({ status: fulfilled ? 'fulfilled' : 'partially_fulfilled' })
      .where(eq(salesOrders.id, orderId))
      .run();

    writeAudit(tx, {
      module: 'sales',
      action: 'order_invoice',
      entity: 'sales_order',
      entityId: orderId,
      reference: order.docNumber,
      summary: `Order ${order.docNumber} invoiced as ${inv.docNumber}${fulfilled ? ' — fulfilled' : ' (partial)'}`,
      after: { invoiceId: inv.id, totalCents: inv.totalCents, fulfilled },
    });
    return { invoiceId: inv.id, docNumber: inv.docNumber, totalCents: inv.totalCents };
  });
}

/**
 * Cancel the order's remaining commitment: every active reservation is
 * released and the order closes as 'cancelled'. Invoices already created from
 * it are immutable business facts — they stand (handle them with the normal
 * return/credit-note flow), and the audit trail records both sides.
 */
export function cancelOrder(ctx: Ctx, id: string, reason: string): void {
  inTx(ctx, (tx) => {
    requireText(reason, 'Cancellation reason', 500);
    const order = getOrder(tx, id);
    if (order.status === 'cancelled' || order.status === 'fulfilled') {
      badRequest('not_cancellable', 'A fulfilled or cancelled order cannot be cancelled');
    }
    for (const r of listReservationsForDocument(tx, 'sales_order', id)) {
      if (r.status === 'active') releaseReservation(tx, r.id);
    }
    tx.db
      .update(salesOrders)
      .set({ status: 'cancelled', cancelledReason: reason })
      .where(eq(salesOrders.id, id))
      .run();
    writeAudit(tx, {
      module: 'sales',
      action: 'order_cancel',
      entity: 'sales_order',
      entityId: id,
      reference: order.docNumber,
      summary: `Order ${order.docNumber} cancelled`,
      reason,
    });
  });
}

// ----------------------------- Queries -------------------------------------

export function getOrder(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.tenantId, ctx.tenantId), eq(salesOrders.id, id)))
    .get();
  if (!row) notFound('order_missing', 'Order not found');
  return row;
}

export function listOrderLines(ctx: Ctx, orderId: string) {
  return ctx.db
    .select()
    .from(salesOrderLines)
    .where(and(eq(salesOrderLines.tenantId, ctx.tenantId), eq(salesOrderLines.orderId, orderId)))
    .all();
}

export function listOrders(
  ctx: Ctx,
  filter: { customerId?: string; status?: string; channel?: string; limit?: number } = {},
) {
  const conds = [eq(salesOrders.tenantId, ctx.tenantId)];
  if (filter.customerId) conds.push(eq(salesOrders.customerId, filter.customerId));
  if (filter.status) conds.push(eq(salesOrders.status, filter.status));
  if (filter.channel) conds.push(eq(salesOrders.channel, filter.channel));
  return ctx.db
    .select()
    .from(salesOrders)
    .where(and(...conds))
    .orderBy(desc(salesOrders.createdAt))
    .limit(clampLimit(filter.limit, 200, 1000))
    .all();
}

/** The invoices that fulfil an order (reporting hook / INVOICED-PAID view). */
export function listInvoicesForOrder(ctx: Ctx, orderId: string) {
  return ctx.db
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.orderId, orderId)))
    .orderBy(desc(salesInvoices.createdAt))
    .all();
}
