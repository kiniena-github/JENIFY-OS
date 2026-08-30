/**
 * The dispatch adapter writes the DURABLE half of the HQ identity (issue #224,
 * Codex P1 on `2dc86e8`).
 *
 * ## Why the adapter has to do this at all
 *
 * `routing/route.ts` refuses to re-trigger an issue JENIFY HQ dispatched. It used
 * to recognise one by a marker in the issue BODY — and HQ's issue is authored by
 * the repository OWNER, the same account the single-use boundary binds. Editing
 * your own issue body is an ordinary act, and it took the guard off.
 *
 * The durable half is the `jenify-hq-dispatch` LABEL. Applying it writes an
 * issue-timeline entry that no repository permission can delete, and that an
 * issue-body edit cannot reach; the workflows read that timeline. So the label
 * has to be on the issue from the moment the issue exists — a record the
 * workflow stamped later would leave a window in which the guard did not exist.
 *
 * That makes it the adapter's job, and unconditionally: a caller must not be
 * able to publish an HQ issue whose only identity is the erasable one.
 *
 * ## What is asserted
 *
 * The label is always applied; the repository is prepared for it first, and a
 * preparation that fails publishes NOTHING; and none of it disturbs the existing
 * refusal ordering.
 */

import { describe, expect, it } from 'vitest';
import { dispatchClaudeTask, dispatchHistory } from '../src/providers/claude/dispatch.js';
import { HQ_DISPATCH_LABEL, HQ_DISPATCH_MARKER } from '../src/routing/providers.js';
import { classifyExitFailure, DISPATCH_HOST, ghCliTransport } from '../src/providers/claude/transport.js';
import type {
  GitHubIssueRequest,
  GitHubIssueResult,
  DispatchCapableTransport,
  GitHubLabelResult,
  GitHubTarget,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';
import { setupFixture, expectOk, type Fixture } from './application.fixture.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability, submitDirectOrder } from '../src/live/orders.js';
import { taskActionDigest } from '../src/operator/approvals.js';

const TARGET = { owner: 'kiniena-github', repo: 'JENIFY-OS' } as const;
const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const EXECUTOR = 'claude-executor';

/**
 * A CLAUDE-bound direct order, Founder-approved by a second authorized human,
 * with the designated executor registered. Built through the canonical control
 * plane rather than by writing rows, so every gate this file leaves alone is
 * genuinely in place.
 */
function dispatchFixture(options: { approve?: boolean } = {}): { ops: Fixture['ops']; taskId: string } {
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
  if (options.approve !== false) {
    // No self-approval: the principal who opened it may not approve it.
    const task = fixture.ops.queue.get(taskId)!;
    expectOk(fixture.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: taskActionDigest(task) }));
  }
  return { ops: fixture.ops, taskId };
}

interface Recorder {
  issues: GitHubIssueRequest[];
  labels: { target: GitHubTarget; label: string; description: string }[];
  /** Call order, so "prepared BEFORE published" is a tested property. */
  order: string[];
}

function stub(options: {
  label?: GitHubLabelResult | 'throw';
  result?: GitHubIssueResult;
  status?: Partial<GitHubTransportStatus>;
}): DispatchCapableTransport & { rec: Recorder } {
  const rec: Recorder = { issues: [], labels: [], order: [] };
  const transport: DispatchCapableTransport & { rec: Recorder } = {
    id: 'stub',
    rec,
    status: () => ({
      available: true,
      authenticated: true,
      account: TARGET.owner,
      depth: 'live',
      observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
      missingFacts: [],
      reason: 'stub transport',
      ...options.status,
    }),
    createIssue: (request) => {
      rec.issues.push(request);
      rec.order.push('createIssue');
      return (
        options.result ?? {
          ok: true,
          issueNumber: 4242,
          issueUrl: `https://github.com/${TARGET.owner}/${TARGET.repo}/issues/4242`,
        }
      );
    },
    // Not assigned afterwards: a publishing transport must carry this from the
    // moment it exists, which is what `DispatchCapableTransport` now enforces.
    ensureLabel: (target, label, description) => {
      rec.labels.push({ target, label, description });
      rec.order.push('ensureLabel');
      if (options.label === 'throw') throw new Error('gh exploded');
      if (options.label == null) return { ok: true, created: true };
      return options.label;
    },
  };
  return transport;
}

