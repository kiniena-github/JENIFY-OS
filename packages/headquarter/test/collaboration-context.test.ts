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
 *
 * Plus the Phase 9 corrections this suite now owns:
 * - H1: the truth section reads the PRIVATE derivation, so a same-realm patch
 *   of the public `listTruth` projection can neither push a real founder_only
 *   record into another worker's bundle nor forge the withheld accounting away;
 * - M2: the read carries the same gates as the sibling WRITE paths — the
 *   capability trio, the directory grant and the session's derived standing —
 *   and fails closed on every stop lever, with the Founder-gated audit path
 *   deliberately still able to read a closed room;
 * - L3: a worker learns categorically that founder_only material was withheld,
 *   never how much; the Founder audit keeps the exact counts;
 * - L4: for a worker, an unknown session and a session it is not in are ONE
 *   indistinguishable refusal.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_CONTEXT_LIMIT,
  COLLABORATION_CONTRIBUTE_CAPABILITY,
  CONTEXT_SECTIONS_BY_ROLE,
} from '../src/application/collaboration-command.js';
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
    // A worker is told categorically what was withheld, never a founder_only
    // cardinality (Phase 9 correction, Low L3).
    expect(bundle.withheld).toEqual({ audience: 'worker', founderOnlyMemory: false, founderOnlyTruth: false, otherSessionContributions: 1 });
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
    // The WORKER learns that something was withheld, not how much (L3).
    expect(bundle.withheld).toMatchObject({ audience: 'worker', founderOnlyMemory: true });
    expect(bundle.task).toBeNull();
    expect(JSON.stringify(bundle)).not.toContain('Other mission note');
    // The Founder-gated audit of the same role keeps the exact count.
    const audit = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'planner', requestedBy: 'founder' }));
    expect(audit.withheld).toMatchObject({ audience: 'founder_audit', founderOnlyMemory: 1 });
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
    // Categorical for the worker; exact for the Founder-gated audit (L3).
    expect(bundle.withheld).toMatchObject({ audience: 'worker', founderOnlyTruth: true });
    expect(JSON.stringify(bundle.withheld)).not.toContain('1');
    expect(bundle.memory).toBeNull();
    const wire = JSON.stringify(bundle);
    expect(wire).not.toContain('PRIVATE-TRUTH');
    expect(wire).not.toContain('OTHER-MISSION-TRUTH');
    expect(wire).not.toContain('Internal mission note');
    const audit = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'reviewer', requestedBy: 'founder' }));
    expect(audit.withheld).toMatchObject({ audience: 'founder_audit', founderOnlyTruth: 1 });
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

describe('the truth section reads the private derivation, not the patchable projection (H1)', () => {
  it('a same-realm patch that relabels privacy on the REAL rows — on the instance AND the prototype — neither reveals a founder_only record to another worker nor forges the withheld accounting away', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const internal = expectOk(
      fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'Load time is 4.2 s.', evidenceRefs: [fx.evidenceId], requestedBy: 'claude' }),
    ).record;
    const priv = expectOk(
      fx.ops.recordTruth({ entityKind: 'mission', entityId: fx.missionId, statement: 'PRIVATE-TRUTH-H1', privacy: 'founder_only', requestedBy: 'founder' }),
    ).record;

    const proto = HeadquarterOperations.prototype as unknown as Record<string, unknown>;
    const instance = fx.ops as unknown as Record<string, unknown>;
    const original = proto.listTruth as (...args: unknown[]) => { privacy: string }[];
    // The exploit from the hostile review, verbatim in shape: wrap the real
    // read and relabel `privacy` on the rows it actually returned.
    const forged = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, args).map((view) => ({ ...view, privacy: 'internal' }));
    };
    proto.listTruth = forged;
    try {
      instance.listTruth = forged;
    } catch {
      /* a non-writable instance slot is a pass — the prototype patch stands */
    }
    try {
      // (a) The lie has taken on the PUBLIC surface: the real founder_only
      // record is there, relabelled, through both the instance and the class.
      const publicView = fx.ops.listTruth();
      expect(publicView.map((view) => view.id)).toContain(priv.id);
      expect(publicView.every((view) => view.privacy === 'internal')).toBe(true);
      // Class-wide, not just this instance: a freshly constructed facade over
      // the same file inherits the forged read too.
      expect(new HeadquarterOperations(fx.db).listTruth().every((view) => view.privacy === 'internal')).toBe(true);

      // (b) The record still does not reach another worker's bundle.
      const bundle = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'reviewer', requestedBy: 'codex' }));
      expect(bundle.truth!.items.map((item) => item.id)).toEqual([internal.id]);
      expect(bundle.truth!.total).toBe(1);
      expect(JSON.stringify(bundle)).not.toContain('PRIVATE-TRUTH-H1');
      expect(JSON.stringify(bundle)).not.toContain(priv.id);

      // (c) The bundle's own honesty field cannot be forged away.
      expect(bundle.withheld).toMatchObject({ audience: 'worker', founderOnlyTruth: true });
      const audit = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'reviewer', requestedBy: 'founder' }));
      expect(audit.withheld).toMatchObject({ audience: 'founder_audit', founderOnlyTruth: 1 });
    } finally {
      proto.listTruth = original;
      delete instance.listTruth;
    }
    // And with the patch gone the honest read is unchanged.
    expect(fx.ops.listTruth().find((view) => view.id === priv.id)!.privacy).toBe('founder_only');
  });
});

