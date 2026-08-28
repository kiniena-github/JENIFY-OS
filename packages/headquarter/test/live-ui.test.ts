/**
 * LIVE HQ CONTROL UI (issue #200 — Connections page, Direct Order composer,
 * provenance chips, freshness indicator).
 *
 * The site-wide honesty invariants from `site.test.ts` still hold and are
 * re-asserted here against the NEW surfaces specifically: nothing on any page
 * is a working control, nothing claims a freshness it has not checked, and no
 * observed fact value reaches rendered HTML.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HQ_PAGES, DIRECT_ORDER_BLOCKER } from '../src/ui/render.js';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import {
  FRESHNESS_VERDICT_JS,
  SNAPSHOT_FILENAME,
  SNAPSHOT_POLL_INTERVAL_MS,
} from '../src/ui/live-refresh.js';
import { CONNECTION_CATALOG } from '../src/live/connections.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

/** Every catalogue fact set to a credential-shaped value. */
const LOADED_ENV = Object.fromEntries(
  CONNECTION_CATALOG.flatMap((descriptor) => descriptor.requiredFacts).map((fact) => [
    fact,
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ]),
);

const bare = buildSite(sample);
const loaded = buildSite({ ...sample, env: LOADED_ENV });

/**
 * The browser's own freshness rule, executed rather than grepped for.
 *
 * `FRESHNESS_VERDICT_JS` is the exact source embedded in every page, so these
 * assertions run the shipped implementation — a label test would pass even if
 * the branch behind the label were wrong, which is precisely the defect this
 * covers (Codex P1 #3).
 */
function freshnessVerdict(): (
  renderedAt: string,
  generatedAt: unknown,
  mode?: unknown,
) => { state: string; label: string; hint: string } {
  return new Function(`${FRESHNESS_VERDICT_JS}; return freshnessVerdict;`)() as (
    renderedAt: string,
    generatedAt: unknown,
    mode?: unknown,
  ) => { state: string; label: string; hint: string };
}

describe('the Connections page joins the site without disturbing it', () => {
  it('keeps all seven original pages and adds Connections as the eighth', () => {
    expect(HQ_PAGES).toHaveLength(8);
    for (const file of [
      'index.html',
      'projects.html',
      'executive-room.html',
      'direct-chats.html',
      'specialists.html',
      'approvals.html',
      'archive.html',
      'connections.html',
    ]) {
      expect(bare.has(file)).toBe(true);
    }
  });

  it('is reachable from every page’s navigation', () => {
    for (const page of HQ_PAGES) {
      expect(bare.get(page.file)!).toContain('href="connections.html"');
    }
  });

  it('holds the site-wide no-mutation invariant on the new pages too', () => {
    for (const page of HQ_PAGES) {
      const html = bare.get(page.file)!;
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<button');
      expect(html).not.toMatch(/\son(click|submit|load|error|mouseover)=/);
    }
  });

  it('adds no input control on the two new surfaces', () => {
    // The Archive page legitimately carries client-side filter inputs; the
    // Direct Order composer and Connection Center carry none, so neither can
    // look like something that submits.
    expect(bare.get('connections.html')!).not.toContain('<input');
    expect(bare.get('index.html')!).not.toContain('<input');
  });
});

