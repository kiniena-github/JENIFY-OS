/**
 * The opened-file identity race (issue #243).
 *
 * Stage 3 validated the database PATHNAME before SQLite opened it and resolved
 * that pathname again afterwards. Both checks can be true while SQLite holds a
 * completely different file: an attacker who swaps a path component during the
 * open, and restores it before the post-open check, got hosted HQ to run
 * against an external or ephemeral database while every pathname check reported
 * the attested durable root.
 *
 * The configuration-level tests in `persistence.test.ts` cover the inputs that
 * are refused before anything opens. They cannot cover this, because nothing
 * about the configuration is wrong here: the path is inside the root, the entry
 * is a regular file, and it still is when the old post-open check ran. Only the
 * moment of the open differs.
 *
 * So this file drives the swap FROM the real open call rather than from a sleep
 * or a thread race — the race is deterministic, and it is the same race every
 * run — and asserts three things: that SQLite genuinely ended up holding the
 * external database, that every pathname check still says the durable root
 * (which is why the previous defence passed), and that hosted startup now
 * refuses the boot anyway because the attestation is descriptor-backed.
 *
 * The swapped component is a PARENT directory: hosted mode now refuses a
 * final-component symlink outright, so the parent is where a race still lives.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    openHqDatabase: (dbPath?: string) => {
      hostile.beforeOpen?.();
      try {
        return actual.openHqDatabase(dbPath);
      } finally {
        // Restoring the path here is the whole point: it is what made the old
        // post-open realpath check pass on a database SQLite never opened.
        hostile.afterOpen?.();
      }
    },
  };
});

// Spread through unchanged by the mock above, so this is the real reader.
import { openHqDatabaseReadOnly } from '@factoryos/headquarter/store';
import { openHqPersistence } from '../src/persistence.js';

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
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hosted HQ refuses a database SQLite opened outside the attested volume', () => {
  it('refuses a boot where a parent component is swapped across SQLite’s open and restored after it', () => {
    if (process.platform !== 'linux') return;

    const root = durableRoot();
    const attestedDir = join(root, 'attested');
    mkdirSync(attestedDir);
    const attestedDb = join(attestedDir, 'hq.sqlite');
    writeFileSync(attestedDb, '');

    // The configured path reaches the attested file through a directory
    // symlink that resolves inside the root — a legitimate mounted-volume
    // layout, and the component the attacker gets to swap.
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

    expect(
      persistence,
      'hosted HQ must stay OFF when SQLite did not open the attested inode',
    ).toBeNull();
    expect(logs.join('\n')).toContain('outside the durable root');

    // The race really happened: SQLite created and initialised the EXTERNAL
    // database, and the attested durable file was never written.
    expect(existsSync(externalDb)).toBe(true);
    const externalHandle = openHqDatabaseReadOnly(externalDb);
    const tables = externalHandle
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_projects'`)
      .all() as { name: string }[];
    externalHandle.close();
    expect(tables, 'SQLite genuinely held the external database').toHaveLength(1);
    expect(readFileSync(attestedDb).length, 'the attested durable file was never written').toBe(0);

    // And this is why pathname checking was not enough: by the time any
    // pathname check runs, everything about the path is correct again.
    expect(realpathSync(dbPath)).toBe(realpathSync(attestedDb));
    expect(statSync(dbPath).ino).toBe(statSync(attestedDb).ino);
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

    expect(persistence, 'the refusal must be the race, not the layout').not.toBeNull();
    expect(persistence!.healthy()).toBe(true);
    expect(statSync(attestedDb).ino).toBe(statSync(dbPath).ino);
    persistence!.close();
  });
});
