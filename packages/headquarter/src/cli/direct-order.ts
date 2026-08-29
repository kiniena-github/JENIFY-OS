/**
 * Direct Order CLI — a TRUSTED-LOCAL-ADMIN / MAINTENANCE interface
 * (issue #200, scope B; classification corrected after the PR #201 review).
 *
 * ## What this interface is, precisely
 *
 * It is the maintenance path by which someone who ALREADY holds full local
 * trust over the Headquarter database opens a canonical, gated order. It is
 * **not** an authenticated Founder-facing path, and it must never be described
 * as one: `--as <id>` asserts a principal id and binds it to nothing — not the
 * OS user, not the process owner, not a credential. The earlier claim that
 * "the Founder's own OS session is the authentication" was an overclaim and
 * has been removed.
 *
 * What the interface really establishes is that the caller can run a process
 * against the HQ SQLite file. Anyone who can do that could already write that
 * file directly, so this command adds no authority — and that is exactly why
 * it may exist while browser writes may not, and equally why it may not claim
 * to authenticate anybody. `live/local-trust.ts` holds the full reasoning, the
 * fail-closed invocation rules and the vocabulary.
 *
 * Consequently issue #200 is NOT fully Founder-operable: a genuine HQ
 * authentication boundary is a Founder-gated security decision that remains
 * open, and until it exists both the browser composer and Founder approvals
 * stay read-only.
 *
 * Everything after the assertion is the ordinary, unmodified control plane:
 * deny-by-default authorization against the principal registry, capability
 * allow-list from the registry, `founder_gate` classification, `needs_approval`
 * with an action digest, hash-chained evidence — and the canonical
 * no-self-approval rule, which means the asserted principal is precisely the
 * one who cannot approve the order it just opened.
 *
 * ## Usage
 *
 *   npm run hq:order --workspace @factoryos/headquarter -- \
 *     --local-admin --as founder --instruction "Draft the Q3 maintenance plan" \
 *     [--project mesob] [--route AUTO|CLAUDE|CODEX] [--db path] [--dry-run]
 *
 * Configuration is a separate run and never happens as a side effect of an
 * order (issue #200, Codex P1 #2):
 *
 *   npm run hq:order --workspace @factoryos/headquarter -- \
 *     --local-admin --register-capability [--db path]
 *
 * That registers `hq.direct_order` when it is absent. It does NOT enable a
 * capability someone disabled — disabling is a containment decision, and no
 * invocation path may quietly undo it. Placing an order against a missing or
 * disabled capability fails closed with that exact reason.
 *
 * `--local-admin` is a required acknowledgement of the trust model above, so
 * an unattended script cannot place principal-attributed orders by accident.
 * The command refuses to run under CI entirely, with no override.
 *
 * `--dry-run` resolves and prints the route without creating anything, so
 * route availability can be checked without opening work.
 *
 * Local only: no network call is made by this file.
 */

import { openHqDatabase } from '../store/db.js';
import { WORKER_ROLES, type WorkerRole } from '../contracts/workers.js';
import { HeadquarterOperations } from '../application/service.js';
import {
  DIRECT_ORDER_CAPABILITY,
  DIRECT_ORDER_ROUTES,
  directOrderCapabilityState,
  registerDirectOrderCapability,
  resolveOrderRoute,
  submitDirectOrder,
  type DirectOrderCapabilityState,
  type DirectOrderRoute,
} from '../live/orders.js';
import {
  LOCAL_ADMIN_ACK_FLAG,
  LOCAL_ADMIN_INTERFACE_NOTICE,
  resolveLocalAdminInvocation,
} from '../live/local-trust.js';
import { PROVIDER_REGISTRY, type SecretsEnv } from '../routing/providers.js';
import { probeCodex } from '../providers/codex/probe.js';
import { formatOrderReceipt } from './order-receipt.js';
import { transportRouteAvailability } from '../providers/claude/dispatch-availability.js';
import { ghCliTransport } from '../providers/claude/transport.js';
import { readFlag, missingFlagValueMessage } from './flags.js';

function flag(argv: string[], name: string): string | null {
  // Three outcomes, not two (issue #224, Codex P2 on `f9383dc`). A flag given
  // without a value REFUSES rather than falling back to a default nobody chose
  // or swallowing the next option as its value — this command writes to the HQ
  // database, so a malformed invocation must not mutate anything.
  const reading = readFlag(argv, name);
  if (reading.kind === 'missing_value') usage(missingFlagValueMessage(name));
  return reading.kind === 'value' ? reading.value : null;
}

