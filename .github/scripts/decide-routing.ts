/**
 * Routing decision entry point for GitHub Actions.
 *
 * The workflows do NOT re-implement routing rules in YAML expressions — they
 * call this script, which delegates to the unit-tested routing module. One
 * tested source of truth, so a rule proven in `packages/headquarter/test/
 * routing.test.ts` is literally the rule that runs in CI.
 *
 * Inputs (env):
 *   EVENT_NAME       issues | issue_comment | workflow_dispatch
 *   EVENT_ACTION     opened | labeled | created | ''
 *   ISSUE_TITLE      full issue title
 *   ISSUE_AUTHOR     login that opened the issue
 *   ACTOR            login that caused this event
 *   ACTOR_TYPE       User | Bot
 *   COMMENT_BODY     body of the triggering comment (issue_comment only)
 *   ISSUE_BODY       body of the issue itself, so an HQ-dispatched issue is
 *                    recognised and cannot be re-triggered from here (#224)
 *   HQ_DISPATCH_EVIDENCE
 *                    durable verdict from the issue's immutable edit history:
 *                    dispatched | never_dispatched | unknown. Anything else,
 *                    including absent, is read as `unknown` and FAILS CLOSED —
 *                    the body marker alone is erasable by the owner (#224)
 *   REPO_OWNER       repository owner login
 *   TARGET_PROVIDER  provider this workflow can execute (CLAUDE | GEMINI | '')
 *   DEDUPE_KEY       stable id for duplicate suppression
 *   HAS_<SECRET>     'true' when that secret is configured (never the value)
 *
 * Outputs (GITHUB_OUTPUT):
 *   outcome           ROUTE | IGNORE | BLOCKED
 *   should_run        'true' only when TARGET_PROVIDER is in dispatchTo
 *   reason            human-readable explanation
 *   requested         comma-separated requested providers
 *   dispatch_to       comma-separated providers that will run
 *   role              MANAGER | BUILDER | REVIEWER | RESEARCHER | '' (never implies a provider)
 *   blocked_report    markdown block for unconnected providers ('' if none)
 *   blocked_marker    stable HTML marker identifying this exact blocked notice
 *   should_report_blocked  'true' only for the ONE workflow that must post it
 */
import { appendFileSync } from 'node:fs';
import {
  decideRouting,
  blockedHeadline,
  parseHqDispatchEvidence,
  PROVIDER_REGISTRY,
  type ProviderId,
  type SecretsEnv,
  type TriggerKind,
} from '../../packages/headquarter/src/routing/index.js';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v == null ? fallback : v;
}

/**
 * Build the secrets view from HAS_* booleans. Actual secret VALUES are never
 * passed to this script — presence is all routing needs, and it keeps
 * credentials out of the process environment entirely.
 */
function secretsFromFlags(): SecretsEnv {
  const out: SecretsEnv = {};
  for (const def of Object.values(PROVIDER_REGISTRY)) {
    for (const secretName of def.requiredSecrets) {
      if (env(`HAS_${secretName}`) === 'true') out[secretName] = 'present';
    }
  }
  return out;
}

function triggerKind(): TriggerKind {
  const name = env('EVENT_NAME');
  const action = env('EVENT_ACTION');
  if (name === 'workflow_dispatch') return 'manual_dispatch';
  if (name === 'issue_comment') return 'issue_comment';
  if (name === 'issues' && action === 'labeled') return 'issue_labeled';
  return 'issue_opened';
}

function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  const line = value.includes('\n')
    ? `${key}<<JENIFY_ROUTING_EOF\n${value}\nJENIFY_ROUTING_EOF\n`
    : `${key}=${value}\n`;
  if (file) appendFileSync(file, line);
  else process.stdout.write(line);
}

const target = env('TARGET_PROVIDER').toUpperCase();

const decision = decideRouting({
  trigger: triggerKind(),
  issueTitle: env('ISSUE_TITLE'),
  actorLogin: env('ACTOR'),
  issueAuthorLogin: env('ISSUE_AUTHOR'),
  repositoryOwner: env('REPO_OWNER'),
  actorIsBot: env('ACTOR_TYPE') === 'Bot' || env('ACTOR').endsWith('[bot]'),
  commentBody: env('COMMENT_BODY'),
  issueBody: env('ISSUE_BODY'),
  // Normalised here rather than trusted: an unset or misspelled value must read
  // as `unknown` (refuse), never as a clean `never_dispatched`.
  hqDispatchEvidence: parseHqDispatchEvidence(process.env.HQ_DISPATCH_EVIDENCE),
  dedupeKey: env('DEDUPE_KEY') || undefined,
  secrets: secretsFromFlags(),
});

const shouldRun =
  target !== '' && decision.outcome === 'ROUTE' && decision.dispatchTo.includes(target as ProviderId);

/**
 * The blocked notice is keyed by WHICH providers are blocked, so the posting
 * workflow can recognise its own earlier notice anywhere in the thread rather
 * than only as the most recent comment.
 */
const blockedReport =
  decision.blocked.length === 0
    ? ''
    : [
        `<!-- jenify-routing-blocked:${decision.blockedReportKey ?? 'unknown'} -->`,
        '## Routing blocked',
        '',
        // Say plainly whether anything ran. A partially-blocked task used to be
        // reported as nothing at all, which read as success.
        decision.dispatchTo.length === 0
          ? '**No worker was started for this task.**'
          : `**${decision.dispatchTo.join(', ')} ${decision.dispatchTo.length === 1 ? 'is doing its' : 'are doing their'} own share of this task. The following requested provider(s) did NOT run, and their share of the task is NOT done:**`,
        '',
        ...decision.blocked.map((b) => `**${blockedHeadline(b.provider)}**\n\n${b.reason}\n`),
        '',
        '_The task was NOT re-routed to a different provider. JENIFY never substitutes one AI for another._',
      ].join('\n');

/**
 * Exactly one workflow posts. Every provider that observes all AI tasks reaches
 * this same decision, so without the owner gate the notice would be posted once
 * per woken workflow.
 */
const shouldReportBlocked =
  target !== '' && decision.blocked.length > 0 && decision.blockedReportOwner === (target as ProviderId);

setOutput('outcome', decision.outcome);
setOutput('should_run', shouldRun ? 'true' : 'false');
setOutput('reason', decision.reason);
setOutput('requested', decision.requestedProviders.join(','));
setOutput('dispatch_to', decision.dispatchTo.join(','));
setOutput('role', decision.role ?? '');
setOutput('blocked_report', blockedReport);
setOutput('blocked_marker', decision.blockedReportKey == null ? '' : `<!-- jenify-routing-blocked:${decision.blockedReportKey} -->`);
setOutput('should_report_blocked', shouldReportBlocked ? 'true' : 'false');

console.log(`[routing] trigger=${triggerKind()} target=${target || '<none>'}`);
console.log(`[routing] hqDispatchEvidence=${parseHqDispatchEvidence(process.env.HQ_DISPATCH_EVIDENCE)}`);
console.log(`[routing] outcome=${decision.outcome} dispatchTo=[${decision.dispatchTo.join(', ')}] shouldRun=${shouldRun}`);
console.log(`[routing] ${decision.reason}`);
