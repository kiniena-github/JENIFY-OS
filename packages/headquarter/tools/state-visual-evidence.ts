/**
 * Measured proof that the Headquarters Floor RENDERS distinct states
 * distinctly (issue #200, spatial HQ).
 *
 * Why this exists as a separate, browser-driven tool.
 *
 * `test/spatial-truth.test.ts` asserts the same property structurally, by
 * comparing the emitted markup for each state. That check is necessary and
 * demonstrably NOT sufficient: an errored uplink and a never-configured one
 * differed in markup — `data-tone="danger"` vs `data-tone="neutral"` — while
 * no CSS rule keyed on that attribute for an unlit prop, so the two pillars
 * were pixel-identical on screen. A reviewer found that; the markup test
 * would not have. Differing markup does not prove differing appearance, and
 * only a real style resolver can settle it.
 *
 * So this reads COMPUTED fills out of Chromium and asserts the biconditional
 * that matters:
 *
 *   two model states look the same  ⟺  they mean the same thing
 *
 * Collisions within a class are intended and expected: `assigned` and
 * `running` both mean "working"; `connected` and `local_only` are both lit.
 * A collision ACROSS classes is the defect.
 *
 * Local only. No network, no deployment: it renders strings in memory and
 * loads them with `setContent`.
 *
 *   npm run evidence:states --workspace @factoryos/headquarter
 *
 * Playwright is deliberately not a dependency of this package (see
 * `tools/ui-evidence.mjs` for the same reasoning). Point PLAYWRIGHT_PATH at an
 * install of it, and CHROMIUM_PATH at a browser binary if needed:
 *   npm i --no-save --prefix /tmp/pw playwright
 *   PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright/index.js \
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     npx tsx tools/state-visual-evidence.ts
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ActivityEvent, ActivityStatus } from '../src/contracts/events.js';
import type { ConnectionState, ConnectionStatus } from '../src/live/connections.js';
import { CONNECTION_CATALOG, CONNECTION_STATE_TONE } from '../src/live/connections.js';
import { latestTaskStates } from '../src/ui/model.js';
import { founderDashboard, projectBoard, workerStatuses } from '../src/ui/views.js';
import { motionFailures, type FigureMotion } from './motion-verdict.js';
import { buildSite } from '../src/ui/site.js';
import { THEME_CSS } from '../src/ui/theme.js';
import { renderScene } from '../src/ui/spatial/scene.js';
// NOTE: `STATUS_ACTIVITY` is deliberately NOT imported. This tool declares its
// own ACTIVITY_PLAN_CLASS so the oracle cannot move with the renderer.
import { floorState, type FloorState } from '../src/ui/spatial/state.js';

async function loadPlaywright(): Promise<{ chromium: any }> {
  const override = process.env.PLAYWRIGHT_PATH;
  try {
    const module: any = await import(override ? pathToFileURL(resolve(override)).href : 'playwright');
    return module.chromium ? module : module.default;
  } catch (error) {
    console.error(
      'playwright is not resolvable. Install it outside the repo and retry:\n' +
        '  npm i --no-save --prefix /tmp/pw playwright\n' +
        '  PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright/index.js npx tsx tools/state-visual-evidence.ts\n' +
        `(resolution error: ${(error as Error).message})`,
    );
    process.exit(2);
  }
}

const STATUSES: ActivityStatus[] = [
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

const CONNECTION_STATES: ConnectionState[] = [
  'connected',
  'local_only',
  'dispatchable',
  'configured',
  'not_connected',
  'expired',
  'error',
  'setup_required',
];

/**
 * What each connection state MEANS — declared here, independently of how the
 * floor draws it.
 *
 * This table used to be computed as `${fixture.lit}/${severity}` from
 * `Fixture.lit` and `Fixture.tone` — the presentation fields under test. That
 * made the whole biconditional self-referential: the oracle could only ever
 * agree with the renderer, because it was the renderer's own output wearing a
 * different name. It cost exactly the collision you would predict —
 * `dispatchable` and `not_connected` render identically, and the derived
 * oracle called them both `false/none` and accepted it, though
 * `CONNECTION_STATE_TONE` deliberately separates them as `info` and `neutral`
 * (Codex review of `fe16a3f`).
 *
 * Every state below now has its OWN meaning, with exactly one approved
 * equivalence. An earlier version grouped `configured`, `expired` and
 * `setup_required` because the canonical table tones all three `warn`. That
 * was wrong, and for a reason worth keeping written down: a shared TONE is a
 * statement about presentation, not about evidence. Those three states say
 * three different things — every required fact is present but unverified; a
 * live check established that a credential has expired; required facts are
 * still missing — and a reader deciding what to do next needs different
 * actions for each. Treating the tone as the meaning let the tool accept an
 * identical rendering for materially different evidence, and would have made
 * it REJECT a correct visual distinction if anyone added one
 * (Codex review of `be02b52`).
 */
