/**
 * Phase 8 — the authority/risk/external-action gateway, HOSTILE.
 *
 * What this suite pins, rule by rule: the risk engine is categorical and can
 * only be escalated; proposals need a resolved, granted actor and a declared
 * adapter; a bound provider is never substituted; the Intent Guard refuses a
 * stale approval, a changed action, a moved provider, a changed mission intent
 * and a blocked mission; the same external side effect is attempted ONCE; an
 * unknown outcome stays unknown and is never retried automatically; every
 * kill-switch scope stops execution and a forged public delegate cannot lift
 * it; risk escalation adds an approval requirement and never removes one; no
 * party approves its own external action; authority is the INTERSECTION of
 * worker grant, mission state, policy and approval; adapter failures record
 * truthful terminal states; no secret reaches the ledger or the evidence chain;
 * and the existing Claude dispatch lane and the gateway exclude each other.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import {
  FAKE_ACTIONS,
  authorizedAction,
  count,
  errorCode,
  fakeAdapter,
  gatewayFixture,
  startedTask,
} from './action-gateway.fixture.js';
import {
  ACTION_RISK_LEVELS,
  EXTERNAL_ACTION_KILL_SCOPE,
  adapterContractProblems,
  adapterKillSwitchScope,
  assessActionRisk,
  providerKillSwitchScope,
  riskRequiresApproval,
} from '../src/application/action-gateway.js';
import { HeadquarterOperations, gatewayActionHistoryFor, writeDispatchOutcome } from '../src/application/service.js';
import { assertBrowserSafe } from '../src/live/redaction.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { OperatorQueue } from '../src/operator/queue.js';
import { openMemoryHqDatabase } from '../src/store/db.js';
import { claudeDispatchEligibility } from '../src/providers/claude/dispatch.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';

describe('the risk engine is categorical, deterministic and monotone', () => {
  const base = { capability: { riskClass: 'reversible' as const, sideEffect: false }, escalations: {} };

  it('grades the three fake contracts low / medium / high with named factors, never numbers', () => {
    expect(assessActionRisk({ ...base, contract: FAKE_ACTIONS.write_note! })).toEqual({ level: 'low', factors: [] });
    const comment = assessActionRisk({ ...base, contract: FAKE_ACTIONS.post_comment! });
    expect(comment.level).toBe('medium');
    expect(comment.factors).toEqual(['external_visibility', 'compensable_only']);
    const release = assessActionRisk({ ...base, contract: FAKE_ACTIONS.publish_release! });
    expect(release.level).toBe('critical');
    expect(release.factors).toContain('public_and_irreversible');
    for (const factor of [...comment.factors, ...release.factors]) expect(factor).toMatch(/^[a-z_]+$/);
    expect(ACTION_RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('escalations only ever RAISE the level; the canonical capability class sets the floor', () => {
    const low = assessActionRisk({ ...base, contract: FAKE_ACTIONS.write_note! });
    const prod = assessActionRisk({ ...base, contract: FAKE_ACTIONS.write_note!, escalations: { productionScope: true } });
    expect(prod.level).toBe('critical');
    expect(prod.factors).toEqual(['production_scope']);
    const spend = assessActionRisk({ ...base, contract: FAKE_ACTIONS.write_note!, escalations: { spend: true } });
    expect(spend.level).toBe('critical');
    const many = assessActionRisk({ ...base, contract: FAKE_ACTIONS.write_note!, escalations: { blastRadius: 'many' } });
    expect(many.level).toBe('high');
    // A declared `single` blast radius does NOT lower a critical contract.
    const still = assessActionRisk({ ...base, contract: FAKE_ACTIONS.publish_release!, escalations: { blastRadius: 'single' } });
    expect(still.level).toBe('critical');
    // The capability row's class is a floor the contract cannot dig under.
    const destructive = assessActionRisk({
      capability: { riskClass: 'destructive', sideEffect: true },
      contract: FAKE_ACTIONS.write_note!,
      escalations: {},
    });
    expect(destructive.level).toBe('high');
    expect(destructive.factors).toEqual(['side_effect', 'capability_destructive']);
    expect(low.level).toBe('low');
    // Same inputs, same answer.
    expect(assessActionRisk({ ...base, contract: FAKE_ACTIONS.post_comment! })).toEqual(
      assessActionRisk({ ...base, contract: FAKE_ACTIONS.post_comment! }),
    );
    expect(riskRequiresApproval('low')).toBe(false);
    expect(riskRequiresApproval('medium')).toBe(false);
    expect(riskRequiresApproval('high')).toBe(true);
    expect(riskRequiresApproval('critical')).toBe(true);
  });

  it('refuses an adapter that promises reversibility without a compensation, at construction', () => {
    const lying = fakeAdapter({
      id: 'fake.lying',
      actions: {
        undo_me: { description: 'x', visibility: 'internal', reversibility: 'reversible', compensation: null },
      },
    });
    expect(adapterContractProblems(lying)).toEqual([
      'action type undo_me: declares reversible without a compensation — reversibility is never promised without a declared method',
    ]);
    expect(() => new HeadquarterOperations(openMemoryHqDatabase(), { actionAdapters: [lying] })).toThrow(/invalid contract/);
    const irreversibleWithUndo = fakeAdapter({
      id: 'fake.contradiction',
      actions: {
        x: {
          description: 'x',
          visibility: 'public',
          reversibility: 'irreversible',
          compensation: { supported: true, method: 'y', description: 'z' },
          // Declared so this stays a ONE-problem contract: the contradiction
          // under test, and not also the missing side-effect identity a
          // public/irreversible action type is now required to state (Wave 5
          // correction round fifteen, High 5).
          sideEffectIdentityFields: [],
        },
      },
    });
    expect(adapterContractProblems(irreversibleWithUndo)).toHaveLength(1);
  });
});

describe('proposing: identity, grant, adapter, provider, references', () => {
  it('refuses system, an unknown actor and an ungranted principal; writes nothing', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    for (const [requestedBy, code] of [
      ['system', 'not_permitted'],
      ['nobody', 'unknown_principal'],
      ['analyst', 'not_permitted'], // registered, holds readStatus only
    ] as const) {
      const result = fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 't',
        payload: {},
        requestedBy,
      });
      expect(errorCode(result), requestedBy).toBe(code);
    }
    expect(count(fx, 'hq_action_intents')).toBe(0);
  });

  it('refuses an unknown adapter or action type, a malformed type, an oversized target and a credential-like payload', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const propose = (over: Record<string, unknown>) =>
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 't',
        payload: { text: 'x' },
        requestedBy: 'founder',
        ...over,
      });
    expect(errorCode(propose({ adapterId: 'fake.other' }))).toBe('unknown_adapter');
    expect(errorCode(propose({ actionType: 'delete_everything' }))).toBe('unknown_adapter');
    expect(errorCode(propose({ actionType: 'Not Valid' }))).toBe('invalid_input');
    expect(errorCode(propose({ target: 'x'.repeat(501) }))).toBe('invalid_input');
    expect(errorCode(propose({ payload: { token: 'abcd1234efgh5678' } }))).toBe('invalid_input');
    expect(errorCode(propose({ payload: [1, 2] as unknown as Record<string, unknown> }))).toBe('invalid_input');
    expect(count(fx, 'hq_action_intents')).toBe(0);
  });

  it('never substitutes a provider: a CLAUDE-bound task refuses a CODEX adapter and a local adapter alike', () => {
    const claude = fakeAdapter({ id: 'fake.claude', provider: 'CLAUDE' });
    const codex = fakeAdapter({ id: 'fake.codex', provider: 'CODEX' });
    const local = fakeAdapter({ id: 'fake.local', provider: null });
    const fx = gatewayFixture({ adapters: [claude, codex, local], adapter: claude });
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'coo' }));
    const started = startedTask(fx, { payload: { document: 'd', executionProvider: 'CLAUDE' } });
    const propose = (adapterId: string) =>
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId,
        actionType: 'write_note',
        target: 't',
        payload: {},
        requestedBy: 'founder',
      });
    expect(errorCode(propose('fake.codex'))).toBe('provider_binding_mismatch');
    expect(errorCode(propose('fake.local'))).toBe('provider_binding_mismatch');
    const bound = expectOk(propose('fake.claude')).action;
    expect(bound.providerId).toBe('CLAUDE');
    expect(count(fx, 'hq_action_intents')).toBe(1);
  });

  it('context refs must name real evidence and real truth; memory and truth inform and grant nothing', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const evidenceId = fx.ops.queue.evidence.list(started.taskId)[0]!.id;
    const missingEvidence = fx.ops.proposeAction({
      taskId: started.taskId,
      adapterId: 'fake.local',
      actionType: 'write_note',
      target: 't',
      payload: {},
      contextEvidenceRefs: [evidenceId, 'ev-does-not-exist'],
      requestedBy: 'founder',
    });
    expect(errorCode(missingEvidence)).toBe('unknown_evidence');
    const missingTruth = fx.ops.proposeAction({
      taskId: started.taskId,
      adapterId: 'fake.local',
      actionType: 'write_note',
      target: 't',
      payload: {},
      contextTruthRefs: ['truth-does-not-exist'],
      requestedBy: 'founder',
    });
    expect(errorCode(missingTruth)).toBe('unknown_truth');
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 't',
        payload: {},
        contextEvidenceRefs: [evidenceId],
        requestedBy: 'founder',
      }),
    ).action;
    expect(proposed.contextEvidenceRefs).toEqual([evidenceId]);
    // The referenced evidence is referenced, not copied, and the proposal
    // executed nothing: the task and its claim are exactly as they were.
    const task = fx.ops.queue.get(started.taskId)!;
    expect(task.status).toBe('running');
    expect(task.fence).toBe(started.fence);
    expect(fx.adapter.calls).toHaveLength(0);
  });

  it('dedupes an identical proposal and keeps a deliberately fresh one apart', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const input = {
      taskId: started.taskId,
      adapterId: 'fake.local',
      actionType: 'write_note',
      target: 't',
      payload: { text: 'same' },
      requestedBy: 'founder',
    };
    const first = expectOk(fx.ops.proposeAction(input));
    const again = expectOk(fx.ops.proposeAction({ ...input, payload: { text: 'same' } }));
    expect(again.deduplicated).toBe(true);
    expect(again.action.id).toBe(first.action.id);
    const fresh = expectOk(fx.ops.proposeAction({ ...input, idempotencyKey: 'second-try' }));
    expect(fresh.deduplicated).toBe(false);
    expect(fresh.action.id).not.toBe(first.action.id);
    expect(count(fx, 'hq_action_intents')).toBe(2);
  });
});

describe('the recorded arc: proposed → authorized → attempted → succeeded', () => {
  it('walks the ledger once, calls the adapter exactly once with a correlation id, and exposes no payload body', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'post_comment',
        target: 'issue/7',
        payload: { text: 'a comment' },
        requestedBy: 'founder',
      }),
    ).action;
    expect(proposed.state).toBe('proposed');
    expect(proposed.riskLevel).toBe('medium');
    expect(proposed.reversibility).toBe('compensable');
    expect(proposed.compensation?.method).toBe('delete_comment');
    expect('payload' in proposed).toBe(false);
    expect(proposed.payloadDigest).toMatch(/^[a-f0-9]{64}$/);

    const authorized = expectOk(
      fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }),
    ).action;
    expect(authorized.state).toBe('authorized');
    expect(authorized.authorization?.approvalId).toBeTruthy();
    expect(authorized.authorization?.by).toBe('claude');
    // Authorizing twice is refused: the snapshot is written once.
    expect(errorCode(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }))).toBe(
      'action_state_conflict',
    );
    // Executing before authorization is refused too.
    const other = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 'n',
        payload: {},
        requestedBy: 'founder',
      }),
    ).action;
    expect(errorCode(fx.ops.executeAction({ actionId: other.id, workerId: 'claude', fence: started.fence }))).toBe(
      'action_state_conflict',
    );

    const executed = expectOk(fx.ops.executeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }));
    expect(executed.outcome).toBe('succeeded');
    expect(executed.action.state).toBe('succeeded');
    expect(executed.action.events.map((e) => e.state)).toEqual(['proposed', 'authorized', 'attempted', 'succeeded']);
    expect(executed.action.attempt?.correlationId).toBe(`${proposed.id}#1`);
    expect(executed.action.outcome?.externalRef).toEqual({ noteId: 'n-1' });
    expect(fx.adapter.calls).toHaveLength(1);
    expect(fx.adapter.calls[0]).toMatchObject({
      actionId: proposed.id,
      taskId: started.taskId,
      actionType: 'post_comment',
      target: 'issue/7',
      payload: { text: 'a comment' },
      correlationId: `${proposed.id}#1`,
    });
    // A terminal action is never re-executed.
    expect(errorCode(fx.ops.executeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }))).toBe(
      'action_state_conflict',
    );
    expect(fx.adapter.calls).toHaveLength(1);
    // Evidence: the chain grew by the gateway entries and is intact; the task itself did not move.
    const kinds = fx.ops.queue.evidence.list(started.taskId).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['action_proposed', 'action_authorized', 'action_attempted', 'action_succeeded']));
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
    expect(fx.ops.queue.get(started.taskId)!.status).toBe('running');
  });

  it('records adapter rejection and unavailability as a truthful terminal `failed`, retry-blocked', () => {
    for (const mode of ['reject', 'unavailable'] as const) {
      const fx = gatewayFixture({ adapter: fakeAdapter({ mode }) });
      const started = startedTask(fx);
      const actionId = authorizedAction(fx, started);
      const executed = expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
      expect(executed.outcome).toBe('failed');
      expect(executed.action.state).toBe('failed');
      expect(executed.action.outcome?.message).toMatch(/remote/);
      expect(executed.action.retryBlocked).toBe(true);
      expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('action_state_conflict');
      expect(fx.adapter.calls).toHaveLength(1);
    }
  });
});

describe('the Intent Guard refuses stale or changed authority', () => {
  it('a Founder approval that expired after authorization refuses execution', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx, { ttlMs: 60_000 });
    const actionId = authorizedAction(fx, started);
    const later = new Date(Date.now() + 61_000);
    const result = fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence, now: later });
    expect(errorCode(result)).toBe('action_approval_stale');
    expect(fx.adapter.calls).toHaveLength(0);
    expect(fx.ops.getAction(actionId)!.state).toBe('authorized');
    expect(fx.ops.queue.evidence.list(started.taskId).some((e) => e.kind === 'action_refused')).toBe(true);
  });

  it('a task payload mutated after authorization refuses with a digest mismatch', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    fx.db.prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`).run(JSON.stringify({ document: 'swapped' }), started.taskId);
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('action_digest_mismatch');
    expect(fx.adapter.calls).toHaveLength(0);
  });

  it('a provider adapter executes only for a worker DECLARED as that provider; declaration moved after authorization refuses', () => {
    const claude = fakeAdapter({ id: 'fake.claude', provider: 'CLAUDE' });
    const fx = gatewayFixture({ adapters: [claude], adapter: claude });
    const started = startedTask(fx); // unbound task
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.claude',
        actionType: 'write_note',
        target: 't',
        payload: {},
        requestedBy: 'founder',
      }),
    ).action;
    // Undeclared worker: refused, not guessed from its vendor string.
    expect(errorCode(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }))).toBe(
      'provider_binding_mismatch',
    );
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'coo' }));
    expectOk(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }));
    // Redeclared as another provider between authorization and execution.
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CODEX', founderId: 'coo' }));
    expect(errorCode(fx.ops.executeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }))).toBe(
      'provider_binding_mismatch',
    );
    expect(claude.calls).toHaveLength(0);
  });

  it('a mission intent amended after authorization refuses; a blocked mission refuses', () => {
    const fx = gatewayFixture();
    registerMissionCommandCapability(fx.db);
    registerMissionOrchestrateCapability(fx.db);
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [CAPS.readStatus, CAPS.indexDoc, MISSION_COMMAND_CAPABILITY.id, MISSION_ORCHESTRATE_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const mission = expectOk(
      fx.ops.commandMission({
        title: 'Notes',
        objective: 'Write the board note',
        constraints: ['Do not publish externally'],
        plan: [{ summary: 'Write it', capabilityId: CAPS.readStatus, payload: { intent: 'go' } }],
        requestedBy: 'founder',
      }),
    ).mission;
    expectOk(fx.ops.orchestrateMission({ missionId: mission.id, mode: 'apply', requestedBy: 'founder' }));
    const taskId = fx.ops.getMission(mission.id)!.planItems[0]!.taskId!;
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, taskId));
    expectOk(fx.ops.startTask(taskId, 'claude', claimed.fence));
    // A mission the task is NOT linked to is refused at proposal.
    const otherMission = expectOk(
      fx.ops.commandMission({ title: 'Other', objective: 'Other', requestedBy: 'founder' }),
    ).mission;
    expect(
      errorCode(
        fx.ops.proposeAction({
          taskId,
          adapterId: 'fake.local',
          actionType: 'write_note',
          target: 't',
          payload: {},
          missionId: otherMission.id,
          requestedBy: 'founder',
        }),
      ),
    ).toBe('invalid_input');
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 't',
        payload: {},
        missionId: mission.id,
        requestedBy: 'founder',
      }),
    ).action;
    expectOk(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: claimed.fence }));
    expectOk(
      fx.ops.amendMissionIntent({
        missionId: mission.id,
        amendment: 'Tighten the do-not list after review.',
        constraints: ['Do not publish externally', 'Do not mention pricing'],
        requestedBy: 'founder',
      }),
    );
    const changed = fx.ops.executeAction({ actionId: proposed.id, workerId: 'claude', fence: claimed.fence });
    expect(errorCode(changed)).toBe('intent_changed');
    if (!changed.ok) expect(changed.error.details?.changed).toEqual(['missionIntentSeq']);
    expect(fx.adapter.calls).toHaveLength(0);
    // A NEW proposal against the current intent is the only way forward — and
    // a blocked mission directs no external action at all.
    const second = expectOk(
      fx.ops.proposeAction({
        taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 't',
        payload: {},
        missionId: mission.id,
        requestedBy: 'founder',
        idempotencyKey: 'after-amendment',
      }),
    ).action;
    expectOk(fx.ops.authorizeAction({ actionId: second.id, workerId: 'claude', fence: claimed.fence }));
    expectOk(fx.ops.transitionMission({ missionId: mission.id, to: 'blocked', note: 'Founder hold', requestedBy: 'founder' }));
    expect(errorCode(fx.ops.executeAction({ actionId: second.id, workerId: 'claude', fence: claimed.fence }))).toBe('mission_not_active');
    expect(fx.adapter.calls).toHaveLength(0);
  });
});

describe('duplicate side effects and unknown outcomes', () => {
  it('the same external side effect is attempted once across two different action intents', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const a = authorizedAction(fx, started);
    const b = authorizedAction(fx, started, { idempotencyKey: 'b' });
    expect(a).not.toBe(b);
    expectOk(fx.ops.executeAction({ actionId: a, workerId: 'claude', fence: started.fence }));
    const dup = fx.ops.executeAction({ actionId: b, workerId: 'claude', fence: started.fence });
    expect(errorCode(dup)).toBe('duplicate_external_action');
    if (!dup.ok) expect(dup.error.details?.holderActionId).toBe(a);
    expect(fx.adapter.calls).toHaveLength(1);
    expect(fx.ops.getAction(b)!.state).toBe('authorized');
    // The engine itself holds the line: a forged second attempt row with the same key is refused.
    const key = (fx.db.prepare(`SELECT side_effect_key FROM hq_action_events WHERE state = 'attempted'`).get() as { side_effect_key: string })
      .side_effect_key;
    expect(() =>
      fx.db
        .prepare(`INSERT INTO hq_action_events (id, action_id, state, actor, at, detail, side_effect_key) VALUES ('x', ?, 'attempted', 'x', 'now', '{}', ?)`)
        .run(b, key),
    ).toThrow(/UNIQUE/);
  });

  it('an unknown outcome stays unknown, is never retried automatically, and only an independent principal reconciles it', () => {
    const fx = gatewayFixture({ adapter: fakeAdapter({ mode: 'unknown' }) });
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    const first = expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expect(first.outcome).toBe('outcome_unknown');
    expect(first.action.state).toBe('outcome_unknown');
    expect(first.action.retryBlocked).toBe(true);
    fx.adapter.mode = 'succeed';
    const retry = fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence });
    expect(errorCode(retry)).toBe('action_outcome_unknown');
    expect(fx.adapter.calls).toHaveLength(1);
    // A second identical proposal dedupes onto the SAME unknown action — no fresh generation opens on uncertainty.
    const again = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 'notes/board',
        payload: { text: 'hello' },
        requestedBy: 'founder',
      }),
    );
    expect(again.deduplicated).toBe(true);
    expect(again.action.id).toBe(actionId);
    // Reconciliation authority: system, the worker, an observer and the PROPOSER are refused.
    fx.principals.register({ id: 'observer', displayName: 'Observer', originateCapabilities: [], approvalAuthority: false, active: true });
    for (const [by, code] of [
      ['system', 'not_permitted'],
      ['claude', 'not_permitted'],
      ['observer', 'not_permitted'],
      ['nobody', 'not_permitted'],
      ['founder', 'not_permitted'], // the proposer
    ] as const) {
      const refused = fx.ops.reconcileAction({ actionId, decision: 'confirmed_failed', note: 'checked', requestedBy: by });
      expect(errorCode(refused), by).toBe(code);
    }
    expect(fx.ops.getAction(actionId)!.state).toBe('outcome_unknown');
    // indexDoc is NOT idempotent: it cannot be reopened for another attempt.
    expect(
      errorCode(fx.ops.reconcileAction({ actionId, decision: 'confirmed_not_executed', note: 'checked', requestedBy: 'coo' })),
    ).toBe('not_permitted');
    const reconciled = expectOk(
      fx.ops.reconcileAction({ actionId, decision: 'confirmed_failed', note: 'Checked the remote log: nothing landed.', requestedBy: 'coo' }),
    ).action;
    expect(reconciled.state).toBe('reconciled');
    expect(reconciled.reconciliation).toMatchObject({ by: 'coo', decision: 'confirmed_failed' });
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('action_state_conflict');
    expect(errorCode(fx.ops.reconcileAction({ actionId, decision: 'confirmed_failed', note: 'again', requestedBy: 'coo' }))).toBe(
      'action_state_conflict',
    );
    expect(fx.adapter.calls).toHaveLength(1);
  });

  it('an adapter that THROWS is an unknown outcome, not a failure', () => {
    const fx = gatewayFixture({ adapter: fakeAdapter({ mode: 'throw' }) });
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    const result = expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.action.outcome?.message).toMatch(/adapter threw/);
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('action_outcome_unknown');
  });

  it('confirmed_not_executed on an IDEMPOTENT capability opens exactly one fresh generation, as a new proposal', () => {
    const fx = gatewayFixture({ adapter: fakeAdapter({ mode: 'unknown' }) });
    const started = startedTask(fx, { capabilityId: CAPS.openPr, payload: { branch: 'b' } });
    const actionId = authorizedAction(fx, started);
    expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expectOk(fx.ops.reconcileAction({ actionId, decision: 'confirmed_not_executed', note: 'Nothing on the remote.', requestedBy: 'coo' }));
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
    expect(fresh.action.id).not.toBe(actionId);
    expectOk(fx.ops.authorizeAction({ actionId: fresh.action.id, workerId: 'claude', fence: started.fence }));
    const executed = expectOk(fx.ops.executeAction({ actionId: fresh.action.id, workerId: 'claude', fence: started.fence }));
    expect(executed.outcome).toBe('succeeded');
    expect(executed.action.attempt?.generation).toBe(2);
    expect(fx.adapter.calls).toHaveLength(2);
    expect(fx.adapter.calls[1]!.sideEffectKey).toMatch(/#2$/);
    // The original, reconciled action never runs again.
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('action_state_conflict');
  });
});

describe('kill switches stop the gateway at every scope, and a forged delegate cannot lift them', () => {
  const scopes = (adapterId: string, capabilityId: string) => [
    ['global', '*'],
    ['capability', capabilityId],
    ['external action', EXTERNAL_ACTION_KILL_SCOPE],
    ['adapter', adapterKillSwitchScope(adapterId)],
  ];

  it('refuses execution under each scope, then resumes once released', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    for (const [name, scope] of scopes('fake.local', CAPS.indexDoc)) {
      expectOk(fx.ops.engageKillSwitch(scope!, 'founder', `${name} stop`));
      const result = fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence });
      expect(errorCode(result), name).toBe('kill_switch_engaged');
      if (!result.ok) expect(result.error.details?.scope).toBe(scope);
      expectOk(fx.ops.releaseKillSwitch(scope!, 'founder'));
    }
    expect(fx.adapter.calls).toHaveLength(0);
    expect(fx.ops.getAction(actionId)!.state).toBe('authorized');
    expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expect(fx.adapter.calls).toHaveLength(1);
  });

  it('a provider scope stops every adapter executing as that provider', () => {
    const claude = fakeAdapter({ id: 'fake.claude', provider: 'CLAUDE' });
    const fx = gatewayFixture({ adapters: [claude], adapter: claude });
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'coo' }));
    const started = startedTask(fx, { payload: { document: 'd', executionProvider: 'CLAUDE' } });
    const actionId = authorizedAction(fx, started, { adapterId: 'fake.claude' });
    expectOk(fx.ops.engageKillSwitch(providerKillSwitchScope('CLAUDE'), 'founder', 'provider stop'));
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('kill_switch_engaged');
    expect(claude.calls).toHaveLength(0);
  });

  it('a lying public killSwitchEngaged (instance AND prototype) changes nothing the gateway decides', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    expectOk(fx.ops.engageKillSwitch(EXTERNAL_ACTION_KILL_SCOPE, 'founder', 'stop'));
    const proto = OperatorQueue.prototype as unknown as Record<string, unknown>;
    const queue = fx.ops.queue as unknown as Record<string, unknown>;
    const savedProto = proto.killSwitchEngaged;
    proto.killSwitchEngaged = () => false;
    try {
      queue.killSwitchEngaged = () => false;
    } catch {
      /* non-writable slot: the prototype patch stands */
    }
    try {
      expect(fx.ops.queue.killSwitchEngaged()).toBe(false); // the lie took
      expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('kill_switch_engaged');
      expect(fx.adapter.calls).toHaveLength(0);
    } finally {
      proto.killSwitchEngaged = savedProto;
      delete queue.killSwitchEngaged;
    }
  });
});

