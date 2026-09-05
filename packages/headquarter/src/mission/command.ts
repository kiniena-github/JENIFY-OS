/**
 * Founder Command — the write seam of the Mission Core (issue #254).
 *
 * ## What this is, in one sentence
 *
 * `submitDirectOrder` with a durable record around it. A Founder types an
 * order; this module records the order as a MISSION (intent lock, state, task
 * plan, history) and creates every unit of work in that plan THROUGH the
 * existing direct-order path — so the Founder gate, provider binding, action
 * digest, idempotency and browser-safety scanning apply to each task exactly
 * as they did before this module existed (integration decision D5). There is
 * no write to `op_tasks` or `op_evidence` here, and no capability is
 * registered, enabled or re-classified on the way past (D6).
 *
 * ## Why every task is `founder_gate`, again
 *
 * The argument in `live/orders.ts` applies unchanged: a free-text order is
 * unclassifiable in advance, so the only honest risk class is the highest one,
 * and a request body cannot declare itself safer. A mission adds nothing to
 * that. Its steps are still free text — the Founder's, restated as a brief —
 * and each still lands in `needs_approval` under a digest a second human must
 * echo back. The mission is a record of what was asked, not a permission to
 * do it.
 *
 * ## Atomicity, stated because it matters for honesty
 *
 * A mission with three steps creates one mission row, one intent row, one
 * event row and three canonical tasks. Those commit together or not at all:
 * the whole creation runs inside `ops.reserveEvidence`, the same IMMEDIATE
 * transaction primitive the dispatch lane uses, on the same connection the
 * store writes through. A mission whose second task was refused leaves
 * nothing behind — not a mission claiming a plan it does not have, and not an
 * orphan task belonging to no mission.
 *
 * ## Deduplication
 *
 * The mission key is derived from everything that makes an order the same
 * order, on the model of `directOrderIdempotencyKey` and for the same reasons
 * recorded there. A repeated command returns the existing mission with
 * `deduplicated: true` and creates nothing. Each task's own key is the mission
 * key plus its ordinal, so a task can only ever dedupe onto ITS OWN mission's
 * earlier attempt, never onto another mission's.
 *
 * ## Who may act
 *
 * Creating and amending require a registered, active human principal that
 * holds the `hq.direct_order` origination grant — the same grant the tasks
 * will be created under, checked here BEFORE the mission row exists so that a
 * clarification-needed mission (which creates no task and would therefore
 * never reach `createTask`'s own check) still cannot be recorded by an
 * unregistered id. Transitioning a mission is a decision, so it requires
 * approval authority. Both fail closed on an unknown, inactive or worker id
 * (D9), and neither authenticates anyone: the `actorAuthentication` marker
 * records how the attribution was obtained, and the earned value reaches this
 * module only through the options parameter no request body can populate —
 * precisely as it reaches `submitDirectOrder`.
 */

import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { assertBrowserSafe } from '../live/redaction.js';
import {
  DEFAULT_ACTOR_AUTHENTICATION,
  isCallerAssertableActorAuthentication,
  type ActorAuthentication,
} from '../live/local-trust.js';
import {
  AUTO_ROUTE_PREFERENCE,
  DIRECT_ORDER_CAPABILITY,
  DIRECT_ORDER_ROUTES,
  directOrderCapabilityState,
  directOrderDispatchBlocked,
  resolveOrderRoute,
  submitDirectOrder,
  type DirectOrderErrorCode,
  type DirectOrderReceipt,
  type DirectOrderRoute,
  type RouteAvailability,
} from '../live/orders.js';
import { readProviderBinding } from '../operator/provider-binding.js';
import { dispatchHistory } from '../providers/claude/dispatch.js';
import type { HeadquarterOperations } from '../application/service.js';
import { isProviderId, type SecretsEnv } from '../routing/providers.js';
import { nowIso } from '../store/db.js';
import { MAX_COMMAND_LENGTH, parseFounderCommand, planFromIntent } from './intent.js';
import {
  assertMissionTransition,
  canMissionTransition,
  isMissionState,
  isMissionTerminal,
  NEEDS_CLARIFICATION_REASON,
  type MissionState,
} from './states.js';
import type { IntentRecord, MissionRecord, MissionStore } from './store.js';

