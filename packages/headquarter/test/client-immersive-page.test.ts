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
import { CLIENT_FETCH_TARGETS } from '../src/client/runtime.js';
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

  it('builds every string through textContent, never markup', () => {
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('outerHTML');
    expect(html).not.toContain('insertAdjacentHTML');
    expect(html).not.toContain('document.write');
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
