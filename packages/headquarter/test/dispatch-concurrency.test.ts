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
 * ## B — a queue worker that could claim what was just published
 *
 * Publishing hands the instruction to the GitHub workflow but does NOT claim
 * the canonical task: it stays `queued` with its approval nonce unconsumed. A
 * worker declared as CLAUDE polling the same capability can therefore claim and
 * execute the same approved action, while the workflow executes the published
 * copy bound to no fence and no consumed approval.
 *
 * The guard here refuses the dispatch in that configuration rather than
 * publishing into the race. It is deliberately narrow — it removes a dispatch,
 * never adds one, and invents no worker identity and no status. It does not
 * close the underlying design question (how a non-worker executor binds to a
 * queue fence), which is raised on the PR instead.
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
  GitHubIssueTransport,
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
  const throwing: GitHubIssueTransport = {
    id: 'stub-gh',
    status: (): GitHubTransportStatus => AUTHENTICATED,
    createIssue: (): GitHubIssueResult => {
      throw new Error('killed mid-flight');
    },
  };
  dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport: throwing });
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

describe('a task a queue worker could claim is not published into the race', () => {
  it('refuses dispatch when a worker is declared as CLAUDE', () => {
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    fixture.ops.declareWorkerProvider({
      workerId: 'claude-worker',
      providerId: 'CLAUDE',
      founderId: 'chair',
    });

    const verdict = claudeDispatchEligibility(fixture.ops, taskId);
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.code).toBe('queue_worker_conflict');
    expect(verdict.message).toContain('claude-worker');
    // And it names the actual hazard rather than a generic refusal.
    expect(verdict.message).toContain('execute twice');
  });

  it('publishes nothing in that configuration', () => {
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    fixture.ops.declareWorkerProvider({
      workerId: 'claude-worker',
      providerId: 'CLAUDE',
      founderId: 'chair',
    });
    const calls: unknown[] = [];
    const transport: GitHubIssueTransport = {
      id: 'stub-gh',
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (request): GitHubIssueResult => {
        calls.push(request);
        return { ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL };
      },
    };
    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
    // The task is untouched and still the worker's to claim, which is the
    // other half of "decide which lane executes this".
    expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('is not triggered by a worker declared as another provider', () => {
    // The guard must be about THIS provider's queue lane, not about workers in
    // general — a CODEX worker can never claim a CLAUDE-bound task anyway.
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    fixture.ops.declareWorkerProvider({
      workerId: 'codex-worker',
      providerId: 'CODEX',
      founderId: 'chair',
    });
    expect(claudeDispatchEligibility(fixture.ops, taskId).eligible).toBe(true);
  });

  it('dispatches normally when no CLAUDE worker is declared — the intended setup', () => {
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    const transport: GitHubIssueTransport = {
      id: 'stub-gh',
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => ({ ok: true, issueNumber: ISSUE, issueUrl: GOOD_URL }),
    };
    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(true);
  });

  it('refuses again if the declaration appears between eligibility and publication', () => {
    // Eligibility is re-asked inside the reservation, so the guard travels with
    // it rather than being a one-time check at the top.
    const fixture = ordersFixture();
    const taskId = approvedTask(fixture);
    const transport: GitHubIssueTransport = {
      id: 'stub-gh',
      status: (): GitHubTransportStatus => {
        // The declaration lands during the (slow) transport check.
        fixture.ops.declareWorkerProvider({
          workerId: 'claude-worker',
          providerId: 'CLAUDE',
          founderId: 'chair',
        });
        return AUTHENTICATED;
      },
      createIssue: (): GitHubIssueResult => {
        throw new Error('must not publish');
      },
    };
    const result = dispatchClaudeTask(fixture.ops, { taskId, target: TARGET, transport });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('queue_worker_conflict');
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
  });
});
