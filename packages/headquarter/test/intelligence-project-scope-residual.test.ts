/**
 * Wave 5, correction round ten — Medium 1: the project-scope derivation was
 * documented as "unforgeable", and the residual priced the attack above its
 * cheapest path.
 *
 * The round-seven fix is real and is pinned next door
 * (`intelligence-project-scope-durability.test.ts`): a THIRD term derived from
 * the append-only mission event log, so clearing a mission's project link
 * narrows nothing. What was false was the prose around it. Phase 14 said the
 * term was "monotone and unforgeable … because `hq_mission_events` is
 * engine-guarded (`no_rewrite`, `no_erase`, `no_replace`)", and scoped the
 * residual to "a mission created with a project by a build older than the
 * commanded-event detail, never re-assigned through the facade".
 *
 * Both are false at the cheapest path. A guard is a row in `sqlite_master`, and
 * `hq_mission_events` carries no hash chain, so a CURRENT-build mission that
 * WAS assigned through the facade is stripped by three `DROP TRIGGER`, one
 * count-preserving `UPDATE … json_remove(...)`, three `CREATE TRIGGER` and one
 * `UPDATE hq_missions SET project_id = NULL`. No `DELETE`, no `INSERT`, no
 * row-count change, no restart, no Founder act.
 *
 * That is a DISCLOSURE defect and it is corrected as one: the word is gone from
 * the code and the page, and the count-preserving in-place rewrite class — the
 * class Phase 13's residual list already carries for every guarded-but-unhashed
 * ledger — is now carried for this ledger too. This file holds all three halves
 * of that correction to the behaviour, so none of them can drift:
 *
 *  1. every SUPPORTED route is still refused its effect (the fix itself);
 *  2. the residual really is reachable at the cost the disclosure states, and
 *     really is invisible to both integrity depths (so the disclosure is not
 *     over-stating a threat either);
 *  3. the prose no longer carries the absolute, and does carry the class.
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
import { MISSION_COMMAND_CAPABILITY } from '../src/application/mission-command.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  WRITE_ONCE_IDENTITY_TABLES,
  fullIntegrity,
  missingImmutabilityGuards,
  structuralIntegrity,
} from '../src/store/integrity.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SOURCE = path.join(HERE, '..', 'src', 'application', 'service.ts');
const PHASE_14 = path.join(
  HERE,
  '..',
  '..',
  '..',
  'docs',
  'HEADQUARTER',
  'PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md',
);

const ATTACKER = 'mission-commander-only';

interface Scene {
  fx: IntelligenceFixture;
  projectId: string;
  missionB: string;
  taskB: string;
  fenceB: number;
}

/**
 * A project ceiling exhausted by task A, and a second task B in the same
 * project that has recorded no spend of its own — the state the round-seven
 * finding was reproduced in.
 */
