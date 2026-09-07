/**
 * Phase 10 — the derived command layer on the read surfaces: the optional
 * snapshot section, the Command Room that projects it, and the wire guards.
 *
 * The section is the one place this phase crosses to an UNAUTHENTICATED
 * reader, so the disclosure discipline is what most of this suite is about:
 * an item derived from a `founder_only` truth record is not carried, no
 * number aggregates over one, and both omissions are counted and stated in
 * the provenance. Beside that: every number is a count the server made,
 * nothing on the artifact is a fabricated metric, and a document without the
 * section changes no room.
 */

import { describe, expect, it } from 'vitest';
import { hydrateRooms } from '../src/client/hydrate.js';
import { buildHqSnapshot, emptyFounderConsole, liveSnapshotFromOperations, type HqSnapshot } from '../src/live/snapshot.js';
import { FABRICATED_FIELD_NAMES, assertBrowserSafe, assertNoFabricatedFields } from '../src/live/redaction.js';
import type { ClientSession } from '../src/client/contracts.js';
import type { Provenance } from '../src/live/provenance.js';
import { COMMAND_CENTER_SNAPSHOT_LIMIT } from '../src/application/chief-of-staff.js';
import { CAPS, expectOk } from './application.fixture.js';
import { commandCenterFixture, taskAwaitingApproval } from './command-center.fixture.js';
import { HQ_ROOMS } from '../src/client/rooms.js';

const AT = '2026-09-07T12:00:00.000Z';
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

const ATTENTION_METRIC = 'Needs the Founder';

describe('the snapshot section', () => {
  it('is absent from a build that read no canonical store, and the Command Room then shows no attention metric', () => {
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
    expect(state.commandCenter).toBeUndefined();
    const view = room(state, 'command-room');
    expect(view.metrics.map((metric) => metric.label)).not.toContain(ATTENTION_METRIC);
    expect(view.liveness).toBe('dark');
  });

  it('carries the counts, the newest items and the ledger state, and clears both wire guards', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'surfaces-held');
    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'incident 42'));
    const brief = expectOk(fx.ops.issueBrief({ requestedBy: 'founder' })).brief;
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(state.commandCenter).toBeDefined();
    const centre = state.commandCenter!.data;
    expect(centre.attention.total).toBe(centre.attention.items.length);
    expect(Object.values(centre.attention.byKind).reduce((sum, value) => sum + value, 0)).toBe(centre.attention.total);
    expect(centre.attention.items.some((item) => item.reason === 'task_awaiting_approval')).toBe(true);
    expect(centre.attention.items.some((item) => item.reason === 'kill_switch_engaged')).toBe(true);
    expect(centre.recommendations.total).toBe(centre.attention.total);
    expect(centre.briefs).toEqual({ total: 1, latest: brief });
    expect(centre.storePresent).toBe(true);
    expect(() => assertBrowserSafe(state)).not.toThrow();
    expect(() => assertNoFabricatedFields(state)).not.toThrow();
  });

  it('names no fabricated-metric key anywhere in the section', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'surfaces-no-fabrication');
    const centre = liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.data;
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    walk(centre);
    for (const forbidden of FABRICATED_FIELD_NAMES) expect(keys.has(forbidden), forbidden).toBe(false);
    for (const shape of ['priority', 'score', 'confidence', 'percent', 'rank', 'weight', 'urgency', 'progress']) {
      expect([...keys].filter((key) => key.toLowerCase().includes(shape)), shape).toEqual([]);
    }
  });

  it('bounds the carried items and states the true total beside them', () => {
    const fx = commandCenterFixture();
    for (let index = 0; index < COMMAND_CENTER_SNAPSHOT_LIMIT + 3; index += 1) {
      taskAwaitingApproval(fx, `surfaces-bound-${index}`);
    }
    const centre = liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.data;
    expect(centre.attention.items).toHaveLength(COMMAND_CENTER_SNAPSHOT_LIMIT);
    expect(centre.attention.total).toBeGreaterThan(COMMAND_CENTER_SNAPSHOT_LIMIT);
    expect(liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.provenance.note).toContain(
      `Carries the newest ${COMMAND_CENTER_SNAPSHOT_LIMIT} of ${centre.attention.total}`,
    );
  });

  it('carries no founder_only-derived item on the unauthenticated artifact, aggregates over none, and says so', () => {
    const fx = commandCenterFixture();
    const before = liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.data.attention;
    const record = expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'The incident review names an internal supplier.',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    ).record;
    expectOk(
      fx.ops.verifyTruth({
        truthId: record.id,
        method: 'tested',
        verdict: 'confirmed',
        evidenceRefs: [fx.evidenceId],
        limitations: 'one reviewer',
        requestedBy: 'codex',
      }),
    );
    const artifact = liveSnapshotFromOperations(fx.ops, { now: AT });
    const centre = artifact.commandCenter!.data;
    expect(centre.attention.items.some((item) => item.source.id === record.id)).toBe(false);
    expect(centre.attention.withheldFounderOnly).toBe(1);
    // The withheld item is a `decision` (truth awaiting acceptance), and the
    // per-kind counts are unchanged by it: no number here aggregates over a
    // record the reader may not see.
    expect(centre.attention.byKind).toEqual(before.byKind);
    expect(centre.attention.total).toBe(before.total);
    expect(centre.recommendations.total).toBe(centre.attention.total);
    expect(JSON.stringify(artifact.commandCenter)).not.toContain('internal supplier');
    expect(artifact.commandCenter!.provenance.note).toContain('1 attention item(s) derive from founder_only truth records');

    // The Founder-gated /state build carries both, and states nothing withheld.
    const gated = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(gated.commandCenter!.data.attention.items.some((item) => item.source.id === record.id)).toBe(true);
    expect(gated.commandCenter!.data.attention.withheldFounderOnly).toBe(0);
    expect(gated.commandCenter!.provenance.note).not.toContain('derive from founder_only truth records');
  });

  it('withholds an unknown entry that names a founder_only record and keeps it out of the unknown total', () => {
    const fx = commandCenterFixture();
    // A founder_only claim citing no evidence: an explicit unknown, and a
    // private one. It must not reach the artifact in any form, including as
    // arithmetic.
    const open = liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.data.unknown.total;
    expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'A private hunch with nothing behind it.',
        bornState: 'claimed',
        evidenceRefs: [],
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    );
    const centre = liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.data;
    expect(centre.unknown.total).toBe(open);
    expect(centre.unknown.withheldFounderOnly).toBe(1);
    expect(liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.provenance.note).toContain(
      '1 unknown entry/entries name founder_only truth records',
    );
    const gated = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true }).commandCenter!.data;
    expect(gated.unknown.total).toBe(open + 1);
    expect(gated.unknown.withheldFounderOnly).toBe(0);
  });

  it('carries no department projection and no recommendation body — those stay behind the Founder gate', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'surfaces-gated-only');
    const centre = liveSnapshotFromOperations(fx.ops, { now: AT }).commandCenter!.data;
    expect(Object.keys(centre).sort()).toEqual(['attention', 'blocked', 'briefs', 'recommendations', 'storePresent', 'unknown']);
    expect(JSON.stringify(centre)).not.toContain('cybersecurity');
    expect(JSON.stringify(centre)).not.toContain('actPath');
    // The Founder-gated briefing does carry both.
    const briefing = fx.ops.founderBriefing({ includeFounderOnly: true });
    expect(briefing.departments.map((entry) => entry.department)).toContain('cybersecurity');
    expect(briefing.recommendations.items[0]!.actPath.length).toBeGreaterThan(0);
  });

});

