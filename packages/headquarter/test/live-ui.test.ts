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
import { SNAPSHOT_FILENAME, SNAPSHOT_POLL_INTERVAL_MS } from '../src/ui/live-refresh.js';
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

  it('does show the connected chip once evidence supports it', () => {
    const connected = buildSite({
      ...sample,
      env: { CLAUDE_ROUTINE_URL: 'x', CLAUDE_ROUTINE_TOKEN: 'y' },
    }).get('connections.html')!;
    expect(connected).toContain(stateChip('Connected', 'accent'));
  });

  it('states plainly that state comes from observed facts, not from the catalogue', () => {
    expect(html).toContain('derived from facts actually observed');
    expect(html).toContain('never that it is reachable');
  });

  it('reports Codex as Local-only once its local facts are observed', () => {
    const local = buildSite({
      ...sample,
      env: { CODEX_CLI_PATH: '/usr/local/bin/codex', CODEX_AUTH_MODE: 'chatgpt' },
    }).get('connections.html')!;
    expect(local).toContain('>Local-only<');
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
    expect(html).toContain('UPDATED — reload');
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
