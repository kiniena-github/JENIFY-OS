/**
 * The isometric renderer for the living Headquarters (issue #200, spatial HQ).
 *
 * Pure string in / SVG string out, exactly like the rest of this UI layer: no
 * DOM, no framework, no external asset, no network request, no randomness.
 * The same `FloorState` always produces byte-identical SVG, which is what lets
 * the site stay reproducible and lets the truth tests assert on the markup.
 *
 * Everything drawn here is a primitive that composes:
 *
 *   iso()      floor units → screen units, one projection for the whole scene
 *   box()      an extruded cuboid — every desk, pillar, plinth and bench
 *   slab()     a room floor with visible thickness
 *   figure()   a worker at a station
 *
 * The renderer decides NOTHING about liveness. It reads `lit`, `activity` and
 * `liveness` off the state it is handed and turns them into classes; whether
 * those values are honest is settled in `state.ts`.
 */

import { escapeHtml } from '../components.js';
import { floorExtent, type Station, type Zone } from './world.js';
import { ANIMATED_ACTIVITIES, type Fixture, type FloorState, type Occupant, type ZoneState } from './state.js';

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/** cos(30°) and sin(30°) — a true 2:1-ish isometric, not a fake skew. */
const ISO_X = 0.8660254037844387;
const ISO_Y = 0.5;

/** Rounded so the emitted path data is stable across platforms. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface Point {
  sx: number;
  sy: number;
}

/** Floor units (x east, y south, z up) → screen units. */
export function iso(x: number, y: number, z = 0): Point {
  return { sx: round((x - y) * ISO_X), sy: round((x + y) * ISO_Y - z) };
}

function polygon(points: Point[], className: string): string {
  const data = points.map((point) => `${point.sx},${point.sy}`).join(' ');
  return `<polygon class="${className}" points="${data}"/>`;
}

/**
 * An extruded cuboid standing on the floor: top face plus the two faces the
 * viewer can see. The three faces carry different classes so the stylesheet
 * can light them differently — that shading IS the depth cue, so it is drawn
 * rather than filtered.
 */
export function box(
  x: number,
  y: number,
  width: number,
  depth: number,
  height: number,
  className: string,
): string {
  const top = polygon(
    [iso(x, y, height), iso(x + width, y, height), iso(x + width, y + depth, height), iso(x, y + depth, height)],
    `${className} face-top`,
  );
  const east = polygon(
    [iso(x + width, y, height), iso(x + width, y + depth, height), iso(x + width, y + depth), iso(x + width, y)],
    `${className} face-east`,
  );
  const south = polygon(
    [iso(x, y + depth, height), iso(x + width, y + depth, height), iso(x + width, y + depth), iso(x, y + depth)],
    `${className} face-south`,
  );
  return `${top}${east}${south}`;
}

/** A room floor with visible thickness below it. */
function slab(zone: Zone): string {
  const { x, y, width, depth } = zone;
  const thickness = 0.34;
  const top = polygon(
    [iso(x, y), iso(x + width, y), iso(x + width, y + depth), iso(x, y + depth)],
    'zone-floor face-top',
  );
  const east = polygon(
    [iso(x + width, y), iso(x + width, y + depth), iso(x + width, y + depth, -thickness), iso(x + width, y, -thickness)],
    'zone-floor face-east',
  );
  const south = polygon(
    [iso(x, y + depth), iso(x + width, y + depth), iso(x + width, y + depth, -thickness), iso(x, y + depth, -thickness)],
    'zone-floor face-south',
  );
  return `${top}${east}${south}`;
}

/** The two low back walls that give a room its enclosure. */
function walls(zone: Zone): string {
  const { x, y, width, depth } = zone;
  const height = 1.15;
  const north = polygon(
    [iso(x, y, height), iso(x + width, y, height), iso(x + width, y), iso(x, y)],
    'zone-wall wall-north',
  );
  const west = polygon(
    [iso(x, y, height), iso(x, y + depth, height), iso(x, y + depth), iso(x, y)],
    'zone-wall wall-west',
  );
  return `${west}${north}`;
}

/** Faint floor lines inside a room — the technical-blueprint texture. */
function floorGrid(zone: Zone): string {
  const lines: string[] = [];
  for (let step = 1; step < zone.width; step += 1) {
    const a = iso(zone.x + step, zone.y);
    const b = iso(zone.x + step, zone.y + zone.depth);
    lines.push(`<line class="zone-grid" x1="${a.sx}" y1="${a.sy}" x2="${b.sx}" y2="${b.sy}"/>`);
  }
  for (let step = 1; step < zone.depth; step += 1) {
    const a = iso(zone.x, zone.y + step);
    const b = iso(zone.x + zone.width, zone.y + step);
    lines.push(`<line class="zone-grid" x1="${a.sx}" y1="${a.sy}" x2="${b.sx}" y2="${b.sy}"/>`);
  }
  return lines.join('');
}

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

