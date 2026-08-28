/**
 * Canonical state → floor state (issue #200, spatial HQ mission).
 *
 * This is the honesty boundary of the living Headquarters. `world.ts` decides
 * where rooms and desks are; `scene.ts` decides how to draw them; THIS file is
 * the only place that decides whether anything is alive, and it decides it
 * from canonical read models alone.
 *
 * Three rules hold throughout, and the tests in `test/spatial-truth.test.ts`
 * enforce each of them against the shipped functions rather than against a
 * description of them:
 *
 *   1. DENY BY DEFAULT. Absence of evidence is rendered as OFFLINE / UNLIT /
 *      UNSTAFFED, never as idle-but-present and never as working. A worker the
 *      event log has never mentioned is dark on this floor.
 *   2. EVERY LIVE-LOOKING THING CARRIES ITS EVIDENCE. Each occupant and each
 *      fixture states, in words, the canonical fact that put it in that state.
 *      A state with no sentence to justify it is a bug, not a default.
 *   3. NOTHING IS INVENTED. There is no synthetic activity, no random motion,
 *      no fabricated progress, cost, ETA or headcount. If canonical data
 *      cannot answer a question the floor omits it.
 */

import type { ApprovalRequest, ChatMessage } from '../../contracts/modules.js';
import type { ActivityStatus } from '../../contracts/events.js';
import type { WorkerDescriptor } from '../../contracts/workers.js';
import type { ArchiveRecord } from '../../archive/schema.js';
import type { ConnectionStatus } from '../../live/connections.js';
import { CONNECTION_STATE_LABELS } from '../../live/connections.js';
import type { TaskState } from '../model.js';
import type { FounderDashboard, ProjectBoardCard, WorkerStatus } from '../views.js';
import type { Tone } from '../components.js';
import { HQ_FLOOR, ROLE_ZONE, UNREGISTERED_ZONE, type Zone } from './world.js';

/**
 * What an occupant is doing, in the floor's own vocabulary.
 *
 * Each value maps to exactly one canonical situation. `offline` is the
 * default for every unknown: it is the only value that may be reached
 * without a status-bearing canonical event.
 */
export type OccupantActivity =
  | 'working'
  | 'reviewing'
  | 'queued'
  | 'blocked'
  | 'awaiting_founder'
  | 'complete'
  | 'offline';

export const ACTIVITY_PRESENTATION: Record<OccupantActivity, { label: string; tone: Tone }> = {
  working: { label: 'Working', tone: 'info' },
  reviewing: { label: 'In review', tone: 'violet' },
  queued: { label: 'Queued', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'danger' },
  awaiting_founder: { label: 'Waiting on Founder', tone: 'warn' },
  complete: { label: 'Last task completed', tone: 'accent' },
  offline: { label: 'Offline', tone: 'neutral' },
};

/**
 * Canonical task status → floor activity.
 *
 * Exhaustive over `ActivityStatus` on purpose: a status added to the contract
 * later fails to compile here rather than silently falling through to a
 * cheerful default.
 */
export const STATUS_ACTIVITY: Record<ActivityStatus, OccupantActivity> = {
  queued: 'queued',
  assigned: 'working',
  running: 'working',
  review_failed: 'reviewing',
  review_passed: 'reviewing',
  blocked: 'blocked',
  outcome_unknown: 'blocked',
  needs_approval: 'awaiting_founder',
  completed: 'complete',
};

/** Activities that mean a screen is lit and a figure is in motion. */
export const ANIMATED_ACTIVITIES: readonly OccupantActivity[] = ['working', 'reviewing'];

/** Activities that put a room into the Founder's attention set. */
export const ATTENTION_ACTIVITIES: readonly OccupantActivity[] = ['blocked', 'awaiting_founder'];

export interface Occupant {
  /** Worker id from the canonical log or registry. */
  id: string;
  displayName: string;
  /** Vendor + role when registered; what the log knows when not. */
  subtitle: string;
  activity: OccupantActivity;
  /**
   * The canonical fact that produced `activity`, in words. Rendered next to
   * the occupant, so a lit desk always shows why it is lit.
   */
  evidence: string;
  /** The task driving the activity, when one does. */
  task: TaskState | null;
  /** True when the worker is in the specialist registry. */
  registered: boolean;
  /** Station id this occupant is drawn at, assigned by `floorState`. */
  stationId: string | null;
}

