/**
 * The narrow HQ browser-control API (issue #200, Founder decision of
 * 2026-08-28).
 *
 * ## Why it is a handler and not a framework plugin
 *
 * Headquarter imports no other workspace package and depends on no web
 * framework, and that independence is worth keeping: it means the whole
 * authority boundary can be exercised in a unit test with no server, no
 * socket, and no fixture that could accidentally differ from production. So
 * this file is a pure function from a reduced request to a reduced response.
 * The host adapts its own framework to it (`@factoryos/server`'s
 * `routes/headquarter.ts` does exactly that) and supplies the ports.
 *
 * ## What is exposed, and what deliberately is not
 *
 * Five routes, matched exactly, deny-by-default on everything else:
 *
 *   GET  /api/hq/control/session            who am I, and are the controls on
 *   GET  /api/hq/control/approvals          the pending approvals + digests
 *   POST /api/hq/control/orders             create a canonical direct order
 *   POST /api/hq/control/approvals/approve  approve the exact rendered action
 *   POST /api/hq/control/approvals/deny     deny, with a reason
 *
 * There is **no ask-for-changes route**, and its absence is a decision rather
 * than an omission. The canonical approval model has exactly two outcomes:
 * `approve` binds a single-use approval to an action digest, `deny` blocks the
 * task with an immutable reason. "Ask for changes" is a third state the
 * Operator does not track, and the two ways to fake it are both dishonest —
 * denying while calling it something softer misreports a blocked task, and
 * leaving the task pending while recording a note would show the Founder a
 * decision the queue never saw. The Founder decision authorised this route
 * "only where the existing approval model allows it"; it does not, so the UI
 * says so instead of drawing a button that lies.
 *
 * There is also **no generic mutation surface**: no route takes a table, a
 * column, a capability id to register, a principal to grant, or a SQL
 * fragment. The two writes call `submitDirectOrder` and
 * `HeadquarterOperations.approveTask`/`denyTask`, which is the whole point —
 * the browser gets the same seam the CLI has, not a wider one.
 *
 * ## The order every request goes through
 *
 * 1. route match (unknown → 404, revealing nothing)
 * 2. origin + content-type, on state-changing methods only
 * 3. client-identity scan — a body that names an actor is REFUSED
 * 4. session → account → explicit Founder map → registered active principal
 * 5. step-up, for approvals of irreversible risk classes
 * 6. the canonical call
 * 7. `assertBrowserSafe` over the response, before it leaves
 *
 * Step 7 is not decoration. Every response passes the same fail-closed guard
 * the polled snapshot passes, so a field added here later cannot carry a
 * credential to the browser without the guard throwing — and a throw becomes
 * an opaque 500, never a partial body.
 */

import { founderConsole, type ApprovalCard } from '../application/console.js';
import type { HeadquarterOperations } from '../application/service.js';
import { taskActionDigest } from '../operator/approvals.js';
import type { SecretsEnv } from '../routing/providers.js';
import {
  checkMutationOrigin,
  resolveFounderPrincipal,
  scanForClientIdentity,
  verifyStepUp,
  FOUNDER_DENIAL_STATUS,
  STEP_UP_RISK_CLASSES,
  type ControlAuditPort,
  type ControlRequest,
  type CredentialVerifierPort,
  type ResolvedFounder,
  type SessionResolverPort,
} from './auth.js';
import { assertBrowserSafe } from './redaction.js';
import {
  directOrderCapabilityState,
  submitDirectOrder,
  DIRECT_ORDER_ROUTES,
  type DirectOrderRoute,
} from './orders.js';
import type { HumanPrincipalPort } from '../application/principals.js';

export const CONTROL_API_PREFIX = '/api/hq/control';

export const CONTROL_ROUTES = {
  session: `${CONTROL_API_PREFIX}/session`,
  approvals: `${CONTROL_API_PREFIX}/approvals`,
  orders: `${CONTROL_API_PREFIX}/orders`,
  approve: `${CONTROL_API_PREFIX}/approvals/approve`,
  deny: `${CONTROL_API_PREFIX}/approvals/deny`,
} as const;

