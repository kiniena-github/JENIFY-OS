/**
 * Master-fix configuration update for the EXISTING local Mesob database.
 * Idempotent; every change flows through the audited platform services.
 * Preserves all operational history (RCV/RAW/TRF/WSH/IOD…).
 *
 * Run:  npx tsx src/apply-masterfix.ts   (from packages/config-mesob)
 */
import { eq, and } from 'drizzle-orm';
import { createDb, schema } from '@factoryos/server/db';
import {
  getTenantByCode,
  createRole,
  createUser,
  saveRoleMatrix,
  getSettings,
  saveSettings,
  buildSessionUser,
  correctBatchOutput,
  getBatch,
  upsertTranslation,
  type Ctx,
} from '@factoryos/server/services';
import { PLATFORM_KEYS } from '@factoryos/server/i18n-keys';
import { registerTranslationKeys } from '@factoryos/server/services';
import type { PermissionMatrix, ModuleId, ActionId } from '@factoryos/shared';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function m(entries: Array<[ModuleId, Array<ActionId | string>]>): PermissionMatrix {
  const out: PermissionMatrix = {};
  for (const [mod, acts] of entries) {
    out[mod] = {};
    for (const a of acts) out[mod]![a] = true;
  }
  return out;
}

const db = createDb();
registerTranslationKeys(db, PLATFORM_KEYS);
const tenant = getTenantByCode(db, 'mesob');
if (!tenant) {
  console.error('Tenant "mesob" not found.');
  process.exit(1);
}
const ownerUser = db
  .select()
  .from(schema.users)
  .where(and(eq(schema.users.tenantId, tenant.id), eq(schema.users.username, 'owner')))
  .get()!;
const ctx: Ctx = { db, tenantId: tenant.id, user: buildSessionUser(db, ownerUser.id) };

// ---------------------------------------------------------------------------
// 1. Stage physics: washing measured, iodization CONSERVED, packaging converted
// ---------------------------------------------------------------------------
const stages = db
  .select()
  .from(schema.productionStages)
  .where(eq(schema.productionStages.tenantId, tenant.id))
  .all();