const CONNECTION_MEANING: Record<ConnectionState, string> = {
  // The single APPROVED EQUIVALENCE. Lighting a pillar makes one claim —
  // "this is reachable now" — and that claim is identical for a verified
  // remote service and a local-only one. The floor may draw them alike.
  connected: 'reachable',
  local_only: 'reachable',

  // Work CAN be dispatched here, but connectivity is unverified.
  dispatchable: 'dispatchable-unverified',
  // Nothing is set up at all.
  not_connected: 'absent',
  // Every required fact is present; nothing has verified it.
  configured: 'present-but-unverified',
  // A live check established that a credential has expired.
  expired: 'credential-expired',
  // Required facts are still missing.
  setup_required: 'setup-incomplete',
  // A verified failure is not an unfinished setup.
  error: 'failing',
};

/**
 * Guard the hand-written table above against wishful thinking.
 *
 * Sharing a meaning is now the rare case, so it must be declared here by name
 * and nowhere else. Deriving the permission from anything — a tone, a flag, a
 * severity — is what produced both of the defects this file has already been
 * corrected for.
 */
const APPROVED_EQUIVALENCES: readonly (readonly [ConnectionState, ConnectionState])[] = [
  ['connected', 'local_only'],
];

/**
 * What the plan is required to show for each activity status — declared HERE,
 * deliberately duplicating the intent rather than importing it.
 *
 * This used to read `STATUS_ACTIVITY` from `spatial/state.ts`. That is the
 * production mapping `floorState` uses to pick the rendered class, so the
 * oracle moved with the renderer and could not disagree with it. Demonstrated
 * by collapsing `review_passed` into `working` — a real semantic error, since
 * a task that passed review is not a task being actively worked. The figure
 * then animated as work, all 81 unit tests passed, and this tool reported OK
 * (Codex review of `9d76eb4`).
 *
 * A duplicate is the point, not an accident: the value of this table is that
 * it does NOT move when `STATUS_ACTIVITY` does. If the two disagree, the
 * rendering stops matching this table and the run fails — which is the signal
 * that something changed the floor's vocabulary. Do not "tidy" this by
 * importing the production mapping; that is precisely the defect.
 */
const ACTIVITY_PLAN_CLASS: Record<ActivityStatus, string> = {
  // In flight: handed to a worker, or executing. The floor draws one figure
  // in motion for both, and the panel's status chip separates them.
  assigned: 'working',
  running: 'working',
  // In the review loop — passed and failed alike. Same claim on the plan
  // ("this worker is in review"), separated in the panel.
  review_passed: 'reviewing',
  review_failed: 'reviewing',
  // Accepted and not started. Still, deliberately.
  queued: 'queued',
  // Stopped, and someone must act. `outcome_unknown` is grouped with
  // `blocked` because an unknown outcome IS a blockage for the reader: the
  // task cannot be advanced until someone establishes what happened.
  blocked: 'blocked',
  outcome_unknown: 'blocked',
  // Stopped, and the Founder specifically must act.
  needs_approval: 'awaiting_founder',
  // Finished; nothing is in flight.
  completed: 'complete',
};

/**
 * Which plan classes the floor promises to put IN MOTION — declared here for
 * the same reason as the table above, and measured rather than read off CSS.
 *
 * The page tells the reader, in words, that a figure moves only while a
 * canonical event says its task is active. `spatial-truth.test.ts` asserts
 * that from the stylesheet TEXT, which is necessary and not sufficient: a rule
 * can be present and still never match, or be overridden by a later one, and
 * the text assertion cannot tell. This tool claims to measure appearance, so
 * it should be the one that catches a motion rule that exists but does not
 * reach the element.
 *
 * It did not. Deleting BOTH figure animations left this tool reporting OK,
 * because the activities stay distinguishable by colour and the biconditional
 * only ever asked about distinguishability — never about the motion claim it
 * advertises (Codex review of `9d76eb4`).
 */
