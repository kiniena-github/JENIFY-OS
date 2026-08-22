// JENIFY template & capability platform vocabulary.
// Pure, deterministic, tenant-agnostic — NOTHING here references a specific
// tenant, sector instance, or country. Persistence + tenant binding live in
// the server; this module is the shared contract and the resolution algebra.

import type { ModuleId } from './index.js';

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

/**
 * Stable capability IDs. A capability is a reusable unit of business function.
 * Templates ACTIVATE and CONFIGURE capabilities; they never fork product code.
 * IDs are permanent contract — never rename one (deprecate + add instead).
 */
export const CAPABILITIES = [
  'parties',
  'customers',
  'suppliers',
  'inventory',
  'warehouses',
  'sales',
  'invoicing',
  'credit',
  'payments',
  'delivery',
  'procurement',
  'production',
  'quality',
  'traceability',
  'projects',
  'workforce',
  'assets',
  'maintenance',
  'reports',
  'approvals',
  'documents',
  'ai',
  'migration',
] as const;
export type CapabilityId = (typeof CAPABILITIES)[number];

/** How a template treats a capability. */
export const ACTIVATION_MODES = ['required', 'recommended', 'optional', 'incompatible'] as const;
export type ActivationMode = (typeof ACTIVATION_MODES)[number];

export interface CapabilityDef {
  id: CapabilityId;
  /** translation key for the display name; never a hard-coded label */
  labelKey: string;
  /** platform modules this capability draws on (for permission/nav mapping) */
  modules: ModuleId[];
  /** capabilities that must also be active for this one to function */
  dependsOn: CapabilityId[];
  category: 'foundation' | 'commercial' | 'operations' | 'people' | 'platform';
}

/**
 * The platform capability catalog. This is the single source of truth for what
 * JENIFY can do; sector templates choose from it. Dependencies are enforced at
 * resolution time (activating `sales` implies `parties`, `inventory`, etc.).
 */
export const CAPABILITY_CATALOG: Record<CapabilityId, CapabilityDef> = {
  parties: { id: 'parties', labelKey: 'cap.parties', modules: ['parties'], dependsOn: [], category: 'foundation' },
  customers: { id: 'customers', labelKey: 'cap.customers', modules: ['parties'], dependsOn: ['parties'], category: 'foundation' },
  suppliers: { id: 'suppliers', labelKey: 'cap.suppliers', modules: ['parties'], dependsOn: ['parties'], category: 'foundation' },
  inventory: { id: 'inventory', labelKey: 'cap.inventory', modules: ['inventory'], dependsOn: [], category: 'foundation' },
  warehouses: { id: 'warehouses', labelKey: 'cap.warehouses', modules: ['inventory'], dependsOn: ['inventory'], category: 'foundation' },
  sales: { id: 'sales', labelKey: 'cap.sales', modules: ['sales'], dependsOn: ['parties', 'inventory'], category: 'commercial' },
  invoicing: { id: 'invoicing', labelKey: 'cap.invoicing', modules: ['sales'], dependsOn: ['sales'], category: 'commercial' },
  credit: { id: 'credit', labelKey: 'cap.credit', modules: ['credit'], dependsOn: ['sales', 'customers'], category: 'commercial' },
  payments: { id: 'payments', labelKey: 'cap.payments', modules: ['payments'], dependsOn: ['parties'], category: 'commercial' },
  delivery: { id: 'delivery', labelKey: 'cap.delivery', modules: ['delivery'], dependsOn: ['sales', 'inventory'], category: 'operations' },
  procurement: { id: 'procurement', labelKey: 'cap.procurement', modules: ['inventory', 'parties'], dependsOn: ['suppliers', 'inventory'], category: 'operations' },
  production: { id: 'production', labelKey: 'cap.production', modules: ['production'], dependsOn: ['inventory'], category: 'operations' },
  quality: { id: 'quality', labelKey: 'cap.quality', modules: ['quality'], dependsOn: ['production'], category: 'operations' },
  traceability: { id: 'traceability', labelKey: 'cap.traceability', modules: ['inventory', 'production'], dependsOn: ['inventory'], category: 'operations' },
  projects: { id: 'projects', labelKey: 'cap.projects', modules: ['reports'], dependsOn: ['parties'], category: 'operations' },
  workforce: { id: 'workforce', labelKey: 'cap.workforce', modules: ['users'], dependsOn: [], category: 'people' },
  assets: { id: 'assets', labelKey: 'cap.assets', modules: ['inventory'], dependsOn: [], category: 'operations' },
  maintenance: { id: 'maintenance', labelKey: 'cap.maintenance', modules: ['production'], dependsOn: ['assets'], category: 'operations' },
  reports: { id: 'reports', labelKey: 'cap.reports', modules: ['reports'], dependsOn: [], category: 'platform' },
  approvals: { id: 'approvals', labelKey: 'cap.approvals', modules: ['settings'], dependsOn: [], category: 'platform' },
  documents: { id: 'documents', labelKey: 'cap.documents', modules: ['reports'], dependsOn: [], category: 'platform' },
  ai: { id: 'ai', labelKey: 'cap.ai', modules: ['dashboard'], dependsOn: [], category: 'platform' },
  migration: { id: 'migration', labelKey: 'cap.migration', modules: ['settings'], dependsOn: [], category: 'platform' },
};

