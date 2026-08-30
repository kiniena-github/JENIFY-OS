/**
 * The EMITTED Command Center page, executed as a browser executes it
 * (issue #219 correction round — the Founder-workstation blocker on PR #225).
 *
 * ## Why this suite exists
 *
 * Every other assertion about the console reads the script as a STRING:
 * `control-console.test.ts` proves the grant rule, the fetch allow-list and the
 * idempotency policy by `new Function`-ing the embedded source, and
 * `live-ui.test.ts` proves the emitted markup contains the mount. Both passed —
 * green, on the exact head — while a real browser at a real deployment drew no
 * composer at all. Nothing in the suite ever put the page's own HTML and the
 * page's own scripts together and looked at the result, so the one thing the
 * Founder actually needs ("`/session` grants `directOrder`, therefore controls
 * appear") was the one thing nothing asserted.
 *
 * So this suite loads the REAL emitted `index.html` into a DOM, lets its own
 * inline scripts run, and answers `/session` with a body produced by the REAL
 * `handleControlRequest` against a real `HeadquarterOperations`. It fails if
 * either side of that seam drifts — a mount that moves, a script that stops
 * being emitted, a script that throws before it draws, a response shape the
 * grant rule stops recognising, or a server that stops granting.
 *
 * ## The origin evidence this pins
 *
 * `/session` is a GET, and a browser sends NO `Origin` header on a GET — so the
 * `Referer` is the only evidence of the page's own origin the request carries,
 * and `controlAvailability` withholds every control when that evidence is
 * missing. The pages therefore pin `referrer-policy: same-origin` rather than
 * inheriting a user-agent default, and the `no-referrer` case below is the
 * reported blocker reproduced exactly: fully configured server, `directOrder`
 * true for a probe that sets its own `Referer`, and no composer in the browser.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { REFERRER_POLICY_META } from '../src/ui/render.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { CONTROL_ROUTES, handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { ControlRequest } from '../src/live/auth.js';
import { registerDirectOrderCapability, DIRECT_ORDER_CAPABILITY } from '../src/live/orders.js';
import { setupFixture } from './application.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';
const PAGE_URL = `${PAGE_ORIGIN}/hq/index.html`;

/**
 * A fully configured deployment: a mapped, active Founder principal that holds
 * the direct-order grant, the capability registered and enabled, and this
 * page's origin on the trusted list. Nothing here is stubbed to say yes —
 * every answer below is computed by the real control API from this state.
 */
function deps(overrides: Partial<ControlApiDeps> = {}): ControlApiDeps {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'hq-proof-originator',
    displayName: 'Proof Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return {
    ops: fixture.ops,
    sessions: {
      resolve: () => ({
        realmId: 'realm',
        accountId: 'acc-1',
        displayName: 'Proof Founder',
        authenticatedAt: new Date().toISOString(),
      }),
    },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-proof-originator' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
    ...overrides,
  };
}

/** The emitted Command Center page — the artefact a host actually serves. */
function commandCenterHtml(): string {
  const page = buildSite(sample).get('index.html');
  if (page == null) throw new Error('buildSite emitted no index.html');
  return page;
}

interface Loaded {
  dom: JSDOM;
  /** Every request the page's own scripts made, in order. */
  calls: string[];
  errors: string[];
}

/**
 * Load the emitted page and let ITS scripts run, with `fetch` answered by the
 * real control API.
 *
 * `referer` is what the browser would attach to the page's same-origin
 * requests: the full page URL under the pinned `same-origin` policy, and
 * `undefined` under `no-referrer`. It is passed straight into the
 * `ControlRequest` the way a host adapter passes a real header.
 */
async function loadPage(
  api: ControlApiDeps,
  options: { referer?: string } = { referer: PAGE_URL },
): Promise<Loaded> {
  const calls: string[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));

  const dom = new JSDOM(commandCenterHtml(), {
    url: PAGE_URL,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window: Record<string, unknown>) {
      window.fetch = (input: string) => {
        const path = String(input).split('?')[0]!;
        calls.push(path);
        // The freshness poll is not this suite's subject; answer it the way a
        // host without a snapshot beside the pages would.
        if (path.endsWith(SNAPSHOT_FILENAME)) {
          return Promise.resolve({ status: 404, json: () => Promise.reject(new Error('no snapshot')) });
        }
        const request: ControlRequest = {
          method: 'GET',
          path,
          headers: options.referer == null ? {} : { referer: options.referer },
        };
        const result = handleControlRequest(request, api);
        return Promise.resolve({ status: result.status, json: () => Promise.resolve(result.body) });
      };
    },
  });

  // Let the console's promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, calls, errors };
}

