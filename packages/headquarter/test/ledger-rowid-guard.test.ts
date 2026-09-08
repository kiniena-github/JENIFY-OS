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
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  LEDGER_ROWID_GUARD,
  LEDGER_ROWID_SEAT_GUARD,
  committedRemovalsBelowMark,
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

/**
 * The same, made DISTINCT per row: several declared ledgers carry a UNIQUE
 * index, so a probe that reuses one filler would be refused by the engine
 * rather than by the guard it means to measure.
 */
function distinctFiller(type: string, tag: number): unknown {
  const value = filler(type);
  return typeof value === 'string' ? `filler-${tag}` : value;
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

/**
 * Wave 5, correction round fourteen — the OTHER side of the same channel.
 *
 * Two fresh hostile reviewers reproduced these at `8481269`, and both went
 * through the side `no_rowid_skip` does not bound:
 *
 *  - **HIGH 1 — a mid-ledger deletion laundered back to a completely clean
 *    store by ONE further PERMITTED `INSERT`.** Control (delete rowid 6 of an
 *    11-row `hq_reliability_verdicts`, guards restored, three statements):
 *    `regressed ["hq_reliability_verdicts"]`, structural `safeMode true`.
 *    Attack (+ one `INSERT` at the freed rowid, nothing dropped, every guard in
 *    place): `missingGuards [] regressed [] truncated []`, structural
 *    `safeMode false`. Four statements to a clean store against three for a
 *    finding that stands — and silent on 30 of the 33 declared ledgers,
 *    including the safe-mode latch ledger itself.
 *  - **HIGH 2 — one `INSERT` at rowid `-1` bricked HQ's own appends.** An
 *    auto-assigned rowid presents as the integer `-1` in a `BEFORE INSERT`
 *    trigger on this engine, so a row planted AT -1 made `no_replace`'s
 *    `EXISTS (… WHERE seq = NEW.seq)` true for ever. Executed on `op_evidence`:
 *    the plant was ACCEPTED with no trigger dropped, every integrity reading
 *    said the store was clean, and `engageKillSwitch` and `assessHqIntegrity`
 *    then BOTH threw `SqliteError: op_evidence is append-only` uncaught.
 *
 * Both are closed at the write by `no_rowid_reseat`, and both halves are pinned
 * here: the refusal on every one of the 33 declared ledgers against their real
 * schemas, and the end-to-end act on a real file through the real facade.
 */
describe('an INSERT at a rowid the engine has already passed is refused', () => {
  /** Both universal guards, as `ensureLedgerRowidGuards` installs them. */
  function liveRowidGuards(): { table: string; create: string; guards: string[] }[] {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      const objects = db.prepare(`SELECT name, type, sql FROM sqlite_master`).all() as {
        name: string;
        type: string;
        sql: string | null;
      }[];
      return ENGINE_IMMUTABLE_TABLES.map((entry) => {
        const create = objects.find((row) => row.type === 'table' && row.name === entry.table);
        const guards = [LEDGER_ROWID_GUARD, LEDGER_ROWID_SEAT_GUARD].map((guard) => {
          const found = objects.find(
            (row) => row.type === 'trigger' && row.name === `trg_${entry.triggerPrefix}_${guard}`,
          );
          expect(found?.sql, `${entry.table} must carry ${guard}`).toBeTruthy();
          return found!.sql!;
        });
        expect(create?.sql, `${entry.table} must exist on a live file`).toBeTruthy();
        return { table: entry.table, create: create!.sql!, guards };
      });
    } finally {
      db.close();
    }
  }

  /**
   * All 33, against their real schemas, in every spelling of "below the top" a
   * caller can compose: the freed hole a deletion leaves, rowid 0, and the -1
   * an omitted AUTOINCREMENT key presents as. The sweep is the declaration
   * itself, so no ledger can be quietly outside it.
   */
  it('refuses the reseating INSERT on every one of the declared ledgers', () => {
    const schema = liveRowidGuards();
    expect(schema.length).toBe(ENGINE_IMMUTABLE_TABLES.length);
    const accepted: string[] = [];
    const covered: string[] = [];
    for (const entry of schema) {
      const db = new Database(':memory:');
      try {
        db.exec(`CREATE TABLE zz_autoincrement_present (seq INTEGER PRIMARY KEY AUTOINCREMENT)`);
        db.exec(`INSERT INTO zz_autoincrement_present DEFAULT VALUES`);
        db.exec(entry.create);
        for (const guard of entry.guards) db.exec(guard);
        const columns = (db.prepare(`PRAGMA table_info("${entry.table}")`).all() as {
          name: string;
          type: string;
          pk: number;
        }[]).filter((column) => column.pk === 0);
        // Distinct values per row: several declared ledgers carry a UNIQUE
        // index, and a repeated filler would be refused by the engine rather
        // than by the guard under test.
        let tag = 0;
        const values = () => {
          tag += 1;
          return columns.map((column) => distinctFiller(column.type, tag) as never);
        };
        const insert = db.prepare(
          `INSERT INTO "${entry.table}" (rowid, ${columns.map((c) => `"${c.name}"`).join(', ')})
           VALUES (?, ${columns.map(() => '?').join(', ')})`,
        );
        // EMPTY first: a plant at rowid -1 or 0 here has no greater row to be
        // compared against, so it is the `NEW.rowid < 1` clause alone that
        // refuses it — and it is the case that bricks a ledger, because every
        // later auto-assigned append then reads `NEW.seq = -1` in the
        // `no_replace` clause and collides with the plant for ever.
        for (const seat of [-1, 0]) {
          try {
            insert.run([seat, ...values()]);
            accepted.push(`${entry.table}@empty${seat}`);
          } catch (error) {
            expect(String((error as Error).message)).toContain('rowids are append-only');
          }
        }
        // Three ordinary appends, so the ledger has a middle to reseat into and
        // so the guard is proven to permit an append on this schema before it
        // is asked to refuse anything.
        for (const rowid of [1, 2, 3]) insert.run([rowid, ...values()]);
        // Free the middle the way a mid-ledger deletion does — with the erase
        // guard absent, which is what that attack pays for — and then try to
        // fill it back in with the guards standing.
        db.exec(`DELETE FROM "${entry.table}" WHERE rowid = 2`);
        covered.push(entry.table);
        for (const reseat of [2, 0, -1]) {
          try {
            insert.run([reseat, ...values()]);
            accepted.push(`${entry.table}@${reseat}`);
          } catch (error) {
            expect(String((error as Error).message)).toContain('rowids are append-only');
          }
        }
        // And the ordinary next append is still taken, at the top, so the
        // refusal above is a bound rather than a brick.
        insert.run([4, ...values()]);
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM "${entry.table}"`).get() as { n: number }).n,
        ).toBe(3);
      } finally {
        db.close();
      }
    }
    expect(covered.length, 'every declared ledger must take an ordinary append').toBe(
      ENGINE_IMMUTABLE_TABLES.length,
    );
    expect(accepted, 'a declared ledger accepted an INSERT at a reseated rowid').toEqual([]);
  });

  /**
   * The laundering act, end to end on a real file through the real facade: the
   * control that must stay blocking, and the one further statement that used to
   * clear it.
   */
  it('keeps a mid-ledger deletion blocking however much is appended afterwards', () => {
    const fx = fileFixture();
    try {
      const table = 'hq_reliability_verdicts';
      const seed = fx.db.prepare(
        `INSERT INTO ${table} (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
         VALUES (?, '2026-01-01T00:00:00.000Z', 'full', 0, '[]', 'p', 'founder')`,
      );
      for (let i = 0; i < 10; i += 1) seed.run(`seed-${i}`);
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      fx.db.close();

      const raw = fx.raw();
      const committed = declaredLedgerIdentities(raw)[table];
      expect(committed.rows).toBe(committed.top);
      const rowids = (
        raw.prepare(`SELECT rowid AS rid FROM "${table}" ORDER BY rid`).all() as { rid: number }[]
      ).map((row) => row.rid);
      const victim = rowids[Math.floor(rowids.length / 2)];
      const whole = raw.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(victim) as Record<
        string,
        unknown
      >;
      const columns = Object.keys(whole);
      const guards = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(table) as { name: string; sql: string }[];

      // The CONTROL: the mid-ledger deletion, at its three-statement price,
      // with every guard put back.
      for (const guard of guards) raw.exec(`DROP TRIGGER ${guard.name}`);
      raw.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(victim);
      for (const guard of guards) raw.exec(guard.sql);
      expect(missingImmutabilityGuards(raw)).toEqual([]);
      expect(regressedImmutableLedgers(raw)).toEqual([table]);

      // The ATTACK: ONE further PERMITTED `INSERT` at the freed rowid, nothing
      // dropped. It is refused, and the finding stands.
      expect(() =>
        raw
          .prepare(
            `INSERT INTO "${table}" (rowid, ${columns.map((c) => `"${c}"`).join(', ')})
             VALUES (?, ${columns.map(() => '?').join(', ')})`,
          )
          .run([victim, ...columns.map((column) => whole[column] as never)]),
      ).toThrow(/rowids are append-only/);
      expect(regressedImmutableLedgers(raw)).toEqual([table]);
      // Nor by any other spelling of the same reseat.
      for (const spelling of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) {
        expect(() =>
          raw
            .prepare(
              `${spelling} INTO "${table}" (rowid, ${columns.map((c) => `"${c}"`).join(', ')})
               VALUES (?, ${columns.map(() => '?').join(', ')})`,
            )
            .run([victim, ...columns.map((column) => whole[column] as never)]),
        ).toThrow(/rowids are append-only/);
      }
      raw.close();

      for (const tag of ['p2', 'p3']) {
        const process = fx.reopen(tag);
        const posture = process.ops.hqReliabilityPosture().integrity;
        expect(posture.safeMode, `${tag} boot`).toBe(true);
        expect(findings(posture.observations), `${tag} boot`).toContain(
          'append_only_guard_missing',
        );
        const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok).toBe(true);
        if (!assessed.ok) throw new Error('unreachable');
        expect(assessed.data.safeMode, `${tag} assess`).toBe(true);
        expect(
          process.ops.releaseKillSwitch('global', 'founder').ok,
          `${tag} release must stay refused`,
        ).toBe(false);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The `-1` plant, and the two things it took away: HQ's own appends, and the
   * Founder's stop button. `op_evidence` is the ledger the reviewer used,
   * because `appendEvidence` is on the path of every command HQ has.
   */
  it('refuses the rowid -1 plant that bricked HQ’s own appends', () => {
    const fx = fileFixture();
    try {
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);

      const raw = fx.db as unknown as Database.Database;
      const seed = raw.prepare(`SELECT * FROM op_evidence ORDER BY seq LIMIT 1`).get() as Record<
        string,
        unknown
      >;
      const columns = Object.keys(seed).filter((column) => column !== 'seq');
      for (const spelling of ['INSERT', 'INSERT OR REPLACE', 'INSERT OR IGNORE']) {
        expect(() =>
          raw
            .prepare(
              `${spelling} INTO op_evidence (seq, ${columns.map((c) => `"${c}"`).join(', ')})
               VALUES (-1, ${columns.map(() => '?').join(', ')})`,
            )
            .run(
              columns.map((column) =>
                column === 'id' ? (`planted-${spelling}` as never) : (seed[column] as never),
              ),
            ),
        ).toThrow(/rowids are append-only/);
      }
      expect(
        (raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE seq < 1`).get() as { n: number })
          .n,
        'nothing may sit below rowid 1 on a declared ledger',
      ).toBe(0);

      // And the two acts the plant used to take away still work.
      expect(fx.ops.engageKillSwitch('global', 'founder', 'stop everything').ok).toBe(true);
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      expect(missingImmutabilityGuards(fx.db as HqDatabase)).toEqual([]);
      expect(regressedImmutableLedgers(fx.db as HqDatabase)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The second half of High 2: whatever makes HQ's own store refuse an append,
   * the Founder gets a REFUSAL and a process that is still running.
   *
   * The write channel is closed above, so the state is reached here the way any
   * other writer could reach it — a trigger that refuses the append. That is
   * exactly the state the rowid `-1` plant produced, and at the reviewed head
   * `engageKillSwitch` and `assessHqIntegrity` both threw the driver's own
   * `SqliteError` uncaught out of the facade: the Founder's stop button did not
   * merely fail, it took the caller down, and the unauthenticated snapshot CLI
   * died with it.
   */
  it('refuses rather than throws when HQ’s own store will not take the append', () => {
    const fx = fileFixture();
    try {
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      const raw = fx.db as unknown as Database.Database;
      raw.exec(
        `CREATE TRIGGER zz_hostile_no_append BEFORE INSERT ON op_evidence
         BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;`,
      );

      const engaged = fx.ops.engageKillSwitch('global', 'founder', 'stop everything');
      expect(engaged.ok, 'engageKillSwitch must refuse, not throw').toBe(false);
      if (engaged.ok) throw new Error('unreachable');
      expect(engaged.error.message).toContain('op_evidence is append-only');
      expect(engaged.error.message).toContain('NOT engaged');

      const assessed = fx.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok, 'assessHqIntegrity must refuse, not throw').toBe(false);
      if (assessed.ok) throw new Error('unreachable');
      expect(assessed.error.message).toContain('could NOT record the verdict');

      const released = fx.ops.releaseKillSwitch('global', 'founder');
      expect(released.ok, 'releaseKillSwitch must refuse, not throw').toBe(false);

      // And the process is still answering: a console that cannot write is not
      // a console that has fallen over.
      expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The measurement the guard rests on, taken rather than assumed (Wave 5
   * correction round fourteen, Low 3). The comment in `ledgerRowidGuardDdl`
   * used to say `NEW.rowid` is "NULL … and -1 in some engine builds"; it is
   * deterministically the integer -1, and that value is exactly what made the
   * High 2 bricking work.
   */
  it('measures what NEW.rowid is for an auto-assigned rowid in a BEFORE INSERT', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)`);
      db.exec(`CREATE TABLE probe (what TEXT)`);
      db.exec(
        `CREATE TRIGGER ledger_probe BEFORE INSERT ON ledger
         BEGIN INSERT INTO probe (what)
           VALUES (TYPEOF(NEW.rowid) || ':' || COALESCE(CAST(NEW.rowid AS TEXT), 'NULL')); END;`,
      );
      db.prepare(`INSERT INTO ledger (v) VALUES ('a')`).run();
      db.prepare(`INSERT INTO ledger (v) VALUES ('b')`).run();
      expect(
        (db.prepare(`SELECT what FROM probe`).all() as { what: string }[]).map((row) => row.what),
      ).toEqual(['integer:-1', 'integer:-1']);
      // Which is why the bound from below is asserted AFTER the insert, where
      // the value is the rowid the row actually took.
      db.exec(
        `CREATE TRIGGER ledger_seat AFTER INSERT ON "ledger"
         WHEN NEW.rowid < 1 OR NEW.rowid <> (SELECT MAX(rowid) FROM "ledger")
         BEGIN SELECT RAISE(ABORT, 'ledger rowids are append-only'); END;`,
      );
      db.prepare(`INSERT INTO ledger (v) VALUES ('c')`).run();
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ledger`).get() as { n: number }).n).toBe(3);
      expect(() => db.prepare(`INSERT INTO ledger (rowid, v) VALUES (-1, 'plant')`).run()).toThrow(
        /rowids are append-only/,
      );
    } finally {
      db.close();
    }
  });

  /**
   * The bound from ABOVE on a file with NO `sqlite_sequence` (Wave 5 correction
   * round fourteen, Low 1).
   *
   * `MAX` is the scalar function with two arguments and the AGGREGATE with one,
   * and an aggregate in a trigger's `WHEN` clause compiles: the `CREATE
   * TRIGGER` succeeds and every INSERT afterwards fails `misuse of aggregate
   * function MAX()`, which on a declared ledger means HQ stops writing
   * altogether. Not reachable on a real HQ file — `sqlite_sequence` is created
   * by the first AUTOINCREMENT table and cannot itself be dropped — so this is
   * a latent defect closed rather than an exploit, and it is executed against
   * one of the five declared ledgers that are not AUTOINCREMENT, which is the
   * only way to get a file that carries a declared ledger and no counter table.
   */
  it('installs a working bound on a ledger whose file carries no sqlite_sequence', () => {
    const source = openMemoryHqDatabase();
    let create: string;
    try {
      void new HeadquarterOperations(source);
      create = (
        source
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hq_missions'`)
          .get() as { sql: string }
      ).sql;
    } finally {
      source.close();
    }
    const db = new Database(':memory:');
    try {
      db.exec(create);
      expect(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'`)
            .get() as { n: number }
        ).n,
        'this probe is only meaningful on a file with no counter table',
      ).toBe(0);
      ensureLedgerRowidGuards(db as unknown as HqDatabase);
      const columns = (db.prepare(`PRAGMA table_info(hq_missions)`).all() as {
        name: string;
        type: string;
        pk: number;
      }[]).filter((column) => column.pk === 0);
      const insert = db.prepare(
        `INSERT INTO hq_missions (${columns.map((c) => `"${c.name}"`).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      );
      // The ordinary append: it threw `misuse of aggregate function MAX()`
      // before this round.
      insert.run(columns.map((column) => distinctFiller(column.type, 1) as never));
      expect((db.prepare(`SELECT COUNT(*) AS n FROM hq_missions`).get() as { n: number }).n).toBe(1);
      // And both bounds still hold on that file.
      expect(() =>
        db
          .prepare(
            `INSERT INTO hq_missions (rowid, ${columns.map((c) => `"${c.name}"`).join(', ')})
             VALUES (500, ${columns.map(() => '?').join(', ')})`,
          )
          .run(columns.map((column) => distinctFiller(column.type, 2) as never)),
      ).toThrow(/rowids are contiguous/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO hq_missions (rowid, ${columns.map((c) => `"${c.name}"`).join(', ')})
             VALUES (-1, ${columns.map(() => '?').join(', ')})`,
          )
          .run(columns.map((column) => distinctFiller(column.type, 3) as never)),
      ).toThrow(/rowids are append-only/);
    } finally {
      db.close();
    }
  });
});

