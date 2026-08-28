/**
 * The Headquarters Floor page body (issue #200, spatial HQ mission).
 *
 * Composes the isometric scene with the drill-down panels that make it
 * operable rather than decorative. The page shell (nav, provenance chips,
 * freshness indicator) is applied by `render.ts`, so this file emits only the
 * main content.
 *
 * The panels are ALWAYS rendered, not revealed by script: every room's detail
 * is in the document, the scene links to it by fragment, and `:target` merely
 * highlights it. That keeps the floor fully usable with scripting off, with a
 * screen reader, and in a printed page — and it means the scene can never show
 * a state whose supporting evidence is missing from the page.
 */

import type { WorkerDescriptor } from '../../contracts/workers.js';
import {
  chip,
  emptyState,
  escapeHtml,
  identity,
  kpiRow,
  relativeAge,
  section,
  statusChip,
  type Tone,
} from '../components.js';
import { renderScene } from './scene.js';
import {
  ACTIVITY_PRESENTATION,
  LIVENESS_PRESENTATION,
  type Fixture,
  type FloorState,
  type Occupant,
  type ZoneState,
} from './state.js';

/**
 * What the floor's motion vocabulary means, stated on the page itself.
 *
 * A spatial UI is a claim-making surface: a moving figure asserts that
 * something is happening. Spelling the mapping out is what keeps that claim
 * checkable by the person reading it, and the last line is the one that
 * matters most — stillness here is evidence, not decoration.
 */
export const MOTION_LEGEND: readonly { activity: string; means: string }[] = [
  { activity: 'Working', means: 'a task held by this worker is recorded assigned or running' },
  { activity: 'In review', means: 'a task held by this worker is recorded review_passed or review_failed' },
  { activity: 'Waiting on Founder', means: 'a task is recorded needs_approval and can move no further' },
  { activity: 'Blocked', means: 'a task is recorded blocked or outcome_unknown' },
  { activity: 'Queued', means: 'a task is recorded queued — accepted and not started, so the figure is still' },
  { activity: 'Last task completed', means: 'the most recent recorded outcome was a completion; nothing is active' },
  {
    activity: 'Offline',
    // This line used to read "no canonical event places this worker on any
    // task — the stillness IS the finding". That is false for one supported
    // state: a specialist the registry marks INACTIVE is offline here even
    // when the log shows it running, because an inactive entry may hold no
    // work. The legend asserted a universal the code does not honour, so it
    // now states both routes and each occupant's own evidence says which one
    // applies to it (Codex review of `5cba822`).
    means:
      'either no canonical event places this worker on a task, or the registry marks it inactive — each figure’s evidence says which',
  },
];

export const FLOOR_HONESTY_NOTE =
  'Nothing on this floor is animated for effect. A figure moves only while a canonical activity event says its ' +
  'task is active, a screen is lit only for the same reason, and an uplink pillar is lit only when connection ' +
  'evidence reports a verified or local-only connection — configuration alone leaves it dark. Rooms with no ' +
  'canonical data are drawn empty rather than populated with plausible-looking staff.';

function activityChip(occupant: Occupant): string {
  const presentation = ACTIVITY_PRESENTATION[occupant.activity];
  return chip(presentation.label, presentation.tone, true);
}

function occupantItem(occupant: Occupant): string {
  const seat = occupant.stationId
    ? `at ${escapeHtml(occupant.stationId)}`
    : 'no station drawn — the room has fewer stations than workers assigned to it';
  return `<li class="hq-occupant" data-worker="${escapeHtml(occupant.id)}" data-activity="${escapeHtml(
    occupant.activity,
  )}">
<div class="row">${identity(occupant.id, occupant.displayName, occupant.subtitle, true)}${activityChip(occupant)}${
    occupant.registered ? '' : chip('Unregistered', 'warn')
  }</div>
<p class="faint">${escapeHtml(occupant.evidence)}</p>
${
  occupant.task
    ? `<p class="row">${statusChip(occupant.task.status)}${chip(occupant.task.project, 'neutral')}<span class="faint">${escapeHtml(
        occupant.task.title,
      )}</span></p>`
    : ''
}
<p class="faint">${escapeHtml(seat)}</p>
</li>`;
}

function fixtureItem(fixture: Fixture): string {
  return `<li class="hq-fixture" data-fixture="${escapeHtml(fixture.id)}" data-lit="${fixture.lit ? 'yes' : 'no'}">
<div class="row"><b>${escapeHtml(fixture.label)}</b>${chip(fixture.detail, fixture.tone)}${chip(
    fixture.lit ? 'Lit' : 'Unlit',
    fixture.lit ? 'accent' : 'neutral',
    true,
  )}</div>
<p class="faint">${escapeHtml(fixture.evidence)}</p>
</li>`;
}