function usage(message: string): never {
  console.error(`${message}

Usage:
  hq:order ${LOCAL_ADMIN_ACK_FLAG} --as <principalId> --instruction "<what to do>"
           [--project <label>] [--route ${DIRECT_ORDER_ROUTES.join('|')}]
           [--db <path>] [--dry-run]

  hq:order ${LOCAL_ADMIN_ACK_FLAG} --register-capability [--db <path>]
           Configuration only: registers ${DIRECT_ORDER_CAPABILITY.id} if it is
           absent. It never enables a capability that was disabled, and it
           never places an order.

  hq:order ${LOCAL_ADMIN_ACK_FLAG} --declare-provider <workerId>=<PROVIDER>
           --as <principalId> [--db <path>]
           Configuration only: declares which provider a worker executes as, so
           it may claim orders bound to that provider. The declaring principal
           must hold approval authority; a worker can never declare one.

  hq:order ${LOCAL_ADMIN_ACK_FLAG} --register-worker <workerId>=<capability>[,<capability>…]
           --as <principalId> [--worker-name "<display name>"] [--worker-vendor <vendor>]
           [--worker-role <role>] [--db <path>]
           Configuration only: registers an execution worker — for instance the
           external Claude GitHub workflow the dispatch handoff claims tasks for.
           Create-only (an existing worker is refused, never overwritten), and it
           grants no provider identity: declare that separately.

${LOCAL_ADMIN_INTERFACE_NOTICE}`);
  process.exit(2);
}

/**
 * Observe the non-secret facts routing needs, exactly as the workflow lane
 * does. Presence only — no credential value is read, and the Codex probe
 * reports an auth MODE, never a token.
 */
function observeFacts(): SecretsEnv {
  const names = new Set(
    Object.values(PROVIDER_REGISTRY).flatMap((provider) => [
      ...provider.requiredSecrets,
      ...provider.requiredLocalFacts,
    ]),
  );
  const env: SecretsEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value.trim() !== '') env[name] = value;
  }
  // A local CLI provider can only be observed on the machine that would run
  // it — which is exactly where this command runs.
  for (const [name, value] of Object.entries(probeCodex().facts)) env[name] = value;
  return env;
}

