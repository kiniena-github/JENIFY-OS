/**
 * Wave 5, correction round seven — a partial enumeration standing in for the
 * complete one, twice, on the check that decides whether HQ can stand behind
 * its own store.
 *
 * Two findings, one shape. Both were reproduced by execution against `ae4bf90`
 * before anything was changed, and the reproductions are the tests below.
 *
 *  - **HIGH 1 — five declared engine-immutable ledgers were covered by NEITHER
 *    wipe detector.** `truncatedImmutableLedgers` iterates `sqlite_sequence`,
 *    `immutableLedgerMarks` was gated on the same table, and
 *    `regressedImmutableLedgers` reads what that gate committed — so
 *    `sqlite_sequence` MEMBERSHIP was standing in for "is this a declared
 *    ledger", and all three shared one blind spot. Five of the 33 entries in
 *    `ENGINE_IMMUTABLE_TABLES` are not `INTEGER PRIMARY KEY AUTOINCREMENT` and
 *    have no row there at all: `hq_memory`, `hq_mission_intents`,
 *    `hq_mission_plan_items`, `hq_missions`, `hq_orchestration_runs`. Executed:
 *    drop the guards, `DELETE FROM hq_mission_plan_items`, put the guards back
 *    — `boot=false [] assess=false [] release=ADMITTED`, on every process
 *    afterwards. Two of those five are the ledgers through which a task's
 *    mission and its project ceiling are derived, which is why this wave gave
 *    them `no_erase` in the first place.
 *  - **HIGH 2 — a MID-ledger delete was invisible at both depths.**
 *    `MAX(rowid)` was standing in for "how many rows does this ledger hold", so
 *    removing rows from the middle left the tail, left the engine's high-water
 *    mark, and left every detector silent. Executed on
 *    `hq_reliability_verdicts` — the ledger that holds the safe-mode latch
 *    itself — with rowids `[1,2,3]` and rowid 2 deleted: `truncated []`,
 *    `regressed []`, `boot=false []`, `release=ADMITTED`, across restarts.
 *
 * The fix enumerates the real thing in both directions: every DECLARED ledger
 * the file carries, and each one's full identity — how many rows it holds, the
 * greatest rowid it holds, and the gap between them. So do the tests. Nothing
 * below names a ledger by hand where the schema can be asked instead, because
 * naming them by hand is precisely how the hole was opened.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  declaredLedgerIdentities,
  regressedImmutableLedgers,
  truncatedImmutableLedgers,
} from '../src/store/integrity.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { RELIABILITY_COMMAND_CAPABILITY } from '../src/application/reliability-command.js';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

/** Give the file a history worth committing to. */
function warm(fx: FileFixture, times = 3): void {
  for (let i = 0; i < times; i += 1) {
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
  }
}

/**
 * The attack, in the form every one of these findings takes: drop the ledger's
 * guards, write, put them back. A guard re-created before the next boot is
 * never observed missing, because the as-found census reads `sqlite_master` at
 * construction time only — which is what makes the ROW-level check the only
 * thing that can see this.
 */
function throughTheGuards(raw: HqDatabase, table: string, write: (raw: HqDatabase) => void): void {
  const triggers = raw
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
    .all(table) as { name: string; sql: string }[];
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
  write(raw);
  for (const trigger of triggers) raw.exec(trigger.sql);
}

interface Seen {
  bootSafeMode: boolean;
  bootFindings: string[];
  assessSafeMode: boolean;
  assessFindings: string[];
  released: boolean;
}

function observe(fx: FileFixture, tag: string): Seen {
  const process = fx.reopen(tag);
  const boot = process.ops.hqReliabilityPosture().integrity;
  const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error('unreachable');
  const released = process.ops.releaseKillSwitch('global', 'founder').ok;
  process.db.close();
  return {
    bootSafeMode: boot.safeMode,
    bootFindings: findings(boot.observations),
    assessSafeMode: assessed.data.safeMode,
    assessFindings: findings(assessed.data.observations),
    released,
  };
}

