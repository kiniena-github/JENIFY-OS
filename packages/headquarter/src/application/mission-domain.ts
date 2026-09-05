/**
 * Mission Core domain rules (Phase 3, issue #253) — the PURE half.
 *
 * Everything here is a total function of its arguments: no database, no
 * clock, no network, no model call. That is deliberate and load-bearing. The
 * Founder Command path turns a sentence into a canonical mission, and every
 * rule that decides what that mission MEANS — what the objective is, which
 * clauses are constraints, whether the plan is valid, whether a task may carry
 * more authority than its mission, what the mission's status truthfully is —
 * has to be checkable in a unit test with no fixture behind it. `mission-core.ts`
 * holds the persistence and the authority gates and calls into this file; it
 * decides nothing this file could have decided.
 *
 * ## Two things this module refuses to be
 *
 * 1. **An AI.** `normalizeFounderCommand` is a deterministic, rule-based
 *    normalizer. It extracts an objective and constraint clauses by fixed
 *    grammar and copies NOTHING else out of the command. It does not guess at
 *    meaning; where the command is materially ambiguous or names a Founder hard
 *    gate, it records a DECISION for the Founder rather than resolving it. A
 *    later phase may replace the normalizer with a model — the contract it
 *    must satisfy is this file's output shape plus `validatePlan`.
 * 2. **A second authority.** Risk classes here are the Operator's own
 *    (`RISK_CLASSES`), the approval rule is the Operator's own
 *    (`riskClassRequiresFounderApproval`), and a mission task's risk ceiling
 *    binds only what a planner may PROPOSE. When a task becomes canonical work
 *    it is an ordinary `op_tasks` row under the unchanged policy, approval,
 *    claim and review gates. Nothing here grants or executes.
 *
 * ## Why the raw command is never copied into the normalized intent
 *
 * The normalized intent is what the browser read model publishes so the
 * Founder can see what HQ understood. The raw instruction is Founder input that
 * may carry anything, so it stays server-side (`hq_missions.original_instruction`)
 * and the browser is handed its digest and length instead. For that split to
 * hold, the normalizer must not smuggle the raw text back in through a
 * "notes" or "remainder" field — so it does not have one. Sentences it cannot
 * classify are COUNTED, not copied, and the count is stated as an unknown.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../operator/approvals.js';
import { RISK_CLASSES, type RiskClass } from '../operator/capabilities.js';
import { riskClassRequiresFounderApproval } from '../operator/policy.js';
import type { ActivityStatus } from '../contracts/events.js';
import type { ReviewState } from '../operator/queue.js';

/* ------------------------------------------------------------------ */
/* Vocabularies                                                        */
/* ------------------------------------------------------------------ */

