/**
 * Releasing a handoff claim is all-or-nothing, and never silent (issue #224,
 * ChatGPT P2 on `83e146b`).
 *
 * ## The defect
 *
 * `OperatorQueue.releaseClaim` did four things in sequence — check the fence,
 * append `claim_released`, transition to `needs_approval`, clear the claim
 * fields — with no transaction around them. A failure between any two left the
 * task in a state none of the documentation describes: released in the log but
 * still claimed, or moved to `needs_approval` while `claimed_by` still named a
 * worker and a lease was still running.
 *
 * `releaseHandoffClaim` then swallowed the error entirely, so the caller was
 * told only that the transport failed. Nothing anywhere said the canonical task
 * had been left claimed by a worker that will never run it — and the next
 * dispatch would refuse without explaining why.
 *
 * ## What is asserted
 *
 * On a failure at ANY step of the release, the task is left EXACTLY as it was
 * before the release was attempted (fully claimed), never half-released; and
 * the refusal says so rather than reporting a clean nothing-was-published.
 */

import { describe, expect, it, vi } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability, submitDirectOrder } from '../src/live/orders.js';
import { dispatchClaudeTask } from '../src/providers/claude/dispatch.js';
import type {
  GitHubIssueResult,
  GitHubIssueTransport,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';

const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' };
const EXECUTOR = 'claude-executor';
const CLAUDE_ROUTING = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

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

/**
 * A CLEAN failure: the process never started, so nothing was created. That is
 * the outcome that releases the claim — an UNCERTAIN one deliberately does not.
 */
const NOTHING_PUBLISHED: GitHubIssueTransport = {
  id: 'stub-gh',
  status: (): GitHubTransportStatus => AUTHENTICATED,
  createIssue: (): GitHubIssueResult => ({
    ok: false,
    kind: 'unavailable',
    message: 'No GitHub CLI (`gh`) is available here.',
  }),
};

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
  fixture.principals.register({
    id: 'chair',
    displayName: 'Chair',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  const registered = fixture.ops.registerExecutionWorker({
    workerId: EXECUTOR,
    displayName: 'Claude GitHub workflow',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    founderId: 'chair',
  });
  if (!registered.ok) throw new Error(`expected registration: ${registered.error.code}`);
  fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CLAUDE', founderId: 'chair' });
  return fixture;
}

/** An approved, CLAUDE-bound order ready to be dispatched. */
function approvedOrder(fixture: Fixture): string {
  const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
  if (!placed.ok) throw new Error(`expected the order to be placed: ${placed.error.code}`);
  const approved = fixture.ops.approveTask({
    taskId: placed.data.task.id,
    founderId: 'chair',
    expectedActionDigest: taskActionDigest(placed.data.task),
  });
  expect(approved.ok).toBe(true);
  return placed.data.task.id;
}

/** Everything about a task's claim that a release is supposed to change. */
function claimState(fixture: Fixture, taskId: string) {
  const task = fixture.ops.queue.get(taskId);
  if (!task) throw new Error(`task ${taskId} vanished`);
  return {
    status: task.status,
    claimedBy: task.claimedBy,
    fence: task.fence,
    leased: task.leaseExpiresAt != null,
  };
}

function releaseEntries(fixture: Fixture, taskId: string): number {
  return fixture.ops.queue.evidence.list(taskId).filter((e) => e.kind === 'claim_released').length;
}

/**
 * Break the RELEASE's transition and nothing else.
 *
 * The dispatch takes the claim and starts the execution in one transaction
 * before publishing (issue #224), and `start` transitions too — so failing
 * every transition refuses the dispatch before a release is ever attempted,
 * which is a different (and already tested) property. The release is the only
 * transition to `needs_approval` in this flow.
 */
function failReleaseTransition(fixture: Fixture) {
  return vi
    .spyOn(fixture.ops.queue as unknown as { transition: (...a: unknown[]) => unknown }, 'transition')
    .mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args[1] === 'needs_approval') throw new Error('disk full');
      const real = Object.getPrototypeOf(fixture.ops.queue) as {
        transition: (...a: unknown[]) => unknown;
      };
      return real.transition.apply(fixture.ops.queue, args);
    });
}

