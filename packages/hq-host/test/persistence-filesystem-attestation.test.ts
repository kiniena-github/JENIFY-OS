import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHqPersistence } from '../src/persistence.js';
import { attestDurableMountBoundary, syntheticMountInfoFor } from './support/durable-mount.js';

const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHostedFixture(prefix: string) {
  const root = mkdtempSync(join(process.cwd(), prefix));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const dbPath = join(dataDir, 'hq.sqlite');
  writeFileSync(dbPath, '');
  return { root, dbPath, backupRoot: join(root, 'backups') };
}

function bumpMountId(info: string): string {
  const match = /^mnt_id:\s*(\d+)\s*$/m.exec(info);
  if (!match) throw new Error('test runner did not expose mnt_id in /proc/self/fdinfo');
  return info.replace(match[0], `mnt_id:\t${Number(match[1]) + 1}`);
}

describe('hosted durable mount-boundary attestation', () => {
  it('refuses an ordinary directory masquerading as the durable root when no volume is mounted there', () => {
    if (process.platform !== 'linux') return;

    // No mount is simulated: the real /proc/self/mountinfo has no entry mounted
    // exactly at this temp directory, so it cannot be attested as durable.
    const { root, dbPath } = makeHostedFixture('.hq-masquerade-root-');

    const logs: string[] = [];
    const persistence = openHqPersistence(
      {
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_RUNTIME: 'hosted',
        FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
        FACTORYOS_HQ_DURABLE_ROOT: root,
      },
      (line) => logs.push(line),
    );

    expect(persistence).toBeNull();
    expect(logs.join('\n')).toContain('is not a mount boundary');
  });

  it('accepts a correctly attested mount and keeps DB and backups on it', async () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath } = makeHostedFixture('.hq-attested-root-');
    attestDurableMountBoundary(root);

    const persistence = openHqPersistence({
      FACTORYOS_HQ_DB: dbPath,
      FACTORYOS_HQ_RUNTIME: 'hosted',
      FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
      FACTORYOS_HQ_DURABLE_ROOT: root,
    });

    expect(persistence).not.toBeNull();
    try {
      // The DB and a fresh backup both stay on the attested mounted filesystem.
      const backup = await persistence!.backup('attested.sqlite');
      expect(existsSync(backup.path)).toBe(true);
      expect(backup.sizeBytes).toBeGreaterThan(0);
    } finally {
      persistence!.close();
    }
  });

  it('refuses a DB inode whose filesystem device differs from the attested durable root', () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath } = makeHostedFixture('.hq-fs-attestation-');
    attestDurableMountBoundary(root);
    const realOpenSync = fs.openSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    let durableRootFd: number | undefined;

    vi.spyOn(fs, 'openSync').mockImplementation(((filePath, flags, mode) => {
      const fd = realOpenSync(filePath, flags, mode);
      if (String(filePath) === root) durableRootFd = fd;
      return fd;
    }) as typeof fs.openSync);

    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd, options) => {
      const stat = realFstatSync(fd, options as never) as fs.Stats;
      if (fd !== durableRootFd) return stat;

      const altered = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat) as fs.Stats;
      Object.defineProperty(altered, 'dev', { value: Number(stat.dev) + 1, enumerable: true });
      return altered;
    }) as typeof fs.fstatSync);

    const logs: string[] = [];
    const persistence = openHqPersistence(
      {
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_RUNTIME: 'hosted',
        FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
        FACTORYOS_HQ_DURABLE_ROOT: root,
      },
      (line) => logs.push(line),
    );

    expect(persistence).toBeNull();
    expect(logs.join('\n')).toContain('different filesystem from FACTORYOS_HQ_DURABLE_ROOT');
  });

  it('refuses a same-device DB that belongs to a different Linux mount identity', () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath } = makeHostedFixture('.hq-mount-attestation-');
    const realOpenSync = fs.openSync.bind(fs);
    const realReadFileSync = fs.readFileSync.bind(fs);
    // Attest the root as a mount boundary AND bump the DB descriptor's mount id
    // in a single readFileSync stub, since both read through readFileSync.
    const syntheticMountInfo = syntheticMountInfoFor(root, realReadFileSync);
    let dbFd: number | undefined;

    vi.spyOn(fs, 'openSync').mockImplementation(((filePath, flags, mode) => {
      const fd = realOpenSync(filePath, flags, mode);
      if (String(filePath) === dbPath) dbFd = fd;
      return fd;
    }) as typeof fs.openSync);

    vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath, options) => {
      if (String(filePath) === '/proc/self/mountinfo') return syntheticMountInfo as never;
      const value = realReadFileSync(filePath, options as never) as string | Buffer;
      if (typeof value !== 'string' || dbFd == null) return value as never;
      if (!String(filePath).endsWith(`/fdinfo/${dbFd}`)) return value as never;
      return bumpMountId(value) as never;
    }) as typeof fs.readFileSync);

    const logs: string[] = [];
    const persistence = openHqPersistence(
      {
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_RUNTIME: 'hosted',
        FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
        FACTORYOS_HQ_DURABLE_ROOT: root,
      },
      (line) => logs.push(line),
    );

    expect(persistence).toBeNull();
    expect(logs.join('\n')).toContain('different mount from FACTORYOS_HQ_DURABLE_ROOT');
  });

  it('refuses backups on a nested same-device mount with a different mount identity', async () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath, backupRoot } = makeHostedFixture('.hq-backup-mount-attestation-');
    const realOpenSync = fs.openSync.bind(fs);
    const realReadFileSync = fs.readFileSync.bind(fs);
    const syntheticMountInfo = syntheticMountInfoFor(root, realReadFileSync);
    let backupFd: number | undefined;

    vi.spyOn(fs, 'openSync').mockImplementation(((filePath, flags, mode) => {
      const fd = realOpenSync(filePath, flags, mode);
      if (String(filePath) === backupRoot) backupFd = fd;
      return fd;
    }) as typeof fs.openSync);

    vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath, options) => {
      if (String(filePath) === '/proc/self/mountinfo') return syntheticMountInfo as never;
      const value = realReadFileSync(filePath, options as never) as string | Buffer;
      if (typeof value !== 'string' || backupFd == null) return value as never;
      if (!String(filePath).endsWith(`/fdinfo/${backupFd}`)) return value as never;
      return bumpMountId(value) as never;
    }) as typeof fs.readFileSync);

    const persistence = openHqPersistence({
      FACTORYOS_HQ_DB: dbPath,
      FACTORYOS_HQ_RUNTIME: 'hosted',
      FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
      FACTORYOS_HQ_DURABLE_ROOT: root,
      FACTORYOS_HQ_BACKUP_DIR: backupRoot,
    });

    expect(persistence).not.toBeNull();
    try {
      await expect(persistence!.backup('should-not-publish.sqlite')).rejects.toThrow(
        'HQ backup directory is on a different mount from FACTORYOS_HQ_DURABLE_ROOT',
      );
    } finally {
      persistence!.close();
    }
  });
});
