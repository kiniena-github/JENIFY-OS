import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { tenants } from '../db/schema.js';
import { newId, nowIso, badRequest } from '../util.js';
import type { Ctx } from './context.js';

/**
 * Tenant provisioning. Factory configuration packages (e.g. config-mesob)
 * call these platform APIs — they never touch tables directly.
 */
export function createTenant(
  db: Db,
  input: {
    code: string;
    name: string;
    locationNote?: string;
    currency?: string;
    timezone?: string;
    brandColor?: string;
    logoPath?: string;
  },
): { tenantId: string; ctx: Ctx } {
  const existing = db.select().from(tenants).where(eq(tenants.code, input.code)).get();
  if (existing) badRequest('tenant_exists', `Tenant '${input.code}' already exists`);
  const id = newId();
  db.insert(tenants)
    .values({
      id,
      code: input.code,
      name: input.name,
      locationNote: input.locationNote ?? null,
      currency: input.currency ?? 'ETB',
      timezone: input.timezone ?? 'UTC',
      brandColor: input.brandColor ?? null,
      logoPath: input.logoPath ?? null,
      createdAt: nowIso(),
    })
    .run();
  return { tenantId: id, ctx: { db, tenantId: id, user: null } };
}

export function getTenant(db: Db, tenantId: string) {
  return db.select().from(tenants).where(eq(tenants.id, tenantId)).get() ?? null;
}

export function getTenantByCode(db: Db, code: string) {
  return db.select().from(tenants).where(eq(tenants.code, code)).get() ?? null;
}

export function updateTenantBranding(
  ctx: Ctx,
  patch: { name?: string; locationNote?: string; brandColor?: string; logoPath?: string },
): void {
  const tenant = getTenant(ctx.db, ctx.tenantId);
  if (!tenant) badRequest('tenant_missing', 'Tenant not found');
  ctx.db
    .update(tenants)
    .set({
      name: patch.name ?? tenant.name,
      locationNote: patch.locationNote ?? tenant.locationNote,
      brandColor: patch.brandColor ?? tenant.brandColor,
      logoPath: patch.logoPath ?? tenant.logoPath,
    })
    .where(eq(tenants.id, ctx.tenantId))
    .run();
}
