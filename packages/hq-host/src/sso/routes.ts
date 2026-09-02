/**
 * HQ's side of the A-4 handoff (Phase 2, Stage 2).
 *
 * Three routes, and none of them can authenticate anybody by itself:
 *
 *   GET  /sso/callback                 redeem a ticket, mint an HQ session
 *   POST /sso/logout                   revoke THIS browser's HQ session
 *   POST /api/sso/hq/backchannel-logout  revoke every session from one origin
 *
 * ## The callback is the only place a session is created
 *
 * It accepts nothing from the browser except an opaque ticket and a `state`,
 * and it trusts neither: `state` must match a cookie this host set moments ago
 * on the same browser (CSRF / session-fixation on the callback), and the ticket
 * is exchanged over the back channel, where the identity host consumes it once
 * and answers with claims the browser never saw and cannot influence.
 *
 * The state is then sent ON to the identity host with the ticket (trap D in
 * `contract.ts`). The cookie check alone proves only that SOME sign-in started
 * in this browser — an attacker's own browser satisfies it trivially — so it
 * cannot, by itself, stop a captured ticket being replayed elsewhere. Only the
 * identity host holds the state the ticket was minted with.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// Side-effect import for the module augmentation only: it is what puts
// `setCookie`/`clearCookie` on FastifyReply and `cookies` on FastifyRequest.
// The plugin itself is registered by the HOST, not here — the cookie layer
// belongs to whoever owns the app, and @factoryos/server already has one.
import '@fastify/cookie';
import {
  HQ_SESSION_COOKIE,
  HQ_SESSION_TTL_MS,
  HQ_SSO_STATE_COOKIE,
  SSO_HQ_ROUTES,
  SSO_IDENTITY_ROUTES,
  SSO_SERVICE_AUTH_HEADER,
} from './contract.js';
import type { IdentityBackChannel } from './back-channel.js';
import type { HqSessionStore } from './session-store.js';

export interface HqSsoOptions {
  store: HqSessionStore;
  backChannel: IdentityBackChannel;
  /** Public origin of the identity host, e.g. https://app.jenifylabs.com */
  identityOrigin: string;
  /** This host's own public origin, e.g. https://hq.jenifylabs.com */
  hqOrigin: string;
  /** Shared service secret, for authenticating the identity host's calls IN. */
  serviceSecret: string;
  /**
   * Whether cookies carry `Secure`. Defaults to true; a loopback proof stack
   * over plain http sets it false, exactly as the tenant server already does
   * for private hosts.
   */
  secureCookies?: boolean;
  audit?: (line: string) => void;
}

/**
 * Reduce a caller-influenced "come back to" value to a SAFE local path.
 *
 * `startsWith('/')` is not enough, and that is worth stating plainly because it
 * is the obvious-looking check and it is wrong: `//evil.example/x` starts with
 * a slash and a browser reads it as a protocol-relative ABSOLUTE url, so it is
 * an open redirect. Backslashes are excluded for the same reason — several
 * browsers normalise `\` to `/`, making `/\evil.example` equivalent to `//`.
 *
 * The value reaching here is written by this host into a host-only cookie, so
 * it should already be trustworthy; this is the belt to that braces. An open
 * redirect on the sign-in path is precisely the primitive used to make a
 * phishing link look legitimate.
 */
export function safeReturnPath(candidate: unknown, fallback = '/hq/'): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//')) return fallback;
  if (candidate.includes('\\')) return fallback;
  return candidate;
}

/** Constant-time comparison that also refuses on a length mismatch. */
function secretMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieOptions(secure: boolean, maxAgeSeconds?: number) {
  return {
    // No `domain`: the cookie is HOST-ONLY, which is the entire point of A-4.
    // The main jenifylabs.com session is never widened, and this one never
    // leaves hq.jenifylabs.com.
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    ...(maxAgeSeconds == null ? {} : { maxAge: maxAgeSeconds }),
  };
}

/**
 * Build the redirect that starts a handoff, and set the state cookie that binds
 * it to this browser.
 *
 * `redirect_uri` is this host's own callback, stated absolutely, so the
 * identity host can check it against its exact allow-list.
 */
export function beginHandoff(
  options: HqSsoOptions,
  reply: FastifyReply,
  returnPath: string,
): string {
  const state = randomBytes(24).toString('base64url');
  reply.setCookie(HQ_SSO_STATE_COOKIE, state, cookieOptions(options.secureCookies ?? true, 600));
  const url = new URL(SSO_IDENTITY_ROUTES.authorize, options.identityOrigin);
  url.searchParams.set('redirect_uri', new URL(SSO_HQ_ROUTES.callback, options.hqOrigin).toString());
  url.searchParams.set('state', state);
  // Where to land afterwards, kept on THIS host's cookie rather than trusted
  // from the identity host's echo. A path only — never an absolute URL — so it
  // can never become an open redirect.
  reply.setCookie(
    'hq_sso_return',
    safeReturnPath(returnPath),
    cookieOptions(options.secureCookies ?? true, 600),
  );
  return url.toString();
}

