/**
 * Restore the operational database from a backup file — with safety:
 * the backup is integrity-checked first, and the current database is kept
 * as `factoryos.sqlite.pre-restore` so a bad restore is always reversible.
 *
 * Run from packages/server (STOP the server first):
 *   npx tsx scripts/restore-db.ts <path-to-backup.sqlite>
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { defaultDbPath } from '../src/db/index.js';

const backup = process.argv[2];
if (!backup || !fs.existsSync(backup)) {
  console.error('Usage: npx tsx scripts/restore-db.ts <path-to-backup.sqlite>');
  process.exit(1);
}

// verify the backup opens and passes an integrity check BEFORE touching anything
const probe = new Database(backup, { readonly: true });
const check = probe.pragma('quick_check', { simple: true });
probe.close();
if (check !== 'ok') {
  console.error(`Backup failed integrity quick_check ('${check}') — restore aborted.`);
  process.exit(1);
}

const dbPath = defaultDbPath();
if (fs.existsSync(dbPath)) {
  fs.copyFileSync(dbPath, `${dbPath}.pre-restore`);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(`${dbPath}${ext}`)) fs.unlinkSync(`${dbPath}${ext}`);
  }
}
fs.copyFileSync(backup, dbPath);
console.log(`Restored ${backup} -> ${dbPath}`);
console.log(`Previous database kept at ${dbPath}.pre-restore (rollback: copy it back).`);
console.log('Start the server to verify, then remove the .pre-restore file when satisfied.');
