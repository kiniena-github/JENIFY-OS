/**
 * Immersive HQ WebGL evidence tool (issue #250, Phase 2 Stage 4).
 *
 * ## What this answers that the test suite cannot
 *
 * `test/client-immersive-page.test.ts` loads the real emitted page into jsdom,
 * which has NO WebGL — so it proves the no-WebGL fallback end to end and leaves
 * the rendered path covered only structurally. This tool closes that gap: it
 * opens `immersive.html` in a REAL browser with a REAL graphics stack, answers
 * the page's own control-API calls, and reports what actually happened:
 *
 *   - which context the page obtained (`webgl2` or `webgl`);
 *   - whether both shaders COMPILED and the program LINKED — with the driver's
 *     own info log if not;
 *   - whether the shell reached its running state (`data-hq-3d="on"`) rather
 *     than its honest fallback;
 *   - whether the rooms hydrated from the authenticated route;
 *   - a screenshot for visual evidence.
 *
 * It exists because a Codex review of `7e87392` raised a specific, plausible
 * and testable claim: that preferring a WebGL 2 context while shipping GLSL ES
 * 1.00 shaders (`attribute` / `varying` / `gl_FragColor`, no `#version 300
 * es`) would make WebGL 2 reject them, so the 3D HQ would never run on the
 * ordinary modern-browser path. That is exactly the kind of claim that should
 * be settled by running it rather than by quoting a specification at it.
 *
 * ## The same posture as `ui-evidence.mjs`
 *
 * Playwright is deliberately NOT a dependency of this package. This is a
 * by-hand tool; the CI checks stay the structural ones in `test/`.
 *
 *   npm run build:site --workspace @factoryos/headquarter
 *   npm i --no-save --prefix /tmp/pw playwright-core
 *   PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright-core/index.js \
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node packages/headquarter/tools/webgl-evidence.mjs
 *
 * Local only. It serves the built site over loopback and stubs the two READ
 * routes; it never reaches a network, a database or a deployment, and it
 * cannot mutate anything — the stub answers GETs and nothing else.
 *
 * ## This tool has been negative-controlled
 *
 * A verification instrument that cannot fail proves nothing, so the liveness
 * assertion was checked by breaking the thing it watches: with the stubbed
 * state route returning 500 instead of a document, the run exits 1 and names
 * every room that stayed dark —
 *
 *     - approvals rendered as dark, fixture said attention
 *     - analytics rendered as dark, fixture said active
 *     ...
 *
 * which is exactly the regression it exists to catch. Note the control that
 * does NOT work: editing a room's liveness in the fixture changes both what the
 * page is sent and what it is compared against, so it passes. The assertion's
 * power is over hydration failing, not over the fixture being wrong about
 * itself.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const siteDir = resolve(flag('--site', join(packageRoot, 'dist', 'site')));
const outDir = resolve(flag('--out', join(packageRoot, 'dist', 'webgl-evidence')));
const port = Number(flag('--port', '4317'));

if (!existsSync(join(siteDir, 'immersive.html'))) {
  console.error(`No immersive.html in ${siteDir}. Run: npm run build:site --workspace @factoryos/headquarter`);
  process.exit(1);
}

/**
 * A Founder session and a small canonical state, in the exact wire shape
 * `live/control-api.ts` produces.
 *
 * Deliberately hand-written rather than imported: this tool must run against
 * the BUILT site with nothing else loaded, and the shapes it sends are the
 * ones the tests already pin server-side. Two rooms carry state so the
 * screenshot shows a lit building and a dark one side by side.
 */
const SESSION = {
  ok: true,
  authenticated: true,
  founder: true,
  principalId: 'founder',
  displayName: 'Evidence Founder',
  approvalAuthority: true,
  controls: {
    directOrder: false,
    approve: true,
    deny: true,
    mutationsEnabled: true,
    trustedOriginConfigured: true,
    requestOriginAllowed: true,
    requestOriginSource: 'referer',
  },
  routes: [],
};

function room(id, ordinal, name, liveness, metrics = [], rows = []) {
  return {
    roomId: id,
    name,
    ordinal,
    purpose: `${name} — evidence fixture.`,
    status: 'live',
    liveness,
    metrics,
    rows,
    emptyMessage: 'Evidence fixture.',
    provenance: 'webgl-evidence fixture',
  };
}

