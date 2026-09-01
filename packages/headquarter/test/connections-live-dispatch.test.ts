/**
 * The EMITTED Connections page, executed as a browser executes it (issue
 * #226, correction round on PR #225 — the Connection Center truth defect).
 *
 * ## The contradiction this suite closes
 *
 * `headquarter-host.ts` computes ONE verdict for CLAUDE —
 * `claude.transportRouteAvailability(claude.ghCliTransport()).providerDispatchable`
 * — and hands it to the control API as `dispatchAvailability`. The Command
 * Center composer already reads it (`command-center-live-composer.test.ts`
 * proves that). This page did not: its `anthropic-claude` card was rendered
 * ENTIRELY at site-build time from `CLAUDE_ROUTINE_URL`/`CLAUDE_ROUTINE_TOKEN`
 * presence, so on the Founder workstation — where those GitHub Actions
 * secrets are deliberately absent and CLAUDE dispatches through the
 * authenticated `gh` transport instead — this page said CLAUDE was NOT
 * CONNECTED while the Command Center said it was dispatchable. Two
 * Founder-facing pages, one real execution path, two answers.
 *
 * This suite loads the REAL emitted `connections.html` into a DOM, lets its
 * own inline script run, and answers `/session` with a body produced by the
 * REAL `handleControlRequest` against a real `HeadquarterOperations` — the
 * same pattern `command-center-live-composer.test.ts` uses, so the two pages
 * are proven to read the identical seam rather than two independently-typed
 * ones.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { CONTROL_ROUTES, handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { ControlRequest } from '../src/live/auth.js';
import type { ProviderId } from '../src/routing/providers.js';
import { setupFixture } from './application.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3101';
const PAGE_URL = `${PAGE_ORIGIN}/hq/connections.html`;

/**
 * A resolved Founder viewing the page, exactly as the Founder-gated
 * `registerHeadquarterSite` mount guarantees for anyone who can load this
 * page at all. `secretsEnv` carries NO `CLAUDE_ROUTINE_*` — the demonstrated
 * Founder-workstation shape (issue #226 test requirement 1). Route
 * availability on `/session` does not depend on approval or origination
 * authority, so a minimal registered, active principal is enough.
 */
function deps(overrides: Partial<ControlApiDeps> = {}): ControlApiDeps {
  const fixture = setupFixture();
  fixture.principals.register({
    id: 'hq-proof-founder',
    displayName: 'Proof Founder',
    originateCapabilities: [],
    approvalAuthority: false,
    active: true,
  });
  return {
    ops: fixture.ops,
    sessions: {
      resolve: () => ({
        realmId: 'realm',
        accountId: 'acc-1',
        displayName: 'Proof Founder',
        authenticatedAt: new Date().toISOString(),
      }),
    },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'hq-proof-founder' }],
    allowedOrigins: [PAGE_ORIGIN],
    secretsEnv: {},
    mutationsEnabled: true,
    ...overrides,
  };
}

/** The emitted Connections page, built with CLAUDE workflow secrets absent. */
function connectionsHtml(): string {
  const page = buildSite({ ...sample, env: {} }).get('connections.html');
  if (page == null) throw new Error('buildSite emitted no connections.html');
  return page;
}

interface Loaded {
  dom: JSDOM;
  errors: string[];
}

async function loadPage(api: ControlApiDeps): Promise<Loaded> {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));

  const dom = new JSDOM(connectionsHtml(), {
    url: PAGE_URL,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window: Record<string, unknown>) {
      window.fetch = (input: string) => {
        const path = String(input).split('?')[0]!;
        if (path.endsWith(SNAPSHOT_FILENAME)) {
          return Promise.resolve({ status: 404, json: () => Promise.reject(new Error('no snapshot')) });
        }
        const request: ControlRequest = {
          method: 'GET',
          path,
          headers: { referer: PAGE_URL },
        };
        const result = handleControlRequest(request, api);
        return Promise.resolve({ status: result.status, json: () => Promise.resolve(result.body) });
      };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, errors };
}

function claudeCard(dom: JSDOM) {
  const document = dom.window.document;
  const card = document.querySelector('[data-connection="anthropic-claude"]')!;
  return {
    card,
    chipText: card.querySelector('[data-connection-state-chip] .chip')?.textContent ?? '',
    chipTone: card.querySelector('[data-connection-state-chip] .chip')?.className ?? '',
    reason: card.querySelector('[data-connection-reason]')?.textContent ?? '',
    liveState: card.getAttribute('data-connection-live-state'),
  };
}

function codexCard(dom: JSDOM) {
  const document = dom.window.document;
  const card = document.querySelector('[data-connection="openai-codex"]')!;
  return {
    chipText: card.querySelector('[data-connection-state-chip] .chip')?.textContent ?? '',
    reason: card.querySelector('[data-connection-reason]')?.textContent ?? '',
    liveState: card.getAttribute('data-connection-live-state'),
  };
}

function kpiValue(dom: JSDOM, key: string): string | null {
  return dom.window.document.querySelector(`[data-kpi="${key}"] .kpi-value`)?.textContent ?? null;
}

