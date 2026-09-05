import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStandaloneHq } from '../src/main.js';
import { attestDurableMountBoundary } from './support/durable-mount.js';
import {
  FOUNDER_COMMAND_CAPABILITY,
  HumanPrincipalRegistry,
  registerFounderCommandCapability,
} from '@factoryos/headquarter/application';

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

  it('reopens a Phase 3 mission — objective, constraints, plan, decisions, version — after a full restart', async () => {
    // Issue #253: the mission tables ride the same durable open as every other
    // canonical table, so a Founder command issued through the REAL standalone
    // process's own `HeadquarterOperations` must read back identically from the
    // next process, with its idempotency and intent fence intact.
    if (process.platform !== 'linux') return;
    const durableRoot = root();
    const env = hostedEnv(durableRoot);

    const first = await buildStandaloneHq({ env, log: () => {} });
    expect(first).not.toBeNull();
    registerFounderCommandCapability(first!.host.db);
    new HumanPrincipalRegistry(first!.host.db).register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [FOUNDER_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const created = first!.host.plane.ops.missions.createFromCommand({
      instruction: 'Fix the header and deploy it to production without changing the design.',
      requestedBy: 'founder',
      project: 'qos',
      title: 'Header fix',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = first!.host.plane.ops.missions.get(created.data.mission.id)!;
    expect(before.status).toBe('blocked');
    expect(before.tasks).toHaveLength(3);
    await first!.close();

    const second = await buildStandaloneHq({ env, log: () => {} });
    expect(second).not.toBeNull();
    const after = second!.host.plane.ops.missions.get(created.data.mission.id);
    expect(after).toEqual(before);
    expect(after!.intent.doNot).toEqual(['changing the design']);
    expect(after!.decisions.map((decision) => decision.kind)).toEqual(['founder_gate']);
    const again = second!.host.plane.ops.missions.createFromCommand({
      instruction: 'Fix the header and deploy it to production without changing the design.',
      requestedBy: 'founder',
      project: 'qos',
      title: 'Header fix',
    });
    expect(again.ok && again.data.deduplicated).toBe(true);
    const stale = second!.host.plane.ops.missions.cancel({
      missionId: created.data.mission.id,
      founderId: 'founder',
      expectedIntentVersion: 99,
      reason: 'stale reading',
    });
    expect(!stale.ok && stale.error.code).toBe('stale_intent_version');
    await second!.close();
  });
});
