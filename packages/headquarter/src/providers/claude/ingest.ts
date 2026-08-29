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
 * - **It does not trust the MARKER either** (issue #224, ChatGPT P1 on
 *   `a2758f46`). The result marker is public, so it says only "this comment is
 *   shaped like a report". A report is accepted only from the repository owner
 *   — the rule `routing/route.ts` already applies to every comment carrying
 *   authority over an AI task, and the same account dispatch had to be
 *   authenticated as to publish. See `findResultComment`.
 * - **It does not substitute a provider.** The lane's provider is a constant
 *   here, so nothing is re-attributed: a report is correlated as CLAUDE's or
 *   not at all.
 * - **It reads one issue**, the one recorded for this task, in the repository
 *   recorded beside it. A caller naming a different repository is refused rather
 *   than followed.
 */

import type { HeadquarterOperations } from '../../application/service.js';
import { taskActionDigest } from '../../operator/approvals.js';
import { PROVIDER_REGISTRY } from '../../routing/providers.js';
import {
  CLAUDE_DISPATCH_EVIDENCE,
  DISPATCH_ACTOR,
  DISPATCH_PROVIDER,
  dispatchHistory,
  parseDispatchCorrelation,
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
  /** Login the report was posted under — verified to be the repository owner. */
  attestedAuthor: string | null;
  /**
   * Logins that posted a result-MARKED comment they are not entitled to post
   * (issue #224, ChatGPT P1 on `a2758f46`). Never correlated, never written to
   * the evidence log — but reported, because a stranger using the result marker
   * is something an operator should see rather than something silently dropped.
   */
  refusedAuthors: string[];
}

export type IngestResult =
  | { ok: true; data: IngestOutcome }
  | { ok: false; error: { code: IngestRefusalCode; message: string } };

function refuse(code: IngestRefusalCode, message: string): IngestResult {
  return { ok: false, error: { code, message } };
}

export interface ResultSelection {
  /** The trusted report, or null when none of the marked comments qualified. */
  report: GitHubIssueComment | null;
  /**
   * Marked comments REFUSED because their author is not the trusted origin.
   * Surfaced rather than dropped: someone posting a result marker they are not
   * entitled to post is worth an operator seeing, and silence would hide it.
   */
  refused: GitHubIssueComment[];
}

/**
 * The trusted report among these comments (issue #224, ChatGPT P1 on `a2758f46`).
 *
 * ## The defect this closes
 *
 * Selection used to be by the result MARKER alone, explicitly ignoring the
 * author — and the marker is public, documented, and sitting in plain text on
 * every dispatched issue. So anyone able to comment on that issue could paste
 * it and make HQ append canonical `claude_github_result_correlated` evidence
 * saying a CLAUDE report had arrived. Correlation neither reviews nor completes,
 * which bounds the damage, but false canonical provenance in an append-only log
 * is still an authority failure: it is exactly the record a human or a later
 * automation would trust.
 *
 * The reasoning that produced it was inverted. "A login is attribution GitHub
 * reports rather than something HQ can verify" is an argument for failing
 * CLOSED on origin, not for accepting every origin.
 *
 * ## The rule, and why this one
 *
 * The comment author must be the **repository owner**. That is not a new
 * identity or a new trust root — it is the rule this lane already runs on,
 * unit-tested in `routing/route.ts`: an AI task must be opened by the repository
 * owner, a bot may never trigger AI work, and *"only the repository owner may
 * re-trigger a task by comment."* A comment that carries authority over an AI
 * task has always had to come from the owner; a result comment is such a
 * comment, and was the one that had been exempted.
 *
 * It also matches the write side: dispatch refuses unless the authenticated
 * transport account owns the target repository. Same account, both directions.
 *
 * No second Claude identity is invented, no provider text from the body is
 * trusted, and the body is still never authority — the marker says "this is
 * shaped like a report", and the owner check says "this is from the party
 * entitled to file one". A bot login can never equal the owner's, so the
 * routing module's bot rule is satisfied by the same comparison.
 *
 * The LAST qualifying comment wins: a correction posted after a first report is
 * what its author meant.
 */
