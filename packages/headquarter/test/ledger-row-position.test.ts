/**
 * Wave 5, correction round fourteen — HOW a row can enter or change position in
 * a declared ledger, enumerated against the ENGINE rather than against memory.
 *
 * Round thirteen closed one spelling of that question: a row entering ABOVE the
 * top (`no_rowid_skip`, `BEFORE INSERT`, `NEW.rowid > 1 + MAX(top, sequence)`).
 * A fresh hostile review of `24ac1b7` reproduced the two that were left, and
 * each was live at ONE statement on a store that verified perfectly:
 *
 *  - **HIGH 1 — one `INSERT` at `seq = 0` on `op_evidence` fabricated a
 *    permanent, unclearable safe mode.** The round-thirteen bound is one-sided
 *    by construction, so rowid `0`, the `-1` the engine itself spells for an
 *    omitted key, every negative, and a REFILL of a freed rowid all passed it.
 *    Measured at `8481269` through this package's own file fixture: the insert
 *    was ACCEPTED with all four declared guards standing, `op_evidence` went
 *    from `{c:5, lo:1, hi:5}` to `{c:6, lo:0, hi:5}`, `verifyEvidenceChain`
 *    returned `1`, and three successive processes each reported
 *    `assess safeMode=true ["evidence_chain_broken"]`. The documented remedy —
 *    a full Founder assessment — re-derives it, and the ghost row cannot be
 *    removed without DDL.
 *  - **MEDIUM 2 — a mid-ledger deletion HEALED for one extra statement.**
 *    Delete rowid 2 from `hq_reliability_verdicts` and three processes report
 *    `append_only_guard_missing`; delete rowid 2 and then `INSERT` at rowid 2
 *    with forged content, and all three report nothing. The sentence that said
 *    SQLite "never reissues a rowid a deleted row held" was false about the
 *    only case that matters: a caller that supplies one.
 *  - **The third spelling, which nobody had tested:** a row that changes
 *    position without entering. `UPDATE … SET rowid` and `INSERT … ON CONFLICT
 *    … DO UPDATE SET rowid` widen `MAX(rowid) - COUNT(*)` exactly as an append
 *    above the top does, and no INSERT guard sees either.
 *
 * All three are now declared in `declaredGuardsFor` — complete BY CONSTRUCTION
 * across the 33 rather than by a per-table list, which is the defect class five
 * consecutive rounds have been about — and every claim below is executed.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fileFixture } from './reliability.fixture.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  LEDGER_ROWID_GUARD,
  LEDGER_ROWID_GUARDS,
  LEDGER_ROWID_MOVE_GUARD,
  LEDGER_ROWID_RESEAT_GUARD,
  declaredGuardsFor,
  declaredLedgerIdentities,
  missingImmutabilityGuards,
  regressedImmutableLedgers,
} from '../src/store/integrity.js';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

interface LiveLedger {
  table: string;
  create: string;
  guards: string[];
}

/**
 * Every declared ledger's REAL `CREATE TABLE` text and its REAL rowid-position
 * guards, taken from a live HQ file. Not a sample and not a rewrite: what is
 * driven below is exactly what ships.
 */
