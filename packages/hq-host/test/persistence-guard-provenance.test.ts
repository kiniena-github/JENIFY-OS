import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHqPersistenceConfig } from '../src/persistence-guard.js';

const roots: string[] = [];

function tempRoot(label: string): string {
  const value = fs.mkdtempSync(path.join(process.cwd(), `.${label}`));
  roots.push(value);
  return value;
}

function hostedEnv(durableRoot: string): Record<string, string> {
  const dbPath = path.join(durableRoot, 'hq.sqlite');
  fs.writeFileSync(dbPath, '');
  return {
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_RUNTIME: 'hosted',
    FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
    FACTORYOS_HQ_DURABLE_ROOT: durableRoot,
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('hosted persistence guard', () => {
  it('refuses hosted durable-volume configuration without positive operator/provider provenance', () => {
    const durableRoot = tempRoot('hq-guard-provenance-');
    const logs: string[] = [];

    const config = resolveHqPersistenceConfig(hostedEnv(durableRoot), (line) => logs.push(line));

    expect(config).toBeNull();
    expect(logs.join('\n')).toContain('FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE');
    expect(logs.join('\n')).toContain('filesystem type alone is not durability provenance');
  });

  it('accepts an explicit stable operator volume identity at configuration time', () => {
    const durableRoot = tempRoot('hq-guard-provenance-');
    const logs: string[] = [];
    const env = {
      ...hostedEnv(durableRoot),
      FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE: 'operator:jenify-hq-volume-01',
    };

    const config = resolveHqPersistenceConfig(env, (line) => logs.push(line));

    expect(config).not.toBeNull();
    expect(logs.join('\n')).toContain('durable volume provenance: operator:jenify-hq-volume-01');
  });

  it('refuses a backup path whose existing symlink ancestor resolves outside the durable root', () => {
    const durableRoot = tempRoot('hq-guard-root-');
    const outside = tempRoot('hq-guard-outside-');
    const link = path.join(durableRoot, 'linked-backups');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const logs: string[] = [];
    const env = {
      ...hostedEnv(durableRoot),
      FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE: 'provider:stable-volume-123',
      FACTORYOS_HQ_BACKUP_DIR: path.join(link, 'nested'),
    };

    const config = resolveHqPersistenceConfig(env, (line) => logs.push(line));

    expect(config).toBeNull();
    expect(logs.join('\n')).toContain('resolves outside FACTORYOS_HQ_DURABLE_ROOT');
    expect(fs.existsSync(path.join(outside, 'nested'))).toBe(false);
  });
});
