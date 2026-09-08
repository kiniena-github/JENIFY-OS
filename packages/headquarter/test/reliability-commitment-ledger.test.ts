/**
 * Wave 5, correction round six — the commitment ledger's own integrity, and
 * the true price of the two costs the previous round documented wrongly.
 *
 * Three findings from the fresh hostile review of `bdec887`, each pinned here
 * by the exploit or the measurement that made it:
 *
 *  - **MEDIUM 1 — the surviving whole-log forgery cost nothing extra at all.**
 *    The shipped residual priced it at "one extra `DROP TABLE`, one restart and
 *    one further Founder act". The attacker never has to drop the table:
 *    wiping its ROWS in place — drop the three triggers, `DELETE`, INSERT one
 *    agreeing replacement, re-create the triggers — leaves the ledger PRESENT,
 *    so the as-found census has nothing to observe and the forgery is accepted
 *    from the very next boot at zero restarts and zero Founder acts. Measured
 *    against the previous head: `BOOT safeMode = false []`, `FULL assessment
 *    safeMode = false []`, `releaseKillSwitch ADMITTED? true`.
 *  - **LOW 1 — a forged `sqlite_sequence` reading latched safe mode for ever.**
 *    `sqlite_sequence` is an ordinary writable table no trigger can guard, and
 *    the per-ledger commitment took the maximum ever recorded — so inflating a
 *    ledger's high-water mark, letting ONE clean boot commit the inflated
 *    reading and then restoring the true value created a
 *    `regressedImmutableLedgers` entry TRUE OF NOTHING, clearable by nothing
 *    including `assessHqIntegrity`. A fabricated finding in the FALSE-ALARM
 *    direction is forbidden exactly as one in the false-reassurance direction
 *    is, and the only escape was a backup restore.
 *  - **MEDIUM 2 — the documented remedy for this wave's own upgrade cost did
 *    not work.** Three shipped sentences said a newly declared ledger's first
 *    boot is "cleared by one Founder full assessment". Carrying the
 *    restored-ledger list into `fullIntegrity` — correct, and what closed the
 *    previous round's Medium — made that false for every established file:
 *    the process that OBSERVED the absence holds it for its whole lifetime, so
 *    it takes a restart and a SECOND assessment. The code is kept and the
 *    sentences were corrected; these tests pin the behaviour the corrected
 *    sentences describe, so they cannot silently become false again.
 *
 * Every attack below is executed against a real FILE through a RAW
 * `better-sqlite3` connection that never ran HQ's code, because each claim is a
 * claim about what a foreign writer can do to the file.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  HQ_INTEGRITY_CHECKPOINT_TABLE,
  SAFE_MODE_STATEMENT,
  committedCheckpointMark,
  elidedCommitmentLedgerRows,
  declaredGuardsFor,
  immutableLedgerMarks,
  recordIntegrityCheckpoint,
  regressedImmutableLedgers,
} from '../src/store/integrity.js';

/** The chain's zero value, spelled here only to BUILD the forgery. */
const GENESIS = 'genesis';

/**
 * Every guard the schema DECLARES on the commitment ledger, DERIVED rather than
 * hand-listed (Wave 5 correction round seven, High 3).
 *
 * The forgery this file models takes the ledger's guards off, rewrites it and
 * puts them back. A hand-written list of three silently modelled a WEAKER attack
 * the day a fourth guard was declared beside the trio — the wipe left
 * `no_overclaim` standing, so the re-creation collided with itself and the test
 * failed for a reason that had nothing to do with what it asserts. Reading the
 * declaration keeps the attack complete by construction.
 */
const CHECKPOINT_GUARDS = declaredCheckpointGuards();

function declaredCheckpointGuards(): string[] {
  const entry = ENGINE_IMMUTABLE_TABLES.find((row) => row.table === HQ_INTEGRITY_CHECKPOINT_TABLE);
  if (!entry) throw new Error('the commitment ledger is no longer a declared ledger');
  return declaredGuardsFor(entry);
}

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

/** Give the file a history worth committing to. */
function warm(fx: FileFixture, times = 3): void {
  for (let i = 0; i < times; i += 1) {
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
  }
}

