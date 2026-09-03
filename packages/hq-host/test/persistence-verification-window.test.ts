/**
 * Defense-in-depth coverage for the backup integrity-check window.
 *
 * Stage 3 is explicitly single-process/single-writer. The before/after content
 * proofs below are intended to catch ordinary in-place mutation and accidental
 * interference around `quick_check`; they are NOT an immutable-snapshot claim
 * against an arbitrary second process with the same OS permissions performing
 * an A→B→A rewrite while SQLite verifies the inode. That stronger attacker is
 * outside the Stage 3 threat boundary and must be excluded operationally by the
 * accepted hosted runtime/provider.
 *
 * The window has no `fs` syscall inside it by design, so this regression drives
 * a simple rewrite from the verification handle's own `close()` and proves the
 * existing defense-in-depth rejection remains intact.
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
import { attestDurableMountBoundary } from './support/durable-mount.js';

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

describe('backup verification-window defense in depth', () => {
  it('refuses a simple rewrite installed as the verification handle closes', async () => {
    if (process.platform !== 'linux') return;

    const root = testRoot();
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
      // In place: same inode, so identity checks alone cannot see it.
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

    try {
      const result = await persistence!.backup('clean.sqlite');
      expect(existsSync(result.path)).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
    } finally {
      persistence!.close();
    }
  });
});
