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
  STRUCTURAL_STATEMENT_BASE,
  fullIntegrity,
  structuralIntegrity,
  type HqIntegrityFinding,
} from '../src/store/integrity.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';
import { HeadquarterOperations } from '../src/application/service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTEGRITY_SOURCE = path.join(HERE, '..', 'src', 'store', 'integrity.ts');

/** A block comment's prose on one line, so a regex can read a figure out of it. */
function commentProse(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(/^\s*\/?\*+\/?\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * The docblock immediately above a declaration in `integrity.ts`, as prose.
 *
 * Numbers stated in a docblock are exactly as unasserted as numbers stated in a
 * served string, and this wave's cost clause drifted three times through the
 * former. Reading it back out of the source is what lets a test compare it to a
 * measurement.
 */
function docblockBefore(declaration: string): string {
  const source = fs.readFileSync(INTEGRITY_SOURCE, 'utf8');
  const at = source.indexOf(declaration);
  expect(at, `\`${declaration}\` must exist in integrity.ts`).toBeGreaterThan(0);
  const before = source.slice(0, at);
  const opened = before.lastIndexOf('/**');
  expect(opened, `\`${declaration}\` must carry a docblock`).toBeGreaterThan(0);
  return commentProse(before.slice(opened));
}

/** `integrity.ts`'s module header, as prose, for the same reason. */
function moduleHeaderProse(): string {
  const source = fs.readFileSync(INTEGRITY_SOURCE, 'utf8');
  const headerEnd = source.indexOf('*/');
  expect(headerEnd).toBeGreaterThan(0);
  return commentProse(source.slice(0, headerEnd));
}

/** The module header's worked cost examples: `[base, seeks, total]` for each file. */
const HEADER_WORKED_COSTS =
  /on the warmed fixture (\d+) \+ (\d+) = (\d+) statements, and on a file HQ has merely booted twice (\d+) \+ (\d+) = (\d+) statements/;

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

/**
 * The explicit deadline every file-backed battery below carries.
 *
 * These build real, file-backed HQ stores, warm them through a boot, damage
 * them in situ and re-execute a whole assessment over the result; the first one
 * induces every finding in the vocabulary and runs BOTH depths over each. On a
 * shared `ubuntu-latest` runner that first battery failed with
 * `Test timed out in 5000ms` while passing on every other head and on every
 * developer machine. Nothing about what the batteries cover is being reduced.
 *
 * Measured on this machine with the whole package running in parallel:
 * 141-1225 ms per test, the slowest being the both-depths classification
 * battery at 1225 ms (1219 ms with the file run alone). 60 s is ~49x that
 * slowest observed run, and the cost-clause tests that share `warmedFile()`
 * carry the same deadline because they do the same real-file work.
 *
 * Per test rather than a package-wide `testTimeout`: raising the global default
 * would relax the deadline for every test in this package, including the
 * many where a hang is the real signal. Only the harness deadline changes here;
 * every assertion is untouched.
 */
const FILE_BACKED_BATTERY_TIMEOUT_MS = 60_000;

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
  }, FILE_BACKED_BATTERY_TIMEOUT_MS);

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
 * Run one structural pass with every route to the engine instrumented, and
 * return every SQL statement it actually EXECUTED — not every statement it
 * prepared, because a prepared statement that is never stepped costs nothing.
 *
 * ## Round thirteen, Medium 1 — the instrument was BLIND to a term the
 * sentence it checks names explicitly
 *
 * This wrapped `db.prepare` only, so it could not see a statement that never
 * goes through a prepared handle. `readDurabilityPosture` runs four of them —
 * `journal_mode`, `synchronous`, `foreign_keys` and `wal_autocheckpoint` —
 * through better-sqlite3's `db.pragma()`, which compiles and steps its own
 * statement internally. The depth statement names "the durability pragmas" in
 * its very first clause and prices the fixed term at "11 catalogue, pragma and
 * commitment-ledger reads", and those four were in neither the 11 nor the total:
 * the real fixed term is 15 and the base is 48, the FOURTH undercount this
 * clause has shipped and the fourth in the same direction.
 *
 * The parse-back rule that catches the other three could not catch this one,
 * because the rule compares the prose to a MEASUREMENT and the measurement
 * itself was missing the term. So the instrument is fixed first and the number
 * second: `db.exec` is wrapped too (it executes SQL without a prepared handle
 * at all — measured at 0 in a structural pass, which is a fact worth pinning
 * rather than assuming), and `db.pragma` is wrapped and recorded as the
 * `PRAGMA <name>` it runs. A future check that reaches the engine by any of the
 * three routes is counted.
 */
