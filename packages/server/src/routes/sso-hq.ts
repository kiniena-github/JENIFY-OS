/**
 * The identity host's HQ sign-in bridge routes
 * (Phase 2, Stage 2; Founder Gate A decided A-4 on 2026-09-02).
 *
 * Opt-in exactly like the HQ control plane: `buildApp` registers these only
 * when handed an explicit plane, so an ordinary JENIFY OS deployment — the
 * Mesob pilot included — has none of them and gains no new surface.
 *
 * One browser-facing route and two back-channel routes:
 *
 *   GET  /api/sso/hq/authorize        needs THIS server's session; mints a ticket
 *   POST /api/sso/hq/redeem           service-authenticated; consumes it once,
 *                                     for the matching state, while the origin
 *                                     session is still live
 *   POST /api/sso/hq/verify-password  service-authenticated; step-up, shared budget
 *
 * The two back-channel routes are useless to a browser: they demand a service
 * secret that no page ever holds, and they are refused without it before any
 * other work happens.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { SESSION_COOKIE } from '../app.js';
import { resolveSessionRecord } from '../services/auth.js';
import {
  mintTicket,
  redeemTicket,
  redirectUriAllowed,
  serviceSecretMatches,
  verifyStepUpPassword,
  type HqLogoutNotifier,
} from '../services/sso-hq.js';

/** Header the back channel carries its service secret in. */
export const SSO_SERVICE_AUTH_HEADER = 'x-jenify-sso-service';

export const SSO_HQ_ROUTES = {
  authorize: '/api/sso/hq/authorize',
  redeem: '/api/sso/hq/redeem',
  verifyPassword: '/api/sso/hq/verify-password',
} as const;

/**
 * Everything a deployment must decide deliberately before the bridge exists.
 *
 * No defaults anywhere. An empty `allowedRedirectUris` bridges nowhere, and an
 * empty `serviceSecret` refuses every back-channel call.
 */
export interface SsoHqPlane {
  /** The HQ origin a ticket may be redeemed for, e.g. https://hq.jenifylabs.com */
  audience: string;
  /** EXACT callback URLs that may receive a ticket. No prefixes, no wildcards. */
  allowedRedirectUris: readonly string[];
  /** Shared secret for the back channel. Dev/test value only, per Founder gate. */
  serviceSecret: string;
  /** Told when a session ends, so HQ can revoke what it derived (trap C). */
  logoutNotifier?: HqLogoutNotifier;
  audit?: (line: string) => void;
}

