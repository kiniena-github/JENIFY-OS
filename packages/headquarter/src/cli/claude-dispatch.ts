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
 *     --local-admin --task <taskId> --repo <owner>/<name> --as-worker <workerId> \
 *     [--role BUILDER|REVIEWER|MANAGER|RESEARCHER] [--db <path>] [--check-only]
 *
 * `--check-only` reports task eligibility, dispatch history, the observed
 * transport state and — when `--as-worker` is given — whether the designated
 * executor could actually claim the task. It publishes nothing, claims nothing
 * and consumes no approval: the safe way to see whether a dispatch would work.
 */

import { openHqDatabase } from '../store/db.js';
import { HeadquarterOperations } from '../application/service.js';
import {
  LOCAL_ADMIN_ACK_FLAG,
  LOCAL_ADMIN_INTERFACE_NOTICE,
  resolveLocalAdminInvocation,
} from '../live/local-trust.js';
import { HQ_DISPATCH_LABEL, ROLES, type Role } from '../routing/providers.js';
import {
  claudeDispatchEligibility,
  dispatchClaudeTask,
  dispatchHistory,
  executorReadiness,
  DEFAULT_DISPATCH_ROLE,
} from '../providers/claude/dispatch.js';
import { ghCliTransport, isValidTarget, type GitHubTarget } from '../providers/claude/transport.js';
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
  hq:dispatch-claude ${LOCAL_ADMIN_ACK_FLAG} --task <taskId> --repo <owner>/<name>
                     --as-worker <workerId>
                     [--role ${ROLES.join('|')}] [--db <path>] [--check-only]

The task must already be canonical, CLAUDE-bound and cleared to execute. This
command creates no task, approves nothing, registers no worker, and substitutes
no provider.

--as-worker names the registered CLAUDE worker the handoff claims the task for.
It is required to dispatch, and optional with --check-only, where it is only
READ (nothing is claimed). Register and declare it first with
  hq:order ${LOCAL_ADMIN_ACK_FLAG} --as <founderId> --register-worker <workerId>=<capability>
  hq:order ${LOCAL_ADMIN_ACK_FLAG} --as <founderId> --declare-provider <workerId>=CLAUDE

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

  // The registered worker the canonical claim is taken for (issue #224, Founder
  // decision approving option 1). REQUIRED to dispatch and never defaulted: the
  // handoff claims the task before publishing, so the external execution is
  // answerable to a fence and a consumed approval, and dispatch must never mint,
  // guess or assume an identity. Registering and declaring this worker are
  // separate, Founder-gated configuration acts (`hq:order --register-worker`,
  // `hq:order --declare-provider`).
  const executorWorkerId = flag(argv, 'as-worker');
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

    // The executor gate is part of "would this dispatch work?" (issue #224,
    // ChatGPT P2 on `83e146b`). Without it this command could print ELIGIBLE
    // for a dispatch that fails instantly because the designated worker is
    // missing, inactive, uncapable or undeclared — and this is the first step
    // of the approved local proof, so that answer would be believed.
    //
    // Read-only: it reports the same facts the claim will check, and takes no
    // claim and consumes no approval. Passing `--as-worker` here therefore
    // publishes and reserves nothing.
    if (executorWorkerId) {
      const capabilityId = ops.queue.get(taskId)?.capabilityId ?? null;
      const readiness = executorReadiness(ops, executorWorkerId, capabilityId);
      console.log(
        `  executor:    ${executorWorkerId} — ${
          readiness.ready ? 'CLAIMABLE (read-only check; nothing was reserved)' : 'WOULD REFUSE'
        }`,
      );
      console.log(
        `               registered=${readiness.registered} active=${readiness.active} ` +
          `capability=${readiness.hasCapability} declared=${readiness.declaredProvider ?? 'none'}`,
      );
      for (const problem of readiness.problems) console.log(`               - ${problem}`);
    } else {
      console.log(
        '  executor:    NOT CHECKED — pass --as-worker <workerId> to verify the designated ' +
          'executor too. Eligibility above says nothing about whether that worker can claim.',
      );
    }
    // The durable HQ identity (issue #224, Codex P1 on `2dc86e8`). Stated
    // rather than checked, deliberately: the only way this transport can
    // establish whether the label exists is to create it, and this command
    // promises to write nothing. So it says what dispatch will do and what
    // happens if that fails, instead of printing a green line it did not earn.
    console.log(
      `  hq label:    NOT CHECKED — dispatch creates \`${HQ_DISPATCH_LABEL}\` in the target ` +
        'repository if it is missing (never --force) and applies it to the issue. That label is ' +
        'what keeps an HQ dispatch recognisable after its body has been edited. Checking it here ' +
        'would mean creating it, and this command writes nothing. If it cannot be created, the ' +
        'dispatch refuses with `dispatch_label_unavailable` and publishes nothing.',
    );
    console.log('\nCheck only — nothing was published, claimed or approved.');
    return;
  }

  if (!executorWorkerId) {
    usage(
      '--as-worker <workerId> is required to dispatch: the handoff claims the canonical task for ' +
        'that registered worker before publishing, so the external execution is bound to a fence ' +
        'and a consumed approval. Register and declare it as an explicit configuration act first; ' +
        'this command will not invent one. (--check-only needs no worker: it publishes nothing.)',
    );
  }
  const result = dispatchClaudeTask(ops, { taskId, target, transport, role, executorWorkerId });
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
