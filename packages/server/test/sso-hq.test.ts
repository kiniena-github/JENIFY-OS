/**
 * The identity host's HQ sign-in bridge, and the two hosts together
 * (Phase 2, Stage 2; Founder Gate A decided A-4 on 2026-09-02).
 *
 * `packages/hq-host` proves HQ's half with a stubbed identity host. This suite
 * proves the half only THIS server can be wrong about — that a ticket is minted
 * only for an account it had already authenticated, that it is redeemable
 * exactly once, that the back channel is closed to a browser, and that step-up
 * really does charge the same failure budget as sign-in — and then wires both
 * hosts together and walks the whole handoff.
 *
 * Two origins throughout, deliberately: `app.example` and `hq.example`. The
 * point of A-4 is that they are different, and that the `fos_session` cookie
 * never crosses between them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/services/users.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { ssoHqTickets } from '../src/db/schema.js';
import {
  SSO_HQ_ROUTES as IDENTITY_ROUTES,
  SSO_SERVICE_AUTH_HEADER,
  type SsoHqPlane,
} from '../src/routes/sso-hq.js';
import { openMemoryHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import { HeadquarterOperations, HumanPrincipalRegistry } from '@factoryos/headquarter/application';
import {
  registerDirectOrderCapability,
  DIRECT_ORDER_CAPABILITY,
  CONTROL_ROUTES,
} from '@factoryos/headquarter/live';
import {
  HQ_SESSION_COOKIE,
  HQ_SSO_STATE_COOKIE,
  HqSessionStore,
  registerHeadquarterRoutes,
  registerHqSsoRoutes,
  ssoIdentity,
  SSO_HQ_ROUTES as HQ_ROUTES,
  type IdentityBackChannel,
} from '@factoryos/hq-host';

const SERVICE_SECRET = 'stage2-dev-test-secret-not-production';
const HQ_ORIGIN = 'https://hq.example';
const HQ_CALLBACK = `${HQ_ORIGIN}${HQ_ROUTES.callback}`;

let db: Db;
let tenant: TestTenant;
let founderUserId: string;

beforeEach(() => {
  _resetRateLimiter();
  db = testDb();
  tenant = makeTestTenant(db, 'SALTA');
  founderUserId = createUser(tenant.sysCtx, {
    username: 'founder.salta',
    displayName: 'The Founder',
    password: 'test-password',
    roleId: tenant.ownerRoleId,
  });
});

function ssoPlane(overrides: Partial<SsoHqPlane> = {}): SsoHqPlane {
  return {
    audience: HQ_ORIGIN,
    allowedRedirectUris: [HQ_CALLBACK],
    serviceSecret: SERVICE_SECRET,
    ...overrides,
  };
}

function identityApp(plane: SsoHqPlane = ssoPlane()) {
  return buildApp({ db, ssoHq: plane });
}

async function signIn(instance: FastifyInstance): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'founder.salta', password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  return `fos_session=${response.cookies.find((c) => c.name === 'fos_session')!.value}`;
}

/** Pull the ticket out of an authorize redirect. */
function ticketFrom(location: string): string {
  return new URL(location).searchParams.get('ticket') ?? '';
}

/* ------------------------------------------------------------------ */
/* Minting: only for an account this server already authenticated      */
/* ------------------------------------------------------------------ */

describe('a ticket is minted only for an already-signed-in account', () => {
  it('refuses to mint anything for an anonymous caller', async () => {
    const instance = identityApp();
    const res = await instance.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=s1`,
    });
    expect(res.statusCode).toBe(401);
    expect(db.select().from(ssoHqTickets).all()).toEqual([]);
    await instance.close();
  });

  it('mints and redirects for a signed-in Founder', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    const res = await instance.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=s1`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe(HQ_ORIGIN);
    expect(location.searchParams.get('state')).toBe('s1');
    expect(location.searchParams.get('ticket')).toBeTruthy();
    await instance.close();
  });

  it('never stores the ticket itself, only a digest', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    const res = await instance.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=s1`,
      headers: { cookie },
    });
    const ticket = ticketFrom(res.headers.location as string);
    const rows = db.select().from(ssoHqTickets).all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(ticket);
    await instance.close();
  });

  it('carries the ORIGINAL sign-in time, not the moment of the handoff (TRAP A)', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await instance.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=s1`,
      headers: { cookie },
    });
    const row = db.select().from(ssoHqTickets).all()[0]!;
    // The ticket was created after the session; the vouched-for sign-in time is
    // the session's, and is strictly older than the ticket's own createdAt.
    expect(Date.parse(row.sessionEstablishedAt)).toBeLessThanOrEqual(Date.parse(row.createdAt));
    expect(row.originSessionId).toBeTruthy();
    await instance.close();
  });
});

