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
import * as service from '../src/application/service.js';
import { writeDispatchOutcome } from '../src/application/service.js';
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

/**
 * HOSTILE, from the other side: forge the WRITER rather than the evidence.
 *
 * ChatGPT's blocking exact-head review of `ef88711`. The first Option B
 * implementation typed the capability as a TypeScript interface, which is
 * erased at runtime — so the exported lanes accepted any object of the right
 * shape and treated "the call did not throw" as proof the mandatory outcome had
 * been durably written.
 *
 * That is worse than the hole it replaced. A counterfeit that simply returns
 * lets `dispatchClaudeTask` take the canonical claim, START the execution and
 * PUBLISH A REAL GITHUB ISSUE while swallowing both `attempted` and
 * `succeeded`, leaving `dispatchHistory` at `none` beside a live public issue —
 * and licensing a later, entirely authorised dispatch to publish a second one.
 *
 * The counterfeits below are deliberately varied: a plain object, a `Proxy`
 * that answers anything, and an object built on the real prototype. All three
 * satisfy the old interface; none carries the private field.
 */
describe('a counterfeit dispatch-evidence capability cannot stand in for the real grant', () => {
  /** What the old interface required, and nothing more. */
  const plainCounterfeit = () => {
    const writes: unknown[] = [];
    return {
      writes,
      appendDispatchOutcome(entry: unknown) {
        // Swallows the mandatory write and reports success.
        writes.push(entry);
        return { seq: 1, at: new Date().toISOString(), actor: 'hq-claude-dispatch', kind: 'x', payload: {}, hash: 'x', prevHash: null };
      },
    };
  };

  /** Answers ANY property, so shape-based checks cannot distinguish it. */
  const proxyCounterfeit = () =>
    new Proxy(
      {},
      {
        get: () => () => ({ seq: 1, at: '', actor: 'hq-claude-dispatch', kind: 'x', payload: {}, hash: 'x', prevHash: null }),
        has: () => true,
      },
    );

  /** A frozen null-prototype object — the same SHAPE the real token has. */
  const lookalikeToken = () => Object.freeze(Object.create(null) as object);

  const counterfeits: ReadonlyArray<readonly [string, () => unknown]> = [
    ['a plain object of the right shape', plainCounterfeit],
    ['a Proxy that answers anything', proxyCounterfeit],
    ['an object shaped exactly like the real opaque token', lookalikeToken],
  ];

  for (const [label, make] of counterfeits) {
    it(`refuses ${label} before anything is claimed, started or published`, () => {
      const { fixture, taskId } = fixtureWithOrder();
      const before = fixture.ops.queue.get(taskId)!;
      const stub = transport();

      const result = dispatchClaudeTask(fixture.ops, {
        evidence: make() as never,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport: stub,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('evidence_grant_invalid');

      // The three facts that matter, none of them implied by the refusal alone.
      expect(stub.calls).toHaveLength(0); // nothing published
      expect(dispatchHistory(fixture.ops, taskId).state).toBe('none'); // history untouched
      const after = fixture.ops.queue.get(taskId)!;
      expect(after.status).toBe(before.status); // no claim, no start
      expect(after.claimedBy).toBe(before.claimedBy);
      expect(after.fence).toBe(before.fence);
      expect(fixture.ops.queue.evidence.verifyChain()).toBeNull();
    });
  }

  it('refuses a counterfeit at the reconciliation lane too', () => {
    const { fixture, taskId } = taskWithUnknownDispatch();
    const result = resolveUnknownDispatch(fixture.ops, {
      evidence: plainCounterfeit() as never,
      taskId,
      outcome: 'not_dispatched',
      resolvedBy: 'coo',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('evidence_grant_invalid');
    // The attempt is STILL unresolved — a counterfeit must not be able to
    // report a reconciliation the evidence log never received.
    expect(dispatchHistory(fixture.ops, taskId).state).toBe('unknown');
  });

  it('refuses a counterfeit at the ingest lane too', () => {
    const { fixture, taskId } = fixtureWithOrder();
    const stub = transport();
    expectOk(
      dispatchClaudeTask(fixture.ops, {
        evidence: fixture.dispatchEvidence,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport: stub,
      }),
    );

    const result = ingestClaudeResult(fixture.ops, {
      taskId,
      target: TARGET,
      evidence: plainCounterfeit() as never,
      transport: { id: 'stub-read', status: () => ({ available: true, authenticated: true, account: TARGET.owner, depth: 'live', observedFacts: [], missingFacts: [], reason: 'stub' }), readIssue: () => { throw new Error('must not be reached'); } } as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('evidence_grant_invalid');
  });

  /**
   * Instance binding. A GENUINE grant, but issued by a different service — so
   * someone able to construct a second `HeadquarterOperations` cannot mint a
   * real capability and present it alongside somebody else's `ops`.
   */
  it("refuses a genuine grant issued by a different HeadquarterOperations", () => {
    const victim = fixtureWithOrder();
    const other = setupFixture();
    const stub = transport();

    const result = dispatchClaudeTask(victim.fixture.ops, {
      evidence: other.dispatchEvidence,
      executorWorkerId: EXECUTOR,
      taskId: victim.taskId,
      target: TARGET,
      transport: stub,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('evidence_grant_invalid');
    expect(result.error.message).toMatch(/issued by a different HeadquarterOperations/);
    expect(stub.calls).toHaveLength(0);
    expect(dispatchHistory(victim.fixture.ops, victim.taskId).state).toBe('none');
  });

  /**
   * ChatGPT's blocking review of `26b3068`: the runtime brand was real, but it
   * lived behind an EXPORTED CLASS, and an exported class object is mutable.
   * Both routes were reproduced end to end on that head before this fix:
   *
   *   A. `DispatchEvidenceGrant.assertIssuedBy = () => {}` (a writable static),
   *      then the counterfeit from the previous round →
   *      issue published (1 createIssue), canonical history `none`.
   *   B. `DispatchEvidenceGrant.prototype.appendDispatchOutcome = () => {}`,
   *      then the GENUINE grant swallowed its own mandatory writes →
   *      issue published (1 createIssue), canonical history `none`.
   *
   * B is the one that matters most: the private-field brand was intact and
   * irrelevant, because the call resolved through a mutable prototype and never
   * went near it.
   *
   * These tests assert the attack SURFACES are gone rather than that a
   * particular patch fails, because a surface that does not exist cannot be
   * attacked in a way a future edit might slip past.
   */
  describe('the verifier and the writer are not patchable objects', () => {
    it('exports no runtime value to patch — the capability type is type-only', () => {
      // Attack A needed `DispatchEvidenceGrant.assertIssuedBy` to exist as a
      // writable property on an exported object. There is no such export now:
      // the class is gone and the type is erased.
      expect('DispatchEvidenceGrant' in service).toBe(false);
    });

    it('exports the verifier and writer as immutable module bindings', () => {
      // Attack A generalised: could an attacker replace what the provider lane
      // calls? An ES module namespace is sealed and its bindings are read-only,
      // which is exactly the guarantee a writable static could not give.
      for (const name of ['assertDispatchEvidenceGrant', 'writeDispatchOutcome'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(service, name);
        expect(descriptor?.writable ?? false).toBe(false);
        expect(() => {
          (service as unknown as Record<string, unknown>)[name] = () => undefined;
        }).toThrow();
      }
      // Not asserting `Object.isExtensible(service)`: whether the namespace
      // object accepts NEW properties varies with the module wrapper the test
      // runner uses, and it is not the property that matters. What matters is
      // that the EXISTING bindings the provider lanes import cannot be
      // replaced — which is what the two checks above pin.
    });

    it('hands out a token with no method and no prototype to poison', () => {
      // Attack B needed a method in the call path. The token has none: no own
      // properties, and a null prototype, so there is not even an inherited
      // `Object.prototype` in any lookup.
      const { fixture } = fixtureWithOrder();
      const token = fixture.dispatchEvidence as unknown as object;
      expect(Object.getPrototypeOf(token)).toBeNull();
      expect(Reflect.ownKeys(token)).toHaveLength(0);
      expect(Object.isFrozen(token)).toBe(true);
    });

    it('publishes and records normally even when a fake method is hung on the token', () => {
      // Attack B, attempted directly: give the token an `appendDispatchOutcome`
      // that swallows writes. It is frozen, so the assignment does not take —
      // and the lane would not have called it either, because the write path
      // does not dispatch through the token at all.
      const { fixture, taskId } = fixtureWithOrder();
      const token = fixture.dispatchEvidence as unknown as Record<string, unknown>;
      try {
        token.appendDispatchOutcome = () => undefined;
      } catch {
        // A frozen null-prototype object in strict mode: expected.
      }
      expect(token.appendDispatchOutcome).toBeUndefined();

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

      // The real writes landed: the issue exists AND the history records it.
      expect(receipt.issueNumber).toBe(ISSUE);
      expect(stub.calls).toHaveLength(1);
      expect(dispatchHistory(fixture.ops, taskId)).toMatchObject({ state: 'dispatched', issueNumber: ISSUE });
    });

    it('re-checks the grant at the write, so skipping the verifier reaches nothing', () => {
      // There is deliberately no single choke point to disable. Even a caller
      // that never goes through `assertDispatchEvidenceGrant` cannot write an
      // outcome with a capability this service did not issue.
      const { fixture, taskId } = fixtureWithOrder();
      const other = setupFixture();
      expect(() =>
        writeDispatchOutcome(fixture.ops, other.dispatchEvidence, {
          taskId,
          actor: 'hq-claude-dispatch',
          kind: CLAUDE_DISPATCH_EVIDENCE.failed,
          payload: { provider: 'CLAUDE', kind: 'rejected', message: 'cross-instance' },
        }),
      ).toThrow(/did not issue/);
      expect(dispatchHistory(fixture.ops, taskId).state).toBe('none');
    });
  });

  /**
   * The consequence, stated as the reviewer stated it: without this check the
   * counterfeit path ends in a duplicate public issue. Here the first dispatch
   * is refused outright, so the second — fully authorised, with the real grant —
   * is a FIRST publication and there is exactly one.
   */
  it('never lets a counterfeit leave a published issue with no canonical record', () => {
    const { fixture, taskId } = fixtureWithOrder();

    const counterfeitRun = transport();
    expect(
      dispatchClaudeTask(fixture.ops, {
        evidence: plainCounterfeit() as never,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport: counterfeitRun,
      }).ok,
    ).toBe(false);
    expect(counterfeitRun.calls).toHaveLength(0);

    const genuineRun = transport();
    const receipt = expectOk(
      dispatchClaudeTask(fixture.ops, {
        evidence: fixture.dispatchEvidence,
        executorWorkerId: EXECUTOR,
        taskId,
        target: TARGET,
        transport: genuineRun,
      }),
    );

    expect(receipt.issueNumber).toBe(ISSUE);
    expect(genuineRun.calls).toHaveLength(1);
    // Exactly one publication in total, and it IS recorded.
    expect(counterfeitRun.calls.length + genuineRun.calls.length).toBe(1);
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
