/**
 * Manual backup: checkpointed, integrity-checked, hash-verified snapshot of
 * the current operational database into its `backups/` folder.
 *
 * Run from packages/server:  npx tsx scripts/backup-db.ts
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultDbPath } from '../src/db/index.js';

const dbPath = defaultDbPath();
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath);
const check = db.pragma('quick_check', { simple: true });
if (check !== 'ok') {
  db.close();
  console.error(`integrity quick_check reported '${check}' — backup aborted, investigate.`);
  process.exit(1);
}
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

const backupsDir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const target = path.join(backupsDir, `manual-${stamp}.sqlite`);
fs.copyFileSync(dbPath, target);

const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (sha(dbPath) !== sha(target)) {
  console.error('Hash mismatch — backup file removed.');
  fs.unlinkSync(target);
  process.exit(1);
}
console.log(`Backup written and verified: ${target}`);
