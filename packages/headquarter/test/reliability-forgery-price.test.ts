/**
 * What the `run_reconciled` witness actually costs an attacker — MEASURED, so
 * the sentence in `reliability-command.ts` cannot drift back into a barrier
 * nobody priced (Wave 5 correction round seventeen, Medium-5 and Low-1).
 *
 * ## What was open
 *
 * Round sixteen closed Critical B-2 by requiring a `reconciled` ledger row to
 * be corroborated by a standing `run_reconciled` link in the hash-chained
 * `op_evidence` log. The residual it recorded said the remaining forgery costs
 * "appending to the hash chain, which is itself guarded by the engine and by a
 * durable length commitment (`verifyEvidenceChain`). Against that writer this
 * is a real barrier."
 *
 * Neither guard participates:
 *
 *  - `op_evidence`'s triggers refuse UPDATE and DELETE, not INSERT;
 *  - the hash is public and unkeyed;
 *  - `verifyEvidenceChain` reads `null` (intact) before AND after.
 *
 * This file EXECUTES the forgery and asserts each of those three, so the price
 * in the docblock is a measurement rather than a claim. It is a
 * characterisation test of a KNOWN, DISCLOSED residual — it does not assert
 * that the forgery is refused, because it is not.
 *
 * ## What it does NOT claim
 *
 *  - it does not claim the residual is acceptable. It claims it is priced;
 *  - it says nothing about a writer who can only append to
 *    `hq_reliability_run_events` and not to `op_evidence`. That attacker IS
 *    refused, and `reliability-fold-latch.test.ts` owns that half;
 *  - the Low-1 case below is the FAIL-CLOSED direction and is deliberately not
 *    repaired: the repair would stop the fold's `default` branch downgrading an
 *    already-concluded run, which is a strictly less conservative latch.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectOk } from './application.fixture.js';
import { reliabilityFixture, type ReliabilityFixture } from './reliability.fixture.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';
import {
  INTEGRITY_ASSESSED_EVIDENCE_KIND,
  RUN_RECONCILED_EVIDENCE_KIND,
  standingIntegrityVerdict,
} from '../src/application/reliability-command.js';

/** A run on the pre-approved, idempotent, SIDE-EFFECT capability, left uncertain. */
function uncertainRun(fx: ReliabilityFixture): string {
  const opened = expectOk(
    fx.ops.openRun({
      taskId: fx.claim.taskId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      runKind: 'external_action',
      label: 'open the pull request',
    }),
  );
  const runId = opened.run.id;
  expectOk(fx.ops.startRunAttempt({ runId, workerId: fx.claim.workerId, fence: fx.claim.fence }));
  expectOk(
    fx.ops.recordRunOutcome({
      runId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      outcome: 'outcome_unknown',
    }),
  );
  const record = fx.ops.getRun(runId)!;
  expect(record.state).toBe('needs_reconciliation');
  return runId;
}

/**
 * Forge ONE `op_evidence` row by raw INSERT, chained from the current tip.
 *
 * This IS the price, written out: read the tip, recompute the documented hash
 * over public inputs, insert. No key, no privileged handle, no UPDATE.
 */
