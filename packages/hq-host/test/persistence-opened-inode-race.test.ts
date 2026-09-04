/**
 * The opened-file identity race (issue #243).
 *
 * Pathname-only validation was not enough: another process could swap a parent
 * component while SQLite opened the database and restore it before the later
 * path check. Earlier Stage 3 code therefore learned to anchor the durable DB
 * inode with O_NOFOLLOW and verify SQLite's opened descriptor afterwards.
 *
 * The stronger correction now goes one step further: SQLite's FIRST writable
 * and migrating open itself uses `/proc/self/fd/<anchor-fd>`. That means a
 * parent-path swap can no longer redirect WAL setup, DDL, or migrations to an
 * external database. If the configured pathname is restored before the final
 * attestation, startup may safely continue because the mutation target never
 * left the anchored durable inode.
 *
 * This file deterministically drives the same parent-path swap from the mocked
 * unmigrated store connection that hosted startup actually calls. It proves the
 * stronger invariant: the hostile replacement is untouched while the anchored
 * durable database receives the schema writes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The hostile hook. `vi.hoisted` because `vi.mock` is hoisted above the module
 * body and the factory would otherwise close over a temporal-dead-zone binding.
 */
const hostile = vi.hoisted(() => ({
  beforeOpen: null as null | (() => void),
  afterOpen: null as null | (() => void),
}));

vi.mock('@factoryos/headquarter/store', async () => {
  const actual =
    await vi.importActual<typeof import('@factoryos/headquarter/store')>(
      '@factoryos/headquarter/store',
    );
  return {
    ...actual,
    connectHqDatabaseUnmigrated: (dbPath?: string) => {
      hostile.beforeOpen?.();
      try {
        return actual.connectHqDatabaseUnmigrated(dbPath);
      } finally {
        hostile.afterOpen?.();
      }
    },
  };
});

import { openHqPersistence } from '../src/persistence.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const cleanup: string[] = [];

function durableRoot(): string {
  // Deliberately NOT os.tmpdir(): hosted durability rejects the OS temp tree.
  const root = mkdtempSync(join(process.cwd(), '.hq-inode-race-test-'));
  cleanup.push(root);
  return root;
}

function externalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hq-external-'));
  cleanup.push(dir);
  return dir;
}

function hostedEnv(root: string, dbPath: string): Record<string, string> {
  attestDurableMountBoundary(root);
  return {
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_RUNTIME: 'hosted',
    FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
    FACTORYOS_HQ_DURABLE_ROOT: root,
  };
}

function trySymlinkDir(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'dir');
    return true;
  } catch (error) {
    // Some Windows developer environments do not grant symlink creation, and
    // hosted attestation is Linux-only anyway. CI exercises this on Linux.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

afterEach(() => {
  hostile.beforeOpen = null;
  hostile.afterOpen = null;
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hosted HQ binds SQLite mutations to the attested durable inode', () => {
  it('does not redirect migrations when a parent component is swapped across SQLite open and restored', () => {
    if (process.platform !== 'linux') return;

    const root = durableRoot();
    const attestedDir = join(root, 'attested');
    mkdirSync(attestedDir);
    const attestedDb = join(attestedDir, 'hq.sqlite');
    writeFileSync(attestedDb, '');

    // The configured path reaches the attested file through a directory
    // symlink that resolves inside the root — a legitimate mounted-volume
    // layout, and the component the hostile actor swaps.
    const live = join(root, 'live');
    if (!trySymlinkDir(attestedDir, live)) return;
    const dbPath = join(live, 'hq.sqlite');

    const external = externalDir();
    const externalDb = join(external, 'hq.sqlite');

    hostile.beforeOpen = () => {
      unlinkSync(live);
      symlinkSync(external, live, 'dir');
    };
    hostile.afterOpen = () => {
      unlinkSync(live);
      symlinkSync(attestedDir, live, 'dir');
    };

    const logs: string[] = [];
    const persistence = openHqPersistence(hostedEnv(root, dbPath), (line) => logs.push(line));

    // The swap happened around the store open, but that store open used the
    // already-anchored /proc/self/fd path. Because the configured pathname was
    // restored before final attestation, a safe boot is allowed.
    expect(persistence, 'anchored SQLite open should remain on the durable inode').not.toBeNull();
    expect(persistence!.db.name).toMatch(/^\/proc\/self\/fd\/\d+$/);

    const tables = persistence!.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_projects'`)
      .all() as { name: string }[];
    expect(tables, 'DDL/migrations must land on the anchored durable database').toHaveLength(1);

    // The hostile replacement must remain completely untouched: no database
    // creation and therefore no WAL/SHM sidecars outside the durable root.
    expect(existsSync(externalDb)).toBe(false);
    expect(existsSync(`${externalDb}-wal`)).toBe(false);
    expect(existsSync(`${externalDb}-shm`)).toBe(false);

    // The path is back to the anchored durable inode when startup finishes.
    expect(realpathSync(dbPath)).toBe(realpathSync(attestedDb));
    expect(statSync(dbPath).ino).toBe(statSync(attestedDb).ino);
    expect(logs.join('\n')).not.toContain('outside the durable root');
    persistence!.close();
  });

  it('boots normally through the same path when nothing swaps underneath it', () => {
    if (process.platform !== 'linux') return;

    const root = durableRoot();
    const attestedDir = join(root, 'attested');
    mkdirSync(attestedDir);
    const attestedDb = join(attestedDir, 'hq.sqlite');
    writeFileSync(attestedDb, '');
    const live = join(root, 'live');
    if (!trySymlinkDir(attestedDir, live)) return;
    const dbPath = join(live, 'hq.sqlite');

    const persistence = openHqPersistence(hostedEnv(root, dbPath), () => {});

    expect(persistence, 'the same legitimate layout must still boot').not.toBeNull();
    expect(persistence!.healthy()).toBe(true);
    expect(statSync(attestedDb).ino).toBe(statSync(dbPath).ino);
    persistence!.close();
  });
});
