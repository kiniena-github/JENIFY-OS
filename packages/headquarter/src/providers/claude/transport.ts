/**
 * GitHub transport boundary for the CLAUDE lane (issue #221, correction to #200).
 *
 * ## What this is, and what it deliberately is not
 *
 * CLAUDE's only real executor is `.github/workflows/ai-task-trigger.yml`, which
 * is woken by a GitHub ISSUE. So dispatching a canonical HQ order to Claude
 * means one thing: creating that issue. This module is the seam through which
 * that single write happens — nothing else. It is not a GitHub client, it is
 * not a second Claude executor, and it holds no credential of its own.
 *
 * `packages/headquarter/src/connectors/github.ts` is the READ side of GitHub and
 * is hard-wired to `scope: 'read'`. Nothing there may write, and nothing here
 * may read the archive: the two directions stay separate modules so that "HQ can
 * open an issue" never becomes a property of the ingestion adapter.
 *
 * ## Credentials: observed, never handled
 *
 * The Founder workstation already holds an authenticated GitHub session (the
 * `gh` CLI keychain, or an environment token the CLI picks up on its own). This
 * module reuses THAT session by spawning `gh`, and never reads, renders, logs,
 * copies or transmits a token value. What it reports is presence and identity —
 * a binary was found, a live `gh auth status` succeeded, the account is
 * `<login>` — which is the same fact-NAMES-only convention `routing/providers.ts`
 * and `live/connections.ts` already use.
 *
 * There is deliberately NO code path that accepts a token as an argument. If a
 * future transport needs one, it will be a different adapter and will have to
 * argue for itself.
 *
 * ## Fail closed
 *
 * Every unknown is an unavailable transport. No binary, an unreadable version,
 * an unauthenticated session, an unparseable issue URL: each returns a named
 * failure, and `dispatch.ts` turns that into a refusal that creates nothing
 * task-side. There is no branch in which a failed transport yields a receipt.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `owner/repo`, the only repository identity this module accepts. */
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A GitHub login. Used to compare the session's account against a repo owner. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GitHubTarget {
  owner: string;
  repo: string;
}

/** `owner/repo` for a validated target. Constructed, never taken verbatim. */
export function targetSlug(target: GitHubTarget): string {
  return `${target.owner}/${target.repo}`;
}

export function isValidTarget(target: GitHubTarget | null | undefined): boolean {
  if (target == null) return false;
  return (
    LOGIN_PATTERN.test(target.owner ?? '') && REPO_SLUG_PATTERN.test(`${target.owner}/${target.repo}`)
  );
}

/**
 * How far a transport got when asked about itself.
 *
 *   none   nothing was observed
 *   local  a local fact was observed (a binary exists) and nothing was asked of
 *          GitHub. This is configuration evidence, exactly as in
 *          `live/connections.ts`: it cannot tell a valid session from a revoked
 *          one, because it never asked.
 *   live   a real request reached GitHub and came back
 */
export type TransportCheckDepth = 'none' | 'local' | 'live';

export interface GitHubTransportStatus {
  /** True when a transport MECHANISM exists here. Not a claim about auth. */
  available: boolean;
  /** True only when a LIVE check confirmed an authenticated session. */
  authenticated: boolean;
  /** The login the live check reported, or null. Non-secret, never a token. */
  account: string | null;
  depth: TransportCheckDepth;
  /** Non-secret fact NAMES observed present. */
  observedFacts: string[];
  /** Non-secret fact NAMES observed absent. */
  missingFacts: string[];
  /** Plain-language explanation, safe to print and to publish. */
  reason: string;
}

export interface GitHubIssueRequest {
  target: GitHubTarget;
  title: string;
  body: string;
  /**
   * Labels to apply. The Claude workflow's `opened` trigger does not need one,
   * so this stays optional and empty by default — a label that does not exist
   * in the repository makes `gh` fail the whole creation.
   */
  labels?: readonly string[];
}

export type IssueFailureKind =
  | 'unavailable'
  | 'unauthenticated'
  | 'rejected'
  | 'unreadable_response';

export type GitHubIssueResult =
  | { ok: true; issueNumber: number; issueUrl: string }
  | { ok: false; kind: IssueFailureKind; message: string };

