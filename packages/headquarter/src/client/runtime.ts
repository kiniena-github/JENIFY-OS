/**
 * The HQ browser client runtime (issue #250, Stage 4 §A).
 *
 * ## What changed at this stage
 *
 * Before Stage 4, every HQ page was a photograph: `build-site.ts` projected a
 * data bundle into HTML, and the only thing the browser asked the server was
 * "is this photograph out of date?". The pages could not show current state
 * even in principle, and the freshness chip said so — `UPDATED — page not
 * rebuilt` is a chip that exists because the page could do nothing about it.
 *
 * This runtime is the other half. It asks the authenticated control API for
 * canonical state, on a session the server resolved, and renders what comes
 * back. Nothing on the immersive page is baked in.
 *
 * ## What it is allowed to do
 *
 * Render text it was handed, and nothing else. The rooms arrive from the server
 * already projected (see `contracts.HqClientStateResponse`), so this file
 * contains no rule about what a room means; it cannot, because it does not know
 * how a room is computed. Every string reaches the document through
 * `textContent`. It draws no control of its own — approve, deny and the order
 * composer remain the existing, separately-tested control consoles, and this
 * runtime only re-reads state after one of them confirms an outcome.
 *
 * ## Fail closed, and keep failing closed
 *
 * The access verdict is re-evaluated on EVERY poll, not once at startup. A
 * session that expires between polls moves the page from `ready` to
 * `unauthenticated`, wipes every room back to "nothing is claimed", and says
 * why. It never leaves the last good render on screen as though it were still
 * current — a stale room that looks live is precisely the failure this stage
 * exists to remove.
 */

import { jsonForScript } from '../ui/components.js';
import { CONTROL_ROUTES } from '../live/control-api.js';
import { DOM_HELPERS_JS } from '../ui/control-console.js';
import { ACCESS_VERDICT_JS, LOCK_STATE_JS } from './access.js';
import { HQ_ROOMS } from './rooms.js';
import { hydrateRooms } from './hydrate.js';

/** The authenticated read route this stage adds. */
export const CLIENT_STATE_PATH: string = CONTROL_ROUTES.state;

/**
 * How often the runtime re-reads canonical state.
 *
 * The same 10–30s band the freshness poll uses. Longer would let an expired
 * session sit on screen; shorter would hammer a Founder-gated route that reads
 * the operational tables on every call for no gain — HQ state changes at human
 * and CI speed, not at frame rate.
 */
export const CLIENT_POLL_INTERVAL_MS = 20_000;

/**
 * How long a single read may take before it is abandoned.
 *
 * Comfortably longer than a Founder-gated state read on a loaded host, and
 * comfortably shorter than the poll interval, so a stalled request is dropped
 * before the next cycle would have started rather than accumulating.
 */
export const CLIENT_READ_TIMEOUT_MS = 12_000;

/**
 * Every path this runtime may fetch.
 *
 * Exported so `test/client-runtime.test.ts` can allow-list every `fetch(` in
 * the emitted page against it, the same assertion `CONTROL_FETCH_TARGETS`
 * carries for the control consoles. Two read routes; no write route, because
 * this runtime performs no write.
 */
export const CLIENT_FETCH_TARGETS: readonly string[] = [CONTROL_ROUTES.session, CLIENT_STATE_PATH];

