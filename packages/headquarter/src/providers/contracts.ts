/**
 * Provider-neutral contracts for AI model/tool vendors (issue #119).
 *
 * These types describe what a provider and its models CLAIM to be and do.
 * They are deliberately data shapes, not a real integration:
 *
 * - NO credential fields anywhere in this file. Auth (API keys, OAuth
 *   tokens, service accounts, ...) lives entirely outside this layer, in
 *   whatever execution worker actually talks to the vendor. Nothing here
 *   is a place secrets could accidentally end up.
 * - "advertised" data (ProviderModelInfo, descriptor contents) is UNTRUSTED
 *   INPUT — a vendor's own description of its product. The registry layer
 *   (`src/registry/`) never treats advertised data as a grant of anything;
 *   see `registry/capabilities.ts` and `registry/members.ts` for the
 *   advertised-vs-granted security boundary.
 */

/** How a provider's models run relative to this machine. */
export type ProviderKind = 'cloud' | 'local' | 'hybrid';

/** Where one specific model actually executes. */
export type ProviderLocality = 'local' | 'cloud';

/** Coarse, provider-claimed cost tier for a model. Informational only. */
export type ProviderCostClass = 'free' | 'low' | 'medium' | 'high' | 'premium';

/** Health as last observed by a probe. Never trust a stale value silently. */
export type ProviderHealth = 'unknown' | 'healthy' | 'degraded' | 'unavailable';

/**
 * One model a provider claims to offer. This is advertised metadata, not a
 * capability grant — see the note in the module doc comment above.
 */
export interface ProviderModelInfo {
  modelId: string;
  /** Provider's own version/build label for the model. */
  modelVersion: string;
  /** Capability domain ids the vendor claims this model supports. */
  advertisedCapabilities: string[];
  contextWindowTokens: number | null;
  defaultCostClass: ProviderCostClass;
  locality: ProviderLocality;
}

/** A provider (vendor or local runtime) and the models it claims to offer. */
export interface ProviderDescriptor {
  /** Stable id, e.g. 'openai', 'anthropic', 'local-custom'. */
  providerId: string;
  displayName: string;
  kind: ProviderKind;
  advertisedModels: ProviderModelInfo[];
}

/** An identity a caller claims to be dispatching as, checked before dispatch. */
export interface IdentityClaim {
  providerId: string;
  modelId: string;
  modelVersion: string;
}

export interface AttestResult {
  ok: boolean;
  /** Present when ok is false — why the claim was rejected. */
  reason?: string;
}

/**
 * The integration seam for one provider. Implementations may reach out to
 * the real vendor (never done inside this package) or be entirely synthetic
 * (see `mock.ts`, used by tests and by any provider without a live probe
 * yet). Registry/routing code depends only on this interface plus
 * `ProviderDirectory` — never on a concrete vendor SDK.
 */
export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  /** Best-effort liveness/quality check for one model. No network access
   * is performed by this package itself — implementations own that. */
  probeHealth(modelId: string): Promise<ProviderHealth>;
  /**
   * Confirms (or rejects) a claimed identity against what this provider
   * actually offers. Used alongside — never instead of — the registry's
   * own `AiMemberRegistry.verifyIdentity`, which checks against the
   * identity a member was actually REGISTERED with.
   */
  attest(identity: IdentityClaim): AttestResult | Promise<AttestResult>;
}
