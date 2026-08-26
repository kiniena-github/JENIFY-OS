import { and, asc, eq, inArray, lt, gt, ne } from 'drizzle-orm';
import { bookableResources, bookings } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { requirePermission } from './permissions.js';
import { nextDocNumber, defineSequence } from './numbering.js';
import { getParty } from './parties.js';
import { requireInstant, requireSpan, requireQty } from '../validate.js';

/** Shared alias: bookings canonicalise instants exactly like every other module. */
const normalizeInstant = requireInstant;

/**
 * Bookings — ONE reserved-time-or-space capability serving hotel rooms,
 * restaurant tables, clinic appointments and class sessions.
 *
 * The load-bearing rule, identical in every sector: a resource can never be
 * double-booked for overlapping time. Intervals are half-open [startAt, endAt)
 * so a 10:00-11:00 booking and an 11:00-12:00 booking do NOT collide, which is
 * exactly how back-to-back appointments and same-day room turnover behave.
 * Cancelled and no-show bookings free their slot.
 */

export type BookingStatus = 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show';



/** Statuses that still occupy the resource. */
const BLOCKING: BookingStatus[] = ['confirmed', 'checked_in'];

const ALLOWED: Record<BookingStatus, BookingStatus[]> = {
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function createResource(
  ctx: Ctx,
  input: { code: string; name: string; kind?: string; capacity?: number },
): string {
  requirePermission(ctx, 'settings', 'edit');
  if (!input.code?.trim() || !input.name?.trim()) badRequest('resource_invalid', 'Code and name are required');
  const id = newId();
  ctx.db
    .insert(bookableResources)
    .values({
      id,
      tenantId: ctx.tenantId,
      code: input.code.trim(),
      name: input.name.trim(),
      kind: input.kind ?? 'resource',
      capacity: input.capacity ?? 1,
      active: true,
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'resource_create',
    entity: 'bookable_resource',
    entityId: id,
    reference: input.code,
    summary: `Bookable resource '${input.name}' created`,
  });
  return id;
}

export function listResources(ctx: Ctx, opts: { includeInactive?: boolean } = {}) {
  const conds = [eq(bookableResources.tenantId, ctx.tenantId)];
  if (!opts.includeInactive) conds.push(eq(bookableResources.active, true));
  return ctx.db.select().from(bookableResources).where(and(...conds)).all();
}

function getResource(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(bookableResources)
    .where(and(eq(bookableResources.tenantId, ctx.tenantId), eq(bookableResources.id, id)))
    .get();
  if (!row) notFound('resource_missing', 'Bookable resource not found');
  return row!;
}

export function getBooking(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, ctx.tenantId), eq(bookings.id, id)))
    .get();
  if (!row) notFound('booking_missing', 'Booking not found');
  return row!;
}

/**
 * Bookings that block a resource over [startAt, endAt). Half-open overlap test:
 * existing.startAt < newEnd AND existing.endAt > newStart.
 */
export function conflictingBookings(
  ctx: Ctx,
  resourceId: string,
  startAt: string,
  endAt: string,
  excludeBookingId?: string,
) {
  // normalise the probe window too — a caller-supplied offset format would
  // otherwise compare lexicographically against canonical stored values
  const start = normalizeInstant(startAt, 'startAt');
  const end = normalizeInstant(endAt, 'endAt');
  const conds = [
    eq(bookings.tenantId, ctx.tenantId),
    eq(bookings.resourceId, resourceId),
    inArray(bookings.status, BLOCKING),
    lt(bookings.startAt, end),
    gt(bookings.endAt, start),
  ];
  if (excludeBookingId) conds.push(ne(bookings.id, excludeBookingId));
  return ctx.db.select().from(bookings).where(and(...conds)).all();
}

export interface CreateBookingInput {
  resourceId: string;
  startAt: string; // ISO instant
  endAt: string;
  customerId?: string;
  partySize?: number;
  notes?: string;
}

