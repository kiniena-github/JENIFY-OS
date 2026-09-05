/**
 * The Founder Command + Mission Room console surface (issue #254).
 *
 * Structural guarantees, checked without a browser: the static Command
 * Center carries the mount and no control; the console binds every path to
 * the canonical route verbatim; the grant rule is deny-by-default for the
 * three new controls; the transition targets are emitted from the server's
 * own table; and the immersive runtime still performs no write.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { CONTROL_GRANT_JS, CONTROL_FETCH_TARGETS, founderCommandConsoleScript } from '../src/ui/control-console.js';
import { CONTROL_ROUTES, handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { CLIENT_FETCH_TARGETS } from '../src/client/runtime.js';
import { MISSION_TRANSITIONS } from '../src/mission/states.js';
import { MissionStore } from '../src/mission/store.js';
import { submitFounderCommand } from '../src/mission/command.js';
import { roomById } from '../src/client/rooms.js';
import { setupFixture, type Fixture } from './application.fixture.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;
const site = buildSite(sample);
const index = site.get('index.html')!;
const immersive = site.get('immersive.html')!;

type Grant = {
  founderCommand: boolean;
  missionAmend: boolean;
  missionTransition: boolean;
  reason: string;
  missionReason: string;
};
const grantedControls = new Function(`${CONTROL_GRANT_JS}; return grantedControls;`)() as (session: unknown) => Grant;

describe('the Command Center carries the Founder Command mount, inert', () => {
  it('renders the section, the mount and the honest blocker text, with no control', () => {
    expect(index).toContain('FOUNDER COMMAND · MISSION ROOM');
    expect(index).toContain('<div data-founder-command-console></div>');
    expect(index).toContain('ZERO tasks and asks for clarification');
    expect(index).not.toContain('<button');
    expect(index).not.toContain('<form');
  });

  it('binds every mission path to the canonical route, verbatim', () => {
    expect(index).toContain(`var MISSIONS_PATH = ${JSON.stringify(CONTROL_ROUTES.missions)};`);
    expect(index).toContain(`var MISSION_AMEND_PATH = ${JSON.stringify(CONTROL_ROUTES.missionAmend)};`);
    expect(index).toContain(`var MISSION_TRANSITION_PATH = ${JSON.stringify(CONTROL_ROUTES.missionTransition)};`);
    for (const route of [CONTROL_ROUTES.missions, CONTROL_ROUTES.missionAmend, CONTROL_ROUTES.missionTransition]) {
      expect(CONTROL_FETCH_TARGETS).toContain(route);
    }
  });

  it('emits the transition targets from the server’s own table', () => {
    const script = founderCommandConsoleScript();
    expect(script).toContain(`var TRANSITIONS = ${JSON.stringify(MISSION_TRANSITIONS)};`);
  });

  it('states every access state it can be in', () => {
    const script = founderCommandConsoleScript();
    for (const state of ['checking', 'unauthenticated', 'unauthorized', 'unavailable', 'offline', 'error', 'live']) {
      expect(script, state).toContain(`'${state}'`);
    }
    // And says what the zero means.
    expect(script).toContain('Zero is the recorded answer, not a loading state.');
    // And never draws the order text, because it never receives it.
    expect(script).toContain('stay server-side');
  });

  it('links the Mission Room’s long form to the page that holds the console', () => {
    expect(roomById('mission-room')!.page).toBe('index.html');
  });
});

describe('the grant rule is deny-by-default for the three mission controls', () => {
  it('grants nothing for a hostile session answer', () => {
    for (const hostile of [undefined, null, {}, { ok: true, founder: true }, { ok: true, founder: true, controls: 'all' }]) {
      const verdict = grantedControls(hostile);
      expect(verdict.founderCommand, JSON.stringify(hostile)).toBe(false);
      expect(verdict.missionAmend, JSON.stringify(hostile)).toBe(false);
      expect(verdict.missionTransition, JSON.stringify(hostile)).toBe(false);
    }
  });

  it('treats truthy-but-not-true flags as not granted, and literal true as granted', () => {
    expect(
      grantedControls({ ok: true, founder: true, controls: { founderCommand: 'yes', missionAmend: 1, missionTransition: {} } }),
    ).toMatchObject({ founderCommand: false, missionAmend: false, missionTransition: false });
    expect(
      grantedControls({ ok: true, founder: true, controls: { founderCommand: true, missionAmend: false, missionTransition: true } }),
    ).toMatchObject({ founderCommand: true, missionAmend: false, missionTransition: true });
  });
});

describe('the immersive runtime still performs no write', () => {
  it('declares only its two read routes, and the page names no mission route', () => {
    expect([...CLIENT_FETCH_TARGETS].sort()).toEqual([CONTROL_ROUTES.session, CONTROL_ROUTES.state].sort());
    for (const route of [CONTROL_ROUTES.missions, CONTROL_ROUTES.missionAmend, CONTROL_ROUTES.missionTransition]) {
      expect(immersive).not.toContain(route);
    }
  });
});

describe('the grant rule names an absent mission store (Opus second pass on a849af8, P2)', () => {
  const FINE = {
    mutationsEnabled: true,
    trustedOriginConfigured: true,
    requestOriginAllowed: true,
    requestOriginSource: 'referer',
    directOrder: true,
    approve: true,
    deny: true,
    founderCommand: false,
    missionAmend: false,
    missionTransition: false,
  };

  it('blames the store in missionReason and leaves the order reason alone', () => {
    // `missionCoreAttached` was published and never read: with everything
    // else correct, a Founder was told the principal or the registry withheld
    // the mission controls. The two reasons now differ in exactly this branch.
    const verdict = grantedControls({ ok: true, founder: true, controls: { ...FINE, missionCoreAttached: false } });
    expect(verdict.founderCommand).toBe(false);
    expect(verdict.missionReason).toContain('No mission store is attached');
    // The blaming sentence is gone; the reason names the principal only to
    // say it is NOT the cause.
    expect(verdict.missionReason).not.toContain('principal may not hold');
    expect(verdict.missionReason).toContain('not what withheld it');
    expect(verdict.reason).not.toContain('mission store');
  });

  it('falls back to the authority/registry sentence when the store IS attached', () => {
    const verdict = grantedControls({ ok: true, founder: true, controls: { ...FINE, missionCoreAttached: true } });
    expect(verdict.missionReason).toContain('the principal may not hold that authority');
    expect(verdict.missionReason).toBe(verdict.reason);
  });

  it('keeps the server’s own message first, and the three deployment reasons before the store', () => {
    // Order matters: a read-only deployment or an untrusted origin is the
    // cause even when no store is attached, because the store would not have
    // helped. The stated server message outranks all of them.
    const stated = grantedControls({ ok: true, founder: true, message: 'server said so', controls: { ...FINE, missionCoreAttached: false } });
    expect(stated.missionReason).toBe('server said so');
    const readOnly = grantedControls({ ok: true, founder: true, controls: { ...FINE, mutationsEnabled: false, missionCoreAttached: false } });
    expect(readOnly.missionReason).toContain('read-only');
    for (const hostile of [undefined, null, { ok: false }]) {
      const off = grantedControls(hostile);
      expect(off.missionReason, JSON.stringify(hostile)).toBe(off.reason);
      expect(off.missionReason.length).toBeGreaterThan(0);
    }
  });
});

describe('every fetch in the mission console states its credentials mode (Opus second pass on a849af8, nit 3)', () => {
  it('carries credentials: same-origin on the session probe, the list read and the POST helper alike', () => {
    // The /session probe omitted `credentials` while the list read two
    // functions down stated it. Same-origin is the browser default, so the
    // two behaved alike — but a pair of calls that differ in a security
    // option reads as a difference that is not there, and a future stricter
    // default would have split them. Every fetch head in the script is
    // audited, so the pair cannot drift apart again.
    const script = founderCommandConsoleScript();
    const heads = [...script.matchAll(/fetch\([^;]*?\)\)/g)].map((match) => match[0]);
    expect(heads.length).toBeGreaterThanOrEqual(3);
    for (const head of heads) {
      expect(head, head).toContain("credentials: 'same-origin'");
    }
  });
});

/* ------------------------------------------------------------------ */
/* The composer does not outlive its session (P2) — in a real DOM      */
/* ------------------------------------------------------------------ */

