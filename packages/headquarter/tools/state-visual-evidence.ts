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
import { CONNECTION_CATALOG } from '../src/live/connections.js';
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

function floorFor(events: ActivityEvent[], connections: ConnectionStatus[]): FloorState {
  const states = latestTaskStates(events);
  return floorState({
    states,
    dashboard: founderDashboard(states, '2026-08-28'),
    workers: workerStatuses(states),
    specialists:
      events.length > 0
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
 * Everything the browser can see about one station: the computed fill and
 * opacity of every shape inside it, in document order. Two stations that
 * produce the same signature are indistinguishable on screen.
 */
function readSignature(stationId: string): string {
  const station = document.querySelector(`[data-station="${stationId}"]`);
  if (!station) return 'MISSING';
  const parts: string[] = [];
  for (const shape of station.querySelectorAll('polygon, circle, ellipse, rect, line')) {
    const style = getComputedStyle(shape);
    parts.push(`${style.fill}|${style.fillOpacity}|${style.stroke}|${style.opacity}`);
  }
  // The group's own opacity applies to everything inside it.
  parts.push(`group:${getComputedStyle(station).opacity}`);
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
  const fixtureLook = new Map<ConnectionState, string>();
  const fixtureMeaning = new Map<ConnectionState, string>();
  for (const state of CONNECTION_STATES) {
    const floor = floorFor([], [connection(state)]);
    const zone = floor.zones.find((entry) => entry.zone.id === 'uplink-gallery')!;
    const fixture = zone.fixtures[0];
    fixtureLook.set(state, await signatureFor(floor, 'uplink-gallery', fixture.stationId));
    fixtureMeaning.set(state, `${fixture.lit}/${fixture.tone === 'warn' || fixture.tone === 'danger'}`);
  }

  /* ---- occupants: desk figures --------------------------------------- */
  const occupantLook = new Map<ActivityStatus, string>();
  for (const status of STATUSES) {
    const floor = floorFor([taskEvent(status)], []);
    const zone = floor.zones.find((entry) => entry.zone.id === 'build-floor')!;
    occupantLook.set(status, await signatureFor(floor, 'build-floor', zone.occupants[0].stationId));
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

  compare('connection', CONNECTION_STATES, fixtureLook, (state) => fixtureMeaning.get(state)!);
  compare('activity', STATUSES, occupantLook, (status) => STATUS_ACTIVITY[status]);

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
