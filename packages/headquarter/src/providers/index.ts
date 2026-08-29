/**
 * Provider layer.
 *
 * Two distinct concerns live side by side here:
 *
 * - the provider-neutral contracts/directory/known-provider descriptors used by
 *   the AI Member + Capability Registry (lane C), and
 * - per-provider execution adapters. Routing
 *   (packages/headquarter/src/routing) decides WHO runs; these adapters are HOW
 *   a specific provider actually runs. One directory per provider, so a new
 *   vendor is a new folder rather than a change to the routing contract.
 */
export * from './contracts.js';
export * from './directory.js';
export * from './known.js';
export * from './mock.js';

export * as codex from './codex/index.js';
export * as claude from './claude/index.js';
