import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/ui/components.js';
import { HQ_PAGES, renderSourceRef } from '../src/ui/render.js';
import { buildSite, bundleAsOf, type HeadquarterData } from '../src/ui/site.js';
import { BrowserSafetyError } from '../src/live/redaction.js';
import type { ConnectionStatus } from '../src/live/connections.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

describe('escapeHtml', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml(`<script>alert("x&'y")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&amp;&#39;y&quot;)&lt;/script&gt;',
    );
  });
});

describe('buildSite', () => {
  const site = buildSite(sample);

  it('renders the full HQ information architecture', () => {
    expect([...site.keys()].sort()).toEqual(HQ_PAGES.map((page) => page.file).sort());
    for (const page of HQ_PAGES) {
      const html = site.get(page.file)!;
      expect(html).toContain('<!doctype html>');
      expect(html).toContain(`JENIFY HQ — ${page.title}`);
      // every page carries the shared navigation
      for (const other of HQ_PAGES) expect(html).toContain(`href="${other.file}"`);
    }
  });

  it('Command Center shows the five Founder lanes, the attention queue and the workforce', () => {
    const html = site.get('index.html')!;
    for (const lane of ['NOW', 'DONE TODAY', 'BLOCKED', 'WAITING FOR FOUNDER', 'NEXT']) {
      expect(html).toContain(`<h2>${lane}</h2>`);
    }
    expect(html).toContain('<h2>WHAT NEEDS THE FOUNDER</h2>');
    expect(html).toContain('<h2>ACTIVE AI WORKFORCE</h2>');
    expect(html).toContain('<h2>LIVE ACTIVITY</h2>');
    expect(html).toContain('Stream 2 — Headquarter UI');
    expect(html).toContain('Fix Gemini 3.7 worker model routing'); // DONE TODAY from sample
  });

  it('Founder Approvals renders the D15 fields read-only with no static action controls', () => {
    const html = site.get('approvals.html')!;
    expect(html).toContain('Universal Operator architecture proposal'); // waiting task
    expect(html).toContain('control API');
    // D15 approval fields (§6b): actionDigest, expiresAt, consumedAt, decidedBy
    expect(html).toContain('Action digest');
    expect(html).toContain('3f9a1c2b4d5e6f70'); // truncated digest rendered
    expect(html).toContain('2026-08-27T05:12:23Z'); // expiresAt
    expect(html).toContain('2026-08-26T09:35:00Z'); // consumedAt
    expect(html).toContain('founder'); // decidedBy
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });

  it('draws the build-time decision controls as inert, explicitly-labelled placeholders', () => {
    const html = site.get('approvals.html')!;
    for (const control of ['Approve', 'Reject', 'Ask for changes']) {
      expect(html).toContain(`<span class="control-readonly" aria-disabled="true">${control}</span>`);
    }
    expect(html).toContain('inert build-time card');
    // The site-wide invariant, RE-SCOPED with the live control plane (issue
    // #200, integration lane) but still load-bearing: the STATIC markup of
    // every page carries no form, no button and no inline handler — a working
    // control may exist only as a DOM node the control-console scripts create
    // AFTER `/session` granted it, and no mutation may go anywhere but the
    // control API (that half is asserted, script by script, in
    // `control-console.test.ts`).
    for (const page of HQ_PAGES) {
      const pageHtml = site.get(page.file)!;
      expect(pageHtml).not.toContain('<form');
      expect(pageHtml).not.toContain('<button');
      expect(pageHtml).not.toMatch(/\son(click|submit|load|error|mouseover)=/);
    }
  });

  it('marks high-risk approvals visually distinct from ordinary ones', () => {
    const html = site.get('approvals.html')!;
    // ap-1 is founder_gate (high risk), ap-2 is repo_write (not on the list).
    expect(html).toMatch(/<article class="card risk-high" data-approval="ap-1"/);
    expect(html).toMatch(/<article class="card" data-approval="ap-2"/);
  });

  it('renders the bundle provenance note on every page so samples cannot pass as authoritative', () => {
    for (const page of HQ_PAGES) {
      const html = site.get(page.file)!;
      // Footer provenance, plus a banner at the top of the page.
      expect(html).toContain('data-provenance');
      expect(html).toContain('data-provenance-banner');
      expect(html).toContain('reconstructed from real GitHub-visible JENIFY-OS activity');
    }
    // A bundle without a note renders no empty provenance footer or banner.
    const bare = buildSite({ ...sample, note: undefined });
    expect(bare.get('index.html')).not.toContain('<footer class="muted" data-provenance>');
    expect(bare.get('index.html')).not.toContain('data-provenance-banner');
  });

  it('states on every page the instant the view is current as of', () => {
    // Newest timestamp in the sample bundle, not wall-clock time.
    expect(bundleAsOf(sample)).toBe('2026-08-26T10:30:00Z');
    for (const page of HQ_PAGES) {
      expect(site.get(page.file)!).toContain('As of 2026-08-26T10:30:00Z');
    }
    // Renders are reproducible: the same bundle always produces the same HTML.
    expect(buildSite(sample).get('index.html')).toBe(site.get('index.html'));
  });

  it('Archive page always carries the not-original-evidence banner', () => {
    const html = site.get('archive.html')!;
    expect(html).toContain('data-archive-banner');
    expect(html).toContain('not original evidence');
    const bare = buildSite({ ...sample, note: undefined });
    expect(bare.get('archive.html')).toContain('data-archive-banner');
  });

  it('Archive page shows monthly groups, evolution, source links, and confidence flags', () => {
    const html = site.get('archive.html')!;
    expect(html).toContain('<h2>2026-08</h2>');
    expect(html).toContain('Evolution — QOS');
    expect(html).toContain('https://github.com/kiniena-github/JENIFY-OS/pull/36');
    expect(html).toContain('archive-search');
    // Structured filters exist alongside free text (issue #138, page 8).
    for (const filter of ['archive-filter-project', 'archive-filter-category', 'archive-filter-status', 'archive-filter-year']) {
      expect(html).toContain(`id="${filter}"`);
    }
    // Evolution entries are addressable by the same record ids the search uses,
    // which is what keeps the two views consistent.
    expect(html).toContain('data-evolution-entry="doc-qos-upgrade-strategy"');
  });

  it('makes sourceRef clickable only for allowed schemes', () => {
    // Normal https evidence link stays clickable.
    expect(renderSourceRef('https://github.com/kiniena-github/JENIFY-OS/pull/36')).toBe(
      '<a href="https://github.com/kiniena-github/JENIFY-OS/pull/36">original</a>',
    );
    // Hostile or non-web locators render as escaped text, never as links.
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)', // leading whitespace is stripped by URL parsers
      '\tjavascript:alert(1)',
      '\njavascript:alert(1)',
      'java\tscript:alert(1)', // tabs/newlines inside the scheme are stripped by URL parsers
      'java\nscript:alert(1)',
      'javascript&#58;alert(1)', // HTML-entity-encoded colon
      '%6A%61vascript:alert(1)', // percent-encoded scheme
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'drive://q0',
      'docs/reports/2026-07.md',
      'http://insecure.example',
    ]) {
      const rendered = renderSourceRef(hostile);
      expect(rendered).not.toContain('<a ');
      expect(rendered).not.toContain('href');
    }
    // End-to-end: a hostile sourceRef in a record never becomes a link on the page.
    const hostileData: HeadquarterData = {
      ...sample,
      archive: [
        {
          ...sample.archive[0],
          id: 'doc-hostile',
          sourceRef: 'javascript:alert(1)',
        },
      ],
    };
    const html = buildSite(hostileData).get('archive.html')!;
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('javascript:alert(1)</code>');
  });

  it('never emits an untrusted ref as a link outside the allowed scheme', () => {
    const hostileData: HeadquarterData = {
      ...sample,
      events: [
        {
          id: 'x1',
          seq: 1,
          at: '2026-08-26T10:00:00Z',
          subjectKind: 'task',
          subjectId: 'x',
          status: 'blocked',
          actor: 'claude',
          summary: 'hostile refs',
          detail: { project: 'P', title: 'hostile refs' },
          refs: ['javascript:alert(1)', 'drive://secret', 'https://github.com/ok'],
        },
      ],
    };
    const html = buildSite(hostileData).get('index.html')!;
    expect(html).toContain('href="https://github.com/ok"');
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).not.toContain('drive://secret');
  });

  it('escapes untrusted content in rendered pages', () => {
    const hostile: HeadquarterData = {
      ...sample,
      events: [
        {
          id: 'x1',
          seq: 1,
          at: '2026-08-26T10:00:00Z',
          subjectKind: 'task',
          subjectId: 'x',
          status: 'running',
          actor: 'claude',
          summary: '<script>alert(1)</script>',
          detail: { project: '<b>P</b>', title: '<script>alert(1)</script>' },
        },
      ],
    };
    const html = buildSite(hostile).get('index.html')!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes untrusted archive content inside the embedded search index', () => {
    const hostile: HeadquarterData = {
      ...sample,
      archive: [{ ...sample.archive[0], title: '</script><script>alert(1)</script>' }],
    };
    const html = buildSite(hostile).get('archive.html')!;
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('<\\/script>');
  });

  it('splits canonical chat messages into executive room and direct chats by threadId', () => {
    const executive = site.get('executive-room.html')!;
    expect(executive).toContain('Stream 2 war room open');
    expect(executive).not.toContain('dm:claude');
    const direct = site.get('direct-chats.html')!;
    expect(direct).toContain('dm:claude');
    expect(direct).toContain('isolated from operator/control-plane files');
    expect(site.get('specialists.html')).toContain('Codex');
  });

  it('gives every AI participant an identity, model/vendor and role', () => {
    const executive = site.get('executive-room.html')!;
    expect(executive).toContain('OpenAI · Mission director'); // ChatGPT
    expect(executive).toContain('Human · final authority'); // Founder
    const specialists = site.get('specialists.html')!;
    expect(specialists).toContain('Anthropic · Build lead'); // Claude
    expect(specialists).toContain('Google · Parallel implementer'); // Jules
  });

  it('shows worker workload on the specialist directory from canonical events only', () => {
    const html = site.get('specialists.html')!;
    // Claude has a running task in the sample bundle.
    expect(html).toContain('Current assignment:');
    expect(html).toContain('On assignment');
    // google-tools has no recorded activity — say so, do not invent a workload.
    expect(html).toContain('No recorded activity for this specialist yet.');
    // Cost/token usage is not in the contracts and must not appear.
    expect(html.toLowerCase()).not.toContain('tokens used');
    expect(html).not.toContain('$');
  });

  it('project board reports health, blockers and next queued work per project', () => {
    const html = site.get('projects.html')!;
    expect(html).toContain('data-project-card="JENIFY-OS"');
    expect(html).toContain('Needs Founder'); // JENIFY-OS has needs_approval, nothing blocked
    expect(html).toContain('Blocked'); // Jenify Labs is blocked
    expect(html).toContain('Latest achievement:');
    expect(html).toContain('Recent update:');
  });
});

/**
 * Codex exact-head finding on `5c767fa` (P1). A caller-supplied `connections`
 * bundle went straight to the renderer with nothing having scanned it, and the
 * snapshot guard could not cover for that: `build-site.ts` recomputes the
 * snapshot's connections from `env`, independently of the bundle, and the HTML
 * is written first. A credential that reached a verifier's `reason`,
 * `evidenceSource` or fact list therefore landed in `connections.html` with no
 * boundary in the path having looked at it.
 *
 * The guard now runs on the connections that are actually RENDERED, on both
 * branches, so the invariant does not depend on which one a caller took.
 */
describe('rendered connections cross the browser boundary through the guard', () => {
  const poisoned = (overrides: Partial<ConnectionStatus>): HeadquarterData => ({
    ...sample,
    connections: [
      {
        id: 'supabase',
        displayName: 'Supabase',
        category: 'infrastructure',
        authMechanism: 'api_key',
        locality: 'cloud',
        advertisedCapabilities: [],
        requiredFacts: [],
        setupHint: 'n/a',
        recheckable: false,
        revocable: false,
        state: 'configured',
        verification: 'configuration',
        outcome: 'not_attempted',
        observedFacts: [],
        missingFacts: [],
        effectiveCapabilities: [],
        lastVerifiedAt: null,
        evidenceSource: 'test',
        reason: 'test',
        canRecheck: false,
        canDisconnect: false,
        ...overrides,
      } as ConnectionStatus,
    ],
  });

  it('throws rather than rendering a credential a verifier put in its reason', () => {
    expect(() =>
      buildSite(poisoned({ reason: 'Supabase: verified — using sk-abcdefghijklmnopqrstuvwxyz012345' })),
    ).toThrow(BrowserSafetyError);
  });

  it('throws rather than rendering one carried in evidenceSource or a fact list', () => {
    expect(() =>
      buildSite(poisoned({ evidenceSource: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })),
    ).toThrow(BrowserSafetyError);
    expect(() =>
      buildSite(poisoned({ observedFacts: ['sk-abcdefghijklmnopqrstuvwxyz012345'] })),
    ).toThrow(BrowserSafetyError);
  });

  it('never writes the page when it refuses', () => {
    // The throw has to come BEFORE any HTML exists, not after: the real build
    // writes each page to disk as it goes.
    let site: Map<string, string> | undefined;
    try {
      site = buildSite(poisoned({ reason: 'sk-abcdefghijklmnopqrstuvwxyz012345' }));
    } catch {
      site = undefined;
    }
    expect(site).toBeUndefined();
  });

  it('lets an honest bundle through untouched', () => {
    const html = buildSite(poisoned({})).get('connections.html')!;
    expect(html).toContain('Supabase');
  });
});
