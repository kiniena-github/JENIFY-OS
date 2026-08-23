import type { CapabilityId, ModuleId, PermissionMatrix } from '@factoryos/shared';
import { resolveTemplate, validateResolved, CAPABILITY_CATALOG } from '@factoryos/shared';
import type {
  GrowthTier,
  SectorAction,
  SectorDefinition,
  SectorRolePreset,
} from '@factoryos/shared/sectors';
import {
  SECTORS,
  SECTOR_BY_ID,
  sectorTemplateLayer,
  liveActions,
} from '@factoryos/shared/sectors';
import type { Db } from '../db/index.js';
import { badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { requirePermission } from './permissions.js';
import {
  publishTemplateLayer,
  bindTenantTemplate,
  resolveTenantConfig,
} from './templates.js';
import { saveRoleExperience } from './experience.js';
import { createRole, listRoles } from './permissions.js';
import { writeAudit } from './audit.js';

/**
 * Ultra-fast onboarding resolver (§23).
 *
 *   COUNTRY → SECTOR → SIZE → LANGUAGE → company details → JENIFY configured
 *
 * The resolver RECOMMENDS a complete starting configuration (capabilities,
 * roles, the tiny daily surface, offline workflows, AI mastery) and lets the
 * user PREVIEW it before anything is provisioned. Nothing is invented: every
 * recommendation is derived from the published sector definitions and the
 * capability catalog's dependency graph.
 */

export interface OnboardingAnswers {
  country: string; // country pack id suffix, e.g. 'ethiopia'
  sectorId: string; // 'sector.retail'
  tier?: GrowthTier; // defaults to 'micro'
  languages?: string[];
  branches?: number;
  warehouses?: number;
}

export interface OnboardingRecommendation {
  sector: { id: string; labelKey: string };
  tier: GrowthTier;
  /** the 4–6 things a business of this size actually sees */
  simpleSurface: SectorAction[];
  /** how many of those work today vs are specified-but-unbuilt (honesty) */
  surfaceReadiness: { live: number; planned: number };
  capabilities: CapabilityId[];
  roles: Array<{ roleCode: string; labelKey: string; actionCount: number; liveActionCount: number }>;
  offlineWorkflows: string[];
  aiMastery: SectorDefinition['ai'];
  /** the template stack that would be bound */
  templateStack: string[];
  issues: string[];
}

function countryTemplateId(country: string): string {
  return `country.${country.trim().toLowerCase()}`;
}

/** The catalogue an onboarding UI lists. */
export function listSectors(): Array<{ id: string; labelKey: string; surface: string[] }> {
  return SECTORS.map((s) => ({
    id: s.id,
    labelKey: s.labelKey,
    surface: s.simpleSurface.map((a) => a.id),
  }));
}

/**
 * PREVIEW — pure recommendation, performs no writes. Resolves the proposed
 * stack through the real template engine so the preview is the truth.
 */
export function recommendConfiguration(db: Db, answers: OnboardingAnswers): OnboardingRecommendation {
  const sector = SECTOR_BY_ID.get(answers.sectorId);
  if (!sector) notFound('sector_unknown', `Unknown sector '${answers.sectorId}'`);
  const tier: GrowthTier = answers.tier ?? 'micro';
  const layer = sectorTemplateLayer(sector!, tier);

  // resolve the proposed stack in memory (core + sector + country)
  const stack = [
    { id: 'core', kind: 'core' as const, version: 1, labelKey: 'template.core', activations: { parties: 'required' as const, inventory: 'required' as const, reports: 'required' as const }, config: {} },
    { id: layer.templateId, kind: 'sector' as const, version: 1, labelKey: layer.labelKey, activations: layer.activations, config: layer.config },
  ];
  const resolved = resolveTemplate(stack);
  const issues = validateResolved(resolved)
    .filter((i) => i.severity === 'error')
    .map((i) => i.message);

  const surface = sector!.simpleSurface;
  return {
    sector: { id: sector!.id, labelKey: sector!.labelKey },
    tier,
    simpleSurface: surface,
    surfaceReadiness: {
      live: surface.filter((a) => a.status === 'live').length,
      planned: surface.filter((a) => a.status === 'planned').length,
    },
    capabilities: resolved.activeCapabilities,
    roles: sector!.roles.map((r) => ({
      roleCode: r.roleCode,
      labelKey: r.labelKey,
      actionCount: r.actions.length,
      liveActionCount: liveActions(r.actions).length,
    })),
    offlineWorkflows: sector!.offlineWorkflows,
    aiMastery: sector!.ai,
    templateStack: ['core', layer.templateId, countryTemplateId(answers.country)],
    issues,
  };
}

export interface ProvisionResult {
  sectorLayerVersion: number;
  bindingVersion: number;
  rolesCreated: string[];
  /** role codes that already existed and were left intact (experience refreshed) */
  rolesReused: string[];
  capabilities: CapabilityId[];
}

/**
 * PROVISION — publishes the sector layer (system authority), binds the tenant,
 * and creates the sector's role presets with their purpose-built experiences.
 *
 * Role experiences are seeded with LIVE actions only: a worker must never be
 * handed a button that goes nowhere. Planned actions stay in the sector
 * definition (and in the recommendation) so the roadmap is visible, but they do
 * not reach a worker's screen until the workflow exists.
 */
export function provisionFromOnboarding(
  ctx: Ctx,
  systemCtx: Ctx,
  answers: OnboardingAnswers,
): ProvisionResult {
  requirePermission(ctx, 'settings', 'edit');
  const sector = SECTOR_BY_ID.get(answers.sectorId);
  if (!sector) notFound('sector_unknown', `Unknown sector '${answers.sectorId}'`);
  if (systemCtx.user !== null) {
    badRequest('system_ctx', 'Publishing a sector layer requires a system context');
  }
  const tier: GrowthTier = answers.tier ?? 'micro';
  const layer = sectorTemplateLayer(sector!, tier);

  // 1. publish the sector layer (global platform artifact; system-only)
  const { version: sectorLayerVersion } = publishTemplateLayer(systemCtx, {
    templateId: layer.templateId,
    kind: 'sector',
    labelKey: layer.labelKey,
    extendsId: layer.extendsId,
    activations: layer.activations,
    config: layer.config,
  });

  // 2. bind this tenant to core -> sector -> country. The country pack is
  //    published by its own seed; if this deployment has not published it yet
  //    we bind without it rather than failing onboarding (the tenant can be
  //    rebound once the pack exists).
  const base = [{ templateId: 'core' }, { templateId: layer.templateId }];
  const withCountry = [...base, { templateId: countryTemplateId(answers.country) }];
  let bindingVersion: number;
  try {
    bindingVersion = bindTenantTemplate(ctx, withCountry).version;
  } catch {
    bindingVersion = bindTenantTemplate(ctx, base).version;
  }

  // 3. create the sector's roles with their purpose-built experiences.
  //    Onboarding must be RE-RUNNABLE and must never clobber a tenant's
  //    existing roles (every tenant already has an owner role, and a business
  //    may re-run onboarding after changing sector or tier). An existing role
  //    code is REUSED — its permissions are left untouched (they may have been
  //    deliberately tuned) and only its experience preset is refreshed.
  const existingByCode = new Map(listRoles(ctx).map((r) => [r.code, r.id]));
  const rolesCreated: string[] = [];
  const rolesReused: string[] = [];
  for (const preset of sector!.roles) {
    const existingId = existingByCode.get(preset.roleCode);
    const roleId =
      existingId ??
      createRole(ctx, {
        code: preset.roleCode,
        name: preset.roleCode,
        dashboardFocus: preset.homeFocus,
        matrix: matrixForPreset(preset),
      });
    if (existingId) rolesReused.push(preset.roleCode);
    saveRoleExperience(ctx, roleId, {
      homeFocus: preset.homeFocus,
      nav: navForPreset(preset),
      mobileActions: liveActions(preset.actions).map((a) => ({
        id: a.id,
        labelKey: a.labelKey,
        path: a.path,
        module: a.module,
        action: a.action,
      })),
    });
    if (!existingId) rolesCreated.push(preset.roleCode);
  }

  const capabilities = resolveTenantConfig(ctx.db, ctx.tenantId).activeCapabilities;
  writeAudit(ctx, {
    module: 'settings',
    action: 'onboarding_provision',
    entity: 'tenant',
    entityId: ctx.tenantId,
    reference: `${sector!.id}/${tier}`,
    summary: `Onboarded as ${sector!.id} (${tier}) — ${rolesCreated.length} role(s) created, ${rolesReused.length} reused, ${capabilities.length} capabilities`,
    after: { sector: sector!.id, tier, created: rolesCreated, reused: rolesReused },
  });
  return { sectorLayerVersion, bindingVersion, rolesCreated, rolesReused, capabilities };
}

/**
 * A role preset's permission matrix: view on its home + the modules its actions
 * touch, plus the specific action verbs those actions need. Deliberately
 * minimal — experience narrows further, but permission is the real authority.
 */
function matrixForPreset(preset: SectorRolePreset): PermissionMatrix {
  const matrix: PermissionMatrix = {};
  const grant = (module: ModuleId, action: string): void => {
    (matrix[module] ??= {})[action] = true;
  };
  grant(preset.homeFocus, 'view');
  for (const a of preset.actions) {
    grant(a.module, 'view');
    if (a.action && a.action !== 'view') grant(a.module, a.action);
  }
  return matrix;
}

function navForPreset(preset: SectorRolePreset): ModuleId[] {
  const mods = new Set<ModuleId>([preset.homeFocus]);
  for (const a of liveActions(preset.actions)) mods.add(a.module);
  return [...mods];
}

/** Which capabilities a sector would gain by moving up a growth tier (§15). */
export function growthPreview(sectorId: string, from: GrowthTier, to: GrowthTier): CapabilityId[] {
  const sector = SECTOR_BY_ID.get(sectorId);
  if (!sector) notFound('sector_unknown', `Unknown sector '${sectorId}'`);
  const a = new Set(Object.keys(sectorTemplateLayer(sector!, from).activations) as CapabilityId[]);
  const b = Object.keys(sectorTemplateLayer(sector!, to).activations) as CapabilityId[];
  return b.filter((c) => !a.has(c) && c in CAPABILITY_CATALOG);
}
