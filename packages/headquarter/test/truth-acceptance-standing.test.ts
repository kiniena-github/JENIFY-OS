/**
 * Phase 7 correction — the CURRENT STANDING of a Founder acceptance.
 *
 * Verification and acceptance are append-only, and a later refutation is
 * deliberately preserved beside the acceptance it undermines. Until this
 * correction `deriveTruthRecord` projected `state: 'accepted'` from the mere
 * existence of an acceptance row, so a record whose verification basis was
 * later refuted, contested or superseded kept presenting as CURRENT accepted
 * truth. These suites pin the rule that replaces it:
 *
 *   an acceptance STANDS only while every precondition it required still
 *   holds — verification `confirmed` (≥1 confirmed, 0 refuted), lifecycle
 *   `current`, no unresolved contradiction — and `state` is `accepted` only
 *   while it stands; otherwise the record derives exactly what it would
 *   derive without the acceptance (`verified` or its born state), the
 *   acceptance row stays fully readable in `acceptances`, and the categorical
 *   `acceptanceStanding` names why.
 *
 * And the two things the correction must NOT do: erase or rewrite any row,
 * or lower the authority needed to displace a record that was ever
 * verified or ever accepted.
 */

import { describe, expect, it } from 'vitest';
import { hydrateRooms } from '../src/client/hydrate.js';
import { liveSnapshotFromOperations, type HqSnapshot } from '../src/live/snapshot.js';
import type { ClientSession } from '../src/client/contracts.js';
import {
  deriveTruthRecord,
  entityCurrentState,
  establishedTruthTier,
  type TruthAcceptanceRow,
  type TruthGraph,
  type TruthRecordRow,
  type TruthVerificationRow,
} from '../src/application/truth-command.js';
import { expectOk } from './application.fixture.js';
import { claim, confirm, count, truthFixture, type TruthFixture } from './truth.fixture.js';

const AT = '2026-09-06T12:00:00.000Z';
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

/** The Founder accepts over the record's CURRENT digest — the canonical path, nothing bypassed. */
function accept(fx: TruthFixture, truthId: string, requestedBy = 'founder') {
  const digest = fx.ops.getTruthRecord(truthId)!.acceptanceDigest;
  expect(digest, 'the record must be acceptable before the Founder can accept it').not.toBeNull();
  return expectOk(fx.ops.acceptTruth({ truthId, expectedDigest: digest!, requestedBy }));
}

function acceptanceRow(fx: TruthFixture, truthId: string): Record<string, unknown> {
  return fx.db.prepare(`SELECT * FROM hq_truth_acceptances WHERE truth_id = ?`).get(truthId) as Record<string, unknown>;
}

/** An accepted record: claude claims, codex confirms, the Founder accepts. */
function acceptedRecord(fx: TruthFixture) {
  const record = claim(fx);
  const verification = confirm(fx, record.id).verification;
  const accepted = accept(fx, record.id);
  expect(accepted.record.state).toBe('accepted');
  expect(accepted.record.acceptanceStanding).toBe('standing');
  return { record, verification, acceptance: accepted.acceptance, rowAtAcceptance: acceptanceRow(fx, record.id) };
}

