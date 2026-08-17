import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { AuditEventInput } from '@factoryos/shared';
import { auditEvents } from '../db/schema.js';
import { newId, nowIso } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';

/** Append-only. There is deliberately no update or delete for audit events. */
export function writeAudit(ctx: Ctx, event: AuditEventInput): void {
  ctx.db
    .insert(auditEvents)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      userId: actorId(ctx),
      module: event.module,
      action: event.action,
      entity: event.entity ?? null,
      entityId: event.entityId ?? null,
      reference: event.reference ?? null,
      summary: event.summary,
      before: event.before === undefined ? null : (event.before as object),
      after: event.after === undefined ? null : (event.after as object),
      reason: event.reason ?? null,
      result: event.result ?? 'success',
      createdAt: nowIso(),
    })
    .run();
}

export interface AuditQuery {
  from?: string;
  to?: string;
  module?: string;
  action?: string;
  userId?: string;
  entity?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
}

export function listAudit(ctx: Ctx, q: AuditQuery) {
  const conds = [eq(auditEvents.tenantId, ctx.tenantId)];
  if (q.from) conds.push(gte(auditEvents.createdAt, q.from));
  if (q.to) conds.push(lte(auditEvents.createdAt, q.to));
  if (q.module) conds.push(eq(auditEvents.module, q.module));
  if (q.action) conds.push(eq(auditEvents.action, q.action));
  if (q.userId) conds.push(eq(auditEvents.userId, q.userId));
  if (q.entity) conds.push(eq(auditEvents.entity, q.entity));
  if (q.entityId) conds.push(eq(auditEvents.entityId, q.entityId));
  const where = and(...conds);
  const rows = ctx.db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt))
    .limit(Math.min(q.limit ?? 100, 500))
    .offset(q.offset ?? 0)
    .all();
  const [{ count }] = ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(where)
    .all();
  return { rows, count };
}