// ---------------------------------------------------------------------------
// Template layers
// ---------------------------------------------------------------------------

/**
 * Layer kinds, in deterministic resolution order (lowest precedence first).
 * A later layer overrides an earlier one; provenance records which layer won.
 *   core        platform defaults (implicit, always present)
 *   capability  a capability's own default config
 *   sector      e.g. Manufacturing
 *   subsector   e.g. Process Manufacturing / Salt
 *   country     e.g. Ethiopia pack
 *   company     the individual tenant's overrides
 */
export const LAYER_KINDS = ['core', 'capability', 'sector', 'subsector', 'country', 'company'] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

export const LAYER_RANK: Record<LayerKind, number> = {
  core: 0,
  capability: 1,
  sector: 2,
  subsector: 3,
  country: 4,
  company: 5,
};

/** A namespaced configuration value. Namespace is a CapabilityId or 'core'. */
export type ConfigNamespace = CapabilityId | 'core';

/**
 * One template layer. `activations` sets how capabilities are treated;
 * `config` supplies namespaced defaults. Published layers are immutable; a new
 * version is a new record. `extends` names the parent template id it builds on
 * (resolved by the caller into an ordered layer list).
 */
export interface TemplateLayer {
  id: string; // stable template id, e.g. 'sector.manufacturing'
  kind: LayerKind;
  version: number;
  labelKey: string;
  extends?: string | null;
  activations: Partial<Record<CapabilityId, ActivationMode>>;
  config: Partial<Record<ConfigNamespace, Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedValue {
  value: unknown;
  /** template id of the layer that supplied the winning value */
  source: string;
  sourceKind: LayerKind;
}

export interface ResolvedConfig {
  /** capabilities that are ON for this resolution (required or opted-in), dependency-closed */
  activeCapabilities: CapabilityId[];
  /** final activation mode per capability after all layers */
  activations: Partial<Record<CapabilityId, ActivationMode>>;
  /** resolved namespaced config with provenance: config[ns][key] = ResolvedValue */
  config: Partial<Record<ConfigNamespace, Record<string, ResolvedValue>>>;
  /** capabilities requested but blocked because a layer marked them incompatible */
  conflicts: Array<{ capability: CapabilityId; incompatibleFrom: string }>;
}

/**
 * Deterministically resolve an ordered layer stack into an effective config.
 * Order MUST be lowest-precedence first (core → … → company). Callers assemble
 * the stack (expanding `extends` and capability defaults) before calling.
 *
 * Determinism: layers are applied in the given order; within equal input the
 * output is identical. No clock, no randomness, no external reads.
 */
export function resolveTemplate(layers: TemplateLayer[]): ResolvedConfig {
  const activations: Partial<Record<CapabilityId, ActivationMode>> = {};
  const config: Partial<Record<ConfigNamespace, Record<string, ResolvedValue>>> = {};

  for (const layer of layers) {
    for (const [cap, mode] of Object.entries(layer.activations) as Array<[CapabilityId, ActivationMode]>) {
      activations[cap] = mode; // later layer wins
    }
    for (const [ns, kv] of Object.entries(layer.config) as Array<[ConfigNamespace, Record<string, unknown>]>) {
      const bucket = (config[ns] ??= {});
      for (const [key, value] of Object.entries(kv)) {
        bucket[key] = { value, source: layer.id, sourceKind: layer.kind };
      }
    }
  }

  // capabilities explicitly required or opted-in (recommended/optional that a
  // later layer did not turn off); 'incompatible' blocks activation entirely
  const conflicts: ResolvedConfig['conflicts'] = [];
  const requested = new Set<CapabilityId>();
  for (const [cap, mode] of Object.entries(activations) as Array<[CapabilityId, ActivationMode]>) {
    if (mode === 'required' || mode === 'recommended' || mode === 'optional') requested.add(cap);
  }

  // dependency closure: activating a capability pulls in its dependencies.
  // If a dependency is marked incompatible, the dependent cannot be satisfied —
  // record that as a real conflict rather than silently skipping it.
  const active = new Set<CapabilityId>();
  const visit = (cap: CapabilityId, requiredBy?: CapabilityId): void => {
    if (active.has(cap)) return;
    if (activations[cap] === 'incompatible') {
      // a dependency of an active capability was blocked — surface it
      if (requiredBy) conflicts.push({ capability: cap, incompatibleFrom: requiredBy });
      return;
    }
    active.add(cap);
    for (const dep of CAPABILITY_CATALOG[cap].dependsOn) visit(dep, cap);
  };
  for (const cap of requested) {
    if (activations[cap] === 'incompatible') {
      conflicts.push({ capability: cap, incompatibleFrom: 'requested-but-incompatible' });
      continue;
    }
    visit(cap);
  }

  return {
    activeCapabilities: [...active].sort(),
    activations,
    config,
    conflicts,
  };
}

/** Flatten a resolved config's values (dropping provenance) for a namespace. */
export function configValues(
  resolved: ResolvedConfig,
  ns: ConfigNamespace,
): Record<string, unknown> {
  const bucket = resolved.config[ns] ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bucket)) out[k] = v.value;
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface TemplateValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/**
 * Validate a resolved config against the catalog:
 *  - every active capability's dependencies are also active (error);
 *  - no active capability was also marked incompatible (error);
 *  - config namespaces reference known capabilities (warning).
 * Pure and deterministic.
 */
