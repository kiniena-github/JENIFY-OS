/**
 * The Mission Room with Phase 3 missions in it (issue #253).
 *
 * `client-hydration.test.ts` proves the no-fake-state rule for every room over
 * an HQ with no missions, and the Mission Room's parity with the Command Room
 * over the same tasks. This suite adds the mission half: zero missions stays
 * zero and dark; a planned mission is present but does not animate; a working
 * mission is active; a blocked or ready-for-review mission is attention; and
 * every row copies the normalized objective and derived status the server
 * sent, never a count-derived completion and never command text.
 */

import { describe, expect, it } from 'vitest';
import { hydrateRooms } from '../src/client/hydrate.js';
import { buildHqSnapshot, emptyFounderConsole } from '../src/live/snapshot.js';
import { assertNoFabricatedFields } from '../src/live/redaction.js';
import type { Provenance } from '../src/live/provenance.js';
import type { MissionView } from '../src/application/mission-core.js';

const AT = '2026-09-05T09:00:00.000Z';
const PROVENANCE: Provenance = { mode: 'live', source: 'test', asOf: AT };

function mission(overrides: Partial<MissionView> & { id: string }): MissionView {
  return {
    title: `Mission ${overrides.id}`,
    status: 'planned',
    lifecycle: 'open',
    priority: 'p2',
    riskCeiling: 'reversible',
    project: 'qos',
    product: null,
    createdBy: 'founder',
    actorAuthentication: 'authenticated_os_session',
    createdAt: AT,
    updatedAt: AT,
    commandDigest: 'a'.repeat(64),
    commandLength: 88,
    intentVersion: 1,
    intentDigest: 'b'.repeat(64),
    intent: {
      objective: 'Improve the QOS website speed',
      scope: ['project:qos'],
      doNot: ['changing the design', 'deploying production'],
      constraints: [],
      context: { project: 'qos', product: null },
      unknowns: [],
    },
    planner: 'hq.deterministic-baseline.v1',
    tasks: [],
    decisions: [],
    blockReason: null,
    evidenceRefs: [],
    outcome: null,
    ...overrides,
  };
}

function state(missions: MissionView[]) {
  return buildHqSnapshot({
    generatedAt: AT,
    console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
    connections: { data: [], provenance: PROVENANCE },
    workforce: { data: [], provenance: PROVENANCE },
    capabilities: { data: [], provenance: PROVENANCE },
    activity: { data: [], provenance: PROVENANCE },
    missions: { data: missions, provenance: PROVENANCE },
  });
}

function room(missions: MissionView[]) {
  return hydrateRooms(state(missions), null).find((view) => view.roomId === 'mission-room')!;
}

describe('the Mission Room over Phase 3 missions', () => {
  it('reports zero missions as zero, dark, with an empty message that says why', () => {
    const view = room([]);
    expect(view.status).toBe('live');
    expect(view.liveness).toBe('dark');
    expect(view.metrics.find((metric) => metric.label === 'Missions recorded')!.value).toBe(0);
    expect(view.metrics.find((metric) => metric.label === 'Tasks recorded')!.value).toBe(0);
    expect(view.rows).toEqual([]);
    expect(view.emptyMessage).toContain('No Founder mission is recorded');
  });

  it('is merely present for a planned mission: lit quiet, never animated', () => {
    const view = room([mission({ id: 'm1' })]);
    expect(view.liveness).toBe('quiet');
    expect(view.metrics.find((metric) => metric.label === 'mission planned')!.value).toBe(1);
    expect(view.rows).toHaveLength(1);
    const row = view.rows[0]!;
    expect(row.primary).toBe('Mission m1');
    expect(row.secondary).toContain('Improve the QOS website speed');
    expect(row.secondary).toContain('2 do-not rule(s)');
    expect(row.chips.map((chip) => chip.label)).toEqual(['planned', 'p2', '0 task(s)', 'intent v1', 'qos']);
  });

  it('is active for a working mission and attention for a blocked, failed or ready-for-review one', () => {
    expect(room([mission({ id: 'w', status: 'working' })]).liveness).toBe('active');
    expect(room([mission({ id: 'b', status: 'blocked', blockReason: '1 Founder decision(s) open' })]).liveness).toBe('attention');
    expect(room([mission({ id: 'r', status: 'ready_review' })]).liveness).toBe('attention');
    expect(room([mission({ id: 'f', status: 'failed', lifecycle: 'failed' })]).liveness).toBe('attention');
    // Attention outranks active when both are present.
    expect(room([mission({ id: 'w', status: 'working' }), mission({ id: 'b', status: 'blocked', blockReason: 'x' })]).liveness).toBe('attention');
  });

  it('puts the block reason first, and counts open decisions on the row', () => {
    const view = room([
      mission({
        id: 'b',
        status: 'blocked',
        blockReason: '1 Founder decision(s) open',
        decisions: [{ id: 'd1', kind: 'founder_gate', question: 'Deploy?', status: 'open', raisedAt: AT, resolvedBy: null, resolvedAt: null, resolution: null }],
      }),
    ]);
    const row = view.rows[0]!;
    expect(row.secondary).toBe('Improve the QOS website speed — BLOCKED: 1 Founder decision(s) open');
    expect(row.chips.map((chip) => chip.label)).toContain('1 decision(s) need you');
    expect(row.chips.find((chip) => chip.label === 'blocked')!.tone).toBe('warn');
  });

  it('never claims completion from a task count: status is copied, not recomputed', () => {
    // Every task completed, but the server derived READY FOR REVIEW — and the
    // room must show exactly that, not "complete".
    const view = room([
      mission({
        id: 'r',
        status: 'ready_review',
        tasks: [
          { id: 'r/a', key: 'a', ordinal: 0, title: 'A', summary: '', dependsOn: [], riskClass: 'read_only', requiresFounderApproval: false, scope: [], doNot: [], intentVersion: 1, state: 'completed', execution: null },
        ],
      }),
    ]);
    expect(view.rows[0]!.chips[0]!.label).toBe('ready_review');
    expect(view.metrics.find((metric) => metric.label === 'mission ready_review')!.value).toBe(1);
    expect(view.metrics.find((metric) => metric.label === 'mission complete')).toBeUndefined();
  });

  it('settled missions are present but do not light the room beyond quiet', () => {
    const view = room([mission({ id: 'c', status: 'complete', lifecycle: 'complete' }), mission({ id: 'x', status: 'cancelled', lifecycle: 'cancelled' })]);
    expect(view.liveness).toBe('quiet');
    expect(view.rows.map((row) => row.chips[0]!.tone)).toEqual(['accent', 'neutral']);
  });

  it('carries no fabricated field and no command text, on the snapshot or the room', () => {
    const snapshot = state([mission({ id: 'm1', status: 'working' })]);
    expect(() => assertNoFabricatedFields(snapshot)).not.toThrow();
    const serialized = JSON.stringify(room([mission({ id: 'm1' })]));
    expect(serialized).not.toContain('originalInstruction');
    expect(serialized).not.toContain('progress');
    expect(serialized).not.toContain('eta');
  });
});