/**
 * The one capability HQ needs from GitHub to reach the Claude workflow.
 *
 * An interface, not a class, because `dispatch.ts` must be exhaustively testable
 * without a network, a `gh` install, or a real issue being opened. Production
 * passes `ghCliTransport()`; tests pass a recording stub.
 */
export interface GitHubIssueTransport {
  /** Stable non-secret id recorded in the evidence log (e.g. `gh-cli`). */
  readonly id: string;
  /** What is observably true about this transport right now. */
  status(): GitHubTransportStatus;
  /** Create ONE issue. Never retries on its own — retry is a caller's decision. */
  createIssue(request: GitHubIssueRequest): GitHubIssueResult;
}

/* ------------------------------------------------------------------ */
/* gh CLI adapter                                                      */
/* ------------------------------------------------------------------ */

export interface SpawnResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type SpawnImpl = (command: string, args: string[], timeoutMs: number) => SpawnResultLike;

const defaultSpawn: SpawnImpl = (command, args, timeoutMs) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    // stdin is closed: `gh` prompts interactively when it senses a TTY, and a
    // prompt in a dispatch path is a hang, not a question anyone can answer.
    input: '',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? undefined,
  };
};

/**
 * Two shapes `gh auth status` has used for the account line. Both are matched
 * so a CLI upgrade does not silently turn an authenticated Founder workstation
 * into "no account observed".
 */
