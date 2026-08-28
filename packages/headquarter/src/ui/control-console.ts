/**
 * Session-gated live controls for the static HQ site (issue #200, LIVE HQ
 * CONTROL V1 integration).
 *
 * ## Why controls are drawn by script and never by the build
 *
 * The HQ pages are one static render served to every viewer, and whether a
 * control is real depends on WHO is looking: the same page is read by a
 * signed-out browser, a signed-in non-Founder, and the mapped Founder. A
 * build-time control would therefore always be a lie for somebody. So the
 * static markup carries NO form, button or input — the same literal invariant
 * the site has always tested — and this script asks the authenticated control
 * API (`GET /api/hq/control/session`) what this viewer's session actually
 * grants, then constructs exactly those controls with DOM calls. A viewer the
 * session does not entitle sees a truthful sentence about why, not a disabled
 * button pretending to be a feature.
 *
 * The old invariant was "nothing on any page can mutate anything". The
 * re-scoped invariant, which `test/control-console.test.ts` enforces at least
 * as strictly:
 *
 *   1. The STATIC markup still contains no form, no button, no input and no
 *      inline handler — nothing mutates without scripting, and nothing
 *      mutates from a page the control API never blessed.
 *   2. Every mutation this script can produce goes to the authenticated HQ
 *      control API and nowhere else: the only fetch targets are the
 *      `CONTROL_ROUTES` constants.
 *   3. No control is drawn that `/session` did not grant: the decision is the
 *      pure `controlVerdict` function below, which fails closed on anything
 *      malformed, and the tests execute that exact source.
 *   4. The script never names an actor. Who is acting is the server session's
 *      business; the request bodies carry no identity-shaped key, and the
 *      control API would refuse them if they did.
 *   5. Server text reaches the page through `textContent` only — this script
 *      contains no HTML injection sink (`innerHTML`, `document.write`, …).
 *
 * ## What the script does when there is no control API
 *
 * A static preview opened from `file://`, or a deployment that never enabled
 * the control plane, has no `/api/hq/control/session` to ask. The fetch fails,
 * the page keeps its truthful build-time sentence, and nothing interactive
 * ever appears. Absence of the API is rendered as absence of controls — never
 * as an error page, and never as a dead button.
 */

import { jsonForScript } from './components.js';
import { CONTROL_ROUTES } from '../live/control-api.js';

/**
 * The truthful static sentence for a control area. True with scripting, true
 * without it, and true on a page served with no control API behind it — the
 * one claim all three situations share.
 */
export const CONTROL_STATIC_NOTE =
  'Controls are drawn on this page only after the HQ control API confirms a signed-in JENIFY OS ' +
  'session that is mapped to the HQ Founder principal and granted the specific capability ' +
  '(GET /api/hq/control/session). If this sentence is all you see, this page cannot reach the ' +
  'control API — a static preview, or a deployment that has not enabled it — and everything here ' +
  'is read-only. No control is ever drawn that the session did not grant.';

/**
 * The control-availability decision, as browser-executable source.
 *
 * One implementation, embedded verbatim in the page and executed directly by
 * the tests (`new Function`) — the same discipline as `FRESHNESS_VERDICT_JS`,
 * and for the same reason: "which controls may be drawn" is exactly the kind
 * of claim that must be tested by running it, not by grepping a label.
 *
 * Fail closed everywhere: a malformed reply, a missing `controls` object, or
 * any flag that is not literally `true` draws nothing. The message prefers the
 * server's own denial text, which is already truthful and has already passed
 * the browser-safety guard.
 */
