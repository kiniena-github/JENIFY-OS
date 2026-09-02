/**
 * HQ's own session records (Phase 2, Stage 2).
 *
 * ## What this is, and what it deliberately is not
 *
 * Founder decision of 2026-09-02: *"HQ IS allowed to maintain its own session
 * table... The HQ session store is not a second identity/password database. It
 * only stores revocable session state."*
 *
 * So: no password, no password hash, no credential of any kind, no way to
 * authenticate anyone from this table alone. A row here says only "the identity
 * host vouched for this account at this instant, and this browser holds the
 * resulting handle". Every row is created by a redeemed single-use ticket and
 * by nothing else. `sso-boundary.test.ts` asserts the schema keeps that
 * promise, so a future column called `password_hash` fails the build.
 *
 * ## Why the token is hashed
 *
 * The cookie value is a bearer credential for HQ. Stored raw, a leaked copy of
 * the HQ database — a backup, a support export, this file on a laptop — would
 * be a set of live sessions for every signed-in Founder. Hashed, it is a set of
 * useless digests. The lookup is by digest, so nothing is lost.
 *
 * SHA-256 is the right primitive here and scrypt would be the wrong one: the
 * token is 32 bytes of CSPRNG output, not a human-chosen secret, so there is no
 * guessing attack for a slow KDF to slow down — and a slow KDF on every request
 * would be a denial-of-service surface instead.
 *
 * ## Two times, never confused
 *
 * `session_established_at` is when the human actually signed in, carried over
 * from the identity host. `created_at` is when THIS handoff happened. Only the
 * first is ever used for step-up freshness. Keeping them in separate columns is
 * what makes the trap-A mistake impossible to make by accident.
 *
 * ## Trap F — revocation has to be DURABLE, not just "revoke what exists"
 *
 * Second Codex correction round. `revokeByOriginSession` alone revokes rows that
 * are already there, and a handoff has a window in which no row is there yet:
 *
 *   1. HQ redeems the ticket. The identity host consumes it and answers.
 *   2. The human signs out. The identity host revokes its session, kills the
 *      unconsumed tickets (there are none left — this one is consumed) and calls
 *      HQ's back-channel logout, which revokes ZERO rows: HQ has not inserted
 *      one yet.
 *   3. HQ's callback returns from the await and inserts a brand-new 60-minute
 *      session — created AFTER the sign-out that was supposed to end it.
 *
 * Neither trap C (revoke derived sessions) nor trap E (kill unconsumed tickets)
 * covers step 3, because at the instant each ran there was nothing to act on.
 * So revocation is recorded as a TOMBSTONE keyed on the origin session id, and
 * `create` refuses when a tombstone exists. The check and the insert are one
 * transaction, and so are the tombstone write and the revoke sweep, so the two
 * orderings SQLite can produce are the only two possible outcomes, and both are
 * safe: tombstone first ⇒ creation refused; insert first ⇒ the sweep revokes it.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { HqDatabase } from '@factoryos/headquarter/store';
import { HQ_SESSION_TTL_MS, type HqSsoClaims } from './contract.js';

const DDL = `
CREATE TABLE IF NOT EXISTS hq_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  realm_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  session_established_at TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_sessions_origin ON hq_sessions(origin_session_id);
-- Housekeeping indexes (fourth correction round). The cleanup sweep runs on the
-- handoff path, so its candidate selection must be a bounded index range scan
-- and never a table scan that grows with the live set.
--
-- expires_at is NOT NULL, so a plain index is right: the sweep seeks to the
-- oldest key and stops at the batch limit.
--
-- revoked_at is NULL for every live session, which is almost all of them. A
-- plain index would therefore store one entry per live row and the sweep would
-- have to walk past them; the PARTIAL index holds only the revoked rows, so the
-- index is exactly the set being collected and it stays small by construction.
CREATE INDEX IF NOT EXISTS idx_hq_sessions_expires_at ON hq_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_hq_sessions_revoked_at
  ON hq_sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS hq_revoked_origin_sessions (
  origin_session_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL
);
`;

export interface HqSessionRecord {
  id: string;
  realmId: string;
  accountId: string;
  displayName: string;
  /** The ORIGINAL sign-in instant. Drives step-up freshness. */
  sessionEstablishedAt: string;
  originSessionId: string;
  /** When this handoff happened. NEVER used for freshness. */
  createdAt: string;
  expiresAt: string;
}

