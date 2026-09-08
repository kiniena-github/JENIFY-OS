/**
 * Wave 5, correction round ten — rolling HQ's commitment ledger BACK to an
 * earlier part of itself.
 *
 * A fresh hostile review of `6ce93df` reproduced one High by execution:
 *
 *  - **HIGH 1 — a PREFIX replay defeated all four commitment checks at once.**
 *    `DROP TABLE hq_integrity_checkpoints`, replay the table's own DDL out of
 *    `sqlite_master`, and re-insert a PREFIX of its own genuine rows at their
 *    own explicit rowids. No hash is recomputed — every row replayed is one HQ
 *    itself wrote — and no header write is needed, because the yes/no witness
 *    of round seven stayed true. `AUTOINCREMENT` rebuilds `sqlite_sequence`
 *    from the explicit rowids, so `elidedCommitmentLedgerRows`' identity holds
 *    at a DIFFERENT number and `truncatedImmutableLedgers` is satisfied;
 *    `regressedImmutableLedgers` reads `ledger_marks` out of the checkpoints
 *    just erased, and the surviving oldest checkpoint's own mark for this table
 *    is always at or below its own rowid; `contradictedChainCommitment` takes
 *    the maximum over the SURVIVING commitments, which the attacker chose.
 *    Measured against `6ce93df`: 18 statements took commitments 7 -> 1 and
 *    evidence 9 -> 4 with `boot=false [] full=false [] reboot=false []` and
 *    `releaseKillSwitch` ADMITTED; a genuinely latched
 *    `["append_only_guard_missing","evidence_chain_broken"]` was cleared; and
 *    once the commitment ledger was rolled back this way, rows could be erased
 *    from any declared ledger with nothing left to measure them against.
 *
 * The answer is a number that only ever goes UP and does not live in any table:
 * the greatest rowid the commitment ledger has ever reached, carried in the low
 * 16 bits of the same database-header slot as the round-seven witness. A
 * `DROP TABLE` cannot lower it.
 *
 * **"and a replay cannot raise the ledger to meet it" stood here and was
 * FALSE** (Wave 5 correction round thirteen, High 2). The witness is a COUNT, so
 * it is met by putting the right NUMBER of rows back rather than the right rows:
 * pad the prefix up to the mark with copies of a surviving row at the erased
 * rowids. Executed, and disclosed at its measured price in the last describe
 * block of this file, together with the two candidate closures that were
 * designed and rejected on the merits.
 *
 * Every attack below is executed against a real FILE through a RAW
 * `better-sqlite3` connection that never ran HQ's code, because each claim is a
 * claim about what a foreign writer can do to the file. The surviving residual
 * is executed too, and stated rather than asserted: one further statement
 * against the header buys the forgery back.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import {
  HQ_INTEGRITY_CHECKPOINT_TABLE,
  SAFE_MODE_STATEMENT,
  commitmentWitnessPresent,
  committedCheckpointMark,
  contradictedChainCommitment,
  decodeCommitmentWitness,
  elidedCommitmentLedgerRows,
  encodeCommitmentWitness,
  recordIntegrityCheckpoint,
  regressedImmutableLedgers,
  truncatedImmutableLedgers,
} from '../src/store/integrity.js';

/** The chain's zero value, spelled here only to BUILD the forgery. */
const GENESIS = 'genesis';

/** The round-seven stamp, spelled here so its back-compatibility is pinned. */
const LEGACY_WITNESS = 0x48514350;

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

function warm(fx: FileFixture, times = 4): void {
  for (let i = 0; i < times; i += 1) {
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
  }
}

