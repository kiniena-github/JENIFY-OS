/**
 * The EMITTED Company Search / Ask Jenify console on index.html (Phase 11),
 * executed as a browser executes it — the Phase 9/10 console pattern: real
 * emitted page, real inline scripts, `fetch` answered by the REAL control API
 * against a real `HeadquarterOperations`.
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
import { handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import { searchConsoleScript } from '../src/ui/control-console.js';
import { searchFixture, type SearchFixture } from './search-ask.fixture.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;
const PAGE_ORIGIN = 'http://localhost:3101';

function deployment(options: { founder?: boolean } = {}): { api: ControlApiDeps; fixture: SearchFixture } {
  const fixture = searchFixture();
  const account: AuthenticatedAccount | null =
    options.founder === false
      ? null
      : { realmId: 'realm', accountId: 'acc-1', displayName: 'Proof', authenticatedAt: new Date().toISOString() };
  const api: ControlApiDeps = {
    ops: fixture.ops,
    sessions: { resolve: () => account },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
  };
  return { api, fixture };
}

function pageHtml(): string {
  const page = buildSite(sample).get('index.html');
  if (page == null) throw new Error('buildSite emitted no index.html');
  return page;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadPage(api: ControlApiDeps): Promise<JSDOM> {
  const pageUrl = `${PAGE_ORIGIN}/hq/index.html`;
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
          headers:
            method === 'GET'
              ? { referer: pageUrl }
              : { origin: PAGE_ORIGIN, 'content-type': 'application/json', referer: pageUrl },
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

describe('the search console’s emitted markup stays inert', () => {
  it('carries a mount and a note, and no input, button or form', () => {
    const html = pageHtml();
    expect(html).toContain('data-search-console');
    const at = html.indexOf('data-search-console');
    const inert = html.slice(Math.max(0, at - 1600), at);
    expect(inert).not.toContain('<button');
    expect(inert).not.toContain('<input');
    expect(inert).not.toContain('<form');
    // The two laws the section must let a reader rely on.
    expect(html).toContain('There is no relevance score, rank, confidence or percentage anywhere in this surface');
    expect(html).toContain('HQ returns unknown or insufficient evidence rather than inventing one');
  });

  it('issues no write of any kind — the only `postJson` in the script is the shared helper’s definition', () => {
    const script = searchConsoleScript();
    // DOM_HELPERS_JS is embedded verbatim in every console, so the helper is
    // DEFINED here. What must not exist is a CALL SITE.
    const occurrences = [...script.matchAll(/postJson\(/g)];
    expect(occurrences).toHaveLength(1);
    expect(script).toContain('function postJson(path, payload)');
    // The one `method: 'POST'` in the script is inside that same helper body;
    // no fetch this console issues names a method at all, so every request it
    // makes is a GET.
    expect([...script.matchAll(/method: 'POST'/g)]).toHaveLength(1);
    expect([...script.matchAll(/fetch\(/g)]).toHaveLength(4); // the helper's, plus session, search, ask
    expect(script).not.toContain('innerHTML');
  });
});

describe('the console drawn for a Founder', () => {
  it('searches the canonical record and shows each hit’s table and id', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    expect(document.querySelector('[data-search-state]')!.getAttribute('data-search-state')).toBe('live');

    const card = document.querySelector('[data-search-card]')!;
    const input = card.querySelectorAll('input')[0] as HTMLInputElement;
    input.value = 'zircon';
    (card.querySelectorAll('button')[0] as HTMLButtonElement).click();
    await settle();

    const results = document.querySelector('[data-search-results]')!.textContent!;
    expect(results).toContain('SEARCH — 1 matching record(s)');
    expect(results).toContain('hq_memory');
    expect(results).toContain(fixture.publicMemoryId);
    expect(results).toContain('matched terms: zircon');
    // The order is STATED, and what it states is that there is no score.
    expect(results).toContain('It is not a relevance score');
    expect(results).not.toContain('score:');
    expect(results).not.toContain('relevance:');
    dom.window.close();
  });

  it('asks a question and draws the grounded answer with its sources and limitations', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    const card = document.querySelector('[data-search-card]')!;
    const question = card.querySelectorAll('input')[2] as HTMLInputElement;
    question.value = 'What is verified about the tantalum measurement run?';
    (card.querySelectorAll('button')[1] as HTMLButtonElement).click();
    await settle();

    const answer = document.querySelector('[data-answer]')!.textContent!;
    expect(document.querySelector('[data-answer-state]')!.getAttribute('data-answer-state')).toBe('grounded');
    expect(answer).toContain('Answered from 1 canonical record');
    expect(answer).toContain('hq_truth_records');
    expect(answer).toContain(fixture.publicTruthId);
    expect(answer).toContain('truth state verified');
    expect(answer).toContain('Sources this answer is grounded in');
    expect(answer).toContain('Limitations of this answer');
    expect(answer).toContain('composed_from_fields_only');
    dom.window.close();
  });

  it('draws an honest unknown rather than prose when the record does not answer', async () => {
    const { api } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    const card = document.querySelector('[data-search-card]')!;
    const question = card.querySelectorAll('input')[2] as HTMLInputElement;
    question.value = 'What is our vanadium export licence number?';
    (card.querySelectorAll('button')[1] as HTMLButtonElement).click();
    await settle();

    const answer = document.querySelector('[data-answer]')!.textContent!;
    expect(document.querySelector('[data-answer-state]')!.getAttribute('data-answer-state')).toBe(
      'insufficient_evidence',
    );
    expect(answer).toContain('no canonical record matching this question');
    expect(answer).toContain('no_matching_canonical_record');
    dom.window.close();
  });

  it('refuses to issue an empty query from the page at all', async () => {
    const { api } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    const card = document.querySelector('[data-search-card]')!;
    (card.querySelectorAll('button')[0] as HTMLButtonElement).click();
    await settle();
    expect(card.textContent).toContain('that is a dump of the company record, not a search');
    expect(document.querySelector('[data-search-results]')!.textContent).toBe('');
    dom.window.close();
  });
});

describe('the console draws nothing for a session with no Founder grant', () => {
  it('states why, and builds no search box at all', async () => {
    const { api } = deployment({ founder: false });
    const dom = await loadPage(api);
    const note = dom.window.document.querySelector('[data-search-state]')!;
    expect(note.getAttribute('data-search-state')).toBe('off');
    expect(note.textContent).toContain('COMPANY SEARCH IS NOT READABLE FROM THIS PAGE');
    expect(dom.window.document.querySelector('[data-search-card]')).toBeNull();
    dom.window.close();
  });
});
