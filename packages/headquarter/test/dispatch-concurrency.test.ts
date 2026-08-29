/**
 * Two ways one canonical task could end up executed or recorded twice
 * (issue #224, Codex P1 ×2 on `172026f`).
 *
 * ## A — concurrent reconciliations
 *
 * The unknown-state check and the terminal append were separate steps, so two
 * operators reconciling the same attempt could both pass the check. A
 * `not_dispatched` resolution appends `failed`, which licenses a fresh dispatch
 * to reserve and publish a SECOND issue, while the concurrent `found`
 * resolution records the original issue as succeeded. One task, two published
 * issues, and contradictory terminal evidence in an append-only log that cannot
 * be edited to sort it out afterwards.
 *
 * ## B — a published task that stayed independently claimable
 *
 * Publishing used to hand the instruction to the GitHub workflow WITHOUT
 * claiming the canonical task: it stayed `queued` with its approval nonce
 * unconsumed, so a worker declared as CLAUDE could claim and execute the same
 * approved action while the workflow executed the published copy, bound to no
 * fence and no consumed approval.
 *
 * Per the Founder decision approving option 1, the handoff now takes the
 * canonical claim for an explicitly designated, separately registered executor
 * worker, inside the same transaction as the dispatch reservation. Dispatch
 * never mints, guesses or assumes that identity — it is named by the caller and
 * registered elsewhere — and every way the claim can fail publishes nothing.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import {
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';
import {
  claudeDispatchEligibility,
  dispatchClaudeTask,
  dispatchHistory,
  resolveUnknownDispatch,
} from '../src/providers/claude/dispatch.js';
import type {
  GitHubIssueResult,
  DispatchCapableTransport,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';

const CLAUDE_ROUTING = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' };
const ISSUE = 4242;
const GOOD_URL = `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/${ISSUE}`;

const AUTHENTICATED: GitHubTransportStatus = {
  available: true,
  authenticated: true,
  account: 'kiniena-github',
  depth: 'live',
  observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
  missingFacts: [],
  reason: 'authenticated',
};

const ORDER = {
  instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
  project: 'mesob',
  route: 'CLAUDE' as const,
  requestedBy: 'founder',
};

/** The designated executor: two explicit configuration acts, never minted by dispatch. */
const EXECUTOR = 'claude-executor';
function registerExecutor(fixture: Fixture): void {
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
  fixture.principals.register({
    id: 'chair',
    displayName: 'Chair',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  registerExecutor(fixture);
  return fixture;
}

/** An approved, queued, CLAUDE-bound task — the state dispatch acts on. */
function approvedTask(fixture: Fixture): string {
  const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
  if (!placed.ok) throw new Error('expected ok');
  fixture.ops.approveTask({
    taskId: placed.data.task.id,
    founderId: 'chair',
    expectedActionDigest: taskActionDigest(placed.data.task),
  });
  return placed.data.task.id;
}

function taskWithUnknownDispatch(fixture: Fixture): string {
  const taskId = approvedTask(fixture);
  const throwing: DispatchCapableTransport = {
    id: 'stub-gh',
    ensureLabel: () => ({ ok: true, created: false }),
    status: (): GitHubTransportStatus => AUTHENTICATED,
    createIssue: (): GitHubIssueResult => {
      throw new Error('killed mid-flight');
    },
  };
  dispatchClaudeTask(fixture.ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: throwing });
  expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  return taskId;
}

describe('exactly one reconciliation of an uncertain attempt wins', () => {
  it('refuses a second reconciliation that arrives after the first', () => {
    const fixture = ordersFixture();
    const taskId = taskWithUnknownDispatch(fixture);

    const first = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: GOOD_URL,
      resolvedBy: 'chair',
    });
    expect(first.ok).toBe(true);

    // The contradictory one: "actually nothing was created".
    const second = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'founder',
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('task_not_eligible');

    // One terminal record, and it is the first decision.
    const history = dispatchHistory(fixture.ops, taskId);
    expect(history.state).toBe('dispatched');
    const terminals = fixture.ops.queue.evidence
      .list(taskId)
      .filter((entry) =>
        entry.kind === 'claude_github_dispatch_succeeded' ||
        entry.kind === 'claude_github_dispatch_failed',
      );
    expect(terminals).toHaveLength(1);
  });

  it('refuses the reverse order too — not_dispatched first, found second', () => {
    const fixture = ordersFixture();
    const taskId = taskWithUnknownDispatch(fixture);

    const first = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'chair',
    });
    // `not_dispatched` reports through a refusal by design; what matters is
    // that it CLOSED the attempt.
    expect(first.ok).toBe(false);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');

    const second = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: GOOD_URL,
      resolvedBy: 'founder',
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('task_not_eligible');
    // Still exactly one terminal record.
    expect(
      fixture.ops.queue.evidence
        .list(taskId)
        .filter((entry) =>
          entry.kind === 'claude_github_dispatch_succeeded' ||
          entry.kind === 'claude_github_dispatch_failed',
        ),
    ).toHaveLength(1);
  });

  /**
   * The interleaving itself, driven rather than described: a full competing
   * reconciliation lands between the caller's read and its write.
   */
  it('re-reads the state INSIDE the transaction, not before waiting for it', () => {
    const fixture = ordersFixture();
    const taskId = taskWithUnknownDispatch(fixture);

    const realList = fixture.ops.queue.evidence.list.bind(fixture.ops.queue.evidence);
    let raced = false;
    // Fire the competing resolution during the FIRST history read, which is the
    // read-only pre-check — so the caller enters its transaction believing the
    // attempt is still unresolved.
    (fixture.ops.queue.evidence as unknown as { list: typeof realList }).list = ((
      id?: string,
    ) => {
      const rows = realList(id);
      if (!raced) {
        raced = true;
        (fixture.ops.queue.evidence as unknown as { list: typeof realList }).list = realList;
        resolveUnknownDispatch(fixture.ops, {
          taskId,
          outcome: 'not_dispatched',
          resolvedBy: 'founder',
        });
      }
      return rows;
    }) as typeof realList;

    const loser = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: GOOD_URL,
      resolvedBy: 'chair',
    });
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error('unreachable');
    expect(loser.error.code).toBe('task_not_eligible');
    expect(
      fixture.ops.queue.evidence
        .list(taskId)
        .filter((entry) => entry.kind === 'claude_github_dispatch_succeeded'),
    ).toHaveLength(0);
  });

  it('still lets a genuine single reconciliation through', () => {
    const fixture = ordersFixture();
    const taskId = taskWithUnknownDispatch(fixture);
    const resolved = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: GOOD_URL,
      resolvedBy: 'chair',
    });
    expect(resolved.ok).toBe(true);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('dispatched');
  });
});

