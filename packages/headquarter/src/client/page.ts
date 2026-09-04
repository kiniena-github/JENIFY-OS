/**
 * The immersive HQ page body (issue #250, Stage 4).
 *
 * ## Server-rendered first, 3D second
 *
 * Every one of the seventeen rooms is in this document as real markup: its
 * name, its purpose, what it is bound to, and — for the rooms whose truth does
 * not depend on a session — its full statement. The canvas is added on top. So
 * the three routes through this page (WebGL, reduced motion, no WebGL at all)
 * differ only in whether there is a picture; the information is the same in all
 * three, and a screen reader, a printed page and a browser with scripting off
 * all get the complete building.
 *
 * ## What is deliberately NOT rendered here
 *
 * Numbers. This page is built by `build-site.ts`, which holds no HQ database
 * and no session, so it has no canonical state to render and does not pretend
 * otherwise: live-bound rooms ship saying "no state document has been read
 * yet", and the client runtime replaces that with the server's answer. The one
 * thing this page may never do is ship a plausible-looking count that came from
 * a bundle rather than from the authenticated route.
 */

import { escapeHtml, section, type Tone } from '../ui/components.js';
import { hydrateRooms } from './hydrate.js';
import { HQ_ROOMS, roomRoute, type HqRoom } from './rooms.js';
import type { RoomView } from './contracts.js';
import { clientRuntimeScript } from './runtime.js';
import { immersiveShellScript } from './webgl.js';

const BINDING_CHIP: Record<RoomView['status'], { label: string; tone: Tone }> = {
  live: { label: 'LIVE', tone: 'accent' },
  awaiting: { label: 'NO STATE READ', tone: 'neutral' },
  not_recorded: { label: 'NOT RECORDED', tone: 'warn' },
  later_phase: { label: 'LATER PHASE', tone: 'violet' },
};

export const IMMERSIVE_HONESTY_NOTE =
  'Every room here is lit by canonical state and nothing else. A dark room is a room HQ is holding ' +
  'nothing in. ' +
  // What a pulse actually means, room by room.
  //
  // This used to say a pulsing room "holds work the canonical queue records as
  // running or stopped" — true of the task rooms and FALSE of two others. The
  // Security Center goes to attention for an engaged kill switch or an untrusted
  // request origin, and the World Network and Settings rooms for an integration
  // in error, expired, configured or setup-required — all with an empty queue.
  // The shell pulses every attention room, so the legend was telling a Founder
  // that a deployment-posture pulse proved queue work (Codex round 16).
  //
  // A page whose whole claim is that it never asserts more than canonical state
  // supports cannot afford a legend that asserts more than the lighting
  // supports.
  'A room glows or pulses for what that room is bound to: in the task rooms that means work the ' +
  'canonical queue records as running or stopped; in the Security Center it means an engaged kill ' +
  'switch or an untrusted request origin; in the World Network and Settings rooms it means an ' +
  'integration HQ recorded as failing, expired or only half configured. Never a timer, never ' +
  'activity invented to fill the room. ' +
  'The room you are currently in is outlined in a neutral grey — that edge is navigation, not state, ' +
  'and it never changes how brightly a room is lit. ' +
  'Rooms whose subject HQ does not record say so in place of a number, and no control is drawn ' +
  'that the control API did not grant to this session.';

function roomPanel(view: RoomView, room: HqRoom): string {
  const isStatic = view.status === 'not_recorded' || view.status === 'later_phase';
  const badge = BINDING_CHIP[view.status];
  return `<section class="hq-room hq-immersive-room" id="room-${escapeHtml(room.id)}" data-hq-room="${escapeHtml(
    room.id,
  )}" data-hq-room-static="${isStatic ? 'yes' : 'no'}" data-liveness="dark" data-hq-room-active="no" aria-labelledby="room-${escapeHtml(
    room.id,
  )}-name">
<h3 id="room-${escapeHtml(room.id)}-name"><span class="hq-room-ordinal" aria-hidden="true">${room.ordinal}</span>${escapeHtml(
    room.name,
  )}</h3>
<p class="row"><span class="chip tone-${badge.tone}" data-hq-room-status>${escapeHtml(badge.label)}</span></p>
<p class="lede">${escapeHtml(room.purpose)}</p>
<div data-hq-room-body><p class="readonly-note">${escapeHtml(view.emptyMessage)}</p></div>
<p class="faint" data-hq-room-provenance>${escapeHtml(view.provenance)}</p>
${room.page ? `<p><a href="${escapeHtml(room.page)}">Open the full ${escapeHtml(room.name)} page →</a></p>` : ''}
<p class="faint"><a href="#hq-building">Back to the building ↑</a></p>
</section>`;
}

