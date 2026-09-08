/**
 * `needs_reconciliation` is a LATCH: only a reconciliation leaves it (Wave 5
 * correction round fifteen, Critical 3 — a defect introduced by this diff).
 *
 * ## What was open
 *
 * `deriveRunRecord`'s fold wrote the rule out branch by branch, and the FIRST
 * branch did not have it:
 *
 * ```ts
 * case 'opened': state = 'open'; break;   // unconditional
 * ```
 *
 * The three neighbours had been hardened against exactly this attacker —
 * `outcome_recorded` explicitly refuses to conclude a run standing at
 * `needs_reconciliation`, `interrupted` fails closed on `uncertain`, and the
 * `default` branch treats anything unreadable as needing a human. So one
 * append of `kind='opened'` — an APPEND, which is precisely the write
 * `hq_reliability_run_events`'s own triggers permit; no UPDATE, no DELETE, no
 * DDL — moved a run from `needs_reconciliation` back to `open`,
 * `needsReconciliation` went false, `admitsAttempt` went true, the `openRun`
 * guard lifted, and a SECOND attempt ran on the same `side_effect = 1`
 * `github.open_pr` work whose last honest word was "HQ does not know whether
 * the first one published". The Founder's reconciliation inbox went from one
 * item to zero in the same instant: the uncertainty and the prompt to look at
 * it were the same row.
 *
 * ## What is enforced instead
 *
 * ONE structural invariant over the whole fold rather than N copies of a
 * sentence. The state, outcome, failure category and reopened flag are
 * snapshotted before each event and restored after it whenever the run stands
 * at `needs_reconciliation` and the event is not a `reconciled`. A branch
 * added in a future phase inherits the latch without being enumerated — which
 * is the property the branch-by-branch version did not have, and the reason it
 * was wrong in exactly one place.
 *
 * The tests below therefore attack EVERY event kind the ledger's vocabulary
 * admits plus an unknown one, taken from the exported `RUN_EVENT_KINDS` the
 * writer itself validates against rather than from a list this file
 * maintains.
 */

import { describe, expect, it } from 'vitest';
import { expectOk } from './application.fixture.js';
import { reliabilityFixture, type ReliabilityFixture } from './reliability.fixture.js';
import { RUN_EVENT_KINDS, deriveRunRecord } from '../src/application/reliability-command.js';

/** A run on the pre-approved, idempotent, SIDE-EFFECT capability, left uncertain. */
function uncertainRun(fx: ReliabilityFixture, key?: string): string {
  const opened = expectOk(
    fx.ops.openRun({
      taskId: fx.claim.taskId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      runKind: 'external_action',
      label: 'open the pull request',
      ...(key ? { idempotencyKey: key } : {}),
    }),
  );
  const runId = opened.run.id;
  expectOk(
    fx.ops.startRunAttempt({
      runId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
    }),
  );
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
  expect(record.needsReconciliation).toBe(true);
  expect(record.admitsAttempt).toBe(false);
  return runId;
}

/**
 * Append a raw run event. Deliberately the ONLY kind of write used here: the
 * ledger's triggers permit an append and refuse everything else, so this is
 * the strongest attacker the storage layer admits rather than a hypothetical
 * one with `UPDATE` rights.
 */
function rawAppend(
  fx: ReliabilityFixture,
  runId: string,
  kind: string,
  detail: Record<string, unknown> = {},
): void {
  fx.db
    .prepare(
      `INSERT INTO hq_reliability_run_events (id, run_id, kind, actor, at, process_id, detail, attempt_key)
       VALUES (?, ?, ?, 'attacker', ?, 'p-attacker', ?, NULL)`,
    )
    .run(
      `ev-${kind}-${Math.random().toString(36).slice(2)}`,
      runId,
      kind,
      new Date().toISOString(),
      JSON.stringify(detail),
    );
}

/**
 * Every `kind` the ledger's own closed vocabulary admits, taken from the
 * exported constant rather than retyped here.
 *
 * The whole finding is that a list of BRANCHES was one short. A list of kinds
 * in this file would reproduce the same mistake at the other end: a kind added
 * in a future phase would be attacked by nothing. `RUN_EVENT_KINDS` is what
 * the writer validates against, so this test grows with it, and an unknown
 * kind is added on top to exercise the fold's `default` — the shape a raw
 * append can actually put in the file.
 */
function ledgerEventKinds(): string[] {
  const kinds = [...RUN_EVENT_KINDS];
  expect(kinds.length).toBeGreaterThanOrEqual(4);
  return kinds;
}