describe('a Founder acceptance stands only while its basis stands — and history is never erased', () => {
  it('accepted → a later refuting verification: the record falls back to its born state, the acceptance stays fully readable, nothing is acceptable', () => {
    const fx = truthFixture();
    const { record, verification, acceptance, rowAtAcceptance } = acceptedRecord(fx);
    const evidenceBefore = fx.ops.queue.evidence.list();

    confirm(fx, record.id, {
      verdict: 'refuted',
      evidenceRefs: [fx.evidenceId2],
      limitations: 'The rerun shows a failing job; the earlier confirmation read a stale log.',
    });

    const view = fx.ops.getTruthRecord(record.id)!;
    expect(view.verification).toBe('contested');
    expect(view.state).toBe('claimed');
    expect(view.acceptanceStanding).toBe('verification_refuted');
    expect(view.lifecycle).toBe('current');
    expect(view.contested).toBe(false);
    expect(view.acceptanceDigest).toBeNull();
    // The immutable acceptance event: who, when, over which digest, on which verifications — all still readable.
    expect(view.acceptances).toHaveLength(1);
    expect(view.acceptances[0]).toEqual({
      id: acceptance.id,
      truthId: record.id,
      acceptedBy: 'founder',
      at: acceptance.at,
      digest: acceptance.digest,
      verificationIds: [verification.id],
      note: null,
    });
    expect(acceptanceRow(fx, record.id)).toEqual(rowAtAcceptance);
    expect(count(fx, 'hq_truth_acceptances')).toBe(1);
    expect(count(fx, 'hq_truth_verifications')).toBe(2);
    // The evidence chain only grew, and still carries the acceptance.
    const evidenceAfter = fx.ops.queue.evidence.list();
    expect(evidenceAfter.slice(0, evidenceBefore.length)).toEqual(evidenceBefore);
    expect(evidenceAfter.some((e) => e.kind === 'truth_accepted' && e.payload.truthId === record.id)).toBe(true);
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
    // Every read surface agrees: the list filter, the entity headline.
    expect(fx.ops.listTruth({ state: 'accepted' })).toEqual([]);
    expect(fx.ops.listTruth({ state: 'claimed' }).map((v) => v.id)).toEqual([record.id]);
    expect(expectOk(fx.ops.getEntityTruth('task', fx.taskId)).currentState).toBe('claimed');
  });

  it('accepted → later confirmed AND refuted (summary contested): the same fall-back; the extra confirmation never launders the refutation', () => {
    const fx = truthFixture();
    const { record, verification } = acceptedRecord(fx);
    confirm(fx, record.id, { requestedBy: 'auditor', method: 'reviewed', limitations: 'Reviewed the log excerpt only.' });
    confirm(fx, record.id, { verdict: 'refuted', evidenceRefs: [fx.evidenceId2], limitations: 'The rerun shows a failing job.' });

    const view = fx.ops.getTruthRecord(record.id)!;
    expect(view.verifications.map((v) => v.verdict)).toEqual(['confirmed', 'confirmed', 'refuted']);
    expect(view.verification).toBe('contested');
    expect(view.state).toBe('claimed');
    expect(view.acceptanceStanding).toBe('verification_refuted');
    expect(view.acceptanceDigest).toBeNull();
    // The acceptance still names exactly the basis the Founder accepted — not the later confirmation.
    expect(view.acceptances[0]!.verificationIds).toEqual([verification.id]);
    expect(expectOk(fx.ops.getEntityTruth('task', fx.taskId)).currentState).toBe('claimed');
  });

  it('accepted → a later unresolved contradiction: the acceptance is contested (state verified, contested); an explicit resolution in its favour restores it, because the basis never moved', () => {
    const fx = truthFixture();
    const { record, acceptance } = acceptedRecord(fx);
    const rival = claim(fx, {
      statement: 'CI is red on the release branch.',
      contradicts: [record.id],
      requestedBy: 'analyst',
      evidenceRefs: [fx.evidenceId2],
    });

    const contested = fx.ops.getTruthRecord(record.id)!;
    expect(contested.state).toBe('verified');
    expect(contested.contested).toBe(true);
    expect(contested.acceptanceStanding).toBe('contested');
    expect(contested.acceptanceDigest).toBeNull();
    expect(contested.acceptances).toHaveLength(1);
    expect(contested.verification).toBe('confirmed');
    // The headline never launders a contested record, whatever it once was.
    expect(expectOk(fx.ops.getEntityTruth('task', fx.taskId)).currentState).toBe('claimed');
    const snapshot = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true }).truth!.data;
    expect(snapshot.byState).toEqual({ claimed: 1, observed: 0, verified: 1, accepted: 0 });
    expect(snapshot.awaitingAcceptance).toBe(0);
    expect(snapshot.unresolvedContradictions).toBe(1);

    // The dispute resolves EXPLICITLY in this record's favour: the rival is refuted.
    confirm(fx, rival.id, { verdict: 'refuted', limitations: 'The evidence shows CI green.' });
    const restored = fx.ops.getTruthRecord(record.id)!;
    expect(restored.contested).toBe(false);
    expect(restored.state).toBe('accepted');
    expect(restored.acceptanceStanding).toBe('standing');
    expect(restored.acceptances[0]!.id).toBe(acceptance.id);
    // Restored by derivation over the same rows — nothing was written to restore it.
    expect(count(fx, 'hq_truth_acceptances')).toBe(1);
    expect(expectOk(fx.ops.getEntityTruth('task', fx.taskId)).currentState).toBe('accepted');
  });

  it('accepted → superseded through the Founder gate: the predecessor keeps its verification but no longer stands as accepted; the successor starts over as a claim', () => {
    const fx = truthFixture();
    const { record, rowAtAcceptance } = acceptedRecord(fx);
    const successor = claim(fx, { statement: 'CI is green after the rerun.', supersedes: record.id, requestedBy: 'founder' });

    const old = fx.ops.getTruthRecord(record.id)!;
    expect(old.lifecycle).toBe('superseded');
    expect(old.supersededBy).toBe(successor.id);
    expect(old.state).toBe('verified');
    expect(old.acceptanceStanding).toBe('superseded');
    expect(old.acceptanceDigest).toBeNull();
    expect(old.verifications).toHaveLength(1);
    expect(old.acceptances).toHaveLength(1);
    expect(acceptanceRow(fx, record.id)).toEqual(rowAtAcceptance);
    expect(successor.state).toBe('claimed');
    expect(successor.acceptanceStanding).toBe('none');

    const entity = expectOk(fx.ops.getEntityTruth('task', fx.taskId));
    expect(entity.history.map((v) => v.id)).toEqual([record.id, successor.id]);
    expect(entity.current.map((v) => v.id)).toEqual([successor.id]);
    expect(entity.currentState).toBe('claimed');
    const snapshot = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true }).truth!.data;
    expect(snapshot.byState).toEqual({ claimed: 1, observed: 0, verified: 1, accepted: 0 });
    expect(snapshot.awaitingAcceptance).toBe(0);
  });
});