function composerOf(dom: JSDOM) {
  const document = dom.window.document;
  const mount = document.querySelector('[data-order-console]');
  const note = document.querySelector('[data-order-console-state]');
  return {
    mountPresent: mount != null,
    state: note?.getAttribute('data-order-console-state') ?? null,
    reason: note?.textContent ?? '',
    textareas: document.querySelectorAll('[data-order-console] textarea').length,
    radios: [...document.querySelectorAll('[data-order-console] input[type=radio]')].map(
      (input) => (input as unknown as { value: string }).value,
    ),
    buttons: [...document.querySelectorAll('[data-order-console] button')].map(
      (button) => button.textContent,
    ),
    formPresent: document.querySelector('[data-order-console-form]') != null,
  };
}

/* ------------------------------------------------------------------ */
/* The grant draws the composer — on the emitted page, in a DOM        */
/* ------------------------------------------------------------------ */

describe('the emitted Command Center draws the composer exactly when /session grants it', () => {
  it('draws a real instruction field, every route control and Start Task under a grant', async () => {
    const api = deps();
    // The premise, established from the same code path the page will reach:
    // this deployment genuinely grants the control.
    const granted = handleControlRequest(
      { method: 'GET', path: CONTROL_ROUTES.session, headers: { referer: PAGE_URL } },
      api,
    ).body as { controls: { directOrder: boolean } };
    expect(granted.controls.directOrder).toBe(true);

    const { dom, calls, errors } = await loadPage(api);
    expect(errors, 'the page must not throw before it draws').toEqual([]);
    expect(calls).toContain(CONTROL_ROUTES.session);

    const composer = composerOf(dom);
    expect(composer.mountPresent).toBe(true);
    // THE ASSERTION THE BLOCKER NEEDED: granted, therefore drawn.
    expect(composer.state, composer.reason).toBe('granted');
    expect(composer.formPresent).toBe(true);
    expect(composer.textareas).toBe(1);
    expect(composer.radios).toEqual(['AUTO', 'CLAUDE', 'CODEX']);
    expect(composer.buttons).toEqual(['Start Task']);
  });

  it('draws nothing, and says which condition failed, when the grant is withheld', async () => {
    // A real refusal, not a stubbed one: this page's origin is not on the
    // deployment's trusted list, so a write from it would be refused too.
    const { dom } = await loadPage(deps({ allowedOrigins: ['https://hq.example'] }));
    const composer = composerOf(dom);
    expect(composer.state).toBe('off');
    expect(composer.textareas).toBe(0);
    expect(composer.radios).toEqual([]);
    expect(composer.buttons).toEqual([]);
    expect(composer.reason).toContain('DIRECT ORDER CONTROL IS OFF');
    expect(composer.reason).toContain('trusted');
  });

  it('names the missing authority when a mapped Founder simply does not hold the grant', async () => {
    const api = deps();
    // Same deployment, same trusted origin — the principal is mapped but was
    // never given the originate capability. The page must say THAT, rather
    // than the generic "a control that was not granted is not drawn" it used
    // to fall back to, which sent a Founder to check a configuration that was
    // already correct.
    const fixture = setupFixture();
    registerDirectOrderCapability(fixture.db);
    fixture.principals.register({
      id: 'hq-proof-originator',
      displayName: 'Proof Founder',
      originateCapabilities: [],
      approvalAuthority: false,
      active: true,
    });
    const { dom } = await loadPage({ ...api, ops: fixture.ops });
    const composer = composerOf(dom);
    expect(composer.state).toBe('off');
    expect(composer.textareas).toBe(0);
    expect(composer.reason).toContain('the principal may not hold that authority');
  });
});

/* ------------------------------------------------------------------ */
/* The origin evidence the console depends on                          */
/* ------------------------------------------------------------------ */

describe('the page pins the referrer policy its own control requests depend on', () => {
  it('emits an explicit same-origin referrer policy on every page', () => {
    for (const [file, html] of buildSite(sample)) {
      expect(html, file).toContain(REFERRER_POLICY_META);
      expect(REFERRER_POLICY_META, file).toContain('content="same-origin"');
    }
  });

  it('reproduces the blocker when the browser sends no referrer at all', async () => {
    // The exact reported shape: a probe that sets its own Referer is granted
    // the control, and the browser is not — because a GET carries no Origin,
    // so a stripped referrer leaves the request with no origin evidence and
    // the server correctly withholds every control. This is what the pinned
    // policy above exists to prevent, and it must stay a REFUSAL rather than
    // becoming a control drawn on a guess.
    const api = deps();
    const probe = handleControlRequest(
      { method: 'GET', path: CONTROL_ROUTES.session, headers: { referer: PAGE_URL } },
      api,
    ).body as { controls: { directOrder: boolean } };
    expect(probe.controls.directOrder).toBe(true);

    const { dom } = await loadPage(api, { referer: undefined });
    const composer = composerOf(dom);
    expect(composer.state).toBe('off');
    expect(composer.textareas).toBe(0);
    expect(composer.reason).toContain('no evidence of the origin');
  });
});
