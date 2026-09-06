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
import { TRUTH_SNAPSHOT_LIMIT } from '../src/application/truth-command.js';
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

describe('the artifact privacy projection', () => {
  it('drops every relation id pointing at a founder_only record — supports, derived_from, contradicts and supersession alike — and counts each withheld counterpart once', () => {
    const fx = truthFixture();
    const open = claim(fx, { statement: 'Public statement.' });
    const secret = claim(fx, {
      statement: 'Private corroboration.',
      privacy: 'founder_only',
      supports: [open.id],
      derivedFrom: [open.id],
      idempotencyKey: 'secret-1',
    });
    const dispute = claim(fx, {
      statement: 'Private dispute.',
      privacy: 'founder_only',
      contradicts: [open.id],
      requestedBy: 'analyst',
      idempotencyKey: 'secret-2',
    });
    const successor = claim(fx, {
      statement: 'Private successor.',
      privacy: 'founder_only',
      supersedes: open.id,
      idempotencyKey: 'secret-3',
    });

    const gated = fx.ops.truthSummary({ includeFounderOnly: true });
    const gatedOpen = gated.records.find((r) => r.id === open.id)!;
    expect(gatedOpen.supportedBy).toEqual([secret.id]);
    expect(gatedOpen.derivations).toEqual([secret.id]);
    expect(gatedOpen.contradictedBy).toEqual([dispute.id]);
    expect(gatedOpen.supersededBy).toBe(successor.id);
    expect(gated.withheldFounderOnly).toBe(0);
    expect(gated.withheldFounderOnlyRelations).toBe(0);

    const artifact = fx.ops.truthSummary({ includeFounderOnly: false });
    expect(artifact.records.map((r) => r.id)).toEqual([open.id]);
    const carried = artifact.records[0]!;
    expect(carried.supportedBy).toEqual([]);
    expect(carried.derivations).toEqual([]);
    expect(carried.contradictedBy).toEqual([]);
    expect(carried.contradictions).toEqual([]);
    expect(carried.supersededBy).toBeNull();
    // Categorical standing stays truthful and is derived exactly as for the
    // gated reader: the record IS superseded, and that supersession resolved
    // the private dispute, so it is not contested — the same answer the
    // Founder-gated view gives, with the counterpart's identity withheld.
    expect(carried.lifecycle).toBe('superseded');
    expect(carried.contested).toBe(gatedOpen.contested);
    expect(carried.contested).toBe(false);
    expect(artifact.withheldFounderOnly).toBe(3);
    expect(artifact.withheldFounderOnlyRelations).toBe(3);
    for (const id of [secret.id, dispute.id, successor.id]) expect(JSON.stringify(artifact)).not.toContain(id);
    // The private records themselves are untouched by the projection.
    expect(fx.ops.getTruthRecord(secret.id)!.supports).toEqual([open.id]);
  });

  it('the artifact\'s aggregate counts span only the carried set — byState and the unresolved-contradiction count disclose nothing about withheld founder_only rows', () => {
    // Review round 2: `total=10, withheldFounderOnly=2, byState.accepted=3` with
    // one carried accepted record ⇒ two PRIVATE records are accepted. Aggregate
    // categorical facts about founder_only rows are still facts about them.
    const fx = truthFixture();
    claim(fx, { statement: 'Public claim.' });
    const privateVerified = claim(fx, { statement: 'Private, verified.', privacy: 'founder_only', idempotencyKey: 'p-1' });
    confirm(fx, privateVerified.id);
    const privateA = claim(fx, { statement: 'Private A.', privacy: 'founder_only', idempotencyKey: 'p-2' });
    claim(fx, { statement: 'Private B, disputing A.', privacy: 'founder_only', contradicts: [privateA.id], requestedBy: 'analyst', idempotencyKey: 'p-3' });

    const gated = fx.ops.truthSummary({ includeFounderOnly: true });
    expect(gated.total).toBe(4);
    expect(gated.byState).toEqual({ claimed: 3, observed: 0, verified: 1, accepted: 0 });
    expect(gated.unresolvedContradictions).toBe(1);
    expect(gated.contradictions).toHaveLength(1);
    expect(gated.awaitingAcceptance).toBe(1);

    const artifact = fx.ops.truthSummary({ includeFounderOnly: false });
    expect(artifact.total).toBe(4);
    expect(artifact.withheldFounderOnly).toBe(3);
    expect(artifact.records.map((r) => r.statement)).toEqual(['Public claim.']);
    // Counts over the carried set only: they sum to total − withheldFounderOnly.
    expect(artifact.byState).toEqual({ claimed: 1, observed: 0, verified: 0, accepted: 0 });
    expect(Object.values(artifact.byState).reduce((a, b) => a + b, 0)).toBe(artifact.total - artifact.withheldFounderOnly);
    // The private dispute is an internal dispute — exactly what founder_only protects.
    expect(artifact.unresolvedContradictions).toBe(0);
    expect(artifact.contradictions).toEqual([]);
    expect(artifact.awaitingAcceptance).toBe(0);
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

  it('Founder Office counts verified-awaiting-acceptance over ALL records, not only the newest TRUTH_SNAPSHOT_LIMIT the artifact carries', () => {
    // Review round 2: the count was taken over the bounded `records` while the
    // sibling `Founder-accepted` metric used `byState` over every record — past
    // twenty records it UNDERSTATED how much verified truth waits at the gate.
    const fx = truthFixture();
    const n = TRUTH_SNAPSHOT_LIMIT + 1;
    for (let i = 0; i < n; i += 1) {
      const record = claim(fx, { statement: `Verified fact ${i}.`, idempotencyKey: `awaiting-${i}` });
      confirm(fx, record.id);
    }
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    const truth = state.truth!.data;
    expect(truth.records).toHaveLength(TRUTH_SNAPSHOT_LIMIT);
    expect(truth.byState.verified).toBe(n);
    expect(truth.awaitingAcceptance).toBe(n);
    const founder = room(state, 'founder-office');
    expect(founder.metrics.find((m) => m.label === 'Verified, awaiting acceptance')!.value).toBe(n);
    expect(founder.liveness).toBe('attention');
  });

  it('a room with no truth rows and no other state stays dark — zero is zero', () => {
    const fx = truthFixture();
    const state = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(state.truth!.data.total).toBe(0);
    expect(room(state, 'company-memory').liveness).toBe('dark');
    expect(room(state, 'company-memory').metrics.find((m) => m.label === 'Truth records')!.value).toBe(0);
  });
});
