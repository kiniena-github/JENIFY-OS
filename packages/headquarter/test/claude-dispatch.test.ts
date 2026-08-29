/**
 * CLAUDE GitHub dispatch adapter (issue #221, correction to #200).
 *
 * Each property the correction claims, proved against the canonical control
 * plane rather than a mock of it:
 *
 *   canonical first          nothing dispatches that HQ has not already cleared
 *   fail closed              no transport / no auth / wrong account → refused,
 *                            and NOTHING is created task-side
 *   no substitution          a CODEX-bound task is never sent down this lane
 *   idempotent dispatch      a repeat returns the same issue; an uncertain
 *                            attempt refuses instead of retrying
 *   correlation              a result reconciles to its canonical task, and a
 *                            malformed or foreign one does not
 *   no secrets               nothing published, and nothing recorded, carries one
 *   workflow contract        the rendered title is what ai-task-trigger.yml routes
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, expectOk, type Fixture } from './application.fixture.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability, submitDirectOrder } from '../src/live/orders.js';
import { decideRouting, parseTaskTitle } from '../src/routing/route.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import {
  CLAUDE_DISPATCH_EVIDENCE,
  DISPATCH_MARKER,
  claudeDispatchEligibility,
  correlateClaudeResult,
  dispatchClaudeTask,
  dispatchHistory,
  parseDispatchCorrelation,
  renderDispatchIssue,
  resolveUnknownDispatch,
  sanitizeIssueTitleText,
} from '../src/providers/claude/dispatch.js';
import {
  ghCliTransport,
  parseAuthAccount,
  parseIssueUrl,
  unavailableTransport,
  type GitHubIssueRequest,
  type GitHubIssueResult,
  type GitHubIssueTransport,
  type GitHubTransportStatus,
} from '../src/providers/claude/transport.js';
import { connectionProbesWithGitHubDispatch, githubDispatchProbe } from '../src/providers/claude/connection.js';
import { CONNECTION_CATALOG, assessConnections } from '../src/live/connections.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const CODEX_ONLY = { CODEX_CLI_PATH: '/usr/local/bin/codex', CODEX_AUTH_MODE: 'chatgpt' };

const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' } as const;

/** A transport that records what it was asked to do and answers as configured. */
function stubTransport(options: {
  status?: Partial<GitHubTransportStatus>;
  result?: GitHubIssueResult;
}): GitHubIssueTransport & { calls: GitHubIssueRequest[] } {
  const calls: GitHubIssueRequest[] = [];
  return {
    id: 'stub',
    calls,
    status: () => ({
      available: true,
      authenticated: true,
      account: TARGET.owner,
      depth: 'live',
      observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
      missingFacts: [],
      reason: 'stub transport',
      ...options.status,
    }),
    createIssue: (request) => {
      calls.push(request);
      return options.result ?? { ok: true, issueNumber: 4242, issueUrl: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/4242` };
    },
  };
}

function orderFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return fixture;
}

/** An order routed to `route`, optionally approved by the second Founder-authority human. */
function placeOrder(
  fixture: Fixture,
  options: { route?: 'CLAUDE' | 'CODEX'; approve?: boolean; title?: string; instruction?: string } = {},
): string {
  const route = options.route ?? 'CLAUDE';
  const receipt = expectOk(
    submitDirectOrder(
      fixture.ops,
      {
        instruction: options.instruction ?? 'Draft the Q3 maintenance plan for the Mesob line.',
        project: 'mesob',
        title: options.title,
        route,
        requestedBy: 'founder',
      },
      route === 'CLAUDE' ? CLAUDE_ONLY : CODEX_ONLY,
    ),
  );
  const taskId = receipt.task.id;
  if (options.approve !== false) {
    // The canonical no-self-approval rule: the principal who opened it may not
    // approve it, so a second approval-authorized human decides.
    const task = fixture.ops.queue.get(taskId)!;
    expectOk(
      fixture.ops.approveTask({
        taskId,
        founderId: 'coo',
        expectedActionDigest: taskActionDigest(task),
      }),
    );
  }
  return taskId;
}

describe('nothing dispatches that the canonical control plane has not cleared', () => {
  it('refuses an order that is still waiting for a Founder approval', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture, { approve: false });
    expect(fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');

    const transport = stubTransport({});
    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('task_not_eligible');
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses when the approval no longer binds the current action', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    // Mutate the payload behind the approval's back — the same attack the
    // execution boundary re-validates against.
    fixture.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ ...fixture.ops.queue.get(taskId)!.payload, instruction: 'something else' }), taskId);

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: stubTransport({}) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('approval_invalid');
    expect(result.error.details?.rejection).toBe('approval_digest_mismatch');
  });

  it('refuses while the kill switch is engaged', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    expectOk(fixture.ops.engageKillSwitch(DIRECT_ORDER_CAPABILITY.id, 'coo', 'containment drill'));

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: stubTransport({}) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('kill_switch_engaged');
  });

  it('refuses an unknown task rather than inventing one', () => {
    const fixture = orderFixture();
    const result = dispatchClaudeTask(fixture.ops, { taskId: 'no-such-task', target: TARGET, transport: stubTransport({}) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unknown_task');
  });

  it('dispatches an approved, CLAUDE-bound order', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({});

    const receipt = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport }));
    expect(receipt.provider).toBe('CLAUDE');
    expect(receipt.issueNumber).toBe(4242);
    expect(receipt.deduplicated).toBe(false);
    expect(transport.calls).toHaveLength(1);

    // The canonical task is untouched: dispatch reports work out, it does not
    // execute, claim, review or complete anything.
    const task = fixture.ops.queue.get(taskId)!;
    expect(task.status).toBe('queued');
    expect(task.claimedBy).toBeNull();
    expect(task.reviewState).toBe('none');
  });
});

describe('no provider substitution', () => {
  it('refuses a CODEX-bound task outright', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture, { route: 'CODEX' });
    const transport = stubTransport({});

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_mismatch');
    expect(result.error.details?.requiredProvider).toBe('CODEX');
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses a task that declares no execution provider at all', () => {
    const fixture = orderFixture();
    const created = expectOk(
      fixture.ops.createTask({
        capabilityId: DIRECT_ORDER_CAPABILITY.id,
        payload: { kind: 'direct_order', instruction: 'unbound work' },
        idempotencyKey: 'unbound-1',
        requestedBy: 'founder',
      }),
    );
    const task = fixture.ops.queue.get(created.task.id)!;
    expectOk(
      fixture.ops.approveTask({ taskId: task.id, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }),
    );

    const result = dispatchClaudeTask(fixture.ops, { taskId: task.id, target: TARGET, transport: stubTransport({}) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_not_bound');
  });
});

describe('an unavailable transport fails closed', () => {
  it('refuses when no transport exists here, and creates no task-side success', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);

    const result = dispatchClaudeTask(fixture.ops, {
      taskId,
      target: TARGET,
      transport: unavailableTransport('No GitHub CLI on this machine.'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('transport_unavailable');
    expect(result.error.message).toContain('SETUP REQUIRED');

    // Nothing was recorded as dispatched, so a later dispatch is a first one.
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
    const kinds = fixture.ops.queue.evidence.list(taskId).map((entry) => entry.kind);
    expect(kinds).toContain(CLAUDE_DISPATCH_EVIDENCE.refused);
    expect(kinds).not.toContain(CLAUDE_DISPATCH_EVIDENCE.succeeded);
  });

  it('refuses an unauthenticated session', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({
      status: { authenticated: false, account: null, reason: 'no logged-in account' },
    });

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('transport_unauthenticated');
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses when the session belongs to somebody who is not the repository owner', () => {
    // The workflow only routes AI tasks OPENED BY THE OWNER, so an issue opened
    // as anyone else is a public artefact no worker will ever run.
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({ status: { account: 'somebody-else' } });

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('transport_actor_mismatch');
    expect(transport.calls).toHaveLength(0);
  });

  it('records a rejected creation as a failure, leaving a retry legitimate', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const failing = stubTransport({ result: { ok: false, kind: 'rejected', message: 'HTTP 403' } });

    const first = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: failing });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('unreachable');
    expect(first.error.code).toBe('transport_failed');
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');

    // A failure that is KNOWN to have created nothing may be retried.
    const working = stubTransport({});
    const receipt = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: working }));
    expect(receipt.deduplicated).toBe(false);
    expect(working.calls).toHaveLength(1);
  });

  it('refuses an explicit-target-less dispatch', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const result = dispatchClaudeTask(fixture.ops, {
      taskId,
      target: { owner: 'not a login', repo: '' },
      transport: stubTransport({}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invalid_target');
  });
});

describe('dispatch is idempotent, and an uncertain outcome is never blindly retried', () => {
  it('returns the same issue instead of opening a second one', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({});

    const first = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport }));
    const second = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport }));

    expect(second.deduplicated).toBe(true);
    expect(second.issueNumber).toBe(first.issueNumber);
    expect(transport.calls).toHaveLength(1);
  });

  it('refuses after an attempt whose outcome was never learned', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const unreadable = stubTransport({
      result: { ok: false, kind: 'unreadable_response', message: 'no issue URL printed' },
    });

    const first = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: unreadable });
    expect(first.ok).toBe(false);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');

    const retry = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: stubTransport({}) });
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.error.code).toBe('dispatch_outcome_unknown');
  });

  it('reconciles an uncertain attempt in both directions, explicitly', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const unreadable = stubTransport({
      result: { ok: false, kind: 'unreadable_response', message: 'no issue URL printed' },
    });
    dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: unreadable });

    // Somebody looked and found nothing: a fresh dispatch is a first dispatch.
    const cleared = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'coo',
    });
    expect(cleared.ok).toBe(false);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');

    // And the other direction, on a second uncertain attempt: the found issue
    // becomes the recorded dispatch, so later calls deduplicate onto it.
    dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: unreadable });
    const found = expectOk(
      resolveUnknownDispatch(fixture.ops, {
        taskId,
        outcome: 'found',
        target: TARGET,
        issueNumber: 99,
        issueUrl: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/99`,
        resolvedBy: 'coo',
      }),
    );
    expect(found.issueNumber).toBe(99);
    const again = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: stubTransport({}) }));
    expect(again.deduplicated).toBe(true);
    expect(again.issueNumber).toBe(99);
  });
});

