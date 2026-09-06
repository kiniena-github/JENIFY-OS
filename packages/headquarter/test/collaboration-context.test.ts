/**
 * Phase 9 — context bundles are bounded, role/task/mission-scoped and
 * privacy-safe. What this suite pins: a bundle carries the ONE mission's
 * current structured intent (never the raw order/rationale), the ONE task's
 * minimal ref (never its payload), this session's participants and
 * contributions (never another session's — counted as withheld), internal
 * truth and entity-linked internal memory only where the role's policy
 * grants the section (founder_only counted as withheld, never carried), every
 * list bounded with its true total; a worker receives only the bundle of a
 * role it holds; assembly writes nothing and repeats deterministically; and
 * nothing unrelated to the mission ever enters (the no-global-dump rule).
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { COLLABORATION_CONTEXT_LIMIT, CONTEXT_SECTIONS_BY_ROLE } from '../src/application/collaboration-command.js';
import { admit, collaborationFixture, contribute, count, errorCode, openSession, roomWithThree, type CollaborationFixture } from './collaboration.fixture.js';

const RAW_RATIONALE = 'RATIONALE-TEXT-THAT-MUST-STAY-SERVER-SIDE';

function remember(fx: CollaborationFixture, over: Partial<Parameters<CollaborationFixture['ops']['recordMemory']>[0]> = {}) {
  return expectOk(
    fx.ops.recordMemory({
      kind: 'founder_note',
      title: 'Load-time note',
      body: 'The CDN cache TTL was raised last week.',
      project: 'qos',
      missionId: fx.missionId,
      requestedBy: 'founder',
      ...over,
    }),
  );
}

/** Every stored row in every table, as one string — the "assembly writes nothing" pin. */
function everyRow(fx: CollaborationFixture): string {
  const tables = (fx.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
  return JSON.stringify(tables.map((table) => [table, fx.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function stripClock<T extends { assembledAt: string; provenance: { asOf: string } }>(bundle: T): Omit<T, 'assembledAt' | 'provenance'> & { provenance: Omit<T['provenance'], 'asOf'> } {
  const { assembledAt, provenance, ...rest } = bundle;
  void assembledAt;
  const { asOf, ...provenanceRest } = provenance;
  void asOf;
  return { ...rest, provenance: provenanceRest } as never;
}

describe('a bundle is scoped to one mission, one session and (when named) one task', () => {
  it('a builder bundle carries the current structured intent without the raw amendment text, the task ref without its payload, this session only, internal memory only, no truth section, every list bounded with the total stated', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    expectOk(fx.ops.amendMissionIntent({ missionId: fx.missionId, amendment: RAW_RATIONALE, objective: 'Reduce page load times to under two seconds', requestedBy: 'founder' }));
    remember(fx, { title: 'Internal mission note' });
    remember(fx, { title: 'Private mission note', privacy: 'founder_only' });
    remember(fx, { title: 'Internal task note', missionId: undefined, taskId: fx.taskId });
    remember(fx, { title: 'Unrelated global note about salt pricing', missionId: undefined });
    for (let i = 0; i < COLLABORATION_CONTEXT_LIMIT + 3; i += 1) {
      contribute(fx, sessionId, { content: `Finding ${i}`, requestedBy: i % 2 === 0 ? 'claude' : 'jules', taskId: i % 3 === 0 ? fx.taskId : undefined });
    }
    // Another session on the same mission, whose contributions must stay out.
    const other = openSession(fx, { title: 'Other room' });
    admit(fx, other.id, 'codex', 'critic');
    contribute(fx, other.id, { kind: 'critique', content: 'OTHER-SESSION-CONTENT', requestedBy: 'codex' });

    const bundle = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', taskId: fx.taskId, requestedBy: 'claude' }));
    expect(bundle.sections).toEqual(CONTEXT_SECTIONS_BY_ROLE.builder);
    expect(bundle.mission).toMatchObject({ id: fx.missionId, objective: 'Reduce page load times to under two seconds', intentSeq: 1, status: 'planned' });
    expect(bundle.mission.planItems.map((item) => item.seq)).toEqual([1, 2]);
    expect(bundle.task).toEqual({ taskId: fx.taskId, capabilityId: CAPS.readStatus, status: 'queued', createdAt: expect.any(String) });
    expect(bundle.participants!.map((p) => p.workerId).sort()).toEqual(['claude', 'codex', 'jules']);
    expect(bundle.contributions!.items).toHaveLength(COLLABORATION_CONTEXT_LIMIT);
    expect(bundle.contributions!.total).toBe(COLLABORATION_CONTEXT_LIMIT + 3);
    expect(bundle.truth).toBeNull();
    const memoryTitles = bundle.memory!.groups.flatMap((group) => group.records.map((record) => record.title));
    expect(memoryTitles).toContain('Internal task note');
    expect(memoryTitles).not.toContain('Private mission note');
    expect(memoryTitles).not.toContain('Unrelated global note about salt pricing');
    expect(bundle.withheld).toEqual({ founderOnlyMemory: 0, founderOnlyTruth: 0, otherSessionContributions: 1 });
    const wire = JSON.stringify(bundle);
    expect(wire).not.toContain(RAW_RATIONALE);
    expect(wire).not.toContain('lighthouse');
    expect(wire).not.toContain('OTHER-SESSION-CONTENT');
    expect(wire).not.toContain('Private mission note');
    expect(wire).not.toContain('intentHistory');
  });

  it('a mission-scoped planner bundle counts the withheld founder_only memory beside the internal memory it carries; an unrelated mission’s memory never appears', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    admit(fx, sessionId, 'claude', 'planner');
    remember(fx, { title: 'Internal mission note' });
    remember(fx, { title: 'Private mission note', privacy: 'founder_only' });
    const otherMission = expectOk(fx.ops.commandMission({ title: 'Other mission', objective: 'Unrelated', requestedBy: 'founder' })).mission;
    remember(fx, { title: 'Other mission note', missionId: otherMission.id });
    const bundle = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'planner', requestedBy: 'claude' }));
    const titles = bundle.memory!.groups.flatMap((group) => group.records.map((record) => record.title));
    expect(titles).toEqual(['Internal mission note']);
    expect(bundle.withheld.founderOnlyMemory).toBe(1);
    expect(bundle.task).toBeNull();
    expect(JSON.stringify(bundle)).not.toContain('Other mission note');
  });

  it('a reviewer bundle carries internal truth about the mission and its tasks — never founder_only truth, never truth about another mission — and no memory section', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const internal = expectOk(fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'Load time is 4.2 s.', evidenceRefs: [fx.evidenceId], requestedBy: 'claude' })).record;
    expectOk(fx.ops.recordTruth({ entityKind: 'mission', entityId: fx.missionId, statement: 'PRIVATE-TRUTH', privacy: 'founder_only', requestedBy: 'founder' }));
    const otherMission = expectOk(fx.ops.commandMission({ title: 'Other mission', objective: 'Unrelated', requestedBy: 'founder' })).mission;
    expectOk(fx.ops.recordTruth({ entityKind: 'mission', entityId: otherMission.id, statement: 'OTHER-MISSION-TRUTH', requestedBy: 'founder' }));
    remember(fx, { title: 'Internal mission note' });
    const bundle = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'reviewer', requestedBy: 'codex' }));
    expect(bundle.sections).toEqual(CONTEXT_SECTIONS_BY_ROLE.reviewer);
    expect(bundle.truth!.items.map((item) => item.id)).toEqual([internal.id]);
    expect(bundle.truth!.items[0]).toMatchObject({ state: 'claimed', contested: false, evidenceRefs: [fx.evidenceId] });
    expect(bundle.truth!.total).toBe(1);
    expect(bundle.withheld.founderOnlyTruth).toBe(1);
    expect(bundle.memory).toBeNull();
    const wire = JSON.stringify(bundle);
    expect(wire).not.toContain('PRIVATE-TRUTH');
    expect(wire).not.toContain('OTHER-MISSION-TRUTH');
    expect(wire).not.toContain('Internal mission note');
  });
});

