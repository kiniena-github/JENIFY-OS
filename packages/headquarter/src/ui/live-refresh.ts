/**
 * Browser freshness indicator for the HQ site (issue #200, scope A + mobile).
 *
 * The rendered pages are static HTML: their content is whatever the build
 * projected. What this script adds is not new content but an honest answer to
 * "is what I am looking at still current?" — it polls the snapshot the build
 * wrote next to the pages and reports one of six states in the header:
 *
 *   LIVE     the snapshot fetched, its generatedAt is EXACTLY this render's
 *            timestamp, AND the snapshot's own provenance is `live` — the page
 *            and the data behind it are the same instant of canonical state
 *   SAMPLE / RECONSTRUCTED
 *            the timestamps match, but the snapshot says its own data is not
 *            live. Freshness is not truth: the static preview ships a sample
 *            bundle, and it may not announce itself as LIVE
 *   UPDATED  the snapshot fetched, and it is NEWER than this render — newer
 *            canonical state exists and this page does not show it. It does
 *            NOT say "reload": these pages are static HTML written by
 *            `build-site.ts`, and the poll never applies a snapshot section to
 *            the document, so reloading re-serves the same build. Seeing the
 *            newer state takes a site rebuild, and the chip says so rather
 *            than sending a reader round a loop that cannot end
 *   STALE    the snapshot fetched, and it is OLDER than this render — the
 *            data file backing this page does not match it, so nothing here
 *            can be claimed to be current
 *   OFFLINE  the snapshot could not be fetched (opened from file://, or the
 *            host is unreachable). The page still shows its build-time data.
 *   ERROR    the snapshot fetched but could not be parsed
 *
 * LIVE requires the exact match and nothing less (issue #200, Codex P1 #3). An
 * earlier version treated every snapshot that was "not newer" as LIVE, which
 * meant an OLDER snapshot — a rolled-back file, a page served from a newer
 * build than the data next to it — rendered as LIVE. Older is not current.
 *
 * Polling rather than websockets is deliberate for V1: the brief asks for
 * simple reliable refresh, the artefact must stay a static build, and a
 * poll that fails degrades to a truthful OFFLINE instead of a silent stall.
 *
 * What it must never do — and what the tests lock — is invent freshness. An
 * unreachable snapshot is reported as unreachable; it never leaves the chip
 * reading LIVE, and it never fabricates a newer timestamp.
 */

/** Poll interval, within the 10–30s band the mission brief specifies. */
export const SNAPSHOT_POLL_INTERVAL_MS = 20_000;

/** File the static build writes next to the pages. */
export const SNAPSHOT_FILENAME = 'hq-snapshot.json';

/**
 * The freshness decision itself, as browser-executable source.
 *
 * It lives here as one string, embedded verbatim in the page and executed
 * directly by the tests (`new Function`), because a claim of LIVE is exactly
 * the kind of thing that must be tested by running it rather than by grepping
 * the rendered HTML for a label. There is one implementation, and it is the
 * one that ships.
 *
 * Returns `{ state, label, hint }`. The only path to `live` is an exact string
 * match between the snapshot's `generatedAt` and the instant this page was
 * rendered, AND a snapshot that does not claim a non-live provenance of its
 * own: freshness and truthfulness are separate questions, and a matching
 * sample bundle must answer the second one honestly.
 */
