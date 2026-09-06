/**
 * Phase 7 — the truth graph's hardening: contradictions stay visible and
 * are never settled by recency; every evidence ref must exist; the four
 * truth tables are insert-only BY ENGINE and no truth act rewrites evidence
 * or history; superseded truth stays auditable and superseding established
 * truth takes the Founder gate; memory grants no truth authority; the
 * projection is no second evidence store and decides nothing canonical;
 * and a monkey-patched public read changes no truth-authority decision.
 */

import { describe, expect, it } from 'vitest';
import { HeadquarterOperations } from '../src/application/service.js';
import { deriveTruthRecord, judgeContradiction, loadTruthGraph } from '../src/application/truth-command.js';
import { OperatorQueue } from '../src/operator/queue.js';
import { CAPS, expectOk } from './application.fixture.js';
import { claim, confirm, count, truthFixture } from './truth.fixture.js';

describe('contradictions stay visible — never newest-wins', () => {
  it('two contradicting current records both stand as contested until an explicit act', () => {
    const fx = truthFixture();
    const green = claim(fx, { statement: 'CI is green.' });
    const red = claim(fx, {
      statement: 'CI is red.',
      contradicts: [green.id],
      requestedBy: 'analyst',
      evidenceRefs: [fx.evidenceId2],
    });
    const a = fx.ops.getTruthRecord(green.id)!;
    const b = fx.ops.getTruthRecord(red.id)!;
    // Neither is the winner: both current, both contested, both at their born state.
    expect(a.lifecycle).toBe('current');
    expect(b.lifecycle).toBe('current');
    expect(a.contested).toBe(true);
    expect(b.contested).toBe(true);
    expect(a.contradictions).toEqual([{ withId: red.id, direction: 'stated_by', resolution: 'unresolved' }]);
    expect(b.contradictions).toEqual([{ withId: green.id, direction: 'stated', resolution: 'unresolved' }]);
    const entity = expectOk(fx.ops.getEntityTruth('task', fx.taskId));
    expect(entity.unresolvedContradictions).toHaveLength(1);
    expect(entity.currentState).toBe('claimed');
    expect(fx.ops.listTruthContradictions()[0]!.resolution).toBe('unresolved');
  });

  it('the newer record is not preferred even when it is verified — a contested record cannot be accepted', () => {
    const fx = truthFixture();
    const green = claim(fx, { statement: 'CI is green.' });
    const red = claim(fx, { statement: 'CI is red.', contradicts: [green.id], requestedBy: 'analyst' });
    const verified = confirm(fx, red.id).record;
    expect(verified.state).toBe('verified');
    expect(verified.contested).toBe(true);
    expect(verified.acceptanceDigest).toBeNull();
    // The entity headline does not launder the contested verification.
    expect(expectOk(fx.ops.getEntityTruth('task', fx.taskId)).currentState).toBe('claimed');
    const accept = fx.ops.acceptTruth({ truthId: red.id, expectedDigest: 'x', requestedBy: 'founder' });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.error.code).toBe('truth_contested');
  });

  it('a contradiction resolves only by an explicit refutation or supersession, and the resolution is named', () => {
    const fx = truthFixture();
    const green = claim(fx, { statement: 'CI is green.' });
    const red = claim(fx, { statement: 'CI is red.', contradicts: [green.id], requestedBy: 'analyst' });
    confirm(fx, green.id, { verdict: 'refuted', limitations: 'The evidence shows a failing job.' });
    expect(fx.ops.getTruthRecord(red.id)!.contradictions[0]!.resolution).toBe('resolved_by_refutation');
    expect(fx.ops.getTruthRecord(red.id)!.contested).toBe(false);
    // The refuted record is still there, visibly refuted — nothing was erased.
    expect(fx.ops.getTruthRecord(green.id)!.verification).toBe('refuted');
    expect(count(fx, 'hq_truth_records')).toBe(2);

    const amber = claim(fx, { statement: 'CI is amber.', contradicts: [red.id], requestedBy: 'founder' });
    expect(fx.ops.getTruthRecord(amber.id)!.contested).toBe(true);
    claim(fx, { statement: 'CI is red (rerun).', supersedes: red.id, requestedBy: 'analyst' });
    expect(fx.ops.getTruthRecord(amber.id)!.contradictions[0]!.resolution).toBe('resolved_by_supersession');
  });

  it('the judgement itself is timestamp-blind', () => {
    const standing = (superseded: boolean, refuted: boolean) => ({ superseded, refuted });
    expect(judgeContradiction(standing(false, false), standing(false, false))).toBe('unresolved');
    expect(judgeContradiction(standing(true, false), standing(false, false))).toBe('resolved_by_supersession');
    expect(judgeContradiction(standing(false, false), standing(false, true))).toBe('resolved_by_refutation');
    expect(judgeContradiction(standing(true, false), standing(false, true))).toBe('both_withdrawn');
  });
});

