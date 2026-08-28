/**
 * Provider binding is an EXECUTION authority (issue #200, Codex P1 #1).
 *
 * The defect under regression here: a direct order resolved its route
 * truthfully and refused to substitute at creation time, but the resolved
 * provider was only payload metadata. `claim()` hands out the head-of-queue
 * task for a capability to any allowed worker, so an order explicitly routed
 * to CLAUDE could be claimed, started and executed by a CODEX worker out of the
 * shared `hq.direct_order` queue. No-substitution held at the front door and
 * evaporated at the back one.
 *
 * Every test below is hostile: it is the wrong worker trying to take work that
 * was not routed to it, or an undeclared one trying to take work at all.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import {
  checkProviderBinding,
  EXECUTION_PROVIDER_KEY,
  ProviderBindingViolation,
  readProviderBinding,
} from '../src/operator/provider-binding.js';
import {
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const BOTH_PROVIDERS = {
  ...CLAUDE_ONLY,
  CODEX_CLI_PATH: '/usr/local/bin/codex',
  CODEX_AUTH_MODE: 'subscription',
};

/**
 * Two workers that may both hold `hq.direct_order`, declared as different
 * providers. This is exactly the shape the finding describes: one shared
 * capability, two providers, one queue.
 */
function bindingFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  for (const id of ['claude-worker', 'codex-worker', 'undeclared-worker']) {
    fixture.store.upsertSpecialist({
      id,
      displayName: id,
      vendor: 'test',
      role: 'parallel_implementer',
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id, CAPS.readStatus],
      active: true,
    });
  }
  // Provider identity is DECLARED, never inferred from a vendor string — and
  // declaring it is an authorized configuration act, not something reachable
  // from a queue handle (Codex round-3 P1 #1).
  expectOk(
    fixture.ops.declareWorkerProvider({
      workerId: 'claude-worker',
      providerId: 'CLAUDE',
      founderId: 'founder',
    }),
  );
  expectOk(
    fixture.ops.declareWorkerProvider({
      workerId: 'codex-worker',
      providerId: 'CODEX',
      founderId: 'founder',
    }),
  );
  return fixture;
}

/** Create a routed order and get it past the Founder gate into `queued`. */
function queuedOrder(
  fixture: Fixture,
  route: 'CLAUDE' | 'CODEX',
  instruction: string,
  env: Record<string, string> = CLAUDE_ONLY,
): string {
  const result = submitDirectOrder(
    fixture.ops,
    { instruction, project: 'mesob', route, requestedBy: 'founder' },
    env,
  );
  if (!result.ok) throw new Error(`expected an order, got ${result.error.code}`);
  const taskId = result.data.task.id;
  const card = founderConsole(fixture.ops).approvals.find((a) => a.taskId === taskId)!;
  // No self-approval: the founder opened it, so a second authorized human decides.
  expectOk(
    fixture.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: card.actionDigest }),
  );
  expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
  return taskId;
}

function queuedClaudeOrder(fixture: Fixture): string {
  return queuedOrder(fixture, 'CLAUDE', 'Draft the Q3 maintenance plan for the Mesob line.');
}

describe('an order routed to one provider cannot be executed by another', () => {
  it('refuses the wrong provider at claim, and creates no assignment', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);

    const stolen = fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(stolen.ok).toBe(false);
    if (stolen.ok) throw new Error('unreachable');
    expect(stolen.error.code).toBe('provider_binding_mismatch');
    expect(stolen.error.details).toMatchObject({
      requiredProvider: 'CLAUDE',
      workerProvider: 'CODEX',
    });

    const task = fx.ops.queue.get(taskId)!;
    expect(task.status).toBe('queued');
    expect(task.claimedBy).toBeNull();
    expect(task.fence).toBe(0);
  });

  it('refuses the wrong provider at the queue itself, not merely in the service layer', () => {
    // The canonical boundary must hold for a caller that never goes through
    // HeadquarterOperations at all.
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    expect(() => fx.ops.queue.claim('codex-worker', DIRECT_ORDER_CAPABILITY.id)).toThrow(
      ProviderBindingViolation,
    );
    expect(fx.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('does not burn the single-use approval on a refused claim', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    expect(fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id).ok).toBe(false);
    // The right worker can still claim: the approval nonce was never consumed.
    const claimed = expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id));
    expect(claimed.id).toBe(taskId);
    expect(claimed.claimedBy).toBe('claude-worker');
    expectOk(fx.ops.startTask(taskId, 'claude-worker', claimed.fence));
  });

  it('records the refusal in the hash-chained evidence log', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    const kinds = fx.ops.queue.evidence.list().map((entry) => entry.kind);
    expect(kinds).toContain('provider_binding_rejected');
  });
});

