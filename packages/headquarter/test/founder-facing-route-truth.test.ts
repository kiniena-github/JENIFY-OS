/**
 * The two Founder-facing pages must agree about CLAUDE (issue #230, the
 * Founder-gate browser finding on the corrected head).
 *
 * ## What the Founder actually saw
 *
 * Signed in as the APPROVER — approval authority, and deliberately no
 * `hq.direct_order` originate grant, exactly as the no-self-approval rule
 * intends — on a workstation whose `gh` transport is authenticated and whose
 * `CLAUDE_ROUTINE_*` workflow secrets are (correctly) absent:
 *
 *   /hq/connections.html : CLAUDE — "Dispatchable — unverified"   (live truth)
 *   /hq/index.html       : CLAUDE — "Blocked — not connected"     (build-time)
 *
 * Same host, same instant, same execution path, two answers. Issue #226 closed
 * this defect class on the Connections page; the Command Center's static route
 * blocks still carried it, because the live verdicts were only ever drawn
 * INSIDE the composer — and the composer is drawn only for a principal holding
 * the originate grant. A Founder who signs in to APPROVE never gets one.
 *
 * ## The rule these tests lock
 *
 * Route availability is a fact about the world, not a control. Whether CLAUDE
 * can dispatch from this host must not depend on who is looking at it, and must
 * never be answered from build-time provider facts once a live answer is
 * available.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { CONTROL_ROUTES, handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import type { ControlRequest } from '../src/live/auth.js';
import type { ProviderId } from '../src/routing/providers.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';
import { setupFixture } from './application.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

const PAGE_ORIGIN = 'http://localhost:3102';

/**
 * The workstation shape: `gh` observed authenticated (so CLAUDE dispatches),
 * and NO `CLAUDE_ROUTINE_*` anywhere — they are GitHub Actions secrets.
 */
const CLAUDE_DISPATCHABLE = (provider: ProviderId): boolean | null =>
  provider === 'CLAUDE' ? true : null;

/**
 * Two principals, and the difference between them is the whole point:
 * `approver` holds approval authority and NO originate grant, so the composer
 * is correctly withheld from them.
 */
function deps(role: 'approver' | 'originator', overrides: Partial<ControlApiDeps> = {}): ControlApiDeps {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'proof-principal',
    displayName: role === 'approver' ? 'HQ Proof Approver' : 'HQ Proof Originator',
    originateCapabilities: role === 'originator' ? [DIRECT_ORDER_CAPABILITY.id] : [],
    approvalAuthority: true,
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
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'proof-principal' }],
    allowedOrigins: [PAGE_ORIGIN],
    // The workstation's real shape: no workflow secrets present.
    secretsEnv: {},
    dispatchAvailability: CLAUDE_DISPATCHABLE,
    mutationsEnabled: true,
    ...overrides,
  };
}

