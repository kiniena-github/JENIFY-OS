/**
 * CLAUDE dispatch adapter — canonical HQ order → the existing Claude GitHub
 * workflow (issue #221, a correction to #200).
 *
 * ## The gap this closes
 *
 * A Founder direct order routed to CLAUDE became a canonical, Founder-gated,
 * evidenced task and then stopped. HQ had no transport from that task to
 * CLAUDE's only real executor, `.github/workflows/ai-task-trigger.yml`, which is
 * woken by a GitHub ISSUE and nothing else. So the order sat approved and unrun,
 * and the Connection Center honestly said `provider_not_connected`.
 *
 * Two wrong fixes were explicitly ruled out and are not implemented here:
 *
 *  - **Setting `CLAUDE_ROUTINE_URL`/`CLAUDE_ROUTINE_TOKEN` in the local HQ
 *    process.** Those names are what `routing/providers.ts` checks, so supplying
 *    them locally would flip CLAUDE to "connected" and make orders placeable —
 *    while changing nothing about whether the task could actually run. That is
 *    manufacturing the appearance of connectivity, which is the exact defect
 *    this repository keeps closing.
 *  - **A second Claude executor** (a local Claude CLI lane, or a parallel
 *    routine caller). #200 says the existing GitHub workflow is operational and
 *    must be reused; a second executor would be a second Claude identity, with
 *    its own provenance and its own gaps.
 *
 * What is implemented instead is the smallest thing that was actually missing: a
 * seam that takes an ALREADY-canonical, ALREADY-approved, CLAUDE-bound task and
 * emits the `[AI TASK][CLAUDE]` issue contract that workflow already understands.
 *
 * ## Order of authority
 *
 * Canonical first, transport last. Nothing here creates, classifies, approves or
 * re-routes a task; `live/orders.ts` and `HeadquarterOperations` did all of that
 * before this module is reachable at all. This module only asks:
 *
 *   1. does the task exist, and is its capability registered and enabled?
 *   2. is the kill switch clear for that capability?
 *   3. is the task BOUND to CLAUDE (`executionProvider`), and is CLAUDE what the
 *      caller asked to dispatch? A mismatch is refused, never substituted.
 *   4. is it eligible to execute RIGHT NOW — `queued`, and where the capability
 *      requires approval, carrying a Founder approval that is approved,
 *      unexpired, unconsumed and bound to the task's CURRENT action digest?
 *   5. has it already been dispatched (evidence log), or is a previous attempt
 *      still unresolved?
 *   6. only then: is there a transport, is it authenticated, and does its
 *      account match the repository owner the workflow will demand?
 *
 * Any "no" refuses and creates nothing — no issue, no task-side success, no
 * status change. A refusal is recorded in the append-only evidence log, so the
 * failure is visible rather than silent.
 *
 * ## Idempotency
 *
 * Dispatch is a side effect on somebody else's system, so "did I already do
 * this?" cannot be answered by hope. It is answered from the canonical
 * hash-chained evidence log: a prior `succeeded` entry for this task returns the
 * SAME issue instead of opening a second one, and a prior `attempted` with no
 * terminal entry is treated as OUTCOME UNKNOWN and refuses — never a blind
 * retry, exactly as `outcome_unknown` works for executions.
 *
 * ## Publication is not a side issue
 *
 * `live/orders.ts` keeps a Founder's instruction text off the browser snapshot
 * deliberately. Dispatching to a GitHub-hosted executor PUBLISHES that text to
 * the target repository, because that is what the executor reads. That is a real
 * consequence of choosing this transport and it is stated here rather than
 * buried: the target repository is always explicit (there is no default), the
 * rendered issue passes the same `assertBrowserSafe` guard the browser boundary
 * uses, and a body that trips it refuses instead of publishing.
 */

import {
  taskActionDigest,
  validateApproval,
  type ApprovalRejection,
} from '../../operator/approvals.js';
import { EXECUTION_PROVIDER_KEY, readProviderBinding } from '../../operator/provider-binding.js';
import type { OperatorTask } from '../../operator/queue.js';
import type { HeadquarterOperations } from '../../application/service.js';
import { classifyCapability } from '../../application/classification.js';
import { assertBrowserSafe } from '../../live/redaction.js';
import { isRole, type ProviderId, type Role } from '../../routing/providers.js';
import {
  isValidTarget,
  targetSlug,
  type GitHubIssueTransport,
  type GitHubTarget,
} from './transport.js';

/** The only provider this adapter will ever dispatch. */
export const DISPATCH_PROVIDER: ProviderId = 'CLAUDE';

/**
 * Evidence kinds this lane writes. Named constants because reads depend on them:
 * a typo in a string literal would silently defeat the duplicate-dispatch guard,
 * which is the one guard whose failure costs a duplicate public issue.
 */
export const CLAUDE_DISPATCH_EVIDENCE = {
  refused: 'claude_github_dispatch_refused',
  attempted: 'claude_github_dispatch_attempted',
  succeeded: 'claude_github_dispatch_succeeded',
  failed: 'claude_github_dispatch_failed',
  correlated: 'claude_github_result_correlated',
} as const;

