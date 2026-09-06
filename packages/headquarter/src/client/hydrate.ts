/**
 * Canonical state → room views (issue #250, Stage 4 §C).
 *
 * ## The one rule
 *
 * Everything in this file COPIES or COUNTS. It never derives a status HQ does
 * not record, never fills an empty room with a plausible-looking row, and never
 * turns an absent answer into a zero. Those are three different failure modes
 * and the type system separates the last one: a live-bound room with no state
 * document is `awaiting`, and only a room whose document actually arrived can
 * be `live` and say "0".
 *
 * ## Why it is pure
 *
 * `hydrateRooms(state, session)` is a total function of its two inputs. That is
 * what lets `test/client-hydration.test.ts` assert the no-fake-state property
 * exhaustively — feed it an empty HQ and check that every single room comes
 * back with zeroes, empty row lists and a `dark` liveness, with no exceptions
 * and no room quietly opting out. A renderer that reached for data itself could
 * not be checked that way.
 *
 * ## Liveness is evidence, not decoration
 *
 * `RoomLiveness` decides whether a room glows and whether anything in it moves.
 * It is computed here, from counts, so the 3D shell has no way to animate a
 * room that canonical state says is empty. The ordering is deliberate:
 * `attention` outranks `active`, because a room with blocked work and running
 * work is a room you need to walk into.
 */

import { HQ_ROOMS, type HqRoom, type RoomSection } from './rooms.js';
import {
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_TONE,
  LIT_CONNECTION_STATES,
  type ConnectionState,
} from '../live/connections.js';
import type {
  ClientSession,
  HqStateDocument,
  RoomChip,
  RoomLiveness,
  RoomMetric,
  RoomRow,
  RoomTone,
  RoomView,
} from './contracts.js';

/** How many rows a room lists before it says how many more there are. */
export const ROOM_ROW_LIMIT = 12;

/**
 * Statuses that mean "this needs a human". Copied from the canonical
 * vocabulary rather than restated, so a status added to the contract does not
 * silently become "fine".
 */
// Statuses that colour a chip or a per-status metric as needing attention.
//
// `review_failed` belongs here because the canonical console files it in the
// BLOCKED bucket (`[...byStatus('blocked'), ...byStatus('review_failed')]`).
// It was missing, so a canonically-blocked task wore a neutral chip — the same
// disagreement between a status reading and a bucket reading that this file now
// refuses to make about liveness (Codex round 13).
//
// This set no longer decides whether any room is LIT. That is bucket
// membership, everywhere.
const ATTENTION_STATUSES = new Set(['blocked', 'review_failed', 'outcome_unknown', 'needs_approval']);

// RUNNING_STATUSES is deliberately GONE.
//
// It held ['assigned', 'running'] and looked like the obvious way to ask "is a
// worker holding this task". It is not, and that is exactly how the Mission
// Room came to pulse for work nobody was executing: a task awaiting independent
// review keeps status `running` while `founderConsole` excludes it from
// `inFlight` on purpose. The status is a fact about the task; the bucket is the
// canonical answer to the question, and the two are not the same question.
//
// `ops.inFlight.length` is that answer, and it is what every room now uses.
// The set is not left here unused, because an unused shortcut with a plausible
// name is the next person's mistake waiting to happen (Codex round 13).

function tone(count: number, positive: RoomTone, zero: RoomTone = 'neutral'): RoomTone {
  return count > 0 ? positive : zero;
}

function metric(label: string, value: number | string, hint: string, t: RoomTone): RoomMetric {
  return { label, value, hint, tone: t };
}

/**
 * `attention` beats `active` beats `quiet` beats `dark`.
 *
 * `quiet` requires `present > 0`: a room that holds records but none of them
 * active is quiet; a room that holds nothing at all is dark. Collapsing those
 * two would let an empty HQ render as a merely-idle one.
 */
export function livenessFrom(counts: {
  attention: number;
  active: number;
  present: number;
}): RoomLiveness {
  if (counts.attention > 0) return 'attention';
  if (counts.active > 0) return 'active';
  if (counts.present > 0) return 'quiet';
  return 'dark';
}

interface Section {
  metrics: RoomMetric[];
  rows: RoomRow[];
  emptyMessage: string;
  liveness: RoomLiveness;
}

type TaskLike = {
  taskId: string;
  capabilityId: string;
  status: string;
  project: string | null;
  title: string | null;
  updatedAt: string;
  assignedTo: string | null;
  blockReason?: string | null;
};

function taskRow(task: TaskLike): RoomRow {
  const chips: RoomChip[] = [
    { label: task.status, tone: ATTENTION_STATUSES.has(task.status) ? 'warn' : 'info' },
  ];
  if (task.project) chips.push({ label: task.project, tone: 'neutral' });
  if (task.assignedTo) chips.push({ label: task.assignedTo, tone: 'violet' });
  return {
    id: task.taskId,
    // `title` is presentation text a caller supplied and may be absent. The
    // capability id is always present and is what the task actually IS, so it
    // is the fallback rather than an invented "Untitled task".
    primary: task.title ?? task.capabilityId,
    secondary: task.blockReason
      ? `${task.capabilityId} — ${task.blockReason}`
      : `${task.capabilityId} · updated ${task.updatedAt}`,
    chips,
  };
}

function limited(rows: RoomRow[]): RoomRow[] {
  if (rows.length <= ROOM_ROW_LIMIT) return rows;
  const shown = rows.slice(0, ROOM_ROW_LIMIT);
  shown.push({
    id: '__more__',
    primary: `${rows.length - ROOM_ROW_LIMIT} more not listed here`,
    secondary:
      'The room lists the most recent records; the full set is in the canonical queue and on the ' +
      'matching HQ page.',
    chips: [],
  });
  return shown;
}

/* ------------------------------------------------------------------ */
/* Per-section projections                                             */
/* ------------------------------------------------------------------ */

