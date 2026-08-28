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
import { THEME_CSS } from '../src/ui/theme.js';
import { renderScene } from '../src/ui/spatial/scene.js';
import { STATUS_ACTIVITY, floorState, type FloorState } from '../src/ui/spatial/state.js';

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
 * Every grouping below is an EXPLICIT approval with a reason, not a
 * convenience. `assertMeaningsAreHonest` then checks the table against the
 * canonical tone vocabulary so a future edit cannot quietly invent an
 * equivalence to make a failure go away.
 */
const CONNECTION_MEANING: Record<ConnectionState, string> = {
  // APPROVED EQUIVALENCE. Lighting a pillar makes one claim — "this is
  // reachable now" — and that claim is identical for a verified remote
  // service and a local-only one. The floor is entitled to draw them alike.
  connected: 'reachable',
  local_only: 'reachable',

  // Distinct from everything else: work CAN be dispatched here, but
  // connectivity has not been verified. Not a failure, not an absence.
  dispatchable: 'dispatchable-unverified',

  // Distinct from dispatchable: nothing is set up at all.
  not_connected: 'absent',

  // APPROVED EQUIVALENCE. Three routes to one operational fact: setup or
  // credentials are incomplete and a human must finish them. The canonical
  // vocabulary assigns all three `warn`, so this is the declared intent
  // rather than a grouping invented here.
  configured: 'setup-incomplete',
  expired: 'setup-incomplete',
  setup_required: 'setup-incomplete',

  // Distinct: a verified failure is not an unfinished setup.
  error: 'failing',
};

/**
 * Guard the hand-written table above against wishful thinking.
 *
 * Two states may share a meaning only if the canonical `CONNECTION_STATE_TONE`
 * also treats them alike — or if they are the one pair explicitly approved to
 * differ in tone while meaning the same thing (`connected`/`local_only`, which
 * are `accent` and `info` but make the same claim to the reader).
 */
const APPROVED_TONE_EXCEPTIONS: readonly (readonly [ConnectionState, ConnectionState])[] = [
  ['connected', 'local_only'],
];

function assertMeaningsAreHonest(): string[] {
  const problems: string[] = [];
  for (let i = 0; i < CONNECTION_STATES.length; i += 1) {
    for (let j = i + 1; j < CONNECTION_STATES.length; j += 1) {
      const a = CONNECTION_STATES[i];
      const b = CONNECTION_STATES[j];
      if (CONNECTION_MEANING[a] !== CONNECTION_MEANING[b]) continue;
      if (CONNECTION_STATE_TONE[a] === CONNECTION_STATE_TONE[b]) continue;
      const approved = APPROVED_TONE_EXCEPTIONS.some(
        ([x, y]) => (x === a && y === b) || (x === b && y === a),
      );
      if (!approved) {
        problems.push(
          `CONNECTION_MEANING groups ${a} with ${b}, but the canonical tone table separates them ` +
            `(${CONNECTION_STATE_TONE[a]} vs ${CONNECTION_STATE_TONE[b]}) and the pair is not an approved exception`,
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
    let opacity = 1;
    let current: Element | null = shape;
    while (current) {
      opacity *= Number.parseFloat(getComputedStyle(current).opacity) || 0;
      if (current === station) break;
      current = current.parentElement;
    }
    // Rounded, because float multiplication of ancestor opacities is not
    // exact and a 1e-16 difference is not a visible one.
    const style = getComputedStyle(shape);
    const label = shape === station ? 'group' : `${style.fill}|${style.fillOpacity}|${style.stroke}`;
    parts.push(`${label}|${opacity.toFixed(4)}`);
  }
  return parts.join(';');
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
    await page.setContent(`<style>${THEME_CSS}</style><body><div class="hq-viewport">${renderScene(floor)}</div></body>`, {
      waitUntil: 'load',
    });
    return page.evaluate(readSignature, stationId);
  }

  /* ---- fixtures: uplink pillars -------------------------------------- */
  failures.push(...assertMeaningsAreHonest());
  const fixtureLook = new Map<ConnectionState, string>();
  for (const state of CONNECTION_STATES) {
    const floor = floorFor([], [connection(state)]);
    const zone = floor.zones.find((entry) => entry.zone.id === 'uplink-gallery')!;
    const fixture = zone.fixtures[0];
    fixtureLook.set(state, await signatureFor(floor, 'uplink-gallery', fixture.stationId));
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

  compare('connection', CONNECTION_STATES, fixtureLook, (state) => CONNECTION_MEANING[state]);
  compare('activity', ACTIVITY_PROBES, occupantLook, (probe) =>
    probe === PROBE_OFFLINE ? 'offline' : STATUS_ACTIVITY[probe],
  );

  await browser.close();

  const classesSeen = new Set(fixtureLook.values()).size;
  console.log(`Compared ${rows.length} state pairs by computed style in a real browser.`);
  console.log(`  connection states → ${classesSeen} visually distinct renderings`);
  console.log(`  activity states   → ${new Set(occupantLook.values()).size} visually distinct renderings`);

  const crossClass = rows.filter((row) => row.sameLook && !row.sameMeaning);
  const withinClass = rows.filter((row) => row.sameLook && row.sameMeaning);
  console.log(`  ${withinClass.length} pairs look alike AND mean the same (intended equivalence)`);
  console.log(`  ${crossClass.length} pairs look alike but mean DIFFERENT things (defects)`);

  if (failures.length > 0) {
    console.error('\nFAILED — the rendering does not faithfully express the model:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('\nOK — two states look the same exactly when they mean the same thing.');
};

await main();
