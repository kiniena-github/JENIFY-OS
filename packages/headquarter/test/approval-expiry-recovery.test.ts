/**
 * A task whose Founder approval expires while it sits `queued` must not become
 * canonically stranded (issue #226, the Founder-workstation blocker after
 * PR #225).
 *
 * ## The demonstrated deadlock
 *
 * Task `49e0dcff-…` stayed `status=queued` after its one-hour approval expired.
 * `hq:dispatch-claude --check-only` proved everything else was ready — transport
 * authenticated, executor claimable, registered, active, capable, declared
 * CLAUDE — and dispatch refused for exactly one reason: the approval had
 * expired.
 *
 * That refusal was correct and incomplete. `claim()` has always applied the
 * canonical consequence for an approval that no longer admits execution (send
 * the task back to `needs_approval` for a fresh Founder decision), but the
 * dispatch lane asks `claudeDispatchEligibility` BEFORE it claims, so `claim()`
 * was never reached. `approveTask` accepts `needs_approval` only — so the task
 * could be neither approved nor run by any supported path.
 *
 * ## What these tests lock
 *
 * Both halves, because either alone is a defect:
 *
 *   1. an expired approval NEVER dispatches — nothing claimed, nothing
 *      published, no approval consumed; and
 *   2. an expired approval always leaves a way back to a fresh Founder
 *      decision, through the canonical approval flow and its every rule.
 *
 * And the things that must NOT change on the way: the digest binding, the
 * no-self-approval rule, provider binding, single-use nonce semantics, the
 * claim fence/nonce, the immutability of the stale approval row, and
 * `--check-only`'s promise to write nothing.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, expectOk, type Fixture } from './application.fixture.js';
import {
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';
import { taskActionDigest, DEFAULT_APPROVAL_TTL_MS } from '../src/operator/approvals.js';
import {
  claudeDispatchEligibility,
  dispatchClaudeTask,
} from '../src/providers/claude/dispatch.js';
import type {
  DispatchCapableTransport,
  GitHubIssueRequest,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' } as const;
const EXECUTOR = 'claude-executor';

function stubTransport(
  status: Partial<GitHubTransportStatus> = {},
): DispatchCapableTransport & { calls: GitHubIssueRequest[] } {
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
      ...status,
    }),
    createIssue: (request) => {
      calls.push(request);
      return {
        ok: true,
        issueNumber: 4242,
        issueUrl: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/4242`,
      };
    },
  };
}

function orderFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
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
  if (!registered.ok) throw new Error(`expected registration: ${registered.error.code}`);
  fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CLAUDE', founderId: 'coo' });
  return fixture;
}

/** An order approved by the second Founder-authority human, as the rules demand. */
function placeApprovedOrder(fixture: Fixture, ttlMs?: number): string {
  const receipt = expectOk(
    submitDirectOrder(
      fixture.ops,
      {
        instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
        project: 'mesob',
        route: 'CLAUDE',
        requestedBy: 'founder',
      },
      CLAUDE_ONLY,
    ),
  );
  const taskId = receipt.task.id;
  const task = fixture.ops.queue.get(taskId)!;
  expectOk(
    fixture.ops.approveTask({
      taskId,
      founderId: 'coo',
      expectedActionDigest: taskActionDigest(task),
      ttlMs,
    }),
  );
  return taskId;
}

/**
 * Age the approval past its time-box.
 *
 * The one thing a test cannot do honestly is wait an hour, and the expiry
 * boundary is a stored instant rather than an injectable clock on this path —
 * so the STORED instant is moved into the past. Nothing else about the row is
 * touched: same id, same decision, same digest, same unconsumed nonce, which is
 * exactly the state the Founder's stranded task was in.
 */
