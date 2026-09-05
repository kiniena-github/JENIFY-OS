/**
 * The browser control console (issue #200, integration lane).
 *
 * This suite is where the RE-SCOPED site-wide invariant becomes load-bearing:
 *
 *   1. No mutation outside the control API — every fetch target in every
 *      emitted page is allow-listed against the control routes plus the
 *      freshness snapshot, and every POST helper call is allow-listed against
 *      the three write routes.
 *   2. No control rendered that /session did not grant — the grant decision
 *      is one embedded source string, executed here directly (the
 *      `FRESHNESS_VERDICT_JS` pattern), and it is deny-by-default in the
 *      strictest usable sense: only a literal `true` grants anything.
 *
 * Plus: the composer's idempotency-key policy (retry-safe, rotate only on a
 * confirmed outcome), the founder-only live route availability on /session
 * (evidence-derived, never descriptor-derived), and the no-secret rule over
 * the pages that now carry the console scripts.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_FETCH_TARGETS,
  CONTROL_GRANT_JS,
  ORDER_KEY_JS,
  approvalsConsoleScript,
  directOrderConsoleScript,
} from '../src/ui/control-console.js';
import { HQ_PAGES, ROUTE_STATE_PRESENTATION } from '../src/ui/render.js';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { SNAPSHOT_FILENAME } from '../src/ui/live-refresh.js';
import { CONTROL_ROUTES, handleControlRequest, type ControlApiDeps } from '../src/live/control-api.js';
import { CONNECTION_CATALOG } from '../src/live/connections.js';
import {
  registerDirectOrderCapability,
  DIRECT_ORDER_CAPABILITY,
} from '../src/live/orders.js';
import { setupFixture } from './application.fixture.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;
const site = buildSite(sample);

/* ------------------------------------------------------------------ */
/* Invariant half 1: no mutation outside the control API               */
/* ------------------------------------------------------------------ */

/** Every inline script block on a page, concatenated. */
function scriptsOf(html: string): string {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n');
}

describe('the composer offers a route that will be RECORDED and BLOCKED (issue #224)', () => {
  // The server no longer refuses a disconnected explicit route: the order is
  // recorded and reported BLOCKED. A composer that still hid the control would
  // withhold the exact flow the correction exists to give the Founder, leaving
  // only API and CLI callers able to use it.
  const composer = directOrderConsoleScript(ROUTE_STATE_PRESENTATION);
  const approvals = approvalsConsoleScript();

  it('creates the radio control on every route, connected or not', () => {
    // One creation site, reached by all three routes — there is no longer a
    // branch that renders inert text instead of a control.
    expect(composer.match(/radio\.name = 'hq-order-route'/g)).toHaveLength(1);
    expect(composer).not.toContain('row.textContent = name');
  });

  it('says plainly what submitting a disconnected route will do', () => {
    expect(composer).toContain('NOT CONNECTED: the order will be RECORDED and BLOCKED, not started.');
    // And still marks the row, so it does not read as an available route.
    expect(composer).toContain("row.className = 'row order-route-blocked'");
  });

  it('shows the bound provider and the blocked outcome after submitting', () => {
    // Reporting only the resolved route printed an arrow to null and read as
    // an ordinary pending approval.
    expect(composer).toContain('body.boundProvider');
    expect(composer).toContain('body.dispatchBlocked === true');
    expect(composer).toContain('BLOCKED');
    expect(composer).toContain('nothing is running');
  });

  it('renders the blocked state on an approval card', () => {
    expect(approvals).toContain('card.dispatchBlocked === true');
    expect(approvals).toContain('BLOCKED');
  });
});

