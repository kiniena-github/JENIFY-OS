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
  directOrderCapabilityState,
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
  registerDirectOrderCapability(fixture.ops);
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
    fx.ops.registerCapability({
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
    fx.ops.registerCapability({
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
    fx.ops.registerCapability({
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
    fx.ops.registerCapability({
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
    fx.ops.registerCapability({
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
    registerDirectOrderCapability(fx.ops);
    expect(directOrderCapabilityState(fx.ops)).toBe('disabled');
  });

  it('reports the capability state truthfully in all three cases', () => {
    const bare = setupFixture();
    expect(directOrderCapabilityState(bare.ops)).toBe('missing');
    registerDirectOrderCapability(bare.ops);
    expect(directOrderCapabilityState(bare.ops)).toBe('enabled');
    new CapabilityRegistry(bare.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    expect(directOrderCapabilityState(bare.ops)).toBe('disabled');
  });
});
