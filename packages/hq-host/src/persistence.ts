/**
 * Provider-neutral persistence boundary for a hosted JENIFY HQ (Phase 2, Stage 3).
 *
 * The HQ core deliberately keeps its proven synchronous SQLite semantics in this
 * stage. Replacing the engine while also moving the process would change
 * transactions, idempotency, leases and fencing at the same time — exactly the
 * invariants Stage 3 is meant to preserve. Hosted mode therefore means one HQ
 * process using SQLite on an explicitly-attested durable mounted volume.
 *
 * No cloud vendor appears here. Choosing/provisioning the actual volume remains
 * a Founder gate. This module only makes the storage contract explicit and
 * refuses configurations that would quietly turn a hosted HQ into an ephemeral
 * one.
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

/** Stage-3 topology. Horizontal/multi-writer rollout is a later explicit gate. */
export const HQ_DURABLE_TOPOLOGY = 'single-process-single-writer' as const;

export interface HqPersistenceConfig {
  runtime: HqRuntimeMode;
  mode: HqPersistenceMode;
  dbPath: string;
  /** Present only for durable-volume mode. */
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
  /** Force committed WAL pages toward the durable database file. */
  checkpoint(): void;
  /** Create and integrity-check a point-in-time SQLite backup. */
  backup(name?: string): Promise<HqBackupResult>;
  /** Integrity check of the live opened database. */
  healthy(): boolean;
  close(): void;
}

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

/**
 * Parse the storage contract without opening the database.
 *
 * New variables introduced by Stage 3:
 *
 *   FACTORYOS_HQ_RUNTIME=local|hosted
 *     Unset stays `local`, preserving every existing workstation/test setup.
 *
 *   FACTORYOS_HQ_PERSISTENCE=local-file|durable-volume
 *     Unset is `local-file` only for local runtime. Hosted runtime MUST say
 *     `durable-volume` explicitly.
 *
 *   FACTORYOS_HQ_DURABLE_ROOT=/mounted/volume
 *     Required for durable-volume mode. It must already exist: creating a
 *     missing directory ourselves could make an ephemeral container directory
 *     look like a mounted durable volume.
 *
 *   FACTORYOS_HQ_BACKUP_DIR=/mounted/volume/backups
 *     Optional. Defaults to <durable-root>/backups for durable mode, or a
 *     sibling `backups` directory for local mode.
 */
export function resolveHqPersistenceConfig(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HqPersistenceConfig | null {
  const rawDbPath = env.FACTORYOS_HQ_DB?.trim();
  if (!rawDbPath) {
    return refuse(log, 'FACTORYOS_HQ_DB is not set.');
  }

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
    return {
      runtime,
      mode,
      dbPath,
      backupRoot,
      topology: HQ_DURABLE_TOPOLOGY,
    };
  }

  if (rawDbPath === ':memory:') {
    return refuse(log, 'durable-volume mode can never use :memory:.');
  }
  if (!path.isAbsolute(rawDbPath)) {
    return refuse(log, 'durable-volume FACTORYOS_HQ_DB must be an absolute path.');
  }

  const rawRoot = env.FACTORYOS_HQ_DURABLE_ROOT?.trim();
  if (!rawRoot) {
    return refuse(log, 'durable-volume mode requires FACTORYOS_HQ_DURABLE_ROOT.');
  }
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
  if (fs.existsSync(dbPath)) {
    if (!fs.statSync(dbPath).isFile()) {
      return refuse(log, 'FACTORYOS_HQ_DB exists but is not a regular file.');
    }
    const realDb = fs.realpathSync(dbPath);
    if (!insideOrEqual(durableRoot, realDb)) {
      return refuse(log, 'FACTORYOS_HQ_DB resolves outside FACTORYOS_HQ_DURABLE_ROOT.');
    }
  }

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

/**
 * Open the configured store. Hosted mode gets stronger SQLite durability and a
 * single explicit storage owner; all higher-level HQ semantics remain unchanged.
 */
export function openHqPersistence(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HqPersistence | null {
  const config = resolveHqPersistenceConfig(env, log);
  if (!config) return null;

  let db: HqDatabase;
  try {
    db = openHqDatabase(config.dbPath);
    db.pragma('busy_timeout = 5000');
    if (config.mode === 'durable-volume') {
      // WAL + FULL synchronous keeps the proven transaction model while making
      // a committed hosted write wait for durable storage rather than only RAM.
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('wal_autocheckpoint = 1000');
    }
  } catch (error) {
    return refuse(log, `could not open HQ database: ${error instanceof Error ? error.message : 'unknown error'}`);
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
      if (fs.existsSync(destination)) throw new Error(`HQ backup already exists: ${filename}`);

      checkpoint();
      const partial = `${destination}.partial-${randomUUID()}`;
      try {
        await db.backup(partial);
        const check = openHqDatabaseReadOnly(partial);
        const valid = quickCheck(check);
        check.close();
        if (!valid) throw new Error('backup integrity check failed');
        fs.renameSync(partial, destination);
        return { path: destination, sizeBytes: fs.statSync(destination).size };
      } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
      }
    },
    close(): void {
      if (closed) return;
      // Best-effort checkpoint before releasing the file. SQLite still owns the
      // transactional guarantee if this cannot truncate because a reader exists.
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

/**
 * Recovery primitive that never overwrites a live database.
 *
 * The operator restores into a NEW file, verifies it, and can then switch the
 * configured path in a separate controlled action. This avoids turning a
 * recovery helper into a destructive production overwrite button.
 */
export function restoreHqBackupToNewFile(
  backupPath: string,
  destinationPath: string,
): HqBackupResult {
  const source = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error('HQ backup does not exist or is not a regular file');
  }
  if (fs.existsSync(destination)) {
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

  try {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const restoredDb = openHqDatabaseReadOnly(destination);
    const restoredHealthy = quickCheck(restoredDb);
    restoredDb.close();
    if (!restoredHealthy) throw new Error('restored HQ database failed integrity check');
    return { path: destination, sizeBytes: fs.statSync(destination).size };
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}