/**
 * Shorter than `MAX_TITLE_LENGTH` (120) on purpose: a task's published title is
 * the mission title plus ` · step NN/NN`, and that suffix must never push a
 * legitimate mission title past the bound the order path enforces.
 */
export const MAX_MISSION_TITLE_LENGTH = 100;

/** A transition or amendment reason is stored permanently and published. Bounded like a denial reason. */
export const MAX_MISSION_REASON_LENGTH = 500;

export interface FounderCommandInput {
  /** The order, in the Founder's words. SERVER-SIDE ONLY once recorded. */
  command: string;
  /** The ONE Founder-typed field published to the browser. Omitted → a neutral default. */
  title?: string;
  /** Optional presentation label. Never authority. */
  project?: string;
  route: DirectOrderRoute;
  /** The human principal placing the order. Authorized against the registry; never authenticated here. */
  requestedBy: string;
  /** Caller-assertable marker only; the earned value arrives via `RouteAvailability`. */
  actorAuthentication?: ActorAuthentication;
  /** Mixed into the derived key, never used as the key. */
  idempotencyKey?: string;
}

export interface FounderCommandReceipt {
  mission: MissionRecord;
  /** The intent record this submission wrote — or, when deduplicated, the mission's latest. */
  intent: IntentRecord;
  /** One receipt per task in the plan, in ordinal order. Empty when the order needs clarification. */
  tasks: DirectOrderReceipt[];
  deduplicated: boolean;
  needsClarification: boolean;
}

export type FounderCommandErrorCode =
  | DirectOrderErrorCode
  | 'empty_command'
  | 'command_too_long'
  | 'unsafe_command'
  | 'unknown_mission'
  | 'mission_terminal'
  | 'mission_has_no_plan'
  | 'invalid_mission_state'
  | 'illegal_mission_transition'
  | 'reason_required'
  | 'reason_too_long'
  | 'unsafe_reason';

export type FounderCommandResult<T = FounderCommandReceipt> =
  | { ok: true; data: T }
  | { ok: false; error: { code: FounderCommandErrorCode; message: string; details?: Record<string, unknown> } };

function commandFail<T = never>(
  code: FounderCommandErrorCode,
  message: string,
  details?: Record<string, unknown>,
): FounderCommandResult<T> {
  return { ok: false, error: { code, message, details } };
}

/** Thrown inside the creation transaction to roll it back; caught and converted at the boundary. */
class CreationRefused extends Error {
  constructor(readonly result: FounderCommandResult<never>) {
    super('mission creation refused');
  }
}

function encodeDigestFields(fields: readonly string[]): string {
  return fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('');
}

/**
 * Deterministic mission key. Same construction and same length-prefixed
 * encoding as `directOrderIdempotencyKey`, for the reasons recorded there.
 */
export function missionIdempotencyKey(input: {
  requestedBy: string;
  route: DirectOrderRoute;
  actorAuthentication: ActorAuthentication;
  project?: string;
  idempotencyKey?: string;
  title?: string;
  command: string;
}): string {
  const digest = createHash('sha256')
    .update(
      encodeDigestFields([
        input.requestedBy,
        input.route,
        input.actorAuthentication,
        input.project ?? '',
        input.idempotencyKey ?? '',
        (input.title ?? '').trim(),
        input.command.trim(),
      ]),
    )
    .digest('hex');
  return `mission:${digest.slice(0, 32)}`;
}

/** A label that reveals nothing about the order. See `defaultTitle` in `live/orders.ts`. */
function defaultMissionTitle(missionId: string): string {
  return `Founder mission ${missionId.slice(0, 8)}`;
}

function taskTitle(missionTitle: string, ordinal: number, count: number): string {
  if (count <= 1) return missionTitle;
  return `${missionTitle} · step ${String(ordinal).padStart(2, '0')}/${String(count).padStart(2, '0')}`;
}

type ActorCheck =
  | { ok: true }
  | { ok: false; result: FounderCommandResult<never> };