/**
 * What `create` did.
 *
 * A refusal is a first-class outcome rather than a thrown error or a bare
 * `null`, because the caller has a real decision to make: it must NOT set a
 * session cookie, and it must tell the human something true. Making the shape
 * explicit is what stops a future caller destructuring `{ token }` off a
 * refusal and shipping `undefined` into a Set-Cookie.
 */
export type HqSessionCreation =
  | { ok: true; token: string; record: HqSessionRecord }
  /** The identity session behind these claims was revoked (trap F). */
  | { ok: false; reason: 'origin_session_revoked' };

/**
 * How long a revocation tombstone is kept.
 *
 * It only has to outlive the longest possible in-flight handoff — a ticket
 * lives 60 seconds and a redemption is one back-channel round trip — so the HQ
 * session TTL is already an enormous margin. Keeping it bounded means a busy
 * deployment does not accumulate a row per sign-out forever.
 */
export const HQ_REVOCATION_TOMBSTONE_TTL_MS = HQ_SESSION_TTL_MS;

/**
 * How many cold session rows one sweep may remove.
 *
 * The sweep runs on the handoff path, so it must be bounded: housekeeping that
 * scaled with the backlog would put an unbounded amount of work in front of a
 * human's sign-in the first time it ran on a neglected table. One handoff adds
 * exactly one row and removes up to this many, so a backlog drains steadily
 * across sign-ins instead of all at once.
 */
export const HQ_SESSION_PRUNE_BATCH = 200;

/**
 * How long a session row stays after it stops being usable.
 *
 * Not zero, deliberately, and for a different reason than the ticket store's
 * grace: an HQ session row is the only local record that a handoff happened at
 * all, so an operator investigating "was this browser signed in an hour ago"
 * has one session lifetime in which to look. `resolve` already refuses an
 * expired or revoked row, so the grace grants no authority — it only bounds the
 * table at roughly two lifetimes' worth of handoffs instead of one.
 */
export const HQ_SESSION_PRUNE_RETENTION_MS = HQ_SESSION_TTL_MS;

interface ColdSessionRow {
  id: string;
  expires_at: string;
  revoked_at: string | null;
}

/**
 * The two candidate reads the sweep actually issues.
 *
 * Module constants rather than inline strings so the boundedness test can
 * `EXPLAIN QUERY PLAN` the SHIPPED SQL instead of a hand-copied lookalike that
 * could drift away from it silently — which is precisely how an index-supported
 * plan regresses back into a table scan without anybody noticing.
 */
export const HQ_SESSION_EXPIRED_CANDIDATES_SQL = `SELECT id, expires_at, revoked_at FROM hq_sessions
   WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`;

/**
 * `revoked_at IS NOT NULL` is not redundant with the range test — `x <= ?` on a
 * NULL is NULL, never true — it is what makes SQLite match the PARTIAL index,
 * so this scan touches only revoked rows rather than every live one.
 */
