import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  CapabilityId,
  LayerKind,
  ResolvedConfig,
  TemplateLayer,
} from '@factoryos/shared';
import {
  LAYER_RANK,
  resolveTemplate,
  validateResolved,
  diffResolved,
} from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { templateLayers, tenantTemplateBindings, tenantSettings } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound, forbidden } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { requirePermission } from './permissions.js';
import { roles } from '../db/schema.js';

/**
 * Template engine: publish immutable template layers, bind a tenant to an
 * ordered layer stack, and resolve the tenant's effective configuration.
 *
 * Contract:
 *  - Published layers are immutable. Re-publishing the same templateId creates
 *    a new version and supersedes the prior one; nothing is edited in place.
 *  - Resolution is deterministic (delegated to the pure shared algebra) and
 *    layered: core -> capability -> sector -> subsector -> country -> company.
 *  - The company layer is synthesized from tenant_settings at resolve time and
 *    sits at the highest precedence (LAYER_RANK company=5). NOTE (architect H2):
 *    each settings domain is layered in as ONE opaque blob under
 *    core['<domain>'] — it does NOT yet override template defaults keyed by
 *    semantic name (e.g. a tenant currency in settings does not shadow the
 *    Ethiopia layer's core.defaultCurrency). Key-level semantic override is a
 *    tracked follow-up (see JENIFY_PROGRAM_STATE.md); no shipped feature reads a
 *    resolved semantic core key yet, so this is honest-but-incomplete, not a bug.
 */

export interface PublishLayerInput {
  templateId: string;
  kind: LayerKind;
  labelKey: string;
  extendsId?: string | null;
  activations?: Partial<Record<CapabilityId, TemplateLayer['activations'][CapabilityId]>>;
  config?: TemplateLayer['config'];
}

/**
 * Publish a new immutable version of a template layer.
 *
 * AUTHORITY (architect H1): `template_layers` is a GLOBAL platform table — a
 * published layer changes resolution for EVERY tenant that binds it. There is
 * no platform-administrator identity yet (tracked as WM5 in JENIFY_PROGRAM_
 * STATE.md), so publishing is restricted to a SYSTEM context (ctx.user === null:
 * seed, provisioning, migrations). No tenant user — not even an owner — may
 * publish a global layer, so wiring a route to this function can never open
 * cross-tenant config tampering. Replace this guard with the platform-admin
 * principal when WM5 lands.
 */
export function publishTemplateLayer(ctx: Ctx, input: PublishLayerInput): { version: number } {
  if (ctx.user !== null) {
    forbidden('template_authority', 'Global template layers may only be published by the platform (system context)');
  }
  if (!input.templateId.trim()) badRequest('template_id', 'A template id is required');
  if (!(input.kind in LAYER_RANK)) badRequest('kind', `Unknown layer kind '${input.kind}'`);

  // Atomic (architect M3): read-latest + insert + supersede must commit together,
  // or a concurrent publish could collide on template_layers_ver or leave two
  // 'published' rows for one templateId.
  return inTx(ctx, (tx) => {
    const latest = tx.db
      .select({ id: templateLayers.id, version: templateLayers.version })
      .from(templateLayers)
      .where(eq(templateLayers.templateId, input.templateId))
      .orderBy(desc(templateLayers.version))
      .limit(1)
      .get();
    const version = (latest?.version ?? 0) + 1;

    const definition: TemplateLayer = {
      id: input.templateId,
      kind: input.kind,
      version,
      labelKey: input.labelKey,
      extends: input.extendsId ?? null,
      activations: input.activations ?? {},
      config: input.config ?? {},
    };

    tx.db
      .insert(templateLayers)
      .values({
        id: newId(),
        templateId: input.templateId,
        kind: input.kind,
        version,
        labelKey: input.labelKey,
        extendsId: input.extendsId ?? null,
        status: 'published',
        definition: definition as object,
        createdBy: actorId(tx),
        publishedAt: nowIso(),
      })
      .run();
    if (latest) {
      tx.db.update(templateLayers).set({ status: 'superseded' }).where(eq(templateLayers.id, latest.id)).run();
    }
    writeAudit(tx, {
      module: 'settings',
      action: 'template_publish',
      entity: 'template_layer',
      reference: input.templateId,
      summary: `Template '${input.templateId}' published as v${version}`,
      after: { kind: input.kind, activations: definition.activations },
    });
    return { version };
  });
}

