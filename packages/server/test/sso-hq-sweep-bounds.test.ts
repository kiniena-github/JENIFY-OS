/**
 * Boundedness of the SSO ticket sweep (Phase 2, Stage 2, FOURTH Codex
 * correction round, P2).
 *
 * ## The finding
 *
 * `pruneExpiredTickets` runs on the authorize path — a human's sign-in — and
 * its `LIMIT 200` bounds the rows RETURNED, not the rows EXAMINED. Migration
 * 0012 indexed only `ticket_hash` and `origin_session_id`, and the sweep's
 * predicate was a disjunction over two OTHER columns, so SQLite had no index to
 * drive and scanned the whole growing live/grace set on every mint. Correct,
 * and unbounded, which on a sign-in path is the same defect as slow.
 *
 * ## What is asserted here
 *
 * `EXPLAIN QUERY PLAN` on the SHIPPED SQL, not a hand-copied lookalike:
 * `ticketSweepCandidateQueries` builds the exact statements the sweep issues,
 * and the plan for each must be an index range SEARCH with no table scan and no
 * temp b-tree sort. Alongside that, the behaviour the plan change must NOT have
 * altered: the same rows are collected, a live ticket still survives, and the
 * batch still caps the union of both reads rather than each one separately.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { ssoHqTickets } from '../src/db/schema.js';
import {
  pruneExpiredTickets,
  ticketSweepCandidateQueries,
  TICKET_PRUNE_BATCH,
} from '../src/services/sso-hq.js';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 24 * 3600_000);

let db: Db;
let tenant: TestTenant;

beforeEach(() => {
  db = testDb();
  tenant = makeTestTenant(db, 'SALTA');
});

function insertTicketRow(input: { id: string; expiresAt: Date; consumedAt?: Date | null }): void {
  db.insert(ssoHqTickets)
    .values({
      id: input.id,
      ticketHash: `hash-${input.id}`,
      audience: 'https://hq.example',
      redirectUri: 'https://hq.example/sso/callback',
      state: 'state-value',
      realmId: tenant.tenantId,
      accountId: 'acc-1',
      displayName: 'The Founder',
      sessionEstablishedAt: NOW.toISOString(),
      originSessionId: 'identity-session-1',
      createdAt: NOW.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      consumedAt: input.consumedAt ? input.consumedAt.toISOString() : null,
    })
    .run();
}

function ticketIds(): string[] {
  return db
    .select({ id: ssoHqTickets.id })
    .from(ssoHqTickets)
    .all()
    .map((r) => r.id)
    .sort();
}

/**
 * The plan for a drizzle query, taken from the query it will actually run.
 *
 * Going through `.toSQL()` is the point: a test that retyped the SQL would keep
 * passing after the shipped statement drifted back into a table scan.
 */
function planFor(query: { toSQL(): { sql: string; params: unknown[] } }): string {
  const { sql, params } = query.toSQL();
  const rows = db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join(' | ');
}

