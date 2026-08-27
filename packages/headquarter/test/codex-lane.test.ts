import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_ASSIGNMENTS,
  applyAssignmentOverrides,
  connectedProviders,
  decideRouting,
  providerConnectivity,
  providerForRole,
  providersForRole,
  PROVIDER_REGISTRY,
  type RoleAssignments,
  type RoutingRequest,
  type SecretsEnv,
} from '../src/routing/index.js';
import {
  buildCodexExecArgs,
  buildReviewPrompt,
  extractEvidence,
  extractRuntimeError,
  isQuotaError,
  parseReviewOutput,
  renderCodexProvenance,
  runCodexReview,
  shaMatches,
  verifyReviewedSha,
  type CodexProbeResult,
  type CodexReviewRequest,
  type SpawnImpl,
} from '../src/providers/codex/index.js';

/**
 * Codex lane safety matrix (Founder mission Phase 7).
 *
 * Every numbered scenario the Founder required is a deterministic test here.
 * None of them spend real Codex allowance: the runner exposes a spawn seam, so
 * the enforcement rules (read-only, exact SHA, no mutation, no substitution)
 * are proven against the real code path with a scripted Codex.
 */

const OWNER = 'kiniena-github';

/** Secrets as they genuinely exist on the repository (GitHub Actions view). */
const CI_SECRETS: SecretsEnv = {
  CLAUDE_ROUTINE_URL: 'https://example.invalid/fire',
  CLAUDE_ROUTINE_TOKEN: 'token',
  GEMINI_API_KEY: 'key',
};

/** The same, plus the local facts observed on the Founder workstation. */
const LOCAL_SECRETS: SecretsEnv = {
  ...CI_SECRETS,
  CODEX_CLI_PATH: 'C:\\Users\\k\\AppData\\Local\\OpenAI\\Codex\\bin\\x\\codex.exe',
  CODEX_AUTH_MODE: 'chatgpt',
};

function req(over: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    trigger: 'issue_opened',
    issueTitle: '[AI TASK] Do a thing',
    actorLogin: OWNER,
    issueAuthorLogin: OWNER,
    repositoryOwner: OWNER,
    secrets: CI_SECRETS,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A disposable git repo, so the runner's real git checks run for real.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jenify-codex-test-'));
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

afterAll(() => {
  // Best-effort cleanup; a leftover temp dir is harmless.
  for (const d of tempDirs) {
    try {
      execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', d] : ['-rf', d], { windowsHide: true });
    } catch {
      /* ignore */
    }
  }
});

const CONNECTED_PROBE: CodexProbeResult = {
  installed: true,
  cliPath: 'C:\\fake\\codex.exe',
  authMode: 'chatgpt',
  authenticated: true,
  codexHome: 'C:\\fake\\.codex',
  helperPaths: ['C:\\fake\\bin'],
  facts: { CODEX_CLI_PATH: 'C:\\fake\\codex.exe', CODEX_AUTH_MODE: 'chatgpt' },
  reason: 'fake connected probe',
};

const DISCONNECTED_PROBE: CodexProbeResult = {
  installed: false,
  cliPath: null,
  authMode: null,
  authenticated: false,
  codexHome: null,
  helperPaths: [],
  facts: {},
  reason: 'Codex CLI not found.',
};

const GOOD_REVIEW = {
  verdict: 'PASS',
  summary: 'Change is correct and covered.',
  findings: [{ severity: 'LOW', category: 'maintainability', title: 'Nit', file: 'a.txt', line: 1, evidence: 'minor' }],
  testConcerns: [],
  securityConcerns: [],
  recommendation: 'Merge.',
};

