/**
 * Wave 5, correction round eight — the two statements the module makes ABOUT
 * ITSELF, checked against the module.
 *
 * ## Why this file exists
 *
 * Nothing here tests a new behaviour. Every claim these tests check was already
 * true of the code and false in the prose, which is the failure mode this wave
 * has now hit in six consecutive rounds: a correction lands, the sentence that
 * described the old behaviour is not re-read, and the stale sentence ships.
 * Two of them shipped from THIS module.
 *
 *  - `INTEGRITY_DEPTH_STATEMENT` is served to the Founder verbatim, as
 *    `depthStatement` on `hqReliabilityPosture`. It said a structural
 *    assessment "reads the schema catalogue and the durability pragmas ONLY".
 *    Four correction rounds had since given the cheap pass `MAX(rowid)` seeks
 *    over every declared ledger and two reads of HQ's own commitment ledger,
 *    and it reports `append_only_ledger_truncated` and `evidence_chain_broken`
 *    on its own (round eight, Medium 1).
 *  - The module header said a finding "is one of six names" and that "only
 *    three findings engage safe mode", while `HQ_INTEGRITY_FINDINGS` holds
 *    seven and `SAFE_MODE_BLOCKING_FINDINGS` holds four — in the same file,
 *    fifteen lines above the constants (round eight, Low 1).
 *
 * ## Why the assertions are derived rather than written down
 *
 * A test that restated the corrected wording would be the same artifact as the
 * wording: it would need a human to re-read it on the next change, which is
 * precisely what did not happen. So neither claim is spelled out here.
 *
 * The depth claim is derived by EXECUTION. Every member of the finding
 * vocabulary is induced against a real file-backed database, both depths are
 * run over each induced state, and the set of findings only the full pass
 * raised is compared to the set named in the shipped sentence. Moving a check
 * between depths, or adding a finding one depth cannot reach, fails here.
 *
 * The vocabulary claims are derived from the CONSTANTS. The header's two
 * numbers are parsed back out of the source text and compared to
 * `HQ_INTEGRITY_FINDINGS.length` and `SAFE_MODE_BLOCKING_FINDINGS.length`, and
 * every blocking finding must be named in the paragraph that enumerates them.
 * Adding an eighth finding, or a fifth blocking one, fails here until the
 * paragraph is updated.
 *
 * The battery is also required to be COMPLETE: every name in
 * `HQ_INTEGRITY_FINDINGS` must be induced by some scenario below. A finding
 * that no scenario reaches cannot be classified by depth, and silently
 * omitting it is how a partition like this rots.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import { openHqDatabase, type HqDatabase } from '../src/store/db.js';
import {
  HQ_INTEGRITY_CHECKPOINT_TABLE,
  HQ_INTEGRITY_FINDINGS,
  INTEGRITY_DEPTH_STATEMENT,
  SAFE_MODE_BLOCKING_FINDINGS,
  fullIntegrity,
  structuralIntegrity,
  type HqIntegrityFinding,
} from '../src/store/integrity.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';
import { HeadquarterOperations } from '../src/application/service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTEGRITY_SOURCE = path.join(HERE, '..', 'src', 'store', 'integrity.ts');

/** What both depths reported over one induced state. */
interface DepthOutcome {
  structural: Set<HqIntegrityFinding>;
  full: Set<HqIntegrityFinding>;
}

function findingsOf(observations: readonly { finding: HqIntegrityFinding }[]): Set<HqIntegrityFinding> {
  return new Set(observations.map((observation) => observation.finding));
}

/**
 * Run BOTH depths over the same handle with the same inputs, so the only
 * difference between the two answers is the depth itself.
 *
 * `structuralIntegrity` is given no recorded verdict: a carried latch would
 * add findings that say nothing about which depth can DETECT what, and this
 * derivation is about detection.
 */
