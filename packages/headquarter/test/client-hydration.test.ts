/**
 * The no-fake-state rule, asserted exhaustively (issue #250, Phase 2 Stage 4).
 *
 * Stage 4's product-truth requirement is short and absolute: if the API says 0
 * missions, show 0; if no worker is active, do not animate a fake active
 * worker; an empty HQ must render as an empty HQ. A rule like that is only
 * worth anything if something checks EVERY room rather than the three someone
 * remembered — so these tests iterate the whole registry and allow no room to
 * opt out.
 *
 * The three states that must stay distinct, and are the reason this suite
 * exists at all:
 *
 *   - **awaiting** — no state document has been read. Claims nothing. Shows no
 *     numbers, not even zeroes, because "HQ has not answered" is not "HQ
 *     answered zero".
 *   - **live, empty** — HQ answered, and the answer is nothing. Shows zeroes
 *     and says what the zero means.
 *   - **live, populated** — HQ answered, and the counts are copied from that
 *     answer exactly.
 */

import { describe, expect, it } from 'vitest';
import { HQ_ROOMS, roomById } from '../src/client/rooms.js';
import { hydrateRoom, hydrateRooms, livenessFrom, ROOM_ROW_LIMIT } from '../src/client/hydrate.js';
import { buildHqSnapshot, emptyFounderConsole, type HqSnapshot } from '../src/live/snapshot.js';
import type { ClientSession } from '../src/client/contracts.js';
import type { Provenance } from '../src/live/provenance.js';
import {
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_TONE,
  LIT_CONNECTION_STATES,
  type ConnectionState,
} from '../src/live/connections.js';
import type { ConsoleTask } from '../src/application/console.js';

const AT = '2026-09-04T12:00:00.000Z';
const PROVENANCE: Provenance = { mode: 'live', source: 'test', asOf: AT };

function emptyState(): HqSnapshot {
  return buildHqSnapshot({
    generatedAt: AT,
    console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
    connections: { data: [], provenance: PROVENANCE },
    workforce: { data: [], provenance: PROVENANCE },
    capabilities: { data: [], provenance: PROVENANCE },
    activity: { data: [], provenance: PROVENANCE },
  });
}

const FOUNDER_SESSION: ClientSession = {
  ok: true,
  authenticated: true,
  founder: true,
  principalId: 'founder',
  displayName: 'Founder',
  approvalAuthority: true,
  controls: {
    directOrder: true,
    approve: true,
    deny: true,
    mutationsEnabled: true,
    trustedOriginConfigured: true,
    requestOriginAllowed: true,
    requestOriginSource: 'referer',
  },
};

describe('an unread state document claims nothing at all', () => {
  const views = hydrateRooms(null, null);

  it('covers every registered room, once, in order', () => {
    expect(views.map((view) => view.roomId)).toEqual(HQ_ROOMS.map((room) => room.id));
  });

  it('marks every live-bound room `awaiting` and shows it no numbers', () => {
    for (const view of views) {
      const room = roomById(view.roomId)!;
      if (room.binding.kind !== 'live') continue;
      expect(view.status, view.roomId).toBe('awaiting');
      // The critical assertion of this whole stage: NOT zeroes.
      expect(view.metrics, view.roomId).toHaveLength(0);
      expect(view.rows, view.roomId).toHaveLength(0);
      expect(view.liveness, view.roomId).toBe('dark');
      expect(view.emptyMessage, view.roomId).toContain('NOT a report');
    }
  });

  it('still states the truth of rooms whose truth does not need a session', () => {
    for (const view of views) {
      const room = roomById(view.roomId)!;
      if (room.binding.kind === 'live') continue;
      expect(view.status, view.roomId).toBe(room.binding.kind);
      expect(view.emptyMessage, view.roomId).toBe(room.binding.reason);
      expect(view.liveness, view.roomId).toBe('dark');
      expect(view.metrics, view.roomId).toHaveLength(0);
    }
  });
});

