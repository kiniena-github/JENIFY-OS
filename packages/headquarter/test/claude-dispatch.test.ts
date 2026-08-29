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
  DISPATCH_HOST,
  classifyExitFailure,
  ghCliTransport,
  parseAuthAccount,
  parseIssueUrl,
  qualifiedTargetSlug,
  targetSlug,
  unavailableTransport,
  type GitHubIssueRequest,
  type GitHubIssueResult,
  type GitHubIssueTransport,
  type GitHubTransportStatus,
} from '../src/providers/claude/transport.js';
import { connectionProbesWithGitHubDispatch, githubDispatchProbe } from '../src/providers/claude/connection.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
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

  it('refuses a repeat that names a different repository, rather than answering with the first', () => {
    // The receipt must describe one publication. Returning repository A's issue
    // while echoing back the caller's repository B is a contradiction, and a
    // silent refusal of an explicit publication target that never says so.
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const first = stubTransport({});
    expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: first }));

    const elsewhere = { owner: TARGET.owner, repo: 'some-other-repo' };
    const second = stubTransport({});
    const result = dispatchClaudeTask(fixture.ops, { taskId, target: elsewhere, transport: second });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('target_mismatch');
    expect(result.error.details?.dispatchedTo).toBe(`${TARGET.owner}/${TARGET.repo}`);
    expect(result.error.details?.requested).toBe(`${TARGET.owner}/some-other-repo`);
    // Nothing was published to the second repository either.
    expect(second.calls).toHaveLength(0);
  });

  it('compares repository identity case-insensitively, as GitHub does', () => {
    // `JENIFY-OS` and `jenify-os` are the same repository; the CLI accepts both.
    // A byte comparison would turn a genuine repeat into a target_mismatch.
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({});
    const first = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport }));

    const otherCasing = { owner: TARGET.owner.toUpperCase(), repo: TARGET.repo.toLowerCase() };
    const again = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: otherCasing, transport }));
    expect(again.deduplicated).toBe(true);
    expect(again.issueUrl).toBe(first.issueUrl);
    // The receipt carries the RECORDED spelling, so it cannot disagree with the
    // issue it points at.
    expect(targetSlug(again.target)).toBe(`${TARGET.owner}/${TARGET.repo}`);
    expect(transport.calls).toHaveLength(1);
  });

  it('answers a repeat for the SAME repository with the recorded issue', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({});
    const first = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport }));
    const again = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: { ...TARGET }, transport }));
    expect(again.deduplicated).toBe(true);
    expect(again.issueUrl).toBe(first.issueUrl);
    expect(targetSlug(again.target)).toBe(`${TARGET.owner}/${TARGET.repo}`);
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