describe('approval is an intersection, never bypassed by risk and never self-granted', () => {
  it('a critical-risk action on a standing-pre-approved capability requires an approval the task cannot carry — refused, not run', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx, { capabilityId: CAPS.openPr, payload: { branch: 'b' } });
    // Low risk on the same task executes without an approval row (policy pre-approved).
    const low = authorizedAction(fx, started);
    expectOk(fx.ops.executeAction({ actionId: low, workerId: 'claude', fence: started.fence }));
    // Escalated to critical: risk adds an approval requirement; standing policy cannot satisfy it.
    const critical = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 'prod',
        payload: { text: 'deploy' },
        risk: { productionScope: true },
        requestedBy: 'founder',
      }),
    ).action;
    expect(critical.riskLevel).toBe('critical');
    const refused = fx.ops.authorizeAction({ actionId: critical.id, workerId: 'claude', fence: started.fence });
    expect(errorCode(refused)).toBe('approval_required_by_risk');
    expect(count(fx, 'hq_approvals')).toBe(0);
    expect(fx.adapter.calls).toHaveLength(1);
  });

  it('the principal who approved the task may not be the one who proposed its external action', () => {
    const fx = gatewayFixture();
    fx.principals.register({
      id: 'coo',
      displayName: 'COO',
      originateCapabilities: [CAPS.indexDoc],
      approvalAuthority: true,
      active: true,
    });
    const started = startedTask(fx, { approver: 'coo' });
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.local',
        actionType: 'write_note',
        target: 't',
        payload: {},
        requestedBy: 'coo',
      }),
    ).action;
    const refused = fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence });
    expect(errorCode(refused)).toBe('not_permitted');
    if (!refused.ok) expect(refused.error.message).toMatch(/may not approve its own external action/);
    // A different proposer on the same approved task is fine.
    expect(authorizedAction(fx, started, { requestedBy: 'founder' })).toBeTruthy();
  });

  it('authority = worker grant ∩ task claim ∩ policy: humans, the wrong fence, a revoked grant and a disabled capability all refuse', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'founder', fence: started.fence }))).toBe('humans_do_not_execute');
    // An id in neither registry is nobody: not assignable, exactly as `claimNext` answers.
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'nobody', fence: started.fence }))).toBe('worker_not_assignable');
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence + 1 }))).toBe('task_not_executing');
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'jules', fence: started.fence }))).toBe('not_permitted');
    // The directory revokes the grant after the claim: the intersection shrinks to nothing.
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus],
      active: true,
    });
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('not_permitted');
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex],
      active: true,
    });
    new CapabilityRegistry(fx.db).setEnabled(CAPS.indexDoc, false);
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('capability_disabled');
    expect(fx.adapter.calls).toHaveLength(0);
    expect(fx.ops.getAction(actionId)!.state).toBe('authorized');
  });
});

