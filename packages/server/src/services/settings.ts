import { and, desc, eq } from 'drizzle-orm';
import { tenantSettings } from '../db/schema.js';
import { newId, nowIso } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';
import { writeAudit } from './audit.js';

/**
 * Versioned settings. Every save creates a new version; documents snapshot the
 * version they were posted with, so history keeps its original configuration.
 */
export function getSettings<T = Record<string, unknown>>(
  ctx: Ctx,
  domain: string,
): { version: number; data: T } | null {
  const row = ctx.db
    .select()
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, ctx.tenantId), eq(tenantSettings.domain, domain)))
    .orderBy(desc(tenantSettings.version))
    .limit(1)
    .get();
  if (!row) return null;
  return { version: row.version, data: row.data as T };
}

export function saveSettings(ctx: Ctx, domain: string, data: unknown): { version: number } {
  const current = getSettings(ctx, domain);
  const version = (current?.version ?? 0) + 1;
  ctx.db
    .insert(tenantSettings)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      domain,
      version,
      data: data as object,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'save',
    entity: 'tenant_settings',
    reference: `${domain}/v${version}`,
    summary: `Settings '${domain}' saved as version ${version}`,
    before: current?.data ?? null,
    after: data,
  });
  return { version };
}

export function getSettingsVersion<T = Record<string, unknown>>(
  ctx: Ctx,
  domain: string,
  version: number,
): { version: number; data: T } | null {
  const row = ctx.db
    .select()
    .from(tenantSettings)
    .where(
      and(
        eq(tenantSettings.tenantId, ctx.tenantId),
        eq(tenantSettings.domain, domain),
        eq(tenantSettings.version, version),
      ),
    )
    .get();
  if (!row) return null;
  return { version: row.version, data: row.data as T };
}
