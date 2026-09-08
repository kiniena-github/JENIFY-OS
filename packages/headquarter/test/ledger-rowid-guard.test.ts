/**
 * Wave 5, correction round thirteen — the ROWID channel on every declared
 * ledger.
 *
 * A fresh hostile review of `237fc76` reproduced this by execution:
 *
 *  - **HIGH 1 — one PERMITTED `INSERT` fabricated a permanent, unclearable safe
 *    mode.** `no_replace` fires only on a COLLIDING rowid, so an ordinary
 *    `INSERT` naming an explicit rowid ABOVE a declared ledger's current
 *    maximum was a write the append-only trio deliberately permitted. It widens
 *    `MAX(rowid) - COUNT(*)` exactly as removing a row from the middle does, and
 *    `committedLedgerGaps` reads that widening as proof of deletion. Measured
 *    against `237fc76` through this package's own file fixture:
 *    `hq_reliability_verdicts` went from `{rows:4, top:4}` to `{rows:5,
 *    top:104}` — the row count went UP and nothing was removed — and every
 *    later process reported `append_only_guard_missing`, `safeMode: true` at
 *    both depths and `releaseKillSwitch` REFUSED, for ever, with a
 *    Founder-facing detail that said the ledger held "fewer rows … or a gap
 *    where a row used to be".
 *
 * The two halves of the answer are both pinned here:
 *
 *  1. the write is REFUSED, on every declared ledger, by a guard that is part
 *     of the declaration rather than a per-table list — because a per-table
 *     enumeration standing in for "every declared ledger" is the defect class
 *     this round exists to close; and
 *  2. the guard never refuses what the ENGINE itself would allocate, including
 *     after a burned AUTOINCREMENT counter — a bound taken from the rows alone
 *     would stop HQ writing at all, which is strictly worse than the gap.
 *
 * The sweep is executed against every one of the 33 declared ledgers, using
 * each ledger's REAL `CREATE TABLE` text taken from a live HQ file, so it is not
 * a sample and no ledger can be quietly outside it.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fileFixture } from './reliability.fixture.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  LEDGER_ROWID_GUARD,
  declaredGuardsFor,
  declaredLedgerIdentities,
  ensureLedgerRowidGuards,
  missingImmutabilityGuards,
  regressedImmutableLedgers,
} from '../src/store/integrity.js';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

/** A live HQ file's own DDL for every declared ledger and its rowid guard. */
function liveSchema(): { table: string; create: string; guard: string }[] {
  const db = openMemoryHqDatabase();
  try {
    void new HeadquarterOperations(db);
    const objects = db.prepare(`SELECT name, tbl_name, type, sql FROM sqlite_master`).all() as {
      name: string;
      tbl_name: string;
      type: string;
      sql: string | null;
    }[];
    return ENGINE_IMMUTABLE_TABLES.map((entry) => {
      const create = objects.find((row) => row.type === 'table' && row.name === entry.table);
      const guard = objects.find(
        (row) => row.type === 'trigger' && row.name === `trg_${entry.triggerPrefix}_${LEDGER_ROWID_GUARD}`,
      );
      expect(create?.sql, `${entry.table} must exist on a live file`).toBeTruthy();
      expect(guard?.sql, `${entry.table} must carry its rowid guard`).toBeTruthy();
      return { table: entry.table, create: create!.sql!, guard: guard!.sql! };
    });
  } finally {
    db.close();
  }
}

/** One column value that satisfies a NOT NULL of the declared affinity. */
function filler(type: string): unknown {
  const declared = type.toUpperCase();
  if (declared.includes('INT')) return 0;
  if (declared.includes('REAL') || declared.includes('FLOA') || declared.includes('DOUB')) return 0;
  if (declared.includes('BLOB')) return Buffer.alloc(0);
  return '';
}

