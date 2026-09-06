/**
 * Phase 6 — the orchestrator-command module itself (issue #265): the
 * capability trio recipe, the pure decision core's precedence, the derived
 * idempotency key, the run tables' engine-held append-only guarantee, the
 * plan-item spec write-once trigger, and the mission digest's back-compat.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  missionOrchestrateCapabilityState,
  missionOrchestrateContractDrift,
  orchestrationTaskIdempotencyKey,
  planOrchestration,
  registerMissionOrchestrateCapability,
  type ObservedPlanItem,
} from '../src/application/orchestrator-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  missionCommandIdempotencyKey,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';

function observed(over: Partial<ObservedPlanItem> = {}): ObservedPlanItem {
  return {
    seq: 1,
    kind: 'work',
    superseded: false,
    taskId: null,
    taskStatus: null,
    reviewPending: false,
    claimedBy: null,
    specCapabilityId: 'repo.read_status',
    specPayload: '{"intent":"go"}',
    specCapabilityState: 'enabled',
    founderHoldsOriginate: true,
    specScopeKillSwitchEngaged: false,
    ...over,
  };
}

describe('the capability trio', () => {
  it('classifies missing/altered/disabled/enabled with drift checked before enabled', () => {
    expect(missionOrchestrateCapabilityState(null)).toBe('missing');
    const db = setupFixture().db;
    registerMissionOrchestrateCapability(db);
    const row = () =>
      new CapabilityRegistry(db).get(MISSION_ORCHESTRATE_CAPABILITY.id)!;
    expect(missionOrchestrateCapabilityState(row())).toBe('enabled');
    db.prepare(`UPDATE op_capabilities SET side_effect = 1 WHERE id = ?`).run(MISSION_ORCHESTRATE_CAPABILITY.id);
    expect(missionOrchestrateCapabilityState(row())).toBe('altered');
    expect(missionOrchestrateContractDrift(row())).toEqual(['sideEffect']);
    db.prepare(`UPDATE op_capabilities SET side_effect = 0 WHERE id = ?`).run(MISSION_ORCHESTRATE_CAPABILITY.id);
    new CapabilityRegistry(db).setEnabled(MISSION_ORCHESTRATE_CAPABILITY.id, false);
    expect(missionOrchestrateCapabilityState(row())).toBe('disabled');
  });
});

describe('planOrchestration — the pure decision core', () => {
  it('applies the stated per-item precedence and orders by seq', () => {
    const decisions = planOrchestration([
      observed({ seq: 7 }),
      observed({ seq: 1, superseded: true }),
      observed({ seq: 2, kind: 'needs_clarification', specCapabilityId: null, specPayload: null }),
      observed({ seq: 3, taskId: 't-1', taskStatus: 'blocked', claimedBy: 'claude' }),
      observed({ seq: 4, specCapabilityId: null, specPayload: null }),
      observed({ seq: 5, specCapabilityState: 'missing' }),
      observed({ seq: 6, founderHoldsOriginate: false }),
    ]);
    expect(decisions.map((d) => [d.planItemSeq, d.decision])).toEqual([
      [1, 'skipped_superseded'],
      [2, 'not_actionable_needs_clarification'],
      [3, 'observed_linked'],
      [4, 'not_actionable_unspecified'],
      [5, 'capability_unknown'],
      [6, 'originate_not_granted'],
      [7, 'ready'],
    ]);
    // The blocked task with its retained claimant is reported VERBATIM — the
    // accepted hostile-rejection posture, execution-inert and visible.
    const linked = decisions.find((d) => d.decision === 'observed_linked')!;
    expect(linked.detail).toEqual({ taskId: 't-1', taskStatus: 'blocked', reviewPending: false, claimedBy: 'claude' });
  });

  it('is deterministic — same observation, same decisions', () => {
    const items = [observed({ seq: 2 }), observed({ seq: 1, specCapabilityId: null, specPayload: null })];
    expect(planOrchestration(items)).toEqual(planOrchestration(items));
  });
});

describe('the derived task idempotency key', () => {
  it('is stable for the same inputs and distinct for a changed payload/seq/mission', () => {
    const base = { missionId: 'm-1', planItemSeq: 1, capabilityId: 'repo.read_status', payload: '{"a":1}' };
    expect(orchestrationTaskIdempotencyKey(base)).toBe(orchestrationTaskIdempotencyKey({ ...base }));
    expect(orchestrationTaskIdempotencyKey(base)).toMatch(/^mission-task:/);
    expect(orchestrationTaskIdempotencyKey({ ...base, payload: '{"a":2}' })).not.toBe(
      orchestrationTaskIdempotencyKey(base),
    );
    expect(orchestrationTaskIdempotencyKey({ ...base, planItemSeq: 2 })).not.toBe(
      orchestrationTaskIdempotencyKey(base),
    );
    expect(orchestrationTaskIdempotencyKey({ ...base, missionId: 'm-2' })).not.toBe(
      orchestrationTaskIdempotencyKey(base),
    );
  });
});

describe('mission digest back-compat', () => {
  it('key(without specs) === key(specs: []) — stored Phase 3/4 keys keep deduping', () => {
    const base = {
      requestedBy: 'founder',
      title: 'T',
      objective: 'O',
      scope: null,
      constraints: [],
      acceptanceCriteria: null,
      project: null,
      priority: null,
      sourceOrderTaskId: null,
      dependsOn: [],
      planItems: ['Item'],
      instruction: null,
      idempotencyKey: null,
    };
    expect(missionCommandIdempotencyKey(base)).toBe(
      missionCommandIdempotencyKey({ ...base, planItemSpecs: [] }),
    );
    expect(
      missionCommandIdempotencyKey({
        ...base,
        planItemSpecs: [{ seq: 1, capabilityId: 'repo.read_status', payload: '{"a":1}' }],
      }),
    ).not.toBe(missionCommandIdempotencyKey(base));
  });
});

describe('engine-held guarantees', () => {
  it('run tables abort UPDATE, DELETE and every REPLACE/upsert spelling', () => {
    const fx = setupFixture();
    registerMissionCommandCapability(fx.db);
    registerMissionOrchestrateCapability(fx.db);
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, MISSION_ORCHESTRATE_CAPABILITY.id, CAPS.readStatus],
      approvalAuthority: true,
      active: true,
    });
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'T',
        objective: 'O',
        plan: [{ summary: 'W', capabilityId: CAPS.readStatus, payload: { intent: 'go' } }],
        requestedBy: 'founder',
      }),
    ).mission;
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const run = fx.db.prepare(`SELECT id FROM hq_orchestration_runs`).get() as { id: string };
    expect(() =>
      fx.db.prepare(`UPDATE hq_orchestration_runs SET summary = '{}' WHERE id = ?`).run(run.id),
    ).toThrow(/append-only/);
    expect(() => fx.db.prepare(`DELETE FROM hq_orchestration_runs WHERE id = ?`).run(run.id)).toThrow(
      /append-only/,
    );
    expect(() =>
      fx.db
        .prepare(
          `INSERT OR REPLACE INTO hq_orchestration_runs (id, mission_id, requested_by, at, observed_digest, summary)
           VALUES (?, 'forged', 'attacker', 'now', 'x', '{}')`,
        )
        .run(run.id),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db.prepare(`UPDATE hq_orchestration_run_items SET decision = 'forged'`).run(),
    ).toThrow(/append-only/);
    expect(() => fx.db.prepare(`DELETE FROM hq_orchestration_run_items`).run()).toThrow(/append-only/);
  });

  it('a stated plan-item spec is write-once at the engine', () => {
    const fx = setupFixture();
    registerMissionCommandCapability(fx.db);
    registerMissionOrchestrateCapability(fx.db);
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, CAPS.readStatus],
      approvalAuthority: true,
      active: true,
    });
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'T',
        objective: 'O',
        plan: [{ summary: 'W', capabilityId: CAPS.readStatus, payload: { intent: 'go' } }],
        requestedBy: 'founder',
      }),
    ).mission;
    expect(() =>
      fx.db
        .prepare(`UPDATE hq_mission_plan_items SET spec_capability_id = 'forged' WHERE mission_id = ?`)
        .run(mission.id),
    ).toThrow(/write-once/);
    expect(() =>
      fx.db
        .prepare(`UPDATE hq_mission_plan_items SET spec_payload = '{"forged":true}' WHERE mission_id = ?`)
        .run(mission.id),
    ).toThrow(/write-once/);
    // And the facade path refuses re-specifying through the amendment door.
    const respec = fx.ops.amendMissionIntent({
      missionId: mission.id,
      amendment: 'Try to change the stated work in place.',
      specifyPlanItems: [{ seq: 1, capabilityId: CAPS.openPr, payload: { other: true } }],
      requestedBy: 'founder',
    });
    expect(respec.ok).toBe(false);
    if (!respec.ok) expect(respec.error.message).toContain('write-once');
  });
});
