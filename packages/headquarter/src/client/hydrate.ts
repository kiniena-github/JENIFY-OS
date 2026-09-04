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
import { CONNECTION_STATE_TONE } from '../live/connections.js';
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
  const attention = ops.blocked.length + ops.outcomeUnknown.length + ops.approvals.length;
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
      return held.length > 0
        ? `Nothing is in flight, queued, blocked or unresolved — but ${held.join('; and ')}.`
        : 'No task is recorded in flight, queued, blocked or unresolved. The Command Room is empty ' +
          'because HQ is holding nothing, not because nothing loaded.';
    })(),
    liveness: livenessFrom({
      attention,
      active: ops.inFlight.length,
      present: rows.length + ops.approvals.length + ops.pendingReviews.length,
    }),
  };
}

function missionsSection(state: HqStateDocument): Section {
  const ops = state.operations.data;
  const all = [
    ...ops.approvals,
    ...ops.pendingReviews,
    ...ops.inFlight,
    ...ops.queued,
    ...ops.blocked,
    ...ops.outcomeUnknown,
  ];
  const byStatus = new Map<string, number>();
  for (const task of all) byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1);
  // Liveness comes from CANONICAL BUCKET MEMBERSHIP, not from re-reading the
  // raw status strings — and from exactly the same arithmetic the Command Room
  // uses, so the two rooms cannot disagree about the same tasks.
  //
  // Reclassifying the statuses got both directions wrong (Codex round 13):
  //
  //   - A task awaiting independent review keeps status `running`, but
  //     `founderConsole` puts it in `pendingReviews` and DELIBERATELY excludes
  //     it from `inFlight`. Counting `running` marked the Mission Room active
  //     and pulsed it, asserting a worker still held a task the canonical
  //     console says nobody is executing.
  //   - `review_failed` is canonically blocked — `blocked` is built as
  //     `byStatus('blocked')` plus `byStatus('review_failed')` — but it was
  //     absent from ATTENTION_STATUSES, so the Mission Room sat quiet while
  //     Home and the Command Room, which read the bucket, showed attention.
  //     Two rooms describing one task differently.
  //
  // The status counts below stay as they are: they are honest copies of what
  // canonical state records, and a status is a fact about a task. What may not
  // be re-derived from them is whether the room is lit.
  const attention = ops.blocked.length + ops.outcomeUnknown.length + ops.approvals.length;
  const active = ops.inFlight.length;
  return {
    metrics: [
      metric('Missions recorded', all.length, 'Every open task the canonical queue holds.', tone(all.length, 'info')),
      ...[...byStatus.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([status, count]) =>
          metric(status, count, `Tasks whose canonical status is ${status}.`, ATTENTION_STATUSES.has(status) ? 'warn' : 'neutral'),
        ),
    ],
    rows: limited(all.map(taskRow)),
    emptyMessage: 'The canonical queue holds no open mission. Nothing is hidden behind this view.',
    liveness: livenessFrom({ attention, active, present: all.length }),
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

function connectionsSection(state: HqStateDocument): Section {
  const connections = state.connections.data;
  const lit = connections.filter(
    (connection) => connection.state === 'connected' || connection.state === 'local_only',
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
  const warned = (state: string): boolean => {
    const t = (CONNECTION_STATE_TONE as Record<string, string>)[state];
    return t === 'warn' || t === 'danger';
  };
  const needsAttention = connections.filter((connection) => warned(connection.state)).length;
  return {
    metrics: [
      metric('Known integrations', connections.length, 'Every integration HQ has a descriptor for.', 'neutral'),
      metric('Proven reachable', lit, 'Verified, or local-only with evidence. Configuration alone does not count.', tone(lit, 'accent')),
      metric('Needing attention', needsAttention, 'Reported error or expired credential.', tone(needsAttention, 'danger')),
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
  const byProject = new Map<string, { events: number; latest: string }>();
  for (const event of state.activity.data) {
    if (!event.project) continue;
    const entry = byProject.get(event.project) ?? { events: 0, latest: event.at };
    entry.events += 1;
    if (event.at > entry.latest) entry.latest = event.at;
    byProject.set(event.project, entry);
  }
  const projects = [...byProject.entries()].sort((a, b) => b[1].latest.localeCompare(a[1].latest));
  return {
    metrics: [
      metric('Projects named', projects.length, 'Distinct project labels on the recent canonical events this document carries.', tone(projects.length, 'info')),
    ],
    rows: limited(
      projects.map(([project, entry]) => ({
        id: project,
        primary: project,
        secondary: `${entry.events} recent canonical event(s) · latest ${entry.latest}`,
        chips: [],
      })),
    ),
    emptyMessage:
      'No recent canonical event names a project. This counts the events in THIS document only — ' +
      'it is not a claim that the archive holds no project.',
    liveness: livenessFrom({ attention: 0, active: 0, present: projects.length }),
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

function founderSection(state: HqStateDocument, session: ClientSession | null): Section {
  const approvals = state.operations.data.approvals.length;
  const principal = typeof session?.principalId === 'string' ? session.principalId : null;
  const display = typeof session?.displayName === 'string' ? session.displayName : null;
  const approvalAuthority = session?.approvalAuthority === true;
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
    ],
    rows,
    emptyMessage:
      'The session route resolved no principal for this browser, so this office states nothing ' +
      'about who you are.',
    // Lit by what is WAITING at the gate, not by the fact that somebody is
    // standing in the room. The identity row above comes from the session, not
    // from anything HQ recorded, and letting it light the office would make an
    // empty HQ show one room that is not dark.
    liveness: livenessFrom({ attention: approvals, active: 0, present: approvals }),
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
  const attention =
    (kill.globalEngaged || engagedScopes > 0 ? 1 : 0) + (controls.requestOriginAllowed === true ? 0 : 1);
  return {
    metrics: [
      metric('Kill switch', kill.globalEngaged ? 'global' : engagedScopes > 0 ? `${engagedScopes} scope(s)` : 'released', 'Canonical kill-switch record.', kill.globalEngaged || engagedScopes > 0 ? 'danger' : 'accent'),
      metric('Write routes', controls.mutationsEnabled === true ? 'enabled' : 'off', 'What the server said, not what this page assumes.', controls.mutationsEnabled === true ? 'info' : 'neutral'),
      metric('Origin trusted', controls.requestOriginAllowed === true ? 'yes' : 'no', 'Decided by the same check that would refuse a write.', controls.requestOriginAllowed === true ? 'accent' : 'warn'),
    ],
    rows,
    emptyMessage: '',
    liveness: livenessFrom({ attention, active: 0, present: rows.length }),
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
