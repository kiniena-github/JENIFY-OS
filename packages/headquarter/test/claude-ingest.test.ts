/**
 * The result correlation is reachable in the real flow (issue #224, ChatGPT P1
 * on `83e146b`).
 *
 * ## The defect
 *
 * `correlateClaudeResult` was implemented, tested and exported — and called by
 * nothing outside tests. The shipped commands were `hq:order`, `hq:snapshot` and
 * `hq:dispatch-claude`; the GitHub connector is read-only ingestion that knows
 * nothing about this lane. So after a successful dispatch the task stayed
 * `assigned` no matter what the workflow did, and the requirement that real
 * status and evidence come BACK to HQ was satisfied only in principle.
 *
 * ## What is asserted
 *
 * A report posted on the dispatched issue reaches the canonical task through the
 * shipped path; every hostile shape is refused; and correlation stays what it
 * claims to be — a record that a report ARRIVED, not a review, not a completion,
 * and not a channel for external text to enter the evidence log.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability, submitDirectOrder } from '../src/live/orders.js';
import { CLAUDE_DISPATCH_EVIDENCE, dispatchClaudeTask } from '../src/providers/claude/dispatch.js';
import { CLAUDE_RESULT_MARKER, findResultComment, ingestClaudeResult } from '../src/providers/claude/ingest.js';
import { parseIssueView } from '../src/providers/claude/transport.js';
import type {
  GitHubIssueComment,
  GitHubIssueReadResult,
  GitHubIssueRequest,
  GitHubIssueResult,
  GitHubIssueTransport,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';

const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' };
const OTHER_TARGET = { owner: 'kiniena-github', repo: 'jenify-news' };
const ISSUE = 4242;
const ISSUE_URL = `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/${ISSUE}`;
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

function comment(overrides: Partial<GitHubIssueComment> = {}): GitHubIssueComment {
  return {
    author: 'kiniena-github',
    body: `<!-- ${CLAUDE_RESULT_MARKER} -->\n## Claude Engineering / Review Report\n\nDone.`,
    url: `${ISSUE_URL}#issuecomment-1`,
    createdAt: '2026-08-29T12:00:00Z',
    ...overrides,
  };
}

/** A transport that publishes, and reports whatever comments the test supplies. */
function transport(options: { comments?: GitHubIssueComment[]; body?: string; read?: GitHubIssueReadResult } = {}) {
  const reads: number[] = [];
  const stub: GitHubIssueTransport & { reads: number[] } = {
    id: 'stub-gh',
    reads,
    status: (): GitHubTransportStatus => AUTHENTICATED,
    createIssue: (request: GitHubIssueRequest): GitHubIssueResult => ({
      ok: true,
      issueNumber: ISSUE,
      issueUrl: `https://github.com/${request.target.owner}/${request.target.repo}/issues/${ISSUE}`,
    }),
    readIssue: (_target, issueNumber): GitHubIssueReadResult => {
      reads.push(issueNumber);
      if (options.read) return options.read;
      return {
        ok: true,
        issue: {
          issueNumber,
          // The dispatched body carries the correlation block; `dispatchClaudeTask`
          // rendered the real one, so the test reuses whatever it produced.
          body: options.body ?? '',
          comments: options.comments ?? [],
        },
      };
    },
  };
  return stub;
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

/** Place, approve and dispatch an order. Returns the task id and the published body. */
function dispatched(fixture: Fixture): { taskId: string; body: string } {
  const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
  if (!placed.ok) throw new Error(`expected the order to be placed: ${placed.error.code}`);
  fixture.ops.approveTask({
    taskId: placed.data.task.id,
    founderId: 'chair',
    expectedActionDigest: taskActionDigest(placed.data.task),
  });
  let published = '';
  const publisher: GitHubIssueTransport = {
    id: 'stub-gh',
    status: (): GitHubTransportStatus => AUTHENTICATED,
    createIssue: (request: GitHubIssueRequest): GitHubIssueResult => {
      published = request.body;
      return { ok: true, issueNumber: ISSUE, issueUrl: ISSUE_URL };
    },
  };
  const sent = dispatchClaudeTask(fixture.ops, {
    executorWorkerId: EXECUTOR,
    taskId: placed.data.task.id,
    target: TARGET,
    transport: publisher,
  });
  if (!sent.ok) throw new Error(`expected a dispatch: ${sent.error.code}`);
  return { taskId: placed.data.task.id, body: published };
}

function correlations(fixture: Fixture, taskId: string) {
  return fixture.ops.queue.evidence
    .list(taskId)
    .filter((e) => e.kind === CLAUDE_DISPATCH_EVIDENCE.correlated);
}

describe('a report on the dispatched issue reaches the canonical task', () => {
  it('correlates it through the shipped path', () => {
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      transport: transport({ body, comments: [comment()] }),
    });

    if (!result.ok) throw new Error(`expected ok: ${result.error.code}`);
    expect(result.data.correlated).toBe(true);
    expect(result.data.issueNumber).toBe(ISSUE);
    expect(correlations(fixture, taskId)).toHaveLength(1);
  });

  it('reports "no result yet" as a success, not an error', () => {
    // This is meant to be run while work is outstanding. A poll that finds
    // nothing has not failed, and must not look like a failure.
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      transport: transport({ body, comments: [comment({ body: 'Looks good to me!' })] }),
    });

    if (!result.ok) throw new Error(`expected ok: ${result.error.code}`);
    expect(result.data.correlated).toBe(false);
    expect(result.data.reportUrl).toBeNull();
    expect(correlations(fixture, taskId)).toHaveLength(0);
  });

  it('does not record the same report twice', () => {
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);
    const stub = transport({ body, comments: [comment()] });

    expect(ingestClaudeResult(fixture.ops, { taskId, target: TARGET, transport: stub }).ok).toBe(true);
    const again = ingestClaudeResult(fixture.ops, { taskId, target: TARGET, transport: stub });

    if (!again.ok) throw new Error('expected ok');
    expect(again.data.correlated).toBe(false);
    expect(again.data.alreadyCorrelated).toBe(true);
    expect(correlations(fixture, taskId)).toHaveLength(1);
  });

  it('takes the LAST marked comment, so a correction supersedes its first report', () => {
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);
    const first = comment({ url: `${ISSUE_URL}#issuecomment-1` });
    const correction = comment({ url: `${ISSUE_URL}#issuecomment-9` });

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      transport: transport({ body, comments: [first, comment({ body: 'chatter' }), correction] }),
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.data.reportUrl).toBe(correction.url);
  });
});

