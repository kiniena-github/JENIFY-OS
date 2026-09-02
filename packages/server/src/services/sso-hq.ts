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
import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { backChannelUrl } from '@factoryos/hq-host';
import type { Db } from '../db/index.js';
import { ssoHqTickets } from '../db/schema.js';
import { newId } from '../util.js';
import {
  accountLoginIdentifier,
  sessionIsLive,
  verifyAccountPassword,
  type SessionRecord,
} from './auth.js';
import { assertNotRateLimited, recordAuthFailure, clearAuthFailures } from './ratelimit.js';
import type { HqLogoutNotifier } from './identity-revocation.js';

/** One minute. A ticket rides in a URL, so its window is deliberately tiny. */
export const SSO_TICKET_TTL_MS = 60_000;

export interface HqSsoClaims {
  realmId: string;
  accountId: string;
  displayName: string;
  sessionEstablishedAt: string;
  originSessionId: string;
}

export type SsoRedeemError =
  | 'ticket_unknown'
  | 'ticket_expired'
  | 'ticket_consumed'
  | 'audience_mismatch'
  /** The redeem call did not present the state this ticket was minted with. */
  | 'state_mismatch'
  /** The identity session this ticket derives from is revoked or expired. */
  | 'origin_session_ended';

export type SsoRedeemOutcome = { ok: true; claims: HqSsoClaims } | { ok: false; error: SsoRedeemError };

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
  // Housekeeping, on the ONE path that creates rows (third correction round).
  // Opportunistic rather than scheduled: this server has no scheduler, and a
  // timer would be a second lifecycle to own, to shut down cleanly and to keep
  // from firing in tests. Pruning where the growth happens needs none of that,
  // and the bound (`TICKET_PRUNE_BATCH`) is what keeps it cheap enough to sit on
  // a sign-in path.
  try {
    pruneExpiredTickets(db, now);
  } catch {
    // Housekeeping must never fail a sign-in. The ticket above is already
    // written and valid; a sweep that could not run leaves rows for the next
    // mint to collect, which is the harmless failure of the two.
  }
  return ticket;
}

/**
 * Constant-time equality for two opaque, browser-supplied values.
 *
 * `state` is compared with this rather than `===` for the same reason the
 * service secret is: an attacker gets unlimited attempts at a value they
 * control, so a comparison whose duration depends on the shared prefix is a
 * (slow, noisy, but real) oracle. A length mismatch is refused outright,
 * because `timingSafeEqual` throws on unequal lengths.
 */
