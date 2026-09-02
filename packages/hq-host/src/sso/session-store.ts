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
