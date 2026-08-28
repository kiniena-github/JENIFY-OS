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
  // Deny by default: the capability does not exist until a deployment asks
  // for it. Registering it here is that explicit ask.
  registerDirectOrderCapability(ops);

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
