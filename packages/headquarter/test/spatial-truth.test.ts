/**
 * Truthfulness invariants for the living Headquarters (issue #200, spatial HQ).
 *
 * A spatial UI is a claim-making surface in a way a table is not: a figure
 * that moves asserts that work is happening, and a lit pillar asserts that a
 * service answers. These tests exist because that class of claim is the
 * easiest one in the whole product to make accidentally — a plausible-looking
 * default is indistinguishable from a fact once it is drawn.
 *
 * So every assertion here runs the SHIPPED functions (`floorState`,
 * `occupantActivity`, `renderScene`, `buildSite`) rather than checking a
 * description of them, and every one of them is about the same question: can
 * this floor show something that canonical data does not support?
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActivityEvent, ActivityStatus } from '../src/contracts/events.js';
import type { WorkerDescriptor } from '../src/contracts/workers.js';
import type { ConnectionState, ConnectionStatus } from '../src/live/connections.js';
import { CONNECTION_CATALOG } from '../src/live/connections.js';
import { latestTaskStates } from '../src/ui/model.js';
import { founderDashboard, projectBoard, workerStatuses } from '../src/ui/views.js';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { THEME_CSS } from '../src/ui/theme.js';
import { HQ_FLOOR, ROLE_ZONE, STATION_KINDS, floorExtent } from '../src/ui/spatial/world.js';
import {
  ACTIVITY_PRESENTATION,
  ANIMATED_ACTIVITIES,
  ATTENTION_ACTIVITIES,
  FIXTURE_STATION_KINDS,
  LIT_CONNECTION_STATES,
  SEAT_PRIORITY,
  WORKER_STATION_KINDS,
  fixtureSeatPriority,
  occupantSeatPriority,
  STATUS_ACTIVITY,
  floorOccupants,
  floorState,
  occupantActivity,
  type FloorInput,
  type OccupantActivity,
} from '../src/ui/spatial/state.js';
import {
  MARKER_CLEARANCE,
  MARKER_GEOMETRY,
  MARKER_HEIGHT,
  PROP_EXTENT,
  box,
  iso,
  renderScene,
} from '../src/ui/spatial/scene.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

let seq = 0;
function event(
  actor: string,
  taskId: string,
  status: ActivityStatus | null,
  detail: Record<string, unknown> = {},
): ActivityEvent {
  seq += 1;
  return {
    id: `ev-${seq}`,
    seq,
    at: `2026-08-28T0${Math.min(9, seq)}:00:00Z`,
    subjectKind: 'task',
    subjectId: taskId,
    status,
    actor,
    summary: `${taskId} → ${status ?? 'note'}`,
    detail: { project: 'JENIFY-OS', title: `Task ${taskId}`, ...detail },
  };
}

function worker(id: string, role: WorkerDescriptor['role'], active = true): WorkerDescriptor {
  return {
    id,
    displayName: id.toUpperCase(),
    vendor: 'test-vendor',
    role,
    allowedCapabilities: [],
    active,
  };
}

/** A floor built from an explicit event log and registry — no sample data. */
function floorFrom(events: ActivityEvent[], specialists: WorkerDescriptor[], connections: ConnectionStatus[] = []) {
  const states = latestTaskStates(events);
  const input: FloorInput = {
    states,
    dashboard: founderDashboard(states, '2026-08-28'),
    workers: workerStatuses(states),
    specialists,
    projects: projectBoard(states),
    approvals: [],
    connections,
    archive: [],
    chatMessages: [],
  };
  return floorState(input);
}

function connectionWithState(state: ConnectionState): ConnectionStatus {
  const descriptor = CONNECTION_CATALOG[0];
  return {
    ...descriptor,
    advertisedCapabilities: [...descriptor.advertisedCapabilities],
    requiredFacts: [...descriptor.requiredFacts],
    state,
    verification: 'configuration',
    outcome: 'not_attempted',
    observedFacts: [],
    missingFacts: [],
    effectiveCapabilities: [],
    lastVerifiedAt: null,
    evidenceSource: 'test fixture',
    reason: `test fixture forcing state ${state}`,
    canRecheck: false,
    canDisconnect: false,
  } as ConnectionStatus;
}

/* ------------------------------------------------------------------ */
/* 1. Deny by default                                                  */
/* ------------------------------------------------------------------ */