describe('a release that fails leaves the claim wholly intact', () => {
  it('rolls back the evidence append when the transition fails', () => {
    const fixture = ordersFixture();
    const taskId = approvedOrder(fixture);

    // Fail the step AFTER the evidence append. Without the transaction the
    // `claim_released` entry survives, so the log says the claim was released
    // while the task is still claimed — the log lying about the queue.
    //
    // Only the RELEASE's transition is broken. The dispatch now starts the
    // execution inside the reservation, before publishing (issue #224), so a
    // blanket `transition` failure would refuse the dispatch there and this
    // scenario would never be reached.
    const transition = failReleaseTransition(fixture);

    const result = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: NOTHING_PUBLISHED,
    });
    transition.mockRestore();

    expect(result.ok).toBe(false);
    // The claim is untouched: still running, still held, still leased.
    expect(claimState(fixture, taskId)).toMatchObject({ status: 'running', claimedBy: EXECUTOR, leased: true });
    // And no half-truth was left in the append-only log.
    expect(releaseEntries(fixture, taskId)).toBe(0);
  });

  it('rolls back the transition when clearing the claim fields fails', () => {
    const fixture = ordersFixture();
    const taskId = approvedOrder(fixture);

    // Fail the LAST step. Without the transaction the task reaches
    // `needs_approval` while `claimed_by` still names the executor and the
    // lease still runs — a task that looks releasable and is not.
    const realPrepare = fixture.db.prepare.bind(fixture.db);
    const prepare = vi.spyOn(fixture.db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('claim_nonce = NULL')) throw new Error('disk full');
      return realPrepare(sql);
    }) as typeof fixture.db.prepare);

    const result = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: NOTHING_PUBLISHED,
    });
    prepare.mockRestore();

    expect(result.ok).toBe(false);
    expect(claimState(fixture, taskId)).toMatchObject({ status: 'running', claimedBy: EXECUTOR, leased: true });
    expect(releaseEntries(fixture, taskId)).toBe(0);
  });

  it('reports the failed release instead of claiming nothing was published', () => {
    const fixture = ordersFixture();
    const taskId = approvedOrder(fixture);
    const transition = failReleaseTransition(fixture);

    const result = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: NOTHING_PUBLISHED,
    });
    transition.mockRestore();

    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('transport_failed');
    // The operator has to be told the task is still claimed — otherwise the
    // next dispatch refuses for a reason nothing explained.
    expect(result.error.message).toContain('still claimed by');
    expect(result.error.message).toContain(EXECUTOR);
    expect(result.error.details?.claimReleased).toBe('failed');
  });
});

describe('the happy path still releases, and says so', () => {
  it('returns the task to needs_approval, unclaimed, on a clean publication failure', () => {
    const fixture = ordersFixture();
    const taskId = approvedOrder(fixture);

    const result = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: NOTHING_PUBLISHED,
    });

    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.details?.claimReleased).toBe('released');
    // `needs_approval`, NOT `queued`: the claim consumed the single-use
    // approval, so re-dispatching genuinely needs a fresh Founder decision.
    expect(claimState(fixture, taskId)).toMatchObject({
      status: 'needs_approval',
      claimedBy: null,
      leased: false,
    });
    expect(releaseEntries(fixture, taskId)).toBe(1);
    expect(result.error.message).not.toContain('still claimed by');
  });

  it('leaves an UNCERTAIN outcome claimed — the release is not fired at all', () => {
    // The distinction the whole design rests on: "nothing was created" releases,
    // "we do not know" does not, because a task whose execution may be running
    // externally must not be handed to anyone else.
    const fixture = ordersFixture();
    const taskId = approvedOrder(fixture);
    const killed: GitHubIssueTransport = {
      id: 'stub-gh',
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => {
        throw new Error('killed mid-flight');
      },
    };

    const result = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: killed,
    });

    expect(result.ok).toBe(false);
    expect(claimState(fixture, taskId)).toMatchObject({ status: 'running', claimedBy: EXECUTOR });
    expect(releaseEntries(fixture, taskId)).toBe(0);
  });
});
