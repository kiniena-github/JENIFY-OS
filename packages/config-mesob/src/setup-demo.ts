/**
 * MESOB DEMO — NOT PRODUCTION.
 *
 * Builds an isolated demo environment for remote founder-guided testing:
 *  - consistent snapshot of the current Mesob database (VACUUM INTO — safe
 *    while the live server runs) into %LOCALAPPDATA%\JenifyOS\demo\
 *  - the Founder database is never written; the demo is a separate file
 *  - tenant footer label set to "MESOB DEMO — NOT PRODUCTION" in the DEMO copy
 *  - a dedicated demo user (display name "Henok") with the Operations Manager
 *    role — no Owner/Super Admin, no user management, no settings editing
 *  - every OTHER demo account gets its password rotated to a random unknown
 *    value so seeded dev credentials cannot be reused against the demo
 *  - the generated password is written ONLY to the demo folder (never git)
 *
 * Run from packages/config-mesob:  npx tsx src/setup-demo.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq, and, ne } from 'drizzle-orm';
import { createDb, defaultDbPath, schema } from '@factoryos/server/db';
import { createUser, resetPassword, writeAudit, getTenantByCode } from '@factoryos/server/services';

const sourcePath = defaultDbPath();
const demoDir = path.join(process.env.LOCALAPPDATA ?? '', 'JenifyOS', 'demo');
const demoDb = path.join(demoDir, 'mesob-demo.sqlite');

if (!fs.existsSync(sourcePath)) {
  console.error(`Source database not found: ${sourcePath}`);
  process.exit(1);
}
fs.mkdirSync(demoDir, { recursive: true });
for (const f of [demoDb, `${demoDb}-wal`, `${demoDb}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// 1. consistent online snapshot of the live DB
const src = new Database(sourcePath, { readonly: false });
src.exec(`VACUUM INTO '${demoDb.replace(/'/g, "''")}'`);
src.close();

// 2. branding assets are served from the DB's folder
const srcBranding = path.join(path.dirname(sourcePath), 'branding');
if (fs.existsSync(srcBranding)) {
  fs.cpSync(srcBranding, path.join(demoDir, 'branding'), { recursive: true });
}

// 3. open the DEMO copy through the platform (runs migrations, backups etc.)
const db = createDb(demoDb);
const tenant = getTenantByCode(db, 'mesob');
if (!tenant) {
  console.error('mesob tenant missing in snapshot');
  process.exit(1);
}
const ctx = { db, tenantId: tenant.id, user: null };

// label the environment unmistakably (sidebar footer shows locationNote)
db.update(schema.tenants)
  .set({ locationNote: 'MESOB DEMO — NOT PRODUCTION' })
  .where(eq(schema.tenants.id, tenant.id))
  .run();

// 4. rotate every existing account's password to a random unknown value
//    (audited resetPassword also revokes any copied sessions)
const rotated = db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(eq(schema.users.tenantId, tenant.id))
  .all();
for (const u of rotated) {
  resetPassword(ctx, u.id, crypto.randomBytes(24).toString('base64url'));
}

// 5. dedicated demo user with the Operations Manager role
const opsRole = db
  .select()
  .from(schema.roles)
  .where(and(eq(schema.roles.tenantId, tenant.id), eq(schema.roles.code, 'operations')))
  .get();
if (!opsRole) {
  console.error("role 'operations' not found in snapshot");
  process.exit(1);
}
const henokPassword = `demo-${crypto.randomBytes(5).toString('hex')}`;
createUser(ctx, {
  username: 'henok',
  displayName: 'Henok',
  password: henokPassword,
  roleId: opsRole.id,
});
writeAudit(ctx, {
  module: 'users',
  action: 'user_create',
  entity: 'tenant',
  entityId: tenant.id,
  summary: 'DEMO environment prepared for remote founder-guided testing (Henok, Operations Manager)',
});

// 6. credentials note stays OUTSIDE the repository entirely
fs.writeFileSync(
  path.join(demoDir, 'DEMO-NOTES.txt'),
  [
    'MESOB DEMO — NOT PRODUCTION',
    `created: ${new Date().toISOString()}`,
    `database: ${demoDb}`,
    'user: henok',
    `password: ${henokPassword}`,
    'role: Operations Manager (no owner/admin powers)',
    'All other accounts in this demo copy have rotated random passwords.',
    '',
  ].join('\n'),
);

console.log('Demo environment ready.');
console.log(`  demo database : ${demoDb}`);
console.log(`  demo user     : henok / ${henokPassword}  (Operations Manager)`);
console.log(`  notes file    : ${path.join(demoDir, 'DEMO-NOTES.txt')}`);
console.log('Founder database was only READ (VACUUM INTO snapshot).');