function expireApproval(fixture: Fixture, taskId: string): string {
  const approvalId = fixture.ops.queue.get(taskId)!.approvalId!;
  expect(approvalId).toBeTruthy();
  fixture.db
    .prepare(`UPDATE hq_approvals SET expires_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 60_000).toISOString(), approvalId);
  return approvalId;
}

function approvalRow(fixture: Fixture, approvalId: string) {
  return fixture.db.prepare(`SELECT * FROM hq_approvals WHERE id = ?`).get(approvalId) as
    | Record<string, unknown>
    | undefined;
}

/* ------------------------------------------------------------------ */
/* 1. An expired approval never dispatches                             */
/* ------------------------------------------------------------------ */

describe('an expired Founder approval never dispatches', () => {
  it('publishes nothing, claims nothing and consumes no approval', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    const approvalId = expireApproval(fixture, taskId);
    const transport = stubTransport();

    const result = dispatchClaudeTask(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('approval_invalid');
    expect(result.error.details?.rejection).toBe('approval_expired');
    // Fail closed, in the only way that matters: no public artefact.
    expect(transport.calls).toHaveLength(0);
    // No claim was taken and the single-use nonce was NOT burned.
    const after = fixture.ops.queue.get(taskId)!;
    expect(after.claimedBy).toBeNull();
    expect(after.claimNonce).toBeNull();
    expect(approvalRow(fixture, approvalId)!.consumed_at).toBeNull();
  });

  it('still refuses after the task has been returned, until a fresh approval exists', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    expireApproval(fixture, taskId);
    const transport = stubTransport();
    const dispatch = () =>
      dispatchClaudeTask(fixture.ops, {
        evidence: fixture.dispatchEvidence,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport,
      });

    const first = dispatch();
    expect(first.ok).toBe(false);
    // The second attempt finds a `needs_approval` task — still refused, and
    // still nothing published. A return is not a re-approval.
    const second = dispatch();
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('task_not_eligible');
    expect(transport.calls).toHaveLength(0);
    expect(fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });
});

/* ------------------------------------------------------------------ */
/* 2. queued + expired approval -> a fresh approval is required        */
/* ------------------------------------------------------------------ */

describe('a queued task with an expired approval returns for a fresh Founder decision', () => {
  it('was stranded before: queued, expired, and not approvable', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    expireApproval(fixture, taskId);

    // The exact reported shape: queued, with an approval that no longer admits
    // execution, and `approveTask` refusing because it is not awaiting approval.
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
    const blocked = fixture.ops.approveTask({
      taskId,
      founderId: 'coo',
      expectedActionDigest: taskActionDigest(fixture.ops.queue.get(taskId)!),
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    expect(blocked.error.code).toBe('task_not_awaiting_approval');
  });

  it('returns the task to needs_approval, canonically, on a dispatch attempt', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    const approvalId = expireApproval(fixture, taskId);

    dispatchClaudeTask(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: stubTransport(),
    });

    const after = fixture.ops.queue.get(taskId)!;
    expect(after.status).toBe('needs_approval');
    // The stale binding is cleared from the TASK...
    expect(after.approvalId).toBeNull();
    // ...and the approval row itself is untouched, immutable audit evidence.
    const row = approvalRow(fixture, approvalId)!;
    expect(row.decision).toBe('approved');
    expect(row.decided_by).toBe('coo');
    expect(row.consumed_at).toBeNull();
    // The canonical rejection is recorded rather than silently applied.
    const kinds = fixture.ops.queue.evidence.list(taskId).map((entry) => entry.kind);
    expect(kinds).toContain('approval_rejected_at_execution');
    expect(fixture.ops.queue.evidence.verifyChain()).toBeNull();
  });

  it('is reachable directly through the canonical operation, and is a no-op on a live approval', () => {
    const fixture = orderFixture();
    const live = placeApprovedOrder(fixture);

    // A still-valid approval is never stripped: the operation grants nothing
    // and takes nothing away.
    const untouched = expectOk(fixture.ops.returnForFreshApproval(live));
    expect(untouched.returned).toBe(false);
    expect(untouched.rejection).toBeNull();
    expect(fixture.ops.queue.get(live)!.status).toBe('queued');
    expect(fixture.ops.queue.get(live)!.approvalId).not.toBeNull();

    expireApproval(fixture, live);
    const applied = expectOk(fixture.ops.returnForFreshApproval(live));
    expect(applied.returned).toBe(true);
    expect(applied.rejection).toBe('approval_expired');
    expect(applied.status).toBe('needs_approval');
  });

  it('never auto-approves: the returned task holds no approval of its own', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    expireApproval(fixture, taskId);
    expectOk(fixture.ops.returnForFreshApproval(taskId));

    const returned = fixture.ops.queue.get(taskId)!;
    expect(returned.status).toBe('needs_approval');
    expect(returned.approvalId).toBeNull();
    // And eligibility agrees: nothing has cleared this to run.
    const verdict = claudeDispatchEligibility(fixture.ops, taskId);
    expect(verdict.eligible).toBe(false);
  });

  it('blocks rather than re-approves when the approved ACTION changed', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    // A mutated payload is hostile, not stale: it must never become
    // re-approvable through this path.
    fixture.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(
        JSON.stringify({ ...fixture.ops.queue.get(taskId)!.payload, instruction: 'something else' }),
        taskId,
      );

    const result = dispatchClaudeTask(fixture.ops, {
      evidence: fixture.dispatchEvidence,
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: stubTransport(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details?.rejection).toBe('approval_digest_mismatch');
    expect(fixture.ops.queue.get(taskId)!.status).toBe('blocked');
  });
});

/* ------------------------------------------------------------------ */
/* 3. A fresh approval restores the valid claim path                   */
/* ------------------------------------------------------------------ */

describe('a fresh Founder approval restores the claim path end to end', () => {
  it('re-approves and dispatches, with a NEW single-use approval bound to the same action', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    const staleApprovalId = expireApproval(fixture, taskId);
    const transport = stubTransport();

    // The attempt that refuses AND returns the task.
    expect(
      dispatchClaudeTask(fixture.ops, {
        evidence: fixture.dispatchEvidence,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport,
      }).ok,
    ).toBe(false);

    // The ordinary approval flow now works — the SAME call the browser makes,
    // echoing the digest it was shown.
    const awaiting = fixture.ops.queue.get(taskId)!;
    expect(awaiting.status).toBe('needs_approval');
    expectOk(
      fixture.ops.approveTask({
        taskId,
        founderId: 'coo',
        expectedActionDigest: taskActionDigest(awaiting),
      }),
    );

    const freshApprovalId = fixture.ops.queue.get(taskId)!.approvalId!;
    expect(freshApprovalId).not.toBe(staleApprovalId);
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');

    // And the dispatch that was blocked now succeeds through the normal path.
    const receipt = expectOk(
      dispatchClaudeTask(fixture.ops, {
        evidence: fixture.dispatchEvidence,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport,
      }),
    );
    expect(receipt.provider).toBe('CLAUDE');
    expect(transport.calls).toHaveLength(1);

    // The claim path really ran: fenced, nonce-stamped, and the FRESH approval
    // is the one consumed — exactly once.
    const executed = fixture.ops.queue.get(taskId)!;
    expect(executed.status).toBe('running');
    expect(executed.claimedBy).toBe(EXECUTOR);
    expect(executed.claimNonce).toBeTruthy();
    expect(executed.fence).toBeGreaterThan(0);
    const fresh = approvalRow(fixture, freshApprovalId)!;
    expect(fresh.consumed_at).not.toBeNull();
    expect(fresh.consumed_by).toBe(EXECUTOR);
    expect(fresh.consumed_task_id).toBe(taskId);
    expect(fresh.consumed_claim_nonce).toBe(executed.claimNonce);
    expect(fresh.consumed_fence).toBe(executed.fence);
    // The stale approval was never consumed by anything.
    expect(approvalRow(fixture, staleApprovalId)!.consumed_at).toBeNull();
    expect(fixture.ops.queue.evidence.verifyChain()).toBeNull();
  });

  it('holds the no-self-approval rule on the fresh decision too', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    expireApproval(fixture, taskId);
    expectOk(fixture.ops.returnForFreshApproval(taskId));

    // `founder` opened this order, so `founder` may not approve it — the return
    // path grants no exemption from the rule.
    const selfApproval = fixture.ops.approveTask({
      taskId,
      founderId: 'founder',
      expectedActionDigest: taskActionDigest(fixture.ops.queue.get(taskId)!),
    });
    expect(selfApproval.ok).toBe(false);
    expect(fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });

  it('holds the digest binding on the fresh decision too', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    expireApproval(fixture, taskId);
    expectOk(fixture.ops.returnForFreshApproval(taskId));

    const stale = fixture.ops.approveTask({
      taskId,
      founderId: 'coo',
      expectedActionDigest: 'not-the-digest-you-were-shown',
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.error.code).toBe('action_digest_mismatch');
    expect(fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });

  it('keeps the provider binding across the whole round trip', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    expireApproval(fixture, taskId);
    expectOk(fixture.ops.returnForFreshApproval(taskId));
    expectOk(
      fixture.ops.approveTask({
        taskId,
        founderId: 'coo',
        expectedActionDigest: taskActionDigest(fixture.ops.queue.get(taskId)!),
      }),
    );

    // A worker declared for another provider still cannot take this order.
    const registered = fixture.ops.registerExecutionWorker({
      workerId: 'codex-executor',
      displayName: 'Codex CLI',
      vendor: 'openai',
      role: 'reviewer_gatekeeper',
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      founderId: 'coo',
    });
    if (!registered.ok) throw new Error(`expected registration: ${registered.error.code}`);
    fixture.ops.declareWorkerProvider({
      workerId: 'codex-executor',
      providerId: 'CODEX',
      founderId: 'coo',
    });
    const claimed = fixture.ops.claimNext(
      'codex-executor',
      DIRECT_ORDER_CAPABILITY.id,
      undefined,
      taskId,
    );
    expect(claimed.ok).toBe(false);
    if (claimed.ok) throw new Error('unreachable');
    expect(claimed.error.code).toBe('provider_binding_mismatch');
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
    expect(fixture.ops.queue.get(taskId)!.claimedBy).toBeNull();
  });

  it('gives the fresh approval its own time-box, not the expired one', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    const staleId = expireApproval(fixture, taskId);
    expectOk(fixture.ops.returnForFreshApproval(taskId));
    expectOk(
      fixture.ops.approveTask({
        taskId,
        founderId: 'coo',
        expectedActionDigest: taskActionDigest(fixture.ops.queue.get(taskId)!),
      }),
    );

    const freshId = fixture.ops.queue.get(taskId)!.approvalId!;
    const freshExpiry = String(approvalRow(fixture, freshId)!.expires_at);
    const staleExpiry = String(approvalRow(fixture, staleId)!.expires_at);
    expect(freshExpiry > staleExpiry).toBe(true);
    expect(Date.parse(freshExpiry)).toBeGreaterThan(Date.now());
    expect(Date.parse(freshExpiry) - Date.now()).toBeLessThanOrEqual(DEFAULT_APPROVAL_TTL_MS + 5_000);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The read-only check stays read-only                              */
/* ------------------------------------------------------------------ */

describe('the eligibility check itself mutates nothing (--check-only)', () => {
  it('reports the expired approval without returning, blocking or approving anything', () => {
    const fixture = orderFixture();
    const taskId = placeApprovedOrder(fixture);
    const approvalId = expireApproval(fixture, taskId);
    const before = fixture.ops.queue.get(taskId)!;
    const evidenceBefore = fixture.ops.queue.evidence.list(taskId).length;

    // This is exactly what `hq:dispatch-claude --check-only` calls.
    const verdict = claudeDispatchEligibility(fixture.ops, taskId);
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.code).toBe('approval_invalid');
    expect(verdict.details?.rejection).toBe('approval_expired');

    const after = fixture.ops.queue.get(taskId)!;
    expect(after.status).toBe(before.status);
    expect(after.approvalId).toBe(before.approvalId);
    expect(after.fence).toBe(before.fence);
    expect(after.claimedBy).toBeNull();
    expect(fixture.ops.queue.evidence.list(taskId)).toHaveLength(evidenceBefore);
    expect(approvalRow(fixture, approvalId)!.consumed_at).toBeNull();
  });
});
