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

export interface IdentityBackChannel {
  redeem(ticket: string): Promise<SsoRedeemResult>;
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
 */
export function httpBackChannel(options: {
  baseUrl: string;
  serviceSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): IdentityBackChannel {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SSO_SERVICE_AUTH_HEADER]: options.serviceSecret,
        },
        body: JSON.stringify(body),
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
    async redeem(ticket) {
      const response = await post(SSO_IDENTITY_ROUTES.redeem, { ticket });
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
