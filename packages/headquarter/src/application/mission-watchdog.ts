/**
 * Mission control decision rules — an UNWIRED library (issue #219).
 *
 * ## Status, stated first because it is the thing most easily overclaimed
 *
 * **Nothing in this repository calls these functions at runtime.** They are
 * exported and unit-tested; no workflow, service, route, script or scheduled
 * job invokes them. `MISSION_WATCHDOG_RUNTIME_CONSUMERS` records that, and
 * `mission-watchdog.wiring-truth.test.ts` fails if a consumer appears while
 * this notice still says there is none.
 *
 * The consequence, said plainly rather than left to be inferred: **the quiet
 * stop is not fixed by this module existing.** A mission can still stall
 * unnoticed today, because the only thing that dispatches a worker is an owner
 * comment carrying `<!-- jenify-run -->` (`.github/workflows/ai-task-trigger.yml`),
 * and nothing on that path consults these rules. What is delivered here is the
 * decision — which state a mission is in and what follows from it — and proof
 * that the decision is fail-closed. What is NOT delivered is anything that
 * observes a mission, keeps a heartbeat, or acts on the answer.
 *
 * Wiring it needs three things this module deliberately does not have: a real
 * heartbeat source, a durable idempotent dispatch-key store, and — for
 * automatic resume — the authority to dispatch a worker without an owner
 * comment. The last is a widening of execution authority and a Founder
 * decision, so it is left as one, rather than taken quietly here.
 *
 * ## What the rules encode
 *
 * The failure the rules describe is specific and was observed: a worker
 * session ends, the branch exists, some tests passed, a dispatch comment was
 * posted — and every one of those looks like progress, so nobody re-triggers.
 * The mission then sits indefinitely in a state that is neither finished nor
 * escalated. "Dispatched", "branch exists", "some tests passed" and "the
 * worker session ended" are NOT completion, and these rules refuse to read
 * them as completion.
 *
 * Three deliberate properties:
 *
 * 1. **Completion is evidence-driven and fail-closed.** A mission is COMPLETE
 *    only when every declared evidence item is satisfied. An empty or unknown
 *    checklist is never vacuously complete — a mission with nothing declared
 *    has not proved anything.
 * 2. **Liveness is proved, not assumed.** A worker counts as active only with
 *    a fresh heartbeat on THIS lane. A stale heartbeat is exactly the quiet
 *    stop, so it resolves to STALLED (resume), never to RUNNING (wait forever).
 * 3. **Blockers outrank activity.** A real Founder-only or external blocker is
 *    escalated even while a worker looks busy, because no amount of worker
 *    time resolves a credential decision or an exhausted provider quota.
 *
 * This module is pure: no clock, no I/O, no network. Callers pass `now`. It
 * decides and explains; it never dispatches, and it never widens authority.
 */

/**
 * Every runtime caller of the decision functions below, outside tests and the
 * `application/index.ts` barrel re-export.
 *
 * It is empty, and the empty list IS the claim: this library is not wired to
 * anything. It exists as a value rather than as prose so the accompanying
 * wiring-truth test can check the claim against the source tree instead of
 * asking a reader to take the docstring's word for it. A future change that
 * genuinely wires the watchdog must list its consumers here and rewrite the
 * status notice above; a change that wires it and leaves this alone fails.
 */
export const MISSION_WATCHDOG_RUNTIME_CONSUMERS: readonly string[] = [];

/**
 * What this module actually delivers, in one machine-checkable word.
 *
 * `decision_rules_only` — the states, the precedence and the dispatch
 * preconditions, with tests. NOT an operating watchdog: see the status section
 * at the top of this file.
 */
export const MISSION_WATCHDOG_STATUS = 'decision_rules_only' as const;

export const MISSION_CONTROL_STATES = [
  'running',
  'stalled',
  'founder_blocked',
  'external_blocked',
  'complete',
] as const;
export type MissionControlState = (typeof MISSION_CONTROL_STATES)[number];

export const MISSION_CONTROL_ACTIONS = [
  /** A worker is genuinely active on this lane — do not duplicate it. */
  'none',
  /** No active worker and the contract is unmet — re-trigger THIS lane. */
  'resume_same_lane',
  /** A Founder-only gate is reached — report the exact action and stop. */
  'escalate_founder',
  /** Outside the worker's control — report precisely, retry only per policy. */
  'report_external',
  /** All completion evidence exists — stop. */
  'stop',
] as const;
export type MissionControlAction = (typeof MISSION_CONTROL_ACTIONS)[number];