function scene(): Scene {
  const fx = intelligenceFixture();
  fx.principals.register({
    id: ATTACKER,
    displayName: 'Holds mission command and nothing else',
    originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });
  const canonical = fx.linkToCanonicalMission(fx.claim.taskId, 'exhausting');
  const claimB = claimSideEffectTask(fx, 'the-attacked-task');
  const missionB = expectOk(
    fx.ops.commandMission({
      title: 'Mission carrying the new work',
      objective: 'Do work under a ceiling somebody else exhausted',
      planItems: ['Do work under a ceiling somebody else exhausted'],
      projectId: canonical.projectId,
      requestedBy: 'founder',
    }),
  ).mission;
  expectOk(
    fx.ops.linkMissionPlanItem({
      missionId: missionB.id,
      planItemSeq: 1,
      taskId: claimB.taskId,
      requestedBy: 'founder',
    }),
  );
  fx.budget([...INTELLIGENCE_TIERS]);
  fx.budget(['deterministic_local'], {
    scopeKind: 'project',
    scopeId: canonical.projectId,
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
    projectId: canonical.projectId,
    missionB: missionB.id,
    taskB: claimB.taskId,
    fenceB: claimB.fence,
  };
}

/** The two published figures the exploit moves. */
function proposalFor(fx: IntelligenceFixture, taskId: string) {
  return expectOk(
    fx.ops.intelligenceRoutingProposal({
      taskId,
      complexity: 'routine',
      contextSize: 'medium',
      workKind: 'coding',
    }),
  );
}

function governedBy(fx: IntelligenceFixture, taskId: string): string[] {
  return proposalFor(fx, taskId)
    .governedBy.map((scope) => String(scope.scopeKind))
    .sort();
}

function permittedTierCount(fx: IntelligenceFixture, taskId: string): number {
  return proposalFor(fx, taskId).permittedTiers.length;
}

function criticalReviewAccepted(scene_: Scene, key: string): boolean {
  return scene_.fx.ops.recordIntelligenceDecision({
    taskId: scene_.taskB,
    workerId: 'claude',
    fence: scene_.fenceB,
    tier: 'critical_review',
    label: 'the write the ceiling should refuse',
    complexity: 'routine',
    contextSize: 'medium',
    workKind: 'coding',
    idempotencyKey: key,
  }).ok;
}

describe('every supported route into the project scope is still refused its effect', () => {
  it('holds the ceiling through the facade call and through the raw column write', () => {
    const current = scene();
    const { fx } = current;
    expect(governedBy(fx, current.taskB)).toEqual(['deployment', 'project']);
    expect(permittedTierCount(fx, current.taskB)).toBe(1);
    expect(criticalReviewAccepted(current, 'before')).toBe(false);

    // (a) The supported facade call, by a principal holding mission command and
    // nothing else. This is the route the round-seven finding used.
    expectOk(
      fx.ops.assignMissionToProject({
        missionId: current.missionB,
        projectId: null,
        requestedBy: ATTACKER,
      }),
    );
    expect(governedBy(fx, current.taskB)).toEqual(['deployment', 'project']);
    expect(permittedTierCount(fx, current.taskB)).toBe(1);
    expect(criticalReviewAccepted(current, 'after-facade')).toBe(false);

    // (b) The raw mutable column, with no guard touched.
    (fx.db as unknown as Database.Database).exec(
      `UPDATE hq_missions SET project_id = NULL WHERE id = '${current.missionB}'`,
    );
    expect(governedBy(fx, current.taskB)).toEqual(['deployment', 'project']);
    expect(permittedTierCount(fx, current.taskB)).toBe(1);
    expect(criticalReviewAccepted(current, 'after-raw-column')).toBe(false);
  });
});

describe('the disclosed residual is reachable at the cost the disclosure states', () => {
  it('strips the scope by a count-preserving in-place rewrite, invisibly to both depths', () => {
    const current = scene();
    const { fx } = current;
    const raw = fx.db as unknown as Database.Database;
    expect(permittedTierCount(fx, current.taskB)).toBe(1);
    expect(criticalReviewAccepted(current, 'residual-before')).toBe(false);

    const rowsBefore = (
      raw.prepare(`SELECT COUNT(*) AS n FROM hq_mission_events`).get() as { n: number }
    ).n;

    // The cheapest path, executed exactly as the disclosure prices it.
    const guards = raw
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'hq_mission_events'`)
      .all() as { name: string; sql: string }[];
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) raw.exec(`DROP TRIGGER "${guard.name}"`);
    const rewritten = raw
      .prepare(
        `UPDATE hq_mission_events SET detail = json_remove(detail, '$.projectId', '$.to', '$.from') WHERE mission_id = ?`,
      )
      .run(current.missionB);
    for (const guard of guards) raw.exec(guard.sql);
    raw.exec(`UPDATE hq_missions SET project_id = NULL WHERE id = '${current.missionB}'`);

    // Count-preserving: no DELETE, no INSERT, and the guards are back, so the
    // schema catalogue is healthy again.
    expect(rewritten.changes).toBeGreaterThan(0);
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM hq_mission_events`).get() as { n: number }).n).toBe(
      rowsBefore,
    );
    for (const guard of guards) {
      expect(
        raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(guard.name),
        guard.name,
      ).toBeDefined();
    }

    // The residual, executed: the project term is gone and the ceiling stops
    // binding. Asserted so that CLOSING this route fails here and sends whoever
    // closed it to the disclosure, rather than leaving a stale residual behind.
    expect(governedBy(fx, current.taskB)).toEqual(['deployment']);
    expect(permittedTierCount(fx, current.taskB)).toBe(INTELLIGENCE_TIERS.length);
    expect(criticalReviewAccepted(current, 'residual-after')).toBe(true);

    // And it is invisible to the integrity machinery, which is the other half
    // of pricing it honestly: this is not a threat HQ quietly detects.
    const store = fx.db as unknown as Parameters<typeof structuralIntegrity>[0];
    const structural = structuralIntegrity(store, {});
    const full = fullIntegrity(store, { verifyEvidenceChain: () => verifyEvidenceChain(store) });
    expect(structural.safeMode).toBe(false);
    expect(structural.observations).toEqual([]);
    expect(full.safeMode).toBe(false);
    expect(full.observations).toEqual([]);
  });
});