describe('the pure derivation: precedence and the never-accepted case', () => {
  function record(id: string, over: Partial<TruthRecordRow> = {}): TruthRecordRow {
    return {
      seq: 1,
      id,
      entityKind: 'task',
      entityId: 'task-1',
      statement: `statement ${id}`,
      bornState: 'observed',
      recordedBy: 'claude',
      recordedAt: AT,
      evidenceRefs: ['evidence-1'],
      privacy: 'internal',
      supersedes: null,
      ...over,
    };
  }
  function verification(id: string, truthId: string, verdict: TruthVerificationRow['verdict']): TruthVerificationRow {
    return { seq: 1, id, truthId, verifiedBy: 'codex', at: AT, method: 'reviewed', verdict, evidenceRefs: ['evidence-1'], limitations: 'none known' };
  }
  function acceptance(id: string, truthId: string, verificationIds: string[]): TruthAcceptanceRow {
    return { seq: 1, id, truthId, acceptedBy: 'founder', at: AT, digest: `truth-accept:${id}`, verificationIds, note: null };
  }

  it('names the first broken precondition — verification_refuted before superseded before contested — and a contest is by construction never simultaneous with either', () => {
    const graph: TruthGraph = {
      records: [
        record('A'),
        record('A2', { supersedes: 'A' }),
        record('B'),
        record('B2', { supersedes: 'B' }),
        record('C'),
        record('D', { recordedBy: 'analyst' }),
        record('E'),
      ],
      relations: [
        { seq: 1, id: 'r1', fromId: 'D', kind: 'contradicts', toKind: 'truth', toId: 'C', recordedBy: 'analyst', recordedAt: AT },
      ],
      verifications: [
        verification('vA1', 'A', 'confirmed'),
        verification('vA2', 'A', 'refuted'),
        verification('vB1', 'B', 'confirmed'),
        verification('vC1', 'C', 'confirmed'),
        verification('vE1', 'E', 'confirmed'),
      ],
      acceptances: [acceptance('aA', 'A', ['vA1']), acceptance('aB', 'B', ['vB1']), acceptance('aC', 'C', ['vC1'])],
    };
    const derive = (id: string) => deriveTruthRecord(graph.records.find((r) => r.id === id)!, graph, 'not_evaluated');
    // A: refuted AND superseded — the basis itself is broken, so that is what is named.
    expect(derive('A')).toMatchObject({ state: 'observed', acceptanceStanding: 'verification_refuted', lifecycle: 'superseded', verification: 'contested' });
    // B: verification intact, superseded.
    expect(derive('B')).toMatchObject({ state: 'verified', acceptanceStanding: 'superseded', lifecycle: 'superseded' });
    // C: verification intact, current, an unresolved contradiction stands against it.
    expect(derive('C')).toMatchObject({ state: 'verified', acceptanceStanding: 'contested', contested: true, lifecycle: 'current' });
    // D contradicts C and is itself contested; never accepted → none.
    expect(derive('D')).toMatchObject({ state: 'observed', acceptanceStanding: 'none', contested: true });
    // E: verified, never accepted — acceptable, standing none.
    const e = derive('E');
    expect(e.acceptanceStanding).toBe('none');
    expect(e.state).toBe('verified');
    expect(e.acceptanceDigest).not.toBeNull();
    // A superseded or refuted record is `out` of any contradiction, so `contested` can only be
    // reached with the verification intact and the record current (judgeContradiction).
    for (const id of ['A', 'B']) expect(derive(id).contested).toBe(false);
    // The headline over the current records: C is contested → its born state; D likewise; E verified.
    expect(entityCurrentState([derive('C'), derive('D'), derive('E')])).toBe('verified');
    expect(entityCurrentState([derive('C'), derive('D')])).toBe('observed');
  });

  it('the established tier the supersession gate reads is HISTORY-based: ever accepted, else ever confirmed, else nothing — a later refutation lowers the state but never the tier', () => {
    const graph: TruthGraph = {
      records: [record('A'), record('B'), record('C'), record('D')],
      relations: [],
      verifications: [
        verification('vA1', 'A', 'confirmed'),
        verification('vA2', 'A', 'refuted'),
        verification('vB1', 'B', 'confirmed'),
        verification('vB2', 'B', 'refuted'),
        verification('vC1', 'C', 'refuted'),
        verification('vC2', 'C', 'inconclusive'),
      ],
      acceptances: [acceptance('aA', 'A', ['vA1'])],
    };
    const row = (id: string) => graph.records.find((r) => r.id === id)!;
    expect(deriveTruthRecord(row('A'), graph, 'not_evaluated').state).toBe('observed');
    expect(establishedTruthTier(row('A'), graph)).toBe('accepted');
    expect(deriveTruthRecord(row('B'), graph, 'not_evaluated').state).toBe('observed');
    expect(establishedTruthTier(row('B'), graph)).toBe('verified');
    expect(establishedTruthTier(row('C'), graph)).toBeNull();
    expect(establishedTruthTier(row('D'), graph)).toBeNull();
  });
});

