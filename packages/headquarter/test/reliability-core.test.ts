/**
 * Phase 13 — the reliability CORE: vocabularies, the pure derivations, the
 * keys, the capability trio, and the crash classification.
 *
 * Everything here is exercised without a facade, because it is meant to be
 * usable without one: a rule that only holds inside the service is a rule the
 * next caller can bypass.
 */

import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATUSES } from '../src/contracts/events.js';
import { MISSION_STATUSES } from '../src/contracts/mission.js';
import { ACTION_STATES, ACTION_RECONCILE_DECISIONS } from '../src/application/action-gateway.js';
import { PRODUCT_LIFECYCLE_STATES } from '../src/application/product-command.js';
import {
  RELIABILITY_COMMAND_CAPABILITY,
  RUN_EVENT_KINDS,
  RUN_FAILURE_CATEGORIES,
  RUN_INTERRUPTION_REASONS,
  RUN_KINDS,
  RUN_OUTCOMES,
  RUN_RECONCILE_DECISIONS,
  RUN_STATES,
  UNRECOGNIZED_BUCKET,
  classifyInterruptedRun,
  deriveRunRecord,
  emptyReliabilitySnapshot,
  isRunKind,
  reliabilityCommandCapabilityState,
  reliabilityCommandContractDrift,
  runAdmitsAttempt,
  runAttemptGeneration,
  runAttemptKey,
  runIdempotencyKey,
  summarizeReliability,
  type RunEventRow,
  type RunRow,
} from '../src/application/reliability-command.js';

const ROW: RunRow = {
  seq: 1,
  id: 'run-1',
  runKind: 'external_action',
  taskId: 'task-1',
  missionId: null,
  actionId: null,
  capabilityId: 'github.open_pr',
  workerId: 'claude',
  claimFence: 1,
  claimNonce: 'nonce-1',
  processId: 'process-one',
  label: 'publish the release note',
  openedAt: '2026-09-01T00:00:00.000Z',
  runKey: 'run:abcdef',
};

let seq = 0;
function event(
  kind: RunEventRow['kind'],
  detail: Record<string, unknown> = {},
  over: Partial<RunEventRow> = {},
): RunEventRow {
  seq += 1;
  return {
    seq,
    id: `event-${seq}`,
    runId: ROW.id,
    kind,
    actor: 'claude',
    at: `2026-09-01T00:00:0${seq % 10}.000Z`,
    processId: 'process-one',
    detail,
    attemptKey: null,
    ...over,
  };
}

describe('the run vocabularies are closed, and disjoint from every canonical one', () => {
  it('shares no member with the task, mission, action or product vocabularies', () => {
    // The load-bearing assertion of the phase's first law. A run state named
    // `completed` or `blocked` would create exactly the ambiguity a reader
    // would then have to resolve by guessing, and a future member that
    // collides fails here rather than in production.
    for (const state of RUN_STATES) {
      expect(ACTIVITY_STATUSES as readonly string[]).not.toContain(state);
      expect(MISSION_STATUSES as readonly string[]).not.toContain(state);
      expect(ACTION_STATES as readonly string[]).not.toContain(state);
      expect(PRODUCT_LIFECYCLE_STATES as readonly string[]).not.toContain(state);
    }
  });

  it('reuses the Phase 8 reconciliation decisions verbatim rather than spelling a second set', () => {
    expect(RUN_RECONCILE_DECISIONS).toBe(ACTION_RECONCILE_DECISIONS);
  });

  it('carries no numeric confidence, probability, percentage or ETA anywhere', () => {
    const everyName = [
      ...RUN_KINDS,
      ...RUN_STATES,
      ...RUN_OUTCOMES,
      ...RUN_FAILURE_CATEGORIES,
      ...RUN_INTERRUPTION_REASONS,
      ...RUN_EVENT_KINDS,
    ].join(' ');
    expect(everyName).not.toMatch(/percent|confidence|probability|score|eta|estimate/i);
  });

  it('states an outcome HQ does not know as a first-class member, not an error', () => {
    expect(RUN_OUTCOMES).toContain('outcome_unknown');
    expect(RUN_STATES).toContain('needs_reconciliation');
  });
});

