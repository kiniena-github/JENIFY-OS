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
import {
  MISSION_ALLOWED_TRANSITIONS,
  MISSION_NOTE_REQUIRED_TARGETS,
  MISSION_PRIORITIES,
} from '../contracts/mission.js';
import { deepFreeze } from '../contracts/freeze.js';

/**
 * The only paths any HQ page script may fetch, beside the freshness
 * snapshot. Exported so the tests can allow-list every `fetch(` in every
 * emitted page against it — that assertion is what makes invariant (1)
 * above load-bearing rather than a comment.
 */
export const CONTROL_FETCH_TARGETS: readonly string[] = deepFreeze([
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
  // Phase 3 (issue #254): the canonical mission surface.
  CONTROL_ROUTES.missions,
  CONTROL_ROUTES.missionTransition,
  CONTROL_ROUTES.missionAmend,
  // Phase 4 (issue #262): the project register, the mission-linkage writes
  // and the workforce surface.
  CONTROL_ROUTES.projects,
  CONTROL_ROUTES.projectTransition,
  CONTROL_ROUTES.projectUpdate,
  CONTROL_ROUTES.missionAssignProject,
  CONTROL_ROUTES.missionLinkPlanItem,
  CONTROL_ROUTES.workforce,
  CONTROL_ROUTES.workforceRoute,
  CONTROL_ROUTES.workforceAssign,
  // Phase 5 (issue #265): the company memory surface on archive.html. The
  // search/context reads exist on the API; this page filters the fetched
  // records locally instead of issuing per-keystroke requests.
  CONTROL_ROUTES.memory,
  // Phase 6 (issue #265): the orchestrate route on projects.html's mission
  // console — preview and apply, one POST path.
  CONTROL_ROUTES.missionOrchestrate,
  // Phase 7: the truth/evidence console on archive.html — the bounded read,
  // the parameterized entity read, and the record/verify/accept writes.
  CONTROL_ROUTES.truth,
  CONTROL_ROUTES.truthEntity,
  CONTROL_ROUTES.truthVerify,
  CONTROL_ROUTES.truthAccept,
  // Phase 9: the Mission Room collaboration console on projects.html — the
  // bounded session list, the per-mission room read, and the open/admit
  // writes. The context read exists on the API and is not fetched by a page.
  CONTROL_ROUTES.collaboration,
  CONTROL_ROUTES.collaborationRoom,
  CONTROL_ROUTES.collaborationAdmit,
  // Phase 10: the Chief of Staff console on index.html — the whole derived
  // briefing and the one Founder-gated write that records a receipt. The
  // inbox-only read exists on the API for a light poll and is not fetched by
  // a page (the briefing already carries it).
  CONTROL_ROUTES.commandCenter,
  CONTROL_ROUTES.commandCenterInbox,
  CONTROL_ROUTES.commandCenterBrief,
  // Phase 11: the unified search and Ask Jenify reads on index.html. Both are
  // GETs and neither joins the postJson allow-list, because the phase adds no
  // write at all.
  CONTROL_ROUTES.search,
  CONTROL_ROUTES.ask,
  // Phase 12: the Product Factory console on projects.html — the bounded
  // register read, the parameterized detail read, and the three writes
  // (register, lifecycle, artifact version). There is no fetch target for a
  // release, because there is no release route.
  CONTROL_ROUTES.products,
  CONTROL_ROUTES.productDetail,
  CONTROL_ROUTES.productLifecycle,
  CONTROL_ROUTES.productArtifacts,
]);

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
  var off = { directOrder: false, approve: false, deny: false, missionCommand: false, projectCommand: false, workforceAssign: false, memoryCommand: false, missionOrchestrate: false, truthRecord: false, truthVerify: false, truthAccept: false, collaborationCommand: false, founderBrief: false, productCommand: false, reason: '' };
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
    missionCommand: session.controls.missionCommand === true,
    projectCommand: session.controls.projectCommand === true,
    workforceAssign: session.controls.workforceAssign === true,
    memoryCommand: session.controls.memoryCommand === true,
    missionOrchestrate: session.controls.missionOrchestrate === true,
    truthRecord: session.controls.truthRecord === true,
    truthVerify: session.controls.truthVerify === true,
    truthAccept: session.controls.truthAccept === true,
    collaborationCommand: session.controls.collaborationCommand === true,
    founderBrief: session.controls.founderBrief === true,
    productCommand: session.controls.productCommand === true,
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

/**
 * Founder Command: the mission composer (Phase 3, issue #254).
 *
 * Static markup stays inert. This script asks `/session`; a granted
 * `missionCommand` control builds a real composer (title, objective, scope,
 * constraints, acceptance criteria, plan items, project, priority, optional
 * raw instruction) inside the mount; anything else writes one truthful line
 * about why nothing is drawn. The composer parses NOTHING: lists are the
 * lines the Founder typed, and an empty plan is honestly recorded server-side
 * as one needs-clarification item, never invented into a breakdown.
 */
