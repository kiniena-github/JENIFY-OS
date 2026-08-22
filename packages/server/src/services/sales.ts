import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { invoiceLines, lots, salesInvoices, paymentAllocations, payments } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { nextDocNumber } from './numbering.js';
import { getItem, getUom, getWarehouse, toBaseQty } from './masterdata.js';
import { getParty } from './parties.js';
import { getSettings } from './settings.js';
import { normalizePriceCategories } from '@factoryos/shared';
import {
  getAvailable,
  createReservation,
  listReservationsForDocument,
  releaseReservation,
} from './inventory.js';

export interface PricingSettings {
  categories: Array<string | { code: string; name: string; active: boolean }>;
  defaultCategory?: string;
  customPrice?: { enabled?: boolean; requiresApproval?: boolean };
  discount?: { requiresApproval?: boolean };
  prices: Record<string, Record<string, number | null>>;
}
export interface VatSettings {
  enabled: boolean;
  ratePct: number;
}

export interface InvoiceLineInput {
  itemId: string;
  warehouseId: string;
  qty: number; // natural units (packs / kg)
  entryUomId: string;
  unitPrice?: number; // ETB; omitted -> price list
  discount?: number; // ETB per line total
}

export interface CreateInvoiceInput {
  customerId: string;
  date: string;
  /** omitted -> customer's default category, then the tenant default */
  priceCategory?: string;
  paymentTerm: 'paid' | 'credit' | 'partial';
  dueDate?: string;
  fulfillment?: 'delivery' | 'pickup';
  notes?: string;
  lines: InvoiceLineInput[];
  /** set true when a custom price/discount was explicitly approved (route checks permission) */
  customApproved?: boolean;
}

/** Money helpers — everything in integer cents. */
function cents(v: number): number {
  return Math.round(v * 100);
}

