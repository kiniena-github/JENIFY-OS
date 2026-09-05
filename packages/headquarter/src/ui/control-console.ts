/**
 * Browser wiring for the HQ control plane (issue #200, integration lane —
 * the UI half of the seam #214 built server-side).
 *
 * ## The invariant this module lives under
 *
 * The site-wide honesty rule used to be "nothing on any page executes
 * anything", asserted literally as "no <form>, no <button>, no <input>".
 * With the Founder-auth control plane real, that rule is RE-SCOPED, not
 * weakened:
 *
 *   1. **No mutation outside the control API.** Every network call any HQ
 *      page makes goes to `CONTROL_API_PREFIX` routes or to the freshness
 *      snapshot next to the pages. Nothing else, ever.
 *   2. **No control is rendered that `/session` did not grant.** The STATIC
 *      HTML still contains no form, button or submit control — exactly as
 *      before. Working controls exist only as DOM nodes created by the
 *      scripts in this module, and only after `GET /api/hq/control/session`
 *      answered with the specific grant (`controls.directOrder`,
 *      `controls.approve`, `controls.deny`) as literally `true`. Anything
 *      else — an unreachable API, a non-Founder session, a read-only
 *      deployment, a malformed answer — draws NOTHING and states why.
 *
 * The grant decision itself is `CONTROL_GRANT_JS`, one string embedded
 * verbatim in the pages and executed directly by the tests (the same
 * pattern as `FRESHNESS_VERDICT_JS`), so the deny-by-default rule that ships
 * is the rule that is tested.
 *
 * ## What the scripts deliberately do NOT do
 *
 * - They never send an identity field. Who is acting is decided by the
 *   server session and the configured Founder map; the control API refuses
 *   a body that names an actor, and these scripts never build one.
 * - They never invent availability. A route the server reports as not
 *   connected is drawn BLOCKED with the server's own reason, verbatim; an
 *   availability the server did not report is stated as not evaluated.
 * - They never substitute a provider. Route choice is sent as chosen; a
 *   refusal comes back as a refusal.
 * - They render API text via `textContent` only — server-supplied strings
 *   can never become markup.
 * - They never read, store or echo a credential. The step-up password field
 *   is a DOM input whose value goes into one same-origin POST body and
 *   nowhere else.
 */

import { jsonForScript } from './components.js';
import { CONTROL_ROUTES } from '../live/control-api.js';

/**
 * The only paths any HQ page script may fetch, beside the freshness
 * snapshot. Exported so the tests can allow-list every `fetch(` in every
 * emitted page against it — that assertion is what makes invariant (1)
 * above load-bearing rather than a comment.
 */
export const CONTROL_FETCH_TARGETS: readonly string[] = [
  CONTROL_ROUTES.session,
  CONTROL_ROUTES.approvals,
  // Stage 4's authenticated read route. It belongs on this list for the same
  // reason as the others: it is a control-API path an HQ page fetches, and the
  // page-wide audit in `test/control-console.test.ts` is only load-bearing if
  // the list is complete.
  CONTROL_ROUTES.state,
  CONTROL_ROUTES.orders,
  CONTROL_ROUTES.approve,
  CONTROL_ROUTES.deny,
  // Phase 3 (issue #253): the mission console reads the mission list and
  // posts a Founder Command or a cancellation. Same list, same audit.
  CONTROL_ROUTES.missions,
  CONTROL_ROUTES.missionCancel,
];

/**
 * The grant decision, as browser-executable source.
 *
 * Deny-by-default in the strictest usable sense: a control is granted only
 * when the session answer is a well-formed object that says `ok: true`,
 * `founder: true`, and carries the control's flag as literally `true`.
 * Truthy-but-not-true values ('yes', 1, {}), a missing controls object, an
 * error answer, or no answer at all grant nothing. The reason string is the
 * server's own message when it sent one, so the page explains itself in the
 * server's words rather than guessing.
 */
export const CONTROL_GRANT_JS = `function grantedControls(session) {
  var off = { directOrder: false, approve: false, deny: false, founderCommand: false, cancelMission: false, reason: '' };
  if (session == null || typeof session !== 'object') {
    off.reason = 'The control API gave no readable answer, so no control is drawn.';
    return off;
  }
  var stated = typeof session.message === 'string' && session.message !== '' ? session.message : '';
  if (session.ok !== true || session.founder !== true || session.controls == null || typeof session.controls !== 'object') {
    off.reason = stated !== '' ? stated : 'This session holds no Founder grant, so no control is drawn.';
    return off;
  }
  return {
    directOrder: session.controls.directOrder === true,
    approve: session.controls.approve === true,
    deny: session.controls.deny === true,
    founderCommand: session.controls.founderCommand === true,
    cancelMission: session.controls.cancelMission === true,
    reason: stated !== '' ? stated : ungrantedReason(session.controls)
  };
}
function ungrantedReason(controls) {
  if (controls.mutationsEnabled === false) {
    return 'This deployment mounts HQ read-only \\u2014 browser writes are not enabled here, so the control API would refuse every one of them.';
  }
  if (controls.trustedOriginConfigured !== true) {
    return 'No trusted origin is configured for HQ browser control, so a write from any page would be refused.';
  }
  if (controls.requestOriginAllowed !== true) {
    return 'The origin of THIS page was not established as a trusted one (origin evidence: ' +
      String(controls.requestOriginSource) + '), so a write from it would be refused.';
  }
  return 'This session is a mapped Founder and this page\\u2019s origin is trusted, but the server did not grant this ' +
    'specific control \\u2014 the principal may not hold that authority, or the capability behind it is not registered ' +
    'and enabled on this deployment. Nothing is wrong with the page; the grant itself was withheld.';
}`;

/**
 * Idempotency-key policy for the composer, as browser-executable source.
 *
 * One key is generated when the composer is built and STAYS THE SAME across
 * failed or unconfirmed submissions — so a retry after a network error or a
 * refusal can never create a second task — and rotates only after the server
 * confirmed an outcome ('created' or 'deduplicated'), at which point the next
 * submission is a deliberately new order. The key is an input the server MIXES
 * into its own derived key, never the key itself, so no client value can name
 * another order's task.
 */