/** A scripted Codex that writes a valid review and attests the given SHA. */
function scriptedCodex(opts: { sha: string; body?: unknown; sessionId?: string; model?: string }): {
  spawnImpl: SpawnImpl;
  readSessionRollout: (id: string | null) => string | null;
  calls: Array<{ command: string; args: string[] }>;
} {
  const sessionId = opts.sessionId ?? '01a043d3-46d7-7540-a8b3-409452d6874e';
  const model = opts.model ?? 'gpt-5.6-sol';
  const calls: Array<{ command: string; args: string[] }> = [];

  const spawnImpl: SpawnImpl = (command, args) => {
    calls.push({ command, args });
    const outIdx = args.indexOf('--output-last-message');
    const outFile = args[outIdx + 1]!;
    writeFileSync(outFile, JSON.stringify(opts.body ?? GOOD_REVIEW), 'utf8');
    const events = [
      JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join('\n');
    return { status: 0, stdout: events, stderr: '' };
  };

  const readSessionRollout = (id: string | null): string | null => {
    if (id !== sessionId) return null;
    return [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: sessionId,
          cli_version: '0.147.0-alpha.6.5',
          model_provider: 'openai',
          cwd: 'C:\\repo',
          git: { commit_hash: opts.sha, branch: 'test', repository_url: 'https://github.com/kiniena-github/JENIFY-OS.git' },
        },
      }),
      JSON.stringify({ type: 'turn_context', payload: { model } }),
    ].join('\n');
  };

  return { spawnImpl, readSessionRollout, calls };
}

function reviewRequest(dir: string, sha: string, over: Partial<CodexReviewRequest> = {}): CodexReviewRequest {
  return {
    requestedProvider: 'CODEX',
    role: 'REVIEWER',
    repoDir: dir,
    targetSha: sha,
    baseRef: 'origin/main',
    pullRequest: 153,
    issueNumber: null,
    extraInstructions: null,
    ...over,
  };
}

// ===========================================================================
// 1 — a CODEX task reaches genuine Codex
// ===========================================================================
describe('1: a CODEX task reaches genuine Codex', () => {
  it('routes to CODEX, and only CODEX, when Codex is genuinely connected', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CODEX] review this', secrets: LOCAL_SECRETS }));
    expect(d.outcome).toBe('ROUTE');
    expect(d.dispatchTo).toEqual(['CODEX']);
    expect(d.dispatchTo).not.toContain('CLAUDE');
  });

  it('the CODEX executor is a real, declared entry point', () => {
    const def = PROVIDER_REGISTRY.CODEX;
    expect(def.executor).toBe('packages/headquarter/src/cli/codex-review.ts');
    expect(def.executorKind).toBe('local-cli');
  });

  it('a genuine run produces a real review through the real code path', () => {
    const { dir, sha } = makeRepo();
    const codex = scriptedCodex({ sha });
    const outcome = runCodexReview(reviewRequest(dir, sha), { probe: CONNECTED_PROBE, ...codex });
    expect(outcome.ok).toBe(true);
    expect(outcome.review?.verdict).toBe('PASS');
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]!.command).toBe(CONNECTED_PROBE.cliPath);
  });
});

// ===========================================================================
// 2 — Claude cannot satisfy a CODEX route
// ===========================================================================
describe('2: Claude cannot satisfy a CODEX route', () => {
  it('a blocked Codex task is never re-routed to Claude', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CODEX] x', secrets: CI_SECRETS }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
    expect(d.reason).toContain('ROUTING BLOCKED — CODEX NOT CONNECTED');
  });

  it('the Codex runner refuses to execute a request for any other provider', () => {
    const { dir, sha } = makeRepo();
    const codex = scriptedCodex({ sha });
    const outcome = runCodexReview(reviewRequest(dir, sha, { requestedProvider: 'CLAUDE' }), {
      probe: CONNECTED_PROBE,
      ...codex,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('provider_mismatch');
    expect(codex.calls).toHaveLength(0);
  });

  it('an unproven run never claims CODEX as the actual provider', () => {
    const { dir, sha } = makeRepo();
    const outcome = runCodexReview(reviewRequest(dir, sha), { probe: DISCONNECTED_PROBE });
    expect(outcome.actualProvider).toBeNull();
  });
});