/**
 * The actor must positively BE an active human principal — and, for the
 * originating actions, hold the direct-order grant. A registered worker is
 * not a human principal and is refused; so is 'system'.
 *
 * `lookupPrincipal` is the narrow read #200 left on the facade for exactly
 * this purpose. It is not the enforcement path for the TASKS — `createTask`
 * resolves the requester itself, through a closure no caller can patch — so
 * the worst a patched lookup could do here is let a mission ROW be recorded
 * under an unregistered name with zero tasks, which grants nothing.
 */
function requireActor(
  ops: HeadquarterOperations,
  actor: string,
  action: string,
  needs: 'originate' | 'approve',
): ActorCheck {
  if (!actor || actor === 'system') {
    return { ok: false, result: commandFail('invalid_input', `A human principal is required to ${action}.`) };
  }
  if (ops.workers.isRegistered(actor)) {
    return {
      ok: false,
      result: commandFail(
        'not_permitted',
        `Registered worker ${actor} cannot ${action}: worker identity never places or decides a Founder mission.`,
        { actor },
      ),
    };
  }
  const principal = ops.lookupPrincipal(actor);
  if (!principal || !principal.active) {
    return {
      ok: false,
      result: commandFail(
        'unknown_principal',
        `${actor} may not ${action}: not a registered, active human principal.`,
        { actor },
      ),
    };
  }
  if (needs === 'originate' && !principal.originateCapabilities.includes(DIRECT_ORDER_CAPABILITY.id)) {
    return {
      ok: false,
      result: commandFail(
        'not_permitted',
        `${actor} may not ${action}: the principal does not hold the ${DIRECT_ORDER_CAPABILITY.id} ` +
          'origination grant, which every task of a mission is created under.',
        { actor },
      ),
    };
  }
  if (needs === 'approve' && !principal.approvalAuthority) {
    return {
      ok: false,
      result: commandFail(
        'not_permitted',
        `${actor} may not ${action}: moving a mission is a decision, and this principal carries no approval authority.`,
        { actor },
      ),
    };
  }
  return { ok: true };
}

function checkReason(reason: string | undefined, required: boolean): FounderCommandResult<string | null> {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    if (required) return commandFail('reason_required', 'A reason is required and is recorded permanently.');
    return { ok: true, data: null };
  }
  if (trimmed.length > MAX_MISSION_REASON_LENGTH) {
    return commandFail(
      'reason_too_long',
      `A reason may be at most ${MAX_MISSION_REASON_LENGTH} characters.`,
      { length: trimmed.length },
    );
  }
  try {
    assertBrowserSafe({ reason: trimmed }, 'mission');
  } catch {
    return commandFail(
      'unsafe_reason',
      'The reason looks like it contains a credential. Reasons are recorded permanently and published, so nothing was written.',
    );
  }
  return { ok: true, data: trimmed };
}

/** Validate and normalise an order's text and labels. Shared by create and amend. */
function checkCommand(input: {
  command: string;
  title?: string;
  project?: string;
}): FounderCommandResult<{ command: string; title: string }> {
  const command = (input.command ?? '').trim();
  if (command.length === 0) return commandFail('empty_command', 'A mission needs an order.');
  if (command.length > MAX_COMMAND_LENGTH) {
    return commandFail(
      'command_too_long',
      `A mission order may be at most ${MAX_COMMAND_LENGTH} characters. Longer than that is a document, not an order.`,
      { length: command.length },
    );
  }
  const title = (input.title ?? '').trim();
  if (title.length > MAX_MISSION_TITLE_LENGTH) {
    return commandFail(
      'title_too_long',
      `A mission title may be at most ${MAX_MISSION_TITLE_LENGTH} characters. It is the one Founder-typed ` +
        'field published to the Mission Room, not a second order.',
      { length: title.length },
    );
  }
  // Refused before any write, exactly as an order is: the command enters the
  // append-only intent log and every step brief enters the evidence log.
  try {
    assertBrowserSafe({ command, project: input.project ?? null, title: title || null }, 'mission');
  } catch {
    return commandFail(
      'unsafe_command',
      'The order looks like it contains a credential. Orders are recorded in the append-only intent ' +
        'lock and their step briefs in the evidence log, so secrets must never be pasted into one.',
    );
  }
  return { ok: true, data: { command, title } };
}

