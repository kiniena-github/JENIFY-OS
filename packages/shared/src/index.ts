// FactoryOS shared platform vocabulary.
// Nothing in this package may reference a specific factory/tenant.

// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

/** Generic platform modules. Tenants relabel them via translations. */
export const MODULES = [
  'dashboard',
  'inventory',
  'production',
  'quality',
  'parties',
  'sales',
  'credit',
  'delivery',
  'payments',
  'reports',
  'users',
  'settings',
  'audit',
] as const;
export type ModuleId = (typeof MODULES)[number];

export const ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'export',
  'view_financial',
  'manage_users',
] as const;
export type ActionId = (typeof ACTIONS)[number];

/**
 * Module-specific fine-grained actions beyond the generic matrix.
 * Kept deliberately small — extend only where a workflow genuinely needs
 * an action narrower than view/create/edit/approve.
 */
export const EXTRA_ACTIONS: Partial<Record<ModuleId, readonly string[]>> = {
  delivery: ['load', 'dispatch'],
};

export type PermissionMatrix = Partial<Record<ModuleId, Partial<Record<string, boolean>>>>;

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

/**
 * Universal lifecycle for operational documents. Individual document kinds
 * add their own workflow states (e.g. delivery Loading/Dispatched) on top,
 * but posting/reversal semantics are uniform:
 *   draft  -> may be edited or discarded freely
 *   posted -> immutable business fact; only reverse/correct creates change
 */
