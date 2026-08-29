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

/**
 * The ONE host this lane will publish to (issue #221, Codex P1 on `1d5b3bf`).
 *
 * `gh` resolves a hostless `--repo owner/repo` against `GH_HOST`, so on a
 * workstation configured for GitHub Enterprise the instruction would have been
 * published — irreversibly — to that host instead. Worse, the failure was
 * silent-ish: `parseIssueUrl` would reject the enterprise URL and leave the
 * attempt outcome-unknown, so HQ would know only that something had happened
 * somewhere. Every `gh` invocation here is therefore host-qualified, and the
 * authentication check asks about this same host, so the session that is
 * observed is the session that will be used.
 *
 * A deployment that genuinely wants an enterprise host would change this
 * constant deliberately, in review, alongside the workflow that reads the issue
 * — not inherit it from an environment variable.
 */
export const DISPATCH_HOST = 'github.com';

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

/**
 * `host/owner/repo` — what is actually handed to `gh`, so the host can never be
 * supplied by the environment. See `DISPATCH_HOST`.
 */
export function qualifiedTargetSlug(target: GitHubTarget): string {
  return `${DISPATCH_HOST}/${targetSlug(target)}`;
}

/**
 * Do two `owner/repo` slugs name the SAME repository (issue #221, Codex P2 on
 * `1d78038`)?
 *
 * GitHub repository identity is case-insensitive, and the CLI accepts either
 * spelling, so a byte comparison would read `owner/JENIFY-OS` and
 * `owner/jenify-os` as two different publication targets — turning a genuine
 * repeat of the same dispatch into a refusal. Identity is compared here;
 * DISPLAY always uses the recorded spelling.
 */
export function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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

/** One comment as GitHub reports it. All fields are UNTRUSTED external text. */
export interface GitHubIssueComment {
  /** Login of the comment's author, as reported. Attribution, not authentication. */
  author: string;
  body: string;
  url: string;
  createdAt: string;
}

export interface GitHubIssueView {
  issueNumber: number;
  body: string;
  comments: GitHubIssueComment[];
}

export type GitHubIssueReadResult =
  | { ok: true; issue: GitHubIssueView }
  | { ok: false; kind: IssueFailureKind; message: string };

/**
 * The capabilities HQ needs from GitHub to reach the Claude workflow, and to
 * observe what it reported back.
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
  /**
   * Read one issue and its comments (issue #224, ChatGPT P1 on `83e146b`).
   *
   * OPTIONAL, so every existing write-only stub and adapter stays valid and a
   * transport that cannot read fails closed at the ingestion path rather than
   * silently reporting "no result yet".
   *
   * Strictly a READ. It is how a result gets back to HQ at all: the workflow
   * reports by commenting on the issue HQ opened, and nothing was watching.
   */
  readIssue?(target: GitHubTarget, issueNumber: number): GitHubIssueReadResult;
  /**
   * Make sure a label EXISTS in the repository, so `createIssue` can apply it
   * (issue #224, Codex P1 on `2dc86e8`).
   *
   * The dispatched issue must carry `jenify-hq-dispatch`, because that label —
   * and the undeletable timeline entry applying it writes — is the durable half
   * of "HQ dispatched this issue". The body marker is the other half, and it is
   * erasable by the account the single-use boundary binds.
   *
   * OPTIONAL for the same reason `readIssue` is: every existing write-only stub
   * stays valid. A transport without it is not a hole — `createIssue` still
   * carries the label, so a repository that does not define it makes the
   * creation FAIL and nothing is published. Unlabelled publication is the one
   * outcome no path produces.
   *
   * Idempotent and non-destructive: it creates the label if absent and leaves an
   * existing one alone. It never renames, recolours or deletes.
   */
  ensureLabel?(target: GitHubTarget, label: string, description: string): GitHubLabelResult;
}

/**
 * The outcome of ensuring a label exists.
 *
 * `ok` covers both "created it" and "it was already there" — the caller only
 * needs to know that `createIssue` may now apply it. There is no
 * outcome-unknown case: creating a label twice is harmless, so an ambiguous
 * result can simply be retried, unlike publishing an issue.
 */
export type GitHubLabelResult =
  | { ok: true; created: boolean }
  | { ok: false; message: string };

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

/**
 * Signatures that PROVE the issue was never created (issue #221, Codex P1 on
 * `1d78038`).
 *
 * The previous rule was the wrong way round: anything that was not an auth
 * message was called `rejected`, which is a TERMINAL answer — dispatch records a
 * failure and a retry becomes legitimate. But an exit code cannot tell "GitHub
 * refused this request" from "GitHub accepted it and the connection died before
 * `gh` could print the URL". In the second case the issue exists, and a licensed
 * retry publishes a duplicate.
 *
 * So the burden of proof is inverted. A failure is retryable only when the text
 * shows the request was rejected or never submitted — an unresolvable
 * repository, a 4xx from the API, a missing session, a malformed invocation.
 * Everything else, a bare network error above all, is `unreadable_response`:
 * outcome unknown, attempt left open, reconciled by a human. The cost is an
 * occasional manual reconciliation; the cost of the other default is a duplicate
 * public issue nobody can withdraw.
 *
 * Deliberately NOT on this list: label errors. Whether `gh` validates a label
 * before or after creating the issue is a version-dependent implementation
 * detail, and an assumption that would be wrong in one direction only — the
 * expensive one.
 */
