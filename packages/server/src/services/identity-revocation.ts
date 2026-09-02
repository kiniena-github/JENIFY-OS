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
 * ceiling remains the backstop, exactly as it was for logout. Nor may it stall:
 * propagation is bounded by one deadline across every session it notifies, for
 * the reasons in `propagateIdentityRevocation` below.
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
 * How many notifier calls may be in flight at once.
 *
 * Small on purpose. The point is to stop a serial walk taking minutes, not to
 * open a connection per session against a host that is already struggling — an
 * administrator disabling a compromised account must not also mount a small
 * burst against HQ.
 */
export const REVOCATION_PROPAGATION_CONCURRENCY = 8;

/**
 * The single overall deadline for propagating ONE revocation, however many
 * sessions it ended.
 *
 * Ten seconds is above any healthy round trip and well inside what a human
 * waiting on a password reset will tolerate. It is a ceiling on the whole
 * operation, not a per-call timeout: `httpHqLogoutNotifier` keeps its own
 * five-second abort per request, and this bounds the sum of them.
 */
export const REVOCATION_PROPAGATION_DEADLINE_MS = 10_000;

export interface IdentityRevocationPropagationOptions {
  /** Notifier calls in flight at once. Defaults to `REVOCATION_PROPAGATION_CONCURRENCY`. */
  concurrency?: number;
  /** Ceiling on the whole propagation. Defaults to `REVOCATION_PROPAGATION_DEADLINE_MS`. */
  deadlineMs?: number;
}

/** Bounded to keep one audit line readable when an account had many sessions. */
const AUDIT_ID_SAMPLE = 20;

function sampleIds(ids: readonly string[]): string {
  if (ids.length <= AUDIT_ID_SAMPLE) return ids.join(', ');
  return `${ids.slice(0, AUDIT_ID_SAMPLE).join(', ')}, and ${ids.length - AUDIT_ID_SAMPLE} more`;
}

/**
 * Tell HQ that these identity sessions are dead (trap C, generalised).
 *
 * Call AFTER the local transaction has committed. Never throws: a caller
 * awaiting this must still succeed when HQ is unreachable.
 *
 * ## Bounded, with one deadline for the whole operation (third correction round)
 *
 * This used to await one notifier call per session, in a straight line, each
 * with its own five-second timeout. One session is fine; an account with forty
 * of them, on an HQ that has stopped answering, made a password reset hang for
 * over three minutes AFTER the local transaction had already committed. An
 * administrator watching that has no way to tell a slow success from a failed
 * one, and the operation they are performing is usually an emergency.
 *
 * So: at most `concurrency` calls in flight, and ONE deadline across all of
 * them. When the deadline passes, calls still outstanding stop being waited on
 * and sessions not yet started are not started. The return is therefore bounded
 * by the deadline regardless of how many sessions there were or how badly HQ is
 * behaving.
 *
 * What that costs is stated rather than hidden: the summary line names how many
 * were confirmed, how many failed and how many were not confirmed before the
 * deadline, and says plainly that the unconfirmed ones remain valid until their
 * own expiry — which is HQ's 60-minute ceiling, the same backstop that has
 * always covered an unreachable HQ. An operator reading it knows exactly what
 * did and did not happen. Reporting silent success would be the misleading
 * outcome; so would blocking for minutes.
 *
 * A batched request was the alternative and was rejected for now: it needs a new
 * multi-id shape on HQ's back-channel-logout route, and a mixed-version
 * deployment (an older HQ, which is the normal state during a rollout) would
 * then take the batch, ignore the field it does not understand and answer 200 —
 * a revocation that reports success and revokes nothing. That is a worse failure
 * than a bounded, honestly-reported partial, and it can be added later behind a
 * version check without changing anything here.
 */
export async function propagateIdentityRevocation(
  ssoHq: IdentityRevocationSink | undefined,
  revocation: IdentityRevocation,
  options: IdentityRevocationPropagationOptions = {},
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
  const ids = revocation.originSessionIds;
  if (ids.length === 0) return;

  const deadlineMs = Math.max(1, options.deadlineMs ?? REVOCATION_PROPAGATION_DEADLINE_MS);
  const concurrency = Math.max(1, options.concurrency ?? REVOCATION_PROPAGATION_CONCURRENCY);

  let expired = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineReached = new Promise<{ kind: 'deadline' }>((resolve) => {
    deadlineTimer = setTimeout(() => {
      expired = true;
      resolve({ kind: 'deadline' });
    }, deadlineMs);
    // Housekeeping for a short-lived process: this timer must never be the
    // reason Node stays alive.
    deadlineTimer.unref?.();
  });

  /** Never rejects: the port's contract is to report, and a bad one is contained. */
  const attempt = async (originSessionId: string): Promise<{ ok: boolean; detail: string }> => {
    try {
      // The port's contract is to REPORT failure rather than throw, and the
      // shipped `httpHqLogoutNotifier` honours it — but "never fails the local
      // operation" must not depend on every implementation being well behaved.
      // A notifier that throws would otherwise turn an administrator's password
      // reset into a 500, with the local revocation already committed: the worst
      // possible outcome, since it looks like the reset did not happen.
      return await notifier.revokeSessionsFor(originSessionId);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'notifier threw' };
    }
  };

  let next = 0;
  let confirmed = 0;
  let failed = 0;
  const unconfirmed: string[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      const originSessionId = ids[index]!;
      if (expired) {
        unconfirmed.push(originSessionId);
        continue;
      }
      const outcome = await Promise.race([
        attempt(originSessionId).then((result) => ({ kind: 'settled' as const, result })),
        deadlineReached,
      ]);
      if (outcome.kind === 'deadline') {
        // The call may still complete at HQ — it simply is not waited on, and is
        // never counted as confirmed on the strength of hope.
        unconfirmed.push(originSessionId);
        continue;
      }
      const { result } = outcome;
      if (result.ok) {
        confirmed += 1;
        audit(
          `[sso] HQ sessions revoked for identity session ${originSessionId} (${revocation.reason})`,
        );
      } else {
        failed += 1;
        audit(
          `[sso] WARNING: could not revoke HQ sessions for ${originSessionId} ` +
            `(${revocation.reason}: ${result.detail}). They remain valid until their own expiry.`,
        );
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()),
    );
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  const clean = confirmed === ids.length;
  audit(
    `[sso] HQ revocation propagation (${revocation.reason}): ${confirmed} of ${ids.length} ` +
      `identity session(s) confirmed, ${failed} refused or unreachable, ${unconfirmed.length} ` +
      `not confirmed within ${deadlineMs}ms` +
      (clean
        ? '.'
        : '. Anything not confirmed remains valid at HQ until its own expiry.' +
          (unconfirmed.length > 0 ? ` Not confirmed: ${sampleIds(unconfirmed)}.` : '')),
  );
}