function opaqueValuesMatch(supplied: string, expected: string): boolean {
  if (supplied.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Redeem a ticket exactly once, for the round trip it was minted for, while the
 * session behind it is still live.
 *
 * The consume is a conditional UPDATE on `consumed_at IS NULL`, so two
 * simultaneous redemptions cannot both win: SQLite serialises them and the
 * second sees zero rows changed. Checking-then-writing would have been a race
 * with a replayed ticket as the prize.
 *
 * ## Why `state` is checked HERE and not only at HQ (trap D)
 *
 * HQ's callback already compares the returned `state` to a cookie it set on
 * this browser, which is the right CSRF check and is not the same check as this
 * one. That comparison proves the browser started A sign-in; it cannot prove
 * the ticket belongs to THAT sign-in, because HQ does not hold the ticket row.
 * So a ticket captured out of a URL — history, a proxy log, a referrer — could
 * be pasted into an attacker's own callback, whose own state cookie matched
 * their own state perfectly, and be redeemed for the victim's claims. Only this
 * server can close that, by comparing the presented state to the one stored
 * with the ticket at mint time.
 *
 * ## Why the origin session is re-checked (trap E)
 *
 * A ticket is minted from a live session and lives up to a minute. Sign out
 * inside that minute and there is no derived HQ session yet for logout
 * propagation to revoke, so the unconsumed ticket would otherwise still mint a
 * brand-new HQ session AFTER sign-out. `invalidateTicketsForOriginSession`
 * closes that from the logout side; this check closes it from the redeem side.
 * Both exist deliberately: the first stops a ticket surviving a logout it saw,
 * the second stops one surviving a session that ended any other way (expiry, an
 * admin revoke, a deactivated account).
 *
 * Order of checks is deliberate too: a ticket that fails any of them is NOT
 * consumed, so a legitimate ticket is never burned by an attacker's bad guess
 * — and no failing path leaks which state or session was expected.
 */
export function redeemTicket(
  db: Db,
  ticket: string,
  audience: string,
  state: string,
  now: Date = new Date(),
): SsoRedeemOutcome {
  if (!ticket) return { ok: false, error: 'ticket_unknown' };
  const row = db.select().from(ssoHqTickets).where(eq(ssoHqTickets.ticketHash, digest(ticket))).get();
  if (!row) return { ok: false, error: 'ticket_unknown' };
  if (row.consumedAt != null) return { ok: false, error: 'ticket_consumed' };
  if (Date.parse(row.expiresAt) <= now.getTime()) return { ok: false, error: 'ticket_expired' };
  if (row.audience !== audience) return { ok: false, error: 'audience_mismatch' };
  // A missing state is a mismatch, never a waiver: an older HQ build that does
  // not send one must fail closed rather than fall through unchecked.
  if (typeof state !== 'string' || !opaqueValuesMatch(state, row.state)) {
    return { ok: false, error: 'state_mismatch' };
  }
  if (!sessionIsLive(db, row.originSessionId, now)) {
    return { ok: false, error: 'origin_session_ended' };
  }

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
 * The HTTP notifier.
 *
 * ## It never follows a redirect (second correction round)
 *
 * This call carries the shared service secret in a header. `fetch` follows
 * redirects by default and a 307/308 preserves the method, body AND headers, so
 * an HQ origin that answered with one — compromised, or simply a proxy
 * misconfigured to add a trailing slash — would have this process repeat the
 * secret at a URL nobody validated, over whatever scheme that URL named. The
 * configured origin is checked by `loadSsoHqPlane`; a redirect target is not,
 * and cannot be, because it does not exist until the response arrives.
 *
 * `redirect: 'error'` therefore refuses outright. The failure is reported like
 * any other transport failure, so sign-out still succeeds locally and the
 * operator sees an audited warning naming it.
 */
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
        const response = await doFetch(backChannelUrl(options.hqOrigin, options.path), {
          method: 'POST',
          headers: { 'content-type': 'application/json', [options.header]: options.serviceSecret },
          body: JSON.stringify({ originSessionId }),
          // Never follow a redirect while carrying the service secret: a 307/308
          // would replay this header at an unvalidated URL.
          redirect: 'error',
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

/**
 * Trap C's notifier port and trap E's ticket sweep now live in
 * `identity-revocation.ts`, which owns the ONE path that ends identity
 * authority — sign-out, password reset, recovery, deactivation — and which
 * `auth.ts` must be able to import without a dependency cycle back through this
 * module. Re-exported here so every existing import path keeps working and the
 * SSO surface still reads as one thing.
 */
export {
  invalidateTicketsForOriginSession,
  type HqLogoutNotifier,
} from './identity-revocation.js';

/**
 * How many dead ticket rows one sweep may remove.
 *
 * The sweep runs on the mint path, so it must be bounded: a housekeeping pass
 * that scales with the backlog would put an unbounded amount of work in front of
 * a human's sign-in the first time it ran on a neglected table. One mint creates
 * exactly one row and removes up to this many, so a backlog drains steadily
 * across sign-ins instead of all at once, and steady state is reached after the
 * first few.
 */
export const TICKET_PRUNE_BATCH = 200;

/**
 * How long a row stays after it stops being redeemable.
 *
 * Not zero, deliberately. A ticket that has just been consumed is exactly the
 * row `redeemTicket` reads to answer `ticket_consumed`, which is the honest
 * answer to a replay and the one an operator wants in the audit line. Deleting
 * it the instant it is consumed would turn every replay into `ticket_unknown` —
 * still refused, but no longer distinguishable from a typo. One ticket lifetime
 * of grace keeps the precise answer for as long as a replay can plausibly be in
 * flight, and costs at most one extra minute of rows.
 */
export const TICKET_PRUNE_RETENTION_MS = SSO_TICKET_TTL_MS;

/**
 * Housekeeping: drop tickets that can no longer be redeemed (third correction
 * round, Codex P1).
 *
 * ## The defect this closes
 *
 * Every authorize INSERTS a row, and nothing ever deleted one: this function
 * existed but had no caller, so consumed, invalidated and expired tickets grew
 * without bound for the life of a deployment. Every one of those rows is dead
 * weight on a table `redeemTicket` reads on the sign-in path, and the row
 * carries `realm_id`, `account_id`, `display_name` and an identity session id —
 * retaining them forever is a data-retention problem as well as a growth one.
 *
 * ## Why it is safe
 *
 * A row is removable only once it is BOTH un-redeemable and has been so for
 * `retentionMs`. Un-redeemable means consumed (`consumed_at` set, by redemption
 * or by trap E's invalidation) or past `expires_at` — exactly the two conditions
 * `redeemTicket` refuses on, so nothing this deletes could have been redeemed by
 * the next call. A live ticket matches neither and is never touched.
 *
 * The SQL filter narrows and bounds the read; the same test is then re-applied
 * in JS against parsed instants before anything is deleted. That second pass is
 * not redundant belt-and-braces for its own sake: the SQL comparison is
 * lexicographic on ISO strings, and it must never be the only thing standing
 * between a live sign-in ticket and a DELETE.
 *
 * ## Why the candidate selection is TWO queries (fourth correction round)
 *
 * `LIMIT 200` bounds the rows RETURNED, not the rows EXAMINED. The old
 * predicate was a disjunction over two columns — `expires_at <= ? OR
 * consumed_at <= ?` — and SQLite cannot drive one index from that, so with
 * migration 0012 indexing only `ticket_hash` and `origin_session_id` every mint
 * scanned the entire growing live/grace set to find its 200 rows. That is
 * unbounded work on the authorize path, which is a human's sign-in.
 *
 * Splitting it into two range scans, each ordered by its own indexed column and
 * each capped at the batch, makes the candidate read bounded by construction:
 * migration 0013 adds `sso_hq_tickets_expires_at` (plain — `expires_at` is NOT
 * NULL) and `sso_hq_tickets_consumed_at` (PARTIAL, `WHERE consumed_at IS NOT
 * NULL`, so it holds only the consumed rows the sweep is actually after rather
 * than a NULL entry for every live ticket). Each scan seeks to the oldest key
 * and stops at the limit; the union is the same set the OR selected, so nothing
 * about which rows are collectable changed.
 */
/**
 * The two candidate reads the sweep actually issues.
 *
 * Exported so the boundedness test can `EXPLAIN QUERY PLAN` the SHIPPED SQL
 * rather than a hand-copied lookalike that could drift away from it silently —
 * which is precisely how an index-supported plan regresses back into a table
 * scan without anybody noticing.
 */
export function ticketSweepCandidateQueries(db: Db, cutoff: string, limit: number) {
  const columns = {
    id: ssoHqTickets.id,
    expiresAt: ssoHqTickets.expiresAt,
    consumedAt: ssoHqTickets.consumedAt,
  };
  return {
    expired: db
      .select(columns)
      .from(ssoHqTickets)
      .where(lte(ssoHqTickets.expiresAt, cutoff))
      // ORDER BY the indexed column so the plan is a range scan from the oldest
      // key, not a scan plus a sort. It also drains a backlog oldest-first,
      // which is the order an operator would expect.
      .orderBy(ssoHqTickets.expiresAt)
      .limit(limit),
    consumed: db
      .select(columns)
      .from(ssoHqTickets)
      // `isNotNull` is not redundant with the range test — `lte` on a NULL is
      // NULL, never true — it is what makes SQLite match the PARTIAL index, so
      // this scan touches only consumed rows.
      .where(and(isNotNull(ssoHqTickets.consumedAt), lte(ssoHqTickets.consumedAt, cutoff)))
      .orderBy(ssoHqTickets.consumedAt)
      .limit(limit),
  };
}

export function pruneExpiredTickets(
  db: Db,
  now: Date = new Date(),
  options: { limit?: number; retentionMs?: number } = {},
): number {
  const limit = options.limit ?? TICKET_PRUNE_BATCH;
  const retentionMs = options.retentionMs ?? TICKET_PRUNE_RETENTION_MS;
  if (limit <= 0) return 0;
  const cutoffMs = now.getTime() - Math.max(0, retentionMs);
  const cutoff = new Date(cutoffMs).toISOString();

  const queries = ticketSweepCandidateQueries(db, cutoff, limit);
  const expiredCandidates = queries.expired.all();
  const consumedCandidates = queries.consumed.all();

  const doomed = new Set<string>();
  for (const row of [...expiredCandidates, ...consumedCandidates]) {
    if (doomed.size >= limit) break;
    const expiredLongEnough = Date.parse(row.expiresAt) <= cutoffMs;
    const consumedLongEnough = row.consumedAt != null && Date.parse(row.consumedAt) <= cutoffMs;
    // A timestamp this cannot parse yields NaN, every comparison is false, and
    // the row survives. Keeping an unclassifiable row is the safe failure.
    if (!expiredLongEnough && !consumedLongEnough) continue;
    doomed.add(row.id);
  }

  if (doomed.size === 0) return 0;
  const ids = [...doomed];
  db.delete(ssoHqTickets).where(inArray(ssoHqTickets.id, ids)).run();
  return ids.length;
}

