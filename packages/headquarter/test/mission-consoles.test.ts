/**
 * The EMITTED Founder Command and Mission Room consoles, executed as a
 * browser executes them (Phase 3, issue #254 — the same pattern as
 * `command-center-live-composer.test.ts`: real emitted page, real inline
 * scripts, `fetch` answered by the REAL control API against a real
 * `HeadquarterOperations`).
 *
 * What this proves that the string-level audits cannot: the mount, the
 * script, the grant rule, the response shape and the server's own grants
 * meet in one DOM and produce a working composer — or, without the grant,
 * one truthful line and no control at all.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { ControlRequest } from '../src/live/auth.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { setupFixture, type Fixture } from './application.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';

function deployment(options: { grant?: boolean; founder?: boolean } = {}): {
  api: ControlApiDeps;
  fixture: Fixture;
} {
  const fixture = setupFixture();
  registerMissionCommandCapability(fixture.db);
  fixture.principals.register({
    id: 'hq-mission-founder',
    displayName: 'Proof Founder',
    originateCapabilities: options.grant === false ? [] : [MISSION_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  const api: ControlApiDeps = {
    ops: fixture.ops,
    sessions: {
      resolve: () =>
        options.founder === false
          ? {
              realmId: 'realm',
              accountId: 'acc-staff',
              displayName: 'Staff',
              authenticatedAt: new Date().toISOString(),
            }
          : {
              realmId: 'realm',
              accountId: 'acc-1',
              displayName: 'Proof Founder',
              authenticatedAt: new Date().toISOString(),
            },
    },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-mission-founder' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
  };
  return { api, fixture };
}

function pageHtml(file: string): string {
  const page = buildSite(sample).get(file);
  if (page == null) throw new Error(`buildSite emitted no ${file}`);
  return page;
}

async function loadPage(file: string, api: ControlApiDeps): Promise<JSDOM> {
  const pageUrl = `${PAGE_ORIGIN}/hq/${file}`;
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(pageHtml(file), {
    url: pageUrl,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window: Record<string, unknown>) {
      window.fetch = (input: string, init?: { method?: string; body?: string }) => {
        const path = String(input).split('?')[0]!;
        if (path.endsWith(SNAPSHOT_FILENAME)) {
          return Promise.resolve({ status: 404, json: () => Promise.reject(new Error('no snapshot')) });
        }
        const method = init?.method ?? 'GET';
        const request: ControlRequest = {
          method,
          path,
          headers:
            method === 'GET'
              ? { referer: pageUrl }
              : { origin: PAGE_ORIGIN, 'content-type': 'application/json', referer: pageUrl },
          body: init?.body != null ? (JSON.parse(init.body) as unknown) : undefined,
        };
        const result = handleControlRequest(request, api);
        return Promise.resolve({ status: result.status, json: () => Promise.resolve(result.body) });
      };
    },
  });
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return dom;
}

function setValue(element: Element | null, value: string): void {
  (element as HTMLInputElement | HTMLTextAreaElement).value = value;
}

describe('the Founder Command composer on the emitted Command Center page', () => {
  it('draws the composer only when /session grants missionCommand', async () => {
    const { api } = deployment();
    const dom = await loadPage('index.html', api);
    const state = dom.window.document
      .querySelector('[data-mission-command-state]')!
      .getAttribute('data-mission-command-state');
    expect(state).toBe('granted');
    expect(dom.window.document.querySelector('[data-mission-command-form]')).not.toBeNull();
  });

  it('draws nothing and says why when the grant is withheld', async () => {
    const { api } = deployment({ grant: false });
    const dom = await loadPage('index.html', api);
    const note = dom.window.document.querySelector('[data-mission-command-state]')!;
    expect(note.getAttribute('data-mission-command-state')).toBe('off');
    expect(note.textContent).toContain('FOUNDER COMMAND IS OFF');
    const mount = dom.window.document.querySelector('[data-mission-command-console]')!;
    expect(mount.querySelector('button')).toBeNull();
  });

  it('commands a real canonical mission end to end from the page', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage('index.html', api);
    const form = dom.window.document.querySelector('[data-mission-command-form]')!;
    setValue(form.querySelector('input[aria-label="Mission title"]'), 'Improve QOS website speed');
    setValue(
      form.querySelector('textarea[aria-label="Mission objective"]'),
      'Reduce load times without changing the visual design',
    );
    setValue(
      form.querySelector('textarea[aria-label="Mission constraints"]'),
      'Do not change the visual design\nDo not deploy production',
    );
    setValue(
      form.querySelector('textarea[aria-label="Raw Founder order"]'),
      'Improve the QOS website speed without changing the visual design.',
    );
    (form.querySelector('button') as HTMLButtonElement).click();
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    const outcome = dom.window.document.querySelector('[data-mission-command-outcome]')!;
    expect(outcome.textContent).toContain('Mission commanded as mission-');
    expect(outcome.textContent).toContain('No task was created');

    const missions = fixture.ops.listMissions();
    expect(missions).toHaveLength(1);
    expect(missions[0]!.createdBy).toBe('hq-mission-founder');
    expect(missions[0]!.constraints).toEqual([
      'Do not change the visual design',
      'Do not deploy production',
    ]);
    // The raw order is preserved server-side and never re-enters the page.
    expect(fixture.ops.getMissionIntentHistory(missions[0]!.id)[0]!.body).toContain(
      'Improve the QOS website speed without changing the visual design.',
    );
    expect(dom.window.document.body.textContent).not.toContain(
      'Improve the QOS website speed without changing the visual design.',
    );
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM op_tasks').get()).toEqual({ n: 0 });
  });
});

describe('the Mission Room console on the emitted Projects page', () => {
  it('renders zero commanded missions as an explicit zero', async () => {
    const { api } = deployment();
    const dom = await loadPage('projects.html', api);
    const note = dom.window.document.querySelector('[data-missions-console-state]')!;
    expect(note.getAttribute('data-missions-console-state')).toBe('live');
    expect(note.textContent).toContain('0 commanded mission(s)');
    const list = dom.window.document.querySelector('[data-missions-list]')!;
    expect(list.textContent).toContain('0 means 0');
    expect(list.querySelectorAll('[data-mission-card]')).toHaveLength(0);
  });

  it('renders the canonical record — objective, constraints, plan, authority truth', async () => {
    const { api, fixture } = deployment();
    fixture.ops.commandMission({
      title: 'Improve QOS website speed',
      objective: 'Reduce load times without changing the visual design',
      constraints: ['Do not change the visual design'],
      planItems: ['Measure current load times'],
      requestedBy: 'hq-mission-founder',
    });
    const dom = await loadPage('projects.html', api);
    const card = dom.window.document.querySelector('[data-mission-card]')!;
    expect(card.textContent).toContain('Improve QOS website speed');
    expect(card.textContent).toContain('Reduce load times without changing the visual design');
    expect(card.textContent).toContain('Do not change the visual design');
    expect(card.textContent).toContain('Measure current load times');
    expect(card.textContent).toContain('no task exists for this item yet');
    expect(card.textContent).toContain('Acceptance criteria: not yet decided');
    expect(card.textContent).toContain('execution approvals stay at the task level');
    // The lifecycle controls advertise exactly the canonical map for planned.
    const buttons = [...card.querySelectorAll('.decision-controls button')].map(
      (button) => button.textContent,
    );
    expect(buttons).toEqual(['working', 'blocked', 'cancelled']);
  });

  it('moves a mission through a real transition from the page, expectedStatus and all', async () => {
    const { api, fixture } = deployment();
    const { mission } = (fixture.ops.commandMission({
      title: 'T',
      objective: 'O',
      requestedBy: 'hq-mission-founder',
    }) as { ok: true; data: { mission: { id: string } } }).data;
    const dom = await loadPage('projects.html', api);
    const card = dom.window.document.querySelector('[data-mission-card]')!;
    const working = [...card.querySelectorAll('.decision-controls button')].find(
      (button) => button.textContent === 'working',
    ) as HTMLButtonElement;
    working.click();
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.ops.getMission(mission.id)!.status).toBe('working');
  });

  it('demands the note client-side exactly where the server would', async () => {
    const { api, fixture } = deployment();
    fixture.ops.commandMission({ title: 'T', objective: 'O', requestedBy: 'hq-mission-founder' });
    const dom = await loadPage('projects.html', api);
    const card = dom.window.document.querySelector('[data-mission-card]')!;
    const cancel = [...card.querySelectorAll('.decision-controls button')].find(
      (button) => button.textContent === 'cancelled',
    ) as HTMLButtonElement;
    cancel.click();
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.window.document.body.textContent).toContain('requires a recorded note');
    expect(fixture.ops.listMissions()[0]!.status).toBe('planned');
  });

  it('shows the list read-only, with the reason, when the command grant is withheld', async () => {
    const { api, fixture } = deployment({ grant: false });
    // Commanded by a DIFFERENT principal that does hold the grant.
    fixture.principals.register({
      id: 'other-founder',
      displayName: 'Other Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    fixture.ops.commandMission({ title: 'T', objective: 'O', requestedBy: 'other-founder' });
    const dom = await loadPage('projects.html', api);
    const list = dom.window.document.querySelector('[data-missions-list]')!;
    expect(list.querySelectorAll('[data-mission-card]')).toHaveLength(1);
    expect(list.textContent).toContain('Lifecycle controls are off for this session');
    expect(list.querySelector('button')).toBeNull();
  });

  it('refuses the whole record to a signed-in non-Founder, with no mission leak', async () => {
    const { api, fixture } = deployment({ founder: false });
    fixture.ops.commandMission({ title: 'Secret direction', objective: 'O', requestedBy: 'hq-mission-founder' });
    const dom = await loadPage('projects.html', api);
    const note = dom.window.document.querySelector('[data-missions-console-state]')!;
    expect(note.getAttribute('data-missions-console-state')).toBe('off');
    expect(dom.window.document.body.textContent).not.toContain('Secret direction');
  });
});
