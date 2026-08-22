import { beforeEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_CATALOG,
  resolveTemplate,
  validateResolved,
  diffResolved,
  type TemplateLayer,
} from '@factoryos/shared';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import {
  publishTemplateLayer,
  bindTenantTemplate,
  resolveTenantConfig,
  tenantCapabilities,
  previewBinding,
  activeBinding,
} from '../src/services/templates.js';
import { saveSettings } from '../src/services/settings.js';
import {
  STANDARD_TEMPLATE_LAYERS,
  MESOB_TEMPLATE_STACK,
} from '@factoryos/config-mesob/template-layers';

let db: Db;
let tt: TestTenant;

function publishStandard(): void {
  for (const layer of STANDARD_TEMPLATE_LAYERS) publishTemplateLayer(tt.sysCtx, layer);
}

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'TPL');
});

describe('pure resolution algebra (shared)', () => {
  it('later layers override earlier and record provenance', () => {
    const layers: TemplateLayer[] = [
      { id: 'core', kind: 'core', version: 1, labelKey: 'x', activations: { inventory: 'required' }, config: { core: { currency: 'USD' } } },
      { id: 'country.et', kind: 'country', version: 1, labelKey: 'x', activations: {}, config: { core: { currency: 'ETB' } } },
    ];
    const r = resolveTemplate(layers);
    expect(r.config.core!.currency).toEqual({ value: 'ETB', source: 'country.et', sourceKind: 'country' });
    expect(r.activeCapabilities).toContain('inventory');
  });

  it('activating a capability pulls in its dependency closure', () => {
    // sales depends on parties + inventory (per catalog)
    const r = resolveTemplate([
      { id: 'core', kind: 'core', version: 1, labelKey: 'x', activations: { sales: 'required' }, config: {} },
    ]);
    expect(r.activeCapabilities).toEqual(expect.arrayContaining(['sales', 'parties', 'inventory']));
    expect(CAPABILITY_CATALOG.sales.dependsOn).toContain('parties');
  });

  it('an incompatible capability is never activated, and the conflict is recorded', () => {
    const r = resolveTemplate([
      { id: 'a', kind: 'core', version: 1, labelKey: 'x', activations: { credit: 'required', payments: 'incompatible' }, config: {} },
    ]);
    // credit is active but payments was explicitly blocked
    expect(r.activeCapabilities).not.toContain('payments');
    // credit depends on payments (via sales→... no) — check a real dependency:
    // sales depends on parties+inventory; make inventory incompatible while sales required
    const r2 = resolveTemplate([
      { id: 'b', kind: 'core', version: 1, labelKey: 'x', activations: { sales: 'required', inventory: 'incompatible' }, config: {} },
    ]);
    expect(r2.activeCapabilities).not.toContain('inventory');
    // the blocked dependency is surfaced, not silently dropped
    expect(r2.conflicts.some((c) => c.capability === 'inventory')).toBe(true);
  });

  it('validateResolved flags a missing dependency', () => {
    // hand-craft an inconsistent resolution: sales active without inventory
    const bad = {
      activeCapabilities: ['sales', 'parties'] as never,
      activations: { sales: 'required' } as never,
      config: {},
      conflicts: [],
    };
    const issues = validateResolved(bad);
    expect(issues.some((i) => i.code === 'missing_dependency')).toBe(true);
  });
});

describe('immutable publishing', () => {
  it('re-publishing a template makes a new version and supersedes the old', () => {
    publishTemplateLayer(tt.sysCtx, { templateId: 'sector.x', kind: 'sector', labelKey: 'x', activations: { sales: 'required' } });
    const second = publishTemplateLayer(tt.sysCtx, { templateId: 'sector.x', kind: 'sector', labelKey: 'x', activations: { sales: 'required', credit: 'required' } });
    expect(second.version).toBe(2);
    // binding resolves the newest published version
    bindTenantTemplate(tt.sysCtx, [{ templateId: 'sector.x' }]);
    expect(tenantCapabilities(db, tt.tenantId)).toContain('credit');
  });
});

