/**
 * Headquarter UI evidence tool (issue #138).
 *
 * Renders the static HQ site, opens every page in a real browser at desktop
 * and mobile widths, and produces two things:
 *
 *   1. A deterministic no-horizontal-overflow assertion per page per width:
 *      document.documentElement.scrollWidth <= window.innerWidth
 *      AND document.body.scrollWidth <= window.innerWidth.
 *      Any failure exits non-zero and names the page, the width, and the
 *      widest offending element.
 *   2. Full-page screenshots for PR/issue evidence.
 *
 * Playwright is deliberately NOT a dependency of this package: the HQ site is
 * framework-free and its CI checks are the structural ones in
 * `test/ui-responsive.test.ts`. This tool is run by hand when visual evidence
 * is required.
 *
 *   npm run build:site --workspace @factoryos/headquarter
 *   node packages/headquarter/tools/ui-evidence.mjs [--site <dir>] [--out <dir>]
 *
 * If `playwright` is not resolvable, point PLAYWRIGHT_PATH at an install of it,
 * and CHROMIUM_PATH at a browser binary if the bundled one is not present:
 *   npm i --no-save --prefix /tmp/pw playwright
 *   PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright/index.js \
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node packages/headquarter/tools/ui-evidence.mjs
 *
 * Local only. No network, no deployment: it opens file:// URLs.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : resolve(argv[index + 1]);
};
/** `--site` lets the same measurement run against another checkout's render. */
const siteDir = flag('--site', join(packageRoot, 'dist', 'site'));
const outDir = flag('--out', join(packageRoot, 'dist', 'ui-evidence'));

/** Pages in navigation order. Kept in sync with HQ_PAGES by name. */
const PAGES = [
  ['index.html', 'command-center'],
  ['projects.html', 'projects'],
  ['executive-room.html', 'executive-room'],
  ['direct-chats.html', 'direct-chats'],
  ['specialists.html', 'specialists'],
  ['approvals.html', 'approvals'],
  ['connections.html', 'connections'],
  ['archive.html', 'archive'],
];

/**
 * Widths under test. 390 is the width of the confirmed defect in issue #138;
 * 320 and 360 are narrower, 414 is the common large-phone width, and the two
 * desktop widths guard the multi-column layouts.
 */
const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 1000, shoot: true },
  { name: 'desktop-1024', width: 1024, height: 900, shoot: false },
  { name: 'mobile-414', width: 414, height: 900, shoot: false },
  { name: 'mobile-390', width: 390, height: 844, shoot: true },
  { name: 'mobile-360', width: 360, height: 800, shoot: true },
  { name: 'mobile-320', width: 320, height: 700, shoot: false },
];

async function loadPlaywright() {
  // ESM ignores NODE_PATH, so an out-of-repo install is pointed at directly.
  const override = process.env.PLAYWRIGHT_PATH;
  try {
    const module = await import(override ? pathToFileURL(resolve(override)).href : 'playwright');
    return module.chromium ? module : module.default;
  } catch (error) {
    console.error(
      'playwright is not resolvable. Install it outside the repo and retry:\n' +
        '  npm i --no-save --prefix /tmp/pw playwright\n' +
        '  PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright node packages/headquarter/tools/ui-evidence.mjs\n' +
        `(resolution error: ${error.message})`,
    );
    process.exit(2);
  }
}

/** Runs in the browser: measure overflow and name the widest offender. */
function measure() {
  const viewport = window.innerWidth;
  const docWidth = document.documentElement.scrollWidth;
  const bodyWidth = document.body.scrollWidth;
  let worst = null;
  if (docWidth > viewport || bodyWidth > viewport) {
    for (const element of document.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      const right = rect.left + rect.width;
      if (right <= viewport + 0.5) continue;
      if (!worst || right > worst.right) {
        worst = {
          right: Math.round(right),
          tag: element.tagName.toLowerCase(),
          cls: (element.getAttribute('class') || '').slice(0, 60),
        };
      }
    }
  }
  return { viewport, docWidth, bodyWidth, worst };
}

