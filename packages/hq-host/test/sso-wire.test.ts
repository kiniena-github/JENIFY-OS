/**
 * The back channel over real sockets (Phase 2, Stage 2).
 *
 * `sso-hq.test.ts` stubs the identity host, which is right for asserting HQ's
 * behaviour but proves nothing about the HTTP client itself. This suite runs
 * `httpBackChannel` against a real listening server, because the parts most
 * likely to be quietly wrong live exactly there: whether the service secret
 * actually reaches the wire as a header rather than a query parameter, whether
 * an unparseable answer is treated as `unavailable` instead of success, and
 * whether a dead host times out into a refusal rather than hanging.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { httpBackChannel, SSO_SERVICE_AUTH_HEADER } from '../src/index.js';

const SECRET = 'wire-test-secret';
let servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/** Start a stand-in identity host and return its base URL. */
async function listen(configure: (app: FastifyInstance) => void): Promise<string> {
  const app = Fastify({ logger: false });
  configure(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(app);
  const address = app.server.address();
  if (address == null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('httpBackChannel talks to a real identity host', () => {
  it('sends the service secret as a header, never in the URL', async () => {
    const seen: { header?: string; url?: string }[] = [];
    const base = await listen((app) => {
      app.post('/api/sso/hq/redeem', async (req) => {
        seen.push({
          header: req.headers[SSO_SERVICE_AUTH_HEADER] as string | undefined,
          url: req.url,
        });
        return {
          ok: true,
          claims: {
            realmId: 'realm',
            accountId: 'acc-1',
            displayName: 'Founder',
            sessionEstablishedAt: '2026-09-02T10:00:00.000Z',
            originSessionId: 'sess-1',
          },
        };
      });
    });

    const channel = httpBackChannel({ baseUrl: base, serviceSecret: SECRET });
    const result = await channel.redeem('ticket-1');

    expect(result.ok).toBe(true);
    expect(seen[0]!.header).toBe(SECRET);
    // A secret in a query string lands in access logs and referrers.
    expect(seen[0]!.url).not.toContain(SECRET);
  });

  it('carries the claims back intact, including the original sign-in time', async () => {
    const base = await listen((app) => {
      app.post('/api/sso/hq/redeem', async () => ({
        ok: true,
        claims: {
          realmId: 'realm',
          accountId: 'acc-1',
          displayName: 'Founder',
          sessionEstablishedAt: '2026-09-02T08:15:00.000Z',
          originSessionId: 'sess-9',
        },
      }));
    });
    const result = await httpBackChannel({ baseUrl: base, serviceSecret: SECRET }).redeem('t');
    expect(result.ok && result.claims.sessionEstablishedAt).toBe('2026-09-02T08:15:00.000Z');
    expect(result.ok && result.claims.originSessionId).toBe('sess-9');
  });

  it('reports an unreachable host as unavailable, never as a rejection', async () => {
    // Port 1 on loopback: nothing listens there.
    const channel = httpBackChannel({
      baseUrl: 'http://127.0.0.1:1',
      serviceSecret: SECRET,
      timeoutMs: 500,
    });
    expect(await channel.redeem('t')).toEqual({ ok: false, error: 'unavailable' });
    expect(await channel.verifyPassword({
      realmId: 'r',
      accountId: 'a',
      password: 'p',
      clientIp: '198.51.100.1',
    })).toBe('unavailable');
  });

  it('treats an unrecognised password answer as unavailable, never as ok', async () => {
    const base = await listen((app) => {
      // A host that answers nonsense must not be able to wave step-up through.
      app.post('/api/sso/hq/verify-password', async () => ({ result: 'sure-why-not' }));
    });
    const channel = httpBackChannel({ baseUrl: base, serviceSecret: SECRET });
    expect(
      await channel.verifyPassword({
        realmId: 'r',
        accountId: 'a',
        password: 'p',
        clientIp: '198.51.100.1',
      }),
    ).toBe('unavailable');
  });

  it('relays the three real password verdicts unchanged', async () => {
    for (const verdict of ['ok', 'rejected', 'rate_limited'] as const) {
      const base = await listen((app) => {
        app.post('/api/sso/hq/verify-password', async () => ({ result: verdict }));
      });
      const channel = httpBackChannel({ baseUrl: base, serviceSecret: SECRET });
      expect(
        await channel.verifyPassword({
          realmId: 'r',
          accountId: 'a',
          password: 'p',
          clientIp: '198.51.100.1',
        }),
      ).toBe(verdict);
    }
  });

  it('forwards the browser address in the body (TRAP B, on the wire)', async () => {
    const seen: string[] = [];
    const base = await listen((app) => {
      app.post('/api/sso/hq/verify-password', async (req) => {
        seen.push((req.body as { clientIp: string }).clientIp);
        return { result: 'ok' };
      });
    });
    await httpBackChannel({ baseUrl: base, serviceSecret: SECRET }).verifyPassword({
      realmId: 'r',
      accountId: 'a',
      password: 'p',
      clientIp: '203.0.113.44',
    });
    expect(seen).toEqual(['203.0.113.44']);
  });

  it('never puts the password in the URL', async () => {
    const urls: string[] = [];
    const base = await listen((app) => {
      app.post('/api/sso/hq/verify-password', async (req) => {
        urls.push(req.url);
        return { result: 'ok' };
      });
    });
    await httpBackChannel({ baseUrl: base, serviceSecret: SECRET }).verifyPassword({
      realmId: 'r',
      accountId: 'a',
      password: 'sup3r-s3cret',
      clientIp: '198.51.100.1',
    });
    expect(urls[0]).not.toContain('sup3r-s3cret');
  });
});
