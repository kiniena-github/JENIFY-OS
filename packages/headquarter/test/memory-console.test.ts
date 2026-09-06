/**
 * The EMITTED Company Memory console on archive.html (Phase 5, issue #265),
 * executed as a browser executes it — the phase4-consoles pattern: real
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
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';
import { expectOk, setupFixture, type Fixture } from './application.fixture.js';
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

function deployment(options: { memoryGrant?: boolean; founder?: boolean } = {}): {
  api: ControlApiDeps;
  fixture: Fixture;
} {
  const fixture = setupFixture();
  registerMemoryCommandCapability(fixture.db);
  fixture.principals.register({
    id: 'hq-phase5-founder',
    displayName: 'Proof Founder',
    originateCapabilities: options.memoryGrant === false ? [] : [MEMORY_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  const account: AuthenticatedAccount | null = options.founder === false ? null : FOUNDER_ACCOUNT;
  const api: ControlApiDeps = {
    ops: fixture.ops,
    sessions: { resolve: () => account },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-phase5-founder' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
  };
  return { api, fixture };
}

function pageHtml(): string {
  const page = buildSite(sample).get('archive.html');
  if (page == null) throw new Error('buildSite emitted no archive.html');
  return page;
}

async function loadPage(api: ControlApiDeps): Promise<JSDOM> {
  const pageUrl = `${PAGE_ORIGIN}/hq/archive.html`;
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(pageHtml(), {
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

describe('the Company Memory console on the emitted Archive page', () => {
  it('static markup carries no memory control — the mount is empty until a script earns one', () => {
    const html = pageHtml();
    expect(html).toContain('data-memory-console');
    // The mount div itself is empty in the static HTML; every input/button
    // inside it is script-created after a real /session grant.
    expect(html).toContain('<div data-memory-console></div>');
  });

  it('renders the live record with an explicit zero and the record form under the grant', async () => {
    const { api } = deployment();
    const dom = await loadPage(api);
    const state = dom.window.document
      .querySelector('[data-memory-console-state]')!
      .getAttribute('data-memory-console-state');
    expect(state).toBe('live');
    const cards = dom.window.document.querySelector('[data-memory-cards]')!;
    expect(cards.textContent).toContain('HQ remembers nothing yet. 0 means 0');
    expect(dom.window.document.querySelector('[data-memory-record-form]')).not.toBeNull();
  });

  it('records a real memory entry end to end from the page', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const form = dom.window.document.querySelector('[data-memory-record-form]')!;
    setValue(form.querySelector('input[aria-label="Title"]'), 'Landing page first');
    setValue(form.querySelector('textarea[aria-label="Body"]'), 'Profile the landing page before changes.');
    setValue(
      form.querySelector('input[aria-label="Project label (free text, never matched against the register)"]'),
      'QOS',
    );
    (form.querySelector('button') as HTMLButtonElement).click();
    await settle();
    const records = fixture.ops.listMemory();
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe('Landing page first');
    // Attribution is the mapped principal — the page never sent an actor.
    expect(records[0].recordedBy).toBe('hq-phase5-founder');
    // The console re-rendered the new record with its provenance line.
    const cards = dom.window.document.querySelector('[data-memory-cards]')!;
    expect(cards.textContent).toContain('Landing page first');
    expect(cards.textContent).toContain('by hq-phase5-founder');
  });

  it('shows the read-only record without the form when the grant is withheld', async () => {
    const { api, fixture } = deployment({ memoryGrant: false });
    // A record that exists already — recorded through the facade by a
    // separately granted principal.
    fixture.principals.register({
      id: 'granted-recorder',
      displayName: 'Recorder',
      originateCapabilities: [MEMORY_COMMAND_CAPABILITY.id],
      approvalAuthority: false,
      active: true,
    });
    expectOk(
      fixture.ops.recordMemory({
        kind: 'decision',
        title: 'Existing decision',
        body: 'Recorded before this page loaded.',
        project: 'JENIFY-OS',
        requestedBy: 'granted-recorder',
      }),
    );
    const dom = await loadPage(api);
    const cards = dom.window.document.querySelector('[data-memory-cards]')!;
    expect(cards.textContent).toContain('Existing decision');
    expect(dom.window.document.querySelector('[data-memory-record-form]')).toBeNull();
    const list = dom.window.document.querySelector('[data-memory-list]')!;
    expect(list.textContent).toContain('The record form is off for this session');
  });

  it('stays off for a session that is not the Founder, with the reason stated', async () => {
    const { api } = deployment({ founder: false });
    const dom = await loadPage(api);
    const note = dom.window.document.querySelector('[data-memory-console-state]')!;
    expect(note.getAttribute('data-memory-console-state')).toBe('off');
    expect(note.textContent).toContain('COMPANY MEMORY IS NOT READABLE FROM THIS PAGE');
  });

  it('renders hostile record content inert — textContent, never markup', async () => {
    const { api, fixture } = deployment();
    fixture.principals.register({
      id: 'granted-recorder',
      displayName: 'Recorder',
      originateCapabilities: [MEMORY_COMMAND_CAPABILITY.id],
      approvalAuthority: false,
      active: true,
    });
    expectOk(
      fixture.ops.recordMemory({
        kind: 'founder_note',
        title: '<img src=x onerror=window.__pwned=1>',
        body: '<script>window.__pwned=2</script>',
        project: 'JENIFY-OS',
        requestedBy: 'granted-recorder',
      }),
    );
    const dom = await loadPage(api);
    const cards = dom.window.document.querySelector('[data-memory-cards]')!;
    expect(cards.textContent).toContain('<img src=x onerror=window.__pwned=1>');
    expect(cards.querySelector('img')).toBeNull();
    expect((dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
