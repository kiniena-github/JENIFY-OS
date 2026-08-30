/**
 * LIVE HQ CONTROL (issue #200).
 *
 * The seam between canonical Headquarter state and a browser:
 *
 *   provenance.ts   the live / reconstructed / sample vocabulary every
 *                   section carries, so a preview can never pass as truth
 *   local-trust.ts  the actor-authentication vocabulary and the fail-closed
 *                   rules for the trusted-local-admin CLI, so no interface can
 *                   claim to authenticate a human that nothing authenticates
 *   auth.ts         the Founder authentication boundary — a live JENIFY OS
 *                   session plus an explicit account→principal binding, the
 *                   only thing in HQ that may say a human was authenticated
 *   control-api.ts  the narrow browser write surface built on that boundary:
 *                   direct order, approve, deny, and nothing else
 *   redaction.ts    the fail-closed browser-safety guard (no secrets, no
 *                   fabricated metrics) applied to every snapshot
 *   connections.ts  Connection Center — evidence-derived integration health,
 *                   with the pluggable probe seam for `+ Add Connection`
 *   orders.ts       Direct Orders — the narrow, Founder-gated write path onto
 *                   the existing HeadquarterOperations facade
 *   snapshot.ts     the read-only projection the UI polls
 */
export * from './provenance.js';
export * from './local-trust.js';
export * from './auth.js';
export * from './control-api.js';
export * from './redaction.js';
export * from './connections.js';
export * from './orders.js';
export * from './snapshot.js';
