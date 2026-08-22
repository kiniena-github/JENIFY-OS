import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import { parties, paymentAllocations, payments, salesInvoices } from '../db/schema.js';
import { nowIso } from '../util.js';
import type { Ctx } from './context.js';
import { invoiceCreditStatus, type CreditStatus } from './sales.js';
import { creditNotedByInvoice } from './returns.js';

export interface CreditRow {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  saleDate: string;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  lastPaymentDate: string | null;
  status: CreditStatus;
}

/**
 * Credit position of every committed invoice, derived from source records.
 * Paid amounts and last-payment dates are computed in two grouped queries
 * (not per invoice) so the screen stays fast as history grows.
 */
export function creditOverview(ctx: Ctx, filter: { customerId?: string; status?: CreditStatus } = {}): {
  rows: CreditRow[];
  outstandingCents: number;
  overdueCents: number;
  dueThisWeekCents: number;
} {
  const conds = [
    eq(salesInvoices.tenantId, ctx.tenantId),
    inArray(salesInvoices.status, ['confirmed', 'dispatched', 'completed']),
  ];
  if (filter.customerId) conds.push(eq(salesInvoices.customerId, filter.customerId));
  const invoices = ctx.db
    .select({
      inv: salesInvoices,
      customerName: parties.name,
    })
    .from(salesInvoices)
    .innerJoin(parties, eq(salesInvoices.customerId, parties.id))
    .where(and(...conds))
    .orderBy(desc(salesInvoices.date))
    .all();

  // grouped: active allocation totals + latest payment date per invoice
  const paidRows = ctx.db
    .select({
      invoiceId: paymentAllocations.invoiceId,
      total: sql<number>`coalesce(sum(${paymentAllocations.amountCents}), 0)`,
      lastDate: sql<string | null>`max(${payments.date})`,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(
      and(
        eq(paymentAllocations.tenantId, ctx.tenantId),
        eq(paymentAllocations.status, 'active'),
        eq(payments.status, 'posted'),
      ),
    )
    .groupBy(paymentAllocations.invoiceId)
    .all();
  const paidByInvoice = new Map(paidRows.map((r) => [r.invoiceId, r]));
  // credit notes reduce the receivable: remaining = total - paid - creditNoted
  const creditNoted = creditNotedByInvoice(ctx, invoices.map((i) => i.inv.id));

  const today = nowIso().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  const rows: CreditRow[] = invoices.map(({ inv, customerName }) => {
    const paidInfo = paidByInvoice.get(inv.id);
    const paid = paidInfo?.total ?? 0;
    const credited = creditNoted.get(inv.id) ?? 0;
    const effectiveTotal = Math.max(0, inv.totalCents - credited);
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.docNumber,
      customerId: inv.customerId,
      customerName,
      saleDate: inv.date,
      dueDate: inv.dueDate,
      totalCents: effectiveTotal,
      paidCents: paid,
      remainingCents: Math.max(0, effectiveTotal - paid),
      lastPaymentDate: paidInfo?.lastDate ?? null,
      status: invoiceCreditStatus({ ...inv, totalCents: effectiveTotal }, paid, today),
    };
  });

  const filtered = filter.status ? rows.filter((r) => r.status === filter.status) : rows;
  return {
    rows: filtered,
    outstandingCents: rows.reduce((s, r) => s + r.remainingCents, 0),
    overdueCents: rows.filter((r) => r.status === 'overdue').reduce((s, r) => s + r.remainingCents, 0),
    dueThisWeekCents: rows
      .filter((r) => r.remainingCents > 0 && r.dueDate && r.dueDate >= today && r.dueDate <= weekAhead)
      .reduce((s, r) => s + r.remainingCents, 0),
  };
}
