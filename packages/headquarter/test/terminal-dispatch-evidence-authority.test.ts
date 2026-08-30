/**
 * HOSTILE: who may write a dispatch fact that DECIDES an outcome.
 *
 * Issue #219, Founder decision of 2026-08-30 approving Option B, after
 * ChatGPT and Codex independently reported the same P1 on `89fb8ad`.
 *
 * The chain that had to stop, reproduced end to end against the previous head
 * before this correction was written:
 *
 *   a genuine dispatch attempt is left `unknown`   (the transport threw; an
 *                                                   issue may or may not exist)
 *   → an UNRELATED in-process holder of `HeadquarterOperations` appends a
 *     terminal `claude_github_dispatch_failed` directly, never touching
 *     `resolveUnknownDispatch` or its reconciliation-authority check
 *   → `dispatchHistory` flips from `unknown` to `none`
 *   → the claim is released and the order re-approved by a REAL approver, who
 *     is looking at evidence that says nothing was published
 *   → a second public issue is created for work that may already be live
 *
 * The previous round bound `attempted` and `succeeded` to an active execution
 * claim and left `failed` unbound, because reconciliation legitimately holds no
 * claim. That is the honest reason the hole existed, and it is why a claim
 * requirement could not close it: the rule had to change axis. It is no longer
 * "what has this caller done" but "was this caller HANDED the writer" — a
 * dispatch-only capability given to whoever CONSTRUCTS the service and to
 * nobody else, the same handshake `OperatorQueue` uses for the approval
 * mutations.
 *
 * What is asserted here is the whole chain and not merely the refusal. A
 * refusal that still let the history close, or that broke the legitimate lanes,
 * would be no fix — so the legitimate clean failure, the legitimate
 * reconciliation in both directions, the legitimate result correlation and an
 * ordinary successful dispatch are all proved to still work, in this file,
 * beside the attack.
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
  DISPATCH_MARKER,
  dispatchClaudeTask,
  dispatchHistory,
  resolveUnknownDispatch,
} from '../src/providers/claude/dispatch.js';
import { ingestClaudeResult } from '../src/providers/claude/ingest.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import type {
  DispatchCapableTransport,
  GitHubIssueRequest,
  GitHubIssueResult,
} from '../src/providers/claude/transport.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' } as const;
const EXECUTOR = 'claude-executor';
const ISSUE = 4242;
const ISSUE_URL = `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/${ISSUE}`;

type Stub = DispatchCapableTransport & { calls: GitHubIssueRequest[] };

/**
 * A transport that answers as configured and COUNTS what it was asked to
 * publish. The count is the fact that matters in the attack: a refusal is
 * cheap talk if a second issue was created anyway.
 */
function transport(options: { throws?: boolean; fails?: boolean } = {}): Stub {
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
    createIssue: (request): GitHubIssueResult => {
      calls.push(request);
      if (options.throws) throw new Error('the transport died mid-call');
      if (options.fails) {
        return { ok: false, kind: 'rejected', message: 'gh: the repository rejected the creation' };
      }
      return { ok: true, issueNumber: ISSUE, issueUrl: ISSUE_URL };
    },
  } as Stub;
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
  approve(fixture, taskId);
  return { fixture, taskId };
}

/** A genuine Founder approval by a principal who did not open the order. */
function approve(fixture: Fixture, taskId: string): void {
  const task = fixture.ops.queue.get(taskId)!;
  expectOk(
    fixture.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }),
  );
}

/** A REAL unresolved attempt: the transport threw, so nobody knows. */
function taskWithUnknownDispatch(): { fixture: Fixture; taskId: string; stub: Stub } {
  const { fixture, taskId } = fixtureWithOrder();
  const stub = transport({ throws: true });
  dispatchClaudeTask(fixture.ops, {
    evidence: fixture.dispatchEvidence,
    executorWorkerId: EXECUTOR,
    taskId,
    target: TARGET,
    transport: stub,
  });
  expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  expect(stub.calls).toHaveLength(1);
  return { fixture, taskId, stub };
}

