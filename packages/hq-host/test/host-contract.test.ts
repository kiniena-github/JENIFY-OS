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
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '@factoryos/headquarter/application';
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