export interface ControlResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ControlApiDeps {
  ops: HeadquarterOperations;
  principals: HumanPrincipalPort;
  sessions: SessionResolverPort;
  /** RAW configured Founder map; parsed per request so a broken map fails closed. */
  founderMap: unknown;
  /** Trusted origins for state-changing requests. Empty ⇒ no mutations at all. */
  allowedOrigins: readonly string[];
  /** Provider facts for route resolution. Names only ever leave here, never values. */
  secretsEnv: SecretsEnv;
  credentials?: CredentialVerifierPort;
  audit?: ControlAuditPort;
  now?: () => Date;
}

function json(status: number, body: Record<string, unknown>): ControlResponse {
  return { status, body };
}

function refusal(status: number, code: string, message: string): ControlResponse {
  return json(status, { ok: false, error: { code, message } });
}

/**
 * Everything the browser is told about a pending approval.
 *
 * Note what is absent: the task PAYLOAD. It carries the Founder's own
 * instruction text, and the digest is what the approval binds to, so the
 * browser needs the digest and not the contents. Publishing the payload here
 * would undo the care `orders.ts` takes to keep instruction text off the wire.
 */
interface ApprovalView {
  taskId: string;
  capabilityId: string;
  riskClass: string;
  title: string | null;
  project: string | null;
  createdBy: string;
  createdAt: string;
  actionDigest: string;
  ask: string;
  /** True when approving this one will demand a fresh credential. */
  stepUpRequired: boolean;
  /** True when the canonical no-self-approval rule already refuses this Founder. */
  selfApproval: boolean;
}

function approvalView(card: ApprovalCard, founderId: string): ApprovalView {
  return {
    taskId: card.taskId,
    capabilityId: card.capabilityId,
    riskClass: card.classification.riskClass,
    title: card.title,
    project: card.project,
    createdBy: card.createdBy,
    createdAt: card.createdAt,
    actionDigest: card.actionDigest,
    ask: card.ask,
    stepUpRequired: STEP_UP_RISK_CLASSES.includes(card.classification.riskClass),
    selfApproval: card.createdBy === founderId,
  };
}

function stringField(body: unknown, key: string): string | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Handle one HQ control request.
 *
 * Never throws for a client's benefit: an unexpected error becomes an opaque
 * 500 so an internal message can never become an oracle.
 */
export function handleControlRequest(
  request: ControlRequest,
  deps: ControlApiDeps,
): ControlResponse {
  try {
    return route(request, deps);
  } catch {
    return refusal(500, 'internal', 'The request could not be completed.');
  }
}

