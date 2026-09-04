/**
 * Stage 3 exact-head durability corrections (issue #244).
 *
 * Three defects are pinned here, each with a deterministic hostile actor driven
 * from a real syscall boundary rather than from timing luck:
 *
 * 1. the backup partial pathname being substituted after `db.backup()` resolves
 *    and before verification opens it;
 * 2. the retained recovery source being mutated IN PLACE — same inode, so a
 *    descriptor cannot notice — after verification and before/during the copy;
 * 3. a successful recovery reporting durability before the destination
 *    directory entry itself was committed.
 */

import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openHqDatabase, openHqDatabaseReadOnly } from '@factoryos/headquarter/store';
import { openHqPersistence, restoreHqBackupToNewFile } from '../src/index.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const roots: string[] = [];

function testRoot(prefix = '.hq-durability-race-'): string {
  const root = mkdtempSync(join(process.cwd(), prefix));
  roots.push(root);
  return root;
}

function hostedPersistence(root: string) {
  const dbPath = join(root, 'hq.sqlite');
  writeFileSync(dbPath, '');
  attestDurableMountBoundary(root);
  const persistence = openHqPersistence(
    {
      FACTORYOS_HQ_DB: dbPath,
      FACTORYOS_HQ_RUNTIME: 'hosted',
      FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
      FACTORYOS_HQ_DURABLE_ROOT: root,
      FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE: 'operator:test-durable-volume',
    },
    () => {},
  );
  expect(persistence).not.toBeNull();
  return persistence!;
}

function createProbeDb(file: string, value: string): void {
  const db = openHqDatabase(file);
  db.exec('CREATE TABLE IF NOT EXISTS durability_probe(value TEXT NOT NULL)');
  db.exec('DELETE FROM durability_probe');
  db.prepare('INSERT INTO durability_probe(value) VALUES (?)').run(value);
  db.close();
}

function readProbe(file: string): string {
  const db = openHqDatabaseReadOnly(file);
  const row = db.prepare('SELECT value FROM durability_probe LIMIT 1').get() as { value: string };
  db.close();
  return row.value;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backup verification is bound to the inode SQLite wrote', () => {
  it('publishes the exact pre-reserved inode the backup was written into', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const realOpenSync = fs.openSync.bind(fs);
    let reservedIno: number | undefined;

    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      const fd = (realOpenSync as any)(candidate, flags, mode);
      if (
        reservedIno === undefined &&
        String(candidate).includes('.partial-') &&
        typeof flags === 'number' &&
        (flags & fs.constants.O_EXCL) !== 0
      ) {
        reservedIno = fs.fstatSync(fd).ino;
      }
      return fd;
    }) as any);

    try {
      const result = await persistence.backup('reserved.sqlite');
      // The partial inode is reserved with O_EXCL BEFORE db.backup() runs, so
      // there is never a moment where an unbound pathname holds the backup.
      expect(reservedIno).toBeDefined();
      expect(fs.statSync(result.path).ino).toBe(reservedIno);
      expect(result.sizeBytes).toBeGreaterThan(0);
    } finally {
      persistence.close();
    }
  });

  it('refuses a hostile partial substituted after db.backup() and before verification', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const hostile = join(root, 'hostile-valid.sqlite');
    createProbeDb(hostile, 'hostile');
    const hostileBytes = readFileSync(hostile);
    const backupRoot = join(root, 'backups');
    const destination = join(backupRoot, 'reserved-proof.sqlite');

    // The exact window the reviewer named: db.backup() has resolved, the
    // partial exists, and verification has not opened anything yet.
    const realBackup = persistence.db.backup.bind(persistence.db);
    let substituted = false;
    vi.spyOn(persistence.db, 'backup').mockImplementation((async (
      partialPath: string,
      options?: unknown,
    ) => {
      const progress = await (realBackup as any)(partialPath, options);
      if (!substituted) {
        substituted = true;
        // Same-permission actor: unlink the real partial and drop a
        // structurally valid SQLite image at the very same pathname.
        const partialName = fs
          .readdirSync(backupRoot)
          .find((entry) => entry.includes('.partial-'));
        expect(partialName).toBeDefined();
        const partial = join(backupRoot, partialName!);
        fs.renameSync(partial, join(root, 'stolen-partial.sqlite'));
        fs.writeFileSync(partial, hostileBytes);
      }
      return progress;
    }) as typeof persistence.db.backup);

    try {
      await expect(persistence.backup('reserved-proof.sqlite')).rejects.toThrow(
        /partial pathname was substituted around the SQLite backup/,
      );
      expect(substituted).toBe(true);
      expect(existsSync(destination)).toBe(false);
      // Nothing hostile was ever published, and an unproven pathname is never
      // deleted on our behalf either.
      const published = fs
        .readdirSync(backupRoot)
        .filter((entry) => !entry.includes('.partial-'));
      expect(published).toEqual([]);
    } finally {
      persistence.close();
    }
  });
});

