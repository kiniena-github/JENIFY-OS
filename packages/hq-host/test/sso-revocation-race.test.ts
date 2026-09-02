/**
 * TRAP F — the post-redemption logout race (Phase 2, Stage 2, second Codex
 * correction round).
 *
 * ## The finding, exactly as it was reported
 *
 * Redemption can succeed just before `/api/auth/logout`, while HQ has not yet
 * executed `store.create`. The identity host has consumed the ticket, so
 * invalidating unconsumed tickets finds nothing; HQ's back-channel logout
 * revokes zero rows because the derived HQ session does not exist yet; and then
 * the callback returns from its await and creates a fresh 60-minute HQ session
 * AFTER the sign-out that was supposed to end it.
 *
 * Trap C (revoke what HQ derived) and trap E (kill unconsumed tickets) both miss
 * it, because at the instant each one ran there was nothing to act on.
 *
 * ## How this suite makes the race deterministic
 *
 * Not with timers, and not with two racing promises — either would be flaky and
 * neither would prove anything on a fast machine. The back channel used here
 * performs the sign-out ITSELF, inside `redeem`, at exactly the instant the real
 * race requires: after the ticket is consumed and before `create` runs. That is
 * the interleaving the finding describes, reproduced by construction, so this
 * test fails deterministically against the old code and passes deterministically
 * against the fix.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { openMemoryHqDatabase } from '@factoryos/headquarter/store';
import {
  HQ_SESSION_COOKIE,
  HQ_SSO_STATE_COOKIE,
  HqSessionStore,
  registerHqSsoRoutes,
  SSO_HQ_ROUTES,
  SSO_SERVICE_AUTH_HEADER,
  type HqSsoClaims,
  type IdentityBackChannel,
} from '../src/index.js';

const SERVICE_SECRET = 'race-test-service-secret';
const HQ_ORIGIN = 'https://hq.example';
const ORIGIN_SESSION = 'identity-session-racing';

let store: HqSessionStore;
const audit: string[] = [];

beforeEach(() => {
  store = new HqSessionStore(openMemoryHqDatabase());
  audit.length = 0;
});

function claims(originSessionId = ORIGIN_SESSION): HqSsoClaims {
  return {
    realmId: 'realm',
    accountId: 'acc-1',
    displayName: 'Proof Founder',
    sessionEstablishedAt: new Date(Date.now() - 3600_000).toISOString(),
    originSessionId,
  };
}

async function buildHq(backChannel: IdentityBackChannel): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerHqSsoRoutes(app, {
    store,
    backChannel,
    identityOrigin: 'https://app.example',
    hqOrigin: HQ_ORIGIN,
    serviceSecret: SERVICE_SECRET,
    secureCookies: false,
    audit: (line) => audit.push(line),
  });
  await app.ready();
  return app;
}

/** Walk a browser through the callback with a matching state cookie. */
function callback(app: FastifyInstance, state = 'st') {
  return app.inject({
    method: 'GET',
    url: `${SSO_HQ_ROUTES.callback}?ticket=opaque-ticket&state=${state}`,
    cookies: { [HQ_SSO_STATE_COOKIE]: state },
  });
}