function loadLayer(db: Db, templateId: string, version?: number): TemplateLayer {
  const row = version
    ? db
        .select()
        .from(templateLayers)
        .where(and(eq(templateLayers.templateId, templateId), eq(templateLayers.version, version)))
        .get()
    : db
        .select()
        .from(templateLayers)
        .where(and(eq(templateLayers.templateId, templateId), eq(templateLayers.status, 'published')))
        .orderBy(desc(templateLayers.version))
        .limit(1)
        .get();
  if (!row) notFound('template_missing', `Template '${templateId}'${version ? ` v${version}` : ''} not found`);
  return row.definition as TemplateLayer;
}

/**
 * Expand a pinned layer list into a fully-ordered resolution stack:
 *  - each layer's `extends` chain is prepended (parents resolve first);
 *  - the whole stack is sorted by LAYER_RANK then by given order, so the
 *    company layer always wins regardless of authoring order.
 */
function expandStack(db: Db, pinned: Array<{ templateId: string; version?: number }>): TemplateLayer[] {
  const collected: TemplateLayer[] = [];
  const seen = new Set<string>();
  const add = (templateId: string, version?: number): void => {
    if (seen.has(templateId)) return;
    seen.add(templateId);
    const layer = loadLayer(db, templateId, version);
    if (layer.extends) add(layer.extends); // parent first (latest published)
    collected.push(layer);
  };
  for (const p of pinned) add(p.templateId, p.version);
  // stable sort by layer rank; equal ranks keep insertion order
  return collected
    .map((l, i) => ({ l, i }))
    .sort((a, b) => LAYER_RANK[a.l.kind] - LAYER_RANK[b.l.kind] || a.i - b.i)
    .map((x) => x.l);
}

/** Synthesize the tenant's company-layer overrides from tenant_settings. */
function companyLayer(db: Db, tenantId: string): TemplateLayer {
  const rows = db
    .select()
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId))
    .all();
  // newest version per settings domain becomes company config under that namespace
  const byDomain = new Map<string, { version: number; data: unknown }>();
  for (const r of rows) {
    const cur = byDomain.get(r.domain);
    if (!cur || r.version > cur.version) byDomain.set(r.domain, { version: r.version, data: r.data });
  }
  const config: TemplateLayer['config'] = {};
  for (const [domain, { data }] of byDomain) {
    // each settings domain layers in as one blob under core['<domain>'] — see
    // the H2 note on getBundle-style key-level override being a follow-up
    const ns = 'core';
    (config[ns] ??= {})[domain] = data;
  }
  return {
    id: 'company.tenant-settings',
    kind: 'company',
    version: 1,
    labelKey: 'template.company',
    activations: {},
    config,
  };
}

/** The active pinned binding for a tenant (newest binding-set), or null. */
export function activeBinding(db: Db, tenantId: string): Array<{ templateId: string; version?: number }> | null {
  const row = db
    .select()
    .from(tenantTemplateBindings)
    .where(eq(tenantTemplateBindings.tenantId, tenantId))
    .orderBy(desc(tenantTemplateBindings.version))
    .limit(1)
    .get();
  return row ? (row.layers as Array<{ templateId: string; version?: number }>) : null;
}

/**
 * Bind a tenant to an ordered pinned layer stack (append-only new version).
 *
 * A binding captures MEMBERSHIP (which templates, in what order), not a frozen
 * parent chain: `extends` parents resolve to their latest published version at
 * resolve time (architect M2), so re-publishing a parent updates every tenant
 * that binds a descendant. This is intentional for a live-config substrate —
 * document reproducibility rides on tenant_settings snapshots on the documents
 * themselves, never on template resolution. Pinning a child `version` pins that
 * layer's own definition, not its ancestors'.
 *
 * Authority: writes only this tenant's own binding, so a tenant owner with
 * settings authority may rebind; system context (seed/provisioning) is exempt.
 */
