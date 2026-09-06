/**
 * Phase 6 — mission priority NEVER reorders operator FIFO (issue #265,
 * directive §14). A CRITICAL-priority mission's orchestrated task joins the
 * queue in ARRIVAL order: a worker claiming next still receives the older
 * manually created task first, proven behaviorally, not by grep.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';

describe('orchestrated tasks join the strictly-FIFO queue', () => {
  it('a critical mission task never jumps an older manual task of the same capability', () => {
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

    // An ordinary manual task arrives FIRST.
    const manual = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { intent: 'ordinary earlier work' },
        requestedBy: 'founder',
      }),
    );

    // A CRITICAL mission is then orchestrated.
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'Everything is on fire',
        objective: 'O',
        priority: 'critical',
        plan: [{ summary: 'Urgent work', capabilityId: CAPS.readStatus, payload: { intent: 'urgent' } }],
        requestedBy: 'founder',
      }),
    ).mission;
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(report.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);

    // The worker's next claim is the OLDER manual task — arrival order, not
    // mission priority.
    const first = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expect(first.id).toBe(manual.task.id);
    // Only after finishing it does the orchestrated task come up.
    fx.ops.queue.start(first.id, 'claude', first.fence);
    fx.ops.queue.complete(first.id, 'claude', first.fence, { ok: true });
    const second = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expect(second.id).not.toBe(manual.task.id);
    expect(second.id).toBe(fx.ops.getMission(mission.id)!.planItems[0].taskId);
  });
});
