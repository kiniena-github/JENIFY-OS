/**
 * The EMITTED Command Center's Mission Core console, executed as a browser
 * executes it (Phase 3, issue #253).
 *
 * Same reasoning as `command-center-live-composer.test.ts`: string assertions
 * over the script prove the rule that ships, and only a DOM running the real
 * page against the real control API proves that the rule DRAWS what the
 * Founder needs. This suite loads the real `index.html`, lets its scripts run,
 * and answers every fetch — GET and POST — with `handleControlRequest` over a
 * real `HeadquarterOperations`. It pins the five explicit states the console
 * must show in words (checking → live / off / empty / error-offline /
 * unauthorized), that a Founder command drawn here lands as a canonical
 * mission and is listed back WITHOUT its raw text, and that cancellation runs
 * through the same real route with the displayed intent version as its fence.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { CONTROL_ROUTES, handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { ControlRequest } from '../src/live/auth.js';
import { FOUNDER_COMMAND_CAPABILITY, registerFounderCommandCapability } from '../src/application/mission-core.js';
import { CONTROL_GRANT_JS, missionConsoleScript } from '../src/ui/control-console.js';
import { setupFixture, type Fixture } from './application.fixture.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';
const PAGE_URL = `${PAGE_ORIGIN}/hq/index.html`;
const RAW_MARKER = 'RAW-CONSOLE-MARKER-9912';

function deployment(options: { grant?: boolean; approvalAuthority?: boolean; founder?: boolean } = {}): { deps: ControlApiDeps; fixture: Fixture } {
  const fixture = setupFixture();
  registerFounderCommandCapability(fixture.db);
  fixture.principals.register({
    id: 'hq-proof-founder',
    displayName: 'Proof Founder',
    originateCapabilities: options.grant === false ? [] : [FOUNDER_COMMAND_CAPABILITY.id],
    approvalAuthority: options.approvalAuthority ?? true,
    active: true,
  });
  return {
    fixture,
    deps: {
      ops: fixture.ops,
      sessions: {
        resolve: () =>
          options.founder === false
            ? null
            : { realmId: 'realm', accountId: 'acc-1', displayName: 'Proof Founder', authenticatedAt: new Date().toISOString() },
      },
      founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-proof-founder' }],
      allowedOrigins: [PAGE_ORIGIN],
      secretsEnv: {},
      mutationsEnabled: true,
    },
  };
}

interface Loaded {
  dom: JSDOM;
  calls: { method: string; path: string }[];
  errors: string[];
  settle(): Promise<void>;
}

/**
 * Load the emitted page with `fetch` answered by the real control API. Unlike
 * the direct-order harness this one honours the METHOD and BODY of the call,
 * because the mission console posts, and attaches the `Origin` a browser
 * attaches to a same-origin POST.
 */
async function loadPage(api: ControlApiDeps, options: { offline?: boolean } = {}): Promise<Loaded> {
  const calls: { method: string; path: string }[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
  const html = buildSite(sample).get('index.html');
  if (html == null) throw new Error('buildSite emitted no index.html');

  const dom = new JSDOM(html, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window: Record<string, unknown>) {
      window.fetch = (input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
        const path = String(input).split('?')[0]!;
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ method, path });
        if (path.endsWith(SNAPSHOT_FILENAME)) {
          return Promise.resolve({ status: 404, json: () => Promise.reject(new Error('no snapshot')) });
        }
        if (options.offline) return Promise.reject(new Error('network down'));
        const request: ControlRequest = {
          method,
          path,
          headers:
            method === 'GET'
              ? { referer: PAGE_URL }
              : { origin: PAGE_ORIGIN, 'content-type': init?.headers?.['content-type'] ?? 'application/json', referer: PAGE_URL },
          body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
        };
        const result = handleControlRequest(request, api);
        return Promise.resolve({ status: result.status, json: () => Promise.resolve(result.body) });
      };
    },
  });
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  return { dom, calls, errors, settle };
}

