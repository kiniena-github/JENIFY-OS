/**
 * Stage 3 P1 correction (issue #247, superseding the narrower issue #245
 * contract): a successful backup must durably commit the backup directory's
 * PARENT CHAIN on every invocation, not only when this invocation's own
 * recursive `mkdir` reported creating it.
 *
 * The #245 version keyed the parent-link fsync off "did THIS call create the
 * directory", which left a real hole: an earlier backup can create the
 * hierarchy and then crash or fail before its parent-link fsync completes.
 * Every later invocation then sees the directories already present, records
 * nothing as newly created, and commits only the backup directory itself — so
 * a power loss still loses the directory entry chain and the recovery point the
 * backup reported.
 *
 * The replacement contract: the chain from the backup directory's own parent up
 * to the attested durable root is recommitted on every backup, and the work
 * stays BOUNDED — never climbing above the durable root.
 *
 * Cases are distinguished by which directories are fsynced during the backup,
 * resolved through /proc/self/fd at fsync time so descriptor-number reuse across
 * the many directory opens a backup performs cannot confuse the assertion.
 */

import fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openHqPersistence } from '../src/index.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const roots: string[] = [];

function hostedPersistence(root: string, env: Record<string, string> = {}) {
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
      ...env,
    },
    () => {},
  );
  expect(persistence).not.toBeNull();
  return persistence!;
}

/**
 * Track which paths are fsynced by resolving each descriptor to its path
 * through /proc/self/fd at fsync time, which is immune to descriptor-number
 * reuse across the many directory opens a backup performs.
 */
function trackDirectoryFsyncs(): { fsyncedPaths: () => Set<string> } {
  const realFsyncSync = fs.fsyncSync.bind(fs);
  const fsynced = new Set<string>();

  vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd) => {
    try {
      fsynced.add(fs.realpathSync(`/proc/self/fd/${fd}`));
    } catch {
      // A non-directory or vanished descriptor is not relevant here.
    }
    return realFsyncSync(fd);
  }) as typeof fs.fsyncSync);

  return { fsyncedPaths: () => new Set(fsynced) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backup directory link durability', () => {
  it('fsyncs the durable-root parent link when the backup directory is created for the first time', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-new-'));
    roots.push(root);
    const durableRoot = realpathSync(root);
    const backupRoot = join(durableRoot, 'backups');
    const persistence = hostedPersistence(root);

    // Start tracking only around the backup, after open, so the assertion is
    // about the backup's own durability work.
    const tracker = trackDirectoryFsyncs();
    try {
      const result = await persistence.backup('first.sqlite');
      expect(fs.existsSync(result.path)).toBe(true);

      const fsynced = tracker.fsyncedPaths();
      // The new backup directory link lives in the durable root, so the durable
      // root itself must be fsynced to commit it.
      expect(fsynced).toContain(durableRoot);
      // The backup directory is also fsynced to commit the published backup file.
      expect(fsynced).toContain(backupRoot);
    } finally {
      persistence.close();
    }
  });

  it('recommits the parent chain of a pre-existing, not-yet-durably-committed backup directory', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-existing-'));
    roots.push(root);
    const durableRoot = realpathSync(root);
    const backupRoot = join(durableRoot, 'backups');
    // Model the exact failure the correction is about: an earlier invocation
    // created the backup directory and then died before its parent-link fsync
    // ran. This invocation sees the directory already present and creates
    // nothing, so the old "only fsync what I just created" rule would commit
    // nothing here and leave the directory entry loseable.
    mkdirSync(backupRoot);
    const persistence = hostedPersistence(root);

    const tracker = trackDirectoryFsyncs();
    try {
      const result = await persistence.backup('second.sqlite');
      expect(fs.existsSync(result.path)).toBe(true);

      const fsynced = tracker.fsyncedPaths();
      // The published backup still commits its own directory...
      expect(fsynced).toContain(backupRoot);
      // ...and the pre-existing directory's own link is committed too, even
      // though this invocation did not create it.
      expect(fsynced).toContain(durableRoot);
    } finally {
      persistence.close();
    }
  });

  it('keeps the recommitted chain bounded to the configured backup path', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-bounded-'));
    roots.push(root);
    const durableRoot = realpathSync(root);
    const backupRoot = join(durableRoot, 'nested', 'backups');
    // Pre-create the whole hierarchy so nothing is newly created here either.
    mkdirSync(backupRoot, { recursive: true });
    const persistence = hostedPersistence(root, { FACTORYOS_HQ_BACKUP_DIR: backupRoot });

    const tracker = trackDirectoryFsyncs();
    try {
      const result = await persistence.backup('bounded.sqlite');
      expect(fs.existsSync(result.path)).toBe(true);

      const fsynced = tracker.fsyncedPaths();
      // Every ancestor between the backup directory and the durable root is
      // committed, inclusive of the durable root that holds the outermost link.
      expect(fsynced).toContain(backupRoot);
      expect(fsynced).toContain(join(durableRoot, 'nested'));
      expect(fsynced).toContain(durableRoot);
      // ...and the work stops there. The durable root is a mount boundary whose
      // own link is the volume's responsibility, so nothing above it is touched.
      expect(fsynced).not.toContain(dirname(durableRoot));
      expect(fsynced).not.toContain('/');
      // Bounded in absolute terms as well: the backup directory, its two
      // ancestors up to the durable root, and nothing else directory-shaped.
      const directories = [...fsynced].filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
      expect(new Set(directories)).toEqual(
        new Set([backupRoot, join(durableRoot, 'nested'), durableRoot]),
      );
    } finally {
      persistence.close();
    }
  });

  it('recommits the chain on a retry after the creating invocation failed', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-retry-'));
    roots.push(root);
    const durableRoot = realpathSync(root);
    const backupRoot = join(durableRoot, 'backups');
    const persistence = hostedPersistence(root);

    try {
      // First invocation: creates the hierarchy, then fails before it can
      // report success — modelled by making its parent-link commit throw, which
      // is exactly the crash window the old contract left open.
      const realOpenSync = fs.openSync.bind(fs);
      const failingOpen = vi
        .spyOn(fs, 'openSync')
        .mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
          if (String(candidate) === durableRoot) {
            const error = new Error(`EIO: simulated crash window, open '${durableRoot}'`);
            (error as NodeJS.ErrnoException).code = 'EIO';
            throw error;
          }
          return (realOpenSync as any)(candidate, flags, mode);
        }) as any);

      await expect(persistence.backup('crashed.sqlite')).rejects.toThrow(/simulated crash window/);
      failingOpen.mockRestore();

      // The directory now exists but its link was never committed, so this
      // retry creates nothing and the old rule would commit nothing.
      expect(fs.existsSync(backupRoot)).toBe(true);

      const tracker = trackDirectoryFsyncs();
      const result = await persistence.backup('retried.sqlite');
      expect(fs.existsSync(result.path)).toBe(true);

      const fsynced = tracker.fsyncedPaths();
      expect(fsynced).toContain(backupRoot);
      expect(fsynced).toContain(durableRoot);
    } finally {
      persistence.close();
    }
  });

  it('never recommits above a backup directory that IS the durable root', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-atroot-'));
    roots.push(root);
    const durableRoot = realpathSync(root);
    const persistence = hostedPersistence(root, { FACTORYOS_HQ_BACKUP_DIR: durableRoot });

    const tracker = trackDirectoryFsyncs();
    try {
      const result = await persistence.backup('at-root.sqlite');
      expect(fs.existsSync(result.path)).toBe(true);

      const fsynced = tracker.fsyncedPaths();
      // The backup file's own directory entry is still committed...
      expect(fsynced).toContain(durableRoot);
      // ...but the durable root's own link belongs to the mount, so the chain
      // above it is empty and untouched.
      expect(fsynced).not.toContain(dirname(durableRoot));
    } finally {
      persistence.close();
    }
  });
});

