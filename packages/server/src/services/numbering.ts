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

/**
 * Atomically allocate the next document number for a sequence.
 * The increment and the value we hand out come from ONE statement
 * (UPDATE … RETURNING), so two concurrent postings can never both
 * read the same counter and mint duplicate numbers.
 */
export function nextDocNumber(ctx: Ctx, seqKey: string): string {
  const updated = ctx.db
    .update(documentSequences)
    .set({ nextValue: sql`${documentSequences.nextValue} + 1` })
    .where(and(eq(documentSequences.tenantId, ctx.tenantId), eq(documentSequences.seqKey, seqKey)))
    .returning({
      prefix: documentSequences.prefix,
      padding: documentSequences.padding,
      nextValue: documentSequences.nextValue,
    })
    .get();
  if (!updated) badRequest('sequence_missing', `Document sequence '${seqKey}' is not configured`);
  const allocated = updated.nextValue - 1; // RETURNING yields the post-increment counter
  return `${updated.prefix}${String(allocated).padStart(updated.padding, '0')}`;
}

export function listSequences(ctx: Ctx) {
  return ctx.db
    .select()
    .from(documentSequences)
    .where(eq(documentSequences.tenantId, ctx.tenantId))
    .all();
}