describe('an unknown worker is dark, never idle-but-present', () => {
  it('renders a registered specialist the log has never named as offline', () => {
    const floor = floorFrom([], [worker('claude', 'build_lead')]);
    const build = floor.zones.find((zone) => zone.zone.id === 'build-floor')!;
    const occupant = build.occupants.find((entry) => entry.id === 'claude')!;
    expect(occupant.activity).toBe('offline');
    expect(occupant.evidence).toContain('No canonical activity event');
    expect(floor.totals.active).toBe(0);
  });

  it('renders a worker marked inactive in the registry as offline even if the log names it', () => {
    const floor = floorFrom(
      [event('codex', 't1', 'running')],
      [worker('codex', 'reviewer_gatekeeper', false)],
    );
    const occupant = floor.zones.flatMap((zone) => zone.occupants).find((entry) => entry.id === 'codex')!;
    expect(occupant.activity).toBe('offline');
    expect(occupant.evidence).toContain('marked inactive');
  });

  it('renders a worker with only annotation events as offline, not queued', () => {
    // status:null events are real recorded activity but move nothing, so they
    // must not put anyone at a lit desk.
    const floor = floorFrom([event('jules', 't1', null)], [worker('jules', 'specialist_tool')]);
    const occupant = floor.zones.flatMap((zone) => zone.occupants).find((entry) => entry.id === 'jules')!;
    expect(occupant.activity).toBe('offline');
  });

  it('gives every occupant a non-empty evidence sentence, whatever its activity', () => {
    const floor = floorFrom(
      [
        event('claude', 't1', 'running'),
        event('codex', 't2', 'blocked'),
        event('gemini', 't3', 'needs_approval'),
        event('mistral', 't4', 'completed'),
      ],
      [worker('claude', 'build_lead'), worker('codex', 'reviewer_gatekeeper'), worker('idle-one', 'specialist_tool')],
    );
    const occupants = floor.zones.flatMap((zone) => zone.occupants);
    expect(occupants.length).toBeGreaterThan(4);
    for (const occupant of occupants) {
      expect(occupant.evidence.trim().length, `${occupant.id} has no evidence`).toBeGreaterThan(20);
    }
  });

  it('never invents a room population: a floor with no data has no occupants at all', () => {
    const floor = floorFrom([], []);
    expect(floor.zones.flatMap((zone) => zone.occupants)).toHaveLength(0);
    expect(floor.totals).toMatchObject({ occupants: 0, active: 0, blocked: 0, offline: 0 });
    for (const zone of floor.zones) {
      if (zone.fixtures.length === 0) expect(zone.liveness).toBe('unstaffed');
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Status mapping                                                   */
/* ------------------------------------------------------------------ */

describe('activity is a function of canonical status and nothing else', () => {
  const expected: Record<ActivityStatus, OccupantActivity> = {
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

  it.each(Object.keys(expected) as ActivityStatus[])('maps %s to its one spatial activity', (status) => {
    expect(STATUS_ACTIVITY[status]).toBe(expected[status]);
    const floor = floorFrom([event('w', 't1', status)], [worker('w', 'build_lead')]);
    const occupant = floor.zones.flatMap((zone) => zone.occupants).find((entry) => entry.id === 'w')!;
    expect(occupant.activity).toBe(expected[status]);
    expect(occupant.evidence).toContain(status);
  });

  it('only assigned and running put a worker in motion', () => {
    const moving = (Object.keys(expected) as ActivityStatus[]).filter((status) =>
      ANIMATED_ACTIVITIES.includes(expected[status]),
    );
    expect(moving.sort()).toEqual(['assigned', 'review_failed', 'review_passed', 'running']);
  });

  it('shows a worker whose only task waits on the Founder, and marks its room for attention', () => {
    // Regression. `workerStatuses` counts active, blocked and completed work
    // and nothing else, so this worker's aggregate is all zeroes. Deriving
    // activity from the aggregate alone drew the single most important figure
    // on the floor — the one whose work the Founder is blocking — as a dark,
    // apparently-idle desk.
    const floor = floorFrom([event('gated', 't1', 'needs_approval')], [worker('gated', 'build_lead')]);
    const zone = floor.zones.find((entry) => entry.zone.id === 'build-floor')!;
    const occupant = zone.occupants.find((entry) => entry.id === 'gated')!;
    expect(occupant.activity).toBe('awaiting_founder');
    expect(occupant.task?.taskId).toBe('t1');
    expect(occupant.evidence).toContain('only the Founder can clear it');
    expect(zone.liveness).toBe('attention');
    expect(floor.totals.awaitingFounder).toBe(1);
    expect(floor.totals.offline).toBe(0);
  });

  it('shows a worker whose only task is queued as queued, not offline', () => {
    const floor = floorFrom([event('waiting', 't1', 'queued')], [worker('waiting', 'build_lead')]);
    const occupant = floor.zones.flatMap((zone) => zone.occupants).find((entry) => entry.id === 'waiting')!;
    expect(occupant.activity).toBe('queued');
    expect(occupant.evidence).toContain('accepted, not started');
  });

  it('prefers an active task over a stale completion when both are recorded', () => {
    const { activity, task } = occupantActivity(worker('w', 'build_lead'), {
      worker: 'w',
      activeTask: {
        taskId: 't9',
        project: 'p',
        title: 'live one',
        worker: 'w',
        status: 'running',
        updatedAt: '2026-08-28T09:00:00Z',
        history: [],
      },
      activeCount: 1,
      blockedCount: 0,
      completedCount: 3,
      lastSeen: '2026-08-28T09:00:00Z',
    });
    expect(activity).toBe('working');
    expect(task?.taskId).toBe('t9');
  });

  it('falls back to blocked before complete when no task is active', () => {
    const { activity } = occupantActivity(worker('w', 'build_lead'), {
      worker: 'w',
      activeTask: null,
      activeCount: 0,
      blockedCount: 2,
      completedCount: 5,
      lastSeen: '2026-08-28T09:00:00Z',
    });
    expect(activity).toBe('blocked');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Uplinks                                                          */
/* ------------------------------------------------------------------ */

describe('an uplink pillar is lit only by connection evidence', () => {
  const states: ConnectionState[] = [
    'connected',
    'local_only',
    'dispatchable',
    'configured',
    'not_connected',
    'expired',
    'error',
    'setup_required',
  ];

  it.each(states)('%s lights the pillar only when it may carry capabilities', (state) => {
    const floor = floorFrom([], [], [connectionWithState(state)]);
    const gallery = floor.zones.find((zone) => zone.zone.id === 'uplink-gallery')!;
    const fixture = gallery.fixtures[0];
    expect(fixture.lit).toBe((LIT_CONNECTION_STATES as readonly string[]).includes(state));
    expect(fixture.evidence).toContain(state);
  });

  it('leaves a configured-but-unverified service dark', () => {
    // "The credential is present" is a setup fact, not a connectivity fact.
    // Lighting it would upgrade the weaker claim into the stronger one.
    const floor = floorFrom([], [], [connectionWithState('configured')]);
    const gallery = floor.zones.find((zone) => zone.zone.id === 'uplink-gallery')!;
    expect(gallery.fixtures[0].lit).toBe(false);
    expect(floor.totals.litUplinks).toBe(0);
    expect(floor.totals.uplinks).toBe(1);
  });

  it('draws a dark pillar rather than omitting an unconnected service', () => {
    const floor = floorFrom([], [], states.map(connectionWithState));
    const gallery = floor.zones.find((zone) => zone.zone.id === 'uplink-gallery')!;
    expect(gallery.fixtures).toHaveLength(states.length);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The scene draws exactly what the state says                      */
/* ------------------------------------------------------------------ */

describe('the rendered scene cannot animate more than the state supports', () => {
  const floor = floorFrom(
    [event('runner', 't1', 'running'), event('stopper', 't2', 'blocked')],
    [worker('runner', 'build_lead'), worker('stopper', 'build_lead'), worker('ghost', 'build_lead')],
  );
  const svg = renderScene(floor);

  it('gives each figure exactly the class of its canonical activity', () => {
    expect(svg).toContain('class="hq-figure act-working" data-worker="runner"');
    expect(svg).toContain('class="hq-figure act-blocked" data-worker="stopper"');
    expect(svg).toContain('class="hq-figure act-offline" data-worker="ghost"');
  });

  it('lights a worker’s screen only under an animated activity', () => {
    // Scoped to worker-occupied stations on purpose. Fixture stations light
    // on their own evidence — a Command Deck console showing a real in-flight
    // count is legitimately lit with nobody sitting at it — so a site-wide
    // count of lit glass would conflate two different claims.
    const workerStations = svg
      .split('<g class="hq-station"')
      .filter((fragment) => fragment.includes('data-occupied="worker"'));
    const lit = workerStations.filter((fragment) => fragment.includes('class="prop-screen is-lit"')).length;
    const animated = floor.zones
      .flatMap((zone) => zone.occupants)
      .filter((occupant) => occupant.stationId && ANIMATED_ACTIVITIES.includes(occupant.activity)).length;
    expect(lit).toBe(animated);
    expect(lit).toBe(1);
  });

  it('never lights a fixture station whose fixture is unlit', () => {
    const fixtureStations = svg
      .split('<g class="hq-station"')
      .filter((fragment) => fragment.includes('data-occupied="fixture"'));
    const litFixtures = floor.zones.flatMap((zone) => zone.fixtures).filter((fixture) => fixture.stationId && fixture.lit);
    const litDrawn = fixtureStations.filter((fragment) => fragment.includes('is-lit')).length;
    expect(litDrawn).toBe(litFixtures.length);
  });

  it('animates a figure for EVERY animated activity and for no other', () => {
    // Derived from ANIMATED_ACTIVITIES rather than listing cases, so adding a
    // new activity cannot quietly acquire motion. This is the rule the page
    // states in words, checked against the stylesheet that has to keep it.
    //
    // Codex P1 on `936a682`: `blocked` and `awaiting_founder` figures pulsed.
    // The page tells the reader a figure moves only while a canonical event
    // says its task is active, so animating stopped work made the page break
    // its own stated rule — worse than never having stated it.
    const activities = Object.keys(ACTIVITY_PRESENTATION) as OccupantActivity[];
    for (const activity of activities) {
      const rules = [...THEME_CSS.matchAll(/\.hq-figure\.act-([a-z_]+)([^{]*)\{([^}]*)\}/g)].filter(
        ([, name]) => name === activity,
      );
      const animates = rules.some(([, , , body]) => /animation:\s*[^;]*\bhq-/.test(body));
      expect(animates, `act-${activity} must ${ANIMATED_ACTIVITIES.includes(activity) ? '' : 'NOT '}animate`).toBe(
        ANIMATED_ACTIVITIES.includes(activity),
      );
    }
    expect(THEME_CSS).toContain('.hq-figure.act-offline { opacity:');
  });

  it('states the floor totals in the scene’s accessible description', () => {
    expect(svg).toContain('1 worker(s) of which'.replace('1 worker(s)', `${floor.totals.occupants} worker(s)`));
    expect(svg).toContain(`${floor.totals.active} active`);
    expect(svg).toContain(`${floor.totals.offline} offline`);
  });

  it('fetches nothing: no external asset, no script, no foreign object', () => {
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('<foreignObject');
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/href="https?:/);
    // The only hrefs are same-document room fragments.
    for (const [, href] of svg.matchAll(/href="([^"]*)"/g)) expect(href.startsWith('#room-')).toBe(true);
  });

  it('keeps the nameplate layer out of the pointer path', () => {
    // Regression, found in a browser and not by any structural check that
    // existed at the time. Nameplates are painted over the plan and each one
    // sits at the centre of its room — the most natural place to click — so
    // without `pointer-events: none` the label swallowed the click on every
    // room. Keyboard focus still worked, so the plan looked interactive and
    // was not.
    expect(svg).toContain('<g class="hq-nameplates" aria-hidden="true">');
    expect(THEME_CSS).toContain('.hq-nameplates { pointer-events: none; }');
  });

  it('is deterministic: the same floor renders byte-identical SVG', () => {
    expect(renderScene(floor)).toBe(svg);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Geometry                                                         */
/* ------------------------------------------------------------------ */

describe('the projection and floor plan are stable', () => {
  it('projects the origin to the origin and keeps the axes distinct', () => {
    expect(iso(0, 0)).toEqual({ sx: 0, sy: 0 });
    expect(iso(1, 0).sx).toBeGreaterThan(0);
    expect(iso(0, 1).sx).toBeLessThan(0);
    // Height lifts a point on screen rather than moving it sideways.
    expect(iso(2, 2, 1)).toEqual({ sx: 0, sy: iso(2, 2).sy - 1 });
  });

  it('lays out eight non-overlapping rooms', () => {
    expect(HQ_FLOOR).toHaveLength(8);
    for (const a of HQ_FLOOR) {
      for (const b of HQ_FLOOR) {
        if (a.id === b.id) continue;
        const disjoint =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.depth <= b.y || b.y + b.depth <= a.y;
        expect(disjoint, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
    const extent = floorExtent();
    expect(extent.width).toBeGreaterThan(0);
    expect(extent.depth).toBeGreaterThan(0);
  });

  it('gives every station a unique id and keeps it inside its room', () => {
    const ids = new Set<string>();
    for (const zone of HQ_FLOOR) {
      for (const station of zone.stations) {
        expect(ids.has(station.id), `duplicate station id ${station.id}`).toBe(false);
        ids.add(station.id);
        expect(station.x).toBeGreaterThanOrEqual(0);
        expect(station.y).toBeGreaterThanOrEqual(0);
        expect(station.x).toBeLessThan(zone.width);
        expect(station.y).toBeLessThan(zone.depth);
      }
    }
  });

  it('routes every registered role to a room that exists', () => {
    for (const zoneId of Object.values(ROLE_ZONE)) {
      expect(HQ_FLOOR.some((zone) => zone.id === zoneId), `${zoneId} is not a room`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. Capacity and registry honesty                                    */
/* ------------------------------------------------------------------ */

describe('the floor never drops or invents people', () => {
  it('lists a worker the registry does not know, and labels it unregistered', () => {
    const floor = floorFrom([event('stranger', 't1', 'running')], []);
    const occupant = floor.zones.flatMap((zone) => zone.occupants).find((entry) => entry.id === 'stranger')!;
    expect(occupant.registered).toBe(false);
    expect(occupant.subtitle).toContain('not in the specialist registry');
    expect(occupant.activity).toBe('working');
  });

  it('keeps a surplus worker in the data with no seat rather than hiding it', () => {
    const buildFloor = HQ_FLOOR.find((zone) => zone.id === 'build-floor')!;
    const seats = buildFloor.stations.filter((station) => station.kind === 'desk').length;
    const crowd = Array.from({ length: seats + 3 }, (_, index) => worker(`w${index}`, 'build_lead'));
    const floor = floorFrom([], crowd);
    const zone = floor.zones.find((entry) => entry.zone.id === 'build-floor')!;
    expect(zone.occupants).toHaveLength(seats + 3);
    expect(zone.occupants.filter((occupant) => occupant.stationId !== null)).toHaveLength(seats);
    for (const seatless of zone.occupants.filter((occupant) => occupant.stationId === null)) {
      expect(seatless.evidence.length).toBeGreaterThan(0);
    }
  });

  it('never seats a worker and a fixture at the same station', () => {
    // Codex P2 on `936a682`. Both seating lists contained `console`, so on the
    // Command Deck a registered mission_director and the "In flight" console
    // were assigned the same station. The renderer gives the occupant
    // precedence, so an OFFLINE director made the in-flight console read as
    // dark while tasks were genuinely in flight, and dropped the fixture's
    // label from the station's accessible title.
    expect(
      WORKER_STATION_KINDS.filter((kind) => (FIXTURE_STATION_KINDS as readonly string[]).includes(kind)),
    ).toEqual([]);

    // And the property that matters, checked on a floor that crowds every room.
    const crowd = [
      worker('director', 'mission_director'),
      worker('lead', 'build_lead'),
      worker('rev', 'reviewer_gatekeeper'),
      ...Array.from({ length: 12 }, (_, index) => worker(`extra${index}`, 'parallel_implementer')),
    ];
    const floor = floorFrom([event('lead', 't1', 'running')], crowd, [connectionWithState('connected')]);
    for (const zone of floor.zones) {
      const taken = new Map<string, string>();
      for (const occupant of zone.occupants) {
        if (occupant.stationId) taken.set(occupant.stationId, `worker ${occupant.id}`);
      }
      for (const fixture of zone.fixtures) {
        if (!fixture.stationId) continue;
        expect(
          taken.has(fixture.stationId),
          `${fixture.id} collides with ${taken.get(fixture.stationId)} at ${fixture.stationId}`,
        ).toBe(false);
      }
    }
  });

  it('keeps a lit Command Deck console lit even when an offline director is on the floor', () => {
    // The end-to-end shape of the P2 defect, asserted on the rendered SVG.
    const floor = floorFrom(
      [event('lead', 't1', 'running')],
      [worker('director', 'mission_director'), worker('lead', 'build_lead')],
    );
    const deck = floor.zones.find((zone) => zone.zone.id === 'command-deck')!;
    const inFlight = deck.fixtures.find((fixture) => fixture.id === 'console-inflight')!;
    expect(inFlight.lit).toBe(true);
    const station = [...renderScene(floor).split('<g class="hq-station"')].find((fragment) =>
      fragment.includes(`data-station="${inFlight.stationId}"`),
    )!;
    expect(station).toContain('data-occupied="fixture"');
    expect(station).toContain('is-lit');
    expect(station).toContain('In flight');
  });

  it('always draws whatever puts a room into attention, even over capacity', () => {
    // Codex review of `a123dbc`, P2, generalised.
    //
    // The room's liveness word is computed from ALL its contents; the plan can
    // only draw what it seats. So when a room is over capacity, the thing that
    // CAUSED the warning must be among the things drawn — otherwise the room
    // says "Needs attention" while showing nothing but healthy pillars and
    // busy people, and the warning has no visible referent.
    //
    // Codex reported the fixture half (8 healthy connections filling the
    // Uplink Gallery, an errored one dropped). The occupant half was not
    // reported and was equally real: 8 working builders filling the Build
    // Floor, a blocked worker dropped. Both now run through one seater, so
    // this asserts the invariant for both at once.
    const connections = [
      ...Array.from({ length: 8 }, (_, index) => ({ ...connectionWithState('connected'), id: `ok-${index}` })),
      { ...connectionWithState('error'), id: 'broken' },
    ];
    const busy = Array.from({ length: 8 }, (_, index) => worker(`aa${index}`, 'build_lead'));
    const floor = floorFrom(
      [
        ...busy.map((entry, index) => event(entry.id, `t${index}`, 'running')),
        event('zz-blocked', 'tz', 'blocked'),
        event('zz-gated', 'tg', 'needs_approval'),
      ],
      [...busy, worker('zz-blocked', 'build_lead'), worker('zz-gated', 'build_lead')],
      connections,
    );

    for (const zone of floor.zones) {
      if (zone.liveness !== 'attention') continue;
      const causes = [
        ...zone.occupants.filter((occupant) => ATTENTION_ACTIVITIES.includes(occupant.activity)),
        ...zone.fixtures.filter((fixture) => fixture.tone === 'warn' || fixture.tone === 'danger'),
      ];
      expect(causes.length, `${zone.zone.id} is 'attention' with nothing causing it`).toBeGreaterThan(0);
      expect(
        causes.some((cause) => cause.stationId !== null),
        `${zone.zone.id} needs attention but every cause is unseated, so the plan cannot show why`,
      ).toBe(true);
    }

    // And specifically, at the two rooms the reproduction crowds.
    const gallery = floor.zones.find((zone) => zone.zone.id === 'uplink-gallery')!;
    expect(gallery.fixtures.find((fixture) => fixture.id === 'uplink-broken')!.stationId).not.toBeNull();
    const build = floor.zones.find((zone) => zone.zone.id === 'build-floor')!;
    for (const id of ['zz-blocked', 'zz-gated']) {
      expect(build.occupants.find((occupant) => occupant.id === id)!.stationId, `${id} unseated`).not.toBeNull();
    }
  });

  it('decides a room’s word and its seating from the same rules', () => {
    // The failure mode itself, rather than another instance of it.
    //
    // `liveness()` computes the room's word from all its contents; the seat
    // priorities decide what the plan can draw. Four review findings on this
    // file have been two individually-correct rules drifting apart, so this
    // asserts the agreement directly: a room is 'attention' EXACTLY when it
    // holds something the seater ranks as attention, and 'active' exactly
    // when it holds something ranked positive and nothing ranked attention.
    //
    // Exercised over every activity and every fixture tone, so a future edit
    // that changes one predicate and not the other fails here.
    const activities = Object.keys(ACTIVITY_PRESENTATION) as OccupantActivity[];
    const statuses: ActivityStatus[] = [
      'queued',
      'assigned',
      'running',
      'review_failed',
      'review_passed',
      'blocked',
      'outcome_unknown',
      'needs_approval',
      'completed',
    ];
    const connectionStates: ConnectionState[] = [
      'connected',
      'local_only',
      'configured',
      'not_connected',
      'expired',
      'error',
    ];

    const floors = [
      ...statuses.map((status) =>
        floorFrom([event(`w-${status}`, `t-${status}`, status)], [worker(`w-${status}`, 'build_lead')]),
      ),
      ...connectionStates.map((state) => floorFrom([], [], [connectionWithState(state)])),
      floorFrom(
        statuses.map((status, index) => event(`m${index}`, `tm${index}`, status)),
        statuses.map((status, index) => worker(`m${index}`, 'build_lead')),
        connectionStates.map(connectionWithState),
      ),
    ];

    expect(activities.length).toBeGreaterThan(0);
    for (const floor of floors) {
      for (const zone of floor.zones) {
        const ranks = [
          ...zone.occupants.map(occupantSeatPriority),
          ...zone.fixtures.map(fixtureSeatPriority),
        ];
        const hasAttention = ranks.includes(SEAT_PRIORITY.attention);
        const hasPositive = ranks.includes(SEAT_PRIORITY.positive);
        if (zone.occupants.length === 0 && zone.fixtures.length === 0) {
          expect(zone.liveness).toBe('unstaffed');
          continue;
        }
        expect(
          zone.liveness === 'attention',
          `${zone.zone.id}: liveness=${zone.liveness} but seater ${hasAttention ? 'does' : 'does not'} rank something attention`,
        ).toBe(hasAttention);
        if (!hasAttention) {
          expect(zone.liveness === 'active', `${zone.zone.id}: liveness=${zone.liveness}`).toBe(hasPositive);
        }
      }
    }
  });

  it('draws a failing fixture differently from one nobody ever configured', () => {
    // Codex review of `67bbaac`. Seating the failure was necessary and not
    // sufficient: an errored uplink is `lit: false` — lighting it would claim
    // positive evidence, the one thing this floor must never do — so it
    // rendered byte-identically to a service nobody has set up. The room said
    // "Needs attention" and the pillar explaining it was invisible unless the
    // reader found its <title>.
    const broken = { ...connectionWithState('error'), id: 'broken', displayName: 'BROKEN' };
    const never = { ...connectionWithState('not_connected'), id: 'never', displayName: 'NEVERSET' };
    const floor = floorFrom([], [], [broken, never]);
    const gallery = floor.zones.find((zone) => zone.zone.id === 'uplink-gallery')!;
    const svg = renderScene(floor);
    const stationOf = (fixtureId: string) => {
      const fixture = gallery.fixtures.find((entry) => entry.id === fixtureId)!;
      expect(fixture.stationId, `${fixtureId} unseated`).not.toBeNull();
      return svg
        .split('<g class="hq-station"')
        .find((fragment) => fragment.includes(`data-station="${fixture.stationId}"`))!;
    };

    const failing = stationOf('uplink-broken');
    const unconfigured = stationOf('uplink-never');

    // Neither is lit: a failure is not positive evidence either.
    expect(failing).not.toContain('is-lit');
    expect(unconfigured).not.toContain('is-lit');

    // But the failure is marked, and the mark is a SHAPE, so the distinction
    // does not rest on colour alone.
    expect(failing).toContain('data-attention="yes"');
    expect(failing).toContain('class="fault-marker"');
    expect(unconfigured).not.toContain('data-attention');
    expect(unconfigured).not.toContain('fault-marker');

    // The stylesheet also tints it, and specifically targets the UNLIT prop —
    // the gap that made the two identical.
    expect(THEME_CSS).toContain('.hq-station[data-attention="yes"] .prop-lamp.face-top');
    expect(THEME_CSS).toContain('.fault-stem.face-top');

    // A stopped thing is never animated.
    expect(THEME_CSS).not.toMatch(/\.fault-(stem|dot)[^{]*\{[^}]*animation:/);
  });

  it('marks every attention fixture it seats, in every room', () => {
    const floor = floorFrom(
      [event('w', 't1', 'needs_approval')],
      [worker('w', 'build_lead')],
      [connectionWithState('error'), connectionWithState('expired')],
    );
    const svg = renderScene(floor);
    for (const zone of floor.zones) {
      for (const fixture of zone.fixtures) {
        if (fixture.stationId === null) continue;
        const station = svg
          .split('<g class="hq-station"')
          .find((fragment) => fragment.includes(`data-station="${fixture.stationId}"`))!;
        const marked = station.includes('data-attention="yes"');
        const causesAttention = fixture.tone === 'warn' || fixture.tone === 'danger';
        expect(marked, `${fixture.id} (tone ${fixture.tone}) marked=${marked}`).toBe(causesAttention);
      }
    }
  });

  it('renders two model states identically only when they mean the same thing', () => {
    // The general form of the round-5 finding, which was a CROSS-CLASS
    // collision: `error` and `not_connected` mean different things and drew
    // byte-identically.
    //
    // Collisions as such are fine and intended — `assigned` and `running`
    // both mean "working", `connected` and `local_only` are both lit. What
    // must never happen is two states from DIFFERENT classes rendering the
    // same. So this asserts the biconditional: identical render ⟺ same class.
    //
    // The <title> is stripped before comparing, because it is text a reader
    // has to go looking for; the point of the finding was that the VISUAL
    // rendering must carry the distinction.
    //
    // LIMIT OF THIS TEST, stated because it is the same limit that let the
    // round-5 defect through: it compares MARKUP, and differing markup does
    // not prove differing appearance. `data-tone="danger"` and
    // `data-tone="neutral"` made the two fragments differ while no CSS rule
    // keyed on them for an unlit prop, so the pillars looked identical. A
    // markup check is therefore necessary and NOT sufficient. The measured
    // check — computed fills read out of a real browser — lives in
    // `tools/state-visual-evidence.ts`, following this package's convention
    // that structural properties run in CI and measured ones are produced as
    // PR evidence.
    const stationFor = (floor: ReturnType<typeof floorFrom>, zoneId: string, stationId: string | null) => {
      if (stationId === null) return 'UNSEATED';
      return renderScene(floor)
        .split('<g class="hq-station"')
        .find((fragment) => fragment.includes(`data-station="${stationId}"`))!
        .replace(/<title>[^<]*<\/title>/, '');
    };

    // Occupants: same class ⟺ same OccupantActivity.
    const statuses: ActivityStatus[] = [
      'queued',
      'assigned',
      'running',
      'review_failed',
      'review_passed',
      'blocked',
      'outcome_unknown',
      'needs_approval',
      'completed',
    ];
    const occupantRender = new Map<ActivityStatus, string>();
    for (const status of statuses) {
      const floor = floorFrom([event('w', 't1', status)], [worker('w', 'build_lead')]);
      const zone = floor.zones.find((entry) => entry.zone.id === 'build-floor')!;
      occupantRender.set(status, stationFor(floor, 'build-floor', zone.occupants[0].stationId));
    }
    for (const a of statuses) {
      for (const b of statuses) {
        const sameClass = STATUS_ACTIVITY[a] === STATUS_ACTIVITY[b];
        const sameRender = occupantRender.get(a) === occupantRender.get(b);
        expect(
          sameRender,
          `${a} and ${b} render ${sameRender ? 'identically' : 'differently'} but mean ` +
            `${STATUS_ACTIVITY[a]} and ${STATUS_ACTIVITY[b]}`,
        ).toBe(sameClass);
      }
    }

    // Fixtures: same class ⟺ same (lit, causes-attention) pair.
    const connectionStates: ConnectionState[] = [
      'connected',
      'local_only',
      'dispatchable',
      'configured',
      'not_connected',
      'expired',
      'error',
      'setup_required',
    ];
    const fixtureRender = new Map<ConnectionState, string>();
    const fixtureClass = new Map<ConnectionState, string>();
    for (const state of connectionStates) {
      const floor = floorFrom([], [], [connectionWithState(state)]);
      const zone = floor.zones.find((entry) => entry.zone.id === 'uplink-gallery')!;
      const fixture = zone.fixtures[0];
      fixtureRender.set(state, stationFor(floor, 'uplink-gallery', fixture.stationId));
      fixtureClass.set(state, `${fixture.lit}/${fixture.tone === 'warn' || fixture.tone === 'danger'}`);
    }
    for (const a of connectionStates) {
      for (const b of connectionStates) {
        const sameClass = fixtureClass.get(a) === fixtureClass.get(b);
        const sameRender = fixtureRender.get(a) === fixtureRender.get(b);
        expect(
          sameRender,
          `${a} (${fixtureClass.get(a)}) and ${b} (${fixtureClass.get(b)}) render ` +
            `${sameRender ? 'identically' : 'differently'}`,
        ).toBe(sameClass);
      }
    }

    // And the classes really are distinct, so the biconditional is not
    // vacuously satisfied by everything landing in one bucket.
    expect(new Set(fixtureClass.values()).size).toBe(3);
    expect(new Set(fixtureRender.values()).size).toBe(3);
  });

  it('builds the fault marker as two separated shapes floating above the prop', () => {
    // Codex review of `a455799`. `box()` extruded from z=0 unconditionally, so
    // the marker's stem and dot were two floor-standing columns sharing one
    // footprint: the shorter drew entirely inside the taller and the pair read
    // as a single spike through the prop it was meant to clarify.
    const { dotBase, dotTop, stemBase, stemTop } = MARKER_GEOMETRY;
    expect(dotTop).toBeGreaterThan(dotBase);
    expect(stemTop).toBeGreaterThan(stemBase);
    expect(stemBase, 'stem must start above the dot, leaving a visible gap').toBeGreaterThan(dotTop);

    // And the shapes really do float: `box` with a base z must not reach the
    // floor. This is the helper-level fix, asserted directly.
    const floating = box(0, 0, 1, 1, 2, 'probe', 1);
    const points = [...floating.matchAll(/points="([^"]+)"/g)].flatMap(([, data]) =>
      data.split(' ').map((pair) => Number(pair.split(',')[1])),
    );
    // Screen y grows downward and z lifts, so the lowest drawn point must sit
    // at z=1, not z=0. iso(1,1,1).sy = 1 - 1 = 0; iso(1,1,0).sy = 1.
    expect(Math.max(...points), 'a floating box still touched the floor').toBeLessThan(iso(1, 1, 0).sy);
  });

  it('floats the marker clear of every station kind, with no silent fallback', () => {
    // The geometry axis had per-case tests only — I checked desks and uplinks
    // by eye and left the other six kinds to a `?? 1.2` fallback, which is
    // exactly the shape of "a rule that holds where it was looked at". A kind
    // added later must fail here rather than inherit a colliding height.
    for (const kind of STATION_KINDS) {
      expect(MARKER_HEIGHT[kind], `${kind} has no marker height`).toBeTypeOf('number');
      expect(PROP_EXTENT[kind], `${kind} has no recorded extent`).toBeTypeOf('number');
      expect(
        MARKER_HEIGHT[kind] - PROP_EXTENT[kind],
        `${kind}: marker at ${MARKER_HEIGHT[kind]} does not clear contents standing ${PROP_EXTENT[kind]} tall`,
      ).toBeGreaterThanOrEqual(MARKER_CLEARANCE);
    }
    // Every kind the floor plan actually uses is covered.
    for (const zone of HQ_FLOOR) {
      for (const station of zone.stations) {
        expect(STATION_KINDS).toContain(station.kind);
      }
    }
  });

  it('marks an attention-causing WORKER, not only a fixture', () => {
    // Codex review of `a455799`. Restricting the marker to fixtures left a
    // blocked figure identifiable only by head colour — recreating, for
    // occupants, the colour-only gap the marker was introduced to close.
    const floor = floorFrom(
      [event('stuck', 't1', 'blocked'), event('busy', 't2', 'running')],
      [worker('stuck', 'build_lead'), worker('busy', 'build_lead')],
    );
    const svg = renderScene(floor);
    const zone = floor.zones.find((entry) => entry.zone.id === 'build-floor')!;
    const stationOf = (id: string) => {
      const occupant = zone.occupants.find((entry) => entry.id === id)!;
      return svg
        .split('<g class="hq-station"')
        .find((fragment) => fragment.includes(`data-station="${occupant.stationId}"`))!;
    };
    expect(stationOf('stuck')).toContain('class="fault-marker"');
    expect(stationOf('stuck')).toContain('data-attention="yes"');
    expect(stationOf('busy')).not.toContain('fault-marker');
  });

  it('says in words why a project bay needs attention, not just that it does', () => {
    // Codex review of `a455799`. The bay took a danger tone from its blocked
    // count while its detail and evidence reported only open/completed work,
    // so a blocked project and a healthy one with identical counts differed
    // by styling and a generic marker alone — in the station title AND the
    // room panel.
    const floor = floorFrom(
      [
        event('a', 't1', 'blocked', { project: 'ALPHA' }),
        event('b', 't2', 'running', { project: 'ALPHA' }),
        event('c', 't3', 'needs_approval', { project: 'GAMMA' }),
        event('d', 't4', 'running', { project: 'BETA' }),
      ],
      [],
    );
    const bays = floor.zones.find((zone) => zone.zone.id === 'project-bays')!.fixtures;
    const bay = (project: string) => bays.find((fixture) => fixture.id === `bay-${project}`)!;

    expect(bay('ALPHA').tone).toBe('danger');
    expect(bay('ALPHA').detail).toContain('1 blocked');
    expect(bay('ALPHA').evidence).toContain('blocked or outcome_unknown');

    expect(bay('GAMMA').tone).toBe('warn');
    expect(bay('GAMMA').detail).toContain('waiting on Founder');
    expect(bay('GAMMA').evidence).toContain('needs_approval');

    // A healthy bay says nothing about blockers, so the words stay a signal.
    expect(bay('BETA').detail).not.toContain('blocked');
    expect(bay('BETA').evidence).not.toContain('blocked');

    // Every attention bay's cause reaches the station title, which is built
    // from label + detail.
    const svg = renderScene(floor);
    for (const project of ['ALPHA', 'GAMMA']) {
      const fixture = bay(project);
      const station = svg
        .split('<g class="hq-station"')
        .find((fragment) => fragment.includes(`data-station="${fixture.stationId}"`))!;
      expect(station).toContain(fixture.detail.split(' · ')[0]);
    }
  });

  it('never lets colour be the only difference between a flagged and a healthy fixture', () => {
    // The general form of the project-bay finding, which was: "a blocked
    // project and a healthy project with the same counts differ only by
    // styling and the generic marker".
    //
    // The rule that catches that shape anywhere: within a room, no fixture
    // that needs attention may carry the same words as one that does not.
    // If two fixtures read identically and differ only in tone, colour is
    // doing all the work — which is the failure mode, not a styling detail.
    //
    // ALPHA and BETA below are constructed to have IDENTICAL open/completed
    // counts and differ only in that ALPHA has a blocked task, so the pair
    // collides unless the words carry the condition.
    const floor = floorFrom(
      [
        // ALPHA: one blocked task. BETA: one running task. Both therefore
        // have openCount 1 and completedCount 0 — identical counts, so
        // pre-fix both read "1 open · 0 done" and only the tone differed.
        event('a', 't1', 'blocked', { project: 'ALPHA' }),
        event('c', 't3', 'running', { project: 'BETA' }),
        event('d', 't4', 'needs_approval', { project: 'GAMMA' }),
      ],
      [],
      [connectionWithState('error'), connectionWithState('not_connected')],
    );

    for (const zone of floor.zones) {
      const flagged = zone.fixtures.filter((fixture) => fixture.tone === 'warn' || fixture.tone === 'danger');
      const healthy = zone.fixtures.filter((fixture) => fixture.tone !== 'warn' && fixture.tone !== 'danger');
      for (const bad of flagged) {
        for (const good of healthy) {
          expect(
            bad.detail === good.detail,
            `${zone.zone.id}: "${bad.id}" needs attention and "${good.id}" does not, ` +
              `yet both read "${bad.detail}" — only colour separates them`,
          ).toBe(false);
        }
        // And its evidence must say something a healthy fixture's would not.
        expect(bad.evidence.length, `${bad.id} has no evidence`).toBeGreaterThan(20);
      }
    }

    // The construction really does collide on counts, so the test is not
    // passing because the fixtures were trivially different anyway.
    const bays = floor.zones.find((zone) => zone.zone.id === 'project-bays')!.fixtures;
    const alpha = bays.find((fixture) => fixture.id === 'bay-ALPHA')!;
    const beta = bays.find((fixture) => fixture.id === 'bay-BETA')!;
    expect(alpha.tone).toBe('danger');
    expect(beta.tone).not.toBe('danger');
    expect(alpha.detail).toContain('1 open');
    expect(beta.detail).toContain('1 open');
    expect(alpha.detail).not.toBe(beta.detail);
  });

  it('seats deterministically when several items tie on priority', () => {
    const connections = Array.from({ length: 12 }, (_, index) => ({
      ...connectionWithState('connected'),
      id: `same-${index}`,
    }));
    const once = floorFrom([], [], connections);
    const twice = floorFrom([], [], connections);
    const seatsOf = (floor: typeof once) =>
      floor.zones.flatMap((zone) => zone.fixtures.map((fixture) => `${fixture.id}@${fixture.stationId}`));
    expect(seatsOf(once)).toEqual(seatsOf(twice));
  });

  it('never drops a LIT fixture while an unlit one holds a station', () => {
    // Codex review of `9c0e354`, P2. With one bench and two Founder-Suite
    // fixtures, the unlit "pending approval requests" claim took the only
    // station and the LIT "gated work" claim was left unseated — a dark bench
    // in the one room whose whole purpose is showing what waits on the
    // Founder. The room gained a second bench; this asserts the general rule
    // that outlives that particular room.
    const floor = floorFrom(
      [event('w', 't1', 'needs_approval')],
      [worker('w', 'build_lead')],
      // More connections than the Uplink Gallery has pillars, unlit first, so
      // naive ordering would seat the dark ones and drop the live one.
      [
        ...Array.from({ length: 9 }, () => connectionWithState('not_connected')),
        connectionWithState('connected'),
      ],
    );
    for (const zone of floor.zones) {
      const unseatedLit = zone.fixtures.filter((fixture) => fixture.lit && fixture.stationId === null);
      const seatedUnlit = zone.fixtures.filter((fixture) => !fixture.lit && fixture.stationId !== null);
      expect(
        unseatedLit.length === 0 || seatedUnlit.length === 0,
        `${zone.zone.id}: lit ${unseatedLit.map((f) => f.id).join()} dropped while unlit ${seatedUnlit
          .map((f) => f.id)
          .join()} kept a station`,
      ).toBe(true);
    }
  });

  it('seats every Founder Suite claim, so gated work is never a dark bench', () => {
    const floor = floorFrom([event('w', 't1', 'needs_approval')], [worker('w', 'build_lead')]);
    const suite = floor.zones.find((zone) => zone.zone.id === 'founder-suite')!;
    const gated = suite.fixtures.find((fixture) => fixture.id === 'bench-gated-tasks')!;
    expect(gated.lit).toBe(true);
    for (const fixture of suite.fixtures) expect(fixture.stationId, `${fixture.id} has no station`).not.toBeNull();
    const station = [...renderScene(floor).split('<g class="hq-station"')].find((fragment) =>
      fragment.includes(`data-station="${gated.stationId}"`),
    )!;
    expect(station).toContain('is-lit');
    expect(station).toContain('Gated work');
  });

  it('gives every room at least as many fixture stations as it can hold fixed-count fixtures', () => {
    // Rooms whose fixture list is a fixed set — not one-per-connection or
    // one-per-project — must have the capacity to draw all of it.
    const fixedCapacity: Record<string, number> = {
      'command-deck': 3,
      'founder-suite': 2,
      'archive-stacks': 2,
      'situation-room': 1,
    };
    for (const [zoneId, needed] of Object.entries(fixedCapacity)) {
      const zone = HQ_FLOOR.find((entry) => entry.id === zoneId)!;
      const stations = zone.stations.filter((station) =>
        (FIXTURE_STATION_KINDS as readonly string[]).includes(station.kind),
      );
      expect(stations.length, `${zoneId} has ${stations.length} fixture stations, needs ${needed}`).toBeGreaterThanOrEqual(
        needed,
      );
    }
  });

  it('keeps every station inside its room after the Founder Suite gained a bench', () => {
    // benchProp draws a 2.0-unit footprint starting at x - 0.4, which is
    // wider than the station point itself; `row()` spacing would have pushed
    // the second bench past the room edge.
    for (const zone of HQ_FLOOR) {
      for (const station of zone.stations.filter((entry) => entry.kind === 'bench')) {
        expect(station.x - 0.4).toBeGreaterThanOrEqual(0);
        expect(station.x - 0.4 + 2.0).toBeLessThanOrEqual(zone.width);
      }
    }
  });

  it('counts totals from the occupants it actually holds', () => {
    const floor = floorFrom(
      [event('a', 't1', 'running'), event('b', 't2', 'blocked'), event('c', 't3', 'needs_approval')],
      [worker('a', 'build_lead'), worker('b', 'reviewer_gatekeeper'), worker('d', 'specialist_tool')],
    );
    const occupants = floor.zones.flatMap((zone) => zone.occupants);
    expect(floor.totals.occupants).toBe(occupants.length);
    expect(floor.totals.active).toBe(
      occupants.filter((occupant) => ANIMATED_ACTIVITIES.includes(occupant.activity)).length,
    );
    expect(floor.totals.blocked).toBe(occupants.filter((occupant) => occupant.activity === 'blocked').length);
    expect(floor.totals.awaitingFounder).toBe(
      occupants.filter((occupant) => occupant.activity === 'awaiting_founder').length,
    );
  });

  it('places registered workers by their role and unregistered ones on the Build Floor', () => {
    const floor = floorFrom(
      [event('unknown-one', 't1', 'running')],
      [worker('rev', 'reviewer_gatekeeper'), worker('dir', 'mission_director')],
    );
    const zoneOf = (id: string) =>
      floor.zones.find((zone) => zone.occupants.some((occupant) => occupant.id === id))!.zone.id;
    expect(zoneOf('rev')).toBe('review-vault');
    expect(zoneOf('dir')).toBe('command-deck');
    expect(zoneOf('unknown-one')).toBe('build-floor');
  });

  it('sorts occupants deterministically so renders do not churn', () => {
    const specialists = [worker('z', 'build_lead'), worker('a', 'build_lead')];
    expect(floorOccupants(specialists, []).map((occupant) => occupant.id)).toEqual(['a', 'z']);
  });
});

/* ------------------------------------------------------------------ */
/* 7. The page in the site                                             */
/* ------------------------------------------------------------------ */

describe('the Headquarters Floor page joins the site under its rules', () => {
  const site = buildSite(sample);
  const html = site.get('headquarters.html')!;

  it('is rendered and reachable from every other page', () => {
    expect(html).toContain('JENIFY HQ — Headquarters Floor');
    for (const [file, page] of site) {
      expect(page, `${file} does not link the floor`).toContain('href="headquarters.html"');
    }
  });

  it('carries a drill-down panel for every room the scene links to', () => {
    const linked = [...html.matchAll(/href="#room-([a-z-]+)"/g)].map((match) => match[1]);
    expect(new Set(linked).size).toBe(HQ_FLOOR.length);
    for (const id of new Set(linked)) expect(html).toContain(`id="room-${id}"`);
  });

  it('states the motion vocabulary on the page rather than leaving it implicit', () => {
    expect(html).toContain('WHAT THE MOTION MEANS');
    expect(html).toContain('the stillness IS the finding');
    expect(html).toContain('Nothing on this floor is animated for effect');
  });

  it('offers no control that could mutate anything', () => {
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toMatch(/\son(click|submit|load|error|mouseover)=/);
  });

  it('lets the plan scroll inside its own frame instead of widening the page', () => {
    expect(html).toContain('class="hq-viewport"');
    expect(html).toContain('tabindex="0"');
    expect(THEME_CSS).toContain('.hq-viewport {');
    expect(THEME_CSS).toMatch(/\.hq-viewport \{[^}]*overflow: auto;/);
    expect(THEME_CSS).not.toMatch(/\.hq-scene \{[^}]*min-width: \d+px/);
  });

  // Distinct ids on purpose. `connectionWithState` reuses CONNECTION_CATALOG[0],
  // so two calls produce two connections sharing one id — the panel lookup
  // below then matches the first and compares it against the second's state,
  // failing for a reason that has nothing to do with the product.
  const PANEL_PROBE_CONNECTIONS = [
    { ...connectionWithState('error'), id: 'probe-error', displayName: 'PROBE ERROR' },
    { ...connectionWithState('connected'), id: 'probe-live', displayName: 'PROBE LIVE' },
  ];

  it('makes the room panel and the plan agree about every station', () => {
    // Two surfaces, one truth — the shape of every finding on this PR so far.
    // `page.ts` and `scene.ts` each read the same FloorState, so they could
    // drift without either being individually wrong: a fixture drawn lit on
    // the plan and listed unlit in the panel would be two defensible renders
    // of one state and a contradiction to the reader.
    //
    // Checked against the state, not against each other, so a shared error
    // cannot satisfy it.
    const floor = floorState({
      states: latestTaskStates(sample.events),
      dashboard: founderDashboard(latestTaskStates(sample.events), sample.todayUtcDate),
      workers: workerStatuses(latestTaskStates(sample.events)),
      specialists: sample.specialists,
      projects: projectBoard(latestTaskStates(sample.events)),
      approvals: sample.approvals,
      connections: PANEL_PROBE_CONNECTIONS,
      archive: sample.archive,
      chatMessages: sample.chatMessages,
    });
    const scene = renderScene(floor);
    const page = buildSite({ ...sample, connections: PANEL_PROBE_CONNECTIONS }).get('headquarters.html')!;

    for (const zone of floor.zones) {
      for (const occupant of zone.occupants) {
        // The panel lists EVERY occupant, seated or not — nothing is dropped
        // from the data just because the room ran out of desks.
        const entry = page.match(
          new RegExp(`<li class="hq-occupant" data-worker="${occupant.id}" data-activity="([a-z_]+)"`),
        );
        expect(entry, `${occupant.id} is missing from the ${zone.zone.id} panel`).not.toBeNull();
        expect(entry![1], `${occupant.id}: panel and state disagree about activity`).toBe(occupant.activity);
      }

      for (const fixture of zone.fixtures) {
        const entry = page.match(new RegExp(`<li class="hq-fixture" data-fixture="${fixture.id}" data-lit="(yes|no)"`));
        expect(entry, `${fixture.id} is missing from the ${zone.zone.id} panel`).not.toBeNull();
        expect(entry![1] === 'yes', `${fixture.id}: panel and state disagree about lit`).toBe(fixture.lit);

        if (fixture.stationId === null) continue;
        const station = scene
          .split('<g class="hq-station"')
          .find((fragment) => fragment.includes(`data-station="${fixture.stationId}"`))!;
        expect(station.includes('is-lit'), `${fixture.id}: plan and state disagree about lit`).toBe(fixture.lit);
        expect(
          station.includes('data-attention="yes"'),
          `${fixture.id}: plan and state disagree about attention`,
        ).toBe(fixture.tone === 'warn' || fixture.tone === 'danger');
      }
    }
  });

  it('gives the least-exercised rooms real content and real evidence', () => {
    // archive-stacks and situation-room are fed by inputs every other test in
    // this file leaves empty, so their fixtures have had the least scrutiny
    // of the eight rooms.
    const states = latestTaskStates(sample.events);
    const floor = floorState({
      states,
      dashboard: founderDashboard(states, sample.todayUtcDate),
      workers: workerStatuses(states),
      specialists: sample.specialists,
      projects: projectBoard(states),
      approvals: sample.approvals,
      connections: [],
      archive: sample.archive,
      chatMessages: sample.chatMessages,
    });

    const stacks = floor.zones.find((zone) => zone.zone.id === 'archive-stacks')!;
    expect(stacks.fixtures.length).toBeGreaterThan(0);
    for (const fixture of stacks.fixtures) {
      expect(fixture.stationId, `${fixture.id} unseated`).not.toBeNull();
      // Archive records are reconstructed documentation, never live evidence,
      // so a stack is never lit whatever the archive holds.
      expect(fixture.lit, 'an archive stack must never be drawn as live').toBe(false);
      expect(fixture.evidence.length).toBeGreaterThan(20);
    }
    expect(stacks.fixtures[0].detail).toMatch(/\d+ record/);

    const situation = floor.zones.find((zone) => zone.zone.id === 'situation-room')!;
    for (const fixture of situation.fixtures) {
      expect(fixture.stationId, `${fixture.id} unseated`).not.toBeNull();
      // A transcript is a record, never a live meeting.
      expect(fixture.lit, 'a transcript must never be drawn as live').toBe(false);
      expect(fixture.evidence).toMatch(/record|no Executive Room message/);
    }
  });

  it('renders reproducibly', () => {
    expect(buildSite(sample).get('headquarters.html')).toBe(html);
  });

  it('publishes no observed credential value, even one that reached a probe reason', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const env = Object.fromEntries(
      CONNECTION_CATALOG.flatMap((descriptor) => descriptor.requiredFacts).map((fact) => [fact, secret]),
    );
    const loaded = buildSite({ ...sample, env }).get('headquarters.html')!;
    expect(loaded).not.toContain(secret);
    expect(loaded).not.toContain('ghp_');
  });
});
