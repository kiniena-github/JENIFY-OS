/**
 * The HQ browser client runtime (issue #250, Phase 2 Stage 4).
 *
 * One package boundary for everything the browser side of HQ is: the typed
 * wire contracts, the seventeen-destination room registry, the pure hydration
 * that turns canonical state into rooms, the access/lock decisions, the
 * emitted runtime, and the procedural 3D shell.
 *
 * Nothing here opens a database, spawns a process or reaches a network. The
 * server-side half of this stage is one read route in `live/control-api.ts`,
 * which calls `hydrateRooms` and nothing else from this module.
 */

export * from './contracts.js';
export * from './rooms.js';
export * from './hydrate.js';
export * from './access.js';
export * from './runtime.js';
export * from './webgl.js';
export * from './theme.js';
export { immersiveBody, IMMERSIVE_HONESTY_NOTE } from './page.js';