describe('every dispatched issue carries the durable HQ label', () => {
  it('applies it, without the caller asking for it', () => {
    const { ops, taskId } = dispatchFixture();
    const transport = stub({});

    const result = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });

    expect(result.ok).toBe(true);
    expect(transport.rec.issues).toHaveLength(1);
    expect(transport.rec.issues[0]!.labels).toContain(HQ_DISPATCH_LABEL);
  });

  it('prepares the repository for the label BEFORE publishing anything', () => {
    // Order is the property, not merely that both happened: `gh` refuses a label
    // it cannot resolve, so ensuring it after publication would be ensuring it
    // for an issue that was never created.
    const { ops, taskId } = dispatchFixture();
    const transport = stub({});

    dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });

    expect(transport.rec.order).toEqual(['ensureLabel', 'createIssue']);
    expect(transport.rec.labels).toEqual([
      { target: TARGET, label: HQ_DISPATCH_LABEL, description: expect.any(String) },
    ]);
  });

  it('keeps caller-supplied labels, and does not send the HQ one twice', () => {
    const { ops, taskId } = dispatchFixture();
    const transport = stub({});

    dispatchClaudeTask(ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport,
      labels: ['ai-task', HQ_DISPATCH_LABEL],
    });

    expect(transport.rec.issues[0]!.labels).toEqual([HQ_DISPATCH_LABEL, 'ai-task']);
  });

  it('still carries the body marker, because the two sources are a union', () => {
    // Issues dispatched before the label existed have only the marker, so
    // dropping it would un-guard everything already in flight.
    const { ops, taskId } = dispatchFixture();
    const transport = stub({});

    dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });

    expect(transport.rec.issues[0]!.body).toContain(HQ_DISPATCH_MARKER);
  });
});

describe('a durable record that cannot be established publishes nothing', () => {
  it('refuses when the repository cannot be prepared for the label', () => {
    const { ops, taskId } = dispatchFixture();
    const transport = stub({ label: { ok: false, message: 'HTTP 403: Resource not accessible' } });

    const result = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('dispatch_label_unavailable');
    expect(transport.rec.issues).toHaveLength(0);
    // Nothing was reserved either, so a later legitimate dispatch is still a
    // FIRST dispatch rather than an unresolved attempt somebody must reconcile.
    expect(dispatchHistory(ops, taskId).state).toBe('none');
  });

  it('refuses when the transport throws preparing it', () => {
    const { ops, taskId } = dispatchFixture();
    const transport = stub({ label: 'throw' });

    const result = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('dispatch_label_unavailable');
    expect(transport.rec.issues).toHaveLength(0);
    expect(dispatchHistory(ops, taskId).state).toBe('none');
  });

  it('leaves the canonical task exactly as it was', () => {
    // The refusal happens before the reservation and before the claim, so the
    // Founder approval is NOT consumed and the task is still dispatchable once
    // the label problem is fixed.
    const { ops, taskId } = dispatchFixture();
    const before = ops.queue.get(taskId)!;

    dispatchClaudeTask(ops, {
      executorWorkerId: EXECUTOR,
      taskId,
      target: TARGET,
      transport: stub({ label: { ok: false, message: 'no' } }),
    });

    const after = ops.queue.get(taskId)!;
    expect(after.status).toBe(before.status);
    expect(after.claimedBy ?? null).toBe(before.claimedBy ?? null);

    // ...and the retry, with the label problem fixed, publishes normally.
    const healthy = stub({});
    expect(dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: healthy }).ok).toBe(
      true,
    );
    expect(healthy.rec.issues[0]!.labels).toContain(HQ_DISPATCH_LABEL);
  });

  it('accepts a label that already existed', () => {
    const { ops, taskId } = dispatchFixture();
    const transport = stub({ label: { ok: true, created: false } });

    expect(dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport }).ok).toBe(true);
    expect(transport.rec.issues[0]!.labels).toContain(HQ_DISPATCH_LABEL);
  });

  it('cannot be handed a transport that is unable to prepare the label', () => {
    // This test REPLACES one asserting the opposite (issue #224, ChatGPT P1 on
    // `72e4322`). `ensureLabel` used to be optional, on the argument that a
    // repository lacking the label would make `createIssue` fail rather than
    // publish unlabelled — so a transport without it was "not a hole".
    //
    // That argument assumed `gh` resolves labels BEFORE submitting the
    // creation, which is precisely what `classifyExitFailure` refuses to
    // assume. If any version applies them after, the "clean" failure had
    // already published an issue carrying only the erasable body marker, and
    // the retry it permitted published a second one.
    //
    // The guarantee is now structural: `DispatchCapableTransport` requires
    // `ensureLabel`, so the configuration the old test exercised does not
    // type-check. Asserted here as a runtime shape check, because a type
    // deleted later would otherwise take its own test with it.
    const transport = stub({});
    expect(typeof transport.ensureLabel).toBe('function');

    const { ops, taskId } = dispatchFixture();
    expect(dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport }).ok).toBe(true);
    // Prepared FIRST, then the issue carries it. Both, not either.
    expect(transport.rec.labels).toHaveLength(1);
    expect(transport.rec.issues[0]!.labels).toContain(HQ_DISPATCH_LABEL);
  });
});