export function validateResolved(resolved: ResolvedConfig): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const active = new Set(resolved.activeCapabilities);
  for (const cap of resolved.activeCapabilities) {
    for (const dep of CAPABILITY_CATALOG[cap].dependsOn) {
      if (!active.has(dep)) {
        issues.push({
          severity: 'error',
          code: 'missing_dependency',
          message: `Capability '${cap}' requires '${dep}', which is not active`,
        });
      }
    }
    if (resolved.activations[cap] === 'incompatible') {
      issues.push({
        severity: 'error',
        code: 'active_incompatible',
        message: `Capability '${cap}' is active but marked incompatible`,
      });
    }
  }
  for (const ns of Object.keys(resolved.config) as ConfigNamespace[]) {
    if (ns !== 'core' && !(ns in CAPABILITY_CATALOG)) {
      issues.push({
        severity: 'warning',
        code: 'unknown_namespace',
        message: `Config namespace '${ns}' is not a known capability`,
      });
    }
  }
  return issues;
}

/** Diff two resolved configs (e.g. preview a template upgrade). Deterministic. */
export interface ConfigDiffEntry {
  namespace: ConfigNamespace;
  key: string;
  before: unknown;
  after: unknown;
  change: 'added' | 'removed' | 'changed';
}

export function diffResolved(before: ResolvedConfig, after: ResolvedConfig): {
  capabilities: { added: CapabilityId[]; removed: CapabilityId[] };
  config: ConfigDiffEntry[];
} {
  const beforeCaps = new Set(before.activeCapabilities);
  const afterCaps = new Set(after.activeCapabilities);
  const config: ConfigDiffEntry[] = [];
  const namespaces = new Set<ConfigNamespace>([
    ...(Object.keys(before.config) as ConfigNamespace[]),
    ...(Object.keys(after.config) as ConfigNamespace[]),
  ]);
  for (const ns of namespaces) {
    const b = before.config[ns] ?? {};
    const a = after.config[ns] ?? {};
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const key of keys) {
      const bv = b[key]?.value;
      const av = a[key]?.value;
      const inB = key in b;
      const inA = key in a;
      if (inB && !inA) config.push({ namespace: ns, key, before: bv, after: undefined, change: 'removed' });
      else if (!inB && inA) config.push({ namespace: ns, key, before: undefined, after: av, change: 'added' });
      else if (JSON.stringify(bv) !== JSON.stringify(av))
        config.push({ namespace: ns, key, before: bv, after: av, change: 'changed' });
    }
  }
  config.sort((x, y) => x.namespace.localeCompare(y.namespace) || x.key.localeCompare(y.key));
  return {
    capabilities: {
      added: [...afterCaps].filter((c) => !beforeCaps.has(c)).sort(),
      removed: [...beforeCaps].filter((c) => !afterCaps.has(c)).sort(),
    },
    config,
  };
}
