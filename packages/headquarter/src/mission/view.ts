/**
 * Mission read model — what a browser may be told about a mission (issue
 * #254, integration decision D10).
 *
 * ## The publication rule, restated for missions
 *
 * `live/orders.ts` keeps an order's instruction text server-side and publishes
 * only the title the Founder chose. A mission holds MORE Founder text than an
 * order — the objective, every constraint, every criterion, every step — and
 * the same rule applies to all of it: none of it crosses this boundary. What
 * crosses is the SHAPE of the intent (how many constraints, how many criteria,
 * which unknown codes fired, whether the chain verifies) and the truth about
 * the plan (each task's canonical status, its presentation word, its bound
 * provider, whether it can dispatch, why it is blocked if it is).
 *
 * That last item — `blockReason` — is a Founder- or reviewer-typed sentence,
 * and it is published, as the canonical console already publishes a task's
 * `blockReason`: it was bounded and credential-scanned at the moment it was
 * written, and it is the one sentence a Founder reading BLOCKED most needs.
 * The same holds for a transition reason.
 *
 * ## Copied and counted, never derived into a claim
 *
 * Every task field is read from the canonical row at projection time. The
 * presentation word is `presentTaskState` applied to that row; the implied
 * mission state is `impliedMissionState` over those words. Both are labelled
 * as derived, shown BESIDE the recorded state, and never written anywhere.
 *
 * Field names avoid `payload` on purpose: the state-route test asserts the
 * serialized document never contains that word, which is the cheapest proof
 * that no task payload leaked.
 */

import type { HeadquarterOperations } from '../application/service.js';
import type { ProviderId, SecretsEnv } from '../routing/providers.js';
import { isProviderId } from '../routing/providers.js';
import { readProviderBinding } from '../operator/provider-binding.js';
import { dispatchHistory } from '../providers/claude/dispatch.js';
import { directOrderDispatchBlocked } from '../live/orders.js';
import { assertBrowserSafe } from '../live/redaction.js';
import { INTENT_UNKNOWN_DESCRIPTIONS, type IntentUnknownCode } from './intent.js';
import {
  impliedMissionState,
  MISSION_TASK_PRESENTATION_LABELS,
  MISSION_TASK_PRESENTATIONS,
  presentTaskState,
  type MissionTaskPresentation,
  type PresentedTaskState,
} from './presentation.js';
import { MISSION_STATE_LABELS, NEEDS_CLARIFICATION_REASON, type MissionState } from './states.js';
import { MAX_MISSIONS_LISTED, type MissionRecord, type MissionStore } from './store.js';

export interface MissionTaskView {
  ordinal: number;
  taskId: string;
  /** The published task title — the mission title plus a step marker. Never the brief. */
  title: string | null;
  canonicalStatus: string;
  reviewState: string;
  presentation: MissionTaskPresentation;
  presentationLabel: string;
  presentationNote: string | null;
  boundProvider: ProviderId | null;
  dispatchBlocked: boolean;
  blockReason: string | null;
  claimedBy: string | null;
  /** True when the canonical row is missing — a link with no task behind it, reported rather than hidden. */
  missing: boolean;
}

export interface MissionUnknownView {
  code: IntentUnknownCode;
  blocking: boolean;
  /** The generic description of the rule. Never the Founder's text. */
  description: string;
}

export interface MissionIntentView {
  /** How many intent rows the lock holds: 1 for an unamended mission. */
  revisions: number;
  latestKind: 'original' | 'amendment';
  latestAt: string;
  latestActor: string;
  latestActorAuthentication: string;
  latestReason: string | null;
  constraintCount: number;
  acceptanceCriteriaCount: number;
  stepCount: number;
  needsClarification: boolean;
  unknowns: MissionUnknownView[];
  /** Whether every intent row still hashes to the chain. False is a tamper report. */
  chainIntact: boolean;
}

export interface MissionHistoryView {
  fromState: MissionState | null;
  toState: MissionState;
  actor: string;
  reason: string | null;
  at: string;
}

export interface MissionView {
  missionId: string;
  title: string;
  project: string | null;
  state: MissionState;
  stateLabel: string;
  /** True when the mission core itself blocked this mission for clarification. */
  needsClarification: boolean;
  blockReason: string | null;
  /** What the canonical tasks imply, derived at read time. Null for a mission with no task. */
  impliedState: MissionState | null;
  impliedStateLabel: string | null;
  /** True when the recorded state and the implied state disagree. Shown, never resolved automatically. */
  driftFromTasks: boolean;
  taskCount: number;
  taskCounts: Record<MissionTaskPresentation, number>;
  tasks: MissionTaskView[];
  intent: MissionIntentView;
  history: MissionHistoryView[];
  requestedBy: string;
  actorAuthentication: string;
  requestedRoute: string;
  createdAt: string;
  updatedAt: string;
}