/** Founder-facing mission status. DERIVED — see `deriveMissionStatus`. */
export const MISSION_STATUSES = [
  'planned',
  'working',
  'blocked',
  'ready_review',
  'verified',
  'complete',
  'failed',
  'cancelled',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/**
 * The EXPLICIT lifecycle decisions a mission row stores. Everything else about
 * status is derived from tasks and decisions at read time, so the stored
 * column can never claim a completion nothing decided.
 */
export const MISSION_LIFECYCLES = ['open', 'verified', 'complete', 'failed', 'cancelled'] as const;
export type MissionLifecycle = (typeof MISSION_LIFECYCLES)[number];

/** Founder-facing task states, mapped from canonical Operator truth. */
export const MISSION_TASK_STATES = [
  'waiting',
  'working',
  'needs_review',
  'needs_approval',
  'completed',
  'blocked',
  'failed',
] as const;
export type MissionTaskState = (typeof MISSION_TASK_STATES)[number];

export const MISSION_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type MissionPriority = (typeof MISSION_PRIORITIES)[number];
export const DEFAULT_MISSION_PRIORITY: MissionPriority = 'p2';

/**
 * The risk a mission's tasks may carry unless the Founder widens it through an
 * explicit intent revision. `reversible` is the conservative default: a plan
 * may read and may make changes that can be undone; anything with an external
 * side effect, anything destructive and anything Founder-gated is REFUSED at
 * plan validation rather than planned around.
 */
export const DEFAULT_MISSION_RISK_CEILING: RiskClass = 'reversible';

export const MAX_COMMAND_LENGTH = 4000;
export const MAX_MISSION_TITLE_LENGTH = 120;
export const MAX_OBJECTIVE_LENGTH = 240;
export const MAX_PLAN_TASKS = 40;
/** Task keys are planner-chosen, stable, and part of the canonical task id. */
export const TASK_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/* ------------------------------------------------------------------ */
/* Intent                                                              */
/* ------------------------------------------------------------------ */

export interface MissionIntent {
  /** One sentence: what the mission is for. Bounded. */
  objective: string;
  /** What the mission is explicitly about — project/product links, stated as `kind:value`. */
  scope: string[];
  /** Hard constraints. A later revision may not drop one silently. */
  doNot: string[];
  /** Positive constraints the command stated ("keep …", "only …", "within …"). */
  constraints: string[];
  context: { project: string | null; product: string | null };
  /** What HQ does NOT know, stated as HQ-authored sentences — never copied text. */
  unknowns: string[];
}

export type FounderGateKind =
  | 'production_deployment'
  | 'dns_or_domain'
  | 'paid_service_or_spend'
  | 'credential_change'
  | 'destructive_data_change'
  | 'legal_or_compliance_commitment';

/** A hard Founder gate the command appears to REQUIRE (not merely forbid). */
export interface FounderGateSignal {
  kind: FounderGateKind;
  /** The matched phrase only — a few words, never the surrounding sentence. */
  phrase: string;
}

export type MissionDecisionKind = 'founder_gate' | 'ambiguity';

/** A decision HQ will not take on the Founder's behalf. */
export interface RaisedDecision {
  kind: MissionDecisionKind;
  question: string;
}

export interface NormalizedCommand {
  intent: MissionIntent;
  gates: FounderGateSignal[];
  decisions: RaisedDecision[];
}

/**
 * Phrases that open a hard-constraint clause. The clause runs to the end of
 * the sentence and is split into individual constraints on `or`/`and`/`,`.
 */
const DO_NOT_MARKERS: readonly RegExp[] = [
  /\bwithout\b/i,
  /\bdo not\b/i,
  /\bdon'?t\b/i,
  /\bnever\b/i,
  /\bmust not\b/i,
  /\bmay not\b/i,
  /\bavoid\b/i,
  /\bnot allowed to\b/i,
];

/** Phrases that open a positive constraint sentence. */
const CONSTRAINT_MARKERS: readonly RegExp[] = [
  /^(keep|only|stay within|within|preserve|maintain|limit|restrict|must)\b/i,
];

/**
 * The hard Founder gates, as detectable phrases. Matched against the WHOLE
 * command, then any match that falls inside a do-not clause is discounted —
 * "without deploying production" is a constraint HQ can honour, while "and
 * deploy to production" is a gate HQ must stop at.
 */
const FOUNDER_GATE_PATTERNS: readonly { kind: FounderGateKind; pattern: RegExp }[] = [
  { kind: 'production_deployment', pattern: /\b(deploy(?:ing|ment)?|promot(?:e|ing|ion)|release|releasing|ship(?:ping)?|publish(?:ing)?)\b[^.!?\n]{0,40}\bproduction\b/i },
  { kind: 'production_deployment', pattern: /\bproduction\s+(deploy(?:ment)?|release|promotion|rollout)\b/i },
  { kind: 'dns_or_domain', pattern: /\b(dns|custom domain|production domain|nameserver|a record|cname)\b/i },
  { kind: 'paid_service_or_spend', pattern: /\b(paid (?:api|plan|service|tier)|purchase|buy|credits?|billing|subscription|upgrade (?:the )?plan|overage|gpu upgrade)\b/i },
  { kind: 'credential_change', pattern: /\b(rotate|rotation|create|issue|expose|share)\b[^.!?\n]{0,30}\b(credential|secret|api key|token|password|private key)s?\b/i },
  { kind: 'destructive_data_change', pattern: /\b(drop|delete|wipe|truncate|purge|destroy|reset)\b[^.!?\n]{0,30}\b(production|prod|live|customer|tenant)\b[^.!?\n]{0,20}\b(data|database|table|records?)\b/i },
  { kind: 'destructive_data_change', pattern: /\bdestructive migration\b/i },
  { kind: 'legal_or_compliance_commitment', pattern: /\b(legal commitment|regulator|government|compliance (?:claim|commitment|certification)|sign (?:the |a )?contract|tax filing)\b/i },
];

const GATE_QUESTIONS: Record<FounderGateKind, string> = {
  production_deployment:
    'The command appears to require a production deployment or promotion. That is a Founder hard gate: nothing in this mission may deploy or promote until you confirm it explicitly, and confirming it here does not deploy anything.',
  dns_or_domain:
    'The command appears to require a DNS or production-domain change. That is a Founder hard gate and stays blocked until you decide it explicitly.',
  paid_service_or_spend:
    'The command appears to require a paid service, credits, billing or a plan upgrade. Default cost posture is $0 extra spend; no task may incur spend until you decide this explicitly.',
  credential_change:
    'The command appears to require creating, rotating or exposing a credential. That is a Founder hard gate; no task may touch a credential until you decide this explicitly.',
  destructive_data_change:
    'The command appears to require a destructive change to production data. That is a Founder hard gate; no task may perform it until you decide this explicitly.',
  legal_or_compliance_commitment:
    'The command appears to involve a legal, government or compliance commitment. HQ makes no such commitment on your behalf; the mission stays blocked until you decide this explicitly.',
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Sentence boundaries: `.`, `!`, `?`, `;` and line breaks. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[.!?;,:\s]+$/g, '').trim();
}

