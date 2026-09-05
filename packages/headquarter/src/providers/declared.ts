/**
 * Declared-only ProviderAdapter — catalog knowledge without invented liveness
 * (Phase 4, issue #262).
 *
 * The production host needs a `ProviderDirectory` so the AI member registry
 * can validate `providerId` at registration — but HQ performs no vendor
 * probes, and `createMockAdapter` (tests) answers `'healthy'` by default,
 * which in production would be a FABRICATED availability claim. This adapter
 * carries the vendor's declared descriptor and answers the only two things
 * it can answer honestly:
 *
 * - `probeHealth` -> 'unknown', always. Nothing asked the service, so
 *   nothing is claimed. Real health arrives only through an explicit
 *   Founder-declared `setAiMemberHealth`, or a real probe in a later phase.
 * - `attest` checks the CLAIM against the DECLARED catalog: provider id must
 *   match and the model/version must appear among the advertised models.
 *   That is a statement about the vendor's published catalog, not about the
 *   service being reachable — used alongside, never instead of, the
 *   registry's own `verifyIdentity`.
 */

import type {
  AttestResult,
  IdentityClaim,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderHealth,
} from './contracts.js';

export function declaredOnlyAdapter(descriptor: ProviderDescriptor): ProviderAdapter {
  return {
    descriptor,
    async probeHealth(): Promise<ProviderHealth> {
      return 'unknown';
    },
    attest(identity: IdentityClaim): AttestResult {
      if (identity.providerId !== descriptor.providerId) {
        return {
          ok: false,
          reason: `Provider mismatch: claimed '${identity.providerId}', adapter is '${descriptor.providerId}'`,
        };
      }
      const known = descriptor.advertisedModels.some(
        (m) => m.modelId === identity.modelId && m.modelVersion === identity.modelVersion,
      );
      if (!known) {
        return {
          ok: false,
          reason:
            `Provider '${descriptor.providerId}' does not advertise model ` +
            `'${identity.modelId}' version '${identity.modelVersion}'`,
        };
      }
      return { ok: true };
    },
  };
}