function overviewSection(state: HqStateDocument): Section {
  const c = state.counts;
  const attention = c.approvals + c.blocked + c.outcomeUnknown;
  const active = c.inFlight;
  const present = attention + active + c.queued + c.pendingReviews;
  return {
    metrics: [
      metric('Waiting on the Founder', c.approvals, 'Recorded needs_approval — nothing moves until decided.', tone(c.approvals, 'warn')),
      metric('In flight', c.inFlight, 'Recorded assigned or running.', tone(c.inFlight, 'info')),
      metric('Queued', c.queued, 'Accepted and not started.', tone(c.queued, 'neutral')),
      metric('Blocked', c.blocked, 'Recorded blocked — work has stopped.', tone(c.blocked, 'danger')),
      metric('Outcome unknown', c.outcomeUnknown, 'The result was never confirmed.', tone(c.outcomeUnknown, 'danger')),
      metric('Pending review', c.pendingReviews, 'Awaiting the independent review lane.', tone(c.pendingReviews, 'info')),
    ],
    rows: [],
    emptyMessage:
      'These are the only counts HQ keeps. There is no progress percentage, no ETA and no cost ' +
      'figure anywhere in this building, because HQ measures none of them.',
    liveness: livenessFrom({ attention, active, present }),
  };
}

function operationsSection(state: HqStateDocument): Section {
  const ops = state.operations.data;
  const rows = [
    ...ops.inFlight.map(taskRow),
    ...ops.blocked.map(taskRow),
    ...ops.outcomeUnknown.map(taskRow),
    ...ops.queued.map(taskRow),
  ];
  // Commanded missions recorded blocked or ready_review need the Founder to
  // walk in — the same bucket arithmetic the Mission Room uses, so the two
  // rooms cannot disagree about the same missions (Phase 3).
  const missionsNeedingDecision = state.missions.data.filter(
    (mission) => MISSION_ATTENTION_STATUSES.has(mission.status),
  ).length;
  const attention =
    ops.blocked.length + ops.outcomeUnknown.length + ops.approvals.length + missionsNeedingDecision;
  return {
    metrics: [
      metric('In flight', ops.inFlight.length, 'Assigned or running right now.', tone(ops.inFlight.length, 'info')),
      metric('Queued', ops.queued.length, 'Accepted, not started.', tone(ops.queued.length, 'neutral')),
      metric('Stopped', ops.blocked.length + ops.outcomeUnknown.length, 'Blocked or outcome unknown.', tone(ops.blocked.length + ops.outcomeUnknown.length, 'danger')),
      metric('Awaiting decision', ops.approvals.length, 'Held at the Founder gate.', tone(ops.approvals.length, 'warn')),
      // Counted here because the room's PRESENCE now includes it, and a room
      // that is not dark must show the reader why. Without this metric the
      // Command Room would sit quiet over four zeroes.
      metric('Awaiting review', ops.pendingReviews.length, 'Submitted and waiting for the independent review lane.', tone(ops.pendingReviews.length, 'info')),
      metric('Missions needing a decision', missionsNeedingDecision, 'Commanded missions recorded blocked or ready for review — the Mission Room holds them.', tone(missionsNeedingDecision, 'warn')),
    ],
    rows: limited(rows),
    // The empty message has to agree with the metrics above it.
    //
    // The Command Room lists what is moving or stuck — in flight, queued,
    // blocked, unresolved — and deliberately does NOT list approvals, which
    // are the Approvals room's subject. But it COUNTS them, and it goes to
    // `attention` liveness for them. So immediately after an order is
    // submitted (the ordinary case: one approval pending, nothing else) the
    // room had no rows and said "HQ is holding nothing" directly beneath a
    // metric reading 1 and a room lit amber. Two true numbers and a false
    // sentence between them (Codex P2 on `7e87392`).
    //
    // Pending reviews are the same case one bucket over, and they were missing
    // (Codex round 14): with ONLY a pending review recorded, `present:
    // rows.length` was 0, so this room went DARK and said "HQ is holding
    // nothing" while Home and Mission — which count the task — said quiet. A
    // dark room means HQ holds nothing here, and HQ held something.
    emptyMessage: (() => {
      const held: string[] = [];
      if (ops.approvals.length > 0) {
        held.push(
          `${ops.approvals.length} task(s) are held at the Founder gate and cannot start until ` +
            'decided — they are listed in the Approvals room',
        );
      }
      if (ops.pendingReviews.length > 0) {
        held.push(
          `${ops.pendingReviews.length} task(s) are submitted and waiting for the independent ` +
            'review lane, so no worker is executing them',
        );
      }
      // The same lesson one aggregate over (Phase 3): the room COUNTS
      // decision-needing missions and lights amber for them, so it must not
      // say "holding nothing" beneath a non-zero mission metric.
      if (missionsNeedingDecision > 0) {
        held.push(
          `${missionsNeedingDecision} commanded mission(s) are blocked or ready for review — ` +
            'they are listed in the Mission Room',
        );
      }
      if (held.length > 0) {
        return `Nothing is in flight, queued, blocked or unresolved — but ${held.join('; and ')}.`;
      }
      // "HQ is holding nothing" is a whole-HQ sentence, so it may only be
      // said when the mission record is empty too. With missions on the books
      // and no task work, the honest sentence is narrower (Phase 3).
      if (state.missions.data.length > 0) {
        return (
          'No task is recorded in flight, queued, blocked or unresolved. The commanded mission ' +
          `record lives in the Mission Room (${state.missions.data.length} mission(s)); no task ` +
          'work has been opened for it here.'
        );
      }
      return (
        'No task is recorded in flight, queued, blocked or unresolved. The Command Room is empty ' +
        'because HQ is holding nothing, not because nothing loaded.'
      );
    })(),
    liveness: livenessFrom({
      attention,
      active: ops.inFlight.length,
      present:
        rows.length + ops.approvals.length + ops.pendingReviews.length + missionsNeedingDecision,
    }),
  };
}

/**
 * Mission statuses that put the room into the Founder's attention set:
 * `blocked` needs unblocking, `ready_review` needs a verification decision.
 * Stated once, and the Command Room's mission metric uses the same set, so
 * the two rooms cannot disagree about the same missions.
 */
const MISSION_ATTENTION_STATUSES = new Set(['blocked', 'ready_review']);