/** The capability gate, named per state exactly as `submitDirectOrder` names it. */
function checkCapability(ops: HeadquarterOperations): FounderCommandResult<null> {
  const state = directOrderCapabilityState(ops);
  if (state === 'enabled') return { ok: true, data: null };
  if (state === 'missing') {
    return commandFail(
      'capability_not_registered',
      `Capability ${DIRECT_ORDER_CAPABILITY.id} is not registered here, so no mission task could be created. ` +
        'Registering it is a separate configuration action; placing a mission never performs it.',
    );
  }
  if (state === 'altered') {
    return commandFail(
      'capability_definition_altered',
      `Capability ${DIRECT_ORDER_CAPABILITY.id} no longer matches its reserved Founder-gate contract, so the ` +
        'mission is refused rather than recorded against a weakened gate.',
    );
  }
  return commandFail(
    'capability_disabled',
    `Capability ${DIRECT_ORDER_CAPABILITY.id} is disabled, so no mission task could be created. A mission will not re-enable it.`,
  );
}

/**
 * Create the plan's tasks and link them. Runs INSIDE the creation transaction;
 * a refused task throws `CreationRefused`, which rolls back the mission too.
 */
function createPlanTasks(
  ops: HeadquarterOperations,
  missions: MissionStore,
  mission: MissionRecord,
  intent: IntentRecord,
  briefs: readonly string[],
  actor: string,
  actorAuthentication: ActorAuthentication | undefined,
  env: SecretsEnv,
  availability: RouteAvailability | undefined,
): DirectOrderReceipt[] {
  const receipts: DirectOrderReceipt[] = [];
  briefs.forEach((brief, index) => {
    const ordinal = index + 1;
    const created = submitDirectOrder(
      ops,
      {
        instruction: brief,
        project: mission.project ?? undefined,
        title: taskTitle(mission.title, ordinal, briefs.length),
        route: mission.requestedRoute,
        requestedBy: actor,
        actorAuthentication,
        idempotencyKey: `${mission.idempotencyKey}:${intent.id}:${ordinal}`,
      },
      env,
      availability,
    );
    if (!created.ok) {
      throw new CreationRefused({ ok: false, error: created.error });
    }
    missions.linkTask({ missionId: mission.id, taskId: created.data.task.id, ordinal, intentId: intent.id });
    receipts.push(created.data);
  });
  return receipts;
}

/**
 * The receipt for a mission that already exists, assembled from CANONICAL
 * READS rather than by replaying the submission.
 *
 * A replay through `submitDirectOrder` was the first draft, on the model of a
 * double-clicked order. It was wrong for a receipt: if the capability had
 * been disabled since the mission was recorded, the replay was refused and
 * the task silently vanished from the receipt — a deduplicated mission
 * reporting fewer tasks than it holds. The links are the record; the tasks
 * they name are read straight from the queue, and the dispatch verdict is the
 * same live derivation every other surface uses.
 */
function existingReceipt(
  ops: HeadquarterOperations,
  missions: MissionStore,
  mission: MissionRecord,
  env: SecretsEnv,
  availability: RouteAvailability | undefined,
): FounderCommandReceipt {
  const intents = missions.listIntent(mission.id);
  const latest = intents[intents.length - 1]!;
  const tasks: DirectOrderReceipt[] = [];
  for (const link of missions.listTaskLinks(mission.id)) {
    const task = ops.queue.get(link.taskId);
    if (!task) continue;
    const classification = ops.classify(task.capabilityId);
    if (!classification.ok) continue;
    const route = resolveOrderRoute(mission.requestedRoute, env, availability);
    const binding = readProviderBinding(task.payload);
    const boundProvider =
      binding.bound && binding.provider != null && isProviderId(binding.provider)
        ? binding.provider
        : (route.resolved ?? AUTO_ROUTE_PREFERENCE[0]!);
    tasks.push({
      task,
      classification: classification.data,
      deduplicated: true,
      route,
      idempotencyKey: task.idempotencyKey ?? '',
      boundProvider,
      dispatchBlocked: directOrderDispatchBlocked(task, env, {
        alreadyDispatched: dispatchHistory(ops, task.id).state === 'dispatched',
        providerDispatchable: availability?.providerDispatchable,
      }),
    });
  }
  return { mission, intent: latest, tasks, deduplicated: true, needsClarification: latest.needsClarification };
}

