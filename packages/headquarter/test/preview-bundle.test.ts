/**
 * Preview bundle contract (issue #196).
 *
 * The single-file Founder preview is only trustworthy if it is provably a
 * copy of the real render rather than a second, drifting implementation of
 * it — and only safe if it reaches for nothing outside itself. These tests
 * pin both properties, plus the escaping detail that would otherwise break
 * the archive page's own inline script.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { HQ_PAGES } from '../src/ui/render.js';
import {
  buildPreviewBundle,
  previewRoute,
  escapeForScriptBlock,
} from '../src/ui/preview-bundle.js';

const data = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'sample-data', 'hq-sample.json'), 'utf8'),
) as HeadquarterData;

const site = buildSite(data);
const bundle = buildPreviewBundle({ site, commit: 'abc1234', provenanceNote: data.note });

/** The JSON payload the shell parses back out of the document. */
function bundledPages(html: string): Record<string, string> {
  const match = html.match(
    /<script type="application\/json" id="pv-pages">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error('the preview bundle carries no page payload');
  return JSON.parse(match[1].replace(/\\u003c/g, '<')) as Record<string, string>;
}

describe('preview bundle', () => {
  it('carries all seven Headquarter pages', () => {
    const pages = bundledPages(bundle);
    expect(Object.keys(pages).sort()).toEqual(HQ_PAGES.map((page) => page.file).sort());
  });

  it('copies each page byte-for-byte from the real render', () => {
    const pages = bundledPages(bundle);
    for (const page of HQ_PAGES) {
      expect(pages[page.file]).toBe(site.get(page.file));
    }
  });

  it('refuses to bundle an incomplete render rather than shipping a gap', () => {
    const partial = new Map(site);
    partial.delete('archive.html');
    expect(() => buildPreviewBundle({ site: partial })).toThrow(/archive\.html/);
  });

  it('gives every page an addressable route', () => {
    expect(previewRoute('index.html')).toBe('command-center');
    expect(previewRoute('direct-chats.html')).toBe('direct-chats');
    const routes = HQ_PAGES.map((page) => previewRoute(page.file));
    expect(new Set(routes).size).toBe(HQ_PAGES.length);
    for (const route of routes) {
      expect(bundle).toContain(`"route":"${route}"`);
    }
  });

  it('neutralises the archive page\'s own </script> so the payload survives', () => {
    // The raw render really does contain a closing script tag — otherwise
    // this test would pass for the wrong reason.
    expect(site.get('archive.html')).toContain('</script>');
    const payload = bundle.slice(bundle.indexOf('id="pv-pages"'));
    const closingTag = payload.slice(0, payload.indexOf('</script>'));
    expect(closingTag).not.toContain('<');
    expect(escapeForScriptBlock('</script>')).toBe('\\u003c/script>');
  });

  it('offers a working page control at every width', () => {
    for (const page of HQ_PAGES) {
      expect(bundle).toContain(`data-pv-page="${page.file}"`);
      expect(bundle).toContain(`<option value="${page.file}">`);
    }
  });

  it('states what the preview is instead of implying a live system', () => {
    expect(bundle).toContain('not connected to a live backend');
    expect(bundle).toContain('abc1234');
    expect(bundle).toContain(data.note as string);
  });

  it('reaches for no external origin of its own', () => {
    // Page content is copied verbatim, so only the shell around the payload
    // is under test here: it must add no CDN, font, script or image host.
    const shell =
      bundle.slice(0, bundle.indexOf('<script type="application/json" id="pv-pages">')) +
      bundle.slice(bundle.lastIndexOf('</script>'));
    expect(shell).not.toMatch(/https?:\/\//);
    expect(shell).not.toMatch(/\bsrc\s*=\s*"[^"]+"/);
  });
});