describe('Connections renders evidence, not descriptors', () => {
  const html = bare.get('connections.html')!;

  it('lists every seeded integration', () => {
    for (const descriptor of CONNECTION_CATALOG) {
      expect(html).toContain(`data-connection="${descriptor.id}"`);
    }
  });

  /** The state chip on a connection card, as opposed to a KPI tile label. */
  const stateChip = (label: string, tone: string) =>
    `<span class="chip tone-${tone}"><span class="dot" aria-hidden="true"></span>${label}</span>`;

  it('shows nothing as connected when nothing was observed', () => {
    // The catalogue names Vercel, Supabase and Google Workspace. Naming them
    // must not make any of them look reachable.
    expect(html).not.toContain(stateChip('Connected', 'accent'));
    expect(html).toContain(stateChip('Not connected', 'neutral'));
  });

  it('shows the dispatchable chip — not the connected one — on routing evidence', () => {
    // Codex round-3 P1 #3: satisfying the routing dispatch contract is not a
    // live check, so the page must not draw the Connected chip for it.
    const routable = buildSite({
      ...sample,
      env: { CLAUDE_ROUTINE_URL: 'x', CLAUDE_ROUTINE_TOKEN: 'y' },
    }).get('connections.html')!;
    expect(routable).toContain(stateChip('Dispatchable — unverified', 'info'));
    expect(routable).not.toContain(stateChip('Connected', 'accent'));
  });

  it('states plainly that state comes from observed facts, not from the catalogue', () => {
    expect(html).toContain('derived from facts actually observed');
    expect(html).toContain('never that it is reachable');
  });

  it('reports Codex as dispatchable and Local once its local facts are observed', () => {
    const local = buildSite({
      ...sample,
      env: { CODEX_CLI_PATH: '/usr/local/bin/codex', CODEX_AUTH_MODE: 'chatgpt' },
    }).get('connections.html')!;
    expect(local).toContain(stateChip('Dispatchable — unverified', 'info'));
    // The local/cloud distinction is load-bearing and survives on the card.
    expect(local).toContain('>Local<');
    expect(local).not.toContain(stateChip('Connected', 'accent'));
  });

  it('names facts but never renders an observed value', () => {
    const html = loaded.get('connections.html')!;
    expect(html).toContain('CLAUDE_ROUTINE_TOKEN');
    // Presence was read; the value must not appear anywhere in the markup.
    expect(html).not.toContain('ghp_');
  });

  it('draws no Disconnect control, because there is no credential store to revoke from', () => {
    expect(html).toContain('No Disconnect/Revoke control is drawn');
    expect(html).not.toContain('>Disconnect<');
  });

  it('explains the extension seam rather than pretending Add Connection works', () => {
    expect(html).toContain('+ Add Connection');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('deny by default');
  });
});

describe('the Direct Order composer is truthful about being blocked', () => {
  const html = bare.get('index.html')!;

  it('appears on the Command Center', () => {
    expect(html).toContain('<h2>DIRECT ORDER</h2>');
    expect(html).toContain('id="direct-order"');
  });

  it('states the actual blocker rather than showing a live-looking control', () => {
    expect(html).toContain('Headquarter has no authenticated Founder session');
    expect(html).toContain('No weak');
    expect(DIRECT_ORDER_BLOCKER).toContain('hq:order');
    // Start Task is drawn so its place is visible, and is inert.
    expect(html).toContain('<span class="control-readonly" aria-disabled="true">Start Task</span>');
  });

  it('explains that an order is Founder-gated and executes nothing on creation', () => {
    expect(html).toContain('hq.direct_order');
    expect(html).toContain('needs_approval');
    expect(html).toContain('no other provider is ever substituted');
  });

  it('reports each route’s real availability', () => {
    for (const route of ['AUTO', 'CLAUDE', 'CODEX']) {
      expect(html).toContain(`data-route="${route}"`);
    }
    expect(html).toContain('Blocked — not connected');
    const connected = buildSite({
      ...sample,
      env: { CLAUDE_ROUTINE_URL: 'x', CLAUDE_ROUTINE_TOKEN: 'y' },
    }).get('index.html')!;
    expect(connected).toContain('>Available<');
  });
});