const ROOMS = [
  ['home', 1, 'Main Home', 'attention'],
  ['command-room', 2, 'Command Room', 'active'],
  ['mission-room', 3, 'Mission Room', 'active'],
  ['meeting-room', 4, 'Meeting Room', 'dark'],
  ['world-network', 5, 'World Network', 'quiet'],
  ['departments', 6, 'Department Navigation', 'quiet'],
  ['ai-workforce', 7, 'AI Workforce', 'quiet'],
  ['approvals', 8, 'Approvals', 'attention'],
  ['resources', 9, 'Resources', 'quiet'],
  ['analytics', 10, 'Analytics', 'active'],
  ['founder-office', 11, 'Founder Office', 'attention'],
  ['projects', 12, 'Projects', 'quiet'],
  ['product-factory', 13, 'Product Factory', 'dark'],
  ['company-memory', 14, 'Company Memory', 'dark'],
  ['research', 15, 'Research / R&D', 'dark'],
  ['security-center', 16, 'Security Center', 'quiet'],
  ['connections', 17, 'Settings / Connections', 'quiet'],
].map(([id, ordinal, name, liveness]) =>
  room(id, ordinal, name, liveness, [
    { label: 'Evidence metric', value: liveness === 'dark' ? 0 : 3, hint: 'Fixture value.', tone: 'info' },
  ]),
);

function stateWith(rooms) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    mode: 'live',
    note: 'webgl-evidence fixture',
    counts: { approvals: 2, pendingReviews: 0, outcomeUnknown: 0, blocked: 1, inFlight: 3, queued: 1 },
    killSwitch: { globalEngaged: false, engagedScopes: [] },
    rooms,
  };
}

const STATE = stateWith(ROOMS);

/**
 * The same seventeen rooms with every one of them dark.
 *
 * Used for the differential below: the page is loaded twice, and the two
 * composited images must differ. That is what makes this a test of the GPU
 * rather than of the DOM.
 */
const DARK_STATE = stateWith(ROOMS.map((room) => ({ ...room, liveness: 'dark' })));

