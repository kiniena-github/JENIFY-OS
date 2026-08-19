/**
 * MESOB GO-LIVE: initialize a FRESH production tenant from EXPLICITLY
 * APPROVED configuration — zero operational history, nothing copied by
 * accident. The founder's test data is never touched or carried over.
 *
 * DRY RUN (default — prints exactly what would / would not be copied):
 *   npx tsx src/init-production.ts mesob-prod "Mesob Salt Factory" owner --warehouses A,B,C
 *
 * EXECUTE (after reviewing the preview):
 *   npx tsx src/init-production.ts mesob-prod "Mesob Salt Factory" owner --warehouses A,B,C --yes
 *
 * Optional: --languages en,am,ti   (default: currently enabled languages)
 *
 * The generated owner password is printed ONCE and appended to
 * data/mesob-logins.txt — hand it over securely and change it at first login.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '@factoryos/server/db';
import {
  getTenantByCode,
  initFreshProductionTenant,
  previewFreshProductionTenant,
} from '@factoryos/server/services';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const [code, name, ownerUsername] = positional;
const flag = (n: string) => {
  const raw = args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  if (raw != null) return raw;
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const warehouseCodes = flag('warehouses')?.split(',').map((x) => x.trim()).filter(Boolean);
const languageCodes = flag('languages')?.split(',').map((x) => x.trim()).filter(Boolean);
const confirmed = args.includes('--yes');

if (!code || !name || !ownerUsername || !warehouseCodes?.length) {
  console.error(
    'Usage: npx tsx src/init-production.ts <new-code> "<Factory Name>" <owner-username> --warehouses A,B,C [--languages en,am,ti] [--yes]',
  );
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

const selection = { warehouseCodes, languageCodes };
const preview = previewFreshProductionTenant(db, source.id, selection);
console.log('================ FRESH PRODUCTION TENANT — PREVIEW ================');
console.log('WILL COPY:');
for (const [k, v] of Object.entries(preview.willCopy)) {
  console.log(`  ${k}: ${Array.isArray(v) ? v.join(' | ') : v}`);
}
console.log('WILL NOT COPY:');
for (const [k, v] of Object.entries(preview.willNotCopy)) {
  console.log(`  ${k}: ${v}`);
}
console.log('====================================================================');

if (!confirmed) {
  console.log('DRY RUN ONLY — nothing was created. Re-run with --yes to execute.');
  process.exit(0);
}

const ownerPassword = `mesob-${crypto.randomBytes(4).toString('hex')}`;
const { tenantId } = initFreshProductionTenant(db, {
  sourceTenantId: source.id,
  code,
  name,
  ownerUsername,
  ownerPassword,
  selection,
});

const here = path.dirname(fileURLToPath(import.meta.url));
const loginsPath = path.resolve(here, '../../../data/mesob-logins.txt');
fs.appendFileSync(
  loginsPath,
  `\n[${new Date().toISOString().slice(0, 10)}] PRODUCTION tenant '${code}':\n${ownerUsername}   ${ownerPassword}   Owner (change at first login)\n`,
);

console.log(`Fresh production tenant '${name}' created (id ${tenantId}).`);
console.log(`Owner login: ${ownerUsername} / ${ownerPassword}  (also appended to data/mesob-logins.txt)`);
console.log('Zero operational history — approved configuration only. Change the password at first login.');
