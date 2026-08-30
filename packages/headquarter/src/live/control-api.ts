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
import { capabilityRowFor } from '../application/service.js';
import type { HeadquarterOperations } from '../application/service.js';
import { taskActionDigest } from '../operator/approvals.js';
import type { ProviderId, SecretsEnv } from '../routing/providers.js';
import { dispatchHistory } from '../providers/claude/dispatch.js';
import {
  checkMutationOrigin,
  normalizedTrustedOrigins,
  requestOriginContext,
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
  directOrderDispatchBlocked,
  resolveOrderRoute,
  submitDirectOrder,
  DIRECT_ORDER_CAPABILITY,
  DIRECT_ORDER_ROUTES,
  type DirectOrderRoute,
} from './orders.js';

export const CONTROL_API_PREFIX = '/api/hq/control';

/**
 * A denial reason is persisted to `op_tasks`, `hq_approvals` and the evidence
 * log, so it is bounded here rather than left to whatever a caller sends —
 * the same reasoning as `MAX_TITLE_LENGTH` on an order.
 */
export const MAX_DENIAL_REASON_LENGTH = 500;

/**
 * An approval note is stored permanently in `hq_approvals.decision_note` and
 * rendered into the generated console HTML, so it is bounded and scanned on
 * exactly the same terms as a denial reason.
 */
export const MAX_APPROVAL_NOTE_LENGTH = 500;

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
  /**
   * The one authority. Identity is resolved from `ops.principals` and nowhere
   * else (issue #200, Codex round 4 P1).
   *
   * This deliberately no longer takes a separate `principals` port. It used to,
   * and that was a second source of truth for the same question: the boundary
   * authenticated a mapped principal id against the supplied registry while
   * `createTask`/`approveTask`/`denyTask` authorized that same string against
   * `ops.principals`. A host that wired two registries — or two databases —
   * would have had an account mapped to an innocuous principal here inherit an
   * unrelated same-id principal's grants there. Detecting the divergence would
   * have been possible; removing the field makes it unrepresentable, which is
   * better.
   */
  ops: HeadquarterOperations;
  sessions: SessionResolverPort;
  /** RAW configured Founder map; parsed per request so a broken map fails closed. */
  founderMap: unknown;
  /** Trusted origins for state-changing requests. Empty ⇒ no mutations at all. */
  allowedOrigins: readonly string[];
  /** Provider facts for route resolution. Names only ever leave here, never values. */
  secretsEnv: SecretsEnv;
  /**
   * Transport-backed dispatchability for a provider — true/false when the host
   * genuinely knows, null when it does not. A host running where the real
   * transport lives supplies it; without one the routing contract answers.
   */
  dispatchAvailability?: (provider: ProviderId) => boolean | null;
  credentials?: CredentialVerifierPort;
  audit?: ControlAuditPort;
  now?: () => Date;
  /**
   * Set false to serve the reads without the writes — the safe posture while a
   * deployment's Founder binding is still being established.
   *
   * It lives here, in the layer that also computes `controls`, rather than in
   * the host adapter, and that placement is the fix for a real defect: with the
   * flag enforced in the adapter only, the session route went on advertising
   * `directOrder`/`approve`/`deny` as available, so a read-only deployment told
   * the UI to draw buttons that could only ever return `mutations_disabled`.
   * One flag, read once, decides both what happens and what is claimed.
   */
  mutationsEnabled?: boolean;
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
  /**
   * True when this is a direct order whose bound provider cannot dispatch right
   * now (issue #224). The live approvals view is what the browser console
   * actually renders, so the blocked state has to travel HERE — a field only on
   * the polled snapshot was a promise nothing kept.
   */
  dispatchBlocked: boolean;
}

