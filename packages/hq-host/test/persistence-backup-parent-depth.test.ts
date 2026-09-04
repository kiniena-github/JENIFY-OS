import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openHqPersistence } from '../src/index.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('hosted backup parent-chain durability bound', () => {
  it('fails closed before startup when the complete parent chain exceeds 32 directories', () => {
    if (process.platform !== 'linux') return;

    const root = mkdtempSync(join(process.cwd(), '.hq-backup-depth-'));
    roots.push(root);
    const dbPath = join(root, 'hq.sqlite');
    writeFileSync(dbPath, '');
    attestDurableMountBoundary(root);

    const backupRoot = Array.from({ length: 33 }, (_, index) => `d${index}`).reduce(
      (current, component) => join(current, component),
      root,
    );
    const logs: string[] = [];

    const persistence = openHqPersistence(
      {
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_RUNTIME: 'hosted',
        FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
        FACTORYOS_HQ_DURABLE_ROOT: root,
        FACTORYOS_HQ_BACKUP_DIR: backupRoot,
      },
      (line) => logs.push(line),
    );

    expect(persistence).toBeNull();
    expect(logs.join('\n')).toMatch(/requires 33 parent-directory commits/);
    expect(logs.join('\n')).toMatch(/exceeding the hosted Stage 3 durability limit of 32/);
  });
});
