/**
 * The JENIFY identity → HQ handoff contract (Phase 2, Stage 2; Founder Gate A
 * decided A-4 on 2026-09-02).
 *
 * ## The shape of A-4
 *
 * One Jenify account system. One password store, in the identity host. HQ gets
 * its OWN host-only session cookie, minted after the identity host vouches for
 * the Founder exactly once:
 *
 *   browser → hq.jenifylabs.com          no hq_session
 *   HQ      → app.jenifylabs.com/authorize?redirect_uri&state   (302)
 *   identity: requires its own session, mints a single-use ticket, 302 back
 *   HQ      → identity /redeem  (BACK CHANNEL, service-authenticated)
 *   identity: consumes the ticket once, returns the claims below
 *   HQ      : mints hq_session, host-only, no Domain attribute
 *
 * The main `fos_session` cookie is never widened to `.jenifylabs.com` and never
 * reaches HQ. HQ never sees a password.
 *
 * ## The three traps this contract is shaped to avoid
 *
 * **A — authentication freshness.** `verifyStepUp` waives the password for a
 * session under five minutes old. If HQ stamped its session with the HANDOFF
 * time, anyone holding a stolen `fos_session` could trigger a handoff and mint
 * apparent freshness, silently skipping step-up on irreversible approvals. So
 * the claims carry `sessionEstablishedAt` — the ORIGINAL sign-in instant — and
 * HQ propagates it verbatim into `AuthenticatedAccount.authenticatedAt`. The
 * handoff time is recorded separately as the HQ session's own `createdAt`, and
 * is never used for freshness.
 *
 * **B — rate limiting.** Step-up password checks share the sign-in failure
 * budget (`ip|login|<username>`), which took two Codex correction rounds to get
 * right. Across a network boundary the identity host would otherwise see HQ's
 * own address for every Founder, collapsing every account into one bucket. So
 * the verify request carries the BROWSER's address explicitly, and the identity
 * host keys on that.
 *
 * **C — logout.** A separate cookie does not die when the main session does.
 * The claims therefore carry `originSessionId`, and the identity host calls
 * HQ's back-channel logout on sign-out to revoke every HQ session derived from
 * it.
 *
 * ## Two more the first Codex review of this branch found
 *
 * **D — a ticket must be bound to its own round trip.** HQ's callback checks
 * `state` against a cookie, which stops a callback that did not start here —
 * but the first draft then redeemed the ticket ALONE. A ticket is carried in a
 * URL, so it can be captured (history, a proxy log, a referrer, a shoulder);
 * captured, it could be replayed into an ATTACKER's browser, whose own state
 * cookie legitimately matched their own callback, and the identity host had
 * nothing left to object to. The redeem call therefore carries the callback
 * `state` too, and the identity host compares it to the state stored WITH the
 * ticket before consuming it. HQ's cookie check now proves "this browser
 * started a sign-in"; the identity host's check proves "and it is THIS one".
 *
 * **E — a ticket must not outlive its session.** Sign out between authorize and
 * redeem and there is no derived HQ session for trap C to revoke, so the
 * unconsumed ticket stayed redeemable for the rest of its TTL and could mint a
 * NEW HQ session after logout. Closed from both ends: the identity host
 * invalidates every unconsumed ticket for a session as it revokes that session,
 * and redemption independently re-checks that the origin session is still live.
 * Either alone would leave a window; both together do not.
 */

/** Routes the IDENTITY host exposes. Mounted under the app origin. */
export const SSO_IDENTITY_ROUTES = {
  /** Browser-facing. Requires the identity host's own session. */
  authorize: '/api/sso/hq/authorize',
  /** Back channel. Service-authenticated; never reachable from a browser usefully. */
  redeem: '/api/sso/hq/redeem',
  /** Back channel. Step-up password verification, on the shared login budget. */
  verifyPassword: '/api/sso/hq/verify-password',
} as const;

/** Routes the HQ host exposes. Mounted under the HQ origin. */
export const SSO_HQ_ROUTES = {
  /** Browser-facing landing point of the redirect back from the identity host. */
  callback: '/sso/callback',
  /** Browser-facing. Revokes this browser's HQ session only. */
  logout: '/sso/logout',
  /** Back channel. The identity host calls this on sign-out (trap C). */
  backchannelLogout: '/api/sso/hq/backchannel-logout',
} as const;

/** HQ's own session cookie. Host-only: it is set with NO Domain attribute. */
export const HQ_SESSION_COOKIE = 'hq_session';

/** Ties a callback to the redirect that started it (CSRF on the callback). */
export const HQ_SSO_STATE_COOKIE = 'hq_sso_state';

/**
 * Ticket lifetime. Deliberately tiny: a ticket is carried in a URL, so it can
 * land in history, a proxy log or a referrer. It is single-use as well, but a
 * short window is the part that does not depend on the store behaving.
 */
export const SSO_TICKET_TTL_MS = 60_000;

/** HQ session lifetime. Founder decision of 2026-09-02: 60 minutes. */
export const HQ_SESSION_TTL_MS = 60 * 60_000;

/** Header carrying the service-to-service secret on back-channel calls. */
export const SSO_SERVICE_AUTH_HEADER = 'x-jenify-sso-service';

/**
 * What the identity host vouches for.
 *
 * Every field is server-derived on the identity side and travels only over the
 * back channel — never through the browser, which sees an opaque ticket alone.
 */
export interface HqSsoClaims {
  realmId: string;
  accountId: string;
  displayName: string;
  /**
   * When the human actually signed in — NOT when the handoff happened.
   *
   * This is trap A. It becomes `AuthenticatedAccount.authenticatedAt`, which is
   * the only input to step-up freshness, so it must never be refreshed by the
   * act of moving between hosts.
   */
  sessionEstablishedAt: string;
  /**
   * The identity host's session id this handoff derives from.
   *
   * Recorded so sign-out can revoke every HQ session that came from it (trap C).
   * It is an opaque id, never the session TOKEN — a stolen HQ database must not
   * yield a usable identity-host credential.
   */
  originSessionId: string;
}

export type SsoRedeemResult =
  | { ok: true; claims: HqSsoClaims }
  | { ok: false; error: SsoRedeemError };

export type SsoRedeemError =
  | 'ticket_unknown'
  | 'ticket_expired'
  | 'ticket_consumed'
  | 'audience_mismatch'
  /**
   * The redeem call did not present the state the ticket was minted with.
   *
   * See trap D above: without this a stolen ticket was redeemable from any
   * browser that happened to hold a valid state of its own.
   */
  | 'state_mismatch'
  /**
   * The identity session this ticket derives from has ended (trap E above).
   *
   * Refused rather than honoured: a sign-out must not leave a redeemable
   * credential behind that can still mint a new HQ session.
   */
  | 'origin_session_ended'
  | 'service_unauthenticated'
  | 'unavailable';

/** Result of a step-up password check performed by the identity host. */
export type SsoPasswordResult = 'ok' | 'rejected' | 'rate_limited' | 'unavailable';

export interface SsoVerifyPasswordRequest {
  realmId: string;
  accountId: string;
  password: string;
  /**
   * The BROWSER's address, forwarded by HQ (trap B).
   *
   * Without it the identity host would bucket every Founder under HQ's own
   * address: one attacker would lock out everyone, and the per-source ceiling
   * would never bite per account.
   */
  clientIp: string;
}
