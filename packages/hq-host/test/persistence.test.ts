import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  openHqDatabaseReadOnly,
} from '@factoryos/headquarter/store';
import {
  openHqPersistence,
  resolveHqPersistenceConfig,
  restoreHqBackupToNewFile,
} from '../src/index.js';

const roots: string[] = [];

function durableRoot(): string {
  // Deliberately NOT os.tmpdir(): hosted durability rejects the OS temp tree.
  const root = mkdtempSync(join(process.cwd(), '.hq-durable-test-'));
  roots.push(root);
  return root;
}

function hostedEnv(root: string): Record<string, string> {
  return {
    FACTORYOS_HQ_DB: join(root, 'hq.sqlite'),
    FACTORYOS_HQ_RUNTIME: 'hosted',
    FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
    FACTORYOS_HQ_DURABLE_ROOT: root,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Stage 3 hosted persistence configuration', () => {
  it('fails closed when hosted mode does not explicitly name durable storage', () => {
    const root = durableRoot();
    const logs: string[] = [];
    expect(
      resolveHqPersistenceConfig(
        { FACTORYOS_HQ_DB: join(root, 'hq.sqlite'), FACTORYOS_HQ_RUNTIME: 'hosted' },
        (line) => logs.push(line),
      ),
    ).toBeNull();
    expect(logs.join('\n')).toContain('requires FACTORYOS_HQ_PERSISTENCE=durable-volume');
  });

  it('refuses a database outside the attested durable root', () => {
    const root = durableRoot();
    const other = durableRoot();
    const logs: string[] = [];
    expect(
      resolveHqPersistenceConfig(
        {
          ...hostedEnv(root),
          FACTORYOS_HQ_DB: join(other, 'wrong.sqlite'),
        },
        (line) => logs.push(line),
      ),
    ).toBeNull();
    expect(logs.join('\n')).toContain('must live inside FACTORYOS_HQ_DURABLE_ROOT');
  });

  it('preserves old local-file behavior when Stage 3 variables are absent', () => {
    const root = durableRoot();
    const config = resolveHqPersistenceConfig({ FACTORYOS_HQ_DB: join(root, 'local.sqlite') }, () => {});
    expect(config?.runtime).toBe('local');
    expect(config?.mode).toBe('local-file');
  });
});

describe('Stage 3 durable SQLite adapter', () => {
  it('survives a full close/reopen with canonical HQ state intact', () => {
    const root = durableRoot();
    const env = hostedEnv(root);

    const first = openHqPersistence(env, () => {});
    expect(first).not.toBeNull();
    first!.db
      .prepare(
        `INSERT INTO hq_projects(id, name, stream, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('project-restart', 'Restart proof', 'hq', 'must survive restart', 'working', 't0', 't0');
    first!.checkpoint();
    first!.close();

    const second = openHqPersistence(env, () => {});
    expect(second).not.toBeNull();
    const row = second!.db
      .prepare('SELECT id, status FROM hq_projects WHERE id = ?')
      .get('project-restart') as { id: string; status: string } | undefined;
    expect(row).toEqual({ id: 'project-restart', status: 'working' });
    expect(second!.healthy()).toBe(true);
    second!.close();
  });

  it('keeps idempotency and lease/fence truth after restart', () => {
    const root = durableRoot();
    const env = hostedEnv(root);
    const first = openHqPersistence(env, () => {})!;
    first.db
      .prepare(
        `INSERT INTO op_capabilities(id, description, risk_class, side_effect, idempotent, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('proof.cap', 'proof', 'small', 1, 1, 1);
    first.db
      .prepare(
        `INSERT INTO op_tasks(
           id, capability_id, payload, idempotency_key, status, fence, claimed_by,
           lease_expires_at, claim_nonce, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-1', 'proof.cap', '{}', 'same-command', 'working', 7, 'worker-a',
        '2099-01-01T00:00:00.000Z', 'nonce-7', 'founder', 't0', 't0',
      );
    first.close();

    const second = openHqPersistence(env, () => {})!;
    const task = second.db
      .prepare('SELECT fence, claimed_by, claim_nonce FROM op_tasks WHERE id = ?')
      .get('task-1') as { fence: number; claimed_by: string; claim_nonce: string };
    expect(task).toEqual({ fence: 7, claimed_by: 'worker-a', claim_nonce: 'nonce-7' });
    expect(() =>
      second.db
        .prepare(
          `INSERT INTO op_tasks(
             id, capability_id, payload, idempotency_key, status, fence, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('task-2', 'proof.cap', '{}', 'same-command', 'waiting', 0, 'founder', 't1', 't1'),
    ).toThrow();
    second.close();
  });

  it('creates an integrity-checked backup and restores only into a new file', async () => {
    const root = durableRoot();
    const env = hostedEnv(root);
    const persistence = openHqPersistence(env, () => {})!;
    persistence.db
      .prepare(
        `INSERT INTO hq_projects(id, name, stream, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('project-backup', 'Backup proof', 'hq', 'recover me', 'verified', 't0', 't0');

    const backup = await persistence.backup('proof.sqlite');
    expect(existsSync(backup.path)).toBe(true);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    persistence.close();

    const restoredPath = join(root, 'restored.sqlite');
    const restored = restoreHqBackupToNewFile(backup.path, restoredPath);
    expect(restored.path).toBe(restoredPath);

    const restoredDb = openHqDatabaseReadOnly(restoredPath);
    const row = restoredDb
      .prepare('SELECT id, status FROM hq_projects WHERE id = ?')
      .get('project-backup') as { id: string; status: string } | undefined;
    expect(row).toEqual({ id: 'project-backup', status: 'verified' });
    restoredDb.close();

    expect(() => restoreHqBackupToNewFile(backup.path, restoredPath)).toThrow(
      /refuses to overwrite/,
    );
  });
});
