/**
 * Wave 1 cross-phase proof — directive §15 (issue #265), on a REAL file.
 *
 * The whole arc, end to end: Founder commands a specced mission; durable
 * related (and founder_only, and unrelated) memory exists; PREVIEW retrieves
 * ONLY authorized/relevant context and writes nothing; APPLY creates each
 * missing canonical task exactly once with the mission's constraints in
 * force at the canonical gates; RESTART (full close/reopen) reproduces the
 * same truthful state; a rerun duplicates nothing; the immutable seq-0
 * intent survives byte-identical; and an engaged kill switch stops apply
 * while preview stays truthful.
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
  PROJECT_COMMAND_CAPABILITY,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';
import { expectOk } from './application.fixture.js';

const FOUNDER = 'wave1-founder';
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

const COUNTED_TABLES = [
  'op_tasks',
  'op_evidence',
  'hq_events',
  'hq_memory',
  'hq_mission_events',
  'hq_mission_intents',
  'hq_orchestration_runs',
  'hq_orchestration_run_items',
  'hq_approvals',
] as const;

describe('the Wave 1 arc: memory-informed orchestration across a restart', () => {
  it('runs the full §15 scenario truthfully', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-wave1-arc-'));
    const path = join(dir, 'headquarter.sqlite');

    // Configuration acts on their own connection, closed first.
    const configDb = openHqDatabase(path);
    registerMissionCommandCapability(configDb);
    registerProjectCommandCapability(configDb);
    registerMemoryCommandCapability(configDb);
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
      displayName: 'Wave 1 Founder',
      originateCapabilities: [
        MISSION_COMMAND_CAPABILITY.id,
        PROJECT_COMMAND_CAPABILITY.id,
        MEMORY_COMMAND_CAPABILITY.id,
        MISSION_ORCHESTRATE_CAPABILITY.id,
        CAP,
      ],
      approvalAuthority: true,
      active: true,
    });
    const configStore = new HeadquarterStore(configDb);
    configStore.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAP],
      active: true,
    });
    configDb.close();

    // 1-3: project, specced mission, durable related + unrelated context.
    const writer = openOps(path);
    const { project } = expectOk(
      writer.ops.createProject({ name: 'QOS Speed', purpose: 'Faster site', requestedBy: FOUNDER }),
    );
    const mission = expectOk(
      writer.ops.commandMission({
        title: 'Faster QOS site',
        objective: 'Reduce page load times without changing the visual design',
        constraints: ['Do not change the visual design', 'Do not deploy production'],
        plan: [{ summary: 'Measure current load times', capabilityId: CAP, payload: { intent: 'measure' } }],
        projectId: project.id,
        requestedBy: FOUNDER,
      }),
    ).mission;
    const related = expectOk(
      writer.ops.recordMemory({
        kind: 'founder_note',
        title: 'Landing page first',
        body: 'Profile the landing page before touching anything else.',
        project: 'QOS',
        missionId: mission.id,
        requestedBy: FOUNDER,
      }),
    ).record;
    const founderOnly = expectOk(
      writer.ops.recordMemory({
        kind: 'blocker',
        title: 'Founder-only context',
        body: 'Budget conversation pending; not for worker packages.',
        project: 'QOS',
        missionId: mission.id,
        privacy: 'founder_only',
        requestedBy: FOUNDER,
      }),
    ).record;
    expectOk(
      writer.ops.recordMemory({
        kind: 'founder_note',
        title: 'Unrelated salt pricing note',
        body: 'Mesob pricing thoughts, nothing to do with QOS.',
        project: 'MESOB',
        requestedBy: FOUNDER,
      }),
    );

    // 4: retrieval is authorized and relevant — the mission context carries
    // the two related records (founder_only included: this is the
    // Founder-gated read path) and NEVER the unrelated one.
    const context = expectOk(writer.ops.getMissionContext(mission.id));
    const titles = context.memory.data.flatMap((group) => group.records.map((record) => record.title));
    expect(titles).toContain('Landing page first');
    expect(titles).toContain('Founder-only context');
    expect(titles).not.toContain('Unrelated salt pricing note');

    // 5 (preview): zero writes, everywhere.
    const before = COUNTED_TABLES.map(
      (table) => (writer.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    );
    const preview = expectOk(
      writer.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: FOUNDER }),
    );
    expect(preview.decisions.map((d) => d.decision)).toEqual(['ready']);
    expect(
      COUNTED_TABLES.map(
        (table) => (writer.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ),
    ).toEqual(before);

    // 5-6 (apply): exactly one canonical task, constraints preserved in the
    // canonical mission truth the task links back to, memory untouched.
    const applied = expectOk(
      writer.ops.orchestrateMission({
        missionId: mission.id,
        mode: 'apply',
        fingerprint: preview.fingerprint,
        requestedBy: FOUNDER,
      }),
    );
    expect(applied.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);
    expect((writer.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
    const linkedMission = writer.ops.getMission(mission.id)!;
    expect(linkedMission.constraints).toEqual(['Do not change the visual design', 'Do not deploy production']);
    expect(linkedMission.projectId).toBe(project.id);
    // Memory row count unchanged by orchestration — the boundary law.
    expect((writer.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }).n).toBe(3);

    // 7: eligibility respects policy/directory truth.
    const state = expectOk(writer.ops.getMissionExecutionState(mission.id));
    expect(state.linkedTasks[0].eligibleWorkers).toEqual(['claude']);

    // 8: the approval boundary stands — a read_only task is queued, nothing
    // is approved, and no approval row exists anywhere in the arc.
    expect(state.linkedTasks[0].status).toBe('queued');
    expect((writer.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }).n).toBe(0);

    const intentBefore = writer.db
      .prepare(`SELECT * FROM hq_mission_intents WHERE mission_id = ? AND seq = 0`)
      .get(mission.id);
    const stateBefore = state;
    // Re-assembled AFTER the apply, so the restart comparison is over the
    // same post-orchestration truth (context is read-time: the linked task
    // now legitimately appears in the mission element).
    const contextBefore = expectOk(writer.ops.getMissionContext(mission.id));
    writer.close();

    // 9-10: RESTART — a brand-new service instance over the same file shows
    // the same truthful state, memory and orchestration reconciled.
    const reader = openOps(path);
    const strip = (v: unknown) =>
      JSON.parse(JSON.stringify(v).replace(/"(asOf|assembledAt)":"[^"]*"/g, '"$1":"T"')) as unknown;
    expect(strip(expectOk(reader.ops.getMissionContext(mission.id)))).toEqual(strip(contextBefore));
    expect(expectOk(reader.ops.getMissionExecutionState(mission.id))).toEqual(stateBefore);

    // 11: rerun duplicates nothing.
    const rerun = expectOk(
      reader.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER }),
    );
    expect(rerun.decisions.map((d) => d.decision)).toEqual(['observed_linked']);
    expect((reader.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);

    // 12: the original intent is byte-identical through everything.
    const intentAfter = reader.db
      .prepare(`SELECT * FROM hq_mission_intents WHERE mission_id = ? AND seq = 0`)
      .get(mission.id);
    expect(intentAfter).toEqual(intentBefore);

    // Coda: an engaged kill switch refuses apply and preview says so.
    expectOk(reader.ops.engageKillSwitch('*', FOUNDER, 'emergency stop'));
    const blocked = reader.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: FOUNDER });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('kill_switch_engaged');
    const previewUnderSwitch = expectOk(
      reader.ops.orchestrateMission({ missionId: mission.id, mode: 'preview', requestedBy: FOUNDER }),
    );
    expect(previewUnderSwitch.state.killSwitch.global).toBe(true);
    // The worker cannot claim either — execution reachability is genuinely
    // stopped at the canonical boundary, not just at the orchestrator.
    expect(reader.ops.claimNext('claude', CAP).ok).toBe(false);
    // The founder_only record still never left the Founder-gated plane.
    expect(reader.ops.getMemoryRecord(founderOnly.id)!.privacy).toBe('founder_only');
    reader.close();
  });
});
