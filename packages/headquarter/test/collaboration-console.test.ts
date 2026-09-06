/**
 * The EMITTED Mission Room collaboration console on projects.html (Phase 9),
 * executed as a browser executes it — the mission-consoles pattern: real
 * emitted page, real inline scripts, `fetch` answered by the REAL control API
 * against a real `HeadquarterOperations`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';
import { admit, collaborationFixture, contribute, openSession, type CollaborationFixture } from './collaboration.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';

function deployment(options: { principalId?: string; founder?: boolean } = {}): { api: ControlApiDeps; fixture: CollaborationFixture } {
  const fixture = collaborationFixture();
  const account: AuthenticatedAccount | null =
    options.founder === false ? null : { realmId: 'realm', accountId: 'acc-1', displayName: 'Proof', authenticatedAt: new Date().toISOString() };
  const api: ControlApiDeps = {
    ops: fixture.ops,
    sessions: { resolve: () => account },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: options.principalId ?? 'founder' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
  };
  return { api, fixture };
}

function pageHtml(): string {
  const page = buildSite(sample).get('projects.html');
  if (page == null) throw new Error('buildSite emitted no projects.html');
  return page;
}

async function loadPage(api: ControlApiDeps): Promise<JSDOM> {
  const pageUrl = `${PAGE_ORIGIN}/hq/projects.html`;
  const dom = new JSDOM(pageHtml(), {
    url: pageUrl,
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
    beforeParse(window: Record<string, unknown>) {
      window.fetch = (input: string, init?: { method?: string; body?: string }) => {
        const url = String(input);
        const path = url.split('?')[0]!;
        if (path.endsWith(SNAPSHOT_FILENAME)) {
          return Promise.resolve({ status: 404, json: () => Promise.reject(new Error('no snapshot')) });
        }
        const query: Record<string, string> = {};
        const raw = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        for (const [key, value] of new URLSearchParams(raw)) if (!(key in query)) query[key] = value;
        const method = init?.method ?? 'GET';
        const request: ControlRequest = {
          method,
          path,
          headers: method === 'GET' ? { referer: pageUrl } : { origin: PAGE_ORIGIN, 'content-type': 'application/json', referer: pageUrl },
          body: init?.body != null ? (JSON.parse(init.body) as unknown) : undefined,
          query,
        };
        const result = handleControlRequest(request, api);
        return Promise.resolve({ status: result.status, json: () => Promise.resolve(result.body) });
      };
    },
  });
  await settle();
  return dom;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(element: Element | null, value: string): void {
  (element as HTMLInputElement | HTMLSelectElement).value = value;
}

describe('the Mission Room collaboration console on the emitted Projects page', () => {
  it('static markup carries no collaboration control — the mount is empty until a script earns one', () => {
    const html = pageHtml();
    expect(html).toContain('<div data-collaboration-console></div>');
    expect(html).not.toContain('Open session</button>');
    expect(html).not.toContain('Admit worker</button>');
  });

  it('renders the live record with an explicit zero and draws the open form only under the granted control', async () => {
    const { api } = deployment();
    const dom = await loadPage(api);
    const doc = dom.window.document;
    expect(doc.querySelector('[data-collaboration-console-state]')!.getAttribute('data-collaboration-console-state')).toBe('live');
    const rooms = doc.querySelector('[data-collaboration-rooms]')!;
    expect(rooms.textContent).toContain('No collaboration session is open on any mission. 0 means 0');
    expect(rooms.querySelector('[data-collaboration-open-form]')).not.toBeNull();
    expect(rooms.querySelector('[data-collaboration-room]')).toBeNull();
  });

  it('opens a session and admits a worker from the page, attributed to the mapped principal; the room then shows the real participant, a facade-recorded contribution with its binding and stance, and the canonical task', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const doc = dom.window.document;
    const form = doc.querySelector('[data-collaboration-open-form]')!;
    setValue(form.querySelector('select[aria-label="Mission to open a collaboration session on"]'), fixture.missionId);
    setValue(form.querySelector('input[aria-label="Session title"]'), 'Speed war room');
    (form.querySelector('button') as HTMLButtonElement).click();
    await settle();
    const sessions = fixture.ops.listCollaborationSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.openedBy).toBe('founder');
    const roomCard = doc.querySelector(`[data-collaboration-room="${fixture.missionId}"]`)!;
    expect(roomCard).not.toBeNull();
    expect(roomCard.textContent).toContain('No worker is admitted. 0 means 0');
    expect(roomCard.querySelector(`[data-collaboration-task="${fixture.taskId}"]`)!.textContent).toContain('claimed by nobody');

    const admitForm = roomCard.querySelector(`[data-collaboration-admit-form="${sessions[0]!.id}"]`)!;
    setValue(admitForm.querySelector('input'), 'claude');
    setValue(admitForm.querySelector('select'), 'builder');
    (admitForm.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(fixture.ops.getCollaborationSession(sessions[0]!.id)!.participants).toEqual([
      expect.objectContaining({ workerId: 'claude', role: 'builder', admittedBy: 'founder', providerId: 'CLAUDE' }),
    ]);
    const participant = doc.querySelector('[data-collaboration-participant="claude"]')!;
    expect(participant.textContent).toContain('builder');
    expect(participant.textContent).toContain('provider CLAUDE');

    // A contribution recorded through the facade under the worker's own identity, then a disagreement — the page shows both truthfully after a reload.
    admit(fixture, sessions[0]!.id, 'codex', 'reviewer');
    const finding = contribute(fixture, sessions[0]!.id, { taskId: fixture.taskId });
    contribute(fixture, sessions[0]!.id, { kind: 'critique', content: 'The image is cached.', requestedBy: 'codex', disagreesWith: [finding.id] });
    const reloaded = await loadPage(api);
    const card = reloaded.window.document.querySelector(`[data-collaboration-contribution="${finding.id}"]`)!;
    expect(card.getAttribute('data-collaboration-standing')).toBe('disputed');
    expect(card.textContent).toContain('FINDING by claude as builder');
    expect(card.textContent).toContain('provider CLAUDE');
    expect(card.textContent).toContain('disputed by codex');
    expect(reloaded.window.document.querySelector('[data-collaboration-disagreement]')!.textContent).toContain('codex (reviewer) disagrees with claude (builder)');
  });

  it('draws nothing but one truthful line for a non-Founder session, and a Founder without the command grant sees the record with the forms off', async () => {
    const nobody = deployment({ founder: false });
    const off = await loadPage(nobody.api);
    const state = off.window.document.querySelector('[data-collaboration-console-state]')!;
    expect(state.getAttribute('data-collaboration-console-state')).toBe('off');
    expect(off.window.document.querySelector('[data-collaboration-rooms]')!.textContent).toBe('');
    expect(off.window.document.querySelector('[data-collaboration-open-form]')).toBeNull();

    const analyst = deployment({ principalId: 'analyst' });
    openSession(analyst.fixture);
    const readOnly = await loadPage(analyst.api);
    const doc = readOnly.window.document;
    expect(doc.querySelector('[data-collaboration-console-state]')!.getAttribute('data-collaboration-console-state')).toBe('live');
    expect(doc.querySelector('[data-collaboration-room]')).not.toBeNull();
    expect(doc.querySelector('[data-collaboration-open-form]')).toBeNull();
    expect(doc.querySelector('[data-collaboration-admit-form]')).toBeNull();
    expect(doc.querySelector('[data-collaboration-rooms]')!.textContent).toContain('The open-session form is off for this session');
  });
});
