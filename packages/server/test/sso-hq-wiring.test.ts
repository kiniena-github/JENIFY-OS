/**
 * The shipped identity process actually carries the bridge (issue #237, Codex P1-3).
 *
 * ## The finding
 *
 * `buildApp` accepted an `ssoHq` plane, `apps/hq-server` called the identity
 * endpoints, and `packages/server/src/index.ts` — the process a real deployment
 * runs — never built one. A repository search found the plane supplied only by
 * tests. So the two shipped processes could not complete a handoff however they
 * were configured: HQ would redirect to `/api/sso/hq/authorize` and get a 404.
 *
 * ## Why this suite is written against `composeAppOptions`
 *
 * Because that is what `index.ts` now calls, and asserting a test's own
 * hand-built options is exactly what let the gap through the first time. The
 * entrypoint keeps only what cannot be tested — opening the default database
 * and listening on a port — so everything below is the real composition path.
 *
 * Three things are proved:
 *
 *   1. absent by default    an ordinary deployment has no bridge and no route
 *   2. refused when unsafe  partial, or plaintext to a public host ⇒ still OFF
 *   3. real when configured a full handoff completes through the composed app
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { buildApp } from '../src/app.js';
import { composeAppOptions } from '../src/compose.js';
import { loadSsoHqPlane } from '../src/services/sso-hq-host.js';
import { createUser } from '../src/services/users.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
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

/** A complete, safe bridge configuration — the only shape that switches it on. */
function bridgeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    FACTORYOS_SSO_HQ: '1',
    FACTORYOS_SSO_HQ_AUDIENCE: HQ_ORIGIN,
    FACTORYOS_SSO_HQ_REDIRECT_URIS: HQ_CALLBACK,
    FACTORYOS_SSO_HQ_SERVICE_SECRET: SERVICE_SECRET,
    ...overrides,
  };
}

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

/* ------------------------------------------------------------------ */
/* 1. Absent by default                                                */
/* ------------------------------------------------------------------ */

