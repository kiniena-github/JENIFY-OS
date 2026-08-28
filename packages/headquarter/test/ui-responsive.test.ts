/**
 * Responsive + accessibility invariants for the Headquarter UI (issue #138,
 * page 9 and the accessibility constraints).
 *
 * These are the STRUCTURAL guarantees — the ones that can be checked without
 * a browser and that therefore run in CI on every change. The measured
 * browser proof (documentElement.scrollWidth <= innerWidth at 320/360/390/414
 * px, plus screenshots) is produced by `tools/ui-evidence.mjs`, which needs a
 * real browser and is run manually as PR evidence.
 *
 * The rule these encode: the page is never allowed to be wider than the
 * viewport, and it is never allowed to *hide* that fact with
 * `overflow-x: hidden`. Wide content scrolls inside its own container.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HQ_PAGES } from '../src/ui/render.js';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { THEME_CSS } from '../src/ui/theme.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;
const site = buildSite(sample);
const pages = HQ_PAGES.map((page) => [page.title, site.get(page.file)!] as const);

/** The stylesheet is identical on every page, so parse it once. */
function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'));
}

describe('viewport and layout containment', () => {
  it.each(pages)('%s declares a responsive viewport', (_title, html) => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it('never masks horizontal overflow with overflow-x: hidden', () => {
    // Hiding the overflow would make the 390px defect invisible instead of
    // fixed. Containment is done with min-width:0 + scrollable containers.
    expect(THEME_CSS).not.toMatch(/overflow-x:\s*hidden/);
    expect(THEME_CSS).not.toMatch(/overflow:\s*hidden[^;]*;\s*}\s*$/m);
    expect(THEME_CSS).toContain('html, body { max-width: 100%; }');
  });

  it('sizes every multi-column grid so a single column can shrink to the viewport', () => {
    const tracks = [...THEME_CSS.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((match) => match[1]);
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      if (!track.includes('minmax')) continue;
      // Every minmax lower bound is either 0 or clamped by min(..., 100%).
      for (const [, lower] of track.matchAll(/minmax\(([^,]+),/g)) {
        const bound = lower.trim();
        expect(
          bound === '0' || bound.startsWith('min(') || bound.startsWith('minmax('),
          `grid track lower bound "${bound}" can exceed a narrow viewport`,
        ).toBe(true);
      }
    }
  });

  it('gives flex and grid children an explicit min-width so long words cannot widen them', () => {
    expect(THEME_CSS).toContain('.grid { display: grid; gap: 0.8rem; min-width: 0; }');
    expect(THEME_CSS).toContain('.card {');
    expect(THEME_CSS.match(/min-width:\s*0/g)?.length ?? 0).toBeGreaterThan(10);
  });

  it('declares no fixed pixel width wider than the narrowest supported viewport', () => {
    // 320px is the narrowest width tools/ui-evidence.mjs asserts against.
    for (const [, value] of THEME_CSS.matchAll(/\b(?:width|min-width):\s*(\d+)px/g)) {
      expect(Number(value)).toBeLessThanOrEqual(320);
    }
  });

  it('is mobile-first: every media query is a min-width query', () => {
    const queries = [...THEME_CSS.matchAll(/@media\s*\(([^)]+)\)/g)].map((match) => match[1]);
    for (const query of queries) {
      expect(query.includes('min-width') || query.includes('prefers-reduced-motion')).toBe(true);
    }
  });

  it.each(pages)('%s wraps every table in a scrollable container', (_title, html) => {
    const body = bodyOf(html);
    const tables = [...body.matchAll(/<table[\s>]/g)];
    const wraps = [...body.matchAll(/<div class="table-wrap"/g)];
    expect(wraps.length).toBe(tables.length);
    // and each wrap immediately precedes its table
    for (const wrap of wraps) {
      const after = body.slice(wrap.index!, wrap.index! + 400);
      expect(after).toContain('<table');
    }
  });

  it.each(pages)('%s uses no fixed pixel sizing in inline styles', (_title, html) => {
    for (const [, style] of bodyOf(html).matchAll(/style="([^"]*)"/g)) {
      expect(style).not.toMatch(/\d+px/);
    }
  });

  it.each(pages)('%s lets long unbroken strings wrap instead of stretching the page', (_title, html) => {
    // Every element that can hold an unbounded token (ids, URLs, titles) is
    // covered by an overflow-wrap rule in the shared stylesheet.
    for (const selector of ['.card p', '.msg .body', 'code', '.feed .what', '.identity .who b']) {
      expect(THEME_CSS).toContain(selector);
    }
    expect(THEME_CSS.match(/overflow-wrap:\s*anywhere/g)?.length ?? 0).toBeGreaterThan(5);
    expect(html).toContain('</html>');
  });
});

describe('accessibility and keyboard usability', () => {
  it.each(pages)('%s starts with a skip link that targets the main region', (_title, html) => {
    expect(html).toContain('<a class="skip-link" href="#hq-main">');
    expect(html).toContain('<main id="hq-main">');
  });

  it.each(pages)('%s has exactly one h1 and a labelled navigation landmark', (_title, html) => {
    expect(bodyOf(html).match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('<nav aria-label="Headquarter sections">');
  });

  it.each(pages)('%s marks exactly one nav item as the current page', (_title, html) => {
    expect(bodyOf(html).match(/aria-current="page"/g)).toHaveLength(1);
  });

  it.each(pages)('%s keeps focus visible and never removes the outline', (_title, html) => {
    expect(html).toContain(':focus-visible');
    expect(THEME_CSS).not.toMatch(/outline:\s*(none|0)/);
  });

  it.each(pages)('%s gives every scrollable region a keyboard-reachable label', (_title, html) => {
    for (const [, attrs] of bodyOf(html).matchAll(/<div class="table-wrap"([^>]*)>/g)) {
      expect(attrs).toContain('tabindex="0"');
      expect(attrs).toContain('aria-label=');
    }
  });

  it('disables all motion under prefers-reduced-motion', () => {
    expect(THEME_CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(THEME_CSS).toMatch(/transition:\s*none\s*!important/);
  });

  it.each(pages)('%s never conveys status by colour alone', (_title, html) => {
    // Every status chip carries a text label next to its colour dot.
    const withoutDots = bodyOf(html).replaceAll('<span class="dot" aria-hidden="true"></span>', '');
    const chips = [...withoutDots.matchAll(/<span class="chip[^"]*">(.*?)<\/span>/g)];
    expect(chips.length).toBeGreaterThan(0);
    for (const [, inner] of chips) {
      expect(inner.replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(0);
    }
  });

  it('describes progress meters in words as well as in a bar', () => {
    const projects = site.get('projects.html')!;
    expect(projects).toMatch(/role="img" aria-label="[^"]*: \d+%"/);
    expect(projects).toMatch(/\d+% of recorded tasks completed/);
  });

  it('announces the archive result count politely', () => {
    expect(site.get('archive.html')!).toContain('role="status" aria-live="polite"');
  });

  it('labels every archive filter control', () => {
    const html = site.get('archive.html')!;
    for (const id of ['archive-search', 'archive-filter-project', 'archive-filter-category', 'archive-filter-status', 'archive-filter-year']) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
  });
});
