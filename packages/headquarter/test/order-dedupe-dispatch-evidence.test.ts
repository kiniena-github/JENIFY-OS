/**
 * A deduplicated order must honour dispatch evidence (issue #224, Codex P2 on
 * `66d34cc`).
 *
 * ## The defect
 *
 * `submitDirectOrder` derived the reported `dispatchBlocked` from
 * `!route.connected` — a statement about the environment *right now*, which
 * knows nothing about what already happened. A repeat submission deduplicates
 * onto the ORIGINAL task, which may have been dispatched long ago, so an order
 * whose GitHub issue is sitting open was reported BLOCKED the moment the
 * transport went away. The CLI receipt then said, in as many words, that
 * nothing was running.
 *
 * The approvals view and the snapshot already applied the evidence-first rule
 * (`directOrderDispatchBlocked` with `alreadyDispatched`). The submission path
 * was the one surface still disagreeing with the other two about the same task
 * — which is worse than any single wrong answer, because the console and the
 * receipt contradicted each other.
 *
 * ## What is asserted
 *
 * Evidence outranks inference on the submission path too, and only there: a
 * task that was never dispatched is still blocked when its provider is
 * unreachable, so the fix cannot be "report everything as fine".
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import {
  DIRECT_ORDER_CAPABILITY,
  directOrderDispatchBlocked,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';
import { dispatchClaudeTask, dispatchHistory } from '../src/providers/claude/dispatch.js';
import type {
  GitHubIssueRequest,
  GitHubIssueResult,
  GitHubIssueTransport,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';

/** Routing facts present: the order is placeable and reported dispatchable. */
const CLAUDE_ROUTING = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
/** The routing facts have gone away. Nothing about the past has changed. */
const NOTHING = {};

const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' };

const ORDER = {
  instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
  project: 'mesob',
  route: 'CLAUDE' as const,
  requestedBy: 'founder',
};

const AUTHENTICATED: GitHubTransportStatus = {
  available: true,
  authenticated: true,
  account: 'kiniena-github',
  depth: 'live',
  observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
  missingFacts: [],
  reason: 'The GitHub CLI is installed and an authenticated github.com session was observed.',
};

function transport(): GitHubIssueTransport {
  return {
    id: 'stub-gh',
    status: (): GitHubTransportStatus => AUTHENTICATED,
    createIssue: (request: GitHubIssueRequest): GitHubIssueResult => ({
      ok: true,
      issueNumber: 4242,
      issueUrl: `https://github.com/${request.target.owner}/${request.target.repo}/issues/4242`,
    }),
  };
}

function ordersFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  // A second human: the canonical no-self-approval rule refuses the principal
  // that opened the order, and approving is how the order reaches dispatch.
  fixture.principals.register({
    id: 'chair',
    displayName: 'Chair',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  return fixture;
}

/** Place the order, approve it, and actually publish it. Returns the task id. */
function dispatchedOrder(fixture: Fixture): string {
  const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
  if (!placed.ok) throw new Error(`expected the order to be placed: ${placed.error.code}`);
  expect(placed.data.dispatchBlocked).toBe(false);

  const approved = fixture.ops.approveTask({
    taskId: placed.data.task.id,
    founderId: 'chair',
    expectedActionDigest: taskActionDigest(placed.data.task),
  });
  expect(approved.ok).toBe(true);

  const sent = dispatchClaudeTask(fixture.ops, {
    taskId: placed.data.task.id,
    target: TARGET,
    transport: transport(),
  });
  if (!sent.ok) throw new Error(`expected a dispatch: ${sent.error.code}`);
  expect(dispatchHistory(fixture.ops, placed.data.task.id).state).toBe('dispatched');
  return placed.data.task.id;
}

describe('a repeat of an already-dispatched order is not reported BLOCKED', () => {
  it('deduplicates onto the same task and says it is not blocked', () => {
    const fixture = ordersFixture();
    const taskId = dispatchedOrder(fixture);

    // The transport goes away. The issue is still open on GitHub.
    const repeat = submitDirectOrder(fixture.ops, ORDER, NOTHING);
    if (!repeat.ok) throw new Error(`expected ok: ${repeat.error.code}`);

    expect(repeat.data.deduplicated).toBe(true);
    expect(repeat.data.task.id).toBe(taskId);
    // Before the fix this was `true`, because the derivation asked only what
    // the environment looks like now.
    expect(repeat.data.dispatchBlocked).toBe(false);
  });

  it('agrees with the approvals/snapshot derivation about the same task', () => {
    // The real cost of the defect was not one wrong boolean — it was two
    // surfaces contradicting each other about one task.
    const fixture = ordersFixture();
    const taskId = dispatchedOrder(fixture);
    const repeat = submitDirectOrder(fixture.ops, ORDER, NOTHING);
    if (!repeat.ok) throw new Error('expected ok');

    const consoleAnswer = directOrderDispatchBlocked(fixture.ops.queue.get(taskId)!, NOTHING, {
      alreadyDispatched: dispatchHistory(fixture.ops, taskId).state === 'dispatched',
    });
    expect(repeat.data.dispatchBlocked).toBe(consoleAnswer);
    expect(consoleAnswer).toBe(false);
  });

  it('still reports the route honestly — nothing claims the provider is reachable', () => {
    const fixture = ordersFixture();
    dispatchedOrder(fixture);
    const repeat = submitDirectOrder(fixture.ops, ORDER, NOTHING);
    if (!repeat.ok) throw new Error('expected ok');
    // `dispatchBlocked: false` says "this order already went"; it must not be
    // read as "CLAUDE is connected". The route resolution is unchanged.
    expect(repeat.data.route.connected).toBe(false);
    expect(repeat.data.route.resolved).toBeNull();
    expect(repeat.data.boundProvider).toBe('CLAUDE');
  });
});

describe('the fix does not turn every blocked order into a clear one', () => {
  it('still reports a never-dispatched order as blocked', () => {
    const fixture = ordersFixture();
    const placed = submitDirectOrder(fixture.ops, ORDER, NOTHING);
    if (!placed.ok) throw new Error('expected ok');
    expect(dispatchHistory(fixture.ops, placed.data.task.id).state).toBe('none');
    expect(placed.data.dispatchBlocked).toBe(true);
  });

  it('still reports a repeat of a never-dispatched blocked order as blocked', () => {
    const fixture = ordersFixture();
    const first = submitDirectOrder(fixture.ops, ORDER, NOTHING);
    const again = submitDirectOrder(fixture.ops, ORDER, NOTHING);
    if (!first.ok || !again.ok) throw new Error('expected both to succeed');
    expect(again.data.deduplicated).toBe(true);
    expect(again.data.dispatchBlocked).toBe(true);
  });

  it('does not treat an unresolved dispatch ATTEMPT as a dispatch', () => {
    // An attempt whose outcome HQ never learned is `unknown`, not `dispatched`.
    // Reading it as evidence of publication would report an order as fine on
    // the strength of having tried — the exact inversion of this lane's rule.
    const fixture = ordersFixture();
    const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
    if (!placed.ok) throw new Error('expected ok');
    fixture.ops.approveTask({
      taskId: placed.data.task.id,
      founderId: 'chair',
      expectedActionDigest: taskActionDigest(placed.data.task),
    });
    const throwing: GitHubIssueTransport = {
      id: 'stub-gh',
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => {
        throw new Error('killed mid-flight');
      },
    };
    expect(
      dispatchClaudeTask(fixture.ops, { taskId: placed.data.task.id, target: TARGET, transport: throwing }).ok,
    ).toBe(false);
    expect(dispatchHistory(fixture.ops, placed.data.task.id).state).toBe('unknown');

    const repeat = submitDirectOrder(fixture.ops, ORDER, NOTHING);
    if (!repeat.ok) throw new Error('expected ok');
    expect(repeat.data.deduplicated).toBe(true);
    // Not dispatched as far as HQ can prove, so still blocked.
    expect(repeat.data.dispatchBlocked).toBe(true);
  });
});