function consoleOf(dom: JSDOM) {
  const document = dom.window.document;
  const note = document.querySelector('[data-mission-console-state]');
  const list = document.querySelector('[data-mission-list]');
  return {
    mountPresent: document.querySelector('[data-mission-console]') != null,
    state: note?.getAttribute('data-mission-console-state') ?? null,
    reason: note?.textContent ?? '',
    formPresent: document.querySelector('[data-mission-console-form]') != null,
    textareas: document.querySelectorAll('[data-mission-console] textarea').length,
    buttons: [...document.querySelectorAll('[data-mission-console] button')].map((button) => button.textContent),
    listState: list?.getAttribute('data-mission-list-state') ?? null,
    listText: list?.textContent ?? '',
    cards: [...document.querySelectorAll('[data-mission]')].map((card) => ({
      id: card.getAttribute('data-mission'),
      status: card.getAttribute('data-mission-status'),
      text: card.textContent ?? '',
      tasks: card.querySelectorAll('[data-mission-task]').length,
      decisions: card.querySelectorAll('[data-mission-decision]').length,
      cancel: card.querySelector('[data-mission-cancel]') != null,
    })),
    outcome: document.querySelector('[data-mission-console-outcome]')?.textContent ?? '',
  };
}

describe('the static page is inert and mounts the console', () => {
  it('ships the Mission Core section with no form, button or input in the markup', () => {
    const html = buildSite(sample).get('index.html')!;
    expect(html).toContain('<h2>FOUNDER COMMAND — MISSION CORE</h2>');
    expect(html).toContain('id="founder-command"');
    expect(html).toContain('<div data-mission-console></div>');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  });

  it('extends the ONE shipped grant rule rather than adding a second one', () => {
    const grant = new Function(`${CONTROL_GRANT_JS}; return grantedControls;`)() as (session: unknown) => Record<string, unknown>;
    expect(grant(null)).toMatchObject({ founderCommand: false, cancelMission: false });
    expect(grant({ ok: true, founder: true, controls: { founderCommand: 'yes', cancelMission: 1 } })).toMatchObject({ founderCommand: false, cancelMission: false });
    expect(grant({ ok: true, founder: true, controls: { founderCommand: true, cancelMission: true } })).toMatchObject({ founderCommand: true, cancelMission: true });
    expect(missionConsoleScript()).toContain('grantedControls(result.body)');
  });
});

