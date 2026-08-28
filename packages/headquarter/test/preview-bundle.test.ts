/**
 * Packaging invariants for the single-file preview bundle (issue #196).
 *
 * `tools/build-preview.mjs` folds the seven rendered HQ pages into one HTML
 * document so a Founder preview can live behind a single URL. It is a
 * packaging step, not a UI change — these tests encode exactly that:
 *
 *   - all seven pages survive, one view element each;
 *   - the only markup rewrites are the two navigation ones (cross-page
 *     hrefs → routes, and the one id shared by every page);
 *   - each page's own content, including the archive search data and script,
 *     comes through untouched;
 *   - the bundle refuses to build rather than silently lose rules or break an
 *     anchor if a future render diverges (per-page stylesheet, id collision).
 *
 * The browser-measured proof (7 routes × 320…1920 px, no horizontal overflow)
 * is produced separately, like `tools/ui-evidence.mjs`, and reported as PR
 * evidence.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tool, deliberately not part of the TS build.
import { PAGES, bundlePreview } from '../tools/build-preview.mjs';
import { HQ_PAGES } from '../src/ui/render.js';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import sample from '../sample-data/hq-sample.json' with { type: 'json' };

const slugs: string[] = (PAGES as [string, string][]).map(([, slug]) => slug);
const site = buildSite(sample as unknown as HeadquarterData);

/** Render the site into a scratch directory and bundle it, as the CLI does. */
function bundle(pages: Map<string, string> = site): string {
  const dir = mkdtempSync(join(tmpdir(), 'hq-preview-'));
  for (const [file, html] of pages) writeFileSync(join(dir, file), html);
  return bundlePreview(dir);
}

const html = bundle();

describe('preview bundle', () => {
  it('carries one view per Headquarter page', () => {
    expect(slugs).toHaveLength(HQ_PAGES.length);
    for (const slug of slugs) expect(html).toContain(`data-hq-view="${slug}"`);
    expect(html.match(/data-hq-view="/g)).toHaveLength(HQ_PAGES.length);
  });

  it('shows exactly one view before any routing happens', () => {
    const views = [...html.matchAll(/<div class="hq-view" data-hq-view="([^"]+)"[^>]*>/g)];
    const visible = views.filter((match) => !match[0].includes(' hidden'));
    expect(visible.map((match) => match[1])).toEqual([slugs[0]]);
  });

  it('turns cross-page navigation into routes and leaves nothing pointing at a file', () => {
    for (const slug of slugs) expect(html).toContain(`href="#/${slug}"`);
    expect(html).not.toMatch(/href="[a-z-]+\.html"/);
  });

  it('keeps page-local anchors working by making the one shared id unique', () => {
    expect(html).not.toContain('id="hq-main"');
    for (const slug of slugs) {
      expect(html).toContain(`id="hq-main--${slug}"`);
      expect(html).toContain(`href="#hq-main--${slug}"`);
    }
    // Anchors that were already unique per page are untouched.
    expect(html).toContain('id="timeline-qos"');
    expect(html).toContain('href="#timeline-qos"');
  });

  it("reproduces each page's own heading and title", () => {
    for (const page of HQ_PAGES) {
      const rendered = site.get(page.file)!;
      const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(rendered)?.[1];
      expect(heading, `${page.file} has an h1`).toBeTruthy();
      expect(html).toContain(heading!.trim());
      expect(html).toContain(`data-hq-title="JENIFY HQ — ${page.title}"`);
    }
  });

  it("keeps the archive page's search corpus and script", () => {
    expect(html).toContain('id="archive-search-data"');
    expect(html).toContain('id="archive-search"');
    expect(html).toContain('archiveRowMatches');
  });

  it('ships the stylesheet once, not seven times', () => {
    expect(html.match(/--rail: 15\.5rem;/g)).toHaveLength(1);
  });

  it('marks the bundle noindex, since a preview link is not a published page', () => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('carries the data-provenance note, so sample data stays labelled as sample', () => {
    expect(html).toContain('Sample bundle reconstructed from real GitHub-visible JENIFY-OS activity');
  });

  it('refuses to bundle if a page ever renders its own stylesheet', () => {
    const divergent = new Map(site);
    divergent.set('projects.html', site.get('projects.html')!.replace('<style>', '<style>/* local */'));
    expect(() => bundle(divergent)).toThrow(/stylesheet differs/);
  });

  it('refuses to bundle if two pages start sharing an id', () => {
    const colliding = new Map(site);
    colliding.set('projects.html', site.get('projects.html')!.replace('id="timeline-qos"', 'id="archive-search"'));
    expect(() => bundle(colliding)).toThrow(/id "archive-search" appears in both/);
  });
});