function roomPanel(zoneState: ZoneState, nowIso: string): string {
  const presentation = LIVENESS_PRESENTATION[zoneState.liveness];
  const occupants =
    zoneState.occupants.length > 0
      ? `<ul class="hq-occupants">${zoneState.occupants.map(occupantItem).join('\n')}</ul>`
      : emptyState('No worker is placed in this room by canonical data.');
  const fixtures =
    zoneState.fixtures.length > 0
      ? `<ul class="hq-occupants">${zoneState.fixtures.map(fixtureItem).join('\n')}</ul>`
      : '';
  const newest = zoneState.occupants
    .map((occupant) => occupant.task?.updatedAt)
    .filter((stamp): stamp is string => typeof stamp === 'string')
    .sort()
    .at(-1);
  return `<section class="hq-room" id="room-${escapeHtml(zoneState.zone.id)}" data-liveness="${escapeHtml(
    zoneState.liveness,
  )}" aria-labelledby="room-${escapeHtml(zoneState.zone.id)}-name">
<h3 id="room-${escapeHtml(zoneState.zone.id)}-name">${escapeHtml(zoneState.zone.name)}</h3>
<p class="row">${chip(presentation.label, presentation.tone, true)}${
    newest ? chip(`Latest task update ${relativeAge(newest, nowIso)}`, 'neutral') : ''
  }</p>
<p class="lede">${escapeHtml(zoneState.zone.purpose)}</p>
<p class="faint">${escapeHtml(zoneState.summary)}</p>
${occupants}
${fixtures}
${
  zoneState.drillDown
    ? `<p><a href="${escapeHtml(zoneState.drillDown.href)}">${escapeHtml(zoneState.drillDown.label)} →</a></p>`
    : ''
}
<p class="faint"><a href="#hq-floor">Back to the floor ↑</a></p>
</section>`;
}

export interface FloorPageInput {
  floor: FloorState;
  nowIso: string;
  /** The registry, used only for the room-capacity note. */
  specialists: readonly WorkerDescriptor[];
}

export function spatialFloorBody({ floor, nowIso }: FloorPageInput): string {
  const { totals } = floor;
  const attentionTone: Tone = totals.blocked + totals.awaitingFounder > 0 ? 'warn' : 'accent';

  const kpis = kpiRow([
    {
      label: 'Workers on the floor',
      value: totals.occupants,
      hint: 'registered specialists plus every worker the activity log names',
      tone: 'neutral',
    },
    {
      label: 'Active now',
      value: totals.active,
      hint: 'holding a task recorded as active — the only figures in motion',
      tone: totals.active > 0 ? 'info' : 'neutral',
    },
    {
      label: 'Needing attention',
      value: totals.blocked + totals.awaitingFounder,
      hint: `${totals.blocked} blocked · ${totals.awaitingFounder} waiting on the Founder`,
      tone: attentionTone,
    },
    {
      label: 'Dark on the floor',
      value: totals.offline,
      hint: 'no task recorded, or the registry marks them inactive',
      tone: 'neutral',
    },
    {
      label: 'Uplinks lit',
      value: `${totals.litUplinks} / ${totals.uplinks}`,
      hint: 'verified or local-only connections; configured-but-unverified stays dark',
      tone: totals.litUplinks > 0 ? 'accent' : 'neutral',
    },
  ]);

  const legend = `<ul class="hq-legend">${MOTION_LEGEND.map(
    (entry) =>
      `<li><b>${escapeHtml(entry.activity)}</b><span class="faint">${escapeHtml(entry.means)}</span></li>`,
  ).join('')}</ul>`;

  const rooms = floor.zones.map((zoneState) => roomPanel(zoneState, nowIso)).join('\n');

  const roomIndex = `<ul class="hq-room-index">${floor.zones
    .map(
      (zoneState) =>
        `<li><a href="#room-${escapeHtml(zoneState.zone.id)}">${escapeHtml(zoneState.zone.name)}</a>${chip(
          LIVENESS_PRESENTATION[zoneState.liveness].label,
          LIVENESS_PRESENTATION[zoneState.liveness].tone,
        )}</li>`,
    )
    .join('')}</ul>`;

  return `${kpis}
${section(
  'THE FLOOR',
  `<div class="hq-viewport" id="hq-floor" tabindex="0" role="region" aria-label="JENIFY headquarters floor plan — pan horizontally to reach every room">
${renderScene(floor)}
</div>
<p class="faint">Select a room to jump to its detail below. The plan scrolls inside its own frame, so the page itself never scrolls sideways.</p>
${roomIndex}`,
)}
${section('WHAT THE MOTION MEANS', `<p class="readonly-note">${escapeHtml(FLOOR_HONESTY_NOTE)}</p>${legend}`)}
${section('ROOMS', `<div class="hq-rooms">${rooms}</div>`)}`;
}
