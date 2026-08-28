/**
 * Direct Orders / mission composer (issue #200, scope B).
 *
 * ## What this is
 *
 * The narrow write path for "the Founder types an instruction and starts a
 * task". It is a thin, testable seam ON TOP of `HeadquarterOperations` — it
 * validates input, resolves a truthful route, and calls `createTask`. It has
 * no database access of its own, writes no `op_tasks` column, and adds no
 * authority.
 *
 * ## Why the capability is `founder_gate` and not something looser
 *
 * The mission brief allows "the minimal narrow contract needed" for a generic
 * free-text order, and warns against creating an authority escape hatch. A
 * free-text instruction is, by construction, unclassifiable in advance: the
 * capability registry's whole design is that risk is fixed at registration
 * time and can never be inferred from a payload (`operator/capabilities.ts`).
 * The only honest risk class for "arbitrary instruction" is therefore the
 * highest one. `founder_gate` is the class `operator/policy.ts` refuses to let
 * a standing pre-approval override, so every direct order lands in
 * `needs_approval` and executes nothing until a Founder approves that exact
 * action by digest.
 *
 * That is not a workaround — it is the point. The composer's value is that it
 * creates *canonical, gated, evidenced* work from a sentence, not that it
 * skips the gate.
 *
 * Note also what the payload is NOT: `instruction` is a brief for a worker to
 * read, never a command line. There is deliberately still no capability in
 * this system whose payload is executed as a shell command.
 *
 * ## Fail closed, never substitute
 *
 * If the requested provider is not genuinely connected the order is REFUSED
 * and nothing is created. `AUTO` picks only from providers evidence shows are
 * connected; an explicit `CLAUDE` or `CODEX` never silently falls back to the
 * other one. This is the same failure that made the pre-registry bridge stall
 * silently, and the fix is to say so rather than to route around it.
 *
 * ## Who the requester is — asserted, never authenticated
 *
 * `requestedBy` is AUTHORIZED against the human-principal registry and is not
 * AUTHENTICATED by anything: Headquarter has no mechanism that can prove a
 * human's identity, in the browser or at a terminal. Every order therefore
 * carries an `actorAuthentication` marker recording how little is known, and
 * the containment is the pair of canonical rules that already exist — deny by
 * default on an unregistered or ungranted id, and no self-approval, so the
 * asserted principal is precisely the one who may not approve the order.
 * See `live/local-trust.ts`.
 */

import { createHash } from 'node:crypto';
import { assertBrowserSafe } from './redaction.js';
import { DEFAULT_ACTOR_AUTHENTICATION, type ActorAuthentication } from './local-trust.js';
import type { TaskClassification } from '../application/classification.js';
import type { HeadquarterOperations, OpsErrorCode } from '../application/service.js';
import type { OperatorTask } from '../operator/queue.js';
import {
  providerConnectivity,
  type ProviderId,
  type SecretsEnv,
} from '../routing/providers.js';

/**
 * The one narrow capability a Founder direct order creates.
 *
 * It is NOT registered automatically anywhere. A deployment that wants direct
 * orders calls `registerDirectOrderCapability` explicitly; until then
 * `submitDirectOrder` fails with `unknown_capability`, because deny-by-default
 * applies to this path exactly as it does to every other.
 */
export const DIRECT_ORDER_CAPABILITY = {
  id: 'hq.direct_order',
  description:
    'Founder direct order — a written instruction for an AI worker to carry out under Operator control. ' +
    'Always Founder-gated: the instruction is a brief, never a command to execute.',
  riskClass: 'founder_gate',
  sideEffect: true,
  idempotent: true,
} as const;

/** Register the direct-order capability on an operations facade. */
export function registerDirectOrderCapability(ops: HeadquarterOperations): void {
  ops.queue.capabilities.register({ ...DIRECT_ORDER_CAPABILITY });
}

/** Routes the composer offers. Kept small on purpose. */
export const DIRECT_ORDER_ROUTES = ['AUTO', 'CLAUDE', 'CODEX'] as const;
export type DirectOrderRoute = (typeof DIRECT_ORDER_ROUTES)[number];

/**
 * Order AUTO considers, best first. Preference is a product decision, not a
 * capability claim — a preferred provider that is not connected is skipped,
 * never substituted for one that is.
 */
export const AUTO_ROUTE_PREFERENCE: readonly ProviderId[] = ['CLAUDE', 'CODEX'];

export const MAX_INSTRUCTION_LENGTH = 4000;