function rowCount(raw: HqDatabase, table: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

function shape(raw: HqDatabase, table: string): { rows: number; top: number; highWater: number } {
  const counted = raw
    .prepare(`SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top FROM "${table}"`)
    .get() as { rows: number; top: number };
  const sequence = raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(table) as
    | { seq: number }
    | undefined;
  return { rows: counted.rows, top: counted.top, highWater: sequence?.seq ?? 0 };
}

/**
 * The attack. DROP a declared ledger, replay its own DDL — table, index and
 * every trigger — and re-insert a PREFIX of the rows it held, at the rowids
 * they already carried.
 *
 * Nothing is invented: every value written back is one HQ wrote. Returns the
 * number of SQL statements the whole act costs, so the price this suite reports
 * is counted rather than asserted.
 */
function replayPrefix(raw: HqDatabase, table: string, keep: number): number {
  const rows = raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<
    string,
    unknown
  >[];
  expect(rows.length).toBeGreaterThan(keep);
  const objects = raw
    .prepare(
      `SELECT type, sql FROM sqlite_master
        WHERE (name = ? OR tbl_name = ?) AND sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
    )
    .all(table, table) as { type: string; sql: string }[];
  expect(objects.some((object) => object.type === 'table')).toBe(true);
  let statements = 0;
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`DROP TABLE "${table}"`);
  statements += 1;
  for (const object of objects) {
    raw.exec(object.sql);
    statements += 1;
  }
  const kept = rows.slice(0, keep);
  const columns = Object.keys(kept[0] ?? {});
  const insert = raw.prepare(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  );
  for (const row of kept) {
    insert.run(columns.map((column) => row[column] as never));
    statements += 1;
  }
  // The state the four in-file readings cannot tell from a healthy ledger:
  // present, guarded, self-consistent, and short.
  const after = shape(raw, table);
  expect(after).toEqual({ rows: keep, top: keep, highWater: keep });
  return statements;
}

/** The whole-log forgery, so the latch this suite attacks is a REAL one. */
function forgeShortenedLog(raw: HqDatabase, drop: number): void {
  const rows = raw.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all() as Record<
    string,
    unknown
  >[];
  const tableSql = (
    raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='op_evidence'`).get() as {
      sql: string;
    }
  ).sql;
  const triggerSql = (
    raw
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='op_evidence'`)
      .all() as { sql: string }[]
  ).map((row) => row.sql);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('DROP TABLE op_evidence');
  raw.exec(tableSql);
  const insert = raw.prepare(
    `INSERT INTO op_evidence (seq, id, at, task_id, actor, kind, payload, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let prev = GENESIS;
  rows.slice(0, rows.length - drop).forEach((row, index) => {
    const payload = JSON.stringify(JSON.parse(String(row.payload)));
    const hash = createHash('sha256')
      .update([prev, row.id, row.at, row.task_id ?? '', row.actor, row.kind, payload].join('|'))
      .digest('hex');
    insert.run(index + 1, row.id, row.at, row.task_id, row.actor, row.kind, payload, prev, hash);
    prev = hash;
  });
  for (const sql of triggerSql) raw.exec(sql);
}

/** Blocking at BOTH depths, across restarts, with the one refused act refused. */
function expectPermanentlyBlocking(fx: FileFixture, tags: readonly string[]): void {
  for (const tag of tags) {
    const process = fx.reopen(tag);
    const posture = process.ops.hqReliabilityPosture().integrity;
    expect(posture.safeMode, `${tag} boot`).toBe(true);
    expect(findings(posture.observations), `${tag} boot`).toContain('append_only_guard_missing');
    const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) throw new Error('unreachable');
    expect(assessed.data.safeMode, `${tag} full`).toBe(true);
    expect(process.ops.releaseKillSwitch('global', 'founder').ok, `${tag} release`).toBe(false);
    process.db.close();
  }
}

/** Clean at BOTH depths, across restarts, with the guarded act admitted. */
function expectClean(fx: FileFixture, tags: readonly string[]): void {
  for (const tag of tags) {
    const process = fx.reopen(tag);
    const posture = process.ops.hqReliabilityPosture().integrity;
    expect(posture.safeMode, `${tag} boot`).toBe(false);
    expect(findings(posture.observations), `${tag} boot`).toEqual([]);
    const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) throw new Error('unreachable');
    expect(assessed.data.safeMode, `${tag} full`).toBe(false);
    expect(findings(assessed.data.observations), `${tag} full`).toEqual([]);
    expect(process.ops.releaseKillSwitch('global', 'founder').ok, `${tag} release`).toBe(true);
    process.db.close();
  }
}