/**
 * A monitor face. The glass is a separate polygon so a lit screen is one
 * class change, and so an UNLIT screen is visibly dark glass rather than a
 * missing object — an absent monitor would read as "no workstation here",
 * which is a different and untrue statement.
 */
function screenFace(x: number, y: number, facing: Station['facing'], lit: boolean): string {
  const glass = lit ? 'prop-screen is-lit' : 'prop-screen';
  if (facing === 'east') {
    return polygon(
      [iso(x + 0.06, y + 0.1, 1.0), iso(x + 0.06, y + 0.62, 1.0), iso(x + 0.06, y + 0.62, 0.52), iso(x + 0.06, y + 0.1, 0.52)],
      glass,
    );
  }
  return polygon(
    [iso(x + 0.1, y + 0.66, 1.0), iso(x + 0.62, y + 0.66, 1.0), iso(x + 0.62, y + 0.66, 0.52), iso(x + 0.1, y + 0.66, 0.52)],
    glass,
  );
}

function deskProp(station: Station, zone: Zone, lit: boolean): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-desk">${chair(x, y, station.facing)}${box(x, y, 0.72, 0.72, 0.45, 'prop-body')}${box(
    x + 0.06,
    y + 0.58,
    0.6,
    0.06,
    0.55,
    'prop-monitor',
  )}${screenFace(x, y, station.facing, lit)}</g>`;
}

function reviewBayProp(station: Station, zone: Zone, lit: boolean): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-bay-booth">${chair(x, y, 'east')}${box(x, y, 0.78, 0.9, 0.42, 'prop-body')}${box(
    x - 0.06,
    y,
    0.06,
    0.9,
    1.25,
    'prop-partition',
  )}${screenFace(x, y, 'east', lit)}</g>`;
}

function consoleProp(station: Station, zone: Zone, lit: boolean): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-console">${box(x, y, 1.0, 0.5, 0.4, 'prop-body')}${box(
    x,
    y + 0.42,
    1.0,
    0.06,
    0.95,
    'prop-monitor',
  )}${polygon(
    [iso(x + 0.08, y + 0.48, 1.28), iso(x + 0.92, y + 0.48, 1.28), iso(x + 0.92, y + 0.48, 0.5), iso(x + 0.08, y + 0.48, 0.5)],
    lit ? 'prop-screen is-lit' : 'prop-screen',
  )}</g>`;
}

function benchProp(station: Station, zone: Zone, lit: boolean): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-bench">${box(x - 0.4, y, 2.0, 0.8, 0.5, 'prop-body')}${box(
    x + 0.4,
    y + 0.2,
    0.4,
    0.4,
    0.9,
    lit ? 'prop-beacon is-lit' : 'prop-beacon',
  )}</g>`;
}

function bayProp(station: Station, zone: Zone, lit: boolean): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-plinth">${box(x, y, 0.8, 0.8, 0.28, 'prop-body')}${box(
    x + 0.22,
    y + 0.22,
    0.36,
    0.36,
    0.75,
    lit ? 'prop-beacon is-lit' : 'prop-beacon',
  )}</g>`;
}

function uplinkProp(station: Station, zone: Zone, lit: boolean): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-uplink">${box(x + 0.15, y + 0.15, 0.45, 0.45, 1.5, 'prop-body')}${box(
    x + 0.1,
    y + 0.1,
    0.55,
    0.55,
    1.72,
    lit ? 'prop-lamp is-lit' : 'prop-lamp',
  )}</g>`;
}