const PROVEN_NOT_SUBMITTED: readonly RegExp[] = [
  /could not resolve to (a|an) [a-z]+/i,
  /\bHTTP 4(00|01|03|04|10|22)\b/,
  /\bnot found\b/i,
  /unknown (flag|shorthand flag|command)/i,
  /accepts \d+ arg|requires at least/i,
];

const PROVEN_UNAUTHENTICATED: readonly RegExp[] = [
  /must be authenticated/i,
  /not logged in|gh auth login/i,
  /authentication (failed|token)/i,
  /bad credentials/i,
];

/**
 * Classify a non-zero `gh` exit that printed no issue URL. Exported so the
 * fail-closed default is a tested property rather than a claim.
 */
export function classifyExitFailure(
  status: number | null,
  detail: string,
): { kind: IssueFailureKind; message: string } {
  const prefix = `The GitHub CLI exited ${status}.`;
  if (PROVEN_UNAUTHENTICATED.some((pattern) => pattern.test(detail))) {
    return { kind: 'unauthenticated', message: `${prefix} ${detail}` };
  }
  if (PROVEN_NOT_SUBMITTED.some((pattern) => pattern.test(detail))) {
    return { kind: 'rejected', message: `${prefix} ${detail}` };
  }
  return {
    kind: 'unreadable_response',
    message:
      `${prefix} Nothing in that failure proves the request never reached GitHub — an issue may ` +
      `have been created before the command failed — so the outcome is UNKNOWN. ${detail}`,
  };
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
      // `--hostname` pins the question to the host we will actually publish to.
      // Without it, a workstation configured for an enterprise host answers
      // about THAT session, and the session observed is not the session used.
      const auth = spawn(ghPath, ['auth', 'status', '--hostname', DISPATCH_HOST], timeoutMs);
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
            `The GitHub CLI is installed but no authenticated ${DISPATCH_HOST} session was ` +
            'observed (`gh auth status` did not report a logged-in account for that host). Run ' +
            `\`gh auth login --hostname ${DISPATCH_HOST}\` on the Founder workstation; HQ will ` +
            'not dispatch without a session it can see.',
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
          `An authenticated GitHub CLI session was observed for account ${account} on ` +
          `${DISPATCH_HOST}. This is a live answer from GitHub about the session itself; no ` +
          'repository-level permission was checked, so no repository capability is claimed from it.',
      };
    },

    /**
     * Create the label if the repository does not already define it.
     *
     * `gh label create` exits non-zero with "already exists" when it does, which
     * is a SUCCESS for this caller: the postcondition is "the label exists", not
     * "I made it". `--force` is deliberately NOT used — it would overwrite an
     * existing label's colour and description, and this method has no business
     * editing repository configuration somebody else set up.
     *
     * Host-qualified for the same reason every other call here is: a bare
     * owner/repo resolves against `GH_HOST`, and creating the label on the wrong
     * host would leave the dispatch target still missing it.
     */
    ensureLabel(target: GitHubTarget, label: string, description: string): GitHubLabelResult {
      if (ghPath == null) {
        return { ok: false, message: 'No GitHub CLI (`gh`) is available here.' };
      }
      if (!isValidTarget(target)) {
        return { ok: false, message: 'The dispatch target is not a valid owner/repo pair.' };
      }
      if (typeof label !== 'string' || label.trim() === '') {
        return { ok: false, message: 'A label name is required.' };
      }
      const result = spawn(
        ghPath,
        [
          'label',
          'create',
          label,
          '--repo',
          qualifiedTargetSlug(target),
          '--description',
          description,
        ],
        timeoutMs,
      );
      if (result.error != null) {
        return { ok: false, message: `The GitHub CLI could not be run: ${result.error.message}` };
      }
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.status === 0) return { ok: true, created: true };
      if (/already exists/i.test(combined)) return { ok: true, created: false };
      const detail = combined.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-3).join(' ').trim();
      return {
        ok: false,
        message: `The GitHub CLI exited ${result.status} creating label "${label}". ${detail}`.trim(),
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
          // HOST-QUALIFIED: `gh` would otherwise resolve a bare owner/repo
          // against GH_HOST and publish to an enterprise host (Codex P1).
          '--repo',
          qualifiedTargetSlug(request.target),
          '--title',
          request.title,
          '--body-file',
          bodyFile,
        ];
        for (const label of request.labels ?? []) args.push('--label', label);
        const result = spawn(ghPath, args, timeoutMs);
        if (result.error != null) {
          // WHEN the failure happened decides what may be claimed (Codex P1).
          //
          // A spawn that never started the process created nothing, so it is
          // `unavailable` and a retry is legitimate. Anything else — a timeout
          // above all — killed a process that may already have created the
          // issue, and calling that "nothing happened" is what licenses a
          // duplicate. Those are `unreadable_response`: the outcome is UNKNOWN,
          // and the caller leaves the attempt unresolved rather than retrying.
          const code = (result.error as NodeJS.ErrnoException).code;
          const neverStarted = code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
          return neverStarted
            ? { ok: false, kind: 'unavailable', message: `The GitHub CLI could not be started: ${result.error.message}` }
            : {
                ok: false,
                kind: 'unreadable_response',
                message:
                  `The GitHub CLI was started and then failed (${code ?? result.error.name}: ` +
                  `${result.error.message}). It may have created the issue before it stopped, so ` +
                  'the outcome is UNKNOWN and is recorded as such rather than as a failure.',
              };
        }
        const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        const parsed = parseIssueUrl(combined, request.target);
        if (result.status !== 0) {
          const detail = combined.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-5).join(' ').trim();
          // A non-zero exit that nonetheless printed an issue URL for this
          // repository is not a clean "nothing happened": something was created
          // and then something else went wrong. Unknown, not failed.
          if (parsed != null) {
            return {
              ok: false,
              kind: 'unreadable_response',
              message:
                `The GitHub CLI exited ${result.status} but printed an issue URL for this ` +
                `repository (${parsed.url}). The outcome is UNKNOWN. ${detail}`,
            };
          }
          return { ok: false, ...classifyExitFailure(result.status, detail) };
        }
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

    /**
     * Read one issue and its comments — the return path (issue #224, ChatGPT P1
     * on `83e146b`).
     *
     * A READ, and only a read: `gh issue view` cannot create, comment, close or
     * label anything, and no argument here could make it. It is host-qualified
     * for the same reason the write is — a bare owner/repo would resolve against
     * `GH_HOST`, and reading the wrong host's issue would attach a stranger's
     * text to a canonical task.
     *
     * Failure classification is simpler than the write's, because there is no
     * side effect whose occurrence could be in doubt: a read either produced
     * usable JSON or it did not, and "did not" is never an outcome-unknown.
     */
    readIssue(target: GitHubTarget, issueNumber: number): GitHubIssueReadResult {
      if (ghPath == null) {
        return { ok: false, kind: 'unavailable', message: 'No GitHub CLI (`gh`) is available here.' };
      }
      if (!isValidTarget(target)) {
        return { ok: false, kind: 'rejected', message: 'The target is not a valid owner/repo pair.' };
      }
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        return { ok: false, kind: 'rejected', message: 'An issue number must be a positive integer.' };
      }
      const result = spawn(
        ghPath,
        [
          'issue',
          'view',
          String(issueNumber),
          '--repo',
          qualifiedTargetSlug(target),
          '--json',
          'number,body,comments',
        ],
        timeoutMs,
      );
      if (result.error != null) {
        return {
          ok: false,
          kind: 'unavailable',
          message: `The GitHub CLI could not be run: ${result.error.message}`,
        };
      }
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.status !== 0) {
        const detail = combined.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-5).join(' ').trim();
        return { ok: false, ...classifyExitFailure(result.status, detail) };
      }
      const view = parseIssueView(result.stdout ?? '', issueNumber);
      if (view == null) {
        return {
          ok: false,
          kind: 'unreadable_response',
          message:
            'The GitHub CLI exited cleanly but its output could not be read as an issue. Nothing ' +
            'is inferred from unreadable output.',
        };
      }
      return { ok: true, issue: view };
    },
  };
}

