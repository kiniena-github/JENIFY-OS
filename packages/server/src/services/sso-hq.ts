/**
 * The identity host's side of the JENIFY HQ sign-in bridge
 * (Phase 2, Stage 2; Founder Gate A decided A-4 on 2026-09-02).
 *
 * This server owns the one Jenify account system and the one password store.
 * HQ owns none of that and never will. What this module adds is the ability to
 * VOUCH for an already-signed-in Founder, exactly once per handoff, over a
 * channel the browser cannot read or forge.
 *
 * Three responsibilities, and nothing else:
 *
 *   mintTicket           after checking this server's own session
 *   redeemTicket         once, over the back channel, then never again
 *   verifyStepUpPassword on the SAME failure budget as sign-in
 *
 * It deliberately does NOT decide anything about HQ authority. Whether the
 * vouched-for account is the Founder is settled by HQ's own configured
 * principal map, exactly as before — this module cannot promote anybody.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { ssoHqTickets } from '../db/schema.js';
import { newId } from '../util.js';
import { accountLoginIdentifier, verifyAccountPassword, type SessionRecord } from './auth.js';
import { assertNotRateLimited, recordAuthFailure, clearAuthFailures } from './ratelimit.js';

/** One minute. A ticket rides in a URL, so its window is deliberately tiny. */
export const SSO_TICKET_TTL_MS = 60_000;

export interface HqSsoClaims {
  realmId: string;
  accountId: string;
  displayName: string;
  sessionEstablishedAt: string;
  originSessionId: string;
}

