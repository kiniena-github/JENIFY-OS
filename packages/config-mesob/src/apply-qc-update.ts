/**
 * One-off Mesob configuration update: QC role split + configurable target ppm.
 * Applies to the EXISTING local database without reseeding — idempotent, and
 * every change goes through the audited platform services.
 *
 * Run:  npx tsx src/apply-qc-update.ts   (from packages/config-mesob)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  type Ctx,
} from '@factoryos/server/services';
import type { PermissionMatrix, ModuleId, ActionId } from '@factoryos/shared';

function m(entries: Array<[ModuleId, ActionId[]]>): PermissionMatrix {
  const out: PermissionMatrix = {};
  for (const [mod, acts] of entries) {
    out[mod] = {};
    for (const a of acts) out[mod]![a] = true;
  }
  return out;
}

const db = createDb();
const tenant = getTenantByCode(db, 'mesob');
if (!tenant) {
  console.error('Tenant "mesob" not found — nothing to update.');
  process.exit(1);
}

// Act as the owner account so audit events carry a real actor.
const ownerUser = db
  .select()
  .from(schema.users)
  .where(and(eq(schema.users.tenantId, tenant.id), eq(schema.users.username, 'owner')))
  .get();
const ctx: Ctx = {
  db,
  tenantId: tenant.id,
  user: ownerUser ? buildSessionUser(db, ownerUser.id) : null,
};

// 1. Quality Management role (skip if it already exists)
const existingQuality = db
  .select()
  .from(schema.roles)
  .where(and(eq(schema.roles.tenantId, tenant.id), eq(schema.roles.code, 'quality')))
  .get();
let qualityRoleId = existingQuality?.id;
if (!qualityRoleId) {
  qualityRoleId = createRole(ctx, {
    code: 'quality',
    name: 'Quality Management',
    dashboardFocus: 'production',
    matrix: m([
      ['dashboard', ['view']],
      ['inventory', ['view']],
      ['production', ['view']],
      ['quality', ['view', 'create', 'edit', 'approve', 'export']],
      ['reports', ['view', 'export']],
    ]),
  });
  console.log('Created role: Quality Management');
} else {
  console.log('Role Quality Management already exists — skipped');
}

// 2. Quality user (skip if it already exists)
const existingUser = db
  .select()
  .from(schema.users)
  .where(and(eq(schema.users.tenantId, tenant.id), eq(schema.users.username, 'quality')))
  .get();
if (!existingUser) {
  const pass = `mesob-${crypto.randomBytes(4).toString('hex')}`;
  createUser(ctx, {
    username: 'quality',
    displayName: 'Quality Manager',
    password: pass,
    roleId: qualityRoleId,
  });
  const loginsFile = path.resolve(process.cwd(), '../../data/mesob-logins.txt');
  fs.appendFileSync(
    loginsFile,
    `\nquality      ${pass.padEnd(18)} Quality Management\n`,
    'utf8',
  );
  console.log(`Created user 'quality' (password ${pass} — also appended to mesob-logins.txt)`);
} else {
  console.log("User 'quality' already exists — skipped");
}

// 3. Production Operator loses QC recording/approval (new matrix version)
const productionRole = db
  .select()
  .from(schema.roles)
  .where(and(eq(schema.roles.tenantId, tenant.id), eq(schema.roles.code, 'production')))
  .get();
if (productionRole) {
  const version = saveRoleMatrix(
    ctx,
    productionRole.id,
    m([
      ['dashboard', ['view']],
      ['inventory', ['view']],
      ['production', ['view', 'create', 'edit']],
      ['quality', ['view']],
      ['reports', ['view']],
    ]),
  );
  console.log(`Production Operator matrix saved as version ${version} (quality: view only)`);
}

// 4. Configurable target ppm (preserves prior versions; tests keep their own target)
const production = getSettings<{ iodization?: { targetPpm?: string } }>(ctx, 'production');
if (!production?.data.iodization?.targetPpm) {
  const { version } = saveSettings(ctx, 'production', {
    iodization: { targetPpm: '30-40 ppm' },
  });
  console.log(`Settings 'production' v${version}: target iodine level = 30-40 ppm (editable in Settings)`);
} else {
  console.log(`Target ppm already configured: ${production.data.iodization.targetPpm}`);
}

console.log('QC configuration update complete. Existing operational data untouched.');