function bothDepths(
  db: HqDatabase,
  options: { reliabilitySchemaPresent?: boolean } = {},
): DepthOutcome {
  const structural = structuralIntegrity(db, {
    reliabilitySchemaPresent: options.reliabilitySchemaPresent,
  });
  const full = fullIntegrity(db, {
    reliabilitySchemaPresent: options.reliabilitySchemaPresent,
    verifyEvidenceChain: () => verifyEvidenceChain(db),
  });
  expect(structural.depth).toBe('structural');
  expect(full.depth).toBe('full');
  return { structural: findingsOf(structural.observations), full: findingsOf(full.observations) };
}

/**
 * Drop a guard, do the damage, put the guard back — the shape every one of
 * these attacks actually takes, and the reason the schema-catalogue census
 * alone cannot see any of them.
 */
function withGuardLifted(dbPath: string, guard: string, damage: (raw: Database.Database) => void): void {
  const raw = new Database(dbPath);
  const sql = (
    raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(guard) as
      | { sql: string }
      | undefined
  )?.sql;
  expect(sql, guard).toBeTruthy();
  raw.exec(`DROP TRIGGER ${guard}`);
  damage(raw);
  raw.exec(sql!);
  // The catalogue is healthy again, which is the whole point: anything found
  // after this was NOT found by reading the schema.
  expect(
    raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(guard),
  ).toBeDefined();
  raw.close();
}

/** A file-backed HQ store that has completed a warm boot, so a commitment exists. */
function warmedFile(): { dir: string; dbPath: string; cleanup: () => void } {
  const fx = fileFixture();
  const dbPath = fx.dbPath;
  const dir = fx.dir;
  expectOk(
    fx.ops.startRunAttempt({
      runId: expectOk(
        fx.ops.openRun({
          taskId: fx.claim.taskId,
          workerId: fx.claim.workerId,
          fence: fx.claim.fence,
          runKind: 'external_action',
          label: 'work before the statement is checked',
        }),
      ).run.id,
      workerId: 'claude',
      fence: fx.claim.fence,
    }),
  );
  fx.db.close();
  const warm = openHqDatabase(dbPath);
  new HeadquarterOperations(warm);
  const committed = (
    warm.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as { n: number }
  ).n;
  expect(committed).toBeGreaterThan(0);
  warm.close();
  return { dir, dbPath, cleanup: () => fx.cleanup() };
}