describe('evidence refs must exist, or the write is refused', () => {
  it('a record naming a phantom evidence id is refused with nothing written', () => {
    const fx = truthFixture();
    const result = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'x',
      evidenceRefs: [fx.evidenceId, 'not-an-evidence-id'],
      requestedBy: 'founder',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown_evidence');
      expect(result.error.details).toEqual({ missing: ['not-an-evidence-id'] });
    }
    expect(count(fx, 'hq_truth_records')).toBe(0);
    expect(count(fx, 'hq_truth_relations')).toBe(0);
  });

  it('a verification naming a phantom evidence id is refused with nothing written', () => {
    const fx = truthFixture();
    const record = claim(fx);
    const result = fx.ops.verifyTruth({
      truthId: record.id,
      method: 'inspected_evidence',
      verdict: 'confirmed',
      evidenceRefs: ['forged'],
      limitations: 'none known',
      requestedBy: 'codex',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_evidence');
    expect(count(fx, 'hq_truth_verifications')).toBe(0);
    expect(fx.ops.getTruthRecord(record.id)!.state).toBe('claimed');
  });

  it('relations must name real truth records', () => {
    const fx = truthFixture();
    for (const over of [{ supports: ['ghost'] }, { contradicts: ['ghost'] }, { derivedFrom: ['ghost'] }, { supersedes: 'ghost' }]) {
      const result = fx.ops.recordTruth({
        entityKind: 'task',
        entityId: fx.taskId,
        statement: 'x',
        requestedBy: 'founder',
        ...over,
      });
      expect(result.ok, JSON.stringify(over)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unknown_truth');
    }
    expect(count(fx, 'hq_truth_records')).toBe(0);
  });
});

describe('evidence and history cannot be rewritten via the truth projection', () => {
  it('the engine aborts UPDATE, DELETE and every REPLACE/upsert spelling on all four truth tables', () => {
    const fx = truthFixture();
    const record = claim(fx);
    confirm(fx, record.id);
    const accepted = fx.ops.acceptTruth({
      truthId: record.id,
      expectedDigest: fx.ops.getTruthRecord(record.id)!.acceptanceDigest!,
      requestedBy: 'founder',
    });
    expect(accepted.ok).toBe(true);
    const verificationId = fx.ops.getTruthRecord(record.id)!.verifications[0]!.id;
    const acceptanceId = fx.ops.getTruthRecord(record.id)!.acceptances[0]!.id;
    const relationId = (fx.db.prepare(`SELECT id FROM hq_truth_relations LIMIT 1`).get() as { id: string }).id;
    for (const [statement, param] of [
      [`UPDATE hq_truth_records SET statement = 'forged' WHERE id = ?`, record.id],
      [`UPDATE hq_truth_records SET born_state = 'accepted' WHERE id = ?`, record.id],
      [`UPDATE hq_truth_records SET recorded_by = 'attacker' WHERE id = ?`, record.id],
      [`DELETE FROM hq_truth_records WHERE id = ?`, record.id],
      [`UPDATE hq_truth_verifications SET verdict = 'refuted' WHERE id = ?`, verificationId],
      [`DELETE FROM hq_truth_verifications WHERE id = ?`, verificationId],
      [`UPDATE hq_truth_acceptances SET accepted_by = 'attacker' WHERE id = ?`, acceptanceId],
      [`DELETE FROM hq_truth_acceptances WHERE id = ?`, acceptanceId],
      [`UPDATE hq_truth_relations SET kind = 'supports' WHERE id = ?`, relationId],
      [`DELETE FROM hq_truth_relations WHERE id = ?`, relationId],
    ] as const) {
      expect(() => fx.db.prepare(statement).run(param), statement).toThrow(/append-only/);
    }
    expect(() =>
      fx.db
        .prepare(
          `INSERT OR REPLACE INTO hq_truth_records (id, entity_kind, entity_id, statement, born_state, recorded_by,
             recorded_at, evidence_refs, privacy) VALUES (?, 'task', 'x', 'forged', 'claimed', 'attacker', 'now', '[]', 'internal')`,
        )
        .run(record.id),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(
          `INSERT INTO hq_truth_acceptances (id, truth_id, accepted_by, at, digest, verification_ids)
           VALUES (?, 'x', 'attacker', 'now', 'd', '[]') ON CONFLICT (id) DO UPDATE SET accepted_by = 'attacker'`,
        )
        .run(acceptanceId),
    ).toThrow(/append-only/);
    // Refused means intact.
    const view = fx.ops.getTruthRecord(record.id)!;
    expect(view.statement).toBe('CI is green on the release branch.');
    expect(view.state).toBe('accepted');
    expect(view.acceptances[0]!.acceptedBy).toBe('founder');
  });

  it('verify and accept never touch the record row, and the op_evidence chain stays intact and append-only', () => {
    const fx = truthFixture();
    const record = claim(fx);
    const rowBefore = fx.db.prepare(`SELECT * FROM hq_truth_records WHERE id = ?`).get(record.id);
    const evidenceBefore = fx.ops.queue.evidence.list();
    confirm(fx, record.id);
    fx.ops.acceptTruth({
      truthId: record.id,
      expectedDigest: fx.ops.getTruthRecord(record.id)!.acceptanceDigest!,
      requestedBy: 'founder',
    });
    expect(fx.db.prepare(`SELECT * FROM hq_truth_records WHERE id = ?`).get(record.id)).toEqual(rowBefore);
    const evidenceAfter = fx.ops.queue.evidence.list();
    // The chain only GREW — every earlier entry is byte-identical, and it verifies.
    expect(evidenceAfter.slice(0, evidenceBefore.length)).toEqual(evidenceBefore);
    expect(evidenceAfter.slice(evidenceBefore.length).map((e) => e.kind)).toEqual(['truth_verified', 'truth_accepted']);
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
    // Truth entries REFERENCE evidence ids; they never carry an evidence body.
    const recorded = evidenceAfter.find((e) => e.kind === 'truth_recorded')!;
    expect(recorded.payload.evidenceRefs).toEqual([fx.evidenceId]);
    expect(JSON.stringify(recorded.payload)).not.toContain('"payload"');
  });

  it('no source file spells a rewrite of any truth table', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [
        /UPDATE\s+hq_truth_\w+/i,
        /DELETE\s+FROM\s+hq_truth_\w+/i,
        /INSERT\s+OR\s+\w+\s+INTO\s+hq_truth_\w+/i,
        /REPLACE\s+INTO\s+hq_truth_\w+/i,
        /hq_truth_\w+[^;]{0,200}ON\s+CONFLICT/i,
      ]) {
        expect(source, `${file} must not rewrite append-only truth history`).not.toMatch(pattern);
      }
    }
  });
});