describe('the guards that stop a duplicate public issue (Codex review of 1d5b3bf)', () => {
  it('publishes nothing when the attempt reservation cannot be recorded', () => {
    // A guard that could not be written is a guard that does not exist. If the
    // `attempted` entry is lost, a created issue would be invisible to
    // `dispatchHistory` and the next run would open a second one.
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({});
    const evidence = fixture.ops.queue.evidence as unknown as { append: (entry: unknown) => unknown };
    const realAppend = evidence.append.bind(fixture.ops.queue.evidence);
    evidence.append = (entry: unknown) => {
      if ((entry as { kind: string }).kind === CLAUDE_DISPATCH_EVIDENCE.attempted) {
        throw new Error('database is locked');
      }
      return realAppend(entry);
    };

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('evidence_unavailable');
    expect(transport.calls).toHaveLength(0);
  });

  it('never reports success for an issue it could not record', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const transport = stubTransport({});
    const evidence = fixture.ops.queue.evidence as unknown as { append: (entry: unknown) => unknown };
    const realAppend = evidence.append.bind(fixture.ops.queue.evidence);
    evidence.append = (entry: unknown) => {
      if ((entry as { kind: string }).kind === CLAUDE_DISPATCH_EVIDENCE.succeeded) {
        throw new Error('disk full');
      }
      return realAppend(entry);
    };

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('dispatch_unrecorded');
    // The operator is handed what they need to reconcile it by hand.
    expect(result.error.details?.issueUrl).toContain('/issues/4242');
    // And the attempt is left OPEN, so a retry refuses instead of duplicating.
    evidence.append = realAppend;
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
    const retry = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: stubTransport({}) });
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.error.code).toBe('dispatch_outcome_unknown');
  });

  it('reserves the dispatch atomically, so a concurrent winner is honoured', () => {
    // The race Codex found: two processes both read `none` and both publish.
    // The reservation re-reads inside its own write transaction, so a dispatch
    // that landed after the fast-path check is seen before anything is created.
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const first = stubTransport({});
    const second = stubTransport({});
    // Simulate the interleaving: the other process completes its whole dispatch
    // between this one's fast-path history read and its reservation.
    let raced = false;
    const racingTransport: GitHubIssueTransport & { calls: GitHubIssueRequest[] } = {
      ...second,
      status: () => {
        if (!raced) {
          raced = true;
          expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: first }));
        }
        return second.status();
      },
    };

    const result = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: racingTransport }));
    expect(result.deduplicated).toBe(true);
    expect(first.calls).toHaveLength(1);
    // The loser published nothing.
    expect(second.calls).toHaveLength(0);
  });

  it('treats a transport that throws as outcome-unknown, not as a crash or a clean failure', () => {
    // The transport is an injected interface, so it can throw at any point —
    // including after GitHub accepted the creation.
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const throwing: GitHubIssueTransport = {
      ...stubTransport({}),
      createIssue: () => {
        throw new Error('EROFS: read-only file system');
      },
    };

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: throwing });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('transport_failed');
    expect(result.error.message).toContain('UNKNOWN');
    // The attempt is left open, so the next dispatch refuses rather than
    // risking a duplicate of an issue that may exist.
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
    const retry = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: stubTransport({}) });
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.error.code).toBe('dispatch_outcome_unknown');
  });

  it('re-checks eligibility immediately before publishing, not only at the start', () => {
    // `transport.status()` makes a live call and can take a minute. In that
    // window an approval can expire or the kill switch can be engaged, and
    // publishing on a minute-old answer would put out unauthorised work.
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const inner = stubTransport({});
    const slowTransport: GitHubIssueTransport & { calls: GitHubIssueRequest[] } = {
      ...inner,
      status: () => {
        // Whatever happens during the live check: here, containment.
        expectOk(fixture.ops.engageKillSwitch(DIRECT_ORDER_CAPABILITY.id, 'coo', 'engaged mid-dispatch'));
        return inner.status();
      },
    };

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: slowTransport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('kill_switch_engaged');
    expect(result.error.message).toContain('immediately before publication');
    expect(inner.calls).toHaveLength(0);
    // And no attempt was reserved, so a later legitimate dispatch is a first one.
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
  });

  it('also catches an approval that expires during the transport check', () => {
    const fixture = orderFixture();
    const taskId = placeOrder(fixture);
    const inner = stubTransport({});
    const slowTransport: GitHubIssueTransport & { calls: GitHubIssueRequest[] } = {
      ...inner,
      status: () => {
        // The Founder approval is time-boxed; expire it mid-flight.
        fixture.db
          .prepare(`UPDATE hq_approvals SET expires_at = ? WHERE task_id = ?`)
          .run('2020-01-01T00:00:00.000Z', taskId);
        return inner.status();
      },
    };

    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: slowTransport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('approval_invalid');
    expect(result.error.details?.rejection).toBe('approval_expired');
    expect(inner.calls).toHaveLength(0);
  });

  it('treats a create that was started and then killed as outcome-unknown', () => {
    // `spawnSync` reports ETIMEDOUT after the process ran, so the issue may
    // already exist. Calling that a failure is what licenses a duplicate.
    const transport = ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: () => {
        const error: NodeJS.ErrnoException = new Error('spawnSync gh ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        return { status: null, stdout: '', stderr: '', error };
      },
    });
    const result = transport.createIssue({ target: TARGET, title: 't', body: 'b' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('unreadable_response');
  });

  it('still calls a never-started process unavailable, so that stays retryable', () => {
    const transport = ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: () => {
        const error: NodeJS.ErrnoException = new Error('spawnSync gh ENOENT');
        error.code = 'ENOENT';
        return { status: null, stdout: '', stderr: '', error };
      },
    });
    const result = transport.createIssue({ target: TARGET, title: 't', body: 'b' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('unavailable');
  });

  it('keeps an ambiguous non-zero exit outcome-unknown rather than retryable', () => {
    // GitHub may have accepted the creation and the connection died before `gh`
    // printed the URL. Nothing in that text proves the request never landed.
    expect(classifyExitFailure(1, 'Post "https://api.github.com/...": EOF').kind).toBe('unreadable_response');
    expect(classifyExitFailure(1, 'error connecting to api.github.com: connection reset by peer').kind).toBe(
      'unreadable_response',
    );
    expect(classifyExitFailure(null, '').kind).toBe('unreadable_response');
  });

  it('calls a failure retryable only when the text proves nothing was created', () => {
    expect(classifyExitFailure(1, 'GraphQL: Could not resolve to a Repository with the name').kind).toBe('rejected');
    expect(classifyExitFailure(1, 'HTTP 404: Not Found').kind).toBe('rejected');
    expect(classifyExitFailure(1, 'HTTP 422: Validation Failed').kind).toBe('rejected');
    expect(classifyExitFailure(1, 'unknown flag: --nope').kind).toBe('rejected');
    expect(classifyExitFailure(1, 'You must be authenticated to use this command').kind).toBe('unauthenticated');
    expect(classifyExitFailure(1, 'gh auth login required').kind).toBe('unauthenticated');
  });

  it('treats a non-zero exit that still printed an issue URL as unknown', () => {
    const transport = ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: () => ({
        status: 1,
        stdout: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/7\n`,
        stderr: 'something went wrong afterwards',
      }),
    });
    const result = transport.createIssue({ target: TARGET, title: 't', body: 'b' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('unreadable_response');
  });
});

describe('the transport is pinned to github.com, whatever GH_HOST says', () => {
  it('host-qualifies the repository it creates the issue in', () => {
    const seen: string[][] = [];
    const transport = ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: (_command, args) => {
        seen.push(args);
        return {
          status: 0,
          stdout: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/9\n`,
          stderr: '',
        };
      },
    });
    expect(transport.createIssue({ target: TARGET, title: 't', body: 'b' }).ok).toBe(true);
    const repoArg = seen[0]![seen[0]!.indexOf('--repo') + 1];
    expect(repoArg).toBe(`${DISPATCH_HOST}/${TARGET.owner}/${TARGET.repo}`);
    expect(qualifiedTargetSlug(TARGET)).toBe('github.com/kiniena-github/JENIFY-OS');
  });

  it('asks about the session on that same host', () => {
    const seen: string[][] = [];
    ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: (_command, args) => {
        seen.push(args);
        return { status: 0, stdout: '', stderr: 'Logged in to github.com account kiniena-github (keyring)' };
      },
    }).status();
    expect(seen[0]).toEqual(['auth', 'status', '--hostname', DISPATCH_HOST]);
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