export const FRESHNESS_VERDICT_JS = `function freshnessVerdict(renderedAt, generatedAt, mode) {
  if (typeof generatedAt !== 'string' || generatedAt === '') {
    return { state: 'error', label: 'ERROR — unreadable snapshot', hint: 'The snapshot carries no generatedAt timestamp, so its freshness cannot be established.' };
  }
  if (generatedAt === renderedAt) {
    // Matching timestamps answer "is this current?", not "is this real". A
    // snapshot whose own provenance is sample or reconstructed is reported by
    // that provenance, however exactly its instant matches — otherwise the
    // static preview, which ships a sample bundle, would announce LIVE.
    //
    // And the test is POSITIVE (Codex round-3 follow-up): only mode === 'live'
    // reaches the live return. \`HqSnapshot.mode\` is mandatory, so a snapshot
    // that omits it, sends null, or sends an empty string is malformed or from
    // some other producer — and previously that absence of provenance was
    // rewarded with the strongest label in the set. Unknown provenance now
    // fails closed, exactly like every other unknown in this system.
    if (mode === 'live') {
      return { state: 'live', label: 'LIVE', hint: 'Snapshot matches this render exactly (' + generatedAt + ') and states live provenance.' };
    }
    if (typeof mode === 'string' && mode !== '') {
      return { state: 'not-live', label: String(mode).toUpperCase() + ' — not live data', hint: 'The snapshot next to this page matches this render (' + generatedAt + '), but its own provenance is ' + mode + ', not live.' };
    }
    return { state: 'not-live', label: 'UNKNOWN PROVENANCE — not live data', hint: 'The snapshot next to this page matches this render (' + generatedAt + ') but states no provenance mode, so it cannot be reported as live.' };
  }
  var fetched = Date.parse(generatedAt);
  var rendered = Date.parse(renderedAt);
  if (isNaN(fetched) || isNaN(rendered)) {
    return { state: 'error', label: 'ERROR — unreadable snapshot', hint: 'The snapshot timestamp (' + generatedAt + ') is not a valid instant, so its freshness cannot be established.' };
  }
  if (fetched > rendered) {
    return { state: 'updated', label: 'UPDATED — page not rebuilt', hint: 'Newer canonical state exists (' + generatedAt + '), but these pages are static HTML written by the site build: reloading re-serves the same ' + renderedAt + ' render. Rebuild the site to see it.' };
  }
  if (fetched < rendered) {
    return { state: 'stale', label: 'STALE — not live', hint: 'The snapshot next to this page (' + generatedAt + ') is OLDER than the ' + renderedAt + ' render, so this page is not showing current data.' };
  }
  return { state: 'stale', label: 'STALE — not live', hint: 'The snapshot timestamp (' + generatedAt + ') does not match this render (' + renderedAt + ') exactly, so currency cannot be confirmed.' };
}`;

/**
 * Inline script wiring the header freshness chip.
 *
 * `renderedAt` is baked in at build time so the comparison is between two
 * known instants rather than against the viewer's clock, which may be wrong.
 */
export function liveRefreshScript(renderedAt: string): string {
  const renderedAtJson = JSON.stringify(renderedAt);
  return `<script>
(function () {
  var RENDERED_AT = ${renderedAtJson};
  var chip = document.querySelector('[data-live-state]');
  if (!chip) return;
  var label = chip.querySelector('[data-live-label]');
  var detail = document.querySelector('[data-live-detail]');

  ${FRESHNESS_VERDICT_JS}

  function set(state, text, hint) {
    chip.setAttribute('data-live-state', state);
    chip.className = 'chip tone-' + (
      state === 'live' ? 'accent'
        : state === 'updated' ? 'warn'
        : state === 'stale' ? 'warn'
        : state === 'offline' ? 'neutral'
        : state === 'not-live' ? 'neutral'
        : 'danger'
    );
    if (label) label.textContent = text;
    if (detail) detail.textContent = hint;
  }

  function poll() {
    fetch(${JSON.stringify(SNAPSHOT_FILENAME)} + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (snapshot) {
        // LIVE is the exact-match case only, and the decision is the shared
        // one above — nothing here may round in favour of LIVE.
        var verdict = freshnessVerdict(RENDERED_AT, snapshot && snapshot.generatedAt, snapshot && snapshot.mode);
        set(verdict.state, verdict.label, verdict.hint);
      })
      .catch(function (error) {
        set(
          'offline',
          'OFFLINE — build-time data',
          'Could not reach ' + ${JSON.stringify(SNAPSHOT_FILENAME)} + ' (' + error.message + '). Showing the ' + RENDERED_AT + ' render; freshness is unknown.'
        );
      });
  }

  poll();
  setInterval(poll, ${SNAPSHOT_POLL_INTERVAL_MS});
})();
</script>`;
}
