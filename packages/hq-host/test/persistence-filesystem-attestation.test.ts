import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHqPersistence } from '../src/persistence.js';

const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hosted durable filesystem attestation', () => {
  it('refuses a DB inode whose filesystem device differs from the attested durable root', () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-fs-attestation-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    const dbPath = join(dataDir, 'hq.sqlite');
    writeFileSync(dbPath, '');

    const realOpenSync = fs.openSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    let durableRootFd: number | undefined;

    vi.spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
      const fd = realOpenSync(path, flags, mode);
      if (String(path) === root) durableRootFd = fd;
      return fd;
    }) as typeof fs.openSync);

    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd, options) => {
      const stat = realFstatSync(fd, options as never) as fs.Stats;
      if (fd !== durableRootFd) return stat;

      // Model a nested ephemeral/bind mount: the pathname is still inside the
      // durable root, but the database and root live on different devices.
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
});