// ===========================================================================
// 3 — missing Codex connectivity fails closed
// ===========================================================================
describe('3: missing Codex connectivity fails closed', () => {
  it('no CLI and no auth => NOT CONNECTED, nothing executed', () => {
    const { dir, sha } = makeRepo();
    const codex = scriptedCodex({ sha });
    const outcome = runCodexReview(reviewRequest(dir, sha), { probe: DISCONNECTED_PROBE, ...codex });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('not_connected');
    expect(outcome.failure?.message).toContain('ROUTING BLOCKED — CODEX NOT CONNECTED');
    expect(codex.calls).toHaveLength(0);
  });

  it('GitHub Actions (no local CLI) fails closed for CODEX by design', () => {
    const conn = providerConnectivity('CODEX', CI_SECRETS);
    expect(conn.connected).toBe(false);
    expect(conn.hasExecutor).toBe(true);
    expect(conn.missingLocalFacts).toEqual(['CODEX_CLI_PATH', 'CODEX_AUTH_MODE']);
  });

  it('a half-configured Codex (CLI present, not logged in) is still not connected', () => {
    const conn = providerConnectivity('CODEX', { ...CI_SECRETS, CODEX_CLI_PATH: 'C:\\codex.exe' });
    expect(conn.connected).toBe(false);
    expect(conn.missingLocalFacts).toEqual(['CODEX_AUTH_MODE']);
  });
});

// ===========================================================================
// 4 — a Codex result records actual provenance
// ===========================================================================
describe('4: a Codex result records actual provenance', () => {
  it('model, session, CLI version and reviewed commit come from the runtime attestation', () => {
    const { dir, sha } = makeRepo();
    const codex = scriptedCodex({ sha, model: 'gpt-5.6-sol' });
    const outcome = runCodexReview(reviewRequest(dir, sha), { probe: CONNECTED_PROBE, ...codex });

    expect(outcome.ok).toBe(true);
    expect(outcome.actualProvider).toBe('CODEX');
    expect(outcome.evidence.actualModel).toBe('gpt-5.6-sol');
    expect(outcome.evidence.modelProvider).toBe('openai');
    expect(outcome.evidence.cliVersion).toBe('0.147.0-alpha.6.5');
    expect(outcome.evidence.sessionId).toBe('01a043d3-46d7-7540-a8b3-409452d6874e');
    expect(outcome.evidence.attestedCommitSha).toBe(sha);
  });

  it('provenance never invents a model it was not told', () => {
    const evidence = extractEvidence({ execEvents: JSON.stringify({ type: 'thread.started', thread_id: 'abc' }) });
    expect(evidence.actualModel).toBeNull();
    const md = renderCodexProvenance({
      requestedProvider: 'CODEX',
      actualProvider: null,
      role: 'REVIEWER',
      requestedSha: 'a'.repeat(40),
      evidence,
      status: 'blocked',
      timestamp: '2026-08-27T10:00:00.000Z',
      executor: 'test',
    });
    expect(md).toContain('| Requested provider | CODEX |');
    expect(md).toContain('| Actual provider | _unverified_ |');
    expect(md).toContain('| Actual model | _unverified_ |');
  });

  it('requested and actual provider are separate rows, so disagreement is visible', () => {
    const md = renderCodexProvenance({
      requestedProvider: 'CODEX',
      actualProvider: 'CODEX',
      role: 'REVIEWER',
      requestedSha: 'b'.repeat(40),
      evidence: { ...extractEvidence({}), actualModel: 'gpt-5.6-sol', attestedCommitSha: 'b'.repeat(40) },
      status: 'completed',
      timestamp: '2026-08-27T10:00:00.000Z',
      executor: 'test',
    });
    expect(md).toContain('| Requested provider | CODEX |');
    expect(md).toContain('| Actual provider | CODEX |');
    expect(md).toContain(`| Attested SHA (reviewed) | ${'b'.repeat(40)} |`);
  });
});

