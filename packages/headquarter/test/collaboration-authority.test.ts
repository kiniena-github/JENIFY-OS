/**
 * Phase 9 — the Mission Room / collaboration authority floor.
 *
 * What this suite pins, in the Founder directive's own terms: a fake or
 * unknown worker is rejected; a wrong provider/model binding is refused; a
 * worker cannot impersonate another; a contribution cannot mutate Founder
 * intent; consensus cannot auto-verify or accept truth; a handoff cannot
 * bypass canonical assignment; a role is metadata and never authority; a
 * session references ONE canonical mission and holds no lifecycle of its
 * own. Every refusal writes nothing; the deciding reads are canonical rows,
 * proven by forging the public reads on the instance AND the prototype.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_CONTRIBUTE_CAPABILITY,
  COLLABORATION_ROLES,
} from '../src/application/collaboration-command.js';
import {
  CLAUDE_MODEL,
  admit,
  collaborationFixture,
  contribute,
  count,
  errorCode,
  openSession,
  roomWithThree,
  type CollaborationFixture,
} from './collaboration.fixture.js';

/** Byte-identical rows of every table the Founder's intent lives in. */
function intentRows(fx: CollaborationFixture): string {
  return JSON.stringify(
    ['hq_missions', 'hq_mission_intents', 'hq_mission_plan_items', 'hq_mission_events', 'op_tasks', 'hq_approvals', 'hq_truth_records', 'hq_truth_verifications', 'hq_truth_acceptances', 'hq_op_task_meta'].map(
      (table) => fx.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
  );
}

describe('a session references ONE canonical mission and holds no lifecycle of its own', () => {
  it('opens on a real non-terminal mission only; its standing is DERIVED from the mission and closes when the mission finishes — no status column exists', () => {
    const fx = collaborationFixture();
    const columns = (fx.db.prepare(`PRAGMA table_info(hq_collab_sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('status');
    expect(columns).not.toContain('standing');

    const unknown = fx.ops.openCollaborationSession({ missionId: 'no-such-mission', title: 'x', requestedBy: 'founder' });
    expect(errorCode(unknown)).toBe('unknown_mission');
    const session = openSession(fx);
    expect(session).toMatchObject({ missionId: fx.missionId, missionStatus: 'planned', standing: 'active', participants: [] });
    admit(fx, session.id, 'claude', 'builder');

    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'cancelled', note: 'stopped', requestedBy: 'founder' }));
    const closed = fx.ops.getCollaborationSession(session.id)!;
    expect(closed.standing).toBe('closed');
    expect(closed.missionStatus).toBe('cancelled');
    // Nothing enters a closed room, and a finished mission opens no new one.
    expect(errorCode(fx.ops.admitCollaborator({ sessionId: session.id, workerId: 'codex', role: 'reviewer', requestedBy: 'founder' }))).toBe('session_closed');
    expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'late', requestedBy: 'claude' }))).toBe('session_closed');
    expect(errorCode(fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'again', requestedBy: 'founder' }))).toBe('mission_terminal');
    expect(count(fx, 'hq_collab_sessions')).toBe(1);
    expect(count(fx, 'hq_collab_participants')).toBe(1);
    expect(count(fx, 'hq_collab_contributions')).toBe(0);
  });

  it('opening and admitting are Founder acts: a worker, system, an unknown id and a human without the command grant are refused, writing nothing', () => {
    const fx = collaborationFixture();
    for (const [actor, code] of [
      ['claude', 'not_permitted'],
      ['system', 'not_permitted'],
      ['ghost', 'unknown_principal'],
      ['analyst', 'not_permitted'],
    ] as const) {
      const opened = fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'x', requestedBy: actor });
      expect(errorCode(opened), actor).toBe(code);
    }
    expect(count(fx, 'hq_collab_sessions')).toBe(0);
    const session = openSession(fx);
    for (const [actor, code] of [
      ['claude', 'not_permitted'],
      ['system', 'not_permitted'],
      ['ghost', 'unknown_principal'],
      ['analyst', 'not_permitted'],
    ] as const) {
      const admitted = fx.ops.admitCollaborator({ sessionId: session.id, workerId: 'codex', role: 'reviewer', requestedBy: actor });
      expect(errorCode(admitted), actor).toBe(code);
    }
    expect(count(fx, 'hq_collab_participants')).toBe(0);
  });

  it('fails closed on a missing/altered/disabled capability — both trios — and never repairs', () => {
    const missing = collaborationFixture({ registerCommand: false, registerContribute: false });
    expect(errorCode(missing.ops.openCollaborationSession({ missionId: missing.missionId, title: 'x', requestedBy: 'founder' }))).toBe('unknown_capability');

    const fx = collaborationFixture();
    fx.db.prepare(`UPDATE op_capabilities SET side_effect = 1 WHERE id = ?`).run(COLLABORATION_COMMAND_CAPABILITY.id);
    expect(errorCode(fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'x', requestedBy: 'founder' }))).toBe('not_permitted');
    fx.db.prepare(`UPDATE op_capabilities SET side_effect = 0 WHERE id = ?`).run(COLLABORATION_COMMAND_CAPABILITY.id);
    new CapabilityRegistry(fx.db).setEnabled(COLLABORATION_COMMAND_CAPABILITY.id, false);
    expect(errorCode(fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'x', requestedBy: 'founder' }))).toBe('capability_disabled');
    new CapabilityRegistry(fx.db).setEnabled(COLLABORATION_COMMAND_CAPABILITY.id, true);
    expect(count(fx, 'hq_collab_sessions')).toBe(0);

    const session = openSession(fx);
    admit(fx, session.id, 'claude', 'builder');
    new CapabilityRegistry(fx.db).setEnabled(COLLABORATION_CONTRIBUTE_CAPABILITY.id, false);
    expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'x', requestedBy: 'claude' }))).toBe('capability_disabled');
    new CapabilityRegistry(fx.db).setEnabled(COLLABORATION_CONTRIBUTE_CAPABILITY.id, true);
    fx.db.prepare(`UPDATE op_capabilities SET risk_class = 'read_only' WHERE id = ?`).run(COLLABORATION_CONTRIBUTE_CAPABILITY.id);
    expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'x', requestedBy: 'claude' }))).toBe('not_permitted');
    expect(count(fx, 'hq_collab_contributions')).toBe(0);
  });
});

describe('a fake, unknown or inactive worker never enters a room', () => {
  it('admitting an unknown id, an inactive worker or a human principal is refused, and the room shows no such participant', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    for (const [workerId, code] of [
      ['ghost', 'unknown_principal'],
      ['retired-bot', 'worker_not_assignable'],
      ['founder', 'not_permitted'],
      ['analyst', 'not_permitted'],
    ] as const) {
      const admitted = fx.ops.admitCollaborator({ sessionId: session.id, workerId, role: 'builder', requestedBy: 'founder' });
      expect(errorCode(admitted), workerId).toBe(code);
    }
    expect(errorCode(fx.ops.admitCollaborator({ sessionId: 'no-such-session', workerId: 'claude', role: 'builder', requestedBy: 'founder' }))).toBe('unknown_session');
    expect(errorCode(fx.ops.admitCollaborator({ sessionId: session.id, workerId: 'claude', role: 'boss' as 'builder', requestedBy: 'founder' }))).toBe('invalid_input');
    expect(count(fx, 'hq_collab_participants')).toBe(0);
    const room = expectOk(fx.ops.getMissionRoom(fx.missionId));
    expect(room.participants).toEqual([]);
    expect(room.sessions[0]!.participants).toEqual([]);
  });

  it('a contribution from an unknown id, system, a human principal, an inactive worker or a worker without the contribute grant is refused, writing nothing', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    admit(fx, session.id, 'mute-bot', 'builder');
    for (const [actor, code] of [
      ['ghost', 'unknown_principal'],
      ['system', 'not_permitted'],
      ['founder', 'not_permitted'],
      ['analyst', 'not_permitted'],
      ['retired-bot', 'worker_not_assignable'],
      ['mute-bot', 'not_permitted'],
    ] as const) {
      const result = fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'x', requestedBy: actor });
      expect(errorCode(result), actor).toBe(code);
    }
    expect(count(fx, 'hq_collab_contributions')).toBe(0);
    expect(count(fx, 'hq_collab_relations')).toBe(0);
  });

  it('a registered worker that was not admitted, or was admitted under another role, cannot contribute; one holding several roles must name one', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    admit(fx, session.id, 'claude', 'builder');
    expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'x', requestedBy: 'jules' }))).toBe('not_a_participant');
    expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'review', content: 'x', role: 'reviewer', requestedBy: 'claude' }))).toBe('not_a_participant');
    // One role: the role need not be named and is recorded from the admission.
    expect(contribute(fx, session.id).role).toBe('builder');
    admit(fx, session.id, 'claude', 'planner');
    expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'plan', content: 'x', requestedBy: 'claude' }))).toBe('invalid_input');
    expect(contribute(fx, session.id, { kind: 'plan', content: 'Measure first.', role: 'planner' }).role).toBe('planner');
    expect(count(fx, 'hq_collab_contributions')).toBe(2);
  });
});

describe('provider/model truth is the canonical binding, never the worker’s word', () => {
  it('records the declared provider and registered model identity for claude, the declared provider only for codex, and undeclared for jules', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const byClaude = contribute(fx, sessionId);
    expect(byClaude.binding).toEqual({
      providerId: 'CLAUDE',
      memberIdentityKey: `${CLAUDE_MODEL.providerId}:${CLAUDE_MODEL.modelId}:${CLAUDE_MODEL.modelVersion}`,
      source: 'declared_provider_and_registered_model',
    });
    const byCodex = contribute(fx, sessionId, { kind: 'review', content: 'Looks right.', requestedBy: 'codex' });
    expect(byCodex.binding).toEqual({ providerId: 'CODEX', memberIdentityKey: null, source: 'declared_provider' });
    const byJules = contribute(fx, sessionId, { content: 'Second opinion.', requestedBy: 'jules' });
    expect(byJules.binding).toEqual({ providerId: null, memberIdentityKey: null, source: 'undeclared' });
    // The admissions recorded the same canonical picture.
    const session = fx.ops.getCollaborationSession(sessionId)!;
    expect(session.participants.find((p) => p.workerId === 'claude')).toMatchObject({ providerId: 'CLAUDE', memberIdentityKey: byClaude.binding.memberIdentityKey });
    expect(session.participants.find((p) => p.workerId === 'jules')).toMatchObject({ providerId: null, memberIdentityKey: null });
  });

  it('a declared binding that disagrees with the canonical one is refused: wrong provider, a provider for an undeclared worker, a wrong model version, and a model for a worker with no registered identity', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const attempts: { requestedBy: string; declaredBinding: Record<string, string> }[] = [
      { requestedBy: 'claude', declaredBinding: { providerId: 'CODEX' } },
      { requestedBy: 'jules', declaredBinding: { providerId: 'GEMINI' } },
      { requestedBy: 'claude', declaredBinding: { modelId: CLAUDE_MODEL.modelId, modelVersion: '2' } },
      { requestedBy: 'codex', declaredBinding: { modelId: 'gpt-generic', modelVersion: 'latest' } },
    ];
    for (const attempt of attempts) {
      const result = fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', ...attempt });
      expect(errorCode(result), JSON.stringify(attempt)).toBe('provider_binding_mismatch');
    }
    expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', requestedBy: 'claude', declaredBinding: { modelId: CLAUDE_MODEL.modelId } }))).toBe('invalid_input');
    expect(count(fx, 'hq_collab_contributions')).toBe(0);
    // The exact canonical declaration is accepted — and what is recorded is still the canonical row, not the echo.
    const exact = contribute(fx, sessionId, {
      declaredBinding: { providerId: 'CLAUDE', modelId: CLAUDE_MODEL.modelId, modelVersion: CLAUDE_MODEL.modelVersion },
    });
    expect(exact.binding.providerId).toBe('CLAUDE');
    expect(exact.binding.source).toBe('declared_provider_and_registered_model');
  });

  it('the binding read is canonical: forged listAiMembers / workerProviderDeclarations / workers.allowedCapabilities on the instance and the prototype decide nothing', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    admit(fx, sessionId, 'mute-bot', 'critic');
    const proto = HeadquarterOperations.prototype as unknown as Record<string, unknown>;
    const ops = fx.ops as unknown as Record<string, unknown>;
    const saved = { members: proto.listAiMembers, providers: proto.workerProviderDeclarations };
    const forgedMembers = {
      configured: true,
      members: [{ id: 'jules', identityKey: 'google:gemini-generic:latest', status: 'active', enabled: true, modelId: 'gemini-generic', modelVersion: 'latest' }],
    };
    const forgedProviders = [{ workerId: 'jules', providerId: 'GEMINI', declaredBy: 'attacker', declaredAt: 'now' }];
    proto.listAiMembers = () => forgedMembers;
    proto.workerProviderDeclarations = () => forgedProviders;
    try {
      ops.listAiMembers = () => forgedMembers;
      ops.workerProviderDeclarations = () => forgedProviders;
    } catch {
      /* a non-writable instance slot is a pass — the prototype patch stands */
    }
    const savedGrant = fx.ops.workers.allowedCapabilities;
    fx.ops.workers.allowedCapabilities = () => [CAPS.readStatus, COLLABORATION_CONTRIBUTE_CAPABILITY.id];
    try {
      // The lies took on the public surfaces.
      expect(fx.ops.listAiMembers().members[0]!.id).toBe('jules');
      expect(fx.ops.workerProviderDeclarations()[0]!.providerId).toBe('GEMINI');
      expect(fx.ops.workers.allowedCapabilities('mute-bot')).toContain(COLLABORATION_CONTRIBUTE_CAPABILITY.id);
      // The decisions did not move.
      expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', requestedBy: 'jules', declaredBinding: { providerId: 'GEMINI' } }))).toBe('provider_binding_mismatch');
      expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', requestedBy: 'jules', declaredBinding: { modelId: 'gemini-generic', modelVersion: 'latest' } }))).toBe('provider_binding_mismatch');
      expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'critique', content: 'x', requestedBy: 'mute-bot' }))).toBe('not_permitted');
      const honest = contribute(fx, sessionId, { content: 'Undeclared and recorded as such.', requestedBy: 'jules' });
      expect(honest.binding).toEqual({ providerId: null, memberIdentityKey: null, source: 'undeclared' });
    } finally {
      proto.listAiMembers = saved.members;
      proto.workerProviderDeclarations = saved.providers;
      delete ops.listAiMembers;
      delete ops.workerProviderDeclarations;
      fx.ops.workers.allowedCapabilities = savedGrant;
    }
    expect(count(fx, 'hq_collab_contributions')).toBe(1);
  });
});

describe('a worker cannot impersonate another', () => {
  it('every contribution is attributed to the resolved actor: jules cannot act under claude’s role, cannot claim claude’s binding, and no input names the worker', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    admit(fx, session.id, 'claude', 'builder');
    admit(fx, session.id, 'jules', 'researcher');
    admit(fx, session.id, 'codex', 'reviewer');
    expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'x', role: 'builder', requestedBy: 'jules' }))).toBe('not_a_participant');
    expect(errorCode(fx.ops.recordContribution({
      sessionId: session.id,
      kind: 'finding',
      content: 'x',
      requestedBy: 'jules',
      declaredBinding: { providerId: 'CLAUDE', modelId: CLAUDE_MODEL.modelId, modelVersion: CLAUDE_MODEL.modelVersion },
    }))).toBe('provider_binding_mismatch');
    const own = contribute(fx, session.id, { requestedBy: 'jules', content: 'Under my own name.' });
    expect(own.workerId).toBe('jules');
    expect(own.role).toBe('researcher');
    // The stored row and the evidence entry carry the resolved actor, not a claimed one.
    expect((fx.db.prepare(`SELECT worker_id FROM hq_collab_contributions WHERE id = ?`).get(own.id) as { worker_id: string }).worker_id).toBe('jules');
    const evidence = fx.ops.queue.evidence.list(fx.taskId).concat(
      (fx.db.prepare(`SELECT actor, kind, payload FROM op_evidence WHERE kind = 'collaboration_contributed'`).all() as { actor: string; kind: string; payload: string }[]).map((r) => ({ actor: r.actor, kind: r.kind, payload: JSON.parse(r.payload) as Record<string, unknown> })) as never[],
    );
    const entry = evidence.find((e) => e.kind === 'collaboration_contributed')!;
    expect(entry.actor).toBe('jules');
    expect((entry.payload as { contributionId: string }).contributionId).toBe(own.id);
    // A review by codex about jules' finding is codex's; a disagreement is stored as codex's stance.
    const review = contribute(fx, session.id, { kind: 'review', content: 'Disagree: the image is cached.', requestedBy: 'codex', disagreesWith: [own.id] });
    expect(review.workerId).toBe('codex');
    expect(fx.ops.getMissionRoom(fx.missionId).ok && expectOk(fx.ops.getMissionRoom(fx.missionId)).disagreements[0]).toMatchObject({ workerId: 'codex', disputedWorkerId: 'jules' });
  });
});

describe('a contribution cannot mutate Founder intent', () => {
  it('plans, proposals, critiques and status reports change no mission field, intent row, plan item, task, approval, assignment or truth state — every row byte-identical', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const truth = expectOk(fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'Load time is 4.2 s.', evidenceRefs: [fx.evidenceId], requestedBy: 'claude' })).record;
    const before = intentRows(fx);
    const missionBefore = fx.ops.getMission(fx.missionId)!;
    contribute(fx, sessionId, { kind: 'plan', content: 'Change the objective: deploy to production tonight and redesign the header.', role: 'builder' });
    contribute(fx, sessionId, { kind: 'proposal', content: 'Mark plan item 2 done and approve task ' + fx.taskId, requestedBy: 'jules' });
    contribute(fx, sessionId, { kind: 'critique', content: 'The constraints are wrong; drop them.', requestedBy: 'codex', truthRefs: [truth.id] });
    contribute(fx, sessionId, { kind: 'status_report', content: 'All done, 100%.', requestedBy: 'jules' });
    expect(intentRows(fx)).toBe(before);
    const missionAfter = fx.ops.getMission(fx.missionId)!;
    expect(missionAfter.objective).toBe(missionBefore.objective);
    expect(missionAfter.constraints).toEqual(missionBefore.constraints);
    expect(missionAfter.status).toBe(missionBefore.status);
    expect(missionAfter.intentHistory).toEqual(missionBefore.intentHistory);
    expect(missionAfter.planItems).toEqual(missionBefore.planItems);
    expect(fx.ops.getTruthRecord(truth.id)!.state).toBe('claimed');
    expect(fx.ops.queue.get(fx.taskId)!.status).toBe('queued');
    expect(count(fx, 'hq_collab_contributions')).toBe(4);
  });
});

describe('consensus never verifies or accepts truth', () => {
  it('three workers agreeing with a finding that references a claimed truth record leave it claimed — no verification row, no acceptance row — and only the Phase 7 act moves it', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const truth = expectOk(fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'CI is green.', evidenceRefs: [fx.evidenceId], requestedBy: 'claude' })).record;
    const finding = contribute(fx, sessionId, { content: 'CI is green; ship it.', truthRefs: [truth.id] });
    contribute(fx, sessionId, { kind: 'review', content: 'Agreed.', requestedBy: 'codex', agreesWith: [finding.id] });
    contribute(fx, sessionId, { kind: 'answer', content: 'Agreed too.', requestedBy: 'jules', agreesWith: [finding.id] });
    // Claude even "agrees" with itself through a second contribution — still nothing moves.
    contribute(fx, sessionId, { kind: 'status_report', content: 'Consensus reached.', agreesWith: [finding.id] });
    expect(count(fx, 'hq_truth_verifications')).toBe(0);
    expect(count(fx, 'hq_truth_acceptances')).toBe(0);
    expect(fx.ops.getTruthRecord(truth.id)!.state).toBe('claimed');
    expect(fx.ops.getTruthRecord(truth.id)!.acceptanceDigest).toBeNull();
    const room = expectOk(fx.ops.getMissionRoom(fx.missionId));
    const view = room.contributions.items.find((c) => c.id === finding.id)!;
    expect(view.standing).toBe('agreed');
    expect(view.agreedBy.map((s) => s.workerId).sort()).toEqual(['claude', 'codex', 'jules']);
    expect(view.truthRefs).toEqual([{ id: truth.id, state: 'claimed' }]);
    expect(room.truth.records.map((r) => r.state)).toEqual(['claimed']);
    // The ONLY way up: an independent verification under real verification authority.
    expectOk(fx.ops.verifyTruth({ truthId: truth.id, method: 'inspected_evidence', verdict: 'confirmed', evidenceRefs: [fx.evidenceId], limitations: 'inspected the entry only', requestedBy: 'codex' }));
    expect(expectOk(fx.ops.getMissionRoom(fx.missionId)).contributions.items.find((c) => c.id === finding.id)!.truthRefs[0]!.state).toBe('verified');
  });

  it('a stored disagreement stays listed and is never resolved by count or recency; standing is categorical and stances name the same session only', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const finding = contribute(fx, sessionId);
    const dispute = contribute(fx, sessionId, { kind: 'critique', content: 'The image is served from cache.', requestedBy: 'codex', disagreesWith: [finding.id] });
    contribute(fx, sessionId, { kind: 'answer', content: 'Agreed with the finding.', requestedBy: 'jules', agreesWith: [finding.id] });
    let room = expectOk(fx.ops.getMissionRoom(fx.missionId));
    expect(room.disagreements).toHaveLength(1);
    expect(room.disagreements[0]).toMatchObject({ contributionId: dispute.id, disputesId: finding.id, workerId: 'codex', disputedWorkerId: 'claude' });
    expect(room.contributions.items.find((c) => c.id === finding.id)!.standing).toBe('mixed');
    // Two more agreements later do not outvote the one disagreement.
    contribute(fx, sessionId, { kind: 'status_report', content: 'Still agree.', requestedBy: 'jules', agreesWith: [finding.id], idempotencyKey: 'again' });
    contribute(fx, sessionId, { kind: 'status_report', content: 'Me too.', agreesWith: [finding.id] });
    room = expectOk(fx.ops.getMissionRoom(fx.missionId));
    expect(room.disagreements).toHaveLength(1);
    expect(room.contributions.items.find((c) => c.id === finding.id)!.standing).toBe('mixed');
    expect(room.contributions.items.find((c) => c.id === dispute.id)!.standing).toBe('unchallenged');
    // Stances are bounded to the session; contradictory stances on one target are refused.
    const other = openSession(fx, { title: 'Other room' });
    admit(fx, other.id, 'claude', 'builder');
    expect(errorCode(fx.ops.recordContribution({ sessionId: other.id, kind: 'review', content: 'x', requestedBy: 'claude', agreesWith: [finding.id] }))).toBe('unknown_contribution');
    expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'review', content: 'x', requestedBy: 'claude', agreesWith: [finding.id], disagreesWith: [finding.id] }))).toBe('invalid_input');
    expect(count(fx, 'hq_collab_relations')).toBe(4);
  });
});

describe('a handoff request never bypasses canonical assignment', () => {
  it('records a recommendation beside the unchanged canonical claim: claimNext by the named worker still refuses, no assignment row appears, and the room shows the real claimant', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, fx.taskId));
    expectOk(fx.ops.startTask(fx.taskId, 'claude', claimed.fence));
    const request = contribute(fx, sessionId, {
      kind: 'handoff_request',
      content: 'Jules has the asset pipeline context.',
      taskId: fx.taskId,
      handoff: { taskId: fx.taskId, toWorkerId: 'jules', reason: 'Context lives with Jules.' },
    });
    expect(request.handoff).toMatchObject({ taskId: fx.taskId, toWorkerId: 'jules', advisory: true, canonical: { status: 'running', claimedBy: 'claude', assignedWorkerId: null } });
    expect(fx.ops.readMeta(fx.taskId)?.assignment ?? null).toBeNull();
    const row = fx.ops.queue.get(fx.taskId)!;
    expect(row.claimedBy).toBe('claude');
    expect(row.fence).toBe(claimed.fence);
    expect(row.status).toBe('running');
    const stolen = fx.ops.claimNext('jules', CAPS.readStatus, undefined, fx.taskId);
    expect(stolen.ok).toBe(false);
    expect(fx.ops.queue.get(fx.taskId)!.claimedBy).toBe('claude');
    const room = expectOk(fx.ops.getMissionRoom(fx.missionId));
    expect(room.handoffRequests).toHaveLength(1);
    expect(room.handoffRequests[0]).toMatchObject({ fromWorkerId: 'claude', toWorkerId: 'jules', canonical: { claimedBy: 'claude', assignedWorkerId: null } });
    expect(room.execution.linkedTasks[0]).toMatchObject({ taskId: fx.taskId, claimedBy: 'claude', assignment: null });
  });

  it('only the Founder’s canonical assignment act changes the picture — on a task with no live claim — and the request itself still assigned nothing', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const second = expectOk(fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: { check: 'assets' }, idempotencyKey: 'collab-task-2', requestedBy: 'claude' })).task;
    expectOk(fx.ops.linkMissionPlanItem({ missionId: fx.missionId, planItemSeq: 2, taskId: second.id, requestedBy: 'founder' }));
    contribute(fx, sessionId, {
      kind: 'handoff_request',
      content: 'Jules should take the asset task.',
      handoff: { taskId: second.id, toWorkerId: 'jules', reason: 'Asset expertise.' },
    });
    expect(fx.ops.readMeta(second.id)?.assignment ?? null).toBeNull();
    expect(expectOk(fx.ops.getMissionRoom(fx.missionId)).handoffRequests[0]!.canonical).toMatchObject({ status: 'queued', claimedBy: null, assignedWorkerId: null });
    expectOk(fx.ops.assignTaskAsFounder({ taskId: second.id, workerId: 'jules', founderId: 'founder', rationale: 'Founder decision.' }));
    expect(expectOk(fx.ops.getMissionRoom(fx.missionId)).handoffRequests[0]!.canonical).toMatchObject({ assignedWorkerId: 'jules', assignedBy: 'founder' });
  });

  it('a handoff naming an unknown, inactive or human target, the requester itself, a task the mission does not link, or carried by another kind is refused', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const unlinked = expectOk(fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: { check: 'other' }, idempotencyKey: 'collab-unlinked', requestedBy: 'claude' })).task;
    const base = { sessionId, kind: 'handoff_request' as const, content: 'x', requestedBy: 'claude' };
    for (const [handoff, code] of [
      [{ taskId: fx.taskId, toWorkerId: 'ghost', reason: 'r' }, 'unknown_principal'],
      [{ taskId: fx.taskId, toWorkerId: 'retired-bot', reason: 'r' }, 'worker_not_assignable'],
      [{ taskId: fx.taskId, toWorkerId: 'founder', reason: 'r' }, 'not_permitted'],
      [{ taskId: fx.taskId, toWorkerId: 'claude', reason: 'r' }, 'invalid_input'],
      [{ taskId: unlinked.id, toWorkerId: 'jules', reason: 'r' }, 'invalid_input'],
      [{ taskId: fx.taskId, toWorkerId: 'jules', reason: '' }, 'invalid_input'],
    ] as const) {
      expect(errorCode(fx.ops.recordContribution({ ...base, handoff })), JSON.stringify(handoff)).toBe(code);
    }
    expect(errorCode(fx.ops.recordContribution({ ...base }))).toBe('invalid_input');
    expect(errorCode(fx.ops.recordContribution({ ...base, kind: 'finding', handoff: { taskId: fx.taskId, toWorkerId: 'jules', reason: 'r' } }))).toBe('invalid_input');
    expect(count(fx, 'hq_collab_contributions')).toBe(0);
  });
});

describe('a role is admission metadata, never authority', () => {
  it('admission as verifier grants no hq.truth_verify, admission as planner grants no mission command, and the worker’s directory grant is untouched', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    const grantBefore = [...fx.ops.workers.allowedCapabilities('jules')];
    const specialistBefore = fx.db.prepare(`SELECT * FROM hq_specialists WHERE id = 'jules'`).get();
    admit(fx, session.id, 'jules', 'verifier');
    admit(fx, session.id, 'jules', 'planner');
    const truth = expectOk(fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'x', evidenceRefs: [fx.evidenceId], requestedBy: 'claude' })).record;
    expect(errorCode(fx.ops.verifyTruth({ truthId: truth.id, method: 'reviewed', verdict: 'confirmed', evidenceRefs: [fx.evidenceId], limitations: 'none', requestedBy: 'jules' }))).toBe('not_permitted');
    expect(errorCode(fx.ops.amendMissionIntent({ missionId: fx.missionId, amendment: 'as planner', objective: 'new', requestedBy: 'jules' }))).toBe('not_permitted');
    expect(errorCode(fx.ops.transitionMission({ missionId: fx.missionId, to: 'working', requestedBy: 'jules' }))).toBe('not_permitted');
    expect([...fx.ops.workers.allowedCapabilities('jules')]).toEqual(grantBefore);
    expect(fx.db.prepare(`SELECT * FROM hq_specialists WHERE id = 'jules'`).get()).toEqual(specialistBefore);
    expect(fx.ops.getTruthRecord(truth.id)!.state).toBe('claimed');
    expect(COLLABORATION_ROLES).toHaveLength(6);
  });
});

describe('references are real and bounded; identical acts deduplicate', () => {
  it('refuses a task the mission does not link, an unknown evidence id, and an unknown or founder_only truth id with one code (no oracle)', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const unlinked = expectOk(fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: { check: 'other' }, idempotencyKey: 'collab-unlinked-2', requestedBy: 'claude' })).task;
    const privateTruth = expectOk(fx.ops.recordTruth({ entityKind: 'mission', entityId: fx.missionId, statement: 'private', privacy: 'founder_only', requestedBy: 'founder' })).record;
    expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', taskId: unlinked.id, requestedBy: 'claude' }))).toBe('invalid_input');
    expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', evidenceRefs: ['no-such-evidence'], requestedBy: 'claude' }))).toBe('unknown_evidence');
    const unknownTruth = fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', truthRefs: ['no-such-truth'], requestedBy: 'claude' });
    const privateRef = fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', truthRefs: [privateTruth.id], requestedBy: 'claude' });
    expect(errorCode(unknownTruth)).toBe('unknown_truth');
    expect(errorCode(privateRef)).toBe('unknown_truth');
    // The same message shape for both: the refusal names the id as unknown and says nothing about privacy.
    if (!unknownTruth.ok && !privateRef.ok) {
      expect(privateRef.error.message.replace(privateTruth.id, 'X')).toBe(unknownTruth.error.message.replace('no-such-truth', 'X'));
    }
    // Secret-like content is refused before anything persists.
    expect(errorCode(fx.ops.recordContribution({ sessionId, kind: 'finding', content: 'x', requestedBy: 'claude', artifactRefs: ['token=ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }))).toBe('invalid_input');
    expect(count(fx, 'hq_collab_contributions')).toBe(0);
  });

  it('an identical contribution dedupes, an admission dedupes on (session, worker, role), and a session dedupes on its derived key', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    expect(openSession(fx).id).toBe(session.id);
    expect(expectOk(fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'Speed war room', purpose: 'Plan and review the load-time work', requestedBy: 'founder' })).deduplicated).toBe(true);
    expect(openSession(fx, { title: 'Another room' }).id).not.toBe(session.id);
    const first = admit(fx, session.id, 'claude', 'builder');
    const again = admit(fx, session.id, 'claude', 'builder');
    expect(again.deduplicated).toBe(true);
    expect(again.participant.id).toBe(first.participant.id);
    expect(admit(fx, session.id, 'claude', 'planner').deduplicated).toBe(false);
    const a = contribute(fx, session.id, { role: 'builder' });
    const b = expectOk(fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'The hero image is 4 MB and blocks first paint.', role: 'builder', requestedBy: 'claude' }));
    expect(b.deduplicated).toBe(true);
    expect(b.contribution.id).toBe(a.id);
    expect(count(fx, 'hq_collab_sessions')).toBe(2);
    expect(count(fx, 'hq_collab_participants')).toBe(2);
    expect(count(fx, 'hq_collab_contributions')).toBe(1);
  });
});

describe('the engine holds the record', () => {
  it('all four tables abort UPDATE, DELETE and REPLACE/upsert on the primary AND the secondary unique targets with recursive_triggers OFF — rows byte-identical', () => {
    const fx = collaborationFixture();
    const sessionId = roomWithThree(fx);
    const finding = contribute(fx, sessionId);
    contribute(fx, sessionId, { kind: 'review', content: 'No.', requestedBy: 'codex', disagreesWith: [finding.id] });
    fx.db.pragma('recursive_triggers = OFF');
    try {
      const sessionKey = (fx.db.prepare(`SELECT idempotency_key FROM hq_collab_sessions WHERE id = ?`).get(sessionId) as { idempotency_key: string }).idempotency_key;
      const contributionKey = (fx.db.prepare(`SELECT idempotency_key FROM hq_collab_contributions WHERE id = ?`).get(finding.id) as { idempotency_key: string }).idempotency_key;
      const tables = ['hq_collab_sessions', 'hq_collab_participants', 'hq_collab_contributions', 'hq_collab_relations'];
      const rows = () => JSON.stringify(tables.map((table) => fx.db.prepare(`SELECT * FROM ${table} ORDER BY seq`).all()));
      const before = rows();
      const attempts: [string, unknown[]][] = [
        [`UPDATE hq_collab_sessions SET mission_id = 'other' WHERE id = ?`, [sessionId]],
        [`DELETE FROM hq_collab_sessions WHERE id = ?`, [sessionId]],
        [`UPDATE hq_collab_participants SET role = 'verifier' WHERE worker_id = 'jules'`, []],
        [`DELETE FROM hq_collab_participants WHERE worker_id = 'jules'`, []],
        [`UPDATE hq_collab_contributions SET worker_id = 'attacker' WHERE id = ?`, [finding.id]],
        [`UPDATE hq_collab_contributions SET content = 'forged' WHERE id = ?`, [finding.id]],
        [`DELETE FROM hq_collab_contributions WHERE id = ?`, [finding.id]],
        [`UPDATE hq_collab_relations SET kind = 'agrees_with'`, []],
        [`DELETE FROM hq_collab_relations`, []],
        // Primary target (id) on each table.
        [`INSERT OR REPLACE INTO hq_collab_sessions (id, mission_id, title, purpose, opened_by, opened_at, idempotency_key) VALUES (?, 'm', 'forged', NULL, 'attacker', 'now', 'k-forged')`, [sessionId]],
        [`REPLACE INTO hq_collab_contributions (id, session_id, mission_id, task_id, worker_id, role, kind, content, artifact_refs, evidence_refs, truth_refs, provider_id, member_identity_key, binding_source, handoff_task_id, handoff_to_worker_id, handoff_reason, at, idempotency_key) VALUES (?, ?, 'm', NULL, 'attacker', 'builder', 'finding', 'forged', '[]', '[]', '[]', NULL, NULL, 'undeclared', NULL, NULL, NULL, 'now', 'k-forged-2')`, [finding.id, sessionId]],
        // Secondary unique targets: session idempotency_key, participant triple, contribution idempotency_key.
        [`INSERT OR REPLACE INTO hq_collab_sessions (id, mission_id, title, purpose, opened_by, opened_at, idempotency_key) VALUES ('forged-session', 'm', 'forged', NULL, 'attacker', 'now', ?)`, [sessionKey]],
        [`INSERT OR REPLACE INTO hq_collab_participants (id, session_id, worker_id, role, provider_id, member_identity_key, admitted_by, admitted_at) VALUES ('forged-participant', ?, 'jules', 'builder', 'GEMINI', NULL, 'attacker', 'now')`, [sessionId]],
        [`REPLACE INTO hq_collab_contributions (id, session_id, mission_id, task_id, worker_id, role, kind, content, artifact_refs, evidence_refs, truth_refs, provider_id, member_identity_key, binding_source, handoff_task_id, handoff_to_worker_id, handoff_reason, at, idempotency_key) VALUES ('forged-contribution', ?, 'm', NULL, 'attacker', 'builder', 'finding', 'forged', '[]', '[]', '[]', NULL, NULL, 'undeclared', NULL, NULL, NULL, 'now', ?)`, [sessionId, contributionKey]],
        [`INSERT INTO hq_collab_sessions (id, mission_id, title, purpose, opened_by, opened_at, idempotency_key) VALUES (?, 'm', 'forged', NULL, 'attacker', 'now', 'k-forged-3') ON CONFLICT(id) DO UPDATE SET title = 'forged'`, [sessionId]],
      ];
      for (const [sql, params] of attempts) {
        expect(() => fx.db.prepare(sql).run(...params), sql).toThrow(/append-only/);
      }
      expect(rows()).toBe(before);
      // Refused means intact: the derived picture is unchanged, and the legitimate writer still works.
      expect(expectOk(fx.ops.getMissionRoom(fx.missionId)).disagreements).toHaveLength(1);
      expect(contribute(fx, sessionId, { content: 'still recording', requestedBy: 'jules' }).workerId).toBe('jules');
    } finally {
      fx.db.pragma('recursive_triggers = ON');
    }
  });
});

describe('hostile patch: the deciding reads are canonical rows, never a public projection', () => {
  it('forged getMission / getCollaborationSession / lookupPrincipal / workers.isRegistered on the instance and the prototype change no decision', () => {
    const fx = collaborationFixture();
    const session = openSession(fx);
    admit(fx, session.id, 'claude', 'builder');
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'cancelled', note: 'stopped', requestedBy: 'founder' }));
    const proto = HeadquarterOperations.prototype as unknown as Record<string, unknown>;
    const ops = fx.ops as unknown as Record<string, unknown>;
    const saved = { getMission: proto.getMission, getSession: proto.getCollaborationSession, lookup: proto.lookupPrincipal };
    const forgedMission = { ...fx.ops.getMission(fx.missionId)!, status: 'working' };
    const forgedSession = { ...session, standing: 'active', missionStatus: 'working' };
    const forgedPrincipal = { id: 'ghost', displayName: 'Ghost', originateCapabilities: [COLLABORATION_COMMAND_CAPABILITY.id], approvalAuthority: true, active: true };
    proto.getMission = () => forgedMission;
    proto.getCollaborationSession = () => forgedSession;
    proto.lookupPrincipal = () => forgedPrincipal;
    try {
      ops.getMission = () => forgedMission;
      ops.getCollaborationSession = () => forgedSession;
      ops.lookupPrincipal = () => forgedPrincipal;
    } catch {
      /* a non-writable instance slot is a pass — the prototype patch stands */
    }
    const savedRegistered = fx.ops.workers.isRegistered;
    fx.ops.workers.isRegistered = () => true;
    try {
      // The lies took on the public surfaces.
      expect((fx.ops.getMission(fx.missionId) as { status: string }).status).toBe('working');
      expect((fx.ops.getCollaborationSession(session.id) as { standing: string }).standing).toBe('active');
      expect(fx.ops.lookupPrincipal('ghost')?.approvalAuthority).toBe(true);
      expect(fx.ops.workers.isRegistered('ghost')).toBe(true);
      // The decisions did not move.
      expect(errorCode(fx.ops.admitCollaborator({ sessionId: session.id, workerId: 'codex', role: 'reviewer', requestedBy: 'founder' }))).toBe('session_closed');
      expect(errorCode(fx.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'x', requestedBy: 'claude' }))).toBe('session_closed');
      expect(errorCode(fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'again', requestedBy: 'founder' }))).toBe('mission_terminal');
      expect(errorCode(fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'by ghost', requestedBy: 'ghost' }))).toBe('unknown_principal');
      // `workers.isRegistered` lies that ghost exists; the admission still reads the hq_specialists row.
      expect(errorCode(fx.ops.admitCollaborator({ sessionId: session.id, workerId: 'ghost', role: 'builder', requestedBy: 'founder' }))).toBe('unknown_principal');
    } finally {
      proto.getMission = saved.getMission;
      proto.getCollaborationSession = saved.getSession;
      proto.lookupPrincipal = saved.lookup;
      delete ops.getMission;
      delete ops.getCollaborationSession;
      delete ops.lookupPrincipal;
      fx.ops.workers.isRegistered = savedRegistered;
    }
    expect(count(fx, 'hq_collab_sessions')).toBe(1);
    expect(count(fx, 'hq_collab_participants')).toBe(1);
    expect(count(fx, 'hq_collab_contributions')).toBe(0);
  });
});
