/**
 * Wave 5, correction round five — the durable integrity checkpoint.
 *
 * Three findings from the fresh hostile review of `83e563e`, each pinned here
 * by the exploit that made it:
 *
 *  - **HIGH 1 — the evidence chain could be re-written WHOLE.** The three
 *    checks the log carried (engine guards, census membership, links +
 *    contiguity + `sqlite_sequence` high-water) are all read out of the log
 *    itself, so a writer that drops the table, re-creates it from its own
 *    schema and inserts a shortened, coherently rehashed replacement satisfies
 *    every one of them. No `UPDATE` is executed, no `sqlite_sequence` is
 *    written (SQLite rebuilds it from the explicit rowids), and the guards are
 *    back before HQ next constructs — so the boot AND the Founder's full
 *    assessment both read CLEAN over a log two committed entries short. The
 *    shipped residual said that attack needed the UPDATE the engine refuses and
 *    left a blocking trace; it needed neither.
 *  - **MEDIUM 1 — one Founder assessment certified a gutted store.** The
 *    boot-time as-found census reported 31 dropped ledgers and engaged safe
 *    mode; the full assessment asked about "the file as it now stands", found
 *    the ledgers HQ had itself re-created EMPTY, and recorded `safeMode: false`
 *    with an empty findings list — then handed `releaseKillSwitch` back.
 *  - **LOW 1 — `PRAGMA user_version` was read as "any non-zero value"**, so a
 *    file some other application had stamped booted HQ straight into safe mode
 *    on first contact.
 *  - **LOW 2 — `assessHqIntegrity` threw a raw `SqliteError`** on a read-only
 *    handle instead of returning a refusal.
 *
 * Every attack below is executed against a real FILE through a RAW
 * `better-sqlite3` connection that never ran HQ's code, because all four claims
 * are claims about what a foreign writer can do to the file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { openHqDatabase, openHqDatabaseReadOnly, type HqDatabase } from '../src/store/db.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  contradictedChainCommitment,
  hqSchemaEnsuredMarkPresent,
  immutableLedgerMarks,
  regressedImmutableLedgers,
} from '../src/store/integrity.js';

/** The chain's zero value, spelled here only to BUILD the forgery. */
const GENESIS = 'genesis';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

/**
 * The whole-log forgery, exactly as the review executed it: no `UPDATE`
 * anywhere, no write to `sqlite_sequence`, and the guards put back afterwards.
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
      .update(
        [prev, row.id, row.at, row.task_id ?? '', row.actor, row.kind, payload].join('|'),
      )
      .digest('hex');
    insert.run(index + 1, row.id, row.at, row.task_id, row.actor, row.kind, payload, prev, hash);
    prev = hash;
  });
  for (const sql of triggerSql) raw.exec(sql);
  return { before: rows.length, after: keep.length };
}

/** Give the file a history worth committing to: three Founder assessments. */
function warm(fx: FileFixture, times = 3): void {
  for (let i = 0; i < times; i += 1) {
    const assessed = fx.ops.assessHqIntegrity({ requestedBy: 'founder' });
    expect(assessed.ok, 'the fixture must be able to assess itself').toBe(true);
  }
}

