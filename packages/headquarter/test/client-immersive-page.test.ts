/**
 * The EMITTED immersive HQ page, executed as a browser executes it
 * (issue #250, Phase 2 Stage 4).
 *
 * ## Why this suite is the one that matters
 *
 * `client-rooms`, `client-hydration`, `client-access` and `client-state-route`
 * each prove one piece in isolation, and all four can be green while the page a
 * Founder actually opens shows nothing — that exact failure happened once
 * before on this surface (see `command-center-live-composer.test.ts`, which
 * exists because the string-level tests all passed while the real browser drew
 * no composer). So this suite loads the REAL `immersive.html` that
 * `build-site.ts` emits, lets its own inline scripts run, and answers every
 * request with a body produced by the REAL `handleControlRequest` against a
 * real `HeadquarterOperations`.
 *
 * ## What jsdom gives us for free
 *
 * jsdom has no WebGL. That is not a limitation here — it is the third route
 * through the page, and the most important one to get right: with no graphics
 * context, the building must disappear cleanly and the document must still
 * carry all seventeen rooms with their real state. This suite therefore proves
 * the fallback by construction, on every single test in it.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { CONTROL_ROUTES, handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';
import { registerDirectOrderCapability, DIRECT_ORDER_CAPABILITY } from '../src/live/orders.js';
import { setupFixture, type Fixture } from './application.fixture.js';
import { HQ_ROOMS } from '../src/client/rooms.js';
import { IMMERSIVE_HONESTY_NOTE } from '../src/client/page.js';
import { SOURCE_MODE_LABELS } from '../src/live/provenance.js';
import { CLIENT_FETCH_TARGETS, CLIENT_READ_TIMEOUT_MS, clientRuntimeScript } from '../src/client/runtime.js';
import { immersiveShellScript } from '../src/client/webgl.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';
const PAGE_URL = `${PAGE_ORIGIN}/hq/immersive.html`;
const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

const FOUNDER_ACCOUNT: AuthenticatedAccount = {
  realmId: 'realm',
  accountId: 'acc-1',
  displayName: 'Proof Founder',
  authenticatedAt: new Date().toISOString(),
};
const STAFF_ACCOUNT: AuthenticatedAccount = {
  realmId: 'realm',
  accountId: 'acc-2',
  displayName: 'Warehouse Lead',
  authenticatedAt: new Date().toISOString(),
};

interface Deployment {
  fixture: Fixture;
  deps: ControlApiDeps;
  /** Swap the session mid-run, to model an expiry or a sign-out. */
  setAccount(account: AuthenticatedAccount | null): void;
}

function deployment(initial: AuthenticatedAccount | null = FOUNDER_ACCOUNT): Deployment {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'hq-proof-originator',
    displayName: 'Proof Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  let account = initial;
  return {
    fixture,
    setAccount(next) {
      account = next;
    },
    deps: {
      ops: fixture.ops,
      sessions: { resolve: () => account },
      founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-proof-originator' }],
      allowedOrigins: [PAGE_ORIGIN],
      secretsEnv: CLAUDE_ONLY,
      mutationsEnabled: true,
    },
  };
}

/** The emitted immersive page — the artefact a host actually serves. */
function immersiveHtml(): string {
  const page = buildSite(sample).get('immersive.html');
  if (page == null) throw new Error('buildSite emitted no immersive.html');
  return page;
}

interface Loaded {
  dom: JSDOM;
  window: Record<string, unknown>;
  document: Document;
  calls: string[];
  errors: string[];
  /** Let the runtime's promise chain settle. */
  settle(): Promise<void>;
  close(): void;
}

async function loadPage(deps: ControlApiDeps): Promise<Loaded> {
  const calls: string[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));

  const dom = new JSDOM(immersiveHtml(), {
    url: PAGE_URL,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window: Record<string, unknown>) {
      window.fetch = (input: string) => {
        const path = String(input).split('?')[0]!;
        calls.push(path);
        if (path.endsWith(SNAPSHOT_FILENAME)) {
          return Promise.resolve({ status: 404, json: () => Promise.reject(new Error('no snapshot')) });
        }
        // A browser sends no Origin on a GET, so the Referer is the only
        // evidence of the page's origin — exactly as in production.
        const request: ControlRequest = { method: 'GET', path, headers: { referer: PAGE_URL } };
        const result = handleControlRequest(request, deps);
        return Promise.resolve({ status: result.status, json: () => Promise.resolve(result.body) });
      };
    },
  });

  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  return {
    dom,
    window: dom.window as unknown as Record<string, unknown>,
    document: dom.window.document,
    calls,
    errors,
    settle,
    close: () => dom.window.close(),
  };
}

function panel(document: Document, roomId: string): HTMLElement {
  const node = document.querySelector(`[data-hq-room="${roomId}"]`);
  if (!node) throw new Error(`no panel for room ${roomId}`);
  return node as HTMLElement;
}

function bodyText(document: Document, roomId: string): string {
  return panel(document, roomId).querySelector('[data-hq-room-body]')!.textContent ?? '';
}

function accessState(document: Document): string {
  return document.querySelector('[data-hq-access]')!.getAttribute('data-hq-access-state') ?? '';
}