describe('the rendered issue is the contract ai-task-trigger.yml actually routes', () => {
  it('parses to CLAUDE with a role and no unknown tags', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture, { title: 'Maintenance plan' });
    const task = fixture.ops.queue.get(taskId)!;

    const issue = renderDispatchIssue({
      task,
      title: 'Maintenance plan',
      project: 'mesob',
      target: TARGET,
      role: 'BUILDER',
      dispatchedAt: '2026-08-29T12:00:00.000Z',
    });

    const parsed = parseTaskTitle(issue.title);
    expect(parsed.isAiTask).toBe(true);
    expect(parsed.requestedProviders).toEqual(['CLAUDE']);
    expect(parsed.role).toBe('BUILDER');
    expect(parsed.unknownTags).toEqual([]);

    // And the routing module itself would dispatch it, given the owner opened it.
    const decision = decideRouting({
      trigger: 'issue_opened',
      issueTitle: issue.title,
      actorLogin: TARGET.owner,
      issueAuthorLogin: TARGET.owner,
      repositoryOwner: TARGET.owner,
      secrets: CLAUDE_ONLY,
    });
    expect(decision.outcome).toBe('ROUTE');
    expect(decision.dispatchTo).toEqual(['CLAUDE']);
  });

  it('never lets a Founder title become a routing tag', () => {
    // `[URGENT] ship it` would otherwise parse as an unknown routing tag and
    // block the whole task at the far end, for a reason unrelated to routing.
    expect(sanitizeIssueTitleText('[URGENT] ship it')).toBe('(URGENT) ship it');
    const fixture = orderFixture();
    const taskId = placeOrder(fixture, { title: '[URGENT] ship it' });
    const task = fixture.ops.queue.get(taskId)!;
    const issue = renderDispatchIssue({
      task,
      title: '[URGENT] ship it',
      project: null,
      target: TARGET,
      role: 'BUILDER',
      dispatchedAt: '2026-08-29T12:00:00.000Z',
    });
    expect(parseTaskTitle(issue.title).unknownTags).toEqual([]);
  });

  it('carries a correlation block that reads back to the canonical task', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const task = fixture.ops.queue.get(taskId)!;
    const issue = renderDispatchIssue({
      task,
      title: null,
      project: null,
      target: TARGET,
      role: 'BUILDER',
      dispatchedAt: '2026-08-29T12:00:00.000Z',
    });

    const correlation = parseDispatchCorrelation(issue.body);
    expect(correlation?.hqTaskId).toBe(taskId);
    expect(correlation?.executionProvider).toBe('CLAUDE');
    expect(correlation?.actionDigest).toBe(taskActionDigest(task));
    expect(issue.body).toContain(DISPATCH_MARKER);
  });

  it('reads nothing back out of a body without a readable block', () => {
    expect(parseDispatchCorrelation(null)).toBeNull();
    expect(parseDispatchCorrelation('no marker here')).toBeNull();
    expect(parseDispatchCorrelation(`<!-- ${DISPATCH_MARKER}: x -->\n\`\`\`json\nnot json\n\`\`\``)).toBeNull();
    expect(
      parseDispatchCorrelation(`<!-- ${DISPATCH_MARKER}: x -->\n\`\`\`json\n{"marker":"other","hqTaskId":"x"}\n\`\`\``),
    ).toBeNull();
  });
});