describe('stale and superseded truth remains auditable', () => {
  it('a superseded record stays in history with its verifications; the successor starts over as a claim', () => {
    const fx = truthFixture();
    const first = claim(fx, { statement: 'Median load 2.4s.' });
    confirm(fx, first.id);
    // Superseding a VERIFIED record needs the Founder gate: the analyst is refused.
    const byAnalyst = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'Median load 1.9s.',
      supersedes: first.id,
      requestedBy: 'analyst',
    });
    expect(byAnalyst.ok).toBe(false);
    if (!byAnalyst.ok) expect(byAnalyst.error.code).toBe('not_permitted');
    const second = claim(fx, { statement: 'Median load 1.9s.', supersedes: first.id, requestedBy: 'founder' });
    expect(second.state).toBe('claimed');
    expect(second.supersedes).toBe(first.id);
    const old = fx.ops.getTruthRecord(first.id)!;
    expect(old.lifecycle).toBe('superseded');
    expect(old.supersededBy).toBe(second.id);
    expect(old.state).toBe('verified');
    expect(old.verifications).toHaveLength(1);
    const entity = expectOk(fx.ops.getEntityTruth('task', fx.taskId));
    expect(entity.history.map((v) => v.id)).toEqual([first.id, second.id]);
    expect(entity.current.map((v) => v.id)).toEqual([second.id]);
    expect(entity.currentState).toBe('claimed');
    // Nothing rewrote the predecessor row.
    expect(
      (fx.db.prepare(`SELECT statement FROM hq_truth_records WHERE id = ?`).get(first.id) as { statement: string }).statement,
    ).toBe('Median load 2.4s.');
  });

  it('a superseded record cannot be verified, accepted or superseded again — the chain forks into a contradiction instead', () => {
    const fx = truthFixture();
    const first = claim(fx);
    const second = claim(fx, { statement: 'v2', supersedes: first.id });
    const verifyOld = fx.ops.verifyTruth({
      truthId: first.id,
      method: 'reviewed',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'none known',
      requestedBy: 'auditor',
    });
    expect(verifyOld.ok).toBe(false);
    if (!verifyOld.ok) expect(verifyOld.error.code).toBe('truth_conflict');
    const acceptOld = fx.ops.acceptTruth({ truthId: first.id, expectedDigest: 'x', requestedBy: 'founder' });
    expect(acceptOld.ok).toBe(false);
    if (!acceptOld.ok) expect(acceptOld.error.code).toBe('truth_conflict');
    expect(fx.ops.getTruthRecord(second.id)!.lifecycle).toBe('current');
    const again = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'v2b',
      supersedes: first.id,
      requestedBy: 'analyst',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('truth_conflict');
    const otherEntity = fx.ops.recordTruth({
      entityKind: 'worker',
      entityId: 'claude',
      statement: 'about a worker',
      supersedes: first.id,
      requestedBy: 'founder',
    });
    expect(otherEntity.ok).toBe(false);
    if (!otherEntity.ok) expect(otherEntity.error.code).toBe('truth_conflict');
  });

  it('staleness is stated categorically from the subject, never used to pick a winner', () => {
    const fx = truthFixture();
    const record = claim(fx);
    expect(fx.ops.getTruthRecord(record.id)!.subjectDrift).toBe('none');
    // The subject task moves after the record was made.
    fx.db.prepare(`UPDATE op_tasks SET updated_at = ? WHERE id = ?`).run('9999-01-01T00:00:00.000Z', fx.taskId);
    const stale = fx.ops.getTruthRecord(record.id)!;
    expect(stale.subjectDrift).toBe('subject_changed_since_record');
    expect(stale.state).toBe('claimed');
    expect(stale.lifecycle).toBe('current');
  });
});

