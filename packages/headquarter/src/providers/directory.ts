/**
 * In-memory directory of registered provider adapters.
 *
 * This is the ONLY thing member/routing business logic is allowed to
 * depend on for "does this provider exist / what does it claim" questions
 * (issue #119, order 4). No file under `src/registry/` imports a concrete
 * vendor — everything goes through this directory and the contracts in
 * `contracts.ts`, so adding a new vendor never touches business logic.
 */

import type { ProviderAdapter } from './contracts.js';

export class ProviderDirectory {
  private adapters = new Map<string, ProviderAdapter>();

  /** Registers (or replaces) the adapter for a provider id. */
  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.descriptor.providerId, adapter);
  }

  /** Returns null for an unknown provider — callers must handle that, not throw here. */
  get(providerId: string): ProviderAdapter | null {
    return this.adapters.get(providerId) ?? null;
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