export function registerSsoHqRoutes(app: FastifyInstance, db: Db, plane: SsoHqPlane): void {
  const audit = plane.audit ?? (() => {});

  /**
   * Start a handoff.
   *
   * Requires this server's OWN session — the whole security of A-4 rests on
   * this line. Everything downstream trusts that a ticket was minted only for
   * an account this server had already authenticated.
   */
  app.get(SSO_HQ_ROUTES.authorize, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    // A ticket ends up in the redirect URL, so never leak this page's URL
    // onward as a referrer.
    reply.header('referrer-policy', 'same-origin');

    const query = req.query as Record<string, unknown>;
    const redirectUri = typeof query.redirect_uri === 'string' ? query.redirect_uri : '';
    const state = typeof query.state === 'string' ? query.state : '';

    // Validate the redirect BEFORE looking at the session, so an unauthenticated
    // prober cannot use this endpoint to discover whether a URL is allow-listed
    // by comparing responses, and so a bad redirect is never followed.
    if (!redirectUri || !redirectUriAllowed(redirectUri, plane.allowedRedirectUris)) {
      audit(`[sso] authorize refused: redirect_uri not allow-listed`);
      return reply
        .status(400)
        .type('text/plain; charset=utf-8')
        .send('This sign-in link is not configured for HQ. Nothing was sent.');
    }
    if (!state) {
      return reply
        .status(400)
        .type('text/plain; charset=utf-8')
        .send('This sign-in link is missing its state value. Open HQ again to retry.');
    }

    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? resolveSessionRecord(db, token) : null;
    if (!session) {
      // Deliberately NOT a redirect into a login flow yet: this server's login
      // screen has no return-to concept, so inventing one here would be a UI
      // change smuggled into an auth change. Say the true thing instead.
      audit('[sso] authorize refused: no identity session');
      return reply
        .status(401)
        .type('text/plain; charset=utf-8')
        .send(
          'Sign in to Jenify first, then open HQ again. HQ has no sign-in of its own — it uses ' +
            'your existing Jenify account.',
        );
    }

    const ticket = mintTicket(db, {
      session,
      audience: plane.audience,
      redirectUri,
      state,
    });
    audit(`[sso] ticket minted for ${session.user.tenantId}/${session.user.id}`);

    const target = new URL(redirectUri);
    target.searchParams.set('ticket', ticket);
    target.searchParams.set('state', state);
    return reply.status(302).redirect(target.toString());
  });

  /** Back channel: exchange a ticket for claims, exactly once. */
  app.post(SSO_HQ_ROUTES.redeem, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!serviceSecretMatches(req.headers[SSO_SERVICE_AUTH_HEADER], plane.serviceSecret)) {
      audit('[sso] redeem refused: bad service credential');
      return reply.status(401).send({ ok: false, error: 'service_unauthenticated' });
    }
    const body = req.body as Record<string, unknown> | undefined;
    const ticket = typeof body?.ticket === 'string' ? body.ticket : '';
    // The callback state, forwarded by HQ. Absent ⇒ the empty string ⇒
    // `state_mismatch`, because a redeem that cannot name the round trip it
    // belongs to is refused rather than trusted (trap D).
    const state = typeof body?.state === 'string' ? body.state : '';
    const outcome = redeemTicket(db, ticket, plane.audience, state);
    if (!outcome.ok) {
      audit(`[sso] redeem refused: ${outcome.error}`);
      return reply.status(400).send(outcome);
    }
    audit(`[sso] ticket redeemed for ${outcome.claims.realmId}/${outcome.claims.accountId}`);
    return reply.status(200).send(outcome);
  });

  /** Back channel: step-up password check on the shared sign-in budget. */
  app.post(SSO_HQ_ROUTES.verifyPassword, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!serviceSecretMatches(req.headers[SSO_SERVICE_AUTH_HEADER], plane.serviceSecret)) {
      audit('[sso] verify-password refused: bad service credential');
      return reply.status(401).send({ ok: false, error: 'service_unauthenticated' });
    }
    const body = req.body as Record<string, unknown> | undefined;
    const realmId = typeof body?.realmId === 'string' ? body.realmId : '';
    const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const clientIp = typeof body?.clientIp === 'string' ? body.clientIp : '';
    const result = verifyStepUpPassword(db, { realmId, accountId, password, clientIp });
    // The outcome is audited; the password is not, was not stored, and is not
    // echoed. `rejected` and `rate_limited` stay distinct because collapsing
    // them would hide an attack in progress.
    audit(`[sso] verify-password ${result} for ${realmId}/${accountId}`);
    return reply.status(200).send({ result });
  });
}

/**
 * Tell HQ that an identity session has ended (trap C).
 *
 * Called from the logout route. Never throws and never blocks sign-out: if HQ
 * cannot be reached the local logout still succeeds, the failure is audited,
 * and the HQ session's own 60-minute ceiling remains the backstop.
 */
export async function propagateLogoutToHq(
  notifier: HqLogoutNotifier | undefined,
  originSessionId: string | null,
  audit: (line: string) => void = () => {},
): Promise<void> {
  if (!notifier || !originSessionId) return;
  const result = await notifier.revokeSessionsFor(originSessionId);
  audit(
    result.ok
      ? `[sso] HQ sessions revoked for identity session ${originSessionId}`
      : `[sso] WARNING: could not revoke HQ sessions for ${originSessionId} (${result.detail}). ` +
          'They remain valid until their own expiry.',
  );
}