/** A lit or unlit object standing in a room: an uplink, a bay, a stack. */
export interface Fixture {
  id: string;
  label: string;
  /** Short second line — a count, a state word. Never a fabricated metric. */
  detail: string;
  /**
   * Whether the fixture is drawn as powered. Only ever true on positive
   * canonical evidence; every unknown is unlit.
   */
  lit: boolean;
  tone: Tone;
  /** Why it is lit or unlit, in words. */
  evidence: string;
  stationId: string | null;
}

/** How alive a room is. Derived, never asserted. */
export type ZoneLiveness = 'active' | 'attention' | 'quiet' | 'unstaffed';

export const LIVENESS_PRESENTATION: Record<ZoneLiveness, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'info' },
  attention: { label: 'Needs attention', tone: 'warn' },
  quiet: { label: 'Quiet', tone: 'neutral' },
  unstaffed: { label: 'Unstaffed', tone: 'neutral' },
};

export interface ZoneState {
  zone: Zone;
  liveness: ZoneLiveness;
  /** One line of canonical counts for the room. */
  summary: string;
  occupants: Occupant[];
  fixtures: Fixture[];
  /** Where in the read-only HQ the full detail for this room lives. */
  drillDown: { href: string; label: string } | null;
}

export interface FloorInput {
  states: TaskState[];
  dashboard: FounderDashboard;
  workers: WorkerStatus[];
  specialists: WorkerDescriptor[];
  projects: ProjectBoardCard[];
  approvals: ApprovalRequest[];
  connections: ConnectionStatus[];
  archive: ArchiveRecord[];
  chatMessages: ChatMessage[];
}

export interface FloorState {
  zones: ZoneState[];
  /** Counts across the whole floor, for the entrance summary. */
  totals: {
    occupants: number;
    active: number;
    blocked: number;
    awaitingFounder: number;
    offline: number;
    litUplinks: number;
    uplinks: number;
  };
}

/* ------------------------------------------------------------------ */
/* Occupants                                                           */
/* ------------------------------------------------------------------ */

/**
 * What one worker is doing, and why.
 *
 * The worker's own task states are the input, not only the aggregated
 * `WorkerStatus`. That distinction is load-bearing: `workerStatuses` counts
 * active, blocked and completed work and nothing else, so a worker whose only
 * task is `queued` or `needs_approval` has an all-zero status — and reading
 * activity from the aggregate alone drew exactly the worker the Founder most
 * needs to see as a dark, apparently-idle desk. The floor's whole purpose is
 * to surface a stalled approval, so it reads the task states directly.
 *
 * Branch order is deliberate:
 *
 *   1. an inactive registry entry can hold no work at all;
 *   2. an ACTIVE task is the strongest statement available — a worker with
 *      both a running task and a gated one is working;
 *   3. then the approval gate, ahead of a blocker, matching the precedence
 *      `founderAttentionQueue` already uses: only the Founder can clear it;
 *   4. then blocked, queued, completed;
 *   5. and absence of all of it is offline, never idle-but-present.
 */
