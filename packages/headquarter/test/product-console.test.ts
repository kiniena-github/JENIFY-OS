/**
 * The EMITTED Product Factory console on projects.html (Phase 12), executed as
 * a browser executes it — the Phase 9/10/11 console pattern: real emitted page,
 * real inline scripts, `fetch` answered by the REAL control API against a real
 * `HeadquarterOperations`.
 *
 * What this proves beyond "it renders": the emitted markup is inert; the
 * console draws NO release, publish or deploy control and no progress number;
 * a Founder's lifecycle move reaches the canonical record and comes back with
 * the honest "nothing external happened" line; and a session with no product
 * grant gets the reads with the write controls off, stated rather than hidden.
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
import { productFactoryConsoleScript } from '../src/ui/control-console.js';
import { productFixture, type ProductFixture } from './product-factory.fixture.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;
const PAGE_ORIGIN = 'http://localhost:3101';

function deployment(options: { founder?: boolean; grantProduct?: boolean } = {}): {
  api: ControlApiDeps;
  fixture: ProductFixture;
} {
  const fixture = productFixture();
  if (options.grantProduct === false) {
    // Registered but not granted: the console must draw the READS and state
    // why the write controls are off, rather than pretending they work.
    fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [],
      approvalAuthority: true,
      active: true,
    });
  }
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
  const page = buildSite(sample).get('projects.html');
  if (page == null) throw new Error('buildSite emitted no projects.html');
  return page;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('the Product Factory console’s emitted markup stays inert', () => {
  it('carries a mount and a note, and no input, button or form', () => {
    const html = pageHtml();
    expect(html).toContain('data-product-factory-console');
    const at = html.indexOf('data-product-factory-console');
    const inert = html.slice(Math.max(0, at - 2000), at);
    expect(inert).not.toContain('<button');
    expect(inert).not.toContain('<input');
    expect(inert).not.toContain('<form');
    // The three laws the section must let a reader rely on.
    expect(html).toContain('never task or worker state');
    expect(html).toContain('There is no release, publish or deploy control here');
    expect(html).toContain('append-only by the database engine itself');
  });

  it('names only the four product paths, and never a release one', () => {
    const script = productFactoryConsoleScript();
    // Every write this console can issue, enumerated from the script itself.
    const posts = [...script.matchAll(/postJson\(([A-Za-z_]+)/g)].map((match) => match[1]);
    // The only `postJson(` call site names the shared helper's own parameter;
    // every real target goes through `handleWrite`, enumerated below.
    expect([...new Set(posts)].sort()).toEqual(['path']);
    const handleWriteTargets = [...script.matchAll(/handleWrite\(([A-Z_]+)/g)].map((match) => match[1]);
    expect([...new Set(handleWriteTargets)].sort()).toEqual([
      'PRODUCTS_PATH',
      'PRODUCT_ARTIFACTS_PATH',
      'PRODUCT_LIFECYCLE_PATH',
    ]);
    expect(script).not.toContain('innerHTML');
    for (const forbidden of ['RELEASE_PATH', 'PUBLISH_PATH', 'DEPLOY_PATH']) {
      expect(script).not.toContain(forbidden);
    }
  });

  it('draws no percentage, share, progress bar or ETA for a product', () => {
    const script = productFactoryConsoleScript();
    // The lifecycle is nine ordered names; turning them into a number would
    // be inventing a figure the record does not carry.
    for (const forbidden of [
      /completedShare/i,
      /percent/i,
      /\bmeter\(/i,
      /progress/i,
      /\beta\b/i,
      /\bestimat/i,
      /\bremaining\b/i,
    ]) {
      expect(script, `the console must not draw ${String(forbidden)}`).not.toMatch(forbidden);
    }
  });
});

describe('the console drawn for a Founder holding the product grant', () => {
  it('shows the product, its canonical project reference and its artifact versions', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    expect(
      document.querySelector('[data-product-factory-state]')!.getAttribute('data-product-factory-state'),
    ).toBe('live');

    const card = document.querySelector(`[data-product-card="${fixture.productId}"]`)!;
    const text = card.textContent!;
    expect(text).toContain('iridium console');
    expect(text).toContain(fixture.projectId);
    expect(text).toContain('references that register entry and does not replace it');
    expect(text).toContain('specification');
    expect(text).toContain('v1');
    expect(text).toContain('never verified by HQ');
    expect(card.querySelector('[data-product-lifecycle]')!.getAttribute('data-product-lifecycle')).toBe('idea');
    dom.window.close();
  });

  it('moves the lifecycle through the canonical route and says nothing external happened', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    const card = document.querySelector(`[data-product-card="${fixture.productId}"]`)!;

    const select = card.querySelector('select') as HTMLSelectElement;
    select.value = 'research';
    const inputs = card.querySelectorAll('input');
    (inputs[0] as HTMLInputElement).value = 'Starting the research from the console.';
    const buttons = [...card.querySelectorAll('button')] as HTMLButtonElement[];
    const move = buttons.find((button) => button.textContent === 'Record the move')!;
    move.click();
    await settle();

    // The canonical record moved…
    expect(fixture.ops.getProduct(fixture.productId)!.lifecycle).toBe('research');
    // …and the page says what did and did not happen, on a line that
    // SURVIVES the reload the write triggers.
    expect(document.querySelector('[data-product-outcome]')!.textContent).toBe(
      'Recorded. Nothing external happened.',
    );
    dom.window.close();
  });

  it('refuses to send a lifecycle move with no note, from the page itself', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    const card = document.querySelector(`[data-product-card="${fixture.productId}"]`)!;
    const buttons = [...card.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent === 'Record the move')!.click();
    await settle();
    expect(card.textContent).toContain('Every lifecycle move needs a recorded note. Nothing was sent.');
    expect(fixture.ops.getProduct(fixture.productId)!.lifecycle).toBe('idea');
    dom.window.close();
  });

  it('shows the plan template and the readiness observation without offering to apply either', async () => {
    const { api, fixture } = deployment();
    const dom = await loadPage(api);
    const document = dom.window.document;
    const card = document.querySelector(`[data-product-card="${fixture.productId}"]`)!;
    const buttons = [...card.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent!.startsWith('Show the plan template'))!.click();
    await settle();

    const detail = document.querySelector(`[data-product-detail="${fixture.productId}"]`)!;
    const text = detail.textContent!;
    expect(text).toContain('template.web.v1');
    expect(text).toContain('RECOMMENDATION');
    expect(text).toContain('hq.mission_command');
    expect(text).toContain('an observation, never an authorization');
    expect(text).toContain('no_release_candidate_artifact');
    // No control anywhere offers to turn the plan into work, or to release.
    const labels = [...detail.querySelectorAll('button')].map((button) => button.textContent ?? '');
    expect(labels).toEqual([]);
    dom.window.close();
  });

  it('publishes the release gate verbatim on the page', async () => {
    const { api } = deployment();
    const dom = await loadPage(api);
    const text = dom.window.document.querySelector('[data-product-list]')!.textContent!;
    expect(text).toContain('HQ has no product release path');
    expect(text).toContain('the Phase 8 gateway');
    dom.window.close();
  });
});

describe('the console is honest about a session it cannot write with', () => {
  it('draws the register and states why the controls are off', async () => {
    const { api, fixture } = deployment({ grantProduct: false });
    const dom = await loadPage(api);
    const document = dom.window.document;
    expect(
      document.querySelector('[data-product-factory-state]')!.getAttribute('data-product-factory-state'),
    ).toBe('live');
    const list = document.querySelector('[data-product-list]')!;
    expect(list.textContent).toContain('Product Factory controls are off for this session');
    expect(document.querySelector('[data-product-create]')).toBeNull();
    // The read still works: the product is drawn, without any write control.
    const card = document.querySelector(`[data-product-card="${fixture.productId}"]`)!;
    expect(card.textContent).toContain('iridium console');
    expect(card.querySelector('select')).toBeNull();
    dom.window.close();
  });

  it('draws nothing at all for a session with no Founder grant', async () => {
    const { api } = deployment({ founder: false });
    const dom = await loadPage(api);
    const note = dom.window.document.querySelector('[data-product-factory-state]')!;
    expect(note.getAttribute('data-product-factory-state')).toBe('off');
    expect(note.textContent).toContain('THE PRODUCT REGISTER IS NOT READABLE FROM THIS PAGE');
    expect(dom.window.document.querySelector('[data-product-card]')).toBeNull();
    dom.window.close();
  });
});