/**
 * The attacker: an ordinary in-process holder of `HeadquarterOperations`. It has
 * no grant, because a grant is not something an `ops` object carries — this is
 * the entire mechanism, so it is stated as the type it is rather than smuggled
 * in through a helper.
 */
function forgeTerminal(ops: Fixture['ops'], taskId: string): () => unknown {
  return () =>
    ops.appendSystemEvidence({
      taskId,
      actor: 'hq-claude-dispatch',
      // The kind is the point: `dispatchHistory` reads it as "nothing was
      // published", which is what re-enables a dispatch.
      kind: CLAUDE_DISPATCH_EVIDENCE.failed as never,
      payload: { provider: 'CLAUDE', kind: 'rejected', message: 'forged' },
    });
}

describe('a terminal dispatch outcome is not writable by a caller holding ops', () => {
  it('refuses a forged terminal failure, naming the grant rather than a generic unknown kind', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();

    expect(forgeTerminal(fixture.ops, taskId)).toThrow(/decides a dispatch outcome/);

    // Nothing was written, so the attempt is still open.
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
    expect(fixture.ops.queue.evidence.list(taskId).filter((e) => e.kind === CLAUDE_DISPATCH_EVIDENCE.failed)).toHaveLength(0);
    // And the append-only chain is intact — a refusal must not half-write.
    expect(fixture.ops.queue.evidence.verifyChain()).toBeNull();
  });

  it('refuses every outcome-setting kind, not only the one that was reported', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    for (const kind of [
      CLAUDE_DISPATCH_EVIDENCE.attempted,
      CLAUDE_DISPATCH_EVIDENCE.succeeded,
      CLAUDE_DISPATCH_EVIDENCE.failed,
      CLAUDE_DISPATCH_EVIDENCE.correlated,
    ]) {
      expect(() =>
        fixture.ops.appendSystemEvidence({
          taskId,
          actor: 'hq-claude-dispatch',
          kind: kind as never,
          payload: { issueNumber: 9999, issueUrl: 'https://github.com/attacker/evil/issues/9999', repository: 'attacker/evil' },
        }),
      ).toThrow(/decides a dispatch outcome/);
    }
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  it('still carries the kinds that decide nothing, so the lane keeps its diagnostics', () => {
    const { fixture } = fixtureWithOrder();
    const entry = fixture.ops.appendSystemEvidence({
      actor: 'system',
      kind: 'direct_order_dispatch_blocked',
      payload: { provider: 'CLAUDE' },
    });
    expect(entry.actor).toBe('system');
    expect(fixture.ops.queue.evidence.verifyChain()).toBeNull();
  });

  /**
   * THE CHAIN, end to end. Each step is asserted, because the fix is only
   * worth anything if the LAST step cannot happen.
   */
  it('stops the forged-failure → release → re-approval → duplicate-issue chain', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();

    // 1. The forgery is refused.
    expect(forgeTerminal(fixture.ops, taskId)).toThrow(/decides a dispatch outcome/);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');

    // 2. The attacker tries the ordinary release/re-approval sequence anyway.
    //    Releasing a claim is a legitimate public operation; it is the forged
    //    evidence that was supposed to make the re-dispatch look safe.
    const claimed = fixture.ops.queue.get(taskId)!;
    if (claimed.claimedBy) {
      fixture.ops.queue.releaseClaim(taskId, claimed.claimedBy, claimed.fence, 'attacker releases the claim');
    }
    const afterRelease = fixture.ops.queue.get(taskId)!;
    if (afterRelease.status === 'needs_approval') approve(fixture, taskId);

    // 3. The second dispatch — the step that would have published a duplicate.
    const second = transport();
    const result = dispatchClaudeTask(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: second,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('dispatch_outcome_unknown');
    // The fact the whole chain exists to produce: NO second public issue.
    expect(second.calls).toHaveLength(0);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  /**
   * The other direction of the same forgery, which #219's earlier round called
   * out and which Option B closes with the same rule: a forged terminal entry
   * can also PREVENT a legitimate reconciliation, because `claimReconciliation`
   * refuses once the attempt is no longer `unknown`.
   */
  it('leaves a legitimate reconciliation reachable after the attempt', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    expect(forgeTerminal(fixture.ops, taskId)).toThrow();

    const resolved = resolveUnknownDispatch(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: ISSUE_URL,
      resolvedBy: 'coo',
    });

    expect(resolved.ok).toBe(true);
    expect(dispatchHistory(fixture.ops, taskId)).toMatchObject({ state: 'dispatched', issueNumber: ISSUE });
  });
});

