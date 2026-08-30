/**
 * HOSTILE: who may declare that an ambiguous external side effect happened.
 *
 * Issue #219, ChatGPT blocking finding on `173cd30`, reproduced end to end
 * before the correction and pinned here after it.
 *
 * The sequence that must fail closed:
 *
 *   a genuine dispatch attempt is left `unknown`   (the transport threw; an
 *                                                   issue may or may not exist)
 *   → an UNAUTHORIZED caller reconciles it as `not_dispatched`
 *   → `dispatchHistory` returns to `none`
 *   → a later dispatch is eligible again and publishes a SECOND issue
 *
 * `resolvedBy` was previously recorded verbatim and checked only for being
 * non-empty, so any string could close the attempt. Deciding whether an
 * irreversible public act happened is the same class of judgement the Founder
 * gate exists for, so it now goes through the boundary `approveTask` uses.
 *
 * What is asserted here is the WHOLE chain, not just the refusal: the attempt
 * must still be `unknown` afterwards, and the next dispatch must still refuse
 * and publish nothing. A refusal that left the history closed would be no fix.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, expectOk, type Fixture } from './application.fixture.js';
import {
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';
import {
  CLAUDE_DISPATCH_EVIDENCE,
  dispatchClaudeTask,
  dispatchHistory,
  resolveUnknownDispatch,
} from '../src/providers/claude/dispatch.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import type { DispatchCapableTransport, GitHubIssueRequest } from '../src/providers/claude/transport.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' } as const;
const EXECUTOR = 'claude-executor';

function transport(options: { throws?: boolean } = {}): DispatchCapableTransport & {
  calls: GitHubIssueRequest[];
} {
  const calls: GitHubIssueRequest[] = [];
  return {
    id: 'stub',
    calls,
    ensureLabel: () => ({ ok: true, created: false }),
    status: () => ({
      available: true,
      authenticated: true,
      account: TARGET.owner,
      depth: 'live',
      observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
      missingFacts: [],
      reason: 'stub transport',
    }),
    createIssue: (request) => {
      calls.push(request);
      if (options.throws) throw new Error('the transport died mid-call');
      return {
        ok: true,
        issueNumber: 4242,
        issueUrl: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/4242`,
      };
    },
  } as DispatchCapableTransport & { calls: GitHubIssueRequest[] };
}

function fixtureWithOrder(): { fixture: Fixture; taskId: string } {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  for (const id of ['founder', 'coo']) {
    fixture.principals.register({
      id,
      displayName: id,
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
  }
  // A registered principal WITHOUT approval authority: being known is not the
  // same as being entitled to decide this.
  fixture.principals.register({
    id: 'observer',
    displayName: 'Observer',
    originateCapabilities: [],
    approvalAuthority: false,
    active: true,
  });
  const registered = fixture.ops.registerExecutionWorker({
    workerId: EXECUTOR,
    displayName: 'Claude GitHub workflow',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    founderId: 'coo',
  });
  if (!registered.ok) throw new Error(registered.error.code);
  fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CLAUDE', founderId: 'coo' });

  const receipt = expectOk(
    submitDirectOrder(
      fixture.ops,
      { instruction: 'Draft the plan.', project: 'mesob', route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
    ),
  );
  const taskId = receipt.task.id;
  const task = fixture.ops.queue.get(taskId)!;
  expectOk(
    fixture.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }),
  );
  return { fixture, taskId };
}

/** A REAL unresolved attempt: the transport threw, so nobody knows. */
function taskWithUnknownDispatch(): { fixture: Fixture; taskId: string } {
  const { fixture, taskId } = fixtureWithOrder();
  dispatchClaudeTask(fixture.ops, {
    executorWorkerId: EXECUTOR,
    taskId,
    target: TARGET,
    transport: transport({ throws: true }),
  });
  expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  return { fixture, taskId };
}

describe('an ambiguous dispatch outcome may only be decided by approval authority', () => {
  it('refuses an unregistered id, and the attempt stays unresolved', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();

    const result = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'nobody-in-particular',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toMatch(/Reconciliation refused/);
    // The whole point: the attempt is NOT closed.
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
    // And nothing was recorded either way.
    const terminals = fixture.ops.queue.evidence
      .list(taskId)
      .filter(
        (e) =>
          e.kind === CLAUDE_DISPATCH_EVIDENCE.failed ||
          e.kind === CLAUDE_DISPATCH_EVIDENCE.succeeded,
      );
    expect(terminals).toHaveLength(0);
  });

  it('refuses a registered principal who does not hold approval authority', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    const result = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'observer',
    });
    expect(result.ok).toBe(false);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  it('refuses the executing worker — worker identity never carries this', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    const result = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: EXECUTOR,
    });
    expect(result.ok).toBe(false);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  it("refuses 'system' — a human principal is required", () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    const result = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'system',
    });
    expect(result.ok).toBe(false);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  /**
   * The consequence the refusal exists for, asserted rather than assumed: after
   * a refused reconciliation the next dispatch must STILL refuse and publish
   * nothing. This is the `unknown -> forged close -> none -> second issue`
   * sequence, proven to stop at the first step.
   */
  it('leaves the next dispatch refusing, so no second issue is published', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'nobody-in-particular',
    });

    const second = transport();
    const redispatch = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: second,
    });

    expect(redispatch.ok).toBe(false);
    // Nothing reached GitHub. This is the duplicate-publication guarantee.
    expect(second.calls).toHaveLength(0);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  it('still lets a genuine approval-authority principal reconcile', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    const result = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'coo',
    });
    // The legitimate path is unchanged: the attempt closes and the operator is
    // told the claim was released. A guard that also broke this would be no use.
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
    expect(result.ok).toBe(false); // `not_dispatched` reports a refusal by design
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toMatch(/reconciled as NOT dispatched/);
  });
});