describe('an uncertain run is left uncertain by every append except a reconciliation', () => {
  it('survives a forged `opened`, keeping the guard, the inbox item and the refusal', () => {
    const fx = reliabilityFixture();
    const runId = uncertainRun(fx);
    const inboxBefore = fx.ops.listRuns().filter((run) => run.needsReconciliation).length;
    expect(inboxBefore).toBe(1);

    rawAppend(fx, runId, 'opened');

    const after = fx.ops.getRun(runId)!;
    expect(after.state).toBe('needs_reconciliation');
    expect(after.outcome).toBe('outcome_unknown');
    expect(after.needsReconciliation).toBe(true);
    expect(after.admitsAttempt).toBe(false);
    // The Founder's reconciliation inbox still holds it.
    expect(fx.ops.listRuns().filter((run) => run.needsReconciliation)).toHaveLength(1);
    // And the guard that stops a second attempt on the same work still stands.
    const second = fx.ops.openRun({
      taskId: fx.claim.taskId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      runKind: 'external_action',
      label: 'open the pull request again',
      idempotencyKey: 'second-lineage',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('run_state_conflict');
  });

  it('survives EVERY event kind the vocabulary admits, plus one it does not', () => {
    for (const kind of [...ledgerEventKinds(), 'a_kind_from_a_future_phase']) {
      if (kind === 'reconciled') continue; // the one event that legitimately concludes
      // A FRESH fixture per kind: `openRun` refuses a second run on work that
      // already stands uncertain, which is the guard under test.
      const fx = reliabilityFixture();
      const runId = uncertainRun(fx);
      rawAppend(fx, runId, kind, {
        // Every field the fold reads, set to the most CONVENIENT value an
        // attacker could choose: "nothing happened, carry on".
        outcome: 'not_executed',
        failureCategory: 'none',
        uncertain: false,
        correlationId: 'c-forged',
        decision: 'confirmed_not_executed',
      });
      const after = fx.ops.getRun(runId)!;
      expect(after.state, kind).toBe('needs_reconciliation');
      expect(after.outcome, kind).toBe('outcome_unknown');
      expect(after.needsReconciliation, kind).toBe(true);
      expect(after.admitsAttempt, kind).toBe(false);
    }
  });

  it('still lets a REAL reconciliation conclude the run and reopen the work', () => {
    // The latch must not become a deadlock: the whole point of
    // `needs_reconciliation` is that a human resolves it.
    const fx = reliabilityFixture();
    const runId = uncertainRun(fx);
    expectOk(
      fx.ops.reconcileRun({
        runId,
        decision: 'confirmed_not_executed',
        requestedBy: 'founder',
        note: 'checked GitHub: no pull request exists',
      }),
    );
    const after = fx.ops.getRun(runId)!;
    expect(after.state).toBe('concluded');
    expect(after.outcome).toBe('not_executed');
    expect(after.needsReconciliation).toBe(false);
    expect(after.admitsAttempt).toBe(true);
  });

  it('is a property of the PURE fold, not of the facade that calls it', () => {
    // `deriveRunRecord` is exported and pure, and other lanes fold rows with
    // it. Asserted directly so the invariant cannot be satisfied by a check
    // that lives only in `getRun`.
    const row = {
      id: 'run-1',
      seq: 1,
      runKind: 'external_action' as const,
      taskId: 't-1',
      missionId: null,
      actionId: null,
      capabilityId: 'github.open_pr',
      workerId: 'claude',
      claimFence: 1,
      processId: 'p-1',
      label: 'open the pull request',
      openedAt: '2026-09-08T00:00:00.000Z',
      claimNonce: 'nonce-1',
      runKey: 'run-key-1',
    };
    let seq = 0;
    const event = (kind: string, detail: Record<string, unknown> = {}) => {
      seq += 1;
      return {
        seq,
        id: `ev-${seq}`,
        runId: 'run-1',
        attemptKey: null,
        kind: kind as never,
        actor: 'claude',
        at: '2026-09-08T00:00:01.000Z',
        processId: 'p-1',
        detail,
      };
    };
    const record = deriveRunRecord(row, [
      event('opened'),
      event('attempt_started', { correlationId: 'c-1' }),
      event('outcome_recorded', { outcome: 'outcome_unknown' }),
      event('opened'),
      event('attempt_started', { correlationId: 'c-2' }),
    ]);
    expect(record.state).toBe('needs_reconciliation');
    expect(record.outcome).toBe('outcome_unknown');
    expect(record.admitsAttempt).toBe(false);
    // The counter still counts — testimony and counters are not authority.
    expect(record.attempts).toBe(2);
  });
});
