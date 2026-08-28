/**
 * The JENIFY HQ floor plan — the spatial vocabulary the living Headquarters
 * is drawn from (issue #200, spatial HQ mission).
 *
 * This module is pure geometry and naming. It holds no state, reads no data
 * and makes no claim about anything being live: it answers only "what rooms
 * does this headquarters have, where are they, and what furniture stands in
 * them". Everything that could be untrue — who is at a desk, whether a screen
 * is lit, whether an uplink is connected — is decided in `state.ts` from
 * canonical data and nowhere else.
 *
 * The plan is ORIGINAL. It is derived from the real JENIFY operating model
 * (mission control, parallel builders, an independent review lane, a Founder
 * approval gate, project work, service uplinks, an evidence archive, and a
 * place to meet) rather than from any referenced artwork or layout.
 *
 * Coordinates are abstract floor units on a flat grid; the isometric
 * projection that turns them into screen space lives in `scene.ts`, so the
 * plan can be re-projected (or re-laid-out) without touching the renderer.
 */

import type { WorkerRole } from '../../contracts/workers.js';

/** What a zone is FOR. Drives its furniture, not its liveness. */
export type ZoneKind =
  | 'command'
  | 'build'
  | 'review'
  | 'founder'
  | 'projects'
  | 'uplinks'
  | 'archive'
  | 'meeting';

/** A piece of furniture an occupant or an artefact can be placed at. */
export type StationKind =
  | 'console' // mission-control console — screens, no seat
  | 'desk' // a working desk with a monitor
  | 'review_bay' // an isolated review booth
  | 'bench' // the Founder approval bench
  | 'bay' // a project bay plinth
  | 'uplink' // a service uplink pillar
  | 'stack' // an archive evidence stack
  | 'table'; // the situation-room table

export interface Station {
  id: string;
  kind: StationKind;
  /** Position within the zone, in floor units from the zone origin. */
  x: number;
  y: number;
  /** Facing, used only to orient the monitor face. */
  facing: 'north' | 'east';
}

export interface Zone {
  id: string;
  /** Room name shown on the floor and as the drill-down heading. */
  name: string;
  kind: ZoneKind;
  /** One sentence: what happens in this room. Never a status claim. */
  purpose: string;
  /** Zone origin on the floor grid, in floor units. */
  x: number;
  y: number;
  /** Zone footprint, in floor units. */
  width: number;
  depth: number;
  stations: Station[];
}

/** Zone footprint and the gutter between zones, in floor units. */
const ZONE_SPAN = 6;
const ZONE_GUTTER = 1.4;

function origin(column: number, row: number): { x: number; y: number } {
  return { x: column * (ZONE_SPAN + ZONE_GUTTER), y: row * (ZONE_SPAN + ZONE_GUTTER) };
}

/**
 * Lay `count` stations out along the zone floor in a stable reading order:
 * left-to-right, then front-to-back. Deterministic, so the same floor plan
 * always renders byte-identically.
 */
function row(zoneId: string, kind: StationKind, count: number, atY: number, facing: Station['facing']): Station[] {
  const stations: Station[] = [];
  const step = (ZONE_SPAN - 1.6) / Math.max(1, count - 1 || 1);
  for (let index = 0; index < count; index += 1) {
    stations.push({
      id: `${zoneId}-${kind}-${index + 1}`,
      kind,
      x: count === 1 ? ZONE_SPAN / 2 - 0.4 : 0.8 + index * step,
      y: atY,
      facing,
    });
  }
  return stations;
}

/**
 * The floor.
 *
 * Nine rooms would not fit a 320 px viewport legibly, and a plan nobody can
 * read is not a headquarters. Eight zones on a 3x3 plan with one open plaza
 * corner keeps every room reachable within one screen-height of panning.
 */