describe('backup re-proves the published bytes, not just the inode', () => {
  it('refuses an in-place rewrite of the reserved partial before publication', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const hostile = join(root, 'hostile-in-place.sqlite');
    createProbeDb(hostile, 'hostile-same-inode');
    const hostileBytes = readFileSync(hostile);
    const backupRoot = join(root, 'backups');
    const destination = join(backupRoot, 'inplace-proof.sqlite');

    // The reserved partial keeps a visible directory entry until it is
    // published, so a same-permission actor can open it BY NAME and rewrite
    // the very inode we verified. dev/ino never changes, so only a content
    // proof can catch this.
    const realLinkSync = fs.linkSync.bind(fs);
    let rewritten = false;
    vi.spyOn(fs, 'linkSync').mockImplementation(((existingPath, newPath) => {
      if (!rewritten && String(newPath).endsWith('/inplace-proof.sqlite')) {
        rewritten = true;
        const partialName = fs.readdirSync(backupRoot).find((e) => e.includes('.partial-'));
        expect(partialName).toBeDefined();
        const partial = join(backupRoot, partialName!);
        const before = fs.statSync(partial).ino;
        fs.writeFileSync(partial, hostileBytes);
        expect(fs.statSync(partial).ino).toBe(before);
      }
      return realLinkSync(existingPath, newPath);
    }) as typeof fs.linkSync);

    try {
      await expect(persistence.backup('inplace-proof.sqlite')).rejects.toThrow(
        /contents changed between integrity verification and publication/,
      );
      expect(rewritten).toBe(true);
      // The hostile bytes must not survive as a published recovery point.
      expect(existsSync(destination)).toBe(false);
    } finally {
      persistence.close();
    }
  });
});

describe('rejected durable work is withdrawn durably', () => {
  it('fsyncs the backup directory after withdrawing a rejected publication', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const hostile = join(root, 'hostile-withdraw.sqlite');
    createProbeDb(hostile, 'hostile-withdrawn');
    const hostileBytes = readFileSync(hostile);
    const backupRoot = join(root, 'backups');
    const destination = join(backupRoot, 'withdraw.sqlite');

    const realLinkSync = fs.linkSync.bind(fs);
    const realFsyncSync = fs.fsyncSync.bind(fs);
    const fsynced: number[] = [];
    let rewritten = false;
    let backupDirectoryFd: number | undefined;

    const realOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      const fd = (realOpenSync as any)(candidate, flags, mode);
      if (String(candidate) === backupRoot) backupDirectoryFd = fd;
      return fd;
    }) as any);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      fsynced.push(fd);
      return realFsyncSync(fd);
    }) as any);
    vi.spyOn(fs, 'linkSync').mockImplementation(((existingPath, newPath) => {
      if (!rewritten && String(newPath).endsWith('/withdraw.sqlite')) {
        rewritten = true;
        const partialName = fs.readdirSync(backupRoot).find((e) => e.includes('.partial-'));
        expect(partialName).toBeDefined();
        fs.writeFileSync(join(backupRoot, partialName!), hostileBytes);
      }
      return realLinkSync(existingPath, newPath);
    }) as typeof fs.linkSync);

    try {
      await expect(persistence.backup('withdraw.sqlite')).rejects.toThrow(/contents changed/);
      expect(rewritten).toBe(true);
      expect(existsSync(destination)).toBe(false);
      // Unlinking the published name is a cache update like creating it was,
      // so the withdrawal itself must be committed.
      expect(backupDirectoryFd).toBeDefined();
      expect(fsynced).toContain(backupDirectoryFd!);
    } finally {
      persistence.close();
    }
  });

  it('fsyncs the destination directory after withdrawing a rejected restore', () => {
    if (process.platform !== 'linux') return;

    const root = testRoot('.hq-recovery-withdraw-');
    const source = join(root, 'source.sqlite');
    const hostile = join(root, 'hostile.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'verified-original');
    createProbeDb(hostile, 'hostile-withdrawn-restore');
    const hostileBytes = readFileSync(hostile);

    const realOpenSync = fs.openSync.bind(fs);
    const realFsyncSync = fs.fsyncSync.bind(fs);
    const directoryFds: number[] = [];
    const fsynced: number[] = [];
    let rewritten = false;

    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      if (!rewritten && String(candidate) === root) {
        rewritten = true;
        fs.writeFileSync(destination, hostileBytes);
      }
      const fd = (realOpenSync as any)(candidate, flags, mode);
      if (String(candidate) === root) directoryFds.push(fd);
      return fd;
    }) as any);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      fsynced.push(fd);
      return realFsyncSync(fd);
    }) as any);

    expect(() => restoreHqBackupToNewFile(source, destination)).toThrow(
      /restored HQ database changed after integrity verification/,
    );
    expect(rewritten).toBe(true);
    expect(existsSync(destination)).toBe(false);
    // The entry was already committed before the rewrite was detected, so the
    // removal has to be committed too — a second directory fsync.
    expect(directoryFds.length).toBeGreaterThanOrEqual(2);
    expect(fsynced).toContain(directoryFds[directoryFds.length - 1]);
  });
});