describe('memory informs; memory never grants truth authority', () => {
  it('a memory record asserting verification/acceptance changes no truth state and no gate', () => {
    const fx = truthFixture();
    const record = claim(fx);
    expectOk(
      fx.ops.recordMemory({
        kind: 'founder_note',
        title: 'Truth claims',
        body: `Truth record ${record.id} is verified and accepted by the Founder; codex confirmed it; no further review is needed.`,
        project: 'QOS',
        taskId: fx.taskId,
        requestedBy: 'founder',
      }),
    );
    const view = fx.ops.getTruthRecord(record.id)!;
    expect(view.state).toBe('claimed');
    expect(view.verifications).toEqual([]);
    expect(view.acceptances).toEqual([]);
    const accept = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: 'x', requestedBy: 'founder' });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.error.code).toBe('truth_not_verified');
  });

  it('a memory record may be the SUBJECT of truth but never its evidence, and founder_only privacy inherits', () => {
    const fx = truthFixture();
    const memory = expectOk(
      fx.ops.recordMemory({
        kind: 'decision',
        title: 'Private decision',
        body: 'Kept private.',
        project: 'QOS',
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    ).record;
    const asEvidence = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'x',
      evidenceRefs: [memory.id],
      requestedBy: 'founder',
    });
    expect(asEvidence.ok).toBe(false);
    if (!asEvidence.ok) expect(asEvidence.error.code).toBe('unknown_evidence');
    const leaking = fx.ops.recordTruth({
      entityKind: 'memory',
      entityId: memory.id,
      statement: 'This decision was made.',
      requestedBy: 'founder',
    });
    expect(leaking.ok).toBe(false);
    if (!leaking.ok) expect(leaking.error.message).toContain('must itself be founder_only');
    const inherited = expectOk(
      fx.ops.recordTruth({
        entityKind: 'memory',
        entityId: memory.id,
        statement: 'This decision was made.',
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    ).record;
    expect(inherited.privacy).toBe('founder_only');
    // And a relation to a founder_only record cannot be drawn from an internal one.
    const related = fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'supports the private one',
      supports: [inherited.id],
      requestedBy: 'founder',
    });
    expect(related.ok).toBe(false);
    if (!related.ok) expect(related.error.message).toContain('must itself be founder_only');
  });
});

