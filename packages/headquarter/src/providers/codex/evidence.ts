/**
 * Codex provenance extraction and verification (Founder mission Phase 3).
 *
 * The rule: we assert ONLY what the Codex runtime itself attested. The Codex
 * CLI writes a session rollout file whose `session_meta` records the CLI
 * version, model provider and the git commit of the tree it actually ran in,
 * and whose `turn_context` records the model that actually served the turn.
 * Those are the facts we quote. What we *asked* for is never promoted into
 * what *happened*.
 *
 * This module is pure: it parses text that run.ts collected.
 */

import { EMPTY_EVIDENCE, type CodexEvidence } from './types.js';

/** One parsed JSONL line, shape-agnostic. */
type Json = Record<string, unknown>;

function parseJsonl(text: string): Json[] {
  const out: Json[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v != null && typeof v === 'object') out.push(v as Json);
    } catch {
      // A malformed line is ignored rather than fatal: the CLI may interleave
      // diagnostics. Missing evidence simply stays null and is reported as
      // unverified, which is the safe direction.
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Extract attested provenance from the Codex session rollout file plus the
 * `codex exec --json` event stream.
 *
 * Both inputs are optional; whatever is missing stays null.
 */
export function extractEvidence(opts: { sessionRollout?: string; execEvents?: string }): CodexEvidence {
  const evidence: CodexEvidence = { ...EMPTY_EVIDENCE };

  for (const entry of parseJsonl(opts.sessionRollout ?? '')) {
    const type = str(entry['type']);
    const payload = (entry['payload'] ?? {}) as Json;

    if (type === 'session_meta') {
      evidence.sessionId ??= str(payload['session_id']) ?? str(payload['id']);
      evidence.cliVersion ??= str(payload['cli_version']);
      evidence.modelProvider ??= str(payload['model_provider']);
      evidence.cwd ??= str(payload['cwd']);
      const git = (payload['git'] ?? {}) as Json;
      evidence.attestedCommitSha ??= str(git['commit_hash']);
      evidence.attestedBranch ??= str(git['branch']);
      evidence.attestedRepoUrl ??= str(git['repository_url']);
    }

    // The runtime records the model that actually served the turn here. This
    // is the only honest source for "actual model".
    if (type === 'turn_context') {
      evidence.actualModel ??= str(payload['model']);
    }
  }

  for (const entry of parseJsonl(opts.execEvents ?? '')) {
    const type = str(entry['type']);
    if (type === 'thread.started') {
      evidence.sessionId ??= str(entry['thread_id']);
    }
    if (type === 'turn.completed') {
      const usage = entry['usage'];
      if (evidence.usage == null && usage != null && typeof usage === 'object') {
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(usage as Json)) {
          if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
        }
        if (Object.keys(clean).length > 0) evidence.usage = clean;
      }
    }
  }

  return evidence;
}

/**
 * Pull the provider's OWN error message out of the event stream.
 *
 * Codex reports a refusal — an exhausted subscription quota, a rate limit, a
 * server fault — as an `error` / `turn.failed` event while still exiting in a
 * way that looks like an ordinary non-zero exit. Surfacing the runtime's own
 * words matters: "you have hit your usage limit, try again at 11:25 PM" is an
 * actionable answer, while a truncated stderr tail is not.
 */
export function extractRuntimeError(execEvents: string | undefined): string | null {
  let found: string | null = null;
  for (const entry of parseJsonl(execEvents ?? '')) {
    const type = str(entry['type']);
    if (type === 'error') {
      found ??= str(entry['message']);
    }
    if (type === 'turn.failed') {
      const err = entry['error'];
      if (err != null && typeof err === 'object') {
        found ??= str((err as Json)['message']);
      }
    }
  }
  return found;
}

/** Does this runtime error describe an exhausted or throttled allowance? */
export function isQuotaError(message: string | null): boolean {
  if (message == null) return false;
  return /usage limit|rate limit|quota|too many requests|purchase more credits/i.test(message);
}

// ---------------------------------------------------------------------------
// Session binding — "the rollout we read must be the run we started"
// ---------------------------------------------------------------------------

/**
 * A Codex session id is a UUID. Requiring the full shape matters because the
 * session id is used to LOCATE the rollout file, and the rollout file is where
 * the attested commit and model come from. A short or oddly-shaped id — `a`,
 * `0`, `-`, a fragment of a path — would match far more than the intended file.
 *
 * The id arrives from the CLI's own event stream, which is runtime output: it
 * is evidence to be validated, not a trusted parameter.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlausibleSessionId(value: string | null | undefined): boolean {
  return typeof value === 'string' && SESSION_ID_RE.test(value.trim());
}

/**
 * Does this rollout FILENAME belong to this session?
 *
 * The id must appear as a whole delimited token, not as a substring. Codex
 * names rollouts `rollout-<timestamp>-<uuid>.jsonl`, so the id is always
 * bounded by `-`, `.`, `_` or the ends of the name. Plain `includes()` — what
 * this replaced — would bind session `…-abc` to a file for a DIFFERENT session
 * whose name merely contained those characters, and the caller would then read
 * that other run's attested commit and model as if they were this run's.
 */
export function sessionRolloutNameMatches(fileName: string, sessionId: string): boolean {
  if (!isPlausibleSessionId(sessionId)) return false;
  if (typeof fileName !== 'string' || fileName === '') return false;
  const id = sessionId.trim().toLowerCase();
  const name = fileName.toLowerCase();
  const at = name.indexOf(id);
  if (at < 0) return false;
  const boundary = (ch: string | undefined): boolean => ch === undefined || /[-._/\\]/.test(ch);
  return boundary(name[at - 1]) && boundary(name[at + id.length]);
}

