/**
 * Four High findings a hostile read-only review executed against `950a1b7`,
 * kept as regressions (Wave 5 correction round fifteen, High 3, High 5,
 * High 6, High 7).
 *
 * Three of the four were INTRODUCED BY THIS DIFF, and all four have the same
 * shape at the prose level: a docblock stated a property the code did not
 * have. So each test below asserts the BEHAVIOUR the sentence claims, and the
 * sentence itself is checked where it can be — a claim nobody measured is the
 * defect, not the symptom.
 *
 * Every number quoted at an assertion was measured on the frozen head before
 * the fix.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS, expectOk } from './application.fixture.js';
import { intelligenceFixture } from './intelligence.fixture.js';
import {
  INTELLIGENCE_TIERS,
  LOCAL_ONLY_TIER,
  PRIVACY_REQUIREMENTS,
  type IntelligenceTier,
} from '../src/application/intelligence-command.js';
import { authorizedAction, fakeAdapter, gatewayFixture, startedTask } from './action-gateway.fixture.js';
import {
  adapterContractProblems,
  sideEffectIdentityPayload,
  type ActionTypeContract,
} from '../src/application/action-gateway.js';
import { reliabilityFixture } from './reliability.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('local_only is a hard constraint, including when a tier is named (High 3)', () => {
  /** Local-only work whose own floor is the local tier: nothing else forces a climb. */
  function localOnlyWork(fx: ReturnType<typeof intelligenceFixture>) {
    return {
      taskId: fx.readOnlyClaim.taskId,
      workerId: fx.readOnlyClaim.workerId,
      fence: fx.readOnlyClaim.fence,
      label: 'summarise the payroll file',
      complexity: 'trivial' as const,
      contextSize: 'small' as const,
      workKind: 'summarization' as const,
      privacy: 'local_only' as const,
    };
  }

  it('refuses EVERY non-local tier, with every tier permitted and budget to spare', () => {
    // MEASURED ON THE FROZEN HEAD: `{"ok":true,"tier":"critical_review"}` with
    // `"privacy":"local_only"` on the hq_intel_decisions row.
    const nonLocal = INTELLIGENCE_TIERS.filter((tier) => tier !== LOCAL_ONLY_TIER);
    expect(nonLocal.length).toBeGreaterThan(0);
    for (const tier of nonLocal) {
      const fx = intelligenceFixture();
      fx.budget([...INTELLIGENCE_TIERS]);
      const recorded = fx.ops.recordIntelligenceDecision({
        ...localOnlyWork(fx),
        tier: tier as IntelligenceTier,
      });
      expect(recorded.ok, tier).toBe(false);
      if (!recorded.ok) expect(recorded.error.code, tier).toBe('privacy_requires_local');
      expect(
        (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_intel_decisions`).get() as { n: number }).n,
        tier,
      ).toBe(0);
    }
  });

  it('still records the local tier, so the constraint is a constraint and not a wall', () => {
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const recorded = expectOk(
      fx.ops.recordIntelligenceDecision({ ...localOnlyWork(fx), tier: LOCAL_ONLY_TIER }),
    );
    expect(recorded.decision.tier).toBe(LOCAL_ONLY_TIER);
  });

  it('refuses an ESCALATION out of local_only, which had no privacy input at all', () => {
    // The escalation path funnels through the same `#resolveRecordedTier`, and
    // `deriveEscalation` picks the cheapest HIGHER permitted tier — so before
    // the fix it was the second way past a constraint the code calls hard.
    const fx = intelligenceFixture();
    fx.budget([...INTELLIGENCE_TIERS]);
    const first = expectOk(
      fx.ops.recordIntelligenceDecision({ ...localOnlyWork(fx), tier: LOCAL_ONLY_TIER }),
    );
    const escalated = fx.ops.escalateIntelligenceDecision({
      decisionId: first.decision.id,
      workerId: fx.readOnlyClaim.workerId,
      fence: fx.readOnlyClaim.fence,
      trigger: 'insufficient_evidence',
    });
    expect(escalated.ok).toBe(false);
    // Named exactly: the escalation is refused because of PRIVACY, not because
    // some other guard happened to catch it. A refusal for the wrong reason is
    // how High 4 and Medium 4 in this same review were true verdicts resting
    // on false mechanisms.
    if (!escalated.ok) expect(escalated.error.code).toBe('privacy_requires_local');
    expect(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_intel_decisions`).get() as { n: number }).n,
    ).toBe(1);
  });

  it('names the admissible tier once, so the cap and the refusal cannot drift', () => {
    // The finding existed because `computeRoutingProposal` applied the privacy
    // cap and `#resolveRecordedTier` — "the one place a recorded tier is
    // checked against the policy" — never read `privacy`. Two spellings of one
    // rule. Asserted structurally: the vocabulary is closed, and the constant
    // both halves read is a member of it.
    expect([...PRIVACY_REQUIREMENTS]).toEqual(['unrestricted', 'local_only']);
    expect(INTELLIGENCE_TIERS).toContain(LOCAL_ONLY_TIER);
    const source = fs.readFileSync(
      path.join(HERE, '..', 'src', 'application', 'intelligence-command.ts'),
      'utf8',
    );
    // The cap reads the shared constant rather than a repeated literal.
    expect(source).toContain('tierRank(floorTier) > tierRank(LOCAL_ONLY_TIER)');
    expect(source).toContain('input.permittedTiers.includes(LOCAL_ONLY_TIER)');
  });
});

describe('a side effect is identified by what the adapter acts on (High 5)', () => {
  it('does not repeat a real external action for a payload field the adapter ignores', () => {
    // MEASURED ON THE FROZEN HEAD: `_nonce: 1|2|3` on the same task, adapter,
    // action type, target `issues/42` and text produced three distinct
    // `effect:…#1` keys and THREE adapter executions.
    const adapter = fakeAdapter();
    const fx = gatewayFixture({ adapter });
    const started = startedTask(fx, { capabilityId: CAPS.indexDoc, worker: 'claude' });
    const outcomes: string[] = [];
    for (const nonce of [1, 2, 3]) {
      const proposed = expectOk(
        fx.ops.proposeAction({
          taskId: started.taskId,
          adapterId: adapter.id,
          actionType: 'post_comment',
          target: 'issues/42',
          payload: { text: 'the same comment', _nonce: nonce },
          requestedBy: 'founder',
        }),
      ).action;
      expectOk(
        fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }),
      );
      const executed = fx.ops.executeAction({
        actionId: proposed.id,
        workerId: 'claude',
        fence: started.fence,
      });
      outcomes.push(executed.ok ? executed.data.outcome : executed.error.code);
    }
    expect(outcomes).toEqual(['succeeded', 'duplicate_external_action', 'duplicate_external_action']);
    expect(adapter.calls).toHaveLength(1);
    // ONE reserved key, by unique index, so the refusal holds across processes.
    const keys = fx.db
      .prepare(`SELECT DISTINCT side_effect_key FROM hq_action_events WHERE side_effect_key IS NOT NULL`)
      .all() as { side_effect_key: string }[];
    expect(keys).toHaveLength(1);
  });

  it('still tells two genuinely different acts apart', () => {
    // The latch must not collapse into "one comment per issue, ever". A
    // DECLARED field that differs is a different act and executes.
    const adapter = fakeAdapter();
    const fx = gatewayFixture({ adapter });
    const started = startedTask(fx, { capabilityId: CAPS.indexDoc, worker: 'claude' });
    for (const text of ['first comment', 'second comment']) {
      const proposed = expectOk(
        fx.ops.proposeAction({
          taskId: started.taskId,
          adapterId: adapter.id,
          actionType: 'post_comment',
          target: 'issues/42',
          payload: { text },
          requestedBy: 'founder',
        }),
      ).action;
      expectOk(
        fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }),
      );
      expect(
        expectOk(
          fx.ops.executeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }),
        ).outcome,
      ).toBe('succeeded');
    }
    expect(adapter.calls).toHaveLength(2);
  });

  it('refuses AT CONSTRUCTION any action HQ cannot walk back that does not say what it acts on', () => {
    // Derived over the whole visibility x reversibility space rather than the
    // one shape the review used: the requirement is "not both internal and
    // reversible", so every other combination must be refused when the
    // declaration is missing and accepted when it is present.
    const combinations: { visibility: ActionTypeContract['visibility']; reversibility: ActionTypeContract['reversibility'] }[] =
      [];
    for (const visibility of ['internal', 'external', 'public'] as const) {
      for (const reversibility of ['reversible', 'compensable', 'irreversible'] as const) {
        combinations.push({ visibility, reversibility });
      }
    }
    expect(combinations).toHaveLength(9);
    for (const { visibility, reversibility } of combinations) {
      const compensation =
        reversibility === 'irreversible'
          ? null
          : { supported: true as const, method: 'undo', description: 'undoes it' };
      const undeclared = fakeAdapter({
        id: 'fake.undeclared',
        actions: { act: { description: 'x', visibility, reversibility, compensation } },
      });
      const problems = adapterContractProblems(undeclared).filter((problem) =>
        problem.includes('sideEffectIdentityFields'),
      );
      const walkBackable = visibility === 'internal' && reversibility === 'reversible';
      expect(problems.length, `${visibility}/${reversibility}`).toBe(walkBackable ? 0 : 1);

      const declared = fakeAdapter({
        id: 'fake.declared',
        actions: {
          act: { description: 'x', visibility, reversibility, compensation, sideEffectIdentityFields: ['text'] },
        },
      });
      expect(
        adapterContractProblems(declared).filter((problem) => problem.includes('sideEffectIdentityFields')),
        `${visibility}/${reversibility}`,
      ).toEqual([]);
    }
  });

  it('projects only the declared fields, keeping absent and null distinguishable', () => {
    expect(sideEffectIdentityPayload({ text: 'a', _nonce: 1 }, ['text'])).toEqual({ text: 'a' });
    expect(sideEffectIdentityPayload({ text: 'a' }, [])).toEqual({});
    expect(sideEffectIdentityPayload({ text: null }, ['text'])).toEqual({ text: null });
    // A declared field the payload does not carry is ABSENT, not `undefined`:
    // "no such field" and "the field is null" are different acts.
    expect(Object.prototype.hasOwnProperty.call(sideEffectIdentityPayload({}, ['text']), 'text')).toBe(false);
    // No declaration => the whole payload, which is the documented
    // internal/reversible fallback rather than an accident.
    expect(sideEffectIdentityPayload({ text: 'a', _nonce: 1 }, undefined)).toEqual({ text: 'a', _nonce: 1 });
  });
});

