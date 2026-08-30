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
import { DispatchEvidenceGrant } from '../../application/service.js';
import type { SystemEvidenceKind, HeadquarterOperations } from '../../application/service.js';
import { classifyCapability } from '../../application/classification.js';
import { assertBrowserSafe } from '../../live/redaction.js';
import {
  HQ_DISPATCH_LABEL,
  HQ_DISPATCH_LABEL_DESCRIPTION,
  HQ_DISPATCH_MARKER,
  isRole,
  type ProviderId,
  type Role,
} from '../../routing/providers.js';
import {
  isValidTarget,
  parseIssueUrl,
  sameRepository,
  targetSlug,
  type GitHubIssueResult,
  type DispatchCapableTransport,
  type GitHubIssueTransport,
  type GitHubLabelResult,
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
  /** The designated executor worker is missing, inactive, misdeclared or refused. */
  | 'executor_not_claimable'
  | 'approval_invalid'
  | 'invalid_target'
  /** Already dispatched somewhere else than the target this call names. */
  | 'target_mismatch'
  | 'invalid_role'
  | 'transport_unavailable'
  | 'transport_unauthenticated'
  | 'transport_actor_mismatch'
  | 'transport_failed'
  /**
   * The durable HQ-dispatch label could not be made to exist, so a published
   * issue would carry only the erasable body marker (#224, Codex P1 on
   * `2dc86e8`).
   */
  | 'dispatch_label_unavailable'
  | 'dispatch_outcome_unknown'
  /**
   * The supplied dispatch-evidence capability is not a genuine grant issued by
   * this `HeadquarterOperations` (issue #219, ChatGPT blocking review of
   * `ef88711`). Checked before anything is claimed, started or published.
   */
  | 'evidence_grant_invalid'
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
  /**
   * True when this call moved the canonical task to `running` (issue #224).
   * Absent on a deduplicated receipt, which started nothing.
   *
   * It is only ever `true` or absent: the start happens INSIDE the reservation,
   * before the issue is published, so a start that refuses rolls the whole
   * reservation back and publishes nothing — there is no successful dispatch
   * whose task was left `assigned`.
   */
  executionStarted?: boolean;
}

export type DispatchResult =
  | { ok: true; data: DispatchReceipt }
  | { ok: false; error: { code: DispatchRefusalCode; message: string; details?: Record<string, unknown> } };

/**
 * The canonical `start` refused inside the dispatch reservation (issue #224).
 *
 * A sentinel rather than a returned value because it must ROLL THE RESERVATION
 * BACK: returning would commit the claim and `start`'s own rejection while
 * nothing was published, which is exactly the half-state the reservation
 * exists to prevent.
 */
class StartRefused extends Error {}

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
export const DISPATCH_MARKER = HQ_DISPATCH_MARKER;

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
    // Bracketed so the canonical block is found by DELIMITER, never by being
    // the first JSON fence in the body — the Founder's instruction sits above
    // it and may legitimately contain JSON of its own.
    CORRELATION_BLOCK_BEGIN,
    '```json',
    JSON.stringify(correlation, null, 2),
    '```',
    CORRELATION_BLOCK_END,
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
/**
 * Sentinels bracketing the canonical correlation block (issue #224, ChatGPT P2
 * on `07fd9fd`).
 *
 * The block used to be found as "the first ```json fence in the body" — but the
 * Founder's free-text instruction is rendered ABOVE it, and engineering
 * instructions routinely contain JSON examples. One such fence shadowed the
 * canonical block: the parser read the instruction's JSON, found no HQ marker,
 * and returned null, so the owner's genuine report was refused as
 * `malformed_correlation`. That fails closed rather than forging authority, but
 * it silently broke the whole feedback leg for an ordinary class of orders —
 * and the more careful the instruction, the more likely it was to break.
 *
 * The block is now delimited explicitly, so finding it never depends on what
 * else the body happens to contain.
 */
export const CORRELATION_BLOCK_BEGIN = `<!-- ${DISPATCH_MARKER}:begin -->`;
export const CORRELATION_BLOCK_END = `<!-- ${DISPATCH_MARKER}:end -->`;

/**
 * The region of the body that holds the canonical block.
 *
 * The LAST begin sentinel wins, and the end sentinel is sought after it: HQ
 * appends its block at the very bottom, so an instruction that contains
 * sentinel-looking text of its own cannot shadow the real one by appearing
 * first. Without sentinels at all — a body rendered by an older build — the
 * whole body is searched, and the marker check below still decides.
 */
function correlationRegion(body: string): string {
  const begin = body.lastIndexOf(CORRELATION_BLOCK_BEGIN);
  if (begin === -1) return body;
  const from = begin + CORRELATION_BLOCK_BEGIN.length;
  const end = body.indexOf(CORRELATION_BLOCK_END, from);
  return end === -1 ? body.slice(from) : body.slice(from, end);
}

export function parseDispatchCorrelation(body: string | null | undefined): DispatchCorrelation | null {
  if (typeof body !== 'string' || !body.includes(DISPATCH_MARKER)) return null;
  // EVERY json fence in the region, newest first — not just the first one in
  // the body. With sentinels the region holds exactly the canonical block;
  // without them this still finds it among an instruction's own examples, and
  // a fence that is not an HQ block is skipped rather than ending the search.
  const fences = [...correlationRegion(body).matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const candidate = readCorrelationRecord(fences[i]?.[1]);
    if (candidate != null) return candidate;
  }
  return null;
}

