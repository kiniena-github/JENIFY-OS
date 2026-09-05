/**
 * The EMITTED Phase 4 consoles — the Project register on projects.html and
 * the workforce console on specialists.html — executed as a browser executes
 * them (the mission-consoles pattern: real emitted page, real inline
 * scripts, `fetch` answered by the REAL control API against a real
 * `HeadquarterOperations`).
 *
 * What this proves that the string-level audits cannot: the mount, the
 * script, the grant rule, the response shape and the server's own grants
 * meet in one DOM and produce working controls — or, without the grant, a
 * truthful read-only record — and authorization loss wipes what it must.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  WORKFORCE_ASSIGN_CAPABILITY,
  registerWorkforceAssignCapability,
} from '../src/application/workforce-command.js';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';

const FOUNDER_ACCOUNT: AuthenticatedAccount = {
  realmId: 'realm',
  accountId: 'acc-1',
  displayName: 'Proof Founder',
  authenticatedAt: new Date().toISOString(),
};

function deployment(options: { projectGrant?: boolean; assignGrant?: boolean; founder?: boolean } = {}): {
  api: ControlApiDeps;
  fixture: Fixture;
  setAccount: (account: AuthenticatedAccount | null) => void;
} {
  const fixture = setupFixture();
  registerProjectCommandCapability(fixture.db);
  registerMissionCommandCapability(fixture.db);
  registerWorkforceAssignCapability(fixture.db);
  const grants: string[] = [MISSION_COMMAND_CAPABILITY.id, CAPS.readStatus];
  if (options.projectGrant !== false) grants.push(PROJECT_COMMAND_CAPABILITY.id);
  if (options.assignGrant !== false) grants.push(WORKFORCE_ASSIGN_CAPABILITY.id);
  fixture.principals.register({
    id: 'hq-phase4-founder',
    displayName: 'Proof Founder',
    originateCapabilities: grants,
    approvalAuthority: true,
    active: true,
  });
  let account: AuthenticatedAccount | null = options.founder === false ? null : FOUNDER_ACCOUNT;
  const api: ControlApiDeps = {
    ops: fixture.ops,
    sessions: { resolve: () => account },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-phase4-founder' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
  };
  return {
    api,
    fixture,
    setAccount: (next) => {
      account = next;
    },
  };
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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(element: Element | null, value: string): void {
  (element as HTMLInputElement | HTMLTextAreaElement).value = value;
}

describe('the Project register console on the emitted Projects page', () => {
  it('renders the live register with an explicit zero and the create control under the grant', async () => {
    const { api } = deployment();
    const dom = await loadPage('projects.html', api);
    const state = dom.window.document
      .querySelector('[data-projects-console-state]')!
      .getAttribute('data-projects-console-state');
    expect(state).toBe('live');
    const list = dom.window.document.querySelector('[data-projects-list]')!;
    expect(list.textContent).toContain('HQ holds no registered project. 0 means 0');
    expect(dom.window.document.querySelector('[data-project-create]')).not.toBeNull();
  });

  it('creates a real register entry end to end from the page', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage('projects.html', api);
    const createBox = dom.window.document.querySelector('[data-project-create]')!;
    setValue(createBox.querySelector('input[aria-label="Project name"]'), 'JENIFY OS');
    setValue(createBox.querySelector('input[aria-label="Project purpose"]'), 'The platform program');
    (createBox.querySelector('button') as HTMLButtonElement).click();
    await settle();
    const projects = fixture.ops.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('JENIFY OS');
    expect(projects[0]!.createdBy).toBe('hq-phase4-founder');
    // And the reload drew the new card.
    expect(
      dom.window.document.querySelector(`[data-project-register-card="${projects[0]!.id}"]`),
    ).not.toBeNull();
  });

  it('shows the record read-only when the project grant is withheld', async () => {
    const { api, fixture } = deployment({ projectGrant: false });
    expectOk(
      fixture.ops.createProject({
        name: 'Pre-existing',
        purpose: 'Registered before the page loaded',
        requestedBy: (() => {
          fixture.principals.register({
            id: 'granted-elsewhere',
            displayName: 'G',
            originateCapabilities: [PROJECT_COMMAND_CAPABILITY.id],
            approvalAuthority: true,
            active: true,
          });
          return 'granted-elsewhere';
        })(),
      }),
    );
    const dom = await loadPage('projects.html', api);
    const list = dom.window.document.querySelector('[data-projects-list]')!;
    expect(list.textContent).toContain('Register controls are off for this session');
    expect(list.textContent).toContain('Pre-existing');
    expect(dom.window.document.querySelector('[data-project-create]')).toBeNull();
    // The card renders with no buttons at all.
    const card = list.querySelector('[data-project-register-card]')!;
    expect(card.querySelector('button')).toBeNull();
  });

  it('wipes every rendered register row when the session expires and a write answers 401', async () => {
    const { api, fixture, setAccount } = deployment();
    expectOk(
      fixture.ops.createProject({
        name: 'Wipe target',
        purpose: 'Will be wiped from the DOM, not from the register',
        requestedBy: 'hq-phase4-founder',
      }),
    );
    const dom = await loadPage('projects.html', api);
    expect(
      dom.window.document.querySelector('[data-projects-list]')!.textContent,
    ).toContain('Wipe target');

    setAccount(null); // mid-session expiry
    const card = dom.window.document.querySelector('[data-project-register-card]')!;
    setValue(card.querySelector('input[aria-label="Reason / note for closing or reopening"]'), 'x');
    (card.querySelector('button') as HTMLButtonElement).click();
    await settle();

    const note = dom.window.document.querySelector('[data-projects-console-state]')!;
    expect(note.getAttribute('data-projects-console-state')).toBe('off');
    expect(note.textContent).toContain('PROJECT REGISTER IS NOT READABLE');
    expect(dom.window.document.querySelector('[data-projects-list]')!.textContent).toBe('');
    // The register itself is intact — only the page's claim to read it went.
    expect(fixture.ops.listProjects()).toHaveLength(1);
  });
});

describe('the workforce console on the emitted Specialist Directory page', () => {
  it('renders every registered worker with declared-or-null provider truth', async () => {
    const { api } = deployment();
    const dom = await loadPage('specialists.html', api);
    const state = dom.window.document
      .querySelector('[data-workforce-console-state]')!
      .getAttribute('data-workforce-console-state');
    expect(state).toBe('live');
    const list = dom.window.document.querySelector('[data-workforce-list]')!;
    expect(list.querySelectorAll('[data-workforce-card]')).toHaveLength(4);
    expect(list.textContent).toContain('No execution provider is declared');
    expect(list.textContent).not.toContain('utilization');
    expect(dom.window.document.querySelector('[data-workforce-assign]')).not.toBeNull();
  });

  it('records a real advisory assignment end to end, changing no task status', async () => {
    const { api, fixture } = deployment();
    const taskId = expectOk(
      fixture.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { kind: 'status' },
        requestedBy: 'hq-phase4-founder',
      }),
    ).task.id;
    const dom = await loadPage('specialists.html', api);
    const assignBox = dom.window.document.querySelector('[data-workforce-assign]')!;
    setValue(assignBox.querySelector('input[aria-label="Task id"]'), taskId);
    const select = assignBox.querySelector('select') as HTMLSelectElement;
    select.value = 'claude';
    const buttons = assignBox.querySelectorAll('button');
    (buttons[1] as HTMLButtonElement).click(); // [evaluate, assign]
    await settle();
    expect(assignBox.textContent).toContain('Advisory assignment recorded for claude');
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
    expect(fixture.ops.readMeta(taskId)!.assignment!.workerId).toBe('claude');
  });

  it('evaluates eligibility with the server’s own refusal reasons', async () => {
    const { api, fixture } = deployment();
    const taskId = expectOk(
      fixture.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { kind: 'status' },
        requestedBy: 'hq-phase4-founder',
      }),
    ).task.id;
    const dom = await loadPage('specialists.html', api);
    const assignBox = dom.window.document.querySelector('[data-workforce-assign]')!;
    setValue(assignBox.querySelector('input[aria-label="Task id"]'), taskId);
    const buttons = assignBox.querySelectorAll('button');
    (buttons[0] as HTMLButtonElement).click();
    await settle();
    expect(assignBox.textContent).toContain('claude: ELIGIBLE');
    expect(assignBox.textContent).toContain('retired-bot: not eligible');
    expect(assignBox.textContent).toContain('worker_inactive');
  });

  it('draws the record without assignment controls when that grant is withheld', async () => {
    const { api } = deployment({ assignGrant: false });
    const dom = await loadPage('specialists.html', api);
    const list = dom.window.document.querySelector('[data-workforce-list]')!;
    expect(list.querySelectorAll('[data-workforce-card]')).toHaveLength(4);
    expect(list.textContent).toContain('Assignment controls are off for this session');
    expect(dom.window.document.querySelector('[data-workforce-assign]')).toBeNull();
  });

  it('states truthfully that no member registry is configured', async () => {
    const { api } = deployment();
    const dom = await loadPage('specialists.html', api);
    const note = dom.window.document.querySelector('[data-workforce-console-state]')!;
    expect(note.textContent).toContain('No AI member registry is configured on this deployment');
  });
});