export type SsoRedeemOutcome =
  | { ok: true; claims: HqSsoClaims }
  | { ok: false; error: 'ticket_unknown' | 'ticket_expired' | 'ticket_consumed' | 'audience_mismatch' };

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time secret comparison that refuses a length mismatch outright. */
export function serviceSecretMatches(supplied: unknown, expected: string | undefined): boolean {
  if (typeof supplied !== 'string' || !expected) return false;
  if (supplied.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Is this redirect target allowed?
 *
 * EXACT string match against the configured list, never a prefix or a hostname
 * test. Prefix matching is how open redirects happen — `https://hq.example.evil`
 * starts with `https://hq.example` — and this parameter is attacker-supplied by
 * definition, so it gets the strictest possible check.
 */
export function redirectUriAllowed(candidate: string, allowList: readonly string[]): boolean {
  return allowList.some((allowed) => allowed === candidate);
}

/**
 * Mint a one-time ticket for an already-authenticated account.
 *
 * The caller MUST have resolved `session` from this server's own session store
 * on this request. Nothing here re-checks the password, and nothing here can be
 * reached without a live session — that is the caller's obligation, enforced in
 * the route.
 */
export function mintTicket(
  db: Db,
  input: {
    session: SessionRecord;
    audience: string;
    redirectUri: string;
    state: string;
    now?: Date;
  },
): string {
  const now = input.now ?? new Date();
  const ticket = randomBytes(32).toString('base64url');
  db.insert(ssoHqTickets)
    .values({
      id: newId(),
      ticketHash: digest(ticket),
      audience: input.audience,
      redirectUri: input.redirectUri,
      state: input.state,
      realmId: input.session.user.tenantId,
      accountId: input.session.user.id,
      displayName: input.session.user.displayName,
      // TRAP A. The ORIGINAL sign-in instant, carried across the handoff so HQ
      // cannot manufacture step-up freshness by bouncing through here.
      sessionEstablishedAt: input.session.establishedAt,
      originSessionId: input.session.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SSO_TICKET_TTL_MS).toISOString(),
      consumedAt: null,
    })
    .run();
  return ticket;
}

/**
 * Redeem a ticket exactly once.
 *
 * The consume is a conditional UPDATE on `consumed_at IS NULL`, so two
 * simultaneous redemptions cannot both win: SQLite serialises them and the
 * second sees zero rows changed. Checking-then-writing would have been a race
 * with a replayed ticket as the prize.
 */
export function redeemTicket(
  db: Db,
  ticket: string,
  audience: string,
  now: Date = new Date(),
): SsoRedeemOutcome {
  if (!ticket) return { ok: false, error: 'ticket_unknown' };
  const row = db.select().from(ssoHqTickets).where(eq(ssoHqTickets.ticketHash, digest(ticket))).get();
  if (!row) return { ok: false, error: 'ticket_unknown' };
  if (row.consumedAt != null) return { ok: false, error: 'ticket_consumed' };
  if (Date.parse(row.expiresAt) <= now.getTime()) return { ok: false, error: 'ticket_expired' };
  if (row.audience !== audience) return { ok: false, error: 'audience_mismatch' };

  const consumed = db
    .update(ssoHqTickets)
    .set({ consumedAt: now.toISOString() })
    // `isNull`, not `eq(..., null)`: in SQL `x = NULL` is never true, so an
    // equality test here would match nothing and every redemption — including
    // the first, legitimate one — would be reported as a replay.
    .where(and(eq(ssoHqTickets.id, row.id), isNull(ssoHqTickets.consumedAt)))
    .run();
  // `changes === 0` means somebody else consumed it between the read and the
  // write. That is a replay, and it loses.
  if (consumed.changes === 0) return { ok: false, error: 'ticket_consumed' };

  return {
    ok: true,
    claims: {
      realmId: row.realmId,
      accountId: row.accountId,
      displayName: row.displayName,
      sessionEstablishedAt: row.sessionEstablishedAt,
      originSessionId: row.originSessionId,
    },
  };
}

export type SsoPasswordOutcome = 'ok' | 'rejected' | 'rate_limited';

/**
 * Step-up password verification on behalf of HQ.
 *
 * ## TRAP B — the budget must be the sign-in budget, keyed on the BROWSER
 *
 * `assertNotRateLimited` enforces two buckets: the key itself and the source
 * key derived from it. The key here is byte-for-byte the one `/api/auth/login`
 * builds — `ip|login|<stored username>` — so ten failures are ten failures
 * across both surfaces rather than ten each. That equivalence took two Codex
 * correction rounds to get right when both surfaces were in one process; moving
 * one of them onto another host is exactly the change that could quietly undo
 * it.
 *
 * The `ip` is the BROWSER's, forwarded by HQ. If HQ's own address were used
 * instead, every Founder would share one bucket: one attacker would lock out
 * everybody, and the per-account bucket would never bite. So a caller that
 * cannot name a client address is refused rather than run unbudgeted.
 *
 * An unknown or deactivated account is refused without touching the password
 * path at all.
 */
export function verifyStepUpPassword(
  db: Db,
  input: { accountId: string; realmId: string; password: string; clientIp: string },
): SsoPasswordOutcome {
  if (!input.clientIp) return 'rejected';
  if (!input.password) return 'rejected';
  const identifier = accountLoginIdentifier(db, input.accountId);
  if (identifier === null) return 'rejected';
  const key = `${input.clientIp}|login|${identifier}`;
  try {
    assertNotRateLimited(key);
  } catch {
    return 'rate_limited';
  }
  if (!verifyAccountPassword(db, input.accountId, input.password)) {
    recordAuthFailure(key);
    return 'rejected';
  }
  clearAuthFailures(key);
  return 'ok';
}

/**
 * Tell HQ that an identity session has ended (TRAP C).
 *
 * A port, so the wiring is testable without sockets and so a deployment that
 * has no HQ configured simply has no notifier. Failures are reported, never
 * thrown: sign-out must succeed here even if HQ is unreachable, and the HQ
 * session's own 60-minute ceiling remains the backstop.
 */
export interface HqLogoutNotifier {
  revokeSessionsFor(originSessionId: string): Promise<{ ok: boolean; detail: string }>;
}

export function httpHqLogoutNotifier(options: {
  hqOrigin: string;
  serviceSecret: string;
  header: string;
  path: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): HqLogoutNotifier {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async revokeSessionsFor(originSessionId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
      try {
        const response = await doFetch(`${options.hqOrigin.replace(/\/+$/, '')}${options.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [options.header]: options.serviceSecret },
          body: JSON.stringify({ originSessionId }),
          signal: controller.signal,
        });
        return { ok: response.ok, detail: `status ${response.status}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Housekeeping: drop tickets that can no longer be redeemed. */
export function pruneExpiredTickets(db: Db, now: Date = new Date()): number {
  const rows = db.select().from(ssoHqTickets).all();
  let removed = 0;
  for (const row of rows) {
    if (row.consumedAt != null || Date.parse(row.expiresAt) <= now.getTime()) {
      db.delete(ssoHqTickets).where(eq(ssoHqTickets.id, row.id)).run();
      removed += 1;
    }
  }
  return removed;
}

