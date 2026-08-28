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
import { HeadquarterOperations } from '../application/service.js';
import {
  DIRECT_ORDER_CAPABILITY,
  DIRECT_ORDER_ROUTES,
  directOrderCapabilityState,
  registerDirectOrderCapability,
  resolveOrderRoute,
  submitDirectOrder,
  type DirectOrderRoute,
} from '../live/orders.js';
import {
  LOCAL_ADMIN_ACK_FLAG,
  LOCAL_ADMIN_INTERFACE_NOTICE,
  resolveLocalAdminInvocation,
} from '../live/local-trust.js';
import { PROVIDER_REGISTRY, type SecretsEnv } from '../routing/providers.js';
import { probeCodex } from '../providers/codex/probe.js';

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
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

  if (!requestedBy) {
    usage('--as <principalId> is required: an order must be attributable (attributable, not authenticated).');
  }
  if (!instruction) usage('--instruction "<what to do>" is required.');
  if (!(DIRECT_ORDER_ROUTES as readonly string[]).includes(routeArg)) {
    usage(`--route must be one of ${DIRECT_ORDER_ROUTES.join(', ')}.`);
  }
  const route = routeArg as DirectOrderRoute;

  const env = observeFacts();

  if (dryRun) {
    const resolution = resolveOrderRoute(route, env);
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
    console.error(
      `Order refused (capability_${capabilityState === 'missing' ? 'not_registered' : 'disabled'}): ` +
        `${DIRECT_ORDER_CAPABILITY.id} is ${capabilityState} in this database. ` +
        (capabilityState === 'missing'
          ? `Register it deliberately with --register-capability.`
          : `Re-enabling a disabled capability is an explicit configuration decision, not something ` +
            `placing an order may do.`),
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
  );

  if (!result.ok) {
    console.error(`Order refused (${result.error.code}): ${result.error.message}`);
    process.exit(1);
  }

  const { task, classification, deduplicated, route: resolution, idempotencyKey } = result.data;
  console.log(deduplicated ? 'Matched an existing identical order.' : 'Order created.');
  console.log(`  task:        ${task.id}`);
  console.log(`  capability:  ${DIRECT_ORDER_CAPABILITY.id} (${classification.riskClass})`);
  console.log(`  status:      ${task.status}`);
  console.log(`  route:       ${resolution.requested} → ${resolution.resolved}`);
  console.log(`  idempotency: ${idempotencyKey}`);
  console.log(`  actor:       ${requestedBy} (asserted locally, NOT authenticated)`);
  console.log(
    classification.requiresApproval
      ? `\nThis order executes NOTHING until a Founder approves that exact action by digest.\n` +
          `And ${requestedBy} cannot be that Founder: the canonical no-self-approval rule refuses ` +
          `an approval by the principal the task was opened as.`
      : '\nThis order runs under standing policy.',
  );
}

main();