describe('deny by default: an undeclared worker holds no provider', () => {
  it('refuses a worker with no declared execution provider', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    const result = fx.ops.claimNext('undeclared-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_binding_mismatch');
    expect(result.error.details).toMatchObject({ workerProvider: null });
  });

  it('refuses everyone when the binding itself is malformed', () => {
    const fx = bindingFixture();
    // A payload that names no usable provider must strand the task rather than
    // fall open to whoever asks first.
    for (const malformed of [null, '', '   ', 42, { provider: 'CLAUDE' }]) {
      const binding = readProviderBinding({ [EXECUTION_PROVIDER_KEY]: malformed });
      expect(binding.bound).toBe(true);
      expect(checkProviderBinding('t', 'claude-worker', binding, 'CLAUDE')).toBeInstanceOf(
        ProviderBindingViolation,
      );
    }
    // And a revoked declaration takes effect immediately.
    expectOk(fx.ops.revokeWorkerProvider({ workerId: 'claude-worker', founderId: 'founder' }));
    expect(fx.ops.queue.workerProviders.providerOf('claude-worker')).toBeNull();
  });

  it('leaves an unbound task alone — the binding narrows, it never widens', () => {
    const fx = bindingFixture();
    // A capability with no executionProvider in its payload behaves exactly as
    // before: this must not become a new gate on the rest of the system.
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'JENIFY-OS' },
        requestedBy: 'claude',
      }),
    );
    expect(readProviderBinding({ repo: 'JENIFY-OS' }).bound).toBe(false);
    expect(expectOk(fx.ops.claimNext('undeclared-worker', CAPS.readStatus)).claimedBy).toBe(
      'undeclared-worker',
    );
  });

  it('still requires the capability grant: binding removes candidates, never adds one', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    // `jules` is declared CLAUDE but was never granted hq.direct_order.
    expectOk(
      fx.ops.declareWorkerProvider({
        workerId: 'jules',
        providerId: 'CLAUDE',
        founderId: 'founder',
      }),
    );
    const result = fx.ops.claimNext('jules', DIRECT_ORDER_CAPABILITY.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_permitted');
  });
});

describe('the binding holds at start, not only at claim', () => {
  it('refuses to start when the worker no longer executes as the bound provider', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    const claimed = expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id));
    // The declaration changes between claim and start — a re-pointed worker
    // must not carry someone else's routed work into execution.
    expectOk(
      fx.ops.declareWorkerProvider({
        workerId: 'claude-worker',
        providerId: 'CODEX',
        founderId: 'founder',
      }),
    );
    const started = fx.ops.startTask(taskId, 'claude-worker', claimed.fence);
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error('unreachable');
    expect(started.error.code).toBe('provider_binding_mismatch');
    expect(fx.ops.queue.get(taskId)!.status).toBe('assigned');
  });
});

describe('the provider map is configuration, not something a worker can move', () => {
  it('offers no write path at all from a queue handle', () => {
    // The hostile shape from the finding: a worker holds a queue, so anything
    // reachable from a queue is reachable by a worker. There must be nothing
    // there to reach — not a guarded method, no method.
    const fx = bindingFixture();
    const lookup = fx.ops.queue.workerProviders as unknown as Record<string, unknown>;
    expect(typeof lookup.providerOf).toBe('function');
    expect(lookup.declare).toBeUndefined();
    expect(lookup.revoke).toBeUndefined();
    expect(Object.getPrototypeOf(lookup)).not.toHaveProperty('declare');
  });

  it('refuses a declaration from a worker, including one about itself', () => {
    const fx = bindingFixture();
    // `codex-worker` is a registered WORKER, so it holds no approval authority
    // and cannot redeclare itself as CLAUDE before claiming a CLAUDE order.
    const escalation = fx.ops.declareWorkerProvider({
      workerId: 'codex-worker',
      providerId: 'CLAUDE',
      founderId: 'codex-worker',
    });
    expect(escalation.ok).toBe(false);
    expect(fx.ops.queue.workerProviders.providerOf('codex-worker')).toBe('CODEX');

    // And the order it was after is still refused.
    queuedClaudeOrder(fx);
    const stolen = fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(stolen.ok).toBe(false);
  });

  it('refuses a declaration from an unknown actor and from a known non-approver', () => {
    const fx = bindingFixture();
    for (const actor of ['nobody-at-all', 'system']) {
      const result = fx.ops.declareWorkerProvider({
        workerId: 'claude-worker',
        providerId: 'CODEX',
        founderId: actor,
      });
      expect(result.ok).toBe(false);
    }
    expect(fx.ops.queue.workerProviders.providerOf('claude-worker')).toBe('CLAUDE');
  });

  it('fails closed on a provider id the routing registry does not know', () => {
    const fx = bindingFixture();
    for (const providerId of ['claude', 'CLAUDE ', 'CLUADE', '']) {
      const result = fx.ops.declareWorkerProvider({
        workerId: 'new-worker',
        providerId,
        founderId: 'founder',
      });
      expect(result.ok).toBe(false);
    }
    expect(fx.ops.queue.workerProviders.providerOf('new-worker')).toBeNull();
  });

  it('records the authorized declaration, attributed to the resolved principal', () => {
    const fx = bindingFixture();
    const kinds = fx.ops.queue.evidence.list().map((entry) => entry.kind);
    expect(kinds).toContain('worker_provider_declared');
    expectOk(fx.ops.revokeWorkerProvider({ workerId: 'codex-worker', founderId: 'founder' }));
    expect(fx.ops.queue.evidence.list().map((e) => e.kind)).toContain('worker_provider_revoked');
    expect(
      fx.ops
        .workerProviderDeclarations()
        .every((record) => record.declaredBy === 'founder'),
    ).toBe(true);
  });
});