describe('the depth statement served to the Founder is derived from what the two depths actually detect', () => {
  it('classifies every finding in the vocabulary by executing it at both depths', () => {
    const structuralRaised = new Set<HqIntegrityFinding>();
    const fullRaised = new Set<HqIntegrityFinding>();
    const record = (outcome: DepthOutcome): void => {
      for (const finding of outcome.structural) structuralRaised.add(finding);
      for (const finding of outcome.full) fullRaised.add(finding);
    };

    // 1. A healthy warm store finds nothing at either depth. Without this the
    //    rest of the battery could be measuring noise.
    {
      const file = warmedFile();
      try {
        const db = openHqDatabase(file.dbPath);
        const outcome = bothDepths(db);
        expect([...outcome.structural]).toEqual([]);
        expect([...outcome.full]).toEqual([]);
        db.close();
      } finally {
        file.cleanup();
      }
    }

    // 2. `append_only_guard_missing` — a guard the schema declares, absent from
    //    the file. The one finding a catalogue read really does answer.
    {
      const file = warmedFile();
      try {
        const raw = new Database(file.dbPath) as unknown as HqDatabase;
        (raw as unknown as Database.Database).exec('DROP TRIGGER trg_op_evidence_no_rewrite');
        const outcome = bothDepths(raw);
        expect(outcome.structural).toContain('append_only_guard_missing');
        record(outcome);
        (raw as unknown as Database.Database).close();
      } finally {
        file.cleanup();
      }
    }

    // 3. `append_only_ledger_truncated` — rows removed with the guard lifted and
    //    the guard put back. The catalogue is healthy; the engine's own
    //    high-water mark is not.
    {
      const file = warmedFile();
      try {
        withGuardLifted(file.dbPath, 'trg_hq_reliability_run_events_no_erase', (raw) => {
          raw.exec('DELETE FROM hq_reliability_run_events');
        });
        const db = openHqDatabase(file.dbPath);
        const outcome = bothDepths(db);
        expect(outcome.structural).toContain('append_only_ledger_truncated');
        record(outcome);
        db.close();
      } finally {
        file.cleanup();
      }
    }

    // 4. `evidence_chain_broken` at the CHEAP depth — the log no longer carries
    //    the entry HQ committed to, at the seq HQ committed it. This is the
    //    detection the shipped sentence denied the structural pass entirely.
    {
      const file = warmedFile();
      try {
        withGuardLifted(file.dbPath, 'trg_op_evidence_no_rewrite', (raw) => {
          const committed = raw
            .prepare(`SELECT MAX(chain_length) AS len FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`)
            .get() as { len: number };
          expect(committed.len).toBeGreaterThan(0);
          const changed = raw
            .prepare(`UPDATE op_evidence SET hash = ? WHERE seq = ?`)
            .run('0'.repeat(64), committed.len);
          expect(changed.changes).toBe(1);
        });
        const db = openHqDatabase(file.dbPath);
        const outcome = bothDepths(db);
        expect(outcome.structural).toContain('evidence_chain_broken');
        record(outcome);
        db.close();
      } finally {
        file.cleanup();
      }
    }

    // 5. `durability_below_requirement` — a pragma read, at both depths.
    {
      const file = warmedFile();
      try {
        const db = openHqDatabase(file.dbPath);
        db.pragma('synchronous = NORMAL');
        const outcome = bothDepths(db);
        expect(outcome.structural).toContain('durability_below_requirement');
        record(outcome);
        db.close();
      } finally {
        file.cleanup();
      }
    }

    // 6. `reliability_schema_absent` — an observation about the file's vintage,
    //    reported at both depths.
    {
      const file = warmedFile();
      try {
        const db = openHqDatabase(file.dbPath);
        const outcome = bothDepths(db, { reliabilitySchemaPresent: false });
        expect(outcome.structural).toContain('reliability_schema_absent');
        record(outcome);
        db.close();
      } finally {
        file.cleanup();
      }
    }

    // 7. `foreign_key_violations` — a dangling reference. The schema declares
    //    exactly one foreign key, and only `PRAGMA foreign_key_check` finds it.
    {
      const file = warmedFile();
      try {
        const raw = new Database(file.dbPath);
        raw.pragma('foreign_keys = OFF');
        // `op_tasks.capability_id` is the schema's one declared foreign key,
        // and `op_tasks` is not an engine-immutable ledger, so this needs no
        // guard lifted — it is a dangling reference and nothing else.
        const dangled = raw
          .prepare(`UPDATE op_tasks SET capability_id = 'no-such-capability'`)
          .run();
        expect(dangled.changes).toBeGreaterThan(0);
        raw.close();
        const db = openHqDatabase(file.dbPath);
        const outcome = bothDepths(db);
        expect(outcome.full).toContain('foreign_key_violations');
        expect(outcome.structural).not.toContain('foreign_key_violations');
        record(outcome);
        db.close();
      } finally {
        file.cleanup();
      }
    }

    // 8. `database_integrity_check_failed` — a genuinely malformed page, which
    //    only the engine's own O(database) check can see.
    {
      const file = warmedFile();
      try {
        const sizing = new Database(file.dbPath);
        const pageSize = sizing.pragma('page_size', { simple: true }) as number;
        const pageCount = sizing.pragma('page_count', { simple: true }) as number;
        sizing.close();
        expect(pageCount).toBeGreaterThan(4);
        const fd = fs.openSync(file.dbPath, 'r+');
        // An INTERIOR page, so the catalogue on page 1 stays readable and the
        // structural pass genuinely runs rather than failing to open.
        fs.writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, (pageCount - 2) * pageSize);
        fs.closeSync(fd);
        const db = new Database(file.dbPath) as unknown as HqDatabase;
        const outcome = bothDepths(db);
        expect(outcome.full).toContain('database_integrity_check_failed');
        expect(outcome.structural).not.toContain('database_integrity_check_failed');
        record(outcome);
        (db as unknown as Database.Database).close();
      } finally {
        file.cleanup();
      }
    }

    // The battery must reach the WHOLE vocabulary. A finding no scenario
    // induces cannot be classified by depth, and quietly leaving one out is how
    // a partition like this stops being true.
    const reached = new Set<HqIntegrityFinding>([...structuralRaised, ...fullRaised]);
    expect([...reached].sort()).toEqual([...HQ_INTEGRITY_FINDINGS].sort());

    // The derived answer, and the shipped sentence's own list of it.
    const fullExclusive = [...fullRaised].filter((finding) => !structuralRaised.has(finding)).sort();
    const claimed = /Findings only a full assessment can raise: ([^.]+)\./.exec(
      INTEGRITY_DEPTH_STATEMENT,
    );
    expect(claimed, 'the depth statement must state which findings only a full assessment raises').toBeTruthy();
    expect(
      claimed![1]
        .split(',')
        .map((name) => name.trim())
        .sort(),
    ).toEqual(fullExclusive);
  });

  it('no longer claims the structural pass reads the catalogue and the pragmas ONLY', () => {
    // The retired falsehood, pinned by its exact shape so it cannot come back
    // by a revert. Scenario 4 above is the execution that disproves it.
    expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/durability pragmas only/i);
    // And the mechanisms the cheap pass really uses are named, because "it also
    // finds more" without saying what it reads is the same under-statement in
    // the other direction.
    expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/MAX\(rowid\)/);
    expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/commitment/i);
  });
});

