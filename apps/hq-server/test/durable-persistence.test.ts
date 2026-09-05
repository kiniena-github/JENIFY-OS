import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStandaloneHq } from '../src/main.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(process.cwd(), '.hq-server-durable-test-'));
  roots.push(value);
  return value;
}

function hostedEnv(durableRoot: string): Record<string, string> {
  const dbPath = join(durableRoot, 'hq.sqlite');
  if (!existsSync(dbPath)) writeFileSync(dbPath, '');
  attestDurableMountBoundary(durableRoot);
  return {
    FACTORYOS_HQ_CONTROL: '1',
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_RUNTIME: 'hosted',
    FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
    FACTORYOS_HQ_DURABLE_ROOT: durableRoot,
    FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE: 'operator:test-durable-volume',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
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
    // Phase 3 (issue #254): a commanded mission — the canonical aggregate
    // with its immutable intent row — must survive the same full restart.
    // Written through the same additive schema the service initialises, on
    // the same durable file.
    first!.host.db
      .prepare(
        `INSERT INTO hq_missions
           (id, title, objective, constraints, status, depends_on, idempotency_key,
            created_by, created_at, updated_at, status_changed_at, status_changed_by)
         VALUES (?, ?, ?, ?, 'planned', '[]', ?, ?, 't0', 't0', 't0', ?)`,
      )
      .run(
        'mission-restart-proof',
        'Survive the restart',
        'Prove mission rows live on the durable volume',
        '["do not lose this row"]',
        'mission:restart-proof',
        'founder',
        'founder',
      );
    first!.host.db
      .prepare(
        `INSERT INTO hq_mission_intents
           (id, mission_id, seq, kind, body, objective, constraints, actor, at)
         VALUES (?, ?, 0, 'founder_order', ?, ?, ?, 'founder', 't0')`,
      )
      .run(
        'intent-restart-proof',
        'mission-restart-proof',
        '{"kind":"founder_order"}',
        'Prove mission rows live on the durable volume',
        '["do not lose this row"]',
      );
    await first!.close();

    const second = await buildStandaloneHq({ env, log: () => {} });
    expect(second).not.toBeNull();
    const row = second!.host.db
      .prepare('SELECT id, status FROM hq_projects WHERE id = ?')
      .get('restart-process') as { id: string; status: string } | undefined;
    expect(row).toEqual({ id: 'restart-process', status: 'working' });
    const mission = second!.host.db
      .prepare('SELECT id, status, title FROM hq_missions WHERE id = ?')
      .get('mission-restart-proof') as { id: string; status: string; title: string } | undefined;
    expect(mission).toEqual({
      id: 'mission-restart-proof',
      status: 'planned',
      title: 'Survive the restart',
    });
    const intent = second!.host.db
      .prepare('SELECT seq, kind FROM hq_mission_intents WHERE mission_id = ?')
      .get('mission-restart-proof') as { seq: number; kind: string } | undefined;
    expect(intent).toEqual({ seq: 0, kind: 'founder_order' });
    expect(second!.host.persistence.config.mode).toBe('durable-volume');
    expect(second!.host.persistence.config.runtime).toBe('hosted');
    await second!.close();
  });
});
