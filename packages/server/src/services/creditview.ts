import { and, desc, eq, inArray } from 'drizzle-orm';
import { parties, paymentAllocations, payments, salesInvoices } from '../db/schema.js';
import { nowIso } from '../util.js';
import type { Ctx } from './context.js';
import { invoicePaidCents, invoiceCreditStatus, type CreditStatus } from './sales.js';

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

/** Credit position of every committed invoice, derived from source records. */
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

  const today = nowIso().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  const rows: CreditRow[] = invoices.map(({ inv, customerName }) => {
    const paid = invoicePaidCents(ctx, inv.id);
    const lastPayment = ctx.db
      .select({ date: payments.date })
      .from(paymentAllocations)
      .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
      .where(
        and(
          eq(paymentAllocations.tenantId, ctx.tenantId),
          eq(paymentAllocations.invoiceId, inv.id),
          eq(paymentAllocations.status, 'active'),
          eq(payments.status, 'posted'),
        ),
      )
      .orderBy(desc(payments.date))
      .limit(1)
      .get();
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.docNumber,
      customerId: inv.customerId,
      customerName,
      saleDate: inv.date,
      dueDate: inv.dueDate,
      totalCents: inv.totalCents,
      paidCents: paid,
      remainingCents: Math.max(0, inv.totalCents - paid),
      lastPaymentDate: lastPayment?.date ?? null,
      status: invoiceCreditStatus(inv, paid, today),
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
