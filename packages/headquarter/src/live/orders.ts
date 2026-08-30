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
 * ## Never substitute — and, since issue #224, never forget either
 *
 * An explicit `CLAUDE` or `CODEX` never silently falls back to the other one,
 * and `AUTO` picks only from providers evidence shows are dispatchable. That
 * has not changed and is the whole point of the routing lane.
 *
 * What HAS changed is what happens when the named provider cannot dispatch
 * today. The order used to be refused with nothing created, so a Founder order
 * placed while `CLAUDE_ROUTINE_*` was absent left `op_tasks` empty — the order
 * was lost rather than blocked, and HQ had no canonical thing to report a
 * truthful BLOCKED state about. #200's sequence is create-then-report, so an
 * explicit order is now CREATED, bound to the provider that was asked for, and
 * recorded as dispatch-blocked. It is gated exactly as any other order: it
 * lands in `needs_approval`, carries the same digest, executes nothing, and —
 * because the binding names the requested provider — can only ever be claimed
 * by a worker declared as that provider. A blocked order is a remembered
 * order, not a permitted one.
 *
 * `AUTO` with nothing connected is recorded too, against the first entry in the
 * declared `AUTO_ROUTE_PREFERENCE`. That is not substitution — substitution
 * means satisfying a request for one NAMED provider with a different one, and
 * AUTO names none — and the preference order is a deterministic product
 * decision rather than a guess. The receipt still says resolved: null, so
 * nothing claims a provider was available. The trade, stated plainly: the
 * binding is fixed once written, because it lives inside the digest a Founder
 * approves, so an order blocked on the first preference stays blocked on it
 * even if a later preference connects first.
 *
 * A note on the word, because two modules use it differently on purpose.
 * `providerConnectivity().connected` is the ROUTING lane's dispatch contract:
 * an executor exists and every fact it needs is present. That is the right and
 * only available gate for placing an order — HQ registers no live provider
 * check, so requiring one here would mean no order could ever be placed. It is
 * deliberately NOT the Connection Center's `connected`, which since Codex
 * round-3 P1 #3 means "a live check ran and succeeded" and nothing less; the
 * same evidence is shown there as `dispatchable`. An order therefore fails
 * closed on dispatchability and claims nothing about reachability.
 *
 * The resolved provider is then BINDING at execution, not a label on the task:
 * it is written to the reserved `executionProvider` payload key, and
 * `OperatorQueue.claim`/`start` refuse any worker not declared as that
 * provider (`operator/provider-binding.ts`). Without that, no-substitution
 * held only at creation — a worker for another provider could still have
 * claimed the order out of the shared `hq.direct_order` queue.
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
import {
  DEFAULT_ACTOR_AUTHENTICATION,
  isCallerAssertableActorAuthentication,
  type ActorAuthentication,
} from './local-trust.js';
import { EXECUTION_PROVIDER_KEY, readProviderBinding } from '../operator/provider-binding.js';
import { dispatchHistory } from '../providers/claude/dispatch.js';
import { CapabilityRegistry } from '../operator/capabilities.js';
import type { HqDatabase } from '../store/db.js';
import type { TaskClassification } from '../application/classification.js';
import { capabilityRowFor } from '../application/service.js';
import type { HeadquarterOperations, OpsErrorCode } from '../application/service.js';
import type { Capability } from '../operator/capabilities.js';
import type { OperatorTask } from '../operator/queue.js';
import {
  isProviderId,
  providerConnectivity,
  type ProviderId,
  type SecretsEnv,
} from '../routing/providers.js';

/**
 * The one narrow capability a Founder direct order creates.
 *
 * It is NOT registered automatically anywhere. A deployment that wants direct
 * orders calls `registerDirectOrderCapability` explicitly, as a CONFIGURATION
 * action; until then `submitDirectOrder` fails closed, because deny-by-default
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

/**
 * Register the direct-order capability — a CONFIGURATION action, deliberately
 * separate from placing an order (issue #200, Codex P1 #2).
 *
 * It never changes the enabled/disabled state of a capability that already
 * exists: `CapabilityRegistry.register` leaves `enabled` alone unless a caller
 * states it explicitly. Disabling `hq.direct_order` is a containment decision,
 * and no invocation path — this function included — may quietly undo it.
 * Re-enabling is its own explicit act (`capabilities.setEnabled`).
 */