describe('the bundle carries the same gates as the write paths and fails closed (M2)', () => {
  it('a cancelled mission closes the room for a WORKER’s read exactly as it closes the write — while the Founder-gated audit may still read it', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    contribute(fx, sessionId, { content: 'ROOM-CONTENT-BEFORE-THE-STOP' });
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'cancelled', note: 'stopped', requestedBy: 'founder' }));
    // The write path's answer, and now the read path's too.
    expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', requestedBy: 'claude' }))).toBe('session_closed');
    const refused = fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' });
    expect(errorCode(refused)).toBe('session_closed');
    expect(JSON.stringify(refused)).not.toContain('ROOM-CONTENT-BEFORE-THE-STOP');
    // Decided and pinned: auditing what a role received is exactly what is
    // needed AFTER a mission is cancelled, and it hands nothing to a worker.
    const audit = expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'founder' }));
    expect(audit.mission.status).toBe('cancelled');
  });

  it('a disabled capability row closes the read: the contribute trio for a worker, the command trio for the Founder audit', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const registry = new CapabilityRegistry(fx.db);
    registry.setEnabled(COLLABORATION_CONTRIBUTE_CAPABILITY.id, false);
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' }))).toBe('capability_disabled');
    // The Founder audit runs on its own trio and is unaffected by that row.
    expect(expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'founder' })).role).toBe('builder');
    registry.setEnabled(COLLABORATION_CONTRIBUTE_CAPABILITY.id, true);
    registry.setEnabled(COLLABORATION_COMMAND_CAPABILITY.id, false);
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'founder' }))).toBe('capability_disabled');
    expect(expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' })).role).toBe('builder');
    // Drift closes it too, and detection never repairs.
    registry.setEnabled(COLLABORATION_COMMAND_CAPABILITY.id, true);
    fx.db.prepare(`UPDATE op_capabilities SET side_effect = 1 WHERE id = ?`).run(COLLABORATION_CONTRIBUTE_CAPABILITY.id);
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' }))).toBe('not_permitted');
  });

  it('revoking the worker’s hq.collaboration_contribute grant closes the read, and the admitted participant row does not survive it', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    expect(expectOk(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' })).role).toBe('builder');
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus],
      active: true,
    });
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' }))).toBe('not_permitted');
    // Still an admitted participant — membership was never the missing gate.
    expect(fx.ops.getCollaborationSession(sessionId)!.participants.map((p) => p.workerId)).toContain('claude');
    // Deactivating the worker closes it on the assignability gate instead.
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus, COLLABORATION_CONTRIBUTE_CAPABILITY.id],
      active: false,
    });
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' }))).toBe('worker_not_assignable');
  });

  it('the gate reads canonical truth: forged workers.allowedCapabilities and queue.capabilities on the instance and the prototype open nothing', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    admit(fx, sessionId, 'mute-bot', 'critic');
    new CapabilityRegistry(fx.db).setEnabled(COLLABORATION_CONTRIBUTE_CAPABILITY.id, false);
    const savedGrant = fx.ops.workers.allowedCapabilities;
    const savedGet = fx.ops.queue.capabilities.get;
    const savedList = fx.ops.queue.capabilities.list;
    const honestRow = savedGet.call(fx.ops.queue.capabilities, COLLABORATION_CONTRIBUTE_CAPABILITY.id)!;
    const forgedRow = { ...honestRow, enabled: true };
    fx.ops.workers.allowedCapabilities = () => [CAPS.readStatus, COLLABORATION_CONTRIBUTE_CAPABILITY.id];
    fx.ops.queue.capabilities.get = (id: string) => (id === COLLABORATION_CONTRIBUTE_CAPABILITY.id ? forgedRow : savedGet.call(fx.ops.queue.capabilities, id));
    fx.ops.queue.capabilities.list = () => savedList.call(fx.ops.queue.capabilities).map((cap) => (cap.id === COLLABORATION_CONTRIBUTE_CAPABILITY.id ? forgedRow : cap));
    try {
      // The lies took on the public surfaces.
      expect(fx.ops.workers.allowedCapabilities('mute-bot')).toContain(COLLABORATION_CONTRIBUTE_CAPABILITY.id);
      expect(fx.ops.queue.capabilities.get(COLLABORATION_CONTRIBUTE_CAPABILITY.id)!.enabled).toBe(true);
      // Neither decision moved: the capability row and the directory grant are
      // read from the database, exactly as the write paths read them.
      expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'builder', requestedBy: 'claude' }))).toBe('capability_disabled');
      new CapabilityRegistry(fx.db).setEnabled(COLLABORATION_CONTRIBUTE_CAPABILITY.id, true);
      expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId, role: 'critic', requestedBy: 'mute-bot' }))).toBe('not_permitted');
    } finally {
      fx.ops.workers.allowedCapabilities = savedGrant;
      fx.ops.queue.capabilities.get = savedGet;
      fx.ops.queue.capabilities.list = savedList;
    }
  });
});