export const CONTROL_VERDICT_JS = `function controlVerdict(session) {
  var off = { directOrder: false, approve: false, deny: false, message: '' };
  if (session == null || typeof session !== 'object' || session.ok !== true) {
    off.message = 'The control API did not answer in the shape this page understands, so no control is drawn.';
    return off;
  }
  if (session.authenticated !== true) {
    off.message = 'Not signed in to JENIFY OS. HQ has no sign-in of its own — sign in to the JENIFY OS app on this host first. Until then this page is read-only.';
    return off;
  }
  if (session.founder !== true) {
    off.message = typeof session.message === 'string' && session.message !== ''
      ? session.message + ' This page stays read-only.'
      : 'This account is signed in but is not the mapped HQ Founder, so no control is drawn.';
    return off;
  }
  var controls = session.controls;
  if (controls == null || typeof controls !== 'object') {
    off.message = 'The session reply named no control availability, so no control is drawn.';
    return off;
  }
  var verdict = {
    directOrder: controls.directOrder === true,
    approve: controls.approve === true,
    deny: controls.deny === true,
    message: ''
  };
  if (!verdict.directOrder && !verdict.approve && !verdict.deny) {
    if (controls.mutationsEnabled === false) {
      verdict.message = 'Signed in as the mapped Founder, but HQ browser writes are switched off for this deployment. Read-only is the configured posture, so no control is drawn.';
    } else if (controls.trustedOriginConfigured === false) {
      verdict.message = 'Signed in as the mapped Founder, but no trusted origin is configured, so every write would be refused. No control is drawn until the deployment configures one.';
    } else {
      verdict.message = 'Signed in as the mapped Founder, but this principal holds no grant a browser control here could use. No control is drawn.';
    }
  } else {
    verdict.message = 'Live controls granted by this session. Every action still passes the canonical Operator rules server-side: deny by default, Founder gating by action digest, no self-approval, no provider substitution.';
  }
  return verdict;
}`;

/**
 * Truthful rendering of a create-order response. Pure and test-executed.
 *
 * The blocked branch is the one honesty rule the composer must never soften:
 * a provider that is not connected is reported BLOCKED with the server's own
 * per-candidate verdicts (fact NAMES, never values), and nothing suggests a
 * substitute.
 */
export const ORDER_OUTCOME_JS = `function orderOutcome(status, body) {
  if (body == null || typeof body !== 'object') {
    return { kind: 'error', text: 'The order endpoint answered HTTP ' + status + ' with an unreadable body, so nothing can be claimed about the order.' };
  }
  if (body.ok === true) {
    var head = body.deduplicated === true
      ? 'This matched an existing identical order, so no second task was created. Task ' + body.taskId + '.'
      : 'Order created as task ' + body.taskId + '.';
    var gate = body.requiresFounderApproval === true
      ? ' It executes NOTHING until a Founder approves this exact action (digest ' + String(body.actionDigest).slice(0, 16) + '\\u2026).'
      : ' Status: ' + body.status + '.';
    var routeText = '';
    if (body.route != null && typeof body.route === 'object' && !Array.isArray(body.route) && body.route.resolved) {
      routeText = ' Route ' + body.route.requested + ' \\u2192 ' + body.route.resolved + ' \\u2014 binding at execution, never substituted.';
    }
    return { kind: body.deduplicated === true ? 'deduplicated' : 'created', text: head + gate + routeText };
  }
  var error = body.error != null && typeof body.error === 'object' ? body.error : { code: 'unknown', message: 'no error detail was returned' };
  if (error.code === 'provider_not_connected') {
    var text = 'BLOCKED \\u2014 ' + error.message + ' Nothing was created and no other provider was substituted.';
    if (Array.isArray(body.route)) {
      for (var index = 0; index < body.route.length; index += 1) {
        var candidate = body.route[index];
        if (candidate == null || typeof candidate !== 'object') continue;
        text += '\\n' + candidate.provider + ': ' + (candidate.connected === true ? 'dispatchable' : 'NOT CONNECTED') + ' \\u2014 ' + candidate.reason;
      }
    }
    return { kind: 'blocked', text: text };
  }
  return { kind: 'refused', text: 'Refused (' + error.code + '): ' + error.message + ' Nothing was created.' };
}`;

