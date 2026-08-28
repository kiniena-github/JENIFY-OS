/**
 * Single-file preview bundle (issue #196).
 *
 * `buildSite()` emits seven separate HTML documents that link to each other
 * with relative `*.html` hrefs. That is exactly right for a static directory,
 * but a Founder preview has to travel as ONE self-contained file that can be
 * opened in a normal browser without a server, a checkout, or a deployment.
 *
 * This module folds the rendered site into that one file. The rules it keeps:
 *
 *   1. **The product pages are copied byte-for-byte.** Each page is handed to
 *      an `<iframe srcdoc>`, so it keeps its own document, its own <head>, its
 *      own stylesheet and its own script. Nothing is re-rendered, no IDs
 *      collide across pages, and the preview shell's CSS cannot leak in. What
 *      the Founder sees is the real render, not a re-creation of it.
 *   2. **Responsive behaviour stays real.** The frame is the viewport for the
 *      page inside it, so the page's own media queries fire off the frame's
 *      width. The width switcher narrows the frame to 390px, which exercises
 *      the same breakpoints a 390px phone does.
 *   3. **In-product navigation still works.** The left rail's own `*.html`
 *      links are intercepted and swapped for the corresponding bundled page,
 *      so the Founder navigates the way the product navigates. The shell's
 *      page buttons are the fallback path if the frame cannot be scripted.
 *   4. **Nothing is invented.** The shell adds no data, no controls that
 *      pretend to act, and no claim about freshness. It only states what the
 *      preview is: a static render of a named commit, sample data, not live.
 *
 * No network, no deployment, no secrets: the output references no external
 * origin and contains only what `dist/site/` already contains.
 */

import { HQ_PAGES } from './render.js';
import { escapeHtml } from './components.js';

export interface PreviewBundleOptions {
  /** Rendered site, exactly as returned by `buildSite()` (filename → HTML). */
  site: Map<string, string>;
  /** Commit the render came from, shown in the shell so it is never guessed. */
  commit?: string;
  /** Provenance note from the data bundle, restated in the preview chrome. */
  provenanceNote?: string;
}

/** `#hash` route for a page file, e.g. `index.html` → `command-center`. */
export function previewRoute(file: string): string {
  return file === 'index.html' ? 'command-center' : file.replace(/\.html$/, '');
}

/**
 * Escapes a string for embedding inside a `<script>` block. Only `<` needs
 * neutralising: the archive page's own inline script contains `</script>`,
 * which would otherwise close the block early. `<` is valid inside a
 * JSON string literal, so the payload still parses as JSON.
 */
export function escapeForScriptBlock(json: string): string {
  return json.replace(/</g, '\\u003c');
}

const SHELL_CSS = `
#hq-preview {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #05070c;
  color: #e9eef8;
  font-family: ui-sans-serif, system-ui, "Segoe UI", Inter, Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.4;
}
#hq-preview * { box-sizing: border-box; }
.pv-bar {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.9rem;
  padding: 0.55rem 0.9rem;
  background: #0d1320;
  border-bottom: 1px solid #2e3f5c;
}
.pv-mark {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  font-size: 0.72rem;
  text-transform: uppercase;
  color: #f7b955;
}
.pv-mark span {
  padding: 0.15rem 0.45rem;
  border: 1px solid #f7b955;
  border-radius: 6px;
}
.pv-note {
  flex: 1 1 16rem;
  min-width: 0;
  color: #9dabc4;
  font-size: 0.74rem;
}
.pv-note code { color: #35dfa8; font-size: 0.72rem; }
.pv-group { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.pv-group button {
  font: inherit;
  font-size: 0.74rem;
  padding: 0.3rem 0.6rem;
  border-radius: 7px;
  border: 1px solid #1d2941;
  background: #121a2b;
  color: #9dabc4;
  cursor: pointer;
}
.pv-group button:hover { border-color: #2e3f5c; color: #e9eef8; }
.pv-group button[aria-pressed="true"] {
  background: #0f7d5d;
  border-color: #35dfa8;
  color: #eafff6;
  font-weight: 600;
}
.pv-group button:focus-visible { outline: 2px solid #35dfa8; outline-offset: 2px; }
.pv-label {
  font-size: 0.66rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #6b7a93;
  align-self: center;
}
.pv-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  justify-content: center;
  background: #070a11;
  overflow: auto;
}
.pv-stage iframe {
  width: 100%;
  height: 100%;
  max-width: 100%;
  border: 0;
  background: #070a11;
  display: block;
}
.pv-stage[data-width="390"] iframe { width: 390px; }
.pv-stage[data-width="1024"] iframe { width: 1024px; }
.pv-stage[data-width="390"],
.pv-stage[data-width="1024"] { padding: 0.75rem 0; }
.pv-select {
  display: none;
  font: inherit;
  font-size: 0.78rem;
  padding: 0.35rem 0.5rem;
  border-radius: 7px;
  border: 1px solid #2e3f5c;
  background: #121a2b;
  color: #e9eef8;
  max-width: 100%;
}
.pv-select:focus-visible { outline: 2px solid #35dfa8; outline-offset: 2px; }

/*
 * Narrow screens already show the product's own left rail a few hundred
 * pixels below, and the width switcher has nothing left to simulate there.
 * The shell collapses to one compact control so it costs the page as little
 * height as possible while keeping a working fallback path.
 */
@media (max-width: 720px) {
  .pv-note { flex-basis: 100%; }
  .pv-pages { display: none; }
  .pv-select { display: block; }
  .pv-widths, .pv-label { display: none; }
}
`.trim();

