/**
 * Registering an execution worker is a Founder-gated canonical act (issue #224,
 * ChatGPT P1 on `83e146b`).
 *
 * ## The defect
 *
 * `dispatchClaudeTask` requires `--as-worker`, and refuses correctly when that
 * worker is missing, inactive, uncapable or undeclared. But nothing canonical
 * could CREATE the worker: `upsertSpecialist` is a store method reachable only
 * by code holding the raw database, and the dispatch tests built their executor
 * by calling it directly.
 *
 * So the boundary the design documents — "registering this worker is an explicit
 * Founder-gated configuration act" — had no implementation. On the real Founder
 * workstation the only way to satisfy the requirement dispatch imposes was to
 * open the SQLite file, which is the absence of a gate rather than a gate.
 *
 * ## What is asserted
 *
 * The act exists, carries the same authority check as the other configuration
 * acts, refuses every hostile shape, is atomic, and grants strictly less than
 * dispatch needs — registration alone never makes a worker able to claim a
 * CLAUDE-bound task.
 */

import { describe, expect, it, vi } from 'vitest';
import { setupFixture, CAPS, type Fixture } from './application.fixture.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';

const WORKER = 'claude-github-workflow';

function fixtureWithFounder(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  fixture.principals.register({
    id: 'chair',
    displayName: 'Chair',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  // A human principal WITHOUT approval authority — attributable, not authorized.
  fixture.principals.register({
    id: 'clerk',
    displayName: 'Clerk',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });
  return fixture;
}

function register(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return fixture.ops.registerExecutionWorker({
    workerId: WORKER,
    displayName: 'Claude GitHub workflow',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    founderId: 'chair',
    ...overrides,
  } as Parameters<Fixture['ops']['registerExecutionWorker']>[0]);
}

describe('only an authorized human may register an execution worker', () => {
  it('registers for a principal holding approval authority', () => {
    const fixture = fixtureWithFounder();
    const result = register(fixture);
    if (!result.ok) throw new Error(`expected ok: ${result.error.code}`);
    expect(result.data.id).toBe(WORKER);
    expect(result.data.active).toBe(true);
    expect(fixture.store.getSpecialist(WORKER)?.allowedCapabilities).toEqual([DIRECT_ORDER_CAPABILITY.id]);
  });

  it('refuses a human principal without approval authority', () => {
    const fixture = fixtureWithFounder();
    const result = register(fixture, { founderId: 'clerk' });
    expect(result.ok).toBe(false);
    expect(fixture.store.getSpecialist(WORKER)).toBeNull();
  });

  it('refuses an unknown principal', () => {
    const fixture = fixtureWithFounder();
    const result = register(fixture, { founderId: 'nobody' });
    expect(result.ok).toBe(false);
    expect(fixture.store.getSpecialist(WORKER)).toBeNull();
  });

  it('refuses a registered WORKER as the registering actor', () => {
    // The point of the gate: an execution worker must never be able to create
    // another execution worker, or grant itself a second identity. Workers hold
    // no approval authority at all, so the same check refuses them.
    const fixture = fixtureWithFounder();
    const first = register(fixture);
    expect(first.ok).toBe(true);
    const result = fixture.ops.registerExecutionWorker({
      workerId: 'a-second-worker',
      displayName: 'Second',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      founderId: WORKER,
    });
    expect(result.ok).toBe(false);
    expect(fixture.store.getSpecialist('a-second-worker')).toBeNull();
  });
});

describe('registration is create-only and deny-by-default', () => {
  it('refuses an id that already exists, and leaves it untouched', () => {
    // `upsertSpecialist` REPLACES the row, so a re-registration would silently
    // rewrite a capability allow-list — an authority — through a command that
    // reads like a bootstrap. Changing a worker belongs to the paths that own
    // that decision.
    const fixture = fixtureWithFounder();
    expect(register(fixture).ok).toBe(true);
    const result = register(fixture, { allowedCapabilities: [CAPS.dropIndex] });
    expect(result.ok).toBe(false);
    expect(fixture.store.getSpecialist(WORKER)?.allowedCapabilities).toEqual([DIRECT_ORDER_CAPABILITY.id]);
  });

  it('refuses a capability the registry does not define', () => {
    const fixture = fixtureWithFounder();
    const result = register(fixture, { allowedCapabilities: ['hq.direct_ordr'] });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('unknown_capability');
    // A typo must not produce a registered worker that can claim nothing.
    expect(fixture.store.getSpecialist(WORKER)).toBeNull();
  });

  it('refuses a mix of known and unknown capabilities', () => {
    const fixture = fixtureWithFounder();
    const result = register(fixture, {
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id, 'infra.nonexistent'],
    });
    expect(result.ok).toBe(false);
    expect(fixture.store.getSpecialist(WORKER)).toBeNull();
  });

  it('refuses an empty capability list', () => {
    const fixture = fixtureWithFounder();
    const result = register(fixture, { allowedCapabilities: [] });
    expect(result.ok).toBe(false);
    expect(fixture.store.getSpecialist(WORKER)).toBeNull();
  });

  it('refuses a blank worker id', () => {
    const fixture = fixtureWithFounder();
    expect(register(fixture, { workerId: '   ' }).ok).toBe(false);
  });
});

describe('registration is atomic and evidenced', () => {
  it('records who registered what', () => {
    const fixture = fixtureWithFounder();
    expect(register(fixture).ok).toBe(true);
    const entry = fixture.ops.queue.evidence
      .list()
      .find((e) => e.kind === 'execution_worker_registered');
    if (!entry) throw new Error('expected an evidence entry');
    expect(entry.actor).toBe('chair');
    expect(entry.payload).toMatchObject({
      workerId: WORKER,
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    });
  });

  it('rolls the registration back when its evidence cannot be written', () => {
    // The same rule as the provider declaration: a grant of execution authority
    // that survives without a record is the worst outcome, because the operator
    // is told it did not happen.
    const fixture = fixtureWithFounder();
    const append = vi.spyOn(fixture.ops.queue.evidence, 'append').mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = register(fixture);
    append.mockRestore();

    expect(result.ok).toBe(false);
    expect(fixture.store.getSpecialist(WORKER)).toBeNull();
  });
});

describe('registration grants strictly less than dispatch needs', () => {
  it('leaves the worker with no provider identity', () => {
    // Two separate Founder-gated acts, so neither alone lets a worker take
    // CLAUDE-bound work. A registered-but-undeclared worker is the shape a
    // half-finished bootstrap leaves behind, and it must not be claimable.
    const fixture = fixtureWithFounder();
    expect(register(fixture).ok).toBe(true);
    expect(fixture.ops.queue.workerProviders.providerOf(WORKER)).toBeNull();
  });

  it('does not enable, alter or re-enable any capability', () => {
    const fixture = fixtureWithFounder();
    fixture.ops.queue.capabilities.setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    expect(register(fixture).ok).toBe(true);
    expect(fixture.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)?.enabled).toBe(false);
  });
});