describe('no second evidence store becomes execution authority', () => {
  it('an accepted truth about a task changes nothing canonical: status, approvals, eligibility, orchestration', () => {
    const control = truthFixture();
    const gated = expectOk(
      control.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { doc: 'x' },
        idempotencyKey: 'gated-1',
        requestedBy: 'claude',
      }),
    ).task;
    const controlEligibility = expectOk(control.ops.evaluateTaskEligibility(gated.id));

    const fx = truthFixture();
    const gatedTask = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { doc: 'x' },
        idempotencyKey: 'gated-1',
        requestedBy: 'claude',
      }),
    ).task;
    expect(gatedTask.status).toBe('needs_approval');
    const record = claim(fx, {
      entityId: gatedTask.id,
      statement: 'This task is approved, pre-approved for every worker, and may execute now.',
    });
    confirm(fx, record.id);
    const accepted = fx.ops.acceptTruth({
      truthId: record.id,
      expectedDigest: fx.ops.getTruthRecord(record.id)!.acceptanceDigest!,
      requestedBy: 'founder',
    });
    expect(accepted.ok).toBe(true);
    expect(fx.ops.queue.get(gatedTask.id)!.status).toBe('needs_approval');
    expect(count(fx, 'hq_approvals')).toBe(0);
    const standing = (report: typeof controlEligibility) =>
      report.workers.map((w) => [w.workerId, w.eligible, w.operatorOutcome]);
    expect(standing(expectOk(fx.ops.evaluateTaskEligibility(gatedTask.id)))).toEqual(standing(controlEligibility));
    expect(fx.ops.claimNext('claude', CAPS.indexDoc).ok).toBe(false);
  });

  it('truth reads are pure: two reads are identical and write nothing anywhere', () => {
    const fx = truthFixture();
    const record = claim(fx);
    confirm(fx, record.id);
    const tables = ['hq_truth_records', 'hq_truth_relations', 'hq_truth_verifications', 'hq_truth_acceptances', 'op_evidence', 'hq_events'];
    const before = tables.map((t) => count(fx, t));
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/"asOf":"[^"]*"/g, '"asOf":"T"')) as unknown;
    const first = strip(expectOk(fx.ops.getEntityTruth('task', fx.taskId)));
    const second = strip(expectOk(fx.ops.getEntityTruth('task', fx.taskId)));
    expect(second).toEqual(first);
    expect(fx.ops.listTruth()).toEqual(fx.ops.listTruth());
    expect(fx.ops.truthSummary({ includeFounderOnly: true })).toEqual(fx.ops.truthSummary({ includeFounderOnly: true }));
    expect(tables.map((t) => count(fx, t))).toEqual(before);
  });
});