/** Actor recorded on evidence written by this adapter. Never a human's name. */
export const DISPATCH_ACTOR = 'hq-claude-dispatch';

export type DispatchRefusalCode =
  | 'unknown_task'
  | 'unknown_capability'
  | 'capability_disabled'
  | 'kill_switch_engaged'
  | 'provider_not_bound'
  | 'provider_mismatch'
  | 'task_not_eligible'
  | 'approval_invalid'
  | 'invalid_target'
  /** Already dispatched somewhere else than the target this call names. */
  | 'target_mismatch'
  | 'invalid_role'
  | 'transport_unavailable'
  | 'transport_unauthenticated'
  | 'transport_actor_mismatch'
  | 'transport_failed'
  | 'dispatch_outcome_unknown'
  /** The guard itself could not be written, so nothing was published. */
  | 'evidence_unavailable'
  /** Something happened at GitHub that HQ could not record. Fail closed, loudly. */
  | 'dispatch_unrecorded'
  | 'unsafe_issue';

export interface DispatchReceipt {
  taskId: string;
  provider: ProviderId;
  target: GitHubTarget;
  issueNumber: number;
  issueUrl: string;
  /** True when this call matched an existing dispatch rather than making one. */
  deduplicated: boolean;
  dispatchedAt: string;
}

export type DispatchResult =
  | { ok: true; data: DispatchReceipt }
  | { ok: false; error: { code: DispatchRefusalCode; message: string; details?: Record<string, unknown> } };

/** Message text from an unknown throwable, bounded — it reaches a refusal reason. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function refuse(
  code: DispatchRefusalCode,
  message: string,
  details?: Record<string, unknown>,
): DispatchResult {
  return { ok: false, error: { code, message, details } };
}

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

export type EligibilityVerdict =
  | { eligible: true; task: OperatorTask; requiresApproval: boolean }
  | { eligible: false; code: DispatchRefusalCode; message: string; details?: Record<string, unknown> };

const APPROVAL_REJECTION_TEXT: Record<ApprovalRejection, string> = {
  approval_missing: 'no Founder approval is bound to it',
  approval_not_approved: 'its approval record is not an approval',
  approval_expired: 'its Founder approval has expired',
  approval_already_consumed: 'its single-use Founder approval has already been consumed',
  approval_digest_mismatch:
    'the action changed since it was approved, so the approval no longer binds this action',
  approval_claim_binding_mismatch: 'its approval is bound to a different claim',
};

/**
 * Is this task genuinely eligible to execute right now?
 *
 * Deliberately asked of the canonical state and of nothing else — no browser
 * input, no caller assertion, no payload field a submitter could set. The
 * approval half reuses `validateApproval` against the task's CURRENT digest, the
 * same function and the same row the execution boundary uses, so dispatch cannot
 * develop its own softer idea of "approved".
 *
 * Note what is NOT accepted: `needs_approval` (nothing has approved it),
 * `blocked` (a Founder denied it or it was stopped), `assigned`/`running` (a
 * worker already holds it), and every post-execution status. Dispatching any of
 * those would either publish work nobody authorised or duplicate work already in
 * flight.
 */
export function claudeDispatchEligibility(
  ops: HeadquarterOperations,
  taskId: string,
  now: Date = new Date(),
): EligibilityVerdict {
  const task = ops.queue.get(taskId);
  if (!task) {
    return { eligible: false, code: 'unknown_task', message: `Unknown task: ${taskId}` };
  }
  const capability = ops.queue.capabilities.get(task.capabilityId);
  if (!capability) {
    return {
      eligible: false,
      code: 'unknown_capability',
      message: `Task ${taskId} names capability ${task.capabilityId}, which is not registered here.`,
    };
  }
  if (!capability.enabled) {
    return {
      eligible: false,
      code: 'capability_disabled',
      message:
        `Capability ${capability.id} is disabled. Dispatch is an invocation: it will not re-enable ` +
        'a capability somebody switched off.',
    };
  }
  if (ops.queue.killSwitchEngaged(task.capabilityId)) {
    return {
      eligible: false,
      code: 'kill_switch_engaged',
      message: `The kill switch is engaged for ${task.capabilityId}; nothing is dispatched.`,
    };
  }

  const binding = readProviderBinding(task.payload);
  if (!binding.bound) {
    return {
      eligible: false,
      code: 'provider_not_bound',
      message:
        `Task ${taskId} declares no ${EXECUTION_PROVIDER_KEY}. This adapter dispatches CLAUDE-bound ` +
        'work only; an unbound task is not assumed to be Claude’s.',
    };
  }
  if (binding.provider !== DISPATCH_PROVIDER) {
    return {
      eligible: false,
      code: 'provider_mismatch',
      message:
        `Task ${taskId} is bound to provider ${binding.provider ?? '<malformed>'}, not ` +
        `${DISPATCH_PROVIDER}. JENIFY never satisfies one provider's work with another's transport.`,
      details: { requiredProvider: binding.provider, dispatchProvider: DISPATCH_PROVIDER },
    };
  }

  if (task.status !== 'queued') {
    return {
      eligible: false,
      code: 'task_not_eligible',
      message:
        `Task ${taskId} is ${task.status}, not queued for execution. Dispatch happens only for work ` +
        'the canonical control plane has already cleared to run.',
      details: { status: task.status },
    };
  }

  const classification = classifyCapability(capability, ops.policyContext);
  if (classification.requiresApproval) {
    const rejection = validateApproval(ops.queue.approvalFor(taskId), taskActionDigest(task), now);
    if (rejection) {
      return {
        eligible: false,
        code: 'approval_invalid',
        message:
          `Task ${taskId} requires a Founder approval and ${APPROVAL_REJECTION_TEXT[rejection]}. ` +
          'Nothing was dispatched.',
        details: { rejection },
      };
    }
  }
  return { eligible: true, task, requiresApproval: classification.requiresApproval };
}