export const DOC_LIFECYCLE = ['draft', 'posted', 'reversed', 'cancelled'] as const;
export type DocLifecycle = (typeof DOC_LIFECYCLE)[number];

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export const MOVEMENT_TYPES = [
  'receipt',
  'issue',
  'transfer_out',
  'transfer_in',
  'production_consume',
  'production_output',
  'sale_dispatch',
  'adjustment',
  'reversal',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const ITEM_KINDS = ['raw_material', 'finished_good', 'consumable', 'other'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Item tracking modes. `serial` is reserved for future discrete manufacturing. */
export const TRACKING_MODES = ['none', 'lot', 'serial'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export const LOT_STATUSES = ['available', 'reserved', 'in_process', 'consumed', 'closed'] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Production (process/batch pattern)
// ---------------------------------------------------------------------------

export const BATCH_STATUSES = ['draft', 'in_progress', 'completed', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * QC lifecycle of a gated batch:
 *   pending                  no decisive test yet ("Pending QC")
 *   failed                   latest test failed — blocked, retest required
 *   retest_required          tester explicitly requested a retest — blocked
 *   passed_pending_release   latest test passed, awaiting explicit release
 *   passed                   released by quality authority — next stage may consume
 */
export const QC_STATUSES = [
  'pending',
  'passed',
  'failed',
  'retest_required',
  'passed_pending_release',
] as const;
export type QcStatus = (typeof QC_STATUSES)[number];

/** How a production stage sources its input. */
export const STAGE_INPUT_SOURCES = ['lot', 'prior_batch'] as const;
export type StageInputSource = (typeof STAGE_INPUT_SOURCES)[number];

/** How a production stage emits its output. */
export const STAGE_OUTPUT_FORMS = ['bulk', 'packaged_items'] as const;
export type StageOutputForm = (typeof STAGE_OUTPUT_FORMS)[number];

/**
 * Physical behavior of a stage — configured per tenant, never assumed:
 *   measured   output is entered/measured; variance/loss is derived (washing)
 *   conserved  output defaults to input; NO automatic mass loss (iodization);
 *              a real measured variance needs an explicit audited correction
 *   converted  input mass is converted into product units (packaging)
 */
export const STAGE_OUTPUT_POLICIES = ['measured', 'conserved', 'converted'] as const;
export type StageOutputPolicy = (typeof STAGE_OUTPUT_POLICIES)[number];

/** Declarative extra-field definition for a stage (e.g. iodine added). */
export interface StageAttributeDef {
  key: string;
  labelKey: string; // translation key
  type: 'number' | 'text';
  unit?: string;
  required?: boolean;
}

export interface StageConfig {
  code: string;
  nameKey: string;
  sequence: number;
  inputSource: StageInputSource;
  outputForm: StageOutputForm;
  requiresQc: boolean;
  /** item the stage consumes when inputSource = lot (optional restriction) */
  inputItemId?: string | null;
  /** items the stage may produce when outputForm = packaged_items */
  outputItemIds?: string[];
  attributes?: StageAttributeDef[];
  docPrefixKey: string; // numbering sequence key, e.g. 'production.washing'
}

// ---------------------------------------------------------------------------
// Commercial
// ---------------------------------------------------------------------------

export const INVOICE_STATUSES = [
  'pending',
  'confirmed',
  'dispatched',
  'completed',
  'cancelled',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_TERMS = ['paid', 'credit', 'partial'] as const;
export type PaymentTerm = (typeof PAYMENT_TERMS)[number];

export const DELIVERY_STATUSES = [
  'pending',
  'loading',
  'dispatched',
  'delivered',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const PAYMENT_STATUSES = ['draft', 'posted', 'reversed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Derived, never stored: credit position of an invoice. */
export type CreditStatus = 'active' | 'partial' | 'paid' | 'overdue';

export const PARTY_KINDS = ['customer', 'supplier', 'both'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

// ---------------------------------------------------------------------------
// Quantities & units
// ---------------------------------------------------------------------------

/**
 * All stock quantities are stored as integers in the item's base unit scaled
 * by 1000 (milli-units) to avoid floating point drift: 1 kg -> 1000.
 * Money is stored as integer cents (ETB * 100 for Mesob).
 */
export const QTY_SCALE = 1000;
export const MONEY_SCALE = 100;

export function toScaledQty(value: number): number {
  return Math.round(value * QTY_SCALE);
}
export function fromScaledQty(scaled: number): number {
  return scaled / QTY_SCALE;
}
export function toCents(value: number): number {
  return Math.round(value * MONEY_SCALE);
}
export function fromCents(cents: number): number {
  return cents / MONEY_SCALE;
}

/** Convert a quantity between units given factors-to-base (e.g. ton=1000, kg=1). */
export function convertQty(value: number, fromFactorToBase: number, toFactorToBase: number): number {
  if (fromFactorToBase <= 0 || toFactorToBase <= 0) {
    throw new Error('Unit conversion factors must be positive');
  }
  return (value * fromFactorToBase) / toFactorToBase;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEventInput {
  module: ModuleId;
  action: string;
  reference?: string | null;
  entity?: string | null;
  entityId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  result?: 'success' | 'blocked' | 'error';
}

// ---------------------------------------------------------------------------
// Session / auth
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  roleId: string;
  roleName: string;
  permissions: PermissionMatrix;
  language: string;
  theme: 'light' | 'dark' | 'system';
}

export function hasPermission(
  matrix: PermissionMatrix,
  module: ModuleId,
  action: ActionId | string,
): boolean {
  return matrix[module]?.[action] === true;
}

// ---------------------------------------------------------------------------
// Price categories (Core configuration — add / rename / archive / default)
// ---------------------------------------------------------------------------

export interface PriceCategory {
  code: string;
  name: string;
  active: boolean;
}

/**
 * Pricing settings historically stored categories as plain strings; the
 * upgraded shape is objects with archive + default support. This normalizer
 * accepts both so historical settings versions keep working.
 */
export function normalizePriceCategories(raw: {
  categories?: Array<string | PriceCategory>;
  defaultCategory?: string;
}): { categories: PriceCategory[]; defaultCode: string | null } {
  const categories = (raw.categories ?? []).map((c) =>
    typeof c === 'string'
      ? { code: c, name: c.charAt(0).toUpperCase() + c.slice(1), active: true }
      : { code: c.code, name: c.name, active: c.active !== false },
  );
  const active = categories.filter((c) => c.active);
  const defaultCode =
    raw.defaultCategory && active.some((c) => c.code === raw.defaultCategory)
      ? raw.defaultCategory
      : (active[0]?.code ?? null);
  return { categories, defaultCode };
}

// ---------------------------------------------------------------------------
// Calendar display (Core capability — never changes stored dates)
// ---------------------------------------------------------------------------

export const ETHIOPIAN_MONTHS = [
  'Meskerem',
  'Tikimt',
  'Hidar',
  'Tahsas',
  'Tir',
  'Yekatit',
  'Megabit',
  'Miyazya',
  'Ginbot',
  'Sene',
  'Hamle',
  'Nehase',
  'Pagume',
] as const;

/**
 * Convert a Gregorian date to the Ethiopian calendar for DISPLAY purposes.
 * Rule: Ethiopian New Year (Meskerem 1) falls on 11 September GC, or
 * 12 September in the Gregorian year preceding a Gregorian leap year.
 */
export function toEthiopianDate(gc: Date): { year: number; month: number; day: number; monthName: string } {
  const isGregorianLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const newYearDay = (gcYear: number) => (isGregorianLeap(gcYear + 1) ? 12 : 11);
  const utc = Date.UTC(gc.getFullYear(), gc.getMonth(), gc.getDate());
  let nyYear = gc.getFullYear();
  let ny = Date.UTC(nyYear, 8, newYearDay(nyYear)); // September = month index 8
  if (utc < ny) {
    nyYear -= 1;
    ny = Date.UTC(nyYear, 8, newYearDay(nyYear));
  }
  const dayOfYear = Math.floor((utc - ny) / 86_400_000); // 0-based
  const month = Math.floor(dayOfYear / 30) + 1;
  const day = (dayOfYear % 30) + 1;
  return {
    year: nyYear - 7,
    month,
    day,
    monthName: ETHIOPIAN_MONTHS[month - 1] ?? `M${month}`,
  };
}