const SHELL_SCRIPT = `
(function () {
  var pages = JSON.parse(document.getElementById('pv-pages').textContent);
  var routes = JSON.parse(document.getElementById('pv-routes').textContent);
  var fileByRoute = {};
  routes.forEach(function (entry) { fileByRoute[entry.route] = entry.file; });

  var frame = document.getElementById('pv-frame');
  var stage = document.getElementById('pv-stage');
  var pageButtons = Array.prototype.slice.call(document.querySelectorAll('[data-pv-page]'));
  var widthButtons = Array.prototype.slice.call(document.querySelectorAll('[data-pv-width]'));
  var pageSelect = document.getElementById('pv-select');
  var current = null;

  function show(file, pushHash) {
    if (!pages[file] || file === current) return;
    current = file;
    frame.srcdoc = pages[file];
    pageButtons.forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-pv-page') === file));
    });
    if (pageSelect) pageSelect.value = file;
    if (pushHash) {
      var route = routes.filter(function (entry) { return entry.file === file; })[0];
      if (route) location.hash = route.route;
    }
  }

  function fromHash() {
    var route = location.hash.replace(/^#/, '');
    return fileByRoute[route] || routes[0].file;
  }

  /**
   * The page inside the frame keeps its own left-rail navigation. Its links
   * point at sibling *.html files that do not exist in a single-file preview,
   * so they are intercepted and turned into a swap of the frame's content.
   * srcdoc frames are same-origin, but if a browser or embedder refuses the
   * reach-in, the shell's own page buttons remain the working path.
   */
  frame.addEventListener('load', function () {
    var doc;
    try { doc = frame.contentDocument; } catch (error) { doc = null; }
    if (!doc) return;
    doc.addEventListener('click', function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href') || '';
      if (!/^[a-z0-9-]+\\.html$/i.test(href)) return;
      event.preventDefault();
      show(href, true);
    });
  });

  pageButtons.forEach(function (button) {
    button.addEventListener('click', function () { show(button.getAttribute('data-pv-page'), true); });
  });
  if (pageSelect) {
    pageSelect.addEventListener('change', function () { show(pageSelect.value, true); });
  }
  widthButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var width = button.getAttribute('data-pv-width');
      stage.setAttribute('data-width', width);
      widthButtons.forEach(function (other) {
        other.setAttribute('aria-pressed', String(other === button));
      });
    });
  });
  window.addEventListener('hashchange', function () { show(fromHash(), false); });

  show(fromHash(), false);
})();
`.trim();

/**
 * Folds a rendered HQ site into one self-contained preview document body.
 *
 * The result is a document *fragment* (no <html>/<head>/<body> wrapper) so it
 * can be embedded by a host that supplies its own skeleton; browsers render it
 * directly as well.
 */
export function buildPreviewBundle(options: PreviewBundleOptions): string {
  const { site, commit, provenanceNote } = options;

  const pages = HQ_PAGES.filter((page) => site.has(page.file));
  const missing = HQ_PAGES.filter((page) => !site.has(page.file)).map((page) => page.file);
  if (missing.length > 0) {
    throw new Error(`preview bundle is missing rendered pages: ${missing.join(', ')}`);
  }

  const payload = Object.fromEntries(pages.map((page) => [page.file, site.get(page.file)!]));
  const routes = pages.map((page) => ({ file: page.file, route: previewRoute(page.file) }));

  const pageButtons = pages
    .map(
      (page) =>
        `<button type="button" data-pv-page="${page.file}" aria-pressed="false">` +
        `${page.glyph} ${page.title}</button>`,
    )
    .join('\n      ');

  const pageOptions = pages
    .map((page) => `<option value="${page.file}">${page.glyph} ${page.title}</option>`)
    .join('\n      ');

  const commitLine = commit ? ` Source commit <code>${escapeHtml(commit)}</code>.` : '';
  // The full provenance note is already stated at the top and foot of every
  // page. The shell restates it as a tooltip and keeps its own line short, so
  // the honesty label costs the page as little vertical room as possible.
  const noteLine = provenanceNote ? ' Sample data bundle — see the source note on each page.' : '';
  const noteTitle = provenanceNote ? ` title="${escapeHtml(provenanceNote)}"` : '';

  return `<title>Jenify Headquarter Preview</title>
<style>
${SHELL_CSS}
</style>
<div id="hq-preview">
  <header class="pv-bar">
    <p class="pv-mark"><span>Preview</span> Jenify Headquarter</p>
    <p class="pv-note"${noteTitle}>Static render — read-only, not connected to a live backend.${commitLine}${noteLine}</p>
    <nav class="pv-group pv-pages" aria-label="Headquarter pages">
      ${pageButtons}
    </nav>
    <select class="pv-select" id="pv-select" aria-label="Headquarter page">
      ${pageOptions}
    </select>
    <p class="pv-label" id="pv-width-label">Width</p>
    <div class="pv-group pv-widths" role="group" aria-labelledby="pv-width-label">
      <button type="button" data-pv-width="full" aria-pressed="true">Full</button>
      <button type="button" data-pv-width="1024" aria-pressed="false">1024px</button>
      <button type="button" data-pv-width="390" aria-pressed="false">390px</button>
    </div>
  </header>
  <div class="pv-stage" id="pv-stage" data-width="full">
    <iframe id="pv-frame" title="Jenify Headquarter page preview"></iframe>
  </div>
</div>
<script type="application/json" id="pv-pages">${escapeForScriptBlock(JSON.stringify(payload))}</script>
<script type="application/json" id="pv-routes">${escapeForScriptBlock(JSON.stringify(routes))}</script>
<script>
${SHELL_SCRIPT}
</script>
`;
}