describe('the capability trio fails closed the way every other Founder gate does', () => {
  it('is founder_gate, has no side effect, and is idempotent', () => {
    expect(RELIABILITY_COMMAND_CAPABILITY).toMatchObject({
      id: 'hq.reliability_command',
      riskClass: 'founder_gate',
      sideEffect: false,
      idempotent: true,
    });
  });

  it('classifies missing / altered / disabled / enabled, and checks drift before enabled', () => {
    expect(reliabilityCommandCapabilityState(null)).toBe('missing');
    const good = { ...RELIABILITY_COMMAND_CAPABILITY, description: 'x', enabled: true };
    expect(reliabilityCommandCapabilityState(good)).toBe('enabled');
    expect(reliabilityCommandCapabilityState({ ...good, enabled: false })).toBe('disabled');
    const weakened = { ...good, riskClass: 'read_only' as const, enabled: true };
    expect(reliabilityCommandCapabilityState(weakened)).toBe('altered');
    expect(reliabilityCommandContractDrift(weakened)).toEqual(['riskClass']);
    // Drift wins over disabled: a weakened definition is reported as weakened
    // even when the row also happens to be off.
    expect(reliabilityCommandCapabilityState({ ...weakened, enabled: false })).toBe('altered');
  });
});

describe('the derived run record', () => {
  it('is open with no outcome until something happens', () => {
    const record = deriveRunRecord(ROW, [event('opened')]);
    expect(record.state).toBe('open');
    expect(record.outcome).toBe('none');
    expect(record.attempts).toBe(0);
    expect(record.admitsAttempt).toBe(true);
    expect(record.nextGeneration).toBe(1);
  });

  it('counts attempts and carries the last correlation', () => {
    const record = deriveRunRecord(ROW, [
      event('opened'),
      event('attempt_started', { correlationId: 'run-1#1', generation: 1 }),
    ]);
    expect(record.state).toBe('attempting');
    expect(record.attempts).toBe(1);
    expect(record.lastCorrelationId).toBe('run-1#1');
    expect(record.admitsAttempt).toBe(false);
  });

  it('concludes on a reported success or failure, and refuses a further attempt either way', () => {
    for (const outcome of ['succeeded', 'failed', 'not_executed'] as const) {
      const record = deriveRunRecord(ROW, [
        event('opened'),
        event('attempt_started', { correlationId: 'run-1#1' }),
        event('outcome_recorded', { outcome, failureCategory: 'none' }),
      ]);
      expect(record.state).toBe('concluded');
      expect(record.outcome).toBe(outcome);
      expect(runAdmitsAttempt(record)).toBe(false);
    }
  });

  it('moves an UNKNOWN outcome to needs_reconciliation and never admits another attempt', () => {
    const record = deriveRunRecord(ROW, [
      event('opened'),
      event('attempt_started', { correlationId: 'run-1#1' }),
      event('outcome_recorded', { outcome: 'outcome_unknown', failureCategory: 'provider_unavailable' }),
    ]);
    expect(record.state).toBe('needs_reconciliation');
    expect(record.outcome).toBe('outcome_unknown');
    expect(record.failureCategory).toBe('provider_unavailable');
    expect(record.needsReconciliation).toBe(true);
    expect(runAdmitsAttempt(record)).toBe(false);
  });

  it('reads an outcome outside the closed vocabulary as UNKNOWN rather than as itself', () => {
    // Fail closed: `hq_reliability_run_events` is append-only, and an APPEND is
    // the write its triggers deliberately permit. A forged `outcome` must not
    // be able to conclude a run — the safe reading is the one that demands a
    // human, never the one that closes the record.
    const record = deriveRunRecord(ROW, [
      event('opened'),
      event('attempt_started', {}),
      event('outcome_recorded', { outcome: 'definitely_fine' }),
    ]);
    expect(record.state).toBe('needs_reconciliation');
    expect(record.outcome).toBe('outcome_unknown');
    expect(runAdmitsAttempt(record)).toBe(false);
  });

  it('reads an event KIND outside the closed vocabulary as “HQ does not know”, never as an attempt', () => {
    // A forged append is representable in an append-only table even though no
    // facade path produces one. The fail-closed reading is the one that costs
    // a human a look, so it lands in needs_reconciliation — not as an attempt,
    // not as a conclusion, and emphatically not as permission to try again.
    const forged = { ...event('opened'), kind: 'totally_fine' as RunEventRow['kind'] };
    const record = deriveRunRecord(ROW, [event('opened'), forged]);
    expect(record.attempts).toBe(0);
    expect(record.state).toBe('needs_reconciliation');
    expect(record.outcome).toBe('outcome_unknown');
    expect(record.failureCategory).toBe('unknown');
    expect(runAdmitsAttempt(record)).toBe(false);
  });

  it('reads a reconciliation decision outside the vocabulary as the strictest of the three', () => {
    const record = deriveRunRecord(ROW, [
      event('opened'),
      event('attempt_started', {}),
      event('outcome_recorded', { outcome: 'outcome_unknown' }),
      event('reconciled', { decision: 'confirmed_obviously_fine', note: 'trust me' }),
    ]);
    expect(record.outcome).toBe('failed');
    expect(runAdmitsAttempt(record)).toBe(false);
  });

  it('reopens an attempt ONLY for confirmed_not_executed, and only then', () => {
    const base = [
      event('opened'),
      event('attempt_started', { correlationId: 'run-1#1' }),
      event('outcome_recorded', { outcome: 'outcome_unknown' }),
    ];
    expect(
      runAdmitsAttempt(deriveRunRecord(ROW, [...base, event('reconciled', { decision: 'confirmed_succeeded' })])),
    ).toBe(false);
    expect(
      runAdmitsAttempt(deriveRunRecord(ROW, [...base, event('reconciled', { decision: 'confirmed_failed' })])),
    ).toBe(false);
    const reopened = deriveRunRecord(ROW, [
      ...base,
      event('reconciled', { decision: 'confirmed_not_executed', note: 'checked GitHub; no PR exists' }),
    ]);
    expect(runAdmitsAttempt(reopened)).toBe(true);
    expect(reopened.outcome).toBe('not_executed');
    expect(reopened.nextGeneration).toBe(2);
  });

  it('closes again after the reopened attempt, rather than staying permanently open', () => {
    const record = deriveRunRecord(ROW, [
      event('opened'),
      event('attempt_started', {}),
      event('outcome_recorded', { outcome: 'outcome_unknown' }),
      event('reconciled', { decision: 'confirmed_not_executed' }),
      event('attempt_started', { correlationId: 'run-1#2', generation: 2 }),
    ]);
    expect(record.state).toBe('attempting');
    expect(record.attempts).toBe(2);
    expect(runAdmitsAttempt(record)).toBe(false);
  });

  it('counts generations the way the Phase 8 side-effect ledger counts them', () => {
    expect(runAttemptGeneration([event('opened')])).toBe(1);
    expect(
      runAttemptGeneration([
        event('reconciled', { decision: 'confirmed_not_executed' }),
        event('reconciled', { decision: 'confirmed_failed' }),
      ]),
    ).toBe(2);
  });
});

