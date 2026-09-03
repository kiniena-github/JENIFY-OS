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
import { createHash, randomUUID } from 'node:crypto';
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

interface DurableDirectoryAnchor {
  fd: number;
  stat: fs.Stats;
  mountId: number;
  target: string;
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

function availableProcFdRoot(): string | undefined {
  const procFdRoot = '/proc/self/fd';
  return process.platform === 'linux' && fs.existsSync(procFdRoot) ? procFdRoot : undefined;
}

function requireProcFdRoot(): string {
  const procFdRoot = availableProcFdRoot();
  if (!procFdRoot) {
    throw new Error(
      'hosted durable HQ requires Linux /proc/self/fd for opened-inode attestation; local mode is unaffected',
    );
  }
  return procFdRoot;
}

function procFdInfoPath(procFdRoot: string, fd: number): string {
  return path.join(path.dirname(procFdRoot), 'fdinfo', String(fd));
}

function procFdMountId(procFdRoot: string, fd: number): number {
  let info: string;
  try {
    info = fs.readFileSync(procFdInfoPath(procFdRoot, fd), 'utf8');
  } catch {
    throw new Error(`could not read mount identity for opened file descriptor ${fd}`);
  }
  const match = /^mnt_id:\s*(\d+)\s*$/m.exec(info);
  const mountId = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(mountId) || mountId < 0) {
    throw new Error(`could not parse mount identity for opened file descriptor ${fd}`);
  }
  return mountId;
}

