/**
 * Reconciling an uncertain dispatch must validate the issue URL it records
 * (issue #224, Codex P2 on `f9383dc`).
 *
 * ## The defect
 *
 * `resolveUnknownDispatch({ outcome: 'found', ... })` validated only the
 * separately-supplied target and issue number, then stored `issueUrl`
 * verbatim as `claude_github_dispatch_succeeded` evidence. So a
 * reconciliation could close an uncertain attempt with a URL pointing at
 * another repository, or at a different issue in the right one.
 *
 * That URL is not decoration. It becomes the authoritative dispatch evidence,
 * it is what `answerAlreadyDispatched` hands back — instead of publishing
 * again — for every later duplicate dispatch, and it is what an operator opens
 * to confirm the work actually exists. A wrong link there sends someone to the
 * wrong issue while HQ reports the task dispatched.
 *
 * The fix reuses `parseIssueUrl`, the same target-scoped parser the transport
 * applies to a real creation, so the reconciliation path and the live path
 * agree about what counts as this repository's issue URL — and additionally
 * requires the parsed number to equal the supplied one.
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

/** Drive a task into the `unknown` dispatch state, which is what reconciliation exists for. */
function taskWithUnknownDispatch(fixture: Fixture): string {
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
  dispatchClaudeTask(fixture.ops, { taskId: placed.data.task.id, target: TARGET, transport: throwing });
  expect(dispatchHistory(fixture.ops, placed.data.task.id).state).toBe('unknown');
  return placed.data.task.id;
}

describe('a reconciliation records only a URL that matches what it claims', () => {
  it('accepts the genuine issue URL and closes the attempt', () => {
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
    if (!resolved.ok) throw new Error(`expected ok: ${resolved.error.code}`);
    expect(resolved.data.issueUrl).toBe(GOOD_URL);
    const history = dispatchHistory(fixture.ops, taskId);
    expect(history.state).toBe('dispatched');
    if (history.state !== 'dispatched') throw new Error('unreachable');
    expect(history.issueUrl).toBe(GOOD_URL);
  });

  it('accepts a differently-cased repository, since GitHub identity is case-insensitive', () => {
    const fixture = ordersFixture();
    const taskId = taskWithUnknownDispatch(fixture);
    const resolved = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: `https://github.com/KINIENA-GITHUB/jenify-os/issues/${ISSUE}`,
      resolvedBy: 'chair',
    });
    expect(resolved.ok).toBe(true);
  });

  const hostile: Array<{ name: string; url: string | undefined }> = [
    {
      name: 'a URL for another repository',
      url: `https://github.com/someone-else/other-repo/issues/${ISSUE}`,
    },
    {
      name: 'a URL for another issue in the right repository',
      url: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/9999`,
    },
    {
      name: 'a URL on another host',
      url: `https://github.enterprise.invalid/${TARGET.owner}/${TARGET.repo}/issues/${ISSUE}`,
    },
    { name: 'a pull-request URL rather than an issue URL', url: `https://github.com/${TARGET.owner}/${TARGET.repo}/pull/${ISSUE}` },
    { name: 'text that is not a URL at all', url: 'I checked and it is there, honest' },
    { name: 'an empty URL', url: '' },
    { name: 'no URL at all', url: undefined },
  ];

  for (const attempt of hostile) {
    it(`refuses ${attempt.name}, and records nothing`, () => {
      const fixture = ordersFixture();
      const taskId = taskWithUnknownDispatch(fixture);
      const resolved = resolveUnknownDispatch(fixture.ops, {
        taskId,
        outcome: 'found',
        target: TARGET,
        issueNumber: ISSUE,
        issueUrl: attempt.url as string,
        resolvedBy: 'chair',
      });
      expect(resolved.ok, attempt.name).toBe(false);
      if (resolved.ok) throw new Error('unreachable');
      expect(resolved.error.code).toBe('invalid_target');
      // The attempt stays OPEN, which is the safe state: the next dispatch
      // still refuses with dispatch_outcome_unknown rather than duplicating.
      expect(dispatchHistory(fixture.ops, taskId).state, attempt.name).toBe('unknown');
    });
  }

  it('leaves a refused reconciliation reconcilable, with the right URL', () => {
    // The refusal must not poison the attempt: a human who mistyped can still
    // close it correctly.
    const fixture = ordersFixture();
    const taskId = taskWithUnknownDispatch(fixture);
    resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: 'https://github.com/someone-else/other-repo/issues/1',
      resolvedBy: 'chair',
    });
    const second = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'found',
      target: TARGET,
      issueNumber: ISSUE,
      issueUrl: GOOD_URL,
      resolvedBy: 'chair',
    });
    expect(second.ok).toBe(true);
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('dispatched');
  });

  it('still lets a not_dispatched reconciliation through without a URL', () => {
    // That outcome records a failure and names no issue, so the URL rule
    // must not apply to it.
    const fixture = ordersFixture();
    const taskId = taskWithUnknownDispatch(fixture);
    const resolved = resolveUnknownDispatch(fixture.ops, {
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'chair',
      note: 'Checked the repository; no issue exists.',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.error.code).toBe('transport_failed');
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
  });
});
