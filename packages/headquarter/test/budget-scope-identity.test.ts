/**
 * Wave 5, correction round thirteen — High 3: a SIXTH route to nullifying a
 * budget ceiling, through a row IDENTITY rather than through any link column.
 *
 * Reproduced at the merged head `237fc76`, 12 of 12 fresh ids, with no DDL and
 * no row-count change:
 *
 *  - `UPDATE hq_missions SET id = …` made `#canonicalTaskScopes`' inner
 *    `JOIN hq_missions m ON m.id = p.mission_id` match nothing. `governedBy`
 *    lost the mission, `permittedTiers` widened from `['deterministic_local']`
 *    to all five, `budgetDecision` went `blocked` -> `within_ceiling`, and a
 *    `critical_review` write that had been refused was ACCEPTED — while the
 *    Founder's own budget report still read `blocked`, so the report and the
 *    enforcement disagreed. `structuralIntegrity` stayed clean.
 *  - `UPDATE op_tasks SET id = …` did the same from the other end of the same
 *    link, and additionally emptied the project half, because
 *    `hq_mission_plan_items.task_id` names the task BY ID.
 *
 * `hq_missions` carried `no_erase` (BEFORE DELETE) and `no_replace` (BEFORE
 * INSERT) and NOTHING that guarded an UPDATE of `id`, although the declaration's
 * own comment said "what is write-once is the row's EXISTENCE and its identity"
 * and the trigger's own message said "hq_missions identity is write-once".
 * `op_tasks` carried no guards at all.
 *
 * Both halves of the answer are pinned here, and neither is a substitute for
 * the other:
 *
 *  1. the WRITE is refused — `trg_hq_missions_no_reidentify` and
 *     `trg_op_tasks_no_reidentify`, both declared so their absence is a census
 *     finding rather than a silent one;
 *  2. the READ no longer depends on the joined identity at all — the mission
 *     comes from `hq_mission_plan_items.mission_id`, which is write-once by its
 *     own `no_remission` guard, and `hq_missions` is consulted through a LEFT
 *     join for the project only. That half is proven with the guard DROPPED,
 *     because a guard is three statements and this must hold without it.
 *
 * The surviving residual is executed too, and priced rather than asserted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { expectOk } from './application.fixture.js';
import { claimSideEffectTask } from './reliability.fixture.js';
import { intelligenceFixture, type IntelligenceFixture } from './intelligence.fixture.js';
import { INTELLIGENCE_TIERS } from '../src/application/intelligence-command.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  WRITE_ONCE_IDENTITY_TABLES,
  declaredGuardsFor,
  declaredIdentityGuardFor,
  missingImmutabilityGuards,
  structuralIntegrity,
} from '../src/store/integrity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SOURCE = path.join(HERE, '..', 'src', 'application', 'service.ts');

interface Scene {
  fx: IntelligenceFixture;
  missionId: string;
  /** The task that SPENT — its own recorded attribution also names the mission. */
  spenderTaskId: string;
  /** The task with NO recorded spend, whose only tie to the ceiling is the plan item. */
  taskId: string;
  fence: number;
  workerId: string;
}

/**
 * A MISSION ceiling exhausted by task A, and a task B in the SAME mission that
 * has recorded no spend of its own.
 *
 * Task B is the one every assertion below is made about, and the reason is
 * exact: for the SPENDER, `#recordedScopesForTask`'s `spentUnder` union names
 * the mission independently, so the canonical derivation could be broken
 * outright and the ceiling would still bind. Only a task whose ONLY tie to the
 * ceiling is its plan item measures the derivation this round corrects.
 */
function scene(): Scene {
  const fx = intelligenceFixture();
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
  return {
    fx,
    missionId: mission.id,
    spenderTaskId: fx.claim.taskId,
    taskId: attacked.taskId,
    fence: attacked.fence,
    workerId: attacked.workerId,
  };
}

function proposal(current: Scene) {
  return expectOk(
    current.fx.ops.intelligenceRoutingProposal({
      taskId: current.taskId,
      complexity: 'routine',
      contextSize: 'medium',
      workKind: 'coding',
    }),
  );
}

function scopeKinds(current: Scene): string[] {
  return proposal(current)
    .governedBy.map((scope) => String(scope.scopeKind))
    .sort();
}

function criticalReviewAccepted(current: Scene, key: string): boolean {
  return current.fx.ops.recordIntelligenceDecision({
    taskId: current.taskId,
    workerId: current.workerId,
    fence: current.fence,
    tier: 'critical_review',
    label: 'the write the exhausted ceiling should refuse',
    complexity: 'routine',
    contextSize: 'medium',
    workKind: 'coding',
    idempotencyKey: key,
  }).ok;
}