/** Truthful rendering of an approve/deny response. Pure and test-executed. */
export const DECISION_OUTCOME_JS = `function decisionOutcome(action, status, body) {
  if (body == null || typeof body !== 'object') {
    return { kind: 'error', text: 'The ' + action + ' endpoint answered HTTP ' + status + ' with an unreadable body, so nothing can be claimed about the decision.' };
  }
  if (body.ok === true) {
    return { kind: 'done', text: 'The ' + action + ' was recorded. Task ' + body.taskId + ' is now ' + body.status + '.' };
  }
  var error = body.error != null && typeof body.error === 'object' ? body.error : { code: 'unknown', message: 'no error detail was returned' };
  if (error.code === 'step_up_required' || error.code === 'step_up_failed' || error.code === 'step_up_rate_limited' || error.code === 'step_up_unavailable') {
    return { kind: 'step_up', text: error.message };
  }
  if (error.code === 'action_digest_mismatch') {
    return { kind: 'refused', text: 'Refused: the action changed since this card was rendered, so the ' + action + ' bound to the old digest was not applied. Refresh the list and read the action again.' };
  }
  return { kind: 'refused', text: 'Refused (' + error.code + '): ' + error.message };
}`;

/**
 * The inline script wiring the Direct Order composer (Command Center) and the
 * Founder decision console (Approvals page). One source serves both pages —
 * each page carries only the container the script looks for, so the same
 * tested code path decides everything.
 */
