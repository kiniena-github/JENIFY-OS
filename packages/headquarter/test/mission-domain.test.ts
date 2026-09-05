/**
 * Phase 3 Mission Core — the pure rules (issue #253).
 *
 * Everything in `mission-domain.ts` is a total function, so these tests need
 * no database and no fixture. They pin the four properties the Founder Command
 * path depends on: the normalizer copies nothing it did not classify, the
 * planner seam refuses every malformed or over-privileged plan, Goal Lock
 * revisions cannot drop a constraint silently, and status is derived from
 * truth rather than from counts.
 */

import { describe, expect, it } from 'vitest';
import { RISK_CLASSES } from '../src/operator/capabilities.js';
import {
  BASELINE_PLANNER,
  baselinePlan,
  deriveMissionStatus,
  detectFounderGates,
  intentDigest,
  missionIdempotencyKey,
  missionTaskStateFrom,
  normalizeFounderCommand,
  reviseIntent,
  riskRank,
  validatePlan,
  withinRiskCeiling,
  type MissionIntent,
  type PlannerResult,
} from '../src/application/mission-domain.js';

const EXAMPLE = 'Improve the QOS website speed without changing the design or deploying production.';

describe('normalizing a Founder command', () => {
  it('locks the objective and lifts the do-not clauses out of the example command', () => {
    const { intent, decisions, gates } = normalizeFounderCommand(EXAMPLE, { project: 'qos-ethiopia-platform' });
    expect(intent.objective).toBe('Improve the QOS website speed');
    expect(intent.doNot).toEqual(['changing the design', 'deploying production']);
    expect(intent.scope).toEqual(['project:qos-ethiopia-platform']);
    expect(intent.context).toEqual({ project: 'qos-ethiopia-platform', product: null });
    // "deploying production" is a PROHIBITION here, not a requirement, so it is
    // a constraint HQ honours rather than a gate HQ stops at.
    expect(gates).toEqual([]);
    expect(decisions).toEqual([]);
  });

  it('is deterministic', () => {
    const a = normalizeFounderCommand(EXAMPLE, { project: 'qos' });
    const b = normalizeFounderCommand(`  ${EXAMPLE}  `, { project: 'qos' });
    expect(a).toEqual(b);
    expect(intentDigest(a.intent)).toBe(intentDigest(b.intent));
  });

  it('counts unclassified sentences and never copies their text', () => {
    const { intent } = normalizeFounderCommand(
      'Speed up the checkout page. The staging password is hunter2-INTERNAL-NOTE. Keep the current design.',
    );
    const serialized = JSON.stringify(intent);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('INTERNAL-NOTE');
    expect(intent.constraints).toEqual(['Keep the current design']);
    expect(intent.unknowns.some((line) => line.startsWith('1 sentence(s) of the command were neither'))).toBe(true);
  });

  it('records the absence of a project or product as an unknown rather than guessing one', () => {
    const { intent } = normalizeFounderCommand('Speed up the checkout page.');
    expect(intent.scope).toEqual([]);
    expect(intent.unknowns[0]).toContain('No project or product was named');
  });

  it('raises a Founder-gate decision when the command REQUIRES a hard gate', () => {
    const { decisions, gates } = normalizeFounderCommand('Fix the header and deploy it to production today.');
    expect(gates.map((gate) => gate.kind)).toEqual(['production_deployment']);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.kind).toBe('founder_gate');
    expect(decisions[0]!.question).toContain('Founder hard gate');
  });

  it('raises one decision per gate kind, for spend, credentials, data and DNS alike', () => {
    const { decisions } = normalizeFounderCommand(
      'Buy credits for the image API, rotate the production API key, drop the customer data table and change the DNS.',
    );
    const questions = decisions.map((decision) => decision.question);
    expect(decisions.every((decision) => decision.kind === 'founder_gate')).toBe(true);
    expect(new Set(questions).size).toBe(decisions.length);
    expect(decisions.length).toBeGreaterThanOrEqual(4);
  });

  it('discounts a gate phrase that appears only inside a do-not clause', () => {
    expect(detectFounderGates('Ship it without deploying production', ['deploying production'])).toEqual([]);
    expect(detectFounderGates('Ship it and deploy to production', [])).toHaveLength(1);
  });

  it('still raises a gate the command REQUIRES when a do-not clause merely mentions the same word', () => {
    // The gate is required by the first sentence and only mentioned by the
    // second. Discounting by substring against the whole do-not list — rather
    // than by where the match sits — lost this decision entirely and created
    // the mission unblocked.
    const { gates, decisions } = normalizeFounderCommand('Set up DNS for the new launch domain. Do not change the DNS TTL.');
    expect(gates.map((gate) => gate.kind)).toEqual(['dns_or_domain']);
    expect(decisions.filter((decision) => decision.kind === 'founder_gate')).toHaveLength(1);
  });

  it('raises an ambiguity decision for an objective too short to plan from', () => {
    const { decisions } = normalizeFounderCommand('Fix it.');
    expect(decisions.map((decision) => decision.kind)).toEqual(['ambiguity']);
  });

  it('bounds the objective', () => {
    const { intent } = normalizeFounderCommand(`${'word '.repeat(120)}end`);
    expect(intent.objective.length).toBeLessThanOrEqual(240);
    expect(intent.objective.endsWith('…')).toBe(true);
  });
});