export function registerDirectOrderCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...DIRECT_ORDER_CAPABILITY });
}

/**
 * The parts of the reserved definition that CARRY the Founder gate.
 *
 * `riskClass` is what `operator/policy.ts` reads to refuse a standing
 * pre-approval, and `sideEffect` is what marks the action as reaching outside
 * the control plane; `idempotent` is what makes replaying an approved digest
 * safe. Those three are the contract — the description is prose and may drift
 * without changing what the system will do.
 *
 * Verifying them at all is the point issue #200's review made (Codex exact-head
 * finding on `5a19350`): checking only missing/disabled/enabled reads the
 * capability's SWITCH and never its DEFINITION, and `createTask` classifies
 * against whatever the canonical registry row says, not against the constant in
 * this file. An existing database whose `hq.direct_order` row had weakened to
 * `riskClass: 'reversible'` (an older schema, a hand-edit, a collision with a
 * differently-defined capability of the same id) would let a free-text
 * instruction go straight to `queued`, skipping the Founder gate this
 * capability exists to impose.
 *
 * Invocation deliberately does not re-register, so nothing re-asserts the
 * definition on the way past — which makes verifying it here the other half of
 * that decision rather than a new rule. Registration stays a separate, explicit
 * configuration act; invocation refuses to ride on a definition that no longer
 * promises what the order is relying on.
 */
export const DIRECT_ORDER_RESERVED_CONTRACT = {
  riskClass: DIRECT_ORDER_CAPABILITY.riskClass,
  sideEffect: DIRECT_ORDER_CAPABILITY.sideEffect,
  idempotent: DIRECT_ORDER_CAPABILITY.idempotent,
} as const;

/**
 * Which contract fields the registry's CURRENT row disagrees with, if any.
 *
 * Exported so a refusal can name them: "altered" is useless to a Founder who
 * cannot see which guarantee was dropped.
 */
export function directOrderContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== DIRECT_ORDER_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== DIRECT_ORDER_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== DIRECT_ORDER_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

/** What the registry currently says about the direct-order capability. */
export type DirectOrderCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/**
 * Read the registry, and believe the ROW rather than the id (issue #219,
 * Codex P1 on `49da330`).
 *
 * `id` plus `enabled` used to be the whole answer, which trusted a name to
 * carry a guarantee that actually lives in the row's columns.
 * `CapabilityRegistry.register` updates the definition of an existing
 * capability by design, so anything that can register can re-register
 * `hq.direct_order` as `riskClass: 'read_only', sideEffect: false` — and then
 * the policy engine, which reads risk from the registry, no longer routes a
 * direct order into `needs_approval`. The order would be queued and executed
 * with no Founder approval, through a path whose entire justification is that
 * it is Founder-gated.
 *
 * The host deliberately consumes an existing registration instead of restoring
 * the definition at startup (re-registering on the way to using a capability is
 * how a disabled one used to get silently re-enabled), so the check belongs
 * here: fail closed while the row does not match the reserved contract, and let
 * the explicit configuration action — `registerDirectOrderCapability` — be what
 * repairs it. Detecting the drift is not the same as fixing it, and an
 * invocation path must not do the second.
 */
