/**
 * Phase 10 authority and enforcement, against the real canonical machinery.
 *
 * What this suite is for:
 *
 * - the Founder Inbox is DERIVED, not a second authority store: mutating the
 *   source through its own gated act changes or removes the item, and no row
 *   anywhere persists one;
 * - every attention item traces back to the canonical row it came from;
 * - a recommendation cannot execute — there is no method on the facade that
 *   accepts one, and producing a briefing changes nothing;
 * - the Chief of Staff is not a superuser: the ONE act it adds is Founder-
 *   gated and fails closed on identity, grant and capability alike;
 * - the brief ledger is append-only by engine and idempotent by derivation;
 * - and — the finding Phase 9 had to fix, applied ahead of time here — every
 *   enforcement-relevant read comes from the private `#db` derivations, pinned
 *   by hostile same-realm patches on the INSTANCE and on the PROTOTYPE, each
 *   with the lie proven to have taken on the public surface it forged.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';
import { admit, contribute, count, openSession } from './collaboration.fixture.js';
import { commandCenterFixture, inboxIds, itemFor, taskAwaitingApproval } from './command-center.fixture.js';
import { HeadquarterOperations, writeDispatchOutcome } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { FOUNDER_BRIEF_CAPABILITY } from '../src/application/chief-of-staff.js';
import { MISSION_ORCHESTRATE_CAPABILITY } from '../src/application/orchestrator-command.js';

function code(result: { ok: boolean; error?: { code: string } }): string | null {
  return result.ok ? null : (result.error?.code ?? null);
}

describe('the Founder Inbox is derived, never a second authority store', () => {
  it('raises a pending approval, and loses the item the moment the Founder decides it', () => {
    const fx = commandCenterFixture();
    const { taskId } = taskAwaitingApproval(fx, 'cc-approval');
    const item = itemFor(fx, 'task_awaiting_approval')!;
    expect(item.source).toEqual({ table: 'op_tasks', id: taskId });
    expect(item.entities).toContainEqual({ kind: 'task', id: taskId });
    // The blocked section lists the same held task from the same row.
    expect(fx.ops.founderBriefing({ includeFounderOnly: true }).blocked.heldForApproval.items.map((t) => t.taskId)).toEqual([taskId]);

    const digest = founderConsole(fx.ops).approvals.find((card) => card.taskId === taskId)!.actionDigest;
    expectOk(fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest }));
    expect(itemFor(fx, 'task_awaiting_approval')).toBeNull();
    expect(fx.ops.founderBriefing({ includeFounderOnly: true }).blocked.heldForApproval.total).toBe(0);
  });

  it('reports the held task as one pending Founder decision in the ops department, with no approval row in existence', () => {
    // The canonical state HQ actually produces, and the one the ops metric
    // used to miss: a task at the gate and NOT ONE `hq_approvals` row, because
    // HQ writes that row when the decision is MADE. Counting
    // `hq_approvals.decision = 'pending'` reported 0 here (Phase 10
    // correction, M1).
    const fx = commandCenterFixture();
    const { taskId } = taskAwaitingApproval(fx, 'cc-ops-metric');
    expect(count(fx, 'hq_approvals')).toBe(0);
    expect(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals WHERE decision = 'pending'`).get() as { n: number }).n,
    ).toBe(0);
    expect(fx.ops.queue.get(taskId)!.status).toBe('needs_approval');

    const opsMetric = () =>
      fx.ops
        .founderBriefing({ includeFounderOnly: true })
        .departments.find((entry) => entry.department === 'ops')!
        .metrics.find((metric) => metric.label === 'Approvals pending')!.value;
    expect(opsMetric()).toBe(1);
    // The executive number and the Founder Inbox read ONE predicate, so they
    // cannot disagree about what is waiting on the Founder.
    const inbox = fx.ops.founderInbox({ includeFounderOnly: true });
    expect(opsMetric()).toBe(inbox.items.filter((item) => item.reason === 'task_awaiting_approval').length);
    expect(opsMetric()).toBe(fx.ops.founderBriefing({ includeFounderOnly: true }).blocked.heldForApproval.total);

    // Deciding it is exactly what WRITES the approval row: the row appears,
    // it is not `pending`, and the metric falls to 0 with the inbox item.
    const digest = founderConsole(fx.ops).approvals.find((card) => card.taskId === taskId)!.actionDigest;
    expectOk(fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest }));
    expect(count(fx, 'hq_approvals')).toBe(1);
    expect((fx.db.prepare(`SELECT decision FROM hq_approvals`).get() as { decision: string }).decision).toBe('approved');
    expect(opsMetric()).toBe(0);
    expect(itemFor(fx, 'task_awaiting_approval')).toBeNull();
  });

  it('shows the same held task in the Mission Room, from the task status rather than an approval row that is never pending', () => {
    // The adjacent surface with M1's shape: the room's "Approvals pending at
    // the Founder gate" card selected `hq_approvals.decision = 'pending'` and
    // so said nothing was waiting while the mission held real work.
    const fx = commandCenterFixture();
    const { taskId } = taskAwaitingApproval(fx, 'cc-room-gate');
    expectOk(fx.ops.linkMissionPlanItem({ missionId: fx.missionId, planItemSeq: 2, taskId, requestedBy: 'founder' }));
    const room = expectOk(fx.ops.getMissionRoom(fx.missionId));
    expect(room.heldForApproval).toEqual([
      { taskId, capabilityId: CAPS.indexDoc, requestedBy: 'claude', since: fx.ops.queue.get(taskId)!.updatedAt },
    ]);
    expect(count(fx, 'hq_approvals')).toBe(0);

    const digest = founderConsole(fx.ops).approvals.find((card) => card.taskId === taskId)!.actionDigest;
    expectOk(fx.ops.approveTask({ taskId, founderId: 'founder', expectedActionDigest: digest }));
    expect(expectOk(fx.ops.getMissionRoom(fx.missionId)).heldForApproval).toEqual([]);
  });

  it('persists no item anywhere: assembling the whole briefing writes not one row', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'cc-nothing-written');
    const tables = ['hq_events', 'op_evidence', 'op_tasks', 'hq_approvals', 'hq_missions', 'hq_truth_records', 'hq_briefs'];
    const before = Object.fromEntries(tables.map((table) => [table, count(fx, table)]));
    fx.ops.founderInbox({ includeFounderOnly: true });
    fx.ops.founderBriefing({ includeFounderOnly: true });
    fx.ops.commandCenterSummary({ includeFounderOnly: true });
    for (const table of tables) expect(count(fx, table), table).toBe(before[table]);
    // And no table was invented to hold an item.
    const names = (
      fx.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((row) => row.name);
    expect(names.filter((name) => /inbox|attention|recommendation/i.test(name))).toEqual([]);
  });

  it('answers the same question twice identically while nothing canonical moved', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'cc-deterministic');
    const first = fx.ops.founderInbox({ includeFounderOnly: true });
    const second = fx.ops.founderInbox({ includeFounderOnly: true });
    expect(second.items).toEqual(first.items);
    expect(second.byKind).toEqual(first.byKind);
  });

  it('follows a blocked task through the canonical status and drops the item when it moves on', () => {
    const fx = commandCenterFixture();
    // `openPr` is an external side effect, so its result goes through the
    // independent review lane rather than completing directly.
    const created = expectOk(
      fx.ops.createTask({ capabilityId: CAPS.openPr, payload: { branch: 'x' }, idempotencyKey: 'cc-blocked', requestedBy: 'claude' }),
    );
    expect(itemFor(fx, 'task_blocked')).toBeNull();
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr, undefined, created.task.id));
    const running = expectOk(fx.ops.startTask(created.task.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(created.task.id, 'claude', running.fence, { measured: false }));
    expect(itemFor(fx, 'review_pending')).not.toBeNull();
    expectOk(fx.ops.reviewTask(created.task.id, 'codex', 'fail', 'the measurement was never taken'));
    const blocked = itemFor(fx, 'task_review_failed')!;
    expect(blocked.source).toEqual({ table: 'op_tasks', id: created.task.id });
    expect(blocked.provenance).toBe('op_tasks.status = review_failed');
    // The review item is gone the moment the review is decided: an item never
    // outlives the canonical predicate that produced it.
    expect(itemFor(fx, 'review_pending')).toBeNull();
  });

  it('raises a mission block through mission command and clears it through the same gate', () => {
    const fx = commandCenterFixture();
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'working', note: 'start', requestedBy: 'founder' }));
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'blocked', note: 'waiting on legal', requestedBy: 'founder' }));
    const item = itemFor(fx, 'mission_blocked')!;
    expect(item.source).toEqual({ table: 'hq_missions', id: fx.missionId });
    expect(item.requiredAuthority).toBe('mission_command');
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'working', note: 'legal cleared it', requestedBy: 'founder' }));
    expect(itemFor(fx, 'mission_blocked')).toBeNull();
  });

  it('raises an engaged kill switch as an incident, states categorically that a reason exists without quoting it, and drops the item when the switch is released', () => {
    const fx = commandCenterFixture();
    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'INCIDENT-42-FREE-TEXT'));
    const item = itemFor(fx, 'kill_switch_engaged')!;
    expect(item.source).toEqual({ table: 'op_kill_switch', id: '*' });
    expect(item.summary).toContain('Kill switch engaged for scope *');
    expect(item.summary).toContain('by founder');
    // The Founder's free text is a categorical statement here, never a quote:
    // an inbox item rides the UNAUTHENTICATED artifact and the pre-existing
    // artifact kill-switch surface publishes scopes only.
    expect(item.summary).toContain('A reason is recorded');
    expect(item.summary).not.toContain('INCIDENT-42-FREE-TEXT');
    // The verbatim reason is on the Founder-gated briefing, unchanged.
    const stop = fx.ops.founderBriefing({ includeFounderOnly: true }).blocked.killSwitches.find((k) => k.scope === '*')!;
    expect(stop.reason).toBe('INCIDENT-42-FREE-TEXT');
    expect(stop.engagedBy).toBe('founder');
    expectOk(fx.ops.releaseKillSwitch('*', 'founder'));
    expect(itemFor(fx, 'kill_switch_engaged')).toBeNull();
  });

  it('says "No reason was recorded" — never an invented one — when a stop carries no reason', () => {
    const fx = commandCenterFixture();
    expectOk(fx.ops.engageKillSwitch('repo.read_status', 'founder', ''));
    const item = itemFor(fx, 'kill_switch_engaged')!;
    expect(item.summary).toContain('No reason was recorded');
    expect(item.summary).not.toContain('A reason is recorded');
  });

  it('raises an unresolved contradiction and traces both real truth records, then drops it on supersession', () => {
    const fx = commandCenterFixture();
    const first = expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'The hero image is 4 MB.',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        requestedBy: 'claude',
      }),
    ).record;
    const second = expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'The hero image is 40 KB.',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        contradicts: [first.id],
        requestedBy: 'claude',
      }),
    ).record;
    const item = itemFor(fx, 'contradiction_unresolved')!;
    expect(item.source).toEqual({ table: 'hq_truth_relations', id: `${second.id}~${first.id}` });
    expect(item.entities).toContainEqual({ kind: 'truth', id: first.id });
    expect(item.entities).toContainEqual({ kind: 'truth', id: second.id });
    expect(item.entities).toContainEqual({ kind: 'mission', id: fx.missionId });

    // Superseding one side settles it through the Phase 7 derivation — never
    // by recency and never by anything in this phase.
    expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'The hero image is 40 KB after the rebuild.',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        supersedes: first.id,
        requestedBy: 'claude',
      }),
    );
    expect(itemFor(fx, 'contradiction_unresolved')).toBeNull();
  });

  it('asks for acceptance only once Phase 7 issues a digest, and stops the moment the Founder accepts', () => {
    const fx = commandCenterFixture();
    const record = expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'Load time is 1.2s on the reference device.',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        requestedBy: 'claude',
      }),
    ).record;
    expect(itemFor(fx, 'truth_awaiting_acceptance')).toBeNull();
    expectOk(
      fx.ops.verifyTruth({
        truthId: record.id,
        method: 'tested',
        verdict: 'confirmed',
        evidenceRefs: [fx.evidenceId],
        limitations: 'measured on one device only',
        requestedBy: 'codex',
      }),
    );
    const item = itemFor(fx, 'truth_awaiting_acceptance')!;
    expect(item.source).toEqual({ table: 'hq_truth_records', id: record.id });
    expect(item.requiredAuthority).toBe('approval_authority_step_up');
    const digest = fx.ops.getTruthRecord(record.id)!.acceptanceDigest!;
    expectOk(fx.ops.acceptTruth({ truthId: record.id, expectedDigest: digest, requestedBy: 'founder' }));
    expect(itemFor(fx, 'truth_awaiting_acceptance')).toBeNull();
    // And the verifier's stated limitation travels verbatim into the verified section.
    const verified = fx.ops.founderBriefing({ includeFounderOnly: true }).verified;
    expect(verified.truth.items.find((entry) => entry.id === record.id)!.verificationLimitations).toEqual([
      'measured on one device only',
    ]);
  });

  it('raises a handoff request and drops it when the Founder makes the canonical assignment', () => {
    const fx = commandCenterFixture();
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'working', note: 'start', requestedBy: 'founder' }));
    const session = openSession(fx);
    admit(fx, session.id, 'claude', 'builder');
    contribute(fx, session.id, {
      kind: 'handoff_request',
      content: 'Jules should take the asset work.',
      handoff: { taskId: fx.taskId, toWorkerId: 'jules', reason: 'Jules owns the asset pipeline' },
    });
    const item = itemFor(fx, 'handoff_requested')!;
    expect(item.entities).toContainEqual({ kind: 'worker', id: 'jules' });
    expect(item.requiredAuthority).toBe('workforce_assign');
    expect(item.summary).toContain('Advisory only');
    expectOk(fx.ops.assignTaskAsFounder({ taskId: fx.taskId, workerId: 'jules', founderId: 'founder' }));
    expect(itemFor(fx, 'handoff_requested')).toBeNull();
  });
});

describe('the dispatch lane is folded by the same rule the gateway enforces', () => {
  it('says unknown after an attempt, dispatched after a success, and nothing after a failure', () => {
    const fx = commandCenterFixture();
    // A dispatch outcome may only be recorded under a live execution claim,
    // which is the point: nothing invents a publication nobody performed.
    expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, fx.taskId));
    const lane = () => fx.ops.founderBriefing({ includeFounderOnly: true }).unknown.dispatchOutcomeUnknown.items;
    expect(lane()).toEqual([]);

    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: fx.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_attempted',
      payload: { provider: 'CLAUDE' },
    });
    expect(lane().map((entry) => entry.taskId)).toEqual([fx.taskId]);
    const item = itemFor(fx, 'dispatch_outcome_unknown')!;
    expect(item.source.table).toBe('op_evidence');
    expect(item.requiredAuthority).toBe('reconciliation_authority');

    // The published source id is a REAL `op_evidence` row id, resolvable
    // against the log the item names, and it is the attempt row that left
    // this lane unknown — not the task id the draft published under an
    // `op_evidence` label (Phase 10 correction, M2).
    const row = fx.db
      .prepare(`SELECT id, seq, task_id, kind FROM op_evidence WHERE id = ?`)
      .get(item.source.id) as { id: string; seq: number; task_id: string | null; kind: string } | undefined;
    expect(row, 'the item source must resolve against op_evidence').toBeDefined();
    expect(row!.kind).toBe('claude_github_dispatch_attempted');
    expect(row!.task_id).toBe(fx.taskId);
    expect(item.source.id).not.toBe(fx.taskId);
    // It is the NEWEST unterminated attempt for the task, by the chain's own order.
    const newestAttempt = fx.db
      .prepare(
        `SELECT id FROM op_evidence WHERE task_id = ? AND kind = 'claude_github_dispatch_attempted' ORDER BY seq DESC LIMIT 1`,
      )
      .get(fx.taskId) as { id: string };
    expect(item.source.id).toBe(newestAttempt.id);
    expect(item.summary).toContain(row!.id);
    // The recommendation copies that true pair rather than re-deriving one.
    const derived = fx.ops
      .founderBriefing({ includeFounderOnly: true })
      .recommendations.items.find((r) => r.attentionIds.includes(item.id))!;
    expect(derived.sourceFacts).toEqual([{ table: 'op_evidence', id: row!.id, fact: item.provenance }]);

    // A recorded success settles it — and stays settled, exactly as
    // `#claudeDispatchState` treats it, so a later attempt row cannot
    // reopen an outcome HQ has evidence for.
    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: fx.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_succeeded',
      payload: { provider: 'CLAUDE', issueNumber: 1 },
    });
    expect(lane()).toEqual([]);
    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: fx.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_attempted',
      payload: { provider: 'CLAUDE' },
    });
    expect(lane()).toEqual([]);
  });

  it('closes an attempt that recorded a failure, because nothing was published', () => {
    const fx = commandCenterFixture();
    expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, fx.taskId));
    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: fx.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_attempted',
      payload: { provider: 'CLAUDE' },
    });
    expect(itemFor(fx, 'dispatch_outcome_unknown')).not.toBeNull();
    writeDispatchOutcome(fx.ops, fx.dispatchEvidence, {
      taskId: fx.taskId,
      actor: 'hq-claude-dispatch',
      kind: 'claude_github_dispatch_failed',
      payload: { provider: 'CLAUDE', message: 'the transport refused' },
    });
    expect(itemFor(fx, 'dispatch_outcome_unknown')).toBeNull();
  });
});

describe('a recommendation is a record, and there is no path from one to an act', () => {
  it('exposes no facade method that accepts a recommendation id', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'cc-no-exec');
    const recommendation = fx.ops.founderBriefing({ includeFounderOnly: true }).recommendations.items[0]!;
    expect(recommendation.executable).toBe(false);
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(fx.ops) as object),
      ...Object.getOwnPropertyNames(fx.ops),
    ];
    // No name suggests one, and — the load-bearing half — nothing on the
    // surface accepts the id: calling every zero-or-one-argument method with
    // it is not part of this test, so the check is on the vocabulary the
    // module exposes plus the absence of any `recommendation` parameter name.
    expect(surface.filter((name) => /recommend/i.test(name))).toEqual([]);
    expect(surface).not.toContain('executeRecommendation');
    expect(surface).not.toContain('applyRecommendation');
    expect(surface).not.toContain('actOnRecommendation');
  });

  it('changes nothing canonical, however many times the recommendation is read', () => {
    const fx = commandCenterFixture();
    const { taskId } = taskAwaitingApproval(fx, 'cc-rec-inert');
    const before = {
      task: fx.ops.queue.get(taskId),
      approvals: count(fx, 'hq_approvals'),
      evidence: count(fx, 'op_evidence'),
      events: count(fx, 'hq_events'),
    };
    for (let i = 0; i < 3; i += 1) fx.ops.founderBriefing({ includeFounderOnly: true });
    expect(fx.ops.queue.get(taskId)).toEqual(before.task);
    expect(count(fx, 'hq_approvals')).toBe(before.approvals);
    expect(count(fx, 'op_evidence')).toBe(before.evidence);
    expect(count(fx, 'hq_events')).toBe(before.events);
  });

  it('names an act that still refuses an unauthorised caller — the recommendation grants nothing', () => {
    const fx = commandCenterFixture();
    const { taskId } = taskAwaitingApproval(fx, 'cc-rec-grants-nothing');
    const digest = founderConsole(fx.ops).approvals.find((card) => card.taskId === taskId)!.actionDigest;
    const recommendation = fx.ops
      .founderBriefing({ includeFounderOnly: true })
      .recommendations.items.find((entry) => entry.kind === 'decide_pending_approval')!;
    expect(recommendation.actPath).toContain('approveTask');
    // `analyst` holds no approval authority. The recommendation exists, is
    // readable, names the act — and the act still refuses.
    expect(code(fx.ops.approveTask({ taskId, founderId: 'analyst', expectedActionDigest: digest }))).toBe('not_permitted');
    expect(fx.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });
});

describe('issuing a brief receipt is a Founder act that fails closed', () => {
  it('refuses a worker, `system`, an unknown id and a human without the grant', () => {
    const fx = commandCenterFixture();
    expect(code(fx.ops.issueBrief({ requestedBy: 'claude' }))).toBe('not_permitted');
    expect(code(fx.ops.issueBrief({ requestedBy: 'system' }))).toBe('not_permitted');
    expect(code(fx.ops.issueBrief({ requestedBy: 'nobody' }))).toBe('unknown_principal');
    expect(code(fx.ops.issueBrief({ requestedBy: 'analyst' }))).toBe('not_permitted');
    expect(count(fx, 'hq_briefs')).toBe(0);
  });

  it('refuses when the capability is not registered, and never registers it as a side effect', () => {
    const fx = commandCenterFixture({ registerBrief: false });
    expect(code(fx.ops.issueBrief({ requestedBy: 'founder' }))).toBe('unknown_capability');
    expect(fx.db.prepare(`SELECT id FROM op_capabilities WHERE id = ?`).get(FOUNDER_BRIEF_CAPABILITY.id)).toBeUndefined();
    expect(count(fx, 'hq_briefs')).toBe(0);
  });

  it('refuses when the Founder holds the capability but not the originate grant', () => {
    const fx = commandCenterFixture({ grantBrief: false });
    expect(code(fx.ops.issueBrief({ requestedBy: 'founder' }))).toBe('not_permitted');
    expect(count(fx, 'hq_briefs')).toBe(0);
  });

  it('refuses a disabled row and a drifted row, reading the DATABASE row rather than the queue delegate', () => {
    const fx = commandCenterFixture();
    fx.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(FOUNDER_BRIEF_CAPABILITY.id);
    expect(code(fx.ops.issueBrief({ requestedBy: 'founder' }))).toBe('capability_disabled');
    fx.db.prepare(`UPDATE op_capabilities SET enabled = 1, side_effect = 1 WHERE id = ?`).run(FOUNDER_BRIEF_CAPABILITY.id);
    expect(code(fx.ops.issueBrief({ requestedBy: 'founder' }))).toBe('not_permitted');
    expect(count(fx, 'hq_briefs')).toBe(0);

    // A forged `queue.capabilities` reporting the reserved contract opens
    // nothing: the gate reads op_capabilities, not the convenience surface.
    const forged = { ...FOUNDER_BRIEF_CAPABILITY, enabled: true };
    fx.ops.queue.capabilities.get = (id: string) => (id === FOUNDER_BRIEF_CAPABILITY.id ? forged : null);
    fx.ops.queue.capabilities.list = () => [forged];
    expect(fx.ops.queue.capabilities.get(FOUNDER_BRIEF_CAPABILITY.id)).toEqual(forged);
    expect(code(fx.ops.issueBrief({ requestedBy: 'founder' }))).toBe('not_permitted');
    expect(count(fx, 'hq_briefs')).toBe(0);
  });

  it('records who, when, both watermarks, the counts and a digest — and nothing else', () => {
    const fx = commandCenterFixture();
    taskAwaitingApproval(fx, 'cc-brief-receipt');
    const brief = expectOk(fx.ops.issueBrief({ requestedBy: 'founder' })).brief;
    expect(brief.issuedBy).toBe('founder');
    expect(brief.watermark.eventSeq).toBeGreaterThan(0);
    expect(brief.watermark.evidenceSeq).toBeGreaterThan(0);
    expect(brief.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(brief.counts.attention.total).toBe(fx.ops.founderInbox({ includeFounderOnly: true }).total);
    // A RECEIPT, not a report: the row stores no item, no recommendation and
    // no document body, so a stale receipt cannot be mistaken for the truth.
    const row = fx.db.prepare(`SELECT * FROM hq_briefs WHERE id = ?`).get(brief.id) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      'content_digest',
      'counts',
      'event_seq',
      'evidence_seq',
      'id',
      'idempotency_key',
      'issued_at',
      'issued_by',
      'seq',
    ]);
    expect(JSON.stringify(row)).not.toContain('approval_pending');
    // One audit event and one evidence entry, both naming the resolved actor.
    const evidence = fx.ops.queue.evidence.list().find((entry) => entry.kind === 'founder_brief_issued')!;
    expect(evidence.actor).toBe('founder');
    expect(evidence.payload.executable).toBe(false);
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
  });

  it('deduplicates a repeat over the same canonical position, and issues afresh once the record moves', () => {
    const fx = commandCenterFixture();
    const first = expectOk(fx.ops.issueBrief({ requestedBy: 'founder' }));
    expect(first.deduplicated).toBe(false);
    // Nothing but the receipt itself was appended, so the company record has
    // not moved and a second issue is the same brief.
    const repeat = expectOk(fx.ops.issueBrief({ requestedBy: 'founder' }));
    expect(repeat.deduplicated).toBe(true);
    expect(repeat.brief.id).toBe(first.brief.id);
    expect(count(fx, 'hq_briefs')).toBe(1);

    taskAwaitingApproval(fx, 'cc-brief-moves');
    const afterChange = expectOk(fx.ops.issueBrief({ requestedBy: 'founder' }));
    expect(afterChange.deduplicated).toBe(false);
    expect(afterChange.brief.id).not.toBe(first.brief.id);
    expect(afterChange.brief.watermark.eventSeq).toBeGreaterThan(first.brief.watermark.eventSeq);
    expect(count(fx, 'hq_briefs')).toBe(2);
  });

  it('measures WHAT CHANGED from the last receipt, and never reports the receipt itself as news', () => {
    const fx = commandCenterFixture();
    const first = expectOk(fx.ops.issueBrief({ requestedBy: 'founder' })).brief;
    const quiet = fx.ops.founderBriefing({ includeFounderOnly: true }).changed;
    expect(quiet.since).toEqual({ briefId: first.id, issuedAt: first.issuedAt, watermark: first.watermark });
    expect(quiet.events.items).toEqual([]);
    expect(quiet.evidenceByKind).toEqual([]);
    expect(quiet.note).toContain('writing a brief is not something to brief about');

    // A mission transition leaves no hq_events row (it lands in
    // hq_mission_events), and the evidence chain still records it — which is
    // exactly why the section states which log each half comes from.
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'working', note: 'start', requestedBy: 'founder' }));
    const moved = fx.ops.founderBriefing({ includeFounderOnly: true }).changed;
    expect(moved.evidenceByKind).toEqual([{ kind: 'mission_transitioned', count: 1 }]);
    expect(moved.events.items).toEqual([]);
    expect(moved.note).toContain('does not carry every canonical write');

    // A truth record DOES land in hq_events, so the events half moves too.
    expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'The build is green.',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        requestedBy: 'claude',
      }),
    );
    const withEvents = fx.ops.founderBriefing({ includeFounderOnly: true }).changed;
    expect(withEvents.events.total).toBe(1);
    expect(withEvents.events.items[0]!.actor).toBe('claude');
    expect(withEvents.evidenceByKind.map((entry) => entry.kind).sort()).toEqual(['mission_transitioned', 'truth_recorded']);
  });

  it('keeps the ledger append-only by engine — no update, no delete, no REPLACE on either unique index', () => {
    const fx = commandCenterFixture();
    const brief = expectOk(fx.ops.issueBrief({ requestedBy: 'founder' })).brief;
    expect(() => fx.db.prepare(`UPDATE hq_briefs SET issued_by = 'mallory' WHERE id = ?`).run(brief.id)).toThrow(
      /append-only/,
    );
    expect(() => fx.db.prepare(`DELETE FROM hq_briefs WHERE id = ?`).run(brief.id)).toThrow(/append-only/);
    const key = (fx.db.prepare(`SELECT idempotency_key FROM hq_briefs WHERE id = ?`).get(brief.id) as { idempotency_key: string })
      .idempotency_key;
    expect(() =>
      fx.db
        .prepare(
          `INSERT OR REPLACE INTO hq_briefs (id, issued_by, issued_at, event_seq, evidence_seq, content_digest, counts, idempotency_key)
           VALUES (?, 'mallory', 'now', 0, 0, 'x', '{}', ?)`,
        )
        .run(brief.id, 'other-key'),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(
          `INSERT OR REPLACE INTO hq_briefs (id, issued_by, issued_at, event_seq, evidence_seq, content_digest, counts, idempotency_key)
           VALUES ('other-id', 'mallory', 'now', 0, 0, 'x', '{}', ?)`,
        )
        .run(key),
    ).toThrow(/append-only/);
    expect(count(fx, 'hq_briefs')).toBe(1);
    expect((fx.db.prepare(`SELECT issued_by FROM hq_briefs WHERE id = ?`).get(brief.id) as { issued_by: string }).issued_by).toBe(
      'founder',
    );
  });

  it('does not turn the Chief of Staff into a superuser: the brief grant unlocks no other act', () => {
    const fx = commandCenterFixture();
    expectOk(fx.ops.issueBrief({ requestedBy: 'founder' }));
    // `analyst` gets the brief grant and nothing else changes about it.
    fx.principals.register({
      id: 'analyst',
      displayName: 'Operations Analyst',
      originateCapabilities: [CAPS.readStatus, FOUNDER_BRIEF_CAPABILITY.id],
      approvalAuthority: false,
      active: true,
    });
    const { taskId } = taskAwaitingApproval(fx, 'cc-not-superuser');
    const digest = founderConsole(fx.ops).approvals.find((card) => card.taskId === taskId)!.actionDigest;
    expect(code(fx.ops.approveTask({ taskId, founderId: 'analyst', expectedActionDigest: digest }))).toBe('not_permitted');
    expect(code(fx.ops.transitionMission({ missionId: fx.missionId, to: 'working', note: 'x', requestedBy: 'analyst' }))).toBe(
      'not_permitted',
    );
    expect(code(fx.ops.openCollaborationSession({ missionId: fx.missionId, title: 'x', requestedBy: 'analyst' }))).toBe(
      'not_permitted',
    );
    // And it CAN issue a brief, which is the only thing the grant means.
    expect(expectOk(fx.ops.issueBrief({ requestedBy: 'analyst' })).brief.issuedBy).toBe('analyst');
  });
});

describe('every enforcement-relevant read is the canonical row, pinned against hostile same-realm patches', () => {
  /**
   * The Phase 9 High finding, applied ahead of time. Each case forges a
   * PUBLIC read on the instance AND on the prototype (so a freshly
   * constructed facade lies too), proves the lie took on that public surface,
   * and then proves the derived command layer is unmoved.
   */
  function freshOps(fx: ReturnType<typeof commandCenterFixture>): HeadquarterOperations {
    return new HeadquarterOperations(fx.db, { store: new HeadquarterStore(fx.db) });
  }

  it('reads truth through the private derivation, so a relabelled `listTruth` cannot publish a founder_only record', () => {
    const fx = commandCenterFixture();
    const record = expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'The private incident review found a credential in a log.',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    ).record;
    expectOk(
      fx.ops.verifyTruth({
        truthId: record.id,
        method: 'tested',
        verdict: 'confirmed',
        evidenceRefs: [fx.evidenceId],
        limitations: 'one reviewer',
        requestedBy: 'codex',
      }),
    );
    // Unauthenticated audience: withheld, and counted.
    const guardedBefore = fx.ops.commandCenterSummary();
    expect(guardedBefore.attention.items.some((item) => item.source.id === record.id)).toBe(false);
    expect(guardedBefore.attention.withheldFounderOnly).toBe(1);

    // The hostile patch: wrap the REAL read and relabel privacy on the REAL
    // rows, on the instance and on the prototype.
    const proto = Object.getPrototypeOf(fx.ops) as { listTruth: () => unknown[]; listTruthContradictions: () => unknown[] };
    const originalList = proto.listTruth;
    const relabel = function (this: HeadquarterOperations) {
      return (originalList.call(this) as { privacy: string }[]).map((view) => ({ ...view, privacy: 'internal' }));
    };
    proto.listTruth = relabel;
    (fx.ops as unknown as { listTruth: unknown }).listTruth = relabel;
    try {
      // The lie took on the public surface — including for a facade
      // constructed after the patch.
      expect(fx.ops.listTruth().find((view) => view.id === record.id)!.privacy).toBe('internal');
      expect(freshOps(fx).listTruth().find((view) => view.id === record.id)!.privacy).toBe('internal');
      // And moved nothing here: the record is still withheld, the honesty
      // count is still 1, and the Founder-gated read still sees the real row.
      const guarded = fx.ops.commandCenterSummary();
      expect(guarded.attention.items.some((item) => item.source.id === record.id)).toBe(false);
      expect(guarded.attention.withheldFounderOnly).toBe(1);
      expect(JSON.stringify(guarded)).not.toContain('credential in a log');
      const past = fx.ops.founderInbox({ includeFounderOnly: true });
      expect(past.items.some((item) => item.source.id === record.id)).toBe(true);
      expect(past.withheldFounderOnly).toBe(0);
    } finally {
      proto.listTruth = originalList;
      delete (fx.ops as unknown as { listTruth?: unknown }).listTruth;
    }
  });

  /**
   * Phase 10 correction, L1. `collaborationSummary` is the read the
   * UNAUTHENTICATED `hq-snapshot.json` publishes, and it used to derive from
   * the public `listCollaborationSessions()` projection — the exact shape of
   * the Phase 9 High. A wrapping patch that relabelled `privacy` on the real
   * rows published a genuine founder_only room AND zeroed the honesty field
   * beside it.
   */
  it('derives the published collaboration section from `#db`, so a relabelled `listCollaborationSessions` publishes no founder_only room and does not zero `withheldFounderOnly`', () => {
    const fx = commandCenterFixture();
    const secret = openSession(fx, { title: 'PRIVATE-TITLE-ABC', purpose: 'PRIVATE-PURPOSE-ABC', privacy: 'founder_only' });
    admit(fx, secret.id, 'claude', 'builder');
    const before = fx.ops.collaborationSummary();
    expect(before.withheldFounderOnly).toBe(1);
    expect(before.recent.map((session) => session.id)).not.toContain(secret.id);

    const proto = Object.getPrototypeOf(fx.ops) as { listCollaborationSessions: (f?: unknown) => unknown[] };
    const original = proto.listCollaborationSessions;
    const relabel = function (this: HeadquarterOperations, filter?: unknown) {
      return (original.call(this, filter) as { privacy: string }[]).map((view) => ({ ...view, privacy: 'internal' }));
    };
    proto.listCollaborationSessions = relabel;
    (fx.ops as unknown as { listCollaborationSessions: unknown }).listCollaborationSessions = relabel;
    try {
      // The lie took on the public surface, on the instance and on a facade
      // constructed after the patch.
      expect(fx.ops.listCollaborationSessions().find((s) => s.id === secret.id)!.privacy).toBe('internal');
      expect(freshOps(fx).listCollaborationSessions().find((s) => s.id === secret.id)!.privacy).toBe('internal');
      // And the published section did not move.
      const after = fx.ops.collaborationSummary();
      expect(after.withheldFounderOnly).toBe(1);
      expect(after.recent.map((session) => session.id)).not.toContain(secret.id);
      expect(after.workersAdmitted).toBe(0);
      expect(JSON.stringify(after)).not.toContain('PRIVATE-TITLE-ABC');
      expect(JSON.stringify(after)).not.toContain('PRIVATE-PURPOSE-ABC');
      // The Founder-gated read still carries the real row.
      expect(fx.ops.collaborationSummary({ includeFounderOnly: true }).recent.map((s) => s.id)).toContain(secret.id);
    } finally {
      proto.listCollaborationSessions = original;
      delete (fx.ops as unknown as { listCollaborationSessions?: unknown }).listCollaborationSessions;
    }
  });

  /**
   * Carry-forward base debt (accepted Phase 7 code, unchanged by this wave's
   * feature diff): `truthSummary` fed the same unauthenticated artifact
   * through `this.listTruth()` / `this.listTruthContradictions()`. Same
   * shape, same fix, pinned the same way.
   */
  it('derives the published truth section from the private graph, so a relabelled `listTruth` publishes no founder_only statement, a forged `listTruthContradictions` invents none there, and `withheldFounderOnly` is not zeroed', () => {
    const fx = commandCenterFixture();
    const record = expectOk(
      fx.ops.recordTruth({
        entityKind: 'mission',
        entityId: fx.missionId,
        statement: 'PRIVATE-STATEMENT-ABC',
        bornState: 'observed',
        evidenceRefs: [fx.evidenceId],
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    ).record;
    const before = fx.ops.truthSummary({ includeFounderOnly: false });
    expect(before.withheldFounderOnly).toBe(1);
    expect(before.records.map((view) => view.id)).not.toContain(record.id);

    const proto = Object.getPrototypeOf(fx.ops) as {
      listTruth: (f?: unknown) => unknown[];
      listTruthContradictions: () => unknown[];
    };
    const originalList = proto.listTruth;
    const originalContradictions = proto.listTruthContradictions;
    const relabel = function (this: HeadquarterOperations, filter?: unknown) {
      return (originalList.call(this, filter) as { privacy: string }[]).map((view) => ({ ...view, privacy: 'internal' }));
    };
    const ghost = () => [
      { a: 'ghost-a', b: 'ghost-b', entityKind: 'mission', entityId: 'ghost-mission', resolution: 'unresolved', statedBy: 'nobody', statedAt: '2026-01-01T00:00:00.000Z' },
    ];
    proto.listTruth = relabel;
    proto.listTruthContradictions = ghost as typeof originalContradictions;
    (fx.ops as unknown as { listTruth: unknown }).listTruth = relabel;
    (fx.ops as unknown as { listTruthContradictions: unknown }).listTruthContradictions = ghost;
    try {
      expect(fx.ops.listTruth().find((view) => view.id === record.id)!.privacy).toBe('internal');
      expect(freshOps(fx).listTruth().find((view) => view.id === record.id)!.privacy).toBe('internal');
      expect(fx.ops.listTruthContradictions()[0]!.a).toBe('ghost-a');
      const after = fx.ops.truthSummary({ includeFounderOnly: false });
      expect(after.withheldFounderOnly).toBe(1);
      expect(after.records.map((view) => view.id)).not.toContain(record.id);
      expect(JSON.stringify(after)).not.toContain('PRIVATE-STATEMENT-ABC');
      // The forged contradiction invented nothing on the published section either.
      expect(after.unresolvedContradictions).toBe(0);
      expect(JSON.stringify(after)).not.toContain('ghost-a');
      // The Founder-gated read still carries the real row.
      expect(fx.ops.truthSummary({ includeFounderOnly: true }).records.map((view) => view.id)).toContain(record.id);
    } finally {
      proto.listTruth = originalList;
      proto.listTruthContradictions = originalContradictions;
      delete (fx.ops as unknown as { listTruth?: unknown }).listTruth;
      delete (fx.ops as unknown as { listTruthContradictions?: unknown }).listTruthContradictions;
    }
  });

  it('judges contradictions from the private graph, so a forged `listTruthContradictions` invents no item and hides none', () => {
    const fx = commandCenterFixture();
    const first = expectOk(
      fx.ops.recordTruth({ entityKind: 'mission', entityId: fx.missionId, statement: 'A', bornState: 'observed', evidenceRefs: [fx.evidenceId], requestedBy: 'claude' }),
    ).record;
    expectOk(
      fx.ops.recordTruth({ entityKind: 'mission', entityId: fx.missionId, statement: 'B', bornState: 'observed', evidenceRefs: [fx.evidenceId], contradicts: [first.id], requestedBy: 'claude' }),
    );
    const proto = Object.getPrototypeOf(fx.ops) as { listTruthContradictions: () => unknown[] };
    const original = proto.listTruthContradictions;
    const lie = function () {
      return [{ a: 'ghost-a', b: 'ghost-b', entityKind: 'mission', entityId: 'ghost-mission', resolution: 'unresolved', statedBy: 'nobody', statedAt: '2026-01-01T00:00:00.000Z' }];
    };
    proto.listTruthContradictions = lie as typeof original;
    (fx.ops as unknown as { listTruthContradictions: unknown }).listTruthContradictions = lie;
    try {
      expect(fx.ops.listTruthContradictions()[0]!.a).toBe('ghost-a');
      const ids = inboxIds(fx);
      expect(ids.some((id) => id.includes('ghost-a'))).toBe(false);
      expect(ids.some((id) => id.includes(first.id))).toBe(true);
    } finally {
      proto.listTruthContradictions = original;
      delete (fx.ops as unknown as { listTruthContradictions?: unknown }).listTruthContradictions;
    }
  });

  it('reads mission status through `#db`, so a forged `getMission` neither creates nor clears an item', () => {
    const fx = commandCenterFixture();
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'working', note: 'start', requestedBy: 'founder' }));
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'blocked', note: 'waiting', requestedBy: 'founder' }));
    const proto = Object.getPrototypeOf(fx.ops) as { getMission: (id: string) => unknown };
    const original = proto.getMission;
    const lie = function (this: HeadquarterOperations, id: string) {
      const real = original.call(this, id) as { status: string } | null;
      return real ? { ...real, status: 'complete' } : null;
    };
    proto.getMission = lie;
    (fx.ops as unknown as { getMission: unknown }).getMission = lie;
    try {
      expect(fx.ops.getMission(fx.missionId)!.status).toBe('complete');
      expect(freshOps(fx).getMission(fx.missionId)!.status).toBe('complete');
      expect(itemFor(fx, 'mission_blocked')).not.toBeNull();
      expect(fx.ops.founderBriefing({ includeFounderOnly: true }).blocked.missions.items.map((m) => m.id)).toEqual([fx.missionId]);
    } finally {
      proto.getMission = original;
      delete (fx.ops as unknown as { getMission?: unknown }).getMission;
    }
  });

  it('reads the kill switch and the capability rows canonically, so forging either changes no safe-next answer', () => {
    const fx = commandCenterFixture();
    new CapabilityRegistry(fx.db).register({ ...MISSION_ORCHESTRATE_CAPABILITY });
    expectOk(
      fx.ops.amendMissionIntent({
        missionId: fx.missionId,
        amendment: 'specify the second item',
        specifyPlanItems: [{ seq: 2, capabilityId: CAPS.readStatus, payload: { check: 'assets' } }],
        requestedBy: 'founder',
      }),
    );
    expectOk(fx.ops.engageKillSwitch(CAPS.readStatus, 'founder', 'audit'));
    const before = fx.ops.founderBriefing({ includeFounderOnly: true }).safeNext;
    expect(before.acts.find((act) => act.act === 'orchestration_preview')!.applyWouldRefuse).toContain(
      `kill switch engaged for spec capability ${CAPS.readStatus}`,
    );
    expect(before.claimableTasks.total).toBe(0);

    const engaged = fx.ops.queue.killSwitchEngaged;
    const capGet = fx.ops.queue.capabilities.get;
    fx.ops.queue.killSwitchEngaged = () => false;
    fx.ops.queue.capabilities.get = () => null;
    try {
      expect(fx.ops.queue.killSwitchEngaged(CAPS.readStatus)).toBe(false);
      expect(fx.ops.queue.capabilities.get(CAPS.readStatus)).toBeNull();
      const after = fx.ops.founderBriefing({ includeFounderOnly: true }).safeNext;
      expect(after.acts.find((act) => act.act === 'orchestration_preview')!.applyWouldRefuse).toContain(
        `kill switch engaged for spec capability ${CAPS.readStatus}`,
      );
      expect(after.claimableTasks.total).toBe(0);
      expect(itemFor(fx, 'kill_switch_engaged')).not.toBeNull();
    } finally {
      fx.ops.queue.killSwitchEngaged = engaged;
      fx.ops.queue.capabilities.get = capGet;
    }
  });

  it('reads the worker binding canonically, so forged `listAiMembers` / `workerProviderDeclarations` change no unknown', () => {
    const fx = commandCenterFixture();
    const before = fx.ops.founderBriefing({ includeFounderOnly: true }).unknown.workersUndeclaredProvider.items.map((w) => w.workerId);
    expect(before).toContain('jules');
    const proto = Object.getPrototypeOf(fx.ops) as {
      listAiMembers: () => unknown;
      workerProviderDeclarations: () => unknown[];
    };
    const originalMembers = proto.listAiMembers;
    const originalDeclarations = proto.workerProviderDeclarations;
    const memberLie = () => ({ configured: true, members: [{ id: 'jules', identityKey: 'google:forged', status: 'active', health: 'healthy', healthCheckedAt: null }] });
    const declarationLie = () => [{ workerId: 'jules', providerId: 'CLAUDE', declaredBy: 'mallory', declaredAt: '2026-01-01T00:00:00.000Z' }];
    proto.listAiMembers = memberLie as typeof originalMembers;
    proto.workerProviderDeclarations = declarationLie as typeof originalDeclarations;
    (fx.ops as unknown as { listAiMembers: unknown }).listAiMembers = memberLie;
    (fx.ops as unknown as { workerProviderDeclarations: unknown }).workerProviderDeclarations = declarationLie;
    try {
      expect((fx.ops.workerProviderDeclarations() as { workerId: string }[])[0]!.workerId).toBe('jules');
      const after = fx.ops.founderBriefing({ includeFounderOnly: true }).unknown.workersUndeclaredProvider.items.map((w) => w.workerId);
      expect(after).toEqual(before);
      const workforce = fx.ops
        .founderBriefing({ includeFounderOnly: true })
        .departments.find((entry) => entry.department === 'ai_workforce')!;
      expect(workforce.metrics.find((metric) => metric.label === 'Provider declared')!.value).toBe(2);
    } finally {
      proto.listAiMembers = originalMembers;
      proto.workerProviderDeclarations = originalDeclarations;
      delete (fx.ops as unknown as { listAiMembers?: unknown }).listAiMembers;
      delete (fx.ops as unknown as { workerProviderDeclarations?: unknown }).workerProviderDeclarations;
    }
  });

  it('reads task titles from `hq_op_task_meta`, so a forged `readMeta` cannot rewrite what an item says', () => {
    const fx = commandCenterFixture();
    const { taskId } = taskAwaitingApproval(fx, 'cc-readmeta');
    expectOk(fx.ops.denyTask({ taskId, founderId: 'founder', reason: 'the document is not ready' }));
    expect(fx.ops.queue.get(taskId)!.status).toBe('blocked');
    fx.db.prepare(`UPDATE hq_op_task_meta SET title = 'Measure load time' WHERE task_id = ?`).run(taskId);
    const proto = Object.getPrototypeOf(fx.ops) as { readMeta: (id: string) => unknown };
    const original = proto.readMeta;
    const lie = function (this: HeadquarterOperations, id: string) {
      const real = original.call(this, id) as Record<string, unknown> | null;
      return real ? { ...real, title: 'Nothing to see here' } : null;
    };
    proto.readMeta = lie;
    (fx.ops as unknown as { readMeta: unknown }).readMeta = lie;
    try {
      expect((fx.ops.readMeta(taskId) as { title: string }).title).toBe('Nothing to see here');
      expect(itemFor(fx, 'task_blocked')!.summary).toContain('Measure load time');
    } finally {
      proto.readMeta = original;
      delete (fx.ops as unknown as { readMeta?: unknown }).readMeta;
    }
  });

  it('counts refusal evidence from the hash-chained log, so a forged `queue.evidence` count changes no department', () => {
    const fx = commandCenterFixture();
    expect(code(fx.ops.createTask({ capabilityId: CAPS.dropIndex, payload: {}, idempotencyKey: 'cc-refusal', requestedBy: 'jules' }))).toBe(
      'enqueue_rejected',
    );
    const security = () =>
      fx.ops
        .founderBriefing({ includeFounderOnly: true })
        .departments.find((entry) => entry.department === 'cybersecurity')!
        .metrics.find((metric) => metric.label === 'Refusal evidence entries (all time)')!.value;
    const real = security();
    expect(real).toBeGreaterThan(0);
    const list = fx.ops.queue.evidence.list;
    fx.ops.queue.evidence.list = () => [];
    try {
      expect(fx.ops.queue.evidence.list()).toEqual([]);
      expect(security()).toBe(real);
    } finally {
      fx.ops.queue.evidence.list = list;
    }
  });
});