describe('the bridge is absent unless a deployment asks for it', () => {
  it('composes no bridge from an empty environment', () => {
    const composed = composeAppOptions(db, {}, () => {});
    expect(composed.options.ssoHq).toBeUndefined();
    expect(composed.options.headquarter).toBeUndefined();
  });

  it('serves no /api/sso/hq/* route at all in that default shape', async () => {
    const app = buildApp(composeAppOptions(db, {}, () => {}).options);
    for (const url of [
      `${IDENTITY_ROUTES.authorize}?redirect_uri=x&state=y`,
      IDENTITY_ROUTES.redeem,
      IDENTITY_ROUTES.verifyPassword,
    ]) {
      const res = await app.inject({ method: url.includes('authorize') ? 'GET' : 'POST', url });
      expect(res.statusCode, url).toBe(404);
    }
    // And the ordinary platform is untouched.
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('stays off when the values are set but the master switch is not', () => {
    const lines: string[] = [];
    const plane = loadSsoHqPlane(bridgeEnv({ FACTORYOS_SSO_HQ: undefined }), (l) => lines.push(l));
    expect(plane).toBeNull();
    expect(lines.join('\n')).toContain('stays OFF');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Refused when the configuration is partial or unsafe              */
/* ------------------------------------------------------------------ */

describe('an incomplete or unsafe configuration stays OFF, not half-open', () => {
  it('refuses a partial configuration and says which values are required', () => {
    for (const missing of [
      'FACTORYOS_SSO_HQ_AUDIENCE',
      'FACTORYOS_SSO_HQ_REDIRECT_URIS',
      'FACTORYOS_SSO_HQ_SERVICE_SECRET',
    ]) {
      const lines: string[] = [];
      const plane = loadSsoHqPlane(bridgeEnv({ [missing]: undefined }), (l) => lines.push(l));
      expect(plane, missing).toBeNull();
      expect(lines.join('\n')).toContain('PARTLY configured');
    }
  });

  it('refuses a plaintext audience — sign-out carries the service secret there', () => {
    const lines: string[] = [];
    const plane = loadSsoHqPlane(
      bridgeEnv({
        FACTORYOS_SSO_HQ_AUDIENCE: 'http://hq.jenifylabs.com',
        FACTORYOS_SSO_HQ_REDIRECT_URIS: 'http://hq.jenifylabs.com/sso/callback',
      }),
      (l) => lines.push(l),
    );
    expect(plane).toBeNull();
    expect(lines.join('\n')).toContain('in the clear');
  });

  it('refuses a plaintext redirect URI — a ticket rides in that URL', () => {
    const lines: string[] = [];
    const plane = loadSsoHqPlane(
      bridgeEnv({ FACTORYOS_SSO_HQ_REDIRECT_URIS: `${HQ_CALLBACK},http://hq.evil.example/sso/callback` }),
      (l) => lines.push(l),
    );
    expect(plane).toBeNull();
    expect(lines.join('\n')).toContain('FACTORYOS_SSO_HQ_REDIRECT_URIS');
  });

  it('allows a loopback proof stack over plain http', () => {
    const plane = loadSsoHqPlane(
      bridgeEnv({
        FACTORYOS_SSO_HQ_AUDIENCE: 'http://127.0.0.1:3200',
        FACTORYOS_SSO_HQ_REDIRECT_URIS: 'http://127.0.0.1:3200/sso/callback',
      }),
      () => {},
    );
    expect(plane).not.toBeNull();
    expect(plane!.audience).toBe('http://127.0.0.1:3200');
  });

  it('refuses a PATH-MOUNTED audience, and says why (third round, Codex P2)', () => {
    // The audience is an origin the back-channel route is appended to. A prefix
    // here was honoured on that channel and dropped by HQ's browser redirect, so
    // one configured value named two different addresses and the handoff could
    // not complete. Refused at boot instead.
    for (const audience of [
      'https://hq.jenifylabs.com/hq',
      'https://hq.jenifylabs.com/hq/',
      'https://hq.jenifylabs.com?next=https://evil.example',
      'https://hq.jenifylabs.com#/hq',
    ]) {
      const lines: string[] = [];
      const plane = loadSsoHqPlane(
        bridgeEnv({ FACTORYOS_SSO_HQ_AUDIENCE: audience }),
        (l) => lines.push(l),
      );
      expect(plane, audience).toBeNull();
      expect(lines.join('\n'), audience).toContain('FACTORYOS_SSO_HQ_AUDIENCE');
      expect(lines.join('\n'), audience).toContain('no path, query or fragment');
    }
  });

  it('still accepts a redirect URI that carries a path, because it is a whole URL', () => {
    // The other half of the same decision: an ORIGIN may not carry a path, and a
    // callback URL must. Applying one rule to both would refuse every correct
    // configuration.
    const plane = loadSsoHqPlane(bridgeEnv(), () => {});
    expect(plane).not.toBeNull();
    expect(plane!.allowedRedirectUris).toEqual([HQ_CALLBACK]);
    expect(HQ_CALLBACK).toContain('/sso/callback');
  });

  it('never invents a redirect allow-list from the audience', () => {
    // Exact URLs only. An audience is not permission to redirect anywhere
    // under it — that is how open redirects are built.
    const plane = loadSsoHqPlane(bridgeEnv(), () => {})!;
    expect(plane.allowedRedirectUris).toEqual([HQ_CALLBACK]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Real when configured: the composed app completes a handoff        */
/* ------------------------------------------------------------------ */

describe('the composed shipped app can really complete a handoff', () => {
  it('mints, redeems and lands an HQ session — the flow that used to 404', async () => {
    // The identity half, built exactly as `src/index.ts` builds it.
    const identity = buildApp(composeAppOptions(db, bridgeEnv(), () => {}).options);
    await identity.ready();

    // The HQ half, on its own origin, talking to that app over the same
    // contract `httpBackChannel` puts on the wire.
    const store = new HqSessionStore(openMemoryHqDatabase());
    const hq = Fastify({ logger: false });
    await hq.register(fastifyCookie);
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
    registerHqSsoRoutes(hq, {
      store,
      backChannel,
      identityOrigin: 'https://app.example',
      hqOrigin: HQ_ORIGIN,
      serviceSecret: SERVICE_SECRET,
      secureCookies: false,
    });
    await hq.ready();

    // 1. The Founder is signed in at the identity host.
    const login = await identity.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'founder.salta', password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = `fos_session=${login.cookies.find((c) => c.name === 'fos_session')!.value}`;

    // 2. HQ sends them to authorize. This is the request that used to 404.
    const authorize = await identity.inject({
      method: 'GET',
      url: `${IDENTITY_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=st`,
      headers: { cookie },
    });
    expect(authorize.statusCode, 'the shipped composition must serve authorize').toBe(302);
    const ticket = new URL(authorize.headers.location as string).searchParams.get('ticket')!;

    // 3. The callback redeems over the back channel and mints HQ's OWN session.
    const callback = await hq.inject({
      method: 'GET',
      url: `${HQ_ROUTES.callback}?ticket=${ticket}&state=st`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'st' },
    });
    expect(callback.statusCode).toBe(302);
    const hqToken = callback.cookies.find((c) => c.name === HQ_SESSION_COOKIE)!.value;
    const record = store.resolve(hqToken)!;
    expect(record.accountId).toBe(founderUserId);
    // The identity cookie never crossed origins; HQ holds only what it derived.
    expect(hqToken).not.toBe(cookie);

    await hq.close();
    await identity.close();
  });

  it('carries a working logout notifier rather than leaving trap C unwired', () => {
    // The shipped composition must build a real notifier; the previous shape
    // left `logoutNotifier` undefined outside tests, so an identity sign-out
    // told HQ nothing.
    const plane = loadSsoHqPlane(bridgeEnv(), () => {})!;
    expect(plane.logoutNotifier).toBeDefined();
    expect(typeof plane.logoutNotifier!.revokeSessionsFor).toBe('function');
  });

  it('is composed independently of the HQ control plane', () => {
    // This server is the IDENTITY half. The HQ it vouches for normally runs in
    // a separate process on its own origin, so the bridge must not require
    // FACTORYOS_HQ_CONTROL on this host.
    const composed = composeAppOptions(db, bridgeEnv(), () => {});
    expect(composed.options.ssoHq).toBeDefined();
    expect(composed.options.headquarter).toBeUndefined();
  });
});
