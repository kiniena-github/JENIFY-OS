/**
 * Phase 5 — context assembly (issue #265).
 *
 * Retrieval is relationship-scoped, bounded, provenance-labeled and PURE:
 * unrelated company memory never enters an entity's context, trimming states
 * the true total, every element names where its bytes came from, and
 * assembling a context writes nothing and changes no canonical truth.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';
import { MEMORY_CONTEXT_LIMIT } from '../src/application/context-assembly.js';

function contextFixture(): Fixture {
  const fx = setupFixture();
  registerMemoryCommandCapability(fx.db);
  registerMissionCommandCapability(fx.db);
  registerProjectCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      MEMORY_COMMAND_CAPABILITY.id,
      MISSION_COMMAND_CAPABILITY.id,
      PROJECT_COMMAND_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

function remember(fx: Fixture, over: Record<string, unknown>) {
  return expectOk(
    fx.ops.recordMemory({
      kind: 'founder_note',
      title: 'A note',
      body: 'Body text.',
      project: 'JENIFY-OS',
      requestedBy: 'founder',
      ...over,
    } as Parameters<Fixture['ops']['recordMemory']>[0]),
  ).record;
}

/** Mission + project + a real linked task, built through the canonical paths only. */
function scenario(fx: Fixture) {
  const { project } = expectOk(
    fx.ops.createProject({ name: 'QOS Speed', purpose: 'Faster site', requestedBy: 'founder' }),
  );
  const { mission } = expectOk(
    fx.ops.commandMission({
      title: 'Faster QOS site',
      objective: 'Reduce page load times without changing the visual design',
      planItems: ['Measure current load times'],
      projectId: project.id,
      requestedBy: 'founder',
    }),
  );
  const { task } = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: { intent: 'measure load times' },
      requestedBy: 'founder',
    }),
  );
  expectOk(
    fx.ops.linkMissionPlanItem({ missionId: mission.id, planItemSeq: 1, taskId: task.id, requestedBy: 'founder' }),
  );
  return { project, mission, task };
}

