/**
 * Stage 3 P1 correction (issue #247): backup publication rollback must remove
 * ONLY the entry this invocation itself published.
 *
 * The defect: after `linkSync` the code read the destination pathname back with
 * `lstatSync` and recorded whatever it found as "the thing I linked". If another
 * actor replaced the destination in that window, the identity check correctly
 * rejected the publication — but the rollback then compared the destination
 * against that REPLACEMENT and unlinked it, destroying a file this backup
 * invocation never created.
 *
 * The correction establishes what was published from the retained partial
 * descriptor's link count instead of from the mutable destination pathname, so
 * a replaced destination fails closed and is preserved.
 *
 * These are hostile tests: they deliberately break the declared
 * single-process/single-writer/private-volume threat boundary to prove the code
 * fails closed anyway. They do not claim that boundary is unnecessary.
 */

import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openHqDatabase } from '@factoryos/headquarter/store';
import { openHqPersistence } from '../src/index.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const roots: string[] = [];

function testRoot(prefix = '.hq-publication-rollback-'): string {
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
  db.exec('CREATE TABLE IF NOT EXISTS backup_probe(value TEXT NOT NULL)');
  db.exec('DELETE FROM backup_probe');
  db.prepare('INSERT INTO backup_probe(value) VALUES (?)').run(value);
  db.close();
}

/**
 * Reserved partial files left behind, excluding the `-wal`/`-shm` sidecars
 * SQLite's own read-only verification open creates alongside them; those are
 * not part of this correction.
 */
function leftoverPartials(backupRoot: string): string[] {
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot).filter((entry) => /\.partial-[0-9a-f-]+$/.test(entry));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('publication rollback only ever withdraws this invocation own entry', () => {
  it('detects a destination replaced between publication and the first identity check', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const backupRoot = join(root, 'backups');
    const destination = join(backupRoot, 'replaced.sqlite');

    // Another actor's file, with its own independent name outside the backup
    // directory, which it will install at the destination.
    const foreign = join(root, 'foreign-actor.sqlite');
    createProbeDb(foreign, 'foreign-actor-state');
    const foreignBytes = readFileSync(foreign);
    const foreignInode = fs.statSync(foreign).ino;

    const realLinkSync = fs.linkSync.bind(fs);
    const realLstatSync = fs.lstatSync.bind(fs);
    let published = false;
    let replaced = false;

    vi.spyOn(fs, 'linkSync').mockImplementation(((existingPath, newPath) => {
      const result = realLinkSync(existingPath, newPath);
      if (String(newPath).endsWith('/replaced.sqlite')) published = true;
      return result;
    }) as typeof fs.linkSync);

    // The hostile window: our link has already published the verified inode,
    // and the code is about to read the destination back to confirm it.
    vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: unknown, options?: unknown) => {
      if (published && !replaced && String(candidate).endsWith('/replaced.sqlite')) {
        replaced = true;
        fs.unlinkSync(destination);
        realLinkSync(foreign, destination);
      }
      return (realLstatSync as any)(candidate, options);
    }) as typeof fs.lstatSync);

    try {
      await expect(persistence.backup('replaced.sqlite')).rejects.toThrow(
        /did not link the verified partial inode/,
      );
      expect(replaced).toBe(true);

      // The other actor's file is preserved: still present, still their inode,
      // still their bytes. Rollback did NOT unlink it.
      expect(existsSync(destination)).toBe(true);
      expect(fs.statSync(destination).ino).toBe(foreignInode);
      expect(readFileSync(destination).equals(foreignBytes)).toBe(true);

      // Their independent name survives too, so nothing was orphaned.
      expect(existsSync(foreign)).toBe(true);
      expect(fs.statSync(foreign).ino).toBe(foreignInode);

      // This invocation left no partial of its own behind.
      expect(leftoverPartials(backupRoot)).toEqual([]);
    } finally {
      persistence.close();
    }
  });

  it('still withdraws its own published inode when publication is rejected afterwards', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const backupRoot = join(root, 'backups');
    const destination = join(backupRoot, 'withdrawn.sqlite');

    const hostile = join(root, 'hostile-rewrite.sqlite');
    createProbeDb(hostile, 'hostile-rewritten');
    const hostileBytes = readFileSync(hostile);

    const realLinkSync = fs.linkSync.bind(fs);
    const realFsyncSync = fs.fsyncSync.bind(fs);
    const fsyncedPaths = new Set<string>();
    let rewritten = false;

    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      try {
        fsyncedPaths.add(fs.realpathSync(`/proc/self/fd/${fd}`));
      } catch {
        // Not a resolvable directory descriptor; irrelevant here.
      }
      return realFsyncSync(fd);
    }) as typeof fs.fsyncSync);

    // Rewrite the reserved partial IN PLACE (same inode) just before the link,
    // so the publication really does attach this invocation's own verified
    // inode and is only rejected afterwards, by the content re-proof.
    vi.spyOn(fs, 'linkSync').mockImplementation(((existingPath, newPath) => {
      if (!rewritten && String(newPath).endsWith('/withdrawn.sqlite')) {
        rewritten = true;
        const partialName = readdirSync(backupRoot).find((entry) => entry.includes('.partial-'));
        expect(partialName).toBeDefined();
        writeFileSync(join(backupRoot, partialName!), hostileBytes);
      }
      return realLinkSync(existingPath, newPath);
    }) as typeof fs.linkSync);

    try {
      await expect(persistence.backup('withdrawn.sqlite')).rejects.toThrow(/contents changed/);
      expect(rewritten).toBe(true);

      // The entry this invocation published names its own inode, so it is
      // cleaned up rather than left as an unverified recovery point...
      expect(existsSync(destination)).toBe(false);
      expect(leftoverPartials(backupRoot)).toEqual([]);
      // ...and the withdrawal itself is committed, because an unlink is a cache
      // update exactly as the link was.
      expect(fsyncedPaths).toContain(fs.realpathSync(backupRoot));
    } finally {
      persistence.close();
    }
  });

  it('never leaves an unverified inode published when the link source is substituted', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const backupRoot = join(root, 'backups');
    const destination = join(backupRoot, 'substituted.sqlite');

    const foreign = join(root, 'foreign-source.sqlite');
    createProbeDb(foreign, 'foreign-source-state');
    const foreignBytes = readFileSync(foreign);

    const realLinkSync = fs.linkSync.bind(fs);
    let substituted = false;

    // Swap the SOURCE pathname out from under the link, so `linkSync` publishes
    // an inode this invocation never verified. That entry is still one we
    // created, so it must not survive under the final backup name — but the
    // substituted file's own name must.
    vi.spyOn(fs, 'linkSync').mockImplementation(((existingPath, newPath) => {
      if (!substituted && String(newPath).endsWith('/substituted.sqlite')) {
        substituted = true;
        const partial = String(existingPath);
        fs.renameSync(partial, `${partial}.verified-hidden`);
        fs.copyFileSync(foreign, partial);
      }
      return realLinkSync(existingPath, newPath);
    }) as typeof fs.linkSync);

    try {
      await expect(persistence.backup('substituted.sqlite')).rejects.toThrow(
        /did not link the verified partial inode/,
      );
      expect(substituted).toBe(true);

      // No unverified bytes are published under the final backup name.
      expect(existsSync(destination)).toBe(false);
      // The substituted file itself keeps its own independent name and bytes:
      // only the extra hard link our publication added was removed.
      expect(existsSync(foreign)).toBe(true);
      expect(readFileSync(foreign).equals(foreignBytes)).toBe(true);
    } finally {
      persistence.close();
    }
  });
});
