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

/**
 * Technical/system activity that must not bury operational stock, financial
 * and security events. Shown only when the caller asks for system scope.
 */
export const TECHNICAL_ACTIONS = ['report_run', 'translation_edit'] as const;

export interface AuditQuery {
  from?: string;
  to?: string;
  module?: string;
  action?: string;
  userId?: string;
  entity?: string;
  entityId?: string;
  /** free-text search over reference, summary, and action code */
  search?: string;
  /** 'operational' (default UI view) hides technical/system noise */
  scope?: 'operational' | 'system' | 'all';
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
  if (q.search?.trim()) {
    const term = `%${q.search.trim()}%`;
    conds.push(
      sql`(${auditEvents.reference} LIKE ${term} COLLATE NOCASE OR ${auditEvents.summary} LIKE ${term} COLLATE NOCASE OR ${auditEvents.action} LIKE ${term} COLLATE NOCASE)`,
    );
  }
  if (q.scope === 'operational') {
    conds.push(sql`${auditEvents.action} NOT IN (${sql.join(TECHNICAL_ACTIONS.map((a) => sql`${a}`), sql`, `)})`);
  } else if (q.scope === 'system') {
    conds.push(sql`${auditEvents.action} IN (${sql.join(TECHNICAL_ACTIONS.map((a) => sql`${a}`), sql`, `)})`);
  }
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
