import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openHqPersistence, resolveHqPersistenceConfig } from '../src/persistence.js';
import { parseMountInfo } from '../src/durable-filesystem.js';
import { attestDurableMountBoundary, syntheticMountInfoFor } from './support/durable-mount.js';

const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHostedFixture(prefix: string, base: string = process.cwd()) {
  const root = mkdtempSync(join(base, prefix));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const dbPath = join(dataDir, 'hq.sqlite');
  writeFileSync(dbPath, '');
  return { root, dbPath, backupRoot: join(root, 'backups') };
}

/**
 * A REAL ephemeral mount to point the durable gate at, with no mount-table
 * simulation whatsoever: `/dev/shm` is a genuine `tmpfs` mounted exactly at its
 * own path on an ordinary Linux host. `undefined` when this host does not offer
 * one in usable form, in which case the synthetic-tmpfs case below still proves
 * the refusal deterministically.
 */
function realEphemeralMountPoint(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const candidate = '/dev/shm';
  try {
    const real = fs.realpathSync(candidate);
    const mounted = parseMountInfo(readFileSync('/proc/self/mountinfo', 'utf8')).some(
      (boundary) => resolve(boundary.mountPoint) === real && boundary.filesystemType === 'tmpfs',
    );
    if (!mounted) return undefined;
    fs.accessSync(real, fs.constants.W_OK);
    return real;
  } catch {
    return undefined;
  }
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

  it('refuses a REAL mounted tmpfs as the durable root, against the real mount table', async () => {
    const ephemeralMount = realEphemeralMountPoint();
    if (!ephemeralMount) return;

    // No stubbing at all: a real tmpfs, mounted exactly at its own path, with a
    // real matching mount identity. It satisfies every mount-boundary check and
    // must still be refused, because its contents do not survive workload
    // replacement.
    const { dbPath } = makeHostedFixture('.hq-real-tmpfs-root-', ephemeralMount);

    const logs: string[] = [];
    const persistence = openHqPersistence(
      {
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_RUNTIME: 'hosted',
        FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
        FACTORYOS_HQ_DURABLE_ROOT: ephemeralMount,
      },
      (line) => logs.push(line),
    );

    expect(persistence).toBeNull();
    expect(logs.join('\n')).toContain('cannot be attested as durable');
    expect(logs.join('\n')).toContain('tmpfs');
  });

  it('refuses a mounted tmpfs whose mount identity matches the opened root descriptor', () => {
    if (process.platform !== 'linux') return;

    // The exact hostile shape the previous gate accepted: a valid mount boundary
    // at the configured root, correct mount identity, ephemeral filesystem.
    const { root, dbPath } = makeHostedFixture('.hq-synthetic-tmpfs-root-');
    attestDurableMountBoundary(root, { filesystemType: 'tmpfs', mountSource: 'tmpfs' });

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
    expect(logs.join('\n')).toContain('known ephemeral');
  });

  it('refuses a container overlay/ephemeral root mounted at the durable root', () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath } = makeHostedFixture('.hq-overlay-root-');
    attestDurableMountBoundary(root, { filesystemType: 'overlay', mountSource: 'overlay' });

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
    expect(logs.join('\n')).toContain('cannot be attested as durable');
  });

  it('refuses a persistent filesystem mounted read-only', () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath } = makeHostedFixture('.hq-readonly-root-');
    attestDurableMountBoundary(root, { mountOptions: 'ro,relatime', superOptions: 'ro' });

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
    expect(logs.join('\n')).toContain('mounted read-only');
  });

  it('refuses an unrecognized filesystem unless the operator attests it', async () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath } = makeHostedFixture('.hq-unclassified-root-');
    attestDurableMountBoundary(root, {
      filesystemType: 'somenewfs',
      mountSource: '/dev/synthetic-durable',
    });
    const env = {
      FACTORYOS_HQ_DB: dbPath,
      FACTORYOS_HQ_RUNTIME: 'hosted',
      FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
      FACTORYOS_HQ_DURABLE_ROOT: root,
    };

    const refusedLogs: string[] = [];
    expect(openHqPersistence(env, (line) => refusedLogs.push(line))).toBeNull();
    expect(refusedLogs.join('\n')).toContain('FACTORYOS_HQ_DURABLE_FS_ALLOW');

    // The narrow, explicit, logged operator attestation — and nothing broader —
    // is what allows it.
    const attestedLogs: string[] = [];
    const persistence = openHqPersistence(
      { ...env, FACTORYOS_HQ_DURABLE_FS_ALLOW: 'somenewfs' },
      (line) => attestedLogs.push(line),
    );

    expect(persistence).not.toBeNull();
    try {
      expect(attestedLogs.join('\n')).toContain('operator-attested durable filesystem types');
      const backup = await persistence!.backup('operator-attested.sqlite');
      expect(existsSync(backup.path)).toBe(true);
    } finally {
      persistence!.close();
    }
  });

  it('refuses an operator attestation that names an ephemeral filesystem', () => {
    if (process.platform !== 'linux') return;

    // The override must not be able to weaken the default: naming tmpfs refuses
    // the boot outright, even though the root here is a permitted ext4 mount.
    const { root, dbPath } = makeHostedFixture('.hq-dishonest-attestation-');
    attestDurableMountBoundary(root);

    const logs: string[] = [];
    const persistence = openHqPersistence(
      {
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_RUNTIME: 'hosted',
        FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
        FACTORYOS_HQ_DURABLE_ROOT: root,
        FACTORYOS_HQ_DURABLE_FS_ALLOW: 'tmpfs',
      },
      (line) => logs.push(line),
    );

    expect(persistence).toBeNull();
    expect(logs.join('\n')).toContain('cannot attest tmpfs as durable');
  });

  it('refuses a wildcard operator attestation', () => {
    if (process.platform !== 'linux') return;

    const { root, dbPath } = makeHostedFixture('.hq-wildcard-attestation-');
    attestDurableMountBoundary(root);

    const logs: string[] = [];
    expect(
      resolveHqPersistenceConfig(
        {
          FACTORYOS_HQ_DB: dbPath,
          FACTORYOS_HQ_RUNTIME: 'hosted',
          FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
          FACTORYOS_HQ_DURABLE_ROOT: root,
          FACTORYOS_HQ_DURABLE_FS_ALLOW: '*',
        },
        (line) => logs.push(line),
      ),
    ).toBeNull();
    expect(logs.join('\n')).toContain('wildcards and blanket values are refused');
  });

  it('keeps the filesystem allow-list out of the portable local-file contract', () => {
    const { root, dbPath } = makeHostedFixture('.hq-local-fs-allow-');

    const config = resolveHqPersistenceConfig(
      {
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_DURABLE_FS_ALLOW: 'somenewfs',
      },
      () => {},
    );

    expect(config).not.toBeNull();
    expect(config!.mode).toBe('local-file');
    expect(config!.attestedFilesystems).toEqual([]);
    expect(root).toContain('.hq-local-fs-allow-');
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
