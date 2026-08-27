import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';
import { ensureRegistrySchema } from '../src/registry/db.js';

describe('registry schema', () => {
  it('ensureRegistrySchema is idempotent', () => {
    const db = openMemoryHqDatabase();
    expect(() => ensureRegistrySchema(db)).not.toThrow();
    expect(() => ensureRegistrySchema(db)).not.toThrow();
  });
});

describe('MemberCapabilityRegistry', () => {
  let db: HqDatabase;
  let registry: MemberCapabilityRegistry;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    registry = new MemberCapabilityRegistry(db);
  });

  it('registers a capability with a known domain and risk class', () => {
    registry.register({ id: 'coding.general', domain: 'coding', description: 'General coding', riskClass: 'reversible' });
    const cap = registry.get('coding.general');
    expect(cap).toMatchObject({ id: 'coding.general', domain: 'coding', enabled: true });
  });

  it('rejects an unknown capability domain', () => {
    expect(() =>
      registry.register({
        id: 'bogus.thing',
        // @ts-expect-error deliberately invalid for the test
        domain: 'time_travel',
        description: 'nope',
        riskClass: 'reversible',
      }),
    ).toThrow(/Unknown capability domain/);
  });

  it('rejects an unknown risk class', () => {
    expect(() =>
      registry.register({
        id: 'coding.general',
        domain: 'coding',
        description: 'General coding',
        // @ts-expect-error deliberately invalid for the test
        riskClass: 'apocalyptic',
      }),
    ).toThrow(/Unknown risk class/);
  });

  it('lists all registered capabilities and can disable one', () => {
    registry.register({ id: 'image.generation', domain: 'image', description: 'Generate images', riskClass: 'reversible' });
    registry.register({ id: 'coding.general', domain: 'coding', description: 'General coding', riskClass: 'reversible' });
    expect(registry.list().map((c) => c.id).sort()).toEqual(['coding.general', 'image.generation']);

    registry.setEnabled('image.generation', false);
    expect(registry.get('image.generation')?.enabled).toBe(false);
    expect(registry.isGrantable('image.generation').ok).toBe(false);
    expect(registry.isGrantable('coding.general').ok).toBe(true);
  });

  it('setEnabled throws for an unknown capability id', () => {
    expect(() => registry.setEnabled('does.not.exist', true)).toThrow(/Unknown capability/);
  });

  it('isGrantable reports unregistered capabilities as not grantable', () => {
    expect(registry.isGrantable('never.registered')).toMatchObject({ ok: false });
  });

  it('covers every declared capability domain across a smoke registration', () => {
    // Exercise all fourteen domains at once — cheap protection against a
    // domain silently disappearing from MEMBER_CAPABILITY_DOMAINS.
    const domains = [
      'coding',
      'research',
      'design',
      'browser_computer_use',
      'documents',
      'image',
      'video',
      'audio',
      'reasoning',
      'retrieval',
      'connectors',
      'local_execution',
      'translation',
      'data_analysis',
    ] as const;
    for (const domain of domains) {
      registry.register({ id: `${domain}.smoke`, domain, description: domain, riskClass: 'read_only' });
    }
    expect(registry.list()).toHaveLength(domains.length);
  });
});
