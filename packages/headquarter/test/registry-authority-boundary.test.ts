/**
 * Issue #182 — hostile end-to-end proof that supplying the AI Member Registry
 * never WIDENS execution authority.
 *
 * PR #178 closed the Registry ↔ Application capability seam (#174 Mission C)
 * but composed the two directories symmetrically: where only the Registry knew
 * a worker, the Registry answered alone. That made Registry membership a route
 * into execution — an id that was `worker_unknown` before `memberRegistry` was
 * passed became assignable, with Registry-granted capabilities, after.
 *
 * These tests attack the seam from the outside, through the real task paths
 * (create / route / assign / claim / start / approve), and pin the invariant
 * that makes the seam safe to switch on:
 *
 *   For every worker id, enabling the Registry can only ever REMOVE authority.
 *   Capabilities are a subset of the base directory's; assignability implies
 *   the base directory would also have said yes.
 *
 * The base (operator/specialist) directory therefore stays the canonical
 * worker-registration authority. Migrating that authority to the Registry
 * would be a separate, deliberately reviewed change — not a side effect of
 * wiring the seam.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/operator/capabilities.js';

import {
  HeadquarterOperations,
  NarrowingWorkerDirectory,
  RegistryWorkerDirectory,
  SpecialistDirectoryAdapter,
  type MemberDirectorySource,
  type WorkerDirectoryPort,
} from '../src/application/index.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import {
  AiMemberRegistry,
  MemberCapabilityRegistry,
  type RegisterMemberInput,
} from '../src/registry/index.js';
import { ProviderDirectory } from '../src/providers/index.js';
import { createMockAdapter } from '../src/providers/mock.js';
import type { ProviderDescriptor } from '../src/providers/contracts.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';

const ANTHROPIC: ProviderDescriptor = {
  providerId: 'anthropic',
  displayName: 'Anthropic',
  kind: 'cloud',
  advertisedModels: [
    {
      modelId: 'model',
      modelVersion: '1',
      advertisedCapabilities: ['docs.write', 'deploy.run'],
      contextWindowTokens: 200000,
      defaultCostClass: 'medium',
      locality: 'cloud',
    },
  ],
};

/** Capability ids, registered in BOTH registries so neither is the bottleneck. */
const CAPS = ['docs.write', 'deploy.run'];

let db: HqDatabase;
let store: HeadquarterStore;
let registry: AiMemberRegistry;

beforeEach(() => {
  db = openMemoryHqDatabase();
  store = new HeadquarterStore(db);
  const capabilities = new MemberCapabilityRegistry(db);
  const providers = new ProviderDirectory();
  providers.register(createMockAdapter(ANTHROPIC));
  registry = new AiMemberRegistry(db, providers, capabilities);
  for (const id of CAPS) {
    capabilities.register({ id, domain: 'coding', riskClass: 'read_only', description: id });
  }
});

function memberSpec(id: string, granted: string[], over: Record<string, unknown> = {}): RegisterMemberInput {
  return {
    id,
    displayName: id,
    providerId: 'anthropic',
    modelId: 'model',
    modelVersion: '1',
    workerType: 'execution',
    locality: 'cloud',
    privacyClass: 'internal',
    costClass: 'low',
    advertisedCapabilities: [...CAPS],
    grantedCapabilities: granted,
    ...over,
  } as RegisterMemberInput;
}

function registerMember(id: string, granted: string[], over: Record<string, unknown> = {}): void {
  registry.register(memberSpec(id, granted, over));
}

function registerSpecialist(id: string, allowed: string[], active = true): void {
  store.upsertSpecialist({
    id,
    displayName: id,
    vendor: 'anthropic',
    role: 'parallel_implementer',
    allowedCapabilities: allowed,
    active,
  });
}

/**
 * A `HeadquarterOperations` with the operator capabilities registered.
 * `withRegistry: false` builds the SAME world without the seam, which is the
 * baseline every widening test compares against.
 */
