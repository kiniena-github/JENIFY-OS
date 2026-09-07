/**
 * `@factoryos/hq-host` satisfies the host port contract (Phase 2, Stage 1).
 *
 * `packages/headquarter/test/host-port-contract.test.ts` states the six
 * obligations a host takes on, framework-free. This suite runs them through
 * Fastify, so the contract and its first standalone implementation cannot
 * drift — and it adds the two things only a real host can be asked: the
 * response headers, and the Founder gate on the static site.
 *
 * The identity seam is exercised in both positions. `NO_IDENTITY` must refuse
 * everything (the honest standalone posture before Founder Gate A), and a
 * wired identity must resolve a Founder exactly as the server's does. Nothing
 * here implements a login: HQ has none, and this package deliberately did not
 * grow one during the split.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import {
  HeadquarterOperations,
  HumanPrincipalRegistry,
  MEMORY_COMMAND_CAPABILITY,
  MISSION_COMMAND_CAPABILITY,
  MISSION_ORCHESTRATE_CAPABILITY,
  MemberRegistryNominationSource,
  PROJECT_COMMAND_CAPABILITY,
  WORKFORCE_ASSIGN_CAPABILITY,
  registerMemoryCommandCapability,
  registerMissionCommandCapability,
  registerMissionOrchestrateCapability,
  registerProjectCommandCapability,
  registerWorkforceAssignCapability,
  TRUTH_RECORD_CAPABILITY,
  TRUTH_VERIFY_CAPABILITY,
  registerTruthRecordCapability,
  registerTruthVerifyCapability,
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_CONTRIBUTE_CAPABILITY,
  registerCollaborationCommandCapability,
  registerCollaborationContributeCapability,
  FOUNDER_BRIEF_CAPABILITY,
  registerFounderBriefCapability,
  type ExternalActionAdapter,
} from '@factoryos/headquarter/application';
import { CapabilityRegistry } from '@factoryos/headquarter/operator';
import {
  AiMemberRegistry,
  MemberCapabilityRegistry,
} from '@factoryos/headquarter/registry';
import {
  KNOWN_PROVIDERS,
  ProviderDirectory,
  declaredOnlyAdapter,
} from '@factoryos/headquarter/providers';
import {
  CONTROL_ROUTES,
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  type AuthenticatedAccount,
} from '@factoryos/headquarter/live';
import {
  registerHeadquarterRoutes,
  registerHeadquarterSite,
  NO_IDENTITY,
  type HeadquarterControlPlane,
  type HqIdentityPort,
} from '../src/index.js';

const ORIGIN = 'https://hq.example';

const FOUNDER: AuthenticatedAccount = {
  realmId: 'realm',
  accountId: 'acc-1',
  displayName: 'Proof Founder',
  authenticatedAt: new Date().toISOString(),
};

/** An identity source, as a host that HAS one would supply it. */
function identityFor(account: AuthenticatedAccount | null): HqIdentityPort {
  return { forRequest: () => ({ sessions: { resolve: () => account } }) };
}

let siteDir: string;

beforeAll(() => {
  siteDir = mkdtempSync(join(tmpdir(), 'hq-host-site-'));
  writeFileSync(join(siteDir, 'index.html'), '<title>HQ</title><p>canonical state</p>');
});

afterAll(() => {
  rmSync(siteDir, { recursive: true, force: true });
});

function plane(overrides: Partial<HeadquarterControlPlane> = {}): HeadquarterControlPlane {
  const db = openMemoryHqDatabase();
  registerDirectOrderCapability(db);
  registerMissionCommandCapability(db);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  new HumanPrincipalRegistry(db).register({
    id: 'founder',
    displayName: 'Proof Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id, MISSION_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return {
    ops,
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
    ...overrides,
  };
}

async function build(
  identity: HqIdentityPort,
  overrides: Partial<HeadquarterControlPlane> = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const control = plane(overrides);
  registerHeadquarterRoutes(app, control, identity);
  registerHeadquarterSite(app, control, identity, siteDir);
  await app.ready();
  return app;
}

describe('the standalone host boots with no tenant platform present', () => {
  it('serves the control API from a bare Fastify instance', async () => {
    // No @factoryos/server anywhere in this process — this is the Stage 1 claim.
    const app = await build(identityFor(FOUNDER));
    const res = await app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(res.statusCode).toBe(200);
    expect(res.json().founder).toBe(true);
    await app.close();
  });

  it('serves the Founder-gated site to a resolved Founder', async () => {
    const app = await build(identityFor(FOUNDER));
    const res = await app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('canonical state');
    await app.close();
  });
});

describe('NO_IDENTITY is honest, not broken', () => {
  it('refuses the control API because nobody is signed in', async () => {
    const app = await build(NO_IDENTITY);
    const res = await app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(res.statusCode).toBe(401);
    // The descriptive shape the contract pins: a probe, not a generic error.
    expect(res.json().authenticated).toBe(false);
    expect(res.json().reason).toBe('unauthenticated');
    await app.close();
  });

  it('refuses the site rather than serving canonical state to nobody', async () => {
    const app = await build(NO_IDENTITY);
    const res = await app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('canonical state');
    await app.close();
  });

  it('grows no sign-in of its own to compensate', async () => {
    // Guards against the tempting Stage-2-shaped shortcut: a "local trust" or
    // "dev bypass" route that makes the pages appear. There is exactly one way
    // in, and it is the injected identity.
    const app = await build(NO_IDENTITY);
    for (const url of ['/login', '/api/hq/login', '/api/auth/login', '/hq/login']) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode, `${url} must not exist`).toBe(404);
    }
    await app.close();
  });
});

