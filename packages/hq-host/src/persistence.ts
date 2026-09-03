/**
 * Provider-neutral persistence boundary for a hosted JENIFY HQ (Phase 2, Stage 3).
 *
 * Stage 3 deliberately preserves the proven synchronous SQLite semantics while
 * requiring a hosted process to use one explicitly-attested durable mounted
 * volume. Vendor selection remains a Founder gate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openHqDatabase,
  openHqDatabaseReadOnly,
  type HqDatabase,
} from '@factoryos/headquarter/store';

export type HqRuntimeMode = 'local' | 'hosted';
export type HqPersistenceMode = 'local-file' | 'durable-volume';

export const HQ_DURABLE_TOPOLOGY = 'single-process-single-writer' as const;

export interface HqPersistenceConfig {
  runtime: HqRuntimeMode;
  mode: HqPersistenceMode;
  dbPath: string;
  durableRoot?: string;
  backupRoot: string;
  topology: typeof HQ_DURABLE_TOPOLOGY;
}

export interface HqBackupResult {
  path: string;
  sizeBytes: number;
}

export interface HqPersistence {
  db: HqDatabase;
  config: HqPersistenceConfig;
  checkpoint(): void;
  backup(name?: string): Promise<HqBackupResult>;
  healthy(): boolean;
  close(): void;
}

interface DurableDbAnchor {
  fd: number;
  stat: fs.Stats;
  procFdRoot: string;
}

type FdSnapshot = Map<number, fs.Stats>;

function insideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function quickCheck(db: HqDatabase): boolean {
  try {
    const row = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    return Object.values(row ?? {})[0] === 'ok';
  } catch {
    return false;
  }
}

function refuse(log: (line: string) => void, detail: string): null {
  log(`[hq] Persistence refused: ${detail}`);
  return null;
}

function lstatIfPresent(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameOpenObject(a: fs.Stats, b: fs.Stats): boolean {
  return sameFile(a, b) && a.mode === b.mode && a.rdev === b.rdev;
}

/**
 * Hosted Stage 3 needs descriptor-backed evidence about the inode SQLite really
 * opened. Linux procfs exposes process file descriptors without choosing a
 * cloud vendor. Local/workstation mode never needs this gate.
 */
function requireProcFdRoot(): string {
  const procFdRoot = '/proc/self/fd';
  if (process.platform !== 'linux' || !fs.existsSync(procFdRoot)) {
    throw new Error(
      'hosted durable HQ requires Linux /proc/self/fd for opened-inode attestation; local mode is unaffected',
    );
  }
  return procFdRoot;
}

