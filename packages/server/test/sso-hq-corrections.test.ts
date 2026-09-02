/**
 * The Codex P1 corrections to the A-4 handoff (issue #237).
 *
 * Four findings on exact head `ef12d0d`. Two of them are the identity host's to
 * fix and are asserted here, hostile-first — each test tries to do the thing the
 * finding said was possible, and fails to:
 *
 *   P1-1  a ticket must be bound to the state it was minted with, so a captured
 *         ticket cannot be redeemed from another browser's round trip
 *   P1-2  a ticket must die with the session behind it, so a sign-out between
 *         authorize and redeem cannot leave a credential that still mints a new
 *         HQ session
 *
 * `sso-hq-wiring.test.ts` covers P1-3 (the shipped entrypoint), and
 * `packages/hq-host/test/sso-origin.test.ts` covers P1-4 (cleartext back
 * channels).
 *
 * Two origins throughout, as in `sso-hq.test.ts`: the point of A-4 is that
 * `app.example` and `hq.example` are different hosts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/services/users.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { sessions, ssoHqTickets, users } from '../src/db/schema.js';
import { SSO_HQ_ROUTES as IDENTITY_ROUTES, SSO_SERVICE_AUTH_HEADER, type SsoHqPlane } from '../src/routes/sso-hq.js';
import { openMemoryHqDatabase } from '@factoryos/headquarter/store';
import {
  HQ_SESSION_COOKIE,
  HQ_SSO_STATE_COOKIE,
  HqSessionStore,
  registerHqSsoRoutes,
  SSO_HQ_ROUTES as HQ_ROUTES,
  type IdentityBackChannel,
} from '@factoryos/hq-host';

const SERVICE_SECRET = 'stage2-dev-test-secret-not-production';
const HQ_ORIGIN = 'https://hq.example';
const IDENTITY_ORIGIN = 'https://app.example';
const HQ_CALLBACK = `${HQ_ORIGIN}${HQ_ROUTES.callback}`;
const SERVICE_HEADERS = {
  'content-type': 'application/json',
  [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET,
};

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

async function signIn(instance: FastifyInstance): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'founder.salta', password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  return `fos_session=${response.cookies.find((c) => c.name === 'fos_session')!.value}`;
}

/** Start a handoff and return the ticket the identity host minted. */
async function mint(instance: FastifyInstance, cookie: string, state: string): Promise<string> {
  const res = await instance.inject({
    method: 'GET',
    url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=${state}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(302);
  return new URL(res.headers.location as string).searchParams.get('ticket')!;
}

function redeem(instance: FastifyInstance, payload: Record<string, unknown>) {
  return instance.inject({
    method: 'POST',
    url: IDENTITY_ROUTES.redeem,
    headers: SERVICE_HEADERS,
    payload,
  });
}

/* ------------------------------------------------------------------ */
/* P1-1 — a ticket belongs to ONE round trip                           */
/* ------------------------------------------------------------------ */

describe('P1-1: a redeemed ticket is bound to the state it was minted with', () => {
  it('refuses a ticket presented with a DIFFERENT state (the stolen-ticket case)', async () => {
    const instance = identityApp();
    const ticket = await mint(instance, await signIn(instance), 'victim-state');

    // The attacker holds the ticket — captured from a URL, a proxy log, a
    // referrer or the victim's history — and presents it with the state of
    // their OWN sign-in attempt, which their own browser cookie matches
    // perfectly. That is exactly the case the callback's cookie check cannot
    // see, and it must lose here.
    const stolen = await redeem(instance, { ticket, state: 'attacker-state' });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error).toBe('state_mismatch');

    // And it did NOT burn the ticket: the victim's own callback still works.
    const legitimate = await redeem(instance, { ticket, state: 'victim-state' });
    expect(legitimate.statusCode).toBe(200);
    expect(legitimate.json().claims.accountId).toBe(founderUserId);
    await instance.close();
  });

  it('refuses a redeem that presents no state at all', async () => {
    // Fail closed rather than waive: an older HQ build that does not send a
    // state must be refused, never quietly trusted.
    const instance = identityApp();
    const ticket = await mint(instance, await signIn(instance), 'st');
    for (const payload of [{ ticket }, { ticket, state: '' }, { ticket, state: 42 }]) {
      const res = await redeem(instance, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('state_mismatch');
    }
    await instance.close();
  });

  it('refuses a state that is a prefix, a suffix or a case variant of the real one', async () => {
    const instance = identityApp();
    const ticket = await mint(instance, await signIn(instance), 'correct-state-value');
    for (const state of [
      'correct-state-valu',
      'correct-state-value ',
      'correct-state-valueX',
      'CORRECT-STATE-VALUE',
      'x',
    ]) {
      const res = await redeem(instance, { ticket, state });
      expect(res.json().error, `state '${state}' must not redeem`).toBe('state_mismatch');
    }
    // Still redeemable by the real one afterwards.
    expect((await redeem(instance, { ticket, state: 'correct-state-value' })).statusCode).toBe(200);
    await instance.close();
  });

  it('does not let one browser redeem a ticket minted for another (both hosts, live)', async () => {
    const identity = identityApp();
    const cookie = await signIn(identity);
    const hq = await buildHqAgainst(identity);

    // The victim starts a real handoff on their browser.
    const victimTicket = await mint(identity, cookie, 'victim-state');

    // The attacker's browser has its own legitimate state cookie — it started
    // its own sign-in at HQ moments ago — and they paste the victim's ticket
    // into their own callback. HQ's cookie check passes. The handoff must not.
    const attackerCallback = await hq.inject({
      method: 'GET',
      url: `${HQ_ROUTES.callback}?ticket=${victimTicket}&state=attacker-state`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'attacker-state' },
    });
    expect(attackerCallback.statusCode).toBe(400);
    expect(attackerCallback.cookies.find((c) => c.name === HQ_SESSION_COOKIE)?.value).toBeFalsy();

    // The victim's own callback still completes: the refusal above was
    // targeted, not a blanket breakage of the flow.
    const victimCallback = await hq.inject({
      method: 'GET',
      url: `${HQ_ROUTES.callback}?ticket=${victimTicket}&state=victim-state`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'victim-state' },
    });
    expect(victimCallback.statusCode).toBe(302);
    expect(victimCallback.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!.value).toBeTruthy();

    await hq.close();
    await identity.close();
  });
});

