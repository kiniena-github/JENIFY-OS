/**
 * Synthetic ProviderAdapter for tests and for any provider that has no live
 * probe/attest implementation yet. Performs no network access whatsoever.
 */

import type { AttestResult, IdentityClaim, ProviderAdapter, ProviderDescriptor, ProviderHealth } from './contracts.js';

export interface MockAdapterOptions {
  /** Fixed health, or a function for per-model/per-call control in tests. */
  health?: ProviderHealth | ((modelId: string) => ProviderHealth);
  /** Override the default attest behavior entirely. */
  attest?: (identity: IdentityClaim) => AttestResult;
}

/**
 * Default attest behavior: ok only when the claimed model/version appears in
 * the descriptor's advertisedModels AND the claimed providerId matches. This
 * mirrors the real check a live adapter would perform, without a network.
 */
function defaultAttest(descriptor: ProviderDescriptor, identity: IdentityClaim): AttestResult {
  if (identity.providerId !== descriptor.providerId) {
    return { ok: false, reason: `Provider mismatch: claimed '${identity.providerId}', adapter is '${descriptor.providerId}'` };
  }
  const known = descriptor.advertisedModels.some(
    (m) => m.modelId === identity.modelId && m.modelVersion === identity.modelVersion,
  );
  if (!known) {
    return {
      ok: false,
      reason: `Provider '${descriptor.providerId}' does not advertise model '${identity.modelId}' version '${identity.modelVersion}'`,
    };
  }
  return { ok: true };
}

export function createMockAdapter(descriptor: ProviderDescriptor, opts: MockAdapterOptions = {}): ProviderAdapter {
  return {
    descriptor,
    async probeHealth(modelId: string): Promise<ProviderHealth> {
      if (typeof opts.health === 'function') return opts.health(modelId);
      return opts.health ?? 'healthy';
    },
    attest(identity: IdentityClaim): AttestResult {
      if (opts.attest) return opts.attest(identity);
      return defaultAttest(descriptor, identity);
    },
  };
}