describe('a result correlates back to its canonical task, or is refused', () => {
  function dispatched(): { fixture: Fixture; taskId: string; body: string } {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({});
    expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport }));
    return { fixture, taskId, body: transport.calls[0]!.body };
  }

  it('records the correlation on the canonical task without completing it', () => {
    const { fixture, taskId, body } = dispatched();
    const receipt = expectOk(
      correlateClaudeResult(fixture.ops, {
        target: TARGET,
        issueNumber: 4242,
        reportedProvider: 'CLAUDE',
        issueBody: body,
        attestedModel: 'attested-by-the-worker',
        reportUrl: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/4242#issuecomment-1`,
      }),
    );
    expect(receipt.taskId).toBe(taskId);

    const correlated = fixture.ops.queue.evidence
      .list(taskId)
      .filter((entry) => entry.kind === CLAUDE_DISPATCH_EVIDENCE.correlated);
    expect(correlated).toHaveLength(1);
    expect(correlated[0]!.payload['attestedModel']).toBe('attested-by-the-worker');
    // A report is not a review: the task is still exactly where it was.
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('refuses a result reported by another provider', () => {
    const { fixture, body } = dispatched();
    const result = correlateClaudeResult(fixture.ops, {
      target: TARGET,
      issueNumber: 4242,
      reportedProvider: 'CODEX',
      issueBody: body,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_mismatch');
  });

  it('refuses an issue HQ never dispatched', () => {
    const { fixture, body } = dispatched();
    const result = correlateClaudeResult(fixture.ops, {
      target: TARGET,
      issueNumber: 777,
      reportedProvider: 'CLAUDE',
      issueBody: body,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unknown_dispatch');
  });

  it('refuses a body whose correlation block names a different task', () => {
    const { fixture } = dispatched();
    const foreign = [
      `<!-- ${DISPATCH_MARKER}: other -->`,
      '```json',
      JSON.stringify({ marker: DISPATCH_MARKER, hqTaskId: 'some-other-task' }),
      '```',
    ].join('\n');
    const result = correlateClaudeResult(fixture.ops, {
      target: TARGET,
      issueNumber: 4242,
      reportedProvider: 'CLAUDE',
      issueBody: foreign,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('malformed_correlation');
  });

  it('refuses an unreadable correlation block rather than attaching on the issue number alone', () => {
    const { fixture } = dispatched();
    const result = correlateClaudeResult(fixture.ops, {
      target: TARGET,
      issueNumber: 4242,
      reportedProvider: 'CLAUDE',
      issueBody: 'a comment somebody edited the body into',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('malformed_correlation');
  });
});

describe('no secret ever reaches the published issue or the evidence log', () => {
  it('refuses to publish an issue that looks like it carries a credential', () => {
    const fixture = orderFixture();
    // `submitDirectOrder` already refuses obvious credentials, so the payload is
    // written past it to prove the DISPATCH boundary refuses independently.
    const created = expectOk(
      fixture.ops.createTask({
        capabilityId: DIRECT_ORDER_CAPABILITY.id,
        payload: {
          kind: 'direct_order',
          instruction: 'deploy using api_key: "AKIA1234567890ABCDEF"',
          executionProvider: 'CLAUDE',
        },
        idempotencyKey: 'leaky-1',
        requestedBy: 'founder',
      }),
    );
    const task = fixture.ops.queue.get(created.task.id)!;
    expectOk(
      fixture.ops.approveTask({ taskId: task.id, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }),
    );

    const transport = stubTransport({});
    const result = dispatchClaudeTask(fixture.ops, { taskId: task.id, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unsafe_issue');
    expect(transport.calls).toHaveLength(0);
  });

  it('keeps the evidence chain intact across a dispatch', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: stubTransport({}) }));
    expect(fixture.ops.queue.evidence.verifyChain()).toBeNull();
  });
});

describe('Connection Center reports the strongest truthful observed state', () => {
  const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'github')!;
  const now = '2026-08-29T12:00:00.000Z';

  function assess(transport: GitHubIssueTransport) {
    const probes = [githubDispatchProbe(descriptor, transport)];
    return assessConnections({}, { catalog: [descriptor], probes, now })[0]!;
  }

  it('reports NOT CONNECTED when no transport mechanism exists', () => {
    const status = assess(unavailableTransport('no gh here'));
    expect(status.state).toBe('not_connected');
    expect(status.effectiveCapabilities).toEqual([]);
    expect(status.lastVerifiedAt).toBeNull();
  });

  it('reports CONFIGURED — never connected — for a binary nobody has asked anything of', () => {
    const status = assess(
      stubTransport({ status: { depth: 'local', authenticated: false, account: null, reason: 'binary found' } }),
    );
    expect(status.state).toBe('configured');
    expect(status.verification).toBe('configuration');
    expect(status.effectiveCapabilities).toEqual([]);
  });

  it('reports SETUP REQUIRED when a live check ran and found no session', () => {
    const status = assess(
      stubTransport({ status: { authenticated: false, account: null, reason: 'not logged in' } }),
    );
    expect(status.state).toBe('setup_required');
    expect(status.lastVerifiedAt).toBeNull();
  });

  it('leaves every other catalogue row exactly as it was', () => {
    // Wiring a transport answers the GitHub row and touches nothing else: the AI
    // provider rows still top out at `dispatchable` on routing evidence alone.
    const probes = connectionProbesWithGitHubDispatch(stubTransport({}));
    const statuses = assessConnections(
      { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' },
      { probes, now },
    );
    const byId = new Map(statuses.map((entry) => [entry.id, entry]));
    expect(byId.get('github')!.state).toBe('connected');
    expect(byId.get('anthropic-claude')!.state).toBe('dispatchable');
    expect(byId.get('anthropic-claude')!.effectiveCapabilities).toEqual([]);
    expect(byId.get('supabase')!.state).toBe('not_connected');
  });

  it('reports CONNECTED only for a live check that succeeded — and grants nothing from it', () => {
    const status = assess(stubTransport({}));
    expect(status.state).toBe('connected');
    expect(status.verification).toBe('live_check');
    expect(status.outcome).toBe('verified');
    expect(status.lastVerifiedAt).toBe(now);
    // An authenticated identity is not repository permission.
    expect(status.effectiveCapabilities).toEqual([]);
  });
});

describe('the gh transport reads what gh actually prints', () => {
  it('recognises both account line shapes and no line at all', () => {
    expect(parseAuthAccount('✓ Logged in to github.com account kiniena-github (keyring)')).toBe('kiniena-github');
    expect(parseAuthAccount('✓ Logged in to github.com as kiniena-github (oauth_token)')).toBe('kiniena-github');
    expect(parseAuthAccount('You are not logged into any GitHub hosts.')).toBeNull();
  });

  it('takes an issue number only from a URL for the repository it asked about', () => {
    expect(parseIssueUrl('https://github.com/kiniena-github/JENIFY-OS/issues/12', TARGET)).toEqual({
      url: 'https://github.com/kiniena-github/JENIFY-OS/issues/12',
      number: 12,
    });
    expect(parseIssueUrl('https://github.com/someone/else/issues/12', TARGET)).toBeNull();
    expect(parseIssueUrl('created successfully', TARGET)).toBeNull();
  });

  it('reports NOT CONNECTED when the gh binary cannot be run at all', () => {
    const transport = ghCliTransport({
      ghPath: '/nonexistent/gh',
      spawnImpl: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
    });
    const status = transport.status();
    expect(status.available).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.missingFacts).toContain('GH_AUTH_ACCOUNT');
  });

  it('never claims a session when gh reports none', () => {
    const transport = ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: () => ({ status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }),
    });
    const status = transport.status();
    expect(status.available).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.depth).toBe('live');
  });

  it('reports an authenticated session with the account it observed', () => {
    const transport = ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: () => ({
        status: 0,
        stdout: '',
        stderr: 'github.com\n  ✓ Logged in to github.com account kiniena-github (keyring)\n',
      }),
    });
    const status = transport.status();
    expect(status.authenticated).toBe(true);
    expect(status.account).toBe('kiniena-github');
    expect(status.observedFacts).toEqual(['GH_CLI_PATH', 'GH_AUTH_ACCOUNT']);
  });
});

describe('eligibility is readable on its own, for a check that publishes nothing', () => {
  it('explains why an unapproved task is not eligible without touching a transport', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture, { approve: false });
    const verdict = claudeDispatchEligibility(fixture.ops, taskId);
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.code).toBe('task_not_eligible');
    expect(verdict.message).toContain('needs_approval');
  });
});
