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
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CAPS, expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import {
  openHqDatabase,
  openHqDatabaseReadOnly,
  openMemoryHqDatabase,
  schemaEnsuredMarkBeforeMigration,
} from '../src/store/db.js';
import {
  BACKUP_REFUSAL_REASONS,
  ENGINE_IMMUTABLE_TABLES,
  HQ_DURABILITY_REQUIREMENT,
  HQ_INTEGRITY_CHECKPOINT_TABLE,
  HQ_INTEGRITY_FINDINGS,
  LEDGER_ROWID_GUARDS,
  LEDGER_ROWID_GUARD,
  WRITE_ONCE_IDENTITY_TABLES,
  declaredGuardsForIdentityTable,
  declaredIdentityGuardFor,
  REQUIRED_IMMUTABILITY_GUARDS,
  ensureLedgerRowidGuards,
  ensureUniqueReentryGuards,
  ensureWriteOnceIdentityGuards,
  SAFE_MODE_BLOCKING_FINDINGS,
  declaredGuardsFor,
  establishedImmutableTables,
  findingIsBlocking,
  fullIntegrity,
  hqSchemaEnsuredMarkPresent,
  missingImmutabilityGuards,
  observeImmutabilityAsFound,
  readDurabilityPosture,
  regressedImmutableLedgers,
  structuralIntegrity,
  truncatedImmutableLedgers,
  verifyHqBackupFile,
} from '../src/store/integrity.js';
import { ensureEvidenceGuards, verifyEvidenceChain } from '../src/operator/evidence.js';
import {
  assessHqBackupCandidate,
  reliabilitySchemaPresent,
} from '../src/application/reliability-command.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';

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

  /**
   * Wave 5 Critical 1, at the DERIVATION rather than at the facade.
   *
   * The facade now appends `worker_report` for a late statement, so no path in
   * this repository writes an `outcome_recorded` on top of an interruption.
   * But `hq_reliability_run_events` is append-only and an APPEND is exactly
   * the write its triggers permit, so a raw connection can still put one
   * there — and if the derivation concluded on it, `needsReconciliation` would
   * go false, the `openRun` guard would lift, and a second attempt generation
   * on the same task would become reachable without any human. The rule is
   * therefore in `deriveRunRecord` and not only in the writer.
   */
  it('does not let a RAW outcome_recorded conclude a run standing at needs_reconciliation', () => {
    const fx = fileFixture({ processIdentity: 'process-one' });
    try {
      const run = openedRun(fx, 'the interrupted run');
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      const other = fx.reopen('the-recovering-process');
      expectOk(other.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      expect(fx.ops.getRun(run.id)!.needsReconciliation).toBe(true);

      const raw = fx.raw();
      raw
        .prepare(
          `INSERT INTO hq_reliability_run_events (id, run_id, kind, actor, at, process_id, detail, attempt_key)
           VALUES (?, ?, 'outcome_recorded', 'a-forged-actor', '2026-01-01T00:00:00.000Z', 'p9', ?, NULL)`,
        )
        .run('forged-outcome', run.id, JSON.stringify({ outcome: 'succeeded', failureCategory: 'none' }));

      const after = fx.ops.getRun(run.id)!;
      expect(after.state).toBe('needs_reconciliation');
      expect(after.outcome).toBe('outcome_unknown');
      expect(after.needsReconciliation).toBe(true);
      expect(after.admitsAttempt).toBe(false);
      // Carried as what it is: a statement somebody appended, not a verdict.
      expect(after.workerReport).toMatchObject({ by: 'a-forged-actor', outcome: 'succeeded' });
      // And the guard the whole exploit runs through is still standing.
      const second = fx.ops.openRun({
        taskId: fx.claim.taskId,
        workerId: 'claude',
        fence: fx.claim.fence,
        runKind: 'external_action',
        label: 'the interrupted run',
        idempotencyKey: 'a-deliberately-fresh-one',
      });
      expect(second.ok).toBe(false);
      // `run_state_conflict` since the three-lane merge, which added an EARLIER
      // `openRun` guard against a task carrying an unreconciled run; before it,
      // the in-reservation guard answered `run_attempt_refused`. Same
      // categorical refusal, same standing run named, and the property this
      // test pins — a raw `outcome_recorded` does not lift the guard — is
      // unchanged.
      expect(!second.ok && second.error.code).toBe('run_state_conflict');
      expect(!second.ok && second.error.details!.runId).toBe(run.id);
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
    // Only the entries whose BASE actually includes `no_rewrite`, because the
    // list gained one whose base is reduced: `hq_mission_plan_items` is
    // legitimately updated and declares `requiredGuards` instead (both Wave 5
    // correction lanes reached this, as Medium 3 and Medium 6). The
    // whole-schema check moved to the next tests, which are strictly stronger
    // than this one was.
    const listed = ENGINE_IMMUTABLE_TABLES.filter((entry) =>
      (entry.requiredGuards ?? REQUIRED_IMMUTABILITY_GUARDS).includes('no_rewrite'),
    )
      .map((entry) => entry.triggerPrefix)
      .sort();
    // Every table with a `no_rewrite` guard is on the list. A future phase that
    // adds an append-only ledger and forgets to list it fails HERE, rather than
    // silently escaping the integrity check forever.
    expect(declared).toEqual(listed);
    // A REDUCED base is a deliberate, named exception, never a quiet omission
    // (Wave 5 Medium 3), and this assertion exists to force a reviewer to see a
    // new one. It saw this one: `hq_missions` joined the list in Wave 5
    // correction round four (High H2), because Phase 14 derives a task's
    // project ceiling through `hq_missions.project_id` while the table was
    // absent from the census entirely — `DELETE FROM hq_missions` unbound every
    // task from every mission and project ceiling with no finding anywhere. Its
    // base is reduced for the same reason `hq_mission_plan_items`' is: status,
    // project link and `updated_at` legitimately move through the facade, so a
    // blanket `no_rewrite` would break every real writer. What is write-once is
    // the row's EXISTENCE and its identity.
    expect(
      ENGINE_IMMUTABLE_TABLES.filter((entry) => entry.requiredGuards).map((entry) => ({
        table: entry.table,
        requiredGuards: [...entry.requiredGuards!],
      })),
    ).toEqual([
      { table: 'hq_mission_plan_items', requiredGuards: ['no_erase', 'no_replace'] },
      { table: 'hq_missions', requiredGuards: ['no_erase', 'no_replace'] },
    ]);
    expect(declared).not.toContain('hq_missions');
    expect(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table)).toContain('hq_missions');
    // And the one reduced-base entry is there for the stated reason, not by
    // accident: it carries no `no_rewrite` guard at all, and it IS listed
    // (the other lane's assertion, kept — being unlisted was the defect).
    expect(declared).not.toContain('hq_mission_plan_items');
    expect(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table)).toContain('hq_mission_plan_items');
    db.close();
  });

  /**
   * Both Wave 5 correction lanes reached this finding (one as High 1, one as
   * Medium 2). The census used to check the trio only, so the SECONDARY guards
   * — including `trg_hq_reliability_run_events_no_replace_attempt`, the
   * cross-process duplicate-attempt guard the module's own comment calls load-
   * bearing — could be dropped with no finding at all. This pins the FULL
   * trigger-name set for every listed PREFIX, so a guard a future phase adds
   * and forgets to declare fails here rather than escaping the check. The
   * companion test below pins the same declaration by TABLE, which is the
   * complementary direction: this one catches a guard named under a listed
   * prefix, that one catches a guard on a listed table whatever it is named.
   */
  it('lists every guard each of those tables actually declares, not just the trio', () => {
    const db = openMemoryHqDatabase();
    void new HeadquarterOperations(db);
    const live = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]
    ).map((row) => row.name);
    for (const entry of ENGINE_IMMUTABLE_TABLES) {
      const onFile = live.filter((name) => name.startsWith(`trg_${entry.triggerPrefix}_`)).sort();
      expect([...declaredGuardsFor(entry)].sort(), entry.table).toEqual(onFile);
    }
    db.close();
  });

  /**
   * The same declaration, pinned by TABLE rather than by trigger-name prefix,
   * so a guard attached to a listed table under some other naming is caught
   * too.
   *
   * The drift argument that justified leaving the secondary guards out is
   * answered here rather than by leaving them unchecked: a phase that adds a
   * guard and does not DECLARE it fails this test, which is exactly where a
   * maintenance mistake should surface.
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
    //
    // EXTENDED, not relaxed, in Wave 5 correction round thirteen (High 3). The
    // schema gained a second declared class — write-once IDENTITY guards on
    // tables that are legitimately updated and are therefore not append-only
    // ledgers, `op_tasks` being the only member. The assertion is still that
    // the live trigger set EQUALS the union of the DECLARATIONS; the union just
    // has two terms now, so a guard on a table nobody declared is still a test
    // failure, in either class.
    //
    // EXTENDED again in Wave 5 correction round fourteen (High 2): a write-once
    // identity table declares its identity guard AND, where the file gives it a
    // secondary unique index, the derived `no_unique_reentry` guard beside it.
    // `declaredGuardsForIdentityTable` is the whole declaration for that class,
    // so this side of the equality reads it rather than the single-guard
    // accessor it used to — the assertion is unchanged and still an EQUALITY.
    const liveTriggers = triggers.map((row) => row.name).sort();
    const declaredTriggers = [
      ...ENGINE_IMMUTABLE_TABLES.flatMap((entry) => declaredGuardsFor(entry)),
      ...WRITE_ONCE_IDENTITY_TABLES.flatMap((entry) => declaredGuardsForIdentityTable(entry)),
    ].sort();
    expect(liveTriggers).toEqual(declaredTriggers);
    // And the two classes are disjoint: an identity guard on a table that is
    // also a declared ledger would be declared twice and censused twice.
    const ledgerTables = new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table));
    expect(WRITE_ONCE_IDENTITY_TABLES.filter((entry) => ledgerTables.has(entry.table))).toEqual([]);
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

  /**
   * The other side of the same coin, and the one that was missing (Wave 5
   * correction round three, High A1). Absence is not tampering on a file that
   * never had the ledger — but on a file that HQ has already ensured, a
   * declared ledger that is gone is exactly tampering, and the census skipped it
   * silently: dropping seven of them left both the structural pass and the FULL
   * assessment reporting a completely clean store with zero observations, while
   * the facade's own ensures recreated each one EMPTY.
   */
  it('reports a DROPPED declared ledger, and does not mistake a first boot for one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-dropped-ledger-'));
    try {
      const dbPath = path.join(dir, 'hq.sqlite');
      const first = openHqDatabase(dbPath);
      // A FIRST construction, where every phase's ledger is legitimately absent
      // before the ensures create it. This must NOT be a finding, or every new
      // database would boot into safe mode.
      const born = new HeadquarterOperations(first);
      expect(born.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(born.hqReliabilityPosture().integrity.observations.map((o) => o.finding)).toEqual([]);
      first.close();

      const raw = new Database(dbPath);
      for (const table of [
        'hq_action_intents',
        'hq_action_events',
        'hq_truth_records',
        'hq_truth_verifications',
        'hq_truth_acceptances',
        'hq_memory',
        'hq_intel_budgets',
      ]) {
        raw.exec(`DROP TABLE ${table}`);
      }
      raw.close();

      const reopened = openHqDatabase(dbPath);
      const ops = new HeadquarterOperations(reopened);
      const integrity = ops.hqReliabilityPosture().integrity;
      expect(integrity.safeMode).toBe(true);
      expect(integrity.observations.map((o) => o.finding)).toContain('append_only_guard_missing');
      const detail = integrity.observations.find((o) => o.finding === 'append_only_guard_missing')!.detail;
      // The reader is told a LEDGER went missing, not that three triggers did.
      expect(detail).toContain('hq_truth_records');
      expect(detail).toContain('hq_intel_budgets');
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The sharpest form of the same drop: the ledger that HOLDS the safe-mode
   * latch. Dropping it erased a latched verdict outright, and `releaseKillSwitch`
   * was then admitted while the evidence chain was still broken.
   */
  it('re-engages, and re-latches, when the VERDICT ledger itself is dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-dropped-verdicts-'));
    try {
      const dbPath = path.join(dir, 'hq.sqlite');
      const first = openHqDatabase(dbPath);
      void new HeadquarterOperations(first);
      first.close();
      const raw = new Database(dbPath);
      raw.exec('DROP TABLE hq_reliability_verdicts');
      raw.close();
      const reopened = openHqDatabase(dbPath);
      const ops = new HeadquarterOperations(reopened);
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      // And it is DURABLE: the boot wrote the blocking verdict into the ledger
      // it had just been handed back, so a further restart still refuses.
      reopened.close();
      const again = openHqDatabase(dbPath);
      const restarted = new HeadquarterOperations(again);
      expect(restarted.hqReliabilityPosture().integrity.safeMode).toBe(true);
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires exactly the trio by default, and the rest per table', () => {
    // The universal DEFAULT is unchanged: requiring `no_replace_unique` of a
    // table with no secondary unique index would be a false finding, and a
    // table whose own columns are legitimately updated declares a reduced base
    // rather than being left out of the census entirely (Wave 5 Medium 3).
    expect([...REQUIRED_IMMUTABILITY_GUARDS]).toEqual(['no_rewrite', 'no_erase', 'no_replace']);
    expect(
      declaredGuardsFor({
        table: 'hq_mission_plan_items',
        triggerPrefix: 'hq_mission_plan_items',
        requiredGuards: ['no_erase', 'no_replace'],
        secondaryGuards: ['no_relink', 'no_respec'],
      }),
    ).toEqual([
      'trg_hq_mission_plan_items_no_erase',
      'trg_hq_mission_plan_items_no_replace',
      'trg_hq_mission_plan_items_no_relink',
      'trg_hq_mission_plan_items_no_respec',
      // The UNIVERSAL guards, which every declared ledger carries whatever its
      // base is (Wave 5 correction round thirteen, High 1; round fourteen,
      // High 1 and Medium 2). They are appended by `declaredGuardsFor` rather
      // than listed per table precisely so a reduced base cannot omit them —
      // the reduced base is what let this entry out of `no_rewrite`, and the
      // rowid channel is not a column. The set grew from one name to three when
      // the round-fourteen review found that "may not enter ABOVE the top" was
      // one of three spellings of the same question: `no_rowid_reseat` closes a
      // row entering AT OR BELOW the top (rowid 0, −1, a hole refill), and
      // `no_rowid_move` closes a row changing position without entering at all.
      'trg_hq_mission_plan_items_no_rowid_skip',
      'trg_hq_mission_plan_items_no_rowid_reseat',
      'trg_hq_mission_plan_items_no_rowid_move',
    ]);
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
      'trg_hq_intel_budgets_no_rowid_skip',
      'trg_hq_intel_budgets_no_rowid_reseat',
      'trg_hq_intel_budgets_no_rowid_move',
    ]);
    // And the universal guardS are universal by CONSTRUCTION: all three are on
    // every entry's declaration, taken from the declaration itself rather than
    // from any list written here. The assertion iterates
    // `LEDGER_ROWID_GUARDS` — the declaration of WHICH guards are universal —
    // so a fourth spelling added tomorrow is checked here without this line
    // being touched.
    expect(
      ENGINE_IMMUTABLE_TABLES.filter((entry) =>
        LEDGER_ROWID_GUARDS.some(
          (guard) => !declaredGuardsFor(entry).includes(`trg_${entry.triggerPrefix}_${guard}`),
        ),
      ).map((entry) => entry.table),
    ).toEqual([]);
    expect([...LEDGER_ROWID_GUARDS]).toContain(LEDGER_ROWID_GUARD);
    expect(
      ENGINE_IMMUTABLE_TABLES.filter((entry) => entry.secondaryGuards.length > 0).map(
        (entry) => entry.table,
      ),
    ).toContain('hq_intel_budgets');
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
      // Both depths, because the census feeds both. The chain verifier is a
      // REQUIRED argument on the merged `fullIntegrity` (the other correction
      // lane's Medium 5: an absent verifier used to read as a passing chain
      // while the report still said `depth: 'full'`), so this call supplies a
      // real one rather than relying on the old optional parameter. The
      // assertion is unchanged — safe mode is engaged by the census, not by
      // the chain.
      expect(structuralIntegrity(raw).safeMode).toBe(true);
      expect(
        fullIntegrity(raw, { verifyEvidenceChain: () => verifyEvidenceChain(raw) }).safeMode,
      ).toBe(true);
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
      // A REAL HQ store, not a bare migrated file. `op_evidence` now carries
      // the same append-only guard trio every other engine-immutable ledger
      // does (Wave 5 correction round three, High A2), and — like every other
      // declared guard — those triggers are installed by the facade's ensure
      // pass rather than by `migrateHqDatabase`, so that a dropped one is
      // OBSERVED before it is repaired. A handle that has never been through a
      // construction therefore genuinely does not carry the guards HQ declares,
      // and `structuralIntegrity` says so. Constructing the facade first is the
      // stronger fixture as well as the honest one: the durability finding is
      // now asserted against a store that is otherwise completely healthy.
      void new HeadquarterOperations(db);
      db.pragma('synchronous = NORMAL');
      const report = structuralIntegrity(db);
      const finding = report.observations.find((o) => o.finding === 'durability_below_requirement');
      expect(finding).toBeTruthy();
      expect(finding!.blocking).toBe(false);
      expect(report.safeMode).toBe(false);
      // And nothing else was found at all: the degraded pragma is the ONLY
      // observation, so this pins "reported, not blocking" against a store with
      // no competing finding to hide behind.
      expect(report.observations.map((o) => o.finding)).toEqual(['durability_below_requirement']);
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
  /**
   * The mirror image, and a fabrication in the direction of ALARM (Wave 5
   * correction round three, Medium A5). `synchronous` is a connection pragma
   * that SQLite stores nothing about in the file, and `openHqDatabaseReadOnly`
   * — which IS the `hq:snapshot` open — never set it. So the writer read
   * `synchronous: 2` and the snapshot read `1`, and every world-readable
   * snapshot of a perfectly healthy WAL + FULL store published
   * `durabilityMeetsRequirement: false` plus a `durability_below_requirement`
   * finding about a defect that was not there — which also made a genuine
   * degradation permanently indistinguishable from the noise.
   */
  it('reports a HEALTHY store as healthy through the read-only snapshot open', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-snapshot-durability-'));
    try {
      const dbPath = path.join(dir, 'hq.sqlite');
      const built = openHqDatabase(dbPath);
      const writer = new HeadquarterOperations(built);
      const writerPosture = writer.hqReliabilityPosture().integrity.durability;
      expect(writerPosture.meetsRequirement).toBe(true);
      built.close();

      const readOnly = openHqDatabaseReadOnly(dbPath);
      const ops = new HeadquarterOperations(readOnly);
      const posture = ops.hqReliabilityPosture().integrity;
      // The same posture the writer reports, on an untampered store.
      expect(posture.durability.journalMode).toBe(writerPosture.journalMode);
      expect(posture.durability.synchronous).toBe(writerPosture.synchronous);
      expect(posture.durability.readonly).toBe(true);
      expect(posture.durability.meetsRequirement).toBe(true);
      expect(posture.observations.map((o) => o.finding)).not.toContain(
        'durability_below_requirement',
      );
      expect(posture.safeMode).toBe(false);
      const published = ops.reliabilitySummary();
      expect(published.durabilityMeetsRequirement).toBe(true);
      expect(published.findings.durability_below_requirement).toBeUndefined();
      expect(published.safeMode).toBe(false);
      readOnly.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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
    // `append_only_ledger_truncated` was added by the Wave 5 correction round
    // six: rows HQ appended are no longer in the file, which is a statement
    // about HQ's own record being false — the module header's test for what
    // blocks.
    expect([...SAFE_MODE_BLOCKING_FINDINGS]).toEqual([
      'database_integrity_check_failed',
      'append_only_guard_missing',
      'append_only_ledger_truncated',
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
      const raw = fx.raw();
      const entry = raw.prepare(`SELECT id FROM op_evidence ORDER BY seq LIMIT 1`).get() as {
        id: string;
      };
      // STRONGER than what this test used to do, because the behaviour it
      // pinned changed for the better (Wave 5 correction round three, High A2).
      // `op_evidence` used to carry no triggers at all — "its guarantee is the
      // chain rather than the engine" — so this raw UPDATE simply succeeded.
      // The engine now refuses it outright, which is the first of the three
      // things that hold the log, and the tamperer has to remove the guard
      // before it can rewrite anything.
      expect(() =>
        raw.prepare(`UPDATE op_evidence SET payload = ? WHERE id = ?`).run('{"tampered":true}', entry.id),
      ).toThrow(/append-only/);
      raw.exec('DROP TRIGGER trg_op_evidence_no_rewrite');
      raw.prepare(`UPDATE op_evidence SET payload = ? WHERE id = ?`).run('{"tampered":true}', entry.id);
      const report = fullIntegrity(fx.db, {
        verifyEvidenceChain: () => fx.ops.queue.evidence.verifyChain(),
      });
      expect(report.depth).toBe('full');
      expect(report.safeMode).toBe(true);
      expect(report.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      // And the removal of the guard is itself a finding now, because
      // `op_evidence` is a declared engine-immutable ledger: the two checks are
      // independent, so neither one alone is the whole defence.
      expect(report.observations.map((o) => o.finding)).toContain('append_only_guard_missing');
      expect(missingImmutabilityGuards(fx.db)).toContain('trg_op_evidence_no_rewrite');
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The deletion half, which the chain could not see at all (Wave 5 correction
   * round three, High A2). Walking the links from the genesis value forward
   * proves the entries PRESENT link to one another and says nothing about where
   * the chain was supposed to END, so `DELETE FROM op_evidence WHERE seq > 1`
   * left a log that verified perfectly and a full assessment that read clean.
   */
  it('refuses a tail deletion by engine, and DETECTS one taken after the guard is dropped', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      const before = (raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }).n;
      expect(before).toBeGreaterThan(1);
      // First: the engine refuses it.
      expect(() => raw.exec('DELETE FROM op_evidence WHERE seq > 1')).toThrow(/append-only/);
      expect((raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }).n).toBe(before);
      // Then: with the guard removed, the deletion goes through — and the
      // AUTOINCREMENT high-water mark SQLite maintains, which a DELETE does not
      // lower, contradicts it. The links all still hold; the LENGTH does not.
      raw.exec('DROP TRIGGER trg_op_evidence_no_erase');
      raw.exec('DELETE FROM op_evidence WHERE seq > 1');
      expect((raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }).n).toBe(1);
      expect(verifyEvidenceChain(fx.db)).toBe(2);
      const report = fullIntegrity(fx.db, { verifyEvidenceChain: () => verifyEvidenceChain(fx.db) });
      expect(report.safeMode).toBe(true);
      expect(report.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The whole log, removed as DDL. `DROP TABLE` is refused by no BEFORE trigger,
   * and the guard census used to SKIP a declared table that was absent — so
   * `DROP TABLE op_evidence` produced a completely clean structural pass and a
   * completely clean full assessment, while the next `openHqDatabase` recreated
   * the table empty.
   */
  it('engages safe mode when the evidence log itself is DROPPED and silently recreated', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      fx.db.close();
      const raw = new Database(dbPath);
      raw.exec('DROP TABLE op_evidence');
      raw.close();
      const reopened = openHqDatabase(dbPath);
      // `migrateHqDatabase` recreates the TABLE — it is foundation DDL — but
      // not the guards, which are a facade ensure, so the loss is visible at
      // the boot observation rather than laundered by the rebuild.
      const ops = new HeadquarterOperations(reopened);
      const posture = ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.map((o) => o.finding)).toContain(
        'append_only_guard_missing',
      );
      reopened.close();
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The inversion the first-boot discriminator left open: MORE damage bought
   * LESS detection (Wave 5 correction round four, High 1).
   *
   * The discriminator read "does this file still carry an ensure-created
   * declared ledger", so dropping SEVEN of them was reported (the test above)
   * and dropping ALL of them emptied the set, read as a first boot, and
   * returned a completely silent census at BOTH depths — while the workers,
   * capabilities, principals, tasks, approvals and kill switch were all still
   * there and `releaseKillSwitch` was handed back.
   */
  it('reports EVERY declared ledger dropped, so widening the attack does not buy silence', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      fx.db.close();
      const raw = new Database(dbPath);
      raw.exec('PRAGMA foreign_keys = OFF');
      const present = new Set(
        (
          raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      let dropped = 0;
      for (const entry of ENGINE_IMMUTABLE_TABLES) {
        if (!present.has(entry.table)) continue;
        raw.exec(`DROP TABLE ${entry.table}`);
        dropped += 1;
      }
      // Every one of them, `op_evidence` included — the widest form of the
      // attack, not a subset.
      expect(dropped).toBe(ENGINE_IMMUTABLE_TABLES.length);
      // And the operational half survives, which is the whole point of the
      // attack: there is authority left in the file to smuggle past safe mode.
      expect((raw.prepare(`SELECT COUNT(*) AS n FROM hq_specialists`).get() as { n: number }).n)
        .toBeGreaterThan(0);
      expect(
        (raw.prepare(`SELECT COUNT(*) AS n FROM hq_human_principals`).get() as { n: number }).n,
      ).toBeGreaterThan(0);
      raw.close();

      const reopened = openHqDatabase(dbPath);
      // The mark HQ leaves in the database header survives `DROP TABLE`, so the
      // file is still read as one HQ has ensured before.
      expect(observeImmutabilityAsFound(reopened).established).toBe(true);
      expect(establishedImmutableTables(reopened)).toEqual([]);
      expect(hqSchemaEnsuredMarkPresent(reopened)).toBe(true);
      const ops = new HeadquarterOperations(reopened);
      const posture = ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      const finding = posture.integrity.observations.find(
        (o) => o.finding === 'append_only_guard_missing',
      );
      expect(finding).toBeDefined();
      // Named, so the Founder is told which ledgers went missing.
      expect(finding!.detail).toContain('hq_reliability_verdicts');
      expect(finding!.detail).toContain('hq_intel_budgets');
      expect(finding!.detail).toContain('hq_truth_records');
      // `op_evidence` TOO, and this assertion exists only because of the
      // round-four RECONCILIATION. Neither lane reported it here alone: the
      // lane that wrote this test fixed the discriminator but left
      // `op_evidence` invisible to the census (the migration re-creates it
      // before the census looks), and the lane that fixed THAT judged
      // establishment on the pre-migration ledger catalogue, which this attack
      // empties. Composed — the mark read AS OF THE MIGRATION — the audit log
      // HQ destroyed is named alongside everything else it destroyed.
      //
      // Asserted on the OBSERVATION, not on the detail string (Wave 5
      // correction round six, Medium 2). The prose assertion it replaces was
      // VACUOUS: the same detail already lists the missing GUARDS
      // `trg_op_evidence_no_erase/_no_replace/_no_rewrite`, so
      // `toContain('op_evidence')` matched whether or not the ledger itself was
      // named — deleting `|| schemaEnsuredMarkBeforeMigration(db) === true`
      // from `migrationRestoredImmutableTables`, which is the whole
      // reconciliation this comment describes, passed the full suite.
      // `tablesAbsent` is the list that reconciliation actually produces.
      expect(observeImmutabilityAsFound(reopened).tablesAbsent).toContain('op_evidence');
      expect(finding!.detail).toContain('op_evidence');
      // And the act safe mode exists to refuse is refused.
      const released = ops.releaseKillSwitch('global', 'founder');
      expect(released.ok).toBe(false);
      reopened.close();
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The other direction of the same discriminator, pinned so the fix above can
   * never be re-implemented as a content check.
   *
   * HQ's own components legitimately write rows to a brand-new file BEFORE a
   * facade is constructed over it — the specialist directory, the capability
   * registry and the human-principal registry all do, and several suites
   * compose exactly that way. "This file has rows" is therefore NOT evidence of
   * a previous boot, and reading it as such put a first construction into safe
   * mode with every declared ledger reported absent.
   */
  it('still reads a fresh file HQ has already written rows to as a first boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-first-boot-rows-'));
    try {
      const dbPath = path.join(dir, 'hq.sqlite');
      const db = openHqDatabase(dbPath);
      // Rows first, facade second — the supported composition order.
      new CapabilityRegistry(db).register({
        id: 'repo.read_status',
        description: 'Read repo/CI status',
        riskClass: 'read_only',
        sideEffect: false,
        idempotent: true,
      });
      new HeadquarterStore(db).upsertSpecialist({
        id: 'claude',
        displayName: 'Claude',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: ['repo.read_status'],
        active: true,
      });
      expect(hqSchemaEnsuredMarkPresent(db)).toBe(false);
      expect(observeImmutabilityAsFound(db).established).toBe(false);
      const ops = new HeadquarterOperations(db);
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(ops.hqReliabilityPosture().integrity.observations).toEqual([]);
      // The facade leaves the mark, so the NEXT construction is established.
      expect(hqSchemaEnsuredMarkPresent(db)).toBe(true);
      db.close();
      const reopened = openHqDatabase(dbPath);
      expect(observeImmutabilityAsFound(reopened).established).toBe(true);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * NEW at the round-four reconciliation, and it pins the seam between the two
   * lanes' fixes rather than either fix.
   *
   * `recordHqSchemaEnsured` stamps the mark at the END of a facade
   * construction. `migrationRestoredImmutableTables` asks whether the file was
   * established BEFORE its migration ran. Read the mark as it STANDS in that
   * second question and a SECOND facade over the same handle sees a mark this
   * very process just wrote, judges a brand-new store established, and reports
   * `op_evidence` as a lost ledger on a file nothing has ever happened to.
   * Executed during the merge, exactly that put nine suites into safe mode —
   * which is why the mark is recorded at migration time and read from there.
   *
   * Two facades over one handle is not a contrivance: several suites compose
   * that way, and so does every caller that hands its own store or registry to
   * a second `HeadquarterOperations`.
   */
  it('does not read its own schema mark as evidence that a fresh store lost a ledger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-second-facade-'));
    try {
      const db = openHqDatabase(path.join(dir, 'hq.sqlite'));
      // The first facade ensures the schema and stamps the mark.
      const first = new HeadquarterOperations(db);
      expect(first.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(hqSchemaEnsuredMarkPresent(db)).toBe(true);
      // The mark AS OF THE MIGRATION is still false — the file was new then.
      expect(schemaEnsuredMarkBeforeMigration(db)).toBe(false);
      // A second facade over the SAME handle, after the stamp.
      const second = new HeadquarterOperations(db);
      expect(second.hqReliabilityPosture().integrity.observations).toEqual([]);
      expect(second.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(observeImmutabilityAsFound(db).tablesAbsent).toEqual([]);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The length commitment has to survive the NEXT WRITE (Wave 5 correction
   * round four, High 2).
   *
   * The high-water comparison alone did not: it compares the largest `seq`
   * present against `sqlite_sequence`, so one further append raised the largest
   * present back to the mark and the deleted seqs simply became a hole in the
   * middle — and the links do not object, because the appended entries chained
   * from the SURVIVING tip. Executed against the previous head, a tail deletion
   * that verified as BROKEN at the instant it happened verified as CLEAN one
   * append later.
   */
  it('keeps detecting a deleted entry after a later, perfectly well-formed append', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      raw.exec('DROP TRIGGER trg_op_evidence_no_erase');
      raw.exec('DELETE FROM op_evidence WHERE seq = (SELECT MAX(seq) FROM op_evidence)');
      const tip = raw.prepare(`SELECT * FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as
        Record<string, unknown>;
      const missing = verifyEvidenceChain(fx.db);
      expect(missing).not.toBeNull();

      // One further append, formed exactly as `append()` forms one: chained
      // from the surviving tip, hashed with the same formula. Nothing about it
      // is malformed — that is the point.
      const id = 'later-entry';
      const at = new Date().toISOString();
      const payload = JSON.stringify({ ok: true });
      const hash = createHash('sha256')
        .update([tip.hash as string, id, at, '', 'hq', 'anything', payload].join('|'))
        .digest('hex');
      raw
        .prepare(
          `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, at, null, 'hq', 'anything', payload, tip.hash as string, hash);
      const seqs = (raw.prepare(`SELECT seq FROM op_evidence ORDER BY seq`).all() as {
        seq: number;
      }[]).map((row) => row.seq);
      // The high-water mark is satisfied again — the largest seq present now
      // equals it — and the seq that was deleted is still absent.
      expect(seqs).not.toContain(missing);
      expect(Math.max(...seqs)).toBe(
        (raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'op_evidence'`).get() as {
          seq: number;
        }).seq,
      );
      raw.close();

      // STRONGER than "still non-null": the same seq, because the answer is
      // "the log stops being true here" and the append did not change where.
      expect(verifyEvidenceChain(fx.db)).toBe(missing);
      const report = fullIntegrity(fx.db, { verifyEvidenceChain: () => verifyEvidenceChain(fx.db) });
      expect(report.safeMode).toBe(true);
      expect(report.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The same thing end to end, through the remedy the residual list tells the
   * Founder to run. HQ's OWN boot appends were the laundering write: a log of
   * six entries robbed of two booted with `append_only_guard_missing`, and the
   * one full assessment that is supposed to clear that finding certified the
   * robbed log as intact.
   */
  it('refuses to certify a robbed evidence log through the full assessment that clears a boot finding', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      // Real history, so the erasure removes committed audit entries rather
      // than the whole log.
      for (let i = 0; i < 3; i += 1) {
        expectOk(
          fx.ops.createTask({
            capabilityId: CAPS.openPr,
            payload: { i },
            idempotencyKey: `history-${i}`,
            requestedBy: 'founder',
          }),
        );
      }
      fx.db.close();
      const raw = new Database(dbPath);
      const before = (
        raw.prepare(`SELECT seq FROM op_evidence ORDER BY seq`).all() as { seq: number }[]
      ).map((row) => row.seq);
      expect(before.length).toBeGreaterThan(2);
      raw.exec('DROP TRIGGER trg_op_evidence_no_erase');
      raw.exec('DELETE FROM op_evidence WHERE seq >= (SELECT MAX(seq) - 1 FROM op_evidence)');
      raw.close();

      const reopened = openHqDatabase(dbPath);
      const ops = new HeadquarterOperations(reopened);
      // The boot looks exactly like the benign one-time guard finding.
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      // The documented remedy. It must NOT clear, because the log itself is
      // short two committed entries and no later append repairs that.
      const assessed = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(assessed.safeMode).toBe(true);
      expect(assessed.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      reopened.close();
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
      const verification = verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate });
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
      // Scribble over the ROOT PAGE of a named table: still opens
      // (`sqlite_master` is page 1 and is untouched), fails `integrity_check`
      // (a page whose first byte is 0x41 is not a valid b-tree page type).
      //
      // The page is now CHOSEN from the catalogue rather than positionally.
      // This used to corrupt 2048 bytes at `size / 2`, which only hit a b-tree
      // page by luck of the schema size; it was then moved to the LAST page for
      // the same reason, and that in turn stopped being a b-tree page when this
      // wave added three triggers to `op_evidence` — at which point the
      // corruption made the catalogue itself unreadable and the refusal became
      // `not_a_readable_sqlite_database`, i.e. the test silently stopped
      // testing what it says it tests for the second time. Asking SQLite which
      // page holds `hq_events` is a choice that cannot drift with the schema.
      const size = fs.statSync(backupPath).size;
      const headerBytes = Buffer.alloc(2);
      const headerFd = fs.openSync(backupPath, 'r');
      fs.readSync(headerFd, headerBytes, 0, 2, 16);
      fs.closeSync(headerFd);
      const declared = headerBytes.readUInt16BE(0);
      // SQLite encodes a 65536-byte page as 1 in the header.
      const pageSize = declared === 1 ? 65536 : declared;
      expect(size % pageSize).toBe(0);
      // Read from the LIVE database rather than by opening the backup: SQLite's
      // online backup copies page for page, so the root pages are the same, and
      // opening the candidate here would create the very `-wal`/`-shm` sidecar
      // whose presence `verifyHqBackupFile` correctly refuses.
      const rootPage = (
        fx.db
          .prepare(`SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'hq_events'`)
          .get() as { rootpage: number }
      ).rootpage;
      expect(rootPage).toBeGreaterThan(1);
      const handle = fs.openSync(backupPath, 'r+');
      fs.writeSync(handle, Buffer.alloc(pageSize, 0x41), 0, pageSize, (rootPage - 1) * pageSize);
      fs.closeSync(handle);
      const verification = verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate });
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
      const verification = verifyHqBackupFile(fx.dbPath, { assessCandidate: assessHqBackupCandidate });
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
      const first = verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate });
      expect(first.verified).toBe(true);
      // The whole reason the checks run against a scratch COPY: opening the
      // candidate with SQLite creates `<path>-wal` and `<path>-shm` and leaves
      // them there, so a verification that opened it directly would refuse its
      // own leftovers on the next call — and would have been reading bytes its
      // digest did not cover on this one.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        expect(fs.existsSync(`${backupPath}${suffix}`), suffix).toBe(false);
      }
      const second = verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate });
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
      const cleanDigest = verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate }).digest;
      expect(cleanDigest).toHaveLength(64);
      fs.writeFileSync(`${backupPath}-wal`, Buffer.alloc(4096, 0x00));
      const withSidecar = verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate });
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
      expect(verifyHqBackupFile(raw, { assessCandidate: assessHqBackupCandidate }).refusals).toEqual(['path_not_normalized']);
      expect(verifyHqBackupFile(`${fx.dir}/sub/../headquarter.sqlite`, { assessCandidate: assessHqBackupCandidate }).refusals).toEqual([
        'path_not_normalized',
      ]);
      // And the normalized form of the same text is a different question,
      // answered on its own merits rather than by resolution.
      expect(sneaky).toBe(fx.dbPath);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The other correction lane's exploit for the same finding, ported onto the
   * surviving implementation: two candidates carried an identical
   * `contentDigest` and an identical recorded size while their verified table
   * counts differed, because the difference lived entirely in an un-digested
   * `-wal` sidecar. The refusal is `sidecar_journal_present` rather than that
   * lane's `file_has_uncheckpointed_wal` because the surviving rule is the
   * broader one — presence, not size, is what makes the main file possibly not
   * the whole database — and the CHECKPOINTED half of the exploit, which that
   * lane pinned and this one did not, is kept exactly as it was written.
   */
  it('refuses a candidate whose committed content is not all in the file it would digest', () => {
    const fx = fileFixture();
    try {
      const candidate = path.join(fx.dir, 'with-a-wal.sqlite');
      const db = openHqDatabase(candidate);
      db.exec('CREATE TABLE IF NOT EXISTS hq_events (x TEXT)');
      db.exec('CREATE TABLE later_addition (x TEXT)');
      // The append-only guards on `op_evidence`, which `openHqDatabase` alone
      // does not install — every real HQ file has them, because every facade
      // construction ensures them. Needed here since Wave 5 correction round
      // ten (High 4): `verifyHqBackupFile` now runs HQ's OWN census over the
      // copy, and a file whose audit log carries no immutability guards is
      // refused `would_latch_safe_mode` rather than verified. That refusal is
      // correct and is pinned in `backup-verification-census.test.ts`; what
      // THIS test is about is the WAL sidecar, so the candidate is made a
      // sound HQ file and the sidecar behaviour is what it still measures.
      ensureEvidenceGuards(db);
      // And the universal rowid guard, for the same reason and since the same
      // census widened (Wave 5 correction round thirteen, High 1): every real
      // HQ file carries it because every facade construction installs it, and a
      // copy that does not is correctly refused `would_latch_safe_mode`.
      ensureLedgerRowidGuards(db);
      // And the write-once identity guards, for the same reason (round
      // thirteen, High 3): the census covers them, so a copy that lacks one is
      // refused rather than verified.
      ensureWriteOnceIdentityGuards(db);
      // And the derived unique-index guard, for the same reason and since the
      // same census widened again (Wave 5 correction round fourteen, High 2):
      // `op_tasks` declares one on a live file, so a copy without it is
      // correctly refused `would_latch_safe_mode` rather than verified.
      ensureUniqueReentryGuards(db);
      // WAL mode with no checkpoint: the newest table is in the sidecar.
      expect(fs.existsSync(`${candidate}-wal`)).toBe(true);
      expect(fs.statSync(`${candidate}-wal`).size).toBeGreaterThan(0);

      const refused = verifyHqBackupFile(candidate, { assessCandidate: assessHqBackupCandidate });
      expect(refused.verified).toBe(false);
      expect(refused.refusals).toEqual(['sidecar_journal_present']);
      // No digest is published for a file HQ will not stand behind.
      expect(refused.digest).toBeNull();

      // Checkpointed and closed, the same path verifies and the digest pins
      // what was checked.
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      const accepted = verifyHqBackupFile(candidate, { assessCandidate: assessHqBackupCandidate });
      expect(accepted.verified).toBe(true);
      expect(accepted.digest).toBe(
        createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'),
      );
      expect(accepted.schemaTables).toBeGreaterThanOrEqual(2);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Wave 5 correction round three, Medium A4. The sidecar refusal is keyed on
   * the resolved PATH, so a HARD LINK to the live inode under a name with no
   * sidecars beside it verified `true` — and that "verified recovery point" was
   * recorded permanently in the append-only register while its committed
   * content demonstrably was NOT all in the bytes that had been digested.
   */
  it('refuses a hard link to the LIVE database, which the path-keyed sidecar check cannot see', () => {
    const fx = fileFixture();
    try {
      const alias = path.join(fx.dir, 'looks-like-a-backup.sqlite');
      fs.linkSync(fx.dbPath, alias);
      // Same inode, and no `-wal` beside THIS name, which is exactly why the
      // sidecar refusal had nothing to say about it.
      expect(fs.statSync(alias).ino).toBe(fs.statSync(fx.dbPath).ino);
      expect(fs.existsSync(`${alias}-wal`)).toBe(false);
      expect(fs.existsSync(`${fx.dbPath}-wal`)).toBe(true);

      const verification = verifyHqBackupFile(alias, { assessCandidate: assessHqBackupCandidate });
      expect(verification.verified).toBe(false);
      expect(verification.refusals).toEqual(['file_has_multiple_links']);
      // Nothing is published about a file HQ will not stand behind.
      expect(verification.digest).toBeNull();
      expect(verification.schemaTables).toBeNull();

      // And the register refuses to record it as a recovery point.
      const refusal = fx.ops.recordVerifiedBackup({ backupPath: alias, requestedBy: 'founder' });
      expect(refusal.ok).toBe(false);
      expect(!refusal.ok && refusal.error.code).toBe('backup_verification_failed');
      expect(!refusal.ok && (refusal.error.details?.refusals as string[])).toContain(
        'file_has_multiple_links',
      );
      expect(fx.ops.listVerifiedBackupsBounded().total).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a hard link even to an otherwise sound consolidated backup', async () => {
    const fx = fileFixture();
    try {
      const backupPath = path.join(fx.dir, 'hq-backup.sqlite');
      await fx.db.backup(backupPath);
      // The backup alone verifies.
      expect(verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate }).verified).toBe(true);
      // A second name for the same bytes does not: a snapshot that another name
      // can still be written through is not a snapshot.
      const alias = path.join(fx.dir, 'second-name.sqlite');
      fs.linkSync(backupPath, alias);
      expect(verifyHqBackupFile(alias, { assessCandidate: assessHqBackupCandidate }).refusals).toEqual(['file_has_multiple_links']);
      expect(verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate }).refusals).toEqual(['file_has_multiple_links']);
      // Removing the extra name restores the property, so the refusal is about
      // the file's real shape and not about its name.
      fs.unlinkSync(alias);
      expect(verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate }).verified).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * `lstat` and `O_NOFOLLOW` cover the FINAL path component only, so a
   * symlinked PARENT directory was followed silently and the register named an
   * alias as if it were the file that had been checked. Recorded rather than
   * refused — see `verifyHqBackupFile` for why refusing was rejected — so the
   * divergence is visible and the REGISTER names the file HQ actually opened.
   */
  it('records the file it actually opened when an ancestor directory is a symlink', async () => {
    const fx = fileFixture();
    try {
      const real = fs.realpathSync(path.join(fx.dir));
      const vault = path.join(real, 'vault');
      fs.mkdirSync(vault);
      const backupPath = path.join(vault, 'hq-backup.sqlite');
      await fx.db.backup(backupPath);
      const direct = verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate });
      expect(direct.verified).toBe(true);
      expect(direct.resolvedPath).toBe(backupPath);

      const link = path.join(real, 'vault-link');
      fs.symlinkSync(vault, link);
      const aliasPath = path.join(link, 'hq-backup.sqlite');
      const throughLink = verifyHqBackupFile(aliasPath, { assessCandidate: assessHqBackupCandidate });
      expect(throughLink.verified).toBe(true);
      // The divergence is stated, not swallowed.
      expect(throughLink.resolvedPath).not.toBe(aliasPath);
      expect(throughLink.resolvedPath).toBe(backupPath);
      expect(throughLink.digest).toBe(direct.digest);

      // And the register names the real file, so the alias cannot become the
      // recorded identity of a recovery point.
      const recorded = expectOk(
        fx.ops.recordVerifiedBackup({ backupPath: aliasPath, requestedBy: 'founder' }),
      );
      expect(recorded.backup.backupPath).toBe(backupPath);
      // Recording it again under the real path is the SAME recovery point.
      const again = expectOk(
        fx.ops.recordVerifiedBackup({ backupPath, requestedBy: 'founder' }),
      );
      expect(again.deduplicated).toBe(true);
      expect(again.backup.id).toBe(recorded.backup.id);
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
      expect(verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate }).verified).toBe(true);

      // A restore is a file copy plus a verification; both halves are proven
      // here rather than assumed, because a backup nobody has opened is not a
      // recovery point.
      const restoredPath = path.join(fx.dir, 'restored.sqlite');
      fs.copyFileSync(backupPath, restoredPath);
      expect(verifyHqBackupFile(restoredPath, { assessCandidate: assessHqBackupCandidate }).verified).toBe(true);
      // The restored copy is a byte-for-byte copy, and its own digest says so.
      // Asserted BEFORE the file is opened live: opening a WAL-mode database
      // for writing creates a `-wal` beside it, and a candidate carrying a
      // journal sidecar is refused rather than verified (Wave 5 review, High
      // finding 3) — an open database is not a recovery point.
      expect(verifyHqBackupFile(restoredPath, { assessCandidate: assessHqBackupCandidate }).digest).toBe(verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate }).digest);

      const restored = openHqDatabase(restoredPath);
      const ops = new HeadquarterOperations(restored, { processIdentity: 'restored-process' });
      expect(ops.getRun(run.id)!.label).toBe('recorded before the backup');
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(verifyHqBackupFile(restoredPath, { assessCandidate: assessHqBackupCandidate }).refusals).toEqual(['sidecar_journal_present']);
      restored.close();
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * Wave 5 correction round six, High 1 and High 2 — the ledger that could be
 * EMPTIED for free, and the two guarantees that fell with it.
 *
 * Round five retired one of two chain commitments to satisfy "one canonical
 * truth per domain", leaving `hq_integrity_checkpoints` as the only external
 * witness to what the evidence log used to be. That ledger is protected by
 * triggers, and `operator/evidence.ts` ALREADY documented the fact that
 * defeats them: a trigger dropped and re-created before the next boot is never
 * observed missing, because the as-found census reads `sqlite_master` at
 * construction time only. Three statements — drop the guard, DELETE, put the
 * guard back — therefore emptied the witness and produced no finding at any
 * depth, because both readers of the witness read the very rows deleted.
 *
 * The same three statements made `RUN_RETRY_STATEMENT` false on
 * `hq_reliability_run_events`, whose rows are what reserve an attempt
 * generation across processes.
 *
 * What closes both is the general form of the check `verifyEvidenceChain` has
 * always made for `op_evidence` alone: `MAX(rowid)` against the engine's own
 * `sqlite_sequence` high-water mark, which a DELETE cannot lower.
 */
describe('emptying a declared append-only ledger is a finding, however the guard is restored', () => {
  /** Drop the named ledger's `no_erase` guard, empty it, and put the guard back. */
  function eraseLedger(dbPath: string, table: string, guard = `trg_${table}_no_erase`): void {
    const raw = new Database(dbPath);
    const sql = (
      raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
        .get(guard) as { sql: string } | undefined
    )?.sql;
    expect(sql, guard).toBeTruthy();
    raw.exec(`DROP TRIGGER ${guard}`);
    raw.exec(`DELETE FROM ${table}`);
    raw.exec(sql!);
    // The guard really is back, so the census that reads the catalogue sees a
    // healthy table — which is the whole reason this attack was silent.
    expect(
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(guard),
    ).toBeDefined();
    // And the engine's mark still records rows that are no longer there.
    const mark = raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(table) as
      | { seq: number }
      | undefined;
    expect(mark!.seq).toBeGreaterThan(0);
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    raw.close();
  }

  it('reports an emptied hq_integrity_checkpoints at BOTH depths, and refuses the release', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      const run = openedRun(fx, 'work before the erasure');
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      fx.db.close();
      // One warm boot, so HQ has actually committed a checkpoint to erase.
      const warm = openHqDatabase(dbPath);
      new HeadquarterOperations(warm);
      expect(
        (
          warm
            .prepare(`SELECT COUNT(*) AS n FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`)
            .get() as { n: number }
        ).n,
      ).toBeGreaterThan(0);
      warm.close();

      eraseLedger(dbPath, HQ_INTEGRITY_CHECKPOINT_TABLE);

      const reopened = openHqDatabase(dbPath);
      const ops = new HeadquarterOperations(reopened);
      // The CHEAP depth, at the boot that opens the file.
      const boot = ops.hqReliabilityPosture().integrity;
      expect(boot.safeMode).toBe(true);
      const truncation = boot.observations.find(
        (observation) => observation.finding === 'append_only_ledger_truncated',
      );
      expect(truncation).toBeDefined();
      expect(truncation!.blocking).toBe(true);
      expect(truncation!.detail).toContain(HQ_INTEGRITY_CHECKPOINT_TABLE);
      // And the Founder's FULL assessment, which is the one path that clears a
      // latch, does not clear this one.
      const assessed = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(assessed.safeMode).toBe(true);
      expect(assessed.observations.map((observation) => observation.finding)).toContain(
        'append_only_ledger_truncated',
      );
      // The act safe mode exists to refuse is refused.
      expect(ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      reopened.close();
    } finally {
      fx.cleanup();
    }
  });

  it('keeps a spent attempt generation spent — an emptied run-event ledger is a finding, not a reset', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      const run = openedRun(fx, 'the one attempt');
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      // The guard `ENGINE_IMMUTABLE_TABLES` calls the single most load-bearing
      // secondary guard in the schema, doing its job.
      const duplicate = fx.ops.startRunAttempt({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
      });
      expect(duplicate.ok).toBe(false);
      fx.db.close();

      eraseLedger(dbPath, 'hq_reliability_run_events');

      const reopened = openHqDatabase(dbPath);
      const ops = new HeadquarterOperations(reopened, {
        policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
      });
      const boot = ops.hqReliabilityPosture().integrity;
      expect(boot.safeMode).toBe(true);
      expect(boot.observations.map((observation) => observation.finding)).toContain(
        'append_only_ledger_truncated',
      );
      // The attempt is NOT re-admitted. `RUN_RETRY_STATEMENT` says an
      // interrupted attempt is never retried automatically and that only a
      // human reconciliation opens a further generation; emptying the ledger
      // used to open one silently.
      const readmitted = ops.startRunAttempt({
        runId: run.id,
        workerId: 'claude',
        fence: fx.claim.fence,
      });
      expect(readmitted.ok).toBe(false);
      reopened.close();
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The other direction, so the fix can never be re-implemented as "any table
   * with fewer rows than its mark is a finding, and a fresh file has none".
   */
  it('says nothing about a healthy file, an untouched restart or a byte copy', async () => {
    const fx = fileFixture();
    try {
      const run = openedRun(fx, 'ordinary work');
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      expect(truncatedImmutableLedgers(fx.db)).toEqual([]);
      const copyPath = path.join(fx.dir, 'copy.sqlite');
      await fx.db.backup(copyPath);
      fx.db.close();
      const reopened = openHqDatabase(fx.dbPath);
      expect(truncatedImmutableLedgers(reopened)).toEqual([]);
      expect(new HeadquarterOperations(reopened).hqReliabilityPosture().integrity.safeMode).toBe(
        false,
      );
      reopened.close();
      // `.backup()` carries `sqlite_sequence` across, so the copy is not a
      // truncation either.
      const copied = openHqDatabase(copyPath);
      expect(truncatedImmutableLedgers(copied)).toEqual([]);
      copied.close();
      // A brand-new file has no marks at all.
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-truncation-fresh-'));
      try {
        const fresh = openHqDatabase(path.join(freshDir, 'hq.sqlite'));
        expect(truncatedImmutableLedgers(fresh)).toEqual([]);
        fresh.close();
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * Wave 5 correction round six, Medium 1 — `regressedImmutableLedgers` shipped
 * load-bearing and covered by NO test.
 *
 * Its only two assertions were `expect(regressedImmutableLedgers(raw)).toEqual([])`
 * on healthy files, which can only pass; mutating the function body to
 * `const regressed: string[] = []` passed the FULL suite. This is the attack it
 * exists for, and it is deliberately one the round-six truncation check CANNOT
 * see: a DROPPED table takes its `sqlite_sequence` row with it, so there is no
 * mark left to contradict — only HQ's own committed checkpoint remains.
 */
describe('a ledger HQ had to re-create EMPTY stays reported across restarts', () => {
  it('names it after two further boots, when no process still remembers the drop', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      const run = openedRun(fx, 'work whose record is about to be destroyed');
      expectOk(fx.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: fx.claim.fence }));
      fx.db.close();
      const warm = openHqDatabase(dbPath);
      new HeadquarterOperations(warm);
      warm.close();

      const raw = new Database(dbPath);
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.exec('DROP TABLE hq_reliability_run_events');
      // The DROP took the high-water mark with it, so the truncation check has
      // nothing to read — this really is the checkpoint's half of the census.
      expect(
        raw
          .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'hq_reliability_run_events'`)
          .get(),
      ).toBeUndefined();
      raw.close();

      // First boot: HQ re-creates the ledger EMPTY. That boot's own as-found
      // observation would report it, so the test does not stop here.
      const first = openHqDatabase(dbPath);
      new HeadquarterOperations(first);
      first.close();
      // Second boot: no process remembers the drop, the table is present, its
      // guards are complete, and the only witness left is what HQ committed.
      const second = openHqDatabase(dbPath);
      expect(observeImmutabilityAsFound(second).tablesAbsent).toEqual([]);
      expect(missingImmutabilityGuards(second)).toEqual([]);
      expect(truncatedImmutableLedgers(second)).toEqual([]);
      expect(regressedImmutableLedgers(second)).toContain('hq_reliability_run_events');
      const ops = new HeadquarterOperations(second);
      const boot = ops.hqReliabilityPosture().integrity;
      expect(boot.safeMode).toBe(true);
      const finding = boot.observations.find((o) => o.finding === 'append_only_guard_missing');
      expect(finding).toBeDefined();
      expect(finding!.detail).toContain('hq_reliability_run_events');
      // And no assessment clears it while it is true.
      const assessed = expectOk(ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(assessed.safeMode).toBe(true);
      expect(ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      second.close();
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * Wave 5 correction round six, Medium 3 — "a missing verifier is treated
 * exactly like one that threw" was a claim with no test behind it.
 *
 * The behaviour was NOT broken and the review's proposed mutation does not
 * break it — measured, not assumed. Replacing the ternary
 * `typeof options.verifyEvidenceChain === 'function' ? null : 'error'` with a
 * plain `null` leaves the guarantee standing, because the `try` below then
 * calls `undefined()`, throws, and the `catch` sets `'error'` anyway. What was
 * genuinely missing was any test at all: the claim "a missing verifier is
 * treated exactly like one that threw" was pinned by nothing, so the Wave 5
 * Medium-5 defect — an absent BLOCKING check indistinguishable from a passed
 * one, on public package API a JS caller reaches with no arguments — could
 * return without a failure anywhere. Verified to bite: making the `catch` set
 * `null` instead of `'error'` fails this test.
 */
describe('an absent evidence-chain verifier is not a passed one', () => {
  it('reports evidence_chain_broken and chainVerified=false when fullIntegrity is called with no verifier', async () => {
    // TypeScript makes the verifier a REQUIRED option; JavaScript does not, and
    // `fullIntegrity` is public package API through `@factoryos/headquarter/store`.
    // The JS caller is modelled by taking the export through the module
    // namespace, which is exactly how such a consumer reaches it — the defect
    // is the runtime behaviour, so the runtime behaviour is what is pinned.
    const namespace: Record<string, unknown> = await import('../src/store/integrity.js');
    const asJsCaller = namespace.fullIntegrity as (
      db: typeof fx.db,
      options?: Record<string, unknown>,
    ) => ReturnType<typeof fullIntegrity>;
    const fx = fileFixture();
    try {
      // The chain is genuinely intact: `verifyEvidenceChain` returns null here.
      expect(verifyEvidenceChain(fx.db)).toBeNull();
      const supplied = fullIntegrity(fx.db, {
        verifyEvidenceChain: () => verifyEvidenceChain(fx.db),
      });
      expect(supplied.safeMode).toBe(false);
      expect(supplied.chainVerified).toBe(true);

      // The SAME database, assessed with no verifier at all.
      const absent = asJsCaller(fx.db, {});
      // With NO options argument at all the call THROWS — `options` carries no
      // default, unlike `structuralIntegrity`'s. That is also not a silent
      // pass, and it is asserted so the two shapes of "no verifier" are both on
      // the record rather than one being assumed from the other.
      expect(() => asJsCaller(fx.db)).toThrow(TypeError);
      expect(absent.depth).toBe('full');
      expect(absent.chainVerified).toBe(false);
      expect(absent.safeMode).toBe(true);
      const finding = absent.observations.find((o) => o.finding === 'evidence_chain_broken');
      expect(finding).toBeDefined();
      expect(finding!.blocking).toBe(true);
      // A verifier that THREW reaches exactly the same verdict — that is the
      // claim, so both halves are asserted rather than one.
      const threw = fullIntegrity(fx.db, {
        verifyEvidenceChain: () => {
          throw new Error('the check could not run');
        },
      });
      expect(threw.chainVerified).toBe(false);
      expect(threw.safeMode).toBe(true);
      expect(threw.observations.map((o) => o.finding)).toEqual(
        absent.observations.map((o) => o.finding),
      );
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * Wave 5 correction round six, Low 3 and Low 7 — two facts that were nearly
 * true, stated and closed.
 */
describe('the two nearly-true facts about a file HQ has been in', () => {
  /**
   * Low 3. `sidecar_journal_present` refuses the LIVE database only while a
   * process holds it open: SQLite removes `-wal`/`-shm` on a clean close, so
   * between runs `verifyHqBackupFile(<the live db path>)` answered
   * `verified: true, refusals: []` and a Founder could register the database HQ
   * runs on as a verified recovery point.
   */
  it('refuses the live database as a recovery point, open or closed', async () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      // While HQ holds it open, the sidecar refusal answers.
      expect(verifyHqBackupFile(dbPath, { assessCandidate: assessHqBackupCandidate }).refusals).toEqual(['sidecar_journal_present']);
      // A genuine backup is still accepted, and is a DIFFERENT file.
      const backupPath = path.join(fx.dir, 'genuine.sqlite');
      await fx.db.backup(backupPath);
      expect(verifyHqBackupFile(backupPath, { assessCandidate: assessHqBackupCandidate }).verified).toBe(true);
      expectOk(fx.ops.recordVerifiedBackup({ backupPath, requestedBy: 'founder' }));

      // The live path is refused through the facade even while it is open,
      // because the facade names the live handle rather than relying on shape.
      const openRefusal = fx.ops.recordVerifiedBackup({ backupPath: dbPath, requestedBy: 'founder' });
      expect(openRefusal.ok).toBe(false);
      expect(!openRefusal.ok && openRefusal.error.code).toBe('backup_verification_failed');

      fx.db.close();
      // Closed: no sidecars remain, and the bare verification really does pass.
      // That is the fact the previous wording denied, so it is asserted rather
      // than glossed.
      expect(verifyHqBackupFile(dbPath, { assessCandidate: assessHqBackupCandidate }).verified).toBe(true);
      // With the live handle named, it is refused — and through an alias for
      // the same file, because both sides are resolved.
      const reopened = openHqDatabase(dbPath);
      const ops = new HeadquarterOperations(reopened);
      expect(verifyHqBackupFile(dbPath, { liveDatabasePath: dbPath, assessCandidate: assessHqBackupCandidate }).refusals).toEqual([
        'candidate_is_the_live_database',
      ]);
      const aliased = path.join(fx.dir, '.', path.basename(dbPath));
      expect(
        verifyHqBackupFile(path.normalize(aliased), { liveDatabasePath: dbPath, assessCandidate: assessHqBackupCandidate }).refusals,
      ).toEqual(['candidate_is_the_live_database']);
      const refused = ops.recordVerifiedBackup({ backupPath: dbPath, requestedBy: 'founder' });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error.code).toBe('backup_verification_failed');
      expect(!refused.ok && (refused.error.details as { refusals: string[] }).refusals).toEqual([
        'candidate_is_the_live_database',
      ]);
      reopened.close();
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Low 7. `migrateHqDatabase` recorded the pre-migration mark as ANY non-zero
   * `user_version` while `hqSchemaEnsuredMarkPresent` read a CLOSED set, so a
   * foreign application's `user_version = 7` made the two readings of "HQ has
   * been here" DISAGREE. The outer `established` gate absorbed it, so it was
   * not exploitable at that head — which is precisely why it needed closing
   * before a refactor made it so.
   */
  it('reads a FOREIGN user_version as somebody else’s stamp in BOTH readings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-foreign-mark-'));
    try {
      const dbPath = path.join(dir, 'foreign.sqlite');
      const foreign = new Database(dbPath);
      foreign.exec(`PRAGMA user_version = 7`);
      foreign.exec(`CREATE TABLE somebody_elses_table (id TEXT PRIMARY KEY)`);
      foreign.close();

      const db = openHqDatabase(dbPath);
      // Both readings agree, and both say "not HQ's mark".
      expect(schemaEnsuredMarkBeforeMigration(db)).toBe(false);
      expect(hqSchemaEnsuredMarkPresent(db)).toBe(false);
      // And a first construction over it is still silent, which is the
      // behaviour the closed set was introduced to protect.
      const ops = new HeadquarterOperations(db);
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(ops.hqReliabilityPosture().integrity.observations).toEqual([]);
      // HQ has now stamped its OWN mark, so both readings flip together on the
      // next open.
      expect(hqSchemaEnsuredMarkPresent(db)).toBe(true);
      db.close();
      const second = openHqDatabase(dbPath);
      expect(schemaEnsuredMarkBeforeMigration(second)).toBe(true);
      expect(hqSchemaEnsuredMarkPresent(second)).toBe(true);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Wave 5, correction round twelve — Low 3: the page's own count of the backup
 * guard's refusals was short, and its count of the exercised ones was short of
 * that.
 *
 * The paragraph said thirteen and omitted `file_has_multiple_links` and
 * `candidate_is_the_live_database` from the list it wrote out — both added by
 * this wave, neither picked up by the prose. Nothing compared either number to
 * anything, which is the same reason the cost clause went wrong three times.
 * Both are compared here, against `BACKUP_REFUSAL_REASONS` itself rather than
 * against a figure typed into this file: the constant reached seventeen at the
 * merge with the concurrent round-eleven lane, which added
 * `candidate_census_unavailable`, and this test caught the drift with no edit —
 * which is exactly what it was written to do.
 *
 * **This paragraph nevertheless went stale itself, twice, in exactly the way it
 * was written to stop** (Wave 5 correction round thirteen, Low 1). It said the
 * constant held fifteen with twelve exercised; the round-ten merge had already
 * taken it to sixteen with thirteen, and the round-eleven merge above took it to
 * seventeen. The tests derive their assertions from the constant, so nothing was
 * ever unpinned — only the prose describing them was false, which is the same
 * artifact-versus-behaviour gap the whole file exists to close. So the two
 * numbers this paragraph states are no longer free-standing claims either: the
 * third test below parses them back out of this very docblock and compares them
 * to the constant and to the sweep. As measured at this head, the constant holds
 * SEVENTEEN and FOURTEEN are exercised — and that second number is a third
 * value in as many merges, which is precisely why it is asserted rather than
 * written down: the pin caught the drift at the merge, with no edit.
 */
const HERE_FOR_PHASE_13 = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test files whose job is to COUNT refusals rather than to induce them.
 *
 * The docblock below explains why comments are stripped: a reason written
 * ABOUT is not a reason exercised. The merge of the two correction lanes turned
 * up the same hazard one level in, in code rather than in prose. The other
 * lane's `backup-refusal-vocabulary.test.ts` asserts the identity of the
 * UNEXERCISED set, which it can only do by writing those three names out as
 * quoted literals — and a sweep that counted them reported all seventeen as
 * exercised, including `file_too_large`, which would need a two-gigabyte file
 * that no test in this package writes. Excluding the censuses keeps both lanes'
 * sweeps measuring the one real property, and both lanes' assertions pass
 * against it.
 */
const REFUSAL_CENSUS_FILES: readonly string[] = Object.freeze([
  'backup-refusal-vocabulary.test.ts',
]);

describe('the page’s count of the backup guard’s refusals is the constant’s count', () => {
  const PHASE_13_PAGE = path.join(
    HERE_FOR_PHASE_13,
    '..',
    '..',
    '..',
    'docs',
    'HEADQUARTER',
    'PHASE_13_ADVANCED_RELIABILITY.md',
  );

  const NUMBER_WORDS: Record<string, number> = {
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
  };

  /**
   * Which reasons any test in this package actually induces.
   *
   * Comments are stripped first, and it matters: this file's own docblock names
   * two reasons in backticks, and a sweep that counted those would report a
   * reason as exercised because somebody wrote about it. Only a quoted string
   * in code counts — which is how a test names the refusal it expects.
   */
  function exercised(): string[] {
    const dir = HERE_FOR_PHASE_13;
    const found = new Set<string>();
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.test.ts')) continue;
      // See `REFUSAL_CENSUS_FILES`: a file that names a reason in order to
      // assert about it has not exercised it.
      if (REFUSAL_CENSUS_FILES.includes(entry)) continue;
      const text = fs
        .readFileSync(path.join(dir, entry), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const reason of BACKUP_REFUSAL_REASONS) {
        if (new RegExp(`['"]${reason}['"]`).test(text)) found.add(reason);
      }
    }
    return [...found].sort();
  }

  it('states the number of refusals the constant holds, and names every one', () => {
    const page = fs.readFileSync(PHASE_13_PAGE, 'utf8');
    const match = /(\w+) categorical\s*\n?refusals, never an exception/.exec(page);
    expect(match, 'the page must state how many categorical refusals there are').toBeTruthy();
    expect(NUMBER_WORDS[match![1]!.toLowerCase()]).toBe(BACKUP_REFUSAL_REASONS.length);
    // The count alone was right about a list nobody could see, so the list is
    // checked too — that is how two reasons went unnamed for a whole wave.
    for (const reason of BACKUP_REFUSAL_REASONS) {
      expect(page, `the page must name the refusal ${reason}`).toContain(`\`${reason}\``);
    }
  });

  /**
   * EVERY place the page states the pair, not the one phrasing this regex was
   * first written for (Wave 5 correction round thirteen, Medium 3).
   *
   * Round twelve added this pin and it read `"<n> of the <m> are exercised"`.
   * A SECOND sentence on the same page said "ten of the thirteen backup path
   * protections are all exercised", and it went on saying it after the constant
   * moved to sixteen and the exercised set to thirteen, because no regex
   * reached it. A pin that reads one phrasing of a claim is the same partial
   * enumeration this whole correction round is about, so the sweep below finds
   * every `"<number word> of the <number word>"` on the page whose sentence is
   * about these refusals and checks BOTH halves of each.
   */
  it('states how many are exercised, and names the ones that are not', () => {
    const page = fs.readFileSync(PHASE_13_PAGE, 'utf8');
    const driven = exercised();
    const notDriven = BACKUP_REFUSAL_REASONS.filter((reason) => !driven.includes(reason));

    // Any `"<number word> of the <number word>"` whose sentence goes on to say
    // those refusals are exercised. Written as a general sweep rather than as
    // the two phrasings this page happens to use today: the concurrent
    // round-thirteen lane changed one of them from "backup path protections" to
    // "backup refusals" while raising both constants, and a regex written
    // around a phrasing would have stopped reading it.
    const pairs = [...page.matchAll(/(\w+) of the (\w+)\b/g)].filter((pair) => {
      if (NUMBER_WORDS[pair[1]!.toLowerCase()] === undefined) return false;
      if (NUMBER_WORDS[pair[2]!.toLowerCase()] === undefined) return false;
      return /exercis/i.test(page.slice(pair.index!, pair.index! + 200));
    });
    expect(pairs.length, 'the page must state the exercised/total pair at least once').toBeGreaterThan(
      0,
    );
    for (const pair of pairs) {
      expect(NUMBER_WORDS[pair[1]!.toLowerCase()], `"${pair[0]}" — exercised count`).toBe(driven.length);
      expect(NUMBER_WORDS[pair[2]!.toLowerCase()], `"${pair[0]}" — total count`).toBe(
        BACKUP_REFUSAL_REASONS.length,
      );
    }
    const match = pairs[0];
    expect(match, 'the page must state how many refusals are exercised').toBeTruthy();
    expect(NUMBER_WORDS[match![1]!.toLowerCase()]).toBe(driven.length);
    // And each unexercised one has to be admitted by name, with its reason —
    // a count that quietly absorbs a newly-unexercised reason is the failure.
    for (const reason of notDriven) {
      expect(page, `the page must say ${reason} is not exercised`).toContain(`\`${reason}\``);
      expect(page).toMatch(new RegExp(`${reason}[\\s\\S]{0,400}?NOT exercised|NOT exercised[\\s\\S]{0,400}?${reason}|${reason}[\\s\\S]{0,400}?not exercised`));
    }
  });

  /**
   * Round thirteen, Low 1 — the same rule turned on THIS FILE'S OWN prose.
   *
   * The two tests above pin the PAGE against the constant, and they held: the
   * page says sixteen and thirteen and both are right. What nothing pinned was
   * the docblock above them, which still said fifteen and twelve after the merge
   * that added `would_latch_safe_mode`. No assertion was ever weakened by it —
   * they all derive from the constant — but a false sentence in a test file is
   * the same artifact as a false sentence in a served string, and this wave has
   * now shipped ten defects that were defects in a disclosure.
   *
   * So the docblock's two numbers are parsed back out of this file and compared
   * to the constant and to the sweep, exactly as the page's are.
   */
  it('states its own two counts in the docblock, and both are the measured ones', () => {
    const source = fs.readFileSync(path.join(HERE_FOR_PHASE_13, 'reliability-durability.test.ts'), 'utf8');
    const anchor = source.indexOf('const HERE_FOR_PHASE_13');
    expect(anchor, 'the anchor this docblock sits above must exist').toBeGreaterThan(0);
    const opened = source.lastIndexOf('/**', anchor);
    expect(opened, 'that anchor must carry a docblock').toBeGreaterThan(0);
    const prose = source
      .slice(opened, anchor)
      .split('\n')
      .map((line) => line.replace(/^\s*\/?\*+\/?\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');

    const stated = /constant holds (\w+) and (\w+) are exercised/i.exec(prose);
    expect(stated, 'the docblock must state how many the constant holds and how many are driven').toBeTruthy();
    expect(NUMBER_WORDS[stated![1]!.toLowerCase()]).toBe(BACKUP_REFUSAL_REASONS.length);
    expect(NUMBER_WORDS[stated![2]!.toLowerCase()]).toBe(exercised().length);
  });
});
