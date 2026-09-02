/**
 * The standalone JENIFY HQ process (Phase 2, Stage 1).
 *
 * This is the Stage 1 claim, tested: HQ boots and serves in a process that
 * never loads `@factoryos/server`. It also pins the honest posture — with no
 * identity wired, the process runs and refuses, and says so at boot rather than
 * appearing broken or, worse, appearing open.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_ROUTES, type AuthenticatedAccount } from '@factoryos/headquarter/live';
import { openHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import { HeadquarterOperations, HumanPrincipalRegistry } from '@factoryos/headquarter/application';
import { registerDirectOrderCapability, DIRECT_ORDER_CAPABILITY } from '@factoryos/headquarter/live';
import type { HqIdentityPort } from '@factoryos/hq-host';
import { buildStandaloneHq } from '../src/main.js';

let workDir: string;
let dbPath: string;
let siteDir: string;

const FOUNDER: AuthenticatedAccount = {
  realmId: 'realm',
  accountId: 'acc-1',
  displayName: 'Proof Founder',
  authenticatedAt: new Date().toISOString(),
};

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'hq-standalone-'));
  dbPath = join(workDir, 'hq.sqlite');
  siteDir = join(workDir, 'site');
  // A real HQ database, created the way the product creates one.
  const db = openHqDatabase(dbPath);
  registerDirectOrderCapability(db);
  new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  new HumanPrincipalRegistry(db).register({
    id: 'founder',
    displayName: 'Proof Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  db.close();
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), '<title>HQ</title><p>canonical state</p>');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    FACTORYOS_HQ_CONTROL: '1',
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_SITE_DIR: siteDir,
    FACTORYOS_HQ_FOUNDER_MAP: JSON.stringify([
      { realmId: 'realm', accountId: 'acc-1', principalId: 'founder' },
    ]),
    FACTORYOS_HQ_ALLOWED_ORIGINS: 'https://hq.example',
    ...overrides,
  };
}

const identityFor = (account: AuthenticatedAccount | null): HqIdentityPort => ({
  forRequest: () => ({ sessions: { resolve: () => account } }),
});

describe('HQ runs as its own process', () => {
  it('boots from the environment alone, with no tenant platform', async () => {
    const built = await buildStandaloneHq({ env: env(), identity: identityFor(FOUNDER), log: () => {} });
    expect(built).not.toBeNull();
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(res.statusCode).toBe(200);
    expect(res.json().founder).toBe(true);
    await built!.close();
  });

  it('serves the Founder-gated site it was pointed at', async () => {
    const built = await buildStandaloneHq({ env: env(), identity: identityFor(FOUNDER), log: () => {} });
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('canonical state');
    await built!.close();
  });
});

describe('it stays OFF unless deliberately switched on', () => {
  it('does not start without the master switch', async () => {
    const built = await buildStandaloneHq({
      env: env({ FACTORYOS_HQ_CONTROL: undefined }),
      log: () => {},
    });
    expect(built).toBeNull();
  });

  it('does not start without a database, rather than inventing one', async () => {
    const built = await buildStandaloneHq({ env: env({ FACTORYOS_HQ_DB: undefined }), log: () => {} });
    expect(built).toBeNull();
  });
});

describe('with no identity wired it refuses, loudly and truthfully', () => {
  it('defaults to NO_IDENTITY and refuses every read', async () => {
    const built = await buildStandaloneHq({ env: env(), log: () => {} });
    await built!.app.ready();
    expect((await built!.app.inject({ method: 'GET', url: CONTROL_ROUTES.session })).statusCode).toBe(401);
    const page = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(page.statusCode).toBe(401);
    expect(page.body).not.toContain('canonical state');
    await built!.close();
  });

  it('says at boot that it is not a hosted HQ', async () => {
    // The product rule from issue #227: a deployment that cannot really do the
    // thing must SAY so rather than look functional.
    const lines: string[] = [];
    const built = await buildStandaloneHq({ env: env(), log: (line) => lines.push(line) });
    await built!.close();
    const banner = lines.join('\n');
    expect(banner).toContain('NO IDENTITY SOURCE');
    expect(banner).toContain('It is NOT a hosted HQ');
  });
});

describe('the A-4 sign-in bridge, wired from the environment', () => {
  const BRIDGE = {
    HQ_SSO_IDENTITY_ORIGIN: 'https://app.example',
    HQ_SSO_HQ_ORIGIN: 'https://hq.example',
    HQ_SSO_SERVICE_SECRET: 'dev-test-secret',
    HQ_SSO_INSECURE_COOKIES: '1',
  };

  it('stays OFF when only part of it is configured, and says so', async () => {
    const lines: string[] = [];
    const built = await buildStandaloneHq({
      env: env({ HQ_SSO_IDENTITY_ORIGIN: 'https://app.example' }),
      log: (line) => lines.push(line),
    });
    await built!.app.ready();
    // Half-configured is OFF, not half-open: still refuses rather than redirects.
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(401);
    expect(lines.join('\n')).toContain('only PARTLY configured');
    await built!.close();
  });

  it('sends an unauthenticated visitor to the identity host instead of a 401', async () => {
    const built = await buildStandaloneHq({ env: env(BRIDGE), log: () => {} });
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(302);
    const target = new URL(res.headers.location as string);
    expect(target.origin).toBe('https://app.example');
    expect(target.pathname).toBe('/api/sso/hq/authorize');
    // The callback it asks to be returned to is on THIS host, absolutely stated.
    expect(target.searchParams.get('redirect_uri')).toBe('https://hq.example/sso/callback');
    expect(target.searchParams.get('state')).toBeTruthy();
    await built!.close();
  });

  it('binds the round trip to a host-only state cookie', async () => {
    const built = await buildStandaloneHq({ env: env(BRIDGE), log: () => {} });
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    const state = res.cookies.find((c) => c.name === 'hq_sso_state');
    expect(state).toBeTruthy();
    expect(state).not.toHaveProperty('domain');
    expect(state!.httpOnly).toBe(true);
    // The redirect's state matches the cookie it just set.
    expect(new URL(res.headers.location as string).searchParams.get('state')).toBe(state!.value);
    await built!.close();
  });

  it('exposes the bridge routes only when the bridge is on', async () => {
    const off = await buildStandaloneHq({ env: env(), log: () => {} });
    await off!.app.ready();
    expect((await off!.app.inject({ method: 'GET', url: '/sso/callback' })).statusCode).toBe(404);
    await off!.close();

    const on = await buildStandaloneHq({ env: env(BRIDGE), log: () => {} });
    await on!.app.ready();
    // Present, and refusing — there is no ticket and no state.
    expect((await on!.app.inject({ method: 'GET', url: '/sso/callback' })).statusCode).toBe(400);
    await on!.close();
  });
});

/* ------------------------------------------------------------------ */
/* Issue #237, Codex P1-4 — the back channel may not be cleartext      */
/* ------------------------------------------------------------------ */