describe('local-file backup directory durability stays portable', () => {
  function localPersistence(root: string) {
    const persistence = openHqPersistence(
      { FACTORYOS_HQ_DB: join(root, 'hq.sqlite'), FACTORYOS_HQ_RUNTIME: 'local' },
      () => {},
    );
    expect(persistence).not.toBeNull();
    return persistence!;
  }

  it('commits the backup directory own parent and bounds the rest of the chain', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-local-'));
    roots.push(root);
    const realRoot = realpathSync(root);
    const backupRoot = join(realRoot, 'backups');
    const persistence = localPersistence(root);

    const tracker = trackDirectoryFsyncs();
    try {
      const result = await persistence.backup('local.sqlite');
      expect(fs.existsSync(result.path)).toBe(true);

      const fsynced = tracker.fsyncedPaths();
      // Local-file mode has no attested volume boundary, so the chain is
      // anchored at the filesystem root — but the backup directory's own parent
      // link is the part that must always be committed.
      expect(fsynced).toContain(realRoot);
      expect(fsynced).toContain(backupRoot);

      const directories = [...fsynced].filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
      // Bounded: at most the cap plus the backup directory itself, never a walk
      // proportional to anything but the configured path depth.
      const chainDepth = Math.min(realRoot.split('/').length, 32);
      expect(directories.length).toBeLessThanOrEqual(33);
      expect(directories.length).toBe(chainDepth + 1);
    } finally {
      persistence.close();
    }
  });

  it('does not fail a workstation backup when an ancestor above the backup parent cannot be opened', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-local-eacces-'));
    roots.push(root);
    const realRoot = realpathSync(root);
    const blocked = dirname(realRoot);
    const persistence = localPersistence(root);

    const realOpenSync = fs.openSync.bind(fs);
    let refusals = 0;
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      // An ancestor ABOVE the backup directory's own parent: on a workstation
      // this can be a system directory the process may traverse but not open
      // for reading. The portable contract tolerates that.
      if (String(candidate) === blocked) {
        refusals += 1;
        const error = new Error(`EACCES: permission denied, open '${blocked}'`);
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      }
      return (realOpenSync as any)(candidate, flags, mode);
    }) as any);

    try {
      const result = await persistence.backup('tolerated.sqlite');
      expect(refusals).toBeGreaterThan(0);
      expect(fs.existsSync(result.path)).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
    } finally {
      persistence.close();
    }
  });

  it('still fails closed when the backup directory own parent cannot be committed', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-local-strict-'));
    roots.push(root);
    const realRoot = realpathSync(root);
    const persistence = localPersistence(root);

    const realOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      if (String(candidate) === realRoot) {
        const error = new Error(`EIO: simulated failure, open '${realRoot}'`);
        (error as NodeJS.ErrnoException).code = 'EIO';
        throw error;
      }
      return (realOpenSync as any)(candidate, flags, mode);
    }) as any);

    try {
      await expect(persistence.backup('strict.sqlite')).rejects.toThrow(/simulated failure/);
    } finally {
      persistence.close();
    }
  });
});