function missionRow(mission: HqStateDocument['missions']['data'][number]): RoomRow {
  const chips: RoomChip[] = [
    {
      label: mission.status,
      tone: MISSION_ATTENTION_STATUSES.has(mission.status)
        ? 'warn'
        : mission.status === 'failed'
          ? 'danger'
          : 'info',
    },
  ];
  if (mission.priority) chips.push({ label: mission.priority, tone: 'neutral' });
  if (mission.project) chips.push({ label: mission.project, tone: 'neutral' });
  // Phase 6 (issue #265): the derived execution summary, from per-item data
  // this document already carries — counts, never a percentage. "unspecified"
  // = live work items with no Founder work spec, which the orchestrator
  // truthfully cannot action (nothing is parsed out of summaries).
  const live = mission.planItems.filter((item) => item.state !== 'superseded');
  const work = live.filter((item) => item.kind === 'work');
  const linked = work.filter((item) => item.taskId != null).length;
  const unspecified = work.filter((item) => item.taskId == null && item.specCapabilityId == null).length;
  const execution =
    work.length > 0
      ? ` · ${linked}/${work.length} work item(s) linked${unspecified > 0 ? ` · ${unspecified} unspecified` : ''}`
      : '';
  return {
    id: mission.id,
    primary: mission.title,
    secondary: mission.blockReason
      ? `${mission.objective} — blocked: ${mission.blockReason}`
      : `${mission.objective} · ${live.length} plan item(s)${execution} · updated ${mission.updatedAt}`,
    chips,
  };
}

function missionsSection(state: HqStateDocument): Section {
  // PHASE 3 SEMANTIC CHANGE, recorded here deliberately (issue #254 and the
  // matching docs/JENIFY_DECISIONS.md entry). Until Phase 3 this room
  // projected open `op_tasks` rows as "missions" — an honest projection of
  // the only canonical data that existed. A Mission is now its own canonical
  // aggregate (`hq_missions`), commanded by the Founder, and this room shows
  // THAT. Tasks remain the Command Room's subject; a mission's linked tasks
  // surface through its plan items. Zero missions truthfully means zero
  // COMMANDED missions even while tasks exist — the counts of the two rooms
  // are counts of different canonical entities now, and each says which.
  //
  // The round-13 lesson carries over unchanged: whether this room is LIT
  // comes from the stated canonical status sets below, never re-derived from
  // any other string, and the Command Room's mission metric shares the same
  // arithmetic so the rooms cannot describe the same missions differently.
  const missions = state.missions.data;
  const byStatus = new Map<string, number>();
  for (const mission of missions) {
    byStatus.set(mission.status, (byStatus.get(mission.status) ?? 0) + 1);
  }
  const attention = missions.filter((mission) =>
    MISSION_ATTENTION_STATUSES.has(mission.status),
  ).length;
  const active = missions.filter((mission) => mission.status === 'working').length;
  const terminal = new Set(['complete', 'failed', 'cancelled']);
  const ordered = [
    ...missions.filter((mission) => MISSION_ATTENTION_STATUSES.has(mission.status)),
    ...missions.filter((mission) => mission.status === 'working'),
    ...missions.filter((mission) => mission.status === 'planned'),
    ...missions.filter((mission) => mission.status === 'verified'),
    ...missions.filter((mission) => terminal.has(mission.status)),
  ];
  return {
    metrics: [
      metric('Missions commanded', missions.length, 'Canonical missions the Founder has commanded. 0 means 0.', tone(missions.length, 'info')),
      ...[...byStatus.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([status, count]) =>
          metric(
            status,
            count,
            `Missions whose canonical status is ${status}.`,
            MISSION_ATTENTION_STATUSES.has(status) ? 'warn' : status === 'failed' ? 'danger' : 'neutral',
          ),
        ),
    ],
    rows: limited(ordered.map(missionRow)),
    emptyMessage:
      'HQ holds no commanded mission. 0 means 0 — the Founder has commanded nothing yet, and ' +
      'nothing is invented to fill the room. Open tasks are the Command Room’s subject and are ' +
      'not restated here as missions.',
    liveness: livenessFrom({ attention, active, present: missions.length }),
  };
}

function approvalsSection(state: HqStateDocument): Section {
  const approvals = state.operations.data.approvals;
  const blockedDispatch = approvals.filter(
    (card) => (card as { dispatchBlocked?: unknown }).dispatchBlocked === true,
  ).length;
  return {
    metrics: [
      metric('Awaiting your decision', approvals.length, 'Each holds work that cannot proceed.', tone(approvals.length, 'warn')),
      metric('Blocked at dispatch', blockedDispatch, 'Approving would not publish: the bound provider cannot dispatch from here.', tone(blockedDispatch, 'danger')),
    ],
    rows: limited(
      approvals.map((card) => ({
        id: card.taskId,
        primary: card.title ?? card.capabilityId,
        secondary: card.ask,
        chips: [
          { label: card.capabilityId, tone: 'info' as RoomTone },
          { label: `digest ${card.actionDigest.slice(0, 12)}`, tone: 'neutral' as RoomTone },
          ...(card.requesterAuthentication
            ? [{ label: `requester: ${card.requesterAuthentication}`, tone: 'warn' as RoomTone }]
            : []),
        ],
      })),
    ),
    emptyMessage:
      'Nothing is waiting on a Founder decision. The two decisions this model has are approve and ' +
      'deny; there is no third, so none is drawn.',
    liveness: livenessFrom({ attention: approvals.length, active: 0, present: approvals.length }),
  };
}