/**
 * Wave 5, correction round twelve — Low 2: the residual's own SQL did not
 * reproduce its own effect.
 *
 * The residual says the same pass "also empties the `spentUnder` half —
 * `UPDATE hq_intel_cost_entries SET mission_ids='[]', project_ids='[]'` … takes
 * an exhausted ceiling's `observed` from 5000 to 0". It does not.
 * `recordedScopeIds` reads the JSON array column UNION the single legacy column
 * — deliberately, as the fail-closed reading — and
 * `recordIntelligenceCost` writes BOTH, so clearing the two array columns leaves
 * `mission_id` and `project_id` still naming the scope and the ceiling still
 * charged. Nothing executed that `UPDATE` before it was disclosed.
 *
 * The residual is real; its price was understated by two columns. Both are
 * executed here, so the corrected sentence is the one the suite enforces.
 */
describe('the spentUnder half of the residual costs four columns, not two', () => {
  /** The `observed` figure for a scope, through the facade that publishes it. */
  function observedFor(fx: IntelligenceFixture, scopeId: string): { decision: string; observed: number | null } {
    const view = expectOk(
      fx.ops.intelligenceBudgetDecision({ scopeKind: 'project', scopeId, window: 'total' }),
    );
    return { decision: view.decision, observed: view.observedMinorUnits };
  }

  /** Lift the ledger's guards, run one UPDATE, put them back. */
  function rewriteInPlace(raw: Database.Database, set: string): number {
    const guards = raw
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'hq_intel_cost_entries'`,
      )
      .all() as { name: string; sql: string }[];
    expect(guards.length, 'the ledger must really be guarded').toBeGreaterThan(0);
    const before = (
      raw.prepare(`SELECT COUNT(*) AS n FROM hq_intel_cost_entries`).get() as { n: number }
    ).n;
    for (const guard of guards) raw.exec(`DROP TRIGGER "${guard.name}"`);
    const changed = raw.prepare(`UPDATE hq_intel_cost_entries SET ${set}`).run().changes;
    for (const guard of guards) raw.exec(guard.sql);
    // Count-preserving, which is what makes the class invisible.
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM hq_intel_cost_entries`).get() as { n: number }).n).toBe(
      before,
    );
    return changed;
  }

  /**
   * The residual's own pass, up to but not including the cost-entry rewrite.
   *
   * The `spentUnder` sentence is the SECOND half of one pass: the first half
   * severs canonical and durable membership (`hq_mission_events` rewritten,
   * `hq_missions.project_id` cleared), and only then is the recorded
   * attribution on the cost row the last thing holding the ceiling.
   */
  function severCanonicalMembership(current: Scene): void {
    const raw = current.fx.db as unknown as Database.Database;
    const guards = raw
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'hq_mission_events'`)
      .all() as { name: string; sql: string }[];
    for (const guard of guards) raw.exec(`DROP TRIGGER "${guard.name}"`);
    raw
      .prepare(`UPDATE hq_mission_events SET detail = json_remove(detail, '$.projectId', '$.to', '$.from')`)
      .run();
    for (const guard of guards) raw.exec(guard.sql);
    raw.exec(`UPDATE hq_missions SET project_id = NULL`);
  }

  it('leaves the ceiling charged when only the two array columns are cleared', () => {
    const current = scene();
    const { fx } = current;
    const raw = fx.db as unknown as Database.Database;
    expect(observedFor(fx, current.projectId)).toEqual({ decision: 'blocked', observed: 5000 });
    severCanonicalMembership(current);
    // Still charged: the recorded attribution on the row is doing the work now,
    // which is the whole point of the union.
    expect(observedFor(fx, current.projectId).observed).toBe(5000);

    // Exactly the statement the disclosure named.
    expect(rewriteInPlace(raw, `mission_ids = '[]', project_ids = '[]'`)).toBeGreaterThan(0);

    // The singular columns still carry the attribution, so the spend is still
    // filed under the project and the ceiling still binds.
    const after = observedFor(fx, current.projectId);
    expect(after.observed, 'the two-column rewrite does not reach the spend').toBe(5000);
    expect(after.decision).toBe('blocked');
  });

  it('reaches it when the two singular columns go with them', () => {
    const current = scene();
    const { fx } = current;
    const raw = fx.db as unknown as Database.Database;
    expect(observedFor(fx, current.projectId)).toEqual({ decision: 'blocked', observed: 5000 });
    severCanonicalMembership(current);
    expect(observedFor(fx, current.projectId).observed).toBe(5000);

    expect(
      rewriteInPlace(
        raw,
        `mission_ids = '[]', project_ids = '[]', mission_id = NULL, project_id = NULL`,
      ),
    ).toBeGreaterThan(0);

    const after = observedFor(fx, current.projectId);
    expect(after.observed, 'the four-column rewrite does reach it').toBe(0);
  });

  it('states the four columns on the Phase 14 page rather than the two', () => {
    const page = fs.readFileSync(PHASE_14, 'utf8');
    expect(page).toContain(
      "UPDATE hq_intel_cost_entries SET mission_ids='[]', project_ids='[]', mission_id=NULL, project_id=NULL",
    );
    expect(page).not.toMatch(
      /UPDATE hq_intel_cost_entries SET mission_ids='\[\]', project_ids='\[\]'` under/,
    );
  });
});