describe('migration 0013 ships the indexes the sweep needs', () => {
  it('creates both housekeeping indexes, and the consumed one is PARTIAL', () => {
    const indexes = (
      db.$client
        .prepare(`SELECT name, partial FROM pragma_index_list('sso_hq_tickets')`)
        .all() as { name: string; partial: number }[]
    ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.name]: row.partial }), {});

    expect(Object.keys(indexes)).toEqual(
      expect.arrayContaining(['sso_hq_tickets_expires_at', 'sso_hq_tickets_consumed_at']),
    );
    // `expires_at` is NOT NULL, so a full index is right. `consumed_at` is NULL
    // for every un-redeemed ticket, so a full index there would hold an entry
    // per LIVE row and the sweep would walk past all of them — the exact cost
    // this change exists to remove.
    expect(indexes.sso_hq_tickets_expires_at).toBe(0);
    expect(indexes.sso_hq_tickets_consumed_at).toBe(1);
  });

  it('the migration is applied by the normal migrate path, not by test setup', () => {
    // `testDb()` runs the real migrations folder. If 0013 were missing from the
    // journal this row would not exist and the assertion above could only pass
    // by accident.
    const applied = db.$client
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'sso_hq_tickets_%'`)
      .get() as { n: number };
    expect(applied.n).toBeGreaterThanOrEqual(4);
  });
});

describe('candidate selection is bounded, not a table scan (fourth round, Codex P2)', () => {
  it('the expired-candidate read seeks an index range', () => {
    const detail = planFor(ticketSweepCandidateQueries(db, NOW.toISOString(), TICKET_PRUNE_BATCH).expired);
    expect(detail).toContain('sso_hq_tickets_expires_at');
    expect(detail).toMatch(/SEARCH/);
    expect(detail).not.toMatch(/SCAN sso_hq_tickets\b(?! USING)/);
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('the consumed-candidate read uses the PARTIAL index, so live tickets are not walked', () => {
    const detail = planFor(
      ticketSweepCandidateQueries(db, NOW.toISOString(), TICKET_PRUNE_BATCH).consumed,
    );
    expect(detail).toContain('sso_hq_tickets_consumed_at');
    expect(detail).toMatch(/SEARCH/);
    expect(detail).not.toMatch(/SCAN sso_hq_tickets\b(?! USING)/);
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('a large live set does not enlarge the work of one sweep', () => {
    // 500 live tickets and 3 dead ones. Under the old OR predicate, finding the
    // three meant touching all 503 on every authorize.
    for (let i = 0; i < 500; i += 1) {
      insertTicketRow({ id: `live-${i}`, expiresAt: new Date(NOW.getTime() + 30_000) });
    }
    for (let i = 0; i < 3; i += 1) insertTicketRow({ id: `dead-${i}`, expiresAt: LONG_AGO });

    expect(pruneExpiredTickets(db, NOW)).toBe(3);
    expect(ticketIds().filter((id) => id.startsWith('live-')).length).toBe(500);
  });
});

describe('the plan change did not change WHICH rows are collectable', () => {
  it('still collects both expired and long-consumed rows in one sweep', () => {
    insertTicketRow({ id: 'expired', expiresAt: LONG_AGO });
    insertTicketRow({
      id: 'consumed',
      expiresAt: new Date(NOW.getTime() + 30_000),
      consumedAt: LONG_AGO,
    });
    insertTicketRow({ id: 'live', expiresAt: new Date(NOW.getTime() + 30_000) });

    expect(pruneExpiredTickets(db, NOW)).toBe(2);
    expect(ticketIds()).toEqual(['live']);
  });

  it('counts a row that is BOTH expired and consumed exactly once', () => {
    // The union has to deduplicate: this row matches both candidate reads, and
    // a sweep that reported 2 would be double-counting a single DELETE.
    insertTicketRow({ id: 'both', expiresAt: LONG_AGO, consumedAt: LONG_AGO });
    expect(pruneExpiredTickets(db, NOW)).toBe(1);
    expect(ticketIds()).toEqual([]);
  });

  it('the batch caps the UNION of both reads, not each read separately', () => {
    for (let i = 0; i < 5; i += 1) insertTicketRow({ id: `expired-${i}`, expiresAt: LONG_AGO });
    for (let i = 0; i < 5; i += 1) {
      insertTicketRow({
        id: `consumed-${i}`,
        expiresAt: new Date(NOW.getTime() + 30_000),
        consumedAt: LONG_AGO,
      });
    }

    // Six, not ten and not twelve: one bound over the whole sweep.
    expect(pruneExpiredTickets(db, NOW, { limit: 6 })).toBe(6);
    expect(ticketIds().length).toBe(4);
  });

  it('drains a backlog oldest-first', () => {
    for (let i = 0; i < 5; i += 1) {
      insertTicketRow({
        id: `dead-${i}`,
        expiresAt: new Date(LONG_AGO.getTime() + i * 60_000),
      });
    }
    expect(pruneExpiredTickets(db, NOW, { limit: 2 })).toBe(2);
    // The two oldest went first, which is the order the ORDER BY exists to give.
    expect(ticketIds()).toEqual(['dead-2', 'dead-3', 'dead-4']);
  });

  it('still refuses to touch a live ticket, whatever the plan', () => {
    insertTicketRow({ id: 'live', expiresAt: new Date(NOW.getTime() + 30_000) });
    expect(pruneExpiredTickets(db, NOW, { limit: 1_000, retentionMs: 0 })).toBe(0);
    expect(ticketIds()).toEqual(['live']);
  });
});