export function createInvoice(
  ctx: Ctx,
  input: CreateInvoiceInput,
): { id: string; docNumber: string; totalCents: number } {
  return inTx(ctx, (tx) => {
    const customer = getParty(tx, input.customerId);
    if (customer.kind === 'supplier') badRequest('not_customer', 'Selected party is not a customer');
    if (!input.lines?.length) badRequest('no_lines', 'At least one line is required');

    const pricing = getSettings<PricingSettings>(tx, 'pricing');
    const vat = getSettings<VatSettings>(tx, 'vat');
    // Explicit category wins; otherwise the customer's default drives the
    // invoice, then the tenant-wide default category.
    const priceCategory =
      input.priceCategory ??
      customer.defaultPriceCategory ??
      (pricing ? (normalizePriceCategories(pricing.data).defaultCode ?? undefined) : undefined);
    if (!priceCategory) badRequest('bad_category', 'No price category given and no default configured');
    if (pricing) {
      const { categories } = normalizePriceCategories(pricing.data);
      const cat = categories.find((c) => c.code === priceCategory);
      if (!cat) badRequest('bad_category', `Unknown price category '${priceCategory}'`);
      if (!cat.active) badRequest('archived_category', `Price category '${cat.name}' is archived`);
    }

    let subtotal = 0;
    let discountTotal = 0;
    const preparedLines: Array<typeof invoiceLines.$inferInsert> = [];
    let hasCustomPrice = false;

    const id = newId();
    for (const line of input.lines) {
      const item = getItem(tx, line.itemId);
      if (!item.sellable) badRequest('not_sellable', `'${item.name}' is not sellable`);
      getWarehouse(tx, line.warehouseId);
      const uom = getUom(tx, line.entryUomId);
      const baseUom = getUom(tx, item.baseUomId);
      if (uom.family !== baseUom.family) {
        badRequest('line_uom', `Unit '${uom.code}' does not measure '${item.name}'`);
      }
      if (!(line.qty > 0)) badRequest('line_qty', 'Quantity must be positive');
      const baseQty = toBaseQty(tx, line.entryUomId, line.qty);

      const listPrice = pricing?.data.prices?.[line.itemId]?.[priceCategory] ?? null;
      let unitPriceCents: number;
      let priceSource: 'list' | 'custom';
      if (line.unitPrice != null) {
        unitPriceCents = cents(line.unitPrice);
        priceSource = listPrice != null && cents(listPrice) === unitPriceCents ? 'list' : 'custom';
      } else if (listPrice != null) {
        unitPriceCents = cents(listPrice);
        priceSource = 'list';
      } else {
        badRequest(
          'price_missing',
          `No ${priceCategory} price configured for '${item.name}' — enter an approved price`,
        );
      }
      if (priceSource === 'custom') hasCustomPrice = true;

      const lineDiscount = cents(line.discount ?? 0);
      if (lineDiscount < 0) badRequest('discount_invalid', 'Discount cannot be negative');
      // price is per natural unit (per pack / per kg of the entry uom's base)
      const lineSubtotal = Math.round((baseQty / baseUom.factorToBase) * unitPriceCents);
      if (lineDiscount > lineSubtotal) {
        badRequest('discount_invalid', 'Discount cannot exceed the line amount');
      }
      subtotal += lineSubtotal;
      discountTotal += lineDiscount;

      preparedLines.push({
        id: newId(),
        tenantId: tx.tenantId,
        invoiceId: id,
        itemId: line.itemId,
        lotId: null,
        warehouseId: line.warehouseId,
        qty: baseQty,
        entryUomId: line.entryUomId,
        unitPriceCents,
        priceSource,
        discountCents: lineDiscount,
        lineSubtotalCents: lineSubtotal - lineDiscount,
      });
    }

    if (hasCustomPrice || discountTotal > 0) {
      const needsApproval =
        (hasCustomPrice && (pricing?.data.customPrice?.requiresApproval ?? true)) ||
        (discountTotal > 0 && (pricing?.data.discount?.requiresApproval ?? true));
      if (needsApproval && !input.customApproved) {
        badRequest('approval_required', 'Custom price or discount requires authorized approval');
      }
    }

    const taxable = subtotal - discountTotal;
    const vatCents = vat?.data.enabled ? Math.round((taxable * vat.data.ratePct) / 100) : 0;
    const totalCents = taxable + vatCents;
    if (input.paymentTerm !== 'paid' && !input.dueDate) {
      badRequest('due_date_required', 'A credit due date is required when a balance will remain');
    }

    const docNumber = nextDocNumber(tx, 'invoice');
    tx.db
      .insert(salesInvoices)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        date: input.date,
        customerId: input.customerId,
        status: 'pending',
        paymentTerm: input.paymentTerm,
        priceCategory,
        customPriceApprovedBy: hasCustomPrice || discountTotal > 0 ? actorId(tx) : null,
        subtotalCents: subtotal,
        discountCents: discountTotal,
        vatCents,
        totalCents,
        dueDate: input.dueDate ?? null,
        fulfillment: input.fulfillment ?? 'delivery',
        salespersonId: actorId(tx),
        pricingVersion: pricing?.version ?? null,
        vatSnapshot: (vat ? { version: vat.version, ...vat.data } : null) as object,
        notes: input.notes ?? null,
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    for (const l of preparedLines) tx.db.insert(invoiceLines).values(l).run();

    writeAudit(tx, {
      module: 'sales',
      action: 'invoice_draft',
      entity: 'sales_invoice',
      entityId: id,
      reference: docNumber,
      summary: `Invoice ${docNumber} drafted for ${customer.name}`,
      after: { totalCents, lines: preparedLines.length },
    });
    return { id, docNumber, totalCents };
  });
}

/**
 * Confirmation is the commercial commitment: allocates stock lot-by-lot
 * (FIFO), reserves it, checks the customer's credit limit, and prepares
 * fulfilment. Prices freeze at confirmation.
 */
