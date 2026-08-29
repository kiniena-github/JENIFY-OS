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
  CONTROL_ROUTES.orders,
  CONTROL_ROUTES.approve,
  CONTROL_ROUTES.deny,
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
  var off = { directOrder: false, approve: false, deny: false, reason: '' };
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
    reason: stated !== '' ? stated : 'A control the session did not grant as exactly true is not drawn.'
  };
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
const DOM_HELPERS_JS = `function el(tag, className, text) {
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
}`;

/**
 * Command Center: the Direct Order composer's live console.
 *
 * Static markup stays inert. This script asks `/session`; a granted
 * `directOrder` control builds a real composer (instruction, optional
 * project/title, route choice, Start Task) inside the mount; anything else
 * writes one truthful line about why nothing is drawn.
 */
export function directOrderConsoleScript(): string {
  return `<script>
(function () {
  var mount = document.querySelector('[data-order-console]');
  if (!mount || typeof window.fetch !== 'function') return;

  ${CONTROL_GRANT_JS}
  ${ORDER_KEY_JS}
  ${DOM_HELPERS_JS}

  var SESSION_PATH = ${jsonForScript(CONTROL_ROUTES.session)};
  var ORDERS_PATH = ${jsonForScript(CONTROL_ROUTES.orders)};

  var note = el('p', 'faint', 'Checking with the control API whether this session grants the composer\\u2026');
  note.setAttribute('data-order-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  function stayOff(reason) {
    note.setAttribute('data-order-console-state', 'off');
    note.textContent = 'Browser submission stays off: ' + reason +
      ' The static composer above remains read-only, and nothing on this page submits.';
  }

  function buildComposer(session) {
    note.setAttribute('data-order-console-state', 'granted');
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
            outcome.textContent = kind === 'created'
              ? 'Order created as task ' + body.taskId + ' (risk ' + body.riskClass + ', route ' +
                (body.route && body.route.requested) + ' \\u2192 ' + (body.route && body.route.resolved) +
                '). It awaits Founder approval and executes nothing until then.'
              : 'This exact order already exists as task ' + body.taskId +
                ' \\u2014 deduplicated; no second task was created.';
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

  var note = el('p', 'faint', 'Checking with the control API whether this session grants decision controls\\u2026');
  note.setAttribute('data-approvals-console-state', 'checking');
  note.setAttribute('role', 'status');
  mount.appendChild(note);

  function stayOff(reason) {
    note.setAttribute('data-approvals-console-state', 'off');
    note.textContent = 'Live decision controls stay off: ' + reason +
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
