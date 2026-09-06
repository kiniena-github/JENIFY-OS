/**
 * Phase 6 — the orchestrator's authority boundaries (issue #265, directive
 * §14: approval, kill switch, worker truth, security).
 *
 * The step-up decision itself is route-layer (live-orchestrate-route.test.ts);
 * what this suite pins is the facade's authority floor: worker/system/unknown
 * identity refused, the trio fails closed, apply additionally demands the
 * MISSION gate, approval-gated work stops at needs_approval with ZERO
 * approval rows and no self-approval, the kill switch stops apply wholesale,
 * and Wave 1 records NO assignment intent.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { taskActionDigest } from '../src/operator/approvals.js';

function orchestratorFixture(
  options: { orchestrateGrant?: boolean; missionGrant?: boolean; register?: boolean } = {},
): Fixture {
  const fx = setupFixture();
  registerMissionCommandCapability(fx.db);
  if (options.register !== false) registerMissionOrchestrateCapability(fx.db);
  const grants: string[] = [CAPS.readStatus, CAPS.indexDoc];
  if (options.missionGrant !== false) grants.push(MISSION_COMMAND_CAPABILITY.id);
  if (options.orchestrateGrant !== false) grants.push(MISSION_ORCHESTRATE_CAPABILITY.id);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: grants,
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

function speccedMission(fx: Fixture, capabilityId: string = CAPS.readStatus) {
  return expectOk(
    fx.ops.commandMission({
      title: 'Faster QOS site',
      objective: 'Reduce page load times',
      plan: [{ summary: 'Do the work', capabilityId, payload: { intent: 'go' } }],
      requestedBy: 'founder',
    }),
  ).mission;
}

describe('identity and the capability trio, fail closed', () => {
  it('refuses worker, system and unknown identity outright, both modes', () => {
    const fx = orchestratorFixture();
    const mission = speccedMission(fx);
    for (const mode of ['preview', 'apply'] as const) {
      for (const [requestedBy, code] of [
        ['claude', 'not_permitted'],
        ['system', 'not_permitted'],
        ['nobody', 'unknown_principal'],
      ] as const) {
        const result = fx.ops.orchestrateMission({ missionId: mission.id, mode, requestedBy });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code, `${mode}:${requestedBy}`).toBe(code);
      }
    }
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
  });

  it('fails closed on a missing/altered/disabled orchestrate capability and never repairs', () => {
    const missing = orchestratorFixture({ register: false });
    const missionA = speccedMission(missing);
    const noCapability = missing.ops.orchestrateMission({ missionId: missionA.id, mode: 'preview', requestedBy: 'founder' });
    expect(noCapability.ok).toBe(false);
    if (!noCapability.ok) expect(noCapability.error.code).toBe('unknown_capability');

    const fx = orchestratorFixture();
    const mission = speccedMission(fx);
    fx.db
      .prepare(`UPDATE op_capabilities SET side_effect = 1 WHERE id = ?`)
      .run(MISSION_ORCHESTRATE_CAPABILITY.id);
    const altered = fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' });
    expect(altered.ok).toBe(false);
    if (!altered.ok) expect(altered.error.code).toBe('not_permitted');
    fx.db
      .prepare(`UPDATE op_capabilities SET side_effect = 0 WHERE id = ?`)
      .run(MISSION_ORCHESTRATE_CAPABILITY.id);
    new CapabilityRegistry(fx.db).setEnabled(MISSION_ORCHESTRATE_CAPABILITY.id, false);
    const disabled = fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe('capability_disabled');
  });

  it('apply additionally demands the MISSION gate — orchestrate alone directs nothing', () => {
    const fx = orchestratorFixture({ missionGrant: false });
    // A mission commanded by a separately granted principal.
    fx.principals.register({
      id: 'commander',
      displayName: 'Commander',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: false,
      active: true,
    });
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'T',
        objective: 'O',
        plan: [{ summary: 'W', capabilityId: CAPS.readStatus, payload: { intent: 'go' } }],
        requestedBy: 'commander',
      }),
    ).mission;
    // Preview works with the orchestrate grant alone (a pure read).
    expect(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' }).ok).toBe(true);
    const apply = fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' });
    expect(apply.ok).toBe(false);
    if (!apply.ok) expect(apply.error.code).toBe('not_permitted');
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
  });
});

describe('the approval boundary holds', () => {
  it('an approval-gated spec stops at needs_approval with ZERO approval rows', () => {
    const fx = orchestratorFixture();
    const mission = speccedMission(fx, CAPS.indexDoc);
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(report.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);
    const task = fx.db.prepare(`SELECT * FROM op_tasks`).get() as Record<string, unknown>;
    expect(task.status).toBe('needs_approval');
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }).n).toBe(0);
    expect(report.state.blockers.approvalPending).toEqual([task.id]);
  });

  it('the orchestrating Founder cannot approve the task it originated; a second principal can', () => {
    const fx = orchestratorFixture();
    const mission = speccedMission(fx, CAPS.indexDoc);
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const taskId = (fx.db.prepare(`SELECT id FROM op_tasks`).get() as { id: string }).id;
    const digest = taskActionDigest(fx.ops.queue.get(taskId)!);
    // Self-approval refused by the canonical queue rule (by === createdBy):
    // the orchestrating Founder IS the creator of every orchestrated task.
    const self = fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest });
    expect(self.ok).toBe(false);
    // The coo (approval authority, not the creator) approves — the recorded
    // second-principal pattern the phase doc states for approval-gated specs.
    const other = fx.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: digest });
    expect(other.ok).toBe(true);
    expect(fx.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('after apply, nothing is approved, claimed or running — the orchestrator never executes', () => {
    const fx = orchestratorFixture();
    const mission = speccedMission(fx);
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const task = fx.db.prepare(`SELECT * FROM op_tasks`).get() as Record<string, unknown>;
    expect(['queued', 'needs_approval']).toContain(task.status);
    expect(task.claimed_by).toBeNull();
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }).n).toBe(0);
  });
});

describe('the kill switch stops apply wholesale', () => {
  it('global engagement refuses apply with zero writes; preview still answers and reports it', () => {
    const fx = orchestratorFixture();
    const mission = speccedMission(fx);
    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'emergency stop'));
    const before = (fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n;
    const apply = fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' });
    expect(apply.ok).toBe(false);
    if (!apply.ok) expect(apply.error.code).toBe('kill_switch_engaged');
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(before);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_orchestration_runs`).get() as { n: number }).n).toBe(0);

    const preview = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' }),
    );
    expect(preview.state.killSwitch.global).toBe(true);
  });

  it('a spec-capability scope refuses that ITEM only; other items proceed', () => {
    const fx = orchestratorFixture();
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'Two lanes',
        objective: 'O',
        plan: [
          { summary: 'Read work', capabilityId: CAPS.readStatus, payload: { intent: 'a' } },
          { summary: 'Index work', capabilityId: CAPS.indexDoc, payload: { intent: 'b' } },
        ],
        requestedBy: 'founder',
      }),
    ).mission;
    expectOk(fx.ops.engageKillSwitch(CAPS.indexDoc, 'founder', 'index lane paused'));
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    const bySeq = new Map(report.decisions.map((d) => [`${d.planItemSeq}:${d.decision}`, true]));
    expect(bySeq.has('1:task_created')).toBe(true);
    expect(bySeq.has('2:kill_switch_scope_engaged')).toBe(true);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
  });
});

describe('Wave 1 records no assignment and consults no memory', () => {
  it('apply leaves hq_op_task_meta assignment untouched and hq_memory row count unchanged', () => {
    const fx = orchestratorFixture();
    const mission = speccedMission(fx);
    const memoryBefore = (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }).n;
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const meta = fx.db
      .prepare(`SELECT assigned_worker_id FROM hq_op_task_meta`)
      .all() as { assigned_worker_id: string | null }[];
    for (const row of meta) expect(row.assigned_worker_id).toBeNull();
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }).n).toBe(memoryBefore);
  });

  it('eligibility in the execution state respects the canonical directory truth', () => {
    const fx = orchestratorFixture();
    const mission = speccedMission(fx);
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const state = expectOk(fx.ops.getMissionExecutionState(mission.id));
    const eligible = state.linkedTasks[0].eligibleWorkers;
    // Directory + policy truth: active grant-holders only; the inactive
    // retired-bot is excluded even though its row lists the capability.
    expect(eligible).toContain('claude');
    expect(eligible).toContain('codex');
    expect(eligible).not.toContain('retired-bot');
  });
});
