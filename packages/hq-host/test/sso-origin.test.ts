/**
 * What may carry a back-channel credential, and what HQ sends with a ticket
 * (issue #237, Codex P1-4 and P1-1).
 *
 * P1-4: `HQ_SSO_IDENTITY_ORIGIN` accepted `http://` to any host, so a
 * deployment could ship the service secret and the Founder's step-up password
 * in cleartext with nothing to signal it. The rule is asserted here against the
 * spellings an attacker would actually try, not only against the happy path.
 *
 * P1-1: HQ's callback must send the state ON with the ticket. HQ cannot itself
 * detect a stolen ticket — its cookie check is satisfied by the attacker's own
 * browser — so the only thing it can get wrong is failing to hand the identity
 * host what that host needs to detect it.
 */

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import {
  checkBackChannelOrigin,
  isLoopbackHostname,
  httpBackChannel,
  registerHqSsoRoutes,
  HqSessionStore,
  HQ_SESSION_COOKIE,
  HQ_SSO_STATE_COOKIE,
  SSO_HQ_ROUTES,
  type IdentityBackChannel,
} from '../src/index.js';
import { openMemoryHqDatabase } from '@factoryos/headquarter/store';

describe('a back channel may not be cleartext to anywhere but loopback', () => {
  it('accepts https to any host', () => {
    for (const origin of [
      'https://app.jenifylabs.com',
      'https://app.example:8443',
      'https://app.example/identity',
      'https://127.0.0.1:3001',
    ]) {
      expect(checkBackChannelOrigin(origin), origin).toEqual({ ok: true, origin });
    }
  });

  it('accepts plaintext ONLY to a real loopback address', () => {
    for (const origin of [
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://127.0.0.1',
      'http://127.5.6.7:3001',
      'http://[::1]:3001',
      'http://[0:0:0:0:0:0:0:1]:3001',
      'http://127.1',
      'http://LOCALHOST:3001',
    ]) {
      expect(checkBackChannelOrigin(origin).ok, origin).toBe(true);
    }
  });

  it('REFUSES the finding: plaintext to a public host', () => {
    // The exact configuration Codex flagged. The service credential and a
    // relayed human password would have gone out in the clear.
    const result = checkBackChannelOrigin('http://app.jenifylabs.com');
    expect(result).toEqual({ ok: false, reason: 'plaintext_not_loopback' });
  });

  it('refuses hosts that only LOOK like loopback', () => {
    for (const origin of [
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'http://evil.example/localhost',
      'http://evil.example#localhost',
      'http://evil.example?host=127.0.0.1',
      'http://notlocalhost',
      'http://localhost-evil.example',
      // RFC 6761 reserves *.localhost for loopback, but resolving it is a
      // system-configuration question rather than a guarantee — and a wrong
      // answer here puts a credential on the network. Fail closed.
      'http://hq.localhost:3001',
      // "Any address" is not loopback.
      'http://0.0.0.0:3001',
      // Private, but still a network a credential would cross in the clear.
      'http://192.168.1.10:3001',
      'http://10.0.0.5:3001',
      'http://[fe80::1]:3001',
    ]) {
      expect(checkBackChannelOrigin(origin).ok, origin).toBe(false);
    }
  });

  it('refuses userinfo, which is how a loopback-looking URL points elsewhere', () => {
    // `new URL('http://localhost@evil.example').hostname` is `evil.example`.
    expect(checkBackChannelOrigin('http://localhost@evil.example')).toEqual({
      ok: false,
      reason: 'credentials_in_url',
    });
    // Refused on https too: a credential in a URL is logged by every proxy.
    expect(checkBackChannelOrigin('https://svc:secret@app.example')).toEqual({
      ok: false,
      reason: 'credentials_in_url',
    });
  });

  it('refuses schemes that are not an HTTP back channel at all', () => {
    for (const origin of ['ws://app.example', 'file:///etc/passwd', 'ftp://app.example']) {
      expect(checkBackChannelOrigin(origin)).toEqual({ ok: false, reason: 'scheme_not_supported' });
    }
  });

  it('refuses anything it cannot parse, rather than guessing', () => {
    for (const origin of ['', '   ', 'app.example', '//app.example', 'https://', 'http://']) {
      expect(checkBackChannelOrigin(origin).ok, JSON.stringify(origin)).toBe(false);
    }
  });

  it('returns the origin unchanged except for trailing slashes', () => {
    // A validator that silently rewrote a configured value would be its own
    // hazard — a path-mounted identity host must keep working.
    expect(checkBackChannelOrigin('https://app.example/identity/')).toEqual({
      ok: true,
      origin: 'https://app.example/identity',
    });
  });

  it('classifies loopback hostnames by address, not by name', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('[::ffff:7f00:1]')).toBe(true); // ::ffff:127.0.0.1
    expect(isLoopbackHostname('[::ffff:c0a8:1]')).toBe(false); // ::ffff:192.168.0.1
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('128.0.0.1')).toBe(false);
    expect(isLoopbackHostname('127.0.0.999')).toBe(false);
  });
});

