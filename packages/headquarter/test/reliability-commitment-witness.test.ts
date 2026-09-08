/**
 * Wave 5, correction round seven — the commitment ledger's own EXISTENCE, and
 * the two findings that turned total erasure into the cheapest attack on it.
 *
 * A fresh hostile review of `d97b8a6` reproduced both by execution:
 *
 *  - **CRITICAL NEW-1 — the total-erasure bypass was open again.** Every check
 *    that guards HQ's commitments read something the erasure destroys:
 *    `regressedImmutableLedgers` reads `committedLedgerMarks` out of the table
 *    that was emptied, and `elidedCommitmentLedgerRows` started from the
 *    `sqlite_sequence` row a `DROP TABLE` takes with it. So `DROP TABLE
 *    hq_integrity_checkpoints` followed by a replay of the table's own DDL out
 *    of `sqlite_master` left it PRESENT and empty: nothing absent for the
 *    as-found census, nothing to contradict, and a genuinely latched
 *    `evidence_chain_broken` cleared for ever. The same held with `op_evidence`
 *    dropped and replayed beside it, and with `hq_reliability_verdicts`.
 *  - **HIGH NEW-2 — a free, permanently-silent commitment wipe survived.**
 *    `DELETE` every row from the ledger AND `DELETE FROM sqlite_sequence` for
 *    it — two statements, no replacement row — reached the same early return.
 *    Zero restarts, zero Founder acts, silent for ever.
 *
 * Both now rest on a witness that does not live in any table:
 * `PRAGMA application_id`, stamped once HQ has appended a commitment to a file.
 * A commitment ledger that is present and EMPTY on a witnessed file is
 * blocking, however it came to be empty.
 *
 * Every attack below is executed against a real FILE through a RAW
 * `better-sqlite3` connection that never ran HQ's code, because each claim is a
 * claim about what a foreign writer can do to the file. The residual is
 * executed too, and stated rather than asserted: a writer that also rewrites
 * the header puts the file back to unwitnessed.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  HQ_INTEGRITY_CHECKPOINT_TABLE,
  SAFE_MODE_STATEMENT,
  declaredGuardsFor,
  commitmentWitnessPresent,
  elidedCommitmentLedgerRows,
  regressedImmutableLedgers,
} from '../src/store/integrity.js';

/** The chain's zero value, spelled here only to BUILD the forgery. */
const GENESIS = 'genesis';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

function warm(fx: FileFixture, times = 3): void {
  for (let i = 0; i < times; i += 1) {
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
  }
}

/** Every guard the schema DECLARES on the commitment ledger, sorted. */
function declaredCheckpointGuards(): string[] {
  const entry = ENGINE_IMMUTABLE_TABLES.find((row) => row.table === HQ_INTEGRITY_CHECKPOINT_TABLE);
  if (!entry) throw new Error('the commitment ledger is no longer a declared ledger');
  return declaredGuardsFor(entry).sort();
}

/** Every trigger the FILE carries on one table, sorted. */
function guardNamesOn(raw: HqDatabase, table: string): string[] {
  return (
    raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
      .all(table) as { name: string }[]
  )
    .map((row) => row.name)
    .sort();
}