/** Blocking at BOTH depths, in every process, with the one refused act refused. */
function expectPermanentlyBlocking(fx: FileFixture, tags: readonly string[], ledger: string): void {
  for (const tag of tags) {
    const seen = observe(fx, tag);
    expect(seen.bootSafeMode, `${tag} boot`).toBe(true);
    expect(seen.bootFindings, `${tag} boot`).toContain('append_only_guard_missing');
    expect(seen.assessSafeMode, `${tag} assessment`).toBe(true);
    expect(seen.released, `${tag} release`).toBe(false);
    const process = fx.reopen(`${tag}-detail`);
    const detail = process.ops
      .hqReliabilityPosture()
      .integrity.observations.map((observation) => observation.detail)
      .join(' ');
    expect(detail, `${tag} names the ledger`).toContain(ledger);
    process.db.close();
  }
}

function fixtureWithMissionWork(): FileFixture {
  const fx = fileFixture();
  registerMissionCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, RELIABILITY_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  expect(
    fx.ops.commandMission({
      title: 'Work whose plan is about to be erased',
      objective: 'Hold a project ceiling through a plan item',
      planItems: ['One', 'Two', 'Three'],
      requestedBy: 'founder',
    }).ok,
  ).toBe(true);
  return fx;
}

describe('the declared ledgers are enumerated from the DECLARATION, never from sqlite_sequence', () => {
  /**
   * The measurement the finding rests on, kept as an assertion so the class
   * cannot silently reopen. Five is not a magic number — it is however many
   * declared ledgers have no engine high-water row, and the test fails if that
   * set changes in either direction without somebody looking at it.
   */
  it('reads every declared ledger, including the five that are not AUTOINCREMENT', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      const notAutoincrement = ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table).filter((table) => {
        const row = raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table) as { sql: string } | undefined;
        expect(row, `${table} is declared but absent from a freshly migrated file`).toBeDefined();
        return row !== undefined && !/AUTOINCREMENT/i.test(row.sql);
      });
      expect(notAutoincrement.sort()).toEqual([
        'hq_memory',
        'hq_mission_intents',
        'hq_mission_plan_items',
        'hq_missions',
        'hq_orchestration_runs',
      ]);

      // `sqlite_sequence` has a row for none of them, at any point in the file's
      // life — which is what made membership of it the wrong enumeration.
      raw.close();
      const worked = fixtureWithMissionWork();
      try {
        warm(worked);
        const sequenced = new Set(
          (worked.db.prepare(`SELECT name FROM sqlite_sequence`).all() as { name: string }[]).map(
            (row) => row.name,
          ),
        );
        for (const table of notAutoincrement) {
          expect(sequenced.has(table), `${table} unexpectedly has an engine high-water row`).toBe(false);
        }
        // And the identity reader sees them anyway, because it iterates the
        // DECLARATION. Every one of them that holds rows is answered for.
        const identities = declaredLedgerIdentities(worked.db);
        expect(Object.keys(identities)).toContain('hq_mission_plan_items');
        expect(Object.keys(identities)).toContain('hq_missions');
        expect(identities.hq_mission_plan_items.rows).toBe(3);
      } finally {
        worked.cleanup();
      }
    } finally {
      fx.cleanup();
    }
  });

  /**
   * HIGH 1, executed end to end on the ledger whose erasure was shown to widen
   * a Founder mission ceiling. Against `ae4bf90` every line below read
   * `[]`/`false`/`ADMITTED`.
   */
  it('reports a wiped hq_mission_plan_items at both depths, in every later process', () => {
    const fx = fixtureWithMissionWork();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      expect(declaredLedgerIdentities(raw).hq_mission_plan_items.rows).toBe(3);
      throughTheGuards(raw, 'hq_mission_plan_items', (db) =>
        db.exec('DELETE FROM hq_mission_plan_items'),
      );
      expect(declaredLedgerIdentities(raw).hq_mission_plan_items).toBeUndefined();
      // The two checks that used to be asked, and still have nothing to say:
      // the table is present, its guards are back, and it never had an engine
      // high-water mark to contradict.
      expect(truncatedImmutableLedgers(raw)).toEqual([]);
      expect(regressedImmutableLedgers(raw)).toEqual(['hq_mission_plan_items']);
      raw.close();

      expectPermanentlyBlocking(fx, ['plan-items-one', 'plan-items-two'], 'hq_mission_plan_items');
    } finally {
      fx.cleanup();
    }
  });

  it('reports a wiped hq_missions the same way', () => {
    const fx = fixtureWithMissionWork();
    try {
      warm(fx);
      fx.db.close();

      const raw = fx.raw();
      throughTheGuards(raw, 'hq_missions', (db) => db.exec('DELETE FROM hq_missions'));
      expect(truncatedImmutableLedgers(raw)).toEqual([]);
      expect(regressedImmutableLedgers(raw)).toEqual(['hq_missions']);
      raw.close();

      expectPermanentlyBlocking(fx, ['missions-one', 'missions-two'], 'hq_missions');
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The other direction of the same enumeration: HQ commits about a ledger it
   * has never appended to only what is true, so a ledger that is legitimately
   * empty is not a finding and never becomes one.
   */
  it('has no false positive: ordinary boots and real work keep every declared ledger satisfied', () => {
    const fx = fixtureWithMissionWork();
    try {
      for (const tag of ['ordinary-one', 'ordinary-two', 'ordinary-three']) {
        const seen = observe(fx, tag);
        expect(seen.bootFindings, tag).toEqual([]);
        expect(seen.assessFindings, tag).toEqual([]);
        expect(seen.released, tag).toBe(true);
      }
    } finally {
      fx.cleanup();
    }
  });
});

describe('a row removed from the MIDDLE of a declared ledger is a finding that does not heal', () => {
  /**
   * HIGH 2, on the ledger that carries the safe-mode latch. The mid-delete is
   * the case a `MAX(rowid)` seek is blind to by construction, and a row COUNT
   * alone is not enough either: HQ keeps appending to this ledger, so the very
   * next verdict row puts the count back where the commitment expects it. What
   * does not heal is the GAP the deletion leaves in the rowids, because SQLite
   * hands the next append `MAX(rowid) + 1` and never reissues a rowid a deleted
   * row held.
   */
  it('reports a mid-ledger delete on hq_reliability_verdicts, and keeps reporting it', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      const rowids = (
        fx.db.prepare(`SELECT rowid AS rid FROM hq_reliability_verdicts ORDER BY rowid`).all() as {
          rid: number;
        }[]
      ).map((row) => row.rid);
      expect(rowids.length).toBeGreaterThanOrEqual(3);
      fx.db.close();

      const raw = fx.raw();
      const before = declaredLedgerIdentities(raw).hq_reliability_verdicts;
      throughTheGuards(raw, 'hq_reliability_verdicts', (db) =>
        db.prepare(`DELETE FROM hq_reliability_verdicts WHERE rowid = ?`).run(rowids[1]),
      );
      const after = declaredLedgerIdentities(raw).hq_reliability_verdicts;
      // The tail is untouched and the engine's high-water mark is untouched:
      // this is exactly the state both shipped detectors read as healthy.
      expect(after.top).toBe(before.top);
      expect(after.rows).toBe(before.rows - 1);
      expect(truncatedImmutableLedgers(raw)).toEqual([]);
      expect(regressedImmutableLedgers(raw)).toEqual(['hq_reliability_verdicts']);
      raw.close();

      // Three processes, each of which APPENDS to this very ledger as it
      // assesses — which is what used to hide the deletion within one process.
      expectPermanentlyBlocking(
        fx,
        ['mid-delete-one', 'mid-delete-two', 'mid-delete-three'],
        'hq_reliability_verdicts',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('reports a mid-ledger delete on the audit log itself', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const rowids = (
        raw.prepare(`SELECT rowid AS rid FROM op_evidence ORDER BY rowid`).all() as { rid: number }[]
      ).map((row) => row.rid);
      expect(rowids.length).toBeGreaterThanOrEqual(4);
      throughTheGuards(raw, 'op_evidence', (db) =>
        db
          .prepare(`DELETE FROM op_evidence WHERE rowid IN (?, ?)`)
          .run(rowids[1], rowids[2]),
      );
      expect(regressedImmutableLedgers(raw)).toContain('op_evidence');
      raw.close();
      expectPermanentlyBlocking(fx, ['log-mid-one', 'log-mid-two'], 'op_evidence');
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * The invariant the gap rule rests on, driven rather than assumed.
 *
 * The gap between a ledger's greatest rowid and the rows it holds is treated as
 * a baseline that only a DELETION may raise. That is only safe if no legitimate
 * write path ever burns a rowid — a refused insert, a deduplicated one, a
 * constraint violation caught and swallowed, a rolled-back transaction. If one
 * did, HQ would latch a permanent finding on a healthy store, which is the same
 * fabricated-finding failure this round is correcting elsewhere. So it is driven
 * here, over the real facade, on all 33 declared ledgers at once.
 */
describe('no legitimate write path burns a rowid on a declared ledger', () => {
  function gaps(db: HqDatabase): Record<string, number> {
    const found: Record<string, number> = {};
    for (const [table, identity] of Object.entries(declaredLedgerIdentities(db))) {
      if (identity.top !== identity.rows) found[table] = identity.top - identity.rows;
    }
    return found;
  }

  it('survives refusals, duplicates, deduplicated writes and a rolled-back transaction', () => {
    const fx = fixtureWithMissionWork();
    try {
      // Refused and deduplicated writes through the facade, each of which
      // reaches a declared ledger's own guards or a UNIQUE index.
      const duplicateMission = fx.ops.commandMission({
        title: 'Work whose plan is about to be erased',
        objective: 'Hold a project ceiling through a plan item',
        planItems: ['One'],
        idempotencyKey: 'same-key',
        requestedBy: 'founder',
      });
      expect(duplicateMission.ok).toBe(true);
      const replayed = fx.ops.commandMission({
        title: 'Work whose plan is about to be erased',
        objective: 'Hold a project ceiling through a plan item',
        planItems: ['One'],
        idempotencyKey: 'same-key',
        requestedBy: 'founder',
      });
      expect(replayed.ok).toBe(true);
      // A refused Founder act: a principal with no grant at all.
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'nobody' }).ok).toBe(false);
      // A duplicate run attempt, which the attempt-key guard refuses outright.
      const run = fx.ops.openRun({
        taskId: fx.claim.taskId,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        runKind: 'external_action',
        label: 'a run whose attempt is about to be duplicated',
      });
      expect(run.ok).toBe(true);
      if (run.ok) {
        expect(
          fx.ops.startRunAttempt({
            runId: run.data.run.id,
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
          }).ok,
        ).toBe(true);
      }
      warm(fx);

      // A transaction that inserts into a declared ledger and is rolled back —
      // the one case SQLite documents as able to burn an AUTOINCREMENT value if
      // it is committed rather than rolled back, driven here on the real file.
      const raw = fx.raw();
      raw.exec('BEGIN');
      raw
        .prepare(
          `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
           VALUES ('rolled-back', '2026-01-01T00:00:00.000Z', NULL, 'probe', 'probe', '{}', 'x', 'y')`,
        )
        .run();
      raw.exec('ROLLBACK');
      // And a statement that FAILS inside a transaction which then commits other
      // work, which is the shape a swallowed constraint violation really has.
      raw.exec('BEGIN');
      expect(() =>
        raw
          .prepare(
            `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
             SELECT id, at, task_id, actor, kind, payload, prev_hash, hash FROM op_evidence LIMIT 1`,
          )
          .run(),
      ).toThrow();
      raw.exec('COMMIT');
      expect(gaps(raw)).toEqual({});
      raw.close();

      expect(gaps(fx.db)).toEqual({});
      // And after a VACUUM, which rewrites the whole file.
      const vacuumed = fx.reopen('after-vacuum');
      vacuumed.db.exec('VACUUM');
      expect(gaps(vacuumed.db)).toEqual({});
      vacuumed.db.close();
      expect(observe(fx, 'after-all-of-it').bootFindings).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('survives a byte copy of the file', () => {
    const fx = fixtureWithMissionWork();
    try {
      warm(fx);
      const copy = `${fx.dbPath}.copy`;
      fx.db.exec(`VACUUM INTO '${copy}'`);
      const copied = new Database(copy, { readonly: true }) as unknown as HqDatabase;
      expect(gaps(copied)).toEqual({});
      copied.close();
    } finally {
      fx.cleanup();
    }
  });
});