export function registerHqSsoRoutes(app: FastifyInstance, options: HqSsoOptions): void {
  const secure = options.secureCookies ?? true;
  const audit = options.audit ?? (() => {});

  app.get(SSO_HQ_ROUTES.callback, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    // A ticket in a query string can reach a log or a referrer, so the page we
    // render never echoes it and the redirect away from it is immediate.
    reply.header('referrer-policy', 'same-origin');

    const query = req.query as Record<string, unknown>;
    const ticket = typeof query.ticket === 'string' ? query.ticket : '';
    const state = typeof query.state === 'string' ? query.state : '';
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> })
      .cookies;
    const expectedState = cookies?.[HQ_SSO_STATE_COOKIE];

    // The state cookie is single-use whatever happens next.
    reply.clearCookie(HQ_SSO_STATE_COOKIE, cookieOptions(secure));

    if (!ticket || !state || !expectedState || !secretMatches(state, expectedState)) {
      audit('[hq-sso] callback refused: state mismatch or missing ticket');
      return reply.status(400).type('text/plain; charset=utf-8').send(
        'HQ sign-in could not be completed: this link did not come from a sign-in started here. ' +
          'Open HQ again to retry.',
      );
    }

    // TRAP D. The state goes WITH the ticket, so the identity host can check
    // that this ticket belongs to this round trip. The check just above proves
    // the state is one this host issued to this browser; only the identity host
    // can prove it is the one the ticket was minted for, because only it holds
    // the ticket row. A ticket captured out of a URL and replayed from another
    // browser therefore fails there even though it passes here.
    const redeemed = await options.backChannel.redeem(ticket, state);
    if (!redeemed.ok) {
      audit(`[hq-sso] callback refused: redeem ${redeemed.error}`);
      const status = redeemed.error === 'unavailable' ? 503 : 400;
      return reply
        .status(status)
        .type('text/plain; charset=utf-8')
        .send(`HQ sign-in could not be completed (${redeemed.error}). Open HQ again to retry.`);
    }

    const { token, record } = options.store.create(redeemed.claims);
    reply.setCookie(
      HQ_SESSION_COOKIE,
      token,
      cookieOptions(secure, Math.floor(HQ_SESSION_TTL_MS / 1000)),
    );
    audit(
      `[hq-sso] session minted for ${record.realmId}/${record.accountId} ` +
        `(signed in at ${record.sessionEstablishedAt}, handoff at ${record.createdAt})`,
    );

    const returnTo = cookies?.hq_sso_return;
    reply.clearCookie('hq_sso_return', cookieOptions(secure));
    return reply.redirect(safeReturnPath(returnTo));
  });

  app.post(SSO_HQ_ROUTES.logout, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> })
      .cookies;
    options.store.revoke(cookies?.[HQ_SESSION_COOKIE]);
    reply.clearCookie(HQ_SESSION_COOKIE, cookieOptions(secure));
    audit('[hq-sso] HQ session revoked by sign-out');
    return reply.status(200).send({ ok: true });
  });

  /**
   * The identity host telling us somebody signed out (trap C).
   *
   * Service-authenticated, because it revokes other people's sessions. It
   * deliberately reports success even when nothing matched: whether a given
   * identity session had ever reached HQ is not something an unauthenticated
   * prober should be able to learn, and the caller has nothing to do
   * differently either way.
   */
  app.post(SSO_HQ_ROUTES.backchannelLogout, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!secretMatches(req.headers[SSO_SERVICE_AUTH_HEADER], options.serviceSecret)) {
      audit('[hq-sso] back-channel logout refused: bad service credential');
      return reply.status(401).send({ ok: false, error: { code: 'service_unauthenticated' } });
    }
    const body = req.body as Record<string, unknown> | undefined;
    const originSessionId = typeof body?.originSessionId === 'string' ? body.originSessionId : '';
    if (!originSessionId) {
      return reply.status(400).send({ ok: false, error: { code: 'origin_session_required' } });
    }
    const revoked = options.store.revokeByOriginSession(originSessionId);
    audit(`[hq-sso] back-channel logout revoked ${revoked} HQ session(s)`);
    return reply.status(200).send({ ok: true, revoked });
  });
}
