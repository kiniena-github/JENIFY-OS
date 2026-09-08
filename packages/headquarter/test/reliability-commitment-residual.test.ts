/**
 * The commitment ledger's residual, EXECUTED rather than described (Wave 5
 * correction round seven, Low 2).
 *
 * `elidedCommitmentLedgerRows` closes the forgery that DELETES commitment rows
 * and re-seats the table. Two rounds of residual text then priced the forgery
 * that survives, and both prices were wrong in the reassuring direction because
 * the version WITHOUT the barrier they named was never run:
 *
 *  - round five wrote that the surviving repair is "the replacement inserted at
 *    an explicit `seq = 1`, then one `UPDATE sqlite_sequence` for that ledger".
 *    That path is not the cheapest, and on a file carrying more than one
 *    commitment it is CAUGHT — collapsing the rows regresses the ledger's own
 *    recorded high-water mark. It was measured on a single-commitment file;
 *  - the same text said "eliding a row breaks that identity in a way the
 *    elision cannot repair by itself". True of an elision, and beside the
 *    point: the cheapest forgery elides nothing.
 *
 * This file runs all three variants against a real file-backed database, so the
 * corrected sentences in `store/integrity.ts` and `operator/evidence.ts` are
 * pinned by what actually happens. It asserts the HOLE as well as the closure —
 * a residual nobody can execute is a residual nobody can price, and the wave
 * has now produced five findings where a disclosure was wrong.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import { elidedCommitmentLedgerRows } from '../src/store/integrity.js';

const LEDGER = 'hq_integrity_checkpoints';

interface TriggerRow {
  name: string;
  sql: string;
}

interface LedgerShape {
  rows: number;
  greatestRowid: number;
  highWaterMark: number;
}

/** Three genuine commitments on a real file: three boots, three checkpoints. */
function threeCommitments(): FileFixture {
  const fx = fileFixture();
  fx.reopen('w1');
  fx.reopen('w2');
  fx.reopen('w3');
  return fx;
}

function shape(raw: HqDatabase): LedgerShape {
  const counted = raw
    .prepare(`SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top FROM ${LEDGER}`)
    .get() as { rows: number; top: number };
  const mark = raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(LEDGER) as
    | { seq: number }
    | undefined;
  return { rows: counted.rows, greatestRowid: counted.top, highWaterMark: Number(mark?.seq ?? 0) };
}

/** Boot posture and a full Founder assessment, in a fresh process over the file. */
function posture(fx: FileFixture, processId: string) {
  const reopened = fx.reopen(processId);
  const boot = reopened.ops.hqReliabilityPosture().integrity;
  const assessed = reopened.ops.assessHqIntegrity({ requestedBy: 'founder' });
  return {
    bootSafeMode: boot.safeMode,
    bootFindings: boot.observations.filter((o) => o.blocking).map((o) => o.finding),
    assessSafeMode: assessed.ok ? assessed.data.safeMode : null,
    assessFindings: assessed.ok
      ? assessed.data.observations.filter((o) => o.blocking).map((o) => o.finding)
      : [],
  };
}