describe('rolling the commitment ledger back to a PREFIX of itself is blocking', () => {
  it('is caught although every reading inside the file agrees with itself', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const before = rowCount(raw, HQ_INTEGRITY_CHECKPOINT_TABLE);
      expect(before).toBeGreaterThan(1);
      const committed = committedCheckpointMark(raw);
      expect(committed).toBe(before);

      const statements = replayPrefix(raw, HQ_INTEGRITY_CHECKPOINT_TABLE, 1);
      // The whole act: one DROP, seven DDL objects — the table, its index and
      // its five guards, the fourth being the concurrent lane's overclaim guard
      // and the fifth the universal rowid guard round thirteen added — and one
      // row put back. The price is counted from the replay itself rather than
      // asserted, so it moves when the schema does.
      expect(statements).toBe(9);

      // The four checks the attack was aimed at have nothing to say — which is
      // exactly why it worked — and the header mark does.
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      expect(truncatedImmutableLedgers(raw)).toEqual([]);
      expect(contradictedChainCommitment(raw)).toBeNull();
      expect(committedCheckpointMark(raw)).toBe(committed);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['prefix-one', 'prefix-two', 'prefix-three']);
    } finally {
      fx.cleanup();
    }
  });

  it('keeps a genuinely latched safe mode latched when the log, the verdicts AND the commitments are rolled back', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      // A REAL latch first: a shortened log that contradicts a commitment.
      const forge = fx.raw();
      forgeShortenedLog(forge, 2);
      forge.close();
      const latching = fx.reopen('latches-the-chain');
      const latchedPosture = latching.ops.hqReliabilityPosture().integrity;
      expect(latchedPosture.safeMode).toBe(true);
      expect(findings(latchedPosture.observations)).toContain('evidence_chain_broken');
      const latched = latching.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(latched.ok).toBe(true);
      if (!latched.ok) throw new Error('unreachable');
      expect(latched.data.safeMode).toBe(true);
      latching.db.close();

      // Roll the verdict ledger back past the latch, then roll the commitments
      // back to a prefix that no longer contradicts the shortened log.
      const raw = fx.raw();
      replayPrefix(raw, 'hq_reliability_verdicts', 1);
      replayPrefix(raw, HQ_INTEGRITY_CHECKPOINT_TABLE, 1);
      expect(contradictedChainCommitment(raw)).toBeNull();
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['relatched-one', 'relatched-two', 'relatched-three']);
    } finally {
      fx.cleanup();
    }
  });

  it('does not hand the same rollback to every other declared ledger', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      // The generalisation the reviewer measured: once the commitments are
      // rolled back, rows can be taken out of anything.
      //
      // The commitment ledger is rolled back FIRST here, and that ordering is
      // itself a result. The concurrent round-ten lane's overclaim guard is a
      // BEFORE INSERT on this ledger, so replaying a genuine checkpoint row
      // AFTER the other ledgers have been shortened is refused — the row's own
      // recorded marks no longer fit the file. Rolling the commitments back
      // while the file is still intact costs the attacker nothing and walks
      // round that guard entirely, which is exactly why the ledger needed a
      // witness the replay cannot rebuild.
      replayPrefix(raw, HQ_INTEGRITY_CHECKPOINT_TABLE, 1);
      replayPrefix(raw, 'hq_events', 1);
      replayPrefix(raw, 'op_evidence', 2);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['general-one', 'general-two']);
    } finally {
      fx.cleanup();
    }
  });

  it('cannot be walked back by HQ’s own next commitment, because the header only goes up', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const committed = committedCheckpointMark(raw);
      replayPrefix(raw, HQ_INTEGRITY_CHECKPOINT_TABLE, 1);
      // Append a genuine checkpoint through HQ's own writer on the rolled-back
      // ledger. It lands at rowid 2, far below the committed mark, and must
      // leave the header alone: a monotone mark that HQ itself could lower
      // would be no mark at all.
      expect(
        recordIntegrityCheckpoint(raw, {
          id: 'checkpoint-after-rollback',
          recordedAt: new Date().toISOString(),
          processId: 'attacker-adjacent',
          recordedBy: 'test',
        }),
      ).toBe(true);
      expect(shape(raw, HQ_INTEGRITY_CHECKPOINT_TABLE).top).toBe(2);
      expect(committedCheckpointMark(raw)).toBe(committed);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['recommitted-one', 'recommitted-two']);
    } finally {
      fx.cleanup();
    }
  });

  it('states the remaining price honestly: one further header write buys it back', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      replayPrefix(raw, HQ_INTEGRITY_CHECKPOINT_TABLE, 1);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      // ONE further statement. HQ holds no key over its own file, and this is
      // the same residual class as zeroing `PRAGMA user_version`. Pinned so it
      // cannot quietly be restated as a closed hole.
      raw.exec(`PRAGMA application_id = ${encodeCommitmentWitness(1)}`);
      expect(commitmentWitnessPresent(raw)).toBe(true);
      expect(committedCheckpointMark(raw)).toBe(1);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();

      const after = fx.reopen('header-lowered');
      expect(after.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      after.db.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('the header mark raises no alarm that is true of nothing', () => {
  it('says nothing across ordinary boots and Founder assessments', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      expectClean(fx, ['idle-one', 'idle-two', 'idle-three']);
      const raw = fx.raw();
      // The mark tracks the ledger it describes, rather than running ahead of
      // it: an inflated mark would be a permanent finding true of nothing.
      const current = shape(raw, HQ_INTEGRITY_CHECKPOINT_TABLE);
      expect(committedCheckpointMark(raw)).toBe(current.top);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });

  it('survives VACUUM, VACUUM INTO and .backup(), which are the legitimate whole-file copies', async () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const committed = committedCheckpointMark(raw);
      expect(committed).toBeGreaterThan(1);

      raw.exec('VACUUM');
      expect(committedCheckpointMark(raw)).toBe(committed);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);

      const intoPath = path.join(fx.dir, 'vacuumed.sqlite');
      raw.exec(`VACUUM INTO '${intoPath}'`);
      const backupPath = path.join(fx.dir, 'backed-up.sqlite');
      await raw.backup(backupPath);
      raw.close();

      for (const copy of [intoPath, backupPath]) {
        expect(fs.existsSync(copy)).toBe(true);
        const opened = new Database(copy) as unknown as HqDatabase;
        expect(committedCheckpointMark(opened), copy).toBe(committed);
        expect(elidedCommitmentLedgerRows(opened), copy).toBe(false);
        expect(shape(opened, HQ_INTEGRITY_CHECKPOINT_TABLE).top, copy).toBe(committed);
        opened.close();
      }

      expectClean(fx, ['after-copies']);
    } finally {
      fx.cleanup();
    }
  });

  it('says nothing about a failed append, an aborted one, a rollback or a released savepoint', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const committed = committedCheckpointMark(raw);
      const before = shape(raw, HQ_INTEGRITY_CHECKPOINT_TABLE);
      const existing = raw
        .prepare(`SELECT id FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} ORDER BY seq LIMIT 1`)
        .get() as { id: string };
      const append = raw.prepare(
        `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
           (id, recorded_at, chain_length, tip_hash, ledger_marks, process_id, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();

      // 1. The guard's own RAISE(ABORT) on a duplicate id.
      expect(() => append.run(existing.id, now, 0, '', '{}', 'p', 'p')).toThrow();
      // 2. The UNIQUE constraint on `id`, reached with the guard temporarily
      //    absent, which is the other way the same abort happens.
      raw.exec('DROP TRIGGER trg_hq_integrity_checkpoints_no_replace');
      expect(() => append.run(existing.id, now, 0, '', '{}', 'p', 'p')).toThrow();
      // 3. A failed append INSIDE a transaction that goes on to commit other
      //    work — a burned sequence value here would be a permanent alarm.
      raw.exec('BEGIN');
      expect(() => append.run(existing.id, now, 0, '', '{}', 'p', 'p')).toThrow();
      raw.exec(`CREATE TABLE IF NOT EXISTS scratch_other_work (a INTEGER)`);
      raw.exec('COMMIT');
      // 4. An explicit ROLLBACK of a GOOD append.
      raw.exec('BEGIN');
      append.run('rolled-back-append', now, 0, '', '{}', 'p', 'p');
      raw.exec('ROLLBACK');
      // 5. SAVEPOINT + ROLLBACK TO around a good append.
      raw.exec('SAVEPOINT probe');
      append.run('savepoint-append', now, 0, '', '{}', 'p', 'p');
      raw.exec('ROLLBACK TO probe');
      raw.exec('RELEASE probe');

      expect(shape(raw, HQ_INTEGRITY_CHECKPOINT_TABLE)).toEqual(before);
      expect(committedCheckpointMark(raw)).toBe(committed);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();

      // The one guard this test dropped is re-created by HQ's own ensure pass,
      // so the boot that observes it absent is the census's finding and the
      // one after it is clean again — the pre-existing behaviour, unchanged.
      const observing = fx.reopen('guard-observed-missing');
      expect(findings(observing.ops.hqReliabilityPosture().integrity.observations)).toEqual([
        'append_only_guard_missing',
      ]);
      observing.db.close();
      const repaired = fx.reopen('guard-back');
      expect(repaired.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const cleared = repaired.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) throw new Error('unreachable');
      expect(cleared.data.safeMode).toBe(false);
      repaired.db.close();
      expectClean(fx, ['after-probes']);
    } finally {
      fx.cleanup();
    }
  });

  it('keeps a header write transactional, so a rolled-back checkpoint cannot inflate the mark', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const committed = committedCheckpointMark(raw);
      raw.exec('BEGIN');
      raw.exec(`PRAGMA application_id = ${encodeCommitmentWitness(committed + 5000)}`);
      expect(committedCheckpointMark(raw)).toBe(committed + 5000);
      raw.exec('ROLLBACK');
      // The property `recordCommitmentWitness` relies on, verified against this
      // engine rather than assumed: the stamp made beside a checkpoint inside
      // the assessment's reservation is rolled back with it.
      expect(committedCheckpointMark(raw)).toBe(committed);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();

      expectClean(fx, ['after-rolled-back-header']);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the header encoding, both directions', () => {
  it('reads only HQ’s own signature, and reads the legacy stamp as witnessed-without-a-mark', () => {
    expect(decodeCommitmentWitness(0)).toEqual({ witnessed: false, mark: 0 });
    expect(decodeCommitmentWitness(0x12345678)).toEqual({ witnessed: false, mark: 0 });
    // The signature alone, with no mark, is NOT a member: a half-written value
    // must not read as a commitment.
    expect(decodeCommitmentWitness(0x48510000)).toEqual({ witnessed: false, mark: 0 });
    // Round seven's stamp keeps meaning what it meant, so a file committed on
    // by the older build raises nothing until its next checkpoint marks it.
    expect(decodeCommitmentWitness(LEGACY_WITNESS)).toEqual({ witnessed: true, mark: 0 });
    expect(decodeCommitmentWitness(0x48510001)).toEqual({ witnessed: true, mark: 1 });
    expect(decodeCommitmentWitness(0x4851ffff)).toEqual({ witnessed: true, mark: 0xffff });
  });

  it('encodes, clamps and saturates — and gives up exactly one mark value, in the fail-open direction', () => {
    expect(encodeCommitmentWitness(1)).toBe(0x48510001);
    expect(encodeCommitmentWitness(0)).toBe(0x48510001);
    expect(encodeCommitmentWitness(-4)).toBe(0x48510001);
    expect(encodeCommitmentWitness(0xffff)).toBe(0x4851ffff);
    // Saturation, stated rather than hidden: past 65535 committed checkpoints
    // the mark stops advancing, so a rollback WITHIN the saturated range is not
    // caught while any rollback below 65535 still is.
    expect(encodeCommitmentWitness(70_000)).toBe(0x4851ffff);
    // The one value the encoding gives up: a genuine mark of 17232 collides
    // with the legacy stamp and is read back as "unknown", so the check is
    // vacuous for that ONE checkpoint and repairs itself at the next.
    expect(encodeCommitmentWitness(0x4350)).toBe(LEGACY_WITNESS);
    expect(decodeCommitmentWitness(encodeCommitmentWitness(0x4350)).mark).toBe(0);
    expect(decodeCommitmentWitness(encodeCommitmentWitness(0x4351)).mark).toBe(0x4351);
  });

  it('round-trips every mark it does not give up', () => {
    for (const mark of [1, 2, 3, 17_231, 17_233, 40_000, 0xfffe, 0xffff]) {
      expect(decodeCommitmentWitness(encodeCommitmentWitness(mark))).toEqual({
        witnessed: true,
        mark,
      });
    }
  });
});

describe('the sentence that crosses to the Founder says what the code does', () => {
  it('escalates from "present and EMPTY" to "fewer than the header records"', () => {
    expect(SAFE_MODE_STATEMENT).toContain('present and EMPTY on a file HQ has committed on is blocking');
    expect(SAFE_MODE_STATEMENT).toContain('that check does not live in any table');
    expect(SAFE_MODE_STATEMENT).toContain('HOW FAR its own commitment ledger has ever reached');
    expect(SAFE_MODE_STATEMENT).toContain('replaying a PREFIX of its own real rows');
    // The residual is in the same sentence as the guarantee, not a page away.
    expect(SAFE_MODE_STATEMENT).toContain('back to a lower mark');
  });
});

/**
 * Wave 5, correction round thirteen — High 2: the header mark can be MET by
 * padding, and three places said it could not.
 *
 * The sentence "a `DROP TABLE` cannot lower it and a replay cannot raise the
 * ledger to meet it" stood verbatim in this file's header, in
 * `HQ_COMMITMENT_WITNESS_MARK`'s docblock and on
 * `PHASE_13_ADVANCED_RELIABILITY.md`. Its second half is false. The witness is a
 * COUNT — the greatest rowid the ledger has ever reached — and a count is met by
 * putting the right NUMBER of rows back, not the right rows: drop the table,
 * replay its own DDL, re-insert a PREFIX of the genuine rows, then pad up to the
 * mark with copies of a surviving row at explicit rowids. `rows`, `top` and
 * `sqlite_sequence` are all the mark again, so both `top < witness.mark` and
 * `rows < witness.mark` are false.
 *
 * ## Why it is DISCLOSED rather than closed
 *
 * No check computable from the file can close it, and the reason is exact. The
 * attacker reads the genuine ledger before destroying it, so any predicate over
 * the file's own content can be satisfied by writing content that satisfies it;
 * the only predicate that could not be met is one over content the attacker
 * cannot reconstruct, and there is none — the header carries 32 bits, 16 of
 * which are the signature. Two candidate closures were designed and rejected on
 * the merits, and both are recorded rather than left for a later round to
 * rediscover:
 *
 *  1. **A "each checkpoint advances something" invariant.** It is true of
 *     `recordIntegrityCheckpoint` by construction and it does catch a pad built
 *     from COPIES. It is rejected because two processes that read the same state
 *     before either writes produce two checkpoints committing identical
 *     quantities — a legitimate concurrent boot — so the check can raise a
 *     PERMANENT finding over an untampered file. A fabricated finding is
 *     forbidden in the alarm direction exactly as in the reassurance one, which
 *     is the whole subject of this correction round. And it buys little even if
 *     it were safe: the pad can be built from DISTINCT rows whose committed
 *     quantities rise, which `no_overclaim` permits because they stay under the
 *     file's real marks.
 *  2. **A content digest in the header's low bits.** Sixteen bits is a 65,536-way
 *     collision search an attacker runs offline in under a second, and widening
 *     it means either shrinking the signature — which round ten already measured
 *     as a real loss in the false-alarm direction — or coupling
 *     `PRAGMA user_version`, which round ten rejected because it would let ONE
 *     statement defeat both marks.
 *
 * So the sentence is corrected and the residual is priced by execution below.
 */
describe('the header mark is a COUNT, and a padded replay meets it', () => {
  it('is silent from the very next boot, at a counted price', () => {
    const fx = fileFixture();
    try {
      warm(fx, 6);
      fx.db.close();

      const raw = fx.raw();
      const table = HQ_INTEGRITY_CHECKPOINT_TABLE;
      const mark = committedCheckpointMark(raw);
      const before = shape(raw, table);
      expect(mark).toBeGreaterThan(2);
      expect(before).toEqual({ rows: mark, top: mark, highWater: mark });

      const rows = raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<
        string,
        unknown
      >[];
      const objects = raw
        .prepare(
          `SELECT type, sql FROM sqlite_master
            WHERE (name = ? OR tbl_name = ?) AND sql IS NOT NULL
            ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
        )
        .all(table, table) as { type: string; sql: string }[];

      let statements = 0;
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.exec(`DROP TABLE "${table}"`);
      statements += 1;
      for (const object of objects) {
        raw.exec(object.sql);
        statements += 1;
      }
      const keep = 2;
      const columns = Object.keys(rows[0] ?? {});
      const insert = raw.prepare(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      );
      for (const row of rows.slice(0, keep)) {
        insert.run(columns.map((column) => row[column] as never));
        statements += 1;
      }
      // The pad: copies of the last SURVIVING row, at the explicit rowids the
      // erased rows held, with only the UNIQUE `id` changed so the ledger's own
      // `no_replace` guard is satisfied. Every commitment written back is one HQ
      // itself made, so `no_overclaim` has nothing to refuse.
      const template = rows[keep - 1]!;
      for (let seq = keep + 1; seq <= mark; seq += 1) {
        const clone: Record<string, unknown> = {
          ...template,
          seq,
          id: `${String(template.id)}-pad-${seq}`,
        };
        insert.run(columns.map((column) => clone[column] as never));
        statements += 1;
      }

      // The state the four in-file readings AND the header witness all accept:
      // present, guarded, self-consistent, and holding the right NUMBER of the
      // wrong rows.
      expect(shape(raw, table)).toEqual(before);
      expect(committedCheckpointMark(raw)).toBe(mark);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      expect(truncatedImmutableLedgers(raw)).toEqual([]);
      expect(contradictedChainCommitment(raw)).toBeNull();
      // Four of the six commitments HQ made are gone, and four copies of one
      // commitment stand where they were.
      const distinct = (
        raw
          .prepare(`SELECT COUNT(DISTINCT chain_length) AS n FROM "${table}"`)
          .get() as { n: number }
      ).n;
      expect(distinct).toBe(keep);
      expect(statements).toBe(1 + objects.length + keep + (mark - keep));
      raw.close();

      // The disclosure, executed. Asserted rather than described, so that
      // CLOSING this route fails here and sends whoever closed it to the
      // residual list instead of leaving a stale price on the page.
      expectClean(fx, ['padded-one', 'padded-two', 'padded-three']);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * And the half that DOES hold, kept beside it so the correction does not read
   * as "the witness buys nothing": a replay that does not pad — the round-ten
   * attack — is still blocking, which is the case the mark was built for.
   */
  it('still refuses the same replay when it is not padded', () => {
    const fx = fileFixture();
    try {
      warm(fx, 6);
      fx.db.close();
      const raw = fx.raw();
      replayPrefix(raw, HQ_INTEGRITY_CHECKPOINT_TABLE, 2);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();
      expectPermanentlyBlocking(fx, ['unpadded-one', 'unpadded-two']);
    } finally {
      fx.cleanup();
    }
  });
});