function statementsExecutedByOneStructuralPass(dbPath: string): {
  sql: string[];
  pragmas: string[];
  execs: string[];
  close: () => void;
} {
  const db = openHqDatabase(dbPath);
  const executed: string[] = [];
  const pragmas: string[] = [];
  const execs: string[] = [];
  const handle = db as unknown as {
    prepare: (sql: string) => Record<string, unknown>;
    exec: (sql: string) => unknown;
    pragma: (source: string, options?: unknown) => unknown;
  };
  const realPrepare = handle.prepare.bind(handle);
  const realExec = handle.exec.bind(handle);
  const realPragma = handle.pragma.bind(handle);
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
  handle.exec = (sql: string) => {
    execs.push(sql.replace(/\s+/g, ' ').trim());
    return realExec(sql);
  };
  handle.pragma = (source: string, options?: unknown) => {
    pragmas.push(String(source).replace(/\s+/g, ' ').trim());
    return realPragma(source, options);
  };
  const outcome = structuralIntegrity(db, {});
  // A pass that found something would be measuring a different code path.
  expect([...findingsOf(outcome.observations)]).toEqual([]);
  handle.prepare = realPrepare;
  handle.exec = realExec;
  handle.pragma = realPragma;
  return {
    // Every route to the engine, in one list, because the sentence being checked
    // prices STATEMENTS and does not care which API carried them.
    sql: [...executed, ...pragmas.map((name) => `PRAGMA ${name}`), ...execs],
    pragmas,
    execs,
    close: () => db.close(),
  };
}

