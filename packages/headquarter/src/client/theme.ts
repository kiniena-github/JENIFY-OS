/**
 * The immersive HQ's own stylesheet (issue #250, Phase 2 Stage 4).
 *
 * Concatenated into `THEME_CSS` alongside the base and spatial sheets, so the
 * responsive and accessibility invariants that parse `THEME_CSS` cover this
 * surface too — `test/ui-responsive.test.ts` reads the whole string, and a rule
 * that broke the no-horizontal-overflow contract would fail there rather than
 * on someone's phone.
 *
 * Two things this sheet must get right:
 *
 *  1. **The canvas is never the only copy.** It is sized in `dvh`/`vh` with a
 *     hard `max-height`, and when `data-hq-3d="unavailable"` the whole building
 *     frame collapses to nothing rather than leaving a black box. The rooms
 *     below are ordinary document flow and are unaffected either way.
 *  2. **Motion stays optional.** Every transition here is inside a
 *     `prefers-reduced-motion` guard by way of the base sheet's `!important`
 *     override, and the only animation is on a room the state document lit.
 */

export const IMMERSIVE_CSS = `
.hq-building {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, rgba(53,223,168,0.07), transparent 60%),
    linear-gradient(180deg, #060910, #04060b);
  min-width: 0;
}
:root[data-hq-3d="unavailable"] .hq-building { display: none; }

.hq-canvas {
  display: block;
  width: 100%;
  height: min(62vh, 560px);
  min-height: 260px;
  touch-action: pan-y;
  cursor: grab;
}
.hq-canvas:active { cursor: grabbing; }

.hq-labels { position: absolute; inset: 0; pointer-events: none; }
.hq-label {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: rgba(7,10,17,0.78);
  color: var(--text);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: none;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 160ms linear;
}
.hq-label:hover, .hq-label:focus-visible { border-color: var(--accent); color: var(--accent); }

.hq-building-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.8rem;
  border-top: 1px solid var(--line);
  background: rgba(6,9,16,0.7);
  min-width: 0;
}
.hq-motion {
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 0.78rem;
  padding: 0.28rem 0.8rem;
  cursor: pointer;
}
.hq-motion[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.hq-building-bar .faint { min-width: 0; overflow-wrap: anywhere; }

.hq-room-ordinal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.5rem;
  height: 1.5rem;
  margin-right: 0.5rem;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-faint);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}

.hq-immersive-room { border-left: 3px solid var(--line); }
.hq-immersive-room[data-liveness="active"] { border-left-color: var(--info); }
.hq-immersive-room[data-liveness="attention"] { border-left-color: var(--warn); }
.hq-immersive-room[data-liveness="quiet"] { border-left-color: var(--line-strong); }
.hq-immersive-room[data-liveness="dark"] { border-left-color: var(--line); }
.hq-immersive-room[data-hq-room-active="yes"] {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(53,223,168,0.22);
}

[data-hq-lock] { border-color: var(--danger); }
[data-hq-client][data-hq-access-state="unauthenticated"] .hq-building,
[data-hq-client][data-hq-access-state="not_founder"] .hq-building,
[data-hq-client][data-hq-access-state="refused"] .hq-building { opacity: 0.45; }
`;