describe('the durable identity has one spelling', () => {
  it('uses the same string as the body marker', () => {
    // A second name for the same fact is how the marker check and the label
    // check would drift apart, and a drifted guard is one that recognises HQ's
    // issues on one path and not the other. The shared evidence action greps for
    // this one string in BOTH the edit history and the label timeline, and
    // `routing-callers-supply-issue-body.test.ts` ties the shell literal to this
    // constant.
    expect(HQ_DISPATCH_LABEL).toBe(HQ_DISPATCH_MARKER);
  });
});

describe('the label step does not disturb the refusal ordering', () => {
  it('an ineligible task is refused before the label is even considered', () => {
    // Preparing a label is a repository WRITE. A task that was never going to be
    // dispatched must not cause one.
    const { ops, taskId } = dispatchFixture({ approve: false });
    const transport = stub({});

    const result = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('task_not_eligible');
    expect(transport.rec.labels).toHaveLength(0);
    expect(transport.rec.issues).toHaveLength(0);
  });

  it('an unauthenticated transport is refused before the label is considered', () => {
    const { ops, taskId } = dispatchFixture();
    const transport = stub({
      status: { authenticated: false, account: null, missingFacts: ['GH_AUTH_ACCOUNT'], reason: 'no session' },
    });

    const result = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('transport_unauthenticated');
    expect(transport.rec.labels).toHaveLength(0);
  });

  it('an issue that trips the credential guard costs no repository write', () => {
    // Ensuring the label is the first repository WRITE this function makes, so
    // it belongs after every check that can refuse — including the one that
    // reads the rendered body. A refusal must not leave a label behind for an
    // issue that was never going to exist.
    const { ops } = dispatchFixture();
    // `submitDirectOrder` refuses an obvious credential at creation, so the task
    // is written past that guard to reach the DISPATCH boundary's own check.
    const created = expectOk(
      ops.createTask({
        capabilityId: DIRECT_ORDER_CAPABILITY.id,
        payload: { kind: 'direct_order', instruction: 'deploy using api_key: "AKIA1234567890ABCDEF"', executionProvider: 'CLAUDE' },
        idempotencyKey: 'leaky-label-1',
        requestedBy: 'founder',
      }),
    );
    const leaky = ops.queue.get(created.task.id)!;
    expectOk(ops.approveTask({ taskId: leaky.id, founderId: 'coo', expectedActionDigest: taskActionDigest(leaky) }));
    const transport = stub({});

    const result = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId: leaky.id, target: TARGET, transport });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unsafe_issue');
    expect(transport.rec.labels).toHaveLength(0);
    expect(transport.rec.issues).toHaveLength(0);
  });

  it('a repeat dispatch is answered from evidence without preparing the label again', () => {
    const { ops, taskId } = dispatchFixture();
    const first = stub({});
    dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: first });

    const second = stub({});
    const repeat = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: second });

    expect(repeat.ok).toBe(true);
    expect(second.rec.issues).toHaveLength(0);
    expect(second.rec.labels).toHaveLength(0);
  });
});

/**
 * The `gh` adapter's half: what `ensureLabel` actually runs, and how it reads
 * the answers. Argument construction is asserted rather than described, because
 * this is the one method here that touches repository configuration.
 */