/** The state the exploit had to move: the ceiling binds and the write is refused. */
function expectCeilingBinds(current: Scene, tag: string): void {
  const seen = proposal(current);
  expect(scopeKinds(current), tag).toEqual(['deployment', 'mission']);
  expect(seen.permittedTiers, tag).toEqual(['deterministic_local']);
  expect(String((seen as unknown as { budgetDecision: unknown }).budgetDecision), tag).toBe(
    'blocked',
  );
  expect(criticalReviewAccepted(current, `${tag}-critical`), tag).toBe(false);
}

describe('a row identity that other tables join to is write-once', () => {
  it('refuses UPDATE hq_missions SET id, on twelve fresh identities', () => {
    const current = scene();
    try {
      expectCeilingBinds(current, 'before');
      const raw = current.fx.db as unknown as Database.Database;
      const rowsBefore = (raw.prepare(`SELECT COUNT(*) AS n FROM hq_missions`).get() as { n: number })
        .n;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        expect(() =>
          raw
            .prepare(`UPDATE hq_missions SET id = ? WHERE id = ?`)
            .run(`rewritten-${attempt}`, current.missionId),
        ).toThrow(/hq_missions identity is write-once/);
      }
      expect((raw.prepare(`SELECT COUNT(*) AS n FROM hq_missions`).get() as { n: number }).n).toBe(
        rowsBefore,
      );
      expectCeilingBinds(current, 'after-mission-rewrite');
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file, so
      // there is nothing to clean up beyond letting it go out of scope.
      current.fx.db.close();
    }
  });

  it('refuses UPDATE op_tasks SET id, on twelve fresh identities', () => {
    const current = scene();
    try {
      expectCeilingBinds(current, 'before');
      const raw = current.fx.db as unknown as Database.Database;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        expect(() =>
          raw.prepare(`UPDATE op_tasks SET id = ? WHERE id = ?`).run(`rewritten-${attempt}`, current.taskId),
        ).toThrow(/op_tasks id is write-once/);
      }
      expectCeilingBinds(current, 'after-task-rewrite');
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file, so
      // there is nothing to clean up beyond letting it go out of scope.
      current.fx.db.close();
    }
  });

  /**
   * The read-side half, proven WITHOUT the guard, because a guard is three
   * statements and the derivation has to hold on its own. The mission comes
   * from the plan item's own write-once `mission_id`; `hq_missions` is joined
   * LEFT and only for the project.
   */
  it('holds the mission ceiling with the identity guard dropped and the id rewritten', () => {
    const current = scene();
    try {
      expectCeilingBinds(current, 'before');
      const raw = current.fx.db as unknown as Database.Database;
      raw.exec(`DROP TRIGGER trg_hq_missions_no_reidentify`);
      raw.prepare(`UPDATE hq_missions SET id = ? WHERE id = ?`).run('rewritten', current.missionId);
      expect(
        (raw.prepare(`SELECT COUNT(*) AS n FROM hq_missions WHERE id = ?`).get(current.missionId) as {
          n: number;
        }).n,
        'the mission row really is renamed',
      ).toBe(0);
      // And the ceiling still binds: the derivation never needed that row's id.
      expectCeilingBinds(current, 'after-raw-rewrite-without-guard');
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file, so
      // there is nothing to clean up beyond letting it go out of scope.
      current.fx.db.close();
    }
  });

  /**
   * The derivation is pinned at the source too, because the defect was one
   * word: an inner join where a LEFT one belonged, on a table whose identity is
   * not the authority for the link.
   */
  it('derives the mission from the plan item column, never from the joined row', () => {
    const source = fs.readFileSync(SERVICE_SOURCE, 'utf8');
    const derivation = source.slice(
      source.indexOf('#canonicalTaskScopes(taskId: string)'),
      source.indexOf('#governingBudgetScopes(taskId: string)'),
    );
    expect(derivation.length).toBeGreaterThan(0);
    expect(derivation).toContain('p.mission_id AS mission_id');
    expect(derivation).toContain('LEFT JOIN hq_missions');
    expect(derivation, 'an inner join here is the defect this test exists for').not.toMatch(
      /\n\s+JOIN hq_missions/,
    );
  });
});

