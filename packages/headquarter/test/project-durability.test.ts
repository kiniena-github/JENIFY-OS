/**
 * The Phase 4 register survives a real close-and-reopen of the canonical
 * database file (issue #262 — the mission-durability pattern applied to
 * projects, their mission relationships, plan-item task links and the
 * member registry).
 *
 * Deliberately a FILE database, not `:memory:`: the property under test is
 * that a registered project, its lifecycle, the mission -> project link, a
 * plan item's write-once task link and a registered member land in the one
 * SQLite file and are read back identically by a brand-new
 * `HeadquarterOperations` after the first connection is fully closed. Runs
 * on every OS; the full-process durable-mount variant stays Linux-gated.
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
import { AiMemberRegistry } from '../src/registry/members.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import { declaredOnlyAdapter } from '../src/providers/declared.js';
import { KNOWN_PROVIDERS } from '../src/providers/known.js';

const FOUNDER = 'p4-durability-founder';

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openOps(path: string): { ops: HeadquarterOperations; close: () => void } {
  const db = openHqDatabase(path);
  const providers = new ProviderDirectory();
  for (const descriptor of KNOWN_PROVIDERS) providers.register(declaredOnlyAdapter(descriptor));
  const ops = new HeadquarterOperations(db, {
    store: new HeadquarterStore(db),
    aiMemberRegistry: new AiMemberRegistry(db, providers, new MemberCapabilityRegistry(db)),
  });
  return { ops, close: () => db.close() };
}

describe('project + workforce durability across a full close and reopen', () => {
  it('reopens the same canonical register, linkage and member state in a fresh service', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-project-durability-'));
    const path = join(dir, 'headquarter.sqlite');

    // Configuration on its own connection, as a real deployment performs it.
    const configDb = openHqDatabase(path);
    registerMissionCommandCapability(configDb);
    registerProjectCommandCapability(configDb);
    new CapabilityRegistry(configDb).register({
      id: 'repo.read_status',
      description: 'Read repo/CI status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    new HeadquarterStore(configDb).upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: ['repo.read_status'],
      active: true,
    });
    new HumanPrincipalRegistry(configDb).register({
      id: FOUNDER,
      displayName: 'Durability Founder',
      originateCapabilities: [
        MISSION_COMMAND_CAPABILITY.id,
        PROJECT_COMMAND_CAPABILITY.id,
        'repo.read_status',
      ],
      approvalAuthority: true,
      active: true,
    });
    configDb.close();

    const writer = openOps(path);
    const project = (() => {
      const created = writer.ops.createProject({
        name: 'JENIFY OS',
        purpose: 'The platform program',
        stream: 'jenify-os',
        requestedBy: FOUNDER,
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.data.project;
    })();
    const mission = (() => {
      const commanded = writer.ops.commandMission({
        title: 'Ship Phase 4',
        objective: 'Projects, tasks and the workforce become first-class',
        planItems: ['Build the register'],
        projectId: project.id,
        requestedBy: FOUNDER,
      });
      if (!commanded.ok) throw new Error(commanded.error.message);
      return commanded.data.mission;
    })();
    const taskId = (() => {
      const created = writer.ops.createTask({
        capabilityId: 'repo.read_status',
        payload: { kind: 'build' },
        requestedBy: FOUNDER,
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.data.task.id;
    })();
    const linked = writer.ops.linkMissionPlanItem({
      missionId: mission.id,
      planItemSeq: 1,
      taskId,
      requestedBy: FOUNDER,
    });
    if (!linked.ok) throw new Error(linked.error.message);
    const member = writer.ops.registerAiMember({
      id: 'claude',
      displayName: 'Claude member record',
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      modelVersion: '1',
      workerType: 'execution',
      locality: 'cloud',
      privacyClass: 'internal',
      costClass: 'high',
      founderId: FOUNDER,
    });
    if (!member.ok) throw new Error(member.error.message);
    const closed = writer.ops.transitionProject({
      projectId: project.id,
      to: 'closed',
      note: 'First slice shipped',
      requestedBy: FOUNDER,
    });
    if (!closed.ok) throw new Error(closed.error.message);
    const before = writer.ops.getProject(project.id)!;
    writer.close();

    // Session two: a brand-new service instance over the same file.
    const reader = openOps(path);
    const after = reader.ops.getProject(project.id);
    expect(after).toEqual(before);
    expect(after!.status).toBe('closed');
    expect(after!.stream).toBe('jenify-os');
    expect(after!.missions).toEqual([
      { missionId: mission.id, title: 'Ship Phase 4', status: 'planned' },
    ]);
    expect(after!.taskCounts).toEqual([{ status: 'queued', count: 1 }]);
    expect(after!.history.map((event) => event.kind)).toEqual(['created', 'transitioned']);

    // The mission side of the relationship reads back identically too.
    const missionAfter = reader.ops.getMission(mission.id)!;
    expect(missionAfter.projectId).toBe(project.id);
    expect(missionAfter.projectName).toBe('JENIFY OS');
    expect(missionAfter.planItems[0]!.taskId).toBe(taskId);

    // The member record and its health truth survive.
    const roster = reader.ops.listAiMembers();
    expect(roster.configured).toBe(true);
    expect(roster.members.map((m) => m.identityKey)).toEqual(['anthropic:claude-fable-5:1']);
    expect(roster.members[0]!.health).toBe('unknown');

    // Dedupe survives the restart: the identical create finds the closed row.
    const again = reader.ops.createProject({
      name: 'JENIFY OS',
      purpose: 'The platform program',
      stream: 'jenify-os',
      requestedBy: FOUNDER,
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.data.deduplicated).toBe(true);
    expect(again.data.project.id).toBe(project.id);
    expect(reader.ops.listProjects()).toHaveLength(1);

    // And the closed-project refusals hold identically after the restart.
    const refused = reader.ops.assignMissionToProject({
      missionId: mission.id,
      projectId: project.id,
      requestedBy: FOUNDER,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('project_closed');
    reader.close();
  });

  it('holds the engine append-only guarantees over the reopened file', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-project-durability-'));
    const path = join(dir, 'headquarter.sqlite');
    const configDb = openHqDatabase(path);
    registerProjectCommandCapability(configDb);
    new HumanPrincipalRegistry(configDb).register({
      id: FOUNDER,
      displayName: 'Durability Founder',
      originateCapabilities: [PROJECT_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    configDb.close();

    const writer = openOps(path);
    const created = writer.ops.createProject({
      name: 'Guarded',
      purpose: 'Its history must be untouchable',
      requestedBy: FOUNDER,
    });
    if (!created.ok) throw new Error(created.error.message);
    writer.close();

    // A fresh raw connection — the triggers live in the FILE, not in any
    // process that happens to be polite.
    const raw = openHqDatabase(path);
    const eventId = (
      raw.prepare(`SELECT id FROM hq_project_events ORDER BY seq LIMIT 1`).get() as { id: string }
    ).id;
    expect(() =>
      raw.prepare(`UPDATE hq_project_events SET actor = 'forged' WHERE id = ?`).run(eventId),
    ).toThrow(/append-only/);
    expect(() =>
      raw
        .prepare(
          `REPLACE INTO hq_project_events (id, project_id, at, actor, kind)
           VALUES (?, 'x', 'now', 'attacker', 'forged')`,
        )
        .run(eventId),
    ).toThrow(/append-only/);
    raw.close();
  });
});
