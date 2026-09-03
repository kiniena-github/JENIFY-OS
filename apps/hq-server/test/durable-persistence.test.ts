import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStandaloneHq } from '../src/main.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(process.cwd(), '.hq-server-durable-test-'));
  roots.push(value);
  return value;
}

function hostedEnv(durableRoot: string): Record<string, string> {
  const dbPath = join(durableRoot, 'hq.sqlite');
  if (!existsSync(dbPath)) writeFileSync(dbPath, '');
  return {
    FACTORYOS_HQ_CONTROL: '1',
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_RUNTIME: 'hosted',
    FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
    FACTORYOS_HQ_DURABLE_ROOT: durableRoot,
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('standalone HQ durable hosted runtime', () => {
  it('fails closed instead of booting hosted mode on an ordinary local file', async () => {
    const durableRoot = root();
    const logs: string[] = [];
    const built = await buildStandaloneHq({
      env: {
        FACTORYOS_HQ_CONTROL: '1',
        FACTORYOS_HQ_DB: join(durableRoot, 'hq.sqlite'),
        FACTORYOS_HQ_RUNTIME: 'hosted',
      },
      log: (line) => logs.push(line),
    });
    expect(built).toBeNull();
    expect(logs.join('\n')).toContain('requires FACTORYOS_HQ_PERSISTENCE=durable-volume');
  });

  it('reopens the same canonical state after the standalone process is fully closed', async () => {
    if (process.platform !== 'linux') return;
    const durableRoot = root();
    const env = hostedEnv(durableRoot);

    const first = await buildStandaloneHq({ env, log: () => {} });
    expect(first).not.toBeNull();
    first!.host.db
      .prepare(
        `INSERT INTO hq_projects(id, name, stream, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('restart-process', 'Hosted restart', 'hq', 'persist across process restart', 'working', 't0', 't0');
    await first!.close();

    const second = await buildStandaloneHq({ env, log: () => {} });
    expect(second).not.toBeNull();
    const row = second!.host.db
      .prepare('SELECT id, status FROM hq_projects WHERE id = ?')
      .get('restart-process') as { id: string; status: string } | undefined;
    expect(row).toEqual({ id: 'restart-process', status: 'working' });
    expect(second!.host.persistence.config.mode).toBe('durable-volume');
    expect(second!.host.persistence.config.runtime).toBe('hosted');
    await second!.close();
  });
});