describe('crash classification', () => {
  const openRecord = deriveRunRecord(ROW, [event('opened')]);
  const attemptingRecord = deriveRunRecord(ROW, [event('opened'), event('attempt_started', {})]);
  const unknownRecord = deriveRunRecord(ROW, [
    event('opened'),
    event('attempt_started', {}),
    event('outcome_recorded', { outcome: 'outcome_unknown' }),
  ]);

  it('concludes a never-attempted run as not_executed, because the ledger PROVES it', () => {
    expect(classifyInterruptedRun(openRecord, { capabilitySideEffect: true })).toEqual({
      interrupted: true,
      uncertain: false,
      reason: 'process_interrupted',
      outcome: 'not_executed',
    });
  });

  it('concludes an interrupted attempt of a no-side-effect capability as not_executed', () => {
    expect(classifyInterruptedRun(attemptingRecord, { capabilitySideEffect: false })).toMatchObject({
      uncertain: false,
      outcome: 'not_executed',
    });
  });

  it('leaves an interrupted attempt of a SIDE-EFFECT capability uncertain, forever', () => {
    const verdict = classifyInterruptedRun(attemptingRecord, { capabilitySideEffect: true })!;
    expect(verdict).toMatchObject({ uncertain: true, outcome: 'outcome_unknown' });
  });

  it('classifies nothing that is already concluded or already awaiting a human', () => {
    expect(classifyInterruptedRun(unknownRecord, { capabilitySideEffect: true })).toBeNull();
    const concluded = deriveRunRecord(ROW, [
      event('opened'),
      event('attempt_started', {}),
      event('outcome_recorded', { outcome: 'succeeded' }),
    ]);
    expect(classifyInterruptedRun(concluded, { capabilitySideEffect: true })).toBeNull();
  });

  it('carries the requested interruption reason through', () => {
    for (const reason of RUN_INTERRUPTION_REASONS) {
      expect(classifyInterruptedRun(attemptingRecord, { capabilitySideEffect: true, reason })!.reason).toBe(
        reason,
      );
    }
  });
});

