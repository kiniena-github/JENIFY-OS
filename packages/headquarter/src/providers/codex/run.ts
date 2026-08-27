/**
 * Codex execution runner — the ONLY impure file in the lane.
 *
 * Guarantees enforced here rather than merely requested in a prompt:
 *
 *  1. READ-ONLY. The CLI is always spawned with `--sandbox read-only`, so a
 *     reviewer physically cannot edit the code it is reviewing.
 *  2. WORKTREE UNCHANGED. HEAD and `git status --porcelain` are captured before
 *     and after; any difference fails the review closed.
 *  3. EXACT SHA. The checkout is verified to be at the requested commit before
 *     Codex starts, and the runtime's own attested commit is verified after.
 *  4. NO SUBSTITUTION. If Codex is not connected, this returns a failure. It
 *     never calls another provider.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { providerConnectivity } from '../../routing/index.js';
import { extractEvidence, extractRuntimeError, isQuotaError, verifyReviewedSha } from './evidence.js';
import { probeCodex, type CodexProbeResult } from './probe.js';
import { CODEX_REVIEW_SCHEMA, buildReviewPrompt, parseReviewOutput } from './review.js';
import { EMPTY_EVIDENCE, type CodexReviewOutcome, type CodexReviewRequest } from './types.js';

export interface SpawnResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type SpawnImpl = (
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => SpawnResultLike;

export interface RunOptions {
  /** Milliseconds before the Codex run is abandoned. */
  timeoutMs?: number;
  /** Pre-computed probe (avoids probing twice). */
  probe?: CodexProbeResult;
  /** Where to keep the run's artefacts. Defaults to a temp directory. */
  workDir?: string;
  /** Model override; defaults to whatever the CLI is configured to use. */
  model?: string | null;
  /** Reasoning effort override. Defaults to 'medium' for the fast review lane. */
  reasoningEffort?: string | null;
  /**
   * Injection seam so the safety rules below can be tested exhaustively
   * without spending real Codex allowance. Production always uses spawnSync.
   */
  spawnImpl?: SpawnImpl;
  /** Injection seam for reading the session rollout that holds attestations. */
  readSessionRollout?: (sessionId: string | null) => string | null;
}

/**
 * Build the Codex CLI argument list.
 *
 * Exported and pure so the read-only guarantee is a TESTED property of the
 * command line, not a claim in a comment. `--sandbox read-only` is not
 * optional and there is no code path that omits it.
 */
export function buildCodexExecArgs(opts: {
  repoDir: string;
  schemaFile: string;
  lastMessageFile: string;
  prompt: string;
  model?: string | null;
  /**
   * Reasoning effort for this run. The Founder workstation's Codex config is
   * pinned to 'ultra', which is far too slow for a FAST reviewer lane, so the
   * lane sets its own value rather than inheriting the interactive default.
   */
  reasoningEffort?: string | null;
}): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--cd',
    opts.repoDir,
    '--output-schema',
    opts.schemaFile,
    '--output-last-message',
    opts.lastMessageFile,
    '--skip-git-repo-check',
  ];
  if (opts.model != null && opts.model.trim() !== '') args.push('--model', opts.model.trim());
  if (opts.reasoningEffort != null && opts.reasoningEffort.trim() !== '') {
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort.trim()}"`);
  }
  args.push(opts.prompt);
  return args;
}

const defaultSpawn: SpawnImpl = (command, args, timeoutMs, env) => {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: env ?? process.env,
    // stdin is closed: `codex exec` otherwise waits on it and would hang.
    input: '',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? undefined };
};

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true }).trim();
}

function safeGit(repoDir: string, args: string[]): string | null {
  try {
    return git(repoDir, args);
  } catch {
    return null;
  }
}

/** Snapshot of the worktree used to prove the reviewer changed nothing. */
interface WorktreeState {
  head: string | null;
  status: string | null;
}

function snapshotWorktree(repoDir: string): WorktreeState {
  return {
    head: safeGit(repoDir, ['rev-parse', 'HEAD']),
    status: safeGit(repoDir, ['status', '--porcelain']),
  };
}

function fail(
  request: CodexReviewRequest,
  kind: CodexReviewOutcome['failure'] extends null ? never : NonNullable<CodexReviewOutcome['failure']>['kind'],
  message: string,
  evidence = { ...EMPTY_EVIDENCE },
): CodexReviewOutcome {
  return {
    ok: false,
    request,
    actualProvider: null,
    evidence,
    review: null,
    failure: { kind, message },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Find the session rollout file the CLI just wrote, so its attested metadata
 * (model, CLI version, git commit) can be read back.
 */
function findSessionRollout(codexHome: string, sessionId: string | null): string | null {
  if (sessionId == null) return null;
  const roots = [join(codexHome, 'sessions')];
  const stack = [...roots];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir == null || !existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else if (entry.includes(sessionId)) return full;
    }
  }
  return null;
}

/**
 * Execute a genuine Codex review of one exact commit.
 *
 * Returns a failure outcome — never a substituted provider — when Codex is
 * unavailable or its result cannot be verified.
 */
