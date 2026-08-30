/**
 * Registration is configuration; placing an order is invocation
 * (issue #200, Codex P1 #2).
 *
 * The defect under regression: `CapabilityRegistry.register` wrote
 * `enabled = excluded.enabled`, which defaults to 1, and the direct-order CLI
 * called it on its way to submitting an order. So disabling `hq.direct_order`
 * — the way a deployment stops direct orders — was silently undone by the very
 * next order. A containment action must never be reversible by a routine one.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { setupFixture, CAPS, type Fixture } from './application.fixture.js';
import {
  DIRECT_ORDER_CAPABILITY,
  DIRECT_ORDER_RESERVED_CONTRACT,
  directOrderCapabilityState,
  directOrderContractDrift,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

const ORDER = {
  instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
  project: 'mesob',
  route: 'CLAUDE' as const,
  requestedBy: 'founder',
};

function ordersFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return fixture;
}

describe('re-registering a capability never re-enables it', () => {
  it('leaves a disabled capability disabled', () => {
    const fx = setupFixture();
    new CapabilityRegistry(fx.db).setEnabled(CAPS.openPr, false);
    new CapabilityRegistry(fx.db).register({
      id: CAPS.openPr,
      description: 'Open a branch-isolated PR',
      riskClass: 'external_side_effect',
      sideEffect: true,
      idempotent: true,
    });
    expect(fx.ops.queue.capabilities.get(CAPS.openPr)!.enabled).toBe(false);
  });

  it('still updates the definition — only the enabled state is left alone', () => {
    const fx = setupFixture();
    new CapabilityRegistry(fx.db).setEnabled(CAPS.openPr, false);
    new CapabilityRegistry(fx.db).register({
      id: CAPS.openPr,
      description: 'Open a PR (revised wording)',
      riskClass: 'destructive',
      sideEffect: true,
      idempotent: false,
    });
    const capability = fx.ops.queue.capabilities.get(CAPS.openPr)!;
    expect(capability.description).toBe('Open a PR (revised wording)');
    expect(capability.riskClass).toBe('destructive');
    expect(capability.enabled).toBe(false);
  });

  it('enables one only when a caller says so explicitly', () => {
    const fx = setupFixture();
    new CapabilityRegistry(fx.db).setEnabled(CAPS.openPr, false);
    new CapabilityRegistry(fx.db).register({
      id: CAPS.openPr,
      description: 'Open a branch-isolated PR',
      riskClass: 'external_side_effect',
      sideEffect: true,
      idempotent: true,
      enabled: true,
    });
    expect(fx.ops.queue.capabilities.get(CAPS.openPr)!.enabled).toBe(true);
  });

  it('still defaults a brand-new capability to enabled', () => {
    const fx = setupFixture();
    new CapabilityRegistry(fx.db).register({
      id: 'brand.new',
      description: 'A capability nobody has seen before',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    expect(fx.ops.queue.capabilities.get('brand.new')!.enabled).toBe(true);
  });

  it('honours an explicit disabled registration for a new capability', () => {
    const fx = setupFixture();
    new CapabilityRegistry(fx.db).register({
      id: 'brand.new',
      description: 'Registered, deliberately off',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
      enabled: false,
    });
    expect(fx.ops.queue.capabilities.get('brand.new')!.enabled).toBe(false);
  });
});

describe('placing an order honours the capability state and never changes it', () => {
  it('fails closed on a DISABLED capability, and leaves it disabled', () => {
    const fx = ordersFixture();
    new CapabilityRegistry(fx.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    const result = submitDirectOrder(fx.ops, ORDER, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('capability_disabled');
    expect(directOrderCapabilityState(fx.ops)).toBe('disabled');
    // And nothing was created on the way to the refusal.
    expect(fx.ops.queue.listByStatus('needs_approval')).toEqual([]);
    expect(fx.ops.queue.listByStatus('queued')).toEqual([]);
  });

  it('fails closed on a MISSING capability, and does not register it', () => {
    const fx = setupFixture();
    fx.principals.register({
      id: 'founder2',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    expect(directOrderCapabilityState(fx.ops)).toBe('missing');
    const result = submitDirectOrder(fx.ops, { ...ORDER, requestedBy: 'founder2' }, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('capability_not_registered');
    expect(directOrderCapabilityState(fx.ops)).toBe('missing');
  });

  it('does not resurrect a disabled capability however many orders are attempted', () => {
    const fx = ordersFixture();
    new CapabilityRegistry(fx.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      submitDirectOrder(fx.ops, { ...ORDER, instruction: `attempt ${attempt}` }, CLAUDE_ONLY);
    }
    expect(directOrderCapabilityState(fx.ops)).toBe('disabled');
  });

  it('registration is the one deliberate act that re-registers — and it too respects disabled', () => {
    const fx = ordersFixture();
    new CapabilityRegistry(fx.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    registerDirectOrderCapability(fx.db);
    expect(directOrderCapabilityState(fx.ops)).toBe('disabled');
  });

  it('reports the capability state truthfully in all three cases', () => {
    const bare = setupFixture();
    expect(directOrderCapabilityState(bare.ops)).toBe('missing');
    registerDirectOrderCapability(bare.db);
    expect(directOrderCapabilityState(bare.ops)).toBe('enabled');
    new CapabilityRegistry(bare.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    expect(directOrderCapabilityState(bare.ops)).toBe('disabled');
  });
});

/**
 * The id is not the guarantee — the row is (issue #219, Codex P1 on `49da330`).
 *
 * `CapabilityRegistry.register` updates the definition of a capability that
 * already exists, by design. So anything that can register can re-register
 * `hq.direct_order` with `riskClass: 'read_only', sideEffect: false`, and the
 * policy engine — which reads risk from the registry and never from the
 * payload — then stops routing a direct order into `needs_approval`. Reading
 * only the id and the enabled flag, `directOrderCapabilityState` said
 * `enabled`, `submitDirectOrder` accepted arbitrary free-text work, and it was
 * queued for execution with no Founder approval, through the one path whose
 * entire justification is that it is Founder-gated.
 *
 * The host deliberately consumes an existing registration rather than
 * restoring the definition at startup, so the check lives at the read: fail
 * closed while the row does not match the reserved contract.
 */