function stackProp(station: Station, zone: Zone): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-stack">${box(x, y, 0.8, 1.0, 0.3, 'prop-body')}${box(
    x + 0.05,
    y + 0.05,
    0.7,
    0.9,
    0.62,
    'prop-body',
  )}${box(x + 0.1, y + 0.1, 0.6, 0.8, 0.9, 'prop-body')}</g>`;
}

function tableProp(station: Station, zone: Zone): string {
  const x = zone.x + station.x;
  const y = zone.y + station.y;
  return `<g class="prop prop-table">${box(x - 0.6, y, 2.4, 1.4, 0.42, 'prop-body')}</g>`;
}

function prop(station: Station, zone: Zone, lit: boolean): string {
  switch (station.kind) {
    case 'desk':
      return deskProp(station, zone, lit);
    case 'review_bay':
      return reviewBayProp(station, zone, lit);
    case 'console':
      return consoleProp(station, zone, lit);
    case 'bench':
      return benchProp(station, zone, lit);
    case 'bay':
      return bayProp(station, zone, lit);
    case 'uplink':
      return uplinkProp(station, zone, lit);
    case 'stack':
      return stackProp(station, zone);
    case 'table':
      return tableProp(station, zone);
  }
}

/* ------------------------------------------------------------------ */
/* Figures                                                             */
/* ------------------------------------------------------------------ */

/**
 * A worker standing at their station.
 *
 * The activity class is the only thing that varies, and the stylesheet gives
 * exactly the animated activities motion. An `offline` figure is drawn dimmed
 * and perfectly still: the absence of motion is the honest signal, so it is
 * never decorated to look busy.
 */
function figure(occupant: Occupant, station: Station, zone: Zone): string {
  const x = zone.x + station.x + (station.facing === 'east' ? 0.95 : 0.18);
  const y = zone.y + station.y + (station.facing === 'east' ? 0.15 : -0.62);
  const head = iso(x + 0.19, y + 0.19, 1.18);
  const shadow = iso(x + 0.19, y + 0.19);
  return `<g class="hq-figure act-${occupant.activity}" data-worker="${escapeHtml(occupant.id)}">
<ellipse class="fig-shadow" cx="${shadow.sx}" cy="${shadow.sy}" rx="0.34" ry="0.17"/>
<g class="fig-body">${box(x, y, 0.38, 0.38, 0.98, 'fig-torso')}<circle class="fig-head" cx="${head.sx}" cy="${head.sy}" r="0.23"/></g>
</g>`;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

/**
 * Painter's-algorithm depth order.
 *
 * In this projection screen depth increases with `x + y`, so painting in
 * ascending `x + y` puts nearer objects over farther ones. Ties break on `x`
 * so the order is total and the output stays deterministic.
 */
function depthKey(x: number, y: number): number {
  return x + y + x * 1e-6;
}

/**
 * Room nameplates, drawn as one layer ON TOP of the whole plan.
 *
 * Two things go wrong with the obvious placements, and this function is the
 * shape that avoids both:
 *
 *   · A plate emitted inside its own room's group is overpainted by every
 *     nearer room, because rooms are painted in depth order. BUILD FLOOR
 *     landed under the Review Vault that way. So all plates are hoisted into
 *     one layer drawn after the entire plan.
 *   · A plate standing in the gutter OUTSIDE its room still lands on a
 *     neighbour: the gutter is 1.4 floor units, but a plate is several units
 *     wide in screen space, so it reaches across the diagonal into the room
 *     down-left of it. So each plate is anchored INSIDE its own footprint,
 *     low and centred, where the room's own floor is clear of furniture.
 *
 * The layer is `aria-hidden`: each room's name is already the accessible name
 * of the room link and the heading of its panel, so announcing it a third time
 * would be noise.
 */
function zoneLabels(floor: FloorState): string {
  const plates = floor.zones
    .map(({ zone }) => {
      // Anchored just behind the room's centre. A room is a diamond on
      // screen, so it is WIDEST at its centre: the longest name only fits
      // there. Placed at the front corner instead, "INDEPENDENT REVIEW
      // VAULT" overhung its own floor onto the room below.
      const anchor = iso(zone.x + zone.width / 2, zone.y + zone.depth / 2 - 0.6);
      const text = zone.name.toUpperCase();
      // Sized from the string so the backing plate always fits the name.
      const halfWidth = round(text.length * 0.148 + 0.34);
      return `<g class="zone-plate">
<rect class="zone-plate-bg" x="${round(anchor.sx - halfWidth)}" y="${round(anchor.sy - 0.42)}" width="${round(
        halfWidth * 2,
      )}" height="0.62" rx="0.14"/>