describe('the identity guards are declared, so their absence is a finding', () => {
  it('reports each of them missing when it is dropped', () => {
    const current = scene();
    try {
      const raw = current.fx.db as unknown as Database.Database;
      expect(missingImmutabilityGuards(raw as never)).toEqual([]);
      raw.exec(`DROP TRIGGER trg_hq_missions_no_reidentify`);
      raw.exec(`DROP TRIGGER trg_op_tasks_no_reidentify`);
      expect(missingImmutabilityGuards(raw as never)).toEqual([
        'trg_hq_missions_no_reidentify',
        'trg_op_tasks_no_reidentify',
      ]);
      // And the finding is BLOCKING, which is what makes the declaration worth
      // having rather than a comment.
      const report = structuralIntegrity(raw as never, {
        guardsMissingAsFound: missingImmutabilityGuards(raw as never),
      });
      expect(report.safeMode).toBe(true);
      expect(report.observations.map((observation) => observation.finding)).toContain(
        'append_only_guard_missing',
      );
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file, so
      // there is nothing to clean up beyond letting it go out of scope.
      current.fx.db.close();
    }
  });

  it('declares hq_missions’ identity guard on the ledger entry, not in a second place', () => {
    const entry = ENGINE_IMMUTABLE_TABLES.find((candidate) => candidate.table === 'hq_missions');
    expect(entry).toBeDefined();
    expect(declaredGuardsFor(entry!)).toContain('trg_hq_missions_no_reidentify');
    // And `op_tasks` is NOT a declared append-only ledger — it is legitimately
    // updated on almost every column — so it is declared in the identity list.
    expect(ENGINE_IMMUTABLE_TABLES.map((candidate) => candidate.table)).not.toContain('op_tasks');
    expect(WRITE_ONCE_IDENTITY_TABLES.map((candidate) => candidate.table)).toEqual(['op_tasks']);
    expect(declaredIdentityGuardFor(WRITE_ONCE_IDENTITY_TABLES[0]!)).toBe('trg_op_tasks_no_reidentify');
  });

  /** Frozen all the way down, for the reason `ENGINE_IMMUTABLE_TABLES` is. */
  it('cannot be emptied through the exported constant', () => {
    expect(Object.isFrozen(WRITE_ONCE_IDENTITY_TABLES)).toBe(true);
    expect(() => {
      (WRITE_ONCE_IDENTITY_TABLES as unknown as { length: number }).length = 0;
    }).toThrow();
    expect(() => {
      (WRITE_ONCE_IDENTITY_TABLES[0] as unknown as { table: string }).table = 'nothing';
    }).toThrow();
    expect(WRITE_ONCE_IDENTITY_TABLES.length).toBe(1);
  });
});

describe('what the guards do NOT close, executed at the price the disclosure states', () => {
  /**
   * `op_tasks`' identity guard is a trigger, so it is the same three-statement
   * residual every engine guard in this package carries. With it dropped, the
   * rename really does detach the task: `hq_mission_plan_items.task_id` names
   * the task by ID and there is no second key to resolve it by, so no read-side
   * derivation can hold this one. Asserted so that CLOSING it fails here and
   * sends whoever closed it to the disclosure, rather than leaving a stale
   * residual on the page.
   */
  it('still detaches a task whose id is rewritten with the guard dropped, in three statements', () => {
    const current = scene();
    try {
      expectCeilingBinds(current, 'before');
      const raw = current.fx.db as unknown as Database.Database;
      const guard = (
        raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
          .get('trg_op_tasks_no_reidentify') as { sql: string }
      ).sql;
      let statements = 0;
      raw.exec(`DROP TRIGGER trg_op_tasks_no_reidentify`);
      statements += 1;
      raw.prepare(`UPDATE op_tasks SET id = ? WHERE id = ?`).run('renamed-task', current.taskId);
      statements += 1;
      raw.exec(guard);
      statements += 1;
      expect(statements).toBe(3);

      const renamed: Scene = { ...current, taskId: 'renamed-task' };
      expect(scopeKinds(renamed), 'the residual: the mission scope is gone').toEqual(['deployment']);
      expect(proposal(renamed).permittedTiers.length).toBe(INTELLIGENCE_TIERS.length);
      // And it is invisible to the structural depth, which is the other half of
      // the disclosure.
      expect(missingImmutabilityGuards(raw as never)).toEqual([]);
      expect(structuralIntegrity(raw as never, {}).safeMode).toBe(false);
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file, so
      // there is nothing to clean up beyond letting it go out of scope.
      current.fx.db.close();
    }
  });
});

