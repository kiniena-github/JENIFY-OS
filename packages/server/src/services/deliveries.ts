import { and, desc, eq } from 'drizzle-orm';
import { deliveries, salesInvoices } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { nextDocNumber } from './numbering.js';
import { getInvoice, listInvoiceLines } from './sales.js';
import { postMovement, listReservationsForDocument, consumeReservation } from './inventory.js';

export interface CreateDeliveryInput {
  invoiceId: string;
  deliveryType?: 'delivery' | 'pickup';
  destination?: string;
  truckNumber?: string;
  driverName?: string;
  driverPhone?: string;
  expectedDate?: string;
  notes?: string;
}

export function createDelivery(ctx: Ctx, input: CreateDeliveryInput): { id: string; docNumber: string } {
  return inTx(ctx, (tx) => {
    const invoice = getInvoice(tx, input.invoiceId);
    if (invoice.status !== 'confirmed') {
      badRequest('invoice_not_confirmed', 'A delivery needs a confirmed sale');
    }
    const open = tx.db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenantId, tx.tenantId),
          eq(deliveries.invoiceId, input.invoiceId),
        ),
      )
      .all()
      .filter((d) => d.status !== 'cancelled');
    if (open.length > 0) badRequest('delivery_exists', 'An open delivery already exists for this invoice');

    const docNumber = nextDocNumber(tx, 'delivery');
    const id = newId();
    tx.db
      .insert(deliveries)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        invoiceId: input.invoiceId,
        customerId: invoice.customerId,
        status: 'pending',
        deliveryType: input.deliveryType ?? invoice.fulfillment,
        destination: input.destination ?? null,
        truckNumber: input.truckNumber ?? null,
        driverName: input.driverName ?? null,
        driverPhone: input.driverPhone ?? null,
        expectedDate: input.expectedDate ?? null,
        notes: input.notes ?? null,
        recordedBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'delivery',
      action: 'delivery_create',
      entity: 'delivery',
      entityId: id,
      reference: docNumber,
      summary: `Delivery ${docNumber} created for invoice ${invoice.docNumber}`,
    });
    return { id, docNumber };
  });
}

export function updateDeliveryDetails(
  ctx: Ctx,
  id: string,
  patch: {
    destination?: string;
    truckNumber?: string;
    driverName?: string;
    driverPhone?: string;
    expectedDate?: string;
    notes?: string;
  },
): void {
  const d = getDelivery(ctx, id);
  if (d.status === 'delivered' || d.status === 'cancelled') {
    badRequest('delivery_closed', 'This delivery is closed');
  }
  ctx.db
    .update(deliveries)
    .set({
      destination: patch.destination ?? d.destination,
      truckNumber: patch.truckNumber ?? d.truckNumber,
      driverName: patch.driverName ?? d.driverName,
      driverPhone: patch.driverPhone ?? d.driverPhone,
      expectedDate: patch.expectedDate ?? d.expectedDate,
      notes: patch.notes ?? d.notes,
    })
    .where(eq(deliveries.id, id))
    .run();
}

export function markLoading(ctx: Ctx, id: string): void {
  const d = getDelivery(ctx, id);
  if (d.status !== 'pending') badRequest('bad_transition', 'Only pending deliveries can start loading');
  ctx.db.update(deliveries).set({ status: 'loading' }).where(eq(deliveries.id, id)).run();
  writeAudit(ctx, {
    module: 'delivery',
    action: 'delivery_loading',
    entity: 'delivery',
    entityId: id,
    reference: d.docNumber,
    summary: `Delivery ${d.docNumber} loading started`,
  });
}

/**
 * Dispatch is the stock event: reserved quantities leave the warehouse,
 * reservations convert to sold, and the invoice becomes Dispatched.
 */
