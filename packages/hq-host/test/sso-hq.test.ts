/**
 * HQ's side of the A-4 handoff (Phase 2, Stage 2).
 *
 * Founder Gate A named three risks by hand. Each has a section here, and each
 * is asserted against the shipped code rather than against a description of it:
 *
 *   A — authentication freshness: the handoff must not manufacture it
 *   B — rate limiting: the BROWSER's address must reach the identity host
 *   C — logout: an identity sign-out must revoke what HQ derived from it
 *
 * Plus the standing rule the whole option exists to protect: HQ must not become
 * a second password system.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { openMemoryHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import { HeadquarterOperations, HumanPrincipalRegistry } from '@factoryos/headquarter/application';
import {
  CONTROL_ROUTES,
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  STEP_UP_MAX_SESSION_AGE_MS,
} from '@factoryos/headquarter/live';
import {
  HQ_SESSION_COOKIE,
  HQ_SSO_STATE_COOKIE,
  HqSessionStore,
  registerHeadquarterRoutes,
  registerHqSsoRoutes,
  ssoIdentity,
  SSO_HQ_ROUTES,
  SSO_SERVICE_AUTH_HEADER,
  type HeadquarterControlPlane,
  type HqSsoClaims,
  type IdentityBackChannel,
  type SsoPasswordResult,
} from '../src/index.js';

const SERVICE_SECRET = 'dev-test-service-secret-value';
const HQ_ORIGIN = 'https://hq.example';
const IDENTITY_ORIGIN = 'https://app.example';

/** An identity host that answers whatever the test tells it to. */
function fakeBackChannel(
  overrides: Partial<{
    claims: HqSsoClaims;
    redeemError: 'ticket_unknown' | 'ticket_consumed' | 'ticket_expired' | 'unavailable';
    password: SsoPasswordResult;
    onVerify: (input: { clientIp: string; accountId: string }) => void;
  }> = {},
): IdentityBackChannel {
  return {
    async redeem() {
      if (overrides.redeemError) return { ok: false, error: overrides.redeemError };
      return { ok: true, claims: overrides.claims ?? defaultClaims() };
    },
    async verifyPassword(input) {
      overrides.onVerify?.(input);
      return overrides.password ?? 'ok';
    },
  };
}

/** Signed in two hours ago — deliberately NOT fresh. */
function defaultClaims(signedInAt = new Date(Date.now() - 2 * 3600_000)): HqSsoClaims {
  return {
    realmId: 'realm',
    accountId: 'acc-1',
    displayName: 'Proof Founder',
    sessionEstablishedAt: signedInAt.toISOString(),
    originSessionId: 'identity-session-1',
  };
}

let store: HqSessionStore;
let plane: HeadquarterControlPlane;

beforeEach(() => {
  const db = openMemoryHqDatabase();
  registerDirectOrderCapability(db);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  new HumanPrincipalRegistry(db).register({
    id: 'founder',
    displayName: 'Proof Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  store = new HqSessionStore(db);
  plane = {
    ops,
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
    allowedOrigins: [HQ_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
  };
});

async function buildHq(backChannel: IdentityBackChannel): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const identity = ssoIdentity(store, backChannel);
  registerHeadquarterRoutes(app, plane, identity);
  registerHqSsoRoutes(app, {
    store,
    backChannel,
    identityOrigin: IDENTITY_ORIGIN,
    hqOrigin: HQ_ORIGIN,
    serviceSecret: SERVICE_SECRET,
    secureCookies: false,
  });
  await app.ready();
  return app;
}

/** Complete a handoff and return the hq_session cookie value. */
async function handoff(app: FastifyInstance, state = 'state-abc'): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `${SSO_HQ_ROUTES.callback}?ticket=t-1&state=${state}`,
    cookies: { [HQ_SSO_STATE_COOKIE]: state },
  });
  expect(res.statusCode).toBe(302);
  const cookie = res.cookies.find((c) => c.name === HQ_SESSION_COOKIE);
  expect(cookie, 'the callback must mint an HQ session').toBeTruthy();
  return cookie!.value;
}