describe('the emitted page carries the whole building before any script runs', () => {
  const html = immersiveHtml();

  it('renders a panel for every one of the seventeen rooms', () => {
    for (const room of HQ_ROOMS) {
      expect(html, room.id).toContain(`data-hq-room="${room.id}"`);
      expect(html, room.id).toContain(room.name);
    }
  });

  it('links every room by its deterministic route', () => {
    for (const room of HQ_ROOMS) {
      expect(html, room.id).toContain(`href="#/room/${room.id}"`);
    }
  });

  it('ships no number and no control of its own', () => {
    // The static build holds no HQ database and no session, so it has nothing
    // true to say about counts. The invariant the rest of the site holds —
    // literally no form, button or inline handler in the emitted markup —
    // applies here too.
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/\son(click|submit|load|error|mouseover)=/);
    for (const room of HQ_ROOMS) {
      if (room.binding.kind !== 'live') continue;
      // Every live-bound room ships stating that nothing has been read yet.
      expect(html, room.id).toContain('No state document has been read yet');
    }
  });

  it('states the truth of the rooms HQ does not record, in the document itself', () => {
    for (const room of HQ_ROOMS) {
      if (room.binding.kind === 'live') continue;
      // These sentences must survive with scripting off: they do not depend on
      // a session, and they are the whole content of those rooms.
      expect(html, room.id).toContain(room.binding.reason.slice(0, 60).replace(/&/g, '&amp;'));
    }
  });

  it('speaks only to the two authenticated read routes and the freshness snapshot', () => {
    // LIMIT, stated rather than implied: `CLIENT_FETCH_TARGETS` is exported by
    // the same module that writes the fetches, so this proves the emitted page
    // reaches nothing the runtime has not DECLARED — not that the declared set
    // is the right one. Adding a path to both would pass. That is the intended
    // semantics of an allow-list (the declaration becomes a review signal), and
    // the assertions below are the independent half: no absolute URL, and no
    // write route, neither of which is derived from the constant.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).join('\n');
    const allowed = new Set<string>([...CLIENT_FETCH_TARGETS]);
    for (const literal of scripts.matchAll(/"(\/[A-Za-z0-9/._-]*)"/g)) {
      expect(allowed.has(literal[1]!), `unexpected path literal ${literal[1]}`).toBe(true);
    }
    expect(scripts).not.toContain('http://');
    expect(scripts).not.toContain('https://');
    // No write route is reachable from this runtime at all.
    expect(scripts).not.toContain(CONTROL_ROUTES.orders);
    expect(scripts).not.toContain(CONTROL_ROUTES.approve);
    expect(scripts).not.toContain(CONTROL_ROUTES.deny);
  });

  it('puts no focusable element inside aria-hidden content', () => {
    // `aria-hidden` removes a subtree from the accessibility tree but NOT from
    // sequential keyboard focus. The scene labels were anchors inside an
    // `aria-hidden` overlay, so a keyboard user tabbed through sixteen
    // invisible stops that a screen reader could not explain — and
    // `positionLabels` could not move them out of the way either, because it
    // changes opacity, not focusability (Codex round 2). They are decorative
    // spans now, and the room index below carries the real link semantics.
    const dom = new JSDOM(immersiveHtml(), { url: PAGE_URL });
    const focusable = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
    for (const hidden of dom.window.document.querySelectorAll('[aria-hidden="true"]')) {
      const trapped = [...hidden.querySelectorAll(focusable)].map(
        (node) => `${node.tagName.toLowerCase()}[${node.getAttribute('data-hq-label') ?? ''}]`,
      );
      expect(trapped, `focusable elements inside aria-hidden: ${trapped.join(', ')}`).toEqual([]);
    }
    dom.window.close();
  });

  it('still lets a keyboard user reach every room, through real links', () => {
    // The other half of the fix above: making the labels decorative is only
    // acceptable because the room index is genuine link markup covering all
    // seventeen destinations.
    const dom = new JSDOM(immersiveHtml(), { url: PAGE_URL });
    const reachable = new Set(
      [...dom.window.document.querySelectorAll('[data-hq-room-link]')].map((node) =>
        node.getAttribute('href'),
      ),
    );
    for (const room of HQ_ROOMS) {
      expect(reachable.has(`#/room/${room.id}`), `${room.id} is not reachable by keyboard`).toBe(true);
    }
    dom.window.close();
  });

  it('builds every string through textContent, never markup', () => {
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('outerHTML');
    expect(html).not.toContain('insertAdjacentHTML');
    expect(html).not.toContain('document.write');
  });
});

describe('the legend accounts for every way a room can be lit', () => {
  it('does not claim a pulse always means queue work', () => {
    // Codex round 16. The legend said a pulsing room "holds work the canonical
    // queue records as running or stopped" — true of the task rooms and FALSE
    // of two others. The Security Center reaches attention for an engaged kill
    // switch or an untrusted origin, and the connection-backed rooms for an
    // integration in error, expired, configured or setup_required, all with an
    // entirely empty queue. The shell pulses every attention room, so the page
    // was telling a Founder that a deployment-posture pulse proved queue work.
    //
    // A page whose whole claim is that it never asserts more than canonical
    // state supports cannot afford a legend asserting more than the lighting
    // supports.
    expect(IMMERSIVE_HONESTY_NOTE).not.toContain('a room that pulses holds work the canonical queue');
    // Every non-task source of attention is named.
    expect(IMMERSIVE_HONESTY_NOTE).toContain('kill switch');
    expect(IMMERSIVE_HONESTY_NOTE).toContain('request origin');
    expect(IMMERSIVE_HONESTY_NOTE).toContain('integration');
    // And the task source is still named, so broadening it did not blur it.
    expect(IMMERSIVE_HONESTY_NOTE).toContain('canonical queue records as running or stopped');
    // The no-fake-state promise survives the rewrite.
    expect(IMMERSIVE_HONESTY_NOTE).toContain('Never a timer');
  });

  it('is the note the page actually renders', () => {
    // Asserting the constant alone would pass if the page stopped using it.
    expect(immersiveHtml()).toContain('Never a timer, never');
  });
});

describe('with no WebGL, the page falls back completely rather than partly', () => {
  it('removes the canvas, says why, and keeps every room', async () => {
    const page = await loadPage(deployment().deps);
    // jsdom reports its own unimplemented `getContext` to the virtual console.
    // That IS the no-WebGL condition being detected — `detectWebgl` catches the
    // throw — so it is filtered out here rather than treated as a page fault.
    // Anything else on this console would be a real script error.
    const unexpected = page.errors.filter((error) => !error.includes('HTMLCanvasElement.prototype.getContext'));
    expect(unexpected, unexpected.join(' | ')).toEqual([]);
    // jsdom provides no graphics context, so this is the real no-WebGL path.
    expect(page.document.documentElement.getAttribute('data-hq-3d')).toBe('unavailable');
    expect(page.document.querySelector('[data-hq-canvas]')).toBeNull();
    const status = page.document.querySelector('[data-hq-3d-status]')!;
    expect(status.textContent).toContain('does not provide WebGL');
    expect(status.textContent).toContain('the same data the 3D view would have shown');
    // And no motion toggle, because there is no camera to slow down.
    expect(page.document.querySelector('[data-hq-motion]')).toBeNull();
    // The building is gone; the information is not.
    for (const room of HQ_ROOMS) {
      expect(panel(page.document, room.id), room.id).not.toBeNull();
    }
    page.close();
  });
});

