import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  PROVIDERS,
  PROVIDER_REGISTRY,
  blockedReportKeyFor,
  blockedReportOwnerFor,
  decideRouting,
  type RoutingRequest,
  type SecretsEnv,
} from '../src/routing/index.js';
import {
  extractRolloutSessionId,
  findSessionRollout,
  isPlausibleSessionId,
  runCodexReview,
  sessionRolloutNameMatches,
  verifyRolloutBinding,
  type CodexProbeResult,
  type CodexReviewRequest,
  type SpawnImpl,
} from '../src/providers/codex/index.js';

/**
 * Wave 2 hostile regressions — the independent-review blockers.
 *
 * Two defects were found by Jules against PR #153 (report PR #163) and one
 * against PR #164 (report PR #168). Each is pinned here by a test that FAILS on
 * the old behaviour, so the fix cannot silently regress:
 *
 *   1. fail-open title parsing on mixed known+unknown routing tags;
 *   2. blocked-report suppression in multi-provider workflows;
 *   3. Codex session rollout bound by filename SUBSTRING.
 */

const OWNER = 'kiniena-github';

/** What GitHub Actions genuinely observes: no local CLI facts exist there. */
const CI_SECRETS: SecretsEnv = {
  CLAUDE_ROUTINE_URL: 'https://example.invalid/fire',
  CLAUDE_ROUTINE_TOKEN: 'token',
  GEMINI_API_KEY: 'key',
};

/** Claude connected, Gemini's credential absent. */
const CLAUDE_ONLY: SecretsEnv = {
  CLAUDE_ROUTINE_URL: 'https://example.invalid/fire',
  CLAUDE_ROUTINE_TOKEN: 'token',
};

function req(over: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    trigger: 'issue_opened',
    issueTitle: '[AI TASK] Do a thing',
    actorLogin: OWNER,
    issueAuthorLogin: OWNER,
    repositoryOwner: OWNER,
    secrets: CI_SECRETS,
    // Ordinary issues, never dispatched by HQ. Stated explicitly because the
    // single-use guard fails CLOSED without it: an unestablished answer refuses
    // the re-trigger (issue #224). The refusal itself is asserted in
    // test/hq-dispatched-issue-retrigger.test.ts.
    hqDispatchEvidence: 'never_dispatched',
    ...over,
  };
}

// ===========================================================================
// Blocker 1 — a typo'd tag beside a real one must still fail closed
// ===========================================================================
describe('Jules #163 blocker 1: mixed known + unknown routing tags fail closed', () => {
  // The exact titles named in issue #174.
  it('[AI TASK][CLAUDE][CODEXX] fires NO worker', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEXX] do the thing' }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
    expect(d.reason).toContain('CODEXX');
  });

  it('[AI TASK][GEMINI][JULES-TYPO] fires NO worker', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][GEMINI][JULES-TYPO] do the thing' }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
    expect(d.reason).toContain('JULES-TYPO');
  });

  it('the recognised provider beside the typo is NOT dispatched', () => {
    // The regression in one line: CLAUDE was recognised, so the old guard was
    // skipped and Claude ran while the typo'd second provider was never
    // mentioned to anyone.
    const d = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEXX] x' }));
    expect(d.dispatchTo).not.toContain('CLAUDE');
    expect(d.requestedProviders).toEqual([]);
  });

  it('a typo beside BOTH fails closed rather than fanning out', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][BOTH][GEMNI] x' }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
  });

  it('a typo beside a ROLE fails closed and does not staff the role', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][REVIEWER][CODEXX] x' }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
    expect(d.staffedFromRole).toBe(false);
  });

  it('a comment directive cannot rescue a task whose title has an unknown tag', () => {
    const d = decideRouting(
      req({
        trigger: 'issue_comment',
        issueTitle: '[AI TASK][CLAUDE][CODEXX] x',
        commentBody: '<!-- jenify-run: CLAUDE -->',
      }),
    );
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
  });

  it('manual dispatch cannot force a typo’d title through either', () => {
    const d = decideRouting(req({ trigger: 'manual_dispatch', issueTitle: '[AI TASK][CLAUDE][CODEXX] x' }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
  });

  it('clean titles are unaffected — no new false blocking', () => {
    expect(decideRouting(req({ issueTitle: '[AI TASK] x' })).outcome).toBe('ROUTE');
    expect(decideRouting(req({ issueTitle: '[AI TASK][CLAUDE] x' })).outcome).toBe('ROUTE');
    expect(decideRouting(req({ issueTitle: '[AI TASK][GEMINI] x' })).outcome).toBe('ROUTE');
    expect(decideRouting(req({ issueTitle: '[AI TASK][BOTH] x' })).dispatchTo).toEqual(['CLAUDE', 'GEMINI']);
    expect(decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][REVIEWER] x' })).outcome).toBe('ROUTE');
  });

  it('brackets in the PROSE, after the routing region, are not routing tags', () => {
    // Only the contiguous tags after the prefix are routing. Otherwise every
    // issue title mentioning "[main]" would fail closed.
    const d = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE] fix the [routing] seam' }));
    expect(d.outcome).toBe('ROUTE');
    expect(d.dispatchTo).toEqual(['CLAUDE']);
  });
});