export interface RouteCandidate {
  provider: ProviderId;
  connected: boolean;
  /** Verbatim from `providerConnectivity` — never softened for display. */
  reason: string;
  /** Missing credential/local-fact NAMES. Never values. */
  missingFacts: string[];
}

export interface RouteResolution {
  requested: DirectOrderRoute;
  /** The provider that would genuinely run this, or null when none can. */
  resolved: ProviderId | null;
  connected: boolean;
  reason: string;
  /** Every provider considered, with its own verdict. Shown in the UI. */
  candidates: RouteCandidate[];
}

function candidate(provider: ProviderId, env: SecretsEnv): RouteCandidate {
  const report = providerConnectivity(provider, env);
  return {
    provider,
    connected: report.connected,
    reason: report.reason,
    missingFacts: [...report.missingSecrets, ...report.missingLocalFacts],
  };
}

/**
 * Resolve a requested route against observed connectivity.
 *
 * An explicit route is answered about ITSELF only: the returned `resolved` is
 * either that provider or null. There is no code path in which asking for
 * CODEX yields CLAUDE.
 */
export function resolveOrderRoute(route: DirectOrderRoute, env: SecretsEnv): RouteResolution {
  if (route === 'AUTO') {
    const candidates = AUTO_ROUTE_PREFERENCE.map((provider) => candidate(provider, env));
    const first = candidates.find((entry) => entry.connected) ?? null;
    return {
      requested: route,
      resolved: first?.provider ?? null,
      connected: first != null,
      reason: first
        ? `AUTO selected ${first.provider}: ${first.reason}`
        : 'AUTO could not select a provider — none of ' +
          `${AUTO_ROUTE_PREFERENCE.join(', ')} is connected here. No substitution is made.`,
      candidates,
    };
  }

  const only = candidate(route as ProviderId, env);
  return {
    requested: route,
    resolved: only.connected ? only.provider : null,
    connected: only.connected,
    reason: only.connected
      ? only.reason
      : `${route} was requested explicitly and is NOT connected here, so the order is blocked ` +
        `rather than routed elsewhere. ${only.reason}`,
    candidates: [only],
  };
}

/* ------------------------------------------------------------------ */
/* Submission                                                          */
/* ------------------------------------------------------------------ */

export interface DirectOrderInput {
  /** What the Founder wants done. A brief for a worker, not a command. */
  instruction: string;
  /** Optional presentation label. Never authority. */
  project?: string;
  /**
   * Optional short label, PUBLISHED to the browser snapshot. Omitted → a
   * neutral default that reveals nothing about the instruction (see
   * `defaultTitle`); the instruction itself never leaves the server.
   */
  title?: string;
  route: DirectOrderRoute;
  /**
   * The human principal opening the work. Resolved against the principal
   * registry by `HeadquarterOperations` — an unregistered id can open nothing.
   *
   * Note what this is and is not: an ASSERTION of identity, authorized against
   * the registry, never authenticated. See `actorAuthentication`.
   */
  requestedBy: string;
  /**
   * How much is actually known about the caller behind `requestedBy`.
   *
   * Recorded on the canonical task so an approver can see that the attribution
   * was asserted rather than proven. Omitted → the weakest value; there is no
   * value that claims authentication (see `live/local-trust.ts`).
   */
  actorAuthentication?: ActorAuthentication;
  /** Supply to make a retry explicit; otherwise derived deterministically. */
  idempotencyKey?: string;
}

export interface DirectOrderReceipt {
  task: OperatorTask;
  classification: TaskClassification;
  /** True when this submission matched an existing order rather than creating one. */
  deduplicated: boolean;
  route: RouteResolution;
  idempotencyKey: string;
}

export type DirectOrderErrorCode =
  | OpsErrorCode
  | 'provider_not_connected'
  | 'empty_instruction'
  | 'instruction_too_long'
  | 'unsafe_instruction';

export type DirectOrderResult =
  | { ok: true; data: DirectOrderReceipt }
  | { ok: false; error: { code: DirectOrderErrorCode; message: string; details?: Record<string, unknown> } };