describe('the legitimate lanes are unchanged by the grant', () => {
  it('publishes and records an ordinary dispatch', () => {
    const { fixture, taskId } = fixtureWithOrder();
    const stub = transport();
    const receipt = expectOk(
      dispatchClaudeTask(fixture.ops, {
        evidence: fixture.dispatchEvidence,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport: stub,
      }),
    );
    expect(receipt.issueNumber).toBe(ISSUE);
    expect(stub.calls).toHaveLength(1);
    expect(dispatchHistory(fixture.ops, taskId)).toMatchObject({ state: 'dispatched', issueNumber: ISSUE });
  });

  it('records a clean transport failure, closing the attempt and releasing the claim', () => {
    const { fixture, taskId } = fixtureWithOrder();
    const stub = transport({ fails: true });
    const result = dispatchClaudeTask(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: stub,
    });

    expect(result.ok).toBe(false);
    // The clean failure IS recorded — Option B gates who may write it, and does
    // not stop the lane that legitimately does. (This is the property Option D
    // would have given up, and the reason the Founder weighed the two.)
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
    const failures = fixture.ops.queue.evidence
      .list(taskId)
      .filter((e) => e.kind === CLAUDE_DISPATCH_EVIDENCE.failed);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.actor).toBe('hq-claude-dispatch');
    expect(fixture.ops.queue.get(taskId)!.claimedBy).toBeNull();
  });

  it('reconciles an unknown attempt as not dispatched, on approval authority', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    const result = resolveUnknownDispatch(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'coo',
    });
    expect(result.ok).toBe(false); // a refusal receipt: nothing was published
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
  });

  it('still refuses a reconciliation from someone without approval authority', () => {
    // The grant and the authority check are INDEPENDENT rules. Holding the
    // grant is what makes this code the dispatch lane; it never stands in for
    // a principal's decision.
    const { fixture, taskId } = taskWithUnknownDispatch();
    const result = resolveUnknownDispatch(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: EXECUTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toMatch(/Reconciliation refused/);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  it('correlates a genuine result report through the grant', () => {
    const { fixture, taskId } = fixtureWithOrder();
    const stub = transport();
    const receipt = expectOk(
      dispatchClaudeTask(fixture.ops, {
        evidence: fixture.dispatchEvidence,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport: stub,
      }),
    );
    const body = stub.calls[0]!.body;
    expect(body).toContain(DISPATCH_MARKER);

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      evidence: fixture.dispatchEvidence,
      transport: {
        id: 'stub-read',
        status: () => ({
          available: true,
          authenticated: true,
          account: TARGET.owner,
          depth: 'live',
          observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
          missingFacts: [],
          reason: 'stub transport',
        }),
        readIssue: (_target: unknown, issueNumber: number) => ({
          ok: true,
          issue: {
            issueNumber,
            body,
            comments: [
              {
                author: TARGET.owner,
                url: `${receipt.issueUrl}#issuecomment-1`,
                body: '<!-- jenify-claude-result -->\n## Claude Engineering / Review Report\nDone.',
              },
            ],
          },
        }),
      } as never,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.correlated).toBe(true);
    const correlations = fixture.ops.queue.evidence
      .list(taskId)
      .filter((e) => e.kind === CLAUDE_DISPATCH_EVIDENCE.correlated);
    expect(correlations).toHaveLength(1);
  });
});