describe('an empty HQ renders as an empty HQ', () => {
  const views = hydrateRooms(emptyState(), FOUNDER_SESSION);

  it('puts no room into a state that animates, anywhere', () => {
    // `active` and `attention` are the two states the 3D shell pulses. With HQ
    // holding nothing, a single room in either would be a fabricated activity
    // claim — so this checks every room, not a sample.
    for (const view of views) {
      expect(['quiet', 'dark'], view.roomId).toContain(view.liveness);
    }
  });

  it('leaves every record-backed room fully dark', () => {
    // The two rooms that describe the SESSION and the DEPLOYMENT rather than
    // HQ's records are exempt, and only those two: the Security Center always
    // has a posture to state, and it is dimly lit (`quiet`) for saying so. Any
    // room that projects records must be dark when there are none.
    for (const view of views) {
      if (view.roomId === 'security-center') continue;
      expect(view.liveness, view.roomId).toBe('dark');
    }
  });

  it('reports zero as zero, and never as a placeholder or an em dash', () => {
    for (const view of views) {
      for (const metric of view.metrics) {
        if (typeof metric.value !== 'number') continue;
        expect(metric.value, `${view.roomId}/${metric.label}`).toBe(0);
      }
    }
  });

  it('lists no row in any room', () => {
    for (const view of views) {
      // Two rooms describe THIS SESSION and THIS DEPLOYMENT rather than
      // records HQ holds, so they have rows even when HQ holds nothing: the
      // Security Center states the posture (kill switch, write routes, origin
      // trust) and the Founder Office states who resolved. Neither is a
      // fabricated operational record — and neither lights its room, which the
      // liveness assertion above proves. Every other room must be bare.
      if (view.roomId === 'security-center' || view.roomId === 'founder-office') continue;
      expect(view.rows, view.roomId).toHaveLength(0);
    }
  });

  it('explains every empty room instead of leaving it blank', () => {
    for (const view of views) {
      if (view.rows.length > 0) continue;
      expect(view.emptyMessage.length, view.roomId).toBeGreaterThan(40);
    }
  });

  it('stamps every live room with the document’s own provenance', () => {
    for (const view of views) {
      if (view.status !== 'live') continue;
      expect(view.provenance, view.roomId).toContain(AT);
      expect(view.provenance, view.roomId).toContain('provenance live');
    }
  });
});