// ===========================================================================
// 5 — Codex can review an exact PR SHA
// ===========================================================================
describe('5: Codex reviews an exact PR SHA', () => {
  it('the exact commit and PR number reach the reviewer prompt', () => {
    const sha = 'c'.repeat(40);
    const prompt = buildReviewPrompt(reviewRequest('C:\\repo', sha));
    expect(prompt).toContain(sha);
    expect(prompt).toContain('pull request #153');
    expect(prompt).toContain('origin/main');
  });

  it('a review of the checked-out commit succeeds end to end', () => {
    const { dir, sha } = makeRepo();
    const codex = scriptedCodex({ sha });
    const outcome = runCodexReview(reviewRequest(dir, sha), { probe: CONNECTED_PROBE, ...codex });
    expect(outcome.ok).toBe(true);
    expect(outcome.evidence.attestedCommitSha).toBe(sha);
  });

  it('a structured BLOCK verdict survives round-tripping with its findings ranked', () => {
    const parsed = parseReviewOutput(
      JSON.stringify({
        verdict: 'BLOCK',
        summary: 'Tenant scoping missing.',
        findings: [
          { severity: 'LOW', category: 'other', title: 'nit', file: null, line: null, evidence: '' },
          { severity: 'CRITICAL', category: 'security', title: 'Cross-tenant read', file: 'src/x.ts', line: 42, evidence: 'Tenant B reads A.' },
        ],
        testConcerns: ['no test for the tenant guard'],
        securityConcerns: ['tenant isolation'],
        recommendation: 'Fix before merge.',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.review.verdict).toBe('BLOCK');
    expect(parsed.review.findings[0]!.severity).toBe('CRITICAL');
    expect(parsed.review.findings[0]!.line).toBe(42);
    expect(parsed.review.testConcerns).toEqual(['no test for the tenant guard']);
  });

  it('a PASS carrying CRITICAL/HIGH findings is upgraded to BLOCK', () => {
    const parsed = parseReviewOutput(
      JSON.stringify({
        verdict: 'PASS',
        summary: 'Looks fine.',
        findings: [{ severity: 'HIGH', category: 'correctness', title: 'Off-by-one', file: 'a.ts', line: 3, evidence: 'drops last row' }],
        testConcerns: [],
        securityConcerns: [],
        recommendation: 'ship',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.review.verdict).toBe('BLOCK');
  });

  it('an unusable or empty result fails closed instead of defaulting to PASS', () => {
    expect(parseReviewOutput('')).toMatchObject({ ok: false, kind: 'empty_result' });
    expect(parseReviewOutput('Looks good to me!')).toMatchObject({ ok: false, kind: 'unparseable_result' });
    expect(parseReviewOutput(JSON.stringify({ summary: 'no verdict' }))).toMatchObject({ ok: false, kind: 'unparseable_result' });
  });
});

// ===========================================================================
// 6 — a review cannot silently target a stale SHA
// ===========================================================================
describe('6: a review cannot silently target a stale SHA', () => {
  it('a checkout at a different commit is refused before Codex is even started', () => {
    const { dir } = makeRepo();
    const codex = scriptedCodex({ sha: 'd'.repeat(40) });
    const outcome = runCodexReview(reviewRequest(dir, 'd'.repeat(40)), { probe: CONNECTED_PROBE, ...codex });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('sha_mismatch');
    expect(codex.calls).toHaveLength(0);
  });

  it('a runtime that attests a DIFFERENT commit than requested is rejected', () => {
    const { dir, sha } = makeRepo();
    // Codex runs, but attests a stale commit — the result must not be accepted.
    const codex = scriptedCodex({ sha: 'e'.repeat(40) });
    const outcome = runCodexReview(reviewRequest(dir, sha), { probe: CONNECTED_PROBE, ...codex });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('sha_mismatch');
    expect(outcome.review).toBeNull();
  });

  it('a runtime that attests NO commit is rejected, not assumed to match', () => {
    const { dir, sha } = makeRepo();
    const codex = scriptedCodex({ sha });
    const outcome = runCodexReview(reviewRequest(dir, sha), {
      probe: CONNECTED_PROBE,
      spawnImpl: codex.spawnImpl,
      readSessionRollout: () => null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('no_sha_attested');
  });

  it('SHA comparison accepts a real abbreviation but not a near-miss', () => {
    const full = '095b88f8f3addb9ae8bda1b5b96f426de4b0b1d4';
    expect(shaMatches(full, '095b88f')).toBe(true);
    expect(shaMatches('095b88f', full)).toBe(true);
    expect(shaMatches(full, full.toUpperCase())).toBe(true);
    expect(shaMatches(full, '095b88e')).toBe(false);
    expect(shaMatches(full, '095b8')).toBe(false); // shorter than git's 7-char minimum
    expect(shaMatches(full, '')).toBe(false);
    expect(shaMatches(full, null)).toBe(false);
  });

  it('verifyReviewedSha reports the mismatch concretely', () => {
    const v = verifyReviewedSha('a'.repeat(40), { ...extractEvidence({}), attestedCommitSha: 'b'.repeat(40) });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.kind).toBe('sha_mismatch');
    expect(v.message).toContain('b'.repeat(40));
    expect(v.message).toContain('a'.repeat(40));
  });
});

// ===========================================================================
// 7 — the Codex reviewer cannot mutate the reviewed code
// ===========================================================================
describe('7: the Codex reviewer cannot mutate reviewed code', () => {
  it('the CLI is always invoked with a read-only sandbox', () => {
    const args = buildCodexExecArgs({
      repoDir: 'C:\\repo',
      schemaFile: 's.json',
      lastMessageFile: 'm.txt',
      prompt: 'review',
    });
    const i = args.indexOf('--sandbox');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain('danger-full-access');
  });

  it('a model override cannot smuggle in a writable sandbox', () => {
    const args = buildCodexExecArgs({
      repoDir: 'C:\\repo',
      schemaFile: 's.json',
      lastMessageFile: 'm.txt',
      prompt: 'review',
      model: 'gpt-5.6-sol',
    });
    expect(args.filter((a) => a === '--sandbox')).toHaveLength(1);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('a run that changed the worktree is rejected even if the review looks fine', () => {
    const { dir, sha } = makeRepo();
    const good = scriptedCodex({ sha });
    const mutating: SpawnImpl = (command, args) => {
      // simulate a reviewer that edits the code it was asked to review
      writeFileSync(join(dir, 'a.txt'), 'MUTATED\n', 'utf8');
      return good.spawnImpl(command, args, 0);
    };
    const outcome = runCodexReview(reviewRequest(dir, sha), {
      probe: CONNECTED_PROBE,
      spawnImpl: mutating,
      readSessionRollout: good.readSessionRollout,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('worktree_mutated');
    expect(outcome.review).toBeNull();
  });

  it('the reviewer prompt states the review-only rule as well', () => {
    const prompt = buildReviewPrompt(reviewRequest('C:\\repo', 'f'.repeat(40)));
    expect(prompt).toContain('Do not modify, stage, commit, push, or revert anything');
  });
});

// ===========================================================================
// 8 — Jules still works independently
// ===========================================================================
describe('8: Jules still works independently', () => {
  it('Jules is still a registered provider with its own identity and marker', () => {
    const def = PROVIDER_REGISTRY.JULES;
    expect(def.id).toBe('JULES');
    expect(def.resultMarker).toBe('jenify-jules-result');
    expect(def.executor).not.toBeNull();
  });

  it('Jules routes on its own when its lane is observed, without touching Codex', () => {
    const withJules = { ...LOCAL_SECRETS, JULES_CLI_PATH: 'C:\\npm\\jules.cmd' };
    const d = decideRouting(req({ issueTitle: '[AI TASK][JULES] review', secrets: withJules }));
    expect(d.outcome).toBe('ROUTE');
    expect(d.dispatchTo).toEqual(['JULES']);
  });

  it('Jules fails closed on its own terms, and is never covered for by Codex', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][JULES] review', secrets: LOCAL_SECRETS }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
    expect(d.reason).toContain('JULES NOT CONNECTED');
  });

  it('a Jules result comment can never re-trigger a worker', () => {
    const d = decideRouting(
      req({
        trigger: 'issue_comment',
        issueTitle: '[AI TASK][JULES] review',
        commentBody: '<!-- jenify-jules-result --> report <!-- jenify-run -->',
        secrets: LOCAL_SECRETS,
      }),
    );
    expect(d.outcome).toBe('IGNORE');
  });
});

// ===========================================================================
// 9 — the REVIEWER role can switch Codex <-> Jules with no redesign
// ===========================================================================
describe('9: the REVIEWER role switches provider without architectural change', () => {
  const withBoth: SecretsEnv = { ...LOCAL_SECRETS, JULES_CLI_PATH: 'C:\\npm\\jules.cmd' };

  it('a role-only task is staffed from the assignment table, not hard-coded to Claude', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][REVIEWER] review PR', secrets: withBoth }));
    expect(d.outcome).toBe('ROUTE');
    expect(d.role).toBe('REVIEWER');
    expect(d.staffedFromRole).toBe(true);
    expect(d.dispatchTo).toEqual(['JULES']); // current default
    expect(d.dispatchTo).not.toContain('CLAUDE');
  });

  it('changing ONLY the assignment moves the same task to Codex', () => {
    const codexPrimary: RoleAssignments = {
      ...DEFAULT_ROLE_ASSIGNMENTS,
      REVIEWER: { ...DEFAULT_ROLE_ASSIGNMENTS.REVIEWER, primary: 'CODEX', backup: ['JULES'] },
    };
    const d = decideRouting(req({ issueTitle: '[AI TASK][REVIEWER] review PR', secrets: withBoth, assignments: codexPrimary }));
    expect(d.outcome).toBe('ROUTE');
    expect(d.dispatchTo).toEqual(['CODEX']);
    expect(d.role).toBe('REVIEWER');
  });

  it('the switch also works at runtime, with no code change at all', () => {
    const { assignments, applied, rejected } = applyAssignmentOverrides(DEFAULT_ROLE_ASSIGNMENTS, {
      JENIFY_ROLE_REVIEWER: 'codex',
    });
    expect(rejected).toEqual([]);
    expect(applied).toEqual([{ role: 'REVIEWER', provider: 'CODEX' }]);
    expect(providerForRole('REVIEWER', assignments)).toBe('CODEX');
    // the outgoing primary stays available for explicit second-opinion dispatch
    expect(providersForRole('REVIEWER', assignments)).toContain('JULES');

    const d = decideRouting(req({ issueTitle: '[AI TASK][REVIEWER] x', secrets: withBoth, assignments }));
    expect(d.dispatchTo).toEqual(['CODEX']);
  });

  it('and back again — the role is the architecture, the provider is staffing', () => {
    const toJules = applyAssignmentOverrides(DEFAULT_ROLE_ASSIGNMENTS, { JENIFY_ROLE_REVIEWER: 'JULES' }).assignments;
    const toGemini = applyAssignmentOverrides(DEFAULT_ROLE_ASSIGNMENTS, { JENIFY_ROLE_REVIEWER: 'GEMINI' }).assignments;
    expect(providerForRole('REVIEWER', toJules)).toBe('JULES');
    expect(providerForRole('REVIEWER', toGemini)).toBe('GEMINI');
    expect(decideRouting(req({ issueTitle: '[AI TASK][REVIEWER] x', secrets: withBoth, assignments: toGemini })).dispatchTo).toEqual(['GEMINI']);
  });

  it('an explicit provider tag still beats the role assignment', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CODEX][REVIEWER] x', secrets: withBoth }));
    expect(d.dispatchTo).toEqual(['CODEX']);
    expect(d.staffedFromRole).toBe(false);
  });

  it('a role staffed to an unconnected provider FAILS CLOSED rather than falling back', () => {
    // REVIEWER -> JULES, but Jules is not observed here. The backup list holds
    // CODEX, which IS connected — and must NOT be silently used.
    const d = decideRouting(req({ issueTitle: '[AI TASK][REVIEWER] x', secrets: LOCAL_SECRETS }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
    expect(d.reason).toContain('JULES NOT CONNECTED');
  });

  it('a bad override is rejected, never silently ignored', () => {
    const { assignments, applied, rejected } = applyAssignmentOverrides(DEFAULT_ROLE_ASSIGNMENTS, {
      JENIFY_ROLE_REVIEWER: 'CODEXX',
    });
    expect(applied).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain('not a known provider');
    expect(providerForRole('REVIEWER', assignments)).toBe('JULES');
  });

  it('every role can be restaffed, not just REVIEWER', () => {
    const { assignments } = applyAssignmentOverrides(DEFAULT_ROLE_ASSIGNMENTS, {
      JENIFY_ROLE_MANAGER: 'GEMINI',
      JENIFY_ROLE_BUILDER: 'CODEX',
      JENIFY_ROLE_RESEARCHER: 'CLAUDE',
    });
    expect(providerForRole('MANAGER', assignments)).toBe('GEMINI');
    expect(providerForRole('BUILDER', assignments)).toBe('CODEX');
    expect(providerForRole('RESEARCHER', assignments)).toBe('CLAUDE');
  });
});

// ===========================================================================
// 10 — existing Claude / Gemini routing is untouched
// ===========================================================================
describe('10: existing Claude and Gemini routing remains intact', () => {
  it('a bare [AI TASK] still goes to Claude and nothing else', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK] build a thing', secrets: LOCAL_SECRETS }));
    expect(d.outcome).toBe('ROUTE');
    expect(d.dispatchTo).toEqual(['CLAUDE']);
    expect(d.staffedFromRole).toBe(false);
  });

  it('[GEMINI] still goes to Gemini only', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][GEMINI] research', secrets: LOCAL_SECRETS }));
    expect(d.dispatchTo).toEqual(['GEMINI']);
  });

  it('[BOTH] still fans out to Claude and Gemini in a stable order', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][BOTH] x', secrets: LOCAL_SECRETS }));
    expect(d.dispatchTo).toEqual(['CLAUDE', 'GEMINI']);
  });

  it('the workflow-executed providers are still exactly Claude and Gemini', () => {
    const ci = connectedProviders(CI_SECRETS);
    expect(ci).toEqual(['CLAUDE', 'GEMINI']);
  });

  it('adding Codex locally does not disturb the existing lanes', () => {
    expect(connectedProviders(LOCAL_SECRETS)).toEqual(['CLAUDE', 'GEMINI', 'CODEX']);
  });
});