describe('Connection Center truth for CLAUDE, live against the control API (issue #226)', () => {
  it('draws NOT CONNECTED at build time when CLAUDE workflow secrets are absent (the defect, before any script runs)', () => {
    const html = connectionsHtml();
    expect(html).toContain('data-connection="anthropic-claude"');
    // The static baseline, unpatched: this is what the Founder actually saw.
    const before = new JSDOM(html);
    const card = before.window.document.querySelector('[data-connection="anthropic-claude"]')!;
    expect(card.querySelector('[data-connection-state-chip] .chip')?.textContent).toBe('Not connected');
    expect(card.querySelector('[data-connection-reason]')?.textContent).toContain('CLAUDE_ROUTINE_URL');
  });

  it('presents CLAUDE as dispatchable when the transport is observed authenticated, and drops the NOT CONNECTED verdict', async () => {
    const api = deps({ dispatchAvailability: (provider: ProviderId) => (provider === 'CLAUDE' ? true : null) });
    // The premise, from the exact seam the Command Center composer reads.
    const probe = handleControlRequest(
      { method: 'GET', path: CONTROL_ROUTES.session, headers: { referer: PAGE_URL } },
      api,
    ).body as { routes: Array<{ requested: string; connected: boolean }> };
    expect(probe.routes.find((r) => r.requested === 'CLAUDE')).toMatchObject({ connected: true });

    const { dom, errors } = await loadPage(api);
    expect(errors, 'the page must not throw before it draws').toEqual([]);

    const claude = claudeCard(dom);
    // The top-level verdict — the chip, exactly what the Founder reads first
    // — is DISPATCHABLE, never "Not connected".
    expect(claude.chipText).toBe('Dispatchable — unverified');
    expect(claude.chipTone).toContain('tone-info');
    expect(claude.liveState).toBe('dispatchable');
    expect(claude.reason).toContain('Live, from the same-origin control API just now');
    expect(claude.reason).toContain('CLAUDE is dispatchable from this host');
    // The workflow-side facts may still appear as provenance/context, but
    // only AFTER — never in place of — the live dispatchable verdict; the
    // reason must not LEAD with the routing contract's own blocked reading.
    const dispatchableAt = claude.reason.indexOf('CLAUDE is dispatchable from this host');
    const notConnectedAt = claude.reason.indexOf('NOT CONNECTED');
    expect(dispatchableAt).toBeGreaterThanOrEqual(0);
    if (notConnectedAt >= 0) expect(dispatchableAt).toBeLessThan(notConnectedAt);

    // The KPI row must not go on reading zero dispatchable providers while
    // the card right below it says otherwise.
    expect(kpiValue(dom, 'dispatchable')).toBe('1');
  });

  it('reports a truthful unavailable state when the transport was checked live and found unauthenticated', async () => {
    const api = deps({ dispatchAvailability: (provider: ProviderId) => (provider === 'CLAUDE' ? false : null) });
    const { dom, errors } = await loadPage(api);
    expect(errors).toEqual([]);

    const claude = claudeCard(dom);
    expect(claude.liveState).toBe('not_connected');
    // Checked live and refused — not the generic "never probed" state, and
    // still never claims connectivity.
    expect(claude.chipText).not.toBe('Dispatchable — unverified');
    expect(claude.chipText).not.toBe('Connected');
    expect(claude.reason).toContain('Live, from the same-origin control API just now');
  });

  it('invents no connection when this host does not know (dispatchAvailability is null)', async () => {
    // No dispatchAvailability supplied at all — the exact shape of a host with
    // no transport, or a static preview server standing in for the control API.
    const api = deps();
    const { dom, errors } = await loadPage(api);
    expect(errors).toEqual([]);

    const claude = claudeCard(dom);
    // Falls back to the same routing-contract fact-presence truth the static
    // build already used — CLAUDE_ROUTINE_* are absent, so still not usable.
    expect(claude.chipText).not.toBe('Dispatchable — unverified');
    expect(claude.chipText).not.toBe('Connected');
    expect(claude.liveState).toBe('not_connected');
  });

  it('leaves the build-time card exactly as it was when the control API is unreachable', async () => {
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
    const dom = new JSDOM(connectionsHtml(), {
      url: PAGE_URL,
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window: Record<string, unknown>) {
        window.fetch = () => Promise.reject(new Error('network unreachable'));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);

    const claude = claudeCard(dom);
    expect(claude.liveState).toBeNull();
    expect(claude.chipText).toBe('Not connected');
    expect(claude.reason).toContain('CLAUDE_ROUTINE_URL');
    expect(claude.reason).not.toContain('Live, from the same-origin control API');
  });

  it('never marks Codex or any other provider connected, even when dispatchAvailability is generously true for everything', async () => {
    const before = codexCard(new JSDOM(connectionsHtml()));
    const api = deps({ dispatchAvailability: () => true });
    const { dom, errors } = await loadPage(api);
    expect(errors).toEqual([]);

    const codex = codexCard(dom);
    // Untouched: this correction is scoped to the demonstrated CLAUDE defect.
    expect(codex.liveState).toBeNull();
    expect(codex.chipText).toBe(before.chipText);
    expect(codex.reason).toBe(before.reason);
  });

  it('emits no secret value anywhere, even with every catalogued fact loaded', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const html = buildSite({
      ...sample,
      env: { CLAUDE_ROUTINE_URL: secret, CLAUDE_ROUTINE_TOKEN: secret },
    }).get('connections.html')!;
    expect(html).not.toContain(secret);
  });
});
