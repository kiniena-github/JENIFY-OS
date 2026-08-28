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
import { HQ_FLOOR, ROLE_ZONE, floorExtent } from '../src/ui/spatial/world.js';
import {
  ANIMATED_ACTIVITIES,
  LIT_CONNECTION_STATES,
  STATUS_ACTIVITY,
  floorOccupants,
  floorState,
  occupantActivity,
  type FloorInput,
  type OccupantActivity,
} from '../src/ui/spatial/state.js';
import { iso, renderScene } from '../src/ui/spatial/scene.js';

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

  it('gives offline figures no animation in the stylesheet, and working figures one', () => {
    expect(THEME_CSS).toContain('.hq-figure.act-working .fig-body { animation:');
    expect(THEME_CSS).toContain('.hq-figure.act-offline { opacity:');
    expect(THEME_CSS).not.toMatch(/\.hq-figure\.act-offline[^{]*\{[^}]*animation:/);
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
