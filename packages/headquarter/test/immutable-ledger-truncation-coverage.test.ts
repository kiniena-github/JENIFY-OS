/**
 * EVERY declared engine-immutable ledger is inside a truncation/regression
 * check, not only the AUTOINCREMENT ones (Wave 5 correction round ten,
 * MEDIUM 4).
 *
 * ## What was open
 *
 * `truncatedImmutableLedgers` (integrity.ts ~1146 at the reviewed head) and
 * `regressedImmutableLedgers` (~1577) both started from a `sqlite_sequence`
 * scan, and `sqlite_sequence` carries a row only for a table declared
 * `INTEGER PRIMARY KEY AUTOINCREMENT`. Five of the thirty-three declared
 * ledgers are not: `hq_memory`, `hq_mission_intents`, `hq_mission_plan_items`,
 * `hq_missions` and `hq_orchestration_runs`. They were therefore outside EVERY
 * truncation check this module has.
 *
 * The reviewer measured it as a matched pair — the identical attack (drop the
 * ledger's triggers, `DELETE`, re-create the triggers verbatim) against one of
 * the five and against the control:
 *
 * ```
 * hq_missions  -> safeMode: false, blocking: []   (three committed missions gone)
 * op_evidence  -> safeMode: true,  blocking: ['append_only_ledger_truncated']
 * ```
 *
 * ## What closes it
 *
 * `immutableLedgerMarks` is driven by the DECLARATION rather than by
 * `sqlite_sequence`, and the mark it publishes was already `MAX(rowid)` — the
 * sequence row was only deciding which tables got one. So every declared ledger
 * now contributes a mark, the commitment ledger records it, and
 * `regressedImmutableLedgers` compares it.
 *
 * The difference that remains is stated rather than smoothed over and is
 * asserted below: the five are covered by the COMMITMENT check, which needs a
 * prior healthy boot to have recorded a mark, not by the engine-high-water
 * check, which genuinely has no witness for them.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { fileFixture } from './reliability.fixture.js';
import { expectOk, CAPS } from './application.fixture.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  declaredGuardsFor,
  immutableLedgerMarks,
  regressedImmutableLedgers,
} from '../src/store/integrity.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { RELIABILITY_COMMAND_CAPABILITY } from '../src/application/reliability-command.js';

/** The five, named so a future schema change that adds a sixth is visible. */
const WITHOUT_AUTOINCREMENT: readonly string[] = [
  'hq_memory',
  'hq_mission_intents',
  'hq_mission_plan_items',
  'hq_missions',
  'hq_orchestration_runs',
];

/** Drop the guards, empty the ledger, put the guards back verbatim. */
function eraseLedger(file: string, table: string): void {
  const raw = new Database(file);
  const triggers = (
    raw
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
      .all(table) as { name: string; sql: string }[]
  ).filter((row) => typeof row.sql === 'string');
  for (const trigger of triggers) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  raw.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) raw.exec(trigger.sql);
  raw.close();
}

/**
 * Grant the Founder the mission-command capability this fixture does not carry
 * by default, so `commandMission` is reachable at all.
 */
function allowMissions(fx: ReturnType<typeof fileFixture>): void {
  registerMissionCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.openPr,
      // The fixture's own reliability grant is re-stated: this registry call
      // REPLACES the principal row, and dropping it would make
      // `assessHqIntegrity` unreachable for the wrong reason.
      RELIABILITY_COMMAND_CAPABILITY.id,
      MISSION_COMMAND_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });
}

/** Command three real missions, so the ledger holds something worth erasing. */
function seedMissions(fx: ReturnType<typeof fileFixture>): number {
  allowMissions(fx);
  for (const label of ['one', 'two', 'three']) {
    expectOk(
      fx.ops.commandMission({
        title: `Mission ${label}`,
        objective: `Do the ${label} thing end to end.`,
        scope: 'The one line.',
        requestedBy: 'founder',
        idempotencyKey: `mission-${label}`,
      }),
    );
  }
  const raw = fx.raw();
  const count = (raw.prepare('SELECT COUNT(*) AS n FROM hq_missions').get() as { n: number }).n;
  raw.close();
  return count;
}

describe('every declared engine-immutable ledger is inside a truncation check', () => {
  it('the five that carry no AUTOINCREMENT are exactly the five named here', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      const without = ENGINE_IMMUTABLE_TABLES.filter((entry) => {
        const row = raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(entry.table) as { sql?: string } | undefined;
        return typeof row?.sql === 'string' && !/AUTOINCREMENT/i.test(row.sql);
      }).map((entry) => entry.table);
      raw.close();
      expect(ENGINE_IMMUTABLE_TABLES.length).toBe(33);
      expect(without.sort()).toEqual([...WITHOUT_AUTOINCREMENT].sort());
      // And every one of them declares `no_erase`, which is what makes
      // `MAX(rowid)` monotonic and therefore a sound witness for them.
      for (const table of WITHOUT_AUTOINCREMENT) {
        const entry = ENGINE_IMMUTABLE_TABLES.find((candidate) => candidate.table === table)!;
        expect(JSON.stringify(declaredGuardsFor(entry)), table).toContain('no_erase');
      }
    } finally {
      fx.cleanup();
    }
  });

  it('every declared ledger the file carries rows for contributes a mark', () => {
    const fx = fileFixture();
    try {
      seedMissions(fx);
      const raw = fx.raw();
      const marks = immutableLedgerMarks(raw);
      raw.close();
      // `hq_missions` used to be absent from this map entirely.
      expect(Object.keys(marks)).toContain('hq_missions');
      expect(marks.hq_missions).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });

  it('erasing hq_missions now reaches the same verdict as erasing op_evidence — the matched pair', () => {
    const fx = fileFixture();
    try {
      const committed = seedMissions(fx);
      expect(committed).toBe(3);
      // A healthy assessment is what records the commitment the erasure will
      // contradict. Without it there is nothing to measure against, which is
      // the honest difference from the AUTOINCREMENT check.
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      fx.db.close();

      eraseLedger(fx.dbPath, 'hq_missions');

      const raw = fx.raw();
      expect(regressedImmutableLedgers(raw)).toContain('hq_missions');
      expect(
        (raw.prepare('SELECT COUNT(*) AS n FROM hq_missions').get() as { n: number }).n,
      ).toBe(0);
      raw.close();

      const after = fx.reopen('after-the-erasure');
      const posture = after.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.filter((o) => o.blocking).length).toBeGreaterThan(0);
      // And a FULL Founder assessment does not clear it: this is a fact about
      // the file as it now stands.
      const assessed = after.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(true);
      expect(after.ops.releaseKillSwitch('global', 'founder').ok).toBe(false);
      after.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('has no false positive: an ordinary boot, an assessment and more missions keep it clear', () => {
    const fx = fileFixture();
    try {
      seedMissions(fx);
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      fx.db.close();
      for (const tag of ['idle-one', 'idle-two']) {
        const process = fx.reopen(tag);
        expect(process.ops.hqReliabilityPosture().integrity.safeMode, tag).toBe(false);
        expect(process.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok, tag).toBe(true);
        process.db.close();
      }
      const grown = fx.reopen('grown');
      registerMissionCommandCapability(grown.db);
      expectOk(
        grown.ops.commandMission({
          title: 'Mission four',
          objective: 'Do the fourth thing end to end.',
          scope: 'The one line.',
          requestedBy: 'founder',
          idempotencyKey: 'mission-four',
        }),
      );
      expect(grown.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      grown.db.close();
      const again = fx.reopen('after-growth');
      expect(again.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      again.db.close();
    } finally {
      fx.cleanup();
    }
  });
});
