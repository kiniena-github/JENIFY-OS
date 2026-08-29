/**
 * Where a PUBLISHED handoff goes when its lease expires (issue #224,
 * dispositioning the double-execution limitation the coordinator asked not to
 * be accepted by implication).
 *
 * ## What was actually wrong
 *
 * The limitation recorded on the PR said a worker declared as CLAUDE after a
 * successful dispatch "can still claim the task". Checked empirically, that is
 * NOT true in any ordering — the consumed single-use approval refuses every one
 * of them. The invariant held; the note was wrong.
 *
 * What the check DID find is different and real. `sweepExpiredLeases` sends a
 * side-effect task to `outcome_unknown` only from `running`; from `assigned` it
 * RE-QUEUES and clears the claim. The handoff claimed the task but never called
 * `start`, so it sat `assigned` — and an expired 6-hour lease therefore did not
 * produce the "handed out, never heard back" record this lane documents. It
 * produced a task in `queued`, which reads as *waiting to run*, carrying an
 * approval already consumed: nothing could claim it (no usable approval) and
 * nothing could re-approve it (`approveTask` refuses a task that is not
 * `needs_approval`). A silent dead end wearing the costume of a queue entry.
 *
 * Publication really does start an execution, so the handoff now calls `start`.
 * That is the canonical boundary, it re-checks binding/approval/digest/fence,
 * and the existing sweep rule then does exactly what the documentation promised.
 *
 * ## What is asserted
 *
 * The safety property (no second execution, in any ordering) AND the state
 * property (an expired lease lands in `outcome_unknown`, never back in the
 * queue) — the second being the one that was only ever prose.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability, submitDirectOrder } from '../src/live/orders.js';
import { dispatchClaudeTask, dispatchHistory } from '../src/providers/claude/dispatch.js';
import type {
  GitHubIssueResult,
  GitHubIssueTransport,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';

const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' };
const EXECUTOR = 'claude-executor';
const SECOND = 'claude-second-executor';
const ISSUE_URL = `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/42`;

const AUTHENTICATED: GitHubTransportStatus = {
  available: true,
  authenticated: true,
  account: 'kiniena-github',
  depth: 'live',
  observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
  missingFacts: [],
  reason: 'The GitHub CLI is installed and an authenticated github.com session was observed.',
};

const PUBLISHES: GitHubIssueTransport = {
  id: 'stub-gh',
  status: (): GitHubTransportStatus => AUTHENTICATED,
  createIssue: (): GitHubIssueResult => ({ ok: true, issueNumber: 42, issueUrl: ISSUE_URL }),
};

function fixture(): Fixture {
  const f = setupFixture();
  registerDirectOrderCapability(f.ops);
  f.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  f.principals.register({
    id: 'chair',
    displayName: 'Chair',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  return f;
}

function declareWorker(f: Fixture, workerId: string): void {
  const registered = f.ops.registerExecutionWorker({
    workerId,
    displayName: workerId,
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    founderId: 'chair',
  });
  if (!registered.ok) throw new Error(`expected registration: ${registered.error.code}`);
  f.ops.declareWorkerProvider({ workerId, providerId: 'CLAUDE', founderId: 'chair' });
}

function approvedOrder(f: Fixture): string {
  const placed = submitDirectOrder(
    f.ops,
    { instruction: 'Draft the Q3 maintenance plan.', project: 'mesob', route: 'CLAUDE', requestedBy: 'founder' },
    { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' },
  );
  if (!placed.ok) throw new Error(`expected the order to be placed: ${placed.error.code}`);
  f.ops.approveTask({
    taskId: placed.data.task.id,
    founderId: 'chair',
    expectedActionDigest: taskActionDigest(placed.data.task),
  });
  return placed.data.task.id;
}

/** Publish the handoff, then age its lease exactly as six hours of clock would. */
function dispatchedAndExpired(f: Fixture, taskId: string): void {
  const sent = dispatchClaudeTask(f.ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: PUBLISHES });
  if (!sent.ok) throw new Error(`expected a dispatch: ${sent.error.code}`);
  expect(sent.data.executionStarted).toBe(true);
  expect(dispatchHistory(f.ops, taskId).state).toBe('dispatched');
  f.db.prepare(`UPDATE op_tasks SET lease_expires_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', taskId);
}

describe('a published handoff is a started execution', () => {
  it('leaves the task running, not merely assigned', () => {
    const f = fixture();
    declareWorker(f, EXECUTOR);
    const taskId = approvedOrder(f);
    const sent = dispatchClaudeTask(f.ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: PUBLISHES });
    if (!sent.ok) throw new Error('expected a dispatch');

    const task = f.ops.queue.get(taskId)!;
    expect(task.status).toBe('running');
    expect(task.claimedBy).toBe(EXECUTOR);
    // Started is not reviewed and not completed: the party that does the work
    // still never declares it done.
    expect(task.reviewState).toBe('none');
    expect(task.result).toBeNull();
  });

  it('expires into outcome_unknown, never back into the queue', () => {
    // The state the documentation always claimed, now actually produced. Before
    // this, the sweep re-queued it — see the header.
    const f = fixture();
    declareWorker(f, EXECUTOR);
    const taskId = approvedOrder(f);
    dispatchedAndExpired(f, taskId);

    const swept = f.ops.queue.sweepExpiredLeases();
    expect(swept.outcomeUnknown).toContain(taskId);
    expect(swept.requeued).not.toContain(taskId);
    expect(f.ops.queue.get(taskId)!.status).toBe('outcome_unknown');
  });

  it('does not strand the task where nothing can claim OR re-approve it', () => {
    // The practical shape of the old defect: `queued` with a consumed approval
    // is unreachable from both directions at once, and looks like normal work.
    const f = fixture();
    declareWorker(f, EXECUTOR);
    const taskId = approvedOrder(f);
    dispatchedAndExpired(f, taskId);
    f.ops.queue.sweepExpiredLeases();

    const task = f.ops.queue.get(taskId)!;
    expect(task.status).not.toBe('queued');
    // `outcome_unknown` has a real, documented way out: a human reconciles it.
    // `queued`-with-a-spent-approval had none.
    expect(task.status).toBe('outcome_unknown');
  });
});

describe('no second CLAUDE identity can execute the same approved action', () => {
  it('refuses a second worker declared AFTER the dispatch', () => {
    const f = fixture();
    declareWorker(f, EXECUTOR);
    const taskId = approvedOrder(f);
    const sent = dispatchClaudeTask(f.ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: PUBLISHES });
    if (!sent.ok) throw new Error('expected a dispatch');

    // The exact ordering the PR's limitation note described.
    declareWorker(f, SECOND);
    const claimed = f.ops.claimNext(SECOND, DIRECT_ORDER_CAPABILITY.id);
    expect(claimed.ok).toBe(false);
    expect(f.ops.queue.get(taskId)!.claimedBy).toBe(EXECUTOR);
  });

  it('refuses a second worker after the lease expires', () => {
    const f = fixture();
    declareWorker(f, EXECUTOR);
    declareWorker(f, SECOND);
    const taskId = approvedOrder(f);
    dispatchedAndExpired(f, taskId);
    f.ops.queue.sweepExpiredLeases();

    const claimed = f.ops.claimNext(SECOND, DIRECT_ORDER_CAPABILITY.id);
    expect(claimed.ok).toBe(false);
    expect(f.ops.queue.get(taskId)!.status).toBe('outcome_unknown');
  });

  it('closes the full claim-then-reapprove chain Codex described', () => {
    // The exploit as a sequence, because each step alone looks harmless and I
    // got this wrong by probing one step in isolation: approving the re-queued
    // task directly IS refused, which is what made it look safe.
    //
    // Before the fix, on the pre-`start` behaviour, this ran end to end:
    //   1. publish the handoff            → task `assigned`, GitHub issue live
    //   2. 6-hour lease expires, sweep    → RE-QUEUED to `queued`
    //   3. any CLAUDE worker attempts a claim → refused, BUT
    //      `rejectAtExecutionBoundary` moves the task to `needs_approval`
    //   4. a Founder supplies a fresh approval → `queued`
    //   5. a second worker claims (fence 2) and starts → `running`
    // — a second execution of one Founder-approved action while the first may
    // still be running on GitHub. Step 3 is the hinge: the failed claim is what
    // unlocks re-approval.
    const f = fixture();
    declareWorker(f, EXECUTOR);
    declareWorker(f, SECOND);
    const taskId = approvedOrder(f);
    dispatchedAndExpired(f, taskId);
    f.ops.queue.sweepExpiredLeases();

    // Step 3 cannot move it: `outcome_unknown` is not a claimable state and the
    // execution boundary is never reached, so nothing re-opens approval.
    expect(f.ops.claimNext(SECOND, DIRECT_ORDER_CAPABILITY.id).ok).toBe(false);
    expect(f.ops.queue.get(taskId)!.status).toBe('outcome_unknown');

    // Step 4 therefore refuses, and step 5 has nothing to claim.
    expect(
      f.ops.approveTask({
        taskId,
        founderId: 'chair',
        expectedActionDigest: taskActionDigest(f.ops.queue.get(taskId)!),
      }).ok,
    ).toBe(false);
    expect(f.ops.claimNext(SECOND, DIRECT_ORDER_CAPABILITY.id).ok).toBe(false);
    expect(f.ops.queue.get(taskId)!.claimedBy).toBe(EXECUTOR);
  });

  it('refuses to re-approve the timed-out task into a second execution', () => {
    // Re-approval is the one route that could make it claimable again, so it is
    // the one that has to refuse while the external execution may still be live.
    const f = fixture();
    declareWorker(f, EXECUTOR);
    declareWorker(f, SECOND);
    const taskId = approvedOrder(f);
    dispatchedAndExpired(f, taskId);
    f.ops.queue.sweepExpiredLeases();

    const reapproved = f.ops.approveTask({
      taskId,
      founderId: 'chair',
      expectedActionDigest: taskActionDigest(f.ops.queue.get(taskId)!),
    });
    expect(reapproved.ok).toBe(false);
    expect(f.ops.claimNext(SECOND, DIRECT_ORDER_CAPABILITY.id).ok).toBe(false);
  });
});
