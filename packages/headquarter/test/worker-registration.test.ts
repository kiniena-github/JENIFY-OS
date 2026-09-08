import { EvidenceLog } from '../src/operator/evidence.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
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
  registerDirectOrderCapability(fixture.db);
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

  it('refuses an id that is already a HUMAN principal', () => {
    const fixture = fixtureWithFounder();
    const result = register(fixture, { workerId: 'chair' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_permitted');
    expect(fixture.store.getSpecialist('chair')).toBeNull();

    // Both consequences the refusal exists to prevent, asserted rather than
    // described. Had the registration succeeded, `chair` would be a human that
    // may execute — `rejectHumanExecution` waves through any id the worker
    // directory knows — and, at the same moment, a Founder locked out of the
    // approval authority they still hold, because `assertApprovalAuthority`
    // refuses every registered worker. Registration is create-only and has no
    // revoke, so undoing it would mean opening the database: exactly the
    // boundary this method exists to remove.
    expect(fixture.ops.workers.isRegistered('chair')).toBe(false);
    expect(fixture.ops.engageKillSwitch('containment', 'chair', 'still authorized').ok).toBe(true);
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
    const append = vi.spyOn(EvidenceLog.prototype, 'append').mockImplementation(() => {
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
    expect(fixture.ops.queue.providerOf(WORKER)).toBeNull();
  });

  it('does not enable, alter or re-enable any capability', () => {
    const fixture = fixtureWithFounder();
    new CapabilityRegistry(fixture.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    expect(register(fixture).ok).toBe(true);
    expect(fixture.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)?.enabled).toBe(false);
  });
});

/**
 * Wave 5, correction round fourteen — Low 6: an in-process call that OMITS a
 * required field threw a `TypeError` out of the facade instead of returning
 * `invalid_input`.
 *
 * `input.allowedCapabilities.length` and `input.workerId.trim()` both
 * dereferenced a field this method never checked was present. Not reachable
 * through the control API, which validates the body first — which is why it is a
 * Low — but a facade method's contract is that it ANSWERS, and a refusal is an
 * answer where a throw is not. The same class as Medium 3 next door, one layer
 * up: a reader, or a writer, must be total over what it can actually be handed.
 */
describe('registerExecutionWorker answers rather than throws on a malformed input', () => {
  it('refuses every omitted required field with invalid_input, and never raises', () => {
    for (const omitted of ['workerId', 'allowedCapabilities'] as const) {
      const fixture = fixtureWithFounder();
      const input: Record<string, unknown> = {
        workerId: 'omission-probe',
        displayName: 'Omission probe',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: [CAPS.readStatus],
        founderId: 'chair',
      };
      delete input[omitted];
      let result: { ok: boolean; error?: { code: string } };
      expect(() => {
        result = fixture.ops.registerExecutionWorker(
          input as Parameters<Fixture['ops']['registerExecutionWorker']>[0],
        );
      }, `omitting ${omitted} must not raise`).not.toThrow();
      expect(result!.ok, `omitting ${omitted} must be refused`).toBe(false);
      expect(result!.error!.code, `omitting ${omitted}`).toBe('invalid_input');
      // And nothing was registered by the refused call.
      expect(fixture.store.getSpecialist('omission-probe') ?? null).toBe(null);
    }
  });

  it('refuses a wrong-typed allowedCapabilities the same way', () => {
    for (const value of [null, 'read_status', 42, {}]) {
      const fixture = fixtureWithFounder();
      const result = fixture.ops.registerExecutionWorker({
        workerId: 'type-probe',
        displayName: 'Type probe',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: value,
        founderId: 'chair',
      } as unknown as Parameters<Fixture['ops']['registerExecutionWorker']>[0]);
      expect(result.ok, `allowedCapabilities = ${JSON.stringify(value)}`).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('invalid_input');
    }
  });
});