function liveLedgers(): LiveLedger[] {
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
      expect(create?.sql, `${entry.table} must exist on a live file`).toBeTruthy();
      const guards = LEDGER_ROWID_GUARDS.map((guard) => {
        const name = `trg_${entry.triggerPrefix}_${guard}`;
        const found = objects.find((row) => row.type === 'trigger' && row.name === name);
        expect(found?.sql, `${entry.table} must carry ${name} on a live file`).toBeTruthy();
        return found!.sql!;
      });
      return { table: entry.table, create: create!.sql!, guards };
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

/**
 * A scratch file carrying ONE ledger and ONLY its rowid-position guards, so
 * what a refusal below proves is those guards and nothing else — the trio would
 * refuse a colliding rowid, and a colliding rowid is not what any of these
 * defects used.
 */
function scratch(entry: LiveLedger): {
  db: Database.Database;
  insert: (rowid: number | null, salt: string, clause?: string) => void;
  state: () => { rows: number; top: number; lo: number; sequence: number };
} {
  const db = new Database(':memory:');
  // `sqlite_sequence` exists on every real HQ file (28 of the 33 are
  // AUTOINCREMENT), so it is made to exist here the same way it does there
  // rather than the guard being rewritten for the test.
  db.exec(`CREATE TABLE zz_autoincrement_present (seq INTEGER PRIMARY KEY AUTOINCREMENT)`);
  db.exec(`INSERT INTO zz_autoincrement_present DEFAULT VALUES`);
  db.exec(entry.create);
  for (const guard of entry.guards) db.exec(guard);
  const columns = (
    db.prepare(`PRAGMA table_info("${entry.table}")`).all() as {
      name: string;
      type: string;
      pk: number;
    }[]
  ).filter((column) => column.pk === 0);
  return {
    db,
    insert: (rowid, salt, clause = 'INSERT') => {
      const names = ['rowid', ...columns.map((column) => `"${column.name}"`)];
      const values = [
        rowid,
        ...columns.map((column) => {
          const base = filler(column.type);
          return typeof base === 'string' ? `${base}${salt}` : base;
        }),
      ];
      db.prepare(
        `${clause} INTO "${entry.table}" (${names.join(', ')}) VALUES (${names
          .map(() => '?')
          .join(', ')})`,
      ).run(values as never[]);
    },
    state: () => {
      const counted = db
        .prepare(
          `SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top, COALESCE(MIN(rowid), 0) AS lo FROM "${entry.table}"`,
        )
        .get() as { rows: number; top: number; lo: number };
      const mark = db
        .prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
        .get(entry.table) as { seq: number } | undefined;
      return { ...counted, sequence: mark?.seq ?? 0 };
    },
  };
}

describe('a row may not enter a declared ledger below its top', () => {
  /**
   * All 33, against their real schemas, for every hostile rowid the review
   * named and the hole refill besides.
   */
  it('refuses rowid 0, −1, −9 and a hole refill on every declared ledger', () => {
    const ledgers = liveLedgers();
    expect(ledgers.length).toBe(ENGINE_IMMUTABLE_TABLES.length);
    const accepted: string[] = [];
    const appended: string[] = [];
    for (const entry of ledgers) {
      const fx = scratch(entry);
      try {
        // Three ordinary appends first, so the guards are proven to PERMIT the
        // engine's own writes on this schema before they are asked to refuse.
        fx.insert(null, 'a');
        fx.insert(null, 'b');
        fx.insert(null, 'c');
        expect(fx.state(), `${entry.table} ordinary appends`).toMatchObject({
          rows: 3,
          top: 3,
          lo: 1,
        });
        appended.push(entry.table);
        for (const rowid of [0, -1, -9]) {
          try {
            fx.insert(rowid, `hostile${rowid}`);
            accepted.push(`${entry.table}@${rowid}`);
          } catch (error) {
            expect(String((error as Error).message)).toContain('rowids are contiguous');
          }
        }
        // And the HOLE REFILL, which is the Medium 2 healing route. The ledger's
        // own `no_erase` guard is not on this scratch file, so the deletion
        // stands in for the three-statement removal a raw writer pays for.
        fx.db.exec(`DELETE FROM "${entry.table}" WHERE rowid = 2`);
        expect(fx.state().rows, `${entry.table} after deletion`).toBe(2);
        try {
          fx.insert(2, 'refill');
          accepted.push(`${entry.table}@refill`);
        } catch (error) {
          expect(String((error as Error).message)).toContain('rowids are contiguous');
        }
        // The gap the deletion opened is still open — nothing healed it.
        expect(fx.state(), `${entry.table} gap survives`).toMatchObject({ rows: 2, top: 3 });
      } finally {
        fx.db.close();
      }
    }
    expect(appended.length, 'every declared ledger must take ordinary appends').toBe(
      ENGINE_IMMUTABLE_TABLES.length,
    );
    expect(accepted, 'a declared ledger accepted a row below its top').toEqual([]);
  });

  /**
   * The ABORT's own semantics, measured rather than assumed, because the guard
   * fires `AFTER INSERT` and an `AFTER` abort that persisted a row or burned a
   * sequence value would be worse than the hole.
   */
  it('persists nothing and burns no sequence value under every conflict clause', () => {
    for (const clause of [
      'INSERT',
      'INSERT OR REPLACE',
      'INSERT OR IGNORE',
      'INSERT OR FAIL',
      'INSERT OR ROLLBACK',
      'REPLACE',
    ]) {
      const entry = liveLedgers().find((candidate) => candidate.table === 'op_evidence')!;
      const fx = scratch(entry);
      try {
        fx.insert(null, 'a');
        fx.insert(null, 'b');
        fx.insert(null, 'c');
        const before = fx.state();
        expect(before).toEqual({ rows: 3, top: 3, lo: 1, sequence: 3 });

        expect(() => fx.insert(0, `outside-${clause}`, clause), `${clause} outside`).toThrow(
          /rowids are contiguous/,
        );
        expect(fx.state(), `${clause} outside`).toEqual(before);

        // Inside an explicit transaction: the statement rolls back, the
        // TRANSACTION does not — so `OR ROLLBACK` never becomes a way to
        // discard a caller's other work.
        fx.db.exec('BEGIN');
        expect(() => fx.insert(0, `inside-${clause}`, clause), `${clause} inside`).toThrow(
          /rowids are contiguous/,
        );
        expect(fx.db.inTransaction, `${clause} keeps the transaction open`).toBe(true);
        expect(fx.state(), `${clause} inside`).toEqual(before);
        fx.db.exec('COMMIT');

        // And the engine's own next append still lands at 4 — no value burned.
        fx.insert(null, 'd');
        expect(fx.state(), `${clause} next append`).toEqual({
          rows: 4,
          top: 4,
          lo: 1,
          sequence: 4,
        });
      } finally {
        fx.db.close();
      }
    }
  });

  /**
   * The anti-bricking half. A bound that refused what the engine itself would
   * allocate would stop HQ writing at all, which this module ranks strictly
   * worse than the gap — the same trade `ledgerRowidGuardDdl` records for
   * `sqlite_sequence`.
   */
  it('permits every append the engine itself would make', () => {
    const entry = liveLedgers().find((candidate) => candidate.table === 'op_evidence')!;
    const fx = scratch(entry);
    try {
      fx.insert(null, 'a');
      fx.insert(null, 'b');
      // A multi-row append: each row fires the guard after its own insert, and
      // each is the greatest at that moment.
      fx.db.exec(
        `INSERT INTO op_evidence (id, at, actor, kind, payload, prev_hash, hash)
         VALUES ('m1','','','','','',''), ('m2','','','','','','')`,
      );
      fx.db.exec(
        `INSERT INTO op_evidence (id, at, actor, kind, payload, prev_hash, hash)
         SELECT 's1','','','','','','' UNION ALL SELECT 's2','','','','','',''`,
      );
      expect(fx.state()).toEqual({ rows: 6, top: 6, lo: 1, sequence: 6 });
      // An EXPLICIT rowid at the top is still an ordinary append.
      fx.insert(7, 'explicit');
      expect(fx.state()).toEqual({ rows: 7, top: 7, lo: 1, sequence: 7 });

      // A BURNED AUTOINCREMENT counter: the engine's next allocation lands
      // above `MAX(rowid) + 1` and is permitted.
      fx.db.exec(`UPDATE sqlite_sequence SET seq = 20 WHERE name = 'op_evidence'`);
      fx.insert(null, 'burned');
      expect(fx.state()).toEqual({ rows: 8, top: 21, lo: 1, sequence: 21 });

      // A ledger that ALREADY holds a hole still takes an append: the new row
      // is the greatest, so an older file is never bricked by this guard.
      fx.db.exec(`DELETE FROM op_evidence WHERE rowid = 3`);
      fx.insert(null, 'after-hole');
      expect(fx.state()).toMatchObject({ rows: 8, top: 22 });
    } finally {
      fx.db.close();
    }
  });
});

describe('a row already in a declared ledger may not change position', () => {
  /**
   * The third spelling, on all 33. `UPDATE … SET rowid` and the upsert's
   * `DO UPDATE SET rowid` branch are the two ways a row moves without entering,
   * and neither `no_rowid_skip` nor `no_rowid_reseat` sees either.
   */
  it('refuses UPDATE SET rowid and ON CONFLICT DO UPDATE SET rowid on every declared ledger', () => {
    const accepted: string[] = [];
    for (const entry of liveLedgers()) {
      const fx = scratch(entry);
      try {
        fx.insert(null, 'a');
        fx.insert(null, 'b');
        const before = fx.state();
        try {
          fx.db.exec(`UPDATE "${entry.table}" SET rowid = 900 WHERE rowid = 1`);
          accepted.push(`${entry.table}@update`);
        } catch (error) {
          expect(String((error as Error).message)).toContain('rowids are contiguous');
        }
        expect(fx.state(), `${entry.table} after UPDATE SET rowid`).toEqual(before);
      } finally {
        fx.db.close();
      }
    }
    expect(accepted, 'a declared ledger accepted a rowid move').toEqual([]);
  });

  /** The upsert branch, driven on a real unique index rather than in the abstract. */
  it('refuses the upsert’s DO UPDATE SET rowid branch', () => {
    const entry = liveLedgers().find((candidate) => candidate.table === 'op_evidence')!;
    const fx = scratch(entry);
    try {
      fx.insert(null, 'a');
      fx.insert(null, 'b');
      const before = fx.state();
      expect(() =>
        fx.db.exec(
          `INSERT INTO op_evidence (id, at, actor, kind, payload, prev_hash, hash)
           VALUES ('a','','','','','','')
           ON CONFLICT(id) DO UPDATE SET rowid = 500`,
        ),
      ).toThrow(/rowids are contiguous/);
      expect(fx.state()).toEqual(before);
    } finally {
      fx.db.close();
    }
  });

  /**
   * The guard must not refuse an ordinary UPDATE, because two declared ledgers
   * carry a REDUCED base precisely so their own columns can move.
   */
  it('permits an ordinary UPDATE that leaves the rowid alone', () => {
    const entry = liveLedgers().find((candidate) => candidate.table === 'hq_missions')!;
    const fx = scratch(entry);
    try {
      fx.insert(null, 'a');
      fx.db.exec(`UPDATE hq_missions SET status = 'moved' WHERE rowid = 1`);
      expect(fx.state()).toMatchObject({ rows: 1, top: 1 });
    } finally {
      fx.db.close();
    }
  });
});

describe('VACUUM does not renumber a declared ledger', () => {
  /**
   * `VACUUM` is the one route to a rowid change that no trigger can see, so it
   * is MEASURED rather than argued about. SQLite renumbers implicit rowids only
   * for a table with no PRIMARY KEY at all; all 33 declared ledgers declare one
   * (28 an `INTEGER PRIMARY KEY`, five a `TEXT` one), and neither shape was
   * renumbered on this engine.
   */
  it('leaves an existing hole open on every declared ledger, and closes one with no PRIMARY KEY', () => {
    for (const entry of liveLedgers()) {
      const fx = scratch(entry);
      try {
        fx.insert(null, 'a');
        fx.insert(null, 'b');
        fx.insert(null, 'c');
        fx.db.exec(`DELETE FROM "${entry.table}" WHERE rowid = 2`);
        const before = fx.state();
        fx.db.exec('VACUUM');
        expect(fx.state(), `${entry.table} across VACUUM`).toMatchObject({
          rows: before.rows,
          top: before.top,
        });
        // A ledger declares a PRIMARY KEY, which is the structural reason the
        // reading above holds rather than a coincidence of this engine build.
        const pk = (
          fx.db.prepare(`PRAGMA table_info("${entry.table}")`).all() as { pk: number }[]
        ).filter((column) => column.pk > 0);
        expect(pk.length, `${entry.table} must declare a primary key`).toBeGreaterThan(0);
      } finally {
        fx.db.close();
      }
    }
    // The control: with no primary key at all the engine DOES renumber, so the
    // reading above is a fact about these schemas rather than about VACUUM.
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE t (k TEXT)`);
      for (let i = 1; i <= 5; i += 1) db.prepare(`INSERT INTO t (k) VALUES (?)`).run(`k${i}`);
      db.exec(`DELETE FROM t WHERE rowid = 2`);
      expect((db.prepare(`SELECT MAX(rowid) AS top FROM t`).get() as { top: number }).top).toBe(5);
      db.exec('VACUUM');
      expect((db.prepare(`SELECT MAX(rowid) AS top FROM t`).get() as { top: number }).top).toBe(4);
    } finally {
      db.close();
    }
  });
});

describe('the end-to-end acts the review executed', () => {
  /**
   * HIGH 1 on a REAL file through the real facade: the exact statement that
   * fabricated a permanent, unclearable safe mode at `8481269`.
   */
  it('refuses the seq-0 INSERT into op_evidence and leaves the store clean', () => {
    const fx = fileFixture();
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      }
      fx.db.close();

      const raw = fx.raw();
      const before = raw
        .prepare(`SELECT COUNT(*) AS c, MIN(rowid) AS lo, MAX(rowid) AS hi FROM op_evidence`)
        .get() as { c: number; lo: number; hi: number };
      expect(before.c).toBeGreaterThan(0);
      expect(before.lo).toBe(1);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO op_evidence (seq,id,at,task_id,actor,kind,payload,prev_hash,hash)
             VALUES (0,'ghost-row','2026-01-01T00:00:00.000Z',NULL,'ghost','ghost','{}','','deadbeef')`,
          )
          .run(),
      ).toThrow(/rowids are contiguous/);
      expect(
        raw
          .prepare(`SELECT COUNT(*) AS c, MIN(rowid) AS lo, MAX(rowid) AS hi FROM op_evidence`)
          .get(),
      ).toEqual(before);
      // The chain still verifies, which is the reading the ghost row broke.
      expect(verifyEvidenceChain(raw)).toBeNull();
      raw.close();

      for (const tag of ['p2', 'p3', 'p4']) {
        const process = fx.reopen(tag);
        const posture = process.ops.hqReliabilityPosture().integrity;
        expect(posture.safeMode, `${tag} boot`).toBe(false);
        expect(findings(posture.observations), `${tag} boot`).toEqual([]);
        const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok).toBe(true);
        if (!assessed.ok) throw new Error('unreachable');
        expect(assessed.data.safeMode, `${tag} assess`).toBe(false);
        expect(findings(assessed.data.observations), `${tag} assess`).toEqual([]);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  /**
   * MEDIUM 2 on a real file: the deletion is detected, and the refill that used
   * to heal it is refused, so it STAYS detected.
   */
  it('keeps a mid-ledger deletion blocking when the freed rowid is offered back', () => {
    const table = 'hq_reliability_verdicts';
    const fx = fileFixture();
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      }
      fx.db.close();
      const raw = fx.raw();
      const row = raw.prepare(`SELECT * FROM "${table}" WHERE rowid = 2`).get() as Record<
        string,
        unknown
      >;
      const columns = Object.keys(row);
      // The removal itself is the standing three-statement residual.
      raw.exec(`DROP TRIGGER trg_${table}_no_erase`);
      raw.prepare(`DELETE FROM "${table}" WHERE rowid = 2`).run();
      raw.exec(
        `CREATE TRIGGER trg_${table}_no_erase BEFORE DELETE ON "${table}" ` +
          `BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`,
      );
      // And the +1 statement that used to erase the evidence of it.
      expect(() =>
        raw
          .prepare(
            `INSERT INTO "${table}" (rowid, ${columns.map((c) => `"${c}"`).join(', ')})
             VALUES (2, ${columns.map(() => '?').join(', ')})`,
          )
          .run(
            columns.map((column) =>
              column === 'id' ? (`${String(row.id)}-forged` as never) : (row[column] as never),
            ),
          ),
      ).toThrow(/rowids are contiguous/);
      expect(raw.prepare(`SELECT COUNT(*) AS c, MAX(rowid) AS t FROM "${table}"`).get()).toEqual({
        c: 2,
        t: 3,
      });
      raw.close();

      for (const tag of ['p2', 'p3', 'p4']) {
        const process = fx.reopen(tag);
        const posture = process.ops.hqReliabilityPosture().integrity;
        expect(posture.safeMode, `${tag} boot`).toBe(true);
        expect(findings(posture.observations), `${tag} boot`).toEqual([
          'append_only_guard_missing',
        ]);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  /** No false alarm: a real workload never meets any of the three. */
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
});

describe('the three position guards are declared by construction', () => {
  it('declares and installs all three on every declared ledger', () => {
    const undeclared = ENGINE_IMMUTABLE_TABLES.filter((entry) => {
      const declared = declaredGuardsFor(entry);
      return LEDGER_ROWID_GUARDS.some(
        (guard) => !declared.includes(`trg_${entry.triggerPrefix}_${guard}`),
      );
    }).map((entry) => entry.table);
    expect(undeclared).toEqual([]);
    expect([...LEDGER_ROWID_GUARDS]).toEqual([
      LEDGER_ROWID_GUARD,
      LEDGER_ROWID_RESEAT_GUARD,
      LEDGER_ROWID_MOVE_GUARD,
    ]);

    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      const live = new Set(
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      const absent: string[] = [];
      for (const entry of ENGINE_IMMUTABLE_TABLES) {
        for (const guard of LEDGER_ROWID_GUARDS) {
          const name = `trg_${entry.triggerPrefix}_${guard}`;
          if (!live.has(name)) absent.push(name);
        }
      }
      expect(absent, 'every declared ledger must carry all three installed').toEqual([]);
      expect(missingImmutabilityGuards(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  /** A dropped position guard is a census finding, not a silent one. */
  it('reports each of the three as missing when it is dropped', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      for (const guard of LEDGER_ROWID_GUARDS) {
        const name = `trg_hq_reliability_verdicts_${guard}`;
        db.exec(`DROP TRIGGER ${name}`);
        expect(missingImmutabilityGuards(db)).toContain(name);
        db.exec(
          guard === LEDGER_ROWID_MOVE_GUARD
            ? `CREATE TRIGGER ${name} BEFORE UPDATE ON "hq_reliability_verdicts" ` +
                `WHEN NEW.rowid <> OLD.rowid BEGIN SELECT RAISE(ABORT, 'x'); END;`
            : guard === LEDGER_ROWID_RESEAT_GUARD
              ? `CREATE TRIGGER ${name} AFTER INSERT ON "hq_reliability_verdicts" ` +
                `WHEN NEW.rowid <> (SELECT MAX(rowid) FROM "hq_reliability_verdicts") ` +
                `BEGIN SELECT RAISE(ABORT, 'x'); END;`
              : `CREATE TRIGGER ${name} BEFORE INSERT ON "hq_reliability_verdicts" ` +
                `WHEN NEW.rowid > 1 + COALESCE((SELECT MAX(rowid) FROM "hq_reliability_verdicts"), 0) ` +
                `BEGIN SELECT RAISE(ABORT, 'x'); END;`,
        );
        expect(missingImmutabilityGuards(db)).not.toContain(name);
      }
    } finally {
      db.close();
    }
  });
});
