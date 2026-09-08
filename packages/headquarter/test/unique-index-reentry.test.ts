/**
 * Wave 5, correction round fourteen — HIGH 2: a row re-entering a table on a
 * SECONDARY unique index.
 *
 * `REPLACE` resolves a conflict on ANY unique index by DELETING the standing
 * row, and it skips `BEFORE DELETE` triggers while `recursive_triggers` is off.
 * That pragma is the engine default and is CONNECTION-scoped: HQ's own handle
 * sets it to 1, and every ordinary connection to the same file has 0. This
 * codebase states that fact in ten other modules and, until this round, applied
 * it one table at a time — which left both of the tables the branch declares a
 * write-once identity for bypassable at ONE statement:
 *
 *  - **`hq_missions`** declares `UNIQUE(idempotency_key)` and carried no
 *    unique-index guard. Reproduced at `8481269` through the real facade from an
 *    ordinary connection: one `INSERT OR REPLACE` at the victim's own rowid
 *    rewrote the mission's `id` to `HIJACKED-MISSION`, `missingImmutabilityGuards`
 *    stayed empty, and two later processes both read `safeMode: false []`.
 *  - **`op_tasks`**, the only member of `WRITE_ONCE_IDENTITY_TABLES`, carried no
 *    `no_replace*` clause at all. Reproduced on the shipped budget scene: one
 *    `INSERT OR REPLACE` colliding on `idx_op_tasks_idem` rewrote the task's
 *    `id`; the proposal for that task went from `{scopes:["deployment",
 *    "mission"], tiers:["deterministic_local"], budgetDecision:"blocked"}` to
 *    `{scopes:["deployment"], tiers:[all five], budgetDecision:"within_ceiling"}`
 *    and a `critical_review` write the exhausted Founder ceiling had REFUSED was
 *    accepted — with both integrity depths silent.
 *
 * Two answers, and the second is the one that matters:
 *
 *  1. the two live instances are closed — `hq_missions` by a declared
 *     `no_replace_unique` in its own module's DDL, `op_tasks` by the DERIVED
 *     `no_unique_reentry` guard built from `PRAGMA index_list` /
 *     `PRAGMA index_info`;
 *  2. the CLASS is closed by execution here: every unique index of every
 *     declared ledger AND every write-once identity table is enumerated from
 *     the live schema and driven, with `recursive_triggers` OFF, against that
 *     table's REAL schema and REAL triggers. A unique index added tomorrow with
 *     nothing holding it fails this file on the day it is added — and it fails
 *     because the engine accepted a forgery, not because a regex did not find a
 *     column name in a trigger's text.
 *
 * Installing the derived guard on all 33 ledgers instead was built and measured,
 * and REJECTED: it pre-empts the engine's own `UNIQUE` conflict on the paths
 * that legitimately rely on it — `action-gateway`'s side-effect deduplication
 * stopped recognising a duplicate — which is the outcome this module ranks
 * strictly worse than the hole. See `uniqueReentryTargets`.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { expectOk } from './application.fixture.js';
import { claimSideEffectTask, fileFixture } from './reliability.fixture.js';
import { intelligenceFixture } from './intelligence.fixture.js';
import { INTELLIGENCE_TIERS } from '../src/application/intelligence-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { RELIABILITY_COMMAND_CAPABILITY } from '../src/application/reliability-command.js';
import { CAPS } from './application.fixture.js';
import { openMemoryHqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  UNIQUE_REENTRY_GUARD,
  WRITE_ONCE_IDENTITY_TABLES,
  declaredGuardsForIdentityTable,
  missingImmutabilityGuards,
  secondaryUniqueIndexes,
  structuralIntegrity,
} from '../src/store/integrity.js';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

/** Every table this round holds a unique-index guarantee over. */
const GUARDED_TABLES: string[] = [
  ...ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table),
  ...WRITE_ONCE_IDENTITY_TABLES.map((entry) => entry.table),
];

/**
 * A scratch file carrying the WHOLE live schema — every table, index and
 * trigger a real HQ file has — with `recursive_triggers` left at the engine
 * default of OFF, which is the adversary's connection and not HQ's.
 */