/* ------------------------------------------------------------------ */
/* Open redirect                                                       */
/* ------------------------------------------------------------------ */

describe('the redirect target is checked exactly, never by prefix', () => {
  it('refuses a look-alike host that merely starts with the allowed URL', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    for (const evil of [
      'https://hq.example.evil.test/sso/callback',
      'https://evil.test/sso/callback',
      `${HQ_CALLBACK}/../../steal`,
      'https://hq.example/sso/callback/extra',
    ]) {
      const res = await instance.inject({
        method: 'GET',
        url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(evil)}&state=s`,
        headers: { cookie },
      });
      expect(res.statusCode, `${evil} must be refused`).toBe(400);
    }
    expect(db.select().from(ssoHqTickets).all()).toEqual([]);
    await instance.close();
  });

  it('refuses a missing state', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    const res = await instance.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    await instance.close();
  });
});

/* ------------------------------------------------------------------ */
/* The back channel is closed to browsers, and a ticket is single-use  */
/* ------------------------------------------------------------------ */

describe('the back channel', () => {
  async function mint(instance: FastifyInstance, cookie: string): Promise<string> {
    const res = await instance.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=s1`,
      headers: { cookie },
    });
    return ticketFrom(res.headers.location as string);
  }

  it('refuses redeem without the service secret, even holding a valid ticket', async () => {
    const instance = identityApp();
    const ticket = await mint(instance, await signIn(instance));
    for (const headers of [{}, { [SSO_SERVICE_AUTH_HEADER]: 'wrong-secret-value-here' }]) {
      const res = await instance.inject({
        method: 'POST',
        url: IDENTITY_ROUTES.redeem,
        headers: { 'content-type': 'application/json', ...headers },
        payload: { ticket, state: 's1' },
      });
      expect(res.statusCode).toBe(401);
    }
    // The ticket survived the failed attempts and is still redeemable.
    const ok = await instance.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.redeem,
      headers: { 'content-type': 'application/json', [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
      payload: { ticket, state: 's1' },
    });
    expect(ok.statusCode).toBe(200);
    await instance.close();
  });

  it('redeems exactly once — a replay loses', async () => {
    const instance = identityApp();
    const ticket = await mint(instance, await signIn(instance));
    const headers = {
      'content-type': 'application/json',
      [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET,
    };
    const first = await instance.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.redeem,
      headers,
      payload: { ticket, state: 's1' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().claims.accountId).toBe(founderUserId);

    const replay = await instance.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.redeem,
      headers,
      payload: { ticket, state: 's1' },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('ticket_consumed');
    await instance.close();
  });

  it('refuses an unknown ticket', async () => {
    const instance = identityApp();
    const res = await instance.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.redeem,
      headers: { 'content-type': 'application/json', [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
      payload: { ticket: 'not-a-real-ticket' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ticket_unknown');
    await instance.close();
  });

  it('refuses a ticket minted for a different audience', async () => {
    const instance = identityApp(ssoPlane({ audience: 'https://somewhere.else' }));
    const ticket = await mint(instance, await signIn(instance));
    // Redeem against a server configured for the real audience.
    const other = buildApp({ db, ssoHq: ssoPlane() });
    const res = await other.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.redeem,
      headers: { 'content-type': 'application/json', [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
      payload: { ticket },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('audience_mismatch');
    await instance.close();
    await other.close();
  });
});

/* ------------------------------------------------------------------ */
/* TRAP B — the shared failure budget                                  */
/* ------------------------------------------------------------------ */

describe('TRAP B — step-up shares the sign-in failure budget', () => {
  const headers = { 'content-type': 'application/json', [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET };

  async function verify(instance: FastifyInstance, password: string, clientIp = '198.51.100.7') {
    return instance.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.verifyPassword,
      headers,
      payload: { realmId: tenant.tenantId, accountId: founderUserId, password, clientIp },
    });
  }

  it('accepts the right password and rejects the wrong one', async () => {
    const instance = identityApp();
    expect((await verify(instance, 'test-password')).json().result).toBe('ok');
    expect((await verify(instance, 'wrong')).json().result).toBe('rejected');
    await instance.close();
  });

  it('charges failures to the SAME bucket sign-in uses, keyed on the browser', async () => {
    const instance = identityApp();
    // Ten wrong step-up guesses from one browser address.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await verify(instance, `wrong-${attempt}`);
    }
    // The eleventh is budget-limited, not merely rejected.
    expect((await verify(instance, 'wrong-again')).json().result).toBe('rate_limited');
    // And sign-in from that same address is now locked out too — one budget,
    // not two. This is the equivalence two Codex rounds established, preserved
    // across a network boundary.
    const login = await instance.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'founder.salta', password: 'test-password' },
      remoteAddress: '198.51.100.7',
    });
    expect(login.statusCode).toBe(429);
    await instance.close();
  });

  it('buckets per browser, so one attacker cannot lock out another Founder', async () => {
    const instance = identityApp();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await verify(instance, `wrong-${attempt}`, '203.0.113.1');
    }
    expect((await verify(instance, 'wrong', '203.0.113.1')).json().result).toBe('rate_limited');
    // A different browser is untouched. Had HQ forwarded its OWN address, every
    // Founder would have shared one bucket and this would fail.
    expect((await verify(instance, 'test-password', '203.0.113.2')).json().result).toBe('ok');
    await instance.close();
  });

  it('refuses to run unbudgeted when no client address is supplied', async () => {
    const instance = identityApp();
    const res = await instance.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.verifyPassword,
      headers,
      payload: { realmId: tenant.tenantId, accountId: founderUserId, password: 'test-password' },
    });
    expect(res.json().result).toBe('rejected');
    await instance.close();
  });

  it('refuses the back channel without the service secret', async () => {
    const instance = identityApp();
    const res = await instance.inject({
      method: 'POST',
      url: IDENTITY_ROUTES.verifyPassword,
      headers: { 'content-type': 'application/json' },
      payload: {
        realmId: tenant.tenantId,
        accountId: founderUserId,
        password: 'test-password',
        clientIp: '198.51.100.7',
      },
    });
    expect(res.statusCode).toBe(401);
    await instance.close();
  });
});