/* ------------------------------------------------------------------ */
/* The issue contract                                                  */
/* ------------------------------------------------------------------ */

/**
 * Marker carried by every issue this adapter opens, and the anchor a later
 * result correlates against.
 *
 * Deliberately NOT `jenify-run` (which re-triggers a worker from a comment) and
 * deliberately NOT any provider's `jenify-*-result` marker (which must never
 * appear on something that could wake a worker).
 */
export const DISPATCH_MARKER = 'jenify-hq-dispatch';

/** Roles this adapter will put in a title. Anything else is refused, not guessed. */
export const DEFAULT_DISPATCH_ROLE: Role = 'BUILDER';

export const MAX_ISSUE_TITLE_LENGTH = 200;

/**
 * Make a task's label safe to sit inside an `[AI TASK]` title.
 *
 * `routing/route.ts` parses the bracket tags that FOLLOW the prefix, and any tag
 * it does not recognise blocks the whole task — correctly, since an instruction
 * it cannot read must never be guessed at. A Founder title of `[URGENT] ship it`
 * would therefore have produced `[AI TASK][CLAUDE][BUILDER] [URGENT] ship it`,
 * which parses `URGENT` as an unknown routing tag and fails closed at the far
 * end for a reason that has nothing to do with routing. Brackets become
 * parentheses so the label survives intact and the grammar stays unambiguous.
 */