describe('the prose around the derivation no longer claims an absolute the code cannot hold', () => {
  it('drops “unforgeable” from the derivation’s own header and states the rewrite class instead', () => {
    const source = fs.readFileSync(SERVICE_SOURCE, 'utf8');
    const header = /#durableTaskProjectScopes\(taskId: string\): string\[\]/.exec(source);
    expect(header, 'the derivation must still be here to have a header').toBeTruthy();
    // The docblock immediately above the method.
    const docStart = source.lastIndexOf('/**', header!.index);
    const doc = source.slice(docStart, header!.index);
    // The word may appear only where it is being RETRACTED. Naming the retired
    // claim is how a reader knows which sentence moved; asserting it away
    // entirely would push the next author into deleting the history instead.
    const asClaim = doc
      .split('\n')
      .filter((line) => /\bunforgeable\b/i.test(line) && !/used to say/i.test(line));
    expect(asClaim).toEqual([]);
    // The residual may not be scoped to an old build alone any more: the class
    // that reaches a current-build, facade-assigned mission has to be named.
    expect(doc).toMatch(/count-preserving/i);
    expect(doc).toMatch(/DROP TRIGGER/);
    // The half that IS held must still be stated, or this correction would have
    // traded a false absolute for a false alarm.
    expect(doc).toMatch(/monotone/i);
  });

  it('drops “unforgeable” from every claim in the package that rested on a trigger', () => {
    // Two more sites made the same claim about the same class of ledger, and a
    // sweep that fixed one and left the others would put the word straight back
    // on the next review.
    for (const file of [
      SERVICE_SOURCE,
      path.join(HERE, '..', 'src', 'application', 'intelligence-command.ts'),
    ]) {
      const text = fs.readFileSync(file, 'utf8');
      const offenders = text
        .split('\n')
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => /\bunforgeable\b/i.test(line) && !/NOT "unforgeable"|used to say/i.test(line));
      expect(offenders.map(([lineNumber]) => `${path.basename(file)}:${lineNumber}`)).toEqual([]);
    }
  });

  it('carries the class on the Phase 14 page rather than only in the code', () => {
    const page = fs.readFileSync(PHASE_14, 'utf8');
    // The page is where a Founder reads what is and is not held, so the
    // disclosure has to be legible there, at the cost it was executed at.
    expect(page).toMatch(/count-preserving in-place rewrite/i);
    expect(page).toMatch(/hq_mission_events/);
    expect(page).toMatch(/json_remove/);
  });
});

