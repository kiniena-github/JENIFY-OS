/**
 * JENIFY Codex reviewer entry point (local lane).
 *
 * This is the `executor` declared for CODEX in the provider registry. It runs
 * on the Founder workstation, because that is where the Codex CLI session
 * lives — GitHub-hosted runners have no Codex credential, and routing fails
 * closed for CODEX there by design.
 *
 * Usage:
 *   npm -w @factoryos/headquarter run codex:review -- --sha <SHA> [options]
 *
 *   --sha <SHA>          exact commit to review (required)
 *   --repo <DIR>         checkout to review (default: cwd)
 *   --base <REF>         diff base (default: origin/main)
 *   --pr <N>             pull request number, for the report header
 *   --issue <N>          task issue number, for the report header
 *   --role <ROLE>        role being performed (default: REVIEWER)
 *   --out <FILE>         write the markdown report here (default: stdout only)
 *   --instructions <T>   extra reviewer instructions
 *   --effort <LEVEL>     reasoning effort (default: medium — this is the FAST lane)
 *   --timeout <SECONDS>  give up after this long (default: 900)
 *   --probe-only         report Codex connectivity and exit
 *
 * Exit codes:
 *   0  review completed, verdict PASS
 *   1  execution/verification failure (BLOCKED — nothing is attributed to Codex)
 *   2  review completed, verdict BLOCK
 */

import { writeFileSync } from 'node:fs';

import { DEFAULT_ROLE_ASSIGNMENTS, applyAssignmentOverrides, parseRole, providerConnectivity, renderAssignments } from '../routing/index.js';
import { probeCodex } from '../providers/codex/probe.js';
import { renderCodexProvenance } from '../providers/codex/evidence.js';
import { renderReview } from '../providers/codex/review.js';
import { runCodexReview } from '../providers/codex/run.js';
import type { CodexReviewRequest } from '../providers/codex/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const probe = probeCodex();

if (flag('probe-only')) {
  const conn = providerConnectivity('CODEX', probe.facts);
  console.log('CODEX connectivity');
  console.log(`  installed:     ${probe.installed}`);
  console.log(`  cli path:      ${probe.cliPath ?? '<none>'}`);
  console.log(`  auth mode:     ${probe.authMode ?? '<none>'}`);
  console.log(`  authenticated: ${probe.authenticated}`);
  console.log(`  connected:     ${conn.connected}`);
  console.log(`  reason:        ${conn.reason}`);
  console.log('');
  const { assignments, rejected } = applyAssignmentOverrides(DEFAULT_ROLE_ASSIGNMENTS, process.env);
  console.log('Current ROLE -> PROVIDER staffing');
  console.log(renderAssignments(assignments));
  for (const r of rejected) console.error(`  rejected override for ${r.role}: ${r.reason}`);
  process.exit(conn.connected ? 0 : 1);
}

const sha = arg('sha');
if (sha == null || sha.trim() === '') {
  console.error('ROUTING BLOCKED — no target SHA. A review must name the exact commit it reviews.');
  console.error('Usage: npm -w @factoryos/headquarter run codex:review -- --sha <SHA> [--repo DIR] [--base REF]');
  process.exit(1);
}

const request: CodexReviewRequest = {
  requestedProvider: 'CODEX',
  role: parseRole(arg('role')) ?? 'REVIEWER',
  repoDir: arg('repo') ?? process.cwd(),
  targetSha: sha.trim(),
  baseRef: arg('base') ?? 'origin/main',
  pullRequest: arg('pr') == null ? null : Number(arg('pr')),
  issueNumber: arg('issue') == null ? null : Number(arg('issue')),
  extraInstructions: arg('instructions') ?? null,
};

console.error(`[codex] ${probe.reason}`);
console.error(`[codex] reviewing ${request.targetSha} in ${request.repoDir} against ${request.baseRef} ...`);

const timeoutSec = Number(arg('timeout') ?? 900);
const outcome = runCodexReview(request, {
  probe,
  reasoningEffort: arg('effort') ?? 'medium',
  timeoutMs: (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 900) * 1000,
});

const provenance = renderCodexProvenance({
  requestedProvider: request.requestedProvider,
  actualProvider: outcome.actualProvider,
  role: request.role,
  issueNumber: request.issueNumber,
  pullRequest: request.pullRequest,
  requestedSha: request.targetSha,
  evidence: outcome.evidence,
  status: outcome.ok ? `completed (${outcome.review?.verdict})` : `blocked (${outcome.failure?.kind})`,
  timestamp: outcome.timestamp,
  executor: 'packages/headquarter/src/cli/codex-review.ts',
});

const report = [
  '<!-- jenify-codex-result -->',
  '## Codex Independent Review',
  '',
  outcome.ok && outcome.review != null
    ? renderReview(outcome.review)
    : [
        '**ROUTING BLOCKED — no Codex review was produced.**',
        '',
        outcome.failure?.message ?? 'Unknown failure.',
        '',
        '_No other provider was substituted. JENIFY never satisfies a CODEX request with a different AI._',
      ].join('\n'),
  '',
  '### Provenance',
  '',
  provenance,
].join('\n');

const outFile = arg('out');
if (outFile != null && outFile.trim() !== '') {
  writeFileSync(outFile, `${report}\n`, 'utf8');
  console.error(`[codex] report written to ${outFile}`);
}

console.log(report);

if (!outcome.ok) process.exit(1);
process.exit(outcome.review?.verdict === 'BLOCK' ? 2 : 0);