/** Session id the rollout file itself declares in its `session_meta` record. */
export function extractRolloutSessionId(rollout: string | null | undefined): string | null {
  for (const entry of parseJsonl(rollout ?? '')) {
    if (str(entry['type']) !== 'session_meta') continue;
    const payload = (entry['payload'] ?? {}) as Json;
    const id = str(payload['session_id']) ?? str(payload['id']);
    if (id != null) return id;
  }
  return null;
}

export type SessionBinding =
  | { ok: true; sessionId: string }
  | { ok: false; message: string };

/**
 * Verify that a rollout file genuinely belongs to the session we executed.
 *
 * Finding a file by name is not proof of ownership — a name can collide, and a
 * runtime that emits a chosen `thread_id` picks which file we go looking for.
 * So the file's OWN declared session id must equal the one the run attested. A
 * rollout that declares nothing, or declares someone else, is refused rather
 * than mined for a commit SHA that would then be reported as this run's.
 */
export function verifyRolloutBinding(expectedSessionId: string | null, rollout: string | null): SessionBinding {
  if (!isPlausibleSessionId(expectedSessionId)) {
    return {
      ok: false,
      message:
        'The Codex runtime did not attest a well-formed session id, so no rollout file can be bound to ' +
        'this run. The result is rejected rather than attributed to an unidentified session.',
    };
  }
  const declared = extractRolloutSessionId(rollout);
  if (declared == null) {
    return {
      ok: false,
      message:
        'The session rollout file declares no session id of its own, so it cannot be proven to belong ' +
        'to this run. Its attestations are refused.',
    };
  }
  if (declared.trim().toLowerCase() !== String(expectedSessionId).trim().toLowerCase()) {
    return {
      ok: false,
      message:
        `The session rollout file declares session ${declared}, but this run attested session ` +
        `${expectedSessionId}. Refusing to read another session's attested commit and model as if they ` +
        'were this run\'s.',
    };
  }
  return { ok: true, sessionId: declared.trim() };
}

// ---------------------------------------------------------------------------
// SHA verification — "a review cannot silently target a stale SHA"
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function isPlausibleSha(value: string | null | undefined): boolean {
  return typeof value === 'string' && SHA_RE.test(value.trim());
}

/**
 * Do two SHAs identify the same commit?
 *
 * Abbreviated SHAs are accepted in EITHER direction, but only as a prefix of
 * at least 7 hex characters — the git minimum. Anything shorter, or a
 * non-prefix, is a mismatch. Comparison is case-insensitive.
 */
export function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!isPlausibleSha(a) || !isPlausibleSha(b)) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return longer.startsWith(shorter);
}

export type ShaVerification =
  | { ok: true; requested: string; attested: string }
  | { ok: false; kind: 'no_sha_attested' | 'sha_mismatch'; message: string; requested: string; attested: string | null };

/**
 * Verify the commit Codex actually ran against is the commit we asked it to
 * review. A missing attestation is a FAILURE, not a pass: an unproven target
 * is exactly the stale-review risk this guard exists to stop.
 */
export function verifyReviewedSha(requestedSha: string, evidence: CodexEvidence): ShaVerification {
  const attested = evidence.attestedCommitSha;
  const requested = String(requestedSha ?? '').trim();

  if (!isPlausibleSha(attested)) {
    return {
      ok: false,
      kind: 'no_sha_attested',
      requested,
      attested: attested ?? null,
      message:
        'The Codex runtime did not attest which commit it reviewed. The result is rejected rather ' +
        'than assumed to match the requested SHA.',
    };
  }
  const attestedSha = String(attested).trim();
  if (!shaMatches(requested, attestedSha)) {
    return {
      ok: false,
      kind: 'sha_mismatch',
      requested,
      attested: attestedSha,
      message:
        `Codex reviewed ${attestedSha} but the review was requested for ${requested}. ` +
        'The result is rejected: a review must never be attributed to a commit it did not read.',
    };
  }
  return { ok: true, requested, attested: attestedSha };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cell(v: string | null | undefined): string {
  return v == null || String(v).trim() === '' ? '_unverified_' : String(v);
}

export interface ProvenanceRenderInput {
  requestedProvider: string;
  actualProvider: string | null;
  role: string | null;
  issueNumber?: number | null;
  pullRequest?: number | null;
  requestedSha: string;
  evidence: CodexEvidence;
  status: string;
  timestamp: string;
  executor: string;
}

/**
 * The Founder-facing provenance table. Requested and actual are shown as
 * separate rows on purpose: if they ever disagree, it must be visible.
 */
export function renderCodexProvenance(input: ProvenanceRenderInput): string {
  const e = input.evidence;
  const rows: Array<[string, string]> = [
    ['Requested provider', input.requestedProvider],
    ['Actual provider', cell(input.actualProvider)],
    ['Actual model', cell(e.actualModel)],
    ['Model provider (attested)', cell(e.modelProvider)],
    ['Executor', input.executor],
    ['CLI version', cell(e.cliVersion)],
    ['Role', cell(input.role)],
    ['Issue', input.issueNumber == null ? '_none_' : `#${input.issueNumber}`],
    ['Pull request', input.pullRequest == null ? '_none_' : `#${input.pullRequest}`],
    ['Requested SHA', cell(input.requestedSha)],
    ['Attested SHA (reviewed)', cell(e.attestedCommitSha)],
    ['Attested branch', cell(e.attestedBranch)],
    ['Repository', cell(e.attestedRepoUrl)],
    ['Session id', cell(e.sessionId)],
    ['Status', input.status],
    ['Timestamp', input.timestamp],
  ];
  return ['| Field | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}