function main(): void {
  const argv = process.argv.slice(2);

  // Fail closed BEFORE anything is parsed, opened or resolved: an interface
  // that cannot authenticate its actor may only run where local trust is a
  // real claim, and only when the operator has said so explicitly.
  const invocation = resolveLocalAdminInvocation(argv, process.env);
  if (!invocation.ok) {
    console.error(invocation.message);
    process.exit(2);
  }
  console.log(`${LOCAL_ADMIN_INTERFACE_NOTICE}\n`);

  const requestedBy = flag(argv, 'as');
  const instruction = flag(argv, 'instruction');
  const project = flag(argv, 'project') ?? undefined;
  const routeArg = (flag(argv, 'route') ?? 'AUTO').toUpperCase();
  const dbPath = flag(argv, 'db');
  const dryRun = argv.includes('--dry-run');
  const registerCapability = argv.includes('--register-capability');
  const declareProvider = flag(argv, 'declare-provider');
  const registerWorker = flag(argv, 'register-worker');

  // Configuration and invocation are different commands wearing one name; they
  // are never performed in the same run.
  if (registerCapability) {
    if (instruction) {
      usage('--register-capability is a configuration action and does not place an order.');
    }
    const configDb = openHqDatabase(dbPath ?? undefined);
    const configOps = new HeadquarterOperations(configDb);
    const before = directOrderCapabilityState(configOps);
    registerDirectOrderCapability(configOps);
    const after = directOrderCapabilityState(configOps);
    console.log(`Capability ${DIRECT_ORDER_CAPABILITY.id}: ${before} → ${after}`);
    if (before === 'altered') {
      console.log(
        'Its definition had drifted from the reserved Founder-gated contract and has been ' +
          'restored. Worth asking what re-registered it with a weaker one.',
      );
    }
    if (after === 'disabled') {
      console.log(
        'It stays DISABLED. Registration does not enable a capability that was deliberately ' +
          'disabled; re-enabling it is its own explicit configuration decision.',
      );
    }
    console.log('\nConfiguration only — no order was placed.');
    return;
  }

  // Declaring which provider a worker executes as is the OTHER configuration
  // action, and it goes through `HeadquarterOperations.declareWorkerProvider`
  // — which resolves the actor and requires approval authority — never through
  // a queue handle (issue #200, Codex round-3 P1 #1). Like registration, it is
  // never performed in the same run as an order.
  if (declareProvider) {
    if (instruction) {
      usage('--declare-provider is a configuration action and does not place an order.');
    }
    if (!requestedBy) {
      usage('--declare-provider needs --as <principalId>: the declaring principal must hold approval authority.');
    }
    const [workerId, providerId] = declareProvider.split('=');
    if (!workerId || !providerId) {
      usage('--declare-provider expects <workerId>=<PROVIDER>, e.g. claude-worker=CLAUDE.');
    }
    const configDb = openHqDatabase(dbPath ?? undefined);
    const configOps = new HeadquarterOperations(configDb);
    const declared = configOps.declareWorkerProvider({
      workerId: workerId!,
      providerId: providerId!,
      founderId: requestedBy!,
    });
    if (!declared.ok) {
      console.error(`Declaration refused (${declared.error.code}): ${declared.error.message}`);
      process.exit(1);
    }
    console.log(
      `Worker ${declared.data.workerId} executes as ${declared.data.providerId} ` +
        `(declared by ${declared.data.declaredBy} at ${declared.data.declaredAt}).`,
    );
    console.log('\nConfiguration only — no order was placed.');
    return;
  }

  // Registering the worker an external execution lane runs as is the THIRD
  // configuration action (issue #224, ChatGPT P1 on `83e146b`). The Claude
  // handoff requires a registered, declared worker before it publishes anything,
  // and nothing canonical could create one: `upsertSpecialist` is a store method,
  // so the real instruction on the Founder workstation was "open the database",
  // which is not a Founder gate. It goes through
  // `HeadquarterOperations.registerExecutionWorker`, which resolves the actor,
  // requires approval authority, refuses an existing id and refuses unknown
  // capabilities. Never performed in the same run as an order.
  if (registerWorker) {
    if (instruction) {
      usage('--register-worker is a configuration action and does not place an order.');
    }
    if (!requestedBy) {
      usage('--register-worker needs --as <principalId>: the registering principal must hold approval authority.');
    }
    const [workerId, capabilityList] = registerWorker.split('=');
    if (!workerId || !capabilityList) {
      usage(
        '--register-worker expects <workerId>=<capability>[,<capability>…], e.g. ' +
          `claude-github-workflow=${DIRECT_ORDER_CAPABILITY.id}.`,
      );
    }
    const allowedCapabilities = capabilityList!
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const roleArg = flag(argv, 'worker-role') ?? 'build_lead';
    if (!(WORKER_ROLES as readonly string[]).includes(roleArg)) {
      usage(`--worker-role must be one of ${WORKER_ROLES.join(', ')}.`);
    }
    const configDb = openHqDatabase(dbPath ?? undefined);
    const configOps = new HeadquarterOperations(configDb);
    const registered = configOps.registerExecutionWorker({
      workerId: workerId!,
      displayName: flag(argv, 'worker-name') ?? workerId!,
      vendor: flag(argv, 'worker-vendor') ?? 'unspecified',
      role: roleArg as WorkerRole,
      allowedCapabilities,
      founderId: requestedBy!,
    });
    if (!registered.ok) {
      console.error(`Registration refused (${registered.error.code}): ${registered.error.message}`);
      process.exit(1);
    }
    console.log(
      `Worker ${registered.data.id} registered (${registered.data.role}, vendor ` +
        `${registered.data.vendor}) by ${requestedBy}.`,
    );
    console.log(`  capabilities: ${registered.data.allowedCapabilities.join(', ')}`);
    console.log(
      '\nIt has NO provider identity yet, so it cannot claim a provider-bound order. Declare it ' +
        `separately:\n  hq:order ${LOCAL_ADMIN_ACK_FLAG} --as ${requestedBy} ` +
        `--declare-provider ${registered.data.id}=<PROVIDER>`,
    );
    console.log('\nConfiguration only — no order was placed.');
    return;
  }

  if (!requestedBy) {
    usage('--as <principalId> is required: an order must be attributable (attributable, not authenticated).');
  }
  if (!instruction) usage('--instruction "<what to do>" is required.');
  if (!(DIRECT_ORDER_ROUTES as readonly string[]).includes(routeArg)) {
    usage(`--route must be one of ${DIRECT_ORDER_ROUTES.join(', ')}.`);
  }
  const route = routeArg as DirectOrderRoute;

  const env = observeFacts();

  // The transport-backed verdict, observed HERE (issue #224, Codex P1 on
  // `66d34cc`). This command runs on the Founder workstation, which is the one
  // machine that can actually see the `gh` session — so it is the caller with
  // the least excuse for inferring dispatchability from `CLAUDE_ROUTINE_*`,
  // which are GitHub Actions secrets and are deliberately absent here. Without
  // it a CLAUDE or AUTO order reported `BLOCKED — NOT CONNECTED` on precisely
  // the workstation where it was dispatchable.
  //
  // One instance for the whole run, because the object is the unit of caching
  // and the dry-run path resolves three routes.
  const availability = transportRouteAvailability(ghCliTransport());

  if (dryRun) {
    const resolution = resolveOrderRoute(route, env, availability);
    console.log(`Route ${route}: ${resolution.connected ? `→ ${resolution.resolved}` : 'BLOCKED'}`);
    console.log(resolution.reason);
    for (const candidate of resolution.candidates) {
      console.log(
        `  ${candidate.provider}: ${candidate.connected ? 'connected' : 'not connected'}` +
          (candidate.missingFacts.length > 0 ? ` (missing: ${candidate.missingFacts.join(', ')})` : ''),
      );
    }
    console.log('\nDry run — nothing was created.');
    return;
  }

  const db = openHqDatabase(dbPath ?? undefined);
  const ops = new HeadquarterOperations(db);

  // Registration is a SEPARATE, explicit action (issue #200, Codex P1 #2),
  // handled above and never in the same run as an order. Placing an order must
  // never register the capability as a side effect, and must never turn a
  // disabled one back on: disabling `hq.direct_order` is how a deployment stops
  // direct orders, and an invocation may not undo it.
  const capabilityState = directOrderCapabilityState(ops);
  if (capabilityState !== 'enabled') {
    // One refusal per state, each naming the state's own remedy. `altered`
    // (issue #219, Codex P1) is the one that is not about the on/off switch:
    // the row exists and may well be enabled, but its risk/side-effect
    // definition no longer carries the Founder gate this path depends on.
    const REFUSALS: Record<Exclude<DirectOrderCapabilityState, 'enabled'>, [string, string]> = {
      missing: [
        'capability_not_registered',
        'Register it deliberately with --register-capability.',
      ],
      altered: [
        'capability_definition_altered',
        'Its registered definition no longer matches the reserved Founder-gated contract ' +
          '(risk class, side effect, idempotency), so the approval gate the order relies on ' +
          'would not be applied. Restore it deliberately with --register-capability.',
      ],
      disabled: [
        'capability_disabled',
        'Re-enabling a disabled capability is an explicit configuration decision, not something ' +
          'placing an order may do.',
      ],
    };
    const [code, remedy] = REFUSALS[capabilityState];
    console.error(
      `Order refused (${code}): ${DIRECT_ORDER_CAPABILITY.id} is ${capabilityState} in this ` +
        `database. ${remedy}`,
    );
    process.exit(1);
  }

  const result = submitDirectOrder(
    ops,
    {
      instruction,
      project,
      route,
      requestedBy,
      // Recorded on the canonical task, and therefore inside the action digest
      // the approver echoes back: this attribution was asserted at a local
      // maintenance interface, not proven.
      actorAuthentication: 'unauthenticated_local_assertion',
    },
    env,
    // The same verdict the dry run reported, so `--dry-run` and the real
    // submission can never disagree about whether the route is dispatchable.
    availability,
  );

  if (!result.ok) {
    console.error(`Order refused (${result.error.code}): ${result.error.message}`);
    process.exit(1);
  }

  // The wording lives in `cli/order-receipt.ts` so it can be executed by a
  // test: this file calls main() at import time, so nothing in it is testable,
  // and the receipt is exactly where a surface quietly starts misreporting.
  for (const line of formatOrderReceipt(result.data, {
    capabilityId: DIRECT_ORDER_CAPABILITY.id,
    requestedBy,
  })) {
    console.log(line);
  }
}

main();
