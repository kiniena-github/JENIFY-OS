/**
 * Mission Core (Phase 3, issue #253) — the Founder Command path made canonical.
 *
 * ## What a mission is, next to what already exists
 *
 * HQ already had two "mission" things and this module is deliberately a third,
 * sitting BESIDE both rather than replacing either:
 *
 *   - `hq_mission_proposals` (`missions.ts`) is an INERT chat-room proposal for
 *     ONE capability invocation. It stays exactly as it was; its tests are
 *     untouched. It answers "may this discussed action become a task".
 *   - `hq.direct_order` (`live/orders.ts`) is ONE free-text instruction that
 *     becomes ONE Founder-gated `op_tasks` row. It stays exactly as it was.
 *   - A Phase 3 MISSION is a locked goal with explicit constraints and a
 *     structured, dependency-ordered TASK PLAN. It owns no execution authority
 *     of its own: every mission task becomes real work only by opening an
 *     ordinary `op_tasks` row through `HeadquarterOperations.createTask`, under
 *     the unchanged capability registry, policy, approval-digest, claim-fence,
 *     provider-binding, review and kill-switch rules.
 *
 * Extending the proposal table was considered and rejected: a proposal is one
 * capability + one payload, and bolting a goal, an intent history, a task graph
 * and a decision list onto that row would have made an inert record carry
 * authority-shaped fields. Separate tables keep "inert proposal" inert.
 *
 * ## Where the authority is, and why this class holds none of its own
 *
 * `MissionCore` is constructed ONLY by `HeadquarterOperations`, which hands it
 * closures over its own `#private` gates: the requester resolver (deny by
 * default; registry allow-lists, never a caller's), the approval-authority
 * assertion (the same gate as the kill switch), the privileged queue (the only
 * evidence writer and the only transaction), the canonical capability row read
 * (`capabilityRowFor`'s substrate), and `createTask`/`denyTask` themselves. A
 * caller holding `ops.missions` therefore reaches exactly the same authority
 * boundary as a caller holding `ops`, one object over, and nothing this class
 * does can be reached without passing one of those gates. It has no public
 * write method that skips resolution — the standing rule of `service.ts`
 * applies here verbatim.
 *
 * ## The Founder Command capability
 *
 * Issuing a Founder Command is authorized like placing a direct order: the
 * acting principal must hold the ORIGINATE grant for `hq.founder_command` in
 * the human-principal registry, the capability must be registered, enabled and
 * unaltered, and the kill switch must be clear for it. Registering it is a
 * separate configuration act (`registerFounderCommandCapability`); issuing a
 * command never performs it and never re-enables a disabled row. A mission is
 * NOT an `op_tasks` row and executes nothing, so the class is `founder_gate`
 * with no side effect: the gate it carries is "who may command HQ at all", and
 * it is deny by default like every other.
 *
 * ## Goal Lock, concretely
 *
 *   - the original command is written once and never updated;
 *   - the normalized intent is versioned (`hq_mission_intents`), and every
 *     mutation that depends on intent — revision, cancellation, outcome,
 *     opening task work — carries `expectedIntentVersion` and is REFUSED when
 *     stale, so an actor holding an older reading of the Founder's intent
 *     cannot overwrite a newer one;
 *   - a do-not rule leaves the intent only when the revision names it;
 *   - an execution opened under intent v1 is marked STALE after v2, and
 *     `HeadquarterOperations.approveTask` refuses to approve it (a stricter
 *     precondition on the existing gate, not a second approval system).
 *
 * ## What the browser is told
 *
 * `MissionView` is the ONLY shape this module hands to a read model. It
 * carries the normalized intent, the plan, the decisions and the derived
 * status — and the command's digest and length in place of its text. The raw
 * instruction has no getter here; it is read by `manifest()` for a future
 * worker prompt, server-side, and by nothing else.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import type { NewActivityEvent } from '../contracts/events.js';
import { CapabilityRegistry, type Capability, type RiskClass } from '../operator/capabilities.js';
import type { OperatorTask, PrivilegedQueueApi } from '../operator/queue.js';
import { assertNoSecretLikeContent } from '../operator/evidence.js';
import type { CreateTaskInput, CreatedTask, OpsError, OpsErrorCode, OpsResult } from './service.js';
import {
  DEFAULT_MISSION_PRIORITY,
  DEFAULT_MISSION_RISK_CEILING,
  MAX_COMMAND_LENGTH,
  MAX_MISSION_TITLE_LENGTH,
  MISSION_PRIORITIES,
  baselinePlan,
  commandDigest,
  deriveMissionStatus,
  intentDigest,
  isRiskClass,
  missionIdempotencyKey,
  missionTaskStateFrom,
  normalizeFounderCommand,
  reviseIntent as reviseIntentRules,
  validatePlan,
  withinRiskCeiling,
  type MissionDecisionKind,
  type MissionIntent,
  type MissionLifecycle,
  type MissionPriority,
  type MissionStatus,
  type MissionTaskState,
  type PlannerResult,
  type ValidatedTask,
} from './mission-domain.js';

/* ------------------------------------------------------------------ */
/* The Founder Command capability                                      */
/* ------------------------------------------------------------------ */

export const FOUNDER_COMMAND_CAPABILITY = {
  id: 'hq.founder_command',
  description:
    'Founder Command — a high-level instruction HQ turns into a canonical mission with a locked goal, ' +
    'explicit constraints and a structured task plan. Creates no Operator task by itself; every mission ' +
    'task becomes work only through the ordinary gated task path.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const;

/** Configuration action. Never re-enables a disabled row (see `CapabilityRegistry.register`). */
export function registerFounderCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...FOUNDER_COMMAND_CAPABILITY });
}

export const FOUNDER_COMMAND_RESERVED_CONTRACT = {
  riskClass: FOUNDER_COMMAND_CAPABILITY.riskClass,
  sideEffect: FOUNDER_COMMAND_CAPABILITY.sideEffect,
  idempotent: FOUNDER_COMMAND_CAPABILITY.idempotent,
} as const;

export function founderCommandContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== FOUNDER_COMMAND_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== FOUNDER_COMMAND_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== FOUNDER_COMMAND_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type FounderCommandCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/** The reserved payload key an opened mission task carries. Inside the approval digest by construction. */
export const MISSION_BINDING_KEY = 'missionBinding';

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export type MissionErrorCode =
  | OpsErrorCode
  | 'empty_command'
  | 'command_too_long'
  | 'title_too_long'
  | 'unsafe_command'
  | 'capability_not_registered'
  | 'capability_definition_altered'
  | 'mission_not_found'
  | 'mission_not_open'
  | 'mission_status_forbids'
  | 'stale_intent_version'
  | 'constraint_removed'
  | 'plan_rejected'
  | 'decision_not_found'
  | 'mission_task_not_found'
  | 'mission_task_already_opened'
  | 'dependencies_incomplete'
  | 'authority_exceeds_task'
  | 'cancellation_blocked'
  | 'reserved_payload_key';