export const HQ_SESSION_REVOKED_CANDIDATES_SQL = `SELECT id, expires_at, revoked_at FROM hq_sessions
   WHERE revoked_at IS NOT NULL AND revoked_at <= ? ORDER BY revoked_at LIMIT ?`;

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class HqSessionStore {
  readonly #db: HqDatabase;
  readonly #ttlMs: number;

  constructor(db: HqDatabase, options: { ttlMs?: number } = {}) {
    this.#db = db;
    this.#ttlMs = options.ttlMs ?? HQ_SESSION_TTL_MS;
    this.#db.exec(DDL);
  }

  /**
   * Mint a session from redeemed claims — unless that identity session has
   * already been revoked (trap F).
   *
   * Returns the raw token exactly once, for the Set-Cookie. It is never stored
   * and cannot be recovered from the database afterwards.
   *
   * The tombstone check and the insert run in ONE better-sqlite3 transaction.
   * That is the whole mechanism: a tombstone written concurrently either commits
   * first (this transaction sees it and refuses) or commits second (it sees this
   * row and revokes it). There is no interleaving in which a live session
   * outlives the sign-out, which is exactly what the check-then-write version
   * allowed.
   */
  create(claims: HqSsoClaims, now: Date = new Date()): HqSessionCreation {
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(16).toString('hex');
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
    const inserted = this.#db.transaction((): boolean => {
      const tombstone = this.#db
        .prepare(`SELECT origin_session_id FROM hq_revoked_origin_sessions WHERE origin_session_id = ?`)
        .get(claims.originSessionId) as { origin_session_id: string } | undefined;
      if (tombstone) return false;
      this.#db
        .prepare(
          `INSERT INTO hq_sessions
             (id, token_hash, realm_id, account_id, display_name,
              session_established_at, origin_session_id, created_at, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          digest(token),
          claims.realmId,
          claims.accountId,
          claims.displayName,
          claims.sessionEstablishedAt,
          claims.originSessionId,
          createdAt,
          expiresAt,
        );
      return true;
    })();
    if (!inserted) return { ok: false, reason: 'origin_session_revoked' };
    // Housekeeping, on the ONE path that adds rows (fourth correction round).
    // Opportunistic rather than scheduled, for the same reason the identity
    // host's ticket sweep is: this host has no scheduler, and a timer would be
    // a second lifecycle to own, shut down and keep from firing in tests.
    // Deliberately OUTSIDE the transaction above: the insert is the human's
    // sign-in and must commit on its own terms, never roll back because a
    // cleanup DELETE ran into a lock.
    try {
      this.pruneColdSessions(now);
    } catch {
      // Housekeeping must never fail a sign-in. The session above is already
      // written and valid; a sweep that could not run leaves rows for the next
      // handoff to collect, which is the harmless failure of the two.
    }
    return {
      ok: true,
      token,
      record: {
        id,
        realmId: claims.realmId,
        accountId: claims.accountId,
        displayName: claims.displayName,
        sessionEstablishedAt: claims.sessionEstablishedAt,
        originSessionId: claims.originSessionId,
        createdAt,
        expiresAt,
      },
    };
  }

  /**
   * Resolve a cookie value to a live session, or null.
   *
   * Expiry and revocation are checked HERE, on every call, because the
   * `SessionResolverPort` contract requires exactly that and forbids caching
   * the decision.
   */
  resolve(token: string | undefined, now: Date = new Date()): HqSessionRecord | null {
    if (!token) return null;
    const row = this.#db
      .prepare(
        `SELECT id, realm_id, account_id, display_name, session_established_at,
                origin_session_id, created_at, expires_at, revoked_at
           FROM hq_sessions WHERE token_hash = ?`,
      )
      .get(digest(token)) as
      | {
          id: string;
          realm_id: string;
          account_id: string;
          display_name: string;
          session_established_at: string;
          origin_session_id: string;
          created_at: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) return null;
    if (row.revoked_at != null) return null;
    if (Date.parse(row.expires_at) <= now.getTime()) return null;
    return {
      id: row.id,
      realmId: row.realm_id,
      accountId: row.account_id,
      displayName: row.display_name,
      sessionEstablishedAt: row.session_established_at,
      originSessionId: row.origin_session_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** Revoke one browser's session (HQ sign-out). Idempotent. */
  revoke(token: string | undefined, now: Date = new Date()): void {
    if (!token) return;
    this.#db
      .prepare(`UPDATE hq_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .run(now.toISOString(), digest(token));
  }

  /**
   * Revoke every HQ session derived from one identity-host session (trap C),
   * and record that the identity session is dead (trap F).
   *
   * Called from the back-channel logout the identity host fires on ANY
   * identity-session-ending operation — sign-out, password reset, recovery,
   * account deactivation. Returns the number of live sessions revoked so the
   * caller can audit it; the tombstone is written whether that number is zero or
   * not, because zero is precisely the racy case: it means the handoff that will
   * create the session has not got there yet.
   *
   * Idempotent: a second call for the same origin session replaces the tombstone
   * timestamp and revokes nothing further.
   */
  revokeByOriginSession(originSessionId: string, now: Date = new Date()): number {
    if (!originSessionId) return 0;
    const at = now.toISOString();
    return this.#db.transaction((): number => {
      this.#db
        .prepare(
          `INSERT INTO hq_revoked_origin_sessions (origin_session_id, revoked_at)
           VALUES (?, ?)
           ON CONFLICT(origin_session_id) DO UPDATE SET
             -- MAX, not a plain overwrite: two revocations can arrive for one
             -- identity session (a sign-out and a password reset, say), and the
             -- second must never move the tombstone BACKWARDS in time, which
             -- would bring forward the moment housekeeping is allowed to drop
             -- it. ISO-8601 UTC sorts lexicographically, so MAX is "the later".
             revoked_at = MAX(hq_revoked_origin_sessions.revoked_at, excluded.revoked_at)`,
        )
        .run(originSessionId, at);
      const result = this.#db
        .prepare(
          `UPDATE hq_sessions SET revoked_at = ?
            WHERE origin_session_id = ? AND revoked_at IS NULL`,
        )
        .run(at, originSessionId);
      // Opportunistic housekeeping, on the one path that adds rows, so the
      // tombstone table stays bounded without a scheduler this host does not
      // have. The horizon is far longer than any handoff can live.
      this.#db
        .prepare(`DELETE FROM hq_revoked_origin_sessions WHERE revoked_at < ?`)
        .run(new Date(now.getTime() - HQ_REVOCATION_TOMBSTONE_TTL_MS).toISOString());
      return result.changes;
    })();
  }

  /**
   * Housekeeping: drop session rows that can no longer authenticate anybody
   * (fourth correction round, Codex P1).
   *
   * ## The defect this closes
   *
   * Every successful callback INSERTED a row and nothing ever deleted one.
   * Logout and back-channel revocation only set `revoked_at`; `resolve` refused
   * an expired row without removing it. So any authenticated identity account
   * could complete handoff after handoff and grow this table without bound —
   * and every row carries a realm id, an account id, a display name and an
   * identity session id, which makes unbounded growth a data-retention problem
   * as much as a disk one.
   *
   * ## Why it cannot take a live session with it
   *
   * A row is removable only once it is BOTH unusable and has been so for
   * `retentionMs`. Unusable means exactly what `resolve` refuses on: revoked
   * (`revoked_at` set) or past `expires_at`. A live session is neither, so it
   * matches neither candidate query — and the JS pass then re-checks, against
   * parsed instants, that the row `resolve` would still hand out is never in
   * the doomed set. That second pass is not belt-and-braces for its own sake:
   * the SQL comparison is lexicographic on ISO strings and must never be the
   * only thing standing between a signed-in Founder and a DELETE.
   *
   * ## Why two queries instead of one OR
   *
   * `WHERE expires_at <= ? OR revoked_at <= ?` bounds the rows RETURNED, not
   * the rows EXAMINED: SQLite cannot drive a single index from a disjunction
   * over two columns, so it would scan the whole growing live set on every
   * handoff. Two range scans, each ordered by its own indexed column and each
   * capped, are bounded by construction — the same reasoning that fixes the
   * ticket sweep next door.
   *
   * ## The tombstone is untouched
   *
   * Trap F's protection lives in `hq_revoked_origin_sessions`, a different
   * table with its own bounded horizon. Collecting a cold `hq_sessions` row
   * therefore cannot resurrect a signed-out identity session: the tombstone
   * that refuses the next `create` outlives the rows this deletes.
   */
  pruneColdSessions(
    now: Date = new Date(),
    options: { limit?: number; retentionMs?: number } = {},
  ): number {
    const limit = options.limit ?? HQ_SESSION_PRUNE_BATCH;
    const retentionMs = options.retentionMs ?? HQ_SESSION_PRUNE_RETENTION_MS;
    if (limit <= 0) return 0;
    const nowMs = now.getTime();
    const cutoffMs = nowMs - Math.max(0, retentionMs);
    const cutoff = new Date(cutoffMs).toISOString();

    const expired = this.#db
      .prepare(HQ_SESSION_EXPIRED_CANDIDATES_SQL)
      .all(cutoff, limit) as ColdSessionRow[];
    const revoked = this.#db
      .prepare(HQ_SESSION_REVOKED_CANDIDATES_SQL)
      .all(cutoff, limit) as ColdSessionRow[];

    const doomed = new Set<string>();
    for (const row of [...expired, ...revoked]) {
      if (doomed.size >= limit) break;
      const expiredLongEnough = Date.parse(row.expires_at) <= cutoffMs;
      const revokedLongEnough = row.revoked_at != null && Date.parse(row.revoked_at) <= cutoffMs;
      // A timestamp this cannot parse yields NaN, every comparison is false, and
      // the row survives. Keeping an unclassifiable row is the safe failure.
      if (!expiredLongEnough && !revokedLongEnough) continue;
      // The invariant, stated once and checked against `now` rather than the
      // cutoff: whatever `resolve` would still return is not collectable.
      const stillUsable = row.revoked_at == null && Date.parse(row.expires_at) > nowMs;
      if (stillUsable) continue;
      doomed.add(row.id);
    }

    if (doomed.size === 0) return 0;
    const ids = [...doomed];
    this.#db
      .prepare(`DELETE FROM hq_sessions WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
    return ids.length;
  }

  /** Is this identity session tombstoned? Exposed for tests and diagnostics. */
  isOriginSessionRevoked(originSessionId: string): boolean {
    if (!originSessionId) return false;
    return (
      this.#db
        .prepare(`SELECT origin_session_id FROM hq_revoked_origin_sessions WHERE origin_session_id = ?`)
        .get(originSessionId) != null
    );
  }
}