/**
 * Wave 5, correction round thirteen — Medium 6 and Medium 7: two defences that
 * reached this head with nothing pinning them.
 *
 * Round four added the recorded-attribution union so that a ceiling a task has
 * ALREADY spent under keeps governing it however the canonical link is later
 * broken. Both halves of that union were unasserted: removing either left the
 * whole suite green (3425 tests), and no test in the package referenced
 * `entry.missionIds`, `#recordedScopesForTask` or `spentUnder` at all.
 *
 * They are load-bearing by execution, and the scenario that shows it is the
 * disclosed count-preserving rewrite of the canonical link: drop the plan item's
 * `no_remission` guard, re-point `mission_id`, put the guard back. The canonical
 * derivation then correctly finds no mission — the link really is gone — and the
 * ONLY reason the exhausted ceiling still binds, and the only reason the
 * Founder's report still reads `blocked` rather than `within_ceiling`, is that
 * the task's own recorded spend named that mission when it was filed.
 */
describe('a ceiling a task has already spent under keeps governing it', () => {
  /** Break the canonical link the way the residual list prices it: three statements. */
  function unlinkCanonically(raw: Database.Database): void {
    const guard = (
      raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
        .get('trg_hq_mission_plan_items_no_remission') as { sql: string }
    ).sql;
    raw.exec(`DROP TRIGGER trg_hq_mission_plan_items_no_remission`);
    raw.prepare(`UPDATE hq_mission_plan_items SET mission_id = 'nowhere'`).run();
    raw.exec(guard);
  }

  function spenderProposal(current: Scene) {
    return expectOk(
      current.fx.ops.intelligenceRoutingProposal({
        taskId: current.spenderTaskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
  }

  it('keeps the mission in the GOVERNING set through a canonical unlink (the spentUnder union)', () => {
    const current = scene();
    try {
      const raw = current.fx.db as unknown as Database.Database;
      expect(
        spenderProposal(current).governedBy.map((scope) => String(scope.scopeKind)).sort(),
      ).toEqual(['deployment', 'mission']);

      unlinkCanonically(raw);

      // The canonical derivation now correctly finds nothing — the link really
      // is gone — and the task that never spent loses the mission scope, which
      // is the honest answer for it.
      expect(scopeKinds(current), 'the non-spender has no tie left').toEqual(['deployment']);
      // The SPENDER keeps it, and only the recorded union can be why.
      const after = spenderProposal(current);
      expect(after.governedBy.map((scope) => String(scope.scopeKind)).sort()).toEqual([
        'deployment',
        'mission',
      ]);
      expect(after.governedBy.map((scope) => String(scope.scopeId))).toContain(current.missionId);
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file, so
      // there is nothing to clean up beyond letting it go out of scope.
      current.fx.db.close();
    }
  });

  it('keeps the recorded spend inside the MEASUREMENT through the same unlink', () => {
    const current = scene();
    try {
      const raw = current.fx.db as unknown as Database.Database;
      unlinkCanonically(raw);

      const after = spenderProposal(current);
      const mission = after.governedBy.find((scope) => String(scope.scopeKind) === 'mission');
      expect(mission, 'the governing set must still carry it for the measurement to matter').toBeDefined();
      // The figure the Founder is shown, and the enforcement, still agree — and
      // the only term that can supply the 5000 is the attribution recorded on
      // the cost entry itself, because the canonical membership is gone. A
      // governing scope whose MEASUREMENT came back empty would read
      // `within_ceiling` here, which is exactly the report/enforcement
      // disagreement this term exists to prevent.
      expect(String((after as unknown as { budgetDecision: unknown }).budgetDecision)).toBe('blocked');
      // `blocked` is only reachable when the measurement found the 5000: a
      // governing scope whose spend came back empty reads `within_ceiling`,
      // which is exactly the report/enforcement disagreement this term
      // prevents. The unmeasured case is asserted below by its consequence.
      expect(String((after as unknown as { refusal: unknown }).refusal ?? '')).not.toBe('');
      expect(after.permittedTiers).toEqual(['deterministic_local']);
      expect(
        current.fx.ops.recordIntelligenceDecision({
          taskId: current.spenderTaskId,
          workerId: 'claude',
          fence: current.fx.claim.fence,
          tier: 'critical_review',
          label: 'the write the exhausted ceiling should still refuse',
          complexity: 'routine',
          contextSize: 'medium',
          workKind: 'coding',
          idempotencyKey: 'after-unlink',
        }).ok,
      ).toBe(false);
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file, so
      // there is nothing to clean up beyond letting it go out of scope.
      current.fx.db.close();
    }
  });
});
