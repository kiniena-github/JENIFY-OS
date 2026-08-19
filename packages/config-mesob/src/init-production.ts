/**
 * MESOB GO-LIVE: initialize a FRESH production tenant from the validated
 * Mesob test configuration — zero operational history, approved config only.
 *
 * This does NOT touch the existing founder test tenant in any way; it adds a
 * new, clean tenant alongside it. Archive any test-only warehouses (e.g.
 * "test warehouse") in Settings BEFORE running so they are not carried over.
 *
 * Run:  npx tsx src/init-production.ts <new-code> "<Factory Name>" <owner-username>
 * e.g.  npx tsx src/init-production.ts mesob-prod "Mesob Salt Factory" owner
 *
 * The generated owner password is printed ONCE and appended to
 * data/mesob-logins.txt — hand it over securely and change it at first login.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '@factoryos/server/db';
import { getTenantByCode, initFreshProductionTenant } from '@factoryos/server/services';

const [code, name, ownerUsername] = process.argv.slice(2);
if (!code || !name || !ownerUsername) {
  console.error('Usage: npx tsx src/init-production.ts <new-code> "<Factory Name>" <owner-username>');
  process.exit(1);
}

const db = createDb();
const source = getTenantByCode(db, 'mesob');
if (!source) {
  console.error("Source tenant 'mesob' not found — nothing to clone.");
  process.exit(1);
}
if (getTenantByCode(db, code)) {
  console.error(`Tenant '${code}' already exists. Choose another code.`);
  process.exit(1);
}

const ownerPassword = `mesob-${crypto.randomBytes(4).toString('hex')}`;
const { tenantId } = initFreshProductionTenant(db, {
  sourceTenantId: source.id,
  code,
  name,
  ownerUsername,
  ownerPassword,
});

const here = path.dirname(fileURLToPath(import.meta.url));
const loginsPath = path.resolve(here, '../../../data/mesob-logins.txt');
fs.appendFileSync(
  loginsPath,
  `\n[${new Date().toISOString().slice(0, 10)}] PRODUCTION tenant '${code}':\n${ownerUsername}   ${ownerPassword}   Owner (change at first login)\n`,
);

console.log(`Fresh production tenant '${name}' created (id ${tenantId}).`);
console.log(`Owner login: ${ownerUsername} / ${ownerPassword}  (also appended to data/mesob-logins.txt)`);
console.log('Zero operational history — configuration only. Change the password at first login.');