/** One required piece of completion evidence. `satisfied` must be proved, not assumed. */
export interface MissionEvidenceItem {
  id: string;
  label: string;
  satisfied: boolean;
}

export type MissionBlockerKind = 'founder' | 'external';

/**
 * A real blocker. `detail` must name the exact action or provider/quota —
 * a blocker with no detail is not actionable and is rejected as fail-closed
 * noise rather than being allowed to halt the loop.
 */
export interface MissionBlocker {
  kind: MissionBlockerKind;
  detail: string;
}

/**
 * A worker's claim to be alive on a lane. `heartbeatAt` is an ISO timestamp of
 * real observed activity — a dispatch record is not a heartbeat, because the
 * observed failure mode is precisely a dispatch that produced no work.
 */
export interface MissionWorker {
  sessionId: string;
  lane: string;
  heartbeatAt: string;
}

export interface MissionControlInput {
  /** The one canonical lane for this mission. */
  lane: string;
  evidence: readonly MissionEvidenceItem[];
  workers: readonly MissionWorker[];
  blockers: readonly MissionBlocker[];
  /** ISO timestamp the decision is made at. */
  now: string;
  /** A heartbeat older than this is a quiet stop, not activity. Default 30 min. */
  staleWorkerAfterMs?: number;
}

export interface MissionControlDecision {
  state: MissionControlState;
  action: MissionControlAction;
  lane: string;
  /** Ids of evidence items not yet satisfied, in declaration order. */
  missingEvidence: readonly string[];
  /** Session ids counted as genuinely active on this lane. */
  activeWorkers: readonly string[];
  /** Human-readable justification — always populated, never decorative. */
  reason: string;
}

/** A heartbeat older than this counts as a quiet stop rather than activity. */
export const DEFAULT_STALE_WORKER_MS = 30 * 60 * 1000;

function parseInstant(value: string): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Workers genuinely active on `lane` at `now`.
 *
 * Fail-closed on every axis: a worker on another lane does not count, an
 * unparseable or absent heartbeat does not count, a heartbeat older than the
 * staleness window does not count. A heartbeat in the future is clamped to
 * "active" rather than trusted arithmetically, since clock skew must not be
 * able to manufacture a stall and duplicate a live worker.
 */
export function activeMissionWorkers(input: MissionControlInput): readonly MissionWorker[] {
  const now = parseInstant(input.now);
  if (now === null) return [];
  const window = input.staleWorkerAfterMs ?? DEFAULT_STALE_WORKER_MS;
  return input.workers.filter((worker) => {
    if (!isNonBlank(worker?.sessionId) || worker.lane !== input.lane) return false;
    const beat = parseInstant(worker.heartbeatAt);
    if (beat === null) return false;
    return now - beat <= window;
  });
}

/**
 * Blockers that are actually actionable. A blocker with no detail cannot be
 * escalated to anyone, so it must not be able to halt the loop — that would
 * reintroduce the quiet stop under a different name.
 */
export function actionableMissionBlockers(
  blockers: readonly MissionBlocker[],
): readonly MissionBlocker[] {
  return blockers.filter(
    (blocker) =>
      (blocker?.kind === 'founder' || blocker?.kind === 'external') && isNonBlank(blocker.detail),
  );
}

/**
 * Classify a mission into exactly one control state and the single action that
 * follows from it.
 *
 * Precedence, and why:
 *   complete > founder_blocked > external_blocked > running > stalled
 *
 * Completion wins outright: a mission that has proved everything is done, and
 * a leftover blocker record cannot un-finish it. Blockers then outrank worker
 * activity, because a credential or quota decision is not resolved by letting
 * a busy worker keep running. Activity outranks stall so a live worker is
 * never duplicated. Stall is the default: unmet contract plus no proved
 * liveness is the exact condition that must resume, not wait.
 */