describe('the Command Room projects the section without restating it', () => {
  it('shows one attention metric, one row per item, and lights attention', () => {
    const fx = commandCenterFixture();
    const { taskId } = taskAwaitingApproval(fx, 'surfaces-room');
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    const view = room(state, 'command-room');
    const metric = view.metrics.find((entry) => entry.label === ATTENTION_METRIC)!;
    expect(metric.value).toBe(state.commandCenter!.data.attention.total);
    expect(metric.hint).toContain('Not a priority list');
    const row = view.rows.find((entry) => entry.id.startsWith('attention-'))!;
    expect(row.secondary).toContain('op_tasks');
    expect(row.secondary).toContain(taskId);
    expect(row.secondary).toContain('resolved by approval_authority');
    expect(view.liveness).toBe('attention');
  });

  it('shows no attention metric and stays dark when HQ genuinely holds nothing', () => {
    const fx = commandCenterFixture();
    // Cancel the fixture mission so its unspecified plan item stops asking.
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'cancelled', note: 'not needed', requestedBy: 'founder' }));
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(state.commandCenter!.data.attention.total).toBe(0);
    const view = room(state, 'command-room');
    expect(view.metrics.find((entry) => entry.label === ATTENTION_METRIC)!.value).toBe(0);
    expect(view.rows.filter((entry) => entry.id.startsWith('attention-'))).toEqual([]);
    // Only the queued fixture task keeps the room out of the dark, and it is
    // shown as a row, so the room can explain everything it is lit for.
    expect(view.rows.length).toBeGreaterThan(0);
  });

  it('names the command-centre section in the Command Room’s stated binding', () => {
    const binding = HQ_ROOMS.find((entry) => entry.id === 'command-room')!.binding;
    expect(binding.kind).toBe('live');
    if (binding.kind !== 'live') throw new Error('the Command Room is bound to live canonical data');
    expect(binding.source).toContain('command-centre section');
    expect(binding.source).toContain('Founder Inbox');
  });

  it('leaves every other room’s metrics untouched', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'surfaces-other-rooms');
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    for (const other of ['mission-room', 'approvals', 'departments', 'company-memory']) {
      const view = room(state, other);
      expect(view.metrics.map((metric) => metric.label), other).not.toContain(ATTENTION_METRIC);
    }
    expect(CAPS.indexDoc).toBe('archive.index_document');
  });
});