export function sanitizeIssueTitleText(text: string): string {
  return text
    .replace(/[[]/g, '(')
    .replace(/[\]]/g, ')')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RenderedIssue {
  title: string;
  body: string;
}

export interface RenderIssueInput {
  task: OperatorTask;
  /** Console label from `TaskMeta`, if any. Never authority. */
  title: string | null;
  project: string | null;
  target: GitHubTarget;
  role: Role;
  dispatchedAt: string;
}

/** The instruction a direct-order payload carries, when it carries one. */
function payloadInstruction(payload: Record<string, unknown>): string | null {
  const value = payload['instruction'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Render the exact `[AI TASK][CLAUDE][ROLE]` contract
 * `.github/workflows/ai-task-trigger.yml` already understands.
 *
 * Pure, and exported, so the contract is a TESTED property rather than a claim:
 * the title parses to CLAUDE with no unknown tags, and the body carries a
 * machine-readable correlation block that maps the issue back to the canonical
 * task without which a result could only ever be attached by hand.
 */
export function renderDispatchIssue(input: RenderIssueInput): RenderedIssue {
  const label = sanitizeIssueTitleText(input.title ?? `HQ order ${input.task.id}`);
  const head = `[AI TASK][${DISPATCH_PROVIDER}][${input.role}] `;
  const title = `${head}${label}`.slice(0, MAX_ISSUE_TITLE_LENGTH).trim();

  const instruction = payloadInstruction(input.task.payload);
  const correlation = {
    marker: DISPATCH_MARKER,
    hqTaskId: input.task.id,
    capabilityId: input.task.capabilityId,
    idempotencyKey: input.task.idempotencyKey,
    actionDigest: taskActionDigest(input.task),
    executionProvider: DISPATCH_PROVIDER,
    role: input.role,
    repository: targetSlug(input.target),
    dispatchedAt: input.dispatchedAt,
  };

  const body = [
    `<!-- ${DISPATCH_MARKER}: ${input.task.id} -->`,
    '',
    '## Instruction',
    '',
    instruction ??
      '_This task carries no free-text instruction; work it from the canonical HQ task named below._',
    '',
    '## Canonical origin',
    '',
    'This issue was opened by the JENIFY HQ dispatch adapter for a Founder-approved canonical',
    'task. The HQ task is the source of truth: this issue is a transport to the existing Claude',
    'workflow, not a second place where work is defined or authorised.',
    '',
    `- HQ task: \`${input.task.id}\``,
    `- Capability: \`${input.task.capabilityId}\``,
    `- Project: ${input.project ? `\`${sanitizeIssueTitleText(input.project)}\`` : '_none_'}`,
    `- Bound execution provider: \`${DISPATCH_PROVIDER}\` (no substitution)`,
    `- Approved action digest: \`${correlation.actionDigest}\``,
    '',
    '## Reporting back',
    '',
    'Report on THIS issue, beginning the comment with the Claude result marker, and include the',
    'HQ task id above so the result reconciles to the canonical task. State the model actually',
    'executing; never claim another provider.',
    '',
    '```json',
    JSON.stringify(correlation, null, 2),
    '```',
  ].join('\n');

  return { title, body };
}

/** The correlation facts an issue body carries, once validated. */
export interface DispatchCorrelation {
  hqTaskId: string;
  capabilityId: string | null;
  actionDigest: string | null;
  executionProvider: string | null;
  repository: string | null;
}

/**
 * Read the correlation block back out of an issue body.
 *
 * Validating rather than trusting: the body is external text by the time it is
 * read back, so a missing marker, absent block, unparseable JSON or missing task
 * id yields null and the caller refuses. Guessing a task id from a body would be
 * how a foreign issue's result gets stapled onto somebody's canonical task.
 */
export function parseDispatchCorrelation(body: string | null | undefined): DispatchCorrelation | null {
  if (typeof body !== 'string' || !body.includes(DISPATCH_MARKER)) return null;
  const fence = /```json\s*([\s\S]*?)```/.exec(body);
  if (!fence?.[1]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record['marker'] !== DISPATCH_MARKER) return null;
  const hqTaskId = record['hqTaskId'];
  if (typeof hqTaskId !== 'string' || hqTaskId.trim() === '') return null;
  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };
  return {
    hqTaskId,
    capabilityId: str('capabilityId'),
    actionDigest: str('actionDigest'),
    executionProvider: str('executionProvider'),
    repository: str('repository'),
  };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/** What the evidence log already knows about dispatching this task. */
export type DispatchHistory =
  | { state: 'none' }
  | { state: 'dispatched'; issueNumber: number; issueUrl: string; repository: string; at: string }
  | { state: 'unknown'; at: string };

/**
 * Read the dispatch history for a task out of the canonical evidence log.
 *
 * The log is the right store for this and a new table would be the wrong one: it
 * is append-only and hash-chained, it is already the record every other decision
 * lands in, and it cannot be edited to make a second dispatch look like a first.
 *
 * `unknown` is the case that matters. An `attempted` entry with no `succeeded`
 * or `failed` after it means HQ asked GitHub to create an issue and never
 * learned the outcome — a crash, a timeout, an unreadable response. Re-sending
 * would risk a duplicate public issue, so it is refused until somebody resolves
 * it, the same rule `outcome_unknown` applies to executions.
 */
export function dispatchHistory(ops: HeadquarterOperations, taskId: string): DispatchHistory {
  let pendingAt: string | null = null;
  let dispatched: DispatchHistory | null = null;
  for (const entry of ops.queue.evidence.list(taskId)) {
    if (entry.kind === CLAUDE_DISPATCH_EVIDENCE.attempted) {
      pendingAt = entry.at;
      continue;
    }
    if (entry.kind === CLAUDE_DISPATCH_EVIDENCE.succeeded) {
      pendingAt = null;
      const issueNumber = entry.payload['issueNumber'];
      const issueUrl = entry.payload['issueUrl'];
      const repository = entry.payload['repository'];
      if (typeof issueNumber === 'number' && typeof issueUrl === 'string' && typeof repository === 'string') {
        dispatched = { state: 'dispatched', issueNumber, issueUrl, repository, at: entry.at };
      }
      continue;
    }
    if (entry.kind === CLAUDE_DISPATCH_EVIDENCE.failed) {
      // A recorded failure closes the attempt: nothing was created, so a later
      // dispatch is a first dispatch and not a retry of an unknown outcome.
      pendingAt = null;
    }
  }
  if (dispatched) return dispatched;
  if (pendingAt) return { state: 'unknown', at: pendingAt };
  return { state: 'none' };
}

/**
 * Answer a repeat dispatch from what was ALREADY dispatched (issue #221, Codex
 * P2 on `1d5b3bf`).
 *
 * The receipt must describe one publication, not two halves of different ones.
 * The first version returned the recorded issue while echoing back the CALLER's
 * target, so a task dispatched to repository A and re-dispatched at repository B
 * got a receipt naming B and pointing at A's issue — a contradiction, and a
 * silent refusal of an explicit publication target that never says so.
 *
 * A differing target is therefore refused rather than deduplicated. It is not a
 * repeat of the same order: nothing was published where the caller asked, and
 * choosing the repository is the guard on the irreversible act. Publishing to B
 * as well would be the other wrong answer — one canonical task, one dispatch —
 * so the refusal names both repositories and leaves the decision with a human.
 */
function answerAlreadyDispatched(
  taskId: string,
  requested: GitHubTarget,
  history: Extract<DispatchHistory, { state: 'dispatched' }>,
  refuseWith: (code: DispatchRefusalCode, message: string, details?: Record<string, unknown>) => DispatchResult,
): DispatchResult {
  const requestedSlug = targetSlug(requested);
  if (history.repository !== requestedSlug) {
    return refuseWith(
      'target_mismatch',
      `Task ${taskId} was already dispatched to ${history.repository} (issue #${history.issueNumber}), ` +
        `but this call names ${requestedSlug}. Nothing was published: one canonical task has one ` +
        'dispatch, and an explicit publication target is never silently swapped for another.',
      { dispatchedTo: history.repository, requested: requestedSlug, issueNumber: history.issueNumber },
    );
  }
  return {
    ok: true,
    data: {
      taskId,
      provider: DISPATCH_PROVIDER,
      // The RECORDED target, so the receipt cannot disagree with the issue it
      // points at.
      target: requested,
      issueNumber: history.issueNumber,
      issueUrl: history.issueUrl,
      deduplicated: true,
      dispatchedAt: history.at,
    },
  };
}

export interface DispatchOptions {
  taskId: string;
  /** Explicit repository. There is no default: dispatch publishes an instruction. */
  target: GitHubTarget;
  transport: GitHubIssueTransport;
  /** Role tag put in the issue title. Defaults to BUILDER. */
  role?: Role;
  /** Labels to apply, if the repository defines them. Empty by default. */
  labels?: readonly string[];
  now?: () => Date;
}

/**
 * Dispatch one canonical, approved, CLAUDE-bound task to the existing Claude
 * GitHub workflow.
 *
 * Returns a receipt only when a real issue exists. Every other path refuses,
 * records the refusal, and leaves the canonical task exactly as it was: this
 * function never transitions a task, never claims one, never approves one, and
 * never marks anything succeeded on the strength of having tried.
 */
export function dispatchClaudeTask(ops: HeadquarterOperations, options: DispatchOptions): DispatchResult {
  const now = options.now ?? (() => new Date());
  const taskId = options.taskId;

  // Best-effort ONLY for records whose loss cannot cost anything: a refusal
  // created nothing, so a refusal that goes unlogged is a lost diagnostic, not a
  // lost fact about the world. Everything that GUARDS the irreversible act — the
  // attempt reservation and the terminal outcome — is written through the
  // mandatory path below (issue #221, Codex P1 on `1d5b3bf`). The first version
  // of this swallowed every failure alike, so a busy or full database could let
  // a public issue exist while `dispatchHistory` still said `none` — and the
  // next run would publish a second one.
  const recordBestEffort = (kind: string, payload: Record<string, unknown>): void => {
    try {
      ops.queue.evidence.append({ taskId, actor: DISPATCH_ACTOR, kind, payload });
    } catch {
      // Deliberately swallowed. See above.
    }
  };
  const refuseAndRecordBestEffort = (
    code: DispatchRefusalCode,
    message: string,
    details?: Record<string, unknown>,
  ): DispatchResult => {
    recordBestEffort(CLAUDE_DISPATCH_EVIDENCE.refused, { code, message, ...(details ?? {}) });
    return refuse(code, message, details);
  };
  if (!isValidTarget(options.target)) {
    return refuseAndRecordBestEffort(
      'invalid_target',
      'A dispatch target must be an explicit owner/repo pair. There is no default target: ' +
        'dispatching publishes the order to a repository, so the repository is always chosen ' +
        'deliberately.',
    );
  }
  const role = options.role ?? DEFAULT_DISPATCH_ROLE;
  if (!isRole(role)) {
    return refuseAndRecordBestEffort('invalid_role', `Unknown role: ${String(role)}. Refusing to guess a role.`);
  }

  const eligibility = claudeDispatchEligibility(ops, taskId, now());
  if (!eligibility.eligible) {
    return refuseAndRecordBestEffort(eligibility.code, eligibility.message, eligibility.details);
  }

  // Already done, or already uncertain. Checked before the transport is touched:
  // a duplicate public issue is not undone by a later refusal.
  const history = dispatchHistory(ops, taskId);
  if (history.state === 'dispatched') {
    return answerAlreadyDispatched(taskId, options.target, history, refuseAndRecordBestEffort);
  }
  if (history.state === 'unknown') {
    return refuseAndRecordBestEffort(
      'dispatch_outcome_unknown',
      `A dispatch of task ${taskId} was attempted at ${history.at} and its outcome was never ` +
        'recorded, so HQ does not know whether a GitHub issue exists. Re-sending could open a ' +
        'duplicate. Resolve the attempt first (see resolveUnknownDispatch) — an uncertain ' +
        'outcome is never blindly retried.',
      { attemptedAt: history.at },
    );
  }

  const status = options.transport.status();
  if (!status.available) {
    return refuseAndRecordBestEffort('transport_unavailable', `NOT CONNECTED / SETUP REQUIRED. ${status.reason}`, {
      transport: options.transport.id,
      missingFacts: status.missingFacts,
    });
  }
  if (!status.authenticated || status.account == null) {
    return refuseAndRecordBestEffort(
      'transport_unauthenticated',
      `NOT CONNECTED / SETUP REQUIRED. ${status.reason}`,
      { transport: options.transport.id, missingFacts: status.missingFacts },
    );
  }
  // The workflow's own routing rule is that an `[AI TASK]` issue must have been
  // OPENED BY THE REPOSITORY OWNER; anything else is ignored outright. Opening
  // it as somebody else would therefore create a public issue that no worker
  // will ever run, while HQ recorded a successful dispatch — a task-side fake
  // success with a real artefact attached. Refuse instead.
  if (status.account.toLowerCase() !== options.target.owner.toLowerCase()) {
    return refuseAndRecordBestEffort(
      'transport_actor_mismatch',
      `The authenticated GitHub account (${status.account}) is not the owner of ` +
        `${targetSlug(options.target)}. The Claude workflow only routes AI tasks opened by the ` +
        'repository owner, so an issue opened by this account would be ignored rather than run.',
      { account: status.account, owner: options.target.owner },
    );
  }

  const meta = ops.readMeta(taskId);
  const dispatchedAt = now().toISOString();
  const issue = renderDispatchIssue({
    task: eligibility.task,
    title: meta?.title ?? null,
    project: meta?.project ?? null,
    target: options.target,
    role,
    dispatchedAt,
  });

  // The same boundary guard the browser snapshot uses, applied before anything
  // is published. An order already passed this at creation; it is re-applied
  // here because this render adds fields, and because publication to a
  // repository is a wider disclosure than the console ever was.
  try {
    assertBrowserSafe({ title: issue.title, body: issue.body }, 'dispatch_issue');
  } catch {
    return refuseAndRecordBestEffort(
      'unsafe_issue',
      'The rendered issue looks like it contains a credential. Nothing was published: a dispatch ' +
        'writes the order into a repository, where it cannot be unpublished.',
    );
  }

  // ---- the reservation: the last thing before the irreversible act ---------
  //
  // Read-then-append as ONE atomic step (issue #221, Codex P1 on `1d5b3bf`).
  // Two local dispatch processes could otherwise both read `none` above and both
  // publish. It happens here, after every check that can refuse, so a refused
  // dispatch never leaves an unresolved attempt behind blocking the next one.
  //
  // If the reservation cannot be WRITTEN, nothing is published. A guard that
  // could not be recorded is a guard that does not exist, and the cost of
  // stopping is a retry while the cost of continuing is a duplicate public
  // issue that cannot be withdrawn.
  let reserved: DispatchHistory;
  try {
    reserved = ops.queue.evidence.reserve<DispatchHistory>(() => {
      const current = dispatchHistory(ops, taskId);
      if (current.state !== 'none') return current;
      ops.queue.evidence.append({
        taskId,
        actor: DISPATCH_ACTOR,
        kind: CLAUDE_DISPATCH_EVIDENCE.attempted,
        payload: {
          provider: DISPATCH_PROVIDER,
          repository: targetSlug(options.target),
          transport: options.transport.id,
          account: status.account,
          role,
          dispatchedAt,
        },
      });
      return { state: 'none' };
    });
  } catch (error) {
    return refuseAndRecordBestEffort(
      'evidence_unavailable',
      'The dispatch attempt could not be recorded in the append-only evidence log ' +
        `(${errorText(error)}), so nothing was published. The evidence entry is what stops a ` +
        'second run from opening a duplicate issue; without it the guard does not exist.',
    );
  }
  // Another process won the race between the fast-path check and the
  // reservation, or resolved an attempt in between. Its answer is authoritative.
  if (reserved.state === 'dispatched') {
    return answerAlreadyDispatched(taskId, options.target, reserved, refuseAndRecordBestEffort);
  }
  if (reserved.state === 'unknown') {
    return refuseAndRecordBestEffort(
      'dispatch_outcome_unknown',
      `A dispatch of task ${taskId} was attempted at ${reserved.at} and its outcome was never ` +
        'recorded, so HQ does not know whether a GitHub issue exists. Nothing was published.',
      { attemptedAt: reserved.at },
    );
  }

  const created = options.transport.createIssue({
    target: options.target,
    title: issue.title,
    body: issue.body,
    labels: options.labels ?? [],
  });

  if (!created.ok) {
    // `unreadable_response` is deliberately NOT recorded as a failure. The
    // transport said it could not tell whether an issue exists; writing
    // "failed" would close the attempt and license a retry that duplicates a
    // public issue. Leaving the `attempted` entry unresolved is what makes the
    // next dispatch refuse with `dispatch_outcome_unknown` until somebody looks.
    if (created.kind === 'unreadable_response') {
      return refuse(
        'transport_failed',
        `The GitHub transport could not confirm the outcome. ${created.message} The attempt is ` +
          'left OPEN, so the next dispatch refuses until it is reconciled.',
        { kind: created.kind },
      );
    }
    try {
      ops.queue.evidence.append({
        taskId,
        actor: DISPATCH_ACTOR,
        kind: CLAUDE_DISPATCH_EVIDENCE.failed,
        payload: {
          provider: DISPATCH_PROVIDER,
          repository: targetSlug(options.target),
          transport: options.transport.id,
          kind: created.kind,
          message: created.message,
        },
      });
    } catch (error) {
      // The failure is real but unrecorded, so the attempt stays open and the
      // next dispatch refuses. Fail-closed, and said plainly rather than
      // reported as an ordinary retryable failure.
      return refuse(
        'dispatch_unrecorded',
        `The GitHub transport did not create the issue (${created.message}), and that outcome ` +
          `could not be recorded either (${errorText(error)}). The attempt is left OPEN and must ` +
          'be reconciled before another dispatch.',
        { kind: created.kind },
      );
    }
    return refuse('transport_failed', `The GitHub transport did not create the issue. ${created.message}`, {
      kind: created.kind,
    });
  }

  try {
    ops.queue.evidence.append({
      taskId,
      actor: DISPATCH_ACTOR,
      kind: CLAUDE_DISPATCH_EVIDENCE.succeeded,
      payload: {
        provider: DISPATCH_PROVIDER,
        repository: targetSlug(options.target),
        transport: options.transport.id,
        issueNumber: created.issueNumber,
        issueUrl: created.issueUrl,
        role,
        dispatchedAt,
      },
    });
  } catch (error) {
    // The worst case, and the one that must never be reported as success: the
    // issue EXISTS and HQ could not record it. Saying "dispatched" would leave a
    // receipt no evidence supports; saying "failed" would invite a duplicate.
    // The attempt stays open, so the next dispatch refuses, and the operator is
    // handed the URL they need to reconcile it.
    return refuse(
      'dispatch_unrecorded',
      `The issue WAS created (${created.issueUrl}) but the dispatch could not be recorded in the ` +
        `evidence log (${errorText(error)}). HQ is not claiming a successful dispatch it cannot ` +
        'evidence. Reconcile the open attempt with that issue before dispatching again.',
      { issueNumber: created.issueNumber, issueUrl: created.issueUrl },
    );
  }

  return {
    ok: true,
    data: {
      taskId,
      provider: DISPATCH_PROVIDER,
      target: options.target,
      issueNumber: created.issueNumber,
      issueUrl: created.issueUrl,
      deduplicated: false,
      dispatchedAt,
    },
  };
}

/**
 * Close out an attempt whose outcome HQ never learned.
 *
 * Deliberately an explicit human decision, mirroring `reconcile` on an
 * `outcome_unknown` execution: somebody looks at the repository, sees whether
 * the issue exists, and says so. `found` records the real issue (so the task is
 * correlated and a later dispatch deduplicates onto it); `not_dispatched`
 * records a failure (so a fresh dispatch is a first dispatch). There is no
 * "assume it worked" and no "assume it didn't".
 */
export function resolveUnknownDispatch(
  ops: HeadquarterOperations,
  input:
    | { taskId: string; outcome: 'found'; target: GitHubTarget; issueNumber: number; issueUrl: string; resolvedBy: string; note?: string }
    | { taskId: string; outcome: 'not_dispatched'; resolvedBy: string; note?: string },
): DispatchResult {
  const history = dispatchHistory(ops, input.taskId);
  if (history.state !== 'unknown') {
    return refuse(
      'task_not_eligible',
      `Task ${input.taskId} has no unresolved dispatch attempt (${history.state}); there is nothing to reconcile.`,
      { state: history.state },
    );
  }
  if (!input.resolvedBy?.trim()) {
    return refuse('task_not_eligible', 'A dispatch reconciliation must record who decided it.');
  }
  if (input.outcome === 'not_dispatched') {
    ops.queue.evidence.append({
      taskId: input.taskId,
      actor: DISPATCH_ACTOR,
      kind: CLAUDE_DISPATCH_EVIDENCE.failed,
      payload: {
        provider: DISPATCH_PROVIDER,
        kind: 'reconciled_not_dispatched',
        resolvedBy: input.resolvedBy,
        message: input.note ?? 'Reconciled: no issue was created for this attempt.',
      },
    });
    return refuse(
      'transport_failed',
      `Task ${input.taskId}: the uncertain attempt was reconciled as NOT dispatched. A fresh ` +
        'dispatch is now a first dispatch.',
    );
  }
  if (!isValidTarget(input.target) || !Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    return refuse('invalid_target', 'Reconciling a found dispatch needs a valid owner/repo and issue number.');
  }
  const at = new Date().toISOString();
  ops.queue.evidence.append({
    taskId: input.taskId,
    actor: DISPATCH_ACTOR,
    kind: CLAUDE_DISPATCH_EVIDENCE.succeeded,
    payload: {
      provider: DISPATCH_PROVIDER,
      repository: targetSlug(input.target),
      transport: 'reconciled',
      issueNumber: input.issueNumber,
      issueUrl: input.issueUrl,
      resolvedBy: input.resolvedBy,
      dispatchedAt: at,
    },
  });
  return {
    ok: true,
    data: {
      taskId: input.taskId,
      provider: DISPATCH_PROVIDER,
      target: input.target,
      issueNumber: input.issueNumber,
      issueUrl: input.issueUrl,
      deduplicated: true,
      dispatchedAt: at,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Result correlation                                                  */
/* ------------------------------------------------------------------ */

export type CorrelationRefusalCode =
  | 'unknown_dispatch'
  | 'provider_mismatch'
  | 'malformed_correlation'
  | 'repository_mismatch';

export interface CorrelationReceipt {
  taskId: string;
  issueNumber: number;
  repository: string;
  provider: ProviderId;
}

export type CorrelationResult =
  | { ok: true; data: CorrelationReceipt }
  | { ok: false; error: { code: CorrelationRefusalCode; message: string } };

export interface CorrelateResultInput {
  target: GitHubTarget;
  issueNumber: number;
  /** The provider that actually reported. Refused unless it is CLAUDE. */
  reportedProvider: string;
  /** Link to the reporting comment. Recorded verbatim as evidence. */
  reportUrl?: string | null;
  /** The issue body, when available, so the correlation block can be re-checked. */
  issueBody?: string | null;
  /** The worker's own model attestation, if it gave one. Never asserted by HQ. */
  attestedModel?: string | null;
}

/**
 * Reconcile a Claude result on a dispatched issue back to its canonical task.
 *
 * What it does: verifies that HQ really dispatched THIS issue in THIS
 * repository, that the reporting provider is the bound one, and that any
 * correlation block in the body still names the same task — then writes the
 * correlation into the append-only evidence log, where the canonical task
 * carries it.
 *
 * What it deliberately does not do: change the task's status, pass its review,
 * or complete it. A result arriving from outside is a REPORT, not an execution
 * record: the queue's independent-review rule exists precisely so the party that
 * did the work is not the party that declares it done, and a correlation helper
 * that transitioned tasks would be a way around it.
 */
export function correlateClaudeResult(
  ops: HeadquarterOperations,
  input: CorrelateResultInput,
): CorrelationResult {
  const repository = isValidTarget(input.target) ? targetSlug(input.target) : null;
  if (repository == null || !Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    return { ok: false, error: { code: 'malformed_correlation', message: 'A correlation needs a valid owner/repo and issue number.' } };
  }
  if (input.reportedProvider !== DISPATCH_PROVIDER) {
    return {
      ok: false,
      error: {
        code: 'provider_mismatch',
        message:
          `A result reported by ${input.reportedProvider} cannot be correlated to a ` +
          `${DISPATCH_PROVIDER}-bound dispatch. No provider substitution is recorded.`,
      },
    };
  }

  // Find the dispatch record for this exact issue. Scanning the whole log rather
  // than trusting a task id supplied by the caller: the authority for "which
  // task is this issue?" is what HQ itself wrote when it dispatched.
  const match = ops.queue.evidence
    .list()
    .find(
      (entry) =>
        entry.kind === CLAUDE_DISPATCH_EVIDENCE.succeeded &&
        entry.payload['issueNumber'] === input.issueNumber &&
        entry.payload['repository'] === repository,
    );
  if (!match?.taskId) {
    return {
      ok: false,
      error: {
        code: 'unknown_dispatch',
        message:
          `HQ has no record of dispatching issue #${input.issueNumber} in ${repository}, so there ` +
          'is no canonical task to correlate this result to. An unrecognised issue is never ' +
          'attached to a task by guesswork.',
      },
    };
  }

  if (input.issueBody != null) {
    const correlation = parseDispatchCorrelation(input.issueBody);
    if (correlation == null) {
      return {
        ok: false,
        error: {
          code: 'malformed_correlation',
          message:
            'The issue body carries no readable HQ correlation block. The result is not attached: ' +
            'an unreadable correlation is an unknown, and unknowns fail closed.',
        },
      };
    }
    if (correlation.hqTaskId !== match.taskId) {
      return {
        ok: false,
        error: {
          code: 'malformed_correlation',
          message:
            `The issue body names HQ task ${correlation.hqTaskId}, but HQ dispatched this issue ` +
            `for task ${match.taskId}. Refusing to attach a result to a task the evidence ` +
            'disagrees about.',
        },
      };
    }
    if (correlation.repository != null && correlation.repository !== repository) {
      return {
        ok: false,
        error: {
          code: 'repository_mismatch',
          message: `The issue body names repository ${correlation.repository}, not ${repository}.`,
        },
      };
    }
  }

  ops.queue.evidence.append({
    taskId: match.taskId,
    actor: DISPATCH_ACTOR,
    kind: CLAUDE_DISPATCH_EVIDENCE.correlated,
    payload: {
      provider: DISPATCH_PROVIDER,
      repository,
      issueNumber: input.issueNumber,
      reportUrl: input.reportUrl ?? null,
      // Recorded as an ATTESTATION, never as HQ's own claim about the model.
      attestedModel: input.attestedModel ?? null,
      note:
        'Result correlated to the canonical task. This records that a report arrived; it does ' +
        'not review, pass or complete the task.',
    },
  });

  return {
    ok: true,
    data: { taskId: match.taskId, issueNumber: input.issueNumber, repository, provider: DISPATCH_PROVIDER },
  };
}