describe('the Founder gate on the static site', () => {
  it('refuses a signed-in account that is not the mapped Founder', async () => {
    const app = await build(identityFor({ ...FOUNDER, accountId: 'someone-else' }));
    const res = await app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('canonical state');
    await app.close();
  });

  it('refuses when the Founder map is malformed, rather than failing open', async () => {
    const app = await build(identityFor(FOUNDER), { founderMap: '{not json' });
    const res = await app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(res.body).not.toContain('canonical state');
    await app.close();
  });
});

describe('headers a host owns', () => {
  it('never lets an authenticated answer be cached', async () => {
    const app = await build(identityFor(FOUNDER));
    const api = await app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(api.headers['cache-control']).toBe('no-store');
    const page = await app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(page.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('pins the referrer policy the origin check depends on', async () => {
    const app = await build(identityFor(FOUNDER));
    const page = await app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(page.headers['referrer-policy']).toBe('same-origin');
    await app.close();
  });
});

describe('the obligations, through Fastify this time', () => {
  it('asks the session port per request rather than once at startup', async () => {
    let calls = 0;
    const counting: HqIdentityPort = {
      forRequest: () => ({
        sessions: {
          resolve() {
            calls += 1;
            return FOUNDER;
          },
        },
      }),
    };
    const app = await build(counting);
    await app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    const afterFirst = calls;
    await app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(calls).toBeGreaterThan(afterFirst);
    await app.close();
  });

  it('reports controls off when mutations are disabled', async () => {
    const app = await build(identityFor(FOUNDER), { mutationsEnabled: false });
    const res = await app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(res.json().controls.directOrder).toBe(false);
    await app.close();
  });

  it('refuses a write from an origin the host did not allow-list', async () => {
    const app = await build(identityFor(FOUNDER), { allowedOrigins: [] });
    const res = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.orders,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { instruction: 'x' },
    });
    // Status AND cause, not just `ok:false` — an empty allow-list is its own
    // named refusal, checked before the origin comparison.
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('origin_allowlist_empty');
    await app.close();
  });

  it('never echoes a provider secret value', async () => {
    const secret = 'ghp-MUST-NEVER-APPEAR';
    const app = await build(identityFor(FOUNDER), {
      secretsEnv: { CLAUDE_ROUTINE_TOKEN: secret },
    });
    const res = await app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(res.body).not.toContain(secret);
    await app.close();
  });
});

describe('the Stage 4 hydration route reaches the browser through this host', () => {
  it('answers a resolved Founder with the seventeen rooms, uncached', async () => {
    // The route is served by the SAME wildcard registration as the rest of the
    // control API, which is the point of that design — but "the wildcard covers
    // it" is an assumption until something asks the real Fastify instance. And
    // `no-store` matters more here than anywhere: this body is canonical
    // company state, projected for one specific principal.
    const app = await build(identityFor(FOUNDER));
    const res = await app.inject({ method: 'GET', url: CONTROL_ROUTES.state });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { ok: boolean; rooms: { roomId: string }[] };
    expect(body.ok).toBe(true);
    expect(body.rooms).toHaveLength(17);
    await app.close();
  });

  it('refuses it to nobody, exactly as it refuses the rest', async () => {
    const app = await build(NO_IDENTITY);
    const res = await app.inject({ method: 'GET', url: CONTROL_ROUTES.state });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('Mission Room');
    await app.close();
  });

  it('serves the read even where this deployment mounts HQ read-only', async () => {
    const app = await build(identityFor(FOUNDER), { mutationsEnabled: false });
    const state = await app.inject({ method: 'GET', url: CONTROL_ROUTES.state });
    expect(state.statusCode).toBe(200);
    // ...while the write routes stay refused, which is what read-only means.
    const write = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.orders,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { instruction: 'x', route: 'CLAUDE', idempotencyKey: 'k' },
    });
    expect(write.statusCode).toBe(403);
    await app.close();
  });
});