describe('authority is never lowered by degradation', () => {
  it('superseding a record that was EVER accepted takes the Founder gate even after a later refutation lowered its state — naive degradation would have opened this to any claimant', () => {
    const fx = truthFixture();
    const { record } = acceptedRecord(fx);
    confirm(fx, record.id, { verdict: 'refuted', evidenceRefs: [fx.evidenceId2], limitations: 'The rerun shows a failing job.' });
    expect(fx.ops.getTruthRecord(record.id)!.state).toBe('claimed');

    const byAnalyst = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'CI is red; the earlier record is withdrawn.',
      supersedes: record.id,
      requestedBy: 'analyst',
    });
    expect(byAnalyst.ok).toBe(false);
    if (!byAnalyst.ok) expect(byAnalyst.error.code).toBe('not_permitted');
    const byWorker = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'CI is red; the earlier record is withdrawn.',
      supersedes: record.id,
      requestedBy: 'claude',
    });
    expect(byWorker.ok).toBe(false);
    if (!byWorker.ok) expect(byWorker.error.code).toBe('not_permitted');
    expect(count(fx, 'hq_truth_records')).toBe(1);
    expect(fx.ops.getTruthRecord(record.id)!.lifecycle).toBe('current');
    // The Founder may.
    const byFounder = claim(fx, { statement: 'CI is red; the earlier record is withdrawn.', supersedes: record.id, requestedBy: 'founder' });
    expect(fx.ops.getTruthRecord(record.id)!.supersededBy).toBe(byFounder.id);
  });

  it('superseding a record that was EVER verified takes the Founder gate even after a later refutation contested it; a record only ever refuted established nothing and needs no gate', () => {
    const fx = truthFixture();
    const onceVerified = claim(fx, { statement: 'Median load 2.4s.' });
    confirm(fx, onceVerified.id);
    confirm(fx, onceVerified.id, { verdict: 'refuted', evidenceRefs: [fx.evidenceId2], limitations: 'A second run measured 3.1s.' });
    expect(fx.ops.getTruthRecord(onceVerified.id)).toMatchObject({ state: 'claimed', verification: 'contested' });
    const byAnalyst = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'Median load 3.1s.',
      supersedes: onceVerified.id,
      requestedBy: 'analyst',
    });
    expect(byAnalyst.ok).toBe(false);
    if (!byAnalyst.ok) expect(byAnalyst.error.code).toBe('not_permitted');
    expect(fx.ops.getTruthRecord(onceVerified.id)!.lifecycle).toBe('current');
    claim(fx, { statement: 'Median load 3.1s.', supersedes: onceVerified.id, requestedBy: 'founder' });
    expect(fx.ops.getTruthRecord(onceVerified.id)!.lifecycle).toBe('superseded');

    // Never confirmed, only refuted: no truth was established, so the ordinary claimant may supersede.
    const neverVerified = claim(fx, { statement: 'Lint is green.', idempotencyKey: 'never-verified' });
    confirm(fx, neverVerified.id, { verdict: 'refuted', limitations: 'Lint reports two errors.' });
    const replaced = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'Lint reports two errors.',
      supersedes: neverVerified.id,
      requestedBy: 'analyst',
    });
    expect(replaced.ok).toBe(true);
  });
});