describe('correlation records arrival — nothing more', () => {
  it('does not move the task status, review it, or complete it', () => {
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);
    const before = fixture.ops.queue.get(taskId)!;

    expect(
      ingestClaudeResult(fixture.ops, {
        taskId,
        target: TARGET,
        transport: transport({ body, comments: [comment()] }),
      }).ok,
    ).toBe(true);

    const after = fixture.ops.queue.get(taskId)!;
    expect(after.status).toBe(before.status);
    expect(after.reviewState).toBe(before.reviewState);
    expect(after.result).toBeNull();
  });

  it('never stores the report text in the evidence log', () => {
    // The comment body is written by whoever can comment on that issue. It is
    // read to identify a report and then discarded; only the issue, the verified
    // URL and the attested author are recorded.
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);
    const secretish = `<!-- ${CLAUDE_RESULT_MARKER} -->\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY`;

    expect(
      ingestClaudeResult(fixture.ops, {
        taskId,
        target: TARGET,
        transport: transport({ body, comments: [comment({ body: secretish })] }),
      }).ok,
    ).toBe(true);

    const recorded = JSON.stringify(correlations(fixture, taskId));
    expect(recorded).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCY');
    expect(recorded).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('refuses to record a comment URL that does not belong to this issue', () => {
    // External text that would become authoritative evidence is verified or
    // dropped — the same rule the reconciliation URL learned.
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);
    const foreign = comment({ url: 'https://github.com/someone/else/issues/1#issuecomment-5' });

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      transport: transport({ body, comments: [foreign] }),
    });

    if (!result.ok) throw new Error('expected ok');
    // Still correlated — the report is real — but the unverifiable URL is not
    // recorded as if HQ had checked it.
    expect(result.data.correlated).toBe(true);
    expect(result.data.reportUrl).toBeNull();
    expect(JSON.stringify(correlations(fixture, taskId))).not.toContain('someone/else');
  });

  it('refuses a URL for the right repository but the wrong issue', () => {
    const fixture = ordersFixture();
    const { taskId, body } = dispatched(fixture);
    const wrongIssue = comment({
      url: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/999#issuecomment-5`,
    });

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      transport: transport({ body, comments: [wrongIssue] }),
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.data.reportUrl).toBeNull();
  });
});

