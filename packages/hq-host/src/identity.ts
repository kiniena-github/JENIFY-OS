/**
 * How a host answers "who is making this request" (Phase 2, Stage 1).
 *
 * ## Why identity is a parameter here and not an implementation
 *
 * HQ has no sign-in of its own. It never has: `live/auth.ts` resolves a
 * principal only from facts a host resolved server-side, and the control API
 * tells an unauthenticated caller, in those words, to *"Sign in to JENIFY OS
 * first. HQ has no sign-in of its own."*
 *
 * That is a recorded Founder decision (2026-08-28): Headquarter grows no second
 * password system. So this package — HQ's own HTTP host — deliberately does not
 * implement identity. It takes one in.
 *
 * Today exactly one implementation exists, in `@factoryos/server`, over the
 * `fos_session` cookie. That is why `packages/server` still owns the session and
 * credential adapters after this split: they are inseparable from that server's
 * auth tables, and moving them here would have made this package depend on the
 * whole tenant platform — the opposite of the point.
 *
 * ## Founder Gate A lives exactly here
 *
 * A browser sends `fos_session` only to the host that set it, and the cookie is
 * issued with no `Domain` attribute (`sessionCookieOptions` has no such field at
 * all). So an HQ served from a DIFFERENT origin — `hq.jenifylabs.com` — receives
 * no session and resolves nobody. That is not a bug to code around; it is the
 * open Founder decision about identity and origin, and this seam is where its
 * answer will be plugged in. Until then `NO_IDENTITY` is the honest default.
 */

import type { FastifyRequest } from 'fastify';
import type { CredentialVerifierPort, SessionResolverPort } from '@factoryos/headquarter/live';

/**
 * The ports for ONE request.
 *
 * They are built per request, never once at startup, because the session
 * resolver is contractually required to re-check expiry and revocation every
 * time. A host that hoisted these would keep a revoked session alive and
 * nothing downstream would notice.
 */
export interface HqRequestIdentity {
  sessions: SessionResolverPort;
  /**
   * Step-up password verification. Optional: a host without one can serve
   * reads. Its ABSENCE must never become a passed step-up — the control API
   * fails closed on that, and `host-port-contract.test.ts` pins it.
   */
  credentials?: CredentialVerifierPort;
}

export interface HqIdentityPort {
  forRequest(request: FastifyRequest): HqRequestIdentity;
}

/**
 * The honest default: nobody is signed in, ever.
 *
 * A host with no identity source resolves no Founder, so every read is refused
 * 401 and every control stays off. That is the correct posture for a standalone
 * HQ process before Founder Gate A, and it is deliberately not a "local trust"
 * or "dev bypass" mode — HQ has never had one, and adding one here would be a
 * second authority path built in the dark.
 */
export const NO_IDENTITY: HqIdentityPort = {
  forRequest() {
    return { sessions: { resolve: () => null } };
  },
};
