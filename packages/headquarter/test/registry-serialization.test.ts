import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';
import { AiMemberRegistry } from '../src/registry/members.js';
import { exportRegistry, importRegistry, type RegistrySnapshot } from '../src/registry/serialization.js';
import type { MemberCapability } from '../src/registry/capabilities.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import { createMockAdapter } from '../src/providers/mock.js';
import type { ProviderDescriptor } from '../src/providers/contracts.js';

const openaiDescriptor: ProviderDescriptor = {
  providerId: 'openai',
  displayName: 'OpenAI',
  kind: 'cloud',
  advertisedModels: [
    {
      modelId: 'gpt-generic',
      modelVersion: 'v1',
      advertisedCapabilities: ['coding'],
      contextWindowTokens: 128000,
      defaultCostClass: 'medium',
      locality: 'cloud',
    },
  ],
};

function makeSourceRegistry() {
  const db = openMemoryHqDatabase();
  const capabilities = new MemberCapabilityRegistry(db);
  capabilities.register({ id: 'coding', domain: 'coding', description: 'General coding', riskClass: 'reversible' });

  const providers = new ProviderDirectory();
  providers.register(createMockAdapter(openaiDescriptor));

  const members = new AiMemberRegistry(db, providers, capabilities);
  members.defineRole('coder', ['coding'], 'Plain coder');
  members.register({
    id: 'member-1',
    displayName: 'Test Member',
    providerId: 'openai',
    modelId: 'gpt-generic',
    modelVersion: 'v1',
    workerType: 'execution',
    locality: 'cloud',
    privacyClass: 'internal',
    costClass: 'medium',
    advertisedCapabilities: ['coding'],
    grantedCapabilities: ['coding'],
    roleEligibility: ['coder'],
  });
  members.addBenchmark('member-1', { ref: 'coding', score: 77, recordedAt: '2026-01-01T00:00:00.000Z' });

  return { db, providers };
}

describe('registry serialization (no-vendor-lock-in)', () => {
  it('scenario 10: export -> import into a fresh db round-trips equal on neutral fields', () => {
    const { db: sourceDb, providers } = makeSourceRegistry();
    const snapshot = exportRegistry(sourceDb);

    const targetDb: HqDatabase = openMemoryHqDatabase();
    const result = importRegistry(targetDb, snapshot, { providerDirectory: providers });
    expect(result.ok).toBe(true);
    expect(result.imported).toEqual({ capabilities: 1, roles: 1, members: 1 });

    const roundTripped = exportRegistry(targetDb);
    expect(roundTripped).toEqual(snapshot);
  });

  it('scenario 10: the snapshot contains no vendor-specific keys, only neutral fields', () => {
    const { db } = makeSourceRegistry();
    const snapshot = exportRegistry(db);
    const raw = JSON.stringify(snapshot);
    // no adapter objects, no functions, no credential-shaped fields
    expect(raw).not.toMatch(/probeHealth|attest|apiKey|secret|credential|password/i);
    expect(snapshot.members[0].providerId).toBe('openai'); // just the neutral id string
  });

  it('import is all-or-nothing: an unknown provider referenced by a member rejects the whole snapshot', () => {
    const { db } = makeSourceRegistry();
    const snapshot = exportRegistry(db);

    const emptyDirectory = new ProviderDirectory(); // 'openai' not registered here
    const targetDb = openMemoryHqDatabase();
    const result = importRegistry(targetDb, snapshot, { providerDirectory: emptyDirectory });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.itemType === 'member' && /Unknown provider/.test(e.message))).toBe(true);
    // nothing was written
    expect(exportRegistry(targetDb).members).toHaveLength(0);
    expect(exportRegistry(targetDb).capabilities).toHaveLength(0);
  });

  it('import is all-or-nothing: an unknown capability domain in the snapshot rejects the whole snapshot with a per-item error', () => {
    const { db, providers } = makeSourceRegistry();
    const snapshot = exportRegistry(db);
    const invalidCapability = {
      id: 'bogus',
      domain: 'time_travel',
      description: 'bad',
      riskClass: 'reversible',
      enabled: true,
    } as unknown as MemberCapability; // deliberately invalid domain, for the test
    const corrupted: RegistrySnapshot = {
      ...snapshot,
      capabilities: [...snapshot.capabilities, invalidCapability],
    };

    const targetDb = openMemoryHqDatabase();
    const result = importRegistry(targetDb, corrupted, { providerDirectory: providers });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.itemType === 'capability' && e.id === 'bogus')).toBe(true);
    expect(exportRegistry(targetDb).members).toHaveLength(0);
  });

  it('rejects an unsupported schemaVersion', () => {
    const { db, providers } = makeSourceRegistry();
    const snapshot = exportRegistry(db);
    const targetDb = openMemoryHqDatabase();
    const result = importRegistry(targetDb, { ...snapshot, schemaVersion: 2 as never }, { providerDirectory: providers });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/schemaVersion/);
  });

  it('rejects importing a member id that already exists in the target database', () => {
    const { db, providers } = makeSourceRegistry();
    const snapshot = exportRegistry(db);

    const targetDb = openMemoryHqDatabase();
    const first = importRegistry(targetDb, snapshot, { providerDirectory: providers });
    expect(first.ok).toBe(true);

    const second = importRegistry(targetDb, snapshot, { providerDirectory: providers });
    expect(second.ok).toBe(false);
    expect(second.errors.some((e) => /already exists/.test(e.message))).toBe(true);
  });
});