export const HQ_FLOOR: readonly Zone[] = [
  {
    id: 'command-deck',
    name: 'Command Deck',
    kind: 'command',
    purpose: 'Mission control. Direct Orders are composed here and every mission is dispatched from it.',
    ...origin(1, 0),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    stations: [...row('command-deck', 'console', 3, 1.4, 'north'), ...row('command-deck', 'desk', 2, 4.1, 'north')],
  },
  {
    id: 'review-vault',
    name: 'Independent Review Vault',
    kind: 'review',
    purpose: 'The independent review lane. Reviewers work in isolation from the builders whose work they judge.',
    ...origin(0, 0),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    stations: row('review-vault', 'review_bay', 4, 2.6, 'east'),
  },
  {
    id: 'founder-suite',
    name: 'Founder Suite',
    kind: 'founder',
    purpose: 'The approval gate. Work recorded as needing the Founder waits at this bench and moves no further.',
    ...origin(2, 0),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    // TWO benches, placed explicitly rather than with `row()`.
    //
    // The Founder Suite carries two distinct canonical claims — pending
    // approval REQUESTS, and tasks recorded as needs_approval — and with one
    // bench the second was left unseated. When nothing was pending but work
    // was gated, the unlit fixture took the only bench and the LIT one
    // vanished from the plan: a dark bench in a room whose whole purpose is
    // to show the Founder what is waiting on them (Codex review of
    // `9c0e354`, P2). Combining the two claims would have lost the
    // distinction, so the room gained the station it was short of.
    //
    // `row()` spaces stations across the full span, which would push the
    // second bench's 2.0-unit footprint past the room's edge; these two
    // positions keep both benches inside it.
    stations: [
      { id: 'founder-suite-bench-1', kind: 'bench', x: 0.7, y: 1.6, facing: 'north' },
      { id: 'founder-suite-bench-2', kind: 'bench', x: 3.2, y: 1.6, facing: 'north' },
      ...row('founder-suite', 'desk', 2, 4.2, 'north'),
    ],
  },
  {
    id: 'build-floor',
    name: 'Build Floor',
    kind: 'build',
    purpose: 'Where implementation happens. Build leads and parallel implementers hold their tasks here.',
    ...origin(0, 1),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    stations: [...row('build-floor', 'desk', 4, 1.5, 'north'), ...row('build-floor', 'desk', 4, 4.2, 'north')].map(
      (station, index) => ({ ...station, id: `build-floor-desk-${index + 1}` }),
    ),
  },
  {
    id: 'situation-room',
    name: 'Situation Room',
    kind: 'meeting',
    purpose: 'The shared table. The Executive Room transcript is the record of what was said here.',
    ...origin(1, 1),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    stations: row('situation-room', 'table', 1, 2.8, 'north'),
  },
  {
    id: 'project-bays',
    name: 'Project Bays',
    kind: 'projects',
    purpose: 'One bay per project on the board. A bay carries its own open, blocked and completed counts.',
    ...origin(2, 1),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    stations: [...row('project-bays', 'bay', 3, 1.5, 'north'), ...row('project-bays', 'bay', 3, 4.2, 'north')].map(
      (station, index) => ({ ...station, id: `project-bays-bay-${index + 1}` }),
    ),
  },
  {
    id: 'archive-stacks',
    name: 'Archive Stacks',
    kind: 'archive',
    purpose: 'Reconstructed evidence records, kept apart from the live floor because they are not original evidence.',
    ...origin(0, 2),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    stations: row('archive-stacks', 'stack', 4, 2.6, 'east'),
  },
  {
    id: 'uplink-gallery',
    name: 'Uplink Gallery',
    kind: 'uplinks',
    purpose: 'One pillar per external service. A pillar is lit only when verification evidence says so.',
    ...origin(1, 2),
    width: ZONE_SPAN,
    depth: ZONE_SPAN,
    stations: [...row('uplink-gallery', 'uplink', 4, 1.6, 'north'), ...row('uplink-gallery', 'uplink', 4, 4.2, 'north')].map(
      (station, index) => ({ ...station, id: `uplink-gallery-uplink-${index + 1}` }),
    ),
  },
];

export const ZONE_IDS = HQ_FLOOR.map((zone) => zone.id);

/** Total floor extent in floor units, used to size the scene's viewBox. */
export function floorExtent(): { width: number; depth: number } {
  let width = 0;
  let depth = 0;
  for (const zone of HQ_FLOOR) {
    width = Math.max(width, zone.x + zone.width);
    depth = Math.max(depth, zone.y + zone.depth);
  }
  return { width, depth };
}

export function zoneById(id: string): Zone | undefined {
  return HQ_FLOOR.find((zone) => zone.id === id);
}

/**
 * Which room a worker stands in, from the ONE canonical fact available about
 * them: their registered role. This is placement, never permission — a worker
 * drawn in the Review Vault has exactly the capabilities the registry grants
 * it and no others.
 */
export const ROLE_ZONE: Record<WorkerRole, string> = {
  mission_director: 'command-deck',
  build_lead: 'build-floor',
  parallel_implementer: 'build-floor',
  reviewer_gatekeeper: 'review-vault',
  specialist_tool: 'build-floor',
};

/**
 * Where a worker with no registry entry stands.
 *
 * Such workers exist: the event log can name an actor the specialist
 * directory has never registered. They are placed on the Build Floor and
 * labelled as unregistered rather than hidden, because hiding recorded
 * activity would make the floor less true than the log it is drawn from.
 */
export const UNREGISTERED_ZONE = 'build-floor';
