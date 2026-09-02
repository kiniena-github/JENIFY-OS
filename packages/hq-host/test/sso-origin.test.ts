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
  backChannelUrl,
  beginHandoff,
  checkBackChannelOrigin,
  checkBackChannelUrl,
  describeBackChannelOriginRefusal,
  isLoopbackHostname,
  httpBackChannel,
  registerHqSsoRoutes,
  HqSessionStore,
  HQ_SESSION_COOKIE,
  HQ_SSO_STATE_COOKIE,
  SSO_HQ_ROUTES,
  SSO_IDENTITY_ROUTES,
  type IdentityBackChannel,
} from '../src/index.js';
import { openMemoryHqDatabase } from '@factoryos/headquarter/store';

describe('a back channel may not be cleartext to anywhere but loopback', () => {
  it('accepts https to any host', () => {
    for (const origin of [
      'https://app.jenifylabs.com',
      'https://app.example:8443',
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

  it('canonicalises an accepted origin and drops trailing slashes', () => {
    // A narrowing, never a widening: only spellings of the SAME origin collapse.
    expect(checkBackChannelOrigin('https://app.example/')).toEqual({
      ok: true,
      origin: 'https://app.example',
    });
    expect(checkBackChannelOrigin('  https://app.example  ')).toEqual({
      ok: true,
      origin: 'https://app.example',
    });
    expect(checkBackChannelOrigin('http://127.1:3001')).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:3001',
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

/**
 * Third correction round, Codex P2: a configured origin must mean ONE thing.
 *
 * The back channel built its URL by concatenation, so a path prefix survived;
 * the browser redirect used `new URL(route, origin)` against a route constant
 * that starts with `/`, so the same prefix was silently dropped. One configured
 * value, two destinations — and the `redirect_uri` HQ then sent matched no
 * allow-list entry, so the handoff could not complete at all.
 *
 * Path mounting is not a requirement of A-4, so the ambiguity is refused rather
 * than supported twice: an ORIGIN may not carry a path, a query or a fragment,
 * and it is refused at boot with a message that says why.
 */
describe('a configured ORIGIN is an origin, not a mount point', () => {
  it('REFUSES a path-mounted identity or HQ origin', () => {
    for (const origin of [
      'https://app.example/identity',
      'https://app.example/identity/',
      'https://hq.example/hq',
      'http://127.0.0.1:3001/identity',
    ]) {
      expect(checkBackChannelOrigin(origin), origin).toEqual({
        ok: false,
        reason: 'path_mounted_origin',
      });
    }
    // A bare root is NOT a path: it is the ordinary spelling of an origin.
    expect(checkBackChannelOrigin('https://app.example/').ok).toBe(true);
  });

  it('REFUSES a query or a fragment, which are the deceptive spellings', () => {
    for (const origin of [
      'https://app.example?next=https://evil.example',
      'https://app.example#https://evil.example',
      'https://app.example/?x=1',
      // The route would be appended AFTER the query, producing an address that
      // reads as the real one and is not.
      'https://app.example?/api/sso/hq/authorize',
    ]) {
      expect(checkBackChannelOrigin(origin), origin).toEqual({
        ok: false,
        reason: 'path_mounted_origin',
      });
    }
  });

  it('still refuses cleartext and userinfo before it looks at the path', () => {
    // Order matters: the transport verdict is the more urgent one to report.
    expect(checkBackChannelOrigin('http://app.example/identity')).toEqual({
      ok: false,
      reason: 'plaintext_not_loopback',
    });
    expect(checkBackChannelOrigin('http://localhost@evil.example/x')).toEqual({
      ok: false,
      reason: 'credentials_in_url',
    });
  });

  it('explains the refusal in a line an operator can act on', () => {
    const line = describeBackChannelOriginRefusal(
      'HQ_SSO_IDENTITY_ORIGIN',
      'https://app.example/identity',
      'path_mounted_origin',
    );
    expect(line).toContain('HQ_SSO_IDENTITY_ORIGIN');
    expect(line).toMatch(/no path, query or fragment/);
    expect(line).toContain('fail closed');
  });

  it('the back channel refuses to be BUILT on a path-mounted origin', () => {
    // Enforced at construction as well as in the loaders, exactly like the
    // cleartext rule: a loader can be bypassed by a future caller.
    expect(() =>
      httpBackChannel({ baseUrl: 'https://app.example/identity', serviceSecret: 's' }),
    ).toThrow(/no path, query or fragment/);
  });

  it('a redirect URI is a whole URL, so a path is still allowed there', () => {
    // The other half of the design: `checkBackChannelUrl` keeps the transport
    // rules for values that are complete addresses, and returns them unedited
    // because the allow-list is matched byte for byte.
    expect(checkBackChannelUrl('https://hq.example/sso/callback')).toEqual({
      ok: true,
      url: 'https://hq.example/sso/callback',
    });
    expect(checkBackChannelUrl('http://127.0.0.1:3200/sso/callback').ok).toBe(true);
    expect(checkBackChannelUrl('http://hq.example/sso/callback')).toEqual({
      ok: false,
      reason: 'plaintext_not_loopback',
    });
    expect(checkBackChannelUrl('https://user:pw@hq.example/sso/callback')).toEqual({
      ok: false,
      reason: 'credentials_in_url',
    });
  });
});

describe('both channels build their URLs the same way', () => {
  function fakeReply() {
    const cookies: Record<string, string> = {};
    return {
      cookies,
      setCookie(name: string, value: string) {
        cookies[name] = value;
        return this;
      },
    };
  }

  it('sends the browser to the authorize route of the configured origin', () => {
    const reply = fakeReply();
    const target = new URL(
      beginHandoff(
        {
          identityOrigin: 'https://app.example',
          hqOrigin: 'https://hq.example',
        } as never,
        reply as never,
        '/hq/',
      ),
    );
    expect(target.origin).toBe('https://app.example');
    expect(target.pathname).toBe(SSO_IDENTITY_ROUTES.authorize);
    // The redirect_uri must be exactly what the identity host allow-lists.
    expect(target.searchParams.get('redirect_uri')).toBe(
      `https://hq.example${SSO_HQ_ROUTES.callback}`,
    );
    expect(target.searchParams.get('state')).toBe(reply.cookies[HQ_SSO_STATE_COOKIE]);
  });

  it('joins an origin and a route identically for the browser and the back channel', async () => {
    const seen: string[] = [];
    const channel = httpBackChannel({
      baseUrl: 'https://app.example',
      serviceSecret: 's',
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ ok: false, error: 'ticket_unknown' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    await channel.redeem('t', 's');

    const reply = fakeReply();
    const browserTarget = new URL(
      beginHandoff(
        { identityOrigin: 'https://app.example', hqOrigin: 'https://hq.example' } as never,
        reply as never,
        '/hq/',
      ),
    );

    // Same origin, same joining rule, whichever channel is speaking.
    expect(seen).toEqual([backChannelUrl('https://app.example', SSO_IDENTITY_ROUTES.redeem)]);
    expect(`${browserTarget.origin}${browserTarget.pathname}`).toBe(
      backChannelUrl('https://app.example', SSO_IDENTITY_ROUTES.authorize),
    );
  });
});