function snapshotProcessFds(procFdRoot: string): FdSnapshot {
  const snapshot: FdSnapshot = new Map();
  for (const entry of fs.readdirSync(procFdRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const fd = Number(entry);
    try {
      snapshot.set(fd, fs.fstatSync(fd));
    } catch {
      // A descriptor may vanish between readdir and fstat; that is not evidence.
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

function openDirectoryAnchor(
  directory: string,
  procFdRoot: string,
  label: string,
): DurableDirectoryAnchor {
  const directoryFlag = fs.constants.O_DIRECTORY ?? 0;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | directoryFlag | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) throw new Error(`${label} is not an opened directory`);
    return {
      fd,
      stat,
      mountId: procFdMountId(procFdRoot, fd),
      target: procFdTarget(procFdRoot, fd),
      procFdRoot,
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function closeDirectoryAnchor(anchor: DurableDirectoryAnchor | undefined): void {
  if (!anchor) return;
  fs.closeSync(anchor.fd);
}

function openDurableRootAnchor(config: HqPersistenceConfig, procFdRoot: string): DurableDirectoryAnchor {
  if (!config.durableRoot) throw new Error('durable root missing from durable-volume configuration');
  const root = openDirectoryAnchor(config.durableRoot, procFdRoot, 'FACTORYOS_HQ_DURABLE_ROOT');
  if (path.resolve(root.target) !== path.resolve(config.durableRoot)) {
    closeDirectoryAnchor(root);
    throw new Error('FACTORYOS_HQ_DURABLE_ROOT changed during mount attestation');
  }
  return root;
}

function assertSameDurableMount(
  root: DurableDirectoryAnchor,
  candidateStat: fs.Stats,
  candidateMountId: number,
  label: string,
): void {
  if (candidateStat.dev !== root.stat.dev) {
    throw new Error(`${label} is on a different filesystem from FACTORYOS_HQ_DURABLE_ROOT`);
  }
  if (candidateMountId !== root.mountId) {
    throw new Error(`${label} is on a different mount from FACTORYOS_HQ_DURABLE_ROOT`);
  }
}

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

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(config.dbPath, fs.constants.O_RDWR | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('opened durable HQ database inode is not a regular file');
    const target = procFdTarget(procFdRoot, fd);
    if (!insideOrEqual(config.durableRoot, target)) {
      throw new Error('opened durable HQ database inode is outside FACTORYOS_HQ_DURABLE_ROOT');
    }

    const root = openDurableRootAnchor(config, procFdRoot);
    try {
      assertSameDurableMount(
        root,
        stat,
        procFdMountId(procFdRoot, fd),
        'opened durable HQ database inode',
      );
    } finally {
      closeDirectoryAnchor(root);
    }

    return { fd, stat, procFdRoot };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function anchoredSqliteOpenPath(anchor: DurableDbAnchor): string {
  return path.join(anchor.procFdRoot, String(anchor.fd));
}

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

  const root = openDurableRootAnchor(config, anchor.procFdRoot);
  try {
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
      assertSameDurableMount(
        root,
        stat,
        procFdMountId(anchor.procFdRoot, fd),
        `SQLite initialization file ${target}`,
      );
      if (sameFile(anchor.stat, stat)) sqliteMainMatchesAnchor = true;
    }

    if (!sqliteMainMatchesAnchor) {
      throw new Error(
        'could not prove SQLite opened the anchored durable HQ database inode; hosted HQ stays OFF',
      );
    }
  } finally {
    closeDirectoryAnchor(root);
  }
}

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

function openAttestedBackupRoot(
  config: HqPersistenceConfig,
  realBackupRoot: string,
): DurableDirectoryAnchor | undefined {
  if (config.mode !== 'durable-volume') return undefined;
  if (!config.durableRoot) throw new Error('durable root missing from durable-volume configuration');

  const procFdRoot = requireProcFdRoot();
  const root = openDurableRootAnchor(config, procFdRoot);
  let backup: DurableDirectoryAnchor | undefined;
  try {
    backup = openDirectoryAnchor(realBackupRoot, procFdRoot, 'HQ backup directory');
    if (!insideOrEqual(config.durableRoot, backup.target)) {
      throw new Error('HQ backup directory descriptor resolved outside the durable root');
    }
    assertSameDurableMount(root, backup.stat, backup.mountId, 'HQ backup directory');
    return backup;
  } catch (error) {
    closeDirectoryAnchor(backup);
    throw error;
  } finally {
    closeDirectoryAnchor(root);
  }
}

function anchoredDirectoryChild(anchor: DurableDirectoryAnchor, filename: string): string {
  return path.join(anchor.procFdRoot, String(anchor.fd), filename);
}

function assertDirectoryPathStillAnchored(anchor: DurableDirectoryAnchor, directory: string): void {
  const current = fs.statSync(directory);
  if (!sameFile(anchor.stat, current)) {
    throw new Error('HQ backup directory changed during backup creation');
  }
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

function unlinkIfSame(candidate: string, expected: fs.Stats): void {
  try {
    const current = lstatIfPresent(candidate);
    if (current && !current.isSymbolicLink() && sameFile(current, expected)) fs.unlinkSync(candidate);
  } catch {
    // Never delete a path whose identity cannot be proven.
  }
}

/**
 * Durably commit the directory entry that publishes `child`.
 *
 * fsyncing the file inode alone is not enough on filesystems that require an
 * explicit directory fsync for the new name to survive a crash. This never
 * creates, replaces or removes anything, so the no-overwrite and exclusive
 * destination guarantees are untouched; it only refuses to report durability
 * it cannot prove.
 *
 * The child-identity proof runs everywhere. The directory fsync itself is a
 * POSIX operation: Windows exposes no directory handle to `fsync` through Node
 * and commits directory metadata with the file, so requiring it there would
 * break portable local/workstation backup and recovery rather than strengthen
 * it. Hosted durable mode is Linux-only and always performs it.
 */
function fsyncDirectoryEntry(directory: string, child: string, expectedChild: fs.Stats): void {
  const entry = lstatIfPresent(child);
  if (!entry || entry.isSymbolicLink() || !sameFile(entry, expectedChild)) {
    throw new Error(`${child} changed before its directory entry was committed`);
  }
  if (process.platform === 'win32') return;

  const directoryFlag = fs.constants.O_DIRECTORY ?? 0;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | directoryFlag);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory()) throw new Error(`${directory} is not an opened directory`);
    if (!sameFile(opened, fs.statSync(directory))) {
      throw new Error(`${directory} changed before its directory entry was committed`);
    }
    const stillLinked = lstatIfPresent(child);
    if (!stillLinked || stillLinked.isSymbolicLink() || !sameFile(stillLinked, expectedChild)) {
      throw new Error(`${child} changed before its directory entry was committed`);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function publishVerifiedNoReplace(
  partial: string,
  destination: string,
  verifiedPartial: fs.Stats,
): fs.Stats {
  const beforeLink = lstatIfPresent(partial);
  if (!beforeLink || beforeLink.isSymbolicLink() || !sameFile(beforeLink, verifiedPartial)) {
    throw new Error('HQ backup partial changed after integrity verification');
  }

  fs.linkSync(partial, destination);
  let linked: fs.Stats | null = null;
  try {
    linked = fs.lstatSync(destination);
    if (linked.isSymbolicLink() || !sameFile(linked, verifiedPartial)) {
      throw new Error('HQ backup publication did not link the verified partial inode');
    }

    unlinkIfSame(partial, verifiedPartial);

    const finalStat = lstatIfPresent(destination);
    if (!finalStat || finalStat.isSymbolicLink() || !sameFile(finalStat, verifiedPartial)) {
      throw new Error('HQ backup destination changed during publication');
    }
    return finalStat;
  } catch (error) {
    if (linked) unlinkIfSame(destination, linked);
    throw error;
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

    const sqliteOpenPath = anchor ? anchoredSqliteOpenPath(anchor) : config.dbPath;
    db = openHqDatabase(sqliteOpenPath);
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

      const filename = safeBackupName(name);
      const backupRoot = ensureBackupRoot(config);
      const backupAnchor = openAttestedBackupRoot(config, backupRoot);
      const destination = path.join(backupRoot, filename);
      const operationDestination = backupAnchor
        ? anchoredDirectoryChild(backupAnchor, filename)
        : destination;
      const partialFilename = `${filename}.partial-${randomUUID()}`;
      const partial = backupAnchor
        ? anchoredDirectoryChild(backupAnchor, partialFilename)
        : path.join(backupRoot, partialFilename);
      let partialFd: number | undefined;
      let reservedPartial: fs.Stats | undefined;

      try {
        if (lstatIfPresent(operationDestination)) {
          throw new Error(`HQ backup already exists: ${filename}`);
        }

        // Reserve the exact inode SQLite is allowed to write BEFORE the backup
        // runs. `O_EXCL` proves we created it, and the retained descriptor —
        // not the mutable pathname — is what every later step verifies and
        // publishes. A same-permission actor can no longer expose a partial
        // pathname to substitution between `db.backup()` and verification.
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        partialFd = fs.openSync(
          partial,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollow,
          0o600,
        );
        reservedPartial = fs.fstatSync(partialFd);
        if (!reservedPartial.isFile()) throw new Error('HQ backup partial is not a regular file');

        // On Linux SQLite writes through our own descriptor path, so the object
        // it opens IS the reserved inode; no pathname it resolves is reachable
        // by another process. Elsewhere the reserved pathname is used and the
        // identity re-proved below, which fails closed on any substitution.
        const procFdRoot = availableProcFdRoot();
        const descriptorPath = procFdRoot ? path.join(procFdRoot, String(partialFd)) : undefined;

        checkpoint();
        await db.backup(descriptorPath ?? partial);

        const afterBackup = lstatIfPresent(partial);
        if (!afterBackup || afterBackup.isSymbolicLink() || !sameFile(afterBackup, reservedPartial)) {
          throw new Error('HQ backup partial pathname was substituted around the SQLite backup');
        }
        const written = fs.fstatSync(partialFd);
        if (!sameOpenObject(reservedPartial, written)) {
          throw new Error('HQ backup partial inode changed during the SQLite backup');
        }
        if (written.size === 0) {
          throw new Error('SQLite did not write the pre-reserved HQ backup inode');
        }

        const verificationPath = descriptorPath ?? partial;
        const check = openHqDatabaseReadOnly(verificationPath);
        const valid = quickCheck(check);
        check.close();
        if (!valid) throw new Error('backup integrity check failed');

        const afterVerification = lstatIfPresent(partial);
        if (
          !afterVerification ||
          afterVerification.isSymbolicLink() ||
          !sameFile(afterVerification, reservedPartial)
        ) {
          throw new Error('HQ backup partial changed during integrity verification');
        }

        // The reserved partial still has a visible directory entry until it is
        // published, so a same-permission actor can open it by name and
        // overwrite the inode IN PLACE with another valid SQLite image. Inode
        // identity cannot see that, so the verified bytes are pinned here and
        // re-proved after publication: what gets published is what passed
        // quick_check, or the backup fails closed.
        const verifiedState = proveOpenFileContents(partialFd);

        fs.fsyncSync(partialFd);
        if (backupAnchor) assertDirectoryPathStillAnchored(backupAnchor, backupRoot);
        const published = publishVerifiedNoReplace(partial, operationDestination, reservedPartial);
        try {
          const publishedState = proveOpenFileContents(partialFd);
          if (publishedState.digest !== verifiedState.digest) {
            throw new Error('HQ backup contents changed between integrity verification and publication');
          }
          if (backupAnchor) {
            assertDirectoryPathStillAnchored(backupAnchor, backupRoot);
            fs.fsyncSync(backupAnchor.fd);
          } else {
            // Local-file mode has no attested directory descriptor, so the
            // published directory entry is committed here instead.
            fsyncDirectoryEntry(backupRoot, destination, reservedPartial);
          }
        } catch (error) {
          // The published name is this operation's own inode, so withdrawing it
          // never touches another process's file.
          unlinkIfSame(operationDestination, reservedPartial);
          throw error;
        }
        return { path: destination, sizeBytes: published.size };
      } catch (error) {
        if (reservedPartial) unlinkIfSame(partial, reservedPartial);
        throw error;
      } finally {
        if (partialFd != null) {
          try {
            fs.closeSync(partialFd);
          } catch {
            // Preserve the primary backup result/error.
          }
        }
        closeDirectoryAnchor(backupAnchor);
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

const RECOVERY_CHUNK_BYTES = 1024 * 1024;

interface ContentProof {
  digest: string;
  size: number;
}

/**
 * Content identity of an OPEN descriptor, read positionally so a concurrent
 * reader/writer cannot move the shared file offset underneath us.
 */
function proveOpenFileContents(fd: number): ContentProof {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(RECOVERY_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { digest: hash.digest('hex'), size: position };
}

function copyExactFileDescriptor(sourceFd: number, destinationFd: number): ContentProof {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(RECOVERY_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;

    let written = 0;
    while (written < bytesRead) {
      const bytesWritten = fs.writeSync(
        destinationFd,
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (bytesWritten <= 0) throw new Error('HQ recovery could not write restored database bytes');
      written += bytesWritten;
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  fs.ftruncateSync(destinationFd, position);
  fs.fsyncSync(destinationFd);
  return { digest: hash.digest('hex'), size: position };
}

function verifyOpenRecoveryFile(
  fd: number,
  fallbackPath: string,
  expected: fs.Stats,
  procFdRoot: string | undefined,
  label: string,
): void {
  const verificationPath = procFdRoot ? path.join(procFdRoot, String(fd)) : fallbackPath;
  if (!procFdRoot) {
    const before = lstatIfPresent(fallbackPath);
    if (!before || before.isSymbolicLink() || !sameFile(before, expected)) {
      throw new Error(`${label} pathname changed before integrity verification`);
    }
  }

  const check = openHqDatabaseReadOnly(verificationPath);
  const healthy = quickCheck(check);
  check.close();
  if (!healthy) throw new Error(`${label} failed integrity check`);

  if (!procFdRoot) {
    const after = lstatIfPresent(fallbackPath);
    if (!after || after.isSymbolicLink() || !sameFile(after, expected)) {
      throw new Error(`${label} pathname changed during integrity verification`);
    }
  }
}

export function restoreHqBackupToNewFile(
  backupPath: string,
  destinationPath: string,
): HqBackupResult {
  const procFdRoot = availableProcFdRoot();
  const source = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;

  const sourceEntry = lstatIfPresent(source);
  if (!sourceEntry || sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
    throw new Error('HQ backup does not exist as a regular non-symlink file');
  }
  if (lstatIfPresent(destination)) {
    throw new Error('HQ recovery refuses to overwrite an existing database');
  }
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('HQ recovery destination directory must already exist');
  }

  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  let created: fs.Stats | null = null;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const sourceStat = fs.fstatSync(sourceFd);
    if (!sourceStat.isFile()) throw new Error('HQ backup opened inode is not a regular file');

    // Retaining the descriptor closes pathname substitution but NOT in-place
    // writes to the same inode. The verified state is therefore pinned by
    // content, not by inode identity: every later step must reproduce exactly
    // these bytes or the restore fails closed.
    const verifiedState = proveOpenFileContents(sourceFd);
    verifyOpenRecoveryFile(sourceFd, source, sourceStat, procFdRoot, 'HQ backup');

    destinationFd = fs.openSync(
      destination,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollow,
      0o600,
    );
    created = fs.fstatSync(destinationFd);
    if (!created.isFile()) throw new Error('HQ recovery destination is not a regular file');

    const copied = copyExactFileDescriptor(sourceFd, destinationFd);
    if (copied.digest !== verifiedState.digest) {
      throw new Error('HQ backup contents changed between integrity verification and the restore copy');
    }

    // The source may also have been mutated in place after the last byte we
    // read; re-proving it here is what makes "the copy is the verified state"
    // a claim rather than an assumption.
    const sourceAfterCopy = proveOpenFileContents(sourceFd);
    if (sourceAfterCopy.digest !== verifiedState.digest) {
      throw new Error('HQ backup contents changed during the restore copy');
    }

    const destinationState = proveOpenFileContents(destinationFd);
    if (destinationState.digest !== verifiedState.digest) {
      throw new Error('restored HQ database does not hold the verified backup contents');
    }

    verifyOpenRecoveryFile(
      destinationFd,
      destination,
      created,
      procFdRoot,
      'restored HQ database',
    );

    const current = lstatIfPresent(destination);
    if (!current || current.isSymbolicLink() || !sameFile(created, current)) {
      throw new Error('HQ recovery destination changed during verification');
    }

    // Only now is the destination name durable enough to report success.
    fsyncDirectoryEntry(parent, destination, created);

    // The destination inode is reachable by name for the whole verification
    // window, so identity checks alone cannot rule out an in-place rewrite
    // around them. This is the last act before success: the bytes being
    // reported as restored are re-proved against the verified source state.
    const committedState = proveOpenFileContents(destinationFd);
    if (committedState.digest !== verifiedState.digest) {
      throw new Error('restored HQ database changed after integrity verification');
    }

    const finalStat = fs.fstatSync(destinationFd);
    return { path: destination, sizeBytes: finalStat.size };
  } catch (error) {
    if (created) {
      try {
        const current = lstatIfPresent(destination);
        if (current && !current.isSymbolicLink() && sameFile(created, current)) {
          fs.rmSync(destination, { force: true });
        }
      } catch {
        // Never trade a recovery failure for deleting an unproven path.
      }
    }
    throw error;
  } finally {
    if (destinationFd != null) {
      try {
        fs.closeSync(destinationFd);
      } catch {
        // Preserve the primary recovery result/error.
      }
    }
    if (sourceFd != null) {
      try {
        fs.closeSync(sourceFd);
      } catch {
        // Preserve the primary recovery result/error.
      }
    }
  }
}
