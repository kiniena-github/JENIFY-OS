/**
 * Wave 5, correction round seven — HIGH NEW-4: the ceiling fix did not cover
 * new work under an already-exhausted ceiling.
 *
 * Round four closed three routes by unioning canonical membership with the
 * attribution HQ had already recorded on a task's own cost entries, and the
 * page claimed "One rule closes all three". It closes them for a task that has
 * ALREADY RECORDED SPEND. A task that has not — new work under a ceiling some
 * other task exhausted — has no recorded attribution to union in, so it was
 * governed by `hq_missions.project_id` alone, which is a MUTABLE column.
 *
 * Reproduced against `d97b8a6`, with the project ceiling exhausted by task A
 * and the attack on task B in the same project: a principal holding only
 * `originateCapabilities: ['hq.mission_command']`, with `approvalAuthority:
 * false` and no intelligence grant, called `assignMissionToProject({ projectId:
 * null })` — a supported facade call, no raw SQL — and `permittedTiers` widened
 * from `["deterministic_local"]` to all five while a `critical_review` decision
 * was ACCEPTED. That same principal calling `setIntelligenceBudget` directly is
 * correctly `refused(not_permitted)`, which is what makes the facade route an
 * authority BYPASS rather than an authority. A raw `UPDATE hq_missions SET
 * project_id = NULL` did the same.
 *
 * What closes it: project membership is derived from the APPEND-ONLY mission
 * event log as well as from the current column, so clearing the link narrows
 * nothing — the act of clearing it is itself the record that the project once
 * governed. See `#durableTaskProjectScopes`.
 *
 * The half that already worked is pinned here too, because a fix that traded
 * one for the other would be no fix: a task with its own recorded spend keeps
 * `governedBy: task_project` and `observed 5000`.
 */

import { describe, expect, it } from 'vitest';
import { expectOk, CAPS } from './application.fixture.js';
import { claimSideEffectTask } from './reliability.fixture.js';
import { intelligenceFixture, type IntelligenceFixture } from './intelligence.fixture.js';
import { INTELLIGENCE_TIERS } from '../src/application/intelligence-command.js';
import { MISSION_COMMAND_CAPABILITY } from '../src/application/mission-command.js';
import type { HeadquarterOperations } from '../src/application/service.js';

/** The principal the exploit is executed as: mission authority and nothing else. */
const ATTACKER = 'mission-commander-only';

interface Scene {
  fx: IntelligenceFixture;
  projectId: string;
  missionB: string;
  taskB: string;
  fenceB: number;
}