const CLASSES_THAT_MUST_MOVE: readonly string[] = ['working', 'reviewing'];

/**
 * Every animation inside this station's figure that DEMONSTRABLY moves it.
 *
 * An animation name is not motion. `animationName` stays non-`none` when the
 * keyframes are flattened to identical values, or when the duration is
 * overridden to `0s` — and in both cases the figure stands perfectly still
 * while the name still reads `hq-work`. Verified both ways: each left this
 * tool AND all 81 unit tests passing (Codex review of `981cedf`).
 *
 * So each animation is seeked to distinct phases through the Web Animations
 * API and the resulting computed style compared. If nothing changes between
 * phases, the animation is not motion, whatever it is called. `moves` is that
 * measurement; `name` and `duration` are reported for the failure message.
 */
function readFigureMotion(stationId: string): FigureMotion[] {
  const station = document.querySelector(`[data-station="${stationId}"]`);
  const figure = station ? station.querySelector('.hq-figure') : null;
  if (!figure) return [];
  const found: FigureMotion[] = [];
  for (const node of [figure, ...figure.querySelectorAll('*')]) {
    const name = getComputedStyle(node).animationName;
    if (!name || name === 'none') continue;
    let duration = 0;
    let movesGeometrically = false;
    let changesAnything = false;
    // NOTE: written inline, no helper functions — this is serialised into the
    // browser, where the build's `keepNames` helper does not exist.
    for (const animation of node.getAnimations()) {
      const timing = animation.effect ? animation.effect.getComputedTiming() : null;
      const span = timing ? Number(timing.duration) || 0 : 0;
      if (span > duration) duration = span;
      if (span <= 0) continue;
      // Sample where the animation ACTUALLY changes, not on a fixed grid.
      //
      // Four quarter-phase samples assume a keyframe layout. They miss any
      // change confined between them: a transform introduced at 85% and
      // restored at 100% moves visibly, yet 0/0.25/0.5/0.75 all read
      // identically, and the tool then REJECTS a correct page. Verified —
      // that exact keyframe set failed as "no change across phases" (Codex
      // review of `ad5530c`).
      //
      // The declared offsets bound every value the animation takes, so
      // sampling them settles whether anything changes. Midpoints are added
      // as well, because a `cubic-bezier` with overshoot can leave the
      // interval spanned by its own endpoints.
      const offsets: number[] = [];
      const effect = animation.effect;
      if (effect && typeof (effect as KeyframeEffect).getKeyframes === 'function') {
        for (const frame of (effect as KeyframeEffect).getKeyframes()) {
          if (typeof frame.offset === 'number') offsets.push(frame.offset);
        }
      }
      if (offsets.length === 0) offsets.push(0, 0.25, 0.5, 0.75, 1);
      offsets.sort((a, b) => a - b);
      const fractions: number[] = [];
      for (let index = 0; index < offsets.length; index += 1) {
        fractions.push(offsets[index]);
        if (index + 1 < offsets.length) fractions.push((offsets[index] + offsets[index + 1]) / 2);
      }

      const geometry: string[] = [];
      const everything: string[] = [];
      const resume = animation.currentTime;
      for (const fraction of fractions) {
        animation.currentTime = span * fraction;
        const at = getComputedStyle(node);
        geometry.push(`${at.transform}|${at.translate}|${at.rotate}|${at.scale}`);
        everything.push(`${at.transform}|${at.opacity}|${at.fillOpacity}|${at.fill}|${at.stroke}`);
      }
      animation.currentTime = resume;
      for (const sample of geometry) {
        if (sample !== geometry[0]) movesGeometrically = true;
      }
      for (const sample of everything) {
        if (sample !== everything[0]) changesAnything = true;
      }
    }
    found.push({ name, duration, movesGeometrically, changesAnything });
  }
  return found;
}

function assertMeaningsAreHonest(): string[] {
  const problems: string[] = [];
  for (let i = 0; i < CONNECTION_STATES.length; i += 1) {
    for (let j = i + 1; j < CONNECTION_STATES.length; j += 1) {
      const a = CONNECTION_STATES[i];
      const b = CONNECTION_STATES[j];
      if (CONNECTION_MEANING[a] !== CONNECTION_MEANING[b]) continue;
      const approved = APPROVED_EQUIVALENCES.some(
        ([x, y]) => (x === a && y === b) || (x === b && y === a),
      );
      if (!approved) {
        problems.push(
          `CONNECTION_MEANING gives ${a} and ${b} the same meaning, but the pair is not in ` +
            'APPROVED_EQUIVALENCES. Every shared meaning must be declared and argued there.',
        );
      }
    }
  }
  return problems;
}