describe('the bridge refuses a cleartext back channel', () => {
  const SAFE = {
    HQ_SSO_IDENTITY_ORIGIN: 'https://app.example',
    HQ_SSO_HQ_ORIGIN: 'https://hq.example',
    HQ_SSO_SERVICE_SECRET: 'dev-test-secret',
    HQ_SSO_INSECURE_COOKIES: '1',
  };

  /** Configured and refused ⇒ the process still boots, and still refuses everyone. */
  async function bridgeIsOff(overrides: Record<string, string>): Promise<string> {
    const lines: string[] = [];
    const built = await buildStandaloneHq({
      env: env({ ...SAFE, ...overrides }),
      log: (line) => lines.push(line),
    });
    await built!.app.ready();
    // No handoff is started: an unauthenticated visitor is refused, not
    // redirected at an origin that cannot safely carry the credential.
    expect((await built!.app.inject({ method: 'GET', url: '/hq/index.html' })).statusCode).toBe(401);
    expect((await built!.app.inject({ method: 'GET', url: '/sso/callback' })).statusCode).toBe(404);
    await built!.close();
    return lines.join('\n');
  }

  it('REFUSES the finding: a plaintext non-loopback identity origin', async () => {
    // The exact configuration Codex flagged: the service credential and the
    // Founder's relayed step-up password would have crossed the network in
    // the clear, with nothing in the boot log to distinguish it.
    const log = await bridgeIsOff({ HQ_SSO_IDENTITY_ORIGIN: 'http://app.jenifylabs.com' });
    expect(log).toContain('HQ_SSO_IDENTITY_ORIGIN');
    expect(log).toContain('in the clear');
  });

  it('refuses a plaintext HQ origin too — sign-out is posted there with the secret', async () => {
    const log = await bridgeIsOff({ HQ_SSO_HQ_ORIGIN: 'http://hq.jenifylabs.com' });
    expect(log).toContain('HQ_SSO_HQ_ORIGIN');
  });

  it('refuses a host that only looks like loopback', async () => {
    for (const origin of [
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'http://localhost@evil.example',
    ]) {
      expect(await bridgeIsOff({ HQ_SSO_IDENTITY_ORIGIN: origin }), origin).toContain('refused');
    }
  });

  it('still allows a genuine loopback proof stack over plain http', async () => {
    const built = await buildStandaloneHq({
      env: env({
        ...SAFE,
        HQ_SSO_IDENTITY_ORIGIN: 'http://127.0.0.1:3001',
        HQ_SSO_HQ_ORIGIN: 'http://localhost:3200',
      }),
      log: () => {},
    });
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).origin).toBe('http://127.0.0.1:3001');
    await built!.close();
  });

  it('keeps HTTPS working exactly as before', async () => {
    const built = await buildStandaloneHq({ env: env(SAFE), log: () => {} });
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).origin).toBe('https://app.example');
    await built!.close();
  });

  /**
   * Third correction round, Codex P2 — a path-mounted origin.
   *
   * `httpBackChannel` appended routes to the configured origin, so a prefix
   * survived there; `beginHandoff` resolved the same routes against the origin's
   * ROOT, so the prefix vanished from the browser redirect and from the
   * `redirect_uri` that the identity host allow-lists. One value, two
   * destinations, and a handoff that could not complete. Path mounting is not a
   * requirement of A-4, so it is refused at boot rather than half supported.
   */
  it('REFUSES a path-mounted identity or HQ origin, at boot', async () => {
    const cases: Record<string, string>[] = [
      { HQ_SSO_IDENTITY_ORIGIN: 'https://app.example/identity' },
      { HQ_SSO_HQ_ORIGIN: 'https://hq.example/hq' },
      // Deceptive spellings: the route would be appended AFTER the query or the
      // fragment, producing an address that reads like the real one.
      { HQ_SSO_IDENTITY_ORIGIN: 'https://app.example?/api/sso/hq/authorize' },
      { HQ_SSO_IDENTITY_ORIGIN: 'https://app.example#https://evil.example' },
    ];
    for (const overrides of cases) {
      const log = await bridgeIsOff(overrides);
      expect(log, JSON.stringify(overrides)).toContain('no path, query or fragment');
      expect(log, JSON.stringify(overrides)).toContain('fail closed');
    }
  });

  it('sends the browser to the route of the configured origin, root and all', async () => {
    // With prefixes refused upstream, the two channels agree by construction:
    // the redirect lands on the identity host's authorize route, and the
    // redirect_uri is exactly this host's callback.
    const built = await buildStandaloneHq({ env: env(SAFE), log: () => {} });
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    const target = new URL(res.headers.location as string);
    expect(target.pathname).toBe('/api/sso/hq/authorize');
    expect(target.searchParams.get('redirect_uri')).toBe('https://hq.example/sso/callback');
    await built!.close();
  });
});