describe('portable local durability', () => {
  it('commits a local-file backup without requiring a platform directory fsync', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot('.hq-local-durability-');
    const dbPath = join(root, 'hq.sqlite');
    const persistence = openHqPersistence(
      { FACTORYOS_HQ_DB: dbPath, FACTORYOS_HQ_RUNTIME: 'local' },
      () => {},
    );
    expect(persistence).not.toBeNull();

    // Windows exposes no directory handle to fsync through Node, so opening a
    // directory this way fails outright there. Model that faithfully: fake the
    // platform AND make any directory open throw the way Windows would. The
    // identity proof must still run, and local backup/recovery must still work.
    const realOpenSync = fs.openSync.bind(fs);
    const directoryOpens: string[] = [];
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      const target = String(candidate);
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(target).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (isDirectory) {
        directoryOpens.push(target);
        const error = new Error(`EPERM: operation not permitted, open '${target}'`);
        (error as NodeJS.ErrnoException).code = 'EPERM';
        throw error;
      }
      return (realOpenSync as any)(candidate, flags, mode);
    }) as any);

    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const result = await persistence!.backup('portable.sqlite');
      expect(existsSync(result.path)).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);

      const restored = join(root, 'restored.sqlite');
      const recovery = restoreHqBackupToNewFile(result.path, restored);
      expect(recovery.sizeBytes).toBe(result.sizeBytes);
      expect(readFileSync(restored).equals(readFileSync(result.path))).toBe(true);

      // No directory was opened at all: the durability step is skipped on the
      // platform that cannot support it, rather than failing the operation.
      expect(directoryOpens).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      persistence!.close();
    }
  });
});

