import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HumanPrincipalRegistry,
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '@factoryos/headquarter/application';
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
    // Driven through the REAL mission code path (`commandMission` on the
    // hosted control plane's own operations facade): the derived digest, the
    // capability gate, the intent lock and the evidence append are all the
    // production machinery, not hand-written rows (Opus second-pass finding
    // on `cee771f`: the previous shape seeded raw SQL and proved only that
    // the tables sit on the durable volume).
    registerMissionCommandCapability(first!.host.db);
    new HumanPrincipalRegistry(first!.host.db).register({
      id: 'founder',
      displayName: 'Restart Proof Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const commanded = first!.host.plane.ops.commandMission({
      title: 'Survive the restart',
      objective: 'Prove mission rows live on the durable volume',
      constraints: ['do not lose this row'],
      instruction: 'The raw hosted restart order, preserved server-side.',
      requestedBy: 'founder',
    });
    if (!commanded.ok) throw new Error(`commandMission refused: ${commanded.error.message}`);
    const missionId = commanded.data.mission.id;
    await first!.close();

    const second = await buildStandaloneHq({ env, log: () => {} });
    expect(second).not.toBeNull();
    const row = second!.host.db
      .prepare('SELECT id, status FROM hq_projects WHERE id = ?')
      .get('restart-process') as { id: string; status: string } | undefined;
    expect(row).toEqual({ id: 'restart-process', status: 'working' });
    // Read back through the facade too — the whole path, both directions.
    const mission = second!.host.plane.ops.getMission(missionId);
    expect(mission).not.toBeNull();
    expect(mission!.status).toBe('planned');
    expect(mission!.title).toBe('Survive the restart');
    expect(mission!.constraints).toEqual(['do not lose this row']);
    const history = second!.host.plane.ops.getMissionIntentHistory(missionId);
    expect(history).toHaveLength(1);
    expect(history[0]!.seq).toBe(0);
    expect(history[0]!.kind).toBe('founder_order');
    expect(history[0]!.body).toContain('The raw hosted restart order');
    // And re-commanding the identical order after the restart deduplicates
    // onto the surviving mission — the derived digest is stable on disk.
    const again = second!.host.plane.ops.commandMission({
      title: 'Survive the restart',
      objective: 'Prove mission rows live on the durable volume',
      constraints: ['do not lose this row'],
      instruction: 'The raw hosted restart order, preserved server-side.',
      requestedBy: 'founder',
    });
    if (!again.ok) throw new Error(`re-command refused: ${again.error.message}`);
    expect(again.data.deduplicated).toBe(true);
    expect(again.data.mission.id).toBe(missionId);
    expect(second!.host.persistence.config.mode).toBe('durable-volume');
    expect(second!.host.persistence.config.runtime).toBe('hosted');
    await second!.close();
  });
});