function approvalView(
  card: ApprovalCard,
  founderId: string,
  dispatchBlocked: boolean,
): ApprovalView {
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
    dispatchBlocked,
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

/**
 * Is this approval card a direct order whose provider cannot dispatch right now?
 *
 * Asked here, per card, because this route is what the live console renders —
 * the polled snapshot carries the same field but nothing in the browser reads
 * it, so a block that lived only there was invisible (issue #224, Codex P1 on
 * `faf4fda`). Evidence outranks inference: an order HQ has already published is
 * not blocked, whatever the environment now looks like.
 *
 * `dispatchAvailability` lets a host that holds the real transport answer for
 * its provider; without one, the routing contract answers, as it did before.
 */
function isDispatchBlocked(deps: ControlApiDeps, taskId: string): boolean {
  const task = deps.ops.queue.get(taskId);
  if (!task) return false;
  return directOrderDispatchBlocked(task, deps.secretsEnv, {
    alreadyDispatched: dispatchHistory(deps.ops, taskId).state === 'dispatched',
    providerDispatchable: deps.dispatchAvailability,
  });
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

  const mutationsEnabled = deps.mutationsEnabled !== false;
  if (!mutationsEnabled && method !== 'GET') {
    return refusal(
      403,
      'mutations_disabled',
      'HQ browser writes are switched off for this deployment.',
    );
  }

  // Auditing is best-effort BY CONTRACT, and the try/catch is what makes that
  // true rather than merely intended (issue #200, Codex round 4 P2).
  //
  // Every `allowed` audit call happens AFTER its canonical write has
  // committed. A throwing sink — an unreachable logging backend, say — would
  // escape to `handleControlRequest`'s catch-all and become a 500, telling the
  // client its order or approval failed when it had in fact succeeded. That is
  // the same defect class as the round-2 denial partial commit: a response
  // disagreeing with committed state, and a retry then hitting an
  // already-created or no-longer-pending task.
  //
  // Swallowing the error is the lesser cost, and it is not a loss of the
  // record: `op_evidence` is the authoritative, hash-chained log written
  // inside the canonical operation. This port is a supplementary host-side
  // sink, and a supplementary sink must never be able to misreport the
  // outcome of the thing it is describing.
  const audit = (
    outcome: 'allowed' | 'refused',
    detail: string,
    founder?: ResolvedFounder,
  ): void => {
    try {
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
    } catch {
      // Deliberately swallowed. See above.
    }
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
    // The SAME registry HeadquarterOperations authorizes against, never a
    // second one supplied alongside it.
    principals: { get: (id: string) => deps.ops.lookupPrincipal(id) },
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
          controls: controlAvailability(deps, null, request),
        }),
      );
    }
    audit('allowed', 'session', resolution.founder);
    const founderControls = controlAvailability(deps, resolution.founder, request);
    return safe(
      json(200, {
        ok: true,
        authenticated: true,
        founder: true,
        principalId: resolution.founder.principal.id,
        displayName: resolution.founder.principal.displayName,
        approvalAuthority: resolution.founder.principal.approvalAuthority,
        // The console renders `message` as its own reason for showing no
        // control, so the one case a Founder could not otherwise explain gets
        // said plainly. Two different situations produce the same `false`, and
        // conflating them would send a Founder to edit a configuration that is
        // already correct, so they are worded apart: the page's origin is not
        // on the trusted list, versus the request carried no evidence of its
        // origin at all (a stripped referrer, leaving only a scheme-blind
        // Host). The untrusted origin itself is deliberately NOT echoed back —
        // a reason must not become a reflection channel for a header the
        // caller controls.
        ...(founderControls.requestOriginAllowed === false
          ? {
              message:
                founderControls.requestOriginSource === 'origin' ||
                founderControls.requestOriginSource === 'referer'
                  ? 'This page was not served from an origin that is trusted for HQ browser ' +
                    'control, so every state-changing request from it would be refused. Add ' +
                    "this deployment's exact origin to the HQ trusted-origin configuration."
                  : 'This request carried no evidence of the origin that made it — no Origin ' +
                    'and no Referer — so the controls stay off rather than being advertised on ' +
                    'a guess. A Host header alone cannot say whether the page was loaded over ' +
                    'http or https, which is exactly what a write is checked against.',
            }
          : {}),
        controls: founderControls,
        // Live route availability for the composer, derived from the same
        // observed evidence that will decide the order — never from the
        // provider catalogue. Founder-only: which providers this host can
        // dispatch to is deployment knowledge an unmapped session has no
        // business reading. Candidate verdicts name missing FACTS, never
        // values, and `safe()` walks this on the way out like everything else.
        // The composer's route verdicts come from the same place the order's
        // own verdict will: a host holding the real transport answers for its
        // provider, so the browser cannot contradict what dispatch will do.
        routes: DIRECT_ORDER_ROUTES.map((route) =>
          resolveOrderRoute(route, deps.secretsEnv, { providerDispatchable: deps.dispatchAvailability }),
        ),
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
        approvals: console_.approvals.map((card) =>
          approvalView(card, founder.principal.id, isDispatchBlocked(deps, card.taskId)),
        ),
      }),
    );
  }

  if (path === CONTROL_ROUTES.orders) return createOrder(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.approve) return approve(request, deps, founder, audit, now);
  return deny(request, deps, founder, audit);
}

