import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { workOrderParts, workOrders, users } from '../db/schema.js';
import { newId, nowIso, badRequest, forbidden, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { requirePermission } from './permissions.js';
import { postMovement } from './inventory.js';
import { nextDocNumber, defineSequence } from './numbering.js';
import { getItem, getWarehouse } from './masterdata.js';

/**
 * Work orders — ONE dispatched-job capability shared by automotive workshops,
 * field service, utilities crews, and mining/hospitality/property maintenance.
 *
 * Discipline:
 *  - Status transitions are explicit and validated (no arbitrary jumps) and
 *    every one is audited.
 *  - Parts issued to a job post REAL stock movements through the append-only
 *    ledger — a job can never consume phantom inventory.
 *  - A technician may only advance their OWN assigned job; dispatch/assignment
 *    needs the wider production.edit authority. Experience narrows further, but
 *    permission is the authority.
 */

export type WorkOrderStatus = 'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

const ALLOWED: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  draft: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export interface CreateWorkOrderInput {
  title: string;
  kind?: string;
  description?: string;
  customerId?: string;
  assetRef?: string;
  assignedToUserId?: string;
  priority?: 'low' | 'normal' | 'high';
  scheduledFor?: string;
}

function ensureSeq(ctx: Ctx): void {
  defineSequence(ctx, 'work_order', 'WO-', 4);
}

export function getWorkOrder(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.tenantId, ctx.tenantId), eq(workOrders.id, id)))
    .get();
  if (!row) notFound('work_order_missing', 'Work order not found');
  return row!;
}

export function createWorkOrder(ctx: Ctx, input: CreateWorkOrderInput): { id: string; docNumber: string } {
  requirePermission(ctx, 'production', 'create');
  if (!input.title?.trim()) badRequest('wo_title', 'A job title is required');
  if (input.assignedToUserId) assertTenantUser(ctx, input.assignedToUserId);
  return inTx(ctx, (tx) => {
    ensureSeq(tx);
    const docNumber = nextDocNumber(tx, 'work_order');
    const id = newId();
    tx.db
      .insert(workOrders)
      .values({
        id,
        tenantId: tx.tenantId,
        docNumber,
        kind: input.kind ?? 'job',
        title: input.title.trim(),
        description: input.description ?? null,
        customerId: input.customerId ?? null,
        assetRef: input.assetRef ?? null,
        assignedToUserId: input.assignedToUserId ?? null,
        status: input.scheduledFor || input.assignedToUserId ? 'scheduled' : 'draft',
        priority: input.priority ?? 'normal',
        scheduledFor: input.scheduledFor ?? null,
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'production',
      action: 'work_order_create',
      entity: 'work_order',
      entityId: id,
      reference: docNumber,
      summary: `Work order ${docNumber} created: ${input.title.trim()}`,
    });
    return { id, docNumber };
  });
}

/** A user id must belong to THIS tenant — never trust a caller-supplied id. */
function assertTenantUser(ctx: Ctx, userId: string): void {
  const row = ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)))
    .get();
  if (!row) badRequest('assignee_invalid', 'Assignee is not a user of this organization');
}

export function assignWorkOrder(ctx: Ctx, id: string, userId: string, scheduledFor?: string): void {
  requirePermission(ctx, 'production', 'edit');
  const wo = getWorkOrder(ctx, id);
  if (wo.status === 'completed' || wo.status === 'cancelled') {
    badRequest('wo_closed', `A ${wo.status} job cannot be reassigned`);
  }
  assertTenantUser(ctx, userId);
  inTx(ctx, (tx) => {
    tx.db
      .update(workOrders)
      .set({
        assignedToUserId: userId,
        scheduledFor: scheduledFor ?? wo.scheduledFor,
        status: wo.status === 'draft' ? 'scheduled' : wo.status,
      })
      .where(eq(workOrders.id, id))
      .run();
    writeAudit(tx, {
      module: 'production',
      action: 'work_order_assign',
      entity: 'work_order',
      entityId: id,
      reference: wo.docNumber,
      summary: `Work order ${wo.docNumber} assigned`,
      before: { assignedToUserId: wo.assignedToUserId },
      after: { assignedToUserId: userId, scheduledFor: scheduledFor ?? wo.scheduledFor },
    });
  });
}

/** The technician working the job (or a dispatcher) advances its status. */
function transition(
  ctx: Ctx,
  id: string,
  to: WorkOrderStatus,
  patch: Record<string, unknown>,
  summary: string,
  reason?: string,
): void {
  const wo = getWorkOrder(ctx, id);
  const from = wo.status as WorkOrderStatus;
  if (!ALLOWED[from]?.includes(to)) {
    badRequest('wo_transition', `A job cannot go from ${from} to ${to}`);
  }
  // the assignee may advance their own job with production.edit; anyone else
  // advancing someone else's job needs the same authority — assignment itself
  // is the dispatcher's control point.
  requirePermission(ctx, 'production', 'edit');
  const isAssignee = wo.assignedToUserId != null && wo.assignedToUserId === actorId(ctx);
  if (!isAssignee && wo.assignedToUserId != null) {
    // a different user is closing someone else's job — allowed only with approve
    requirePermission(ctx, 'production', 'approve');
  }
  inTx(ctx, (tx) => {
    tx.db.update(workOrders).set({ status: to, ...patch }).where(eq(workOrders.id, id)).run();
    writeAudit(tx, {
      module: 'production',
      action: `work_order_${to}`,
      entity: 'work_order',
      entityId: id,
      reference: wo.docNumber,
      summary,
      before: { status: from },
      after: { status: to },
      reason,
    });
  });
}