export function clientRuntimeScript(): string {
  const roomIds = HQ_ROOMS.map((room) => room.id);
  const roomOrdinals = HQ_ROOMS.map((room) => room.ordinal);
  // The provenance each room carries when NO state document is in hand — the
  // same string the server rendered into the page. `hydrateRooms(null, null)`
  // is the one source for it, so the static page and a page that has just
  // invalidated say exactly the same thing.
  const staticProvenance = Object.fromEntries(
    hydrateRooms(null, null).map((view) => [view.roomId, view.provenance]),
  );
  return `<script>
(function () {
  var root = document.querySelector('[data-hq-client]');
  if (!root || typeof window.fetch !== 'function') return;

  ${DOM_HELPERS_JS}
  ${ACCESS_VERDICT_JS}
  ${LOCK_STATE_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var STATE_PATH = ${jsonForScript(CLIENT_STATE_PATH)};
  var ROOM_IDS = ${jsonForScript(roomIds)};
  // Carried explicitly rather than derived from the array index. They happen to
  // be 1..17 in order today, and a test holds that — but a shell slot is a
  // shader array index, and deriving one from a list position is the kind of
  // coincidence that silently lights the wrong room if the registry is ever
  // reordered.
  var ROOM_ORDINALS = ${jsonForScript(roomOrdinals)};
  var ROOM_STATIC_PROVENANCE = ${jsonForScript(staticProvenance)};
  var POLL_MS = ${CLIENT_POLL_INTERVAL_MS};
  var READ_TIMEOUT_MS = ${CLIENT_READ_TIMEOUT_MS};

  var accessChip = document.querySelector('[data-hq-access]');
  var accessNote = document.querySelector('[data-hq-access-note]');
  var lockBanner = document.querySelector('[data-hq-lock]');
  var stampNode = document.querySelector('[data-hq-stamp]');

  function setAccess(verdict) {
    if (accessChip) {
      accessChip.setAttribute('data-hq-access-state', verdict.state);
      accessChip.className = 'chip tone-' + (verdict.state === 'ready' ? 'accent' : verdict.state === 'unauthenticated' ? 'neutral' : 'warn');
      accessChip.textContent = verdict.label;
    }
    if (accessNote) accessNote.textContent = verdict.message;
    root.setAttribute('data-hq-access-state', verdict.state);
  }

  function setLock(lock) {
    if (!lockBanner) return;
    if (!lock.locked) {
      lockBanner.hidden = true;
      lockBanner.textContent = '';
      return;
    }
    lockBanner.hidden = false;
    lockBanner.textContent = lock.label + ' — ' + lock.message;
  }

  function panelFor(roomId) {
    return document.querySelector('[data-hq-room="' + roomId + '"]');
  }

  function clearRooms(reason) {
    // Drop the cached views FIRST. They were read under an authority this page
    // no longer has, and the hashchange handler below reapplies them to the 3D
    // shell — so keeping them here would relight, and possibly pulse, rooms
    // from the previous authenticated read while the text panels beside them
    // said nothing was current (Codex P1 on 7e87392). Wiping the rooms has to
    // mean wiping every copy of them, including the one only the building can
    // see.
    lastViews = null;
    for (var i = 0; i < ROOM_IDS.length; i += 1) {
      var panel = panelFor(ROOM_IDS[i]);
      if (!panel) continue;
      var statusNode = panel.querySelector('[data-hq-room-status]');
      var body = panel.querySelector('[data-hq-room-body]');
      // A room whose truth is static (not recorded / a later roadmap phase) is
      // left exactly as the server rendered it: its statement does not depend
      // on a session, and blanking it would replace a true sentence with an
      // access complaint.
      if (panel.getAttribute('data-hq-room-static') === 'yes') continue;
      if (statusNode) statusNode.textContent = 'NO STATE READ';
      if (body) {
        body.textContent = '';
        body.appendChild(el('p', 'readonly-note', reason));
      }
      // The per-room provenance is state-derived too. Left alone, each live
      // room went on claiming the previous document's "as of ... provenance
      // live" while everything around it said no state had been read — the
      // same defect as the global stamp, one level further in (Codex round 4).
      var provenanceNode = panel.querySelector('[data-hq-room-provenance]');
      if (provenanceNode) {
        provenanceNode.textContent = ROOM_STATIC_PROVENANCE[ROOM_IDS[i]] || '';
      }
      panel.setAttribute('data-liveness', 'dark');
    }
    if (typeof window.__hqShellApply === 'function') {
      var dark = [];
      for (var j = 0; j < ROOM_IDS.length; j += 1) {
        dark.push({ roomId: ROOM_IDS[j], ordinal: ROOM_ORDINALS[j], liveness: 'dark' });
      }
      window.__hqShellApply(dark, activeRoom());
    }
  }

  function metricNode(metric) {
    var box = el('div', 'kpi tone-' + metric.tone);
    box.appendChild(el('span', 'kpi-label', metric.label));
    box.appendChild(el('b', 'kpi-value', String(metric.value)));
    box.appendChild(el('span', 'kpi-hint', metric.hint));
    return box;
  }

  function rowNode(row) {
    var item = el('li', 'hq-occupant');
    item.appendChild(el('b', null, row.primary));
    var chips = el('p', 'row');
    for (var i = 0; i < row.chips.length; i += 1) {
      chips.appendChild(el('span', 'chip tone-' + row.chips[i].tone, row.chips[i].label));
    }
    if (row.chips.length > 0) item.appendChild(chips);
    item.appendChild(el('p', 'faint', row.secondary));
    return item;
  }

  function renderRoom(view) {
    var panel = panelFor(view.roomId);
    if (!panel) return;
    var statusNode = panel.querySelector('[data-hq-room-status]');
    var body = panel.querySelector('[data-hq-room-body]');
    var provenanceNode = panel.querySelector('[data-hq-room-provenance]');
    if (statusNode) statusNode.textContent = view.status === 'live' ? 'LIVE' : view.status.toUpperCase();
    if (provenanceNode) provenanceNode.textContent = view.provenance;
    panel.setAttribute('data-liveness', view.liveness);
    if (!body) return;
    body.textContent = '';
    if (view.metrics.length > 0) {
      var kpis = el('div', 'kpis');
      for (var m = 0; m < view.metrics.length; m += 1) kpis.appendChild(metricNode(view.metrics[m]));
      body.appendChild(kpis);
    }
    if (view.rows.length > 0) {
      var list = el('ul', 'hq-occupants');
      for (var r = 0; r < view.rows.length; r += 1) list.appendChild(rowNode(view.rows[r]));
      body.appendChild(list);
    } else if (view.emptyMessage) {
      // The empty message is NOT a placeholder. It states what the zero means,
      // which is the difference between an honest empty room and a broken one.
      body.appendChild(el('p', 'readonly-note', view.emptyMessage));
    }
  }

  function activeRoom() {
    var match = /^#\\/room\\/([a-z0-9-]+)$/.exec(window.location.hash || '');
    if (!match) return 'home';
    for (var i = 0; i < ROOM_IDS.length; i += 1) if (ROOM_IDS[i] === match[1]) return match[1];
    return 'home';
  }

  function markActive() {
    var current = activeRoom();
    for (var i = 0; i < ROOM_IDS.length; i += 1) {
      var panel = panelFor(ROOM_IDS[i]);
      if (panel) panel.setAttribute('data-hq-room-active', ROOM_IDS[i] === current ? 'yes' : 'no');
      var link = document.querySelector('[data-hq-room-link="' + ROOM_IDS[i] + '"]');
      if (link) {
        if (ROOM_IDS[i] === current) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    }
    if (typeof window.__hqShellGoTo === 'function') window.__hqShellGoTo(current);
    return current;
  }

  var lastViews = null;

  // A document is applied whole or not at all.
  //
  // The first version of this guard asked only whether rooms was an array, so a
  // 200 carrying an empty, partial or duplicated set updated the panels it did
  // supply and left every omitted panel showing the PREVIOUS document's
  // metrics, liveness and provenance — while the global stamp advanced to the
  // new one. Half a document is not a smaller truth, it is a page mixing two
  // instants (Codex round 5).
  //
  // The second version checked the seventeen ids and stopped there, which left
  // the same failure reachable by a different door: a version-skewed server
  // sending all seventeen ids with a room missing metrics passed the check,
  // then threw at view.metrics.length PART WAY THROUGH the render loop —
  // after earlier panels had already been mutated — and the throw was caught by
  // a handler that only cleared inFlight. Same mixed page, same stale stamp
  // and lock (Codex round 6).
  //
  // So the whole shape is checked, for every entry, before any panel is
  // touched. Everything the render path and the shell read is required to be
  // present and of the right type: a missing hint would draw an empty node
  // rather than throw, but a page that renders canonical company state should
  // not be guessing which half of a malformed document it can trust.
  function isText(value) { return typeof value === 'string'; }

  function metricValid(metric) {
    return metric != null && typeof metric === 'object' &&
      isText(metric.label) && isText(metric.hint) && isText(metric.tone) &&
      (typeof metric.value === 'string' || typeof metric.value === 'number');
  }

  function chipValid(chip) {
    return chip != null && typeof chip === 'object' && isText(chip.tone) && isText(chip.label);
  }

  function rowValid(row) {
    if (row == null || typeof row !== 'object') return false;
    if (!isText(row.primary) || !isText(row.secondary) || !Array.isArray(row.chips)) return false;
    for (var i = 0; i < row.chips.length; i += 1) if (!chipValid(row.chips[i])) return false;
    return true;
  }

  // The ordinal the registry gives each room, by id. Built once.
  var ROOM_ORDINAL_BY_ID = {};
  for (var o = 0; o < ROOM_IDS.length; o += 1) ROOM_ORDINAL_BY_ID[ROOM_IDS[o]] = ROOM_ORDINALS[o];

  function roomViewValid(view) {
    if (view == null || typeof view !== 'object') return false;
    if (!isText(view.roomId) || !isText(view.status) || !isText(view.liveness) || !isText(view.provenance)) return false;
    if (!isText(view.emptyMessage)) return false;
    // The ordinal must be THIS room's ordinal, not merely a number in range.
    //
    // The text panels are selected by roomId while the shell indexes its
    // lighting by view.ordinal, so the two identify a room by different keys.
    // A document that swaps two valid ordinals between two valid rooms passed a
    // range check and then lit and pulsed the wrong buildings beside panels
    // that were themselves correct — the page disagreeing with itself, which is
    // the one thing this stage exists to prevent (Codex round 7).
    //
    // I had written the range check under a comment saying a bad ordinal lights
    // the wrong building, which was the right observation attached to a check
    // that did not enforce it.
    if (ROOM_ORDINAL_BY_ID[view.roomId] !== view.ordinal) return false;
    if (!Array.isArray(view.metrics) || !Array.isArray(view.rows)) return false;
    for (var m = 0; m < view.metrics.length; m += 1) if (!metricValid(view.metrics[m])) return false;
    for (var r = 0; r < view.rows.length; r += 1) if (!rowValid(view.rows[r])) return false;
    return true;
  }

  function roomsComplete(rooms) {
    if (!Array.isArray(rooms) || rooms.length !== ROOM_IDS.length) return false;
    var seen = {};
    for (var i = 0; i < rooms.length; i += 1) {
      if (!roomViewValid(rooms[i])) return false;
      var id = rooms[i].roomId;
      if (seen[id] === true) return false;
      seen[id] = true;
    }
    for (var j = 0; j < ROOM_IDS.length; j += 1) if (seen[ROOM_IDS[j]] !== true) return false;
    return true;
  }

  function applyState(body) {
    if (body == null || typeof body !== 'object' || body.ok !== true || !roomsComplete(body.rooms)) {
      // invalidate(), not clearRooms(): this is the fourth path that abandons a
      // state document, and it had the same defect as the three Codex found —
      // it dropped the rooms and left the previous poll's lock banner and stamp
      // standing. Found by re-reading my own fix rather than by a second
      // review round, which is where it should have been found the first time.
      invalidate('The state route answered with a body this client cannot read as a complete, well-formed set ' +
        'of all ' + ROOM_IDS.length + ' rooms, so nothing is claimed here rather than part of the page moving ' +
        'to a new document and the rest staying on the old one.');
      return;
    }
    lastViews = body.rooms;
    for (var i = 0; i < body.rooms.length; i += 1) renderRoom(body.rooms[i]);
    setLock(lockState(body.killSwitch));
    if (stampNode) {
      stampNode.textContent = 'Canonical state as of ' + String(body.generatedAt) + ' · provenance ' + String(body.mode);
    }
    if (typeof window.__hqShellApply === 'function') window.__hqShellApply(body.rooms, activeRoom());
  }

  // Every read is bounded — by the CLOCK, not by the browser's feature set.
  //
  // A fetch that establishes a connection and then never resolves OR rejects —
  // a stalled proxy, a hung host — left inFlight true forever: every
  // subsequent poll was discarded, the last hydrated rooms stayed on screen
  // looking current, and even a session expiry could no longer invalidate
  // them. A fail-closed runtime that can be wedged open by silence is not
  // fail-closed (Codex round 5).
  //
  // The first fix hung that bound on AbortController, and the timer's callback
  // did nothing at all when there was none. On such a browser the read still
  // never settled: the deadline in cycle() below would eventually let a NEW
  // poll start, but it neither invalidated what was on screen nor cancelled the
  // abandoned promise — so stale canonical state stayed visible through
  // repeated stalls, and a late answer from an abandoned read could still land
  // on top of a newer one (Codex round 6). A guarantee that only holds where a
  // constructor happens to exist is not a guarantee.
  //
  // So the timeout resolves the read itself. The abort is now an optimisation
  // on top — it frees the connection where it can — and never the mechanism the
  // deadline depends on. finish is idempotent, so whichever arrives first
  // wins and the loser is dropped.
  var READ_TIMED_OUT = 'no answer within ' + Math.round(READ_TIMEOUT_MS / 1000) + 's';

  function read(path) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var options = { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (controller) options.signal = controller.signal;
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function finish(result) {
        if (done) return;
        done = true;
        if (timer !== null) window.clearTimeout(timer);
        resolve(result);
      }
      timer = window.setTimeout(function () {
        // Best effort: release the connection if this browser can. The read is
        // resolved either way, on the line below.
        if (controller) { try { controller.abort(); } catch (ignored) {} }
        finish({ status: 0, body: null, error: READ_TIMED_OUT });
      }, READ_TIMEOUT_MS);
      fetch(path, options).then(
        function (response) {
          return response.json().then(
            function (parsed) { finish({ status: response.status, body: parsed, error: null }); },
            function () { finish({ status: response.status, body: null, error: null }); }
          );
        },
        function (failure) {
          finish({
            status: 0,
            body: null,
            error: failure && failure.name === 'AbortError'
              ? READ_TIMED_OUT
              : failure && failure.message ? failure.message : 'network failure',
          });
        }
      );
    });
  }

  // Everything derived from a state document goes at once, or the page ends up
  // half-current: an earlier version cleared only the rooms when a state read
  // failed, leaving the previous poll's lock banner and "canonical state as of"
  // stamp on screen — the page saying nothing is current while still asserting
  // a lock and a provenance from a read it had just disowned (Codex P2 on
  // 7e87392). One function, so a future branch cannot forget half of it.
  function invalidate(reason) {
    clearRooms(reason);
    setLock({ locked: false, label: '', message: '' });
    if (stampNode) stampNode.textContent = '';
  }

  var inFlight = false;
  var inFlightSince = 0;
  // Which cycle is the current one. A cycle that has been superseded — because
  // the deadline below let a new one start — must not be able to write the page
  // when its answer finally arrives, or a stale document lands on top of a
  // fresher one (Codex round 6).
  var generation = 0;

  function cycle() {
    // The timeout inside read() is the real bound. This is the second lock on
    // the same door: if a read somehow outlives it anyway, a cycle running
    // longer than two timeouts is treated as lost rather than allowed to block
    // every future poll indefinitely.
    if (inFlight && Date.now() - inFlightSince < READ_TIMEOUT_MS * 2) return;
    generation += 1;
    var mine = generation;
    function current() { return mine === generation; }
    inFlight = true;
    inFlightSince = Date.now();
    read(SESSION_PATH).then(function (session) {
      if (!current()) return;
      var verdict = accessVerdict(session.status, session.body, session.error);
      setAccess(verdict);
      if (verdict.state !== 'ready') {
        // Every non-ready state wipes the rooms. Including the transition OUT
        // of ready: an expired session must not leave the previous render on
        // screen looking current.
        invalidate(verdict.message);
        inFlight = false;
        return;
      }
      return read(STATE_PATH).then(function (state) {
        if (!current()) return;
        if (state.error) {
          invalidate('The HQ state route could not be reached (' + state.error + '), so nothing on this page is claimed to be current.');
        } else if (state.status !== 200) {
          var verdict2 = accessVerdict(state.status, state.body, null);
          setAccess(verdict2);
          invalidate(verdict2.message);
        } else {
          applyState(state.body);
        }
        inFlight = false;
      });
    }).catch(function (failure) {
      // A throw anywhere above means the page may have been mutated part way
      // through a document. Clearing inFlight and walking away left exactly the
      // mixed old/new page — stale stamp, stale lock — that invalidate() exists
      // to prevent (Codex round 6). Whatever went wrong, nothing here is
      // claimed to be current afterwards.
      if (current()) {
        invalidate('This page could not finish reading canonical HQ state (' +
          (failure && failure.message ? failure.message : 'unexpected client error') +
          '), so nothing on it is claimed to be current.');
      }
      inFlight = false;
    });
  }

  // The hook the existing control consoles call after a CONFIRMED mutation, so
  // a decision the Founder just made is reflected without waiting out a poll.
  // It re-reads canonical state; it never patches the DOM from the mutation's
  // own response, because that response says what happened to ONE task and this
  // page claims to show all of them.
  window.__hqStateChanged = function () { cycle(); };

  window.addEventListener('hashchange', function () {
    var current = markActive();
    if (lastViews && typeof window.__hqShellApply === 'function') window.__hqShellApply(lastViews, current);
  });

  markActive();
  cycle();
  window.setInterval(cycle, POLL_MS);
})();
</script>`;
}
