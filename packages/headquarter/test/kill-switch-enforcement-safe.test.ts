/**
 * Phase 8, the carried-forward Low 7: every kill-switch read that DECIDES a
 * write or an authority outcome reads the canonical `op_kill_switch` row,
 * never the patchable `queue.killSwitchEngaged` convenience delegate.
 *
 * Each test forges the public delegate on BOTH the instance and the
 * prototype, proves the lie took (the delegate answers false while the row
 * says engaged), and then proves the decision is unchanged:
 *
 *   - `approveTask`        no approval row lands while the switch is engaged
 *   - `claimNext`          the typed `kill_switch_engaged` refusal, no claim
 *   - `orchestrateMission` apply refuses wholesale at the precheck, zero writes
 *   - `claudeDispatchEligibility` (via the exported `killSwitchEngagedFor`
 *                          function binding) reports the engaged switch
 *   - the gateway's `executeAction` refuses (pinned again in its own suite)
 *
 * The one call site deliberately LEFT on the delegate is `#missionExecutionState`,
 * a derived read projection: the last test shows a forged delegate CAN lie to
 * that display — and that the lie decides nothing, because the same apply that
 * reported "clear" still refused.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { OperatorQueue } from '../src/operator/queue.js';
import { killSwitchEngagedFor } from '../src/application/service.js';
import { claudeDispatchEligibility } from '../src/providers/claude/dispatch.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability, submitDirectOrder } from '../src/live/orders.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

/** Forge the public delegate on instance and prototype; run `fn`; restore. */
function withForgedDelegate<T>(fx: Fixture, fn: () => T): T {
  const proto = OperatorQueue.prototype as unknown as Record<string, unknown>;
  const queue = fx.ops.queue as unknown as Record<string, unknown>;
  const hadProto = Object.prototype.hasOwnProperty.call(proto, 'killSwitchEngaged');
  const savedProto = proto.killSwitchEngaged;
  const hadOwn = Object.prototype.hasOwnProperty.call(queue, 'killSwitchEngaged');
  const savedOwn = queue.killSwitchEngaged;
  proto.killSwitchEngaged = () => false;
  try {
    queue.killSwitchEngaged = () => false;
  } catch {
    /* a non-writable instance slot is a pass — the prototype patch stands */
  }
  try {
    // The lie took: the convenience read now says "clear" about everything.
    expect(fx.ops.queue.killSwitchEngaged()).toBe(false);
    expect(fx.ops.queue.killSwitchEngaged(CAPS.indexDoc)).toBe(false);
    return fn();
  } finally {
    if (hadProto) proto.killSwitchEngaged = savedProto;
    else delete proto.killSwitchEngaged;
    if (hadOwn) queue.killSwitchEngaged = savedOwn;
    else delete queue.killSwitchEngaged;
  }
}