describe('Mesob formalized as Core+Manufacturing+Process+Salt+Ethiopia', () => {
  beforeEach(() => {
    publishStandard();
    bindTenantTemplate(tt.sysCtx, MESOB_TEMPLATE_STACK);
  });

  it('resolves the expected active capabilities for a salt factory', () => {
    const caps = tenantCapabilities(db, tt.tenantId);
    // required/recommended across the salt stack + dependency closure
    expect(caps).toEqual(
      expect.arrayContaining(['parties', 'inventory', 'warehouses', 'production', 'quality', 'traceability', 'sales', 'payments']),
    );
  });

  it('resolves Ethiopia country config (currency, timezone, calendar, languages)', () => {
    const r = resolveTenantConfig(db, tt.tenantId);
    expect(r.config.core!.defaultCurrency!.value).toBe('ETB');
    expect(r.config.core!.defaultTimezone!.value).toBe('Africa/Addis_Ababa');
    expect(r.config.core!.calendar!.value).toBe('ethiopian');
    expect(r.config.core!.defaultLanguages!.value).toEqual(['en', 'am', 'ti']);
    // provenance points at the Ethiopia layer, not core
    expect(r.config.core!.defaultCurrency!.source).toBe('country.ethiopia');
  });

  it('carries salt process physics from the subsector layer', () => {
    const r = resolveTenantConfig(db, tt.tenantId);
    expect(r.config.production!.model!.value).toBe('process');
    expect(r.config.production!.conservedStages!.value).toEqual(['iodization']);
    expect(r.config.production!.iodineIsInventory!.value).toBe(false);
    expect(r.config.production!.qcReleaseGate!.value).toBe(true);
  });

  it('resolves cleanly with no validation errors', () => {
    const r = resolveTenantConfig(db, tt.tenantId);
    expect(validateResolved(r).filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

describe('Ethiopia is NOT hard-coded — dummy country pack proves it', () => {
  it('swapping Ethiopia for Testland changes only country-layer values', () => {
    publishStandard();
    // same stack, Testland instead of Ethiopia
    const testlandStack = MESOB_TEMPLATE_STACK.map((l) =>
      l.templateId === 'country.ethiopia' ? { templateId: 'country.testland' } : l,
    );
    bindTenantTemplate(tt.sysCtx, testlandStack);
    const r = resolveTenantConfig(db, tt.tenantId);
    expect(r.config.core!.defaultCurrency!.value).toBe('TST'); // NOT ETB
    expect(r.config.core!.defaultTimezone!.value).toBe('UTC'); // NOT Addis
    expect(r.config.core!.calendar!.value).toBe('gregorian'); // NOT ethiopian
    expect(r.config.core!.defaultLanguages!.value).toEqual(['en']);
    // the salt physics (sector/subsector) are unchanged — country-independent
    expect(r.config.production!.conservedStages!.value).toEqual(['iodization']);
  });
});

describe('company settings layer in at highest precedence (as domain blobs)', () => {
  it('a tenant settings domain appears in the resolved config with company provenance', () => {
    publishStandard();
    bindTenantTemplate(tt.sysCtx, MESOB_TEMPLATE_STACK);
    saveSettings(tt.ownerCtx, 'general', { defaultCurrency: 'ETB', companyName: 'Mesob' });
    const r = resolveTenantConfig(db, tt.tenantId);
    // the 'general' settings domain is layered in as a company blob under core.
    // NOTE (architect H2): this is a domain blob, NOT a key-level override of the
    // template's semantic core.defaultCurrency — key-level override is a tracked
    // follow-up. Assert what the substrate actually guarantees today.
    expect(r.config.core!.general!.sourceKind).toBe('company');
    expect((r.config.core!.general!.value as { companyName: string }).companyName).toBe('Mesob');
    // the template's semantic Ethiopia value is still present and unshadowed
    expect(r.config.core!.defaultCurrency!.value).toBe('ETB');
    expect(r.config.core!.defaultCurrency!.sourceKind).toBe('country');
  });
});

describe('preview + diff before binding', () => {
  it('previews the capability + config delta of a proposed binding', () => {
    publishStandard();
    bindTenantTemplate(tt.sysCtx, [{ templateId: 'core' }]);
    const preview = previewBinding(db, tt.tenantId, MESOB_TEMPLATE_STACK);
    expect(preview.activeCapabilities).toContain('production');
    expect(preview.diff.capabilities.added).toContain('production');
    expect(preview.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('diffResolved reports added/removed capabilities', () => {
    const before = resolveTemplate([{ id: 'core', kind: 'core', version: 1, labelKey: 'x', activations: { inventory: 'required' }, config: {} }]);
    const after = resolveTemplate([{ id: 'core', kind: 'core', version: 1, labelKey: 'x', activations: { inventory: 'required', production: 'required' }, config: {} }]);
    const d = diffResolved(before, after);
    expect(d.capabilities.added).toContain('production');
  });
});

describe('publish authority (architect H1)', () => {
  it('a tenant user (even owner) cannot publish a GLOBAL template layer', () => {
    expect(() =>
      publishTemplateLayer(tt.ownerCtx, { templateId: 'sector.evil', kind: 'sector', labelKey: 'x', activations: {} }),
    ).toThrowError(/platform/);
  });

  it('a non-owner cannot rebind the tenant template', () => {
    publishStandard();
    const staffRole = createRole(tt.sysCtx, { code: 'staff2', name: 'Staff', matrix: matrixOf([['settings', ['view', 'edit']]]) });
    const staffId = createUser(tt.sysCtx, { username: 'staff2', displayName: 'Staff', password: 'test-password', roleId: staffRole });
    const staffCtx = { db, tenantId: tt.tenantId, user: buildSessionUser(db, staffId)! };
    expect(() => bindTenantTemplate(staffCtx, [{ templateId: 'core' }])).toThrowError(/owner/);
  });
});

describe('binding validation', () => {
  it('rejects a binding that does not resolve cleanly', () => {
    // publish a broken layer that activates quality without production, and
    // explicitly marks production incompatible so the closure cannot repair it
    publishTemplateLayer(tt.sysCtx, {
      templateId: 'broken',
      kind: 'sector',
      labelKey: 'x',
      activations: { quality: 'required', production: 'incompatible' },
    });
    expect(() => bindTenantTemplate(tt.sysCtx, [{ templateId: 'broken' }])).toThrowError(/does not resolve cleanly/);
    expect(activeBinding(db, tt.tenantId)).toBeNull();
  });
});