const main = async () => {
  if (!existsSync(siteDir)) {
    console.error(`No rendered site at ${siteDir}. Run: npm run build:site --workspace @factoryos/headquarter`);
    process.exit(2);
  }
  const { chromium } = await loadPlaywright();
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const failures = [];
  const rows = [];

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    for (const [file, slug] of PAGES) {
      await page.goto(pathToFileURL(join(siteDir, file)).href, { waitUntil: 'load' });
      const result = await page.evaluate(measure);
      const overflow = Math.max(result.docWidth, result.bodyWidth) - result.viewport;
      const ok = overflow <= 0;
      rows.push({ viewport: viewport.name, page: slug, ...result, overflow, ok });
      if (!ok) failures.push({ viewport: viewport.name, page: slug, ...result });
      if (viewport.shoot) {
        await page.screenshot({
          path: join(outDir, `${slug}--${viewport.name}.jpeg`),
          fullPage: true,
          type: 'jpeg',
          quality: 72,
        });
      }
    }
    await context.close();
  }
  const width = (value, size) => String(value).padEnd(size);
  console.log(`${width('viewport', 14)}${width('page', 16)}${width('innerWidth', 12)}${width('scrollWidth', 13)}result`);
  for (const row of rows) {
    console.log(
      `${width(row.viewport, 14)}${width(row.page, 16)}${width(row.viewport, 12)}${width(
        Math.max(row.docWidth, row.bodyWidth),
        13,
      )}${row.ok ? 'OK' : `OVERFLOW +${row.overflow}px (${row.worst?.tag}.${row.worst?.cls})`}`,
    );
  }

  // Functional check for the archive search/Evolution consistency fix: the
  // ranked result list and the Evolution chains must agree on one match set.
  const archiveContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const archivePage = await archiveContext.newPage();
  await archivePage.goto(pathToFileURL(join(siteDir, 'archive.html')).href, { waitUntil: 'load' });
  const searchChecks = [];
  const readState = async () =>
    archivePage.evaluate(() => ({
      browseHidden: document.getElementById('archive-browse').hidden,
      resultsHidden: document.getElementById('archive-results').hidden,
      visibleResults: [...document.querySelectorAll('#archive-results [data-archive-id]')]
        .filter((element) => !element.hidden)
        .map((element) => element.getAttribute('data-archive-id')),
      dimmedEvolution: [...document.querySelectorAll('[data-evolution-entry]')]
        .filter((element) => element.classList.contains('is-dimmed'))
        .map((element) => element.getAttribute('data-evolution-entry')),
      count: document.getElementById('archive-count').textContent.trim(),
    }));

  const idle = await readState();
  searchChecks.push(['idle shows the chronological browser', idle.browseHidden === false && idle.resultsHidden === true]);
  searchChecks.push(['idle dims no evolution entry', idle.dimmedEvolution.length === 0]);

  await archivePage.fill('#archive-search', 'qos upgrade');
  const searched = await readState();
  searchChecks.push(['a query swaps in the ranked result list', searched.browseHidden === true && searched.resultsHidden === false]);
  searchChecks.push(['results are narrowed', searched.visibleResults.length > 0 && searched.visibleResults.length < idle.visibleResults.length + 1]);
  searchChecks.push([
    'evolution agrees with the result set',
    searched.dimmedEvolution.every((id) => !searched.visibleResults.includes(id)) &&
      searched.visibleResults.every((id) => !searched.dimmedEvolution.includes(id)),
  ]);
  searchChecks.push(['the count is announced', /records? match/.test(searched.count)]);

  await archivePage.fill('#archive-search', '');
  const cleared = await readState();
  searchChecks.push(['clearing restores the browser', cleared.browseHidden === false && cleared.resultsHidden === true]);
  searchChecks.push(['clearing un-dims evolution', cleared.dimmedEvolution.length === 0]);
  await archiveContext.close();

  console.log('\narchive search / evolution consistency');
  for (const [label, ok] of searchChecks) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
    if (!ok) failures.push({ page: 'archive', viewport: 'interaction', check: label });
  }

  await browser.close();

  console.log(`\nScreenshots → ${outDir}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} page/width combination(s) overflow horizontally.`);
    process.exit(1);
  }
  console.log(`\nNo horizontal overflow at any of: ${VIEWPORTS.map((v) => v.width).join(', ')} px.`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
