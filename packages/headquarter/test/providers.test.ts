import { describe, expect, it } from 'vitest';
import { ProviderDirectory } from '../src/providers/directory.js';
import { createMockAdapter } from '../src/providers/mock.js';
import { KNOWN_PROVIDERS, registerKnownProviders } from '../src/providers/known.js';
import type { ProviderDescriptor } from '../src/providers/contracts.js';

const descriptor: ProviderDescriptor = {
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

describe('ProviderDirectory', () => {
  it('register/get/has/list round-trip', () => {
    const dir = new ProviderDirectory();
    expect(dir.has('openai')).toBe(false);
    dir.register(createMockAdapter(descriptor));
    expect(dir.has('openai')).toBe(true);
    expect(dir.get('openai')?.descriptor.providerId).toBe('openai');
    expect(dir.list()).toHaveLength(1);
  });

  it('returns null (never throws) for an unknown provider lookup', () => {
    const dir = new ProviderDirectory();
    expect(dir.get('nope')).toBeNull();
  });
});

describe('createMockAdapter', () => {
  it('probeHealth defaults to healthy and honors a fixed override', async () => {
    const adapter = createMockAdapter(descriptor);
    await expect(adapter.probeHealth('gpt-generic')).resolves.toBe('healthy');

    const degraded = createMockAdapter(descriptor, { health: 'degraded' });
    await expect(degraded.probeHealth('gpt-generic')).resolves.toBe('degraded');
  });

  it('probeHealth honors a per-model function override', async () => {
    const adapter = createMockAdapter(descriptor, {
      health: (modelId) => (modelId === 'gpt-generic' ? 'healthy' : 'unavailable'),
    });
    await expect(adapter.probeHealth('gpt-generic')).resolves.toBe('healthy');
    await expect(adapter.probeHealth('other-model')).resolves.toBe('unavailable');
  });

  // ---- scenario 8 (provider layer half): attest rejects a mismatched claim ----

  it('scenario 8: attest() accepts the advertised identity and rejects a mismatched one', async () => {
    const adapter = createMockAdapter(descriptor);
    const ok = await adapter.attest({ providerId: 'openai', modelId: 'gpt-generic', modelVersion: 'v1' });
    expect(ok).toEqual({ ok: true });

    const wrongModel = await adapter.attest({ providerId: 'openai', modelId: 'gpt-nonexistent', modelVersion: 'v1' });
    expect(wrongModel.ok).toBe(false);

    const wrongProvider = await adapter.attest({ providerId: 'anthropic', modelId: 'gpt-generic', modelVersion: 'v1' });
    expect(wrongProvider.ok).toBe(false);
  });

  it('attest() honors a full override', async () => {
    const adapter = createMockAdapter(descriptor, { attest: () => ({ ok: false, reason: 'forced rejection' }) });
    const result = await adapter.attest({ providerId: 'openai', modelId: 'gpt-generic', modelVersion: 'v1' });
    expect(result).toEqual({ ok: false, reason: 'forced rejection' });
  });
});

describe('known providers', () => {
  it('includes every required vendor seed, each with no credential-shaped fields', () => {
    const ids = KNOWN_PROVIDERS.map((p) => p.providerId);
    expect(ids).toEqual(
      expect.arrayContaining([
        'openai',
        'anthropic',
        'google',
        'microsoft',
        'xai',
        'meta-llama',
        'qwen',
        'deepseek',
        'mistral',
        'kimi',
        'local-custom',
        'jenify-ai',
      ]),
    );
    for (const descriptor of KNOWN_PROVIDERS) {
      expect(descriptor.advertisedModels.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(descriptor)).not.toMatch(/apiKey|secret|credential|password/i);
    }
  });

  it('jenify-ai is marked local, as the future/planned in-house model', () => {
    const jenify = KNOWN_PROVIDERS.find((p) => p.providerId === 'jenify-ai')!;
    expect(jenify.kind).toBe('local');
  });

  it('registerKnownProviders seeds a directory with a mock adapter per known provider', () => {
    const dir = new ProviderDirectory();
    registerKnownProviders(dir);
    for (const p of KNOWN_PROVIDERS) {
      expect(dir.has(p.providerId)).toBe(true);
    }
  });
});