describe('the Phase 3 mission surface travels through the same two wildcards', () => {
  it('commands a canonical mission through the real Fastify instance, uncached', async () => {
    // The adapter needed ZERO changes for these routes — that is the design
    // claim, and this is the ask that turns it from assumption into evidence.
    const app = await build(identityFor(FOUNDER));
    const res = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.missions,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {
        title: 'Improve QOS website speed',
        objective: 'Reduce load times without changing the visual design',
        constraints: ['No visual changes', 'No production deploy'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { ok: boolean; mission: { id: string; createdBy: string } };
    expect(body.ok).toBe(true);
    expect(body.mission.createdBy).toBe('founder');

    const read = await app.inject({ method: 'GET', url: CONTROL_ROUTES.missions });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { missions: unknown[] }).missions).toHaveLength(1);
    await app.close();
  });

  it('refuses a mission write from an origin the host did not allow-list', async () => {
    const app = await build(identityFor(FOUNDER), { allowedOrigins: [] });
    const res = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.missions,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { title: 'x', objective: 'y' },
    });
    // The exact status and the exact cause (empty allow-list is checked
    // before the origin comparison), plus proof that nothing was written:
    // the Founder-gated READ — which needs no origin — still shows zero.
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('origin_allowlist_empty');
    const read = await app.inject({ method: 'GET', url: CONTROL_ROUTES.missions });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { missions: unknown[] }).missions).toHaveLength(0);
    await app.close();
  });

  it('refuses the mission surface to nobody, exactly as it refuses the rest', async () => {
    const app = await build(NO_IDENTITY);
    const res = await app.inject({ method: 'GET', url: CONTROL_ROUTES.missions });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('the Phase 4 surfaces travel through the same two wildcards, wired as config.ts wires them', () => {
  // The EXACT composition loadHeadquarterHost performs (minus persistence):
  // AiMemberRegistry over declared-only provider adapters, an advisory
  // nomination source — and NO `memberRegistry`, because the narrowing seam
  // is the recorded authority migration (issue #182) and stays off.
  async function phase4App(): Promise<{
    app: FastifyInstance;
    ops: HeadquarterOperations;
  }> {
    const db = openMemoryHqDatabase();
    registerDirectOrderCapability(db);
    registerMissionCommandCapability(db);
    registerProjectCommandCapability(db);
    registerWorkforceAssignCapability(db);
    new CapabilityRegistry(db).register({
      id: 'repo.read_status',
      description: 'Read repo/CI status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const store = new HeadquarterStore(db);
    store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: ['repo.read_status'],
      active: true,
    });
    const providers = new ProviderDirectory();
    for (const descriptor of KNOWN_PROVIDERS) providers.register(declaredOnlyAdapter(descriptor));
    const aiMembers = new AiMemberRegistry(db, providers, new MemberCapabilityRegistry(db));
    const ops = new HeadquarterOperations(db, {
      store,
      aiMemberRegistry: aiMembers,
      nominationSources: [new MemberRegistryNominationSource(aiMembers)],
    });
    new HumanPrincipalRegistry(db).register({
      id: 'founder',
      displayName: 'Proof Founder',
      originateCapabilities: [
        DIRECT_ORDER_CAPABILITY.id,
        MISSION_COMMAND_CAPABILITY.id,
        PROJECT_COMMAND_CAPABILITY.id,
        WORKFORCE_ASSIGN_CAPABILITY.id,
        'repo.read_status',
      ],
      approvalAuthority: true,
      active: true,
    });
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      {
        ops,
        founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        mutationsEnabled: true,
      },
      identityFor(FOUNDER),
    );
    await app.ready();
    return { app, ops };
  }

  it('creates a project and reads the workforce through the real Fastify instance', async () => {
    const { app } = await phase4App();
    const created = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.projects,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { name: 'JENIFY OS', purpose: 'The platform program' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');

    const workforce = await app.inject({ method: 'GET', url: CONTROL_ROUTES.workforce });
    expect(workforce.statusCode).toBe(200);
    const body = workforce.json() as {
      workers: { id: string; providerDeclared: string | null }[];
      memberRegistryConfigured: boolean;
    };
    expect(body.workers.map((worker) => worker.id)).toEqual(['claude']);
    expect(body.workers[0]!.providerDeclared).toBeNull();
    expect(body.memberRegistryConfigured).toBe(true);
    await app.close();
  });

  it('ANTI-EMPTYING: a member row under a live worker id changes no grant and no claim', async () => {
    // The regression this pins: passing `memberRegistry` (the narrowing
    // seam) would intersect claude's operator grants with the member
    // registry's DISJOINT vocabulary and empty them — every claim would
    // then refuse. The host wiring must never flip that on as a side effect
    // of configuring the lifecycle registry.
    const { app, ops } = await phase4App();
    const registered = ops.registerAiMember({
      id: 'claude', // same id as the live execution worker, zero member grants
      displayName: 'Claude member record',
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      modelVersion: '1',
      workerType: 'execution',
      locality: 'cloud',
      privacyClass: 'internal',
      costClass: 'high',
      founderId: 'founder',
    });
    expect(registered.ok).toBe(true);

    const created = ops.createTask({
      capabilityId: 'repo.read_status',
      payload: { kind: 'status' },
      requestedBy: 'founder',
    });
    expect(created.ok).toBe(true);
    const claimed = ops.claimNext('claude', 'repo.read_status');
    expect(claimed.ok).toBe(true);

    // And the enrichment is visible where it should be — display, not authority.
    const workforce = await app.inject({ method: 'GET', url: CONTROL_ROUTES.workforce });
    const body = workforce.json() as {
      workers: { id: string; member: { identityKey: string } | null }[];
    };
    expect(body.workers[0]!.member!.identityKey).toBe('anthropic:claude-fable-5:1');
    await app.close();
  });
});

describe('the Phase 5/6 surfaces travel through the same two wildcards, Fastify-wired', () => {
  async function wave1App(): Promise<{ app: FastifyInstance; ops: HeadquarterOperations }> {
    const db = openMemoryHqDatabase();
    registerMissionCommandCapability(db);
    registerMemoryCommandCapability(db);
    registerMissionOrchestrateCapability(db);
    new CapabilityRegistry(db).register({
      id: 'repo.read_status',
      description: 'Read repo/CI status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const store = new HeadquarterStore(db);
    store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: ['repo.read_status'],
      active: true,
    });
    const ops = new HeadquarterOperations(db, { store });
    new HumanPrincipalRegistry(db).register({
      id: 'founder',
      displayName: 'Proof Founder',
      originateCapabilities: [
        MISSION_COMMAND_CAPABILITY.id,
        MEMORY_COMMAND_CAPABILITY.id,
        MISSION_ORCHESTRATE_CAPABILITY.id,
        'repo.read_status',
      ],
      approvalAuthority: true,
      active: true,
    });
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      {
        ops,
        founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        mutationsEnabled: true,
      },
      identityFor(FOUNDER),
    );
    await app.ready();
    return { app, ops };
  }

  it('records memory, previews and applies orchestration end to end — and never approves or claims', async () => {
    const { app, ops } = await wave1App();
    const commanded = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.missions,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {
        title: 'Faster QOS site',
        objective: 'Reduce page load times',
        plan: [{ summary: 'Measure', capabilityId: 'repo.read_status', payload: { intent: 'go' } }],
      },
    });
    expect(commanded.statusCode).toBe(201);
    const missionId = (commanded.json() as { mission: { id: string } }).mission.id;

    const recorded = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.memory,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {
        kind: 'founder_note',
        title: 'Landing page first',
        body: 'Profile the landing page before touching anything else.',
        project: 'QOS',
        missionId,
      },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.headers['cache-control']).toBe('no-store');

    // The QUERY reaches the boundary and is identity-scanned (the one
    // Phase 5 contract widening) — a ?principalId= attempt is refused.
    const injected = await app.inject({
      method: 'GET',
      url: `${CONTROL_ROUTES.memoryContext}?scope=mission&id=${missionId}&principalId=someone-else`,
    });
    expect(injected.statusCode).toBe(400);
    expect((injected.json() as { error: { code: string } }).error.code).toBe('client_identity_supplied');
    const context = await app.inject({
      method: 'GET',
      url: `${CONTROL_ROUTES.memoryContext}?scope=mission&id=${missionId}`,
    });
    expect(context.statusCode).toBe(200);

    const preview = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.missionOrchestrate,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { missionId, mode: 'preview' },
    });
    expect(preview.statusCode).toBe(200);
    const apply = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.missionOrchestrate,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {
        missionId,
        mode: 'apply',
        fingerprint: (preview.json() as { report: { fingerprint: string } }).report.fingerprint,
      },
    });
    expect(apply.statusCode).toBe(200);
    const decisions = (apply.json() as { report: { decisions: { decision: string }[] } }).report.decisions;
    expect(decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);

    // The anti-execution pin, at the Fastify-wired layer: orchestration
    // created and linked — nothing is approved, claimed or running.
    const task = ops.queue.listByStatus('queued')[0]!;
    expect(task.claimedBy).toBeNull();
    expect(ops.getMission(missionId)!.status).toBe('planned');
    await app.close();
  });

  it('refuses the whole Wave 1 surface to nobody, exactly as it refuses the rest', async () => {
    const app = await (async () => {
      const db = openMemoryHqDatabase();
      const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
      const instance = Fastify({ logger: false });
      registerHeadquarterRoutes(
        instance,
        {
          ops,
          founderMap: [],
          allowedOrigins: [ORIGIN],
          secretsEnv: {},
          mutationsEnabled: true,
        },
        NO_IDENTITY,
      );
      await instance.ready();
      return instance;
    })();
    for (const url of [CONTROL_ROUTES.memory, `${CONTROL_ROUTES.memorySearch}?text=x`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    const orchestrate = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.missionOrchestrate,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { missionId: 'any', mode: 'apply' },
    });
    expect(orchestrate.statusCode).toBe(401);
    await app.close();
  });
});