describe('the derived keys', () => {
  const base = {
    taskId: 'task-1',
    runKind: 'external_action' as const,
    actionId: null,
    missionId: null,
    label: 'publish',
    idempotencyKey: null,
  };

  it('is deterministic for identical inputs', () => {
    expect(runIdempotencyKey(base)).toBe(runIdempotencyKey({ ...base }));
  });

  it('takes the caller idempotency key as an INPUT, never as the key itself', () => {
    const withKey = runIdempotencyKey({ ...base, idempotencyKey: 'attempt-two' });
    expect(withKey).not.toBe(runIdempotencyKey(base));
    expect(withKey).not.toContain('attempt-two');
    expect(withKey.startsWith('run:')).toBe(true);
  });

  it('separates different work, and joins the same work across restarts', () => {
    expect(runIdempotencyKey({ ...base, taskId: 'task-2' })).not.toBe(runIdempotencyKey(base));
    expect(runIdempotencyKey({ ...base, runKind: 'dispatch' })).not.toBe(runIdempotencyKey(base));
    // The claim fence is deliberately absent from the inputs entirely: a
    // re-claim after a crash must find the SAME run and inherit its unresolved
    // outcome, and a key that varied with the fence would defeat that.
    expect(Object.keys(base)).not.toContain('fence');
  });

  it('gives each generation its own reservation identity', () => {
    expect(runAttemptKey('run:abc', 1)).toBe('run:abc#1');
    expect(runAttemptKey('run:abc', 2)).not.toBe(runAttemptKey('run:abc', 1));
  });
});

describe('the snapshot fold is closed by construction', () => {
  it('keys every map by a CHECKED vocabulary member, and buckets anything else', () => {
    const hostile = deriveRunRecord(
      { ...ROW, runKind: 'totally new kind' as RunRow['runKind'] },
      [event('opened')],
    );
    const view = summarizeReliability({
      storePresent: true,
      runs: [hostile],
      verifiedBackups: 0,
      safeMode: false,
      assessmentDepth: 'structural',
      evidenceChain: 'verified',
      findings: ['append_only_guard_missing', 'a finding nobody defined'],
      durabilityMeetsRequirement: true,
    });
    expect(Object.keys(view.byKind).sort()).toEqual([...RUN_KINDS, UNRECOGNIZED_BUCKET].sort());
    expect(view.byKind[UNRECOGNIZED_BUCKET]).toBe(1);
    expect(JSON.stringify(view)).not.toContain('totally new kind');
    expect(JSON.stringify(view)).not.toContain('a finding nobody defined');
    expect(view.findings).toEqual({ append_only_guard_missing: 1, [UNRECOGNIZED_BUCKET]: 1 });
    // Every count is an integer, and each map's total equals what was folded.
    const total = Object.values(view.byKind).reduce((a, b) => a + b, 0);
    expect(total).toBe(view.runs);
    for (const value of Object.values(view.byState)) expect(Number.isInteger(value)).toBe(true);
  });

  it('has an unrecognized bucket that is not a member of any vocabulary it counts', () => {
    expect(isRunKind(UNRECOGNIZED_BUCKET)).toBe(false);
    expect(RUN_STATES as readonly string[]).not.toContain(UNRECOGNIZED_BUCKET);
    expect(RUN_OUTCOMES as readonly string[]).not.toContain(UNRECOGNIZED_BUCKET);
  });

  it('states an ABSENT store as absent rather than as an empty one', () => {
    const empty = emptyReliabilitySnapshot(false);
    expect(empty.storePresent).toBe(false);
    expect(empty.runs).toBe(0);
    expect(empty.note).toMatch(/Counts over closed vocabularies only/);
  });
});
