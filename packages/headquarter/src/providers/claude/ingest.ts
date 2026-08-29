/**
 * The return path: observe what the Claude workflow reported, and correlate it
 * to the canonical task (issue #224, ChatGPT P1 on `83e146b`).
 *
 * ## The gap this closes
 *
 * `correlateClaudeResult` was written, tested and reachable — from tests. No
 * shipped command called it, and the GitHub connector is read-only ingestion
 * that does not know about this lane. So a dispatched task stayed `assigned`
 * forever no matter what happened on GitHub, and #200's requirement that real
 * status and evidence come BACK to HQ was satisfied only in principle. A seam
 * nothing calls is a design, not a feature.
 *
 * This is the smallest path that closes it: read the issue HQ itself dispatched,
 * look for the provider's own result marker, and hand what it finds to the
 * canonical correlation.
 *
 * ## What it deliberately does not do
 *
 * - **It does not review.** Correlation records that a report ARRIVED. The party
 *   that did the work is never the party that declares it done, so nothing here
 *   passes, fails or completes a task, and no status moves.
 * - **It does not trust the report.** The comment body is text written by
 *   whoever could comment on that issue. It is never executed, never stored as
 *   evidence, and never allowed to name the task it attaches to — the authority
 *   for "which task is this issue?" is what HQ wrote when it dispatched.
 * - **It does not substitute a provider.** A report that is not CLAUDE's is
 *   refused by `correlateClaudeResult`, not re-attributed.
 * - **It reads one issue**, the one recorded for this task, in the repository
 *   recorded beside it. A caller naming a different repository is refused rather
 *   than followed.
 */

import type { HeadquarterOperations } from '../../application/service.js';
import { PROVIDER_REGISTRY } from '../../routing/providers.js';
import {
  CLAUDE_DISPATCH_EVIDENCE,
  DISPATCH_PROVIDER,
  correlateClaudeResult,
  dispatchHistory,
} from './dispatch.js';
import {
  isValidTarget,
  parseIssueUrl,
  sameRepository,
  targetSlug,
  type GitHubIssueComment,
  type GitHubIssueTransport,
  type GitHubTarget,
} from './transport.js';

/** The marker CLAUDE's own report carries. A registry fact, not a literal here. */
export const CLAUDE_RESULT_MARKER = PROVIDER_REGISTRY.CLAUDE.resultMarker;

export type IngestRefusalCode =
  | 'unknown_task'
  | 'not_dispatched'
  | 'dispatch_outcome_unknown'
  | 'target_mismatch'
  | 'transport_cannot_read'
  | 'read_failed'
  | 'correlation_refused';

export interface IngestOutcome {
  taskId: string;
  issueNumber: number;
  repository: string;
  /** True when a report was found AND correlated by this call. */
  correlated: boolean;
  /** True when this exact report was already correlated by an earlier call. */
  alreadyCorrelated: boolean;
  /** The report's URL, only when it verifiably belongs to this issue. */
  reportUrl: string | null;
  /** Login the report was posted under, as GitHub reported it. Attested, not authenticated. */
  attestedAuthor: string | null;
}

export type IngestResult =
  | { ok: true; data: IngestOutcome }
  | { ok: false; error: { code: IngestRefusalCode; message: string } };

function refuse(code: IngestRefusalCode, message: string): IngestResult {
  return { ok: false, error: { code, message } };
}

/**
 * The report among these comments, or null.
 *
 * The LAST marked comment wins: a worker that posted a correction after its
 * first report meant the correction. Selection is by the provider's marker
 * alone — not by author login, which is attribution GitHub reports rather than
 * a fact HQ can verify, and not by position.
 */
export function findResultComment(comments: readonly GitHubIssueComment[]): GitHubIssueComment | null {
  // No marker means there is no way to tell a report from any other comment, so
  // nothing is a report. Fail closed rather than correlating on a guess.
  if (CLAUDE_RESULT_MARKER == null) return null;
  const marker = CLAUDE_RESULT_MARKER;
  let found: GitHubIssueComment | null = null;
  for (const comment of comments) {
    if (comment.body.includes(marker)) found = comment;
  }
  return found;
}

/**
 * Keep a URL only when it verifiably points at THIS issue.
 *
 * The same lesson as the reconciliation URL (issue #224, Codex P2 on `f9383dc`),
 * arriving from a less trusted direction: a comment URL is external text that
 * would become authoritative evidence. An unverifiable one is recorded as null
 * — the report still correlates, and nothing points somewhere it should not.
 */