<text class="zone-name" x="${anchor.sx}" y="${anchor.sy}" text-anchor="middle">${escapeHtml(text)}</text>
</g>`;
    })
    .join('');
  return `<g class="hq-nameplates" aria-hidden="true">${plates}</g>`;
}

/**
 * A thin lit strip along each room's north wall. Purely architectural: it
 * gives a room a sense of enclosure and scale, and it carries no state.
 */
function wallLight(zone: Zone): string {
  return polygon(
    [
      iso(zone.x + 0.25, zone.y + 0.06, 0.92),
      iso(zone.x + zone.width - 0.25, zone.y + 0.06, 0.92),
      iso(zone.x + zone.width - 0.25, zone.y + 0.06, 0.78),
      iso(zone.x + 0.25, zone.y + 0.06, 0.78),
    ],
    'zone-striplight',
  );
}

/** A seat behind a workstation, so a desk reads as a place someone works. */
function chair(x: number, y: number, facing: Station['facing']): string {
  const cx = facing === 'east' ? x + 0.92 : x + 0.14;
  const cy = facing === 'east' ? y + 0.14 : y - 0.62;
  return `${box(cx, cy, 0.34, 0.34, 0.24, 'prop-chair')}${box(
    facing === 'east' ? cx + 0.28 : cx,
    facing === 'east' ? cy : cy - 0.06,
    facing === 'east' ? 0.06 : 0.34,
    facing === 'east' ? 0.34 : 0.06,
    0.62,
    'prop-chair',
  )}`;
}

function renderZone(zoneState: ZoneState): string {
  const { zone } = zoneState;
  const occupantByStation = new Map(
    zoneState.occupants.filter((occupant) => occupant.stationId).map((occupant) => [occupant.stationId!, occupant]),
  );
  const fixtureByStation = new Map(
    zoneState.fixtures.filter((fixture) => fixture.stationId).map((fixture) => [fixture.stationId!, fixture]),
  );

  const drawn = [...zone.stations]
    .sort((a, b) => depthKey(a.x, a.y) - depthKey(b.x, b.y))
    .map((station) => {
      const occupant = occupantByStation.get(station.id) ?? null;
      const fixture = fixtureByStation.get(station.id) ?? null;
      const lit = occupant
        ? ANIMATED_ACTIVITIES.includes(occupant.activity)
        : fixture
          ? fixture.lit
          : false;
      const tone = fixture ? ` data-tone="${escapeHtml(fixture.tone)}"` : '';
      const label = occupant
        ? `${occupant.displayName}, ${occupant.activity}`
        : fixture
          ? `${fixture.label}, ${fixture.detail}`
          : `empty ${station.kind.replaceAll('_', ' ')}`;
      return `<g class="hq-station" data-station="${escapeHtml(station.id)}" data-occupied="${
        occupant ? 'worker' : fixture ? 'fixture' : 'empty'
      }"${tone}><title>${escapeHtml(label)}</title>${prop(station, zone, lit)}${
        occupant ? figure(occupant, station, zone) : ''
      }</g>`;
    })
    .join('');

  // The whole room is one link: it is the room the Founder clicks, and a link
  // is focusable and reachable by keyboard without any script.
  return `<a class="hq-zone" href="#room-${escapeHtml(zone.id)}" data-zone="${escapeHtml(
    zone.id,
  )}" data-liveness="${escapeHtml(zoneState.liveness)}" aria-label="${escapeHtml(
    `${zone.name} — ${zoneState.summary}. Open room detail.`,
  )}">
${slab(zone)}${floorGrid(zone)}${walls(zone)}${wallLight(zone)}${drawn}
</a>`;
}

/**
 * The whole floor as one SVG.
 *
 * `preserveAspectRatio` keeps the plan undistorted; the element is sized by
 * the stylesheet, and the scrollable canvas around it is what makes a
 * 20-unit-wide floor usable at 320 px without the PAGE ever scrolling
 * sideways.
 */
export function renderScene(floor: FloorState): string {
  const extent = floorExtent();
  const halfWidth = round(extent.width * ISO_X) + 2.4;
  const minY = -2.4;
  const height = round(extent.depth * 2 * ISO_Y) + 3.6;
  const viewBox = `${-halfWidth} ${minY} ${round(halfWidth * 2)} ${height}`;

  const zones = [...floor.zones]
    .sort((a, b) => depthKey(a.zone.x, a.zone.y) - depthKey(b.zone.x, b.zone.y))
    .map(renderZone)
    .join('\n');

  const description =
    `Isometric plan of the JENIFY headquarters: ${floor.zones.length} rooms, ` +
    `${floor.totals.occupants} worker(s) of which ${floor.totals.active} active, ` +
    `${floor.totals.blocked} blocked, ${floor.totals.awaitingFounder} waiting on the Founder, ` +
    `${floor.totals.offline} offline, and ${floor.totals.litUplinks} of ${floor.totals.uplinks} service uplinks lit.`;

  return `<svg class="hq-scene" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(
    description,
  )}">
<g class="hq-floorplan">
${zones}
</g>
${zoneLabels(floor)}
</svg>`;
}