function workforceSection(state: HqStateDocument): Section {
  const workers = state.workforce.data;
  const active = workers.filter((worker) => worker.active).length;
  return {
    metrics: [
      metric('Registered workers', workers.length, 'Rows in the canonical specialist directory.', tone(workers.length, 'info')),
      metric('Marked active', active, 'The registry’s own active flag. Not a claim that one is working now.', tone(active, 'accent')),
      metric('Marked inactive', workers.length - active, 'Registered but not permitted to hold work.', tone(workers.length - active, 'neutral')),
    ],
    rows: limited(
      workers.map((worker) => ({
        id: worker.id,
        primary: worker.displayName,
        secondary: `${worker.vendor} · ${worker.role} · ${worker.allowedCapabilities.length} granted capability(ies)`,
        chips: [
          { label: worker.active ? 'active' : 'inactive', tone: worker.active ? 'accent' : ('neutral' as RoomTone) },
          { label: worker.role, tone: 'violet' as RoomTone },
          // Phase 4 truth chips. Provider: declared or absent, never
          // inferred from the vendor string. Dispatchable renders only when
          // the building context genuinely observed it (three-valued).
          // Member health: 'unknown' is drawn AS unknown — nothing probed,
          // nothing claimed.
          ...(worker.provider
            ? [
                { label: `provider: ${worker.provider.declaredId}`, tone: 'info' as RoomTone },
                ...(worker.provider.dispatchable !== null
                  ? [
                      {
                        label: worker.provider.dispatchable ? 'dispatchable' : 'not dispatchable',
                        tone: worker.provider.dispatchable ? 'accent' : ('warn' as RoomTone),
                      },
                    ]
                  : []),
              ]
            : [{ label: 'no provider declared', tone: 'neutral' as RoomTone }]),
          ...(worker.member
            ? [
                {
                  label: `health: ${worker.member.health}`,
                  tone:
                    worker.member.health === 'healthy'
                      ? ('accent' as RoomTone)
                      : worker.member.health === 'unknown'
                        ? ('neutral' as RoomTone)
                        : ('warn' as RoomTone),
                },
              ]
            : []),
        ],
      })),
    ),
    emptyMessage:
      'No worker is registered in the canonical directory. Nobody is drawn at a desk, because ' +
      'nobody is recorded at one.',
    // Registry membership is not activity. An `active` FLAG means the registry
    // permits this worker to hold work; it does not mean a task is running, and
    // this room must not pulse as though it did. `present` lights the room;
    // motion is reserved for the rooms that hold real running tasks.
    liveness: livenessFrom({ attention: 0, active: 0, present: workers.length }),
  };
}