export function controlConsoleScript(): string {
  const sessionUrl = jsonForScript(CONTROL_ROUTES.session);
  const ordersUrl = jsonForScript(CONTROL_ROUTES.orders);
  const approvalsUrl = jsonForScript(CONTROL_ROUTES.approvals);
  const approveUrl = jsonForScript(CONTROL_ROUTES.approve);
  const denyUrl = jsonForScript(CONTROL_ROUTES.deny);

  return `<script>
(function () {
  var SESSION_URL = ${sessionUrl};
  var ORDERS_URL = ${ordersUrl};
  var APPROVALS_URL = ${approvalsUrl};
  var APPROVE_URL = ${approveUrl};
  var DENY_URL = ${denyUrl};

  var composerRoot = document.querySelector('[data-hq-order-composer]');
  var approvalsRoot = document.querySelector('[data-hq-approvals]');
  if (!composerRoot && !approvalsRoot) return;

  ${CONTROL_VERDICT_JS}
  ${ORDER_OUTCOME_JS}
  ${DECISION_OUTCOME_JS}

  function say(root, text) {
    var status = root.querySelector('[data-hq-control-status]');
    if (status) status.textContent = text;
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function labelled(labelText, control) {
    var wrap = make('div', 'order-field');
    var label = make('label', 'order-label', labelText);
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  /* A fresh submission identity. Reused for retries of the SAME submission so
     a network blip cannot double-create; regenerated after a success so
     deliberately sending the identical text again is a new order. The server
     MIXES this into its derived key — it can never name another order's key. */
  function freshKey() {
    if (window.crypto && window.crypto.getRandomValues) {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      var out = '';
      for (var index = 0; index < bytes.length; index += 1) {
        out += (bytes[index] + 256).toString(16).slice(1);
      }
      return 'hq-browser-' + out;
    }
    return 'hq-browser-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().then(
        function (body) { return { status: response.status, body: body }; },
        function () { return { status: response.status, body: null }; }
      );
    });
  }

  /* ---------------- Direct Order composer ---------------- */

  function drawComposer(root) {
    var form = document.createElement('form');
    form.className = 'hq-live-form';
    form.setAttribute('data-hq-live', 'order');

    var instruction = document.createElement('textarea');
    instruction.rows = 4;
    instruction.required = true;
    instruction.maxLength = 4000;
    instruction.placeholder = 'What you want done, in your own words. A brief for a worker, never a command to run.';

    var project = document.createElement('input');
    project.type = 'text';
    project.placeholder = 'Optional label. Labels are presentation, never authority.';

    var titleField = document.createElement('input');
    titleField.type = 'text';
    titleField.maxLength = 120;
    titleField.placeholder = 'Optional short label. This is the ONE part of an order published to the browser snapshot.';

    var routeSelect = document.createElement('select');
    var routeNames = ['AUTO', 'CLAUDE', 'CODEX'];
    for (var index = 0; index < routeNames.length; index += 1) {
      var option = document.createElement('option');
      option.value = routeNames[index];
      option.textContent = routeNames[index];
      routeSelect.appendChild(option);
    }

    var submit = make('button', null, 'Start Task');
    submit.type = 'submit';

    var result = make('p', 'muted hq-live-result');
    result.setAttribute('data-hq-order-result', '');

    var submissionKey = freshKey();

    form.addEventListener('submit', function (submitEvent) {
      submitEvent.preventDefault();
      submit.disabled = true;
      result.textContent = 'Submitting\\u2026';
      var payload = { instruction: instruction.value, route: routeSelect.value, idempotencyKey: submissionKey };
      if (project.value.trim() !== '') payload.project = project.value.trim();
      if (titleField.value.trim() !== '') payload.title = titleField.value.trim();
      postJson(ORDERS_URL, payload)
        .then(function (reply) {
          var outcome = orderOutcome(reply.status, reply.body);
          result.textContent = outcome.text;
          if (outcome.kind === 'created' || outcome.kind === 'deduplicated') {
            submissionKey = freshKey();
            instruction.value = '';
            titleField.value = '';
          }
        })
        .catch(function (problem) {
          result.textContent = 'The order could not be submitted (' + problem.message + '). Nothing can be claimed about it; retrying the same content is safe \\u2014 the submission key was kept, so it cannot double-create.';
        })
        .then(function () { submit.disabled = false; });
    });

    form.appendChild(labelled('Instruction', instruction));
    form.appendChild(labelled('Project (optional)', project));
    form.appendChild(labelled('Title (optional, published)', titleField));
    form.appendChild(labelled('Route', routeSelect));
    var controlsRow = make('div', 'decision-controls');
    controlsRow.appendChild(submit);
    form.appendChild(controlsRow);
    form.appendChild(result);
    root.appendChild(form);
  }

  /* ---------------- Founder decision console ---------------- */

  function drawApprovalCard(listNode, card, verdict, refresh) {
    var article = make('article', 'card hq-live-approval');
    article.setAttribute('data-hq-live-approval', String(card.taskId));

    article.appendChild(make('h3', null, card.title != null ? String(card.title) : String(card.taskId)));
    article.appendChild(make('p', 'muted', String(card.ask)));
    article.appendChild(make('p', 'faint',
      String(card.taskId) + ' \\u00b7 ' + String(card.capabilityId) + ' \\u00b7 risk ' + String(card.riskClass) +
      ' \\u00b7 requested by ' + String(card.createdBy) + ' \\u00b7 digest ' + String(card.actionDigest).slice(0, 16) + '\\u2026'));

    var passwordInput = null;
    if (card.stepUpRequired === true) {
      passwordInput = document.createElement('input');
      passwordInput.type = 'password';
      passwordInput.autocomplete = 'current-password';
      passwordInput.placeholder = 'JENIFY OS password';
      article.appendChild(labelled(
        'Step-up \\u2014 this risk class is irreversible: re-enter your JENIFY OS password (a session younger than five minutes passes without it)',
        passwordInput));
    }

    var reasonInput = null;
    if (verdict.deny) {
      reasonInput = document.createElement('input');
      reasonInput.type = 'text';
      reasonInput.maxLength = 500;
      reasonInput.placeholder = 'Required to deny. Recorded permanently in the evidence log.';
      article.appendChild(labelled('Denial reason', reasonInput));
    }

    var result = make('p', 'muted hq-live-result');
    var row = make('div', 'decision-controls');

    function decide(action, url, payload) {
      result.textContent = 'Submitting\\u2026';
      if (passwordInput && passwordInput.value !== '') payload.stepUpPassword = passwordInput.value;
      postJson(url, payload).then(function (reply) {
        var outcome = decisionOutcome(action, reply.status, reply.body);
        result.textContent = outcome.text;
        if (passwordInput) passwordInput.value = '';
        if (outcome.kind === 'done') refresh();
      }).catch(function (problem) {
        result.textContent = 'The ' + action + ' could not be submitted (' + problem.message + '). Nothing can be claimed about it.';
      });
    }

    if (verdict.approve && card.selfApproval !== true) {
      var approveButton = make('button', null, 'Approve');
      approveButton.type = 'button';
      approveButton.addEventListener('click', function () {
        decide('approval', APPROVE_URL, { taskId: card.taskId, expectedActionDigest: card.actionDigest });
      });
      row.appendChild(approveButton);
    }
    if (card.selfApproval === true) {
      row.appendChild(make('span', 'faint', 'You created this order, and the canonical no-self-approval rule refuses your approval \\u2014 no Approve control is drawn. A different approval-authorized principal must decide it.'));
    }
    if (verdict.deny) {
      var denyButton = make('button', null, 'Deny');
      denyButton.type = 'button';
      denyButton.addEventListener('click', function () {
        var reason = reasonInput ? reasonInput.value.trim() : '';
        if (reason === '') {
          result.textContent = 'A denial needs a reason \\u2014 it is recorded permanently. Nothing was sent.';
          return;
        }
        decide('denial', DENY_URL, { taskId: card.taskId, expectedActionDigest: card.actionDigest, reason: reason });
      });
      row.appendChild(denyButton);
    }

    article.appendChild(row);
    article.appendChild(result);
    listNode.appendChild(article);
  }

  function drawApprovals(root, verdict) {
    var listNode = root.querySelector('[data-hq-live-approvals-list]');
    if (!listNode) {
      listNode = make('div', 'stack');
      listNode.setAttribute('data-hq-live-approvals-list', '');
      root.appendChild(listNode);
    }
    function refresh() {
      fetch(APPROVALS_URL, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          while (listNode.firstChild) listNode.removeChild(listNode.firstChild);
          if (body == null || typeof body !== 'object' || body.ok !== true || !Array.isArray(body.approvals)) {
            listNode.appendChild(make('p', 'muted', 'The live approval list could not be read, so no decision control is drawn.'));
            return;
          }
          if (body.approvals.length === 0) {
            listNode.appendChild(make('p', 'muted', 'No approval is pending right now (fetched live at ' + String(body.generatedAt) + ').'));
            return;
          }
          listNode.appendChild(make('p', 'faint', 'Fetched live from the control API at ' + String(body.generatedAt) + '. Each decision binds to the exact action digest shown \\u2014 if the action changes meanwhile, the decision is refused, never re-applied.'));
          for (var index = 0; index < body.approvals.length; index += 1) {
            drawApprovalCard(listNode, body.approvals[index], verdict, refresh);
          }
        })
        .catch(function (problem) {
          while (listNode.firstChild) listNode.removeChild(listNode.firstChild);
          listNode.appendChild(make('p', 'muted', 'The live approval list is unreachable (' + problem.message + '), so no decision control is drawn.'));
        });
    }
    refresh();
  }

  /* ---------------- Session gate ---------------- */

  fetch(SESSION_URL, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (response) {
      return response.json().then(function (body) { return body; }, function () { return null; });
    })
    .then(function (session) {
      var verdict = controlVerdict(session);
      if (composerRoot) {
        say(composerRoot, verdict.message);
        if (verdict.directOrder) drawComposer(composerRoot);
      }
      if (approvalsRoot) {
        say(approvalsRoot, verdict.message);
        if (verdict.approve || verdict.deny) drawApprovals(approvalsRoot, verdict);
      }
    })
    .catch(function (problem) {
      var text = 'The HQ control API is not reachable from this page (' + problem.message + '), so it stays read-only. That is the expected state for a static preview or a deployment that has not enabled the control plane.';
      if (composerRoot) say(composerRoot, text);
      if (approvalsRoot) say(approvalsRoot, text);
    });
})();
</script>`;
}
