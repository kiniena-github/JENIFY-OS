/**
 * Codex reviewer lane — contract types.
 *
 * Everything here is plain data so the whole lane can be tested without ever
 * spawning Codex. The impure part (spawning the CLI) lives in run.ts and is
 * the only file that touches the process table.
 */

import type { ProviderId, Role } from '../../routing/index.js';

// ---------------------------------------------------------------------------
// Review request
// ---------------------------------------------------------------------------

/** A review always targets ONE exact commit. There is no "latest" mode. */
export interface CodexReviewRequest {
  /** Provider the Founder/Headquarter ASKED for. Always recorded verbatim. */
  requestedProvider: ProviderId;
  /** Role this execution is performing. */
  role: Role;
  /** Absolute path of the checkout to review. */
  repoDir: string;
  /** Exact 40-char commit SHA under review. Never a branch name. */
  targetSha: string;
  /** Base ref the diff is computed against (e.g. 'origin/main'). */
  baseRef: string;
  /** GitHub PR number, when the review is of a PR. */
  pullRequest?: number | null;
  /** GitHub issue number, when the review was dispatched from a task issue. */
  issueNumber?: number | null;
  /** Extra reviewer instructions appended to the standard rubric. */
  extraInstructions?: string | null;
}

// ---------------------------------------------------------------------------
// Structured review result (Phase 4)
// ---------------------------------------------------------------------------

export type ReviewVerdict = 'PASS' | 'BLOCK';

export const FINDING_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = ['correctness', 'security', 'testing', 'performance', 'maintainability', 'other'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface ReviewFinding {
  severity: FindingSeverity;
  category: FindingCategory;
  /** One-line statement of the defect. */
  title: string;
  /** Repo-relative path, when the finding is anchored to a file. */
  file: string | null;
  /** 1-indexed line, when known. */
  line: number | null;
  /** Concrete evidence: the failing input/state and the wrong behaviour. */
  evidence: string;
}

export interface StructuredReview {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  testConcerns: string[];
  securityConcerns: string[];
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Provenance evidence (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Facts ATTESTED by the Codex runtime itself — never copied from what we
 * requested. Any field the runtime did not attest stays null, and a null field
 * is rendered as `_unverified_` rather than guessed.
 */
export interface CodexEvidence {
  /** 'openai' as reported in the session metadata. */
  modelProvider: string | null;
  /** e.g. 'gpt-5.6-sol', taken from the runtime's own turn context. */
  actualModel: string | null;
  /** Codex CLI version that executed. */
  cliVersion: string | null;
  /** Codex session/thread id — the execution identifier. */
  sessionId: string | null;
  /** Commit SHA the Codex runtime recorded for its own working tree. */
  attestedCommitSha: string | null;
  attestedBranch: string | null;
  attestedRepoUrl: string | null;
  /** Working directory the runtime recorded. */
  cwd: string | null;
  /** Token usage, when reported. */
  usage: Record<string, number> | null;
}

export const EMPTY_EVIDENCE: CodexEvidence = {
  modelProvider: null,
  actualModel: null,
  cliVersion: null,
  sessionId: null,
  attestedCommitSha: null,
  attestedBranch: null,
  attestedRepoUrl: null,
  cwd: null,
  usage: null,
};

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type CodexFailureKind =
  | 'not_connected'
  | 'sha_mismatch'
  | 'no_sha_attested'
  | 'provider_mismatch'
  | 'unparseable_result'
  | 'empty_result'
  | 'worktree_mutated'
  /** The provider itself refused: exhausted subscription quota, rate limit, server fault. */
  | 'provider_error'
  /** The provider's allowance is spent. A retry later may succeed; nothing is wrong with the code. */
  | 'quota_exhausted'
  | 'execution_failed';

export interface CodexReviewOutcome {
  /** True only when a genuine Codex execution produced a validated review. */
  ok: boolean;
  request: CodexReviewRequest;
  /** The provider that ACTUALLY executed, proven by evidence. Null if unproven. */
  actualProvider: ProviderId | null;
  evidence: CodexEvidence;
  review: StructuredReview | null;
  failure: { kind: CodexFailureKind; message: string } | null;
  /** ISO timestamp of when the outcome was finalised. */
  timestamp: string;
}