describe('Phase 7 — the truth routes through the Fastify host', () => {
  async function phase7App(): Promise<{ app: FastifyInstance; ops: HeadquarterOperations; taskId: string; evidenceId: string }> {
    const db = openMemoryHqDatabase();
    registerTruthRecordCapability(db);
    registerTruthVerifyCapability(db);
    new CapabilityRegistry(db).register({
      id: 'repo.read_status',
      description: 'Read repo/CI status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const store = new HeadquarterStore(db);
    store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: ['repo.read_status', TRUTH_RECORD_CAPABILITY.id],
      active: true,
    });
    const ops = new HeadquarterOperations(db, { store });
    new HumanPrincipalRegistry(db).register({
      id: 'founder',
      displayName: 'Proof Founder',
      originateCapabilities: [TRUTH_RECORD_CAPABILITY.id, TRUTH_VERIFY_CAPABILITY.id, 'repo.read_status'],
      approvalAuthority: true,
      active: true,
    });
    const created = ops.createTask({
      capabilityId: 'repo.read_status',
      payload: { check: 'ci' },
      idempotencyKey: 'host-truth-1',
      requestedBy: 'claude',
    });
    if (!created.ok) throw new Error(created.error.message);
    const evidenceId = ops.queue.evidence.list(created.data.task.id)[0]!.id;
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      {
        ops,
        founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        mutationsEnabled: true,
      },
      identityFor(FOUNDER),
    );
    await app.ready();
    return { app, ops, taskId: created.data.task.id, evidenceId };
  }

  it('records a claim and reads entity truth end to end; the query is identity-scanned; a claim never upgrades itself', async () => {
    const { app, ops, taskId, evidenceId } = await phase7App();
    const recorded = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.truth,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { entityKind: 'task', entityId: taskId, statement: 'CI is green.', evidenceRefs: [evidenceId] },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.headers['cache-control']).toBe('no-store');
    const record = (recorded.json() as { record: { id: string; state: string; recordedBy: string } }).record;
    expect(record.state).toBe('claimed');
    expect(record.recordedBy).toBe('founder');

    const injected = await app.inject({
      method: 'GET',
      url: `${CONTROL_ROUTES.truthEntity}?kind=task&id=${taskId}&principalId=someone-else`,
    });
    expect(injected.statusCode).toBe(400);
    expect((injected.json() as { error: { code: string } }).error.code).toBe('client_identity_supplied');
    const entity = await app.inject({ method: 'GET', url: `${CONTROL_ROUTES.truthEntity}?kind=task&id=${taskId}` });
    expect(entity.statusCode).toBe(200);
    expect((entity.json() as { truth: { currentState: string } }).truth.currentState).toBe('claimed');

    // The author cannot verify its own claim through the host either; the record stays claimed.
    const selfVerify = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.truthVerify,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { truthId: record.id, method: 'reviewed', verdict: 'confirmed', evidenceRefs: [evidenceId], limitations: 'none known' },
    });
    expect(selfVerify.statusCode).toBe(403);
    const accept = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.truthAccept,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { truthId: record.id, expectedDigest: 'anything' },
    });
    expect(accept.statusCode).toBe(409);
    expect((accept.json() as { error: { code: string } }).error.code).toBe('truth_not_verified');
    expect(ops.getTruthRecord(record.id)!.state).toBe('claimed');
    await app.close();
  });

  it('refuses the whole truth surface to nobody, exactly as it refuses the rest', async () => {
    const db = openMemoryHqDatabase();
    const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      { ops, founderMap: [], allowedOrigins: [ORIGIN], secretsEnv: {}, mutationsEnabled: true },
      NO_IDENTITY,
    );
    await app.ready();
    for (const url of [CONTROL_ROUTES.truth, `${CONTROL_ROUTES.truthEntity}?kind=task&id=x`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    for (const url of [CONTROL_ROUTES.truth, CONTROL_ROUTES.truthVerify, CONTROL_ROUTES.truthAccept]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { truthId: 'any', expectedDigest: 'x' },
      });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });
});

