/**
 * Wave 5, correction round seven, HIGH 3 — one permitted APPEND could make HQ
 * condemn its own store on a claim nothing stood behind.
 *
 * `committedLedgerIdentities` and `contradictedChainCommitment` read the
 * commitment ledger's stored columns and take them at their word, and APPENDING
 * to that ledger is the one write its own append-only trio deliberately
 * permits. So a single `INSERT` — no trigger dropped, no restart, no guard
 * touched — was enough to brick the whole control plane with a finding that was
 * true of nothing and that no in-HQ act could clear. Three routes, all executed
 * against `ae4bf90` before anything was changed:
 *
 *  - an over-stated `ledger_marks` → `regressedImmutableLedgers
 *    ["hq_reliability_verdicts","op_evidence"]`, `p2/p3 boot=true assess=true
 *    release=refused`, and HQ told the Founder that those named ledgers "were
 *    DROPPED and are back empty" when nothing had touched them;
 *  - an over-stated `chain_length` of 999999 → `evidence_chain_broken`, the same
 *    way, over a log that verified perfectly;
 *  - an over-stated `ledger_rows`, which the round-seven row-count commitment
 *    would otherwise have opened as a third route.
 *
 * This is the failure the module already forbids in both directions — the
 * round-six correction on `immutableLedgerMarks` says a fabricated finding is
 * forbidden in the FALSE-ALARM direction exactly as in the false-reassurance
 * one. It had not closed; it had MOVED, from `sqlite_sequence` to the commitment
 * ledger's own permitted append, and it had got cheaper on the way.
 *
 * **The repair that was tried and rejected is pinned here too**, because it is
 * the obvious one and the next reader will reach for it: capping a commitment at
 * read time by the engine's own high-water mark defeats every forgery above AND
 * hands back an evasion that is closed today, since `sqlite_sequence` is
 * writable. The last test in this file is the evasion, and it must keep failing
 * for the attacker.
 */

import { describe, expect, it } from 'vitest';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  HQ_INTEGRITY_CHECKPOINT_TABLE,
  contradictedChainCommitment,
  declaredGuardsFor,
  declaredLedgerIdentities,
  regressedImmutableLedgers,
} from '../src/store/integrity.js';

const OVERCLAIM_GUARD = 'trg_hq_integrity_checkpoints_no_overclaim';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

function warm(fx: FileFixture, times = 3): void {
  for (let i = 0; i < times; i += 1) {
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
  }
}

/** The newest genuine commitment, which every forgery below starts from. */
function newest(raw: HqDatabase): {
  chain_length: number;
  tip_hash: string;
  ledger_marks: string;
  ledger_rows: string;
} {
  return raw
    .prepare(
      `SELECT chain_length, tip_hash, ledger_marks, ledger_rows
         FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} ORDER BY seq DESC LIMIT 1`,
    )
    .get() as { chain_length: number; tip_hash: string; ledger_marks: string; ledger_rows: string };
}