export interface MissionViewOptions {
  env?: SecretsEnv;
  dispatchAvailability?: (provider: ProviderId) => boolean | null;
  limit?: number;
}

function emptyCounts(): Record<MissionTaskPresentation, number> {
  const counts = {} as Record<MissionTaskPresentation, number>;
  for (const word of MISSION_TASK_PRESENTATIONS) counts[word] = 0;
  return counts;
}

function taskView(
  ops: HeadquarterOperations,
  link: { taskId: string; ordinal: number },
  options: MissionViewOptions,
): { view: MissionTaskView; presented: PresentedTaskState | null } {
  const task = ops.queue.get(link.taskId);
  if (!task) {
    return {
      presented: null,
      view: {
        ordinal: link.ordinal,
        taskId: link.taskId,
        title: null,
        canonicalStatus: 'missing',
        reviewState: 'none',
        presentation: 'blocked',
        presentationLabel: MISSION_TASK_PRESENTATION_LABELS.blocked,
        presentationNote: 'The mission links a task the canonical queue no longer holds.',
        boundProvider: null,
        dispatchBlocked: false,
        blockReason: null,
        claimedBy: null,
        missing: true,
      },
    };
  }
  const presented = presentTaskState(task.status, task.reviewState);
  const binding = readProviderBinding(task.payload);
  const boundProvider =
    binding.bound && binding.provider != null && isProviderId(binding.provider) ? binding.provider : null;
  return {
    presented,
    view: {
      ordinal: link.ordinal,
      taskId: task.id,
      title: ops.readMeta(task.id)?.title ?? null,
      canonicalStatus: task.status,
      reviewState: task.reviewState,
      presentation: presented.presentation,
      presentationLabel: MISSION_TASK_PRESENTATION_LABELS[presented.presentation],
      presentationNote: presented.note,
      boundProvider,
      dispatchBlocked: directOrderDispatchBlocked(task, options.env ?? {}, {
        alreadyDispatched: dispatchHistory(ops, task.id).state === 'dispatched',
        providerDispatchable: options.dispatchAvailability,
      }),
      blockReason: task.blockReason,
      claimedBy: task.claimedBy,
      missing: false,
    },
  };
}

