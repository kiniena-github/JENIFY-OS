import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission } from '../services/permissions.js';
import {
  createWorkOrder, assignWorkOrder, startWorkOrder, completeWorkOrder, cancelWorkOrder,
  issuePartToWorkOrder, listWorkOrders, myWorkOrders, getWorkOrder, workOrderParts_,
  type CreateWorkOrderInput, type WorkOrderStatus,
} from '../services/workorders.js';
import {
  createResource, listResources, createBooking, checkInBooking, completeBooking,
  cancelBooking, markNoShow, rescheduleBooking, listBookings, getBooking,
  type CreateBookingInput, type BookingStatus,
} from '../services/bookings.js';

/**
 * Shared operational capabilities used by many sector templates:
 *   work orders — automotive, field service, utilities, mining, maintenance
 *   bookings    — hospitality, restaurant, healthcare, education
 * Permissions are enforced inside each service (fail-closed), so these handlers
 * stay thin and no authority decision is duplicated.
 */
export function registerOperationsRoutes(app: FastifyInstance, db: Db): void {
  // ------------------------------ work orders ------------------------------
  app.get<{ Querystring: { status?: WorkOrderStatus; assignedToUserId?: string } }>('/api/work-orders', async (req) => {
    const ctx = requireCtx(db, req);
    return listWorkOrders(ctx, req.query);
  });

  /** The technician's own queue — the whole content of their worker screen. */
  app.get('/api/work-orders/mine', async (req) => {
    const ctx = requireCtx(db, req);
    return myWorkOrders(ctx);
  });

  app.get<{ Params: { id: string } }>('/api/work-orders/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'view');
    return { workOrder: getWorkOrder(ctx, req.params.id), parts: workOrderParts_(ctx, req.params.id) };
  });

  app.post<{ Body: CreateWorkOrderInput }>('/api/work-orders', async (req) => {
    const ctx = requireCtx(db, req);
    return createWorkOrder(ctx, req.body);
  });

  app.post<{ Params: { id: string }; Body: { userId: string; scheduledFor?: string } }>(
    '/api/work-orders/:id/assign',
    async (req) => {
      const ctx = requireCtx(db, req);
      assignWorkOrder(ctx, req.params.id, req.body.userId, req.body.scheduledFor);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/work-orders/:id/start', async (req) => {
    const ctx = requireCtx(db, req);
    startWorkOrder(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/api/work-orders/:id/complete', async (req) => {
    const ctx = requireCtx(db, req);
    completeWorkOrder(ctx, req.params.id, req.body?.note);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>('/api/work-orders/:id/cancel', async (req) => {
    const ctx = requireCtx(db, req);
    cancelWorkOrder(ctx, req.params.id, req.body?.reason);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { itemId: string; warehouseId: string; lotId?: string; qty: number } }>(
    '/api/work-orders/:id/parts',
    async (req) => {
      const ctx = requireCtx(db, req);
      return issuePartToWorkOrder(ctx, req.params.id, req.body);
    },
  );

  // -------------------------------- bookings -------------------------------
  app.get('/api/resources', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'view');
    return listResources(ctx);
  });

  app.post<{ Body: { code: string; name: string; kind?: string; capacity?: number } }>('/api/resources', async (req) => {
    const ctx = requireCtx(db, req);
    return { id: createResource(ctx, req.body) };
  });

  app.get<{ Querystring: { resourceId?: string; from?: string; to?: string; status?: BookingStatus } }>(
    '/api/bookings',
    async (req) => {
      const ctx = requireCtx(db, req);
      return listBookings(ctx, req.query);
    },
  );

  app.get<{ Params: { id: string } }>('/api/bookings/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'view');
    return getBooking(ctx, req.params.id);
  });

  app.post<{ Body: CreateBookingInput }>('/api/bookings', async (req) => {
    const ctx = requireCtx(db, req);
    return createBooking(ctx, req.body);
  });

  app.post<{ Params: { id: string } }>('/api/bookings/:id/check-in', async (req) => {
    const ctx = requireCtx(db, req);
    checkInBooking(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/bookings/:id/complete', async (req) => {
    const ctx = requireCtx(db, req);
    completeBooking(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/bookings/:id/no-show', async (req) => {
    const ctx = requireCtx(db, req);
    markNoShow(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>('/api/bookings/:id/cancel', async (req) => {
    const ctx = requireCtx(db, req);
    cancelBooking(ctx, req.params.id, req.body?.reason);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { startAt: string; endAt: string } }>(
    '/api/bookings/:id/reschedule',
    async (req) => {
      const ctx = requireCtx(db, req);
      rescheduleBooking(ctx, req.params.id, req.body.startAt, req.body.endAt);
      return { ok: true };
    },
  );
}
