/**
 * The EMITTED Chief of Staff console on index.html (Phase 10), executed as a
 * browser executes it — the mission-consoles pattern: real emitted page, real
 * inline scripts, `fetch` answered by the REAL control API against a real
 * `HeadquarterOperations`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';
import { commandCenterFixture, taskAwaitingApproval, type CommandCenterFixture } from './command-center.fixture.js';
import { FOUNDER_BRIEF_CAPABILITY } from '../src/application/chief-of-staff.js';
import { expectOk } from './application.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';

function deployment(
  options: { principalId?: string; founder?: boolean; grantBrief?: boolean } = {},
): { api: ControlApiDeps; fixture: CommandCenterFixture } {
  const fixture = commandCenterFixture({ grantBrief: options.grantBrief });
  const account: AuthenticatedAccount | null =
    options.founder === false
      ? null
      : { realmId: 'realm', accountId: 'acc-1', displayName: 'Proof', authenticatedAt: new Date().toISOString() };
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
  const page = buildSite(sample).get('index.html');
  if (page == null) throw new Error('buildSite emitted no index.html');
  return page;
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

async function settle(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the Chief of Staff console on the emitted Command Center page', () => {
  it('static markup carries a mount and a note, and no control at all', () => {
    const html = pageHtml();
    expect(html).toContain('data-command-center-console');
    const inert = html.slice(html.indexOf('data-command-center-console') - 1400, html.indexOf('data-command-center-console'));
    expect(inert).not.toContain('<button');
    expect(inert).not.toContain('<input');
    expect(inert).not.toContain('<form');
    // The note states the two laws a reader must be able to rely on.
    expect(html).toContain('A recommendation is a record and never a button');
    expect(html).toContain('There is no priority, score, confidence, percentage or ETA anywhere in this layer');
  });

  it('renders the live briefing for a Founder, with each item naming its canonical row', async () => {
    const { api, fixture } = deployment();
    const { taskId } = taskAwaitingApproval(fixture, 'console-held');
    const dom = await loadPage(api);
    const document = dom.window.document;
    expect(document.querySelector('[data-command-center-state]')!.getAttribute('data-command-center-state')).toBe('live');
    const state = document.querySelector('[data-command-center-state]')!.textContent!;
    expect(state).toContain('need the Founder');
    expect(state).toContain('Nothing here is stored, ranked or estimated');

    const item = document.querySelector(`[data-attention-item][data-attention-kind="approval"]`)!;
    expect(item.textContent).toContain(taskId);
    expect(item.textContent).toContain('op_tasks');
    expect(item.textContent).toContain('op_tasks.status = needs_approval');
    expect(item.textContent).toContain('approval_authority');

    // The six questions and the departments are all drawn.
    const card = document.querySelector('[data-command-center-briefing]')!.textContent!;
    expect(card).toContain('WHAT NEEDS ME');
    expect(card).toContain('WHAT IS BLOCKED');
    expect(card).toContain('WHAT CHANGED');
    expect(card).toContain('WHAT IS VERIFIED');
    expect(card).toContain('WHAT IS UNKNOWN');
    expect(card).toContain('WHAT HQ CAN SAFELY DO NEXT');
    expect(document.querySelectorAll('[data-department]').length).toBe(9);
    dom.window.close();
  });

  it('draws a recommendation as a record — stating executable: false and the act, with no control on it', async () => {
    const { api, fixture } = deployment();
    taskAwaitingApproval(fixture, 'console-recommendation');
    const dom = await loadPage(api);
    const recommendation = dom.window.document.querySelector('[data-recommendation]')!;
    expect(recommendation.textContent).toContain('executable: false');
    expect(recommendation.textContent).toContain('approveTask');
    expect(recommendation.textContent).toContain('authority: approval_authority');
    expect(recommendation.querySelector('button')).toBeNull();
    expect(recommendation.querySelector('a')).toBeNull();
    expect(recommendation.querySelector('input')).toBeNull();
    dom.window.close();
  });

  it('states a not_recorded department as not recorded, with no metric invented for it', async () => {
    const { api } = deployment();
    const dom = await loadPage(api);
    const finance = dom.window.document.querySelector('[data-department="finance"]')!;
    expect(finance.getAttribute('data-department-basis')).toBe('not_recorded');
    expect(finance.textContent).toContain('No metric is shown, because HQ records nothing that would make one true');
    expect(finance.textContent).toContain('would be fabricated');
    const development = dom.window.document.querySelector('[data-department="development"]')!;
    expect(development.getAttribute('data-department-basis')).toBe('canonical');
    expect(development.textContent).toContain('Tasks queued');
    dom.window.close();
  });

  it('issues a real receipt from the page under a granted control, and shows the digest it recorded', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const form = dom.window.document.querySelector('[data-brief-form]')!;
    expect(form).not.toBeNull();
    (form.querySelector('button') as HTMLButtonElement).click();
    await settle();
    const briefs = fixture.ops.listBriefs();
    expect(briefs.total).toBe(1);
    // The page re-reads after the write, so the form now states the ledger's
    // real latest receipt rather than an optimistic local message.
    const outcome = dom.window.document.querySelector('[data-brief-form]')!.textContent!;
    expect(outcome).toContain('Latest receipt: ' + briefs.briefs[0]!.id);
    expect(outcome).toContain(briefs.briefs[0]!.contentDigest);
    expect(outcome).toContain('1 receipt(s) on the ledger');
    dom.window.close();
  });

  it('draws no brief control when the grant is withheld, and still renders the whole read', async () => {
    const { api, fixture } = deployment({ grantBrief: false });
    taskAwaitingApproval(fixture, 'console-ungranted');
    const dom = await loadPage(api);
    const document = dom.window.document;
    expect(document.querySelector('[data-brief-form]')).toBeNull();
    expect(document.querySelector('[data-command-center-briefing]')!.textContent).toContain(
      'The issue-brief control is off for this session',
    );
    expect(document.querySelector('[data-attention-item]')).not.toBeNull();
    expect(fixture.ops.listBriefs().total).toBe(0);
    dom.window.close();
  });

  it('withdraws the brief control when the capability row is disabled, without touching the read', async () => {
    const { api, fixture } = deployment();
    fixture.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(FOUNDER_BRIEF_CAPABILITY.id);
    const dom = await loadPage(api);
    expect(dom.window.document.querySelector('[data-brief-form]')).toBeNull();
    expect(dom.window.document.querySelector('[data-command-center-state]')!.getAttribute('data-command-center-state')).toBe('live');
    dom.window.close();
  });

  it('draws nothing for a session that is not the Founder, and says why', async () => {
    const { api } = deployment({ founder: false });
    const dom = await loadPage(api);
    const note = dom.window.document.querySelector('[data-command-center-state]')!;
    expect(note.getAttribute('data-command-center-state')).toBe('off');
    expect(note.textContent).toContain('THE COMMAND CENTRE IS NOT READABLE FROM THIS PAGE');
    expect(dom.window.document.querySelector('[data-command-center-briefing]')).toBeNull();
    dom.window.close();
  });

  it('shows a claim with missing provenance as missing, and states no withheld count when nothing is withheld', async () => {
    const { api, fixture } = deployment();
    const record = expectOk(
      fixture.ops.recordTruth({
        entityKind: 'mission',
        entityId: fixture.missionId,
        statement: 'A claim with nothing behind it.',
        bornState: 'claimed',
        evidenceRefs: [],
        requestedBy: 'claude',
      }),
    ).record;
    const dom = await loadPage(api);
    const card = dom.window.document.querySelector('[data-command-center-briefing]')!.textContent!;
    expect(card).toContain('Claims citing no evidence \u2014 missing provenance, shown as missing');
    expect(card).toContain(record.id);
    // This route is Founder-gated, so nothing is withheld from it — and the
    // console says nothing rather than drawing a decorative zero.
    expect(card).not.toContain('item(s) derived from founder_only records are withheld');
    dom.window.close();
  });
});
