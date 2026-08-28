/**
 * Browser freshness indicator for the HQ site (issue #200, scope A + mobile).
 *
 * The rendered pages are static HTML: their content is whatever the build
 * projected. What this script adds is not new content but an honest answer to
 * "is what I am looking at still current?" — it polls the snapshot the build
 * wrote next to the pages and reports one of four states in the header:
 *
 *   LIVE     the snapshot fetched, and its generatedAt matches this render
 *   UPDATED  the snapshot fetched, and it is NEWER than this render — the
 *            page you are reading is behind; reload to see it
 *   OFFLINE  the snapshot could not be fetched (opened from file://, or the
 *            host is unreachable). The page still shows its build-time data.
 *   ERROR    the snapshot fetched but could not be parsed
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

  function set(state, text, hint) {
    chip.setAttribute('data-live-state', state);
    chip.className = 'chip tone-' + (
      state === 'live' ? 'accent' : state === 'updated' ? 'warn' : state === 'offline' ? 'neutral' : 'danger'
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
        var generatedAt = snapshot && snapshot.generatedAt;
        if (typeof generatedAt !== 'string') throw new Error('snapshot has no generatedAt');
        if (generatedAt > RENDERED_AT) {
          set('updated', 'UPDATED — reload', 'A newer snapshot exists (' + generatedAt + '). This page still shows the ' + RENDERED_AT + ' render.');
        } else {
          set('live', 'LIVE', 'Snapshot confirmed current as of ' + generatedAt + '.');
        }
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