export function immersiveBody(): string {
  // `null` state, deliberately: the static build has no session and no
  // database, so every live-bound room ships as "no state document has been
  // read yet" rather than as a zero.
  const views = hydrateRooms(null, null);
  const byId = new Map(views.map((view) => [view.roomId, view]));

  const roomLinks = HQ_ROOMS.map(
    (room) =>
      `<li><a href="${escapeHtml(roomRoute(room.id))}" data-hq-room-link="${escapeHtml(room.id)}"><span class="hq-room-ordinal" aria-hidden="true">${room.ordinal}</span>${escapeHtml(
        room.name,
      )}</a></li>`,
  ).join('');

  // Spans, NOT anchors.
  //
  // These float over the canvas and are `aria-hidden`, because the room index
  // below is the real, accessible navigation and duplicating it in the
  // accessibility tree would just make every room announce twice. But
  // `aria-hidden` does not remove descendants from sequential focus, so as
  // anchors they were sixteen invisible tab stops that a screen reader could
  // not explain and that `positionLabels` could not even move out of the way —
  // it changes opacity, not focusability (Codex round 2).
  //
  // As spans they are decorative, exactly as they are described. The shell
  // script attaches click handlers so pointing at a room still walks into it;
  // keyboard users get the same destinations from the room index, with proper
  // link semantics.
  const labels = HQ_ROOMS.filter((room) => room.placement.ring !== 0)
    .map(
      (room) =>
        `<span class="hq-label" data-hq-label="${escapeHtml(room.id)}">${escapeHtml(room.name)}</span>`,
    )
    .join('');

  const panels = HQ_ROOMS.map((room) => roomPanel(byId.get(room.id)!, room)).join('\n');

  // NOTE the absence of a `<button>` here, and everywhere else in this page's
  // static markup. The site-wide invariant is that the rendered HTML carries no
  // form, button or submit control — working controls exist only as DOM nodes a
  // script creates after the server said they may. The motion toggle is created
  // by the shell script instead, which also makes it correct: with no WebGL
  // there is no camera to slow down, so the toggle would control nothing.
  const building = `<div class="hq-building" id="hq-building">
<canvas class="hq-canvas" data-hq-canvas role="img" aria-label="Procedural 3D view of the JENIFY headquarters. Every room is also listed as text below, with the same state."></canvas>
<div class="hq-labels" data-hq-labels aria-hidden="true">${labels}</div>
<div class="hq-building-bar" data-hq-building-bar></div>
</div>
<p class="faint" data-hq-3d-status data-tone="checking">Checking whether this device can draw the 3D headquarters…</p>`;

  return `<div data-hq-client data-hq-access-state="checking">
<p class="row"><span class="chip tone-neutral" data-hq-access data-hq-access-state="checking">CHECKING…</span><span class="faint" data-hq-stamp></span></p>
<p class="faint" data-hq-access-note>Asking the HQ control API who this browser is…</p>
<div class="provenance-banner" role="alert" data-hq-lock hidden></div>
${section('THE BUILDING', `${building}<ul class="hq-room-index">${roomLinks}</ul>`)}
${section('WHAT THE LIGHT MEANS', `<p class="readonly-note">${escapeHtml(IMMERSIVE_HONESTY_NOTE)}</p>`)}
${section('ROOMS', `<div class="hq-rooms">${panels}</div>`)}
</div>
${immersiveShellScript()}
${clientRuntimeScript()}`;
}