function route(request: ControlRequest, deps: ControlApiDeps): ControlResponse {
  const method = request.method.toUpperCase();
  const path = request.path;
  const now = deps.now ?? (() => new Date());

  const known =
    (method === 'GET' && (path === CONTROL_ROUTES.session || path === CONTROL_ROUTES.approvals)) ||
    (method === 'POST' &&
      (path === CONTROL_ROUTES.orders ||
        path === CONTROL_ROUTES.approve ||
        path === CONTROL_ROUTES.deny));
  if (!known) {
    // Deny by default, and say nothing about what does exist.
    return refusal(404, 'not_found', 'No such HQ control route.');
  }

  const audit = (
    outcome: 'allowed' | 'refused',
    detail: string,
    founder?: ResolvedFounder,
  ): void => {
    deps.audit?.record({
      at: now().toISOString(),
      route: `${method} ${path}`,
      outcome,
      detail,
      ...(founder
        ? {
            accountId: founder.account.accountId,
            realmId: founder.account.realmId,
            principalId: founder.principal.id,
          }
        : {}),
    });
  };

  const origin = checkMutationOrigin(request, deps.allowedOrigins);
  if (!origin.ok) {
    audit('refused', origin.reason);
    return refusal(403, origin.reason, origin.message);
  }

  const identity = scanForClientIdentity(request.body);
  if (!identity.ok) {
    audit('refused', 'client_identity_supplied');
    return refusal(
      400,
      'client_identity_supplied',
      `This request tries to supply '${identity.key}'. Who is acting is decided by the ` +
        'server session and the configured Founder map only; a request that names an actor is ' +
        'refused rather than silently re-attributed.',
    );
  }

  const resolution = resolveFounderPrincipal(request, {
    sessions: deps.sessions,
    principals: deps.principals,
    founderMap: deps.founderMap,
  });

  // The session probe is the one route a signed-in non-Founder may call: it
  // exists so the UI can show "you are signed in, the controls are off" and
  // an accurate reason, instead of guessing from a failed mutation. It never
  // reveals which account IS the Founder.
  if (path === CONTROL_ROUTES.session) {
    if (!resolution.ok) {
      const authenticated = resolution.reason !== 'unauthenticated';
      audit('refused', resolution.reason);
      return safe(
        json(resolution.reason === 'unauthenticated' ? 401 : 200, {
          ok: true,
          authenticated,
          founder: false,
          reason: resolution.reason,
          message: resolution.message,
          controls: controlAvailability(deps, false),
        }),
      );
    }
    audit('allowed', 'session', resolution.founder);
    return safe(
      json(200, {
        ok: true,
        authenticated: true,
        founder: true,
        principalId: resolution.founder.principal.id,
        displayName: resolution.founder.principal.displayName,
        approvalAuthority: resolution.founder.principal.approvalAuthority,
        controls: controlAvailability(deps, true),
      }),
    );
  }

  if (!resolution.ok) {
    audit('refused', resolution.reason);
    return refusal(
      FOUNDER_DENIAL_STATUS[resolution.reason],
      resolution.reason,
      resolution.message,
    );
  }
  const founder = resolution.founder;

  if (method === 'GET' && path === CONTROL_ROUTES.approvals) {
    const console_ = founderConsole(deps.ops, now());
    audit('allowed', 'list_approvals', founder);
    return safe(
      json(200, {
        ok: true,
        generatedAt: console_.generatedAt,
        approvals: console_.approvals.map((card) => approvalView(card, founder.principal.id)),
      }),
    );
  }

  if (path === CONTROL_ROUTES.orders) return createOrder(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.approve) return approve(request, deps, founder, audit, now);
  return deny(request, deps, founder, audit);
}

type Audit = (outcome: 'allowed' | 'refused', detail: string, founder?: ResolvedFounder) => void;

/** What the UI may draw as live, derived from configuration rather than hope. */
function controlAvailability(deps: ControlApiDeps, founder: boolean): Record<string, unknown> {
  return {
    directOrder: founder && directOrderCapabilityState(deps.ops) === 'enabled',
    approve: founder,
    deny: founder,
    // Stated, not hidden: the canonical model has no third decision, so the
    // UI must not draw one. See the module docstring.
    askForChanges: false,
    askForChangesReason:
      'The canonical approval model records approve or deny only. A third outcome would be a ' +
      'state the Operator does not track, so it is not offered.',
  };
}

/** Guard every response body on the way out, exactly like the polled snapshot. */
function safe(response: ControlResponse): ControlResponse {
  try {
    assertBrowserSafe(response.body, 'control');
  } catch {
    return refusal(500, 'internal', 'The response could not be produced safely.');
  }
  return response;
}

