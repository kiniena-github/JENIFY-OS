/**
 * Claude result ingestion CLI — bring the workflow's report back to HQ
 * (issue #224, ChatGPT P1 on `83e146b`).
 *
 * ## Why this exists
 *
 * `hq:dispatch-claude` carries a canonical order OUT to the Claude GitHub
 * workflow. Nothing carried anything back. `correlateClaudeResult` existed and
 * was tested, but no shipped command called it, so a dispatched task stayed
 * `assigned` however the external work went, and #200's requirement that real
 * status and evidence return to HQ held only on paper.
 *
 * This is the return leg, and it runs here for the same reason the dispatch does:
 * the authenticated GitHub session is the Founder workstation's, and it exists
 * nowhere else.
 *
 * ## What it does, exactly
 *
 * It reads the issue HQ itself opened for a task, looks for the comment carrying
 * CLAUDE's own result marker, and hands it to the canonical correlation. That
 * records that a report ARRIVED, on the canonical task, in the append-only
 * evidence log.
 *
 * It does NOT review the report, pass it, fail it, or complete the task — the
 * party that did the work never declares it done, and this command holds no
 * opinion about quality. It moves no status. It stores no report text: the
 * comment body is external text, so what is recorded is the issue, the verified
 * comment URL, and the login the report was posted under, attested rather than
 * authenticated.
 *
 * Running it repeatedly is safe and expected: an unfinished task simply reports
 * that no result has arrived, and a report already correlated is not recorded
 * twice.
 *
 * ## Usage
 *
 *   npm run hq:ingest-claude --workspace @factoryos/headquarter -- \
 *     --local-admin --task <taskId> --repo <owner>/<name> [--db <path>]
 *
 * Local only in effect: the single network call is a READ of one issue.
 */

import { openHqDatabase } from '../store/db.js';
import { HeadquarterOperations, type DispatchEvidenceGrant } from '../application/service.js';
import {
  LOCAL_ADMIN_ACK_FLAG,
  LOCAL_ADMIN_INTERFACE_NOTICE,
  resolveLocalAdminInvocation,
} from '../live/local-trust.js';
import { ingestClaudeResult } from '../providers/claude/ingest.js';
import { ghCliTransport, isValidTarget, type GitHubTarget } from '../providers/claude/transport.js';
import { readFlag, missingFlagValueMessage } from './flags.js';

function flag(argv: string[], name: string): string | null {
  const reading = readFlag(argv, name);
  if (reading.kind === 'missing_value') usage(missingFlagValueMessage(name));
  return reading.kind === 'value' ? reading.value : null;
}

function usage(message: string): never {
  console.error(`${message}

Usage:
  hq:ingest-claude ${LOCAL_ADMIN_ACK_FLAG} --task <taskId> --repo <owner>/<name> [--db <path>]

Reads the issue HQ dispatched for that task and correlates the workflow's report
to it. It records that a report ARRIVED — it does not review, pass, or complete
the task, and it changes no task status.

${LOCAL_ADMIN_INTERFACE_NOTICE}`);
  process.exit(2);
}

/** Same strictness as dispatch: `a/b/extra` is refused, never trimmed to `a/b`. */
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
  const dbPath = flag(argv, 'db');

  if (!taskId) usage('--task <taskId> is required.');
  if (!target) usage('--repo <owner>/<name> is required, and is verified against what HQ recorded.');

  const db = openHqDatabase(dbPath ?? undefined);
  // This process is the composition root, so it is the one place the
  // dispatch-only evidence capability is handed out (issue #219, Option B). It
  // is captured in a local and passed straight into the lane; nothing reads it
  // off `ops`, because nothing can.
  let evidence: DispatchEvidenceGrant | undefined;
  const ops = new HeadquarterOperations(db, {
    grantDispatchEvidence: (grant) => {
      evidence = grant;
    },
  });
  if (!evidence) {
    throw new Error('The dispatch evidence grant was not issued; refusing to ingest without it.');
  }
  const result = ingestClaudeResult(ops, { taskId, target, transport: ghCliTransport(), evidence });

  if (!result.ok) {
    console.error(`Ingestion refused (${result.error.code}): ${result.error.message}`);
    process.exit(1);
  }

  const { issueNumber, repository, correlated, alreadyCorrelated, reportUrl, attestedAuthor, refusedAuthors } =
    result.data;
  console.log(`task ${result.data.taskId}`);
  console.log(`  issue:   #${issueNumber} in ${repository}`);
  if (correlated) {
    console.log('  result:  CORRELATED — a report arrived and is recorded on the canonical task.');
  } else if (alreadyCorrelated) {
    console.log('  result:  already correlated — nothing was recorded twice.');
  } else {
    console.log('  result:  none yet. No report from the repository owner on that issue.');
  }
  if (reportUrl) console.log(`  report:  ${reportUrl}`);
  if (attestedAuthor) console.log(`  posted by: ${attestedAuthor} (verified: the repository owner)`);

  // Loud, because somebody using the result marker they are not entitled to use
  // is either a mistake worth correcting or an attempt worth knowing about
  // (issue #224, ChatGPT P1 on `a2758f46`). Nothing was correlated for these and
  // nothing was written to the evidence log.
  if (refusedAuthors.length > 0) {
    console.log(
      `\n  ⚠ REFUSED ${refusedAuthors.length} result-marked comment(s) from: ${refusedAuthors.join(', ')}`,
    );
    console.log(
      '    A result marker is public text; it says a comment is SHAPED like a report, not that it',
    );
    console.log(
      '    is one. Only the repository owner may file a result, so these were ignored entirely —',
    );
    console.log('    not correlated, and not recorded in the evidence log.');
  }

  if (correlated) {
    console.log(
      '\nThis records that a report ARRIVED. It does not review it, pass it, or complete the ' +
        'task — the party that did the work never declares it done. Independent review is a ' +
        'separate step, and the task status is unchanged.',
    );
  }
}

main();