/* ------------------------------------------------------------------ */
/* Issue #237, Codex P1-3 — the shipped HQ process really hands off     */
/* ------------------------------------------------------------------ */

describe('the shipped HQ process completes a handoff over a real socket', () => {
  /**
   * The HQ half of the "two real entrypoints" proof.
   *
   * This process cannot import `@factoryos/server` — that boundary is the whole
   * point of Stage 1 and is asserted in `package-boundary.test.ts` — so the
   * identity host here is a stand-in that speaks the same contract, reached
   * over a real loopback socket by the real `httpBackChannel` that
   * `buildStandaloneHq` wires from the environment. The identity side of the
   * same seam is proved against the real `packages/server` composition in
   * `packages/server/test/sso-hq-wiring.test.ts`.
   */
  it('redeems a ticket through the environment-wired back channel and mints a session', async () => {
    const redeemed: { ticket: string; state: string }[] = [];
    const identity = Fastify({ logger: false });
    identity.post('/api/sso/hq/redeem', async (req) => {
      const body = req.body as { ticket: string; state: string };
      redeemed.push(body);
      // The stand-in enforces the same binding the real identity host does.
      if (body.state !== 'round-trip') return { ok: false, error: 'state_mismatch' };
      return {
        ok: true,
        claims: {
          realmId: 'realm',
          accountId: 'acc-1',
          displayName: 'Proof Founder',
          sessionEstablishedAt: new Date().toISOString(),
          originSessionId: 'identity-session-1',
        },
      };
    });
    await identity.listen({ port: 0, host: '127.0.0.1' });
    const address = identity.server.address();
    if (address == null || typeof address === 'string') throw new Error('no port');
    const identityOrigin = `http://127.0.0.1:${address.port}`;

    const built = await buildStandaloneHq({
      env: env({
        HQ_SSO_IDENTITY_ORIGIN: identityOrigin,
        HQ_SSO_HQ_ORIGIN: 'http://localhost:3200',
        HQ_SSO_SERVICE_SECRET: 'dev-test-secret',
        HQ_SSO_INSECURE_COOKIES: '1',
      }),
      log: () => {},
    });
    await built!.app.ready();

    const callback = await built!.app.inject({
      method: 'GET',
      url: '/sso/callback?ticket=t-1&state=round-trip',
      cookies: { hq_sso_state: 'round-trip' },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.cookies.find((c) => c.name === 'hq_session')).toBeTruthy();
    // The state travelled with the ticket (P1-1), on the real wire.
    expect(redeemed).toEqual([{ ticket: 't-1', state: 'round-trip' }]);

    // And the site it refused a moment ago now answers for this browser.
    const session = callback.cookies.find((c) => c.name === 'hq_session')!.value;
    const page = await built!.app.inject({
      method: 'GET',
      url: '/hq/index.html',
      cookies: { hq_session: session },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('canonical state');

    await built!.close();
    await identity.close();
  });
});