function connection(state: ConnectionState): ConnectionStatus {
  const descriptor = CONNECTION_CATALOG[0];
  return {
    ...descriptor,
    advertisedCapabilities: [...descriptor.advertisedCapabilities],
    requiredFacts: [...descriptor.requiredFacts],
    state,
    verification: 'live_check',
    outcome: 'not_attempted',
    observedFacts: [],
    missingFacts: [],
    effectiveCapabilities: [],
    lastVerifiedAt: null,
    evidenceSource: 'state-visual-evidence',
    reason: `forced state ${state}`,
    canRecheck: false,
    canDisconnect: false,
  } as ConnectionStatus;
}

function taskEvent(status: ActivityStatus): ActivityEvent {
  return {
    id: 'ev-1',
    seq: 1,
    at: '2026-08-28T01:00:00Z',
    subjectKind: 'task',
    subjectId: 't1',
    status,
    actor: 'w',
    summary: 'probe',
    detail: { project: 'P', title: 'T' },
  };
}

function floorFor(
  events: ActivityEvent[],
  connections: ConnectionStatus[],
  // Registering the worker used to be inferred from `events.length > 0`, which
  // silently made the offline probe measure nothing: offline is precisely the
  // case of a REGISTERED worker with no events, so the inference excluded the
  // one state it most needed to include.
  registerWorker = events.length > 0,
): FloorState {
  const states = latestTaskStates(events);
  return floorState({
    states,
    dashboard: founderDashboard(states, '2026-08-28'),
    workers: workerStatuses(states),
    specialists: registerWorker
      ? [{ id: 'w', displayName: 'W', vendor: 'v', role: 'build_lead', allowedCapabilities: [], active: true }]
      : [],
    projects: projectBoard(states),
    approvals: [],
    connections,
    archive: [],
    chatMessages: [],
  });
}

/**
 * Everything the browser can see about one station: the computed fill and the
 * EFFECTIVE opacity of every shape inside it, in document order. Two stations
 * that produce the same signature are indistinguishable on screen.
 *
 * The effective opacity has to be composed by walking ancestors, and getting
 * that wrong is how this function was blind for four review rounds. CSS
 * `opacity` is NOT inherited: it establishes a group that the browser
 * composites, so `getComputedStyle(leaf).opacity` reports `1` no matter what
 * any ancestor is set to. The rules that dim a stalled worker apply opacity to
 * `.hq-figure`, an intermediate group — neither the leaf shapes this function
 * read, nor the outer `[data-station]` element it also read. Measured: a
 * `queued` figure really renders at 0.78 and an `offline` one at 0.4, and the
 * signature recorded neither. Any two states differing ONLY by figure opacity
 * were therefore certain to be called identical, on a render that was correct
 * (Codex review of `fe16a3f`).
 *
 * So multiply every ancestor's opacity up to and including the station root.
 * That is what the compositor does, and it is the only reading that makes
 * "same signature" mean "same pixels".
 */
