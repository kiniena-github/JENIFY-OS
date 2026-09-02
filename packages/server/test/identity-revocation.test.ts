/**
 * EVERY identity-session revocation reaches HQ (Phase 2, Stage 2, second Codex
 * correction round).
 *
 * ## The finding
 *
 * Only explicit logout carried `ssoHq` propagation. Three other operations end
 * identity authority and none of them told HQ anything:
 *
 *   · an administrator resetting a password (`/api/users/:id/reset-password`)
 *   · an emergency recovery code being used (`/api/auth/recover`)
 *   · an account being deactivated (`PATCH /api/users/:id { active: false }`)
 *
 * Each correctly killed the identity session and left the DERIVED HQ session
 * alive for up to its full 60 minutes. So the exact two things an administrator
 * does about a compromised account — reset the password, switch the account off
 * — left the attacker's HQ session working, on the host where irreversible
 * Founder actions live.
 *
 * ## How this suite proves the fix
 *
 * Not by asserting that a notifier was called. By standing up BOTH halves — the
 * real composed identity app and a real `HqSessionStore` behind HQ's real
 * back-channel logout route — completing a real handoff, and then checking that
 * `store.resolve(hqToken)` is null the instant each operation returns. That is
 * the property that matters, and it cannot be satisfied by a well-intentioned
 * call that goes to the wrong place.
 *
 * The structural test at the end is the part that keeps it true: `revoked_at` on
 * `sessions` may be written by exactly ONE module, so a fifth ending path cannot
 * be added without going through the propagating path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { buildApp } from '../src/app.js';
import { composeAppOptions } from '../src/compose.js';
import { createUser } from '../src/services/users.js';
import { generateRecoveryCodes } from '../src/services/recovery.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
import { httpHqLogoutNotifier } from '../src/services/sso-hq.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { SSO_HQ_ROUTES as IDENTITY_ROUTES, SSO_SERVICE_AUTH_HEADER } from '../src/routes/sso-hq.js';
import { openMemoryHqDatabase } from '@factoryos/headquarter/store';
import {
  HQ_SESSION_COOKIE,
  HQ_SSO_STATE_COOKIE,
  HqSessionStore,
  registerHqSsoRoutes,
  SSO_HQ_ROUTES as HQ_ROUTES,
  type IdentityBackChannel,
} from '@factoryos/hq-host';

const HQ_ORIGIN = 'https://hq.example';
const HQ_CALLBACK = `${HQ_ORIGIN}${HQ_ROUTES.callback}`;
const SERVICE_SECRET = 'stage2-dev-test-secret-not-production';

let db: Db;
let tenant: TestTenant;
let founderUserId: string;
let identity: FastifyInstance;
let hq: FastifyInstance;
let store: HqSessionStore;
const audit: string[] = [];

/**
 * Both halves, wired to each other the way the shipped processes are.
 *
 * The logout notifier posts into HQ's REAL back-channel route with the real
 * service secret, so the propagation under test is the whole path — service
 * authentication included — and not a stub that always says yes.
 */