/**
 * A PROJECT ceiling exhausted by one task, and a second task in the same
 * project whose only tie to the ceiling is its plan item. Shared by the two
 * round-fourteen describes below.
 */
interface ProjectScene {
  fx: IntelligenceFixture;
  projectId: string;
  taskId: string;
}

function exhaustedProjectScene(): ProjectScene {
  const fx = intelligenceFixture();
  const project = expectOk(
    fx.ops.createProject({
      name: 'The project whose ceiling is exhausted',
      purpose: 'Carry the mission under test',
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
  const victim = claimSideEffectTask(fx, 'the-project-scope-victim');
  expectOk(
    fx.ops.linkMissionPlanItem({
      missionId: mission.id,
      planItemSeq: 2,
      taskId: victim.taskId,
      requestedBy: 'founder',
    }),
  );
  fx.budget([...INTELLIGENCE_TIERS]);
  fx.budget(['deterministic_local'], {
    scopeKind: 'project',
    scopeId: project.id,
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
      idempotencyKey: 'the-spend-that-exhausted-the-project',
    }),
  );
  return { fx, projectId: project.id, taskId: victim.taskId };
}

function sceneProposal(scene: ProjectScene) {
  return expectOk(
    scene.fx.ops.intelligenceRoutingProposal({
      taskId: scene.taskId,
      complexity: 'routine',
      contextSize: 'medium',
      workKind: 'coding',
    }),
  );
}

function scopeKindsFor(scene: ProjectScene): string[] {
  return sceneProposal(scene)
    .governedBy.map((scope) => String(scope.scopeKind))
    .sort();
}

/**
 * Wave 5, correction round fourteen — Medium 4: the `op_tasks.payload` route to
 * a PROVIDER ceiling is correctly disclosed and carried NO pin, so closing or
 * widening it would have been silent.
 *
 * Phase 14's NOT-fixed list says `op_tasks.payload` remains mutable and
 * uncensused, and that what still depends on the live payload is which provider
 * scope governs a NEW decision on a task that has recorded no spend of its own.
 * That is true, and it is executed here at the price it actually costs — ONE
 * `UPDATE`, no DDL, no row-count change — so that the residual cannot drift in
 * either direction: closing it fails this test and sends whoever closed it to
 * the page, and widening it fails the assertions about what still holds.
 */
describe('the disclosed op_tasks.payload route to a provider ceiling, pinned', () => {
  interface ProviderScene {
    fx: IntelligenceFixture;
    /** The task with NO recorded spend, governed only by its live binding. */
    taskId: string;
    workerId: string;
    fence: number;
  }

  /** A PROVIDER ceiling exhausted by one task, and a second bound to the same. */
  function providerScene(): ProviderScene {
    const fx = intelligenceFixture();
    const raw = fx.db as unknown as Database.Database;
    const spender = fx.claim;
    const victim = claimSideEffectTask(fx, 'the-provider-bound-victim');
    // The binding lives in the task payload, which is what the disclosure is
    // about. It is set the way the queue's own reader reads it.
    raw
      .prepare(`UPDATE op_tasks SET payload = json_set(payload, '$.executionProvider', 'CLAUDE')`)
      .run();
    fx.budget([...INTELLIGENCE_TIERS]);
    fx.budget(['deterministic_local'], {
      scopeKind: 'provider',
      scopeId: 'claude',
      window: 'total',
      ceilingMinorUnits: 1,
    });
    expectOk(
      fx.ops.recordIntelligenceCost({
        taskId: spender.taskId,
        workerId: spender.workerId,
        fence: spender.fence,
        providerId: 'claude',
        provenance: 'billed',
        amountMinorUnits: 5000,
        currency: 'USD',
        unitKind: 'requests',
        idempotencyKey: 'the-spend-that-exhausted-the-provider',
      }),
    );
    return { fx, taskId: victim.taskId, workerId: victim.workerId, fence: victim.fence };
  }

  function proposal(scene: ProviderScene) {
    return expectOk(
      scene.fx.ops.intelligenceRoutingProposal({
        taskId: scene.taskId,
        complexity: 'routine',
        contextSize: 'medium',
        workKind: 'coding',
      }),
    );
  }

  function scopeKinds(scene: ProviderScene): string[] {
    return proposal(scene)
      .governedBy.map((scope) => String(scope.scopeKind))
      .sort();
  }

  it('nullifies a provider ceiling at ONE statement, invisibly, exactly as disclosed', () => {
    const scene = providerScene();
    try {
      const raw = scene.fx.db as unknown as Database.Database;
      expect(scopeKinds(scene), 'before').toEqual(['deployment', 'provider']);
      expect(proposal(scene).permittedTiers).toEqual(['deterministic_local']);
      expect(
        String((proposal(scene) as unknown as { budgetDecision: unknown }).budgetDecision),
      ).toBe('blocked');
      expect(
        scene.fx.ops.recordIntelligenceDecision({
          taskId: scene.taskId,
          workerId: scene.workerId,
          fence: scene.fence,
          tier: 'critical_review',
          label: 'the write the exhausted provider ceiling should refuse',
          complexity: 'routine',
          contextSize: 'medium',
          workKind: 'coding',
          idempotencyKey: 'provider-critical-before',
        }).ok,
      ).toBe(false);

      const rowsBefore = (raw.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n;
      let statements = 0;
      raw
        .prepare(`UPDATE op_tasks SET payload = json_remove(payload, '$.executionProvider') WHERE id = ?`)
        .run(scene.taskId);
      statements += 1;
      expect(statements, 'one statement, no DDL — the disclosed price').toBe(1);
      expect((raw.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(
        rowsBefore,
      );

      expect(scopeKinds(scene), 'the residual: the provider scope is gone').toEqual(['deployment']);
      expect(proposal(scene).permittedTiers.length).toBe(INTELLIGENCE_TIERS.length);
      expect(
        String((proposal(scene) as unknown as { budgetDecision: unknown }).budgetDecision),
      ).toBe('within_ceiling');
      expect(
        scene.fx.ops.recordIntelligenceDecision({
          taskId: scene.taskId,
          workerId: scene.workerId,
          fence: scene.fence,
          tier: 'critical_review',
          label: 'the write the nullified ceiling now admits',
          complexity: 'routine',
          contextSize: 'medium',
          workKind: 'coding',
          idempotencyKey: 'provider-critical-after',
        }).ok,
        'the residual really does admit the refused write',
      ).toBe(true);

      // And it is invisible at both integrity depths, which is the other half
      // of the disclosure rather than an aside.
      expect(structuralIntegrity(scene.fx.db, {}).safeMode).toBe(false);
      expect(
        fullIntegrity(scene.fx.db, { verifyEvidenceChain: () => verifyEvidenceChain(scene.fx.db) })
          .safeMode,
      ).toBe(false);
    } finally {
      // The intelligence fixture is `:memory:`-backed and owns no file.
      scene.fx.db.close();
    }
  });

  /**
   * The half that still HOLDS, so the pin bounds the residual rather than only
   * demonstrating it: a provider ceiling the task has ALREADY SPENT UNDER keeps
   * governing it however the live payload is rewritten, because the attribution
   * on its own cost entries is HQ-derived and append-only.
   */
  it('keeps governing a task that has already spent under the provider ceiling', () => {
    const scene = providerScene();
    try {
      const raw = scene.fx.db as unknown as Database.Database;
      expectOk(
        scene.fx.ops.recordIntelligenceCost({
          taskId: scene.taskId,
          workerId: scene.workerId,
          fence: scene.fence,
          providerId: 'claude',
          provenance: 'billed',
          amountMinorUnits: 1,
          currency: 'USD',
          unitKind: 'requests',
          idempotencyKey: 'the-victims-own-spend',
        }),
      );
      raw
        .prepare(`UPDATE op_tasks SET payload = json_remove(payload, '$.executionProvider') WHERE id = ?`)
        .run(scene.taskId);
      expect(
        scopeKinds(scene),
        'a ceiling already spent under keeps governing, whatever the live payload says',
      ).toEqual(['deployment', 'provider']);
      expect(proposal(scene).permittedTiers).toEqual(['deterministic_local']);
    } finally {
      scene.fx.db.close();
    }
  });

  it('the phase document still carries this residual, at the price measured here', () => {
    const page = fs.readFileSync(PHASE_14, 'utf8');
    expect(page).toContain('`op_tasks.payload` remains mutable and uncensused');
    expect(page).toContain('which provider scope governs a NEW decision on');
    expect(page).toContain('intelligence-project-scope-residual.test.ts');
  });
});

/**
 * Wave 5, correction round fourteen — Low 7: `hq_projects` carries NO engine
 * guard and is in NEITHER census, and the measured effect on the budget
 * derivation is NONE.
 *
 * Both halves are executed here, and the second is why this is recorded rather
 * than closed. `hq_projects` is not in `ENGINE_IMMUTABLE_TABLES` and not in
 * `WRITE_ONCE_IDENTITY_TABLES`, so a raw `DELETE FROM hq_projects` and a raw
 * `UPDATE hq_projects SET id` are both ACCEPTED, with `missingImmutabilityGuards
 * []` and `structuralIntegrity safeMode: false` — nothing observes either. And
 * the project ceiling keeps binding through both, because project membership is
 * derived from the APPEND-ONLY mission event log (`#durableTaskProjectScopes`),
 * which records the project a mission was created under and both ends of every
 * later move, and never from the project ROW.
 *
 * That is the property this test exists to hold: if the derivation ever starts
 * reading `hq_projects` — a join added for a name, a filter added for an active
 * flag — the ceiling stops binding here and this fails, which is the moment the
 * table would need a guard and a census entry. Adding those today would declare
 * a guarantee nothing depends on, and this module's own rule is that a guard
 * nothing checks is a guard that can go missing quietly.
 */
describe('hq_projects is unguarded and uncensused, and the ceiling does not depend on it', () => {
  it('accepts a raw DELETE and a raw identity rewrite, and the project ceiling still binds', () => {
    const scene = exhaustedProjectScene();
    try {
      const raw = scene.fx.db as unknown as Database.Database;
      expect(
        raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`).all('hq_projects'),
        'the disclosure is that this table carries no guard',
      ).toEqual([]);
      expect(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table)).not.toContain('hq_projects');
      expect(WRITE_ONCE_IDENTITY_TABLES.map((entry) => entry.table)).not.toContain('hq_projects');

      const before = scopeKindsFor(scene);
      expect(before).toContain('project');

      // Both writes, each rolled back so the second measures the same state.
      for (const write of [
        () => raw.prepare(`UPDATE hq_projects SET id = ? WHERE id = ?`).run('renamed-project', scene.projectId),
        () => raw.prepare(`DELETE FROM hq_projects WHERE id = ?`).run(scene.projectId),
      ]) {
        raw.exec('SAVEPOINT unguarded_projects');
        write();
        expect(
          scopeKindsFor(scene),
          'the project ceiling is derived from the append-only mission event log, not from this row',
        ).toEqual(before);
        expect(
          String((sceneProposal(scene) as unknown as { budgetDecision: unknown }).budgetDecision),
        ).toBe('blocked');
        // And nothing observes the write, which is the other half of the record.
        expect(missingImmutabilityGuards(scene.fx.db)).toEqual([]);
        expect(structuralIntegrity(scene.fx.db, {}).safeMode).toBe(false);
        raw.exec('ROLLBACK TO unguarded_projects');
        raw.exec('RELEASE unguarded_projects');
      }
    } finally {
      scene.fx.db.close();
    }
  });

  it('the phase document records it, with the measured effect', () => {
    const page = fs.readFileSync(PHASE_14, 'utf8');
    expect(page).toContain('`hq_projects` carries no engine guard and is in neither census');
    expect(page).toContain('the measured effect on the budget derivation is NONE');
  });
});