export function createBooking(ctx: Ctx, input: CreateBookingInput): { id: string; docNumber: string } {
  requirePermission(ctx, 'sales', 'create');
  const resource = getResource(ctx, input.resourceId);
  if (!resource.active) badRequest('resource_inactive', 'That resource is not bookable');
  const { start: startAt, end: endAt } = requireSpan(input.startAt, input.endAt, { start: 'startAt', end: 'endAt' });
  if (input.customerId) getParty(ctx, input.customerId); // tenant-scoped
  const partySize = input.partySize ?? 1;
  requireQty(partySize, 'Party size', { integerOnly: true, max: 100000 });
  if (partySize > resource.capacity) {
    badRequest('over_capacity', `'${resource.name}' holds ${resource.capacity}, not ${partySize}`);
  }

  return inTx(ctx, (tx) => {
    // re-check inside the transaction so two concurrent bookings cannot both pass
    const clash = conflictingBookings(tx, input.resourceId, startAt, endAt);
    if (clash.length > 0) {
      badRequest('double_booked', `'${resource.name}' is already booked for that time`);
    }
    defineSequence(tx, 'booking', 'BKG-', 4);
    const docNumber = nextDocNumber(tx, 'booking');
    const id = newId();
    tx.db
      .insert(bookings)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        resourceId: input.resourceId,
        customerId: input.customerId ?? null,
        // store the CANONICAL UTC form, never the caller's format
        startAt,
        endAt,
        partySize,
        status: 'confirmed',
        notes: input.notes ?? null,
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'sales',
      action: 'booking_create',
      entity: 'booking',
      entityId: id,
      reference: docNumber,
      summary: `Booking ${docNumber} for '${resource.name}' ${startAt} → ${endAt}`,
    });
    return { id, docNumber };
  });
}

function transition(ctx: Ctx, id: string, to: BookingStatus, patch: Record<string, unknown>, reason?: string): void {
  requirePermission(ctx, 'sales', 'edit');
  const b = getBooking(ctx, id);
  const from = b.status as BookingStatus;
  if (!ALLOWED[from]?.includes(to)) {
    badRequest('booking_transition', `A booking cannot go from ${from} to ${to}`);
  }
  inTx(ctx, (tx) => {
    tx.db.update(bookings).set({ status: to, ...patch }).where(eq(bookings.id, id)).run();
    writeAudit(tx, {
      module: 'sales',
      action: `booking_${to}`,
      entity: 'booking',
      entityId: id,
      reference: b.docNumber,
      summary: `Booking ${b.docNumber} → ${to}`,
      before: { status: from },
      after: { status: to },
      reason,
    });
  });
}

export function checkInBooking(ctx: Ctx, id: string): void {
  transition(ctx, id, 'checked_in', {});
}
export function completeBooking(ctx: Ctx, id: string): void {
  transition(ctx, id, 'completed', {});
}
export function markNoShow(ctx: Ctx, id: string): void {
  transition(ctx, id, 'no_show', {});
}
export function cancelBooking(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('booking_reason', 'A cancellation reason is required');
  transition(ctx, id, 'cancelled', { cancelledReason: reason }, reason);
}

/** Move a booking — re-validates the double-booking rule for the new slot. */
export function rescheduleBooking(ctx: Ctx, id: string, startAt: string, endAt: string): void {
  requirePermission(ctx, 'sales', 'edit');
  const b = getBooking(ctx, id);
  if (b.status !== 'confirmed') badRequest('booking_not_open', 'Only a confirmed booking can be moved');
  const { start: from, end: to } = requireSpan(startAt, endAt, { start: 'startAt', end: 'endAt' });
  inTx(ctx, (tx) => {
    const clash = conflictingBookings(tx, b.resourceId, from, to, id);
    if (clash.length > 0) badRequest('double_booked', 'That resource is already booked for the new time');
    tx.db.update(bookings).set({ startAt: from, endAt: to }).where(eq(bookings.id, id)).run();
    writeAudit(tx, {
      module: 'sales',
      action: 'booking_reschedule',
      entity: 'booking',
      entityId: id,
      reference: b.docNumber,
      summary: `Booking ${b.docNumber} moved`,
      before: { startAt: b.startAt, endAt: b.endAt },
      after: { startAt: from, endAt: to },
    });
  });
}

/** The day view every booking sector needs (arrivals, sittings, appointments). */
export function listBookings(
  ctx: Ctx,
  filter: { resourceId?: string; from?: string; to?: string; status?: BookingStatus } = {},
) {
  requirePermission(ctx, 'sales', 'view');
  const conds = [eq(bookings.tenantId, ctx.tenantId)];
  if (filter.resourceId) conds.push(eq(bookings.resourceId, filter.resourceId));
  if (filter.status) conds.push(eq(bookings.status, filter.status));
  // window bounds are normalised too, so the day view cannot be skewed by a
  // caller-supplied offset format (same root cause as the overlap check)
  if (filter.from) conds.push(gt(bookings.endAt, normalizeInstant(filter.from, 'from')));
  if (filter.to) conds.push(lt(bookings.startAt, normalizeInstant(filter.to, 'to')));
  return ctx.db.select().from(bookings).where(and(...conds)).orderBy(asc(bookings.startAt)).all();
}
