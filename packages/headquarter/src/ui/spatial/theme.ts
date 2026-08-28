/**
 * Stylesheet for the living Headquarters (issue #200, spatial HQ mission).
 *
 * Appended to `THEME_CSS` rather than shipped separately, on purpose: the
 * responsive and accessibility invariants in `test/ui-responsive.test.ts`
 * parse THEME_CSS, so folding the spatial rules into it puts them under the
 * same enforced constraints as the rest of the site —
 *
 *   · no fixed pixel width above the narrowest supported viewport,
 *   · every media query mobile-first (`min-width` only),
 *   · every multi-column grid track able to shrink to one column,
 *   · all motion switched off under `prefers-reduced-motion`.
 *
 * Lengths inside the SVG are user units, not CSS pixels: the scene declares a
 * `viewBox`, so `font-size: 0.62px` is 0.62 floor units and scales with the
 * plan. Nothing in here sizes a page element in pixels.
 */

export const SPATIAL_CSS = `
/* ---------------------------------------------------------------- */
/* Living Headquarters — floor, rooms, figures                       */
/* ---------------------------------------------------------------- */

/* The plan is wider than a phone. It scrolls inside its own frame; the
   PAGE never scrolls sideways, which is the site-wide rule. */
.hq-viewport {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(60% 70% at 50% 22%, rgba(106,166,255,0.10), transparent 70%),
    radial-gradient(45% 55% at 18% 78%, rgba(53,223,168,0.07), transparent 70%),
    var(--bg-deep);
  padding: 0.5rem;
  overflow: auto;
  overscroll-behavior-x: contain;
  min-width: 0;
  box-shadow: var(--shadow);
}
.hq-scene { display: block; width: 100%; min-width: 46rem; height: auto; }
@media (min-width: 62rem) {
  .hq-scene { min-width: 0; }
}

/* Rooms are links: the whole room is the target, and it is reachable by
   keyboard because it is an anchor rather than a scripted click area. */
.hq-zone { cursor: pointer; transition: opacity 160ms ease; }
.hq-zone:hover .zone-floor.face-top { fill: #16253d; }
.hq-zone:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.zone-floor.face-top { fill: #101a2c; }
.zone-floor.face-east { fill: #0a1220; }
.zone-floor.face-south { fill: #070d17; }
.zone-grid { stroke: rgba(106,166,255,0.10); stroke-width: 0.018; }
.zone-wall { fill: #16203a; }
.zone-wall.wall-north { fill: #1c2947; }
.zone-striplight { fill: rgba(106,166,255,0.22); }

/* Nameplates live in their own top layer, so they are coloured once here
   rather than per room: liveness is carried by the floor tint, the room
   index chip and the room panel, never by the plate.

   The layer MUST NOT take pointer events. It is painted over the plan, and
   a plate sits at the centre of its room — the most natural place to click.
   Without this the label silently ate the click on every room, so the plan
   looked interactive and was not. Keyboard focus was unaffected, which is
   exactly why a structural test alone would not have caught it. */
.hq-nameplates { pointer-events: none; }
.zone-name {
  fill: var(--text);
  font-family: ui-sans-serif, system-ui, "Segoe UI", Inter, Roboto, sans-serif;
  font-size: 0.48px;
  font-weight: 700;
  letter-spacing: 0.04px;
}
.zone-plate-bg { fill: rgba(7,10,17,0.82); stroke: var(--line); stroke-width: 0.02; }

/* Liveness tints the room floor. It is always accompanied by the room's
   liveness word in the panel below, so nothing is said by colour alone. */
.hq-zone[data-liveness="active"] .zone-floor.face-top { fill: #142842; }
.hq-zone[data-liveness="active"] .zone-striplight { fill: rgba(106,166,255,0.4); }
.hq-zone[data-liveness="attention"] .zone-floor.face-top { fill: #251f16; }
.hq-zone[data-liveness="attention"] .zone-striplight { fill: rgba(247,185,85,0.38); }
.hq-zone[data-liveness="unstaffed"] { opacity: 0.6; }

/* Furniture. Three faces, three tones — the shading is the depth cue.
   These are deliberately well clear of the floor tones: at the first
   render the props were within a few points of the floor they stood on,
   which made every room read as empty. */
.prop-body.face-top { fill: #3a4b70; }
.prop-body.face-east { fill: #273455; }
.prop-body.face-south { fill: #1b2540; }
.prop-chair.face-top { fill: #2e3c5c; }
.prop-chair.face-east { fill: #202b46; }
.prop-chair.face-south { fill: #171f34; }
.prop-monitor.face-top { fill: #223051; }
.prop-monitor.face-east { fill: #18213a; }
.prop-monitor.face-south { fill: #111828; }
.prop-partition.face-top { fill: #2b3a58; }
.prop-partition.face-east { fill: #1d2740; }
.prop-partition.face-south { fill: #151d31; }

/* Dark glass, not a missing object: an unlit screen still shows there is a
   workstation there. */
.prop-screen { fill: #0f1728; }
.prop-screen.is-lit { fill: var(--info); fill-opacity: 0.9; animation: hq-screen 3.4s ease-in-out infinite; }

.prop-lamp.face-top, .prop-lamp.face-east, .prop-lamp.face-south { fill: #1a2338; }
.prop-lamp.is-lit.face-top { fill: var(--accent); }
.prop-lamp.is-lit.face-east { fill: var(--accent-deep); }
.prop-lamp.is-lit.face-south { fill: #0a5540; }
.prop-lamp.is-lit { animation: hq-pulse 4.2s ease-in-out infinite; }

.prop-beacon.face-top, .prop-beacon.face-east, .prop-beacon.face-south { fill: #1a2338; }
.prop-beacon.is-lit.face-top { fill: var(--warn); }
.prop-beacon.is-lit.face-east { fill: #a97a2c; }
.prop-beacon.is-lit.face-south { fill: #7d5a1f; }
.hq-station[data-tone="danger"] .prop-beacon.is-lit.face-top { fill: var(--danger); }
.hq-station[data-tone="info"] .prop-beacon.is-lit.face-top { fill: var(--info); }
.hq-station[data-tone="accent"] .prop-beacon.is-lit.face-top { fill: var(--accent); }

/* A FAILING fixture is not lit — lighting it would claim positive evidence,
   which is the one thing this floor must never do — but it must not look
   like an ordinary dark pillar either. An errored or expired uplink used to
   render byte-identically to a service nobody has configured, so the room
   could say "Needs attention" with nothing on the plan explaining why
   (Codex review of 67bbaac).
   These rules tint the whole prop; the fault marker beside them carries the
   same information as a SHAPE, so nothing here rests on colour alone. */
.hq-station[data-attention="yes"] .prop-lamp.face-top,
.hq-station[data-attention="yes"] .prop-beacon.face-top { fill: var(--warn); }
.hq-station[data-attention="yes"] .prop-lamp.face-east,
.hq-station[data-attention="yes"] .prop-beacon.face-east { fill: #a9762c; }
.hq-station[data-attention="yes"] .prop-lamp.face-south,
.hq-station[data-attention="yes"] .prop-beacon.face-south { fill: #7a541d; }
.hq-station[data-attention="yes"][data-tone="danger"] .prop-lamp.face-top,
.hq-station[data-attention="yes"][data-tone="danger"] .prop-beacon.face-top { fill: var(--danger); }
.hq-station[data-attention="yes"][data-tone="danger"] .prop-lamp.face-east,
.hq-station[data-attention="yes"][data-tone="danger"] .prop-beacon.face-east { fill: #a83f3f; }
.hq-station[data-attention="yes"][data-tone="danger"] .prop-lamp.face-south,
.hq-station[data-attention="yes"][data-tone="danger"] .prop-beacon.face-south { fill: #7d2e2e; }

/* The marker itself. Static: it reports a stopped thing, and this floor does
   not animate stopped things. */
.fault-stem.face-top, .fault-dot.face-top { fill: var(--warn); }
.fault-stem.face-east, .fault-dot.face-east { fill: #a9762c; }
.fault-stem.face-south, .fault-dot.face-south { fill: #7a541d; }
.hq-station[data-tone="danger"] .fault-stem.face-top,
.hq-station[data-tone="danger"] .fault-dot.face-top { fill: var(--danger); }
.hq-station[data-tone="danger"] .fault-stem.face-east,
.hq-station[data-tone="danger"] .fault-dot.face-east { fill: #a83f3f; }
.hq-station[data-tone="danger"] .fault-stem.face-south,
.hq-station[data-tone="danger"] .fault-dot.face-south { fill: #7d2e2e; }

/* Figures. */
.fig-shadow { fill: rgba(0,0,0,0.42); }
.fig-torso.face-top { fill: #8496b8; }
.fig-torso.face-east { fill: #63739a; }
.fig-torso.face-south { fill: #4d5b7e; }
.fig-head { fill: #bcc8e0; }

/* ONLY the animated activities move.
   ANIMATED_ACTIVITIES is ['working', 'reviewing'], and the page tells the
   reader in so many words that a figure moves only while a canonical event
   says its task is active. Blocked and awaiting-Founder figures used to
   pulse, which made STOPPED work assert ongoing activity — the page breaking
   its own stated rule, which is worse than never having stated it. Stalled
   work is now perfectly still; its state is carried by head colour, the room
   tint, the room's liveness chip and the panel, never by motion.
   (Codex exact-head review of 936a682, P1.)
   NOTE: no backticks in this block — it lives inside a TS template literal. */
.hq-figure.act-working .fig-body { animation: hq-work 2.1s ease-in-out infinite; }
.hq-figure.act-reviewing .fig-body { animation: hq-review 4.6s ease-in-out infinite; }
.hq-figure.act-reviewing .fig-head { fill: var(--violet); }
.hq-figure.act-blocked .fig-head { fill: var(--danger); }
.hq-figure.act-awaiting_founder .fig-head { fill: var(--warn); }
.hq-figure.act-complete .fig-head { fill: var(--accent); }
.hq-figure.act-queued { opacity: 0.78; }
/* Offline is deliberately inert and dimmed: the absence of motion is the
   finding, so it is never dressed up. */
.hq-figure.act-offline { opacity: 0.4; }

@keyframes hq-work {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-0.055px); }
}
@keyframes hq-review {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(0.06px); }
}
@keyframes hq-screen {
  0%, 100% { fill-opacity: 0.62; }
  50% { fill-opacity: 1; }
}
@keyframes hq-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* ---------------------------------------------------------------- */
/* Floor index, legend and room panels                               */
/* ---------------------------------------------------------------- */

.hq-room-index {
  list-style: none;
  margin: 0.7rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  min-width: 0;
}
.hq-room-index li {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 0.3rem 0.5rem;
  min-width: 0;
}
.hq-room-index a { text-decoration: none; overflow-wrap: anywhere; }

.hq-legend { list-style: none; margin: 0.7rem 0 0; padding: 0; display: grid; gap: 0.4rem; min-width: 0; }
@media (min-width: 62rem) {
  .hq-legend { grid-template-columns: repeat(2, minmax(min(20rem, 100%), 1fr)); }
}
.hq-legend li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: baseline;
  border-left: 2px solid var(--line-strong);
  padding-left: 0.6rem;
  min-width: 0;
}
.hq-legend li b { color: var(--text); }
.hq-legend li span { overflow-wrap: anywhere; }

.hq-rooms { display: grid; gap: 0.8rem; min-width: 0; }
@media (min-width: 68rem) {
  .hq-rooms { grid-template-columns: repeat(2, minmax(min(24rem, 100%), 1fr)); align-items: start; }
}
.hq-room {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--pad);
  min-width: 0;
  scroll-margin-top: 1rem;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.hq-room h3 { margin: 0 0 0.4rem; }
.hq-room[data-liveness="attention"] { border-color: rgba(247,185,85,0.4); }
.hq-room[data-liveness="active"] { border-color: rgba(106,166,255,0.35); }
/* The scene's links land here; :target is the whole camera mechanism, so
   the floor works with scripting switched off. */
.hq-room:target { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }

.hq-occupants { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.hq-occupant, .hq-fixture {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 0.5rem 0.6rem;
  min-width: 0;
}
.hq-occupant p, .hq-fixture p { margin: 0.3rem 0 0; overflow-wrap: anywhere; }
.hq-occupant[data-activity="offline"] { opacity: 0.82; }
.hq-fixture[data-lit="yes"] { border-color: rgba(53,223,168,0.32); }
`;
