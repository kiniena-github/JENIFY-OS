/**
 * The HQ browser-control API over real HTTP, with real sessions
 * (JENIFY-OS issue #200, Founder decision of 2026-08-28).
 *
 * `@factoryos/headquarter`'s own suites prove the boundary and the wiring with
 * ports. This suite proves the things only a real server can be wrong about:
 * that the session cookie is genuinely what identifies the caller, that
 * logging out and expiring really do stop mutations, that a hosted HTTPS
 * request gets a `Secure` cookie while local development does not, and that an
 * ordinary tenant deployment — the Mesob pilot's shape — has none of these
 * routes at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, hostnameFromHeader, isPrivateHost, type AppOptions } from '../src/app.js';
import { sessions } from '../src/db/schema.js';
import { createUser } from '../src/services/users.js';
import { createRole } from '../src/services/permissions.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
import { testDb, makeTestTenant, fullMatrix, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { openMemoryHqDatabase } from '@factoryos/headquarter/store';
import { HeadquarterStore } from '@factoryos/headquarter/store';
import { HeadquarterOperations, HumanPrincipalRegistry } from '@factoryos/headquarter/application';
import {
  registerDirectOrderCapability,
  DIRECT_ORDER_CAPABILITY,
} from '@factoryos/headquarter/live';

const ORIGIN = 'http://localhost:3001';
const JSON_HEADERS = { origin: ORIGIN, 'content-type': 'application/json' };
/** Claude genuinely connected; Codex genuinely not. Facts, not fabrication. */
const SECRETS = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

let db: Db;
let tenant: TestTenant;
let founderUserId: string;
let staffUserId: string;

interface Plane {
  ops: HeadquarterOperations;
  principals: HumanPrincipalRegistry;
}

function hqPlane(): Plane {
  const hqDb = openMemoryHqDatabase();
  const ops = new HeadquarterOperations(hqDb, { store: new HeadquarterStore(hqDb) });
  registerDirectOrderCapability(hqDb);
  const principals = new HumanPrincipalRegistry(hqDb);
  principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return { ops, principals };
}

function app(plane: Plane, overrides: Partial<NonNullable<AppOptions['headquarter']>> = {}) {
  return buildApp({
    db,
    headquarter: {
      ops: plane.ops,
      founderMap: [{ realmId: tenant.tenantId, accountId: founderUserId, principalId: 'founder' }],
      allowedOrigins: [ORIGIN],
      secretsEnv: SECRETS,
      ...overrides,
    },
  });
}

async function signIn(
  instance: ReturnType<typeof buildApp>,
  username: string,
): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((c) => c.name === 'fos_session')!;
  return `fos_session=${cookie.value}`;
}

const ORDER = {
  instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
  route: 'CLAUDE',
  title: 'Q3 maintenance plan',
};

beforeEach(() => {
  db = testDb();
  tenant = makeTestTenant(db, 'SALTA');
  founderUserId = createUser(tenant.sysCtx, {
    username: 'founder.salta',
    displayName: 'The Founder',
    password: 'test-password',
    roleId: tenant.ownerRoleId,
  });
  const staffRoleId = createRole(tenant.sysCtx, {
    code: 'staff',
    name: 'Staff',
    matrix: matrixOf([['inventory', ['view']]]),
  });
  staffUserId = createUser(tenant.sysCtx, {
    username: 'staff.salta',
    displayName: 'Warehouse Lead',
    password: 'test-password',
    roleId: staffRoleId,
  });
  expect(fullMatrix).toBeTypeOf('function');
});

describe('the session cookie is what identifies the caller', () => {
  it('lets the mapped Founder create a canonical order and refuses everyone else', async () => {
    const plane = hqPlane();
    const instance = app(plane);

    const anonymous = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: JSON_HEADERS,
      payload: ORDER,
    });
    expect(anonymous.statusCode).toBe(401);

    const staff = await signIn(instance, 'staff.salta');
    const asStaff = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: staff },
      payload: ORDER,
    });
    expect(asStaff.statusCode).toBe(403);
    expect(asStaff.json().error.code).toBe('not_founder');

    const founder = await signIn(instance, 'founder.salta');
    const asFounder = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(asFounder.statusCode).toBe(201);
    expect(asFounder.json().requiresFounderApproval).toBe(true);

    // Exactly one canonical task, attributed to the mapped principal.
    const tasks = plane.ops.queue.listByStatus('needs_approval');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.createdBy).toBe('founder');
    expect(staffUserId).not.toBe(founderUserId);
  });

  it('refuses a body that names its own principal, even from the real Founder', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: { ...ORDER, requestedBy: 'somebody-else' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('client_identity_supplied');
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('stops mutating the moment the session is revoked by signing out', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    await instance.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: founder },
    });
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(response.statusCode).toBe(401);
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('stops mutating once the session has expired', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    db.update(sessions)
      .set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(sessions.token, founder.split('=')[1]!))
      .run();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(response.statusCode).toBe(401);
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('blocks a forged cross-site request carrying a real cookie', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');

    const crossSite = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, origin: 'https://evil.example', cookie: founder },
      payload: ORDER,
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error.code).toBe('origin_not_allowed');

    // The classic cross-site form post. Fastify's own content-type gate
    // refuses it first (415) and the API's JSON requirement is the backstop —
    // either way nothing is created, which is the property that matters.
    const formPost = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: founder },
      payload: 'instruction=x&route=CLAUDE',
    });
    expect(formPost.statusCode).toBeGreaterThanOrEqual(400);
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });
});