export function startWorkOrder(ctx: Ctx, id: string): void {
  const wo = getWorkOrder(ctx, id);
  transition(ctx, id, 'in_progress', { startedAt: nowIso() }, `Work order ${wo.docNumber} started`);
}

export function completeWorkOrder(ctx: Ctx, id: string, completionNote?: string): void {
  const wo = getWorkOrder(ctx, id);
  transition(
    ctx,
    id,
    'completed',
    { completedAt: nowIso(), completionNote: completionNote ?? null },
    `Work order ${wo.docNumber} completed`,
  );
}

export function cancelWorkOrder(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('wo_reason', 'A cancellation reason is required');
  const wo = getWorkOrder(ctx, id);
  transition(ctx, id, 'cancelled', { cancelledReason: reason }, `Work order ${wo.docNumber} cancelled`, reason);
}

/**
 * Issue a part to a job: posts a REAL stock movement (issue) and records the
 * consumption line. Only an open job consumes parts.
 */
export function issuePartToWorkOrder(
  ctx: Ctx,
  id: string,
  input: { itemId: string; warehouseId: string; lotId?: string | null; qty: number },
): { partId: string } {
  requirePermission(ctx, 'inventory', 'create');
  const wo = getWorkOrder(ctx, id);
  if (wo.status !== 'scheduled' && wo.status !== 'in_progress') {
    badRequest('wo_not_open', 'Parts can only be issued to a scheduled or in-progress job');
  }
  const item = getItem(ctx, input.itemId);
  getWarehouse(ctx, input.warehouseId);
  if (!(input.qty > 0)) badRequest('wo_part_qty', 'Issued quantity must be positive');
  // Traceability: a lot-tracked part must name the lot it came from, otherwise
  // the issue would post against an untracked balance and break lot genealogy.
  if (item.trackingMode === 'lot' && !input.lotId) {
    badRequest('wo_part_lot', `'${item.name}' is lot-tracked — the lot being used must be specified`);
  }
  const qtyMilli = Math.round(input.qty * 1000);
  return inTx(ctx, (tx) => {
    postMovement(tx, {
      itemId: input.itemId,
      lotId: input.lotId ?? null,
      warehouseId: input.warehouseId,
      qty: -qtyMilli, // parts leave stock
      movementType: 'issue',
      documentKind: 'work_order',
      documentId: id,
      documentNumber: wo.docNumber,
    });
    const partId = newId();
    tx.db
      .insert(workOrderParts)
      .values({
        id: partId,
        tenantId: tx.tenantId,
        workOrderId: id,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        lotId: input.lotId ?? null,
        qty: qtyMilli,
        issuedBy: actorId(tx),
        issuedAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'inventory',
      action: 'work_order_part_issue',
      entity: 'work_order',
      entityId: id,
      reference: wo.docNumber,
      summary: `${qtyMilli / 1000} issued to work order ${wo.docNumber}`,
    });
    return { partId };
  });
}

export function listWorkOrders(
  ctx: Ctx,
  filter: { status?: WorkOrderStatus; assignedToUserId?: string; limit?: number } = {},
) {
  requirePermission(ctx, 'production', 'view');
  const conds = [eq(workOrders.tenantId, ctx.tenantId)];
  if (filter.status) conds.push(eq(workOrders.status, filter.status));
  if (filter.assignedToUserId) conds.push(eq(workOrders.assignedToUserId, filter.assignedToUserId));
  return ctx.db
    .select()
    .from(workOrders)
    .where(and(...conds))
    .orderBy(asc(workOrders.scheduledFor), desc(workOrders.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500))
    .all();
}

/** The technician's own queue — the entire content of their worker screen. */
export function myWorkOrders(ctx: Ctx) {
  requirePermission(ctx, 'production', 'view');
  const me = actorId(ctx);
  if (!me) forbidden('unauthenticated', 'Sign in required');
  return ctx.db
    .select()
    .from(workOrders)
    .where(
      and(
        eq(workOrders.tenantId, ctx.tenantId),
        eq(workOrders.assignedToUserId, me),
        inArray(workOrders.status, ['scheduled', 'in_progress']),
      ),
    )
    .orderBy(asc(workOrders.scheduledFor))
    .all();
}

export function workOrderParts_(ctx: Ctx, id: string) {
  getWorkOrder(ctx, id);
  return ctx.db
    .select()
    .from(workOrderParts)
    .where(and(eq(workOrderParts.tenantId, ctx.tenantId), eq(workOrderParts.workOrderId, id)))
    .all();
}