describe('a sign-out landing between redeem and create wins (trap F)', () => {
  it('refuses to create a session for an identity session revoked mid-handoff', async () => {
    let hq: FastifyInstance;
    // The sign-out happens here: the ticket is consumed, the claims are on their
    // way back, and the human hits "sign out" before HQ has inserted anything.
    const backChannel: IdentityBackChannel = {
      async redeem() {
        const res = await hq!.inject({
          method: 'POST',
          url: SSO_HQ_ROUTES.backchannelLogout,
          headers: { [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
          payload: { originSessionId: ORIGIN_SESSION },
        });
        // Zero rows revoked — that is the whole point. The old code read this as
        // "nothing to do" and carried on to mint a session anyway.
        expect(res.json()).toEqual({ ok: true, revoked: 0 });
        return { ok: true, claims: claims() };
      },
      async verifyPassword() {
        return 'ok';
      },
    };
    hq = await buildHq(backChannel);

    const res = await callback(hq);

    expect(res.statusCode, 'a handoff whose sign-in already ended must not complete').toBe(401);
    const cookie = res.cookies.find((c) => c.name === HQ_SESSION_COOKIE);
    // Either no cookie at all, or an explicit clear — never a live token.
    expect(cookie?.value ?? '').toBe('');
    expect(audit.join('\n')).toContain('origin_session_revoked');
    await hq.close();
  });

  it('leaves NO session row behind, so nothing can resolve afterwards', async () => {
    let hq: FastifyInstance;
    let mintedToken: string | undefined;
    const backChannel: IdentityBackChannel = {
      async redeem() {
        await hq!.inject({
          method: 'POST',
          url: SSO_HQ_ROUTES.backchannelLogout,
          headers: { [SSO_SERVICE_AUTH_HEADER]: SERVICE_SECRET },
          payload: { originSessionId: ORIGIN_SESSION },
        });
        return { ok: true, claims: claims() };
      },
      async verifyPassword() {
        return 'ok';
      },
    };
    hq = await buildHq(backChannel);
    const res = await callback(hq);
    mintedToken = res.cookies.find((c) => c.name === HQ_SESSION_COOKIE)?.value;

    expect(store.resolve(mintedToken)).toBeNull();
    // And the direct store call is refused too, so the guarantee does not depend
    // on the route remembering to check.
    expect(store.create(claims())).toEqual({ ok: false, reason: 'origin_session_revoked' });
    await hq.close();
  });

  it('records the tombstone even when there was nothing yet to revoke', () => {
    expect(store.revokeByOriginSession(ORIGIN_SESSION)).toBe(0);
    expect(store.isOriginSessionRevoked(ORIGIN_SESSION)).toBe(true);
  });

  it('still revokes an ALREADY-created session, the case trap C always covered', () => {
    const created = store.create(claims());
    expect(created.ok).toBe(true);
    const token = created.ok ? created.token : '';
    expect(store.resolve(token)).not.toBeNull();

    expect(store.revokeByOriginSession(ORIGIN_SESSION)).toBe(1);
    expect(store.resolve(token)).toBeNull();
  });

  it('is idempotent: a second revocation of the same session revokes nothing new', () => {
    store.create(claims());
    expect(store.revokeByOriginSession(ORIGIN_SESSION)).toBe(1);
    expect(store.revokeByOriginSession(ORIGIN_SESSION)).toBe(0);
    expect(store.isOriginSessionRevoked(ORIGIN_SESSION)).toBe(true);
  });

  it('never blocks the NEXT sign-in, which is a different identity session', async () => {
    // The tombstone is keyed on the identity session id, so signing in again —
    // a new session, a new id — is unaffected. A fix that blocked the account
    // would have locked the Founder out of HQ after every sign-out.
    store.revokeByOriginSession(ORIGIN_SESSION);
    const hq = await buildHq({
      async redeem() {
        return { ok: true, claims: claims('identity-session-2') };
      },
      async verifyPassword() {
        return 'ok';
      },
    });
    const res = await callback(hq);
    expect(res.statusCode).toBe(302);
    const token = res.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!.value;
    expect(store.resolve(token)?.originSessionId).toBe('identity-session-2');
    await hq.close();
  });

  it('keeps the tombstone table bounded rather than growing per sign-out forever', () => {
    const old = new Date(Date.now() - 25 * 3600_000);
    store.revokeByOriginSession('ancient-session', old);
    expect(store.isOriginSessionRevoked('ancient-session')).toBe(true);
    // Housekeeping runs on the path that adds rows, so a later revocation
    // clears one that can no longer protect anything (a ticket lives 60s).
    store.revokeByOriginSession('recent-session');
    expect(store.isOriginSessionRevoked('ancient-session')).toBe(false);
    expect(store.isOriginSessionRevoked('recent-session')).toBe(true);
  });

  it('adds no credential-shaped column to HQ — the tombstone is an id and a time', () => {
    // The standing rule the whole A-4 option exists to protect: HQ holds
    // revocable session state and NEVER credentials. A new table is exactly
    // where that could erode, so it is checked here as well as on hq_sessions.
    const db = openMemoryHqDatabase();
    new HqSessionStore(db);
    const columns = (
      db.prepare('PRAGMA table_info(hq_revoked_origin_sessions)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns.sort()).toEqual(['origin_session_id', 'revoked_at']);
    for (const column of columns) {
      expect(/pass|secret|credential|token/i.test(column), `suspicious column ${column}`).toBe(
        false,
      );
    }
    db.close();
  });

  it('an ordinary handoff with no sign-out still works exactly as before', async () => {
    const hq = await buildHq({
      async redeem() {
        return { ok: true, claims: claims() };
      },
      async verifyPassword() {
        return 'ok';
      },
    });
    const res = await callback(hq);
    expect(res.statusCode).toBe(302);
    const token = res.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!.value;
    expect(store.resolve(token)?.accountId).toBe('acc-1');
    await hq.close();
  });
});
