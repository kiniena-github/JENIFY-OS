/**
 * The EMITTED Truth + Evidence console on archive.html (Phase 7), executed
 * as a browser executes it — the memory-console pattern: real emitted page,
 * real inline scripts, `fetch` answered by the REAL control API against a
 * real `HeadquarterOperations`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';
import { claim, confirm, truthFixture, type TruthFixture } from './truth.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';

function deployment(options: { principalId?: string; founder?: boolean; stale?: boolean } = {}): {
  api: ControlApiDeps;
  fixture: TruthFixture;
} {
  const fixture = truthFixture();
  const authenticatedAt = options.stale
    ? new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
    : new Date().toISOString();
  const account: AuthenticatedAccount | null =
    options.founder === false ? null : { realmId: 'realm', accountId: 'acc-1', displayName: 'Proof', authenticatedAt };
  const api: ControlApiDeps = {
    ops: fixture.ops,
    sessions: { resolve: () => account },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: options.principalId ?? 'founder' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    credentials: { verify: (_a, password) => (password === 'correct-password' ? 'ok' : 'rejected') },
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
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return dom;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(element: Element | null, value: string): void {
  (element as HTMLInputElement | HTMLTextAreaElement).value = value;
}

describe('the Truth + Evidence console on the emitted Archive page', () => {
  it('static markup carries no truth control — the mount is empty until a script earns one', () => {
    const html = pageHtml();
    // The mount div itself is empty in the static HTML; every input/button
    // inside it is script-created after a real /session grant.
    expect(html).toContain('<div data-truth-console></div>');
    expect(html).not.toContain('<button type="button" class="order-live-submit">Accept truth');
  });

  it('renders the live projection with an explicit zero and each form only under its grant', async () => {
    const { api } = deployment();
    const dom = await loadPage(api);
    const doc = dom.window.document;
    expect(doc.querySelector('[data-truth-console-state]')!.getAttribute('data-truth-console-state')).toBe('live');
    expect(doc.querySelector('[data-truth-cards]')!.textContent).toContain('HQ holds no truth record yet. 0 means 0');
    expect(doc.querySelector('[data-truth-contradictions]')!.textContent).toContain('No unresolved contradiction');
    expect(doc.querySelector('[data-truth-record-form]')).not.toBeNull();
    expect(doc.querySelector('[data-truth-verify-form]')).not.toBeNull();
    // Founder holds approval authority, but nothing is acceptable: the accept form draws no control.
    const accept = doc.querySelector('[data-truth-accept-form]')!;
    expect(accept.textContent).toContain('Nothing is acceptable right now');
    expect(accept.querySelector('button')).toBeNull();
  });

  it('records a claim from the page attributed to the mapped principal, showing its derived state', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const form = dom.window.document.querySelector('[data-truth-record-form]')!;
    setValue(form.querySelector('select[aria-label="Entity kind"]'), 'task');
    setValue(form.querySelector('input[aria-label="Entity id"]'), fixture.taskId);
    setValue(form.querySelector('textarea[aria-label="Statement"]'), 'CI is green on the release branch.');
    setValue(form.querySelector('input[aria-label="Evidence ids, comma separated (required for an observation)"]'), fixture.evidenceId);
    (form.querySelector('button') as HTMLButtonElement).click();
    await settle();
    const records = fixture.ops.listTruth();
    expect(records).toHaveLength(1);
    expect(records[0]!.recordedBy).toBe('founder');
    expect(records[0]!.state).toBe('claimed');
    const card = dom.window.document.querySelector('[data-truth-card]')!;
    expect(card.getAttribute('data-truth-state')).toBe('claimed');
    expect(card.textContent).toContain('CLAIMED');
    expect(card.textContent).toContain('Evidence (op_evidence ids, referenced never copied)');
  });

  it('shows the contradiction first, the verification with its limitations, and accepts through step-up', async () => {
    const { api, fixture } = deployment({ principalId: 'coo', stale: true });
    const record = claim(fixture);
    const verified = confirm(fixture, record.id).record;
    const rival = claim(fixture, { statement: 'CI is red.', contradicts: [record.id], requestedBy: 'analyst' });
    let dom = await loadPage(api);
    let doc = dom.window.document;
    expect(doc.querySelector('[data-truth-contradictions]')!.textContent).toContain('1 UNRESOLVED CONTRADICTION');
    const verifiedCard = doc.querySelector(`[data-truth-card="${record.id}"]`)!;
    expect(verifiedCard.textContent).toContain('Verified CONFIRMED by codex');
    expect(verifiedCard.textContent).toContain('limitations: Inspected the recorded evidence entry only');
    expect(verifiedCard.textContent).toContain('CONTESTED');
    // Contested: nothing acceptable, no accept control drawn. The coo holds no record/verify grant.
    expect(doc.querySelector('[data-truth-accept-form]')!.querySelector('button')).toBeNull();
    expect(doc.querySelector('[data-truth-record-form]')).toBeNull();
    expect(doc.querySelector('[data-truth-verify-form]')).toBeNull();

    // Resolve the contradiction explicitly (refute the rival), then the accept form draws with the digest.
    confirm(fixture, rival.id, { verdict: 'refuted', limitations: 'The evidence shows CI green.' });
    dom = await loadPage(api);
    doc = dom.window.document;
    const acceptForm = doc.querySelector('[data-truth-accept-form]')!;
    const button = acceptForm.querySelector('button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    // Stale session, no password: step-up refuses; nothing accepted.
    button.click();
    await settle();
    expect(acceptForm.textContent).toContain('step_up_required');
    expect(fixture.ops.getTruthRecord(record.id)!.state).toBe('verified');
    // With the password: accepted, attributed to the mapped coo, over the exact digest.
    setValue(acceptForm.querySelector('input[type="password"]'), 'correct-password');
    button.click();
    await settle();
    const after = fixture.ops.getTruthRecord(record.id)!;
    expect(after.state).toBe('accepted');
    expect(after.acceptances[0]!.acceptedBy).toBe('coo');
    expect(after.acceptances[0]!.digest).toBe(fixture.ops.getTruthRecord(record.id)!.acceptances[0]!.digest);
    expect(verified.acceptanceDigest).not.toBeNull();
    expect((acceptForm.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });

  it('shows an acceptance that no longer stands as history beside the state the record derives now, and draws no accept control for it', async () => {
    const { api, fixture } = deployment();
    const record = claim(fixture);
    confirm(fixture, record.id);
    const accepted = fixture.ops.acceptTruth({
      truthId: record.id,
      expectedDigest: fixture.ops.getTruthRecord(record.id)!.acceptanceDigest!,
      requestedBy: 'coo',
    });
    expect(accepted.ok).toBe(true);
    confirm(fixture, record.id, { verdict: 'refuted', evidenceRefs: [fixture.evidenceId2], limitations: 'The rerun shows a failing job.' });
    const dom = await loadPage(api);
    const doc = dom.window.document;
    const card = doc.querySelector(`[data-truth-card="${record.id}"]`)!;
    expect(card.getAttribute('data-truth-state')).toBe('claimed');
    expect(card.getAttribute('data-truth-acceptance-standing')).toBe('verification_refuted');
    expect(card.textContent).toContain('ACCEPTED by coo');
    expect(card.textContent).toContain('ACCEPTANCE NO LONGER STANDS');
    expect(card.textContent).toContain('no longer stands (verification_refuted): the record now derives CLAIMED');
    expect(card.textContent).toContain('Verified REFUTED by codex');
    expect(card.textContent).not.toContain('ACCEPTABLE (digest');
    expect(doc.querySelector('[data-truth-accept-form]')!.querySelector('button')).toBeNull();
  });

  it('reads one entity’s history through the parameterized route', async () => {
    const { api, fixture } = deployment();
    const first = claim(fixture);
    claim(fixture, { statement: 'v2', supersedes: first.id });
    const dom = await loadPage(api);
    const lookup = dom.window.document.querySelector('[data-truth-entity-form]')!;
    setValue(lookup.querySelector('select[aria-label="Entity kind to look up"]'), 'task');
    setValue(lookup.querySelector('input[aria-label="Entity id to look up"]'), fixture.taskId);
    (lookup.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(lookup.textContent).toContain('current state CLAIMED');
    expect(lookup.textContent).toContain('2 in history');
    expect(lookup.querySelector('[data-truth-entity-history]')!.querySelectorAll('[data-truth-card]')).toHaveLength(2);
    expect(lookup.textContent).toContain('Superseded by');
  });

  it('stays off for a session that is not the Founder, and renders hostile statements inert', async () => {
    const off = await loadPage(deployment({ founder: false }).api);
    const note = off.window.document.querySelector('[data-truth-console-state]')!;
    expect(note.getAttribute('data-truth-console-state')).toBe('off');
    expect(note.textContent).toContain('THE TRUTH PROJECTION IS NOT READABLE FROM THIS PAGE');

    const { api, fixture } = deployment();
    claim(fixture, { statement: '<img src=x onerror=window.__pwned=1>' });
    const dom = await loadPage(api);
    const cards = dom.window.document.querySelector('[data-truth-cards]')!;
    expect(cards.textContent).toContain('<img src=x onerror=window.__pwned=1>');
    expect(cards.querySelector('img')).toBeNull();
    expect((dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