function lanesSection(state: HqStateDocument): Section {
  const workers = state.workforce.data;
  const byRole = new Map<string, { total: number; active: number }>();
  for (const worker of workers) {
    const lane = byRole.get(worker.role) ?? { total: 0, active: 0 };
    lane.total += 1;
    if (worker.active) lane.active += 1;
    byRole.set(worker.role, lane);
  }
  const lanes = [...byRole.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return {
    metrics: [
      metric('Operating lanes', lanes.length, 'Distinct registered roles in the directory.', tone(lanes.length, 'info')),
      metric('Registered members', workers.length, 'Across every lane.', tone(workers.length, 'neutral')),
    ],
    rows: lanes.map(([role, counts]) => ({
      id: role,
      primary: role,
      secondary: `${counts.total} registered · ${counts.active} marked active`,
      chips: [{ label: `${counts.total}`, tone: 'info' as RoomTone }],
    })),
    emptyMessage:
      'No lane exists, because no worker is registered. HQ does not persist a department registry ' +
      'of its own — these lanes ARE the recorded roles, and with no workers there are none.',
    liveness: livenessFrom({ attention: 0, active: 0, present: lanes.length }),
  };
}

function capabilitiesSection(state: HqStateDocument): Section {
  const caps = state.capabilities.data;
  const enabled = caps.filter((cap) => cap.enabled).length;
  const destructive = caps.filter((cap) => cap.riskClass === 'destructive').length;
  return {
    metrics: [
      metric('Registered capabilities', caps.length, 'Rows in the canonical capability registry.', tone(caps.length, 'info')),
      metric('Enabled', enabled, 'May be executed at all.', tone(enabled, 'accent')),
      metric('Disabled', caps.length - enabled, 'Registered and switched off.', tone(caps.length - enabled, 'neutral')),
      metric('Destructive class', destructive, 'Always Founder-gated, whatever else is configured.', tone(destructive, 'warn')),
    ],
    rows: limited(
      caps.map((cap) => ({
        id: cap.id,
        primary: cap.id,
        secondary: cap.description,
        chips: [
          { label: cap.riskClass, tone: cap.riskClass === 'read_only' ? 'neutral' : ('warn' as RoomTone) },
          { label: cap.enabled ? 'enabled' : 'disabled', tone: cap.enabled ? 'accent' : ('neutral' as RoomTone) },
          // The canonical classification's own words for what running this
          // would demand. Copied from `classifyCapability`, never re-derived
          // here — this room must not disagree with the Approval Center about
          // whether something needs a Founder.
          {
            label: cap.classification.requiresApproval ? 'Founder approval required' : 'no approval gate',
            tone: cap.classification.requiresApproval ? 'warn' : ('neutral' as RoomTone),
          },
        ],
      })),
    ),
    emptyMessage:
      'The capability registry is empty, so HQ is permitted to do nothing at all. That is a real ' +
      'and safe state, not a loading failure.',
    liveness: livenessFrom({ attention: 0, active: 0, present: caps.length }),
  };
}

/**
 * The states "Needing attention" counts — and the words the hint uses to say so.
 *
 * The hint used to read "Reported error or expired credential". That was true
 * of the older, narrower filter and became false the moment the count started
 * reading `CONNECTION_STATE_TONE`, which also warns on `configured` and
 * `setup_required`. So a count of 1 told the Founder a failure had occurred
 * when the integration may only be half set up — a page whose whole claim is
 * that it never asserts more than canonical state supports, asserting a
 * failure that canonical state does not record (Codex round 17).
 *
 * Both the filter and the hint now read this one list, and the list is derived
 * from the same mapping, so the number and its explanation cannot drift, and a
 * state whose tone changes moves both at once.
 */
const WARNED_CONNECTION_STATES: readonly ConnectionState[] = (
  Object.keys(CONNECTION_STATE_TONE) as ConnectionState[]
).filter((state) => CONNECTION_STATE_TONE[state] === 'warn' || CONNECTION_STATE_TONE[state] === 'danger');

const NEEDS_ATTENTION_HINT = `Integrations HQ records as: ${WARNED_CONNECTION_STATES.map(
  (state) => CONNECTION_STATE_LABELS[state],
).join(', ')}. A reported failure and a half-finished setup both count.`;

function connectionsSection(state: HqStateDocument): Section {
  const connections = state.connections.data;
  // Reachability from the canonical list, not a copy of it.
  //
  // This was `connected || local_only` written out here, duplicating
  // LIT_CONNECTION_STATES — which lived in the spatial floor's presentation
  // layer, so the two agreed by luck rather than by construction. I flagged it
  // on the round-16 thread and offered to move it; leaving two lists agreeing
  // by luck is the same restatement shape that caused the finding directly
  // above, so it is moved rather than left as an offer. The constant now sits
  // beside CONNECTION_STATE_TONE in `live/connections.ts`, where the docstring
  // already referred to it, and both views read the one list.
  const lit = connections.filter((connection) =>
    (LIT_CONNECTION_STATES as readonly string[]).includes(connection.state),
  ).length;
  // Attention comes from the CANONICAL tone mapping, not a list kept here.
  //
  // This filter named `error` and `expired` only, so an integration that is
  // `configured` or `setup_required` — ordinary outcomes from
  // `assessConnections` — left both connection-backed rooms quiet and reported
  // "Needing attention: 0". `CONNECTION_STATE_TONE` already classifies both as
  // warnings, and its docstring exists BECAUSE this exact defect was caught
  // once before on another surface: "a half-finished integration raised a flag
  // in one place and left the floor reading Quiet". I restated a narrower list
  // beside the mapping that was created to stop precisely that (Codex round
  // 16).
  const warned = (state: string): boolean =>
    (WARNED_CONNECTION_STATES as readonly string[]).includes(state);
  const needsAttention = connections.filter((connection) => warned(connection.state)).length;
  return {
    metrics: [
      metric('Known integrations', connections.length, 'Every integration HQ has a descriptor for.', 'neutral'),
      metric('Proven reachable', lit, 'Verified, or local-only with evidence. Configuration alone does not count.', tone(lit, 'accent')),
      metric('Needing attention', needsAttention, NEEDS_ATTENTION_HINT, tone(needsAttention, 'danger')),
    ],
    rows: limited(
      connections.map((connection) => ({
        id: connection.id,
        primary: connection.displayName,
        secondary: connection.reason,
        chips: [
          // Same mapping for the chip, so the row and the count cannot
          // disagree about the same integration.
          { label: connection.state, tone: ((CONNECTION_STATE_TONE as Record<string, RoomTone>)[connection.state] ?? 'neutral') },
          { label: connection.authMechanism, tone: 'violet' as RoomTone },
          ...(connection.missingFacts.length > 0
            ? [{ label: `missing: ${connection.missingFacts.join(', ')}`, tone: 'warn' as RoomTone }]
            : []),
        ],
      })),
    ),
    emptyMessage: 'HQ holds no integration descriptor at all, so the network has nothing to draw.',
    liveness: livenessFrom({ attention: needsAttention, active: 0, present: connections.length }),
  };
}

function projectsSection(state: HqStateDocument): Section {
  // PHASE 4 SEMANTIC CHANGE, recorded here deliberately (issue #262 and the
  // matching docs/JENIFY_DECISIONS.md entry) — the Mission Room rebinding
  // treatment, applied to this room. Until Phase 4 this section counted the
  // free-text `project` LABELS on the recent activity window: an honest
  // projection of the only project-shaped data that existed. `hq_projects`
  // is now the canonical Founder-commanded project REGISTER, and this room
  // shows THAT. Activity labels stay labels and are not restated here; a
  // register entry's missions come from the canonical `project_id`
  // relationship, never from label matching.
  //
  // Liveness derives from the register's missions by the SAME status sets
  // the Mission Room uses (attention: MISSION_ATTENTION_STATUSES; active:
  // 'working'), so the two rooms can never describe the same missions
  // differently — the round-13 lesson, carried to the new entity.
  const projects = state.projects.data;
  const active = projects.filter((project) => project.status === 'active').length;
  const missionsAssigned = projects.reduce((sum, project) => sum + project.missions.length, 0);
  const attention = projects.filter((project) =>
    project.missions.some((mission) => MISSION_ATTENTION_STATUSES.has(mission.status)),
  ).length;
  const working = projects.filter((project) =>
    project.missions.some((mission) => mission.status === 'working'),
  ).length;
  return {
    metrics: [
      metric('Projects registered', projects.length, 'Canonical register entries the Founder has created. 0 means 0.', tone(projects.length, 'info')),
      metric('Active', active, 'Open for mission assignment.', tone(active, 'accent')),
      metric('Closed', projects.length - active, 'Closed with a recorded reason; reopenable.', tone(projects.length - active, 'neutral')),
      metric('Missions assigned', missionsAssigned, 'Canonical project_id relationships, not label matches.', tone(missionsAssigned, 'info')),
    ],
    rows: limited(
      projects.map((project) => ({
        id: project.id,
        primary: project.name,
        secondary: `${project.purpose} · ${project.missions.length} mission(s)`,
        chips: [
          {
            label: project.status,
            tone: project.status === 'active' ? 'accent' : ('neutral' as RoomTone),
          },
          ...(project.stream ? [{ label: project.stream, tone: 'violet' as RoomTone }] : []),
          ...(project.missions.length > 0
            ? [{ label: `${project.missions.length} mission(s)`, tone: 'info' as RoomTone }]
            : []),
        ],
      })),
    ),
    emptyMessage:
      'HQ holds no registered project. 0 means 0 — the Founder has registered nothing yet, and ' +
      'nothing is invented to fill the room. Project labels on activity events are labels, not ' +
      'this register.',
    liveness: livenessFrom({ attention, active: working, present: projects.length }),
  };
}

// activitySection is GONE, with its RoomSection member.
//
// No room was bound to it — 'activity' was the one declared section nothing
// used — so it never ran. It also carried the exact defect round 13 named: it
// derived `attention` by matching ATTENTION_STATUSES against `event.status`,
// where an activity event is a HISTORICAL log entry and its status is the
// status at the time of the event, not a statement about now. A room lit from
// that would have claimed something needs a human because something once did.
//
// Deleted rather than fixed and kept, for the reason RUNNING_STATUSES was
// deleted one round earlier: unused code with a plausible name is the next
// person's mistake waiting to happen, and this one was already wrong. The
// projects room still reads the activity data — through projectsSection, which
// counts what each project is carrying and never re-interprets a status.

function analyticsSection(state: HqStateDocument): Section {
  const c = state.counts;
  const open = c.approvals + c.pendingReviews + c.outcomeUnknown + c.blocked + c.inFlight + c.queued;
  const stopped = c.blocked + c.outcomeUnknown;
  return {
    metrics: [
      metric('Open records', open, 'The sum of the six canonical buckets. A count, not a workload estimate.', tone(open, 'info')),
      metric('Stopped', stopped, 'Blocked plus outcome-unknown.', tone(stopped, 'danger')),
      metric('Registered workers', state.workforce.data.length, 'Directory rows.', 'neutral'),
      metric('Registered capabilities', state.capabilities.data.length, 'Registry rows.', 'neutral'),
      metric('Integrations known', state.connections.data.length, 'Descriptor rows.', 'neutral'),
      metric('Events in window', state.activity.data.length, 'Canonical events carried by this document.', 'neutral'),
    ],
    rows: [],
    emptyMessage:
      'Analytics here is counting, and only counting. HQ records no duration, cost, token, ETA or ' +
      'completion figure, so none is shown and none is inferred — the wire format actively refuses ' +
      'those fields.',
    // Presence covers everything this room COUNTS, not just the task buckets.
    //
    // With `present: open` it went dark whenever no operation was open, even
    // while showing non-zero worker, capability, integration and event counts —
    // a room the page calls dark, meaning "HQ is holding nothing here", sitting
    // above four populated numbers (Codex round 3). Active and attention still
    // come from task state alone: registry rows are not work in progress.
    liveness: livenessFrom({
      // Approvals are attention here too.
      //
      // `stopped` alone left an approval-only HQ QUIET in this room while Home,
      // Command, Mission, Approvals and Founder Office all ranked the same
      // approval as attention — five rooms amber and this one not, over one
      // task. Worse when running work also existed: Analytics went `active`,
      // which under the documented attention-over-active ordering reads as
      // "work is moving and nothing needs you" (Codex round 14).
      //
      // Recorded plainly: my own sweep one commit earlier declared this room
      // sound. It was not. Reading each room in turn is not the same as
      // comparing them against each other, which is what the strengthened
      // cross-room test now does.
      attention: stopped + c.approvals,
      active: c.inFlight,
      present:
        open +
        state.workforce.data.length +
        state.capabilities.data.length +
        state.connections.data.length +
        state.activity.data.length,
    }),
  };
}

/**
 * Phase 7: the truth/evidence projection, when the state document carries
 * it. Every number here is a COUNT of derived categorical states the server
 * already computed; an absent section contributes nothing (not a zero) —
 * a static build opens no truth store and says so by omission.
 */
function truthFacts(state: HqStateDocument): {
  present: boolean;
  total: number;
  accepted: number;
  verified: number;
  awaitingAcceptance: number;
  unresolved: number;
  contradictionRows: RoomRow[];
} {
  const truth = state.truth?.data;
  if (!truth) {
    return { present: false, total: 0, accepted: 0, verified: 0, awaitingAcceptance: 0, unresolved: 0, contradictionRows: [] };
  }
  return {
    present: true,
    total: truth.total,
    accepted: truth.byState.accepted,
    verified: truth.byState.verified,
    // Verified, current and uncontested — exactly the records the server
    // issued an acceptance digest for, counted SERVER-SIDE over every record
    // the reader may see. Until review round 2 this was counted here over the
    // bounded `records` page (newest TRUTH_SNAPSHOT_LIMIT) while the sibling
    // `Founder-accepted` metric used `byState` over all records, so past
    // twenty records it understated the verified truth waiting at the gate.
    awaitingAcceptance: truth.awaitingAcceptance,
    unresolved: truth.unresolvedContradictions,
    contradictionRows: truth.contradictions.map((pair) => ({
      id: `contradiction-${pair.a}-${pair.b}`,
      primary: `Unresolved contradiction on ${pair.entityKind} ${pair.entityId}`,
      secondary:
        `${pair.a} contradicts ${pair.b} (stated by ${pair.statedBy} at ${pair.statedAt}). Neither side is preferred ` +
        'by recency; it resolves only by an explicit supersession or a refuting verification.',
      chips: [
        { label: 'unresolved', tone: 'danger' as RoomTone },
        { label: pair.entityKind, tone: 'info' as RoomTone },
      ],
    })),
  };
}

function founderSection(state: HqStateDocument, session: ClientSession | null): Section {
  const approvals = state.operations.data.approvals.length;
  const principal = typeof session?.principalId === 'string' ? session.principalId : null;
  const display = typeof session?.displayName === 'string' ? session.displayName : null;
  const approvalAuthority = session?.approvalAuthority === true;
  const truth = truthFacts(state);
  const rows: RoomRow[] = [];
  if (principal) {
    rows.push({
      id: principal,
      primary: display ?? principal,
      secondary: `Resolved principal ${principal}. Approval authority: ${approvalAuthority ? 'yes' : 'no'}.`,
      chips: [
        { label: approvalAuthority ? 'may approve' : 'no approval authority', tone: approvalAuthority ? 'accent' : 'neutral' },
      ],
    });
  }
  return {
    metrics: [
      metric('Held at your gate', approvals, 'Tasks recorded needs_approval.', tone(approvals, 'warn')),
      metric('Approval authority', approvalAuthority ? 'yes' : 'no', 'From the registered principal, not from being signed in.', approvalAuthority ? 'accent' : 'neutral'),
      // Phase 7: verified truth waiting on the Founder's explicit acceptance —
      // the truth-projection analogue of "held at your gate". Only when the
      // document carries the section; a static build shows no such metric.
      ...(truth.present
        ? [
            metric(
              'Verified, awaiting acceptance',
              truth.awaitingAcceptance,
              'Truth records independently verified, current and uncontested. Acceptance is an explicit Founder act behind step-up; nothing here accepts itself.',
              tone(truth.awaitingAcceptance, 'warn'),
            ),
            metric(
              'Founder-accepted',
              truth.accepted,
              'Truth records whose one explicit Founder acceptance currently stands. A later refutation, contest or supersession lowers the record to what it derives without the acceptance; the acceptance stays readable in its history.',
              tone(truth.accepted, 'accent'),
            ),
          ]
        : []),
    ],
    rows,
    emptyMessage:
      'The session route resolved no principal for this browser, so this office states nothing ' +
      'about who you are.',
    // Lit by what is WAITING at the gate, not by the fact that somebody is
    // standing in the room. The identity row above comes from the session, not
    // from anything HQ recorded, and letting it light the office would make an
    // empty HQ show one room that is not dark. Verified truth awaiting the
    // Founder is waiting at the gate too (Phase 7).
    liveness: livenessFrom({
      attention: approvals + truth.awaitingAcceptance,
      active: 0,
      present: approvals + truth.awaitingAcceptance + truth.accepted,
    }),
  };
}

function securitySection(state: HqStateDocument, session: ClientSession | null): Section {
  const controls = session?.controls ?? {};
  const kill = state.operations.data.killSwitch;
  const engagedScopes = kill.engagedScopes.length;
  const mechanisms = new Map<string, number>();
  for (const connection of state.connections.data) {
    mechanisms.set(connection.authMechanism, (mechanisms.get(connection.authMechanism) ?? 0) + 1);
  }
  const rows: RoomRow[] = [
    {
      id: 'kill-switch',
      primary: kill.globalEngaged ? 'Global kill switch ENGAGED' : 'Global kill switch released',
      secondary: kill.globalEngaged
        ? 'No capability may execute anywhere in HQ.'
        : engagedScopes > 0
          ? `Engaged for ${engagedScopes} scope(s): ${kill.engagedScopes.map((entry) => entry.scope).join(', ')}.`
          : 'No scope is under a kill switch.',
      chips: [{ label: kill.globalEngaged || engagedScopes > 0 ? 'locked' : 'open', tone: kill.globalEngaged || engagedScopes > 0 ? 'danger' : 'accent' }],
    },
    {
      id: 'browser-writes',
      primary: controls.mutationsEnabled === true ? 'Browser writes enabled' : 'Browser writes OFF',
      secondary:
        controls.mutationsEnabled === true
          ? 'This deployment mounts HQ with write routes. Every write still passes the Founder gate, the origin gate and step-up.'
          : 'This deployment mounts HQ read-only, or the server did not state otherwise. No write route would accept anything from this page.',
      chips: [{ label: controls.mutationsEnabled === true ? 'enabled' : 'off', tone: controls.mutationsEnabled === true ? 'info' : 'neutral' }],
    },
    {
      id: 'origin',
      primary: controls.requestOriginAllowed === true ? 'This page’s origin is trusted' : 'This page’s origin is NOT established as trusted',
      secondary: `Origin evidence: ${String(controls.requestOriginSource ?? 'not stated')}. Trusted-origin list configured: ${controls.trustedOriginConfigured === true ? 'yes' : 'no'}.`,
      chips: [{ label: controls.requestOriginAllowed === true ? 'allowed' : 'not allowed', tone: controls.requestOriginAllowed === true ? 'accent' : 'warn' }],
    },
    ...[...mechanisms.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mechanism, count]) => ({
        id: `auth-${mechanism}`,
        primary: `${count} integration(s) authenticate by ${mechanism}`,
        secondary:
          'Mechanism only. No credential, token or key value crosses this boundary — the response ' +
          'guard throws rather than publishing one.',
        chips: [],
      })),
  ];
  // Phase 7: unresolved truth contradictions are a SECURITY posture fact —
  // HQ holds two current, unrefuted statements about the same entity and
  // refuses to pick one by recency. Each is listed, and each is attention.
  const truth = truthFacts(state);
  rows.push(...truth.contradictionRows);
  const attention =
    (kill.globalEngaged || engagedScopes > 0 ? 1 : 0) +
    (controls.requestOriginAllowed === true ? 0 : 1) +
    truth.unresolved;
  return {
    metrics: [
      metric('Kill switch', kill.globalEngaged ? 'global' : engagedScopes > 0 ? `${engagedScopes} scope(s)` : 'released', 'Canonical kill-switch record.', kill.globalEngaged || engagedScopes > 0 ? 'danger' : 'accent'),
      metric('Write routes', controls.mutationsEnabled === true ? 'enabled' : 'off', 'What the server said, not what this page assumes.', controls.mutationsEnabled === true ? 'info' : 'neutral'),
      metric('Origin trusted', controls.requestOriginAllowed === true ? 'yes' : 'no', 'Decided by the same check that would refuse a write.', controls.requestOriginAllowed === true ? 'accent' : 'warn'),
      ...(truth.present
        ? [
            // Stated as a condition, like the room's other metrics, so the
            // numeric-metric invariant keeps treating this room as it does.
            metric(
              'Truth contradictions',
              truth.unresolved > 0 ? `${truth.unresolved} unresolved` : 'none unresolved',
              'Two current, unrefuted truth records about one entity. Never settled by recency; listed below until an explicit act resolves it.',
              truth.unresolved > 0 ? 'danger' : 'accent',
            ),
          ]
        : []),
    ],
    rows,
    emptyMessage: '',
    liveness: livenessFrom({ attention, active: 0, present: rows.length }),
  };
}

