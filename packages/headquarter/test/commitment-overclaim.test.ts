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
  CHECKPOINT_COLUMNS_THAT_DECIDE_NOTHING,
  declaredLedgerIdentities,
  elidedCommitmentLedgerRows,
  regressedImmutableLedgers,
  truncatedImmutableLedgers,
  unboundedCheckpointColumns,
} from '../src/store/integrity.js';

const OVERCLAIM_GUARD = 'trg_hq_integrity_checkpoints_no_overclaim';

/**
 * 5 s is vitest's default and is not a measurement. The probes below open real
 * file-backed HQ databases and, in the enumeration, compose several thousand
 * raw `INSERT`s against one, so each carries the deadline this branch gives
 * every file-backed probe rather than inheriting the harness default.
 */
const FILE_BACKED_PROBE_TIMEOUT_MS = 120_000;

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

/**
 * Wave 5, correction round twelve, HIGH 1 — the guard above was bypassed by a
 * DUPLICATE JSON KEY, at one statement.
 *
 * `json_extract(x, '$.k')` returns the FIRST value a duplicated key carries;
 * `json_each(x)` yields every one of them. The guard bounded a commitment with
 * `json_extract` and `committedGreatest` read it back with `json_each` + `MAX`,
 * so a single `INSERT` whose `ledger_marks` named the same ledger twice — the
 * legal value first, the forged value second — was bounded by the legal one and
 * believed at the forged one. Executed against `48dd026` on a file built by this
 * package's own fixture: the plain over-claim was REFUSED and
 * `{"op_evidence":4,"op_evidence":999}` was ACCEPTED, after which
 * `regressedImmutableLedgers` reported `["op_evidence"]` and the file latched
 * `append_only_guard_missing` with `safeMode: true`, permanently, about a log
 * nothing had touched.
 *
 * That is the round-seven defect re-opened by a second route, and the direction
 * matters: it FABRICATES a finding. The module forbids that in the alarm
 * direction exactly as in the reassurance direction, so this file pins the
 * refusal rather than the survivability of the alarm.
 */
