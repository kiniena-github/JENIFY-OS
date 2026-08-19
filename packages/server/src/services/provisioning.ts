import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  documentSequences,
  items,
  productionStages,
  roles,
  tenantLanguages,
  tenantSettings,
  tenants,
  translations,
  uoms,
  warehouses,
} from '../db/schema.js';
import { newId, nowIso, badRequest } from '../util.js';
import type { Ctx } from './context.js';
import { createRole, getRoleMatrix } from './permissions.js';
import { createUser } from './users.js';
import { writeAudit } from './audit.js';

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

/** True for a valid IANA timezone identifier (e.g. Africa/Addis_Ababa). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function updateTenantBranding(
  ctx: Ctx,
  patch: { name?: string; locationNote?: string; brandColor?: string; logoPath?: string; timezone?: string },
): void {
  const tenant = getTenant(ctx.db, ctx.tenantId);
  if (!tenant) badRequest('tenant_missing', 'Tenant not found');
  if (patch.timezone != null && !isValidTimezone(patch.timezone)) {
    badRequest('timezone_invalid', `'${patch.timezone}' is not a valid timezone identifier`);
  }
  const before = {
    name: tenant.name,
    locationNote: tenant.locationNote,
    brandColor: tenant.brandColor,
    timezone: tenant.timezone,
  };
  ctx.db
    .update(tenants)
    .set({
      name: patch.name ?? tenant.name,
      locationNote: patch.locationNote ?? tenant.locationNote,
      brandColor: patch.brandColor ?? tenant.brandColor,
      logoPath: patch.logoPath ?? tenant.logoPath,
      timezone: patch.timezone ?? tenant.timezone,
    })
    .where(eq(tenants.id, ctx.tenantId))
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'tenant_update',
    entity: 'tenant',
    entityId: ctx.tenantId,
    reference: tenant.code,
    summary:
      patch.timezone && patch.timezone !== tenant.timezone
        ? `Factory timezone changed to ${patch.timezone} (display only — stored transactions unchanged)`
        : `Company profile updated`,
    before,
    after: patch,
  });
}

/**
 * "Initialize Fresh Production Tenant": clone a validated tenant's APPROVED
 * CONFIGURATION into a brand-new tenant with ZERO operational history —
 * no transactions, no test customers, no batches, no payments, no audit noise.
 *
 * Copied: tenant identity/branding, latest settings versions, roles + latest
 * permission matrices, units, items, EXPLICITLY APPROVED warehouses and
 * languages, custom translations (approved languages only), production
 * stages, document numbering (counters reset to 1).
 * Never copied: parties, lots, stock, batches, invoices, deliveries, payments,
 * simple transactions, users (a fresh owner is created), unapproved
 * warehouses/languages, any operational history.
 *
 * Approval is EXPLICIT — nothing is carried over merely for being active in
 * the validation database. Real-world opening stock/receivables at go-live
 * should enter through proper opening documents later — never as fabricated
 * history.
 */
export interface FreshTenantSelection {
  /** warehouse CODES explicitly approved for production — required */
  warehouseCodes: string[];
  /** language codes to carry; defaults to currently ENABLED languages */
  languageCodes?: string[];
}

