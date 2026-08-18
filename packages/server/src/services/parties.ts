import { and, eq, like, or } from 'drizzle-orm';
import type { PartyKind } from '@factoryos/shared';
import { parties } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';
import { writeAudit } from './audit.js';

export function createParty(
  ctx: Ctx,
  input: {
    kind: PartyKind;
    name: string;
    partyType?: string;
    phone?: string;
    location?: string;
    taxInfo?: string;
    creditLimit?: number; // major currency units
    defaultPriceCategory?: string;
    notes?: string;
  },
): string {
  if (!input.name.trim()) badRequest('party_name', 'Name is required');
  if (input.creditLimit != null && input.creditLimit < 0) {
    badRequest('credit_limit', 'Credit limit cannot be negative');
  }
  const id = newId();
  ctx.db
    .insert(parties)
    .values({
      id,
      tenantId: ctx.tenantId,
      kind: input.kind,
      name: input.name.trim(),
      partyType: input.partyType ?? null,
      phone: input.phone ?? null,
      location: input.location ?? null,
      taxInfo: input.taxInfo ?? null,
      creditLimitCents: input.creditLimit != null ? Math.round(input.creditLimit * 100) : null,
      defaultPriceCategory: input.defaultPriceCategory ?? null,
      notes: input.notes ?? null,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'parties',
    action: 'party_create',
    entity: 'party',
    entityId: id,
    reference: input.name,
    summary: `${input.kind} '${input.name}' created`,
  });
  return id;
}

export function updateParty(
  ctx: Ctx,
  partyId: string,
  patch: {
    name?: string;
    partyType?: string;
    phone?: string;
    location?: string;
    taxInfo?: string;
    creditLimit?: number | null;
    defaultPriceCategory?: string | null;
    notes?: string;
    active?: boolean;
  },
): void {
  const party = getParty(ctx, partyId);
  if (patch.creditLimit != null && patch.creditLimit < 0) {
    badRequest('credit_limit', 'Credit limit cannot be negative');
  }
  const before = {
    name: party.name,
    partyType: party.partyType,
    creditLimitCents: party.creditLimitCents,
    active: party.active,
  };
  ctx.db
    .update(parties)
    .set({
      name: patch.name ?? party.name,
      partyType: patch.partyType ?? party.partyType,
      phone: patch.phone ?? party.phone,
      location: patch.location ?? party.location,
      taxInfo: patch.taxInfo ?? party.taxInfo,
      creditLimitCents:
        patch.creditLimit === undefined
          ? party.creditLimitCents
          : patch.creditLimit === null
            ? null
            : Math.round(patch.creditLimit * 100),
      defaultPriceCategory:
        patch.defaultPriceCategory === undefined
          ? party.defaultPriceCategory
          : patch.defaultPriceCategory,
      notes: patch.notes ?? party.notes,
      active: patch.active ?? party.active,
    })
    .where(eq(parties.id, partyId))
    .run();
  writeAudit(ctx, {
    module: 'parties',
    action: 'party_update',
    entity: 'party',
    entityId: partyId,
    reference: party.name,
    summary: `Party '${party.name}' updated`,
    before,
    after: patch,
  });
  // credit controls are financial events — audit them under the credit module
  if (patch.creditLimit !== undefined) {
    const newCents = patch.creditLimit === null ? null : Math.round(patch.creditLimit * 100);
    if (newCents !== party.creditLimitCents) {
      writeAudit(ctx, {
        module: 'credit',
        action: 'credit_limit_change',
        entity: 'party',
        entityId: partyId,
        reference: party.name,
        summary: `Credit limit for '${party.name}' changed from ${party.creditLimitCents != null ? party.creditLimitCents / 100 : '—'} to ${newCents != null ? newCents / 100 : '—'}`,
        before: { creditLimitCents: party.creditLimitCents },
        after: { creditLimitCents: newCents },
      });
    }
  }
}

export function getParty(ctx: Ctx, partyId: string) {
  const row = ctx.db
    .select()
    .from(parties)
    .where(and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, partyId)))
    .get();
  if (!row) notFound('party_missing', 'Party not found');
  return row;
}

export function listParties(
  ctx: Ctx,
  filter: { kind?: PartyKind; search?: string; partyType?: string } = {},
) {
  const conds = [eq(parties.tenantId, ctx.tenantId)];
  if (filter.kind) {
    conds.push(or(eq(parties.kind, filter.kind), eq(parties.kind, 'both'))!);
  }
  if (filter.partyType) conds.push(eq(parties.partyType, filter.partyType));
  if (filter.search) {
    conds.push(or(like(parties.name, `%${filter.search}%`), like(parties.phone, `%${filter.search}%`))!);
  }
  return ctx.db
    .select()
    .from(parties)
    .where(and(...conds))
    .all();
}