const allCounts = (fx: Fixture) =>
  (['hq_memory', 'hq_events', 'op_evidence', 'hq_missions', 'hq_mission_intents', 'hq_mission_events'] as const).map(
    (t) => (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
  );

describe('mission context', () => {
  it('groups mission → task → project → related, and NEVER includes unrelated memory', () => {
    const fx = contextFixture();
    const { project, mission, task } = scenario(fx);

    const missionNote = remember(fx, { title: 'Mission note', missionId: mission.id });
    remember(fx, { title: 'Task note', taskId: task.id });
    remember(fx, { title: 'Project note', projectId: project.id });
    const source = remember(fx, { title: 'Raw source', kind: 'source_material', sourceRefs: ['docs/perf.md'] });
    remember(fx, {
      kind: 'summary',
      title: 'Mission summary',
      missionId: mission.id,
      derivedFrom: [source.id],
    });
    remember(fx, { title: 'Unrelated global note about salt pricing' });

    const context = expectOk(fx.ops.getMissionContext(mission.id));
    expect(context.scope).toBe('mission');
    expect(context.memory.data.map((g) => g.linkage)).toEqual(['mission', 'task', 'project', 'related']);

    const titles = context.memory.data.flatMap((g) => g.records.map((r) => r.title));
    expect(titles).toContain('Mission note');
    expect(titles).toContain('Task note');
    expect(titles).toContain('Project note');
    expect(titles).toContain('Mission summary');
    // One hop of derivation pulls the summary's source in as 'related'.
    const related = context.memory.data.find((g) => g.linkage === 'related')!;
    expect(related.records.map((r) => r.title)).toEqual(['Raw source']);
    // The no-global-dump assertion.
    expect(titles).not.toContain('Unrelated global note about salt pricing');
    // A record appears exactly once even when reachable through two paths.
    expect(titles.filter((t) => t === 'Mission note')).toEqual(['Mission note']);
    expect(titles.filter((t) => t === missionNote.title).length).toBe(1);
  });

  it('bounds each group to the limit with the true total stated', () => {
    const fx = contextFixture();
    const { mission } = scenario(fx);
    for (let i = 0; i < MEMORY_CONTEXT_LIMIT + 5; i++) {
      remember(fx, { title: `Mission note ${i}`, missionId: mission.id });
    }
    const context = expectOk(fx.ops.getMissionContext(mission.id));
    const group = context.memory.data.find((g) => g.linkage === 'mission')!;
    expect(group.total).toBe(MEMORY_CONTEXT_LIMIT + 5);
    expect(group.records.length).toBe(MEMORY_CONTEXT_LIMIT);
  });

  it('labels every element with live provenance naming what was read', () => {
    const fx = contextFixture();
    const { mission } = scenario(fx);
    const context = expectOk(fx.ops.getMissionContext(mission.id));
    expect(context.entity.provenance.mode).toBe('live');
    expect(context.entity.provenance.source).toContain('hq_missions');
    expect(context.memory.provenance.mode).toBe('live');
    expect(context.memory.provenance.source).toContain('hq_memory');
    expect(context.memory.provenance.asOf).toBeTruthy();
  });

  it('assembly is a pure read: no row changes anywhere, canonical truth untouched', () => {
    const fx = contextFixture();
    const { mission } = scenario(fx);
    remember(fx, { title: 'Mission note', missionId: mission.id });
    const missionBefore = fx.ops.getMission(mission.id);
    const countsBefore = allCounts(fx);
    expectOk(fx.ops.getMissionContext(mission.id));
    expectOk(fx.ops.getMissionContext(mission.id));
    expect(allCounts(fx)).toEqual(countsBefore);
    expect(fx.ops.getMission(mission.id)).toEqual(missionBefore);
  });

  it('is deterministic across repeated assembly (timestamps aside)', () => {
    const fx = contextFixture();
    const { mission } = scenario(fx);
    remember(fx, { title: 'Mission note', missionId: mission.id });
    const strip = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v).replace(/"(asOf|assembledAt)":"[^"]*"/g, '"$1":"T"'),
      ) as unknown;
    const first = strip(expectOk(fx.ops.getMissionContext(mission.id)));
    const second = strip(expectOk(fx.ops.getMissionContext(mission.id)));
    expect(second).toEqual(first);
  });

  it('refuses an unknown mission after nothing else leaked', () => {
    const fx = contextFixture();
    const result = fx.ops.getMissionContext('ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_mission');
  });
});

describe('project and task context', () => {
  it('project context carries project-linked memory only, plus the one-hop walk', () => {
    const fx = contextFixture();
    const { project, mission } = scenario(fx);
    remember(fx, { title: 'Project note', projectId: project.id });
    remember(fx, { title: 'Mission-only note', missionId: mission.id });
    const context = expectOk(fx.ops.getProjectContext(project.id));
    expect(context.scope).toBe('project');
    expect(context.memory.data.map((g) => g.linkage)).toEqual(['project', 'related']);
    const titles = context.memory.data.flatMap((g) => g.records.map((r) => r.title));
    expect(titles).toEqual(['Project note']);
  });

  it('task context carries a minimal canonical ref — never the payload', () => {
    const fx = contextFixture();
    const { task } = scenario(fx);
    remember(fx, { title: 'Task note', taskId: task.id });
    const context = expectOk(fx.ops.getTaskContext(task.id));
    expect(context.scope).toBe('task');
    expect(context.entity.data).toEqual({
      taskId: task.id,
      capabilityId: CAPS.readStatus,
      status: task.status,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(context)).not.toContain('measure load times');
    const titles = context.memory.data.flatMap((g) => g.records.map((r) => r.title));
    expect(titles).toEqual(['Task note']);
  });

  it('unknown project/task refuse typed', () => {
    const fx = contextFixture();
    const project = fx.ops.getProjectContext('ghost');
    expect(project.ok).toBe(false);
    if (!project.ok) expect(project.error.code).toBe('unknown_project');
    const task = fx.ops.getTaskContext('ghost');
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.error.code).toBe('unknown_task');
  });
});