function memorySection(state: HqStateDocument): Section {
  // Phase 5 (issue #265): the Company Memory room, rebound from later_phase to
  // the canonical hq_memory record. Everything here is a projection of rows
  // the state document already carries; nothing is inferred, summarized on
  // the fly, or invented. A summary shown here is a RECORD of kind 'summary'
  // that names its sources — never a rendering-time compression.
  const records = state.memory.data;
  const current = records.filter((record) => record.status === 'CURRENT').length;
  const summaries = records.filter((record) => record.kind === 'summary').length;
  const founderOnly = records.filter((record) => record.privacy === 'founder_only').length;
  // Phase 7: the truth projection sits beside memory in this room — memory
  // informs, truth is what was claimed/observed/verified/accepted about it.
  // Counts only; a memory record never becomes truth by being remembered.
  const truth = truthFacts(state);
  return {
    metrics: [
      metric('Records', state.counts.memory, 'All company memory records, superseded history included. 0 means 0.', tone(state.counts.memory, 'info')),
      metric('Current', current, 'Records not yet superseded, carried by this document.', tone(current, 'accent')),
      metric('Superseded', records.length - current, 'History retained by the insert-only store — never rewritten, never deleted.', 'neutral'),
      metric('Summaries', summaries, 'A summary is its own record; the originals it derives from are retained and linked.', tone(summaries, 'violet')),
      metric('Founder-only', founderOnly, 'Records carried only through the Founder-authenticated route.', tone(founderOnly, 'neutral')),
      ...(truth.present
        ? [
            metric('Truth records', truth.total, 'Claimed, observed, verified or accepted statements referencing real evidence. Memory grants none of these states.', tone(truth.total, 'info')),
            metric('Verified', truth.verified, 'Independently verified, not yet Founder-accepted.', tone(truth.verified, 'violet')),
            metric('Accepted', truth.accepted, 'Carrying one explicit Founder acceptance that currently stands.', tone(truth.accepted, 'accent')),
          ]
        : []),
    ],
    rows: limited(
      records.map((record) => ({
        id: record.id,
        primary: record.title,
        secondary: `${record.kind} · recorded ${record.recorded.date} (${record.recorded.confidence}) by ${record.recordedBy}`,
        chips: [
          { label: record.kind, tone: record.kind === 'summary' ? ('violet' as RoomTone) : ('info' as RoomTone) },
          {
            label: record.status,
            tone: record.status === 'CURRENT' ? ('accent' as RoomTone) : ('neutral' as RoomTone),
          },
          ...(record.privacy === 'founder_only'
            ? [{ label: 'founder_only', tone: 'warn' as RoomTone }]
            : []),
          ...(record.missionId ? [{ label: 'mission-linked', tone: 'info' as RoomTone }] : []),
          ...(record.projectId ? [{ label: 'project-linked', tone: 'info' as RoomTone }] : []),
          ...(record.taskId ? [{ label: 'task-linked', tone: 'info' as RoomTone }] : []),
          ...(record.derivedFrom.length > 0
            ? [{ label: `derived from ${record.derivedFrom.length}`, tone: 'violet' as RoomTone }]
            : []),
        ],
      })),
    ),
    emptyMessage:
      'HQ remembers nothing yet. 0 means 0 — no demo memory is invented to fill the room; a ' +
      'record appears here when the Founder (or a gated act) records one.',
    // Memory never demands a human and is never "working": present-only
    // liveness, so a populated record renders quiet and an empty one dark.
    // Truth records count as presence too; they demand nothing here (the
    // Founder Office carries the awaiting-acceptance signal).
    liveness: livenessFrom({ attention: 0, active: 0, present: records.length + truth.total }),
  };
}