/** Dry-run: exactly what a fresh production tenant WOULD copy vs leave behind. */
export function previewFreshProductionTenant(
  db: Db,
  sourceTenantId: string,
  selection: FreshTenantSelection,
): { willCopy: Record<string, string[] | string>; willNotCopy: Record<string, string> } {
  const source = getTenant(db, sourceTenantId);
  if (!source) badRequest('tenant_missing', 'Source tenant not found');
  const whAll = db.select().from(warehouses).where(eq(warehouses.tenantId, source.id)).all();
  const approvedWh = whAll.filter((w) => selection.warehouseCodes.includes(w.code) && w.active);
  const langAll = db.select().from(tenantLanguages).where(eq(tenantLanguages.tenantId, source.id)).all();
  const wantedLangs = selection.languageCodes ?? langAll.filter((l) => l.enabled).map((l) => l.code);
  const approvedLangs = langAll.filter((l) => wantedLangs.includes(l.code));
  const itemsAll = db.select().from(items).where(eq(items.tenantId, source.id)).all();
  const stagesAll = db.select().from(productionStages).where(eq(productionStages.tenantId, source.id)).all();
  const rolesAll = db.select().from(roles).where(eq(roles.tenantId, source.id)).all();
  const seqAll = db.select().from(documentSequences).where(eq(documentSequences.tenantId, source.id)).all();
  const settingsDomains = [
    ...new Set(
      db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, source.id)).all().map((x) => x.domain),
    ),
  ];
  return {
    willCopy: {
      company: `${source.name} (${source.currency}, ${source.timezone})`,
      warehouses: approvedWh.map((w) => `${w.code} — ${w.name}`),
      products: itemsAll.map((i) => i.name),
      productionStages: stagesAll.sort((a, b) => a.sequence - b.sequence).map((st) => st.code),
      roles: rolesAll.map((r) => r.name),
      languages: approvedLangs.map((l) => l.code),
      settings: settingsDomains,
      numbering: seqAll.map((sq) => `${sq.prefix}${'\u2026'} (counter reset to 1)`),
    },
    willNotCopy: {
      transactions: 'receipts, transfers, batches, invoices, payments, deliveries, sack transactions',
      customersSuppliers: 'all parties',
      stock: 'all lots, movements, balances, reservations',
      users: 'all accounts (a fresh owner is created)',
      unapprovedWarehouses:
        whAll
          .filter((w) => !(selection.warehouseCodes.includes(w.code) && w.active))
          .map((w) => `${w.code} — ${w.name}`)
          .join(', ') || 'none',
      unapprovedLanguages:
        langAll
          .filter((l) => !wantedLangs.includes(l.code))
          .map((l) => l.code)
          .join(', ') || 'none',
      history: 'audit trail and every operational record',
    },
  };
}