/**
 * The read-time half: WHICH of the two acts the gap term is reporting.
 *
 * The module used to justify closing the channel only at the write with a
 * sentence saying a mid-ledger deletion and an append past the top are
 * "indistinguishable from the file alone, at any later moment, so nothing this
 * reader could do would separate them". That was false. They are separated by
 * `COUNT(*) WHERE rowid <= committed top` against the committed row count, and
 * `committedRemovalsBelowMark` is that reader — see its docblock for the worked
 * four-case table, including the case it does NOT separate.
 */
describe('a removal below the committed mark is told apart from an append past it', () => {
  /** A warmed file whose verdict ledger holds a committed identity. */
  function warmed(): FileFixture {
    const fx = fileFixture();
    const seed = fx.db.prepare(
      `INSERT INTO hq_reliability_verdicts
         (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
       VALUES (?, '2026-01-01T00:00:00.000Z', 'full', 0, '[]', 'p', 'founder')`,
    );
    for (let i = 0; i < 10; i += 1) seed.run(`seed-${i}`);
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
    fx.db.close();
    return fx;
  }

  it('names the ledger a row was removed from, and not the one a row was planted in', () => {
    const table = 'hq_reliability_verdicts';

    // A: a row removed from the middle, at the three-statement price.
    const removed = warmed();
    try {
      const raw = removed.raw();
      const guards = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(table) as { name: string; sql: string }[];
      for (const guard of guards) raw.exec(`DROP TRIGGER ${guard.name}`);
      raw.prepare(`DELETE FROM "${table}" WHERE rowid = 5`).run();
      for (const guard of guards) raw.exec(guard.sql);
      expect(regressedImmutableLedgers(raw)).toEqual([table]);
      expect(committedRemovalsBelowMark(raw, [table])).toEqual([table]);
      raw.close();
      const process = removed.reopen('after-removal');
      const posture = process.ops.hqReliabilityPosture().integrity;
      const detail = posture.observations.map((observation) => observation.detail).join(' ');
      expect(detail).toContain('rows are MISSING from below');
      process.db.close();
    } finally {
      removed.cleanup();
    }

    // B: a row PLANTED past the top, at the same three-statement price. The gap
    // term reports it too — it is tampering — but nothing was removed, and the
    // detail no longer says it was.
    const planted = warmed();
    try {
      const raw = planted.raw();
      const guard = (
        raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
          .get(`trg_${table}_${LEDGER_ROWID_GUARD}`) as { sql: string }
      ).sql;
      const whole = raw
        .prepare(`SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT 1`)
        .get() as Record<string, unknown>;
      const columns = Object.keys(whole);
      raw.exec(`DROP TRIGGER trg_${table}_${LEDGER_ROWID_GUARD}`);
      raw
        .prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .run(
          columns.map((column) =>
            column === 'seq'
              ? (500 as never)
              : column === 'id'
                ? ('planted-past-the-top' as never)
                : (whole[column] as never),
          ),
        );
      raw.exec(guard);
      expect(regressedImmutableLedgers(raw)).toEqual([table]);
      expect(
        committedRemovalsBelowMark(raw, [table]),
        'nothing was removed, so nothing may be reported as removed',
      ).toEqual([]);
      raw.close();
      const process = planted.reopen('after-plant');
      const posture = process.ops.hqReliabilityPosture().integrity;
      const detail = posture.observations.map((observation) => observation.detail).join(' ');
      expect(detail).toContain('no ledger here is missing rows from below');
      expect(detail).toContain('a row written at a position HQ never allocated');
      process.db.close();
    } finally {
      planted.cleanup();
    }
  });

  /**
   * The case it does NOT separate, asserted so the disclosure cannot drift from
   * it: a hole that is REFILLED reads exactly like a ledger nothing touched.
   * That is why the refill is refused where it is written.
   */
  it('does not separate a refilled hole from an untampered ledger', () => {
    const table = 'hq_reliability_verdicts';
    const fx = warmed();
    try {
      const raw = fx.raw();
      const guards = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(table) as { name: string; sql: string }[];
      const whole = raw.prepare(`SELECT * FROM "${table}" WHERE rowid = 5`).get() as Record<
        string,
        unknown
      >;
      const columns = Object.keys(whole);
      for (const guard of guards) raw.exec(`DROP TRIGGER ${guard.name}`);
      raw.prepare(`DELETE FROM "${table}" WHERE rowid = 5`).run();
      raw
        .prepare(
          `INSERT INTO "${table}" (rowid, ${columns.map((c) => `"${c}"`).join(', ')})
           VALUES (?, ${columns.map(() => '?').join(', ')})`,
        )
        .run([5, ...columns.map((column) => whole[column] as never)]);
      for (const guard of guards) raw.exec(guard.sql);
      expect(
        regressedImmutableLedgers(raw),
        'the refill is not detectable at read time, and the disclosure says so',
      ).toEqual([]);
      expect(committedRemovalsBelowMark(raw, [table])).toEqual([]);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });
});