export function runCodexReview(request: CodexReviewRequest, options: RunOptions = {}): CodexReviewOutcome {
  if (request.requestedProvider !== 'CODEX') {
    return fail(
      request,
      'provider_mismatch',
      `This runner executes CODEX only; it was handed a request for ${request.requestedProvider}. ` +
        'JENIFY never satisfies one provider request with a different provider.',
    );
  }

  // ---- 1. connectivity, from observed facts ------------------------------
  const probe = options.probe ?? probeCodex();
  const connectivity = providerConnectivity('CODEX', probe.facts);
  if (!connectivity.connected) {
    return fail(request, 'not_connected', `ROUTING BLOCKED — CODEX NOT CONNECTED. ${probe.reason}`);
  }
  const cliPath = probe.cliPath;
  if (cliPath == null) {
    return fail(request, 'not_connected', 'ROUTING BLOCKED — CODEX NOT CONNECTED. No Codex CLI path was resolved.');
  }

  // ---- 2. the checkout must already be at the requested commit -----------
  const before = snapshotWorktree(request.repoDir);
  if (before.head == null) {
    return fail(request, 'execution_failed', `${request.repoDir} is not a readable git checkout.`);
  }
  if (before.head.toLowerCase() !== request.targetSha.trim().toLowerCase()) {
    return fail(
      request,
      'sha_mismatch',
      `The checkout at ${request.repoDir} is at ${before.head}, but the review was requested for ` +
        `${request.targetSha}. Check out the exact commit before reviewing; JENIFY will not review ` +
        'one commit and report it as another.',
    );
  }

  // ---- 3. run Codex, read-only -------------------------------------------
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'jenify-codex-'));
  const schemaFile = join(workDir, 'review-schema.json');
  const lastMessageFile = join(workDir, 'review-last-message.txt');
  const eventsFile = join(workDir, 'review-events.jsonl');
  writeFileSync(schemaFile, JSON.stringify(CODEX_REVIEW_SCHEMA, null, 2), 'utf8');

  const args = buildCodexExecArgs({
    repoDir: request.repoDir,
    schemaFile,
    lastMessageFile,
    prompt: buildReviewPrompt(request),
    model: options.model,
    reasoningEffort: options.reasoningEffort ?? 'medium',
  });

  // The Codex agent shells out to its own bundled tools (ripgrep). The desktop
  // app puts those on PATH; a headless spawn has to do it explicitly or every
  // repo search inside the review fails.
  const sep = process.platform === 'win32' ? ';' : ':';
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...probe.helperPaths, process.env['PATH'] ?? ''].filter((p) => p !== '').join(sep),
  };

  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const result = spawnImpl(cliPath, args, options.timeoutMs ?? 15 * 60 * 1000, spawnEnv);

  const events = result.stdout ?? '';
  writeFileSync(eventsFile, events, 'utf8');

  // ---- 4. the reviewer must not have changed anything --------------------
  const after = snapshotWorktree(request.repoDir);
  if (after.head !== before.head || after.status !== before.status) {
    return fail(
      request,
      'worktree_mutated',
      'The worktree changed during the review. An independent reviewer must not modify the code it ' +
        `reviews, so the result is rejected. HEAD ${before.head} -> ${after.head}.`,
    );
  }

  if (result.error != null) {
    return fail(request, 'execution_failed', `Codex CLI failed to run: ${result.error.message}`);
  }

  // The runtime's own refusal outranks the exit code: it says WHY, and whether
  // retrying later is the right answer. It also outranks any review file left
  // on disk — a turn that failed did not produce a trustworthy verdict.
  const runtimeError = extractRuntimeError(events);
  if (runtimeError != null) {
    return isQuotaError(runtimeError)
      ? fail(
          request,
          'quota_exhausted',
          `Codex declined the request: ${runtimeError} Nothing is wrong with the reviewed code, ` +
            'and no other provider was substituted. Re-run the review once the allowance resets.',
        )
      : fail(request, 'provider_error', `Codex reported an error: ${runtimeError}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.startsWith('Reading additional input from stdin'))
      .slice(-15)
      .join('\n')
      .trim();
    return fail(request, 'execution_failed', `Codex CLI exited ${result.status}. ${stderr}`);
  }

  // ---- 5. provenance ------------------------------------------------------
  let evidence = extractEvidence({ execEvents: events });
  const readRollout =
    options.readSessionRollout ??
    ((sessionId: string | null): string | null => {
      const path = findSessionRollout(probe.codexHome ?? '', sessionId);
      if (path == null) return null;
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    });
  const rollout = readRollout(evidence.sessionId);
  if (rollout != null) {
    // keep the exec-only evidence as a floor; missing fields render as _unverified_
    evidence = extractEvidence({ execEvents: events, sessionRollout: rollout });
  }

  const shaCheck = verifyReviewedSha(request.targetSha, evidence);
  if (!shaCheck.ok) {
    return fail(request, shaCheck.kind, shaCheck.message, evidence);
  }

  // ---- 6. the review itself ----------------------------------------------
  const lastMessage = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, 'utf8') : '';
  const parsed = parseReviewOutput(lastMessage);
  if (!parsed.ok) {
    return fail(request, parsed.kind, parsed.message, evidence);
  }

  return {
    ok: true,
    request,
    // Asserted only now: a real Codex process ran, attested its own model and
    // commit, and returned a validated review.
    actualProvider: 'CODEX',
    evidence,
    review: parsed.review,
    failure: null,
    timestamp: new Date().toISOString(),
  };
}
