import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { openHqDatabaseReadOnly } from '@factoryos/headquarter/store';
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

function entryExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function hostedEnv(root: string): Record<string, string> {
  const dbPath = join(root, 'hq.sqlite');
  // Hosted Stage 3 deliberately refuses to create the DB through a raceable
  // pathname. The mounted-volume initializer/operator pre-creates the regular
  // file; SQLite then owns its contents/schema. Never follow a dangling link.
  if (!entryExists(dbPath)) writeFileSync(dbPath, '');
  return {
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_RUNTIME: 'hosted',
    FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
    FACTORYOS_HQ_DURABLE_ROOT: root,
  };
}

function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    // Some Windows developer environments do not grant symlink creation. CI
    // exercises the hostile case on Linux; do not make local Windows unusable.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
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
        { ...hostedEnv(root), FACTORYOS_HQ_DB: join(other, 'wrong.sqlite') },
        (line) => logs.push(line),
      ),
    ).toBeNull();
    expect(logs.join('\n')).toContain('must live inside FACTORYOS_HQ_DURABLE_ROOT');
  });

  it('refuses a missing hosted DB instead of creating through an unpinned pathname', () => {
    const root = durableRoot();
    const logs: string[] = [];
    expect(
      resolveHqPersistenceConfig(
        {
          FACTORYOS_HQ_DB: join(root, 'hq.sqlite'),
          FACTORYOS_HQ_RUNTIME: 'hosted',
          FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
          FACTORYOS_HQ_DURABLE_ROOT: root,
        },
        (line) => logs.push(line),
      ),
    ).toBeNull();
    expect(logs.join('\n')).toContain('must already exist as a regular file');
    expect(existsSync(join(root, 'hq.sqlite'))).toBe(false);
  });

  it('refuses a dangling DB symlink before SQLite can create its outside target', () => {
    const root = durableRoot();
    const outsideRoot = durableRoot();
    const outsideTarget = join(outsideRoot, 'not-created-yet.sqlite');
    const dbLink = join(root, 'hq.sqlite');
    if (!trySymlink(outsideTarget, dbLink)) return;

    const logs: string[] = [];
    expect(resolveHqPersistenceConfig(hostedEnv(root), (line) => logs.push(line))).toBeNull();
    expect(logs.join('\n')).toContain('must not be a symbolic link');
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it('also refuses a valid final DB symlink inside the durable root', () => {
    const root = durableRoot();
    const target = join(root, 'real.sqlite');
    writeFileSync(target, '');
    const dbLink = join(root, 'hq.sqlite');
    if (!trySymlink(target, dbLink)) return;

    const logs: string[] = [];
    expect(resolveHqPersistenceConfig(hostedEnv(root), (line) => logs.push(line))).toBeNull();
    expect(logs.join('\n')).toContain('must not be a symbolic link');
  });

  it('preserves old local-file behavior when Stage 3 variables are absent', () => {
    const root = durableRoot();
    const config = resolveHqPersistenceConfig({ FACTORYOS_HQ_DB: join(root, 'local.sqlite') }, () => {});
    expect(config?.runtime).toBe('local');
    expect(config?.mode).toBe('local-file');
  });
});

describe('Stage 3 durable SQLite adapter', () => {
  it('boots only with the required effective WAL/FULL SQLite modes and inode attestation', () => {
    const root = durableRoot();
    const persistence = openHqPersistence(hostedEnv(root), () => {});
    if (process.platform !== 'linux') {
      // Hosted Stage 3 currently fails closed where descriptor-backed procfs
      // attestation is unavailable. Local/workstation mode remains portable.
      expect(persistence).toBeNull();
      return;
    }
    expect(persistence).not.toBeNull();
    expect(String(persistence!.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(persistence!.db.pragma('synchronous', { simple: true }))).toBe(2);
    persistence!.close();
  });

  it('survives a full close/reopen with canonical HQ state intact', () => {
    if (process.platform !== 'linux') return;
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
    if (process.platform !== 'linux') return;
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

  it('publishes only one backup when two callers race for the same name', async () => {
    if (process.platform !== 'linux') return;
    const root = durableRoot();
    const persistence = openHqPersistence(hostedEnv(root), () => {})!;
    const results = await Promise.allSettled([
      persistence.backup('same-name.sqlite'),
      persistence.backup('same-name.sqlite'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(existsSync(join(root, 'backups', 'same-name.sqlite'))).toBe(true);
    persistence.close();
  });

  it('creates an integrity-checked backup and restores only into a new file', async () => {
    if (process.platform !== 'linux') return;
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

  it('never removes an existing recovery destination', async () => {
    if (process.platform !== 'linux') return;
    const root = durableRoot();
    const persistence = openHqPersistence(hostedEnv(root), () => {})!;
    const backup = await persistence.backup('recovery-source.sqlite');
    persistence.close();

    const destination = join(root, 'already-there.sqlite');
    writeFileSync(destination, 'do-not-delete');
    expect(() => restoreHqBackupToNewFile(backup.path, destination)).toThrow(/refuses to overwrite/);
    expect(readFileSync(destination, 'utf8')).toBe('do-not-delete');
  });

  it('treats a dangling recovery destination symlink as existing and preserves it', async () => {
    if (process.platform !== 'linux') return;
    const root = durableRoot();
    const outsideRoot = durableRoot();
    const persistence = openHqPersistence(hostedEnv(root), () => {})!;
    const backup = await persistence.backup('recovery-link-source.sqlite');
    persistence.close();

    const destination = join(root, 'recovery-target.sqlite');
    const outsideTarget = join(outsideRoot, 'future.sqlite');
    if (!trySymlink(outsideTarget, destination)) return;

    expect(() => restoreHqBackupToNewFile(backup.path, destination)).toThrow(/refuses to overwrite/);
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(readlinkSync(destination)).toBe(outsideTarget);
    expect(existsSync(outsideTarget)).toBe(false);
  });
});