export const ORDER_KEY_JS = `function orderKeyAfterSubmit(outcome, currentKey, freshKey) {
  if (outcome === 'created' || outcome === 'deduplicated') return freshKey;
  return currentKey;
}
function freshOrderKey() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'order-' + window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] + 256).toString(16).slice(1);
    return 'order-' + hex;
  } catch (error) {
    return 'order-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
  }
}`;

/** Shared DOM helpers embedded in both console scripts. */
/**
 * Shared browser helpers. Exported since Stage 4 so the immersive client
 * runtime builds its DOM through the SAME `el()` — the one that sets
 * `textContent` and never `innerHTML`, which is what keeps server-supplied
 * strings from becoming markup on any HQ page.
 */
export const DOM_HELPERS_JS = `function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function jsonExchange(promise) {
  return promise.then(function (response) {
    return response.json().then(
      function (body) { return { status: response.status, body: body }; },
      function () { return { status: response.status, body: null }; }
    );
  });
}
function postJson(path, payload) {
  return jsonExchange(fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  }));
}
// Stage 4: tell the client runtime that canonical state moved, so a page
// showing all of HQ re-READS it rather than patching itself from a response
// that describes one task. Optional by design — the control consoles ship on
// pages that have no runtime, and a missing hook must change nothing.
function notifyStateChanged() {
  if (typeof window.__hqStateChanged === 'function') {
    try { window.__hqStateChanged(); } catch (e) {}
  }
}`;

/**
 * Command Center: the Direct Order composer's live console.
 *
 * Static markup stays inert. This script asks `/session`; a granted
 * `directOrder` control builds a real composer (instruction, optional
 * project/title, route choice, Start Task) inside the mount; anything else
 * writes one truthful line about why nothing is drawn.
 */