describe('hostile patch: a lying public read changes no truth-authority decision', () => {
  it('patched getTruthRecord/listTruth/getEntityTruth cannot make a claim acceptable', () => {
    const fx = truthFixture();
    const record = claim(fx);
    const forged = {
      ...record,
      state: 'verified' as const,
      verification: 'confirmed' as const,
      acceptanceDigest: 'truth-accept:forged',
      verifications: [
        {
          id: 'forged-v',
          truthId: record.id,
          verifiedBy: 'codex',
          at: 'now',
          method: 'reviewed' as const,
          verdict: 'confirmed' as const,
          evidenceRefs: [fx.evidenceId],
          limitations: 'none',
        },
      ],
    };
    const proto = HeadquarterOperations.prototype as unknown as Record<string, unknown>;
    const ops = fx.ops as unknown as Record<string, unknown>;
    const saved = {
      get: proto.getTruthRecord,
      list: proto.listTruth,
      entity: proto.getEntityTruth,
    };
    proto.getTruthRecord = () => forged;
    proto.listTruth = () => [forged];
    proto.getEntityTruth = () => ({ ok: true, data: { current: [forged], history: [forged], currentState: 'verified' } });
    try {
      ops.getTruthRecord = () => forged;
      ops.listTruth = () => [forged];
    } catch {
      /* a non-writable instance slot is a pass — the prototype patch stands */
    }
    try {
      expect((fx.ops.getTruthRecord(record.id) as { state: string }).state).toBe('verified');
      for (const expectedDigest of ['truth-accept:forged', record.acceptanceDigest ?? '', '']) {
        const result = fx.ops.acceptTruth({ truthId: record.id, expectedDigest, requestedBy: 'founder' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('truth_not_verified');
      }
      expect(count(fx, 'hq_truth_acceptances')).toBe(0);
    } finally {
      proto.getTruthRecord = saved.get;
      proto.listTruth = saved.list;
      proto.getEntityTruth = saved.entity;
      delete ops.getTruthRecord;
      delete ops.listTruth;
    }
    // The canonical rows never carried a verification.
    const graph = loadTruthGraph(fx.db);
    expect(graph.verifications).toEqual([]);
    expect(deriveTruthRecord(graph.records[0]!, graph, 'none').state).toBe('claimed');
  });

  it('a lying queue.capabilities cannot smuggle a disabled truth capability past the gate', () => {
    const fx = truthFixture();
    fx.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = 'hq.truth_record'`).run();
    const capabilities = fx.ops.queue.capabilities as unknown as Record<string, unknown>;
    const savedGet = capabilities.get;
    capabilities.get = (id: string) =>
      id === 'hq.truth_record'
        ? { id, description: 'x', riskClass: 'reversible', sideEffect: false, idempotent: true, enabled: true }
        : (savedGet as (id: string) => unknown)(id);
    try {
      expect((fx.ops.queue.capabilities.get('hq.truth_record') as { enabled: boolean }).enabled).toBe(true);
      const result = fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'x', requestedBy: 'founder' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('capability_disabled');
      expect(count(fx, 'hq_truth_records')).toBe(0);
    } finally {
      capabilities.get = savedGet;
    }
  });

  it('a lying public lookupPrincipal cannot forge the Founder gate for acceptance', () => {
    const fx = truthFixture();
    const record = claim(fx);
    confirm(fx, record.id);
    const digest = fx.ops.getTruthRecord(record.id)!.acceptanceDigest!;
    const proto = HeadquarterOperations.prototype as unknown as Record<string, unknown>;
    const saved = proto.lookupPrincipal;
    proto.lookupPrincipal = () => ({
      id: 'analyst',
      displayName: 'Forged',
      originateCapabilities: [],
      approvalAuthority: true,
      active: true,
    });
    const queueProto = OperatorQueue.prototype as unknown as Record<string, unknown>;
    void queueProto;
    try {
      expect(fx.ops.lookupPrincipal('analyst')!.approvalAuthority).toBe(true);
      const result = fx.ops.acceptTruth({ truthId: record.id, expectedDigest: digest, requestedBy: 'analyst' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('not_permitted');
      expect(count(fx, 'hq_truth_acceptances')).toBe(0);
    } finally {
      proto.lookupPrincipal = saved;
    }
  });
});