describe('the idempotency key', () => {
  const base = { requestedBy: 'founder', actorAuthentication: 'unauthenticated', instruction: EXAMPLE };

  it('is stable for the same command from the same principal', () => {
    expect(missionIdempotencyKey(base)).toBe(missionIdempotencyKey({ ...base, instruction: `${EXAMPLE}  ` }));
  });

  it('changes with the principal, the project, the trust marker and a caller key', () => {
    const keys = new Set([
      missionIdempotencyKey(base),
      missionIdempotencyKey({ ...base, requestedBy: 'coo' }),
      missionIdempotencyKey({ ...base, project: 'qos' }),
      missionIdempotencyKey({ ...base, actorAuthentication: 'authenticated_os_session' }),
      missionIdempotencyKey({ ...base, clientKey: 'second' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('cannot be made to collide across a field boundary', () => {
    expect(missionIdempotencyKey({ ...base, project: 'p\u0000q', product: 'r' })).not.toBe(
      missionIdempotencyKey({ ...base, project: 'p', product: 'q\u0000r' }),
    );
  });
});

describe('risk authority', () => {
  it('relies on RISK_CLASSES being declared in severity order', () => {
    expect([...RISK_CLASSES]).toEqual(['read_only', 'reversible', 'external_side_effect', 'destructive', 'founder_gate']);
    expect(riskRank('read_only')).toBeLessThan(riskRank('reversible'));
    expect(riskRank('reversible')).toBeLessThan(riskRank('external_side_effect'));
    expect(riskRank('external_side_effect')).toBeLessThan(riskRank('destructive'));
    expect(riskRank('destructive')).toBeLessThan(riskRank('founder_gate'));
  });

  it('lets a task carry equal or less authority than the ceiling, never more', () => {
    expect(withinRiskCeiling('read_only', 'reversible')).toBe(true);
    expect(withinRiskCeiling('reversible', 'reversible')).toBe(true);
    expect(withinRiskCeiling('external_side_effect', 'reversible')).toBe(false);
  });
});

describe('the planner seam', () => {
  const intent: MissionIntent = normalizeFounderCommand(EXAMPLE, { project: 'qos' }).intent;
  const mission = { riskCeiling: 'reversible' as const, scope: intent.scope, doNot: intent.doNot };

  it('produces a valid, dependency-ordered baseline plan', () => {
    const plan = baselinePlan(intent);
    expect(plan.planner).toBe(BASELINE_PLANNER);
    const validated = validatePlan(plan, mission);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.tasks.map((task) => task.key)).toEqual(['measure', 'change', 'verify']);
    expect(validated.tasks.map((task) => task.ordinal)).toEqual([0, 1, 2]);
    // Every task inherits the mission's do-not rules.
    for (const task of validated.tasks) expect(task.doNot).toEqual(expect.arrayContaining(intent.doNot));
    // Nothing in the baseline needs a Founder approval.
    expect(validated.tasks.every((task) => task.requiresFounderApproval === false)).toBe(true);
  });

  it('accepts a valid multi-task graph and orders it stably', () => {
    const plan: PlannerResult = {
      planner: 'test',
      tasks: [
        { key: 'd', title: 'D', summary: '', dependsOn: ['b', 'c'], riskClass: 'read_only' },
        { key: 'b', title: 'B', summary: '', dependsOn: ['a'], riskClass: 'read_only' },
        { key: 'c', title: 'C', summary: '', dependsOn: ['a'], riskClass: 'reversible' },
        { key: 'a', title: 'A', summary: '', dependsOn: [], riskClass: 'read_only' },
      ],
    };
    const validated = validatePlan(plan, mission);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.tasks.map((task) => task.key)).toEqual(['a', 'b', 'c', 'd']);
    // Same plan, different insertion order, same ordinals.
    const shuffled = validatePlan({ ...plan, tasks: [...plan.tasks].reverse() }, mission);
    expect(shuffled.ok && shuffled.tasks.map((task) => task.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects a cycle', () => {
    const result = validatePlan(
      {
        planner: 'test',
        tasks: [
          { key: 'a', title: 'A', summary: '', dependsOn: ['c'], riskClass: 'read_only' },
          { key: 'b', title: 'B', summary: '', dependsOn: ['a'], riskClass: 'read_only' },
          { key: 'c', title: 'C', summary: '', dependsOn: ['b'], riskClass: 'read_only' },
        ],
      },
      mission,
    );
    expect(!result.ok && result.rejection.code).toBe('dependency_cycle');
    expect(!result.ok && result.rejection.details?.cycle).toEqual(['a', 'b', 'c']);
  });

  it('rejects a missing dependency and a self dependency', () => {
    const missing = validatePlan(
      { planner: 'test', tasks: [{ key: 'a', title: 'A', summary: '', dependsOn: ['ghost'], riskClass: 'read_only' }] },
      mission,
    );
    expect(!missing.ok && missing.rejection.code).toBe('missing_dependency');
    const self = validatePlan(
      { planner: 'test', tasks: [{ key: 'a', title: 'A', summary: '', dependsOn: ['a'], riskClass: 'read_only' }] },
      mission,
    );
    expect(!self.ok && self.rejection.code).toBe('self_dependency');
  });

  it('rejects a task whose authority exceeds the mission, whatever the planner calls it', () => {
    const result = validatePlan(
      {
        planner: 'ai-planner',
        tasks: [{ key: 'deploy', title: 'Just a small deploy', summary: 'harmless', dependsOn: [], riskClass: 'external_side_effect' }],
      },
      mission,
    );
    expect(!result.ok && result.rejection.code).toBe('authority_exceeds_mission');
  });

  it('forces the approval flag from the risk class and ignores the planner', () => {
    const result = validatePlan(
      {
        planner: 'ai-planner',
        tasks: [
          // A planner claiming "no approval needed" on a destructive task.
          { key: 'wipe', title: 'Wipe', summary: '', dependsOn: [], riskClass: 'destructive', requiresFounderApproval: false } as never,
        ],
      },
      { riskCeiling: 'founder_gate', scope: [], doNot: [] },
    );
    expect(result.ok && result.tasks[0]!.requiresFounderApproval).toBe(true);
  });

  it('lets a task add do-not rules and never drop an inherited one', () => {
    const result = validatePlan(
      { planner: 'test', tasks: [{ key: 'a', title: 'A', summary: '', dependsOn: [], riskClass: 'read_only', doNot: ['touching billing'] }] },
      mission,
    );
    expect(result.ok && result.tasks[0]!.doNot).toEqual([...intent.doNot, 'touching billing']);
  });

  it('refuses a task that widens scope, and accepts one that narrows it', () => {
    const widened = validatePlan(
      { planner: 'test', tasks: [{ key: 'a', title: 'A', summary: '', dependsOn: [], riskClass: 'read_only', scope: ['project:other'] }] },
      mission,
    );
    expect(!widened.ok && widened.rejection.code).toBe('scope_widened');
    const narrowed = validatePlan(
      { planner: 'test', tasks: [{ key: 'a', title: 'A', summary: '', dependsOn: [], riskClass: 'read_only', scope: [] }] },
      mission,
    );
    expect(narrowed.ok).toBe(true);
  });

  it('refuses empty plans, duplicate keys, malformed keys and unknown risk classes', () => {
    expect(!validatePlan({ planner: 't', tasks: [] }, mission).ok).toBe(true);
    const dup = validatePlan(
      {
        planner: 't',
        tasks: [
          { key: 'a', title: 'A', summary: '', dependsOn: [], riskClass: 'read_only' },
          { key: 'a', title: 'A2', summary: '', dependsOn: [], riskClass: 'read_only' },
        ],
      },
      mission,
    );
    expect(!dup.ok && dup.rejection.code).toBe('duplicate_task_key');
    const badKey = validatePlan({ planner: 't', tasks: [{ key: 'Bad Key!', title: 'A', summary: '', dependsOn: [], riskClass: 'read_only' }] }, mission);
    expect(!badKey.ok && badKey.rejection.code).toBe('invalid_task_key');
    const badRisk = validatePlan({ planner: 't', tasks: [{ key: 'a', title: 'A', summary: '', dependsOn: [], riskClass: 'harmless' as never }] }, mission);
    expect(!badRisk.ok && badRisk.rejection.code).toBe('invalid_task');
  });
});

describe('Goal Lock revisions', () => {
  const current: MissionIntent = normalizeFounderCommand(EXAMPLE, { project: 'qos' }).intent;

  it('refuses a revision that drops a do-not rule without naming it', () => {
    const result = reviseIntent(current, { doNot: ['changing the design'] });
    expect(!result.ok && result.rejection).toEqual({ code: 'constraint_removed', removed: ['deploying production'] });
  });

  it('allows an explicitly named removal and records it', () => {
    const result = reviseIntent(current, { doNot: ['changing the design'], removeDoNot: ['deploying production'] });
    expect(result.ok && result.outcome.removedDoNot).toEqual(['deploying production']);
    expect(result.ok && result.outcome.next.doNot).toEqual(['changing the design']);
  });

  it('detects material scope expansion', () => {
    const same = reviseIntent(current, { scope: ['project:qos'] });
    expect(same.ok && same.outcome.scopeExpanded).toBe(false);
    const wider = reviseIntent(current, { scope: ['project:qos', 'product:jenify-news'] });
    expect(wider.ok && wider.outcome.scopeExpanded).toBe(true);
  });

  it('changes the intent digest when anything material changes, and not otherwise', () => {
    const unchanged = reviseIntent(current, {});
    expect(unchanged.ok && intentDigest(unchanged.outcome.next)).toBe(intentDigest(current));
    const changed = reviseIntent(current, { objective: 'Improve the QOS website speed by 30%' });
    expect(changed.ok && intentDigest(changed.outcome.next)).not.toBe(intentDigest(current));
  });
});

describe('truthful status', () => {
  const waiting = { state: 'waiting' as const, hasExecution: false };
  const working = { state: 'working' as const, hasExecution: true };
  const completed = { state: 'completed' as const, hasExecution: true };

  it('is planned until canonical work is opened', () => {
    expect(deriveMissionStatus({ lifecycle: 'open', openDecisions: 0, tasks: [waiting, waiting] })).toBe('planned');
  });

  it('is blocked on an open Founder decision, whatever the tasks say', () => {
    expect(deriveMissionStatus({ lifecycle: 'open', openDecisions: 1, tasks: [completed, completed] })).toBe('blocked');
  });

  it('is working once any execution is open and nothing is blocked', () => {
    expect(deriveMissionStatus({ lifecycle: 'open', openDecisions: 0, tasks: [completed, working, waiting] })).toBe('working');
  });

  it('never infers completion from task counts: all done means READY FOR REVIEW', () => {
    expect(deriveMissionStatus({ lifecycle: 'open', openDecisions: 0, tasks: [completed, completed] })).toBe('ready_review');
  });

  it('is blocked when any task is blocked or failed', () => {
    expect(deriveMissionStatus({ lifecycle: 'open', openDecisions: 0, tasks: [completed, { state: 'failed', hasExecution: true }] })).toBe('blocked');
  });

  it('lets explicit lifecycle decisions win', () => {
    expect(deriveMissionStatus({ lifecycle: 'cancelled', openDecisions: 3, tasks: [working] })).toBe('cancelled');
    expect(deriveMissionStatus({ lifecycle: 'verified', openDecisions: 0, tasks: [completed] })).toBe('verified');
    expect(deriveMissionStatus({ lifecycle: 'complete', openDecisions: 0, tasks: [completed] })).toBe('complete');
    expect(deriveMissionStatus({ lifecycle: 'failed', openDecisions: 0, tasks: [] })).toBe('failed');
  });

  it('maps canonical Operator truth to Founder-facing task states', () => {
    expect(missionTaskStateFrom(null)).toBe('waiting');
    expect(missionTaskStateFrom({ status: 'queued', reviewState: 'none', workerReportedFailure: false })).toBe('waiting');
    expect(missionTaskStateFrom({ status: 'assigned', reviewState: 'none', workerReportedFailure: false })).toBe('working');
    expect(missionTaskStateFrom({ status: 'running', reviewState: 'none', workerReportedFailure: false })).toBe('working');
    expect(missionTaskStateFrom({ status: 'running', reviewState: 'pending', workerReportedFailure: false })).toBe('needs_review');
    expect(missionTaskStateFrom({ status: 'needs_approval', reviewState: 'none', workerReportedFailure: false })).toBe('needs_approval');
    expect(missionTaskStateFrom({ status: 'completed', reviewState: 'passed', workerReportedFailure: false })).toBe('completed');
    expect(missionTaskStateFrom({ status: 'review_failed', reviewState: 'failed', workerReportedFailure: true })).toBe('failed');
    expect(missionTaskStateFrom({ status: 'review_failed', reviewState: 'failed', workerReportedFailure: false })).toBe('blocked');
    expect(missionTaskStateFrom({ status: 'outcome_unknown', reviewState: 'none', workerReportedFailure: false })).toBe('blocked');
    expect(missionTaskStateFrom({ status: 'blocked', reviewState: 'none', workerReportedFailure: false })).toBe('blocked');
  });
});