describe('the emitted console draws exactly what /session grants', () => {
  it('under a full grant: live note, a composer, and an EMPTY list stated as empty', async () => {
    const { deps } = deployment();
    const { dom, errors, calls } = await loadPage(deps);
    expect(errors, 'the page must not throw before it draws').toEqual([]);
    const view = consoleOf(dom);
    expect(view.mountPresent).toBe(true);
    expect(view.state, view.reason).toBe('granted');
    expect(view.formPresent).toBe(true);
    expect(view.textareas).toBe(1);
    expect(view.buttons).toEqual(['Issue Founder Command']);
    expect(view.listState).toBe('empty');
    expect(view.listText).toContain('No Founder mission is recorded');
    expect(view.listText).toContain('not a loading failure');
    expect(view.cards).toEqual([]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(`GET ${CONTROL_ROUTES.missions}`);
  });

  it('without the originate grant: composer OFF with the server’s reason, list still readable', async () => {
    const { dom } = await loadPage(deployment({ grant: false }).deps);
    const view = consoleOf(dom);
    expect(view.state).toBe('off');
    expect(view.reason).toContain('MISSION CONTROLS ARE OFF');
    expect(view.reason).toContain('the principal may not hold that authority');
    expect(view.textareas).toBe(0);
    expect(view.buttons).toEqual([]);
    expect(view.listState).toBe('empty');
  });

  it('with no session: off, and the list states it is unauthorized rather than empty', async () => {
    const { dom, calls } = await loadPage(deployment({ founder: false }).deps);
    const view = consoleOf(dom);
    expect(view.state).toBe('off');
    expect(view.listState).toBe('unauthorized');
    expect(view.listText).toContain('resolved Founder session');
    expect(view.textareas).toBe(0);
    // It never even asked for the list.
    expect(calls.some((call) => call.path === CONTROL_ROUTES.missions)).toBe(false);
  });

  it('when the control API is unreachable: off and offline, claiming nothing', async () => {
    const { dom } = await loadPage(deployment().deps, { offline: true });
    const view = consoleOf(dom);
    expect(view.state).toBe('off');
    expect(view.reason).toContain('not reachable');
    expect(view.listState).toBe('offline');
    expect(view.cards).toEqual([]);
  });
});

describe('a Founder command issued from the console becomes a canonical mission, listed without its text', () => {
  it('creates, re-reads, shows what HQ understood, and offers a real cancel', async () => {
    const { deps, fixture } = deployment();
    const { dom, settle, errors } = await loadPage(deps);
    const document = dom.window.document;
    const textarea = document.querySelector('[data-mission-console] textarea') as unknown as { value: string };
    const title = document.querySelector('[data-mission-console] input[aria-label="Mission title"]') as unknown as { value: string };
    textarea.value = `Improve the QOS website speed without changing the design or deploying production. Internal note ${RAW_MARKER}.`;
    title.value = 'QOS speed';
    (document.querySelector('[data-mission-console] button') as unknown as { click(): void }).click();
    await settle();
    expect(errors).toEqual([]);

    const view = consoleOf(dom);
    expect(view.outcome).toContain('created, status planned');
    expect(view.outcome).toContain('HQ understood the objective as: “Improve the QOS website speed”');
    expect(view.outcome).toContain('2 do-not rule(s), 3 planned task(s) and 0 decision(s)');
    // The composer is cleared after a confirmed outcome; the text is not echoed.
    expect(textarea.value).toBe('');
    // Canonical: the mission exists server-side, created by the mapped principal.
    const missions = fixture.ops.missions.list();
    expect(missions).toHaveLength(1);
    expect(missions[0]!.createdBy).toBe('hq-proof-founder');
    expect(missions[0]!.actorAuthentication).toBe('authenticated_os_session');

    // Listed back, in full, without the raw command anywhere on the page.
    expect(view.listState).toBe('live');
    expect(view.cards).toHaveLength(1);
    const card = view.cards[0]!;
    expect(card.id).toBe(missions[0]!.id);
    expect(card.status).toBe('planned');
    expect(card.tasks).toBe(3);
    expect(card.decisions).toBe(0);
    expect(card.text).toContain('QOS speed');
    expect(card.text).toContain('Objective (as HQ understood it): Improve the QOS website speed');
    expect(card.text).toContain('Do not: changing the design · deploying production');
    expect(card.text).toContain('the command text stays server-side');
    expect(card.text).toContain('No canonical work opened yet. Nothing is running for this task.');
    expect(card.text).toContain('No evidence link has been submitted');
    expect(card.cancel).toBe(true);
    expect(document.body.textContent).not.toContain(RAW_MARKER);
    // No fabricated figure anywhere on the card.
    for (const forbidden of ['%', 'ETA', 'cost', 'tokens']) expect(card.text).not.toContain(forbidden);

    // Cancel through the real route, fenced on the version the card displayed.
    const reason = document.querySelector('[data-mission] input[type="text"]') as unknown as { value: string };
    reason.value = 'Superseded by the platform rewrite';
    (document.querySelector('[data-mission-cancel]') as unknown as { click(): void }).click();
    await settle();
    const after = consoleOf(dom);
    expect(after.cards[0]!.status).toBe('cancelled');
    expect(after.cards[0]!.cancel).toBe(false);
    expect(after.cards[0]!.text).toContain('Outcome: cancelled by hq-proof-founder');
    expect(fixture.ops.missions.list()[0]!.status).toBe('cancelled');
  });

  it('draws a Founder-gate command as BLOCKED with the decision, and offers no cancel without approval authority', async () => {
    const { deps } = deployment({ approvalAuthority: false });
    const { dom, settle } = await loadPage(deps);
    const document = dom.window.document;
    (document.querySelector('[data-mission-console] textarea') as unknown as { value: string }).value = 'Fix the header and deploy it to production.';
    (document.querySelector('[data-mission-console] button') as unknown as { click(): void }).click();
    await settle();
    const view = consoleOf(dom);
    expect(view.outcome).toContain('1 decision(s) needing you');
    expect(view.outcome).toContain('BLOCKED until you decide them');
    expect(view.cards[0]!.status).toBe('blocked');
    expect(view.cards[0]!.decisions).toBe(1);
    expect(view.cards[0]!.text).toContain('Founder hard gate');
    expect(view.cards[0]!.cancel).toBe(false);
  });

  it('reports a refusal in the server’s words and creates nothing', async () => {
    const { deps, fixture } = deployment();
    const { dom, settle } = await loadPage(deps);
    const document = dom.window.document;
    (document.querySelector('[data-mission-console] textarea') as unknown as { value: string }).value = 'Rotate nothing; api_key: sk-abcdefghijklmnopqrstuvwxyz';
    (document.querySelector('[data-mission-console] button') as unknown as { click(): void }).click();
    await settle();
    const view = consoleOf(dom);
    expect(view.outcome).toContain('Refused (unsafe_command)');
    expect(view.outcome).toContain('Nothing was created.');
    expect(fixture.ops.missions.list()).toEqual([]);
    expect(view.listState).toBe('empty');
  });
});