/** Load one emitted page and let its own scripts run against the real API. */
async function loadPage(file: string, api: ControlApiDeps): Promise<{ dom: JSDOM; errors: string[] }> {
  const html = buildSite({ ...sample, env: {} }).get(file);
  if (html == null) throw new Error(`buildSite emitted no ${file}`);
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: `${PAGE_ORIGIN}/hq/${file}`,
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
          headers: { referer: `${PAGE_ORIGIN}/hq/${file}` },
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

function claudeRouteBlock(dom: JSDOM) {
  const block = dom.window.document.querySelector('[data-route="CLAUDE"]')!;
  return {
    chip: block.querySelector('[data-route-state-chip] .chip')?.textContent ?? '',
    reason: block.querySelector('[data-route-reason]')?.textContent ?? '',
    liveState: block.getAttribute('data-route-live-state'),
    staticState: block.getAttribute('data-route-static-state'),
  };
}

function claudeConnectionCard(dom: JSDOM) {
  const card = dom.window.document.querySelector('[data-connection="anthropic-claude"]')!;
  return {
    chip: card.querySelector('[data-connection-state-chip] .chip')?.textContent ?? '',
    liveState: card.getAttribute('data-connection-live-state'),
  };
}

describe('Command Center route truth does not depend on who is looking (issue #230)', () => {
  it('reproduces the build-time claim before any script runs', () => {
    const html = buildSite({ ...sample, env: {} }).get('index.html')!;
    const dom = new JSDOM(html);
    const block = claudeRouteBlock(dom);
    // This is exactly what the Founder was left looking at.
    expect(block.staticState).toBe('blocked');
    expect(block.chip).toBe('Blocked — not connected');
    expect(block.liveState).toBeNull();
  });

  it('corrects CLAUDE to Available for an APPROVER who holds no originate grant', async () => {
    const api = deps('approver');
    // The premise: this session is a Founder, is NOT granted the composer, and
    // the server nonetheless knows CLAUDE is dispatchable.
    const probe = handleControlRequest(
      { method: 'GET', path: CONTROL_ROUTES.session, headers: { referer: `${PAGE_ORIGIN}/hq/index.html` } },
      api,
    ).body as { founder: boolean; controls: { directOrder: boolean }; routes: Array<{ requested: string; connected: boolean }> };
    expect(probe.founder).toBe(true);
    expect(probe.controls.directOrder).toBe(false);
    expect(probe.routes.find((r) => r.requested === 'CLAUDE')?.connected).toBe(true);

    const { dom, errors } = await loadPage('index.html', api);
    expect(errors, 'the page must not throw before it draws').toEqual([]);

    const block = claudeRouteBlock(dom);
    expect(block.chip).toBe('Available');
    expect(block.liveState).toBe('ready');
    expect(block.reason).toContain('Live, from the same-origin control API just now');
    // The exact false claim the Founder reported.
    expect(block.chip).not.toBe('Blocked — not connected');
    // The workflow-secret view may still appear as provenance, but only AFTER
    // the live verdict — never as the leading claim.
    const dispatchableAt = block.reason.indexOf('is dispatchable from this host');
    const missingAt = block.reason.indexOf('missing credential(s)');
    expect(dispatchableAt).toBeGreaterThanOrEqual(0);
    if (missingAt >= 0) expect(dispatchableAt).toBeLessThan(missingAt);
  });

  it('shows the same CLAUDE verdict to an originator, who also gets the composer', async () => {
    const { dom, errors } = await loadPage('index.html', deps('originator'));
    expect(errors).toEqual([]);
    expect(claudeRouteBlock(dom).chip).toBe('Available');
    // And the composer really is drawn for this one — the grant still governs
    // the CONTROL, exactly as before; only the FACT stopped depending on it.
    expect(dom.window.document.querySelector('[data-order-console-form]')).not.toBeNull();
  });

  it('CODEX stays truthfully blocked in the same pass — nothing is blanket-greened', async () => {
    const { dom } = await loadPage('index.html', deps('approver'));
    const codex = dom.window.document.querySelector('[data-route="CODEX"]')!;
    expect(codex.getAttribute('data-route-live-state')).toBe('blocked');
    expect(codex.querySelector('[data-route-state-chip] .chip')?.textContent).toBe('Blocked — not connected');
  });

  it('AGREES with the Connection Center for the same session and instant', async () => {
    const api = deps('approver');
    const command = claudeRouteBlock((await loadPage('index.html', api)).dom);
    const connections = claudeConnectionCard((await loadPage('connections.html', api)).dom);
    // The defect was that these two disagreed. Both now derive from the same
    // /session routes field, so agreement is structural rather than lucky.
    expect(command.liveState).toBe('ready');
    expect(connections.liveState).toBe('dispatchable');
    expect(command.chip).toBe('Available');
    expect(connections.chip).toBe('Dispatchable — unverified');
  });

  it('leaves the build-time render alone when the control API is unreachable', async () => {
    const html = buildSite({ ...sample, env: {} }).get('index.html')!;
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
    const dom = new JSDOM(html, {
      url: `${PAGE_ORIGIN}/hq/index.html`,
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window: Record<string, unknown>) {
        window.fetch = () => Promise.reject(new Error('network unreachable'));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);
    const block = claudeRouteBlock(dom);
    expect(block.liveState).toBeNull();
    expect(block.chip).toBe('Blocked — not connected');
  });

  it('invents nothing for a non-Founder session, which carries no routes at all', async () => {
    const api = deps('approver', { founderMap: [] });
    const { dom } = await loadPage('index.html', api);
    const block = claudeRouteBlock(dom);
    expect(block.liveState).toBeNull();
    expect(block.chip).toBe('Blocked — not connected');
  });
});