describe('the back channel refuses to be built on a cleartext transport', () => {
  it('throws rather than quietly shipping the secret in the clear', () => {
    // Enforced at construction, not only in the environment loaders: a loader
    // can be bypassed by a future caller, a constructor cannot.
    expect(() => httpBackChannel({ baseUrl: 'http://app.example', serviceSecret: 's' })).toThrow(
      /in the clear/,
    );
  });

  it('still builds for https and for a loopback proof stack', () => {
    expect(() => httpBackChannel({ baseUrl: 'https://app.example', serviceSecret: 's' })).not.toThrow();
    expect(() =>
      httpBackChannel({ baseUrl: 'http://127.0.0.1:3001', serviceSecret: 's' }),
    ).not.toThrow();
  });
});

describe('HQ sends the state on with the ticket (P1-1, HQ half)', () => {
  it('forwards the exact state that matched this browser\'s cookie', async () => {
    const seen: { ticket: string; state: string }[] = [];
    const backChannel: IdentityBackChannel = {
      async redeem(ticket, state) {
        seen.push({ ticket, state });
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
      },
      async verifyPassword() {
        return 'ok';
      },
    };

    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerHqSsoRoutes(app, {
      store: new HqSessionStore(openMemoryHqDatabase()),
      backChannel,
      identityOrigin: 'https://app.example',
      hqOrigin: 'https://hq.example',
      serviceSecret: 'dev-test-service-secret-value',
      secureCookies: false,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?ticket=t-1&state=round-trip-state`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'round-trip-state' },
    });
    expect(res.statusCode).toBe(302);
    expect(seen).toEqual([{ ticket: 't-1', state: 'round-trip-state' }]);
    await app.close();
  });

  it('never reaches the back channel at all when the cookie does not match', async () => {
    let called = false;
    const backChannel: IdentityBackChannel = {
      async redeem() {
        called = true;
        return { ok: false, error: 'ticket_unknown' };
      },
      async verifyPassword() {
        return 'ok';
      },
    };
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerHqSsoRoutes(app, {
      store: new HqSessionStore(openMemoryHqDatabase()),
      backChannel,
      identityOrigin: 'https://app.example',
      hqOrigin: 'https://hq.example',
      serviceSecret: 'dev-test-service-secret-value',
      secureCookies: false,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.callback}?ticket=t-1&state=attacker-state`,
      cookies: { [HQ_SSO_STATE_COOKIE]: 'this-browsers-state' },
    });
    expect(res.statusCode).toBe(400);
    expect(called, 'a mismatched state must not even be sent onward').toBe(false);
    expect(res.cookies.find((c) => c.name === HQ_SESSION_COOKIE)).toBeUndefined();
    await app.close();
  });
});
