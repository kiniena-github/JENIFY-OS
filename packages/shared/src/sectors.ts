// JENIFY sector template family — PLATFORM data (no tenant literals).
//
// A sector is NOT an application. It is capability activation + configuration +
// role experiences + an AI mastery model, resolved through the ONE core by the
// template engine. Adding a sector must never fork the platform.
//
// HONESTY CONTRACT (directive §41): every surfaced action carries a `status`.
//   'live'    — the screen/route exists and works today
//   'planned' — the workflow is specified and activated in the template, but the
//               dedicated screen is not built yet; it must NOT be presented as
//               finished product. Role resolution filters these out of worker
//               surfaces so no user is shown a dead end.
// A sector counts as DONE only when its defined workflows actually run.

import type { ModuleId } from './index.js';
import type { ActivationMode, CapabilityId, TemplateLayer } from './templates.js';

export type SurfaceStatus = 'live' | 'planned';

export interface SectorAction {
  id: string;
  labelKey: string;
  path: string;
  module: ModuleId;
  action?: string;
  status: SurfaceStatus;
}

/** A role's purpose-built experience inside a sector (§16: no role sees the whole template). */
export interface SectorRolePreset {
  roleCode: string;
  labelKey: string;
  homeFocus: ModuleId;
  /** the deliberately tiny verb set this role works from */
  actions: SectorAction[];
}

/** Progressive complexity (§15): capabilities appear as the business grows. */
export type GrowthTier = 'micro' | 'small' | 'medium' | 'advanced' | 'enterprise';

export interface SectorGrowthStep {
  tier: GrowthTier;
  adds: CapabilityId[];
}

/** §27 sector AI acceptance model — what the AI may and may never do here. */
export interface SectorAIMastery {
  understands: string[];
  answers: string[];
  detects: string[];
  recommends: string[];
  /** low-risk drafts the AI may prepare (never posts) */
  prepares: string[];
  neverDoes: string[];
}

export interface SectorDefinition {
  id: string; // template id, e.g. 'sector.retail'
  labelKey: string;
  /** 4–6 obvious daily actions a micro business sees — nothing else */
  simpleSurface: SectorAction[];
  /** capabilities the smallest viable business in this sector needs */
  baseActivations: Partial<Record<CapabilityId, ActivationMode>>;
  /** what unlocks as the business grows (never shown to a micro business) */
  growth: SectorGrowthStep[];
  roles: SectorRolePreset[];
  ai: SectorAIMastery;
  /** workflows that genuinely need offline continuity (§19) */
  offlineWorkflows: string[];
  /** namespaced sector config defaults */
  config?: TemplateLayer['config'];
}

// Short helpers keep the definitions readable and consistent.
const live = (id: string, path: string, module: ModuleId, action?: string): SectorAction => ({
  id, labelKey: `verb.${id}`, path, module, action, status: 'live',
});
const planned = (id: string, path: string, module: ModuleId, action?: string): SectorAction => ({
  id, labelKey: `verb.${id}`, path, module, action, status: 'planned',
});

// Common live surfaces that already exist in the shipped web app.
const SELL = live('sell', '/sales', 'sales', 'create');
const STOCK = live('stock', '/inventory', 'inventory');
const CUSTOMERS = live('customers', '/customers', 'parties');
const MONEY = live('money', '/payments', 'payments');
const TODAY = live('today', '/', 'dashboard');
const RECEIVE = live('receive', '/receiving', 'inventory', 'create');
const DELIVERIES = live('deliveries', '/deliveries', 'delivery');
const REPORTS = live('reports', '/reports', 'reports');
const PRODUCTION = live('production', '/production', 'production');
const CREDIT = live('credit', '/credit', 'credit');

// ---------------------------------------------------------------------------
// The 20 sector families
// ---------------------------------------------------------------------------