describe('provenance and freshness are never overstated', () => {
  it('chips the bundle’s own source mode on every page when it states one', () => {
    const marked = buildSite({ ...sample, sourceMode: 'reconstructed' });
    for (const page of HQ_PAGES) {
      expect(marked.get(page.file)!).toContain('>RECONSTRUCTED<');
    }
    const asSample = buildSite({ ...sample, sourceMode: 'sample' });
    expect(asSample.get('index.html')!).toContain('>SAMPLE<');
  });

  it('makes no source claim for a bundle that states none', () => {
    const html = bare.get('index.html')!;
    for (const label of ['>LIVE<', '>SAMPLE<', '>RECONSTRUCTED<']) {
      expect(html).not.toContain(label);
    }
  });

  it('starts the freshness chip as CHECKING, never as LIVE', () => {
    // Before the first poll returns, the page genuinely does not know.
    for (const page of HQ_PAGES) {
      const html = bare.get(page.file)!;
      expect(html).toContain('data-live-state="checking"');
      expect(html).toContain('CHECKING…');
    }
  });

  it('polls the snapshot within the 10–30s band the brief specifies', () => {
    expect(SNAPSHOT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(SNAPSHOT_POLL_INTERVAL_MS).toBeLessThanOrEqual(30_000);
    expect(bare.get('index.html')!).toContain(SNAPSHOT_FILENAME);
  });

  it('degrades to OFFLINE rather than claiming freshness it cannot verify', () => {
    const html = bare.get('index.html')!;
    expect(html).toContain('OFFLINE — build-time data');
    expect(html).toContain('freshness is unknown');
    // And it can say the page is behind, which is the case a stale render must
    // be able to report.
    expect(html).toContain('UPDATED — page not rebuilt');
    // And it does not promise that reloading will reveal the newer state:
    // these pages are static HTML and the poll renders no snapshot section,
    // so a reload re-serves the same build (Codex round-3 follow-up).
    expect(html).toContain('Rebuild the site to see it');
  });

  it('ships exactly one freshness decision, and the page runs that one', () => {
    // The tests below execute the same source the browser executes. If the
    // page ever grew a second, divergent copy of the rule, this fails.
    expect(bare.get('index.html')!).toContain(FRESHNESS_VERDICT_JS);
  });

  it('claims LIVE only for the exact matching snapshot timestamp', () => {
    // Codex P1 #3: an earlier version treated everything "not newer" as LIVE,
    // so an OLDER snapshot rendered as LIVE. Older is not current.
    const verdict = freshnessVerdict();
    const rendered = '2026-08-28T12:00:00.000Z';

    // `live` provenance is required positively; the timestamp alone is not
    // enough (see the mode test below).
    expect(verdict(rendered, rendered, 'live').state).toBe('live');

    for (const older of [
      '2026-08-28T11:59:59.999Z',
      '2026-08-28T11:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    ]) {
      const result = verdict(rendered, older);
      expect(result.state, `${older} must not read as live`).toBe('stale');
      expect(result.label).not.toContain('LIVE');
    }

    expect(verdict(rendered, '2026-08-28T12:00:00.001Z').state).toBe('updated');
  });

  it('does not claim LIVE for a matching snapshot that says it is not live', () => {
    // Freshness and truthfulness are different questions. The static preview
    // ships a `sample` bundle whose generatedAt is by construction the render
    // instant, so an exact-match-only rule would still have it announce LIVE.
    const verdict = freshnessVerdict();
    const rendered = '2026-08-28T12:00:00.000Z';
    for (const mode of ['sample', 'reconstructed']) {
      const result = verdict(rendered, rendered, mode);
      expect(result.state, mode).toBe('not-live');
      expect(result.label, mode).toContain(mode.toUpperCase());
      expect(result.label, mode).not.toBe('LIVE');
      expect(result.hint, mode).toContain('not live');
    }
    // A snapshot that states `live` is the ONLY path to the live label.
    expect(verdict(rendered, rendered, 'live').state).toBe('live');
    // Absent provenance fails closed (Codex round-3 follow-up). `mode` is
    // mandatory on HqSnapshot, so a snapshot missing it is malformed or from
    // another producer — and it used to be rewarded with the strongest label.
    for (const missing of [undefined, null, '']) {
      const result = verdict(rendered, rendered, missing);
      expect(result.state, String(missing)).toBe('not-live');
      expect(result.label, String(missing)).toContain('UNKNOWN PROVENANCE');
    }
  });

  it('reads the snapshot mode from the page, not only from the rule', () => {
    // The wiring must pass the mode through, or the guard above is inert.
    expect(bare.get('index.html')!).toContain('snapshot && snapshot.mode');
  });

  it('does not accept an equal instant written differently as an exact match', () => {
    // Same moment, different text: not the snapshot this page was built from,
    // so currency is unconfirmed rather than assumed.
    const result = freshnessVerdict()('2026-08-28T12:00:00.000Z', '2026-08-28T12:00:00Z');
    expect(result.state).toBe('stale');
    expect(result.hint).toContain('does not match this render');
  });

  it('reports an unreadable snapshot as an error rather than as freshness', () => {
    const verdict = freshnessVerdict();
    const rendered = '2026-08-28T12:00:00.000Z';
    for (const broken of [undefined, null, '', 42, {}, 'not-a-timestamp']) {
      expect(verdict(rendered, broken).state, `${String(broken)} must not read as live`).toBe(
        'error',
      );
    }
  });

  it('still states the build-time instant, which is true with or without scripting', () => {
    for (const page of HQ_PAGES) {
      expect(bare.get(page.file)!).toContain('As of 2026-08-26T10:30:00Z');
    }
  });
});

describe('renders stay reproducible', () => {
  it('produces identical HTML for identical inputs', () => {
    expect(buildSite({ ...sample, env: LOADED_ENV }).get('connections.html')).toBe(
      loaded.get('connections.html'),
    );
  });
});
