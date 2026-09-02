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
   * Mint a session from redeemed claims.
   *
   * Returns the raw token exactly once, for the Set-Cookie. It is never stored
   * and cannot be recovered from the database afterwards.
   */
  create(claims: HqSsoClaims, now: Date = new Date()): { token: string; record: HqSessionRecord } {
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(16).toString('hex');
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
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
    return {
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
   * Revoke every HQ session derived from one identity-host session (trap C).
   *
   * Called from the back-channel logout the identity host fires on sign-out.
   * Returns the number revoked so the caller can audit it.
   */
  revokeByOriginSession(originSessionId: string, now: Date = new Date()): number {
    const result = this.#db
      .prepare(
        `UPDATE hq_sessions SET revoked_at = ?
          WHERE origin_session_id = ? AND revoked_at IS NULL`,
      )
      .run(now.toISOString(), originSessionId);
    return result.changes;
  }
}
