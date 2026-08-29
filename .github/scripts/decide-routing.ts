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
 *   HQ_DISPATCH_PROVENANCE
 *                    REQUIRED. `dispatched` | `not_dispatched` | `unverified`,
 *                    read from the issue's DURABLE label timeline — the record
 *                    an issue-body edit cannot erase (#224, Codex P1 on
 *                    `2dc86e8`). Missing or unrecognised is a hard failure, not
 *                    a default: a caller that forgets to wire it would
 *                    otherwise silently get the pre-fix behaviour, which is the
 *                    exact shape of defect this issue has already produced four
 *                    times. Report a read that failed as `unverified`; never as
 *                    `not_dispatched`.
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
  isHqDispatchProvenance,
  HQ_DISPATCH_PROVENANCE_VALUES,
  PROVIDER_REGISTRY,
  type HqDispatchProvenance,
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

/**
 * The durable HQ-dispatch record, as the calling workflow observed it.
 *
 * REQUIRED, and refused rather than defaulted. `decideRouting` treats an absent
 * value as "this caller did not look", which keeps the pure function composable
 * for unit tests — but a WORKFLOW that did not look is a workflow running the
 * pre-fix guard, and it would do so silently with every test green. Issue #224
 * has produced that exact defect four times (a guard correct where it was wired
 * and absent where it was not), so the wiring is enforced HERE, at the one seam
 * every workflow goes through, instead of being trusted.
 */
function hqDispatchProvenance(): HqDispatchProvenance {
  const raw = env('HQ_DISPATCH_PROVENANCE').trim();
  if (isHqDispatchProvenance(raw)) return raw;
  console.error(
    `[routing] HQ_DISPATCH_PROVENANCE must be one of ${HQ_DISPATCH_PROVENANCE_VALUES.join(' | ')}; got ` +
      `${raw === '' ? '<empty>' : JSON.stringify(raw)}. This is the durable record that decides whether an ` +
      'issue JENIFY HQ dispatched may be re-triggered from GitHub; the editable issue body cannot answer ' +
      'that on its own. Read it from the issue label timeline and report a failed read as `unverified`. ' +
      'No routing decision was made.',
  );
  process.exit(1);
}

const decision = decideRouting({
  hqDispatchProvenance: hqDispatchProvenance(),
  trigger: triggerKind(),
  issueTitle: env('ISSUE_TITLE'),
  actorLogin: env('ACTOR'),
  issueAuthorLogin: env('ISSUE_AUTHOR'),
  repositoryOwner: env('REPO_OWNER'),
  actorIsBot: env('ACTOR_TYPE') === 'Bot' || env('ACTOR').endsWith('[bot]'),
  commentBody: env('COMMENT_BODY'),
  issueBody: env('ISSUE_BODY'),
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

console.log(
  `[routing] trigger=${triggerKind()} target=${target || '<none>'} hqDispatchRecord=${env('HQ_DISPATCH_PROVENANCE').trim()}`,
);
console.log(`[routing] outcome=${decision.outcome} dispatchTo=[${decision.dispatchTo.join(', ')}] shouldRun=${shouldRun}`);
console.log(`[routing] ${decision.reason}`);
