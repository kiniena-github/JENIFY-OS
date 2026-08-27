/**
 * Provider execution adapters.
 *
 * Routing (packages/headquarter/src/routing) decides WHO runs. These adapters
 * are HOW a specific provider actually runs. One directory per provider, so a
 * new vendor is a new folder rather than a change to the routing contract.
 */
export * as codex from './codex/index.js';