/** Project one mission. */
export function missionView(
  ops: HeadquarterOperations,
  missions: MissionStore,
  mission: MissionRecord,
  options: MissionViewOptions = {},
): MissionView {
  const projected = missions.listTaskLinks(mission.id).map((link) => taskView(ops, link, options));
  const tasks = projected.map((entry) => entry.view);
  const presented = projected
    .map((entry) => entry.presented)
    .filter((entry): entry is PresentedTaskState => entry !== null);
  const counts = emptyCounts();
  for (const task of tasks) counts[task.presentation] += 1;
  const implied = tasks.length === 0 ? null : impliedMissionState(presented);

  const intents = missions.listIntent(mission.id);
  const latest = intents[intents.length - 1];
  const intent: MissionIntentView = latest
    ? {
        revisions: intents.length,
        latestKind: latest.kind,
        latestAt: latest.at,
        latestActor: latest.actor,
        latestActorAuthentication: latest.actorAuthentication,
        latestReason: latest.reason,
        constraintCount: latest.constraints.length,
        acceptanceCriteriaCount: latest.acceptanceCriteria.length,
        stepCount: latest.stepCount,
        needsClarification: latest.needsClarification,
        unknowns: latest.unknowns.map((entry) => ({
          code: entry.code,
          blocking: entry.blocking,
          description: INTENT_UNKNOWN_DESCRIPTIONS[entry.code],
        })),
        chainIntact: missions.verifyIntentChain(mission.id),
      }
    : {
        revisions: 0,
        latestKind: 'original',
        latestAt: mission.createdAt,
        latestActor: mission.requestedBy,
        latestActorAuthentication: mission.actorAuthentication,
        latestReason: null,
        constraintCount: 0,
        acceptanceCriteriaCount: 0,
        stepCount: 0,
        needsClarification: false,
        unknowns: [],
        // A mission with NO intent row is a broken record, and the chain of
        // nothing is not "intact" — it is absent. Reported as not intact.
        chainIntact: false,
      };

  return {
    missionId: mission.id,
    title: mission.title,
    project: mission.project,
    state: mission.state,
    stateLabel: MISSION_STATE_LABELS[mission.state],
    needsClarification:
      mission.state === 'blocked' && (mission.blockReason ?? '').startsWith(NEEDS_CLARIFICATION_REASON),
    blockReason: mission.blockReason,
    impliedState: implied,
    impliedStateLabel: implied ? MISSION_STATE_LABELS[implied] : null,
    driftFromTasks: implied !== null && implied !== mission.state,
    taskCount: tasks.length,
    taskCounts: counts,
    tasks,
    intent,
    history: missions.listEvents(mission.id).map((event) => ({
      fromState: event.fromState,
      toState: event.toState,
      actor: event.actor,
      reason: event.reason,
      at: event.at,
    })),
    requestedBy: mission.requestedBy,
    actorAuthentication: mission.actorAuthentication,
    requestedRoute: mission.requestedRoute,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

/**
 * What is true about the WHOLE store at the moment a list was read, carried
 * beside the listed window so the window can never masquerade as the total
 * (Opus second pass on `a849af8`, P1).
 *
 * The defect this closes: `missionViews` capped the list at
 * `MAX_MISSIONS_LISTED` (50) and nothing downstream learned that a cap had
 * applied. The snapshot section carried no total, `missionAttention` counted
 * only the 50 it was handed, and every room metric — "Missions recorded",
 * "Missions blocked", "Missions needing attention" — was a fact about the
 * window wearing the label of a fact about the store. Reproduced: 55 missions
 * with the 5 oldest blocked gave `total 50, blocked 0`, a Command Room reading
 * "needing attention 0", and a Mission Room rendered quiet over five blocked
 * missions. `livenessFrom` reads the same count, so the room did not light.
 *
 * Every number here that is a fact about the `state` column is counted over
 * every row by `MissionStore.countMissionsByState`, so it is true whether the
 * window held 3 missions or 50 of 5,000. The one count that is NOT here is
 * drift: whether a mission's recorded state disagrees with its tasks needs the
 * task projection, and projecting every mission is exactly the cost the cap
 * exists to avoid. Drift stays a window count and is labelled as one wherever
 * it is shown.
 */
export interface MissionListingFacts {
  /** Every mission the store holds, in any state. `countMissions()`, not the list length. */
  total: number;
  /** How many the window carries. */
  listed: number;
  /** The cap that applied. */
  limit: number;
  /** True when `total > listed`: the window is the newest `listed` of `total`. */
  truncated: boolean;
  /** Store-wide, by recorded state. A column count, never a count over the window. */
  byState: Record<MissionState, number>;
  /** Store-wide: recorded blocked by the mission core for clarification. */
  needsClarification: number;
}

export interface MissionListing extends MissionListingFacts {
  /** The window, newest first, proven browser-safe. */
  missions: MissionView[];
}

/**
 * The list read: the newest missions up to the cap, with the store-wide facts
 * that say how much of the store the window is. Fail closed: a view that
 * cannot be proven safe throws rather than being returned partially.
 */
export function missionListing(
  ops: HeadquarterOperations,
  missions: MissionStore,
  options: MissionViewOptions = {},
): MissionListing {
  const limit = options.limit ?? MAX_MISSIONS_LISTED;
  const views = missions.listMissions(limit).map((mission) => missionView(ops, missions, mission, options));
  assertBrowserSafe(views, 'missions');
  const total = missions.countMissions();
  const tallies = missions.countMissionsByState();
  return {
    missions: views,
    total,
    listed: views.length,
    limit,
    truncated: total > views.length,
    byState: tallies.byState,
    needsClarification: tallies.needsClarification,
  };
}

/**
 * Every mission the store lists, newest first, proven browser-safe before it
 * is returned. The bare window — callers that need to know whether it IS the
 * whole store read `missionListing` instead.
 */
export function missionViews(
  ops: HeadquarterOperations,
  missions: MissionStore,
  options: MissionViewOptions = {},
): MissionView[] {
  return missionListing(ops, missions, options).missions;
}

export interface MissionAttention {
  /** Store-wide. */
  total: number;
  /** The window's size, so a reader can see how much of `total` the rows cover. */
  listed: number;
  truncated: boolean;
  /** Store-wide. */
  needsClarification: number;
  /** Store-wide. */
  blocked: number;
  /** Store-wide. */
  readyReview: number;
  /** Store-wide. */
  working: number;
  /** Store-wide. */
  planned: number;
  /** Store-wide. */
  terminal: number;
  /**
   * WINDOW-SCOPED — the only count here that is. Drift needs each mission's
   * task projection, which exists only for the listed missions. When
   * `truncated` is true this is "drift among the `listed` newest", and every
   * label that shows it says so.
   */
  drift: number;
}

/**
 * Counts the rooms light on. Copied and counted, nothing else — and each
 * count says what it is counted over: the store-wide facts come from the
 * listing's column tallies, the window-scoped drift from the views.
 */
export function missionAttention(views: readonly MissionView[], facts: MissionListingFacts): MissionAttention {
  return {
    total: facts.total,
    listed: views.length,
    truncated: facts.truncated,
    needsClarification: facts.needsClarification,
    blocked: facts.byState.blocked,
    readyReview: facts.byState.ready_review,
    working: facts.byState.working,
    planned: facts.byState.planned,
    terminal: facts.byState.complete + facts.byState.cancelled,
    drift: views.filter((view) => view.driftFromTasks).length,
  };
}
