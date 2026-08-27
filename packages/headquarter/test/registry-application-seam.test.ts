import { beforeEach, describe, expect, it } from 'vitest';

import {
  HeadquarterOperations,
  NarrowingWorkerDirectory,
  RegistryWorkerDirectory,
  SpecialistDirectoryAdapter,
  narrowByRegistry,
  type MemberDirectorySource,
  type WorkerDirectoryPort,
} from '../src/application/index.js';
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
      advertisedCapabilities: ['coding', 'reasoning'],
      contextWindowTokens: 200000,
      defaultCostClass: 'medium',
      locality: 'cloud',
    },
  ],
};

/**
 * Cross-lane tests for the Registry ↔ Application capability seam (#174 C).
 *
 * PR #172 landed lane C and lane F side by side but left the application
 * reading `hq_specialists.allowed_capabilities` instead of the Registry's
 * granted/effective truth. These tests pin the joined behaviour, and in
 * particular the direction of authority: the Registry may only NARROW.
 */

let db: HqDatabase;
let store: HeadquarterStore;
let registry: AiMemberRegistry;

const CAPS = ['docs.write', 'code.review', 'deploy.run'];

beforeEach(() => {
  db = openMemoryHqDatabase();
  store = new HeadquarterStore(db);
  const capabilities = new MemberCapabilityRegistry(db);
  const providers = new ProviderDirectory();
  providers.register(createMockAdapter(ANTHROPIC));
  registry = new AiMemberRegistry(db, providers, capabilities);
  for (const id of CAPS) {
    capabilities.register({
      id,
      domain: 'coding',
      riskClass: 'read_only',
      description: id,
    });
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

// ===========================================================================
// The core rule: effective capabilities, never advertised
// ===========================================================================
describe('the seam reads granted/effective capabilities, never advertised ones', () => {
  it('a member advertising everything but granted little holds only what was granted', () => {
    registerMember('m1', ['docs.write']);
    const dir = new RegistryWorkerDirectory(registry);
    expect(dir.allowedCapabilities('m1')).toEqual(['docs.write']);
    // it advertised all three
    expect(registry.get('m1')!.advertisedCapabilities).toHaveLength(3);
  });

  it('an unknown worker holds nothing and is not assignable', () => {
    const dir = new RegistryWorkerDirectory(registry);
    expect(dir.allowedCapabilities('nobody')).toEqual([]);
    expect(dir.isRegistered('nobody')).toBe(false);
    expect(dir.assignability('nobody')).toEqual({ assignable: false, reason: 'worker_unknown' });
  });

  it('REVOCATION takes effect immediately, with nothing cached', () => {
    registerMember('m1', ['docs.write', 'code.review']);
    const dir = new RegistryWorkerDirectory(registry);
    expect(dir.allowedCapabilities('m1')).toContain('code.review');

    registry.update('m1', { grantedCapabilities: ['docs.write'] }, 'founder');
    expect(dir.allowedCapabilities('m1')).toEqual(['docs.write']);
    expect(dir.allowedCapabilities('m1')).not.toContain('code.review');
  });

  it('a capability DISABLED registry-wide stops authorising, though still granted', () => {
    registerMember('m1', ['docs.write', 'code.review']);
    const dir = new RegistryWorkerDirectory(registry);
    const caps = new MemberCapabilityRegistry(db);
    caps.setEnabled('code.review', false);

    expect(registry.get('m1')!.grantedCapabilities).toContain('code.review');
    expect(dir.allowedCapabilities('m1')).not.toContain('code.review');
  });
});

// ===========================================================================
// Lifecycle: suspension, disablement, replacement, handover
// ===========================================================================
describe('a worker that must not take new work is refused, with the reason', () => {
  it('a disabled member is not assignable', () => {
    registerMember('m1', ['docs.write']);
    registry.disable('m1', 'under review', 'founder');
    const v = new RegistryWorkerDirectory(registry).assignability('m1');
    expect(v.assignable).toBe(false);
    expect(v).toMatchObject({ reason: 'worker_inactive' });
  });

  it('a replaced member reports worker_replaced and names its successor', () => {
    registerMember('m1', ['docs.write']);
    registry.replace('m1', memberSpec('m2', ['docs.write']), 'founder');
    const v = new RegistryWorkerDirectory(registry).assignability('m1');
    expect(v.assignable).toBe(false);
    expect(v).toMatchObject({ reason: 'worker_replaced' });
  });

  it('a removed member is not assignable', () => {
    registerMember('m1', ['docs.write']);
    registry.remove('m1', 'retired', 'founder');
    expect(new RegistryWorkerDirectory(registry).assignability('m1').assignable).toBe(false);
  });

  it('role suspension does not silently leave stale capabilities behind', () => {
    // Role eligibility is derived; revoking the capability must remove BOTH the
    // role and the capability, never leave the capability usable on its own.
    registry.defineRole('reviewer', ['code.review'], 'reviews code');
    registerMember('m1', ['code.review'], { roleEligibility: ['reviewer'] });
    expect(registry.get('m1')!.roleEligibility).toContain('reviewer');

    registry.update('m1', { grantedCapabilities: [] }, 'founder');
    const after = registry.get('m1')!;
    expect(after.roleEligibility).not.toContain('reviewer');
    expect(after.suspendedRoles.map((r) => r.roleId)).toContain('reviewer');
    expect(new RegistryWorkerDirectory(registry).allowedCapabilities('m1')).toEqual([]);
  });
});

// ===========================================================================
// The composite: the Registry may only NARROW
// ===========================================================================
describe('composition can only narrow, never widen', () => {
  function composite(): WorkerDirectoryPort {
    return new NarrowingWorkerDirectory(
      new SpecialistDirectoryAdapter(store),
      new RegistryWorkerDirectory(registry),
    );
  }

  it('a worker in BOTH directories gets the intersection', () => {
    registerSpecialist('w1', ['docs.write', 'deploy.run']);
    registerMember('w1', ['docs.write', 'code.review']);
    expect([...composite().allowedCapabilities('w1')]).toEqual(['docs.write']);
  });

  it('the Registry cannot GRANT what the operator directory withheld', () => {
    registerSpecialist('w1', ['docs.write']);
    registerMember('w1', ['docs.write', 'deploy.run']);
    expect(composite().allowedCapabilities('w1')).not.toContain('deploy.run');
  });

  it('the operator directory cannot grant what the Registry revoked', () => {
    registerSpecialist('w1', ['docs.write', 'deploy.run']);
    registerMember('w1', ['deploy.run']);
    registry.update('w1', { grantedCapabilities: [] }, 'founder');
    expect(composite().allowedCapabilities('w1')).toEqual([]);
  });

  it('a worker known only to the operator directory is unaffected', () => {
    registerSpecialist('legacy', ['docs.write']);
    expect([...composite().allowedCapabilities('legacy')]).toEqual(['docs.write']);
    expect(composite().assignability('legacy').assignable).toBe(true);
  });

  it('a worker known ONLY to the Registry holds nothing and cannot be assigned', () => {
    // #182: the Registry may narrow and nominate, never enrol. Before it was
    // supplied this id was `worker_unknown`; supplying it must not change that.
    registerMember('m1', ['docs.write']);
    expect([...composite().allowedCapabilities('m1')]).toEqual([]);
    const verdict = composite().assignability('m1');
    expect(verdict.assignable).toBe(false);
    expect(verdict).toMatchObject({ reason: 'worker_unknown', details: { knownTo: 'registry_only' } });
    // Identity is still recognised, so the id can never be taken for a human.
    expect(composite().isRegistered('m1')).toBe(true);
  });

  it('either directory refusing assignability is enough to refuse', () => {
    registerSpecialist('w1', ['docs.write'], false); // inactive specialist
    registerMember('w1', ['docs.write']); // fine in the registry
    expect(composite().assignability('w1').assignable).toBe(false);

    registerSpecialist('w2', ['docs.write'], true);
    registerMember('w2', ['docs.write']);
    registry.disable('w2', 'paused', 'founder');
    expect(composite().assignability('w2').assignable).toBe(false);
  });

  it('a worker in neither directory is unknown', () => {
    expect(composite().assignability('ghost')).toEqual({ assignable: false, reason: 'worker_unknown' });
  });
});

// ===========================================================================
// Wiring into HeadquarterOperations
// ===========================================================================
describe('HeadquarterOperations wiring', () => {
  it('without a registry, behaviour is exactly the previous default', () => {
    const ops = new HeadquarterOperations(db);
    registerSpecialist('w1', ['docs.write']);
    expect([...ops.workers.allowedCapabilities('w1')]).toEqual(['docs.write']);
  });

  it('with a registry, application reads cannot diverge from it', () => {
    registerSpecialist('w1', ['docs.write', 'deploy.run']);
    registerMember('w1', ['docs.write']);
    const ops = new HeadquarterOperations(db, { memberRegistry: registry });
    // deploy.run exists ONLY in the stale specialist row; the Registry is the
    // provider-neutral truth and it never granted it.
    expect(ops.workers.allowedCapabilities('w1')).not.toContain('deploy.run');
    expect([...ops.workers.allowedCapabilities('w1')]).toEqual(['docs.write']);
  });

  it('a CLAIM using stale specialist capabilities is refused end to end', () => {
    // The whole point of the seam, exercised through the real task path rather
    // than by reading the port: the specialist row still says this worker may
    // deploy, the Registry never granted it, so the work must not be claimable.
    registerSpecialist('w1', ['docs.write', 'deploy.run']);
    registerMember('w1', ['docs.write']);
    const ops = new HeadquarterOperations(db, { memberRegistry: registry });
    ops.queue.capabilities.register({
      id: 'deploy.run',
      description: 'Run a deployment',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });

    const created = ops.createTask({
      capabilityId: 'deploy.run',
      payload: {},
      idempotencyKey: 'seam-1',
      requestedBy: 'w1',
    });
    // Refused at creation: the requester no longer holds the capability.
    expect(created.ok).toBe(false);

    const claim = ops.claimNext('w1', 'deploy.run');
    expect(claim.ok).toBe(false);
  });

  it('a worker still holding the capability in BOTH is unaffected', () => {
    registerSpecialist('w2', ['docs.write']);
    registerMember('w2', ['docs.write']);
    const ops = new HeadquarterOperations(db, { memberRegistry: registry });
    ops.queue.capabilities.register({
      id: 'docs.write',
      description: 'Write docs',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const created = ops.createTask({
      capabilityId: 'docs.write',
      payload: {},
      idempotencyKey: 'seam-2',
      requestedBy: 'w2',
    });
    expect(created.ok).toBe(true);
  });

  it('an explicit workers port still overrides everything', () => {
    const fake: WorkerDirectoryPort = {
      isRegistered: () => true,
      allowedCapabilities: () => ['only.this'],
      assignability: () => ({ assignable: true }),
    };
    const ops = new HeadquarterOperations(db, { workers: fake, memberRegistry: registry });
    expect([...ops.workers.allowedCapabilities('anyone')]).toEqual(['only.this']);
  });

  it('narrowByRegistry returns the base untouched when no registry is supplied', () => {
    const base = new SpecialistDirectoryAdapter(store);
    expect(narrowByRegistry(base, null)).toBe(base);
    expect(narrowByRegistry(base, undefined)).toBe(base);
  });

  it('AiMemberRegistry satisfies the structural seam without adaptation', () => {
    const source: MemberDirectorySource = registry;
    registerMember('m1', ['docs.write']);
    expect(source.get('m1')?.id).toBe('m1');
    expect(source.listAssignments('m1')).toEqual([]);
  });
});