/** One fence's contents as a correlation record, or null if it is not one. */
function readCorrelationRecord(json: string | undefined): DispatchCorrelation | null {
  if (json == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
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
  // Identity, not spelling: GitHub repository names are case-insensitive and the
  // CLI accepts either, so a byte comparison would turn a genuine repeat into a
  // refusal (Codex P2 on `1d78038`).
  if (!sameRepository(history.repository, requestedSlug)) {
    return refuseWith(
      'target_mismatch',
      `Task ${taskId} was already dispatched to ${history.repository} (issue #${history.issueNumber}), ` +
        `but this call names ${requestedSlug}. Nothing was published: one canonical task has one ` +
        'dispatch, and an explicit publication target is never silently swapped for another.',
      { dispatchedTo: history.repository, requested: requestedSlug, issueNumber: history.issueNumber },
    );
  }
  const [recordedOwner, recordedRepo] = history.repository.split('/');
  return {
    ok: true,
    data: {
      taskId,
      provider: DISPATCH_PROVIDER,
      // The RECORDED target, so the receipt cannot disagree with the issue it
      // points at — including its spelling.
      target: { owner: recordedOwner ?? requested.owner, repo: recordedRepo ?? requested.repo },
      issueNumber: history.issueNumber,
      issueUrl: history.issueUrl,
      deduplicated: true,
      dispatchedAt: history.at,
    },
  };
}

/**
 * How long the claim taken at handoff is leased for.
 *
 * A GitHub-hosted AI task runs for far longer than the queue's 5-minute worker
 * default, and an expired lease on a side-effect task becomes `outcome_unknown`
 * — the canonical "we handed it out and never heard back" state. That is the
 * correct destination for an external execution nobody reported on, so the
 * lease is long enough not to fire spuriously and short enough that a silent
 * handoff does not sit claimed forever.
 */
export const DEFAULT_EXECUTION_LEASE_MS = 6 * 60 * 60_000;

/* ------------------------------------------------------------------ */
/* Executor readiness (read-only)                                      */
/* ------------------------------------------------------------------ */

export interface ExecutorReadiness {
  workerId: string;
  /** True when nothing here would refuse the claim. Not a promise it will succeed. */
  ready: boolean;
  registered: boolean;
  active: boolean;
  /** The provider this worker is DECLARED as, or null if it has no declaration. */
  declaredProvider: string | null;
  /** Whether the worker's allow-list contains the task's capability. */
  hasCapability: boolean;
  /** Why it would be refused, in the operator's words. Empty when ready. */
  problems: string[];
}

/**
 * Can the designated executor actually claim this task? (issue #224, ChatGPT P2
 * on `83e146b`.)
 *
 * `--check-only` is the first step of the approved local proof, and it used to
 * answer a question that had stopped being the whole question: it reported task
 * eligibility, dispatch history and transport state, and never looked at the
 * executor. So it could print ELIGIBLE for a dispatch that fails instantly
 * because the worker is missing, deactivated, lacks `hq.direct_order`, or was
 * never declared as CLAUDE — the exact gates the claim added.
 *
 * STRICTLY READ-ONLY, and that is the point: it takes no claim, consumes no
 * approval, mints no nonce, moves no status. It re-asks the same questions the
 * claim will ask, from the same sources, and reports them. A `ready: true` here
 * is therefore not a reservation and cannot be treated as one — the real gates
 * still run inside the dispatch transaction, where they are atomic.
 *
 * It deliberately does NOT re-implement the claim's logic. Each fact is read
 * from the module that owns it: the specialist directory for registration and
 * the capability allow-list, the declared-provider lookup for identity, and
 * `assertAssignable` for the handover freeze.
 */
export function executorReadiness(
  ops: HeadquarterOperations,
  workerId: string,
  capabilityId: string | null,
): ExecutorReadiness {
  const problems: string[] = [];
  const specialist = ops.directory.getSpecialist(workerId);
  const declaredProvider = ops.queue.providerOf(workerId);

  if (!specialist) {
    problems.push(
      `Worker ${workerId} is not registered. Registering it is an explicit Founder-gated ` +
        'configuration act; dispatch will not invent it.',
    );
  } else if (!specialist.active) {
    problems.push(`Worker ${workerId} is registered but INACTIVE, so it cannot be assigned work.`);
  }

  const hasCapability =
    specialist != null && capabilityId != null && specialist.allowedCapabilities.includes(capabilityId);
  if (specialist && capabilityId != null && !hasCapability) {
    problems.push(
      `Worker ${workerId} is not allowed the capability ${capabilityId}. Permissions live in the ` +
        'specialist record and the capability registry, never in the worker itself.',
    );
  } else if (capabilityId == null) {
    // "Not checked" must not read as "checked and false": there is no task to
    // take a capability from, so the allow-list question has not been asked.
    problems.push(
      'The task capability is unknown here, so the worker allow-list was NOT checked. That is an ' +
        'unanswered question, not a pass.',
    );
  }

  if (declaredProvider == null) {
    problems.push(
      `Worker ${workerId} has no declared provider, so it cannot claim a CLAUDE-bound task. ` +
        'Declaring it is a separate Founder-gated configuration act.',
    );
  } else if (declaredProvider !== DISPATCH_PROVIDER) {
    problems.push(
      `Worker ${workerId} is declared as ${declaredProvider}, not ${DISPATCH_PROVIDER}. Dispatch ` +
        'refuses rather than substituting a provider.',
    );
  }

  if (specialist) {
    const assignability = ops.queue.assignabilityProblem(workerId);
    if (assignability != null) problems.push(assignability);
  }

  return {
    workerId,
    ready: problems.length === 0,
    registered: specialist != null,
    active: specialist?.active ?? false,
    declaredProvider,
    hasCapability,
    problems,
  };
}

/**
 * Release the claim taken at handoff when nothing was published after all
 * (issue #224, Founder decision approving option 1).
 *
 * Claiming before publishing is what stops a second executor taking the task —
 * and it means a handoff that then fails cleanly would otherwise leave the task
 * `assigned` to a worker that is not running it, invisible to any later
 * dispatch. So a CLOSED, nothing-was-published outcome releases the claim
 * through the canonical `fail` boundary: the task returns to
 * `needs_approval`, which is where a task whose approval was consumed honestly
 * belongs.
 *
 * It deliberately does NOT return the task to `queued`. The claim consumed the
 * single-use approval, so re-dispatching genuinely does need a fresh Founder
 * decision — that is the honest cost of binding the external execution to an
 * approval, not an oversight. Nor does it fire for an UNCERTAIN outcome: there
 * the task stays claimed and its lease expires into `outcome_unknown`, the
 * canonical "handed out, never heard back" state.
 *
 * Best-effort by contract: the publication outcome is already recorded, and a
 * release that cannot be written must not turn a recorded outcome into an
 * unrecorded one. `OperatorQueue.releaseClaim` is atomic, so a failure here
 * leaves the claim wholly intact rather than half-removed.
 *
 * But best-effort is not SILENT (issue #224, ChatGPT P2 on `83e146b`). Swallowing
 * the error told the caller "nothing was published" while the task stayed
 * `assigned` to a worker that will never run it — true, and materially
 * incomplete. The outcome is returned so the refusal can say which of the two
 * states the task is actually in.
 */
type ClaimReleaseOutcome =
  | { kind: 'released' }
  /** Nothing to release: never claimed, or already moved on. */
  | { kind: 'not_held' }
  | { kind: 'failed'; message: string; claimedBy: string };

function releaseHandoffClaim(
  ops: HeadquarterOperations,
  taskId: string,
  reason: string,
): ClaimReleaseOutcome {
  let claimedBy = 'unknown';
  try {
    const task = ops.queue.get(taskId);
    if (!task || task.claimedBy == null) return { kind: 'not_held' };
    if (task.status !== 'assigned' && task.status !== 'running') return { kind: 'not_held' };
    claimedBy = task.claimedBy;
    ops.queue.releaseClaim(taskId, task.claimedBy, task.fence, reason);
    return { kind: 'released' };
  } catch (error) {
    return { kind: 'failed', message: errorText(error), claimedBy };
  }
}

/**
 * What to append to a refusal so the operator knows where the task was left.
 *
 * A release that failed is not a footnote: the task is still claimed, so the
 * next dispatch will refuse and the lease will eventually expire into
 * `outcome_unknown` unless somebody acts.
 */
function releaseNote(outcome: ClaimReleaseOutcome, taskId: string): string {
  if (outcome.kind !== 'failed') return '';
  return (
    ` WARNING: the canonical claim could NOT be released (${outcome.message}). Task ${taskId} is ` +
    `still claimed by ${outcome.claimedBy} and no dispatch will succeed until that is resolved; ` +
    'its lease will otherwise expire into `outcome_unknown`.'
  );
}

export interface DispatchOptions {
  taskId: string;
  /** Explicit repository. There is no default: dispatch publishes an instruction. */
  target: GitHubTarget;
  /** Must be able to guarantee the durable label exists before publishing. */
  transport: DispatchCapableTransport;
  /**
   * The registered worker the canonical claim is taken for (issue #224,
   * Founder decision approving option 1).
   *
   * REQUIRED, and never defaulted: dispatch must not mint, guess, impersonate
   * or silently assume a worker identity. Registering this worker and declaring
   * it as CLAUDE are explicit, Founder-gated configuration acts that happen
   * elsewhere; if it is missing, inactive, misdeclared or lacks the capability,
   * the dispatch fails closed and publishes nothing.
   */
  executorWorkerId: string;
  /** Lease for the claim taken at handoff. Defaults to DEFAULT_EXECUTION_LEASE_MS. */
  leaseMs?: number;
  /** Role tag put in the issue title. Defaults to BUILDER. */
  role?: Role;
  /** Labels to apply, if the repository defines them. Empty by default. */
  labels?: readonly string[];
  now?: () => Date;
  /**
   * The dispatch-only evidence capability (issue #219, Founder decision
   * approving Option B).
   *
   * REQUIRED, and deliberately not derivable from `ops`. Holding a
   * `HeadquarterOperations` no longer entitles a caller to write a dispatch
   * outcome, so this lane must be HANDED the power by whoever constructed the
   * service — the same composition-root handshake `OperatorQueue` uses for the
   * approval mutations. That is the whole mechanism: if it could be fetched off
   * `ops`, the caller forging a terminal `failed` could fetch it too.
   */
  evidence: DispatchEvidenceGrant;
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
  const recordBestEffort = (kind: SystemEvidenceKind, payload: Record<string, unknown>): void => {
    try {
      ops.appendSystemEvidence({ taskId, actor: DISPATCH_ACTOR, kind, payload });
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
  // FIRST, before any check that could claim, start or publish (issue #219,
  // ChatGPT blocking review of `ef88711`).
  //
  // `options.evidence` is caller-supplied, and a TypeScript interface is not a
  // runtime boundary: a counterfeit of the right shape used to be accepted,
  // silently discard the mandatory `attempted`/`succeeded` writes, and let this
  // function publish a real GitHub issue that `dispatchHistory` would then
  // report as never having happened. The whole guard rests on the writes being
  // real, so the writer is authenticated before the guard is relied on rather
  // than after.
  //
  // Deliberately placed above the target check too: order the refusals by what
  // they protect, not by how cheap they are.
  try {
    DispatchEvidenceGrant.assertIssuedBy(ops, options.evidence);
  } catch (error) {
    return refuseAndRecordBestEffort('evidence_grant_invalid', errorText(error));
  }
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

  // "Have I already done this?" is asked FIRST, before eligibility (issue #224,
  // Founder decision approving option 1).
  //
  // The order matters now and did not before. Since the handoff takes the
  // canonical claim, a dispatched task is `assigned` rather than `queued`, so
  // asking eligibility first would refuse a REPEAT with `task_not_eligible`
  // instead of answering it from evidence — turning the duplicate-dispatch
  // guard into a generic refusal and, worse, making a caller that retries on
  // refusal believe nothing had been published. Whether an issue already exists
  // is a fact about the world; whether the task may run is a question that only
  // arises if it does not.
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

  const eligibility = claudeDispatchEligibility(ops, taskId, now());
  if (!eligibility.eligible) {
    return refuseAndRecordBestEffort(eligibility.code, eligibility.message, eligibility.details);
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

  // ---- the durable identity must exist BEFORE the issue does --------------
  //
  // Issue #224, Codex P1 on `2dc86e8`. The single-use guard in `routing/route.ts`
  // used to recognise an HQ-dispatched issue by a marker in its BODY. The issue
  // is authored by the repository owner — the same account the guard binds — and
  // an author may edit their own body, so removing the marker turned the issue
  // back into an ordinary `[AI TASK]` one that a comment, a label event or a
  // manual dispatch could run again, with `jenify-run: GEMINI` substituting a
  // provider on a CLAUDE-bound task.
  //
  // The durable half of that identity is the `jenify-hq-dispatch` LABEL: applying
  // it writes an issue-timeline entry that no repository permission deletes, and
  // no body edit can touch. It is applied by `createIssue` below, which means the
  // label must already exist in the target repository — `gh` refuses a label it
  // cannot resolve.
  //
  // So it is ensured HERE, and a failure REFUSES: publishing an issue whose only
  // HQ identity is the erasable one would ship exactly the defect this fixes,
  // quietly. The position is deliberate — LAST of the checks and immediately
  // before the reservation, because ensuring a label is the first REPOSITORY
  // WRITE this function makes, and every refusal above it (ineligible task,
  // no session, wrong account, a credential in the rendered body) must cost no
  // write at all.
  //
  // `ensureLabel` is REQUIRED of a publishing transport — the type says so
  // (`DispatchCapableTransport`), so there is no absent case to reason about
  // here (issue #224, ChatGPT P1 on `72e4322`).
  //
  // It was optional, on the argument that a repository lacking the label would
  // make `createIssue` FAIL rather than publish unlabelled. That argument
  // assumed `gh` resolves labels before submitting the creation — the very
  // assumption `classifyExitFailure` refuses to make, because whether `gh`
  // validates a label before or after creating the issue is version-dependent.
  // If it applies them after, the "clean" failure had already published an
  // issue carrying only the erasable body marker, and the retry that failure
  // permitted published a second one.
  //
  // Both halves of that are now closed: the label is guaranteed to exist before
  // publication (here, by the type), and a label failure that reaches
  // `createIssue` anyway is classified outcome-UNKNOWN rather than a clean
  // rejection, so it never licenses a retry.
  let labelReady: GitHubLabelResult;
  try {
    labelReady = options.transport.ensureLabel(
      options.target,
      HQ_DISPATCH_LABEL,
      HQ_DISPATCH_LABEL_DESCRIPTION,
    );
  } catch (error) {
    // Safe to treat as a clean failure, unlike `createIssue`: creating a label
    // twice is harmless, so an ambiguous outcome here costs a retry rather
    // than a duplicate public artefact.
    return refuseAndRecordBestEffort(
      'dispatch_label_unavailable',
      `The GitHub transport threw while ensuring the \`${HQ_DISPATCH_LABEL}\` label exists ` +
        `(${errorText(error)}). Nothing was published.`,
      { transport: options.transport.id, label: HQ_DISPATCH_LABEL },
    );
  }
  if (!labelReady.ok) {
    return refuseAndRecordBestEffort(
      'dispatch_label_unavailable',
      `The \`${HQ_DISPATCH_LABEL}\` label could not be made to exist in ${targetSlug(options.target)} ` +
        `(${labelReady.message}). That label is the durable record that stops an HQ-dispatched issue ` +
        'being re-triggered once its body has been edited, so nothing was published.',
      { transport: options.transport.id, label: HQ_DISPATCH_LABEL },
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
  //
  // Eligibility is re-asked HERE as well, not only at the top (Codex P1 on
  // `1d78038`). The first check happens before `transport.status()`, which makes
  // a live call and may take up to a minute; in that window a time-boxed
  // approval can expire, the kill switch can be engaged, the capability can be
  // disabled, or another worker can claim the task. Publishing on the strength
  // of a minute-old answer would put out work that is no longer authorised. The
  // re-check runs inside the same transaction as the reservation, so nothing can
  // change between "still eligible" and "claimed".
  //
  // The CLAIM happens here too (issue #224, Founder decision approving option
  // 1). Publishing used to leave the task `queued` with its approval nonce
  // unconsumed, so a worker declared as CLAUDE could claim and execute the same
  // approved action while the workflow executed the published copy — bound to
  // no fence and no consumed approval. The handoff now takes the canonical
  // claim for the designated executor worker in the SAME transaction as the
  // reservation, so after publication the task is no longer independently
  // claimable, and the external execution is answerable to a real fence and a
  // consumed approval like any internal one.
  //
  // It goes through `HeadquarterOperations.claimNext`, not a table write: that
  // is the path carrying human-execution rejection, assignability, the
  // capability allow-list, the kill switch, assignment intent, provider binding
  // and approval consumption. Dispatch never mints, guesses or assumes a worker
  // identity — the caller names one, and registering it is a separate,
  // Founder-gated configuration act.
  type Reservation =
    | { kind: 'reserved'; claimed: OperatorTask }
    | { kind: 'history'; history: DispatchHistory }
    | { kind: 'claim_refused'; code: string; message: string }
    | { kind: 'ineligible'; verdict: Extract<EligibilityVerdict, { eligible: false }> };
  let reserved: Reservation;
  try {
    reserved = ops.reserveEvidence<Reservation>(() => {
      const current = dispatchHistory(ops, taskId);
      if (current.state !== 'none') return { kind: 'history', history: current };
      const recheck = claudeDispatchEligibility(ops, taskId, now());
      if (!recheck.eligible) return { kind: 'ineligible', verdict: recheck };
      // Claim THIS task — never "whatever is next", which would let a handoff
      // seize an unrelated order.
      let claimed;
      try {
        claimed = ops.claimNext(
          options.executorWorkerId,
          recheck.task.capabilityId,
          options.leaseMs ?? DEFAULT_EXECUTION_LEASE_MS,
          taskId,
        );
      } catch (error) {
        // A provider-binding violation or an approval replay throws. Fail
        // closed; the transaction rolls the whole reservation back.
        return { kind: 'claim_refused', code: 'threw', message: errorText(error) };
      }
      if (!claimed.ok) {
        return { kind: 'claim_refused', code: claimed.error.code, message: claimed.error.message };
      }
      // Paranoia, cheap: the narrowed claim must have taken the task we are
      // about to publish and nothing else.
      if (claimed.data.id !== taskId) {
        return {
          kind: 'claim_refused',
          code: 'wrong_task',
          message: `The claim took task ${claimed.data.id}, not ${taskId}.`,
        };
      }
      // START HERE, not after publication (issue #224). Publication is what
      // makes an execution real, so the canonical start/fence state has to be
      // secured BEFORE the issue exists, in the transaction that reserves it.
      //
      // Started afterwards, there is a window — the process dying between the
      // recorded publication and the start call — where the issue is live and
      // the task is still `assigned`. `sweepExpiredLeases` re-queues an expired
      // `assigned` task instead of sending it to `outcome_unknown`, and a
      // re-queued task is the first step of the chain the review named: the
      // refused claim runs `rejectAtExecutionBoundary`, which unlocks a fresh
      // approval and a second execution while the first may still be running.
      // Starting here removes the window rather than narrowing it: after this
      // transaction commits the task is `running`, so EVERY later ambiguity —
      // crash, lost outcome, expired lease — lands in `outcome_unknown`.
      //
      // It is also strictly more fail-closed. A start that refuses now refuses
      // BEFORE anything is published and rolls the whole reservation back,
      // including the rejection `start` itself records; afterwards it left a
      // live issue behind a task moved to `needs_approval`, which is the same
      // second-execution door.
      //
      // A clean publication failure below releases the claim exactly as before:
      // `running -> needs_approval` is an allowed transition, and the release
      // path is unchanged.
      try {
        ops.queue.start(taskId, options.executorWorkerId, claimed.data.fence);
      } catch (error) {
        // THROWN, not returned. Returning a refusal COMMITS this transaction,
        // which would leave the task claimed (and `start`'s own rejection
        // recorded) with nothing published — the half-state the reservation
        // exists to prevent. Throwing rolls all of it back; the outer catch
        // recognises this sentinel and answers with the same refusal a claim
        // failure gives, because from the caller's side it is the same fact:
        // the designated executor does not hold an executable claim on this
        // task, and nothing was published.
        throw new StartRefused(errorText(error));
      }
      options.evidence.appendDispatchOutcome({
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
          executorWorkerId: options.executorWorkerId,
          fence: claimed.data.fence,
        },
      });
      return { kind: 'reserved', claimed: claimed.data };
    });
  } catch (error) {
    if (error instanceof StartRefused) {
      return refuseAndRecordBestEffort(
        'executor_not_claimable',
        `The designated executor worker ${options.executorWorkerId} could not START task ${taskId} ` +
          `(${error.message}). Nothing was published, and the claim was rolled back with it. The ` +
          'handoff claims AND starts the canonical task before publishing, precisely so a live ' +
          'issue can never sit behind a task the lease sweep would return to the queue.',
        { executorWorkerId: options.executorWorkerId, reason: 'start_refused' },
      );
    }
    return refuseAndRecordBestEffort(
      'evidence_unavailable',
      'The dispatch attempt could not be recorded in the append-only evidence log ' +
        `(${errorText(error)}), so nothing was published. The evidence entry is what stops a ` +
        'second run from opening a duplicate issue; without it the guard does not exist.',
    );
  }
  // The designated executor could not take the canonical claim. Nothing was
  // published and the transaction rolled back, so the task is exactly as it
  // was: still queued, still approved, still nobody's.
  if (reserved.kind === 'claim_refused') {
    return refuseAndRecordBestEffort(
      'executor_not_claimable',
      `The designated executor worker ${options.executorWorkerId} could not claim task ${taskId} ` +
        `(${reserved.code}: ${reserved.message}). Nothing was published. The handoff takes the ` +
        'canonical claim before publishing precisely so an external execution is answerable to a ' +
        'fence and a consumed approval; without the claim there is nothing to publish into. ' +
        'Register and declare the executor worker as an explicit configuration act, or fix why ' +
        'it is not assignable.',
      { executorWorkerId: options.executorWorkerId, reason: reserved.code },
    );
  }
  // The task stopped being eligible while the transport was being checked.
  if (reserved.kind === 'ineligible') {
    return refuseAndRecordBestEffort(
      reserved.verdict.code,
      `${reserved.verdict.message} (Re-checked immediately before publication: the task was ` +
        'eligible when this dispatch started and is not any more, so nothing was published.)',
      reserved.verdict.details,
    );
  }
  // Another process won the race between the fast-path check and the
  // reservation, or resolved an attempt in between. Its answer is authoritative.
  if (reserved.kind === 'history' && reserved.history.state === 'dispatched') {
    return answerAlreadyDispatched(taskId, options.target, reserved.history, refuseAndRecordBestEffort);
  }
  if (reserved.kind === 'history' && reserved.history.state === 'unknown') {
    const at = reserved.history.at;
    return refuseAndRecordBestEffort(
      'dispatch_outcome_unknown',
      `A dispatch of task ${taskId} was attempted at ${at} and its outcome was never recorded, ` +
        'so HQ does not know whether a GitHub issue exists. Nothing was published.',
      { attemptedAt: at },
    );
  }
  if (reserved.kind !== 'reserved') {
    // Unreachable: `reserve` returns `history` only for a state the two checks
    // above both answer. Stated as a refusal rather than a cast, so a future
    // history state cannot silently fall through into publication.
    return refuseAndRecordBestEffort(
      'dispatch_outcome_unknown',
      `Task ${taskId}: the dispatch reservation returned a state this adapter does not handle. ` +
        'Nothing was published.',
    );
  }
  const claimedTask = reserved.claimed;

  // A transport that THROWS is an unknown outcome, not a clean failure.
  //
  // Found by sweeping for siblings of the three ambiguity findings rather than
  // by a review: `createIssue` is an injected interface, so it can throw at any
  // point — including after GitHub accepted the creation. Letting the exception
  // escape crashed the caller with a reservation already written, and a caller
  // that turns exceptions into a generic error (a host route, say) would have
  // reported something indistinguishable from "nothing happened". The attempt
  // stays OPEN, exactly as for `unreadable_response`, and the refusal says so.
  let created: GitHubIssueResult;
  try {
    created = options.transport.createIssue({
      target: options.target,
      title: issue.title,
      body: issue.body,
      // The durable HQ identity, ALWAYS, and never at the caller's discretion:
      // it is what `routing/route.ts` reads once the body has been edited. Any
      // caller-supplied labels are additional, and a duplicate is dropped rather
      // than passed to `gh` twice.
      labels: [HQ_DISPATCH_LABEL, ...(options.labels ?? []).filter((l) => l !== HQ_DISPATCH_LABEL)],
    });
  } catch (error) {
    return refuse(
      'transport_failed',
      `The GitHub transport threw while creating the issue (${errorText(error)}). Nothing proves ` +
        'the request never reached GitHub, so the outcome is UNKNOWN: the attempt is left OPEN ' +
        'and the next dispatch refuses until it is reconciled.',
      { kind: 'threw' },
    );
  }

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
      options.evidence.appendDispatchOutcome({
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
    const release = releaseHandoffClaim(
      ops,
      taskId,
      `The GitHub handoff was claimed but the issue was not created (${created.kind}). Nothing ` +
        'was published. The single-use approval was consumed by the claim, so re-dispatching ' +
        'needs a fresh Founder approval.',
    );
    return refuse(
      'transport_failed',
      `The GitHub transport did not create the issue. ${created.message}${releaseNote(release, taskId)}`,
      { kind: created.kind, claimReleased: release.kind },
    );
  }

  try {
    options.evidence.appendDispatchOutcome({
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

  // The execution is already `running` — started inside the reservation above,
  // before this issue existed, so there is no window in which a live issue sits
  // behind a task the lease sweep would re-queue. Reported on the receipt
  // because an operator reading it should see the canonical state, not infer it.
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
      executionStarted: true,
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
/**
 * Run one reconciliation's terminal write under the SAME serialization dispatch
 * uses (issue #224, Codex P1 on `172026f`).
 *
 * The defect this closes: the unknown-state check and the terminal append were
 * two separate steps, so two operators reconciling the same attempt could both
 * pass the check. A `not_dispatched` resolution then appended `failed`, which
 * licenses a fresh dispatch to reserve and publish a SECOND issue, while the
 * concurrent `found` resolution recorded the original issue as succeeded — one
 * task, two published issues, and contradictory terminal evidence in an
 * append-only log that cannot be edited to sort it out afterwards.
 *
 * `EvidenceLog.reserve` is the same IMMEDIATE write transaction the dispatch
 * reservation takes, so the second caller blocks at BEGIN and then sees the
 * state the first one left. Re-reading the history INSIDE the transaction is
 * what makes that matter: without it the second caller would still be acting on
 * the answer it read before waiting.
 *
 * Returns a refusal when this caller lost the race, or null when it won and the
 * write is committed.
 */
function claimReconciliation(
  ops: HeadquarterOperations,
  taskId: string,
  write: () => void,
): DispatchResult | null {
  return ops.reserveEvidence<DispatchResult | null>(() => {
    const current = dispatchHistory(ops, taskId);
    if (current.state !== 'unknown') {
      return refuse(
        'task_not_eligible',
        `Task ${taskId} has no unresolved dispatch attempt (${current.state}); there is nothing ` +
          'to reconcile. Another reconciliation resolved it first — exactly one may win, so this ' +
          'one wrote nothing rather than adding a second, contradictory terminal record.',
        { state: current.state },
      );
    }
    write();
    return null;
  });
}

export function resolveUnknownDispatch(
  ops: HeadquarterOperations,
  input: (
    | { taskId: string; outcome: 'found'; target: GitHubTarget; issueNumber: number; issueUrl: string; resolvedBy: string; note?: string }
    | { taskId: string; outcome: 'not_dispatched'; resolvedBy: string; note?: string }
  ) & {
    /**
     * The dispatch-only evidence capability (issue #219, Option B).
     *
     * Reconciliation is the ONE legitimate way to close an unresolved attempt
     * without holding a claim, which is exactly why the terminal kinds are no
     * longer on the generic surface: this function's authority check is the
     * gate, and it can only be the gate if there is no way around it. The two
     * requirements are independent and both hold — the grant says this code is
     * the dispatch lane, `reconciliationAuthorityRefusal` says a principal with
     * approval authority decided.
     */
    evidence: DispatchEvidenceGrant;
  },
): DispatchResult {
  // The capability is authenticated before anything else, for the same reason
  // it is in `dispatchClaudeTask`: a counterfeit could swallow the terminal
  // write and report a reconciliation that never reached the evidence log.
  try {
    DispatchEvidenceGrant.assertIssuedBy(ops, input.evidence);
  } catch (error) {
    return refuse('evidence_grant_invalid', errorText(error));
  }
  // Read-only pre-checks first. Nothing below writes until the reservation, so
  // a refusal here cannot leave a half-resolved attempt behind.
  const preview = dispatchHistory(ops, input.taskId);
  if (preview.state !== 'unknown') {
    return refuse(
      'task_not_eligible',
      `Task ${input.taskId} has no unresolved dispatch attempt (${preview.state}); there is nothing to reconcile.`,
      { state: preview.state },
    );
  }
  if (!input.resolvedBy?.trim()) {
    return refuse('task_not_eligible', 'A dispatch reconciliation must record who decided it.');
  }
  // AUTHENTICATE the decider, before anything is written (issue #219, ChatGPT
  // blocking finding on `173cd30`).
  //
  // `resolvedBy` used to be recorded verbatim and checked only for being
  // non-empty, so any string closed an `unknown` attempt. Closing one in the
  // `not_dispatched` direction returns `dispatchHistory` to `none` and makes a
  // later dispatch eligible as if nothing might already have been published —
  // the duplicate-publication path #221/#224 hardened against everywhere else.
  //
  // Deciding whether an irreversible external side effect happened is the same
  // class of judgement the Founder gate exists for, so it goes through the same
  // boundary `approveTask` uses. No new identity mechanism: `'system'` and
  // registered workers are refused, and the id must resolve to a principal
  // holding approval authority.
  const authorityRefusal = ops.reconciliationAuthorityRefusal(input.resolvedBy.trim());
  if (authorityRefusal) {
    return refuse('task_not_eligible', `Reconciliation refused: ${authorityRefusal}`, {
      resolvedBy: input.resolvedBy.trim(),
    });
  }
  if (input.outcome === 'not_dispatched') {
    const claimed = claimReconciliation(ops, input.taskId, () => {
      input.evidence.appendDispatchOutcome({
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
    });
    if (claimed) return claimed;
    // Nothing was published, and the attempt is now closed — so the claim the
    // handoff took must not keep the task assigned to a worker that never ran
    // it (issue #224, Founder decision approving option 1).
    const release = releaseHandoffClaim(
      ops,
      input.taskId,
      `Reconciled as NOT dispatched by ${input.resolvedBy}: no GitHub issue was created for the ` +
        'handoff, so the claim it took is released.',
    );
    return refuse(
      'transport_failed',
      `Task ${input.taskId}: the uncertain attempt was reconciled as NOT dispatched. Nothing was ` +
        `published${release.kind === 'failed' ? '' : ' and the handoff claim is released'}. The claim ` +
        'consumed the single-use approval, so a fresh dispatch needs a fresh Founder approval as ' +
        `well as a re-queue.${releaseNote(release, input.taskId)}`,
      { claimReleased: release.kind },
    );
  }
  if (!isValidTarget(input.target) || !Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    return refuse('invalid_target', 'Reconciling a found dispatch needs a valid owner/repo and issue number.');
  }
  // The URL has to AGREE with the target and number it is recorded beside
  // (issue #224, Codex P2 on `f9383dc`). It used to be taken verbatim while
  // only the separately-supplied pair was checked, so a reconciliation could
  // close an uncertain attempt with a URL pointing at another repository or
  // another issue entirely — and that URL becomes the authoritative
  // `succeeded` evidence, which every later deduplicated dispatch hands back as
  // its receipt. A wrong link there is not cosmetic: it is what an operator
  // opens to confirm the work, and what `answerAlreadyDispatched` returns
  // instead of publishing again.
  //
  // `parseIssueUrl` is the same target-scoped parser the transport uses on a
  // real creation, so the reconciliation path and the live path agree on what
  // counts as this repository's issue URL. Requiring the parsed number to equal
  // the supplied one closes the remaining gap: a URL for issue 7 recorded as
  // issue 9 would otherwise pass the parser.
  //
  // But the parser SEARCHES rather than anchors, because on the live path it
  // reads arbitrary `gh` stdout (issue #224, Codex P2 on `d8ef4ca`). So
  // `"https://github.com/o/r/issues/4242 trailing garbage"` parses fine, and
  // the first version of this check then persisted the caller's whole string —
  // closing the attempt while recording an invalid authoritative URL that every
  // deduplicated receipt would hand back. Two guards, because they answer
  // different halves:
  //
  //   - the trimmed input must EQUAL the URL that parsed, so a reconciliation
  //     carrying anything else refuses instead of being silently trimmed. This
  //     is a human typing the URL of an issue they just looked at; extra text
  //     means they pasted something other than what they think they did, and
  //     guessing which part they meant is exactly the leniency this lane
  //     refuses everywhere else.
  //   - and what is PERSISTED is `parsed.url`, never caller text, so nothing
  //     but a parser-validated string can ever reach the evidence log even if a
  //     future edit loosens the comparison above.
  const supplied = (input.issueUrl ?? '').trim();
  const parsed = parseIssueUrl(supplied, input.target);
  if (parsed == null || parsed.number !== input.issueNumber || supplied !== parsed.url) {
    return refuse(
      'invalid_target',
      `The issue URL does not match the reconciliation it is being recorded for. It must be ` +
        `exactly a github.com issue URL for ${targetSlug(input.target)} numbered ` +
        `${input.issueNumber}, with nothing else around it. Nothing was recorded: this URL would ` +
        'become the authoritative dispatch evidence and the receipt every later duplicate ' +
        'dispatch is answered with, so a mismatched or padded one is refused rather than stored.',
      { issueNumber: input.issueNumber, repository: targetSlug(input.target) },
    );
  }
  // From here on the PARSED url is the one recorded and returned.
  const issueUrl = parsed.url;
  const at = new Date().toISOString();
  const claimed = claimReconciliation(ops, input.taskId, () => {
    input.evidence.appendDispatchOutcome({
      taskId: input.taskId,
      actor: DISPATCH_ACTOR,
      kind: CLAUDE_DISPATCH_EVIDENCE.succeeded,
      payload: {
        provider: DISPATCH_PROVIDER,
        repository: targetSlug(input.target),
        transport: 'reconciled',
        issueNumber: input.issueNumber,
        issueUrl,
        resolvedBy: input.resolvedBy,
        dispatchedAt: at,
      },
    });
  });
  if (claimed) return claimed;
  return {
    ok: true,
    data: {
      taskId: input.taskId,
      provider: DISPATCH_PROVIDER,
      target: input.target,
      issueNumber: input.issueNumber,
      issueUrl,
      deduplicated: true,
      dispatchedAt: at,
    },
  };
}
