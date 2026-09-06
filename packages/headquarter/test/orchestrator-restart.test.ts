/**
 * Phase 6 — orchestration survives restarts and never guesses (issue #265,
 * directive §14: restart, unknown outcome, the accepted Low #1 posture).
 *
 * A real FILE database: an applied cycle's tasks, links and run records are
 * read back identically by a brand-new service instance; a rerun after the
 * "restart" reconciles instead of duplicating; an outcome_unknown task stays
 * unknown (never requeued, never retried by the orchestrator); and a
 * hostile-rejection blocked task with its retained claimant is reported
 * verbatim and never duplicated.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openHqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';
import { expectOk } from './application.fixture.js';

const FOUNDER = 'restart-founder';
const CAP = 'repo.read_status';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openOps(path: string): { ops: HeadquarterOperations; close: () => void; db: ReturnType<typeof openHqDatabase> } {
  const db = openHqDatabase(path);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  return { ops, close: () => db.close(), db };
}

function configure(path: string): void {
  const configDb = openHqDatabase(path);
  registerMissionCommandCapability(configDb);
  registerMissionOrchestrateCapability(configDb);
  new CapabilityRegistry(configDb).register({
    id: CAP,
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  new HumanPrincipalRegistry(configDb).register({
    id: FOUNDER,
    displayName: 'Restart Founder',
    originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, MISSION_ORCHESTRATE_CAPABILITY.id, CAP],
    approvalAuthority: true,
    active: true,
  });
  const store = new HeadquarterStore(configDb);
  store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAP],
    active: true,
  });
  configDb.close();
}

describe('orchestration across a full close and reopen', () => {
  it('reopens identical tasks/links/runs and a rerun reconciles without duplicating', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-orch-restart-'));
    const path = join(dir, 'headquarter.sqlite');
    configure(path);

    const writer = openOps(path);
    const mission = expectOk(
      writer.ops.commandMission({
        title: 'Restart-safe orchestration',
        objective: 'O',
        plan: [{ summary: 'Work', capabilityId: CAP, payload: { intent: 'go' } }],
        requestedBy: FOUNDER,
      }),
    ).mission;
    const applied = expectOk(
      writer.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER }),
    );
    expect(applied.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);
    const beforeMission = writer.ops.getMission(mission.id)!;
    const beforeState = expectOk(writer.ops.getMissionExecutionState(mission.id));
    writer.close();

    const reader = openOps(path);
    expect(reader.ops.getMission(mission.id)).toEqual(beforeMission);
    const stateAfter = expectOk(reader.ops.getMissionExecutionState(mission.id));
    expect(stateAfter).toEqual(beforeState);
    const runs = reader.db.prepare(`SELECT COUNT(*) AS n FROM hq_orchestration_runs`).get() as { n: number };
    expect(runs.n).toBe(1);

    // Rerun on the fresh instance: observes, creates nothing.
    const rerun = expectOk(
      reader.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER }),
    );
    expect(rerun.decisions.map((d) => d.decision)).toEqual(['observed_linked']);
    expect((reader.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
    // The mission's immutable original intent survived everything.
    const seq0 = reader.ops.getMissionIntentHistory(mission.id)[0]!;
    expect(seq0.seq).toBe(0);
    expect(seq0.kind).toBe('founder_order');
    reader.close();
  });

  it('an outcome_unknown linked task stays unknown — reported as a blocker, never requeued or retried', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-orch-unknown-'));
    const path = join(dir, 'headquarter.sqlite');
    configure(path);
    const session = openOps(path);
    const mission = expectOk(
      session.ops.commandMission({
        title: 'Unknown outcome',
        objective: 'O',
        plan: [{ summary: 'Work', capabilityId: CAP, payload: { intent: 'go' } }],
        requestedBy: FOUNDER,
      }),
    ).mission;
    expectOk(session.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER }));
    const taskId = session.ops.getMission(mission.id)!.planItems[0].taskId!;
    // Simulate the fail-closed sweep outcome directly at the row (tests may
    // stage canonical states; production writers cannot — op_tasks carries
    // no orchestrator-reachable path to this state).
    session.db
      .prepare(`UPDATE op_tasks SET status = 'outcome_unknown', claimed_by = 'claude' WHERE id = ?`)
      .run(taskId);

    const report = expectOk(
      session.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER }),
    );
    expect(report.decisions).toEqual([
      {
        planItemSeq: 1,
        decision: 'observed_linked',
        detail: { taskId, taskStatus: 'outcome_unknown', reviewPending: false, claimedBy: 'claude' },
      },
    ]);
    // Unchanged: not requeued, not retried, no duplicate task.
    const row = session.db.prepare(`SELECT status FROM op_tasks WHERE id = ?`).get(taskId) as { status: string };
    expect(row.status).toBe('outcome_unknown');
    expect((session.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
    expect(report.state.blockers.outcomeUnknown).toEqual([taskId]);
    session.close();
  });

  it('the accepted Low #1 posture: a blocked task with a retained claimant is reported verbatim, execution-inert, never duplicated', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-orch-blocked-'));
    const path = join(dir, 'headquarter.sqlite');
    configure(path);
    const session = openOps(path);
    const mission = expectOk(
      session.ops.commandMission({
        title: 'Hostile rejection aftermath',
        objective: 'O',
        plan: [{ summary: 'Work', capabilityId: CAP, payload: { intent: 'go' } }],
        requestedBy: FOUNDER,
      }),
    ).mission;
    expectOk(session.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER }));
    const taskId = session.ops.getMission(mission.id)!.planItems[0].taskId!;
    // The hostile-approval-rejection shape: blocked, claimant RETAINED for
    // investigation, approval binding cleared (execution-inert).
    session.db
      .prepare(`UPDATE op_tasks SET status = 'blocked', claimed_by = 'claude', block_reason = ? WHERE id = ?`)
      .run('approval digest mismatch at the execution boundary', taskId);

    const report = expectOk(
      session.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER }),
    );
    const linked = report.decisions.find((d) => d.decision === 'observed_linked')!;
    expect(linked.detail).toEqual({ taskId, taskStatus: 'blocked', reviewPending: false, claimedBy: 'claude' });
    expect(report.state.blockers.blocked).toEqual([taskId]);
    expect(report.state.linkedTasks[0].claimedBy).toBe('claude');
    expect((session.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
    session.close();
  });
});