describe('recovery proves the copied bytes are the verified source state', () => {
  it('refuses an in-place source mutation applied after verification and before the copy', () => {
    if (process.platform !== 'linux') return;

    const root = testRoot('.hq-recovery-freeze-');
    const source = join(root, 'source.sqlite');
    const hostile = join(root, 'hostile.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'verified-original');
    createProbeDb(hostile, 'hostile-in-place');
    // A different length as well as different content, so the copy itself
    // reads bytes that never passed verification.
    const hostileBytes = Buffer.concat([readFileSync(hostile), Buffer.alloc(4096)]);

    const realOpenSync = fs.openSync.bind(fs);
    let mutated = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      if (!mutated && String(candidate) === destination) {
        mutated = true;
        // In place: the source keeps its inode, so the retained descriptor
        // still points at exactly the object that passed quick_check.
        const before = fs.statSync(source).ino;
        fs.writeFileSync(source, hostileBytes);
        expect(fs.statSync(source).ino).toBe(before);
      }
      return (realOpenSync as any)(candidate, flags, mode);
    }) as any);

    expect(() => restoreHqBackupToNewFile(source, destination)).toThrow(
      /contents changed between integrity verification and the restore copy/,
    );
    expect(mutated).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it('refuses an in-place source mutation applied during the copy', () => {
    if (process.platform !== 'linux') return;

    const root = testRoot('.hq-recovery-freeze-');
    const source = join(root, 'source.sqlite');
    const hostile = join(root, 'hostile.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'verified-original');
    createProbeDb(hostile, 'hostile-mid-copy');
    const hostileBytes = readFileSync(hostile);

    // ftruncateSync runs after the last source read but still inside the copy,
    // so the copied bytes match the verified state and ONLY the post-copy
    // re-proof of the source can catch this.
    const realFtruncateSync = fs.ftruncateSync.bind(fs);
    let mutated = false;
    vi.spyOn(fs, 'ftruncateSync').mockImplementation(((fd: number, len?: number) => {
      if (!mutated) {
        mutated = true;
        const before = fs.statSync(source).ino;
        fs.writeFileSync(source, hostileBytes);
        expect(fs.statSync(source).ino).toBe(before);
      }
      return realFtruncateSync(fd, len);
    }) as any);

    expect(() => restoreHqBackupToNewFile(source, destination)).toThrow(
      /contents changed during the restore copy/,
    );
    expect(mutated).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it('still restores a stable source exactly', () => {
    const root = testRoot('.hq-recovery-freeze-');
    const source = join(root, 'source.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'stable-state');

    const result = restoreHqBackupToNewFile(source, destination);
    expect(result.sizeBytes).toBe(fs.statSync(source).size);
    expect(readProbe(destination)).toBe('stable-state');
    expect(readFileSync(destination).equals(readFileSync(source))).toBe(true);
  });
});

describe('recovery re-proves the restored bytes before reporting success', () => {
  it('refuses an in-place destination rewrite applied after the destination hash', () => {
    if (process.platform !== 'linux') return;

    const root = testRoot('.hq-recovery-commit-');
    const source = join(root, 'source.sqlite');
    const hostile = join(root, 'hostile.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'verified-original');
    createProbeDb(hostile, 'hostile-destination-rewrite');
    const hostileBytes = readFileSync(hostile);

    // The parent-directory open happens after the destination content hash and
    // its SQLite verification, so injecting here models a rewrite that inode
    // identity provably cannot see.
    const realOpenSync = fs.openSync.bind(fs);
    let rewritten = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      if (!rewritten && String(candidate) === root) {
        rewritten = true;
        const before = fs.statSync(destination).ino;
        fs.writeFileSync(destination, hostileBytes);
        expect(fs.statSync(destination).ino).toBe(before);
      }
      return (realOpenSync as any)(candidate, flags, mode);
    }) as any);

    expect(() => restoreHqBackupToNewFile(source, destination)).toThrow(
      /restored HQ database changed after integrity verification/,
    );
    expect(rewritten).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });
});

describe('recovery commits the destination directory entry', () => {
  it('fsyncs the destination parent directory after verification and before returning', () => {
    const root = testRoot('.hq-recovery-dirsync-');
    const source = join(root, 'source.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'directory-durability');

    const realOpenSync = fs.openSync.bind(fs);
    const realFsyncSync = fs.fsyncSync.bind(fs);
    const fsynced: number[] = [];
    let destinationFd: number | undefined;
    let parentFd: number | undefined;

    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      const fd = (realOpenSync as any)(candidate, flags, mode);
      if (String(candidate) === destination) destinationFd = fd;
      if (String(candidate) === root) parentFd = fd;
      return fd;
    }) as any);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      fsynced.push(fd);
      return realFsyncSync(fd);
    }) as any);

    const result = restoreHqBackupToNewFile(source, destination);

    expect(result.path).toBe(destination);
    expect(destinationFd).toBeDefined();
    expect(parentFd).toBeDefined();
    expect(fsynced).toContain(destinationFd!);
    expect(fsynced).toContain(parentFd!);
    // The directory entry is committed last: after the restored inode is
    // fsynced and after destination identity/integrity verification.
    expect(fsynced.indexOf(parentFd!)).toBeGreaterThan(fsynced.indexOf(destinationFd!));
    expect(fsynced[fsynced.length - 1]).toBe(parentFd!);
  });
});