const ACCOUNT_PATTERNS: readonly RegExp[] = [
  /account\s+([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/i,
  /logged in to [^\s]+ as ([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/i,
];

export function parseAuthAccount(output: string): string | null {
  for (const pattern of ACCOUNT_PATTERNS) {
    const match = pattern.exec(output);
    const login = match?.[1];
    if (login && LOGIN_PATTERN.test(login)) return login;
  }
  return null;
}

/**
 * Read the issue number out of what `gh issue create` prints.
 *
 * The URL is CONSTRUCTED-checked rather than trusted: it must be a github.com
 * issue URL for the repository we asked about, and the trailing segment must be
 * a positive integer. Anything else is `unreadable_response` — we would rather
 * report that the outcome is unknown than record a number we guessed, because
 * that number is what a later result comment correlates against.
 */
export function parseIssueUrl(output: string, target: GitHubTarget): { url: string; number: number } | null {
  const slug = targetSlug(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`https://github\\.com/${slug}/issues/(\\d+)`, 'i');
  const match = pattern.exec(output ?? '');
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { url: match[0], number };
}

export interface GhCliTransportOptions {
  /** Explicit path to the `gh` binary. Resolved from PATH when omitted. */
  ghPath?: string | null;
  /** Injection seam. Production uses spawnSync; tests supply their own. */
  spawnImpl?: SpawnImpl;
  /** Milliseconds before a `gh` invocation is abandoned. */
  timeoutMs?: number;
}

/** Resolve `gh` on PATH without shelling out to a shell. */
function resolveGh(explicit?: string | null): string | null {
  if (explicit != null && explicit.trim() !== '') return explicit.trim();
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(probe, ['gh'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '');
    return found ?? null;
  } catch {
    return null;
  }
}

/**
 * The production transport: the Founder workstation's own authenticated `gh`
 * session.
 *
 * Chosen over a raw HTTPS call with a token for one reason that matters here —
 * it means HQ never has to be given a credential at all. The session already
 * exists, `gh` owns it, and this adapter only asks it to do one thing.
 */
export function ghCliTransport(options: GhCliTransportOptions = {}): GitHubIssueTransport {
  const spawn = options.spawnImpl ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const ghPath = resolveGh(options.ghPath);

  const unavailable = (reason: string): GitHubTransportStatus => ({
    available: false,
    authenticated: false,
    account: null,
    depth: 'none',
    observedFacts: [],
    missingFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
    reason,
  });

  return {
    id: 'gh-cli',

    status(): GitHubTransportStatus {
      if (ghPath == null) {
        return unavailable(
          'No GitHub CLI (`gh`) was found on this machine, so HQ has no GitHub transport here. ' +
            'HQ holds no GitHub credential of its own and will not invent one: install the GitHub ' +
            'CLI and run `gh auth login` once on the Founder workstation.',
        );
      }
      const auth = spawn(ghPath, ['auth', 'status'], timeoutMs);
      if (auth.error != null) {
        return {
          ...unavailable(`The GitHub CLI at ${ghPath} could not be run: ${auth.error.message}`),
          observedFacts: ['GH_CLI_PATH'],
          missingFacts: ['GH_AUTH_ACCOUNT'],
        };
      }
      // `gh auth status` calls the API, so a non-zero exit here is a LIVE
      // answer: the session is missing, expired or revoked. That is a stronger
      // and more useful fact than "a binary exists", and it is reported as one.
      const output = `${auth.stdout ?? ''}\n${auth.stderr ?? ''}`;
      const account = parseAuthAccount(output);
      if (auth.status !== 0 || account == null) {
        return {
          available: true,
          authenticated: false,
          account: null,
          depth: 'live',
          observedFacts: ['GH_CLI_PATH'],
          missingFacts: ['GH_AUTH_ACCOUNT'],
          reason:
            'The GitHub CLI is installed but no authenticated GitHub session was observed ' +
            '(`gh auth status` did not report a logged-in account). Run `gh auth login` on the ' +
            'Founder workstation; HQ will not dispatch without a session it can see.',
        };
      }
      return {
        available: true,
        authenticated: true,
        account,
        depth: 'live',
        observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
        missingFacts: [],
        reason:
          `An authenticated GitHub CLI session was observed for account ${account}. This is a ` +
          'live answer from GitHub about the session itself; no repository-level permission was ' +
          'checked, so no repository capability is claimed from it.',
      };
    },

    createIssue(request: GitHubIssueRequest): GitHubIssueResult {
      if (ghPath == null) {
        return { ok: false, kind: 'unavailable', message: 'No GitHub CLI (`gh`) is available here.' };
      }
      if (!isValidTarget(request.target)) {
        return {
          ok: false,
          kind: 'rejected',
          message: 'The dispatch target is not a valid owner/repo pair; nothing was sent.',
        };
      }
      // The body goes through a file rather than an argument: it carries the
      // Founder's instruction, and command lines are length-bounded, shell-quoted
      // differently per platform, and visible in process listings.
      const workDir = mkdtempSync(join(tmpdir(), 'jenify-hq-dispatch-'));
      const bodyFile = join(workDir, 'issue-body.md');
      try {
        writeFileSync(bodyFile, request.body, 'utf8');
        const args = [
          'issue',
          'create',
          '--repo',
          targetSlug(request.target),
          '--title',
          request.title,
          '--body-file',
          bodyFile,
        ];
        for (const label of request.labels ?? []) args.push('--label', label);
        const result = spawn(ghPath, args, timeoutMs);
        if (result.error != null) {
          return { ok: false, kind: 'unavailable', message: `The GitHub CLI failed to run: ${result.error.message}` };
        }
        const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        if (result.status !== 0) {
          const detail = combined.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-5).join(' ').trim();
          const kind: IssueFailureKind = /auth|login|credential/i.test(detail) ? 'unauthenticated' : 'rejected';
          return { ok: false, kind, message: `The GitHub CLI exited ${result.status}. ${detail}` };
        }
        const parsed = parseIssueUrl(combined, request.target);
        if (parsed == null) {
          return {
            ok: false,
            kind: 'unreadable_response',
            message:
              'The GitHub CLI reported success but printed no issue URL for this repository, so ' +
              'HQ cannot say which issue (if any) was created. The outcome is UNKNOWN and is ' +
              'recorded as such rather than guessed.',
          };
        }
        return { ok: true, issueNumber: parsed.number, issueUrl: parsed.url };
      } finally {
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // A leftover temp file is not worth failing a dispatch over.
        }
      }
    },
  };
}

/**
 * A transport that exists but can do nothing — the honest default for any host
 * that has not been given one.
 *
 * Preferable to `null` at the call sites: a missing transport and an unusable
 * one then travel the same, single, tested refusal path instead of one of them
 * being a special case somebody forgets.
 */
export function unavailableTransport(reason: string): GitHubIssueTransport {
  return {
    id: 'none',
    status: () => ({
      available: false,
      authenticated: false,
      account: null,
      depth: 'none',
      observedFacts: [],
      missingFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
      reason,
    }),
    createIssue: () => ({ ok: false, kind: 'unavailable', message: reason }),
  };
}