describe('the cost clause of the depth statement is derived from what a pass executes', () => {
  /**
   * RE-DERIVED a third time (round twelve, Medium 1), and this time against the
   * sets themselves rather than against their sizes.
   *
   * Round ten measured "two MAX(rowid) seeks per COMMITTED ledger"; the merge
   * with the concurrent round-seven lane made the identity read per DECLARED
   * ledger; and this test's own title claimed the standalone seek was "per
   * committed one" while its assertions only ever compared `seeks.length` to
   * `ledgersSeeked.size` and bounded that size below 33 — neither of which can
   * tell the committed set from any other. It is not per committed ledger:
   * `truncatedImmutableLedgers` takes it while walking `sqlite_sequence`, so on
   * the fixture's own warmed file it seeks four ledgers where HQ has committed
   * marks for three, and it would seek a ledger HQ has committed nothing about.
   * So the seeked set is compared to the `sqlite_sequence` set it really comes
   * from, and shown DIFFERENT from the committed set, which is the comparison
   * whose absence let the sentence ship wrong.
   */
  it('reads an identity per declared ledger, and seeks the sqlite_sequence set, not the committed set', () => {
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
      pass.close();

      // The two candidate sets, read off the file the pass just ran over.
      const declared = new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table));
      const raw = new Database(file.dbPath, { readonly: true });
      const sequenced = new Set(
        (raw.prepare(`SELECT name, seq FROM sqlite_sequence`).all() as { name: string; seq: number }[])
          .filter((row) => declared.has(row.name) && row.seq > 0)
          .map((row) => row.name),
      );
      const committed = new Set<string>();
      for (const row of raw
        .prepare(`SELECT ledger_marks FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`)
        .all() as { ledger_marks: string }[]) {
        for (const name of Object.keys(JSON.parse(row.ledger_marks) as Record<string, unknown>)) {
          if (declared.has(name)) committed.add(name);
        }
      }
      raw.close();

      const sorted = (values: Set<string>): string[] => [...values].sort();
      // The set it IS.
      expect(sorted(ledgersSeeked)).toEqual(sorted(sequenced));
      // The set the sentence used to name, shown to be a different one on this
      // very file — so an assertion that only counted would have passed.
      expect(committed.size).toBeGreaterThan(0);
      expect(sorted(ledgersSeeked)).not.toEqual(sorted(committed));

      // The retired PHRASING stays retired, by its exact shape, and the clauses
      // that replaced it are the measured ones.
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/one MAX\(rowid\) seek per declared ledger/i);
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(
        /two MAX\(rowid\) seeks for each ledger HQ has committed a mark for/,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(
        /one COUNT\(\*\) and one MAX\(rowid\) over each declared ledger/,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(
        /one further MAX\(rowid\) seek for each declared ledger the engine carries a positive sqlite_sequence\s+row for/,
      );
      // And the wrong set may not come back as the sentence's own claim.
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(
        /one further MAX\(rowid\) seek for each ledger HQ has committed a mark for/,
      );
    } finally {
      file.cleanup();
    }
  }, FILE_BACKED_BATTERY_TIMEOUT_MS);

  /**
   * The statement TOTAL, as a rule rather than as one file's number.
   *
   * "46 statements per pass" shipped to the Founder verbatim and was wrong on
   * both files measured at the head that shipped it — the third wrong number
   * this clause has carried, always understating, and every one of them possible
   * because no test ever compared a count to anything. A pass costs
   * `STRUCTURAL_STATEMENT_BASE` plus one standalone seek per declared ledger
   * with a positive `sqlite_sequence` row, and that second term moves with the
   * store's history, so the total cannot be a constant. Executed on TWO files
   * whose seek terms differ, because a rule asserted on one file is a number.
   *
   * The concurrent lane's rule is applied to this lane's own prose as well
   * (round eleven, Medium 1, merged): the worked figures in
   * `STRUCTURAL_STATEMENT_BASE`'s docblock — 2 seeks and 50 statements on a file
   * HQ has merely booted twice, 4 and 52 on the warmed one, and 15 statements
   * with zero identity reads before the first commitment — are PARSED BACK OUT
   * of the source and compared to these measurements. Writing a rule instead of
   * a total does not exempt the numbers that illustrate it; leaving illustrative
   * figures unasserted is how the first three drifted.
   *
   * **This paragraph itself carried the fourth wrong set** (Wave 5 correction
   * round fourteen, Low 2). It went on saying 46/48/11 after the base moved to
   * 48 and the fixed term to 15, and nothing caught it because the ASSERTIONS
   * below parse the figures out of `integrity.ts` — they never read this
   * comment. The figures here are now the ones the source states and the
   * measurement produces; a comment is not self-checking, so this one is
   * written to be checkable by eye against the constant it quotes.
   */
  it('costs a fixed base plus one statement per seek, on two files with different seek counts', () => {
    const declared = new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table));
    const measure = (dbPath: string): { total: number; seeks: number; identities: number } => {
      const pass = statementsExecutedByOneStructuralPass(dbPath);
      const total = pass.sql.length;
      const seeks = pass.sql.filter((sql) => /^SELECT MAX\(rowid\) AS top FROM /.test(sql)).length;
      const identities = pass.sql.filter((sql) =>
        /^SELECT COUNT\(\*\) AS held, COALESCE\(MAX\(rowid\), 0\) AS top FROM /.test(sql),
      ).length;
      pass.close();
      return { total, seeks, identities };
    };
    const committedOn = (dbPath: string): boolean => {
      const raw = new Database(dbPath, { readonly: true });
      const rows = (
        raw.prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`).get() as { n: number }
      ).n;
      raw.close();
      return rows > 0;
    };

    // A file HQ has established but not yet committed on: the expensive half
    // has nothing to compare against and does not run. Stated because quoting
    // the committed-on figure for every pass overstates this case four times
    // over.
    let before: { total: number; seeks: number; identities: number } | undefined;
    let plain: { total: number; seeks: number; identities: number } | undefined;
    let warm: { total: number; seeks: number; identities: number } | undefined;
    const fresh = fileFixture();
    try {
      fresh.db.close();
      expect(committedOn(fresh.dbPath), 'this branch is the pre-commitment one').toBe(false);
      before = measure(fresh.dbPath);
      expect(before.identities, 'no ledger identity is read before the first commitment').toBe(0);
      expect(before.total).toBeLessThan(STRUCTURAL_STATEMENT_BASE);

      // One more boot is what records the first commitment, and it is what
      // brings the 33 identity reads into the pass.
      const booted = openHqDatabase(fresh.dbPath);
      new HeadquarterOperations(booted);
      booted.close();
      expect(committedOn(fresh.dbPath)).toBe(true);
      plain = measure(fresh.dbPath);
      expect(plain.identities).toBe(ENGINE_IMMUTABLE_TABLES.length);

      // And a file carrying real reliability work, which brings further ledgers
      // into `sqlite_sequence` and therefore adds seeks.
      const file = warmedFile();
      try {
        warm = measure(file.dbPath);
        expect(warm.seeks, 'the two files must differ in the term being tested').toBeGreaterThan(
          plain.seeks,
        );
        // The RULE, on both committed-on files.
        expect(plain.total).toBe(STRUCTURAL_STATEMENT_BASE + plain.seeks);
        expect(warm.total).toBe(STRUCTURAL_STATEMENT_BASE + warm.seeks);
        // The seek term really is the sqlite_sequence count, on the file with
        // more of them — so the base is not absorbing a second variable.
        const raw = new Database(file.dbPath, { readonly: true });
        const sequenced = (
          raw.prepare(`SELECT name, seq FROM sqlite_sequence`).all() as { name: string; seq: number }[]
        ).filter((row) => declared.has(row.name) && row.seq > 0);
        raw.close();
        expect(warm.seeks).toBe(sequenced.length);
      } finally {
        file.cleanup();
      }
    } finally {
      fresh.cleanup();
    }

    // The sentence states the rule and interpolates the constant, so it cannot
    // carry a total of its own again — and it states the cheaper branch too.
    expect(INTEGRITY_DEPTH_STATEMENT).toContain(
      `${STRUCTURAL_STATEMENT_BASE} statements plus one for each of those seeks`,
    );
    expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/the whole pass is \d+ statements/);
    expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/Before the first commitment/);

    // And every illustrative figure in the constant's own docblock is parsed
    // back out of the source and compared to what was just measured, rather
    // than left beside the assertion as prose (round eleven, Medium 1).
    const constantProse = docblockBefore('export const STRUCTURAL_STATEMENT_BASE');
    const madeOf =
      /It is the (\d+) identity reads over the declared ledgers plus the (\d+) catalogue, pragma and commitment-ledger reads that do not move: (\d+) \+ (\d+) = (\d+) statements/.exec(
        constantProse,
      );
    expect(madeOf, 'the constant must state what it is made of, as a sum').toBeTruthy();
    expect(madeOf!.slice(1).map(Number)).toEqual([
      warm!.identities,
      warm!.total - warm!.identities - warm!.seeks,
      warm!.identities,
      warm!.total - warm!.identities - warm!.seeks,
      STRUCTURAL_STATEMENT_BASE,
    ]);

    const worked =
      /carries (\d+) such ledgers and executes (\d+) statements; one carrying a run attempt carries (\d+) and executes (\d+) statements/.exec(
        constantProse,
      );
    expect(worked, 'the constant must state the two files it was measured on').toBeTruthy();
    expect(worked!.slice(1).map(Number)).toEqual([
      plain!.seeks,
      plain!.total,
      warm!.seeks,
      warm!.total,
    ]);

    // The module header works the same rule on the same two files, and its
    // booted-twice half is the one this test — and only this test — measures.
    const headerWorked = HEADER_WORKED_COSTS.exec(moduleHeaderProse());
    expect(headerWorked, 'the module header must work the rule on two files').toBeTruthy();
    expect(headerWorked!.slice(1).map(Number)).toEqual([
      STRUCTURAL_STATEMENT_BASE,
      warm!.seeks,
      warm!.total,
      STRUCTURAL_STATEMENT_BASE,
      plain!.seeks,
      plain!.total,
    ]);

    const preCommitment = /measured at (\d+) statements and ZERO identity reads/.exec(constantProse);
    expect(preCommitment, 'the constant must state the pre-commitment branch').toBeTruthy();
    expect(Number(preCommitment![1])).toBe(before!.total);
    // "overstate … by three times" is the only comparative it makes, and it is
    // measured rather than rhetorical. It said FOUR until round thirteen's
    // Medium 1: the pre-commitment branch reads the same four durability pragmas
    // the committed-on branch does, so counting them raised the smaller number
    // proportionally more and the ratio fell. Both bounds move with the
    // comparative, so a stale word fails here.
    expect(constantProse).toMatch(/overstate the unestablished case by three\s*times/);
    expect(before!.total * 3).toBeLessThanOrEqual(plain!.total);
    expect(before!.total * 4).toBeGreaterThan(warm!.total);
  }, FILE_BACKED_BATTERY_TIMEOUT_MS);

  /**
   * Round thirteen, Medium 1 — the INSTRUMENT, checked before the number it
   * produces.
   *
   * The three previous undercounts of this clause were caught by parsing the
   * prose back out of the source and comparing it to a measurement. That rule
   * cannot catch an undercount the MEASUREMENT shares, and it did not: the
   * measurement wrapped `db.prepare`, `readDurabilityPosture` reads four pragmas
   * through `db.pragma()`, and "the durability pragmas" the sentence names in
   * its first clause were in neither the fixed term nor the total.
   *
   * So the instrument itself is asserted here. It is not enough that the numbers
   * agree — they agreed for three rounds while being wrong together.
   */
  it('counts the durability pragmas, which do not go through a prepared statement', () => {
    const file = warmedFile();
    try {
      const pass = statementsExecutedByOneStructuralPass(file.dbPath);
      // The four the served sentence promises a pass reads, by name, taken off
      // the `db.pragma` route rather than assumed to be somewhere in the total.
      expect([...pass.pragmas].sort()).toEqual([
        'foreign_keys',
        'journal_mode',
        'synchronous',
        'wal_autocheckpoint',
      ]);
      // They are not prepared statements, which is exactly why they were missed:
      // none of them appears in the prepared-statement stream.
      const prepared = pass.sql.filter((sql) => !sql.startsWith('PRAGMA '));
      for (const name of pass.pragmas) {
        expect(prepared.some((sql) => sql.includes(name))).toBe(false);
      }
      // `db.exec` is the third route to the engine. A structural pass takes it
      // zero times; that is pinned rather than assumed, so a future check that
      // used it could not slip past the count either.
      expect(pass.execs).toEqual([]);
      // And the fixed term the sentence prices includes them: the total minus
      // the two census terms is 15, of which 4 are these.
      const identities = pass.sql.filter((sql) =>
        /^SELECT COUNT\(\*\) AS held, COALESCE\(MAX\(rowid\), 0\) AS top FROM /.test(sql),
      ).length;
      const seeks = pass.sql.filter((sql) => /^SELECT MAX\(rowid\) AS top FROM /.test(sql)).length;
      const fixed = pass.sql.length - identities - seeks;
      expect(fixed).toBe(STRUCTURAL_STATEMENT_BASE - ENGINE_IMMUTABLE_TABLES.length);
      expect(fixed - pass.pragmas.length).toBe(
        STRUCTURAL_STATEMENT_BASE - ENGINE_IMMUTABLE_TABLES.length - 4,
      );
      pass.close();

      // The served sentence names the term it used to omit, and may not carry
      // the retired figure again.
      expect(INTEGRITY_DEPTH_STATEMENT).toContain(
        `${STRUCTURAL_STATEMENT_BASE - ENGINE_IMMUTABLE_TABLES.length} catalogue, pragma and ` +
          `commitment-ledger reads that do not move`,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(
        /11 catalogue, pragma and commitment-ledger reads/,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(/durability pragmas themselves/);
    } finally {
      file.cleanup();
    }
  }, FILE_BACKED_BATTERY_TIMEOUT_MS);

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
  }, FILE_BACKED_BATTERY_TIMEOUT_MS);

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
  }, FILE_BACKED_BATTERY_TIMEOUT_MS);

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
   * scale with the ledgers HQ DECLARES and the seeks with the ledgers the ENGINE
   * carries a positive `sqlite_sequence` row for. Only the third term — the
   * catalogue, pragma and commitment-ledger reads — is fixed.
   *
   * **The second term's census is the one correction the merge made to this
   * test** (round twelve, Medium 1, merged into round eleven's). This test as
   * written required the served sentence to say "with marks committed for 4 of
   * them" and compared that 4 to the measured seek count. The two agree in SIZE
   * on this fixture and name different sets — four `sqlite_sequence`-carrying
   * ledgers against three HQ has committed marks for — so the assertion passed
   * on the wrong rule, which is the failure mode the round above it exists to
   * stop. The test in the same describe block that compares the seeked SET to
   * the `sqlite_sequence` SET carries that half now, and this one asserts the
   * terms and the arithmetic.
   *
   * The total is therefore fixture-dependent BY CONSTRUCTION, and this test
   * treats it that way. Each of the three terms is measured off one real pass
   * over the deterministic `warmedFile()` fixture, the base is required to be
   * the two terms that do not move with the store's history, and then every
   * number the served sentence and the module header state is PARSED BACK OUT
   * of the prose and compared to the measurement. Nothing below retypes a
   * figure for the prose to agree with, which is the same rule the rest of this
   * file follows and the one the shipped constants escaped.
   */
  it('ships its three measured terms and no total or duration at all', () => {
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

      // The three terms, measured, and the shipped base as the two of them that
      // do not move with the store's history — rather than as a fourth
      // independent claim.
      expect(identities.length).toBe(ENGINE_IMMUTABLE_TABLES.length);
      expect(seeks.length).toBe(4);
      // 15, not 11, since round thirteen's Medium 1: the four durability
      // pragmas go through `db.pragma()` and the instrument above now counts
      // them. Deliberately a literal — this line is the independent claim the
      // parse-back below is compared against, so deriving it would make the
      // comparison circular.
      expect(fixedReads).toBe(15);
      expect(total).toBe(identities.length + seeks.length + fixedReads);
      expect(STRUCTURAL_STATEMENT_BASE).toBe(identities.length + fixedReads);

      // ...and the served sentence's arithmetic IS that arithmetic.
      const declaredClaim = /Over the (\d+) ledgers this build declares/.exec(
        INTEGRITY_DEPTH_STATEMENT,
      );
      const fixedClaim = /and (\d+) catalogue, pragma and commitment-ledger reads/.exec(
        INTEGRITY_DEPTH_STATEMENT,
      );
      const baseClaim = /(\d+) statements plus one for each of those seeks/.exec(
        INTEGRITY_DEPTH_STATEMENT,
      );
      for (const [term, match] of [
        ['declared ledgers', declaredClaim],
        ['fixed reads', fixedClaim],
        ['base statements', baseClaim],
      ] as const) {
        expect(match, `the depth statement must state its ${term}`).toBeTruthy();
      }
      expect(Number(declaredClaim![1])).toBe(identities.length);
      expect(Number(fixedClaim![1])).toBe(fixedReads);
      expect(Number(baseClaim![1])).toBe(STRUCTURAL_STATEMENT_BASE);

      // The second term is attributed to the census it really comes from, and
      // the retired attribution may not come back — the size agrees on this
      // fixture and the sets do not, which is why it went unnoticed.
      expect(INTEGRITY_DEPTH_STATEMENT).toMatch(
        /one further seek per declared ledger the engine carries\s+a positive sqlite_sequence row for/,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/with marks committed for \d+ of them/);
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/one further seek per committed one/);

      // And no fixture's TOTAL is served as though it were the cost of a pass.
      // The ONE statement count the sentence may carry is the base, and only in
      // the rule form the base claim above just read out of it.
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(
        /\d+ statements(?! plus one for each of those seeks)/,
      );
      expect(INTEGRITY_DEPTH_STATEMENT).not.toMatch(/the whole pass is \d+ statements/);

      // The module header states the base as a sum, and both worked totals as
      // sums, and they are read out of the source rather than trusted.
      const headerProse = moduleHeaderProse();
      const headerSum =
        /the two terms that do NOT move with the store's history are (\d+) \+ (\d+) = (\d+) statements/.exec(
          headerProse,
        );
      expect(headerSum, 'the module header must state the base as a sum of its terms').toBeTruthy();
      expect(headerSum!.slice(1).map(Number)).toEqual([
        identities.length,
        fixedReads,
        STRUCTURAL_STATEMENT_BASE,
      ]);
      const headerWorked = HEADER_WORKED_COSTS.exec(headerProse);
      expect(
        headerWorked,
        'the module header must show the rule worked on two files, not one total',
      ).toBeTruthy();
      expect(headerWorked!.slice(1, 4).map(Number)).toEqual([
        STRUCTURAL_STATEMENT_BASE,
        seeks.length,
        total,
      ]);
      expect(Number(headerWorked![4])).toBe(STRUCTURAL_STATEMENT_BASE);
      expect(Number(headerWorked![4]) + Number(headerWorked![5])).toBe(Number(headerWorked![6]));
      expect(Number(headerWorked![5])).toBeLessThan(seeks.length);

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
  }, FILE_BACKED_BATTERY_TIMEOUT_MS);
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
