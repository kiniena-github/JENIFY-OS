/**
 * The backup integrity-check window (issue #244, third review round).
 *
 * Proving the backup bytes only AFTER `quick_check` is not enough. A
 * same-permission actor can rewrite the reserved inode in place while the
 * check is running or as its handle closes; a later-only hash would then pin
 * the REPLACEMENT as the verified state, and every downstream comparison —
 * including the post-publication proof — would agree with it. Bytes that never
 * passed SQLite integrity checking would be published as a successful backup.
 *
 * The window has no `fs` syscall inside it by design, so the hostile actor is
 * driven from the verification handle's own `close()`, which is exactly the
 * boundary the finding names.
 */

import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hostile = vi.hoisted(() => ({
  onVerificationClose: null as null | (() => void),
}));

vi.mock('@factoryos/headquarter/store', async () => {
  const actual =
    await vi.importActual<typeof import('@factoryos/headquarter/store')>(
      '@factoryos/headquarter/store',
    );
  return {
    ...actual,
    openHqDatabaseReadOnly: (dbPath?: string) => {
      const db = actual.openHqDatabaseReadOnly(dbPath);
      const realClose = db.close.bind(db);
      (db as { close: () => unknown }).close = () => {
        const result = realClose();
        hostile.onVerificationClose?.();
        return result;
      };
      return db;
    },
  };
});

import { openHqDatabase } from '@factoryos/headquarter/store';
import { openHqPersistence } from '../src/index.js';

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(process.cwd(), '.hq-verification-window-'));
  roots.push(root);
  return root;
}

function createProbeDb(file: string, value: string): void {
  const db = openHqDatabase(file);
  db.exec('CREATE TABLE IF NOT EXISTS window_probe(value TEXT NOT NULL)');
  db.exec('DELETE FROM window_probe');
  db.prepare('INSERT INTO window_probe(value) VALUES (?)').run(value);
  db.close();
}

afterEach(() => {
  hostile.onVerificationClose = null;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backup proves both sides of the integrity check', () => {
  it('refuses a rewrite installed as the verification handle closes', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const dbPath = join(root, 'hq.sqlite');
    writeFileSync(dbPath, '');
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

    const hostileSource = join(root, 'hostile-mid-check.sqlite');
    createProbeDb(hostileSource, 'never-passed-quick-check');
    const hostileBytes = readFileSync(hostileSource);
    const backupRoot = join(root, 'backups');
    const destination = join(backupRoot, 'window.sqlite');

    let rewritten = false;
    hostile.onVerificationClose = () => {
      if (rewritten) return;
      const partialName = fs.readdirSync(backupRoot).find((e) => e.includes('.partial-'));
      if (!partialName) return;
      rewritten = true;
      const partial = join(backupRoot, partialName);
      // In place: same inode, so identity checks provably cannot see it.
      const before = fs.statSync(partial).ino;
      fs.writeFileSync(partial, hostileBytes);
      expect(fs.statSync(partial).ino).toBe(before);
    };

    try {
      await expect(persistence!.backup('window.sqlite')).rejects.toThrow(
        /contents changed during integrity verification/,
      );
      expect(rewritten).toBe(true);
      expect(existsSync(destination)).toBe(false);
      // Nothing was published at all, under any name.
      const published = fs.readdirSync(backupRoot).filter((e) => !e.includes('.partial-'));
      expect(published).toEqual([]);
    } finally {
      persistence!.close();
    }
  });

  it('still publishes a backup when nothing rewrites the partial', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
    const dbPath = join(root, 'hq.sqlite');
    writeFileSync(dbPath, '');
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

    try {
      const result = await persistence!.backup('clean.sqlite');
      expect(existsSync(result.path)).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
    } finally {
      persistence!.close();
    }
  });
});