export function directOrderConsoleScript(
  routePresentation: { ready: { label: string; tone: string }; blocked: { label: string; tone: string } },
): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-order-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${ORDER_KEY_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var ORDERS_PATH = ${jsonForScript(CONTROL_ROUTES.orders)};
  var ROUTE_READY = ${jsonForScript(routePresentation.ready)};
  var ROUTE_BLOCKED = ${jsonForScript(routePresentation.blocked)};

  // ROUTE AVAILABILITY IS A FACT, NOT A CONTROL (issue #230, Founder-gate
  // browser finding on the corrected head).
  //
  // The static route blocks above are rendered at SITE-BUILD time from
  // whatever provider facts the build machine happened to hold — on the
  // Founder workstation that means no \`CLAUDE_ROUTINE_*\`, so they read
  // "Blocked — not connected". The live verdicts were only ever drawn inside
  // the composer, and the composer is drawn only for a principal holding the
  // \`hq.direct_order\` originate grant. A Founder signed in to APPROVE — who
  // holds approval authority and no originate grant, exactly as the
  // no-self-approval rule intends — therefore saw the build-time claim and
  // nothing else, while /hq/connections.html showed the live truth. Two
  // Founder-facing pages, one real execution path, two answers: the same
  // defect class #226 closed on the Connections page, still open here.
  //
  // So the static blocks are corrected from the SAME \`/session\` routes field
  // the composer reads, for every resolved Founder, whatever they may or may
  // not originate. Whether CLAUDE can dispatch from this host does not depend
  // on who is looking at it.
  //
  // A response with no readable \`routes\` (an unauthenticated or non-Founder
  // session, an unreachable API) changes nothing: the build-time render stands
  // rather than being guessed at.
  function patchStaticRoutes(session) {
    if (session == null || typeof session !== 'object' || !Array.isArray(session.routes)) return;
    var blocks = document.querySelectorAll('[data-route]');
    for (var b = 0; b < blocks.length; b++) {
      (function (block) {
        var name = block.getAttribute('data-route');
        var found = null;
        for (var i = 0; i < session.routes.length; i++) {
          var entry = session.routes[i];
          if (entry && entry.requested === name) { found = entry; break; }
        }
        if (found == null || typeof found.reason !== 'string') return;
        var presentation = found.connected === true ? ROUTE_READY : ROUTE_BLOCKED;
        var chipMount = block.querySelector('[data-route-state-chip]');
        if (chipMount) {
          chipMount.textContent = '';
          var span = document.createElement('span');
          span.className = 'chip tone-' + presentation.tone;
          span.appendChild(document.createTextNode(presentation.label));
          chipMount.appendChild(span);
        }
        var reason = block.querySelector('[data-route-reason]');
        if (reason) reason.textContent = 'Live, from the same-origin control API just now: ' + found.reason;
        block.setAttribute('data-route-live-state', found.connected === true ? 'ready' : 'blocked');
      })(blocks[b]);
    }
  }

  // A bordered state panel, NOT another line of faint body text.
  //
  // This section is already dense with grey explanatory prose, and the console's
  // own verdict used to be set in the same 0.8rem faint style inside it. A
  // Founder scrolling Direct Order therefore read a real, specific refusal —
  // "no Referer, so the controls stay off" — as more static sample copy, and
  // reported the composer as simply absent (#219 correction round, the
  // Founder-workstation blocker on PR #225). The console must be legible about
  // whether it is live, checking, or off, and why.
  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session grants the composer\\u2026');
  note.setAttribute('data-order-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  function stayOff(reason) {
    note.setAttribute('data-order-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'DIRECT ORDER CONTROL IS OFF \\u2014 ' + reason +
      ' The static composer above remains read-only, and nothing on this page submits.';
  }

  function buildComposer(session) {
    note.setAttribute('data-order-console-state', 'granted');
    note.className = 'readonly-note console-state console-state-live';
    note.textContent = 'Live: this session is granted the direct-order control' +
      (typeof session.displayName === 'string' && session.displayName !== ''
        ? ' as ' + session.displayName + '.'
        : '.');

    var idempotencyKey = freshOrderKey();
    var box = el('div', 'panel order-live');
    box.setAttribute('data-order-console-form', '');

    var instructionLabel = el('p', 'order-label', 'Instruction');
    var instruction = document.createElement('textarea');
    instruction.rows = 4;
    instruction.setAttribute('aria-label', 'Order instruction');
    var projectLabel = el('p', 'order-label', 'Project (optional, a label only)');
    var project = document.createElement('input');
    project.type = 'text';
    project.setAttribute('aria-label', 'Project label');
    var titleLabel = el('p', 'order-label', 'Title (optional \\u2014 the one field published to the console)');
    var title = document.createElement('input');
    title.type = 'text';
    title.setAttribute('aria-label', 'Order title');

    var routeLabel = el('p', 'order-label', 'Route');
    var routeBox = el('div', 'order-live-routes');
    var resolutions = Array.isArray(session.routes) ? session.routes : null;
    var chosen = null;
    var routeNames = ['AUTO', 'CLAUDE', 'CODEX'];
    for (var i = 0; i < routeNames.length; i++) {
      (function (name) {
        var row = el('p', 'row');
        var found = null;
        if (resolutions) {
          for (var j = 0; j < resolutions.length; j++) {
            if (resolutions[j] && resolutions[j].requested === name) found = resolutions[j];
          }
        }
        var connected = found != null && found.connected === true;
        // EVERY route is offered now (issue #224). It used to be that a
        // disconnected route was stated but not selectable, because the server
        // would certainly refuse it and a control that cannot work is a control
        // pretending to work. The server no longer refuses: a valid order is
        // recorded and reported BLOCKED, so refusing to offer it here would be
        // the browser withholding the very flow the correction exists to give
        // the Founder — and only API and CLI callers would benefit.
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'hq-order-route';
        radio.value = name;
        radio.id = 'hq-order-route-' + name;
        radio.addEventListener('change', function () { chosen = name; });
        var label = document.createElement('label');
        label.setAttribute('for', radio.id);
        if (found == null) {
          label.textContent = name + ' \\u2014 availability was not evaluated by this server; the order is recorded either way, and no provider is ever substituted.';
        } else if (connected) {
          label.textContent = name + ' \\u2014 ' + found.reason;
        } else {
          row.className = 'row order-route-blocked';
          label.textContent = name + ' \\u2014 NOT CONNECTED: the order will be RECORDED and BLOCKED, not started. ' + found.reason;
        }
        row.appendChild(radio);
        row.appendChild(label);
        routeBox.appendChild(row);
      })(routeNames[i]);
    }

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = 'Start Task';
    submit.className = 'order-live-submit';
    var outcome = el('p', 'muted', 'Every order lands in needs_approval and executes nothing until a Founder approves that exact action digest.');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    outcome.setAttribute('data-order-console-outcome', '');

    submit.addEventListener('click', function () {
      var text = instruction.value.trim();
      if (text === '') {
        outcome.textContent = 'An order needs an instruction. Nothing was sent.';
        return;
      }
      if (chosen == null) {
        outcome.textContent = 'Choose a route first. Nothing was sent.';
        return;
      }
      submit.disabled = true;
      outcome.textContent = 'Submitting\\u2026';
      var payload = { instruction: text, route: chosen, idempotencyKey: idempotencyKey };
      if (project.value.trim() !== '') payload.project = project.value.trim();
      if (title.value.trim() !== '') payload.title = title.value.trim();
      postJson(ORDERS_PATH, payload)
        .then(function (result) {
          submit.disabled = false;
          var body = result.body || {};
          if (body.ok === true) {
            var kind = body.deduplicated === true ? 'deduplicated' : 'created';
            idempotencyKey = orderKeyAfterSubmit(kind, idempotencyKey, freshOrderKey());
            // A recorded-but-blocked order must READ as blocked. Reporting only
            // the resolved route printed an arrow to null and called it an
            // ordinary pending approval, which is neither the binding the API
            // returned nor the state the Founder needs to see.
            var bound = body.boundProvider ? String(body.boundProvider) : null;
            var routeLine = (body.route && body.route.requested) +
              (bound ? ' \\u2192 ' + bound : '');
            var blockedNote = body.dispatchBlocked === true
              ? ' BLOCKED \\u2014 NOT CONNECTED: it is recorded and gated, but ' + (bound || 'its provider') +
                ' cannot dispatch from here yet, so nothing is running. It stays this exact task and ' +
                'becomes ready once the provider is reachable.'
              : '';
            outcome.textContent = kind === 'created'
              ? 'Order created as task ' + body.taskId + ' (risk ' + body.riskClass + ', route ' +
                routeLine + '). It awaits Founder approval and executes nothing until then.' + blockedNote
              : 'This exact order already exists as task ' + body.taskId +
                ' \\u2014 deduplicated; no second task was created.' + blockedNote;
            notifyStateChanged();
            return;
          }
          var error = body.error || {};
          var line = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
            (error.message || 'no detail was given') +
            ' Nothing was created, and no other provider was substituted.';
          if (Array.isArray(body.route)) {
            for (var k = 0; k < body.route.length; k++) {
              var candidateVerdict = body.route[k];
              if (candidateVerdict && typeof candidateVerdict.reason === 'string') {
                line += ' [' + candidateVerdict.provider + ': ' + candidateVerdict.reason + ']';
              }
            }
          }
          outcome.textContent = line;
        })
        .catch(function (error) {
          submit.disabled = false;
          outcome.textContent = 'The order could not be submitted (' + error.message +
            '). Retrying keeps the same idempotency key, so a retry cannot create a duplicate task.';
        });
    });

    box.appendChild(instructionLabel);
    box.appendChild(instruction);
    box.appendChild(projectLabel);
    box.appendChild(project);
    box.appendChild(titleLabel);
    box.appendChild(title);
    box.appendChild(routeLabel);
    box.appendChild(routeBox);
    box.appendChild(submit);
    box.appendChild(outcome);
    mount.appendChild(box);
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      // BEFORE the grant branch, and outside it: the route verdicts are the
      // same facts whether or not this session may originate an order.
      patchStaticRoutes(result.body);
      var grant = grantedControls(result.body);
      if (grant.directOrder) buildComposer(result.body);
      else stayOff(grant.reason);
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Mission Core: the Founder Command composer and the mission list (Phase 3,
 * issue #253).
 *
 * Same rules as the two consoles beside it, and worth restating because this
 * one carries more Founder-typed text than either:
 *
 * - Static markup stays inert; the composer, the list and the cancel control
 *   exist only as DOM nodes created after `/session` granted `founderCommand`
 *   (composer) or `cancelMission` (cancel). Reading the list needs a Founder
 *   session and nothing more; a refused read states why and draws nothing.
 * - Nothing is invented. The list renders what `GET /missions` returned —
 *   derived status, normalized intent, plan, decisions, evidence links —
 *   through `textContent`. There is no progress bar, no ETA, no worker
 *   figure, no cost, because HQ measures none of them and the server sends
 *   none. A mission with no tasks in flight reads as exactly that.
 * - The RAW command never comes back. The server publishes the normalized
 *   intent plus the command's digest and length; the composer's own textarea
 *   is cleared after a confirmed outcome and is never echoed into the list.
 * - Five explicit states, drawn as words: checking, off (with the server's
 *   reason), empty ("no mission is recorded" — HQ holding nothing, not a
 *   loading failure), error/offline ("could not be read"), and live.
 * - The idempotency key rotates only after a confirmed outcome, so a retry
 *   after a network failure cannot create a second mission.
 */
export function missionConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-mission-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${ORDER_KEY_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var MISSIONS_PATH = ${jsonForScript(CONTROL_ROUTES.missions)};
  var MISSION_CANCEL_PATH = ${jsonForScript(CONTROL_ROUTES.missionCancel)};
  var PRIORITIES = ['p0', 'p1', 'p2', 'p3'];

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session may command and read missions\\u2026');
  note.setAttribute('data-mission-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var listMount = el('div', 'mission-list');
  listMount.setAttribute('data-mission-list', '');
  listMount.setAttribute('data-mission-list-state', 'checking');

  function stayOff(reason) {
    note.setAttribute('data-mission-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'MISSION CONTROLS ARE OFF \\u2014 ' + reason +
      ' Nothing on this page issues a command, and no mission is drawn from a guess.';
  }

  function toneFor(status) {
    if (status === 'blocked' || status === 'ready_review' || status === 'failed') return 'warn';
    if (status === 'working') return 'info';
    if (status === 'complete' || status === 'verified') return 'accent';
    return 'neutral';
  }

  function chip(label, tone) { return el('span', 'chip tone-' + tone, label); }

  function listLine(label, values) {
    var p = el('p', 'faint');
    p.appendChild(el('b', null, label + ': '));
    p.appendChild(document.createTextNode(values.length > 0 ? values.join(' \\u00b7 ') : 'none recorded'));
    return p;
  }

  function taskNode(task) {
    var li = el('li', 'hq-occupant');
    li.setAttribute('data-mission-task', task.id);
    li.appendChild(el('b', null, task.title));
    var row = el('p', 'row');
    row.appendChild(chip(task.state, task.state === 'blocked' || task.state === 'failed' || task.state === 'needs_approval' ? 'warn' : task.state === 'completed' ? 'accent' : 'neutral'));
    row.appendChild(chip('risk ' + task.riskClass, task.requiresFounderApproval === true ? 'warn' : 'neutral'));
    if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) row.appendChild(chip('after ' + task.dependsOn.join(', '), 'neutral'));
    if (task.execution && task.execution.stale === true) row.appendChild(chip('execution STALE: intent moved on', 'danger'));
    li.appendChild(row);
    li.appendChild(el('p', 'faint', task.summary));
    if (task.execution) {
      li.appendChild(el('p', 'faint', 'Canonical task ' + task.execution.taskId + ' \\u00b7 ' + task.execution.capabilityId +
        ' \\u00b7 status ' + task.execution.status + (task.execution.blockReason ? ' \\u00b7 ' + task.execution.blockReason : '')));
    } else {
      li.appendChild(el('p', 'faint', 'No canonical work opened yet. Nothing is running for this task.'));
    }
    return li;
  }

  function decisionNode(decision) {
    var li = el('li', 'hq-occupant');
    li.setAttribute('data-mission-decision', decision.id);
    li.appendChild(el('b', null, decision.kind === 'founder_gate' ? 'Founder hard gate' : 'Ambiguity'));
    var row = el('p', 'row');
    row.appendChild(chip(decision.status, decision.status === 'open' ? 'warn' : 'accent'));
    li.appendChild(row);
    li.appendChild(el('p', 'faint', decision.question));
    if (decision.status === 'resolved') li.appendChild(el('p', 'faint', 'Resolved by ' + decision.resolvedBy + ': ' + decision.resolution));
    return li;
  }

  function missionCard(mission, grant, refresh) {
    var card = el('article', 'card mission-card');
    card.setAttribute('data-mission', mission.id);
    card.setAttribute('data-mission-status', mission.status);
    var head = el('p', 'row-between');
    head.appendChild(el('b', null, mission.title));
    var chips = el('span', 'row');
    chips.appendChild(chip(mission.status, toneFor(mission.status)));
    chips.appendChild(chip(mission.priority, 'neutral'));
    chips.appendChild(chip('risk ceiling ' + mission.riskCeiling, 'neutral'));
    head.appendChild(chips);
    card.appendChild(head);
    card.appendChild(el('p', 'muted', 'Objective (as HQ understood it): ' + mission.intent.objective));
    if (mission.blockReason) card.appendChild(el('p', 'order-route-blocked', 'BLOCKED \\u2014 ' + mission.blockReason));
    card.appendChild(listLine('Do not', mission.intent.doNot));
    card.appendChild(listLine('Constraints', mission.intent.constraints));
    card.appendChild(listLine('Scope', mission.intent.scope));
    card.appendChild(listLine('Unknown', mission.intent.unknowns));
    card.appendChild(el('p', 'faint',
      'Origin: Founder command by ' + mission.createdBy + ' (' + mission.actorAuthentication + '), ' +
      mission.commandLength + ' characters, digest ' + String(mission.commandDigest).slice(0, 16) + '\\u2026 \\u2014 the command text stays server-side. ' +
      'Intent v' + mission.intentVersion + ' (digest ' + String(mission.intentDigest).slice(0, 16) + '\\u2026), planned by ' + mission.planner +
      ', created ' + mission.createdAt + ', updated ' + mission.updatedAt + '.'));

    var tasksHead = el('p', 'order-label', 'Plan \\u2014 ' + mission.tasks.length + ' task(s), in dependency order');
    card.appendChild(tasksHead);
    var tasks = el('ul', 'hq-occupants');
    for (var t = 0; t < mission.tasks.length; t++) tasks.appendChild(taskNode(mission.tasks[t]));
    card.appendChild(tasks);

    var open = 0;
    for (var d = 0; d < mission.decisions.length; d++) if (mission.decisions[d].status === 'open') open += 1;
    card.appendChild(el('p', 'order-label', 'Founder decisions \\u2014 ' + open + ' open of ' + mission.decisions.length));
    if (mission.decisions.length > 0) {
      var decisions = el('ul', 'hq-occupants');
      for (var k = 0; k < mission.decisions.length; k++) decisions.appendChild(decisionNode(mission.decisions[k]));
      card.appendChild(decisions);
    } else {
      card.appendChild(el('p', 'faint', 'No decision is waiting on you for this mission.'));
    }

    if (Array.isArray(mission.evidenceRefs) && mission.evidenceRefs.length > 0) {
      var refsHead = el('p', 'order-label', 'Evidence');
      card.appendChild(refsHead);
      var refs = el('ul', 'hq-occupants');
      for (var r = 0; r < mission.evidenceRefs.length; r++) {
        var li = el('li', null);
        var a = document.createElement('a');
        a.href = mission.evidenceRefs[r];
        a.rel = 'noopener noreferrer';
        a.textContent = mission.evidenceRefs[r];
        li.appendChild(a);
        refs.appendChild(li);
      }
      card.appendChild(refs);
    } else {
      card.appendChild(el('p', 'faint', 'No evidence link has been submitted on this mission yet.'));
    }

    if (mission.outcome) {
      card.appendChild(el('p', 'muted', 'Outcome: ' + mission.outcome.decision + ' by ' + mission.outcome.by + ' at ' + mission.outcome.at +
        (mission.outcome.note ? ' \\u2014 ' + mission.outcome.note : '')));
    }

    if (grant.cancelMission && mission.lifecycle === 'open') {
      var reasonLabel = el('p', 'order-label', 'Cancel this mission (a reason is required and recorded)');
      var reason = document.createElement('input');
      reason.type = 'text';
      reason.setAttribute('aria-label', 'Cancellation reason for ' + mission.title);
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'order-live-submit';
      cancel.textContent = 'Cancel mission';
      cancel.setAttribute('data-mission-cancel', mission.id);
      var outcome = el('p', 'muted', '');
      outcome.setAttribute('role', 'status');
      outcome.setAttribute('aria-live', 'polite');
      outcome.setAttribute('data-mission-cancel-outcome', '');
      cancel.addEventListener('click', function () {
        var text = reason.value.trim();
        if (text === '') { outcome.textContent = 'A cancellation needs a reason. Nothing was sent.'; return; }
        cancel.disabled = true;
        outcome.textContent = 'Cancelling\\u2026';
        postJson(MISSION_CANCEL_PATH, { missionId: mission.id, reason: text, expectedIntentVersion: mission.intentVersion })
          .then(function (result) {
            var body = result.body || {};
            if (body.ok === true) {
              outcome.textContent = 'Mission ' + body.missionId + ' is now ' + body.status + '.';
              notifyStateChanged();
              refresh();
              return;
            }
            cancel.disabled = false;
            var error = body.error || {};
            outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given') +
              (error.code === 'stale_intent_version' ? ' The list is re-read now.' : '');
            if (error.code === 'stale_intent_version') refresh();
          })
          .catch(function (error) {
            cancel.disabled = false;
            outcome.textContent = 'The cancellation could not be sent (' + error.message + '). Nothing changed.';
          });
      });
      card.appendChild(reasonLabel);
      card.appendChild(reason);
      card.appendChild(cancel);
      card.appendChild(outcome);
    }
    return card;
  }

  function renderList(body, grant, refresh) {
    listMount.textContent = '';
    if (body == null || typeof body !== 'object' || body.ok !== true || !Array.isArray(body.missions)) {
      listMount.setAttribute('data-mission-list-state', 'error');
      listMount.appendChild(el('p', 'readonly-note console-state console-state-off',
        'The mission list could not be read as a complete document, so no mission is drawn. This is not a report that HQ holds none.'));
      return;
    }
    if (body.missions.length === 0) {
      listMount.setAttribute('data-mission-list-state', 'empty');
      listMount.appendChild(el('p', 'readonly-note',
        'No Founder mission is recorded. HQ is holding nothing here \\u2014 this is an empty HQ, not a loading failure.'));
      return;
    }
    listMount.setAttribute('data-mission-list-state', 'live');
    listMount.appendChild(el('p', 'faint', body.missions.length + ' mission(s) recorded \\u00b7 as of ' + body.generatedAt + ' \\u00b7 ' + body.provenance));
    for (var i = 0; i < body.missions.length; i++) listMount.appendChild(missionCard(body.missions[i], grant, refresh));
  }

  function refreshWith(grant) {
    return function refresh() {
      listMount.setAttribute('data-mission-list-state', 'checking');
      jsonExchange(fetch(MISSIONS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' }))
        .then(function (result) {
          if (result.status !== 200) {
            listMount.textContent = '';
            listMount.setAttribute('data-mission-list-state', result.status === 401 || result.status === 403 ? 'unauthorized' : 'error');
            var error = (result.body && result.body.error) || {};
            listMount.appendChild(el('p', 'readonly-note console-state console-state-off',
              (result.status === 401 || result.status === 403 ? 'This session may not read missions' : 'The mission list could not be read') +
              ' (' + (error.code || ('HTTP ' + result.status)) + '). No mission is drawn from a guess.'));
            return;
          }
          renderList(result.body, grant, refresh);
        })
        .catch(function (error) {
          listMount.textContent = '';
          listMount.setAttribute('data-mission-list-state', 'offline');
          listMount.appendChild(el('p', 'readonly-note console-state console-state-off',
            'The HQ control API could not be reached (' + error.message + '), so no mission is drawn and nothing here is claimed to be current.'));
        });
    };
  }

  function buildComposer(session, grant, refresh) {
    var idempotencyKey = freshOrderKey();
    var box = el('div', 'panel order-live');
    box.setAttribute('data-mission-console-form', '');
    var instructionLabel = el('p', 'order-label', 'Founder command (stays server-side; HQ shows what it understood)');
    var instruction = document.createElement('textarea');
    instruction.rows = 4;
    instruction.setAttribute('aria-label', 'Founder command');
    var titleLabel = el('p', 'order-label', 'Title (optional \\u2014 the one free-text field published to the console)');
    var title = document.createElement('input');
    title.type = 'text';
    title.setAttribute('aria-label', 'Mission title');
    var projectLabel = el('p', 'order-label', 'Project (optional, a label only)');
    var project = document.createElement('input');
    project.type = 'text';
    project.setAttribute('aria-label', 'Mission project');
    var productLabel = el('p', 'order-label', 'Product (optional, a label only)');
    var product = document.createElement('input');
    product.type = 'text';
    product.setAttribute('aria-label', 'Mission product');
    var priorityLabel = el('p', 'order-label', 'Priority');
    var priority = document.createElement('select');
    priority.setAttribute('aria-label', 'Mission priority');
    for (var p = 0; p < PRIORITIES.length; p++) {
      var option = document.createElement('option');
      option.value = PRIORITIES[p];
      option.textContent = PRIORITIES[p];
      if (PRIORITIES[p] === 'p2') option.selected = true;
      priority.appendChild(option);
    }
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Issue Founder Command';
    var outcome = el('p', 'muted', 'A command becomes a mission with a locked goal, explicit do-not rules and a dependency-ordered plan. It executes nothing: each task becomes work only through the ordinary gated task path.');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    outcome.setAttribute('data-mission-console-outcome', '');

    submit.addEventListener('click', function () {
      var text = instruction.value.trim();
      if (text === '') { outcome.textContent = 'A Founder command needs an instruction. Nothing was sent.'; return; }
      submit.disabled = true;
      outcome.textContent = 'Submitting\\u2026';
      var payload = { instruction: text, priority: priority.value, idempotencyKey: idempotencyKey };
      if (title.value.trim() !== '') payload.title = title.value.trim();
      if (project.value.trim() !== '') payload.project = project.value.trim();
      if (product.value.trim() !== '') payload.product = product.value.trim();
      postJson(MISSIONS_PATH, payload)
        .then(function (result) {
          submit.disabled = false;
          var body = result.body || {};
          if (body.ok === true) {
            var kind = body.deduplicated === true ? 'deduplicated' : 'created';
            idempotencyKey = orderKeyAfterSubmit(kind, idempotencyKey, freshOrderKey());
            var mission = body.mission || {};
            var openDecisions = 0;
            if (mission.decisions) for (var i = 0; i < mission.decisions.length; i++) if (mission.decisions[i].status === 'open') openDecisions += 1;
            outcome.textContent = (kind === 'created'
              ? 'Mission ' + body.missionId + ' created, status ' + body.status + '.'
              : 'This exact command already exists as mission ' + body.missionId + ' \\u2014 deduplicated; no second mission was created.') +
              ' HQ understood the objective as: \\u201c' + (mission.intent ? mission.intent.objective : '') + '\\u201d, with ' +
              (mission.intent ? mission.intent.doNot.length : 0) + ' do-not rule(s), ' + (mission.tasks ? mission.tasks.length : 0) + ' planned task(s) and ' +
              openDecisions + ' decision(s) needing you.' + (openDecisions > 0 ? ' It is BLOCKED until you decide them; nothing plans around a Founder gate.' : '');
            if (kind === 'created') instruction.value = '';
            notifyStateChanged();
            refresh();
            return;
          }
          var error = body.error || {};
          outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given') + ' Nothing was created.';
        })
        .catch(function (error) {
          submit.disabled = false;
          outcome.textContent = 'The command could not be submitted (' + error.message +
            '). Retrying keeps the same idempotency key, so a retry cannot create a duplicate mission.';
        });
    });

    box.appendChild(instructionLabel);
    box.appendChild(instruction);
    box.appendChild(titleLabel);
    box.appendChild(title);
    box.appendChild(projectLabel);
    box.appendChild(project);
    box.appendChild(productLabel);
    box.appendChild(product);
    box.appendChild(priorityLabel);
    box.appendChild(priority);
    box.appendChild(submit);
    box.appendChild(outcome);
    mount.appendChild(box);
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      var grant = grantedControls(result.body);
      var session = result.body;
      var founder = session != null && typeof session === 'object' && session.ok === true && session.founder === true;
      if (!founder) {
        stayOff(grant.reason);
        listMount.setAttribute('data-mission-list-state', 'unauthorized');
        listMount.appendChild(el('p', 'readonly-note', 'Missions are read only by a resolved Founder session, so none is listed here.'));
        mount.appendChild(listMount);
        return;
      }
      var refresh = refreshWith(grant);
      if (grant.founderCommand) {
        note.setAttribute('data-mission-console-state', 'granted');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: this session may issue Founder Commands' +
          (typeof session.displayName === 'string' && session.displayName !== '' ? ' as ' + session.displayName + '.' : '.');
        buildComposer(session, grant, refresh);
      } else {
        stayOff(grant.reason);
      }
      mount.appendChild(listMount);
      refresh();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      listMount.setAttribute('data-mission-list-state', 'offline');
      listMount.appendChild(el('p', 'readonly-note', 'No mission is drawn while the control API is unreachable.'));
      mount.appendChild(listMount);
    });
})();
</script>`;
}

/**
 * Founder Approvals: the live decision console.
 *
 * Asks `/session`; with `approve` or `deny` granted it fetches the live
 * pending approvals from the control API and draws real decision controls
 * per card — Approve only where the card itself does not name the acting
 * principal as creator (the no-self-approval rule refuses that server-side,
 * so no button is drawn that would only ever fail), a step-up password field
 * exactly where the card says a fresh credential will be demanded, and Deny
 * with its required reason. Every decision echoes the card's action digest,
 * so what is approved is the exact rendered action.
 */
export function approvalsConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-approvals-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var APPROVALS_PATH = ${jsonForScript(CONTROL_ROUTES.approvals)};
  var APPROVE_PATH = ${jsonForScript(CONTROL_ROUTES.approve)};
  var DENY_PATH = ${jsonForScript(CONTROL_ROUTES.deny)};

  // Same treatment as the Direct Order console, for the same reason: the
  // console's verdict must not read as more static prose.
  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session grants decision controls\\u2026');
  note.setAttribute('data-approvals-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  function stayOff(reason) {
    note.setAttribute('data-approvals-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'DECISION CONTROLS ARE OFF \\u2014 ' + reason +
      ' The cards below remain read-only, and nothing on this page submits.';
  }

  function decisionCard(card, grant) {
    var box = el('article', 'card');
    box.setAttribute('data-live-approval', card.taskId);
    box.appendChild(el('h3', null, card.title || card.taskId));
    box.appendChild(el('p', 'muted', card.ask));
    box.appendChild(el('p', 'faint',
      card.taskId + ' \\u00b7 ' + card.capabilityId + ' \\u00b7 risk ' + card.riskClass +
      ' \\u00b7 raised by ' + card.createdBy));
    var digestLine = el('p', 'faint', 'Action digest: ' + String(card.actionDigest).slice(0, 16) + '\\u2026 \\u2014 the decision binds to exactly this action.');
    box.appendChild(digestLine);

    // A recorded order whose provider cannot dispatch is shown as BLOCKED, not
    // as an ordinary pending approval. It is still approvable — approving it is
    // what makes it ready the moment the provider is back — so this states the
    // situation rather than disabling the decision.
    if (card.dispatchBlocked === true) {
      box.appendChild(el('p', 'order-route-blocked',
        'BLOCKED \\u2014 NOT CONNECTED: this order is recorded and gated, but its provider ' +
        'cannot dispatch from here yet. Approving it changes nothing until the provider is ' +
        'reachable; nothing is running.'));
    }

    var status = el('p', 'muted', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('data-live-approval-outcome', '');

    var stepUp = null;
    if (card.stepUpRequired === true) {
      var stepUpLabel = el('p', 'order-label', 'Step-up: this risk class demands a fresh credential. Re-enter your JENIFY OS password to approve.');
      stepUp = document.createElement('input');
      stepUp.type = 'password';
      stepUp.autocomplete = 'current-password';
      stepUp.setAttribute('aria-label', 'Step-up password');
      box.appendChild(stepUpLabel);
      box.appendChild(stepUp);
    }

    function settle(result, verb) {
      var body = result.body || {};
      if (body.ok === true) {
        status.textContent = verb + ': task ' + body.taskId + ' is now ' + body.status + '.';
        var controls = box.querySelectorAll('button, input, textarea');
        for (var i = 0; i < controls.length; i++) controls[i].disabled = true;
        if (stepUp) stepUp.value = '';
        notifyStateChanged();
        return;
      }
      var error = body.error || {};
      status.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
        (error.message || 'no detail was given') + ' Nothing was decided.';
    }

    if (grant.approve) {
      if (card.selfApproval === true) {
        box.appendChild(el('p', 'faint',
          'No Approve control is drawn: the no-self-approval rule refuses the creator of an order, and that is you.'));
      } else {
        var noteLabel = el('p', 'order-label', 'Approval note (optional, stored permanently)');
        var noteInput = document.createElement('input');
        noteInput.type = 'text';
        noteInput.setAttribute('aria-label', 'Approval note');
        var approveButton = document.createElement('button');
        approveButton.type = 'button';
        approveButton.textContent = 'Approve';
        approveButton.addEventListener('click', function () {
          approveButton.disabled = true;
          status.textContent = 'Submitting approval\\u2026';
          var payload = { taskId: card.taskId, expectedActionDigest: card.actionDigest };
          if (noteInput.value.trim() !== '') payload.note = noteInput.value.trim();
          if (stepUp && stepUp.value !== '') payload.stepUpPassword = stepUp.value;
          postJson(APPROVE_PATH, payload)
            .then(function (result) { approveButton.disabled = false; settle(result, 'Approved'); })
            .catch(function (error) {
              approveButton.disabled = false;
              status.textContent = 'The approval could not be submitted (' + error.message + '). Nothing was decided.';
            });
        });
        box.appendChild(noteLabel);
        box.appendChild(noteInput);
        box.appendChild(approveButton);
      }
    } else {
      box.appendChild(el('p', 'faint', 'No Approve control is drawn: this session does not hold the approve grant.'));
    }

    if (grant.deny) {
      var reasonLabel = el('p', 'order-label', 'Denial reason (required \\u2014 recorded immutably)');
      var reasonInput = document.createElement('input');
      reasonInput.type = 'text';
      reasonInput.setAttribute('aria-label', 'Denial reason');
      var denyButton = document.createElement('button');
      denyButton.type = 'button';
      denyButton.textContent = 'Deny';
      denyButton.addEventListener('click', function () {
        if (reasonInput.value.trim() === '') {
          status.textContent = 'A denial needs a reason. Nothing was sent.';
          return;
        }
        denyButton.disabled = true;
        status.textContent = 'Submitting denial\\u2026';
        postJson(DENY_PATH, {
          taskId: card.taskId,
          expectedActionDigest: card.actionDigest,
          reason: reasonInput.value.trim()
        })
          .then(function (result) { denyButton.disabled = false; settle(result, 'Denied'); })
          .catch(function (error) {
            denyButton.disabled = false;
            status.textContent = 'The denial could not be submitted (' + error.message + '). Nothing was decided.';
          });
      });
      box.appendChild(reasonLabel);
      box.appendChild(reasonInput);
      box.appendChild(denyButton);
    } else {
      box.appendChild(el('p', 'faint', 'No Deny control is drawn: this session does not hold the deny grant.'));
    }

    box.appendChild(status);
    return box;
  }

  function buildConsole(grant) {
    note.setAttribute('data-approvals-console-state', 'granted');
    note.className = 'readonly-note console-state console-state-live';
    note.textContent = 'Live decision console \\u2014 pending approvals fetched from the control API, not from this page\\u2019s build-time bundle.';
    jsonExchange(fetch(APPROVALS_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.approvals)) {
          stayOff('the live approvals list could not be read (' +
            ((body.error && body.error.code) || ('HTTP ' + result.status)) + ').');
          return;
        }
        if (body.approvals.length === 0) {
          mount.appendChild(el('p', 'muted', 'No approval is pending in the live queue right now.'));
          return;
        }
        var grid = el('div', 'grid grid-wide');
        for (var i = 0; i < body.approvals.length; i++) {
          grid.appendChild(decisionCard(body.approvals[i], grant));
        }
        mount.appendChild(grid);
      })
      .catch(function (error) {
        stayOff('the live approvals list is not reachable (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      var grant = grantedControls(result.body);
      if (grant.approve || grant.deny) buildConsole(grant);
      else stayOff(grant.reason);
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Connection Center: CLAUDE's live dispatch truth (issue #226, correction
 * round on #225 — "two Founder-facing pages contradicting each other about
 * the same real execution path").
 *
 * ## The defect this closes
 *
 * The `anthropic-claude` card on this page is otherwise rendered ENTIRELY at
 * site-build time by `live/connections.assessConnections`, which asks the
 * routing dispatch contract whether `CLAUDE_ROUTINE_URL`/`CLAUDE_ROUTINE_TOKEN`
 * are present. Those are GitHub Actions workflow secrets, deliberately absent
 * on the Founder workstation, where CLAUDE actually dispatches through the
 * authenticated `gh` transport instead
 * (`providers/claude/dispatch-availability.ts`). The build-time render
 * therefore said CLAUDE was NOT CONNECTED on this page while the SAME
 * transport observation, reused by `control-api.ts` as `dispatchAvailability`,
 * already told the Command Center composer CLAUDE was dispatchable — two
 * Founder-facing pages disagreeing about the same real execution path.
 *
 * ## Why this reads `/session`'s `routes`, and invents nothing of its own
 *
 * `GET /api/hq/control/session` already returns, for every resolved Founder,
 * `routes: DIRECT_ORDER_ROUTES.map(route => resolveOrderRoute(route,
 * secretsEnv, { providerDispatchable: deps.dispatchAvailability }))` — the
 * EXACT seam the Command Center composer already reads to decide whether the
 * CLAUDE radio is offered as connected. Reading the SAME field here, rather
 * than adding a second endpoint or re-deriving a transport observation
 * client-side, is what makes it structurally impossible for the two pages to
 * disagree: they read one server computation, not two.
 *
 * `resolveOrderRoute` already carries the null-fallback this script relies
 * on: when a host has no live transport observation for CLAUDE
 * (`dispatchAvailability` returns null — a static preview, CI, or a host with
 * no `gh` at all), its `connected` verdict falls back to the same
 * routing-contract fact-presence check the build-time render already used, so
 * this script's patch is then a same-truth no-op rather than an invented
 * connection (issue #226 test: "unknown dispatch availability never invents
 * a connected status").
 *
 * ## What it never does
 *
 * It touches ONE card (`anthropic-claude`) and the KPI tiles that count
 * connection states. Every other catalogue row — Codex included — is left
 * exactly as the static build rendered it: this correction is scoped to the
 * demonstrated CLAUDE defect, never a general "trust the browser" rule. An
 * unreachable control API (a static preview, a host with HQ control off, or a
 * genuine network failure) leaves the build-time card exactly as it was.
 */
export function connectionsLiveScript(
  dispatchable: { label: string; tone: string },
  notConnected: { label: string; tone: string },
): string {
  return `<script>
(function () {
  if (typeof window.fetch !== 'function') return;
  var card = document.querySelector('[data-connection="anthropic-claude"]');
  if (!card) return;
  var chipMount = card.querySelector('[data-connection-state-chip]');
  var reasonEl = card.querySelector('[data-connection-reason]');
  if (!chipMount || !reasonEl) return;

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var DISPATCHABLE = ${jsonForScript(dispatchable)};
  var NOT_CONNECTED = ${jsonForScript(notConnected)};

  function setChip(presentation) {
    chipMount.textContent = '';
    var span = document.createElement('span');
    span.className = 'chip tone-' + presentation.tone;
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    span.appendChild(dot);
    span.appendChild(document.createTextNode(presentation.label));
    chipMount.appendChild(span);
  }

  // Recomputed from every card's effective state rather than adjusted by
  // delta, so the KPI row is always a true tally of what is actually drawn —
  // self-correcting whatever the CLAUDE card's build-time state happened to
  // be, with no assumption about which single bucket it came from.
  function recomputeKpis() {
    var buckets = { connected: 0, dispatchable: 0, configured: 0, setup_required: 0, not_connected: 0, error: 0 };
    var cards = document.querySelectorAll('[data-connection]');
    for (var i = 0; i < cards.length; i++) {
      var state = cards[i].getAttribute('data-connection-live-state') || cards[i].getAttribute('data-connection-static-state');
      if (state && Object.prototype.hasOwnProperty.call(buckets, state)) buckets[state] += 1;
    }
    for (var key in buckets) {
      if (!Object.prototype.hasOwnProperty.call(buckets, key)) continue;
      var tile = document.querySelector('[data-kpi="' + key + '"] .kpi-value');
      if (tile) tile.textContent = String(buckets[key]);
    }
  }

  fetch(SESSION_PATH, { headers: { accept: 'application/json' } })
    .then(function (response) { return response.json(); })
    .then(function (session) {
      if (session == null || typeof session !== 'object' || !Array.isArray(session.routes)) return;
      var entry = null;
      for (var i = 0; i < session.routes.length; i++) {
        var candidate = session.routes[i];
        if (candidate && candidate.requested === 'CLAUDE') { entry = candidate; break; }
      }
      // An unreadable or absent CLAUDE entry is not this script's business to
      // interpret — the build-time card stands rather than being guessed at.
      if (entry == null || typeof entry.reason !== 'string') return;
      var live = entry.connected === true ? DISPATCHABLE : NOT_CONNECTED;
      setChip(live);
      reasonEl.textContent = 'Live, from the same-origin control API just now: ' + entry.reason;
      card.setAttribute('data-connection-live-state', entry.connected === true ? 'dispatchable' : 'not_connected');
      recomputeKpis();
    })
    .catch(function () {
      // The control API is not reachable from this page (a static preview, a
      // host with HQ control off, or genuinely offline) — the build-time card
      // stands, exactly as it did before this script existed.
    });
})();
</script>`;
}
