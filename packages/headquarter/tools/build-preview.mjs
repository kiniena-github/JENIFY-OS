/**
 * Headquarter single-file preview bundler (issue #196).
 *
 * The HQ site builder (`npm run build:site`) emits seven separate .html files
 * that link to each other by filename. That works over a file:// checkout and
 * over any static host, but a Founder preview link is one URL — so this tool
 * folds the same seven renders into ONE self-contained HTML document that can
 * be opened from a single link, with client-side routing standing in for the
 * cross-file <a href="projects.html"> navigation.
 *
 * It is deliberately a packaging step, NOT a UI change:
 *   - every page's markup is carried over verbatim except for the two
 *     rewrites navigation needs (see below);
 *   - the stylesheet is byte-identical across all seven renders, so it is
 *     emitted once and asserted identical rather than merged;
 *   - no page's content, layout, breakpoints or scripts are touched, so the
 *     responsive behaviour measured by tools/ui-evidence.mjs is preserved.
 *
 * The two rewrites, per page:
 *   1. href="<page>.html"  →  href="#/<slug>"  (cross-page nav becomes routing)
 *   2. id="hq-main" / href="#hq-main"  →  suffixed with the page slug, because
 *      hq-main is the one id that appears on every page and duplicating it in
 *      a single document would break the skip link. Every other id in the site
 *      is already unique across pages (asserted below), so page-local anchors
 *      and the archive search script keep working untouched.
 *
 * Local only. No network, no deployment: it reads a rendered site directory
 * and writes one file.
 *
 *   npm run build:site --workspace @factoryos/headquarter
 *   npm run build:preview --workspace @factoryos/headquarter
 *   node packages/headquarter/tools/build-preview.mjs [--site <dir>] [--out <file>]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Pages in navigation order, with the route slug each becomes. Kept in sync
 *  with buildSite()'s filenames and with tools/ui-evidence.mjs. */
export const PAGES = [
  ['index.html', 'command-center'],
  ['projects.html', 'projects'],
  ['executive-room.html', 'executive-room'],
  ['direct-chats.html', 'direct-chats'],
  ['specialists.html', 'specialists'],
  ['approvals.html', 'approvals'],
  ['archive.html', 'archive'],
];

function section(html, tag) {
  const open = html.indexOf(`<${tag}>`);
  const close = html.indexOf(`</${tag}>`);
  if (open === -1 || close === -1) throw new Error(`missing <${tag}> section`);
  return html.slice(open + tag.length + 2, close);
}

function titleOf(html) {
  const match = /<title>([^<]*)<\/title>/.exec(html);
  if (!match) throw new Error('missing <title>');
  return match[1];
}

/** Every id used by a page, so cross-page collisions can be caught up front. */
function idsOf(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

function rewrite(page) {
  let body = page.body;
  // 1. cross-page navigation → client-side routes
  for (const [file, slug] of PAGES) {
    body = body.split(`href="${file}"`).join(`href="#/${slug}"`);
  }
  // 2. the one shared id, and the skip link that targets it
  body = body.split('id="hq-main"').join(`id="hq-main--${page.slug}"`);
  body = body.split('href="#hq-main"').join(`href="#hq-main--${page.slug}"`);
  return body;
}

/** Fold a rendered site directory into one self-contained HTML document. */
export function bundlePreview(siteDir) {
  const pages = PAGES.map(([file, slug]) => {
    const html = readFileSync(join(siteDir, file), 'utf8');
    return {
      file,
      slug,
      html,
      title: titleOf(html),
      style: section(html, 'style'),
      body: section(html, 'body'),
    };
  });

  // The bundle emits one stylesheet. That is only sound while every page
  // renders the same one — assert it rather than assume it, so a future
  // per-page stylesheet fails the build instead of silently losing rules.
  const [{ style }] = pages;
  for (const page of pages) {
    if (page.style !== style) {
      throw new Error(`${page.file}: stylesheet differs from index.html — bundler needs updating`);
    }
  }

  // Same for ids: hq-main is the known shared one and is suffixed per page.
  // Anything else appearing twice would silently break an anchor or a script.
  const seen = new Map();
  for (const page of pages) {
    for (const id of idsOf(page.html)) {
      if (id === 'hq-main') continue;
      const owner = seen.get(id);
      if (owner) throw new Error(`id "${id}" appears in both ${owner} and ${page.file}`);
      seen.set(id, page.file);
    }
  }

  // A page's own <script> blocks are written into the bundle as-is and run at
  // parse time, exactly as they do in the standalone render. A stray
  // `</script>` inside one would end the block early — guard the invariant
  // rather than trust it.
  for (const page of pages) {
    const withoutScripts = page.body.replace(/<script\b[\s\S]*?<\/script\s*>/g, '');
    if (/<\/script\s*>/.test(withoutScripts)) {
      throw new Error(`${page.file}: unbalanced </script> — cannot be inlined safely`);
    }
  }

  const views = pages
    .map(
      (page) =>
        `<div class="hq-view" data-hq-view="${page.slug}" data-hq-title="${page.title}"${
          page.slug === PAGES[0][1] ? '' : ' hidden'
        }>\n${rewrite(page)}\n</div>`,
    )
    .join('\n');

  const router = `
(function () {
  var views = document.querySelectorAll('.hq-view');
  var routes = {};
  Array.prototype.forEach.call(views, function (view) {
    routes[view.getAttribute('data-hq-view')] = view;
  });
  var fallback = ${JSON.stringify(PAGES[0][1])};

  function show(slug) {
    var target = routes[slug] || routes[fallback];
    Array.prototype.forEach.call(views, function (view) {
      view.hidden = view !== target;
    });
    document.title = target.getAttribute('data-hq-title');
    window.scrollTo(0, 0);
  }

  // Only "#/<slug>" hashes are routes. Page-local anchors (#timeline-qos,
  // #hq-main--projects) keep their normal in-document jump behaviour.
  function route() {
    var hash = window.location.hash || '';
    if (hash.indexOf('#/') !== 0) return;
    show(hash.slice(2));
  }

  window.addEventListener('hashchange', route);
  route();
})();
`.trim();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>${pages[0].title}</title>
<style>${style}</style>
<style>
.hq-view[hidden] { display: none; }
</style>
</head>
<body>
${views}
<script>
${router}
</script>
</body>
</html>
`;
}

// CLI entry point — skipped when this module is imported (e.g. by the tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : resolve(argv[index + 1]);
  };
  const siteDir = flag('--site', join(packageRoot, 'dist', 'site'));
  const outFile = flag('--out', join(packageRoot, 'dist', 'preview', 'headquarter-preview.html'));

  const html = bundlePreview(siteDir);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html);
  console.log(
    `Bundled ${PAGES.length} Headquarter pages → ${outFile} (${(html.length / 1024).toFixed(0)} kB)`,
  );
}
