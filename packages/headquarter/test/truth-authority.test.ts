/**
 * Phase 7 — the truth state machine's authority floor.
 *
 * What this suite pins: a record is born claimed/observed and can never
 * assert or reach a higher state by itself; its author can never verify it;
 * an observation needs real evidence and still cannot verify itself;
 * `verified` is derived only from an independent actor holding real
 * verification authority; `accepted` exists only behind the canonical
 * Founder gate (approval authority, independence, digest binding), and a
 * contested or unverified record is refused. Every refusal writes nothing.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { TRUTH_RECORD_CAPABILITY, TRUTH_VERIFY_CAPABILITY } from '../src/application/truth-command.js';
import { claim, confirm, count, truthFixture } from './truth.fixture.js';

describe('a claim can never upgrade itself', () => {
  it('is born claimed; asserting verified/accepted at birth is refused, holder of every grant or not', () => {
    const fx = truthFixture();
    for (const bornState of ['verified', 'accepted'] as const) {
      const result = fx.ops.recordTruth({
        entityKind: 'task',
        entityId: fx.taskId,
        statement: 'CI is green.',
        bornState: bornState as unknown as 'claimed',
        evidenceRefs: [fx.evidenceId],
        requestedBy: 'founder',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_input');
    }
    expect(count(fx, 'hq_truth_records')).toBe(0);
    const record = claim(fx, { requestedBy: 'founder' });
    expect(record.state).toBe('claimed');
    expect(record.bornState).toBe('claimed');
    expect(record.acceptanceDigest).toBeNull();
  });

  it('the author cannot verify its own claim, even holding hq.truth_verify', () => {
    const fx = truthFixture();
    const record = claim(fx, { requestedBy: 'founder' });
    const self = fx.ops.verifyTruth({
      truthId: record.id,
      method: 'inspected_evidence',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'none known',
      requestedBy: 'founder',
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe('not_permitted');
    expect(count(fx, 'hq_truth_verifications')).toBe(0);
    expect(fx.ops.getTruthRecord(record.id)!.state).toBe('claimed');
  });

  it('a worker claim cannot be verified by that worker; the independent reviewer can', () => {
    const fx = truthFixture();
    const record = claim(fx);
    // claude does not even hold hq.truth_verify — refused on the grant.
    const noGrant = fx.ops.verifyTruth({
      truthId: record.id,
      method: 'reviewed',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'none known',
      requestedBy: 'claude',
    });
    expect(noGrant.ok).toBe(false);
    if (!noGrant.ok) expect(noGrant.error.code).toBe('not_permitted');
    const verified = confirm(fx, record.id);
    expect(verified.record.state).toBe('verified');
    expect(verified.verification.verifiedBy).toBe('codex');
    expect(verified.verification.limitations).toContain('did not rerun CI');
    expect(verified.record.acceptanceDigest).not.toBeNull();
  });
});

describe('an observation cannot verify itself', () => {
  it('requires at least one existing evidence ref, and its author still cannot verify it', () => {
    const fx = truthFixture();
    const bare = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'The task row exists.',
      bornState: 'observed',
      requestedBy: 'founder',
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.message).toContain('at least one existing evidence entry');
    const observed = claim(fx, { bornState: 'observed', requestedBy: 'founder' });
    expect(observed.state).toBe('observed');
    const self = fx.ops.verifyTruth({
      truthId: observed.id,
      method: 'inspected_evidence',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'none known',
      requestedBy: 'founder',
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe('not_permitted');
    expect(fx.ops.getTruthRecord(observed.id)!.state).toBe('observed');
  });

  it('observed → verified needs a real verification act under real verification authority', () => {
    const fx = truthFixture({ registerVerify: false });
    const observed = claim(fx, { bornState: 'observed' });
    const noCapability = fx.ops.verifyTruth({
      truthId: observed.id,
      method: 'inspected_evidence',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'none known',
      requestedBy: 'codex',
    });
    expect(noCapability.ok).toBe(false);
    if (!noCapability.ok) expect(noCapability.error.code).toBe('unknown_capability');
    for (const [requestedBy, code] of [
      ['system', 'not_permitted'],
      ['nobody', 'unknown_principal'],
      ['analyst', 'not_permitted'],
    ] as const) {
      const result = fx.ops.verifyTruth({
        truthId: observed.id,
        method: 'inspected_evidence',
        verdict: 'confirmed',
        evidenceRefs: [fx.evidenceId],
        limitations: 'none known',
        requestedBy,
      });
      expect(result.ok, requestedBy).toBe(false);
      if (!result.ok) expect(result.error.code, requestedBy).toBe(code);
    }
    expect(count(fx, 'hq_truth_verifications')).toBe(0);
  });

  it('a verification must state method, verdict, evidence and limitations — vocabulary only', () => {
    const fx = truthFixture();
    const record = claim(fx);
    const base = {
      truthId: record.id,
      method: 'inspected_evidence' as const,
      verdict: 'confirmed' as const,
      evidenceRefs: [fx.evidenceId],
      limitations: 'none known',
      requestedBy: 'codex',
    };
    for (const over of [
      { method: 'vibes' },
      { verdict: 'probably' },
      { evidenceRefs: [] },
      { limitations: '' },
    ]) {
      const result = fx.ops.verifyTruth({ ...base, ...(over as object) } as typeof base);
      expect(result.ok, JSON.stringify(over)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_input');
    }
    expect(count(fx, 'hq_truth_verifications')).toBe(0);
  });
});

describe('verified → accepted only through the canonical Founder gate', () => {
  function verifiedRecord(fx: ReturnType<typeof truthFixture>) {
    const record = claim(fx);
    return confirm(fx, record.id).record;
  }

  it('refuses workers, system, unknown ids and a human without approval authority', () => {
    const fx = truthFixture();
    const record = verifiedRecord(fx);
    for (const [requestedBy, code] of [
      ['claude', 'not_permitted'],
      ['codex', 'not_permitted'],
      ['system', 'not_permitted'],
      ['nobody', 'not_permitted'],
      ['analyst', 'not_permitted'],
      ['former-cto', 'not_permitted'],
    ] as const) {
      const result = fx.ops.acceptTruth({
        truthId: record.id,
        expectedDigest: record.acceptanceDigest!,
        requestedBy,
      });
      expect(result.ok, requestedBy).toBe(false);
      if (!result.ok) expect(result.error.code, requestedBy).toBe(code);
    }
    expect(count(fx, 'hq_truth_acceptances')).toBe(0);
    expect(fx.ops.getTruthRecord(record.id)!.state).toBe('verified');
  });

  it('refuses a claimed or observed record outright — nothing here verifies it', () => {
    const fx = truthFixture();
    const record = claim(fx);
    const result = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: 'anything', requestedBy: 'founder' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('truth_not_verified');
    expect(count(fx, 'hq_truth_acceptances')).toBe(0);
  });

  it('binds acceptance to the exact verification basis — a moved basis is refused', () => {
    const fx = truthFixture();
    const record = verifiedRecord(fx);
    const stale = record.acceptanceDigest!;
    // The basis moves: a second confirming verification arrives.
    confirm(fx, record.id, { requestedBy: 'auditor', method: 'reviewed' });
    const moved = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: stale, requestedBy: 'founder' });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe('action_digest_mismatch');
    expect(fx.ops.queue.evidence.list().some((e) => e.kind === 'truth_acceptance_refused_basis_changed')).toBe(true);
    const missing = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: '', requestedBy: 'founder' });
    expect(missing.ok).toBe(false);
    expect(count(fx, 'hq_truth_acceptances')).toBe(0);
    // The current digest accepts.
    const current = fx.ops.getTruthRecord(record.id)!.acceptanceDigest!;
    const accepted = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: current, requestedBy: 'founder' });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.data.record.state).toBe('accepted');
      expect(accepted.data.acceptance.verificationIds).toHaveLength(2);
      expect(accepted.data.acceptance.digest).toBe(current);
    }
  });

  it('the acceptor is neither the author nor a confirming verifier', () => {
    const fx = truthFixture();
    // Founder claims, codex verifies → founder cannot accept its own claim.
    const own = confirm(fx, claim(fx, { requestedBy: 'founder' }).id).record;
    const asAuthor = fx.ops.acceptTruth({ truthId: own.id, expectedDigest: own.acceptanceDigest!, requestedBy: 'founder' });
    expect(asAuthor.ok).toBe(false);
    if (!asAuthor.ok) expect(asAuthor.error.code).toBe('not_permitted');
    // claude claims, founder verifies → founder cannot accept what it verified; the coo can.
    const verifiedByFounder = confirm(fx, claim(fx, { statement: 'Lint is green.' }).id, { requestedBy: 'founder' }).record;
    const asVerifier = fx.ops.acceptTruth({
      truthId: verifiedByFounder.id,
      expectedDigest: verifiedByFounder.acceptanceDigest!,
      requestedBy: 'founder',
    });
    expect(asVerifier.ok).toBe(false);
    if (!asVerifier.ok) expect(asVerifier.error.code).toBe('not_permitted');
    const byCoo = fx.ops.acceptTruth({
      truthId: verifiedByFounder.id,
      expectedDigest: verifiedByFounder.acceptanceDigest!,
      requestedBy: 'coo',
    });
    expect(byCoo.ok).toBe(true);
    // Repeating the same acceptance dedupes; a different acceptor conflicts.
    const again = fx.ops.acceptTruth({
      truthId: verifiedByFounder.id,
      expectedDigest: verifiedByFounder.acceptanceDigest!,
      requestedBy: 'coo',
    });
    expect(again.ok && again.data.deduplicated).toBe(true);
    const second = fx.ops.acceptTruth({
      truthId: verifiedByFounder.id,
      expectedDigest: verifiedByFounder.acceptanceDigest!,
      requestedBy: 'founder',
    });
    expect(second.ok).toBe(false);
    expect(count(fx, 'hq_truth_acceptances')).toBe(1);
  });

  it('a refuted record is not verified; a contested (confirmed AND refuted) record stays at its born state', () => {
    const fx = truthFixture();
    const record = claim(fx);
    confirm(fx, record.id, { verdict: 'refuted', limitations: 'CI log shows a failing job.' });
    expect(fx.ops.getTruthRecord(record.id)!.state).toBe('claimed');
    expect(fx.ops.getTruthRecord(record.id)!.verification).toBe('refuted');
    confirm(fx, record.id, { requestedBy: 'auditor' });
    const view = fx.ops.getTruthRecord(record.id)!;
    expect(view.verification).toBe('contested');
    expect(view.state).toBe('claimed');
    expect(view.acceptanceDigest).toBeNull();
    const result = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: 'x', requestedBy: 'founder' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('truth_not_verified');
  });

  it('acceptance executes nothing: no task status, approval row, claim or kill switch moves', () => {
    const fx = truthFixture();
    const record = verifiedRecord(fx);
    const taskBefore = fx.ops.queue.get(fx.taskId)!;
    const approvalsBefore = count(fx, 'hq_approvals');
    const accepted = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: record.acceptanceDigest!, requestedBy: 'founder' });
    expect(accepted.ok).toBe(true);
    expect(fx.ops.queue.get(fx.taskId)).toEqual(taskBefore);
    expect(count(fx, 'hq_approvals')).toBe(approvalsBefore);
    expect(fx.ops.killSwitchScopes()).toEqual([]);
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
  });
});

describe('identity and the two capability trios, fail closed', () => {
  it('recording refuses system, unknown ids, the ungranted, and an inactive worker', () => {
    const fx = truthFixture();
    for (const [requestedBy, code] of [
      ['system', 'not_permitted'],
      ['nobody', 'unknown_principal'],
      ['coo', 'not_permitted'],
      ['codex', 'not_permitted'],
      ['retired-bot', 'worker_not_assignable'],
    ] as const) {
      const result = fx.ops.recordTruth({
        entityKind: 'task',
        entityId: fx.taskId,
        statement: 'x',
        evidenceRefs: [fx.evidenceId],
        requestedBy,
      });
      expect(result.ok, requestedBy).toBe(false);
      if (!result.ok) expect(result.error.code, requestedBy).toBe(code);
    }
    expect(count(fx, 'hq_truth_records')).toBe(0);
  });

  it('fails closed on a missing/altered/disabled capability and never repairs', () => {
    const missing = truthFixture({ registerRecord: false });
    const noCapability = missing.ops.recordTruth({
      entityKind: 'task',
      entityId: missing.taskId,
      statement: 'x',
      requestedBy: 'founder',
    });
    expect(noCapability.ok).toBe(false);
    if (!noCapability.ok) expect(noCapability.error.code).toBe('unknown_capability');

    const fx = truthFixture();
    fx.db.prepare(`UPDATE op_capabilities SET side_effect = 1 WHERE id = ?`).run(TRUTH_RECORD_CAPABILITY.id);
    const altered = fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'x', requestedBy: 'founder' });
    expect(altered.ok).toBe(false);
    if (!altered.ok) expect(altered.error.code).toBe('not_permitted');
    fx.db.prepare(`UPDATE op_capabilities SET side_effect = 0 WHERE id = ?`).run(TRUTH_RECORD_CAPABILITY.id);
    new CapabilityRegistry(fx.db).setEnabled(TRUTH_RECORD_CAPABILITY.id, false);
    const disabled = fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'x', requestedBy: 'founder' });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe('capability_disabled');
    // The verify trio, same rules.
    new CapabilityRegistry(fx.db).setEnabled(TRUTH_RECORD_CAPABILITY.id, true);
    const record = claim(fx);
    new CapabilityRegistry(fx.db).setEnabled(TRUTH_VERIFY_CAPABILITY.id, false);
    const verifyDisabled = fx.ops.verifyTruth({
      truthId: record.id,
      method: 'reviewed',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'none known',
      requestedBy: 'codex',
    });
    expect(verifyDisabled.ok).toBe(false);
    if (!verifyDisabled.ok) expect(verifyDisabled.error.code).toBe('capability_disabled');
    expect(count(fx, 'hq_truth_verifications')).toBe(0);
  });

  it('subject existence is probed only after the gates — the ungranted get no oracle', () => {
    const fx = truthFixture();
    const ungranted = fx.ops.recordTruth({ entityKind: 'task', entityId: 'ghost', statement: 'x', requestedBy: 'coo' });
    expect(ungranted.ok).toBe(false);
    if (!ungranted.ok) expect(ungranted.error.code).toBe('not_permitted');
    const granted = fx.ops.recordTruth({ entityKind: 'task', entityId: 'ghost', statement: 'x', requestedBy: 'founder' });
    expect(granted.ok).toBe(false);
    if (!granted.ok) expect(granted.error.code).toBe('unknown_entity');
    for (const entityKind of ['mission', 'project', 'memory', 'worker', 'capability'] as const) {
      const result = fx.ops.recordTruth({ entityKind, entityId: 'ghost', statement: 'x', requestedBy: 'founder' });
      expect(result.ok, entityKind).toBe(false);
      if (!result.ok) expect(result.error.code, entityKind).toBe('unknown_entity');
    }
    expect(count(fx, 'hq_truth_records')).toBe(0);
  });

  it('dedupes an identical re-record and an identical re-verification', () => {
    const fx = truthFixture();
    const first = claim(fx);
    const again = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'CI is green on the release branch.',
      evidenceRefs: [fx.evidenceId],
      requestedBy: 'claude',
    });
    expect(again.ok && again.data.deduplicated && again.data.record.id === first.id).toBe(true);
    expect(count(fx, 'hq_truth_records')).toBe(1);
    confirm(fx, first.id);
    const verifyAgain = confirm(fx, first.id);
    expect(verifyAgain.deduplicated).toBe(true);
    expect(count(fx, 'hq_truth_verifications')).toBe(1);
  });
});