export function initFreshProductionTenant(
  db: Db,
  input: {
    sourceTenantId: string;
    code: string;
    name: string;
    ownerUsername: string;
    ownerPassword: string;
    ownerDisplayName?: string;
    /** explicit approved-production selection — nothing copied by accident */
    selection: FreshTenantSelection;
  },
): { tenantId: string; ownerUserId: string } {
  const source = getTenant(db, input.sourceTenantId);
  if (!source) badRequest('tenant_missing', 'Source tenant not found');
  if (!input.selection?.warehouseCodes?.length) {
    badRequest('selection_required', 'Explicitly list the approved production warehouse codes');
  }
  const srcCtx: Ctx = { db, tenantId: source.id, user: null };

  const { tenantId, ctx } = createTenant(db, {
    code: input.code,
    name: input.name,
    locationNote: source.locationNote ?? undefined,
    currency: source.currency,
    timezone: source.timezone,
    brandColor: source.brandColor ?? undefined,
    logoPath: source.logoPath ?? undefined,
  });

  // every copied entity gets a fresh id; settings JSON is rewritten with the map
  const idMap = new Map<string, string>();

  // ---- units of measure ----
  for (const u of db.select().from(uoms).where(eq(uoms.tenantId, source.id)).all()) {
    const id = newId();
    idMap.set(u.id, id);
    db.insert(uoms)
      .values({ ...u, id, tenantId })
      .run();
  }

  // ---- items ----
  for (const i of db.select().from(items).where(eq(items.tenantId, source.id)).all()) {
    const id = newId();
    idMap.set(i.id, id);
    db.insert(items)
      .values({ ...i, id, tenantId, baseUomId: idMap.get(i.baseUomId) ?? i.baseUomId, createdAt: nowIso() })
      .run();
  }

  // ---- warehouses: EXPLICITLY approved codes only, never "whatever is active" ----
  const approvedWarehouses = db
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, source.id), eq(warehouses.active, true)))
    .all()
    .filter((w) => input.selection.warehouseCodes.includes(w.code));
  if (approvedWarehouses.length !== input.selection.warehouseCodes.length) {
    const found = approvedWarehouses.map((w) => w.code);
    const missing = input.selection.warehouseCodes.filter((c) => !found.includes(c));
    badRequest('warehouse_selection', `Approved warehouse code(s) not found or inactive: ${missing.join(', ')}`);
  }
  for (const w of approvedWarehouses) {
    const id = newId();
    idMap.set(w.id, id);
    db.insert(warehouses)
      .values({ ...w, id, tenantId, createdAt: nowIso() })
      .run();
  }

  // ---- production stages (sequence order so prior-stage links resolve) ----
  const stages = db
    .select()
    .from(productionStages)
    .where(eq(productionStages.tenantId, source.id))
    .all()
    .sort((a, b) => a.sequence - b.sequence);
  for (const s of stages) {
    const id = newId();
    idMap.set(s.id, id);
    db.insert(productionStages)
      .values({
        ...s,
        id,
        tenantId,
        inputItemId: s.inputItemId ? (idMap.get(s.inputItemId) ?? s.inputItemId) : null,
        priorStageId: s.priorStageId ? (idMap.get(s.priorStageId) ?? s.priorStageId) : null,
        outputItemIds: Array.isArray(s.outputItemIds)
          ? (s.outputItemIds as string[]).map((x) => idMap.get(x) ?? x)
          : s.outputItemIds,
      })
      .run();
  }

  // ---- document numbering: same prefixes, counters reset to 1 ----
  for (const seq of db
    .select()
    .from(documentSequences)
    .where(eq(documentSequences.tenantId, source.id))
    .all()) {
    db.insert(documentSequences)
      .values({ id: newId(), tenantId, seqKey: seq.seqKey, prefix: seq.prefix, padding: seq.padding, nextValue: 1 })
      .run();
  }

  // ---- approved languages + their custom translations only ----
  const langAll = db
    .select()
    .from(tenantLanguages)
    .where(eq(tenantLanguages.tenantId, source.id))
    .all();
  const approvedLangCodes =
    input.selection.languageCodes ?? langAll.filter((l) => l.enabled).map((l) => l.code);
  for (const l of langAll.filter((x) => approvedLangCodes.includes(x.code))) {
    db.insert(tenantLanguages)
      .values({ ...l, id: newId(), tenantId })
      .run();
  }
  for (const tr of db
    .select()
    .from(translations)
    .where(eq(translations.tenantId, source.id))
    .all()
    .filter((x) => approvedLangCodes.includes(x.language))) {
    db.insert(translations)
      .values({ ...tr, id: newId(), tenantId })
      .run();
  }

  // ---- latest settings per domain, item/warehouse ids rewritten ----
  const remapJson = (value: unknown): unknown => {
    if (typeof value === 'string') return idMap.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remapJson);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [idMap.get(k) ?? k, remapJson(v)]),
      );
    }
    return value;
  };
  const allSettings = db
    .select()
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, source.id))
    .orderBy(desc(tenantSettings.version))
    .all();
  const latestByDomain = new Map<string, (typeof allSettings)[number]>();
  for (const s of allSettings) if (!latestByDomain.has(s.domain)) latestByDomain.set(s.domain, s);
  for (const s of latestByDomain.values()) {
    db.insert(tenantSettings)
      .values({
        id: newId(),
        tenantId,
        domain: s.domain,
        version: 1,
        data: remapJson(s.data) as object,
        createdBy: null,
        createdAt: nowIso(),
      })
      .run();
  }

  // ---- roles with their LATEST matrices ----
  let ownerRoleId: string | null = null;
  for (const r of db.select().from(roles).where(eq(roles.tenantId, source.id)).all()) {
    const matrix = getRoleMatrix(srcCtx, r.id);
    const id = createRole(ctx, {
      code: r.code,
      name: r.name,
      description: r.description ?? undefined,
      isOwnerRole: r.isOwnerRole,
      matrix,
    });
    if (r.isOwnerRole) ownerRoleId = id;
  }
  if (!ownerRoleId) badRequest('no_owner_role', 'Source tenant has no owner role to clone');

  // ---- fresh owner account (credentials supplied by the provisioner) ----
  const ownerUserId = createUser(ctx, {
    username: input.ownerUsername,
    displayName: input.ownerDisplayName ?? `${input.name} Owner`,
    password: input.ownerPassword,
    roleId: ownerRoleId,
  });

  writeAudit(ctx, {
    module: 'settings',
    action: 'tenant_provisioned',
    entity: 'tenant',
    entityId: tenantId,
    reference: input.code,
    summary: `Fresh production tenant '${input.name}' initialized from '${source.name}' configuration — zero operational history`,
  });

  return { tenantId, ownerUserId };
}
