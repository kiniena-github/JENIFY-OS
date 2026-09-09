/**
 * Wave 5 correction round SEVENTEEN — the hostile review's findings, closed as
 * CLASSES and pinned here.
 *
 * Every suite in this file was written from an EXECUTED reproduction against
 * the frozen head `85b720d`, and every one of them fails when its fix is
 * reverted. Nothing here reaches a network, a provider or a paid service: the
 * adapters are the package's own local fakes and every database is
 * `:memory:`.
 *
 *  - Critical 1 — `sideEffectGeneration` counted forged rows, so ONE plain
 *    `INSERT` into `hq_action_events` opened a fresh generation and produced a
 *    SECOND real execution of a public, irreversible external action.
 *  - Medium 4 — the regression test round fifteen left behind asserted the
 *    class in its comment and tested one spelling. Closed here, by attacking
 *    every INSERT spelling, every side-effect-key shape and the whole state
 *    vocabulary plus its case and whitespace variants.
 *  - High 1 — the residual sentence beside `witnessReconciliations` named a
 *    defence that does not exist, and the two-append forgery it glossed left
 *    every health surface reporting clean.
 *  - Medium 2 — `ops.directory.getSpecialist` was the one delegate round
 *    sixteen did not migrate, on the line above the comment claiming the class
 *    was closed.
 *  - Medium 3 — `deriveRunRecord`'s `witnessed` tri-state defaulted OPEN.
 *  - Low 1 — `evaluateBudget`'s unreadable-ceiling guard missed `NaN` and
 *    `Infinity` while its docblock said otherwise.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CAPS, expectOk } from './application.fixture.js';
import {
  authorizedAction,
  errorCode,
  fakeAdapter,
  gatewayFixture,
  startedTask,
  type GatewayFixture,
} from './action-gateway.fixture.js';
import { ACTION_STATES, sideEffectGeneration } from '../src/application/action-gateway.js';
import {
  RUN_RECONCILED_EVIDENCE_KIND,
  deriveRunRecord,
  runAdmitsAttempt,
  runAttemptGeneration,
  uncommittedReconciliationWitnesses,
  type RunEventRow,
  type RunRow,
} from '../src/application/reliability-command.js';
import { contradictedChainCommitment } from '../src/store/integrity.js';
import { evaluateBudget } from '../src/application/intelligence-command.js';
import { executorReadiness } from '../src/providers/claude/dispatch.js';
import type { HqDatabase } from '../src/store/db.js';

/* ------------------------------------------------------------------ */
/* Critical 1 + Medium 4 — the action ledger's generation counter       */
/* ------------------------------------------------------------------ */

/**
 * A `publish_release` action that has really executed once.
 *
 * `publish_release` is `visibility: 'public'`, `reversibility: 'irreversible'`,
 * `compensation: null` — the worst thing this ledger can be made to repeat,
 * and the contract the reviewer used. It is critical risk, so it runs under
 * the approval-gated `indexDoc` task the fixture already approves.
 */
function executedRelease(): { fx: GatewayFixture; actionId: string; base: string; fence: number; taskId: string } {
  const fx = gatewayFixture({ adapter: fakeAdapter({ mode: 'succeed' }) });
  const started = startedTask(fx, { capabilityId: CAPS.indexDoc, worker: 'claude' });
  const actionId = authorizedAction(fx, started, {
    actionType: 'publish_release',
    target: 'releases/v1',
    payload: { tag: 'v1' },
  });
  expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
  expect(fx.adapter.calls).toHaveLength(1);
  const base = (
    fx.db.prepare(`SELECT side_effect_key_base AS b FROM hq_action_intents WHERE id = ?`).get(actionId) as {
      b: string;
    }
  ).b;
  return { fx, actionId, base, fence: started.fence, taskId: started.taskId };
}

/** Every INSERT spelling SQLite accepts for a row that collides with nothing. */
const INSERT_SPELLINGS = [
  'INSERT INTO',
  'INSERT OR REPLACE INTO',
  'INSERT OR IGNORE INTO',
  'INSERT OR ABORT INTO',
  'INSERT OR FAIL INTO',
  'INSERT OR ROLLBACK INTO',
  'REPLACE INTO',
] as const;