export function bindTenantTemplate(
  ctx: Ctx,
  layers: Array<{ templateId: string; version?: number }>,
): { version: number } {
  if (ctx.user !== null) {
    requirePermission(ctx, 'settings', 'edit');
    const role = ctx.db
      .select({ isOwnerRole: roles.isOwnerRole })
      .from(roles)
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, ctx.user.roleId)))
      .get();
    if (!role?.isOwnerRole) {
      forbidden('template_authority', 'Only an owner may change the tenant template binding');
    }
  }
  if (layers.length === 0) badRequest('layers', 'At least one template layer is required');
  // validate the stack resolves cleanly before persisting the binding
  const stack = [...expandStack(ctx.db, layers), companyLayer(ctx.db, ctx.tenantId)];
  const resolved = resolveTemplate(stack);
  const errors = validateResolved(resolved).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    badRequest('template_invalid', `Binding does not resolve cleanly: ${errors.map((e) => e.message).join('; ')}`);
  }
  const latest = ctx.db
    .select({ version: tenantTemplateBindings.version })
    .from(tenantTemplateBindings)
    .where(eq(tenantTemplateBindings.tenantId, ctx.tenantId))
    .orderBy(desc(tenantTemplateBindings.version))
    .limit(1)
    .get();
  const version = (latest?.version ?? 0) + 1;
  ctx.db
    .insert(tenantTemplateBindings)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      version,
      layers: layers as object,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'template_bind',
    entity: 'tenant_template_binding',
    reference: layers.map((l) => l.templateId).join(' > '),
    summary: `Tenant bound to ${layers.length} template layer(s) as binding v${version}`,
    after: { layers, activeCapabilities: resolved.activeCapabilities },
  });
  return { version };
}

/** Resolve a tenant's effective configuration (binding + company overrides). */
export function resolveTenantConfig(db: Db, tenantId: string): ResolvedConfig {
  const pinned = activeBinding(db, tenantId) ?? [];
  const stack = [...expandStack(db, pinned), companyLayer(db, tenantId)];
  return resolveTemplate(stack);
}

/** Effective active capabilities for a tenant (fast helper for UI/nav gating). */
export function tenantCapabilities(db: Db, tenantId: string): CapabilityId[] {
  return resolveTenantConfig(db, tenantId).activeCapabilities;
}

/** Preview the diff between a tenant's current config and a proposed binding. */
export function previewBinding(
  db: Db,
  tenantId: string,
  proposed: Array<{ templateId: string; version?: number }>,
) {
  const before = resolveTenantConfig(db, tenantId);
  const stack = [...expandStack(db, proposed), companyLayer(db, tenantId)];
  const after = resolveTemplate(stack);
  return {
    diff: diffResolved(before, after),
    issues: validateResolved(after),
    activeCapabilities: after.activeCapabilities,
  };
}

/** List published template layers (optionally by kind) for admin/onboarding UIs. */
export function listTemplateLayers(db: Db, opts: { kind?: LayerKind } = {}) {
  const conds = [eq(templateLayers.status, 'published')];
  if (opts.kind) conds.push(eq(templateLayers.kind, opts.kind));
  return db
    .select({
      templateId: templateLayers.templateId,
      kind: templateLayers.kind,
      version: templateLayers.version,
      labelKey: templateLayers.labelKey,
      extendsId: templateLayers.extendsId,
    })
    .from(templateLayers)
    .where(and(...conds))
    .all();
}

/** Load several published layer definitions at once (seed/verification helper). */
export function loadPublishedLayers(db: Db, templateIds: string[]): TemplateLayer[] {
  if (templateIds.length === 0) return [];
  return db
    .select()
    .from(templateLayers)
    .where(and(inArray(templateLayers.templateId, templateIds), eq(templateLayers.status, 'published')))
    .all()
    .map((r) => r.definition as TemplateLayer);
}
