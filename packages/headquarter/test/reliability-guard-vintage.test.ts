/**
 * Wave 5 review, correction cycle 2 — the MEDIUM.
 *
 * **The widened census raised a FALSE `append_only_guard_missing` on a
 * legitimate, untampered database created by an older version of this
 * repository's own code.** That is a regression introduced by the FIRST
 * correction (`9782b45`), not a pre-existing defect: widening the census to the
 * secondary guards was right, doing it with no schema-vintage awareness was
 * not.
 *
 * The consequences were both halves of a reliability failure at once. On the
 * first WRITABLE boot after an upgrade, `claimNext`, `approveTask`,
 * `releaseKillSwitch`, `executeAction`, `openRun` and every Founder-gated write
 * refused — an outage indistinguishable from a real tamper. On the READ-ONLY
 * `hq:snapshot` path the ensures return early, so nothing ever repaired the
 * file and the false verdict was PERMANENT: `safeMode: true` published to an
 * unauthenticated reader about a healthy record.
 *
 * ## The archaeology, because the fix is only as good as the facts under it
 *
 * `git log --reverse -S` over `packages/headquarter/src`, guard trigger name
 * versus `CREATE TABLE IF NOT EXISTS`, run over all 28 listed tables and all 19
 * secondary guards. Exactly four groups mismatch:
 *
 * | guard(s) | introduced | table introduced |
 * |---|---|---|
 * | `hq_memory` trio + `supersede_only` | `5da1ed7` (Phase 5) | `7e87392` (Phase 2 S4) |
 * | `hq_memory` `no_replace_idem` / `no_replace_rowid` | `2d72ce1` (Wave 2) | `7e87392` |
 * | `hq_mission_intents` trio | `ee942dc` / `ece8050` | `43174bd` (Phase 3) |
 * | `hq_mission_events` trio | `ee942dc` / `ece8050` | `43174bd` |
 *
 * The reviewer's probe also listed `trg_hq_products_no_replace_unique` and
 * `trg_hq_product_artifacts_no_replace_version` as missing from its "legitimate
 * older file". Checking rather than assuming: both appear in `f1ce71c`, the
 * SAME commit as `hq_products` and `hq_product_artifacts` — verified by reading
 * that commit's `product-command.ts`. No version of this code ever wrote a file
 * with those tables and without those guards, so requiring them whenever the
 * table is present stays correct and is unchanged here.
 *
 * ## The design
 *
 * Per-guard vintage, witnessed BY THE FILE. A guard is required only when the
 * file carries a schema object that the code declaring the guard also created.
 * Not a stored version marker: a marker lives in the same file the tamper is in
 * and can be deleted along with the guard, whereas these witnesses are tables
 * and columns HQ's own code needs.
 *
 * The vintage files below are reconstructed by REMOVING from a current file
 * exactly the schema objects the later versions added — which is what "written
 * by an older version" means as a fact about a file. Each is then proven clean,
 * and then proven to still catch a genuine drop.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { fileFixture } from './reliability.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { openHqDatabase, openHqDatabaseReadOnly, openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  HQ_GUARD_VINTAGE_PROVENANCE,
  declaredGuardSuffixesFor,
  declaredGuardsFor,
  missingImmutabilityGuards,
  readSchemaFacts,
  requiredGuardsFor,
  witnessPresent,
} from '../src/store/integrity.js';

/** Every table a given wave introduced, dropped to reconstruct an earlier file. */
const WAVE_2_AND_LATER_TABLES = [
  'hq_action_events',
  'hq_action_intents',
  'hq_truth_acceptances',
  'hq_truth_relations',
  'hq_truth_verifications',
  'hq_truth_records',
];
const WAVE_3_AND_LATER_TABLES = [
  'hq_briefs',
  'hq_collab_relations',
  'hq_collab_contributions',
  'hq_collab_participants',
  'hq_collab_sessions',
];
const WAVE_4_AND_LATER_TABLES = ['hq_product_artifacts', 'hq_product_events', 'hq_products'];
const PHASE_13_TABLES = [
  'hq_reliability_run_events',
  'hq_reliability_backups',
  'hq_reliability_runs',
];
const PHASE_14_TABLES = [
  'hq_intel_decision_outcomes',
  'hq_intel_cost_entries',
  'hq_intel_decisions',
  'hq_intel_budgets',
  'hq_intel_model_observations',
];

