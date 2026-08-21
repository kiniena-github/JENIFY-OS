import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

/**
 * Operational data belongs in safe LOCAL app storage, never inside a cloud-
 * synced folder (OneDrive syncing an active WAL is a known corruption vector).
 * Resolution order: explicit FACTORYOS_DB → %LOCALAPPDATA%/JenifyOS (once the
 * relocation script has placed the DB there) → legacy repo data/ path.
 */
export function localAppDataDbPath(): string | null {
  const base = process.env.LOCALAPPDATA;
  return base ? path.join(base, 'JenifyOS', 'factoryos.sqlite') : null;
}

export function legacyDbPath(): string {
  return path.resolve(here, '../../../../data/factoryos.sqlite');
}

export function defaultDbPath(): string {
  if (process.env.FACTORYOS_DB) return process.env.FACTORYOS_DB;
  const local = localAppDataDbPath();
  if (local && fs.existsSync(local)) return local;
  return legacyDbPath();
}

const AUTO_BACKUP_INTERVAL_MS = 24 * 3600_000;
const AUTO_BACKUP_KEEP = 14;

/**
 * Codified backup discipline: at most one automatic snapshot per day, taken at
 * startup after a WAL checkpoint and a quick integrity check, pruned to the
 * newest 14. Failure to back up never blocks the application from starting —
 * it is logged loudly instead.
 */
function maybeAutoBackup(sqlite: Database.Database, dbPath: string): void {
  try {
    const backupsDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const existing = fs
      .readdirSync(backupsDir)
      .filter((f) => f.startsWith('auto-') && f.endsWith('.sqlite'))
      .sort();
    const newest = existing.at(-1);
    if (newest) {
      const age = Date.now() - fs.statSync(path.join(backupsDir, newest)).mtimeMs;
      if (age < AUTO_BACKUP_INTERVAL_MS) return;
    }
    const check = sqlite.pragma('quick_check', { simple: true });
    if (check !== 'ok') {
      console.error(`[jenify-backup] integrity quick_check reported: ${check} — backup skipped, investigate!`);
      return;
    }
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(backupsDir, `auto-${stamp}.sqlite`);
    fs.copyFileSync(dbPath, target);
    for (const f of existing.slice(0, Math.max(0, existing.length + 1 - AUTO_BACKUP_KEEP))) {
      fs.unlinkSync(path.join(backupsDir, f));
    }
    console.log(`[jenify-backup] automatic backup written: ${target}`);
  } catch (err) {
    console.error('[jenify-backup] automatic backup FAILED:', err);
  }
}

/** Open (and migrate) a FactoryOS database. Pass ':memory:' for tests. */
export function createDb(dbPath: string = defaultDbPath()): Db {
  if (dbPath !== ':memory:') {
    // Guard against silently starting an EMPTY database at the legacy path
    // after a relocation: the renamed rollback artifact marks that the real
    // data lives elsewhere (or must be restored) — refuse to fresh-create.
    if (!fs.existsSync(dbPath) && fs.existsSync(`${dbPath}.pre-relocation`)) {
      throw new Error(
        `Refusing to create a NEW empty database at ${dbPath}: a .pre-relocation artifact exists. ` +
          `The operational DB was relocated (check %LOCALAPPDATA%/JenifyOS) or must be restored.`,
      );
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const preExisting = dbPath !== ':memory:' && fs.existsSync(dbPath);
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  // daily snapshot runs BEFORE migrations so a bad migration always has a
  // same-day pre-migration backup to restore from
  if (preExisting) maybeAutoBackup(sqlite, dbPath);
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export { schema };