describe('the handoff claims the canonical task before publishing', () => {
  it('leaves the task assigned to the designated executor, not independently claimable', () => {
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    const transport: DispatchCapableTransport = {
      id: 'stub-gh',
      ensureLabel: () => ({ ok: true, created: false }),
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => ({ ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL }),
    };
    expect(dispatchClaudeTask(fixture.ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport }).ok).toBe(true);

    const task = fixture.ops.queue.get(taskId)!;
    // `running`, not `assigned` (issue #224, dispositioning the double-execution
    // limitation). The claim alone left it `assigned`, and `sweepExpiredLeases`
    // sends a side-effect task to `outcome_unknown` only from `running` — from
    // `assigned` it RE-QUEUES. So an expired handoff lease landed the task in
    // `queued` carrying a consumed approval: unclaimable, un-re-approvable, and
    // reading as "waiting to run". Publication really has started an execution,
    // so `start` says the true thing and the sweep then does what the docs
    // already promised.
    expect(task.status).toBe('running');
    expect(task.claimedBy).toBe(EXECUTOR);
    // The defect this closes: another worker could previously claim and execute
    // the same approved action while the workflow ran the published copy.
    expect(fixture.ops.queue.selectClaimable(EXECUTOR, task.capabilityId).task).toBeNull();
    expect(fixture.ops.queue.claim(EXECUTOR, task.capabilityId)).toBeNull();
  });

  it('consumes the single-use approval, so the published action cannot run twice', () => {
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    const transport: DispatchCapableTransport = {
      id: 'stub-gh',
      ensureLabel: () => ({ ok: true, created: false }),
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => ({ ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL }),
    };
    dispatchClaudeTask(fixture.ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });
    const approval = fixture.ops.queue.approvalFor(taskId);
    // Bound to this claim, and spent: the external execution is answerable to
    // the same approval an internal one would have been.
    expect(approval?.consumedAt).not.toBeNull();
  });

  it('publishes nothing when the designated executor cannot claim', () => {
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    const calls: unknown[] = [];
    const transport: DispatchCapableTransport = {
      id: 'stub-gh',
      ensureLabel: () => ({ ok: true, created: false }),
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (request): GitHubIssueResult => {
        calls.push(request);
        return { ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL };
      },
    };
    const result = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: 'nobody-registered',
      taskId,
      target: TARGET,
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('executor_not_claimable');
    expect(calls).toHaveLength(0);
    // The transaction rolled back: the task is exactly as it was.
    const task = fixture.ops.queue.get(taskId)!;
    expect(task.status).toBe('queued');
    expect(task.claimedBy).toBeNull();
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
  });

  it('refuses a worker that is not declared as this provider, and publishes nothing', () => {
    // Dispatch never assumes an identity: a registered worker that is not
    // CLAUDE cannot carry a CLAUDE-bound task, and provider binding says so at
    // the canonical boundary.
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    fixture.store.upsertSpecialist({
      id: 'codex-worker',
      displayName: 'Codex',
      vendor: 'openai',
      role: 'build_lead',
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      active: true,
    });
    fixture.ops.declareWorkerProvider({
      workerId: 'codex-worker',
      providerId: 'CODEX',
      founderId: 'chair',
    });
    const calls: unknown[] = [];
    const transport: DispatchCapableTransport = {
      id: 'stub-gh',
      ensureLabel: () => ({ ok: true, created: false }),
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (request): GitHubIssueResult => {
        calls.push(request);
        return { ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL };
      },
    };
    const result = dispatchClaudeTask(fixture.ops, {
      executorWorkerId: 'codex-worker',
      taskId,
      target: TARGET,
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('executor_not_claimable');
    expect(calls).toHaveLength(0);
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('refuses an inactive executor, and publishes nothing', () => {
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    fixture.store.upsertSpecialist({
      id: EXECUTOR,
      displayName: 'Claude GitHub workflow',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      active: false,
    });
    const calls: unknown[] = [];
    const transport: DispatchCapableTransport = {
      id: 'stub-gh',
      ensureLabel: () => ({ ok: true, created: false }),
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (request): GitHubIssueResult => {
        calls.push(request);
        return { ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL };
      },
    };
    const result = dispatchClaudeTask(fixture.ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('claims THIS task, never whatever happens to be next in the queue', () => {
    // A handoff that seized an unrelated order would be the same class of
    // defect wearing different clothes.
    const fixture = ordersFixture();
    const first = approvedTask(fixture);
    const second = submitDirectOrder(
      fixture.ops,
      { ...ORDER, instruction: 'A second, different order.' },
      CLAUDE_ROUTING,
    );
    if (!second.ok) throw new Error('expected ok');
    fixture.ops.approveTask({
      taskId: second.data.task.id,
      founderId: 'chair',
      expectedActionDigest: taskActionDigest(second.data.task),
    });

    const transport: DispatchCapableTransport = {
      id: 'stub-gh',
      ensureLabel: () => ({ ok: true, created: false }),
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => ({ ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL }),
    };
    // Dispatch the SECOND one while the first is older and also claimable.
    expect(
      dispatchClaudeTask(fixture.ops, {
        executorWorkerId: EXECUTOR,
        taskId: second.data.task.id,
        target: TARGET,
        transport,
      }).ok,
    ).toBe(true);

    expect(fixture.ops.queue.get(second.data.task.id)!.status).toBe('running');
    // The older one is untouched.
    expect(fixture.ops.queue.get(first)!.status).toBe('queued');
    expect(fixture.ops.queue.get(first)!.claimedBy).toBeNull();
  });
});