function readSignature(stationId: string): string {
  const station = document.querySelector(`[data-station="${stationId}"]`);
  if (!station) return 'MISSING';

  // NOTE: the ancestor walk is written inline rather than as a helper. This
  // function is serialised and evaluated inside the browser, where the
  // build's `keepNames` helper (`__name`) does not exist — a named inner
  // function turns into a ReferenceError at page.evaluate time.
  const parts: string[] = [];
  const shapes = [...station.querySelectorAll('polygon, circle, ellipse, rect, line'), station];
  for (const shape of shapes) {
    // ONE walk, collecting BOTH inherited-by-composition properties. Opacity
    // multiplies; animation names accumulate. Recording the animation only at
    // the leaf was the same blindness as reading opacity only at the leaf, and
    // it had the same consequence one level up: `hq-work` and `hq-review` are
    // applied to `.fig-body`, an intermediate GROUP, so with the animations
    // frozen at an identical phase-zero transform, deleting BOTH figure
    // animations left every captured signature unchanged and the tool still
    // reported OK. Verified by deleting them (Codex review of `9d76eb4`).
    let opacity = 1;
    const animations: string[] = [];
    let current: Element | null = shape;
    while (current) {
      const ancestor = getComputedStyle(current);
      opacity *= Number.parseFloat(ancestor.opacity) || 0;
      if (ancestor.animationName && ancestor.animationName !== 'none') {
        animations.push(ancestor.animationName);
      }
      if (current === station) break;
      current = current.parentElement;
    }
    // Rounded, because float multiplication of ancestor opacities is not
    // exact and a 1e-16 difference is not a visible one.
    const style = getComputedStyle(shape);
    // Animations are recorded SYMBOLICALLY rather than sampled: whether a
    // thing moves is a real visual difference, and it is the one property here
    // that cannot be read off a single frame — see FREEZE_ANIMATIONS_CSS.
    const motion = animations.length > 0 ? animations.join('+') : 'still';
    const label = shape === station ? 'group' : `${style.fill}|${style.fillOpacity}|${style.stroke}`;
    parts.push(`${label}|${motion}|${opacity.toFixed(4)}`);
  }
  return parts.join(';');
}

/**
 * Sample every state at the SAME animation phase.
 *
 * Two of these properties are continuously animated — a lit uplink lamp sweeps
 * `opacity` under `hq-pulse`, a lit screen sweeps `fill-opacity` under
 * `hq-screen` — and each state is rendered and sampled in sequence, so the
 * phase at sampling time is whatever the machine happened to be doing.
 * Measured on one unchanged page, one station:
 *
 *   t≈   0ms  lamp.opacity=1          t≈1500ms  lamp.opacity=0.610034
 *   t≈ 300ms  lamp.opacity=0.974748   t≈2100ms  lamp.opacity=0.552695
 *   t≈ 700ms  lamp.opacity=0.875001   t≈2600ms  lamp.opacity=0.566362
 *   t≈1100ms  lamp.opacity=0.732239   t≈3100ms  lamp.opacity=0.649349
 *
 * A 0.45 spread on a property the comparison treats as identity. Six
 * consecutive runs happened to agree, because `setContent` restarts the
 * animations and sampling lands a near-constant delay later — but that is the
 * machine being consistent, not the tool being correct. A slower runner would
 * have failed equivalent pairs like `connected`/`local_only` for no reason
 * (Codex review of `be02b52`).
 *
 * Pausing at delay 0 makes every sample deterministic. It also means an
 * animated element can coincide with a static one at that phase, which is why
 * `readSignature` records `animationName` symbolically: whether a thing moves
 * is captured as a fact, not inferred from one lucky frame.
 */
const FREEZE_ANIMATIONS_CSS = `*, *::before, *::after {
  animation-play-state: paused !important;
  animation-delay: 0s !important;
  transition: none !important;
}`;

/**
 * The words the reader sees beside the pillar, taken from the SHIPPED page.
 *
 * Read out of the rendered HTML rather than off `Fixture.label`/`detail`,
 * because reading the model would be the same self-referential mistake this
 * file was already corrected for once: the question is what reaches the
 * reader, and only the built page answers it.
 *
 * Every state is rendered through the same catalogue entry, so the id and
 * display name are constant across states and cannot make two entries differ
 * trivially. Only state-derived text varies.
 */