describe('a Founder session hydrates the rooms from the authenticated route', () => {
  it('reads the session and the state route, and nothing else', async () => {
    const page = await loadPage(deployment().deps);
    const controlCalls = page.calls.filter((call) => call.startsWith('/api/'));
    expect(new Set(controlCalls)).toEqual(new Set([CONTROL_ROUTES.session, CONTROL_ROUTES.state]));
    page.close();
  });

  it('marks the access chip ready and stamps the state’s own provenance', async () => {
    const page = await loadPage(deployment().deps);
    expect(accessState(page.document)).toBe('ready');
    expect(page.document.querySelector('[data-hq-access]')!.textContent).toBe('FOUNDER SESSION');
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');
    page.close();
  });

  it('reports an empty HQ as zeroes, in the document', async () => {
    const page = await loadPage(deployment().deps);
    const home = bodyText(page.document, 'home');
    expect(home).toContain('Waiting on the Founder');
    expect(home).toContain('0');
    expect(panel(page.document, 'home').getAttribute('data-liveness')).toBe('dark');
    // And the empty Command Room explains its zero rather than looking broken.
    expect(bodyText(page.document, 'command-room')).toContain('because HQ is holding nothing');
    page.close();
  });

  it('shows a real recorded order in the room that holds it', async () => {
    const live = deployment();
    const created = handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: PAGE_ORIGIN, 'content-type': 'application/json' },
        body: {
          instruction: 'Verify the Stage 4 branch build.',
          route: 'CLAUDE',
          idempotencyKey: 'k-page-1',
          title: 'Verify Stage 4 build',
        },
      },
      live.deps,
    );
    expect(created.status).toBe(201);

    const page = await loadPage(live.deps);
    const approvals = panel(page.document, 'approvals');
    expect(approvals.querySelector('[data-hq-room-body]')!.textContent).toContain('Verify Stage 4 build');
    expect(approvals.getAttribute('data-liveness')).toBe('attention');
    expect(approvals.querySelector('[data-hq-room-status]')!.textContent).toBe('LIVE');
    // The instruction text stays server-side, even on the rendered page.
    expect(page.document.documentElement.outerHTML).not.toContain('Verify the Stage 4 branch build.');
    page.close();
  });

  it('re-reads canonical state when a mutation says it changed', async () => {
    // The refresh-after-mutation contract. The hook is what the existing
    // approval and order consoles call after a CONFIRMED outcome.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(bodyText(page.document, 'approvals')).toContain('Nothing is waiting on a Founder decision');

    handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: PAGE_ORIGIN, 'content-type': 'application/json' },
        body: {
          instruction: 'Something to decide.',
          route: 'CLAUDE',
          idempotencyKey: 'k-page-2',
          title: 'Decide this',
        },
      },
      live.deps,
    );

    // Nothing has told the page yet, so it still shows what it last read.
    expect(bodyText(page.document, 'approvals')).toContain('Nothing is waiting on a Founder decision');

    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(bodyText(page.document, 'approvals')).toContain('Decide this');
    expect(panel(page.document, 'approvals').getAttribute('data-liveness')).toBe('attention');
    page.close();
  });
});

