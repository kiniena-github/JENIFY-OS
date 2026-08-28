/**
 * The Founder control console — the browser half of the HQ control API
 * (issue #200, integration lane).
 *
 * ## The invariant this file re-scopes, stated precisely
 *
 * The HQ site's original invariant was "nothing on any page executes
 * anything", enforced as: no `<form>`, no `<button>`, no `<input>`, no inline
 * handler in any rendered page. That wording described a site with no
 * authentication boundary. The boundary now exists (`live/auth.ts`,
 * `live/control-api.ts`), so the invariant becomes the stronger property:
 *
 *   1. The STATIC MARKUP still contains no form, button, input or inline
 *      handler — every write control is constructed at runtime, by this
 *      script only.
 *   2. No control is constructed unless `GET /api/hq/control/session`
 *      granted it: `controlPlan` is deny-by-default, and an unreachable,
 *      unmounted, unparseable or non-granting answer draws NOTHING.
 *   3. The only mutations any shipped script performs are POSTs to the three
 *      canonical control routes — the same seam the CLI has, not a wider one.
 *   4. No request body ever names an actor. Who is acting is the server's
 *      decision (session → Founder map → registry); the API refuses a body
 *      carrying an identity-shaped key, and this console never sends one.
 *
 * Both halves are tested by EXECUTING the shipped source
 * (`test/control-console.test.ts`), the same way `FRESHNESS_VERDICT_JS` is
 * tested — a grep for a label would pass even if the guard behind it were
 * wrong.
 *
 * ## Why progressive upgrade rather than a rendered form
 *
 * The same static pages are served in places with no control plane at all —
 * `file://`, a plain static host, a deployment with `mutationsEnabled: false`.
 * Rendering a form there would draw a control that cannot work, which is the
 * exact dishonesty the original invariant existed to prevent. Building the
 * form only after the session probe grants it means the drawn UI and the
 * server's answer cannot disagree: the availability calculation lives in
 * `control-api.ts` (`controlAvailability`), is derived from the same
 * conditions that refuse the write, and this script adds no availability
 * logic of its own beyond `=== true`.
 *
 * All server-supplied text is written with `textContent`, never as HTML, and
 * every control-API response already passed `assertBrowserSafe` server-side.
 */

import {
  CONTROL_ROUTES,
  MAX_APPROVAL_NOTE_LENGTH,
  MAX_DENIAL_REASON_LENGTH,
} from '../live/control-api.js';
import { DIRECT_ORDER_ROUTES } from '../live/orders.js';

/**
 * The deny-by-default availability decision, as browser-executable source.
 *
 * One implementation, embedded verbatim and executed directly by the tests.
 * Every grant check is `=== true` — a missing field, a truthy string, a
 * malformed body, an unexpected status all draw nothing.
 */
export const CONTROL_PLAN_JS = `function controlPlan(status, body) {
  var none = { directOrder: false, approve: false, deny: false };
  if (status === 0) {
    return { state: 'unreachable', controls: none, message: 'The HQ control API could not be reached, so this page stays read-only. It is being served without the JENIFY OS control plane (static hosting or file://), or the host is down.' };
  }
  if (status === 404) {
    return { state: 'unavailable', controls: none, message: 'This host does not mount the HQ control plane, so browser controls stay off and this page stays read-only.' };
  }
  if (status === 401) {
    return { state: 'signed_out', controls: none, message: (body && typeof body.message === 'string') ? body.message : 'Sign in to JENIFY OS first. HQ has no sign-in of its own.' };
  }
  if (!body || typeof body !== 'object' || body.ok !== true) {
    return { state: 'unavailable', controls: none, message: 'The HQ control API answered in an unexpected shape, so no control is drawn.' };
  }
  if (body.founder !== true) {
    return { state: 'no_authority', controls: none, message: (typeof body.message === 'string' && body.message !== '') ? body.message : 'This signed-in account is not the HQ Founder, so no control is drawn.' };
  }
  var advertised = (body.controls && typeof body.controls === 'object') ? body.controls : {};
  var granted = {
    directOrder: advertised.directOrder === true,
    approve: advertised.approve === true,
    deny: advertised.deny === true
  };
  if (!granted.directOrder && !granted.approve && !granted.deny) {
    var why = 'this Founder principal holds no browser-writable grant here.';
    if (advertised.mutationsEnabled === false) why = 'HQ browser writes are switched off for this deployment.';
    else if (advertised.trustedOriginConfigured === false) why = 'no trusted origin is configured for HQ browser control, so every write would be refused.';
    return { state: 'no_authority', controls: granted, message: 'Founder session verified, but no control is granted: ' + why };
  }
  return { state: 'ready', controls: granted, message: 'Founder session verified. Only the controls the control API granted are drawn here; every write goes to the Founder-gated canonical queue.' };
}`;