// ===========================================================================
// Blocker 2 — a blocked provider must be reported, once, even on a ROUTE
// ===========================================================================
describe('Jules #163 blocker 2: blocked reporting in multi-provider workflows', () => {
  it('a mixed request routes the connected provider AND still reports the blocked one', () => {
    // [CLAUDE][CODEX] in CI: Claude is live, Codex is local-cli so CI sees none
    // of its facts. Claude must do its own share; Codex must be reported.
    const d = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEX] x' }));
    expect(d.outcome).toBe('ROUTE');
    expect(d.dispatchTo).toEqual(['CLAUDE']);
    expect(d.blocked.map((b) => b.provider)).toEqual(['CODEX']);
    // THE REGRESSION: outcome is ROUTE, so an outcome-gated reporter posted
    // nothing and the blocked provider vanished silently.
    expect(d.blockedReportOwner).not.toBeNull();
  });

  it('no provider is substituted for the blocked one', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEX] x' }));
    expect(d.dispatchTo).not.toContain('CODEX');
    expect(d.dispatchTo).toEqual(['CLAUDE']);
  });

  it('exactly ONE provider owns the report, so two woken workflows cannot both post', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][BOTH][CODEX] x' }));
    const owners = PROVIDERS.filter((p) => d.blockedReportOwner === p);
    expect(owners).toHaveLength(1);
  });

  it('the owner is a provider that actually wakes for every AI task', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEX] x' }));
    const owner = d.blockedReportOwner!;
    expect(PROVIDER_REGISTRY[owner].observesAllAiTasks).toBe(true);
    expect(PROVIDER_REGISTRY[owner].executorKind).toBe('github-workflow');
  });

  it('a local-cli provider is never made the reporter — it observes nothing in CI', () => {
    for (const p of PROVIDERS) {
      if (PROVIDER_REGISTRY[p].executorKind === 'local-cli') {
        expect(PROVIDER_REGISTRY[p].observesAllAiTasks).toBe(false);
      }
    }
  });

  it('the owner reports even when its OWN credential is missing', () => {
    // Gemini blocked, Claude live: Claude reports. And with Claude's own
    // secrets absent the notice must STILL be owned by somebody — it is posted
    // with the repository token, not the provider's credential.
    const d = decideRouting(req({ issueTitle: '[AI TASK][BOTH] x', secrets: {} }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.blockedReportOwner).not.toBeNull();
  });

  it('a fully blocked task still reports, exactly as before', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CODEX] x' }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.blockedReportOwner).not.toBeNull();
    expect(d.blockedReportKey).toBe('CODEX');
  });

  it('nothing blocked means nothing to report', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE] x' }));
    expect(d.blocked).toEqual([]);
    expect(d.blockedReportOwner).toBeNull();
    expect(d.blockedReportKey).toBeNull();
  });

  it('the report key identifies the blocked SET, so a repeat is recognisable', () => {
    const a = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEX] x' }));
    const b = decideRouting(req({ issueTitle: '[AI TASK][CODEX][CLAUDE] x' }));
    expect(a.blockedReportKey).toBe(b.blockedReportKey);
  });

  it('a DIFFERENT blocked set gets a different key, so a new outage is not swallowed', () => {
    const codexOnly = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEX] x' }));
    const both = decideRouting(req({ issueTitle: '[AI TASK][CLAUDE][CODEX] x', secrets: CLAUDE_ONLY }));
    // Gemini is not requested here, so widen: request it too.
    const withGemini = decideRouting(req({ issueTitle: '[AI TASK][BOTH][CODEX] x', secrets: CLAUDE_ONLY }));
    expect(codexOnly.blockedReportKey).toBe('CODEX');
    expect(both.blockedReportKey).toBe('CODEX');
    expect(withGemini.blockedReportKey).toBe('CODEX+GEMINI');
  });

  it('key and owner are pure functions of the blocked list', () => {
    expect(blockedReportKeyFor([])).toBeNull();
    expect(blockedReportOwnerFor([])).toBeNull();
  });
});