function rowCount(raw: HqDatabase, table: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

/**
 * DROP a table and put it back EXACTLY as the file described it — the table
 * SQL, its indexes and its triggers, all replayed out of `sqlite_master`.
 *
 * This is the whole point of the Critical: nothing is left absent for the
 * as-found census to observe, and the guards are back before HQ next opens the
 * file.
 */
function dropAndReplayDdl(raw: HqDatabase, table: string): void {
  const objects = raw
    .prepare(
      `SELECT type, sql FROM sqlite_master
        WHERE (name = ? OR tbl_name = ?) AND sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
    )
    .all(table, table) as { type: string; sql: string }[];
  expect(objects.some((object) => object.type === 'table')).toBe(true);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`DROP TABLE "${table}"`);
  for (const object of objects) raw.exec(object.sql);
  // Present, empty, and guarded again — the state the census cannot see.
  expect(rowCount(raw, table)).toBe(0);
}

/** The whole-log forgery, so the latch under attack is a REAL one. */
function forgeShortenedLog(raw: HqDatabase, drop: number): void {
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

describe('destroying HQ’s commitment ledger outright is blocking, not silent', () => {
  it('refuses a DROP + DDL replay of the commitment ledger alone, for ever', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      expect(commitmentWitnessPresent(raw)).toBe(true);
      expect(rowCount(raw, HQ_INTEGRITY_CHECKPOINT_TABLE)).toBeGreaterThan(0);
      dropAndReplayDdl(raw, HQ_INTEGRITY_CHECKPOINT_TABLE);
      // The two checks the attack was aimed at have nothing to say — which is
      // exactly why it worked — and the witness does.
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      // DERIVED, not counted by hand (Wave 5 correction round seven, High 3).
      // The point of the assertion is "every guard the schema declares on this
      // ledger is back", and a literal `3` stopped being that number the moment
      // `no_overclaim` was declared beside the trio.
      expect(guardNamesOn(raw, HQ_INTEGRITY_CHECKPOINT_TABLE)).toEqual(declaredCheckpointGuards());
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['replayed-one', 'replayed-two', 'replayed-three']);
    } finally {
      fx.cleanup();
    }
  });

  it('keeps a genuinely latched evidence_chain_broken latched when the log AND the commitments are replayed', () => {
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

      // The Critical: destroy the log and the commitments together and put both
      // back from their own DDL. Nothing absent, nothing contradicted, and the
      // verdict ledger's latch is cleared by the next assessment because the
      // fresh log carries a genuine corroborating link.
      const raw = fx.raw();
      dropAndReplayDdl(raw, 'op_evidence');
      dropAndReplayDdl(raw, HQ_INTEGRITY_CHECKPOINT_TABLE);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['gutted-one', 'gutted-two', 'gutted-three']);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a DROP + DDL replay of the verdict ledger and the commitments together', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      dropAndReplayDdl(raw, 'hq_reliability_verdicts');
      dropAndReplayDdl(raw, HQ_INTEGRITY_CHECKPOINT_TABLE);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['verdicts-one', 'verdicts-two']);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses the two-statement wipe that left no replacement row and no high-water mark', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      // DERIVED from the schema's own declaration rather than hand-listed
      // (Wave 5 correction round seven, High 3): the attack this test models is
      // "take EVERY guard off this ledger", and a hand-written list of three
      // silently modelled a weaker attack the day a fourth guard was declared.
      for (const guard of declaredCheckpointGuards()) {
        raw.exec(`DROP TRIGGER IF EXISTS ${guard}`);
      }
      expect(guardNamesOn(raw, HQ_INTEGRITY_CHECKPOINT_TABLE)).toEqual([]);
      raw.exec(`DELETE FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`);
      raw.exec(`DELETE FROM sqlite_sequence WHERE name = '${HQ_INTEGRITY_CHECKPOINT_TABLE}'`);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      expectPermanentlyBlocking(fx, ['wiped-one', 'wiped-two', 'wiped-three']);
    } finally {
      fx.cleanup();
    }
  });

  it('states the remaining price honestly: rewriting the header too is still silent', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      dropAndReplayDdl(raw, HQ_INTEGRITY_CHECKPOINT_TABLE);
      // One further statement, and the file is back to unwitnessed. HQ holds no
      // key over its own file; this is the disclosed residual, pinned so it
      // cannot quietly be restated as a closed hole.
      raw.exec('PRAGMA application_id = 0');
      expect(commitmentWitnessPresent(raw)).toBe(false);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();

      const after = fx.reopen('header-rewritten');
      expect(after.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      after.db.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('the witness raises no alarm that is true of nothing', () => {
  it('says nothing about a first boot, an idle restart, or a file that predates it', () => {
    const fx = fileFixture();
    try {
      // A brand-new file: nothing committed, so nothing witnessed.
      fx.db.close();
      const fresh = fx.raw();
      expect(commitmentWitnessPresent(fresh)).toBe(false);
      expect(elidedCommitmentLedgerRows(fresh)).toBe(false);
      fresh.close();

      const first = fx.reopen('idle-one');
      expect(first.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      first.db.close();
      const second = fx.reopen('idle-two');
      expect(second.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      const assessed = second.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(findings(assessed.data.observations)).toEqual([]);
      expect(second.ops.releaseKillSwitch('global', 'founder').ok).toBe(true);
      second.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('survives VACUUM, which is the legitimate act that rewrites the whole file', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      expect(commitmentWitnessPresent(raw)).toBe(true);
      raw.exec('VACUUM');
      // `VACUUM` preserves the header slot, so a maintenance act neither raises
      // a false alarm nor launders a real one.
      expect(commitmentWitnessPresent(raw)).toBe(true);
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

  it('says so in the statement that crosses to the Founder', () => {
    expect(SAFE_MODE_STATEMENT).toContain('present and EMPTY on a file HQ has committed on is blocking');
    expect(SAFE_MODE_STATEMENT).toContain('that check does not live in any table');
  });
});