/**
 * The full console, as one self-executing script body.
 *
 * Exported separately from the `<script>` wrapper so tests can run it with a
 * fake `document`/`fetch` and assert what it actually constructs and sends.
 */
export const CONTROL_CONSOLE_JS = `(function () {
  var ROUTES = ${JSON.stringify(CONTROL_ROUTES)};
  var ORDER_ROUTES = ${JSON.stringify([...DIRECT_ORDER_ROUTES])};
  var MAX_NOTE = ${MAX_APPROVAL_NOTE_LENGTH};
  var MAX_REASON = ${MAX_DENIAL_REASON_LENGTH};
  var mounts = document.querySelectorAll('[data-hq-control]');
  if (!mounts || mounts.length === 0) return;

  ${CONTROL_PLAN_JS}

  function setStatus(mount, text) {
    var target = mount.querySelector('[data-hq-control-status]');
    if (target) target.textContent = text;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function parse(response) {
    return response.json().then(
      function (parsed) { return { status: response.status, body: parsed }; },
      function () { return { status: response.status, body: null }; }
    );
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(parse);
  }

  function errorText(result, fallback) {
    var body = result.body;
    var message = (body && body.error && typeof body.error.message === 'string') ? body.error.message : fallback;
    var code = (body && body.error && typeof body.error.code === 'string') ? body.error.code : ('http_' + result.status);
    if (result.status === 429) return 'RATE LIMITED (' + code + '): ' + message;
    if (result.status === 403) return 'REFUSED (' + code + '): ' + message;
    if (result.status === 401) return 'SIGNED OUT (' + code + '): ' + message;
    return 'FAILED ' + result.status + ' (' + code + '): ' + message;
  }

  function labelled(labelText, node) {
    var wrap = el('div', 'order-field');
    wrap.appendChild(el('p', 'order-label', labelText));
    wrap.appendChild(node);
    return wrap;
  }

  function buildOrderForm(mount) {
    var host = mount.querySelector('[data-hq-control-mount]');
    if (!host) return;
    host.textContent = '';

    var form = el('form', 'hq-live-form');
    var titleInput = el('input');
    titleInput.setAttribute('maxlength', '200');
    var projectInput = el('input');
    var instructionInput = el('textarea');
    instructionInput.setAttribute('required', 'required');
    var routeSelect = el('select');
    for (var i = 0; i < ORDER_ROUTES.length; i++) {
      var option = el('option', null, ORDER_ROUTES[i]);
      option.setAttribute('value', ORDER_ROUTES[i]);
      routeSelect.appendChild(option);
    }
    form.appendChild(labelled('Instruction — a brief for a worker, never a command to run', instructionInput));
    form.appendChild(labelled('Title (optional)', titleInput));
    form.appendChild(labelled('Project (optional — a label, never authority)', projectInput));
    form.appendChild(labelled('Route — an explicit CLAUDE/CODEX never falls back; AUTO picks only a provider evidence shows dispatchable', routeSelect));

    var submit = el('button', 'hq-live-submit', 'Start Task — goes to Founder Approval');
    submit.setAttribute('type', 'submit');
    form.appendChild(submit);
    var out = el('p', 'hq-live-result');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var instruction = String(instructionInput.value || '').trim();
      if (instruction === '') {
        out.textContent = 'An instruction is required.';
        return;
      }
      // Deliberately NO identity, actor or principal field: who is acting is
      // the server's decision, and the API refuses a body that names one.
      var payload = { instruction: instruction, route: String(routeSelect.value || 'AUTO') };
      var title = String(titleInput.value || '').trim();
      if (title !== '') payload.title = title;
      var project = String(projectInput.value || '').trim();
      if (project !== '') payload.project = project;
      submit.setAttribute('disabled', 'disabled');
      out.textContent = 'Submitting\\u2026';
      postJson(ROUTES.orders, payload).then(function (result) {
        submit.removeAttribute('disabled');
        if (result.body && result.body.ok === true) {
          var body = result.body;
          var route = body.route || {};
          out.textContent = [
            body.deduplicated ? 'Matched an existing identical order \\u2014 no duplicate was created.' : 'Order created.',
            'Task ' + body.taskId + ' \\u2014 status ' + body.status + (body.requiresFounderApproval === true ? ' (executes NOTHING until a Founder approves this exact action)' : ''),
            'Route ' + route.requested + ' \\u2192 ' + route.resolved + (route.reason ? ' \\u2014 ' + route.reason : ''),
            'Action digest ' + String(body.actionDigest || '').slice(0, 16) + '\\u2026'
          ].join('\\n');
        } else {
          var text = errorText(result, 'The order was not created.');
          var candidates = result.body ? result.body.route : null;
          if (candidates && candidates.length) {
            for (var i = 0; i < candidates.length; i++) {
              var candidate = candidates[i];
              text += '\\n' + candidate.provider + ': ' + (candidate.connected ? 'connected' : 'not connected');
              if (candidate.missingFacts && candidate.missingFacts.length) {
                text += ' (missing: ' + candidate.missingFacts.join(', ') + ')';
              }
            }
            text += '\\nNo other provider is ever substituted.';
          }
          out.textContent = text;
        }
      });
    });

    host.appendChild(form);
    host.appendChild(out);
  }

  function buildApprovals(mount, granted) {
    var host = mount.querySelector('[data-hq-control-mount]');
    if (!host) return;

    function card(approval) {
      var box = el('article', 'card hq-live-approval');
      box.appendChild(el('h3', null, approval.title != null ? approval.title : approval.taskId));
      if (approval.ask) box.appendChild(el('p', 'muted', approval.ask));
      box.appendChild(el('p', 'faint',
        approval.taskId + ' \\u00b7 ' + approval.capabilityId + ' \\u00b7 risk ' + approval.riskClass +
        ' \\u00b7 opened by ' + approval.createdBy + ' \\u00b7 digest ' + String(approval.actionDigest || '').slice(0, 16) + '\\u2026'));
      var out = el('p', 'hq-live-result');
      var controls = el('div', 'decision-controls');

      var stepUpInput = null;
      if (approval.stepUpRequired === true) {
        stepUpInput = el('input');
        stepUpInput.setAttribute('type', 'password');
        box.appendChild(labelled('Step-up: your JENIFY OS password (required for this risk class unless your session is under five minutes old)', stepUpInput));
      }

      if (granted.approve === true && approval.selfApproval !== true) {
        var noteInput = el('input');
        noteInput.setAttribute('maxlength', String(MAX_NOTE));
        box.appendChild(labelled('Approval note (optional \\u2014 stored permanently and shown in the console)', noteInput));
        var approveButton = el('button', 'hq-live-approve', 'Approve this exact action');
        approveButton.setAttribute('type', 'button');
        approveButton.addEventListener('click', function () {
          var payload = { taskId: approval.taskId, expectedActionDigest: approval.actionDigest };
          var note = String(noteInput.value || '').trim();
          if (note !== '') payload.note = note;
          if (stepUpInput && String(stepUpInput.value || '') !== '') payload.stepUpPassword = String(stepUpInput.value);
          out.textContent = 'Approving\\u2026';
          postJson(ROUTES.approve, payload).then(function (result) {
            if (result.body && result.body.ok === true) {
              out.textContent = 'Approved \\u2014 task ' + result.body.taskId + ' is now ' + result.body.status + '.';
              refresh();
            } else {
              out.textContent = errorText(result, 'Nothing was approved.');
            }
          });
        });
        controls.appendChild(approveButton);
      }
      if (approval.selfApproval === true) {
        controls.appendChild(el('span', 'faint', 'No Approve control is drawn: the canonical no-self-approval rule refuses the principal this order was opened as.'));
      }

      if (granted.deny === true) {
        var reasonInput = el('textarea');
        reasonInput.setAttribute('maxlength', String(MAX_REASON));
        box.appendChild(labelled('Denial reason (required to deny \\u2014 recorded immutably)', reasonInput));
        var denyButton = el('button', 'hq-live-deny', 'Deny');
        denyButton.setAttribute('type', 'button');
        denyButton.addEventListener('click', function () {
          var reason = String(reasonInput.value || '').trim();
          if (reason === '') {
            out.textContent = 'A denial needs a reason. Nothing was sent.';
            return;
          }
          out.textContent = 'Denying\\u2026';
          postJson(ROUTES.deny, { taskId: approval.taskId, reason: reason, expectedActionDigest: approval.actionDigest }).then(function (result) {
            if (result.body && result.body.ok === true) {
              out.textContent = 'Denied \\u2014 task ' + result.body.taskId + ' is now ' + result.body.status + '.';
              refresh();
            } else {
              out.textContent = errorText(result, 'Nothing was denied.');
            }
          });
        });
        controls.appendChild(denyButton);
      }

      box.appendChild(controls);
      box.appendChild(out);
      return box;
    }

    function refresh() {
      fetch(ROUTES.approvals, { credentials: 'same-origin', cache: 'no-store' })
        .then(parse)
        .then(function (result) {
          host.textContent = '';
          var body = result.body;
          if (!(body && body.ok === true && body.approvals && typeof body.approvals.length === 'number')) {
            host.appendChild(el('p', 'faint', 'Could not load the pending approvals (HTTP ' + result.status + ').'));
            return;
          }
          if (body.approvals.length === 0) {
            host.appendChild(el('p', 'faint', 'No approval is pending right now.'));
            return;
          }
          for (var i = 0; i < body.approvals.length; i++) host.appendChild(card(body.approvals[i]));
        })
        .catch(function () {
          host.textContent = '';
          host.appendChild(el('p', 'faint', 'Could not reach the approvals route; nothing is drawn.'));
        });
    }

    refresh();
  }

  fetch(ROUTES.session, { credentials: 'same-origin', cache: 'no-store' })
    .then(parse)
    .catch(function () { return { status: 0, body: null }; })
    .then(function (result) {
      var plan = controlPlan(result.status, result.body);
      for (var i = 0; i < mounts.length; i++) {
        var mount = mounts[i];
        var kind = mount.getAttribute('data-hq-control');
        setStatus(mount, plan.message);
        if (kind === 'direct-order' && plan.controls.directOrder === true) {
          buildOrderForm(mount);
        }
        if (kind === 'approvals' && (plan.controls.approve === true || plan.controls.deny === true)) {
          buildApprovals(mount, plan.controls);
        }
      }
    });
})();`;

/** The console wrapped for embedding in a rendered page. */
export function controlConsoleScript(): string {
  return `<script>
${CONTROL_CONSOLE_JS}
</script>`;
}