// ===========================================================================
// Blocker 3 — Codex session rollout binding
// ===========================================================================

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    try {
      execFileSync(
        process.platform === 'win32' ? 'cmd' : 'rm',
        process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', d] : ['-rf', d],
        { windowsHide: true },
      );
    } catch {
      /* ignore */
    }
  }
});

const REAL_SESSION = '01a043d3-46d7-7540-a8b3-409452d6874e';
const OTHER_SESSION = '01a043d3-46d7-7540-a8b3-409452d6874f';

describe('Jules #168: a session rollout must be BOUND to the run, not name-matched', () => {
  it('rejects a session id that is not a well-formed UUID', () => {
    for (const bad of ['a', '0', '-', '', 'not-a-uuid', '01a043d3', null, undefined]) {
      expect(isPlausibleSessionId(bad)).toBe(false);
    }
    expect(isPlausibleSessionId(REAL_SESSION)).toBe(true);
    expect(isPlausibleSessionId(REAL_SESSION.toUpperCase())).toBe(true);
  });

  it('matches a rollout filename only on a whole delimited token', () => {
    expect(sessionRolloutNameMatches(`rollout-2026-08-27T10-00-00-${REAL_SESSION}.jsonl`, REAL_SESSION)).toBe(true);
    expect(sessionRolloutNameMatches(`${REAL_SESSION}.jsonl`, REAL_SESSION)).toBe(true);
    // THE REGRESSION: `entry.includes(sessionId)` matched a LONGER id that
    // merely starts with ours, handing us another run's attestations.
    expect(sessionRolloutNameMatches(`rollout-${REAL_SESSION}extra.jsonl`, REAL_SESSION)).toBe(false);
    expect(sessionRolloutNameMatches(`rollout-x${REAL_SESSION}.jsonl`, REAL_SESSION)).toBe(false);
  });

  it('a short or empty id can never select a file', () => {
    expect(sessionRolloutNameMatches('rollout-a-b.jsonl', 'a')).toBe(false);
    expect(sessionRolloutNameMatches('anything.jsonl', '')).toBe(false);
  });

  it('finds the one genuine rollout on disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'jenify-codexhome-'));
    tempDirs.push(home);
    const dir = join(home, 'sessions', '2026', '08', '27');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-08-27T10-00-00-${REAL_SESSION}.jsonl`), '{}', 'utf8');
    writeFileSync(join(dir, `rollout-2026-08-27T11-00-00-${OTHER_SESSION}.jsonl`), '{}', 'utf8');
    expect(findSessionRollout(home, REAL_SESSION)).toContain(REAL_SESSION);
    expect(findSessionRollout(home, OTHER_SESSION)).toContain(OTHER_SESSION);
  });

  it('an AMBIGUOUS match returns nothing rather than guessing', () => {
    const home = mkdtempSync(join(tmpdir(), 'jenify-codexhome-'));
    tempDirs.push(home);
    const a = join(home, 'sessions', 'a');
    const b = join(home, 'sessions', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    // Two files claim the same session. Directory order is not evidence.
    writeFileSync(join(a, `rollout-${REAL_SESSION}.jsonl`), '{}', 'utf8');
    writeFileSync(join(b, `rollout-${REAL_SESSION}.jsonl`), '{}', 'utf8');
    expect(findSessionRollout(home, REAL_SESSION)).toBeNull();
  });

  it('a malformed session id never walks the disk at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'jenify-codexhome-'));
    tempDirs.push(home);
    const dir = join(home, 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-${REAL_SESSION}.jsonl`), '{}', 'utf8');
    expect(findSessionRollout(home, 'a')).toBeNull();
    expect(findSessionRollout(home, '-')).toBeNull();
    expect(findSessionRollout(home, null)).toBeNull();
  });

  it('reads back the session id a rollout declares about itself', () => {
    const rollout = JSON.stringify({ type: 'session_meta', payload: { session_id: REAL_SESSION } });
    expect(extractRolloutSessionId(rollout)).toBe(REAL_SESSION);
    expect(extractRolloutSessionId('')).toBeNull();
    expect(extractRolloutSessionId('not json at all')).toBeNull();
  });

  it('refuses a rollout whose declared session is a DIFFERENT run', () => {
    const foreign = JSON.stringify({
      type: 'session_meta',
      payload: { session_id: OTHER_SESSION, git: { commit_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } },
    });
    const v = verifyRolloutBinding(REAL_SESSION, foreign);
    expect(v.ok).toBe(false);
  });

  it('refuses a rollout that declares no session of its own', () => {
    const anonymous = JSON.stringify({ type: 'session_meta', payload: { git: { commit_hash: 'abc1234' } } });
    expect(verifyRolloutBinding(REAL_SESSION, anonymous).ok).toBe(false);
  });

  it('accepts the genuine, self-consistent rollout', () => {
    const good = JSON.stringify({ type: 'session_meta', payload: { session_id: REAL_SESSION } });
    expect(verifyRolloutBinding(REAL_SESSION, good).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end: a hostile runtime cannot spoof provenance through the runner
// ---------------------------------------------------------------------------

const CONNECTED_PROBE: CodexProbeResult = {
  installed: true,
  cliPath: '/fake/codex',
  authMode: 'chatgpt',
  authenticated: true,
  codexHome: '/fake/.codex',
  helperPaths: [],
  facts: { CODEX_CLI_PATH: '/fake/codex', CODEX_AUTH_MODE: 'chatgpt' },
  reason: 'fake connected probe',
};

const GOOD_REVIEW = {
  verdict: 'PASS',
  summary: 'Looks fine.',
  findings: [],
  testConcerns: [],
  securityConcerns: [],
  recommendation: 'Merge.',
};

function makeRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jenify-codex-wave2-'));
  tempDirs.push(dir);
  const g = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  g('add', '.');
  g('commit', '-q', '-m', 'initial');
  return { dir, sha: g('rev-parse', 'HEAD') };
}

/** A Codex that returns a clean PASS and attests `sessionId`. */
function codexAttesting(sessionId: string): SpawnImpl {
  return (_command, args) => {
    const outFile = args[args.indexOf('--output-last-message') + 1]!;
    writeFileSync(outFile, JSON.stringify(GOOD_REVIEW), 'utf8');
    return {
      status: 0,
      stdout: JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
      stderr: '',
    };
  };
}

function request(dir: string, sha: string): CodexReviewRequest {
  return {
    requestedProvider: 'CODEX',
    role: 'REVIEWER',
    repoDir: dir,
    targetSha: sha,
    baseRef: 'origin/main',
    pullRequest: 174,
    issueNumber: null,
    extraInstructions: null,
  };
}

describe('Jules #168 end to end: foreign provenance cannot reach a verdict', () => {
  it('a rollout belonging to another session is rejected, PASS notwithstanding', () => {
    const { dir, sha } = makeRepo();
    const outcome = runCodexReview(request(dir, sha), {
      probe: CONNECTED_PROBE,
      spawnImpl: codexAttesting(REAL_SESSION),
      // The attacker's payoff: a rollout attesting the RIGHT commit, so the SHA
      // check would pass — but belonging to a different session.
      readSessionRollout: () =>
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { session_id: OTHER_SESSION, cli_version: '9.9.9', model_provider: 'openai', git: { commit_hash: sha } },
          }),
          JSON.stringify({ type: 'turn_context', payload: { model: 'totally-real-model' } }),
        ].join('\n'),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('session_unbound');
    expect(outcome.actualProvider).toBeNull();
    expect(outcome.review).toBeNull();
    // and none of the foreign run's claims were adopted
    expect(outcome.evidence.actualModel).not.toBe('totally-real-model');
  });

  it('a runtime attesting a malformed session id cannot bind any rollout', () => {
    const { dir, sha } = makeRepo();
    const outcome = runCodexReview(request(dir, sha), {
      probe: CONNECTED_PROBE,
      spawnImpl: codexAttesting('a'),
      readSessionRollout: () =>
        JSON.stringify({ type: 'session_meta', payload: { session_id: 'a', git: { commit_hash: sha } } }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.actualProvider).toBeNull();
  });

  it('the genuine, self-consistent run still passes end to end', () => {
    const { dir, sha } = makeRepo();
    const outcome = runCodexReview(request(dir, sha), {
      probe: CONNECTED_PROBE,
      spawnImpl: codexAttesting(REAL_SESSION),
      readSessionRollout: () =>
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { session_id: REAL_SESSION, cli_version: '0.147.0', model_provider: 'openai', git: { commit_hash: sha } },
          }),
          JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
        ].join('\n'),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.actualProvider).toBe('CODEX');
    expect(outcome.evidence.sessionId).toBe(REAL_SESSION);
    expect(outcome.evidence.attestedCommitSha).toBe(sha);
  });
});
