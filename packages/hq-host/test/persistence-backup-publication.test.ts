import fs from 'node:fs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openHqDatabase, openHqDatabaseReadOnly } from '@factoryos/headquarter/store';
import { openHqPersistence, restoreHqBackupToNewFile } from '../src/index.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const roots: string[] = [];

function testRoot(prefix = '.hq-backup-publication-'): string {
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

function readProbe(file: string): string {
  const db = openHqDatabaseReadOnly(file);
  const row = db.prepare('SELECT value FROM backup_probe LIMIT 1').get() as { value: string };
  db.close();
  return row.value;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Stage 3 verified backup publication', () => {
  it('never reports success when the verified partial pathname is swapped before publication', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const replacement = join(root, 'hostile-valid.sqlite');
    createProbeDb(replacement, 'hostile');
    const destination = join(root, 'backups', 'proof.sqlite');

    const realLinkSync = fs.linkSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'linkSync').mockImplementation(((existingPath, newPath) => {
      // Hosted publication operates through /proc/self/fd/<backup-dir-fd>/...
      // rather than the mutable backupRoot pathname. Trigger on the destination
      // filename so the hostile swap really occurs between identity check/link.
      if (!swapped && String(newPath).endsWith('/proof.sqlite')) {
        swapped = true;
        const partial = String(existingPath);
        fs.renameSync(partial, `${partial}.verified-hidden`);
        fs.copyFileSync(replacement, partial);
      }
      return realLinkSync(existingPath, newPath);
    }) as typeof fs.linkSync);

    try {
      await expect(persistence.backup('proof.sqlite')).rejects.toThrow(
        /did not link the verified partial inode/,
      );
      expect(swapped).toBe(true);
      expect(existsSync(destination)).toBe(false);
    } finally {
      persistence.close();
    }
  });

  it('fsyncs the descriptor-attested backup directory before reporting success', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const persistence = hostedPersistence(root);
    const backupRoot = join(root, 'backups');
    const realOpenSync = fs.openSync.bind(fs);
    const realFsyncSync = fs.fsyncSync.bind(fs);
    let backupDirectoryFd: number | undefined;
    const fsynced: number[] = [];

    vi.spyOn(fs, 'openSync').mockImplementation(((filePath, flags, mode) => {
      const fd = realOpenSync(filePath, flags, mode);
      if (String(filePath) === backupRoot) backupDirectoryFd = fd;
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd) => {
      fsynced.push(fd);
      return realFsyncSync(fd);
    }) as typeof fs.fsyncSync);

    try {
      const result = await persistence.backup('durable.sqlite');
      expect(existsSync(result.path)).toBe(true);
      expect(backupDirectoryFd).toBeDefined();
      expect(fsynced).toContain(backupDirectoryFd!);
    } finally {
      persistence.close();
    }
  });
});

describe('portable local recovery', () => {
  it('restores safely when Linux procfs descriptor paths are unavailable', () => {
    const root = testRoot('.hq-portable-recovery-');
    const source = join(root, 'source.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'portable-state');

    const realExistsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation(((candidate) => {
      if (String(candidate) === '/proc/self/fd') return false;
      return realExistsSync(candidate);
    }) as typeof fs.existsSync);

    const result = restoreHqBackupToNewFile(source, destination);
    expect(result.path).toBe(destination);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(readProbe(destination)).toBe('portable-state');
  });
});