describe('who receives a bundle', () => {
  it('a worker receives only the bundle of a role it holds in that session; a human without the command grant, system and an unknown id are refused; the Founder audits any role', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    expect(expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' })).role).toBe('builder');
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'reviewer', requestedBy: 'claude' }))).toBe('not_permitted');
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'mute-bot' }))).toBe('not_permitted');
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'retired-bot' }))).toBe('worker_not_assignable');
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'analyst' }))).toBe('not_permitted');
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'system' }))).toBe('not_permitted');
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'ghost' }))).toBe('unknown_principal');
    for (const role of ['planner', 'builder', 'researcher', 'reviewer', 'verifier', 'critic'] as const) {
      const bundle = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role, requestedBy: 'founder' }));
      expect(bundle.sections).toEqual(CONTEXT_SECTIONS_BY_ROLE[role]);
    }
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId: 'no-such-session', role: 'builder', requestedBy: 'founder' }))).toBe('unknown_session');
    // An unknown id learns nothing about which sessions exist.
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId: 'no-such-session', role: 'builder', requestedBy: 'ghost' }))).toBe('unknown_principal');
    const unlinked = expectOk(fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: { check: 'other' }, idempotencyKey: 'ctx-unlinked', requestedBy: 'claude' })).task;
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', taskId: unlinked.id, requestedBy: 'claude' }))).toBe('invalid_input');
  });

  it('assembly writes nothing — every row in every table byte-identical, no evidence, no event — and repeats deterministically', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    contribute(fx, sessionId);
    remember(fx, { title: 'Internal mission note' });
    const before = everyRow(fx);
    const evidenceBefore = count(fx, 'op_evidence');
    const eventsBefore = count(fx, 'hq_events');
    const first = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'planner', requestedBy: 'founder' }));
    const second = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'planner', requestedBy: 'founder' }));
    expect(stripClock(second)).toEqual(stripClock(first));
    expect(everyRow(fx)).toBe(before);
    expect(count(fx, 'op_evidence')).toBe(evidenceBefore);
    expect(count(fx, 'hq_events')).toBe(eventsBefore);
  });
});