/** Split a constraint clause into its individual constraints. */
function splitClause(clause: string): string[] {
  return clause
    .split(/\s*,\s*|\s+\bor\b\s+|\s+\band\b\s+|\s+\bnor\b\s+/i)
    .map((part) => stripTerminalPunctuation(part))
    .filter((part) => part.length > 0);
}

/**
 * Find the earliest do-not marker in a sentence and return the head (before
 * it) and the clause (after it), or null when the sentence has none.
 */
function splitOnDoNot(sentence: string): { head: string; clause: string } | null {
  let earliest: { index: number; length: number } | null = null;
  for (const marker of DO_NOT_MARKERS) {
    const match = marker.exec(sentence);
    if (match && (earliest === null || match.index < earliest.index)) {
      earliest = { index: match.index, length: match[0].length };
    }
  }
  if (!earliest) return null;
  return {
    head: stripTerminalPunctuation(sentence.slice(0, earliest.index)),
    clause: sentence.slice(earliest.index + earliest.length).trim(),
  };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Turn a Founder command into a normalized intent plus the decisions HQ will
 * not make on the Founder's behalf. Deterministic: same command, same output.
 *
 * Grammar, stated so it can be checked: the FIRST sentence is the objective;
 * a do-not marker splits any sentence into head + hard-constraint clause;
 * later sentences that begin with a positive-constraint marker are
 * constraints; every other later sentence is counted and NOT copied.
 */
export function normalizeFounderCommand(
  instruction: string,
  context: { project?: string | null; product?: string | null } = {},
): NormalizedCommand {
  const text = collapseWhitespace(instruction);
  const sentences = splitSentences(text);
  const doNot: string[] = [];
  const constraints: string[] = [];
  const unknowns: string[] = [];
  let objective = '';
  let unclassified = 0;

  sentences.forEach((sentence, index) => {
    const split = splitOnDoNot(sentence);
    if (index === 0) {
      if (split) {
        objective = split.head.length > 0 ? split.head : stripTerminalPunctuation(sentence);
        doNot.push(...splitClause(split.clause));
      } else {
        objective = stripTerminalPunctuation(sentence);
      }
      return;
    }
    if (split) {
      if (split.head.length > 0 && CONSTRAINT_MARKERS.some((marker) => marker.test(split.head))) {
        constraints.push(split.head);
      }
      doNot.push(...splitClause(split.clause));
      return;
    }
    if (CONSTRAINT_MARKERS.some((marker) => marker.test(sentence))) {
      constraints.push(stripTerminalPunctuation(sentence));
      return;
    }
    unclassified += 1;
  });

  if (objective.length > MAX_OBJECTIVE_LENGTH) {
    objective = `${objective.slice(0, MAX_OBJECTIVE_LENGTH - 1).trimEnd()}…`;
  }

  const project = context.project?.trim() || null;
  const product = context.product?.trim() || null;
  const scope: string[] = [];
  if (project) scope.push(`project:${project}`);
  if (product) scope.push(`product:${product}`);
  if (scope.length === 0) {
    unknowns.push(
      'No project or product was named with the command, so the mission is not linked to one. Tasks inherit no product context until the intent is revised.',
    );
  }
  if (unclassified > 0) {
    unknowns.push(
      `${unclassified} sentence(s) of the command were neither the objective nor a constraint. They are held server-side in the original command only and were NOT planned from; revise the intent if they carry scope.`,
    );
  }

  const decisions: RaisedDecision[] = [];
  const objectiveWords = objective.split(' ').filter((word) => word.length > 0).length;
  if (objectiveWords < 3) {
    decisions.push({
      kind: 'ambiguity',
      question:
        'The objective is too short to plan from without guessing at what is wanted. State the objective in a full sentence before any task proceeds.',
    });
  }

  const gates = detectFounderGates(text, doNot);
  for (const gate of gates) {
    decisions.push({ kind: 'founder_gate', question: GATE_QUESTIONS[gate.kind] });
  }

  return {
    intent: {
      objective,
      scope,
      doNot: dedupe(doNot),
      constraints: dedupe(constraints),
      context: { project, product },
      unknowns,
    },
    gates,
    decisions: dedupeDecisions(decisions),
  };
}

function dedupeDecisions(decisions: RaisedDecision[]): RaisedDecision[] {
  const seen = new Set<string>();
  return decisions.filter((decision) => {
    const key = `${decision.kind}|${decision.question}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Founder hard gates the command appears to REQUIRE. A match whose phrase also
 * appears inside a do-not constraint is a prohibition, not a requirement, and
 * is discounted.
 */
export function detectFounderGates(text: string, doNot: readonly string[]): FounderGateSignal[] {
  const prohibited = doNot.map((clause) => clause.toLowerCase());
  const signals: FounderGateSignal[] = [];
  for (const { kind, pattern } of FOUNDER_GATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const phrase = collapseWhitespace(match[0]).toLowerCase();
    if (prohibited.some((clause) => clause.includes(phrase) || phrase.includes(clause))) continue;
    if (signals.some((signal) => signal.kind === kind)) continue;
    signals.push({ kind, phrase: phrase.length > 60 ? `${phrase.slice(0, 59)}…` : phrase });
  }
  return signals;
}

/* ------------------------------------------------------------------ */
/* Digests and idempotency                                             */
/* ------------------------------------------------------------------ */

export function commandDigest(instruction: string): string {
  return createHash('sha256').update(instruction.trim(), 'utf8').digest('hex');
}

export function intentDigest(intent: MissionIntent): string {
  return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}

/** Length-prefixed encoding, for the same reason `orders.ts` uses it. */
function encodeFields(fields: readonly string[]): string {
  return fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('');
}

/**
 * Deterministic mission idempotency key: the same principal issuing the same
 * command for the same project/product under the same trust marker is the
 * SAME mission, and a double-submitted composer dedupes onto it. A caller key
 * is mixed in, never used as the key, so no caller can name another mission.
 */
export function missionIdempotencyKey(input: {
  requestedBy: string;
  actorAuthentication: string;
  project?: string | null;
  product?: string | null;
  clientKey?: string | null;
  instruction: string;
}): string {
  const digest = createHash('sha256')
    .update(
      encodeFields([
        input.requestedBy,
        input.actorAuthentication,
        input.project ?? '',
        input.product ?? '',
        input.clientKey ?? '',
        input.instruction.trim(),
      ]),
    )
    .digest('hex');
  return `mission:${digest.slice(0, 32)}`;
}

/* ------------------------------------------------------------------ */
/* Risk authority                                                      */
/* ------------------------------------------------------------------ */

/**
 * `RISK_CLASSES` is declared in severity order and this is the one place that
 * relies on it (asserted by `test/mission-domain.test.ts`, so a reordering
 * fails loudly instead of silently inverting the ceiling).
 */
export function riskRank(riskClass: RiskClass): number {
  return RISK_CLASSES.indexOf(riskClass);
}

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === 'string' && (RISK_CLASSES as readonly string[]).includes(value);
}

/** True when `candidate` carries no more authority than `ceiling`. */
export function withinRiskCeiling(candidate: RiskClass, ceiling: RiskClass): boolean {
  return riskRank(candidate) <= riskRank(ceiling);
}

/* ------------------------------------------------------------------ */
/* Planner seam                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a planner — the deterministic baseline today, an AI worker later —
 * proposes. This is the WIRE SHAPE a later phase must produce; nothing about
 * it is trusted until `validatePlan` has accepted it.
 */
export interface PlannedTask {
  key: string;
  title: string;
  summary: string;
  dependsOn: string[];
  riskClass: RiskClass;
  /** Narrowing only: a task may name a subset of scope, never widen it. */
  scope?: string[];
  /** Additive only: a task may add do-not rules, never drop an inherited one. */
  doNot?: string[];
}

export interface PlannerResult {
  /** Who planned. Recorded on the mission so a reader knows what to trust. */
  planner: string;
  tasks: PlannedTask[];
}

/** A task after the invariants have been enforced. */
export interface ValidatedTask {
  key: string;
  ordinal: number;
  title: string;
  summary: string;
  dependsOn: string[];
  riskClass: RiskClass;
  /** Forced from the risk class; a planner's own flag is ignored. */
  requiresFounderApproval: boolean;
  scope: string[];
  /** Mission do-not rules PLUS the task's own additions. Never fewer. */
  doNot: string[];
}

export type PlanRejectionCode =
  | 'empty_plan'
  | 'too_many_tasks'
  | 'invalid_task'
  | 'invalid_task_key'
  | 'duplicate_task_key'
  | 'self_dependency'
  | 'missing_dependency'
  | 'dependency_cycle'
  | 'authority_exceeds_mission'
  | 'scope_widened';

export interface PlanRejection {
  code: PlanRejectionCode;
  message: string;
  details?: Record<string, unknown>;
}

export type PlanValidation = { ok: true; tasks: ValidatedTask[] } | { ok: false; rejection: PlanRejection };

function planFail(code: PlanRejectionCode, message: string, details?: Record<string, unknown>): PlanValidation {
  return { ok: false, rejection: { code, message, details } };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Enforce the planning invariants on a planner result, whoever produced it.
 *
 * - keys are well-formed and unique; dependencies exist and the graph is
 *   acyclic (Kahn's algorithm; ties broken by key so the ordinal is stable);
 * - no task carries more risk than the mission's ceiling — and a task whose
 *   class can require approval is marked so REGARDLESS of what the planner
 *   said about it;
 * - a task's scope may only narrow the mission's; a task's do-not list is the
 *   mission's plus its own, so a constraint can never be planned away.
 */
export function validatePlan(
  plan: PlannerResult,
  mission: { riskCeiling: RiskClass; scope: readonly string[]; doNot: readonly string[] },
): PlanValidation {
  if (!plan || !Array.isArray(plan.tasks)) {
    return planFail('invalid_task', 'A plan must carry a tasks array.');
  }
  if (plan.tasks.length === 0) {
    return planFail('empty_plan', 'A plan needs at least one task; an empty plan is not a mission.');
  }
  if (plan.tasks.length > MAX_PLAN_TASKS) {
    return planFail('too_many_tasks', `A plan may carry at most ${MAX_PLAN_TASKS} tasks.`, {
      count: plan.tasks.length,
    });
  }

  const byKey = new Map<string, PlannedTask>();
  for (const task of plan.tasks) {
    if (
      !task ||
      typeof task !== 'object' ||
      typeof task.key !== 'string' ||
      typeof task.title !== 'string' ||
      typeof task.summary !== 'string' ||
      !isStringArray(task.dependsOn) ||
      (task.scope !== undefined && !isStringArray(task.scope)) ||
      (task.doNot !== undefined && !isStringArray(task.doNot))
    ) {
      return planFail('invalid_task', 'Every task needs a key, title, summary and a dependsOn array.');
    }
    if (!TASK_KEY_PATTERN.test(task.key)) {
      return planFail('invalid_task_key', `Task key "${task.key}" is not a stable canonical key.`, {
        key: task.key,
      });
    }
    if (task.title.trim().length === 0) {
      return planFail('invalid_task', `Task "${task.key}" has no title.`, { key: task.key });
    }
    if (byKey.has(task.key)) {
      return planFail('duplicate_task_key', `Task key "${task.key}" appears more than once.`, { key: task.key });
    }
    if (!isRiskClass(task.riskClass)) {
      return planFail('invalid_task', `Task "${task.key}" names an unknown risk class.`, {
        key: task.key,
        riskClass: task.riskClass,
      });
    }
    if (!withinRiskCeiling(task.riskClass, mission.riskCeiling)) {
      return planFail(
        'authority_exceeds_mission',
        `Task "${task.key}" is planned as ${task.riskClass}, which exceeds the mission's risk ceiling ` +
          `${mission.riskCeiling}. A task may never carry more authority than its mission; widen the ` +
          'mission through an explicit intent revision if that is really intended.',
        { key: task.key, riskClass: task.riskClass, riskCeiling: mission.riskCeiling },
      );
    }
    if (task.scope) {
      const widened = task.scope.filter((entry) => !mission.scope.includes(entry));
      if (widened.length > 0) {
        return planFail('scope_widened', `Task "${task.key}" names scope the mission does not: ${widened.join(', ')}.`, {
          key: task.key,
          widened,
        });
      }
    }
    byKey.set(task.key, task);
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.key) {
        return planFail('self_dependency', `Task "${task.key}" depends on itself.`, { key: task.key });
      }
      if (!byKey.has(dependency)) {
        return planFail('missing_dependency', `Task "${task.key}" depends on "${dependency}", which is not in the plan.`, {
          key: task.key,
          dependency,
        });
      }
    }
  }

  // Kahn's algorithm with a sorted frontier, so the order is a function of the
  // plan and not of insertion order.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of plan.tasks) {
    indegree.set(task.key, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.key]);
    }
  }
  const frontier = [...indegree.entries()].filter(([, n]) => n === 0).map(([key]) => key).sort();
  const order: string[] = [];
  while (frontier.length > 0) {
    const key = frontier.shift()!;
    order.push(key);
    for (const dependent of (dependents.get(key) ?? []).sort()) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        frontier.push(dependent);
        frontier.sort();
      }
    }
  }
  if (order.length !== plan.tasks.length) {
    const stuck = [...indegree.entries()].filter(([, n]) => n > 0).map(([key]) => key).sort();
    return planFail('dependency_cycle', `The plan's dependencies form a cycle through: ${stuck.join(', ')}.`, {
      cycle: stuck,
    });
  }

  const tasks: ValidatedTask[] = order.map((key, ordinal) => {
    const task = byKey.get(key)!;
    return {
      key,
      ordinal,
      title: task.title.trim(),
      summary: task.summary.trim(),
      dependsOn: [...task.dependsOn].sort(),
      riskClass: task.riskClass,
      requiresFounderApproval: riskClassRequiresFounderApproval(task.riskClass),
      scope: task.scope ? [...task.scope] : [...mission.scope],
      doNot: dedupe([...mission.doNot, ...(task.doNot ?? [])]),
    };
  });
  return { ok: true, tasks };
}