function dropTables(db: HqDatabase, tables: readonly string[]): void {
  for (const table of tables) {
    for (const row of db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
      .all(table) as { name: string }[]) {
      db.exec(`DROP TRIGGER IF EXISTS ${row.name}`);
    }
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/**
 * A real HQ file, then de-aged to a named vintage, then handed back as a PATH.
 *
 * The mutation runs on a raw connection so nothing re-ensures anything, and the
 * facade is opened afterwards by the caller — writable or read-only, which is
 * the difference between the reviewer's [4] and [4b].
 */
function vintageFile(
  deAge: (raw: HqDatabase) => void,
): { dbPath: string; cleanup: () => void; raw: () => HqDatabase } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-vintage-'));
  const dbPath = path.join(dir, 'headquarter.sqlite');
  const opened: HqDatabase[] = [];
  const seed = openHqDatabase(dbPath);
  opened.push(seed);
  void new HeadquarterOperations(seed);
  seed.close();
  const raw = new Database(dbPath) as unknown as HqDatabase;
  opened.push(raw);
  deAge(raw);
  return {
    dbPath,
    raw: () => {
      const handle = new Database(dbPath) as unknown as HqDatabase;
      opened.push(handle);
      return handle;
    },
    cleanup: () => {
      for (const handle of opened) {
        try {
          handle.close();
        } catch {
          // A double close is not a test failure.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Phase 2 Stage 4: `hq_memory` exists, unhardened, and nothing after it does. */
function toPhase2Stage4(raw: HqDatabase): void {
  dropTables(raw, [
    ...PHASE_14_TABLES,
    ...PHASE_13_TABLES,
    ...WAVE_4_AND_LATER_TABLES,
    ...WAVE_3_AND_LATER_TABLES,
    ...WAVE_2_AND_LATER_TABLES,
  ]);
  dropTables(raw, ['hq_project_events']);
  for (const row of raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'hq_memory'`)
    .all() as { name: string }[]) {
    raw.exec(`DROP TRIGGER ${row.name}`);
  }
  for (const row of raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'hq_mission_%'`)
    .all() as { name: string }[]) {
    raw.exec(`DROP TRIGGER ${row.name}`);
  }
  // The Phase 5 indexes went with the Phase 5 columns; SQLite refuses a
  // DROP COLUMN while an index still references it.
  for (const index of [
    'idx_hq_memory_idem',
    'idx_hq_memory_mission',
    'idx_hq_memory_project_ref',
    'idx_hq_memory_task',
  ]) {
    raw.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  for (const column of ['derived_from', 'mission_id', 'project_id', 'task_id', 'idempotency_key']) {
    raw.exec(`ALTER TABLE hq_memory DROP COLUMN ${column}`);
  }
}

/**
 * Phase 5: `hq_memory` hardened (trio + supersede rule + the `derived_from`
 * column), Wave 2 and later absent — so the two Wave 2 REPLACE guards are
 * absent too, exactly as that version wrote them.
 */
function toPhase5(raw: HqDatabase): void {
  dropTables(raw, [
    ...PHASE_14_TABLES,
    ...PHASE_13_TABLES,
    ...WAVE_4_AND_LATER_TABLES,
    ...WAVE_3_AND_LATER_TABLES,
    ...WAVE_2_AND_LATER_TABLES,
  ]);
  raw.exec(`DROP TRIGGER trg_hq_memory_no_replace_idem`);
  raw.exec(`DROP TRIGGER trg_hq_memory_no_replace_rowid`);
}

/** Wave 4: everything through the Product Factory, no Phase 13/14 ledgers. */
function toWave4(raw: HqDatabase): void {
  dropTables(raw, [...PHASE_14_TABLES, ...PHASE_13_TABLES]);
}

describe('the census knows a schema vintage from a tamper', () => {
  it('finds NOTHING wrong with a Phase 2 Stage 4 file — hq_memory, unguarded, as that version wrote it', () => {
    const file = vintageFile(toPhase2Stage4);
    try {
      const raw = file.raw();
      expect(raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'hq_memory'`).get()).toBeTruthy();
      // Before this fix: five findings on hq_memory alone, all false.
      expect(missingImmutabilityGuards(raw)).toEqual([]);
    } finally {
      file.cleanup();
    }
  });

  it('finds NOTHING wrong with a Phase 5 file that legitimately lacks the two Wave 2 guards', () => {
    // This is the reviewer's exact case: the table, the trio, and NOT
    // `no_replace_idem` / `no_replace_rowid`, because Wave 2 had not happened.
    const file = vintageFile(toPhase5);
    try {
      const raw = file.raw();
      const triggers = new Set(
        (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as {
          name: string;
        }[]).map((row) => row.name),
      );
      expect(triggers.has('trg_hq_memory_no_rewrite')).toBe(true);
      expect(triggers.has('trg_hq_memory_supersede_only')).toBe(true);
      expect(triggers.has('trg_hq_memory_no_replace_idem')).toBe(false);
      expect(triggers.has('trg_hq_memory_no_replace_rowid')).toBe(false);

      expect(missingImmutabilityGuards(raw)).toEqual([]);
    } finally {
      file.cleanup();
    }
  });

  it('finds NOTHING wrong with a Wave 4 file', () => {
    const file = vintageFile(toWave4);
    try {
      expect(missingImmutabilityGuards(file.raw())).toEqual([]);
    } finally {
      file.cleanup();
    }
  });

  it('still catches a GENUINE drop at every one of those vintages', () => {
    const cases: { name: string; deAge: (raw: HqDatabase) => void; drop: string }[] = [
      // The trio is required at Phase 2 S4? No — hq_memory carried no guards
      // then. So the genuine-drop case there is a table whose guards DID
      // arrive with it.
      { name: 'phase-2-s4', deAge: toPhase2Stage4, drop: 'trg_hq_orch_runs_no_erase' },
      { name: 'phase-5', deAge: toPhase5, drop: 'trg_hq_memory_supersede_only' },
      { name: 'wave-4', deAge: toWave4, drop: 'trg_hq_memory_no_replace_idem' },
      { name: 'wave-4-secondary', deAge: toWave4, drop: 'trg_hq_products_no_replace_unique' },
    ];
    for (const testCase of cases) {
      const file = vintageFile((raw) => {
        testCase.deAge(raw);
        raw.exec(`DROP TRIGGER ${testCase.drop}`);
      });
      try {
        expect(missingImmutabilityGuards(file.raw()), testCase.name).toEqual([testCase.drop]);
      } finally {
        file.cleanup();
      }
    }
  });

  it('still catches a drop of EVERY declared guard on a current file', () => {
    // The other direction, exhaustively: at the live vintage nothing is
    // excused, so a fix that quietly excused a guard everywhere fails here.
    const fx = fileFixture();
    try {
      const facts = readSchemaFacts(fx.db);
      for (const entry of ENGINE_IMMUTABLE_TABLES) {
        expect(requiredGuardsFor(entry, facts).sort(), entry.table).toEqual(
          [...declaredGuardsFor(entry)].sort(),
        );
      }
      const raw = fx.raw();
      const all = ENGINE_IMMUTABLE_TABLES.flatMap((entry) => declaredGuardsFor(entry));
      for (const guard of all) raw.exec(`DROP TRIGGER ${guard}`);
      expect(missingImmutabilityGuards(raw).sort()).toEqual([...all].sort());
    } finally {
      fx.cleanup();
    }
  });
});

describe('the vintage-aware census through the facade, both handle kinds', () => {
  it('does NOT engage safe mode on a writable boot over a legitimate Phase 5 file (the reviewer probe [4])', () => {
    const file = vintageFile(toPhase5);
    try {
      const db = openHqDatabase(file.dbPath);
      const ops = new HeadquarterOperations(db);
      const posture = ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(false);
      expect(
        posture.integrity.observations.map((o) => o.finding),
      ).not.toContain('append_only_guard_missing');
      db.close();
    } finally {
      file.cleanup();
    }
  });

  it('does NOT publish a false safeMode over the READ-ONLY snapshot path (the reviewer probe [4b])', () => {
    // The worse half: the ensures return early on a read-only handle, so
    // nothing repairs the file and a false verdict here is PERMANENT — a
    // law-8 truth violation published to an unauthenticated reader.
    const file = vintageFile(toPhase5);
    try {
      const db = openHqDatabaseReadOnly(file.dbPath);
      const ops = new HeadquarterOperations(db);
      const summary = ops.reliabilitySummary();
      expect(summary.findings.append_only_guard_missing).toBeUndefined();
      expect(summary.safeMode).toBe(false);
      // The durability finding on a read-only handle is real and unchanged —
      // it is reported and does NOT engage safe mode, which is the older rule
      // this fix must not have disturbed.
      expect(ops.hqReliabilityPosture().integrity.observations.map((o) => o.finding)).not.toContain(
        'append_only_guard_missing',
      );
      db.close();
    } finally {
      file.cleanup();
    }
  });

  it('DOES engage safe mode over the read-only path when a guard was genuinely dropped', () => {
    const file = vintageFile((raw) => {
      toPhase5(raw);
      raw.exec(`DROP TRIGGER trg_hq_memory_no_rewrite`);
    });
    try {
      const db = openHqDatabaseReadOnly(file.dbPath);
      const ops = new HeadquarterOperations(db);
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      expect(ops.reliabilitySummary().findings.append_only_guard_missing).toBe(1);
      db.close();
    } finally {
      file.cleanup();
    }
  });
});

describe('the vintage declaration cannot rot silently', () => {
  it('names only real guard suffixes on the table it sits on', () => {
    for (const entry of ENGINE_IMMUTABLE_TABLES) {
      const suffixes = new Set(declaredGuardSuffixesFor(entry));
      for (const suffix of Object.keys(entry.laterThanTable ?? {})) {
        expect(suffixes.has(suffix), `${entry.table}.${suffix}`).toBe(true);
      }
    }
  });

  it('names witnesses that actually EXIST in the live schema', () => {
    // A typo'd witness is the dangerous failure mode: it would never be
    // present, so the guard would never be required, and a real drop would go
    // unreported forever. This is the test that makes that impossible.
    const db = openMemoryHqDatabase();
    void new HeadquarterOperations(db);
    const facts = readSchemaFacts(db);
    for (const entry of ENGINE_IMMUTABLE_TABLES) {
      for (const [suffix, witness] of Object.entries(entry.laterThanTable ?? {})) {
        expect(witnessPresent(witness, facts), `${entry.table}.${suffix}`).toBe(true);
      }
    }
    db.close();
  });

  it('declares exactly the four groups the archaeology found, and no more', () => {
    const withVintage = ENGINE_IMMUTABLE_TABLES.filter((entry) => entry.laterThanTable);
    expect(withVintage.map((entry) => entry.table).sort()).toEqual([
      'hq_memory',
      'hq_mission_events',
      'hq_mission_intents',
    ]);
    // Three TABLES, four commit groups: `hq_memory` carries two of them.
    expect(HQ_GUARD_VINTAGE_PROVENANCE.mismatchedGroups).toBe(4);
    expect([...HQ_GUARD_VINTAGE_PROVENANCE.roundedUpGroups]).toEqual([
      'hq_mission_intents',
      'hq_mission_events',
    ]);
    // Every OTHER table is held to its full declaration whenever it exists,
    // which is the rule that was already right and is not relaxed.
    for (const entry of ENGINE_IMMUTABLE_TABLES) {
      if (entry.laterThanTable) continue;
      const facts: Parameters<typeof requiredGuardsFor>[1] = {
        hasTable: () => false,
        hasColumn: () => false,
      };
      expect(requiredGuardsFor(entry, facts), entry.table).toEqual(declaredGuardsFor(entry));
    }
  });
});