/**
 * The whole `state` vocabulary, plus the spellings a whitelist would miss.
 *
 * The point of the case and whitespace variants is not that they are more
 * dangerous — they are less, because the candidate query matches `reconciled`
 * exactly and anything else is not counted at all. The point is that the test
 * MEASURES that rather than reasoning about it, which is what the round-fifteen
 * regression test did not do.
 */
const STATE_SPELLINGS = [
  ...ACTION_STATES,
  'RECONCILED',
  'Reconciled',
  'reCoNcIlEd',
  ' reconciled',
  'reconciled ',
  '\treconciled\n',
  '  reconciled  ',
  '',
  'not_a_state',
  "reconciled' --",
  'confirmed_not_executed',
] as const;

describe('Critical 1: no appended action event mints a side-effect generation', () => {
  it('refuses every INSERT spelling, every side-effect-key shape and the whole state vocabulary', () => {
    const attempted: string[] = [];
    const accepted: string[] = [];
    for (const spelling of INSERT_SPELLINGS) {
      const { fx, actionId, base } = executedRelease();
      // The connection pragma binds no foreign writer: prove the guards alone
      // hold, exactly as the round-fifteen test does.
      fx.db.pragma('recursive_triggers = OFF');
      try {
        const reservedKey = (
          fx.db.prepare(`SELECT side_effect_key AS k FROM hq_action_events WHERE side_effect_key IS NOT NULL`).get() as {
            k: string;
          }
        ).k;
        const keyVariants: (string | null)[] = [null, reservedKey, `${base}#1`, `${base}#2`, 'arbitrary-key', ''];
        let n = 0;
        for (const key of keyVariants) {
          for (const state of STATE_SPELLINGS) {
            n += 1;
            const label = `${spelling} state=${JSON.stringify(state)} key=${JSON.stringify(key)}`;
            attempted.push(label);
            try {
              fx.db
                .prepare(
                  `${spelling} hq_action_events (id, action_id, state, actor, at, detail, side_effect_key)
                   VALUES (?, ?, ?, 'attacker', 'now', '{"decision":"confirmed_not_executed"}', ?)`,
                )
                .run(`forged-${n}`, actionId, state, key);
              accepted.push(label);
            } catch {
              // The engine refused it. Either way the assertions below hold.
            }
            // The generation has not moved, so no fresh side-effect key exists.
            expect(sideEffectGeneration(fx.db, base), label).toBe(1);
            // And the facade agrees: an identical proposal still DEDUPES onto
            // the standing action rather than opening a second attempt.
            const again = fx.ops.proposeAction({
              taskId: (fx.db.prepare(`SELECT task_id AS t FROM hq_action_intents WHERE id = ?`).get(actionId) as { t: string }).t,
              adapterId: 'fake.local',
              actionType: 'publish_release',
              target: 'releases/v1',
              payload: { tag: 'v1' },
              requestedBy: 'founder',
            });
            expect(again.ok, label).toBe(true);
            if (again.ok) expect(again.data.deduplicated, label).toBe(true);
            expect(fx.adapter.calls.length, label).toBe(1);
          }
        }
        // One real external execution of the irreversible public action, after
        // every forgery in the matrix.
        expect(fx.adapter.calls).toHaveLength(1);
      } finally {
        fx.db.pragma('recursive_triggers = ON');
      }
    }
    // The attack surface has to be REAL: most of these rows land, and the
    // defence is that a landed row counts for nothing — not that the engine
    // refuses them all. A matrix the engine rejected wholesale would prove
    // nothing about `sideEffectGeneration`.
    expect(attempted.length).toBe(INSERT_SPELLINGS.length * 6 * STATE_SPELLINGS.length);
    // The whole `side_effect_key = NULL` column lands — that is the column the
    // reviewer's one-statement attack used, it collides with nothing, and the
    // unique index does not reach it. The non-null columns are refused after
    // their first row by the engine's own guards, which is a different defence
    // and not the one under test here.
    expect(accepted.length).toBeGreaterThanOrEqual(INSERT_SPELLINGS.length * STATE_SPELLINGS.length);
  });

  it('an HONEST reconciliation still opens exactly one fresh generation, and a copy of it opens none', () => {
    const fx = gatewayFixture({ adapter: fakeAdapter({ mode: 'unknown' }) });
    const started = startedTask(fx, { capabilityId: CAPS.openPr, payload: { branch: 'b' } });
    const actionId = authorizedAction(fx, started);
    expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    const base = (
      fx.db.prepare(`SELECT side_effect_key_base AS b FROM hq_action_intents WHERE id = ?`).get(actionId) as { b: string }
    ).b;
    expect(sideEffectGeneration(fx.db, base)).toBe(1);
    expectOk(
      fx.ops.reconcileAction({
        actionId,
        decision: 'confirmed_not_executed',
        note: 'Nothing on the remote.',
        requestedBy: 'coo',
      }),
    );
    // Corroborated by the evidence entry written in the same reservation.
    expect(sideEffectGeneration(fx.db, base)).toBe(2);

    // A COPY of that honest row — same action, actor and decision, appended
    // raw — is not credited twice: witnesses are consumed one per row.
    fx.db
      .prepare(
        `INSERT INTO hq_action_events (id, action_id, state, actor, at, detail, side_effect_key)
         VALUES ('copied', ?, 'reconciled', 'coo', 'now', '{"decision":"confirmed_not_executed"}', NULL)`,
      )
      .run(actionId);
    expect(sideEffectGeneration(fx.db, base)).toBe(2);

    // The fresh generation is a NEW proposal and it executes exactly once.
    fx.adapter.mode = 'succeed';
    const fresh = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 'notes/board',
        payload: { text: 'hello' },
        requestedBy: 'founder',
      }),
    );
    expect(fresh.deduplicated).toBe(false);
    expectOk(fx.ops.authorizeAction({ actionId: fresh.action.id, workerId: 'claude', fence: started.fence }));
    const executed = expectOk(
      fx.ops.executeAction({ actionId: fresh.action.id, workerId: 'claude', fence: started.fence }),
    );
    expect(executed.action.attempt?.generation).toBe(2);
    expect(fx.adapter.calls).toHaveLength(2);
  });

  it('an evidence row with the right fields and no valid hash corroborates nothing', () => {
    const { fx, actionId, base } = executedRelease();
    // A forged ledger row AND a forged witness that is not a genuine LINK.
    fx.db
      .prepare(
        `INSERT INTO hq_action_events (id, action_id, state, actor, at, detail, side_effect_key)
         VALUES ('forged-event', ?, 'reconciled', 'attacker', 'now', '{"decision":"confirmed_not_executed"}', NULL)`,
      )
      .run(actionId);
    fx.db
      .prepare(
        `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
         VALUES ('ev-forged', 'now', NULL, 'attacker', 'action_reconciled', ?, 'nope', 'nope')`,
      )
      .run(JSON.stringify({ actionId, decision: 'confirmed_not_executed' }));
    expect(sideEffectGeneration(fx.db, base)).toBe(1);
    expect(fx.adapter.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* High 1 — the residual sentence, and the health surface              */
/* ------------------------------------------------------------------ */

/** Append a genuine LINK to `op_evidence`, the way a foreign writer would. */
function appendForgedEvidenceLink(
  db: HqDatabase,
  entry: { id: string; at: string; taskId: string | null; actor: string; kind: string; payload: unknown },
): number {
  const previous = db.prepare(`SELECT hash FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as
    | { hash: string }
    | undefined;
  const prevHash = previous?.hash ?? 'GENESIS';
  const payloadJson = JSON.stringify(entry.payload);
  const hash = createHash('sha256')
    .update([prevHash, entry.id, entry.at, entry.taskId ?? '', entry.actor, entry.kind, payloadJson].join('|'))
    .digest('hex');
  db.prepare(
    `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.id, entry.at, entry.taskId, entry.actor, entry.kind, payloadJson, prevHash, hash);
  return Number((db.prepare(`SELECT MAX(seq) AS s FROM op_evidence`).get() as { s: number }).s);
}

describe('High 1: what the chain commitment does and does not detect, measured', () => {
  it('is silent about an APPEND past the newest committed length', () => {
    /**
     * The measurement behind the corrected residual sentence. The claim that
     * stood for one round was that appending to the chain is "guarded by the
     * engine and by a durable length commitment (`verifyEvidenceChain`)".
     * `contradictedChainCommitment` reports the first committed `chain_length`
     * at which the log no longer carries the committed `tip_hash` — a
     * SHORTENING or a REWRITE behind a commitment, which
     * `test/reliability-checkpoint-durability.test.ts` drives end to end. An
     * append PAST the newest commitment is ordinary chain growth and this is
     * what that reads as.
     */
    const fx = gatewayFixture({ adapter: fakeAdapter({ mode: 'unknown' }) });
    const started = startedTask(fx, { capabilityId: CAPS.openPr, payload: { branch: 'b' } });
    const actionId = authorizedAction(fx, started);
    expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expectOk(
      fx.ops.reconcileAction({ actionId, decision: 'confirmed_not_executed', note: 'checked', requestedBy: 'coo' }),
    );
    const committed = fx.db
      .prepare(`SELECT MAX(chain_length) AS n FROM hq_integrity_checkpoints WHERE chain_length > 0`)
      .get() as { n: number | null };
    expect(
      committed.n ?? 0,
      'the fixture must carry a real commitment for this to measure anything',
    ).toBeGreaterThan(0);
    expect(contradictedChainCommitment(fx.db), 'intact before the append').toBeNull();

    const seq = appendForgedEvidenceLink(fx.db, {
      id: 'ev-appended',
      at: 'now',
      taskId: null,
      actor: 'attacker',
      kind: RUN_RECONCILED_EVIDENCE_KIND,
      payload: { runId: 'run-x', decision: 'confirmed_not_executed' },
    });
    expect(seq, 'the append must land past the commitment for this to measure anything').toBeGreaterThan(
      committed.n!,
    );
    expect(contradictedChainCommitment(fx.db), 'an append past the commitment is not a contradiction').toBeNull();
    // The whole-chain walk is silent too: the forged row is a genuine link.
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
  });

  it('counts a reconciliation witness no standing commitment covers, and counts none of HQ`s own', () => {
    const fx = gatewayFixture({ adapter: fakeAdapter({ mode: 'unknown' }) });
    const started = startedTask(fx, { capabilityId: CAPS.openPr, payload: { branch: 'b' } });
    const actionId = authorizedAction(fx, started);
    expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expect(fx.ops.hqReliabilityPosture().commitments.uncommittedReconciliationWitnesses).toBe(0);

    // HQ's own reconciliation commits to the log inside its own reservation,
    // so its witness is covered the instant it lands.
    expectOk(
      fx.ops.reconcileAction({
        actionId,
        decision: 'confirmed_not_executed',
        note: 'Nothing on the remote.',
        requestedBy: 'coo',
      }),
    );
    const honest = fx.ops.hqReliabilityPosture();
    expect(honest.commitments.uncommittedReconciliationWitnesses).toBe(0);
    expect(honest.commitments.statement.length).toBeGreaterThan(120);

    // The two-append forgery: a genuine link naming a run, appended past every
    // commitment. Previously this left every health surface reporting clean.
    appendForgedEvidenceLink(fx.db, {
      id: 'ev-forged-witness',
      at: 'now',
      taskId: null,
      actor: 'attacker',
      kind: RUN_RECONCILED_EVIDENCE_KIND,
      payload: { runId: 'run-x', decision: 'confirmed_not_executed' },
    });
    expect(uncommittedReconciliationWitnesses(fx.db)).toBe(1);
    expect(fx.ops.hqReliabilityPosture().commitments.uncommittedReconciliationWitnesses).toBe(1);
    // The chain still verifies and the commitment is still intact — which is
    // the whole point: without this count, nothing anywhere said otherwise.
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();

    // The RESIDUAL, executed rather than reasoned about: a writer that also
    // appends a checkpoint committing its own tip is not counted. Three
    // appends rather than two, and it is disclosed, not closed.
    //
    // THE PRICE IS MEASURED HERE, and it was overstated in the reassuring
    // direction for one round (Wave 5 correction round eighteen, Medium C).
    // The prose beside `witnessReconciliations` said the third append costs
    // "two extra reads"; it costs ONE — the single row read below, whose
    // `seq` serves as the `op_evidence` value in BOTH commitment columns. The
    // three shapes are executed against the guard rather than argued about:
    //
    // ```
    // bare '{}'                 read 1  landed=false  may not commit beyond the record  counter stays 1
    // copy of the prior row     read 2  landed=false  may not commit beyond the record  counter stays 1
    // only `op_evidence`, seq   read 1  landed=true                                     counter 1 -> 0
    // ```
    //
    // READ ONE, and the only one the landing shape takes.
    const tip = fx.db.prepare(`SELECT seq, hash FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as {
      seq: number;
      hash: string;
    };
    const insert = (id: string, marks: string, rows: string): void => {
      fx.db
        .prepare(
          `INSERT INTO hq_integrity_checkpoints (id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
           VALUES (?, 'now', ?, ?, ?, ?, 'p', 'attacker')`,
        )
        .run(id, tip.seq, tip.hash, marks, rows);
    };
    // A bare commitment is refused: the guard requires the commitment to carry
    // the ledger identities the file actually holds.
    expect(() => insert('cp-bare', '{}', '{}')).toThrow(/may not commit beyond the record/);
    expect(uncommittedReconciliationWitnesses(fx.db), 'a refused commitment covers nothing').toBe(1);
    // Nor does copying the previous checkpoint's commitment, which would be
    // the other obvious way to avoid reading the file's identities. READ TWO,
    // and it buys nothing.
    const prior = fx.db
      .prepare(
        `SELECT ledger_marks AS m, ledger_rows AS r FROM hq_integrity_checkpoints ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as { m: string; r: string };
    expect(() => insert('cp-copied', prior.m, prior.r)).toThrow(/may not commit beyond the record/);
    expect(uncommittedReconciliationWitnesses(fx.db), 'a refused commitment covers nothing').toBe(1);
    // And the shape that DOES land, from the one read already taken: the tip
    // `seq` is both the `op_evidence` AUTOINCREMENT mark and its row count, so
    // the committed difference is zero and no gap clause refuses it. No second
    // read, and no other ledger named at all.
    const oneReadCommitment = JSON.stringify({ op_evidence: tip.seq });
    insert('cp-forged', oneReadCommitment, oneReadCommitment);
    expect(uncommittedReconciliationWitnesses(fx.db)).toBe(0);
    // The end state, stated as what it is: every Founder-facing surface reads
    // clean beside two real adapter executions of an irreversible public
    // action.
    expect(fx.ops.hqReliabilityPosture().commitments.uncommittedReconciliationWitnesses).toBe(0);
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Medium 2 — the fourth dispatch delegate                             */
/* ------------------------------------------------------------------ */

describe('Medium 2: the Founder-facing readiness verdict reads no patchable surface', () => {
  it('does not move when `ops.directory.getSpecialist` is replaced with a maximally permissive lie', () => {
    const fx = gatewayFixture();
    const ghost = 'ghost-worker';
    const before = executorReadiness(fx.ops, ghost, CAPS.indexDoc);
    expect(before).toMatchObject({ ready: false, registered: false, active: false, hasCapability: false });

    // An OWN-PROPERTY closure: one assignment on the object the caller already
    // holds, no prototype involved. The descriptor is asserted, so the test
    // fails if the surface ever stops being patchable in this shape rather
    // than silently proving nothing.
    const descriptor = Object.getOwnPropertyDescriptor(fx.ops.directory, 'getSpecialist')!;
    expect(descriptor.writable).toBe(true);
    const saved = fx.ops.directory.getSpecialist;
    try {
      (fx.ops.directory as { getSpecialist: unknown }).getSpecialist = () => ({
        id: ghost,
        displayName: 'Ghost',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: [CAPS.indexDoc, CAPS.openPr, CAPS.readStatus, CAPS.dropIndex],
        active: true,
      });
      const after = executorReadiness(fx.ops, ghost, CAPS.indexDoc);
      expect(after).toMatchObject({ ready: false, registered: false, active: false, hasCapability: false });
      expect(after.problems).toEqual(before.problems);
    } finally {
      (fx.ops.directory as { getSpecialist: unknown }).getSpecialist = saved;
    }
  });
});

/* ------------------------------------------------------------------ */
/* Medium 3 — the `witnessed` tri-state                                */
/* ------------------------------------------------------------------ */

const RUN_ROW: RunRow = {
  seq: 1,
  id: 'run-1',
  runKey: 'run:abcdef',
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
};

function runEvent(kind: RunEventRow['kind'], detail: Record<string, unknown>, over: Partial<RunEventRow> = {}): RunEventRow {
  return {
    seq: 0,
    id: 'e',
    runId: 'run-1',
    kind,
    actor: 'claude',
    at: '2026-09-01T00:00:01.000Z',
    processId: 'process-one',
    detail,
    attemptKey: null,
    ...over,
  };
}

describe('Medium 3: an UNCOMPUTED witness is not a witness', () => {
  const prefix = [
    runEvent('opened', {}, { seq: 1, id: 'e1' }),
    runEvent('attempt_started', { correlationId: 'run-1#1' }, { seq: 2, id: 'e2' }),
    runEvent('outcome_recorded', { outcome: 'outcome_unknown' }, { seq: 3, id: 'e3' }),
  ];
  const reconciliation = (over: Partial<RunEventRow>): RunEventRow =>
    runEvent(
      'reconciled',
      { decision: 'confirmed_not_executed', note: 'checked' },
      { seq: 4, id: 'e4', actor: 'attacker', ...over },
    );

  it('leaves the latch closed for every value of `witnessed` except a literal true', () => {
    // Measured against the head `85b720d` over this exact fold: absent, `null`
    // and `0` all gave `concluded / not_executed / admits=true / by=attacker /
    // nextGen=2`, against `witnessed=false` giving `needs_reconciliation /
    // outcome_unknown / admits=false / by=null`.
    for (const over of [
      { label: 'absent', patch: {} },
      { label: 'false', patch: { witnessed: false } },
      { label: 'null', patch: { witnessed: null as unknown as boolean } },
      { label: 'zero', patch: { witnessed: 0 as unknown as boolean } },
      { label: 'empty string', patch: { witnessed: '' as unknown as boolean } },
      { label: 'the string "true"', patch: { witnessed: 'true' as unknown as boolean } },
      { label: 'one', patch: { witnessed: 1 as unknown as boolean } },
    ]) {
      const events = [...prefix, reconciliation(over.patch)];
      const record = deriveRunRecord(RUN_ROW, events);
      expect(record.state, over.label).toBe('needs_reconciliation');
      expect(record.outcome, over.label).toBe('outcome_unknown');
      expect(record.needsReconciliation, over.label).toBe(true);
      expect(runAdmitsAttempt(record), over.label).toBe(false);
      expect(record.reconciliation, over.label).toBeNull();
      expect(runAttemptGeneration(events), over.label).toBe(1);
    }
  });

  it('still concludes on a literal true, or the latch would be unopenable', () => {
    const events = [...prefix, reconciliation({ witnessed: true })];
    const record = deriveRunRecord(RUN_ROW, events);
    expect(record.state).toBe('concluded');
    expect(record.outcome).toBe('not_executed');
    expect(runAdmitsAttempt(record)).toBe(true);
    expect(runAttemptGeneration(events)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Low 1 — the unreadable ceiling                                      */
/* ------------------------------------------------------------------ */

describe('Low 1: an unreadable ceiling is a Founder decision in every spelling', () => {
  it('refuses NaN, Infinity, a fraction, a negative and null identically', () => {
    for (const ceiling of [
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      -1,
      '100' as unknown as number,
    ]) {
      const evaluation = evaluateBudget({
        budget: { ceilingMinorUnits: ceiling, currency: 'ETB', permittedTiers: ['standard'] },
        entries: [],
      });
      const label = String(ceiling);
      expect(evaluation.decision, label).toBe('requires_founder_decision');
      expect(evaluation.permittedTiers, label).toEqual(['deterministic_local']);
      expect(evaluation.ceilingMinorUnits, label).toBeNull();
      expect(evaluation.grantsSpend, label).toBe(false);
      expect(evaluation.authorizesPaidActivation, label).toBe(false);
    }
  });

  it('still measures against a readable ceiling, including zero', () => {
    const within = evaluateBudget({
      budget: { ceilingMinorUnits: 10_000, currency: 'ETB', permittedTiers: ['standard'] },
      entries: [{ amountMinorUnits: 100, currency: 'ETB' }],
    });
    expect(within.decision).toBe('within_ceiling');
    expect(within.grantsSpend).toBe(false);
    const blocked = evaluateBudget({
      budget: { ceilingMinorUnits: 0, currency: 'ETB', permittedTiers: ['standard'] },
      entries: [{ amountMinorUnits: 1, currency: 'ETB' }],
    });
    expect(blocked.decision).toBe('blocked');
  });
});