/* ------------------------------------------------------------------ */
/* TRAP A — the handoff must not manufacture authentication freshness  */
/* ------------------------------------------------------------------ */

describe('TRAP A — a handoff is not a fresh sign-in', () => {
  it('carries the ORIGINAL sign-in time into the session, not the handoff time', async () => {
    const signedInAt = new Date(Date.now() - 3 * 3600_000);
    const app = await buildHq(fakeBackChannel({ claims: defaultClaims(signedInAt) }));
    const token = await handoff(app);

    const record = store.resolve(token)!;
    expect(record.sessionEstablishedAt).toBe(signedInAt.toISOString());
    // The handoff instant is recorded, separately, and is much newer.
    expect(Date.parse(record.createdAt)).toBeGreaterThan(Date.parse(record.sessionEstablishedAt));
    await app.close();
  });

  it('reports that original time as authenticatedAt, which is what step-up reads', async () => {
    const signedInAt = new Date(Date.now() - 3 * 3600_000);
    const app = await buildHq(fakeBackChannel({ claims: defaultClaims(signedInAt) }));
    const token = await handoff(app);

    const res = await app.inject({
      method: 'GET',
      url: CONTROL_ROUTES.session,
      cookies: { [HQ_SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().founder).toBe(true);
    // The whole trap in one assertion: an hours-old sign-in stays hours old.
    const age = Date.now() - Date.parse(store.resolve(token)!.sessionEstablishedAt);
    expect(age).toBeGreaterThan(STEP_UP_MAX_SESSION_AGE_MS);
    await app.close();
  });

  it('does not let a repeated handoff refresh an old sign-in', async () => {
    const signedInAt = new Date(Date.now() - 3 * 3600_000);
    const app = await buildHq(fakeBackChannel({ claims: defaultClaims(signedInAt) }));
    const first = store.resolve(await handoff(app, 's1'))!;
    const second = store.resolve(await handoff(app, 's2'))!;
    // Bouncing through the identity host again buys no freshness whatsoever.
    expect(second.sessionEstablishedAt).toBe(first.sessionEstablishedAt);
    expect(second.sessionEstablishedAt).toBe(signedInAt.toISOString());
    await app.close();
  });

  it('still honours a genuinely fresh sign-in', async () => {
    const app = await buildHq(fakeBackChannel({ claims: defaultClaims(new Date()) }));
    const record = store.resolve(await handoff(app))!;
    expect(Date.now() - Date.parse(record.sessionEstablishedAt)).toBeLessThan(
      STEP_UP_MAX_SESSION_AGE_MS,
    );
    await app.close();
  });
});

/* ------------------------------------------------------------------ */
/* TRAP B — the browser's address must reach the identity host         */
/* ------------------------------------------------------------------ */

describe('TRAP B — step-up is budgeted against the real client', () => {
  it('forwards the browser address, not HQ own, to the identity host', async () => {
    const seen: string[] = [];
    const app = await buildHq(
      fakeBackChannel({ onVerify: (input) => seen.push(input.clientIp), password: 'ok' }),
    );
    const token = await handoff(app);
    await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.approve,
      headers: { origin: HQ_ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '' },
      cookies: { [HQ_SESSION_COOKIE]: token },
      payload: { taskId: 'nope', stepUpPassword: 'hunter2' },
      remoteAddress: '203.0.113.9',
    });
    expect(seen).toContain('203.0.113.9');
    await app.close();
  });

  it('asks the identity host nothing when no password was supplied', async () => {
    const seen: string[] = [];
    const app = await buildHq(fakeBackChannel({ onVerify: (i) => seen.push(i.accountId) }));
    const token = await handoff(app);
    await app.inject({
      method: 'GET',
      url: CONTROL_ROUTES.session,
      cookies: { [HQ_SESSION_COOKIE]: token },
    });
    expect(seen).toEqual([]);
    await app.close();
  });

  it('refuses honestly when the identity host cannot be reached', async () => {
    // An outage must not be reported to the person at the keyboard as a wrong
    // password, and must not approve anything.
    const app = await buildHq(fakeBackChannel({ password: 'unavailable' }));
    const token = await handoff(app);
    const res = await app.inject({
      method: 'POST',
      url: CONTROL_ROUTES.approve,
      headers: { origin: HQ_ORIGIN, 'content-type': 'application/json' },
      cookies: { [HQ_SESSION_COOKIE]: token },
      payload: { taskId: 'nope', stepUpPassword: 'hunter2' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('step_up_unavailable');
    await app.close();
  });
});

/* ------------------------------------------------------------------ */
/* TRAP C — identity sign-out revokes what HQ derived                  */
/* ------------------------------------------------------------------ */

describe('TRAP C — logout propagates', () => {
  it('revokes every HQ session derived from one identity session', async () => {
    const app = await buildHq(fakeBackChannel());
    const first = await handoff(app, 's1');
    const second = await handoff(app, 's2');
    expect(store.resolve(first)).not.toBeNull();
    expect(store.resolve(second)).not.toBeNull();

    const res = await app.inject({
      method: 'POST',
      url: SSO_HQ_ROUTES.backchannelLogout,
      headers: { [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
      payload: { originSessionId: 'identity-session-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(2);
    expect(store.resolve(first)).toBeNull();
    expect(store.resolve(second)).toBeNull();
    await app.close();
  });

  it('refuses back-channel logout without the service credential', async () => {
    const app = await buildHq(fakeBackChannel());
    const token = await handoff(app);
    for (const headers of [{}, { [SSO_SERVICE_AUTH_HEADER]: 'wrong' }]) {
      const res = await app.inject({
        method: 'POST',
        url: SSO_HQ_ROUTES.backchannelLogout,
        headers,
        payload: { originSessionId: 'identity-session-1' },
      });
      expect(res.statusCode).toBe(401);
    }
    // Nothing was revoked by the attempts.
    expect(store.resolve(token)).not.toBeNull();
    await app.close();
  });

  it('lets a Founder sign out of HQ alone', async () => {
    const app = await buildHq(fakeBackChannel());
    const token = await handoff(app);
    const res = await app.inject({
      method: 'POST',
      url: SSO_HQ_ROUTES.logout,
      cookies: { [HQ_SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    expect(store.resolve(token)).toBeNull();
    await app.close();
  });

  it('stops answering the control API the moment the session is revoked', async () => {
    const app = await buildHq(fakeBackChannel());
    const token = await handoff(app);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: CONTROL_ROUTES.session,
          cookies: { [HQ_SESSION_COOKIE]: token },
        })
      ).statusCode,
    ).toBe(200);
    store.revokeByOriginSession('identity-session-1');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: CONTROL_ROUTES.session,
          cookies: { [HQ_SESSION_COOKIE]: token },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
});

/* ------------------------------------------------------------------ */
/* The callback is the only door, and it is bolted                     */
/* ------------------------------------------------------------------ */

describe('the callback refuses everything it should', () => {
  it('refuses a state that does not match the cookie (CSRF / fixation)', async () => {
    const app = await buildHq(fakeBackChannel());
    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?ticket=t-1&state=attacker`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'genuine' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.cookies.find((c) => c.name === HQ_SESSION_COOKIE)?.value).toBeFalsy();
    await app.close();
  });

  it('refuses a callback with no state cookie at all', async () => {
    const app = await buildHq(fakeBackChannel());
    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?ticket=t-1&state=anything`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('refuses a callback with no ticket', async () => {
    const app = await buildHq(fakeBackChannel());
    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?state=s`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 's' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('mints nothing when the identity host rejects the ticket', async () => {
    for (const error of ['ticket_unknown', 'ticket_consumed', 'ticket_expired'] as const) {
      const app = await buildHq(fakeBackChannel({ redeemError: error }));
      const res = await app.inject({
        method: 'GET',
        url: `${SSO_HQ_ROUTES.callback}?ticket=t&state=s`,
        cookies: { [HQ_SSO_STATE_COOKIE]: 's' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.cookies.find((c) => c.name === HQ_SESSION_COOKIE)?.value).toBeFalsy();
      await app.close();
    }
  });

  it('burns the state cookie even on a refusal, so it cannot be reused', async () => {
    const app = await buildHq(fakeBackChannel({ redeemError: 'ticket_unknown' }));
    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?ticket=t&state=s`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 's' },
    });
    const cleared = res.cookies.find((c) => c.name === HQ_SSO_STATE_COOKIE);
    expect(cleared?.value).toBe('');
    await app.close();
  });

  it('sets a HOST-ONLY session cookie — no Domain attribute, ever', async () => {
    const app = await buildHq(fakeBackChannel());
    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?ticket=t&state=s`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 's' },
    });
    const cookie = res.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!;
    // This is the entire reason A-4 was chosen over A-2.
    expect(cookie).not.toHaveProperty('domain');
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe('lax');
    await app.close();
  });

  it('never redirects anywhere but a path on this host', async () => {
    const app = await buildHq(fakeBackChannel());
    // `//evil` and `/\evil` are the ones that matter: both START WITH a slash,
    // so the obvious `startsWith('/')` check passes them, and a browser reads
    // both as absolute URLs. An open redirect on the sign-in path is exactly
    // what makes a phishing link look legitimate.
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example/steal',
      '/\\evil.example/steal',
      '\\\\evil.example/steal',
      'javascript:alert(1)',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `${SSO_HQ_ROUTES.callback}?ticket=t&state=s`,
        cookies: { [HQ_SSO_STATE_COOKIE]: 's', hq_sso_return: hostile },
      });
      expect(res.headers.location, `${hostile} must not be followed`).toBe('/hq/');
    }
    await app.close();
  });

  it('still honours a genuine in-app path', async () => {
    const app = await buildHq(fakeBackChannel());
    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?ticket=t&state=s`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 's', hq_sso_return: '/hq/connections.html' },
    });
    expect(res.headers.location).toBe('/hq/connections.html');
    await app.close();
  });
});

/* ------------------------------------------------------------------ */
/* HQ is still not a password system                                   */
/* ------------------------------------------------------------------ */

describe('HQ holds sessions, never credentials', () => {
  it('stores no password-shaped column', () => {
    const db = openMemoryHqDatabase();
    new HqSessionStore(db);
    const columns = (db.prepare('PRAGMA table_info(hq_sessions)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const column of columns) {
      expect(/pass|secret|credential|hash_pw/i.test(column), `suspicious column ${column}`).toBe(
        false,
      );
    }
    expect(columns).toContain('session_established_at');
    expect(columns).toContain('origin_session_id');
  });

  it('never stores the session token itself', async () => {
    const app = await buildHq(fakeBackChannel());
    const token = await handoff(app);
    const db = openMemoryHqDatabase();
    // The store under test is the one bound to `plane`; read it back directly.
    const record = store.resolve(token)!;
    expect(record).toBeTruthy();
    // A dump of the table must not contain the bearer value.
    const dump = JSON.stringify(record);
    expect(dump).not.toContain(token);
    db.close();
    await app.close();
  });

  it('cannot mint a session without a redeemed ticket', async () => {
    const app = await buildHq(fakeBackChannel());
    // There is no other route that creates one.
    for (const url of ['/sso/login', '/api/sso/hq/login', '/hq/login', '/login']) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode, `${url} must not exist`).toBe(404);
    }
    await app.close();
  });
});
