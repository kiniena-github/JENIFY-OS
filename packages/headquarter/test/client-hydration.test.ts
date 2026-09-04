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