describe('re-acceptance of a degraded record goes through the ordinary ladder — never a dedupe shortcut', () => {
  it('a contested acceptance: the Founder echoing the old digest is refused truth_contested, not answered "already accepted"', () => {
    const fx = truthFixture();
    const { record, acceptance } = acceptedRecord(fx);
    claim(fx, { statement: 'CI is red.', contradicts: [record.id], requestedBy: 'analyst', evidenceRefs: [fx.evidenceId2] });
    const again = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: acceptance.digest, requestedBy: 'founder' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('truth_contested');
    // Another approval-authority principal fares no better.
    const byCoo = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: acceptance.digest, requestedBy: 'coo' });
    expect(byCoo.ok).toBe(false);
    if (!byCoo.ok) expect(byCoo.error.code).toBe('truth_contested');
    expect(count(fx, 'hq_truth_acceptances')).toBe(1);
  });

  it('a refuted basis: refused truth_not_verified with the standing named; a superseded record: refused truth_conflict', () => {
    const fx = truthFixture();
    const refuted = acceptedRecord(fx);
    confirm(fx, refuted.record.id, { verdict: 'refuted', evidenceRefs: [fx.evidenceId2], limitations: 'The rerun shows a failing job.' });
    const again = fx.ops.acceptTruth({ truthId: refuted.record.id, expectedDigest: refuted.acceptance.digest, requestedBy: 'founder' });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('truth_not_verified');
      expect(again.error.details).toMatchObject({ state: 'claimed', verification: 'contested', acceptanceStanding: 'verification_refuted' });
    }

    const superseded = claim(fx, { statement: 'Lint is green.', idempotencyKey: 'to-supersede' });
    confirm(fx, superseded.id);
    const acceptedLint = accept(fx, superseded.id);
    claim(fx, { statement: 'Lint is green after the fix.', supersedes: superseded.id, requestedBy: 'founder' });
    const afterSupersession = fx.ops.acceptTruth({ truthId: superseded.id, expectedDigest: acceptedLint.acceptance.digest, requestedBy: 'founder' });
    expect(afterSupersession.ok).toBe(false);
    if (!afterSupersession.ok) expect(afterSupersession.error.code).toBe('truth_conflict');
    expect(count(fx, 'hq_truth_acceptances')).toBe(2);
  });

  it('a standing acceptance still deduplicates for its acceptor and conflicts for another — including after a contest resolved in its favour', () => {
    const fx = truthFixture();
    const { record, acceptance } = acceptedRecord(fx);
    const rival = claim(fx, { statement: 'CI is red.', contradicts: [record.id], requestedBy: 'analyst', evidenceRefs: [fx.evidenceId2] });
    confirm(fx, rival.id, { verdict: 'refuted', limitations: 'The evidence shows CI green.' });
    expect(fx.ops.getTruthRecord(record.id)!.acceptanceStanding).toBe('standing');
    const same = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: acceptance.digest, requestedBy: 'founder' });
    expect(same.ok && same.data.deduplicated).toBe(true);
    const other = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: acceptance.digest, requestedBy: 'coo' });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe('truth_conflict');
    expect(count(fx, 'hq_truth_acceptances')).toBe(1);
  });
});

