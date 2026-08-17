/**
 * Mesob Salt Factory — first FactoryOS tenant configuration.
 *
 * Everything Mesob-specific lives HERE, not in platform code:
 * warehouses A/B/C, Afdera source, 500g/1kg/50kg products, roles,
 * production stages, document prefixes, languages, branding.
 *
 * The seed provisions the tenant exclusively through platform service APIs —
 * exactly the way any future factory would be onboarded.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDb } from '@factoryos/server/db';
import {
  createTenant,
  getTenantByCode,
  createRole,
  createUser,
  createUom,
  createItem,
  createWarehouse,
  createStage,
  defineSequence,
  saveSettings,
  registerTranslationKeys,
  enableLanguage,
  upsertTranslation,
  type Ctx,
} from '@factoryos/server/services';
import { PLATFORM_KEYS } from '@factoryos/server/i18n-keys';
import { createParty } from '@factoryos/server/services';
import type { PermissionMatrix, ModuleId, ActionId } from '@factoryos/shared';
import { MODULES, ACTIONS } from '@factoryos/shared';

// ---------------------------------------------------------------------------

function m(entries: Array<[ModuleId, ActionId[]]>): PermissionMatrix {
  const out: PermissionMatrix = {};
  for (const [mod, acts] of entries) {
    out[mod] = {};
    for (const a of acts) out[mod]![a] = true;
  }
  return out;
}

function fullMatrix(): PermissionMatrix {
  const out: PermissionMatrix = {};
  for (const mod of MODULES) {
    out[mod] = {};
    for (const a of ACTIONS) out[mod]![a] = true;
  }
  return out;
}

function password(): string {
  return `mesob-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------

const db = createDb();

if (getTenantByCode(db, 'mesob')) {
  console.log('Tenant "mesob" already exists — nothing to do.');
  console.log('Delete data/factoryos.sqlite and re-run to reseed from scratch.');
  process.exit(0);
}

registerTranslationKeys(db, PLATFORM_KEYS);

console.log('Creating Mesob Salt Factory tenant…');
const { ctx } = createTenant(db, {
  code: 'mesob',
  name: 'Mesob Salt Factory',
  locationNote: 'Mekelle, Tigray, Ethiopia',
  currency: 'ETB',
  timezone: 'Africa/Addis_Ababa',
  brandColor: '#1e6bd6',
});

// --------------------------- Languages -------------------------------------
enableLanguage(ctx, 'en', 'English');
enableLanguage(ctx, 'am', 'አማርኛ (Amharic)');
enableLanguage(ctx, 'ti', 'ትግርኛ (Tigrinya)');

// --------------------------- Units of measure ------------------------------
const kg = createUom(ctx, { code: 'kg', name: 'Kilogram', family: 'mass', factorToBase: 1 });
const ton = createUom(ctx, { code: 't', name: 'Ton', family: 'mass', factorToBase: 1000 });
const quintal = createUom(ctx, { code: 'q', name: 'Quintal', family: 'mass', factorToBase: 100 });
const piece = createUom(ctx, { code: 'pc', name: 'Piece', family: 'count', factorToBase: 1 });

// --------------------------- Items -----------------------------------------
const rawSalt = createItem(ctx, {
  code: 'RAW-SALT',
  name: 'Raw Salt (Afdera)',
  kind: 'raw_material',
  trackingMode: 'lot',
  baseUomId: kg,
  purchasable: true,
  sellable: true, // locked business fact: raw salt can be sold directly in bulk
  attributes: { source: 'Afdera', sourceLocked: true, lotSeqKey: 'lot.raw' },
});
const salt500 = createItem(ctx, {
  code: 'SALT-500G',
  name: 'Iodized Salt 500g',
  kind: 'finished_good',
  trackingMode: 'lot',
  baseUomId: piece,
  unitWeightKg: 0.5,
  sellable: true,
});
const salt1kg = createItem(ctx, {
  code: 'SALT-1KG',
  name: 'Iodized Salt 1kg',
  kind: 'finished_good',
  trackingMode: 'lot',
  baseUomId: piece,
  unitWeightKg: 1,
  sellable: true,
});
const salt50kg = createItem(ctx, {
  code: 'SALT-50KG',
  name: 'Iodized Salt 50kg',
  kind: 'finished_good',
  trackingMode: 'lot',
  baseUomId: piece,
  unitWeightKg: 50,
  sellable: true,
});
const emptySack = createItem(ctx, {
  code: 'EMPTY-SACK',
  name: 'Empty Sack',
  kind: 'other',
  trackingMode: 'none',
  baseUomId: piece,
  sellable: true,
});

// --------------------------- Default supplier ------------------------------
createParty(ctx, {
  kind: 'supplier',
  name: 'Afdera Salt Supplier',
  location: 'Afdera, Afar',
  notes: 'Default raw-salt supplier. Edit or add suppliers as needed.',
});

// --------------------------- Warehouses ------------------------------------
// Locked current master: Warehouse A, B, C only.
createWarehouse(ctx, { code: 'A', name: 'Warehouse A', locationNote: 'Mekelle factory' });
createWarehouse(ctx, { code: 'B', name: 'Warehouse B', locationNote: 'Mekelle factory' });
createWarehouse(ctx, { code: 'C', name: 'Warehouse C', locationNote: 'Mekelle factory' });

// --------------------------- Document numbering ----------------------------
const sequences: Array<[string, string]> = [
  ['receiving', 'RCV-'],
  ['lot.raw', 'RAW-'],
  ['transfer', 'TRF-'],
  ['production.washing', 'WSH-'],
  ['production.iodization', 'IOD-'],
  ['production.packaging', 'PKG-'],
  ['invoice', 'INV-'],
  ['delivery', 'DEL-'],
  ['payment', 'PAY-'],
  ['sack', 'SACK-'],
];
for (const [key, prefix] of sequences) defineSequence(ctx, key, prefix, 4, 1);

// --------------------------- Production stages -----------------------------
const washing = createStage(ctx, {
  code: 'washing',
  nameKey: 'stage.washing',
  sequence: 1,
  inputSource: 'lot',
  outputForm: 'bulk',
  inputItemId: rawSalt,
  docSeqKey: 'production.washing',
});
const iodization = createStage(ctx, {
  code: 'iodization',
  nameKey: 'stage.iodization',
  sequence: 2,
  inputSource: 'prior_batch',
  outputForm: 'bulk',
  requiresQc: true,
  priorStageId: washing,
  attributes: [
    {
      key: 'iodine_added_kg',
      labelKey: 'production.attr.iodine_added_kg',
      type: 'number',
      unit: 'kg',
      required: true,
    },
  ],
  docSeqKey: 'production.iodization',
});
createStage(ctx, {
  code: 'packaging',
  nameKey: 'stage.packaging',
  sequence: 3,
  inputSource: 'prior_batch',
  outputForm: 'packaged_items',
  priorStageId: iodization,
  outputItemIds: [salt500, salt1kg, salt50kg],
  docSeqKey: 'production.packaging',
});

// --------------------------- Roles -----------------------------------------
const ownerRole = createRole(ctx, {
  code: 'owner',
  name: 'Owner / Super Admin',
  dashboardFocus: 'dashboard',
  isOwnerRole: true,
  matrix: fullMatrix(),
});

const opsRole = createRole(ctx, {
  code: 'operations',
  name: 'Operations Manager',
  dashboardFocus: 'production',
  matrix: m([
    ['dashboard', ['view']],
    ['inventory', ['view', 'create', 'edit', 'approve', 'export']],
    ['production', ['view', 'create', 'edit', 'approve', 'export']],
    ['quality', ['view', 'create', 'edit', 'approve', 'export']],
    ['parties', ['view']],
    ['sales', ['view']],
    ['delivery', ['view', 'create', 'edit', 'approve', 'export']],
    ['reports', ['view', 'export']],
  ]),
});

const warehouseRole = createRole(ctx, {
  code: 'warehouse',
  name: 'Warehouse / Store Keeper',
  dashboardFocus: 'inventory',
  matrix: m([
    ['dashboard', ['view']],
    ['inventory', ['view', 'create', 'edit', 'export']],
    ['production', ['view']],
    ['delivery', ['view', 'create', 'edit']],
    ['reports', ['view']],
  ]),
});

const productionRole = createRole(ctx, {
  code: 'production',
  name: 'Production Operator / Supervisor',
  dashboardFocus: 'production',
  matrix: m([
    ['dashboard', ['view']],
    ['inventory', ['view']],
    ['production', ['view', 'create', 'edit']],
    ['quality', ['view', 'create', 'edit']],
    ['reports', ['view']],
  ]),
});

const salesRole = createRole(ctx, {
  code: 'sales',
  name: 'Sales & Customer Officer',
  dashboardFocus: 'sales',
  matrix: m([
    ['dashboard', ['view']],
    ['inventory', ['view']],
    ['parties', ['view', 'create', 'edit']],
    ['sales', ['view', 'create', 'edit', 'view_financial', 'export']],
    ['credit', ['view']],
    ['delivery', ['view', 'create']],
    ['reports', ['view']],
  ]),
});

const financeRole = createRole(ctx, {
  code: 'finance',
  name: 'Finance / Accountant',
  dashboardFocus: 'payments',
  matrix: m([
    ['dashboard', ['view', 'view_financial']],
    ['inventory', ['view']],
    ['parties', ['view', 'edit', 'approve', 'view_financial']],
    ['sales', ['view', 'view_financial', 'export']],
    ['credit', ['view', 'create', 'edit', 'approve', 'view_financial', 'export']],
    ['payments', ['view', 'create', 'edit', 'approve', 'view_financial', 'export']],
    ['delivery', ['view']],
    ['reports', ['view', 'export', 'view_financial']],
    ['settings', ['view']],
  ]),
});

// --------------------------- Users -----------------------------------------
const logins: Array<{ user: string; role: string; pass: string }> = [];
function seedUser(username: string, displayName: string, roleId: string, roleName: string) {
  const pass = password();
  createUser(ctx, { username, displayName, password: pass, roleId });
  logins.push({ user: username, role: roleName, pass });
}
seedUser('owner', 'Mesob Owner', ownerRole, 'Owner / Super Admin');
seedUser('operations', 'Operations Manager', opsRole, 'Operations Manager');
seedUser('warehouse', 'Warehouse Keeper', warehouseRole, 'Warehouse / Store Keeper');
seedUser('production', 'Production Supervisor', productionRole, 'Production Operator / Supervisor');
seedUser('sales', 'Sales Officer', salesRole, 'Sales & Customer Officer');
seedUser('finance', 'Finance Accountant', financeRole, 'Finance / Accountant');

// --------------------------- Settings --------------------------------------
saveSettings(ctx, 'general', {
  companyName: 'Mesob Salt Factory',
  location: 'Mekelle, Tigray, Ethiopia',
  rawSource: 'Afdera, Afar',
  rawSourceLocked: true,
  currency: 'ETB',
  sessionTimeoutMinutes: 720,
  alerts: { credit: true, stock: true },
});
saveSettings(ctx, 'vat', {
  enabled: true,
  ratePct: 15,
  note: 'Sample rate — the authorized admin must confirm the approved VAT rate.',
});
saveSettings(ctx, 'pricing', {
  categories: ['retail', 'wholesale', 'distributor'],
  customPrice: { enabled: true, requiresApproval: true, overrideReasonRequired: true },
  discount: { requiresApproval: true },
  // Unit prices in ETB per item; the authorized admin enters approved values.
  prices: {
    [rawSalt]: { retail: null, wholesale: null, distributor: null },
    [salt500]: { retail: null, wholesale: null, distributor: null },
    [salt1kg]: { retail: null, wholesale: null, distributor: null },
    [salt50kg]: { retail: null, wholesale: null, distributor: null },
  },
});
saveSettings(ctx, 'production', {
  iodization: {
    targetLevel: 'Admin-approved target (set before first real batch)',
  },
});
saveSettings(ctx, 'modules', {
  // Mesob "quick item" screen for empty sacks (pieces, separate from salt stock)
  simpleItemScreens: [
    { route: 'sacks', itemId: emptySack, labelKey: 'nav.sacks', sellDocSeqKey: 'sack' },
  ],
});

// --------------------------- Mesob terminology (EN relabels) ---------------
const enOverrides: Array<[string, string]> = [
  ['nav.receiving', 'Raw Salt Receiving'],
  ['nav.inventory', 'Inventory'],
  ['nav.sales', 'Sales / Invoices'],
  ['nav.credit', 'Credit Management'],
  ['nav.sacks', 'Empty Sacks'],
  ['stage.washing', 'Washing / Production Batch'],
  ['stage.iodization', 'Iodization & Quality Test'],
  ['stage.packaging', 'Packaging'],
];
for (const [key, text] of enOverrides) upsertTranslation(ctx, key, 'en', text, 'active');

// ------------------- Amharic / Tigrinya placeholders -----------------------
// Clearly-editable placeholders, NOT reviewed terminology. The factory's
// authorized admin must review these in Languages & Translations.
const amPlaceholders: Array<[string, string]> = [
  ['nav.dashboard', 'ዳሽቦርድ'],
  ['nav.receiving', 'ጥሬ ጨው መቀበያ'],
  ['nav.inventory', 'ክምችት'],
  ['nav.production', 'ምርት'],
  ['nav.customers', 'ደንበኞች'],
  ['nav.sales', 'ሽያጭ'],
  ['nav.payments', 'ክፍያዎች'],
  ['nav.deliveries', 'ማድረስ'],
  ['nav.reports', 'ሪፖርቶች'],
  ['nav.settings', 'ቅንብሮች'],
  ['shell.signout', 'ውጣ'],
];
const tiPlaceholders: Array<[string, string]> = [
  ['nav.dashboard', 'ዳሽቦርድ'],
  ['nav.receiving', 'ጥረ ጨው ምቕባል'],
  ['nav.inventory', 'ክምችት'],
  ['nav.production', 'ፍርያት'],
  ['nav.customers', 'ዓማዊል'],
  ['nav.sales', 'መሸጣ'],
  ['nav.payments', 'ክፍሊታት'],
  ['nav.reports', 'ጸብጻባት'],
  ['nav.settings', 'ቅንብራት'],
];
for (const [key, text] of amPlaceholders) upsertTranslation(ctx, key, 'am', text, 'placeholder');
for (const [key, text] of tiPlaceholders) upsertTranslation(ctx, key, 'ti', text, 'placeholder');

// --------------------------- Done ------------------------------------------
const loginLines = logins
  .map((l) => `${l.user.padEnd(12)} ${l.pass.padEnd(18)} ${l.role}`)
  .join('\n');
const summary = `
Mesob Salt Factory tenant created.

LOGINS (username / password / role) — keep this file private:
${loginLines}

Next: npm run dev  →  http://localhost:5173
`;
console.log(summary);
const outFile = path.resolve(process.cwd(), '../../data/mesob-logins.txt');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, summary, 'utf8');
console.log(`Login list also saved to ${outFile}`);

// Reference exports for tooling/tests (unused at runtime)
export type { Ctx };