describe('the evidence log commits to a witness that does not live inside it', () => {
  it('refuses a whole-log forgery that executes no UPDATE and leaves the guards standing', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const shape = forgeShortenedLog(raw, 2);
      expect(shape.after).toBe(shape.before - 2);
      // The forgery really is internally coherent — this is what made the
      // previous head read clean, and it is asserted rather than assumed.
      const seqs = (raw.prepare(`SELECT seq FROM op_evidence ORDER BY seq`).all() as { seq: number }[]).map(
        (row) => row.seq,
      );
      expect(seqs).toEqual(Array.from({ length: shape.after }, (_, i) => i + 1));
      expect(
        (raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'op_evidence'`).get() as { seq: number })
          .seq,
        'SQLite rebuilds the high-water mark from the explicit rowids, so no write to it was needed',
      ).toBe(shape.after);
      expect(
        (
          raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='op_evidence'`).get() as {
            n: number;
          }
        ).n,
        'the guards are back, so the as-found census has nothing to report',
        // FOUR since Wave 5 correction round thirteen (High 1): the universal
        // rowid guard joined the trio on every declared ledger, and this
        // forgery replays the triggers it captured, so it replays four.
      ).toBe(4);
      // And the durable commitment catches it anyway. The answer is the FIRST
      // committed length the shortened log no longer reaches — the same shape
      // of answer every other chain check gives, "the log stops being true
      // here" — and the walk returns it unchanged.
      expect(contradictedChainCommitment(raw)).toBe(shape.after + 1);
      expect(verifyEvidenceChain(raw)).toBe(shape.after + 1);
      raw.close();

      const reopened = fx.reopen('after-forgery');
      const posture = reopened.ops.hqReliabilityPosture().integrity;
      expect(posture.safeMode).toBe(true);
      expect(findings(posture.observations)).toContain('evidence_chain_broken');
      const assessed = reopened.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(true);
      expect(findings(assessed.data.observations)).toContain('evidence_chain_broken');
      // The act safe mode exists to refuse is refused.
      expect(reopened.ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      reopened.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a tail SUBSTITUTION that keeps the length, the seqs and the high-water mark', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      const rows = raw.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all() as Record<string, unknown>[];
      const triggerSql = (
        raw.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='op_evidence'`).all() as {
          sql: string;
        }[]
      ).map((row) => row.sql);
      for (const name of (
        raw.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='op_evidence'`).all() as {
          name: string;
        }[]
      ).map((row) => row.name)) {
        raw.exec(`DROP TRIGGER ${name}`);
      }
      // DELETE the last two, then INSERT replacements at the SAME seqs. No
      // UPDATE, no renumbering, no change of length.
      const last = rows[rows.length - 1];
      const secondLast = rows[rows.length - 2];
      raw.exec(`DELETE FROM op_evidence WHERE seq >= ${secondLast.seq as number}`);
      let prev = String(rows[rows.length - 3].hash);
      const insert = raw.prepare(
        `INSERT INTO op_evidence (seq, id, at, task_id, actor, kind, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const original of [secondLast, last]) {
        const payload = JSON.stringify({ substituted: true });
        const hash = createHash('sha256')
          .update([prev, original.id, original.at, '', original.actor, original.kind, payload].join('|'))
          .digest('hex');
        insert.run(
          original.seq as number,
          original.id,
          original.at,
          null,
          original.actor,
          original.kind,
          payload,
          prev,
          hash,
        );
        prev = hash;
      }
      for (const sql of triggerSql) raw.exec(sql);
      expect(
        (raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }).n,
        'the substitution keeps the length exactly',
      ).toBe(rows.length);
      expect(verifyEvidenceChain(raw)).not.toBeNull();
      raw.close();

      const reopened = fx.reopen('after-substitution');
      expect(reopened.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const assessed = reopened.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok && assessed.data.safeMode).toBe(true);
      expect(assessed.ok && findings(assessed.data.observations)).toContain('evidence_chain_broken');
      reopened.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('cannot be talked out of a contradiction by APPENDING a checkpoint that matches the forgery', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      forgeShortenedLog(raw, 2);
      // The append the trio deliberately permits: a fresh commitment that
      // agrees with the forged log. Every commitment ever recorded is checked
      // and the per-ledger comparison takes the maximum, so this adds a
      // satisfied row and removes nothing.
      const tip = raw.prepare(`SELECT seq, hash FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as {
        seq: number;
        hash: string;
      };
      // The row is composed the way HQ composes one — `chain_length` beside the
      // `op_evidence` mark it IS, and the row count beside it — because
      // `trg_hq_integrity_checkpoints_no_overclaim` refuses a commitment that
      // over-claims either (Wave 5 correction round seven, High 3), and a row
      // that omitted the marks would model a WEAKER attacker than this test is
      // about: it would be refused for its shape rather than defeated on the
      // merits. The point stands where it always did — a fresh commitment that
      // AGREES with the forged log adds a satisfied row and removes none.
      const held = (
        raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }
      ).n;
      raw
        .prepare(
          `INSERT INTO hq_integrity_checkpoints
             (id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'forged-checkpoint',
          new Date().toISOString(),
          tip.seq,
          tip.hash,
          JSON.stringify({ op_evidence: tip.seq }),
          JSON.stringify({ op_evidence: held }),
          'attacker',
          'attacker',
        );
      expect(contradictedChainCommitment(raw)).not.toBeNull();
      raw.close();

      const reopened = fx.reopen('after-forged-checkpoint');
      expect(reopened.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const assessed = reopened.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok && assessed.data.safeMode).toBe(true);
      reopened.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('has no false positive: ordinary boots, appends and assessments keep every commitment satisfied', () => {
    const fx = fileFixture();
    try {
      warm(fx, 2);
      for (const process of ['p2', 'p3', 'p4']) {
        const reopened = fx.reopen(process);
        const posture = reopened.ops.hqReliabilityPosture().integrity;
        expect(posture.safeMode, `${process} boot`).toBe(false);
        expect(findings(posture.observations), `${process} boot`).toEqual([]);
        const assessed = reopened.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok && assessed.data.safeMode, `${process} assessment`).toBe(false);
        reopened.db.close();
      }
      const raw = fx.raw();
      expect(contradictedChainCommitment(raw)).toBeNull();
      expect(verifyEvidenceChain(raw)).toBeNull();
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      // The commitments really were recorded — a check that never has anything
      // to measure against would pass this test vacuously.
      expect(
        (raw.prepare(`SELECT COUNT(*) AS n FROM hq_integrity_checkpoints`).get() as { n: number }).n,
      ).toBeGreaterThan(0);
      expect(immutableLedgerMarks(raw).op_evidence).toBeGreaterThan(0);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });

  it('survives VACUUM, which carries sqlite_sequence and the commitments across', () => {
    const fx = fileFixture();
    try {
      warm(fx, 2);
      fx.db.close();
      const raw = fx.raw();
      raw.exec('VACUUM');
      expect(contradictedChainCommitment(raw)).toBeNull();
      expect(regressedImmutableLedgers(raw)).toEqual([]);
      raw.close();
      const reopened = fx.reopen('after-vacuum');
      expect(reopened.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      const assessed = reopened.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok && assessed.data.safeMode).toBe(false);
      reopened.db.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('a full assessment does not certify a store whose ledgers were destroyed', () => {
  it('keeps safe mode engaged through the Founder assessment that used to clear it', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      fx.db.close();
      const raw = new Database(dbPath);
      raw.exec('PRAGMA foreign_keys = OFF');
      const present = new Set(
        (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      let dropped = 0;
      for (const entry of ENGINE_IMMUTABLE_TABLES) {
        if (!present.has(entry.table)) continue;
        raw.exec(`DROP TABLE ${entry.table}`);
        dropped += 1;
      }
      expect(dropped).toBe(ENGINE_IMMUTABLE_TABLES.length);
      raw.close();

      const reopened = openHqDatabase(dbPath);
      const ops = new HeadquarterOperations(reopened);
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      expect(ops.releaseKillSwitch('global', 'founder').ok).toBe(false);

      // THE FINDING: this call used to return `safeMode: false` with an EMPTY
      // findings list and hand `releaseKillSwitch` straight back.
      const assessed = ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(true);
      expect(findings(assessed.data.observations)).toContain('append_only_guard_missing');
      const named = assessed.data.observations.find((o) => o.finding === 'append_only_guard_missing');
      expect(named!.detail).toContain('hq_reliability_verdicts');
      expect(ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      reopened.close();
    } finally {
      fx.cleanup();
    }
  });

  it('keeps it engaged across restarts too, where a checkpoint preceded the destruction', () => {
    const fx = fileFixture();
    try {
      // The local-first cadence: a second command over the file, which commits
      // what the first one wrote.
      const warmBoot = fx.reopen('warm');
      warmBoot.db.close();
      fx.db.close();

      const raw = fx.raw();
      raw.exec('PRAGMA foreign_keys = OFF');
      const present = new Set(
        (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      for (const entry of ENGINE_IMMUTABLE_TABLES) {
        // Everything but the checkpoint ledger, which is the case the durable
        // half is FOR. Dropping that one too is the disclosed residual and is
        // not what this test claims.
        if (entry.table === 'hq_integrity_checkpoints') continue;
        if (present.has(entry.table)) raw.exec(`DROP TABLE ${entry.table}`);
      }
      raw.close();

      // Three separate processes, each asked for a full Founder assessment.
      for (const process of ['p2', 'p3', 'p4']) {
        const reopened = fx.reopen(process);
        expect(reopened.ops.hqReliabilityPosture().integrity.safeMode, `${process} boot`).toBe(true);
        const assessed = reopened.ops.assessHqIntegrity({ requestedBy: 'founder' });
        expect(assessed.ok && assessed.data.safeMode, `${process} assessment`).toBe(true);
        expect(reopened.ops.releaseKillSwitch('global', 'founder').ok, `${process} release`).toBe(false);
        reopened.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });
});

describe('the schema-ensured mark is HQ’s own value, not any non-zero one', () => {
  it('does not read another application’s user_version as evidence that HQ has been here', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-foreign-mark-'));
    try {
      const foreignPath = path.join(dir, 'foreign.sqlite');
      const seed = new Database(foreignPath);
      seed.exec('PRAGMA user_version = 7');
      seed.close();
      expect(
        hqSchemaEnsuredMarkPresent(new Database(foreignPath) as unknown as HqDatabase),
      ).toBe(false);

      // THE FINDING: this file booted `safeMode: true
      // ["append_only_guard_missing"]` — every declared ledger reported absent
      // from a database nothing had tampered with.
      const db = openHqDatabase(foreignPath);
      const ops = new HeadquarterOperations(db);
      const posture = ops.hqReliabilityPosture().integrity;
      expect(posture.safeMode).toBe(false);
      expect(findings(posture.observations)).toEqual([]);
      // And HQ has now stamped its OWN mark, so the next boot is established.
      expect(hqSchemaEnsuredMarkPresent(db)).toBe(true);
      db.close();

      const control = openHqDatabase(path.join(dir, 'control.sqlite'));
      expect(new HeadquarterOperations(control).hqReliabilityPosture().integrity.safeMode).toBe(false);
      control.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still reads a file HQ HAS ensured as established, so the drop census keeps working', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      expect(hqSchemaEnsuredMarkPresent(raw)).toBe(true);
      raw.exec('DROP TABLE hq_intel_budgets');
      raw.close();
      const reopened = fx.reopen('after-drop');
      const posture = reopened.ops.hqReliabilityPosture().integrity;
      expect(posture.safeMode).toBe(true);
      expect(findings(posture.observations)).toContain('append_only_guard_missing');
      reopened.db.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('a read-only handle is refused, not thrown at', () => {
  it('returns an OpsResult refusal from assessHqIntegrity instead of an engine exception', () => {
    const fx = fileFixture();
    try {
      fx.db.close();
      const readOnly = openHqDatabaseReadOnly(fx.dbPath);
      const ops = new HeadquarterOperations(readOnly);
      // Booting read-only is fine and is not what this test is about.
      expect(typeof ops.hqReliabilityPosture().integrity.safeMode).toBe('boolean');
      // THE FINDING: this call threw `SqliteError: attempt to write a readonly
      // database` straight out of the facade.
      const assessed = ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(false);
      if (assessed.ok) throw new Error('a read-only assessment was admitted');
      expect(assessed.error.code).toBe('invalid_input');
      expect(assessed.error.message).toContain('read-only handle');
      readOnly.close();
    } finally {
      fx.cleanup();
    }
  });
});