describe('a worker cannot use the bundle to discover which sessions exist (L4)', () => {
  it('a REAL session the worker is not admitted to refuses byte-identically to a session id that never existed; the Founder-gated path still distinguishes them', () => {
    const fx = collaborationFixture();
    const mine = roomWithThree(fx);
    const theirs = openSession(fx, { title: 'Room jules is not in' });
    admit(fx, theirs.id, 'codex', 'reviewer');

    const notMine = fx.ops.assembleCollaborationContext({ sessionId: theirs.id, role: 'builder', requestedBy: 'jules' });
    const neverExisted = fx.ops.assembleCollaborationContext({ sessionId: 'collab-never-existed', role: 'builder', requestedBy: 'jules' });
    expect(errorCode(notMine)).toBe('unknown_session');
    expect(errorCode(neverExisted)).toBe('unknown_session');
    // Identical but for the id the caller itself supplied — no code, message,
    // or details field separates "not yours" from "not real".
    const shape = (result: unknown, id: string) => JSON.stringify(result).split(id).join('<SESSION-ID>');
    expect(shape(notMine, theirs.id)).toBe(shape(neverExisted, 'collab-never-existed'));

    // Inside its own room, a worker may still be told it holds another role
    // there — it already knows that session exists.
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId: mine, role: 'reviewer', requestedBy: 'jules' }))).toBe('not_permitted');

    // The Founder-gated commander path keeps the distinguishing answers.
    expect(expectOk(fx.ops.assembleCollaborationContext({ sessionId: theirs.id, role: 'reviewer', requestedBy: 'founder' })).sessionId).toBe(theirs.id);
    expect(errorCode(fx.ops.assembleCollaborationContext({ sessionId: 'collab-never-existed', role: 'reviewer', requestedBy: 'founder' }))).toBe('unknown_session');
  });
});