export function directOrderCapabilityState(ops: HeadquarterOperations): DirectOrderCapabilityState {
  // The DATABASE row, never `queue.capabilities` (issue #219, Codex P1 on
  // `9c2a474`). That collaborator is an own-property closure #200 documents as
  // patchable; replacing it to report the reserved definition made this
  // function answer `enabled` while the weakened row was still what `#enqueue`
  // classified against — a Founder-gated order straight to `queued`.
  const capability = capabilityRowFor(ops, DIRECT_ORDER_CAPABILITY.id);
  if (!capability) return 'missing';
  // Checked before `enabled`, because a weakened definition is a fact about
  // the row whether or not the row is switched on, and re-enabling it must not
  // be the moment the weakened contract silently takes effect. Issue #200's
  // lane checked `enabled` first and reported a weakened-but-disabled row as
  // plain `disabled`; both orderings refuse the order, but this one lets the
  // operator learn about the drift before the switch hides it. Integration
  // decision for #219 — see the PR body.
  if (directOrderContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
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

/**
 * A title is a label, not a second instruction. It is also the one field of an
 * order that is PUBLISHED to the browser snapshot, so it is bounded here
 * rather than left to whatever a caller sends.
 */
export const MAX_TITLE_LENGTH = 120;

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

/**
 * How a host that holds the real transport answers for a provider (issue #224,
 * Codex P1 on `4225d78`).
 *
 * The routing contract asks whether the facts a provider's executor needs are
 * present in THIS process. For CLAUDE on the Founder workstation that is the
 * wrong question and gives the wrong answer: `CLAUDE_ROUTINE_*` are GitHub
 * Actions secrets, deliberately absent locally, while the order actually
 * travels through the authenticated `gh` transport. Reporting NOT CONNECTED
 * there made the composer contradict both the live snapshot and the transport
 * that would really carry the work.
 *
 * `null` means "this host does not know", and the routing contract answers as
 * before. Only a host that genuinely observes a transport should say `true`.
 */
export interface RouteAvailability {
  providerDispatchable?: (provider: ProviderId) => boolean | null;
  /**
   * An actor-authentication marker the CALLING INTERFACE earned, rather than
   * one the caller asserted (issue #219, integrating #200 with #214).
   *
   * It lives here, on the options object, and NOT on `DirectOrderInput`, for a
   * structural reason rather than a stylistic one: `input` is the shape a
   * request body is deserialized into, so anything reachable on it is
   * assertable by whoever wrote that body. This parameter is not, and cannot
   * be, part of a parsed payload. Only `live/control-api.ts` sets it, after
   * `live/auth.ts` has resolved a live JENIFY OS session to a configured
   * principal.
   *
   * When present it overrides `input.actorAuthentication`, which the caller
   * may still only populate from the caller-assertable vocabulary.
   */
  resolvedActorAuthentication?: ActorAuthentication;
}

function candidate(
  provider: ProviderId,
  env: SecretsEnv,
  availability?: RouteAvailability,
): RouteCandidate {
  const report = providerConnectivity(provider, env);
  const observed = availability?.providerDispatchable?.(provider) ?? null;
  if (observed === null) {
    return {
      provider,
      connected: report.connected,
      reason: report.reason,
      missingFacts: [...report.missingSecrets, ...report.missingLocalFacts],
    };
  }
  return {
    provider,
    connected: observed,
    // Truthful about WHERE the verdict came from, and never silently louder
    // than the routing contract it overrode.
    reason: observed
      ? `${provider} is dispatchable from this host: the transport that would carry it was ` +
        `observed available. (Routing-contract view of this process: ${report.reason})`
      : report.reason,
    missingFacts: observed ? [] : [...report.missingSecrets, ...report.missingLocalFacts],
  };
}

/**
 * Resolve a requested route against observed connectivity.
 *
 * An explicit route is answered about ITSELF only: the returned `resolved` is
 * either that provider or null. There is no code path in which asking for
 * CODEX yields CLAUDE.
 */
export function resolveOrderRoute(
  route: DirectOrderRoute,
  env: SecretsEnv,
  availability?: RouteAvailability,
): RouteResolution {
  if (route === 'AUTO') {
    const candidates = AUTO_ROUTE_PREFERENCE.map((provider) => candidate(provider, env, availability));
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

  const only = candidate(route as ProviderId, env, availability);
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


/**
 * Is this canonical task a direct order whose bound provider cannot dispatch
 * RIGHT NOW (issue #224)?
 *
 * Derived live rather than read from a stored flag, and that is the point. A
 * block is a fact about the world, not about the action: an order placed while
 * `CLAUDE_ROUTINE_*` was absent stops being blocked the moment the secrets are
 * configured, with no write to the task and no change to the digest an approver
 * echoes back. A payload flag frozen at creation would go stale in exactly the
 * direction that misleads — showing BLOCKED for an order that is now fine, or
 * the reverse.
 *
 * Payload-blind about everything else: it reads only the reserved
 * `executionProvider` binding, never the instruction.
 */
export interface DispatchBlockedContext {
  /**
   * True when HQ has already published this order. Evidence outranks
   * inference: an order that demonstrably reached its executor is not blocked,
   * whatever the environment looks like now.
   */
  alreadyDispatched?: boolean;
  /**
   * A transport-backed verdict for a provider: true/false when the caller
   * genuinely knows, null when it does not and the routing contract should
   * answer instead.
   *
   * This exists because "can HQ dispatch to CLAUDE from here?" and "are the
   * workflow's routine secrets visible in this process?" are different
   * questions, and only the first one is the one being asked. On the Founder
   * workstation CLAUDE is dispatched through the authenticated `gh` transport
   * while `CLAUDE_ROUTINE_*` is deliberately absent — those are GitHub Actions
   * secrets, and `providers/claude/dispatch.ts` warns that setting them locally
   * would manufacture connectivity. Deriving the live verdict from their
   * absence would report a successfully dispatched order as blocked forever, in
   * exactly the environment this lane is built for.
   */
  providerDispatchable?: (provider: ProviderId) => boolean | null;
}

export function directOrderDispatchBlocked(
  task: { capabilityId: string; payload: Record<string, unknown> },
  env: SecretsEnv,
  context: DispatchBlockedContext = {},
): boolean {
  if (task.capabilityId !== DIRECT_ORDER_CAPABILITY.id) return false;
  // What actually happened outranks what the environment suggests.
  if (context.alreadyDispatched) return false;
  const binding = readProviderBinding(task.payload);
  if (!binding.bound) return false;
  // A binding HQ cannot read is not dispatchable by anyone, which is the
  // strongest truthful answer available.
  if (binding.provider == null || !isProviderId(binding.provider)) return true;
  const observed = context.providerDispatchable?.(binding.provider) ?? null;
  if (observed !== null) return !observed;
  return !providerConnectivity(binding.provider, env).connected;
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
  /**
   * Supply to distinguish a deliberate second order from an accidental
   * repeat of the same one. It is MIXED INTO the derived key, never used as
   * the key: a caller cannot choose the key another order already holds.
   */
  idempotencyKey?: string;
}

export interface DirectOrderReceipt {
  task: OperatorTask;
  classification: TaskClassification;
  /** True when this submission matched an existing order rather than creating one. */
  deduplicated: boolean;
  route: RouteResolution;
  idempotencyKey: string;
  /**
   * The provider this order is BOUND to — what `executionProvider` carries and
   * what the queue will enforce at claim time. For an explicit route this is
   * the requested provider whether or not it can dispatch today; for AUTO it is
   * the provider the route resolved to.
   */
  boundProvider: ProviderId;
  /**
   * True when the order was created but its provider cannot dispatch right now
   * (issue #224). The canonical task exists, is gated exactly as any other, and
   * executes nothing; the browser must show BLOCKED / NOT CONNECTED rather than
   * success. `route.reason` says why, in the routing lane's own words.
   */
  dispatchBlocked: boolean;
}

export type DirectOrderErrorCode =
  | OpsErrorCode
  | 'provider_not_connected'
  | 'capability_not_registered'
  | 'capability_definition_altered'
  | 'empty_instruction'
  | 'instruction_too_long'
  | 'title_too_long'
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
 * Unambiguous encoding for the idempotency digest.
 *
 * Every field is LENGTH-PREFIXED rather than separated, so no input can imitate
 * a field boundary whatever bytes it contains. Two earlier versions of this
 * were wrong in instructive ways. First a raw NUL byte written literally into
 * this source file: invisible in a diff, and silently rewritten by any tool
 * that normalises control characters, which would have changed every key with
 * no visible change. Then the same byte as an escape — which fixed the source
 * but not the CLAIM, because a programmatic or JSON caller can put a NUL inside
 * `project` or `instruction` and nothing rejects it. `("p\u0000q", "r")` and
 * `("p", "q\u0000r")` joined to identical bytes, so two genuinely different
 * orders hashed alike and the second was deduplicated onto the first, keeping
 * the wrong canonical instruction.
 *
 * A length prefix has no such escape hatch: a reader never has to guess where a
 * field ends, so no field content can be mistaken for structure. Byte length,
 * not code-unit length, so a multi-byte character cannot shift a boundary
 * either.
 */
function encodeDigestFields(fields: readonly string[]): string {
  return fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('');
}

/**
 * Deterministic idempotency key.
 *
 * Derived from everything that makes an order THE SAME ORDER: who asked, what
 * they asked for, which project, which route was requested, which provider it
 * actually resolved to, how much is known about the caller, and any key the
 * caller supplied. A double-clicked composer therefore dedupes onto the first
 * task instead of creating a second one, without the browser having to remember
 * anything; changing any of those inputs is a genuinely different order and
 * gets its own key.
 *
 * Each input earns its place by a way the receipt would otherwise lie:
 *
 * - **The RESOLVED provider, not only the requested route.** An `AUTO` order
 *   that resolved to CLAUDE and a later `AUTO` order that resolves to CODEX are
 *   the same four fields, so the second deduplicated onto the CLAUDE task while
 *   its receipt and the CLI both reported `AUTO → CODEX`. The submission result
 *   disagreed with the canonical payload it pointed at — separate from
 *   claim-time binding, which was enforcing the payload correctly.
 * - **The actor-authentication marker.** It is deliberately persisted inside
 *   the approval digest, so an order first submitted with the default
 *   `unauthenticated` marker and then through the local-admin CLI (or the
 *   reverse) returned the original task carrying a different trust context than
 *   the caller supplied. Deduplicating across trust values makes the receipt's
 *   trust context untruthful.
 * - **The published title.** `createTask` deliberately skips its metadata
 *   upsert for a deduplicated task, so two orders alike in every other field
 *   but carrying different titles collapsed onto the first — and the second
 *   caller's title, the one field of an order that reaches the browser, was
 *   silently discarded while the console went on showing the first. Either the
 *   title is part of what makes an order the same order, or a dedupe has to
 *   reject a differing one; it is cheaper and more honest to derive from it.
 *   The RAW trimmed title is used, not the effective one, so that an order
 *   which omitted a title and one which typed the default out longhand stay
 *   distinguishable from each other's intent.
 * - **A caller-supplied key, as an INPUT and never as the key itself.** Passing
 *   it through verbatim made the deduplication table addressable by the caller:
 *   `op_tasks` is unique on (capability, idempotency key), so a caller that
 *   supplied a key another order already held had its own order silently
 *   discarded and was handed the EXISTING task back as its receipt — a
 *   different principal's order, under a different instruction, presented as
 *   the outcome of its own submission. Mixing it into the digest keeps its
 *   legitimate use (the same order with a different key is a deliberate second
 *   order) while making it impossible for one order's key to name another's
 *   task.
 */
export function directOrderIdempotencyKey(
  input: Pick<
    DirectOrderInput,
    | 'instruction'
    | 'project'
    | 'route'
    | 'requestedBy'
    | 'idempotencyKey'
    | 'actorAuthentication'
    | 'title'
  > & {
    /** The provider the route actually resolved to, when it is known. */
    resolvedProvider?: string | null;
  },
): string {
  const digest = createHash('sha256')
    .update(
      encodeDigestFields([
        input.requestedBy,
        input.route,
        input.resolvedProvider ?? '',
        input.actorAuthentication ?? DEFAULT_ACTOR_AUTHENTICATION,
        input.project ?? '',
        input.idempotencyKey ?? '',
        (input.title ?? '').trim(),
        input.instruction.trim(),
      ]),
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
function defaultTitle(boundProvider: ProviderId): string {
  return `Direct order → ${boundProvider}`;
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
  availability?: RouteAvailability,
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
  // The title is the ONE part of an order that reaches the browser, so it is
  // bounded and safety-scanned before the write, exactly like the instruction
  // (open Codex finding on title pre-write validation). An empty or
  // whitespace-only title is not an error — it falls back to the neutral
  // default, the same as omitting it.
  const title = (input.title ?? '').trim();
  if (title.length > MAX_TITLE_LENGTH) {
    return orderFail(
      'title_too_long',
      `An order title may be at most ${MAX_TITLE_LENGTH} characters. It is a label for the ` +
        'Founder console, not a second instruction.',
      { length: title.length },
    );
  }
  if (!DIRECT_ORDER_ROUTES.includes(input.route)) {
    // Deny by default on an unknown route, exactly as on an unknown capability.
    return orderFail('invalid_input', `Unknown route: ${String(input.route)}`);
  }

  // The trust marker is a claim about the caller, and it is persisted inside
  // the approval digest — so an unknown one is refused here rather than
  // recorded (issue #200, Codex finding on `5a19350`). `ActorAuthentication`
  // deliberately has no `authenticated` member, but a union enforces that on
  // TypeScript callers only: a JSON or plain-JavaScript caller could pass
  // `'authenticated'` and manufacture the exact trust claim the vocabulary
  // exists to make unsayable. Deny by default, like every other unknown here.
  if (
    input.actorAuthentication !== undefined &&
    !isCallerAssertableActorAuthentication(input.actorAuthentication)
  ) {
    return orderFail(
      'invalid_input',
      'Unusable actorAuthentication marker. A marker outside the vocabulary is refused rather ' +
        'than persisted into the approval digest, and a marker that must be EARNED — an ' +
        'authenticated session — is refused from a caller asserting it about itself. The ' +
        'authenticated value reaches an order only from the interface that resolved the ' +
        'identity, through a parameter no request body can populate.',
    );
  }
  // Earned beats asserted. `resolvedActorAuthentication` is set only by an
  // interface that authenticated the principal itself, and is unreachable from
  // a deserialized payload, so it wins over anything `input` carries.
  const actorAuthentication: ActorAuthentication =
    availability?.resolvedActorAuthentication ??
    input.actorAuthentication ??
    DEFAULT_ACTOR_AUTHENTICATION;

  // Fail closed on the capability's CURRENT configured state, and never touch
  // it (issue #200, Codex P1 #2). Placing an order is an invocation; it does
  // not register the capability, and it certainly does not re-enable one that
  // someone disabled. The queue would refuse either way — this is here so the
  // refusal names the actual reason instead of a generic policy denial.
  const capabilityState = directOrderCapabilityState(ops);
  if (capabilityState === 'missing') {
    return orderFail(
      'capability_not_registered',
      `Capability ${DIRECT_ORDER_CAPABILITY.id} is not registered here. Registering it is a ` +
        'separate, deliberate configuration action — placing an order never performs it.',
    );
  }
  if (capabilityState === 'altered') {
    // Named fields, not a vague "altered": the Founder needs to know which
    // guarantee the row stopped making. Nothing is repaired here — putting the
    // reserved definition back is the explicit registration action, and an
    // invocation path that quietly restored it would be the same mistake as
    // one that quietly re-enables a disabled capability.
    // The row again, for the same reason the state check reads it: the fields
    // named in the refusal must be the ones the registry actually holds.
    const capability = capabilityRowFor(ops, DIRECT_ORDER_CAPABILITY.id);
    const drift = capability ? directOrderContractDrift(capability) : [];
    return orderFail(
      'capability_definition_altered',
      `Capability ${DIRECT_ORDER_CAPABILITY.id} is registered with a definition that no longer ` +
        `matches its reserved contract (${drift.join(', ')}), so the Founder gate it exists to ` +
        'enforce is not the one the registry would apply. The order is refused. Restoring the ' +
        'reserved definition is a deliberate configuration action; placing an order will not do it.',
      { drift },
    );
  }
  if (capabilityState === 'disabled') {
    return orderFail(
      'capability_disabled',
      `Capability ${DIRECT_ORDER_CAPABILITY.id} is disabled. Re-enabling it is an explicit ` +
        'configuration decision; an order will not do it silently.',
    );
  }

  // An order becomes hash-chained evidence the moment it is created. Refuse a
  // pasted credential here rather than letting the evidence log throw later,
  // when a task may already exist. `assertBrowserSafe` is the stricter of the
  // two guards — it scans each raw string as well as the encoded payload, so a
  // quoted secret cannot hide behind JSON escaping.
  try {
    assertBrowserSafe({ instruction, project: input.project ?? null, title: title || null }, 'order');
  } catch {
    return orderFail(
      'unsafe_instruction',
      'The order looks like it contains a credential. Orders are recorded in the ' +
        'append-only evidence log — and the title is published to the browser — so secrets ' +
        'must never be pasted into one.',
    );
  }

  const route = resolveOrderRoute(input.route, env, availability);
  // Which provider the order is BOUND to, and whether it can dispatch today.
  //
  // These are two different questions, and conflating them was the #200 gap
  // this corrects (issue #224). The old code answered "can it dispatch?" first
  // and refused before creating anything, so a Founder order to CLAUDE placed
  // while `CLAUDE_ROUTINE_*` is absent left `op_tasks` empty: the order was
  // lost, not blocked, and HQ had nothing to show a truthful BLOCKED state
  // about. #200's sequence is create-then-report: the canonical task is the
  // record of what the Founder asked for, and dispatchability is a live
  // property of the provider that HQ reports rather than a precondition of
  // remembering the request.
  //
  // Nothing about the gates changes. The task is created through the same
  // `createTask`, lands in `needs_approval` under the same `founder_gate`
  // class, carries the same digest, and — because `executionProvider` binds it
  // to the requested provider — can still only ever be claimed by a worker
  // declared as that provider. A blocked order is a REMEMBERED order, not a
  // permitted one.
  //
  // Which provider an unresolved order is recorded AGAINST.
  //
  // An explicit route names its own provider, so a blocked `CLAUDE` order is
  // bound to CLAUDE. `AUTO` names none, and the first cut of this correction
  // therefore kept refusing it — reasoning that there was no identity to bind,
  // that binding nothing would widen who could claim it, and that binding an
  // unresolvable value would create a task that could never dispatch.
  //
  // Both independent reviewers disagreed, and they were right: the identity
  // problem has a truthful answer that I had ruled out too early. AUTO's
  // preference order is a DECLARED, deterministic product decision
  // (`AUTO_ROUTE_PREFERENCE`), not a guess — so an AUTO order that resolves to
  // nothing is recorded against the first preference and blocked on it. That
  // is not substitution: substitution means satisfying a request for one named
  // provider with a different one, and AUTO names none. The receipt says
  // exactly what happened — requested AUTO, resolved nothing, bound to the
  // preferred candidate, BLOCKED — so nothing is claimed that is not true.
  //
  // The cost, stated rather than hidden: the binding is fixed once written,
  // because it lives inside the digest a Founder approves. If the SECOND
  // preference connects first, this order stays blocked on the first one and
  // the Founder places an explicit order for the provider that is up. That is
  // the honest trade for keeping the order canonical, resumable and
  // non-claimable, none of which the old refusal delivered at all.
  const preferred = AUTO_ROUTE_PREFERENCE[0];
  const boundProvider: ProviderId | null =
    route.resolved ?? (input.route === 'AUTO' ? (preferred ?? null) : (input.route as ProviderId));
  if (boundProvider == null) {
    // Only reachable if the preference order is emptied — a configuration
    // error, not a connectivity one. Deny by default rather than invent.
    return orderFail('provider_not_connected', route.reason, {
      requested: route.requested,
      candidates: route.candidates,
    });
  }
  // What the ROUTE says at submission. Used only for the historical evidence
  // entry below; the state the caller is told is derived from the task that
  // actually exists — see after `createTask`.
  const routeBlocked = !route.connected;

  // Always derived, never adopted, and derived AFTER the route resolves so the
  // key names the provider the order actually carries — see
  // `directOrderIdempotencyKey`.
  const idempotencyKey = directOrderIdempotencyKey({
    ...input,
    instruction,
    // The BOUND provider, not the resolved one: an explicit order placed while
    // its provider is unreachable and the same order placed once it is back
    // are the same order, and must dedupe onto the same canonical task rather
    // than creating a second one (issue #224).
    resolvedProvider: boundProvider,
    actorAuthentication,
  });
  const created = ops.createTask({
    capabilityId: DIRECT_ORDER_CAPABILITY.id,
    payload: {
      kind: 'direct_order',
      instruction,
      project: input.project ?? null,
      requestedRoute: route.requested,
      // The reserved binding key, not a label: the queue refuses to let any
      // worker but one declared as this provider claim or start the task
      // (issue #200, Codex P1 #1 — `operator/provider-binding.ts`). It is in
      // the payload, so it is inside the action digest a Founder approves:
      // the provider cannot be swapped between approval and execution.
      [EXECUTION_PROVIDER_KEY]: boundProvider,
      // Honesty travels with the action: the approver reading this task sees
      // that `requestedBy` was asserted, not authenticated. It is part of the
      // payload, so it is part of the action digest a Founder echoes back —
      // the assertion cannot be edited away between rendering and approval.
      actorAuthentication,
    },
    idempotencyKey,
    requestedBy: input.requestedBy,
    project: input.project,
    title: title || defaultTitle(boundProvider),
  });

  if (!created.ok) {
    return { ok: false, error: created.error };
  }

  // Evidence-derived, per the correction brief: the block is recorded as an
  // append-only fact about this order rather than baked into the payload, so
  // the digest an approver echoes back stays a description of the ACTION and
  // the block stays a description of the WORLD — which can change while the
  // order waits. Fact NAMES only, never values.
  if (routeBlocked && !created.data.deduplicated) {
    try {
      ops.appendSystemEvidence({
        taskId: created.data.task.id,
        actor: 'system',
        kind: 'direct_order_dispatch_blocked',
        payload: {
          provider: boundProvider,
          requestedRoute: route.requested,
          reason: route.reason,
          missingFacts: route.candidates.flatMap((candidate) => candidate.missingFacts),
        },
      });
    } catch {
      // The order is already canonical and correctly gated; a lost diagnostic
      // must not turn a created order into a reported failure. The block is
      // still derivable live from `providerConnectivity`, which is the source
      // this entry was copied from.
    }
  }

  // Derived from the TASK that now exists, through the one canonical
  // derivation, rather than from the route variable above (issue #224, Codex P2
  // on `66d34cc`).
  //
  // The defect this closes: `!route.connected` describes the environment right
  // now and knows nothing about what already happened. A deduplicated order
  // returns the ORIGINAL task, which may have been dispatched days ago, so an
  // order whose issue is sitting open on GitHub was reported BLOCKED the moment
  // the transport went away — and the CLI receipt said, in as many words, that
  // nothing was running. The approvals view and the snapshot already applied
  // the evidence-first rule (`isDispatchBlocked` in `live/control-api.ts`), so
  // the submission path was the one surface still disagreeing with the other
  // two about the same task.
  //
  // Now all three ask `directOrderDispatchBlocked` with the same two inputs:
  // what HQ has already published, and what a host that holds the real
  // transport observes. Evidence outranks inference on every path or on none.
  //
  // For a task created by THIS call the answer is unchanged — there is no
  // dispatch history yet, and the binding is the provider the route just
  // resolved — so this is strictly a correction to the deduplicated case.
  const dispatchBlocked = directOrderDispatchBlocked(created.data.task, env, {
    alreadyDispatched: dispatchHistory(ops, created.data.task.id).state === 'dispatched',
    providerDispatchable: availability?.providerDispatchable,
  });

  return {
    ok: true,
    data: {
      task: created.data.task,
      classification: created.data.classification,
      deduplicated: created.data.deduplicated,
      route,
      idempotencyKey,
      boundProvider,
      dispatchBlocked,
    },
  };
}