export function classifyMission(input: MissionControlInput): MissionControlDecision {
  const lane = input.lane;
  const missingEvidence = input.evidence
    .filter((item) => item?.satisfied !== true)
    .map((item) => item.id);
  const active = activeMissionWorkers(input);
  const activeWorkers = active.map((worker) => worker.sessionId);
  const blockers = actionableMissionBlockers(input.blockers);

  // Fail-closed: an empty checklist has proved nothing. Vacuous truth must
  // never read as COMPLETE, or a mission with no declared contract would
  // report finished the moment it was created.
  const contractDeclared = input.evidence.length > 0;
  const contractMet = contractDeclared && missingEvidence.length === 0;

  if (contractMet) {
    return {
      state: 'complete',
      action: 'stop',
      lane,
      missingEvidence: [],
      activeWorkers,
      reason: `All ${input.evidence.length} declared completion-evidence items are satisfied.`,
    };
  }

  const founder = blockers.find((blocker) => blocker.kind === 'founder');
  if (founder) {
    return {
      state: 'founder_blocked',
      action: 'escalate_founder',
      lane,
      missingEvidence,
      activeWorkers,
      reason: `Founder-only action required: ${founder.detail}`,
    };
  }

  const external = blockers.find((blocker) => blocker.kind === 'external');
  if (external) {
    return {
      state: 'external_blocked',
      action: 'report_external',
      lane,
      missingEvidence,
      activeWorkers,
      reason: `Blocked outside the worker's control: ${external.detail}`,
    };
  }

  if (active.length > 0) {
    return {
      state: 'running',
      action: 'none',
      lane,
      missingEvidence,
      activeWorkers,
      reason: `${active.length} worker(s) active on ${lane}; do not dispatch a duplicate.`,
    };
  }

  return {
    state: 'stalled',
    action: 'resume_same_lane',
    lane,
    missingEvidence,
    activeWorkers,
    reason: contractDeclared
      ? `No active worker on ${lane} and ${missingEvidence.length} evidence item(s) outstanding: ${missingEvidence.join(', ')}.`
      : `No active worker on ${lane} and no completion contract declared; nothing has been proved.`,
  };
}

export interface MissionDispatchRequest {
  /** Lane the caller wants to dispatch onto. */
  lane: string;
  /**
   * Stable key for this dispatch intent. Two retries of the same intent share
   * a key so an idempotent retry resumes instead of fanning out workers.
   */
  dispatchKey: string;
}

export interface MissionDispatchDecision {
  dispatch: boolean;
  reason: string;
}

/**
 * Duplicate-dispatch protection.
 *
 * Refuses, in order: a competing lane (the anti-collision rule — one canonical
 * branch per mission, never a second), a dispatch key already spent
 * (idempotent retry), and a state whose action is not `resume_same_lane`.
 * Only a genuine STALLED mission on the canonical lane dispatches.
 */
export function shouldDispatchMission(
  decision: MissionControlDecision,
  request: MissionDispatchRequest,
  spentDispatchKeys: readonly string[] = [],
): MissionDispatchDecision {
  if (!isNonBlank(request?.lane) || !isNonBlank(request?.dispatchKey)) {
    return { dispatch: false, reason: 'Dispatch request needs both a lane and a dispatch key.' };
  }
  if (request.lane !== decision.lane) {
    return {
      dispatch: false,
      reason: `Refusing a competing lane: mission is canonically on ${decision.lane}, request targeted ${request.lane}.`,
    };
  }
  if (spentDispatchKeys.includes(request.dispatchKey)) {
    return {
      dispatch: false,
      reason: `Dispatch key ${request.dispatchKey} was already spent; a retry resumes the existing lane rather than adding a worker.`,
    };
  }
  if (decision.action !== 'resume_same_lane') {
    return {
      dispatch: false,
      reason: `State ${decision.state} calls for ${decision.action}, not a new dispatch.`,
    };
  }
  return {
    dispatch: true,
    reason: `Mission is stalled on ${decision.lane} with ${decision.missingEvidence.length} evidence item(s) outstanding; resuming the same lane.`,
  };
}

/**
 * Guard for the one-canonical-branch rule. Throws rather than returning a
 * boolean because creating a competing integration lane is the kind of mistake
 * that must not be reachable by ignoring a return value.
 */
export function assertCanonicalLane(canonicalLane: string, proposedLane: string): void {
  if (!isNonBlank(canonicalLane)) {
    throw new Error('Mission has no canonical lane recorded; refusing to act on an unnamed lane.');
  }
  if (proposedLane !== canonicalLane) {
    throw new Error(
      `Refusing to open a competing mission lane: canonical lane is ${canonicalLane}, proposed ${proposedLane}.`,
    );
  }
}

/**
 * Render a decision as a short operator-readable status line. Reporting only —
 * it states what is missing rather than implying progress that has not happened.
 */
export function describeMissionDecision(decision: MissionControlDecision): string {
  const missing =
    decision.missingEvidence.length === 0
      ? 'no outstanding evidence'
      : `outstanding: ${decision.missingEvidence.join(', ')}`;
  return `[${decision.state.toUpperCase()}] ${decision.lane} → ${decision.action} (${missing}). ${decision.reason}`;
}
