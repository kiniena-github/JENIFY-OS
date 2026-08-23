import { beforeEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_CATALOG,
  resolveTemplate,
  validateResolved,
  MODULES,
  type CapabilityId,
} from '@factoryos/shared';
import {
  SECTORS,
  SECTOR_BY_ID,
  sectorTemplateLayer,
  liveActions,
  type GrowthTier,
} from '@factoryos/shared/sectors';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { publishTemplateLayer, bindTenantTemplate, resolveTenantConfig } from '../src/services/templates.js';
import { recommendConfiguration, provisionFromOnboarding, listSectors, growthPreview } from '../src/services/onboarding.js';
import { effectiveExperience } from '../src/services/experience.js';
import { buildSessionUser } from '../src/services/auth.js';
import { createUser } from '../src/services/users.js';
import { listRoles } from '../src/services/permissions.js';
import { PLATFORM_KEYS } from '../src/i18n-keys.js';
import type { Ctx } from '../src/services/context.js';

let db: Db;
let tt: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'SEC');
});

const TIERS: GrowthTier[] = ['micro', 'small', 'medium', 'advanced', 'enterprise'];

// ---------------------------------------------------------------------------
// The 20 sector families — structural integrity
// ---------------------------------------------------------------------------
describe('sector catalogue', () => {
  it('defines exactly the 20 required sector families with unique ids', () => {
    expect(SECTORS).toHaveLength(20);
    expect(new Set(SECTORS.map((s) => s.id)).size).toBe(20);
    for (const s of SECTORS) expect(s.id.startsWith('sector.')).toBe(true);
  });

  it('every sector shows a MICRO business only 4-6 daily actions (progressive complexity)', () => {
    for (const s of SECTORS) {
      expect(s.simpleSurface.length, `${s.id} surface`).toBeGreaterThanOrEqual(4);
      expect(s.simpleSurface.length, `${s.id} surface`).toBeLessThanOrEqual(6);
    }
  });

  it('every activation and growth capability is a real catalogue capability', () => {
    for (const s of SECTORS) {
      for (const cap of Object.keys(s.baseActivations) as CapabilityId[]) {
        expect(CAPABILITY_CATALOG[cap], `${s.id}: ${cap}`).toBeDefined();
      }
      for (const step of s.growth) {
        for (const cap of step.adds) expect(CAPABILITY_CATALOG[cap], `${s.id}: ${cap}`).toBeDefined();
      }
    }
  });

  it('every sector action targets a real platform module', () => {
    for (const s of SECTORS) {
      const all = [...s.simpleSurface, ...s.roles.flatMap((r) => r.actions)];
      for (const a of all) expect(MODULES.includes(a.module), `${s.id}: ${a.id} -> ${a.module}`).toBe(true);
    }
  });

  it('every sector defines role experiences — and NO role sees the whole template', () => {
    for (const s of SECTORS) {
      expect(s.roles.length, `${s.id} roles`).toBeGreaterThanOrEqual(3);
      for (const r of s.roles) {
        expect(r.actions.length, `${s.id}/${r.roleCode}`).toBeGreaterThan(0);
        // a role's surface must be materially smaller than the sector's full capability set
        expect(r.actions.length).toBeLessThanOrEqual(6);
      }
    }
  });

  it('every sector declares an AI mastery model INCLUDING explicit never-do limits', () => {
    for (const s of SECTORS) {
      expect(s.ai.understands.length, `${s.id}`).toBeGreaterThan(0);
      expect(s.ai.answers.length, `${s.id}`).toBeGreaterThan(0);
      expect(s.ai.neverDoes.length, `${s.id} neverDoes`).toBeGreaterThan(0);
    }
  });

  it('regulated sectors carry hard AI limits (healthcare administrative-only, government non-deciding)', () => {
    const health = SECTOR_BY_ID.get('sector.healthcare')!;
    expect(health.ai.neverDoes.join(' ').toLowerCase()).toContain('clinical');
    expect((health.config?.core as { scope?: string } | undefined)?.scope).toBe('administrative_only');
    const gov = SECTOR_BY_ID.get('sector.government')!;
    expect(gov.ai.neverDoes.join(' ').toLowerCase()).toContain('decide');
    const pharm = SECTOR_BY_ID.get('sector.pharmacy')!;
    expect(pharm.ai.neverDoes.join(' ').toLowerCase()).toMatch(/clinical|medical advice/);
  });

  it('every sector label and verb has a registered translation key (no hard-coded UI text)', () => {
    const keys = new Set(PLATFORM_KEYS.map((k) => k.key));
    for (const s of SECTORS) {
      expect(keys.has(s.labelKey), `missing i18n ${s.labelKey}`).toBe(true);
      for (const a of liveActions(s.simpleSurface)) {
        expect(keys.has(a.labelKey), `missing i18n ${a.labelKey}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Performance law (§18) — sector data must never reach the browser bundle
// ---------------------------------------------------------------------------
describe('client bundle protection', () => {
  it('the shared barrel does NOT re-export sector tables (they cost ~6 kB gzip in the client)', async () => {
    // Regression guard: re-exporting sectors from '@factoryos/shared' pushed the
    // web initial bundle 69.22 -> 74.88 kB gzip. Sector data is server-side.
    const barrel = await import('@factoryos/shared');
    expect('SECTORS' in barrel).toBe(false);
    expect('SECTOR_BY_ID' in barrel).toBe(false);
    expect('sectorTemplateLayer' in barrel).toBe(false);
  });

  it('sector data is reachable from its own subpath', async () => {
    const mod = await import('@factoryos/shared/sectors');
    expect(mod.SECTORS).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// Honesty contract (§41) — planned surfaces must never masquerade as finished
// ---------------------------------------------------------------------------
describe('honesty contract', () => {
  it('every action declares live|planned status', () => {
    for (const s of SECTORS) {
      for (const a of [...s.simpleSurface, ...s.roles.flatMap((r) => r.actions)]) {
        expect(['live', 'planned']).toContain(a.status);
      }
    }
  });

  it('liveActions() filters planned work out of worker surfaces', () => {
    const withPlanned = SECTORS.find((s) => s.roles.some((r) => r.actions.some((a) => a.status === 'planned')))!;
    const role = withPlanned.roles.find((r) => r.actions.some((a) => a.status === 'planned'))!;
    expect(liveActions(role.actions).every((a) => a.status === 'live')).toBe(true);
    expect(liveActions(role.actions).length).toBeLessThan(role.actions.length);
  });
});

// ---------------------------------------------------------------------------
// Real resolution through the engine — a sector is configuration, not a fork
// ---------------------------------------------------------------------------
describe('every sector resolves cleanly through the real template engine', () => {
  it('all 20 sectors resolve with zero validation errors at every growth tier', () => {
    for (const s of SECTORS) {
      for (const tier of TIERS) {
        const layer = sectorTemplateLayer(s, tier);
        const resolved = resolveTemplate([
          { id: 'core', kind: 'core', version: 1, labelKey: 'x', activations: { parties: 'required', inventory: 'required', reports: 'required' }, config: {} },
          { id: layer.templateId, kind: 'sector', version: 1, labelKey: layer.labelKey, activations: layer.activations, config: layer.config },
        ]);
        const errors = validateResolved(resolved).filter((i) => i.severity === 'error');
        expect(errors, `${s.id}@${tier}: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
      }
    }
  });

  it('growth tiers only ADD capabilities — a micro business never carries enterprise weight', () => {
    for (const s of SECTORS) {
      const micro = Object.keys(sectorTemplateLayer(s, 'micro').activations);
      const ent = Object.keys(sectorTemplateLayer(s, 'enterprise').activations);
      for (const cap of micro) expect(ent, `${s.id}`).toContain(cap);
      expect(ent.length, `${s.id} must grow`).toBeGreaterThanOrEqual(micro.length);
    }
  });

  it('a published sector layer binds to a real tenant and resolves its capabilities', () => {
    publishTemplateLayer(tt.sysCtx, { templateId: 'core', kind: 'core', labelKey: 'template.core', activations: { parties: 'required', inventory: 'required', reports: 'required' } });
    const layer = sectorTemplateLayer(SECTOR_BY_ID.get('sector.retail')!, 'small');
    publishTemplateLayer(tt.sysCtx, {
      templateId: layer.templateId, kind: 'sector', labelKey: layer.labelKey,
      extendsId: layer.extendsId, activations: layer.activations, config: layer.config,
    });
    bindTenantTemplate(tt.sysCtx, [{ templateId: 'core' }, { templateId: 'sector.retail' }]);
    const caps = resolveTenantConfig(db, tt.tenantId).activeCapabilities;
    expect(caps).toEqual(expect.arrayContaining(['sales', 'inventory', 'payments', 'parties']));
    // retail at 'small' has NOT unlocked enterprise-only capabilities
    expect(caps).not.toContain('timesheets');
  });
});

// ---------------------------------------------------------------------------
// Onboarding resolver (§23)
// ---------------------------------------------------------------------------
describe('onboarding resolver', () => {
  it('lists all 20 sectors for the wizard', () => {
    expect(listSectors()).toHaveLength(20);
  });

  it('recommends a complete configuration and reports surface readiness honestly', () => {
    const rec = recommendConfiguration(db, { country: 'ethiopia', sectorId: 'sector.retail', tier: 'micro' });
    expect(rec.sector.id).toBe('sector.retail');
    expect(rec.capabilities).toEqual(expect.arrayContaining(['sales', 'inventory']));
    expect(rec.roles.length).toBeGreaterThanOrEqual(3);
    expect(rec.issues).toHaveLength(0);
    // readiness is reported, not hidden
    expect(rec.surfaceReadiness.live + rec.surfaceReadiness.planned).toBe(rec.simpleSurface.length);
    expect(rec.templateStack).toContain('country.ethiopia');
    expect(rec.aiMastery.neverDoes.length).toBeGreaterThan(0);
  });

  it('recommendation performs NO writes (preview is safe)', () => {
    const before = listRoles(tt.ownerCtx).length;
    recommendConfiguration(db, { country: 'ethiopia', sectorId: 'sector.logistics' });
    expect(listRoles(tt.ownerCtx).length).toBe(before);
  });

  it('rejects an unknown sector', () => {
    expect(() => recommendConfiguration(db, { country: 'ethiopia', sectorId: 'sector.nope' })).toThrowError(/Unknown sector/);
  });

  it('growth preview shows exactly what a tier upgrade unlocks', () => {
    const adds = growthPreview('sector.retail', 'micro', 'medium');
    expect(adds.length).toBeGreaterThan(0);
    expect(adds).toEqual(expect.arrayContaining(['expiry']));
  });

  it('provisioning creates the sector roles with permission-bounded worker experiences', () => {
    publishTemplateLayer(tt.sysCtx, { templateId: 'core', kind: 'core', labelKey: 'template.core', activations: { parties: 'required', inventory: 'required', reports: 'required' } });
    const result = provisionFromOnboarding(tt.ownerCtx, tt.sysCtx, { country: 'ethiopia', sectorId: 'sector.retail', tier: 'micro' });
    expect(result.rolesCreated).toEqual(expect.arrayContaining(['cashier', 'stock_keeper']));
    expect(result.capabilities).toEqual(expect.arrayContaining(['sales', 'inventory']));

    // a cashier's resolved experience is tiny AND only contains permitted, LIVE actions
    const cashierRole = listRoles(tt.ownerCtx).find((r) => r.code === 'cashier')!;
    const uid = createUser(tt.sysCtx, { username: 'cash1', displayName: 'Cashier', password: 'test-password', roleId: cashierRole.id });
    const cashierCtx: Ctx = { db, tenantId: tt.tenantId, user: buildSessionUser(db, uid)! };
    const exp = effectiveExperience(cashierCtx);
    expect(exp.mobileActions.length).toBeGreaterThan(0);
    expect(exp.mobileActions.length).toBeLessThanOrEqual(5);
    // the cashier cannot see settings/users even though the tenant has them
    expect(exp.nav).not.toContain('settings');
    expect(exp.nav).not.toContain('users');
  });

  it('onboarding is RE-RUNNABLE and never clobbers an existing role', () => {
    publishTemplateLayer(tt.sysCtx, { templateId: 'core', kind: 'core', labelKey: 'template.core', activations: { parties: 'required', inventory: 'required', reports: 'required' } });
    const first = provisionFromOnboarding(tt.ownerCtx, tt.sysCtx, { country: 'ethiopia', sectorId: 'sector.retail', tier: 'micro' });
    // the tenant already had an 'owner' role — it must be reused, not duplicated
    expect(first.rolesReused).toContain('owner');
    const ownerRoleCount = listRoles(tt.ownerCtx).filter((r) => r.code === 'owner').length;
    expect(ownerRoleCount).toBe(1);
    // re-running (e.g. switching tier) must not throw and must not duplicate roles
    const second = provisionFromOnboarding(tt.ownerCtx, tt.sysCtx, { country: 'ethiopia', sectorId: 'sector.retail', tier: 'medium' });
    expect(second.rolesCreated).toHaveLength(0);
    expect(listRoles(tt.ownerCtx).filter((r) => r.code === 'cashier')).toHaveLength(1);
    // the owner role kept its original (full) permissions — not narrowed by a preset
    const owner = listRoles(tt.ownerCtx).find((r) => r.code === 'owner')!;
    expect(owner.matrix.settings?.edit).toBe(true);
  });

  it('provisioning refuses to publish a global layer from a tenant context', () => {
    expect(() =>
      provisionFromOnboarding(tt.ownerCtx, tt.ownerCtx, { country: 'ethiopia', sectorId: 'sector.retail' }),
    ).toThrowError(/system context/);
  });
});