function sectionFor(
  section: RoomSection,
  state: HqStateDocument,
  session: ClientSession | null,
): Section {
  switch (section) {
    case 'overview':
      return overviewSection(state);
    case 'operations':
      return operationsSection(state);
    case 'missions':
      return missionsSection(state);
    case 'approvals':
      return approvalsSection(state);
    case 'workforce':
      return workforceSection(state);
    case 'lanes':
      return lanesSection(state);
    case 'capabilities':
      return capabilitiesSection(state);
    case 'connections':
      return connectionsSection(state);
    case 'projects':
      return projectsSection(state);
    case 'analytics':
      return analyticsSection(state);
    case 'founder':
      return founderSection(state, session);
    case 'security':
      return securitySection(state, session);
    case 'memory':
      return memorySection(state);
  }
}

/* ------------------------------------------------------------------ */
/* The public projection                                               */
/* ------------------------------------------------------------------ */

/**
 * One room's view.
 *
 * The `state === null` branch is the interesting one: a live-bound room with no
 * document is `awaiting`, carries NO metrics, and says so. It must not show
 * zeroes, because "HQ answered zero" and "HQ has not answered" are different
 * claims and only one of them is true before the first fetch returns.
 */
export function hydrateRoom(
  room: HqRoom,
  state: HqStateDocument | null,
  session: ClientSession | null,
): RoomView {
  const base = {
    roomId: room.id,
    name: room.name,
    ordinal: room.ordinal,
    purpose: room.purpose,
    ...(room.page ? { page: room.page } : {}),
  };

  if (room.binding.kind === 'not_recorded' || room.binding.kind === 'later_phase') {
    return {
      ...base,
      status: room.binding.kind,
      liveness: 'dark',
      metrics: [],
      rows: [],
      emptyMessage: room.binding.reason,
      provenance:
        room.binding.kind === 'later_phase'
          ? 'No canonical source. This capability belongs to a later roadmap phase.'
          : 'No canonical source. HQ does not record this today.',
    };
  }

  if (!state) {
    return {
      ...base,
      status: 'awaiting',
      liveness: 'dark',
      metrics: [],
      rows: [],
      emptyMessage:
        'No state document has been read yet, so this room claims nothing. This is NOT a report ' +
        'that HQ is empty.',
      provenance: room.binding.source,
    };
  }

  const projected = sectionFor(room.binding.section, state, session);
  return {
    ...base,
    status: 'live',
    liveness: projected.liveness,
    metrics: projected.metrics,
    rows: projected.rows,
    emptyMessage: projected.emptyMessage,
    provenance: `${room.binding.source} · as of ${state.generatedAt} · provenance ${state.mode}`,
  };
}

/** Every room, in the Founder's approved order. */
export function hydrateRooms(
  state: HqStateDocument | null,
  session: ClientSession | null,
): RoomView[] {
  return HQ_ROOMS.map((room) => hydrateRoom(room, state, session));
}
