/**
 * The ONE path that ends identity authority (Phase 2, Stage 2, second Codex
 * correction round).
 *
 * ## The defect this closes
 *
 * `POST /api/auth/logout` told HQ that a session had ended. Nothing else did —
 * and sign-out is not the only thing that ends a session:
 *
 *   · an admin password reset revoked every session of that account;
 *   · an emergency recovery code changed the password and revoked them too;
 *   · deactivating an account made every session of it stop resolving.
 *
 * Each of those correctly killed identity-side authority and left the DERIVED HQ
 * session alive for up to its full 60 minutes. So the exact operation an
 * administrator performs when an account is compromised — reset the password,
 * switch the account off — left the attacker's HQ session working, on the host
 * where irreversible Founder actions live.
 *
 * The fix is not "call the notifier in four more places". Four call sites is
 * four chances for the fifth to be forgotten. Session-ending is instead ONE
 * function, `revokeIdentitySessions`, which is the only code in this server that
 * writes `sessions.revoked_at`, and which always returns the origin session ids
 * it ended so its caller can hand them to `propagateIdentityRevocation`.
 * `identity-revocation.test.ts` asserts the first half of that structurally: no
 * other module may set `revoked_at` on `sessions`.
 *
 * ## Why revocation and propagation are two steps
 *
 * The revoke is synchronous and belongs INSIDE the caller's transaction (the
 * recovery flow already has one, and its atomicity is load-bearing). The
 * propagation is a network call that must never be inside a transaction, must
 * never fail the local operation, and must happen only after the local change
 * has actually committed. Splitting them is what lets both be true.
 *
 * Propagation failure is audited, never thrown: an unreachable HQ must not stop
 * an administrator from resetting a compromised password. HQ's own 60-minute
 * ceiling remains the backstop, exactly as it was for logout.
 *
 * ## Why the notifier port and the ticket sweep live HERE
 *
 * `auth.ts` has to call this module, and `sso-hq.ts` has to call `auth.ts`
 * (`sessionIsLive`, `verifyAccountPassword`). Owning the two pieces both sides
 * need — the notifier interface and `invalidateTicketsForOriginSession` — keeps
 * the dependency a straight line instead of a cycle. `sso-hq.ts` re-exports
 * both, so every existing import path still resolves.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, ssoHqTickets } from '../db/schema.js';
import { nowIso } from '../util.js';

/**
 * Tell HQ that an identity session has ended (trap C).
 *
 * A port, so the wiring is testable without sockets and so a deployment with no
 * HQ configured simply has no notifier. Implementations report failure, never
 * throw: ending identity authority must succeed here even when HQ is
 * unreachable.
 */