describe('a populated HQ is copied, never re-derived', () => {
  function populated(): HqSnapshot {
    const console_ = emptyFounderConsole(AT);
    console_.inFlight = [
      {
        taskId: 't-run',
        capabilityId: 'repo.read_status',
        status: 'running',
        reviewState: 'none',
        fence: 1,
        claimedBy: 'worker-a',
        submittedBy: null,
        createdBy: 'founder',
        createdAt: AT,
        updatedAt: AT,
        blockReason: null,
        classification: {
          capabilityId: 'repo.read_status',
          riskClass: 'read_only',
          sideEffect: false,
          idempotent: true,
          requiresApproval: false,
          requiresIndependentReview: false,
          requiresIdempotencyKey: false,
          route: 'auto',
          reason: 'read only',
        },
        project: 'jenify-os',
        title: 'Read CI status',
        assignedTo: 'worker-a',
        sourceProposalId: null,
      },
    ];
    console_.blocked = [{ ...console_.inFlight[0]!, taskId: 't-blocked', status: 'blocked', blockReason: 'upstream down' }];
    return buildHqSnapshot({
      generatedAt: AT,
      console: { data: console_, provenance: PROVENANCE },
      connections: { data: [], provenance: PROVENANCE },
      workforce: { data: [], provenance: PROVENANCE },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
  }

  const state = populated();
  const views = hydrateRooms(state, FOUNDER_SESSION);
  const view = (id: string) => views.find((candidate) => candidate.roomId === id)!;

  it('copies the counts the state document carries, exactly', () => {
    const home = view('home');
    const inFlight = home.metrics.find((metric) => metric.label === 'In flight')!;
    const blocked = home.metrics.find((metric) => metric.label === 'Blocked')!;
    expect(inFlight.value).toBe(state.counts.inFlight);
    expect(blocked.value).toBe(state.counts.blocked);
  });

  it('lights the rooms that hold the work, and only those', () => {
    // Blocked work outranks running work: a room holding both is a room you
    // need to walk into.
    expect(view('command-room').liveness).toBe('attention');
    expect(view('mission-room').liveness).toBe('attention');
    // Nothing was registered in the directory or the registry, so those rooms
    // stay dark even though HQ is busy.
    expect(view('ai-workforce').liveness).toBe('dark');
    expect(view('resources').liveness).toBe('dark');
    expect(view('world-network').liveness).toBe('dark');
  });

  it('never pulses a room on a registry FLAG rather than on recorded work', () => {
    // `active: true` on a specialist means the registry permits it to hold
    // work — not that it is holding any. Lighting the AI Workforce room from
    // that flag would animate a worker nothing says is working.
    const withWorkers = buildHqSnapshot({
      generatedAt: AT,
      console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
      connections: { data: [], provenance: PROVENANCE },
      workforce: {
        data: [
          {
            id: 'w1',
            displayName: 'Claude',
            vendor: 'anthropic',
            role: 'build_lead',
            active: true,
            allowedCapabilities: [],
            capabilities: [],
          },
        ] as never,
        provenance: PROVENANCE,
      },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
    const workforce = hydrateRooms(withWorkers, FOUNDER_SESSION).find((v) => v.roomId === 'ai-workforce')!;
    expect(workforce.liveness).toBe('quiet');
    expect(workforce.metrics.find((metric) => metric.label === 'Marked active')!.value).toBe(1);
  });

  it('caps how many rows a room lists, and says how many it did not', () => {
    const many = emptyFounderConsole(AT);
    const template = state.operations.data.inFlight[0]!;
    many.queued = Array.from({ length: ROOM_ROW_LIMIT + 5 }, (_, index) => ({
      ...template,
      taskId: `t-${index}`,
      status: 'queued' as const,
    }));
    const snapshot = buildHqSnapshot({
      generatedAt: AT,
      console: { data: many, provenance: PROVENANCE },
      connections: { data: [], provenance: PROVENANCE },
      workforce: { data: [], provenance: PROVENANCE },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
    const command = hydrateRooms(snapshot, FOUNDER_SESSION).find((v) => v.roomId === 'command-room')!;
    expect(command.rows).toHaveLength(ROOM_ROW_LIMIT + 1);
    expect(command.rows.at(-1)!.primary).toBe('5 more not listed here');
  });
});

describe('a room is dark only when everything it counts is empty', () => {
  it('keeps Analytics lit when its recorded inputs hold rows but no operation is open', () => {
    // Analytics counts workers, capabilities, integrations and events as well as
    // the task buckets. Deriving its presence from the task buckets alone made
    // it go dark — "HQ is holding nothing here" — while displaying four
    // non-zero counts directly underneath (Codex round 3).
    const withRecords = buildHqSnapshot({
      generatedAt: AT,
      console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
      connections: { data: [], provenance: PROVENANCE },
      workforce: {
        data: [
          { id: 'w1', displayName: 'Claude', vendor: 'anthropic', role: 'build_lead', active: false, allowedCapabilities: [] },
        ] as never,
        provenance: PROVENANCE,
      },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
    const views = hydrateRooms(withRecords, FOUNDER_SESSION);
    const analytics = views.find((view) => view.roomId === 'analytics')!;
    expect(analytics.metrics.find((metric) => metric.label === 'Registered workers')!.value).toBe(1);
    expect(analytics.liveness).toBe('quiet');
    // And still not moving: a registry row is not work in progress.
    expect(['active', 'attention']).not.toContain(analytics.liveness);
  });

  it('still goes dark when nothing it counts holds anything', () => {
    const analytics = hydrateRooms(emptyState(), FOUNDER_SESSION).find((v) => v.roomId === 'analytics')!;
    expect(analytics.liveness).toBe('dark');
  });
});

describe('liveness is ordered by what needs a human first', () => {
  it('ranks attention over active over quiet over dark', () => {
    expect(livenessFrom({ attention: 1, active: 5, present: 9 })).toBe('attention');
    expect(livenessFrom({ attention: 0, active: 1, present: 9 })).toBe('active');
    expect(livenessFrom({ attention: 0, active: 0, present: 1 })).toBe('quiet');
    expect(livenessFrom({ attention: 0, active: 0, present: 0 })).toBe('dark');
  });
});

describe('a room that is not live can never be filled in by a state document', () => {
  it('stays not_recorded / later_phase however rich the state is', () => {
    const state = emptyState();
    for (const room of HQ_ROOMS) {
      if (room.binding.kind === 'live') continue;
      const view = hydrateRoom(room, state, FOUNDER_SESSION);
      expect(view.status, room.id).toBe(room.binding.kind);
      expect(view.metrics, room.id).toHaveLength(0);
      expect(view.rows, room.id).toHaveLength(0);
      expect(view.liveness, room.id).toBe('dark');
    }
  });
});

describe('the Mission Room reads canonical buckets, not raw task statuses', () => {
  // Codex round 13. Liveness was re-derived by matching task.status against
  // hand-kept sets, which got it wrong in BOTH directions — and each direction
  // is a different kind of lie.
  function taskAt(taskId: string, status: string, reviewState: string): ConsoleTask {
    return {
      taskId,
      capabilityId: 'repo.read_status',
      status,
      reviewState,
      fence: 1,
      claimedBy: 'worker-a',
      submittedBy: 'worker-a',
      createdBy: 'founder',
      createdAt: AT,
      updatedAt: AT,
      blockReason: null,
      classification: {
        capabilityId: 'repo.read_status',
        riskClass: 'read_only',
        sideEffect: false,
        idempotent: true,
        requiresApproval: false,
        requiresIndependentReview: true,
        requiresIdempotencyKey: false,
        route: 'auto',
        reason: 'read only',
      },
      project: 'jenify-os',
      title: 'Read CI status',
      assignedTo: 'worker-a',
      sourceProposalId: null,
    } as ConsoleTask;
  }

  function stateWith(mutate: (console_: ReturnType<typeof emptyFounderConsole>) => void): HqSnapshot {
    const console_ = emptyFounderConsole(AT);
    mutate(console_);
    return buildHqSnapshot({
      generatedAt: AT,
      console: { data: console_, provenance: PROVENANCE },
      connections: { data: [], provenance: PROVENANCE },
      workforce: { data: [], provenance: PROVENANCE },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
  }

  const mission = (state: HqSnapshot) =>
    hydrateRooms(state, FOUNDER_SESSION).find((view) => view.roomId === 'mission-room')!;
  const commandRoom = (state: HqSnapshot) =>
    hydrateRooms(state, FOUNDER_SESSION).find((view) => view.roomId === 'command-room')!;

  it('does not pulse for a task awaiting review that nobody is executing', () => {
    // The task keeps status `running`, but `founderConsole` files it in
    // pendingReviews and DELIBERATELY excludes it from inFlight. Reading the
    // status asserted that a worker still held it, and pulsed the room to say
    // so — motion standing in for work that is not happening.
    const state = stateWith((console_) => {
      console_.pendingReviews = [
        { ...taskAt('t-review', 'running', 'pending'), ineligibleReviewers: ['system', 'worker-a'] },
      ] as typeof console_.pendingReviews;
    });
    const view = mission(state);
    expect(view.liveness).not.toBe('active');
    expect(view.liveness).not.toBe('attention');
    // Still recorded, so the room is not dark either — something is there, and
    // nothing is running or stuck.
    expect(view.liveness).toBe('quiet');
  });

  it('lights for review_failed, which the canonical console files as blocked', () => {
    // `blocked` is byStatus('blocked') PLUS byStatus('review_failed'), so this
    // task is canonically stopped. The status set omitted `review_failed`, so
    // the Mission Room sat quiet while Home and the Command Room — which read
    // the bucket — reported attention. Two rooms describing one task
    // differently is the failure this stage exists to prevent.
    const state = stateWith((console_) => {
      console_.blocked = [taskAt('t-failed', 'review_failed', 'failed')];
    });
    expect(mission(state).liveness).toBe('attention');
    expect(commandRoom(state).liveness).toBe('attention');
  });

  it('agrees with the Command Room about the same tasks, in every combination', () => {
    // The general property, rather than the two reported cases: both rooms
    // cover the same buckets, so neither may reach a state the other does not.
    const combinations: { name: string; mutate: (c: ReturnType<typeof emptyFounderConsole>) => void }[] = [
      { name: 'empty', mutate: () => {} },
      { name: 'in flight', mutate: (c) => { c.inFlight = [taskAt('t1', 'running', 'none')]; } },
      { name: 'queued', mutate: (c) => { c.queued = [taskAt('t2', 'queued', 'none')]; } },
      { name: 'blocked', mutate: (c) => { c.blocked = [taskAt('t3', 'blocked', 'none')]; } },
      { name: 'review failed', mutate: (c) => { c.blocked = [taskAt('t4', 'review_failed', 'failed')]; } },
      {
        name: 'pending review',
        mutate: (c) => {
          c.pendingReviews = [
            { ...taskAt('t5', 'running', 'pending'), ineligibleReviewers: ['system'] },
          ] as typeof c.pendingReviews;
        },
      },
    ];
    // EXACT equality, not "both lit or both unlit".
    //
    // The first version of this compared only `lit()`, and Codex round 14 walked
    // straight through the gap: with only a pending review recorded, the Command
    // Room was DARK — "HQ is holding nothing" — while Home and Mission were
    // `quiet`, because the task is still recorded. Both are "not lit", so the
    // test passed over a room contradicting two others about whether HQ held
    // anything at all. A consistency check that collapses the very distinction
    // the page relies on is not a consistency check.
    for (const { name, mutate } of combinations) {
      const state = stateWith(mutate);
      const homeView = hydrateRooms(stateWith(mutate), FOUNDER_SESSION).find((v) => v.roomId === 'home')!;
      const missionView = mission(state);
      const commandView = commandRoom(state);
      expect(
        [homeView.liveness, missionView.liveness, commandView.liveness],
        `${name}: home ${homeView.liveness}, mission ${missionView.liveness}, command ${commandView.liveness}`,
      ).toEqual([homeView.liveness, homeView.liveness, homeView.liveness]);
    }
  });
});

describe('Analytics ranks an approval the way every other room does', () => {
  // Codex round 14, and a direct miss by my own sweep one commit earlier, which
  // read each room in turn and declared this one sound. Reading rooms
  // individually is not the same as comparing them against each other.
  function stateWithApproval(alsoRunning: boolean): HqSnapshot {
    const console_ = emptyFounderConsole(AT);
    const base = {
      taskId: 't-appr',
      capabilityId: 'repo.read_status',
      status: 'needs_approval',
      reviewState: 'none',
      fence: 1,
      claimedBy: null,
      submittedBy: null,
      createdBy: 'founder',
      createdAt: AT,
      updatedAt: AT,
      blockReason: null,
      classification: {
        capabilityId: 'repo.read_status',
        riskClass: 'read_only',
        sideEffect: false,
        idempotent: true,
        requiresApproval: true,
        requiresIndependentReview: false,
        requiresIdempotencyKey: false,
        route: 'auto',
        reason: 'needs approval',
      },
      project: 'jenify-os',
      title: 'Approve me',
      assignedTo: null,
      sourceProposalId: null,
    };
    console_.approvals = [
      { ...base, actionDigest: 'digest-1', ask: 'Approve the read.', requestedBy: null },
    ] as unknown as typeof console_.approvals;
    if (alsoRunning) {
      console_.inFlight = [
        { ...base, taskId: 't-run', status: 'running', assignedTo: 'worker-a', claimedBy: 'worker-a' },
      ] as unknown as typeof console_.inFlight;
    }
    return buildHqSnapshot({
      generatedAt: AT,
      console: { data: console_, provenance: PROVENANCE },
      connections: { data: [], provenance: PROVENANCE },
      workforce: { data: [], provenance: PROVENANCE },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
  }

  const roomLiveness = (state: HqSnapshot, roomId: string) =>
    hydrateRooms(state, FOUNDER_SESSION).find((view) => view.roomId === roomId)!.liveness;

  it('is attention for an approval-only HQ, like the five rooms beside it', () => {
    const state = stateWithApproval(false);
    for (const roomId of ['home', 'command-room', 'mission-room', 'approvals', 'founder-office', 'analytics']) {
      expect(roomLiveness(state, roomId), roomId).toBe('attention');
    }
  });

  it('does not report merely active when an approval is waiting behind running work', () => {
    // The worse half: `active` under the documented attention-over-active
    // ordering reads as "work is moving and nothing needs you".
    const state = stateWithApproval(true);
    expect(roomLiveness(state, 'analytics')).toBe('attention');
    expect(roomLiveness(state, 'analytics')).not.toBe('active');
  });
});

describe('no room contradicts its own displayed numbers', () => {
  // The general form of rounds 1, 3 and 14, all of which were one room's
  // liveness disagreeing with the figures printed inside it: the Command Room
  // saying "HQ is holding nothing" above a metric reading 1; Analytics dark
  // above four populated counts; Analytics quiet while five rooms called the
  // same approval attention.
  //
  // Each was fixed individually and each fix was correct. None of them stopped
  // the next one, because they were instances. This is the invariant behind
  // them, checked over every live room at once: the legend says a dark room is
  // a room HQ is holding nothing in, so a dark room may not display a non-zero
  // count or a row, and a room displaying one may not be dark.
  //
  // Numeric metrics only — the Security Center's metrics are deliberately
  // strings ('global', 'released', 'enabled'), which state a condition rather
  // than count anything. Its rows still participate.
  function scenarios(): { name: string; state: HqSnapshot }[] {
    const task = {
      taskId: 't',
      capabilityId: 'repo.read_status',
      status: 'running',
      reviewState: 'none',
      fence: 1,
      claimedBy: 'worker-a',
      submittedBy: null,
      createdBy: 'founder',
      createdAt: AT,
      updatedAt: AT,
      blockReason: null,
      classification: {
        capabilityId: 'repo.read_status',
        riskClass: 'read_only',
        sideEffect: false,
        idempotent: true,
        requiresApproval: false,
        requiresIndependentReview: false,
        requiresIdempotencyKey: false,
        route: 'auto',
        reason: 'read only',
      },
      project: 'jenify-os',
      title: 'Read CI status',
      assignedTo: 'worker-a',
      sourceProposalId: null,
    };
    const build = (mutate: (c: ReturnType<typeof emptyFounderConsole>) => void): HqSnapshot => {
      const console_ = emptyFounderConsole(AT);
      mutate(console_);
      return buildHqSnapshot({
        generatedAt: AT,
        console: { data: console_, provenance: PROVENANCE },
        connections: { data: [], provenance: PROVENANCE },
        workforce: { data: [], provenance: PROVENANCE },
        capabilities: { data: [], provenance: PROVENANCE },
        activity: { data: [], provenance: PROVENANCE },
      });
    };
    return [
      { name: 'empty HQ', state: emptyState() },
      { name: 'in flight', state: build((c) => { c.inFlight = [task] as typeof c.inFlight; }) },
      { name: 'queued', state: build((c) => { c.queued = [{ ...task, status: 'queued' }] as typeof c.queued; }) },
      { name: 'blocked', state: build((c) => { c.blocked = [{ ...task, status: 'blocked' }] as typeof c.blocked; }) },
      {
        name: 'review failed',
        state: build((c) => { c.blocked = [{ ...task, status: 'review_failed' }] as typeof c.blocked; }),
      },
      {
        name: 'pending review',
        state: build((c) => {
          c.pendingReviews = [
            { ...task, reviewState: 'pending', ineligibleReviewers: ['system'] },
          ] as unknown as typeof c.pendingReviews;
        }),
      },
      {
        name: 'approval only',
        state: build((c) => {
          c.approvals = [
            { ...task, status: 'needs_approval', actionDigest: 'd', ask: 'Approve.', requestedBy: null },
          ] as unknown as typeof c.approvals;
        }),
      },
      {
        name: 'outcome unknown',
        state: build((c) => {
          c.outcomeUnknown = [
            { ...task, status: 'outcome_unknown', allowedDecisions: ['confirmed_done'], ineligibleReconcilers: ['system'] },
          ] as unknown as typeof c.outcomeUnknown;
        }),
      },
    ];
  }

  it('never renders a dark room above a non-zero count or a row', () => {
    for (const { name, state } of scenarios()) {
      for (const view of hydrateRooms(state, FOUNDER_SESSION)) {
        if (view.status !== 'live') continue;
        const counted = view.metrics
          .filter((m) => typeof m.value === 'number')
          .reduce((sum, m) => sum + (m.value as number), 0);
        if (view.liveness !== 'dark') continue;
        expect(counted, `${name}: ${view.roomId} is dark but counts ${counted}`).toBe(0);
        // The Founder Office is the one room that may be dark with a row in it,
        // and the reason is deliberate rather than an oversight: its row is the
        // SESSION's resolved principal — who you are — not something HQ is
        // holding. Lighting the office for that would mean an empty HQ never
        // looks empty, and would light a room for "you exist" rather than for
        // recorded work, which is the no-fake-state rule losing to visual
        // tidiness.
        //
        // The exemption is narrow on purpose. Its numeric metric — tasks held at
        // the gate — is still required to be zero above, so a dark Founder
        // Office with real approvals waiting still fails here. Only the identity
        // row is forgiven.
        if (view.roomId === 'founder-office') continue;
        expect(view.rows.length, `${name}: ${view.roomId} is dark but lists rows`).toBe(0);
      }
    }
  });

  it('never renders a lit room with nothing at all in it', () => {
    // The inverse, and the one round 14 needed: a room that is not dark must
    // show the reader WHY. The Command Room's presence fix would have recreated
    // round 1's defect without the "Awaiting review" metric beside it.
    for (const { name, state } of scenarios()) {
      for (const view of hydrateRooms(state, FOUNDER_SESSION)) {
        if (view.status !== 'live' || view.liveness === 'dark') continue;
        const counted = view.metrics
          .filter((m) => typeof m.value === 'number')
          .reduce((sum, m) => sum + (m.value as number), 0);
        const statedCondition = view.metrics.some((m) => typeof m.value === 'string');
        expect(
          counted > 0 || view.rows.length > 0 || statedCondition,
          `${name}: ${view.roomId} is ${view.liveness} but displays nothing that explains it`,
        ).toBe(true);
      }
    }
  });
});

describe('connection attention follows the canonical tone mapping', () => {
  // Codex round 16. The filter named `error` and `expired` only, so an
  // integration that is `configured` or `setup_required` left both
  // connection-backed rooms quiet and reported "Needing attention: 0".
  //
  // `CONNECTION_STATE_TONE` already classified both as warnings, and its
  // docstring exists because this exact defect was caught once before on
  // another surface — a half-finished integration flagged in one place and
  // reading Quiet on the floor. I restated a narrower list beside the mapping
  // created to prevent it.
  function stateWithConnection(connectionState: string): HqSnapshot {
    return buildHqSnapshot({
      generatedAt: AT,
      console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
      connections: {
        data: [
          {
            id: 'github',
            displayName: 'GitHub',
            state: connectionState,
            reason: 'fixture',
            authMechanism: 'token',
            missingFacts: [],
          },
        ] as never,
        provenance: PROVENANCE,
      },
      workforce: { data: [], provenance: PROVENANCE },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
  }

  const view = (state: HqSnapshot, roomId: string) =>
    hydrateRooms(state, FOUNDER_SESSION).find((room) => room.roomId === roomId)!;

  it('warns for every state the canonical mapping calls a warning', () => {
    for (const connectionState of ['error', 'expired', 'configured', 'setup_required']) {
      const state = stateWithConnection(connectionState);
      for (const roomId of ['world-network', 'connections']) {
        const room = view(state, roomId);
        expect(room.liveness, `${connectionState} in ${roomId}`).toBe('attention');
        const needing = room.metrics.find((m) => m.label === 'Needing attention')!;
        expect(needing.value, `${connectionState} in ${roomId}`).toBe(1);
      }
    }
  });

  it('does not warn for states the mapping calls settled', () => {
    // The other direction, so this cannot become "always attention".
    for (const connectionState of ['connected', 'local_only', 'not_connected']) {
      const state = stateWithConnection(connectionState);
      const room = view(state, 'world-network');
      expect(room.liveness, connectionState).not.toBe('attention');
      expect(room.metrics.find((m) => m.label === 'Needing attention')!.value, connectionState).toBe(0);
    }
  });

  it('gives the row chip the same tone as the count, for the same integration', () => {
    // A row and a count disagreeing about one integration is the cross-room
    // contradiction of round 14, one level in.
    const state = stateWithConnection('setup_required');
    const room = view(state, 'world-network');
    const chip = room.rows[0]!.chips.find((c) => c.label === 'setup_required')!;
    expect(chip.tone).toBe('warn');
  });
});

describe('reachability comes from one list, not two that agree', () => {
  /**
   * Written out here, on purpose, one line per state.
   *
   * The previous version of this suite derived the expectation from
   * LIT_CONNECTION_STATES — the same constant the client reads — and covered
   * five of the eight states. Two things followed, and both are the reason
   * this is now a literal table (Codex round 17):
   *
   *   1. It said nothing about whether the list is CORRECT. Re-hardcoding the
   *      client to treat `not_connected`, `expired` or `setup_required` as
   *      reachable stayed green, because those three were never asked about.
   *   2. A ninth `ConnectionState` needed no test change at all: the loop
   *      would simply never mention it.
   *
   * `Record<ConnectionState, ...>` closes (2) at the type level — a new state
   * fails `tsc` until someone decides, here, whether it may be drawn as
   * reachable. The literal values close (1): they are a judgement about what
   * each word means, made independently of the constant, and the assertion
   * below then holds the constant to them.
   *
   * The judgement itself: only a state that means "HQ observed this working"
   * may be lit. `dispatchable` and `configured` mean the setup looks right,
   * which is a weaker claim wearing the stronger one's clothes.
   */
  const MAY_BE_DRAWN_REACHABLE: Record<ConnectionState, boolean> = {
    connected: true, // a live check ran and succeeded
    local_only: true, // runs here, with evidence; nothing to reach
    dispatchable: false, // an executor exists — the provider was never asked
    configured: false, // required facts present; nothing was verified
    not_connected: false,
    expired: false, // it worked once, which is not "it works"
    error: false,
    setup_required: false,
  };

  it('holds the canonical lit list to an independently stated judgement', () => {
    // The direction the derived version could not check at all: not "does the
    // client follow the list" but "is the list the right list".
    const canonical = [...LIT_CONNECTION_STATES].sort();
    const expected = (Object.keys(MAY_BE_DRAWN_REACHABLE) as ConnectionState[])
      .filter((state) => MAY_BE_DRAWN_REACHABLE[state])
      .sort();
    expect(canonical).toEqual(expected);
  });

  it('reports proven-reachable for exactly the states that may be drawn reachable', () => {
    for (const connectionState of Object.keys(MAY_BE_DRAWN_REACHABLE) as ConnectionState[]) {
      const state = buildHqSnapshot({
        generatedAt: AT,
        console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
        connections: {
          data: [
            {
              id: 'c',
              displayName: 'C',
              state: connectionState,
              reason: 'fixture',
              authMechanism: 'token',
              missingFacts: [],
            },
          ] as never,
          provenance: PROVENANCE,
        },
        workforce: { data: [], provenance: PROVENANCE },
        capabilities: { data: [], provenance: PROVENANCE },
        activity: { data: [], provenance: PROVENANCE },
      });
      const room = hydrateRooms(state, FOUNDER_SESSION).find((r) => r.roomId === 'world-network')!;
      const proven = room.metrics.find((m) => m.label === 'Proven reachable')!;
      expect(proven.value, connectionState).toBe(MAY_BE_DRAWN_REACHABLE[connectionState] ? 1 : 0);
    }
  });
});

describe('the attention count and its hint describe the same set of states', () => {
  it('names every warned state, and no settled one, in the hint', () => {
    // The count reads CONNECTION_STATE_TONE; the hint used to read "Reported
    // error or expired credential", left over from a narrower filter. So a
    // `configured` integration made the count say 1 while the hint said that 1
    // meant a failure — HQ asserting something canonical state does not record
    // (Codex round 17).
    //
    // Not a string comparison against a copy of the sentence: that would pass
    // whatever the sentence claimed. The property is that every warned state
    // is named and no settled one is.
    const state = buildHqSnapshot({
      generatedAt: AT,
      console: { data: emptyFounderConsole(AT), provenance: PROVENANCE },
      connections: {
        data: [
          {
            id: 'c',
            displayName: 'C',
            state: 'configured',
            reason: 'fixture',
            authMechanism: 'token',
            missingFacts: [],
          },
        ] as never,
        provenance: PROVENANCE,
      },
      workforce: { data: [], provenance: PROVENANCE },
      capabilities: { data: [], provenance: PROVENANCE },
      activity: { data: [], provenance: PROVENANCE },
    });
    const room = hydrateRooms(state, FOUNDER_SESSION).find((r) => r.roomId === 'world-network')!;
    const hint = room.metrics.find((m) => m.label === 'Needing attention')!.hint;

    for (const connectionState of Object.keys(CONNECTION_STATE_TONE) as ConnectionState[]) {
      const tone = CONNECTION_STATE_TONE[connectionState];
      const warned = tone === 'warn' || tone === 'danger';
      expect(hint.includes(CONNECTION_STATE_LABELS[connectionState]), `${connectionState} (${tone})`).toBe(
        warned,
      );
    }
    // And it must not describe the count as a failure, which is the specific
    // false claim that started this.
    expect(hint).toMatch(/half-finished setup/);
  });
});