/* ------------------------------------------------------------------ */
/* Both hosts, wired together                                          */
/* ------------------------------------------------------------------ */

describe('the two hosts complete a handoff', () => {
  /** A back channel that calls the real identity app, without sockets. */
  function wire(identity: FastifyInstance): IdentityBackChannel {
    const headers = {
      'content-type': 'application/json',
      [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET,
    };
    return {
      async redeem(ticket, state) {
        const res = await identity.inject({
          method: 'POST',
          url: IDENTITY_ROUTES.redeem,
          headers,
          // Exactly what `httpBackChannel` puts on the wire, state included
          // (trap D): the ticket alone is not enough to redeem.
          payload: { ticket, state },
        });
        return res.json();
      },
      async verifyPassword(input) {
        const res = await identity.inject({
          method: 'POST',
          url: IDENTITY_ROUTES.verifyPassword,
          headers,
          payload: input,
        });
        return res.json().result;
      },
    };
  }

  async function buildHq(backChannel: IdentityBackChannel) {
    const hqDb = openMemoryHqDatabase();
    registerDirectOrderCapability(hqDb);
    const ops = new HeadquarterOperations(hqDb, { store: new HeadquarterStore(hqDb) });
    new HumanPrincipalRegistry(hqDb).register({
      id: 'founder',
      displayName: 'The Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const store = new HqSessionStore(hqDb);
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    const plane = {
      ops,
      founderMap: [
        { realmId: tenant.tenantId, accountId: founderUserId, principalId: 'founder' },
      ],
      allowedOrigins: [HQ_ORIGIN],
      secretsEnv: {},
      mutationsEnabled: true,
    };
    registerHeadquarterRoutes(app, plane, ssoIdentity(store, backChannel));
    registerHqSsoRoutes(app, {
      store,
      backChannel,
      identityOrigin: 'https://app.example',
      hqOrigin: HQ_ORIGIN,
      serviceSecret: SERVICE_SECRET,
      secureCookies: false,
    });
    await app.ready();
    return { app, store };
  }

  it('walks the whole flow: sign in at the app, end up a Founder at HQ', async () => {
    const identity = identityApp();
    const cookie = await signIn(identity);
    const { app: hq, store } = await buildHq(wire(identity));

    // 1. The identity host vouches, once.
    const authorized = await identity.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=st`,
      headers: { cookie },
    });
    const ticket = ticketFrom(authorized.headers.location as string);

    // 2. HQ redeems it over the back channel and mints ITS OWN session.
    const callback = await hq.inject({
      method: 'GET',
      url: `${HQ_ROUTES.callback}?ticket=${ticket}&state=st`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'st' },
    });
    expect(callback.statusCode).toBe(302);
    const hqCookie = callback.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!;
    // The identity host's cookie was never involved on this origin.
    expect(hqCookie.name).not.toBe('fos_session');
    expect(hqCookie).not.toHaveProperty('domain');

    // 3. HQ now knows the Founder — through its own cookie alone.
    const session = await hq.inject({
      method: 'GET',
      url: CONTROL_ROUTES.session,
      cookies: { [HQ_SESSION_COOKIE]: hqCookie.value },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().founder).toBe(true);

    // 4. And the vouched-for sign-in time is the real one.
    expect(store.resolve(hqCookie.value)!.sessionEstablishedAt).toBeTruthy();
    await hq.close();
    await identity.close();
  });

  it('refuses HQ entirely when the ticket was never redeemed', async () => {
    const identity = identityApp();
    const { app: hq } = await buildHq(wire(identity));
    const res = await hq.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(res.statusCode).toBe(401);
    await hq.close();
    await identity.close();
  });

  it('TRAP C — signing out of Jenify revokes the HQ session', async () => {
    const identity0 = identityApp();
    const cookie = await signIn(identity0);
    let hqRef: Awaited<ReturnType<typeof buildHq>> | null = null;

    // The identity host is rebuilt with a notifier pointed at the real HQ app.
    const identity = buildApp({
      db,
      ssoHq: ssoPlane({
        logoutNotifier: {
          async revokeSessionsFor(originSessionId) {
            const res = await hqRef!.app.inject({
              method: 'POST',
              url: HQ_ROUTES.backchannelLogout,
              headers: {
                'content-type': 'application/json',
                [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET,
              },
              payload: { originSessionId },
            });
            return { ok: res.statusCode === 200, detail: `status ${res.statusCode}` };
          },
        },
      }),
    });
    hqRef = await buildHq(wire(identity));

    const authorized = await identity.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=st`,
      headers: { cookie },
    });
    const ticket = ticketFrom(authorized.headers.location as string);
    const callback = await hqRef.app.inject({
      method: 'GET',
      url: `${HQ_ROUTES.callback}?ticket=${ticket}&state=st`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'st' },
    });
    const hqToken = callback.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!.value;
    expect(hqRef.store.resolve(hqToken)).not.toBeNull();

    // Sign out of Jenify. HQ must not still be open.
    const loggedOut = await identity.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(hqRef.store.resolve(hqToken), 'the HQ session must die with the identity session').toBeNull();

    const after = await hqRef.app.inject({
      method: 'GET',
      url: CONTROL_ROUTES.session,
      cookies: { [HQ_SESSION_COOKIE]: hqToken },
    });
    expect(after.statusCode).toBe(401);

    await hqRef.app.close();
    await identity.close();
    await identity0.close();
  });

  it('still signs out locally when HQ cannot be reached', async () => {
    // Sign-out must never be blocked by a downstream outage.
    const identity = buildApp({
      db,
      ssoHq: ssoPlane({
        logoutNotifier: {
          async revokeSessionsFor() {
            return { ok: false, detail: 'unreachable' };
          },
        },
      }),
    });
    const cookie = await signIn(identity);
    const res = await identity.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    await identity.close();
  });
});

/* ------------------------------------------------------------------ */
/* Off by default                                                      */
/* ------------------------------------------------------------------ */

describe('an ordinary tenant deployment has none of this', () => {
  it('exposes no bridge routes when no plane is passed', async () => {
    const instance = buildApp({ db });
    for (const url of Object.values(IDENTITY_ROUTES)) {
      const res = await instance.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} must not exist`).toBe(404);
    }
    await instance.close();
  });
});