export interface HqLogoutNotifier {
  revokeSessionsFor(originSessionId: string): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Kill every unconsumed ticket minted from one identity session (trap E).
 *
 * Called as that session is revoked, in the same transaction, so there is no
 * instant at which the session is gone and a ticket from it is still redeemable.
 * Marking them consumed rather than deleting them keeps the single-use
 * bookkeeping intact: a redemption arriving afterwards is refused as
 * `ticket_consumed`, which is exactly what it is, and `pruneExpiredTickets`
 * clears the rows later.
 *
 * Returns how many were invalidated, so the caller can audit it.
 */
export function invalidateTicketsForOriginSession(
  db: Db,
  originSessionId: string,
  now: Date = new Date(),
): number {
  if (!originSessionId) return 0;
  const result = db
    .update(ssoHqTickets)
    .set({ consumedAt: now.toISOString() })
    .where(and(eq(ssoHqTickets.originSessionId, originSessionId), isNull(ssoHqTickets.consumedAt)))
    .run();
  return result.changes;
}

/**
 * Why identity authority ended.
 *
 * Recorded in the audit line so an operator reading HQ revocations can tell a
 * routine sign-out from an account being switched off under them.
 */
export type IdentityRevocationReason =
  | 'logout'
  | 'password_reset'
  | 'recovery'
  | 'account_deactivated';

/** Which sessions to end: one specific session, or every session of an account. */
export type IdentitySessionFilter = { sessionId: string } | { userId: string };

export interface IdentityRevocation {
  reason: IdentityRevocationReason;
  /** The identity session ids that were live and are now revoked. */
  originSessionIds: string[];
  /** Unredeemed HQ handoff tickets killed along with them (trap E). */
  ticketsInvalidated: number;
}

/** Nothing ended. A convenience so callers never have to build the empty shape. */
export function noIdentityRevocation(reason: IdentityRevocationReason): IdentityRevocation {
  return { reason, originSessionIds: [], ticketsInvalidated: 0 };
}

/**
 * End identity sessions and everything derived from them on THIS side.
 *
 * Safe to call with a transaction handle as `db` — it performs no async work and
 * opens no transaction of its own, so it composes with the callers that already
 * have one (recovery) and with the ones that need to add one (password reset).
 *
 * Only sessions that are still live are touched, so the returned list is exactly
 * what this call ended, never what a previous call already had. That matters:
 * propagating an id twice is harmless, but reporting one as "ended now" when it
 * ended an hour ago would make the audit trail lie.
 */
export function revokeIdentitySessions(
  db: Db,
  filter: IdentitySessionFilter,
  reason: IdentityRevocationReason,
  now: string = nowIso(),
): IdentityRevocation {
  const live = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        'sessionId' in filter
          ? eq(sessions.id, filter.sessionId)
          : eq(sessions.userId, filter.userId),
        isNull(sessions.revokedAt),
      ),
    )
    .all();
  if (live.length === 0) return noIdentityRevocation(reason);

  let ticketsInvalidated = 0;
  for (const row of live) {
    db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.id)).run();
    // Trap E, on every ending path rather than only on sign-out: a ticket minted
    // seconds ago has no HQ session yet, so revoking derived sessions cannot
    // reach it. It has to be killed where it lives.
    ticketsInvalidated += invalidateTicketsForOriginSession(db, row.id, new Date(now));
  }
  return { reason, originSessionIds: live.map((row) => row.id), ticketsInvalidated };
}

/** The slice of the SSO plane propagation needs. Kept structural to avoid a cycle. */
export interface IdentityRevocationSink {
  logoutNotifier?: HqLogoutNotifier;
  audit?: (line: string) => void;
}

/**
 * Tell HQ that these identity sessions are dead (trap C, generalised).
 *
 * Call AFTER the local transaction has committed. Never throws: a caller
 * awaiting this must still succeed when HQ is unreachable.
 */
export async function propagateIdentityRevocation(
  ssoHq: IdentityRevocationSink | undefined,
  revocation: IdentityRevocation,
): Promise<void> {
  const audit = ssoHq?.audit ?? (() => {});
  if (revocation.ticketsInvalidated > 0) {
    audit(
      `[sso] ${revocation.ticketsInvalidated} unredeemed HQ ticket(s) invalidated by ` +
        `${revocation.reason}`,
    );
  }
  const notifier = ssoHq?.logoutNotifier;
  if (!notifier) return;
  for (const originSessionId of revocation.originSessionIds) {
    // The port's contract is to REPORT failure rather than throw, and the
    // shipped `httpHqLogoutNotifier` honours it — but "never fails the local
    // operation" must not depend on every implementation being well behaved.
    // A notifier that throws would otherwise turn an administrator's password
    // reset into a 500, with the local revocation already committed: the worst
    // possible outcome, since it looks like the reset did not happen.
    let result: { ok: boolean; detail: string };
    try {
      result = await notifier.revokeSessionsFor(originSessionId);
    } catch (error) {
      result = { ok: false, detail: error instanceof Error ? error.message : 'notifier threw' };
    }
    audit(
      result.ok
        ? `[sso] HQ sessions revoked for identity session ${originSessionId} (${revocation.reason})`
        : `[sso] WARNING: could not revoke HQ sessions for ${originSessionId} ` +
            `(${revocation.reason}: ${result.detail}). They remain valid until their own expiry.`,
    );
  }
}