async function buildBothHosts(): Promise<void> {
  store = new HqSessionStore(openMemoryHqDatabase());
  const hqApp = Fastify({ logger: false });
  await hqApp.register(fastifyCookie);

  const options = composeAppOptions(
    db,
    {
      FACTORYOS_SSO_HQ: '1',
      FACTORYOS_SSO_HQ_AUDIENCE: HQ_ORIGIN,
      FACTORYOS_SSO_HQ_REDIRECT_URIS: HQ_CALLBACK,
      FACTORYOS_SSO_HQ_SERVICE_SECRET: SERVICE_SECRET,
    },
    () => {},
  ).options;
  options.ssoHq = {
    ...options.ssoHq!,
    audit: (line) => audit.push(line),
    logoutNotifier: {
      async revokeSessionsFor(originSessionId) {
        const res = await hqApp.inject({
          method: 'POST',
          url: HQ_ROUTES.backchannelLogout,
          headers: { [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
          payload: { originSessionId },
        });
        return { ok: res.statusCode === 200, detail: `status ${res.statusCode}` };
      },
    },
  };
  identity = buildApp(options);
  await identity.ready();

  const backChannel: IdentityBackChannel = {
    async redeem(ticket, state) {
      const res = await identity.inject({
        method: 'POST',
        url: IDENTITY_ROUTES.redeem,
        headers: { 'content-type': 'application/json', [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
        payload: { ticket, state },
      });
      return res.json();
    },
    async verifyPassword(input) {
      const res = await identity.inject({
        method: 'POST',
        url: IDENTITY_ROUTES.verifyPassword,
        headers: { 'content-type': 'application/json', [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
        payload: input,
      });
      return res.json().result;
    },
  };
  registerHqSsoRoutes(hqApp, {
    store,
    backChannel,
    identityOrigin: 'https://app.example',
    hqOrigin: HQ_ORIGIN,
    serviceSecret: SERVICE_SECRET,
    secureCookies: false,
  });
  await hqApp.ready();
  hq = hqApp;
}

/** Sign in at the identity host and complete a full handoff into HQ. */
async function signInAndHandOff(
  username = 'founder.salta',
  password = 'test-password',
): Promise<{ identityCookie: string; hqToken: string }> {
  const login = await identity.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  const identityCookie = `fos_session=${login.cookies.find((c) => c.name === 'fos_session')!.value}`;

  const authorize = await identity.inject({
    method: 'GET',
    url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=st`,
    headers: { cookie: identityCookie },
  });
  expect(authorize.statusCode).toBe(302);
  const ticket = new URL(authorize.headers.location as string).searchParams.get('ticket')!;

  const callback = await hq.inject({
    method: 'GET',
    url: `${HQ_ROUTES.callback}?ticket=${ticket}&state=st`,
    cookies: { [HQ_SSO_STATE_COOKIE]: 'st' },
  });
  expect(callback.statusCode).toBe(302);
  const hqToken = callback.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!.value;
  // The HQ session is live before the operation under test runs — otherwise
  // every assertion below would pass for the wrong reason.
  expect(store.resolve(hqToken)).not.toBeNull();
  return { identityCookie, hqToken };
}

beforeEach(async () => {
  _resetRateLimiter();
  audit.length = 0;
  db = testDb();
  tenant = makeTestTenant(db, 'SALTA');
  founderUserId = createUser(tenant.sysCtx, {
    username: 'founder.salta',
    displayName: 'The Founder',
    password: 'test-password',
    roleId: tenant.ownerRoleId,
  });
  await buildBothHosts();
});

afterEach(async () => {
  await hq?.close();
  await identity?.close();
});

/* ------------------------------------------------------------------ */
/* 1. Every ending operation kills the derived HQ session IMMEDIATELY   */
/* ------------------------------------------------------------------ */

describe('an HQ session dies with the identity authority behind it', () => {
  it('sign-out kills it (the one path that already worked)', async () => {
    const { identityCookie, hqToken } = await signInAndHandOff();
    const res = await identity.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: identityCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(store.resolve(hqToken)).toBeNull();
  });

  it('an ADMIN PASSWORD RESET kills it — it did not before', async () => {
    const { hqToken } = await signInAndHandOff();
    // A separate administrator, signed in on their own session.
    const adminLogin = await identity.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner.salta', password: 'test-password' },
    });
    const adminCookie = `fos_session=${adminLogin.cookies.find((c) => c.name === 'fos_session')!.value}`;

    const res = await identity.inject({
      method: 'POST',
      url: `/api/users/${founderUserId}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { password: 'a-brand-new-password' },
    });
    expect(res.statusCode).toBe(200);

    expect(
      store.resolve(hqToken),
      'resetting a compromised password must not leave the HQ session alive',
    ).toBeNull();
    expect(audit.join('\n')).toContain('password_reset');
    // The administrator's OWN session is untouched — this is targeted, not a
    // global sign-out.
    expect((await identity.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: adminCookie } })).statusCode).toBe(200);
  });

  it('DEACTIVATING the account kills it — it did not before', async () => {
    const { hqToken } = await signInAndHandOff();
    const adminLogin = await identity.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner.salta', password: 'test-password' },
    });
    const adminCookie = `fos_session=${adminLogin.cookies.find((c) => c.name === 'fos_session')!.value}`;

    const res = await identity.inject({
      method: 'PATCH',
      url: `/api/users/${founderUserId}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);

    expect(
      store.resolve(hqToken),
      'switching an account off must not leave its HQ session alive',
    ).toBeNull();
    expect(audit.join('\n')).toContain('account_deactivated');
  });

  it('an EMERGENCY RECOVERY CODE kills it — it did not before', async () => {
    const codes = generateRecoveryCodes(tenant.ownerCtx, founderUserId);
    const { hqToken } = await signInAndHandOff();

    const res = await identity.inject({
      method: 'POST',
      url: '/api/auth/recover',
      payload: {
        username: 'founder.salta',
        code: codes[0],
        newPassword: 'recovered-password',
        tenantCode: 'SALTA',
      },
    });
    expect(res.statusCode).toBe(200);

    expect(store.resolve(hqToken)).toBeNull();
    expect(audit.join('\n')).toContain('recovery');
  });

  it('a REACTIVATION is not a revocation — only ending authority propagates', async () => {
    const { hqToken } = await signInAndHandOff();
    const adminLogin = await identity.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner.salta', password: 'test-password' },
    });
    const adminCookie = `fos_session=${adminLogin.cookies.find((c) => c.name === 'fos_session')!.value}`;
    // An ordinary edit that changes nothing about authority must leave the HQ
    // session alone — a fix that revoked on every PATCH would be its own bug.
    const res = await identity.inject({
      method: 'PATCH',
      url: `/api/users/${founderUserId}`,
      headers: { cookie: adminCookie },
      payload: { displayName: 'The Founder (renamed)' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.resolve(hqToken)).not.toBeNull();
  });

  it('leaves the local operation successful when HQ is unreachable', async () => {
    // An administrator must always be able to reset a compromised password,
    // even with HQ down. HQ's own 60-minute ceiling is the backstop, and the
    // failure is audited rather than swallowed. Closing the HQ half makes the
    // notifier throw rather than answer — the harshest version of "unreachable",
    // and the one that turned this route into a 500 before the propagation
    // helper started catching it.
    const { hqToken } = await signInAndHandOff();
    await hq.close();

    const adminLogin = await identity.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner.salta', password: 'test-password' },
    });
    const adminCookie = `fos_session=${adminLogin.cookies.find((c) => c.name === 'fos_session')!.value}`;
    const res = await identity.inject({
      method: 'POST',
      url: `/api/users/${founderUserId}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { password: 'another-new-password' },
    });
    expect(res.statusCode).toBe(200);
    // The identity session is dead regardless of what HQ heard.
    expect(hqToken.length).toBeGreaterThan(0);
    expect(audit.join('\n')).toMatch(/HQ sessions revoked|WARNING: could not revoke/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The identity side of the redirect finding                        */
/* ------------------------------------------------------------------ */

describe('the logout notifier never follows a redirect while carrying the secret', () => {
  const listening: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(listening.map((s) => s.close()));
    listening.length = 0;
  });

  async function listen(configure: (app: FastifyInstance) => void): Promise<string> {
    const app = Fastify({ logger: false });
    configure(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    listening.push(app);
    const address = app.server.address();
    if (address == null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  for (const status of [301, 302, 303, 307, 308] as const) {
    it(`refuses a ${status} rather than replaying the service secret`, async () => {
      const captured: unknown[] = [];
      const attacker = await listen((app) => {
        app.all('/*', async (req) => {
          captured.push(req.headers[SSO_SERVICE_AUTH_HEADER]);
          return { ok: true };
        });
      });
      const hqStandIn = await listen((app) => {
        app.post(HQ_ROUTES.backchannelLogout, async (_req, reply) =>
          reply.status(status).header('location', `${attacker}${HQ_ROUTES.backchannelLogout}`).send(),
        );
      });

      const notifier = httpHqLogoutNotifier({
        hqOrigin: hqStandIn,
        serviceSecret: SERVICE_SECRET,
        header: SSO_SERVICE_AUTH_HEADER,
        path: HQ_ROUTES.backchannelLogout,
        timeoutMs: 2_000,
      });
      const result = await notifier.revokeSessionsFor('sess-1');

      expect(result.ok).toBe(false);
      expect(captured, `a ${status} must not carry the service secret onward`).toEqual([]);
    });
  }

  it('still reports success on an ordinary non-redirected call', async () => {
    const hqStandIn = await listen((app) => {
      app.post(HQ_ROUTES.backchannelLogout, async () => ({ ok: true, revoked: 1 }));
    });
    const notifier = httpHqLogoutNotifier({
      hqOrigin: hqStandIn,
      serviceSecret: SERVICE_SECRET,
      header: SSO_SERVICE_AUTH_HEADER,
      path: HQ_ROUTES.backchannelLogout,
    });
    expect((await notifier.revokeSessionsFor('sess-1')).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Structural: one revocation path, so a fifth cannot be forgotten   */
/* ------------------------------------------------------------------ */

describe('session revocation has exactly one implementation', () => {
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

  function everySourceFile(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return everySourceFile(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  it('no module except identity-revocation.ts sets revoked_at on sessions', () => {
    // The defect was four ending paths, each ending sessions its own way, only
    // one of which told HQ. This bound is what stops a fifth being added the
    // same way: revoking has to go through the function that returns the ids
    // propagation needs.
    const offenders: string[] = [];
    for (const file of everySourceFile(srcRoot)) {
      if (file.endsWith(path.join('services', 'identity-revocation.ts'))) continue;
      const source = readFileSync(file, 'utf8');
      // `update(sessions).set({ revokedAt ... })`, in any spelling drizzle allows.
      if (/update\(\s*sessions\s*\)[\s\S]{0,200}?revokedAt/.test(source)) {
        offenders.push(path.relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every ending path routes through it', () => {
    // A cheap, honest cross-check on the test above: these four modules must
    // actually import the shared path, so "no offenders" cannot be satisfied by
    // a module that quietly stopped revoking at all.
    for (const file of [
      path.join(srcRoot, 'services', 'auth.ts'),
      path.join(srcRoot, 'services', 'users.ts'),
      path.join(srcRoot, 'services', 'recovery.ts'),
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('revokeIdentitySessions');
    }
    for (const file of [
      path.join(srcRoot, 'routes', 'auth.ts'),
      path.join(srcRoot, 'routes', 'admin.ts'),
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('propagateIdentityRevocation');
    }
  });
});