export function dispatchDelivery(ctx: Ctx, id: string, opts: { dispatchDate?: string } = {}): void {
  inTx(ctx, (tx) => {
    const d = getDelivery(tx, id);
    if (d.status !== 'pending' && d.status !== 'loading') {
      badRequest('bad_transition', 'Only pending/loading deliveries can dispatch');
    }
    if (d.deliveryType === 'delivery' && (!d.truckNumber || !d.driverName || !d.destination)) {
      badRequest('delivery_details', 'Truck, driver and destination are required before dispatch');
    }
    const invoice = getInvoice(tx, d.invoiceId);
    const lines = listInvoiceLines(tx, d.invoiceId);
    const reservations = listReservationsForDocument(tx, 'sales_invoice', d.invoiceId).filter(
      (r) => r.status === 'active',
    );
    if (reservations.length === 0) badRequest('no_reservations', 'No reserved stock for this invoice');
    for (const r of reservations) {
      postMovement(tx, {
        itemId: r.itemId,
        lotId: r.lotId,
        warehouseId: r.warehouseId,
        qty: -r.qty,
        movementType: 'sale_dispatch',
        documentKind: 'delivery',
        documentId: id,
        documentNumber: d.docNumber,
      });
      consumeReservation(tx, r.id);
    }
    tx.db
      .update(deliveries)
      .set({ status: 'dispatched', dispatchDate: opts.dispatchDate ?? nowIso().slice(0, 10) })
      .where(eq(deliveries.id, id))
      .run();
    tx.db.update(salesInvoices).set({ status: 'dispatched' }).where(eq(salesInvoices.id, invoice.id)).run();
    writeAudit(tx, {
      module: 'delivery',
      action: 'delivery_dispatch',
      entity: 'delivery',
      entityId: id,
      reference: d.docNumber,
      summary: `Delivery ${d.docNumber} dispatched — ${lines.length} line(s) left stock`,
    });
  });
}

export function markDelivered(
  ctx: Ctx,
  id: string,
  input: { actualDate: string; receivedBy: string; proofAttachmentId?: string; notes?: string },
): void {
  inTx(ctx, (tx) => {
    const d = getDelivery(tx, id);
    if (d.status !== 'dispatched') badRequest('bad_transition', 'Only dispatched deliveries can complete');
    if (!input.actualDate || !input.receivedBy?.trim()) {
      badRequest('delivered_details', 'Actual date and receiver are required');
    }
    tx.db
      .update(deliveries)
      .set({
        status: 'delivered',
        actualDate: input.actualDate,
        receivedBy: input.receivedBy,
        proofAttachmentId: input.proofAttachmentId ?? null,
        notes: input.notes ?? d.notes,
      })
      .where(eq(deliveries.id, id))
      .run();
    tx.db
      .update(salesInvoices)
      .set({ status: 'completed' })
      .where(eq(salesInvoices.id, d.invoiceId))
      .run();
    writeAudit(tx, {
      module: 'delivery',
      action: 'delivery_delivered',
      entity: 'delivery',
      entityId: id,
      reference: d.docNumber,
      summary: `Delivery ${d.docNumber} delivered to ${input.receivedBy}`,
    });
  });
}

export function cancelDelivery(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('reason_required', 'A cancellation reason is required');
  const d = getDelivery(ctx, id);
  if (d.status === 'dispatched' || d.status === 'delivered') {
    badRequest('bad_transition', 'Dispatched deliveries cannot be cancelled');
  }
  ctx.db
    .update(deliveries)
    .set({ status: 'cancelled', cancelledReason: reason })
    .where(eq(deliveries.id, id))
    .run();
  writeAudit(ctx, {
    module: 'delivery',
    action: 'delivery_cancel',
    entity: 'delivery',
    entityId: id,
    reference: d.docNumber,
    summary: `Delivery ${d.docNumber} cancelled`,
    reason,
  });
}

export function getDelivery(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.tenantId, ctx.tenantId), eq(deliveries.id, id)))
    .get();
  if (!row) notFound('delivery_missing', 'Delivery not found');
  return row;
}

export function listDeliveries(ctx: Ctx, filter: { status?: string; limit?: number } = {}) {
  const conds = [eq(deliveries.tenantId, ctx.tenantId)];
  if (filter.status) conds.push(eq(deliveries.status, filter.status));
  return ctx.db
    .select()
    .from(deliveries)
    .where(and(...conds))
    .orderBy(desc(deliveries.createdAt))
    .limit(Math.min(filter.limit ?? 200, 1000))
    .all();
}
