/**
 * HQ session housekeeping (Phase 2, Stage 2, FOURTH Codex correction round).
 *
 * ## The finding
 *
 * Every successful callback INSERTED an `hq_sessions` row and nothing ever
 * deleted one. HQ sign-out and back-channel revocation only set `revoked_at`;
 * `resolve` refused an expired row without collecting it. So any authenticated
 * identity account could complete handoff after handoff and grow the HQ
 * database without bound — with a realm id, an account id, a display name and
 * an identity session id per row, which makes it a retention problem as much as
 * a disk one.
 *
 * ## What this suite has to prove, and in which direction
 *
 * The dangerous fix here is not "fails to collect" — that is the status quo and
 * it is merely untidy. The dangerous fix is one that collects a session a
 * signed-in human is still using, which would sign the Founder out at random.
 * So every collection assertion below is paired with a survival assertion, the
 * candidate reads are checked to be index-supported rather than table scans
 * (a `LIMIT` bounds rows RETURNED, not rows EXAMINED), and trap F's tombstone
 * is re-proved to outlive the rows the sweep removes.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '@factoryos/headquarter/store';
import {
  HQ_SESSION_EXPIRED_CANDIDATES_SQL,
  HQ_SESSION_PRUNE_BATCH,
  HQ_SESSION_PRUNE_RETENTION_MS,
  HQ_SESSION_REVOKED_CANDIDATES_SQL,
  HQ_SESSION_TTL_MS,
  HqSessionStore,
  type HqSsoClaims,
} from '../src/index.js';

const NOW = new Date('2026-09-02T12:00:00.000Z');

let db: HqDatabase;
let store: HqSessionStore;

beforeEach(() => {
  db = openMemoryHqDatabase();
  store = new HqSessionStore(db);
});

function claims(originSessionId: string): HqSsoClaims {
  return {
    realmId: 'realm',
    accountId: 'acc-1',
    displayName: 'Proof Founder',
    sessionEstablishedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    originSessionId,
  };
}

function sessionCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM hq_sessions`).get() as { n: number }).n;
}

function sessionIds(): string[] {
  return (db.prepare(`SELECT id FROM hq_sessions ORDER BY id`).all() as { id: string }[]).map(
    (r) => r.id,
  );
}

/** Write a row directly, so a backlog exists without minting one handoff at a time. */
function insertSessionRow(input: {
  id: string;
  expiresAt: Date;
  revokedAt?: Date | null;
}): void {
  db.prepare(
    `INSERT INTO hq_sessions
       (id, token_hash, realm_id, account_id, display_name,
        session_established_at, origin_session_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, 'realm', 'acc-1', 'Proof Founder', ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    `hash-${input.id}`,
    NOW.toISOString(),
    `origin-${input.id}`,
    NOW.toISOString(),
    input.expiresAt.toISOString(),
    input.revokedAt ? input.revokedAt.toISOString() : null,
  );
}

describe('cold HQ session rows are collected (fourth round, Codex P1)', () => {
  it('collects rows that expired long ago', () => {
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    insertSessionRow({ id: 'expired-long-ago', expiresAt: longAgo });
    expect(sessionCount()).toBe(1);

    expect(store.pruneColdSessions(NOW)).toBe(1);
    expect(sessionCount()).toBe(0);
  });

  it('collects rows revoked long ago, even though they had not expired', () => {
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    insertSessionRow({
      id: 'revoked-long-ago',
      // Still inside its TTL — only the revocation makes it cold.
      expiresAt: new Date(NOW.getTime() + HQ_SESSION_TTL_MS),
      revokedAt: longAgo,
    });

    expect(store.pruneColdSessions(NOW)).toBe(1);
    expect(sessionCount()).toBe(0);
  });

  it('NEVER collects a session a signed-in human is still using', () => {
    const created = store.create(claims('origin-live'), NOW);
    expect(created.ok).toBe(true);
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    insertSessionRow({ id: 'dead', expiresAt: longAgo });

    // The sweep runs with a very generous batch and still leaves the live row.
    expect(store.pruneColdSessions(NOW, { limit: 1_000 })).toBe(1);
    expect(sessionIds()).toEqual([created.ok ? created.record.id : '']);
    // And the cookie still resolves, which is the assertion that actually
    // matters to the human holding it.
    const token = created.ok ? created.token : '';
    expect(store.resolve(token, NOW)?.accountId).toBe('acc-1');
  });

  it('a zero-retention sweep still refuses to take an unexpired, unrevoked row', () => {
    // The hostile shape: retention collapsed to nothing, so the cutoff IS now.
    // Only the `resolve`-parity guard stands between a live session and DELETE.
    const created = store.create(claims('origin-live'), NOW);
    expect(store.pruneColdSessions(NOW, { retentionMs: 0 })).toBe(0);
    expect(sessionCount()).toBe(1);
    expect(store.resolve(created.ok ? created.token : '', NOW)).not.toBeNull();
  });

  it('keeps a just-revoked row for the grace window, then collects it', () => {
    const created = store.create(claims('origin-1'), NOW);
    const token = created.ok ? created.token : '';
    store.revoke(token, NOW);
    // Already refused, immediately — the grace grants no authority.
    expect(store.resolve(token, NOW)).toBeNull();

    expect(store.pruneColdSessions(NOW)).toBe(0);
    expect(sessionCount()).toBe(1);

    const later = new Date(NOW.getTime() + HQ_SESSION_PRUNE_RETENTION_MS + 1_000);
    expect(store.pruneColdSessions(later)).toBe(1);
    expect(sessionCount()).toBe(0);
    expect(store.resolve(token, later)).toBeNull();
  });

  it('collects sessions killed by back-channel revocation once they are cold', () => {
    const created = store.create(claims('origin-shared'), NOW);
    expect(store.revokeByOriginSession('origin-shared', NOW)).toBe(1);

    const later = new Date(NOW.getTime() + HQ_SESSION_PRUNE_RETENTION_MS + 1_000);
    expect(store.pruneColdSessions(later)).toBe(1);
    expect(sessionCount()).toBe(0);
    expect(store.resolve(created.ok ? created.token : '', later)).toBeNull();
  });

  it('is bounded: one sweep removes at most its batch size', () => {
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    for (let i = 0; i < 25; i += 1) insertSessionRow({ id: `dead-${i}`, expiresAt: longAgo });

    expect(store.pruneColdSessions(NOW, { limit: 10 })).toBe(10);
    expect(sessionCount()).toBe(15);
    expect(store.pruneColdSessions(NOW, { limit: 10 })).toBe(10);
    expect(store.pruneColdSessions(NOW, { limit: 10 })).toBe(5);
    expect(sessionCount()).toBe(0);
    // The shipped bound is a real number, not an accident of the default.
    expect(HQ_SESSION_PRUNE_BATCH).toBeGreaterThan(0);
  });

  it('the batch caps the UNION of both candidate reads, not each one separately', () => {
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    for (let i = 0; i < 5; i += 1) insertSessionRow({ id: `expired-${i}`, expiresAt: longAgo });
    for (let i = 0; i < 5; i += 1) {
      insertSessionRow({
        id: `revoked-${i}`,
        expiresAt: new Date(NOW.getTime() + HQ_SESSION_TTL_MS),
        revokedAt: longAgo,
      });
    }

    expect(store.pruneColdSessions(NOW, { limit: 6 })).toBe(6);
    expect(sessionCount()).toBe(4);
  });

  it('a row that is BOTH expired and revoked is counted once, not twice', () => {
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    insertSessionRow({ id: 'both', expiresAt: longAgo, revokedAt: longAgo });

    expect(store.pruneColdSessions(NOW)).toBe(1);
    expect(sessionCount()).toBe(0);
  });

  it('an unparseable timestamp keeps the row rather than guessing', () => {
    insertSessionRow({ id: 'weird', expiresAt: new Date(NOW.getTime() - 24 * 3600_000) });
    db.prepare(`UPDATE hq_sessions SET expires_at = 'not-a-date' WHERE id = 'weird'`).run();

    expect(store.pruneColdSessions(NOW)).toBe(0);
    expect(sessionCount()).toBe(1);
    // It is still not usable: `resolve` refuses NaN expiry rather than honouring it.
    expect(store.resolve('anything', NOW)).toBeNull();
  });
});

describe('the sweep runs on the one path that adds rows', () => {
  it('a handoff collects the backlog left by earlier handoffs', () => {
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    for (let i = 0; i < 3; i += 1) insertSessionRow({ id: `dead-${i}`, expiresAt: longAgo });
    expect(sessionCount()).toBe(3);

    const created = store.create(claims('origin-new'), NOW);
    expect(created.ok).toBe(true);
    // The three cold rows are gone and the brand-new one is not.
    expect(sessionIds()).toEqual([created.ok ? created.record.id : '']);
  });

  it('repeated handoffs by one account do not grow the table without bound', () => {
    // The reported abuse: an authenticated account completing handoff after
    // handoff. Each handoff here is one hour apart, so the previous session has
    // expired and passed its grace by the time the next one arrives.
    let at = NOW;
    for (let i = 0; i < 40; i += 1) {
      at = new Date(at.getTime() + HQ_SESSION_TTL_MS + HQ_SESSION_PRUNE_RETENTION_MS + 1_000);
      store.create(claims(`origin-${i}`), at);
    }
    // Before the fix this was 40 and climbing. The steady state is the one live
    // session; nothing older than a lifetime plus its grace survives.
    expect(sessionCount()).toBe(1);
  });

  it('housekeeping failure never fails a sign-in', () => {
    // A connection on which ONLY the sweep's reads blow up. Housekeeping is not
    // allowed to take a human's sign-in down with it: the session must still be
    // created, returned and resolvable, and the uncollected rows simply wait for
    // the next handoff.
    const sabotaged = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql === HQ_SESSION_EXPIRED_CANDIDATES_SQL || sql === HQ_SESSION_REVOKED_CANDIDATES_SQL) {
              throw new Error('disk I/O error');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as HqDatabase;

    insertSessionRow({ id: 'dead', expiresAt: new Date(NOW.getTime() - 24 * 3600_000) });
    const broken = new HqSessionStore(sabotaged);
    const created = broken.create(claims('origin-ok'), NOW);

    expect(created.ok).toBe(true);
    expect(broken.resolve(created.ok ? created.token : '', NOW)).not.toBeNull();
    // The sweep threw, so the cold row survives — the harmless failure of the two.
    expect(sessionIds()).toContain('dead');
  });
});

describe('trap F survives housekeeping', () => {
  it('a tombstone still refuses a late handoff after the session rows are collected', () => {
    const created = store.create(claims('origin-signed-out'), NOW);
    expect(created.ok).toBe(true);
    // Sign-out: revokes the row AND writes the durable tombstone.
    store.revokeByOriginSession('origin-signed-out', NOW);

    const later = new Date(NOW.getTime() + HQ_SESSION_PRUNE_RETENTION_MS + 1_000);
    expect(store.pruneColdSessions(later)).toBe(1);
    expect(sessionCount()).toBe(0);

    // The tombstone is in a DIFFERENT table with its own horizon, so collecting
    // the session row cannot resurrect the signed-out identity session.
    expect(store.isOriginSessionRevoked('origin-signed-out')).toBe(true);
    expect(store.create(claims('origin-signed-out'), later)).toEqual({
      ok: false,
      reason: 'origin_session_revoked',
    });
    expect(sessionCount()).toBe(0);
  });
});

describe('candidate selection is index-supported, not a table scan', () => {
  /**
   * `EXPLAIN QUERY PLAN` is the only honest proof here. A `LIMIT` bounds the
   * rows RETURNED; only the plan says how many were EXAMINED to find them, and
   * that is exactly the distinction the finding turned on.
   */
  function plan(sql: string, params: unknown[]): string {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[];
    return rows.map((r) => r.detail).join(' | ');
  }

  it('the expired-candidate read seeks an index range instead of scanning', () => {
    const detail = plan(HQ_SESSION_EXPIRED_CANDIDATES_SQL, [NOW.toISOString(), 200]);
    expect(detail).toContain('idx_hq_sessions_expires_at');
    expect(detail).toMatch(/SEARCH/);
    expect(detail).not.toMatch(/SCAN hq_sessions\b(?! USING)/);
    // An ORDER BY satisfied by the index, so there is no sort of the whole set.
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('the revoked-candidate read uses the PARTIAL index, so live rows are not walked', () => {
    const detail = plan(HQ_SESSION_REVOKED_CANDIDATES_SQL, [NOW.toISOString(), 200]);
    expect(detail).toContain('idx_hq_sessions_revoked_at');
    expect(detail).toMatch(/SEARCH/);
    expect(detail).not.toMatch(/SCAN hq_sessions\b(?! USING)/);
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('both housekeeping indexes are actually created by the store DDL', () => {
    const indexes = (
      db
        .prepare(`SELECT name, partial FROM pragma_index_list('hq_sessions')`)
        .all() as { name: string; partial: number }[]
    ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.name]: row.partial }), {});

    expect(Object.keys(indexes)).toEqual(
      expect.arrayContaining(['idx_hq_sessions_expires_at', 'idx_hq_sessions_revoked_at']),
    );
    // `expires_at` is NOT NULL so a full index is right; `revoked_at` is NULL
    // for every live session, so its index MUST be partial or it would hold an
    // entry per live row — the growth this whole change is about.
    expect(indexes.idx_hq_sessions_expires_at).toBe(0);
    expect(indexes.idx_hq_sessions_revoked_at).toBe(1);
  });

  it('a large live set does not enlarge the work of one sweep', () => {
    // 500 live sessions, 3 cold ones. If the plan were a table scan, finding the
    // three would mean touching all 503 on every single handoff.
    for (let i = 0; i < 500; i += 1) {
      insertSessionRow({
        id: `live-${i}`,
        expiresAt: new Date(NOW.getTime() + HQ_SESSION_TTL_MS),
      });
    }
    const longAgo = new Date(NOW.getTime() - 24 * 3600_000);
    for (let i = 0; i < 3; i += 1) insertSessionRow({ id: `cold-${i}`, expiresAt: longAgo });

    expect(store.pruneColdSessions(NOW)).toBe(3);
    expect(sessionCount()).toBe(500);
  });
});
