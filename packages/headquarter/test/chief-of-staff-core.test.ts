/**
 * Phase 10 — the PURE derivation core of the Chief of Staff.
 *
 * These tests hand `CommandFacts` straight to the exported derivations, with
 * no database anywhere, so what they prove is the rule itself rather than the
 * facade's plumbing (`command-center-authority.test.ts` proves that against
 * real canonical rows). What is under test here:
 *
 * - the predicate behind every attention kind, and that changing the fact
 *   removes the item;
 * - that ordering is a stated GROUPING and not a ranking;
 * - that a superseded truth record is excluded from "verified" and counted;
 * - that unknown stays unknown and missing provenance is shown, not hidden;
 * - that a recommendation is structurally inert;
 * - that no derived document carries a score, priority, percentage, ETA or
 *   confidence field.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTENTION_KINDS,
  ATTENTION_REASONS,
  BRIEFING_SECTION_LIMIT,
  INBOX_ORDERING_STATEMENT,
  RECOMMENDATION_KINDS,
  REQUIRED_AUTHORITIES,
  SAFE_ACT_KINDS,
  SOURCE_TABLES,
  assembleBriefing,
  assembleCommandCenterSnapshot,
  assembleFounderInbox,
  blockedTotalOf,
  bounded,
  briefCountsOf,
  briefIdempotencyKey,
  contentDigest,
  countByKind,
  deriveBlocked,
  deriveChanged,
  deriveDepartments,
  deriveFounderInbox,
  deriveRecommendations,
  deriveSafeNext,
  deriveUnknown,
  deriveVerified,
  orderAttentionItems,
  tasksHeldAtFounderGate,
  truthSubjectRef,
  type CommandFacts,
  type InboxAttentionItem,
  type MissionFact,
  type TaskFact,
  type TruthFact,
} from '../src/application/chief-of-staff.js';

const NOW = '2026-09-07T12:00:00.000Z';
const EARLIER = '2026-09-01T09:00:00.000Z';

function facts(over: Partial<CommandFacts> = {}): CommandFacts {
  return {
    now: NOW,
    missions: [],
    tasks: [],
    approvals: [],
    killSwitches: [],
    truth: [],
    contradictions: [],
    actions: [],
    collaboration: { sessions: [], disagreements: [], handoffs: [] },
    dispatchLane: [],
    workers: [],
    projects: [],
    memory: { total: 0, current: 0, founderOnly: 0, byKind: {} },
    capabilities: [],
    orchestrationRuns: 0,
    refusalEvidence: {},
    stores: { missions: true, projects: true, memory: true, truth: true, actions: true, collaboration: true, briefs: true },
    ...over,
  };
}

function mission(over: Partial<MissionFact> = {}): MissionFact {
  return {
    id: 'mission-1',
    title: 'Faster site',
    status: 'working',
    blockReason: null,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    statusChangedAt: EARLIER,
    acceptanceCriteriaStated: true,
    dependsOn: [],
    planItems: [{ seq: 1, kind: 'work', taskId: 'task-1', specCapabilityId: null }],
    linkedTasks: [{ taskId: 'task-1', status: 'running', reviewPending: false, claimedBy: 'claude' }],
    engagedSpecScopes: [],
    specCapabilitiesUnavailable: [],
    ...over,
  };
}

function task(over: Partial<TaskFact> = {}): TaskFact {
  return {
    id: 'task-1',
    capabilityId: 'repo.read_status',
    status: 'running',
    reviewPending: false,
    claimedBy: 'claude',
    createdBy: 'claude',
    createdAt: EARLIER,
    updatedAt: EARLIER,
    blockReason: null,
    submittedBy: null,
    title: 'Measure load time',
    eligibleWorkers: ['claude'],
    ...over,
  };
}

function truth(over: Partial<TruthFact> = {}): TruthFact {
  return {
    id: 'truth-1',
    seq: 1,
    entityKind: 'mission',
    entityId: 'mission-1',
    statement: 'The hero image is 4 MB.',
    state: 'claimed',
    lifecycle: 'current',
    verification: 'none',
    contested: false,
    recordedBy: 'claude',
    recordedAt: EARLIER,
    evidenceRefs: ['ev-1'],
    privacy: 'internal',
    subjectDrift: 'none',
    acceptanceDigest: null,
    verificationLimitations: [],
    ...over,
  };
}

function reasons(items: readonly InboxAttentionItem[]): string[] {
  return items.map((item) => item.reason);
}

describe('the Founder Inbox is a set of predicates over canonical rows', () => {
  it('raises an approval item from the canonical task status, not from an approval row that does not exist yet', () => {
    // The predicate that looks obvious is wrong in this codebase: HQ writes
    // the `hq_approvals` row when the decision is MADE, so a task waiting on
    // the Founder has none. `op_tasks.status = needs_approval` is the fact.
    const held = facts({ tasks: [task({ status: 'needs_approval' })], approvals: [] });
    const item = deriveFounderInbox(held).find((entry) => entry.reason === 'task_awaiting_approval')!;
    expect(item.kind).toBe('approval');
    expect(item.source).toEqual({ table: 'op_tasks', id: 'task-1' });
    expect(item.entities).toContainEqual({ kind: 'task', id: 'task-1' });
    expect(item.entities).toContainEqual({ kind: 'capability', id: 'repo.read_status' });
    expect(item.requiredAuthority).toBe('approval_authority');
    expect(item.provenance).toBe('op_tasks.status = needs_approval');
    expect(item.since).toBe(EARLIER);

    // Decide it on the SOURCE row and the item is simply not derived again.
    expect(reasons(deriveFounderInbox(facts({ tasks: [task({ status: 'queued' })] })))).not.toContain('task_awaiting_approval');
  });

  it('lists the same held task under WHAT IS BLOCKED, naming no approval id it does not have', () => {
    const view = deriveBlocked(facts({ tasks: [task({ status: 'needs_approval' })] }));
    expect(view.heldForApproval.items).toEqual([
      { taskId: 'task-1', title: 'Measure load time', capabilityId: 'repo.read_status', since: EARLIER },
    ]);
  });

  it('flags an approved-but-never-consumed approval past its expiry, and marks it stale', () => {
    const expired = facts({
      approvals: [
        {
          id: 'approval-2',
          taskId: 'task-1',
          riskClass: 'external_side_effect',
          requestedBy: 'claude',
          requestedAt: EARLIER,
          decision: 'approved',
          decidedBy: 'founder',
          decidedAt: EARLIER,
          expiresAt: '2026-09-02T09:00:00.000Z',
          consumedAt: null,
        },
      ],
      tasks: [task({ status: 'needs_approval' })],
    });
    const item = deriveFounderInbox(expired).find((entry) => entry.reason === 'approval_expired_unconsumed')!;
    expect(item.staleness).toBe('stale');
    expect(item.since).toBe('2026-09-02T09:00:00.000Z');
    // Consumed, or the task finished: either way the predicate stops holding.
    const consumed = facts({ ...expired, approvals: [{ ...expired.approvals[0]!, consumedAt: NOW }] });
    expect(reasons(deriveFounderInbox(consumed))).not.toContain('approval_expired_unconsumed');
    const finished = facts({ ...expired, tasks: [task({ status: 'completed' })] });
    expect(reasons(deriveFounderInbox(finished))).not.toContain('approval_expired_unconsumed');
  });

  it('derives review, blocked, incident and stale-mission items from their own canonical statuses', () => {
    const derived = deriveFounderInbox(
      facts({
        tasks: [
          task({ id: 'task-review', reviewPending: true, submittedBy: 'claude' }),
          task({ id: 'task-blocked', status: 'blocked', blockReason: 'the asset pipeline is down' }),
          task({ id: 'task-failed', status: 'review_failed' }),
          task({ id: 'task-unknown', status: 'outcome_unknown' }),
        ],
        killSwitches: [{ scope: '*', reason: 'incident 42', engagedBy: 'founder', engagedAt: EARLIER }],
        missions: [
          mission({ id: 'mission-blocked', status: 'blocked', blockReason: 'waiting on legal', linkedTasks: [] }),
          mission({ id: 'mission-idle', status: 'working', linkedTasks: [], planItems: [] }),
        ],
      }),
    );
    expect(reasons(derived)).toEqual(
      expect.arrayContaining([
        'review_pending',
        'task_blocked',
        'task_review_failed',
        'task_outcome_unknown',
        'kill_switch_engaged',
        'mission_blocked',
        'mission_working_nothing_in_motion',
      ]),
    );
    // A kill switch carries no canonical timestamp of "since when is this a
    // problem" beyond when it was engaged, and HQ cannot judge whether the
    // cause is resolved, so staleness is `not_evaluated` rather than guessed.
    expect(derived.find((i) => i.reason === 'kill_switch_engaged')!.staleness).toBe('not_evaluated');
    expect(derived.find((i) => i.reason === 'mission_working_nothing_in_motion')!.staleness).toBe('stale');
    expect(derived.find((i) => i.reason === 'task_blocked')!.summary).toContain('the asset pipeline is down');
  });

  it('does not call a working mission stale while any linked task is still in motion or awaiting anyone', () => {
    for (const status of ['queued', 'assigned', 'running', 'needs_approval', 'blocked', 'outcome_unknown'] as const) {
      const derived = deriveFounderInbox(
        facts({ missions: [mission({ linkedTasks: [{ taskId: 'task-1', status, reviewPending: false, claimedBy: null }] })] }),
      );
      expect(reasons(derived), status).not.toContain('mission_working_nothing_in_motion');
    }
    // A completed task awaiting an independent review is still "awaiting
    // someone", and is not motionlessness either.
    expect(
      reasons(
        deriveFounderInbox(
          facts({
            missions: [
              mission({ linkedTasks: [{ taskId: 'task-1', status: 'review_passed', reviewPending: true, claimedBy: null }] }),
            ],
          }),
        ),
      ),
    ).not.toContain('mission_working_nothing_in_motion');
  });

  it('raises a high-risk open action and an unreconciled attempt as separate items with separate authorities', () => {
    const derived = deriveFounderInbox(
      facts({
        actions: [
          {
            id: 'action-open',
            taskId: 'task-1',
            missionId: 'mission-1',
            adapterId: 'github',
            actionType: 'open_issue',
            riskLevel: 'high',
            state: 'proposed',
            requestedBy: 'claude',
            requestedAt: EARLIER,
            attemptedAt: null,
          },
          {
            id: 'action-attempted',
            taskId: 'task-2',
            missionId: null,
            adapterId: 'github',
            actionType: 'open_issue',
            riskLevel: 'low',
            state: 'attempted',
            requestedBy: 'claude',
            requestedAt: EARLIER,
            attemptedAt: NOW,
          },
        ],
      }),
    );
    const risk = derived.find((item) => item.reason === 'action_high_risk_open')!;
    const open = derived.find((item) => item.reason === 'action_awaiting_reconciliation')!;
    expect(risk.kind).toBe('risk');
    expect(risk.requiredAuthority).toBe('approval_authority');
    expect(open.kind).toBe('external_action');
    expect(open.requiredAuthority).toBe('approval_authority_step_up');
    expect(open.since).toBe(NOW);
    // A succeeded action is neither: nothing is pending and nothing is unknown.
    const settled = deriveFounderInbox(
      facts({
        actions: [
          {
            id: 'action-done',
            taskId: 'task-1',
            missionId: null,
            adapterId: 'github',
            actionType: 'open_issue',
            riskLevel: 'critical',
            state: 'succeeded',
            requestedBy: 'claude',
            requestedAt: EARLIER,
            attemptedAt: EARLIER,
          },
        ],
      }),
    );
    expect(reasons(settled)).not.toContain('action_awaiting_reconciliation');
    expect(reasons(settled)).not.toContain('action_high_risk_open');
  });

  it('carries an unresolved contradiction with both records traced, and marks it stale when either subject drifted', () => {
    const base = facts({
      truth: [truth({ id: 'truth-a' }), truth({ id: 'truth-b', seq: 2 })],
      contradictions: [
        { a: 'truth-a', b: 'truth-b', entityKind: 'mission', entityId: 'mission-1', resolution: 'unresolved', statedBy: 'codex', statedAt: EARLIER },
      ],
    });
    const item = deriveFounderInbox(base).find((entry) => entry.reason === 'contradiction_unresolved')!;
    expect(item.source).toEqual({ table: 'hq_truth_relations', id: 'truth-a~truth-b' });
    expect(item.entities).toContainEqual({ kind: 'truth', id: 'truth-a' });
    expect(item.entities).toContainEqual({ kind: 'truth', id: 'truth-b' });
    expect(item.entities).toContainEqual({ kind: 'mission', id: 'mission-1' });
    expect(item.staleness).toBe('current');
    expect(item.summary).toContain('neither side is preferred by recency');

    const drifted = facts({ ...base, truth: [truth({ id: 'truth-a', subjectDrift: 'subject_changed_since_record' }), truth({ id: 'truth-b', seq: 2 })] });
    expect(deriveFounderInbox(drifted).find((e) => e.reason === 'contradiction_unresolved')!.staleness).toBe('stale');

    const resolved = facts({ ...base, contradictions: [{ ...base.contradictions[0]!, resolution: 'resolved_by_supersession' }] });
    expect(reasons(deriveFounderInbox(resolved))).not.toContain('contradiction_unresolved');
  });

  it('marks a contradiction founderOnly when either side is a founder_only record', () => {
    const derived = deriveFounderInbox(
      facts({
        truth: [truth({ id: 'truth-a' }), truth({ id: 'truth-b', seq: 2, privacy: 'founder_only' })],
        contradictions: [
          { a: 'truth-a', b: 'truth-b', entityKind: 'mission', entityId: 'mission-1', resolution: 'unresolved', statedBy: 'codex', statedAt: EARLIER },
        ],
      }),
    );
    expect(derived.find((item) => item.reason === 'contradiction_unresolved')!.founderOnly).toBe(true);
  });

  it('names a memory-subject truth record as memory, not as truth', () => {
    // A small correction over the interrupted draft, which collapsed every
    // non-mission/task/worker/capability/project subject onto `truth` and so
    // published a memory id under the wrong kind.
    expect(truthSubjectRef('memory', 'memory-7')).toEqual({ kind: 'memory', id: 'memory-7' });
    const item = deriveFounderInbox(
      facts({ truth: [truth({ entityKind: 'memory', entityId: 'memory-7', state: 'verified', acceptanceDigest: 'digest-1' })] }),
    ).find((entry) => entry.reason === 'truth_awaiting_acceptance')!;
    expect(item.entities).toContainEqual({ kind: 'memory', id: 'memory-7' });
  });

  it('raises an unknown dispatch outcome and drops it once the lane records a terminal', () => {
    const unknown = facts({
      dispatchLane: [{ taskId: 'task-1', state: 'unknown', at: EARLIER, evidenceId: 'evidence-attempt-1', evidenceSeq: 41 }],
      tasks: [task()],
    });
    const item = deriveFounderInbox(unknown).find((entry) => entry.reason === 'dispatch_outcome_unknown')!;
    expect(item.requiredAuthority).toBe('reconciliation_authority');
    expect(item.summary).toContain('whether an issue was published is unknown');
    // The source names the `op_evidence` row that left the lane unknown, by
    // that row's own id — never the task id under an `op_evidence` label
    // (Phase 10 correction, M2). The task stays an affected entity.
    expect(item.source).toEqual({ table: 'op_evidence', id: 'evidence-attempt-1' });
    expect(item.source.id).not.toBe('task-1');
    expect(item.entities).toEqual([{ kind: 'task', id: 'task-1' }]);
    expect(item.id).toBe('external_action:dispatch_outcome_unknown:evidence-attempt-1');
    // And the derived recommendation carries the same true pair, because it
    // copies the item's source rather than re-deriving one.
    const recommendation = deriveRecommendations([item])[0]!;
    expect(recommendation.sourceFacts).toEqual([
      { table: 'op_evidence', id: 'evidence-attempt-1', fact: item.provenance },
    ]);
    const dispatched = facts({
      ...unknown,
      dispatchLane: [{ taskId: 'task-1', state: 'dispatched', at: NOW, evidenceId: 'evidence-success-1', evidenceSeq: 42 }],
    });
    expect(reasons(deriveFounderInbox(dispatched))).not.toContain('dispatch_outcome_unknown');
  });

  it('raises a handoff and a disagreement only while the mission they sit on is non-terminal', () => {
    const live = facts({
      missions: [mission()],
      collaboration: {
        sessions: [{ id: 'collab-1', missionId: 'mission-1', missionStatus: 'working', standing: 'active', title: 'War room', privacy: 'internal' }],
        disagreements: [
          { sessionId: 'collab-1', missionId: 'mission-1', contributionId: 'c-2', workerId: 'codex', role: 'reviewer', disputesId: 'c-1', disputedWorkerId: 'claude', at: EARLIER, privacy: 'internal' },
        ],
        handoffs: [
          {
            contributionId: 'c-3',
            sessionId: 'collab-1',
            missionId: 'mission-1',
            taskId: 'task-1',
            fromWorkerId: 'claude',
            toWorkerId: 'jules',
            at: EARLIER,
            canonical: { status: 'running', claimedBy: 'claude', assignedWorkerId: null },
            privacy: 'internal',
          },
        ],
      },
    });
    expect(reasons(deriveFounderInbox(live))).toEqual(expect.arrayContaining(['handoff_requested', 'disagreement_open']));
    const cancelled = facts({ ...live, missions: [mission({ status: 'cancelled' })] });
    expect(reasons(deriveFounderInbox(cancelled))).not.toContain('handoff_requested');
    expect(reasons(deriveFounderInbox(cancelled))).not.toContain('disagreement_open');
    // And a handoff the Founder already honoured canonically stops asking.
    const assigned = facts({
      ...live,
      collaboration: {
        ...live.collaboration,
        handoffs: [{ ...live.collaboration.handoffs[0]!, canonical: { status: 'running', claimedBy: 'claude', assignedWorkerId: 'jules' } }],
      },
    });
    expect(reasons(deriveFounderInbox(assigned))).not.toContain('handoff_requested');
  });

  it('flags the handoff and the disagreement of a founder_only session as founderOnly, and an internal session’s as not — the flag follows the room’s own classification', () => {
    const roomsWith = (privacy: 'internal' | 'founder_only') =>
      facts({
        missions: [mission()],
        collaboration: {
          sessions: [{ id: 'collab-1', missionId: 'mission-1', missionStatus: 'working', standing: 'active', title: 'Room', privacy }],
          disagreements: [
            { sessionId: 'collab-1', missionId: 'mission-1', contributionId: 'c-2', workerId: 'codex', role: 'reviewer', disputesId: 'c-1', disputedWorkerId: 'claude', at: EARLIER, privacy },
          ],
          handoffs: [
            { contributionId: 'c-3', sessionId: 'collab-1', missionId: 'mission-1', taskId: 'task-1', fromWorkerId: 'claude', toWorkerId: 'jules', at: EARLIER, canonical: null, privacy },
          ],
        },
      });
    const collaborationItems = (privacy: 'internal' | 'founder_only') =>
      deriveFounderInbox(roomsWith(privacy)).filter(
        (item) => item.reason === 'handoff_requested' || item.reason === 'disagreement_open',
      );
    const open = collaborationItems('internal');
    expect(open).toHaveLength(2);
    for (const item of open) expect(item.founderOnly, item.reason).toBe(false);
    const secret = collaborationItems('founder_only');
    // The items still EXIST (the Founder reads them past the gate); they are
    // flagged, and every reading layer that honours the flag withholds them.
    expect(secret).toHaveLength(2);
    for (const item of secret) expect(item.founderOnly, item.reason).toBe(true);
  });

  it('asks for acceptance exactly while the Phase 7 derivation issued an acceptance digest', () => {
    const acceptable = facts({ truth: [truth({ state: 'verified', acceptanceDigest: 'digest-1' })] });
    const item = deriveFounderInbox(acceptable).find((entry) => entry.reason === 'truth_awaiting_acceptance')!;
    expect(item.requiredAuthority).toBe('approval_authority_step_up');
    expect(item.source).toEqual({ table: 'hq_truth_records', id: 'truth-1' });
    expect(reasons(deriveFounderInbox(facts({ truth: [truth({ state: 'verified', acceptanceDigest: null })] })))).not.toContain(
      'truth_awaiting_acceptance',
    );
  });
});

describe('ordering is a stated grouping, not a ranking', () => {
  it('groups by kind in vocabulary order and, inside a kind, puts the oldest canonical timestamp first', () => {
    const item = (kind: InboxAttentionItem['kind'], id: string, since: string | null): InboxAttentionItem => ({
      id,
      kind,
      reason: 'task_awaiting_approval',
      source: { table: 'hq_approvals', id },
      entities: [],
      summary: id,
      since,
      staleness: 'current',
      requiredAuthority: 'approval_authority',
      provenance: 'test',
      founderOnly: false,
    });
    const ordered = orderAttentionItems([
      item('stale_mission', 'z', EARLIER),
      item('approval', 'b', NOW),
      item('approval', 'a', EARLIER),
      item('review', 'c', NOW),
      item('approval', 'd', null),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b', 'd', 'c', 'z']);
    // A source row with no timestamp of its own sorts last WITHIN its kind —
    // it is never given an invented one to sort by.
    expect(ordered[2]!.since).toBeNull();
  });

  it('states the ordering in the assembled document and attaches no number to any kind', () => {
    const inbox = assembleFounderInbox({ items: [], at: NOW, includeFounderOnly: true });
    expect(inbox.ordering).toContain('A grouping, not a ranking');
    expect(inbox.ordering).toContain('no priority, score or weight exists');
    expect(Object.values(inbox.byKind).every((value) => value === 0)).toBe(true);
    expect(Object.keys(inbox.byKind).sort()).toEqual([...ATTENTION_KINDS].sort());
  });
});

describe('stale facts are excluded or marked, and unknown stays unknown', () => {
  it('excludes a superseded record from "verified" and states how many were excluded', () => {
    const view = deriveVerified(
      facts({
        truth: [
          truth({ id: 'truth-current', state: 'verified', seq: 2 }),
          truth({ id: 'truth-old', state: 'verified', lifecycle: 'superseded', seq: 1 }),
        ],
      }),
      { includeFounderOnly: true },
    );
    expect(view.truth.items.map((entry) => entry.id)).toEqual(['truth-current']);
    expect(view.verified).toBe(1);
    expect(view.supersededExcluded).toBe(1);
  });

  it('marks a verified record stale when its canonical subject drifted, and never reorders by it', () => {
    const view = deriveVerified(
      facts({
        truth: [
          truth({ id: 'truth-drifted', state: 'verified', seq: 2, subjectDrift: 'subject_changed_since_record' }),
          truth({ id: 'truth-fresh', state: 'accepted', seq: 1 }),
        ],
      }),
      { includeFounderOnly: true },
    );
    expect(view.truth.items.map((entry) => entry.id)).toEqual(['truth-drifted', 'truth-fresh']);
    expect(view.truth.items[0]!.staleness).toBe('stale');
    expect(view.truth.items[0]!.subjectDrift).toBe('subject_changed_since_record');
    expect(view.truth.items[1]!.staleness).toBe('current');
  });

  it('reports a claim that cites no evidence as missing provenance rather than hiding it', () => {
    const view = deriveVerified(facts({ truth: [truth({ state: 'verified', evidenceRefs: [] })] }), { includeFounderOnly: true });
    expect(view.truth.items[0]!.provenanceMissing).toBe(true);
    const unknown = deriveUnknown(facts({ truth: [truth({ evidenceRefs: [] })] }), { includeFounderOnly: true });
    expect(unknown.truthWithoutEvidence.items.map((entry) => entry.id)).toEqual(['truth-1']);
    expect(unknown.total).toBeGreaterThan(0);
  });

  it('carries the verifier’s stated limitations verbatim and resolves none of them', () => {
    const view = deriveVerified(
      facts({ truth: [truth({ state: 'verified', verificationLimitations: ['only measured on one page'] })] }),
      { includeFounderOnly: true },
    );
    expect(view.truth.items[0]!.verificationLimitations).toEqual(['only measured on one page']);
  });

  it('lists every explicit unknown and never resolves, estimates or defaults one', () => {
    const view = deriveUnknown(
      facts({
        tasks: [task({ status: 'outcome_unknown' })],
        actions: [
          { id: 'a1', taskId: 'task-1', missionId: null, adapterId: 'github', actionType: 'open_issue', riskLevel: 'low', state: 'outcome_unknown', requestedBy: 'claude', requestedAt: EARLIER, attemptedAt: EARLIER },
        ],
        dispatchLane: [{ taskId: 'task-2', state: 'unknown', at: EARLIER, evidenceId: 'evidence-attempt-2', evidenceSeq: 7 }],
        missions: [mission({ acceptanceCriteriaStated: false })],
        truth: [truth({ id: 'truth-inconclusive', verification: 'inconclusive' })],
        workers: [{ id: 'jules', displayName: 'Jules', active: true, providerDeclared: null, memberIdentityKey: null, liveClaims: 0 }],
      }),
      { includeFounderOnly: true },
    );
    expect(view.tasksOutcomeUnknown.total).toBe(1);
    expect(view.actionsOutcomeUnknown.total).toBe(1);
    expect(view.dispatchOutcomeUnknown.total).toBe(1);
    expect(view.missionsWithoutAcceptanceCriteria.total).toBe(1);
    expect(view.truthInconclusive.total).toBe(1);
    expect(view.truthWithoutEvidence.total).toBe(0);
    expect(view.workersUndeclaredProvider.total).toBe(1);
    expect(view.total).toBe(6);
    expect(view.note).toContain('Nothing here is resolved, estimated or defaulted');
  });

  it('states an absent store as absent rather than reading it as an empty answer', () => {
    const view = deriveUnknown(
      facts({ stores: { missions: true, projects: false, memory: false, truth: true, actions: true, collaboration: true, briefs: false } }),
      { includeFounderOnly: true },
    );
    expect(view.storesAbsent.sort()).toEqual(['briefs', 'memory', 'projects']);
  });
});

describe('privacy: a founder_only record is withheld, and nothing else aggregates over it', () => {
  const graph = facts({
    truth: [
      truth({ id: 'truth-public', state: 'verified', seq: 1 }),
      truth({ id: 'truth-private', state: 'verified', seq: 2, privacy: 'founder_only', acceptanceDigest: 'digest-1' }),
      truth({ id: 'truth-private-bare', seq: 3, privacy: 'founder_only', evidenceRefs: [] }),
    ],
  });

  it('withholds the item AND keeps it out of every count, stating only how many were withheld', () => {
    const guarded = assembleFounderInbox({ items: deriveFounderInbox(graph), at: NOW });
    expect(guarded.items).toHaveLength(0);
    expect(guarded.total).toBe(0);
    expect(guarded.byKind.decision).toBe(0);
    expect(guarded.withheldFounderOnly).toBe(1);

    const past = assembleFounderInbox({ items: deriveFounderInbox(graph), at: NOW, includeFounderOnly: true });
    expect(past.items.map((item) => item.reason)).toEqual(['truth_awaiting_acceptance']);
    expect(past.withheldFounderOnly).toBe(0);
  });

  it('keeps founder_only records out of the verified and unknown sections and their totals', () => {
    const verified = deriveVerified(graph);
    expect(verified.truth.items.map((entry) => entry.id)).toEqual(['truth-public']);
    expect(verified.verified).toBe(1);
    expect(verified.withheldFounderOnly).toBe(1);

    const unknown = deriveUnknown(graph);
    expect(unknown.truthWithoutEvidence.items).toHaveLength(0);
    expect(unknown.withheldFounderOnly).toBe(1);
    expect(unknown.total).toBe(0);
  });

  it('derives recommendations only for items the reader may see', () => {
    const guarded = assembleBriefing({ facts: graph, changed: deriveChanged({ since: null, eventsAfter: [], eventsTotal: 0, evidenceByKind: [] }), briefs: { total: 0, latest: null } });
    expect(guarded.recommendations.total).toBe(0);
    const past = assembleBriefing({
      facts: graph,
      changed: deriveChanged({ since: null, eventsAfter: [], eventsTotal: 0, evidenceByKind: [] }),
      briefs: { total: 0, latest: null },
      includeFounderOnly: true,
    });
    expect(past.recommendations.items.map((entry) => entry.kind)).toEqual(['accept_verified_truth']);
  });

  it('withholds them from the snapshot section too, counting the omission in both places', () => {
    const section = assembleCommandCenterSnapshot({ facts: graph, briefs: { total: 0, latest: null } });
    expect(section.attention.total).toBe(0);
    expect(section.attention.items).toHaveLength(0);
    expect(section.attention.withheldFounderOnly).toBe(1);
    expect(section.unknown.withheldFounderOnly).toBe(1);
    expect(section.recommendations.total).toBe(0);
  });
});

describe('a recommendation is a record and cannot execute', () => {
  it('states its source facts, rationale, limitations, entities and authority, and is executable: false', () => {
    const items = deriveFounderInbox(facts({ tasks: [task({ status: 'needs_approval' })] }));
    const [recommendation] = deriveRecommendations(items);
    expect(recommendation!.executable).toBe(false);
    expect(recommendation!.sourceFacts).toEqual([
      { table: 'op_tasks', id: 'task-1', fact: 'op_tasks.status = needs_approval' },
    ]);
    expect(recommendation!.affectedEntities).toContainEqual({ kind: 'task', id: 'task-1' });
    expect(recommendation!.rationale).toContain('op_tasks.status = needs_approval');
    expect(recommendation!.limitations.length).toBeGreaterThan(0);
    expect(recommendation!.requiredAuthority).toBe('approval_authority');
    expect(recommendation!.actPath).toContain('approveTask');
    expect(recommendation!.attentionIds).toEqual([items[0]!.id]);
  });

  it('carries no field that could be handed back as a handle — no token, no callback, no payload', () => {
    const [recommendation] = deriveRecommendations(
      deriveFounderInbox(facts({ tasks: [task({ status: 'blocked', blockReason: 'stopped' })] })),
    );
    expect(Object.keys(recommendation!).sort()).toEqual([
      'actPath',
      'affectedEntities',
      'attentionIds',
      'executable',
      'id',
      'kind',
      'limitations',
      'rationale',
      'requiredAuthority',
      'sourceFacts',
      'summary',
    ]);
    expect(Object.values(recommendation!).some((value) => typeof value === 'function')).toBe(false);
  });

  it('adds the stale warning to a recommendation whose source fact is marked stale', () => {
    const items = deriveFounderInbox(facts({ missions: [mission({ linkedTasks: [], planItems: [] })] }));
    const [recommendation] = deriveRecommendations(items.filter((item) => item.reason === 'mission_working_nothing_in_motion'));
    expect(recommendation!.limitations).toContain('The source fact is marked stale against its subject; read the subject first.');
  });

  it('derives exactly one recommendation per readable inbox item — the count is the size of that set', () => {
    const derived = deriveFounderInbox(
      facts({
        tasks: [task({ status: 'blocked' }), task({ id: 'task-2', status: 'outcome_unknown' })],
        killSwitches: [{ scope: '*', reason: null, engagedBy: null, engagedAt: null }],
      }),
    );
    expect(deriveRecommendations(derived)).toHaveLength(derived.length);
  });
});

describe('what HQ can safely do next says what stops each act, and never confuses two acts', () => {
  it('reports a preview as available while listing what APPLY would refuse, in its own field', () => {
    const view = deriveSafeNext(
      facts({
        missions: [
          mission({
            status: 'blocked',
            planItems: [{ seq: 1, kind: 'work', taskId: null, specCapabilityId: 'repo.read_status' }],
            engagedSpecScopes: ['repo.read_status'],
            specCapabilitiesUnavailable: ['repo.read_status'],
          }),
        ],
        killSwitches: [{ scope: '*', reason: null, engagedBy: null, engagedAt: null }],
        capabilities: [],
      }),
    );
    const preview = view.acts.find((act) => act.act === 'orchestration_preview')!;
    expect(preview.safe).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.applyWouldRefuse).toEqual(
      expect.arrayContaining([
        'mission is blocked (a Founder stop)',
        'global kill switch engaged',
        'hq.mission_orchestrate is not registered',
        'kill switch engaged for spec capability repo.read_status',
        'spec capability repo.read_status is not registered and enabled',
      ]),
    );
  });

  it('keeps `safe` and `blockers` in agreement for every act, always', () => {
    const view = deriveSafeNext(
      facts({
        stores: { missions: true, projects: true, memory: true, truth: true, actions: true, collaboration: true, briefs: false },
        collaboration: {
          sessions: [
            { id: 'collab-1', missionId: 'mission-1', missionStatus: 'working', standing: 'active', title: 'War room', privacy: 'internal' },
            { id: 'collab-2', missionId: 'mission-2', missionStatus: 'cancelled', standing: 'closed', title: 'Closed room', privacy: 'internal' },
          ],
          disagreements: [],
          handoffs: [],
        },
      }),
    );
    for (const act of view.acts) expect(act.safe, act.act).toBe(act.blockers.length === 0);
    const brief = view.acts.find((act) => act.act === 'issue_founder_brief')!;
    expect(brief.safe).toBe(false);
    expect(brief.blockers).toEqual(['the brief ledger is absent on this database handle']);
    // Only the ACTIVE session offers a bundle read.
    expect(view.acts.filter((act) => act.act === 'assemble_collaboration_context')).toHaveLength(1);
  });

  it('names an ACTIVE founder_only session in a bundle-read act only past the Founder gate — its id and mission are Founder-private material', () => {
    const input = facts({
      collaboration: {
        sessions: [
          { id: 'collab-open', missionId: 'mission-1', missionStatus: 'working', standing: 'active', title: 'Open room', privacy: 'internal' },
          { id: 'collab-secret', missionId: 'mission-1', missionStatus: 'working', standing: 'active', title: 'Private room', privacy: 'founder_only' },
        ],
        disagreements: [],
        handoffs: [],
      },
    });
    const guarded = deriveSafeNext(input).acts.filter((act) => act.act === 'assemble_collaboration_context');
    expect(guarded.flatMap((act) => act.targets.map((target) => target.id))).toContain('collab-open');
    expect(guarded.flatMap((act) => act.targets.map((target) => target.id))).not.toContain('collab-secret');
    const gated = deriveSafeNext(input, { includeFounderOnly: true }).acts.filter((act) => act.act === 'assemble_collaboration_context');
    expect(gated.flatMap((act) => act.targets.map((target) => target.id)).sort()).toEqual(['collab-open', 'collab-secret', 'mission-1', 'mission-1']);
  });

  it('lists a queued task as claimable only when a registered worker is eligible and no stop covers it', () => {
    const eligible = facts({ tasks: [task({ status: 'queued', eligibleWorkers: ['claude'] })] });
    expect(deriveSafeNext(eligible).claimableTasks.items.map((entry) => entry.taskId)).toEqual(['task-1']);
    expect(deriveSafeNext(facts({ tasks: [task({ status: 'queued', eligibleWorkers: [] })] })).claimableTasks.total).toBe(0);
    expect(
      deriveSafeNext(facts({ ...eligible, killSwitches: [{ scope: 'repo.read_status', reason: null, engagedBy: null, engagedAt: null }] }))
        .claimableTasks.total,
    ).toBe(0);
    expect(deriveSafeNext(eligible).note).toContain('Nothing in this section executes, claims, dispatches or approves');
  });
});

describe('what changed is a delta over the append-only record, or says it is not one', () => {
  it('says plainly that it is not a delta when no brief was ever issued', () => {
    const view = deriveChanged({ since: null, eventsAfter: [], eventsTotal: 0, evidenceByKind: [] });
    expect(view.since).toBeNull();
    expect(view.note).toContain('is NOT a delta');
  });

  it('names the brief and both watermarks it is measured from', () => {
    const view = deriveChanged({
      since: {
        seq: 1,
        id: 'brief-1',
        issuedBy: 'founder',
        issuedAt: EARLIER,
        watermark: { eventSeq: 12, evidenceSeq: 30 },
        contentDigest: 'abc',
        counts: { attention: { total: 0, byKind: countByKind([]) }, unknown: { total: 0 }, blocked: { total: 0 }, recommendations: { total: 0 } },
      },
      eventsAfter: [{ seq: 13, at: NOW, subjectKind: 'system', subjectId: 'x', status: null, actor: 'founder', summary: 'something' }],
      eventsTotal: 1,
      evidenceByKind: [{ kind: 'enqueued', count: 2 }, { kind: 'claimed', count: 1 }],
    });
    expect(view.since).toEqual({ briefId: 'brief-1', issuedAt: EARLIER, watermark: { eventSeq: 12, evidenceSeq: 30 } });
    expect(view.note).toContain('event seq > 12');
    expect(view.note).toContain('evidence seq 30');
    // Sorted by kind so the same delta renders identically twice.
    expect(view.evidenceByKind.map((entry) => entry.kind)).toEqual(['claimed', 'enqueued']);
  });
});

describe('departments are projections, and say so when nothing canonical backs them', () => {
  it('states not_recorded with an explanation and no metric for a department HQ records nothing for', () => {
    const projections = deriveDepartments(facts(), []);
    for (const name of ['research', 'product', 'finance'] as const) {
      const projection = projections.find((entry) => entry.department === name)!;
      expect(projection.basis).toBe('not_recorded');
      expect(projection.metrics).toEqual([]);
      expect(projection.sources).toEqual([]);
      expect(projection.note.length).toBeGreaterThan(0);
    }
    expect(projections.find((entry) => entry.department === 'finance')!.note).toContain('would be fabricated');
  });

  it('counts "Approvals pending" from the canonical Founder gate, with no approval row in existence, and agrees with the inbox', () => {
    // The exact state HQ actually produces: a task held at the gate and NO
    // `hq_approvals` row at all, because HQ writes that row when the decision
    // is MADE. The metric used to read `hq_approvals.decision = 'pending'`
    // and so reported 0 over a queue of genuinely held work (M1).
    const held = facts({ tasks: [task({ status: 'needs_approval' }), task({ id: 'task-2', status: 'running' })], approvals: [] });
    expect(held.approvals).toEqual([]);
    const inbox = deriveFounderInbox(held);
    const ops = deriveDepartments(held, inbox).find((entry) => entry.department === 'ops')!;
    const pending = ops.metrics.find((metric) => metric.label === 'Approvals pending')!;
    expect(pending.value).toBe(1);
    // One canonical predicate, so the executive number, the Founder Inbox and
    // WHAT IS BLOCKED cannot disagree about what is at the gate.
    expect(pending.value).toBe(reasons(inbox).filter((reason) => reason === 'task_awaiting_approval').length);
    expect(pending.value).toBe(deriveBlocked(held).heldForApproval.total);
    expect(pending.value).toBe(tasksHeldAtFounderGate(held).length);
    expect(ops.note).toContain('op_tasks.status = needs_approval');

    // Decide it on the canonical row and the metric falls with the inbox —
    // including the case that produced the defect, where deciding the task is
    // exactly what WRITES the (now non-pending) approval row.
    const decided = facts({
      tasks: [task({ status: 'completed' }), task({ id: 'task-2', status: 'running' })],
      approvals: [
        {
          id: 'approval-1',
          taskId: 'task-1',
          riskClass: 'external_side_effect',
          requestedBy: 'claude',
          requestedAt: EARLIER,
          decision: 'approved',
          decidedBy: 'founder',
          decidedAt: NOW,
          expiresAt: null,
          consumedAt: NOW,
        },
      ],
    });
    const after = deriveDepartments(decided, deriveFounderInbox(decided)).find((entry) => entry.department === 'ops')!;
    expect(after.metrics.find((metric) => metric.label === 'Approvals pending')!.value).toBe(0);
  });

  it('counts only over the canonical stores it names, and reads an absent store as absent', () => {
    const withoutProjects = deriveDepartments(
      facts({ stores: { missions: true, projects: false, memory: true, truth: true, actions: true, collaboration: true, briefs: true } }),
      [],
    );
    const business = withoutProjects.find((entry) => entry.department === 'business')!;
    expect(business.basis).toBe('not_recorded');
    expect(business.note).toContain('absence is stated, not read as zero');

    const withProjects = deriveDepartments(
      facts({ projects: [{ id: 'p1', name: 'QOS', status: 'active', missionIds: ['mission-1'] }], missions: [mission()] }),
      [],
    );
    const canonical = withProjects.find((entry) => entry.department === 'business')!;
    expect(canonical.basis).toBe('canonical');
    expect(canonical.sources).toEqual(['hq_projects', 'hq_missions']);
    expect(canonical.metrics).toContainEqual({ label: 'Projects active', value: 1 });
    expect(canonical.metrics).toContainEqual({ label: 'Missions with no project', value: 0 });
  });

  it('counts a live claim as a task genuinely held now, and invents no worker activity', () => {
    const projections = deriveDepartments(
      facts({
        workers: [
          { id: 'claude', displayName: 'Claude', active: true, providerDeclared: 'CLAUDE', memberIdentityKey: 'anthropic:claude-fable-5:1', liveClaims: 1 },
          { id: 'retired', displayName: 'Retired', active: false, providerDeclared: null, memberIdentityKey: null, liveClaims: 0 },
        ],
        tasks: [task({ status: 'running', claimedBy: 'claude' }), task({ id: 'task-done', status: 'completed', claimedBy: 'claude' })],
      }),
      [],
    );
    const workforce = projections.find((entry) => entry.department === 'ai_workforce')!;
    expect(workforce.metrics).toContainEqual({ label: 'Registered workers active', value: 1 });
    expect(workforce.metrics).toContainEqual({ label: 'Provider declared', value: 1 });
    expect(workforce.metrics).toContainEqual({ label: 'Live claims held', value: 1 });
  });

  it('groups the same inbox items rather than re-scoring them', () => {
    const items = deriveFounderInbox(
      facts({ tasks: [task({ status: 'blocked' }), task({ id: 'task-2', reviewPending: true })] }),
    );
    const development = deriveDepartments(facts(), items).find((entry) => entry.department === 'development')!;
    expect(development.attention).toBe(items.filter((item) => item.kind === 'blocked' || item.kind === 'review').length);
  });
});

describe('nothing derived carries a fabricated number', () => {
  const rich = facts({
    missions: [mission({ status: 'blocked', blockReason: 'stopped' })],
    tasks: [task({ status: 'blocked' })],
    approvals: [
      { id: 'a1', taskId: 'task-2', riskClass: 'destructive', requestedBy: 'claude', requestedAt: EARLIER, decision: 'approved', decidedBy: 'founder', decidedAt: EARLIER, expiresAt: '2026-09-02T00:00:00.000Z', consumedAt: null },
    ],
    truth: [truth({ state: 'verified', acceptanceDigest: 'digest-1' })],
    killSwitches: [{ scope: '*', reason: 'incident', engagedBy: 'founder', engagedAt: EARLIER }],
  });

  it('has no priority, score, confidence, percentage, ETA, cost or rank key anywhere in the briefing', () => {
    const briefing = assembleBriefing({
      facts: rich,
      changed: deriveChanged({ since: null, eventsAfter: [], eventsTotal: 0, evidenceByKind: [] }),
      briefs: { total: 0, latest: null },
      includeFounderOnly: true,
    });
    const forbidden = /"(priority|score|confidence|percent|percentage|eta|rank|weight|urgency|cost|tokens|progress)[A-Za-z]*"\s*:/i;
    expect(JSON.stringify(briefing)).not.toMatch(forbidden);
  });

  it('makes every stated total the size of the enumerated set', () => {
    const briefing = assembleBriefing({
      facts: rich,
      changed: deriveChanged({ since: null, eventsAfter: [], eventsTotal: 0, evidenceByKind: [] }),
      briefs: { total: 0, latest: null },
      includeFounderOnly: true,
    });
    const items = deriveFounderInbox(rich);
    expect(briefing.needsMe.total).toBe(items.length);
    expect(Object.values(briefing.needsMe.byKind).reduce((sum, value) => sum + value, 0)).toBe(items.length);
    expect(briefing.recommendations.total).toBe(items.length);
    expect(blockedTotalOf(briefing.blocked)).toBe(
      briefing.blocked.missions.total +
        briefing.blocked.tasks.total +
        briefing.blocked.heldForApproval.total +
        briefing.blocked.killSwitches.length +
        briefing.blocked.plansNeedingFounder.total,
    );
    expect(briefCountsOf(briefing).attention.total).toBe(items.length);
  });

  it('bounds every list with the true total stated beside it', () => {
    const many = facts({
      tasks: Array.from({ length: BRIEFING_SECTION_LIMIT + 5 }, (_unused, index) => task({ id: `task-${index}`, status: 'blocked' })),
    });
    const view = deriveBlocked(many);
    expect(view.tasks.items).toHaveLength(BRIEFING_SECTION_LIMIT);
    expect(view.tasks.total).toBe(BRIEFING_SECTION_LIMIT + 5);
    expect(view.tasks.truncated).toBe(true);
    expect(bounded([1, 2, 3], 10)).toEqual({ items: [1, 2, 3], total: 3, truncated: false });
  });
});

describe('the brief receipt digests what it says it digests', () => {
  it('gives the same brief the same idempotency key and a different one after the watermark moves', () => {
    const key = briefIdempotencyKey({ requestedBy: 'founder', watermark: { eventSeq: 4, evidenceSeq: 9 }, idempotencyKey: null });
    expect(briefIdempotencyKey({ requestedBy: 'founder', watermark: { eventSeq: 4, evidenceSeq: 9 }, idempotencyKey: null })).toBe(key);
    expect(briefIdempotencyKey({ requestedBy: 'founder', watermark: { eventSeq: 5, evidenceSeq: 9 }, idempotencyKey: null })).not.toBe(key);
    expect(briefIdempotencyKey({ requestedBy: 'analyst', watermark: { eventSeq: 4, evidenceSeq: 9 }, idempotencyKey: null })).not.toBe(key);
    expect(key.startsWith('founder-brief:')).toBe(true);
  });

  it('digests a document deterministically, so a re-derivation can be checked against a receipt', () => {
    const changed = deriveChanged({ since: null, eventsAfter: [], eventsTotal: 0, evidenceByKind: [] });
    const first = assembleBriefing({ facts: facts(), changed, briefs: { total: 0, latest: null }, includeFounderOnly: true });
    const second = assembleBriefing({ facts: facts(), changed, briefs: { total: 0, latest: null }, includeFounderOnly: true });
    expect(contentDigest(first)).toBe(contentDigest(second));
    const moved = assembleBriefing({
      facts: facts({ tasks: [task({ status: 'blocked' })] }),
      changed,
      briefs: { total: 0, latest: null },
      includeFounderOnly: true,
    });
    expect(contentDigest(moved)).not.toBe(contentDigest(first));
  });
});

describe('the vocabulary claims no rule the derivations do not have', () => {
  /**
   * A vocabulary entry nobody can be sent to is a claim about HQ that nothing
   * backs. These build a fact set rich enough to reach every predicate, then
   * check the reachable set against each exported list.
   */
  const everything = facts({
    now: NOW,
    missions: [
      mission({ id: 'm-blocked', status: 'blocked', blockReason: 'stopped', linkedTasks: [] }),
      mission({ id: 'm-review', status: 'ready_review', linkedTasks: [] }),
      mission({ id: 'm-verified', status: 'verified', linkedTasks: [] }),
      mission({ id: 'm-idle', status: 'working', linkedTasks: [], planItems: [] }),
      mission({
        id: 'm-plan',
        status: 'working',
        planItems: [{ seq: 1, kind: 'needs_clarification', taskId: null, specCapabilityId: null }],
        linkedTasks: [],
      }),
      mission({
        id: 'm-done',
        status: 'working',
        planItems: [{ seq: 1, kind: 'work', taskId: 'task-complete', specCapabilityId: null }],
        linkedTasks: [{ taskId: 'task-complete', status: 'completed', reviewPending: false, claimedBy: null }],
      }),
      mission({ id: 'm-dep', status: 'working', dependsOn: [{ missionId: 'm-gone', status: 'failed' }], linkedTasks: [] }),
      mission({ id: 'm-live', status: 'working' }),
    ],
    tasks: [
      task({ id: 'task-complete', status: 'completed' }),
      task({ id: 'task-held', status: 'needs_approval' }),
      task({ id: 'task-review', reviewPending: true }),
      task({ id: 'task-blocked', status: 'blocked' }),
      task({ id: 'task-failed', status: 'review_failed' }),
      task({ id: 'task-unknown', status: 'outcome_unknown' }),
      task({ id: 'task-expired', status: 'queued' }),
      task({ id: 'task-queued', status: 'queued', eligibleWorkers: ['claude'] }),
    ],
    approvals: [
      {
        id: 'approval-expired',
        taskId: 'task-expired',
        riskClass: 'destructive',
        requestedBy: 'claude',
        requestedAt: EARLIER,
        decision: 'approved',
        decidedBy: 'founder',
        decidedAt: EARLIER,
        expiresAt: '2026-09-02T00:00:00.000Z',
        consumedAt: null,
      },
    ],
    killSwitches: [{ scope: 'infra.drop_index', reason: 'audit', engagedBy: 'founder', engagedAt: EARLIER }],
    truth: [
      truth({ id: 'truth-a' }),
      truth({ id: 'truth-b', seq: 2 }),
      truth({ id: 'truth-accept', seq: 3, state: 'verified', acceptanceDigest: 'digest-1' }),
    ],
    contradictions: [
      { a: 'truth-a', b: 'truth-b', entityKind: 'mission', entityId: 'm-live', resolution: 'unresolved', statedBy: 'codex', statedAt: EARLIER },
    ],
    actions: [
      { id: 'action-risk', taskId: 'task-held', missionId: 'm-live', adapterId: 'github', actionType: 'open_issue', riskLevel: 'high', state: 'proposed', requestedBy: 'claude', requestedAt: EARLIER, attemptedAt: null },
      { id: 'action-open', taskId: 'task-held', missionId: null, adapterId: 'github', actionType: 'open_issue', riskLevel: 'low', state: 'attempted', requestedBy: 'claude', requestedAt: EARLIER, attemptedAt: EARLIER },
    ],
    dispatchLane: [{ taskId: 'task-unknown', state: 'unknown', at: EARLIER, evidenceId: 'evidence-attempt-9', evidenceSeq: 9 }],
    collaboration: {
      sessions: [{ id: 'collab-1', missionId: 'm-live', missionStatus: 'working', standing: 'active', title: 'Room', privacy: 'internal' }],
      disagreements: [
        { sessionId: 'collab-1', missionId: 'm-live', contributionId: 'c-2', workerId: 'codex', role: 'reviewer', disputesId: 'c-1', disputedWorkerId: 'claude', at: EARLIER, privacy: 'internal' },
      ],
      handoffs: [
        { contributionId: 'c-3', sessionId: 'collab-1', missionId: 'm-live', taskId: 'task-1', fromWorkerId: 'claude', toWorkerId: 'jules', at: EARLIER, canonical: null, privacy: 'internal' },
      ],
    },
    capabilities: [{ id: 'hq.mission_orchestrate', riskClass: 'founder_gate', sideEffect: false, enabled: true }],
    stores: { missions: true, projects: true, memory: true, truth: true, actions: true, collaboration: true, briefs: true },
  });

  it('reaches every attention reason and every attention kind', () => {
    const derived = deriveFounderInbox(everything);
    expect([...new Set(reasons(derived))].sort()).toEqual([...ATTENTION_REASONS].sort());
    expect([...new Set(derived.map((item) => item.kind))].sort()).toEqual([...ATTENTION_KINDS].sort());
  });

  it('reaches every recommendation kind and every required authority it names', () => {
    const derived = deriveFounderInbox(everything);
    const recommendations = deriveRecommendations(derived);
    expect([...new Set(recommendations.map((entry) => entry.kind))].sort()).toEqual([...RECOMMENDATION_KINDS].sort());
    const safeNext = deriveSafeNext(
      facts({
        ...everything,
        missions: [
          ...everything.missions,
          mission({ id: 'm-specified', planItems: [{ seq: 1, kind: 'work', taskId: null, specCapabilityId: 'repo.read_status' }], linkedTasks: [] }),
        ],
      }),
    );
    const reached = new Set<string>([
      ...derived.map((item) => item.requiredAuthority),
      ...recommendations.map((entry) => entry.requiredAuthority),
      ...safeNext.acts.map((act) => act.requiredAuthority),
    ]);
    expect([...reached].sort()).toEqual([...REQUIRED_AUTHORITIES].sort());
  });

  it('reaches every safe-act kind and names every source table it declares', () => {
    const safeNext = deriveSafeNext(
      facts({
        ...everything,
        missions: [
          ...everything.missions,
          mission({ id: 'm-specified', planItems: [{ seq: 1, kind: 'work', taskId: null, specCapabilityId: 'repo.read_status' }], linkedTasks: [] }),
        ],
      }),
    );
    expect([...new Set(safeNext.acts.map((act) => act.act))].sort()).toEqual([...SAFE_ACT_KINDS].sort());
    const tables = new Set(deriveFounderInbox(everything).map((item) => item.source.table));
    expect([...tables].sort()).toEqual([...SOURCE_TABLES].sort());
  });

  it('states the inbox ordering in exactly the vocabulary order it sorts by', () => {
    expect(INBOX_ORDERING_STATEMENT).toContain(`(${ATTENTION_KINDS.join(', ')})`);
    const ordered = deriveFounderInbox(everything).map((item) => item.kind);
    const positions = ordered.map((kind) => ATTENTION_KINDS.indexOf(kind));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
