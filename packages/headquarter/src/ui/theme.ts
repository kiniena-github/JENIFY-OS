/**
 * Headquarter design system (issue #138).
 *
 * One dark, premium executive theme shared by every HQ page. Kept as a
 * plain string so the site stays framework-free, dependency-free and
 * renderable without a DOM — the same property the rest of the UI layer
 * relies on.
 *
 * Two rules constrain everything in here:
 *
 * 1. NO HORIZONTAL OVERFLOW. Every grid track is `minmax(min(<x>, 100%), 1fr)`,
 *    every flex/grid child gets `min-width: 0`, long tokens wrap, and wide
 *    content (tables, timelines) scrolls inside its own container instead of
 *    widening the page. Verified at 320/360/390/414 px by
 *    `tools/ui-evidence.mjs` and asserted structurally in
 *    `test/ui-responsive.test.ts`.
 * 2. NO MOTION OR COLOUR THAT CARRIES MEANING ALONE. Status is always a word
 *    plus a colour, focus is always visible, and all motion is disabled under
 *    `prefers-reduced-motion`.
 */

import { SPATIAL_CSS } from './spatial/theme.js';

const BASE_CSS = `
:root {
  color-scheme: dark;
  --bg: #070a11;
  --bg-deep: #05070c;
  --surface: #0d1320;
  --surface-2: #121a2b;
  --surface-3: #172236;
  --line: #1d2941;
  --line-strong: #2e3f5c;
  --text: #e9eef8;
  --text-dim: #9dabc4;
  --text-faint: #6b7a93;
  --accent: #35dfa8;
  --accent-deep: #0f7d5d;
  --info: #6aa6ff;
  --warn: #f7b955;
  --danger: #ff6f6f;
  --violet: #b79bff;
  --radius-lg: 16px;
  --radius: 12px;
  --radius-sm: 8px;
  --pad: clamp(0.9rem, 2.5vw, 1.6rem);
  --shadow: 0 1px 0 rgba(255,255,255,0.03) inset, 0 12px 32px -18px rgba(0,0,0,0.9);
  --rail: 15.5rem;
}

* { box-sizing: border-box; }

html, body { max-width: 100%; }

body {
  margin: 0;
  background:
    radial-gradient(1100px 620px at 82% -12%, rgba(53,223,168,0.09), transparent 60%),
    radial-gradient(900px 520px at 4% 0%, rgba(106,166,255,0.07), transparent 55%),
    var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, "Segoe UI", Inter, Roboto, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ---------------------------------------------------------------- */
/* Accessibility primitives                                          */
/* ---------------------------------------------------------------- */

.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 100;
  background: var(--accent);
  color: #04120d;
  padding: 0.6rem 1rem;
  border-radius: 0 0 var(--radius-sm) 0;
  font-weight: 700;
}
.skip-link:focus { left: 0; }

a { color: var(--accent); }
a:focus-visible,
summary:focus-visible,
input:focus-visible,
select:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ---------------------------------------------------------------- */
/* App shell                                                         */
/* ---------------------------------------------------------------- */

.shell { display: block; }

.rail {
  background: linear-gradient(180deg, var(--surface) 0%, var(--bg-deep) 100%);
  border-bottom: 1px solid var(--line);
  padding: 0.9rem var(--pad) 0.75rem;
}

.brand { display: flex; align-items: center; gap: 0.65rem; min-width: 0; }
.brand .mark {
  width: 2.1rem; height: 2.1rem;
  flex: 0 0 auto;
  border-radius: 9px;
  display: grid; place-items: center;
  font-weight: 800; font-size: 0.85rem; letter-spacing: 0.02em;
  color: #04120d;
  background: linear-gradient(140deg, var(--accent), #12a97c);
}
.brand .wordmark { min-width: 0; }
.brand .wordmark b { display: block; font-size: 0.95rem; letter-spacing: 0.02em; }
.brand .wordmark span { display: block; font-size: 0.7rem; color: var(--text-faint); letter-spacing: 0.14em; text-transform: uppercase; }

.rail nav ul {
  list-style: none;
  margin: 0.85rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.rail nav a {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.45rem 0.7rem;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  color: var(--text-dim);
  text-decoration: none;
  font-size: 0.85rem;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.rail nav a .glyph { opacity: 0.85; font-size: 0.95rem; }
.rail nav a:hover { background: var(--surface-2); color: var(--text); }
.rail nav a[aria-current="page"] {
  background: linear-gradient(180deg, rgba(53,223,168,0.16), rgba(53,223,168,0.06));
  border-color: rgba(53,223,168,0.4);
  color: var(--text);
  font-weight: 650;
}

main {
  padding: var(--pad);
  min-width: 0;
}

.rail-foot {
  margin-top: 1rem;
  padding-top: 0.8rem;
  border-top: 1px solid var(--line);
  font-size: 0.72rem;
  color: var(--text-faint);
  line-height: 1.45;
}

.page-head { margin-bottom: 1.25rem; min-width: 0; }
.page-head h1 {
  margin: 0.15rem 0 0.3rem;
  font-size: clamp(1.35rem, 4.5vw, 1.9rem);
  letter-spacing: -0.015em;
  line-height: 1.15;
}
.eyebrow {
  margin: 0;
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
}
.page-head p.lede { margin: 0; color: var(--text-dim); max-width: 62ch; }

@media (min-width: 62rem) {
  .shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); min-height: 100vh; }
  .rail {
    border-bottom: 0;
    border-right: 1px solid var(--line);
    padding: 1.2rem 1rem;
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    overflow-y: auto;
  }
  .rail nav ul { flex-direction: column; flex-wrap: nowrap; gap: 0.2rem; margin-top: 1.4rem; }
  .rail nav a { padding: 0.55rem 0.7rem; font-size: 0.88rem; }
  main { padding: 1.8rem 2rem 3rem; }
  .page-head { margin-bottom: 1.75rem; }
}

/* ---------------------------------------------------------------- */
/* Sections, cards, grids                                            */
/* ---------------------------------------------------------------- */

section { margin: 0 0 1.6rem; min-width: 0; }

section > h2 {
  margin: 0 0 0.75rem;
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-faint);
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
section > h2::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(90deg, var(--line), transparent);
}

.panel {
  background: linear-gradient(180deg, var(--surface) 0%, rgba(13,19,32,0.72) 100%);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 1rem 1.05rem;
  box-shadow: var(--shadow);
  min-width: 0;
}

.grid { display: grid; gap: 0.8rem; min-width: 0; }
.grid-kpi { grid-template-columns: repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr)); }
.grid-cards { grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr)); }
.grid-wide { grid-template-columns: repeat(auto-fill, minmax(min(100%, 26rem), 1fr)); }
.grid-lanes { grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); align-items: start; }

@media (min-width: 68rem) {
  .split-main { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr); gap: 1.1rem; align-items: start; }
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0.85rem 0.95rem;
  min-width: 0;
  transition: border-color 0.15s ease, transform 0.15s ease, background 0.15s ease;
}
.card:hover { border-color: var(--line); background: var(--surface-2); }
.card h3 { margin: 0 0 0.35rem; font-size: 0.98rem; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.card p { margin: 0.25rem 0; overflow-wrap: anywhere; }

.kpi { display: flex; flex-direction: column; gap: 0.25rem; }
.kpi .kpi-label { font-size: 0.7rem; letter-spacing: 0.13em; text-transform: uppercase; color: var(--text-faint); }
.kpi .kpi-value { font-size: clamp(1.55rem, 6vw, 2.1rem); font-weight: 700; line-height: 1; letter-spacing: -0.03em; }
.kpi .kpi-hint { font-size: 0.78rem; color: var(--text-dim); overflow-wrap: anywhere; }
.kpi.tone-danger .kpi-value { color: var(--danger); }
.kpi.tone-warn .kpi-value { color: var(--warn); }
.kpi.tone-accent .kpi-value { color: var(--accent); }
.kpi.tone-info .kpi-value { color: var(--info); }

.muted { color: var(--text-dim); font-size: 0.85rem; }
.faint { color: var(--text-faint); font-size: 0.8rem; }
.empty {
  color: var(--text-faint);
  font-style: italic;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  padding: 0.7rem 0.85rem;
  margin: 0;
  font-size: 0.85rem;
}

.stack { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
.row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; min-width: 0; }
.row-between { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; justify-content: space-between; min-width: 0; }

/* ---------------------------------------------------------------- */
/* Status language                                                   */
/* ---------------------------------------------------------------- */

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip .dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.chip.tone-accent { color: var(--accent); border-color: rgba(53,223,168,0.38); background: rgba(53,223,168,0.10); }
.chip.tone-info { color: var(--info); border-color: rgba(106,166,255,0.38); background: rgba(106,166,255,0.10); }
.chip.tone-warn { color: var(--warn); border-color: rgba(247,185,85,0.38); background: rgba(247,185,85,0.10); }
.chip.tone-danger { color: var(--danger); border-color: rgba(255,111,111,0.42); background: rgba(255,111,111,0.11); }
.chip.tone-violet { color: var(--violet); border-color: rgba(183,155,255,0.38); background: rgba(183,155,255,0.10); }
.chip.tone-neutral { color: var(--text-dim); }

.attention-card { border-left: 3px solid var(--warn); }
.attention-card.tone-danger { border-left-color: var(--danger); }
.risk-high { border: 1px solid rgba(255,111,111,0.45); box-shadow: 0 0 0 1px rgba(255,111,111,0.10); }

.meter {
  height: 6px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
  margin: 0.45rem 0 0.3rem;
}
.meter > span { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-deep), var(--accent)); }

/* ---------------------------------------------------------------- */
/* Identity                                                          */
/* ---------------------------------------------------------------- */

.avatar {
  width: 2.15rem; height: 2.15rem;
  flex: 0 0 auto;
  border-radius: 10px;
  display: grid; place-items: center;
  font-size: 0.78rem; font-weight: 700; letter-spacing: 0.02em;
  color: #06110c;
  border: 1px solid rgba(255,255,255,0.10);
}
.avatar.sm { width: 1.6rem; height: 1.6rem; border-radius: 7px; font-size: 0.62rem; }
.identity { display: flex; gap: 0.6rem; align-items: center; min-width: 0; }
.identity .who { min-width: 0; }
.identity .who b { display: block; font-size: 0.92rem; overflow-wrap: anywhere; }
.identity .who span { display: block; font-size: 0.74rem; color: var(--text-faint); overflow-wrap: anywhere; }

/* ---------------------------------------------------------------- */
/* Feeds, timelines, messages                                        */
/* ---------------------------------------------------------------- */

.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.feed li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.65rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.feed li:last-child { border-bottom: 0; }
.feed .when { font-variant-numeric: tabular-nums; }
.feed .what { min-width: 0; overflow-wrap: anywhere; }

.timeline { list-style: none; margin: 0; padding: 0 0 0 1.05rem; border-left: 1px solid var(--line); }
.timeline li { position: relative; padding: 0 0 0.85rem 0.25rem; min-width: 0; }
.timeline li::before {
  content: "";
  position: absolute;
  left: -1.36rem; top: 0.42rem;
  width: 0.55rem; height: 0.55rem;
  border-radius: 50%;
  background: var(--surface-3);
  border: 1px solid var(--line-strong, var(--line));
}
.timeline li.is-blocked::before { background: var(--danger); }
.timeline li.is-approval::before { background: var(--warn); }
.timeline li.is-done::before { background: var(--accent); }
.timeline li.is-active::before { background: var(--info); }

.thread { display: flex; flex-direction: column; gap: 0.7rem; min-width: 0; }
.msg {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 0.65rem 0.8rem;
  min-width: 0;
}
.msg.from-founder { border-color: rgba(53,223,168,0.35); background: linear-gradient(180deg, rgba(53,223,168,0.08), var(--surface)); }
.msg .msg-head { display: flex; gap: 0.55rem; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 0.4rem; }
.msg .body { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }

.convo-layout { display: grid; gap: 1rem; min-width: 0; }
@media (min-width: 62rem) {
  .convo-layout { grid-template-columns: minmax(0, 15rem) minmax(0, 1fr); align-items: start; }
}
@media (min-width: 84rem) {
  .convo-layout { grid-template-columns: minmax(0, 15rem) minmax(0, 1fr) minmax(0, 17rem); }
  /* Two-pane variant: the per-conversation context lives inside the
     transcript itself, so there is no third column to reserve. */
  .convo-layout.two-pane { grid-template-columns: minmax(0, 17rem) minmax(0, 1fr); }
}
.convo-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.convo-list a {
  display: block;
  padding: 0.55rem 0.65rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface);
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.convo-list a:hover { background: var(--surface-2); }

/* ---------------------------------------------------------------- */
/* Tables: kept for dense evidence, never allowed to widen the page  */
/* ---------------------------------------------------------------- */

.table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  max-width: 100%;
}
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { text-align: left; padding: 0.5rem 0.65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-faint); font-weight: 600; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }

code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; overflow-wrap: anywhere; color: var(--text-dim); }

/* ---------------------------------------------------------------- */
/* Search + filters                                                  */
/* ---------------------------------------------------------------- */

.filter-bar { display: grid; gap: 0.6rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); }
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.field label { font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-faint); }
input[type="search"], select {
  width: 100%;
  max-width: 100%;
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.6rem;
  font: inherit;
  font-size: 0.9rem;
}
input[type="search"]::placeholder { color: var(--text-faint); }

details.record { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 0.6rem 0.8rem; min-width: 0; }
details.record + details.record { margin-top: 0.5rem; }
details.record > summary { cursor: pointer; list-style: none; min-width: 0; }
details.record > summary::-webkit-details-marker { display: none; }
details.record > summary h3 { display: inline; font-size: 0.95rem; overflow-wrap: anywhere; }
details.record[open] { background: var(--surface-2); border-color: var(--line-strong, var(--line)); }
.record-meta { margin-top: 0.45rem; padding-top: 0.55rem; border-top: 1px solid var(--line); }

/* ---------------------------------------------------------------- */
/* Provenance / honesty banners                                      */
/* ---------------------------------------------------------------- */

.provenance-banner {
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  border: 1px solid rgba(247,185,85,0.42);
  background: rgba(247,185,85,0.09);
  color: var(--text);
  border-radius: var(--radius);
  padding: 0.65rem 0.8rem;
  margin: 0 0 1.2rem;
  font-size: 0.82rem;
  min-width: 0;
}
.provenance-banner b { color: var(--warn); white-space: nowrap; }
.provenance-banner span { min-width: 0; overflow-wrap: anywhere; }

.readonly-note {
  border: 1px solid rgba(106,166,255,0.4);
  background: rgba(106,166,255,0.08);
  border-radius: var(--radius);
  padding: 0.65rem 0.8rem;
  font-size: 0.82rem;
  margin: 0 0 1rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The control console's own verdict (issue #219 correction round). It reuses
   .readonly-note's panel shape and only re-tones it, so it cannot widen a
   narrow viewport; what it adds is that "off" and "live" are distinguishable
   from the surrounding explanatory prose at a glance rather than being one
   more faint paragraph inside a section full of them. */
.console-state { font-weight: 500; }
.console-state-off {
  border-color: rgba(247,185,85,0.55);
  background: rgba(247,185,85,0.1);
  color: var(--warn);
}
.console-state-live {
  border-color: rgba(53,223,168,0.5);
  background: rgba(53,223,168,0.1);
  color: var(--accent);
}

.decision-controls { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.6rem; }
.control-readonly {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.32rem 0.7rem;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--line-strong, var(--line));
  background: var(--surface-2);
  color: var(--text-faint);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: not-allowed;
  max-width: 100%;
}

/* Direct Order composer + Connection Center (issue #200). Both reuse the
   existing card/chip/control-readonly vocabulary; these rules only add the
   stacking and label treatment, so nothing here can widen a narrow viewport. */
.order-composer { display: grid; gap: 0.75rem; min-width: 0; }
.order-field { min-width: 0; display: grid; gap: 0.3rem; }
.order-label {
  margin: 0;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.order-field .control-readonly {
  justify-content: flex-start;
  font-weight: 500;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}
.order-route { min-width: 0; }
.order-route p { min-width: 0; overflow-wrap: anywhere; }
[data-connection] .record-meta code { overflow-wrap: anywhere; }
[data-live-detail] { margin: 0.25rem 0 0; min-width: 0; overflow-wrap: anywhere; }

footer[data-provenance] {
  margin-top: 2rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`;

/**
 * The one stylesheet every HQ page carries.
 *
 * The spatial rules are concatenated here rather than shipped as a separate
 * sheet so that the responsive/accessibility invariants which parse
 * `THEME_CSS` cover the living Headquarters too. The reduced-motion block in
 * `BASE_CSS` uses `!important`, so it disables the spatial animations
 * regardless of the order the two halves appear in.
 */
export const THEME_CSS = `${BASE_CSS}${SPATIAL_CSS}`;
