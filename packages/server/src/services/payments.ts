import { and, desc, eq } from 'drizzle-orm';
import { paymentAllocations, payments } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { nextDocNumber } from './numbering.js';
import { getParty } from './parties.js';
import { getInvoice, invoicePaidCents } from './sales.js';

/**
 * One payment CAN be allocated across multiple invoices (founder decision).
 * The unallocated remainder stays visible on the payment until applied.
 */

export interface AllocationInput {
  invoiceId: string;
  amount: number; // ETB
}

export interface CreatePaymentInput {
  customerId: string;
  date: string;
  amount: number; // ETB
  method: string;
  referenceNumber?: string;
  notes?: string;
  allocations?: AllocationInput[];
}

function cents(v: number): number {
  return Math.round(v * 100);
}

export function createPayment(
  ctx: Ctx,
  input: CreatePaymentInput,
  opts: { post?: boolean } = {},
): { id: string; docNumber: string } {
  return inTx(ctx, (tx) => {
    const customer = getParty(tx, input.customerId);
    if (!(input.amount > 0)) badRequest('amount_invalid', 'Payment amount must be positive');
    if (!input.method?.trim()) badRequest('method_required', 'Payment method is required');

    const docNumber = nextDocNumber(tx, 'payment');
    const id = newId();
    tx.db
      .insert(payments)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        date: input.date,
        customerId: input.customerId,
        amountCents: cents(input.amount),
        method: input.method,
        referenceNumber: input.referenceNumber ?? null,
        receivedByUserId: actorId(tx),
        notes: input.notes ?? null,
        status: 'draft',
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'payments',
      action: 'payment_draft',
      entity: 'payment',
      entityId: id,
      reference: docNumber,
      summary: `Payment ${docNumber} drafted for ${customer.name}`,
    });
    if (opts.post) {
      postPayment(tx, id, input.allocations ?? []);
    } else if (input.allocations?.length) {
      badRequest('draft_allocations', 'Allocations are applied when the payment is posted');
    }
    return { id, docNumber };
  });
}

/** Posting makes the money real and applies the requested allocations. */
export function postPayment(ctx: Ctx, id: string, allocations: AllocationInput[]): void {
  inTx(ctx, (tx) => {
    const payment = getPayment(tx, id);
    if (payment.status !== 'draft') badRequest('not_draft', 'Payment is already posted or reversed');
    tx.db
      .update(payments)
      .set({ status: 'posted', postedAt: nowIso() })
      .where(eq(payments.id, id))
      .run();
    if (allocations.length) applyAllocations(tx, id, allocations);
    writeAudit(tx, {
      module: 'payments',
      action: 'payment_post',
      entity: 'payment',
      entityId: id,
      reference: payment.docNumber,
      summary: `Payment ${payment.docNumber} posted (${payment.amountCents / 100})`,
    });
  });
}

/** Apply (more) allocations to a posted payment — e.g. its unallocated remainder. */
export function applyAllocations(ctx: Ctx, paymentId: string, allocations: AllocationInput[]): void {
  inTx(ctx, (tx) => {
    const payment = getPayment(tx, paymentId);
    if (payment.status !== 'posted') badRequest('not_posted', 'Allocations require a posted payment');
    let allocated = allocatedCents(tx, paymentId);
    for (const a of allocations) {
      const amount = cents(a.amount);
      if (amount <= 0) badRequest('allocation_invalid', 'Allocation amount must be positive');
      const invoice = getInvoice(tx, a.invoiceId);
      if (invoice.customerId !== payment.customerId) {
        badRequest('customer_mismatch', 'Invoice belongs to a different customer');
      }
      if (invoice.status === 'cancelled' || invoice.status === 'pending') {
        badRequest('invoice_not_open', `Invoice ${invoice.docNumber} is not an open balance`);
      }
      const remaining = invoice.totalCents - invoicePaidCents(tx, a.invoiceId);
      if (amount > remaining) {
        badRequest(
          'over_allocation',
          `Allocation exceeds the open balance of ${invoice.docNumber} (${remaining / 100})`,
        );
      }
      if (allocated + amount > payment.amountCents) {
        badRequest('payment_exceeded', 'Allocations cannot exceed the payment amount');
      }
      allocated += amount;
      tx.db
        .insert(paymentAllocations)
        .values({
          id: newId(),
          tenantId: tx.tenantId,
          paymentId,
          invoiceId: a.invoiceId,
          amountCents: amount,
          status: 'active',
          createdAt: nowIso(),
        })
        .run();
      writeAudit(tx, {
        module: 'payments',
        action: 'payment_allocate',
        entity: 'payment',
        entityId: paymentId,
        reference: payment.docNumber,
        summary: `${amount / 100} of ${payment.docNumber} applied to ${invoice.docNumber}`,
      });
    }
  });
}

/** Reversal restores every allocated invoice balance through linked events. */
export function reversePayment(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('reason_required', 'A reversal reason is required');
  inTx(ctx, (tx) => {
    const payment = getPayment(tx, id);
    if (payment.status !== 'posted') badRequest('not_posted', 'Only posted payments can be reversed');
    tx.db
      .update(paymentAllocations)
      .set({ status: 'reversed' })
      .where(
        and(
          eq(paymentAllocations.tenantId, tx.tenantId),
          eq(paymentAllocations.paymentId, id),
          eq(paymentAllocations.status, 'active'),
        ),
      )
      .run();
    tx.db
      .update(payments)
      .set({ status: 'reversed', reversalReason: reason })
      .where(eq(payments.id, id))
      .run();
    writeAudit(tx, {
      module: 'payments',
      action: 'payment_reverse',
      entity: 'payment',
      entityId: id,
      reference: payment.docNumber,
      summary: `Payment ${payment.docNumber} reversed`,
      reason,
    });
  });
}

export function allocatedCents(ctx: Ctx, paymentId: string): number {
  const rows = ctx.db
    .select()
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.tenantId, ctx.tenantId),
        eq(paymentAllocations.paymentId, paymentId),
        eq(paymentAllocations.status, 'active'),
      ),
    )
    .all();
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

export function getPayment(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.tenantId, ctx.tenantId), eq(payments.id, id)))
    .get();
  if (!row) notFound('payment_missing', 'Payment not found');
  return row;
}

export function listPayments(ctx: Ctx, filter: { customerId?: string; limit?: number } = {}) {
  const conds = [eq(payments.tenantId, ctx.tenantId)];
  if (filter.customerId) conds.push(eq(payments.customerId, filter.customerId));
  const rows = ctx.db
    .select()
    .from(payments)
    .where(and(...conds))
    .orderBy(desc(payments.createdAt))
    .limit(Math.min(filter.limit ?? 200, 1000))
    .all();
  return rows.map((p) => ({ ...p, allocatedCents: allocatedCents(ctx, p.id) }));
}

export function listAllocationsForPayment(ctx: Ctx, paymentId: string) {
  return ctx.db
    .select()
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.tenantId, ctx.tenantId), eq(paymentAllocations.paymentId, paymentId)))
    .all();
}