function forgeEvidenceLink(
  fx: ReliabilityFixture,
  actor: string,
  kind: string,
  payload: Record<string, unknown>,
): void {
  const tip = fx.db.prepare(`SELECT hash FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as
    | { hash: string }
    | undefined;
  const prevHash = tip?.hash ?? 'genesis';
  const id = `forged-${Math.random().toString(36).slice(2)}`;
  const at = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  const hash = createHash('sha256')
    .update([prevHash, id, at, '', actor, kind, payloadJson].join('|'))
    .digest('hex');
  fx.db
    .prepare(
      `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(id, at, actor, kind, payloadJson, prevHash, hash);
}

/** Append one raw `reconciled` row to the run ledger — the write its triggers permit. */
function rawReconciledRow(
  fx: ReliabilityFixture,
  runId: string,
  actor: string,
  detail: Record<string, unknown>,
): void {
  fx.db
    .prepare(
      `INSERT INTO hq_reliability_run_events (id, run_id, kind, actor, at, process_id, detail, attempt_key)
       VALUES (?, ?, 'reconciled', ?, ?, 'p-attacker', ?, NULL)`,
    )
    .run(
      `ev-forged-${Math.random().toString(36).slice(2)}`,
      runId,
      actor,
      new Date().toISOString(),
      JSON.stringify(detail),
    );
}

describe('the price of forging a reconciliation, as measured', () => {
  it('is two INSERTs, and neither cited guard objects before or after', () => {
    const fx = reliabilityFixture();
    const runId = uncertainRun(fx);
    expect(fx.ops.listRuns().filter((run) => run.needsReconciliation)).toHaveLength(1);
    // The FIRST cited guard: a durable length commitment / chain verification.
    expect(verifyEvidenceChain(fx.db), 'the chain is intact before the forgery').toBeNull();

    forgeEvidenceLink(fx, 'attacker', RUN_RECONCILED_EVIDENCE_KIND, {
      runId,
      decision: 'confirmed_not_executed',
      note: 'forged',
      executable: false,
    });
    rawReconciledRow(fx, runId, 'attacker', {
      decision: 'confirmed_not_executed',
      note: 'forged',
    });

    // …and it reads intact AFTER it too. A correctly chained forged link is an
    // ordinary entry to this function, which is what it is designed to say.
    expect(verifyEvidenceChain(fx.db), 'the chain verification does not object').toBeNull();

    const after = fx.ops.getRun(runId)!;
    expect(after.state, 'the forgery concludes the run — this is the disclosed residual').toBe(
      'concluded',
    );
    expect(after.outcome).toBe('not_executed');
    expect(after.needsReconciliation).toBe(false);
    expect(after.admitsAttempt).toBe(true);
    // The Founder's reconciliation inbox is emptied by it.
    expect(fx.ops.listRuns().filter((run) => run.needsReconciliation)).toHaveLength(0);
    // And a second attempt on the `side_effect = 1` work is re-admitted.
    expect(
      fx.ops.openRun({
        taskId: fx.claim.taskId,
        workerId: fx.claim.workerId,
        fence: fx.claim.fence,
        runKind: 'external_action',
        label: 'again',
        idempotencyKey: 'second-lineage',
      }).ok,
    ).toBe(true);
  });

  it('does not need an unresolved actor: `founder` works exactly as well', () => {
    // The docblock used to describe the closed case as "one appended row, by an
    // actor nobody resolved". The actor is not what is checked — the witness is
    // matched on `[actor, decision]`, so any name that appears in both rows
    // corroborates itself.
    const fx = reliabilityFixture();
    const runId = uncertainRun(fx);
    forgeEvidenceLink(fx, 'founder', RUN_RECONCILED_EVIDENCE_KIND, {
      runId,
      decision: 'confirmed_not_executed',
      note: 'forged under a trusted name',
      executable: false,
    });
    rawReconciledRow(fx, runId, 'founder', {
      decision: 'confirmed_not_executed',
      note: 'forged under a trusted name',
    });
    expect(fx.ops.getRun(runId)!.state).toBe('concluded');
  });

  it('op_evidence refuses UPDATE and DELETE but not INSERT, which is why the above works', () => {
    const fx = reliabilityFixture();
    uncertainRun(fx);
    const row = fx.db.prepare(`SELECT id FROM op_evidence ORDER BY seq LIMIT 1`).get() as {
      id: string;
    };
    expect(() =>
      fx.db.prepare(`UPDATE op_evidence SET actor = 'x' WHERE id = ?`).run(row.id),
    ).toThrow();
    expect(() => fx.db.prepare(`DELETE FROM op_evidence WHERE id = ?`).run(row.id)).toThrow();
    // The INSERT the forgery uses is not refused, and must not be: an append is
    // the write the log is for.
    expect(() =>
      forgeEvidenceLink(fx, 'anybody', 'some_unrelated_kind', { note: 'an ordinary append' }),
    ).not.toThrow();
    expect(verifyEvidenceChain(fx.db)).toBeNull();
  });

  it('Low-1: one raw COPY of an HONEST reconciliation reverts a concluded run', () => {
    // No forged evidence at all. Witnesses are consumed one per event, so a
    // second ledger row against one witness is unwitnessed and folds through
    // `default`. Fail-closed — the run reappears in the Founder's inbox — and
    // therefore recorded here rather than repaired.
    const fx = reliabilityFixture();
    const runId = uncertainRun(fx);
    expectOk(
      fx.ops.reconcileRun({
        runId,
        decision: 'confirmed_not_executed',
        note: 'checked, nothing published',
        requestedBy: 'founder',
      }),
    );
    expect(fx.ops.getRun(runId)!.state).toBe('concluded');

    rawReconciledRow(fx, runId, 'founder', {
      decision: 'confirmed_not_executed',
      note: 'checked, nothing published',
    });

    const after = fx.ops.getRun(runId)!;
    expect(after.state, 'the honest conclusion is reverted by one raw append').toBe(
      'needs_reconciliation',
    );
    expect(after.outcome).toBe('outcome_unknown');
    expect(after.needsReconciliation, 'and it returns to the Founder inbox').toBe(true);
    // The direction matters: it takes AWAY permission rather than granting it.
    expect(after.admitsAttempt).toBe(false);
    expect(verifyEvidenceChain(fx.db), 'and the evidence log is untouched by it').toBeNull();
  });
});

/**
 * The SIBLING residual, measured rather than reasoned by analogy.
 *
 * `standingIntegrityVerdict` carried the identical sentence — a forged evidence
 * entry costs "appending to a chain that is now engine-guarded and
 * length-committed. A real barrier" — and the phase document repeated it a
 * third time. The whole lesson of this wave is that one defect described in
 * three texts is still one defect, so the sibling is EXECUTED here rather than
 * assumed to behave the same way.
 */
describe('the price of forging a CLEAR integrity verdict, as measured', () => {
  it('is the same two INSERTs, and clears a latched safe mode', () => {
    const fx = reliabilityFixture();
    // Break the chain by a legal APPEND, so HQ genuinely cannot stand behind
    // its own record and latches safe mode.
    fx.db
      .prepare(
        `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
         VALUES (?, ?, NULL, 'not-hq', 'forged', '{"executable":false}', 'genesis', 'never-computed')`,
      )
      .run('forged-evidence-entry', new Date().toISOString());
    expect(verifyEvidenceChain(fx.db), 'the chain really is broken').not.toBeNull();
    const engaged = expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
    expect(engaged.safeMode).toBe(true);
    expect(standingIntegrityVerdict(fx.db)!.safeMode).toBe(true);

    // The forgery: one locally-valid evidence link naming a verdict id, and one
    // appended clean verdict row carrying it. A broken chain EARLIER does not
    // stop a link being valid against the row before it, which is what
    // `evidenceEntryLinkStands` checks.
    const verdictId = 'verdict-forged-clean';
    forgeEvidenceLink(fx, 'attacker', INTEGRITY_ASSESSED_EVIDENCE_KIND, {
      verdictId,
      depth: 'full',
      safeMode: false,
      safeModeChanged: true,
      findings: [],
      executable: false,
    });
    fx.db
      .prepare(
        `INSERT INTO hq_reliability_verdicts
           (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
         VALUES (?, ?, 'full', 0, '[]', 'attacker', 'attacker')`,
      )
      .run(verdictId, new Date().toISOString());

    const standing = standingIntegrityVerdict(fx.db)!;
    expect(
      standing.safeMode,
      'the disclosed residual: a file-holding writer clears the latch with two appends',
    ).toBe(false);
    // And the chain is STILL broken — the condition the latch was raised for
    // never went away, which is what makes the cleared latch a lie rather than
    // merely a shortcut.
    expect(verifyEvidenceChain(fx.db), 'the chain remains broken throughout').not.toBeNull();
  });
});
