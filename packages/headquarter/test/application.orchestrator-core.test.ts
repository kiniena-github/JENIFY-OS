/**
 * Phase 6 — the orchestration cycle against the real canonical machinery
 * (issue #265, directive §14: task creation, idempotency, traceability,
 * lifecycle honesty).
 *
 * The claims proven here: a Founder-spec'd plan item becomes exactly ONE real
 * task through the approved origination path with the payload VERBATIM; a
 * rerun creates nothing; unspecified/needs_clarification/superseded items
 * produce no task and truthful decisions; preview writes NOTHING; the
 * fingerprint refuses an apply over a moved mission; and every derived state
 * figure is categorical — counts and canonical statuses, never a percentage.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  orchestrationTaskIdempotencyKey,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';

function orchestratorFixture(grants: string[] = [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc]): Fixture {
  const fx = setupFixture();
  registerMissionCommandCapability(fx.db);
  registerMissionOrchestrateCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, MISSION_ORCHESTRATE_CAPABILITY.id, ...grants],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

const SPEC_PAYLOAD = { intent: 'measure load times', target: 'landing-page' };

function commandSpecced(fx: Fixture, over: Record<string, unknown> = {}) {
  return expectOk(
    fx.ops.commandMission({
      title: 'Faster QOS site',
      objective: 'Reduce page load times without changing the visual design',
      constraints: ['Do not change the visual design'],
      plan: [{ summary: 'Measure current load times', capabilityId: CAPS.readStatus, payload: SPEC_PAYLOAD }],
      requestedBy: 'founder',
      ...over,
    } as Parameters<Fixture['ops']['commandMission']>[0]),
  ).mission;
}

const COUNTED_TABLES = [
  'op_tasks',
  'op_evidence',
  'hq_events',
  'hq_mission_events',
  'hq_mission_intents',
  'hq_orchestration_runs',
  'hq_orchestration_run_items',
  'hq_approvals',
] as const;

function allCounts(fx: Fixture): number[] {
  return COUNTED_TABLES.map(
    (table) => (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
}

describe('commanding with specs still creates no task', () => {
  it('a spec is a stated plan, not an act — nothing claimable exists until orchestration', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    expect(mission.planItems[0].specCapabilityId).toBe(CAPS.readStatus);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }).n).toBe(0);
    expect(fx.ops.claimNext('claude', CAPS.readStatus).ok).toBe(false);
  });

  it('a byte-identical spec-less re-command keeps deduping onto its Phase 3-era key', () => {
    const fx = orchestratorFixture();
    const first = expectOk(
      fx.ops.commandMission({ title: 'T', objective: 'O', planItems: ['Item'], requestedBy: 'founder' }),
    );
    const second = expectOk(
      fx.ops.commandMission({ title: 'T', objective: 'O', planItems: ['Item'], requestedBy: 'founder' }),
    );
    expect(second.deduplicated).toBe(true);
    expect(second.mission.id).toBe(first.mission.id);
    // The object form WITHOUT specs digests identically to the string form.
    const objectForm = expectOk(
      fx.ops.commandMission({ title: 'T', objective: 'O', plan: [{ summary: 'Item' }], requestedBy: 'founder' }),
    );
    expect(objectForm.deduplicated).toBe(true);
    expect(objectForm.mission.id).toBe(first.mission.id);
  });
});

describe('preview is a pure read', () => {
  it('classifies every item and writes NOTHING anywhere', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    const before = allCounts(fx);
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' }),
    );
    expect(report.mode).toBe('preview');
    expect(report.runId).toBeNull();
    expect(report.decisions).toEqual([
      { planItemSeq: 1, decision: 'ready', detail: { capabilityId: CAPS.readStatus } },
    ]);
    expect(report.fingerprint).toMatch(/^orch-observed:/);
    expect(allCounts(fx)).toEqual(before);
  });
});

describe('apply — task creation from the Founder-specified plan', () => {
  it('creates exactly one canonical task, payload verbatim, linked write-once, run recorded', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(report.mode).toBe('apply');
    expect(report.runId).toMatch(/^orch-/);
    expect(report.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);

    const tasks = fx.db.prepare(`SELECT * FROM op_tasks`).all() as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].capability_id).toBe(CAPS.readStatus);
    expect(tasks[0].created_by).toBe('founder');
    expect(tasks[0].status).toBe('queued');
    // Payload VERBATIM — the Founder's stored spec, nothing injected.
    expect(JSON.parse(tasks[0].payload as string)).toEqual(SPEC_PAYLOAD);

    const after = fx.ops.getMission(mission.id)!;
    expect(after.planItems[0].taskId).toBe(tasks[0].id);
    // Traceability: the run items name the plan item and the task.
    const runItems = fx.db.prepare(`SELECT * FROM hq_orchestration_run_items`).all() as Record<string, unknown>[];
    expect(runItems.map((r) => r.decision)).toEqual(['task_created', 'item_linked']);
    const runs = fx.db.prepare(`SELECT * FROM hq_orchestration_runs`).all() as Record<string, unknown>[];
    expect(runs).toHaveLength(1);
    // The mission event log and evidence chain both carry the act.
    const events = fx.db
      .prepare(`SELECT kind FROM hq_mission_events WHERE mission_id = ? ORDER BY seq`)
      .all(mission.id) as { kind: string }[];
    expect(events.map((e) => e.kind)).toContain('orchestrated');
    expect(fx.ops.queue.evidence.list().some((e) => e.kind === 'mission_orchestrated')).toBe(true);
    // The mission itself did NOT move: orchestration never transitions.
    expect(after.status).toBe(mission.status);
  });

  it('rerun observes the linked item and creates nothing new', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const beforeTasks = (fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n;
    const rerun = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(rerun.decisions.map((d) => d.decision)).toEqual(['observed_linked']);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(beforeTasks);
    // A rerun is legible: a second run record exists, with zero acts.
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_orchestration_runs`).get() as { n: number }).n).toBe(2);
  });

  it('adopts and links a task an earlier crashed cycle already created (dedupe recovery)', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    // Simulate the committed half of an earlier run: the task exists under
    // the DERIVED key, the link does not.
    const preview = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' }),
    );
    expect(preview.decisions[0].decision).toBe('ready');
    const item = fx.ops.getMission(mission.id)!.planItems[0];
    const key = orchestrationTaskIdempotencyKey({
      missionId: mission.id,
      planItemSeq: 1,
      capabilityId: item.specCapabilityId!,
      payload: item.specPayload!,
    });
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: JSON.parse(item.specPayload!) as Record<string, unknown>,
        idempotencyKey: key,
        requestedBy: 'founder',
      }),
    );
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(report.decisions.map((d) => d.decision)).toEqual(['task_deduplicated', 'item_linked']);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
    expect(fx.ops.getMission(mission.id)!.planItems[0].taskId).toBe(created.task.id);
  });

  it('a byte-different payload derives a different key — two different orders, two tasks', () => {
    const fx = orchestratorFixture();
    const a = commandSpecced(fx);
    const b = commandSpecced(fx, {
      title: 'Faster QOS site, pass two',
      plan: [
        {
          summary: 'Measure again',
          capabilityId: CAPS.readStatus,
          payload: { intent: 'measure load times', target: 'product-list' },
        },
      ],
    });
    expectOk(fx.ops.orchestrateMission({ missionId: a.id, mode: 'apply', requestedBy: 'founder' }));
    expectOk(fx.ops.orchestrateMission({ missionId: b.id, mode: 'apply', requestedBy: 'founder' }));
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(2);
  });
});

describe('apply — items that must NOT become tasks', () => {
  it('unspecified, needs_clarification and superseded items produce truthful decisions and no task', () => {
    const fx = orchestratorFixture();
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'Mixed plan',
        objective: 'O',
        plan: [
          { summary: 'Specified work', capabilityId: CAPS.readStatus, payload: { intent: 'go' } },
          { summary: 'Vague work nobody specified' },
          { summary: 'To be superseded', capabilityId: CAPS.readStatus, payload: { intent: 'old' } },
        ],
        requestedBy: 'founder',
      }),
    ).mission;
    expectOk(
      fx.ops.amendMissionIntent({
        missionId: mission.id,
        amendment: 'Item three is no longer wanted.',
        supersedePlanItemSeqs: [3],
        requestedBy: 'founder',
      }),
    );
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    const bySeq = new Map(report.decisions.map((d) => [`${d.planItemSeq}:${d.decision}`, d]));
    expect(bySeq.has('1:task_created')).toBe(true);
    expect(bySeq.has('1:item_linked')).toBe(true);
    expect(bySeq.has('2:not_actionable_unspecified')).toBe(true);
    expect(bySeq.has('3:skipped_superseded')).toBe(true);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
    // The zero-spec objective text never became work: no parsing happened.
    expect(report.decisions.some((d) => d.decision === 'ready')).toBe(false);
  });

  it('an unregistered or disabled spec capability is a per-item verdict, no task', () => {
    const fx = orchestratorFixture();
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'Future capability',
        objective: 'O',
        plan: [{ summary: 'Needs a capability nobody registered', capabilityId: 'future.capability', payload: { a: 1 } }],
        requestedBy: 'founder',
      }),
    ).mission;
    const unknown = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(unknown.decisions[0].decision).toBe('capability_unknown');

    new CapabilityRegistry(fx.db).register({
      id: 'future.capability',
      description: 'Arrived later',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
      enabled: false,
    });
    const disabled = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(disabled.decisions[0].decision).toBe('capability_disabled');
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
  });

  it('a capability registered AFTER command time becomes actionable — specs are not frozen verdicts', () => {
    const fx = orchestratorFixture();
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'Future capability, arriving',
        objective: 'O',
        plan: [{ summary: 'Waits for registration', capabilityId: 'late.capability', payload: { a: 1 } }],
        requestedBy: 'founder',
      }),
    ).mission;
    new CapabilityRegistry(fx.db).register({
      id: 'late.capability',
      description: 'Registered after the mission was commanded',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [
        MISSION_COMMAND_CAPABILITY.id,
        MISSION_ORCHESTRATE_CAPABILITY.id,
        CAPS.readStatus,
        'late.capability',
      ],
      approvalAuthority: true,
      active: true,
    });
    const report = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }),
    );
    expect(report.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);
  });
});

describe('fingerprint and lifecycle refusals', () => {
  it('refuses an apply whose preview fingerprint no longer matches the mission', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    const preview = expectOk(
      fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' }),
    );
    expectOk(
      fx.ops.amendMissionIntent({
        missionId: mission.id,
        amendment: 'Scope changed after the preview.',
        addPlanItems: ['New work'],
        requestedBy: 'founder',
      }),
    );
    const stale = fx.ops.orchestrateMission({
      missionId: mission.id,
      mode: 'apply',
      fingerprint: preview.fingerprint,
      requestedBy: 'founder',
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('orchestrate_fingerprint_mismatch');
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
  });

  it('apply orchestrates only planned/working; preview answers on blocked; terminal refuses both', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    expectOk(
      fx.ops.transitionMission({ missionId: mission.id, to: 'blocked', note: 'Founder stop', requestedBy: 'founder' }),
    );
    const blocked = fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('mission_not_orchestratable');
    expect(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' }).ok).toBe(true);

    expectOk(fx.ops.transitionMission({ missionId: mission.id, to: 'cancelled', note: 'Done with it', requestedBy: 'founder' }));
    const terminal = fx.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: 'founder' });
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.code).toBe('mission_terminal');
  });
});

describe('categorical execution state', () => {
  it('reports counts and canonical statuses; recommends ready_review only when every work item is complete', () => {
    const fx = orchestratorFixture();
    const mission = commandSpecced(fx);
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const midway = expectOk(fx.ops.getMissionExecutionState(mission.id));
    expect(midway.planItems).toEqual({
      total: 1,
      superseded: 0,
      needsClarification: 0,
      workUnspecified: 0,
      workSpecified: 1,
      linked: 1,
    });
    expect(midway.linkedTasks[0].status).toBe('queued');
    expect(midway.linkedTasks[0].eligibleWorkers).toContain('claude');
    expect(midway.linkedTasks[0].eligibleWorkers).not.toContain('retired-bot');
    expect(midway.recommendation).toBe('none');
    // Nothing percentage-shaped anywhere on the wire shape.
    expect(JSON.stringify(midway)).not.toMatch(/percent|Percent|eta|Eta/);

    // Drive the task to completion through the CANONICAL path.
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    fx.ops.queue.start(claimed.id, 'claude', claimed.fence);
    fx.ops.queue.complete(claimed.id, 'claude', claimed.fence, { ok: true });
    const done = expectOk(fx.ops.getMissionExecutionState(mission.id));
    expect(done.linkedTasks[0].status).toBe('completed');
    expect(done.recommendation).toBe('ready_review');
    // A recommendation transitions NOTHING: the mission still sits where the
    // Founder left it.
    expect(fx.ops.getMission(mission.id)!.status).toBe('planned');
  });
});