describe('the commitment-ledger row identity closes the DELETE-and-re-seat forgery', () => {
  it('an elision with no repair is blocking, and stays blocking', () => {
    const fx = threeCommitments();
    try {
      const raw = fx.raw();
      const triggers = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(LEDGER) as TriggerRow[];
      expect(triggers.length).toBe(3);
      for (const trigger of triggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
      raw.exec(`DELETE FROM ${LEDGER} WHERE seq = (SELECT MIN(seq) FROM ${LEDGER})`);
      for (const trigger of triggers) raw.exec(trigger.sql);
      const after = shape(raw);
      expect(after.rows).toBe(2);
      expect(after.highWaterMark).toBe(3);
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();

      const p2 = posture(fx, 'p2');
      expect(p2.bootSafeMode).toBe(true);
      expect(p2.assessSafeMode).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('the path the round-five residual named is CAUGHT once the file carries more than one commitment', () => {
    // Collapsing three commitments to one repairs the row identity and
    // regresses the ledger's own recorded high-water mark. The round-five text
    // measured this on a single-commitment file, where the collapse is
    // invisible, and reported it as silent for ever.
    const fx = threeCommitments();
    try {
      const raw = fx.raw();
      const triggers = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(LEDGER) as TriggerRow[];
      const rows = raw.prepare(`SELECT * FROM ${LEDGER} ORDER BY seq`).all() as Record<
        string,
        unknown
      >[];
      const newest = rows[rows.length - 1];
      for (const trigger of triggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
      raw.exec(`DELETE FROM ${LEDGER}`);
      raw
        .prepare(
          `INSERT INTO ${LEDGER} (seq, id, recorded_at, chain_length, tip_hash, ledger_marks, process_id, recorded_by)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'forged-1',
          newest.recorded_at,
          newest.chain_length,
          newest.tip_hash,
          newest.ledger_marks,
          newest.process_id,
          newest.recorded_by,
        );
      raw.prepare(`UPDATE sqlite_sequence SET seq = 1 WHERE name = ?`).run(LEDGER);
      for (const trigger of triggers) raw.exec(trigger.sql);
      const after = shape(raw);
      // The row identity IS repaired by that path, in every reading that lives
      // inside the file...
      expect(after).toEqual({ rows: 1, greatestRowid: 1, highWaterMark: 1 });
      // ...and since round ten it is reported anyway, by the greatest rowid
      // this ledger has ever reached, which HQ keeps in the database header
      // where a `DELETE` and a `sqlite_sequence` write cannot reach it.
      expect(elidedCommitmentLedgerRows(raw)).toBe(true);
      raw.close();
      // It is caught by the recorded per-ledger high-water mark as well.
      const p2 = posture(fx, 'p2');
      expect(p2.bootSafeMode).toBe(true);
      expect(p2.assessSafeMode).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the residual, executed: a COUNT-PRESERVING in-place rewrite is silent, at the cheapest price found', () => {
  it('one trigger, one UPDATE, zero sqlite_sequence writes — and the whole forgery goes unreported for ever', () => {
    const fx = threeCommitments();
    try {
      const raw = fx.raw();

      // 1. Forge the evidence log itself, IN PLACE: rewrite the tail entry's
      //    kind and payload, then re-chain every hash. Nothing is deleted, so
      //    the log's own length and high-water mark are untouched.
      const evidenceTriggers = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'op_evidence'`)
        .all() as TriggerRow[];
      for (const trigger of evidenceTriggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
      const entries = raw.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all() as Record<
        string,
        unknown
      >[];
      expect(entries.length).toBeGreaterThan(0);
      const rewrite = raw.prepare(
        `UPDATE op_evidence SET kind = ?, payload = ?, prev_hash = ?, hash = ? WHERE seq = ?`,
      );
      const lastSeq = entries[entries.length - 1].seq as number;
      let previousHash = entries[0].prev_hash as string;
      for (const entry of entries) {
        const isTail = (entry.seq as number) === lastSeq;
        const kind = isTail ? 'forged_kind' : (entry.kind as string);
        const payload = isTail ? JSON.stringify({ forged: true }) : (entry.payload as string);
        const hash = createHash('sha256')
          .update(
            [
              previousHash,
              entry.id as string,
              entry.at as string,
              (entry.task_id as string | null) ?? '',
              entry.actor as string,
              kind,
              JSON.stringify(JSON.parse(payload)),
            ].join('|'),
          )
          .digest('hex');
        rewrite.run(kind, payload, previousHash, hash, entry.seq);
        previousHash = hash;
      }
      for (const trigger of evidenceTriggers) raw.exec(trigger.sql);

      // 2. Repair the commitments the same way: ONE trigger of three, ONE
      //    UPDATE, no DELETE, no INSERT, no explicit rowid, and — the half the
      //    round-five residual said was needed — no `sqlite_sequence` write.
      const ledgerTriggers = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(LEDGER) as TriggerRow[];
      const updateGuard = ledgerTriggers.find((t) => /BEFORE UPDATE/i.test(t.sql));
      expect(updateGuard).toBeDefined();
      const before = shape(raw);
      raw.exec(`DROP TRIGGER ${updateGuard!.name}`);
      raw.prepare(`UPDATE ${LEDGER} SET tip_hash = ? WHERE chain_length = ?`).run(
        previousHash,
        entries.length,
      );
      raw.exec(updateGuard!.sql);
      const after = shape(raw);

      // The identity this check rests on is preserved by construction.
      expect(after).toEqual(before);
      expect(after.rows).toBe(after.highWaterMark);
      expect(after.greatestRowid).toBe(after.highWaterMark);
      expect(elidedCommitmentLedgerRows(raw)).toBe(false);
      raw.close();

      // 3. Silent at the boot that follows, at a full Founder assessment, and
      //    at every process after that. This is the residual, and it is stated
      //    in `store/integrity.ts` and `operator/evidence.ts` at exactly this
      //    price.
      for (const processId of ['p2', 'p3', 'p4']) {
        const seen = posture(fx, processId);
        expect(seen.bootSafeMode, `${processId} boot`).toBe(false);
        expect(seen.bootFindings, `${processId} boot findings`).toEqual([]);
        expect(seen.assessSafeMode, `${processId} assessment`).toBe(false);
        expect(seen.assessFindings, `${processId} assessment findings`).toEqual([]);
      }
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * The sentences this file exists to keep honest. Pinned by TEXT as well as by
 * behaviour, because the defect was a false sentence beside correct code: the
 * runtime never changed, only what was written about it. A behavioural test
 * alone would have passed on the head that carried the wrong price.
 */
describe('the source sentences state the price this file actually executes', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const read = (relative: string) => fs.readFileSync(path.join(HERE, '..', relative), 'utf8');

  it('neither source module still prices the surviving repair as an explicit seq plus a sqlite_sequence write', () => {
    for (const relative of ['src/store/integrity.ts', 'src/operator/evidence.ts']) {
      const source = read(relative);
      expect(
        source.includes('The DURABLE one is two statements'),
        `${relative} still carries the retired round-five price`,
      ).toBe(false);
      expect(
        source.includes('the cost is one explicit rowid and one extra'),
        `${relative} still carries the retired round-five price`,
      ).toBe(false);
    }
  });

  it('both source modules state the count-preserving in-place rewrite, and that it needs no sqlite_sequence write', () => {
    for (const relative of ['src/store/integrity.ts', 'src/operator/evidence.ts']) {
      const source = read(relative);
      expect(source, relative).toContain('in place');
      expect(source, relative).toContain('BEFORE UPDATE');
      expect(source, relative).toContain('p2/p3/p4 boot=false assess=false release=ADMITTED');
    }
  });

  it('the elision sentence no longer implies the identity answers a rewrite that elides nothing', () => {
    const source = read('src/store/integrity.ts');
    expect(
      source.includes('in a way the elision cannot repair by itself'),
      'the sentence the round-seven review found false of the cheapest path is still shipped',
    ).toBe(false);
    expect(source).toContain('cheapest surviving forgery elides nothing');
  });
});
