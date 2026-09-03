/**
 * Stage 3 P1 correction (issue #245): a first backup into a newly created
 * backup directory must durably commit that directory's own link from the
 * durable root before reporting success, or an abrupt crash could lose the
 * whole backup directory. An already-existing backup directory must not perform
 * that extra parent-directory work.
 *
 * The two cases are distinguished by whether the durable ROOT directory (the
 * parent that holds the new `backups` link) is fsynced during the backup.
 */

import fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openHqPersistence } from '../src/index.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const roots: string[] = [];

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

  it('does not fsync the durable-root parent when the backup directory already exists', async () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backupdir-existing-'));
    roots.push(root);
    const durableRoot = realpathSync(root);
    const backupRoot = join(durableRoot, 'backups');
    // Pre-create the backup directory so no new link is added to the durable root.
    mkdirSync(backupRoot);
    const persistence = hostedPersistence(root);

    const tracker = trackDirectoryFsyncs();
    try {
      const result = await persistence.backup('second.sqlite');
      expect(fs.existsSync(result.path)).toBe(true);

      const fsynced = tracker.fsyncedPaths();
      // The published backup still commits its own directory...
      expect(fsynced).toContain(backupRoot);
      // ...but no unbounded extra work is done on the durable root.
      expect(fsynced).not.toContain(durableRoot);
    } finally {
      persistence.close();
    }
  });
});