describe('it refuses to look where it should not', () => {
  it('refuses a task that was never dispatched', () => {
    const fixture = ordersFixture();
    const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
    if (!placed.ok) throw new Error('expected ok');
    const stub = transport();

    const result = ingestClaudeResult(fixture.ops, {
      taskId: placed.data.task.id,
      target: TARGET,
      transport: stub,
    });

    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('not_dispatched');
    expect(stub.reads).toHaveLength(0);
  });

  it('refuses an unknown task', () => {
    const fixture = ordersFixture();
    const result = ingestClaudeResult(fixture.ops, {
      taskId: 'no-such-task',
      target: TARGET,
      transport: transport(),
    });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('unknown_task');
  });

  it('refuses a repository that disagrees with what HQ recorded', () => {
    // Reading another repository's issue #4242 and attaching what it says to
    // this task is precisely the confusion the evidence log exists to prevent.
    const fixture = ordersFixture();
    const { taskId } = dispatched(fixture);
    const stub = transport({ comments: [comment()] });

    const result = ingestClaudeResult(fixture.ops, { taskId, target: OTHER_TARGET, transport: stub });

    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('target_mismatch');
    expect(stub.reads).toHaveLength(0);
  });

  it('refuses while a dispatch attempt is unresolved', () => {
    const fixture = ordersFixture();
    const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
    if (!placed.ok) throw new Error('expected ok');
    fixture.ops.approveTask({
      taskId: placed.data.task.id,
      founderId: 'chair',
      expectedActionDigest: taskActionDigest(placed.data.task),
    });
    const killed: GitHubIssueTransport = {
      id: 'stub-gh',
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => {
        throw new Error('killed mid-flight');
      },
    };
    dispatchClaudeTask(fixture.ops, {
      executorWorkerId: EXECUTOR,
      taskId: placed.data.task.id,
      target: TARGET,
      transport: killed,
    });

    const result = ingestClaudeResult(fixture.ops, {
      taskId: placed.data.task.id,
      target: TARGET,
      transport: transport({ comments: [comment()] }),
    });

    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('dispatch_outcome_unknown');
  });

  it('fails closed when the transport cannot read at all', () => {
    const fixture = ordersFixture();
    const { taskId } = dispatched(fixture);
    const writeOnly: GitHubIssueTransport = {
      id: 'write-only',
      status: (): GitHubTransportStatus => AUTHENTICATED,
      createIssue: (): GitHubIssueResult => ({ ok: true, issueNumber: ISSUE, issueUrl: ISSUE_URL }),
    };

    const result = ingestClaudeResult(fixture.ops, { taskId, target: TARGET, transport: writeOnly });

    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('transport_cannot_read');
  });

  it('reports a failed read rather than inferring "no result"', () => {
    // "I could not look" and "there is nothing there" are different facts, and
    // conflating them would quietly report an unfinished task as unstarted.
    const fixture = ordersFixture();
    const { taskId } = dispatched(fixture);

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      transport: transport({ read: { ok: false, kind: 'unavailable', message: 'no gh here' } }),
    });

    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('read_failed');
  });
});

describe('parsing `gh issue view` output', () => {
  it('reads a well-formed response', () => {
    const view = parseIssueView(
      JSON.stringify({
        number: ISSUE,
        body: 'the order',
        comments: [{ author: { login: 'kiniena-github' }, body: 'hello', url: ISSUE_URL, createdAt: 'now' }],
      }),
      ISSUE,
    );
    expect(view?.comments[0]).toMatchObject({ author: 'kiniena-github', body: 'hello' });
  });

  it('refuses a response describing a different issue', () => {
    expect(parseIssueView(JSON.stringify({ number: 7, body: '', comments: [] }), ISSUE)).toBeNull();
  });

  it('refuses unparseable output rather than guessing', () => {
    expect(parseIssueView('not json at all', ISSUE)).toBeNull();
    expect(parseIssueView('', ISSUE)).toBeNull();
  });

  it('survives malformed comment entries without throwing', () => {
    const view = parseIssueView(
      JSON.stringify({ number: ISSUE, comments: [null, 42, { body: 'no author' }] }),
      ISSUE,
    );
    expect(view?.body).toBe('');
    expect(view?.comments).toEqual([{ author: '', body: 'no author', url: '', createdAt: '' }]);
  });
});

describe('finding the report', () => {
  it('ignores comments without the marker', () => {
    expect(findResultComment([comment({ body: 'nice work' })])).toBeNull();
  });

  it('does not require the report to come from any particular login', () => {
    // Author is attribution GitHub reports, not a fact HQ can verify, so the
    // marker is the contract. Provider identity is enforced canonically, in
    // `correlateClaudeResult`, not by trusting a login string.
    expect(findResultComment([comment({ author: 'someone-else' })])).not.toBeNull();
  });
});