export const SECTORS: readonly SectorDefinition[] = [
  // 1 ----------------------------------------------------------------------
  {
    id: 'sector.wholesale',
    labelKey: 'sector.wholesale',
    simpleSurface: [CUSTOMERS, planned('orders', '/orders', 'sales', 'create'), STOCK, DELIVERIES, MONEY],
    baseActivations: {
      parties: 'required', customers: 'required', suppliers: 'recommended', inventory: 'required',
      warehouses: 'required', sales: 'required', invoicing: 'required', credit: 'required',
      payments: 'required', delivery: 'required', orders: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'small', adds: ['procurement'] },
      { tier: 'medium', adds: ['approvals', 'fleet'] },
      { tier: 'advanced', adds: ['billing', 'ai'] },
      { tier: 'enterprise', adds: ['timesheets', 'assets'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, CREDIT, MONEY] },
      { roleCode: 'sales_rep', labelKey: 'role.sales_rep', homeFocus: 'sales', actions: [CUSTOMERS, SELL, planned('collect', '/payments', 'payments', 'create')] },
      { roleCode: 'warehouse', labelKey: 'role.warehouse', homeFocus: 'inventory', actions: [RECEIVE, STOCK, planned('pick', '/deliveries', 'delivery', 'load')] },
      { roleCode: 'driver', labelKey: 'role.driver', homeFocus: 'delivery', actions: [DELIVERIES] },
      { roleCode: 'finance', labelKey: 'role.finance', homeFocus: 'payments', actions: [MONEY, CREDIT, REPORTS] },
    ],
    ai: {
      understands: ['customers', 'credit exposure', 'stock cover', 'orders', 'deliveries', 'collections'],
      answers: ['who owes us', 'what stock is low', 'which deliveries are late', 'today/period sales'],
      detects: ['overdue receivables', 'credit-limit breaches', 'stockouts', 'late deliveries'],
      recommends: ['which customers to chase', 'what to reorder'],
      prepares: ['draft customer', 'draft sales invoice', 'draft receiving'],
      neverDoes: ['post payments', 'extend a credit limit', 'dispatch stock without human confirmation'],
    },
    offlineWorkflows: ['receiving', 'delivery confirmation', 'field order capture (planned)'],
  },
  // 2 ----------------------------------------------------------------------
  {
    id: 'sector.retail',
    labelKey: 'sector.retail',
    simpleSurface: [SELL, STOCK, planned('expenses', '/sacks', 'inventory', 'create'), CUSTOMERS, TODAY],
    baseActivations: {
      parties: 'required', customers: 'recommended', inventory: 'required', sales: 'required',
      invoicing: 'required', payments: 'required', pos: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'small', adds: ['suppliers', 'credit'] },
      { tier: 'medium', adds: ['warehouses', 'procurement', 'expiry'] },
      { tier: 'advanced', adds: ['approvals', 'billing', 'ai'] },
      { tier: 'enterprise', adds: ['workforce', 'timesheets'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'cashier', labelKey: 'role.cashier', homeFocus: 'sales', actions: [SELL, CUSTOMERS] },
      { roleCode: 'stock_keeper', labelKey: 'role.stock_keeper', homeFocus: 'inventory', actions: [RECEIVE, STOCK] },
    ],
    ai: {
      understands: ['sales', 'products', 'stock', 'cash', 'customer debt', 'pricing'],
      answers: ['what sold today', 'what is low', 'who owes me', 'cash position'],
      detects: ['low stock', 'unusual discounts', 'debt build-up'],
      recommends: ['what to reorder', 'which debts to chase'],
      prepares: ['draft customer', 'draft receiving'],
      neverDoes: ['complete a sale without the cashier', 'change prices silently'],
    },
    offlineWorkflows: ['selling (design-gated: cash-only, class-L)', 'receiving'],
    config: { core: { tinyShopMode: true } },
  },
  // 3 ----------------------------------------------------------------------
  {
    id: 'sector.manufacturing',
    labelKey: 'sector.manufacturing',
    simpleSurface: [PRODUCTION, STOCK, RECEIVE, SELL, TODAY],
    baseActivations: {
      parties: 'required', inventory: 'required', warehouses: 'required', production: 'required',
      quality: 'recommended', traceability: 'recommended', sales: 'required', payments: 'required',
      reports: 'required',
    },
    growth: [
      { tier: 'small', adds: ['suppliers', 'delivery'] },
      { tier: 'medium', adds: ['procurement', 'recipes', 'credit'] },
      { tier: 'advanced', adds: ['assets', 'maintenance', 'approvals', 'ai'] },
      { tier: 'enterprise', adds: ['workforce', 'timesheets'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'production_operator', labelKey: 'role.production_operator', homeFocus: 'production', actions: [PRODUCTION] },
      { roleCode: 'quality', labelKey: 'role.quality', homeFocus: 'quality', actions: [live('qc', '/production', 'quality', 'approve')] },
      { roleCode: 'warehouse', labelKey: 'role.warehouse', homeFocus: 'inventory', actions: [RECEIVE, STOCK] },
    ],
    ai: {
      understands: ['materials', 'batches', 'stages', 'yield/loss', 'quality', 'finished stock'],
      answers: ['what was produced today', 'why was loss high', 'what needs QC release', 'raw stock'],
      detects: ['abnormal loss', 'QC failures', 'batches awaiting release', 'material shortage'],
      recommends: ['what to produce next', 'which material to reorder'],
      prepares: ['draft receiving'],
      neverDoes: ['release QC', 'post production output', 'invent yield figures'],
    },
    offlineWorkflows: ['receiving', 'production floor capture (planned)'],
    config: { production: { models: ['process', 'discrete'] } },
  },
  // 4 ----------------------------------------------------------------------
  {
    id: 'sector.construction',
    labelKey: 'sector.construction',
    simpleSurface: [planned('projects', '/projects', 'reports'), TODAY, planned('materials', '/inventory', 'inventory'), planned('workers', '/users', 'users'), MONEY],
    baseActivations: {
      parties: 'required', projects: 'required', inventory: 'required', warehouses: 'recommended',
      procurement: 'recommended', approvals: 'recommended', payments: 'required', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['workforce', 'timesheets', 'assets'] },
      { tier: 'advanced', adds: ['maintenance', 'documents', 'ai'] },
      { tier: 'enterprise', adds: ['billing', 'quality'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'site_engineer', labelKey: 'role.site_engineer', homeFocus: 'inventory', actions: [RECEIVE, planned('site_log', '/projects', 'reports', 'create')] },
      { roleCode: 'storekeeper', labelKey: 'role.storekeeper', homeFocus: 'inventory', actions: [RECEIVE, STOCK] },
      { roleCode: 'procurement', labelKey: 'role.procurement', homeFocus: 'parties', actions: [planned('request', '/procurement', 'inventory', 'create')] },
    ],
    ai: {
      understands: ['projects', 'budget vs actual', 'material consumption', 'progress', 'subcontractors'],
      answers: ['project cost so far', 'what materials went to site', 'pending approvals'],
      detects: ['budget overrun', 'material variance', 'stalled progress'],
      recommends: ['which project needs attention'],
      prepares: ['draft material request'],
      neverDoes: ['approve payment certificates', 'change a budget'],
    },
    offlineWorkflows: ['site material receipt', 'daily site log (planned)'],
  },
  // 5 ----------------------------------------------------------------------
  {
    id: 'sector.logistics',
    labelKey: 'sector.logistics',
    simpleSurface: [planned('jobs', '/jobs', 'delivery'), planned('vehicles', '/fleet', 'delivery'), planned('drivers', '/users', 'users'), DELIVERIES, MONEY],
    baseActivations: {
      parties: 'required', customers: 'required', delivery: 'required', fleet: 'recommended',
      assets: 'recommended', payments: 'required', invoicing: 'required', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['workorders', 'maintenance', 'credit'] },
      { tier: 'advanced', adds: ['approvals', 'timesheets', 'ai'] },
      { tier: 'enterprise', adds: ['billing', 'projects'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'driver', labelKey: 'role.driver', homeFocus: 'delivery', actions: [DELIVERIES] },
      { roleCode: 'dispatcher', labelKey: 'role.dispatcher', homeFocus: 'delivery', actions: [DELIVERIES, CUSTOMERS] },
    ],
    ai: {
      understands: ['jobs', 'vehicles', 'drivers', 'delivery performance', 'fuel', 'maintenance due'],
      answers: ['which deliveries are late', "today's trips", 'delivery performance'],
      detects: ['late deliveries', 'failed deliveries', 'maintenance overdue'],
      recommends: ['which job to assign next'],
      prepares: ['draft delivery'],
      neverDoes: ['confirm a delivery the driver did not confirm', 'invent proof of delivery'],
    },
    offlineWorkflows: ['delivery confirmation', 'proof of delivery capture'],
  },
  // 6 ----------------------------------------------------------------------
  {
    id: 'sector.restaurant',
    labelKey: 'sector.restaurant',
    simpleSurface: [planned('orders', '/orders', 'sales', 'create'), planned('kitchen', '/kitchen', 'production'), MONEY, STOCK, TODAY],
    baseActivations: {
      parties: 'recommended', inventory: 'required', sales: 'required', invoicing: 'required',
      payments: 'required', pos: 'recommended', orders: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'small', adds: ['suppliers', 'recipes'] },
      { tier: 'medium', adds: ['bookings', 'expiry', 'procurement'] },
      { tier: 'advanced', adds: ['workforce', 'timesheets', 'ai'] },
      { tier: 'enterprise', adds: ['warehouses', 'approvals'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'waiter', labelKey: 'role.waiter', homeFocus: 'sales', actions: [planned('take_order', '/orders', 'sales', 'create')] },
      { roleCode: 'kitchen', labelKey: 'role.kitchen', homeFocus: 'production', actions: [planned('kitchen_queue', '/kitchen', 'production')] },
      { roleCode: 'cashier', labelKey: 'role.cashier', homeFocus: 'payments', actions: [SELL, MONEY] },
    ],
    ai: {
      understands: ['orders', 'kitchen flow', 'recipes', 'ingredient consumption', 'waste', 'food cost'],
      answers: ['what sold today', 'what ingredients are low', 'busiest hours'],
      detects: ['ingredient shortage', 'unusual waste', 'slow tickets'],
      recommends: ['what to prep', 'what to reorder'],
      prepares: ['draft purchase of ingredients'],
      neverDoes: ['void a bill', 'post cash without the cashier'],
    },
    offlineWorkflows: ['order taking (planned)', 'kitchen status (planned)'],
  },
  // 7 ----------------------------------------------------------------------
  {
    id: 'sector.hospitality',
    labelKey: 'sector.hospitality',
    simpleSurface: [planned('bookings', '/bookings', 'sales'), planned('rooms', '/rooms', 'reports'), planned('housekeeping', '/housekeeping', 'production'), MONEY, TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', bookings: 'required', sales: 'required',
      invoicing: 'required', payments: 'required', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['workorders', 'maintenance', 'inventory'] },
      { tier: 'advanced', adds: ['workforce', 'timesheets', 'approvals', 'ai'] },
      { tier: 'enterprise', adds: ['assets', 'billing', 'projects'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'reception', labelKey: 'role.reception', homeFocus: 'sales', actions: [planned('check_in', '/bookings', 'sales', 'edit'), CUSTOMERS] },
      { roleCode: 'housekeeper', labelKey: 'role.housekeeper', homeFocus: 'production', actions: [planned('rooms_to_clean', '/housekeeping', 'production', 'edit')] },
      { roleCode: 'maintenance', labelKey: 'role.maintenance', homeFocus: 'production', actions: [planned('work_orders', '/workorders', 'production')] },
    ],
    ai: {
      understands: ['bookings', 'occupancy', 'room status', 'guest requests', 'revenue per room'],
      answers: ['arrivals today', 'occupancy', 'rooms needing cleaning'],
      detects: ['overbooking risk', 'unclean rooms before arrival', 'maintenance blocking a room'],
      recommends: ['rooms to prioritise'],
      prepares: ['draft booking'],
      neverDoes: ['confirm a booking payment', 'release a room without housekeeping sign-off'],
    },
    offlineWorkflows: ['housekeeping status (planned)'],
  },
  // 8 ----------------------------------------------------------------------
  {
    id: 'sector.pharmacy',
    labelKey: 'sector.pharmacy',
    simpleSurface: [SELL, STOCK, planned('expiry', '/inventory', 'inventory'), CUSTOMERS, TODAY],
    baseActivations: {
      parties: 'required', inventory: 'required', traceability: 'required', expiry: 'required',
      sales: 'required', invoicing: 'required', payments: 'required', pos: 'recommended',
      suppliers: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['procurement', 'warehouses', 'credit'] },
      { tier: 'advanced', adds: ['approvals', 'ai', 'quality'] },
      { tier: 'enterprise', adds: ['billing', 'workforce'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'dispenser', labelKey: 'role.dispenser', homeFocus: 'sales', actions: [SELL, STOCK] },
      { roleCode: 'stock_keeper', labelKey: 'role.stock_keeper', homeFocus: 'inventory', actions: [RECEIVE, STOCK] },
    ],
    ai: {
      understands: ['medicines', 'batches', 'expiry dates', 'stock', 'suppliers', 'sales'],
      answers: ['what expires soon', 'what is low', 'what sold today'],
      detects: ['near-expiry batches', 'expired stock still on hand', 'stockouts'],
      recommends: ['FEFO picking order', 'what to reorder'],
      prepares: ['draft receiving'],
      neverDoes: ['give clinical/medical advice', 'dispense without a human', 'alter batch records'],
    },
    offlineWorkflows: ['receiving', 'selling (design-gated)'],
    config: { expiry: { fefo: true } },
  },
  // 9 ----------------------------------------------------------------------
  {
    id: 'sector.healthcare',
    labelKey: 'sector.healthcare',
    simpleSurface: [planned('appointments', '/bookings', 'sales'), planned('patients', '/customers', 'parties'), planned('billing', '/sales', 'sales'), MONEY, TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', bookings: 'required', invoicing: 'required',
      payments: 'required', documents: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['inventory', 'expiry', 'cases'] },
      { tier: 'advanced', adds: ['approvals', 'workforce', 'timesheets'] },
      { tier: 'enterprise', adds: ['billing', 'assets', 'maintenance'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'reception', labelKey: 'role.reception', homeFocus: 'parties', actions: [planned('book', '/bookings', 'sales', 'create'), CUSTOMERS] },
      { roleCode: 'finance', labelKey: 'role.finance', homeFocus: 'payments', actions: [MONEY, CREDIT] },
    ],
    ai: {
      understands: ['appointments', 'administrative billing', 'payments', 'supplies'],
      answers: ['appointments today', 'unpaid bills', 'supply levels'],
      detects: ['no-shows', 'unpaid balances', 'expiring supplies'],
      recommends: ['scheduling gaps to fill'],
      prepares: ['draft appointment'],
      neverDoes: [
        'ANY clinical decision, diagnosis, triage or treatment suggestion',
        'read or infer clinical records',
        'anything beyond administrative/billing scope',
      ],
    },
    offlineWorkflows: [],
    config: { core: { scope: 'administrative_only', clinicalOutOfScope: true } },
  },
  // 10 ---------------------------------------------------------------------
  {
    id: 'sector.agriculture',
    labelKey: 'sector.agriculture',
    simpleSurface: [planned('fields', '/projects', 'reports'), planned('inputs', '/inventory', 'inventory'), planned('harvest', '/production', 'production'), SELL, TODAY],
    baseActivations: {
      parties: 'required', inventory: 'required', production: 'recommended', traceability: 'recommended',
      sales: 'required', payments: 'required', projects: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['warehouses', 'suppliers', 'procurement', 'expiry'] },
      { tier: 'advanced', adds: ['assets', 'maintenance', 'workforce', 'timesheets'] },
      { tier: 'enterprise', adds: ['quality', 'approvals', 'ai'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'field_worker', labelKey: 'role.field_worker', homeFocus: 'production', actions: [planned('field_log', '/production', 'production', 'create')] },
      { roleCode: 'store_keeper', labelKey: 'role.store_keeper', homeFocus: 'inventory', actions: [RECEIVE, STOCK] },
    ],
    ai: {
      understands: ['fields/plots', 'inputs applied', 'harvest quantities', 'produce sales', 'traceability'],
      answers: ['harvest so far', 'input consumption', 'what sold'],
      detects: ['input shortages', 'yield anomalies'],
      recommends: ['what to reorder'],
      prepares: ['draft receiving'],
      neverDoes: ['give agronomic/chemical dosing advice', 'invent yield forecasts'],
    },
    offlineWorkflows: ['field activity capture (planned)', 'receiving'],
  },
  // 11 ---------------------------------------------------------------------
  {
    id: 'sector.automotive',
    labelKey: 'sector.automotive',
    simpleSurface: [planned('jobs', '/workorders', 'production'), planned('vehicles', '/assets', 'inventory'), planned('parts', '/inventory', 'inventory'), MONEY, TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', inventory: 'required', workorders: 'required',
      assets: 'recommended', sales: 'required', invoicing: 'required', payments: 'required',
      reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['suppliers', 'procurement', 'timesheets'] },
      { tier: 'advanced', adds: ['maintenance', 'approvals', 'ai', 'credit'] },
      { tier: 'enterprise', adds: ['fleet', 'warehouses'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'technician', labelKey: 'role.technician', homeFocus: 'production', actions: [planned('my_jobs', '/workorders', 'production', 'edit')] },
      { roleCode: 'service_advisor', labelKey: 'role.service_advisor', homeFocus: 'sales', actions: [CUSTOMERS, planned('estimate', '/sales', 'sales', 'create')] },
      { roleCode: 'parts', labelKey: 'role.parts', homeFocus: 'inventory', actions: [RECEIVE, STOCK] },
    ],
    ai: {
      understands: ['vehicles', 'jobs', 'parts used', 'labour', 'service history'],
      answers: ['open jobs', 'parts low', 'revenue per job'],
      detects: ['jobs stalled', 'parts shortage', 'repeat repairs'],
      recommends: ['parts to reorder'],
      prepares: ['draft estimate', 'draft customer'],
      neverDoes: ['authorise repairs', 'close a job the technician has not finished'],
    },
    offlineWorkflows: ['workshop job status (planned)'],
  },
  // 12 ---------------------------------------------------------------------
  {
    id: 'sector.realestate',
    labelKey: 'sector.realestate',
    simpleSurface: [planned('properties', '/assets', 'inventory'), planned('tenants', '/customers', 'parties'), planned('rent', '/billing', 'sales'), MONEY, TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', assets: 'required', billing: 'required',
      invoicing: 'required', payments: 'required', credit: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['workorders', 'maintenance', 'documents'] },
      { tier: 'advanced', adds: ['approvals', 'ai', 'projects'] },
      { tier: 'enterprise', adds: ['workforce', 'procurement'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'property_manager', labelKey: 'role.property_manager', homeFocus: 'parties', actions: [CUSTOMERS, planned('leases', '/billing', 'sales')] },
      { roleCode: 'maintenance', labelKey: 'role.maintenance', homeFocus: 'production', actions: [planned('work_orders', '/workorders', 'production')] },
    ],
    ai: {
      understands: ['properties/units', 'tenants', 'leases', 'rent due', 'arrears', 'maintenance'],
      answers: ['who has not paid rent', 'occupancy', 'upcoming lease expiry'],
      detects: ['rent arrears', 'vacant units', 'overdue maintenance'],
      recommends: ['which tenants to chase'],
      prepares: ['draft rent invoice'],
      neverDoes: ['post rent receipts', 'terminate a lease'],
    },
    offlineWorkflows: [],
  },
  // 13 ---------------------------------------------------------------------
  {
    id: 'sector.professional',
    labelKey: 'sector.professional',
    simpleSurface: [planned('clients', '/customers', 'parties'), planned('projects', '/projects', 'reports'), planned('time', '/timesheets', 'users'), planned('invoices', '/sales', 'sales'), TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', projects: 'required', timesheets: 'recommended',
      workforce: 'recommended', invoicing: 'required', payments: 'required', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['approvals', 'documents', 'credit'] },
      { tier: 'advanced', adds: ['billing', 'ai'] },
      { tier: 'enterprise', adds: ['procurement', 'assets'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'consultant', labelKey: 'role.consultant', homeFocus: 'users', actions: [planned('log_time', '/timesheets', 'users', 'create')] },
      { roleCode: 'finance', labelKey: 'role.finance', homeFocus: 'payments', actions: [MONEY, CREDIT] },
    ],
    ai: {
      understands: ['clients', 'projects', 'time logged', 'billable vs non-billable', 'invoices'],
      answers: ['unbilled time', 'project profitability', 'who owes us'],
      detects: ['unbilled work', 'over-run projects', 'low utilisation'],
      recommends: ['what to invoice next'],
      prepares: ['draft invoice from time'],
      neverDoes: ['post an invoice without review', 'alter time records'],
    },
    offlineWorkflows: ['time capture (planned)'],
  },
  // 14 ---------------------------------------------------------------------
  {
    id: 'sector.education',
    labelKey: 'sector.education',
    simpleSurface: [planned('students', '/customers', 'parties'), planned('classes', '/bookings', 'sales'), planned('fees', '/billing', 'sales'), MONEY, TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', bookings: 'recommended', billing: 'required',
      invoicing: 'required', payments: 'required', credit: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['workforce', 'timesheets', 'documents'] },
      { tier: 'advanced', adds: ['assets', 'approvals', 'ai'] },
      { tier: 'enterprise', adds: ['inventory', 'procurement', 'maintenance'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'registrar', labelKey: 'role.registrar', homeFocus: 'parties', actions: [CUSTOMERS, planned('enrol', '/bookings', 'sales', 'create')] },
      { roleCode: 'finance', labelKey: 'role.finance', homeFocus: 'payments', actions: [MONEY, CREDIT] },
    ],
    ai: {
      understands: ['learners', 'classes', 'fee schedules', 'fee arrears', 'staff'],
      answers: ['who has unpaid fees', 'enrolment numbers', 'collections this term'],
      detects: ['fee arrears', 'under-filled classes'],
      recommends: ['which families to contact'],
      prepares: ['draft fee invoice'],
      neverDoes: ['assess or grade learners', 'expose learner personal data beyond permission'],
    },
    offlineWorkflows: ['attendance capture (planned)'],
  },
  // 15 ---------------------------------------------------------------------
  {
    id: 'sector.mining',
    labelKey: 'sector.mining',
    simpleSurface: [PRODUCTION, planned('equipment', '/assets', 'inventory'), STOCK, planned('safety', '/cases', 'reports'), TODAY],
    baseActivations: {
      parties: 'required', inventory: 'required', warehouses: 'required', production: 'required',
      assets: 'required', maintenance: 'recommended', traceability: 'recommended',
      sales: 'required', payments: 'required', reports: 'required',
    },
    growth: [
      { tier: 'advanced', adds: ['procurement', 'workforce', 'timesheets', 'approvals', 'cases'] },
      { tier: 'enterprise', adds: ['quality', 'projects', 'ai', 'documents'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'supervisor', labelKey: 'role.supervisor', homeFocus: 'production', actions: [PRODUCTION, STOCK] },
      { roleCode: 'maintenance', labelKey: 'role.maintenance', homeFocus: 'production', actions: [planned('work_orders', '/workorders', 'production')] },
    ],
    ai: {
      understands: ['production output', 'equipment availability', 'materials', 'downtime', 'safety events'],
      answers: ['output this period', 'equipment down', 'open safety cases'],
      detects: ['downtime spikes', 'output drops', 'overdue maintenance'],
      recommends: ['maintenance priorities'],
      prepares: ['draft work order'],
      neverDoes: ['make safety determinations', 'close a safety case'],
    },
    offlineWorkflows: ['production capture (planned)', 'equipment status (planned)'],
  },
  // 16 ---------------------------------------------------------------------
  {
    id: 'sector.ngo',
    labelKey: 'sector.ngo',
    simpleSurface: [planned('programs', '/projects', 'reports'), planned('donors', '/customers', 'parties'), planned('spend', '/payments', 'payments'), REPORTS, TODAY],
    baseActivations: {
      parties: 'required', projects: 'required', payments: 'required', approvals: 'recommended',
      documents: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['inventory', 'procurement', 'suppliers'] },
      { tier: 'advanced', adds: ['workforce', 'timesheets', 'ai'] },
      { tier: 'enterprise', adds: ['assets', 'billing'] },
    ],
    roles: [
      { roleCode: 'director', labelKey: 'role.director', homeFocus: 'dashboard', actions: [TODAY, REPORTS] },
      { roleCode: 'program_officer', labelKey: 'role.program_officer', homeFocus: 'reports', actions: [planned('program_log', '/projects', 'reports', 'create')] },
      { roleCode: 'finance', labelKey: 'role.finance', homeFocus: 'payments', actions: [MONEY, REPORTS] },
    ],
    ai: {
      understands: ['programs', 'grants/restricted funds', 'budget vs spend', 'procurement', 'reporting'],
      answers: ['spend against grant', 'pending approvals', 'programme activity'],
      detects: ['restricted-fund overspend', 'budget variance', 'missing documentation'],
      recommends: ['what needs donor reporting'],
      prepares: ['draft expense record'],
      neverDoes: ['move money between restricted funds', 'expose beneficiary personal data'],
    },
    offlineWorkflows: ['field activity capture (planned)'],
  },
  // 17 ---------------------------------------------------------------------
  {
    id: 'sector.fieldservice',
    labelKey: 'sector.fieldservice',
    simpleSurface: [planned('my_jobs', '/workorders', 'production'), planned('customers', '/customers', 'parties'), planned('parts', '/inventory', 'inventory'), MONEY, TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', workorders: 'required', assets: 'recommended',
      inventory: 'recommended', invoicing: 'required', payments: 'required', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['timesheets', 'maintenance', 'fleet'] },
      { tier: 'advanced', adds: ['approvals', 'billing', 'ai'] },
      { tier: 'enterprise', adds: ['procurement', 'warehouses', 'projects'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'technician', labelKey: 'role.technician', homeFocus: 'production', actions: [planned('my_jobs', '/workorders', 'production', 'edit')] },
      { roleCode: 'dispatcher', labelKey: 'role.dispatcher', homeFocus: 'production', actions: [planned('assign', '/workorders', 'production', 'edit'), CUSTOMERS] },
    ],
    ai: {
      understands: ['work orders', 'technicians', 'customer assets', 'parts used', 'service contracts'],
      answers: ['open jobs', 'jobs today', 'parts consumed'],
      detects: ['overdue jobs', 'repeat failures', 'parts shortage'],
      recommends: ['job assignment order'],
      prepares: ['draft work order'],
      neverDoes: ['close a job the technician did not complete', 'invent service outcomes'],
    },
    offlineWorkflows: ['job status + completion capture (planned)'],
  },
  // 18 ---------------------------------------------------------------------
  {
    id: 'sector.ecommerce',
    labelKey: 'sector.ecommerce',
    simpleSurface: [planned('orders', '/orders', 'sales'), STOCK, DELIVERIES, planned('returns', '/sales-returns', 'sales'), MONEY],
    baseActivations: {
      parties: 'required', customers: 'required', inventory: 'required', orders: 'required',
      sales: 'required', invoicing: 'required', payments: 'required', delivery: 'required',
      reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['warehouses', 'suppliers', 'procurement'] },
      { tier: 'advanced', adds: ['approvals', 'billing', 'ai', 'fleet'] },
      { tier: 'enterprise', adds: ['workforce', 'projects'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'fulfilment', labelKey: 'role.fulfilment', homeFocus: 'inventory', actions: [STOCK, DELIVERIES] },
      { roleCode: 'support', labelKey: 'role.support', homeFocus: 'parties', actions: [CUSTOMERS, planned('returns', '/sales-returns', 'sales', 'create')] },
    ],
    ai: {
      understands: ['orders', 'stock availability', 'fulfilment', 'returns', 'payments'],
      answers: ['orders today', 'what is out of stock', 'return rate'],
      detects: ['oversell risk', 'unfulfilled orders', 'return spikes'],
      recommends: ['what to restock'],
      prepares: ['draft customer', 'draft delivery'],
      neverDoes: ['refund a customer automatically', 'cancel a paid order'],
    },
    offlineWorkflows: ['fulfilment/picking (planned)'],
  },
  // 19 ---------------------------------------------------------------------
  {
    id: 'sector.utilities',
    labelKey: 'sector.utilities',
    simpleSurface: [planned('accounts', '/customers', 'parties'), planned('billing', '/billing', 'sales'), planned('requests', '/cases', 'reports'), MONEY, TODAY],
    baseActivations: {
      parties: 'required', customers: 'required', billing: 'required', invoicing: 'required',
      payments: 'required', cases: 'recommended', credit: 'recommended', reports: 'required',
    },
    growth: [
      { tier: 'medium', adds: ['workorders', 'assets', 'maintenance'] },
      { tier: 'advanced', adds: ['approvals', 'fleet', 'ai'] },
      { tier: 'enterprise', adds: ['workforce', 'timesheets', 'procurement'] },
    ],
    roles: [
      { roleCode: 'owner', labelKey: 'role.owner', homeFocus: 'dashboard', actions: [TODAY, REPORTS, MONEY] },
      { roleCode: 'field_tech', labelKey: 'role.field_tech', homeFocus: 'production', actions: [planned('my_jobs', '/workorders', 'production', 'edit')] },
      { roleCode: 'billing_clerk', labelKey: 'role.billing_clerk', homeFocus: 'sales', actions: [planned('run_billing', '/billing', 'sales', 'create'), MONEY] },
    ],
    ai: {
      understands: ['accounts', 'service locations', 'billing cycles', 'arrears', 'service requests'],
      answers: ['who is in arrears', 'open service requests', 'collections this cycle'],
      detects: ['arrears', 'unbilled accounts', 'overdue requests'],
      recommends: ['collection priorities'],
      prepares: ['draft billing run'],
      neverDoes: ['disconnect a customer', 'post a billing run without approval'],
    },
    offlineWorkflows: ['field job capture (planned)', 'meter/service reading (planned)'],
  },
  // 20 ---------------------------------------------------------------------
  {
    id: 'sector.government',
    labelKey: 'sector.government',
    simpleSurface: [planned('requests', '/cases', 'reports'), planned('approvals', '/approvals', 'settings'), planned('assets', '/assets', 'inventory'), REPORTS, TODAY],
    baseActivations: {
      parties: 'required', cases: 'required', approvals: 'required', documents: 'recommended',
      reports: 'required', payments: 'recommended',
    },
    growth: [
      { tier: 'medium', adds: ['assets', 'procurement', 'suppliers'] },
      { tier: 'advanced', adds: ['workforce', 'timesheets', 'projects'] },
      { tier: 'enterprise', adds: ['maintenance', 'billing', 'ai'] },
    ],
    roles: [
      { roleCode: 'director', labelKey: 'role.director', homeFocus: 'dashboard', actions: [TODAY, REPORTS] },
      { roleCode: 'case_officer', labelKey: 'role.case_officer', homeFocus: 'reports', actions: [planned('my_cases', '/cases', 'reports', 'edit')] },
      { roleCode: 'approver', labelKey: 'role.approver', homeFocus: 'settings', actions: [planned('approvals', '/approvals', 'settings', 'approve')] },
    ],
    ai: {
      understands: ['requests/cases', 'processing time', 'approvals', 'public assets', 'procurement'],
      answers: ['open cases', 'average processing time', 'pending approvals'],
      detects: ['overdue cases', 'approval bottlenecks'],
      recommends: ['case prioritisation'],
      prepares: ['draft case record'],
      neverDoes: [
        'decide a citizen case',
        'grant or deny an application',
        'expose citizen data beyond permission',
      ],
    },
    offlineWorkflows: ['field case capture (planned)'],
    config: { core: { publicAccountability: true } },
  },
];