function checkpointShape(raw: HqDatabase): { rows: number; top: number; highWater: number } {
  const counted = raw
    .prepare(`SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`)
    .get() as { rows: number; top: number };
  const sequence = raw
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
    .get(HQ_INTEGRITY_CHECKPOINT_TABLE) as { seq: number } | undefined;
  return { rows: counted.rows, top: counted.top, highWater: sequence?.seq ?? 0 };
}

/**
 * The whole-log forgery: no `UPDATE` anywhere, no write to `sqlite_sequence`,
 * guards put back afterwards.
 */
function forgeShortenedLog(raw: HqDatabase, drop: number): { before: number; after: number } {
  const rows = raw.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all() as Record<string, unknown>[];
  const tableSql = (
    raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='op_evidence'`).get() as {
      sql: string;
    }
  ).sql;
  const triggerSql = (
    raw.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='op_evidence'`).all() as {
      sql: string;
    }[]
  ).map((row) => row.sql);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('DROP TABLE op_evidence');
  raw.exec(tableSql);
  const insert = raw.prepare(
    `INSERT INTO op_evidence (seq, id, at, task_id, actor, kind, payload, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let prev = GENESIS;
  const keep = rows.slice(0, rows.length - drop);
  keep.forEach((row, index) => {
    const payload = JSON.stringify(JSON.parse(String(row.payload)));
    const hash = createHash('sha256')
      .update([prev, row.id, row.at, row.task_id ?? '', row.actor, row.kind, payload].join('|'))
      .digest('hex');
    insert.run(index + 1, row.id, row.at, row.task_id, row.actor, row.kind, payload, prev, hash);
    prev = hash;
  });
  for (const sql of triggerSql) raw.exec(sql);
  return { before: rows.length, after: keep.length };
}

/**
 * Wipe the commitments IN PLACE and leave one row that agrees with whatever the
 * log now says. The table is never absent, so no census observes anything.
 *
 * `explicitSeq` is the attacker's REPAIR of the invariant this round adds: it
 * inserts the replacement at rowid 1 and pushes `sqlite_sequence` back down to
 * match, which is the honest remaining price and is executed here rather than
 * asserted.
 */
function wipeCommitmentsInPlace(
  raw: HqDatabase,
  options: { repairSequence: boolean; omitOwnMark?: boolean },
): void {
  const guardSql = (
    raw
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
      .all(HQ_INTEGRITY_CHECKPOINT_TABLE) as { sql: string }[]
  ).map((row) => row.sql);
  for (const guard of CHECKPOINT_GUARDS) raw.exec(`DROP TRIGGER IF EXISTS ${guard}`);
  raw.exec(`DELETE FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`);
  const marks: Record<string, number> = {};
  for (const row of raw.prepare(`SELECT name, seq FROM sqlite_sequence`).all() as {
    name: string;
    seq: number;
  }[]) {
    marks[row.name] = row.seq;
  }
  // The attacker composes the replacement row's marks anyway, so leaving its
  // own ledger out costs nothing extra — and it is what the DELETE-the-sequence
  // variant has to do, since the mark it commits must not exceed what the file
  // will show afterwards.
  if (options.omitOwnMark) delete marks[HQ_INTEGRITY_CHECKPOINT_TABLE];
  // The forged row commits the ROW COUNTS as well as the marks (Wave 5
  // correction round seven, High 1 and High 2 added the column). Leaving the
  // column at its `'{}'` default would model a WEAKER attacker than the one this
  // file is about: HQ's next checkpoint would see every count advance, append
  // immediately, and re-create the high-water mark a whole process earlier than
  // the residual this test prices. An attacker composing the replacement row
  // composes both columns.
  const heldRows: Record<string, number> = {};
  for (const table of Object.keys(marks)) {
    try {
      heldRows[table] = (
        raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
      ).n;
    } catch {
      // A table the forgery has already dropped commits no count.
    }
  }
  // The gutted-store variant drops `op_evidence` too, and an attacker with no
  // log to agree with simply commits to none.
  let tip: { seq: number; hash: string } | undefined;
  try {
    tip = raw.prepare(`SELECT seq, hash FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as
      | { seq: number; hash: string }
      | undefined;
  } catch {
    tip = undefined;
  }
  if (options.repairSequence) {
    marks[HQ_INTEGRITY_CHECKPOINT_TABLE] = 1;
    raw
      .prepare(
        `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
           (seq, id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'checkpoint-forged',
        new Date().toISOString(),
        tip?.seq ?? 0,
        tip?.hash ?? '',
        JSON.stringify(marks),
        JSON.stringify(heldRows),
        'attacker',
        'hq_boot',
      );
    raw.exec(`UPDATE sqlite_sequence SET seq = 1 WHERE name = '${HQ_INTEGRITY_CHECKPOINT_TABLE}'`);
  } else {
    raw
      .prepare(
        `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
           (id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'checkpoint-forged',
        new Date().toISOString(),
        tip?.seq ?? 0,
        tip?.hash ?? '',
        JSON.stringify(marks),
        JSON.stringify(heldRows),
        'attacker',
        'hq_boot',
      );
  }
  for (const sql of guardSql) raw.exec(sql);
}