describe('snapshot counts, the rooms and the entity headline agree with the standing', () => {
  it('byState counts the CURRENT standing; awaitingAcceptance never counts a degraded acceptance; Founder Office and Company Memory agree', () => {
    const fx = truthFixture();
    const { record } = acceptedRecord(fx);
    const before = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(before.truth!.data.byState).toEqual({ claimed: 0, observed: 0, verified: 0, accepted: 1 });
    expect(room(before, 'founder-office').metrics.find((m) => m.label === 'Founder-accepted')!.value).toBe(1);

    confirm(fx, record.id, { verdict: 'refuted', evidenceRefs: [fx.evidenceId2], limitations: 'The rerun shows a failing job.' });
    const after = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    const truth = after.truth!.data;
    expect(truth.total).toBe(1);
    expect(truth.byState).toEqual({ claimed: 1, observed: 0, verified: 0, accepted: 0 });
    expect(truth.awaitingAcceptance).toBe(0);
    expect(truth.records[0]!.acceptanceStanding).toBe('verification_refuted');
    expect(truth.records[0]!.acceptances).toHaveLength(1);
    const founder = room(after, 'founder-office');
    expect(founder.metrics.find((m) => m.label === 'Founder-accepted')!.value).toBe(0);
    expect(founder.metrics.find((m) => m.label === 'Verified, awaiting acceptance')!.value).toBe(0);
    expect(room(after, 'company-memory').metrics.find((m) => m.label === 'Accepted')!.value).toBe(0);

    // A fresh, independently verified record on the same entity is what waits at the gate now.
    const fresh = claim(fx, { statement: 'CI is green after the fix.', idempotencyKey: 'fresh' });
    confirm(fx, fresh.id);
    const next = liveSnapshotFromOperations(fx.ops, { now: AT, includeFounderOnlyMemory: true });
    expect(next.truth!.data.byState).toEqual({ claimed: 1, observed: 0, verified: 1, accepted: 0 });
    expect(next.truth!.data.awaitingAcceptance).toBe(1);
    expect(expectOk(fx.ops.getEntityTruth('task', fx.taskId)).currentState).toBe('verified');
  });
});