describe('a bound task does not head-of-line block a worker it is not for', () => {
  it('offers the oldest COMPATIBLE task instead of refusing at the head', () => {
    const fx = bindingFixture();
    // Oldest first: a CLAUDE order, then a CODEX order, in one shared queue.
    const claudeTask = queuedOrder(fx, 'CLAUDE', 'Claude: draft the maintenance plan.', BOTH_PROVIDERS);
    const codexTask = queuedOrder(fx, 'CODEX', 'Codex: review the maintenance plan.', BOTH_PROVIDERS);
    expect(fx.ops.queue.get(claudeTask)!.createdAt <= fx.ops.queue.get(codexTask)!.createdAt).toBe(
      true,
    );

    // Before the fix this was a refusal, forever: the CLAUDE order sat at the
    // head and the CODEX worker could never reach its own work.
    const claimed = expectOk(fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id));
    expect(claimed.id).toBe(codexTask);
    expect(claimed.claimedBy).toBe('codex-worker');

    // Skipping took nothing from the CLAUDE order: untouched, still queued,
    // still claimable by the worker it was routed to.
    const skipped = fx.ops.queue.get(claudeTask)!;
    expect(skipped.status).toBe('queued');
    expect(skipped.claimedBy).toBeNull();
    expect(skipped.fence).toBe(0);
    expect(expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id)).id).toBe(
      claudeTask,
    );
  });

  it('still refuses loudly when nothing in the queue is compatible', () => {
    // Selection must not turn "that work is not yours" into "the queue is
    // empty": a worker with no work of its own gets the refusal, evidenced.
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    const result = fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_binding_mismatch');
    expect(fx.ops.queue.evidence.list().map((e) => e.kind)).toContain('provider_binding_rejected');
  });

  it('never selects a malformed binding for anyone, and does not let it block', () => {
    const fx = bindingFixture();
    const claudeTask = queuedClaudeOrder(fx);
    // Force a malformed binding onto the head task, behind the queue's back.
    const poisoned = fx.ops.queue.get(claudeTask)!;
    fx.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(
        JSON.stringify({ ...poisoned.payload, [EXECUTION_PROVIDER_KEY]: 42 }),
        claudeTask,
      );
    // Nobody may take it — not the provider it was routed to, not anyone else.
    for (const worker of ['claude-worker', 'codex-worker', 'undeclared-worker']) {
      const result = fx.ops.claimNext(worker, DIRECT_ORDER_CAPABILITY.id);
      expect(result.ok).toBe(false);
    }
    expect(fx.ops.queue.get(claudeTask)!.status).toBe('queued');

    // And it does not strand later work its own provider CAN run.
    const second = queuedOrder(fx, 'CLAUDE', 'Claude: a second, well-formed order.');
    expect(expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id)).id).toBe(second);
  });

  it('offers an undeclared worker unbound work that sits behind a bound task', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    const unbound = expectOk(
      fx.ops.createTask({
        capabilityId: DIRECT_ORDER_CAPABILITY.id,
        payload: { kind: 'unbound' },
        idempotencyKey: 'unbound-1',
        requestedBy: 'founder',
      }),
    ).task;
    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === unbound.id)!;
    expectOk(
      fx.ops.approveTask({
        taskId: unbound.id,
        founderId: 'coo',
        expectedActionDigest: card.actionDigest,
      }),
    );
    expect(expectOk(fx.ops.claimNext('undeclared-worker', DIRECT_ORDER_CAPABILITY.id)).id).toBe(
      unbound.id,
    );
  });
});

describe('the bound provider is part of the approved action', () => {
  it('changes the action digest, so a swapped provider invalidates the approval', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    const task = fx.ops.queue.get(taskId)!;
    expect(task.payload[EXECUTION_PROVIDER_KEY]).toBe('CLAUDE');
    const swapped = {
      ...task,
      payload: { ...task.payload, [EXECUTION_PROVIDER_KEY]: 'CODEX' },
    };
    expect(taskActionDigest(swapped)).not.toBe(taskActionDigest(task));
  });
});
