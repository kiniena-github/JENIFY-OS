/**
 * HQ's identity adapter over its own session cookie (Phase 2, Stage 2).
 *
 * This is the implementation that plugs into the `HqIdentityPort` seam Stage 1
 * built. Under A-4 it is the ONLY way a Founder is known to HQ.
 *
 * ## Trap A lives on one line, and it is `authenticatedAt`
 *
 * `AuthenticatedAccount.authenticatedAt` is the sole input to step-up
 * freshness. It is set from `sessionEstablishedAt` — when the human actually
 * signed in at the identity host — and never from the HQ session's own
 * `createdAt`. Refreshing it at handoff would mean anyone holding a stolen
 * `fos_session` could mint apparent freshness on demand and approve
 * irreversible work without ever typing a password.
 *
 * ## Why step-up needs a preparation pass
 *
 * `CredentialVerifierPort.verify` is synchronous, and so is
 * `handleControlRequest` — deliberately, because the whole authority boundary
 * is framework-free and unit-testable without a server. Under A-4 the password
 * check is a network call to the identity host, which is not.
 *
 * Rather than make the core async (a change rippling through 1771 tests to
 * serve one host), the async work happens BEFORE the core runs: the route
 * handler awaits `prepareStepUp`, and the synchronous verifier then returns
 * that already-computed answer. The verifier re-checks that the answer belongs
 * to this account and this password, so a precomputed `ok` can never be
 * harvested by a different question than the one it answered.
 *
 * An unreachable identity host is NOT laundered through the port as a
 * rejection. `prepareStepUp` reports `unavailable`, the handler refuses the
 * request honestly, and nobody is told their correct password was wrong.
 */

import type { FastifyRequest } from 'fastify';
import type { CredentialVerifierPort, SessionResolverPort } from '@factoryos/headquarter/live';
import type { HqIdentityPort } from '../identity.js';
import type { IdentityBackChannel } from './back-channel.js';
import type { HqSessionStore } from './session-store.js';
import { HQ_SESSION_COOKIE } from './contract.js';

/** What the async pre-pass concluded, before the synchronous core runs. */
export type StepUpPreparation = 'none' | 'ready' | 'unavailable';

interface PendingStepUp {
  realmId: string;
  accountId: string;
  password: string;
  result: 'ok' | 'rejected' | 'rate_limited';
}

/**
 * Per-request scratch space.
 *
 * A WeakMap keyed by the request object, so nothing survives the request and
 * one request's verdict can never be read by another. The password sits here
 * only for as long as it already sits in `request.body`, so this adds no
 * exposure it did not already have.
 */
const pending = new WeakMap<FastifyRequest, PendingStepUp>();

/**
 * The port itself, pre-pass included.
 *
 * `prepare` is part of `HqIdentityPort` rather than a sibling the caller has to
 * remember to invoke — an earlier shape returned `{ port, prepareStepUp }`, and
 * because `port` alone was what got registered, the pre-pass silently never
 * ran: an unreachable identity host fell through to the core instead of being
 * refused. Keeping them on one object makes that mistake unrepresentable.
 */
export type SsoIdentity = HqIdentityPort;

function readCookie(request: FastifyRequest, name: string): string | undefined {
  return (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[
    name
  ];
}

export function ssoIdentity(store: HqSessionStore, backChannel: IdentityBackChannel): SsoIdentity {
  function sessions(request: FastifyRequest): SessionResolverPort {
    return {
      resolve() {
        // Re-resolved on every call: the store checks revocation and expiry
        // each time, as the port contract requires.
        const record = store.resolve(readCookie(request, HQ_SESSION_COOKIE));
        if (!record) return null;
        return {
          realmId: record.realmId,
          accountId: record.accountId,
          displayName: record.displayName,
          // TRAP A. The original sign-in instant, never `record.createdAt`.
          authenticatedAt: record.sessionEstablishedAt,
        };
      },
    };
  }

  function credentials(request: FastifyRequest): CredentialVerifierPort {
    return {
      verify(account, password) {
        const prepared = pending.get(request);
        // No preparation ⇒ fail closed. A handler that forgot to await
        // `prepareStepUp` must not accidentally pass step-up.
        if (!prepared) return 'rejected';
        if (prepared.realmId !== account.realmId || prepared.accountId !== account.accountId) {
          return 'rejected';
        }
        if (prepared.password !== password) return 'rejected';
        return prepared.result;
      },
    };
  }

  return {
    forRequest(request) {
      return { sessions: sessions(request), credentials: credentials(request) };
    },

    async prepare(request) {
      const body = request.body;
      const supplied =
        body != null && typeof body === 'object'
          ? (body as Record<string, unknown>).stepUpPassword
          : undefined;
      if (typeof supplied !== 'string' || supplied.length === 0) return 'none';

      // Resolve WHO is asking from the session alone — never from the body.
      const record = store.resolve(readCookie(request, HQ_SESSION_COOKIE));
      if (!record) return 'none';

      const result = await backChannel.verifyPassword({
        realmId: record.realmId,
        accountId: record.accountId,
        password: supplied,
        // TRAP B. The browser's address, so the identity host buckets the
        // failure against the real client and shares the sign-in budget.
        clientIp: request.ip,
      });

      if (result === 'unavailable') return 'unavailable';
      pending.set(request, {
        realmId: record.realmId,
        accountId: record.accountId,
        password: supplied,
        result,
      });
      return 'ready';
    },
  };
}
