/**
 * Phase 7 — the truth projection on the read surfaces: the optional snapshot
 * section, the three rooms that project it (Security Center, Founder Office,
 * Company Memory), and the wire guards. Every number shown is a count of a
 * derived categorical state; a document without the section changes no room;
 * the browser view carries no key the fabricated-field guard refuses.
 */

import { describe, expect, it } from 'vitest';
import { hydrateRooms } from '../src/client/hydrate.js';
import { buildHqSnapshot, emptyFounderConsole, liveSnapshotFromOperations, type HqSnapshot } from '../src/live/snapshot.js';
import { FABRICATED_FIELD_NAMES, assertBrowserSafe, assertNoFabricatedFields } from '../src/live/redaction.js';
import type { ClientSession } from '../src/client/contracts.js';
import type { Provenance } from '../src/live/provenance.js';
import { claim, confirm, truthFixture } from './truth.fixture.js';

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

describe('the snapshot section', () => {
  it('is absent from a build that read no truth store, and every fixture without it still builds', () => {
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
    expect(state.truth).toBeUndefined();
    for (const id of ['security-center', 'founder-office', 'company-memory']) {
      const view = room(state, id);
      expect(view.metrics.map((m) => m.label)).not.toContain('Truth contradictions');
      expect(view.metrics.map((m) => m.label)).not.toContain('Truth records');
      expect(view.metrics.map((m) => m.label)).not.toContain('Verified, awaiting acceptance');
    }
  });

  it('carries derived states with the totals stated, and clears both wire guards', () => {
    const fx = truthFixture();
    const record = claim(fx);
    confirm(fx, record.id);
    const rival = claim(fx, { statement: 'CI is red.', contradicts: [record.id], requestedBy: 'analyst' });
    void rival;
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(state.truth).toBeDefined();
    const truth = state.truth!.data;
    expect(truth.total).toBe(2);
    expect(truth.byState).toEqual({ claimed: 1, observed: 0, verified: 1, accepted: 0 });
    expect(truth.unresolvedContradictions).toBe(1);
    expect(truth.records[0]!.statement).toBe('CI is red.');
    expect(state.truth!.provenance.source).toContain('op_evidence');
    expect(() => assertBrowserSafe(state)).not.toThrow();
    expect(() => assertNoFabricatedFields(state)).not.toThrow();
    // No key of the browser view is a fabricated-metric name, at any depth.
    const keys = new Set<string>();
    JSON.stringify(state.truth, (key, value) => {
      if (key) keys.add(key);
      return value as unknown;
    });
    for (const banned of FABRICATED_FIELD_NAMES) expect(keys.has(banned), banned).toBe(false);
    expect(keys.has('confidence')).toBe(false);
    expect(keys.has('score')).toBe(false);
  });
});

describe('the rooms', () => {
  it('Security Center lists each unresolved contradiction as attention; Founder Office counts verified-awaiting-acceptance', () => {
    const fx = truthFixture();
    const record = claim(fx);
    confirm(fx, record.id);
    const calm = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    const securityCalm = room(calm, 'security-center');
    expect(securityCalm.metrics.find((m) => m.label === 'Truth contradictions')!.value).toBe('none unresolved');
    expect(securityCalm.rows.some((r) => r.id.startsWith('contradiction-'))).toBe(false);
    const founderCalm = room(calm, 'founder-office');
    expect(founderCalm.metrics.find((m) => m.label === 'Verified, awaiting acceptance')!.value).toBe(1);
    expect(founderCalm.liveness).toBe('attention');

    claim(fx, { statement: 'CI is red.', contradicts: [record.id], requestedBy: 'analyst' });
    const contested = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    const security = room(contested, 'security-center');
    expect(security.metrics.find((m) => m.label === 'Truth contradictions')!.value).toBe('1 unresolved');
    const contradictionRow = security.rows.find((r) => r.id.startsWith('contradiction-'))!;
    expect(contradictionRow.primary).toContain(`Unresolved contradiction on task ${fx.taskId}`);
    expect(contradictionRow.secondary).toContain('Neither side is preferred by recency');
    expect(security.liveness).toBe('attention');
    // A contested verified record is no longer acceptable, and the office says so.
    const founder = room(contested, 'founder-office');
    expect(founder.metrics.find((m) => m.label === 'Verified, awaiting acceptance')!.value).toBe(0);
  });

  it('Company Memory shows truth counts beside memory; an accepted record moves the accepted count only', () => {
    const fx = truthFixture();
    const record = claim(fx);
    confirm(fx, record.id);
    fx.ops.acceptTruth({
      truthId: record.id,
      expectedDigest: fx.ops.getTruthRecord(record.id)!.acceptanceDigest!,
      requestedBy: 'founder',
    });
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    const memory = room(state, 'company-memory');
    const metric = (label: string) => memory.metrics.find((m) => m.label === label)!.value;
    expect(metric('Truth records')).toBe(1);
    expect(metric('Verified')).toBe(0);
    expect(metric('Accepted')).toBe(1);
    expect(metric('Records')).toBe(0);
    expect(memory.liveness).toBe('quiet');
    const founder = room(state, 'founder-office');
    expect(founder.metrics.find((m) => m.label === 'Founder-accepted')!.value).toBe(1);
    expect(founder.metrics.find((m) => m.label === 'Verified, awaiting acceptance')!.value).toBe(0);
  });

  it('a room with no truth rows and no other state stays dark — zero is zero', () => {
    const fx = truthFixture();
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(state.truth!.data.total).toBe(0);
    expect(room(state, 'company-memory').liveness).toBe('dark');
    expect(room(state, 'company-memory').metrics.find((m) => m.label === 'Truth records')!.value).toBe(0);
  });
});
