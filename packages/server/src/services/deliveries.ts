import { and, desc, eq } from 'drizzle-orm';
import { deliveries, invoiceLines, salesInvoices } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { nextDocNumber } from './numbering.js';
import { getInvoice, listInvoiceLines } from './sales.js';
import { postMovement, listReservationsForDocument, consumeReservation, reduceReservation } from './inventory.js';
import { getSettings } from './settings.js';

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
    // A first delivery needs a confirmed sale. A follow-up (split) delivery is
    // allowed while the invoice is 'dispatched' and stock is still undelivered.
    if (invoice.status === 'confirmed') {
      // ok — first delivery
    } else if (invoice.status === 'dispatched' && invoiceUndelivered(tx, input.invoiceId) > 0) {
      // ok — follow-up delivery for the remainder
    } else {
      badRequest('invoice_not_deliverable', 'A delivery needs a confirmed sale (or an undelivered remainder)');
    }
    // required at creation — destination and expected date always; vehicle and
    // driver details only for factory deliveries (deliberately not required
    // for customer pickup)
    const type = input.deliveryType ?? invoice.fulfillment;
    if (!input.destination?.trim()) badRequest('destination_required', 'Destination is required');
    if (!input.expectedDate) badRequest('expected_required', 'Expected delivery date is required');
    if (input.expectedDate < nowIso().slice(0, 10)) {
      badRequest('expected_past', 'Expected delivery date cannot be before today');
    }
    if (type === 'delivery') {
      if (!input.truckNumber?.trim()) badRequest('truck_required', 'Truck number is required');
      if (!input.driverName?.trim()) badRequest('driver_required', 'Driver name is required');
      if (!input.driverPhone?.trim()) badRequest('driver_phone_required', 'Driver phone is required');
    }
    // block a second delivery only while one is still IN PROGRESS (pending/
    // loading); a dispatched/delivered prior delivery may be followed by a new
    // one for the undelivered remainder (split delivery).
    const inProgress = tx.db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenantId, tx.tenantId),
          eq(deliveries.invoiceId, input.invoiceId),
        ),
      )
      .all()
      .filter((d) => d.status === 'pending' || d.status === 'loading');
    if (inProgress.length > 0) badRequest('delivery_exists', 'An in-progress delivery already exists for this invoice');

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
        brandingVersion: getSettings(tx, 'branding')?.version ?? null,
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
/**
 * Dispatch a delivery. Full by default (ships all reserved stock). Passing
 * `lineQtys` ships only those quantities (split delivery): the invoice line's
 * reservation is partially consumed, qtyDelivered advances, and the invoice
 * stays open for a follow-up delivery of the remainder. The invoice only
 * COMPLETES when every line is fully delivered (at markDelivered time).
 */
export function dispatchDelivery(
  ctx: Ctx,
  id: string,
  opts: { dispatchDate?: string; lineQtys?: Array<{ invoiceLineId: string; qty: number }> } = {},
): void {
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

    if (opts.lineQtys && opts.lineQtys.length > 0) {
      // ---- split (partial) dispatch ----
      const byId = new Map(lines.map((l) => [l.id, l]));
      let shippedAny = false;
      for (const { invoiceLineId, qty } of opts.lineQtys) {
        const line = byId.get(invoiceLineId);
        if (!line) badRequest('dispatch_line_unknown', `Invoice line ${invoiceLineId} not on this invoice`);
        const qtyMilli = Math.round(qty * 1000);
        const remaining = line!.qty - line!.qtyDelivered;
        if (qtyMilli <= 0) badRequest('dispatch_qty', 'Dispatch quantity must be positive');
        if (qtyMilli > remaining) badRequest('over_dispatch', `Cannot dispatch more than remaining (${remaining / 1000}) for this line`);
        postMovement(tx, {
          itemId: line!.itemId,
          lotId: line!.lotId,
          warehouseId: line!.warehouseId,
          qty: -qtyMilli,
          movementType: 'sale_dispatch',
          documentKind: 'delivery',
          documentId: id,
          documentNumber: d.docNumber,
        });
        if (line!.reservationId) reduceReservation(tx, line!.reservationId, qtyMilli);
        tx.db.update(invoiceLines).set({ qtyDelivered: line!.qtyDelivered + qtyMilli }).where(eq(invoiceLines.id, line!.id)).run();
        shippedAny = true;
      }
      if (!shippedAny) badRequest('nothing_dispatched', 'No quantities to dispatch');
    } else {
      // ---- full dispatch (ship all remaining reservations) ----
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
      // full dispatch marks every line fully delivered
      for (const line of lines) {
        tx.db.update(invoiceLines).set({ qtyDelivered: line.qty }).where(eq(invoiceLines.id, line.id)).run();
      }
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
      summary: `Delivery ${d.docNumber} dispatched${opts.lineQtys ? ' (partial)' : ''} — ${lines.length} line(s)`,
    });
  });
}

/** Milli base-units still undelivered across an invoice's lines. */
function invoiceUndelivered(ctx: Ctx, invoiceId: string): number {
  const lines = listInvoiceLines(ctx, invoiceId);
  return lines.reduce((s, l) => s + Math.max(0, l.qty - l.qtyDelivered), 0);
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
    if (input.actualDate > nowIso().slice(0, 10)) {
      badRequest('actual_future', 'Actual delivery date cannot be in the future');
    }
    if (d.dispatchDate && input.actualDate < d.dispatchDate) {
      badRequest('actual_before_dispatch', 'Actual delivery date cannot be before the dispatch date');
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
    // the invoice completes only when EVERY line is fully delivered — a partial
    // (split) delivery leaves it 'dispatched' with a remainder still open
    const stillOpen = invoiceUndelivered(tx, d.invoiceId);
    if (stillOpen <= 0) {
      tx.db
        .update(salesInvoices)
        .set({ status: 'completed' })
        .where(eq(salesInvoices.id, d.invoiceId))
        .run();
    }
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