function count(fx: Fixture, table: string): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('approveTask reads the canonical kill-switch row', () => {
  it('refuses the approval while the capability scope is engaged, whatever the delegate says; zero approval rows', () => {
    const fx = setupFixture();
    const task = expectOk(
      fx.ops.createTask({ capabilityId: CAPS.indexDoc, payload: { document: 'd' }, idempotencyKey: 'ks-1', requestedBy: 'claude' }),
    ).task;
    expect(task.status).toBe('needs_approval');
    expectOk(fx.ops.engageKillSwitch(CAPS.indexDoc, 'founder', 'index lane paused'));
    const result = withForgedDelegate(fx, () =>
      fx.ops.approveTask({ taskId: task.id, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('kill_switch_engaged');
    expect(count(fx, 'hq_approvals')).toBe(0);
    expect(fx.ops.queue.get(task.id)!.status).toBe('needs_approval');
    // And the global scope, the same way.
    expectOk(fx.ops.releaseKillSwitch(CAPS.indexDoc, 'founder'));
    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'emergency stop'));
    const global = withForgedDelegate(fx, () =>
      fx.ops.approveTask({ taskId: task.id, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }),
    );
    expect(global.ok).toBe(false);
    expect(count(fx, 'hq_approvals')).toBe(0);
    // Released: the same approval lands, so the migrated read is the row and not a stuck answer.
    expectOk(fx.ops.releaseKillSwitch('*', 'founder'));
    expectOk(fx.ops.approveTask({ taskId: task.id, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }));
    expect(count(fx, 'hq_approvals')).toBe(1);
  });
});

describe('claimNext reads the canonical kill-switch row', () => {
  it('answers the typed kill_switch_engaged refusal — not nothing_claimable — and hands out no claim', () => {
    const fx = setupFixture();
    const task = expectOk(
      fx.ops.createTask({ capabilityId: CAPS.openPr, payload: { branch: 'b' }, idempotencyKey: 'ks-2', requestedBy: 'claude' }),
    ).task;
    expect(task.status).toBe('queued');
    expectOk(fx.ops.engageKillSwitch(CAPS.openPr, 'founder', 'pr lane paused'));
    const result = withForgedDelegate(fx, () => fx.ops.claimNext('claude', CAPS.openPr));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('kill_switch_engaged');
    const after = fx.ops.queue.get(task.id)!;
    expect(after.status).toBe('queued');
    expect(after.claimedBy).toBeNull();
    expect(after.fence).toBe(0);
    expectOk(fx.ops.releaseKillSwitch(CAPS.openPr, 'founder'));
    expect(expectOk(fx.ops.claimNext('claude', CAPS.openPr)).id).toBe(task.id);
  });
});

describe('orchestrateMission apply precheck reads the canonical kill-switch row', () => {
  function orchestratorFixture(): Fixture {
    const fx = setupFixture();
    registerMissionCommandCapability(fx.db);
    registerMissionOrchestrateCapability(fx.db);
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [CAPS.readStatus, MISSION_COMMAND_CAPABILITY.id, MISSION_ORCHESTRATE_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    return fx;
  }

  it('refuses apply wholesale under a forged delegate, with zero task/run writes', () => {
    const fx = orchestratorFixture();
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'T',
        objective: 'O',
        plan: [{ summary: 'W', capabilityId: CAPS.readStatus, payload: { intent: 'go' } }],
        requestedBy: 'founder',
      }),
    ).mission;
    expectOk(fx.ops.engageKillSwitch(MISSION_ORCHESTRATE_CAPABILITY.id, 'founder', 'orchestration paused'));
    const apply = withForgedDelegate(fx, () =>
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(apply.ok).toBe(false);
    if (!apply.ok) {
      expect(apply.error.code).toBe('kill_switch_engaged');
      // Decided at the PRECHECK, not only inside the lock: the migrated fast path refuses first.
      expect(apply.error.details?.revalidation).toBeUndefined();
    }
    expect(count(fx, 'op_tasks')).toBe(0);
    expect(count(fx, 'hq_orchestration_runs')).toBe(0);
  });

  it('the derived Mission Room projection is deliberately left on the delegate — it CAN be lied to and decides nothing', () => {
    const fx = orchestratorFixture();
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'T',
        objective: 'O',
        plan: [{ summary: 'W', capabilityId: CAPS.readStatus, payload: { intent: 'go' } }],
        requestedBy: 'founder',
      }),
    ).mission;
    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'emergency stop'));
    withForgedDelegate(fx, () => {
      // The projection reports the forged answer (a display lie the patcher tells itself)...
      const state = expectOk(fx.ops.getMissionExecutionState(mission.id));
      expect(state.killSwitch.global).toBe(false);
      // ...while the WRITE decision beside it still reads the row and refuses.
      const apply = fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' });
      expect(apply.ok).toBe(false);
      if (!apply.ok) expect(apply.error.code).toBe('kill_switch_engaged');
    });
    // Unpatched, the projection tells the truth again.
    expect(expectOk(fx.ops.getMissionExecutionState(mission.id)).killSwitch.global).toBe(true);
    expect(count(fx, 'op_tasks')).toBe(0);
  });
});

describe('the Claude dispatch eligibility reads the canonical row through the function binding', () => {
  it('reports kill_switch_engaged under a forged delegate; killSwitchEngagedFor cannot be reassigned', () => {
    const fx = setupFixture();
    registerDirectOrderCapability(fx.db);
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const receipt = expectOk(
      submitDirectOrder(fx.ops, { instruction: 'Draft the plan.', project: 'mesob', route: 'CLAUDE', requestedBy: 'founder' }, CLAUDE_ONLY),
    );
    const taskId = receipt.task.id;
    expectOk(fx.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: taskActionDigest(fx.ops.queue.get(taskId)!) }));
    expectOk(fx.ops.engageKillSwitch(DIRECT_ORDER_CAPABILITY.id, 'founder', 'orders paused'));
    withForgedDelegate(fx, () => {
      expect(killSwitchEngagedFor(fx.ops, DIRECT_ORDER_CAPABILITY.id)).toBe(true);
      expect(killSwitchEngagedFor(fx.ops)).toBe(false); // global is clear; the answer is the row's, scope by scope
      const verdict = claudeDispatchEligibility(fx.ops, taskId);
      expect(verdict.eligible).toBe(false);
      if (!verdict.eligible) expect(verdict.code).toBe('kill_switch_engaged');
    });
    expectOk(fx.ops.releaseKillSwitch(DIRECT_ORDER_CAPABILITY.id, 'founder'));
    expect(claudeDispatchEligibility(fx.ops, taskId).eligible).toBe(true);
  });
});
