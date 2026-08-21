/**
 * Relocate the operational database out of the (OneDrive-synced) repo into
 * safe local app storage: %LOCALAPPDATA%\JenifyOS\.
 *
 * Safety contract:
 *  1. WAL is checkpointed, then the source file is hash-verified after copy.
 *  2. The original stays in place, renamed `factoryos.sqlite.pre-relocation`
 *     (rollback: rename it back and delete the LOCALAPPDATA copy).
 *  3. Branding assets move with the DB (they are served from the DB's folder).
 *  4. Nothing is deleted.
 *
 * STOP THE SERVER FIRST. Run from packages/server:  npx tsx scripts/relocate-db.ts
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const legacy = path.resolve(here, '../../../data/factoryos.sqlite');
const localBase = process.env.LOCALAPPDATA;
if (!localBase) {
  console.error('LOCALAPPDATA is not set — cannot determine safe local storage.');
  process.exit(1);
}
const targetDir = path.join(localBase, 'JenifyOS');
const target = path.join(targetDir, 'factoryos.sqlite');

if (!fs.existsSync(legacy)) {
  console.error(`Nothing to relocate: ${legacy} does not exist (already relocated?).`);
  process.exit(1);
}
if (fs.existsSync(target)) {
  console.error(`Refusing to overwrite existing ${target}. Resolve manually.`);
  process.exit(1);
}

const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 1. checkpoint WAL so the .sqlite file alone is the complete database
const db = new Database(legacy);
const check = db.pragma('quick_check', { simple: true });
if (check !== 'ok') {
  db.close();
  console.error(`integrity quick_check reported '${check}' — NOT relocating a suspect database.`);
  process.exit(1);
}
// H1 guard: TRUNCATE checkpoint reports busy>0 when another connection
// (a still-running server) holds the database — refuse, or writes committed
// between our copy and the rename would silently vanish.
const cp = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
if (cp[0]?.busy) {
  db.close();
  console.error('Another process is using this database (checkpoint busy). STOP the server first.');
  process.exit(1);
}
db.close();

// 2. copy + verify
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(legacy, target);
const srcHash = sha256(legacy);
const dstHash = sha256(target);
if (srcHash !== dstHash) {
  fs.unlinkSync(target);
  console.error('Hash mismatch after copy — relocation aborted, nothing changed.');
  process.exit(1);
}

// 3. branding assets live next to the DB — move a copy alongside it
const legacyBranding = path.join(path.dirname(legacy), 'branding');
if (fs.existsSync(legacyBranding)) {
  fs.cpSync(legacyBranding, path.join(targetDir, 'branding'), { recursive: true });
}

// 4. keep the original as the rollback artifact (renamed so defaultDbPath
//    resolution switches to the LOCALAPPDATA copy)
fs.renameSync(legacy, `${legacy}.pre-relocation`);
for (const ext of ['-wal', '-shm']) {
  const f = `${legacy}${ext}`;
  if (fs.existsSync(f)) fs.renameSync(f, `${legacy}.pre-relocation${ext}`);
}

console.log('Relocation complete and verified.');
console.log(`  new operational DB : ${target}`);
console.log(`  sha256             : ${dstHash}`);
console.log(`  rollback artifact  : ${legacy}.pre-relocation`);
console.log('Restart the server; it now resolves the LOCALAPPDATA location automatically.');
console.log('Rollback: delete the LOCALAPPDATA copy and rename the .pre-relocation file back.');