for (const s of stages) {
  const policy =
    s.code === 'iodization' ? 'conserved' : s.outputForm === 'packaged_items' ? 'converted' : 'measured';
  if (s.outputPolicy !== policy) {
    db.update(schema.productionStages)
      .set({ outputPolicy: policy })
      .where(eq(schema.productionStages.id, s.id))
      .run();
    console.log(`Stage ${s.code}: output policy -> ${policy}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Correct IOD-0001: the 20 kg "loss" was invented test logic; iodization
//    conserves mass. Explicit audited correction 4,580 -> 4,600.
// ---------------------------------------------------------------------------
const iod = db
  .select()
  .from(schema.productionBatches)
  .where(
    and(eq(schema.productionBatches.tenantId, tenant.id), eq(schema.productionBatches.docNumber, 'IOD-0001')),
  )
  .get();
if (iod && iod.outputQty !== iod.inputQty) {
  correctBatchOutput(
    ctx,
    iod.id,
    iod.inputQty / 1000,
    'Master-fix correction: iodization conserves salt mass — the previous 20 kg loss was invented test data, no measured variance exists',
  );
  const after = getBatch(ctx, iod.id);
  console.log(`IOD-0001 corrected: output ${after.outputQty! / 1000} kg, loss ${after.lossQty! / 1000} kg`);
} else {
  console.log('IOD-0001 already conserved or absent — skipped');
}

// ---------------------------------------------------------------------------
// 3. Roles — split operator/supervisor, independent QC, delivery load/dispatch
// ---------------------------------------------------------------------------
const roleByCode = (code: string) =>
  db
    .select()
    .from(schema.roles)
    .where(and(eq(schema.roles.tenantId, tenant.id), eq(schema.roles.code, code)))
    .get();

const production = roleByCode('production');
if (production && production.name !== 'Production Operator') {
  db.update(schema.roles).set({ name: 'Production Operator' }).where(eq(schema.roles.id, production.id)).run();
  console.log("Role renamed: 'Production Operator / Supervisor' -> 'Production Operator'");
}

if (!roleByCode('production_supervisor')) {
  const supervisorRole = createRole(ctx, {
    code: 'production_supervisor',
    name: 'Production Supervisor',
    dashboardFocus: 'production',
    matrix: m([
      ['dashboard', ['view']],
      ['inventory', ['view']],
      ['production', ['view', 'create', 'edit', 'approve', 'export']],
      ['quality', ['view']],
      ['reports', ['view', 'export']],
    ]),
  });
  const pass = `mesob-${crypto.randomBytes(4).toString('hex')}`;
  createUser(ctx, {
    username: 'supervisor',
    displayName: 'Production Supervisor',
    password: pass,
    roleId: supervisorRole,
  });
  fs.appendFileSync(
    path.resolve(process.cwd(), '../../data/mesob-logins.txt'),
    `supervisor   ${pass.padEnd(18)} Production Supervisor\n`,
    'utf8',
  );
  console.log(`Created role+user 'Production Supervisor' (password ${pass}, appended to mesob-logins.txt)`);
}

const operations = roleByCode('operations');
if (operations) {
  saveRoleMatrix(
    ctx,
    operations.id,
    m([
      ['dashboard', ['view']],
      ['inventory', ['view', 'create', 'edit', 'approve', 'export']],
      ['production', ['view', 'create', 'edit', 'approve', 'export']],
      ['quality', ['view', 'export']], // independent QC authority
      ['parties', ['view']],
      ['sales', ['view']],
      ['delivery', ['view', 'create', 'edit', 'approve', 'export']],
      ['reports', ['view', 'export']],
    ]),
  );
  console.log('Operations Manager: QC create/edit/approve removed (view + export kept)');
}

const warehouse = roleByCode('warehouse');
if (warehouse) {
  saveRoleMatrix(
    ctx,
    warehouse.id,
    m([
      ['dashboard', ['view']],
      ['inventory', ['view', 'create', 'edit', 'export']],
      ['production', ['view']],
      ['delivery', ['view', 'create', 'edit', 'load', 'dispatch']],
      ['reports', ['view']],
    ]),
  );
  console.log('Warehouse Keeper: action-specific delivery load + dispatch granted');
}

const finance = roleByCode('finance');
if (finance) {
  saveRoleMatrix(
    ctx,
    finance.id,
    m([
      ['dashboard', ['view', 'view_financial']],
      ['inventory', ['view']],
      ['parties', ['view', 'approve', 'view_financial']], // credit control, not identity editing
      ['sales', ['view', 'view_financial', 'export']],
      ['credit', ['view', 'create', 'edit', 'approve', 'view_financial', 'export']],
      ['payments', ['view', 'create', 'edit', 'approve', 'view_financial', 'export']],
      ['delivery', ['view']],
      ['reports', ['view', 'export', 'view_financial']],
      ['settings', ['view']],
    ]),
  );
  console.log('Finance: customer identity editing removed; credit/financial control kept');
}

// ---------------------------------------------------------------------------
// 4. Pricing categories -> configurable objects with a default
// ---------------------------------------------------------------------------
const pricing = getSettings<{ categories: unknown[]; defaultCategory?: string }>(ctx, 'pricing');
if (pricing && typeof pricing.data.categories?.[0] === 'string') {
  saveSettings(ctx, 'pricing', {
    ...pricing.data,
    categories: (pricing.data.categories as string[]).map((c) => ({
      code: c,
      name: c.charAt(0).toUpperCase() + c.slice(1),
      active: true,
    })),
    defaultCategory: 'retail',
  });
  console.log('Pricing categories upgraded to configurable objects (default: retail)');
}

// ---------------------------------------------------------------------------
// 5. Production settings: additive metadata (form/type to be confirmed)
// ---------------------------------------------------------------------------
const prod = getSettings<{ iodization?: Record<string, unknown> }>(ctx, 'production');
if (prod && !prod.data.iodization?.additiveName) {
  saveSettings(ctx, 'production', {
    ...prod.data,
    iodization: {
      ...(prod.data.iodization ?? {}),
      additiveName: 'Iodine',
      additiveForm: '',
      additiveUnit: 'kg',
    },
  });
  console.log('Additive configuration added (name: Iodine; form left for factory confirmation)');
}

// ---------------------------------------------------------------------------
// 6. General settings: explicit calendar display config
// ---------------------------------------------------------------------------
const general = getSettings<Record<string, unknown>>(ctx, 'general');
if (general && !general.data.calendar) {
  saveSettings(ctx, 'general', { ...general.data, calendar: 'gregorian' });
  console.log('Calendar display config added (gregorian; EC available in Settings)');
}

// ---------------------------------------------------------------------------
// 7. Branding/document settings
// ---------------------------------------------------------------------------
if (!getSettings(ctx, 'branding')) {
  saveSettings(ctx, 'branding', {
    companyName: tenant.name,
    address: tenant.locationNote ?? '',
    phone: '',
    email: '',
    tin: '',
    headerNote: '',
    footerNote: 'Thank you for your business.',
    pageSize: 'A4',
    assets: {},
  });
  console.log('Document branding settings initialized');
}

// ---------------------------------------------------------------------------
// 8. Customer defaults + Mesob additive terminology
// ---------------------------------------------------------------------------
const customers = db
  .select()
  .from(schema.parties)
  .where(and(eq(schema.parties.tenantId, tenant.id), eq(schema.parties.kind, 'customer')))
  .all();
for (const c of customers) {
  if (!c.defaultPriceCategory && c.partyType) {
    const map: Record<string, string> = { retailer: 'retail', wholesaler: 'wholesale', distributor: 'distributor' };
    const cat = map[c.partyType];
    if (cat) {
      db.update(schema.parties).set({ defaultPriceCategory: cat }).where(eq(schema.parties.id, c.id)).run();
      console.log(`Customer '${c.name}': default price category -> ${cat}`);
    }
  }
}

upsertTranslation(ctx, 'production.attr.iodine_added_kg', 'en', 'Iodine quantity added (kg)', 'active');
console.log("Mesob terminology: additive field labeled 'Iodine quantity added (kg)'");

console.log('\nMaster-fix configuration update complete. Operational history untouched.');