export function confirmInvoice(ctx: Ctx, id: string, opts: { creditOverride?: boolean } = {}): void {
  inTx(ctx, (tx) => {
    const invoice = getInvoice(tx, id);
    if (invoice.status !== 'pending') badRequest('not_pending', 'Invoice is already processed');
    const customer = getParty(tx, invoice.customerId);

    // credit limit check on the unpaid remainder
    if (invoice.paymentTerm !== 'paid' && customer.creditLimitCents != null && !opts.creditOverride) {
      const outstanding = customerOutstanding(tx, customer.id);
      if (outstanding + invoice.totalCents > customer.creditLimitCents) {
        badRequest(
          'credit_limit',
          `This sale would exceed ${customer.name}'s credit limit — authorized override required`,
        );
      }
    }

    const lines = listInvoiceLines(tx, id);
    for (const line of lines) {
      const item = getItem(tx, line.itemId);
      if (item.trackingMode === 'lot') {
        // FIFO allocation across lots in the selected warehouse
        let remaining = line.qty;
        const candidateLots = tx.db
          .select()
          .from(lots)
          .where(and(eq(lots.tenantId, tx.tenantId), eq(lots.itemId, line.itemId)))
          .orderBy(asc(lots.createdAt))
          .all();
        const allocations: Array<{ lotId: string; qty: number }> = [];
        for (const lot of candidateLots) {
          if (remaining <= 0) break;
          const avail = getAvailable(tx, line.itemId, line.warehouseId, lot.id);
          if (avail <= 0) continue;
          const take = Math.min(avail, remaining);
          allocations.push({ lotId: lot.id, qty: take });
          remaining -= take;
        }
        if (remaining > 0) {
          badRequest(
            'insufficient_available',
            `Not enough available stock of '${item.name}' in the selected warehouse`,
          );
        }
        // first allocation stays on this line; extra allocations become new
        // lines, and money splits proportionally with no rounding loss
        const [first, ...rest] = allocations;
        let subtotalLeft = line.lineSubtotalCents;
        let discountLeft = line.discountCents;
        for (const extra of rest) {
          const rx = createReservation(tx, {
            itemId: line.itemId,
            lotId: extra.lotId,
            warehouseId: line.warehouseId,
            qty: extra.qty,
            documentKind: 'sales_invoice',
            documentId: id,
          });
          const ratio = extra.qty / line.qty;
          const extraSubtotal = Math.round(line.lineSubtotalCents * ratio);
          const extraDiscount = Math.round(line.discountCents * ratio);
          subtotalLeft -= extraSubtotal;
          discountLeft -= extraDiscount;
          tx.db
            .insert(invoiceLines)
            .values({
              id: newId(),
              tenantId: tx.tenantId,
              invoiceId: id,
              itemId: line.itemId,
              lotId: extra.lotId,
              warehouseId: line.warehouseId,
              qty: extra.qty,
              entryUomId: line.entryUomId,
              unitPriceCents: line.unitPriceCents,
              priceSource: line.priceSource,
              discountCents: extraDiscount,
              lineSubtotalCents: extraSubtotal,
              reservationId: rx,
            })
            .run();
        }
        const r1 = createReservation(tx, {
          itemId: line.itemId,
          lotId: first.lotId,
          warehouseId: line.warehouseId,
          qty: first.qty,
          documentKind: 'sales_invoice',
          documentId: id,
        });
        tx.db
          .update(invoiceLines)
          .set({
            lotId: first.lotId,
            qty: first.qty,
            reservationId: r1,
            lineSubtotalCents: subtotalLeft,
            discountCents: discountLeft,
          })
          .where(eq(invoiceLines.id, line.id))
          .run();
      } else {
        const avail = getAvailable(tx, line.itemId, line.warehouseId);
        if (avail < line.qty) {
          badRequest('insufficient_available', `Not enough available stock of '${item.name}'`);
        }
        const r = createReservation(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          qty: line.qty,
          documentKind: 'sales_invoice',
          documentId: id,
        });
        tx.db.update(invoiceLines).set({ reservationId: r }).where(eq(invoiceLines.id, line.id)).run();
      }
    }

    tx.db
      .update(salesInvoices)
      .set({
        status: 'confirmed',
        confirmedBy: actorId(tx),
        confirmedAt: nowIso(),
        // presentation snapshot: reprints keep issuance-time branding
        brandingVersion: getSettings(tx, 'branding')?.version ?? null,
      })
      .where(eq(salesInvoices.id, id))
      .run();
    writeAudit(tx, {
      module: 'sales',
      action: 'invoice_confirm',
      entity: 'sales_invoice',
      entityId: id,
      reference: invoice.docNumber,
      summary: `Invoice ${invoice.docNumber} confirmed — stock reserved`,
    });
  });
}

/** Cancel before dispatch: releases every reservation, keeps full history. */
export function cancelInvoice(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('reason_required', 'A cancellation reason is required');
  inTx(ctx, (tx) => {
    const invoice = getInvoice(tx, id);
    if (invoice.status !== 'pending' && invoice.status !== 'confirmed') {
      badRequest('not_cancellable', 'Dispatched or completed invoices must be reversed, not cancelled');
    }
    const paid = invoicePaidCents(tx, id);
    if (paid > 0) {
      badRequest('has_payments', 'Reverse the applied payments before cancelling this invoice');
    }
    for (const r of listReservationsForDocument(tx, 'sales_invoice', id)) {
      if (r.status === 'active') releaseReservation(tx, r.id);
    }
    tx.db
      .update(salesInvoices)
      .set({ status: 'cancelled', cancelledReason: reason })
      .where(eq(salesInvoices.id, id))
      .run();
    writeAudit(tx, {
      module: 'sales',
      action: 'invoice_cancel',
      entity: 'sales_invoice',
      entityId: id,
      reference: invoice.docNumber,
      summary: `Invoice ${invoice.docNumber} cancelled`,
      reason,
    });
  });
}