describe('HQ’s own commitment ledger is checked against itself', () => {
  it('refuses a whole-log forgery whose commitments were wiped IN PLACE, with no table ever absent', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const committedBefore = checkpointShape(raw);
      expect(committedBefore.rows).toBeGreaterThan(1);
      forgeShortenedLog(raw, 2);
      wipeCommitmentsInPlace(raw, { repairSequence: false });
      const shape = checkpointShape(raw);
      // The whole point of the exploit: the table is PRESENT, its three guards
      // are back, and the as-found census therefore has nothing to observe.
      expect(shape.rows).toBe(1);
      expect(shape.highWater).toBeGreaterThan(shape.rows);
      // DERIVED, not hand-counted (Wave 5 correction round seven, High 3): what
      // matters is that EVERY declared guard is back, which is what leaves the
      // as-found census nothing to observe.
      expect(
        (
          raw
            .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
            .all(HQ_INTEGRITY_CHECKPOINT_TABLE) as { name: string }[]
        )
          .map((row) => row.name)
          .sort(),
      ).toEqual([...CHECKPOINT_GUARDS].sort());
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      // The boot that opens the file afterwards, which used to read CLEAN and
      // hand back the one act safe mode exists to refuse.
      const after = fx.reopen('after-in-place-wipe');
      const posture = after.ops.hqReliabilityPosture().integrity;
      expect(posture.safeMode).toBe(true);
      expect(findings(posture.observations)).toContain('append_only_guard_missing');
      const assessed = after.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(true);
      expect(after.ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      after.db.close();

      // And it is DURABLE: this is a fact about the file as it now stands, not
      // an observation belonging to the process that saw the wipe.
      const later = fx.reopen('two-restarts-later');
      expect(later.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const reassessed = later.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(reassessed.ok).toBe(true);
      if (!reassessed.ok) throw new Error('unreachable');
      expect(reassessed.data.safeMode).toBe(true);
      expect(later.ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      later.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('keeps a gutted store blocking when the commitments were wiped in place rather than dropped', () => {
    const fx = fileFixture();
    try {
      warm(fx, 1);
      fx.db.close();

      const raw = fx.raw();
      raw.exec('PRAGMA foreign_keys = OFF');
      const present = new Set(
        (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      let dropped = 0;
      for (const entry of ENGINE_IMMUTABLE_TABLES) {
        if (entry.table === HQ_INTEGRITY_CHECKPOINT_TABLE) continue;
        if (!present.has(entry.table)) continue;
        raw.exec(`DROP TABLE ${entry.table}`);
        dropped += 1;
      }
      expect(dropped).toBeGreaterThan(20);
      wipeCommitmentsInPlace(raw, { repairSequence: false });
      raw.close();

      // The process that watches the drop blocked before this round too. The
      // one after it did not: HQ had re-created the ledgers empty and the
      // commitments that would have contradicted them were gone.
      for (const tag of ['gutted-first', 'gutted-second', 'gutted-third']) {
        const process = fx.reopen(tag);
        expect(process.ops.hqReliabilityPosture().integrity.safeMode, tag).toBe(true);
        const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok).toBe(true);
        if (!assessed.ok) throw new Error('unreachable');
        expect(assessed.data.safeMode, tag).toBe(true);
        expect(process.ops.releaseKillSwitch('global', 'founder').ok, tag).toBe(false);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  it('catches the sqlite_sequence repair too, now that the header records how far the ledger reached', () => {
    // This test pinned a DISCLOSED RESIDUAL for two rounds: repairing the row
    // identity — insert the replacement at rowid 1 and push `sqlite_sequence`
    // back down to match — left this check with nothing to say, and the boot
    // that followed read clean. Round ten closed it, so the residual it
    // pinned is gone and what it pins now is the closure. The assertions are
    // strictly stronger in every line; nothing was relaxed to make them pass.
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      forgeShortenedLog(raw, 2);
      wipeCommitmentsInPlace(raw, { repairSequence: true });
      const shape = checkpointShape(raw);
      // Every reading that lives INSIDE the file agrees with itself again...
      expect(shape).toEqual({ rows: 1, top: 1, highWater: 1 });
      // ...and the one that does not live in the file reports the collapse.
      expect(committedCheckpointMark(raw)).toBeGreaterThan(1);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      const after = fx.reopen('sequence-repaired');
      const posture = after.ops.hqReliabilityPosture().integrity;
      expect(posture.safeMode).toBe(true);
      expect(findings(posture.observations)).toContain('append_only_guard_missing');
      const assessed = after.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(true);
      expect(after.ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      after.db.close();
    } finally {
      fx.cleanup();
    }
  });

  /**
   * RE-PRICED twice, downwards both times, and measured rather than carried
   * forward.
   *
   * This test used to be called "every process after the first", because the
   * one-statement repair — delete the ledger's `sqlite_sequence` row instead of
   * matching it — bought the forger exactly one clean process, including the
   * Founder assessment it was aiming to pass.
   *
   * The concurrent round-ten lane took the ASSESSMENT away from it: HQ's
   * committed mark used to be gated on the ledger having a `sqlite_sequence`
   * row, so deleting that row meant HQ saw nothing to commit about its own
   * commitment ledger and appended nothing during the assessment. The mark is
   * now read from the ledger's own rows, so the first thing that assessment
   * does is append a checkpoint, which re-creates the high-water mark from the
   * rowid the forged row still carries, and the identity breaks inside the same
   * process.
   *
   * This lane takes the BOOT away from it as well: the greatest rowid the
   * ledger has ever reached is recorded in the database header, which no
   * `sqlite_sequence` write can touch, so the very first boot after the wipe is
   * already blocking. Nothing is bought at all now.
   */
  it('no longer sells even one clean process for the cheaper one-statement repair', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      forgeShortenedLog(raw, 2);
      wipeCommitmentsInPlace(raw, { repairSequence: false, omitOwnMark: true });
      raw.exec(`DELETE FROM sqlite_sequence WHERE name = '${HQ_INTEGRITY_CHECKPOINT_TABLE}'`);
      expect(checkpointShape(raw).highWater).toBe(0);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      // The boot the statement used to buy is blocking now, and so is the
      // Founder assessment it was aiming to pass, and so is every process
      // afterwards.
      for (const tag of ['the-process-it-used-to-buy', 'and-then-one', 'and-then-two']) {
        const process = fx.reopen(tag);
        expect(process.ops.hqReliabilityPosture().integrity.safeMode, tag).toBe(true);
        const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok).toBe(true);
        if (!assessed.ok) throw new Error('unreachable');
        expect(assessed.data.safeMode, tag).toBe(true);
        expect(process.ops.releaseKillSwitch('global', 'founder').ok, tag).toBe(false);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  it('has no false positive: boots, assessments, a refused duplicate append and VACUUM all keep the identity', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const first = fx.reopen('idle-one');
      first.db.close();
      const second = fx.reopen('idle-two');
      expect(second.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      second.db.close();

      const raw = fx.raw();
      const before = checkpointShape(raw);
      expect(before.rows).toBe(before.highWater);
      expect(before.top).toBe(before.highWater);

      // A legitimate FAILED append must not burn a sequence value: if it did,
      // this check would raise a permanent alarm no in-HQ act could clear —
      // the exact fabricated-finding failure the Low of this round corrects.
      const duplicate = raw.prepare(
        `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
           (id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const existing = raw
        .prepare(`SELECT id FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} ORDER BY seq LIMIT 1`)
        .get() as { id: string };
      expect(() =>
        duplicate.run(existing.id, new Date().toISOString(), 0, '', '{}', 'p', 'p'),
      ).toThrow();
      expect(checkpointShape(raw)).toEqual(before);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);

      raw.exec('VACUUM');
      expect(checkpointShape(raw)).toEqual(before);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();

      const after = fx.reopen('after-vacuum');
      expect(after.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      const assessed = after.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(false);
      after.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('says nothing at all about a file that carries no commitment ledger yet', () => {
    const fx = fileFixture();
    try {
      fx.db.close();
      const raw = fx.raw();
      raw.exec(`DROP TABLE ${HQ_INTEGRITY_CHECKPOINT_TABLE}`);
      // The ABSENCE is the census's finding — the table is a declared
      // engine-immutable ledger — and this check must not report it a second
      // time under a detail that would be false.
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });

  it('says so in the statement that crosses to the Founder', () => {
    expect(SAFE_MODE_STATEMENT).toContain('commitment ledger is checked against itself');
    expect(SAFE_MODE_STATEMENT).toContain('removed from it in place are blocking');
  });
});

describe('a committed ledger mark is corroborated by the rows, not taken from sqlite_sequence alone', () => {
  it('cannot be inflated into a permanent finding that is true of nothing', () => {
    const fx = fileFixture();
    try {
      warm(fx, 1);
      fx.db.close();

      // `sqlite_sequence` is an ordinary writable table and SQLite refuses to
      // let a trigger guard it, so this is a write any raw connection can make.
      const tamper = fx.raw();
      const real = (
        tamper.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'hq_reliability_verdicts'`).get() as {
          seq: number;
        }
      ).seq;
      tamper.exec(`UPDATE sqlite_sequence SET seq = 500000 WHERE name = 'hq_reliability_verdicts'`);
      // The reading is corroborated against the ledger's own MAX(rowid), so the
      // inflated number is not what HQ commits.
      expect(immutableLedgerMarks(tamper)['hq_reliability_verdicts']).toBe(real);
      tamper.close();

      // ONE clean boot used to be all the attack needed: it is the boot that
      // commits. The round-six MERGE made that boot no longer clean — the other
      // lane's `truncatedImmutableLedgers` compares `MAX(rowid)` against
      // `sqlite_sequence` for EVERY declared ledger, so an inflated mark IS a
      // blocking observation about the file as it now stands, and the attack
      // cannot even reach the commit through a facade construction. That is a
      // strengthening, not a replacement: the corroborated reading above is
      // still what HQ commits, and it is still the only thing standing between
      // a forged mark and a PERMANENT finding, which is what this test exists
      // for. Both are asserted.
      const committing = fx.reopen('commits-the-forged-reading');
      const blocked = committing.ops.hqReliabilityPosture().integrity;
      expect(blocked.safeMode).toBe(true);
      expect(findings(blocked.observations)).toContain('append_only_ledger_truncated');
      committing.db.close();

      // The commit path itself, exercised DIRECTLY against the raw handle so
      // this test still proves what it was written to prove: with the inflated
      // mark in place, what HQ commits is the CORROBORATED value, not the
      // forged one. Without that corroboration this write is what made the
      // finding below permanent.
      const committer = fx.raw();
      recordIntegrityCheckpoint(committer, {
        id: `checkpoint-forged-reading`,
        recordedAt: '2026-09-08T00:00:00.000Z',
        processId: 'commits-the-forged-reading',
        recordedBy: 'founder',
      });
      committer.close();

      const restore = fx.raw();
      restore.exec(`UPDATE sqlite_sequence SET seq = ${real} WHERE name = 'hq_reliability_verdicts'`);
      // NOTHING was manufactured. This is the assertion the whole test exists
      // for and it is unchanged by the merge.
      expect(regressedImmutableLedgers(restore)).toEqual([]);
      restore.close();

      // Every process afterwards used to report ["append_only_guard_missing"]
      // at both depths, for ever, on a file whose ledgers were intact — with
      // the only escape being a backup restore. What stands now is a LATCHED
      // verdict from the boot that genuinely observed the inflated mark, and a
      // latch is not a fabrication: it is HQ's record of an observation it
      // really made, and one Founder full assessment of the file as it now
      // stands clears it. That is the difference this correction is about.
      const first = fx.reopen('after-one');
      expect(first.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const cleared = first.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) throw new Error('unreachable');
      expect(findings(cleared.data.observations)).toEqual([]);
      expect(first.ops.releaseKillSwitch('global', 'founder').ok).toBe(true);
      first.db.close();

      for (const tag of ['after-two', 'after-three']) {
        const process = fx.reopen(tag);
        expect(process.ops.hqReliabilityPosture().integrity.safeMode, tag).toBe(false);
        const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok).toBe(true);
        if (!assessed.ok) throw new Error('unreachable');
        expect(findings(assessed.data.observations), tag).toEqual([]);
        expect(process.ops.releaseKillSwitch('global', 'founder').ok, tag).toBe(true);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  it('still reports a ledger that was really DROPPED, which is what the commitment is for', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.exec('DROP TABLE hq_reliability_verdicts');
      raw.close();

      const first = fx.reopen('watched-the-drop');
      expect(first.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      first.db.close();
      const second = fx.reopen('after-the-drop');
      const posture = second.ops.hqReliabilityPosture().integrity;
      expect(posture.safeMode).toBe(true);
      expect(findings(posture.observations)).toContain('append_only_guard_missing');
      second.db.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('what a newly declared LEDGER costs an established file, measured', () => {
  it('takes a restart and a SECOND Founder assessment, which is what the documents now say', () => {
    const fx = fileFixture();
    try {
      fx.db.close();
      // A file that predates the build declaring `hq_integrity_checkpoints`
      // simply does not carry it. This is the upgrade path, not an attack.
      const raw = fx.raw();
      raw.exec(`DROP TABLE ${HQ_INTEGRITY_CHECKPOINT_TABLE}`);
      raw.close();

      const first = fx.reopen('upgrade-first-process');
      expect(first.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const firstAssessment = first.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(firstAssessment.ok).toBe(true);
      if (!firstAssessment.ok) throw new Error('unreachable');
      // The process that OBSERVED the absence holds it for its whole lifetime,
      // deliberately: that is what stops a destroyed ledger being laundered by
      // re-creating it empty. So the FIRST assessment does not clear it.
      expect(firstAssessment.data.safeMode).toBe(true);
      expect(first.ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      first.db.close();

      const second = fx.reopen('upgrade-second-process');
      expect(second.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const secondAssessment = second.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(secondAssessment.ok).toBe(true);
      if (!secondAssessment.ok) throw new Error('unreachable');
      expect(secondAssessment.data.safeMode).toBe(false);
      expect(second.ops.releaseKillSwitch('global', 'founder').ok).toBe(true);
      second.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('still costs a newly declared GUARD exactly one assessment, which is the asymmetry the documents claim', () => {
    const fx = fileFixture();
    try {
      fx.db.close();
      const raw = fx.raw();
      raw.exec('DROP TRIGGER trg_op_evidence_no_erase');
      raw.close();

      const only = fx.reopen('guard-upgrade');
      expect(only.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const assessed = only.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      // Re-creating a trigger genuinely repairs the file's guard set, so this
      // one IS cleared by the process that observed it.
      expect(assessed.data.safeMode).toBe(false);
      expect(only.ops.releaseKillSwitch('global', 'founder').ok).toBe(true);
      only.db.close();
    } finally {
      fx.cleanup();
    }
  });
});