function panelEntryFor(state: ConnectionState, fixtureId: string): string {
  const page = buildSite({
    generatedAt: '2026-08-28T12:00:00Z',
    todayUtcDate: '2026-08-28',
    events: [],
    specialists: [],
    approvals: [],
    archive: [],
    chatMessages: [],
    connections: [connection(state)],
  }).get('headquarters.html');
  if (!page) return 'NO PAGE';
  const marker = `data-fixture="${fixtureId}"`;
  const at = page.indexOf(marker);
  if (at === -1) return 'NOT IN PANEL';
  const end = page.indexOf('</li>', at);
  return page
    .slice(at, end === -1 ? undefined : end)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const main = async () => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });

  const failures: string[] = [];
  const rows: { group: string; a: string; b: string; sameLook: boolean; sameMeaning: boolean }[] = [];

  async function signatureFor(floor: FloorState, zoneId: string, stationId: string | null): Promise<string> {
    if (stationId === null) return 'UNSEATED';
    await page.setContent(
      `<style>${THEME_CSS}</style><style>${FREEZE_ANIMATIONS_CSS}</style>` +
        `<body><div class="hq-viewport">${renderScene(floor)}</div></body>`,
      { waitUntil: 'load' },
    );
    return page.evaluate(readSignature, stationId);
  }

  /* ---- fixtures: uplink pillars -------------------------------------- */
  failures.push(...assertMeaningsAreHonest());
  const fixtureLook = new Map<ConnectionState, string>();
  const fixturePanel = new Map<ConnectionState, string>();
  for (const state of CONNECTION_STATES) {
    const floor = floorFor([], [connection(state)]);
    const zone = floor.zones.find((entry) => entry.zone.id === 'uplink-gallery')!;
    const fixture = zone.fixtures[0];
    fixtureLook.set(state, await signatureFor(floor, 'uplink-gallery', fixture.stationId));
    fixturePanel.set(state, panelEntryFor(state, fixture.id));
  }

  /* ---- occupants: desk figures --------------------------------------- */
  //
  // `offline` is included even though no ActivityStatus maps to it, because it
  // is the state whose entire visual distinctness rested on the figure opacity
  // the old signature could not see — measuring the other nine while omitting
  // the one that exercises the fix would be evidence of nothing. It is reached
  // the only way the product reaches it: a registered worker the log never
  // names. `PROBE_OFFLINE` is not an ActivityStatus, so it cannot collide with
  // one.
  const PROBE_OFFLINE = 'offline (no canonical event)' as const;
  type ActivityProbe = ActivityStatus | typeof PROBE_OFFLINE;
  const ACTIVITY_PROBES: ActivityProbe[] = [...STATUSES, PROBE_OFFLINE];

  const occupantLook = new Map<ActivityProbe, string>();
  for (const probe of ACTIVITY_PROBES) {
    const floor = floorFor(probe === PROBE_OFFLINE ? [] : [taskEvent(probe)], [], true);
    const zone = floor.zones.find((entry) => entry.zone.id === 'build-floor')!;
    const occupant = zone.occupants[0];
    if (!occupant) {
      failures.push(`${probe}: no occupant was placed on the build floor, so nothing was measured`);
      continue;
    }
    if (probe === PROBE_OFFLINE && occupant.activity !== 'offline') {
      // Fail rather than silently measure a state other than the one named.
      failures.push(`${PROBE_OFFLINE}: expected an offline occupant, got '${occupant.activity}'`);
    }
    occupantLook.set(probe, await signatureFor(floor, 'build-floor', occupant.stationId));

    // The motion claim, measured in the browser rather than read off the
    // stylesheet. `signatureFor` has just loaded this state's page.
    if (occupant.stationId !== null) {
      const animations = await page.evaluate(readFigureMotion, occupant.stationId);
      const expected = CLASSES_THAT_MUST_MOVE.includes(
        probe === PROBE_OFFLINE ? 'offline' : ACTIVITY_PLAN_CLASS[probe],
      );

      // The verdict lives in `motion-verdict.ts` so it can be unit-tested:
      // four consecutive review rounds found the RULE wrong, never the
      // measurement, and a rule that only runs inside a browser tool outside
      // CI is a rule nothing guards.
      failures.push(...motionFailures(probe, expected, animations));
    }
  }

  function compare<T extends string>(
    group: string,
    keys: T[],
    look: Map<T, string>,
    meaning: (key: T) => string,
  ): void {
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = keys[i];
        const b = keys[j];
        const sameLook = look.get(a) === look.get(b);
        const sameMeaning = meaning(a) === meaning(b);
        rows.push({ group, a, b, sameLook, sameMeaning });
        if (sameLook !== sameMeaning) {
          failures.push(
            `${group}: ${a} (${meaning(a)}) and ${b} (${meaning(b)}) ` +
              `${sameLook ? 'LOOK IDENTICAL but mean different things' : 'look different but mean the same thing'}`,
          );
        }
      }
    }
  }

  // Activities: the plan alone carries the whole distinction, so the plain
  // biconditional is the right claim — but the oracle is this file's OWN
  // declaration, never the production mapping. See ACTIVITY_PLAN_CLASS.
  compare('activity', ACTIVITY_PROBES, occupantLook, (probe) =>
    probe === PROBE_OFFLINE ? 'offline' : ACTIVITY_PLAN_CLASS[probe],
  );

  /* ---- connections: three rules, because one was not enough ----------- */
  //
  // Giving each connection state its own meaning made the flat biconditional
  // the wrong claim. `configured`, `expired` and `setup_required` mean three
  // different things and are drawn as one amber pillar — which is not a
  // defect, because the plan is a summary and the room panel beside it is
  // ALWAYS in the document (see `spatial/page.ts`). The distinction the reader
  // needs is there: "Configured — unverified" / "Expired" / "Setup required".
  //
  // So what the floor actually owes the reader is three separate promises,
  // stated separately rather than collapsed into one that is easy to state and
  // false:
  //
  //   1. different meaning       => tellable apart SOMEWHERE on the page
  //   2. different canonical tone => tellable apart ON THE PLAN
  //   3. same meaning            => the PLAN invents no distinction
  //
  // Rule 2 is what caught `dispatchable`/`not_connected`. Rule 1 is the safety
  // property. Rule 3 is scoped to the plan because a panel legitimately
  // carries more detail than a pillar.
  for (let i = 0; i < CONNECTION_STATES.length; i += 1) {
    for (let j = i + 1; j < CONNECTION_STATES.length; j += 1) {
      const a = CONNECTION_STATES[i];
      const b = CONNECTION_STATES[j];
      const samePlan = fixtureLook.get(a) === fixtureLook.get(b);
      const samePanel = fixturePanel.get(a) === fixturePanel.get(b);
      const sameMeaning = CONNECTION_MEANING[a] === CONNECTION_MEANING[b];
      const sameTone = CONNECTION_STATE_TONE[a] === CONNECTION_STATE_TONE[b];
      rows.push({ group: 'connection', a, b, sameLook: samePlan, sameMeaning });

      if (!sameMeaning && samePlan && samePanel) {
        failures.push(
          `connection: ${a} (${CONNECTION_MEANING[a]}) and ${b} (${CONNECTION_MEANING[b]}) are ` +
            'INDISTINGUISHABLE on the whole page — same pillar and same panel entry',
        );
      }
      // An approved equivalence is exactly a licence to draw two differently
      // toned states alike, so rule 2 must not fire on one. connected/
      // local_only are `accent` and `info` and are deliberately one pillar.
      const approvedPair = APPROVED_EQUIVALENCES.some(
        ([x, y]) => (x === a && y === b) || (x === b && y === a),
      );
      if (!sameTone && samePlan && !approvedPair) {
        failures.push(
          `connection: ${a} and ${b} are drawn identically on the plan though the canonical tone ` +
            `table separates them (${CONNECTION_STATE_TONE[a]} vs ${CONNECTION_STATE_TONE[b]})`,
        );
      }
      if (sameMeaning && !samePlan) {
        failures.push(
          `connection: ${a} and ${b} mean the same thing (${CONNECTION_MEANING[a]}) but the plan ` +
            'draws them differently, inventing a distinction the reader cannot act on',
        );
      }
    }
  }

  await browser.close();

  const classesSeen = new Set(fixtureLook.values()).size;
  console.log(`Compared ${rows.length} state pairs by computed style in a real browser.`);
  console.log(`  connection pillars → ${classesSeen} visually distinct renderings`);
  console.log(`  connection panels  → ${new Set(fixturePanel.values()).size} distinct panel entries`);
  console.log(`  activity figures   → ${new Set(occupantLook.values()).size} visually distinct renderings`);

  // Reported separately, because "same pillar" stopped being the same question
  // as "same meaning" once each connection state got its own meaning. A pair
  // drawn as one pillar and separated in the panel is CORRECT — the plan is a
  // summary — so counting it as a defect, as an earlier version of this
  // summary did, would misreport the tool's own result.
  const sharedPillar = rows.filter((row) => row.sameLook && !row.sameMeaning);
  const intended = rows.filter((row) => row.sameLook && row.sameMeaning);
  console.log(`  ${intended.length} pairs render alike AND mean the same (approved equivalence)`);
  console.log(
    `  ${sharedPillar.length} pairs share a pillar while meaning different things ` +
      '(allowed only because the panel separates them — checked above)',
  );

  if (failures.length > 0) {
    console.error('\nFAILED — the rendering does not faithfully express the model:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(
    '\nOK — every pair with a different meaning is tellable apart somewhere on the page,\n' +
      '     every canonical tone distinction survives onto the plan except where an\n' +
      '     equivalence is explicitly approved, and the plan invents no distinction.',
  );
};

await main();