describe('a commitment whose JSON does not have one value per key is refused', () => {
  /**
   * Append one checkpoint with the two JSON columns written as RAW TEXT.
   *
   * `append` above builds them with `JSON.stringify`, which cannot express a
   * duplicated key — so the attack is unreachable through it, and reaching the
   * attack is the whole point of this block.
   */
  function appendRawJson(raw: HqDatabase, marks: string, rows: string, chainLength = 0): void {
    raw
      .prepare(
        `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
           (id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `forged-${Math.random().toString(36).slice(2)}`,
        new Date().toISOString(),
        chainLength,
        '',
        marks,
        rows,
        'attacker',
        'attacker',
      );
  }

  /** Whether the ledger accepted the row, and the refusal message when it did not. */
  function attempt(raw: HqDatabase, marks: string, rows: string): { accepted: boolean; message: string } {
    try {
      appendRawJson(raw, marks, rows);
      return { accepted: true, message: '' };
    } catch (error) {
      return { accepted: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  it('refuses the duplicate-key over-claim on ledger_marks, which one INSERT used to land', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const genuine = Number(JSON.parse(newest(raw).ledger_marks).op_evidence);
      expect(genuine).toBeGreaterThan(0);

      // The CONTROL: the plain over-claim the round-seven guard already refused,
      // so this test cannot pass because the ledger refuses everything.
      const plain = attempt(raw, JSON.stringify({ op_evidence: 999 }), '{}');
      expect(plain.accepted, 'the plain over-claim must stay refused').toBe(false);

      // The ATTACK, at one statement: legal value first, forged value second.
      const duplicated = attempt(raw, `{"op_evidence":${genuine},"op_evidence":999}`, '{}');
      expect(duplicated.accepted, 'a duplicated key must not carry an over-claim past the guard').toBe(
        false,
      );
      expect(duplicated.message).toMatch(/may not commit beyond the record/);
      raw.close();

      // And the fabricated finding it used to manufacture is simply absent.
      expect(regressedImmutableLedgers(fx.raw())).toEqual([]);
      expectNoFinding(fx, ['after-refused-duplicate-marks']);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses the same shape on ledger_rows, which was the second landed route', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const genuine = Number(JSON.parse(newest(raw).ledger_rows).op_evidence);
      expect(genuine).toBeGreaterThan(0);
      const duplicated = attempt(raw, '{}', `{"op_evidence":${genuine},"op_evidence":999}`);
      expect(duplicated.accepted, 'the row-count half must refuse it too').toBe(false);
      raw.close();
      expect(regressedImmutableLedgers(fx.raw())).toEqual([]);
      expectNoFinding(fx, ['after-refused-duplicate-rows']);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a duplicated key even when both values are legal, because the parses may not differ', () => {
    // The refusal is of the AMBIGUITY, not of the over-claim: a value the two
    // spellings could read differently never lands, so no reader has to be
    // trusted to have picked the same one.
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const genuine = Number(JSON.parse(newest(raw).ledger_marks).op_evidence);
      expect(attempt(raw, `{"op_evidence":${genuine},"op_evidence":${genuine}}`, '{}').accepted).toBe(
        false,
      );
      // A JSON SCALAR is the same ambiguity in the other direction: `json_each`
      // yields one row with a NULL key, so its cardinality exceeds its distinct
      // key count too.
      expect(attempt(raw, 'null', '{}').accepted).toBe(false);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });

  it('still accepts every commitment HQ itself writes, and keeps recording new ones', () => {
    // The half that must never move: a refusal that also refused HQ's own
    // checkpoints would stop the commitment ledger advancing at all, which is a
    // worse outcome than the attack it closes.
    const fx = fileFixture();
    try {
      const before = (
        fx.db.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as { n: number }
      ).n;
      warm(fx);
      const after = (
        fx.db.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as { n: number }
      ).n;
      expect(after, 'HQ must still be able to commit').toBeGreaterThan(before);
      fx.db.close();

      // An empty commitment and an ordinary one are both still writable by a raw
      // writer, so the clause refuses the ambiguous shape and nothing wider.
      const raw = fx.raw();
      expect(attempt(raw, '{}', '{}').accepted).toBe(true);
      raw.close();
      expectNoFinding(fx, ['after-legitimate-commitments']);
    } finally {
      fx.cleanup();
    }
  });

  it('leaves the three-statement price as the cheapest path, by executing it', () => {
    // Without this the block above would pass on a ledger that had simply
    // stopped accepting forgeries by some unrelated means. The disclosed price
    // is three statements, and three statements still reach.
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
      appendRawJson(raw, JSON.stringify({ op_evidence: 999 }), '{}', last.chain_length);
      raw.exec(guard);
      expect(regressedImmutableLedgers(raw)).toContain('op_evidence');
      raw.close();
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * Wave 5, correction round THIRTEEN, HIGH 1 — the guard bounded THREE of the
 * row's columns and left `tip_hash` and the explicit `seq` unbounded, so ONE
 * permitted `INSERT` still fabricated a permanent, unclearable safe mode while
 * three shipped sentences said it could not.
 *
 * The adversary is the one this guard was built for and priced against: a local
 * process with raw SQLite write access, using INSERT only — no DDL, no
 * `DROP TRIGGER`, no `UPDATE`, no `sqlite_sequence` write, no restart and no
 * Founder act. Appending to this ledger is exactly the write its own
 * append-only trio deliberately permits.
 *
 *  - **Exploit A, a forged tip hash at a legal chain length.** Every clause the
 *    guard carried passed: `chain_length` did not exceed the committed
 *    `op_evidence` mark, that mark did not exceed the ledger's `MAX(rowid)`,
 *    `ledger_rows` claimed nothing, and both JSON columns had one value per key.
 *    `contradictedChainCommitment` then read `tip_hash` — which nothing bounded
 *    — and reported `evidence_chain_broken` over a log that verified perfectly.
 *  - **Exploit B, a caller-chosen rowid, with every COMMITTED value truthful.**
 *    `trg_hq_integrity_checkpoints_no_replace` refuses an explicit `seq` that
 *    already exists, and a hostile one does not exist. The row landed at rowid
 *    1000, `elidedCommitmentLedgerRows` compared the ledger's row count against
 *    its greatest rowid, and reported `append_only_guard_missing` — HQ telling
 *    the Founder its own commitment ledger had been rewritten, on a file where
 *    only an append had happened.
 *
 * Both were unclearable: the finding is re-derived from the file as it stands,
 * the forged row cannot be deleted or updated by its own guards, and every
 * restart re-raises it. Safe mode then permanently refuses approve, claim,
 * release-kill-switch, execute-external-action, register-worker and
 * declare-provider — the whole control plane — on a healthy store.
 *
 * The ROOT CAUSE is the class, not the two instances: round twelve reasoned
 * about `chain_length` explicitly and never looked one column over. So the last
 * block below is not another exploit — it derives the guard's obligations from
 * `PRAGMA table_info` and fails the day a column is added without a bound.
 */
describe('no single INSERT a raw writer can compose fabricates a finding', () => {
  /** Every column of the commitment ledger, as the FILE declares them. */
  function checkpointColumns(raw: HqDatabase): string[] {
    return (
      raw.prepare(`PRAGMA table_info(${HQ_INTEGRITY_CHECKPOINT_TABLE})`).all() as { name: string }[]
    ).map((column) => column.name);
  }

  /** The newest genuine commitment, EVERY column of it. */
  function newestWholeRow(raw: HqDatabase): Record<string, unknown> {
    return raw
      .prepare(`SELECT * FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} ORDER BY seq DESC LIMIT 1`)
      .get() as Record<string, unknown>;
  }

  /**
   * One raw `INSERT` naming exactly the columns given, with no HQ code in the
   * path. Returns whether it landed and the refusal when it did not.
   */
  function insertRow(
    raw: HqDatabase,
    columns: readonly string[],
    values: Record<string, unknown>,
  ): { accepted: boolean; message: string } {
    try {
      raw
        .prepare(
          `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE} ` +
            `(${columns.map((column) => `"${column}"`).join(', ')}) ` +
            `VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .run(columns.map((column) => values[column] as never));
      return { accepted: true, message: '' };
    } catch (error) {
      return { accepted: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Every reading that can turn this ledger into a BLOCKING finding.
   *
   * Derived from `structuralIntegrity`, not chosen: `regressedImmutableLedgers`
   * and `elidedCommitmentLedgerRows` are the two inputs to its
   * `append_only_guard_missing`, `truncatedImmutableLedgers` is its
   * `append_only_ledger_truncated`, and `contradictedChainCommitment` is its
   * `evidence_chain_broken` — which is also the one this ledger contributes to
   * the FULL depth's chain verification. Nothing else in the module reads
   * `hq_integrity_checkpoints` into an observation.
   */
  function ledgerReadings(raw: HqDatabase): {
    regressed: string[];
    truncated: string[];
    contradicted: number | null;
    elided: boolean;
  } {
    return {
      regressed: regressedImmutableLedgers(raw),
      truncated: truncatedImmutableLedgers(raw),
      contradicted: contradictedChainCommitment(raw),
      elided: elidedCommitmentLedgerRows(raw),
    };
  }

  const NOTHING_REPORTED = { regressed: [], truncated: [], contradicted: null, elided: false };

  it(
    'refuses Exploit A: a forged tip hash at a legal chain length, in one INSERT',
    () => {
      const fx = fileFixture();
      try {
        warm(fx);
        fx.db.close();

        const raw = fx.raw();
        const columns = checkpointColumns(raw);
        const genuine = newestWholeRow(raw);
        expect(Number(genuine.chain_length)).toBeGreaterThan(0);
        // Every OTHER column is exactly what HQ itself committed a moment ago —
        // the marks, the row counts and the chain length all still fit the file.
        // Only the hash is forged, and it is a well-formed 64-hex one so nothing
        // can refuse it for its shape.
        const forgedHash = '0'.repeat(64);
        expect(forgedHash).not.toBe(String(genuine.tip_hash));
        const attempt = insertRow(raw, columns, {
          ...genuine,
          seq: null,
          id: 'forged-tip-hash',
          tip_hash: forgedHash,
          process_id: 'attacker',
          recorded_by: 'attacker',
        });
        expect(attempt.accepted, 'one INSERT must not fabricate evidence_chain_broken').toBe(false);
        expect(attempt.message).toMatch(/may not commit beyond the record/);
        expect(ledgerReadings(raw)).toEqual(NOTHING_REPORTED);
        raw.close();

        expectNoFinding(fx, ['forged-tip-one', 'forged-tip-two']);
      } finally {
        fx.cleanup();
      }
    },
    FILE_BACKED_PROBE_TIMEOUT_MS,
  );

  it(
    'refuses Exploit B: a caller-chosen rowid, with every committed value truthful',
    () => {
      const fx = fileFixture();
      try {
        warm(fx);
        fx.db.close();

        const raw = fx.raw();
        const columns = checkpointColumns(raw);
        const genuine = newestWholeRow(raw);
        // NOTHING here is a lie about the file. The chain length, the tip hash,
        // the marks and the row counts are the ones HQ wrote. Only the ROWID is
        // hostile, and `no_replace` refuses an explicit `seq` that already
        // EXISTS — 1000 does not.
        const attempt = insertRow(raw, columns, {
          ...genuine,
          seq: 1000,
          id: 'forged-seq',
          process_id: 'attacker',
          recorded_by: 'attacker',
        });
        expect(attempt.accepted, 'one INSERT must not fabricate append_only_guard_missing').toBe(
          false,
        );
        expect(attempt.message).toMatch(/may not commit beyond the record/);
        expect(ledgerReadings(raw)).toEqual(NOTHING_REPORTED);
        raw.close();

        expectNoFinding(fx, ['forged-seq-one', 'forged-seq-two']);
      } finally {
        fx.cleanup();
      }
    },
    FILE_BACKED_PROBE_TIMEOUT_MS,
  );

  /**
   * MINIMALITY, by enumeration rather than by sample.
   *
   * The two three-statement tests above this block establish that three
   * statements SUFFICE. Neither establishes that ONE does not, and that is the
   * half the shipped price sentence actually asserts — so it is the half that
   * has to be executed. Every column the file declares is perturbed through
   * every hostile shape this ledger's readers can tell apart, singly and then in
   * the full cross-product over the five columns that DECIDE anything; each
   * attempt is either refused at the write, or lands and is read back through
   * every reading that can turn this ledger into a blocking finding.
   *
   * Each attempt runs inside a `SAVEPOINT` that is rolled back, so the file the
   * next attempt sees is the intact one — `sqlite_sequence` included, which is
   * an ordinary table and rolls back with everything else.
   */
  it(
    'no single INSERT, over every column and every shape, makes an intact store report anything',
    () => {
      const fx = fileFixture();
      try {
        warm(fx);
        fx.db.close();

        const raw = fx.raw();
        const columns = checkpointColumns(raw);
        const genuine = newestWholeRow(raw);
        const before = ledgerReadings(raw);
        expect(before, 'the store must be intact before the enumeration').toEqual(NOTHING_REPORTED);
        const shapeBefore = raw
          .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top ` +
              `FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`,
          )
          .get() as { rows: number; top: number };

        const marks = JSON.parse(String(genuine.ledger_marks)) as Record<string, number>;
        const held = JSON.parse(String(genuine.ledger_rows)) as Record<string, number>;
        const chain = Number(genuine.chain_length);
        const existingId = (
          raw
            .prepare(`SELECT id FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} ORDER BY seq LIMIT 1`)
            .get() as { id: string }
        ).id;

        /**
         * The hostile shapes, per column. Written against what the READERS can
         * distinguish — an over-claim, an under-claim, a forged hash, a chosen
         * rowid, a duplicated JSON key, a scalar, malformed JSON, a wrong type —
         * plus, in every set, the value HQ itself would have written, so the
         * enumeration cannot pass by refusing everything.
         */
        const shapes: Record<string, unknown[]> = {
          seq: [null, shapeBefore.top + 1, 1, 0, -1, 1000, 2 ** 31, 'x'],
          id: ['fresh-id', existingId, ''],
          recorded_at: [String(genuine.recorded_at), '', 'not-a-time'],
          chain_length: [chain, 0, chain + 1, 999_999, -1],
          tip_hash: [String(genuine.tip_hash), '', '0'.repeat(64), 'f'.repeat(64), 'not-a-hash'],
          ledger_marks: [
            String(genuine.ledger_marks),
            '{}',
            JSON.stringify({ ...marks, op_evidence: (marks.op_evidence ?? 0) + 1000 }),
            `{"op_evidence":${marks.op_evidence ?? 0},"op_evidence":999999}`,
            'null',
            '{"op_evidence":',
          ],
          ledger_rows: [
            String(genuine.ledger_rows),
            '{}',
            JSON.stringify({ ...held, op_evidence: (held.op_evidence ?? 0) + 1000 }),
            `{"op_evidence":${held.op_evidence ?? 0},"op_evidence":999999}`,
            'null',
            '{"op_evidence":',
          ],
          process_id: ['attacker', ''],
          recorded_by: ['attacker', ''],
        };
        // The enumeration is over the FILE's columns, so a column added to the
        // ledger without a shape set here fails loudly rather than being skipped.
        expect(Object.keys(shapes).sort()).toEqual([...columns].sort());

        /** The columns whose value any reader of this ledger acts on. */
        const deciding = ['seq', 'chain_length', 'tip_hash', 'ledger_marks', 'ledger_rows'];

        let attempts = 0;
        let landed = 0;
        const fabricated: string[] = [];
        const attempt = (values: Record<string, unknown>, label: string): void => {
          attempts += 1;
          raw.exec('SAVEPOINT probe');
          const result = insertRow(raw, columns, values);
          if (result.accepted) {
            landed += 1;
            const after = ledgerReadings(raw);
            if (JSON.stringify(after) !== JSON.stringify(NOTHING_REPORTED)) {
              fabricated.push(`${label} -> ${JSON.stringify(after)}`);
            }
          }
          raw.exec('ROLLBACK TO probe');
          raw.exec('RELEASE probe');
        };

        // 1. Every column, every shape, one at a time.
        let fresh = 0;
        for (const column of columns) {
          for (const value of shapes[column]) {
            fresh += 1;
            attempt(
              { ...genuine, seq: null, id: `single-${fresh}`, ...{ [column]: value } },
              `single ${column}=${String(value)}`,
            );
          }
        }

        // 2. The full cross-product over the columns that decide something,
        //    because a bound that holds one column at a time can still be walked
        //    round by two at once — which is exactly how Exploit A got past a
        //    guard that already bounded `chain_length`.
        for (const seq of shapes.seq) {
          for (const chainLength of shapes.chain_length) {
            for (const tipHash of shapes.tip_hash) {
              for (const ledgerMarks of shapes.ledger_marks) {
                for (const ledgerRows of shapes.ledger_rows) {
                  fresh += 1;
                  attempt(
                    {
                      ...genuine,
                      id: `combo-${fresh}`,
                      seq,
                      chain_length: chainLength,
                      tip_hash: tipHash,
                      ledger_marks: ledgerMarks,
                      ledger_rows: ledgerRows,
                      process_id: 'attacker',
                      recorded_by: 'attacker',
                    },
                    `combo seq=${String(seq)} len=${String(chainLength)} tip=${String(tipHash).slice(0, 8)} ` +
                      `marks=${String(ledgerMarks)} rows=${String(ledgerRows)}`,
                  );
                }
              }
            }
          }
        }

        expect(fabricated, 'a single INSERT still fabricates a finding').toEqual([]);
        // Not vacuous in either direction: the enumeration reached thousands of
        // attempts, and some of them LANDED — a ledger that simply refused every
        // append would satisfy the assertion above while proving nothing.
        expect(attempts).toBeGreaterThan(1_000);
        expect(landed, 'the ledger must still accept an ordinary append').toBeGreaterThan(0);
        expect(deciding.every((column) => columns.includes(column))).toBe(true);

        // The file is exactly where it started: every attempt was rolled back.
        expect(
          raw
            .prepare(
              `SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top ` +
                `FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`,
            )
            .get(),
        ).toEqual(shapeBefore);
        expect(ledgerReadings(raw)).toEqual(NOTHING_REPORTED);
        raw.close();

        expectNoFinding(fx, ['after-enumeration']);
      } finally {
        fx.cleanup();
      }
    },
    FILE_BACKED_PROBE_TIMEOUT_MS,
  );

  /**
   * What the `AFTER INSERT` timing costs and does not cost, executed.
   *
   * The rowid clause could not be spelled `BEFORE INSERT`: SQLite reports an
   * omitted `AUTOINCREMENT` rowid there as the integer `-1`, which is a value a
   * caller can also supply and which lands at rowid -1 and breaks the ledger's
   * identity exactly as 1000 does. Moving the timing is what separates "the
   * engine will choose" from "the caller chose". Three properties have to hold
   * for that to be a free move, and each is measured here rather than asserted
   * in the docblock: the refusal still reaches every spelling of an `INSERT`,
   * the rejected row does not persist, and it does not burn a sequence value —
   * a burned one would leave `elidedCommitmentLedgerRows` reporting for ever,
   * which is the very failure this round is closing.
   */
  it(
    'refuses the reseat under every INSERT spelling, and burns no sequence value doing it',
    () => {
      const fx = fileFixture();
      try {
        warm(fx);
        fx.db.close();

        const raw = fx.raw();
        const columns = checkpointColumns(raw);
        const genuine = newestWholeRow(raw);
        const shape = (): unknown =>
          raw
            .prepare(
              `SELECT (SELECT COUNT(*) FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}) AS rows, ` +
                `(SELECT COALESCE(MAX(rowid), 0) FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}) AS top, ` +
                `(SELECT seq FROM sqlite_sequence WHERE name = '${HQ_INTEGRITY_CHECKPOINT_TABLE}') AS mark`,
            )
            .get();
        const before = shape();

        for (const spelling of ['INSERT', 'INSERT OR REPLACE', 'INSERT OR IGNORE']) {
          // -1 is the placeholder value a `BEFORE INSERT` clause cannot tell from
          // an omitted rowid; 0 and 1000 are the ordinary reseats. All three land
          // OUTSIDE the ledger's identity and all three must be refused.
          for (const seq of [-1, 0, 1000]) {
            let landed = false;
            let message = '';
            try {
              raw
                .prepare(
                  `${spelling} INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE} ` +
                    `(${columns.map((column) => `"${column}"`).join(', ')}) ` +
                    `VALUES (${columns.map(() => '?').join(', ')})`,
                )
                .run(
                  columns.map((column) =>
                    column === 'seq'
                      ? (seq as never)
                      : column === 'id'
                        ? (`reseat-${spelling}-${seq}` as never)
                        : (genuine[column] as never),
                  ),
                );
              landed = true;
            } catch (error) {
              message = error instanceof Error ? error.message : String(error);
            }
            expect(landed, `${spelling} at seq ${seq} must be refused`).toBe(false);
            expect(message).toMatch(/may not commit beyond the record/);
          }
        }

        // Nothing persisted, and — the half that matters — the AUTOINCREMENT
        // high-water mark is exactly where it was. A refusal that raised it
        // would put `rows`, `top` and `mark` out of step and manufacture the
        // finding by another route.
        expect(shape()).toEqual(before);
        expect(ledgerReadings(raw)).toEqual(NOTHING_REPORTED);
        raw.close();

        expectNoFinding(fx, ['after-reseat-spellings']);
      } finally {
        fx.cleanup();
      }
    },
    FILE_BACKED_PROBE_TIMEOUT_MS,
  );
});

/**
 * The CLASS, not the two instances.
 *
 * Round seven bounded `ledger_marks`. Its own follow-up bounded `ledger_rows`
 * and `chain_length`. Round twelve re-read all three for the duplicate-key parse
 * and never looked at `tip_hash` or `seq`. Every one of those rounds shipped a
 * sentence stating the price of a guard whose clause set had been written out by
 * hand, and every one of them was one column short of the enumeration the
 * sentence assumed.
 *
 * This block does not test a column. It derives the obligation from
 * `PRAGMA table_info` of the ledger as the FILE declares it, checks it against
 * the guard as `sqlite_master` holds it, and fails when the two disagree — so
 * the next column added to this table is bounded, or explicitly declared to
 * decide nothing, on the day it is added rather than in the round that finds it.
 */
describe('every column of the commitment ledger is bounded or declared to decide nothing', () => {
  it('leaves no column of the real table outside the guard’s clause set', () => {
    const fx = fileFixture();
    try {
      // Against the real, constructed store — not against the DDL string, which
      // is what a hand-written enumeration was already checking itself against.
      expect(unboundedCheckpointColumns(fx.db)).toEqual([]);
      fx.db.close();
      const raw = fx.raw();
      expect(unboundedCheckpointColumns(raw)).toEqual([]);

      // Not vacuous: the derivation must actually SEE the table's columns, and
      // the four it excuses must be a strict subset of them.
      const columns = (
        raw.prepare(`PRAGMA table_info(${HQ_INTEGRITY_CHECKPOINT_TABLE})`).all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      expect(columns.length).toBeGreaterThan(CHECKPOINT_COLUMNS_THAT_DECIDE_NOTHING.length);
      for (const excused of CHECKPOINT_COLUMNS_THAT_DECIDE_NOTHING) {
        expect(columns, `${excused} is excused but is not a column of the ledger`).toContain(
          excused,
        );
      }
      // And every column NOT excused is named by the guard's own text, which is
      // the property `unboundedCheckpointColumns` returns the complement of.
      const guard = (
        raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?`)
          .get(OVERCLAIM_GUARD) as { sql: string }
      ).sql;
      for (const column of columns) {
        if (CHECKPOINT_COLUMNS_THAT_DECIDE_NOTHING.includes(column)) continue;
        expect(guard, `${column} is unbounded in the over-claim guard`).toContain(`NEW.${column}`);
      }
      raw.close();
    } finally {
      fx.cleanup();
    }
  });

  it('reports a column the guard stops naming, and reports every one when the guard is gone', () => {
    // The derivation has to FAIL when the property fails, or it is decoration.
    // Both directions are executed against a real file: a guard re-created
    // without one clause, and no guard at all.
    const fx = fileFixture();
    try {
      fx.db.close();
      const raw = fx.raw();
      const guard = (
        raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?`)
          .get(OVERCLAIM_GUARD) as { sql: string }
      ).sql;

      raw.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      // Fail-CLOSED: no guard means nothing is bounded, and every deciding
      // column is reported rather than none.
      expect(unboundedCheckpointColumns(raw).sort()).toEqual(
        ['chain_length', 'ledger_marks', 'ledger_rows', 'seq', 'tip_hash'].sort(),
      );

      // One clause removed — the exact shape of the round-thirteen defect.
      const withoutTipHash = guard
        .split('\n')
        .filter((line) => !line.includes('NEW.tip_hash'))
        .join('\n');
      expect(withoutTipHash).not.toContain('NEW.tip_hash');
      raw.exec(withoutTipHash);
      expect(unboundedCheckpointColumns(raw)).toEqual(['tip_hash']);

      raw.exec(`DROP TRIGGER ${OVERCLAIM_GUARD}`);
      raw.exec(guard);
      expect(unboundedCheckpointColumns(raw)).toEqual([]);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });
});