describe('the gh adapter prepares the label host-qualified and non-destructively', () => {
  function adapter(reply: { status: number | null; stdout?: string; stderr?: string; error?: Error }): {
    transport: ReturnType<typeof ghCliTransport>;
    seen: string[][];
  } {
    const seen: string[][] = [];
    const transport = ghCliTransport({
      ghPath: '/usr/bin/gh',
      spawnImpl: (_command, args) => {
        seen.push(args);
        return { status: reply.status, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', error: reply.error };
      },
    });
    return { transport, seen };
  }

  it('creates the label on the dispatch host, and never with --force', () => {
    // `--force` would overwrite an existing label's colour and description.
    // Ensuring a label exists is not a licence to edit repository configuration
    // somebody else set up.
    const { transport, seen } = adapter({ status: 0 });

    const result = transport.ensureLabel!(TARGET, HQ_DISPATCH_LABEL, 'why');

    expect(result).toEqual({ ok: true, created: true });
    expect(seen[0]).toEqual([
      'label',
      'create',
      HQ_DISPATCH_LABEL,
      '--repo',
      `${DISPATCH_HOST}/${TARGET.owner}/${TARGET.repo}`,
      '--description',
      'why',
    ]);
    expect(seen[0]).not.toContain('--force');
  });

  it('treats "already exists" as success, because the postcondition is existence', () => {
    const { transport } = adapter({ status: 1, stderr: 'X label with this name already exists' });
    expect(transport.ensureLabel!(TARGET, HQ_DISPATCH_LABEL, 'why')).toEqual({ ok: true, created: false });
  });

  it('reports any other non-zero exit as a failure, so the dispatch refuses', () => {
    const { transport } = adapter({ status: 1, stderr: 'HTTP 403: Resource not accessible by integration' });
    const result = transport.ensureLabel!(TARGET, HQ_DISPATCH_LABEL, 'why');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('403');
  });

  it('reports a process that could not be started as a failure', () => {
    const { transport } = adapter({ status: null, error: new Error('spawn ENOENT') });
    expect(transport.ensureLabel!(TARGET, HQ_DISPATCH_LABEL, 'why').ok).toBe(false);
  });

  it('refuses a malformed target without running anything', () => {
    const { transport, seen } = adapter({ status: 0 });
    expect(transport.ensureLabel!({ owner: 'a/b', repo: 'c' }, HQ_DISPATCH_LABEL, 'why').ok).toBe(false);
    expect(transport.ensureLabel!(TARGET, '  ', 'why').ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

/**
 * A label failure never licenses a retry (issue #224, ChatGPT P1 on `72e4322`).
 *
 * ## The defect
 *
 * `ensureLabel` was optional, on the argument that a repository lacking the
 * label would make `createIssue` FAIL rather than publish an unlabelled issue.
 * That argument assumed `gh` resolves labels BEFORE submitting the creation.
 *
 * This module already refuses that assumption elsewhere: `classifyExitFailure`
 * was written so that only failures PROVEN to precede submission are terminal,
 * precisely because whether `gh` validates a label before or after creating the
 * issue is version-dependent. But `gh` reports a missing label as
 * `could not add label: 'x' not found`, and the generic `/\bnot found\b/i` in
 * `PROVEN_NOT_SUBMITTED` matched it — so the label case classified as
 * `rejected`, a terminal failure that closes the attempt and permits a retry.
 *
 * If any `gh` version applies labels after creating the issue, that retry
 * publishes a SECOND public issue while the first exists carrying only the
 * erasable body marker — the exact artefact the label was added to prevent, and
 * the exact duplicate the outcome-unknown design exists to prevent.
 *
 * ## What is asserted
 *
 * A label failure is outcome-UNKNOWN, and an attempt left unknown blocks the
 * next dispatch instead of letting it publish again.
 */
describe('a label failure is never proven-not-submitted', () => {
  const LABEL_FAILURES = [
    "could not add label: 'jenify-hq-dispatch' not found",
    "HTTP 422: could not add label: 'jenify-hq-dispatch' not found",
    'could not resolve label jenify-hq-dispatch',
    "label 'jenify-hq-dispatch' not found",
  ];

  it('classifies every shape of it as outcome-unknown, not rejected', () => {
    for (const detail of LABEL_FAILURES) {
      const verdict = classifyExitFailure(1, detail);
      expect(verdict.kind, detail).toBe('unreadable_response');
    }
  });

  it('still classifies a genuinely-not-submitted failure as rejected', () => {
    // The guard must not become "everything is unknown", which would strand
    // every real rejection as an attempt needing human reconciliation.
    expect(classifyExitFailure(1, 'GraphQL: Could not resolve to a Repository with the name').kind).toBe(
      'rejected',
    );
    expect(classifyExitFailure(1, 'HTTP 404: Not Found').kind).toBe('rejected');
  });

  it('leaves the attempt OPEN, so the next dispatch cannot publish a duplicate', () => {
    // The whole point, driven end to end rather than asserted on the classifier:
    // the issue may already exist, so the next dispatch must refuse rather than
    // create a second one.
    const { ops, taskId } = dispatchFixture();
    const failing = stub({
      result: {
        ok: false,
        kind: 'unreadable_response',
        message: "The GitHub CLI exited 1. could not add label: 'jenify-hq-dispatch' not found",
      },
    });

    const first = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: failing });
    expect(first.ok).toBe(false);

    // The attempt is outstanding, NOT failed — nothing proved the issue absent.
    expect(dispatchHistory(ops, taskId).state).toBe('unknown');

    const second = stub({});
    const retry = dispatchClaudeTask(ops, { executorWorkerId: EXECUTOR, taskId, target: TARGET, transport: second });

    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.error.code).toBe('dispatch_outcome_unknown');
    // Nothing was published the second time. That is the duplicate that is not.
    expect(second.rec.issues).toHaveLength(0);
  });
});