/**
 * Parse `gh issue view --json number,body,comments` output.
 *
 * Defensive by construction: every field is external text, so anything missing
 * or of the wrong type becomes an empty string rather than a thrown error or an
 * `undefined` that travels onward. A comment whose shape is unrecognisable is
 * dropped, not guessed at.
 */
export function parseIssueView(stdout: string, expectedNumber: number): GitHubIssueView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed == null) return null;
  const record = parsed as Record<string, unknown>;
  // The issue GitHub answered with must be the one that was asked for; a
  // mismatch means the read cannot be trusted to describe the dispatched issue.
  if (typeof record['number'] !== 'number' || record['number'] !== expectedNumber) return null;
  const rawComments = Array.isArray(record['comments']) ? record['comments'] : [];
  const comments: GitHubIssueComment[] = [];
  for (const entry of rawComments) {
    if (typeof entry !== 'object' || entry == null) continue;
    const comment = entry as Record<string, unknown>;
    const author = comment['author'];
    comments.push({
      author:
        typeof author === 'object' && author != null && typeof (author as Record<string, unknown>)['login'] === 'string'
          ? ((author as Record<string, unknown>)['login'] as string)
          : '',
      body: typeof comment['body'] === 'string' ? comment['body'] : '',
      url: typeof comment['url'] === 'string' ? comment['url'] : '',
      createdAt: typeof comment['createdAt'] === 'string' ? comment['createdAt'] : '',
    });
  }
  return {
    issueNumber: expectedNumber,
    body: typeof record['body'] === 'string' ? record['body'] : '',
    comments,
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