/** Swapped between page loads; the stub serves whatever this points at. */
let servedState = STATE;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method !== 'GET') {
    res.writeHead(405).end('read-only evidence server');
    return;
  }
  if (path === '/api/hq/control/session') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(SESSION));
    return;
  }
  if (path === '/api/hq/control/state') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(servedState));
    return;
  }
  if (path === '/favicon.ico') {
    // The HQ site ships no favicon; a browser asks for one anyway, and the 404
    // it gets would otherwise be reported as a console error by this tool.
    res.writeHead(204).end();
    return;
  }
  const file = join(siteDir, path === '/' ? 'immersive.html' : path.replace(/^\/+/, ''));
  if (!file.startsWith(siteDir) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const playwrightPath = process.env.PLAYWRIGHT_PATH ?? 'playwright-core';
const chromiumPath = process.env.CHROMIUM_PATH;

// `playwright` exposes `chromium` as a named export; `playwright-core` (the
// smaller install, with no bundled browsers) exposes it on the default. Accept
// either, so the documented `npm i --no-save` line works with both.
const playwrightModule = await import(playwrightPath);
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
if (!chromium) {
  console.error(`No chromium launcher on ${playwrightPath}. Install playwright or playwright-core.`);
  process.exit(1);
}

await new Promise((done) => server.listen(port, '127.0.0.1', done));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  args: [
    '--no-sandbox',
    // Software rasterisation, so this runs on a headless box with no GPU and
    // still exercises a REAL GL implementation rather than a stub.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});

const failures = [];
const report = {};

try {
  // Tall enough that the whole building frame is in the screenshot. At 900 the
  // canvas ran off the bottom and the evidence images showed only its top
  // third, which made the framing look far tighter than it is.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(`http://127.0.0.1:${port}/immersive.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // What the shell decided, read off the document it actually produced.
  report.hq3d = await page.evaluate(() => document.documentElement.getAttribute('data-hq-3d'));
  report.status = await page.evaluate(
    () => document.querySelector('[data-hq-3d-status]')?.textContent ?? '',
  );
  report.access = await page.evaluate(
    () => document.querySelector('[data-hq-access]')?.getAttribute('data-hq-access-state') ?? '',
  );
  report.canvasPresent = await page.evaluate(() => document.querySelector('[data-hq-canvas]') != null);
  report.motionButton = await page.evaluate(
    () => document.querySelector('[data-hq-motion]')?.textContent ?? null,
  );
  report.litRooms = await page.evaluate(() =>
    [...document.querySelectorAll('[data-hq-room]')]
      .map((node) => [node.getAttribute('data-hq-room'), node.getAttribute('data-liveness')])
      .filter(([, liveness]) => liveness !== 'dark')
      .map(([id, liveness]) => `${id}:${liveness}`),
  );

  // THE question this tool was written for: does the page's own shader pair
  // compile and link on the context the page actually chose? Compiled here
  // against a context obtained exactly as the page obtains it.
  report.gl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const attrs = { alpha: false, antialias: true, depth: true };
    let name = 'webgl2';
    let gl = canvas.getContext('webgl2', attrs);
    if (!gl) {
      name = 'webgl';
      gl = canvas.getContext('webgl', attrs);
    }
    if (!gl) return { context: null };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      context: name,
      version: gl.getParameter(gl.VERSION),
      shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
    };
  });

  // Pull the exact shader sources out of the page's own inline script and
  // compile them on the page's own context type — no transcription, so this
  // cannot pass while the shipped shaders fail.
  report.shaders = await page.evaluate(() => {
    const source = [...document.querySelectorAll('script')].map((node) => node.textContent).join('\n');
    // The shaders are emitted through `jsonForScript`, so in the page they are
    // JSON string literals that OPEN with an escaped newline — matching on
    // `"precision` finds nothing, which is how an earlier run of this tool
    // reported "shader literals not located" while the shell was in fact
    // running perfectly well.
    const literals = source.match(/"\\nprecision highp float;[\s\S]*?[^\\]"/g) ?? [];
    if (literals.length < 2) return { found: literals.length, error: 'shader literals not located in page' };
    const [vertexSrc, fragmentSrc] = literals.slice(0, 2).map((literal) => JSON.parse(literal));
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {}) ?? canvas.getContext('webgl', {});
    if (!gl) return { found: literals.length, error: 'no context' };
    const build = (type, src) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return {
        ok: gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true,
        log: gl.getShaderInfoLog(shader) ?? '',
        shader,
      };
    };
    const vs = build(gl.VERTEX_SHADER, vertexSrc);
    const fs = build(gl.FRAGMENT_SHADER, fragmentSrc);
    let linked = false;
    let linkLog = '';
    if (vs.ok && fs.ok) {
      const program = gl.createProgram();
      gl.attachShader(program, vs.shader);
      gl.attachShader(program, fs.shader);
      gl.linkProgram(program);
      linked = gl.getProgramParameter(program, gl.LINK_STATUS) === true;
      linkLog = gl.getProgramInfoLog(program) ?? '';
      // Every attribute the shell binds must actually exist in the linked
      // program, or the building would draw with a stale/zero buffer.
      if (linked) {
        linkLog =
          'attribs: ' +
          ['aPos', 'aNormal', 'aColor', 'aMeta', 'aState', 'aPulse']
            .map((name) => `${name}=${gl.getAttribLocation(program, name)}`)
            .join(' ');
      }
    }
    return {
      contextUsed: canvas.getContext('webgl2', {}) ? 'webgl2' : 'webgl',
      vertexCompiled: vs.ok,
      vertexLog: vs.log,
      fragmentCompiled: fs.ok,
      fragmentLog: fs.log,
      linked,
      linkLog,
    };
  });

  // Did the building actually draw something? A canvas that is a single flat
  // colour has not.
  // Did the building actually DRAW?
  //
  // Neither `gl.readPixels` nor `drawImage` can answer this: the shell does not
  // set `preserveDrawingBuffer`, so its drawing buffer is undefined once the
  // frame has been composited, and both report a black canvas. Earlier runs of
  // this tool duly declared "nothing was drawn" while the screenshot beside it
  // showed the building — a probe defect that would have become a false
  // finding if it had gone into a report unchecked.
  //
  // The compositor's own output is the honest source, so the screenshot is
  // taken first and then decoded back INSIDE the page, where an <img> and a 2D
  // canvas can read its pixels without this tool needing a PNG decoder.
  const canvasBox = await page.locator('[data-hq-canvas]').boundingBox();
  const shot = await page.screenshot({ clip: canvasBox ?? undefined });
  report.rendered = await page.evaluate(async (base64) => {
    const image = new Image();
    await new Promise((done, fail) => {
      image.onload = done;
      image.onerror = fail;
      image.src = `data:image/png;base64,${base64}`;
    });
    const copy = document.createElement('canvas');
    copy.width = image.width;
    copy.height = image.height;
    const ctx = copy.getContext('2d');
    if (!ctx) return { drawn: false, reason: 'no 2d context' };
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
    const seen = new Set();
    let lit = 0;
    let samples = 0;
    for (let i = 0; i < data.length; i += 4 * 37) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      samples += 1;
      // The scene's fog colour is (4, 6, 9); anything brighter is geometry.
      if (data[i] + data[i + 1] + data[i + 2] > 40) lit += 1;
    }
    return {
      drawn: seen.size > 8 && lit > 0,
      distinctColoursSampled: seen.size,
      litSamples: lit,
      samples,
    };
  }, shot.toString('base64'));

  report.consoleErrors = consoleErrors;

  await page.screenshot({ path: join(outDir, 'immersive-webgl.png'), fullPage: false });
  await page.evaluate(() => {
    window.location.hash = '#/room/approvals';
    document.querySelector('.hq-building')?.scrollIntoView({ block: 'center' });
  });
  // Long enough for the camera flight to settle: the ease is ~0.085 per frame,
  // so a move takes about a second of real frames to converge.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outDir, 'immersive-room-approvals.png'), fullPage: false });

  /* ---------- assertions ---------- */
  if (report.hq3d !== 'on') failures.push(`shell did not run: data-hq-3d=${report.hq3d} (${report.status})`);
  if (!report.canvasPresent) failures.push('canvas was removed — the page took its fallback path');
  if (report.access !== 'ready') failures.push(`access state was ${report.access}, expected ready`);
  if (!report.shaders?.vertexCompiled) failures.push(`vertex shader failed: ${report.shaders?.vertexLog}`);
  if (!report.shaders?.fragmentCompiled) failures.push(`fragment shader failed: ${report.shaders?.fragmentLog}`);
  if (!report.shaders?.linked) failures.push(`program did not link: ${report.shaders?.linkLog}`);
  if (!report.rendered?.drawn) failures.push(`nothing was drawn: ${JSON.stringify(report.rendered)}`);

  // The state-driven lighting itself, asserted rather than merely collected.
  //
  // Without this the tool could print PASS while the one thing it exists to
  // prove was broken: a ready session, compiled shaders and the shell's
  // structural geometry alone satisfy every check above, so a regression that
  // stopped rooms hydrating would have gone unnoticed and the "verified in a
  // real browser" claim would have been hollow (Codex round 3, against this
  // file). The fixture's liveness per room is known, so it is checked.
  const expectedLiveness = new Map(ROOMS.map((room) => [room.roomId, room.liveness]));
  const actualLiveness = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-hq-room]')].map((node) => [
        node.getAttribute('data-hq-room'),
        node.getAttribute('data-liveness'),
      ]),
    ),
  );
  report.liveness = { expected: Object.fromEntries(expectedLiveness), actual: actualLiveness };
  for (const [roomId, expected] of expectedLiveness) {
    if (actualLiveness[roomId] !== expected) {
      failures.push(`${roomId} rendered as ${actualLiveness[roomId]}, fixture said ${expected}`);
    }
  }
  if (Object.keys(actualLiveness).length !== ROOMS.length) {
    failures.push(`expected ${ROOMS.length} room panels, found ${Object.keys(actualLiveness).length}`);
  }

  /* ---------- the differential: does the GPU actually light the rooms? ---------- */
  //
  // The check above reads `data-liveness` off the TEXT PANELS, which the client
  // runtime writes. That proves hydration reached the DOM and nothing more: if
  // `__hqShellApply` stopped writing `stateData`, or the `bufferSubData` upload
  // were dropped, every panel attribute would still be correct, the screenshot
  // would still be "drawn" because the structural geometry is enough, and this
  // tool would still print PASS with every room dark in the actual building
  // (Codex round 4, against this file for the second time).
  //
  // So the page is loaded TWICE — once with the mixed fixture, once with the
  // same seventeen rooms all dark — and the two composited canvases are
  // compared. Amber only ever comes from a room at `attention`, so its presence
  // in one image and absence in the other is an independently observable fact
  // about what the GPU drew, not about what the DOM says.
  const warmthOf = async (label) => {
    const box = await page.locator('[data-hq-canvas]').boundingBox();
    const png = await page.screenshot({ clip: box ?? undefined });
    return page.evaluate(async ([base64, tag]) => {
      const image = new Image();
      await new Promise((done, fail) => {
        image.onload = done;
        image.onerror = fail;
        image.src = `data:image/png;base64,${base64}`;
      });
      const copy = document.createElement('canvas');
      copy.width = image.width;
      copy.height = image.height;
      const ctx = copy.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
      let warm = 0;
      let bright = 0;
      for (let i = 0; i < data.length; i += 4 * 17) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        // Amber: red clearly ahead of blue. The dark tint and the cyan
        // structure are both blue-dominant, so this cannot be reached by them.
        if (r > b + 25 && r > 70) warm += 1;
        if (r + g + b > 150) bright += 1;
      }
      return { tag, warm, bright };
    }, [png.toString('base64'), label]);
  };

  const litMeasurement = await warmthOf('mixed');

  servedState = DARK_STATE;
  await page.evaluate(() => {
    window.location.hash = '';
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const darkMeasurement = await warmthOf('all-dark');
  servedState = STATE;

  report.gpuDifferential = { lit: litMeasurement, dark: darkMeasurement };

  if (!(litMeasurement.warm > 0)) {
    failures.push(
      `the GPU drew no amber with rooms at attention (${JSON.stringify(litMeasurement)}) — the ` +
        'state document is reaching the DOM but not the building',
    );
  }
  if (!(litMeasurement.warm > darkMeasurement.warm * 4 + 20)) {
    failures.push(
      'the composited building looks the same lit and unlit ' +
        `(lit ${JSON.stringify(litMeasurement)} vs dark ${JSON.stringify(darkMeasurement)}) — ` +
        'room lighting is not reaching the GPU',
    );
  }

  /* ---------- context loss after startup ---------- */
  //
  // Detection covers a context that is already lost when created; a GPU reset
  // later is a different path and used to leave the canvas on the page with
  // the status still claiming the 3D headquarters was active — the black
  // rectangle this design exists to avoid (Codex round 4). `WEBGL_lose_context`
  // makes that testable rather than theoretical, so it is tested.
  servedState = STATE;
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const loseSupported = await page.evaluate(() => {
    const canvas = document.querySelector('[data-hq-canvas]');
    if (!canvas) return false;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (!lose) return false;
    lose.loseContext();
    return true;
  });
  if (loseSupported) {
    await page.waitForTimeout(800);
    report.contextLoss = await page.evaluate(() => ({
      flag: document.documentElement.getAttribute('data-hq-3d'),
      status: document.querySelector('[data-hq-3d-status]')?.textContent ?? '',
      canvasPresent: document.querySelector('[data-hq-canvas]') != null,
      motionPresent: document.querySelector('[data-hq-motion]') != null,
      roomsStillPresent: document.querySelectorAll('[data-hq-room]').length,
    }));
    if (report.contextLoss.flag !== 'lost') {
      failures.push(`after context loss data-hq-3d was ${report.contextLoss.flag}, expected "lost"`);
    }
    if (report.contextLoss.canvasPresent) {
      failures.push('the canvas survived context loss — a dead rectangle claiming to be the building');
    }
    if (!report.contextLoss.status.includes('lost after')) {
      failures.push(`context-loss status did not explain itself: ${report.contextLoss.status}`);
    }
    if (report.contextLoss.roomsStillPresent !== ROOMS.length) {
      failures.push(
        `context loss took the rooms with it: ${report.contextLoss.roomsStillPresent} of ${ROOMS.length} left`,
      );
    }
  } else {
    report.contextLoss = { skipped: 'WEBGL_lose_context not available on this driver' };
  }

  if (report.consoleErrors.length > 0) failures.push(`console errors: ${report.consoleErrors.join(' | ')}`);
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify(report, null, 2));
console.log(`\nScreenshots → ${outDir}`);
if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nPASS — the immersive HQ runs on a real browser graphics stack.');