function snapshotProcessFds(procFdRoot: string): FdSnapshot {
  const snapshot: FdSnapshot = new Map();
  for (const entry of fs.readdirSync(procFdRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const fd = Number(entry);
    try {
      snapshot.set(fd, fs.fstatSync(fd));
    } catch {
      // /proc/self/fd can list the directory descriptor used for the listing;
      // it may be closed before fstat. A vanished descriptor is not evidence.
    }
  }
  return snapshot;
}

function procFdTarget(procFdRoot: string, fd: number): string {
  try {
    return fs.realpathSync(path.join(procFdRoot, String(fd)));
  } catch {
    throw new Error(`could not resolve opened file descriptor ${fd} during durable inode attestation`);
  }
}

/**
 * Open and hold the exact pre-existing durable DB inode before SQLite starts.
 *
 * Hosted startup intentionally requires the DB file to be pre-created by the
 * operator/mount initialization. That means this security check never creates a
 * file through a pathname that another process could race outside the attested
 * volume. Final-component symlinks are refused and O_NOFOLLOW gives the open
 * itself the same rule. Parent-component races are caught by resolving the
 * descriptor itself through procfs after open.
 */
function openDurableDbAnchor(config: HqPersistenceConfig): DurableDbAnchor {
  if (!config.durableRoot) throw new Error('durable root missing from durable-volume configuration');
  const procFdRoot = requireProcFdRoot();
  const entry = lstatIfPresent(config.dbPath);
  if (!entry) {
    throw new Error(
      'hosted durable HQ database must already exist as a regular file on the attested volume',
    );
  }
  if (entry.isSymbolicLink()) {
    throw new Error('hosted durable HQ database path must not be a symbolic link');
  }
  if (!entry.isFile()) throw new Error('hosted durable HQ database path is not a regular file');

  const noFollow = fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(config.dbPath, fs.constants.O_RDWR | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('opened durable HQ database inode is not a regular file');
    const target = procFdTarget(procFdRoot, fd);
    if (!insideOrEqual(config.durableRoot, target)) {
      throw new Error('opened durable HQ database inode is outside FACTORYOS_HQ_DURABLE_ROOT');
    }
    return { fd, stat, procFdRoot };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * Prove that SQLite itself holds the same inode we anchored, not merely that the
 * configured pathname looks safe before/after open.
 *
 * The before/after descriptor diff is important: a pre-existing unrelated fd
 * cannot satisfy the proof. Every regular file opened during the synchronous
 * SQLite initialization must also resolve inside the durable root, covering WAL
 * and SHM sidecars if they are opened during the transition to WAL mode.
 */
function assertSqliteOpenedAnchoredDb(
  config: HqPersistenceConfig,
  anchor: DurableDbAnchor,
  before: FdSnapshot,
): void {
  if (!config.durableRoot) throw new Error('durable root missing from durable-volume configuration');

  const currentEntry = lstatIfPresent(config.dbPath);
  if (!currentEntry || currentEntry.isSymbolicLink() || !currentEntry.isFile()) {
    throw new Error('durable HQ database pathname changed during SQLite startup');
  }
  const currentStat = fs.statSync(config.dbPath);
  if (!sameFile(anchor.stat, currentStat)) {
    throw new Error('durable HQ database pathname was replaced during SQLite startup');
  }
  const currentReal = fs.realpathSync(config.dbPath);
  if (!insideOrEqual(config.durableRoot, currentReal)) {
    throw new Error('durable HQ database pathname resolved outside the attested root after open');
  }

  let sqliteMainMatchesAnchor = false;
  const after = snapshotProcessFds(anchor.procFdRoot);
  for (const [fd, stat] of after) {
    const previous = before.get(fd);
    if (previous && sameOpenObject(previous, stat)) continue;
    if (!stat.isFile()) continue;

    const target = procFdTarget(anchor.procFdRoot, fd);
    if (!insideOrEqual(config.durableRoot, target)) {
      throw new Error(`SQLite initialization opened a regular file outside the durable root: ${target}`);
    }
    if (sameFile(anchor.stat, stat)) sqliteMainMatchesAnchor = true;
  }

  if (!sqliteMainMatchesAnchor) {
    throw new Error(
      'could not prove SQLite opened the anchored durable HQ database inode; hosted HQ stays OFF',
    );
  }
}

/**
 * Validate the configured durable DB entry before descriptor attestation.
 * Hosted mode deliberately refuses final-component symlinks, including valid
 * ones, so the configured name and the inode SQLite opens have one unambiguous
 * relationship.
 */
function validateExistingDurableDbEntry(
  dbPath: string,
  log: (line: string) => void,
): boolean {
  const entry = lstatIfPresent(dbPath);
  if (!entry) {
    refuse(
      log,
      'FACTORYOS_HQ_DB must already exist as a regular file on the durable volume before hosted HQ starts.',
    );
    return false;
  }
  if (entry.isSymbolicLink()) {
    refuse(log, 'FACTORYOS_HQ_DB must not be a symbolic link in hosted durable mode.');
    return false;
  }
  if (!entry.isFile()) {
    refuse(log, 'FACTORYOS_HQ_DB exists but is not a regular file.');
    return false;
  }
  return true;
}

export function resolveHqPersistenceConfig(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HqPersistenceConfig | null {
  const rawDbPath = env.FACTORYOS_HQ_DB?.trim();
  if (!rawDbPath) return refuse(log, 'FACTORYOS_HQ_DB is not set.');

  const runtimeRaw = (env.FACTORYOS_HQ_RUNTIME ?? 'local').trim();
  if (runtimeRaw !== 'local' && runtimeRaw !== 'hosted') {
    return refuse(log, 'FACTORYOS_HQ_RUNTIME must be exactly "local" or "hosted".');
  }
  const runtime: HqRuntimeMode = runtimeRaw;

  const persistenceRaw = env.FACTORYOS_HQ_PERSISTENCE?.trim();
  const modeRaw = persistenceRaw || (runtime === 'local' ? 'local-file' : '');
  if (modeRaw !== 'local-file' && modeRaw !== 'durable-volume') {
    return refuse(
      log,
      runtime === 'hosted'
        ? 'hosted runtime requires FACTORYOS_HQ_PERSISTENCE=durable-volume.'
        : 'FACTORYOS_HQ_PERSISTENCE must be "local-file" or "durable-volume".',
    );
  }
  const mode: HqPersistenceMode = modeRaw;

  if (runtime === 'hosted' && mode !== 'durable-volume') {
    return refuse(log, 'hosted HQ cannot use local-file persistence.');
  }

  if (mode === 'local-file') {
    const dbPath = rawDbPath === ':memory:' ? rawDbPath : path.resolve(rawDbPath);
    const backupRoot = path.resolve(
      env.FACTORYOS_HQ_BACKUP_DIR?.trim() || path.join(path.dirname(dbPath), 'backups'),
    );
    return { runtime, mode, dbPath, backupRoot, topology: HQ_DURABLE_TOPOLOGY };
  }

  if (rawDbPath === ':memory:') {
    return refuse(log, 'durable-volume mode can never use :memory:.');
  }
  if (!path.isAbsolute(rawDbPath)) {
    return refuse(log, 'durable-volume FACTORYOS_HQ_DB must be an absolute path.');
  }

  const rawRoot = env.FACTORYOS_HQ_DURABLE_ROOT?.trim();
  if (!rawRoot) return refuse(log, 'durable-volume mode requires FACTORYOS_HQ_DURABLE_ROOT.');
  if (!path.isAbsolute(rawRoot)) {
    return refuse(log, 'FACTORYOS_HQ_DURABLE_ROOT must be an absolute path.');
  }
  if (!fs.existsSync(rawRoot) || !fs.statSync(rawRoot).isDirectory()) {
    return refuse(
      log,
      'FACTORYOS_HQ_DURABLE_ROOT must already exist as the mounted durable volume; it is never auto-created.',
    );
  }

  const durableRoot = fs.realpathSync(rawRoot);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (insideOrEqual(tempRoot, durableRoot)) {
    return refuse(log, 'the OS temporary directory cannot be attested as HQ durable storage.');
  }

  const dbPath = path.resolve(rawDbPath);
  const dbParent = path.dirname(dbPath);
  if (!fs.existsSync(dbParent) || !fs.statSync(dbParent).isDirectory()) {
    return refuse(log, 'the parent directory of FACTORYOS_HQ_DB must already exist on the durable volume.');
  }
  const realDbParent = fs.realpathSync(dbParent);
  if (!insideOrEqual(durableRoot, realDbParent)) {
    return refuse(log, 'FACTORYOS_HQ_DB must live inside FACTORYOS_HQ_DURABLE_ROOT.');
  }
  if (!validateExistingDurableDbEntry(dbPath, log)) return null;

  const backupRoot = path.resolve(
    env.FACTORYOS_HQ_BACKUP_DIR?.trim() || path.join(durableRoot, 'backups'),
  );
  if (!insideOrEqual(durableRoot, backupRoot)) {
    return refuse(log, 'FACTORYOS_HQ_BACKUP_DIR must live inside FACTORYOS_HQ_DURABLE_ROOT.');
  }

  return {
    runtime,
    mode,
    dbPath,
    durableRoot,
    backupRoot,
    topology: HQ_DURABLE_TOPOLOGY,
  };
}

function ensureBackupRoot(config: HqPersistenceConfig): string {
  fs.mkdirSync(config.backupRoot, { recursive: true });
  const realBackupRoot = fs.realpathSync(config.backupRoot);
  if (config.durableRoot && !insideOrEqual(config.durableRoot, realBackupRoot)) {
    throw new Error('HQ backup directory resolved outside the durable root');
  }
  return realBackupRoot;
}

function safeBackupName(name: string | undefined): string {
  if (name != null) {
    const trimmed = name.trim();
    if (!trimmed || path.basename(trimmed) !== trimmed || trimmed === '.' || trimmed === '..') {
      throw new Error('HQ backup name must be a plain filename');
    }
    return trimmed;
  }
  return `hq-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
}

/** Atomically publish a verified file without ever replacing an existing name. */
function publishNoReplace(partial: string, destination: string): void {
  // A same-filesystem hard-link creation is atomic and fails with EEXIST if a
  // concurrent writer already published this destination. Unlike rename(), it
  // never replaces the previous verified recovery point.
  fs.linkSync(partial, destination);
  try {
    fs.unlinkSync(partial);
  } catch {
    // The verified destination is already safely published. A leftover unique
    // partial name is preferable to reporting failure or touching destination.
  }
}

export function openHqPersistence(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HqPersistence | null {
  const config = resolveHqPersistenceConfig(env, log);
  if (!config) return null;

  let db: HqDatabase | undefined;
  let anchor: DurableDbAnchor | undefined;
  let beforeSqliteOpen: FdSnapshot | undefined;
  try {
    if (config.mode === 'durable-volume') {
      anchor = openDurableDbAnchor(config);
      beforeSqliteOpen = snapshotProcessFds(anchor.procFdRoot);
    }

    db = openHqDatabase(config.dbPath);
    db.pragma('busy_timeout = 5000');
    if (config.mode === 'durable-volume') {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('wal_autocheckpoint = 1000');

      const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
      const synchronous = Number(db.pragma('synchronous', { simple: true }));
      if (journalMode !== 'wal' || synchronous !== 2) {
        throw new Error(
          `durable SQLite modes not active (journal_mode=${journalMode}, synchronous=${synchronous}); required WAL/FULL`,
        );
      }
      if (!anchor || !beforeSqliteOpen) {
        throw new Error('durable inode attestation was not initialized');
      }
      assertSqliteOpenedAnchoredDb(config, anchor, beforeSqliteOpen);
    }
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // Preserve the original initialization error while best-effort releasing locks.
      }
    }
    if (anchor) {
      try {
        fs.closeSync(anchor.fd);
      } catch {
        // Preserve the original initialization error.
      }
    }
    return refuse(
      log,
      `could not initialize HQ database: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (anchor) {
    fs.closeSync(anchor.fd);
    anchor = undefined;
  }

  if (!quickCheck(db)) {
    db.close();
    return refuse(log, 'SQLite quick_check failed; the HQ control plane stays OFF.');
  }

  let closed = false;
  const checkpoint = (): void => {
    if (closed) throw new Error('HQ persistence is closed');
    db.pragma('wal_checkpoint(PASSIVE)');
  };

  const handle: HqPersistence = {
    db,
    config,
    checkpoint,
    healthy: () => !closed && quickCheck(db),
    async backup(name?: string): Promise<HqBackupResult> {
      if (closed) throw new Error('HQ persistence is closed');
      const backupRoot = ensureBackupRoot(config);
      const filename = safeBackupName(name);
      const destination = path.join(backupRoot, filename);
      if (lstatIfPresent(destination)) throw new Error(`HQ backup already exists: ${filename}`);

      checkpoint();
      const partial = `${destination}.partial-${randomUUID()}`;
      try {
        await db.backup(partial);
        const check = openHqDatabaseReadOnly(partial);
        const valid = quickCheck(check);
        check.close();
        if (!valid) throw new Error('backup integrity check failed');
        publishNoReplace(partial, destination);
        return { path: destination, sizeBytes: fs.statSync(destination).size };
      } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
      }
    },
    close(): void {
      if (closed) return;
      try {
        db.pragma('wal_checkpoint(PASSIVE)');
      } finally {
        db.close();
        closed = true;
      }
    },
  };

  log(
    `[hq] persistence=${config.mode}, runtime=${config.runtime}, topology=${config.topology}, ` +
      `db=${config.dbPath}`,
  );
  return handle;
}

export function restoreHqBackupToNewFile(
  backupPath: string,
  destinationPath: string,
): HqBackupResult {
  const source = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error('HQ backup does not exist or is not a regular file');
  }
  if (lstatIfPresent(destination)) {
    throw new Error('HQ recovery refuses to overwrite an existing database');
  }
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('HQ recovery destination directory must already exist');
  }

  const sourceDb = openHqDatabaseReadOnly(source);
  const sourceHealthy = quickCheck(sourceDb);
  sourceDb.close();
  if (!sourceHealthy) throw new Error('HQ backup failed integrity check');

  let created: fs.Stats | null = null;
  try {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    created = fs.lstatSync(destination);

    const restoredDb = openHqDatabaseReadOnly(destination);
    const restoredHealthy = quickCheck(restoredDb);
    restoredDb.close();
    if (!restoredHealthy) throw new Error('restored HQ database failed integrity check');

    const current = fs.lstatSync(destination);
    if (!sameFile(created, current)) {
      throw new Error('HQ recovery destination changed during verification');
    }
    return { path: destination, sizeBytes: current.size };
  } catch (error) {
    // Only remove the exact inode created by THIS invocation. If COPYFILE_EXCL
    // lost a race, or another actor replaced the path, their file is untouched.
    if (created) {
      try {
        const current = lstatIfPresent(destination);
        if (current && sameFile(created, current)) fs.rmSync(destination, { force: true });
      } catch {
        // Never trade a recovery failure for deleting an unproven path.
      }
    }
    throw error;
  }
}