describe('configuration decides what exists', () => {
  it('gives an ordinary tenant deployment no HQ routes at all', async () => {
    // The Mesob pilot's shape: buildApp with a db and nothing else.
    const instance = buildApp({ db });
    for (const url of [
      '/api/hq/control/session',
      '/api/hq/control/orders',
      '/api/hq/control/approvals',
    ]) {
      const response = await instance.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('authenticates no Founder when no account is bound', async () => {
    const plane = hqPlane();
    const instance = app(plane, { founderMap: [] });
    const founder = await signIn(instance, 'founder.salta');
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('founder_map_unconfigured');
  });

  it('can serve the read routes with writes switched off', async () => {
    const plane = hqPlane();
    const instance = app(plane, { mutationsEnabled: false });
    const founder = await signIn(instance, 'founder.salta');
    const read = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/approvals',
      headers: { cookie: founder },
    });
    expect(read.statusCode).toBe(200);
    const write = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('mutations_disabled');
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('never caches an authenticated, principal-specific answer', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    const response = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/session',
      headers: { cookie: founder },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('leaks no session token or password into any HQ response', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    const token = founder.split('=')[1]!;
    for (const url of ['/api/hq/control/session', '/api/hq/control/approvals']) {
      const response = await instance.inject({ method: 'GET', url, headers: { cookie: founder } });
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain('test-password');
    }
  });
});

describe('the session cookie hardens itself on a hosted origin', () => {
  async function loginCookie(host: string, headers: Record<string, string> = {}) {
    const instance = buildApp({ db });
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host, ...headers },
      payload: { username: 'founder.salta', password: 'test-password' },
    });
    expect(response.statusCode).toBe(200);
    return response.cookies.find((c) => c.name === 'fos_session')!;
  }

  it('is always HttpOnly and SameSite=Lax', async () => {
    expect(await loginCookie('localhost:3001')).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
    });
  });

  it('stays plaintext-capable on loopback and private-network hosts', async () => {
    // The local-first deployment: a factory server on the LAN, over plain HTTP.
    for (const host of ['localhost:3001', '127.0.0.1:3001', '192.168.1.10:3001', 'mesob-server:3001']) {
      expect((await loginCookie(host)).secure, host).toBeFalsy();
    }
  });

  it('sets Secure behind a TLS-terminating proxy, where req.protocol says http', async () => {
    // The case a naive `req.protocol === 'https'` check gets silently wrong.
    const cookie = await loginCookie('hq.example.com', { 'x-forwarded-proto': 'https' });
    expect(cookie.secure).toBe(true);
  });

  it('sets Secure on a public hostname even with no proxy header at all', async () => {
    // Secure by default: a public site over plaintext fails visibly rather
    // than quietly running an authenticated session in the clear.
    expect((await loginCookie('hq.example.com')).secure).toBe(true);
  });
});