export interface MissionError {
  code: MissionErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type MissionResult<T> = { ok: true; data: T } | { ok: false; error: MissionError };

function fail(code: MissionErrorCode, message: string, details?: Record<string, unknown>): MissionResult<never> {
  return { ok: false, error: { code, message, details } };
}

function ok<T>(data: T): MissionResult<T> {
  return { ok: true, data };
}

function fromOps(error: OpsError): MissionResult<never> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface FounderCommandInput {
  /** The Founder's instruction. Stored server-side only; normalized for the browser. */
  instruction: string;
  /** The acting principal. Authorized against the registry; never authenticated here. */
  requestedBy: string;
  /** Published label. Omitted → a neutral default that reveals nothing about the command. */
  title?: string;
  project?: string;
  product?: string;
  priority?: MissionPriority;
  /** Most authority any planned task may carry. Defaults to `reversible`. */
  riskCeiling?: RiskClass;
  /** Mixed into the derived idempotency key so a deliberate repeat is a new mission. */
  idempotencyKey?: string;
  /**
   * A structured planner result to validate INSTEAD of the deterministic
   * baseline. The seam a later AI planner uses; `validatePlan` decides, not
   * the planner.
   */
  plan?: PlannerResult;
  /** Recorded on the mission. Callers may assert only the caller-assertable vocabulary. */
  actorAuthentication?: string;
}

export interface FounderCommandReceipt {
  mission: MissionView;
  deduplicated: boolean;
}

export interface ReviseIntentInput {
  missionId: string;
  founderId: string;
  expectedIntentVersion: number;
  objective?: string;
  scope?: string[];
  doNot?: string[];
  constraints?: string[];
  /** Every do-not rule being dropped must be NAMED here, or the revision is refused. */
  removeDoNot?: string[];
  riskCeiling?: RiskClass;
  note: string;
}

export interface ResolveDecisionInput {
  missionId: string;
  decisionId: string;
  founderId: string;
  expectedIntentVersion: number;
  resolution: string;
}

export interface CancelMissionInput {
  missionId: string;
  founderId: string;
  expectedIntentVersion: number;
  reason: string;
}

export interface DecideOutcomeInput {
  missionId: string;
  founderId: string;
  expectedIntentVersion: number;
  decision: 'verified' | 'complete' | 'failed';
  note: string;
}

export interface OpenTaskWorkInput {
  missionId: string;
  missionTaskId: string;
  /** Worker or human principal opening the canonical work. Registry-authorized. */
  requestedBy: string;
  expectedIntentVersion: number;
  capabilityId: string;
  payload: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Read model                                                          */
/* ------------------------------------------------------------------ */

export interface MissionTaskExecutionView {
  taskId: string;
  /** Canonical Operator status, copied. */
  status: string;
  reviewState: string;
  capabilityId: string;
  /** Intent version the execution was opened under. */
  intentVersion: number;
  /** True when the mission's intent moved on after this execution was opened. */
  stale: boolean;
  blockReason: string | null;
}

export interface MissionTaskView {
  id: string;
  key: string;
  ordinal: number;
  title: string;
  summary: string;
  dependsOn: string[];
  riskClass: RiskClass;
  requiresFounderApproval: boolean;
  scope: string[];
  doNot: string[];
  intentVersion: number;
  state: MissionTaskState;
  execution: MissionTaskExecutionView | null;
}

export interface MissionDecisionView {
  id: string;
  kind: MissionDecisionKind;
  question: string;
  status: 'open' | 'resolved';
  raisedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface MissionView {
  id: string;
  title: string;
  status: MissionStatus;
  lifecycle: MissionLifecycle;
  priority: MissionPriority;
  riskCeiling: RiskClass;
  project: string | null;
  product: string | null;
  createdBy: string;
  actorAuthentication: string;
  createdAt: string;
  updatedAt: string;
  /** Provenance of the command WITHOUT its text: digest and length only. */
  commandDigest: string;
  commandLength: number;
  intentVersion: number;
  intentDigest: string;
  intent: MissionIntent;
  planner: string;
  tasks: MissionTaskView[];
  decisions: MissionDecisionView[];
  /** Why the mission is blocked, in one line, when it is. */
  blockReason: string | null;
  /** https evidence refs submitted on the mission's executions. Never a local path. */
  evidenceRefs: string[];
  outcome: { decision: MissionLifecycle; by: string; at: string; note: string | null } | null;
}

/**
 * The compact authoritative manifest a later worker prompt consumes instead of
 * an ad-hoc chat summary. SERVER-SIDE: it includes the original command.
 */
export interface MissionManifest {
  missionId: string;
  title: string;
  status: MissionStatus;
  intentVersion: number;
  intentDigest: string;
  commandDigest: string;
  originalInstruction: string;
  intent: MissionIntent;
  riskCeiling: RiskClass;
  priority: MissionPriority;
  tasks: Pick<MissionTaskView, 'id' | 'key' | 'title' | 'summary' | 'dependsOn' | 'riskClass' | 'doNot' | 'scope' | 'state'>[];
  openDecisions: Pick<MissionDecisionView, 'id' | 'kind' | 'question'>[];
}

/* ------------------------------------------------------------------ */
/* Dependencies handed in by HeadquarterOperations                     */
/* ------------------------------------------------------------------ */

/** Who an actor turned out to be. Mirrors `service.ts`'s private type. */
export interface MissionRequester {
  kind: 'worker' | 'human';
  allowedCapabilities: readonly string[];
}

export interface MissionCoreDeps {
  db: HqDatabase;
  privileged: () => PrivilegedQueueApi;
  resolveRequester: (actor: string, action: string) => OpsResult<MissionRequester>;
  /** Null when the actor holds approval authority; otherwise the refusal. */
  assertApprovalAuthority: (actor: string, action: string) => { ok: false; error: OpsError } | null;
  capabilityRow: (capabilityId: string) => Capability | null;
  killSwitchEngaged: (capabilityId: string) => boolean;
  taskById: (taskId: string) => OperatorTask | null;
  createTask: (input: CreateTaskInput) => OpsResult<CreatedTask>;
  denyTask: (input: { taskId: string; founderId: string; reason: string }) => OpsResult<OperatorTask>;
  appendEvent: (event: NewActivityEvent) => void;
  /** Whether a caller-supplied trust marker is one a caller may assert. */
  isCallerAssertableActorAuthentication: (value: string) => boolean;
  defaultActorAuthentication: string;
}

interface MissionRow {
  id: string;
  title: string;
  original_instruction: string;
  command_digest: string;
  intent_version: number;
  intent: string;
  intent_digest: string;
  planner: string;
  project: string | null;
  product: string | null;
  priority: string;
  risk_ceiling: string;
  lifecycle: string;
  idempotency_key: string;
  created_by: string;
  actor_authentication: string;
  created_at: string;
  updated_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

interface TaskRow {
  id: string;
  mission_id: string;
  task_key: string;
  ordinal: number;
  title: string;
  summary: string;
  depends_on: string;
  risk_class: string;
  requires_founder_approval: number;
  scope: string;
  do_not: string;
  intent_version: number;
  op_task_id: string | null;
  execution_intent_version: number | null;
}

interface DecisionRow {
  id: string;
  mission_id: string;
  kind: string;
  question: string;
  status: string;
  raised_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

/** Op statuses that make honest cancellation impossible from this layer. */
const UNCANCELLABLE_EXECUTION_STATUSES: readonly string[] = ['queued', 'assigned', 'running', 'outcome_unknown'];

export const MISSION_LIST_LIMIT = 100;

function parseJsonArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export class MissionCore {
  /** `#private` for the same reason every other database handle in this layer is. */
  readonly #db: HqDatabase;
  readonly #deps: MissionCoreDeps;

  constructor(deps: MissionCoreDeps) {
    this.#db = deps.db;
    this.#deps = deps;
  }

  /* ---------------- capability state ---------------- */

  /** Registry state of `hq.founder_command`, from the canonical row. */
  capabilityState(): FounderCommandCapabilityState {
    const capability = this.#deps.capabilityRow(FOUNDER_COMMAND_CAPABILITY.id);
    if (!capability) return 'missing';
    if (founderCommandContractDrift(capability).length > 0) return 'altered';
    return capability.enabled ? 'enabled' : 'disabled';
  }

  /* ---------------- Founder Command ---------------- */

  /**
   * Turn a Founder command into a canonical mission, atomically and
   * idempotently. Refusals happen BEFORE the first write; the mission row, its
   * v1 intent, its tasks, its decisions and its evidence commit together or
   * not at all.
   */
  createFromCommand(input: FounderCommandInput, options: { resolvedActorAuthentication?: string } = {}): MissionResult<FounderCommandReceipt> {
    const instruction = (input.instruction ?? '').trim();
    if (instruction.length === 0) return fail('empty_command', 'A Founder command needs an instruction.');
    if (instruction.length > MAX_COMMAND_LENGTH) {
      return fail('command_too_long', `A Founder command may be at most ${MAX_COMMAND_LENGTH} characters.`, {
        length: instruction.length,
      });
    }
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required.');
    const title = (input.title ?? '').trim();
    if (title.length > MAX_MISSION_TITLE_LENGTH) {
      return fail('title_too_long', `A mission title may be at most ${MAX_MISSION_TITLE_LENGTH} characters.`, {
        length: title.length,
      });
    }
    const priority = input.priority ?? DEFAULT_MISSION_PRIORITY;
    if (!MISSION_PRIORITIES.includes(priority)) {
      return fail('invalid_input', `Unknown priority: ${String(priority)}. Choose one of ${MISSION_PRIORITIES.join(', ')}.`);
    }
    const riskCeiling = input.riskCeiling ?? DEFAULT_MISSION_RISK_CEILING;
    if (!isRiskClass(riskCeiling)) {
      return fail('invalid_input', `Unknown risk ceiling: ${String(riskCeiling)}.`);
    }
    if (input.actorAuthentication !== undefined && !this.#deps.isCallerAssertableActorAuthentication(input.actorAuthentication)) {
      return fail(
        'invalid_input',
        'Unusable actorAuthentication marker. A value that must be EARNED is refused from a caller asserting it; ' +
          'the authenticated value reaches a mission only from the interface that resolved the identity.',
      );
    }
    const actorAuthentication =
      options.resolvedActorAuthentication ?? input.actorAuthentication ?? this.#deps.defaultActorAuthentication;

    // Fail closed on the capability's CURRENT configured state; never touch it.
    const capabilityState = this.capabilityState();
    if (capabilityState === 'missing') {
      return fail(
        'capability_not_registered',
        `Capability ${FOUNDER_COMMAND_CAPABILITY.id} is not registered here. Registering it is a separate, ` +
          'deliberate configuration action — issuing a command never performs it.',
      );
    }
    if (capabilityState === 'altered') {
      const row = this.#deps.capabilityRow(FOUNDER_COMMAND_CAPABILITY.id);
      const drift = row ? founderCommandContractDrift(row) : [];
      return fail(
        'capability_definition_altered',
        `Capability ${FOUNDER_COMMAND_CAPABILITY.id} no longer matches its reserved contract (${drift.join(', ')}). ` +
          'The command is refused; restoring the definition is an explicit configuration action.',
        { drift },
      );
    }
    if (capabilityState === 'disabled') {
      return fail('capability_disabled', `Capability ${FOUNDER_COMMAND_CAPABILITY.id} is disabled.`);
    }
    if (this.#deps.killSwitchEngaged(FOUNDER_COMMAND_CAPABILITY.id)) {
      return fail('kill_switch_engaged', `Kill switch is engaged for ${FOUNDER_COMMAND_CAPABILITY.id}.`);
    }

    // The registry, not the caller: an id that is not a registered principal
    // holding the originate grant commands nothing.
    const requester = this.#deps.resolveRequester(input.requestedBy, 'issue a Founder command');
    if (!requester.ok) return fromOps(requester.error);
    if (requester.data.kind !== 'human') {
      return fail('not_permitted', `Registered worker ${input.requestedBy} cannot issue a Founder command: only a human principal may.`, {
        actor: input.requestedBy,
      });
    }
    if (!requester.data.allowedCapabilities.includes(FOUNDER_COMMAND_CAPABILITY.id)) {
      return fail(
        'not_permitted',
        `${input.requestedBy} is not granted ${FOUNDER_COMMAND_CAPABILITY.id} (least privilege). Nothing was created.`,
        { actor: input.requestedBy },
      );
    }

    // Everything published or evidenced is scanned before the first write.
    try {
      assertNoSecretLikeContent({
        instruction,
        title: title || null,
        project: input.project ?? null,
        product: input.product ?? null,
      });
    } catch {
      return fail(
        'unsafe_command',
        'The command looks like it contains a credential. Missions are recorded permanently and their ' +
          'normalized intent is shown in the Founder console, so nothing was created.',
      );
    }

    const normalized = normalizeFounderCommand(instruction, { project: input.project, product: input.product });
    const plan = input.plan ?? baselinePlan(normalized.intent);
    const validation = validatePlan(plan, {
      riskCeiling,
      scope: normalized.intent.scope,
      doNot: normalized.intent.doNot,
    });
    if (!validation.ok) {
      return fail('plan_rejected', validation.rejection.message, {
        rejection: validation.rejection.code,
        ...validation.rejection.details,
      });
    }
    if (typeof plan.planner !== 'string' || plan.planner.trim().length === 0) {
      return fail('plan_rejected', 'A plan must name its planner.', { rejection: 'invalid_task' });
    }

    const idempotencyKey = missionIdempotencyKey({
      requestedBy: input.requestedBy,
      actorAuthentication,
      project: input.project ?? null,
      product: input.product ?? null,
      clientKey: input.idempotencyKey ?? null,
      instruction,
    });
    const digest = commandDigest(instruction);
    const intentHash = intentDigest(normalized.intent);
    const project = input.project?.trim() || null;
    const product = input.product?.trim() || null;
    const effectiveTitle = title || defaultTitle(project, product);

    const privileged = this.#deps.privileged();
    const receipt = privileged.reserve((): FounderCommandReceipt => {
      // Inside the IMMEDIATE transaction, so two concurrent identical commands
      // cannot both pass the check and both insert.
      const existing = this.#db
        .prepare(`SELECT id FROM hq_missions WHERE idempotency_key = ?`)
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        return { mission: this.get(existing.id)!, deduplicated: true };
      }
      const id = uuid();
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_missions
             (id, title, original_instruction, command_digest, intent_version, intent, intent_digest, planner,
              project, product, priority, risk_ceiling, lifecycle, idempotency_key, created_by,
              actor_authentication, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          effectiveTitle,
          instruction,
          digest,
          JSON.stringify(normalized.intent),
          intentHash,
          plan.planner,
          project,
          product,
          priority,
          riskCeiling,
          idempotencyKey,
          input.requestedBy,
          actorAuthentication,
          at,
          at,
        );
      this.#db
        .prepare(
          `INSERT INTO hq_mission_intents (mission_id, version, intent, intent_digest, changed_by, changed_at, note)
           VALUES (?, 1, ?, ?, ?, ?, 'Original Founder command, normalized')`,
        )
        .run(id, JSON.stringify(normalized.intent), intentHash, input.requestedBy, at);
      this.#insertTasks(id, validation.tasks, 1, at);
      for (const decision of normalized.decisions) {
        this.#db
          .prepare(
            `INSERT INTO hq_mission_decisions (id, mission_id, kind, question, status, raised_at)
             VALUES (?, ?, ?, ?, 'open', ?)`,
          )
          .run(uuid(), id, decision.kind, decision.question, at);
      }
      // Evidence names digests, counts and ids — never the command text.
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'mission_created',
        payload: {
          missionId: id,
          commandDigest: digest,
          intentVersion: 1,
          intentDigest: intentHash,
          planner: plan.planner,
          taskCount: validation.tasks.length,
          decisionCount: normalized.decisions.length,
          founderGates: normalized.gates.map((gate) => gate.kind),
          riskCeiling,
          actorAuthentication,
          executable: false,
        },
      });
      const mission = this.get(id)!;
      this.#deps.appendEvent({
        subjectKind: 'mission',
        subjectId: id,
        status: null,
        actor: input.requestedBy,
        summary: `Mission created from a Founder command (${validation.tasks.length} task(s), ${normalized.decisions.length} decision(s) open)`,
        detail: { missionStatus: mission.status, project: project ?? undefined, title: effectiveTitle },
      });
      return { mission, deduplicated: false };
    });
    return ok(receipt);
  }