function orderFail(
  code: DirectOrderErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DirectOrderResult {
  return { ok: false, error: { code, message, details } };
}

/**
 * Deterministic idempotency key.
 *
 * Derived from everything that makes the order the same order — who asked,
 * what they asked for, which project, and which route. A double-clicked
 * composer therefore dedupes onto the first task instead of creating a second
 * one, without the browser having to remember anything. Changing any of those
 * four inputs is a genuinely different order and gets its own key.
 */
export function directOrderIdempotencyKey(
  input: Pick<DirectOrderInput, 'instruction' | 'project' | 'route' | 'requestedBy'>,
): string {
  const digest = createHash('sha256')
    .update(
      [input.requestedBy, input.route, input.project ?? '', input.instruction.trim()].join(' '),
    )
    .digest('hex');
  return `direct-order:${digest.slice(0, 32)}`;
}

/**
 * Default label for an order whose author did not choose one.
 *
 * Deliberately says nothing about the instruction's contents. An earlier draft
 * defaulted the title to the instruction's first line, which quietly published
 * Founder-typed text: `TaskMeta.title` flows into `ConsoleTask.title` and from
 * there into the browser snapshot, so anyone who pasted sensitive text into
 * an order had it rendered without ever choosing to publish it.
 *
 * A supplied `title` is still published — that is what a title is for, and
 * choosing one is a deliberate act. What must not happen is content reaching
 * the browser as a side effect of writing the instruction.
 */
function defaultTitle(route: RouteResolution): string {
  return `Direct order → ${route.resolved}`;
}

/**
 * Submit a Founder direct order.
 *
 * Everything downstream of `ops.createTask` is untouched canonical machinery:
 * the capability allow-list comes from the principal registry (never from this
 * caller), classification comes from the capability entry, and the
 * `founder_gate` risk class parks the task in `needs_approval` with an action
 * digest a Founder must echo back before anything runs.
 */
export function submitDirectOrder(
  ops: HeadquarterOperations,
  input: DirectOrderInput,
  env: SecretsEnv,
): DirectOrderResult {
  const instruction = (input.instruction ?? '').trim();
  if (instruction.length === 0) {
    return orderFail('empty_instruction', 'An order needs an instruction.');
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    return orderFail(
      'instruction_too_long',
      `An order instruction may be at most ${MAX_INSTRUCTION_LENGTH} characters.`,
      { length: instruction.length },
    );
  }
  if (!input.requestedBy) {
    return orderFail('invalid_input', 'requestedBy is required.');
  }
  if (!DIRECT_ORDER_ROUTES.includes(input.route)) {
    // Deny by default on an unknown route, exactly as on an unknown capability.
    return orderFail('invalid_input', `Unknown route: ${String(input.route)}`);
  }

  // An order becomes hash-chained evidence the moment it is created. Refuse a
  // pasted credential here rather than letting the evidence log throw later,
  // when a task may already exist. `assertBrowserSafe` is the stricter of the
  // two guards — it scans each raw string as well as the encoded payload, so a
  // quoted secret cannot hide behind JSON escaping.
  try {
    assertBrowserSafe({ instruction, project: input.project ?? null }, 'order');
  } catch {
    return orderFail(
      'unsafe_instruction',
      'The instruction looks like it contains a credential. Orders are recorded in the ' +
        'append-only evidence log, so secrets must never be pasted into one.',
    );
  }

  const route = resolveOrderRoute(input.route, env);
  if (!route.connected || route.resolved == null) {
    // Fail closed: nothing is created, and no other provider is substituted.
    return orderFail('provider_not_connected', route.reason, {
      requested: route.requested,
      candidates: route.candidates,
    });
  }

  const idempotencyKey = input.idempotencyKey ?? directOrderIdempotencyKey({ ...input, instruction });
  const created = ops.createTask({
    capabilityId: DIRECT_ORDER_CAPABILITY.id,
    payload: {
      kind: 'direct_order',
      instruction,
      project: input.project ?? null,
      requestedRoute: route.requested,
      resolvedProvider: route.resolved,
      // Honesty travels with the action: the approver reading this task sees
      // that `requestedBy` was asserted, not authenticated. It is part of the
      // payload, so it is part of the action digest a Founder echoes back —
      // the assertion cannot be edited away between rendering and approval.
      actorAuthentication: input.actorAuthentication ?? DEFAULT_ACTOR_AUTHENTICATION,
    },
    idempotencyKey,
    requestedBy: input.requestedBy,
    project: input.project,
    title: input.title ?? defaultTitle(route),
  });

  if (!created.ok) {
    return { ok: false, error: created.error };
  }
  return {
    ok: true,
    data: {
      task: created.data.task,
      classification: created.data.classification,
      deduplicated: created.data.deduplicated,
      route,
      idempotencyKey,
    },
  };
}