describe('the module header’s counts are the constants’ counts', () => {
  /** The header docblock, unwrapped into one line of prose. */
  function headerProse(): string {
    const source = fs.readFileSync(INTEGRITY_SOURCE, 'utf8');
    const end = source.indexOf('*/');
    expect(end).toBeGreaterThan(0);
    return source
      .slice(0, end)
      .split('\n')
      .map((line) => line.replace(/^\s*\/?\*+\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
  }

  const NUMBER_WORDS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  it('says how many finding names there are, and is right', () => {
    const match = /is one of (\w+) names/.exec(headerProse());
    expect(match, 'the header must state the size of the closed vocabulary').toBeTruthy();
    expect(NUMBER_WORDS[match![1]]).toBe(HQ_INTEGRITY_FINDINGS.length);
  });

  it('says how many findings block, is right, and names every one of them', () => {
    const prose = headerProse();
    const match = /Only (\w+) findings engage safe mode/.exec(prose);
    expect(match, 'the header must state how many findings engage safe mode').toBeTruthy();
    expect(NUMBER_WORDS[match![1]]).toBe(SAFE_MODE_BLOCKING_FINDINGS.length);

    // Naming them is what makes the count checkable by a reader as well as by
    // this test: the count was right about a list nobody could see, twice.
    for (const finding of SAFE_MODE_BLOCKING_FINDINGS) {
      expect(prose, `the header must name the blocking finding ${finding}`).toContain(finding);
    }
    // And a finding that does NOT block may not appear in that enumeration,
    // which is the failure the count alone would not catch.
    const enumeration = /Only \w+ findings engage safe mode:(.+?)Each means/.exec(prose);
    expect(enumeration).toBeTruthy();
    for (const finding of HQ_INTEGRITY_FINDINGS) {
      if (SAFE_MODE_BLOCKING_FINDINGS.includes(finding)) continue;
      expect(enumeration![1], `${finding} does not block and may not be enumerated as blocking`).not.toContain(
        finding,
      );
    }
  });
});