describe('a privileged mutation and its evidence commit together (High 6)', () => {
  /**
   * Refuse exactly one evidence kind at the ENGINE, which is how the review
   * produced the split: the row write succeeds, the append aborts.
   */
  function refuseEvidenceKind(db: { exec: (sql: string) => unknown }, kind: string): void {
    db.exec(
      `CREATE TRIGGER refuse_${kind} BEFORE INSERT ON op_evidence
       WHEN NEW.kind = '${kind}'
       BEGIN SELECT RAISE(ABORT, 'the store refused ${kind}'); END;`,
    );
  }

  it('leaves the kill switch ENGAGED when it says the kill switch is still engaged', () => {
    // MEASURED ON THE FROZEN HEAD: the call said `operator_rejected … the kill
    // switch is STILL engaged` while `op_kill_switch.engaged = 0`,
    // `killSwitchEngaged` read false, a task queued and `claimNext` CLAIMED,
    // with no `kill_switch_released` evidence anywhere. The message was the
    // exact opposite of the truth, on the one control a Founder reaches for in
    // a hurry to stop everything.
    const fx = reliabilityFixture();
    expectOk(fx.ops.engageKillSwitch(CAPS.openPr, 'founder', 'stop everything'));
    refuseEvidenceKind(fx.db, 'kill_switch_released');

    const released = fx.ops.releaseKillSwitch(CAPS.openPr, 'founder');
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.error.message).toContain('STILL engaged');
    // ...and it IS still engaged, in the row, in the read, and in behaviour.
    expect(
      (fx.db.prepare(`SELECT engaged FROM op_kill_switch WHERE scope = ?`).get(CAPS.openPr) as {
        engaged: number;
      }).engaged,
    ).toBe(1);
    expect(fx.ops.queue.killSwitchEngaged(CAPS.openPr)).toBe(true);
    expect(
      (fx.db
        .prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'kill_switch_released'`)
        .get() as { n: number }).n,
    ).toBe(0);
  });

  it('leaves the kill switch RELEASED when the engage evidence cannot be written', () => {
    // The mirror image, because the pair is what the fix is about: an engage
    // that could not be recorded must not be believed either.
    const fx = reliabilityFixture();
    refuseEvidenceKind(fx.db, 'kill_switch_engaged');
    const engaged = fx.ops.engageKillSwitch(CAPS.openPr, 'founder', 'stop everything');
    expect(engaged.ok).toBe(false);
    expect(fx.ops.queue.killSwitchEngaged(CAPS.openPr)).toBe(false);
    expect(
      fx.db.prepare(`SELECT engaged FROM op_kill_switch WHERE scope = ?`).get(CAPS.openPr) ?? null,
    ).toBeNull();
  });

  it('rolls back the APPROVAL row when its evidence cannot be written', () => {
    // Derived rather than named: the wrapper is applied at the one place the
    // privileged API is issued, so every mutation on that surface has this
    // property. `approve` is checked because its split would leave a task
    // queued with an approval row nothing in the audit log accounts for.
    const fx = reliabilityFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { document: 'doc-1' },
        idempotencyKey: 'approve-atomicity',
        requestedBy: 'claude',
      }),
    );
    expect(created.task.status).toBe('needs_approval');
    refuseEvidenceKind(fx.db, 'founder_approved');
    const approvalsBefore = (
      fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }
    ).n;

    const approved = fx.ops.approveTask({
      taskId: created.task.id,
      founderId: 'founder',
      expectedActionDigest: taskActionDigest(created.task),
    });
    // The refusal must be the APPEND failing, not an earlier guard — a test
    // that never reached the write would prove nothing about atomicity.
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.error.code).toBe('operator_rejected');
      expect(approved.error.message).toContain('founder_approved');
    }
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }).n).toBe(
      approvalsBefore,
    );
    expect(fx.ops.queue.get(created.task.id)!.status).toBe('needs_approval');
  });
});

describe('an unreadable payload is refused, never executed as an empty one (High 7)', () => {
  it('refuses BOTH authorization and execution of an intent whose payload does not parse', () => {
    // MEASURED ON THE FROZEN HEAD: a raw INSERT of a corrupt-payload intent
    // authorized and executed, and the adapter received `payload: {}` against
    // a real target of `issues/7`. The docblock claimed "an intent whose
    // payload reads as `{}` no longer matches its own stored `payload_digest`,
    // so every path that acts on a payload refuses it" — and
    // `actionPayloadDigest` had exactly one call site in the package, the one
    // that WRITES the row. Nothing recomputed it.
    const adapter = fakeAdapter();
    const fx = gatewayFixture({ adapter });
    const started = startedTask(fx, { capabilityId: CAPS.indexDoc, worker: 'claude' });
    const real = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: adapter.id,
        actionType: 'post_comment',
        target: 'issues/7',
        payload: { text: 'the real comment' },
        requestedBy: 'founder',
      }),
    ).action;
    const row = fx.db
      .prepare(`SELECT * FROM hq_action_intents WHERE id = ?`)
      .get(real.id) as Record<string, unknown>;

    const corruptId = 'act-corrupt-1';
    fx.db
      .prepare(
        `INSERT INTO hq_action_intents (id, task_id, mission_id, capability_id, provider_id, adapter_id, action_type,
           target, payload, payload_digest, risk_level, risk_factors, visibility, reversibility, compensation,
           context_evidence_refs, context_truth_refs, requested_by, requested_at, side_effect_key_base, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        corruptId,
        row.task_id,
        row.mission_id,
        row.capability_id,
        row.provider_id,
        row.adapter_id,
        row.action_type,
        row.target,
        // What a JS `String(object)` in a JSON column actually looks like.
        '[object Object]',
        row.payload_digest,
        row.risk_level,
        row.risk_factors,
        row.visibility,
        row.reversibility,
        row.compensation,
        row.context_evidence_refs,
        row.context_truth_refs,
        row.requested_by,
        row.requested_at,
        `${String(row.side_effect_key_base)}:corrupt`,
        `${String(row.idempotency_key)}:corrupt`,
      );
    fx.db
      .prepare(
        `INSERT INTO hq_action_events (id, action_id, state, actor, at, detail, side_effect_key)
         VALUES (?, ?, 'proposed', 'founder', ?, '{}', NULL)`,
      )
      .run('ev-corrupt-proposed', corruptId, new Date().toISOString());

    const authorized = fx.ops.authorizeAction({
      actionId: corruptId,
      workerId: 'claude',
      fence: started.fence,
    });
    expect(authorized.ok).toBe(false);
    if (!authorized.ok) expect(authorized.error.code).toBe('action_digest_mismatch');

    const executed = fx.ops.executeAction({
      actionId: corruptId,
      workerId: 'claude',
      fence: started.fence,
    });
    expect(executed.ok).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });

  it('leaves a HEALTHY intent executable, so the check is a check and not a wall', () => {
    const adapter = fakeAdapter();
    const fx = gatewayFixture({ adapter });
    const started = startedTask(fx, { capabilityId: CAPS.indexDoc, worker: 'claude' });
    const actionId = authorizedAction(fx, started);
    expect(
      expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence })).outcome,
    ).toBe('succeeded');
    expect(adapter.calls).toHaveLength(1);
  });
});
