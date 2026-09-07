/**
 * Phase 13 — DURABILITY. The claims this phase makes about a FILE are proved
 * against a real file: engine-held immutability from a raw connection that
 * never ran this code, the cross-connection duplicate-attempt guard, the
 * durability posture, the engine-immutable-table inventory, and backup
 * verification against real bytes on disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import { openHqDatabase, openMemoryHqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  HQ_DURABILITY_REQUIREMENT,
  HQ_INTEGRITY_FINDINGS,
  REQUIRED_IMMUTABILITY_GUARDS,
  SAFE_MODE_BLOCKING_FINDINGS,
  declaredGuardsFor,
  findingIsBlocking,
  fullIntegrity,
  missingImmutabilityGuards,
  readDurabilityPosture,
  structuralIntegrity,
  verifyHqBackupFile,
} from '../src/store/integrity.js';
import { reliabilitySchemaPresent } from '../src/application/reliability-command.js';
import { HeadquarterOperations } from '../src/application/service.js';

function openedRun(fx: ReturnType<typeof fileFixture>, label = 'the one run') {
  return expectOk(
    fx.ops.openRun({
      taskId: fx.claim.taskId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      runKind: 'external_action',
      label,
    }),
  ).run;
}

describe('the run ledger is immutable BY ENGINE, not by this module’s discipline', () => {
  it('refuses UPDATE, DELETE and REPLACE from a RAW connection that never ran the application', async () => {
    const fx = fileFixture();
    try {
      const run = openedRun(fx);
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      // The backup register needs a row before an UPDATE/DELETE on it can be
      // refused at all — a trigger on an empty table fires for nothing, and a
      // vacuously passing assertion is worse than no assertion.
      const backupPath = path.join(fx.dir, 'immutability.sqlite');
      await fx.db.backup(backupPath);
      expectOk(fx.ops.recordVerifiedBackup({ backupPath, requestedBy: 'founder' }));
      // A separate better-sqlite3 handle. It has no idea this repository
      // exists; the guarantee has to live in the FILE.
      const raw = fx.raw();
      for (const statement of [
        `UPDATE hq_reliability_runs SET label = 'rewritten' WHERE id = '${run.id}'`,
        `DELETE FROM hq_reliability_runs WHERE id = '${run.id}'`,
        `UPDATE hq_reliability_run_events SET kind = 'reconciled' WHERE run_id = '${run.id}'`,
        `DELETE FROM hq_reliability_run_events WHERE run_id = '${run.id}'`,
        `UPDATE hq_reliability_backups SET size_bytes = 0`,
        `DELETE FROM hq_reliability_backups`,
      ]) {
        expect(() => raw.exec(statement), statement).toThrow(/append-only/);
      }
      expect(fx.ops.getRun(run.id)!.label).toBe('the one run');
      expect(fx.ops.getRun(run.id)!.attempts).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a REPLACE that collides on the run key — the duplicate-run guard', () => {
    const fx = fileFixture();
    try {
      const run = openedRun(fx);
      const raw = fx.raw();
      const stored = raw
        .prepare(`SELECT * FROM hq_reliability_runs WHERE id = ?`)
        .get(run.id) as Record<string, unknown>;
      // REPLACE resolving a unique-index conflict deletes the standing row
      // WITHOUT firing BEFORE DELETE, so the secondary-unique guard is what
      // actually holds here.
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO hq_reliability_runs
               (id, run_kind, task_id, mission_id, action_id, capability_id, worker_id, claim_fence,
                claim_nonce, process_id, label, opened_at, run_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'a-different-id',
            'dispatch',
            stored.task_id,
            null,
            null,
            stored.capability_id,
            'somebody-else',
            0,
            null,
            'a-forged-process',
            'a forged run',
            '2026-01-01T00:00:00.000Z',
            stored.run_key,
          ),
      ).toThrow(/append-only/);
      expect(fx.ops.listRuns()).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a REPLACE that collides on the ATTEMPT key — the duplicate-attempt guard', () => {
    const fx = fileFixture();
    try {
      const run = openedRun(fx);
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      const raw = fx.raw();
      const attempt = raw
        .prepare(`SELECT * FROM hq_reliability_run_events WHERE attempt_key IS NOT NULL`)
        .get() as Record<string, unknown>;
      expect(attempt).toBeTruthy();
      // Erasing the standing attempt reservation is what would free a
      // generation for a SECOND real execution of the same work, so this is
      // the guard the phase most depends on.
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO hq_reliability_run_events
               (id, run_id, kind, actor, at, process_id, detail, attempt_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'a-forged-event',
            run.id,
            'attempt_started',
            'somebody-else',
            '2026-01-01T00:00:00.000Z',
            'a-forged-process',
            '{}',
            attempt.attempt_key,
          ),
      ).toThrow(/append-only/);
      expect(fx.ops.getRun(run.id)!.attempts).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a duplicate attempt across TWO CONNECTIONS, by index rather than by memory', () => {
    const fx = fileFixture();
    try {
      const run = openedRun(fx);
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      const attemptKey = (
        fx
          .raw()
          .prepare(`SELECT attempt_key FROM hq_reliability_run_events WHERE attempt_key IS NOT NULL`)
          .get() as { attempt_key: string }
      ).attempt_key;
      // A plain INSERT of the same generation from a connection that shares no
      // memory with the first: refused by the UNIQUE index itself.
      const other = fx.raw();
      expect(() =>
        other
          .prepare(
            `INSERT INTO hq_reliability_run_events (id, run_id, kind, actor, at, process_id, detail, attempt_key)
             VALUES (?, ?, 'attempt_started', 'second-process', '2026-01-01T00:00:00.000Z', 'p2', '{}', ?)`,
          )
          .run('second-attempt', run.id, attemptKey),
      ).toThrow(/UNIQUE|append-only/);
      expect(fx.ops.getRun(run.id)!.attempts).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('sees one process’s committed run from a SECOND facade over the same file', () => {
    const fx = fileFixture();
    try {
      const run = openedRun(fx, 'written by process one');
      const second = fx.reopen('process-two');
      expect(second.ops.getRun(run.id)!.label).toBe('written by process one');
      expect(second.ops.getRun(run.id)!.processId).toBe('process-one');
      expect(second.ops.hqProcessIdentity()).toBe('process-two');
    } finally {
      fx.cleanup();
    }
  });
});

describe('the engine-immutable inventory is checked against the live schema, not maintained by hand', () => {
  it('lists every table the schema actually declares append-only', () => {
    const db = openMemoryHqDatabase();
    // Constructing the facade ensures every phase's schema, so the file now
    // carries the complete set.
    void new HeadquarterOperations(db);
    expect(reliabilitySchemaPresent(db)).toBe(true);
    const declared = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => name.endsWith('_no_rewrite'))
      .map((name) => name.replace(/^trg_/, '').replace(/_no_rewrite$/, ''))
      .sort();
    // Only the entries that HOLD the trio, because the list gained one that
    // deliberately does not: `hq_mission_plan_items` is legitimately updated
    // and carries three guards of its own instead (Wave 5 review, Medium
    // finding 6). The whole-schema check moved to the next test, which is
    // strictly stronger than this one was.
    const listed = ENGINE_IMMUTABLE_TABLES.filter((entry) => entry.holdsUniversalTrio !== false)
      .map((entry) => entry.triggerPrefix)
      .sort();
    // Every table with a `no_rewrite` guard is on the list. A future phase that
    // adds an append-only ledger and forgets to list it fails HERE, rather than
    // silently escaping the integrity check forever.
    expect(declared).toEqual(listed);
    // And the one non-trio entry is there for the stated reason, not by
    // accident: it carries no `no_rewrite` guard at all.
    expect(declared).not.toContain('hq_mission_plan_items');
    expect(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table)).toContain('hq_mission_plan_items');
    db.close();
  });

  /**
   * Wave 5 review, MEDIUM finding 2. The census used to match the trio only,
   * so every SECONDARY guard — the unique-index guards and `hq_memory`'s
   * supersede rule — was invisible to it: dropping one produced no
   * `append_only_guard_missing` finding and engaged no safe mode.
   *
   * The drift argument that justified leaving them out is answered here rather
   * than by leaving them unchecked: a phase that adds a guard and does not
   * DECLARE it fails this test, which is exactly where a maintenance mistake
   * should surface.
   */
  it('declares every guard the live schema actually carries on a listed table', () => {
    const db = openMemoryHqDatabase();
    void new HeadquarterOperations(db);
    const triggers = db
      .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'`)
      .all() as { name: string; tbl_name: string }[];
    for (const entry of ENGINE_IMMUTABLE_TABLES) {
      const live = triggers
        .filter((row) => row.tbl_name === entry.table)
        .map((row) => row.name)
        .sort();
      expect(live, entry.table).toEqual([...declaredGuardsFor(entry)].sort());
    }
    // INVERTED, and this is the half that was missing (Wave 5 review, Medium
    // finding 6). The loop above iterates the DECLARATION, so it cannot see a
    // guard on a table nobody listed — which is exactly how
    // `hq_mission_plan_items`' three guards escaped the census entirely, and
    // why the doc's "a phase that adds a guard and forgets to declare it fails
    // there" was untrue whenever the phase also added a table. Asserting the
    // LIVE trigger set equals the union of the declarations closes it in the
    // direction that matters: a new guarded table is now a test failure.
    const liveTriggers = triggers.map((row) => row.name).sort();
    const declaredTriggers = ENGINE_IMMUTABLE_TABLES.flatMap((entry) => declaredGuardsFor(entry)).sort();
    expect(liveTriggers).toEqual(declaredTriggers);
    db.close();
  });

  it('reports a dropped SECONDARY guard as a missing guard, on Phase 13 and Phase 14 alike', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      raw.exec('DROP TRIGGER trg_hq_intel_budgets_no_replace_unique');
      raw.exec('DROP TRIGGER trg_hq_reliability_run_events_no_replace_attempt');
      raw.exec('DROP TRIGGER trg_hq_memory_supersede_only');
      expect(missingImmutabilityGuards(raw)).toEqual([
        'trg_hq_intel_budgets_no_replace_unique',
        'trg_hq_memory_supersede_only',
        'trg_hq_reliability_run_events_no_replace_attempt',
      ]);
      // And the finding is BLOCKING, so a file found in that state engages
      // safe mode at the next construction — which is the half that makes the
      // census worth widening.
      const report = structuralIntegrity(raw, {
        guardsMissingAsFound: missingImmutabilityGuards(raw),
      });
      expect(report.safeMode).toBe(true);
      expect(report.observations.map((o) => o.finding)).toContain('append_only_guard_missing');
      expect(report.observations[0]!.detail).toContain('trg_hq_intel_budgets_no_replace_unique');
    } finally {
      fx.cleanup();
    }
  });

  it('engages safe mode at the next construction when a Phase 14 secondary guard is gone', () => {
    const fx = fileFixture();
    try {
      fx.raw().exec('DROP TRIGGER trg_hq_intel_costs_no_replace_unique');
      const restarted = fx.reopen('process-two');
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.map((o) => o.finding)).toContain('append_only_guard_missing');
      expect(posture.integrity.observations[0]!.detail).toContain(
        'trg_hq_intel_costs_no_replace_unique',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('finds nothing missing on a healthy database, and finds a dropped guard on a tampered one', () => {
    const fx = fileFixture();
    try {
      expect(missingImmutabilityGuards(fx.db)).toEqual([]);
      const raw = fx.raw();
      raw.exec('DROP TRIGGER trg_hq_reliability_runs_no_erase');
      raw.exec('DROP TRIGGER trg_hq_truth_records_no_replace');
      expect(missingImmutabilityGuards(raw)).toEqual([
        'trg_hq_reliability_runs_no_erase',
        'trg_hq_truth_records_no_replace',
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it('ignores a table that is simply ABSENT rather than calling it tampered', () => {
    // A pre-Phase-N file has never had these tables. Absence is not tampering,
    // and conflating the two would engage safe mode on every older database HQ
    // is ever pointed at.
    const bare = new Database(':memory:') as unknown as Parameters<typeof missingImmutabilityGuards>[0];
    expect(missingImmutabilityGuards(bare)).toEqual([]);
    bare.close();
  });

  it('requires exactly the trio of EVERY table, and the rest per table', () => {
    // The universal requirement is unchanged: requiring `no_replace_unique` of
    // a table with no secondary unique index would be a false finding, the
    // same reason `hq_mission_plan_items` is not held to the trio at all.
    expect([...REQUIRED_IMMUTABILITY_GUARDS]).toEqual(['no_rewrite', 'no_erase', 'no_replace']);
    // The rest are declared where they exist, and the census reads both.
    expect(declaredGuardsFor({
      table: 'hq_intel_budgets',
      triggerPrefix: 'hq_intel_budgets',
      secondaryGuards: ['no_replace_unique'],
    })).toEqual([
      'trg_hq_intel_budgets_no_rewrite',
      'trg_hq_intel_budgets_no_erase',
      'trg_hq_intel_budgets_no_replace',
      'trg_hq_intel_budgets_no_replace_unique',
    ]);
    expect(
      ENGINE_IMMUTABLE_TABLES.filter((entry) => entry.secondaryGuards.length > 0).map(
        (entry) => entry.table,
      ),
    ).toContain('hq_intel_budgets');
  });
});

describe('the durability posture is reported, never pretended', () => {
  it('reports a file-backed database as WAL + FULL, meeting the requirement', () => {
    const fx = fileFixture();
    try {
      const posture = readDurabilityPosture(fx.db);
      expect(posture.journalMode).toBe(HQ_DURABILITY_REQUIREMENT.journalMode);
      expect(posture.synchronous).toBe(HQ_DURABILITY_REQUIREMENT.synchronous);
      expect(posture.inMemory).toBe(false);
      expect(posture.meetsRequirement).toBe(true);
      expect(posture.readonly).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('says an in-memory database is in memory instead of claiming WAL', () => {
    const db = openMemoryHqDatabase();
    const posture = readDurabilityPosture(db);
    expect(posture.inMemory).toBe(true);
    expect(posture.journalMode).not.toBe('wal');
    // Not durable, and therefore not held to a durability requirement it
    // cannot meet — stated rather than fudged in either direction.
    expect(posture.meetsRequirement).toBe(true);
    db.close();
  });

  it('reports a degraded posture as an OBSERVATION that does not engage safe mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-durability-'));
    try {
      const dbPath = path.join(dir, 'weak.sqlite');
      const db = openHqDatabase(dbPath);
      db.pragma('synchronous = NORMAL');
      const report = structuralIntegrity(db);
      const finding = report.observations.find((o) => o.finding === 'durability_below_requirement');
      expect(finding).toBeTruthy();
      expect(finding!.blocking).toBe(false);
      expect(report.safeMode).toBe(false);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the finding vocabulary and what blocks', () => {
  it('is closed, and blocking is the short argued list', () => {
    expect([...SAFE_MODE_BLOCKING_FINDINGS]).toEqual([
      'database_integrity_check_failed',
      'append_only_guard_missing',
      'evidence_chain_broken',
    ]);
    for (const finding of HQ_INTEGRITY_FINDINGS) {
      expect(findingIsBlocking(finding)).toBe(SAFE_MODE_BLOCKING_FINDINGS.includes(finding));
    }
    // The three that are deliberately NOT blocking.
    expect(findingIsBlocking('foreign_key_violations')).toBe(false);
    expect(findingIsBlocking('durability_below_requirement')).toBe(false);
    expect(findingIsBlocking('reliability_schema_absent')).toBe(false);
  });

  it('engages safe mode on a BROKEN EVIDENCE CHAIN, which is the tamper a schema check cannot see', () => {
    const fx = fileFixture();
    try {
      // Rewrite a payload in the hash-chained evidence log through a raw
      // connection: `op_evidence` carries no triggers, because its guarantee is
      // the chain rather than the engine.
      const raw = fx.raw();
      const entry = raw.prepare(`SELECT id FROM op_evidence ORDER BY seq LIMIT 1`).get() as {
        id: string;
      };
      raw.prepare(`UPDATE op_evidence SET payload = ? WHERE id = ?`).run('{"tampered":true}', entry.id);
      const report = fullIntegrity(fx.db, {
        verifyEvidenceChain: () => fx.ops.queue.evidence.verifyChain(),
      });
      expect(report.depth).toBe('full');
      expect(report.safeMode).toBe(true);
      expect(report.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
    } finally {
      fx.cleanup();
    }
  });

  it('treats a chain that cannot be verified at all as a broken one', () => {
    const fx = fileFixture();
    try {
      const report = fullIntegrity(fx.db, {
        verifyEvidenceChain: () => {
          throw new Error('the log could not be read');
        },
      });
      expect(report.safeMode).toBe(true);
      expect(report.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
    } finally {
      fx.cleanup();
    }
  });

  it('reports a healthy store as healthy at both depths', () => {
    const fx = fileFixture();
    try {
      expect(structuralIntegrity(fx.db).safeMode).toBe(false);
      const full = fullIntegrity(fx.db, {
        verifyEvidenceChain: () => fx.ops.queue.evidence.verifyChain(),
      });
      expect(full.safeMode).toBe(false);
      expect(full.observations.filter((o) => o.blocking)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('backup verification, against real bytes on disk', () => {
  it('verifies a real SQLite copy of the HQ database and digests exactly what it checked', async () => {
    const fx = fileFixture();
    try {
      const backupPath = path.join(fx.dir, 'hq-backup.sqlite');
      await fx.db.backup(backupPath);
      const verification = verifyHqBackupFile(backupPath);
      expect(verification.verified).toBe(true);
      expect(verification.refusals).toEqual([]);
      expect(verification.integrityVerdict).toBe('ok');
      expect(verification.schemaTables).toBeGreaterThan(10);
      // The digest is of the FILE, computed by HQ — not a declared one.
      const expected = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
      expect(verification.digest).toBe(expected);
      expect(verification.sizeBytes).toBe(fs.statSync(backupPath).size);
    } finally {
      fx.cleanup();
    }
  });

  it('records a verified backup once, and deduplicates the identical record', async () => {
    const fx = fileFixture();
    try {
      const backupPath = path.join(fx.dir, 'hq-backup.sqlite');
      await fx.db.backup(backupPath);
      const first = expectOk(
        fx.ops.recordVerifiedBackup({
          backupPath,
          requestedBy: 'founder',
          note: 'nightly recovery point',
        }),
      );
      expect(first.deduplicated).toBe(false);
      expect(first.backup.contentDigest).toHaveLength(64);
      expect(first.backup.verifiedBy).toBe('founder');
      expect(first.backup.statement).toMatch(/computed BY HQ/);
      const again = expectOk(fx.ops.recordVerifiedBackup({ backupPath, requestedBy: 'founder' }));
      expect(again.deduplicated).toBe(true);
      expect(again.backup.id).toBe(first.backup.id);
      expect(fx.ops.listVerifiedBackupsBounded().total).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses every path protection, categorically, and records nothing', () => {
    const fx = fileFixture();
    try {
      const refuse = (candidate: string): string[] => {
        const result = fx.ops.recordVerifiedBackup({ backupPath: candidate, requestedBy: 'founder' });
        expect(result.ok).toBe(false);
        return (
          (!result.ok && (result.error.details?.refusals as string[])) || []
        );
      };
      expect(refuse('relative/path.sqlite')).toEqual(['path_not_absolute']);
      expect(refuse(path.join(fx.dir, 'does-not-exist.sqlite'))).toEqual(['path_missing']);
      expect(refuse(fx.dir)).toEqual(['path_not_a_regular_file']);

      const empty = path.join(fx.dir, 'empty.sqlite');
      fs.writeFileSync(empty, '');
      expect(refuse(empty)).toEqual(['file_empty']);

      const link = path.join(fx.dir, 'link.sqlite');
      fs.symlinkSync(fx.dbPath, link);
      expect(refuse(link)).toEqual(['path_is_symlink']);

      const garbage = path.join(fx.dir, 'garbage.sqlite');
      fs.writeFileSync(garbage, 'this is not a database, it is a poem');
      expect(refuse(garbage)).toEqual(['not_a_readable_sqlite_database']);

      // A perfectly valid SQLite database that is not an HQ database.
      const foreign = path.join(fx.dir, 'foreign.sqlite');
      const other = new Database(foreign);
      other.exec('CREATE TABLE somebody_elses_data (x TEXT)');
      other.close();
      expect(refuse(foreign)).toEqual(['not_an_hq_database']);

      expect(fx.ops.listVerifiedBackupsBounded().total).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a CORRUPTED backup rather than vouching for it', async () => {
    const fx = fileFixture();
    try {
      const backupPath = path.join(fx.dir, 'hq-backup.sqlite');
      await fx.db.backup(backupPath);
      // Scribble over the LAST page of the file: still opens (`sqlite_master`
      // lives at the front), fails `integrity_check` (a page whose first byte
      // is 0x41 is not a valid b-tree page type).
      //
      // Deliberately the last page rather than 2048 bytes at `size / 2`, which
      // is what this used to do. That offset only hit a b-tree page by luck of
      // the current schema size: adding one table to HQ moved it onto a page
      // whose corruption `integrity_check` does not report, and the test then
      // silently stopped testing what it says it tests. Page-aligned, at a page
      // the front-loaded catalogue never occupies, is a choice that stays true.
      const size = fs.statSync(backupPath).size;
      const headerBytes = Buffer.alloc(2);
      const headerFd = fs.openSync(backupPath, 'r');
      fs.readSync(headerFd, headerBytes, 0, 2, 16);
      fs.closeSync(headerFd);
      const declared = headerBytes.readUInt16BE(0);
      // SQLite encodes a 65536-byte page as 1 in the header.
      const pageSize = declared === 1 ? 65536 : declared;
      expect(size % pageSize).toBe(0);
      const handle = fs.openSync(backupPath, 'r+');
      fs.writeSync(handle, Buffer.alloc(pageSize, 0x41), 0, pageSize, size - pageSize);
      fs.closeSync(handle);
      const verification = verifyHqBackupFile(backupPath);
      expect(verification.verified).toBe(false);
      // WHICH refusal, by name (Wave 5 review, Low finding 8). This test used
      // to assert `verified: false` and the facade's error CODE only, which
      // left `integrity_check_failed` the one refusal of the eight exercised
      // here whose reason nothing pinned — so a corrupted backup and a
      // perfectly good one refused for an unrelated reason read the same.
      expect(verification.refusals).toContain('integrity_check_failed');
      expect(verification.integrityVerdict).not.toBe('ok');
      const refusal = fx.ops.recordVerifiedBackup({ backupPath, requestedBy: 'founder' });
      expect(refusal.ok).toBe(false);
      expect(!refusal.ok && refusal.error.code).toBe('backup_verification_failed');
      expect(
        !refusal.ok && (refusal.error.details?.refusals as string[]),
      ).toContain('integrity_check_failed');
      expect(!refusal.ok && refusal.error.message).toContain('integrity_check_failed');
      expect(fx.ops.listVerifiedBackupsBounded().total).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('is a pure read of the candidate, and REFUSES a database carrying a journal sidecar', () => {
    const fx = fileFixture();
    try {
      const before = fs.readFileSync(fx.dbPath);
      const verification = verifyHqBackupFile(fx.dbPath);
      // The LIVE database is WAL-mode and carries a `-wal`, and SQLite resolves
      // that together with the main file while the digest covers only the main
      // file. Verifying it used to return `verified: true` — a record whose
      // digest did not pin what was checked (Wave 5 review, High finding 3).
      // The honest answer is a categorical refusal, and this test asserts it
      // by name rather than asserting the old, weaker pass.
      expect(verification.verified).toBe(false);
      expect(verification.refusals).toEqual(['sidecar_journal_present']);
      // Still a pure read: not one byte of the candidate changed, and HQ left
      // no sidecar of its own beside it either — the previous version created
      // `-wal`/`-shm` next to whatever it verified, by opening it with SQLite.
      expect(fs.readFileSync(fx.dbPath).equals(before)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('creates no sidecar beside the candidate, so verifying twice is stable', async () => {
    const fx = fileFixture();
    try {
      const backupPath = path.join(fx.dir, 'hq-backup.sqlite');
      await fx.db.backup(backupPath);
      const first = verifyHqBackupFile(backupPath);
      expect(first.verified).toBe(true);
      // The whole reason the checks run against a scratch COPY: opening the
      // candidate with SQLite creates `<path>-wal` and `<path>-shm` and leaves
      // them there, so a verification that opened it directly would refuse its
      // own leftovers on the next call — and would have been reading bytes its
      // digest did not cover on this one.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        expect(fs.existsSync(`${backupPath}${suffix}`), suffix).toBe(false);
      }
      const second = verifyHqBackupFile(backupPath);
      expect(second.verified).toBe(true);
      expect(second.digest).toBe(first.digest);
      expect(second.schemaTables).toBe(first.schemaTables);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read a -wal the digest never covered', async () => {
    const fx = fileFixture();
    try {
      // The reviewer's exploit, verbatim: a genuine consolidated backup, with
      // a `-wal` dropped beside it afterwards. It used to verify `true` with
      // the pristine file's digest and a table count read out of the sidecar.
      const backupPath = path.join(fx.dir, 'exploit.sqlite');
      await fx.db.backup(backupPath);
      const cleanDigest = verifyHqBackupFile(backupPath).digest;
      expect(cleanDigest).toHaveLength(64);
      fs.writeFileSync(`${backupPath}-wal`, Buffer.alloc(4096, 0x00));
      const withSidecar = verifyHqBackupFile(backupPath);
      expect(withSidecar.verified).toBe(false);
      expect(withSidecar.refusals).toEqual(['sidecar_journal_present']);
      // Nothing about the file was reported at all — not a digest that would
      // have pinned the wrong thing, and not a table count.
      expect(withSidecar.digest).toBeNull();
      expect(withSidecar.schemaTables).toBeNull();
      const refusal = fx.ops.recordVerifiedBackup({ backupPath, requestedBy: 'founder' });
      expect(refusal.ok).toBe(false);
      expect(!refusal.ok && refusal.error.code).toBe('backup_verification_failed');
      expect(fx.ops.listVerifiedBackupsBounded().total).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a path that is absolute but not normalized, without resolving it', () => {
    const fx = fileFixture();
    try {
      const sneaky = path.join(fx.dir, 'sub', '..', 'headquarter.sqlite');
      // `path.join` normalizes, so build the unnormalized text directly.
      const raw = `${fx.dir}/./headquarter.sqlite`;
      expect(path.isAbsolute(raw)).toBe(true);
      expect(verifyHqBackupFile(raw).refusals).toEqual(['path_not_normalized']);
      expect(verifyHqBackupFile(`${fx.dir}/sub/../headquarter.sqlite`).refusals).toEqual([
        'path_not_normalized',
      ]);
      // And the normalized form of the same text is a different question,
      // answered on its own merits rather than by resolution.
      expect(sneaky).toBe(fx.dbPath);
    } finally {
      fx.cleanup();
    }
  });

  it('RESTORES from a verified backup into a working HQ database', async () => {
    const fx = fileFixture();
    try {
      const run = openedRun(fx, 'recorded before the backup');
      const backupPath = path.join(fx.dir, 'hq-backup.sqlite');
      await fx.db.backup(backupPath);
      expect(verifyHqBackupFile(backupPath).verified).toBe(true);

      // A restore is a file copy plus a verification; both halves are proven
      // here rather than assumed, because a backup nobody has opened is not a
      // recovery point.
      const restoredPath = path.join(fx.dir, 'restored.sqlite');
      fs.copyFileSync(backupPath, restoredPath);
      expect(verifyHqBackupFile(restoredPath).verified).toBe(true);
      // The restored copy is a byte-for-byte copy, and its own digest says so.
      // Asserted BEFORE the file is opened live: opening a WAL-mode database
      // for writing creates a `-wal` beside it, and a candidate carrying a
      // journal sidecar is refused rather than verified (Wave 5 review, High
      // finding 3) — an open database is not a recovery point.
      expect(verifyHqBackupFile(restoredPath).digest).toBe(verifyHqBackupFile(backupPath).digest);

      const restored = openHqDatabase(restoredPath);
      const ops = new HeadquarterOperations(restored, { processIdentity: 'restored-process' });
      expect(ops.getRun(run.id)!.label).toBe('recorded before the backup');
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(verifyHqBackupFile(restoredPath).refusals).toEqual(['sidecar_journal_present']);
      restored.close();
    } finally {
      fx.cleanup();
    }
  });
});