/**
 * A project whose ceiling is exhausted by task A, and a SECOND task in the same
 * project that has spent nothing of its own.
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

  // A second mission in the SAME project, carrying a second task.
  const claimB = claimSideEffectTask(fx, 'the-attacked-task');
  const taskB = claimB.taskId;
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
      taskId: taskB,
      requestedBy: 'founder',
    }),
  );

  // The deployment baseline permits everything; the PROJECT ceiling is what
  // binds, and task A exhausts it.
  fx.budget([...INTELLIGENCE_TIERS]);
  // The project policy permits the free local tier only, so when it drops out
  // of the governing set the permitted set WIDENS -- which is the half of the
  // exploit that let a `critical_review` decision be recorded.
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
  return { fx, projectId: canonical.projectId, missionB: missionB.id, taskB, fenceB: claimB.fence };
}

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

function decideOn(
  fx: IntelligenceFixture,
  taskId: string,
  fence: number,
  over: Record<string, unknown> = {},
) {
  return fx.ops.recordIntelligenceDecision({
    taskId,
    workerId: 'claude',
    fence,
    label: 'the write the ceiling should refuse',
    complexity: 'routine',
    contextSize: 'medium',
    workKind: 'coding',
    ...over,
  } as Parameters<HeadquarterOperations['recordIntelligenceDecision']>[0]);
}

describe('an exhausted ceiling still governs work that has spent nothing under it', () => {
  it('keeps governing after the SUPPORTED facade call that used to clear the link', () => {
    const { fx, projectId, missionB, taskB, fenceB } = scene();

    // Before the attack: the project ceiling governs task B and blocks it.
    const before = proposalFor(fx, taskB);
    expect(before.governedBy.map((scope) => `${scope.scopeKind}:${scope.scopeId}`)).toContain(
      `project:${projectId}`,
    );
    expect([...before.permittedTiers]).toEqual(['deterministic_local']);
    expect(decideOn(fx, taskB, fenceB, { tier: 'critical_review' }).ok).toBe(false);

    // The principal that performs the attack cannot touch the ceiling itself —
    // which is exactly what makes the route below a bypass and not an authority.
    const direct = fx.ops.setIntelligenceBudget({
      scopeKind: 'project',
      scopeId: projectId,
      window: 'total',
      ceilingMinorUnits: 10_000_000,
      currency: 'USD',
      permittedTiers: [...INTELLIGENCE_TIERS],
      setBy: ATTACKER,
    });
    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error('unreachable');
    expect(direct.error.code).toBe('not_permitted');

    // The exploit, executed as that principal: one supported facade call.
    expectOk(
      fx.ops.assignMissionToProject({ missionId: missionB, projectId: null, requestedBy: ATTACKER }),
    );

    const after = proposalFor(fx, taskB);
    expect(after.governedBy.map((scope) => `${scope.scopeKind}:${scope.scopeId}`)).toContain(
      `project:${projectId}`,
    );
    expect(after.governedBy.find((scope) => scope.scopeId === projectId)?.derivedFrom).toBe(
      'task_project',
    );
    expect([...after.permittedTiers]).toEqual(['deterministic_local']);
    expect(after.budgetDecision).toBe('blocked');

    const refused = decideOn(fx, taskB, fenceB, {
      tier: 'critical_review',
      idempotencyKey: 'after-the-unlink',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error.code).toBe('budget_ceiling_blocks');
  });

  it('keeps governing after the RAW write that clears the same column', () => {
    const { fx, projectId, missionB, taskB, fenceB } = scene();
    fx.db.prepare(`UPDATE hq_missions SET project_id = NULL WHERE id = ?`).run(missionB);

    const after = proposalFor(fx, taskB);
    expect(after.governedBy.map((scope) => `${scope.scopeKind}:${scope.scopeId}`)).toContain(
      `project:${projectId}`,
    );
    expect([...after.permittedTiers]).toEqual(['deterministic_local']);
    const refused = decideOn(fx, taskB, fenceB, { tier: 'high', idempotencyKey: 'after-raw-unlink' });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error.code).toBe('budget_ceiling_blocks');
  });

  it('keeps the Founder’s spend figure visible on both sides of the unlink', () => {
    const { fx, projectId, missionB } = scene();
    const before = expectOk(
      fx.ops.intelligenceBudgetDecision({ scopeKind: 'project', scopeId: projectId, window: 'total' }),
    );
    expect({ decision: before.decision, observed: before.observedMinorUnits }).toEqual({
      decision: 'blocked',
      observed: 5000,
    });
    expectOk(
      fx.ops.assignMissionToProject({ missionId: missionB, projectId: null, requestedBy: ATTACKER }),
    );
    const after = expectOk(
      fx.ops.intelligenceBudgetDecision({ scopeKind: 'project', scopeId: projectId, window: 'total' }),
    );
    expect({ decision: after.decision, observed: after.observedMinorUnits }).toEqual({
      decision: 'blocked',
      observed: 5000,
    });
  });

  it('invents no scope: a task in no project is governed by the deployment baseline alone', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    // No mission, no project, no history — the derivation must add nothing.
    const unlinked = claimSideEffectTask(fx, 'belongs-to-nothing').taskId;
    const proposal = proposalFor(fx, unlinked);
    expect(proposal.governedBy.map((scope) => scope.scopeKind)).toEqual(['deployment']);
    expect([...proposal.permittedTiers]).toEqual([...INTELLIGENCE_TIERS]);
    // And a mission that has never been assigned to a project contributes none
    // either: `assignMissionToProject` is the only act that records one.
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'Mission with no project',
        objective: 'Belong to no project at all',
        planItems: ['Belong to no project at all'],
        requestedBy: 'founder',
      }),
    ).mission;
    expectOk(
      fx.ops.linkMissionPlanItem({
        missionId: mission.id,
        planItemSeq: 1,
        taskId: unlinked,
        requestedBy: 'founder',
      }),
    );
    const linked = proposalFor(fx, unlinked);
    expect(linked.governedBy.map((scope) => scope.scopeKind)).toEqual(['deployment']);
    expect(CAPS.openPr).toBeTruthy();
  });
});