  #insertTasks(missionId: string, tasks: readonly ValidatedTask[], intentVersion: number, at: string): void {
    const insert = this.#db.prepare(
      `INSERT INTO hq_mission_tasks
         (id, mission_id, task_key, ordinal, title, summary, depends_on, risk_class, requires_founder_approval,
          scope, do_not, intent_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const task of tasks) {
      insert.run(
        // Stable and canonical: derived from the mission id and the planner's
        // key, so the same plan replayed names the same task.
        `${missionId}/${task.key}`,
        missionId,
        task.key,
        task.ordinal,
        task.title,
        task.summary,
        JSON.stringify(task.dependsOn),
        task.riskClass,
        task.requiresFounderApproval ? 1 : 0,
        JSON.stringify(task.scope),
        JSON.stringify(task.doNot),
        intentVersion,
        at,
        at,
      );
    }
  }

  /* ---------------- Goal Lock: intent revision ---------------- */

  /**
   * Revise the current intent as a NEW version. Founder authority, fenced on
   * the version the caller read, do-not rules removable only by name, scope
   * expansion recorded, existing tasks re-checked against a narrowed ceiling.
   */
  reviseIntent(input: ReviseIntentInput): MissionResult<MissionView> {
    const refusal = this.#deps.assertApprovalAuthority(input.founderId, 'revise a mission intent');
    if (refusal) return fromOps(refusal.error);
    if (!input.note?.trim()) return fail('invalid_input', 'An intent revision requires a note.');
    const row = this.#row(input.missionId);
    if (!row) return fail('mission_not_found', `Unknown mission: ${input.missionId}`);
    if (row.lifecycle !== 'open') {
      return fail('mission_not_open', `Mission ${row.id} is ${row.lifecycle}; its intent is closed.`, { lifecycle: row.lifecycle });
    }
    const stale = this.#fence(row, input.expectedIntentVersion);
    if (stale) return stale;
    const current = JSON.parse(row.intent) as MissionIntent;
    const revised = reviseIntentRules(current, input);
    if (!revised.ok) {
      if (revised.rejection.code === 'constraint_removed') {
        return fail(
          'constraint_removed',
          `The revision drops do-not rule(s) without naming them: ${revised.rejection.removed.join('; ')}. A constraint ` +
            'may leave a mission only when the revision names it in removeDoNot.',
          { removed: revised.rejection.removed },
        );
      }
      return fail('invalid_input', revised.rejection.message);
    }
    const nextCeiling = input.riskCeiling ?? (row.risk_ceiling as RiskClass);
    if (!isRiskClass(nextCeiling)) return fail('invalid_input', `Unknown risk ceiling: ${String(nextCeiling)}.`);
    const exceeding = this.#taskRows(row.id).filter((task) => !withinRiskCeiling(task.risk_class as RiskClass, nextCeiling));
    if (exceeding.length > 0) {
      return fail(
        'plan_rejected',
        `Narrowing the risk ceiling to ${nextCeiling} would leave task(s) above it: ${exceeding.map((t) => t.task_key).join(', ')}. ` +
          'A task may never carry more authority than its mission.',
        { rejection: 'authority_exceeds_mission', tasks: exceeding.map((t) => t.task_key) },
      );
    }
    try {
      assertNoSecretLikeContent({ note: input.note, intent: revised.outcome.next });
    } catch {
      return fail('invalid_input', 'The revision looks like it contains a credential; nothing was written.');
    }

    const privileged = this.#deps.privileged();
    const view = privileged.reserve((): MissionView => {
      const at = nowIso();
      const version = row.intent_version + 1;
      const hash = intentDigest(revised.outcome.next);
      this.#db
        .prepare(
          `INSERT INTO hq_mission_intents
             (mission_id, version, intent, intent_digest, changed_by, changed_at, note, scope_expanded, removed_do_not)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          version,
          JSON.stringify(revised.outcome.next),
          hash,
          input.founderId,
          at,
          input.note.trim(),
          revised.outcome.scopeExpanded ? 1 : 0,
          revised.outcome.removedDoNot.length > 0 ? JSON.stringify(revised.outcome.removedDoNot) : null,
        );
      // Fenced UPDATE: the row must still be at the version the caller read.
      const updated = this.#db
        .prepare(
          `UPDATE hq_missions SET intent = ?, intent_digest = ?, intent_version = ?, risk_ceiling = ?, updated_at = ?
           WHERE id = ? AND intent_version = ?`,
        )
        .run(JSON.stringify(revised.outcome.next), hash, version, nextCeiling, at, row.id, row.intent_version);
      if (updated.changes !== 1) {
        throw new Error(`Mission ${row.id} moved past intent version ${row.intent_version} during the revision`);
      }
      privileged.appendEvidence({
        actor: input.founderId,
        kind: 'mission_intent_revised',
        payload: {
          missionId: row.id,
          fromVersion: row.intent_version,
          toVersion: version,
          intentDigest: hash,
          scopeExpanded: revised.outcome.scopeExpanded,
          removedDoNot: revised.outcome.removedDoNot,
          riskCeiling: nextCeiling,
          staleExecutions: this.#taskRows(row.id).filter((t) => t.op_task_id !== null).length,
        },
      });
      const mission = this.get(row.id)!;
      this.#deps.appendEvent({
        subjectKind: 'mission',
        subjectId: row.id,
        status: null,
        actor: input.founderId,
        summary: `Mission intent revised to v${version}${revised.outcome.scopeExpanded ? ' (scope expanded)' : ''}`,
        detail: { missionStatus: mission.status, project: row.project ?? undefined, title: row.title },
      });
      return mission;
    });
    return ok(view);
  }

  /* ---------------- decisions ---------------- */

  /**
   * The Founder answers an open decision. Resolving a `founder_gate` decision
   * UNBLOCKS the mission's status and authorizes nothing: a task that would
   * deploy, spend or destroy still needs its own capability, its own approval
   * digest and its own step-up when it is opened as canonical work.
   */
  resolveDecision(input: ResolveDecisionInput): MissionResult<MissionView> {
    const refusal = this.#deps.assertApprovalAuthority(input.founderId, 'resolve a mission decision');
    if (refusal) return fromOps(refusal.error);
    if (!input.resolution?.trim()) return fail('invalid_input', 'Resolving a decision requires a resolution note.');
    const row = this.#row(input.missionId);
    if (!row) return fail('mission_not_found', `Unknown mission: ${input.missionId}`);
    if (row.lifecycle !== 'open') return fail('mission_not_open', `Mission ${row.id} is ${row.lifecycle}.`);
    const stale = this.#fence(row, input.expectedIntentVersion);
    if (stale) return stale;
    const decision = this.#db
      .prepare(`SELECT * FROM hq_mission_decisions WHERE id = ? AND mission_id = ?`)
      .get(input.decisionId, row.id) as DecisionRow | undefined;
    if (!decision) return fail('decision_not_found', `Unknown decision ${input.decisionId} on mission ${row.id}`);
    if (decision.status !== 'open') return fail('invalid_input', `Decision ${decision.id} is already resolved.`);
    try {
      assertNoSecretLikeContent({ resolution: input.resolution });
    } catch {
      return fail('invalid_input', 'The resolution looks like it contains a credential; nothing was written.');
    }
    const privileged = this.#deps.privileged();
    const view = privileged.reserve((): MissionView => {
      const at = nowIso();
      this.#db
        .prepare(
          `UPDATE hq_mission_decisions SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(input.founderId, at, input.resolution.trim(), decision.id);
      this.#touch(row.id, at);
      privileged.appendEvidence({
        actor: input.founderId,
        kind: 'mission_decision_resolved',
        payload: { missionId: row.id, decisionId: decision.id, kind: decision.kind, intentVersion: row.intent_version, authorizes: 'nothing' },
      });
      const mission = this.get(row.id)!;
      this.#deps.appendEvent({
        subjectKind: 'mission',
        subjectId: row.id,
        status: null,
        actor: input.founderId,
        summary: `Founder resolved a ${decision.kind} decision`,
        detail: { missionStatus: mission.status, project: row.project ?? undefined, title: row.title },
      });
      return mission;
    });
    return ok(view);
  }

  /* ---------------- cancellation ---------------- */

  /**
   * Cancel a mission through the one path that is honest about what it can
   * stop. Founder authority, fenced. A mission task whose canonical execution
   * is queued, claimed, running or unresolved is NOT stoppable from here — the
   * Operator's own paths (kill switch, reconciliation, review) own that — so
   * the cancellation is refused and names them. Executions still waiting at
   * the Founder gate are DENIED as part of the cancellation, because a denial
   * is not an authorization and nothing had run.
   */
  cancel(input: CancelMissionInput): MissionResult<MissionView> {
    const refusal = this.#deps.assertApprovalAuthority(input.founderId, 'cancel a mission');
    if (refusal) return fromOps(refusal.error);
    const reason = (input.reason ?? '').trim();
    if (!reason) return fail('invalid_input', 'Cancelling a mission requires a reason.');
    const row = this.#row(input.missionId);
    if (!row) return fail('mission_not_found', `Unknown mission: ${input.missionId}`);
    if (row.lifecycle !== 'open') {
      return fail('mission_not_open', `Mission ${row.id} is already ${row.lifecycle}.`, { lifecycle: row.lifecycle });
    }
    const stale = this.#fence(row, input.expectedIntentVersion);
    if (stale) return stale;
    try {
      assertNoSecretLikeContent({ reason });
    } catch {
      return fail('invalid_input', 'The cancellation reason looks like it contains a credential; nothing was written.');
    }
    const executions = this.#taskRows(row.id)
      .filter((task) => task.op_task_id !== null)
      .map((task) => ({ task, op: this.#deps.taskById(task.op_task_id!) }));
    const unstoppable = executions.filter((entry) => entry.op && UNCANCELLABLE_EXECUTION_STATUSES.includes(entry.op.status));
    if (unstoppable.length > 0) {
      return fail(
        'cancellation_blocked',
        `Mission ${row.id} has canonical work this layer cannot honestly stop: ` +
          unstoppable.map((entry) => `${entry.task.task_key} (${entry.op!.status})`).join(', ') +
          '. Queued or claimed work is stopped through the Operator — the kill switch, review or reconciliation — ' +
          'not by marking the mission cancelled while it runs.',
        { tasks: unstoppable.map((entry) => ({ key: entry.task.task_key, taskId: entry.op!.id, status: entry.op!.status })) },
      );
    }
    const awaitingApproval = executions.filter((entry) => entry.op && entry.op.status === 'needs_approval');

    const privileged = this.#deps.privileged();
    let view: MissionView;
    try {
      view = privileged.reserve((): MissionView => {
        const at = nowIso();
        for (const entry of awaitingApproval) {
          const denied = this.#deps.denyTask({
            taskId: entry.op!.id,
            founderId: input.founderId,
            reason: `Mission ${row.id} cancelled: ${reason}`,
          });
          if (!denied.ok) throw new Error(`Could not deny ${entry.op!.id} while cancelling: ${denied.error.message}`);
        }
        const updated = this.#db
          .prepare(
            `UPDATE hq_missions SET lifecycle = 'cancelled', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
             WHERE id = ? AND lifecycle = 'open' AND intent_version = ?`,
          )
          .run(input.founderId, at, reason, at, row.id, row.intent_version);
        if (updated.changes !== 1) throw new Error(`Mission ${row.id} changed while being cancelled`);
        privileged.appendEvidence({
          actor: input.founderId,
          kind: 'mission_cancelled',
          payload: {
            missionId: row.id,
            intentVersion: row.intent_version,
            reason,
            deniedExecutions: awaitingApproval.map((entry) => entry.op!.id),
          },
        });
        const mission = this.get(row.id)!;
        this.#deps.appendEvent({
          subjectKind: 'mission',
          subjectId: row.id,
          status: null,
          actor: input.founderId,
          summary: `Mission cancelled: ${reason}`,
          detail: { missionStatus: mission.status, project: row.project ?? undefined, title: row.title },
        });
        return mission;
      });
    } catch (error) {
      return fail('operator_rejected', error instanceof Error ? error.message : String(error), { missionId: row.id });
    }
    return ok(view);
  }

  /* ---------------- outcome ---------------- */

  /**
   * Explicit Founder statements about a mission's outcome. `verified` is
   * reachable only from the DERIVED `ready_review` (every task's canonical
   * execution completed); `complete` only from `verified`; `failed` from any
   * open mission with a reason. None of them grants or executes anything.
   */
  decideOutcome(input: DecideOutcomeInput): MissionResult<MissionView> {
    const refusal = this.#deps.assertApprovalAuthority(input.founderId, `mark a mission ${input.decision}`);
    if (refusal) return fromOps(refusal.error);
    if (!['verified', 'complete', 'failed'].includes(input.decision)) {
      return fail('invalid_input', `Unknown mission outcome: ${String(input.decision)}`);
    }
    const note = (input.note ?? '').trim();
    if (!note) return fail('invalid_input', 'A mission outcome requires a note.');
    const row = this.#row(input.missionId);
    if (!row) return fail('mission_not_found', `Unknown mission: ${input.missionId}`);
    const stale = this.#fence(row, input.expectedIntentVersion);
    if (stale) return stale;
    const current = this.get(row.id)!;
    if (input.decision === 'verified' && current.status !== 'ready_review') {
      return fail(
        'mission_status_forbids',
        `Mission ${row.id} is ${current.status}, not ready_review: verification is a statement about completed ` +
          'evidence, and there is none to verify yet.',
        { status: current.status },
      );
    }
    if (input.decision === 'complete' && current.lifecycle !== 'verified') {
      return fail('mission_status_forbids', `Mission ${row.id} is ${current.status}; only a verified mission can be completed.`, {
        status: current.status,
      });
    }
    if (input.decision === 'failed' && !['open', 'verified'].includes(current.lifecycle)) {
      return fail('mission_status_forbids', `Mission ${row.id} is already ${current.lifecycle}.`, { status: current.status });
    }
    try {
      assertNoSecretLikeContent({ note });
    } catch {
      return fail('invalid_input', 'The outcome note looks like it contains a credential; nothing was written.');
    }
    const privileged = this.#deps.privileged();
    const view = privileged.reserve((): MissionView => {
      const at = nowIso();
      const updated = this.#db
        .prepare(
          `UPDATE hq_missions SET lifecycle = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
           WHERE id = ? AND lifecycle = ? AND intent_version = ?`,
        )
        .run(input.decision, input.founderId, at, note, at, row.id, current.lifecycle, row.intent_version);
      if (updated.changes !== 1) throw new Error(`Mission ${row.id} changed while its outcome was being decided`);
      privileged.appendEvidence({
        actor: input.founderId,
        kind: 'mission_outcome_decided',
        payload: { missionId: row.id, decision: input.decision, intentVersion: row.intent_version, note },
      });
      const mission = this.get(row.id)!;
      this.#deps.appendEvent({
        subjectKind: 'mission',
        subjectId: row.id,
        status: null,
        actor: input.founderId,
        summary: `Mission marked ${input.decision}: ${note}`,
        detail: { missionStatus: mission.status, project: row.project ?? undefined, title: row.title },
      });
      return mission;
    });
    return ok(view);
  }

  /* ---------------- opening canonical work ---------------- */

  /**
   * Open a mission task as canonical Operator work.
   *
   * This is the ONLY bridge from a plan to execution, and it is a call to
   * `HeadquarterOperations.createTask` with three extra, strictly narrowing
   * preconditions: the caller's reading of the intent is current (fence), the
   * capability's risk class does not exceed the TASK's planned class (which
   * already does not exceed the mission's), and every dependency has a
   * completed execution. The payload gains the reserved `missionBinding` key —
   * inside the approval digest — so an approver sees which mission and which
   * intent version the action belongs to, and `approveTask` can refuse it once
   * the intent has moved on. Provider/worker assignment is untouched: the task
   * is claimed later, through the unchanged claim path.
   */
  openTaskWork(input: OpenTaskWorkInput): MissionResult<CreatedTask & { missionTask: MissionTaskView }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required.');
    const requester = this.#deps.resolveRequester(input.requestedBy, 'open mission task work');
    if (!requester.ok) return fromOps(requester.error);
    const row = this.#row(input.missionId);
    if (!row) return fail('mission_not_found', `Unknown mission: ${input.missionId}`);
    if (row.lifecycle !== 'open') return fail('mission_not_open', `Mission ${row.id} is ${row.lifecycle}; no new work may be opened.`);
    const stale = this.#fence(row, input.expectedIntentVersion);
    if (stale) return stale;
    const current = this.get(row.id)!;
    if (current.status === 'blocked' && current.decisions.some((d) => d.status === 'open')) {
      return fail(
        'mission_status_forbids',
        `Mission ${row.id} is blocked on ${current.decisions.filter((d) => d.status === 'open').length} open Founder decision(s). ` +
          'Nothing plans or works around a decision the Founder has not taken.',
        { status: current.status },
      );
    }
    const task = this.#taskRows(row.id).find((t) => t.id === input.missionTaskId);
    if (!task) return fail('mission_task_not_found', `Unknown mission task ${input.missionTaskId} on mission ${row.id}`);
    if (task.op_task_id !== null) {
      return fail('mission_task_already_opened', `Mission task ${task.task_key} already has canonical work ${task.op_task_id}.`, {
        taskId: task.op_task_id,
      });
    }
    const view = current.tasks.find((t) => t.id === task.id)!;
    const incomplete = view.dependsOn.filter((key) => current.tasks.find((t) => t.key === key)?.state !== 'completed');
    if (incomplete.length > 0) {
      return fail('dependencies_incomplete', `Mission task ${task.task_key} depends on work that is not completed: ${incomplete.join(', ')}.`, {
        incomplete,
      });
    }
    const capability = this.#deps.capabilityRow(input.capabilityId);
    if (!capability) return fail('unknown_capability', `Unknown capability: ${input.capabilityId}`);
    if (!withinRiskCeiling(capability.riskClass, task.risk_class as RiskClass)) {
      return fail(
        'authority_exceeds_task',
        `Capability ${capability.id} is ${capability.riskClass}, which exceeds mission task ${task.task_key}'s planned class ` +
          `${task.risk_class}. Task authority never widens past its plan; revise the mission intent first.`,
        { capabilityRisk: capability.riskClass, taskRisk: task.risk_class },
      );
    }
    if (input.payload == null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      return fail('invalid_input', 'A payload object is required.');
    }
    if (Object.prototype.hasOwnProperty.call(input.payload, MISSION_BINDING_KEY)) {
      return fail('reserved_payload_key', `Payload key ${MISSION_BINDING_KEY} is reserved; the mission writes it.`);
    }

    const privileged = this.#deps.privileged();
    let created: MissionResult<CreatedTask & { missionTask: MissionTaskView }>;
    try {
      created = privileged.reserve(() => {
        const result = this.#deps.createTask({
          capabilityId: input.capabilityId,
          payload: {
            ...input.payload,
            [MISSION_BINDING_KEY]: {
              missionId: row.id,
              missionTaskId: task.id,
              intentVersion: row.intent_version,
              intentDigest: row.intent_digest,
            },
          },
          // Deterministic per task and intent version: a retry dedupes, a new
          // intent version is a new action.
          idempotencyKey: `mission-task:${task.id}:v${row.intent_version}`,
          requestedBy: input.requestedBy,
          project: row.project ?? undefined,
          title: `${row.title} — ${task.title}`,
        });
        if (!result.ok) return fromOps(result.error);
        const at = nowIso();
        const linked = this.#db
          .prepare(
            `UPDATE hq_mission_tasks SET op_task_id = ?, execution_intent_version = ?, updated_at = ?
             WHERE id = ? AND op_task_id IS NULL`,
          )
          .run(result.data.task.id, row.intent_version, at, task.id);
        if (linked.changes !== 1) throw new Error(`Mission task ${task.id} was opened concurrently`);
        this.#touch(row.id, at);
        privileged.appendEvidence({
          taskId: result.data.task.id,
          actor: input.requestedBy,
          kind: 'mission_task_work_opened',
          payload: {
            missionId: row.id,
            missionTaskId: task.id,
            intentVersion: row.intent_version,
            capabilityId: input.capabilityId,
            riskClass: capability.riskClass,
            deduplicated: result.data.deduplicated,
          },
        });
        const mission = this.get(row.id)!;
        this.#deps.appendEvent({
          subjectKind: 'mission',
          subjectId: row.id,
          status: null,
          actor: input.requestedBy,
          summary: `Canonical work opened for mission task ${task.task_key} (${input.capabilityId})`,
          detail: { missionStatus: mission.status, project: row.project ?? undefined, title: row.title },
        });
        return ok({ ...result.data, missionTask: mission.tasks.find((t) => t.id === task.id)! });
      });
    } catch (error) {
      return fail('operator_rejected', error instanceof Error ? error.message : String(error), { missionId: row.id });
    }
    return created;
  }

  /**
   * Is this canonical task an execution of a mission task opened under an
   * intent version the mission has since moved past? Consulted by
   * `HeadquarterOperations.approveTask` so a stale execution cannot be
   * approved. Null for a task that belongs to no mission.
   */
  executionIntentStaleness(opTaskId: string): { missionId: string; missionTaskId: string; executionVersion: number; currentVersion: number; stale: boolean } | null {
    const task = this.#db
      .prepare(`SELECT t.id, t.mission_id, t.execution_intent_version, m.intent_version FROM hq_mission_tasks t JOIN hq_missions m ON m.id = t.mission_id WHERE t.op_task_id = ?`)
      .get(opTaskId) as { id: string; mission_id: string; execution_intent_version: number | null; intent_version: number } | undefined;
    if (!task || task.execution_intent_version === null) return null;
    return {
      missionId: task.mission_id,
      missionTaskId: task.id,
      executionVersion: task.execution_intent_version,
      currentVersion: task.intent_version,
      stale: task.execution_intent_version !== task.intent_version,
    };
  }

  /* ---------------- reads ---------------- */

  get(id: string): MissionView | null {
    const row = this.#row(id);
    if (!row) return null;
    return this.#view(row);
  }

  /** Most recent first. Bounded, so the browser read model cannot grow without limit. */
  list(limit = MISSION_LIST_LIMIT): MissionView[] {
    const rows = this.#db
      .prepare(`SELECT * FROM hq_missions ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, MISSION_LIST_LIMIT))) as MissionRow[];
    return rows.map((row) => this.#view(row));
  }

  /** Immutable intent history, oldest first. */
  intentHistory(missionId: string): { version: number; intent: MissionIntent; intentDigest: string; changedBy: string; changedAt: string; note: string | null; scopeExpanded: boolean; removedDoNot: string[] }[] {
    const rows = this.#db
      .prepare(`SELECT * FROM hq_mission_intents WHERE mission_id = ? ORDER BY version`)
      .all(missionId) as { version: number; intent: string; intent_digest: string; changed_by: string; changed_at: string; note: string | null; scope_expanded: number; removed_do_not: string | null }[];
    return rows.map((row) => ({
      version: row.version,
      intent: JSON.parse(row.intent) as MissionIntent,
      intentDigest: row.intent_digest,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
      note: row.note,
      scopeExpanded: !!row.scope_expanded,
      removedDoNot: row.removed_do_not ? parseJsonArray(row.removed_do_not) : [],
    }));
  }

  /** Server-side. The one read that includes the original command. */
  manifest(missionId: string): MissionManifest | null {
    const row = this.#row(missionId);
    if (!row) return null;
    const view = this.#view(row);
    return {
      missionId: view.id,
      title: view.title,
      status: view.status,
      intentVersion: view.intentVersion,
      intentDigest: view.intentDigest,
      commandDigest: view.commandDigest,
      originalInstruction: row.original_instruction,
      intent: view.intent,
      riskCeiling: view.riskCeiling,
      priority: view.priority,
      tasks: view.tasks.map((task) => ({
        id: task.id,
        key: task.key,
        title: task.title,
        summary: task.summary,
        dependsOn: task.dependsOn,
        riskClass: task.riskClass,
        doNot: task.doNot,
        scope: task.scope,
        state: task.state,
      })),
      openDecisions: view.decisions.filter((d) => d.status === 'open').map((d) => ({ id: d.id, kind: d.kind, question: d.question })),
    };
  }

  /* ---------------- internals ---------------- */

  #row(id: string): MissionRow | null {
    return (this.#db.prepare(`SELECT * FROM hq_missions WHERE id = ?`).get(id) as MissionRow | undefined) ?? null;
  }

  #taskRows(missionId: string): TaskRow[] {
    return this.#db.prepare(`SELECT * FROM hq_mission_tasks WHERE mission_id = ? ORDER BY ordinal, task_key`).all(missionId) as TaskRow[];
  }

  #decisionRows(missionId: string): DecisionRow[] {
    return this.#db.prepare(`SELECT * FROM hq_mission_decisions WHERE mission_id = ? ORDER BY raised_at, id`).all(missionId) as DecisionRow[];
  }

  #touch(missionId: string, at: string): void {
    this.#db.prepare(`UPDATE hq_missions SET updated_at = ? WHERE id = ?`).run(at, missionId);
  }

  #fence(row: MissionRow, expected: number): MissionResult<never> | null {
    if (typeof expected !== 'number' || !Number.isInteger(expected)) {
      return fail('invalid_input', 'expectedIntentVersion must be the integer intent version the caller read.');
    }
    if (expected !== row.intent_version) {
      return fail(
        'stale_intent_version',
        `Mission ${row.id} is at intent version ${row.intent_version}; this write was prepared against v${expected}. ` +
          'Re-read the mission — a newer Founder intent is not overwritten by an older reading of it.',
        { expected, current: row.intent_version },
      );
    }
    return null;
  }

  /** Did the executing worker itself report failure? Read from the evidence chain. */
  #workerReportedFailure(opTaskId: string): boolean {
    const latest = this.#db
      .prepare(
        `SELECT kind FROM op_evidence WHERE task_id = ? AND kind IN ('execution_failed', 'review_failed', 'review_passed')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(opTaskId) as { kind: string } | undefined;
    return latest?.kind === 'execution_failed';
  }

  #view(row: MissionRow): MissionView {
    const intent = JSON.parse(row.intent) as MissionIntent;
    const evidenceRefs: string[] = [];
    const tasks: MissionTaskView[] = this.#taskRows(row.id).map((task) => {
      let execution: MissionTaskExecutionView | null = null;
      let state: MissionTaskState;
      const op = task.op_task_id ? this.#deps.taskById(task.op_task_id) : null;
      if (task.op_task_id && op) {
        execution = {
          taskId: op.id,
          status: op.status,
          reviewState: op.reviewState,
          capabilityId: op.capabilityId,
          intentVersion: task.execution_intent_version ?? task.intent_version,
          stale: (task.execution_intent_version ?? task.intent_version) !== row.intent_version,
          blockReason: op.blockReason,
        };
        state = missionTaskStateFrom({
          status: op.status,
          reviewState: op.reviewState,
          workerReportedFailure: this.#workerReportedFailure(op.id),
        });
        const refs = (op.result as { refs?: unknown } | null)?.refs;
        if (Array.isArray(refs)) {
          for (const ref of refs) if (typeof ref === 'string' && ref.startsWith('https:')) evidenceRefs.push(ref);
        }
      } else if (task.op_task_id && !op) {
        // A link to a task that no longer resolves is a blocked task, not a
        // waiting one: something HQ recorded cannot be read back.
        state = 'blocked';
      } else {
        state = 'waiting';
      }
      return {
        id: task.id,
        key: task.task_key,
        ordinal: task.ordinal,
        title: task.title,
        summary: task.summary,
        dependsOn: parseJsonArray(task.depends_on),
        riskClass: task.risk_class as RiskClass,
        requiresFounderApproval: !!task.requires_founder_approval,
        scope: parseJsonArray(task.scope),
        doNot: parseJsonArray(task.do_not),
        intentVersion: task.intent_version,
        state,
        execution,
      };
    });
    const decisions: MissionDecisionView[] = this.#decisionRows(row.id).map((d) => ({
      id: d.id,
      kind: d.kind as MissionDecisionKind,
      question: d.question,
      status: d.status === 'resolved' ? 'resolved' : 'open',
      raisedAt: d.raised_at,
      resolvedBy: d.resolved_by,
      resolvedAt: d.resolved_at,
      resolution: d.resolution,
    }));
    const openDecisions = decisions.filter((d) => d.status === 'open').length;
    const lifecycle = row.lifecycle as MissionLifecycle;
    const status = deriveMissionStatus({
      lifecycle,
      openDecisions,
      tasks: tasks.map((task) => ({ state: task.state, hasExecution: task.execution !== null })),
    });
    let blockReason: string | null = null;
    if (status === 'blocked') {
      const blockedTasks = tasks.filter((t) => t.state === 'blocked' || t.state === 'failed');
      const parts: string[] = [];
      if (openDecisions > 0) parts.push(`${openDecisions} Founder decision(s) open`);
      if (blockedTasks.length > 0) parts.push(`task(s) ${blockedTasks.map((t) => `${t.key}: ${t.state}`).join(', ')}`);
      blockReason = parts.join('; ');
    }
    return {
      id: row.id,
      title: row.title,
      status,
      lifecycle,
      priority: row.priority as MissionPriority,
      riskCeiling: row.risk_ceiling as RiskClass,
      project: row.project,
      product: row.product,
      createdBy: row.created_by,
      actorAuthentication: row.actor_authentication,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      commandDigest: row.command_digest,
      commandLength: row.original_instruction.length,
      intentVersion: row.intent_version,
      intentDigest: row.intent_digest,
      intent,
      planner: row.planner,
      tasks,
      decisions,
      blockReason,
      evidenceRefs: [...new Set(evidenceRefs)],
      outcome:
        lifecycle !== 'open' && row.decided_by && row.decided_at
          ? { decision: lifecycle, by: row.decided_by, at: row.decided_at, note: row.decision_note }
          : null,
    };
  }
}

/**
 * Default label for a mission whose author did not choose one. Says nothing
 * about the command's contents — the same rule as a direct order's default
 * title, for the same reason: the title is the one free-text field that
 * travels to the browser, and content must not reach it as a side effect.
 */
function defaultTitle(project: string | null, product: string | null): string {
  if (project) return `Founder mission → ${project}`;
  if (product) return `Founder mission → ${product}`;
  return 'Founder mission';
}
