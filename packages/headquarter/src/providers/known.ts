/**
 * Data-only seed descriptors for widely-known AI providers (issue #119,
 * order 4). These are informational seeds — NOT integrations, NOT
 * capability grants, and NOT auth of any kind. Registering a provider
 * descriptor here does zero: it just makes `member.register()` accept that
 * providerId and lets routing reason about the model's advertised shape.
 *
 * A member still needs its capabilities explicitly GRANTED by a registrar
 * (see `registry/members.ts`) before anything can route to it — nothing in
 * this file widens permissions on its own.
 *
 * advertisedCapabilities below are deliberately conservative generic
 * guesses (e.g. a general-purpose chat model gets 'reasoning' and
 * 'research', not every domain it might theoretically handle). Real
 * capability grants for a real deployed member are a separate, explicit
 * step.
 */

import type { ProviderDescriptor } from './contracts.js';
import { ProviderDirectory } from './directory.js';
import { createMockAdapter, type MockAdapterOptions } from './mock.js';

export const KNOWN_PROVIDERS: readonly ProviderDescriptor[] = [
  {
    providerId: 'openai',
    displayName: 'OpenAI',
    kind: 'cloud',
    advertisedModels: [
      {
        modelId: 'gpt-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'coding', 'research', 'documents'],
        contextWindowTokens: 128000,
        defaultCostClass: 'medium',
        locality: 'cloud',
      },
      {
        modelId: 'gpt-generic-image',
        modelVersion: 'latest',
        advertisedCapabilities: ['image'],
        contextWindowTokens: null,
        defaultCostClass: 'medium',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    kind: 'cloud',
    advertisedModels: [
      {
        modelId: 'claude-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'coding', 'research', 'documents', 'browser_computer_use'],
        contextWindowTokens: 200000,
        defaultCostClass: 'medium',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'google',
    displayName: 'Google',
    kind: 'cloud',
    advertisedModels: [
      {
        modelId: 'gemini-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'research', 'retrieval', 'documents'],
        contextWindowTokens: 1000000,
        defaultCostClass: 'medium',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'microsoft',
    displayName: 'Microsoft',
    kind: 'cloud',
    advertisedModels: [
      {
        modelId: 'copilot-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['coding', 'documents', 'connectors'],
        contextWindowTokens: 128000,
        defaultCostClass: 'medium',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'xai',
    displayName: 'xAI',
    kind: 'cloud',
    advertisedModels: [
      {
        modelId: 'grok-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'research'],
        contextWindowTokens: 128000,
        defaultCostClass: 'medium',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'meta-llama',
    displayName: 'Meta (Llama)',
    kind: 'hybrid',
    advertisedModels: [
      {
        modelId: 'llama-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'translation'],
        contextWindowTokens: 128000,
        defaultCostClass: 'low',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'qwen',
    displayName: 'Alibaba (Qwen)',
    kind: 'hybrid',
    advertisedModels: [
      {
        modelId: 'qwen-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'coding', 'translation'],
        contextWindowTokens: 128000,
        defaultCostClass: 'low',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    kind: 'cloud',
    advertisedModels: [
      {
        modelId: 'deepseek-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'coding'],
        contextWindowTokens: 128000,
        defaultCostClass: 'low',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'mistral',
    displayName: 'Mistral AI',
    kind: 'hybrid',
    advertisedModels: [
      {
        modelId: 'mistral-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'coding'],
        contextWindowTokens: 128000,
        defaultCostClass: 'low',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'kimi',
    displayName: 'Moonshot AI (Kimi)',
    kind: 'cloud',
    advertisedModels: [
      {
        modelId: 'kimi-generic',
        modelVersion: 'latest',
        advertisedCapabilities: ['reasoning', 'research', 'retrieval'],
        contextWindowTokens: 200000,
        defaultCostClass: 'low',
        locality: 'cloud',
      },
    ],
  },
  {
    providerId: 'local-custom',
    displayName: 'Local Custom Runtime',
    kind: 'local',
    advertisedModels: [
      {
        modelId: 'local-generic',
        modelVersion: 'unversioned',
        advertisedCapabilities: ['local_execution', 'coding'],
        contextWindowTokens: 8192,
        defaultCostClass: 'free',
        locality: 'local',
      },
    ],
  },
  {
    // Future/planned — JENIFY's own local model, not yet built. Included
    // here so the directory/registry shapes are ready when it exists;
    // registering this descriptor grants nothing on its own.
    providerId: 'jenify-ai',
    displayName: 'Jenify AI (planned, local)',
    kind: 'local',
    advertisedModels: [
      {
        modelId: 'jenify-ai-generic',
        modelVersion: 'planned',
        advertisedCapabilities: ['local_execution'],
        contextWindowTokens: null,
        defaultCostClass: 'free',
        locality: 'local',
      },
    ],
  },
] as const;

/**
 * Convenience for tests/dev wiring: registers every known descriptor into a
 * directory using mock adapters (no network). Real deployments would
 * register real adapters per provider instead of calling this.
 */
export function registerKnownProviders(
  directory: ProviderDirectory,
  adapterOptionsByProviderId: Readonly<Record<string, MockAdapterOptions>> = {},
): void {
  for (const descriptor of KNOWN_PROVIDERS) {
    directory.register(createMockAdapter(descriptor, adapterOptionsByProviderId[descriptor.providerId] ?? {}));
  }
}