/** The planner id the deterministic decomposition records itself under. */
export const BASELINE_PLANNER = 'hq.deterministic-baseline.v1';

/**
 * The deterministic baseline decomposition: measure → change → verify.
 *
 * It is a scaffold, and it says so in its task summaries. It does not claim to
 * know the work; it gives the Founder three canonical, dependency-ordered
 * tasks whose risk never exceeds `reversible`, each carrying the mission's
 * constraints, so the mission is dispatchable as gated Operator work the
 * moment someone opens a task. A richer planner replaces THIS function and
 * must still pass `validatePlan`.
 */
export function baselinePlan(intent: MissionIntent): PlannerResult {
  const subject = intent.objective.length > 0 ? intent.objective : 'the stated objective';
  return {
    planner: BASELINE_PLANNER,
    tasks: [
      {
        key: 'measure',
        title: 'Establish the current state and a baseline',
        summary: `Read-only investigation of "${subject}": record how things stand now and what evidence would show the objective is met. No change is made.`,
        dependsOn: [],
        riskClass: 'read_only',
      },
      {
        key: 'change',
        title: 'Make the change within scope and constraints',
        summary: `Carry out "${subject}" inside the recorded scope and every do-not rule, as a reversible change on an isolated branch or equivalent. Nothing here may deploy, spend or touch production.`,
        dependsOn: ['measure'],
        riskClass: 'reversible',
      },
      {
        key: 'verify',
        title: 'Verify the result against the baseline and constraints',
        summary: `Read-only verification that the change met "${subject}", that no do-not rule was crossed, and that the evidence is linked for Founder review.`,
        dependsOn: ['change'],
        riskClass: 'read_only',
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Intent revision                                                     */
/* ------------------------------------------------------------------ */

export type IntentRevisionRejection =
  | { code: 'constraint_removed'; removed: string[] }
  | { code: 'invalid_intent'; message: string };

export interface IntentRevisionOutcome {
  next: MissionIntent;
  scopeExpanded: boolean;
  removedDoNot: string[];
}

/**
 * Apply a revision to a current intent under the Goal Lock rules.
 *
 * A do-not rule may leave the intent only when the revision NAMES it in
 * `removeDoNot`; a revised list that merely omits one is refused. Scope
 * expansion is allowed but DETECTED and returned so the caller records it.
 */
export function reviseIntent(
  current: MissionIntent,
  revision: {
    objective?: string;
    scope?: string[];
    doNot?: string[];
    constraints?: string[];
    removeDoNot?: string[];
  },
): { ok: true; outcome: IntentRevisionOutcome } | { ok: false; rejection: IntentRevisionRejection } {
  const nextObjective = revision.objective !== undefined ? collapseWhitespace(revision.objective) : current.objective;
  if (nextObjective.length === 0 || nextObjective.length > MAX_OBJECTIVE_LENGTH) {
    return { ok: false, rejection: { code: 'invalid_intent', message: 'An objective must be a non-empty sentence.' } };
  }
  for (const [name, list] of [
    ['scope', revision.scope],
    ['doNot', revision.doNot],
    ['constraints', revision.constraints],
    ['removeDoNot', revision.removeDoNot],
  ] as const) {
    if (list !== undefined && !isStringArray(list)) {
      return { ok: false, rejection: { code: 'invalid_intent', message: `${name} must be a list of strings.` } };
    }
  }
  const explicitlyRemoved = new Set((revision.removeDoNot ?? []).map((entry) => entry.toLowerCase()));
  const proposedDoNot = revision.doNot !== undefined ? dedupe(revision.doNot.map(stripTerminalPunctuation)) : [...current.doNot];
  const proposedLower = new Set(proposedDoNot.map((entry) => entry.toLowerCase()));
  const silentlyRemoved = current.doNot.filter(
    (entry) => !proposedLower.has(entry.toLowerCase()) && !explicitlyRemoved.has(entry.toLowerCase()),
  );
  if (silentlyRemoved.length > 0) {
    return { ok: false, rejection: { code: 'constraint_removed', removed: silentlyRemoved } };
  }
  const nextDoNot = proposedDoNot.filter((entry) => !explicitlyRemoved.has(entry.toLowerCase()));
  const removedDoNot = current.doNot.filter((entry) => explicitlyRemoved.has(entry.toLowerCase()));
  const nextScope = revision.scope !== undefined ? dedupe(revision.scope) : [...current.scope];
  const scopeExpanded = nextScope.some((entry) => !current.scope.includes(entry));
  return {
    ok: true,
    outcome: {
      next: {
        objective: nextObjective,
        scope: nextScope,
        doNot: nextDoNot,
        constraints: revision.constraints !== undefined ? dedupe(revision.constraints) : [...current.constraints],
        context: current.context,
        unknowns: current.unknowns,
      },
      scopeExpanded,
      removedDoNot,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Status derivation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Founder-facing task state from canonical Operator truth. `null` execution
 * means no canonical task has been opened for it yet: it is waiting.
 *
 * The queue files BOTH a worker's own `fail()` and an independent reviewer's
 * rejection under `review_failed`; they differ only in the evidence kind
 * written alongside (`execution_failed` versus `review_failed`). The caller
 * reads that evidence and says which it was, so `failed` here means "the
 * executing worker reported failure" and `blocked` means everything the
 * Founder must unblock, including a rejected review and an unknown outcome.
 */
export function missionTaskStateFrom(
  execution: { status: ActivityStatus; reviewState: ReviewState; workerReportedFailure: boolean } | null,
): MissionTaskState {
  if (!execution) return 'waiting';
  switch (execution.status) {
    case 'queued':
      return 'waiting';
    case 'assigned':
      return 'working';
    case 'running':
      return execution.reviewState === 'pending' ? 'needs_review' : 'working';
    case 'needs_approval':
      return 'needs_approval';
    case 'review_passed':
    case 'completed':
      return 'completed';
    case 'review_failed':
      return execution.workerReportedFailure ? 'failed' : 'blocked';
    case 'blocked':
    case 'outcome_unknown':
      return 'blocked';
  }
}

/**
 * The mission's truthful status.
 *
 * Explicit lifecycle decisions win. Otherwise: an open decision or a blocked
 * or failed task blocks the mission; every task completed makes it READY FOR
 * REVIEW — never complete, because completion is a Founder decision about
 * evidence and not a count; any opened execution makes it working; nothing
 * opened is planned.
 */
export function deriveMissionStatus(input: {
  lifecycle: MissionLifecycle;
  openDecisions: number;
  tasks: readonly { state: MissionTaskState; hasExecution: boolean }[];
}): MissionStatus {
  if (input.lifecycle !== 'open') return input.lifecycle;
  if (input.openDecisions > 0) return 'blocked';
  if (input.tasks.some((task) => task.state === 'blocked' || task.state === 'failed')) return 'blocked';
  if (input.tasks.length > 0 && input.tasks.every((task) => task.state === 'completed')) return 'ready_review';
  if (input.tasks.some((task) => task.hasExecution && task.state !== 'completed')) return 'working';
  return 'planned';
}