/* ------------------------------------------------------------------ */
/* P1-2 — a ticket does not outlive its session                        */
/* ------------------------------------------------------------------ */

describe('P1-2: a ticket dies with the identity session behind it', () => {
  it('refuses a ticket redeemed AFTER sign-out (the logout-before-redeem race)', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    const ticket = await mint(instance, cookie, 'st');

    // Sign out in the window between authorize and redeem. No HQ session
    // exists yet, so trap C's back-channel logout has nothing to revoke —
    // this ticket is the whole exposure.
    const out = await instance.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);

    const res = await redeem(instance, { ticket, state: 'st' });
    expect(res.statusCode).toBe(400);
    // Killed at sign-out, in the same transaction that revoked the session.
    expect(res.json().error).toBe('ticket_consumed');
    await instance.close();
  });

  it('invalidates every outstanding ticket for that session, not just one', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    const tickets = [
      await mint(instance, cookie, 'st-1'),
      await mint(instance, cookie, 'st-2'),
      await mint(instance, cookie, 'st-3'),
    ];
    await instance.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });

    for (const [index, ticket] of tickets.entries()) {
      const res = await redeem(instance, { ticket, state: `st-${index + 1}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('ticket_consumed');
    }
    // Every row is marked consumed in the store, not merely refused in flight.
    expect(db.select().from(ssoHqTickets).all().every((row) => row.consumedAt != null)).toBe(true);
    await instance.close();
  });

  it('leaves another session\'s tickets alone when one session signs out', async () => {
    const instance = identityApp();
    const first = await signIn(instance);
    const second = await signIn(instance);
    const firstTicket = await mint(instance, first, 'st-a');
    const secondTicket = await mint(instance, second, 'st-b');

    await instance.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: first } });

    expect((await redeem(instance, { ticket: firstTicket, state: 'st-a' })).json().error).toBe(
      'ticket_consumed',
    );
    // The other browser is still signed in and its handoff must still work.
    expect((await redeem(instance, { ticket: secondTicket, state: 'st-b' })).statusCode).toBe(200);
    await instance.close();
  });

  it('refuses a ticket whose session ended some other way than /logout', async () => {
    // The independent half of the fix. Sign-out invalidation cannot cover a
    // session revoked by an admin, by recovery, or simply expired — so
    // redemption re-checks liveness itself rather than trusting that every
    // path to ending a session remembered to call the invalidator.
    const instance = identityApp();
    const cookie = await signIn(instance);
    const ticket = await mint(instance, cookie, 'st');

    const sessionId = db.select().from(ssoHqTickets).all()[0]!.originSessionId;
    db.update(sessions)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();

    const res = await redeem(instance, { ticket, state: 'st' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('origin_session_ended');
    await instance.close();
  });

  it('refuses a ticket whose session has expired', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    const ticket = await mint(instance, cookie, 'st');
    const sessionId = db.select().from(ssoHqTickets).all()[0]!.originSessionId;
    db.update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();

    expect((await redeem(instance, { ticket, state: 'st' })).json().error).toBe('origin_session_ended');
    await instance.close();
  });

  it('refuses a ticket for an account deactivated after the ticket was minted', async () => {
    const instance = identityApp();
    const cookie = await signIn(instance);
    const ticket = await mint(instance, cookie, 'st');
    db.update(users).set({ active: false }).where(eq(users.id, founderUserId)).run();

    expect((await redeem(instance, { ticket, state: 'st' })).json().error).toBe('origin_session_ended');
    await instance.close();
  });

  it('does not consume a ticket it refuses, so a refusal is not a denial of service', async () => {
    // An attacker who can guess at states must not be able to burn a
    // legitimate ticket by failing to redeem it.
    const instance = identityApp();
    const ticket = await mint(instance, await signIn(instance), 'st');
    for (const state of ['no', 'nope', 'still-no']) await redeem(instance, { ticket, state });
    expect(db.select().from(ssoHqTickets).all()[0]!.consumedAt).toBeNull();
    expect((await redeem(instance, { ticket, state: 'st' })).statusCode).toBe(200);
    await instance.close();
  });

  it('still signs out normally when the bridge is not configured at all', async () => {
    // The ticket invalidation must not have made logout depend on HQ.
    const plain = buildApp({ db });
    const cookie = await signIn(plain);
    const out = await plain.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(await plain.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).toHaveProperty(
      'statusCode',
      401,
    );
    await plain.close();
  });
});

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

function identityApp(plane: SsoHqPlane = ssoPlane()) {
  return buildApp({ db, ssoHq: plane });
}

/** An HQ host whose back channel calls the real identity app, without sockets. */
async function buildHqAgainst(identity: FastifyInstance): Promise<FastifyInstance> {
  const backChannel: IdentityBackChannel = {
    async redeem(ticket, state) {
      const res = await identity.inject({
        method: 'POST',
        url: IDENTITY_ROUTES.redeem,
        headers: SERVICE_HEADERS,
        payload: { ticket, state },
      });
      return res.json();
    },
    async verifyPassword(input) {
      const res = await identity.inject({
        method: 'POST',
        url: IDENTITY_ROUTES.verifyPassword,
        headers: SERVICE_HEADERS,
        payload: input,
      });
      return res.json().result;
    },
  };
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerHqSsoRoutes(app, {
    store: new HqSessionStore(openMemoryHqDatabase()),
    backChannel,
    identityOrigin: IDENTITY_ORIGIN,
    hqOrigin: HQ_ORIGIN,
    serviceSecret: SERVICE_SECRET,
    secureCookies: false,
  });
  await app.ready();
  return app;
}