describe('an INSERT at a rowid the engine would not have allocated is refused', () => {
  /**
   * All 33, against their real schemas. The scratch file carries ONLY the
   * ledger and its rowid guard, so what is measured is that guard and nothing
   * else — the trio would refuse a colliding rowid, and a colliding rowid is
   * not what this defect used.
   */
  it('refuses the skipping INSERT on every one of the declared ledgers', () => {
    const schema = liveSchema();
    expect(schema.length).toBe(ENGINE_IMMUTABLE_TABLES.length);
    const accepted: string[] = [];
    const covered: string[] = [];
    for (const entry of schema) {
      const db = new Database(':memory:');
      try {
        // `sqlite_sequence` exists on every real HQ file, because 28 of the 33
        // declared ledgers are AUTOINCREMENT. The scratch file carries one
        // ledger, so the engine's counter table is made to exist here the same
        // way it does there — by an AUTOINCREMENT table — rather than the guard
        // being rewritten for the test.
        db.exec(`CREATE TABLE zz_autoincrement_present (seq INTEGER PRIMARY KEY AUTOINCREMENT)`);
        db.exec(`INSERT INTO zz_autoincrement_present DEFAULT VALUES`);
        db.exec(entry.create);
        db.exec(entry.guard);
        const columns = (db.prepare(`PRAGMA table_info("${entry.table}")`).all() as {
          name: string;
          type: string;
          pk: number;
        }[]).filter((column) => column.pk === 0);
        const insert = db.prepare(
          `INSERT INTO "${entry.table}" (rowid, ${columns.map((c) => `"${c.name}"`).join(', ')})
           VALUES (?, ${columns.map(() => '?').join(', ')})`,
        );
        // The first row lands at the rowid the engine would itself allocate, so
        // the guard is proven to permit an ordinary append on this schema
        // before it is asked to refuse anything.
        insert.run([1, ...columns.map((column) => filler(column.type) as never)]);
        covered.push(entry.table);
        // And the attack: an explicit rowid far above the top, colliding with
        // nothing.
        try {
          insert.run([500, ...columns.map((column) => filler(column.type) as never)]);
          accepted.push(entry.table);
        } catch (error) {
          expect(String((error as Error).message)).toContain('rowids are contiguous');
        }
      } finally {
        db.close();
      }
    }
    // Every declared ledger took the ordinary append, so none passed the
    // refusal check merely by rejecting both writes.
    expect(covered.length, 'every declared ledger must take an ordinary append').toBe(
      ENGINE_IMMUTABLE_TABLES.length,
    );
    expect(accepted, 'a declared ledger accepted an INSERT at a skipped rowid').toEqual([]);
  });

  /**
   * The same act on a REAL file through the real facade, end to end, because
   * the claim being pinned is about what a raw writer can do to HQ's own store
   * and what HQ then tells the Founder.
   */
  it('leaves a real store clean where the same statement used to condemn it for ever', () => {
    const fx = fileFixture();
    try {
      for (let pass = 0; pass < 4; pass += 1) {
        expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      }
      fx.db.close();

      const raw = fx.raw();
      const table = 'hq_reliability_verdicts';
      const before = raw
        .prepare(`SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top FROM "${table}"`)
        .get() as { rows: number; top: number };
      expect(before.rows).toBeGreaterThan(0);
      expect(before.top).toBe(before.rows);
      const row = raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT 1`).get() as Record<
        string,
        unknown
      >;
      const columns = Object.keys(row);
      // Its own last row, at a rowid a hundred above the top and colliding with
      // nothing — the exact statement that was ACCEPTED before this round.
      expect(() =>
        raw
          .prepare(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(
            columns.map((column) =>
              column === 'seq'
                ? ((before.top + 100) as never)
                : column === 'id'
                  ? (`${String(row.id)}-forged` as never)
                  : (row[column] as never),
            ),
          ),
      ).toThrow(/rowids are contiguous/);
      const after = raw
        .prepare(`SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top FROM "${table}"`)
        .get() as { rows: number; top: number };
      expect(after).toEqual(before);
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      raw.close();

      for (const tag of ['p2', 'p3', 'p4', 'p5']) {
        const process = fx.reopen(tag);
        const posture = process.ops.hqReliabilityPosture().integrity;
        expect(posture.safeMode, `${tag} boot`).toBe(false);
        expect(findings(posture.observations), `${tag} boot`).toEqual([]);
        const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok).toBe(true);
        if (!assessed.ok) throw new Error('unreachable');
        expect(assessed.data.safeMode, `${tag} assess`).toBe(false);
        expect(process.ops.releaseKillSwitch('global', 'founder').ok, `${tag} release`).toBe(true);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The price, counted rather than asserted: the guard is a trigger, so it is
   * the same standing residual every other engine guard has — dropped, written
   * through, re-created, and never observed missing by a census that reads
   * `sqlite_master` at construction time only. What is closed is the INVERSION,
   * where fabricating a permanent finding cost ONE ordinary statement while
   * everything else HQ defends against cost three.
   */
  it('still falls to three statements, and that is what the residual is priced at', () => {
    const fx = fileFixture();
    try {
      for (let pass = 0; pass < 4; pass += 1) {
        expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      }
      fx.db.close();
      const raw = fx.raw();
      const table = 'hq_reliability_verdicts';
      const guard = raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
        .get(`trg_${table}_${LEDGER_ROWID_GUARD}`) as { sql: string };
      const row = raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT 1`).get() as Record<
        string,
        unknown
      >;
      const columns = Object.keys(row);
      let statements = 0;
      raw.exec(`DROP TRIGGER trg_${table}_${LEDGER_ROWID_GUARD}`);
      statements += 1;
      raw
        .prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .run(
          columns.map((column) =>
            column === 'seq'
              ? (104 as never)
              : column === 'id'
                ? (`${String(row.id)}-forged` as never)
                : (row[column] as never),
          ),
        );
      statements += 1;
      raw.exec(guard.sql);
      statements += 1;
      expect(statements).toBe(3);
      // The guard is back, so the census has nothing to say — which is what
      // makes this a residual rather than a hole, and it is recorded at this
      // price in the phase document rather than argued away.
      expect(missingImmutabilityGuards(raw)).toEqual([]);
      expect(regressedImmutableLedgers(raw)).toEqual([table]);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('the guard permits everything the engine itself would allocate', () => {
  /**
   * The anti-bricking half, and the reason the bound names `sqlite_sequence` as
   * well as the rows. `INSERT OR IGNORE` on a conflict and
   * `INSERT … ON CONFLICT … DO NOTHING` both RAISE the AUTOINCREMENT counter
   * without inserting a row (measured below), so the engine's next append lands
   * past `MAX(rowid) + 1`. No such statement targets a declared ledger — that is
   * what `ledger-rowid-contiguity.test.ts` asserts from the source — but a bound
   * that refused the engine's own allocation would stop HQ writing at all if one
   * ever did, which is strictly worse than the rowid hole it opens.
   */
  it('takes the engine’s next append after a burned AUTOINCREMENT counter', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT UNIQUE)`);
      db.exec(
        `CREATE TRIGGER trg_ledger_no_rowid_skip BEFORE INSERT ON "ledger"
         WHEN NEW.rowid > 1 + MAX(COALESCE((SELECT MAX(rowid) FROM "ledger"), 0),
                                  COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'ledger'), 0))
         BEGIN SELECT RAISE(ABORT, 'ledger rowids are contiguous'); END;`,
      );
      const state = () => {
        const counted = db.prepare(`SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top FROM ledger`).get() as {
          rows: number;
          top: number;
        };
        const mark = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'ledger'`).get() as
          | { seq: number }
          | undefined;
        return { ...counted, sequence: mark?.seq ?? 0 };
      };
      db.prepare(`INSERT INTO ledger (k) VALUES ('a')`).run();
      db.prepare(`INSERT INTO ledger (k) VALUES ('b')`).run();
      expect(state()).toEqual({ rows: 2, top: 2, sequence: 2 });

      // Both of the constructs the engine burns a counter on, executed rather
      // than assumed — the round-twelve text named only the `DO UPDATE` branch.
      db.prepare(`INSERT OR IGNORE INTO ledger (k) VALUES ('a')`).run();
      expect(state()).toEqual({ rows: 2, top: 2, sequence: 3 });
      db.prepare(`INSERT INTO ledger (k) VALUES ('b') ON CONFLICT DO NOTHING`).run();
      expect(state()).toEqual({ rows: 2, top: 2, sequence: 4 });

      // And the engine's own next append — at rowid 5, which is THREE above the
      // greatest row held — is permitted. A bound taken from the rows alone
      // would have refused it and stopped the ledger dead.
      db.prepare(`INSERT INTO ledger (k) VALUES ('c')`).run();
      expect(state()).toEqual({ rows: 3, top: 5, sequence: 5 });

      // What is still refused is a rowid beyond what the engine would allocate.
      expect(() => db.prepare(`INSERT INTO ledger (rowid, k) VALUES (99, 'd')`).run()).toThrow(
        /rowids are contiguous/,
      );
    } finally {
      db.close();
    }
  });

  /**
   * No false alarm on an ordinary store: the guard is on every declared ledger
   * of a real file, and a real workload writes to them without ever meeting it.
   */
  it('never refuses an ordinary HQ write, and leaves no rowid hole behind', () => {
    const fx = fileFixture();
    try {
      for (let pass = 0; pass < 5; pass += 1) {
        expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
        expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      }
      const identities = declaredLedgerIdentities(fx.db as HqDatabase);
      const populated = Object.entries(identities).filter(([, identity]) => identity.rows > 0);
      expect(populated.length).toBeGreaterThan(0);
      for (const [table, identity] of populated) {
        expect(identity.top, `${table} must have no rowid hole`).toBe(identity.rows);
      }
      expect(missingImmutabilityGuards(fx.db as HqDatabase)).toEqual([]);
      expect(regressedImmutableLedgers(fx.db as HqDatabase)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The declaration is complete BY CONSTRUCTION rather than by a maintained
   * list: the guard is appended in `declaredGuardsFor`, so a ledger cannot be
   * declared without declaring it, and `ensureLedgerRowidGuards` iterates the
   * declaration itself.
   */
  it('declares and installs the guard on every declared ledger, from the declaration', () => {
    const undeclared = ENGINE_IMMUTABLE_TABLES.filter(
      (entry) => !declaredGuardsFor(entry).includes(`trg_${entry.triggerPrefix}_${LEDGER_ROWID_GUARD}`),
    ).map((entry) => entry.table);
    expect(undeclared).toEqual([]);

    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      const live = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as {
          name: string;
        }[]).map((row) => row.name),
      );
      const absent = ENGINE_IMMUTABLE_TABLES.filter(
        (entry) => !live.has(`trg_${entry.triggerPrefix}_${LEDGER_ROWID_GUARD}`),
      ).map((entry) => entry.table);
      expect(absent, 'every declared ledger must carry the installed guard').toEqual([]);
      expect(missingImmutabilityGuards(db)).toEqual([]);

      // Idempotent, and re-created rather than left alone, so a ledger that
      // gained `sqlite_sequence` since the last construction is rebound.
      ensureLedgerRowidGuards(db);
      ensureLedgerRowidGuards(db);
      expect(missingImmutabilityGuards(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