describe('Phase 8 — the action-ledger routes through the Fastify host', () => {
  /** A deterministic local adapter; nothing here reaches any real system. */
  const localAdapter: ExternalActionAdapter = {
    id: 'fake.local',
    provider: null,
    actions: {
      write_note: {
        description: 'Write an internal note.',
        visibility: 'internal',
        reversibility: 'reversible',
        compensation: { supported: true, method: 'delete_note', description: 'Deletes the note.' },
      },
    },
    execute: () => ({ ok: true, externalRef: { noteId: 'n-1' } }),
  };

  async function phase8App(): Promise<{ app: FastifyInstance; ops: HeadquarterOperations; taskId: string; fence: number }> {
    const db = openMemoryHqDatabase();
    new CapabilityRegistry(db).register({
      id: 'repo.read_status',
      description: 'Read repo/CI status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const store = new HeadquarterStore(db);
    store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: ['repo.read_status'],
      active: true,
    });
    const ops = new HeadquarterOperations(db, { store, actionAdapters: [localAdapter] });
    new HumanPrincipalRegistry(db).register({
      id: 'founder',
      displayName: 'Proof Founder',
      originateCapabilities: ['repo.read_status'],
      approvalAuthority: true,
      active: true,
    });
    const created = ops.createTask({
      capabilityId: 'repo.read_status',
      payload: { check: 'ci' },
      idempotencyKey: 'host-action-1',
      requestedBy: 'claude',
    });
    if (!created.ok) throw new Error(created.error.message);
    const claimed = ops.claimNext('claude', 'repo.read_status');
    if (!claimed.ok) throw new Error(claimed.error.message);
    const started = ops.startTask(claimed.data.id, 'claude', claimed.data.fence);
    if (!started.ok) throw new Error(started.error.message);
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      {
        ops,
        founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        mutationsEnabled: true,
      },
      identityFor(FOUNDER),
    );
    await app.ready();
    return { app, ops, taskId: created.data.task.id, fence: claimed.data.fence };
  }

  it('proposes through the host attributed to the mapped principal, reads the ledger, and offers no execute route; the worker step stays outside HTTP', async () => {
    const { app, ops, taskId, fence } = await phase8App();
    const proposed = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.actions,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { taskId, adapterId: 'fake.local', actionType: 'write_note', target: 'notes/board', payload: { text: 'hello' } },
    });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.headers['cache-control']).toBe('no-store');
    const action = (proposed.json() as { action: { id: string; state: string; requestedBy: string; riskLevel: string } }).action;
    expect(action).toMatchObject({ state: 'proposed', requestedBy: 'founder', riskLevel: 'low' });
    expect(JSON.stringify(proposed.json())).not.toContain('"payload"');

    const injected = await app.inject({ method: 'GET', url: `${CONTROL_ROUTES.actionDetail}?id=${action.id}&principalId=someone-else` });
    expect(injected.statusCode).toBe(400);
    expect((injected.json() as { error: { code: string } }).error.code).toBe('client_identity_supplied');

    // No HTTP route executes: the browser cannot authorize or execute.
    for (const url of [`${CONTROL_ROUTES.actions}/authorize`, `${CONTROL_ROUTES.actions}/execute`]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { actionId: action.id },
      });
      expect(res.statusCode, url).toBe(404);
    }
    expect(ops.getAction(action.id)!.state).toBe('proposed');

    // The worker acts through the facade, under its live fenced claim; the host then reads the truthful ledger.
    const authorized = ops.authorizeAction({ actionId: action.id, workerId: 'claude', fence });
    expect(authorized.ok).toBe(true);
    const executed = ops.executeAction({ actionId: action.id, workerId: 'claude', fence });
    expect(executed.ok && executed.data.outcome).toBe('succeeded');
    const detail = await app.inject({ method: 'GET', url: `${CONTROL_ROUTES.actionDetail}?id=${action.id}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { action: { state: string } }).action.state).toBe('succeeded');
    const list = await app.inject({ method: 'GET', url: `${CONTROL_ROUTES.actions}?taskId=${taskId}` });
    expect((list.json() as { total: number }).total).toBe(1);
    // Nothing to reconcile on a succeeded action: 409, and step-up is demanded first on a stale session elsewhere.
    const reconcile = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.actionReconcile,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { actionId: action.id, decision: 'confirmed_failed', note: 'checked' },
    });
    expect(reconcile.statusCode).toBe(409);
    await app.close();
  });

  it('refuses the whole action surface to nobody, exactly as it refuses the rest', async () => {
    const db = openMemoryHqDatabase();
    const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      { ops, founderMap: [], allowedOrigins: [ORIGIN], secretsEnv: {}, mutationsEnabled: true },
      NO_IDENTITY,
    );
    await app.ready();
    for (const url of [CONTROL_ROUTES.actions, `${CONTROL_ROUTES.actionDetail}?id=x`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    for (const url of [CONTROL_ROUTES.actions, CONTROL_ROUTES.actionReconcile]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { actionId: 'any', decision: 'confirmed_failed', note: 'n' },
      });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });
});

describe('Phase 9 — the collaboration routes through the Fastify host', () => {
  async function phase9App(): Promise<{ app: FastifyInstance; ops: HeadquarterOperations; missionId: string }> {
    const db = openMemoryHqDatabase();
    registerMissionCommandCapability(db);
    registerCollaborationCommandCapability(db);
    registerCollaborationContributeCapability(db);
    const store = new HeadquarterStore(db);
    store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [COLLABORATION_CONTRIBUTE_CAPABILITY.id],
      active: true,
    });
    const ops = new HeadquarterOperations(db, { store });
    new HumanPrincipalRegistry(db).register({
      id: 'founder',
      displayName: 'Proof Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, COLLABORATION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const mission = ops.commandMission({ title: 'Host mission', objective: 'Prove the wiring', requestedBy: 'founder' });
    if (!mission.ok) throw new Error(mission.error.message);
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      {
        ops,
        founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        mutationsEnabled: true,
      },
      identityFor(FOUNDER),
    );
    await app.ready();
    return { app, ops, missionId: mission.data.mission.id };
  }

  it('opens and admits through the host attributed to the mapped principal, refuses `role` as an identity key in body and query, reads the room, and offers no contribute route — the worker contribution stays outside HTTP', async () => {
    const { app, ops, missionId } = await phase9App();
    const opened = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.collaboration,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { missionId, title: 'Host room' },
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.headers['cache-control']).toBe('no-store');
    const session = (opened.json() as { session: { id: string; openedBy: string; standing: string } }).session;
    expect(session).toMatchObject({ openedBy: 'founder', standing: 'active' });

    const identityInBody = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.collaborationAdmit,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { sessionId: session.id, workerId: 'claude', role: 'builder' },
    });
    expect(identityInBody.statusCode).toBe(400);
    expect((identityInBody.json() as { error: { code: string } }).error.code).toBe('client_identity_supplied');
    const identityInQuery = await app.inject({
      method: 'GET',
      url: `${CONTROL_ROUTES.collaborationContext}?sessionId=${session.id}&role=builder`,
    });
    expect(identityInQuery.statusCode).toBe(400);

    const admitted = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.collaborationAdmit,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { sessionId: session.id, workerId: 'claude', collaborationRole: 'builder' },
    });
    expect(admitted.statusCode).toBe(201);
    expect((admitted.json() as { participant: { workerId: string; admittedBy: string } }).participant).toMatchObject({ workerId: 'claude', admittedBy: 'founder' });

    // No HTTP route contributes: the browser cannot record a contribution under any worker's name.
    const contribute = await app.inject({
      method: 'POST',
      url: `${CONTROL_ROUTES.collaboration}/contribute`,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { sessionId: session.id, kind: 'finding', content: 'from the browser' },
    });
    expect(contribute.statusCode).toBe(404);
    expect(ops.listContributions(session.id).total).toBe(0);

    // The worker acts through the facade under its own resolved identity; the host then reads the truthful room.
    const recorded = ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'Recorded by the worker.', requestedBy: 'claude' });
    expect(recorded.ok).toBe(true);
    const room = await app.inject({ method: 'GET', url: `${CONTROL_ROUTES.collaborationRoom}?missionId=${missionId}` });
    expect(room.statusCode).toBe(200);
    const view = (room.json() as { room: { participants: { workerId: string }[]; contributions: { total: number; items: { workerId: string; kind: string }[] } } }).room;
    expect(view.participants.map((p) => p.workerId)).toEqual(['claude']);
    expect(view.contributions.total).toBe(1);
    expect(view.contributions.items[0]).toMatchObject({ workerId: 'claude', kind: 'finding' });
    const context = await app.inject({
      method: 'GET',
      url: `${CONTROL_ROUTES.collaborationContext}?sessionId=${session.id}&collaborationRole=builder`,
    });
    expect(context.statusCode).toBe(200);
    expect((context.json() as { bundle: { role: string } }).bundle.role).toBe('builder');
    await app.close();
  });

  it('refuses the whole collaboration surface to nobody, exactly as it refuses the rest', async () => {
    const db = openMemoryHqDatabase();
    const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      { ops, founderMap: [], allowedOrigins: [ORIGIN], secretsEnv: {}, mutationsEnabled: true },
      NO_IDENTITY,
    );
    await app.ready();
    for (const url of [
      CONTROL_ROUTES.collaboration,
      `${CONTROL_ROUTES.collaborationRoom}?missionId=x`,
      `${CONTROL_ROUTES.collaborationContext}?sessionId=x&collaborationRole=builder`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    for (const url of [CONTROL_ROUTES.collaboration, CONTROL_ROUTES.collaborationAdmit]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { missionId: 'any', title: 't', sessionId: 'any', workerId: 'claude', collaborationRole: 'builder' },
      });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });
});

describe('Phase 10 — the command-centre routes through the Fastify host', () => {
  async function phase10App(options: { grantBrief?: boolean } = {}): Promise<{
    app: FastifyInstance;
    ops: HeadquarterOperations;
    missionId: string;
  }> {
    const db = openMemoryHqDatabase();
    registerMissionCommandCapability(db);
    registerFounderBriefCapability(db);
    const store = new HeadquarterStore(db);
    const ops = new HeadquarterOperations(db, { store });
    new HumanPrincipalRegistry(db).register({
      id: 'founder',
      displayName: 'Proof Founder',
      originateCapabilities: [
        MISSION_COMMAND_CAPABILITY.id,
        ...(options.grantBrief === false ? [] : [FOUNDER_BRIEF_CAPABILITY.id]),
      ],
      approvalAuthority: true,
      active: true,
    });
    const mission = ops.commandMission({
      title: 'Host mission',
      objective: 'Prove the wiring',
      planItems: ['Do the thing'],
      requestedBy: 'founder',
    });
    if (!mission.ok) throw new Error(mission.error.message);
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      {
        ops,
        founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        mutationsEnabled: true,
      },
      identityFor(FOUNDER),
    );
    await app.ready();
    return { app, ops, missionId: mission.data.mission.id };
  }

  it('reads the briefing and the inbox, issues one receipt attributed to the mapped principal, and deduplicates the repeat', async () => {
    const { app, ops, missionId } = await phase10App();
    const briefing = await app.inject({ method: 'GET', url: CONTROL_ROUTES.commandCenter });
    expect(briefing.statusCode).toBe(200);
    expect(briefing.headers['cache-control']).toBe('no-store');
    const body = briefing.json() as {
      briefing: { needsMe: { items: { source: { table: string; id: string } }[] }; recommendations: { items: { executable: boolean }[] } };
      briefStorePresent: boolean;
    };
    expect(body.briefStorePresent).toBe(true);
    // The commanded mission has an unspecified plan item, so the derived
    // inbox names that canonical row rather than an invented one.
    expect(body.briefing.needsMe.items.map((item) => item.source.id)).toContain(missionId);
    for (const recommendation of body.briefing.recommendations.items) expect(recommendation.executable).toBe(false);

    const inbox = await app.inject({ method: 'GET', url: CONTROL_ROUTES.commandCenterInbox });
    expect(inbox.statusCode).toBe(200);
    expect((inbox.json() as { inbox: { items: unknown[] } }).inbox.items).toHaveLength(body.briefing.needsMe.items.length);

    const issued = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.commandCenterBrief,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    expect((issued.json() as { brief: { issuedBy: string } }).brief.issuedBy).toBe('founder');
    const repeat = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.commandCenterBrief,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {},
    });
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { deduplicated: boolean }).deduplicated).toBe(true);
    expect(ops.listBriefs().total).toBe(1);

    // A body naming an actor is refused before the facade is reached.
    const forged = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.commandCenterBrief,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { requestedBy: 'mallory' },
    });
    expect(forged.statusCode).toBe(400);
    expect(ops.listBriefs().total).toBe(1);
    await app.close();
  });

  it('refuses the write to a Founder without the grant while the reads still answer', async () => {
    const { app, ops } = await phase10App({ grantBrief: false });
    const refused = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.commandCenterBrief,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    expect(ops.listBriefs().total).toBe(0);
    expect((await app.inject({ method: 'GET', url: CONTROL_ROUTES.commandCenter })).statusCode).toBe(200);
    await app.close();
  });

  it('refuses the whole command-centre surface to nobody, exactly as it refuses the rest', async () => {
    const db = openMemoryHqDatabase();
    const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
    const app = Fastify({ logger: false });
    registerHeadquarterRoutes(
      app,
      { ops, founderMap: [], allowedOrigins: [ORIGIN], secretsEnv: {}, mutationsEnabled: true },
      NO_IDENTITY,
    );
    await app.ready();
    for (const url of [CONTROL_ROUTES.commandCenter, CONTROL_ROUTES.commandCenterInbox]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    const write = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.commandCenterBrief,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: {},
    });
    expect(write.statusCode).toBe(401);
    await app.close();
  });
});