describe('every page script speaks only to the control API and the snapshot', () => {
  it('allow-lists every fetch call site on every page', () => {
    // The scripts are written so each `fetch(` names either the snapshot
    // literal or a *_PATH variable assigned below from a control route. A
    // fetch spelled any other way fails this test — which is the point.
    const allowedFetchHeads = [
      `fetch(${JSON.stringify(SNAPSHOT_FILENAME)}`,
      'fetch(SESSION_PATH',
      'fetch(APPROVALS_PATH',
      'fetch(MISSIONS_PATH', // Phase 3: the Founder-gated mission read
      'fetch(path,', // postJson's parameter; its call sites are audited below
    ];
    for (const page of HQ_PAGES) {
      const scripts = scriptsOf(site.get(page.file)!);
      for (const match of scripts.matchAll(/fetch\([^)]{0,40}/g)) {
        const head = match[0]!;
        expect(
          allowedFetchHeads.some((allowed) => head.startsWith(allowed)),
          `${page.file}: unexpected fetch call site: ${head}`,
        ).toBe(true);
      }
    }
  });

  it('allow-lists every read() call site against the two authenticated read routes', () => {
    // `read(path)` is the Stage 4 client runtime's indirection over `fetch`.
    // Its own `fetch(path,` head is on the allow-list above, so without this
    // second audit the indirection would be a hole in the first one: any path
    // at all could reach the network through it.
    for (const page of HQ_PAGES) {
      const scripts = scriptsOf(site.get(page.file)!);
      for (const match of scripts.matchAll(/[^a-zA-Z_]read\((\w+)[,)]/g)) {
        expect(
          ['SESSION_PATH', 'STATE_PATH', 'path'].includes(match[1]!),
          `${page.file}: unexpected read target: ${match[1]}`,
        ).toBe(true);
      }
    }
  });

  it('allow-lists every postJson call site against the six write routes', () => {
    // Three until Phase 3; the mission command/transition/amend writes joined
    // with issue #254 — the same Founder-approved widening the route-table
    // test records.
    for (const page of HQ_PAGES) {
      const scripts = scriptsOf(site.get(page.file)!);
      for (const match of scripts.matchAll(/postJson\((\w+)[,)]/g)) {
        expect(
          [
            'ORDERS_PATH',
            'APPROVE_PATH',
            'DENY_PATH',
            'MISSIONS_PATH',
            'TRANSITION_PATH',
            'AMEND_PATH',
            'path',
          ].includes(match[1]!),
          `${page.file}: unexpected postJson target: ${match[1]}`,
        ).toBe(true);
      }
    }
  });

  it('binds every *_PATH variable to the canonical control route, verbatim', () => {
    const index = scriptsOf(site.get('index.html')!);
    expect(index).toContain(`var SESSION_PATH = ${JSON.stringify(CONTROL_ROUTES.session)};`);
    expect(index).toContain(`var ORDERS_PATH = ${JSON.stringify(CONTROL_ROUTES.orders)};`);
    expect(index).toContain(`var MISSIONS_PATH = ${JSON.stringify(CONTROL_ROUTES.missions)};`);
    const approvals = scriptsOf(site.get('approvals.html')!);
    expect(approvals).toContain(`var SESSION_PATH = ${JSON.stringify(CONTROL_ROUTES.session)};`);
    expect(approvals).toContain(`var APPROVALS_PATH = ${JSON.stringify(CONTROL_ROUTES.approvals)};`);
    expect(approvals).toContain(`var APPROVE_PATH = ${JSON.stringify(CONTROL_ROUTES.approve)};`);
    expect(approvals).toContain(`var DENY_PATH = ${JSON.stringify(CONTROL_ROUTES.deny)};`);
    const projects = scriptsOf(site.get('projects.html')!);
    expect(projects).toContain(`var MISSIONS_PATH = ${JSON.stringify(CONTROL_ROUTES.missions)};`);
    expect(projects).toContain(
      `var TRANSITION_PATH = ${JSON.stringify(CONTROL_ROUTES.missionTransition)};`,
    );
    expect(projects).toContain(`var AMEND_PATH = ${JSON.stringify(CONTROL_ROUTES.missionAmend)};`);
  });

  it('names no absolute URL and no path outside the allow-list in any script', () => {
    const allowed = new Set<string>([...CONTROL_FETCH_TARGETS]);
    for (const page of HQ_PAGES) {
      const scripts = scriptsOf(site.get(page.file)!);
      expect(scripts, page.file).not.toContain('http://');
      expect(scripts, page.file).not.toContain('https://');
      for (const literal of scripts.matchAll(/"(\/[A-Za-z0-9/._-]*)"/g)) {
        expect(allowed.has(literal[1]!), `${page.file}: unexpected path literal ${literal[1]}`).toBe(
          true,
        );
      }
    }
  });

  it('builds server-supplied text with textContent, never innerHTML', () => {
    for (const page of HQ_PAGES) {
      const scripts = scriptsOf(site.get(page.file)!);
      expect(scripts, page.file).not.toContain('innerHTML');
      expect(scripts, page.file).not.toContain('outerHTML');
      expect(scripts, page.file).not.toContain('insertAdjacentHTML');
      expect(scripts, page.file).not.toContain('document.write');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Invariant half 2: no control rendered that /session did not grant   */
/* ------------------------------------------------------------------ */

type Grant = { directOrder: boolean; approve: boolean; deny: boolean; reason: string };

function grantedControls(): (session: unknown) => Grant {
  return new Function(`${CONTROL_GRANT_JS}; return grantedControls;`)() as (
    session: unknown,
  ) => Grant;
}

describe('the shipped grant rule is deny-by-default', () => {
  const grant = grantedControls();

  it('grants nothing for a missing, scalar, or malformed session answer', () => {
    for (const hostile of [undefined, null, '', 'ok', 42, true, [], {}]) {
      const verdict = grant(hostile);
      expect(verdict.directOrder, JSON.stringify(hostile)).toBe(false);
      expect(verdict.approve, JSON.stringify(hostile)).toBe(false);
      expect(verdict.deny, JSON.stringify(hostile)).toBe(false);
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it('grants nothing without ok:true, founder:true AND a controls object', () => {
    for (const hostile of [
      { ok: false, founder: true, controls: { directOrder: true, approve: true, deny: true } },
      { ok: true, founder: false, controls: { directOrder: true, approve: true, deny: true } },
      { ok: true, founder: 'true', controls: { directOrder: true } },
      { ok: 1, founder: true, controls: { directOrder: true } },
      { ok: true, founder: true },
      { ok: true, founder: true, controls: null },
      { ok: true, founder: true, controls: 'all' },
    ]) {
      const verdict = grant(hostile);
      expect(verdict.directOrder, JSON.stringify(hostile)).toBe(false);
      expect(verdict.approve, JSON.stringify(hostile)).toBe(false);
      expect(verdict.deny, JSON.stringify(hostile)).toBe(false);
    }
  });

  it('treats truthy-but-not-true control flags as not granted', () => {
    const verdict = grant({
      ok: true,
      founder: true,
      controls: { directOrder: 'yes', approve: 1, deny: {} },
    });
    expect(verdict).toMatchObject({ directOrder: false, approve: false, deny: false });
  });

  it('grants exactly the controls stated as literally true', () => {
    const verdict = grant({
      ok: true,
      founder: true,
      controls: { directOrder: true, approve: false, deny: true },
    });
    expect(verdict).toMatchObject({ directOrder: true, approve: false, deny: true });
  });

  it('explains itself in the server’s words when the server gave any', () => {
    const verdict = grant({ ok: true, founder: false, message: 'This account is signed in but is not the HQ Founder.' });
    expect(verdict.reason).toBe('This account is signed in but is not the HQ Founder.');
  });
});

describe('the composer’s idempotency key is retry-safe', () => {
  const keyAfter = new Function(
    `var window = { crypto: undefined }; ${ORDER_KEY_JS}; return orderKeyAfterSubmit;`,
  )() as (outcome: string, current: string, fresh: string) => string;

  it('keeps the same key while no outcome was confirmed, so a retry cannot duplicate', () => {
    for (const outcome of ['refused', 'network_error', '', 'anything-else']) {
      expect(keyAfter(outcome, 'key-1', 'key-2'), outcome).toBe('key-1');
    }
  });

  it('rotates the key only after the server confirmed created or deduplicated', () => {
    expect(keyAfter('created', 'key-1', 'key-2')).toBe('key-2');
    expect(keyAfter('deduplicated', 'key-1', 'key-2')).toBe('key-2');
  });
});

describe('the static markup stays inert with the consoles mounted', () => {
  it('mounts an EMPTY console container on the Command Center and Approvals pages', () => {
    expect(site.get('index.html')!).toContain('<div data-order-console></div>');
    expect(site.get('approvals.html')!).toContain('<div data-approvals-console></div>');
  });

  it('still ships no static button, form or input on the console pages', () => {
    for (const file of ['index.html', 'approvals.html']) {
      const html = site.get(file)!;
      expect(html, file).not.toContain('<button');
      expect(html, file).not.toContain('<form');
      expect(html, file).not.toContain('<input');
    }
  });
});

/* ------------------------------------------------------------------ */
/* /session route availability: evidence, founder-only                 */
/* ------------------------------------------------------------------ */

function planeDeps(overrides: Partial<ControlApiDeps> = {}): ControlApiDeps {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return {
    ops: fixture.ops,
    sessions: {
      resolve: () => ({
        realmId: 'realm',
        accountId: 'acc-1',
        displayName: 'Founder',
        authenticatedAt: new Date().toISOString(),
      }),
    },
    founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
    allowedOrigins: ['http://localhost:3001'],
    secretsEnv: {},
    ...overrides,
  };
}

function session(deps: ControlApiDeps) {
  return handleControlRequest(
    { method: 'GET', path: CONTROL_ROUTES.session, headers: {} },
    deps,
  );
}

describe('the session answer’s route availability is evidence-derived', () => {
  it('reports every route blocked on a machine where nothing is observed', () => {
    const body = session(planeDeps()).body as { routes: Array<Record<string, unknown>> };
    expect(body.routes).toHaveLength(3);
    for (const route of body.routes) {
      expect(route.connected, String(route.requested)).toBe(false);
      expect(route.resolved, String(route.requested)).toBeNull();
    }
  });

  it('reports exactly the provider whose facts are observed, and never substitutes', () => {
    const body = session(
      planeDeps({ secretsEnv: { CLAUDE_ROUTINE_URL: 'x', CLAUDE_ROUTINE_TOKEN: 'y' } }),
    ).body as { routes: Array<{ requested: string; connected: boolean; resolved: string | null }> };
    const byRoute = new Map(body.routes.map((route) => [route.requested, route]));
    expect(byRoute.get('CLAUDE')).toMatchObject({ connected: true, resolved: 'CLAUDE' });
    expect(byRoute.get('CODEX')).toMatchObject({ connected: false, resolved: null });
    expect(byRoute.get('AUTO')).toMatchObject({ connected: true, resolved: 'CLAUDE' });
  });

  it('never leaks an observed fact VALUE through the session answer', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const facts = Object.fromEntries(
      CONNECTION_CATALOG.flatMap((d) => d.requiredFacts).map((fact) => [fact, secret]),
    );
    const result = session(planeDeps({ secretsEnv: { ...facts, CLAUDE_ROUTINE_URL: secret, CLAUDE_ROUTINE_TOKEN: secret } }));
    // assertBrowserSafe refuses a leaking body outright; and the serialized
    // answer must not carry the value even in a reason string.
    expect(JSON.stringify(result.body)).not.toContain(secret);
  });

  it('offers no route availability to a caller the founder map does not name', () => {
    const body = session(planeDeps({ founderMap: [] })).body as Record<string, unknown>;
    expect(body.founder).toBe(false);
    expect(body.routes).toBeUndefined();
  });

  it('offers no route availability to an unauthenticated caller', () => {
    const result = session(planeDeps({ sessions: { resolve: () => null } }));
    expect(result.status).toBe(401);
    expect((result.body as Record<string, unknown>).routes).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* No secret reaches the pages that now carry scripts                  */
/* ------------------------------------------------------------------ */

describe('console scripts add no secret path to the rendered pages', () => {
  it('keeps observed credential values out of every page even with every fact loaded', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const env = Object.fromEntries(
      CONNECTION_CATALOG.flatMap((descriptor) => descriptor.requiredFacts).map((fact) => [fact, secret]),
    );
    const loaded = buildSite({ ...sample, env });
    for (const page of HQ_PAGES) {
      expect(loaded.get(page.file)!, page.file).not.toContain(secret);
    }
  });
});