export function findResultComment(
  comments: readonly GitHubIssueComment[],
  trustedAuthor: string,
): ResultSelection {
  // No marker means there is no way to tell a report from any other comment, so
  // nothing is a report. Fail closed rather than correlating on a guess.
  if (CLAUDE_RESULT_MARKER == null) return { report: null, refused: [] };
  const marker = CLAUDE_RESULT_MARKER;
  // GitHub logins are case-insensitive, so the comparison is too — but it is
  // still an EXACT match, never a prefix or a contains.
  const trusted = trustedAuthor.trim().toLowerCase();
  let report: GitHubIssueComment | null = null;
  const refused: GitHubIssueComment[] = [];
  for (const comment of comments) {
    if (!comment.body.includes(marker)) continue;
    // An empty trusted author would otherwise match an empty/unknown author.
    if (trusted !== '' && comment.author.trim().toLowerCase() === trusted) report = comment;
    else refused.push(comment);
  }
  return { report, refused };
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

/* ------------------------------------------------------------------ */
/* The correlation write — private, and reachable only from below      */
/* ------------------------------------------------------------------ */

/**
 * Record that a report arrived, on the canonical task (issue #224, ChatGPT P1
 * on `7542f16`).
 *
 * ## Why this is not exported
 *
 * It used to be `correlateClaudeResult`, exported from `dispatch.ts` and
 * re-exported by the provider index — an evidence-WRITING function taking
 * caller-supplied `reportedProvider`, `issueBody`, `reportUrl` and
 * `attestedModel`. So the owner check added one round earlier lived in the
 * CALLER, and any other caller could skip it: application code could append
 * `claude_github_result_correlated` without a single owner-authored comment
 * ever having been observed. The provenance failure had not been closed, only
 * moved one layer inward, which is worse — it looks closed.
 *
 * The guard is now inseparable from the write: this function is module-private,
 * and the only exported path that reaches it is `ingestClaudeResult`, which
 * cannot get here without having READ the issue through a transport and found a
 * result comment authored by the repository owner. There is no `reportedProvider`
 * parameter to assert, because there is no caller left who could assert one —
 * the provider is this lane's constant.
 *
 * `attestedModel` is gone with it. It was caller-supplied text nothing could
 * verify, and ingestion has nothing truthful to put there; recording a field HQ
 * cannot stand behind is worse than not recording it.
 *
 * The issue body is REQUIRED rather than optional, closing the other quiet
 * bypass: an optional body meant a caller could simply omit it and skip every
 * correlation-block check below.
 */
type CorrelationRefusal =
  | 'unknown_dispatch'
  | 'malformed_correlation'
  | 'repository_mismatch'
  | 'correlation_drift';

function recordCorrelation(
  ops: HeadquarterOperations,
  input: {
    taskId: string;
    target: GitHubTarget;
    issueNumber: number;
    /** REQUIRED: the body carrying the anti-drift contract. */
    issueBody: string;
    reportUrl: string | null;
    /**
     * The login `findResultComment` verified to be the repository owner, three
     * lines from the only call site. Recorded so the evidence says WHO filed the
     * report and not merely that one arrived — which is what the operator doc
     * has always claimed this entry contains.
     */
    reportAuthor: string;
  },
): { ok: true } | { ok: false; code: CorrelationRefusal; message: string } {
  const repository = targetSlug(input.target);

  // The authority for "which task is this issue?" is what HQ itself wrote when
  // it dispatched — never a task id supplied by a caller or read from a body.
  const match = ops.queue.evidence
    .list()
    .find(
      (entry) =>
        entry.kind === CLAUDE_DISPATCH_EVIDENCE.succeeded &&
        entry.payload['issueNumber'] === input.issueNumber &&
        typeof entry.payload['repository'] === 'string' &&
        sameRepository(entry.payload['repository'] as string, repository),
    );
  if (!match?.taskId || match.taskId !== input.taskId) {
    return {
      ok: false,
      code: 'unknown_dispatch',
      message:
        `HQ has no record of dispatching issue #${input.issueNumber} in ${repository} for task ` +
        `${input.taskId}. An unrecognised issue is never attached to a task by guesswork.`,
    };
  }

  const task = ops.queue.get(input.taskId);
  if (!task) {
    return { ok: false, code: 'unknown_dispatch', message: `Task ${input.taskId} no longer exists.` };
  }

  const correlation = parseDispatchCorrelation(input.issueBody);
  if (correlation == null) {
    return {
      ok: false,
      code: 'malformed_correlation',
      message:
        'The issue body carries no readable HQ correlation block. The result is not attached: an ' +
        'unreadable correlation is an unknown, and unknowns fail closed.',
    };
  }
  if (correlation.hqTaskId !== task.id) {
    return {
      ok: false,
      code: 'malformed_correlation',
      message:
        `The issue body names HQ task ${correlation.hqTaskId}, but HQ dispatched this issue for ` +
        `task ${task.id}. Refusing to attach a result to a task the evidence disagrees about.`,
    };
  }
  if (correlation.repository != null && !sameRepository(correlation.repository, repository)) {
    return {
      ok: false,
      code: 'repository_mismatch',
      message: `The issue body names repository ${correlation.repository}, not ${repository}.`,
    };
  }

  // The ANTI-DRIFT contract, actually enforced (issue #224, ChatGPT P2 on
  // `7542f16`). These three fields are why the block carries more than a task
  // id, and they were parsed and then ignored — so an edited body could keep
  // the task id and repository while changing the approved digest, the bound
  // provider or the capability, and still correlate. A report is about ONE
  // approved action; a body that describes a different one is describing
  // different work, and attaching it would be the drift the block exists to
  // catch.
  //
  // Compared against the CANONICAL task as it stands now, not against the body:
  // if the action changed after dispatch, the current digest no longer matches
  // what was published, and refusing is right — the report may be about the
  // action that was approved, but HQ can no longer say the task still is.
  //
  // Absent fields fail closed. A block missing its anti-drift fields is not the
  // contract, and treating "not stated" as "not violated" is how a contract
  // becomes decorative.
  const drift: string[] = [];
  if (correlation.capabilityId !== task.capabilityId) {
    drift.push(
      `capability ${correlation.capabilityId ?? '(absent)'} ≠ ${task.capabilityId}`,
    );
  }
  if (correlation.executionProvider !== DISPATCH_PROVIDER) {
    drift.push(
      `execution provider ${correlation.executionProvider ?? '(absent)'} ≠ ${DISPATCH_PROVIDER}`,
    );
  }
  const digest = taskActionDigest(task);
  if (correlation.actionDigest !== digest) {
    drift.push(`approved action digest ${correlation.actionDigest ?? '(absent)'} ≠ ${digest}`);
  }
  if (drift.length > 0) {
    return {
      ok: false,
      code: 'correlation_drift',
      message:
        `The issue body's correlation block no longer describes this task's approved action: ` +
        `${drift.join('; ')}. The result is not attached.`,
    };
  }

  ops.queue.evidence.append({
    taskId: task.id,
    actor: DISPATCH_ACTOR,
    kind: CLAUDE_DISPATCH_EVIDENCE.correlated,
    payload: {
      provider: DISPATCH_PROVIDER,
      repository,
      issueNumber: input.issueNumber,
      reportUrl: input.reportUrl,
      // The VERIFIED origin. A public login, never a secret, and the one fact
      // that makes "arrived from the repository owner" checkable in the log
      // rather than only asserted by the note beside it.
      reportAuthor: input.reportAuthor.trim(),
      note:
        'Result correlated to the canonical task. This records that a report arrived from the ' +
        'repository owner; it does not review, pass or complete the task.',
    },
  });
  return { ok: true };
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

  // The trusted origin is the repository owner recorded for this dispatch —
  // the same account the transport had to be authenticated as to publish, and
  // the same party `routing/route.ts` already requires for any comment that
  // carries authority over an AI task.
  const { report, refused } = findResultComment(read.issue.comments, options.target.owner);
  const refusedAuthors = [...new Set(refused.map((c) => c.author.trim()).filter((a) => a !== ''))];
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
        refusedAuthors,
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
        refusedAuthors,
      },
    };
  }

  const correlation = recordCorrelation(ops, {
    taskId,
    target: options.target,
    issueNumber,
    issueBody: read.issue.body,
    reportUrl,
    reportAuthor: report.author,
  });
  if (!correlation.ok) {
    return refuse(
      'correlation_refused',
      `A report from the repository owner was found on issue #${issueNumber} but was not ` +
        `attached: ${correlation.message}`,
    );
  }

  return {
    ok: true,
    data: {
      taskId,
      issueNumber,
      repository,
      correlated: true,
      alreadyCorrelated: false,
      reportUrl,
      attestedAuthor,
      refusedAuthors,
    },
  };
}