function verifiedReportUrl(url: string, target: GitHubTarget, issueNumber: number): string | null {
  const parsed = parseIssueUrl(url, target);
  if (parsed == null || parsed.number !== issueNumber) return null;
  // A comment URL is the issue URL plus an anchor, so `startsWith` is the
  // relationship to check — and it must be an anchor, not another path segment.
  if (url === parsed.url) return url;
  const suffix = url.slice(parsed.url.length);
  return url.startsWith(parsed.url) && suffix.startsWith('#') ? url : null;
}

/** Has this exact report already been recorded for this task? */
function alreadyCorrelated(
  ops: HeadquarterOperations,
  taskId: string,
  issueNumber: number,
  reportUrl: string | null,
): boolean {
  return ops.queue.evidence
    .list(taskId)
    .some(
      (entry) =>
        entry.kind === CLAUDE_DISPATCH_EVIDENCE.correlated &&
        entry.payload['issueNumber'] === issueNumber &&
        (entry.payload['reportUrl'] ?? null) === reportUrl,
    );
}

export interface IngestOptions {
  taskId: string;
  /** The repository the caller believes the task was dispatched to. Verified. */
  target: GitHubTarget;
  transport: GitHubIssueTransport;
}

/**
 * Look for the Claude workflow's report on the issue HQ dispatched for this
 * task, and correlate it if it is there.
 *
 * "No report yet" is a SUCCESS with `correlated: false`, not an error: this is
 * meant to be run repeatedly while work is outstanding, and a poll that finds
 * nothing has not failed. Only a refusal to look — an undispatched task, a
 * repository that disagrees with the evidence, a transport that cannot read —
 * is an error.
 */
export function ingestClaudeResult(ops: HeadquarterOperations, options: IngestOptions): IngestResult {
  const { taskId } = options;
  if (!ops.queue.get(taskId)) return refuse('unknown_task', `No task ${taskId} exists.`);
  if (!isValidTarget(options.target)) {
    return refuse('target_mismatch', 'An ingestion target must be a valid owner/repo pair.');
  }

  const history = dispatchHistory(ops, taskId);
  if (history.state === 'unknown') {
    return refuse(
      'dispatch_outcome_unknown',
      `Task ${taskId} has an unresolved dispatch attempt. Reconcile it before reading a result: ` +
        'HQ does not know which issue — if any — carries this task.',
    );
  }
  if (history.state !== 'dispatched') {
    return refuse(
      'not_dispatched',
      `Task ${taskId} was never dispatched, so there is no issue to read a result from.`,
    );
  }

  // The RECORDED repository decides, not the caller's argument. Reading some
  // other repository's issue of the same number and attaching what it says to
  // this task is exactly the confusion the evidence log exists to prevent.
  const recorded = history.repository;
  if (!sameRepository(recorded, targetSlug(options.target))) {
    return refuse(
      'target_mismatch',
      `Task ${taskId} was dispatched to ${recorded}, not ${targetSlug(options.target)}. HQ reads ` +
        'the issue it actually opened.',
    );
  }
  const issueNumber = history.issueNumber;

  if (typeof options.transport.readIssue !== 'function') {
    return refuse(
      'transport_cannot_read',
      `The transport ${options.transport.id} cannot read issues, so no result can be observed. ` +
        'Nothing is inferred from the inability to look.',
    );
  }
  const read = options.transport.readIssue(options.target, issueNumber);
  if (!read.ok) {
    return refuse(
      'read_failed',
      `Could not read issue #${issueNumber} in ${recorded}: ${read.message}`,
    );
  }

  const report = findResultComment(read.issue.comments);
  const repository = targetSlug(options.target);
  if (report == null) {
    return {
      ok: true,
      data: {
        taskId,
        issueNumber,
        repository,
        correlated: false,
        alreadyCorrelated: false,
        reportUrl: null,
        attestedAuthor: null,
      },
    };
  }

  const reportUrl = verifiedReportUrl(report.url, options.target, issueNumber);
  const attestedAuthor = report.author.trim() === '' ? null : report.author;
  if (alreadyCorrelated(ops, taskId, issueNumber, reportUrl)) {
    return {
      ok: true,
      data: {
        taskId,
        issueNumber,
        repository,
        correlated: false,
        alreadyCorrelated: true,
        reportUrl,
        attestedAuthor,
      },
    };
  }

  const correlation = correlateClaudeResult(ops, {
    target: options.target,
    issueNumber,
    reportedProvider: DISPATCH_PROVIDER,
    issueBody: read.issue.body,
    reportUrl: reportUrl ?? undefined,
  });
  if (!correlation.ok) {
    return refuse(
      'correlation_refused',
      `A report was found on issue #${issueNumber} but was not attached: ${correlation.error.message}`,
    );
  }

  return {
    ok: true,
    data: {
      taskId: correlation.data.taskId,
      issueNumber,
      repository,
      correlated: true,
      alreadyCorrelated: false,
      reportUrl,
      attestedAuthor,
    },
  };
}
