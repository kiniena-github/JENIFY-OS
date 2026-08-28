/**
 * Founder Direct Order CLI (issue #200, scope B — the working write path).
 *
 * ## Why this is a CLI and not a browser button
 *
 * `HeadquarterOperations.createTask` authorizes by resolving `requestedBy`
 * against the human-principal registry. Headquarter has no authenticated
 * browser session that can establish who the requester is, so a browser write
 * would have to trust a client-supplied principal id — impersonation — or
 * ship a new authentication boundary invented under automation, which the
 * mission's Founder-only gates cover. Neither is acceptable, so the composer
 * in the UI is inert and this is where an order is actually placed: here the
 * Founder's own OS session on their own workstation IS the authentication,
 * and the principal id is asserted by someone who already has the machine.
 *
 * Everything after that point is the ordinary, unmodified control plane:
 * capability allow-list from the registry, `founder_gate` classification,
 * `needs_approval` with an action digest, hash-chained evidence.
 *
 * ## Usage
 *
 *   npm run hq:order --workspace @factoryos/headquarter -- \
 *     --as founder --instruction "Draft the Q3 maintenance plan" \
 *     [--project mesob] [--route AUTO|CLAUDE|CODEX] [--db path] [--dry-run]
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
  hq:order --as <principalId> --instruction "<what to do>"
           [--project <label>] [--route ${DIRECT_ORDER_ROUTES.join('|')}]
           [--db <path>] [--dry-run]`);
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
  const requestedBy = flag(argv, 'as');
  const instruction = flag(argv, 'instruction');
  const project = flag(argv, 'project') ?? undefined;
  const routeArg = (flag(argv, 'route') ?? 'AUTO').toUpperCase();
  const dbPath = flag(argv, 'db');
  const dryRun = argv.includes('--dry-run');

  if (!requestedBy) usage('--as <principalId> is required: an order must be attributable.');
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

  const result = submitDirectOrder(ops, { instruction, project, route, requestedBy }, env);

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
  console.log(
    classification.requiresApproval
      ? '\nThis order executes NOTHING until a Founder approves that exact action by digest.'
      : '\nThis order runs under standing policy.',
  );
}

main();