function liveSchemaCopy(): Database.Database {
  const source = openMemoryHqDatabase();
  let objects: { type: string; sql: string | null }[];
  try {
    void new HeadquarterOperations(source);
    objects = source
      .prepare(
        `SELECT type, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
      )
      .all() as { type: string; sql: string | null }[];
  } finally {
    source.close();
  }
  const db = new Database(':memory:');
  expect(db.pragma('recursive_triggers', { simple: true }), 'the adversary’s pragma').toBe(0);
  for (const object of objects) db.exec(object.sql!);
  // Referential integrity is OFF for the sweep, and that is not a weakening of
  // what it measures: the probe seeds ONE table at a time with no parent rows
  // beside it, where a real attacker works on a populated store whose parents
  // are all there. Leaving it on would make the seed fail for a reason that has
  // nothing to do with a unique index — and every refusal asserted below is a
  // TRIGGER refusal or a UNIQUE one, never a foreign-key one.
  db.pragma('foreign_keys = OFF');
  expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
  return db;
}

/** The columns to write, excluding an INTEGER PRIMARY KEY (the rowid alias). */
function writableColumns(db: Database.Database, table: string): { name: string; type: string }[] {
  return (
    db.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string;
      type: string;
      pk: number;
    }[]
  ).filter((column) => !(column.pk === 1 && column.type.toUpperCase() === 'INTEGER'));
}

/**
 * Columns whose value is bounded by their own table's guard, so a generic
 * filler is not a row that table will accept.
 *
 * Only the commitment ledger has any: `no_overclaim` refuses a checkpoint that
 * claims more than the file holds, which is that guard working exactly as it
 * should. The seed row therefore COMMITS NOTHING — empty JSON, a zero chain
 * length — rather than the guard being dropped to make this sweep convenient.
 * None of these columns is in any unique index, so the collision this file
 * measures is unaffected.
 */
const SEED_OVERRIDES: Record<string, unknown> = {
  ledger_marks: '{}',
  ledger_rows: '{}',
  chain_length: 0,
  tip_hash: '',
};

/** A distinct value per column and per generation, of the declared affinity. */
function value(column: { name: string; type: string }, generation: number): unknown {
  if (Object.prototype.hasOwnProperty.call(SEED_OVERRIDES, column.name)) {
    return SEED_OVERRIDES[column.name];
  }
  const declared = column.type.toUpperCase();
  if (declared.includes('INT') || declared.includes('REAL') || declared.includes('FLOA')) {
    // Distinct per column name AND per generation, so an integer unique index
    // collides only where this test intends it to.
    let hash = generation * 1_000_003;
    for (const character of column.name) hash = (hash * 31 + character.charCodeAt(0)) % 900_000;
    return hash + 1;
  }
  if (declared.includes('BLOB')) return Buffer.from(`${column.name}-${generation}`);
  return `${column.name}-${generation}`;
}

describe('every unique index of every guarded table refuses a colliding re-entry', () => {
  /**
   * The class closure, driven rather than read. For each table and each of its
   * SECONDARY unique indexes, a second row is composed that differs in every
   * other column — so the ONLY conflict is that index — and offered at the
   * victim's own rowid, under `INSERT OR REPLACE` and under bare `REPLACE`.
   * Both must abort and the standing row must be byte-identical afterwards.
   */
  it('aborts INSERT OR REPLACE and REPLACE on each one, leaving the standing row intact', () => {
    const db = liveSchemaCopy();
    const accepted: string[] = [];
    let probes = 0;
    try {
      for (const table of GUARDED_TABLES) {
        const indexes = secondaryUniqueIndexes(db, table);
        if (indexes.length === 0) continue;
        const columns = writableColumns(db, table);
        for (const index of indexes) {
          // Every index this module cannot express is still DRIVEN here: the
          // executed refusal is the guarantee, and an index that no derived
          // clause could cover must still be held by something.
          for (const clause of ['INSERT OR REPLACE', 'REPLACE']) {
            db.exec('SAVEPOINT probe');
            try {
              const names = ['rowid', ...columns.map((column) => `"${column.name}"`)];
              const placeholders = names.map(() => '?').join(', ');
              db.prepare(
                `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders})`,
              ).run([1 as never, ...columns.map((column) => value(column, 1) as never)]);
              const standing = db
                .prepare(`SELECT * FROM "${table}" WHERE rowid = 1`)
                .get() as Record<string, unknown>;
              probes += 1;
              try {
                db.prepare(
                  `${clause} INTO "${table}" (${names.join(', ')}) VALUES (${placeholders})`,
                ).run([
                  1 as never,
                  ...columns.map((column) =>
                    // The target index's columns keep generation 1 so THIS index
                    // is the conflict; every other column moves to generation 2
                    // so no other index is.
                    index.columns.includes(column.name)
                      ? (value(column, 1) as never)
                      : (value(column, 2) as never),
                  ),
                ]);
                accepted.push(`${table}.${index.name} via ${clause}`);
              } catch {
                // Refused — by a trigger or by the engine's own UNIQUE
                // constraint. Either is a refusal; what matters is that the
                // standing row is still there and unchanged.
                const after = db.prepare(`SELECT * FROM "${table}" WHERE rowid = 1`).get();
                expect(after, `${table}.${index.name} via ${clause}`).toEqual(standing);
              }
            } finally {
              db.exec('ROLLBACK TO probe');
              db.exec('RELEASE probe');
            }
          }
        }
      }
    } finally {
      db.close();
    }
    // The sweep really ran: a guarantee proven over zero probes is not one.
    expect(probes, 'the sweep must reach real unique indexes').toBeGreaterThan(40);
    expect(accepted, 'a guarded table accepted a colliding re-entry').toEqual([]);
  });

  /**
   * The enumeration itself is a fact about the FILE, so a table that gains a
   * unique index enters the sweep above without anybody adding it to a list.
   */
  it('enumerates its indexes from PRAGMA index_list rather than from a list here', () => {
    const db = liveSchemaCopy();
    try {
      const seen = GUARDED_TABLES.flatMap((table) =>
        secondaryUniqueIndexes(db, table).map((index) => `${table}.${index.name}`),
      );
      expect(seen.length).toBeGreaterThan(20);
      // Two the review named by hand must be among them, so the derivation is
      // shown to see the exact indexes the exploits used.
      expect(seen).toContain('op_tasks.idx_op_tasks_idem');
      expect(seen).toContain('hq_missions.sqlite_autoindex_hq_missions_2');
      // And every index it reports must be expressible on this schema — an
      // inexpressible one is not a failure here, it is a signal that the
      // generated clause could not cover it and something else must.
      const inexpressible = GUARDED_TABLES.flatMap((table) =>
        secondaryUniqueIndexes(db, table)
          .filter((index) => !index.expressible)
          .map((index) => `${table}.${index.name}`),
      );
      expect(inexpressible).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('the derived guard is declared, installed and censused', () => {
  it('installs it on every write-once identity table the file gives one to', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      const triggers = new Set(
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      for (const entry of WRITE_ONCE_IDENTITY_TABLES) {
        for (const name of declaredGuardsForIdentityTable(entry)) {
          expect(triggers.has(name), `${name} must be installed`).toBe(true);
        }
      }
      expect(missingImmutabilityGuards(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  /**
   * The DECLARATION is held to the FILE. `uniqueIndexGuard` is a stored flag
   * rather than a per-pass `PRAGMA` read, for a measured cost reason, and this
   * is what stops it drifting: a table that gains or loses a secondary unique
   * index and does not change the flag fails here.
   */
  it('agrees with what the live file actually declares', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      for (const entry of WRITE_ONCE_IDENTITY_TABLES) {
        const derived = secondaryUniqueIndexes(db, entry.table).some((index) => index.expressible);
        expect(entry.uniqueIndexGuard, `${entry.table} declaration vs file`).toBe(derived);
      }
    } finally {
      db.close();
    }
  });

  it('reports the derived guard as missing when it is dropped', () => {
    const db = openMemoryHqDatabase();
    try {
      void new HeadquarterOperations(db);
      const name = `trg_op_tasks_${UNIQUE_REENTRY_GUARD}`;
      db.exec(`DROP TRIGGER ${name}`);
      expect(missingImmutabilityGuards(db)).toContain(name);
      expect(structuralIntegrity(db).safeMode).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('the two acts the review executed', () => {
  /**
   * `op_tasks` on the shipped budget scene, end to end: the write that detached
   * a task from its Founder ceiling for one statement.
   */
  it('refuses the INSERT OR REPLACE that detached a task from its budget ceiling', () => {
    const fx = intelligenceFixture();
    try {
      const project = expectOk(
        fx.ops.createProject({
          name: 'Project carrying the governed mission',
          purpose: 'Carry the mission whose ceiling is under test',
          requestedBy: 'founder',
        }),
      ).project;
      const mission = expectOk(
        fx.ops.commandMission({
          title: 'Mission carrying two tasks',
          objective: 'One task spends, the other only belongs',
          planItems: ['The work that spends', 'The work that only belongs'],
          projectId: project.id,
          requestedBy: 'founder',
        }),
      ).mission;
      expectOk(
        fx.ops.linkMissionPlanItem({
          missionId: mission.id,
          planItemSeq: 1,
          taskId: fx.claim.taskId,
          requestedBy: 'founder',
        }),
      );
      const attacked = claimSideEffectTask(fx, 'the-attacked-task');
      expectOk(
        fx.ops.linkMissionPlanItem({
          missionId: mission.id,
          planItemSeq: 2,
          taskId: attacked.taskId,
          requestedBy: 'founder',
        }),
      );
      fx.budget([...INTELLIGENCE_TIERS]);
      fx.budget(['deterministic_local'], {
        scopeKind: 'mission',
        scopeId: mission.id,
        window: 'total',
        ceilingMinorUnits: 1,
      });
      expectOk(
        fx.ops.recordIntelligenceCost({
          taskId: fx.claim.taskId,
          workerId: fx.claim.workerId,
          fence: fx.claim.fence,
          providerId: 'anthropic',
          provenance: 'billed',
          amountMinorUnits: 5000,
          currency: 'USD',
          unitKind: 'requests',
          idempotencyKey: 'the-spend-that-exhausted-it',
        }),
      );

      const ceilingBinds = (tag: string): void => {
        const seen = expectOk(
          fx.ops.intelligenceRoutingProposal({
            taskId: attacked.taskId,
            complexity: 'routine',
            contextSize: 'medium',
            workKind: 'coding',
          }),
        );
        expect(
          seen.governedBy.map((scope) => String(scope.scopeKind)).sort(),
          tag,
        ).toEqual(['deployment', 'mission']);
        expect(seen.permittedTiers, tag).toEqual(['deterministic_local']);
        expect(String((seen as unknown as { budgetDecision: unknown }).budgetDecision), tag).toBe(
          'blocked',
        );
        expect(
          fx.ops.recordIntelligenceDecision({
            taskId: attacked.taskId,
            workerId: attacked.workerId,
            fence: attacked.fence,
            tier: 'critical_review',
            label: 'the write the exhausted ceiling should refuse',
            complexity: 'routine',
            contextSize: 'medium',
            workKind: 'coding',
            idempotencyKey: `${tag}-critical`,
          }).ok,
          tag,
        ).toBe(false);
      };
      ceilingBinds('before');

      const raw = fx.db as unknown as Database.Database;
      const victim = raw
        .prepare(`SELECT rowid AS rid, * FROM op_tasks WHERE id = ?`)
        .get(attacked.taskId) as Record<string, unknown>;
      const columns = Object.keys(victim).filter((column) => column !== 'rid');
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO op_tasks (rowid, ${columns
              .map((column) => `"${column}"`)
              .join(', ')})
             VALUES (?, ${columns.map(() => '?').join(', ')})`,
          )
          .run([
            victim.rid as never,
            ...columns.map((column) =>
              column === 'id' ? ('HIJACKED-TASK' as never) : (victim[column] as never),
            ),
          ]),
      ).toThrow(/op_tasks unique keys are write-once/);
      expect(
        (raw.prepare(`SELECT id FROM op_tasks WHERE rowid = ?`).get(victim.rid) as { id: string })
          .id,
      ).toBe(attacked.taskId);
      ceilingBinds('after');
      expect(missingImmutabilityGuards(fx.db)).toEqual([]);
      expect(structuralIntegrity(fx.db).safeMode).toBe(false);
    } finally {
      fx.db.close();
    }
  });

  /**
   * `hq_missions` through the real facade, from an ORDINARY connection — the
   * one whose `recursive_triggers` is 0 and for which `no_erase` therefore does
   * not fire.
   */
  it('refuses the INSERT OR REPLACE that rewrote a mission’s identity', () => {
    const fx = fileFixture();
    try {
      registerMissionCommandCapability(fx.db);
      fx.principals.register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [
          CAPS.readStatus,
          CAPS.openPr,
          RELIABILITY_COMMAND_CAPABILITY.id,
          MISSION_COMMAND_CAPABILITY.id,
        ],
        approvalAuthority: true,
        active: true,
      });
      const mission = expectOk(
        fx.ops.commandMission({
          title: 'A mission a raw writer would like to own',
          objective: 'Prove the identity is held for every connection',
          planItems: ['The work'],
          requestedBy: 'founder',
        }),
      ).mission;
      fx.db.close();

      const raw = fx.raw();
      expect(
        (raw as unknown as Database.Database).pragma('recursive_triggers', { simple: true }),
        'an ordinary connection carries the engine default',
      ).toBe(0);
      const victim = raw
        .prepare(`SELECT rowid AS rid, * FROM hq_missions WHERE id = ?`)
        .get(mission.id) as Record<string, unknown>;
      expect(victim.idempotency_key, 'the collision target').toBeTruthy();
      const columns = Object.keys(victim).filter((column) => column !== 'rid');
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO hq_missions (rowid, ${columns
              .map((column) => `"${column}"`)
              .join(', ')})
             VALUES (?, ${columns.map(() => '?').join(', ')})`,
          )
          .run([
            victim.rid as never,
            ...columns.map((column) =>
              column === 'id' ? ('HIJACKED-MISSION' as never) : (victim[column] as never),
            ),
          ]),
      ).toThrow(/hq_missions/);
      expect(
        (raw.prepare(`SELECT id FROM hq_missions WHERE rowid = ?`).get(victim.rid) as { id: string })
          .id,
      ).toBe(mission.id);
      expect(missingImmutabilityGuards(raw)).toEqual([]);
      raw.close();

      for (const tag of ['p2', 'p3']) {
        const process = fx.reopen(tag);
        const posture = process.ops.hqReliabilityPosture().integrity;
        expect(posture.safeMode, `${tag} boot`).toBe(false);
        expect(findings(posture.observations), `${tag} boot`).toEqual([]);
        expect(
          (
            process.db.prepare(`SELECT id FROM hq_missions WHERE rowid = ?`).get(victim.rid) as {
              id: string;
            }
          ).id,
          `${tag} identity`,
        ).toBe(mission.id);
        process.db.close();
      }
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The legitimate write path the guard must not touch: `commandMission` is
   * idempotent on the same key, and creating a second mission with a different
   * key still works.
   */
  it('leaves the facade’s own mission writes alone', () => {
    const fx = fileFixture();
    try {
      registerMissionCommandCapability(fx.db);
      fx.principals.register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [
          CAPS.readStatus,
          CAPS.openPr,
          RELIABILITY_COMMAND_CAPABILITY.id,
          MISSION_COMMAND_CAPABILITY.id,
        ],
        approvalAuthority: true,
        active: true,
      });
      const first = expectOk(
        fx.ops.commandMission({
          title: 'One',
          objective: 'o',
          planItems: ['a'],
          requestedBy: 'founder',
        }),
      ).mission;
      // The SAME command again: idempotent, and it must not meet the guard.
      const again = expectOk(
        fx.ops.commandMission({
          title: 'One',
          objective: 'o',
          planItems: ['a'],
          requestedBy: 'founder',
        }),
      ).mission;
      expect(again.id).toBe(first.id);
      const second = expectOk(
        fx.ops.commandMission({
          title: 'Two',
          objective: 'different',
          planItems: ['b'],
          requestedBy: 'founder',
        }),
      ).mission;
      expect(second.id).not.toBe(first.id);
      expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * And the legitimate task path: `createTask` is deduplicated by
   * `idx_op_tasks_idem`, and the derived guard must not turn that into a
   * refusal — the exact failure mode that stopped the all-33 variant shipping.
   */
  it('leaves createTask’s idempotent deduplication alone', () => {
    const fx = fileFixture();
    try {
      const first = expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'dedup' },
          idempotencyKey: 'dedup-key',
          requestedBy: 'claude',
        }),
      );
      const again = expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'dedup' },
          idempotencyKey: 'dedup-key',
          requestedBy: 'claude',
        }),
      );
      expect(again.task.id).toBe(first.task.id);
      expect(fx.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
