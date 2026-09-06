/**
 * Phase 9 — the collaboration record on the read surfaces: the optional
 * snapshot section, the Mission Room that projects it, and the wire guards.
 * Every number shown is a count the server made over stored admissions and
 * contributions; a document without the section changes no room; the
 * section carries no founder_only material, no raw intent body and no task
 * payload; and no key of it is a fabricated-metric name.
 */

import { describe, expect, it } from 'vitest';
import { hydrateRooms } from '../src/client/hydrate.js';
import { buildHqSnapshot, emptyFounderConsole, liveSnapshotFromOperations, type HqSnapshot } from '../src/live/snapshot.js';
import { FABRICATED_FIELD_NAMES, assertBrowserSafe, assertNoFabricatedFields } from '../src/live/redaction.js';
import type { ClientSession } from '../src/client/contracts.js';
import type { Provenance } from '../src/live/provenance.js';
import { COLLABORATION_SNAPSHOT_LIMIT } from '../src/application/collaboration-command.js';
import { expectOk } from './application.fixture.js';
import { admit, collaborationFixture, contribute, openSession, roomWithThree } from './collaboration.fixture.js';

const AT = '2026-09-06T12:00:00.000Z';
const PROVENANCE: Provenance = { mode: 'live', source: 'test', asOf: AT };
const SESSION: ClientSession = {
  ok: true,
  authenticated: true,
  founder: true,
  principalId: 'founder',
  displayName: 'Founder',
  approvalAuthority: true,
  controls: { mutationsEnabled: true, trustedOriginConfigured: true, requestOriginAllowed: true, requestOriginSource: 'referer' },
};

function room(state: HqSnapshot, id: string) {
  return hydrateRooms(state, SESSION).find((view) => view.roomId === id)!;
}

const COLLABORATION_METRICS = ['Collaboration sessions', 'Workers admitted', 'Contributions', 'Open disagreements', 'Handoff requests'];

describe('the snapshot section', () => {
  it('is absent from a build that read no collaboration store, and the Mission Room then shows no collaboration metric', () => {
    const state = buildHqSnapshot({
      generatedAt: AT,
      projects: { data: [], provenance: PROVENANCE },
      memory: { data: [], provenance: PROVENANCE },
      console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
      connections: { data: [], provenance: PROVENANCE },
      workforce: { data: [], provenance: PROVENANCE },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
      missions: { data: [], provenance: PROVENANCE },
    });
    expect(state.collaboration).toBeUndefined();
    const view = room(state, 'mission-room');
    for (const label of COLLABORATION_METRICS) expect(view.metrics.map((m) => m.label)).not.toContain(label);
    expect(view.liveness).toBe('dark');
  });

  it('carries counts over every session plus the newest sessions, clears both wire guards, and no key is a fabricated-metric name', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    expectOk(fx.ops.amendMissionIntent({ missionId: fx.missionId, amendment: 'RATIONALE-NEVER-ON-THE-WIRE', objective: 'Faster', requestedBy: 'founder' }));
    const finding = contribute(fx, sessionId, { taskId: fx.taskId });
    contribute(fx, sessionId, { kind: 'critique', content: 'No.', requestedBy: 'codex', disagreesWith: [finding.id] });
    contribute(fx, sessionId, { kind: 'handoff_request', content: 'To jules.', handoff: { taskId: fx.taskId, toWorkerId: 'jules', reason: 'r' } });
    for (let i = 0; i < COLLABORATION_SNAPSHOT_LIMIT + 1; i += 1) openSession(fx, { title: `Room ${i}` });
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(state.collaboration).toBeDefined();
    const collaboration = state.collaboration!.data;
    expect(collaboration).toMatchObject({
      sessions: COLLABORATION_SNAPSHOT_LIMIT + 2,
      activeSessions: COLLABORATION_SNAPSHOT_LIMIT + 2,
      workersAdmitted: 3,
      contributions: 3,
      disagreements: 1,
      handoffRequests: 1,
    });
    expect(collaboration.recent).toHaveLength(COLLABORATION_SNAPSHOT_LIMIT);
    expect(state.collaboration!.provenance.note).toContain(`newest ${COLLABORATION_SNAPSHOT_LIMIT} of ${COLLABORATION_SNAPSHOT_LIMIT + 2}`);
    expect(() => assertBrowserSafe(state)).not.toThrow();
    expect(() => assertNoFabricatedFields(state)).not.toThrow();
    const keys = new Set<string>();
    JSON.stringify(state.collaboration, (key, value) => {
      if (key) keys.add(key);
      return value as unknown;
    });
    for (const banned of FABRICATED_FIELD_NAMES) expect(keys.has(banned), banned).toBe(false);
    expect(keys.has('confidence')).toBe(false);
    expect(keys.has('progress')).toBe(false);
    const wire = JSON.stringify(state.collaboration);
    expect(wire).not.toContain('RATIONALE-NEVER-ON-THE-WIRE');
    expect(wire).not.toContain('lighthouse');
    expect(wire).not.toContain('The hero image');
  });
});

describe('the Mission Room', () => {
  it('counts sessions, admitted workers, contributions, disagreements and handoff requests; a disagreement or handoff lights attention, recorded contributions light active, an admitted-but-silent session is quiet', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    admit(fx, session.id, 'claude', 'builder');
    admit(fx, session.id, 'codex', 'reviewer');
    let view = room(liveSnapshotFromOperations(fx.ops, { now: AT }), 'mission-room');
    const metric = (label: string) => view.metrics.find((m) => m.label === label)!;
    expect(metric('Collaboration sessions').value).toBe(1);
    expect(metric('Workers admitted').value).toBe(2);
    expect(metric('Contributions').value).toBe(0);
    expect(metric('Open disagreements').value).toBe(0);
    expect(metric('Handoff requests').value).toBe(0);
    // A planned mission with one silent session: present, nothing active, nothing needing a decision.
    expect(view.liveness).toBe('quiet');
    expect(view.rows.some((r) => r.id === `collaboration-${session.id}`)).toBe(true);

    const finding = contribute(fx, session.id);
    view = room(liveSnapshotFromOperations(fx.ops, { now: AT }), 'mission-room');
    expect(view.metrics.find((m) => m.label === 'Contributions')!.value).toBe(1);
    expect(view.liveness).toBe('active');

    contribute(fx, session.id, { kind: 'critique', content: 'Disagree.', requestedBy: 'codex', disagreesWith: [finding.id] });
    view = room(liveSnapshotFromOperations(fx.ops, { now: AT }), 'mission-room');
    expect(view.metrics.find((m) => m.label === 'Open disagreements')!.value).toBe(1);
    expect(view.liveness).toBe('attention');
    const row = view.rows.find((r) => r.id === `collaboration-${session.id}`)!;
    expect(row.chips.map((c) => c.label)).toContain('disagreement');
    expect(row.secondary).toContain('1 disagreement(s)');
  });

  it('a mission with no session shows zero for every collaboration count and lights nothing for them — the room is quiet from the planned mission alone', () => {
    const fx = collaborationFixture();
    const view = room(liveSnapshotFromOperations(fx.ops, { now: AT }), 'mission-room');
    expect(view.metrics.find((m) => m.label === 'Collaboration sessions')!.value).toBe(0);
    expect(view.metrics.find((m) => m.label === 'Workers admitted')!.value).toBe(0);
    // One planned mission is present, so the room is quiet — not lit by any collaboration count.
    expect(view.liveness).toBe('quiet');
    expect(view.rows.filter((r) => r.id.startsWith('collaboration-'))).toEqual([]);
  });
});
