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
import { openHqDatabase, openHqDatabaseReadOnly, openMemoryHqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  HQ_DURABILITY_REQUIREMENT,
  HQ_INTEGRITY_FINDINGS,
  REQUIRED_IMMUTABILITY_GUARDS,
  SAFE_MODE_BLOCKING_FINDINGS,
  declaredGuardNames,
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
    const listed = ENGINE_IMMUTABLE_TABLES.map((entry) => entry.triggerPrefix).sort();
    // Every table with a `no_rewrite` guard is on the list. A future phase that
    // adds an append-only ledger and forgets to list it fails HERE, rather than
    // silently escaping the integrity check forever.
    expect(declared).toEqual(listed);
    db.close();
  });

  /**
   * Wave 5 High 1. The census used to check the trio only, so the SECONDARY
   * guards — including `trg_hq_reliability_run_events_no_replace_attempt`, the
   * cross-process duplicate-attempt guard the module's own comment calls load-
   * bearing — could be dropped with no finding at all. This pins the FULL
   * trigger-name set for every listed prefix, so a guard a future phase adds
   * and forgets to declare fails here rather than escaping the check.
   */
  it('lists every guard each of those tables actually declares, not just the trio', () => {
    const db = openMemoryHqDatabase();
    void new HeadquarterOperations(db);
    const live = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]
    ).map((row) => row.name);
    for (const entry of ENGINE_IMMUTABLE_TABLES) {
      const onFile = live.filter((name) => name.startsWith(`trg_${entry.triggerPrefix}_`)).sort();
      expect(declaredGuardNames(entry).sort(), entry.table).toEqual(onFile);
    }
    db.close();
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

  it('requires exactly the trio that carries the guarantee', () => {
    expect([...REQUIRED_IMMUTABILITY_GUARDS]).toEqual(['no_rewrite', 'no_erase', 'no_replace']);
  });

  /**
   * Wave 5 High 1, as the exploit that found it. Dropping ONE secondary guard
   * used to be invisible: the census reported `[]`, safe mode stayed false at
   * both depths, and a raw `INSERT OR REPLACE` then erased a committed
   * append-only row (`recursive_triggers` is off and connection-scoped, so no
   * BEFORE DELETE fires) and substituted a forged one, with no finding.
   */
  it('finds a dropped SECONDARY guard, and engages safe mode on it', () => {
    const fx = fileFixture();
    try {
      openedRun(fx, 'the run whose attempt guard is about to vanish');
      expect(missingImmutabilityGuards(fx.db)).toEqual([]);
      const raw = fx.raw();
      raw.exec('DROP TRIGGER trg_hq_reliability_run_events_no_replace_attempt');

      expect(missingImmutabilityGuards(raw)).toEqual([
        'trg_hq_reliability_run_events_no_replace_attempt',
      ]);
      // Both depths, because the census feeds both.
      expect(structuralIntegrity(raw).safeMode).toBe(true);
      expect(fullIntegrity(raw).safeMode).toBe(true);
      expect(
        structuralIntegrity(raw).observations.map((observation) => observation.finding),
      ).toContain('append_only_guard_missing');

      // And the next construction latches it.
      const restarted = fx.reopen('process-two');
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
    } finally {
      fx.cleanup();
    }
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

/**
 * Wave 5 High 5. `reliabilitySummary()` is the one read on the path that
 * produces the WORLD-READABLE `hq-snapshot.json`. Its store-absent branch
 * returned a hard-coded `{safeMode:false, findings:{},
 * durabilityMeetsRequirement:true}` — but `#integrityReport` is latched at
 * construction independently of the reliability store, and the snapshot CLI
 * opens read-only, which is exactly that branch. So the artifact published
 * "everything is fine" while HQ had latched safe mode with blocking findings.
 */
describe('the unauthenticated snapshot never publishes optimism HQ does not hold', () => {
  it('carries the latched safe-mode verdict on a handle with no run ledger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-snapshot-failopen-'));
    try {
      const dbPath = path.join(dir, 'hq.sqlite');
      const built = openHqDatabase(dbPath);
      void new HeadquarterOperations(built);
      built.close();

      // A file that carries no Phase 13 ledger AND has lost an append-only
      // guard — the two facts the read-only snapshot path must not conflate.
      const raw = openHqDatabase(dbPath);
      raw.exec('DROP TABLE hq_reliability_runs');
      raw.exec('DROP TRIGGER trg_hq_action_events_no_erase');
      raw.close();

      const readOnly = openHqDatabaseReadOnly(dbPath);
      const ops = new HeadquarterOperations(readOnly);
      expect(ops.reliabilityStorePresent()).toBe(false);
      const latched = ops.hqReliabilityPosture().integrity;
      expect(latched.safeMode).toBe(true);

      const published = ops.reliabilitySummary();
      expect(published.storePresent).toBe(false);
      expect(published.safeMode).toBe(true);
      expect(published.findings.append_only_guard_missing).toBe(1);
      expect(published.assessmentDepth).toBe(latched.depth);
      // Reported as HQ actually found it, in either direction — never asserted.
      expect(published.durabilityMeetsRequirement).toBe(latched.durability.meetsRequirement);
      // The absence of the ledger is itself a stated finding, not silence.
      expect(published.findings.reliability_schema_absent).toBe(1);
      // Privacy shape unchanged: counts over the closed vocabulary only.
      for (const key of Object.keys(published.findings)) {
        expect(HQ_INTEGRITY_FINDINGS as readonly string[]).toContain(key);
      }
      readOnly.close();
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
      // Scribble over a page in the middle of the file: still opens, fails
      // integrity_check.
      const handle = fs.openSync(backupPath, 'r+');
      const size = fs.statSync(backupPath).size;
      fs.writeSync(handle, Buffer.alloc(2048, 0x41), 0, 2048, Math.floor(size / 2));
      fs.closeSync(handle);
      const verification = verifyHqBackupFile(backupPath);
      expect(verification.verified).toBe(false);
      const refusal = fx.ops.recordVerifiedBackup({ backupPath, requestedBy: 'founder' });
      expect(refusal.ok).toBe(false);
      expect(!refusal.ok && refusal.error.code).toBe('backup_verification_failed');
      expect(fx.ops.listVerifiedBackupsBounded().total).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('is a pure read: verifying the LIVE database changes not one byte of it', () => {
    const fx = fileFixture();
    try {
      const before = fs.readFileSync(fx.dbPath);
      const verification = verifyHqBackupFile(fx.dbPath);
      expect(verification.verified).toBe(true);
      expect(fs.readFileSync(fx.dbPath).equals(before)).toBe(true);
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

      const restored = openHqDatabase(restoredPath);
      const ops = new HeadquarterOperations(restored, { processIdentity: 'restored-process' });
      expect(ops.getRun(run.id)!.label).toBe('recorded before the backup');
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      // The restored copy is a different file, and its own digest says so.
      expect(verifyHqBackupFile(restoredPath).digest).toBe(verifyHqBackupFile(backupPath).digest);
      restored.close();
    } finally {
      fx.cleanup();
    }
  });
});