describe('a weakened direct-order definition fails closed', () => {
  /** Re-register the reserved id with a different definition. */
  function reregister(fx: Fixture, definition: Record<string, unknown>): void {
    new CapabilityRegistry(fx.db).register({
      id: DIRECT_ORDER_CAPABILITY.id,
      description: DIRECT_ORDER_CAPABILITY.description,
      riskClass: DIRECT_ORDER_CAPABILITY.riskClass,
      sideEffect: DIRECT_ORDER_CAPABILITY.sideEffect,
      idempotent: DIRECT_ORDER_CAPABILITY.idempotent,
      ...definition,
    } as Parameters<CapabilityRegistry['register']>[0]);
  }

  // The reason this matters, proved rather than asserted: with the weakened
  // row in place, the canonical create path really does queue the work outright
  // instead of holding it for approval. The refusal below is what stands
  // between that row and an executed order.
  it('would genuinely lose the approval gate — the danger is real, not theoretical', () => {
    const fx = ordersFixture();
    const gated = fx.ops.createTask({
      capabilityId: DIRECT_ORDER_CAPABILITY.id,
      payload: { kind: 'direct_order', instruction: 'before' },
      idempotencyKey: 'before',
      requestedBy: 'founder',
    });
    expect(gated.ok).toBe(true);
    expect(gated.ok && gated.data.task.status).toBe('needs_approval');

    reregister(fx, { riskClass: 'read_only', sideEffect: false });
    const ungated = fx.ops.createTask({
      capabilityId: DIRECT_ORDER_CAPABILITY.id,
      payload: { kind: 'direct_order', instruction: 'after' },
      idempotencyKey: 'after',
      requestedBy: 'founder',
    });
    expect(ungated.ok).toBe(true);
    expect(ungated.ok && ungated.data.task.status).toBe('queued');
  });

  it('reports `altered` for every single-field drift in the reserved contract', () => {
    for (const [field, definition] of [
      ['riskClass', { riskClass: 'external_side_effect' }],
      ['sideEffect', { sideEffect: false }],
      ['idempotent', { idempotent: false }],
    ] as const) {
      const fx = ordersFixture();
      expect(directOrderCapabilityState(fx.ops)).toBe('enabled');
      reregister(fx, definition);
      expect(directOrderCapabilityState(fx.ops), field).toBe('altered');
      expect(directOrderContractDrift(fx.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)!))
        .toEqual([field]);
    }
  });

  it('refuses the order, names the drifted fields, and creates nothing', () => {
    const fx = ordersFixture();
    reregister(fx, { riskClass: 'read_only', sideEffect: false });

    const result = submitDirectOrder(fx.ops, ORDER, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('capability_definition_altered');
    expect(result.error.details?.drift).toEqual(['riskClass', 'sideEffect']);
    expect(fx.ops.queue.listByStatus('needs_approval')).toEqual([]);
    expect(fx.ops.queue.listByStatus('queued')).toEqual([]);
  });

  // Detecting the drift is not the same as fixing it. An invocation path that
  // quietly restored the reserved definition would be the same mistake as one
  // that quietly re-enables a disabled capability.
  it('does not repair the definition, however many orders are attempted', () => {
    const fx = ordersFixture();
    reregister(fx, { riskClass: 'read_only', sideEffect: false });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      submitDirectOrder(fx.ops, { ...ORDER, instruction: `attempt ${attempt}` }, CLAUDE_ONLY);
    }
    const capability = fx.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)!;
    expect(capability.riskClass).toBe('read_only');
    expect(directOrderCapabilityState(fx.ops)).toBe('altered');
  });

  // `altered` is read before `enabled`, so re-enabling a weakened row is not
  // the moment the weakened contract silently takes effect.
  it('stays `altered` whether the weakened row is enabled or disabled', () => {
    const fx = ordersFixture();
    reregister(fx, { riskClass: 'read_only', sideEffect: false });
    expect(directOrderCapabilityState(fx.ops)).toBe('altered');
    new CapabilityRegistry(fx.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    expect(directOrderCapabilityState(fx.ops)).toBe('altered');
    new CapabilityRegistry(fx.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, true);
    expect(directOrderCapabilityState(fx.ops)).toBe('altered');
  });

  // The deliberate configuration action is what repairs it — and it is still
  // not allowed to re-enable a capability someone disabled on purpose.
  it('is repaired only by the explicit registration action', () => {
    const fx = ordersFixture();
    reregister(fx, { riskClass: 'read_only', sideEffect: false });
    registerDirectOrderCapability(fx.db);
    expect(directOrderCapabilityState(fx.ops)).toBe('enabled');
    const result = submitDirectOrder(fx.ops, ORDER, CLAUDE_ONLY);
    expect(result.ok).toBe(true);

    const disabled = ordersFixture();
    new CapabilityRegistry(disabled.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    reregister(disabled, { riskClass: 'read_only', sideEffect: false });
    registerDirectOrderCapability(disabled.db);
    expect(directOrderCapabilityState(disabled.ops)).toBe('disabled');
  });

  // Prose is not the contract. A reworded description must not start refusing
  // orders, or the check becomes something deployments learn to work around.
  it('ignores description drift, which changes no guarantee', () => {
    const fx = ordersFixture();
    reregister(fx, { description: 'Founder direct order (reworded for the console).' });
    expect(directOrderCapabilityState(fx.ops)).toBe('enabled');
    expect(submitDirectOrder(fx.ops, ORDER, CLAUDE_ONLY).ok).toBe(true);
  });

  // The reserved contract is read from the constant, so the two can never
  // disagree about what "unaltered" means.
  it('accepts exactly the reserved definition', () => {
    const fx = ordersFixture();
    expect(
      directOrderContractDrift(fx.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)!),
    ).toEqual([]);
    expect(DIRECT_ORDER_RESERVED_CONTRACT).toEqual({
      riskClass: 'founder_gate',
      sideEffect: true,
      idempotent: true,
    });
  });
});