// ----------------------------- Derived finance -----------------------------

/** Total actively-allocated, posted payment money on an invoice. */
export function invoicePaidCents(ctx: Ctx, invoiceId: string): number {
  const rows = ctx.db
    .select({ total: sql<number>`coalesce(sum(${paymentAllocations.amountCents}), 0)` })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(
      and(
        eq(paymentAllocations.tenantId, ctx.tenantId),
        eq(paymentAllocations.invoiceId, invoiceId),
        eq(paymentAllocations.status, 'active'),
        eq(payments.status, 'posted'),
      ),
    )
    .all();
  return rows[0]?.total ?? 0;
}

/**
 * Paid-cents for MANY invoices in ONE grouped query (perf: replaces the
 * per-invoice N+1 in reports/credit views). Returns a Map invoiceId → cents;
 * invoices with no posted allocations are absent (treat as 0).
 */
export function invoicesPaidCents(ctx: Ctx, invoiceIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (invoiceIds.length === 0) return out;
  const rows = ctx.db
    .select({
      invoiceId: paymentAllocations.invoiceId,
      total: sql<number>`coalesce(sum(${paymentAllocations.amountCents}), 0)`,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(
      and(
        eq(paymentAllocations.tenantId, ctx.tenantId),
        inArray(paymentAllocations.invoiceId, invoiceIds),
        eq(paymentAllocations.status, 'active'),
        eq(payments.status, 'posted'),
      ),
    )
    .groupBy(paymentAllocations.invoiceId)
    .all();
  for (const r of rows) out.set(r.invoiceId, r.total);
  return out;
}

export type CreditStatus = 'active' | 'partial' | 'paid' | 'overdue';

export function invoiceCreditStatus(
  invoice: { totalCents: number; dueDate: string | null; status: string },
  paidCents: number,
  today = nowIso().slice(0, 10),
): CreditStatus {
  const remaining = invoice.totalCents - paidCents;
  if (remaining <= 0) return 'paid';
  if (invoice.dueDate && invoice.dueDate < today) return 'overdue';
  if (paidCents > 0) return 'partial';
  return 'active';
}

/** Customer outstanding = Σ remaining balances of committed (non-cancelled) invoices. */
export function customerOutstanding(ctx: Ctx, customerId: string): number {
  const invoices = ctx.db
    .select()
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.tenantId, ctx.tenantId),
        eq(salesInvoices.customerId, customerId),
        inArray(salesInvoices.status, ['confirmed', 'dispatched', 'completed']),
      ),
    )
    .all();
  // perf: one grouped paid-cents query for all the customer's invoices, not N
  const paidByInvoice = invoicesPaidCents(ctx, invoices.map((i) => i.id));
  let outstanding = 0;
  for (const inv of invoices) {
    outstanding += Math.max(0, inv.totalCents - (paidByInvoice.get(inv.id) ?? 0));
  }
  return outstanding;
}

// ----------------------------- Queries -------------------------------------

export function getInvoice(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, ctx.tenantId), eq(salesInvoices.id, id)))
    .get();
  if (!row) notFound('invoice_missing', 'Invoice not found');
  return row;
}

export function listInvoiceLines(ctx: Ctx, invoiceId: string) {
  return ctx.db
    .select()
    .from(invoiceLines)
    .where(and(eq(invoiceLines.tenantId, ctx.tenantId), eq(invoiceLines.invoiceId, invoiceId)))
    .all();
}

export function listInvoices(
  ctx: Ctx,
  filter: { customerId?: string; status?: string; limit?: number } = {},
) {
  const conds = [eq(salesInvoices.tenantId, ctx.tenantId)];
  if (filter.customerId) conds.push(eq(salesInvoices.customerId, filter.customerId));
  if (filter.status) conds.push(eq(salesInvoices.status, filter.status));
  return ctx.db
    .select()
    .from(salesInvoices)
    .where(and(...conds))
    .orderBy(desc(salesInvoices.createdAt))
    .limit(Math.min(filter.limit ?? 200, 1000))
    .all();
}