type Audit = (outcome: 'allowed' | 'refused', detail: string, founder?: ResolvedFounder) => void;

/**
 * What the UI may draw as live.
 *
 * Every control is derived from the thing that will actually decide the
 * request — never from the weaker fact that an account was mapped. Being the
 * Founder is not one authority but several independent ones, and the human
 * principal registry is explicit that they do not imply each other: a mapped,
 * active principal may hold `approvalAuthority: false`, or hold approval
 * authority while lacking the origination grant for `hq.direct_order`. Reading
 * only `founder` advertised buttons that `HeadquarterOperations` would then
 * refuse — the same defect as the `mutationsEnabled` one, one layer further in
 * (issue #200, Codex round 2 P2).
 */
function controlAvailability(
  deps: ControlApiDeps,
  founder: ResolvedFounder | null,
  request: ControlRequest,
): Record<string, unknown> {
  // Every write control is gated on the SAME conditions that refuse the write,
  // so the console can never be told a button works when the route will refuse
  // it. That means the origin allow-list too: with none configured, or only
  // unparseable entries, `checkMutationOrigin` rejects every POST as
  // `origin_allowlist_empty` — and derived from the same function it uses, so
  // the two cannot disagree about what counts as a usable origin.
  const originsUsable = normalizedTrustedOrigins(deps.allowedOrigins).length > 0;
  // A configured allow-list is necessary and NOT sufficient. What decides a
  // POST is whether THIS page's origin is on it, so that is what decides the
  // advertisement too (issue #219 correction round, Codex P2). A console
  // reached at a preview hostname nobody added to the list is told the
  // controls are off, with the reason, instead of drawing buttons whose every
  // POST returns `origin_not_allowed`.
  const requestOrigin = requestOriginContext(request, deps.allowedOrigins);
  const writable =
    founder !== null &&
    deps.mutationsEnabled !== false &&
    originsUsable &&
    requestOrigin.allowed === true;
  const principal = founder?.principal;
  const mayApprove = writable && principal?.approvalAuthority === true;
  const mayOriginate =
    writable && principal?.originateCapabilities.includes(DIRECT_ORDER_CAPABILITY.id) === true;
  return {
    directOrder: mayOriginate && directOrderCapabilityState(deps.ops) === 'enabled',
    approve: mayApprove,
    deny: mayApprove,
    mutationsEnabled: deps.mutationsEnabled !== false,
    trustedOriginConfigured: originsUsable,
    // Stated separately from `trustedOriginConfigured`, because they answer
    // different questions and a deployment can pass the first and fail the
    // second. `requestOriginSource` names how the requesting origin was
    // established — `origin`/`referer` carry a scheme and can answer yes;
    // `host` carries none and `none` is no evidence at all, and both of those
    // answer no rather than guess a scheme the POST gate would decide on.
    requestOriginAllowed: requestOrigin.allowed,
    requestOriginSource: requestOrigin.source,
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
      idempotencyKey: clientKey,
    },
    deps.secretsEnv,
    {
      providerDispatchable: deps.dispatchAvailability,
      // Earned, not asserted: a server-resolved JENIFY OS session mapped by
      // explicit configuration to this principal. This is the first interface
      // in Headquarter entitled to say so.
      //
      // Passed HERE, on the options object, rather than on the order input:
      // the input is what a request body deserializes into, and this value must
      // never be reachable from a body. `submitDirectOrder` refuses it from a
      // caller asserting it about itself (issue #219, integrating #200's
      // runtime vocabulary guard with #214's authenticated path).
      resolvedActorAuthentication: 'authenticated_os_session',
    },
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
    //
    // `capability_definition_altered` belongs there for the same reason
    // (issue #219, Codex P2 on `6e5f054`). The three capability-state
    // refusals answer one question — may this capability be invoked here,
    // as it is currently configured — and the answer is a property of the
    // SERVER's registry row, not of the submitted order. A 400 tells the
    // console the order was malformed and invites the Founder to edit and
    // resend an order that was already valid; the drifted row would refuse
    // every retry. All three now say 403: refused, and nothing you can
    // change in this request will help. Restoring the reserved definition
    // stays the explicit registration action, exactly as before.
    const status =
      result.error.code === 'provider_not_connected'
        ? 409
        : result.error.code === 'capability_not_registered' ||
            result.error.code === 'capability_disabled' ||
            result.error.code === 'capability_definition_altered' ||
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

  audit(
    'allowed',
    result.data.dispatchBlocked
      ? result.data.deduplicated
        ? 'order_deduplicated_blocked'
        : 'order_created_blocked'
      : result.data.deduplicated
        ? 'order_deduplicated'
        : 'order_created',
    founder,
  );
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
      // The order exists AND cannot be dispatched right now (issue #224). Both
      // halves are true and the browser must show both: this is a created,
      // gated, remembered order in a BLOCKED / NOT CONNECTED state — never a
      // success it can present as running, and never a failure that suggests
      // nothing was recorded.
      dispatchBlocked: result.data.dispatchBlocked,
      boundProvider: result.data.boundProvider,
      route: {
        requested: result.data.route.requested,
        resolved: result.data.route.resolved,
        reason: result.data.route.reason,
        // Names of the facts that are missing, never their values — the shape
        // `routing/providers.ts` already guarantees.
        missingFacts: result.data.dispatchBlocked
          ? result.data.route.candidates.flatMap((candidate) => candidate.missingFacts)
          : [],
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
  // The note gets the same treatment as a denial reason, and for a stronger
  // reason: it is not merely persisted, it is PUBLISHED — `renderFounderApprovals`
  // writes `decision_note` into the generated HTML (issue #200, Codex round 3 P1).
  if (note !== undefined) {
    if (note.length > MAX_APPROVAL_NOTE_LENGTH) {
      audit('refused', 'note_too_long', founder);
      return refusal(
        400,
        'note_too_long',
        `An approval note may be at most ${MAX_APPROVAL_NOTE_LENGTH} characters.`,
      );
    }
    try {
      assertBrowserSafe({ note }, 'approval');
    } catch {
      audit('refused', 'unsafe_note', founder);
      return refusal(
        400,
        'unsafe_note',
        'The approval note looks like it contains a credential. Approval notes are stored ' +
          'permanently and rendered in the Founder console, so nothing was approved.',
      );
    }
  }

  // Step-up is decided from the CANONICAL capability of the task named in the
  // request, never from a risk class the client sends. An unknown task is
  // refused here rather than being allowed to skip the check and fail later.
  const task = deps.ops.queue.get(taskId);
  if (!task) {
    audit('refused', 'unknown_task', founder);
    return refusal(404, 'unknown_task', `Unknown task: ${taskId}`);
  }
  // The DATABASE row, never `queue.capabilities` (issue #219, Codex P1 on
  // `2175fa2`). Whether a password is demanded is decided from `riskClass`, so
  // this is enforcement, and it was reading the convenience surface #200
  // documents as patchable: `queue.capabilities.get = () => ({ ...cap,
  // riskClass: 'read_only' })` drops the class out of STEP_UP_RISK_CLASSES,
  // `verifyStepUp` never runs, and a stale Founder session approves a
  // `founder_gate` task with no fresh credential. `approveTask` does not
  // re-demand one — step-up is decided here — so nothing downstream catches it.
  const capability = capabilityRowFor(deps.ops, task.capabilityId);
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
      const status =
        stepUp.reason === 'step_up_rate_limited'
          ? 429
          : stepUp.reason === 'step_up_failed'
            ? 403
            : 401;
      return refusal(status, stepUp.reason, stepUp.message);
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
  if (reason.length > MAX_DENIAL_REASON_LENGTH) {
    audit('refused', 'reason_too_long', founder);
    return refusal(
      400,
      'reason_too_long',
      `A denial reason may be at most ${MAX_DENIAL_REASON_LENGTH} characters.`,
    );
  }
  // Guard the reason before the canonical call, exactly as the order path
  // guards an instruction (issue #200, Codex round 2 P1). `denyTask` now
  // refuses a credential-shaped reason before its first write, so this is not
  // what prevents the partial commit — it is what makes the browser's refusal
  // specific instead of a generic `operator_rejected`, and it applies the
  // stricter of the two guards, which also scans the raw string rather than
  // only the JSON encoding.
  try {
    assertBrowserSafe({ reason }, 'denial');
  } catch {
    audit('refused', 'unsafe_reason', founder);
    return refusal(
      400,
      'unsafe_reason',
      'The denial reason looks like it contains a credential. Denials are recorded in the ' +
        'append-only evidence log, so nothing was written.',
    );
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