function makeOps(withRegistry = true): HeadquarterOperations {
  const ops = new HeadquarterOperations(db, {
    store,
    ...(withRegistry ? { memberRegistry: registry } : {}),
  });
  for (const id of CAPS) {
    new CapabilityRegistry(db).register({
      id,
      description: id,
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
  }
  return ops;
}

function composite(): WorkerDirectoryPort {
  return new NarrowingWorkerDirectory(
    new SpecialistDirectoryAdapter(store),
    new RegistryWorkerDirectory(registry),
  );
}

function errorCode(result: { ok: true } | { ok: false; error: { code: string } }): string {
  return result.ok ? 'ok' : result.error.code;
}

// ===========================================================================
// 1. A Registry-only member cannot route, claim or start — however granted
// ===========================================================================
describe('a Registry-only member gains NOTHING from the Registry being enabled', () => {
  beforeEach(() => {
    // Fully granted, active, healthy — and unknown to the operator directory.
    registerMember('ghost-worker', [...CAPS]);
  });

  it('holds no capabilities and is not assignable', () => {
    const dir = makeOps().workers;
    expect([...dir.allowedCapabilities('ghost-worker')]).toEqual([]);
    const verdict = dir.assignability('ghost-worker');
    expect(verdict.assignable).toBe(false);
    expect(verdict).toMatchObject({ reason: 'worker_unknown', details: { knownTo: 'registry_only' } });
    // The Registry itself would have said yes — that is exactly the widening.
    expect(new RegistryWorkerDirectory(registry).assignability('ghost-worker').assignable).toBe(true);
  });

  it('cannot open work', () => {
    const created = makeOps().createTask({
      capabilityId: 'deploy.run',
      payload: {},
      idempotencyKey: 'ghost-create',
      requestedBy: 'ghost-worker',
    });
    expect(created.ok).toBe(false);
    expect(errorCode(created)).toBe('worker_not_assignable');
  });

  it('cannot claim work queued by a legitimate worker', () => {
    registerSpecialist('w1', ['deploy.run']);
    registerMember('w1', ['deploy.run']);
    const ops = makeOps();
    expect(
      ops.createTask({
        capabilityId: 'deploy.run',
        payload: {},
        idempotencyKey: 'ghost-claim',
        requestedBy: 'w1',
      }).ok,
    ).toBe(true);

    const claim = ops.claimNext('ghost-worker', 'deploy.run');
    expect(claim.ok).toBe(false);
    expect(errorCode(claim)).toBe('worker_not_assignable');
    // and the task is still there for whoever may legitimately take it
    expect(ops.claimNext('w1', 'deploy.run').ok).toBe(true);
  });

  it('cannot start a task, even one already claimed and fenced by someone else', () => {
    registerSpecialist('w1', ['deploy.run']);
    registerMember('w1', ['deploy.run']);
    const ops = makeOps();
    ops.createTask({
      capabilityId: 'deploy.run',
      payload: {},
      idempotencyKey: 'ghost-start',
      requestedBy: 'w1',
    });
    const claimed = ops.claimNext('w1', 'deploy.run');
    expect(claimed.ok).toBe(true);
    const task = claimed.ok ? claimed.data : null;

    const start = ops.startTask(task!.id, 'ghost-worker', task!.fence!);
    expect(start.ok).toBe(false);
    expect(errorCode(start)).toBe('worker_not_assignable');
  });

  it('cannot be handed an assignment intent', () => {
    registerSpecialist('w1', ['deploy.run']);
    const ops = makeOps();
    const created = ops.createTask({
      capabilityId: 'deploy.run',
      payload: {},
      idempotencyKey: 'ghost-assign',
      requestedBy: 'w1',
    });
    expect(created.ok).toBe(true);
    const taskId = created.ok ? created.data.task.id : '';

    const assigned = ops.assignTask(taskId, 'ghost-worker', 'w1');
    expect(assigned.ok).toBe(false);
    expect(errorCode(assigned)).toBe('worker_not_assignable');
  });

  it('is routed as INELIGIBLE even when a nomination source pushes it hard', () => {
    registerSpecialist('w1', ['deploy.run']);
    const ops = new HeadquarterOperations(db, {
      store,
      memberRegistry: registry,
      nominationSources: [
        {
          id: 'hostile-source',
          nominate: () => [
            { workerId: 'ghost-worker', rationale: 'best model available' },
            { workerId: 'w1', rationale: 'known worker' },
          ],
        },
      ],
    });
    new CapabilityRegistry(db).register({
      id: 'deploy.run',
      description: 'deploy.run',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const created = ops.createTask({
      capabilityId: 'deploy.run',
      payload: {},
      idempotencyKey: 'ghost-route',
      requestedBy: 'w1',
    });
    const taskId = created.ok ? created.data.task.id : '';

    const routed = ops.routeTask(taskId);
    expect(routed.ok).toBe(true);
    const nominations = routed.ok ? routed.data.nominations : [];
    const ghost = nominations.find((n) => n.workerId === 'ghost-worker')!;
    expect(ghost.eligible).toBe(false);
    expect(ghost.assignability.assignable).toBe(false);
    const legitimate = nominations.find((n) => n.workerId === 'w1')!;
    expect(legitimate.eligible).toBe(true);
  });

  it('never picks up approval authority by being a Registry member', () => {
    // Recognised as a worker identity (never mistaken for a human), and worker
    // identity carries no approval authority.
    const ops = makeOps();
    expect(ops.workers.isRegistered('ghost-worker')).toBe(true);
    registerSpecialist('w1', ['deploy.run']);
    const created = ops.createTask({
      capabilityId: 'deploy.run',
      payload: {},
      idempotencyKey: 'ghost-approve',
      requestedBy: 'w1',
    });
    const taskId = created.ok ? created.data.task.id : '';
    const approved = ops.approveTask({
      taskId,
      founderId: 'ghost-worker',
      expectedActionDigest: 'anything',
    });
    expect(approved.ok).toBe(false);
    expect(errorCode(approved)).toBe('not_permitted');
  });

  it('is refused whether or not the Registry is supplied — enabling it grants nothing', () => {
    // The regression test for the widening itself: for an id the base does not
    // know, turning `memberRegistry` on must not turn any refusal into a yes.
    registerSpecialist('w1', ['deploy.run']);
    const withRegistry = makeOps(true);
    const without = makeOps(false);
    let n = 0;
    for (const ops of [withRegistry, without]) {
      expect([...ops.workers.allowedCapabilities('ghost-worker')]).toEqual([]);
      expect(ops.workers.assignability('ghost-worker').assignable).toBe(false);
      expect(
        ops.createTask({
          capabilityId: 'deploy.run',
          payload: {},
          idempotencyKey: `parity-${n++}`,
          requestedBy: 'ghost-worker',
        }).ok,
      ).toBe(false);
      expect(errorCode(ops.claimNext('ghost-worker', 'deploy.run'))).toBe('worker_not_assignable');
    }

    // The ONE difference, and it is a narrowing one: with the Registry the id
    // is recognised as a worker identity, so it is refused as an unassignable
    // worker rather than falling through to the human-principal path. Both
    // refuse; the Registry-aware refusal never reaches human authority.
    expect(
      errorCode(
        withRegistry.createTask({
          capabilityId: 'deploy.run',
          payload: {},
          idempotencyKey: 'parity-code-on',
          requestedBy: 'ghost-worker',
        }),
      ),
    ).toBe('worker_not_assignable');
    expect(
      errorCode(
        without.createTask({
          capabilityId: 'deploy.run',
          payload: {},
          idempotencyKey: 'parity-code-off',
          requestedBy: 'ghost-worker',
        }),
      ),
    ).toBe('unknown_principal');
  });
});

// ===========================================================================
// 2. Both-known: intersection, and either refusal wins
// ===========================================================================
describe('a worker both directories know is narrowed by both', () => {
  it('capabilities are the intersection, in both directions', () => {
    registerSpecialist('w1', ['docs.write', 'deploy.run']);
    registerMember('w1', ['deploy.run']);
    expect([...composite().allowedCapabilities('w1')]).toEqual(['deploy.run']);

    registerSpecialist('w2', ['docs.write']);
    registerMember('w2', ['docs.write', 'deploy.run']);
    expect([...composite().allowedCapabilities('w2')]).toEqual(['docs.write']);
  });

  it('a Registry revocation removes the capability end to end', () => {
    registerSpecialist('w1', ['deploy.run']);
    registerMember('w1', ['deploy.run']);
    const ops = makeOps();
    expect(
      ops.createTask({
        capabilityId: 'deploy.run',
        payload: {},
        idempotencyKey: 'revoke-1',
        requestedBy: 'w1',
      }).ok,
    ).toBe(true);

    registry.update('w1', { grantedCapabilities: [] }, 'founder');
    expect([...ops.workers.allowedCapabilities('w1')]).toEqual([]);
    expect(errorCode(ops.claimNext('w1', 'deploy.run'))).toBe('not_permitted');
  });

  it('a capability disabled registry-wide stops authorising immediately', () => {
    registerSpecialist('w1', ['deploy.run']);
    registerMember('w1', ['deploy.run']);
    const ops = makeOps();
    new MemberCapabilityRegistry(db).setEnabled('deploy.run', false);
    expect([...ops.workers.allowedCapabilities('w1')]).toEqual([]);
    expect(errorCode(ops.claimNext('w1', 'deploy.run'))).toBe('not_permitted');
  });

  it('a Registry-disabled member is refused with worker_inactive', () => {
    registerSpecialist('w1', ['deploy.run']);
    registerMember('w1', ['deploy.run']);
    registry.disable('w1', 'under review', 'founder');
    const verdict = composite().assignability('w1');
    expect(verdict).toMatchObject({ assignable: false, reason: 'worker_inactive' });
    expect(errorCode(makeOps().claimNext('w1', 'deploy.run'))).toBe('worker_not_assignable');
  });

  it('a REPLACED member is refused and names its successor', () => {
    registerSpecialist('w1', ['deploy.run']);
    registerMember('w1', ['deploy.run']);
    registry.replace('w1', memberSpec('w1-next', ['deploy.run']), 'founder');
    const verdict = composite().assignability('w1');
    expect(verdict).toMatchObject({ assignable: false, reason: 'worker_replaced' });

    // ...and the successor does NOT inherit execution rights: it is a
    // Registry-only member until someone registers it for execution.
    expect(composite().assignability('w1-next').assignable).toBe(false);
    expect([...composite().allowedCapabilities('w1-next')]).toEqual([]);
  });

  it('a removed member is refused', () => {
    registerSpecialist('w1', ['deploy.run']);
    registerMember('w1', ['deploy.run']);
    registry.remove('w1', 'retired', 'founder');
    expect(composite().assignability('w1').assignable).toBe(false);
  });

  it('an inactive BASE worker is refused even though the Registry is happy', () => {
    registerSpecialist('w1', ['deploy.run'], false);
    registerMember('w1', ['deploy.run']);
    expect(composite().assignability('w1')).toMatchObject({
      assignable: false,
      reason: 'worker_inactive',
    });
  });

  it('a pending handover in the Registry blocks new work', () => {
    // Driven through a structural stub: `handover_pending` is lane D state and
    // this seam only has to honour it, not produce it.
    const registryPort = new RegistryWorkerDirectory({
      get: () =>
        ({
          id: 'w1',
          status: 'active',
          enabled: true,
          effectiveCapabilities: ['deploy.run'],
          replacedById: null,
        }) as never,
      listAssignments: () => [{ id: 'a1', status: 'handover_pending' } as never],
    } satisfies MemberDirectorySource);
    registerSpecialist('w1', ['deploy.run']);
    const dir = new NarrowingWorkerDirectory(new SpecialistDirectoryAdapter(store), registryPort);
    expect(dir.assignability('w1')).toMatchObject({
      assignable: false,
      reason: 'handover_pending',
    });
  });
});

// ===========================================================================
// 3. Base-only compatibility is preserved
// ===========================================================================
describe('a worker the Registry does not know keeps working exactly as before', () => {
  it('keeps its capabilities, assignability and the whole task path', () => {
    registerSpecialist('legacy', ['deploy.run']);
    registerMember('someone-else', ['deploy.run']); // registry in use, but not for `legacy`
    const ops = makeOps();

    expect([...ops.workers.allowedCapabilities('legacy')]).toEqual(['deploy.run']);
    expect(ops.workers.assignability('legacy').assignable).toBe(true);

    const created = ops.createTask({
      capabilityId: 'deploy.run',
      payload: {},
      idempotencyKey: 'legacy-1',
      requestedBy: 'legacy',
    });
    expect(created.ok).toBe(true);
    const claimed = ops.claimNext('legacy', 'deploy.run');
    expect(claimed.ok).toBe(true);
    const task = claimed.ok ? claimed.data : null;
    expect(ops.startTask(task!.id, 'legacy', task!.fence!).ok).toBe(true);
  });

  it('an inactive base-only worker is still refused', () => {
    registerSpecialist('retired', ['deploy.run'], false);
    expect(composite().assignability('retired')).toMatchObject({
      assignable: false,
      reason: 'worker_inactive',
    });
  });
});

// ===========================================================================
// 4. The invariant, stated directly over a matrix of worlds
// ===========================================================================
describe('composition is a filter over the base directory, never a second source', () => {
  it('capabilities are always a subset of the base, and assignability implies the base agrees', () => {
    registerSpecialist('both-active', ['docs.write', 'deploy.run']);
    registerMember('both-active', ['deploy.run']);
    registerSpecialist('both-inactive', ['docs.write'], false);
    registerMember('both-inactive', ['docs.write']);
    registerSpecialist('base-only', ['docs.write']);
    registerSpecialist('base-only-inactive', ['docs.write'], false);
    registerMember('registry-only', ['docs.write', 'deploy.run']);
    registerMember('registry-only-disabled', ['docs.write']);
    registry.disable('registry-only-disabled', 'paused', 'founder');

    const base = new SpecialistDirectoryAdapter(store);
    const dir = composite();
    const ids = [
      'both-active',
      'both-inactive',
      'base-only',
      'base-only-inactive',
      'registry-only',
      'registry-only-disabled',
      'nobody',
    ];

    for (const id of ids) {
      const baseCaps = new Set(base.allowedCapabilities(id));
      for (const cap of dir.allowedCapabilities(id)) {
        // Every composed capability came from the base directory.
        expect({ id, cap, grantedByBase: baseCaps.has(cap) }).toEqual({ id, cap, grantedByBase: true });
      }
      if (dir.assignability(id).assignable) {
        // Nobody the base refuses is assignable through the composite.
        expect({ id, assignableInBase: base.assignability(id).assignable }).toEqual({
          id,
          assignableInBase: true,
        });
      }
    }
  });
});