// ===========================================================================
// 11 — unknown providers still fail closed
// ===========================================================================
describe('11: unknown providers still fail closed', () => {
  it('an unrecognised tag never defaults to Claude', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][COPILOTX] x', secrets: LOCAL_SECRETS }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
  });

  it('a misspelled Codex tag is refused, not helpfully corrected', () => {
    const d = decideRouting(req({ issueTitle: '[AI TASK][CODE X] x', secrets: LOCAL_SECRETS }));
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
    expect(d.reason).toContain('Refusing to default to Claude');
  });

  it('an unknown provider in a run directive is refused', () => {
    const d = decideRouting(
      req({
        trigger: 'issue_comment',
        issueTitle: '[AI TASK][CODEX] x',
        commentBody: '<!-- jenify-run: NOTAREALAI -->',
        secrets: LOCAL_SECRETS,
      }),
    );
    expect(d.outcome).toBe('BLOCKED');
    expect(d.dispatchTo).toEqual([]);
  });

  it('every registry entry either has an executor or explains why it cannot run', () => {
    for (const def of Object.values(PROVIDER_REGISTRY)) {
      if (def.executor == null) {
        expect(def.executorKind).toBeNull();
      } else {
        expect(def.executorKind).not.toBeNull();
      }
    }
  });
});

