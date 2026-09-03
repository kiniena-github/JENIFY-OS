import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openHqDatabase, openHqDatabaseReadOnly } from '@factoryos/headquarter/store';
import { openHqPersistence, restoreHqBackupToNewFile } from '../src/index.js';

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(process.cwd(), '.hq-recovery-race-'));
  roots.push(root);
  return root;
}

function createProbeDb(file: string, value: string): void {
  const db = openHqDatabase(file);
  db.exec('CREATE TABLE IF NOT EXISTS recovery_probe(value TEXT NOT NULL)');
  db.exec('DELETE FROM recovery_probe');
  db.prepare('INSERT INTO recovery_probe(value) VALUES (?)').run(value);
  db.close();
}

function readProbe(file: string): string {
  const db = openHqDatabaseReadOnly(file);
  const row = db.prepare('SELECT value FROM recovery_probe LIMIT 1').get() as { value: string };
  db.close();
  return row.value;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Stage 3 descriptor-bound recovery', () => {
  it('copies the exact source inode that passed integrity verification', () => {
    if (process.platform !== 'linux') return;
    const root = testRoot();
    const source = join(root, 'source.sqlite');
    const replacement = join(root, 'replacement.sqlite');
    const hiddenOriginal = join(root, 'source-original-hidden.sqlite');
    const destination = join(root, 'restored.sqlite');
    createProbeDb(source, 'verified-original');
    createProbeDb(replacement, 'hostile-replacement');

    const realOpenSync = fs.openSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      const fd = (realOpenSync as any)(candidate, flags, mode);
      if (!swapped && String(candidate) === source) {
        swapped = true;
        fs.renameSync(source, hiddenOriginal);
        fs.copyFileSync(replacement, source);
      }
      return fd;
    }) as any);

    const result = restoreHqBackupToNewFile(source, destination);
    expect(swapped).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(readProbe(destination)).toBe('verified-original');
    expect(readProbe(source)).toBe('hostile-replacement');
  });

  it('never accepts or removes a replacement swapped onto the destination pathname', () => {
    if (process.platform !== 'linux') return;
    const root = testRoot();
    const source = join(root, 'source.sqlite');
    const replacement = join(root, 'replacement.sqlite');
    const destination = join(root, 'restored.sqlite');
    const hiddenCreated = join(root, 'created-hidden.sqlite');
    createProbeDb(source, 'verified-original');
    createProbeDb(replacement, 'hostile-destination');

    const realOpenSync = fs.openSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: unknown, flags: unknown, mode?: unknown) => {
      const fd = (realOpenSync as any)(candidate, flags, mode);
      if (!swapped && String(candidate) === destination) {
        swapped = true;
        fs.renameSync(destination, hiddenCreated);
        fs.copyFileSync(replacement, destination);
      }
      return fd;
    }) as any);

    expect(() => restoreHqBackupToNewFile(source, destination)).toThrow(
      /destination changed during verification/,
    );
    expect(swapped).toBe(true);
    expect(readProbe(destination)).toBe('hostile-destination');
  });

  it('rejects an invalid backup name before acquiring the backup-directory descriptor', async () => {
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

    const openSpy = vi.spyOn(fs, 'openSync');
    await expect(persistence!.backup('../escape.sqlite')).rejects.toThrow(/plain filename/);
    expect(openSpy).not.toHaveBeenCalled();
    persistence!.close();
  });
});