/** Append one checkpoint, as a raw writer with no HQ code in the path. */
function append(
  raw: HqDatabase,
  row: { chainLength: number; tipHash: string; marks: unknown; rows: unknown; seq?: number },
): void {
  const columns = row.seq === undefined ? '' : 'seq, ';
  const values = row.seq === undefined ? '' : '?, ';
  const args: unknown[] = row.seq === undefined ? [] : [row.seq];
  raw
    .prepare(
      `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
         (${columns}id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
       VALUES (${values}?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ...args,
      `forged-${Math.random().toString(36).slice(2)}`,
      new Date().toISOString(),
      row.chainLength,
      row.tipHash,
      JSON.stringify(row.marks),
      JSON.stringify(row.rows),
      'attacker',
      'attacker',
    );
}

/** Every guard the schema DECLARES on the commitment ledger. */
function declaredCheckpointGuards(): string[] {
  const entry = ENGINE_IMMUTABLE_TABLES.find((row) => row.table === HQ_INTEGRITY_CHECKPOINT_TABLE);
  if (!entry) throw new Error('the commitment ledger is no longer a declared ledger');
  return declaredGuardsFor(entry);
}

/** Clean at both depths, in two further processes, with the refused act admitted. */
function expectNoFinding(fx: FileFixture, tags: readonly string[]): void {
  for (const tag of tags) {
    const process = fx.reopen(tag);
    const boot = process.ops.hqReliabilityPosture().integrity;
    expect(boot.safeMode, `${tag} boot`).toBe(false);
    expect(findings(boot.observations), `${tag} boot`).toEqual([]);
    const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) throw new Error('unreachable');
    expect(assessed.data.safeMode, `${tag} assessment`).toBe(false);
    expect(findings(assessed.data.observations), `${tag} assessment`).toEqual([]);
    expect(process.ops.releaseKillSwitch('global', 'founder').ok, `${tag} release`).toBe(true);
    process.db.close();
  }
}

describe('a commitment HQ could not have made is refused where it is written', () => {
  it('declares the over-claim guard beside the trio, so its absence is a census finding', () => {
    const fx = fileFixture();
    try {
      expect(declaredCheckpointGuards()).toContain(OVERCLAIM_GUARD);
      const present = (
        fx.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
          .all(HQ_INTEGRITY_CHECKPOINT_TABLE) as { name: string }[]
      ).map((row) => row.name);
      expect(present.sort()).toEqual([...declaredCheckpointGuards()].sort());
    } finally {
      fx.cleanup();
    }
  });

  it('refuses an over-stated ledger mark, and reports nothing afterwards', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const last = newest(raw);
      const marks = { ...JSON.parse(last.ledger_marks), op_evidence: 999, hq_reliability_verdicts: 999 };
      expect(() =>
        append(raw, {
          chainLength: last.chain_length,
          tipHash: last.tip_hash,
          marks,
          rows: JSON.parse(last.ledger_rows),
        }),
      ).toThrow(/may not commit beyond the record/);
      // Nothing landed, so nothing is condemned — and the file's own ledgers are
      // exactly where they were.
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      raw.close();

      expectNoFinding(fx, ['marks-one', 'marks-two']);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses an over-stated chain length, and reports nothing afterwards', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const last = newest(raw);
      expect(() =>
        append(raw, {
          chainLength: 999999,
          tipHash: last.tip_hash,
          marks: JSON.parse(last.ledger_marks),
          rows: JSON.parse(last.ledger_rows),
        }),
      ).toThrow(/may not commit beyond the record/);
      expect(contradictedChainCommitment(raw)).toBeNull();
      raw.close();

      expectNoFinding(fx, ['chain-one', 'chain-two']);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses an over-stated row count, the route the row commitment would otherwise open', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const last = newest(raw);
      const rows = { ...JSON.parse(last.ledger_rows), op_evidence: 999 };
      expect(() =>
        append(raw, {
          chainLength: last.chain_length,
          tipHash: last.tip_hash,
          marks: JSON.parse(last.ledger_marks),
          rows,
        }),
      ).toThrow(/may not commit beyond the record/);
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      raw.close();

      expectNoFinding(fx, ['rows-one', 'rows-two']);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a claim about EVERY declared ledger, derived rather than sampled', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const last = newest(raw);
      const identities = declaredLedgerIdentities(raw);
      // Enumerated from the DECLARATION, which is the whole point of this round:
      // a hand-picked sample of two ledgers is the same mistake in a new place.
      for (const entry of ENGINE_IMMUTABLE_TABLES) {
        const held = identities[entry.table] ?? { rows: 0, top: 0 };
        expect(
          () =>
            append(raw, {
              chainLength: last.chain_length,
              tipHash: last.tip_hash,
              marks: { ...JSON.parse(last.ledger_marks), [entry.table]: held.top + 1 },
              rows: JSON.parse(last.ledger_rows),
            }),
          `${entry.table} mark`,
        ).toThrow(/may not commit beyond the record/);
        expect(
          () =>
            append(raw, {
              chainLength: last.chain_length,
              tipHash: last.tip_hash,
              marks: JSON.parse(last.ledger_marks),
              rows: { ...JSON.parse(last.ledger_rows), [entry.table]: held.rows + 1 },
            }),
          `${entry.table} rows`,
        ).toThrow(/may not commit beyond the record/);
      }
      raw.close();
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The guard must not refuse what HQ itself writes. A checkpoint commits
   * exactly what the file holds at that moment, so the bound is never reached —
   * and if it ever were, HQ would stop committing anything at all, silently,
   * which is the worst outcome available here.
   */
  it('never refuses HQ’s own checkpoints, over repeated boots and real work', () => {
    const fx = fileFixture();
    try {
      const committed = (): number =>
        (
          fx.db.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as {
            n: number;
          }
        ).n;
      warm(fx, 4);
      expect(committed()).toBeGreaterThan(1);
      fx.db.close();
      for (const tag of ['ordinary-one', 'ordinary-two', 'ordinary-three']) {
        const process = fx.reopen(tag);
        expect(process.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok, tag).toBe(true);
        const rows = (
          process.db.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as {
            n: number;
          }
        ).n;
        expect(rows, `${tag} kept committing`).toBeGreaterThan(1);
        expect(findings(process.ops.hqReliabilityPosture().integrity.observations), tag).toEqual([]);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The price, measured rather than described. The guard is not a boundary — it
   * is the same three statements every other tamper in this module costs, and
   * the same standing residual: a guard dropped and re-created before the next
   * boot is never observed missing. What is closed is the INVERSION, where
   * fabricating a finding was cheaper than everything else HQ defends against.
   */
  it('costs three statements rather than one, and says so', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const last = newest(raw);
      const guard = (
        raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?`)
          .get(OVERCLAIM_GUARD) as { sql: string }
      ).sql;
      raw.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      append(raw, {
        chainLength: last.chain_length,
        tipHash: last.tip_hash,
        marks: { ...JSON.parse(last.ledger_marks), op_evidence: 999 },
        rows: JSON.parse(last.ledger_rows),
      });
      raw.exec(guard);
      expect(regressedImmutableLedgers(raw)).toContain('op_evidence');
      raw.close();
      const process = fx.reopen('after-three-statements');
      expect(process.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      process.db.close();
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * The evasion the rejected read-time repair would have handed back.
 *
 * Capping a commitment at read time by `sqlite_sequence` defeats every forgery
 * above — and this file's tail truncation, which is caught today, would then be
 * hidden by one further `UPDATE`. The commitment must therefore keep believing
 * the greatest value it recorded, and it does.
 */
describe('a commitment is not capped by a number the attacker can write', () => {
  it('still catches a tail truncation that writes the engine mark down to match', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      const marksBefore = declaredLedgerIdentities(fx.db).hq_reliability_verdicts;
      expect(marksBefore.rows).toBeGreaterThan(1);
      fx.db.close();

      const raw = fx.raw();
      const guards = (
        raw
          .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
          .all('hq_reliability_verdicts') as { name: string; sql: string }[]
      );
      for (const guard of guards) raw.exec(`DROP TRIGGER ${guard.name}`);
      raw.exec(`DELETE FROM hq_reliability_verdicts WHERE rowid > 1`);
      for (const guard of guards) raw.exec(guard.sql);
      // The one further statement that would defeat a read-time cap.
      raw.exec(`UPDATE sqlite_sequence SET seq = 1 WHERE name = 'hq_reliability_verdicts'`);
      expect(regressedImmutableLedgers(raw)).toContain('hq_reliability_verdicts');
      raw.close();

      const process = fx.reopen('after-lowered-mark');
      expect(process.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      expect(process.ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      process.db.close();
    } finally {
      fx.cleanup();
    }
  });
});
