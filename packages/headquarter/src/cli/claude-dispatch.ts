/**
 * Claude dispatch CLI — carry an approved HQ order to the existing Claude
 * GitHub workflow (issue #221).
 *
 * ## Why this runs here and not in the browser
 *
 * The transport is the Founder workstation's own authenticated GitHub session.
 * That session exists on that machine and nowhere else — not on a GitHub-hosted
 * runner, not in a hosted preview, and certainly not in a browser tab. So the
 * dispatch step is a local command, exactly like the Codex review lane, and the
 * browser composer stays what it is: the place an order is CREATED and gated,
 * never the place work is fired.
 *
 * ## What it can and cannot do
 *
 * It cannot create, classify, approve, or re-route anything. It takes the id of
 * a task the canonical control plane has already cleared to run and asks the
 * dispatch adapter to publish it. Every gate lives in
 * `providers/claude/dispatch.ts`; this file only parses arguments and prints.
 *
 * Like `hq:order`, it is a TRUSTED-LOCAL-ADMIN interface: running it establishes
 * only that the caller can run a process against the HQ database. It therefore
 * refuses under CI and requires the explicit local-trust acknowledgement, and it
 * asserts no principal — dispatch attributes nothing to a human, because it
 * decides nothing on a human's behalf.
 *
 * ## Usage
 *
 *   npm run hq:dispatch-claude --workspace @factoryos/headquarter -- \
 *     --local-admin --task <taskId> --repo <owner>/<name> \
 *     [--role BUILDER|REVIEWER|MANAGER|RESEARCHER] [--db <path>] [--check-only]
 *
 * `--check-only` reports eligibility and the observed transport state and
 * publishes nothing — the safe way to see whether a dispatch would work.
 */

import { openHqDatabase } from '../store/db.js';
import { HeadquarterOperations } from '../application/service.js';
import {
  LOCAL_ADMIN_ACK_FLAG,
  LOCAL_ADMIN_INTERFACE_NOTICE,
  resolveLocalAdminInvocation,
} from '../live/local-trust.js';
import { ROLES, type Role } from '../routing/providers.js';
import {
  claudeDispatchEligibility,
  dispatchClaudeTask,
  dispatchHistory,
  DEFAULT_DISPATCH_ROLE,
} from '../providers/claude/dispatch.js';
import { ghCliTransport, isValidTarget, type GitHubTarget } from '../providers/claude/transport.js';

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

function usage(message: string): never {
  console.error(`${message}

Usage:
  hq:dispatch-claude ${LOCAL_ADMIN_ACK_FLAG} --task <taskId> --repo <owner>/<name>
                     [--role ${ROLES.join('|')}] [--db <path>] [--check-only]

The task must already be canonical, CLAUDE-bound and cleared to execute. This
command creates no task, approves nothing, and substitutes no provider.

${LOCAL_ADMIN_INTERFACE_NOTICE}`);
  process.exit(2);
}

/**
 * Parse `owner/repo`, and reject anything that is not exactly that (issue #221,
 * Codex P2 on `1d5b3bf`).
 *
 * Destructuring alone silently DISCARDED extra segments, so `--repo a/b/extra`
 * validated as `a/b` and published there. Choosing the repository is the guard
 * on an irreversible act, so unexpected input is refused rather than trimmed
 * into something plausible.
 */
function parseTarget(slug: string | null): GitHubTarget | null {
  if (!slug) return null;
  const segments = slug.split('/');
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  const target = { owner, repo };
  return isValidTarget(target) ? target : null;
}

function main(): void {
  const argv = process.argv.slice(2);

  const invocation = resolveLocalAdminInvocation(argv, process.env);
  if (!invocation.ok) {
    console.error(invocation.message);
    process.exit(2);
  }
  console.log(`${LOCAL_ADMIN_INTERFACE_NOTICE}\n`);

  const taskId = flag(argv, 'task');
  const target = parseTarget(flag(argv, 'repo'));
  const roleArg = (flag(argv, 'role') ?? DEFAULT_DISPATCH_ROLE).toUpperCase();
  const dbPath = flag(argv, 'db');
  const checkOnly = argv.includes('--check-only');

  if (!taskId) usage('--task <taskId> is required.');
  if (!target) usage('--repo <owner>/<name> is required, and there is no default: dispatch publishes the order.');
  if (!(ROLES as readonly string[]).includes(roleArg)) usage(`--role must be one of ${ROLES.join(', ')}.`);
  const role = roleArg as Role;

  const db = openHqDatabase(dbPath ?? undefined);
  const ops = new HeadquarterOperations(db);
  // Observed on THIS machine, which is the machine that would dispatch. No
  // token value is read: the transport reports presence and identity only.
  const transport = ghCliTransport();

  if (checkOnly) {
    const eligibility = claudeDispatchEligibility(ops, taskId);
    const history = dispatchHistory(ops, taskId);
    const status = transport.status();
    console.log(`task ${taskId}`);
    console.log(
      eligibility.eligible
        ? '  eligibility: ELIGIBLE — canonical, CLAUDE-bound and cleared to execute.'
        : `  eligibility: REFUSED (${eligibility.code}) — ${eligibility.message}`,
    );
    console.log(`  dispatch:    ${history.state}`);
    console.log(
      `  transport:   ${transport.id} — ${
        status.authenticated ? `authenticated as ${status.account}` : 'NOT CONNECTED / SETUP REQUIRED'
      }`,
    );
    console.log(`               ${status.reason}`);
    console.log('\nCheck only — nothing was published.');
    return;
  }

  const result = dispatchClaudeTask(ops, { taskId, target, transport, role });
  if (!result.ok) {
    console.error(`Dispatch refused (${result.error.code}): ${result.error.message}`);
    process.exit(1);
  }
  const receipt = result.data;
  console.log(receipt.deduplicated ? 'Already dispatched — no second issue was opened.' : 'Dispatched.');
  console.log(`  task:     ${receipt.taskId}`);
  console.log(`  provider: ${receipt.provider} (bound; no substitution)`);
  console.log(`  issue:    ${receipt.issueUrl}`);
  console.log(
    '\nThe existing Claude workflow decides what happens next. HQ recorded the dispatch; it has ' +
      'not recorded, reviewed, or completed any result.',
  );
}

main();