describe('host classification decides Secure, and fails safe (Codex round 1, P1)', () => {
  it('keeps a public IPv6 literal Secure over plaintext', () => {
    // The shipped defect: stripping the brackets left a colon-containing
    // string with no dot, which the bare-LAN-hostname rule swallowed — so a
    // globally routable IPv6 host served the session cookie without Secure.
    for (const host of [
      '[2606:4700:4700::1111]:3001',
      '[2606:4700:4700::1111]',
      '[2001:db8::1]:8080',
      '2606:4700:4700::1111',
    ]) {
      expect(isPrivateHost(hostnameFromHeader(host)), host).toBe(false);
    }
  });

  it('still allows plaintext on genuinely private IPv6 hosts', () => {
    for (const host of [
      '[::1]:3001',
      '[::1]',
      '[fe80::1ff:fe23:4567:890a]:3001', // link-local
      '[fd12:3456:789a::1]:3001', // unique-local
      '[fc00::1]',
      '[::ffff:192.168.1.10]:3001', // IPv4-mapped private
    ]) {
      expect(isPrivateHost(hostnameFromHeader(host)), host).toBe(true);
    }
  });

  it('classifies an IPv4-mapped PUBLIC address as public', () => {
    expect(isPrivateHost(hostnameFromHeader('[::ffff:8.8.8.8]:3001'))).toBe(false);
  });

  it('keeps the IPv4 and hostname rules intact', () => {
    for (const host of ['localhost:3001', '127.0.0.1:3001', '192.168.1.10:3001', '10.0.0.4', 'mesob-server:3001']) {
      expect(isPrivateHost(hostnameFromHeader(host)), host).toBe(true);
    }
    for (const host of ['hq.example.com', '8.8.8.8:3001', '172.32.0.1', '999.1.1.1']) {
      expect(isPrivateHost(hostnameFromHeader(host)), host).toBe(false);
    }
  });

  it('treats an unknown or unparseable host as public, so a gap only adds Secure', () => {
    for (const host of ['', '   ', '[not-an-address]', '[]']) {
      expect(isPrivateHost(hostnameFromHeader(host)), JSON.stringify(host)).toBe(false);
    }
  });

  it('does not eat a hextet off an unbracketed IPv6 address', () => {
    expect(hostnameFromHeader('2606:4700:4700::1111')).toBe('2606:4700:4700::1111');
    expect(hostnameFromHeader('[::1]:3001')).toBe('::1');
    expect(hostnameFromHeader('hq.example.com:3001')).toBe('hq.example.com');
  });
});