export function missionCommandConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-mission-command-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${ORDER_KEY_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var MISSIONS_PATH = ${jsonForScript(CONTROL_ROUTES.missions)};
  var PRIORITIES = ${jsonForScript(MISSION_PRIORITIES)};

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session grants Founder Command\\u2026');
  note.setAttribute('data-mission-command-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  function stayOff(reason) {
    note.setAttribute('data-mission-command-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'FOUNDER COMMAND IS OFF \\u2014 ' + reason +
      ' Nothing on this page commands a mission.';
  }

  function lines(textarea) {
    var out = [];
    var raw = textarea.value.split('\\n');
    for (var i = 0; i < raw.length; i++) {
      var trimmed = raw[i].trim();
      if (trimmed !== '') out.push(trimmed);
    }
    return out;
  }

  function labelled(box, text, node, aria) {
    box.appendChild(el('p', 'order-label', text));
    node.setAttribute('aria-label', aria);
    box.appendChild(node);
    return node;
  }

  function buildComposer(session) {
    note.setAttribute('data-mission-command-state', 'granted');
    note.className = 'readonly-note console-state console-state-live';
    note.textContent = 'Live: this session is granted Founder Command' +
      (typeof session.displayName === 'string' && session.displayName !== ''
        ? ' as ' + session.displayName + '.'
        : '.');

    var idempotencyKey = freshOrderKey();
    var box = el('div', 'panel order-live');
    box.setAttribute('data-mission-command-form', '');

    var title = labelled(box, 'Mission title', document.createElement('input'), 'Mission title');
    title.type = 'text';
    var objective = labelled(box, 'Objective \\u2014 the destination this mission protects', document.createElement('textarea'), 'Mission objective');
    objective.rows = 2;
    var scope = labelled(box, 'Scope (optional)', document.createElement('input'), 'Mission scope');
    scope.type = 'text';
    var constraints = labelled(box, 'Constraints \\u2014 one do-not-do rule per line', document.createElement('textarea'), 'Mission constraints');
    constraints.rows = 3;
    var acceptance = labelled(box, 'Acceptance criteria \\u2014 one per line (leave empty to record: not yet decided)', document.createElement('textarea'), 'Acceptance criteria');
    acceptance.rows = 2;
    var plan = labelled(box, 'Plan items \\u2014 one per line (leave empty to record: task breakdown not yet decided)', document.createElement('textarea'), 'Plan items');
    plan.rows = 3;
    var project = labelled(box, 'Project (optional, a label only)', document.createElement('input'), 'Project label');
    project.type = 'text';

    var priority = document.createElement('select');
    var unstated = document.createElement('option');
    unstated.value = '';
    unstated.textContent = 'unstated \\u2014 no priority is recorded';
    priority.appendChild(unstated);
    for (var i = 0; i < PRIORITIES.length; i++) {
      var option = document.createElement('option');
      option.value = PRIORITIES[i];
      option.textContent = PRIORITIES[i];
      priority.appendChild(option);
    }
    labelled(box, 'Priority \\u2014 mission metadata only; the task queue stays strictly FIFO', priority, 'Mission priority');

    var instruction = labelled(box, 'Raw order (optional) \\u2014 preserved server-side in the immutable intent record; it never reaches a browser', document.createElement('textarea'), 'Raw Founder order');
    instruction.rows = 3;

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = 'Command Mission';
    submit.className = 'order-live-submit';
    var outcome = el('p', 'muted', 'Commanding a mission records canonical direction. It creates no task, dispatches nothing, and later-phase orchestration does not exist yet \\u2014 execution still goes through direct orders and Founder approval.');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    outcome.setAttribute('data-mission-command-outcome', '');

    submit.addEventListener('click', function () {
      var titleText = title.value.trim();
      var objectiveText = objective.value.trim();
      if (titleText === '' || objectiveText === '') {
        outcome.textContent = 'A mission needs a title and an objective. Nothing was sent.';
        return;
      }
      submit.disabled = true;
      outcome.textContent = 'Submitting\\u2026';
      var payload = { title: titleText, objective: objectiveText, idempotencyKey: idempotencyKey };
      if (scope.value.trim() !== '') payload.scope = scope.value.trim();
      if (project.value.trim() !== '') payload.project = project.value.trim();
      if (priority.value !== '') payload.priority = priority.value;
      if (instruction.value.trim() !== '') payload.instruction = instruction.value.trim();
      var constraintLines = lines(constraints);
      if (constraintLines.length > 0) payload.constraints = constraintLines;
      var acceptanceLines = lines(acceptance);
      if (acceptanceLines.length > 0) payload.acceptanceCriteria = acceptanceLines;
      var planLines = lines(plan);
      if (planLines.length > 0) payload.planItems = planLines;
      postJson(MISSIONS_PATH, payload)
        .then(function (result) {
          submit.disabled = false;
          var body = result.body || {};
          if (body.ok === true && body.mission) {
            var kind = body.deduplicated === true ? 'deduplicated' : 'created';
            idempotencyKey = orderKeyAfterSubmit(kind, idempotencyKey, freshOrderKey());
            var planCount = Array.isArray(body.mission.planItems) ? body.mission.planItems.length : 0;
            outcome.textContent = kind === 'created'
              ? 'Mission commanded as ' + body.mission.id + ' (status ' + body.mission.status +
                ', ' + planCount + ' plan item(s)). The full record is in the Mission Room. ' +
                'No task was created and nothing executes from it.'
              : 'This exact order is already commanded as ' + body.mission.id +
                ' \\u2014 deduplicated; no second mission was created.';
            notifyStateChanged();
            return;
          }
          var error = body.error || {};
          outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
            (error.message || 'no detail was given') + ' Nothing was created.';
          if (result.status === 401 || result.status === 403) {
            // Session/authorization loss: a live-looking composer must not
            // stay armed under it. Disarm every control and flip the banner
            // off; re-authenticating and reloading the page rebuilds it.
            var armed = box.querySelectorAll('input, textarea, select, button');
            for (var d = 0; d < armed.length; d++) armed[d].disabled = true;
            stayOff('the control API refused the command (' +
              (error.code || ('HTTP ' + result.status)) + ').');
          }
        })
        .catch(function (error) {
          submit.disabled = false;
          outcome.textContent = 'The command could not be submitted (' + error.message +
            '). Retrying keeps the same idempotency key, so a retry cannot create a duplicate mission.';
        });
    });

    box.appendChild(submit);
    box.appendChild(outcome);
    mount.appendChild(box);
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      var grant = grantedControls(result.body);
      if (grant.missionCommand) buildComposer(result.body);
      else stayOff(grant.reason);
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Mission Room console: the live mission list + detail + lifecycle controls
 * (Phase 3, issue #254).
 *
 * The LIST renders for any resolved Founder session (`GET /missions` is a
 * Founder-gated read); the transition/amend CONTROLS are drawn only when
 * `/session` granted `missionCommand`, and a transition button is drawn only
 * for a movement the canonical map allows from the mission's current status
 * — the UI never advertises a transition the server will refuse. Zero
 * missions renders as an explicit zero, never as blankness.
 */
export function missionsConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-missions-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var MISSIONS_PATH = ${jsonForScript(CONTROL_ROUTES.missions)};
  var TRANSITION_PATH = ${jsonForScript(CONTROL_ROUTES.missionTransition)};
  var AMEND_PATH = ${jsonForScript(CONTROL_ROUTES.missionAmend)};
  var PROJECTS_PATH = ${jsonForScript(CONTROL_ROUTES.projects)};
  var ORDERS_PATH = ${jsonForScript(CONTROL_ROUTES.orders)};
  var ASSIGN_PROJECT_PATH = ${jsonForScript(CONTROL_ROUTES.missionAssignProject)};
  var LINK_ITEM_PATH = ${jsonForScript(CONTROL_ROUTES.missionLinkPlanItem)};
  var ORCHESTRATE_PATH = ${jsonForScript(CONTROL_ROUTES.missionOrchestrate)};
  var ALLOWED = ${jsonForScript(MISSION_ALLOWED_TRANSITIONS)};
  var NOTE_REQUIRED = ${jsonForScript(MISSION_NOTE_REQUIRED_TARGETS)};

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read the mission record\\u2026');
  note.setAttribute('data-missions-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var listBox = el('div', 'missions-live');
  listBox.setAttribute('data-missions-list', '');
  mount.appendChild(listBox);

  function stayOff(reason) {
    // Safe/off clears the record BY CONSTRUCTION: once this session cannot
    // prove the mission read, previously rendered mission details (and their
    // still-wired controls) must not stay on screen under a banner saying
    // the record is unreadable (Opus second-pass finding on cee771f).
    listBox.textContent = '';
    note.setAttribute('data-missions-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'MISSION RECORD IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function recheckAfterWriteRefusal(status, error) {
    // A 401/403 on a lifecycle/amend write can mean session loss (wipe the
    // record) or a narrower loss (mutations or the capability turned off)
    // where the record stays legitimately readable. Never guess which:
    // re-ask /session, then let the read path decide — a refused read wipes
    // via stayOff, a granted read re-renders with the controls this session
    // still actually holds.
    jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        sessionAnswer = result.body;
        if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
          stayOff('the session no longer resolves to the Founder (a write was refused: ' +
            (error.code || ('HTTP ' + status)) + ')');
          return;
        }
        reload();
      })
      .catch(function (err) {
        stayOff('the HQ control API is not reachable from this page (' + err.message + ').');
      });
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  function renderList(missions, canCommand, reason, activeProjects) {
    listBox.textContent = '';
    if (!Array.isArray(missions)) return;
    if (missions.length === 0) {
      textLine(listBox, 'muted', 'HQ holds no commanded mission. 0 means 0 \\u2014 nothing is invented to fill this list.');
      return;
    }
    if (!canCommand) {
      textLine(listBox, 'readonly-note', 'Lifecycle controls are off for this session \\u2014 ' + reason);
    }
    for (var i = 0; i < missions.length; i++) {
      renderMission(missions[i], canCommand, activeProjects);
    }
  }

  function renderMission(mission, canCommand, activeProjects) {
    var card = el('article', 'panel mission-card');
    card.setAttribute('data-mission-card', mission.id);

    var head = el('p', 'row');
    head.appendChild(el('b', '', mission.title));
    var statusChip = el('span', 'chip', String(mission.status));
    statusChip.setAttribute('data-mission-status', String(mission.status));
    head.appendChild(statusChip);
    if (mission.priority) head.appendChild(el('span', 'chip', 'priority: ' + mission.priority));
    // Two DIFFERENT claims, worded apart (Phase 4): the canonical register
    // relationship versus the free-text label the order happened to carry.
    if (mission.projectName) head.appendChild(el('span', 'chip', 'project: ' + mission.projectName));
    if (mission.project) head.appendChild(el('span', 'chip', 'label: ' + mission.project));
    card.appendChild(head);

    textLine(card, 'faint', mission.id + ' \\u00b7 commanded by ' + mission.createdBy + ' \\u00b7 ' + mission.createdAt);
    textLine(card, '', 'Objective (current): ' + mission.objective);
    if (mission.scope) textLine(card, 'muted', 'Scope: ' + mission.scope);

    var constraints = Array.isArray(mission.constraints) ? mission.constraints : [];
    textLine(card, 'muted', constraints.length > 0
      ? 'Constraints (non-negotiable): ' + constraints.join(' \\u00b7 ')
      : 'Constraints: none were stated.');
    var acceptance = mission.acceptanceCriteria;
    textLine(card, 'muted', Array.isArray(acceptance) && acceptance.length > 0
      ? 'Acceptance criteria: ' + acceptance.join(' \\u00b7 ')
      : 'Acceptance criteria: not yet decided \\u2014 recorded as an explicit unknown, not guessed.');

    if (mission.blockReason) textLine(card, 'muted', 'BLOCKED \\u2014 ' + mission.blockReason);

    var items = Array.isArray(mission.planItems) ? mission.planItems : [];
    if (items.length === 0) {
      textLine(card, 'muted', 'Plan: no items are recorded.');
    } else {
      textLine(card, 'order-label', 'Task plan');
      var planList = document.createElement('ul');
      planList.className = 'timeline';
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var li = document.createElement('li');
        var itemLine = item.seq + '. ' + item.summary + ' \\u2014 ' + item.state;
        if (item.rawTaskStatus) itemLine += ' (task ' + item.taskId + ': ' + item.rawTaskStatus + ')';
        else if (item.kind === 'work' && !item.taskId && item.state !== 'superseded') itemLine += ' (no task exists for this item yet)';
        // Phase 6: spec PRESENCE (the payload stays server-side, like intent
        // bodies). An unlinked work item without one is truthfully not
        // actionable by the orchestrator.
        if (item.specCapabilityId) itemLine += ' [work spec: ' + item.specCapabilityId + ']';
        else if (item.kind === 'work' && !item.taskId && item.state !== 'superseded') itemLine += ' [no Founder work spec \\u2014 not orchestratable]';
        li.appendChild(el('span', '', itemLine));
        if (canCommand && item.kind === 'work' && !item.taskId && item.state !== 'superseded') {
          li.appendChild(planItemControls(mission, item));
        }
        planList.appendChild(li);
      }
      card.appendChild(planList);
    }

    if (currentGrant && currentGrant.missionOrchestrate === true) {
      card.appendChild(orchestrateControls(mission));
    }

    if (mission.verification) {
      textLine(card, 'muted', 'Verified by ' + mission.verification.by + ' at ' + mission.verification.at +
        ' \\u2014 recorded Founder decision, not independent machine verification: ' + mission.verification.note);
    }
    if (mission.authority) {
      textLine(card, 'faint', 'Authority truth: risk class ' + String(mission.authority.riskClass) +
        ', Founder-only origination, no approval row exists for commanding \\u2014 execution approvals stay at the task level.');
    }
    var history = Array.isArray(mission.intentHistory) ? mission.intentHistory : [];
    if (history.length > 0) {
      // The Founder Intent Lock, inspectable in-product (M3): every sequence
      // shows its STRUCTURED state — the immutable original (seq 0) clearly
      // distinguished from later amendments and from the CURRENT fields
      // above. The raw order text and amendment rationale stay server-side.
      textLine(card, 'order-label', 'Intent record (append-only; raw order text and rationale stay server-side)');
      var intentList = document.createElement('ul');
      intentList.className = 'timeline';
      intentList.setAttribute('data-mission-intents', mission.id);
      for (var s = 0; s < history.length; s++) {
        var entry = history[s];
        var li2 = document.createElement('li');
        var line = (entry.seq === 0
          ? 'ORIGINAL intent (seq 0, immutable)'
          : 'Amendment (seq ' + entry.seq + ')') +
          ' \\u2014 by ' + entry.actor + ' at ' + entry.at +
          ' \\u00b7 objective: ' + entry.objective;
        var entryConstraints = Array.isArray(entry.constraints) ? entry.constraints : [];
        line += entryConstraints.length > 0
          ? ' \\u00b7 constraints: ' + entryConstraints.join(' \\u00b7 ')
          : ' \\u00b7 constraints: none stated';
        var entryAcceptance = entry.acceptanceCriteria;
        line += Array.isArray(entryAcceptance) && entryAcceptance.length > 0
          ? ' \\u00b7 acceptance: ' + entryAcceptance.join(' \\u00b7 ')
          : ' \\u00b7 acceptance: recorded as unknown';
        li2.textContent = line;
        if (entry.seq === 0) li2.setAttribute('data-mission-original-intent', '');
        intentList.appendChild(li2);
      }
      card.appendChild(intentList);
    }

    if (canCommand && ALLOWED[mission.status] && ALLOWED[mission.status].length > 0) {
      var controls = el('div', 'decision-controls');
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Mission lifecycle controls');
      var noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.setAttribute('aria-label', 'Reason / note for the transition');
      noteInput.placeholder = 'note \\u2014 required for blocked, verified, failed, cancelled';
      var actionOutcome = el('p', 'muted', '');
      actionOutcome.setAttribute('role', 'status');
      actionOutcome.setAttribute('aria-live', 'polite');
      for (var t = 0; t < ALLOWED[mission.status].length; t++) {
        (function (target) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'order-live-submit';
          button.textContent = target === 'verified' ? 'verify \\u2014 record a Founder decision' : target;
          button.addEventListener('click', function () {
            var payload = { missionId: mission.id, to: target, expectedStatus: mission.status };
            var noteText = noteInput.value.trim();
            if (noteText !== '') payload.note = noteText;
            if (NOTE_REQUIRED.indexOf(target) !== -1 && noteText === '') {
              actionOutcome.textContent = 'Moving a mission to ' + target + ' requires a recorded note. Nothing was sent.';
              return;
            }
            button.disabled = true;
            actionOutcome.textContent = 'Submitting\\u2026';
            postJson(TRANSITION_PATH, payload).then(function (result) {
              button.disabled = false;
              var body = result.body || {};
              if (body.ok === true) { actionOutcome.textContent = 'Recorded.'; notifyStateChanged(); reload(); return; }
              var error = body.error || {};
              actionOutcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
                (error.message || 'no detail was given');
              if (result.status === 401 || result.status === 403) {
                recheckAfterWriteRefusal(result.status, error);
              }
            }).catch(function (error) {
              button.disabled = false;
              actionOutcome.textContent = 'Not submitted (' + error.message + ').';
            });
          });
          controls.appendChild(button);
        })(ALLOWED[mission.status][t]);
      }
      controls.appendChild(noteInput);
      card.appendChild(controls);
      card.appendChild(actionOutcome);

      var amendBox = el('div', 'order-field');
      textLine(amendBox, 'order-label', 'Amend intent (append-only \\u2014 the original order is never rewritten)');
      var rationale = document.createElement('textarea');
      rationale.rows = 2;
      rationale.setAttribute('aria-label', 'Amendment rationale');
      rationale.placeholder = 'why the direction changes (required; preserved server-side)';
      amendBox.appendChild(rationale);
      var newObjective = document.createElement('input');
      newObjective.type = 'text';
      newObjective.setAttribute('aria-label', 'New objective (optional)');
      newObjective.placeholder = 'new objective (optional)';
      amendBox.appendChild(newObjective);
      var addItems = document.createElement('textarea');
      addItems.rows = 2;
      addItems.setAttribute('aria-label', 'Plan items to add, one per line');
      addItems.placeholder = 'plan items to add, one per line (optional)';
      amendBox.appendChild(addItems);
      var amendSubmit = document.createElement('button');
      amendSubmit.type = 'button';
      amendSubmit.className = 'order-live-submit';
      amendSubmit.textContent = 'Amend mission';
      var amendOutcome = el('p', 'muted', '');
      amendOutcome.setAttribute('role', 'status');
      amendOutcome.setAttribute('aria-live', 'polite');
      amendSubmit.addEventListener('click', function () {
        var rationaleText = rationale.value.trim();
        if (rationaleText === '') {
          amendOutcome.textContent = 'An amendment needs its rationale. Nothing was sent.';
          return;
        }
        var payload = { missionId: mission.id, amendment: rationaleText };
        if (newObjective.value.trim() !== '') payload.objective = newObjective.value.trim();
        var addLines = [];
        var raw = addItems.value.split('\\n');
        for (var r = 0; r < raw.length; r++) { var trimmed = raw[r].trim(); if (trimmed !== '') addLines.push(trimmed); }
        if (addLines.length > 0) payload.addPlanItems = addLines;
        amendSubmit.disabled = true;
        amendOutcome.textContent = 'Submitting\\u2026';
        postJson(AMEND_PATH, payload).then(function (result) {
          amendSubmit.disabled = false;
          var body = result.body || {};
          if (body.ok === true) { amendOutcome.textContent = 'Amendment recorded.'; notifyStateChanged(); reload(); return; }
          var error = body.error || {};
          amendOutcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
            (error.message || 'no detail was given');
          if (result.status === 401 || result.status === 403) {
            recheckAfterWriteRefusal(result.status, error);
          }
        }).catch(function (error) {
          amendSubmit.disabled = false;
          amendOutcome.textContent = 'Not submitted (' + error.message + ').';
        });
      });
      amendBox.appendChild(amendSubmit);
      amendBox.appendChild(amendOutcome);
      card.appendChild(amendBox);

      // Phase 4: bind (or clear) the canonical mission -> project link. The
      // choices are REAL active register entries read from /projects just
      // now; an empty register offers nothing and says so.
      var assignBox = el('div', 'order-field');
      textLine(assignBox, 'order-label', 'Project assignment (canonical register link)');
      var projects = Array.isArray(activeProjects) ? activeProjects : [];
      if (projects.length === 0 && !mission.projectId) {
        textLine(assignBox, 'muted', 'No active project exists in the register, so there is nothing to assign to.');
      } else {
        var projectSelect = document.createElement('select');
        projectSelect.setAttribute('aria-label', 'Assign this mission to a project');
        var noneOption = document.createElement('option');
        noneOption.value = '';
        noneOption.textContent = mission.projectId ? '\\u2014 clear the assignment \\u2014' : '\\u2014 choose a project \\u2014';
        projectSelect.appendChild(noneOption);
        for (var pj = 0; pj < projects.length; pj++) {
          var option = document.createElement('option');
          option.value = projects[pj].id;
          option.textContent = projects[pj].name;
          if (mission.projectId === projects[pj].id) option.selected = true;
          projectSelect.appendChild(option);
        }
        var assignSubmit = document.createElement('button');
        assignSubmit.type = 'button';
        assignSubmit.className = 'order-live-submit';
        assignSubmit.textContent = 'Record assignment';
        var assignOutcome = el('p', 'muted', '');
        assignOutcome.setAttribute('role', 'status');
        assignOutcome.setAttribute('aria-live', 'polite');
        assignSubmit.addEventListener('click', function () {
          var chosen = projectSelect.value === '' ? null : projectSelect.value;
          if (chosen === (mission.projectId || null)) {
            assignOutcome.textContent = 'The assignment is already exactly that. Nothing was sent.';
            return;
          }
          assignSubmit.disabled = true;
          assignOutcome.textContent = 'Submitting\\u2026';
          postJson(ASSIGN_PROJECT_PATH, { missionId: mission.id, projectId: chosen }).then(function (result) {
            assignSubmit.disabled = false;
            var body = result.body || {};
            if (body.ok === true) { assignOutcome.textContent = 'Recorded.'; notifyStateChanged(); reload(); return; }
            var error = body.error || {};
            assignOutcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
              (error.message || 'no detail was given');
            if (result.status === 401 || result.status === 403) {
              recheckAfterWriteRefusal(result.status, error);
            }
          }).catch(function (error) {
            assignSubmit.disabled = false;
            assignOutcome.textContent = 'Not submitted (' + error.message + ').';
          });
        });
        assignBox.appendChild(projectSelect);
        assignBox.appendChild(assignSubmit);
        assignBox.appendChild(assignOutcome);
      }
      card.appendChild(assignBox);
    }

    listBox.appendChild(card);
  }

  // Phase 4: controls for an unlinked work item. Two explicit, truthful
  // paths and no third: LINK an existing task by its exact id, or CREATE a
  // task through the ordinary /orders route (full direct-order gating,
  // idempotency and approval flow \\u2014 the plan item summary only PREFILLS an
  // instruction draft the Founder still owns and edits) and then link the
  // returned id. The two steps stay two steps; a link refusal after a
  // created order is reported exactly, never papered over.
  function planItemControls(mission, item) {
    var box = el('div', 'order-field');
    var linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.setAttribute('aria-label', 'Task id to link to plan item ' + item.seq);
    linkInput.placeholder = 'existing task id';
    var linkButton = document.createElement('button');
    linkButton.type = 'button';
    linkButton.className = 'order-live-submit';
    linkButton.textContent = 'Link task';
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    function linkTask(taskId, after) {
      postJson(LINK_ITEM_PATH, { missionId: mission.id, planItemSeq: item.seq, taskId: taskId }).then(function (result) {
        var body = result.body || {};
        if (body.ok === true) { outcome.textContent = after || 'Linked.'; notifyStateChanged(); reload(); return; }
        var error = body.error || {};
        outcome.textContent = (after ? after + ' But the link was refused (' : 'Link refused (') +
          (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given') +
          (after ? ' Retry the link with task id ' + taskId + '.' : '');
        if (result.status === 401 || result.status === 403) {
          recheckAfterWriteRefusal(result.status, error);
        }
      }).catch(function (error) {
        outcome.textContent = 'The link was not submitted (' + error.message + ').' +
          (after ? ' ' + after + ' Retry the link with task id ' + taskId + '.' : '');
      });
    }
    linkButton.addEventListener('click', function () {
      var taskId = linkInput.value.trim();
      if (taskId === '') { outcome.textContent = 'A task id is required to link. Nothing was sent.'; return; }
      outcome.textContent = 'Linking\\u2026';
      linkTask(taskId, '');
    });
    box.appendChild(linkInput);
    box.appendChild(linkButton);

    var routes = (sessionAnswer && Array.isArray(sessionAnswer.routes)) ? sessionAnswer.routes : [];
    var granted = grantedControls(sessionAnswer);
    if (granted.directOrder && routes.length > 0) {
      var instruction = document.createElement('textarea');
      instruction.rows = 2;
      instruction.setAttribute('aria-label', 'Order instruction for plan item ' + item.seq);
      instruction.value = item.summary;
      var routeSelect = document.createElement('select');
      routeSelect.setAttribute('aria-label', 'Route for the new order');
      for (var r = 0; r < routes.length; r++) {
        var routeOption = document.createElement('option');
        routeOption.value = String(routes[r].requested);
        routeOption.textContent = String(routes[r].requested) + (routes[r].connected === true ? '' : ' (not connected)');
        routeSelect.appendChild(routeOption);
      }
      var createButton = document.createElement('button');
      createButton.type = 'button';
      createButton.className = 'order-live-submit';
      createButton.textContent = 'Create task via direct order, then link';
      createButton.addEventListener('click', function () {
        var text = instruction.value.trim();
        if (text === '') { outcome.textContent = 'The order needs an instruction. Nothing was sent.'; return; }
        createButton.disabled = true;
        outcome.textContent = 'Creating the order\\u2026';
        postJson(ORDERS_PATH, { instruction: text, route: routeSelect.value, title: 'Plan item ' + item.seq + ': ' + item.summary }).then(function (result) {
          createButton.disabled = false;
          var body = result.body || {};
          if (body.ok !== true || typeof body.taskId !== 'string') {
            var error = body.error || {};
            outcome.textContent = 'The order was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
              (error.message || 'no detail was given') + ' Nothing was linked.';
            if (result.status === 401 || result.status === 403) {
              recheckAfterWriteRefusal(result.status, error);
            }
            return;
          }
          linkTask(body.taskId, 'Task ' + body.taskId + ' was created' + (body.deduplicated === true ? ' (deduplicated)' : '') + '.');
        }).catch(function (error) {
          createButton.disabled = false;
          outcome.textContent = 'The order was not submitted (' + error.message + '). Nothing was linked.';
        });
      });
      box.appendChild(instruction);
      box.appendChild(routeSelect);
      box.appendChild(createButton);
    }
    box.appendChild(outcome);
    return box;
  }

  var sessionAnswer = null;
  var currentGrant = null;

  // Phase 6: the orchestration panel — preview derives the cycle truthfully,
  // apply creates real gated tasks through the canonical origination path.
  // Apply demands STEP-UP (the first mission-state -> execution write), so a
  // password field appears with it; a stale preview fingerprint refuses.
  function orchestrateControls(mission) {
    var box = el('div', 'order-field');
    box.setAttribute('data-mission-orchestrate', mission.id);
    textLine(box, 'order-label', 'Orchestration \\u2014 preview shows what a cycle would do; apply creates real tasks that still pass every canonical gate. Nothing is approved, claimed or transitioned by orchestration.');
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    var fingerprint = null;
    var previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'order-live-submit';
    previewButton.textContent = 'Preview cycle';
    var applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'order-live-submit';
    applyButton.textContent = 'Apply cycle';
    applyButton.disabled = true;
    var stepUpLabel = el('p', 'order-label', 'Step-up: applying turns mission state into real gated tasks, so it demands a fresh credential. Re-enter your JENIFY OS password.');
    var stepUp = document.createElement('input');
    stepUp.type = 'password';
    stepUp.autocomplete = 'current-password';
    stepUp.setAttribute('aria-label', 'Step-up password for orchestrate apply');

    function describeReport(report, prefix) {
      var lines = [];
      var decisions = Array.isArray(report.decisions) ? report.decisions : [];
      for (var d = 0; d < decisions.length; d++) {
        var entry = decisions[d];
        var lineText = 'item ' + entry.planItemSeq + ': ' + entry.decision;
        if (entry.detail && entry.detail.taskId) lineText += ' (task ' + entry.detail.taskId + ')';
        if (entry.detail && entry.detail.capabilityId && !entry.detail.taskId) lineText += ' (' + entry.detail.capabilityId + ')';
        lines.push(lineText);
      }
      var state = report.state || {};
      var counts = state.planItems || {};
      var summary = prefix + ' ' + lines.join(' \\u00b7 ') +
        ' \\u2014 plan: ' + counts.linked + '/' + (counts.workSpecified + counts.workUnspecified) + ' work item(s) linked, ' +
        counts.workUnspecified + ' unspecified.';
      if (state.recommendation === 'ready_review') {
        summary += ' Derived recommendation: ready_review \\u2014 a recommendation only; nothing transitions without the Founder.';
      }
      if (state.killSwitch && (state.killSwitch.global || state.killSwitch.orchestrate)) {
        summary += ' KILL SWITCH ENGAGED \\u2014 apply is refused while it holds.';
      }
      outcome.textContent = summary;
    }

    previewButton.addEventListener('click', function () {
      previewButton.disabled = true;
      outcome.textContent = 'Previewing\\u2026';
      postJson(ORCHESTRATE_PATH, { missionId: mission.id, mode: 'preview' }).then(function (result) {
        previewButton.disabled = false;
        var body = result.body || {};
        if (body.ok !== true || body.report == null) {
          var error = body.error || {};
          outcome.textContent = 'Preview refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
          if (result.status === 401 || result.status === 403) recheckAfterWriteRefusal(result.status, error);
          return;
        }
        fingerprint = body.report.fingerprint || null;
        applyButton.disabled = false;
        describeReport(body.report, 'Preview \\u2014');
      }).catch(function (error) {
        previewButton.disabled = false;
        outcome.textContent = 'Not previewed (' + error.message + ').';
      });
    });

    applyButton.addEventListener('click', function () {
      var payload = { missionId: mission.id, mode: 'apply' };
      if (fingerprint) payload.fingerprint = fingerprint;
      if (stepUp.value !== '') payload.stepUpPassword = stepUp.value;
      applyButton.disabled = true;
      outcome.textContent = 'Applying\\u2026';
      postJson(ORCHESTRATE_PATH, payload).then(function (result) {
        applyButton.disabled = false;
        stepUp.value = '';
        var body = result.body || {};
        if (body.ok !== true || body.report == null) {
          var error = body.error || {};
          outcome.textContent = 'Apply refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
          if (result.status === 401 || result.status === 403) recheckAfterWriteRefusal(result.status, error);
          return;
        }
        describeReport(body.report, 'Applied \\u2014');
        notifyStateChanged();
        reload();
      }).catch(function (error) {
        applyButton.disabled = false;
        outcome.textContent = 'Not applied (' + error.message + ').';
      });
    });

    box.appendChild(previewButton);
    box.appendChild(stepUpLabel);
    box.appendChild(stepUp);
    box.appendChild(applyButton);
    box.appendChild(outcome);
    return box;
  }

  function reload() {
    jsonExchange(fetch(MISSIONS_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.missions)) {
          var error = body.error || {};
          stayOff('the mission read was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
            (error.message || 'no detail was given'));
          return;
        }
        var grant = grantedControls(sessionAnswer);
        currentGrant = grant;
        note.setAttribute('data-missions-console-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + body.missions.length + ' commanded mission(s), from the canonical record just now.';
        if (!grant.missionCommand) {
          renderList(body.missions, false, grant.reason, []);
          return;
        }
        // The assignment select needs the REAL register. A failed project
        // read degrades to no choices — never to invented ones — and the
        // missions still render.
        jsonExchange(fetch(PROJECTS_PATH, { headers: { accept: 'application/json' } }))
          .then(function (projectsResult) {
            var projectsBody = projectsResult.body || {};
            var active = [];
            if (projectsBody.ok === true && Array.isArray(projectsBody.projects)) {
              for (var p = 0; p < projectsBody.projects.length; p++) {
                if (projectsBody.projects[p].status === 'active') active.push(projectsBody.projects[p]);
              }
            }
            renderList(body.missions, true, grant.reason, active);
          })
          .catch(function () {
            renderList(body.missions, true, grant.reason, []);
          });
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        var grant = grantedControls(result.body);
        stayOff(grant.reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}


/**
 * Projects page: the canonical Project register console (Phase 4).
 *
 * Static markup stays inert. This script asks `/session`; any resolved
 * Founder gets the live register READ; the create/close/reopen/update
 * controls are built only under a granted `projectCommand`. Authorization
 * loss is honest in both directions, exactly like the mission console:
 * safe/off clears every rendered register row by construction, and a
 * 401/403 on a write re-asks /session and lets the read path decide.
 */
export function projectsConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-projects-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var PROJECTS_PATH = ${jsonForScript(CONTROL_ROUTES.projects)};
  var TRANSITION_PATH = ${jsonForScript(CONTROL_ROUTES.projectTransition)};
  var UPDATE_PATH = ${jsonForScript(CONTROL_ROUTES.projectUpdate)};

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read the project register\\u2026');
  note.setAttribute('data-projects-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var listBox = el('div', 'projects-live');
  listBox.setAttribute('data-projects-list', '');
  mount.appendChild(listBox);

  function stayOff(reason) {
    // Safe/off clears the record BY CONSTRUCTION (the mission-console rule).
    listBox.textContent = '';
    note.setAttribute('data-projects-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'PROJECT REGISTER IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function recheckAfterWriteRefusal(status, error) {
    jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        sessionAnswer = result.body;
        if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
          stayOff('the session no longer resolves to the Founder (a write was refused: ' +
            (error.code || ('HTTP ' + status)) + ')');
          return;
        }
        reload();
      })
      .catch(function (err) {
        stayOff('the HQ control API is not reachable from this page (' + err.message + ').');
      });
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  function handleWrite(path, payload, button, outcome, successText) {
    button.disabled = true;
    outcome.textContent = 'Submitting\\u2026';
    postJson(path, payload).then(function (result) {
      button.disabled = false;
      var body = result.body || {};
      if (body.ok === true) { outcome.textContent = successText; notifyStateChanged(); reload(); return; }
      var error = body.error || {};
      outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
        (error.message || 'no detail was given');
      if (result.status === 401 || result.status === 403) {
        recheckAfterWriteRefusal(result.status, error);
      }
    }).catch(function (error) {
      button.disabled = false;
      outcome.textContent = 'Not submitted (' + error.message + ').';
    });
  }

  function renderProject(project, canCommand) {
    var card = el('article', 'panel project-card');
    card.setAttribute('data-project-register-card', project.id);

    var head = el('p', 'row');
    head.appendChild(el('b', '', project.name));
    var statusChip = el('span', 'chip', String(project.status));
    statusChip.setAttribute('data-project-status', String(project.status));
    head.appendChild(statusChip);
    if (project.stream) head.appendChild(el('span', 'chip', project.stream));
    card.appendChild(head);

    textLine(card, 'faint', project.id + ' \\u00b7 registered by ' + (project.createdBy || 'not recorded (pre-Phase-4 row)') + ' \\u00b7 ' + project.createdAt);
    textLine(card, '', 'Purpose: ' + project.purpose);

    var missions = Array.isArray(project.missions) ? project.missions : [];
    if (missions.length === 0) {
      textLine(card, 'muted', 'Missions: none are assigned to this project. 0 means 0.');
    } else {
      textLine(card, 'order-label', 'Missions (canonical project_id relationship)');
      var missionList = document.createElement('ul');
      missionList.className = 'timeline';
      for (var m = 0; m < missions.length; m++) {
        var li = document.createElement('li');
        li.textContent = missions[m].title + ' \\u2014 ' + missions[m].status + ' (' + missions[m].missionId + ')';
        missionList.appendChild(li);
      }
      card.appendChild(missionList);
    }

    var counts = Array.isArray(project.taskCounts) ? project.taskCounts : [];
    if (counts.length > 0) {
      var parts = [];
      for (var c = 0; c < counts.length; c++) parts.push(counts[c].status + ': ' + counts[c].count);
      textLine(card, 'muted', 'Linked tasks by canonical status \\u2014 counts only, never a percentage: ' + parts.join(' \\u00b7 '));
    } else {
      textLine(card, 'muted', 'Linked tasks: none. No figure is invented for work that is not recorded.');
    }

    if (canCommand) {
      var controls = el('div', 'decision-controls');
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Project register controls');
      var noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.setAttribute('aria-label', 'Reason / note for closing or reopening');
      noteInput.placeholder = 'note \\u2014 required to close or reopen';
      var outcome = el('p', 'muted', '');
      outcome.setAttribute('role', 'status');
      outcome.setAttribute('aria-live', 'polite');
      var target = project.status === 'active' ? 'closed' : 'active';
      var moveButton = document.createElement('button');
      moveButton.type = 'button';
      moveButton.className = 'order-live-submit';
      moveButton.textContent = target === 'closed' ? 'close \\u2014 with a recorded reason' : 'reopen \\u2014 with a recorded reason';
      moveButton.addEventListener('click', function () {
        var noteText = noteInput.value.trim();
        if (noteText === '') {
          outcome.textContent = 'Moving a project to ' + target + ' requires a recorded note. Nothing was sent.';
          return;
        }
        handleWrite(TRANSITION_PATH, { projectId: project.id, to: target, note: noteText, expectedStatus: project.status }, moveButton, outcome, 'Recorded.');
      });
      controls.appendChild(moveButton);
      controls.appendChild(noteInput);
      card.appendChild(controls);

      if (project.status === 'active') {
        var editBox = el('div', 'order-field');
        textLine(editBox, 'order-label', 'Edit the register entry (audited \\u2014 the event log records what changed)');
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.setAttribute('aria-label', 'New name (optional)');
        nameInput.placeholder = 'new name (optional)';
        var purposeInput = document.createElement('input');
        purposeInput.type = 'text';
        purposeInput.setAttribute('aria-label', 'New purpose (optional)');
        purposeInput.placeholder = 'new purpose (optional)';
        var editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'order-live-submit';
        editButton.textContent = 'Update entry';
        editButton.addEventListener('click', function () {
          var payload = { projectId: project.id };
          if (nameInput.value.trim() !== '') payload.name = nameInput.value.trim();
          if (purposeInput.value.trim() !== '') payload.purpose = purposeInput.value.trim();
          if (payload.name == null && payload.purpose == null) {
            outcome.textContent = 'Nothing to update \\u2014 supply a new name or purpose. Nothing was sent.';
            return;
          }
          handleWrite(UPDATE_PATH, payload, editButton, outcome, 'Updated.');
        });
        editBox.appendChild(nameInput);
        editBox.appendChild(purposeInput);
        editBox.appendChild(editButton);
        card.appendChild(editBox);
      }
      card.appendChild(outcome);
    }

    listBox.appendChild(card);
  }

  function renderRegister(projects, canCommand, reason) {
    listBox.textContent = '';
    if (!Array.isArray(projects)) return;
    if (canCommand) {
      var createBox = el('div', 'order-field');
      createBox.setAttribute('data-project-create', '');
      textLine(createBox, 'order-label', 'Register a project');
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.setAttribute('aria-label', 'Project name');
      nameInput.placeholder = 'name (required)';
      var purposeInput = document.createElement('input');
      purposeInput.type = 'text';
      purposeInput.setAttribute('aria-label', 'Project purpose');
      purposeInput.placeholder = 'purpose (required)';
      var streamInput = document.createElement('input');
      streamInput.type = 'text';
      streamInput.setAttribute('aria-label', 'Stream label (optional)');
      streamInput.placeholder = 'stream label (optional)';
      var createButton = document.createElement('button');
      createButton.type = 'button';
      createButton.className = 'order-live-submit';
      createButton.textContent = 'Create register entry';
      var createOutcome = el('p', 'muted', '');
      createOutcome.setAttribute('role', 'status');
      createOutcome.setAttribute('aria-live', 'polite');
      createButton.addEventListener('click', function () {
        var name = nameInput.value.trim();
        var purpose = purposeInput.value.trim();
        if (name === '' || purpose === '') {
          createOutcome.textContent = 'A project needs a name and a purpose. Nothing was sent.';
          return;
        }
        var payload = { name: name, purpose: purpose };
        if (streamInput.value.trim() !== '') payload.stream = streamInput.value.trim();
        handleWrite(PROJECTS_PATH, payload, createButton, createOutcome, 'Registered.');
      });
      createBox.appendChild(nameInput);
      createBox.appendChild(purposeInput);
      createBox.appendChild(streamInput);
      createBox.appendChild(createButton);
      createBox.appendChild(createOutcome);
      listBox.appendChild(createBox);
    } else {
      textLine(listBox, 'readonly-note', 'Register controls are off for this session \\u2014 ' + reason);
    }
    if (projects.length === 0) {
      textLine(listBox, 'muted', 'HQ holds no registered project. 0 means 0 \\u2014 nothing is invented to fill this register.');
      return;
    }
    for (var i = 0; i < projects.length; i++) {
      renderProject(projects[i], canCommand);
    }
  }

  var sessionAnswer = null;
  function reload() {
    jsonExchange(fetch(PROJECTS_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.projects)) {
          var error = body.error || {};
          stayOff('the register read was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
            (error.message || 'no detail was given'));
          return;
        }
        var grant = grantedControls(sessionAnswer);
        note.setAttribute('data-projects-console-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + body.projects.length + ' registered project(s), from the canonical register just now.';
        renderRegister(body.projects, grant.projectCommand, grant.reason);
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        var grant = grantedControls(result.body);
        stayOff(grant.reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Specialist Directory page: the workforce truth console (Phase 4).
 *
 * Static markup stays inert. Any resolved Founder gets the live /workforce
 * READ — enforcement, transport and member truth with nothing inferred. The
 * eligibility and assignment controls are built only under a granted
 * `workforceAssign`. Assignment is ADVISORY and drawn as exactly that.
 */
export function workforceConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-workforce-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var WORKFORCE_PATH = ${jsonForScript(CONTROL_ROUTES.workforce)};
  var ROUTE_PATH = ${jsonForScript(CONTROL_ROUTES.workforceRoute)};
  var ASSIGN_PATH = ${jsonForScript(CONTROL_ROUTES.workforceAssign)};

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read the workforce record\\u2026');
  note.setAttribute('data-workforce-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var listBox = el('div', 'workforce-live');
  listBox.setAttribute('data-workforce-list', '');
  mount.appendChild(listBox);

  function stayOff(reason) {
    listBox.textContent = '';
    note.setAttribute('data-workforce-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'WORKFORCE RECORD IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function recheckAfterWriteRefusal(status, error) {
    jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        sessionAnswer = result.body;
        if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
          stayOff('the session no longer resolves to the Founder (a write was refused: ' +
            (error.code || ('HTTP ' + status)) + ')');
          return;
        }
        reload();
      })
      .catch(function (err) {
        stayOff('the HQ control API is not reachable from this page (' + err.message + ').');
      });
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  function renderWorkforce(body, canAssign, reason) {
    listBox.textContent = '';
    var workers = Array.isArray(body.workers) ? body.workers : [];
    if (workers.length === 0) {
      textLine(listBox, 'muted', 'No worker is registered in the canonical directory. 0 means 0.');
    }
    for (var i = 0; i < workers.length; i++) {
      var worker = workers[i];
      var card = el('article', 'panel workforce-card');
      card.setAttribute('data-workforce-card', worker.id);
      var head = el('p', 'row');
      head.appendChild(el('b', '', worker.displayName));
      head.appendChild(el('span', 'chip', worker.active ? 'active' : 'inactive'));
      head.appendChild(el('span', 'chip', String(worker.role)));
      card.appendChild(head);
      textLine(card, 'faint', worker.id + ' \\u00b7 vendor: ' + worker.vendor + ' \\u00b7 ' +
        (Array.isArray(worker.allowedCapabilities) ? worker.allowedCapabilities.length : 0) + ' granted capability(ies)');
      if (worker.providerDeclared) {
        var transportLine = 'Execution provider (declared): ' + worker.providerDeclared;
        if (worker.transport) {
          transportLine += ' \\u2014 ' + worker.transport.reason;
          if (worker.transport.dispatchable === true) transportLine += ' Dispatchable from this host.';
          else if (worker.transport.dispatchable === false) transportLine += ' NOT dispatchable from this host.';
          else transportLine += ' Dispatchability was not observed from this host.';
        }
        textLine(card, 'muted', transportLine);
      } else {
        textLine(card, 'muted', 'No execution provider is declared. The vendor name is who MAKES this worker, never an execution claim.');
      }
      if (worker.member) {
        textLine(card, 'muted', 'Member record: ' + worker.member.identityKey + ' \\u00b7 status ' + worker.member.status +
          ' \\u00b7 health ' + worker.member.health + (worker.member.healthCheckedAt ? ' (declared ' + worker.member.healthCheckedAt + ')' : ' (never declared)'));
      }
      listBox.appendChild(card);
    }
    var membersOnly = Array.isArray(body.membersNotEnrolledForExecution) ? body.membersNotEnrolledForExecution : [];
    if (membersOnly.length > 0) {
      textLine(listBox, 'order-label', 'Registered members NOT enrolled for execution (a registry row enrols nobody)');
      for (var mo = 0; mo < membersOnly.length; mo++) {
        textLine(listBox, 'muted', membersOnly[mo].displayName + ' \\u2014 ' + membersOnly[mo].identityKey +
          ' \\u00b7 status ' + membersOnly[mo].status + ' \\u00b7 health ' + membersOnly[mo].health);
      }
    }

    if (!canAssign) {
      textLine(listBox, 'readonly-note', 'Assignment controls are off for this session \\u2014 ' + reason);
      return;
    }
    var assignBox = el('div', 'order-field');
    assignBox.setAttribute('data-workforce-assign', '');
    textLine(assignBox, 'order-label', 'Advisory assignment \\u2014 narrows claiming only; the task still goes through policy, approval and review');
    var taskInput = document.createElement('input');
    taskInput.type = 'text';
    taskInput.setAttribute('aria-label', 'Task id');
    taskInput.placeholder = 'task id';
    var workerSelect = document.createElement('select');
    workerSelect.setAttribute('aria-label', 'Worker to assign');
    // Only workers the register marks active are offered. The server is the
    // authority either way (an inactive target is refused with
    // worker_not_assignable); the dropdown just stops offering what cannot
    // be accepted.
    var assignableWorkers = [];
    for (var w = 0; w < workers.length; w++) {
      if (workers[w].active === true) assignableWorkers.push(workers[w]);
    }
    for (var aw = 0; aw < assignableWorkers.length; aw++) {
      var option = document.createElement('option');
      option.value = assignableWorkers[aw].id;
      option.textContent = assignableWorkers[aw].displayName;
      workerSelect.appendChild(option);
    }
    if (assignableWorkers.length === 0) workerSelect.disabled = true;
    var rationaleInput = document.createElement('input');
    rationaleInput.type = 'text';
    rationaleInput.setAttribute('aria-label', 'Rationale (optional)');
    rationaleInput.placeholder = 'rationale (optional)';
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    var checkButton = document.createElement('button');
    checkButton.type = 'button';
    checkButton.className = 'order-live-submit';
    checkButton.textContent = 'Evaluate eligibility';
    checkButton.addEventListener('click', function () {
      var taskId = taskInput.value.trim();
      if (taskId === '') { outcome.textContent = 'A task id is required. Nothing was sent.'; return; }
      checkButton.disabled = true;
      outcome.textContent = 'Evaluating\\u2026';
      postJson(ROUTE_PATH, { taskId: taskId }).then(function (result) {
        checkButton.disabled = false;
        var body2 = result.body || {};
        if (body2.ok !== true || body2.report == null) {
          var error = body2.error || {};
          outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
          if (result.status === 401 || result.status === 403) recheckAfterWriteRefusal(result.status, error);
          return;
        }
        var lines = [];
        // Canonical task state first: when the write path would refuse the
        // assignment, say so before listing per-worker eligibility.
        var taskState = body2.report.taskState || {};
        var statePrefix = '';
        if (taskState.assignmentOpen === false) {
          statePrefix = 'ASSIGNMENT CLOSED \\u2014 ' + (taskState.reason || 'the task is not in an assignable state') + ' \\u00b7 ';
        }
        var reportWorkers = Array.isArray(body2.report.workers) ? body2.report.workers : [];
        for (var rw = 0; rw < reportWorkers.length; rw++) {
          var entry = reportWorkers[rw];
          var verdict = entry.eligible === true ? 'ELIGIBLE' : 'not eligible';
          var why = '';
          if (entry.eligible !== true) {
            if (entry.holdsCapability !== true) why = ' \\u2014 does not hold ' + body2.report.capabilityId;
            else if (entry.assignability && entry.assignability.assignable !== true) why = ' \\u2014 ' + String(entry.assignability.reason);
            else if (entry.denyReason) why = ' \\u2014 ' + entry.denyReason;
          }
          lines.push(entry.workerId + ': ' + verdict + why);
        }
        outcome.textContent = statePrefix + 'Eligibility for ' + body2.report.capabilityId + ' \\u2014 ' + lines.join(' \\u00b7 ');
      }).catch(function (error) {
        checkButton.disabled = false;
        outcome.textContent = 'Not evaluated (' + error.message + ').';
      });
    });
    var assignButton = document.createElement('button');
    assignButton.type = 'button';
    assignButton.className = 'order-live-submit';
    assignButton.textContent = 'Record advisory assignment';
    assignButton.addEventListener('click', function () {
      var taskId = taskInput.value.trim();
      if (taskId === '') { outcome.textContent = 'A task id is required. Nothing was sent.'; return; }
      var payload = { taskId: taskId, workerId: workerSelect.value };
      if (rationaleInput.value.trim() !== '') payload.rationale = rationaleInput.value.trim();
      assignButton.disabled = true;
      outcome.textContent = 'Submitting\\u2026';
      postJson(ASSIGN_PATH, payload).then(function (result) {
        assignButton.disabled = false;
        var body2 = result.body || {};
        if (body2.ok === true) {
          // Truthful because assignTask now refuses once a live claim exists
          // or the task can never return to the queue: success here means the
          // narrowing genuinely applies to future claiming.
          outcome.textContent = 'Advisory assignment recorded for ' + payload.workerId +
            '. The task status is unchanged; future claiming from the queue is narrowed to that worker.';
          notifyStateChanged();
          return;
        }
        var error = body2.error || {};
        outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
        if (result.status === 401 || result.status === 403) recheckAfterWriteRefusal(result.status, error);
      }).catch(function (error) {
        assignButton.disabled = false;
        outcome.textContent = 'Not submitted (' + error.message + ').';
      });
    });
    if (assignableWorkers.length === 0) {
      assignButton.disabled = true;
      textLine(assignBox, 'muted', 'No active worker can be offered \\u2014 every registered worker is marked inactive. Eligibility can still be evaluated.');
    }
    assignBox.appendChild(taskInput);
    assignBox.appendChild(workerSelect);
    assignBox.appendChild(rationaleInput);
    assignBox.appendChild(checkButton);
    assignBox.appendChild(assignButton);
    assignBox.appendChild(outcome);
    listBox.appendChild(assignBox);
  }

  var sessionAnswer = null;
  function reload() {
    jsonExchange(fetch(WORKFORCE_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.workers)) {
          var error = body.error || {};
          stayOff('the workforce read was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
            (error.message || 'no detail was given'));
          return;
        }
        var grant = grantedControls(sessionAnswer);
        note.setAttribute('data-workforce-console-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + body.workers.length + ' registered worker(s), from the canonical directory just now.' +
          (body.memberRegistryConfigured === true ? '' : ' No AI member registry is configured on this deployment \\u2014 stated, not guessed.');
        renderWorkforce(body, grant.workforceAssign, grant.reason);
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        var grant = grantedControls(result.body);
        stayOff(grant.reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Archive page: the Company Memory console (Phase 5, issue #265).
 *
 * Static markup stays inert. Any resolved Founder gets the live /memory
 * READ — every record with its provenance (recorded date + confidence +
 * source, recordedBy, entity links, supersede chain, derivation), rendered
 * via textContent only. The record form is built only under a granted
 * `memoryCommand`. Filtering is local and deterministic over the fetched
 * rows — no per-keystroke network, no semantic scoring, no invention.
 */
export function memoryConsoleScript(
  kinds: readonly string[],
  privacyLevels: readonly string[],
): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-memory-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var MEMORY_PATH = ${jsonForScript(CONTROL_ROUTES.memory)};
  var KINDS = ${jsonForScript(kinds)};
  var PRIVACY_LEVELS = ${jsonForScript(privacyLevels)};

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read company memory\\u2026');
  note.setAttribute('data-memory-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var listBox = el('div', 'memory-live');
  listBox.setAttribute('data-memory-list', '');
  mount.appendChild(listBox);

  function stayOff(reason) {
    listBox.textContent = '';
    note.setAttribute('data-memory-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'COMPANY MEMORY IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  // Local, deterministic filter: every space-separated token must appear in
  // the record's title/body/kind/project/tags (case-insensitive). Filtering
  // hides rows from view; it never re-ranks, scores or fetches.
  function matchesFilter(record, filterText) {
    var tokens = filterText.toLowerCase().split(/\\s+/).filter(function (t) { return t !== ''; });
    if (tokens.length === 0) return true;
    var haystack = (record.title + ' ' + record.body + ' ' + record.kind + ' ' + record.project + ' ' +
      (Array.isArray(record.tags) ? record.tags.join(' ') : '')).toLowerCase();
    for (var i = 0; i < tokens.length; i++) {
      if (haystack.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  }

  function renderRecords(records, filterText) {
    var cards = listBox.querySelector('[data-memory-cards]');
    if (!cards) return;
    cards.textContent = '';
    var shown = 0;
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!matchesFilter(record, filterText)) continue;
      shown++;
      var card = el('article', 'panel memory-card');
      card.setAttribute('data-memory-card', record.id);
      var head = el('p', 'row');
      head.appendChild(el('b', '', record.title));
      head.appendChild(el('span', 'chip', record.kind));
      head.appendChild(el('span', 'chip', record.status));
      if (record.privacy === 'founder_only') head.appendChild(el('span', 'chip', 'founder_only'));
      card.appendChild(head);
      textLine(card, 'faint', 'recorded ' + record.recorded.date + ' (' + record.recorded.confidence + ')' +
        (record.recorded.source ? ' via ' + record.recorded.source : '') + ' by ' + record.recordedBy +
        ' \\u00b7 project label: ' + record.project);
      textLine(card, 'muted', record.body);
      var links = [];
      if (record.missionId) links.push('mission ' + record.missionId);
      if (record.projectId) links.push('project ' + record.projectId);
      if (record.taskId) links.push('task ' + record.taskId);
      if (links.length > 0) textLine(card, 'muted', 'Linked to: ' + links.join(' \\u00b7 '));
      if (record.supersedes) textLine(card, 'faint', 'Supersedes ' + record.supersedes);
      if (Array.isArray(record.supersededBy) && record.supersededBy.length > 0) {
        textLine(card, 'faint', 'Superseded by ' + record.supersededBy.join(', '));
      }
      if (Array.isArray(record.derivedFrom) && record.derivedFrom.length > 0) {
        textLine(card, 'faint', 'SUMMARY \\u2014 derived from ' + record.derivedFrom.join(', ') +
          '; the originals are retained and this record never replaces them.');
      }
      if (Array.isArray(record.sourceRefs) && record.sourceRefs.length > 0) {
        textLine(card, 'faint', 'Sources (pointers, never copies): ' + record.sourceRefs.join(' \\u00b7 '));
      }
      cards.appendChild(card);
    }
    if (shown === 0) {
      textLine(cards, 'muted', records.length === 0
        ? 'HQ remembers nothing yet. 0 means 0 \\u2014 no demo memory is invented to fill this page.'
        : 'No record matches this filter. ' + records.length + ' record(s) exist unfiltered.');
    }
  }

  function buildRecordForm(reload) {
    var form = el('div', 'order-field');
    form.setAttribute('data-memory-record-form', '');
    textLine(form, 'order-label', 'Record company memory \\u2014 insert-only; changing a record means superseding it with a successor');
    var kindSelect = document.createElement('select');
    kindSelect.setAttribute('aria-label', 'Memory kind');
    for (var i = 0; i < KINDS.length; i++) {
      var option = document.createElement('option');
      option.value = KINDS[i];
      option.textContent = KINDS[i];
      kindSelect.appendChild(option);
    }
    var titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.setAttribute('aria-label', 'Title');
    titleInput.placeholder = 'title';
    var bodyInput = document.createElement('textarea');
    bodyInput.setAttribute('aria-label', 'Body');
    bodyInput.placeholder = 'what HQ should remember';
    var projectInput = document.createElement('input');
    projectInput.type = 'text';
    projectInput.setAttribute('aria-label', 'Project label (free text, never matched against the register)');
    projectInput.placeholder = 'project label';
    var missionInput = document.createElement('input');
    missionInput.type = 'text';
    missionInput.setAttribute('aria-label', 'Mission id (optional canonical link)');
    missionInput.placeholder = 'mission id (optional)';
    var tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.setAttribute('aria-label', 'Tags, comma separated (optional)');
    tagsInput.placeholder = 'tags, comma separated (optional)';
    var supersedesInput = document.createElement('input');
    supersedesInput.type = 'text';
    supersedesInput.setAttribute('aria-label', 'Supersedes record id (optional)');
    supersedesInput.placeholder = 'supersedes record id (optional)';
    var privacySelect = document.createElement('select');
    privacySelect.setAttribute('aria-label', 'Privacy');
    for (var p = 0; p < PRIVACY_LEVELS.length; p++) {
      var pOption = document.createElement('option');
      pOption.value = PRIVACY_LEVELS[p];
      pOption.textContent = PRIVACY_LEVELS[p];
      privacySelect.appendChild(pOption);
    }
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Record memory';
    submit.addEventListener('click', function () {
      var title = titleInput.value.trim();
      var bodyText = bodyInput.value.trim();
      var project = projectInput.value.trim();
      if (title === '' || bodyText === '' || project === '') {
        outcome.textContent = 'Title, body and project label are required. Nothing was sent.';
        return;
      }
      var payload = { kind: kindSelect.value, title: title, body: bodyText, project: project, privacy: privacySelect.value };
      if (missionInput.value.trim() !== '') payload.missionId = missionInput.value.trim();
      if (supersedesInput.value.trim() !== '') payload.supersedes = supersedesInput.value.trim();
      var tags = tagsInput.value.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return t !== ''; });
      if (tags.length > 0) payload.tags = tags;
      submit.disabled = true;
      outcome.textContent = 'Recording\\u2026';
      postJson(MEMORY_PATH, payload).then(function (result) {
        submit.disabled = false;
        var answer = result.body || {};
        if (answer.ok === true) {
          outcome.textContent = answer.deduplicated === true
            ? 'Already recorded \\u2014 this exact memory deduplicated onto the stored record.'
            : 'Recorded. The store is insert-only; this record can be superseded but never rewritten.';
          titleInput.value = ''; bodyInput.value = ''; supersedesInput.value = '';
          notifyStateChanged();
          reload();
          return;
        }
        var error = answer.error || {};
        outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
      }).catch(function (error) {
        submit.disabled = false;
        outcome.textContent = 'Not recorded (' + error.message + ').';
      });
    });
    form.appendChild(kindSelect);
    form.appendChild(titleInput);
    form.appendChild(bodyInput);
    form.appendChild(projectInput);
    form.appendChild(missionInput);
    form.appendChild(tagsInput);
    form.appendChild(supersedesInput);
    form.appendChild(privacySelect);
    form.appendChild(submit);
    form.appendChild(outcome);
    return form;
  }

  var sessionAnswer = null;
  function reload() {
    jsonExchange(fetch(MEMORY_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.records)) {
          var error = body.error || {};
          stayOff('the memory read was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' +
            (error.message || 'no detail was given'));
          return;
        }
        var records = body.records;
        var grant = grantedControls(sessionAnswer);
        note.setAttribute('data-memory-console-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + records.length + ' memory record(s), read from hq_memory just now. ' +
          'Superseded history is retained; a summary is a record that names its sources.';
        listBox.textContent = '';
        var filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.setAttribute('aria-label', 'Filter memory records');
        filterInput.placeholder = 'filter records (local, deterministic)';
        listBox.appendChild(filterInput);
        var cards = el('div', 'memory-cards');
        cards.setAttribute('data-memory-cards', '');
        listBox.appendChild(cards);
        filterInput.addEventListener('input', function () {
          renderRecords(records, filterInput.value);
        });
        renderRecords(records, '');
        if (grant.memoryCommand) {
          listBox.appendChild(buildRecordForm(reload));
        } else {
          textLine(listBox, 'readonly-note', 'The record form is off for this session \\u2014 ' + grant.reason);
        }
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        var grant = grantedControls(result.body);
        stayOff(grant.reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Archive page: the Truth + Evidence console (Phase 7).
 *
 * Static markup stays inert. Any resolved Founder gets the live /truth READ:
 * every record with its DERIVED categorical state, born state, lifecycle,
 * verification picture, contradictions (with their resolution, never a
 * winner by recency), evidence refs, verifications with limitations, and
 * acceptance provenance — rendered via textContent only. The unresolved
 * contradictions are listed FIRST, so no record is read without its dispute.
 * An entity lookup reads the parameterized entity route. The record, verify
 * and accept forms are built only under their respective granted controls;
 * accept carries the record's acceptance digest verbatim and a step-up
 * password field (never stored, never echoed).
 */
export function truthConsoleScript(vocabulary: {
  entityKinds: readonly string[];
  bornStates: readonly string[];
  methods: readonly string[];
  verdicts: readonly string[];
  privacyLevels: readonly string[];
}): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-truth-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var TRUTH_PATH = ${jsonForScript(CONTROL_ROUTES.truth)};
  var TRUTH_ENTITY_PATH = ${jsonForScript(CONTROL_ROUTES.truthEntity)};
  var TRUTH_VERIFY_PATH = ${jsonForScript(CONTROL_ROUTES.truthVerify)};
  var TRUTH_ACCEPT_PATH = ${jsonForScript(CONTROL_ROUTES.truthAccept)};
  var ENTITY_KINDS = ${jsonForScript(vocabulary.entityKinds)};
  var BORN_STATES = ${jsonForScript(vocabulary.bornStates)};
  var METHODS = ${jsonForScript(vocabulary.methods)};
  var VERDICTS = ${jsonForScript(vocabulary.verdicts)};
  var PRIVACY_LEVELS = ${jsonForScript(vocabulary.privacyLevels)};

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read the truth projection\\u2026');
  note.setAttribute('data-truth-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var box = el('div', 'memory-live truth-live');
  box.setAttribute('data-truth-list', '');
  mount.appendChild(box);

  function stayOff(reason) {
    box.textContent = '';
    note.setAttribute('data-truth-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'THE TRUTH PROJECTION IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }
  function textLine(parent, cls, text) { parent.appendChild(el('p', cls, text)); }
  function select(label, values) {
    var node = document.createElement('select');
    node.setAttribute('aria-label', label);
    for (var i = 0; i < values.length; i++) {
      var option = document.createElement('option');
      option.value = values[i];
      option.textContent = values[i];
      node.appendChild(option);
    }
    return node;
  }
  function input(label, placeholder) {
    var node = document.createElement('input');
    node.type = 'text';
    node.setAttribute('aria-label', label);
    node.placeholder = placeholder;
    return node;
  }
  function idList(text) {
    return text.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return t !== ''; });
  }

  function renderRecord(record) {
    var card = el('article', 'panel memory-card truth-card');
    card.setAttribute('data-truth-card', record.id);
    card.setAttribute('data-truth-state', record.state);
    card.setAttribute('data-truth-acceptance-standing', record.acceptanceStanding);
    var head = el('p', 'row');
    head.appendChild(el('b', '', record.statement));
    head.appendChild(el('span', 'chip', record.state.toUpperCase()));
    head.appendChild(el('span', 'chip', 'born ' + record.bornState));
    head.appendChild(el('span', 'chip', record.lifecycle));
    if (record.contested) head.appendChild(el('span', 'chip', 'CONTESTED'));
    if (record.acceptances.length > 0 && record.acceptanceStanding !== 'standing') head.appendChild(el('span', 'chip', 'ACCEPTANCE NO LONGER STANDS'));
    if (record.privacy === 'founder_only') head.appendChild(el('span', 'chip', 'founder_only'));
    card.appendChild(head);
    textLine(card, 'faint', 'About ' + record.entityKind + ' ' + record.entityId + ' \\u00b7 recorded ' + record.recordedAt +
      ' by ' + record.recordedBy + ' \\u00b7 id ' + record.id);
    textLine(card, 'muted', 'Verification: ' + record.verification + ' \\u00b7 subject drift: ' + record.subjectDrift +
      (record.acceptanceDigest ? ' \\u00b7 ACCEPTABLE (digest ' + record.acceptanceDigest + ')' : ''));
    textLine(card, 'faint', record.evidenceRefs.length > 0
      ? 'Evidence (op_evidence ids, referenced never copied): ' + record.evidenceRefs.join(' \\u00b7 ')
      : 'Evidence: none referenced \\u2014 this is a bare claim.');
    var i;
    for (i = 0; i < record.verifications.length; i++) {
      var v = record.verifications[i];
      textLine(card, 'muted', 'Verified ' + v.verdict.toUpperCase() + ' by ' + v.verifiedBy + ' at ' + v.at + ' via ' + v.method +
        ' \\u00b7 evidence ' + v.evidenceRefs.join(', ') + ' \\u00b7 limitations: ' + v.limitations);
    }
    for (i = 0; i < record.acceptances.length; i++) {
      var a = record.acceptances[i];
      textLine(card, 'muted', 'ACCEPTED by ' + a.acceptedBy + ' at ' + a.at + ' over verification(s) ' + a.verificationIds.join(', ') +
        ' \\u00b7 digest ' + a.digest + (a.note ? ' \\u00b7 note: ' + a.note : ''));
    }
    if (record.acceptances.length > 0 && record.acceptanceStanding !== 'standing') {
      textLine(card, 'muted', 'That acceptance no longer stands (' + record.acceptanceStanding + '): the record now derives ' + record.state.toUpperCase() +
        '. The acceptance above is immutable history \\u2014 nothing was erased, and nothing here re-accepts it.');
    }
    for (i = 0; i < record.contradictions.length; i++) {
      var c = record.contradictions[i];
      textLine(card, c.resolution === 'unresolved' ? 'muted' : 'faint',
        (c.direction === 'stated' ? 'Contradicts ' : 'Contradicted by ') + c.withId + ' \\u2014 ' + c.resolution +
        (c.resolution === 'unresolved' ? ' (neither side is preferred by recency)' : ''));
    }
    if (record.supersedes) textLine(card, 'faint', 'Supersedes ' + record.supersedes);
    if (record.supersededBy) textLine(card, 'faint', 'Superseded by ' + record.supersededBy + ' \\u2014 retained as history, never rewritten.');
    if (record.supports.length > 0) textLine(card, 'faint', 'Supports ' + record.supports.join(', '));
    if (record.supportedBy.length > 0) textLine(card, 'faint', 'Supported by ' + record.supportedBy.join(', '));
    if (record.derivedFrom.length > 0) textLine(card, 'faint', 'Derived from ' + record.derivedFrom.join(', '));
    return card;
  }

  function renderContradictions(parent, pairs) {
    var list = el('div', 'truth-contradictions');
    list.setAttribute('data-truth-contradictions', '');
    if (pairs.length === 0) {
      textLine(list, 'faint', 'No unresolved contradiction. 0 means 0.');
    } else {
      textLine(list, 'order-label', pairs.length + ' UNRESOLVED CONTRADICTION(S) \\u2014 HQ holds two current, unrefuted statements and picks neither');
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        textLine(list, 'muted', p.entityKind + ' ' + p.entityId + ': ' + p.a + ' contradicts ' + p.b + ' (stated by ' + p.statedBy + ' at ' + p.statedAt + ')');
      }
    }
    parent.appendChild(list);
  }

  function buildRecordForm(reload) {
    var form = el('div', 'order-field');
    form.setAttribute('data-truth-record-form', '');
    textLine(form, 'order-label', 'Record a claim or observation \\u2014 born claimed/observed; verified and accepted are earned from other actors, never asserted');
    var kind = select('Entity kind', ENTITY_KINDS);
    var entityId = input('Entity id', 'entity id');
    var statement = document.createElement('textarea');
    statement.setAttribute('aria-label', 'Statement');
    statement.placeholder = 'what is claimed or observed';
    var born = select('Born state', BORN_STATES);
    var evidence = input('Evidence ids, comma separated (required for an observation)', 'op_evidence ids, comma separated');
    var contradicts = input('Contradicts truth ids, comma separated (optional)', 'contradicts truth ids (optional)');
    var supersedes = input('Supersedes truth id (optional)', 'supersedes truth id (optional)');
    var privacy = select('Privacy', PRIVACY_LEVELS);
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Record truth';
    submit.addEventListener('click', function () {
      if (entityId.value.trim() === '' || statement.value.trim() === '') {
        outcome.textContent = 'Entity id and statement are required. Nothing was sent.';
        return;
      }
      var payload = { entityKind: kind.value, entityId: entityId.value.trim(), statement: statement.value.trim(), bornState: born.value, privacy: privacy.value };
      var refs = idList(evidence.value);
      if (refs.length > 0) payload.evidenceRefs = refs;
      var against = idList(contradicts.value);
      if (against.length > 0) payload.contradicts = against;
      if (supersedes.value.trim() !== '') payload.supersedes = supersedes.value.trim();
      submit.disabled = true;
      outcome.textContent = 'Recording\\u2026';
      postJson(TRUTH_PATH, payload).then(function (result) {
        submit.disabled = false;
        var answer = result.body || {};
        if (answer.ok === true) {
          outcome.textContent = answer.deduplicated === true
            ? 'Already recorded \\u2014 deduplicated onto the stored record.'
            : 'Recorded as ' + (answer.record ? answer.record.state : 'a record') + '. It cannot upgrade itself.';
          statement.value = ''; supersedes.value = ''; contradicts.value = '';
          notifyStateChanged();
          reload();
          return;
        }
        var error = answer.error || {};
        outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
      }).catch(function (error) {
        submit.disabled = false;
        outcome.textContent = 'Not recorded (' + error.message + ').';
      });
    });
    form.appendChild(kind); form.appendChild(entityId); form.appendChild(statement); form.appendChild(born);
    form.appendChild(evidence); form.appendChild(contradicts); form.appendChild(supersedes); form.appendChild(privacy);
    form.appendChild(submit); form.appendChild(outcome);
    return form;
  }

  function buildVerifyForm(reload) {
    var form = el('div', 'order-field');
    form.setAttribute('data-truth-verify-form', '');
    textLine(form, 'order-label', 'Verify a record \\u2014 independent only: the author of a record is refused; every verification states its limitations');
    var truthId = input('Truth record id to verify', 'truth record id');
    var method = select('Verification method', METHODS);
    var verdict = select('Verdict', VERDICTS);
    var evidence = input('Evidence ids, comma separated (required)', 'op_evidence ids, comma separated');
    var limitations = document.createElement('textarea');
    limitations.setAttribute('aria-label', 'Limitations');
    limitations.placeholder = 'limitations of this verification (required; write "none known" if honest)';
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Record verification';
    submit.addEventListener('click', function () {
      var refs = idList(evidence.value);
      if (truthId.value.trim() === '' || refs.length === 0 || limitations.value.trim() === '') {
        outcome.textContent = 'Truth id, at least one evidence id and limitations are required. Nothing was sent.';
        return;
      }
      submit.disabled = true;
      outcome.textContent = 'Recording verification\\u2026';
      postJson(TRUTH_VERIFY_PATH, { truthId: truthId.value.trim(), method: method.value, verdict: verdict.value, evidenceRefs: refs, limitations: limitations.value.trim() })
        .then(function (result) {
          submit.disabled = false;
          var answer = result.body || {};
          if (answer.ok === true) {
            outcome.textContent = 'Verification recorded (' + verdict.value + '). Record now derives as ' + (answer.record ? answer.record.state : 'unknown') + '.';
            notifyStateChanged();
            reload();
            return;
          }
          var error = answer.error || {};
          outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
        }).catch(function (error) {
          submit.disabled = false;
          outcome.textContent = 'Not recorded (' + error.message + ').';
        });
    });
    form.appendChild(truthId); form.appendChild(method); form.appendChild(verdict); form.appendChild(evidence);
    form.appendChild(limitations); form.appendChild(submit); form.appendChild(outcome);
    return form;
  }

  function buildAcceptForm(records, reload) {
    var form = el('div', 'order-field');
    form.setAttribute('data-truth-accept-form', '');
    var acceptable = records.filter(function (r) { return r.acceptanceDigest; });
    textLine(form, 'order-label', 'Founder acceptance \\u2014 only a verified, current, uncontested record; the digest shown is what you accept, and step-up is demanded');
    if (acceptable.length === 0) {
      textLine(form, 'muted', 'Nothing is acceptable right now: no record is verified, current and uncontested. Nothing is drawn that would only refuse.');
      return form;
    }
    var choice = document.createElement('select');
    choice.setAttribute('aria-label', 'Truth record to accept');
    for (var i = 0; i < acceptable.length; i++) {
      var option = document.createElement('option');
      option.value = acceptable[i].id;
      option.textContent = acceptable[i].statement + ' (' + acceptable[i].entityKind + ' ' + acceptable[i].entityId + ')';
      choice.appendChild(option);
    }
    var noteInput = input('Acceptance note (optional)', 'note (optional)');
    textLine(form, 'order-label', 'Step-up: acceptance is your irreversible signature on truth, so it demands a fresh credential. Re-enter your JENIFY OS password.');
    var stepUp = document.createElement('input');
    stepUp.type = 'password';
    stepUp.autocomplete = 'current-password';
    stepUp.setAttribute('aria-label', 'Step-up password for truth acceptance');
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Accept truth';
    submit.addEventListener('click', function () {
      var chosen = null;
      for (var j = 0; j < acceptable.length; j++) if (acceptable[j].id === choice.value) chosen = acceptable[j];
      if (!chosen) { outcome.textContent = 'No record chosen.'; return; }
      var payload = { truthId: chosen.id, expectedDigest: chosen.acceptanceDigest };
      if (noteInput.value.trim() !== '') payload.note = noteInput.value.trim();
      if (stepUp.value !== '') payload.stepUpPassword = stepUp.value;
      submit.disabled = true;
      outcome.textContent = 'Accepting\\u2026';
      postJson(TRUTH_ACCEPT_PATH, payload).then(function (result) {
        submit.disabled = false;
        stepUp.value = '';
        var answer = result.body || {};
        if (answer.ok === true) {
          outcome.textContent = answer.deduplicated === true ? 'Already accepted by you.' : 'Accepted. The acceptance is recorded once and never rewritten.';
          notifyStateChanged();
          reload();
          return;
        }
        var error = answer.error || {};
        outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
      }).catch(function (error) {
        submit.disabled = false;
        outcome.textContent = 'Not accepted (' + error.message + ').';
      });
    });
    form.appendChild(choice); form.appendChild(noteInput); form.appendChild(stepUp); form.appendChild(submit); form.appendChild(outcome);
    return form;
  }

  function buildEntityLookup() {
    var form = el('div', 'order-field');
    form.setAttribute('data-truth-entity-form', '');
    textLine(form, 'order-label', 'Entity truth history \\u2014 current records, full history and unresolved contradictions for one canonical entity');
    var kind = select('Entity kind to look up', ENTITY_KINDS);
    var id = input('Entity id to look up', 'entity id');
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    var results = el('div', 'memory-cards');
    results.setAttribute('data-truth-entity-history', '');
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'order-live-submit';
    go.textContent = 'Read entity truth';
    go.addEventListener('click', function () {
      results.textContent = '';
      if (id.value.trim() === '') { outcome.textContent = 'An entity id is required.'; return; }
      outcome.textContent = 'Reading\\u2026';
      jsonExchange(fetch(TRUTH_ENTITY_PATH + '?kind=' + encodeURIComponent(kind.value) + '&id=' + encodeURIComponent(id.value.trim()), { headers: { accept: 'application/json' } }))
        .then(function (result) {
          var body = result.body || {};
          if (body.ok !== true || !body.truth) {
            var error = body.error || {};
            outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
            return;
          }
          var truth = body.truth;
          outcome.textContent = truth.entityKind + ' ' + truth.entityId + ': current state ' + truth.currentState.toUpperCase() + ' \\u00b7 ' +
            truth.current.length + ' current record(s) \\u00b7 ' + truth.total + ' in history' + (truth.truncated ? ' (bounded)' : '');
          renderContradictions(results, truth.unresolvedContradictions);
          for (var i = 0; i < truth.history.length; i++) results.appendChild(renderRecord(truth.history[i]));
        }).catch(function (error) {
          outcome.textContent = 'Not read (' + error.message + ').';
        });
    });
    form.appendChild(kind); form.appendChild(id); form.appendChild(go); form.appendChild(outcome); form.appendChild(results);
    return form;
  }

  var sessionAnswer = null;
  function reload() {
    jsonExchange(fetch(TRUTH_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.records)) {
          var error = body.error || {};
          stayOff('the truth read was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given'));
          return;
        }
        var records = body.records;
        var grant = grantedControls(sessionAnswer);
        note.setAttribute('data-truth-console-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + body.total + ' truth record(s)' + (body.truncated ? ' (newest ' + records.length + ' shown)' : '') +
          ', derived from hq_truth_* just now. States are categorical \\u2014 claimed, observed, verified, accepted \\u2014 and never a score.';
        box.textContent = '';
        renderContradictions(box, Array.isArray(body.unresolvedContradictions) ? body.unresolvedContradictions : []);
        var cards = el('div', 'memory-cards');
        cards.setAttribute('data-truth-cards', '');
        box.appendChild(cards);
        if (records.length === 0) {
          textLine(cards, 'muted', 'HQ holds no truth record yet. 0 means 0 \\u2014 nothing is invented to fill this page.');
        }
        for (var i = 0; i < records.length; i++) cards.appendChild(renderRecord(records[i]));
        box.appendChild(buildEntityLookup());
        if (grant.truthRecord) box.appendChild(buildRecordForm(reload));
        else textLine(box, 'readonly-note', 'The record form is off for this session \\u2014 ' + grant.reason);
        if (grant.truthVerify) box.appendChild(buildVerifyForm(reload));
        else textLine(box, 'readonly-note', 'The verify form is off for this session \\u2014 ' + grant.reason);
        if (grant.truthAccept) box.appendChild(buildAcceptForm(records, reload));
        else textLine(box, 'readonly-note', 'Acceptance is off for this session \\u2014 it requires approval authority. ' + grant.reason);
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        stayOff(grantedControls(result.body).reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}


/**
 * Mission Room collaboration console on projects.html (Phase 9).
 *
 * The static markup is a mount and a note — no control. This script asks
 * `/session`; any resolved Founder gets the live READ: the bounded session
 * list, and for each mission with a session the full Mission Room read
 * (canonical tasks with their live claim/assignment, admitted workers with
 * the binding HQ recorded, the actual contributions with their explicit
 * agreement/disagreement stances and the truth state each referenced record
 * derives NOW, disagreements listed first, handoff requests beside the
 * canonical claim they did not change, truth records, pending approvals,
 * blockers, recent orchestration runs and external actions). The open and
 * admit forms are drawn only under a granted `collaborationCommand`. Nothing
 * animates; nothing is invented; zero renders as an explicit zero; every
 * server string lands through textContent.
 */
export function collaborationConsoleScript(roles: readonly string[]): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-collaboration-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var COLLAB_PATH = ${jsonForScript(CONTROL_ROUTES.collaboration)};
  var COLLAB_ROOM_PATH = ${jsonForScript(CONTROL_ROUTES.collaborationRoom)};
  var COLLAB_ADMIT_PATH = ${jsonForScript(CONTROL_ROUTES.collaborationAdmit)};
  var MISSIONS_PATH = ${jsonForScript(CONTROL_ROUTES.missions)};
  var ROLES = ${jsonForScript(roles)};
  var ROOM_LIMIT = 12;

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read the collaboration record\\u2026');
  note.setAttribute('data-collaboration-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var box = el('div', 'missions-live collaboration-live');
  box.setAttribute('data-collaboration-rooms', '');
  mount.appendChild(box);

  var sessionAnswer = null;

  function stayOff(reason) {
    box.textContent = '';
    note.setAttribute('data-collaboration-console-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'COLLABORATION RECORD IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  function chip(parent, text, attr, value) {
    var c = el('span', 'chip', text);
    if (attr) c.setAttribute(attr, value);
    parent.appendChild(c);
  }

  function listOf(parent, label, items, render, emptyText) {
    textLine(parent, 'order-label', label);
    if (!Array.isArray(items) || items.length === 0) {
      textLine(parent, 'muted', emptyText);
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'timeline';
    for (var i = 0; i < items.length; i++) {
      var li = document.createElement('li');
      render(li, items[i]);
      ul.appendChild(li);
    }
    parent.appendChild(ul);
  }

  function bindingText(binding) {
    if (!binding) return 'binding: not recorded';
    var provider = binding.providerId ? 'provider ' + binding.providerId : 'provider undeclared';
    var model = binding.memberIdentityKey ? 'model ' + binding.memberIdentityKey : 'no registered model identity';
    return provider + ' \\u00b7 ' + model + ' (' + (binding.source || 'unknown') + ')';
  }

  function canonicalText(canonical) {
    if (!canonical) return 'canonical task row: absent';
    return 'canonical: status ' + canonical.status + ', claimed by ' + (canonical.claimedBy || 'nobody') +
      ', Founder assignment ' + (canonical.assignedWorkerId ? canonical.assignedWorkerId + ' (by ' + canonical.assignedBy + ')' : 'none');
  }

  function renderRoom(room, canCommand, reason) {
    var card = el('article', 'panel mission-card collaboration-room');
    card.setAttribute('data-collaboration-room', room.missionId);
    var mission = room.mission || {};
    var head = el('p', 'row');
    head.appendChild(el('b', '', 'MISSION ROOM \\u2014 ' + (mission.title || room.missionId)));
    chip(head, String(mission.status), 'data-mission-status', String(mission.status));
    card.appendChild(head);
    textLine(card, 'faint', room.missionId + ' \\u00b7 commanded by ' + mission.createdBy + ' \\u00b7 assembled ' + room.assembledAt);
    textLine(card, '', 'Objective (current): ' + mission.objective);
    var constraints = Array.isArray(mission.constraints) ? mission.constraints : [];
    textLine(card, 'muted', constraints.length > 0 ? 'Constraints (non-negotiable): ' + constraints.join(' \\u00b7 ') : 'Constraints: none were stated.');

    var execution = room.execution || {};
    listOf(card, 'Canonical tasks (op_tasks, the one task truth)', execution.linkedTasks, function (li, task) {
      li.textContent = 'plan item ' + task.planItemSeq + ' \\u2192 task ' + task.taskId + ': ' + task.status +
        (task.reviewPending ? ' (review pending)' : '') +
        ' \\u00b7 claimed by ' + (task.claimedBy || 'nobody') +
        ' \\u00b7 Founder assignment ' + (task.assignment ? task.assignment.workerId : 'none') +
        ' \\u00b7 eligible: ' + (Array.isArray(task.eligibleWorkers) && task.eligibleWorkers.length > 0 ? task.eligibleWorkers.join(', ') : 'nobody');
      li.setAttribute('data-collaboration-task', task.taskId);
    }, 'No plan item of this mission is linked to a real task. 0 means 0.');

    var blockers = execution.blockers || {};
    var blockerLines = [];
    if (Array.isArray(blockers.unspecifiedWorkItems) && blockers.unspecifiedWorkItems.length > 0) blockerLines.push('unspecified work items: ' + blockers.unspecifiedWorkItems.join(', '));
    if (Array.isArray(blockers.needsClarification) && blockers.needsClarification.length > 0) blockerLines.push('needs clarification: ' + blockers.needsClarification.join(', '));
    if (Array.isArray(blockers.approvalPending) && blockers.approvalPending.length > 0) blockerLines.push('approval pending: ' + blockers.approvalPending.join(', '));
    if (Array.isArray(blockers.outcomeUnknown) && blockers.outcomeUnknown.length > 0) blockerLines.push('outcome unknown: ' + blockers.outcomeUnknown.join(', '));
    if (Array.isArray(blockers.blocked) && blockers.blocked.length > 0) blockerLines.push('blocked: ' + blockers.blocked.join(', '));
    var killSwitch = execution.killSwitch || {};
    if (killSwitch.global === true) blockerLines.push('GLOBAL KILL SWITCH ENGAGED');
    if (killSwitch.orchestrate === true) blockerLines.push('orchestration kill switch engaged');
    listOf(card, 'Blockers', blockerLines, function (li, line) { li.textContent = line; }, 'No blocker is recorded.');

    listOf(card, 'Participating workers (admitted by the Founder; a role is metadata, never authority)', room.participants, function (li, p) {
      li.textContent = p.workerId + ' \\u2014 ' + (Array.isArray(p.roles) ? p.roles.join(', ') : '') + ' \\u00b7 ' +
        bindingText({ providerId: p.providerId, memberIdentityKey: p.memberIdentityKey, source: p.providerId ? (p.memberIdentityKey ? 'declared_provider_and_registered_model' : 'declared_provider') : 'undeclared' });
      li.setAttribute('data-collaboration-participant', p.workerId);
    }, 'No worker is admitted. 0 means 0 \\u2014 nothing is drawn that was not recorded.');

    listOf(card, 'Disagreements (explicit; never settled by count or recency)', room.disagreements, function (li, d) {
      li.textContent = d.workerId + ' (' + d.role + ') disagrees with ' + d.disputedWorkerId + ' (' + d.disputedRole + ') \\u2014 contribution ' + d.contributionId + ' vs ' + d.disputesId + ' at ' + d.at;
      li.setAttribute('data-collaboration-disagreement', d.contributionId);
    }, 'No disagreement is recorded.');

    listOf(card, 'Handoff requests (recommendations \\u2014 canonical assignment unchanged)', room.handoffRequests, function (li, h) {
      li.textContent = h.fromWorkerId + ' requests handoff of task ' + h.taskId + ' to ' + h.toWorkerId + ': ' + h.reason + ' \\u00b7 ' + canonicalText(h.canonical);
      li.setAttribute('data-collaboration-handoff', h.contributionId);
    }, 'No handoff is requested.');

    var contributions = room.contributions || { items: [], total: 0 };
    textLine(card, 'order-label', 'Contributions (' + contributions.total + ' recorded' + (contributions.truncated ? ', newest ' + contributions.items.length + ' shown' : '') + ')');
    if (!Array.isArray(contributions.items) || contributions.items.length === 0) {
      textLine(card, 'muted', 'No contribution is recorded. 0 means 0 \\u2014 no worker activity is invented.');
    } else {
      var list = el('div', 'memory-cards');
      for (var i = 0; i < contributions.items.length; i++) {
        var c = contributions.items[i];
        var item = el('article', 'panel memory-card collaboration-contribution');
        item.setAttribute('data-collaboration-contribution', c.id);
        item.setAttribute('data-collaboration-standing', String(c.standing));
        var row = el('p', 'row');
        row.appendChild(el('b', '', c.kind.toUpperCase() + ' by ' + c.workerId + ' as ' + c.role));
        chip(row, String(c.standing), 'data-contribution-standing', String(c.standing));
        if (c.taskId) chip(row, 'task ' + c.taskId);
        item.appendChild(row);
        textLine(item, '', c.content);
        textLine(item, 'faint', c.id + ' \\u00b7 ' + c.at + ' \\u00b7 ' + bindingText(c.binding));
        var stances = [];
        if (Array.isArray(c.agreesWith) && c.agreesWith.length > 0) stances.push('agrees with ' + c.agreesWith.join(', '));
        if (Array.isArray(c.disagreesWith) && c.disagreesWith.length > 0) stances.push('disagrees with ' + c.disagreesWith.join(', '));
        if (Array.isArray(c.respondsTo) && c.respondsTo.length > 0) stances.push('responds to ' + c.respondsTo.join(', '));
        if (Array.isArray(c.agreedBy) && c.agreedBy.length > 0) stances.push('agreed by ' + c.agreedBy.map(function (s) { return s.workerId; }).join(', '));
        if (Array.isArray(c.disputedBy) && c.disputedBy.length > 0) stances.push('disputed by ' + c.disputedBy.map(function (s) { return s.workerId; }).join(', '));
        if (stances.length > 0) textLine(item, 'muted', stances.join(' \\u00b7 '));
        if (Array.isArray(c.truthRefs) && c.truthRefs.length > 0) {
          textLine(item, 'muted', 'Truth refs (state derived now, unmoved by any agreement here): ' + c.truthRefs.map(function (t) { return t.id + ' = ' + (t.state || 'not visible'); }).join(' \\u00b7 '));
        }
        if (Array.isArray(c.evidenceRefs) && c.evidenceRefs.length > 0) textLine(item, 'muted', 'Evidence (op_evidence ids, referenced never copied): ' + c.evidenceRefs.join(', '));
        if (Array.isArray(c.artifactRefs) && c.artifactRefs.length > 0) textLine(item, 'muted', 'Artifacts: ' + c.artifactRefs.join(', '));
        if (c.handoff) textLine(item, 'muted', 'Handoff requested to ' + c.handoff.toWorkerId + ' for task ' + c.handoff.taskId + ' \\u2014 advisory. ' + canonicalText(c.handoff.canonical));
        list.appendChild(item);
      }
      card.appendChild(list);
    }

    var truth = room.truth || { records: [], total: 0, unresolvedContradictions: 0 };
    listOf(card, 'Truth + evidence about this mission and its tasks (' + truth.total + ' record(s), ' + truth.unresolvedContradictions + ' unresolved contradiction(s))', truth.records, function (li, t) {
      li.textContent = t.state.toUpperCase() + (t.contested ? ' \\u00b7 CONTESTED' : '') + ' \\u2014 ' + t.entityKind + ' ' + t.entityId + ': ' + t.statement + ' (recorded by ' + t.recordedBy + ')';
      li.setAttribute('data-collaboration-truth', t.id);
    }, 'No truth record is about this mission or its tasks.');

    listOf(card, 'Held at the Founder gate (op_tasks.status = needs_approval)', room.heldForApproval, function (li, a) {
      li.textContent = 'task ' + a.taskId + ' \\u2014 ' + a.capabilityId + ', requested by ' + a.requestedBy + ', waiting since ' + a.since;
    }, 'No task of this mission is waiting on a Founder decision.');

    listOf(card, 'Recent orchestration runs', room.recentRuns, function (li, r) {
      li.textContent = r.runId + ' by ' + r.requestedBy + ' at ' + r.at;
    }, 'No orchestration run is recorded.');

    var actions = room.externalActions || { items: [], total: 0 };
    listOf(card, 'External actions on the ledger (' + actions.total + ')', actions.items, function (li, a) {
      li.textContent = a.id + ' \\u2014 ' + a.adapterId + '/' + a.actionType + ' for task ' + a.taskId + ': ' + a.state + ' (' + a.riskLevel + ' risk) proposed by ' + a.requestedBy;
    }, 'No external action is on the ledger for this mission.');

    listOf(card, 'Sessions', room.sessions, function (li, sn) {
      li.textContent = sn.title + ' (' + sn.id + ') \\u2014 ' + sn.standing + ' \\u00b7 ' + sn.participants.length + ' admitted \\u00b7 ' + sn.contributionCount + ' contribution(s) \\u00b7 opened by ' + sn.openedBy + ' at ' + sn.openedAt;
      li.setAttribute('data-collaboration-session', sn.id);
      if (canCommand && sn.standing === 'active') li.appendChild(admitForm(sn));
    }, 'No session is open on this mission.');

    if (!canCommand) textLine(card, 'readonly-note', 'Admission controls are off for this session \\u2014 ' + reason);
    box.appendChild(card);
  }

  function admitForm(session) {
    var form = el('div', 'order-field');
    form.setAttribute('data-collaboration-admit-form', session.id);
    var worker = document.createElement('input');
    worker.type = 'text';
    worker.setAttribute('aria-label', 'Registered worker id to admit to ' + session.id);
    worker.placeholder = 'registered worker id';
    var role = document.createElement('select');
    role.setAttribute('aria-label', 'Collaboration role for the admitted worker');
    for (var r = 0; r < ROLES.length; r++) {
      var option = document.createElement('option');
      option.value = ROLES[r];
      option.textContent = ROLES[r];
      role.appendChild(option);
    }
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Admit worker';
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    submit.addEventListener('click', function () {
      var workerId = worker.value.trim();
      if (workerId === '') { outcome.textContent = 'A registered worker id is required. Nothing was sent.'; return; }
      submit.disabled = true;
      outcome.textContent = 'Submitting\\u2026';
      postJson(COLLAB_ADMIT_PATH, { sessionId: session.id, workerId: workerId, collaborationRole: role.value }).then(function (result) {
        submit.disabled = false;
        var body = result.body || {};
        if (body.ok === true) { outcome.textContent = body.deduplicated ? 'Already admitted.' : 'Admitted.'; notifyStateChanged(); reload(); return; }
        var error = body.error || {};
        outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
      }).catch(function (error) {
        submit.disabled = false;
        outcome.textContent = 'Not submitted (' + error.message + ').';
      });
    });
    form.appendChild(worker);
    form.appendChild(role);
    form.appendChild(submit);
    form.appendChild(outcome);
    return form;
  }

  function openForm(missions) {
    var form = el('div', 'order-field');
    form.setAttribute('data-collaboration-open-form', '');
    textLine(form, 'order-label', 'Open a collaboration session on a canonical mission');
    var open = [];
    for (var i = 0; i < missions.length; i++) {
      var st = missions[i].status;
      if (st !== 'complete' && st !== 'failed' && st !== 'cancelled') open.push(missions[i]);
    }
    if (open.length === 0) {
      textLine(form, 'muted', 'No non-terminal mission exists, so there is nothing to open a session on.');
      return form;
    }
    var select = document.createElement('select');
    select.setAttribute('aria-label', 'Mission to open a collaboration session on');
    for (var m = 0; m < open.length; m++) {
      var option = document.createElement('option');
      option.value = open[m].id;
      option.textContent = open[m].title + ' (' + open[m].status + ')';
      select.appendChild(option);
    }
    var title = document.createElement('input');
    title.type = 'text';
    title.setAttribute('aria-label', 'Session title');
    title.placeholder = 'session title (required)';
    var purpose = document.createElement('input');
    purpose.type = 'text';
    purpose.setAttribute('aria-label', 'Session purpose (optional)');
    purpose.placeholder = 'purpose (optional)';
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Open session';
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    submit.addEventListener('click', function () {
      var titleText = title.value.trim();
      if (titleText === '') { outcome.textContent = 'A session title is required. Nothing was sent.'; return; }
      var payload = { missionId: select.value, title: titleText };
      if (purpose.value.trim() !== '') payload.purpose = purpose.value.trim();
      submit.disabled = true;
      outcome.textContent = 'Submitting\\u2026';
      postJson(COLLAB_PATH, payload).then(function (result) {
        submit.disabled = false;
        var body = result.body || {};
        if (body.ok === true) { outcome.textContent = body.deduplicated ? 'That session already exists.' : 'Session opened.'; notifyStateChanged(); reload(); return; }
        var error = body.error || {};
        outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
      }).catch(function (error) {
        submit.disabled = false;
        outcome.textContent = 'Not submitted (' + error.message + ').';
      });
    });
    form.appendChild(select);
    form.appendChild(title);
    form.appendChild(purpose);
    form.appendChild(submit);
    form.appendChild(outcome);
    return form;
  }

  function renderRooms(sessions, grant) {
    var missionIds = [];
    for (var i = 0; i < sessions.length; i++) {
      if (missionIds.indexOf(sessions[i].missionId) === -1) missionIds.push(sessions[i].missionId);
    }
    var shown = missionIds.slice(0, ROOM_LIMIT);
    if (missionIds.length > shown.length) {
      textLine(box, 'muted', 'Rooms are shown for the newest ' + shown.length + ' of ' + missionIds.length + ' missions with sessions.');
    }
    if (shown.length === 0) {
      textLine(box, 'muted', 'No collaboration session is open on any mission. 0 means 0 \\u2014 no room and no worker activity is invented.');
    }
    var pending = shown.length;
    for (var m = 0; m < shown.length; m++) {
      (function (missionId) {
        jsonExchange(fetch(COLLAB_ROOM_PATH + '?missionId=' + encodeURIComponent(missionId), { headers: { accept: 'application/json' } }))
          .then(function (result) {
            var body = result.body || {};
            if (body.ok === true && body.room) renderRoom(body.room, grant.collaborationCommand, grant.reason);
            else textLine(box, 'muted', 'The room for mission ' + missionId + ' could not be read (' + ((body.error && body.error.code) || ('HTTP ' + result.status)) + ').');
          })
          .catch(function (error) {
            textLine(box, 'muted', 'The room for mission ' + missionId + ' could not be read (' + error.message + ').');
          })
          .then(function () {
            pending -= 1;
            if (pending === 0) drawOpenForm(grant);
          });
      })(shown[m]);
    }
    if (shown.length === 0) drawOpenForm(grant);
  }

  function drawOpenForm(grant) {
    if (!grant.collaborationCommand) {
      textLine(box, 'readonly-note', 'The open-session form is off for this session \\u2014 ' + grant.reason);
      return;
    }
    jsonExchange(fetch(MISSIONS_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        box.appendChild(openForm(body.ok === true && Array.isArray(body.missions) ? body.missions : []));
      })
      .catch(function () {
        box.appendChild(openForm([]));
      });
  }

  function reload() {
    jsonExchange(fetch(COLLAB_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.sessions)) {
          var error = body.error || {};
          stayOff('the collaboration read was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given'));
          return;
        }
        var grant = grantedControls(sessionAnswer);
        note.setAttribute('data-collaboration-console-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + body.total + ' collaboration session(s)' + (body.truncated ? ' (newest ' + body.sessions.length + ' shown)' : '') +
          ', from the canonical record just now. Every worker shown was admitted by the Founder; every contribution shown was recorded under a resolved worker identity.';
        box.textContent = '';
        renderRooms(body.sessions, grant);
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        stayOff(grantedControls(result.body).reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}


/**
 * Chief of Staff / Company Command Center console on index.html (Phase 10).
 *
 * The static markup is a mount and a note — no control, no data. This script
 * asks `/session`; any resolved Founder gets the live READ of the whole
 * derived briefing: the Founder Inbox with the canonical row each item
 * references, what is blocked, what changed since the last issued brief, what
 * is verified, what is recorded unknown, what HQ can safely do next, the
 * recommendations that answer the inbox, and the department PROJECTIONS. The
 * "Issue brief receipt" button is drawn only under a granted `founderBrief`.
 *
 * Three things this console deliberately never draws:
 * - a priority, score, percentage, ETA or confidence — none exists in the
 *   data, and the wire guards refuse the field names outright;
 * - an act on a recommendation. A recommendation card states the acting path
 *   and the authority it takes, as TEXT, because there is no route and no
 *   facade method that accepts a recommendation id;
 * - worker activity. Every number shown is a count the server made over rows
 *   it had just enumerated, and zero renders as an explicit zero.
 *
 * Every server string lands through textContent, and nothing animates.
 */
export function commandCenterConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-command-center-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var COMMAND_CENTER_PATH = ${jsonForScript(CONTROL_ROUTES.commandCenter)};
  var BRIEF_PATH = ${jsonForScript(CONTROL_ROUTES.commandCenterBrief)};
  var ITEM_LIMIT = 12;

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read the command centre\\u2026');
  note.setAttribute('data-command-center-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var box = el('div', 'missions-live command-center-live');
  box.setAttribute('data-command-center', '');
  mount.appendChild(box);

  var sessionAnswer = null;

  function stayOff(reason) {
    box.textContent = '';
    note.setAttribute('data-command-center-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'THE COMMAND CENTRE IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  function chip(parent, text, attr, value) {
    var c = el('span', 'chip', text);
    if (attr) c.setAttribute(attr, value);
    parent.appendChild(c);
  }

  function listOf(parent, label, items, render, emptyText) {
    textLine(parent, 'order-label', label);
    if (!Array.isArray(items) || items.length === 0) {
      textLine(parent, 'muted', emptyText);
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'timeline';
    for (var i = 0; i < items.length && i < ITEM_LIMIT; i++) {
      var li = document.createElement('li');
      render(li, items[i]);
      ul.appendChild(li);
    }
    parent.appendChild(ul);
    if (items.length > ITEM_LIMIT) textLine(parent, 'faint', 'Showing the first ' + ITEM_LIMIT + ' of ' + items.length + '.');
  }

  function boundedNote(list) {
    if (!list) return '0';
    return list.truncated ? list.total + ' (newest ' + list.items.length + ' shown)' : String(list.total);
  }

  function renderInbox(card, inbox) {
    var head = el('p', 'row');
    head.appendChild(el('b', '', 'WHAT NEEDS ME \\u2014 ' + inbox.total + ' item(s)'));
    var kinds = inbox.byKind || {};
    for (var key in kinds) {
      if (Object.prototype.hasOwnProperty.call(kinds, key) && kinds[key] > 0) chip(head, key + ' ' + kinds[key], 'data-attention-kind', key);
    }
    card.appendChild(head);
    textLine(card, 'faint', inbox.ordering);
    if (inbox.withheldFounderOnly > 0) {
      textLine(card, 'muted', inbox.withheldFounderOnly + ' item(s) derived from founder_only records are withheld from this read.');
    }
    listOf(card, 'Attention items (each references the canonical row it exists because of)', inbox.items, function (li, item) {
      li.textContent = item.kind + ' \\u00b7 ' + item.summary +
        ' \\u2014 source ' + item.source.table + ' ' + item.source.id +
        ' \\u00b7 predicate: ' + item.provenance +
        ' \\u00b7 resolved under ' + item.requiredAuthority +
        ' \\u00b7 ' + (item.since ? 'since ' + item.since : 'the source record carries no timestamp') +
        ' \\u00b7 staleness: ' + item.staleness;
      li.setAttribute('data-attention-item', item.id);
      li.setAttribute('data-attention-kind', item.kind);
    }, 'Nothing needs the Founder. 0 means 0 \\u2014 no item is invented to fill the queue.');
  }

  function renderBlocked(card, blocked) {
    listOf(card, 'WHAT IS BLOCKED \\u2014 missions (' + boundedNote(blocked.missions) + ')', blocked.missions.items, function (li, m) {
      li.textContent = m.title + ' (' + m.id + ') \\u2014 ' + m.status + (m.blockReason ? ': ' + m.blockReason : '') + ' \\u00b7 since ' + m.statusChangedAt;
    }, 'No mission is blocked.');
    listOf(card, 'Blocked or review-failed tasks (' + boundedNote(blocked.tasks) + ')', blocked.tasks.items, function (li, t) {
      li.textContent = (t.title ? t.title + ' (' + t.taskId + ')' : t.taskId) + ' \\u2014 ' + t.status + (t.blockReason ? ': ' + t.blockReason : '');
    }, 'No task is blocked.');
    listOf(card, 'Held at the Founder gate (' + boundedNote(blocked.heldForApproval) + ')', blocked.heldForApproval.items, function (li, t) {
      li.textContent = (t.title ? t.title + ' (' + t.taskId + ')' : t.taskId) + ' \\u2014 approval ' + (t.approvalId || 'not recorded') + (t.requestedAt ? ' requested ' + t.requestedAt : '');
    }, 'No task is held at the Founder gate.');
    listOf(card, 'Kill switches engaged (' + blocked.killSwitches.length + ')', blocked.killSwitches, function (li, k) {
      li.textContent = k.scope + (k.reason ? ': ' + k.reason : '') + (k.engagedBy ? ' \\u00b7 engaged by ' + k.engagedBy : '');
    }, 'No kill switch is engaged.');
    listOf(card, 'Plans the orchestrator cannot act on (' + boundedNote(blocked.plansNeedingFounder) + ')', blocked.plansNeedingFounder.items, function (li, p) {
      li.textContent = p.title + ' (' + p.missionId + ') \\u2014 ' + p.needsClarification + ' item(s) need clarification, ' + p.unspecifiedWork + ' work item(s) have no Founder spec';
    }, 'Every live plan item is either linked or specified.');
  }

  function renderChanged(card, changed) {
    textLine(card, 'order-label', 'WHAT CHANGED');
    textLine(card, 'muted', changed.note);
    listOf(card, 'Canonical events (' + boundedNote(changed.events) + ')', changed.events.items, function (li, e) {
      li.textContent = '#' + e.seq + ' ' + e.at + ' \\u00b7 ' + e.actor + ' \\u00b7 ' + e.subjectKind + ' ' + e.subjectId + (e.status ? ' [' + e.status + ']' : '') + ' \\u2014 ' + e.summary;
    }, 'No canonical event was appended.');
    listOf(card, 'Evidence appended, by kind', changed.evidenceByKind, function (li, k) {
      li.textContent = k.kind + ': ' + k.count;
    }, 'No evidence entry was appended.');
  }

  function renderVerified(card, verified) {
    textLine(card, 'order-label', 'WHAT IS VERIFIED \\u2014 ' + verified.verified + ' verified, ' + verified.accepted + ' Founder-accepted, ' + verified.supersededExcluded + ' superseded and therefore excluded');
    if (verified.withheldFounderOnly > 0) textLine(card, 'muted', verified.withheldFounderOnly + ' founder_only record(s) are withheld from this read and from every number above.');
    listOf(card, 'Current records (' + boundedNote(verified.truth) + ')', verified.truth.items, function (li, t) {
      li.textContent = t.state.toUpperCase() + ' \\u00b7 ' + t.entityKind + ' ' + t.entityId + ': ' + t.statement +
        ' \\u00b7 recorded by ' + t.recordedBy +
        ' \\u00b7 ' + (t.provenanceMissing ? 'NO EVIDENCE CITED \\u2014 provenance is missing' : 'evidence cited') +
        ' \\u00b7 subject drift: ' + t.subjectDrift + ' (' + t.staleness + ')' +
        (t.verificationLimitations.length > 0 ? ' \\u00b7 stated limitations: ' + t.verificationLimitations.join(' | ') : '');
      li.setAttribute('data-verified-truth', t.id);
    }, 'No current record derives verified or accepted.');
    listOf(card, 'Missions verified or complete (' + boundedNote(verified.missions) + ')', verified.missions.items, function (li, m) {
      li.textContent = m.title + ' (' + m.id + ') \\u2014 ' + m.status;
    }, 'No mission is verified or complete.');
  }

  function renderUnknown(card, unknown) {
    textLine(card, 'order-label', 'WHAT IS UNKNOWN \\u2014 ' + unknown.total + ' explicit unknown(s)');
    textLine(card, 'muted', unknown.note);
    if (unknown.withheldFounderOnly > 0) textLine(card, 'muted', unknown.withheldFounderOnly + ' entry/entries naming founder_only records are withheld from this read and from the total above.');
    listOf(card, 'Tasks with an unconfirmed outcome (' + boundedNote(unknown.tasksOutcomeUnknown) + ')', unknown.tasksOutcomeUnknown.items, function (li, t) {
      li.textContent = (t.title ? t.title + ' (' + t.taskId + ')' : t.taskId) + ' \\u00b7 since ' + t.updatedAt;
    }, 'No task outcome is unknown.');
    listOf(card, 'External actions awaiting reconciliation (' + boundedNote(unknown.actionsOutcomeUnknown) + ')', unknown.actionsOutcomeUnknown.items, function (li, a) {
      li.textContent = a.actionId + ' on task ' + a.taskId + ' \\u2014 ' + a.state + ' since ' + a.since;
    }, 'No external action is awaiting reconciliation.');
    listOf(card, 'Dispatch attempts with no terminal record (' + boundedNote(unknown.dispatchOutcomeUnknown) + ')', unknown.dispatchOutcomeUnknown.items, function (li, d) {
      li.textContent = 'task ' + d.taskId + ' \\u00b7 attempted ' + d.at;
    }, 'No dispatch attempt is unresolved.');
    listOf(card, 'Missions with no stated acceptance criteria (' + boundedNote(unknown.missionsWithoutAcceptanceCriteria) + ')', unknown.missionsWithoutAcceptanceCriteria.items, function (li, m) {
      li.textContent = m.title + ' (' + m.id + ') \\u2014 ' + m.status;
    }, 'Every live mission states acceptance criteria.');
    listOf(card, 'Claims citing no evidence \\u2014 missing provenance, shown as missing (' + boundedNote(unknown.truthWithoutEvidence) + ')', unknown.truthWithoutEvidence.items, function (li, t) {
      li.textContent = t.id + ' \\u00b7 ' + t.entityKind + ' ' + t.entityId + ' \\u00b7 ' + t.state;
    }, 'Every current record cites evidence.');
    listOf(card, 'Verifications that concluded nothing (' + boundedNote(unknown.truthInconclusive) + ')', unknown.truthInconclusive.items, function (li, t) {
      li.textContent = t.id + ' \\u00b7 ' + t.entityKind + ' ' + t.entityId;
    }, 'No verification is inconclusive.');
    listOf(card, 'Active workers with no declared provider (' + boundedNote(unknown.workersUndeclaredProvider) + ')', unknown.workersUndeclaredProvider.items, function (li, w) {
      li.textContent = w.workerId + ' (' + w.displayName + ') \\u2014 no op_worker_providers row; nothing is inferred from its vendor string';
    }, 'Every active worker has a declared provider.');
    if (Array.isArray(unknown.storesAbsent) && unknown.storesAbsent.length > 0) {
      textLine(card, 'muted', 'Stores absent on this database handle (their answers are absence, not zero): ' + unknown.storesAbsent.join(', ') + '.');
    }
  }

  function renderSafeNext(card, safeNext) {
    textLine(card, 'order-label', 'WHAT HQ CAN SAFELY DO NEXT');
    textLine(card, 'muted', safeNext.note);
    listOf(card, 'Acts', safeNext.acts, function (li, a) {
      li.textContent = a.act + ' (' + a.nature + ') \\u2014 ' + (a.safe ? 'available now' : 'not available: ' + a.blockers.join('; ')) +
        ' \\u00b7 authority: ' + a.requiredAuthority +
        (a.applyWouldRefuse.length > 0 ? ' \\u00b7 applying afterwards would currently refuse: ' + a.applyWouldRefuse.join('; ') : '') +
        ' \\u00b7 ' + a.note;
      li.setAttribute('data-safe-act', a.act);
    }, 'No read or record act is available on this handle.');
    listOf(card, 'Queued tasks a registered worker could claim (' + boundedNote(safeNext.claimableTasks) + ')', safeNext.claimableTasks.items, function (li, t) {
      li.textContent = (t.title ? t.title + ' (' + t.taskId + ')' : t.taskId) + ' \\u00b7 ' + t.capabilityId + ' \\u00b7 eligible: ' + t.eligibleWorkers.join(', ');
    }, 'No queued task has an eligible registered worker and no engaged stop.');
  }

  function renderRecommendations(card, recommendations) {
    textLine(card, 'order-label', 'RECOMMENDATIONS (' + boundedNote(recommendations) + ')');
    textLine(card, 'muted', 'A recommendation is a record, never a button: HQ has no route and no method that takes one. Each names the existing act and the authority that act passes.');
    listOf(card, 'Recommended acts', recommendations.items, function (li, r) {
      li.textContent = r.kind + ' \\u2014 ' + r.summary +
        ' \\u00b7 act: ' + r.actPath +
        ' \\u00b7 authority: ' + r.requiredAuthority +
        ' \\u00b7 rationale: ' + r.rationale +
        ' \\u00b7 limitations: ' + r.limitations.join(' | ') +
        ' \\u00b7 executable: ' + String(r.executable);
      li.setAttribute('data-recommendation', r.id);
    }, 'Nothing is recommended, because nothing needs the Founder.');
  }

  function renderDepartments(card, departments) {
    textLine(card, 'order-label', 'DEPARTMENTS \\u2014 projections over canonical truth, never their own stores');
    var list = el('div', 'memory-cards');
    for (var i = 0; i < departments.length; i++) {
      var d = departments[i];
      var item = el('article', 'panel memory-card command-center-department');
      item.setAttribute('data-department', d.department);
      item.setAttribute('data-department-basis', d.basis);
      var row = el('p', 'row');
      row.appendChild(el('b', '', d.department.replace(/_/g, ' ').toUpperCase()));
      chip(row, d.basis === 'canonical' ? 'canonical' : 'not recorded', 'data-department-basis', d.basis);
      if (d.attention > 0) chip(row, d.attention + ' need(s) the Founder');
      item.appendChild(row);
      if (d.metrics.length === 0) {
        textLine(item, 'muted', 'No metric is shown, because HQ records nothing that would make one true.');
      } else {
        for (var m = 0; m < d.metrics.length; m++) {
          textLine(item, '', d.metrics[m].label + ': ' + d.metrics[m].value);
        }
      }
      textLine(item, 'faint', (d.sources.length > 0 ? 'Sources: ' + d.sources.join(', ') + '. ' : '') + d.note);
      list.appendChild(item);
    }
    card.appendChild(list);
  }

  function briefForm(briefs) {
    var form = el('div', 'order-field');
    form.setAttribute('data-brief-form', '');
    textLine(form, 'order-label', 'Issue a brief receipt');
    textLine(form, 'muted', 'Records ONE append-only row: who issued it, when, the canonical watermarks it observed, categorical counts and a content digest. It sends nothing, schedules nothing and decides nothing.');
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'order-live-submit';
    submit.textContent = 'Issue brief receipt';
    var outcome = el('p', 'muted', '');
    outcome.setAttribute('role', 'status');
    outcome.setAttribute('aria-live', 'polite');
    submit.addEventListener('click', function () {
      submit.disabled = true;
      outcome.textContent = 'Submitting\\u2026';
      postJson(BRIEF_PATH, {}).then(function (result) {
        submit.disabled = false;
        var body = result.body || {};
        if (body.ok === true) {
          outcome.textContent = body.deduplicated
            ? 'Nothing was appended since the last receipt, so this deduplicated to brief ' + body.brief.id + '.'
            : 'Receipt ' + body.brief.id + ' recorded at watermark ' + body.brief.watermark.eventSeq + '/' + body.brief.watermark.evidenceSeq + '.';
          notifyStateChanged();
          reload();
          return;
        }
        var error = body.error || {};
        outcome.textContent = 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
      }).catch(function (error) {
        submit.disabled = false;
        outcome.textContent = 'Not submitted (' + error.message + ').';
      });
    });
    form.appendChild(submit);
    form.appendChild(outcome);
    if (briefs.latest) {
      textLine(form, 'faint', 'Latest receipt: ' + briefs.latest.id + ' by ' + briefs.latest.issuedBy + ' at ' + briefs.latest.issuedAt +
        ' \\u00b7 digest ' + briefs.latest.contentDigest + ' \\u00b7 ' + briefs.total + ' receipt(s) on the ledger.');
    } else {
      textLine(form, 'faint', 'No brief has ever been issued. 0 means 0.');
    }
    return form;
  }

  function renderBriefing(briefing, grant, briefStorePresent) {
    var card = el('article', 'panel mission-card command-center-briefing');
    card.setAttribute('data-command-center-briefing', '');
    textLine(card, 'faint', 'Assembled ' + briefing.assembledAt + ' \\u00b7 ' + briefing.provenance.source);
    renderInbox(card, briefing.needsMe);
    renderBlocked(card, briefing.blocked);
    renderChanged(card, briefing.changed);
    renderVerified(card, briefing.verified);
    renderUnknown(card, briefing.unknown);
    renderSafeNext(card, briefing.safeNext);
    renderRecommendations(card, briefing.recommendations);
    renderDepartments(card, briefing.departments);
    if (!briefStorePresent) {
      textLine(card, 'readonly-note', 'This database handle carries no brief ledger, so no receipt can be recorded from it.');
    } else if (grant.founderBrief) {
      card.appendChild(briefForm(briefing.briefs));
    } else {
      textLine(card, 'readonly-note', 'The issue-brief control is off for this session \\u2014 ' + grant.reason);
    }
    box.appendChild(card);
  }

  function reload() {
    jsonExchange(fetch(COMMAND_CENTER_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !body.briefing) {
          var error = body.error || {};
          stayOff('the command-centre read was refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given'));
          return;
        }
        var grant = grantedControls(sessionAnswer);
        note.setAttribute('data-command-center-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + body.briefing.needsMe.total + ' item(s) need the Founder, ' +
          body.briefing.unknown.total + ' explicit unknown(s), ' + body.briefing.recommendations.total + ' recommendation(s), ' +
          'derived from the canonical record just now. Nothing here is stored, ranked or estimated.';
        box.textContent = '';
        renderBriefing(body.briefing, grant, body.briefStorePresent === true);
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        stayOff(grantedControls(result.body).reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Company Search + Ask Jenify console on index.html (Phase 11).
 *
 * The static markup is a mount and a note — no input, no button, no form, per
 * the site-wide inert-markup rule. This script asks `/session`; any resolved
 * Founder gets two live READS built into the mount: a unified search across
 * the canonical sources, and a natural-language question answered from rows
 * retrieved first.
 *
 * What this console deliberately never draws:
 * - a relevance score, rank, percentage or confidence. None exists in the
 *   data. What a hit shows instead is WHICH query terms it matched, which the
 *   reader can check against the snippet beside it;
 * - an action. Every element here is a read; there is no write route in this
 *   phase, and `postJson` is not called once in this script;
 * - a generated sentence. The answer text is the server's composed line over
 *   canonical fields, rendered verbatim through textContent, with each cited
 *   row's table and id beside it.
 *
 * Both reads are GETs whose criteria travel in the query string, and both are
 * refused by the server when the caller supplies no criterion at all — a
 * search box that returns the company record for an empty query is a dump,
 * not a search, and this console never issues one.
 */
export function searchConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-search-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var SEARCH_PATH = ${jsonForScript(CONTROL_ROUTES.search)};
  var ASK_PATH = ${jsonForScript(CONTROL_ROUTES.ask)};
  var HIT_LIMIT = 12;

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session may search the company record\\u2026');
  note.setAttribute('data-search-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var box = el('div', 'missions-live search-live');
  box.setAttribute('data-search-live', '');
  mount.appendChild(box);

  function stayOff(reason) {
    box.textContent = '';
    note.setAttribute('data-search-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'COMPANY SEARCH IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  function field(parent, labelText, placeholder) {
    var wrap = el('div', 'order-field');
    var label = el('label', 'order-label', labelText);
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'order-input';
    input.placeholder = placeholder;
    label.appendChild(input);
    wrap.appendChild(label);
    parent.appendChild(wrap);
    return input;
  }

  function button(parent, text) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'order-live-submit';
    b.textContent = text;
    parent.appendChild(b);
    return b;
  }

  function outcomeLine(parent) {
    var p = el('p', 'muted', '');
    p.setAttribute('role', 'status');
    p.setAttribute('aria-live', 'polite');
    parent.appendChild(p);
    return p;
  }

  function refusalText(result) {
    var body = result.body || {};
    var error = body.error || {};
    return 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
  }

  function renderDocumentLine(li, doc, matchedTerms, snippet, stale) {
    li.appendChild(el('b', '', doc.title));
    textLine(li, 'faint', doc.source + ' \\u00b7 ' + doc.table + ' \\u00b7 ' + doc.entityId + ' \\u00b7 ' + doc.at);
    textLine(li, '', 'status ' + doc.status + (doc.truthState ? ' \\u00b7 truth state ' + doc.truthState : '') +
      ' \\u00b7 lifecycle ' + doc.lifecycle + (stale ? ' \\u2014 SUPERSEDED, shown because it matched, not because it is current' : ''));
    if (snippet) textLine(li, 'muted', snippet);
    textLine(li, 'faint', 'matched terms: ' + (matchedTerms.length > 0 ? matchedTerms.join(', ') : 'none (structured filter only)') +
      (doc.evidenceRefs.length > 0 ? ' \\u00b7 evidence: ' + doc.evidenceRefs.join(', ') : ' \\u00b7 no op_evidence cited'));
  }

  function renderSearch(card, data) {
    var head = el('p', 'row');
    head.appendChild(el('b', '', 'SEARCH \\u2014 ' + data.total + ' matching record(s)'));
    card.appendChild(head);
    textLine(card, 'faint', 'Criteria: ' + data.criteria.join(' | '));
    textLine(card, 'faint', data.ordering);
    textLine(card, 'faint', 'Retrieval: ' + data.retrieval.mode + ' (' + data.retrieval.adapterId + '). ' + data.retrieval.note);
    if (data.withheldFounderOnly > 0) {
      textLine(card, 'muted', data.withheldFounderOnly + ' founder-classified document(s) exist in the corpus. ' +
        'That count describes the corpus, not this query.');
    }
    if (data.total === 0) {
      textLine(card, 'muted', 'No canonical record matched. That states what the company record contains; it is not a statement that the thing searched for is false.');
      return;
    }
    var ul = document.createElement('ul');
    ul.className = 'timeline';
    for (var i = 0; i < data.hits.length && i < HIT_LIMIT; i++) {
      var li = document.createElement('li');
      renderDocumentLine(li, data.hits[i].document, data.hits[i].matchedTerms, data.hits[i].snippet, data.hits[i].stale);
      ul.appendChild(li);
    }
    card.appendChild(ul);
    if (data.truncated) {
      textLine(card, 'faint', 'Showing ' + data.hits.length + ' of ' + data.total + ' matches; the limit is stated, never silent.');
    }
  }

  function renderAnswer(card, answer) {
    var head = el('p', 'row');
    head.appendChild(el('b', '', 'ASK JENIFY \\u2014 ' + answer.state));
    var state = el('span', 'chip', answer.state);
    state.setAttribute('data-answer-state', answer.state);
    head.appendChild(state);
    card.appendChild(head);
    textLine(card, '', answer.response);
    if (answer.unknownReason) textLine(card, 'faint', 'Reason: ' + answer.unknownReason);
    if (answer.truth.cited > 0) {
      textLine(card, 'faint', 'Cited truth records: ' + answer.truth.cited + ' \\u00b7 strongest state cited: ' + answer.truth.strongest);
    }
    if (answer.citations.length > 0) {
      textLine(card, 'order-label', 'Sources this answer is grounded in');
      var ul = document.createElement('ul');
      ul.className = 'timeline';
      for (var i = 0; i < answer.citations.length; i++) {
        var li = document.createElement('li');
        renderDocumentLine(li, answer.citations[i].document, answer.citations[i].matchedTerms, answer.citations[i].snippet, answer.citations[i].stale);
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }
    textLine(card, 'order-label', 'Limitations of this answer');
    var limits = document.createElement('ul');
    limits.className = 'timeline';
    for (var j = 0; j < answer.limitations.length; j++) {
      var item = document.createElement('li');
      item.textContent = answer.limitations[j].code + ' \\u2014 ' + answer.limitations[j].statement;
      limits.appendChild(item);
    }
    card.appendChild(limits);
    textLine(card, 'faint', answer.provenance);
  }

  function buildConsole() {
    box.textContent = '';
    var card = el('article', 'panel mission-card search-card');
    card.setAttribute('data-search-card', '');

    textLine(card, 'order-label', 'Search the canonical company record');
    var text = field(card, 'Text', 'e.g. load time hero image');
    var source = field(card, 'Source (optional, comma-separated)', 'mission, memory, truth, task, project, worker\\u2026');
    var searchOutcome = outcomeLine(card);
    var searchResults = el('div', '');
    searchResults.setAttribute('data-search-results', '');
    var runSearch = button(card, 'Search');
    card.appendChild(searchResults);

    runSearch.addEventListener('click', function () {
      var query = text.value.trim();
      var sources = source.value.trim();
      if (query === '' && sources === '') {
        searchOutcome.textContent = 'Supply at least one criterion. HQ does not answer a query with no criterion \\u2014 that is a dump of the company record, not a search.';
        return;
      }
      runSearch.disabled = true;
      searchOutcome.textContent = 'Searching\\u2026';
      jsonExchange(fetch(SEARCH_PATH + '?text=' + encodeURIComponent(query) + '&source=' + encodeURIComponent(sources), { headers: { accept: 'application/json' } })).then(function (result) {
        runSearch.disabled = false;
        searchResults.textContent = '';
        var body = result.body || {};
        if (body.ok !== true || !body.search) {
          searchOutcome.textContent = refusalText(result);
          return;
        }
        searchOutcome.textContent = 'Read at ' + body.search.searchedAt + '. Nothing was written to answer this.';
        renderSearch(searchResults, body.search);
      }).catch(function (error) {
        runSearch.disabled = false;
        searchOutcome.textContent = 'Not searched (' + error.message + ').';
      });
    });

    textLine(card, 'order-label', 'Ask Jenify a question about the company');
    textLine(card, 'muted', 'The question is answered from canonical rows retrieved first. When the record does not support an answer, HQ says so \\u2014 it never fills the gap with prose.');
    var question = field(card, 'Question', 'e.g. what is verified about the QOS load time work?');
    var askOutcome = outcomeLine(card);
    var answerBox = el('div', '');
    answerBox.setAttribute('data-answer', '');
    var runAsk = button(card, 'Ask Jenify');
    card.appendChild(answerBox);

    runAsk.addEventListener('click', function () {
      var asked = question.value.trim();
      if (asked === '') {
        askOutcome.textContent = 'Type a question first.';
        return;
      }
      runAsk.disabled = true;
      askOutcome.textContent = 'Retrieving canonical records\\u2026';
      jsonExchange(fetch(ASK_PATH + '?question=' + encodeURIComponent(asked), { headers: { accept: 'application/json' } })).then(function (result) {
        runAsk.disabled = false;
        answerBox.textContent = '';
        var body = result.body || {};
        if (body.ok !== true || !body.answer) {
          askOutcome.textContent = refusalText(result);
          return;
        }
        askOutcome.textContent = 'Answered at ' + body.answer.askedAt + ' from ' + body.answer.citations.length +
          ' cited record(s) of ' + body.answer.considered + ' that matched. Nothing was written to answer this.';
        renderAnswer(answerBox, body.answer);
      }).catch(function (error) {
        runAsk.disabled = false;
        askOutcome.textContent = 'Not asked (' + error.message + ').';
      });
    });

    box.appendChild(card);
    note.setAttribute('data-search-state', 'live');
    note.className = 'readonly-note console-state console-state-live';
    note.textContent = 'Live: search and Ask Jenify read the canonical record directly. Both are reads \\u2014 no result is stored, ranked, scored or estimated, and no answer states anything its cited rows do not carry.';
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        stayOff(grantedControls(result.body).reason);
        return;
      }
      buildConsole();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}

/**
 * Projects page: the Product Factory console (Phase 12).
 *
 * Static markup is a mount and a note, by the site-wide inert-markup rule.
 * This script asks `/session`; any resolved Founder gets the live register
 * read, and a session the server granted `productCommand` additionally gets
 * the three writes — register a product against a canonical project, move a
 * lifecycle, record the next artifact version.
 *
 * What this console deliberately never draws:
 * - a release, publish, deploy or distribute button. No such route exists and
 *   no facade method sits behind one. What it draws instead is the readiness
 *   OBSERVATION and, verbatim from the server, the statement that a real
 *   release runs through the Phase 8 gateway;
 * - a progress bar, percentage, completion share or ETA for a product. The
 *   lifecycle is a categorical state and nothing here turns nine ordered
 *   names into a number;
 * - an "apply this plan" control. The plan is a template's proposal; it
 *   carries no id, and turning a line of it into work means commanding a
 *   canonical mission on the mission console like any other mission;
 * - a vocabulary of its own. The product types, lifecycle states and artifact
 *   kinds are read from the server's response, so a console option that HQ
 *   would refuse cannot exist.
 */
export function productFactoryConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-product-factory-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var PRODUCTS_PATH = ${jsonForScript(CONTROL_ROUTES.products)};
  var PRODUCT_DETAIL_PATH = ${jsonForScript(CONTROL_ROUTES.productDetail)};
  var PRODUCT_LIFECYCLE_PATH = ${jsonForScript(CONTROL_ROUTES.productLifecycle)};
  var PRODUCT_ARTIFACTS_PATH = ${jsonForScript(CONTROL_ROUTES.productArtifacts)};

  var note = el('p', 'readonly-note console-state', 'Checking with the control API whether this session can read the product register\\u2026');
  note.setAttribute('data-product-factory-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  var listBox = el('div', 'projects-live product-live');
  listBox.setAttribute('data-product-list', '');
  mount.appendChild(listBox);

  // The outcome of the last write lives OUTSIDE the list, deliberately: a
  // successful write reloads the register, which rebuilds every card and
  // would otherwise wipe the line that said what happened.
  var banner = el('p', 'muted', '');
  banner.setAttribute('data-product-outcome', '');
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  mount.appendChild(banner);

  var sessionAnswer = null;

  function stayOff(reason) {
    listBox.textContent = '';
    banner.textContent = '';
    note.setAttribute('data-product-factory-state', 'off');
    note.className = 'readonly-note console-state console-state-off';
    note.textContent = 'THE PRODUCT REGISTER IS NOT READABLE FROM THIS PAGE \\u2014 ' + reason;
  }

  function textLine(parent, cls, text) {
    parent.appendChild(el('p', cls, text));
  }

  function refusalText(result) {
    var body = result.body || {};
    var error = body.error || {};
    return 'Refused (' + (error.code || ('HTTP ' + result.status)) + '): ' + (error.message || 'no detail was given');
  }

  function recheckAfterWriteRefusal(status, error) {
    jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        sessionAnswer = result.body;
        if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
          stayOff('the session no longer resolves to the Founder (a write was refused: ' +
            (error.code || ('HTTP ' + status)) + ')');
          return;
        }
        reload();
      })
      .catch(function (err) {
        stayOff('the HQ control API is not reachable from this page (' + err.message + ').');
      });
  }

  function handleWrite(path, payload, button, outcome, successText) {
    button.disabled = true;
    outcome.textContent = 'Submitting\\u2026';
    postJson(path, payload).then(function (result) {
      button.disabled = false;
      var body = result.body || {};
      if (body.ok === true) {
        outcome.textContent = successText;
        banner.textContent = successText;
        notifyStateChanged();
        reload();
        return;
      }
      outcome.textContent = refusalText(result);
      banner.textContent = refusalText(result);
      if (result.status === 401 || result.status === 403) {
        recheckAfterWriteRefusal(result.status, body.error || {});
      }
    }).catch(function (error) {
      button.disabled = false;
      outcome.textContent = 'Not submitted (' + error.message + ').';
      banner.textContent = 'Not submitted (' + error.message + ').';
    });
  }

  function select(parent, labelText, options) {
    var wrap = el('div', 'order-field');
    var label = el('label', 'order-label', labelText);
    var input = document.createElement('select');
    input.className = 'order-input';
    for (var i = 0; i < options.length; i++) {
      var option = document.createElement('option');
      option.value = String(options[i]);
      option.textContent = String(options[i]);
      input.appendChild(option);
    }
    label.appendChild(input);
    wrap.appendChild(label);
    parent.appendChild(wrap);
    return input;
  }

  function textField(parent, labelText, placeholder) {
    var wrap = el('div', 'order-field');
    var label = el('label', 'order-label', labelText);
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'order-input';
    input.placeholder = placeholder;
    label.appendChild(input);
    wrap.appendChild(label);
    parent.appendChild(wrap);
    return input;
  }

  function outcomeLine(parent) {
    var p = el('p', 'muted', '');
    p.setAttribute('role', 'status');
    p.setAttribute('aria-live', 'polite');
    parent.appendChild(p);
    return p;
  }

  function renderArtifacts(card, product) {
    var artifacts = Array.isArray(product.artifacts) ? product.artifacts : [];
    if (artifacts.length === 0) {
      textLine(card, 'muted', 'Artifacts: none recorded. 0 means 0 \\u2014 no version is invented for this product.');
      return;
    }
    textLine(card, 'order-label', 'Artifact versions \\u2014 immutable; a new version is a new row, never an edit');
    var list = document.createElement('ul');
    list.className = 'timeline';
    for (var i = 0; i < artifacts.length; i++) {
      var a = artifacts[i];
      var li = document.createElement('li');
      li.appendChild(el('b', '', a.kind + ' \\u00b7 ' + a.name + ' \\u00b7 v' + a.version + (a.latest ? ' (latest)' : '')));
      li.appendChild(el('p', 'faint', a.locator + ' \\u00b7 recorded by ' + a.recordedBy + ' \\u00b7 ' + a.recordedAt));
      li.appendChild(el('p', 'faint', a.contentDigest
        ? 'content digest ' + a.contentDigest + ' \\u2014 ' + a.digestProvenance + ', never verified by HQ'
        : 'no content digest was declared for this version'));
      li.appendChild(el('p', 'faint', 'record digest ' + a.recordDigest));
      list.appendChild(li);
    }
    card.appendChild(list);
    if (product.artifactTotal > artifacts.length) {
      textLine(card, 'faint', 'Showing ' + artifacts.length + ' of ' + product.artifactTotal + ' recorded versions.');
    }
  }

  function renderReadiness(card, readiness) {
    if (readiness == null) return;
    textLine(card, 'order-label', 'Release readiness \\u2014 an observation, never an authorization');
    var blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
    if (blockers.length === 0) {
      textLine(card, 'muted', 'Nothing is missing from the record. That is not an approval and not a release.');
    } else {
      var list = document.createElement('ul');
      list.className = 'timeline';
      for (var i = 0; i < blockers.length; i++) {
        var li = document.createElement('li');
        li.appendChild(el('b', '', blockers[i].code));
        li.appendChild(el('p', '', blockers[i].statement));
        list.appendChild(li);
      }
      card.appendChild(list);
    }
    textLine(card, 'readonly-note', readiness.statement);
  }

  function renderPlan(card, plan) {
    if (plan == null || !Array.isArray(plan.missions)) return;
    textLine(card, 'order-label', 'Plan proposed by the ' + plan.templateId + ' template');
    textLine(card, 'faint', plan.templateStatement);
    var list = document.createElement('ul');
    list.className = 'timeline';
    for (var i = 0; i < plan.missions.length; i++) {
      var mission = plan.missions[i];
      var li = document.createElement('li');
      li.appendChild(el('b', '', mission.title));
      li.appendChild(el('p', '', mission.objective));
      li.appendChild(el('p', 'faint', 'plan items: ' + (mission.planItems || []).join(' \\u00b7 ')));
      list.appendChild(li);
    }
    card.appendChild(list);
    textLine(card, 'readonly-note', plan.statement);
    textLine(card, 'faint', 'Canonical path: ' + plan.canonicalPath);
  }

  function openDetail(card, productId) {
    jsonExchange(fetch(PRODUCT_DETAIL_PATH + '?productId=' + encodeURIComponent(productId), { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        var box = el('div', 'order-field');
        box.setAttribute('data-product-detail', productId);
        if (body.ok !== true) {
          textLine(box, 'muted', refusalText(result));
          card.appendChild(box);
          return;
        }
        renderPlan(box, body.plan);
        renderReadiness(box, body.readiness);
        card.appendChild(box);
      })
      .catch(function (error) {
        textLine(card, 'muted', 'The detail read failed (' + error.message + ').');
      });
  }

  function renderProduct(product, vocabulary, canCommand) {
    var card = el('article', 'panel product-card');
    card.setAttribute('data-product-card', product.id);

    var head = el('p', 'row');
    head.appendChild(el('b', '', product.name));
    var lifecycleChip = el('span', 'chip', String(product.lifecycle));
    lifecycleChip.setAttribute('data-product-lifecycle', String(product.lifecycle));
    head.appendChild(lifecycleChip);
    head.appendChild(el('span', 'chip', String(product.productType)));
    card.appendChild(head);

    textLine(card, 'faint', product.id + ' \\u00b7 registered by ' + product.createdBy + ' \\u00b7 ' + product.createdAt);
    textLine(card, 'faint', 'Canonical project: ' + product.projectId + ' \\u2014 this product references that register entry and does not replace it.');
    textLine(card, '', 'Problem: ' + product.problem);
    textLine(card, '', 'For: ' + product.targetUsers);
    if (product.summary) textLine(card, 'muted', product.summary);
    textLine(card, 'faint', product.lifecycleStatement);

    renderArtifacts(card, product);

    var detailButton = document.createElement('button');
    detailButton.type = 'button';
    detailButton.className = 'order-live-submit';
    detailButton.textContent = 'Show the plan template and release readiness';
    detailButton.addEventListener('click', function () {
      detailButton.disabled = true;
      openDetail(card, product.id);
    });
    card.appendChild(detailButton);

    if (canCommand) {
      var moveBox = el('div', 'order-field');
      textLine(moveBox, 'order-label', 'Move the product lifecycle \\u2014 records a state; publishes nothing');
      var toInput = select(moveBox, 'To', vocabulary.lifecycleStates || []);
      var noteInput = textField(moveBox, 'Note', 'why \\u2014 required for every move');
      var moveOutcome = outcomeLine(moveBox);
      var moveButton = document.createElement('button');
      moveButton.type = 'button';
      moveButton.className = 'order-live-submit';
      moveButton.textContent = 'Record the move';
      moveButton.addEventListener('click', function () {
        var noteText = noteInput.value.trim();
        if (noteText === '') {
          moveOutcome.textContent = 'Every lifecycle move needs a recorded note. Nothing was sent.';
          return;
        }
        handleWrite(PRODUCT_LIFECYCLE_PATH, {
          productId: product.id,
          to: toInput.value,
          note: noteText,
          expectedState: product.lifecycle
        }, moveButton, moveOutcome, 'Recorded. Nothing external happened.');
      });
      moveBox.appendChild(moveButton);
      card.appendChild(moveBox);

      var artifactBox = el('div', 'order-field');
      textLine(artifactBox, 'order-label', 'Record the next artifact version \\u2014 append-only; the version number is derived by HQ');
      var kindInput = select(artifactBox, 'Kind', vocabulary.artifactKinds || []);
      var nameInput = textField(artifactBox, 'Name', 'artifact name (required)');
      var locatorInput = textField(artifactBox, 'Locator', 'where it is (required)');
      var digestInput = textField(artifactBox, 'Content digest', 'sha256 hex (optional) \\u2014 recorded as declared, never verified');
      var artifactOutcome = outcomeLine(artifactBox);
      var artifactButton = document.createElement('button');
      artifactButton.type = 'button';
      artifactButton.className = 'order-live-submit';
      artifactButton.textContent = 'Record the version';
      artifactButton.addEventListener('click', function () {
        var payload = {
          productId: product.id,
          kind: kindInput.value,
          name: nameInput.value.trim(),
          locator: locatorInput.value.trim()
        };
        if (payload.name === '' || payload.locator === '') {
          artifactOutcome.textContent = 'An artifact version needs a name and a locator. Nothing was sent.';
          return;
        }
        if (digestInput.value.trim() !== '') payload.contentDigest = digestInput.value.trim();
        handleWrite(PRODUCT_ARTIFACTS_PATH, payload, artifactButton, artifactOutcome, 'Recorded as a new version.');
      });
      artifactBox.appendChild(artifactButton);
      card.appendChild(artifactBox);
    }

    listBox.appendChild(card);
  }

  function renderRegister(body, canCommand, reason) {
    listBox.textContent = '';
    var vocabulary = body.vocabulary || {};
    var products = Array.isArray(body.products) ? body.products : [];
    if (canCommand) {
      var createBox = el('div', 'order-field');
      createBox.setAttribute('data-product-create', '');
      textLine(createBox, 'order-label', 'Register a product against a canonical project');
      var projectInput = textField(createBox, 'Project id', 'the canonical hq_projects id (required)');
      var typeInput = select(createBox, 'Product type', vocabulary.productTypes || []);
      var nameInput = textField(createBox, 'Name', 'name (required)');
      var problemInput = textField(createBox, 'Problem', 'the problem it solves (required)');
      var usersInput = textField(createBox, 'Target users', 'who it is for (required)');
      var summaryInput = textField(createBox, 'Summary', 'summary (optional)');
      var createOutcome = outcomeLine(createBox);
      var createButton = document.createElement('button');
      createButton.type = 'button';
      createButton.className = 'order-live-submit';
      createButton.textContent = 'Register the product';
      createButton.addEventListener('click', function () {
        var payload = {
          projectId: projectInput.value.trim(),
          productType: typeInput.value,
          name: nameInput.value.trim(),
          problem: problemInput.value.trim(),
          targetUsers: usersInput.value.trim()
        };
        if (payload.projectId === '' || payload.name === '' || payload.problem === '' || payload.targetUsers === '') {
          createOutcome.textContent = 'A product needs a canonical project id, a name, a problem and its target users. Nothing was sent.';
          return;
        }
        if (summaryInput.value.trim() !== '') payload.summary = summaryInput.value.trim();
        handleWrite(PRODUCTS_PATH, payload, createButton, createOutcome, 'Registered.');
      });
      createBox.appendChild(createButton);
      listBox.appendChild(createBox);
    } else {
      textLine(listBox, 'readonly-note', 'Product Factory controls are off for this session \\u2014 ' + reason);
    }
    if (typeof body.releaseGate === 'string') {
      textLine(listBox, 'readonly-note', body.releaseGate);
    }
    if (products.length === 0) {
      textLine(listBox, 'muted', 'HQ holds no registered product. 0 means 0 \\u2014 nothing is invented to fill this register.');
      return;
    }
    for (var i = 0; i < products.length; i++) {
      renderProduct(products[i], vocabulary, canCommand);
    }
    if (body.truncated === true) {
      textLine(listBox, 'faint', 'Showing ' + products.length + ' of ' + body.total + ' registered products.');
    }
  }

  function reload() {
    jsonExchange(fetch(PRODUCTS_PATH, { headers: { accept: 'application/json' } }))
      .then(function (result) {
        var body = result.body || {};
        if (body.ok !== true || !Array.isArray(body.products)) {
          stayOff('the register read was refused \\u2014 ' + refusalText(result));
          return;
        }
        var grant = grantedControls(sessionAnswer);
        note.setAttribute('data-product-factory-state', 'live');
        note.className = 'readonly-note console-state console-state-live';
        note.textContent = 'Live: ' + body.total + ' registered product(s), read from the canonical register just now. ' +
          'Nothing on this page can release, publish or deploy anything.';
        renderRegister(body, grant.productCommand, grant.reason);
      })
      .catch(function (error) {
        stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
      });
  }

  jsonExchange(fetch(SESSION_PATH, { headers: { accept: 'application/json' } }))
    .then(function (result) {
      sessionAnswer = result.body;
      if (result.body == null || typeof result.body !== 'object' || result.body.founder !== true) {
        stayOff(grantedControls(result.body).reason);
        return;
      }
      reload();
    })
    .catch(function (error) {
      stayOff('the HQ control API is not reachable from this page (' + error.message + ').');
    });
})();
</script>`;
}