/**
 * Submit a Founder command: record the mission and create its plan.
 */
export function submitFounderCommand(
  ops: HeadquarterOperations,
  missions: MissionStore,
  input: FounderCommandInput,
  env: SecretsEnv,
  availability?: RouteAvailability,
): FounderCommandResult {
  const checked = checkCommand(input);
  if (!checked.ok) return checked;
  const { command, title } = checked.data;
  if (!input.requestedBy) return commandFail('invalid_input', 'requestedBy is required.');
  if (!DIRECT_ORDER_ROUTES.includes(input.route)) {
    return commandFail('invalid_input', `Unknown route: ${String(input.route)}`);
  }
  if (
    input.actorAuthentication !== undefined &&
    !isCallerAssertableActorAuthentication(input.actorAuthentication)
  ) {
    return commandFail(
      'invalid_input',
      'Unusable actorAuthentication marker. A marker outside the vocabulary is refused rather than recorded, ' +
        'and the authenticated value reaches a mission only from the interface that resolved the identity.',
    );
  }
  const actorAuthentication: ActorAuthentication =
    availability?.resolvedActorAuthentication ?? input.actorAuthentication ?? DEFAULT_ACTOR_AUTHENTICATION;

  const capability = checkCapability(ops);
  if (!capability.ok) return capability;
  const actor = requireActor(ops, input.requestedBy, 'place a Founder mission', 'originate');
  if (!actor.ok) return actor.result;

  const idempotencyKey = missionIdempotencyKey({
    requestedBy: input.requestedBy,
    route: input.route,
    actorAuthentication,
    project: input.project,
    idempotencyKey: input.idempotencyKey,
    title,
    command,
  });
  const existing = missions.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    return { ok: true, data: existingReceipt(ops, missions, existing, env, availability) };
  }

  const intent = parseFounderCommand(command);
  const missionId = uuid();
  const missionTitle = title || defaultMissionTitle(missionId);
  const briefs = planFromIntent(intent, missionTitle);
  const at = nowIso();
  const initialState: MissionState = briefs.length > 0 ? 'planned' : 'blocked';
  const blockReason =
    briefs.length > 0
      ? null
      : `${NEEDS_CLARIFICATION_REASON}: ${intent.unknowns
          .filter((entry) => entry.blocking)
          .map((entry) => entry.code)
          .join(', ')}`;

  try {
    const data = ops.reserveEvidence<FounderCommandReceipt>(() => {
      const mission = missions.insertMission({
        id: missionId,
        idempotencyKey,
        title: missionTitle,
        project: input.project ?? null,
        state: initialState,
        blockReason,
        requestedBy: input.requestedBy,
        actorAuthentication,
        requestedRoute: input.route,
        at,
      });
      const record = missions.appendIntent({
        missionId,
        kind: 'original',
        command,
        objective: intent.objective,
        constraints: intent.constraints,
        acceptanceCriteria: intent.acceptanceCriteria,
        unknowns: intent.unknowns,
        needsClarification: intent.needsClarification,
        stepCount: intent.steps.length,
        actor: input.requestedBy,
        actorAuthentication,
        reason: null,
        at,
      });
      missions.recordTransition({
        missionId,
        fromState: null,
        toState: initialState,
        blockReason,
        actor: input.requestedBy,
        reason:
          briefs.length > 0
            ? `Recorded with a plan of ${briefs.length} task(s).`
            : 'Recorded without a plan: the order needs clarification before any task is created.',
        at,
      });
      const tasks = createPlanTasks(
        ops,
        missions,
        mission,
        record,
        briefs,
        input.requestedBy,
        input.actorAuthentication,
        env,
        availability,
      );
      return {
        mission: missions.getMission(missionId)!,
        intent: record,
        tasks,
        deduplicated: false,
        needsClarification: intent.needsClarification,
      };
    });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof CreationRefused) return error.result;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Amendment                                                           */
/* ------------------------------------------------------------------ */

export interface AmendMissionInput {
  missionId: string;
  /** The amended order, in full. Recorded beside the original, never over it. */
  command: string;
  /** Why the intent changed. Required, bounded, published. */
  reason: string;
  actor: string;
  actorAuthentication?: ActorAuthentication;
}