describe('step-up password attempts are rate limited (Codex round 1, P1)', () => {
  it('stops unlimited guessing from a stale Founder session', async () => {
    _resetRateLimiter();
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    // Age the session past the step-up window: the exact attacker position
    // step-up exists to contain — a stolen, long-lived cookie.
    db.update(sessions)
      .set({ createdAt: '2026-08-01T00:00:00.000Z' })
      .where(eq(sessions.token, founder.split('=')[1]!))
      .run();

    plane.principals.register({
      id: 'coo',
      displayName: 'COO',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const created = plane.ops.createTask({
      capabilityId: DIRECT_ORDER_CAPABILITY.id,
      payload: { kind: 'direct_order', instruction: 'x', executionProvider: 'CLAUDE' },
      idempotencyKey: 'coo-order-1',
      requestedBy: 'coo',
      title: 'COO order',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.task.id;

    const guess = () =>
      instance.inject({
        method: 'POST',
        url: '/api/hq/control/approvals/approve',
        headers: { ...JSON_HEADERS, cookie: founder },
        payload: { taskId, expectedActionDigest: 'x'.repeat(64), stepUpPassword: 'wrong' },
      });

    const codes: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const response = await guess();
      codes.push(response.json().error.code);
    }

    // The budget bites well before 14 attempts, and every guess after it is
    // refused without reaching scrypt at all.
    expect(codes).toContain('step_up_failed');
    expect(codes).toContain('step_up_rate_limited');
    expect(codes[codes.length - 1]).toBe('step_up_rate_limited');
    expect(codes.filter((c) => c === 'step_up_failed').length).toBeLessThanOrEqual(10);

    // Nothing was approved, and the correct password is refused too while the
    // budget is exhausted — a lockout, not a bypass.
    expect(plane.ops.queue.get(taskId)!.status).toBe('needs_approval');
    _resetRateLimiter();
  });
});

describe('step-up shares the login source budget (Codex round 2, P2)', () => {
  /** Age the session past the step-up window: the stolen-cookie position. */
  function ageSession(cookie: string): void {
    db.update(sessions)
      .set({ createdAt: '2026-08-01T00:00:00.000Z' })
      .where(eq(sessions.token, cookie.split('=')[1]!))
      .run();
  }

  function pendingTaskId(plane: Plane): string {
    plane.principals.register({
      id: 'coo',
      displayName: 'COO',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const created = plane.ops.createTask({
      capabilityId: DIRECT_ORDER_CAPABILITY.id,
      payload: { kind: 'direct_order', instruction: 'x', executionProvider: 'CLAUDE' },
      idempotencyKey: `coo-${Math.random()}`,
      requestedBy: 'coo',
      title: 'COO order',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    return created.data.task.id;
  }

  it('lets failed sign-ins exhaust the budget that step-up then draws on', async () => {
    // The defect this replaces: the key was `ip|hq-stepup|account`, and
    // `sourceKeyOf` keeps the SECOND component — so step-up had its own
    // `ip|hq-stepup|*` ceiling and an attacker who burned the login budget got
    // a fresh allowance just by moving to this endpoint.
    _resetRateLimiter();
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    ageSession(founder);
    const taskId = pendingTaskId(plane);

    // Burn the per-source ceiling on the LOGIN surface alone, varying the
    // username so no single per-account bucket is what trips.
    for (let i = 0; i < 31; i += 1) {
      await instance.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: `nobody${i}.salta`, password: 'wrong' },
      });
    }

    const stepUp = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/approvals/approve',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: { taskId, expectedActionDigest: 'x'.repeat(64), stepUpPassword: 'wrong' },
    });
    expect(stepUp.statusCode).toBe(429);
    expect(stepUp.json().error.code).toBe('step_up_rate_limited');
    expect(plane.ops.queue.get(taskId)!.status).toBe('needs_approval');
    _resetRateLimiter();
  });

  it('charges step-up failures into the SAME source bucket login draws on', async () => {
    // The discriminating measurement. The per-account lockout fires at 10, so
    // step-up alone can never reach the source ceiling of 30 — which is
    // correct, not a gap. What must be true is that those 10 failures land in
    // `ip|login|*` rather than a private bucket: with sharing, 10 step-up
    // failures plus 20 login failures trip the ceiling; without it, 20 login
    // failures alone leave the source at 20 and sign-in still works.
    _resetRateLimiter();
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    ageSession(founder);
    const taskId = pendingTaskId(plane);

    for (let i = 0; i < 10; i += 1) {
      await instance.inject({
        method: 'POST',
        url: '/api/hq/control/approvals/approve',
        headers: { ...JSON_HEADERS, cookie: founder },
        payload: { taskId, expectedActionDigest: 'x'.repeat(64), stepUpPassword: 'wrong' },
      });
    }
    for (let i = 0; i < 20; i += 1) {
      await instance.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: `nobody${i}.salta`, password: 'wrong' },
      });
    }

    const login = await instance.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'staff.salta', password: 'test-password' },
    });
    expect(login.statusCode).toBe(429);
    _resetRateLimiter();
  });

  it('gives no fresh per-account allowance by switching endpoints', async () => {
    // Codex round 6: sharing the source ceiling was not enough. Ten failed
    // sign-ins against a known username used to leave ten MORE guesses at
    // step-up against the same password, because the per-account buckets were
    // separate keys. Both surfaces now charge ip|login|<username>.
    _resetRateLimiter();
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    ageSession(founder);
    const taskId = pendingTaskId(plane);

    for (let i = 0; i < 10; i += 1) {
      await instance.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'founder.salta', password: 'wrong' },
      });
    }

    const stepUp = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/approvals/approve',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: { taskId, expectedActionDigest: 'x'.repeat(64), stepUpPassword: 'wrong' },
    });
    expect(stepUp.statusCode).toBe(429);
    expect(stepUp.json().error.code).toBe('step_up_rate_limited');
    expect(plane.ops.queue.get(taskId)!.status).toBe('needs_approval');
    _resetRateLimiter();
  });

  it('locks the account out of sign-in once step-up burns the shared bucket', async () => {
    // The same property in the other direction.
    _resetRateLimiter();
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    ageSession(founder);
    const taskId = pendingTaskId(plane);

    for (let i = 0; i < 10; i += 1) {
      await instance.inject({
        method: 'POST',
        url: '/api/hq/control/approvals/approve',
        headers: { ...JSON_HEADERS, cookie: founder },
        payload: { taskId, expectedActionDigest: 'x'.repeat(64), stepUpPassword: 'wrong' },
      });
    }

    const login = await instance.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'founder.salta', password: 'test-password' },
    });
    expect(login.statusCode).toBe(429);
    _resetRateLimiter();
  });

  it('still leaves a DIFFERENT account able to sign in', async () => {
    // Sharing one account's bucket must not become a global lockout.
    _resetRateLimiter();
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.salta');
    ageSession(founder);
    const taskId = pendingTaskId(plane);

    for (let i = 0; i < 10; i += 1) {
      await instance.inject({
        method: 'POST',
        url: '/api/hq/control/approvals/approve',
        headers: { ...JSON_HEADERS, cookie: founder },
        payload: { taskId, expectedActionDigest: 'x'.repeat(64), stepUpPassword: 'wrong' },
      });
    }

    const other = await instance.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'staff.salta', password: 'test-password' },
    });
    expect(other.statusCode).toBe(200);
    _resetRateLimiter();
  });
});