/**
 * Opus second pass on `a849af8`. The console set "Live: this session is
 * granted Founder Command as <name>." once at load; the 401 branch of the
 * poll called only `clearMissions`, which touched the list and the detail and
 * never the note or the composer. After a session expired between polls the
 * mount read "Live …" directly above "Mission list: NOT SIGNED IN", and the
 * Record Mission button stayed enabled and would submit.
 *
 * This runs the EMITTED page in jsdom with `fetch` answered by the REAL
 * control API and the session resolver flipped between polls, the way
 * `command-center-live-composer.test.ts` proves the order composer. The poll
 * timer is captured rather than waited for.
 */
describe('the Founder Command composer is withdrawn when the session is gone', () => {
  const PAGE_ORIGIN = 'http://localhost:3101';
  const PAGE_URL = `${PAGE_ORIGIN}/hq/index.html`;
  const ACCOUNT: AuthenticatedAccount = {
    realmId: 'realm',
    accountId: 'acc-1',
    displayName: 'Proof Founder',
    authenticatedAt: new Date().toISOString(),
  };

  interface Loaded {
    dom: JSDOM;
    calls: string[];
    errors: string[];
    setSession(account: AuthenticatedAccount | null): void;
    /** Fire every interval the page registered — the mission poll among them. */
    tick(): Promise<void>;
  }

  async function loadPage(seed?: (fixture: Fixture, missions: MissionStore) => void): Promise<Loaded> {
    const fixture = setupFixture();
    registerDirectOrderCapability(fixture.db);
    fixture.principals.register({
      id: 'hq-proof-originator',
      displayName: 'Proof Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const missions = new MissionStore(fixture.db);
    seed?.(fixture, missions);
    let current: AuthenticatedAccount | null = ACCOUNT;
    const api: ControlApiDeps = {
      ops: fixture.ops,
      sessions: { resolve: () => current },
      founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-proof-originator' }],
      allowedOrigins: [PAGE_ORIGIN],
      secretsEnv: {},
      mutationsEnabled: true,
      missions,
    };
    const calls: string[] = [];
    const errors: string[] = [];
    const intervals: (() => void)[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
    const dom = new JSDOM(index, {
      url: PAGE_URL,
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window: Record<string, unknown>) {
        window.setInterval = (callback: () => void) => {
          intervals.push(callback);
          return intervals.length;
        };
        window.fetch = (input: string) => {
          const path = String(input).split('?')[0]!;
          calls.push(path);
          if (path.endsWith(SNAPSHOT_FILENAME)) {
            return Promise.resolve({ status: 404, json: () => Promise.reject(new Error('no snapshot')) });
          }
          const request: ControlRequest = { method: 'GET', path, headers: { referer: PAGE_URL } };
          const result = handleControlRequest(request, api);
          return Promise.resolve({ status: result.status, json: () => Promise.resolve(result.body) });
        };
      },
    });
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await settle();
    return {
      dom,
      calls,
      errors,
      setSession(account) {
        current = account;
      },
      async tick() {
        for (const callback of intervals) callback();
        await settle();
      },
    };
  }

  function consoleOf(dom: JSDOM) {
    const document = dom.window.document;
    const note = document.querySelector('[data-founder-command-state]');
    const list = document.querySelector('[data-mission-list-state]');
    const buttons = [...document.querySelectorAll('[data-founder-command-console] button')] as unknown as {
      textContent: string;
      disabled: boolean;
    }[];
    return {
      state: note?.getAttribute('data-founder-command-state') ?? null,
      note: note?.textContent ?? '',
      listState: list?.getAttribute('data-mission-list-state') ?? null,
      formPresent: document.querySelector('[data-founder-command-form]') != null,
      submitEnabled: buttons.some((button) => button.textContent === 'Record Mission' && !button.disabled),
    };
  }

  it('says Live and draws Record Mission under a grant, then withdraws both on the first 401', async () => {
    const page = await loadPage();
    expect(page.errors).toEqual([]);
    const live = consoleOf(page.dom);
    expect(live.state).toBe('granted');
    expect(live.note).toContain('Live: this session is granted Founder Command as Proof Founder.');
    expect(live.formPresent).toBe(true);
    expect(live.submitEnabled).toBe(true);
    expect(live.listState).toBe('live');

    // The session expires between polls: the resolver answers null, the
    // next list read is a 401.
    page.setSession(null);
    await page.tick();
    const gone = consoleOf(page.dom);
    expect(gone.listState).toBe('unauthenticated');
    // THE ASSERTIONS THE FINDING NEEDED: no "Live", no submit.
    expect(gone.note).not.toContain('Live');
    expect(gone.state).toBe('off');
    expect(gone.note).toContain('FOUNDER COMMAND IS OFF');
    expect(gone.note).toContain('NOT SIGNED IN');
    expect(gone.note).toContain('withdrawn');
    expect(gone.formPresent).toBe(false);
    expect(gone.submitEnabled).toBe(false);
    expect(page.errors).toEqual([]);
  });

  it('redraws the composer only through a fresh /session grant once the session is back', async () => {
    // A list that answers again is not a grant. The console asks /session
    // again and draws exactly what THAT answer grants — the same thing a page
    // reload would do, without leaving a withdrawn composer withdrawn forever
    // after a transient expiry.
    const page = await loadPage();
    page.setSession(null);
    await page.tick();
    expect(consoleOf(page.dom).formPresent).toBe(false);
    const sessionProbesBefore = page.calls.filter((path) => path === CONTROL_ROUTES.session).length;

    page.setSession(ACCOUNT);
    await page.tick();
    const back = consoleOf(page.dom);
    expect(page.calls.filter((path) => path === CONTROL_ROUTES.session).length).toBe(sessionProbesBefore + 1);
    expect(back.state).toBe('granted');
    expect(back.note).toContain('Live: this session is granted Founder Command');
    expect(back.formPresent).toBe(true);
    expect(back.submitEnabled).toBe(true);
    expect(back.listState).toBe('live');
    expect(page.errors).toEqual([]);
  });

  it('RENDERS a zero-task mission as zero — in the list chip and in the opened detail', async () => {
    // Mutation-testing pass on `b3f72d1` (nit). The rest of this file pins
    // substrings of the generated source, which proves the sentence exists in
    // the script and nothing about what the page draws. This runs the emitted
    // page against a REAL clarification-blocked mission (recorded with zero
    // tasks through the real command path), reads the drawn list row, clicks
    // Open, and reads the drawn detail.
    const page = await loadPage((fixture, missions) => {
      const recorded = submitFounderCommand(
        fixture.ops,
        missions,
        { command: 'Should we ship the export?', route: 'CLAUDE', requestedBy: 'hq-proof-originator', title: 'Unclear order' },
        {},
      );
      if (!recorded.ok) throw new Error(recorded.error.message);
      if (recorded.data.tasks.length !== 0) throw new Error('fixture must hold zero tasks');
    });
    expect(page.errors).toEqual([]);
    const document = page.dom.window.document;
    const rows = [...document.querySelectorAll('[data-mission-row]')];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.textContent).toContain('Unclear order');
    const chips = [...row.querySelectorAll('.chip')].map((chip) => chip.textContent);
    expect(chips).toContain('0 task(s)');
    expect(chips).toContain('needs clarification');
    expect(chips).toContain('Blocked');
    // Nothing is drawn as a task, and no detail is open yet.
    expect(document.querySelectorAll('.mission-task')).toHaveLength(0);
    expect(document.querySelector('[data-mission-detail-for]')).toBeNull();

    const open = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Open') as
      | { click(): void }
      | undefined;
    expect(open).toBeDefined();
    open!.click();
    const detail = document.querySelector('[data-mission-detail-for]')!;
    expect(detail).not.toBeNull();
    expect(detail.textContent).toContain('Task plan — 0 task(s)');
    expect(detail.textContent).toContain('This mission holds no task.');
    expect(detail.textContent).toContain('The order needs clarification');
    expect(detail.querySelectorAll('.mission-task')).toHaveLength(0);
    // The intent line reports the chain as intact AND anchored (no
    // UNANCHORED caveat) for a mission recorded by this code.
    expect(detail.textContent).toContain('chain intact');
    expect(detail.textContent).not.toContain('UNANCHORED');
    expect(page.errors).toEqual([]);
  });
});