export interface AmendMissionReceipt {
  mission: MissionRecord;
  intent: IntentRecord;
  /** Tasks created BY THIS amendment. Non-empty only for a mission that had no plan. */
  tasks: DirectOrderReceipt[];
  /** True when the amendment gave a plan-less mission its first plan. */
  planCreated: boolean;
  needsClarification: boolean;
}

/**
 * Append an amendment to a mission's intent lock.
 *
 * What an amendment can and cannot do is bounded by the canonical model, and
 * stated rather than papered over:
 *
 *   - It ALWAYS appends: the original row stays byte-for-byte as it was, and
 *     the new row is chained to it with its actor, timestamp and reason.
 *   - For a mission with NO plan (recorded blocked for clarification), an
 *     amendment that the rules can read creates the plan's tasks and moves
 *     the mission `blocked → planned`. That is the one case where an amendment
 *     changes work.
 *   - For a mission that already has tasks, the amendment is recorded and the
 *     existing tasks are NOT altered. They cannot be: each carries a brief
 *     inside an action digest a Founder approves, and rewriting it would
 *     change the action under the approval. The Mission Room says this next
 *     to the amendment. Adding steps to a live plan is later-phase work.
 */
export function amendMission(
  ops: HeadquarterOperations,
  missions: MissionStore,
  input: AmendMissionInput,
  env: SecretsEnv,
  availability?: RouteAvailability,
): FounderCommandResult<AmendMissionReceipt> {
  const mission = missions.getMission(input.missionId ?? '');
  if (!mission) return commandFail('unknown_mission', `Unknown mission: ${String(input.missionId)}`);
  if (isMissionTerminal(mission.state)) {
    return commandFail('mission_terminal', `Mission ${mission.id} is ${mission.state} and takes no amendment.`, {
      state: mission.state,
    });
  }
  const checked = checkCommand({ command: input.command, project: mission.project ?? undefined });
  if (!checked.ok) return checked;
  const reason = checkReason(input.reason, true);
  if (!reason.ok) return reason;
  if (
    input.actorAuthentication !== undefined &&
    !isCallerAssertableActorAuthentication(input.actorAuthentication)
  ) {
    return commandFail('invalid_input', 'Unusable actorAuthentication marker.');
  }
  const actorAuthentication: ActorAuthentication =
    availability?.resolvedActorAuthentication ?? input.actorAuthentication ?? DEFAULT_ACTOR_AUTHENTICATION;
  const capability = checkCapability(ops);
  if (!capability.ok) return capability;
  const actor = requireActor(ops, input.actor, 'amend a Founder mission', 'originate');
  if (!actor.ok) return actor.result;

  const intent = parseFounderCommand(checked.data.command);
  const hadTasks = missions.listTaskLinks(mission.id).length > 0;
  const briefs = hadTasks ? [] : planFromIntent(intent, mission.title);
  const at = nowIso();

  try {
    const data = ops.reserveEvidence<AmendMissionReceipt>(() => {
      const record = missions.appendIntent({
        missionId: mission.id,
        kind: 'amendment',
        command: checked.data.command,
        objective: intent.objective,
        constraints: intent.constraints,
        acceptanceCriteria: intent.acceptanceCriteria,
        unknowns: intent.unknowns,
        needsClarification: intent.needsClarification,
        stepCount: intent.steps.length,
        actor: input.actor,
        actorAuthentication,
        reason: reason.data,
        at,
      });
      let tasks: DirectOrderReceipt[] = [];
      if (briefs.length > 0) {
        tasks = createPlanTasks(ops, missions, mission, record, briefs, input.actor, input.actorAuthentication, env, availability);
        // A plan-less mission is `blocked` (clarification) or `failed`
        // (re-plan after a failure); both list `planned` as an exit.
        if (canMissionTransition(mission.state, 'planned')) {
          missions.recordTransition({
            missionId: mission.id,
            fromState: mission.state,
            toState: 'planned',
            blockReason: null,
            actor: input.actor,
            reason: `Amendment supplied a plan of ${tasks.length} task(s).`,
            at,
          });
        }
      } else if (!hadTasks && intent.needsClarification && mission.state === 'blocked') {
        // Still unreadable. The block reason is refreshed to name THIS
        // amendment's unknowns, through the same recorded-transition path
        // (blocked → blocked is not a listed edge, so it is written as a
        // reason refresh on the current state, with its own history row).
        missions.recordTransition({
          missionId: mission.id,
          fromState: 'blocked',
          toState: 'blocked',
          blockReason: `${NEEDS_CLARIFICATION_REASON}: ${intent.unknowns
            .filter((entry) => entry.blocking)
            .map((entry) => entry.code)
            .join(', ')}`,
          actor: input.actor,
          reason: 'Amendment recorded; the order still needs clarification and no task was created.',
          at,
        });
      }
      return {
        mission: missions.getMission(mission.id)!,
        intent: record,
        tasks,
        planCreated: tasks.length > 0,
        needsClarification: intent.needsClarification,
      };
    });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof CreationRefused) return error.result;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Explicit transitions                                                */
/* ------------------------------------------------------------------ */

export interface TransitionMissionInput {
  missionId: string;
  to: MissionState | string;
  actor: string;
  /** Required when moving to `blocked`, `failed` or `cancelled`; optional otherwise. Bounded, published. */
  reason?: string;
}

/** Targets that need a stated reason: each records a stop, and a stop without a why is the quiet stop. */
const REASON_REQUIRED_TARGETS: readonly MissionState[] = ['blocked', 'failed', 'cancelled'];

/** Targets that claim something about a PLAN, and are therefore refused for a mission that has none. */
const PLAN_REQUIRED_TARGETS: readonly MissionState[] = ['planned', 'working', 'ready_review', 'verified', 'complete'];

/**
 * Move a mission's RECORDED state. Explicit, attributed, reasoned, and
 * refused when the table does not list the edge.
 */
export function transitionMission(
  ops: HeadquarterOperations,
  missions: MissionStore,
  input: TransitionMissionInput,
): FounderCommandResult<{ mission: MissionRecord; from: MissionState; to: MissionState }> {
  const mission = missions.getMission(input.missionId ?? '');
  if (!mission) return commandFail('unknown_mission', `Unknown mission: ${String(input.missionId)}`);
  if (!isMissionState(input.to)) {
    return commandFail('invalid_mission_state', `Unknown mission state: ${String(input.to)}`);
  }
  const to = input.to;
  const actor = requireActor(ops, input.actor, 'move a Founder mission', 'approve');
  if (!actor.ok) return actor.result;
  if (!canMissionTransition(mission.state, to)) {
    return commandFail(
      'illegal_mission_transition',
      `Illegal mission transition: ${mission.state} -> ${to}.` +
        (isMissionTerminal(mission.state) ? ` ${mission.state} is terminal.` : ''),
      { from: mission.state, to },
    );
  }
  const reason = checkReason(input.reason, REASON_REQUIRED_TARGETS.includes(to));
  if (!reason.ok) return reason;
  if (to === 'blocked' && reason.data !== null && reason.data.startsWith(NEEDS_CLARIFICATION_REASON)) {
    return commandFail(
      'invalid_input',
      `A Founder-stated block reason may not begin with "${NEEDS_CLARIFICATION_REASON}"; that prefix is reserved ` +
        'for the block the mission core records itself.',
    );
  }
  if (PLAN_REQUIRED_TARGETS.includes(to) && missions.listTaskLinks(mission.id).length === 0) {
    return commandFail(
      'mission_has_no_plan',
      `Mission ${mission.id} has no task, so it cannot be recorded as ${to}: that would claim a plan it does not have. ` +
        'Amend the order until it yields one.',
      { to },
    );
  }
  // Belt and braces: the assert is the same table, and it throws rather than
  // returning, so a future caller that skips the check above still cannot
  // write an unlisted edge.
  assertMissionTransition(mission.state, to);
  const event = missions.recordTransition({
    missionId: mission.id,
    fromState: mission.state,
    toState: to,
    blockReason: to === 'blocked' ? reason.data : null,
    actor: input.actor,
    reason: reason.data,
  });
  return { ok: true, data: { mission: missions.getMission(mission.id)!, from: event.fromState!, to: event.toState } };
}