function createOrder(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const instruction = stringField(request.body, 'instruction') ?? '';
  const routeName = stringField(request.body, 'route') ?? '';
  const project = stringField(request.body, 'project');
  const title = stringField(request.body, 'title');
  const clientKey = stringField(request.body, 'idempotencyKey');

  if (!DIRECT_ORDER_ROUTES.includes(routeName as DirectOrderRoute)) {
    audit('refused', 'invalid_route', founder);
    return refusal(
      400,
      'invalid_input',
      `Unknown route. Choose one of: ${DIRECT_ORDER_ROUTES.join(', ')}.`,
    );
  }

  const result = submitDirectOrder(
    deps.ops,
    {
      instruction,
      project,
      title,
      route: routeName as DirectOrderRoute,
      // The ONLY place the acting principal comes from. Not the body — the
      // body could not have carried it, the identity scan refuses it.
      requestedBy: founder.principal.id,
      // Earned, not asserted: a server-resolved JENIFY OS session mapped by
      // explicit configuration to this principal. This is the first interface
      // in Headquarter entitled to say so.
      actorAuthentication: 'authenticated_os_session',
      idempotencyKey: clientKey,
    },
    deps.secretsEnv,
  );

  if (!result.ok) {
    audit('refused', result.error.code, founder);
    // An authorization denial must not be reported as a bad request. The
    // registry refuses an ungranted principal through the generic
    // `enqueue_rejected` code — the only way that code can be reached from
    // here, since its other cause (a side-effect capability with no
    // idempotency key) cannot occur on a path that always derives one. So it
    // belongs with the 403s, and a browser is told "not allowed" rather than
    // "malformed", which is what the caller would otherwise try to fix.
    const status =
      result.error.code === 'provider_not_connected'
        ? 409
        : result.error.code === 'capability_not_registered' ||
            result.error.code === 'capability_disabled' ||
            result.error.code === 'unknown_principal' ||
            result.error.code === 'not_permitted' ||
            result.error.code === 'enqueue_rejected' ||
            result.error.code === 'kill_switch_engaged'
          ? 403
          : 400;
    return safe(
      json(status, {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
        // Candidate verdicts name missing FACTS, never their values — the
        // shape `routing/providers.ts` already guarantees.
        route: result.error.details?.candidates ?? null,
      }),
    );
  }

  audit('allowed', result.data.deduplicated ? 'order_deduplicated' : 'order_created', founder);
  const task = result.data.task;
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      taskId: task.id,
      status: task.status,
      deduplicated: result.data.deduplicated,
      capabilityId: task.capabilityId,
      riskClass: result.data.classification.riskClass,
      requiresFounderApproval: task.status === 'needs_approval',
      route: {
        requested: result.data.route.requested,
        resolved: result.data.route.resolved,
        reason: result.data.route.reason,
      },
      // Bound at creation so the browser can present the exact action it will
      // later be asked to approve.
      actionDigest: taskActionDigest(task),
    }),
  );
}

function approve(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const taskId = stringField(request.body, 'taskId') ?? '';
  const expectedActionDigest = stringField(request.body, 'expectedActionDigest') ?? '';
  const note = stringField(request.body, 'note');
  if (!taskId || !expectedActionDigest) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      'An approval needs a taskId and the action digest that was displayed.',
    );
  }

  // Step-up is decided from the CANONICAL capability of the task named in the
  // request, never from a risk class the client sends. An unknown task is
  // refused here rather than being allowed to skip the check and fail later.
  const task = deps.ops.queue.get(taskId);
  if (!task) {
    audit('refused', 'unknown_task', founder);
    return refusal(404, 'unknown_task', `Unknown task: ${taskId}`);
  }
  const capability = deps.ops.queue.capabilities.get(task.capabilityId);
  if (!capability) {
    audit('refused', 'unknown_capability', founder);
    return refusal(403, 'unknown_capability', `Unknown capability: ${task.capabilityId}`);
  }
  if (STEP_UP_RISK_CLASSES.includes(capability.riskClass)) {
    const stepUp = verifyStepUp(founder, stringField(request.body, 'stepUpPassword'), {
      credentials: deps.credentials,
      now: now(),
    });
    if (!stepUp.ok) {
      audit('refused', stepUp.reason, founder);
      return refusal(stepUp.reason === 'step_up_failed' ? 403 : 401, stepUp.reason, stepUp.message);
    }
  }

  const result = deps.ops.approveTask({
    taskId,
    // Again: the server-resolved principal, never a body field.
    founderId: founder.principal.id,
    expectedActionDigest,
    note,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    const status =
      result.error.code === 'action_digest_mismatch'
        ? 409
        : result.error.code === 'unknown_task'
          ? 404
          : 403;
    return safe(
      json(status, { ok: false, error: { code: result.error.code, message: result.error.message } }),
    );
  }
  audit('allowed', 'approved', founder);
  return safe(json(200, { ok: true, taskId, status: result.data.status }));
}

function deny(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const taskId = stringField(request.body, 'taskId') ?? '';
  const reason = (stringField(request.body, 'reason') ?? '').trim();
  const expectedActionDigest = stringField(request.body, 'expectedActionDigest');
  if (!taskId || !reason) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'A denial needs a taskId and a reason.');
  }
  const result = deps.ops.denyTask({
    taskId,
    founderId: founder.principal.id,
    reason,
    expectedActionDigest,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(result.error.code === 'unknown_task' ? 404 : 403, {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'denied', founder);
  return safe(json(200, { ok: true, taskId, status: result.data.status }));
}