// ===========================================================================
// The provider's own refusal is reported in its own words
// ===========================================================================
describe('a Codex refusal is reported honestly, never as a review', () => {
  /** Verbatim event stream captured from the real CLI on 2026-08-27. */
  const QUOTA_EVENTS = [
    JSON.stringify({ type: 'thread.started', thread_id: '01a043f3-3ece-70c2-a045-bbf468204a36' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'error',
      message:
        "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:25 PM.",
    }),
    JSON.stringify({
      type: 'turn.failed',
      error: { message: "You've hit your usage limit." },
    }),
  ].join('\n');

  it('an exhausted allowance is reported as quota_exhausted, in the provider own words', () => {
    const { dir, sha } = makeRepo();
    const outcome = runCodexReview(reviewRequest(dir, sha), {
      probe: CONNECTED_PROBE,
      spawnImpl: () => ({ status: 1, stdout: QUOTA_EVENTS, stderr: 'Reading additional input from stdin...' }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.kind).toBe('quota_exhausted');
    expect(outcome.failure?.message).toContain('usage limit');
    expect(outcome.failure?.message).toContain('11:25 PM');
    // and it must be clear this is not a verdict on the code
    expect(outcome.failure?.message).toContain('Nothing is wrong with the reviewed code');
    expect(outcome.review).toBeNull();
    expect(outcome.actualProvider).toBeNull();
  });

  it('a non-quota runtime error is reported as provider_error', () => {
    const { dir, sha } = makeRepo();
    const events = JSON.stringify({ type: 'error', message: 'upstream connection reset' });
    const outcome = runCodexReview(reviewRequest(dir, sha), {
      probe: CONNECTED_PROBE,
      spawnImpl: () => ({ status: 1, stdout: events, stderr: '' }),
    });
    expect(outcome.failure?.kind).toBe('provider_error');
    expect(outcome.failure?.message).toContain('upstream connection reset');
  });

  it('a refusal is never turned into a PASS', () => {
    const { dir, sha } = makeRepo();
    const good = scriptedCodex({ sha });
    const outcome = runCodexReview(reviewRequest(dir, sha), {
      probe: CONNECTED_PROBE,
      // a valid review file is on disk, but the runtime also reported an error:
      // the error wins, because the review cannot be trusted.
      spawnImpl: (c, a) => {
        good.spawnImpl(c, a, 0);
        return { status: 1, stdout: QUOTA_EVENTS, stderr: '' };
      },
      readSessionRollout: good.readSessionRollout,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.review).toBeNull();
  });

  it('quota detection recognises the real wordings, and does not over-match', () => {
    expect(isQuotaError("You've hit your usage limit.")).toBe(true);
    expect(isQuotaError('429 Too Many Requests')).toBe(true);
    expect(isQuotaError('quota exceeded for this project')).toBe(true);
    expect(isQuotaError('TypeError: cannot read property of undefined')).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it('extractRuntimeError finds the message in either event shape', () => {
    expect(extractRuntimeError(QUOTA_EVENTS)).toContain('usage limit');
    expect(extractRuntimeError(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }))).toBe('boom');
    expect(extractRuntimeError(JSON.stringify({ type: 'turn.completed' }))).toBeNull();
    expect(extractRuntimeError(undefined)).toBeNull();
  });
});

// ===========================================================================
// Codex result comments are loop-proof, like every other provider
// ===========================================================================
describe('Codex results never re-trigger Codex', () => {
  it('a Codex result comment carrying a run directive is inert', () => {
    const d = decideRouting(
      req({
        trigger: 'issue_comment',
        issueTitle: '[AI TASK][CODEX] x',
        commentBody: '<!-- jenify-codex-result -->\n## Codex Independent Review\n<!-- jenify-run -->',
        secrets: LOCAL_SECRETS,
      }),
    );
    expect(d.outcome).toBe('IGNORE');
    expect(d.reason).toContain('result comments never re-trigger');
  });

  it('the CLI report begins with the loop-proof Codex marker', () => {
    const cli = readFileSync(new URL('../src/cli/codex-review.ts', import.meta.url), 'utf8');
    expect(cli).toContain('<!-- jenify-codex-result -->');
    expect(PROVIDER_REGISTRY.CODEX.resultMarker).toBe('jenify-codex-result');
  });
});