describe('every refusal reaches the reader, and takes the state with it', () => {
  it('shows a signed-out browser nothing, and says so', async () => {
    const page = await loadPage(deployment(null).deps);
    expect(accessState(page.document)).toBe('unauthenticated');
    for (const room of HQ_ROOMS) {
      if (room.binding.kind !== 'live') continue;
      expect(panel(page.document, room.id).querySelector('[data-hq-room-status]')!.textContent, room.id).toBe(
        'NO STATE READ',
      );
      expect(panel(page.document, room.id).getAttribute('data-liveness'), room.id).toBe('dark');
    }
    page.close();
  });

  it('tells a signed-in non-Founder that this is configuration, not a fault', async () => {
    const staffDeps = deployment(STAFF_ACCOUNT).deps;
    const page = await loadPage(staffDeps);
    expect(accessState(page.document)).toBe('not_founder');
    // The reason shown is the control API's OWN sentence, not a paraphrase this
    // client invented — that is what keeps the page and the server from
    // explaining the same refusal two different ways.
    const shown = page.document.querySelector('[data-hq-access-note]')!.textContent ?? '';
    const fromServer = handleControlRequest(
      { method: 'GET', path: CONTROL_ROUTES.session, headers: { referer: PAGE_URL } },
      staffDeps,
    ).body as { message?: string; reason?: string };
    expect(fromServer.reason).toBe('not_founder');
    expect(shown.length).toBeGreaterThan(20);
    expect(shown).toBe(fromServer.message);
    expect(bodyText(page.document, 'home')).not.toContain('Waiting on the Founder');
    page.close();
  });

  it('wipes the rooms when a session expires mid-session', async () => {
    // The transition OUT of ready is the case that matters: a stale room left
    // on screen looking current is precisely what this stage removes.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(accessState(page.document)).toBe('ready');
    expect(bodyText(page.document, 'home')).toContain('Waiting on the Founder');

    live.setAccount(null);
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(accessState(page.document)).toBe('unauthenticated');
    expect(bodyText(page.document, 'home')).not.toContain('Waiting on the Founder');
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    page.close();
  });

  it('does not relight the building from a read it has disowned', async () => {
    // Codex P1 on `7e87392`. The text panels were cleared on session expiry,
    // but the cached views the 3D shell is driven from were not — so navigating
    // to another room afterwards reapplied the previous AUTHENTICATED read to
    // the building, relighting and potentially pulsing rooms whose panels
    // beside them said nothing was current. Wiping the rooms has to mean
    // wiping every copy of them.
    const live = deployment();
    handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: PAGE_ORIGIN, 'content-type': 'application/json' },
        body: { instruction: 'Something lit.', route: 'CLAUDE', idempotencyKey: 'k-relight', title: 'Lit work' },
      },
      live.deps,
    );
    const page = await loadPage(live.deps);
    expect(panel(page.document, 'approvals').getAttribute('data-liveness')).toBe('attention');

    // Capture what the shell is told, from here on.
    const applied: { rooms: { roomId: string; liveness: string }[]; active: string }[] = [];
    const shell = page.window.__hqShellApply as ((v: unknown, a: string) => void) | undefined;
    page.window.__hqShellApply = (views: { roomId: string; liveness: string }[], active: string) => {
      applied.push({ rooms: views, active });
      if (shell) shell(views, active);
    };

    live.setAccount(null);
    (page.window.__hqStateChanged as () => void)();
    await page.settle();
    expect(accessState(page.document)).toBe('unauthenticated');

    // Now navigate, which is what used to reapply the stale views.
    page.dom.window.location.hash = '#/room/mission-room';
    page.dom.window.dispatchEvent(new page.dom.window.Event('hashchange'));
    await page.settle();

    expect(applied.length).toBeGreaterThan(0);
    for (const call of applied) {
      for (const room of call.rooms) {
        expect(room.liveness, `${room.roomId} relit after invalidation`).toBe('dark');
      }
    }
    page.close();
  });

  it('clears the lock banner and the state stamp when a state read fails, not just the rooms', async () => {
    // Codex P2 on `7e87392`. The session probe still succeeds, so the earlier
    // code took the state-failure branch and cleared only the rooms — leaving
    // the previous poll's stamp on screen. The page then said nothing was
    // current while still asserting when it was current.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    // Session keeps working; the STATE route stops answering.
    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.reject(new Error('Failed to fetch'));
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect((page.document.querySelector('[data-hq-lock]') as HTMLElement).hidden).toBe(true);
    expect(bodyText(page.document, 'home')).toContain('could not be reached');
    page.close();
  });

  it('clears everything on a 200 whose body it cannot read, not just the rooms', async () => {
    // The FOURTH path that abandons a state document, and the one Codex did not
    // reach: a well-formed HTTP 200 carrying a body this client cannot parse as
    // a state document. It had the same defect as the three that were reported
    // — rooms dropped, lock banner and stamp left standing — so it is pinned
    // here rather than left to a later review round.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, rooms: 'not-an-array' }) });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect((page.document.querySelector('[data-hq-lock]') as HTMLElement).hidden).toBe(true);
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    page.close();
  });

  it('refuses a document that describes only some of the rooms', async () => {
    // Codex round 5. The guard used to ask only whether `rooms` was an array,
    // so a 200 carrying a partial set updated the panels it supplied and left
    // every omitted panel showing the PREVIOUS document — with the global
    // stamp advanced to the new one. The page then presented two different
    // instants as one, which is worse than presenting none.
    const live = deployment();
    handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: PAGE_ORIGIN, 'content-type': 'application/json' },
        body: { instruction: 'Held work.', route: 'CLAUDE', idempotencyKey: 'k-partial', title: 'Held' },
      },
      live.deps,
    );
    const page = await loadPage(live.deps);
    expect(panel(page.document, 'approvals').getAttribute('data-liveness')).toBe('attention');

    // A well-formed document describing one room and omitting sixteen.
    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              rooms: [{ roomId: 'home', status: 'live', liveness: 'quiet', metrics: [], provenance: 'partial' }],
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    // Nothing is kept — not the room the partial document did describe, and
    // above all not the sixteen it did not.
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(panel(page.document, 'approvals').getAttribute('data-liveness')).toBe('dark');
    expect(bodyText(page.document, 'approvals')).toContain('cannot read');
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    page.close();
  });

  it('refuses a document that names the same room twice', async () => {
    // The other way to arrive at seventeen entries without seventeen rooms.
    // Counting alone would have accepted it and left fifteen panels stale.
    const live = deployment();
    const page = await loadPage(live.deps);

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              rooms: HQ_ROOMS.map((room, index) => ({
                roomId: index === 5 ? 'home' : room.id,
                status: 'live',
                liveness: 'quiet',
                metrics: [],
                provenance: 'duplicated',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    page.close();
  });

  it('refuses a document whose rooms are all present but malformed', async () => {
    // Codex round 6. The completeness guard checked the seventeen ids and
    // stopped, so a version-skewed 200 carrying all seventeen with a room
    // missing `metrics` passed it — then threw at `view.metrics.length` PART
    // WAY THROUGH the render loop, after earlier panels had already been
    // mutated, and the throw was caught by a handler that only cleared
    // `inFlight`. The same mixed old/new page with the same stale stamp,
    // reached by a different door.
    const live = deployment();
    handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: PAGE_ORIGIN, 'content-type': 'application/json' },
        body: { instruction: 'Held work.', route: 'CLAUDE', idempotencyKey: 'k-malformed', title: 'Held' },
      },
      live.deps,
    );
    const page = await loadPage(live.deps);
    expect(panel(page.document, 'approvals').getAttribute('data-liveness')).toBe('attention');

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              // All seventeen ids, each exactly once — and the LAST one is
              // missing `metrics`, so a guard that validated lazily would have
              // rendered sixteen panels before discovering it.
              rooms: HQ_ROOMS.map((room, index) => {
                const view: Record<string, unknown> = {
                  roomId: room.id,
                  ordinal: room.ordinal,
                  status: 'live',
                  liveness: 'quiet',
                  metrics: [],
                  rows: [],
                  emptyMessage: 'skewed',
                  provenance: 'skewed',
                };
                if (index === HQ_ROOMS.length - 1) delete view.metrics;
                return view;
              }),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    // Nothing rendered from it, and nothing left claiming to be current.
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    // The first room in the loop must NOT have taken the skewed document's
    // wording — that is the "mutated part way through" failure.
    expect(bodyText(page.document, 'home')).not.toContain('skewed');
    // And the room that held real state is surrendered, not left on the
    // previous document.
    expect(panel(page.document, 'approvals').getAttribute('data-liveness')).toBe('dark');
    // Rejected up front by the completeness guard, NOT caught downstream after
    // panels were already touched — the two paths word themselves differently
    // on purpose, and only one of them means nothing was mutated.
    expect(bodyText(page.document, 'home')).not.toContain('could not finish reading');
    page.close();
  });

  it('refuses a document carrying a tone outside the contract\u2019s vocabulary', async () => {
    // Codex round 18. `tone` went straight into a class name after only a
    // typeof check, so a version-skewed document could carry
    // `tone: 'critical'` and render `class="kpi tone-critical"` — a rule the
    // stylesheet does not have. The number stayed and its colour vanished,
    // while the page went on stamping the document as current: a danger metric
    // reading like an ordinary one is the quiet direction of wrong, and the
    // two other closed sets (liveness, provenance mode) were already checked.
    const live = deployment();
    const page = await loadPage(live.deps);

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              mode: 'live',
              killSwitch: { globalEngaged: false, engagedScopes: [] },
              rooms: HQ_ROOMS.map((room) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
                liveness: 'dark',
                metrics:
                  room.binding.kind === 'live'
                    ? [{ label: 'Blocked', value: 3, hint: 'skewed', tone: 'critical' }]
                    : [],
                rows: [],
                emptyMessage: 'skewed',
                provenance: 'skewed',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    // Refused whole, as with any other unreadable document: nothing rendered
    // from it and nothing left claiming to be current.
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(bodyText(page.document, 'home')).not.toContain('skewed');
    // The specific failure being prevented: a number on the page wearing a
    // class the stylesheet cannot colour.
    expect(page.document.body.innerHTML).not.toContain('tone-critical');
    page.close();
  });

  it('refuses a document that swaps two rooms’ ordinals', async () => {
    // Codex round 7. The text panels are selected by roomId while the shell
    // indexes its lighting by view.ordinal, so the two identify a room by
    // different keys. A document with all seventeen ids, each once, and every
    // ordinal in range — but two of them exchanged — passed the range check and
    // then lit and pulsed the WRONG buildings beside panels that were
    // themselves correct. The page disagreeing with itself is the one thing
    // this stage exists to prevent.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    // Capture what the shell would be told, so the assertion goes at the
    // building and not only at the text.
    const applied: { roomId: string; ordinal: number }[][] = [];
    page.window.__hqShellApply = (views: { roomId: string; ordinal: number }[]) => {
      applied.push(views);
    };

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              rooms: HQ_ROOMS.map((room, index) => ({
                roomId: room.id,
                // Two adjacent rooms exchange ordinals. Both values are valid,
                // both are in range, and every id is present exactly once.
                ordinal:
                  index === 3 ? HQ_ROOMS[4]!.ordinal : index === 4 ? HQ_ROOMS[3]!.ordinal : room.ordinal,
                status: 'live',
                liveness: 'attention',
                metrics: [],
                rows: [],
                emptyMessage: 'swapped',
                provenance: 'swapped',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    expect(bodyText(page.document, 'home')).not.toContain('swapped');

    // Whatever the shell was handed after this, no room may carry an ordinal
    // that is not its own — the mislit-building failure, asserted directly.
    const registered = new Map(HQ_ROOMS.map((room) => [room.id, room.ordinal]));
    for (const call of applied) {
      for (const view of call) {
        expect(view.ordinal, `${view.roomId} was given another room's ordinal`).toBe(
          registered.get(view.roomId),
        );
      }
    }
    page.close();
  });

  it('refuses to light a room the registry says HQ does not record', async () => {
    // Not a reviewer finding — found by putting round 7's lesson to the rest of
    // the guard rather than waiting to be told. `hydrateRooms` is exact: a room
    // bound `not_recorded` or `later_phase` always reports that kind and always
    // reports `dark`. Both sides of the wire hold the same registry, so a
    // document claiming otherwise is a version skew or worse — and what it
    // produces is the failure this whole stage exists to prevent: a room the
    // registry says HQ does not record, arriving as LIVE and rendering
    // canonical-looking state for a capability that does not exist.
    const live = deployment();
    const page = await loadPage(live.deps);

    const research = HQ_ROOMS.find((room) => room.id === 'research')!;
    const researchBinding = research.binding;
    // Narrowing and assertion in one: if this room ever becomes live-bound,
    // this test is about the wrong room and should say so loudly.
    if (researchBinding.kind !== 'not_recorded') {
      throw new Error(`research is bound ${researchBinding.kind}, so this test no longer tests what it claims`);
    }

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              rooms: HQ_ROOMS.map((room) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                // Everything correct except the one room that claims to hold
                // canonical state its binding says does not exist.
                status: room.id === 'research' ? 'live' : room.binding.kind === 'live' ? 'live' : room.binding.kind,
                liveness: room.id === 'research' ? 'attention' : 'dark',
                metrics:
                  room.id === 'research'
                    ? [{ label: 'Studies running', value: 7, hint: 'invented', tone: 'accent' }]
                    : [],
                rows: [],
                emptyMessage: 'x',
                provenance: 'x',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    // The invented number must not be anywhere on the page.
    expect(page.document.body.textContent).not.toContain('Studies running');
    // And the room HQ does not record still says exactly what it always said,
    // rather than being blanked into an access complaint.
    expect(bodyText(page.document, 'research')).toContain(researchBinding.reason);
    page.close();
  });

  it('refuses a liveness value it has no meaning for', async () => {
    // `RoomLiveness` is a closed set of four. The shell falls back to dark for
    // anything else and the CSS simply would not match, so nothing throws —
    // which is exactly why this needs asserting rather than assuming.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              rooms: HQ_ROOMS.map((room, index) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
                liveness: index === 2 ? 'extremely-busy' : 'dark',
                metrics: [],
                rows: [],
                emptyMessage: 'x',
                provenance: 'x',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(panel(page.document, HQ_ROOMS[2]!.id).getAttribute('data-liveness')).toBe('dark');
    page.close();
  });

  it('refuses a document with perfect rooms and no provenance header', async () => {
    // Codex round 8. Room validation said nothing about the document's own
    // header, so seventeen perfect rooms with a missing `generatedAt`/`mode`
    // were applied and the stamp read "Canonical state as of undefined".
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              killSwitch: { globalEngaged: false, engagedScopes: [] },
              rooms: HQ_ROOMS.map((room) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
                liveness: 'dark',
                metrics: [],
                rows: [],
                emptyMessage: 'x',
                provenance: 'x',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    const stamp = page.document.querySelector('[data-hq-stamp]')!.textContent ?? '';
    expect(stamp).toBe('');
    expect(stamp).not.toContain('undefined');
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    page.close();
  });

  it('refuses a provenance header that is present but not true', async () => {
    // Self-review after round 8. `headerValid` required non-empty strings and
    // stopped there, on the reasoning that a malformed value "renders as text
    // rather than misleading" — which is exactly the reasoning that let
    // `[object Object]` reach a lock banner, so it does not survive contact
    // with this stage's own standard.
    //
    // A `generatedAt` that is not an instant makes "Canonical state as of X"
    // false rather than merely ugly, and an empty `mode` leaves the stamp
    // asserting a provenance with the provenance missing.
    const live = deployment();
    const rooms = HQ_ROOMS.map((room) => ({
      roomId: room.id,
      ordinal: room.ordinal,
      status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
      liveness: 'dark',
      metrics: [],
      rows: [],
      emptyMessage: 'x',
      provenance: 'x',
    }));

    for (const header of [
      { generatedAt: 'the day before yesterday', mode: 'live' },
      { generatedAt: '', mode: 'live' },
      { generatedAt: new Date().toISOString(), mode: '' },
    ]) {
      const page = await loadPage(live.deps);
      expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

      const original = page.window.fetch as (input: string) => Promise<unknown>;
      page.window.fetch = (input: string) => {
        if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
          return Promise.resolve({
            status: 200,
            json: () =>
              Promise.resolve({ ok: true, ...header, killSwitch: { globalEngaged: false, engagedScopes: [] }, rooms }),
          });
        }
        return original(input);
      };
      (page.window.__hqStateChanged as () => void)();
      await page.settle();

      const stamp = page.document.querySelector('[data-hq-stamp]')!.textContent ?? '';
      expect(stamp, JSON.stringify(header)).toBe('');
      expect(bodyText(page.document, 'home'), JSON.stringify(header)).toContain('cannot read');
      page.close();
    }
  });

  it('refuses content for a room HQ does not record, even when its light is right', async () => {
    // Codex round 10, and the same shape as round 7's ordinal: I pinned the
    // status and the liveness and stopped, so a document could keep NOT
    // RECORDED and `dark` while supplying perfectly valid metrics — and
    // `renderRoom` would put canonical-looking numbers underneath a chip still
    // saying the subject is not recorded. `hydrateRoom` guarantees these
    // collections are empty for a static binding; the guard now enforces that
    // rather than a weaker neighbouring property.
    const live = deployment();
    const page = await loadPage(live.deps);
    const research = HQ_ROOMS.find((room) => room.id === 'research')!;
    const researchBinding = research.binding;
    if (researchBinding.kind !== 'not_recorded') {
      throw new Error(`research is bound ${researchBinding.kind}, so this test no longer tests what it claims`);
    }

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              mode: 'live',
              killSwitch: { globalEngaged: false, engagedScopes: [] },
              rooms: HQ_ROOMS.map((room) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
                // Correct status, correct liveness — and content it may not have.
                liveness: 'dark',
                metrics:
                  room.id === 'research'
                    ? [{ label: 'Active studies', value: 12, hint: 'Fabricated.', tone: 'accent' }]
                    : [],
                rows: [],
                emptyMessage: 'x',
                provenance: 'x',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(page.document.body.textContent).not.toContain('Active studies');
    // And the room still says exactly what the registry says it says.
    expect(bodyText(page.document, 'research')).toContain(researchBinding.reason);
    page.close();
  });

  it('validates every field the render path and the shell actually read', () => {
    // The guard against the defect this branch has produced five times.
    //
    // Rounds 7, 8, 10, 11 and 12 were all the same shape: a field arrives from
    // the wire, something downstream reads it, and the validator happens not to
    // check that particular one. Each was found by review, one field per round.
    // Reviewing harder is not a fix for that — the fix is to stop it being
    // possible to read a field nobody validated.
    //
    // So this derives both sets from the SHIPPED source rather than from a list
    // I maintain: every `view.x` / `metric.x` / `row.x` / `chip.x` the rendering
    // code and the 3D shell touch, against every one the validators touch. A new
    // field consumed without a check fails here, in the same commit that adds
    // it, rather than in someone's next review round.
    const runtime = clientRuntimeScript();
    const shell = immersiveShellScript();

    const between = (source: string, start: string, end: string): string => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + 1);
      expect(from, `marker not found: ${start}`).toBeGreaterThan(-1);
      expect(to, `marker not found: ${end}`).toBeGreaterThan(from);
      return source.slice(from, to);
    };

    const fieldsOn = (source: string, receivers: string[]): Set<string> => {
      const found = new Set<string>();
      for (const receiver of receivers) {
        const pattern = new RegExp(`\\b${receiver}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
        for (const match of source.matchAll(pattern)) found.add(match[1]!);
      }
      return found;
    };

    // What the rendering path reads: the three node builders plus renderRoom.
    const renderPath = between(runtime, 'function metricNode(metric)', 'function activeRoom()');
    // What the building reads.
    const shellApply = between(shell, 'function applyViews(views, activeRoomId)', 'window.__hqShellApply =');
    // What the validators check.
    const validators = between(runtime, 'function isText(value)', 'function applyState(body)');

    const consumed = new Set([
      ...fieldsOn(renderPath, ['view', 'metric', 'row', 'chip']),
      ...fieldsOn(shellApply, ['view']),
    ]);
    const validated = fieldsOn(validators, ['view', 'metric', 'row', 'chip', 'rooms[i]']);
    // `length` is a JavaScript property of the arrays, not a wire field.
    consumed.delete('length');
    validated.delete('length');

    expect(consumed.size, 'no fields were extracted — the markers have drifted').toBeGreaterThan(8);
    const unchecked = [...consumed].filter((field) => !validated.has(field));
    expect(unchecked, `read from a state document but never validated: ${unchecked.join(', ')}`).toEqual([]);
  });

  it('refuses a fetched document that says a live room is still awaiting', async () => {
    // Codex round 12. `awaiting` means "no state document has been read yet" —
    // it is what the STATIC build ships, from hydrateRooms(null, null). The
    // state route always calls hydrateRooms with a real state, so a fetched
    // document can never legitimately contain it. Accepting it let a payload
    // render canonical metrics and lit rooms underneath a NO STATE READ chip
    // while advancing the provenance stamp: the page claiming it had read
    // nothing and showing what it read, at the same time.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              mode: 'live',
              killSwitch: { globalEngaged: false, engagedScopes: [] },
              rooms: HQ_ROOMS.map((room) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                status: room.binding.kind === 'live' ? 'awaiting' : room.binding.kind,
                liveness: room.binding.kind === 'live' ? 'active' : 'dark',
                metrics:
                  room.binding.kind === 'live'
                    ? [{ label: 'Running now', value: 9, hint: 'Under a NO STATE READ chip.', tone: 'accent' }]
                    : [],
                rows: [],
                emptyMessage: 'x',
                provenance: 'x',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(page.document.body.textContent).not.toContain('Running now');
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    page.close();
  });

  it('never lets a response rewrite what a static room says', async () => {
    // Codex round 12, and the reason the fix is structural rather than a fourth
    // field check. I had pinned status, then liveness, then metrics and rows —
    // and a fabricated `emptyMessage` still walked through and replaced the
    // registry-backed NOT RECORDED explanation with server text. A static room's
    // statement does not depend on a session, so no response has business
    // rewriting it: those panels are validated but never re-rendered.
    const live = deployment();
    const page = await loadPage(live.deps);
    const research = HQ_ROOMS.find((room) => room.id === 'research')!;
    const researchBinding = research.binding;
    if (researchBinding.kind !== 'not_recorded') {
      throw new Error(`research is bound ${researchBinding.kind}, so this test no longer tests what it claims`);
    }

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              mode: 'live',
              killSwitch: { globalEngaged: false, engagedScopes: [] },
              rooms: HQ_ROOMS.map((room) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
                liveness: 'dark',
                metrics: [],
                rows: [],
                // Everything the guard checks is correct. Only the words lie.
                emptyMessage:
                  room.id === 'research' ? 'Research throughput is tracked and healthy.' : 'x',
                provenance: room.id === 'research' ? 'Canonical research telemetry.' : 'x',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    // This document is well-formed, so the live rooms hydrate normally...
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');
    // ...and the static room still says exactly what the registry says.
    expect(bodyText(page.document, 'research')).toContain(researchBinding.reason);
    expect(page.document.body.textContent).not.toContain('Research throughput is tracked and healthy.');
    expect(page.document.body.textContent).not.toContain('Canonical research telemetry.');
    page.close();
  });

  it('refuses a provenance mode the server cannot emit', async () => {
    // I argued against this one round ago: the server owns the vocabulary and
    // might grow it, so a client checking a list would blank a legitimate page.
    // That was wrong, and wrong in a way this branch had already been taught
    // once — I framed it as strict versus lenient instead of asking WHERE THE
    // TRUTH LIVES (Codex round 9).
    //
    // The list is not restated in the runtime. It is emitted from
    // `SOURCE_MODE_LABELS`, which TypeScript requires to carry a key for every
    // `SourceMode`, so growing the union grows the emitted list in the same
    // build. There was never a real dilemma to resolve.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    const original = page.window.fetch as (input: string) => Promise<unknown>;
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: '2027-01-01T00:00:00.000Z',
              mode: 'definitely-canonical-trust-me',
              killSwitch: { globalEngaged: false, engagedScopes: [] },
              rooms: HQ_ROOMS.map((room) => ({
                roomId: room.id,
                ordinal: room.ordinal,
                status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
                liveness: 'dark',
                metrics: [],
                rows: [],
                emptyMessage: 'Nothing recorded.',
                provenance: 'invented source',
              })),
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(page.document.body.textContent).not.toContain('definitely-canonical-trust-me');
    page.close();
  });

  it('emits the provenance vocabulary from the server, so it cannot drift', () => {
    // The assertion that makes the constraint above safe rather than brittle.
    // If someone adds a SourceMode and this list did not follow, every real
    // document carrying the new mode would be refused and the page would go
    // blank — a false refusal caused by a stale copy, which is precisely the
    // class of bug that put `[object Object]` on a lock banner.
    // LIMIT: both sides derive from SOURCE_MODE_LABELS, so this cannot catch a
    // wrong vocabulary — only a runtime that has STOPPED deriving from it and
    // gone back to a copy. That is exactly the failure it exists for, and the
    // negative control (hard-coding a short list) is what shows it fires. It is
    // recorded because a test whose expectation shares a source with the
    // behaviour is invisible when it is worthless, and I nearly recorded one
    // such test as evidence in round 16.
    const emitted = immersiveHtml().match(/var MODE_VALUES = (\{[^}]*\});/);
    expect(emitted, 'MODE_VALUES not found in the emitted page').not.toBeNull();
    expect(Object.keys(JSON.parse(emitted![1]!)).sort()).toEqual(Object.keys(SOURCE_MODE_LABELS).sort());
  });

  it('will not let a missing kill-switch record read as an unlocked HQ', async () => {
    // Codex round 8, and the most dangerous of the three: a response with
    // seventeen valid rooms and NO kill-switch record resolved to
    // `locked: false`, which CLEARS a lock banner that was previously and
    // correctly visible — while the rooms beside it still presented as current.
    // A page that quietly stops showing a lock is the worst single failure
    // available on this surface. Absent is not "unlocked"; it is unreadable,
    // and unreadable fails closed like everything else here.
    const live = deployment();
    const page = await loadPage(live.deps);

    const lockBanner = page.document.querySelector('[data-hq-lock]') as HTMLElement;
    const original = page.window.fetch as (input: string) => Promise<unknown>;

    const roomsPayload = HQ_ROOMS.map((room) => ({
      roomId: room.id,
      ordinal: room.ordinal,
      status: room.binding.kind === 'live' ? 'live' : room.binding.kind,
      liveness: 'dark',
      metrics: [],
      rows: [],
      emptyMessage: 'x',
      provenance: 'x',
    }));

    // First: HQ is genuinely locked, and the banner says so.
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              mode: 'live',
              killSwitch: { globalEngaged: true, engagedScopes: [] },
              rooms: roomsPayload,
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();
    expect(lockBanner.hidden).toBe(false);
    expect(lockBanner.textContent).toContain('HQ LOCKED');

    // Then: a document that simply omits the record.
    page.window.fetch = (input: string) => {
      if (String(input).split('?')[0] === CONTROL_ROUTES.state) {
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              generatedAt: new Date().toISOString(),
              mode: 'live',
              rooms: roomsPayload,
            }),
        });
      }
      return original(input);
    };
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    // The rooms must NOT still be presented as current beside a cleared lock.
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(bodyText(page.document, 'home')).toContain('cannot read');
    // And the page must say out loud that the lock is among what it no longer
    // claims, rather than silently dropping a red banner.
    expect(bodyText(page.document, 'home')).toContain('including whether HQ is locked');
    page.close();
  });

  it('bounds a stalled read on a browser with no AbortController', async () => {
    // Codex round 6. The timeout was armed but its callback did nothing when
    // there was no AbortController, so on such a browser the read still never
    // settled: the cycle deadline would eventually allow a NEW poll, but it
    // neither invalidated what was on screen nor cancelled the abandoned
    // promise. Stale canonical state stayed visible through repeated stalls.
    // A guarantee that only holds where a constructor happens to exist is not a
    // guarantee, so the timeout now resolves the read itself.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    // Take AbortController away, exactly as an old browser would.
    const hadAbort = page.window.AbortController;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (page.window as Record<string, unknown>).AbortController;
    expect(typeof page.window.AbortController).not.toBe('function');

    const original = page.window.fetch as (input: string, options?: unknown) => Promise<unknown>;
    let silent = true;
    page.window.fetch = (input: string, options?: { signal?: AbortSignal }) => {
      if (!silent || String(input).split('?')[0] !== CONTROL_ROUTES.state) return original(input, options);
      // Never resolves, never rejects, and nothing can abort it.
      return new Promise(() => {});
    };

    const realSetTimeout = page.window.setTimeout as (fn: () => void, ms: number) => number;
    let armedAtTimeout = 0;
    page.window.setTimeout = (fn: () => void, ms: number) => {
      if (ms === CLIENT_READ_TIMEOUT_MS) {
        armedAtTimeout += 1;
        return realSetTimeout(fn, 0);
      }
      return realSetTimeout(fn, ms);
    };

    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(armedAtTimeout).toBeGreaterThan(0);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(bodyText(page.document, 'home')).toContain('no answer within');

    // Not wedged either: the next poll hydrates, with no AbortController still.
    silent = false;
    (page.window.__hqStateChanged as () => void)();
    await page.settle();
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    (page.window as Record<string, unknown>).AbortController = hadAbort;
    page.close();
  });

  it('abandons a read that never answers, rather than wedging every later poll', async () => {
    // Codex round 5. A fetch that connects and then neither resolves nor
    // rejects — a stalled proxy, a hung host — left `inFlight` true forever:
    // every later poll was discarded, the last hydrated rooms stayed on screen
    // looking current, and not even a session expiry could take them down. A
    // fail-closed runtime that silence can wedge open is not fail-closed.
    const live = deployment();
    const page = await loadPage(live.deps);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');

    const original = page.window.fetch as (input: string, options?: unknown) => Promise<unknown>;
    let silent = true;
    page.window.fetch = (input: string, options?: { signal?: AbortSignal }) => {
      if (!silent || String(input).split('?')[0] !== CONTROL_ROUTES.state) return original(input, options);
      // Only the abort signal can end this.
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const failure = new Error('The user aborted a request.');
          failure.name = 'AbortError';
          reject(failure);
        });
      });
    };

    // Fire the runtime's OWN timer immediately instead of waiting out twelve
    // real seconds. The delay is matched exactly, so this cannot pass against a
    // runtime that arms no timeout, or arms one of a different length.
    const realSetTimeout = page.window.setTimeout as (fn: () => void, ms: number) => number;
    let armedAtTimeout = 0;
    page.window.setTimeout = (fn: () => void, ms: number) => {
      if (ms === CLIENT_READ_TIMEOUT_MS) {
        armedAtTimeout += 1;
        return realSetTimeout(fn, 0);
      }
      return realSetTimeout(fn, ms);
    };

    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    expect(armedAtTimeout).toBeGreaterThan(0);
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toBe('');
    expect(bodyText(page.document, 'home')).toContain('could not be reached');
    expect(bodyText(page.document, 'home')).toContain('no answer within');

    // And the runtime is not wedged: the very next poll hydrates again.
    silent = false;
    (page.window.__hqStateChanged as () => void)();
    await page.settle();
    expect(page.document.querySelector('[data-hq-stamp]')!.textContent).toContain('provenance live');
    page.close();
  });

  it('stops each room claiming the previous document’s provenance', async () => {
    // Per-room provenance is state-derived too. Left alone through
    // invalidation, every live room went on printing "as of <instant> ·
    // provenance live" while the header above it said no state had been read —
    // the same defect as the global stamp, one level further in (Codex round
    // 4).
    const live = deployment();
    const page = await loadPage(live.deps);
    const provenance = (roomId: string) =>
      panel(page.document, roomId).querySelector('[data-hq-room-provenance]')!.textContent ?? '';
    expect(provenance('home')).toContain('provenance live');

    live.setAccount(null);
    (page.window.__hqStateChanged as () => void)();
    await page.settle();

    for (const room of HQ_ROOMS) {
      if (room.binding.kind !== 'live') continue;
      const shown = provenance(room.id);
      expect(shown, room.id).not.toContain('provenance live');
      expect(shown, room.id).not.toContain('as of');
      // And it says something true rather than going blank: the binding's own
      // source, exactly as the server-rendered page states it.
      expect(shown, room.id).toBe(room.binding.source);
    }
    page.close();
  });

  it('leaves the rooms HQ does not record saying exactly what they said', async () => {
    // Their statement does not depend on a session, so an access failure must
    // not replace a true sentence with an access complaint.
    const before = await loadPage(deployment().deps);
    const signedOut = await loadPage(deployment(null).deps);
    for (const room of HQ_ROOMS) {
      if (room.binding.kind === 'live') continue;
      expect(bodyText(signedOut.document, room.id), room.id).toBe(bodyText(before.document, room.id));
      expect(bodyText(signedOut.document, room.id), room.id).toContain(room.binding.reason.slice(0, 40));
    }
    before.close();
    signedOut.close();
  });

  it('reports an unreachable HQ as unreachable, never as an empty one', async () => {
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(immersiveHtml(), {
      url: PAGE_URL,
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window: Record<string, unknown>) {
        window.fetch = () => Promise.reject(new Error('Failed to fetch'));
      },
    });
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const chip = dom.window.document.querySelector('[data-hq-access]')!;
    expect(chip.getAttribute('data-hq-access-state')).toBe('unreachable');
    expect(chip.textContent).toBe('HQ UNREACHABLE');
    expect(dom.window.document.querySelector('[data-hq-access-note]')!.textContent).toContain('Failed to fetch');
    dom.window.close();
  });
});
