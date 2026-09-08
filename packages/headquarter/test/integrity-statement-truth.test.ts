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
 *
 * ## Round ten, Low 1 — the same statement's COST clause
 *
 * The depth half of `INTEGRITY_DEPTH_STATEMENT` was pinned above; its cost
 * half was not, and it had drifted in the fail-safe direction the same way.
 * It said "one MAX(rowid) seek per declared ledger, and one COUNT(*) plus one
 * indexed lookup over HQ's own small commitment ledger", and all three terms
 * were wrong: the seeks are two per COMMITTED ledger, the third read is a full
 * SCAN with a `json_each` expansion and a temporary B-tree `GROUP BY` rather
 * than a lookup, and the ledger is not "small" in the sense of fixed — it
 * grows a row per clean boot and per clean assessment.
 *
 * So the cost clause is derived too, by the same rule: nothing below restates
 * the wording. The seek count comes from INSTRUMENTING `db.prepare` and
 * counting what one pass actually executes, the shape of the ledger read comes
 * from `EXPLAIN QUERY PLAN` over the statement the pass really ran, and the
 * growth comes from executing a clean assessment and a clean boot and counting
 * rows. Each is then compared to what the served sentence claims.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import { openHqDatabase, type HqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
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

/**
 * The one warm store every scenario below starts from, built once.
 *
 * `warmedFile()` has thirteen call sites in this file and EIGHT of them are
 * inside a single test, because each depth scenario has to damage its own
 * database — a truncated ledger and a broken evidence chain cannot share one
 * file. What those eight do NOT need is eight independent CONSTRUCTIONS of the
 * identical undamaged store, and that is what they were paying for.
 *
 * The cost is not CPU. `openHqDatabase` sets `synchronous = FULL` on purpose —
 * this file's own battery asserts `durability_below_requirement` when it is
 * anything less — so every commit in a build is an fsync. Measured with
 * `strace -f -c -e trace=fsync` at this head: 271 fsyncs for one warm build,
 * and 2184 for the eight-scenario test. That is the highest fsync count of any
 * test in the package, roughly eight times the ~250-275 the rest of the suite
 * sits at.
 *
 * On this machine an fsync costs ~0.135 ms and the test runs in ~1.1 s, so the
 * cost was invisible. A test's timeout is WALL time, though, and on slower
 * storage the same 2184 fsyncs dominate it: at 2 ms per fsync the test takes
 * 6.5 s and at 9 ms it takes 22 s, against vitest's 5000 ms default. That is
 * what failed in CI, on a test no commit in this wave had touched.
 *
 * So the undamaged store is built ONCE, verified once, and COPIED per call. A
 * cleanly closed HQ database is a single file with no WAL or shared-memory
 * residue (verified below), so each scenario receives a byte-for-byte copy of
 * the one store that was checked — strictly more deterministic than thirteen
 * separate builds, not less, and it re-derives nothing.
 */
let warmTemplate: { dir: string; dbPath: string } | null = null;

function warmTemplatePath(): string {
  if (warmTemplate) return warmTemplate.dbPath;
  const fx = fileFixture();
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
  const warm = openHqDatabase(fx.dbPath);
  new HeadquarterOperations(warm);
  const committed = (
    warm.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as { n: number }
  ).n;
  expect(committed).toBeGreaterThan(0);
  warm.close();

  // The property that makes copying equivalent to rebuilding, asserted rather
  // than assumed: after a clean close the store is ONE file. If a future change
  // leaves a `-wal` or `-shm` beside it, copying the main file alone would hand
  // out a store missing its most recent commits, and this fails instead.
  expect(fs.readdirSync(path.dirname(fx.dbPath))).toEqual([path.basename(fx.dbPath)]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-warm-template-'));
  const dbPath = path.join(dir, path.basename(fx.dbPath));
  fs.copyFileSync(fx.dbPath, dbPath);
  fx.cleanup();
  warmTemplate = { dir, dbPath };
  return dbPath;
}

// Built in a hook rather than lazily inside whichever test happens to ask
// first, so the one shared construction is charged to the shared setup and each
// test's own budget covers only its own work. Vitest gives a hook 10 s and a
// test 5 s, which is the right way round for a fixture every test reuses.
beforeAll(() => {
  warmTemplatePath();
});

afterAll(() => {
  if (warmTemplate) fs.rmSync(warmTemplate.dir, { recursive: true, force: true });
  warmTemplate = null;
});

/** A file-backed HQ store that has completed a warm boot, so a commitment exists. */
function warmedFile(): { dir: string; dbPath: string; cleanup: () => void } {
  const template = warmTemplatePath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-warmed-'));
  const dbPath = path.join(dir, path.basename(template));
  fs.copyFileSync(template, dbPath);
  return { dir, dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
        const pristine = fs.readFileSync(file.dbPath);
        // The page is chosen by OUTCOME, not by offset (Wave 5 correction round
        // seven, at the merge with the concurrent lane). This scenario used a
        // fixed `pageCount - 2`, which is a bet on the file's layout: the
        // concurrent lane added a column to the commitment ledger and a row
        // count per declared ledger, the layout moved under the bet, and the
        // scribble landed somewhere the durability pragma itself could not read
        // past — so the scenario failed with `database disk image is malformed`
        // thrown out of `readDurabilityPosture` instead of asserting anything.
        // What the scenario MEANS is "a genuinely malformed page that the
        // catalogue read and the pragmas survive", so it looks for one and fails
        // loudly if the file carries none.
        let outcome: DepthOutcome | null = null;
        for (let page = pageCount - 1; page >= 2 && outcome === null; page -= 1) {
          fs.writeFileSync(file.dbPath, pristine);
          const fd = fs.openSync(file.dbPath, 'r+');
          fs.writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, (page - 1) * pageSize);
          fs.closeSync(fd);
          const db = new Database(file.dbPath) as unknown as HqDatabase;
          try {
            const seen = bothDepths(db);
            if (
              seen.full.has('database_integrity_check_failed') &&
              !seen.structural.has('database_integrity_check_failed')
            ) {
              outcome = seen;
            }
          } catch {
            // A page the cheap pass cannot even open past is not the page this
            // scenario is about; try the next one.
          } finally {
            (db as unknown as Database.Database).close();
          }
        }
        expect(outcome, 'no page corruption produced a full-only integrity failure').not.toBeNull();
        if (outcome === null) throw new Error('unreachable');
        record(outcome);
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

/**
 * Run one structural pass with `db.prepare` instrumented, and return every SQL
 * statement it actually EXECUTED — not every statement it prepared, because a
 * prepared statement that is never stepped costs nothing.
 */
function statementsExecutedByOneStructuralPass(dbPath: string): { sql: string[]; close: () => void } {
  const db = openHqDatabase(dbPath);
  const executed: string[] = [];
  const handle = db as unknown as {
    prepare: (sql: string) => Record<string, unknown>;
  };
  const realPrepare = handle.prepare.bind(handle);
  handle.prepare = (sql: string) => {
    const statement = realPrepare(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();
    for (const method of ['all', 'get', 'run'] as const) {
      const real = statement[method] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof real !== 'function') continue;
      statement[method] = (...args: unknown[]) => {
        executed.push(normalized);
        return real.apply(statement, args);
      };
    }
    return statement;
  };
  const outcome = structuralIntegrity(db, {});
  // A pass that found something would be measuring a different code path.
  expect([...findingsOf(outcome.observations)]).toEqual([]);
  handle.prepare = realPrepare;
  return { sql: executed, close: () => db.close() };
}

describe('the cost clause of the depth statement is derived from what a pass executes', () => {
  /**
   * RE-DERIVED at the merge with the concurrent round-seven lane, and strictly
   * stronger than before.
   *
   * Round ten measured this clause at its own head and found "two MAX(rowid)
   * seeks per COMMITTED ledger, not one per DECLARED one". The concurrent lane
   * was closing High 2 in the same wave, and its fix reads every DECLARED
   * ledger's identity — a `COUNT(*)` and a `MAX(rowid)` together — because a
   * seek cannot see a row taken out of the middle of a ledger and a count can.
   * So BOTH shapes are in the pass now, and both are counted here rather than
   * one of them standing in for the other: the identity read is per declared
   * ledger, the standalone seek is per committed one, and neither number is
   * read off the sentence.
   */
  it('counts both reads: an identity per declared ledger, a seek per committed one', () => {
    const file = warmedFile();
    try {
      const pass = statementsExecutedByOneStructuralPass(file.dbPath);
      const identities = pass.sql.filter((sql) =>
        /^SELECT COUNT\(\*\) AS held, COALESCE\(MAX\(rowid\), 0\) AS top FROM /.test(sql),
      );
      const identityLedgers = new Set(
        identities.map((sql) => /FROM "?([A-Za-z_]+)"?/.exec(sql)![1]),
      );
      expect(identities.length).toBe(ENGINE_IMMUTABLE_TABLES.length);
      expect(identityLedgers.size).toBe(ENGINE_IMMUTABLE_TABLES.length);

      const seeks = pass.sql.filter((sql) => /^SELECT MAX\(rowid\) AS top FROM /.test(sql));
      const ledgersSeeked = new Set(seeks.map((sql) => /FROM "?([A-Za-z_]+)"?/.exec(sql)![1]));
      expect(seeks.length).toBeGreaterThan(0);
      // Still the retired claim's disproof: the standalone seek is NOT taken
      // over the whole declared census.
      expect(ledgersSeeked.size).toBeLessThan(ENGINE_IMMUTABLE_TABLES.length);
      expect(seeks.length).toBe(ledgersSeeked.size);

      // The retired PHRASING stays retired, by its exact shape, and the two
      // clauses that replaced it are the measured ones.
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/one MAX\(rowid\) seek per declared ledger/i);
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(
        /two MAX\(rowid\) seeks for each ledger HQ has committed a mark for/,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(
        /one COUNT\(\*\) and one MAX\(rowid\) over each declared ledger/,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(
        /one further MAX\(rowid\) seek for each ledger HQ has committed a mark for/,
      );
      pass.close();
    } finally {
      file.cleanup();
    }
  });

  it('reads the commitment ledger with a SCAN and a temporary B-tree, not one indexed lookup', () => {
    const file = warmedFile();
    try {
      const pass = statementsExecutedByOneStructuralPass(file.dbPath);
      const markRead = pass.sql.find(
        (sql) => sql.includes(HQ_INTEGRITY_CHECKPOINT_TABLE) && sql.includes('json_each'),
      );
      expect(markRead, 'the pass must read its committed marks out of the checkpoint ledger').toBeTruthy();
      pass.close();

      // The plan of the statement the pass REALLY ran, asked of the engine.
      const raw = new Database(file.dbPath);
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${markRead!}`).all() as { detail: string }[])
        .map((row) => row.detail)
        .join(' | ');
      raw.close();
      expect(plan).toMatch(/SCAN/);
      expect(plan).toMatch(/TEMP B-TREE/i);

      // So the sentence may not call that term a lookup, and must name what it
      // actually is. `json_each` and the temporary B-tree are the two parts a
      // reader would otherwise have to take on trust.
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/one COUNT\(\*\) plus one indexed lookup/);
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/full SCAN/);
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/json_each/);
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/temporary B-tree/i);
    } finally {
      file.cleanup();
    }
  });

  it('grows the ledger it scans, by a row per clean boot and per clean assessment', () => {
    const fx = fileFixture();
    try {
      const rows = (): number => {
        const raw = new Database(fx.dbPath);
        const count = (
          raw.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as { n: number }
        ).n;
        raw.close();
        return count;
      };
      const atStart = rows();
      // One CLEAN Founder assessment, through the facade that serves the
      // sentence being checked.
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      const afterAssessment = rows();
      fx.db.close();

      // One CLEAN boot, nothing else.
      const booted = openHqDatabase(fx.dbPath);
      new HeadquarterOperations(booted);
      const afterBoot = rows();
      booted.close();

      // Strictly increasing on clean activity — which is exactly why calling
      // the ledger "small" and the read "one indexed lookup" understated it.
      expect(afterAssessment).toBeGreaterThan(atStart);
      expect(afterBoot).toBeGreaterThan(afterAssessment);
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/grows a row per clean boot and per clean assessment/);
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/small commitment ledger/);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Round eleven, Medium 1 — the cost clause's TOTAL, which nothing pinned.
   *
   * The three tests above pin the SHAPES of the reads, and have since round
   * ten. The figures shipped beside them were asserted NOWHERE: the served
   * sentence and the module header both said "46 statements per pass and
   * 0.871 ms averaged over 50", and both added "Pinned in
   * `integrity-statement-truth.test.ts` rather than estimated" — in this file,
   * which contained neither number. The pass really executes 48. That is the
   * THIRD time in one wave this clause has been wrong in the same direction,
   * the third inside the sentence written to stop the recurrence, and it
   * happened while every test here passed.
   *
   * So the number is not simply replaced with a better one. A bare total cannot
   * stay right, because two of its three terms are CENSUSES: the identity reads
   * scale with the ledgers HQ DECLARES and the seeks with the ledgers HQ has
   * COMMITTED a mark for. Only the third term — the catalogue, pragma and
   * commitment-ledger reads — is fixed.
   *
   * The total is therefore fixture-dependent BY CONSTRUCTION, and this test
   * treats it that way. Each of the three terms is measured off one real pass
   * over the deterministic `warmedFile()` fixture, the total is required to be
   * their sum, and then every number the served sentence and the module header
   * state is PARSED BACK OUT of the prose and compared to the measurement.
   * Nothing below retypes a figure for the prose to agree with, which is the
   * same rule the rest of this file follows and the one the shipped constants
   * escaped.
   */
  it('ships a total that is its own three measured terms, and no duration at all', () => {
    const file = warmedFile();
    try {
      const pass = statementsExecutedByOneStructuralPass(file.dbPath);
      const identities = pass.sql.filter((sql) =>
        /^SELECT COUNT\(\*\) AS held, COALESCE\(MAX\(rowid\), 0\) AS top FROM /.test(sql),
      );
      const seeks = pass.sql.filter((sql) => /^SELECT MAX\(rowid\) AS top FROM /.test(sql));
      const fixedReads = pass.sql.length - identities.length - seeks.length;
      const total = pass.sql.length;
      pass.close();

      // The three terms, measured, and the total as their sum rather than as a
      // fourth independent claim.
      expect(identities.length).toBe(ENGINE_IMMUTABLE_TABLES.length);
      expect(seeks.length).toBe(4);
      expect(fixedReads).toBe(11);
      expect(total).toBe(identities.length + seeks.length + fixedReads);

      // ...and the served sentence's arithmetic IS that arithmetic.
      const declaredClaim = /Over the (\d+) ledgers this build declares/.exec(
        INTEGRITY_DEPTH_STATEMENT,
      );
      const committedClaim = /with marks committed for (\d+) of them/.exec(
        INTEGRITY_DEPTH_STATEMENT,
      );
      const fixedClaim = /and (\d+) catalogue, pragma and commitment-ledger reads/.exec(
        INTEGRITY_DEPTH_STATEMENT,
      );
      const totalClaim = /that is (\d+) statements/.exec(INTEGRITY_DEPTH_STATEMENT);
      for (const [term, match] of [
        ['declared ledgers', declaredClaim],
        ['committed marks', committedClaim],
        ['fixed reads', fixedClaim],
        ['total statements', totalClaim],
      ] as const) {
        expect(match, `the depth statement must state its ${term}`).toBeTruthy();
      }
      expect(Number(declaredClaim![1])).toBe(identities.length);
      expect(Number(committedClaim![1])).toBe(seeks.length);
      expect(Number(fixedClaim![1])).toBe(fixedReads);
      expect(Number(totalClaim![1])).toBe(total);

      // The module header states the same sum, spelled as a sum, and it is read
      // out of the source rather than trusted.
      const header = fs.readFileSync(INTEGRITY_SOURCE, 'utf8');
      const headerEnd = header.indexOf('*/');
      expect(headerEnd).toBeGreaterThan(0);
      const headerProse = header
        .slice(0, headerEnd)
        .split('\n')
        .map((line) => line.replace(/^\s*\/?\*+\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ');
      const headerSum = /that is (\d+) \+ (\d+) \+ (\d+) = (\d+) statements/.exec(headerProse);
      expect(headerSum, 'the module header must state the cost as a sum of its terms').toBeTruthy();
      expect(headerSum!.slice(1).map(Number)).toEqual([
        identities.length,
        seeks.length,
        fixedReads,
        total,
      ]);

      // The retired figures, by their exact shape, so a revert cannot bring
      // them back quietly — the same rule the retired PHRASINGS are held to
      // above.
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/46 statements/);
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/under a millisecond/i);

      // And NO duration of any kind is served. 0.871 ms shipped as though it
      // were a property of the code; re-running that measurement gives a
      // different answer on every machine it is run on, so there is nothing
      // here for a test to pin and the sentence claims nothing.
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/millisecond/i);
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/\bms\b/);
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?)\b/i);
    } finally {
      file.cleanup();
    }
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
