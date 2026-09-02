/**
 * HQ's back channel to the identity host (Phase 2, Stage 2).
 *
 * Two calls, both server-to-server, neither ever reachable from a browser with
 * anything useful: redeeming a ticket, and asking the identity host to check a
 * step-up password. HQ holds no password store, so the second call is the ONLY
 * way step-up can be satisfied here — which is the point of A-4.
 *
 * It is a port so tests can wire HQ to the identity host's handler directly and
 * assert behaviour without sockets, while `sso-wire.test.ts` still proves the
 * real HTTP implementation over two live Fastify instances.
 */

import {
  SSO_IDENTITY_ROUTES,
  SSO_SERVICE_AUTH_HEADER,
  type SsoPasswordResult,
  type SsoRedeemResult,
  type SsoVerifyPasswordRequest,
} from './contract.js';
import {
  backChannelUrl,
  checkBackChannelOrigin,
  describeBackChannelOriginRefusal,
} from './origin.js';

export interface IdentityBackChannel {
  /**
   * Exchange a ticket for claims.
   *
   * `state` is the value that came back on the callback and matched this
   * browser's state cookie. It is REQUIRED (trap D): the identity host compares
   * it to the state the ticket was minted with, so a ticket captured out of a
   * URL cannot be redeemed from a different browser's round trip.
   */
  redeem(ticket: string, state: string): Promise<SsoRedeemResult>;
  verifyPassword(input: SsoVerifyPasswordRequest): Promise<SsoPasswordResult>;
}

/**
 * Talk to a real identity host over HTTP.
 *
 * The service secret travels in a header and never in a URL, so it cannot land
 * in an access log or a referrer. A transport failure is reported as
 * `unavailable` rather than as a rejection, so the caller can fail CLOSED
 * without also telling the person at the keyboard that their password was
 * wrong.
 *
 * ## It refuses to be built on a cleartext transport
 *
 * Keeping a credential out of the URL is worth nothing if the whole request is
 * readable on the wire, and this channel carries both the service secret and a
 * relayed step-up password. `checkBackChannelOrigin` is therefore enforced HERE,
 * at construction, and not only in the environment loaders: a loader can be
 * bypassed by a future caller, a constructor cannot. The loaders still check
 * first, so an operator gets a boot-log explanation rather than a stack trace.
 *
 * That check also refuses a path-mounted origin (third correction round): this
 * client appends route constants to `baseUrl`, so a prefix here was honoured
 * while the browser redirect dropped it, and one configured value pointed the
 * two channels at two different places.
 *
 * ## And it refuses to FOLLOW anything (second correction round)
 *
 * Validating the origin validates the URL this code chose to call. `fetch`
 * follows redirects by default, and a redirect target is chosen by the
 * responder: a compromised or merely misconfigured identity host answering
 * 307/308 would make this client repeat the request — method, body and headers
 * preserved, per RFC 7231 — at whatever URL it named, including plaintext http
 * to somewhere else entirely. That request carries the service secret in a
 * header and, on the step-up path, the Founder's password in the body. The
 * origin check never sees that second URL.
 *
 * So every credential-bearing call sets `redirect: 'error'`. Fail closed, at the
 * simplest possible point: the credential is never sent twice, because there is
 * never a second request. A redirect from the identity host is a
 * misconfiguration, and it surfaces as `unavailable` — the same honest "could
 * not ask" an unreachable host produces — rather than as a silent credential
 * forward or as a false rejection of a correct password.
 */
export function httpBackChannel(options: {
  baseUrl: string;
  serviceSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): IdentityBackChannel {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const checked = checkBackChannelOrigin(options.baseUrl);
  if (!checked.ok) {
    throw new Error(
      describeBackChannelOriginRefusal('identity origin', options.baseUrl, checked.reason),
    );
  }
  const base = checked.origin;

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(backChannelUrl(base, path), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SSO_SERVICE_AUTH_HEADER]: options.serviceSecret,
        },
        body: JSON.stringify(body),
        // Never follow a redirect while carrying a credential: `fetch` would
        // replay this exact method, body and header at a URL the responder
        // chose, which the origin check never validated. `error` rejects the
        // promise instead, and the catch below turns that into `unavailable`.
        redirect: 'error',
        signal: controller.signal,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async redeem(ticket, state) {
      const response = await post(SSO_IDENTITY_ROUTES.redeem, { ticket, state });
      if (!response) return { ok: false, error: 'unavailable' };
      const body = response.body as SsoRedeemResult | null;
      if (!body || typeof body !== 'object') return { ok: false, error: 'unavailable' };
      return body;
    },
    async verifyPassword(input) {
      const response = await post(SSO_IDENTITY_ROUTES.verifyPassword, input);
      if (!response) return 'unavailable';
      const body = response.body as { result?: SsoPasswordResult } | null;
      const result = body?.result;
      // Anything unrecognised is treated as unavailable, never as `ok`.
      return result === 'ok' || result === 'rejected' || result === 'rate_limited'
        ? result
        : 'unavailable';
    },
  };
}