export function occupantActivity(
  descriptor: WorkerDescriptor | null,
  status: WorkerStatus | null,
  tasks: readonly TaskState[] = [],
): { activity: OccupantActivity; evidence: string; task: TaskState | null } {
  if (descriptor && !descriptor.active) {
    return {
      activity: 'offline',
      evidence: 'Registered in the specialist directory but marked inactive — it may hold no work.',
      task: null,
    };
  }
  if (!status && tasks.length === 0) {
    return {
      activity: 'offline',
      evidence: 'No canonical activity event names this worker, so nothing is known about what it is doing.',
      task: null,
    };
  }

  /** Newest task in any of the given canonical statuses. */
  const newestIn = (statuses: readonly ActivityStatus[]): TaskState | null =>
    [...tasks]
      .filter((task) => statuses.includes(task.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .at(-1) ?? null;

  const active = status?.activeTask ?? newestIn(['assigned', 'running', 'review_failed', 'review_passed']);
  if (active) {
    return {
      activity: STATUS_ACTIVITY[active.status],
      evidence: `Task ${active.taskId} is recorded as ${active.status}, updated ${active.updatedAt}.`,
      task: active,
    };
  }

  const gated = newestIn(['needs_approval']);
  if (gated) {
    return {
      activity: 'awaiting_founder',
      evidence: `Task ${gated.taskId} is recorded as needs_approval since ${gated.updatedAt} — only the Founder can clear it.`,
      task: gated,
    };
  }

  const stopped = newestIn(['blocked', 'outcome_unknown']);
  if (stopped) {
    return {
      activity: 'blocked',
      evidence: `Task ${stopped.taskId} is recorded as ${stopped.status} since ${stopped.updatedAt}; nothing this worker holds is active.`,
      task: stopped,
    };
  }
  if (status && status.blockedCount > 0) {
    return {
      activity: 'blocked',
      evidence: `${status.blockedCount} task(s) recorded as blocked or outcome_unknown; none recorded as active.`,
      task: null,
    };
  }

  const queued = newestIn(['queued']);
  if (queued) {
    return {
      activity: 'queued',
      evidence: `Task ${queued.taskId} is recorded as queued since ${queued.updatedAt} — accepted, not started.`,
      task: queued,
    };
  }

  const completed = newestIn(['completed']);
  if (completed || (status && status.completedCount > 0)) {
    const count = status?.completedCount ?? 1;
    return {
      activity: 'complete',
      evidence: `Last recorded outcome was a completion (${count} completed); no task is active now.`,
      task: completed,
    };
  }

  return {
    activity: 'offline',
    evidence: status
      ? `Named in the activity log (last seen ${status.lastSeen}) but holds no active, gated, blocked, queued or completed task.`
      : 'No canonical activity event names this worker, so nothing is known about what it is doing.',
    task: null,
  };
}

/**
 * Everyone the floor knows about: every registered specialist, plus every
 * worker the event log names that the registry does not.
 *
 * Both directions matter. Dropping unregistered actors would make the floor
 * quieter than the log; dropping registered-but-silent specialists would hide
 * the fact that a worker exists and is doing nothing.
 */
export function floorOccupants(
  specialists: readonly WorkerDescriptor[],
  workers: readonly WorkerStatus[],
  states: readonly TaskState[] = [],
): Occupant[] {
  const statusByWorker = new Map(workers.map((worker) => [worker.worker, worker]));
  const tasksByWorker = new Map<string, TaskState[]>();
  for (const state of states) {
    tasksByWorker.set(state.worker, [...(tasksByWorker.get(state.worker) ?? []), state]);
  }
  const occupants: Occupant[] = specialists.map((descriptor) => {
    const status = statusByWorker.get(descriptor.id) ?? null;
    const { activity, evidence, task } = occupantActivity(
      descriptor,
      status,
      tasksByWorker.get(descriptor.id) ?? [],
    );
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      subtitle: `${descriptor.vendor} · ${descriptor.role.replaceAll('_', ' ')}`,
      activity,
      evidence,
      task,
      registered: true,
      stationId: null,
    };
  });

  const registered = new Set(specialists.map((descriptor) => descriptor.id));
  for (const worker of workers) {
    if (registered.has(worker.worker)) continue;
    const { activity, evidence, task } = occupantActivity(
      null,
      worker,
      tasksByWorker.get(worker.worker) ?? [],
    );
    occupants.push({
      id: worker.worker,
      displayName: worker.worker,
      subtitle: 'Named in the activity log · not in the specialist registry',
      activity,
      evidence,
      task,
      registered: false,
      stationId: null,
    });
  }

  return occupants.sort((a, b) => a.id.localeCompare(b.id));
}

/** Which room an occupant stands in — role for the registered, Build Floor otherwise. */
export function occupantZone(occupant: Occupant, specialists: readonly WorkerDescriptor[]): string {
  const descriptor = specialists.find((entry) => entry.id === occupant.id);
  return descriptor ? ROLE_ZONE[descriptor.role] : UNREGISTERED_ZONE;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Uplink pillars.
 *
 * A pillar is lit ONLY for `connected` and `local_only` — the two states
 * `live/connections.ts` allows to carry effective capabilities. Everything
 * else, including `configured` and `dispatchable`, is drawn dark: those mean
 * "the setup looks right", which is not the same claim as "this works", and
 * a lit pillar would make the weaker claim look like the stronger one.
 */
export const LIT_CONNECTION_STATES = ['connected', 'local_only'] as const;

function uplinkFixtures(connections: readonly ConnectionStatus[]): Fixture[] {
  return connections.map((connection) => {
    const lit = (LIT_CONNECTION_STATES as readonly string[]).includes(connection.state);
    return {
      id: `uplink-${connection.id}`,
      label: connection.displayName,
      detail: CONNECTION_STATE_LABELS[connection.state],
      lit,
      tone: lit ? 'accent' : connection.state === 'error' || connection.state === 'expired' ? 'danger' : 'neutral',
      evidence: connection.reason,
      stationId: null,
    };
  });
}

/**
 * One plinth per project on the board.
 *
 * `detail` and `evidence` must NAME the condition that set the tone. A bay
 * flagged danger while its text reported only "4 open · 1 done" told the
 * Founder something was wrong and not what: a blocked project and a healthy
 * one with identical counts differed by styling and a generic marker alone,
 * in both the station title and the room panel (Codex review of `a455799`).
 * The marker says LOOK HERE; the words have to say why.
 */
function projectFixtures(projects: readonly ProjectBoardCard[]): Fixture[] {
  return projects.map((project) => {
    const counts: string[] = [];
    if (project.blockedCount > 0) counts.push(`${project.blockedCount} blocked`);
    if (project.waitingForFounderCount > 0) counts.push(`${project.waitingForFounderCount} waiting on Founder`);
    counts.push(`${project.openCount} open`, `${project.completedCount} done`);

    const cause =
      project.blockedCount > 0
        ? `${project.blockedCount} task(s) recorded as blocked or outcome_unknown. `
        : project.waitingForFounderCount > 0
          ? `${project.waitingForFounderCount} task(s) recorded as needs_approval — only the Founder can clear them. `
          : '';

    return {
      id: `bay-${project.project}`,
      label: project.project,
      detail: counts.join(' · '),
      lit: project.openCount > 0,
      tone:
        project.blockedCount > 0
          ? 'danger'
          : project.waitingForFounderCount > 0
            ? 'warn'
            : project.openCount > 0
              ? 'info'
              : 'neutral',
      evidence:
        cause +
        (project.openCount > 0
          ? `${project.openCount} task(s) recorded open, last activity ${project.lastActivity}.`
          : `No open tasks recorded; last activity ${project.lastActivity}.`),
      stationId: null,
    };
  });
}

function approvalFixtures(dashboard: FounderDashboard, approvals: readonly ApprovalRequest[]): Fixture[] {
  const pending = approvals.filter((approval) => approval.decision === 'pending');
  const waiting = dashboard.waitingForFounder;
  const fixtures: Fixture[] = [
    {
      id: 'bench-approvals',
      label: 'Approval bench',
      detail: `${pending.length} pending request(s)`,
      lit: pending.length > 0,
      tone: pending.length > 0 ? 'warn' : 'neutral',
      evidence:
        pending.length > 0
          ? `${pending.length} approval request(s) recorded with decision "pending".`
          : 'No approval request is recorded as pending.',
      stationId: null,
    },
    {
      id: 'bench-gated-tasks',
      label: 'Gated work',
      detail: `${waiting.length} task(s) at the gate`,
      lit: waiting.length > 0,
      tone: waiting.length > 0 ? 'warn' : 'neutral',
      evidence:
        waiting.length > 0
          ? `${waiting.length} task(s) recorded as needs_approval — no worker may proceed on them.`
          : 'No task is recorded as needs_approval.',
      stationId: null,
    },
  ];
  return fixtures;
}

function archiveFixtures(archive: readonly ArchiveRecord[]): Fixture[] {
  const projects = new Set(archive.map((record) => record.project).filter(Boolean));
  return [
    {
      id: 'stack-records',
      label: 'Evidence records',
      detail: `${archive.length} record(s)`,
      lit: false,
      tone: 'neutral',
      evidence:
        'Archive records are reconstructed documentation, not original evidence, so the stacks are never drawn as live.',
      stationId: null,
    },
    {
      id: 'stack-projects',
      label: 'Projects covered',
      detail: `${projects.size} project(s)`,
      lit: false,
      tone: 'neutral',
      evidence: `${projects.size} distinct project(s) appear across the archived records.`,
      stationId: null,
    },
  ];
}

function situationFixtures(chatMessages: readonly ChatMessage[]): Fixture[] {
  const executive = chatMessages.filter((message) => message.threadId === 'executive-room');
  const latest = executive.reduce<string | null>((newest, message) => (newest && newest > message.at ? newest : message.at), null);
  return [
    {
      id: 'table-transcript',
      label: 'Executive Room transcript',
      detail: `${executive.length} message(s)`,
      lit: false,
      tone: 'neutral',
      evidence: latest
        ? `Transcript holds ${executive.length} message(s); the most recent is timestamped ${latest}. A transcript is a record, never a live meeting.`
        : 'No Executive Room message is recorded, so no meeting can be shown.',
      stationId: null,
    },
  ];
}

function commandFixtures(dashboard: FounderDashboard, states: readonly TaskState[]): Fixture[] {
  return [
    {
      id: 'console-inflight',
      label: 'In flight',
      detail: `${dashboard.now.length} task(s)`,
      lit: dashboard.now.length > 0,
      tone: dashboard.now.length > 0 ? 'info' : 'neutral',
      evidence: `${dashboard.now.length} task(s) recorded in an active status right now.`,
      stationId: null,
    },
    {
      id: 'console-queued',
      label: 'Queued',
      detail: `${dashboard.next.length} task(s)`,
      lit: false,
      tone: 'neutral',
      evidence: `${dashboard.next.length} task(s) recorded as queued — accepted, not started.`,
      stationId: null,
    },
    {
      id: 'console-tracked',
      label: 'Tracked tasks',
      detail: `${states.length} total`,
      lit: false,
      tone: 'neutral',
      evidence: `${states.length} task(s) have produced at least one status-bearing canonical event.`,
      stationId: null,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The floor                                                           */
/* ------------------------------------------------------------------ */

/**
 * How alive a room is.
 *
 * `unstaffed` means the room holds NOTHING the canonical data knows about —
 * no worker and no fixture. A room full of dark uplink pillars is not
 * unstaffed, it is quiet: the pillars are real objects reporting a real
 * "not connected", and dimming that room to near-invisibility hid seven
 * truthful findings behind a styling rule meant for genuinely empty space.
 */
function liveness(occupants: readonly Occupant[], fixtures: readonly Fixture[]): ZoneLiveness {
  if (occupants.length === 0 && fixtures.length === 0) return 'unstaffed';
  // Same predicates the seat priorities use, so the room's word and what the
  // plan is able to draw can never be computed from different rules.
  if (occupants.some(occupantNeedsAttention) || fixtures.some(fixtureNeedsAttention)) {
    return 'attention';
  }
  if (occupants.some(occupantIsPositive) || fixtures.some(fixtureIsPositive)) {
    return 'active';
  }
  return 'quiet';
}

/**
 * Seat occupants and stand fixtures at the stations their room actually has.
 *
 * A room has a finite number of desks. When more occupants belong to a room
 * than it has stations, the surplus is still listed in the drill-down panel —
 * it simply has no seat drawn, which is the truthful rendering of a room that
 * is over capacity. Nothing is dropped from the data.
 */
/**
 * Station kinds a WORKER may stand at, and those a FIXTURE may stand on.
 *
 * These two sets MUST stay disjoint, and `test/spatial-truth.test.ts` asserts
 * that they are. Both lists once contained `console`, so on the Command Deck a
 * registered `mission_director` and the "In flight" console were seated at the
 * same station; the renderer gives the occupant precedence, so an OFFLINE
 * director made the in-flight console read as dark while tasks were genuinely
 * in flight — the fixture's canonical lit state silently replaced by the
 * worker's, and its label dropped from the station's accessible title.
 *
 * That is the exact failure this page exists to prevent, so the fix is
 * structural rather than a tie-break rule: a station belongs to one kind of
 * claim, and the two can never collide to be arbitrated in the first place.
 * (Codex exact-head review of `936a682`, P2.)
 */
export const WORKER_STATION_KINDS = ['desk', 'review_bay'] as const;
export const FIXTURE_STATION_KINDS = ['uplink', 'bay', 'stack', 'bench', 'console', 'table'] as const;

/**
 * How badly a thing needs one of a room's limited stations.
 *
 * 0 — it is WHY the room needs attention (a blocked or Founder-gated worker,
 *     an errored or expired connection). Seat it first, always.
 * 1 — it is positive evidence: active work, a lit fixture.
 * 2 — everything else. Its absence from the plan asserts nothing.
 */
export const SEAT_PRIORITY = { attention: 0, positive: 1, ordinary: 2 } as const;

/*
 * The four predicates below are the SINGLE definition of "needs attention"
 * and "is positive evidence" for each kind of thing on the floor.
 *
 * They exist as named functions rather than inline conditions because the
 * same two rules are needed in two places — `liveness()`, which decides the
 * room's word, and the seat priorities, which decide what the plan can draw —
 * and those two must agree by construction. A room flagged by one rule and
 * seated by the other is precisely the defect class that has now produced
 * four review findings on this file: two individually-correct rules, written
 * separately, drifting apart. Duplicating the predicate a fifth time would be
 * betting that the next edit updates every copy.
 */
export function occupantNeedsAttention(occupant: Occupant): boolean {
  return ATTENTION_ACTIVITIES.includes(occupant.activity);
}

export function occupantIsPositive(occupant: Occupant): boolean {
  return ANIMATED_ACTIVITIES.includes(occupant.activity);
}

export function fixtureNeedsAttention(fixture: Fixture): boolean {
  return fixture.tone === 'warn' || fixture.tone === 'danger';
}

export function fixtureIsPositive(fixture: Fixture): boolean {
  return fixture.lit;
}

export function occupantSeatPriority(occupant: Occupant): number {
  if (occupantNeedsAttention(occupant)) return SEAT_PRIORITY.attention;
  if (occupantIsPositive(occupant)) return SEAT_PRIORITY.positive;
  return SEAT_PRIORITY.ordinary;
}

export function fixtureSeatPriority(fixture: Fixture): number {
  if (fixtureNeedsAttention(fixture)) return SEAT_PRIORITY.attention;
  return fixtureIsPositive(fixture) ? SEAT_PRIORITY.positive : SEAT_PRIORITY.ordinary;
}

/**
 * Seat items at a room's stations, most-needing-to-be-seen first.
 *
 * A room has finitely many stations and its occupant and fixture lists are
 * data-driven, so over-capacity is normal and something must be left unseated.
 * The question this function answers is WHICH — and the answer has to follow
 * the evidence, because the room's liveness word is computed from ALL of its
 * contents while the plan can only draw what it seats.
 *
 * Two rounds of review walked this in:
 *
 *   · plain list order let an unlit fixture take the last station and push a
 *     lit one off the plan (Codex on `9c0e354`);
 *   · lit-first then let eight healthy connections fill the Uplink Gallery
 *     and drop an ERRORED one — so the room read "Needs attention" while the
 *     plan showed nothing but healthy pillars, hiding the very fixture that
 *     caused the warning (Codex on `a123dbc`).
 *
 * The same hole existed for occupants and was not reported: eight working
 * builders filled the Build Floor and a blocked worker went unseated, with
 * the room again marked for attention and the plan showing only busy people.
 * Both now run through this one function, so the rule cannot hold for one
 * kind of claim and quietly lapse for the other.
 *
 * The invariant, asserted in `test/spatial-truth.test.ts`: whatever puts a
 * room into `attention` is always among the things drawn in it. Items keep
 * their caller order in the returned list, so the panel and the plan agree.
 */
function seatByPriority<T extends { stationId: string | null }>(
  items: T[],
  zone: Zone,
  kinds: readonly string[],
  priority: (item: T) => number,
): T[] {
  const stations = zone.stations.filter((station) => kinds.includes(station.kind));
  // Sort indices, not items: a stable order by (priority, original position)
  // keeps the assignment deterministic when several items tie.
  const order = [...items.keys()].sort(
    (a, b) => priority(items[a]) - priority(items[b]) || a - b,
  );
  const assigned = new Map<number, string>();
  order.forEach((itemIndex, rank) => {
    if (rank < stations.length) assigned.set(itemIndex, stations[rank].id);
  });
  return items.map((item, index) => ({ ...item, stationId: assigned.get(index) ?? null }));
}


export function floorState(input: FloorInput): FloorState {
  const occupants = floorOccupants(input.specialists, input.workers, input.states);
  const byZone = new Map<string, Occupant[]>();
  for (const occupant of occupants) {
    const zoneId = occupantZone(occupant, input.specialists);
    byZone.set(zoneId, [...(byZone.get(zoneId) ?? []), occupant]);
  }

  const fixturesByZone: Record<string, Fixture[]> = {
    'command-deck': commandFixtures(input.dashboard, input.states),
    'founder-suite': approvalFixtures(input.dashboard, input.approvals),
    'project-bays': projectFixtures(input.projects),
    'uplink-gallery': uplinkFixtures(input.connections),
    'archive-stacks': archiveFixtures(input.archive),
    'situation-room': situationFixtures(input.chatMessages),
  };

  const drillDowns: Record<string, { href: string; label: string }> = {
    'command-deck': { href: 'index.html', label: 'Open the Command Center' },
    'build-floor': { href: 'specialists.html', label: 'Open the Specialist Directory' },
    'review-vault': { href: 'specialists.html', label: 'Open the Specialist Directory' },
    'founder-suite': { href: 'approvals.html', label: 'Open Founder Approvals' },
    'project-bays': { href: 'projects.html', label: 'Open Projects' },
    'uplink-gallery': { href: 'connections.html', label: 'Open Connections' },
    'archive-stacks': { href: 'archive.html', label: 'Open the Archive' },
    'situation-room': { href: 'executive-room.html', label: 'Open the Executive Room' },
  };

  const zones: ZoneState[] = HQ_FLOOR.map((zone) => {
    const zoneOccupants = seatByPriority(
      byZone.get(zone.id) ?? [],
      zone,
      WORKER_STATION_KINDS,
      occupantSeatPriority,
    );
    const zoneFixtures = seatByPriority(
      fixturesByZone[zone.id] ?? [],
      zone,
      FIXTURE_STATION_KINDS,
      fixtureSeatPriority,
    );
    const active = zoneOccupants.filter(occupantIsPositive).length;
    const attention = zoneOccupants.filter(occupantNeedsAttention).length;
    const summaryParts: string[] = [];
    if (zoneOccupants.length > 0) {
      summaryParts.push(`${zoneOccupants.length} worker(s)`, `${active} active`, `${attention} needing attention`);
    }
    if (zoneFixtures.length > 0) {
      summaryParts.push(`${zoneFixtures.filter((fixture) => fixture.lit).length} of ${zoneFixtures.length} lit`);
    }
    return {
      zone,
      liveness: liveness(zoneOccupants, zoneFixtures),
      summary: summaryParts.length > 0 ? summaryParts.join(' · ') : 'Nothing canonical is recorded for this room.',
      occupants: zoneOccupants,
      fixtures: zoneFixtures,
      drillDown: drillDowns[zone.id] ?? null,
    };
  });

  const allFixtures = zones.flatMap((zone) => zone.fixtures);
  const uplinks = allFixtures.filter((fixture) => fixture.id.startsWith('uplink-'));

  return {
    zones,
    totals: {
      occupants: occupants.length,
      active: occupants.filter(occupantIsPositive).length,
      blocked: occupants.filter((occupant) => occupant.activity === 'blocked').length,
      awaitingFounder: occupants.filter((occupant) => occupant.activity === 'awaiting_founder').length,
      offline: occupants.filter((occupant) => occupant.activity === 'offline').length,
      litUplinks: uplinks.filter((fixture) => fixture.lit).length,
      uplinks: uplinks.length,
    },
  };
}
