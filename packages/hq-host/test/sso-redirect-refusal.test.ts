/**
 * A credential-bearing back-channel call never follows a redirect
 * (Phase 2, Stage 2, second Codex correction round).
 *
 * ## The finding
 *
 * `checkBackChannelOrigin` validates the URL this client CHOOSES to call.
 * `fetch` then follows redirects by default, and the redirect target is chosen
 * by the responder — so a 307 or 308 answer would have the client repeat the
 * request at a URL nothing validated, with the method, body and headers
 * preserved (RFC 7231 §6.4.7). Those headers carry the shared service secret,
 * and on the step-up path that body carries the Founder's password. A single
 * `Location: http://attacker.example/` would have posted both, in the clear, to
 * whoever wrote it.
 *
 * ## What is asserted
 *
 * Two live servers on loopback: a stand-in identity host that only redirects,
 * and a "somewhere else" that records everything it receives. For every redirect
 * status a POST can carry — 301, 302, 303, 307, 308 — the second server must see
 * NOTHING, and the call must fail closed as `unavailable` rather than as a
 * password rejection.
 *
 * 307 and 308 are the dangerous pair (method, body and headers survive), but 301
 * and 302 are included deliberately: browsers and clients historically rewrite
 * those to GET, which drops the body but NOT the headers — the service secret
 * would still have travelled. And 303 is included because "it always becomes a
 * GET" is exactly the reasoning that would justify allowing it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { httpBackChannel, SSO_IDENTITY_ROUTES, SSO_SERVICE_AUTH_HEADER } from '../src/index.js';

const SECRET = 'redirect-test-service-secret';
const PASSWORD = 'the-founder-step-up-password';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

let servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function listen(configure: (app: FastifyInstance) => void): Promise<string> {
  const app = Fastify({ logger: false });
  configure(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(app);
  const address = app.server.address();
  if (address == null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/** Everything the "somewhere else" host managed to capture. Must stay empty. */
interface Captured {
  url: string;
  secret: string | undefined;
  body: unknown;
}

async function elsewhere(captured: Captured[]): Promise<string> {
  return listen((app) => {
    app.all('/*', async (req) => {
      captured.push({
        url: req.url,
        secret: req.headers[SSO_SERVICE_AUTH_HEADER] as string | undefined,
        body: req.body,
      });
      // Answer plausibly, so a client that DID follow would look like it worked
      // — the test must fail loudly on a forward, not quietly on a parse error.
      return { ok: true, result: 'ok', claims: null };
    });
  });
}

describe('the back channel refuses every redirect rather than replaying credentials', () => {
  for (const status of REDIRECT_STATUSES) {
    it(`refuses a ${status} on redeem and forwards the secret nowhere`, async () => {
      const captured: Captured[] = [];
      const attacker = await elsewhere(captured);
      const identity = await listen((app) => {
        app.post(SSO_IDENTITY_ROUTES.redeem, async (_req, reply) =>
          reply.status(status).header('location', `${attacker}${SSO_IDENTITY_ROUTES.redeem}`).send(),
        );
      });

      const result = await httpBackChannel({
        baseUrl: identity,
        serviceSecret: SECRET,
        timeoutMs: 2_000,
      }).redeem('ticket-1', 'state-1');

      // Fail CLOSED: no claims, and honestly reported as "could not ask".
      expect(result).toEqual({ ok: false, error: 'unavailable' });
      expect(captured, `a ${status} must not carry the service secret onward`).toEqual([]);
    });

    it(`refuses a ${status} on verify-password and leaks neither secret nor password`, async () => {
      const captured: Captured[] = [];
      const attacker = await elsewhere(captured);
      const identity = await listen((app) => {
        app.post(SSO_IDENTITY_ROUTES.verifyPassword, async (_req, reply) =>
          reply
            .status(status)
            .header('location', `${attacker}${SSO_IDENTITY_ROUTES.verifyPassword}`)
            .send(),
        );
      });

      const result = await httpBackChannel({
        baseUrl: identity,
        serviceSecret: SECRET,
        timeoutMs: 2_000,
      }).verifyPassword({
        realmId: 'realm',
        accountId: 'acc-1',
        password: PASSWORD,
        clientIp: '203.0.113.44',
      });

      // `unavailable`, never `rejected`: nobody is told a correct password was
      // wrong because of a misconfigured redirect, and never `ok` either.
      expect(result).toBe('unavailable');
      expect(captured).toEqual([]);
      expect(JSON.stringify(captured)).not.toContain(PASSWORD);
    });
  }

  it('refuses a redirect that stays on the SAME validated origin', async () => {
    // The origin is not the point — the second request is. A path-level redirect
    // on the identity host itself (a proxy adding a trailing slash, say) is
    // still a request this code never decided to make, so it is refused too,
    // and the operator sees a plain failure instead of a silent second send.
    const identity = await listen((app) => {
      app.post(SSO_IDENTITY_ROUTES.redeem, async (_req, reply) =>
        reply.status(308).header('location', `${SSO_IDENTITY_ROUTES.redeem}/`).send(),
      );
      app.post(`${SSO_IDENTITY_ROUTES.redeem}/`, async () => ({ ok: true, claims: {} }));
    });
    const result = await httpBackChannel({
      baseUrl: identity,
      serviceSecret: SECRET,
      timeoutMs: 2_000,
    }).redeem('t', 's');
    expect(result).toEqual({ ok: false, error: 'unavailable' });
  });

  it('still completes an ordinary non-redirected call', async () => {
    // The refusal must not be "everything fails now".
    const identity = await listen((app) => {
      app.post(SSO_IDENTITY_ROUTES.redeem, async () => ({
        ok: true,
        claims: {
          realmId: 'realm',
          accountId: 'acc-1',
          displayName: 'Founder',
          sessionEstablishedAt: '2026-09-02T10:00:00.000Z',
          originSessionId: 'sess-1',
        },
      }));
    });
    const result = await httpBackChannel({ baseUrl: identity, serviceSecret: SECRET }).redeem(
      't',
      's',
    );
    expect(result.ok).toBe(true);
  });
});