export const SECTOR_BY_ID = new Map(SECTORS.map((s) => [s.id, s]));

/**
 * Convert a sector definition into a publishable template layer. Growth-tier
 * capabilities are NOT activated at publish time — a tenant opts into a tier,
 * which is what keeps a micro business's surface small (§15).
 */
export function sectorTemplateLayer(sector: SectorDefinition, tier: GrowthTier = 'micro'): {
  templateId: string;
  kind: 'sector';
  labelKey: string;
  extendsId: string;
  activations: Partial<Record<CapabilityId, ActivationMode>>;
  config: TemplateLayer['config'];
} {
  const order: GrowthTier[] = ['micro', 'small', 'medium', 'advanced', 'enterprise'];
  const upTo = order.indexOf(tier);
  const activations: Partial<Record<CapabilityId, ActivationMode>> = { ...sector.baseActivations };
  for (const step of sector.growth) {
    if (order.indexOf(step.tier) <= upTo) {
      for (const cap of step.adds) activations[cap] ??= 'recommended';
    }
  }
  return {
    templateId: sector.id,
    kind: 'sector',
    labelKey: sector.labelKey,
    extendsId: 'core',
    activations,
    config: {
      ...(sector.config ?? {}),
      core: {
        ...(sector.config?.core ?? {}),
        simpleSurface: sector.simpleSurface.map((a) => a.id),
        growthTier: tier,
        offlineWorkflows: sector.offlineWorkflows,
      },
    },
  };
}

/** Only the surfaces that actually work today — used to keep worker UIs honest. */
export function liveActions(actions: SectorAction[]): SectorAction[] {
  return actions.filter((a) => a.status === 'live');
}