describe('secrets, immutability and the one-execution-path seam', () => {
  it('a credential in an adapter result is withheld from the ledger, the evidence chain and the view', () => {
    const token = `ghp_${'a'.repeat(30)}`;
    const fx = gatewayFixture({ adapter: fakeAdapter({ externalRef: { url: 'https://example.test/n/1', token } }) });
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    const executed = expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expect(executed.outcome).toBe('succeeded');
    expect(executed.action.outcome).toMatchObject({ externalRef: null, externalRefWithheld: true });
    const everything = [
      JSON.stringify(fx.db.prepare(`SELECT * FROM hq_action_events`).all()),
      JSON.stringify(fx.db.prepare(`SELECT * FROM hq_action_intents`).all()),
      JSON.stringify(fx.ops.queue.evidence.list()),
      JSON.stringify(fx.db.prepare(`SELECT * FROM hq_events`).all()),
      JSON.stringify(fx.ops.getAction(actionId)),
    ].join('');
    expect(everything).not.toContain(token);
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
  });

  it('a credential in an adapter MESSAGE — a rejected outcome or a thrown error — is withheld the same way, and visibly so', () => {
    // Real APIs echo the token or the Authorization header in auth errors, so
    // this is the first thing a real adapter will hand back. Both stores are
    // engine-immutable and op_evidence is hash-chained: a token that lands
    // there can never be removed. Review round 2 proved it landed.
    const token = `ghp_${'c'.repeat(30)}`;
    const everythingIn = (fx: ReturnType<typeof gatewayFixture>, actionId: string) =>
      [
        JSON.stringify(fx.db.prepare(`SELECT * FROM hq_action_events`).all()),
        JSON.stringify(fx.db.prepare(`SELECT * FROM hq_action_intents`).all()),
        JSON.stringify(fx.ops.queue.evidence.list()),
        JSON.stringify(fx.db.prepare(`SELECT * FROM hq_events`).all()),
        JSON.stringify(fx.ops.getAction(actionId)),
      ].join('');

    // 1. The rejected path: outcome.message carries the token.
    const rejecting = fakeAdapter();
    rejecting.execute = (request) => {
      rejecting.calls.push(request);
      return { ok: false, kind: 'rejected', message: `remote said: token ${token} is invalid` };
    };
    const fx1 = gatewayFixture({ adapter: rejecting });
    const started1 = startedTask(fx1);
    const action1 = authorizedAction(fx1, started1);
    const failed = expectOk(fx1.ops.executeAction({ actionId: action1, workerId: 'claude', fence: started1.fence }));
    expect(failed.outcome).toBe('failed');
    expect(failed.action.outcome).toMatchObject({ state: 'failed', message: null, messageWithheld: true });
    expect(everythingIn(fx1, action1)).not.toContain(token);
    expect(fx1.ops.queue.evidence.verifyChain()).toBeNull();
    // Withheld, not silent: the ledger event, the evidence entry and the audit row all say so.
    const event1 = fx1.db.prepare(`SELECT detail FROM hq_action_events WHERE action_id = ? AND state = 'failed'`).get(action1) as { detail: string };
    expect(JSON.parse(event1.detail)).toMatchObject({ message: null, messageWithheld: true });
    const evidence1 = fx1.ops.queue.evidence.list(started1.taskId).find((e) => e.kind === 'action_failed')!;
    expect(evidence1.payload).toMatchObject({ message: null, messageWithheld: true });
    // ...and the view passes the browser guard `safe()` applies on the wire (it used to 500).
    expect(() => assertBrowserSafe(fx1.ops.getAction(action1), 'action')).not.toThrow();

    // 2. The throw path: the error text carries the token.
    const throwing = fakeAdapter();
    throwing.execute = (request) => {
      throwing.calls.push(request);
      throw new Error(`401 Unauthorized for bearer ${token}`);
    };
    const fx2 = gatewayFixture({ adapter: throwing });
    const started2 = startedTask(fx2);
    const action2 = authorizedAction(fx2, started2);
    const unknown = expectOk(fx2.ops.executeAction({ actionId: action2, workerId: 'claude', fence: started2.fence }));
    expect(unknown.outcome).toBe('outcome_unknown');
    expect(unknown.action.outcome).toMatchObject({ state: 'outcome_unknown', message: null, messageWithheld: true });
    expect(everythingIn(fx2, action2)).not.toContain(token);
    expect(fx2.ops.queue.evidence.verifyChain()).toBeNull();
    expect(() => assertBrowserSafe(fx2.ops.getAction(action2), 'action')).not.toThrow();
    // Unknown stays unknown and retry-blocked — withholding the text changes no state.
    expect(errorCode(fx2.ops.executeAction({ actionId: action2, workerId: 'claude', fence: started2.fence }))).toBe('action_outcome_unknown');

    // 3. An honest message is still recorded, and says it was not withheld.
    const fx3 = gatewayFixture({ adapter: fakeAdapter({ mode: 'reject' }) });
    const started3 = startedTask(fx3);
    const action3 = authorizedAction(fx3, started3);
    const honest = expectOk(fx3.ops.executeAction({ actionId: action3, workerId: 'claude', fence: started3.fence }));
    expect(honest.action.outcome).toMatchObject({ state: 'failed', message: 'the remote refused the request', messageWithheld: false });
  });

  it('both ledger tables are append-only by engine', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    expect(() => fx.db.prepare(`UPDATE hq_action_intents SET risk_level = 'low' WHERE id = ?`).run(actionId)).toThrow(/append-only/);
    expect(() => fx.db.prepare(`DELETE FROM hq_action_intents WHERE id = ?`).run(actionId)).toThrow(/append-only/);
    expect(() => fx.db.prepare(`UPDATE hq_action_events SET state = 'succeeded'`).run()).toThrow(/append-only/);
    expect(() => fx.db.prepare(`DELETE FROM hq_action_events`).run()).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(`INSERT OR REPLACE INTO hq_action_intents (id, task_id, capability_id, adapter_id, action_type, target, payload, payload_digest, risk_level, risk_factors, visibility, reversibility, context_evidence_refs, context_truth_refs, requested_by, requested_at, side_effect_key_base, idempotency_key) VALUES (?, 't', 'c', 'a', 'x', 't', '{}', 'd', 'low', '[]', 'internal', 'irreversible', '[]', '[]', 'r', 'now', 'b', 'k')`)
        .run(actionId),
    ).toThrow(/append-only/);
    expect(fx.ops.getAction(actionId)!.state).toBe('authorized');
  });

  it('REPLACE landing on a secondary unique index — intents idempotency_key, events side_effect_key — aborts; the attempt reservation survives and nothing re-executes', () => {
    const fx = gatewayFixture();
    // The connection pragma binds no foreign writer: prove the trigger alone holds.
    fx.db.pragma('recursive_triggers = OFF');
    try {
      const started = startedTask(fx);
      const actionId = authorizedAction(fx, started);
      expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
      const key = (fx.db.prepare(`SELECT side_effect_key FROM hq_action_events WHERE side_effect_key IS NOT NULL`).get() as { side_effect_key: string })
        .side_effect_key;
      const idem = (fx.db.prepare(`SELECT idempotency_key FROM hq_action_intents WHERE id = ?`).get(actionId) as { idempotency_key: string })
        .idempotency_key;
      const rows = () =>
        JSON.stringify([
          fx.db.prepare(`SELECT * FROM hq_action_intents ORDER BY seq`).all(),
          fx.db.prepare(`SELECT * FROM hq_action_events ORDER BY seq`).all(),
        ]);
      const before = rows();
      // A forged "reconciled: confirmed_not_executed" event carrying the reserved
      // key would erase the durable attempt and open a second generation.
      expect(() =>
        fx.db
          .prepare(
            `INSERT OR REPLACE INTO hq_action_events (id, action_id, state, actor, at, detail, side_effect_key)
             VALUES ('forged-event', ?, 'reconciled', 'attacker', 'now', '{"decision":"confirmed_not_executed"}', ?)`,
          )
          .run(actionId, key),
      ).toThrow(/append-only/);
      expect(() =>
        fx.db
          .prepare(
            `REPLACE INTO hq_action_intents (id, task_id, capability_id, adapter_id, action_type, target, payload, payload_digest, risk_level, risk_factors, visibility, reversibility, context_evidence_refs, context_truth_refs, requested_by, requested_at, side_effect_key_base, idempotency_key)
             VALUES ('forged-intent', 't', 'c', 'a', 'x', 't', '{}', 'd', 'low', '[]', 'internal', 'irreversible', '[]', '[]', 'r', 'now', 'b', ?)`,
          )
          .run(idem),
      ).toThrow(/append-only/);
      expect(rows()).toBe(before);
      const view = fx.ops.getAction(actionId)!;
      expect(view.events.map((e) => e.state)).toEqual(['proposed', 'authorized', 'attempted', 'succeeded']);
      expect(view.state).toBe('succeeded');
      expect(view.attempt?.generation).toBe(1);
      expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('action_state_conflict');
      expect(fx.adapter.calls).toHaveLength(1);
    } finally {
      fx.db.pragma('recursive_triggers = ON');
    }
  });

  it('the dispatch-lane exclusion reads canonical op_evidence rows: a forged queue.evidence.list changes nothing the gateway decides, at execute and at propose', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started);
    // The Claude lane publishes for this task (claim-bound kinds, written through the grant).
    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: started.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_attempted',
      payload: { provider: 'CLAUDE' },
    });
    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: started.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_succeeded',
      payload: { provider: 'CLAUDE', issueNumber: 1 },
    });
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('duplicate_external_action');
    expect(fx.adapter.calls).toHaveLength(0);

    // Forge the deliberately patchable public evidence READ to hide the lane's entries.
    const evidence = fx.ops.queue.evidence as unknown as Record<string, unknown>;
    const realList = fx.ops.queue.evidence.list;
    evidence.list = (taskId?: string) =>
      realList.call(fx.ops.queue.evidence, taskId).filter((e) => !e.kind.startsWith('claude_github_dispatch'));
    try {
      // The lie took: the convenience read no longer shows the dispatch.
      expect(fx.ops.queue.evidence.list(started.taskId).some((e) => e.kind.startsWith('claude_github_dispatch'))).toBe(false);
      expect(realList.call(fx.ops.queue.evidence, started.taskId).some((e) => e.kind === 'claude_github_dispatch_succeeded')).toBe(true);
      // ...and the gate still refuses, because it read the canonical rows.
      expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe('duplicate_external_action');
      expect(fx.adapter.calls).toHaveLength(0);
      expect(fx.ops.getAction(actionId)!.state).toBe('authorized');
      const proposal = fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: fx.adapter.id,
        actionType: 'write_note',
        target: 'notes/other',
        payload: { text: 'again' },
        requestedBy: 'founder',
      });
      expect(errorCode(proposal)).toBe('duplicate_external_action');
    } finally {
      evidence.list = realList;
    }
  });

  it('the dispatch lane reads the gateway history through the function binding: forged gatewayActionHistory / listActions on instance and prototype change nothing', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx, { capabilityId: CAPS.readStatus, payload: { check: 'ci' } });
    const actionId = authorizedAction(fx, started);
    expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    const proto = HeadquarterOperations.prototype as unknown as Record<string, unknown>;
    const instance = fx.ops as unknown as Record<string, unknown>;
    const saved = { history: proto.gatewayActionHistory, list: proto.listActions };
    proto.gatewayActionHistory = () => ({ state: 'none' });
    proto.listActions = () => [];
    try {
      instance.gatewayActionHistory = () => ({ state: 'none' });
      instance.listActions = () => [];
    } catch {
      /* a non-writable instance slot is a pass — the prototype patch stands */
    }
    try {
      // The lie took on the public method...
      expect(fx.ops.gatewayActionHistory(started.taskId)).toEqual({ state: 'none' });
      // ...the binding still answers from the ledger rows...
      expect(gatewayActionHistoryFor(fx.ops, started.taskId)).toEqual({ state: 'succeeded', actionId });
      // ...and the lane stays refused.
      const verdict = claudeDispatchEligibility(fx.ops, started.taskId);
      expect(verdict.eligible).toBe(false);
      if (!verdict.eligible) {
        expect(verdict.code).toBe('task_not_eligible');
        expect(verdict.details?.gatewayActionId).toBe(actionId);
      }
    } finally {
      proto.gatewayActionHistory = saved.history;
      proto.listActions = saved.list;
      delete instance.gatewayActionHistory;
      delete instance.listActions;
    }
  });

  it('a task the Claude dispatch lane already took is refused by the gateway; a task the gateway executed is refused by the dispatch lane', () => {
    const fx = gatewayFixture();
    // Gateway → dispatch: a succeeded gateway action makes the lane ineligible
    // (asked BEFORE the lane's own binding checks, so an unbound task shows it).
    const started = startedTask(fx, { capabilityId: CAPS.readStatus, payload: { check: 'ci' } });
    const actionId = authorizedAction(fx, started);
    expectOk(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    expect(fx.ops.gatewayActionHistory(started.taskId)).toEqual({ state: 'succeeded', actionId });
    const verdict = claudeDispatchEligibility(fx.ops, started.taskId);
    expect(verdict.eligible).toBe(false);
    if (!verdict.eligible) {
      expect(verdict.code).toBe('task_not_eligible');
      expect(verdict.details?.gatewayActionId).toBe(actionId);
    }
    // Dispatch → gateway: an attempted dispatch (claim-bound evidence) refuses a proposal.
    const other = startedTask(fx, { capabilityId: CAPS.readStatus, payload: { check: 'lint' } });
    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: other.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_attempted',
      payload: { provider: 'CLAUDE' },
    });
    const refused = fx.ops.proposeAction({
      taskId: other.taskId,
      adapterId: 'fake.local',
      actionType: 'write_note',
      target: 't',
      payload: {},
      requestedBy: 'founder',
    });
    expect(errorCode(refused)).toBe('duplicate_external_action');
  });

  it('reads are pure and the list is newest first with a bounded wire shape', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const a = authorizedAction(fx, started);
    const b = authorizedAction(fx, started, { idempotencyKey: 'b' });
    const evidenceBefore = fx.ops.queue.evidence.list().length;
    expect(fx.ops.listActions({ taskId: started.taskId }).map((v) => v.id)).toEqual([b, a]);
    expect(fx.ops.listActions({ state: 'authorized' })).toHaveLength(2);
    expect(fx.ops.listActions({ state: 'succeeded' })).toHaveLength(0);
    expect(fx.ops.listActionsBounded()).toMatchObject({ total: 2, truncated: false });
    expect(fx.ops.getAction('nope')).toBeNull();
    expect(fx.ops.queue.evidence.list()).toHaveLength(evidenceBefore);
  });
});
