import { and, eq, sql } from 'drizzle-orm';
import { documentSequences } from '../db/schema.js';
import { newId, badRequest } from '../util.js';
import type { Ctx } from './context.js';

export function defineSequence(
  ctx: Ctx,
  seqKey: string,
  prefix: string,
  padding = 4,
  startAt = 1,
): void {
  const existing = ctx.db
    .select()
    .from(documentSequences)
    .where(and(eq(documentSequences.tenantId, ctx.tenantId), eq(documentSequences.seqKey, seqKey)))
    .get();
  if (existing) {
    ctx.db
      .update(documentSequences)
      .set({ prefix, padding })
      .where(eq(documentSequences.id, existing.id))
      .run();
    return;
  }
  ctx.db
    .insert(documentSequences)
    .values({ id: newId(), tenantId: ctx.tenantId, seqKey, prefix, padding, nextValue: startAt })
    .run();
}

/** Atomically allocate the next document number for a sequence. */
export function nextDocNumber(ctx: Ctx, seqKey: string): string {
  const row = ctx.db
    .select()
    .from(documentSequences)
    .where(and(eq(documentSequences.tenantId, ctx.tenantId), eq(documentSequences.seqKey, seqKey)))
    .get();
  if (!row) badRequest('sequence_missing', `Document sequence '${seqKey}' is not configured`);
  ctx.db
    .update(documentSequences)
    .set({ nextValue: sql`${documentSequences.nextValue} + 1` })
    .where(eq(documentSequences.id, row.id))
    .run();
  return `${row.prefix}${String(row.nextValue).padStart(row.padding, '0')}`;
}

export function listSequences(ctx: Ctx) {
  return ctx.db
    .select()
    .from(documentSequences)
    .where(eq(documentSequences.tenantId, ctx.tenantId))
    .all();
}
