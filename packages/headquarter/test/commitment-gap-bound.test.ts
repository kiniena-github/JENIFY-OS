/**
 * Wave 5, correction round fourteen — MEDIUM 1 (the gap baseline was poisoned
 * by ONE permitted append) and LOW 1 (the derivation that says a column is
 * "bounded" only establishes that it is NAMED).
 *
 * **MEDIUM 1, reproduced at `8481269`.** `committedLedgerGaps` reads
 * `MAX(mark − rows)` per declared ledger and takes it as the baseline a later
 * gap is measured against. `no_overclaim` bounded `ledger_marks` from above and
 * `ledger_rows` from above, and NOTHING bounded the difference — so a
 * commitment carrying HQ's own marks and a LOWER row count for one ledger
 * passed every clause. Measured on `hq_reliability_verdicts`, the ledger that
 * holds the safe-mode latch: one `INSERT` whose `ledger_rows` read
 * `{hq_reliability_verdicts: 1}` — a declared key, valid JSON, a non-negative
 * integer at or below what the file held, exactly the shape HQ itself writes —
 * was ACCEPTED, and the mid-ledger deletion the control detects
 * (`p2..p4 safeMode=true ["append_only_guard_missing"]`) then went UNDETECTED
 * at every later process. The phase document said that fail-open cost three
 * statements; it cost one.
 *
 * **The fix is structural, not a corrected sentence.** The guard now bounds the
 * committed GAP by the file's own `MAX(rowid) − COUNT(*)` for each ledger the
 * commitment names a row count for — which is exactly what
 * `recordIntegrityCheckpoint` writes, and exactly the pair
 * `committedLedgerGaps` consumes. The sentence is corrected as well, because it
 * was wrong in the understating direction on the page whose theme is that
 * prices must be measured.
 */

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fileFixture } from './reliability.fixture.js';
import { openMemoryHqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import {
  CHECKPOINT_COLUMNS_THAT_DECIDE_NOTHING,
  HQ_INTEGRITY_CHECKPOINT_TABLE,
  regressedImmutableLedgers,
  unboundedCheckpointColumns,
} from '../src/store/integrity.js';

const OVERCLAIM_GUARD = 'trg_hq_integrity_checkpoints_no_overclaim';
const LEDGER = 'hq_reliability_verdicts';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

/** Four clean assessments, so the ledgers hold rows and commitments exist. */
function warm(fx: ReturnType<typeof fileFixture>): void {
  for (let pass = 0; pass < 4; pass += 1) {
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
  }
  expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
}

/**
 * The poison commitment: HQ's own newest checkpoint with ONE ledger's row count
 * written down. Every column is a shape `COMMITMENT_SHAPE_CLAUSES` admits.
 */
function poison(raw: Database.Database, rows: Record<string, number>): { landed: boolean; message: string } {
  const last = raw
    .prepare(`SELECT * FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} ORDER BY seq DESC LIMIT 1`)
    .get() as Record<string, unknown>;
  const columns = Object.keys(last).filter((column) => column !== 'seq');
  try {
    raw
      .prepare(
        `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE} (${columns
          .map((column) => `"${column}"`)
          .join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(
        columns.map((column) =>
          column === 'id'
            ? ('poison-checkpoint' as never)
            : column === 'ledger_rows'
              ? (JSON.stringify(rows) as never)
              : (last[column] as never),
        ),
      );
    return { landed: true, message: '' };
  } catch (error) {
    return { landed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove one row from the middle of a ledger, paying the standing price. */
function deleteMidLedger(raw: Database.Database, table: string, rowid: number): number {
  let statements = 0;
  raw.exec(`DROP TRIGGER trg_${table}_no_erase`);
  statements += 1;
  raw.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(rowid);
  statements += 1;
  raw.exec(
    `CREATE TRIGGER trg_${table}_no_erase BEFORE DELETE ON "${table}" ` +
      `BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`,
  );
  statements += 1;
  return statements;
}

/**
 * Five successive processes, each doing what the residual list tells the
 * Founder to do: read the posture, run a full assessment, try the release.
 *
 * The ASSESSMENT is load-bearing here and is why the earlier probe of this
 * defect saw nothing: a full assessment APPENDS its verdict row, which puts the
 * ledger's row count back where the commitment expects it, so from the second
 * process onward the GAP is the only surviving witness of the deletion. That is
 * exactly the round-seven finding this baseline exists for, and exactly what
 * poisoning the baseline erases.
 */
function walk(fx: ReturnType<typeof fileFixture>, tags: string[]): unknown[] {
  return tags.map((tag) => {
    const process = fx.reopen(tag);
    const posture = process.ops.hqReliabilityPosture().integrity;
    const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
    const seen = {
      tag,
      boot: posture.safeMode,
      findings: findings(posture.observations),
      assess: assessed.ok ? (assessed.data as unknown as { safeMode: boolean }).safeMode : null,
      release: process.ops.releaseKillSwitch('global', 'founder').ok,
    };
    process.db.close();
    return seen;
  });
}

const TAGS = ['p2', 'p3', 'p4', 'p5', 'p6'];

/** What an UNPOISONED store says about a mid-ledger deletion, for ever. */
const DETECTED = TAGS.map((tag) => ({
  tag,
  boot: true,
  findings: ['append_only_guard_missing'],
  assess: true,
  release: false,
}));

describe('a commitment may not claim a larger gap than the file holds', () => {
  /**
   * The control and the attack, identical but for the one `INSERT` — the shape
   * the round-seven measurement used, and the only way to show that the append
   * is what did the hiding.
   */
  it('refuses the one permitted append that used to erase the mid-ledger finding', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const held = (raw.prepare(`SELECT COUNT(*) AS c FROM "${LEDGER}"`).get() as { c: number }).c;
      expect(held, 'the ledger must hold enough rows for a middle to exist').toBeGreaterThan(2);

      // The poison, at ONE statement, claiming a row count BELOW what the file
      // holds while carrying HQ's own marks. Every value is in range from
      // above; the GAP it commits is not.
      const attempt = poison(raw, { [LEDGER]: 1 });
      expect(attempt.landed, 'the gap over-claim must be refused where it is written').toBe(false);
      expect(attempt.message).toMatch(/may not commit beyond the record/);
      expect(
        raw
          .prepare(`SELECT COUNT(*) AS c FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} WHERE id = ?`)
          .get('poison-checkpoint'),
        'nothing persisted',
      ).toEqual({ c: 0 });

      // And the deletion it was meant to hide is reported by every later
      // process, exactly as the control does.
      expect(deleteMidLedger(raw, LEDGER, 2)).toBe(3);
      expect(regressedImmutableLedgers(raw)).toEqual([LEDGER]);
      raw.close();

      expect(walk(fx, TAGS)).toEqual(DETECTED);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The CONTROL, run as its own test rather than asserted about: without any
   * commitment tampering the same deletion is blocking in every process.
   */
  it('reports the same deletion for ever when no commitment was tampered with', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      expect(deleteMidLedger(raw, LEDGER, 2)).toBe(3);
      raw.close();
      expect(walk(fx, TAGS)).toEqual(DETECTED);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The price, COUNTED rather than asserted, which is the whole point of this
   * correction. The phase document said this fail-open cost three statements
   * while it cost ONE. It now costs three, and the residual behind those three
   * is real — so it is measured here, in the fail-open direction, rather than
   * argued away.
   */
  it('costs three statements now, and the residual behind them still reaches', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const guard = (
        raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
          .get(OVERCLAIM_GUARD) as { sql: string }
      ).sql;

      let statements = 0;
      raw.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      statements += 1;
      const landed = poison(raw, { [LEDGER]: 1 });
      statements += 1;
      expect(landed.landed, 'with the guard gone the append is permitted again').toBe(true);
      raw.exec(guard);
      statements += 1;
      expect(statements, 'the same three statements every other residual here pays').toBe(3);

      expect(deleteMidLedger(raw, LEDGER, 2)).toBe(3);
      raw.close();

      // The residual, executed: the first process still latches on the row
      // count, and from the second — once its own assessment has appended and
      // healed that count — the poisoned gap baseline is all that is left and
      // it says nothing.
      const seen = walk(fx, TAGS) as { tag: string; boot: boolean; release: boolean }[];
      expect(seen[0].boot, 'p2 still latches on the count').toBe(true);
      expect(seen.slice(1).map((entry) => entry.boot), 'p3..p6 go silent').toEqual([
        false,
        false,
        false,
        false,
      ]);
      // Which is why the guard exists at all: without it the SAME outcome cost
      // one statement rather than three.
      expect(seen.every((entry) => entry.release)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  /** HQ's own commitments are never refused by the new clause. */
  it('never refuses a checkpoint HQ itself writes, over repeated boots and real work', () => {
    const fx = fileFixture();
    try {
      for (let pass = 0; pass < 6; pass += 1) {
        expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
        expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      }
      const before = (
        fx.db
          .prepare(`SELECT COUNT(*) AS c FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`)
          .get() as { c: number }
      ).c;
      expect(before).toBeGreaterThan(1);
      for (const tag of ['p2', 'p3']) {
        const process = fx.reopen(tag);
        expect(process.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
        expect(process.ops.hqReliabilityPosture().integrity.safeMode, tag).toBe(false);
        process.db.close();
      }
      expect(
        (
          fx.raw()
            .prepare(`SELECT COUNT(*) AS c FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`)
            .get() as { c: number }
        ).c,
        'HQ kept committing with the new clause standing',
      ).toBeGreaterThan(before);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The clause is exactly as wide as the reading it protects, and no wider. A
   * PARTIAL commitment — a row count with no mark beside it — is what
   * `ledger-identity.test.ts` drives to prove the count term binds on its own,
   * and it must still be an append the ledger permits.
   */
  it('admits a commitment that names a row count and no mark for it', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const last = raw
        .prepare(
          `SELECT chain_length, tip_hash, ledger_marks FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} ORDER BY seq DESC LIMIT 1`,
        )
        .get() as { chain_length: number; tip_hash: string; ledger_marks: string };
      const marks = JSON.parse(last.ledger_marks) as Record<string, number>;
      // A ledger the commitment carries NO mark for. `hq_briefs` is empty on
      // this fixture, so no genuine checkpoint carries either half for it.
      expect(marks.hq_briefs).toBeUndefined();
      expect(() =>
        raw
          .prepare(
            `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
               (id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'partial-commitment',
            new Date().toISOString(),
            last.chain_length,
            last.tip_hash,
            last.ledger_marks,
            JSON.stringify({ hq_briefs: 0 }),
            'hq_boot',
            'hq_boot',
          ),
      ).not.toThrow();
      raw.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('the checkpoint-column derivation says what it actually establishes', () => {
  /** Nothing unnamed on a live file — the standing guarantee, unchanged. */
  it('reports no unnamed deciding column on a live store', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      expect(unboundedCheckpointColumns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  /**
   * LOW 1, first half: the interpolated `.` was an unescaped regex
   * metacharacter, so any single character between `NEW` and the column name
   * satisfied the check. `NEWXseq` is the smallest thing that demonstrates it.
   */
  it('does not accept NEWXseq as naming seq', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      db.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      db.exec(
        `CREATE TRIGGER ${OVERCLAIM_GUARD}\n` +
          `AFTER INSERT ON ${HQ_INTEGRITY_CHECKPOINT_TABLE}\n` +
          `WHEN NEWXseq <> 0 AND NEW.ledger_marks <> '' AND NEW.ledger_rows <> ''\n` +
          `  AND NEW.chain_length <> 0 AND NEW.tip_hash <> ''\n` +
          `BEGIN SELECT RAISE(ABORT, 'x'); END;`,
      );
      expect(unboundedCheckpointColumns(db)).toEqual(['seq']);
    } finally {
      db.close();
    }
  });

  /**
   * LOW 1, second half: a column named only inside a SQL comment is not named
   * by a clause, and the derivation now strips comments before it looks.
   */
  it('does not accept a column named only in a comment', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      db.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      db.exec(
        `CREATE TRIGGER ${OVERCLAIM_GUARD}\n` +
          `AFTER INSERT ON ${HQ_INTEGRITY_CHECKPOINT_TABLE}\n` +
          `WHEN NEW.seq <> 0 AND NEW.ledger_marks <> '' AND NEW.ledger_rows <> ''\n` +
          `  AND NEW.chain_length <> 0 -- NEW.tip_hash is only mentioned here\n` +
          `BEGIN SELECT RAISE(ABORT, 'x'); END;`,
      );
      expect(unboundedCheckpointColumns(db)).toEqual(['tip_hash']);

      db.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      db.exec(
        `CREATE TRIGGER ${OVERCLAIM_GUARD}\n` +
          `AFTER INSERT ON ${HQ_INTEGRITY_CHECKPOINT_TABLE}\n` +
          `WHEN NEW.seq <> 0 AND NEW.ledger_marks <> '' AND NEW.ledger_rows <> ''\n` +
          `  AND NEW.chain_length <> 0 /* NEW.tip_hash in a block comment */\n` +
          `BEGIN SELECT RAISE(ABORT, 'x'); END;`,
      );
      expect(unboundedCheckpointColumns(db)).toEqual(['tip_hash']);
    } finally {
      db.close();
    }
  });

  /**
   * And the honest limit, ASSERTED rather than left implied: the derivation
   * establishes NAMED, not BOUNDED. A clause that mentions every deciding
   * column and constrains none satisfies it, and this test is what stops the
   * docblock ever claiming otherwise again. What actually establishes the bound
   * is the executed enumeration in `commitment-overclaim.test.ts`.
   */
  it('is satisfied by a clause that names every column and bounds nothing', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      const deciding = (
        db.prepare(`PRAGMA table_info(${HQ_INTEGRITY_CHECKPOINT_TABLE})`).all() as {
          name: string;
        }[]
      )
        .map((column) => column.name)
        .filter((name) => !CHECKPOINT_COLUMNS_THAT_DECIDE_NOTHING.includes(name));
      expect(deciding.length).toBeGreaterThan(0);
      db.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      db.exec(
        `CREATE TRIGGER ${OVERCLAIM_GUARD}\n` +
          `AFTER INSERT ON ${HQ_INTEGRITY_CHECKPOINT_TABLE}\n` +
          `WHEN 1 = 0 AND (${deciding.map((name) => `NEW.${name} IS NEW.${name}`).join(' AND ')})\n` +
          `BEGIN SELECT RAISE(ABORT, 'x'); END;`,
      );
      // Every column is NAMED, so the derivation is silent — and the guard
      // refuses nothing at all.
      expect(unboundedCheckpointColumns(db)).toEqual([]);
      const digest = createHash('sha256').update('names-but-does-not-bound').digest('hex');
      expect(digest).toHaveLength(64);
    } finally {
      db.close();
    }
  });
});