describe('a blocked order survives to be dispatched later (issue #224)', () => {
  /** An order placed while CLAUDE cannot dispatch: created, gated, blocked. */
  function blockedOrder(fixture: Fixture): string {
    const receipt = expectOk(
      submitDirectOrder(
        fixture.ops,
        {
          instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
          project: 'mesob',
          route: 'CLAUDE',
          requestedBy: 'founder',
        },
        // Nothing observed: CLAUDE_ROUTINE_* deliberately absent, exactly the
        // local truth the Founder workstation has.
        {},
      ),
    );
    expect(receipt.dispatchBlocked).toBe(true);
    expect(receipt.boundProvider).toBe('CLAUDE');
    return receipt.task.id;
  }

  it('is the same canonical task that later dispatches — no second task, no substitution', () => {
    const fixture = orderFixture();
    const taskId = blockedOrder(fixture);

    // Approved by the second Founder-authority human, as any other order.
    const task = fixture.ops.queue.get(taskId)!;
    expectOk(
      fixture.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }),
    );

    // The GitHub transport is a different thing from the workflow's routine
    // secrets: it is authenticated on the workstation even while
    // CLAUDE_ROUTINE_* is absent. That is exactly the #224 case.
    const transport = stubTransport({});
    const receipt = expectOk(dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport }));

    expect(receipt.taskId).toBe(taskId);
    expect(receipt.provider).toBe('CLAUDE');
    expect(transport.calls).toHaveLength(1);
    // Exactly one canonical task existed throughout.
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM op_tasks').get()).toMatchObject({ n: 1 });
  });

  it('cannot be dispatched while it is still waiting for approval', () => {
    const fixture = orderFixture();
    const taskId = blockedOrder(fixture);
    const transport = stubTransport({});
    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('task_not_eligible');
    expect(transport.calls).toHaveLength(0);
  });

  it('shows BLOCKED in the browser read model, and stops showing it once the provider connects', () => {
    const fixture = orderFixture();
    const taskId = blockedOrder(fixture);
    const at = '2026-08-29T12:00:00.000Z';

    const blocked = liveSnapshotFromOperations(fixture.ops, { now: at, env: {}, mode: 'live' });
    const card = blocked.operations.data.approvals.find((entry) => entry.taskId === taskId);
    expect(card).toBeDefined();
    expect((card as unknown as Record<string, unknown>).dispatchBlocked).toBe(true);

    // Derived live: the same task, unchanged, once the secrets are configured.
    const connected = liveSnapshotFromOperations(fixture.ops, { now: at, env: CLAUDE_ONLY, mode: 'live' });
    const same = connected.operations.data.approvals.find((entry) => entry.taskId === taskId);
    expect((same as unknown as Record<string, unknown>).dispatchBlocked).toBe(false);

    // And the instruction never reaches the browser, blocked or not.
    expect(JSON.stringify(blocked)).not.toContain('Q3 maintenance plan');
  });
});
